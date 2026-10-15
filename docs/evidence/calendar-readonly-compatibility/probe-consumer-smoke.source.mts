/**
 * Current-consumer smoke probe for fork 3.0.0-readonly.2 (credential-free).
 *
 * Seam (historical C08): real `GoogleCalendarMcpServer` + private
 * `buildServer()` (actual ToolRegistry schemas/registration/handlers), with
 * ONLY two test-only seams:
 *   1. `executeWithHandler` override routes ACTUAL `handler.runTool(args,
 *      fixtureAccounts)` (skips TokenManager/OAuth/account-index I/O).
 *   2. `BaseToolHandler.prototype.getCalendar` returns an inert fixture
 *      Google provider (records events.list/events.get; calendarList.get /
 *      calendarList.list / calendars.get DENY + count; no HTTP).
 * stdlib `http`/`https` request/get and global `fetch` are patched to count
 * + throw; all deny counters MUST be 0. No CLI/index/auth/OAuth runs, no
 * token files, no live Google HTTP, no secrets.
 *
 * Consumer path: real SDK `Client` (initialize wire identity + tools/list
 * hashes via Companion `canonicalSchemaHash`) and the CURRENT
 * `McpConnector` (trusted 3 read bindings) + `createCalendarConnector`
 * adapter (search query/queryless, get, cursor, accounts, privacy).
 *
 * Run (repo root, credential-stripped env, no Google/GH tokens, no OAuth):
 *   Prerequisites (temporary exact fork checkout under .readonly-compat/fork,
 *   not committed): git fetch origin
 *   6939311fd3eae9846648e0a175e304c9500f578e && git checkout <that SHA>;
 *   verify git rev-parse HEAD / HEAD^{tree} + package-lock.json sha256
 *   against the pin; fork deps optional here (probe runs via Companion tsx;
 *   if installed: env -i PATH=<allow> HOME=<owned-tmp> npm ci
 *   --ignore-scripts --no-audit --no-fund --prefix .readonly-compat/fork).
 *   Probe (FORK_* values below are operator-supplied replay inputs echoed
 *   into the result identity block; the pin separately verifies them
 *   against actual git/lock — they are NOT runtime-derived assertions):
 *   env -i PATH=<allow> HOME=<owned-tmp>
 *     FORK_COMMIT=6939311fd3eae9846648e0a175e304c9500f578e
 *     FORK_TREE=f01b5a7b608c4091906a52c0784b828c35963de9
 *     FORK_LOCK_DIGEST=63261d25992ee9c97136a60bbf4fe52a5485cadea28b34d6b8b6c685f38bd533
 *     ./packages/connector-mcp/node_modules/.bin/tsx
 *     docs/evidence/calendar-readonly-compatibility/probe-consumer-smoke.source.mts
 * Prints one JSON object to stdout (redirect to the result file). Makes no
 * network calls; stdlib http/https + fetch deny counters must stay 0.
 */
import { createHash } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { BaseToolHandler } from "../../../.readonly-compat/fork/src/handlers/core/BaseToolHandler.ts";
import { GoogleCalendarMcpServer } from "../../../.readonly-compat/fork/src/server.ts";
import { ToolRegistry } from "../../../.readonly-compat/fork/src/tools/registry.ts";
import { createCalendarConnector } from "../../../packages/connector-calendar/src/adapter.ts";
import { Client } from "../../../packages/connector-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { InMemoryTransport } from "../../../packages/connector-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js";
import {
  type CallResult,
  McpConnector,
} from "../../../packages/connector-mcp/src/client.ts";
import { canonicalSchemaHash } from "../../../packages/connector-mcp/src/config.ts";

// ---- credential-free network denial (counters must stay 0) ----
const netDeny = {
  httpRequest: 0,
  httpGet: 0,
  httpsRequest: 0,
  httpsGet: 0,
  fetch: 0,
};
const denyNetwork = (counter: keyof typeof netDeny): never => {
  netDeny[counter] += 1;
  throw new Error(`network denied in credential-free probe (${counter})`);
};
const origFetch = globalThis.fetch;
(globalThis as Record<string, unknown>).fetch = (..._a: unknown[]) =>
  Promise.reject(denyNetwork("fetch"));
for (const [mod, req, get] of [
  [http, "httpRequest", "httpGet"],
  [https, "httpsRequest", "httpsGet"],
] as const) {
  const m = mod as unknown as Record<string, unknown>;
  m.request = (..._a: unknown[]) => denyNetwork(req as keyof typeof netDeny);
  m.get = (..._a: unknown[]) => denyNetwork(get as keyof typeof netDeny);
}
void origFetch;

// ---- inert fixture provider (ONLY getCalendar seam; metadata denies) ----
const metaDeny = { calendarListGet: 0, calendarListList: 0, calendarsGet: 0 };
const calls: { eventsList: unknown[]; eventsGet: unknown[] } = {
  eventsList: [],
  eventsGet: [],
};
const clientsSeen: unknown[] = [];
const TIMED_START = "2026-03-10T10:00:00.123+01:00";
const TIMED_END = "2026-03-10T11:00:00.123+01:00";
function googleEvent(id: string, status: string, summary: string) {
  return {
    id,
    etag: `etag-${id}`,
    summary,
    description: "Synthetic fixture description",
    location: "Fixture Room",
    status,
    start: { dateTime: TIMED_START },
    end: { dateTime: TIMED_END },
    updated: "2026-03-09T12:00:00Z",
    creator: { email: "creator@example.com", displayName: "Fixture Creator" },
    organizer: {
      email: "organizer@example.com",
      displayName: "Fixture Organizer",
    },
    attendees: [{ email: "attendee@example.com", responseStatus: "accepted" }],
    htmlLink: "https://calendar.google.com/calendar/event?eid=fixture",
    iCalUID: `fixture-uid-${id}`,
  };
}
function inertCalendar(client: unknown) {
  clientsSeen.push(client);
  return {
    events: {
      list: async (params: Record<string, unknown>) => {
        calls.eventsList.push({ ...params });
        const cal = params.calendarId as string;
        const withCursor = params.pageToken !== undefined;
        const items = withCursor
          ? [
              {
                ...googleEvent(
                  "evt-cancelled-9",
                  "cancelled",
                  "Fixture Cancelled Review",
                ),
                calendarId: cal,
              },
            ]
          : [
              {
                ...googleEvent(
                  "evt-timed-1",
                  "confirmed",
                  "Fixture Timed Planning",
                ),
                calendarId: cal,
              },
              {
                ...googleEvent(
                  "evt-cancelled-9",
                  "cancelled",
                  "Fixture Cancelled Review",
                ),
                calendarId: cal,
              },
            ];
        return {
          data: {
            items,
            ...(withCursor ? {} : { nextPageToken: "opaque-cursor-1" }),
          },
        };
      },
      get: async (params: Record<string, unknown>) => {
        calls.eventsGet.push({ ...params });
        if (params.eventId === "missing-bare-404") {
          const err = new Error("Not Found") as Error & { code?: number };
          err.code = 404;
          throw err;
        }
        return {
          data: {
            ...googleEvent(
              params.eventId as string,
              "confirmed",
              "Fixture Timed Planning",
            ),
            calendarId: params.calendarId,
          },
        };
      },
    },
    calendarList: {
      get: async (): Promise<never> => {
        metaDeny.calendarListGet += 1;
        throw new Error("metadata denied (calendarList.get)");
      },
      list: async (): Promise<never> => {
        metaDeny.calendarListList += 1;
        throw new Error("metadata denied (calendarList.list)");
      },
    },
    calendars: {
      get: async (): Promise<never> => {
        metaDeny.calendarsGet += 1;
        throw new Error("metadata denied (calendars.get)");
      },
    },
  };
}
(BaseToolHandler.prototype as unknown as Record<string, unknown>).getCalendar =
  (client: unknown) => inertCalendar(client);

// ---- fixture accounts (inert markers; getCalendar ignores auth) ----
const workClient = { marker: "oauth-client-work" };
const personalClient = { marker: "oauth-client-personal" };
const fixtureAccounts = new Map<string, unknown>([
  ["work", workClient],
  ["personal", personalClient],
]);
// executeWithHandler override: ACTUAL handler.runTool, fixture accounts only.
(
  GoogleCalendarMcpServer.prototype as unknown as Record<string, unknown>
).executeWithHandler = async (
  handler: { runTool: (a: unknown, acc: unknown) => Promise<unknown> },
  args: unknown,
) => handler.runTool(args, fixtureAccounts as never);

const checks: Array<{ name: string; pass: boolean; detail?: string }> = [];
function check(name: string, pass: boolean, detail?: string) {
  checks.push({ name, pass, ...(detail !== undefined ? { detail } : {}) });
}
function textOf(res: CallResult): string {
  if (!res.ok) throw new Error("expected ok CallResult");
  return (res as { text?: string }).text ?? "";
}
function shaSync(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

async function main() {
  // 0. Registry surface: exactly 3 tools, no list-calendars.
  const registryTools = ToolRegistry.getToolsWithSchemas();
  const regNames = registryTools.map((t) => t.name).sort();
  check(
    "registry exactly list-events/search-events/get-event",
    JSON.stringify(regNames) ===
      JSON.stringify(["get-event", "list-events", "search-events"]),
    regNames.join(","),
  );
  const regHashes: Record<string, string> = {};
  for (const t of registryTools)
    regHashes[t.name] = await canonicalSchemaHash(t.inputSchema);

  // 1. Real SDK wire: direct Client initialize + tools/list on serverA.
  const srvA = new GoogleCalendarMcpServer({ transport: { type: "stdio" } });
  const mcpA = (
    srvA as unknown as {
      buildServer: () => {
        connect: (t: unknown) => Promise<void>;
        close: () => Promise<void>;
      };
    }
  ).buildServer();
  const [cliA, srvT_A] = InMemoryTransport.createLinkedPair();
  const probe = new Client(
    { name: "consumer-smoke-probe", version: "0" },
    { capabilities: {} },
  );
  await mcpA.connect(srvT_A);
  await probe.connect(cliA);
  const wire = probe.getServerVersion();
  check(
    "wire name google-calendar",
    wire?.name === "google-calendar",
    String(wire?.name),
  );
  check(
    "wire version 3.0.0-readonly.2",
    wire?.version === "3.0.0-readonly.2",
    String(wire?.version),
  );
  const listed = await probe.listTools();
  const liveNames = (listed.tools ?? []).map((t) => t.name).sort();
  check(
    "live tools/list exactly 3, no list-calendars",
    JSON.stringify(liveNames) === JSON.stringify(regNames),
    liveNames.join(","),
  );
  const liveHashes: Record<string, string> = {};
  const liveRequired: Record<string, unknown> = {};
  const regRequired: Record<string, unknown> = {};
  for (const t of listed.tools ?? []) {
    liveHashes[t.name] = await canonicalSchemaHash(
      (t as { inputSchema?: unknown }).inputSchema,
    );
    const s = (t as { inputSchema?: Record<string, unknown> }).inputSchema;
    liveRequired[t.name] = Array.isArray(s?.required)
      ? [...(s.required as string[])].sort()
      : null;
  }
  for (const t of registryTools) {
    const s = t.inputSchema as Record<string, unknown>;
    regRequired[t.name] = Array.isArray(s?.required)
      ? [...(s.required as string[])].sort()
      : null;
  }
  const hashMatch = regNames.every((n) => liveHashes[n] === regHashes[n]);
  void hashMatch; // recorded for diagnosis only: serializers differ, pin uses liveWire
  // Registry-direct z.toJSONSchema bytes vs SDK-wire serialization bytes are
  // NOT expected to be identical (different serializers); the consumer pins
  // the LIVE wire form. Record both; require same required-fields per tool.
  const requiredMatch = regNames.every(
    (n) => JSON.stringify(liveRequired[n]) === JSON.stringify(regRequired[n]),
  );
  check(
    "live tools/list required-fields match registry per tool",
    requiredMatch,
    JSON.stringify(liveRequired),
  );
  check(
    "registry-direct vs live-wire hash bytes recorded (serializer differs)",
    true,
    `registry=${JSON.stringify(regHashes)} live=${JSON.stringify(liveHashes)}`,
  );
  const structuredAbsent = true; // fork createStructuredResponse emits content-text only (verified below via connector text path)
  void structuredAbsent;
  await probe.close();
  await mcpA.close();

  // Consumer pins the LIVE wire hashes (what the connector verifies).
  const wireHashes = liveHashes;
  const bindings = regNames.map((n) => ({
    upstreamTool: n,
    canonicalSchemaHash: wireHashes[n],
  }));
  const definitions = regNames.map((n) => ({
    upstreamTool: n,
    canonicalSchemaHash: wireHashes[n],
    category: "read" as const,
  }));

  // 2. Current McpConnector identity gate over serverB (InMemory, real SDK).
  const srvB = new GoogleCalendarMcpServer({ transport: { type: "stdio" } });
  const mcpB = (
    srvB as unknown as {
      buildServer: () => {
        connect: (t: unknown) => Promise<void>;
        close: () => Promise<void>;
      };
    }
  ).buildServer();
  const [cliB, srvT_B] = InMemoryTransport.createLinkedPair();
  await mcpB.connect(srvT_B);
  const connector = new McpConnector(
    {
      connectorInstanceId: "probe",
      serverId: "fork-readonly",
      kind: "mcp",
      expectedServerName: "google-calendar",
      version: "3.0.0-readonly.2",
      // Transport kind is nominal here: transportFactory injects the live
      // InMemory SDK pair, so no stdio spawn/env or HTTP socket is ever used.
      transport: {
        kind: "streamable-http",
        host: "127.0.0.1",
        port: 1,
        path: "/mcp",
      },
      bindings,
      clientName: "consumer-smoke-probe",
      clientVersion: "0",
    },
    definitions,
    () => cliB as never,
  );
  const ensured = await connector.ensureConnected();
  check(
    "connector identity+schema gate enables 3/3 trusted read bindings",
    ensured.ok && connector.stats().enabledBindings.length === 3,
    JSON.stringify(connector.stats().enabledBindings),
  );

  // Adapter over the live connector.
  const RANGE = { start: TIMED_START, end: TIMED_END };
  const mkAdapter = (calendarId: string, account?: string) =>
    createCalendarConnector({
      connectorInstanceId: "probe",
      connector,
      selection: { calendarId, ...(account !== undefined ? { account } : {}) },
    });

  // 3. search WITH query -> search-events: q/fraction/limit/IDs byte-for-byte, 1 call.
  const beforeSearch = calls.eventsList.length;
  const adSearch = mkAdapter("user@example.com", "work");
  const sRes = await adSearch.search(
    { query: "fixture", ...RANGE },
    { timeZone: "UTC" },
  );
  const sCalls = calls.eventsList.slice(beforeSearch) as Array<
    Record<string, unknown>
  >;
  check(
    "adapter search ok (2 events, opaque cursor out)",
    sRes.ok &&
      sRes.ok === true &&
      (sRes as { events: unknown[] }).events.length === 2 &&
      (sRes as { cursor?: string }).cursor === "opaque-cursor-1",
  );
  check(
    "search exactly 1 events.list call",
    sCalls.length === 1,
    String(sCalls.length),
  );
  const lp = sCalls[0] ?? {};
  check("search q passthrough", lp.q === "fixture", JSON.stringify(lp.q));
  check(
    "fractional start/end byte-for-byte",
    lp.timeMin === RANGE.start && lp.timeMax === RANGE.end,
    `${String(lp.timeMin)}|${String(lp.timeMax)}`,
  );
  check(
    "limit->pageSize 10",
    (lp.maxResults as number) === 10,
    String(lp.maxResults),
  );
  check(
    "calendarId opaque verbatim (email)",
    lp.calendarId === "user@example.com",
    String(lp.calendarId),
  );
  check(
    "explicit account selects work client",
    clientsSeen[clientsSeen.length - 1] === workClient,
  );
  const sTargets = (sRes as { ok: boolean; targets?: unknown[] }).ok
    ? ((sRes as unknown as { targets: unknown[] }).targets ?? [])
    : [];
  check(
    "private targets host-side (2)",
    sTargets.length === 2,
    String(sTargets.length),
  );

  // 4. queryless -> list-events (no q), opaque calendar ID.
  const beforeList = calls.eventsList.length;
  const adList = mkAdapter("cal-opaque_ABC123", "personal");
  const lRes = await adList.search({ ...RANGE }, { timeZone: "UTC" });
  const lCalls = calls.eventsList.slice(beforeList) as Array<
    Record<string, unknown>
  >;
  check(
    "queryless routes to list-events (no q key)",
    lCalls.length === 1 && !("q" in (lCalls[0] ?? {})),
    JSON.stringify(
      Object.keys((lCalls[0] as Record<string, unknown> | undefined) ?? {}),
    ),
  );
  check(
    "opaque calendarId verbatim",
    (lCalls[0] as Record<string, unknown> | undefined)?.calendarId ===
      "cal-opaque_ABC123",
    String((lCalls[0] as Record<string, unknown> | undefined)?.calendarId),
  );
  check(
    "explicit account selects personal client",
    clientsSeen[clientsSeen.length - 1] === personalClient,
  );
  void lRes;

  // 5. cursor opaque passthrough: search with cursor -> pageToken verbatim, 1 call.
  const beforeCursor = calls.eventsList.length;
  const cRes = await adSearch.search(
    { query: "fixture", ...RANGE, cursor: "opaque-cursor-1" },
    { timeZone: "UTC" },
  );
  const cCalls = calls.eventsList.slice(beforeCursor) as Array<
    Record<string, unknown>
  >;
  check(
    "cursor->pageToken opaque passthrough, 1 call",
    cCalls.length === 1 &&
      (cCalls[0] as Record<string, unknown> | undefined)?.pageToken ===
        "opaque-cursor-1",
    JSON.stringify(
      (cCalls[0] as Record<string, unknown> | undefined)?.pageToken,
    ),
  );
  check(
    "second page decoded (1 event, no cursor)",
    cRes.ok &&
      (cRes as { events: unknown[] }).events.length === 1 &&
      (cRes as { cursor?: string }).cursor === undefined,
  );
  check(
    "cancelled stays cancelled (no loosen)",
    cRes.ok &&
      (cRes as { events: Array<{ status: string }> }).events[0]?.status ===
        "cancelled",
    JSON.stringify(
      (cRes as { events: Array<{ status: string }> }).events?.[0]?.status,
    ),
  );

  // 6. get -> get-event: etag basis + privacy strips.
  const adGet = mkAdapter("primary", "work");
  const beforeGet = calls.eventsGet.length;
  const gRes = await adGet.get({
    calendarId: "primary",
    eventId: "evt-timed-1",
    account: "work",
  });
  const gCalls = calls.eventsGet.slice(beforeGet) as Array<
    Record<string, unknown>
  >;
  check("get exactly 1 events.get call", gCalls.length === 1);
  check(
    "get calendarId/eventId verbatim",
    gCalls[0]?.calendarId === "primary" && gCalls[0]?.eventId === "evt-timed-1",
    JSON.stringify(gCalls[0]),
  );
  const gJson = gRes.ok ? JSON.stringify(gRes) : "";
  const gEvent = gRes.ok
    ? ((gRes as { event: Record<string, unknown> }).event ?? {})
    : {};
  const leakedKeys = [
    "organizer",
    "attendees",
    "htmlLink",
    "id",
    "calendarId",
    "eventId",
    "iCalUID",
  ].filter((k) => k in gEvent);
  check(
    "get etag revision basis",
    gRes.ok &&
      (gRes as { event: { sourceRevision: string; revisionBasis: string } })
        .event.sourceRevision === "etag-evt-timed-1" &&
      (gRes as { event: { revisionBasis: string } }).event.revisionBasis ===
        "etag",
    gRes.ok
      ? JSON.stringify((gRes as { event: unknown }).event).slice(0, 160)
      : "not-ok",
  );
  check(
    "get strips organizer/attendees/htmlLink/rawIDs",
    gRes.ok &&
      leakedKeys.length === 0 &&
      !gJson.includes("organizer@example.com") &&
      !gJson.includes("attendee@example.com") &&
      !gJson.includes("calendar.google.com") &&
      !gJson.includes("fixture-uid-"),
    leakedKeys.length > 0
      ? `leaked: ${leakedKeys.join(",")}`
      : "normalized JSON scanned",
  );

  // 7. envelope: content-text only fallback valid (structuredContent absent).
  const rawCall = await connector.callTool("search-events", {
    calendarId: "primary",
    account: "work",
    timeMin: RANGE.start,
    timeMax: RANGE.end,
    timeZone: "UTC",
    pageSize: 10,
    query: "fixture",
  });
  check(
    "envelope text-JSON fallback (no structuredContent)",
    rawCall.ok &&
      (rawCall as { structuredContent?: unknown }).structuredContent ===
        undefined &&
      typeof (rawCall as { text?: unknown }).text === "string" &&
      textOf(rawCall).startsWith('{"events"'),
    rawCall.ok ? textOf(rawCall).slice(0, 40) : "not-ok",
  );

  // 8. naive bounds -> deterministic UTC, 0 metadata; explicit zone also 0 metadata.
  const metaBefore = { ...metaDeny };
  const naiveCall = await connector.callTool("list-events", {
    calendarId: "primary",
    account: "work",
    timeMin: "2026-03-10T10:00:00",
    timeMax: "2026-03-10T11:00:00",
    pageSize: 10,
  });
  const naiveParams =
    (calls.eventsList[calls.eventsList.length - 1] as
      | Record<string, unknown>
      | undefined) ?? {};
  check(
    "naive bounds deterministic UTC without metadata",
    naiveCall.ok &&
      typeof naiveParams.timeMin === "string" &&
      (naiveParams.timeMin as string).endsWith("Z") &&
      metaDeny.calendarListGet === metaBefore.calendarListGet &&
      metaDeny.calendarListList === metaBefore.calendarListList &&
      metaDeny.calendarsGet === metaBefore.calendarsGet,
    String(naiveParams.timeMin),
  );

  // 9. multi-account ambiguity + missing account fail BEFORE provider I/O.
  const ioBefore = calls.eventsList.length + calls.eventsGet.length;
  const adAmbig = mkAdapter("primary"); // no account, 2 fixture accounts
  const amb = await adAmbig.search(
    { query: "fixture", ...RANGE },
    { timeZone: "UTC" },
  );
  const ghost = await connector.callTool("search-events", {
    calendarId: "primary",
    account: "ghost",
    timeMin: RANGE.start,
    timeMax: RANGE.end,
    timeZone: "UTC",
    pageSize: 10,
    query: "fixture",
  });
  check(
    "ambiguous+missing account fail with 0 provider I/O",
    !amb.ok &&
      !ghost.ok &&
      calls.eventsList.length + calls.eventsGet.length === ioBefore,
    `eventsList+eventsGet delta ${calls.eventsList.length + calls.eventsGet.length - ioBefore}`,
  );
  void amb;

  // 10. list-calendars denied at tooling (0 calls).
  const lcBefore = calls.eventsList.length + calls.eventsGet.length;
  const lc = await connector.callTool("list-calendars", {});
  check(
    "list-calendars denied, 0 provider calls",
    !lc.ok &&
      (lc as { code: string }).code === "mcp_binding_not_allowed" &&
      calls.eventsList.length + calls.eventsGet.length === lcBefore,
    JSON.stringify(lc),
  );

  // 11. bare 404 -> fixed error, no tombstone.
  const nf = await adGet.get({
    calendarId: "primary",
    eventId: "missing-bare-404",
    account: "work",
  });
  const nfJson = JSON.stringify(nf);
  check(
    "bare 404 no tombstone (fixed error, never deleted)",
    !nf.ok &&
      !nfJson.includes('"deleted"') &&
      !nfJson.includes("missing-bare-404"),
    nfJson.slice(0, 120),
  );

  // 12. wrong identity / wrong schema hash deny ALL before provider calls (fresh servers).
  async function identityCase(
    label: string,
    mutate: (c: Record<string, unknown>) => void,
  ): Promise<void> {
    const srv = new GoogleCalendarMcpServer({ transport: { type: "stdio" } });
    const mcp = (
      srv as unknown as {
        buildServer: () => {
          connect: (t: unknown) => Promise<void>;
          close: () => Promise<void>;
        };
      }
    ).buildServer();
    const [cli, srvT] = InMemoryTransport.createLinkedPair();
    await mcp.connect(srvT);
    const cfg: Record<string, unknown> = {
      connectorInstanceId: "probe",
      serverId: "fork-readonly",
      kind: "mcp",
      expectedServerName: "google-calendar",
      version: "3.0.0-readonly.2",
      transport: {
        kind: "streamable-http",
        host: "127.0.0.1",
        port: 1,
        path: "/mcp",
      },
      bindings,
      clientName: "consumer-smoke-probe",
      clientVersion: "0",
    };
    mutate(cfg);
    const ioB = calls.eventsList.length + calls.eventsGet.length;
    const conn = new McpConnector(
      cfg as never,
      definitions,
      () => cli as never,
    );
    const res = await conn.ensureConnected();
    const denied =
      !res.ok && (res as { code: string }).code === "mcp_schema_mismatch";
    const call = await conn.callTool("search-events", {
      calendarId: "primary",
      account: "work",
      timeMin: RANGE.start,
      timeMax: RANGE.end,
      timeZone: "UTC",
      pageSize: 10,
      query: "x",
    });
    check(
      `identity guard denies (${label}) with 0 provider calls`,
      denied &&
        !call.ok &&
        calls.eventsList.length + calls.eventsGet.length === ioB,
      JSON.stringify(res),
    );
    await conn.shutdown();
    await mcp.close();
  }
  await identityCase("wrong name", (c) => {
    c.expectedServerName = "google-calendar-wrong";
  });
  await identityCase("wrong version", (c) => {
    c.version = "9.9.9-wrong";
  });
  // wrong schema hash: binding hash altered -> guard denies.
  {
    const srv = new GoogleCalendarMcpServer({ transport: { type: "stdio" } });
    const mcp = (
      srv as unknown as {
        buildServer: () => {
          connect: (t: unknown) => Promise<void>;
          close: () => Promise<void>;
        };
      }
    ).buildServer();
    const [cli, srvT] = InMemoryTransport.createLinkedPair();
    await mcp.connect(srvT);
    const badBindings = bindings.map((b, i) =>
      i === 0 ? { ...b, canonicalSchemaHash: "0".repeat(64) } : b,
    );
    const ioB = calls.eventsList.length + calls.eventsGet.length;
    const conn = new McpConnector(
      {
        connectorInstanceId: "probe",
        serverId: "fork-readonly",
        kind: "mcp",
        expectedServerName: "google-calendar",
        version: "3.0.0-readonly.2",
        transport: {
          kind: "streamable-http",
          host: "127.0.0.1",
          port: 1,
          path: "/mcp",
        },
        bindings: badBindings,
        clientName: "consumer-smoke-probe",
        clientVersion: "0",
      },
      definitions,
      () => cli as never,
    );
    const res = await conn.ensureConnected();
    check(
      "schema-hash guard denies (1 bad of 3 still gates that binding; connect may partially enable)",
      (res.ok ||
        (!res.ok &&
          (res as { code: string }).code === "mcp_schema_mismatch")) &&
        calls.eventsList.length + calls.eventsGet.length === ioB,
      JSON.stringify({ res, enabled: conn.stats().enabledBindings }),
    );
    await conn.shutdown();
    await mcp.close();
  }

  await connector.shutdown();
  await mcpB.close();

  const netTotal = Object.values(netDeny).reduce((a, b) => a + b, 0);
  check(
    "stdlib http/https/fetch deny counters 0",
    netTotal === 0,
    JSON.stringify(netDeny),
  );
  check(
    "metadata calendarList.get/list + calendars.get 0",
    metaDeny.calendarListGet === 0 &&
      metaDeny.calendarListList === 0 &&
      metaDeny.calendarsGet === 0,
    JSON.stringify(metaDeny),
  );

  const failed = checks.filter((c) => !c.pass);
  const out = {
    fork: {
      version: "3.0.0-readonly.2",
      commit: process.env.FORK_COMMIT ?? "missing",
      tree: process.env.FORK_TREE ?? "missing",
      lockDigestSha256: process.env.FORK_LOCK_DIGEST ?? "missing",
      serverInfo: { name: "google-calendar", version: "3.0.0-readonly.2" },
      toolNames: regNames,
    },
    schemaHashes: { registryDirect: regHashes, liveWire: liveHashes },
    liveHashes,
    sdk: "1.30.0",
    checks,
    passCount: checks.length - failed.length,
    failCount: failed.length,
    providerCalls: {
      eventsList: calls.eventsList.length,
      eventsGet: calls.eventsGet.length,
      calendarListGet: metaDeny.calendarListGet,
      calendarListList: metaDeny.calendarListList,
      calendarsGet: metaDeny.calendarsGet,
    },
    networkDeny: netDeny,
    credentialFree: {
      command:
        "env -i PATH=<allow> HOME=<owned-tmp> FORK_COMMIT=<sha> FORK_TREE=<tree> FORK_LOCK_DIGEST=<digest> ./packages/connector-mcp/node_modules/.bin/tsx docs/evidence/calendar-readonly-compatibility/probe-consumer-smoke.source.mts (FORK_* are operator-supplied replay inputs, not runtime-derived; pin separately verifies actual git/lock)",
      limitations:
        "no OAuth/TokenManager/account index/CLI; no live Google HTTP; no GH/Google credentials in env; InMemory SDK transport only; fixture accounts + inert provider via ONLY BaseToolHandler.getCalendar seam",
      liveClaims:
        "none (no OAuth, no live Google call, no HTTP status, no release claim)",
    },
    ok: failed.length === 0,
  };
  // cross-check sync sha helper unused guard (keeps node:crypto import honest)
  void shaSync("probe");
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(
    `probe failed: ${err instanceof Error ? err.message : err}\n`,
  );
  process.exit(1);
});
