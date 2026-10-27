// @companion/model-local — provider-neutral local model gateway errors.
//
// All failures surface as ModelLocalError with a closed, lowercase code
// vocabulary. Messages are fixed/generic: they never carry the auth token,
// the raw provider response/body, the prompt, or reasoning content.

export const MODEL_LOCAL_ERROR_CODES = [
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

export type ModelLocalErrorCode = (typeof MODEL_LOCAL_ERROR_CODES)[number];

/**
 * Fixed non-sensitive cause for `answer_invalid` normalization failures.
 * Mirrors the kernel/contract answer-invalid reason vocabulary for the two
 * provider-side branches; raw arguments/body never travel here.
 */
export const MODEL_LOCAL_ANSWER_INVALID_REASONS = [
  "model_args_malformed",
  "model_args_oversize",
] as const;
export type ModelLocalAnswerInvalidReason =
  (typeof MODEL_LOCAL_ANSWER_INVALID_REASONS)[number];

/**
 * Fixed, non-sensitive detail for `invalid_response`: lets diagnostics tell
 * an oversized body apart from malformed JSON without ever carrying bytes.
 */
export const MODEL_LOCAL_INVALID_RESPONSE_CAUSES = [
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
export type ModelLocalInvalidResponseCause =
  (typeof MODEL_LOCAL_INVALID_RESPONSE_CAUSES)[number];

/** Optional structural failure detail; never holds bodies or messages. */
export interface ModelLocalErrorDetails {
  readonly invalidResponseCause?: ModelLocalInvalidResponseCause;
  readonly httpStatus?: number;
}

/** Typed gateway failure with a closed code; never holds secrets/bodies. */
export class ModelLocalError extends Error {
  readonly code: ModelLocalErrorCode;
  /** Optional fixed cause code (only for answer_invalid today). */
  readonly reason: ModelLocalAnswerInvalidReason | undefined;
  /** Optional fixed invalid-response cause (oversize vs malformed JSON). */
  readonly invalidResponseCause: ModelLocalInvalidResponseCause | undefined;
  /** Optional HTTP status for `request_failed` (numeric, safe). */
  readonly httpStatus: number | undefined;

  constructor(
    code: ModelLocalErrorCode,
    message: string,
    reason?: ModelLocalAnswerInvalidReason,
    details?: ModelLocalErrorDetails,
  ) {
    super(message);
    this.name = "ModelLocalError";
    this.code = code;
    this.reason = reason;
    this.invalidResponseCause = details?.invalidResponseCause;
    this.httpStatus = details?.httpStatus;
  }
}
