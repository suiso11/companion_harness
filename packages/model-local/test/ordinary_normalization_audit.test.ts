// Ordinary vs answer.submit native normalization audit (r3946441628).
//
// Error mapping matrix (fixed, redacted, no raw id/args/body in errors):
// - ordinary-only malformed args (bad JSON shape / non-object) -> tool_call_invalid
// - ordinary-only oversize args -> invalid_response
// - answer-only malformed args (bad JSON / non-object) -> answer_invalid
// - answer-only oversize args -> answer_invalid (repairable, never invalid_response)
// - mixed valid-ordinary + malformed-answer -> answer_invalid (answer leg fails)
// - mixed malformed-ordinary + valid-answer -> tool_call_invalid (ordinary leg fails)
// - mixed oversize-ordinary + valid-answer -> invalid_response
// - mixed valid-ordinary + oversize-answer -> answer_invalid
// Every mixed batch rejects atomically (never partially accepted) with the
// first invalid leg's fixed code in call order. Free text never parses.

import { describe, expect, it } from "vitest";
import { ModelLocalError } from "../src/errors.js";
import { MAX_TOOL_CALL_ARGUMENTS_BYTES } from "../src/gateway.js";
import { normalizeOllamaResponse } from "../src/ollama.js";
import { normalizeOpenAIResponse } from "../src/openai_compatible.js";

const SECRET = "ordinary-audit-secret-must-not-leak-xyz";
const ORDINARY = { name: "notes.search", description: "search" };
const ANSWER = { name: "answer.submit", description: "submit" };
const BOTH = [ORDINARY, ANSWER];
const encoder = new TextEncoder();

function codeOf(error: unknown): string {
  expect(error).toBeInstanceOf(ModelLocalError);
  return (error as ModelLocalError).code;
}

function expectNoLeak(error: unknown): void {
  const err = error as ModelLocalError;
  expect(err.message).not.toContain(SECRET);
  expect(JSON.stringify(err)).not.toContain(SECRET);
  expect(JSON.stringify(err)).not.toContain("aaaa");
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

function openaiCall(
  name: string,
  args: unknown,
  id: string,
): unknown {
  return { id, type: "function", function: { name, arguments: args } };
}

function ollamaCall(name: string, args: unknown, id: string): unknown {
  return { id, function: { name, arguments: args } };
}

function oversizeJson(): string {
  const overhead = encoder.encode(`{"pad":""}`).byteLength;
  const pad = MAX_TOOL_CALL_ARGUMENTS_BYTES - overhead + 1;
  return JSON.stringify({ pad: "a".repeat(pad) });
}

describe("ordinary-only malformed normalization", () => {
  it("openai ordinary malformed args reject as tool_call_invalid (never answer_invalid)", () => {
    try {
      normalizeOpenAIResponse(
        openaiBody([
          openaiCall("notes.search", `{broken ${SECRET}`, "call-ord-1"),
        ]),
        [ORDINARY],
      );
      expect.unreachable();
    } catch (error) {
      expect(codeOf(error)).toBe("tool_call_invalid");
      expect(codeOf(error)).not.toBe("answer_invalid");
      expectNoLeak(error);
    }
  });

  it("ollama ordinary malformed args reject as tool_call_invalid (never answer_invalid)", () => {
    try {
      normalizeOllamaResponse(
        ollamaBody([
          ollamaCall("notes.search", `{broken ${SECRET}`, "call-ord-1"),
        ]),
        [ORDINARY],
      );
      expect.unreachable();
    } catch (error) {
      expect(codeOf(error)).toBe("tool_call_invalid");
      expect(codeOf(error)).not.toBe("answer_invalid");
      expectNoLeak(error);
    }
  });

  it("ordinary oversize rejects as invalid_response on both adapters", () => {
    const over = oversizeJson();
    try {
      normalizeOpenAIResponse(
        openaiBody([openaiCall("notes.search", over, "call-ord-2")]),
        [ORDINARY],
      );
      expect.unreachable();
    } catch (error) {
      expect(codeOf(error)).toBe("invalid_response");
      expectNoLeak(error);
    }
    try {
      normalizeOllamaResponse(
        ollamaBody([ollamaCall("notes.search", over, "call-ord-2")]),
        [ORDINARY],
      );
      expect.unreachable();
    } catch (error) {
      expect(codeOf(error)).toBe("invalid_response");
      expectNoLeak(error);
    }
  });
});

describe("answer-only malformed normalization", () => {
  it("openai answer malformed args reject as answer_invalid", () => {
    try {
      normalizeOpenAIResponse(
        openaiBody([
          openaiCall("answer.submit", `{broken ${SECRET}`, "call-ans-1"),
        ]),
        [ANSWER],
      );
      expect.unreachable();
    } catch (error) {
      expect(codeOf(error)).toBe("answer_invalid");
      expectNoLeak(error);
    }
  });

  it("ollama answer malformed args reject as answer_invalid", () => {
    try {
      normalizeOllamaResponse(
        ollamaBody([
          ollamaCall("answer.submit", `{broken ${SECRET}`, "call-ans-1"),
        ]),
        [ANSWER],
      );
      expect.unreachable();
    } catch (error) {
      expect(codeOf(error)).toBe("answer_invalid");
      expectNoLeak(error);
    }
  });

  it("answer oversize rejects as answer_invalid on both adapters", () => {
    const over = oversizeJson();
    try {
      normalizeOpenAIResponse(
        openaiBody([openaiCall("answer.submit", over, "call-ans-2")]),
        [ANSWER],
      );
      expect.unreachable();
    } catch (error) {
      expect(codeOf(error)).toBe("answer_invalid");
      expectNoLeak(error);
    }
    try {
      normalizeOllamaResponse(
        ollamaBody([ollamaCall("answer.submit", over, "call-ans-2")]),
        [ANSWER],
      );
      expect.unreachable();
    } catch (error) {
      expect(codeOf(error)).toBe("answer_invalid");
      expectNoLeak(error);
    }
  });
});

describe("mixed ordinary + answer malformed normalization", () => {
  it("openai valid-ordinary + malformed-answer rejects as answer_invalid", () => {
    try {
      normalizeOpenAIResponse(
        openaiBody([
          openaiCall("notes.search", JSON.stringify({ q: "x" }), "call-ord-ok"),
          openaiCall("answer.submit", `{broken ${SECRET}`, "call-ans-bad"),
        ]),
        BOTH,
      );
      expect.unreachable();
    } catch (error) {
      expect(codeOf(error)).toBe("answer_invalid");
      expectNoLeak(error);
    }
  });

  it("openai malformed-ordinary + valid-answer rejects as tool_call_invalid", () => {
    try {
      normalizeOpenAIResponse(
        openaiBody([
          openaiCall("notes.search", `{broken ${SECRET}`, "call-ord-bad"),
          openaiCall(
            "answer.submit",
            JSON.stringify({ version: 1, parts: [] }),
            "call-ans-ok",
          ),
        ]),
        BOTH,
      );
      expect.unreachable();
    } catch (error) {
      expect(codeOf(error)).toBe("tool_call_invalid");
      expect(codeOf(error)).not.toBe("answer_invalid");
      expectNoLeak(error);
    }
  });

  it("ollama mixed legs keep per-leg codes (atomic, order-first)", () => {
    try {
      normalizeOllamaResponse(
        ollamaBody([
          ollamaCall("notes.search", { q: "x" }, "call-ord-ok"),
          ollamaCall("answer.submit", `{broken ${SECRET}`, "call-ans-bad"),
        ]),
        BOTH,
      );
      expect.unreachable();
    } catch (error) {
      expect(codeOf(error)).toBe("answer_invalid");
      expectNoLeak(error);
    }
    try {
      normalizeOllamaResponse(
        ollamaBody([
          ollamaCall("notes.search", `{broken ${SECRET}`, "call-ord-bad"),
          ollamaCall(
            "answer.submit",
            { version: 1, parts: [] },
            "call-ans-ok",
          ),
        ]),
        BOTH,
      );
      expect.unreachable();
    } catch (error) {
      expect(codeOf(error)).toBe("tool_call_invalid");
      expect(codeOf(error)).not.toBe("answer_invalid");
      expectNoLeak(error);
    }
  });

  it("mixed oversize legs keep per-leg codes on both adapters", () => {
    const over = oversizeJson();
    // Oversize ordinary + valid answer -> invalid_response (ordinary leg).
    try {
      normalizeOpenAIResponse(
        openaiBody([
          openaiCall("notes.search", over, "call-ord-big"),
          openaiCall(
            "answer.submit",
            JSON.stringify({ version: 1, parts: [] }),
            "call-ans-ok",
          ),
        ]),
        BOTH,
      );
      expect.unreachable();
    } catch (error) {
      expect(codeOf(error)).toBe("invalid_response");
      expectNoLeak(error);
    }
    // Valid ordinary + oversize answer -> answer_invalid (answer leg).
    try {
      normalizeOpenAIResponse(
        openaiBody([
          openaiCall("notes.search", JSON.stringify({ q: "x" }), "call-ord-ok"),
          openaiCall("answer.submit", over, "call-ans-big"),
        ]),
        BOTH,
      );
      expect.unreachable();
    } catch (error) {
      expect(codeOf(error)).toBe("answer_invalid");
      expectNoLeak(error);
    }
    try {
      normalizeOllamaResponse(
        ollamaBody([
          ollamaCall("notes.search", { q: "x" }, "call-ord-ok"),
          ollamaCall("answer.submit", over, "call-ans-big"),
        ]),
        BOTH,
      );
      expect.unreachable();
    } catch (error) {
      expect(codeOf(error)).toBe("answer_invalid");
      expectNoLeak(error);
    }
  });
});
