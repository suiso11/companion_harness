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
// resolved hostside from the COMMITTED proposal (`expectedRevision`) through
// the injected `resolveExpectedEtag`. A missing etag or a hash/updated-only
// expected revision (no etag available) is SAFELY REJECTED as
// `definite_failure` with NO patch dispatched — never a fresh read etag
// substituted for the approved expected revision.
//
// Outcome map (exact, §18.6):
//   - MCP classified `{"status":"succeeded"}`            -> `succeeded`
//   - MCP classified `{"status":"definite_failure",…}`  -> `definite_failure`
//     (includes exact 412/etag_mismatch: the provider proved NO patch)
//   - transport loss / timeout / abort / disconnect / unparseable response
//     (the write may have been dispatched)               -> `unknown`
//     (never a resend, never a cancel, never definite_failure on loss)

import { z } from "zod";

/** Dedicated write MCP identity (never the readonly entrypoint). */
export const RESCHEDULE_WRITE_MCP_NAME = "google-calendar-reschedule" as const;
export const RESCHEDULE_WRITE_MCP_VERSION = "1.0.0-reschedule.1" as const;
/** The ONLY tool on the dedicated write entrypoint. */
export const RESCHEDULE_WRITE_TOOL = "reschedule-event" as const;
/** The Harness-side write tool name (§18.1, start/end only). */
export const CALENDAR_RESCHEDULE_TOOL = "calendar.reschedule" as const;

/** Strict RFC3339-with-offset instant (explicit offset, no bare dates). */
const IsoInstantSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => {
    if (Number.isNaN(Date.parse(value))) return false;
    return /T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value);
  }, "start/end must be RFC3339 instants with an explicit offset");

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
 * Hostside committed-grant etag resolution: returns the EXACT opaque etag
 * from the committed proposal, or null when no etag exists (hash-only /
 * updated-only expected revision). Null is a safe definite rejection, never
 * a fresh-preflight substitution.
 */
export type ResolveExpectedEtag = (targetResourceId: string) => string | null;

/** Structural request (mirrors the kernel `CalendarActionWriteRequest`). */
export interface RescheduleWriteRequest {
  readonly grant: {
    readonly executionId: string;
    readonly proposalId: string;
    readonly proposalHash: string;
    readonly tool: "calendar.reschedule";
    readonly inputHash: string;
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
    // Committed-grant etag ONLY: hash/updated-only revisions (no etag) are
    // safely rejected with NO patch dispatched — never substituted.
    const expectedEtag = options.resolveExpectedEtag(request.targetResourceId);
    if (expectedEtag === null || expectedEtag.length === 0) {
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
    // Strict classified payload only; anything unparseable means the proof
    // was lost in transit -> unknown (never definite on loss).
    let payload: z.infer<typeof RescheduleWriteOutcomePayloadSchema>;
    try {
      const text = call.text ?? "";
      payload = RescheduleWriteOutcomePayloadSchema.parse(JSON.parse(text));
    } catch {
      return { status: "unknown" };
    }
    if (payload.status === "succeeded") {
      return { status: "succeeded" };
    }
    return { status: "definite_failure" };
  }

  return { capability, update };
}
