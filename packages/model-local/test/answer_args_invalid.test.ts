// Malformed native answer.submit arguments (r3944753213).
//
// answer.submit normalization failures (malformed JSON, non-object, oversized
// args) reject as fixed redacted `answer_invalid` (no raw id/args/body), while
// ordinary-tool failures keep the generic `tool_call_invalid` /
// `invalid_response` path. Free-text content is never parsed.

import { describe, expect, it } from "vitest";
import { ModelLocalError } from "../src/errors.js";
import { MAX_TOOL_CALL_ARGUMENTS_BYTES } from "../src/gateway.js";
import { normalizeOllamaResponse } from "../src/ollama.js";
import { normalizeOpenAIResponse } from "../src/openai_compatible.js";

const SECRET = "answer-secret-must-not-leak-xyz";
const ORDINARY_TOOLS = [{ name: "notes.search", description: "search" }];
const ANSWER_TOOLS = [{ name: "answer.submit", description: "submit" }];
const encoder = new TextEncoder();

function expectAnswerInvalid(error: unknown): void {
  expect(error).toBeInstanceOf(ModelLocalError);
  const err = error as ModelLocalError;
  expect(err.code).toBe("answer_invalid");
  expect(err.message).not.toContain(SECRET);
  expect(JSON.stringify(err)).not.toContain(SECRET);
}

function openaiBody(toolCalls: unknown[]): unknown {
  return {
    choices: [
      {
        message: { role: "assistant", content: "", tool_calls: toolCalls },
        finish_reason: "tool_calls",
      },
    ],
  };
}

function ollamaBody(toolCalls: unknown[]): unknown {
  return {
    message: { role: "assistant", content: "", tool_calls: toolCalls },
    done: true,
  };
}

describe("openai answer.submit normalization", () => {
  it("malformed JSON answer args reject as answer_invalid", () => {
    const call = {
      id: "a-1",
      type: "function",
      function: { name: "answer.submit", arguments: `{broken ${SECRET}` },
    };
    try {
      normalizeOpenAIResponse(openaiBody([call]), ANSWER_TOOLS);
      expect.unreachable();
    } catch (error) {
      expectAnswerInvalid(error);
    }
  });

  it("non-object JSON answer args reject as answer_invalid", () => {
    for (const args of [`[1,2]`, `42`, `"str"`, `null`]) {
      const call = {
        id: "a-1",
        type: "function",
        function: { name: "answer.submit", arguments: args },
      };
      try {
        normalizeOpenAIResponse(openaiBody([call]), ANSWER_TOOLS);
        expect.unreachable();
      } catch (error) {
        expectAnswerInvalid(error);
      }
    }
  });

  it("non-string non-object answer args reject as answer_invalid", () => {
    const call = {
      id: "a-1",
      type: "function",
      function: { name: "answer.submit", arguments: 42 },
    };
    try {
      normalizeOpenAIResponse(openaiBody([call]), ANSWER_TOOLS);
      expect.unreachable();
    } catch (error) {
      expectAnswerInvalid(error);
    }
  });

  it("oversized answer args reject as answer_invalid (not invalid_response)", () => {
    const overhead = encoder.encode(`{"pad":""}`).byteLength;
    const pad = MAX_TOOL_CALL_ARGUMENTS_BYTES - overhead + 1;
    const over = JSON.stringify({ pad: `a`.repeat(pad) });
    expect(encoder.encode(over).byteLength).toBeGreaterThan(
      MAX_TOOL_CALL_ARGUMENTS_BYTES,
    );
    const call = {
      id: "a-1",
      type: "function",
      function: { name: "answer.submit", arguments: over },
    };
    try {
      normalizeOpenAIResponse(openaiBody([call]), ANSWER_TOOLS);
      expect.unreachable();
    } catch (error) {
      expectAnswerInvalid(error);
      expect((error as ModelLocalError).code).not.toBe("invalid_response");
    }
  });

  it("oversized object-form answer args reject as answer_invalid", () => {
    const overhead = encoder.encode(`{"pad":""}`).byteLength;
    const pad = MAX_TOOL_CALL_ARGUMENTS_BYTES - overhead + 1;
    const call = {
      id: "a-1",
      type: "function",
      function: {
        name: "answer.submit",
        arguments: { pad: `${SECRET}${"a".repeat(pad)}` },
      },
    };
    try {
      normalizeOpenAIResponse(openaiBody([call]), ANSWER_TOOLS);
      expect.unreachable();
    } catch (error) {
      expectAnswerInvalid(error);
    }
  });

  it("ordinary malformed behavior unchanged", () => {
    const call = {
      id: "c-1",
      type: "function",
      function: { name: "notes.search", arguments: `{broken ${SECRET}` },
    };
    try {
      normalizeOpenAIResponse(openaiBody([call]), ORDINARY_TOOLS);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ModelLocalError);
      expect((error as ModelLocalError).code).toBe("tool_call_invalid");
      expect((error as ModelLocalError).message).not.toContain(SECRET);
    }
  });

  it("ordinary oversize stays invalid_response", () => {
    const overhead = encoder.encode(`{"pad":""}`).byteLength;
    const pad = MAX_TOOL_CALL_ARGUMENTS_BYTES - overhead + 1;
    const over = JSON.stringify({ pad: "a".repeat(pad) });
    const call = {
      id: "c-1",
      type: "function",
      function: { name: "notes.search", arguments: over },
    };
    try {
      normalizeOpenAIResponse(openaiBody([call]), ORDINARY_TOOLS);
      expect.unreachable();
    } catch (error) {
      expect((error as ModelLocalError).code).toBe("invalid_response");
    }
  });

  it("free text JSON remains unsupported", () => {
    const result = normalizeOpenAIResponse(
      {
        choices: [
          {
            message: {
              role: "assistant",
              content: JSON.stringify({
                version: 1,
                parts: [{ text: "x", citations: [] }],
              }),
            },
            finish_reason: "stop",
          },
        ],
      },
      ANSWER_TOOLS,
    );
    expect(result.toolCalls).toEqual([]);
  });
});

describe("ollama answer.submit normalization", () => {
  it("malformed string answer args reject as answer_invalid", () => {
    const call = {
      id: "a-1",
      function: { name: "answer.submit", arguments: `{broken ${SECRET}` },
    };
    try {
      normalizeOllamaResponse(ollamaBody([call]), ANSWER_TOOLS);
      expect.unreachable();
    } catch (error) {
      expectAnswerInvalid(error);
    }
  });

  it("non-object parsed answer args reject as answer_invalid", () => {
    const call = {
      id: "a-1",
      function: { name: "answer.submit", arguments: `[1,2]` },
    };
    try {
      normalizeOllamaResponse(ollamaBody([call]), ANSWER_TOOLS);
      expect.unreachable();
    } catch (error) {
      expectAnswerInvalid(error);
    }
  });

  it("oversized answer args reject as answer_invalid", () => {
    const overhead = encoder.encode(`{"pad":""}`).byteLength;
    const pad = MAX_TOOL_CALL_ARGUMENTS_BYTES - overhead + 1;
    const call = {
      id: "a-1",
      function: {
        name: "answer.submit",
        arguments: { pad: "a".repeat(pad) },
      },
    };
    try {
      normalizeOllamaResponse(ollamaBody([call]), ANSWER_TOOLS);
      expect.unreachable();
    } catch (error) {
      expectAnswerInvalid(error);
    }
  });

  it("ordinary malformed stays tool_call_invalid", () => {
    const call = {
      id: "c-1",
      function: { name: "notes.search", arguments: `{broken ${SECRET}` },
    };
    try {
      normalizeOllamaResponse(ollamaBody([call]), ORDINARY_TOOLS);
      expect.unreachable();
    } catch (error) {
      expect((error as ModelLocalError).code).toBe("tool_call_invalid");
      expect((error as ModelLocalError).message).not.toContain(SECRET);
    }
  });
});
