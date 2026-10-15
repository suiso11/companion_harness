/**
 * Dedicated write category gate (M5 reschedule): the connector is either a
 * readonly connector (default `["read"]`) or a DEDICATED write connector
 * (exactly `["write"]`) — never both. A default connector refuses a trusted
 * `write` definition with `mcp_binding_not_allowed` before any dial; a
 * dedicated write connector enables ONLY `write` definitions and refuses
 * `read` ones. Mixed/empty/unknown categories fail closed at construction.
 *
 * Real SDK `Client` + `McpServer` over `InMemoryTransport`; the upstream
 * advertises a `reschedule-event` tool whose name and input-schema hash
 * exactly match the configured binding — the policy (not the wire) decides.
 */
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { McpConnector, STDIO_IMPLICIT_ENV_VARS } from "../src/client.js";
import {
  canonicalSchemaHash,
  type McpConnectorConfig,
  mcpConnectorConfigSchema,
} from "../src/config.js";

const WIRE_NAME = "google-calendar-reschedule";
const WIRE_VERSION = "1.0.0-reschedule.1";

const RESCHEDULE_SCHEMA = {
  calendarId: z.string().min(1).max(512),
  eventId: z.string().min(1).max(1024),
  account: z.string().min(1).max(512).optional(),
  start: z.string().min(1).max(128),
  end: z.string().min(1).max(128),
  expectedEtag: z.string().min(1).max(256),
};
const READ_SCHEMA = { q: z.string() };

const closables: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  const pending = closables.splice(0);
  for (const close of pending) {
    await close().catch(() => undefined);
  }
});

function policyConfig(
  bindings: Array<{ upstreamTool: string; canonicalSchemaHash: string }>,
): McpConnectorConfig {
  return mcpConnectorConfigSchema.parse({
    connectorInstanceId: "cal-write-gate",
    serverId: "logical-write-gate",
    kind: "mcp" as const,
    expectedServerName: WIRE_NAME,
    version: WIRE_VERSION,
    transport: {
      kind: "stdio" as const,
      command: "unused-injected",
      args: [] as string[],
      envAllowlist: [...STDIO_IMPLICIT_ENV_VARS] as string[],
      shutdownWaitMs: 1000,
    },
    bindings,
  });
}

async function probeHash(
  name: string,
  inputSchema: Record<string, z.ZodType>,
): Promise<string> {
  const server = new McpServer({ name: "hash-probe", version: "0.0.0" });
  server.registerTool(
    name,
    { description: "probe", inputSchema },
    async () => ({ content: [{ type: "text" as const, text: "x" }] }),
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const probe = new Client(
    { name: "probe", version: "0.0.0" },
    { capabilities: {} },
  );
  await probe.connect(clientTransport);
  const listed = await probe.listTools();
  const tool = listed.tools.find((entry) => entry.name === name);
  if (tool === undefined) throw new Error("probe tool missing");
  const hash = await canonicalSchemaHash(tool.inputSchema);
  await probe.close().catch(() => undefined);
  await server.close().catch(() => undefined);
  return hash;
}

async function linkedServer() {
  let calls = 0;
  const server = new McpServer({ name: WIRE_NAME, version: WIRE_VERSION });
  server.registerTool(
    "reschedule-event",
    { description: "fixture", inputSchema: RESCHEDULE_SCHEMA },
    async () => {
      calls += 1;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ status: "succeeded" }),
          },
        ],
      };
    },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  closables.push(() => server.close());
  return {
    transport: clientTransport as unknown as Transport,
    calls: () => calls,
  };
}

describe("dedicated write category gate (real in-memory SDK)", () => {
  it("default readonly connector refuses a trusted write definition before any dial", async () => {
    const hash = await probeHash("reschedule-event", RESCHEDULE_SCHEMA);
    const server = await linkedServer();
    let factoryCalls = 0;
    const connector = new McpConnector(
      policyConfig([
        { upstreamTool: "reschedule-event", canonicalSchemaHash: hash },
      ]),
      [
        {
          upstreamTool: "reschedule-event",
          canonicalSchemaHash: hash,
          category: "write",
        },
      ],
      () => {
        factoryCalls += 1;
        return server.transport;
      },
    );
    closables.push(() => connector.shutdown());
    expect(await connector.ensureConnected()).toEqual({
      ok: false,
      code: "mcp_binding_not_allowed",
    });
    expect(
      await connector.callTool("reschedule-event", {
        calendarId: "primary",
        eventId: "evt-1",
        start: "2026-03-01T10:00:00Z",
        end: "2026-03-01T11:00:00Z",
        expectedEtag: '"etag-v1"',
      }),
    ).toEqual({ ok: false, code: "mcp_binding_not_allowed" });
    expect(connector.isAllowed("reschedule-event")).toBe(false);
    expect(factoryCalls).toBe(0);
    expect(server.calls()).toBe(0);
  });

  it("dedicated write connector enables ONLY the write definition and dispatches", async () => {
    const hash = await probeHash("reschedule-event", RESCHEDULE_SCHEMA);
    const server = await linkedServer();
    const connector = new McpConnector(
      policyConfig([
        { upstreamTool: "reschedule-event", canonicalSchemaHash: hash },
      ]),
      [
        {
          upstreamTool: "reschedule-event",
          canonicalSchemaHash: hash,
          category: "write",
        },
      ],
      () => server.transport,
      { permittedCategories: ["write"] },
    );
    closables.push(() => connector.shutdown());
    expect(await connector.ensureConnected()).toEqual({ ok: true });
    expect(connector.isAllowed("reschedule-event")).toBe(true);
    expect(connector.stats().enabledBindings).toEqual(["reschedule-event"]);
    const res = await connector.callTool("reschedule-event", {
      calendarId: "primary",
      eventId: "evt-1",
      start: "2026-03-01T10:00:00Z",
      end: "2026-03-01T11:00:00Z",
      expectedEtag: '"etag-v1"',
    });
    expect(res.ok).toBe(true);
    expect(server.calls()).toBe(1);
    await connector.shutdown();
    expect(connector.isAllowed("reschedule-event")).toBe(false);
  });

  it("dedicated write connector refuses a read definition (boundary both ways)", async () => {
    const readHash = await probeHash("search-events", READ_SCHEMA);
    const server = await linkedServer();
    let factoryCalls = 0;
    const connector = new McpConnector(
      policyConfig([
        { upstreamTool: "search-events", canonicalSchemaHash: readHash },
      ]),
      [
        {
          upstreamTool: "search-events",
          canonicalSchemaHash: readHash,
          category: "read",
        },
      ],
      () => {
        factoryCalls += 1;
        return server.transport;
      },
      { permittedCategories: ["write"] },
    );
    closables.push(() => connector.shutdown());
    expect(await connector.ensureConnected()).toEqual({
      ok: false,
      code: "mcp_binding_not_allowed",
    });
    expect(factoryCalls).toBe(0);
  });

  it("mixed/empty/unknown categories fail closed at construction", async () => {
    const hash = await probeHash("reschedule-event", RESCHEDULE_SCHEMA);
    const server = await linkedServer();
    const config = policyConfig([
      { upstreamTool: "reschedule-event", canonicalSchemaHash: hash },
    ]);
    const defs = [
      {
        upstreamTool: "reschedule-event",
        canonicalSchemaHash: hash,
        category: "write" as const,
      },
    ];
    expect(
      () =>
        new McpConnector(config, defs, () => server.transport, {
          permittedCategories: ["read", "write"],
        }),
    ).toThrow("mcp_unavailable");
    expect(
      () =>
        new McpConnector(config, defs, () => server.transport, {
          permittedCategories: [],
        }),
    ).toThrow("mcp_unavailable");
    expect(
      () =>
        new McpConnector(config, defs, () => server.transport, {
          permittedCategories: ["sensitive"],
        }),
    ).toThrow("mcp_unavailable");
  });
});
