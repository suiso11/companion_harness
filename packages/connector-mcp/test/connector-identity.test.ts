/**
 * Connected-transport fixture tests (official SDK 1.30.0, in-memory only).
 * McpConnector is wired to a real Client over InMemoryTransport against a
 * deterministic McpServer — genuine initialize/listTools/call behavior, not
 * manual list verification. No network, no OAuth, no upstream compat claim.
 *
 * C09-07 wire-identity gate: the ACTUAL initialize.serverInfo (name+version)
 * must equal the trusted config expectedServerName/version BEFORE tools/list;
 * a mismatch disables all configured bindings and never reaches upstream.
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
  type TransportFactory,
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

const SEARCH_INPUT_SCHEMA = {
  q: z.string(),
  maxResults: z.number().optional(),
};

function baseConfig(
  bindings: Array<{ upstreamTool: string; canonicalSchemaHash: string }>,
  overrides: Record<string, unknown> = {},
): McpConnectorConfig {
  return mcpConnectorConfigSchema.parse({
    connectorInstanceId: "cal-1",
    serverId: "fake",
    kind: "mcp" as const,
    expectedServerName: "fake-calendar",
    version: "0.0.0",
    transport: {
      kind: "stdio" as const,
      command: "unused-injected",
      args: [] as string[],
      envAllowlist: [...STDIO_IMPLICIT_ENV_VARS] as string[],
      shutdownWaitMs: 3000,
    },
    bindings,
    ...overrides,
  });
}

interface FakeServerOptions {
  isErrorTool?: boolean;
  serverName?: string;
  serverVersion?: string;
  /** Also register a second readonly tool (`get-event`) with its own counter. */
  withGetEvent?: boolean;
  /** REAL in-flight drop: close the SDK server from inside the handler. */
  closeDuringSearch?: boolean;
}

/**
 * Real McpServer linked over InMemoryTransport, connected (awaited) before
 * use. `transport` is the client side handed to the connector factory; the
 * overridden `close` counts real transport cleanup.
 */
async function linkedServer(opts: FakeServerOptions = {}) {
  let calls = 0;
  let getEventCalls = 0;
  let closes = 0;
  const server = new McpServer({
    name: opts.serverName ?? "fake-calendar",
    version: opts.serverVersion ?? "0.0.0",
  });
  server.registerTool(
    "search-events",
    { description: "fake readonly search", inputSchema: SEARCH_INPUT_SCHEMA },
    async ({ q }) => {
      calls += 1;
      if (opts.closeDuringSearch) {
        // Drop the real underlying SDK link BEFORE this handler can publish a
        // response, so the awaited logical call fails genuinely in flight.
        await server.close();
      }
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
  if (opts.withGetEvent) {
    server.registerTool(
      "get-event",
      { description: "fake readonly get", inputSchema: { id: z.string() } },
      async ({ id }) => {
        getEventCalls += 1;
        return {
          content: [{ type: "text" as const, text: `event ${id}` }],
          structuredContent: { id },
        };
      },
    );
  }
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  closables.push(() => server.close());
  const raw = clientTransport as unknown as { close: () => Promise<void> };
  const originalClose = raw.close.bind(raw);
  raw.close = async () => {
    closes += 1;
    await originalClose();
  };
  return {
    transport: clientTransport as unknown as Transport,
    calls: () => calls,
    getEventCalls: () => getEventCalls,
    closes: () => closes,
  };
}

/** Learns the real canonical hash of the fixture tool via a throwaway SDK
 * client over a fresh pair (closed immediately, not permanent). */
async function probeSearchHash(): Promise<string> {
  const server = new McpServer({ name: "hash-probe", version: "0.0.0" });
  server.registerTool(
    "search-events",
    { description: "probe", inputSchema: SEARCH_INPUT_SCHEMA },
    async () => ({ content: [{ type: "text" as const, text: "x" }] }),
  );
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const probe = new Client(
    { name: "probe", version: "0.0.0" },
    { capabilities: {} },
  );
  await probe.connect(ct);
  const listed = await probe.listTools();
  const hash = await canonicalSchemaHash(
    listed.tools.find((t) => t.name === "search-events")?.inputSchema,
  );
  await probe.close().catch(() => undefined);
  await server.close().catch(() => undefined);
  return hash;
}

/** Factory handing out transports in order; the last one repeats. */
function queuedFactory(transports: Transport[]): TransportFactory {
  let index = 0;
  return () => {
    const t = transports[Math.min(index, transports.length - 1)] as Transport;
    index += 1;
    return t;
  };
}

describe("McpConnector connected identity (in-memory SDK transport)", () => {
  it("constructor is lazy: no dial, no enabled/allowed state before validation", async () => {
    const server = await linkedServer();
    let dials = 0;
    const connector = new McpConnector(
      baseConfig([
        { upstreamTool: "search-events", canonicalSchemaHash: HASH },
      ]),
      () => {
        dials += 1;
        return server.transport;
      },
    );
    closables.push(() => connector.shutdown());
    expect(connector.stats()).toEqual({
      connected: false,
      consecutiveFailures: 0,
      enabledBindings: [],
    });
    expect(connector.isAllowed("search-events")).toBe(false);
    expect(dials).toBe(0);
  });

  it("refuses an unconfigured write name before any dial with mcp_binding_not_allowed", async () => {
    const server = await linkedServer();
    let dials = 0;
    const connector = new McpConnector(
      baseConfig([
        { upstreamTool: "search-events", canonicalSchemaHash: HASH },
      ]),
      () => {
        dials += 1;
        return server.transport;
      },
    );
    closables.push(() => connector.shutdown());
    const res = await connector.callTool("delete-event", { id: "42" });
    expect(res).toEqual({ ok: false, code: "mcp_binding_not_allowed" });
    expect(dials).toBe(0);
    expect(server.calls()).toBe(0);
    expect(connector.stats()).toEqual({
      connected: false,
      consecutiveFailures: 0,
      enabledBindings: [],
    });
  });

  it("matching wire identity with a DIFFERENT logical serverId dispatches the registered tool", async () => {
    const realHash = await probeSearchHash();
    const server = await linkedServer();
    const connector = new McpConnector(
      baseConfig(
        [{ upstreamTool: "search-events", canonicalSchemaHash: realHash }],
        // Logical id deliberately unlike the wire name.
        { serverId: "logical-google-calendar-fork" },
      ),
      queuedFactory([server.transport]),
    );
    closables.push(() => connector.shutdown());
    const res = await connector.callTool("search-events", { q: "standup" });
    expect(res).toMatchObject({
      ok: true,
      structuredContent: { totalCount: 1 },
    });
    expect(connector.isAllowed("search-events")).toBe(true);
    expect(server.calls()).toBe(1);
    // Shutdown clears enabled/allowed state (no stale callable binding).
    await connector.shutdown();
    expect(connector.stats()).toEqual({
      connected: false,
      consecutiveFailures: 0,
      enabledBindings: [],
    });
    expect(connector.isAllowed("search-events")).toBe(false);
  });

  it("wrong wire server NAME rejects with fixed mismatch, disables all, no tool calls", async () => {
    const realHash = await probeSearchHash();
    const server = await linkedServer({ serverName: "evil-calendar" });
    const connector = new McpConnector(
      baseConfig([
        { upstreamTool: "search-events", canonicalSchemaHash: realHash },
        { upstreamTool: "get-event", canonicalSchemaHash: HASH },
      ]),
      queuedFactory([server.transport]),
    );
    closables.push(() => connector.shutdown());
    const ensured = await connector.ensureConnected();
    expect(ensured).toEqual({ ok: false, code: "mcp_schema_mismatch" });
    expect(connector.isAllowed("search-events")).toBe(false);
    expect(connector.isAllowed("get-event")).toBe(false);
    expect(connector.stats()).toEqual({
      connected: false,
      consecutiveFailures: 0,
      enabledBindings: [],
    });
    expect(server.calls()).toBe(0);
    expect(server.closes()).toBeGreaterThanOrEqual(1);
    // Redaction: no raw identity in the fixed result.
    expect(JSON.stringify(ensured)).not.toContain("evil-calendar");
  });

  it("wrong wire server VERSION rejects with fixed mismatch, disables all, no tool calls", async () => {
    const realHash = await probeSearchHash();
    const server = await linkedServer({ serverVersion: "9.9.9" });
    const connector = new McpConnector(
      baseConfig([
        { upstreamTool: "search-events", canonicalSchemaHash: realHash },
      ]),
      queuedFactory([server.transport]),
    );
    closables.push(() => connector.shutdown());
    const ensured = await connector.ensureConnected();
    expect(ensured).toEqual({ ok: false, code: "mcp_schema_mismatch" });
    expect(connector.isAllowed("search-events")).toBe(false);
    expect(connector.stats().enabledBindings).toEqual([]);
    expect(server.calls()).toBe(0);
    expect(server.closes()).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(ensured)).not.toContain("9.9.9");
  });

  it("revalidates the wire gate every connect and recovers via a fresh correct transport", async () => {
    const realHash = await probeSearchHash();
    const wrongVersion = await linkedServer({ serverVersion: "9.9.9" });
    const correct = await linkedServer();
    let dials = 0;
    const factory: TransportFactory = () => {
      const list = [wrongVersion.transport, correct.transport];
      const t = list[Math.min(dials, list.length - 1)] as Transport;
      dials += 1;
      return t;
    };
    const connector = new McpConnector(
      baseConfig([
        { upstreamTool: "search-events", canonicalSchemaHash: realHash },
      ]),
      factory,
    );
    closables.push(() => connector.shutdown());
    // First explicit call: changed wire version -> mismatch, exactly one dial,
    // no automatic resend/retry within the logical call.
    const first = await connector.callTool("search-events", { q: "first" });
    expect(first).toEqual({ ok: false, code: "mcp_schema_mismatch" });
    expect(dials).toBe(1);
    expect(wrongVersion.calls()).toBe(0);
    expect(connector.stats().connected).toBe(false);
    // A NEW explicit call revalidates the fresh (now correct) transport and
    // enables again instead of stranding a stale disabled flag.
    const second = await connector.callTool("search-events", { q: "second" });
    expect(second).toMatchObject({
      ok: true,
      structuredContent: { totalCount: 1 },
    });
    expect(correct.calls()).toBe(1);
    expect(dials).toBe(2);
    expect(connector.isAllowed("search-events")).toBe(true);
  });

  it("runtime bypass of a missing expected identity fails closed with no transport", async () => {
    const bypassTemplate = {
      connectorInstanceId: "cal-1",
      serverId: "fake",
      kind: "mcp" as const,
      version: "0.0.0",
      transport: {
        kind: "stdio" as const,
        command: "unused",
        args: [] as string[],
        envAllowlist: [...STDIO_IMPLICIT_ENV_VARS] as string[],
        shutdownWaitMs: 3000,
      },
      bindings: [{ upstreamTool: "search-events", canonicalSchemaHash: HASH }],
    };
    const withExpectedName = {
      ...bypassTemplate,
      expectedServerName: "fake-calendar",
    };
    for (const bypass of [
      bypassTemplate, // expectedServerName absent
      { ...withExpectedName, version: undefined }, // expected version absent
    ]) {
      let dials = 0;
      const connector = new McpConnector(
        bypass as unknown as McpConnectorConfig,
        () => {
          dials += 1;
          throw new Error("must not create a transport");
        },
      );
      const ensured = await connector.ensureConnected();
      expect(ensured).toEqual({ ok: false, code: "mcp_schema_mismatch" });
      expect(dials).toBe(0);
      expect(connector.stats().enabledBindings).toEqual([]);
      expect(connector.isAllowed("search-events")).toBe(false);
    }
  });

  it("schema drift denies dispatch with mcp_schema_mismatch and no upstream call", async () => {
    const serverA = await linkedServer();
    const serverB = await linkedServer();
    const connector = new McpConnector(
      baseConfig([
        { upstreamTool: "search-events", canonicalSchemaHash: "0".repeat(64) },
      ]),
      queuedFactory([serverA.transport, serverB.transport]),
    );
    closables.push(() => connector.shutdown());
    const ensured = await connector.ensureConnected();
    expect(ensured).toEqual({ ok: false, code: "mcp_schema_mismatch" });
    expect(connector.isAllowed("search-events")).toBe(false);
    const res = await connector.callTool("search-events", { q: "standup" });
    expect(res).toEqual({ ok: false, code: "mcp_schema_mismatch" });
    expect(serverA.calls()).toBe(0);
    expect(serverB.calls()).toBe(0);
    expect(connector.stats().connected).toBe(false);
  });

  it("partial schema drift keeps the valid binding and disables only the drifted one", async () => {
    const realHash = await probeSearchHash();
    const server = await linkedServer({ withGetEvent: true });
    const connector = new McpConnector(
      baseConfig([
        // Valid binding: exact learned hash.
        { upstreamTool: "search-events", canonicalSchemaHash: realHash },
        // Drifted binding: correct name, wrong configured hash.
        { upstreamTool: "get-event", canonicalSchemaHash: "0".repeat(64) },
      ]),
      queuedFactory([server.transport]),
    );
    closables.push(() => connector.shutdown());
    const ensured = await connector.ensureConnected();
    expect(ensured).toEqual({ ok: true });
    // Stats report ONLY the validated binding; the drifted one stays denied.
    expect(connector.stats()).toEqual({
      connected: true,
      consecutiveFailures: 0,
      enabledBindings: ["search-events"],
    });
    expect(connector.isAllowed("search-events")).toBe(true);
    expect(connector.isAllowed("get-event")).toBe(false);
    // Valid binding actually dispatches and reaches upstream.
    const ok = await connector.callTool("search-events", { q: "standup" });
    expect(ok).toMatchObject({
      ok: true,
      structuredContent: { totalCount: 1 },
    });
    expect(server.calls()).toBe(1);
    // Drifted binding: fixed mismatch, no tool-side effect.
    const bad = await connector.callTool("get-event", { id: "1" });
    expect(bad).toEqual({ ok: false, code: "mcp_schema_mismatch" });
    expect(server.getEventCalls()).toBe(0);
  });

  it("isError=true maps to a fixed redacted error, never ok text", async () => {
    const realHash = await probeSearchHash();
    const server = await linkedServer({ isErrorTool: true });
    const connector = new McpConnector(
      baseConfig([
        { upstreamTool: "search-events", canonicalSchemaHash: realHash },
      ]),
      queuedFactory([server.transport]),
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
    expect(connector.stats()).toEqual({
      connected: false,
      consecutiveFailures: 1,
      enabledBindings: [],
    });
    expect(connector.isAllowed("search-events")).toBe(false);
  });

  it("a failed logical call after connect clears enabled/allowed state", async () => {
    const realHash = await probeSearchHash();
    const server = await linkedServer({ closeDuringSearch: true });
    const connector = new McpConnector(
      baseConfig([
        { upstreamTool: "search-events", canonicalSchemaHash: realHash },
      ]),
      queuedFactory([server.transport]),
    );
    closables.push(() => connector.shutdown());
    const ensured = await connector.ensureConnected();
    expect(ensured).toEqual({ ok: true });
    expect(connector.isAllowed("search-events")).toBe(true);
    // REAL in-flight failure: the upstream SDK handler drops the underlying
    // link AFTER receiving the call, so its response can never be published.
    // The idle transport is NOT pre-closed and no .send/transport mock is used;
    // the single logical call reaches the handler exactly once and is never
    // auto-resent, so this is one genuine connection failure (not a count
    // double).
    const res = await connector.callTool("search-events", { q: "x" });
    expect(res).toEqual({ ok: false, code: "mcp_unavailable" });
    expect(server.calls()).toBe(1);
    expect(connector.stats()).toEqual({
      connected: false,
      consecutiveFailures: 1,
      enabledBindings: [],
    });
    expect(connector.isAllowed("search-events")).toBe(false);
  });
});
