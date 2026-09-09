/**
 * Connected-transport fixture tests (official SDK 1.30.0, in-memory only).
 * McpConnector is wired to a real Client over InMemoryTransport against a
 * deterministic McpServer — genuine initialize/listTools/call behavior, not
 * manual list verification. No network, no OAuth, no upstream compat claim.
 */
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  assertLoopbackHttp,
  McpConnector,
  STDIO_IMPLICIT_ENV_VARS,
} from "../src/client.js";
import type { McpConnectorConfig } from "../src/config.js";
import {
  canonicalSchemaHash,
  mcpConnectorConfigSchema,
} from "../src/config.js";

const closables: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  const pending = closables.splice(0);
  for (const close of pending) {
    await close().catch(() => undefined);
  }
});

const HASH = "b".repeat(64);

function baseConfig(
  bindings: Array<{ upstreamTool: string; canonicalSchemaHash: string }>,
): McpConnectorConfig {
  return mcpConnectorConfigSchema.parse({
    connectorInstanceId: "cal-1",
    serverId: "fake",
    kind: "mcp" as const,
    version: "0.0.0-proposed.1",
    transport: {
      kind: "stdio" as const,
      command: "unused-injected",
      args: [] as string[],
      envAllowlist: [...STDIO_IMPLICIT_ENV_VARS] as string[],
      shutdownWaitMs: 3000,
    },
    bindings,
  });
}

async function linkedServer(opts: { isErrorTool?: boolean } = {}) {
  let calls = 0;
  const server = new McpServer({ name: "fake-calendar", version: "0.0.0" });
  server.registerTool(
    "search-events",
    {
      description: "fake readonly search",
      inputSchema: { q: z.string(), maxResults: z.number().optional() },
    },
    async ({ q }) => {
      calls += 1;
      if (opts.isErrorTool) {
        return {
          content: [{ type: "text" as const, text: "secret-raw-failure" }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text" as const, text: `hits for ${q}` }],
        structuredContent: { totalCount: 1 },
      };
    },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  closables.push(() => server.close());
  return {
    calls: () => calls,
    factory: (_config: unknown): Transport =>
      clientTransport as unknown as Transport,
  };
}

describe("McpConnector connected identity (in-memory SDK transport)", () => {
  it("verifies listTools identity on connect and dispatches the allowed call", async () => {
    const { factory } = await linkedServer();
    // Learn the real canonical hash via a throwaway SDK client over a fresh pair.
    const server2 = new McpServer({ name: "fake-calendar", version: "0.0.0" });
    server2.registerTool(
      "search-events",
      {
        description: "fake readonly search",
        inputSchema: { q: z.string(), maxResults: z.number().optional() },
      },
      async () => ({
        content: [{ type: "text" as const, text: "x" }],
      }),
    );
    const [ct2, st2] = InMemoryTransport.createLinkedPair();
    await server2.connect(st2);
    const { Client } = await import(
      "@modelcontextprotocol/sdk/client/index.js"
    );
    const probe = new Client(
      { name: "probe", version: "0.0.0" },
      { capabilities: {} },
    );
    await probe.connect(ct2);
    const listed = await probe.listTools();
    const tool = listed.tools.find((t) => t.name === "search-events");
    expect(tool).toBeDefined();
    const realHash = await canonicalSchemaHash(tool?.inputSchema);
    await probe.close().catch(() => undefined);
    await server2.close().catch(() => undefined);

    const connector = new McpConnector(
      baseConfig([
        { upstreamTool: "search-events", canonicalSchemaHash: realHash },
      ]),
      factory as never,
    );
    closables.push(() => connector.shutdown());
    const ensured = await connector.ensureConnected();
    expect(ensured).toEqual({ ok: true });
    expect(connector.isAllowed("search-events")).toBe(true);
    const res = await connector.callTool("search-events", { q: "standup" });
    expect(res).toMatchObject({ ok: true });
    await connector.shutdown();
    expect(connector.stats().connected).toBe(false);
  });

  it("schema drift denies dispatch with mcp_schema_mismatch and no upstream call", async () => {
    const { factory, calls } = await linkedServer();
    const connector = new McpConnector(
      baseConfig([
        { upstreamTool: "search-events", canonicalSchemaHash: "0".repeat(64) },
      ]),
      factory as never,
    );
    closables.push(() => connector.shutdown());
    const ensured = await connector.ensureConnected();
    expect(ensured).toEqual({ ok: false, code: "mcp_schema_mismatch" });
    expect(connector.isAllowed("search-events")).toBe(false);
    const res = await connector.callTool("search-events", { q: "standup" });
    expect(res).toEqual({ ok: false, code: "mcp_schema_mismatch" });
    expect(calls()).toBe(0);
    expect(connector.stats().connected).toBe(false);
  });

  it("isError=true maps to a fixed redacted error, never ok text", async () => {
    const { factory } = await linkedServer({ isErrorTool: true });
    const serverProbe = new McpServer({ name: "fake2", version: "0.0.0" });
    serverProbe.registerTool(
      "search-events",
      {
        description: "x",
        inputSchema: { q: z.string(), maxResults: z.number().optional() },
      },
      async () => ({ content: [{ type: "text" as const, text: "x" }] }),
    );
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await serverProbe.connect(st);
    const { Client } = await import(
      "@modelcontextprotocol/sdk/client/index.js"
    );
    const probe = new Client(
      { name: "probe", version: "0.0.0" },
      { capabilities: {} },
    );
    await probe.connect(ct);
    const listed = await probe.listTools();
    const realHash = await canonicalSchemaHash(
      listed.tools.find((t) => t.name === "search-events")?.inputSchema,
    );
    await probe.close().catch(() => undefined);
    await serverProbe.close().catch(() => undefined);

    const connector = new McpConnector(
      baseConfig([
        { upstreamTool: "search-events", canonicalSchemaHash: realHash },
      ]),
      factory as never,
    );
    closables.push(() => connector.shutdown());
    const res = await connector.callTool("search-events", { q: "standup" });
    expect(res).toEqual({ ok: false, code: "calendar_upstream_error" });
    expect(JSON.stringify(res)).not.toContain("secret-raw-failure");
  });

  it("rejects non-loopback hosts at the runtime boundary", () => {
    expect(() =>
      assertLoopbackHttp(new URL("http://example.com/mcp")),
    ).toThrow();
    expect(() =>
      assertLoopbackHttp(new URL("http://127.0.0.1:8377/mcp")),
    ).not.toThrow();
  });

  it("failed connect cleans up and reports mcp_unavailable", async () => {
    const failingFactory = (): Transport => {
      throw new Error("spawn ENOENT");
    };
    const connector = new McpConnector(
      baseConfig([
        { upstreamTool: "search-events", canonicalSchemaHash: HASH },
      ]),
      failingFactory,
    );
    const res = await connector.ensureConnected();
    expect(res).toEqual({ ok: false, code: "mcp_unavailable" });
    expect(connector.stats().connected).toBe(false);
  });
});
