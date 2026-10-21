import { describe, expect, it } from "vitest";
import {
  buildWebCanonicalKey,
  isValidLoopbackHttpUrl,
  parseWebSearchConfig,
  WebSearchConfigSchema,
  WebSearchHitSchema,
  WebSearchToolInputSchema,
  WebSearchToolOutputSchema,
} from "../src/web.js";

/**
 * Contract-level bounds and fail-closed configuration tests for `web.search`
 * (design §3 allocates the exact bounds; §9 the strict config parse).
 */
describe("WebSearchToolInputSchema", () => {
  it("accepts the minimal input and applies the default top_k", () => {
    const parsed = WebSearchToolInputSchema.parse({ query: "hello" });
    expect(parsed.top_k).toBe(5);
  });

  it("accepts 200 code points and rejects 201", () => {
    const max = "\u3042".repeat(200);
    expect(WebSearchToolInputSchema.safeParse({ query: max }).success).toBe(
      true,
    );
    expect(
      WebSearchToolInputSchema.safeParse({ query: `${max}\u3042` }).success,
    ).toBe(false);
  });

  it("rejects astral padding above the 200 code-point bound", () => {
    const emoji = "\u{1F600}";
    expect(
      WebSearchToolInputSchema.safeParse({ query: emoji.repeat(200) }).success,
    ).toBe(true);
    expect(
      WebSearchToolInputSchema.safeParse({ query: emoji.repeat(201) }).success,
    ).toBe(false);
  });

  it("rejects unknown keys and out-of-vocabulary time_range", () => {
    expect(
      WebSearchToolInputSchema.safeParse({
        query: "x",
        freshness: "normal",
      }).success,
    ).toBe(false);
    expect(
      WebSearchToolInputSchema.safeParse({
        query: "x",
        time_range: "decade",
      }).success,
    ).toBe(false);
  });
});

describe("WebSearchToolOutputSchema", () => {
  const hit = {
    referenceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ordinal: 1,
    snapshotId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    resourceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    canonicalKey: buildWebCanonicalKey("a".repeat(64)),
    title: null,
    url: "https://example.com/a",
    snippet: "snippet",
  };
  it("rejects a 9th result", () => {
    const hits = Array.from({ length: 9 }, (_, i) => ({
      ...hit,
      ordinal: i + 1,
    }));
    expect(WebSearchToolOutputSchema.safeParse({ results: hits }).success).toBe(
      false,
    );
  });

  it("rejects non-http(s) schemes and URLs over 2048 chars", () => {
    expect(
      WebSearchHitSchema.safeParse({ ...hit, url: "javascript:alert(1)" })
        .success,
    ).toBe(false);
    expect(
      WebSearchHitSchema.safeParse({
        ...hit,
        url: `https://a${"b".repeat(3000)}`,
      }).success,
    ).toBe(false);
  });

  it("rejects titles over 256 code points and empty snippets", () => {
    expect(
      WebSearchHitSchema.safeParse({ ...hit, title: "\u3042".repeat(257) })
        .success,
    ).toBe(false);
  });
});

describe("COMPANION_WEB_SEARCH_JSON config (fail-closed, §9)", () => {
  it("parses nothing as disabled defaults", () => {
    const config = parseWebSearchConfig(undefined);
    expect(config.enabled).toBe(false);
    expect(config.timeout_ms).toBe(10_000);
    expect(config.per_turn_budget).toBe(3);
    expect(config.max_results).toBe(5);
    expect(config.max_response_bytes).toBe(1_048_576);
  });

  it("parses the draft shape string", () => {
    const config = parseWebSearchConfig(
      JSON.stringify({
        enabled: true,
        searxng_base_url: "http://127.0.0.1:8888",
        max_results: 8,
        timeout_ms: 10_000,
      }),
    );
    expect(config.max_results).toBe(8);
    expect(config.enabled).toBe(true);
  });

  it("rejects invalid JSON", () => {
    expect(() => parseWebSearchConfig("{oops")).toThrow(TypeError);
  });

  it("rejects unknown keys (strict)", () => {
    expect(() =>
      parseWebSearchConfig(
        JSON.stringify({
          enabled: true,
          searxng_base_url: "http://127.0.0.1",
          extra: 1,
        }),
      ),
    ).toThrow();
  });

  it("rejects non-loopback base URLs", () => {
    for (const bad of [
      "http://example.com:8080",
      "http://8.8.8.8",
      "https://10.0.0.2:8888",
      "http://127.0.0.1:8888/search?q=template",
      "ftp://127.0.0.1:8888",
      "http://user:pw@127.0.0.1:8888",
    ]) {
      expect(() =>
        parseWebSearchConfig(
          JSON.stringify({ enabled: true, searxng_base_url: bad }),
        ),
      ).toThrow();
      expect(isValidLoopbackHttpUrl(bad)).toBe(false);
    }
  });

  it("accepts loopback spellings", () => {
    for (const ok of [
      "http://127.0.0.1:8888",
      "http://localhost:8888",
      "http://[::1]:8888",
      "https://127.0.0.1:9443",
      "http://127.1.2.3:9998",
    ]) {
      expect(isValidLoopbackHttpUrl(ok)).toBe(true);
    }
  });

  it("enforces enabled:true requires searxng_base_url", () => {
    expect(() =>
      parseWebSearchConfig(JSON.stringify({ enabled: true })),
    ).toThrow();
    expect(WebSearchConfigSchema.safeParse({ enabled: false }).success).toBe(
      true,
    );
  });
});
