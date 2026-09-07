// Provider-neutral ModelGateway contract plus shared request plumbing.
//
// Guarantees: loopback-only HTTP endpoints (see base_url.ts; `localhost`
// is pinned to literal `127.0.0.1` at parse time with no DNS lookup),
// per-request revalidation of the concrete fetch URL immediately before
// fetch (literal `127.0.0.1`/`::1` only, so mutated or unpinned targets
// never reach fetch), fetch with `redirect: "error"` (no redirect following), single attempt (no retry,
// no fallback, no router), and redacted failures (no auth token, raw
// response/body, prompt, or reasoning in any error).

import {
  assertPinnedLoopbackFetchUrl,
  normalizeLoopbackBaseUrl,
} from "./base_url.js";
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
/**
 * Maximum accepted native tool-call arguments payload per call (32KiB,
 * counted in UTF-8 bytes, not JS string characters).
 *
 * Aligned with the kernel ToolBroker `maxInputBytesPerCall` budget (32KiB
 * canonical input bytes): a provider arguments payload at or under this
 * bound may still be rejected downstream by broker validation/reservation,
 * which remains authoritative. Payloads over this bound are rejected here
 * with fixed redacted `invalid_response` before accepting/normalizing, and
 * are never truncated. The broker still validates/reserves every accepted
 * ordinary call.
 */
export const MAX_TOOL_CALL_ARGUMENTS_BYTES = 32 * 1024;

/** UTF-8 byte length of a string (never JS character count). */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/**
 * Maximum prototype links followed by `assertNoCustomToJSON` (bounds
 * `Reflect.getPrototypeOf` calls). Plain JSON chains are at most two links
 * (`value` -> `Object/Array.prototype` -> `null`), so this bound stays far
 * above every legal shape while keeping a hostile `getPrototypeOf` trap
 * finite: cycles and over-long chains reject with `TypeError`.
 */
export const MAX_PROTOTYPE_CHAIN_LINKS = 16;

/**
 * Reject any `toJSON` found on the value or its prototype chain without
 * invoking user code. Only `Object.getOwnPropertyDescriptor` (which never
 * calls getters or `toJSON` itself) is used: a data descriptor, an accessor
 * descriptor, or any inherited descriptor all reject. Plain JSON data from
 * `JSON.parse` never carries `toJSON`, so provider-parsed objects stay valid.
 *
 * The walk is hardened against hostile `Proxy`/`getPrototypeOf` chains:
 * visited prototype objects are tracked so self-cycles and multi-node
 * cycles reject instead of looping forever, the number of
 * `Object.getPrototypeOf` calls is bounded by
 * `MAX_PROTOTYPE_CHAIN_LINKS`, and throwing traps reject with the same
 * fixed `TypeError` (never leaking the trap error).
 */
function assertNoCustomToJSON(node: object): void {
  const seen = new Set<unknown>();
  let current: unknown = node;
  for (let depth = 0; depth <= MAX_PROTOTYPE_CHAIN_LINKS; depth += 1) {
    if (current === null) {
      return;
    }
    if (
      (typeof current !== "object" && typeof current !== "function") ||
      seen.has(current)
    ) {
      throw new TypeError("cyclic prototype in tool arguments");
    }
    seen.add(current);
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(current, "toJSON");
    } catch {
      throw new TypeError("unreadable prototype in tool arguments");
    }
    if (descriptor !== undefined) {
      throw new TypeError("custom toJSON in tool arguments");
    }
    if (depth >= MAX_PROTOTYPE_CHAIN_LINKS) {
      throw new TypeError("excessive prototype chain in tool arguments");
    }
    try {
      current = Object.getPrototypeOf(current);
    } catch {
      throw new TypeError("unreadable prototype in tool arguments");
    }
  }
  throw new TypeError("excessive prototype chain in tool arguments");
}

/**
 * Strict structural clone for tool-call arguments size measurement.
 *
 * Accepted values are plain JSON data only: null, finite numbers, strings,
 * booleans, plain objects (`Object.prototype` or `null` prototype), and
 * plain arrays (`Array.prototype`). Rejected without invoking user code
 * (no getter, setter, `toJSON`, or proxy-trap call beyond the inert
 * `Object.*` structural reads): custom `toJSON` (own or inherited),
 * accessor properties, symbol-keyed properties (enumerable or not),
 * functions, symbols, `undefined`, `bigint`, non-finite numbers, objects
 * with non-plain prototypes, arrays with holes or extra non-index keys,
 * and cycles. Unsupported values throw `TypeError` (never echoing data);
 * callers map the failure to their fixed redacted code.
 *
 * Object output uses a null-prototype sink with sorted keys so a
 * provider-controlled `__proto__` key stays a plain own property (never
 * invoking the `Object.prototype` setter, never dropped from the measured
 * serialization). Legal JSON keys are never rejected by name.
 */
function canonicalizeForSize(value: unknown, seen?: WeakSet<object>): unknown {
  if (value === null) {
    return null;
  }
  const kind = typeof value;
  if (kind === "string" || kind === "boolean") {
    return value;
  }
  if (kind === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("unsupported number in tool arguments");
    }
    return value;
  }
  if (
    kind === "undefined" ||
    kind === "function" ||
    kind === "symbol" ||
    kind === "bigint"
  ) {
    throw new TypeError("unsupported value in tool arguments");
  }
  if (kind !== "object") {
    throw new TypeError("unsupported value in tool arguments");
  }
  const node = value as object;
  assertNoCustomToJSON(node);
  if (Object.getOwnPropertySymbols(node).length > 0) {
    throw new TypeError("symbol key in tool arguments");
  }
  const active = seen ?? new WeakSet<object>();
  if (active.has(node)) {
    throw new TypeError("cyclic tool arguments");
  }
  if (Array.isArray(node)) {
    if (Object.getPrototypeOf(node) !== Array.prototype) {
      throw new TypeError("non-plain array in tool arguments");
    }
    active.add(node);
    try {
      const arr = node as unknown[];
      // Reject holes (missing index descriptors serialize as null and would
      // miscount) and extra enumerable non-index keys (ignored by
      // JSON.stringify, so accepting them would undercount). Descriptors
      // are read once per index without re-reading through the property
      // (which would invoke a getter if one raced in).
      const keys = Object.keys(arr);
      for (const key of keys) {
        if (!/^(0|[1-9][0-9]*)$/.test(key)) {
          throw new TypeError("extra key on array in tool arguments");
        }
        const numeric = Number(key);
        if (!Number.isSafeInteger(numeric) || numeric >= arr.length) {
          throw new TypeError("extra key on array in tool arguments");
        }
      }
      const out: unknown[] = new Array(arr.length);
      for (let index = 0; index < arr.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(arr, String(index));
        if (descriptor === undefined) {
          throw new TypeError("holey array in tool arguments");
        }
        if (descriptor.get !== undefined || descriptor.set !== undefined) {
          throw new TypeError("accessor in tool arguments");
        }
        out[index] = canonicalizeForSize(
          (descriptor as { value?: unknown }).value,
          active,
        );
      }
      return out;
    } finally {
      active.delete(node);
    }
  }
  const proto = Object.getPrototypeOf(node);
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError("non-plain prototype in tool arguments");
  }
  active.add(node);
  try {
    // Null-prototype sink: assigning provider-controlled keys such as
    // `__proto__` creates a plain own property instead of invoking the
    // `Object.prototype` setter (which would mutate the prototype and drop
    // the key from serialization, undercounting size). Every enumerable
    // own key is preserved and sorted for deterministic measurement;
    // legal JSON keys are never rejected by name. Descriptors are read via
    // `getOwnPropertyDescriptor` so accessor getters are rejected without
    // ever being invoked.
    const sorted: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(node).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(node, key) as
        | { value?: unknown; get?: unknown; set?: unknown }
        | undefined;
      if (
        descriptor === undefined ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined
      ) {
        throw new TypeError("accessor in tool arguments");
      }
      sorted[key] = canonicalizeForSize(descriptor.value, active);
    }
    return sorted;
  } finally {
    active.delete(node);
  }
}

/**
 * Deterministic (sorted-keys, no whitespace) JSON serialization for
 * tool-call arguments size measurement and wire encoding. Key order does
 * not affect the measured byte length; sorting keeps the measurement
 * stable across providers. Mirrors the kernel canonical form for size
 * alignment.
 *
 * The input must be plain JSON data (see `canonicalizeForSize`): custom
 * `toJSON`, accessors, symbols, functions, `undefined`, `bigint`,
 * non-finite numbers, non-plain prototypes, array holes/extras, and
 * cycles throw `TypeError` without invoking user code and without echoing
 * data. `JSON.parse` output (plain objects/arrays/primitives) always
 * remains valid.
 *
 * The returned string is the exact representation adapters send on the
 * wire (OpenAI `arguments` string; parsed back to the object form for
 * Ollama `tool_calls`, whose outer `JSON.stringify` then emits the same
 * key order with no whitespace), so the UTF-8 byte length measured here
 * is the length actually sent against the 32KiB bound.
 */
export function canonicalToolArgumentsJson(value: unknown): string {
  const text = JSON.stringify(canonicalizeForSize(value));
  if (text === undefined) {
    throw new TypeError("unsupported tool arguments");
  }
  return text;
}

/**
 * Exact wire encoding for one tool-call arguments payload: the canonical
 * serialization adapters send (OpenAI `arguments` string directly; parsed
 * back to the object form for Ollama `tool_calls`, whose outer
 * `JSON.stringify` then emits the same key order with no whitespace).
 * Throws `TypeError` for non-plain-JSON input without invoking user code;
 * callers map the failure to their fixed redacted code. `null`/`undefined`
 * encode as `{}` (matching adapter empty-arguments semantics).
 *
 * Final send-time bound: the canonical string is measured in UTF-8 bytes
 * here, immediately before adapters send it, and payloads over
 * `MAX_TOOL_CALL_ARGUMENTS_BYTES` (32KiB) reject with fixed redacted
 * `invalid_request` (never truncated, never echoed). This catches stateful
 * arguments that measured small during history validation but serialize
 * large on the wire (TOCTOU), even when request validation was bypassed.
 */
export function toWireToolArgumentsJson(args: unknown): string {
  const text = canonicalToolArgumentsJson(args ?? {});
  if (utf8ByteLength(text) > MAX_TOOL_CALL_ARGUMENTS_BYTES) {
    throw new ModelLocalError(
      "invalid_request",
      "model message carries invalid tool calls",
    );
  }
  return text;
}

/**
 * Object form of the exact wire encoding (for the Ollama `tool_calls`
 * payload): reparsed from `toWireToolArgumentsJson`, so the outer request
 * `JSON.stringify` emits exactly the measured bytes. Derives only from the
 * checked canonical string above (no independent serialization path), so
 * the same 32KiB UTF-8 bound and the same fixed redacted `invalid_request`
 * apply. Plain `Object.prototype` objects only (`__proto__` stays an own
 * property via the `JSON.parse` round-trip). Throws `TypeError` for
 * non-plain-JSON input without invoking user code.
 */
export function toWireToolArgumentsObject(args: unknown): unknown {
  return JSON.parse(toWireToolArgumentsJson(args)) as unknown;
}

/**
 * Reject an oversize tool-call arguments payload with fixed redacted
 * `invalid_response` (no raw arguments or provider body in the error).
 */
export function assertToolArgumentsByteLength(byteLength: number): void {
  if (byteLength > MAX_TOOL_CALL_ARGUMENTS_BYTES) {
    throw new ModelLocalError(
      "invalid_response",
      "model returned an invalid response",
    );
  }
}

/**
 * Reserved native terminal protocol identity. Used ONLY as a fixed
 * structural classification for normalization failures (never persisted,
 * never echoed): malformed `answer.submit` arguments reject as
 * `answer_invalid` so the caller can repair, while every other tool keeps
 * the generic `tool_call_invalid` / `invalid_response` path. Raw id, args,
 * and provider body never enter the error.
 */
export const ANSWER_SUBMIT_TOOL_NAME = "answer.submit" as const;

/** True only for the reserved `answer.submit` tool identity. */
export function isAnswerSubmitTool(name: unknown): boolean {
  return name === ANSWER_SUBMIT_TOOL_NAME;
}

/**
 * Fixed redacted normalization failure for `answer.submit` arguments
 * (malformed JSON, non-object, or oversized). No raw detail carried.
 */
export function answerArgsInvalidError(): ModelLocalError {
  return new ModelLocalError(
    "answer_invalid",
    "model returned an invalid answer",
  );
}

/**
 * Fixed redacted normalization failure for non-answer tool-call arguments
 * (malformed JSON shape or non-object). No raw detail carried.
 */
export function toolArgsInvalidError(): ModelLocalError {
  return new ModelLocalError(
    "tool_call_invalid",
    "model returned an invalid tool call",
  );
}

/** Throw the fixed per-tool normalization failure (answer vs ordinary). */
export function throwInvalidToolArguments(toolName: string): never {
  if (isAnswerSubmitTool(toolName)) {
    throw answerArgsInvalidError();
  }
  throw toolArgsInvalidError();
}

/**
 * Per-tool arguments size bound: `answer.submit` oversize rejects as fixed
 * `answer_invalid` (repairable), every other tool as fixed `invalid_response`
 * (generic, unchanged). Never truncates, never echoes raw payloads.
 */
export function assertToolArgumentsByteLengthForTool(
  byteLength: number,
  toolName: string,
): void {
  if (byteLength > MAX_TOOL_CALL_ARGUMENTS_BYTES) {
    if (isAnswerSubmitTool(toolName)) {
      throw answerArgsInvalidError();
    }
    throw new ModelLocalError(
      "invalid_response",
      "model returned an invalid response",
    );
  }
}
/** Maximum tool-call id/name lengths for history validation. */
export const MAX_TOOL_CALL_ID_LENGTH = 256;
/**
 * Provider-native tool-name shape enforced before accepting a ChatResult.
 * Mirrors contracts ToolNameSchema (namespace.verb, lowercase): the
 * AgentStrategy expects broker tools in this shape, and the reserved
 * answer.submit terminal protocol already satisfies it (preserved, never
 * special-cased here). Unknown but well-formed ordinary names pass this
 * check and reach ToolBroker for authoritative unknown-tool budget/audit.
 */
export const NATIVE_TOOL_NAME_PATTERN =
  /^[a-z0-9]+(?:_[a-z0-9]+)*\.[a-z0-9]+(?:_[a-z0-9]+)*$/;

/** True when a string carries ASCII control characters (never accepted). */
function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function nativeToolCallInvalidError(): ModelLocalError {
  return new ModelLocalError(
    "tool_call_invalid",
    "model returned an invalid tool call",
  );
}

function nativeToolCallOversizeError(): ModelLocalError {
  return new ModelLocalError(
    "invalid_response",
    "model returned an invalid response",
  );
}

/**
 * Enforce the shared per-message assistant-text bound on normalized
 * provider output. Assistant `text` longer than MAX_MESSAGE_CONTENT_LENGTH
 * rejects atomically with fixed redacted invalid_response (never truncated,
 * never echoed) before AgentStrategy stores it for replay, so no tool
 * executes and no evidence is created. Measured with the same character
 * semantics as ChatMessage validation (`text.length`, UTF-16 code units),
 * not UTF-8 bytes: multibyte characters count by length. Empty text stays
 * valid (tool-call-only responses); the caller classifies free text.
 */
export function assertAssistantTextWithinBound(text: string): void {
  if (text.length > MAX_MESSAGE_CONTENT_LENGTH) {
    throw new ModelLocalError(
      "invalid_response",
      "model returned an invalid response",
    );
  }
}

/**
 * Enforce the shared per-message native tool-call count bound on normalized
 * provider output (r3946739336). A response carrying more than
 * MAX_TOOL_CALLS_PER_MESSAGE native calls rejects atomically with fixed
 * redacted invalid_response (never truncated, never echoed) before
 * AgentStrategy or ToolBroker sees any call, so none executes. The check
 * runs before per-call argument parsing so an over-count batch containing a
 * malformed answer.submit still fails as invalid_response (never
 * answer_invalid, never repaired).
 */
export function assertToolCallCountWithinBound(count: number): void {
  if (count > MAX_TOOL_CALLS_PER_MESSAGE) {
    throw nativeToolCallOversizeError();
  }
}

/**
 * Validate a provider-native tool-call name before accepting the ChatResult.
 * Accepts only non-empty namespace.verb names within the 128-char
 * contracts bound (covers answer.submit and ordinary broker tools).
 * Rejects empty/control-bearing/misshaped names as fixed redacted
 * tool_call_invalid and oversize names as fixed redacted
 * invalid_response. Never truncates, never echoes raw values.
 */
export function assertNativeToolCallName(name: unknown): string {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    hasControlCharacters(name)
  ) {
    throw nativeToolCallInvalidError();
  }
  const NAME_LIMIT = 128;
  if (name.length > NAME_LIMIT) {
    throw nativeToolCallOversizeError();
  }
  if (!NATIVE_TOOL_NAME_PATTERN.test(name)) {
    throw nativeToolCallInvalidError();
  }
  return name;
}

/**
 * Validate a provider-native tool-call id before accepting the ChatResult.
 * Absent (undefined/null) ids synthesize the finite replay-safe
 * call_<index> fallback (preserves Ollama responses that omit ids and
 * keeps OpenAI tool_call_id replay correlation valid within the shared
 * 256-char history bound). Any present id must be a non-empty string
 * within 256 chars with no control characters: empty/non-string/
 * control-bearing rejects as fixed redacted tool_call_invalid, oversize
 * as fixed redacted invalid_response. Never truncates, never echoes.
 */
export function normalizeNativeToolCallId(
  rawId: unknown,
  index: number,
): string {
  if (rawId === undefined || rawId === null) {
    return `call_${index}`;
  }
  if (
    typeof rawId !== "string" ||
    rawId.length === 0 ||
    hasControlCharacters(rawId)
  ) {
    throw nativeToolCallInvalidError();
  }
  if (rawId.length > MAX_TOOL_CALL_ID_LENGTH) {
    throw nativeToolCallOversizeError();
  }
  return rawId;
}

export const MAX_TOOL_CALL_NAME_LENGTH = 128;

/**
 * True when an apiKey is a legal HTTP Authorization header value.
 *
 * Accepted per character (no normalization applied): printable ASCII
 * U+0020..U+007E plus Latin-1 U+00A0..U+00FF. Rejected: C0 controls
 * U+0000..U+001F (including CR/LF), DEL U+007F, C1 controls
 * U+0080..U+009F, and anything above U+00FF (emoji and other
 * non-Latin-1 code points that header conversion cannot represent).
 */
export function isValidApiKeyHeaderValue(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) as number;
    if (code < 0x20) {
      return false;
    }
    if (code === 0x7f) {
      return false;
    }
    if (code >= 0x80 && code <= 0x9f) {
      return false;
    }
    if (code > 0xff) {
      return false;
    }
  }
  return true;
}

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
  if (message.toolCallId !== undefined && message.role !== "tool") {
    throw new ModelLocalError(
      "invalid_request",
      "model message carries a tool call id on a non-tool role",
    );
  }
  if (message.role === "tool") {
    // Provider-neutral correlation: every tool result must carry both the
    // originating call id and tool name (non-empty, bounded). Adapters
    // serialize provider-natively (OpenAI `tool_call_id`, Ollama
    // `tool_name`) but validation requires both so neither wire can emit
    // an uncorrelated bare tool message. No ids are echoed in errors.
    if (
      typeof message.toolCallId !== "string" ||
      message.toolCallId.length === 0 ||
      message.toolCallId.length > MAX_TOOL_CALL_ID_LENGTH
    ) {
      throw new ModelLocalError(
        "invalid_request",
        "model message carries an invalid tool call id",
      );
    }
    if (
      typeof message.toolName !== "string" ||
      message.toolName.length === 0 ||
      message.toolName.length > MAX_TOOL_CALL_NAME_LENGTH
    ) {
      throw new ModelLocalError(
        "invalid_request",
        "model message carries an invalid tool name",
      );
    }
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
    // Replay bound (r3946625239): every replayed assistant
    // toolCalls[].arguments shares the 32KiB UTF-8 deterministic serialized
    // bound enforced on provider output. Measured here during history
    // validation — before either adapter JSON.stringify/request construction —
    // so an oversized replay rejects with fixed redacted invalid_request
    // without allocating the wire body. Non-plain-JSON replay (custom
    // toJSON, accessors, symbols, functions, non-plain prototypes, cycles,
    // unsupported values) rejects the same way without invoking user code.
    // Never truncated, never echoes raw args, never touches ToolBroker
    // budget (validation only; the broker still reserves accepted calls).
    let serialized: string;
    try {
      serialized = canonicalToolArgumentsJson(
        (call as { arguments?: unknown }).arguments,
      );
    } catch {
      throw new ModelLocalError(
        "invalid_request",
        "model message carries invalid tool calls",
      );
    }
    if (utf8ByteLength(serialized) > MAX_TOOL_CALL_ARGUMENTS_BYTES) {
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
    (typeof options.apiKey !== "string" ||
      options.apiKey.length === 0 ||
      !isValidApiKeyHeaderValue(options.apiKey))
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
      cancelResponseBody(response);
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
function cancelResponseBody(response: Response): void {
  let pending: Promise<void> | undefined;
  try {
    pending = response.body?.cancel();
  } catch {
    // Best effort: the fixed redacted error below carries no detail.
    return;
  }
  if (pending !== undefined) {
    // Attach the rejection handler synchronously and never await a
    // hostile cancel: the fixed redacted error below stays authoritative
    // and a rejecting/pending cancel cannot surface or hang the caller.
    void pending.catch(() => {
      // Best effort: cancel rejection is swallowed, never surfaced.
    });
  }
}

/**
 * Best-effort reader cancel that can never produce an unhandled rejection,
 * hang the caller, or replace the primary error. The rejection handler is
 * attached synchronously (no `await` on a hostile cancel) and any
 * synchronous throw is swallowed; callers throw their own authoritative
 * redacted error or abort mapping afterwards.
 */
function cancelReaderQuietly(reader: BoundedBodyReader, reason: unknown): void {
  let pending: Promise<void> | undefined;
  try {
    pending = reader.cancel(reason);
  } catch {
    // Best effort: the caller's primary error stays authoritative.
    return;
  }
  if (pending !== undefined) {
    void pending.catch(() => {
      // Best effort: cancel rejection is swallowed, never surfaced.
    });
  }
}

/**
 * Read at most `MAX_RESPONSE_BYTES + 1` UTF-8 bytes from the response
 * stream, cancel the reader on overflow, and decode only bytes within the
 * bound (chunks are merged before a single fatal `TextDecoder` pass so
 * valid multibyte characters split across chunks survive while malformed
 * sequences are rejected instead of replaced with U+FFFD). Byte length
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
    // Timeout/external-abort cleanup: never await a hostile reader and
    // never surface its outcome. The handler is attached synchronously so
    // a rejecting cancel cannot become an unhandled rejection; the abort
    // mapping below (AbortError vs timeout) stays authoritative.
    cancelReaderQuietly(
      reader,
      new DOMException("The operation was aborted.", "AbortError"),
    );
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
        // A timeout or external abort can surface as `done=true` (reader
        // cancelled) instead of a read rejection: never accept EOF while
        // aborted. External cancellation keeps its abort rejection;
        // timeout-guard aborts map to `timeout`.
        if (isAborted(externalSignal)) {
          throw toAbortRejection(externalSignal as AbortSignal);
        }
        if (controller.signal.aborted) {
          throw new ModelLocalError("timeout", "model request timed out");
        }
        break;
      }
      const value: Uint8Array | undefined = next.value;
      if (value === undefined) {
        if (isAborted(externalSignal)) {
          throw toAbortRejection(externalSignal as AbortSignal);
        }
        if (controller.signal.aborted) {
          throw new ModelLocalError("timeout", "model request timed out");
        }
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        // Overflow cleanup: fire-and-forget with a synchronous rejection
        // handler (never await a hostile cancel). The redacted overflow
        // error below is authoritative; a cancel rejection never replaces
        // it or leaks into the output.
        cancelReaderQuietly(
          reader,
          new DOMException("Response body exceeds limit.", "AbortError"),
        );
        throw failures.tooLarge();
      }
      chunks.push(value);
    }
    // Never decode a partially or fully read body after an abort: a
    // cancelled reader may have returned `done=true` above (handled), or
    // the abort may have landed between the final read and decode.
    if (isAborted(externalSignal)) {
      throw toAbortRejection(externalSignal as AbortSignal);
    }
    if (controller.signal.aborted) {
      throw new ModelLocalError("timeout", "model request timed out");
    }
    const merged = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    // Fatal UTF-8: malformed sequences (truncated, overlong, surrogate,
    // bad continuation) reject here before JSON parsing instead of
    // surfacing as U+FFFD replacement characters. The error is fixed and
    // redacted (no bytes, body, or URL) and always `invalid_response`,
    // including on non-2xx drains whose status mapping cannot apply to an
    // undecodable body.
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(merged);
    } catch {
      throw new ModelLocalError(
        "invalid_response",
        "model returned an invalid response",
      );
    }
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
 * Enforce strict native tool-call results: unsolicited calls are rejected,
 * and every accepted call carries a bounded valid id/name (no free-text
 * JSON emulation is performed anywhere; content text is never parsed for
 * tool calls). Duplicate native ids reject atomically with fixed redacted
 * tool_call_invalid before conversation storage/execution, so trim logic
 * can never orphan a tool response, except for the multi-answer terminal
 * protocol: when the entire step consists of multiple answer.submit calls
 * (count > 1, every name is answer.submit), duplicate ids pass through so
 * AgentStrategy applies its deterministic-ID remap and duplicate-answer
 * repair-once path (no Broker execution). Unknown but well-formed ordinary names are NOT rejected
 * here: they pass through so the AgentStrategy/ToolBroker applies the
 * authoritative unknown-tool budget/audit. Malformed ids/names reject
 * with fixed redacted codes (never truncated, never echoed).
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
  // Per-call bounds first: every original call (including a duplicate
  // answer.submit) must carry a valid bounded id/name; failures reject
  // atomically before any duplicate exception is considered.
  for (const call of options.toolCalls) {
    normalizeNativeToolCallId(call.id, 0);
    assertNativeToolCallName(call.name);
  }
  // Duplicate-answer exception: the whole step is multiple answer.submit
  // calls (count > 1, all names answer.submit). Ordinary or mixed batches
  // fall through to the atomic duplicate gate below.
  if (
    options.toolCalls.length > 1 &&
    options.toolCalls.every((call) => call.name === ANSWER_SUBMIT_TOOL_NAME)
  ) {
    return;
  }
  const seenIds = new Set<string>();
  for (const call of options.toolCalls) {
    if (seenIds.has(call.id)) {
      throw nativeToolCallInvalidError();
    }
    seenIds.add(call.id);
  }
}

/**
 * Validate an injected/normalized ChatResult before execution or storage
 * (r3949581177/r3949352972, r3950152834). Custom gateways bypass provider normalization,
 * so AgentStrategy must apply every existing bound atomically here: assistant
 * text (character semantics), stopReason, per-message tool-call count, per-call id/name
 * shape and bounds, per-call plain-JSON arguments with the exact 32KiB
 * canonical UTF-8 bound, and duplicate ids. Unknown but well-formed ordinary
 * names still pass (authoritative unknown-tool budget/audit stays with the
 * ToolBroker). Throws the same fixed redacted codes as provider
 * normalization (`answer_invalid` for malformed/oversize answer.submit
 * arguments, `tool_call_invalid` for malformed ids/names/args/duplicates or
 * unsolicited calls, `invalid_response` for oversize text/count/ids/names or
 * non-object shapes). Never truncates, never echoes raw values, never
 * executes or grants anything (validation only).
 *
 * Detached snapshot (r3950152834, r3950938866): `text`/`stopReason`/
 * `toolCalls`/`usage` are each captured once via own data descriptors
 * (accessor descriptors reject without invoking user code, so a stateful
 * getter's second value is never executed), each arguments object is cloned
 * from its already-computed canonical JSON string, optional `usage` is
 * validated as token counts only ({inputTokens, outputTokens} nonnegative
 * safe integers, no extra/raw fields) and cloned into a new plain object
 * included only when present (absent usage is omitted for
 * exactOptionalPropertyTypes), and a new plain `ChatResult` with new call
 * objects is returned. Callers must use the returned snapshot (never the
 * source result), so later mutation cannot change what was validated. No
 * nested references are shared with the source result.
 */
export function validateChatResult(
  result: unknown,
  requestedTools?: readonly ToolDefinition[] | undefined,
): ChatResult {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new ModelLocalError(
      "invalid_response",
      "model returned an invalid response",
    );
  }
  const source = result as object;
  // Single capture per top-level field via own data descriptors: an accessor
  // descriptor rejects without invoking the getter (zero executions, so a
  // second getter value can never surface); a missing own property rejects
  // as malformed. Plain `JSON.parse` / object-literal results always carry
  // own data properties, so legal shapes stay valid.
  const readTopField = (key: string): unknown => {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(source, key);
    } catch {
      throw new ModelLocalError(
        "invalid_response",
        "model returned an invalid response",
      );
    }
    if (descriptor === undefined) {
      throw new ModelLocalError(
        "invalid_response",
        "model returned an invalid response",
      );
    }
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      throw new ModelLocalError(
        "invalid_response",
        "model returned an invalid response",
      );
    }
    return descriptor.value;
  };
  const text = readTopField("text");
  const stopReason = readTopField("stopReason");
  const toolCallsValue = readTopField("toolCalls");
  if (typeof text !== "string") {
    throw new ModelLocalError(
      "invalid_response",
      "model returned an invalid response",
    );
  }
  // Text bound first so an oversize batch containing a malformed
  // answer.submit still fails as invalid_response (never repaired).
  assertAssistantTextWithinBound(text);
  if (
    stopReason !== "stop" &&
    stopReason !== "tool_calls" &&
    stopReason !== "unknown"
  ) {
    throw new ModelLocalError(
      "invalid_response",
      "model returned an invalid response",
    );
  }
  if (!Array.isArray(toolCallsValue)) {
    throw new ModelLocalError(
      "invalid_response",
      "model returned an invalid response",
    );
  }
  const toolCalls = toolCallsValue as unknown[];
  // Count bound before per-call parsing (same ordering as adapters).
  assertToolCallCountWithinBound(toolCalls.length);
  const seenIds = new Map<string, string>();
  const names: string[] = [];
  const snapshotCalls: { id: string; name: string; arguments: unknown }[] = [];
  for (let index = 0; index < toolCalls.length; index += 1) {
    // Single capture per element: holes and accessor elements reject without
    // invoking user code.
    let elementDescriptor: PropertyDescriptor | undefined;
    try {
      elementDescriptor = Object.getOwnPropertyDescriptor(
        toolCalls,
        String(index),
      );
    } catch {
      throw nativeToolCallInvalidError();
    }
    if (
      elementDescriptor === undefined ||
      elementDescriptor.get !== undefined ||
      elementDescriptor.set !== undefined
    ) {
      throw nativeToolCallInvalidError();
    }
    const entry = elementDescriptor.value;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw nativeToolCallInvalidError();
    }
    const callSource = entry as object;
    const readCallField = (key: string): unknown => {
      let descriptor: PropertyDescriptor | undefined;
      try {
        descriptor = Object.getOwnPropertyDescriptor(callSource, key);
      } catch {
        throw nativeToolCallInvalidError();
      }
      if (descriptor === undefined) {
        return undefined;
      }
      if (descriptor.get !== undefined || descriptor.set !== undefined) {
        if (key === "arguments") {
          // Name is read below; defer precise per-tool error until after.
          throw new TypeError("accessor in tool arguments");
        }
        throw nativeToolCallInvalidError();
      }
      return descriptor.value;
    };
    // Injected results must carry an explicit id: absent ids reject here
    // (provider adapters synthesize call_<index> only for omitted
    // provider-native ids, never for already-normalized results).
    const rawId = readCallField("id");
    if (rawId === undefined || rawId === null) {
      throw nativeToolCallInvalidError();
    }
    const id = normalizeNativeToolCallId(rawId, index);
    const rawName = readCallField("name");
    const name = assertNativeToolCallName(rawName);
    let args: unknown;
    try {
      args = readCallField("arguments");
    } catch {
      throwInvalidToolArguments(name);
    }
    if (!isRecord(args)) {
      throwInvalidToolArguments(name);
    }
    let serialized: string;
    try {
      serialized = canonicalToolArgumentsJson(args);
    } catch {
      throwInvalidToolArguments(name);
    }
    assertToolArgumentsByteLengthForTool(utf8ByteLength(serialized), name);
    // Detached clone from the already-computed canonical string: plain
    // `Object.prototype` data only, no shared references with the source.
    const clonedArgs = JSON.parse(serialized) as unknown;
    // Duplicate answer.submit ids defer to AgentStrategy classification so
    // the terminal protocol repairs exactly once; any duplicate involving
    // an ordinary tool rejects atomically here so nothing executes.
    const prior = seenIds.get(id);
    if (prior !== undefined) {
      if (
        !(prior === ANSWER_SUBMIT_TOOL_NAME && name === ANSWER_SUBMIT_TOOL_NAME)
      ) {
        throw nativeToolCallInvalidError();
      }
    } else {
      seenIds.set(id, name);
    }
    names.push(name);
    snapshotCalls.push({ id, name, arguments: clonedArgs });
  }
  // Optional usage snapshot (r3950938866): captured exactly once via its own
  // data descriptor (accessor descriptors reject without invoking user code,
  // so a stateful getter's second value is never executed). Absent (missing
  // own property, undefined, or null) is omitted for
  // exactOptionalPropertyTypes. When present, the object must carry exactly
  // {inputTokens, outputTokens} as nonnegative safe integers with no
  // extra/raw fields (no total_tokens, reasoning, or provider blobs); each
  // count is read once via its own data descriptor and the snapshot is a new
  // plain object sharing no references with the source.
  const readUsageSnapshot = ():
    | { inputTokens: number; outputTokens: number }
    | undefined => {
    let usageDescriptor: PropertyDescriptor | undefined;
    try {
      usageDescriptor = Object.getOwnPropertyDescriptor(source, "usage");
    } catch {
      throw new ModelLocalError(
        "invalid_response",
        "model returned an invalid response",
      );
    }
    if (usageDescriptor === undefined) {
      return undefined;
    }
    if (
      usageDescriptor.get !== undefined ||
      usageDescriptor.set !== undefined
    ) {
      throw new ModelLocalError(
        "invalid_response",
        "model returned an invalid response",
      );
    }
    const rawUsage = usageDescriptor.value;
    if (rawUsage === undefined || rawUsage === null) {
      return undefined;
    }
    if (typeof rawUsage !== "object" || Array.isArray(rawUsage as unknown[])) {
      throw new ModelLocalError(
        "invalid_response",
        "model returned an invalid response",
      );
    }
    const usageNode = rawUsage as object;
    let usageProto: unknown;
    try {
      usageProto = Object.getPrototypeOf(usageNode);
    } catch {
      throw new ModelLocalError(
        "invalid_response",
        "model returned an invalid response",
      );
    }
    if (usageProto !== Object.prototype && usageProto !== null) {
      throw new ModelLocalError(
        "invalid_response",
        "model returned an invalid response",
      );
    }
    try {
      if (Object.getOwnPropertySymbols(usageNode).length > 0) {
        throw new ModelLocalError(
          "invalid_response",
          "model returned an invalid response",
        );
      }
    } catch (error) {
      if (error instanceof ModelLocalError) {
        throw error;
      }
      throw new ModelLocalError(
        "invalid_response",
        "model returned an invalid response",
      );
    }
    let inputDescriptor: PropertyDescriptor | undefined;
    let outputDescriptor: PropertyDescriptor | undefined;
    try {
      inputDescriptor = Object.getOwnPropertyDescriptor(
        usageNode,
        "inputTokens",
      );
      outputDescriptor = Object.getOwnPropertyDescriptor(
        usageNode,
        "outputTokens",
      );
    } catch {
      throw new ModelLocalError(
        "invalid_response",
        "model returned an invalid response",
      );
    }
    if (
      inputDescriptor === undefined ||
      outputDescriptor === undefined ||
      inputDescriptor.get !== undefined ||
      inputDescriptor.set !== undefined ||
      outputDescriptor.get !== undefined ||
      outputDescriptor.set !== undefined
    ) {
      throw new ModelLocalError(
        "invalid_response",
        "model returned an invalid response",
      );
    }
    const inputTokens = (inputDescriptor as { value?: unknown }).value;
    const outputTokens = (outputDescriptor as { value?: unknown }).value;
    if (!isSafeUsageCount(inputTokens) || !isSafeUsageCount(outputTokens)) {
      throw new ModelLocalError(
        "invalid_response",
        "model returned an invalid response",
      );
    }
    const keys = Object.keys(usageNode);
    if (
      keys.length !== 2 ||
      !keys.includes("inputTokens") ||
      !keys.includes("outputTokens")
    ) {
      throw new ModelLocalError(
        "invalid_response",
        "model returned an invalid response",
      );
    }
    return { inputTokens, outputTokens };
  };
  const usageSnapshot = readUsageSnapshot();
  // Multiple answer.submit calls (same or distinct ids) classify as the
  // duplicate terminal protocol in AgentStrategy: skip the shared duplicate
  // gate and return the detached snapshot after the unsolicited check so
  // repair-once applies.
  if (names.filter((entry) => entry === ANSWER_SUBMIT_TOOL_NAME).length > 1) {
    if (
      toolCalls.length > 0 &&
      (requestedTools === undefined || requestedTools.length === 0)
    ) {
      throw new ModelLocalError(
        "tool_call_invalid",
        "model returned tool calls without tools requested",
      );
    }
    return {
      text,
      toolCalls: snapshotCalls,
      stopReason: stopReason as ChatResult["stopReason"],
      ...(usageSnapshot === undefined ? {} : { usage: usageSnapshot }),
    };
  }
  validateNativeToolCalls({
    toolCalls: snapshotCalls,
    requestedTools,
  });
  return {
    text,
    toolCalls: snapshotCalls,
    stopReason: stopReason as ChatResult["stopReason"],
    ...(usageSnapshot === undefined ? {} : { usage: usageSnapshot }),
  };
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
 * normalized summary when both counts are safe integers >= 0, returns
 * undefined only when the provider omits both counts (undefined/null),
 * and throws fixed redacted `invalid_response` for any present-but-invalid
 * count (wrong type, fraction, negative, or above MAX_SAFE_INTEGER,
 * including JSON-rounded values). No coercion, clamping, or truncation;
 * raw blobs are never surfaced.
 */
export function extractModelUsage(
  inputTokens: unknown,
  outputTokens: unknown,
): { inputTokens: number; outputTokens: number } | undefined {
  const absentInput = inputTokens === undefined || inputTokens === null;
  const absentOutput = outputTokens === undefined || outputTokens === null;
  if (absentInput && absentOutput) {
    return undefined;
  }
  if (!isSafeUsageCount(inputTokens) || !isSafeUsageCount(outputTokens)) {
    throw new ModelLocalError(
      "invalid_response",
      "model returned an invalid response",
    );
  }
  return {
    inputTokens: inputTokens as number,
    outputTokens: outputTokens as number,
  };
}

/** True only for a nonnegative safe-integer token count (no coercion). */
function isSafeUsageCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    (value as number) >= 0
  );
}
