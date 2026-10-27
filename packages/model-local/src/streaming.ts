// PR-2 streaming support for the OpenAI-compatible adapter.
//
// `stream:true` SSE parsing that accumulates `content`, `reasoning_content`
// and `tool_calls` argument deltas into the same normal form the
// non-streaming path validates, so downstream tool-loop / answer.submit
// validation is unchanged. Provisional per-chunk pieces are surfaced via
// the optional delta callback only (never validated, never persisted).
//
// Bounds: the effective per-call byte cap (min(maxResponseBytes,
// MAX_RESPONSE_BYTES)) applies to the DECODED accumulated payload (UTF-8
// bytes of content, reasoning, tool-call names/arguments and the
// provisional answer draft), matching the non-streaming response bound.
// Raw SSE framing is separately capped by MAX_STREAM_WIRE_BYTES for
// transport safety only, so per-token `data:` envelopes never consume the
// caller's response budget. Accumulated text honors
// MAX_MESSAGE_CONTENT_LENGTH and per-tool arguments honor
// MAX_TOOL_CALL_ARGUMENTS_BYTES with the same redacted error classes as
// the non-streaming path (`invalid_response`, `tool_call_invalid`,
// `answer_invalid`). Step/wall timeouts arrive via the caller AbortSignal
// (300s step / 600s wall owned by the kernel); external cancellation
// rethrows the original abort rejection untouched. Malformed chunks reject
// as `invalid_response` (same class as today). No retry, no fallback, no
// redirect following, no logging of bodies/prompts/reasoning.

import { assertPinnedLoopbackFetchUrl } from "./base_url.js";
import { ModelLocalError } from "./errors.js";
import {
  assertAssistantTextWithinBound,
  assertToolArgumentsByteLengthForTool,
  assertToolCallCountWithinBound,
  connectionFailureError,
  isAnswerSubmitTool,
  isRecord,
  MAX_MESSAGE_CONTENT_LENGTH,
  MAX_RESPONSE_BYTES,
  MAX_TOOL_CALLS_PER_MESSAGE,
  resolveResponseByteLimit,
  utf8ByteLength,
} from "./gateway.js";
import type {
  FetchImpl,
  ModelStreamDelta,
  ModelStreamDeltaCallback,
  RawHttpResponse,
} from "./types.js";

/** Fixed redacted `invalid_response` with a closed, non-sensitive cause. */
function invalidResponse(
  cause: import("./errors.js").ModelLocalInvalidResponseCause,
): ModelLocalError {
  return new ModelLocalError(
    "invalid_response",
    cause === "response_too_large"
      ? "model returned an oversized response"
      : "model returned an invalid response",
    undefined,
    { invalidResponseCause: cause },
  );
}

/** Raw per-chunk pieces produced by the accumulator (callback input). */
export interface StreamChunkPieces {
  readonly content: string;
  readonly reasoning: string;
  readonly toolDeltas: ReadonlyArray<{
    readonly index: number;
    readonly name: string;
    readonly argumentsText: string;
  }>;
}

/**
 * Absolute raw SSE wire cap for one streamed call (64 MiB, transport
 * safety only). The caller's effective response cap bounds the DECODED
 * payload instead (see `OpenAIStreamAccumulator`); this much larger wire
 * bound only stops a runaway provider from streaming unbounded framing.
 * Exceeding either bound fails closed with the same `invalid_response` /
 * `response_too_large` class. Exported so operators and tests can reason
 * about the ceiling.
 */
export const MAX_STREAM_WIRE_BYTES = 64 * 1024 * 1024;

/**
 * Bounded capture of the raw SSE bytes actually received for one call.
 * Disabled (zero work, no retained chunks, no extra copy) when the caller
 * did not pass `onRawResponse`. When enabled it retains at most the
 * effective per-call DECODED byte cap, so the observer never retains more
 * than the caller's response budget even when the SSE wire (framing) is
 * legitimately larger; bytes beyond that prefix are dropped. The observer
 * therefore sees a bounded prefix, never the whole oversized wire body.
 * Decoding is
 * non-fatal: malformed UTF-8 is exactly one of the failures this observer
 * exists to expose, so replacement characters are preferable to throwing
 * from the recording hook. Headers are never part of the captured value.
 */
class RawSseCapture {
  private readonly chunks: Uint8Array[] = [];
  private capturedBytes = 0;
  private emitted = false;

  constructor(
    private readonly status: number,
    private readonly limit: number,
    private readonly onRawResponse:
      | ((response: RawHttpResponse) => void)
      | undefined,
  ) {}

  get enabled(): boolean {
    return this.onRawResponse !== undefined;
  }

  /** Retain the received bytes (bounded to the per-call limit). */
  push(value: Uint8Array): void {
    if (!this.enabled || this.capturedBytes >= this.limit) {
      return;
    }
    const remaining = this.limit - this.capturedBytes;
    const part =
      value.byteLength <= remaining ? value : value.subarray(0, remaining);
    if (part.byteLength > 0) {
      this.chunks.push(part);
      this.capturedBytes += part.byteLength;
    }
  }

  /**
   * Invoke the raw observer at most once. Callback exceptions propagate
   * unchanged (same as the non-streaming path): a recording failure must be
   * explicit, never silently swallowed. Abort/timeout paths deliberately do
   * not emit (see `postChatCompletionStream`).
   */
  emit(): void {
    if (!this.enabled || this.emitted) {
      return;
    }
    this.emitted = true;
    const callback = this.onRawResponse as (response: RawHttpResponse) => void;
    callback({ status: this.status, body: this.decode() });
  }

  private decode(): string {
    if (this.chunks.length === 0) {
      return "";
    }
    if (this.chunks.length === 1) {
      return new TextDecoder().decode(this.chunks[0]);
    }
    const merged = new Uint8Array(this.capturedBytes);
    let offset = 0;
    for (const chunk of this.chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    // Non-fatal on purpose: invalid UTF-8 is captured as received (U+FFFD)
    // instead of losing the raw record to a decode throw.
    return new TextDecoder().decode(merged);
  }
}

/** One accumulated tool call (arguments appended across chunks). */
interface AccumulatedToolCall {
  id: string | undefined;
  seenId: boolean;
  type: string | undefined;
  name: string | undefined;
  argumentsText: string;
}

/**
 * Strict incremental accumulator for OpenAI `stream:true` chunk bodies.
 * Each `pushChunkBody` validates one parsed `data:` JSON value and appends
 * its deltas; `finalize` synthesizes the exact non-streaming response shape
 * so the caller validates through the shared normalizer (identical error
 * classes and identical ChatResult). The accumulator itself never throws
 * per-tool answer codes for size: when the tool name is already known an
 * oversize increment rejects with the same per-tool code the finalizer
 * would produce; otherwise the finalizer classifies it. Independently, the
 * decoded accumulated payload (content + reasoning + every tool name and
 * arguments + provisional answer draft, in UTF-8 bytes) is bounded by the
 * effective per-call cap, so SSE framing never eats the response budget.
 */
export class OpenAIStreamAccumulator {
  private readonly maxDecodedBytes: number;
  private content = "";
  private reasoning = "";
  private contentBytes = 0;
  private reasoningBytes = 0;
  private toolNameBytes = 0;
  private toolArgumentBytes = 0;
  private draftCache = "";
  private draftBytes = 0;
  private draftDirty = false;
  private readonly tools = new Map<number, AccumulatedToolCall>();
  private finishReason = "";
  private rawUsage: unknown = undefined;
  private seenUsage = false;
  private done = false;

  constructor(options: { maxDecodedBytes?: number } = {}) {
    this.maxDecodedBytes = options.maxDecodedBytes ?? MAX_RESPONSE_BYTES;
  }

  /** Append one parsed chunk body; returns the provisional pieces. */
  pushChunkBody(body: unknown): StreamChunkPieces {
    if (this.done) {
      throw invalidResponse("chunk_shape_invalid");
    }
    if (!isRecord(body)) {
      throw invalidResponse("chunk_shape_invalid");
    }
    if (body.message !== undefined) {
      // Non-streaming shape inside a stream: wrong envelope for this path.
      throw invalidResponse("chunk_shape_invalid");
    }
    const choices = body.choices;
    if (!Array.isArray(choices)) {
      throw invalidResponse("chunk_shape_invalid");
    }
    let contentPiece = "";
    let reasoningPiece = "";
    const toolDeltas: Array<{
      index: number;
      name: string;
      argumentsText: string;
    }> = [];
    for (const choice of choices) {
      if (!isRecord(choice)) {
        throw invalidResponse("chunk_shape_invalid");
      }
      if (choice.message !== undefined) {
        // Non-streaming `message` shape inside a stream chunk: wrong
        // envelope for this path (stream chunks carry `delta` only).
        throw invalidResponse("chunk_shape_invalid");
      }
      if (
        choice.finish_reason !== undefined &&
        choice.finish_reason !== null &&
        typeof choice.finish_reason !== "string"
      ) {
        throw invalidResponse("chunk_shape_invalid");
      }
      if (
        typeof choice.finish_reason === "string" &&
        choice.finish_reason.length > 0
      ) {
        this.finishReason = choice.finish_reason;
      }
      const delta = choice.delta;
      if (delta === undefined || delta === null) {
        continue;
      }
      if (!isRecord(delta)) {
        throw invalidResponse("chunk_shape_invalid");
      }
      if (
        delta.content !== undefined &&
        delta.content !== null &&
        typeof delta.content !== "string"
      ) {
        throw invalidResponse("chunk_shape_invalid");
      }
      if (typeof delta.content === "string" && delta.content.length > 0) {
        this.content += delta.content;
        this.contentBytes += utf8ByteLength(delta.content);
        contentPiece += delta.content;
        assertAssistantTextWithinBound(this.content);
      }
      if (
        delta.reasoning_content !== undefined &&
        delta.reasoning_content !== null &&
        typeof delta.reasoning_content !== "string"
      ) {
        throw invalidResponse("chunk_shape_invalid");
      }
      if (
        typeof delta.reasoning_content === "string" &&
        delta.reasoning_content.length > 0
      ) {
        this.reasoning += delta.reasoning_content;
        this.reasoningBytes += utf8ByteLength(delta.reasoning_content);
        reasoningPiece += delta.reasoning_content;
        // Same character bound as assistant text: reasoning buffers stay
        // finite under the identical redacted code.
        if (this.reasoning.length > MAX_MESSAGE_CONTENT_LENGTH) {
          throw invalidResponse("content_too_long");
        }
      }
      if (delta.tool_calls !== undefined && delta.tool_calls !== null) {
        if (!Array.isArray(delta.tool_calls)) {
          throw invalidResponse("tool_call_shape_invalid");
        }
        for (const entry of delta.tool_calls) {
          const piece = this.appendToolCallDelta(entry);
          if (piece !== null) {
            toolDeltas.push(piece);
          }
        }
      }
    }
    if (body.usage !== undefined && body.usage !== null) {
      if (!isRecord(body.usage)) {
        throw invalidResponse("usage_invalid");
      }
      // Terminal usage summary (present only with
      // `stream_options.include_usage`); validated at finalize through the
      // shared usage extractor so counts keep the same classes.
      this.rawUsage = body.usage;
      this.seenUsage = true;
    }
    this.assertDecodedWithinBound();
    return { content: contentPiece, reasoning: reasoningPiece, toolDeltas };
  }

  /** Mark the stream complete (`[DONE]` seen); further pushes reject. */
  markDone(): void {
    this.done = true;
  }

  /** Accumulated plain content so far (provisional). */
  getContent(): string {
    return this.content;
  }

  /** Accumulated reasoning text so far (provisional, never validated). */
  getReasoning(): string {
    return this.reasoning;
  }

  /** Last non-empty finish_reason seen ("" when none arrived). */
  getFinishReason(): string {
    return this.finishReason;
  }

  /**
   * Synthesize the exact non-streaming response body for the shared
   * normalizer: tool calls sorted by stream index (deterministic order),
   * ids/names/arguments as accumulated. Validation (count, id/name shape,
   * per-tool argument size/code, usage) then runs through the identical
   * path as `stream:false`, producing the identical ChatResult shape.
   */
  toNormalFormBody(): Record<string, unknown> {
    const ordered = [...this.tools.entries()].sort((a, b) => a[0] - b[0]);
    assertToolCallCountWithinBound(ordered.length);
    if (ordered.length > MAX_TOOL_CALLS_PER_MESSAGE) {
      throw invalidResponse("tool_call_shape_invalid");
    }
    const toolCalls = ordered.map(([streamIndex, call]) => ({
      id: call.seenId ? (call.id as string) : `call_${streamIndex}`,
      type: call.type ?? "function",
      function: {
        name: call.name ?? "",
        arguments: call.argumentsText,
      },
    }));
    const body: Record<string, unknown> = {
      choices: [
        {
          message: {
            content: this.content,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: this.finishReason,
        },
      ],
    };
    if (this.seenUsage) {
      body.usage = this.rawUsage;
    }
    return body;
  }

  /**
   * Cumulative provisional draft text for `answer.submit`: concatenation of
   * `parts[].text` decoded from the accumulated argument JSON of every
   * `answer.submit` tool call, in stream-index order. Best-effort only
   * (never throws): partial escapes/unicode prefixes decode what is
   * complete so far; unparseable prefixes contribute nothing until more
   * bytes arrive. The validated answer still comes only from the final
   * ChatResult.
   */
  getAnswerDraftText(): string {
    this.ensureDraft();
    return this.draftCache;
  }

  /**
   * Enforce the effective per-call cap on the decoded accumulated payload:
   * UTF-8 bytes of content + reasoning + every tool-call name/arguments +
   * the provisional draft already accumulated. The raw SSE wire has its
   * own much larger transport cap (`MAX_STREAM_WIRE_BYTES`).
   */
  private assertDecodedWithinBound(): void {
    this.ensureDraft();
    const total =
      this.contentBytes +
      this.reasoningBytes +
      this.toolNameBytes +
      this.toolArgumentBytes +
      this.draftBytes;
    if (total > this.maxDecodedBytes) {
      throw new ModelLocalError(
        "invalid_response",
        "model returned an oversized response",
        undefined,
        { invalidResponseCause: "response_too_large" },
      );
    }
  }

  /** Recompute the provisional draft (and its UTF-8 size) when stale. */
  private ensureDraft(): void {
    if (!this.draftDirty) {
      return;
    }
    const ordered = [...this.tools.entries()].sort((a, b) => a[0] - b[0]);
    let draft = "";
    for (const [, call] of ordered) {
      if (call.name === undefined || !isAnswerSubmitTool(call.name)) {
        continue;
      }
      const piece = extractPartialPartsText(call.argumentsText);
      if (piece.length === 0) {
        continue;
      }
      // Multiple `answer.submit` calls concatenate like parts: exactly one
      // blank line between contributions (matching the authoritative
      // rendering), never direct adjacency.
      draft += (draft.length === 0 ? "" : "\n\n") + piece;
    }
    this.draftCache = draft;
    this.draftBytes = utf8ByteLength(draft);
    this.draftDirty = false;
  }

  private appendToolCallDelta(entry: unknown): {
    index: number;
    name: string;
    argumentsText: string;
  } | null {
    if (!isRecord(entry)) {
      throw invalidResponse("tool_call_shape_invalid");
    }
    const index = entry.index;
    if (
      typeof index !== "number" ||
      !Number.isSafeInteger(index) ||
      index < 0
    ) {
      throw invalidResponse("tool_call_shape_invalid");
    }
    let call = this.tools.get(index);
    if (call === undefined) {
      if (this.tools.size >= MAX_TOOL_CALLS_PER_MESSAGE) {
        throw invalidResponse("tool_call_shape_invalid");
      }
      call = {
        id: undefined,
        seenId: false,
        type: undefined,
        name: undefined,
        argumentsText: "",
      };
      this.tools.set(index, call);
    }
    if (entry.id !== undefined && entry.id !== null) {
      if (typeof entry.id !== "string") {
        throw invalidResponse("tool_call_shape_invalid");
      }
      if (!call.seenId) {
        call.id = entry.id;
        call.seenId = true;
      } else if (call.id !== entry.id) {
        throw invalidResponse("tool_call_shape_invalid");
      }
    }
    if (entry.type !== undefined && entry.type !== null) {
      if (typeof entry.type !== "string") {
        throw invalidResponse("tool_call_shape_invalid");
      }
      if (call.type === undefined) {
        call.type = entry.type;
      } else if (call.type !== entry.type) {
        throw invalidResponse("tool_call_shape_invalid");
      }
    }
    const fn = entry.function;
    if (fn !== undefined && fn !== null) {
      if (!isRecord(fn)) {
        throw invalidResponse("tool_call_shape_invalid");
      }
      if (fn.name !== undefined && fn.name !== null) {
        if (typeof fn.name !== "string") {
          throw invalidResponse("tool_call_shape_invalid");
        }
        if (fn.name.length > 0) {
          const previousName = call.name;
          if (call.name === undefined) {
            call.name = fn.name;
          } else if (fn.name === call.name) {
            // Names stream once but some proxies repeat them: identical
            // repeats are tolerated.
          } else if (fn.name.startsWith(call.name)) {
            // Prefix growth (split names): the accumulated name extends.
            call.name = fn.name;
          } else if (call.name.startsWith(fn.name)) {
            // Repeat of an already-subsumed earlier fragment: tolerated.
          } else {
            // Any other name for the same index conflicts: reject the
            // stream instead of combining arguments across tool names.
            throw invalidResponse("tool_call_shape_invalid");
          }
          if (call.name !== previousName) {
            this.draftDirty = true;
            this.toolNameBytes +=
              utf8ByteLength(call.name ?? "") -
              utf8ByteLength(previousName ?? "");
          }
        }
      }
      if (fn.arguments !== undefined && fn.arguments !== null) {
        if (typeof fn.arguments !== "string") {
          throw invalidResponse("tool_call_shape_invalid");
        }
        call.argumentsText += fn.arguments;
        this.toolArgumentBytes += utf8ByteLength(fn.arguments);
        this.draftDirty = true;
        // Incremental size guard with the same per-tool codes as the
        // finalizer once the name is known; unknown-name prefixes stay
        // bounded by the decoded per-call cap until finalize classifies.
        if (call.name !== undefined) {
          assertToolArgumentsByteLengthForTool(
            utf8ByteLength(call.argumentsText),
            call.name,
          );
        }
      }
    }
    if (fn === undefined || fn === null) {
      return null;
    }
    const fnRecord = fn as Record<string, unknown>;
    const argsPiece =
      typeof fnRecord.arguments === "string" ? fnRecord.arguments : "";
    if (argsPiece.length === 0) {
      return null;
    }
    return {
      index,
      name: call.name ?? "",
      argumentsText: argsPiece,
    };
  }
}

/**
 * Best-effort incremental extraction of `parts[].text` string values from a
 * partial JSON arguments prefix. Scans for `"text"` keys and decodes the
 * following JSON string as far as it is complete: complete escape sequences
 * (`\"`, `\\`, `\n`, `\uXXXX`, split surrogate pairs only when both halves
 * arrived) contribute their decoded characters; a trailing incomplete
 * escape (`\`, `\u12`, lone high surrogate at the end) is held back until
 * more bytes arrive. Never throws: unparseable regions contribute nothing.
 */
export function extractPartialPartsText(partialJson: string): string {
  let out = "";
  let cursor = 0;
  let parts = 0;
  for (;;) {
    const keyIndex = partialJson.indexOf('"text"', cursor);
    if (keyIndex === -1) {
      return out;
    }
    let pos = keyIndex + '"text"'.length;
    pos = skipJsonWhitespace(partialJson, pos);
    if (partialJson[pos] !== ":") {
      cursor = pos + 1;
      continue;
    }
    pos = skipJsonWhitespace(partialJson, pos + 1);
    if (partialJson[pos] !== '"') {
      cursor = pos + 1;
      continue;
    }
    const decoded = decodeJsonStringPrefix(partialJson, pos);
    // The authoritative rendering joins `parts[].text` with exactly one
    // blank line (`renderRunResultText` / `renderAnswerText`): mirror the
    // separator between successive text values so the provisional draft
    // suffixes match the final text.
    if (parts > 0) {
      out += "\n\n";
    }
    parts += 1;
    out += decoded.text;
    cursor = decoded.nextCursor;
    if (cursor <= pos) {
      return out;
    }
  }
}

function skipJsonWhitespace(text: string, pos: number): number {
  while (
    pos < text.length &&
    (text[pos] === " " ||
      text[pos] === "\t" ||
      text[pos] === "\n" ||
      text[pos] === "\r")
  ) {
    pos += 1;
  }
  return pos;
}

/**
 * Decode one JSON string starting at the opening quote `pos`. Returns the
 * decoded-so-far text plus the cursor to continue scanning after (past the
 * closing quote when terminated, else end of input). Incomplete trailing
 * escapes are excluded from the text (they will decode on a later call
 * with more bytes); lone trailing high surrogates are likewise held back.
 */
function decodeJsonStringPrefix(
  text: string,
  pos: number,
): { text: string; nextCursor: number } {
  let out = "";
  let i = pos + 1;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === '"') {
      return { text: out, nextCursor: i + 1 };
    }
    if (ch !== "\\") {
      out += ch;
      i += 1;
      continue;
    }
    // Escape sequence: need at least one more char.
    if (i + 1 >= text.length) {
      return { text: out, nextCursor: text.length };
    }
    const esc = text[i + 1] as string;
    if (esc === "u") {
      // Need 4 hex digits.
      if (i + 5 >= text.length) {
        return { text: out, nextCursor: text.length };
      }
      const hex = text.slice(i + 2, i + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
        return { text: out, nextCursor: text.length };
      }
      const code = Number.parseInt(hex, 16);
      if (code >= 0xd800 && code <= 0xdbff) {
        // High surrogate: require the low half now, else hold back.
        if (text[i + 6] !== "\\" || text[i + 7] !== "u") {
          return { text: out, nextCursor: i };
        }
        if (i + 11 >= text.length) {
          return { text: out, nextCursor: i };
        }
        const lowHex = text.slice(i + 8, i + 12);
        if (!/^[0-9a-fA-F]{4}$/.test(lowHex)) {
          return { text: out, nextCursor: i };
        }
        const low = Number.parseInt(lowHex, 16);
        if (low < 0xdc00 || low > 0xdfff) {
          return { text: out, nextCursor: i };
        }
        out += String.fromCharCode(code, low);
        i += 12;
        continue;
      }
      out += String.fromCharCode(code);
      i += 6;
      continue;
    }
    switch (esc) {
      case '"':
        out += '"';
        break;
      case "\\":
        out += "\\";
        break;
      case "/":
        out += "/";
        break;
      case "b":
        out += "\b";
        break;
      case "f":
        out += "\f";
        break;
      case "n":
        out += "\n";
        break;
      case "r":
        out += "\r";
        break;
      case "t":
        out += "\t";
        break;
      default:
        // Invalid escape: stop this string (unvalidated provisional text).
        return { text: out, nextCursor: text.length };
    }
    i += 2;
  }
  return { text: out, nextCursor: text.length };
}

/**
 * POST a `stream:true` chat body and feed parsed SSE `data:` JSON values to
 * `onChunkBody` until `data: [DONE]`. Transport guards mirror
 * `postJsonNoRedirect`: loopback revalidation, `redirect: "error"`, single
 * attempt, composed external-signal + `timeoutMs` abort, bounded raw bytes
 * (the decoded per-call cap retains the raw-capture prefix; the much larger
 * MAX_STREAM_WIRE_BYTES bounds transport), fixed redacted errors. Non-2xx
 * statuses drain within the decoded per-call cap and reject as
 * `request_failed` with the status.
 * External cancellation rethrows the original abort rejection untouched.
 * The optional `onRawResponse` observer receives the status plus the exact
 * received SSE bytes decoded (bounded by the decoded per-call cap) exactly
 * once per
 * call: after a completed stream before normalization, before a malformed
 * chunk / invalid-response failure, and after a non-2xx body is drained.
 * Headers are never included. Cancellation (external abort or timeout) does
 * NOT invoke it: a cancelled response is not a provider response, and the
 * abort outcome stays byte-for-byte unchanged. Declared-oversize bodies are
 * rejected before reading and therefore have no received bytes to report.
 */
export async function postChatCompletionStream(options: {
  fetchImpl: FetchImpl;
  url: string;
  body: unknown;
  apiKey: string | undefined;
  timeoutMs: number | undefined;
  signal?: AbortSignal;
  maxResponseBytes?: number;
  /** Raw SSE-body observer invoked at most once, before normalization. */
  onRawResponse?: (response: RawHttpResponse) => void;
  onChunkBody: (body: unknown) => void;
}): Promise<void> {
  const safeUrl = assertPinnedLoopbackFetchUrl(options.url);
  // The caller's effective cap bounds the DECODED payload (enforced by the
  // accumulator); the raw SSE wire only has the much larger transport bound.
  const decodedLimit = resolveResponseByteLimit(options.maxResponseBytes);
  const wireLimit = MAX_STREAM_WIRE_BYTES;
  const externalSignal = options.signal;
  if (isAborted(externalSignal)) {
    throw toAbortRejection(externalSignal as AbortSignal);
  }
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
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
  try {
    let response: Response;
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
        throw error;
      }
      throw mapFetchRejection(error);
    }
    const requestFailed = (status: number): ModelLocalError =>
      new ModelLocalError(
        "request_failed",
        `model request failed with status ${status}`,
        undefined,
        { httpStatus: status },
      );
    const rawCapture = new RawSseCapture(
      response.status,
      decodedLimit,
      options.onRawResponse,
    );
    const declared = parseDeclaredContentLength(response);
    // A successful SSE body may legitimately exceed the decoded cap because
    // of framing, so only the wire bound applies there. Non-2xx bodies keep
    // the decoded per-call cap exactly as before.
    if (
      declared !== undefined &&
      declared > (response.ok ? wireLimit : decodedLimit)
    ) {
      cancelBody(response);
      if (!response.ok) {
        throw requestFailed(response.status);
      }
      throw new ModelLocalError(
        "invalid_response",
        "model returned an oversized response",
        undefined,
        { invalidResponseCause: "response_too_large" },
      );
    }
    if (!response.ok) {
      await drainBounded(
        response,
        controller,
        externalSignal,
        decodedLimit,
        rawCapture,
      );
      // Non-2xx bodies are reported before the fixed status failure is
      // thrown, mirroring `postJsonNoRedirect`. An abort/deadline during
      // the drain skips this (drainBounded throws first).
      rawCapture.emit();
      throw requestFailed(response.status);
    }
    // A successful streaming response must actually be SSE. A JSON/HTML
    // content type means the endpoint/provider did not stream: fail closed
    // with a fixed cause instead of parsing arbitrary bytes as SSE lines.
    const contentType = response.headers.get("content-type");
    if (
      contentType !== null &&
      !contentType.trim().toLowerCase().startsWith("text/event-stream")
    ) {
      cancelBody(response);
      throw invalidResponse("unexpected_content_type");
    }
    await readSseStream(
      response,
      controller,
      externalSignal,
      wireLimit,
      rawCapture,
      options.onChunkBody,
    );
    // Completed stream: report the exact received bytes before the caller
    // normalizes them (streamOpenAIChat calls normalizeOpenAIResponse after
    // this returns).
    rawCapture.emit();
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
 * Incrementally read an SSE response: split raw bytes at LF (0x0A never
 * occurs inside a UTF-8 multibyte sequence), fatal-decode each complete
 * line so malformed UTF-8 rejects as `invalid_response` exactly like the
 * non-streaming path, and dispatch `data:` events. `data: [DONE]`
 * terminates; anything after it rejects as `invalid_response`.
 */
async function readSseStream(
  response: Response,
  controller: AbortController,
  externalSignal: AbortSignal | undefined,
  wireLimit: number,
  rawCapture: RawSseCapture,
  onChunkBody: (body: unknown) => void,
): Promise<void> {
  if (isAborted(externalSignal)) {
    throw toAbortRejection(externalSignal as AbortSignal);
  }
  const stream = response.body;
  if (stream === null) {
    // No body bytes were received; still expose the status before failing
    // so an empty/malformed HTTP response is observable.
    rawCapture.emit();
    throw invalidResponse("stream_incomplete");
  }
  const reader = stream.getReader() as unknown as {
    read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>;
    cancel(reason?: unknown): Promise<void>;
    releaseLock(): void;
  };
  const onControllerAbort = (): void => {
    cancelQuietly(reader, "aborted");
  };
  controller.signal.addEventListener("abort", onControllerAbort, {
    once: true,
  });
  const fatalDecoder = new TextDecoder("utf-8", { fatal: true });
  let pending: number[] = [];
  let totalBytes = 0;
  let dataLines: string[] = [];
  let seenDone = false;
  const fail = (error: unknown): never => {
    if (isAborted(externalSignal)) {
      throw toAbortRejection(externalSignal as AbortSignal);
    }
    if (controller.signal.aborted) {
      throw new ModelLocalError("timeout", "model request timed out");
    }
    throw error;
  };
  const decodeLine = (raw: Uint8Array): string => {
    try {
      return fatalDecoder.decode(raw);
    } catch {
      cancelQuietly(reader, "bad encoding");
      return fail(invalidResponse("sse_line_invalid"));
    }
  };
  const readNext = async (): Promise<{
    done: boolean;
    value?: Uint8Array | undefined;
  }> => {
    try {
      return await reader.read();
    } catch (error) {
      return fail(
        connectionFailureError(error) ?? invalidResponse("sse_line_invalid"),
      );
    }
  };
  // Chunk validation / consumer failure: cancel the body and abort the
  // request BEFORE propagating, so the model stops generating a response
  // nobody will read (no retained connection or compute after the gateway
  // has already failed).
  const dispatchWithCleanup = (lines: string[]): void => {
    try {
      dispatchEvent(lines, onChunkBody, () => {
        seenDone = true;
      });
    } catch (error) {
      cancelQuietly(reader, "chunk error");
      try {
        controller.abort();
      } catch {
        // Best effort: cancellation must never mask the chunk error.
      }
      throw error;
    }
  };
  try {
    for (;;) {
      const current = await readNext();
      if (current.done) {
        if (isAborted(externalSignal)) {
          throw toAbortRejection(externalSignal as AbortSignal);
        }
        if (controller.signal.aborted) {
          throw new ModelLocalError("timeout", "model request timed out");
        }
        break;
      }
      const value = current.value;
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
      // Retain at most the decoded per-call cap; an overflowing chunk
      // contributes only the prefix that fits (bounded raw observation).
      rawCapture.push(value);
      if (totalBytes > wireLimit) {
        cancelQuietly(reader, "exceeds wire limit");
        fail(
          new ModelLocalError(
            "invalid_response",
            "model returned an oversized response",
            undefined,
            { invalidResponseCause: "response_too_large" },
          ),
        );
      }
      for (let i = 0; i < value.byteLength; i += 1) {
        const byte = value[i] as number;
        if (byte === 0x0a) {
          const lineBytes = new Uint8Array(pending);
          pending = [];
          const line = decodeLine(lineBytes);
          // `line` assigned or `fail` threw.
          const text = line.endsWith("\r") ? line.slice(0, -1) : line;
          if (seenDone) {
            cancelQuietly(reader, "trailing data");
            fail(invalidResponse("trailing_data"));
          }
          if (text === "") {
            dispatchWithCleanup(dataLines);
            dataLines = [];
          } else if (text.startsWith(":")) {
            // SSE comment / heartbeat: ignored.
          } else if (text.startsWith("data:")) {
            const payload = text.slice("data:".length);
            dataLines.push(
              payload.startsWith(" ") ? payload.slice(1) : payload,
            );
          } else {
            // Unknown SSE field (`event:`, `id:`, `retry:`): providers may
            // send them; only `data:` carries chunks. Ignored strictly
            // (never an error, never state).
          }
        } else {
          pending.push(byte);
        }
      }
    }
    // Trailing bytes without a final LF form one last line.
    if (pending.length > 0) {
      const line = decodeLine(new Uint8Array(pending));
      const text = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (text.startsWith("data:")) {
        const payload = text.slice("data:".length);
        dataLines.push(payload.startsWith(" ") ? payload.slice(1) : payload);
      }
      pending = [];
    }
    if (dataLines.length > 0) {
      if (seenDone) {
        fail(invalidResponse("trailing_data"));
      }
      dispatchWithCleanup(dataLines);
    }
    if (isAborted(externalSignal)) {
      throw toAbortRejection(externalSignal as AbortSignal);
    }
    if (controller.signal.aborted) {
      throw new ModelLocalError("timeout", "model request timed out");
    }
    if (!seenDone) {
      // EOF before the `data: [DONE]` sentinel: a truncated stream must
      // never be normalized into a successful ChatResult (a partial tool
      // call could otherwise execute). Abort/timeout keep priority above.
      throw invalidResponse("stream_incomplete");
    }
  } catch (error) {
    // Malformed chunk / invalid-response failures report the bytes received
    // so far before propagating, so the private record can explain the
    // failure. Cancellation (external abort or timeout) deliberately emits
    // nothing: the raw observer only describes provider responses, and the
    // abort rejection stays untouched. A chunk error cancels the request
    // controller, but that internal cleanup must not suppress this report.
    const timedOut =
      error instanceof ModelLocalError && error.code === "timeout";
    if (!isAborted(externalSignal) && !timedOut) {
      rawCapture.emit();
    }
    throw error;
  } finally {
    controller.signal.removeEventListener("abort", onControllerAbort);
    try {
      reader.releaseLock();
    } catch {
      // Best effort: the stream is already cancelled or consumed.
    }
  }
}

/** Dispatch one buffered SSE event to the chunk consumer. */
function dispatchEvent(
  dataLines: string[],
  onChunkBody: (body: unknown) => void,
  onDone: () => void,
): void {
  if (dataLines.length === 0) {
    return;
  }
  const data = dataLines.join("\n");
  if (data === "[DONE]") {
    onDone();
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new ModelLocalError(
      "invalid_response",
      "model returned an invalid response",
      undefined,
      { invalidResponseCause: "malformed_json" },
    );
  }
  onChunkBody(parsed);
}

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

function cancelBody(response: Response): void {
  let pending: Promise<void> | undefined;
  try {
    pending = response.body?.cancel();
  } catch {
    return;
  }
  if (pending !== undefined) {
    void pending.catch(() => {});
  }
}

function cancelQuietly(
  reader: { cancel(reason?: unknown): Promise<void> },
  reason: string,
): void {
  let pending: Promise<void> | undefined;
  try {
    pending = reader.cancel(new DOMException(reason, "AbortError"));
  } catch {
    return;
  }
  if (pending !== undefined) {
    void pending.catch(() => {});
  }
}

async function drainBounded(
  response: Response,
  controller: AbortController,
  externalSignal: AbortSignal | undefined,
  limit: number,
  rawCapture: RawSseCapture,
): Promise<void> {
  const stream = response.body;
  if (stream === null) {
    return;
  }
  const reader = (
    stream as ReadableStream<Uint8Array>
  ).getReader() as unknown as {
    read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>;
    cancel(reason?: unknown): Promise<void>;
    releaseLock(): void;
  };
  // Wire BOTH abort sources to cancel the reader: a reader implementation
  // not coupled to the fetch signal must never stay pending after a
  // cancellation or deadline (the fetch signal alone cannot cancel it).
  const onExternalAbort = (): void => {
    cancelQuietly(reader, "aborted");
  };
  const onControllerAbort = (): void => {
    cancelQuietly(reader, "aborted");
  };
  if (externalSignal !== undefined) {
    externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }
  controller.signal.addEventListener("abort", onControllerAbort, {
    once: true,
  });
  // Abort semantics match the successful-response reader: external
  // cancellation propagates the original abort rejection untouched and a
  // deadline surfaces as `timeout` — the caller's HTTP-status
  // `request_failed` classification only applies when the drain completes
  // (a drainBounded throw replaces it).
  const classifyAbort = (error?: unknown): never => {
    if (isAborted(externalSignal)) {
      throw toAbortRejection(externalSignal as AbortSignal);
    }
    if (controller.signal.aborted) {
      throw new ModelLocalError("timeout", "model request timed out");
    }
    throw (
      connectionFailureError(error) ??
      new ModelLocalError("transport_error", "model transport failed")
    );
  };
  let total = 0;
  try {
    for (;;) {
      let next: { done: boolean; value?: Uint8Array | undefined };
      try {
        next = await reader.read();
      } catch (error) {
        // A read rejected because an abort/deadline landed mid-drain:
        // classify it instead of swallowing into the status error.
        classifyAbort(error);
        return;
      }
      if (next.done || next.value === undefined) {
        // A reader cancelled by an abort/deadline resolves `done` instead
        // of rejecting (cancel() closes the stream): classify the abort
        // before treating it as a completed drain.
        if (isAborted(externalSignal) || controller.signal.aborted) {
          classifyAbort();
        }
        return;
      }
      total += next.value.byteLength;
      // Same bounded capture as the successful reader: retain only bytes
      // within the per-call cap (overflow keeps the fitting prefix).
      rawCapture.push(next.value);
      if (total > limit) {
        cancelQuietly(reader, "exceeds limit");
        return;
      }
    }
  } finally {
    if (externalSignal !== undefined) {
      externalSignal.removeEventListener("abort", onExternalAbort);
    }
    controller.signal.removeEventListener("abort", onControllerAbort);
    try {
      reader.releaseLock();
    } catch {
      // Best effort.
    }
  }
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

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
    return new ModelLocalError("timeout", "model request timed out");
  }
  return (
    connectionFailureError(error) ??
    new ModelLocalError("transport_error", "model transport failed")
  );
}

export type { ModelStreamDelta, ModelStreamDeltaCallback };
