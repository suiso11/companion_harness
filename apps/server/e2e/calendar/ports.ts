// Fixed loopback ports + scripted constants for the C15 Calendar fake E2E
// harness (deliberately ISOLATED from the existing M3 e2e harness):
//
//   4183  CALENDAR_APP_PORT          App A: C14 OWNED composition (real
//                                    MCP connector + real Calendar adapter +
//                                    real agent/broker) over an injected
//                                    real-SDK inert MCP transport.
//   4184  CALENDAR_BINDING_APP_PORT  App B: the C12 `calendarBinding` seam
//                                    with an explicitly trusted fake
//                                    connector contract (tombstone only).
//   4186  CALENDAR_CONTROL_PORT      Loopback-only in-process control
//                                    (fixture seeding / arms / status).

export const CALENDAR_APP_PORT = 4183;
export const CALENDAR_BINDING_APP_PORT = 4184;
export const CALENDAR_CONTROL_PORT = 4186;

export const CALENDAR_APP_ORIGIN = `http://127.0.0.1:${CALENDAR_APP_PORT}`;
export const CALENDAR_BINDING_APP_ORIGIN = `http://127.0.0.1:${CALENDAR_BINDING_APP_PORT}`;
export const CALENDAR_CONTROL_ORIGIN = `http://127.0.0.1:${CALENDAR_CONTROL_PORT}`;

/** Fake MCP server identity (must equal the config hint exactly). */
export const FAKE_MCP_SERVER_NAME = "e2e-fake-calendar";
export const FAKE_MCP_SERVER_VERSION = "1.0.0-e2e";

/** Trusted host calendar selection (metadata only, no provider claim). */
export const CALENDAR_ID = "cal-e2e";
/** Stored connector display name for the scenario-B seeded instance. */
export const FAKE_BINDING_DISPLAY_NAME = "calendar-fake-e2e";

/** Common single upstream event the fake calendar returns. */
export const EVENT_ID = "e2e-event-1";
export const EVENT_TITLE_V1 = "E2E Standup";
export const EVENT_TITLE_V2 = "E2E Standup (moved 11:00)";
export const EVENT_DESCRIPTION = "notes: q3 planning";
export const EVENT_START = "2026-10-13T09:00:00Z";
/** Wire-normalized start (ISO with milliseconds) as the REAL adapter emits. */
export const EVENT_START_RENDERED = "2026-10-13T09:00:00.000Z";
export const EVENT_END = "2026-10-13T10:00:00Z";

/**
 * Input texts the deterministic fake model keys its plan on. The FAKE model
 * (no real LLM) executes a fixed plan: calendar.search -> rN citation ->
 * (refresh/delete plans only:) reference.refresh on the delivered rN ->
 * structured answer citing the newly materialized rN.
 */
export const TEXT_SEARCH = "search my calendar";
export const TEXT_REFRESH = "refresh the calendar event";
export const TEXT_DELETE = "re-read the calendar event after deletion";

/** Answer part texts the fake model submits (deterministic, cited). */
export const ANSWER_SEARCH_TEXT = "calendar search answer";
export const ANSWER_REFRESH_TEXT = "calendar refresh answer";
export const ANSWER_TOMBSTONE_TEXT = "calendar tombstone answer";
export const ANSWER_FAILED_TEXT = "the calendar call failed";
export const ANSWER_NO_HIT_TEXT = "no calendar events";
