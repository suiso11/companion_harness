/**
 * C09-06 Streamable HTTP cleanup regression against REAL loopback Node HTTP.
 *
 * - production `new McpConnector(cfg)` (no factory injection) does a genuine
 *   initialize/tools/list/tools/call against a real SDK McpServer over
 *   StreamableHTTPServerTransport;
 * - redirects (300–399) are refused with the fixed unavailable result and the
 *   redirect destination is NEVER hit (counter stays zero), regardless of the
 *   Request/RequestInit a redirect-following caller might pass;
 * - a refused response body is cancelled (server observes the socket close),
 *   with no body/secret retained.
 *
 * Ephemeral loopback ports only; every server/transport is closed first so the
 * file is full-suite safe.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  defaultTransportFactory,
  loopbackNoRedirectFetch,
  McpConnector,
} from "../src/client.js";
import type { McpConnectorConfig } from "../src/config.js";
import {
  canonicalSchemaHash,
  mcpConnectorConfigSchema,
} from "../src/config.js";

const WIRE_NAME = "http-calendar";
const WIRE_VERSION = "1.0.0";
const TOOL = "search-events";
const SECRET = "sk-http-inert-do-not-leak /etc/shadow";

interface RunningServer {
  port: number;
  hits: () => number;
  close: () => Promise<void>;
}

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  const pending = closers.splice(0);
  for (const close of pending) await close().catch(() => undefined);
});

/** Real SDK MCP server over stateful Streamable HTTP; non-POST returns 405. */
async function startMcpHttpServer(): Promise<RunningServer> {
  const server = new McpServer({ name: WIRE_NAME, version: WIRE_VERSION });
  server.registerTool(
    TOOL,
    { description: "readonly", inputSchema: { q: z.string() } },
    async () => ({
      content: [{ type: "text" as const, text: "hits" }],
      structuredContent: { totalCount: 1 },
    }),
  );
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    enableJsonResponse: true,
    keepAliveMs: 0,
  });
  // SDK 1.30.0 declares `StreamableHTTPServerTransport.onclose` (and peers) as
  // `(() => void) | undefined`, which is not assignable to the exactOptional
  // `Transport` callback surface even though the public runtime contract and
  // `implements Transport` are valid. Cross the boundary through the same
  // test-side `Transport` convention used elsewhere, without shadowing the SDK.
  await server.connect(transport as unknown as Transport);
  let hits = 0;
  const node = http.createServer((req, res) => {
    hits += 1;
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let parsed: unknown;
      try {
        parsed = raw.length > 0 ? JSON.parse(raw) : undefined;
      } catch {
        parsed = undefined;
      }
      void transport.handleRequest(req, res, parsed);
    });
  });
  await new Promise<void>((resolve) => node.listen(0, "127.0.0.1", resolve));
  const port = (node.address() as AddressInfo).port;
  return {
    port,
    hits: () => hits,
    close: async () => {
      node.closeAllConnections();
      await server.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
      await new Promise<void>((resolve) => node.close(() => resolve()));
    },
  };
}

function httpConfig(port: number, hash: string): McpConnectorConfig {
  return mcpConnectorConfigSchema.parse({
    connectorInstanceId: "c09-http",
    serverId: "logical-http",
    kind: "mcp" as const,
    expectedServerName: WIRE_NAME,
    version: WIRE_VERSION,
    transport: {
      kind: "streamable-http" as const,
      host: "127.0.0.1",
      port,
      path: "/mcp",
      followRedirects: false,
    },
    bindings: [{ upstreamTool: TOOL, canonicalSchemaHash: hash }],
  });
}

/** Learn the real advertised hash via a fresh server + real SDK client. */
async function probeHash(): Promise<string> {
  const server = await startMcpHttpServer();
  try {
    const client = new Client(
      { name: "probe", version: "0.0.0" },
      { capabilities: {} },
    );
    await client.connect(
      defaultTransportFactory(httpConfig(server.port, "f".repeat(64))),
    );
    const listed = await client.listTools();
    const tool = (listed.tools ?? []).find((t) => t.name === TOOL);
    const hash = await canonicalSchemaHash(tool?.inputSchema);
    await client.close().catch(() => undefined);
    return hash;
  } finally {
    await server.close();
  }
}

describe("C09-06 Streamable HTTP loopback lifecycle", () => {
  it("initializes, lists, and calls through the production connector", async () => {
    const hash = await probeHash();
    const server = await startMcpHttpServer();
    closers.push(server.close);

    const connector = new McpConnector(httpConfig(server.port, hash));
    closers.push(() => connector.shutdown());
    const res = await connector.callTool(TOOL, { q: "standup" });
    expect(res).toMatchObject({
      ok: true,
      structuredContent: { totalCount: 1 },
    });
    expect(connector.stats()).toMatchObject({
      connected: true,
      enabledBindings: [TOOL],
    });
    await connector.shutdown();
    expect(connector.stats().connected).toBe(false);
  });

  it("refuses 300–399 redirects with a fixed result and never hits the destination", async () => {
    for (const status of [301, 302, 303, 307, 308, 304]) {
      let destinationHits = 0;
      const destination = http.createServer((_req, res) => {
        destinationHits += 1;
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end("{}");
      });
      await new Promise<void>((resolve) =>
        destination.listen(0, "127.0.0.1", resolve),
      );
      const destinationPort = (destination.address() as AddressInfo).port;

      const source = http.createServer((_req, res) => {
        res.statusCode = status;
        res.setHeader(
          "location",
          `http://127.0.0.1:${destinationPort}/mcp?secret=${encodeURIComponent(SECRET)}`,
        );
        if (status === 304) {
          res.end();
          return;
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ secret: SECRET }));
      });
      await new Promise<void>((resolve) =>
        source.listen(0, "127.0.0.1", resolve),
      );
      const sourcePort = (source.address() as AddressInfo).port;

      try {
        const connector = new McpConnector(
          httpConfig(sourcePort, "f".repeat(64)),
        );
        const result = await connector.callTool(TOOL, { q: "x" });
        expect(result).toEqual({ ok: false, code: "mcp_unavailable" });
        const serialized = JSON.stringify(result);
        expect(serialized).not.toContain(SECRET);
        expect(serialized).not.toContain("location");
        expect(destinationHits).toBe(0);
        await connector.shutdown();
      } finally {
        source.closeAllConnections();
        destination.closeAllConnections();
        await new Promise<void>((resolve) => source.close(() => resolve()));
        await new Promise<void>((resolve) =>
          destination.close(() => resolve()),
        );
      }
    }
  });

  it("cancels a refused redirect body without retaining it", async () => {
    let bodyClosed = false;
    const source = http.createServer((_req, res) => {
      res.statusCode = 302;
      res.setHeader("location", "http://127.0.0.1:1/never");
      res.setHeader("content-type", "application/octet-stream");
      res.write(Buffer.alloc(1024, 0x2e));
      res.on("close", () => {
        bodyClosed = true;
      });
      // Deliberately do not end: only a client body-cancel closes the socket.
    });
    await new Promise<void>((resolve) =>
      source.listen(0, "127.0.0.1", resolve),
    );
    const port = (source.address() as AddressInfo).port;
    try {
      await expect(
        loopbackNoRedirectFetch(`http://127.0.0.1:${port}/mcp`, {
          redirect: "follow",
        }),
      ).rejects.toThrow(/redirect refused: HTTP 302/);
      await expect.poll(() => bodyClosed, { timeout: 3000 }).toBe(true);
    } finally {
      source.closeAllConnections();
      await new Promise<void>((resolve) => source.close(() => resolve()));
    }
  });

  it("pins every redirect-following input form to a manual refusal and never hits the destination", async () => {
    const PRIVATE_HEADER = "x-c09-private-marker";
    const PRIVATE_VALUE = "c09-private-header-value-do-not-leak";
    const BODY_MARKER = "c09-private-body-marker-do-not-leak";
    let destinationHits = 0;
    const destination = http.createServer((_req, res) => {
      destinationHits += 1;
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end("{}");
    });
    await new Promise<void>((resolve) =>
      destination.listen(0, "127.0.0.1", resolve),
    );
    const destinationPort = (destination.address() as AddressInfo).port;

    const source = http.createServer((_req, res) => {
      res.statusCode = 302;
      res.setHeader("location", `http://127.0.0.1:${destinationPort}/mcp`);
      res.setHeader(PRIVATE_HEADER, PRIVATE_VALUE);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ marker: BODY_MARKER }));
    });
    await new Promise<void>((resolve) =>
      source.listen(0, "127.0.0.1", resolve),
    );
    const sourcePort = (source.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${sourcePort}/mcp`;

    // DISTINCT boundary branches, not parameter copies of one path: a string
    // URL, a URL object, and a Request whose OWN redirect is 'follow'. Each is
    // combined with a redirect-following RequestInit where the API takes one.
    const forms: Array<{
      name: string;
      make: () => { input: string | URL | Request; init?: RequestInit };
    }> = [
      {
        name: "string URL",
        make: () => ({ input: url, init: { redirect: "follow" } }),
      },
      {
        name: "URL object",
        make: () => ({ input: new URL(url), init: { redirect: "follow" } }),
      },
      {
        name: "Request object",
        make: () => ({ input: new Request(url, { redirect: "follow" }) }),
      },
    ];

    try {
      for (const form of forms) {
        const { input, init } = form.make();
        const outcome = await loopbackNoRedirectFetch(input, init).then(
          () => ({ thrown: false as const }),
          (error: unknown) => ({ thrown: true as const, error }),
        );
        expect(outcome.thrown).toBe(true);
        let message = "";
        if (outcome.thrown && outcome.error instanceof Error) {
          message = outcome.error.message;
        } else if (outcome.thrown) {
          message = String(outcome.error);
        }
        // The direct thrown error must be synthetic: no private header/body
        // marker may escape (no exact error-wording assertion).
        expect(message).not.toContain(PRIVATE_VALUE);
        expect(message).not.toContain(BODY_MARKER);
        expect(destinationHits).toBe(0);
      }
      expect(destinationHits).toBe(0);
    } finally {
      source.closeAllConnections();
      destination.closeAllConnections();
      await new Promise<void>((resolve) => source.close(() => resolve()));
      await new Promise<void>((resolve) => destination.close(() => resolve()));
    }
  });

  it("fails closed with zero network when a programmatic config bypasses the loopback schema", async () => {
    let fetchCalls = 0;
    // SAFETY TRIPWIRE: the real global fetch must NEVER be reached; if the
    // runtime loopback boundary regressed this would be a real DNS/WAN call.
    const tripwire = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      fetchCalls += 1;
      return Promise.reject(
        new Error("network access is forbidden in this test"),
      );
    });
    try {
      const cfg = httpConfig(1, "f".repeat(64));
      // Programmatic schema BYPASS: start from a schema-valid config, then
      // mutate the transport AFTER parse (never schema.parse a bad URL) so the
      // runtime loopback re-check is the only gate.
      (cfg.transport as unknown as { host: string }).host = "example.invalid";
      const connector = new McpConnector(cfg);
      closers.push(() => connector.shutdown());

      const result = await connector.callTool(TOOL, { q: "no-network" });
      expect(result).toEqual({ ok: false, code: "mcp_unavailable" });
      expect(connector.isAllowed(TOOL)).toBe(false);
      expect(connector.stats()).toMatchObject({
        connected: false,
        enabledBindings: [],
      });
      expect(fetchCalls).toBe(0);
    } finally {
      tripwire.mockRestore();
    }
  });
});
