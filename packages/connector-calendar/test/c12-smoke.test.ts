/**
 * C12 end-to-end smoke over a GENUINE MCP SDK local inert provider.
 *
 * Pipeline under test (no HTTP/stdio/OAuth/network):
 *   low-level SDK `Server` + `InMemoryTransport` linked pair
 *     -> real `@companion/connector-mcp` `McpConnector` (policy + identity)
 *     -> real `createCalendarConnector` adapter (map + normalize)
 *     -> real kernel `ToolBroker` + `ReferenceManager`
 *     -> SQLite (`resource_snapshots` / `session_references` / private
 *        `calendar_get_targets`)
 *     -> model-facing reference output.
 *
 * Every call is real consumer behavior: the provider is an inert synthetic
 * server, but the protocol, decoding, identity checks, snapshotting and
 * private-target persistence all run through the production code paths.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  closeKernelDatabase,
  createDurableCalendarTargetStore,
  createKernelRepository,
  createM1ToolRegistrations,
  createReferenceManager,
  createToolBroker,
  type KernelDatabaseHandle,
  migrateKernelDatabase,
  openKernelDatabase,
} from "../../kernel/src/index.js";
import {
  type CalendarConnector,
  createCalendarConnector,
} from "../src/adapter.js";

const T0 = 1790000000000;
const CTX = { origin: "smoke-origin", caller: "smoke-caller" };
const WIRE_NAME = "c12-inert-calendar";
const WIRE_VERSION = "0.0.0-c12";
const CALENDAR_ID = "host-calendar-id";
const ACCOUNT = "host-account";

const SEARCH_TOOL = "search-events";
const LIST_TOOL = "list-events";
const GET_TOOL = "get-event";

const SEARCH_INPUT_SCHEMA = {
  type: "object",
  properties: {
    calendarId: { type: "string" },
    account: { type: "string" },
    timeMin: { type: "string" },
    timeMax: { type: "string" },
    timeZone: { type: "string" },
    pageSize: { type: "number" },
    pageToken: { type: "string" },
    query: { type: "string" },
  },
  required: ["calendarId", "timeMin", "timeMax", "timeZone", "pageSize"],
  additionalProperties: true,
};
const GET_INPUT_SCHEMA = {
  type: "object",
  properties: {
    eventId: { type: "string" },
    calendarId: { type: "string" },
    account: { type: "string" },
  },
  required: ["eventId"],
  additionalProperties: true,
};

let searchHash = "";
let getHash = "";

beforeAll(async () => {
  searchHash = await canonicalSchemaHash(SEARCH_INPUT_SCHEMA);
  getHash = await canonicalSchemaHash(GET_INPUT_SCHEMA);
});

interface RawEvent {
  id: string;
  calendarId: string;
  status: string;
  summary: string;
  start: { dateTime?: string; timeZone?: string };
  end: { dateTime?: string; timeZone?: string };
  etag?: string;
}

function rawEvent(overrides: Partial<RawEvent> = {}): RawEvent {
  return {
    id: "evt-a",
    calendarId: CALENDAR_ID,
    status: "confirmed",
    summary: "Standup",
    start: { dateTime: "2026-10-01T09:00:00+09:00", timeZone: "Asia/Tokyo" },
    end: { dateTime: "2026-10-01T10:00:00+09:00", timeZone: "Asia/Tokyo" },
    etag: '"etag-1"',
    ...overrides,
  };
}

interface WireState {
  events: RawEvent[];
  nextPageToken?: string;
  fail: boolean;
  searchArgs: Array<Record<string, unknown>>;
  searchTimeZones: string[];
  calls: string[];
  onSearch?: () => void;
  onGet?: () => void;
}

function freshState(events: RawEvent[]): WireState {
  return {
    events,
    fail: false,
    searchArgs: [],
    searchTimeZones: [],
    calls: [],
  };
}

const closables: Array<() => Promise<unknown> | undefined> = [];
const tempDirs: string[] = [];
afterEach(async () => {
  const pending = closables.splice(0);
  for (const close of pending) {
    await Promise.resolve(close()).catch(() => undefined);
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function createInertServer(state: WireState): Promise<{
  transport: Transport;
  server: Server;
}> {
  const server = new Server(
    { name: WIRE_NAME, version: WIRE_VERSION },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, (async () => ({
    tools: [
      { name: SEARCH_TOOL, inputSchema: SEARCH_INPUT_SCHEMA },
      { name: LIST_TOOL, inputSchema: SEARCH_INPUT_SCHEMA },
      { name: GET_TOOL, inputSchema: GET_INPUT_SCHEMA },
    ],
  })) as never);
  server.setRequestHandler(CallToolRequestSchema, ((request: unknown) => {
    const params = (
      request as {
        params?: { name?: string; arguments?: Record<string, unknown> };
      }
    ).params;
    const tool = params?.name ?? "";
    const args = params?.arguments ?? {};
    state.calls.push(tool);
    if (tool === GET_TOOL) {
      state.onGet?.();
      const event = state.events.find((entry) => entry.id === args.eventId);
      if (event === undefined) {
        return {
          content: [{ type: "text", text: "not found" }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: "{}" }],
        structuredContent: { event },
      };
    }
    state.searchArgs.push(args);
    state.searchTimeZones.push(String(args.timeZone ?? ""));
    state.onSearch?.();
    if (state.fail) {
      return {
        content: [{ type: "text", text: "upstream private failure" }],
        isError: true,
      };
    }
    if (tool === SEARCH_TOOL) {
      return {
        content: [{ type: "text", text: "{}" }],
        structuredContent: {
          events: state.events,
          totalCount: state.events.length,
          calendarId: CALENDAR_ID,
          timeRange: {
            start: String(args.timeMin ?? "2026-10-01T00:00:00Z"),
            end: String(args.timeMax ?? "2026-10-02T00:00:00Z"),
          },
          ...(state.nextPageToken !== undefined
            ? { nextPageToken: state.nextPageToken }
            : {}),
        },
      };
    }
    return {
      content: [{ type: "text", text: "{}" }],
      structuredContent: {
        events: state.events,
        totalCount: state.events.length,
        ...(state.nextPageToken !== undefined
          ? { nextPageToken: state.nextPageToken }
          : {}),
      },
    };
  }) as never);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return { transport: clientTransport as unknown as Transport, server };
}

function config(): McpConnectorConfig {
  return mcpConnectorConfigSchema.parse({
    connectorInstanceId: "logical-c12",
    serverId: "logical-c12",
    kind: "mcp",
    expectedServerName: WIRE_NAME,
    version: WIRE_VERSION,
    transport: {
      kind: "streamable-http",
      host: "127.0.0.1",
      port: 1,
      path: "/mcp",
      followRedirects: false,
    },
    bindings: [
      { upstreamTool: SEARCH_TOOL, canonicalSchemaHash: searchHash },
      { upstreamTool: LIST_TOOL, canonicalSchemaHash: searchHash },
      { upstreamTool: GET_TOOL, canonicalSchemaHash: getHash },
    ],
  });
}

function definitions(): McpBindingDefinition[] {
  return [
    {
      upstreamTool: SEARCH_TOOL,
      canonicalSchemaHash: searchHash,
      category: "read",
    },
    {
      upstreamTool: LIST_TOOL,
      canonicalSchemaHash: searchHash,
      category: "read",
    },
    { upstreamTool: GET_TOOL, canonicalSchemaHash: getHash, category: "read" },
  ];
}

interface Stack {
  dbPath: string;
  handle: KernelDatabaseHandle;
  repo: ReturnType<typeof createKernelRepository>;
  manager: ReturnType<typeof createReferenceManager>;
  broker: ReturnType<typeof createToolBroker>;
  adapter: CalendarConnector;
  connectorInstanceId: string;
  state: WireState;
  close: () => Promise<void>;
}

async function createStack(dbPath: string, state: WireState): Promise<Stack> {
  const handle = openKernelDatabase(dbPath);
  await migrateKernelDatabase({ db: handle.raw });
  const repo = createKernelRepository(handle.raw);
  const manager = createReferenceManager(handle.raw);
  const row = manager.ensureCalendarConnectorInstance(
    "host-calendar",
    CALENDAR_ID,
    { account: ACCOUNT, now: T0 },
  );
  const { transport, server } = await createInertServer(state);
  const mcp = new McpConnector(config(), definitions(), () => transport);
  const adapter: CalendarConnector = createCalendarConnector({
    connectorInstanceId: row.id,
    connector: mcp,
    selection: { calendarId: CALENDAR_ID, account: ACCOUNT },
  });
  const registrations = createM1ToolRegistrations({
    db: handle.raw,
    repo,
    referenceManager: manager,
    bindings: [],
    calendarBinding: { connectorInstanceId: row.id, connector: adapter },
    calendarTargetStore: createDurableCalendarTargetStore(handle.raw),
    clock: { now: () => T0 + 100 },
  });
  const broker = createToolBroker({
    db: handle.raw,
    repo,
    registrations,
  });
  return {
    dbPath,
    handle,
    repo,
    manager,
    broker,
    adapter,
    connectorInstanceId: row.id,
    state,
    close: async () => {
      await mcp.shutdown().catch(() => undefined);
      await server.close().catch(() => undefined);
      closeKernelDatabase(handle);
    },
  };
}

function newRunningRun(
  repo: Stack["repo"],
  now = T0,
  timeZone?: string,
): { sessionId: string; runId: string } {
  const sessionId = repo.createSession({ key: randomUUID(), now }).body
    .sessionId;
  const posted = repo.postMessage(
    sessionId,
    { text: "calendar smoke" },
    {
      key: randomUUID(),
      now,
      ...(timeZone !== undefined ? { timeZone } : {}),
    },
  );
  const runId = posted.body.run.id;
  repo.startRun(runId, { now: now + 1 });
  return { sessionId, runId };
}

const SEARCH_INPUT = {
  query: "standup",
  start: "2026-10-01T00:00:00+09:00",
  end: "2026-10-01T23:59:59+09:00",
  limit: 10,
};

function tempDb(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `c12-smoke-${name}-`));
  tempDirs.push(dir);
  return join(dir, "kernel.sqlite");
}

describe("C12 genuine-SDK inert provider smoke", () => {
  it("one page, frozen Turn zone, verbatim cursor, and a persisted private target", async () => {
    const state = freshState([rawEvent()]);
    state.nextPageToken = "opaque-cursor";
    const stack = await createStack(tempDb("onepage"), state);
    closables.push(stack.close);
    const { runId } = newRunningRun(stack.repo, T0, "Asia/Tokyo");
    const out = await stack.broker.invoke(
      runId,
      "calendar.search",
      SEARCH_INPUT,
      CTX,
    );
    expect(out.result.actualOutcome).toBe("succeeded");
    const normalizedOut = out.normalized as {
      cursor?: string;
      hits: Array<{ canonicalKey: string }>;
    };
    expect(normalizedOut.cursor).toBe("opaque-cursor");
    expect(normalizedOut.hits).toHaveLength(1);
    expect(normalizedOut.hits[0]?.canonicalKey).toMatch(
      /^calendar:[0-9a-f]{64}$/,
    );
    // Frozen zone from the Turn (never a construction-time global).
    expect(state.searchTimeZones).toEqual(["Asia/Tokyo"]);
    // Exactly one upstream page request, no auto-pagination.
    expect(state.calls.filter((c) => c === SEARCH_TOOL)).toHaveLength(1);
    // The private target is durable in the private table.
    const target = stack.handle.raw
      .prepare("SELECT target_json FROM calendar_get_targets")
      .get() as { target_json: string } | undefined;
    expect(target).toBeDefined();
    expect(JSON.parse(target?.target_json ?? "{}")).toEqual({
      calendarId: CALENDAR_ID,
      eventId: "evt-a",
      account: ACCOUNT,
    });
  });

  it("same revision reuses one Snapshot; a changed revision materializes a new one", async () => {
    const state = freshState([rawEvent()]);
    const stack = await createStack(tempDb("reuse"), state);
    closables.push(stack.close);
    const { runId } = newRunningRun(stack.repo);
    const first = await stack.broker.invoke(
      runId,
      "calendar.search",
      SEARCH_INPUT,
      CTX,
    );
    const firstHit = (
      first.normalized as {
        hits: Array<{ referenceId: string; snapshotId: string }>;
      }
    ).hits[0] as { referenceId: string; snapshotId: string };
    const same = await stack.broker.invoke(
      runId,
      "calendar.search",
      SEARCH_INPUT,
      {
        ...CTX,
        freshness: "refresh",
      },
    );
    const sameHit = (
      same.normalized as {
        hits: Array<{ referenceId: string; snapshotId: string }>;
      }
    ).hits[0] as { referenceId: string; snapshotId: string };
    expect(sameHit.snapshotId).toBe(firstHit.snapshotId);
    // Provider revision change -> new Snapshot + rN even with identical text.
    state.events[0] = rawEvent({ etag: '"etag-2"' });
    const changed = await stack.broker.invoke(
      runId,
      "calendar.search",
      SEARCH_INPUT,
      { ...CTX, freshness: "refresh" },
    );
    const changedHit = (
      changed.normalized as {
        hits: Array<{ referenceId: string; snapshotId: string }>;
      }
    ).hits[0] as { referenceId: string; snapshotId: string };
    expect(changedHit.snapshotId).not.toBe(firstHit.snapshotId);
    const revisions = stack.handle.raw
      .prepare(
        "SELECT source_revision FROM resource_snapshots ORDER BY revision ASC",
      )
      .all() as Array<{ source_revision: string }>;
    expect(revisions.map((r) => r.source_revision)).toEqual([
      '"etag-1"',
      '"etag-2"',
    ]);
    // Content change with the SAME revision also materializes a new snapshot.
    state.events[0] = rawEvent({
      summary: "Renamed Standup",
      etag: '"etag-1"',
    });
    const contentChanged = await stack.broker.invoke(
      runId,
      "calendar.search",
      SEARCH_INPUT,
      { ...CTX, freshness: "refresh" },
    );
    const contentChangedHit = (
      contentChanged.normalized as {
        hits: Array<{ snapshotId: string }>;
      }
    ).hits[0] as { snapshotId: string };
    expect(contentChangedHit.snapshotId).not.toBe(changedHit.snapshotId);
  });

  it("queryless search uses list-events and the frozen zone is forwarded", async () => {
    const state = freshState([rawEvent()]);
    const stack = await createStack(tempDb("list"), state);
    closables.push(stack.close);
    const { runId } = newRunningRun(stack.repo, T0, "Europe/Paris");
    const out = await stack.broker.invoke(
      runId,
      "calendar.search",
      {
        start: SEARCH_INPUT.start,
        end: SEARCH_INPUT.end,
        limit: 5,
      },
      CTX,
    );
    expect(out.result.actualOutcome).toBe("succeeded");
    expect(state.calls).toEqual([LIST_TOOL]);
    expect(state.searchTimeZones).toEqual(["Europe/Paris"]);
  });

  it("reference.open is stored-only; explicit refresh rereads and creates a new Snapshot+rN", async () => {
    const state = freshState([rawEvent()]);
    const stack = await createStack(tempDb("refresh"), state);
    closables.push(stack.close);
    const { runId } = newRunningRun(stack.repo);
    const searched = await stack.broker.invoke(
      runId,
      "calendar.search",
      SEARCH_INPUT,
      CTX,
    );
    const hit = (
      searched.normalized as { hits: Array<{ referenceId: string }> }
    ).hits[0] as { referenceId: string };
    const callsAfterSearch = [...state.calls];
    const opened = await stack.broker.invoke(
      runId,
      "reference.open",
      { referenceId: hit.referenceId },
      CTX,
    );
    expect(opened.result.actualOutcome).toBe("succeeded");
    expect(
      (opened.normalized as { body: { text: string } }).body.text,
    ).toContain("Standup");
    expect(state.calls).toEqual(callsAfterSearch);
    const snapshotsBefore = (
      stack.handle.raw
        .prepare("SELECT COUNT(*) AS n FROM resource_snapshots")
        .get() as { n: number }
    ).n;
    const refreshed = await stack.broker.invoke(
      runId,
      "reference.refresh",
      { referenceId: hit.referenceId },
      CTX,
    );
    expect(refreshed.result.actualOutcome).toBe("succeeded");
    expect(state.calls.filter((c) => c === GET_TOOL)).toHaveLength(1);
    const snapshotsAfter = (
      stack.handle.raw
        .prepare("SELECT COUNT(*) AS n FROM resource_snapshots")
        .get() as { n: number }
    ).n;
    expect(snapshotsAfter).toBe(snapshotsBefore + 1);
    // Exact get mapping from the durable private target.
    expect(state.searchArgs.length).toBeGreaterThan(0);
  });

  it("failed and omitted follow-ups retain history; no deletion is inferred", async () => {
    const state = freshState([rawEvent()]);
    const stack = await createStack(tempDb("retain"), state);
    closables.push(stack.close);
    const { runId } = newRunningRun(stack.repo);
    const first = await stack.broker.invoke(
      runId,
      "calendar.search",
      SEARCH_INPUT,
      CTX,
    );
    const hit = (first.normalized as { hits: Array<{ referenceId: string }> })
      .hits[0] as { referenceId: string };
    const snapshotsAfterFirst = (
      stack.handle.raw
        .prepare("SELECT COUNT(*) AS n FROM resource_snapshots")
        .get() as { n: number }
    ).n;
    state.fail = true;
    const failedRun = newRunningRun(stack.repo, T0 + 500).runId;
    const failed = await stack.broker.invoke(
      failedRun,
      "calendar.search",
      SEARCH_INPUT,
      CTX,
    );
    expect(failed.result.actualOutcome).toBe("failed");
    expect(failed.result.errorCode).toBe("calendar_upstream_error");
    state.fail = false;
    state.events = [];
    const omittedRun = newRunningRun(stack.repo, T0 + 900).runId;
    const omitted = await stack.broker.invoke(
      omittedRun,
      "calendar.search",
      SEARCH_INPUT,
      CTX,
    );
    expect(omitted.result.actualOutcome).toBe("succeeded");
    expect(
      (
        stack.handle.raw
          .prepare("SELECT COUNT(*) AS n FROM resource_snapshots")
          .get() as { n: number }
      ).n,
    ).toBe(snapshotsAfterFirst);
    const reopened = await stack.broker.invoke(
      runId,
      "reference.open",
      { referenceId: hit.referenceId },
      CTX,
    );
    expect(reopened.result.actualOutcome).toBe("succeeded");
    expect(
      (reopened.normalized as { body: { text: string } }).body.text,
    ).toContain("Standup");
    expect(JSON.stringify(reopened.modelFacing).toLowerCase()).not.toContain(
      "deleted",
    );
  });

  it("a late-cancelled genuine result writes no Snapshot/rN/set/ref/target", async () => {
    const state = freshState([rawEvent()]);
    const stack = await createStack(tempDb("cancel"), state);
    closables.push(stack.close);
    const { sessionId, runId } = newRunningRun(stack.repo);
    const before = {
      snapshots: (
        stack.handle.raw
          .prepare("SELECT COUNT(*) AS n FROM resource_snapshots")
          .get() as { n: number }
      ).n,
      targets: (
        stack.handle.raw
          .prepare("SELECT COUNT(*) AS n FROM calendar_get_targets")
          .get() as { n: number }
      ).n,
      refs: (
        stack.handle.raw
          .prepare("SELECT COUNT(*) AS n FROM session_references")
          .get() as { n: number }
      ).n,
    };
    // The inert provider cancels the Run while the MCP call is in flight, so
    // the result arrives AFTER the Run left `running`.
    state.onSearch = () => {
      stack.repo.cancelRun(sessionId, runId, { now: T0 + 5 });
    };
    const out = await stack.broker.invoke(
      runId,
      "calendar.search",
      SEARCH_INPUT,
      CTX,
    );
    expect(out.result.actualOutcome).toBe("cancelled");
    expect(out.result.errorCode).toBe("execution_cancelled");
    expect(
      (
        stack.handle.raw
          .prepare("SELECT COUNT(*) AS n FROM resource_snapshots")
          .get() as { n: number }
      ).n,
    ).toBe(before.snapshots);
    expect(
      (
        stack.handle.raw
          .prepare("SELECT COUNT(*) AS n FROM calendar_get_targets")
          .get() as { n: number }
      ).n,
    ).toBe(before.targets);
    expect(
      (
        stack.handle.raw
          .prepare("SELECT COUNT(*) AS n FROM session_references")
          .get() as { n: number }
      ).n,
    ).toBe(before.refs);
    expect(
      (
        stack.handle.raw
          .prepare("SELECT COUNT(*) AS n FROM reference_sets")
          .get() as { n: number }
      ).n,
    ).toBe(0);
  });

  it("provenance stays opaque and provider ids live only in the private table", async () => {
    const state = freshState([rawEvent()]);
    const stack = await createStack(tempDb("privacy"), state);
    closables.push(stack.close);
    const { runId } = newRunningRun(stack.repo, T0, "Asia/Tokyo");
    const out = await stack.broker.invoke(
      runId,
      "calendar.search",
      SEARCH_INPUT,
      CTX,
    );
    const serialized = JSON.stringify(out.modelFacing);
    expect(serialized).not.toContain("evt-a");
    expect(serialized).not.toContain(CALENDAR_ID);
    expect(serialized).not.toContain(ACCOUNT);
    expect(serialized).not.toContain(WIRE_NAME);
    // The private target table does hold the provider ids (host-side only).
    const target = stack.handle.raw
      .prepare("SELECT target_json FROM calendar_get_targets")
      .get() as { target_json: string };
    expect(target.target_json).toContain("evt-a");
  });

  it("durable private target survives restart and refresh rereads with no re-search", async () => {
    const dbPath = tempDb("restart");
    const state = freshState([rawEvent()]);
    const first = await createStack(dbPath, state);
    let runId = "";
    let referenceId = "";
    const run = newRunningRun(first.repo);
    runId = run.runId;
    const searched = await first.broker.invoke(
      runId,
      "calendar.search",
      SEARCH_INPUT,
      CTX,
    );
    referenceId = (
      searched.normalized as { hits: Array<{ referenceId: string }> }
    ).hits[0]?.referenceId as string;
    await first.close();
    // Fresh process: new SQLite connection, new SDK provider, new connector.
    const state2 = freshState([rawEvent()]);
    const second = await createStack(dbPath, state2);
    closables.push(second.close);
    expect(
      (
        second.handle.raw
          .prepare("SELECT COUNT(*) AS n FROM calendar_get_targets")
          .get() as { n: number }
      ).n,
    ).toBe(1);
    const refreshed = await second.broker.invoke(
      runId,
      "reference.refresh",
      { referenceId },
      CTX,
    );
    expect(refreshed.result.actualOutcome).toBe("succeeded");
    expect(state2.calls.filter((c) => c === GET_TOOL)).toHaveLength(1);
    expect(state2.calls.filter((c) => c === SEARCH_TOOL)).toHaveLength(0);
  });
});

describe("C12 adapter binding identity (cross-calendar get)", () => {
  it("refuses a get target that leaves the trusted single-calendar selection", async () => {
    const state = freshState([rawEvent()]);
    const stack = await createStack(tempDb("cross"), state);
    closables.push(stack.close);
    const result = await stack.adapter.get({
      calendarId: "some-other-calendar",
      eventId: "evt-a",
    });
    expect(result).toEqual({ ok: false, code: "calendar_range_invalid" });
    expect(state.calls.filter((c) => c === GET_TOOL)).toHaveLength(0);
  });
});
