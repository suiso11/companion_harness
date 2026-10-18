// M6 dedicated create write adapter (Harness side, agreed M6 extension).
//
// This is the Harness-owned binding into the SEPARATE dedicated create MCP
// entrypoint (`google-calendar-create` / `1.0.0-create.1`, tool
// `create-event` ONLY). It never touches the readonly entrypoint
// (`google-calendar` / `3.0.0-readonly.2`) nor the reschedule entrypoint
// (`google-calendar-reschedule` / `1.0.0-reschedule.1`): readonly tools,
// scopes, and pins are byte/behavior identical with or without this module
// loaded, and the reschedule binding is unchanged.
//
// Binding shape (mirrors the kernel `CalendarCreateWritePort` structurally;
// the kernel owns that type and this package never imports `@companion/kernel`
// to keep the M4 dependency direction intact):
//   capability: { tool: 'calendar.create',
//                 editableFields: exactly ['title','start','end'],
//                 connectorInstanceId, writeEnabled: true }
//   insert(request, signal): exactly ONE `create-event` MCP call per
//     committed grant (retry:false — `McpConnector.callTool` is single-attempt
//     with no logical resend), then the closed three-outcome map.
//
// Stable client id (NO fake resource): the insert id derives deterministically
// hostside from the IMMUTABLE execution id (UUID without dashes: 32 lowercase
// hex chars) BEFORE dispatch and is never model input. Hex `[0-9a-f]` is a
// strict subset of Google's allowed base32hex `[a-v0-9]` alphabet and 32 chars
// sit inside the 5..1024 length bound, so the derived id is always
// provider-legal. One execution owns exactly one id; one consumed grant
// performs exactly one insert with it. Repeated approval of the same
// hash/key returns the original run, so the same id is never re-inserted.
//
// Body discipline: the provider `events.insert` body carries ONLY
// `{ id, summary, start, end }` (stable id + immutable title + timed bounds).
// No description, attendees, recurrence, all-day, or provider ids exist here.
// The opaque calendar/account selection routes the call hostside and never
// enters the body.
//
// Outcome map (exact):
//   - MCP classified `{"status":"succeeded"}`            -> `succeeded`
//   - MCP classified `{"status":"definite_failure",…}`  -> `definite_failure`
//     (includes exact 409/already-exists: the provider proved NO overwrite —
//     never an overwrite, never a retry, never a resend)
//   - transport loss / timeout / abort / disconnect / unparseable response
//     (the insert may have been dispatched)               -> `unknown`
//     (never a resend, never a cancel, never definite_failure on loss;
//     an `unknown` insert response is NEVER read-to-auto-resolve or retried
//     by any caller — it finishes plain `unknown`)

import { isStrictCalendarInstant } from "@companion/contracts";
import { z } from "zod";

/** Dedicated create MCP identity (never the readonly/reschedule entrypoint). */
export const CREATE_WRITE_MCP_NAME = "google-calendar-create" as const;
export const CREATE_WRITE_MCP_VERSION = "1.0.0-create.1" as const;
/** The ONLY tool on the dedicated create entrypoint. */
export const CREATE_WRITE_TOOL = "create-event" as const;
/** The Harness-side create tool name (title/start/end only). */
export const CALENDAR_CREATE_TOOL = "calendar.create" as const;

/** Strict RFC3339-with-offset instant (explicit offset, no bare dates). */
const IsoInstantSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(
    (value) => isStrictCalendarInstant(value),
    "start/end must be RFC3339 instants with an explicit offset",
  );

/** Immutable creation title: bounded, verbatim, no NUL/controls. */
const CreateTitleSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !value.includes("\0"), "title must not contain NUL")
  .refine((value) => {
    for (const unit of value) {
      const code = unit.codePointAt(0) ?? 0;
      if ((code >= 0x00 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f)) {
        return false;
      }
    }
    return true;
  }, "title must not contain control characters")
  .refine((value) => value.trim().length > 0, "title must not be blank");

/** Stable insert id: 32 lowercase hex from the execution UUID (no dashes). */
const StableEventIdSchema = z
  .string()
  .length(32)
  .regex(/^[0-9a-f]+$/, "stable event id must be 32 lowercase hex chars");

/**
 * Exact `create-event` MCP input: opaque host selection + the provider body
 * `{ id, summary, start, end }` ONLY. Unknown keys rejected; start < end.
 */
export const CreateWriteMcpInputSchema = z
  .strictObject({
    calendarId: z.string().min(1).max(512),
    account: z.string().min(1).max(512).optional(),
    id: StableEventIdSchema,
    summary: CreateTitleSchema,
    start: IsoInstantSchema,
    end: IsoInstantSchema,
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
export const CreateWriteOutcomePayloadSchema = z.union([
  z.strictObject({ status: z.literal("succeeded") }),
  z.strictObject({
    status: z.literal("definite_failure"),
    code: z.string().min(1).max(128),
  }),
]);

/** Minimal single-attempt MCP caller (implemented by `McpConnector`). */
export interface CreateWriteCaller {
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

/** Host-private create target (provider ids never leave the host store). */
export interface CreateWriteTarget {
  readonly calendarId: string;
  readonly account?: string;
}

/**
 * Structural request (EXACT kernel `CalendarCreateWriteRequest` shape: the
 * kernel owns that type and this package never imports `@companion/kernel`
 * to keep the M4 dependency direction intact — calendar/account selection
 * is TOP-LEVEL, never a nested `target`). A nested `target` from any caller
 * is a contract violation and fails closed below (never dispatched).
 */
export interface CreateWriteRequest {
  readonly grant: {
    readonly executionId: string;
    readonly proposalId: string;
    readonly proposalHash: string;
    readonly tool: "calendar.create";
    readonly inputHash: string;
    /** Always null for create (no source event, no etag). */
    readonly expectedRevision: null;
  };
  readonly connectorInstanceId: string;
  readonly tool: "calendar.create";
  readonly title: string;
  readonly start: string;
  readonly end: string;
  /** Stable insert id derived from the immutable execution id. */
  readonly stableEventId: string;
  /** Host-owned calendar/account selection, TOP-LEVEL (kernel shape). */
  readonly calendarId: string;
  readonly account?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

export type CreateWriteOutcome =
  | { readonly status: "succeeded" }
  | { readonly status: "definite_failure" }
  | { readonly status: "unknown" };

export interface CreateWritePort {
  readonly capability: {
    readonly tool: "calendar.create";
    readonly editableFields: readonly ["title", "start", "end"];
    readonly connectorInstanceId: string;
    readonly writeEnabled: true;
  };
  insert(
    request: CreateWriteRequest,
    signal?: AbortSignal,
  ): Promise<CreateWriteOutcome>;
}

export interface CreateCreateWritePortOptions {
  readonly connectorInstanceId: string;
  /** Dedicated create MCP caller (single `create-event` binding). */
  readonly caller: CreateWriteCaller;
  /** Exact configured upstream tool name (must be `create-event`). */
  readonly upstreamTool?: string;
}

/**
 * Create the dedicated Harness create port. Exactly one MCP call per insert;
 * no retry, no overwrite, no other fields. A throwing caller after the
 * committed marker maps to `unknown` (the strategy owns the marker; this
 * port only classifies its own single attempt).
 */
export function createCreateWritePort(
  options: CreateCreateWritePortOptions,
): CreateWritePort {
  const upstreamTool = options.upstreamTool ?? CREATE_WRITE_TOOL;
  if (upstreamTool !== CREATE_WRITE_TOOL) {
    throw new Error("create write binding must be create-event only");
  }
  const capability = {
    tool: CALENDAR_CREATE_TOOL,
    editableFields: ["title", "start", "end"] as const,
    connectorInstanceId: options.connectorInstanceId,
    writeEnabled: true as const,
  };

  async function insert(
    request: CreateWriteRequest,
    signal?: AbortSignal,
  ): Promise<CreateWriteOutcome> {
    // Exact binding: grant-bound tool + instance must match the capability,
    // and create grants never carry an expected revision. The selection is
    // the kernel's TOP-LEVEL calendarId/account (a nested `target` object is
    // a contract violation and fails closed with zero calls).
    const selection =
      typeof request.calendarId === "string" && request.calendarId.length > 0
        ? {
            calendarId: request.calendarId,
            ...(request.account !== undefined
              ? { account: request.account }
              : {}),
          }
        : null;
    if (
      request.tool !== CALENDAR_CREATE_TOOL ||
      request.connectorInstanceId !== options.connectorInstanceId ||
      request.grant.tool !== CALENDAR_CREATE_TOOL ||
      request.grant.expectedRevision !== null ||
      selection === null
    ) {
      return { status: "definite_failure" };
    }
    if (
      !/^[0-9a-f]{32}$/.test(request.stableEventId) ||
      request.title.length === 0
    ) {
      return { status: "definite_failure" };
    }
    const args = CreateWriteMcpInputSchema.safeParse({
      ...selection,
      id: request.stableEventId,
      summary: request.title,
      start: request.start,
      end: request.end,
    });
    if (!args.success) {
      return { status: "definite_failure" };
    }
    // THE single attempt (retry:false): `callTool` never auto-resends.
    // No redirect follow, no timeout resend, no 409 overwrite.
    let call: Awaited<ReturnType<CreateWriteCaller["callTool"]>>;
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
    // Strict classified payload only, structuredContent FIRST (same policy
    // as the reschedule port): a present value, even null/wrong-shaped, is
    // the ONLY source and is never rescued by text. Only when the property
    // is ABSENT is the ENTIRE text parsed as strict JSON. Anything
    // unparseable means the proof was lost in transit -> unknown (never
    // definite on loss, never a fallback claim).
    let payload: z.infer<typeof CreateWriteOutcomePayloadSchema>;
    if (Object.hasOwn(call, "structuredContent")) {
      try {
        payload = CreateWriteOutcomePayloadSchema.parse(call.structuredContent);
      } catch {
        return { status: "unknown" };
      }
    } else {
      try {
        const text = call.text ?? "";
        payload = CreateWriteOutcomePayloadSchema.parse(JSON.parse(text));
      } catch {
        return { status: "unknown" };
      }
    }
    if (payload.status === "succeeded") {
      return { status: "succeeded" };
    }
    return { status: "definite_failure" };
  }

  return { capability, insert };
}
