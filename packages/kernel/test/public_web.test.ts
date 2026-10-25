// Behavioral/security tests for the bounded public Web transport.
//
// All network activity is local loopback through an explicit test transport
// seam. URL/DNS policy still runs unchanged: seams only replace the socket
// destination and DNS answer source, never the public-address checks.
import {
  createServer,
  request as httpRequest,
  type RequestListener,
  type Server,
  type ServerResponse,
} from "node:http";
import type { RequestOptions } from "node:https";
import type { Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ToolError } from "../src/broker.js";
import {
  assertPublicHttpUrl,
  createPinnedLookup,
  fetchPublicPage,
  htmlToText,
  isPublicIpAddress,
  type PublicPageFetchTransport,
  unbracketHostname,
} from "../src/public_web.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup !== undefined) await cleanup();
  }
});

async function startServer(
  handler: RequestListener,
): Promise<{ port: number; server: Server; sockets: Set<Socket> }> {
  const server = createServer(handler);
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("no local port");
  }
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { port: address.port, server, sockets };
}

/** Route the production-shaped request to a local test server. */
function transportTo(
  port: number,
  capture?: (options: RequestOptions) => void,
): PublicPageFetchTransport {
  return (options, onResponse) => {
    capture?.(options);
    const { servername: _servername, ...rest } = options;
    const headers = {
      ...(options.headers as Record<string, string | undefined>),
      host: `127.0.0.1:${port}`,
    };
    return httpRequest(
      {
        ...rest,
        protocol: "http:",
        hostname: "127.0.0.1",
        port,
        lookup: undefined,
        headers,
      },
      onResponse,
    );
  };
}

function endlessRejectedResponse(
  response: ServerResponse,
  status: number,
  headers: Record<string, string>,
): void {
  response.writeHead(status, headers);
  const timer = setInterval(() => {
    try {
      response.write(Buffer.alloc(16 * 1024, 120));
    } catch {
      // The client is expected to destroy this response.
    }
  }, 2);
  response.on("close", () => clearInterval(timer));
  response.on("error", () => clearInterval(timer));
  response.write("x");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function expectToolError(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await promise;
    throw new Error("expected rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).errorCode).toBe(code);
  }
}

function invokeLookup(
  lookup: ReturnType<typeof createPinnedLookup>,
  hostname: string,
  options: { all?: boolean },
): Promise<{ result: unknown; family: number | undefined }> {
  return new Promise((resolve, reject) => {
    const callable = lookup as unknown as (
      host: string,
      opts: { all?: boolean },
      callback: (error: Error | null, result: unknown, family?: number) => void,
    ) => void;
    callable(hostname, options, (error, result, family) => {
      if (error !== null) reject(error);
      else resolve({ result, family });
    });
  });
}

describe("pinned lookup", () => {
  it("returns an address-record array when Node asks with all:true", async () => {
    const lookup = createPinnedLookup("93.184.216.34");
    const all = await invokeLookup(lookup, "public.example", { all: true });
    expect(all.result).toEqual([{ address: "93.184.216.34", family: 4 }]);

    const single = await invokeLookup(lookup, "public.example", { all: false });
    expect(single.result).toBe("93.184.216.34");
    expect(single.family).toBe(4);
  });

  it("pins IPv6 with family 6 in both callback shapes", async () => {
    const lookup = createPinnedLookup("2606:4700:4700::1111");
    const all = await invokeLookup(lookup, "public.example", { all: true });
    expect(all.result).toEqual([
      { address: "2606:4700:4700::1111", family: 6 },
    ]);
    const single = await invokeLookup(lookup, "public.example", {});
    expect(single.result).toBe("2606:4700:4700::1111");
    expect(single.family).toBe(6);
  });
});

describe("IPv4/IPv6 public address policy", () => {
  it("keeps ordinary public addresses usable", () => {
    for (const address of [
      "8.8.8.8",
      "1.1.1.1",
      "93.184.216.34",
      "2606:4700:4700::1111",
      "2001:4860:4860::8888",
      "2a00:1450:4001:81b::200e",
      "::ffff:808:808",
    ]) {
      expect(isPublicIpAddress(address), address).toBe(true);
    }
  });

  it("rejects private, reserved, transition and NAT64 encodings", () => {
    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "192.0.2.1",
      "198.51.100.7",
      "203.0.113.9",
      "::",
      "::1",
      "fc00::1",
      "fe80::1",
      "ff02::1",
      "2001:db8::1",
      "2001::1",
      "2002:0a00:0001::1",
      "64:ff9b::a00:1",
      "64:ff9b:1::a00:1",
      "::ffff:10.0.0.1",
      "::ffff:127.0.0.1",
      "::ffff:c0a8:101",
    ]) {
      expect(isPublicIpAddress(address), address).toBe(false);
    }
  });

  it("unbrackets IPv6 URL literals for checks but keeps Host formatting", async () => {
    const url = assertPublicHttpUrl("http://[2606:4700:4700::1111]:8080/a?b=1");
    expect(unbracketHostname(url.hostname)).toBe("2606:4700:4700::1111");
    expect(url.host).toBe("[2606:4700:4700::1111]:8080");

    let captured: RequestOptions | undefined;
    const { port } = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<title>IPv6</title><p>ok</p>");
    });
    const result = await fetchPublicPage(
      "http://[2606:4700:4700::1111]:8080/a?b=1",
      { request: transportTo(port, (options) => (captured = options)) },
    );
    expect(captured?.hostname).toBe("2606:4700:4700::1111");
    expect(
      (captured?.headers as Record<string, string> | undefined)?.host,
    ).toBe("[2606:4700:4700::1111]:8080");
    expect(captured?.servername).toBeUndefined();
    expect(result.title).toBe("IPv6");
    expect(result.text).toContain("ok");

    expect(() => assertPublicHttpUrl("http://[::1]/")).toThrow(ToolError);
    expect(() => assertPublicHttpUrl("http://[64:ff9b:1::a00:1]/")).toThrow(
      ToolError,
    );
  });
});

describe("cancellation and deadlines before send", () => {
  it("does not send when cancelled during DNS and suppresses the late answer", async () => {
    let resolveDns: ((addresses: readonly string[]) => void) | undefined;
    const dns = new Promise<readonly string[]>((resolve) => {
      resolveDns = resolve;
    });
    let sends = 0;
    const { port } = await startServer((_request, response) => {
      sends += 1;
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<p>must not be reached</p>");
    });
    const controller = new AbortController();
    const promise = fetchPublicPage("http://public.example/page", {
      resolveAddresses: () => dns,
      request: transportTo(port),
      signal: controller.signal,
      timeoutMs: 5_000,
    });
    await delay(10);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });

    resolveDns?.(["93.184.216.34"]);
    await delay(20);
    expect(sends).toBe(0);
  });

  it("does not send when the deadline expires during DNS", async () => {
    let resolveDns: ((addresses: readonly string[]) => void) | undefined;
    const dns = new Promise<readonly string[]>((resolve) => {
      resolveDns = resolve;
    });
    let sends = 0;
    const { port } = await startServer((_request, response) => {
      sends += 1;
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<p>late</p>");
    });
    const promise = fetchPublicPage("http://public.example/page", {
      resolveAddresses: () => dns,
      request: transportTo(port),
      timeoutMs: 40,
    });
    await expectToolError(promise, "execution_timeout");
    resolveDns?.(["93.184.216.34"]);
    await delay(20);
    expect(sends).toBe(0);
  });
});

describe("rejected responses close their sockets", () => {
  it.each([
    ["redirect", 302, { "content-type": "text/html" }, "execution_failed"],
    ["non-2xx", 500, { "content-type": "text/html" }, "execution_failed"],
    [
      "unsupported MIME",
      200,
      { "content-type": "application/octet-stream" },
      "output_invalid",
    ],
    [
      "oversize declared header",
      200,
      { "content-type": "text/html", "content-length": "99999999" },
      "output_too_large",
    ],
  ])(
    "destroys the endless %s response instead of draining it",
    async (_name, status, headers, code) => {
      let closedResolve: (() => void) | undefined;
      const closed = new Promise<void>((resolve) => {
        closedResolve = resolve;
      });
      const { port } = await startServer((_request, response) => {
        response.on("close", () => closedResolve?.());
        endlessRejectedResponse(response, status, headers);
      });
      const promise = fetchPublicPage("https://public.example/endless", {
        resolvedAddresses: ["93.184.216.34"],
        request: transportTo(port),
        timeoutMs: 2_000,
      });
      await expectToolError(promise, code);
      await Promise.race([
        closed,
        delay(1_000).then(() => {
          throw new Error("rejected response socket stayed open");
        }),
      ]);
    },
  );

  it("bounds an undeclared oversized success body", async () => {
    const { port } = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("y".repeat(4_096));
    });
    const promise = fetchPublicPage("https://public.example/big", {
      maxBytes: 1_024,
      resolvedAddresses: ["93.184.216.34"],
      request: transportTo(port),
      timeoutMs: 2_000,
    });
    await expectToolError(promise, "output_too_large");
  });
});

describe("adversarial HTML extraction", () => {
  it("handles 512 KiB of unclosed markup in linear time with bounded output", () => {
    const giant = "<".repeat(512 * 1024);
    const started = performance.now();
    const result = htmlToText(giant);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(2_500);
    expect(result.text.length).toBeLessThanOrEqual(512 * 1024);
  });

  it("consumes repeated unclosed script/style blocks without backtracking", () => {
    const scripts = "<script>".repeat(64 * 1024);
    const styles = "<style>".repeat(64 * 1024);
    const started = performance.now();
    const scriptResult = htmlToText(`<p>visible</p>${scripts}`);
    const styleResult = htmlToText(`<p>visible</p>${styles}`);
    expect(performance.now() - started).toBeLessThan(2_500);
    expect(scriptResult.text).toContain("visible");
    expect(scriptResult.text).not.toContain("script");
    expect(styleResult.text).toContain("visible");
  });

  it("preserves a useful title and normal text", () => {
    const result = htmlToText(
      "<!doctype html><html><head><title> Hello &amp; World </title>" +
        "<style>.x{color:red}</style><script>alert('x')</script></head>" +
        "<body><!-- hidden --><noscript>fallback</noscript><h1>Body</h1><p>text</p></body></html>",
    );
    expect(result.title).toBe("Hello & World");
    expect(result.text).toContain("Body");
    expect(result.text).toContain("text");
    expect(result.text).not.toContain("alert");
    expect(result.text).not.toContain("color:red");
    expect(result.text).not.toContain("fallback");
    expect(result.text).not.toContain("hidden");
  });
});
