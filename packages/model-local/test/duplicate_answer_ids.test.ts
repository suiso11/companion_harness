// Duplicate answer.submit IDs reach AgentStrategy repair (r3950636376).
//
// Native validation allows duplicate ids only when the entire provider step
// consists of multiple answer.submit calls (count > 1, every name is
// answer.submit), so Ollama/OpenAI results flow to AgentStrategy's
// deterministic-ID remap and duplicate-answer repair-once path. Ordinary or
// mixed duplicate ids still reject atomically as tool_call_invalid, and each
// original call still passes id/name/args bounds (oversize/malformed ids
// reject with the same fixed codes, never bypassed by the exception).
import { describe, expect, it } from "vitest";
import { ModelLocalError } from "../src/errors.js";
import { normalizeOllamaResponse } from "../src/ollama.js";
import { normalizeOpenAIResponse } from "../src/openai_compatible.js";

const SECRET = "dup-answer-secret-must-not-leak-7q7q";
const TOOLS = [{ name: "answer.submit", description: "submit" }];
const MIXED_TOOLS = [
  { name: "answer.submit", description: "submit" },
  { name: "notes.search", description: "search" },
];

function validAnswerArgs(index: number): Record<string, unknown> {
  return { version: 1, parts: [{ text: `part-${index}`, citations: [] }] };
}

function openaiBody(calls: unknown[]): unknown {
  return {
    choices: [
      {
        message: { role: "assistant", content: "", tool_calls: calls },
        finish_reason: "tool_calls",
      },
    ],
  };
}

function ollamaBody(calls: unknown[]): unknown {
  return {
    message: { role: "assistant", content: "", tool_calls: calls },
    done: true,
  };
}

function openaiAnswerCall(
  id: unknown,
  index: number,
  args: unknown = validAnswerArgs(index),
): unknown {
  return {
    id,
    type: "function",
    function: { name: "answer.submit", arguments: args },
  };
}

function ollamaAnswerCall(
  id: unknown,
  index: number,
  args: unknown = validAnswerArgs(index),
): unknown {
  return {
    id,
    function: { name: "answer.submit", arguments: args },
  };
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    expect.unreachable("should reject");
  } catch (error) {
    expect(error).toBeInstanceOf(ModelLocalError);
    expect((error as ModelLocalError).code).toBe(code);
    expect((error as ModelLocalError).message).not.toContain(SECRET);
    expect(JSON.stringify(error)).not.toContain(SECRET);
  }
}

describe("duplicate answer.submit ids pass native validation for repair", () => {
  it("openai duplicate answer ids are preserved for agent remap", () => {
    const result = normalizeOpenAIResponse(
      openaiBody([
        openaiAnswerCall("dup-same", 0),
        openaiAnswerCall("dup-same", 1),
      ]),
      TOOLS,
    );
    expect(result.toolCalls.map((call) => call.id)).toEqual([
      "dup-same",
      "dup-same",
    ]);
    expect(result.toolCalls.map((call) => call.name)).toEqual([
      "answer.submit",
      "answer.submit",
    ]);
    expect(result.stopReason).toBe("tool_calls");
  });

  it("ollama duplicate answer ids are preserved for agent remap", () => {
    const result = normalizeOllamaResponse(
      ollamaBody([
        ollamaAnswerCall("dup-same", 0),
        ollamaAnswerCall("dup-same", 1),
      ]),
      TOOLS,
    );
    expect(result.toolCalls.map((call) => call.id)).toEqual([
      "dup-same",
      "dup-same",
    ]);
    expect(result.toolCalls.map((call) => call.name)).toEqual([
      "answer.submit",
      "answer.submit",
    ]);
    expect(result.stopReason).toBe("tool_calls");
  });

  it("ordinary duplicate ids still reject atomically", () => {
    const openaiCalls = [
      {
        id: "dup-ordinary",
        type: "function",
        function: { name: "notes.search", arguments: {} },
      },
      {
        id: "dup-ordinary",
        type: "function",
        function: { name: "notes.search", arguments: {} },
      },
    ];
    expectCode(
      () => normalizeOpenAIResponse(openaiBody(openaiCalls), MIXED_TOOLS),
      "tool_call_invalid",
    );
    const ollamaCalls = [
      { id: "dup-ordinary", function: { name: "notes.search", arguments: {} } },
      { id: "dup-ordinary", function: { name: "notes.search", arguments: {} } },
    ];
    expectCode(
      () => normalizeOllamaResponse(ollamaBody(ollamaCalls), MIXED_TOOLS),
      "tool_call_invalid",
    );
  });

  it("mixed duplicate ids still reject atomically", () => {
    const openaiCalls = [
      openaiAnswerCall("dup-mixed", 0),
      {
        id: "dup-mixed",
        type: "function",
        function: { name: "notes.search", arguments: {} },
      },
    ];
    expectCode(
      () => normalizeOpenAIResponse(openaiBody(openaiCalls), MIXED_TOOLS),
      "tool_call_invalid",
    );
    const ollamaCalls = [
      ollamaAnswerCall("dup-mixed", 0),
      {
        id: "dup-mixed",
        function: { name: "notes.search", arguments: {} },
      },
    ];
    expectCode(
      () => normalizeOllamaResponse(ollamaBody(ollamaCalls), MIXED_TOOLS),
      "tool_call_invalid",
    );
  });

  it("oversize duplicate answer ids still reject as invalid_response", () => {
    const oversized = "x".repeat(257);
    expectCode(
      () =>
        normalizeOpenAIResponse(
          openaiBody([
            openaiAnswerCall(oversized, 0),
            openaiAnswerCall(oversized, 1),
          ]),
          TOOLS,
        ),
      "invalid_response",
    );
    expectCode(
      () =>
        normalizeOllamaResponse(
          ollamaBody([
            ollamaAnswerCall(oversized, 0),
            ollamaAnswerCall(oversized, 1),
          ]),
          TOOLS,
        ),
      "invalid_response",
    );
  });
});
