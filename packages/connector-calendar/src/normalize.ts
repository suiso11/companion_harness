import { z } from "zod";

/**
 * Versioned upstream event shape for the PROPOSED readonly fork surface
 * (docs/google_calendar_readonly_binding_design.md P3/P7 deltas).
 * NOT a claim about the unmodified upstream: `nextPageToken` and `etag`
 * exist only after the external patch; without it there is no paging or
 * etag binding (adoption gate, see binding.ts).
 */
export const PROPOSED_UPSTREAM_EVENT_SCHEMA_VERSION = 1;

export const proposedUpstreamEventSchema = z
  .object({
    id: z.string().min(1).max(1024),
    calendarId: z.string().min(1).max(512),
    status: z.enum(["confirmed", "tentative", "cancelled"]),
    summary: z.string().max(4096),
    description: z.string().max(16384).optional(),
    location: z.string().max(4096).optional(),
    start: z.string().min(1).max(128),
    end: z.string().min(1).max(128),
    updated: z.string().datetime({ offset: true }).optional(),
    etag: z.string().min(1).max(512).optional(),
    // Sensitive passthrough fields are accepted here so the normalizer can
    // provably DROP them; they never reach the Snapshot.
    attendees: z.unknown().optional(),
    organizer: z.unknown().optional(),
    conferenceData: z.unknown().optional(),
    hangoutLink: z.unknown().optional(),
    htmlLink: z.unknown().optional(),
  })
  .strict()
  .catchall(z.unknown());

export type ProposedUpstreamEvent = z.infer<typeof proposedUpstreamEventSchema>;

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

function allDayEndExclusive(start: string, end: string): boolean {
  // All-day Google events use DATE (YYYY-MM-DD) forms; timed use dateTime.
  // Heuristic-free structural check on the wire shape only.
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
  return dateOnly.test(start) && dateOnly.test(end);
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseEventTime(value: string, field: "start" | "end"): number {
  const dateOnly = DATE_ONLY.exec(value);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) {
      throw new Error(`invalid all-day ${field}: ${value}`);
    }
    // Real calendar validation (rejects e.g. 2026-02-30 rollover).
    const ms = Date.UTC(year, month - 1, day);
    const check = new Date(ms);
    if (
      check.getUTCFullYear() !== year ||
      check.getUTCMonth() !== month - 1 ||
      check.getUTCDate() !== day
    ) {
      throw new Error(`invalid all-day ${field}: ${value}`);
    }
    return ms;
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new Error(`invalid ISO ${field}: ${value}`);
  }
  return ms;
}

/** Validate start/end wire shapes (timed ISO dateTime or all-day DATE). */
function validateEventRange(start: string, end: string): void {
  const startMs = parseEventTime(start, "start");
  const endMs = parseEventTime(end, "end");
  if (!(endMs > startMs)) {
    throw new Error("event end must be after start");
  }
}

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
 */
export function canonicalKey(
  connectorInstanceId: string,
  calendarId: string,
  eventId: string,
): string {
  return `calendar:${connectorInstanceId}:${calendarId}:${eventId}`;
}

export interface NormalizeOptions {
  connectorInstanceId: string;
  nowIso: string;
}

/**
 * Strict versioned normalization: structured object first; real ISO/all-day
 * start/end validation with end>start (§17.4); privacy exclusions
 * (attendees/organizer/conference URLs/HTML links/raw payload) are dropped.
 * Revision precedence: etag > sourceUpdatedAt > content hash, where the
 * hash covers the ACTUAL normalized snapshot (truncated title/description/
 * location/start/end) — never the raw untruncated source.
 * `deleted` is never produced here — tombstones require authoritative
 * evidence via classifyDeletion (search omission creates none).
 */
export async function normalizeEvent(
  raw: unknown,
  options: NormalizeOptions,
): Promise<NormalizedEvent> {
  const parsed = proposedUpstreamEventSchema.parse(raw);
  void options.nowIso;
  validateEventRange(parsed.start, parsed.end);
  const key = canonicalKey(
    options.connectorInstanceId,
    parsed.calendarId,
    parsed.id,
  );
  const title = parsed.summary.slice(0, 1024);
  const description =
    parsed.description !== undefined
      ? parsed.description.slice(0, 8192)
      : undefined;
  const location =
    parsed.location !== undefined
      ? parsed.location.slice(0, 1024)
      : undefined;
  const snapshotForHash = {
    title,
    description: description ?? "",
    location: location ?? "",
    start: parsed.start,
    end: parsed.end,
  };
  let sourceRevision: string;
  let basis: NormalizedEvent["revisionBasis"];
  if (parsed.etag !== undefined) {
    sourceRevision = parsed.etag;
    basis = "etag";
  } else if (parsed.updated !== undefined) {
    sourceRevision = parsed.updated;
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
    start: parsed.start,
    end: parsed.end,
    allDayEndExclusive: allDayEndExclusive(parsed.start, parsed.end),
    ...(parsed.updated !== undefined
      ? { sourceUpdatedAt: parsed.updated }
      : {}),
    sourceRevision,
    revisionBasis: basis,
    sensitivity: "personal",
  };
  return normalizedEventSchema.parse(out);
}

export type DeletionVerdict =
  | { kind: "deleted"; reason: "authoritative-tombstone" }
  | { kind: "not-deleted"; reason: "no-authoritative-evidence" }
  | { kind: "unknown"; code: "calendar_upstream_error" };

/**
 * Deletion classifier (§17.5 + 2026-09-09 correction): bare 404/410 or
 * `cancelled` alone is NOT deletion proof; search omission NEVER creates a
 * tombstone. Only operation-specific authoritative evidence for a
 * prior-known resource yields `deleted`; ambiguous errors map to
 * `calendar_upstream_error` with no deletion.
 */
export function classifyDeletion(input: {
  priorKnown: boolean;
  authoritativeRead:
    | "get-tombstone"
    | "list-showDeleted-tombstone"
    | "not-found"
    | "ambiguous-error"
    | "search-omission";
}): DeletionVerdict {
  if (!input.priorKnown)
    return { kind: "not-deleted", reason: "no-authoritative-evidence" };
  switch (input.authoritativeRead) {
    case "get-tombstone":
    case "list-showDeleted-tombstone":
      return { kind: "deleted", reason: "authoritative-tombstone" };
    case "ambiguous-error":
    case "not-found":
    case "search-omission":
      return input.authoritativeRead === "ambiguous-error"
        ? { kind: "unknown", code: "calendar_upstream_error" }
        : { kind: "not-deleted", reason: "no-authoritative-evidence" };
  }
}
