// PR-2 streaming support for the OpenAI-compatible adapter.
//
// `stream:true` SSE parsing that accumulates `content`, `reasoning_content`
// and `tool_calls` argument deltas into the same normal form the
// non-streaming path validates, so downstream tool-loop / answer.submit
// validation is unchanged. Provisional per-chunk pieces are surfaced via
// the optional delta callback only (never validated, never persisted).
//
// Bounds: the effective per-call byte cap (min(maxResponseBytes,
// MAX_RESPONSE_BYTES)) applies to raw SSE bytes; accumulated text honors
// MAX_MESSAGE_CONTENT_LENGTH and per-tool arguments honor
// MAX_TOOL_CALL_ARGUMENTS_BYTES with the same redacted error classes as
// the non-streaming path (`invalid_response`, `tool_call_invalid`,
// `answer_invalid`). Step/wall timeouts arrive via the caller AbortSignal
// (120s step / 300s wall owned by the kernel); external cancellation
// rethrows the original abort rejection untouched. Malformed chunks reject
// as `invalid_response` (same class as today). No retry, no fallback, no
// redirect following, no logging of bodies/prompts/reasoning.

import { assertPinnedLoopbackFetchUrl } from "./base_url.js";
import { ModelLocalError } from "./errors.js";
import {
  assertAssistantTextWithinBound,
  assertToolArgumentsByteLengthForTool,
  assertToolCallCountWithinBound,
  isAnswerSubmitTool,
  isRecord,
  MAX_MESSAGE_CONTENT_LENGTH,
  MAX_TOOL_CALLS_PER_MESSAGE,
  resolveResponseByteLimit,
  utf8ByteLength,
} from "./gateway.js";
import type {
  FetchImpl,
  ModelStreamDelta,
  ModelStreamDeltaCallback,
} from "./types.js";

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
 * would produce; otherwise the finalizer classifies it.
 */
export class OpenAIStreamAccumulator {
  private content = "";
  private reasoning = "";
  private readonly tools = new Map<number, AccumulatedToolCall>();
  private finishReason = "";
  private rawUsage: unknown = undefined;
  private seenUsage = false;
  private done = false;

  /** Append one parsed chunk body; returns the provisional pieces. */
  pushChunkBody(body: unknown): StreamChunkPieces {
    if (this.done) {
      throw new ModelLocalError(
        "invalid_response",
        "model returned an invalid response",
      );
    }
    if (!isRecord(body)) {
      throw new ModelLocalError(
        "invalid_response",
        "model returned an invalid response",
      );
    }
    if (body.message !== undefined) {
      // Non-streaming shape inside a stream: wrong envelope for this path.
      throw new ModelLocalError(
        "invalid_response",
        "model returned an invalid response",
      );
    }
    const choices = body.choices;
    if (!Array.isArray(choices)) {
      throw new ModelLocalError(
        "invalid_response",
        "model returned an invalid response",
      );
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
        throw new ModelLocalError(
          "invalid_response",
          "model returned an invalid response",
        );
      }
      if (choice.message !== undefined) {
        // Non-streaming `message` shape inside a stream chunk: wrong
        // envelope for this path (stream chunks carry `delta` only).
        throw new ModelLocalError(
          "invalid_response",
          "model returned an invalid response",
        );
      }
      if (
        choice.finish_reason !== undefined &&
        choice.finish_reason !== null &&
        typeof choice.finish_reason !== "string"
      ) {
        throw new ModelLocalError(
          "invalid_response",
          "model returned an invalid response",
        );
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
        throw new ModelLocalError(
          "invalid_response",
          "model returned an invalid response",
        );
      }
      if (
        delta.content !== undefined &&
        delta.content !== null &&
        typeof delta.content !== "string"
      ) {
        throw new ModelLocalError(
          "invalid_response",
          "model returned an invalid response",
        );
      }
      if (typeof delta.content === "string" && delta.content.length > 0) {
        this.content += delta.content;
        contentPiece += delta.content;
        assertAssistantTextWithinBound(this.content);
      }
      if (
        delta.reasoning_content !== undefined &&
        delta.reasoning_content !== null &&
        typeof delta.reasoning_content !== "string"
      ) {
        throw new ModelLocalError(
          "invalid_response",
          "model returned an invalid response",
        );
      }
      if (
        typeof delta.reasoning_content === "string" &&
        delta.reasoning_content.length > 0
      ) {
        this.reasoning += delta.reasoning_content;
        reasoningPiece += delta.reasoning_content;
        // Same character bound as assistant text: reasoning buffers stay
        // finite under the identical redacted code.
        if (this.reasoning.length > MAX_MESSAGE_CONTENT_LENGTH) {
          throw new ModelLocalError(
            "invalid_response",
            "model returned an invalid response",
          );
        }
      }
      if (delta.tool_calls !== undefined && delta.tool_calls !== null) {
        if (!Array.isArray(delta.tool_calls)) {
          throw new ModelLocalError(
            "invalid_response",
            "model returned an invalid response",
          );
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
        throw new ModelLocalError(
          "invalid_response",
          "model returned an invalid response",
        );
      }
      // Terminal usage summary (present only with
      // `stream_options.include_usage`); validated at finalize through the
      // shared usage extractor so counts keep the same classes.
      this.rawUsage = body.usage;
      this.seenUsage = true;
    }
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
      throw new ModelLocalError(
        "invalid_response",
        "model returned an invalid response",
      );
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
    const ordered = [...this.tools.entries()].sort((a, b) => a[0] - b[0]);
    let draft = "";
    for (const [, call] of ordered) {
      if (call.name === undefined || !isAnswerSubmitTool(call.name)) {
        continue;
      }
      draft += extractPartialPartsText(call.argumentsText);
    }
    return draft;
  }

  private appendToolCallDelta(entry: unknown): {
    index: number;
    name: string;
    argumentsText: string;
  } | null {
    if (!isRecord(entry)) {
      throw new ModelLocalError(
        "invalid_response",
        "model returned an invalid response",
      );
    }
    const index = entry.index;
    if (
      typeof index !== "number" ||
      !Number.isSafeInteger(index) ||
      index < 0
    ) {
      throw new ModelLocalError(
        "invalid_response",
        "model returned an invalid response",
      );
    }
    let call = this.tools.get(index);
    if (call === undefined) {
      if (this.tools.size >= MAX_TOOL_CALLS_PER_MESSAGE) {
        throw new ModelLocalError(
          "invalid_response",
          "model returned an invalid response",
        );
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
        throw new ModelLocalError(
          "invalid_response",
          "model returned an invalid response",
        );
      }
      if (!call.seenId) {
        call.id = entry.id;
        call.seenId = true;
      } else if (call.id !== entry.id) {
        throw new ModelLocalError(
          "invalid_response",
          "model returned an invalid response",
        );
      }
    }
    if (entry.type !== undefined && entry.type !== null) {
      if (typeof entry.type !== "string") {
        throw new ModelLocalError(
          "invalid_response",
          "model returned an invalid response",
        );
      }
      if (call.type === undefined) {
        call.type = entry.type;
      } else if (call.type !== entry.type) {
        throw new ModelLocalError(
          "invalid_response",
          "model returned an invalid response",
        );
      }
    }
    const fn = entry.function;
    if (fn !== undefined && fn !== null) {
      if (!isRecord(fn)) {
        throw new ModelLocalError(
          "invalid_response",
          "model returned an invalid response",
        );
      }
      if (fn.name !== undefined && fn.name !== null) {
        if (typeof fn.name !== "string") {
          throw new ModelLocalError(
            "invalid_response",
            "model returned an invalid response",
          );
        }
        if (fn.name.length > 0) {
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
            throw new ModelLocalError(
              "invalid_response",
              "model returned an invalid response",
            );
          }
        }
      }
      if (fn.arguments !== undefined && fn.arguments !== null) {
        if (typeof fn.arguments !== "string") {
          throw new ModelLocalError(
            "invalid_response",
            "model returned an invalid response",
          );
        }
        call.argumentsText += fn.arguments;
        // Incremental size guard with the same per-tool codes as the
        // finalizer once the name is known; unknown-name prefixes stay
        // bounded by the shared raw SSE byte cap until finalize classifies.
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
 * (effective per-call cap), fixed redacted errors. Non-2xx statuses drain
 * within the same bound and reject as `request_failed` with the status.
 * External cancellation rethrows the original abort rejection untouched.
 */
export async function postChatCompletionStream(options: {
  fetchImpl: FetchImpl;
  url: string;
  body: unknown;
  apiKey: string | undefined;
  timeoutMs: number | undefined;
  signal?: AbortSignal;
  maxResponseBytes?: number;
  onChunkBody: (body: unknown) => void;
}): Promise<void> {
  const safeUrl = assertPinnedLoopbackFetchUrl(options.url);
  const limit = resolveResponseByteLimit(options.maxResponseBytes);
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
      );
    const declared = parseDeclaredContentLength(response);
    if (declared !== undefined && declared > limit) {
      cancelBody(response);
      if (!response.ok) {
        throw requestFailed(response.status);
      }
      throw new ModelLocalError(
        "invalid_response",
        "model returned an oversized response",
      );
    }
    if (!response.ok) {
      await drainBounded(response, controller, externalSignal, limit);
      throw requestFailed(response.status);
    }
    await readSseStream(
      response,
      controller,
      externalSignal,
      limit,
      options.onChunkBody,
    );
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
  limit: number,
  onChunkBody: (body: unknown) => void,
): Promise<void> {
  if (isAborted(externalSignal)) {
    throw toAbortRejection(externalSignal as AbortSignal);
  }
  const stream = response.body;
  if (stream === null) {
    throw new ModelLocalError(
      "invalid_response",
      "model returned an invalid response",
    );
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
      return fail(
        new ModelLocalError(
          "invalid_response",
          "model returned an invalid response",
        ),
      );
    }
  };
  const readNext = async (): Promise<{
    done: boolean;
    value?: Uint8Array | undefined;
  }> => {
    try {
      return await reader.read();
    } catch {
      return fail(
        new ModelLocalError(
          "invalid_response",
          "model returned an invalid response",
        ),
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
      if (totalBytes > limit) {
        cancelQuietly(reader, "exceeds limit");
        fail(
          new ModelLocalError(
            "invalid_response",
            "model returned an oversized response",
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
            fail(
              new ModelLocalError(
                "invalid_response",
                "model returned an invalid response",
              ),
            );
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
        fail(
          new ModelLocalError(
            "invalid_response",
            "model returned an invalid response",
          ),
        );
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
  const classifyAbort = (): never => {
    if (isAborted(externalSignal)) {
      throw toAbortRejection(externalSignal as AbortSignal);
    }
    if (controller.signal.aborted) {
      throw new ModelLocalError("timeout", "model request timed out");
    }
    throw new ModelLocalError("transport_error", "model transport failed");
  };
  let total = 0;
  try {
    for (;;) {
      let next: { done: boolean; value?: Uint8Array | undefined };
      try {
        next = await reader.read();
      } catch {
        // A read rejected because an abort/deadline landed mid-drain:
        // classify it instead of swallowing into the status error.
        classifyAbort();
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
  return new ModelLocalError("transport_error", "model transport failed");
}

export type { ModelStreamDelta, ModelStreamDeltaCallback };
