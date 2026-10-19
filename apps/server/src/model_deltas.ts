// PR-2 ephemeral model deltas (SSE-only broadcast, never persisted).
//
// Persistence decision: deltas NEVER touch the events table — they are
// broadcast on the run SSE stream only (SSE-only, not replayed, JSON
// fallback polling reads durable rows and ignores them). Only the existing
// durable events are persisted, so the events budget is untouched. Delta
// envelopes carry `seq: 0` (never a cursor) and the SSE wire omits the
// `id:` line so `Last-Event-ID` reconnects never land on an ephemeral row.
//
// Coalescing bounds SSE traffic: per-run `reasoning` / `draft` text pieces
// flush at most every 50ms or every 256 chars (whichever first); `usage`
// passes through immediately (one per step). Payload contents (reasoning,
// draft text) are never logged.
//
// This module owns formatting + coalescing; `sse.ts` owns transport.

import {
  ANSWER_DRAFT_DELTA_EVENT_TYPE,
  MODEL_REASONING_DELTA_EVENT_TYPE,
  MODEL_USAGE_EVENT_TYPE,
  type ModelDeltaEvent,
  ModelDeltaEventSchema,
} from "@companion/contracts";

/** Coalescing bounds: flush interval and per-flush text budget. */
export const MODEL_DELTA_COALESCE_MS = 50;
export const MODEL_DELTA_COALESCE_CHARS = 256;

/** Max text carried by one emitted delta envelope (contracts bound). */
const MAX_DELTA_TEXT = 65_536;

export type DeltaTextKind = "reasoning" | "draft";

export interface DeltaPiece {
  readonly runId: string;
  readonly step: number;
  readonly kind: DeltaTextKind;
  readonly text: string;
  readonly now: number;
}

export interface DeltaUsage {
  readonly runId: string;
  readonly step: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly elapsedMs: number;
  readonly now: number;
}

/** Pre-formatted SSE chunk subscriber (one per open run stream). */
export type DeltaChunkListener = (chunk: string) => void;

/** Minimal timers surface (injectable for tests; defaults to globals). */
export interface DeltaTimers {
  now?: () => number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}

/**
 * Format one ephemeral delta as SSE bytes (plan §16.4 shape, minus `id`):
 * `event` stays `run-event` so existing subscriptions receive deltas;
 * `data` is the full delta DTO as one JSON line. No `id:` line is emitted
 * (ephemeral `seq: 0` is never a cursor).
 */
export function formatModelDeltaSse(event: ModelDeltaEvent): string {
  const data = JSON.stringify({
    schemaVersion: event.schemaVersion,
    runId: event.runId,
    seq: event.seq,
    type: event.type,
    createdAt: event.createdAt,
    payload: event.payload,
  });
  return `event: run-event\ndata: ${data}\n\n`;
}

/**
 * Ephemeral per-run delta bus. `publishPiece` coalesces text per
 * run+kind+step (steps never merge); `publishUsage` flushes the run's
 * pending text buffers, then emits immediately. Invalid envelopes are
 * dropped (never throw into the strategy, never logged with content).
 * Nothing here writes to the DB.
 */
export class ModelDeltaBus {
  private readonly listeners = new Map<string, Set<DeltaChunkListener>>();
  private readonly buffers = new Map<
    string,
    {
      text: string;
      timer: ReturnType<typeof setTimeout> | undefined;
    }
  >();
  private readonly now: () => number;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;

  constructor(timers: DeltaTimers = {}) {
    this.now = timers.now ?? Date.now;
    this.setTimeoutFn = timers.setTimeout ?? setTimeout;
    this.clearTimeoutFn = timers.clearTimeout ?? clearTimeout;
  }

  /** Subscribe one SSE stream to a run's deltas; returns unsubscribe. */
  subscribe(runId: string, listener: DeltaChunkListener): () => void {
    let set = this.listeners.get(runId);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(runId, set);
    }
    set.add(listener);
    return () => {
      const current = this.listeners.get(runId);
      if (current === undefined) {
        return;
      }
      current.delete(listener);
      if (current.size === 0) {
        this.listeners.delete(runId);
      }
    };
  }

  /** Buffer one text piece; flushes at the coalescing bounds. */
  publishPiece(piece: DeltaPiece): void {
    if (piece.text.length === 0) {
      return;
    }
    // Key includes the step: adjacent model steps never share a buffer, so
    // one flush can never concatenate text from two steps while stamping
    // it all with the later step number.
    const key = `${piece.runId}\n${piece.kind}\n${piece.step}`;
    let buffer = this.buffers.get(key);
    if (buffer === undefined) {
      buffer = { text: "", timer: undefined };
      this.buffers.set(key, buffer);
    }
    buffer.text += piece.text;
    if (buffer.text.length >= MODEL_DELTA_COALESCE_CHARS) {
      this.flushKey(key);
      return;
    }
    if (buffer.timer === undefined) {
      buffer.timer = this.setTimeoutFn(() => {
        this.flushKey(key);
      }, MODEL_DELTA_COALESCE_MS);
    }
  }

  /** Emit one terminal usage summary immediately (one per step). */
  publishUsage(usage: DeltaUsage): void {
    // Terminal usage ends the run: flush this run's pending text buffers
    // FIRST so a short final reasoning/draft piece is never stranded
    // behind its 50ms timer while the SSE poll closes on the usage event
    // (a connected client would miss the tail of the text).
    this.flush(usage.runId);
    const event = this.buildEvent(
      usage.runId,
      MODEL_USAGE_EVENT_TYPE,
      {
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        elapsedMs: usage.elapsedMs,
      },
      usage.now,
    );
    // Usage steps are 1-based ordinals; out-of-range steps drop (never
    // throw into the strategy).
    if (event === null) {
      return;
    }
    this.emit(usage.runId, event);
  }

  /** Flush buffered pieces now (tests / drain); no-op when empty. */
  flush(runId?: string): void {
    for (const key of [...this.buffers.keys()]) {
      if (runId !== undefined && !key.startsWith(`${runId}\n`)) {
        continue;
      }
      this.flushKey(key);
    }
  }

  private flushKey(key: string): void {
    const first = key.indexOf("\n");
    const second = key.indexOf("\n", first + 1);
    if (first === -1 || second === -1) {
      return;
    }
    this.flushBuffer(
      key.slice(0, first),
      key.slice(first + 1, second) as DeltaTextKind,
      Number(key.slice(second + 1)),
    );
  }

  private flushBuffer(runId: string, kind: DeltaTextKind, step: number): void {
    const key = `${runId}\n${kind}\n${step}`;
    const buffer = this.buffers.get(key);
    if (buffer === undefined || buffer.text.length === 0) {
      if (buffer?.timer !== undefined) {
        this.clearTimeoutFn(buffer.timer);
        buffer.timer = undefined;
      }
      return;
    }
    if (buffer.timer !== undefined) {
      this.clearTimeoutFn(buffer.timer);
      buffer.timer = undefined;
    }
    const text = buffer.text;
    buffer.text = "";
    this.buffers.delete(key);
    const type =
      kind === "reasoning"
        ? MODEL_REASONING_DELTA_EVENT_TYPE
        : ANSWER_DRAFT_DELTA_EVENT_TYPE;
    // Chunk over-long buffers to the contracts text bound (provisional
    // display only; the validated answer is unaffected).
    for (let offset = 0; offset < text.length; offset += MAX_DELTA_TEXT) {
      const event = this.buildEvent(
        runId,
        type,
        { step, text: text.slice(offset, offset + MAX_DELTA_TEXT) },
        this.now(),
      );
      if (event === null) {
        return;
      }
      this.emit(runId, event);
    }
  }

  private buildEvent(
    runId: string,
    type: ModelDeltaEvent["type"],
    payload: unknown,
    now: number,
  ): ModelDeltaEvent | null {
    try {
      return ModelDeltaEventSchema.parse({
        schemaVersion: 1,
        runId,
        seq: 0,
        createdAt: now,
        type,
        payload,
      });
    } catch {
      // Invalid delta (bad step/count): dropped, never surfaced with content.
      return null;
    }
  }

  private emit(runId: string, event: ModelDeltaEvent): void {
    const set = this.listeners.get(runId);
    if (set === undefined || set.size === 0) {
      return;
    }
    const chunk = formatModelDeltaSse(event);
    for (const listener of [...set]) {
      try {
        listener(chunk);
      } catch {
        // Best effort: a slow/closed stream never breaks the bus.
      }
    }
  }
}
