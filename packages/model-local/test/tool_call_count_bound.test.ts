// Provider-native per-message tool-call count bound (r3946739336).
//
// At most MAX_TOOL_CALLS_PER_MESSAGE (32, shared constant) native calls per
// provider response: exactly 32 accepts, 33 rejects atomically with fixed
// redacted invalid_response (never truncated, never echoed) before
// AgentStrategy/ToolBroker sees any call, so none executes. The count check
// runs before per-call argument parsing: an over-count batch containing a
// malformed answer.submit still fails as invalid_response (never
// answer_invalid, never repaired).

import { describe, expect, it } from "vitest";
import { ModelLocalError } from "../src/errors.js";
import {
  assertToolCallCountWithinBound,
  MAX_TOOL_CALLS_PER_MESSAGE,
} from "../src/gateway.js";
import { normalizeOllamaResponse } from "../src/ollama.js";
import { normalizeOpenAIResponse } from "../src/openai_compatible.js";

const SECRET = "count-secret-must-not-leak-7q7q";
const TOOLS = [{ name: "notes.search", description: "search" }];

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

function openaiCall(index: number): unknown {
  return {
    id: `c-${index}`,
    type: "function",
    function: { name: "notes.search", arguments: {} },
  };
}

function ollamaCall(index: number): unknown {
  return {
    id: `c-${index}`,
    function: { name: "notes.search", arguments: {} },
  };
}

function expectInvalidResponse(error: unknown): void {
  expect(error).toBeInstanceOf(ModelLocalError);
  const err = error as ModelLocalError;
  expect(err.code).toBe("invalid_response");
  expect(err.message).toBe("model returned an invalid response");
  expect(err.message).not.toContain(SECRET);
  expect(JSON.stringify(err)).not.toContain(SECRET);
}

describe("shared count bound", () => {
  it("is 32 via the shared constant", () => {
    expect(MAX_TOOL_CALLS_PER_MESSAGE).toBe(32);
    expect(() => assertToolCallCountWithinBound(32)).not.toThrow();
    try {
      assertToolCallCountWithinBound(33);
      expect.unreachable();
    } catch (error) {
      expectInvalidResponse(error);
    }
  });
});

describe("exact 32 accepts (both providers)", () => {
  it("accepts exactly 32 native calls", () => {
    const oaiCalls = Array.from({ length: 32 }, (_, i) => openaiCall(i));
    const oai = normalizeOpenAIResponse(openaiBody(oaiCalls), TOOLS);
    expect(oai.toolCalls).toHaveLength(32);
    expect(oai.stopReason).toBe("tool_calls");

    const olCalls = Array.from({ length: 32 }, (_, i) => ollamaCall(i));
    const ol = normalizeOllamaResponse(ollamaBody(olCalls), TOOLS);
    expect(ol.toolCalls).toHaveLength(32);
    expect(ol.stopReason).toBe("tool_calls");
  });
});

describe("33 rejects atomically (both providers)", () => {
  it("rejects 33 native calls as invalid_response without echo", () => {
    const oaiCalls = Array.from({ length: 33 }, (_, i) =>
      i === 32
        ? {
            id: `c-${i}-${SECRET}`,
            type: "function",
            function: { name: "notes.search", arguments: {} },
          }
        : openaiCall(i),
    );
    try {
      normalizeOpenAIResponse(openaiBody(oaiCalls), TOOLS);
      expect.unreachable();
    } catch (error) {
      expectInvalidResponse(error);
    }

    const olCalls = Array.from({ length: 33 }, (_, i) =>
      i === 32
        ? {
            id: `c-${i}-${SECRET}`,
            function: { name: "notes.search", arguments: {} },
          }
        : ollamaCall(i),
    );
    try {
      normalizeOllamaResponse(ollamaBody(olCalls), TOOLS);
      expect.unreachable();
    } catch (error) {
      expectInvalidResponse(error);
    }
  });

  it("count check precedes argument parsing (malformed answer.submit still invalid_response)", () => {
    const badAnswerOpenai = Array.from({ length: 32 }, (_, i) => openaiCall(i));
    badAnswerOpenai.push({
      id: "a-bad",
      type: "function",
      function: { name: "answer.submit", arguments: `{broken ${SECRET}` },
    });
    try {
      normalizeOpenAIResponse(openaiBody(badAnswerOpenai), [
        ...TOOLS,
        { name: "answer.submit", description: "submit" },
      ]);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ModelLocalError);
      expect((error as ModelLocalError).code).toBe("invalid_response");
      expect((error as Error).message).not.toContain(SECRET);
    }

    const badAnswerOllama = Array.from({ length: 32 }, (_, i) => ollamaCall(i));
    badAnswerOllama.push({
      id: "a-bad",
      function: { name: "answer.submit", arguments: `{broken ${SECRET}` },
    });
    try {
      normalizeOllamaResponse(ollamaBody(badAnswerOllama), [
        ...TOOLS,
        { name: "answer.submit", description: "submit" },
      ]);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ModelLocalError);
      expect((error as ModelLocalError).code).toBe("invalid_response");
      expect((error as Error).message).not.toContain(SECRET);
    }
  });
});
