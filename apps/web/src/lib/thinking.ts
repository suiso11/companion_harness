// PR-3 thinking/status UI (frontend plan §11.1 Q11): pure view logic.
//
// - Ephemeral `model.reasoning.delta` text accumulates here only: it is
//   never persisted (no localStorage, no history write) and never sent
//   back. After a reload the text is gone by construction.
// - `model.usage` drives the completion stats line (tok/s from
//   completionTokens / elapsedMs, never llama `timings`).
// - The phase line derives from durable events only (tool counts + step
//   completions tracked in the run view), so it works without streaming
//   and after reload. Tool names/args are never rendered: known tool
//   namespaces map to fixed Japanese labels, everything else is generic.

/** Max reasoning chars shown in the Thinking block (bounded display). */
export const MAX_THINKING_CHARS = 4000;

/** Truncation marker appended to the shown text when bounded. */
export const THINKING_TRUNCATED_SUFFIX = "（以下省略）";

/** Ephemeral per-run thinking state (memory only, never persisted). */
export interface ThinkingState {
  readonly text: string;
  readonly truncated: boolean;
  readonly usage: ThinkingUsage | null;
}

/** Terminal `model.usage` payload (contracts exact shape). */
export interface ThinkingUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly elapsedMs: number;
}

export const EMPTY_THINKING: ThinkingState = {
  text: "",
  truncated: false,
  usage: null,
};

/**
 * Append one reasoning piece. Pure: returns the next state with the text
 * bounded to MAX_THINKING_CHARS (excess is dropped, `truncated` set).
 * Invalid (non-string/empty) pieces leave the state unchanged.
 */
export function appendThinkingText(
  state: ThinkingState,
  text: unknown,
): ThinkingState {
  if (typeof text !== "string" || text.length === 0) {
    return state;
  }
  const combined = `${state.text}${text}`;
  if (combined.length <= MAX_THINKING_CHARS) {
    return { ...state, text: combined };
  }
  return {
    ...state,
    text: combined.slice(0, MAX_THINKING_CHARS),
    truncated: true,
  };
}

/** Record one terminal usage summary (replaces any previous). */
export function applyThinkingUsage(
  state: ThinkingState,
  usage: unknown,
): ThinkingState {
  if (typeof usage !== "object" || usage === null) {
    return state;
  }
  const record = usage as {
    promptTokens?: unknown;
    completionTokens?: unknown;
    elapsedMs?: unknown;
  };
  if (
    typeof record.promptTokens !== "number" ||
    !Number.isSafeInteger(record.promptTokens) ||
    record.promptTokens < 0 ||
    typeof record.completionTokens !== "number" ||
    !Number.isSafeInteger(record.completionTokens) ||
    record.completionTokens < 0 ||
    typeof record.elapsedMs !== "number" ||
    !Number.isSafeInteger(record.elapsedMs) ||
    record.elapsedMs < 0
  ) {
    return state;
  }
  return {
    ...state,
    usage: {
      promptTokens: record.promptTokens,
      completionTokens: record.completionTokens,
      elapsedMs: record.elapsedMs,
    },
  };
}

/** Display text for the Thinking block (plain text, truncation marked). */
export function thinkingDisplayText(state: ThinkingState): string {
  if (state.text.length === 0) {
    return "";
  }
  return state.truncated
    ? `${state.text}${THINKING_TRUNCATED_SUFFIX}`
    : state.text;
}

/** Tokens/sec from usage (null when unavailable: hidden line). */
export function thinkingTokensPerSec(
  usage: ThinkingUsage | null,
): number | null {
  if (usage === null || usage.elapsedMs <= 0) {
    return null;
  }
  return usage.completionTokens / (usage.elapsedMs / 1000);
}

/**
 * Completion stats line (upstream `ChatMessageAssistantStatistics` look:
 * tokens, tok/s, elapsed), or null when it must stay hidden. Plain ASCII
 * numbers + fixed labels so e2e only asserts the "tok/s" substring.
 */
export function formatThinkingStats(
  usage: ThinkingUsage | null,
): string | null {
  const rate = thinkingTokensPerSec(usage);
  if (rate === null || usage === null) {
    return null;
  }
  const elapsedSec = usage.elapsedMs / 1000;
  return (
    `${usage.completionTokens} tokens · ` +
    `${rate.toFixed(1)} tok/s · ${elapsedSec.toFixed(1)}s`
  );
}

/* ------------------------------------------------------------------ */
/* Phase line (durable events only)                                     */
/* ------------------------------------------------------------------ */

/** Visible run phase (no tech vocabulary leaks into the text). */
export type RunPhase = "thinking" | "tool" | "composing";

/** Durable counters the phase derives from (tracked in the run view). */
export interface RunPhaseInput {
  readonly toolRequested: number;
  readonly toolCompleted: number;
  readonly stepsCompleted: number;
}

/**
 * Derive the phase from durable counters only: no streaming flag, no
 * ephemeral text, so the line is identical before/after reload.
 */
export function deriveRunPhase(input: RunPhaseInput): RunPhase {
  if (input.toolRequested > input.toolCompleted) {
    return "tool";
  }
  if (input.toolRequested > 0 || input.stepsCompleted > 0) {
    return "composing";
  }
  return "thinking";
}

/**
 * Fixed Japanese label for a tool namespace. Tool names/args are never
 * rendered: known namespaces map to a fixed label, unknown tools yield
 * null (the generic count-only line is used instead).
 */
export function toolKindLabel(tool: unknown): string | null {
  if (typeof tool !== "string") {
    return null;
  }
  if (tool.startsWith("calendar.")) {
    return "カレンダー検索";
  }
  if (tool.startsWith("memory.")) {
    return "記憶検索";
  }
  return null;
}

/** Distinct fixed labels for the observed tool names (order-stable). */
export function toolPhaseLabels(toolNames: readonly unknown[]): string[] {
  const labels: string[] = [];
  for (const name of toolNames) {
    const label = toolKindLabel(name);
    if (label !== null && !labels.includes(label)) {
      labels.push(label);
    }
  }
  return labels;
}

/**
 * Phase line text (F-01-2: no Run/Tool/seq vocabulary). Counts only,
 * never tool names or args.
 */
export function formatPhaseText(
  phase: RunPhase,
  toolNames: readonly unknown[],
  toolRequested: number,
  toolCompleted: number,
): string {
  switch (phase) {
    case "tool": {
      const labels = toolPhaseLabels(toolNames);
      const count = `${toolCompleted}/${toolRequested}`;
      if (labels.length === 0) {
        return `ツール実行中（${count}）`;
      }
      const first = labels[0] ?? "";
      if (labels.length > 1) {
        return `ツール実行中（${first}など ${count}）`;
      }
      return `ツール実行中（${first} ${count}）`;
    }
    case "composing":
      return "回答作成中…";
    case "thinking":
      return "考え中…";
  }
}
