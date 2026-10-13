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
  CALENDAR_ID,
  EVENT_DESCRIPTION,
  EVENT_END,
  EVENT_ID,
  EVENT_START,
  EVENT_TITLE_V1,
  EVENT_TITLE_V2,
  FAKE_MCP_SERVER_NAME,
  FAKE_MCP_SERVER_VERSION,
} from "./ports.js";

/** Scripted upstream Calendar state; ONLY the control server mutates it. */
export interface FakeCalendarState {
  /** Synthetic authoritative deletion (fixture seam; never a normalizer). */
  deleted: boolean;
  /** 1 = seeded title, 2 = advanced title (fake upstream mutation). */
  revision: 1 | 2;
  /** Real wire call counts over the real connector (observation only). */
  searchCalls: number;
  listCalls: number;
  getCalls: number;
}

export function createFakeCalendarState(): FakeCalendarState {
  return {
    deleted: false,
    revision: 1,
    searchCalls: 0,
    listCalls: 0,
    getCalls: 0,
  };
}

export function resetFakeCalendarState(state: FakeCalendarState): void {
  state.deleted = false;
  state.revision = 1;
  state.searchCalls = 0;
  state.listCalls = 0;
  state.getCalls = 0;
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
    start: { dateTime: EVENT_START },
    end: { dateTime: EVENT_END },
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
export function createFakeCalendarMcpServer(state: FakeCalendarState): Server {
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
  ];
  asServer.setRequestHandler(ListToolsRequestSchema, (_request: unknown) => ({
    tools,
  }));
  asServer.setRequestHandler(CallToolRequestSchema, (request: unknown) => {
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
      state.getCalls += 1;
      if (state.deleted) return deletedResult();
      return {
        content: [{ type: "text", text: "fake event" }],
        structuredContent: { event: fakeEvent(state) },
      };
    }
    return {
      content: [{ type: "text", text: "unknown tool" }],
      isError: true,
    };
  });
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
