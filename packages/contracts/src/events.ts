import { z } from "zod";
import { Sha256HexSchema, UnixMsSchema, UuidSchema } from "./ids.js";
import { RunResultSchema } from "./run_result.js";
import {
  ActualOutcomeSchema,
  ReportedOutcomeSchema,
  ResultDispositionSchema,
  RunErrorCodeSchema,
  ToolErrorCodeSchema,
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

export const ToolCompletedPayloadSchema = z.strictObject({
  callId: UuidSchema,
  callIndex: z.number().int().min(1),
  tool: ToolNameSchema,
  actualOutcome: ActualOutcomeSchema,
  reportedOutcome: ReportedOutcomeSchema.nullable(),
  disposition: ResultDispositionSchema,
  errorCode: ToolErrorCodeSchema.nullable(),
  resultDigest: Sha256HexSchema.nullable(),
  reusedFromCallId: UuidSchema.nullable(),
});

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
  type: M0RunEventType,
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
const ToolCompletedEventSchema = z.strictObject({
  ...EnvelopeBase,
  type: z.literal("tool.completed"),
  payload: ToolCompletedPayloadSchema,
});

/** Closed M0 RunEvent envelope registry (schemaVersion=1). */
export const RunEventSchema = z.discriminatedUnion("type", [
  RunQueuedEventSchema,
  RunStartedEventSchema,
  RunCancelRequestedEventSchema,
  RunCompletedEventSchema,
  RunFailedEventSchema,
  RunCancelledEventSchema,
  RunAbandonedEventSchema,
  ToolRequestedEventSchema,
  ToolCompletedEventSchema,
]);
export type RunEvent = z.infer<typeof RunEventSchema>;

/** Per-type payload registry for targeted validation. */
export const RUN_EVENT_PAYLOAD_SCHEMAS = {
  "run.queued": RunQueuedPayloadSchema,
  "run.started": RunStartedPayloadSchema,
  "run.cancel_requested": RunCancelRequestedPayloadSchema,
  "run.completed": RunCompletedPayloadSchema,
  "run.failed": RunFailedPayloadSchema,
  "run.cancelled": RunCancelledPayloadSchema,
  "run.abandoned": RunAbandonedPayloadSchema,
  "tool.requested": ToolRequestedPayloadSchema,
  "tool.completed": ToolCompletedPayloadSchema,
} as const;

/** Parse a full envelope; rejects unknown types (incl. M2+/M3 names). */
export function parseRunEvent(data: unknown): RunEvent {
  return RunEventSchema.parse(data);
}

/** Parse a bare payload for a known M0 type. */
export function parseRunEventPayload<T extends M0RunEventType>(
  type: T,
  data: unknown,
): z.infer<(typeof RUN_EVENT_PAYLOAD_SCHEMAS)[T]> {
  return (RUN_EVENT_PAYLOAD_SCHEMAS[type] as z.ZodType).parse(data) as z.infer<
    (typeof RUN_EVENT_PAYLOAD_SCHEMAS)[T]
  >;
}
