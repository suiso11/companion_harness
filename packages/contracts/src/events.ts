import { z } from "zod";
import { Sha256HexSchema, UnixMsSchema, UuidSchema } from "./ids.js";
import { ReferencePresentedPayloadSchema } from "./references.js";
import { RunResultSchema } from "./run_result.js";
import {
  ActualOutcomeSchema,
  LatestToolErrorCodeSchema,
  M0ToolErrorCodeSchema,
  ReportedOutcomeSchema,
  ResultDispositionSchema,
  RunErrorCodeSchema,
  ToolNameSchema,
} from "./tools.js";

/** Envelope schema version. M0 serves version 1 only. */
export const RUN_EVENT_SCHEMA_VERSION = 1 as const;

const EnvelopeBase = {
  schemaVersion: z.literal(RUN_EVENT_SCHEMA_VERSION),
  runId: UuidSchema,
  seq: z.number().int().min(1),
  createdAt: UnixMsSchema,
} as const;

/**
 * Exact M0 event payloads. Only `run.completed` carries a RunResult; no
 * other event carries answer text. Audit payloads carry digests/codes only.
 *
 * AMBIGUITY: the plan fixes the M0 type list and the completed-only result
 * rule but leaves non-result payload fields implicit. Non-terminal payloads
 * below carry the minimal ids/counters needed for cursor/audit correlation;
 * `run.abandoned` carries the closed `cause` union (`restart_recovery` from
 * startup recovery, `drain` from graceful shutdown, §11.3/§11.5).
 */
export const RunQueuedPayloadSchema = z.strictObject({
  attempt: z.number().int().min(1),
});

export const RunStartedPayloadSchema = z.strictObject({
  attempt: z.number().int().min(1),
});

export const RunCancelRequestedPayloadSchema = z.strictObject({});

export const RunCompletedPayloadSchema = z.strictObject({
  result: RunResultSchema,
});

export const RunFailedPayloadSchema = z.strictObject({
  errorCode: RunErrorCodeSchema,
});

export const RunCancelledPayloadSchema = z.strictObject({});

export const RunAbandonedPayloadSchema = z.strictObject({
  cause: z.enum(["restart_recovery", "drain"]),
});

export const ToolRequestedPayloadSchema = z.strictObject({
  callId: UuidSchema,
  callIndex: z.number().int().min(1),
  tool: ToolNameSchema,
  argsHash: Sha256HexSchema,
});

/**
 * Exact M0 `tool.completed` payload: error codes limited to the M0 nine.
 * Used by the exact M0 envelope registry and M0 page only.
 */
export const M0ToolCompletedPayloadSchema = z.strictObject({
  callId: UuidSchema,
  callIndex: z.number().int().min(1),
  tool: ToolNameSchema,
  actualOutcome: ActualOutcomeSchema,
  reportedOutcome: ReportedOutcomeSchema.nullable(),
  disposition: ResultDispositionSchema,
  errorCode: M0ToolErrorCodeSchema.nullable(),
  resultDigest: Sha256HexSchema.nullable(),
  reusedFromCallId: UuidSchema.nullable(),
});

/**
 * Generic/latest `tool.completed` payload: accepts M0+M1 codes (closed
 * 14-code union). Used by the latest envelope registry.
 */
export const ToolCompletedPayloadSchema = z.strictObject({
  callId: UuidSchema,
  callIndex: z.number().int().min(1),
  tool: ToolNameSchema,
  actualOutcome: ActualOutcomeSchema,
  reportedOutcome: ReportedOutcomeSchema.nullable(),
  disposition: ResultDispositionSchema,
  errorCode: LatestToolErrorCodeSchema.nullable(),
  resultDigest: Sha256HexSchema.nullable(),
  reusedFromCallId: UuidSchema.nullable(),
});

/** Alias: M1/latest `tool.completed` payload (M0+M1 codes). */
export const M1ToolCompletedPayloadSchema = ToolCompletedPayloadSchema;
export const LatestToolCompletedPayloadSchema = ToolCompletedPayloadSchema;

/** Exact M0 event type list. No other type exists in M0. */
export const M0_RUN_EVENT_TYPES = [
  "run.queued",
  "run.started",
  "run.cancel_requested",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.abandoned",
  "tool.requested",
  "tool.completed",
] as const;
export type M0RunEventType = (typeof M0_RUN_EVENT_TYPES)[number];
export const M0RunEventTypeSchema = z.enum(M0_RUN_EVENT_TYPES);

/** Terminal event types: exactly one per Run, always final. */
export const TERMINAL_EVENT_TYPES = [
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.abandoned",
] as const;
export type TerminalEventType = (typeof TERMINAL_EVENT_TYPES)[number];
export const TerminalEventTypeSchema = z.enum(TERMINAL_EVENT_TYPES);

export function isTerminalEventType(
  type: M0RunEventType | M1RunEventType,
): type is TerminalEventType {
  return (TERMINAL_EVENT_TYPES as readonly string[]).includes(type);
}

const RunQueuedEventSchema = z.strictObject({
  ...EnvelopeBase,
  type: z.literal("run.queued"),
  payload: RunQueuedPayloadSchema,
});
const RunStartedEventSchema = z.strictObject({
  ...EnvelopeBase,
  type: z.literal("run.started"),
  payload: RunStartedPayloadSchema,
});
const RunCancelRequestedEventSchema = z.strictObject({
  ...EnvelopeBase,
  type: z.literal("run.cancel_requested"),
  payload: RunCancelRequestedPayloadSchema,
});
const RunCompletedEventSchema = z.strictObject({
  ...EnvelopeBase,
  type: z.literal("run.completed"),
  payload: RunCompletedPayloadSchema,
});
const RunFailedEventSchema = z.strictObject({
  ...EnvelopeBase,
  type: z.literal("run.failed"),
  payload: RunFailedPayloadSchema,
});
const RunCancelledEventSchema = z.strictObject({
  ...EnvelopeBase,
  type: z.literal("run.cancelled"),
  payload: RunCancelledPayloadSchema,
});
const RunAbandonedEventSchema = z.strictObject({
  ...EnvelopeBase,
  type: z.literal("run.abandoned"),
  payload: RunAbandonedPayloadSchema,
});
const ToolRequestedEventSchema = z.strictObject({
  ...EnvelopeBase,
  type: z.literal("tool.requested"),
  payload: ToolRequestedPayloadSchema,
});
/** Exact M0 `tool.completed` envelope (M0 nine codes only). */
const M0ToolCompletedEventSchema = z.strictObject({
  ...EnvelopeBase,
  type: z.literal("tool.completed"),
  payload: M0ToolCompletedPayloadSchema,
});

/** Latest (M0+M1) `tool.completed` envelope (closed 14-code union). */
const ToolCompletedEventSchema = z.strictObject({
  ...EnvelopeBase,
  type: z.literal("tool.completed"),
  payload: ToolCompletedPayloadSchema,
});

/** Closed M0 RunEvent envelope registry (schemaVersion=1, M0 codes only). */
export const RunEventSchema = z.discriminatedUnion("type", [
  RunQueuedEventSchema,
  RunStartedEventSchema,
  RunCancelRequestedEventSchema,
  RunCompletedEventSchema,
  RunFailedEventSchema,
  RunCancelledEventSchema,
  RunAbandonedEventSchema,
  ToolRequestedEventSchema,
  M0ToolCompletedEventSchema,
]);
export type RunEvent = z.infer<typeof RunEventSchema>;

/** Exact M0 per-type payload registry (M0 codes only). */
export const RUN_EVENT_PAYLOAD_SCHEMAS = {
  "run.queued": RunQueuedPayloadSchema,
  "run.started": RunStartedPayloadSchema,
  "run.cancel_requested": RunCancelRequestedPayloadSchema,
  "run.completed": RunCompletedPayloadSchema,
  "run.failed": RunFailedPayloadSchema,
  "run.cancelled": RunCancelledPayloadSchema,
  "run.abandoned": RunAbandonedPayloadSchema,
  "tool.requested": ToolRequestedPayloadSchema,
  "tool.completed": M0ToolCompletedPayloadSchema,
} as const;

/* ------------------------------------------------------------------ */
/* M1: reference.presented (non-final extension, §14.4)                  */
/* ------------------------------------------------------------------ */

/**
 * M1 non-final extension event. `reference.presented` is never terminal:
 * exactly one terminal event still closes each Run, and nothing may follow
 * it. The payload carries structural IDs/ordinals only (no snapshot body,
 * snippet, title, content, or path); see `ReferencePresentedPayloadSchema`.
 */
export const REFERENCE_PRESENTED_EVENT_TYPE = "reference.presented" as const;

/** Latest (M1) event type list: the exact M0 nine plus reference.presented. */
export const M1_RUN_EVENT_TYPES = [
  ...M0_RUN_EVENT_TYPES,
  REFERENCE_PRESENTED_EVENT_TYPE,
] as const;
export type M1RunEventType = (typeof M1_RUN_EVENT_TYPES)[number];
export const M1RunEventTypeSchema = z.enum(M1_RUN_EVENT_TYPES);

/** Alias: M1 is the latest schema version served. */
export const LATEST_RUN_EVENT_TYPES = M1_RUN_EVENT_TYPES;
export type LatestRunEventType = M1RunEventType;
export const LatestRunEventTypeSchema = M1RunEventTypeSchema;

const ReferencePresentedEventSchema = z.strictObject({
  ...EnvelopeBase,
  type: z.literal(REFERENCE_PRESENTED_EVENT_TYPE),
  payload: ReferencePresentedPayloadSchema,
});

/**
 * Exact M0 RunEvent envelope registry (schemaVersion=1, exactly 9 types,
 * M0 nine tool codes only). Retained verbatim for M0 assertions; rejects
 * `reference.presented`, M1 tool codes, and any M2+ names.
 */
export const M0RunEventSchema = RunEventSchema;
export type M0RunEvent = RunEvent;

/** Latest RunEvent envelope registry (schemaVersion=1, M0 nine + M1 one). */
export const LatestRunEventSchema = z.discriminatedUnion("type", [
  RunQueuedEventSchema,
  RunStartedEventSchema,
  RunCancelRequestedEventSchema,
  RunCompletedEventSchema,
  RunFailedEventSchema,
  RunCancelledEventSchema,
  RunAbandonedEventSchema,
  ToolRequestedEventSchema,
  ToolCompletedEventSchema,
  ReferencePresentedEventSchema,
]);
export type LatestRunEvent = z.infer<typeof LatestRunEventSchema>;

/** Alias: M1 is the latest schema version served. */
export const M1RunEventSchema = LatestRunEventSchema;
export type M1RunEvent = LatestRunEvent;

/**
 * Latest per-type payload registry (M0 nine + reference.presented, with
 * `tool.completed` accepting the closed M0+M1 code union).
 */
export const LATEST_RUN_EVENT_PAYLOAD_SCHEMAS = {
  ...RUN_EVENT_PAYLOAD_SCHEMAS,
  "tool.completed": ToolCompletedPayloadSchema,
  "reference.presented": ReferencePresentedPayloadSchema,
} as const;

/** Alias: M1 is the latest schema version served. */
export const M1_RUN_EVENT_PAYLOAD_SCHEMAS = LATEST_RUN_EVENT_PAYLOAD_SCHEMAS;

/**
 * Latest events page: same cursor semantics as the M0 page, but events may
 * include `reference.presented`. The exact M0 page (`EventsResponseSchema`
 * in http.ts) is untouched.
 */
export const LatestEventsResponseSchema = z.strictObject({
  events: z.array(LatestRunEventSchema),
  nextAfter: z.number().int().min(0),
  hasMore: z.boolean(),
  terminal: z.boolean(),
});
export type LatestEventsResponse = z.infer<typeof LatestEventsResponseSchema>;

/** Parse a full envelope with the latest registry (understands M1). */
export function parseRunEvent(data: unknown): LatestRunEvent {
  return LatestRunEventSchema.parse(data);
}

/** Parse a full envelope with the exact M0 registry (rejects M1+ types). */
export function parseM0RunEvent(data: unknown): RunEvent {
  return M0RunEventSchema.parse(data);
}

/** Parse a bare payload for a known M0 type (exact M0 registry). */
export function parseM0RunEventPayload<T extends M0RunEventType>(
  type: T,
  data: unknown,
): z.infer<(typeof RUN_EVENT_PAYLOAD_SCHEMAS)[T]> {
  return (RUN_EVENT_PAYLOAD_SCHEMAS[type] as z.ZodType).parse(data) as z.infer<
    (typeof RUN_EVENT_PAYLOAD_SCHEMAS)[T]
  >;
}

/** Parse a bare payload for a known latest (M0+M1) type. */
export function parseRunEventPayload<T extends M1RunEventType>(
  type: T,
  data: unknown,
): z.infer<(typeof LATEST_RUN_EVENT_PAYLOAD_SCHEMAS)[T]> {
  return (LATEST_RUN_EVENT_PAYLOAD_SCHEMAS[type] as z.ZodType).parse(
    data,
  ) as z.infer<(typeof LATEST_RUN_EVENT_PAYLOAD_SCHEMAS)[T]>;
}
