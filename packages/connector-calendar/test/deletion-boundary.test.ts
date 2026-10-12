/**
 * C11 Calendar consumer deletion-boundary regressions.
 *
 * These drive the REAL `@companion/connector-mcp` `McpConnector` over the
 * GENUINE lower-level SDK `Server` + `InMemoryTransport` (public
 * `CallToolRequestSchema`/`ListToolsRequestSchema` handlers) and feed the
 * returned `CallResult` through the Calendar consumer decoders. The server
 * fixture is synthetic and no HTTP is ever dialled: the config carries a dummy
 * loopback URL, but the injected in-memory transport is used instead.
 *
 * Every case is a NEGATIVE invariant. `cancelled`, an `isError` body, a thrown
 * JSON-RPC error, an empty one-page search, a raw `deleted` status, and
 * unknown tombstone hint flags must never produce a Calendar tombstone. There
 * is NO adopted positive authoritative get-tombstone contract (C11-01 is
 * BLOCKED), so no case fabricates one.
 */

import {
  canonicalSchemaHash,
  type McpBindingDefinition,
  McpConnector,
  type McpConnectorConfig,
  mcpConnectorConfigSchema,
} from "@companion/connector-mcp";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  canonicalKey,
  normalizeGetResult,
  normalizeSearchResult,
} from "../src/normalize.js";

const GET_TOOL = "get-event";
const SEARCH_TOOL = "search-events";
const WIRE_NAME = "c11-fixture";
const WIRE_VERSION = "1.0.0";
const CONNECTOR_INSTANCE = "cal-c11";
const CALENDAR_ID = "primary";

/** Minimal readonly fixture schemas: name + shape only, no tool inventory. */
const GET_INPUT_SCHEMA = {
  type: "object",
  properties: { eventId: { type: "string" } },
  required: ["eventId"],
};
const SEARCH_INPUT_SCHEMA = {
  type: "object",
  properties: { timeMin: { type: "string" } },
  required: ["timeMin"],
};

const GET_OPTIONS = {
  connectorInstanceId: CONNECTOR_INSTANCE,
  calendarId: CALENDAR_ID,
};
const SEARCH_OPTIONS = {
  connectorInstanceId: CONNECTOR_INSTANCE,
  calendarId: CALENDAR_ID,
  requestedLimit: 10,
  operation: "search-events" as const,
};

let getHash = "";
let searchHash = "";

beforeAll(async () => {
  getHash = await canonicalSchemaHash(GET_INPUT_SCHEMA);
  searchHash = await canonicalSchemaHash(SEARCH_INPUT_SCHEMA);
});

const closables: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  const pending = closables.splice(0);
  for (const close of pending) {
    await close().catch(() => undefined);
  }
});

/** A genuine structured `get-event` result carrying a synthetic event body. */
function eventResult(event: Record<string, unknown>): Record<string, unknown> {
  return {
    content: [{ type: "text", text: "{}" }],
    structuredContent: { event },
  };
}

function rawEvent(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "fixture-event",
    calendarId: CALENDAR_ID,
    status: "confirmed",
    summary: "Fixture Event",
    start: { dateTime: "2026-10-01T09:00:00Z" },
    end: { dateTime: "2026-10-01T10:00:00Z" },
    ...overrides,
  };
}

type Reply = { result: Record<string, unknown> } | { error: McpError };

interface Fixture {
  transport: Transport;
  calls: (tool: string) => number;
  totalCalls: () => number;
}

/**
 * Low-level SDK `Server` over a linked `InMemoryTransport` pair. It advertises
 * exactly the two readonly fixture tools with their exact input schemas so the
 * trusted binding-identity verification passes, and answers `tools/call`
 * through the supplied reply (a structured result or a thrown `McpError`).
 */
async function linkedFixture(reply: (tool: string) => Reply): Promise<Fixture> {
  const counts = new Map<string, number>();
  const server = new Server(
    { name: WIRE_NAME, version: WIRE_VERSION },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, (async () => ({
    tools: [
      { name: GET_TOOL, inputSchema: GET_INPUT_SCHEMA },
      { name: SEARCH_TOOL, inputSchema: SEARCH_INPUT_SCHEMA },
    ],
  })) as never);
  server.setRequestHandler(CallToolRequestSchema, ((request: unknown) => {
    const tool = (request as { params?: { name?: string } }).params?.name ?? "";
    counts.set(tool, (counts.get(tool) ?? 0) + 1);
    const decided = reply(tool);
    if ("error" in decided) throw decided.error;
    return decided.result;
  }) as never);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  closables.push(() => server.close());
  return {
    transport: clientTransport as unknown as Transport,
    calls: (tool) => counts.get(tool) ?? 0,
    totalCalls: () => [...counts.values()].reduce((sum, n) => sum + n, 0),
  };
}

function baseConfig(): McpConnectorConfig {
  return mcpConnectorConfigSchema.parse({
    connectorInstanceId: CONNECTOR_INSTANCE,
    serverId: "logical-c11",
    kind: "mcp" as const,
    expectedServerName: WIRE_NAME,
    version: WIRE_VERSION,
    transport: {
      kind: "streamable-http" as const,
      host: "127.0.0.1",
      port: 1,
      path: "/mcp",
      followRedirects: false,
    },
    bindings: [
      { upstreamTool: GET_TOOL, canonicalSchemaHash: getHash },
      { upstreamTool: SEARCH_TOOL, canonicalSchemaHash: searchHash },
    ],
  });
}

function connectorFor(transport: Transport): McpConnector {
  const definitions: McpBindingDefinition[] = [
    { upstreamTool: GET_TOOL, canonicalSchemaHash: getHash, category: "read" },
    {
      upstreamTool: SEARCH_TOOL,
      canonicalSchemaHash: searchHash,
      category: "read",
    },
  ];
  const connector = new McpConnector(
    baseConfig(),
    definitions,
    () => transport,
  );
  closables.push(() => connector.shutdown());
  return connector;
}

describe("C11 consumer deletion boundary (real SDK wire, synthetic fixture)", () => {
  it("keeps a cancelled get as a normal status, not a tombstone", async () => {
    const bodies = [
      eventResult(rawEvent({ etag: '"etag-r1"' })),
      eventResult(rawEvent({ status: "cancelled", etag: '"etag-r2"' })),
    ];
    let index = 0;
    const fixture = await linkedFixture(() => ({
      result: bodies[index++] ?? eventResult(rawEvent()),
    }));
    const connector = connectorFor(fixture.transport);
    expect(await connector.ensureConnected()).toEqual({ ok: true });

    const first = await normalizeGetResult(
      await connector.callTool(GET_TOOL, { eventId: "fixture-event" }),
      GET_OPTIONS,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await normalizeGetResult(
      await connector.callTool(GET_TOOL, { eventId: "fixture-event" }),
      GET_OPTIONS,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.event.canonicalKey).toBe(
      await canonicalKey(CONNECTOR_INSTANCE, CALENDAR_ID, "fixture-event"),
    );
    expect(second.event.canonicalKey).toBe(first.event.canonicalKey);
    expect(second.event.status).toBe("cancelled");
    expect(second.event.status).not.toBe("deleted");
    expect(second.event.title).toBe("Fixture Event");
    expect(second.event.sourceRevision).toBe('"etag-r2"');
    expect(second.event.sourceRevision).not.toBe(first.event.sourceRevision);
  });

  it("redacts an isError 404 marker with a conflicting deleted body", async () => {
    const sentinel = "private-404-marker-do-not-leak";
    const fixture = await linkedFixture(() => ({
      result: {
        content: [
          { type: "text", text: `${sentinel} upstream reported not found` },
        ],
        isError: true,
        structuredContent: { event: rawEvent({ status: "deleted" }) },
      },
    }));
    const connector = connectorFor(fixture.transport);
    expect(await connector.ensureConnected()).toEqual({ ok: true });

    const upstream = await connector.callTool(GET_TOOL, {
      eventId: "fixture-event",
    });
    expect(upstream).toEqual({ ok: false, code: "calendar_upstream_error" });
    expect(JSON.stringify(upstream)).not.toContain(sentinel);
    expect(await normalizeGetResult(upstream, GET_OPTIONS)).toEqual({
      ok: false,
      code: "calendar_upstream_error",
    });
  });

  it("redacts a thrown InternalError 410 and never auto-resends", async () => {
    const sentinel = "private-410-marker-do-not-leak";
    const fixture = await linkedFixture(() => ({
      error: new McpError(
        ErrorCode.InternalError,
        `upstream failed ${sentinel}`,
        { status: 410, detail: sentinel },
      ),
    }));
    const connector = connectorFor(fixture.transport);
    expect(await connector.ensureConnected()).toEqual({ ok: true });

    const upstream = await connector.callTool(GET_TOOL, {
      eventId: "fixture-event",
    });
    expect(upstream).toEqual({ ok: false, code: "mcp_unavailable" });
    expect(JSON.stringify(upstream)).not.toContain(sentinel);
    expect(fixture.calls(GET_TOOL)).toBe(1);
    expect(fixture.totalCalls()).toBe(1);
    expect(await normalizeGetResult(upstream, GET_OPTIONS)).toEqual({
      ok: false,
      code: "mcp_unavailable",
    });
  });

  it("returns an empty page plus its opaque cursor and never infers deletion", async () => {
    const cursor = "opaque-next-page-token";
    const fixture = await linkedFixture((tool) =>
      tool === GET_TOOL
        ? { result: eventResult(rawEvent()) }
        : {
            result: {
              content: [{ type: "text", text: "{}" }],
              structuredContent: {
                events: [],
                totalCount: 0,
                calendarId: CALENDAR_ID,
                timeRange: {
                  start: "2026-10-01T00:00:00Z",
                  end: "2026-10-02T00:00:00Z",
                },
                nextPageToken: cursor,
              },
            },
          },
    );
    const connector = connectorFor(fixture.transport);
    expect(await connector.ensureConnected()).toEqual({ ok: true });

    const prior = await normalizeGetResult(
      await connector.callTool(GET_TOOL, { eventId: "fixture-event" }),
      GET_OPTIONS,
    );
    expect(prior.ok).toBe(true);

    const page = await normalizeSearchResult(
      await connector.callTool(SEARCH_TOOL, {
        timeMin: "2026-10-01T00:00:00Z",
      }),
      SEARCH_OPTIONS,
    );
    expect(page).toEqual({ ok: true, events: [], cursor });
    expect(fixture.calls(SEARCH_TOOL)).toBe(1);
  });

  it("rejects a raw get whose consumed status is the future deleted value", async () => {
    const fixture = await linkedFixture(() => ({
      result: eventResult(rawEvent({ status: "deleted" })),
    }));
    const connector = connectorFor(fixture.transport);
    expect(await connector.ensureConnected()).toEqual({ ok: true });

    const upstream = await connector.callTool(GET_TOOL, {
      eventId: "fixture-event",
    });
    expect(upstream.ok).toBe(true);
    expect(await normalizeGetResult(upstream, GET_OPTIONS)).toEqual({
      ok: false,
      code: "calendar_response_invalid",
    });
  });

  it("strips unknown deleted/tombstone hint flags from a confirmed event", async () => {
    const fixture = await linkedFixture(() => ({
      result: eventResult(
        rawEvent({
          deleted: true,
          tombstone: true,
          provenance: "get-tombstone",
        }),
      ),
    }));
    const connector = connectorFor(fixture.transport);
    expect(await connector.ensureConnected()).toEqual({ ok: true });

    const decoded = await normalizeGetResult(
      await connector.callTool(GET_TOOL, { eventId: "fixture-event" }),
      GET_OPTIONS,
    );
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.event.status).toBe("confirmed");
    expect(decoded.event).not.toHaveProperty("deleted");
    expect(decoded.event).not.toHaveProperty("tombstone");
    expect(decoded.event).not.toHaveProperty("provenance");
  });
});
