import { describe, expect, it } from "vitest";
import {
  decodeSearxResults,
  normalizeSearxBaseUrl,
  normalizeWebUrl,
  searchSearx,
  stripControlChars,
  WebSearchClientError,
} from "../src/client.js";
import { searxJsonFixture, startSearxStub } from "./helpers/stub_searx.js";

describe("normalizeSearxBaseUrl", () => {
  it("pins localhost and strips the trailing slash", () => {
    expect(normalizeSearxBaseUrl("http://localhost:8888")).toBe(
      "http://127.0.0.1:8888",
    );
    expect(normalizeSearxBaseUrl("http://127.0.0.1:8888/")).toBe(
      "http://127.0.0.1:8888",
    );
    expect(normalizeSearxBaseUrl("http://[::1]:8888")).toBe(
      "http://[::1]:8888",
    );
  });

  it("fail-closed rejects non-loopback / bad schemes / creds", () => {
    for (const bad of [
      "http://example.com:8888",
      "https://example.org",
      "ftp://127.0.0.1",
      "http://user:pw@127.0.0.1:8888",
      "http://127.0.0.1:8888/?q=x",
      undefined,
      "",
    ]) {
      expect(() => normalizeSearxBaseUrl(bad)).toThrow(WebSearchClientError);
    }
  });
});

describe("decodeSearxResults (untrusted framing)", () => {
  it("strips control characters and collapses whitespace", () => {
    expect(stripControlChars("a\u0000b\u0008c\nd\u007f\u009fe\t f")).toBe(
      "abcd e f",
    );
  });

  it("bounds title/snippet and drops junk entries", () => {
    const body = searxJsonFixture([
      {
        url: "https://example.com/1",
        title: `\u3042`.repeat(300),
        content: "ok",
      },
      { url: "javascript:alert(1)", title: "bad", content: "scheme" },
      { url: "https://example.com/3", title: "", content: "" },
      { url: "ftp://example.com/4", title: "x", content: "y" },
      {
        url: "https://example.com/2",
        title: " good ",
        content: " snip\t\n ",
      },
    ]);
    const results = decodeSearxResults(body, 5);
    expect(results).toHaveLength(2);
    expect(results[1]?.title).toBe(" good ");
    expect(results[1]?.snippet).toBe("snip");
    expect(results[1]?.canonicalKey.startsWith("web-v1-")).toBe(true);
  });

  it("rejects non-JSON and non-object bodies with response_invalid", () => {
    expect(() => decodeSearxResults("not-json", 5)).toThrow();
    expect(() => decodeSearxResults("[]", 5)).toThrow();
    expect(() => decodeSearxResults("{}", 5)).toThrow();
  });
});

describe("normalizeWebUrl", () => {
  it("keeps http/https and builds a stable sha-256 canonical key", () => {
    const a = normalizeWebUrl("https://example.com/a");
    const b = normalizeWebUrl("https://EXAMPLE.com/a#frag");
    expect(a?.url).toBe("https://example.com/a");
    expect(a?.canonicalKey).toBe(b?.canonicalKey);
    expect(normalizeWebUrl("gopher://example.com")).toBeNull();
    expect(normalizeWebUrl(`https://a/${"x".repeat(2500)}`)).toBeNull();
  });
});

describe("searchSearx over a loopback stub", () => {
  it("decodes a normal SearXNG JSON response", async () => {
    const stub = await startSearxStub({
      body: searxJsonFixture([
        { url: "https://example.com/", title: "T", content: "s" },
      ]),
      redirectLocation: "http://127.0.0.1:1/never",
    });
    try {
      const results = await searchSearx({
        baseUrl: stub.url,
        query: "loopback search",
        timeoutMs: 5000,
      });
      expect(results).toHaveLength(1);
      expect(results[0]?.url).toBe("https://example.com/");
    } finally {
      await stub.close();
    }
  });

  it("sends format=json and never sends non-allowlisted params", async () => {
    const stub = await startSearxStub({ body: searxJsonFixture([]) });
    try {
      await searchSearx({
        baseUrl: stub.url,
        query: "kind of q",
        language: "ja",
        timeRange: "week",
        timeoutMs: 5000,
      });
      const request = stub.requests[0];
      expect(request?.url.pathname).toBe("/search");
      expect(request?.url.searchParams.get("format")).toBe("json");
      expect(request?.url.searchParams.get("q")).toBe("kind of q");
      expect(request?.url.searchParams.get("language")).toBe("ja");
      expect(request?.url.searchParams.get("time_range")).toBe("week");
      expect(stub.addr.startsWith("127.0.0.1:")).toBe(true);
    } finally {
      await stub.close();
    }
  });

  it("refuses every 3xx without leaking the query to the redirect target", async () => {
    const stub = await startSearxStub({
      status: 302,
      body: "",
      redirectLocation: "http://127.0.0.1:1/exfil",
    });
    try {
      await expect(
        searchSearx({
          baseUrl: stub.url,
          query: "secret query",
          timeoutMs: 5000,
        }),
      ).rejects.toMatchObject({ code: "redirect_refused" });
      // no second (redirect-following) request ever happened
      expect(stub.requests).toHaveLength(1);
    } finally {
      await stub.close();
    }
  });

  it("cuts oversized bodies at the byte cap before JSON.parse", async () => {
    const big = searxJsonFixture([
      {
        url: "https://example.com/",
        title: "t",
        content: "b".repeat(64 * 1024),
      },
    ]);
    const stub = await startSearxStub({ body: big });
    try {
      await expect(
        searchSearx({
          baseUrl: stub.url,
          query: "big",
          maxResponseBytes: 512,
          timeoutMs: 5000,
        }),
      ).rejects.toMatchObject({ code: "response_too_large" });
    } finally {
      await stub.close();
    }
  });

  it("returns empty for empty results", async () => {
    const stub = await startSearxStub({ body: searxJsonFixture([]) });
    try {
      const results = await searchSearx({
        baseUrl: stub.url,
        query: "empty",
        timeoutMs: 5000,
      });
      expect(results).toEqual([]);
    } finally {
      await stub.close();
    }
  });

  it("reports upstream errors for non-2xx statuses", async () => {
    const stub = await startSearxStub({ status: 503, body: "boom" });
    try {
      await expect(
        searchSearx({ baseUrl: stub.url, query: "x", timeoutMs: 5000 }),
      ).rejects.toMatchObject({ code: "upstream_error" });
    } finally {
      await stub.close();
    }
  });

  it("times out against a server that never responds", async () => {
    const stub = await startSearxStub({ neverRespond: true });
    try {
      await expect(
        searchSearx({ baseUrl: stub.url, query: "x", timeoutMs: 200 }),
      ).rejects.toMatchObject({ code: "timeout" });
    } finally {
      await stub.close();
    }
  });
});
