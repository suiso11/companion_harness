// M3 per-run client reducer (plan §16.4, exact).
//
// - Events of one Run are applied strictly serialized, in seq order.
// - Duplicate seq is ignored (cursor unchanged).
// - Unknown event types advance the cursor only (no crash, no error UI).
// - A seq gap signals catch-up via the M0 JSON pagination API before SSE
//   continues; the gap event itself is not applied.
// - The cursor is persisted only after the reducer has applied the event
//   (never before); persistence is the caller's job via `persistCursor`.

/** User-visible Run state (plan §16.2 fixed mapping, no tech vocabulary). */
export type VisibleRunStatus =
  | "generating"
  | "answered"
  | "failed"
  | "stopped";

export interface AnswerPartView {
  readonly text: string;
  readonly citations: readonly string[];
}

export interface RunViewState {
  /** Highest applied seq. Persist only after apply (§16.4). */
  readonly cursor: number;
  readonly visible: VisibleRunStatus;
  /** StructuredAnswer parts once `run.completed` arrives. */
  readonly answer: readonly AnswerPartView[];
  /** Failure-only retry (§16.6): failed/abandoned views only. */
  readonly retryVisible: boolean;
  /** Contextual stop (§16.6): active runs only. */
  readonly stopVisible: boolean;
  /** Last visible message ("生成中", answer head, failure, "停止しました"). */
  readonly notice: string;
}

export interface ReducerInputEvent {
  readonly seq: number;
  readonly type: string;
  readonly payload: unknown;
}

export type ReducerOutcome =
  | { readonly kind: "applied" }
  | { readonly kind: "ignored-duplicate" }
  | { readonly kind: "ignored-unknown" }
  | { readonly kind: "needs-catchup"; readonly expectedSeq: number };

export const INITIAL_RUN_VIEW: RunViewState = {
  cursor: 0,
  visible: "generating",
  answer: [],
  retryVisible: false,
  stopVisible: true,
  notice: "生成中",
};

/** Known non-final extension types: no visible change (plan §16.2). */
const SILENT_TYPES: ReadonlySet<string> = new Set([
  "tool.requested",
  "tool.completed",
  "reference.presented",
  "model.step.started",
  "model.step.completed",
  "model.step.failed",
]);

/**
 * Map a durable RunResult (exact contracts shape) to answer part views:
 * - V1 (`{ version: 1, text }`, historical M0/M1 rows): the rendered text
 *   as a single citation-less part.
 * - V2 (`{ version: 2, text, answer: { version, parts } }`): the exact
 *   part-to-citations mapping of the nested StructuredAnswer.
 * Any other shape yields no parts (never crashes the reducer).
 */
export function runResultToAnswerParts(result: unknown): AnswerPartView[] {
  if (typeof result !== "object" || result === null) {
    return [];
  }
  const record = result as { version?: unknown; text?: unknown; answer?: unknown };
  if (record.version === 2) {
    const answer = record.answer as { parts?: unknown } | undefined;
    const parts = answer?.parts;
    if (!Array.isArray(parts)) {
      return [];
    }
    const out: AnswerPartView[] = [];
    for (const part of parts) {
      if (typeof part !== "object" || part === null) {
        continue;
      }
      const entry = part as { text?: unknown; citations?: unknown };
      if (typeof entry.text !== "string") {
        continue;
      }
      const citations = Array.isArray(entry.citations)
        ? entry.citations.filter(
            (citation): citation is string => typeof citation === "string",
          )
        : [];
      out.push({ text: entry.text, citations });
    }
    return out;
  }
  // V1: text only, no structured citations exist in that shape.
  if (record.version === 1 && typeof record.text === "string") {
    return [{ text: record.text, citations: [] }];
  }
  return [];
}

/**
 * `run.completed` payload (exact contracts shape): `{ result: RunResult }`.
 */
function readAnswerParts(payload: unknown): AnswerPartView[] {
  if (typeof payload !== "object" || payload === null) {
    return [];
  }
  const result = (payload as { result?: unknown }).result;
  return runResultToAnswerParts(result);
}

/**
 * Apply one RunEvent to the view. Pure: no DOM, no I/O, no persistence.
 * The caller must serialize calls per Run and persist `cursor` afterwards.
 */
export function applyRunEvent(
  state: RunViewState,
  event: ReducerInputEvent,
): { readonly state: RunViewState; readonly outcome: ReducerOutcome } {
  if (!Number.isInteger(event.seq) || event.seq <= 0) {
    return {
      state,
      outcome: { kind: "ignored-unknown" },
    };
  }
  if (event.seq <= state.cursor) {
    return { state, outcome: { kind: "ignored-duplicate" } };
  }
  if (event.seq > state.cursor + 1) {
    return {
      state,
      outcome: { kind: "needs-catchup", expectedSeq: state.cursor + 1 },
    };
  }
  const cursor = event.seq;
  switch (event.type) {
    case "run.queued":
    case "run.started":
      return {
        state: {
          cursor,
          visible: "generating",
          answer: [],
          retryVisible: false,
          stopVisible: true,
          notice: "生成中",
        },
        outcome: { kind: "applied" },
      };
    case "tool.requested":
    case "tool.completed":
      return {
        state: { ...state, cursor, visible: "generating", notice: "生成中" },
        outcome: { kind: "applied" },
      };
    case "run.completed":
      return {
        state: {
          cursor,
          visible: "answered",
          answer: readAnswerParts(event.payload),
          retryVisible: false,
          stopVisible: false,
          notice: "回答が届きました",
        },
        outcome: { kind: "applied" },
      };
    case "run.failed":
    case "run.abandoned":
      return {
        state: {
          cursor,
          visible: "failed",
          answer: [],
          retryVisible: true,
          stopVisible: false,
          notice: "生成に失敗しました",
        },
        outcome: { kind: "applied" },
      };
    case "run.cancel_requested":
      // Non-terminal (§11.5): the Run stays active until `run.cancelled`
      // settles. Keep the active view (stream open, submit disabled, stop
      // still offered — contextual stop exact contract, §16.2/§16.6) while
      // already displaying「停止しました」.
      return {
        state: {
          ...state,
          cursor,
          visible: "generating",
          retryVisible: false,
          stopVisible: true,
          notice: "停止しました",
        },
        outcome: { kind: "applied" },
      };
    case "run.cancelled":
      // Terminal (§11.4): exactly one terminal event per Run.
      return {
        state: {
          cursor,
          visible: "stopped",
          answer: [],
          retryVisible: false,
          stopVisible: false,
          notice: "停止しました",
        },
        outcome: { kind: "applied" },
      };
    default:
      if (SILENT_TYPES.has(event.type)) {
        return { state: { ...state, cursor }, outcome: { kind: "applied" } };
      }
      // Unknown future non-final extension: advance the cursor only (§16.4).
      return { state: { ...state, cursor }, outcome: { kind: "ignored-unknown" } };
  }
}

/**
 * Corrupt-cursor guard (§16.7): non-integers, negatives, and cursors far
 * beyond the server's `event_seq` stop infinite reconnect and switch to
 * history resync. `eventSeq` is `runs.event_seq` (last issued seq).
 */
export function isCorruptCursor(cursor: unknown, eventSeq: number): boolean {
  if (typeof cursor !== "number" || !Number.isInteger(cursor) || cursor < 0) {
    return true;
  }
  return cursor > eventSeq;
}

/**
 * Effective SSE cursor (§16.4, exact): the max of the valid `?after` query
 * value and the valid `Last-Event-ID` header. Invalid values (non-integer,
 * <= 0) are ignored. No valid value means 0.
 */
export function effectiveCursor(
  afterQuery: string | null | undefined,
  lastEventIdHeader: string | null | undefined,
): number {
  const candidates: number[] = [];
  for (const raw of [afterQuery, lastEventIdHeader]) {
    if (raw === null || raw === undefined || raw.length === 0) {
      continue;
    }
    const trimmed = raw.trim();
    if (!/^\d+$/.test(trimmed)) {
      continue;
    }
    const value = Number(trimmed);
    if (Number.isSafeInteger(value) && value > 0) {
      candidates.push(value);
    }
  }
  return candidates.length === 0 ? 0 : Math.max(...candidates);
}
