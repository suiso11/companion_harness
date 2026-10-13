// C15 dedicated Calendar fake E2E harness (1/3): scripted FAKE MCP server
// paired with the real SDK `Client` INSIDE the real server-owned Calendar
// connector over the OFFICIAL inert `InMemoryTransport` (re-exported C15
// seam). No network, no process spawn, no OAuth surface: the whole real
// connector pipeline (initialize handshake identity, tools/list binding
// identity, tools/call) runs, while the upstream DATA is this scripted
// state object, mutated only via the loopback control server (fixture seam:
// synthetic deletion / title advance never touch the production normalizer).
//
// The tool input schemas are LITERAL JSON Schemas on the wire; the harness
// computes their canonical hashes (same canonicalSchemaHash rule) so config
// hint bindings, trusted host definitions and the live tools/list result
// link byte-for-byte. Env/config NEVER injects these definitions: they live
// here as trusted host code only.

import {
  type CallToolRequest,
  CallToolRequestSchema,
  canonicalSchemaHash,
  ListToolsRequestSchema,
  Server,
} from "@companion/connector-mcp";
import {
  AUTHORITATIVE_DELETED_REVISION,
  AUTHORITATIVE_GET_TOOL,
  CALENDAR_ID,
  EVENT_DESCRIPTION,
  EVENT_END_RENDERED,
  EVENT_ID,
  EVENT_START_RENDERED,
  EVENT_TITLE_V1,
  EVENT_TITLE_V2,
  FAKE_MCP_SERVER_NAME,
  FAKE_MCP_SERVER_VERSION,
} from "./ports.js";

/**
 * Scripted upstream Calendar state; ONLY the control server mutates it.
 */
export interface FakeCalendarState {
  /** Synthetic authoritative deletion (fixture seam; never a normalizer). */
  deleted: boolean;
  /** 1 = seeded title, 2 = advanced title (fake upstream mutation). */
  revision: 1 | 2;
  /** Real wire call counts over the real connector (observation only). */
  searchCalls: number;
  listCalls: number;
  getCalls: number;
  /* --- C22 fake WRITE fixture (only the injected fake port mutates) --- */
  /** Real external-write attempts (one per committed approval write). */
  writeCalls: number;
  /**
   * Fake write behavior:
   *  - `success`  : apply the write to this state (read-back verifies),
   *  - `unverified`: connector reports succeeded WITHOUT applying it
   *                 (authoritative read-back then fails -> unverified),
   *  - `unknown`   : connector cannot say what happened,
   *  - `failure`   : definite failure,
   *  - `barrier`   : apply, then hold the call until the control server
   *                 releases it (post-marker Stop observation seam).
   */
  writeMode: FakeWriteMode;
  /** When armed, every fake upstream READ blocks until released. */
  readBarrier: boolean;
  /**
   * C15 tombstone app: the EXPLICIT HOST-TRUSTED authoritative synthetic
   * deletion gate. Distinct from `deleted` (the bare 404 / uncertain miss):
   * while armed, the dedicated `get-event-authoritative` wire operation
   * answers with POSITIVE deleted evidence instead of an error. Production
   * normalizer/adapter/schema are untouched; only this fixture decides.
   */
  authoritativeDeleted: boolean;
  /** Applied write boundaries (null until a write really lands). */
  startOverride: string | null;
  endOverride: string | null;
  /** Barrier releases (fixture seam only; never production code). */
  releaseRead: (() => void) | null;
  releaseWrite: (() => void) | null;
}

export type FakeWriteMode =
  | "success"
  | "unverified"
  | "unknown"
  | "failure"
  | "barrier";

export function createFakeCalendarState(): FakeCalendarState {
  return {
    deleted: false,
    revision: 1,
    searchCalls: 0,
    listCalls: 0,
    getCalls: 0,
    writeCalls: 0,
    writeMode: "success",
    readBarrier: false,
    authoritativeDeleted: false,
    startOverride: null,
    endOverride: null,
    releaseRead: null,
    releaseWrite: null,
  };
}

export function resetFakeCalendarState(state: FakeCalendarState): void {
  state.deleted = false;
  state.revision = 1;
  state.searchCalls = 0;
  state.listCalls = 0;
  state.getCalls = 0;
  state.writeCalls = 0;
  state.writeMode = "success";
  state.readBarrier = false;
  state.authoritativeDeleted = false;
  state.startOverride = null;
  state.endOverride = null;
  state.releaseRead?.();
  state.releaseWrite?.();
  state.releaseRead = null;
  state.releaseWrite = null;
}

/** Block until the control server releases the armed barrier (fixture only). */
async function awaitRelease(
  state: FakeCalendarState,
  which: "read" | "write",
): Promise<void> {
  if (which === "read" ? !state.readBarrier : state.writeMode !== "barrier") {
    return;
  }
  await new Promise<void>((resolve) => {
    const assign = (): void => {
      if (which === "read") {
        state.releaseRead = resolve;
      } else {
        state.releaseWrite = resolve;
      }
    };
    assign();
  });
}

/**
 * Literal MCP JSON Schema shapes that MUST hash-match the hashes written
 * into COMPANION_CALENDAR_JSON binding hints + host definitions. The fake
 * upstream arguments follow `mapCalendarSearchRequest`
 * (calendarId/account?/timeMin/timeMax/timeZone/pageSize/pageToken?/query?)
 * and the adapter get mapping (eventId/calendarId/account?).
 */
const stringProperty = { type: "string" } as const;
const integerProperty = { type: "integer" } as const;

export const FAKE_SEARCH_TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    calendarId: stringProperty,
    account: stringProperty,
    timeMin: stringProperty,
    timeMax: stringProperty,
    timeZone: stringProperty,
    pageSize: integerProperty,
    pageToken: stringProperty,
    query: stringProperty,
  },
  required: ["calendarId", "timeMin", "timeMax", "timeZone", "pageSize"],
  additionalProperties: false,
} as const;

export const FAKE_LIST_TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    calendarId: stringProperty,
    account: stringProperty,
    timeMin: stringProperty,
    timeMax: stringProperty,
    timeZone: stringProperty,
    pageSize: integerProperty,
    pageToken: stringProperty,
  },
  required: ["calendarId", "timeMin", "timeMax", "timeZone", "pageSize"],
  additionalProperties: false,
} as const;

export const FAKE_GET_TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    eventId: stringProperty,
    calendarId: stringProperty,
    account: stringProperty,
  },
  required: ["eventId", "calendarId"],
  additionalProperties: false,
} as const;

/** Deterministic candidate event the scripted fake upstream serves. */
export function fakeEvent(state: FakeCalendarState): unknown {
  return {
    id: EVENT_ID,
    calendarId: CALENDAR_ID,
    status: "confirmed",
    summary: state.revision === 1 ? EVENT_TITLE_V1 : EVENT_TITLE_V2,
    description: EVENT_DESCRIPTION,
    start: {
      dateTime: state.startOverride ?? EVENT_START_RENDERED,
    },
    end: {
      dateTime: state.endOverride ?? EVENT_END_RENDERED,
    },
    updated: "2026-10-13T00:00:00Z",
    etag: state.revision === 1 ? "rev-1" : "rev-2",
  };
}

/** Canonical hashes of the three fake tool schemas (host trusted link). */
export async function fakeToolSchemaHashes(): Promise<{
  search: string;
  list: string;
  get: string;
}> {
  return {
    search: await canonicalSchemaHash(FAKE_SEARCH_TOOL_INPUT_SCHEMA),
    list: await canonicalSchemaHash(FAKE_LIST_TOOL_INPUT_SCHEMA),
    get: await canonicalSchemaHash(FAKE_GET_TOOL_INPUT_SCHEMA),
  };
}

/**
 * One fresh SDK `Server` per transport pair (the connector may reconnect;
 * servers are recreated per connect while sharing the state object).
 * Handshake identity, tools/list and tools/call all follow the fake state;
 * a "deleted" upstream event resolves as an isError tool result: a bare
 * miss maps to a fixed upstream error and NO tombstone is ever synthesized
 * (production normalizer untouched; deletion lives only in this fixture).
 */
export function createFakeCalendarMcpServer(
  state: FakeCalendarState,
  options: { readonly authoritativeTool?: boolean } = {},
): Server {
  const server = new Server(
    { name: FAKE_MCP_SERVER_NAME, version: FAKE_MCP_SERVER_VERSION },
    // SDK 1.30.0 `Server.setRequestHandler` asserts the advertised capability
    // at REGISTRATION time; the tools/list + tools/call handlers below
    // therefore require the `tools` capability to be declared here (an empty
    // capabilities object used to register them lazily without complaint).
    { capabilities: { tools: {} } },
  );
  const asServer = server as unknown as {
    setRequestHandler: (schema: unknown, handler: unknown) => void;
  };
  const tools = [
    {
      name: "search-events",
      description: "fake readonly search tool (scripted E2E)",
      inputSchema: FAKE_SEARCH_TOOL_INPUT_SCHEMA,
    },
    {
      name: "list-events",
      description: "fake readonly list tool (scripted E2E)",
      inputSchema: FAKE_LIST_TOOL_INPUT_SCHEMA,
    },
    {
      name: "get-event",
      description: "fake readonly get tool (scripted E2E)",
      inputSchema: FAKE_GET_TOOL_INPUT_SCHEMA,
    },
    // C15 tombstone app ONLY: a SEPARATE trusted read binding used solely
    // for the positive synthetic authoritative deletion evidence. Same
    // argument schema as `get-event` (byte-identical canonical hash), never
    // reachable from the production composed adapter (its tool map does not
    // name it) and never reachable unless the fixture armed the dedicated
    // authoritative gate.
    ...(options.authoritativeTool === true
      ? [
          {
            name: AUTHORITATIVE_GET_TOOL,
            description: "fake authoritative deletion tool (host fixture)",
            inputSchema: FAKE_GET_TOOL_INPUT_SCHEMA,
          },
        ]
      : []),
  ];
  asServer.setRequestHandler(ListToolsRequestSchema, (_request: unknown) => ({
    tools,
  }));
  asServer.setRequestHandler(
    CallToolRequestSchema,
    async (request: unknown) => {
      const call = request as CallToolRequest;
      const args = (call.params.arguments ?? {}) as Record<string, unknown>;
      if (call.params.name === "search-events") {
        state.searchCalls += 1;
        // Exact strict search-events ROOT envelope: query (if present) plus
        // calendarId and timeRange are source-REQUIRED here.
        if (state.deleted) return deletedResult();
        return {
          content: [{ type: "text", text: "fake search page" }],
          structuredContent: {
            events: [fakeEvent(state)],
            totalCount: 1,
            ...(typeof args.query === "string" && args.query.length > 0
              ? { query: args.query }
              : {}),
            calendarId: CALENDAR_ID,
            timeRange: {
              start:
                typeof args.timeMin === "string"
                  ? args.timeMin
                  : "2026-10-13T00:00:00Z",
              end:
                typeof args.timeMax === "string"
                  ? args.timeMax
                  : "2026-10-31T00:00:00Z",
            },
          },
        };
      }
      if (call.params.name === "list-events") {
        state.listCalls += 1;
        if (state.deleted) return deletedResult();
        return {
          content: [{ type: "text", text: "fake list page" }],
          structuredContent: {
            events: [fakeEvent(state)],
            totalCount: 1,
          },
        };
      }
      if (call.params.name === "get-event") {
        // C22 fixture seam: an armed read barrier holds the authoritative READ
        // (preflight / read-back) inside the real connector so the browser spec
        // can observe the real pre-marker window.
        await awaitRelease(state, "read");
        state.getCalls += 1;
        if (state.deleted) return deletedResult();
        return {
          content: [{ type: "text", text: "fake event" }],
          structuredContent: { event: fakeEvent(state) },
        };
      }
      if (call.params.name === AUTHORITATIVE_GET_TOOL) {
        // Only advertised when the fixture asked for it. POSITIVE evidence
        // ONLY when the dedicated authoritative gate is armed; otherwise this
        // separate operation is just a miss (never a silent tombstone).
        state.getCalls += 1;
        if (!state.authoritativeDeleted) return deletedResult();
        return {
          content: [{ type: "text", text: "fake authoritative event" }],
          structuredContent: {
            event: {
              // Type-only: `fakeEvent` builds the same object shape (typed
              // `unknown` at the boundary); the spread is runtime-identical.
              ...(fakeEvent(state) as Record<string, unknown>),
              // Provider-shaped positive deletion proof: a cancelled record
              // carrying the host-trusted synthetic revision. The fixture
              // wrapper requires BOTH the armed gate and this exact revision.
              status: "cancelled",
              etag: AUTHORITATIVE_DELETED_REVISION,
            },
          },
        };
      }
      return {
        content: [{ type: "text", text: "unknown tool" }],
        isError: true,
      };
    },
  );
  return server;
}

function deletedResult(): unknown {
  // Bare isError miss: production maps this to the fixed upstream error
  // code and NEVER synthesizes a tombstone. Provider-shaped text; the
  // connector/normalizer never interprets this content.
  return {
    content: [{ type: "text", text: "event not found" }],
    isError: true,
  };
}
