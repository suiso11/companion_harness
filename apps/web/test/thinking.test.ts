// PR-3 unit tests: Thinking/status pure logic (no DOM, no Svelte).
import { describe, expect, test } from "vitest";
import {
  applyRunEvent,
  INITIAL_RUN_VIEW,
  type RunViewState,
} from "../src/lib/reducer.js";
import {
  appendThinkingText,
  applyThinkingUsage,
  deriveRunPhase,
  EMPTY_THINKING,
  formatPhaseText,
  formatThinkingStats,
  MAX_THINKING_CHARS,
  thinkingDisplayText,
  thinkingTokensPerSec,
  toolKindLabel,
  toolPhaseLabels,
} from "../src/lib/thinking.js";

function stateAt(
  events: Array<{ seq: number; type: string; payload: unknown }>,
): RunViewState {
  let state = { ...INITIAL_RUN_VIEW };
  for (const event of events) {
    const applied = applyRunEvent(state, event);
    expect(applied.outcome.kind).toBe("applied");
    state = { ...applied.state };
  }
  return state;
}

describe("appendThinkingText", () => {
  test("accumulates reasoning pieces as plain text", () => {
    const next = appendThinkingText(
      appendThinkingText(EMPTY_THINKING, "こんにちは"),
      "世界",
    );
    expect(next.text).toBe("こんにちは世界");
    expect(next.truncated).toBe(false);
  });

  test("bounds the shown length and marks truncation", () => {
    const next = appendThinkingText(
      EMPTY_THINKING,
      "a".repeat(MAX_THINKING_CHARS + 10),
    );
    expect(next.text.length).toBe(MAX_THINKING_CHARS);
    expect(next.truncated).toBe(true);
    expect(thinkingDisplayText(next)).toContain("（以下省略）");
  });

  test("ignores invalid pieces without throwing", () => {
    expect(appendThinkingText(EMPTY_THINKING, null)).toBe(EMPTY_THINKING);
    expect(appendThinkingText(EMPTY_THINKING, "")).toBe(EMPTY_THINKING);
    expect(appendThinkingText(EMPTY_THINKING, 42)).toBe(EMPTY_THINKING);
  });

  test("markup stays inert plain text (no HTML interpretation by logic)", () => {
    const next = appendThinkingText(EMPTY_THINKING, '<b>bold</b> & "q"');
    expect(next.text).toBe('<b>bold</b> & "q"');
  });
});

describe("thinking usage stats", () => {
  test("tok/s from completionTokens / elapsedMs", () => {
    const usage = { promptTokens: 10, completionTokens: 45, elapsedMs: 2800 };
    const withUsage = applyThinkingUsage(EMPTY_THINKING, usage);
    expect(withUsage.usage).toEqual(usage);
    expect(thinkingTokensPerSec(withUsage.usage)).toBeCloseTo(45 / 2.8, 5);
    expect(formatThinkingStats(withUsage.usage)).toMatch(/tok\/s/);
    expect(formatThinkingStats(withUsage.usage)).toContain("45 tokens");
  });

  test("hidden when usage is missing or elapsed is zero", () => {
    expect(formatThinkingStats(null)).toBeNull();
    expect(
      formatThinkingStats({
        promptTokens: 1,
        completionTokens: 5,
        elapsedMs: 0,
      }),
    ).toBeNull();
  });

  test("invalid usage payloads are dropped", () => {
    expect(applyThinkingUsage(EMPTY_THINKING, null).usage).toBeNull();
    expect(
      applyThinkingUsage(EMPTY_THINKING, {
        promptTokens: -1,
        completionTokens: 1,
        elapsedMs: 1,
      }).usage,
    ).toBeNull();
    expect(
      applyThinkingUsage(EMPTY_THINKING, {
        promptTokens: 1,
        completionTokens: 1,
        elapsedMs: 1.5,
      }).usage,
    ).toBeNull();
  });
});

describe("phase derivation (durable counters only)", () => {
  test("thinking before any tool or step", () => {
    expect(
      deriveRunPhase({ toolRequested: 0, toolCompleted: 0, stepsCompleted: 0 }),
    ).toBe("thinking");
    expect(formatPhaseText("thinking", [], 0, 0)).toBe("考え中…");
  });

  test("tool phase counts only, with calendar label", () => {
    const view = stateAt([
      { seq: 1, type: "run.started", payload: { attempt: 1 } },
      {
        seq: 2,
        type: "tool.requested",
        payload: { callId: "id-1", callIndex: 1, tool: "calendar.search" },
      },
      {
        seq: 3,
        type: "tool.requested",
        payload: { callId: "id-2", callIndex: 2, tool: "calendar.search" },
      },
      {
        seq: 4,
        type: "tool.completed",
        payload: {
          callId: "id-1",
          callIndex: 1,
          tool: "calendar.search",
          actualOutcome: "succeeded",
          reportedOutcome: "succeeded",
          disposition: "accepted",
          errorCode: null,
          resultDigest: null,
          reusedFromCallId: null,
        },
      },
    ]);
    expect(view.toolRequested).toBe(2);
    expect(view.toolCompleted).toBe(1);
    const phase = deriveRunPhase(view);
    expect(phase).toBe("tool");
    expect(
      formatPhaseText(
        phase,
        view.toolNames,
        view.toolRequested,
        view.toolCompleted,
      ),
    ).toBe("ツール実行中（カレンダー検索 1/2）");
  });

  test("composing once tools settle", () => {
    const phase = deriveRunPhase({
      toolRequested: 2,
      toolCompleted: 2,
      stepsCompleted: 0,
    });
    expect(phase).toBe("composing");
    expect(formatPhaseText(phase, ["calendar.search"], 2, 2)).toBe(
      "回答作成中…",
    );
  });

  test("unknown tool names never render raw", () => {
    expect(toolKindLabel("calendar.search")).toBe("カレンダー検索");
    expect(toolKindLabel("evil.tool")).toBeNull();
    expect(toolKindLabel(null)).toBeNull();
    expect(toolPhaseLabels(["evil.tool", 42])).toEqual([]);
    expect(formatPhaseText("tool", ["evil.tool"], 1, 0)).toBe(
      "ツール実行中（0/1）",
    );
    expect(
      formatPhaseText("tool", ["calendar.search", "memory.search"], 2, 0),
    ).toBe("ツール実行中（カレンダー検索など 0/2）");
  });

  test("model.step.completed is durable and silent", () => {
    const view = stateAt([
      { seq: 1, type: "run.started", payload: { attempt: 1 } },
      { seq: 2, type: "model.step.completed", payload: { step: 1 } },
    ]);
    expect(view.stepsCompleted).toBe(1);
    expect(view.notice).toBe("生成中");
    expect(
      deriveRunPhase({
        toolRequested: view.toolRequested,
        toolCompleted: view.toolCompleted,
        stepsCompleted: view.stepsCompleted,
      }),
    ).toBe("composing");
  });

  test("terminal preserves counters for the final stats context", () => {
    const view = stateAt([
      { seq: 1, type: "run.started", payload: { attempt: 1 } },
      {
        seq: 2,
        type: "tool.requested",
        payload: { callId: "id-1", callIndex: 1, tool: "calendar.search" },
      },
      {
        seq: 3,
        type: "run.completed",
        payload: { result: { version: 1, text: "done" } },
      },
    ]);
    expect(view.visible).toBe("answered");
    expect(view.toolRequested).toBe(1);
  });
});
