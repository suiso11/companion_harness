// Provider-neutral ModelGateway contract plus shared request plumbing.
//
// Guarantees: loopback-only HTTP endpoints (see base_url.ts; `localhost`
// is pinned to literal `127.0.0.1` at parse time with no DNS lookup),
// per-request revalidation of the concrete fetch URL immediately before
// fetch (literal `127.0.0.1`/`::1` only, so mutated or unpinned targets
// never reach fetch), fetch with `redirect: "error"` (no redirect following), single attempt (no retry,
// no fallback, no router), and redacted failures (no auth token, raw
// response/body, prompt, or reasoning in any error).

import { assertPinnedLoopbackFetchUrl, normalizeLoopbackBaseUrl } from "./base_url.js";
import { ModelLocalError } from "./errors.js";
import type {
  ChatMessage,
  ChatRequest,
  ChatResult,
  FetchImpl,
  GatewayOptions,
  ModelCapabilities,
  ToolDefinition,
} from "./types.js";

/** Provider-neutral local model gateway. */
export interface ModelGateway {
  readonly provider: "ollama" | "openai-compatible";
  readonly capabilities: ModelCapabilities;
  /** Normalized endpoint URL (no trailing slash, path prefix included). */
  readonly baseUrl: string;
  /** Full chat-completions-style endpoint URL actually POSTed to. */
  readonly chatUrl: string;
  /**
   * Single chat attempt (no retry). The optional `signal` aborts the
   * underlying fetch when present; gateways must forward it. Omitting the
   * argument preserves backward compatibility.
   */
  chat(
    request: ChatRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ChatResult>;
}

/** Maximum sizes accepted on gateway inputs (generic, prompt-safe). */
export const MAX_MODEL_NAME_LENGTH = 256;
/**
 * Maximum accepted chat message content length (65_536 chars == 64KiB).
 * Aligned with the kernel per-call model-facing output budget so a legal
 * <=64KiB tool result is never rejected by a lower arbitrary message cap.
 */
export const MAX_MESSAGE_CONTENT_LENGTH = 65_536;
export const MAX_MESSAGES_PER_REQUEST = 128;
export const MAX_TOOLS_PER_REQUEST = 32;
/**
 * Maximum provider HTTP response body accepted by `postJsonNoRedirect`
 * (1 MiB, counted in UTF-8 bytes, not JS string characters).
 *
 * Both success and non-2xx bodies share this bound: an oversized
 * `Content-Length` is rejected before reading, otherwise the body stream
 * is read up to `MAX_RESPONSE_BYTES + 1` bytes (catching absent or
 * dishonest lengths) and the reader is cancelled on overflow. Only bytes
 * within the bound are decoded and `JSON.parse`d. Failures use fixed
 * redacted messages (no body, URL, apiKey, or prompt).
 */
export const MAX_RESPONSE_BYTES = 1_048_576;
/** Maximum prior native tool calls carried on one assistant message. */
export const MAX_TOOL_CALLS_PER_MESSAGE = 32;
/** Maximum tool-call id/name lengths for history validation. */
export const MAX_TOOL_CALL_ID_LENGTH = 256;
export const MAX_TOOL_CALL_NAME_LENGTH = 128;

/**
 * Validate advertised capabilities against a request: tools require
 * native tool calling. Throws `unsupported_capability`.
 */
export function assertToolCallingCapability(
  capabilities: ModelCapabilities,
  tools: readonly ToolDefinition[] | undefined,
): void {
  if (tools !== undefined && tools.length > 0 && !capabilities.toolCalling) {
    throw new ModelLocalError(
      "unsupported_capability",
      "model does not support native tool calling",
    );
  }
}

/** Validate a gateway chat request (generic messages, no prompt echo). */
export function validateChatRequest(request: ChatRequest): void {
  if (typeof request !== "object" || request === null) {
    throw new ModelLocalError("invalid_request", "model request is invalid");
  }
  if (
    typeof request.model !== "string" ||
    request.model.length === 0 ||
    request.model.length > MAX_MODEL_NAME_LENGTH
  ) {
    throw new ModelLocalError(
      "invalid_request",
      "model request carries an invalid model name",
    );
  }
  if (
    !Array.isArray(request.messages) ||
    request.messages.length === 0 ||
    request.messages.length > MAX_MESSAGES_PER_REQUEST
  ) {
    throw new ModelLocalError(
      "invalid_request",
      "model request must carry at least one message",
    );
  }
  for (const message of request.messages) {
    validateChatMessage(message);
  }
  if (request.tools !== undefined) {
    validateToolDefinitions(request.tools);
  }
}

function validateChatMessage(message: ChatMessage): void {
  if (typeof message !== "object" || message === null) {
    throw new ModelLocalError("invalid_request", "model message is invalid");
  }
  if (
    message.role !== "system" &&
    message.role !== "user" &&
    message.role !== "assistant" &&
    message.role !== "tool"
  ) {
    throw new ModelLocalError(
      "invalid_request",
      "model message carries an invalid role",
    );
  }
  if (
    typeof message.content !== "string" ||
    message.content.length > MAX_MESSAGE_CONTENT_LENGTH
  ) {
    throw new ModelLocalError(
      "invalid_request",
      "model message carries invalid content",
    );
  }
  if (
    message.toolCallId !== undefined &&
    (typeof message.toolCallId !== "string" ||
      message.toolCallId.length === 0 ||
      message.toolCallId.length > MAX_TOOL_CALL_ID_LENGTH)
  ) {
    throw new ModelLocalError(
      "invalid_request",
      "model message carries an invalid tool call id",
    );
  }
  if (
    message.toolName !== undefined &&
    (typeof message.toolName !== "string" ||
      message.toolName.length === 0 ||
      message.toolName.length > MAX_TOOL_CALL_NAME_LENGTH)
  ) {
    throw new ModelLocalError(
      "invalid_request",
      "model message carries an invalid tool name",
    );
  }
  if (message.toolName !== undefined && message.role !== "tool") {
    throw new ModelLocalError(
      "invalid_request",
      "model message carries a tool name on a non-tool role",
    );
  }
  validateHistoryToolCalls(message);
}

function validateHistoryToolCalls(message: ChatMessage): void {
  if (message.toolCalls === undefined) {
    return;
  }
  if (message.role !== "assistant") {
    throw new ModelLocalError(
      "invalid_request",
      "model message carries tool calls on a non-assistant role",
    );
  }
  if (
    !Array.isArray(message.toolCalls) ||
    message.toolCalls.length > MAX_TOOL_CALLS_PER_MESSAGE
  ) {
    throw new ModelLocalError(
      "invalid_request",
      "model message carries invalid tool calls",
    );
  }
  for (const call of message.toolCalls) {
    if (
      typeof call !== "object" ||
      call === null ||
      typeof (call as { id?: unknown }).id !== "string" ||
      (call as { id: string }).id.length === 0 ||
      (call as { id: string }).id.length > MAX_TOOL_CALL_ID_LENGTH ||
      typeof (call as { name?: unknown }).name !== "string" ||
      (call as { name: string }).name.length === 0 ||
      (call as { name: string }).name.length > MAX_TOOL_CALL_NAME_LENGTH ||
      !isRecord((call as { arguments?: unknown }).arguments)
    ) {
      throw new ModelLocalError(
        "invalid_request",
        "model message carries invalid tool calls",
      );
    }
  }
}

function validateToolDefinitions(tools: ToolDefinition[]): void {
  if (tools.length > MAX_TOOLS_PER_REQUEST) {
    throw new ModelLocalError(
      "invalid_request",
      "model request carries too many tools",
    );
  }
  const seen = new Set<string>();
  for (const tool of tools) {
    if (
      typeof tool !== "object" ||
      tool === null ||
      typeof tool.name !== "string" ||
      tool.name.length === 0 ||
      tool.name.length > 128 ||
      typeof tool.description !== "string" ||
      tool.description.length === 0 ||
      tool.description.length > 1024
    ) {
      throw new ModelLocalError(
        "invalid_request",
        "model request carries an invalid tool definition",
      );
    }
    if (seen.has(tool.name)) {
      throw new ModelLocalError(
        "invalid_request",
        "model request carries duplicate tool names",
      );
    }
    seen.add(tool.name);
    if (
      tool.parameters !== undefined &&
      (typeof tool.parameters !== "object" ||
        tool.parameters === null ||
        Array.isArray(tool.parameters))
    ) {
      throw new ModelLocalError(
        "invalid_request",
        "model request carries an invalid tool schema",
      );
    }
  }
}

export interface ResolvedGatewayConfig {
  baseUrl: string;
  fetchImpl: FetchImpl;
  apiKey: string | undefined;
  timeoutMs: number | undefined;
}

/** Validate gateway options: loopback base URL, fetch impl, timeout. */
export function resolveGatewayConfig(
  options: GatewayOptions,
): ResolvedGatewayConfig {
  if (typeof options !== "object" || options === null) {
    throw new ModelLocalError("invalid_request", "model options are invalid");
  }
  const baseUrl = normalizeLoopbackBaseUrl(options.baseUrl);
  let fetchImpl = options.fetchImpl;
  if (fetchImpl === undefined) {
    const globalFetch = (globalThis as { fetch?: FetchImpl }).fetch;
    if (typeof globalFetch !== "function") {
      throw new ModelLocalError(
        "transport_error",
        "model transport is unavailable",
      );
    }
    fetchImpl = globalFetch.bind(globalThis);
  }
  if (
    options.apiKey !== undefined &&
    (typeof options.apiKey !== "string" || options.apiKey.length === 0)
  ) {
    throw new ModelLocalError("invalid_request", "model auth is invalid");
  }
  if (
    options.timeoutMs !== undefined &&
    (!Number.isInteger(options.timeoutMs) ||
      options.timeoutMs < 1 ||
      options.timeoutMs > 120_000)
  ) {
    throw new ModelLocalError("invalid_request", "model timeout is invalid");
  }
  return {
    baseUrl,
    fetchImpl,
    apiKey: options.apiKey,
    timeoutMs: options.timeoutMs,
  };
}

/**
 * POST a JSON body with `redirect: "error"` (redirects rejected, never
 * followed) exactly once (no retry). Returns the parsed JSON body.
 * All failures are redacted ModelLocalError instances, except external
 * cancellation: when `signal` aborts, the original abort rejection is
 * rethrown untouched so callers can distinguish cancellation from a
 * transport timeout. The signal actually aborts the underlying fetch
 * (not a Promise.race alone) and is composed with the optional
 * single-attempt transport `timeoutMs` guard, which also covers bounded
 * body reading. Response bodies are bounded by `MAX_RESPONSE_BYTES`
 * (byte length, never `response.json()` on unbounded data); see the
 * constant for the exact reader behavior.
 */
export async function postJsonNoRedirect(options: {
  fetchImpl: FetchImpl;
  url: string;
  body: unknown;
  apiKey: string | undefined;
  timeoutMs: number | undefined;
  signal?: AbortSignal;
}): Promise<unknown> {
  // Revalidate the concrete fetch target immediately before use: construction-
  // time validation alone leaves a bypass window if the stored URL is mutated
  // or joined incorrectly. Only literal loopback (no `localhost`) passes, so
  // no DNS lookup occurs here and no rebinding/hosts-file name reaches fetch.
  const safeUrl = assertPinnedLoopbackFetchUrl(options.url);
  const externalSignal = options.signal;
  if (isAborted(externalSignal)) {
    throw toAbortRejection(externalSignal as AbortSignal);
  }
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (options.apiKey !== undefined) {
    headers.authorization = `Bearer ${options.apiKey}`;
  }
  const controller = new AbortController();
  const onExternalAbort = (): void => controller.abort();
  if (externalSignal !== undefined) {
    externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (options.timeoutMs !== undefined) {
    timer = setTimeout(() => controller.abort(), options.timeoutMs);
  }
  let response: Response;
  try {
    try {
      response = await options.fetchImpl(safeUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(options.body),
        redirect: "error",
        signal: controller.signal,
      });
    } catch (error) {
      if (isAborted(externalSignal)) {
        // External cancellation: preserve the abort rejection (no timeout
        // mapping, no double classification, no raw detail added).
        throw error;
      }
      throw mapFetchRejection(error);
    }
    // Bound the response body before JSON parsing (success and error
    // statuses share the bound; `response.json()` is never called on
    // unbounded data). An oversized declared `Content-Length` is rejected
    // before reading; otherwise the stream is read up to
    // `MAX_RESPONSE_BYTES + 1` bytes so absent or dishonest lengths are
    // still caught, and the reader is cancelled on overflow. Only bytes
    // within the bound are decoded and parsed. Errors are fixed redacted
    // messages (no body, URL, apiKey, or prompt).
    const requestFailed = (status: number): ModelLocalError =>
      new ModelLocalError(
        "request_failed",
        `model request failed with status ${status}`,
      );
    const declared = parseDeclaredContentLength(response);
    if (declared !== undefined && declared > MAX_RESPONSE_BYTES) {
      await cancelResponseBody(response);
      if (!response.ok) {
        throw requestFailed(response.status);
      }
      throw new ModelLocalError(
        "invalid_response",
        "model returned an oversized response",
      );
    }
    if (!response.ok) {
      // Drain the error body within the same bound (absent/dishonest
      // lengths included) so a huge error payload cannot exhaust memory,
      // then report only the fixed status failure.
      await readBoundedBodyText(response, controller, externalSignal, {
        tooLarge: () => requestFailed(response.status),
        failed: () => requestFailed(response.status),
      });
      throw requestFailed(response.status);
    }
    const text = await readBoundedBodyText(
      response,
      controller,
      externalSignal,
      {
        tooLarge: () =>
          new ModelLocalError(
            "invalid_response",
            "model returned an oversized response",
          ),
        failed: () =>
          new ModelLocalError(
            "invalid_response",
            "model returned an invalid response",
          ),
      },
    );
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ModelLocalError(
        "invalid_response",
        "model returned an invalid response",
      );
    }
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (externalSignal !== undefined) {
      externalSignal.removeEventListener("abort", onExternalAbort);
    }
  }
}

/**
 * Minimal body-reader shape (avoids naming stream lib types directly).
 * `Uint8Array` chunk reads mirror `ReadableStreamDefaultReader.read()`.
 */
interface BoundedBodyReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<void>;
  releaseLock(): void;
}

/** Parse a `Content-Length` header to a safe byte count, if well-formed. */
function parseDeclaredContentLength(response: Response): number | undefined {
  const raw = response.headers.get("content-length");
  if (raw === null) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return undefined;
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < 0) {
    return undefined;
  }
  return value;
}

/** Best-effort release of an unread/rejected response stream. */
async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best effort: the fixed redacted error below carries no detail.
  }
}

/**
 * Read at most `MAX_RESPONSE_BYTES + 1` UTF-8 bytes from the response
 * stream, cancel the reader on overflow, and decode only bytes within the
 * bound (chunks are merged before a single `TextDecoder` pass so multibyte
 * characters split across chunks survive). Byte length
 * (`Uint8Array.byteLength`) is enforced, never JS string length.
 * Aborting `controller` (external signal or timeout guard) cancels the
 * reader; external cancellation rethrows the original abort rejection
 * while timeout-guard aborts map to `timeout`. Other stream failures and
 * overflows use the caller-supplied redacted factories. The reader lock is
 * always released and the abort listener removed.
 */
async function readBoundedBodyText(
  response: Response,
  controller: AbortController,
  externalSignal: AbortSignal | undefined,
  failures: {
    tooLarge: () => ModelLocalError;
    failed: () => ModelLocalError;
  },
): Promise<string> {
  if (isAborted(externalSignal)) {
    throw toAbortRejection(externalSignal as AbortSignal);
  }
  const stream = response.body;
  if (stream === null) {
    return "";
  }
  const reader: BoundedBodyReader = stream.getReader();
  const onControllerAbort = (): void => {
    try {
      void reader.cancel(
        new DOMException("The operation was aborted.", "AbortError"),
      );
    } catch {
      // Best effort: the abort mapping below reports the outcome.
    }
  };
  controller.signal.addEventListener("abort", onControllerAbort, {
    once: true,
  });
  try {
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    for (;;) {
      let next: { done: boolean; value?: Uint8Array };
      try {
        next = await reader.read();
      } catch {
        if (isAborted(externalSignal)) {
          throw toAbortRejection(externalSignal as AbortSignal);
        }
        if (controller.signal.aborted) {
          throw new ModelLocalError("timeout", "model request timed out");
        }
        throw failures.failed();
      }
      if (next.done) {
        break;
      }
      const value: Uint8Array | undefined = next.value;
      if (value === undefined) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        try {
          await reader.cancel(
            new DOMException("Response body exceeds limit.", "AbortError"),
          );
        } catch {
          // Best effort: the redacted overflow error below is authoritative.
        }
        throw failures.tooLarge();
      }
      chunks.push(value);
    }
    if (isAborted(externalSignal)) {
      throw toAbortRejection(externalSignal as AbortSignal);
    }
    const merged = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(merged);
  } finally {
    controller.signal.removeEventListener("abort", onControllerAbort);
    try {
      reader.releaseLock();
    } catch {
      // Best effort: the stream is already cancelled or consumed.
    }
  }
}

/** Preserve (or synthesize) the external abort rejection for cancellation. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** Preserve (or synthesize) the external abort rejection for cancellation. */
function toAbortRejection(signal: AbortSignal): unknown {
  const reason = (signal as { reason?: unknown }).reason;
  if (reason instanceof Error) {
    return reason;
  }
  if (reason !== undefined && reason !== null) {
    return reason;
  }
  return new DOMException("The operation was aborted.", "AbortError");
}

/** Map fetch rejections to redacted codes (redirects are never followed). */
function mapFetchRejection(error: unknown): ModelLocalError {
  if (error instanceof ModelLocalError) {
    return error;
  }
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("redirect")) {
    return new ModelLocalError(
      "request_failed",
      "model request was redirected; redirects are not allowed",
    );
  }
  if (error instanceof Error && error.name === "AbortError") {
    // The only AbortController in this module is the single-attempt
    // timeout guard, so an abort here means the step timed out (fixed
    // safe code, no raw detail echoed).
    return new ModelLocalError("timeout", "model request timed out");
  }
  return new ModelLocalError("transport_error", "model transport failed");
}

/**
 * Enforce strict native tool-call results: unsolicited calls or calls to
 * unknown tools are rejected (no free-text JSON emulation is performed
 * anywhere; content text is never parsed for tool calls).
 */
export function validateNativeToolCalls(options: {
  toolCalls: { id: string; name: string; arguments: unknown }[];
  requestedTools: readonly ToolDefinition[] | undefined;
}): void {
  if (options.toolCalls.length === 0) {
    return;
  }
  if (
    options.requestedTools === undefined ||
    options.requestedTools.length === 0
  ) {
    throw new ModelLocalError(
      "tool_call_invalid",
      "model returned tool calls without tools requested",
    );
  }
  const known = new Set(options.requestedTools.map((tool) => tool.name));
  for (const call of options.toolCalls) {
    if (!known.has(call.name)) {
      throw new ModelLocalError(
        "tool_call_invalid",
        "model requested an unknown tool",
      );
    }
  }
}

/** Plain-object guard for provider payloads. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Join a normalized loopback base URL with an absolute endpoint path.
 * The join is serialized through the URL object (never `hostname` + port
 * string surgery), so a bracketed IPv6 base such as `http://[::1]:11434`
 * keeps standards-compliant brackets in the fetch URL. A base sub-path
 * prefix is preserved (`{base}/prefix` + `/api/chat`).
 */
export function joinLoopbackPath(
  normalizedBaseUrl: string,
  path: string,
): string {
  const url = new URL(normalizedBaseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${path}`;
  url.search = "";
  url.hash = "";
  return url.href.replace(/\/+$/, "");
}

/**
 * Extract optional token-count usage (input/output only). Returns the
 * normalized summary when both counts are integers >= 0, otherwise
 * undefined (provider omitted or malformed counts are ignored, never
 * surfaced as raw blobs). Never throws.
 */
export function extractModelUsage(
  inputTokens: unknown,
  outputTokens: unknown,
): { inputTokens: number; outputTokens: number } | undefined {
  if (
    typeof inputTokens !== "number" ||
    !Number.isInteger(inputTokens) ||
    inputTokens < 0 ||
    typeof outputTokens !== "number" ||
    !Number.isInteger(outputTokens) ||
    outputTokens < 0
  ) {
    return undefined;
  }
  return { inputTokens, outputTokens };
}
