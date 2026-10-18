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
//   4185  CALENDAR_TOMBSTONE_APP_PORT App C: the C12 `calendarBinding`
//                                    seam with a trusted fixture WRAPPER
//                                    over its own real MCP connector, whose
//                                    DEDICATED authoritative synthetic
//                                    get mode can yield a positive deleted
//                                    observation (throwaway DB/instance).
//   4186  CALENDAR_CONTROL_PORT      Loopback-only in-process control
//                                    (fixture seeding / arms / status).

export const CALENDAR_APP_PORT = 4183;
export const CALENDAR_BINDING_APP_PORT = 4184;
export const CALENDAR_TOMBSTONE_APP_PORT = 4185;
export const CALENDAR_CONTROL_PORT = 4186;

export const CALENDAR_APP_ORIGIN = `http://127.0.0.1:${CALENDAR_APP_PORT}`;
export const CALENDAR_BINDING_APP_ORIGIN = `http://127.0.0.1:${CALENDAR_BINDING_APP_PORT}`;
export const CALENDAR_TOMBSTONE_APP_ORIGIN = `http://127.0.0.1:${CALENDAR_TOMBSTONE_APP_PORT}`;
export const CALENDAR_CONTROL_ORIGIN = `http://127.0.0.1:${CALENDAR_CONTROL_PORT}`;

/**
 * Trusted HOST fixture name of the dedicated synthetic AUTHORITATIVE
 * deletion tool on the tombstone app. It reuses the exact `get-event`
 * argument shape (so its canonical schema hash is byte-identical to
 * `FAKE_GET_TOOL_INPUT_SCHEMA`) and is advertised ONLY on that app. The
 * production calendar adapter/normalizer know nothing about it; the C12
 * fixture binding is the only caller, and only behind the explicit
 * authoritative gate.
 */
export const AUTHORITATIVE_GET_TOOL = "get-event-authoritative";
/**
 * Host-trusted synthetic source revision carried by the POSITIVE
 * authoritative deleted evidence on the wire. The fixture wrapper requires
 * this exact value (together with the explicit armed gate) before it ever
 * yields a `deleted` normalized event.
 */
export const AUTHORITATIVE_DELETED_REVISION = "rev-deleted-authoritative";

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
/**
 * Adversarial upstream title for the preview-ambiguity regression: it begins
 * with the legacy stored-preview tool prefix, so only the unambiguous new
 * preview marker keeps receipt/history renderers from cutting the real title.
 */
export const EVENT_TITLE_TOOL_PREFIXED =
  "calendar.reschedule: quarterly planning";
export const EVENT_DESCRIPTION = "notes: q3 planning";
export const EVENT_START = "2026-10-13T09:00:00Z";
/** Wire-normalized start (ISO with milliseconds) as the REAL adapter emits. */
export const EVENT_START_RENDERED = "2026-10-13T09:00:00.000Z";
export const EVENT_END = "2026-10-13T10:00:00Z";
/** Wire-normalized end (the REAL adapter renders both boundaries). */
export const EVENT_END_RENDERED = "2026-10-13T10:00:00.000Z";

/**
 * Input texts the deterministic fake model keys its plan on. The FAKE model
 * (no real LLM) executes a fixed plan: calendar.search -> rN citation ->
 * (refresh/delete plans only:) reference.refresh on the delivered rN ->
 * structured answer citing the newly materialized rN.
 */
export const TEXT_SEARCH = "search my calendar";
export const TEXT_REFRESH = "refresh the calendar event";
export const TEXT_DELETE = "re-read the calendar event after deletion";

/**
 * C22 action texts (the SAME current-turn-request keyed script):
 *  - TEXT_STAGE  : stage the reschedule proposal for the REAL selected r1,
 *  - TEXT_ASSENT : natural-language assent, which must NEVER approve anything.
 */
export const TEXT_STAGE = "move the standup to 11:00";
export const TEXT_ASSENT = "yes, please do it, I approve";

/**
 * C22 staged reschedule boundaries, already in the WIRE-NORMALIZED rendering
 * the real Calendar adapter emits (ISO + milliseconds), so the fake write, the
 * authoritative read-back and the exact boundary comparison all agree.
 */
export const STAGE_START = "2026-10-13T11:00:00.000Z";
export const STAGE_END = "2026-10-13T12:00:00.000Z";

/** Answer part texts the fake model submits (deterministic, cited). */
export const ANSWER_SEARCH_TEXT = "calendar search answer";
export const ANSWER_REFRESH_TEXT = "calendar refresh answer";
export const ANSWER_TOMBSTONE_TEXT = "calendar tombstone answer";
export const ANSWER_FAILED_TEXT = "the calendar call failed";
export const ANSWER_NO_HIT_TEXT = "no calendar events";
/** C22 answer part submitted alongside the staged (proposal-only) reschedule. */
export const ANSWER_STAGE_TEXT = "calendar stage answer";
/** C22: natural-language assent only ever produces this plain answer. */
export const ANSWER_ASSENT_TEXT = "calendar assent answer";

/**
 * M6 create texts (the SAME current-turn-request keyed script): TEXT_CREATE
 * stages a targetless `calendar.create` for the fixed immutable title and
 * timed bounds below; the model then submits ANSWER_CREATE_TEXT with NO
 * citation (there is no source event, no rN to cite).
 */
export const TEXT_CREATE = "create a team sync next week";
export const ANSWER_CREATE_TEXT = "calendar create answer";

/**
 * M6 staged creation content (immutable user semantics, verbatim). The title
 * deliberately carries markup-significant characters (`<sync>` / `&`) to
 * prove the reused UI renders it via textContent (no new security surface);
 * exact full title must survive the card, the verified receipt and the
 * reloaded history.
 */
export const CREATE_TITLE = "Q3 planning <sync> & review";
export const CREATE_START = "2026-11-04T10:00:00.000Z";
export const CREATE_END = "2026-11-04T11:00:00.000Z";

/**
 * Loopback Google-shaped create fixture paths (served by the harness
 * control server, Node-side loopback only, never page-fetched):
 * POST {FIXTURE_CREATE_PATH} materializes the event (exactly one POST per
 * committed insert, 409 on an already-inserted stable id), GET
 * {FIXTURE_CREATE_PATH}/:id is the authoritative read-back surface the
 * readonly fake MCP `get-event` serves for stable ids.
 */
export const FIXTURE_CREATE_PATH =
  "/google/calendar/v3/calendars/cal-e2e/events";
