import type { CallResult, McpErrorCode } from "@companion/connector-mcp";
import { parseStrictCalendarInstantMs } from "@companion/contracts";
import { z } from "zod";
import { canonicalUtcIso, isIanaTimeZone, parseDateOnly } from "./time.js";

/**
 * Consumer-owned decoder for the candidate readonly fork surface
 * (`@cocal/google-calendar-mcp`, unadopted). It interprets the real nested
 * event envelope observed in the tracked C08 archive:
 * `start`/`end` are objects (`{dateTime?, date?, timeZone?}`), NOT flat
 * strings. The candidate producer also emits many rare fields, so the event
 * schema validates only the CONSUMED fields and strips everything else; the
 * strictness lives in the exact operation ROOT envelopes and the endpoint
 * union.
 *
 * Strictness note: the candidate TS interface makes `summary`/`status`
 * optional. Rejecting a missing summary/status is an explicit CONSUMER policy
 * (never fabricate an empty title or a "confirmed" status); it is NOT an
 * upstream guarantee and is not an adoption claim.
 */

const REQUEST_INVALID = "calendar_response_invalid";

const dateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .refine((value) => parseDateOnly(value) !== undefined, {
    message: "all-day value must be a real calendar date",
  });

const timedSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => parseStrictCalendarInstantMs(value) !== undefined, {
    message: "datetime must be RFC3339 with an explicit offset",
  });

const ianaSchema = z.string().min(1).max(128).refine(isIanaTimeZone, {
  message: "timeZone must be an IANA-shaped name or UTC",
});

/** Strict nested endpoint: exactly one of `date` or `dateTime`. */
export const candidateEventEndpointSchema = z
  .strictObject({
    date: dateOnlySchema.optional(),
    dateTime: timedSchema.optional(),
    timeZone: ianaSchema.optional(),
  })
  .superRefine((v, ctx) => {
    const hasDate = v.date !== undefined;
    const hasDateTime = v.dateTime !== undefined;
    if (hasDate === hasDateTime) {
      ctx.addIssue({
        code: "custom",
        message: "endpoint must specify exactly one of date or dateTime",
        path: ["date"],
      });
    }
  });

/**
 * Nested candidate event: validates the consumed fields and the endpoint
 * union. Unknown converter extras (organizer, attendees, recurrence, source,
 * attachments, ...) are stripped, never rejected or passed through.
 */
export const candidateEventSchema = z.object({
  id: z.string().min(1).max(1024),
  calendarId: z.string().min(1).max(512),
  status: z.enum(["confirmed", "tentative", "cancelled"]),
  summary: z.string().min(1).max(4096),
  description: z.string().max(16384).optional(),
  location: z.string().max(4096).optional(),
  start: candidateEventEndpointSchema,
  end: candidateEventEndpointSchema,
  updated: timedSchema.optional(),
  etag: z.string().min(1).max(512).optional(),
});

export type CandidateEvent = z.infer<typeof candidateEventSchema>;

const nextPageTokenSchema = z.string().min(1).max(2048);

/**
 * Actual `list-events` root. The broad candidate TS interface permits
 * `calendars`/`accounts`/`note`/`warnings`/`partialFailures`; they are
 * enumerated here and projected out (never returned to the consumer).
 */
export const listEventsPageSchema = z.strictObject({
  events: z.array(candidateEventSchema),
  totalCount: z.number().int().min(0),
  nextPageToken: nextPageTokenSchema.optional(),
  calendars: z.array(z.string()).optional(),
  accounts: z.array(z.string()).optional(),
  note: z.string().optional(),
  warnings: z.array(z.string()).optional(),
  partialFailures: z
    .array(z.strictObject({ accountId: z.string(), reason: z.string() }))
    .optional(),
});

/**
 * Actual `search-events` root: distinct from the list envelope. The actual
 * candidate handler always emits `calendarId` and `timeRange` (the broad TS
 * interface labels them optional); `query` is emitted iff the search input
 * carried one. These are source-proven REQUIRED/Optional distinctions.
 */
export const searchEventsPageSchema = z.strictObject({
  events: z.array(candidateEventSchema),
  totalCount: z.number().int().min(0),
  nextPageToken: nextPageTokenSchema.optional(),
  query: z.string().min(1).optional(),
  calendarId: z.string().min(1),
  timeRange: z.strictObject({ start: timedSchema, end: timedSchema }),
});

/** Actual `get-event` root: exactly `{event}`, not a page. */
export const getEventBodySchema = z.strictObject({
  event: candidateEventSchema,
});

/** Normalized Snapshot event (§17.4, exact): privacy exclusions applied. */
export const normalizedEventSchema = z
  .object({
    schemaVersion: z.literal(1),
    canonicalKey: z.string().min(1).max(1024),
    status: z.enum(["confirmed", "tentative", "cancelled", "deleted"]),
    title: z.string().max(1024),
    description: z.string().max(8192).optional(),
    location: z.string().max(1024).optional(),
    start: z.string().min(1).max(128),
    end: z.string().min(1).max(128),
    allDayEndExclusive: z.boolean(),
    sourceUpdatedAt: z.string().datetime({ offset: true }).optional(),
    sourceRevision: z.string().min(1).max(512),
    revisionBasis: z.enum(["etag", "source-updated", "normalized-hash"]),
    sensitivity: z.literal("personal"),
  })
  .strict();

export type NormalizedEvent = z.infer<typeof normalizedEventSchema>;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalJson((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Canonical resource identity (§17.4, exact):
 * connectorInstanceId + calendarId + eventId, no URLs or absolute paths.
 * Collision-safe: the exact tuple is JSON-serialized before hashing so
 * embedded separators (e.g. ':') cannot merge distinct tuples.
 * Opaque: only the `calendar:` prefix plus hex digest is exposed.
 */
export async function canonicalKey(
  connectorInstanceId: string,
  calendarId: string,
  eventId: string,
): Promise<string> {
  const digest = await sha256Hex(
    JSON.stringify([connectorInstanceId, calendarId, eventId]),
  );
  return `calendar:${digest}`;
}

interface ResolvedEndpoints {
  allDay: boolean;
  startOut: string;
  endOut: string;
}

/**
 * Validate the endpoint pair and canonicalize it. All-day DATE strings are
 * unchanged (exclusive end); timed instants become UTC ISO. Mixed kinds,
 * reversed/equal order and impossible calendar values are rejected.
 */
function resolveEndpoints(
  start: CandidateEvent["start"],
  end: CandidateEvent["end"],
): ResolvedEndpoints {
  if (start.date !== undefined) {
    if (end.date === undefined) throw new Error("mixed endpoint kinds");
    const startMs = parseDateOnly(start.date);
    const endMs = parseDateOnly(end.date);
    if (startMs === undefined || endMs === undefined || !(endMs > startMs)) {
      throw new Error("invalid all-day range");
    }
    return { allDay: true, startOut: start.date, endOut: end.date };
  }
  if (start.dateTime === undefined || end.dateTime === undefined) {
    throw new Error("mixed endpoint kinds");
  }
  const startMs = parseStrictCalendarInstantMs(start.dateTime);
  const endMs = parseStrictCalendarInstantMs(end.dateTime);
  if (startMs === undefined || endMs === undefined || !(endMs > startMs)) {
    throw new Error("invalid timed range");
  }
  return {
    allDay: false,
    startOut: canonicalUtcIso(startMs),
    endOut: canonicalUtcIso(endMs),
  };
}

export interface NormalizeOptions {
  connectorInstanceId: string;
}

/**
 * Strict normalization of a validated nested candidate event.
 *
 * Failure (schema/endpoint/time/hash) rejects with the fixed
 * `Error("calendar_response_invalid")` carrying NO cause, raw value or Zod
 * issue. No clock, no `now`, no environment reads.
 *
 * Revision precedence: etag > canonical source-updated > normalized-hash,
 * where the hash covers the ACTUAL normalized snapshot after temporal
 * canonicalization and truncation (status/title/optional description/optional
 * location/start/end/allDayEndExclusive) and excludes identity, revision and
 * private metadata. `deleted` is never produced here: this decoder passes
 * through only the candidate consumed statuses and never synthesizes a
 * tombstone.
 */
export async function normalizeEvent(
  raw: unknown,
  options: NormalizeOptions,
): Promise<NormalizedEvent> {
  try {
    return await normalizeEventStrict(raw, options.connectorInstanceId);
  } catch {
    throw new Error("calendar_response_invalid");
  }
}

async function normalizeEventStrict(
  raw: unknown,
  connectorInstanceId: string,
): Promise<NormalizedEvent> {
  const parsed = candidateEventSchema.parse(raw);
  const { allDay, startOut, endOut } = resolveEndpoints(
    parsed.start,
    parsed.end,
  );

  // `updated` is validated by the schema even when a higher-priority etag wins,
  // so a malformed timestamp can never become sourceUpdatedAt.
  let sourceUpdatedAt: string | undefined;
  if (parsed.updated !== undefined) {
    const updatedMs = parseStrictCalendarInstantMs(parsed.updated);
    if (updatedMs === undefined) throw new Error("invalid updated");
    sourceUpdatedAt = canonicalUtcIso(updatedMs);
  }

  const key = await canonicalKey(
    connectorInstanceId,
    parsed.calendarId,
    parsed.id,
  );
  const title = parsed.summary.slice(0, 1024);
  const description =
    parsed.description !== undefined
      ? parsed.description.slice(0, 8192)
      : undefined;
  const location =
    parsed.location !== undefined ? parsed.location.slice(0, 1024) : undefined;
  const snapshotForHash = {
    status: parsed.status,
    title,
    ...(description !== undefined ? { description } : {}),
    ...(location !== undefined ? { location } : {}),
    start: startOut,
    end: endOut,
    allDayEndExclusive: allDay,
  };
  let sourceRevision: string;
  let basis: NormalizedEvent["revisionBasis"];
  if (parsed.etag !== undefined) {
    sourceRevision = parsed.etag;
    basis = "etag";
  } else if (sourceUpdatedAt !== undefined) {
    sourceRevision = sourceUpdatedAt;
    basis = "source-updated";
  } else {
    sourceRevision = await sha256Hex(
      JSON.stringify(canonicalJson(snapshotForHash)),
    );
    basis = "normalized-hash";
  }
  const out: NormalizedEvent = {
    schemaVersion: 1,
    canonicalKey: key,
    status: parsed.status,
    title,
    ...(description !== undefined ? { description } : {}),
    ...(location !== undefined ? { location } : {}),
    start: startOut,
    end: endOut,
    allDayEndExclusive: allDay,
    ...(sourceUpdatedAt !== undefined ? { sourceUpdatedAt } : {}),
    sourceRevision,
    revisionBasis: basis,
    sensitivity: "personal",
  };
  return normalizedEventSchema.parse(out);
}

/**
 * structuredContent-first selection using OWN-PROPERTY presence. A present
 * `structuredContent` (even null/undefined/wrong-shaped) is the ONLY source
 * and is never rescued by text. Only when the property is ABSENT is the ENTIRE
 * `text` parsed as strict JSON (no fences, prose, prefix/suffix scanning or
 * event synthesis).
 *
 * Transport seam: the merged MCP client omits `structuredContent` when its
 * value is `undefined`, so an upstream property-present `undefined` is
 * indistinguishable from absence after the transport. Legal JSON cannot carry
 * `undefined`, so this only matters for injected direct objects; the Calendar
 * boundary still rejects an explicit own-property `undefined` it does receive.
 */
function selectBody(result: {
  structuredContent?: unknown;
  text?: string;
}): unknown {
  if (Object.hasOwn(result, "structuredContent")) {
    return result.structuredContent;
  }
  if (typeof result.text !== "string") throw new Error(REQUEST_INVALID);
  return JSON.parse(result.text) as unknown;
}

export interface NormalizePageOptions {
  connectorInstanceId: string;
  calendarId: string;
  requestedLimit: number;
  /** Explicit upstream operation: list and search roots are not interchangeable. */
  operation: "list-events" | "search-events";
}

export interface NormalizeGetOptions {
  connectorInstanceId: string;
  calendarId: string;
}

export type NormalizeSearchResult =
  | { ok: true; events: NormalizedEvent[]; cursor?: string }
  | { ok: false; code: McpErrorCode };

/**
 * One-page decode plus the host-private upstream targets for the SAME decoded
 * events. `targets` is provider-identity data and MUST NOT leave the host:
 * it is never part of a Snapshot/body, model-facing output, public DTO or
 * fixed error. It is produced from the SAME candidate parse as `events` (one
 * parse, no second decode) so a target can never diverge from a normalized
 * event or be fabricated for a rejected event.
 */
export interface NormalizeSearchPageResult {
  events: NormalizedEvent[];
  cursor?: string;
  targets: Array<{ canonicalKey: string; calendarId: string; eventId: string }>;
}

export type NormalizeSearchPageOutcome =
  | ({ ok: true } & NormalizeSearchPageResult)
  | { ok: false; code: McpErrorCode };

export type NormalizeGetResult =
  | { ok: true; event: NormalizedEvent }
  | { ok: false; code: McpErrorCode };

function isValidPageOptions(options: NormalizePageOptions): boolean {
  return (
    typeof options.calendarId === "string" &&
    options.calendarId.length > 0 &&
    Number.isInteger(options.requestedLimit) &&
    options.requestedLimit >= 1 &&
    options.requestedLimit <= 20
  );
}

/**
 * Decode a `calendar.search` page result into normalized events plus an
 * opaque cursor and the host-private targets for the same events. Page
 * metadata is projected out. An incoming fixed MCP failure code is preserved;
 * every decode/validation failure is the fixed `calendar_response_invalid`.
 * Never slices/truncates an over-limit page and never fetches a second page.
 */
export async function normalizeSearchPage(
  result: CallResult,
  options: NormalizePageOptions,
): Promise<NormalizeSearchPageOutcome> {
  if (!result.ok) return { ok: false, code: result.code };
  if (!isValidPageOptions(options)) {
    return { ok: false, code: "calendar_range_invalid" };
  }
  try {
    const raw = selectBody(result);
    let events: CandidateEvent[];
    let totalCount: number;
    let nextPageToken: string | undefined;
    let rootCalendarId: string | undefined;
    if (options.operation === "search-events") {
      const body = searchEventsPageSchema.parse(raw);
      events = body.events;
      totalCount = body.totalCount;
      nextPageToken = body.nextPageToken;
      rootCalendarId = body.calendarId;
    } else {
      const body = listEventsPageSchema.parse(raw);
      events = body.events;
      totalCount = body.totalCount;
      nextPageToken = body.nextPageToken;
    }
    // Producer totalCount is the PAGE count; never a live query total.
    if (totalCount !== events.length) throw new Error(REQUEST_INVALID);
    if (events.length > options.requestedLimit)
      throw new Error(REQUEST_INVALID);
    if (rootCalendarId !== undefined && rootCalendarId !== options.calendarId) {
      throw new Error(REQUEST_INVALID);
    }
    const normalized: NormalizedEvent[] = [];
    const targets: Array<{
      canonicalKey: string;
      calendarId: string;
      eventId: string;
    }> = [];
    for (const event of events) {
      if (event.calendarId !== options.calendarId) {
        throw new Error(REQUEST_INVALID);
      }
      const decoded = await normalizeEvent(event, {
        connectorInstanceId: options.connectorInstanceId,
      });
      normalized.push(decoded);
      targets.push({
        canonicalKey: decoded.canonicalKey,
        calendarId: event.calendarId,
        eventId: event.id,
      });
    }
    return nextPageToken !== undefined
      ? { ok: true, events: normalized, cursor: nextPageToken, targets }
      : { ok: true, events: normalized, targets };
  } catch {
    return { ok: false, code: REQUEST_INVALID };
  }
}

/**
 * Existing public page decoder: identical normalized events/cursor as
 * {@link normalizeSearchPage}, with the host-private targets projected out.
 */
export async function normalizeSearchResult(
  result: CallResult,
  options: NormalizePageOptions,
): Promise<NormalizeSearchResult> {
  const page = await normalizeSearchPage(result, options);
  if (!page.ok) return { ok: false, code: page.code };
  return page.cursor !== undefined
    ? { ok: true, events: page.events, cursor: page.cursor }
    : { ok: true, events: page.events };
}

/**
 * Decode a `get-event` result. Root must be exactly `{event}` (a page root is
 * rejected) and the event must belong to the trusted HOST calendar. This is a
 * read, NOT deletion proof.
 */
export async function normalizeGetResult(
  result: CallResult,
  options: NormalizeGetOptions,
): Promise<NormalizeGetResult> {
  if (!result.ok) return { ok: false, code: result.code };
  if (
    typeof options.calendarId !== "string" ||
    options.calendarId.length === 0
  ) {
    return { ok: false, code: "calendar_range_invalid" };
  }
  try {
    const raw = selectBody(result);
    const body = getEventBodySchema.parse(raw);
    if (body.event.calendarId !== options.calendarId) {
      throw new Error(REQUEST_INVALID);
    }
    const event = await normalizeEvent(body.event, {
      connectorInstanceId: options.connectorInstanceId,
    });
    return { ok: true, event };
  } catch {
    return { ok: false, code: REQUEST_INVALID };
  }
}
