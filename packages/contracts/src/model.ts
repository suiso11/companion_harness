import { z } from "zod";

/**
 * M2 model-step contracts (§15.5, §15.10): typed non-final audit events for
 * Agent Runs plus the fixed redacted model/answer error vocabulary.
 *
 * All payloads carry structural metadata only (step ordinals, timings,
 * token-count summaries, fixed error codes). Prompts, raw model output,
 * reasoning, secrets, and any content/body/snippet/title/path keys are
 * never present here; every payload schema is strict and rejects them.
 * Adapter / model identity lives in the `model_calls` audit table, not in
 * events. Current-run EvidenceGrant validation for citations belongs in
 * the kernel, not in contracts.
 */

/** Max model steps per Run (agreed budget §15.5, repair included). */
export const MAX_MODEL_STEPS_PER_RUN = 8 as const;

/** Exact M2 model-step event types (non-terminal, Agent Run only). */
export const M2_MODEL_STEP_EVENT_TYPES = [
  "model.step.started",
  "model.step.completed",
  "model.step.failed",
] as const;
export type M2ModelStepEventType = (typeof M2_MODEL_STEP_EVENT_TYPES)[number];
export const M2ModelStepEventTypeSchema = z.enum(M2_MODEL_STEP_EVENT_TYPES);

/**
 * Closed M2 model/answer error vocabulary (fixed lowercase redacted codes,
 * §15.10): `model_unavailable` (gateway cannot reach a model),
 * `model_step_timeout` (a single step exceeded its timeout), `answer_invalid`
 * (the submitted StructuredAnswer failed validation), `citation_invalid`
 * (a citation failed the structural grant gate). No raw errors, prompts,
 * reasoning, or free text are ever valid here. This family is disjoint from
 * the M0 Run codes and the M0+M1 tool codes; those registries are untouched.
 */
export const M2_MODEL_ERROR_CODES = [
  "model_unavailable",
  "model_step_timeout",
  "answer_invalid",
  "citation_invalid",
] as const;
export type M2ModelErrorCode = (typeof M2_MODEL_ERROR_CODES)[number];
export const M2ModelErrorCodeSchema = z.enum(M2_MODEL_ERROR_CODES);

/** Known M2 model error codes (alias of the closed M2 vocabulary). */
export const KNOWN_M2_MODEL_ERROR_CODES = M2_MODEL_ERROR_CODES;

/** Exact M2 schema-versioned model error-code registry (version 1 only). */
export const M2_MODEL_ERROR_CODE_REGISTRY = {
  1: M2ModelErrorCodeSchema,
} as const;
export type M2ModelErrorSchemaVersion =
  keyof typeof M2_MODEL_ERROR_CODE_REGISTRY;

/** Parse a model error code with the exact M2 registry. */
export function parseM2ModelErrorCode(data: unknown): M2ModelErrorCode {
  return M2_MODEL_ERROR_CODE_REGISTRY[1].parse(data);
}

/** 1-based model step ordinal within a Run (bounded by the step budget). */
export const ModelStepNumberSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_MODEL_STEPS_PER_RUN);
export type ModelStepNumber = z.infer<typeof ModelStepNumberSchema>;

/** Observed step wall time in milliseconds (structural metadata only). */
export const ModelStepDurationMsSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);
export type ModelStepDurationMs = z.infer<typeof ModelStepDurationMsSchema>;

/**
 * Optional provider usage summary (token counts only, when the provider
 * reports them). No prompts, completions, reasoning, or raw usage blobs.
 */
export const ModelStepUsageSchema = z.strictObject({
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
});
export type ModelStepUsage = z.infer<typeof ModelStepUsageSchema>;

/** `model.step.started` payload: step ordinal only. */
export const ModelStepStartedPayloadSchema = z.strictObject({
  step: ModelStepNumberSchema,
});
export type ModelStepStartedPayload = z.infer<
  typeof ModelStepStartedPayloadSchema
>;

/** `model.step.completed` payload: step ordinal + timing + optional usage. */
export const ModelStepCompletedPayloadSchema = z.strictObject({
  step: ModelStepNumberSchema,
  durationMs: ModelStepDurationMsSchema,
  usage: ModelStepUsageSchema.optional(),
});
export type ModelStepCompletedPayload = z.infer<
  typeof ModelStepCompletedPayloadSchema
>;

/**
 * `model.step.failed` payload: step ordinal + fixed redacted code.
 * `durationMs` is optional because a failure (e.g. `model_unavailable`)
 * may occur before any timing is observed.
 */
export const ModelStepFailedPayloadSchema = z.strictObject({
  step: ModelStepNumberSchema,
  errorCode: M2ModelErrorCodeSchema,
  durationMs: ModelStepDurationMsSchema.optional(),
});
export type ModelStepFailedPayload = z.infer<
  typeof ModelStepFailedPayloadSchema
>;
