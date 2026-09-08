// Provider assistant-text bound (normalized output, both adapters).
//
// Normalized provider assistant `text` is at most MAX_MESSAGE_CONTENT_LENGTH
// (65_536 chars, character semantics matching ChatMessage validation:
// `text.length`, UTF-16 code units, not UTF-8 bytes) before AgentStrategy
// stores it for replay. Empty text stays valid when native tool calls exist;
// oversize text rejects atomically with fixed redacted invalid_response (no
// truncation, no raw text in the error, no tool execution). The text check
// runs before per-call argument parsing so an oversize batch containing a
// malformed answer.submit still fails as invalid_response (never
// answer_invalid, never repaired); valid answer.submit arguments are
// unaffected.

import { describe, expect, it } from "vitest";
import { ModelLocalError } from "../src/errors.js";
import {
  assertAssistantTextWithinBound,
  MAX_MESSAGE_CONTENT_LENGTH,
} from "../src/gateway.js";
import { normalizeOllamaResponse } from "../src/ollama.js";
import { normalizeOpenAIResponse } from "../src/openai_compatible.js";

const SECRET = "text-bound-secret-must-not-leak-4x9q";
const ORDINARY = { name: "notes.search", description: "search" };
const ANSWER = { name: "answer.submit", description: "submit" };

function openaiBody(content: unknown, toolCalls?: unknown[]): unknown {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content,
          ...(toolCalls === undefined ? {} : { tool_calls: toolCalls }),
        },
        finish_reason: toolCalls !== undefined ? "tool_calls" : "stop",
      },
    ],
  };
}

function ollamaBody(content: unknown, toolCalls?: unknown[]): unknown {
  return {
    message: {
      role: "assistant",
      content,
      ...(toolCalls === undefined ? {} : { tool_calls: toolCalls }),
    },
    done: true,
  };
}

function openaiOrdinaryCall(id: string): unknown {
  return {
    id,
    type: "function",
    function: { name: "notes.search", arguments: {} },
  };
}

function ollamaOrdinaryCall(id: string): unknown {
  return { id, function: { name: "notes.search", arguments: {} } };
}

function validAnswerArgs(): unknown {
  return { version: 1, parts: [{ text: "done", citations: [] }] };
}

function expectInvalidResponse(error: unknown): void {
  expect(error).toBeInstanceOf(ModelLocalError);
  const err = error as ModelLocalError;
  expect(err.code).toBe("invalid_response");
  expect(err.message).toBe("model returned an invalid response");
  expect(err.message).not.toContain(SECRET);
  expect(JSON.stringify(err)).not.toContain(SECRET);
}

describe("shared text bound constant", () => {
  it("is 65536 chars and the assertion matches ChatMessage (.length) semantics", () => {
    expect(MAX_MESSAGE_CONTENT_LENGTH).toBe(65_536);
    expect(() =>
      assertAssistantTextWithinBound("x".repeat(65_536)),
    ).not.toThrow();
    try {
      assertAssistantTextWithinBound("x".repeat(65_537));
      expect.unreachable();
    } catch (error) {
      expectInvalidResponse(error);
    }
  });
});

describe("exact 65536 accepts / 65537 rejects (text-only, both providers)", () => {
  it("accepts exactly 65536 chars", () => {
    const text = "a".repeat(65_536);
    const oai = normalizeOpenAIResponse(openaiBody(text), undefined);
    expect(oai.text.length).toBe(65_536);
    expect(oai.text).toBe(text);
    const ol = normalizeOllamaResponse(ollamaBody(text), undefined);
    expect(ol.text.length).toBe(65_536);
    expect(ol.text).toBe(text);
  });

  it("rejects 65537 chars atomically with fixed redacted invalid_response", () => {
    const text = `b${"a".repeat(65_500)}${SECRET}`;
    expect(text.length).toBe(65_537);
    try {
      normalizeOpenAIResponse(openaiBody(text), undefined);
      expect.unreachable();
    } catch (error) {
      expectInvalidResponse(error);
    }
    try {
      normalizeOllamaResponse(ollamaBody(text), undefined);
      expect.unreachable();
    } catch (error) {
      expectInvalidResponse(error);
    }
  });
});

describe("multibyte character semantics (not bytes)", () => {
  it("counts characters: 65536 multibyte chars fit despite exceeding 65536 bytes", () => {
    // "é" is 1 char but 2 UTF-8 bytes: 65536 chars = 131072 bytes.
    const text = "é".repeat(65_536);
    expect(text.length).toBe(65_536);
    expect(new TextEncoder().encode(text).byteLength).toBeGreaterThan(65_536);
    const oai = normalizeOpenAIResponse(openaiBody(text), undefined);
    expect(oai.text.length).toBe(65_536);
    const ol = normalizeOllamaResponse(ollamaBody(text), undefined);
    expect(ol.text.length).toBe(65_536);
  });

  it("rejects 65537 multibyte chars without echo", () => {
    const text = "あ".repeat(65_537);
    expect(text.length).toBe(65_537);
    try {
      normalizeOpenAIResponse(openaiBody(text), undefined);
      expect.unreachable();
    } catch (error) {
      expectInvalidResponse(error);
      expect((error as Error).message).not.toContain("あ".repeat(8));
    }
    try {
      normalizeOllamaResponse(ollamaBody(text), undefined);
      expect.unreachable();
    } catch (error) {
      expectInvalidResponse(error);
    }
  });

  it("counts surrogate pairs as 2 per ChatMessage validation", () => {
    // "😀".length === 2 (UTF-16 units): 32768 pairs fill exactly 65536.
    expect("😀".length).toBe(2);
    const fit = "😀".repeat(32_768);
    expect(fit.length).toBe(65_536);
    expect(() => assertAssistantTextWithinBound(fit)).not.toThrow();
    const over = `${fit}x`;
    expect(over.length).toBe(65_537);
    try {
      normalizeOpenAIResponse(openaiBody(over), undefined);
      expect.unreachable();
    } catch (error) {
      expectInvalidResponse(error);
    }
  });
});

describe("empty text with native tool calls stays valid", () => {
  it("accepts empty text when tool calls exist (both providers)", () => {
    const oai = normalizeOpenAIResponse(
      openaiBody("", [openaiOrdinaryCall("c-1")]),
      [ORDINARY],
    );
    expect(oai.text).toBe("");
    expect(oai.toolCalls).toHaveLength(1);
    const ol = normalizeOllamaResponse(
      ollamaBody("", [ollamaOrdinaryCall("c-1")]),
      [ORDINARY],
    );
    expect(ol.text).toBe("");
    expect(ol.toolCalls).toHaveLength(1);
  });
});

describe("tool-call responses with oversize text reject atomically", () => {
  it("rejects oversize text + valid ordinary calls as invalid_response", () => {
    const text = "z".repeat(65_537);
    try {
      normalizeOpenAIResponse(openaiBody(text, [openaiOrdinaryCall("c-oai")]), [
        ORDINARY,
      ]);
      expect.unreachable();
    } catch (error) {
      expectInvalidResponse(error);
    }
    try {
      normalizeOllamaResponse(ollamaBody(text, [ollamaOrdinaryCall("c-ol")]), [
        ORDINARY,
      ]);
      expect.unreachable();
    } catch (error) {
      expectInvalidResponse(error);
    }
  });

  it("text check precedes argument parsing: oversize text + malformed answer still invalid_response", () => {
    const text = `q`.repeat(65_537);
    const badAnswerOai = {
      id: "a-bad",
      type: "function",
      function: { name: "answer.submit", arguments: `{broken ${SECRET}` },
    };
    try {
      normalizeOpenAIResponse(openaiBody(text, [badAnswerOai]), [ANSWER]);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ModelLocalError);
      expect((error as ModelLocalError).code).toBe("invalid_response");
      expect((error as Error).message).not.toContain(SECRET);
    }
    const badAnswerOl = {
      id: "a-bad",
      function: { name: "answer.submit", arguments: `{broken ${SECRET}` },
    };
    try {
      normalizeOllamaResponse(ollamaBody(text, [badAnswerOl]), [ANSWER]);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ModelLocalError);
      expect((error as ModelLocalError).code).toBe("invalid_response");
      expect((error as Error).message).not.toContain(SECRET);
    }
  });

  it("valid answer.submit arguments unaffected at the boundary", () => {
    const fit = "a".repeat(65_536);
    const oaiCall = {
      id: "a-ok",
      type: "function",
      function: { name: "answer.submit", arguments: validAnswerArgs() },
    };
    const oai = normalizeOpenAIResponse(openaiBody(fit, [oaiCall]), [ANSWER]);
    expect(oai.text.length).toBe(65_536);
    expect(oai.toolCalls).toHaveLength(1);
    expect(oai.toolCalls[0]?.name).toBe("answer.submit");
    const olCall = {
      id: "a-ok",
      function: { name: "answer.submit", arguments: validAnswerArgs() },
    };
    const ol = normalizeOllamaResponse(ollamaBody(fit, [olCall]), [ANSWER]);
    expect(ol.text.length).toBe(65_536);
    expect(ol.toolCalls).toHaveLength(1);
  });
});
