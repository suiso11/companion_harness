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

/** Typed gateway failure with a closed code; never holds secrets/bodies. */
export class ModelLocalError extends Error {
  readonly code: ModelLocalErrorCode;
  /** Optional fixed cause code (only for answer_invalid today). */
  readonly reason: ModelLocalAnswerInvalidReason | undefined;

  constructor(
    code: ModelLocalErrorCode,
    message: string,
    reason?: ModelLocalAnswerInvalidReason,
  ) {
    super(message);
    this.name = "ModelLocalError";
    this.code = code;
    this.reason = reason;
  }
}
