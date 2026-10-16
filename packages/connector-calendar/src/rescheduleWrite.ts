// M5 dedicated reschedule write adapter (Harness side, §18.6).
//
// This is the Harness-owned binding into the SEPARATE dedicated reschedule
// MCP entrypoint (`google-calendar-reschedule` / `1.0.0-reschedule.1`, tool
// `reschedule-event` ONLY). It never touches the readonly entrypoint
// (`google-calendar` / `3.0.0-readonly.2`): readonly tools, scopes, and pin
// are byte/behavior identical with or without this module loaded.
//
// Binding shape (mirrors the kernel `CalendarActionWritePort` structurally;
// the kernel owns that type and this package never imports `@companion/kernel`
// to keep the M4 dependency direction intact):
//   capability: { tool: 'calendar.reschedule',
//                 editableFields: exactly ['start','end'],
//                 connectorInstanceId, writeEnabled: true }
//   update(request, signal): exactly ONE `reschedule-event` MCP call per
//     committed grant (retry:false — `McpConnector.callTool` is single-attempt
//     with no logical resend, §17.6), then the closed three-outcome map.
//
// Expected etag (NO fresh preflight substitution): the conditional etag is
// resolved hostside from the COMMITTED grant (`expectedRevision` carried in
// the grant, keyed by execution/proposal/hash — never the current resource
// alone) through the injected `resolveExpectedEtag`. The resolver answer
// must equal the approved revision exactly and that revision must carry a
// real source-etag basis: a missing etag or a hash/updated-only expected
// revision (no etag available) is SAFELY REJECTED as `definite_failure`
// with NO patch dispatched — never a fresh read etag substituted for the
// approved expected revision.
//
// Outcome map (exact, §18.6):
//   - MCP classified `{"status":"succeeded"}`            -> `succeeded`
//   - MCP classified `{"status":"definite_failure",…}`  -> `definite_failure`
//     (includes exact 412/etag_mismatch: the provider proved NO patch)
//   - transport loss / timeout / abort / disconnect / unparseable response
//     (the write may have been dispatched)               -> `unknown`
//     (never a resend, never a cancel, never definite_failure on loss)

import { z } from "zod";
import { daysInMonth, parseTimedInstant } from "./time.js";

/** Dedicated write MCP identity (never the readonly entrypoint). */
export const RESCHEDULE_WRITE_MCP_NAME = "google-calendar-reschedule" as const;
export const RESCHEDULE_WRITE_MCP_VERSION = "1.0.0-reschedule.1" as const;
/** The ONLY tool on the dedicated write entrypoint. */
export const RESCHEDULE_WRITE_TOOL = "reschedule-event" as const;
/**
 * Pinned LIVE-WIRE canonical input-schema hash for `reschedule-event`
 * (SDK wire bytes: strict `additionalProperties: false` + the `$schema`
 * annotation key). Probed 2026-10-15 over REAL stdio against BOTH the
 * freshly built fork bundle and the tracked contract-mirror fixture
 * (identical bytes).
 */
export const RESCHEDULE_WRITE_WIRE_HASH =
  "9f59e35bf76bfec75a99546fc3c22348cd20e33e9414154ea321d414186d09b7" as const;
/** The Harness-side write tool name (§18.1, start/end only). */
export const CALENDAR_RESCHEDULE_TOOL = "calendar.reschedule" as const;

/**
 * Strict RFC3339 instant grammar with real calendar validation (matches the
 * fork `isStrictCalendarInstant` wire contract): `Date.parse` rollover
 * (`2023-02-30` -> March 2) is rejected instead of accepted. Month lengths,
 * leap years, time ranges, and numeric offsets are enforced.
 *
 * Reuses the existing strict helper (`parseTimedInstant` from `./time.js`,
 * explicit calendar validation, no `Date.parse` permissiveness) for the
 * seconds-precision form; the fork wire contract additionally allows
 * minute-precision (`THH:MM`), which is validated strictly here with the
 * same shared `daysInMonth` table.
 */
const ISO_MINUTE_INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(Z|[+-](\d{2}):(\d{2}))$/;

/**
 * True when an instant carries genuine sub-millisecond precision: a nonzero
 * digit past the millisecond position (e.g. `.1234`). Millisecond-expressible
 * fractions (`.12`, `.123`, `.123000`) are NOT sub-millisecond — a trailing
 * all-zero tail names the same ms. The write contract rejects genuine sub-ms
 * input so the ms-truncating instant parsers (`parseTimedInstant` here, the
 * kernel read-back comparison mirroring it) can never verify a boundary the
 * approval did not preserve.
 */
const SUBSECOND_FRACTION_PATTERN = /T\d{2}:\d{2}:\d{2}\.(\d+)/;
function hasSubMillisecondPrecision(value: string): boolean {
  const match = SUBSECOND_FRACTION_PATTERN.exec(value);
  if (match === null) return false;
  const digits = match[1] as string;
  return digits.length > 3 && /[^0]/.test(digits.slice(3));
}

export function isStrictCalendarInstant(value: string): boolean {
  if (value.length === 0 || value.length > 128) return false;
  if (hasSubMillisecondPrecision(value)) return false;
  if (parseTimedInstant(value) !== undefined) return true;
  const m = ISO_MINUTE_INSTANT_PATTERN.exec(value);
  if (m === null) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > daysInMonth(year, month)) return false;
  if (hour > 23 || minute > 59) return false;
  const offHour = Number(m[7]);
  const offMinute = Number(m[8]);
  if (m[6] !== "Z" && (offHour > 23 || offMinute > 59)) return false;
  return !Number.isNaN(Date.parse(value));
}

/** Strict RFC3339-with-offset instant (explicit offset, no bare dates). */
const IsoInstantSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(
    (value) => isStrictCalendarInstant(value),
    "start/end must be RFC3339 instants with an explicit offset",
  );

/** Exact `reschedule-event` MCP input (start/end only + opaque selection). */
export const RescheduleWriteMcpInputSchema = z
  .strictObject({
    calendarId: z.string().min(1).max(512),
    eventId: z.string().min(1).max(1024),
    account: z.string().min(1).max(512).optional(),
    start: IsoInstantSchema,
    end: IsoInstantSchema,
    expectedEtag: z.string().min(1).max(256),
  })
  .superRefine((value, ctx) => {
    const startMs = Date.parse(value.start);
    const endMs = Date.parse(value.end);
    if (Number.isNaN(startMs) || Number.isNaN(endMs) || !(endMs > startMs)) {
      ctx.addIssue({
        code: "custom",
        message: "start must be before end",
        path: ["start"],
      });
    }
  });

/** Classified MCP outcome payload (strict; unparseable means lost). */
export const RescheduleWriteOutcomePayloadSchema = z.union([
  z.strictObject({ status: z.literal("succeeded") }),
  z.strictObject({
    status: z.literal("definite_failure"),
    code: z.string().min(1).max(128),
  }),
]);

/** Minimal single-attempt MCP caller (implemented by `McpConnector`). */
export interface RescheduleWriteCaller {
  callTool(
    upstreamTool: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<
    | {
        readonly ok: true;
        readonly structuredContent?: unknown;
        readonly text?: string;
      }
    | { readonly ok: false; readonly code: string }
  >;
}

/** Host-private write target (provider ids never leave the host store). */
export interface RescheduleWriteTarget {
  readonly calendarId: string;
  readonly eventId: string;
  readonly account?: string;
}

/**
 * Hostside committed-grant etag resolution: keyed by the EXACT committed
 * grant (execution + proposal + hash), never by the target resource alone.
 * Returns the EXACT opaque etag from the committed proposal's
 * `expectedRevision`, or null when no etag exists (hash-only /
 * updated-only expected revision). Null is a safe definite rejection, never
 * a fresh-preflight substitution.
 */
export interface RescheduleWriteGrantRef {
  readonly executionId: string;
  readonly proposalId: string;
  readonly proposalHash: string;
  /** Immutable approved revision the grant was committed against. */
  readonly expectedRevision: string;
}

export type ResolveExpectedEtag = (
  grant: RescheduleWriteGrantRef,
) => string | null;

/**
 * Concrete host resolver keyed by the committed grant (production default
 * helper, trusted host code only, default OFF: nothing is auto-wired).
 *
 * The host builds this ONCE from its committed-grant store
 * (execution/proposal/hash -> immutable `expectedRevision`) and passes the
 * returned `ResolveExpectedEtag` into `createRescheduleWritePort`. Lookup
 * is by the EXACT committed grant triple; the answer must equal
 * `grant.expectedRevision` exactly and carry a real source-etag basis
 * (`isSourceEtagBasis`), otherwise null (safe definite rejection, never a
 * fresh-preflight substitution). Resolver throw pre-dispatch is caught by
 * the port as `definite_failure` (safe: no dispatch happened).
 */
export function createCommittedGrantResolver(
  committed: ReadonlyMap<string, string> | Record<string, string>,
): ResolveExpectedEtag {
  const store =
    committed instanceof Map ? committed : new Map(Object.entries(committed));
  return (grant: RescheduleWriteGrantRef): string | null => {
    const key = `${grant.executionId}\n${grant.proposalId}\n${grant.proposalHash}`;
    const revision = store.get(key);
    if (revision === undefined) return null;
    if (revision !== grant.expectedRevision) return null;
    if (!isSourceEtagBasis(revision)) return null;
    return revision;
  };
}

/**
 * Source-etag basis proof: the approved `expectedRevision` is usable as a
 * conditional etag ONLY when it is a real source etag. A content-hash
 * fallback (64-hex SHA-256) or an `updated`-timestamp string is NOT an
 * etag and is rejected — the port must never treat those as etags.
 */
export function isSourceEtagBasis(value: string): boolean {
  if (value.length === 0 || value.length > 256) return false;
  // Content-hash fallback (proposal `expectedRevision` when no
  // `source_revision` exists): proves nothing about the live resource.
  if (/^[0-9a-f]{64}$/i.test(value)) return false;
  // `updated`-timestamp strings: wall-clock markers, not etags.
  if (/^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value))) {
    return false;
  }
  return true;
}

/** Structural request (mirrors the kernel `CalendarActionWriteRequest`). */
export interface RescheduleWriteRequest {
  readonly grant: {
    readonly executionId: string;
    readonly proposalId: string;
    readonly proposalHash: string;
    readonly tool: "calendar.reschedule";
    readonly inputHash: string;
    /** Immutable approved revision the grant was committed against. */
    readonly expectedRevision: string;
  };
  readonly connectorInstanceId: string;
  readonly tool: "calendar.reschedule";
  readonly start: string;
  readonly end: string;
  readonly targetResourceId: string;
  readonly targetCanonicalKey: string;
  readonly target: RescheduleWriteTarget;
  readonly signal?: AbortSignal | undefined;
}

export type RescheduleWriteOutcome =
  | { readonly status: "succeeded" }
  | { readonly status: "definite_failure" }
  | { readonly status: "unknown" };

export interface RescheduleWritePort {
  readonly capability: {
    readonly tool: "calendar.reschedule";
    readonly editableFields: readonly ["start", "end"];
    readonly connectorInstanceId: string;
    readonly writeEnabled: true;
  };
  update(
    request: RescheduleWriteRequest,
    signal?: AbortSignal,
  ): Promise<RescheduleWriteOutcome>;
}

export interface CreateRescheduleWritePortOptions {
  readonly connectorInstanceId: string;
  /** Dedicated write MCP caller (single `reschedule-event` binding). */
  readonly caller: RescheduleWriteCaller;
  /** Exact configured upstream tool name (must be `reschedule-event`). */
  readonly upstreamTool?: string;
  /** Committed-grant etag resolution (no fresh preflight). */
  readonly resolveExpectedEtag: ResolveExpectedEtag;
}

/**
 * Create the dedicated Harness write port. Exactly one MCP call per update;
 * no retry, no recurring split, no other fields. A throwing caller after the
 * committed marker maps to `unknown` (the strategy owns the marker; this
 * port only classifies its own single attempt).
 */
export function createRescheduleWritePort(
  options: CreateRescheduleWritePortOptions,
): RescheduleWritePort {
  const upstreamTool = options.upstreamTool ?? RESCHEDULE_WRITE_TOOL;
  if (upstreamTool !== RESCHEDULE_WRITE_TOOL) {
    throw new Error("reschedule write binding must be reschedule-event only");
  }
  const capability = {
    tool: CALENDAR_RESCHEDULE_TOOL,
    editableFields: ["start", "end"] as const,
    connectorInstanceId: options.connectorInstanceId,
    writeEnabled: true as const,
  };

  async function update(
    request: RescheduleWriteRequest,
    signal?: AbortSignal,
  ): Promise<RescheduleWriteOutcome> {
    // Exact binding: grant-bound tool + instance must match the capability.
    if (
      request.tool !== CALENDAR_RESCHEDULE_TOOL ||
      request.connectorInstanceId !== options.connectorInstanceId
    ) {
      return { status: "definite_failure" };
    }
    if (request.start.length === 0 || request.end.length === 0) {
      return { status: "definite_failure" };
    }
    // Committed-grant etag ONLY, tied to the EXACT approved revision:
    // the resolver is keyed by execution/proposal/hash (never the current
    // resource alone), its answer must equal `grant.expectedRevision`
    // exactly (no substitution), and that revision must carry a real source
    // etag basis (hash-only / updated-only revisions are safely rejected
    // with NO patch dispatched — never substituted, never a fresh read).
    const grantRef: RescheduleWriteGrantRef = {
      executionId: request.grant.executionId,
      proposalId: request.grant.proposalId,
      proposalHash: request.grant.proposalHash,
      expectedRevision: request.grant.expectedRevision,
    };
    // Resolver exceptions (e.g. a temporarily unreadable committed-grant
    // store) happen BEFORE any MCP call is dispatched, so the no-commit
    // proof is intact: definite_failure, never `unknown` (the strategy maps
    // a throw to unknown-commit, which would falsely claim a write may have
    // occurred).
    let expectedEtag: string | null;
    try {
      expectedEtag = options.resolveExpectedEtag(grantRef);
    } catch {
      return { status: "definite_failure" };
    }
    if (
      expectedEtag === null ||
      expectedEtag.length === 0 ||
      expectedEtag !== request.grant.expectedRevision ||
      !isSourceEtagBasis(request.grant.expectedRevision)
    ) {
      return { status: "definite_failure" };
    }
    const args = RescheduleWriteMcpInputSchema.safeParse({
      calendarId: request.target.calendarId,
      eventId: request.target.eventId,
      ...(request.target.account !== undefined
        ? { account: request.target.account }
        : {}),
      start: request.start,
      end: request.end,
      expectedEtag,
    });
    if (!args.success) {
      return { status: "definite_failure" };
    }
    // THE single attempt (retry:false): `callTool` never auto-resends.
    let call: Awaited<ReturnType<RescheduleWriteCaller["callTool"]>>;
    try {
      call = await options.caller.callTool(
        upstreamTool,
        args.data,
        signal ?? request.signal,
      );
    } catch {
      return { status: "unknown" };
    }
    if (!call.ok) {
      // Transport/identity denial AFTER possible dispatch: the response was
      // lost, so definite failure must never be claimed.
      return { status: "unknown" };
    }
    // Strict classified payload only, structuredContent FIRST per the MCP
    // response contract (`docs/implementation_plan.md`: structuredContent is
    // authoritative when present; strict JSON text is a fallback ONLY when it
    // is absent). Own-property presence decides — the same policy as the
    // readonly decoder (`./normalize.ts` `selectBody`): a present value, even
    // null/wrong-shaped, is the ONLY source and is never rescued by text
    // (falling back to a valid text would risk a false verified receipt for
    // a response the provider did not actually classify). Only when the
    // property is ABSENT is the ENTIRE text parsed as strict JSON.
    // Anything unparseable means the proof was lost in transit -> unknown
    // (never definite on loss, never a fallback claim).
    let payload: z.infer<typeof RescheduleWriteOutcomePayloadSchema>;
    if (Object.hasOwn(call, "structuredContent")) {
      try {
        payload = RescheduleWriteOutcomePayloadSchema.parse(
          call.structuredContent,
        );
      } catch {
        return { status: "unknown" };
      }
    } else {
      try {
        const text = call.text ?? "";
        payload = RescheduleWriteOutcomePayloadSchema.parse(JSON.parse(text));
      } catch {
        return { status: "unknown" };
      }
    }
    if (payload.status === "succeeded") {
      return { status: "succeeded" };
    }
    return { status: "definite_failure" };
  }

  return { capability, update };
}
