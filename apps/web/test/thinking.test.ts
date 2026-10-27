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
  durableRunStart,
  EMPTY_THINKING,
  formatElapsedSuffix,
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

describe("model failure reasons (fixed diagnostics)", () => {
  test("maps the latest model.step.failed payload to fixed Japanese text", () => {
    const cases: Array<{
      payload: Record<string, unknown>;
      expected: string;
    }> = [
      {
        payload: { step: 1, errorCode: "model_step_timeout" },
        expected: "時間切れ（1回5分）",
      },
      {
        payload: {
          step: 1,
          errorCode: "model_unavailable",
          gatewayErrorCode: "request_failed",
          httpStatus: 502,
        },
        expected: "モデルサーバーが応答しません（起動中の可能性）",
      },
      {
        payload: {
          step: 1,
          errorCode: "model_unavailable",
          gatewayErrorCode: "transport_error",
          invalidResponseCause: "connection_reset",
        },
        expected: "モデルサーバーが応答しません（起動中の可能性）",
      },
      {
        payload: {
          step: 1,
          errorCode: "model_unavailable",
          gatewayErrorCode: "invalid_response",
          invalidResponseCause: "response_too_large",
        },
        expected: "返答が大きすぎます",
      },
      {
        payload: {
          step: 1,
          errorCode: "model_unavailable",
          gatewayErrorCode: "invalid_response",
          invalidResponseCause: "stream_incomplete",
        },
        expected: "モデルの返答形式が不正です（stream_incomplete）",
      },
      {
        payload: { step: 1, errorCode: "answer_invalid" },
        expected: "回答の形式が崩れました",
      },
      {
        payload: {
          step: 1,
          errorCode: "answer_invalid",
          reason: "output_truncated",
        },
        expected: "出力が上限で途中で切れました",
      },
    ];
    for (const testCase of cases) {
      const view = stateAt([
        { seq: 1, type: "run.started", payload: {} },
        {
          seq: 2,
          type: "model.step.failed",
          payload: testCase.payload,
        },
        {
          seq: 3,
          type: "run.failed",
          payload: { errorCode: "execution_failed" },
        },
      ]);
      expect(view.notice).toBe(testCase.expected);
      expect(view.failureNotice).toBe(testCase.expected);
      expect(view.retryVisible).toBe(true);
    }
  });

  test("falls back to the generic failure and maps output_invalid", () => {
    const generic = stateAt([
      { seq: 1, type: "run.started", payload: {} },
      {
        seq: 2,
        type: "run.failed",
        payload: { errorCode: "execution_failed" },
      },
    ]);
    expect(generic.notice).toBe("生成に失敗しました");
    const invalid = stateAt([
      { seq: 1, type: "run.started", payload: {} },
      { seq: 2, type: "run.failed", payload: { errorCode: "output_invalid" } },
    ]);
    expect(invalid.notice).toBe("回答の形式が崩れました");
  });
});

describe("cancellation run views (PR #82 review)", () => {
  test("run.cancel_requested stays generating with the stop notice", () => {
    // PR #82 review (4312961764): the run stays "generating" (non-terminal,
    // §11.5) until the watchdog settles, so the UI hides the phase line via
    // the cancel-pending flag while this notice is up.
    const view = stateAt([
      { seq: 1, type: "run.started", payload: { attempt: 1 } },
      { seq: 2, type: "run.cancel_requested", payload: {} },
    ]);
    expect(view.visible).toBe("generating");
    expect(view.notice).toBe("停止しました");
    expect(view.stopVisible).toBe(true);
  });

  test("run.cancelled is the terminal stopped view", () => {
    const view = stateAt([{ seq: 1, type: "run.cancelled", payload: {} }]);
    expect(view.visible).toBe("stopped");
    expect(view.notice).toBe("停止しました");
    expect(view.stopVisible).toBe(false);
    expect(
      deriveRunPhase({
        toolRequested: view.toolRequested,
        toolCompleted: view.toolCompleted,
        stepsCompleted: view.stepsCompleted,
      }),
    ).toBe("thinking");
  });
});

describe("elapsed suffix + durable run start (PR #82 review)", () => {
  test("elapsed suffix is the visible（N秒）tick", () => {
    expect(formatElapsedSuffix(0)).toBe("（0秒）");
    expect(formatElapsedSuffix(42)).toBe("（42秒）");
    expect(formatElapsedSuffix(7.9)).toBe("（7秒）");
    expect(formatElapsedSuffix(-3)).toBe("（0秒）");
  });

  test("durableRunStart prefers startedAt, falls back to createdAt", () => {
    expect(durableRunStart({ id: "r1", startedAt: 1000, createdAt: 500 })).toBe(
      1000,
    );
    expect(durableRunStart({ id: "r1", createdAt: 500 })).toBe(500);
    expect(durableRunStart({ id: "r1" })).toBeNull();
    expect(durableRunStart({ startedAt: 0 })).toBeNull();
    expect(durableRunStart({ startedAt: -5 })).toBeNull();
    expect(durableRunStart(null)).toBeNull();
    expect(durableRunStart("run")).toBeNull();
  });
});

describe("web-only phase wording (PR112 review)", () => {
  test("pure web.search phases use the dedicated wording", () => {
    expect(formatPhaseText("tool", ["web.search"], 1, 0)).toBe("ウェブ検索中…");
  });

  test("web.search with an unmapped tool keeps the generic mixed line", () => {
    // The unmapped tool is dropped from labels, so the count line shows the
    // remaining label — but never the dedicated ウェブ検索中… wording.
    expect(
      formatPhaseText("tool", ["web.search", "reference.open"], 2, 1),
    ).toBe("ツール実行中（ウェブ検索 1/2）");
  });

  test("unmapped-only runs still keep the generic count line", () => {
    expect(formatPhaseText("tool", ["reference.open"], 1, 0)).toBe(
      "ツール実行中（0/1）",
    );
  });
});
