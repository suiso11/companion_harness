// PR-4 provisional answer draft (frontend plan §11.1 Q11, option ii).
//
// - Ephemeral `answer.draft.delta` text accumulates in memory only: it is
//   never persisted (no localStorage, no history write) and never sent
//   back. After a reload the text is gone by construction.
// - The draft is UNVALIDATED provisional text decoded from partial
//   `answer.submit` argument JSON: it is rendered as plain text only
//   (never HTML/markdown, never live citation links or chips). Citation
//   markers such as `[r1]` stay inert text inside the draft paragraph.
// - A new step's draft restarts: a delta whose `step` differs from the
//   current draft replaces the text instead of appending. Terminal
//   validated answers (`run.completed`) and failures/cancels discard the
//   draft entirely (the validated structured answer replaces it).
// - Display is muted + labelled「下書き（検証前）」; the draft section
//   uses `aria-live="off"` so draft tokens are never announced (the run
//   status line keeps `aria-live="polite"` announcements).

/** Max draft chars shown in the provisional bubble (bounded display). */
export const MAX_DRAFT_CHARS = 4000;

/** Truncation marker appended to the shown text when bounded. */
export const DRAFT_TRUNCATED_SUFFIX = "（以下省略）";

/** Fixed provisional label: marks the bubble as unvalidated. */
export const DRAFT_LABEL = "下書き（検証前）";

/** Ephemeral per-run draft state (memory only, never persisted). */
export interface DraftState {
  readonly step: number;
  readonly text: string;
  readonly truncated: boolean;
}

/** Valid 1-based step ordinal (mirrors contracts ModelStepNumber bounds). */
function isValidStep(step: unknown): step is number {
  return (
    typeof step === "number" &&
    Number.isSafeInteger(step) &&
    step >= 1 &&
    step <= 64
  );
}

/**
 * Start (or restart) a draft from one delta piece. Invalid pieces yield
 * null (no draft). Over-long pieces are bounded with `truncated` set.
 */
export function initDraftText(step: unknown, text: unknown): DraftState | null {
  if (!isValidStep(step)) {
    return null;
  }
  if (typeof text !== "string" || text.length === 0) {
    return null;
  }
  if (text.length <= MAX_DRAFT_CHARS) {
    return { step, text, truncated: false };
  }
  return {
    step,
    text: text.slice(0, MAX_DRAFT_CHARS),
    truncated: true,
  };
}

/**
 * Apply one `answer.draft.delta` payload to the current draft. Pure:
 * returns the next state (or null when there is no draft and the piece
 * is invalid). A delta from a NEW step restarts the text; a delta from
 * the SAME step appends (bounded, excess dropped, `truncated` set).
 * Invalid (non-string/empty) pieces leave the state unchanged.
 */
export function appendDraftText(
  state: DraftState | null,
  payload: unknown,
): DraftState | null {
  if (typeof payload !== "object" || payload === null) {
    return state;
  }
  const record = payload as { step?: unknown; text?: unknown };
  if (!isValidStep(record.step)) {
    return state;
  }
  if (typeof record.text !== "string" || record.text.length === 0) {
    return state;
  }
  if (state === null || record.step !== state.step) {
    return initDraftText(record.step, record.text);
  }
  const combined = `${state.text}${record.text}`;
  if (combined.length <= MAX_DRAFT_CHARS) {
    return { ...state, text: combined };
  }
  if (state.text.length >= MAX_DRAFT_CHARS) {
    return { ...state, truncated: true };
  }
  return {
    ...state,
    text: combined.slice(0, MAX_DRAFT_CHARS),
    truncated: true,
  };
}

/** Display text for the draft bubble (plain text, truncation marked). */
export function draftDisplayText(state: DraftState | null): string {
  if (state === null || state.text.length === 0) {
    return "";
  }
  return state.truncated
    ? `${state.text}${DRAFT_TRUNCATED_SUFFIX}`
    : state.text;
}
