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
  "request_failed",
  "transport_error",
  "timeout",
] as const;

export type ModelLocalErrorCode = (typeof MODEL_LOCAL_ERROR_CODES)[number];

/** Typed gateway failure with a closed code; never holds secrets/bodies. */
export class ModelLocalError extends Error {
  readonly code: ModelLocalErrorCode;

  constructor(code: ModelLocalErrorCode, message: string) {
    super(message);
    this.name = "ModelLocalError";
    this.code = code;
  }
}
