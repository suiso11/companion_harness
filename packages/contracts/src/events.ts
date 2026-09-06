import { z } from "zod";
import { Sha256HexSchema, UnixMsSchema, UuidSchema } from "./ids.js";
import {
  M2_MODEL_STEP_EVENT_TYPES,
  ModelStepCompletedPayloadSchema,
  ModelStepFailedPayloadSchema,
  ModelStepStartedPayloadSchema,
} from "./model.js";
import { ReferencePresentedPayloadSchema } from "./references.js";
import { RunResultSchema, RunResultV1Schema } from "./run_result.js";
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

/**
 * Exact M0 `run.completed` payload: V1 RunResult only. Frozen: M0/M1
 * assertions pin this acceptance (V2 M2 rows are rejected here).
 */
export const M0RunCompletedPayloadSchema = z.strictObject({
  result: RunResultV1Schema,
});

/** Alias: M1 pins the same V1-only completed payload as M0. */
export const M1RunCompletedPayloadSchema = M0RunCompletedPayloadSchema;

/**
 * Latest (M2) `run.completed` payload: V1 historical rows plus V2 M2 rows
 * (durable StructuredAnswer persistence). Only `run.completed` carries a
 * RunResult; durable/API data retains citations while history prompts
 * project only the rendered text.
 */
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
  type: M0RunEventType | M1RunEventType | M2RunEventType,
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
const M0RunCompletedEventSchema = z.strictObject({
  ...EnvelopeBase,
  type: z.literal("run.completed"),
  payload: M0RunCompletedPayloadSchema,
});
/** M1 pins the same V1-only completed envelope as M0. */
const M1RunCompletedEventSchema = M0RunCompletedEventSchema;
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
  M0RunCompletedEventSchema,
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
  "run.completed": M0RunCompletedPayloadSchema,
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

/** Exact M1 RunEvent envelope registry (M0 nine + reference.presented). */
export const M1RunEventSchema = z.discriminatedUnion("type", [
  RunQueuedEventSchema,
  RunStartedEventSchema,
  RunCancelRequestedEventSchema,
  M1RunCompletedEventSchema,
  RunFailedEventSchema,
  RunCancelledEventSchema,
  RunAbandonedEventSchema,
  ToolRequestedEventSchema,
  ToolCompletedEventSchema,
  ReferencePresentedEventSchema,
]);
export type M1RunEvent = z.infer<typeof M1RunEventSchema>;

/**
 * Exact M1 per-type payload registry (M0 nine + reference.presented, with
 * `tool.completed` accepting the closed M0+M1 code union; `run.completed`
 * stays V1-only so M1 assertions pin M0/M1 compatibility).
 */
export const M1_RUN_EVENT_PAYLOAD_SCHEMAS = {
  ...RUN_EVENT_PAYLOAD_SCHEMAS,
  "run.completed": M1RunCompletedPayloadSchema,
  "tool.completed": ToolCompletedPayloadSchema,
  "reference.presented": ReferencePresentedPayloadSchema,
} as const;

/**
 * Exact M1 events page: same cursor semantics as the M0 page, but events
 * may include `reference.presented`. Rejects `model.step.*` (M2+).
 */
export const M1EventsResponseSchema = z.strictObject({
  events: z.array(M1RunEventSchema),
  nextAfter: z.number().int().min(0),
  hasMore: z.boolean(),
  terminal: z.boolean(),
});
export type M1EventsResponse = z.infer<typeof M1EventsResponseSchema>;

/* ------------------------------------------------------------------ */
/* M2: model.step.* (non-final extension, §15.10)                        */
/* ------------------------------------------------------------------ */

/**
 * M2 non-final extension events. `model.step.started` / `model.step.completed`
 * / `model.step.failed` are never terminal: exactly one terminal event still
 * closes each Run, and nothing may follow it. All three belong to the Agent
 * Run (never an Action Run). Payloads carry structural metadata only (step
 * ordinals, timings, token-count summaries, fixed redacted error codes) —
 * never prompts, raw model output, reasoning, secrets, or content.
 */
/** Latest (M2) event type list: the exact M1 ten plus the three model steps. */
export const M2_RUN_EVENT_TYPES = [
  ...M1_RUN_EVENT_TYPES,
  ...M2_MODEL_STEP_EVENT_TYPES,
] as const;
export type M2RunEventType = (typeof M2_RUN_EVENT_TYPES)[number];
export const M2RunEventTypeSchema = z.enum(M2_RUN_EVENT_TYPES);

/** Alias: M2 is the latest schema version served. */
export const LATEST_RUN_EVENT_TYPES = M2_RUN_EVENT_TYPES;
export type LatestRunEventType = M2RunEventType;
export const LatestRunEventTypeSchema = M2RunEventTypeSchema;

const ModelStepStartedEventSchema = z.strictObject({
  ...EnvelopeBase,
  type: z.literal("model.step.started"),
  payload: ModelStepStartedPayloadSchema,
});
const ModelStepCompletedEventSchema = z.strictObject({
  ...EnvelopeBase,
  type: z.literal("model.step.completed"),
  payload: ModelStepCompletedPayloadSchema,
});
const ModelStepFailedEventSchema = z.strictObject({
  ...EnvelopeBase,
  type: z.literal("model.step.failed"),
  payload: ModelStepFailedPayloadSchema,
});

/** Exact M2 RunEvent envelope registry (schemaVersion=1, 13 closed types). */
export const M2RunEventSchema = z.discriminatedUnion("type", [
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
  ModelStepStartedEventSchema,
  ModelStepCompletedEventSchema,
  ModelStepFailedEventSchema,
]);
export type M2RunEvent = z.infer<typeof M2RunEventSchema>;

/** Alias: M2 is the latest schema version served. */
export const LatestRunEventSchema = M2RunEventSchema;
export type LatestRunEvent = M2RunEvent;

/**
 * Latest (M2) per-type payload registry (M1 ten + the three model steps,
 * with `run.completed` accepting V1 historical rows and V2 M2 rows).
 */
export const M2_RUN_EVENT_PAYLOAD_SCHEMAS = {
  ...M1_RUN_EVENT_PAYLOAD_SCHEMAS,
  "run.completed": RunCompletedPayloadSchema,
  "model.step.started": ModelStepStartedPayloadSchema,
  "model.step.completed": ModelStepCompletedPayloadSchema,
  "model.step.failed": ModelStepFailedPayloadSchema,
} as const;

/** Alias: M2 is the latest schema version served. */
export const LATEST_RUN_EVENT_PAYLOAD_SCHEMAS = M2_RUN_EVENT_PAYLOAD_SCHEMAS;

/**
 * Latest (M2) events page: same cursor semantics as the M0/M1 pages, but
 * events may include `reference.presented` and `model.step.*`. The exact
 * M0 page (`M0EventsResponseSchema` in http.ts) and the exact M1 page
 * (`M1EventsResponseSchema` above) are untouched.
 */
export const M2EventsResponseSchema = z.strictObject({
  events: z.array(M2RunEventSchema),
  nextAfter: z.number().int().min(0),
  hasMore: z.boolean(),
  terminal: z.boolean(),
});
export type M2EventsResponse = z.infer<typeof M2EventsResponseSchema>;

/** Alias: M2 is the latest schema version served. */
export const LatestEventsResponseSchema = M2EventsResponseSchema;
export type LatestEventsResponse = M2EventsResponse;

/** Parse a full envelope with the latest registry (understands M2). */
export function parseRunEvent(data: unknown): LatestRunEvent {
  return LatestRunEventSchema.parse(data);
}

/** Parse a full envelope with the exact M2 registry (rejects M3+ names). */
export function parseM2RunEvent(data: unknown): M2RunEvent {
  return M2RunEventSchema.parse(data);
}

/** Parse a full envelope with the exact M1 registry (rejects M2+ types). */
export function parseM1RunEvent(data: unknown): M1RunEvent {
  return M1RunEventSchema.parse(data);
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

/** Parse a bare payload for a known M1 type (exact M1 registry). */
export function parseM1RunEventPayload<T extends M1RunEventType>(
  type: T,
  data: unknown,
): z.infer<(typeof M1_RUN_EVENT_PAYLOAD_SCHEMAS)[T]> {
  return (M1_RUN_EVENT_PAYLOAD_SCHEMAS[type] as z.ZodType).parse(
    data,
  ) as z.infer<(typeof M1_RUN_EVENT_PAYLOAD_SCHEMAS)[T]>;
}

/** Parse a bare payload for a known M2 type (exact M2 registry). */
export function parseM2RunEventPayload<T extends M2RunEventType>(
  type: T,
  data: unknown,
): z.infer<(typeof M2_RUN_EVENT_PAYLOAD_SCHEMAS)[T]> {
  return (M2_RUN_EVENT_PAYLOAD_SCHEMAS[type] as z.ZodType).parse(
    data,
  ) as z.infer<(typeof M2_RUN_EVENT_PAYLOAD_SCHEMAS)[T]>;
}

/** Parse a bare payload for a known latest (M2) type. */
export function parseRunEventPayload<T extends M2RunEventType>(
  type: T,
  data: unknown,
): z.infer<(typeof LATEST_RUN_EVENT_PAYLOAD_SCHEMAS)[T]> {
  return (LATEST_RUN_EVENT_PAYLOAD_SCHEMAS[type] as z.ZodType).parse(
    data,
  ) as z.infer<(typeof LATEST_RUN_EVENT_PAYLOAD_SCHEMAS)[T]>;
}
