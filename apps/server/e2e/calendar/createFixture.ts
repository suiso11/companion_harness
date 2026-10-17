// M6 hermetic LOCAL Google-shaped create fixture (tracked, clean-clone-safe).
//
// A loopback-only in-memory Google Calendar `events` surface for the
// dedicated `calendar.create` browser harness (e2e/calendar/server.ts):
//   POST <FIXTURE_CREATE_PATH>  materializes one event (exactly one POST per
//                               committed insert; 409 on a re-inserted stable
//                               id, never an overwrite),
//   GET  <FIXTURE_CREATE_PATH>/:id  the authoritative read-back surface the
//                               readonly fake MCP `get-event` serves for
//                               stable ids (404 when never inserted).
//
// Hermetic by default: no fork checkout, no network, no OAuth, no live
// Google. The tracked stdio double
// (`packages/connector-calendar/test/helpers/createFixtureServer.mjs`,
// same pattern as `rescheduleFixtureServer.mjs`) is the alternate process
// form of this exact contract for suites that want a spawned entrypoint;
// the browser harness uses THIS in-process store so the suite passes on a
// clean clone with no nested fork. The production fork entrypoint
// (`google-calendar-create` / `1.0.0-create.1`, tool `create-event`) stays
// the separately validated production path (fork CLI suites, not this file).

import { CALENDAR_ID } from "./ports.js";

/** Fixture write behavior (loopback control seam; never production). */
export type CreateFixtureMode = "success" | "loss" | "wrong-title";

export interface CreatedEventRecord {
  readonly id: string;
  readonly summary: string;
  readonly start: string;
  readonly end: string;
  readonly calendarId: string;
}

export interface RecordedCreateRequest {
  readonly contentType: string;
  readonly account: string | null;
  readonly calendarId: string;
  readonly body: unknown;
}

export interface CreateFixtureStore {
  mode: CreateFixtureMode;
  /** Every POST that reached the fixture (independent of receipt state). */
  postCount: number;
  /** Every authoritative GET served (independent of receipt state). */
  getCount: number;
  events: Map<string, CreatedEventRecord>;
  requests: RecordedCreateRequest[];
  reset(): void;
}

export function createCreateFixtureStore(): CreateFixtureStore {
  const store: CreateFixtureStore = {
    mode: "success",
    postCount: 0,
    getCount: 0,
    events: new Map(),
    requests: [],
    reset() {
      store.mode = "success";
      store.postCount = 0;
      store.getCount = 0;
      store.events.clear();
      store.requests.length = 0;
    },
  };
  return store;
}

const STABLE_ID_PATTERN = /^[0-9a-f]{32}$/;

function isBlank(value: string): boolean {
  return value.trim().length === 0;
}

function hasControlChars(value: string): boolean {
  for (const unit of value) {
    const code = unit.codePointAt(0) ?? 0;
    if (
      (code >= 0x00 && code <= 0x1f) ||
      (code >= 0x7f && code <= 0x9f && code !== 0x85)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Handle one control-server request for the Google-shaped create surface.
 * Returns true when the path belonged to this fixture (response already
 * ended), false for unrelated paths.
 */
export async function handleCreateFixtureRequest(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  store: CreateFixtureStore,
  readBody: () => Promise<string>,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const base = "/google/calendar/v3/calendars/";
  if (!url.pathname.startsWith(base)) return false;
  const rest = url.pathname.slice(base.length);
  const segments = rest.split("/");
  // Only the single wore calendar is reachable (same-calendar assertion).
  if (segments[0] !== CALENDAR_ID) return false;
  const json = (status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (
    req.method === "POST" &&
    segments.length === 2 &&
    segments[1] === "events"
  ) {
    const raw = await readBody();
    let body: unknown = null;
    try {
      body = JSON.parse(raw) as unknown;
    } catch {
      json(400, { error: { code: "invalid_input" } });
      return true;
    }
    const contentType = String(req.headers["content-type"] ?? "");
    const accountHeader = req.headers["x-fixture-account"];
    const account =
      typeof accountHeader === "string" && accountHeader.length > 0
        ? accountHeader
        : null;
    store.postCount += 1;
    store.requests.push({
      contentType,
      account,
      calendarId: segments[0] as string,
      body,
    });
    if (!contentType.includes("application/json")) {
      json(400, { error: { code: "invalid_input" } });
      return true;
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      json(400, { error: { code: "invalid_input" } });
      return true;
    }
    const record = body as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const allowed = ["end", "id", "start", "summary"];
    if (
      keys.length !== allowed.length ||
      !allowed.every((key, index) => keys[index] === key)
    ) {
      // No description/attendees/recurrence/etag/provider fields ever enter
      // the body: exact `{ id, summary, start, end }` ONLY.
      json(400, { error: { code: "invalid_input" } });
      return true;
    }
    const id = record.id;
    const summary = record.summary;
    const start = record.start as { dateTime?: unknown } | undefined;
    const end = record.end as { dateTime?: unknown } | undefined;
    if (
      typeof id !== "string" ||
      !STABLE_ID_PATTERN.test(id) ||
      typeof summary !== "string" ||
      summary.length < 1 ||
      summary.length > 256 ||
      isBlank(summary) ||
      summary.includes("\0") ||
      hasControlChars(summary) ||
      typeof start !== "object" ||
      start === null ||
      typeof end !== "object" ||
      end === null ||
      typeof (start as { dateTime?: unknown }).dateTime !== "string" ||
      typeof (end as { dateTime?: unknown }).dateTime !== "string"
    ) {
      json(400, { error: { code: "invalid_input" } });
      return true;
    }
    const startText = (start as { dateTime: string }).dateTime;
    const endText = (end as { dateTime: string }).dateTime;
    const startMs = Date.parse(startText);
    const endMs = Date.parse(endText);
    if (Number.isNaN(startMs) || Number.isNaN(endMs) || !(endMs > startMs)) {
      json(400, { error: { code: "invalid_input" } });
      return true;
    }
    if (store.events.has(id)) {
      // The provider proved NO overwrite: an already-inserted stable id is a
      // definite 409, never a resend, never a second record.
      json(409, { error: { code: "already_exists" } });
      return true;
    }
    store.events.set(id, {
      id,
      summary,
      start: startText,
      end: endText,
      calendarId: CALENDAR_ID,
    });
    json(200, {
      id,
      summary,
      start: { dateTime: startText },
      end: { dateTime: endText },
    });
    return true;
  }
  if (
    req.method === "GET" &&
    segments.length === 3 &&
    segments[1] === "events"
  ) {
    const id = segments[2] as string;
    store.getCount += 1;
    const stored = store.events.get(id);
    if (stored === undefined) {
      json(404, { error: { code: "not_found" } });
      return true;
    }
    // Wrong-readback arm (loopback seam only): the stored insert stays
    // correct, but the authoritative read observes a drifted title — the
    // kernel must finish `succeeded_unverified`, never a verified claim.
    const summary =
      store.mode === "wrong-title"
        ? `${stored.summary} (drifted)`
        : stored.summary;
    json(200, {
      id: stored.id,
      calendarId: stored.calendarId,
      status: "confirmed",
      summary,
      start: { dateTime: stored.start },
      end: { dateTime: stored.end },
      updated: "2026-11-04T00:00:00Z",
      etag: `create-${stored.id}`,
    });
    return true;
  }
  return false;
}
