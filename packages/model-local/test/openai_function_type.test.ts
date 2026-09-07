// OpenAI-compatible native tool-call `type` gate (r3946532966).
//
// Accept a native entry only when `entry.type` is exactly "function" and the
// `function` payload is valid. An explicit non-function string type is an
// unsupported variant: reject as fixed redacted `invalid_response` without
// inspecting or executing any function-shaped payload. A missing/non-string
// type (or a missing/invalid function payload) rejects as fixed redacted
// `tool_call_invalid`. Mixed arrays reject atomically (never partially
// accepted). Free-text content is never parsed; raw names/args never leak.

import { describe, expect, it } from "vitest";
import { ModelLocalError } from "../src/errors.js";
import { normalizeOpenAIResponse } from "../src/openai_compatible.js";

const SECRET = "function-type-secret-must-not-leak-xyz";
const TOOLS = [{ name: "notes.search", description: "search" }];

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

function validCall(id = "call-ok"): unknown {
  return {
    id,
    type: "function",
    function: { name: "notes.search", arguments: JSON.stringify({ q: "x" }) },
  };
}

function codeOf(error: unknown): string {
  expect(error).toBeInstanceOf(ModelLocalError);
  return (error as ModelLocalError).code;
}

function expectRedacted(error: unknown, secret = SECRET): void {
  const err = error as ModelLocalError;
  expect(err.message).not.toContain(secret);
  expect(JSON.stringify(err)).not.toContain(secret);
  expect(JSON.stringify(err)).not.toContain("notes.search");
  expect(JSON.stringify(err)).not.toContain("call-");
}

describe("openai function type gate", () => {
  it("accepts exact type function with a valid payload", () => {
    const result = normalizeOpenAIResponse(openaiBody([validCall()]), TOOLS);
    expect(result.toolCalls).toEqual([
      { id: "call-ok", name: "notes.search", arguments: { q: "x" } },
    ]);
  });

  it("rejects a deceptive function-shaped non-function as invalid_response without executing", () => {
    // Valid function payload, wrong discriminator: must not execute.
    const deceptive = {
      id: "call-evil",
      type: "custom",
      function: {
        name: "notes.search",
        arguments: JSON.stringify({ q: SECRET }),
      },
    };
    try {
      normalizeOpenAIResponse(openaiBody([deceptive]), TOOLS);
      expect.unreachable();
    } catch (error) {
      expect(codeOf(error)).toBe("invalid_response");
      expect((error as ModelLocalError).message).toBe(
        "model returned an invalid response",
      );
      expectRedacted(error);
    }
  });

  it("rejects near-miss string types as invalid_response", () => {
    for (const [index, type] of [
      "Function",
      "FUNCTION",
      "function ",
      " function",
      "",
    ].entries()) {
      try {
        normalizeOpenAIResponse(
          openaiBody([
            {
              id: `call-near-${index}`,
              type,
              function: {
                name: "notes.search",
                arguments: JSON.stringify({ q: "x" }),
              },
            },
          ]),
          TOOLS,
        );
        expect.unreachable(`type ${String(type)} must reject`);
      } catch (error) {
        expect(codeOf(error)).toBe("invalid_response");
        expectRedacted(error);
      }
    }
  });

  it("rejects missing or non-string types as tool_call_invalid", () => {
    const variants: unknown[] = [
      {
        id: "call-missing",
        function: { name: "notes.search", arguments: "{}" },
      },
      {
        id: "call-null",
        type: null,
        function: { name: "notes.search", arguments: "{}" },
      },
      {
        id: "call-num",
        type: 0,
        function: { name: "notes.search", arguments: "{}" },
      },
      {
        id: "call-undef",
        type: undefined,
        function: { name: "notes.search", arguments: "{}" },
      },
    ];
    for (const entry of variants) {
      try {
        normalizeOpenAIResponse(openaiBody([entry]), TOOLS);
        expect.unreachable();
      } catch (error) {
        expect(codeOf(error)).toBe("tool_call_invalid");
        expect((error as ModelLocalError).message).toBe(
          "model returned an invalid tool call",
        );
        expectRedacted(error);
      }
    }
  });

  it("rejects missing/invalid function payloads as tool_call_invalid", () => {
    const variants: unknown[] = [
      { id: "call-nofn", type: "function" },
      { id: "call-nullfn", type: "function", function: null },
      {
        id: "call-noname",
        type: "function",
        function: { arguments: JSON.stringify({ q: SECRET }) },
      },
    ];
    for (const entry of variants) {
      try {
        normalizeOpenAIResponse(openaiBody([entry]), TOOLS);
        expect.unreachable();
      } catch (error) {
        expect(codeOf(error)).toBe("tool_call_invalid");
        expectRedacted(error);
      }
    }
  });

  it("rejects mixed valid + non-function arrays atomically", () => {
    const nonFunction = {
      id: "call-bad",
      type: "custom",
      function: {
        name: "notes.search",
        arguments: JSON.stringify({ q: SECRET }),
      },
    };
    for (const calls of [
      [validCall("call-first-ok"), nonFunction],
      [nonFunction, validCall("call-second-ok")],
    ]) {
      try {
        normalizeOpenAIResponse(openaiBody(calls), TOOLS);
        expect.unreachable();
      } catch (error) {
        // Explicit string variant keeps the envelope code even when mixed.
        expect(codeOf(error)).toBe("invalid_response");
        expectRedacted(error);
      }
    }
  });

  it("rejects mixed valid + missing-type arrays as tool_call_invalid", () => {
    const missingType = {
      id: "call-missing",
      function: {
        name: "notes.search",
        arguments: JSON.stringify({ q: SECRET }),
      },
    };
    for (const calls of [
      [validCall("call-first-ok"), missingType],
      [missingType, validCall("call-second-ok")],
    ]) {
      try {
        normalizeOpenAIResponse(openaiBody(calls), TOOLS);
        expect.unreachable();
      } catch (error) {
        expect(codeOf(error)).toBe("tool_call_invalid");
        expectRedacted(error);
      }
    }
  });

  it("never derives calls from free-text content", () => {
    const result = normalizeOpenAIResponse(
      {
        choices: [
          {
            message: {
              role: "assistant",
              content: JSON.stringify({
                type: "function",
                name: "notes.search",
                arguments: { q: SECRET },
              }),
            },
            finish_reason: "stop",
          },
        ],
      },
      TOOLS,
    );
    expect(result.toolCalls).toEqual([]);
  });
});
