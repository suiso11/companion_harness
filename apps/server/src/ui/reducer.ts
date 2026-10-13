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
export type VisibleRunStatus = "generating" | "answered" | "failed" | "stopped";

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
  const record = result as {
    version?: unknown;
    text?: unknown;
    answer?: unknown;
  };
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
      return {
        state: { ...state, cursor },
        outcome: { kind: "ignored-unknown" },
      };
  }
}

/* ------------------------------------------------------------------ */
/* C22 actual approval UX (pure view mapping, no DOM/I/O)               */
/* ------------------------------------------------------------------ */

/**
 * Exact server-side proposal status vocabulary (`ActionProposalStatus`,
 * type-only import so the browser bundle never pulls zod).
 */
export type ProposalStatus = "pending" | "approved" | "rejected" | "expired";

/** Exact execution status vocabulary (`ActionExecutionStatus`). */
export type ExecutionStatus =
  | "queued"
  | "preflight"
  | "executing"
  | "succeeded"
  | "succeeded_unverified"
  | "blocked_stale"
  | "failed"
  | "unknown";

/** Exact receipt outcome vocabulary (`ActionReceiptOutcome`). */
export type ReceiptOutcome = ExecutionStatus;

/**
 * Everything the approval card needs, already read from the ACTUAL APIs
 * (`GET .../proposals`, `GET .../proposals/:id/execution`) and the client
 * clock. No technical id is ever carried into a rendered string.
 */
export interface ActionCardInput {
  readonly status: ProposalStatus;
  /** Deterministic safe preview summary from the proposal itself. */
  readonly preview: string;
  readonly start: string;
  readonly end: string;
  readonly expiresAt: number;
  readonly now: number;
  readonly executionStatus: ExecutionStatus | null;
  readonly markerCommitted: boolean;
  readonly cancellable: boolean;
  readonly receiptOutcome: ReceiptOutcome | null;
  readonly receiptSummary: string | null;
}

export interface ActionCardModel {
  /**
   * The Approve/Reject controls exist ONLY for a pending, unexpired
   * proposal: an expired or already decided proposal renders no control, so
   * a stale card can never reach an external write.
   */
  readonly decisionVisible: boolean;
  readonly expired: boolean;
  readonly progressText: string;
  /** Contextual Stop: live execution AND the external marker NOT committed. */
  readonly stopVisible: boolean;
  readonly outcomeText: string;
  readonly detailText: string;
}

/** Fixed safe redacted execution error codes (`M5_ACTION_ERROR_CODES`). */
export type ActionErrorCode =
  | "action_preflight_failed"
  | "action_cancelled_before_write"
  | "action_write_failed"
  | "action_recovery_abandoned_before_write"
  | "database_state_invalid";

export const ACTION_PROGRESS_TEXT: Readonly<
  Record<"queued" | "preflight" | "executing", string>
> = {
  queued: "承認を受け付けました。準備しています",
  preflight: "変更前の内容を確認しています",
  executing: "日程を更新しています",
};

/**
 * Receipt outcome -> fixed plain text (§18.7). Never "停止しました": a
 * cancel is NOT a receipt outcome, and an unverified/failed/unknown write
 * requires a manual check rather than any stop vocabulary.
 */
export function receiptOutcomeText(outcome: ReceiptOutcome | null): string {
  switch (outcome) {
    case "succeeded":
      return "日程を更新しました";
    case "succeeded_unverified":
      return "更新しましたが結果を確認できませんでした。内容を手動で確認してください";
    case "blocked_stale":
      return "元の予定に変更があったため、更新しませんでした。内容を手動で確認してください";
    case "failed":
      return "更新できませんでした。内容を手動で確認してください";
    case "unknown":
      return "更新の結果が不明です。内容を手動で確認してください";
    default:
      return "";
  }
}

/**
 * Fixed safe execution error-code text (§18.5). `action_cancelled_before_write`
 * keeps the external write NOT performed — it is the pre-marker cancel
 * outcome, distinct from any "stopped" receipt.
 */
export function actionErrorCodeText(code: ActionErrorCode | null): string {
  switch (code) {
    case "action_cancelled_before_write":
      return "更新は実施していません";
    case "action_preflight_failed":
      return "変更前の内容を確認できませんでした。内容を手動で確認してください";
    case "action_write_failed":
      return "更新できませんでした。内容を手動で確認してください";
    case "action_recovery_abandoned_before_write":
      return "更新は実施していません。内容を手動で確認してください";
    case "database_state_invalid":
      return "状態が不正です。内容を手動で確認してください";
    default:
      return "";
  }
}

/**
 * Pure mapping from the actual API reads to the rendered card. Deterministic
 * and total: an unknown/terminal-lost execution renders its real status and
 * never a fabricated success.
 */
export function actionCardModel(input: ActionCardInput): ActionCardModel {
  // Client deadline guard: the card is only actionable while the server
  // validity window is still open per the CLIENT clock as well; the server
  // repository state remains authoritative and is re-read on approve.
  const expired = input.now >= input.expiresAt;
  const pendingOpen = input.status === "pending" && !expired;
  const live =
    input.executionStatus === "queued" ||
    input.executionStatus === "preflight" ||
    input.executionStatus === "executing";
  const progressText = live
    ? ACTION_PROGRESS_TEXT[
        input.executionStatus as "queued" | "preflight" | "executing"
      ]
    : "";
  const terminalOutcome: ReceiptOutcome | null =
    input.receiptOutcome ??
    (input.executionStatus !== null && !live ? input.executionStatus : null);
  const outcomeText = receiptOutcomeText(terminalOutcome);
  return {
    decisionVisible: pendingOpen,
    expired: expired && input.status === "pending",
    progressText,
    // The external-call marker is a committed, irreversible boundary: Stop
    // exists only before it, and is hidden for a terminal execution.
    stopVisible: live && !input.markerCommitted && input.cancellable,
    outcomeText:
      outcomeText !== ""
        ? outcomeText
        : expired && input.status === "pending"
          ? "確認の期限が過ぎました。新しく依頼してください"
          : "",
    detailText: input.receiptSummary ?? input.preview,
  };
}

/**
 * Deterministic history intent text for the two exact decision history
 * variants (§18.4). These items carry NO user text: the intent is derived
 * from the real persisted decision plus its real receipt outcome, never
 * rendered blank.
 */
export function actionDecisionIntentText(
  kind: "action_approval" | "action_rejection",
  outcome: ReceiptOutcome | null,
): string {
  if (kind === "action_rejection") {
    return "日程変更の案を却下しました";
  }
  if (outcome === null) {
    return "日程変更を承認しました";
  }
  return `日程変更を承認しました（${receiptOutcomeText(outcome)}）`;
}

/**
 * Validated parse of a cancel `200` response body (`CancelRunResponse`):
 * returns the actual `run.status` string, or `null` when the body is not
 * the exact `{ run: { id, status } }` shape. The caller claims a stop ONLY
 * for the `cancelled` terminal; every other (or unparseable) outcome
 * refreshes the actual execution/receipt state instead.
 */
export function parseCancelRunStatus(body: unknown): string | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const run = (body as { run?: unknown }).run;
  if (typeof run !== "object" || run === null) {
    return null;
  }
  const status = (run as { status?: unknown }).status;
  return typeof status === "string" ? status : null;
}

/**
 * Terminal-hydration single-owner guard (§16.7): the first claim for a Run
 * wins; later claims for the same Run are declined so the terminal history
 * refresh (and the failure-only retry appended after it) happens exactly
 * once even when both the serialized event path and the fallback poll path
 * observe the same terminal view.
 */
export function claimTerminalHydration(
  claimed: Set<string>,
  runId: string,
): boolean {
  if (claimed.has(runId)) {
    return false;
  }
  claimed.add(runId);
  return true;
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
