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

/**
 * Closed, non-sensitive cause vocabulary for `answer_invalid` (and the
 * repair-exhausted terminal failure). Every value is a fixed literal (or a
 * bounded `parse:<zod issue>@<path>` form); model text, arguments values,
 * provider bodies, titles, and paths never enter this field.
 */
export const ANSWER_INVALID_REASON_CODES = [
  "model_args_malformed",
  "model_args_oversize",
  "version_invalid",
  "mixed_tool_calls",
  "duplicate_answer",
  "reserved_namespace",
  "free_text",
  "citation_not_granted",
  "output_truncated",
  "other",
] as const;
export type AnswerInvalidReasonCode =
  (typeof ANSWER_INVALID_REASON_CODES)[number];

/** Allowlisted zod issue codes that may appear in a parse reason. */
export const ANSWER_INVALID_PARSE_ISSUE_CODES = [
  "invalid_type",
  "too_big",
  "too_small",
  "invalid_literal",
  "invalid_union",
  "invalid_format",
  "unrecognized_keys",
  "custom",
] as const;
export type AnswerInvalidParseIssueCode =
  (typeof ANSWER_INVALID_PARSE_ISSUE_CODES)[number];

/**
 * A fixed parse reason. The path is limited to schema keys / array indices
 * (joined with `.`) and the root sentinel `answer`, so a model-authored key
 * can never be echoed into observability.
 */
export type AnswerInvalidReason =
  | AnswerInvalidReasonCode
  | `parse:${AnswerInvalidParseIssueCode}@${string}`;

const ANSWER_INVALID_PARSE_REASON_REGEX = new RegExp(
  `^parse:(?:${ANSWER_INVALID_PARSE_ISSUE_CODES.join("|")})@` +
    `(?:version|parts|text|citations|answer|\\d{1,3})` +
    `(?:\\.(?:version|parts|text|citations|answer|\\d{1,3}))*$`,
);
export const ANSWER_INVALID_REASON_REGEX = new RegExp(
  `^(?:${ANSWER_INVALID_REASON_CODES.join("|")}|` +
    `${ANSWER_INVALID_PARSE_REASON_REGEX.source.slice(1, -1)})$`,
);

/** Fixed reason code, bounded to 64 chars including a fixed parse path. */
export const AnswerInvalidReasonSchema = z
  .string()
  .max(64)
  .refine((value): value is AnswerInvalidReason =>
    ANSWER_INVALID_REASON_REGEX.test(value),
  );

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
 * reports them). Counts are nonnegative safe integers; unsafe values
 * (fractions, negatives, or above MAX_SAFE_INTEGER, including JSON-rounded
 * values) are rejected, never coerced, clamped, or rounded. No prompts,
 * completions, reasoning, or raw usage blobs.
 */
export const ModelStepUsageSchema = z.strictObject({
  inputTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  outputTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
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
 * Closed gateway (model-local) error vocabulary retained as safe diagnostic
 * detail beside the unchanged public M2 code. Mirrors the provider-neutral
 * `@companion/model-local` code list; every value is a fixed literal, so no
 * raw provider text, body, header, prompt, or reasoning can travel here.
 */
export const MODEL_GATEWAY_ERROR_CODES = [
  "invalid_base_url",
  "unsupported_capability",
  "invalid_request",
  "invalid_response",
  "tool_call_invalid",
  "answer_invalid",
  "request_failed",
  "transport_error",
  "timeout",
] as const;
export type ModelGatewayErrorCode = (typeof MODEL_GATEWAY_ERROR_CODES)[number];
export const ModelGatewayErrorCodeSchema = z.enum(MODEL_GATEWAY_ERROR_CODES);

/** Closed `invalid_response` cause vocabulary (no bytes are ever included). */
export const MODEL_INVALID_RESPONSE_CAUSES = [
  "response_too_large",
  "malformed_json",
  "sse_line_invalid",
  "chunk_shape_invalid",
  "content_too_long",
  "tool_call_shape_invalid",
  "tool_call_arguments_too_large",
  "stream_incomplete",
  "trailing_data",
  "unexpected_content_type",
  "response_shape_invalid",
  "result_shape_invalid",
  "usage_invalid",
  "encoding_invalid",
  "connection_refused",
  "connection_reset",
  "connection_closed",
] as const;
export type ModelInvalidResponseCause =
  (typeof MODEL_INVALID_RESPONSE_CAUSES)[number];
export const ModelInvalidResponseCauseSchema = z.enum(
  MODEL_INVALID_RESPONSE_CAUSES,
);

/**
 * `model.step.failed` payload: step ordinal + fixed redacted code.
 * `durationMs` is optional because a failure (e.g. `model_unavailable`)
 * may occur before any timing is observed.
 */
export const ModelStepFailedPayloadSchema = z.strictObject({
  step: ModelStepNumberSchema,
  errorCode: M2ModelErrorCodeSchema,
  durationMs: ModelStepDurationMsSchema.optional(),
  /** Additive optional cause for answer/citation failures (fixed codes). */
  reason: AnswerInvalidReasonSchema.optional(),
  /** Additive safe gateway code beside the public M2 code (fixed enum). */
  gatewayErrorCode: ModelGatewayErrorCodeSchema.optional(),
  /** Additive fixed invalid-response cause (oversize vs malformed JSON). */
  invalidResponseCause: ModelInvalidResponseCauseSchema.optional(),
  /** Additive numeric HTTP status for a request failure (no body/header). */
  httpStatus: z.number().int().min(100).max(599).optional(),
});
export type ModelStepFailedPayload = z.infer<
  typeof ModelStepFailedPayloadSchema
>;
