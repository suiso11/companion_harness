// Provider-side per-call tool arguments bound (r3943625953).
//
// Each native tool-call arguments payload is bounded by
// `MAX_TOOL_CALL_ARGUMENTS_BYTES` (32KiB UTF-8 bytes, aligned with the
// kernel ToolBroker `maxInputBytesPerCall`; the broker still
// validates/reserves every accepted ordinary call and remains
// authoritative). OpenAI string arguments are byte-checked before
// JSON.parse and the parsed JSON is validated + re-measured at its
// deterministic serialized size; Ollama object/string forms are measured
// at deterministic serialized UTF-8 size. Oversize rejects the whole
// response with fixed redacted `invalid_response` (never partially
// accepted, never truncated, no raw arguments/provider body in errors,
// no free-text JSON fallback).

import { describe, expect, it } from "vitest";
import { ModelLocalError } from "../src/errors.js";
import {
  canonicalToolArgumentsJson,
  MAX_TOOL_CALL_ARGUMENTS_BYTES,
} from "../src/gateway.js";
import { normalizeOllamaResponse } from "../src/ollama.js";
import { normalizeOpenAIResponse } from "../src/openai_compatible.js";

const SECRET_MARKER = "bound-secret-must-not-leak-xyz";
const TOOLS = [{ name: "notes.search", description: "search" }];
const encoder = new TextEncoder();

function expectInvalidResponse(error: unknown): ModelLocalError {
  expect(error).toBeInstanceOf(ModelLocalError);
  const err = error as ModelLocalError;
  expect(err.code).toBe("invalid_response");
  expect(err.message).toBe("model returned an invalid response");
  expect(err.message).not.toContain(SECRET_MARKER);
  return err;
}

function expectToolCallInvalid(error: unknown): ModelLocalError {
  expect(error).toBeInstanceOf(ModelLocalError);
  const err = error as ModelLocalError;
  expect(err.code).toBe("tool_call_invalid");
  expect(err.message).not.toContain(SECRET_MARKER);
  return err;
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

function openaiCall(args: unknown, id = "call_1"): unknown {
  return {
    id,
    type: "function",
    function: { name: "notes.search", arguments: args },
  };
}

function ollamaCall(args: unknown, id = "call_1"): unknown {
  return { id, function: { name: "notes.search", arguments: args } };
}

/** ASCII `{"pad":"..."}` overhead: 10 bytes, so pad length fills the rest. */
const ASCII_OVERHEAD = encoder.encode(`{"pad":""}`).byteLength;
const ASCII_PAD_AT_BOUND = MAX_TOOL_CALL_ARGUMENTS_BYTES - ASCII_OVERHEAD;

/** Multibyte `é` is 2 UTF-8 bytes: exact-bound pad count is integral. */
const E_ACUTE_PAD_AT_BOUND =
  (MAX_TOOL_CALL_ARGUMENTS_BYTES - ASCII_OVERHEAD) / 2;

describe("shared bound export", () => {
  it("is 32KiB in bytes", () => {
    expect(MAX_TOOL_CALL_ARGUMENTS_BYTES).toBe(32 * 1024);
    expect(Number.isInteger(E_ACUTE_PAD_AT_BOUND)).toBe(true);
  });
});

describe("openai string arguments bound", () => {
  it("accepts exactly 32KiB and rejects 32KiB + 1", () => {
    const exact = JSON.stringify({ pad: "a".repeat(ASCII_PAD_AT_BOUND) });
    expect(encoder.encode(exact).byteLength).toBe(
      MAX_TOOL_CALL_ARGUMENTS_BYTES,
    );
    const ok = normalizeOpenAIResponse(openaiBody([openaiCall(exact)]), TOOLS);
    expect(ok.toolCalls).toHaveLength(1);

    const over = JSON.stringify({ pad: "a".repeat(ASCII_PAD_AT_BOUND + 1) });
    expect(encoder.encode(over).byteLength).toBe(
      MAX_TOOL_CALL_ARGUMENTS_BYTES + 1,
    );
    try {
      normalizeOpenAIResponse(openaiBody([openaiCall(over)]), TOOLS);
      expect.unreachable();
    } catch (error) {
      expectInvalidResponse(error);
    }
  });

  it("enforces bytes not characters with multibyte payloads", () => {
    const exact = JSON.stringify({ pad: "é".repeat(E_ACUTE_PAD_AT_BOUND) });
    expect(exact.length).toBeLessThan(MAX_TOOL_CALL_ARGUMENTS_BYTES);
    expect(encoder.encode(exact).byteLength).toBe(
      MAX_TOOL_CALL_ARGUMENTS_BYTES,
    );
    const ok = normalizeOpenAIResponse(openaiBody([openaiCall(exact)]), TOOLS);
    expect(ok.toolCalls).toHaveLength(1);

    const over = JSON.stringify({ pad: "é".repeat(E_ACUTE_PAD_AT_BOUND + 1) });
    expect(over.length).toBeLessThan(MAX_TOOL_CALL_ARGUMENTS_BYTES);
    expect(encoder.encode(over).byteLength).toBeGreaterThan(
      MAX_TOOL_CALL_ARGUMENTS_BYTES,
    );
    try {
      normalizeOpenAIResponse(openaiBody([openaiCall(over)]), TOOLS);
      expect.unreachable();
    } catch (error) {
      expectInvalidResponse(error);
    }
  });

  it("keeps malformed JSON as tool_call_invalid without leaking", () => {
    try {
      normalizeOpenAIResponse(
        openaiBody([openaiCall(`{broken ${SECRET_MARKER}`)]),
        TOOLS,
      );
      expect.unreachable();
    } catch (error) {
      expectToolCallInvalid(error);
    }
  });

  it("rejects the whole response when one of several calls is oversize", () => {
    const small = JSON.stringify({ q: "x" });
    const over = JSON.stringify({ pad: "a".repeat(ASCII_PAD_AT_BOUND + 1) });
    for (const calls of [
      [openaiCall(small, "call_1"), openaiCall(over, "call_2")],
      [openaiCall(over, "call_1"), openaiCall(small, "call_2")],
    ]) {
      try {
        normalizeOpenAIResponse(openaiBody(calls), TOOLS);
        expect.unreachable();
      } catch (error) {
        const err = expectInvalidResponse(error);
        expect(JSON.stringify(err)).not.toContain("aaaa");
      }
    }
  });

  it("bounds object-form arguments without echoing them", () => {
    const over = { pad: `${SECRET_MARKER}${"a".repeat(ASCII_PAD_AT_BOUND)}` };
    try {
      normalizeOpenAIResponse(openaiBody([openaiCall(over)]), TOOLS);
      expect.unreachable();
    } catch (error) {
      expectInvalidResponse(error);
    }
  });
});

describe("ollama object/string arguments bound", () => {
  it("accepts exactly 32KiB object form and rejects 32KiB + 1", () => {
    const exact = { pad: "a".repeat(ASCII_PAD_AT_BOUND) };
    expect(encoder.encode(JSON.stringify(exact)).byteLength).toBe(
      MAX_TOOL_CALL_ARGUMENTS_BYTES,
    );
    const ok = normalizeOllamaResponse(ollamaBody([ollamaCall(exact)]), TOOLS);
    expect(ok.toolCalls).toHaveLength(1);

    const over = { pad: "a".repeat(ASCII_PAD_AT_BOUND + 1) };
    try {
      normalizeOllamaResponse(ollamaBody([ollamaCall(over)]), TOOLS);
      expect.unreachable();
    } catch (error) {
      expectInvalidResponse(error);
    }
  });

  it("bounds string form before parsing (exact accept, +1 reject)", () => {
    const exact = JSON.stringify({ pad: "a".repeat(ASCII_PAD_AT_BOUND) });
    expect(encoder.encode(exact).byteLength).toBe(
      MAX_TOOL_CALL_ARGUMENTS_BYTES,
    );
    const ok = normalizeOllamaResponse(ollamaBody([ollamaCall(exact)]), TOOLS);
    expect(ok.toolCalls).toHaveLength(1);

    const over = JSON.stringify({ pad: "a".repeat(ASCII_PAD_AT_BOUND + 1) });
    try {
      normalizeOllamaResponse(ollamaBody([ollamaCall(over)]), TOOLS);
      expect.unreachable();
    } catch (error) {
      expectInvalidResponse(error);
    }
  });

  it("enforces bytes not characters with multibyte object payloads", () => {
    const exact = { pad: "é".repeat(E_ACUTE_PAD_AT_BOUND) };
    const exactRaw = JSON.stringify(exact);
    expect(exactRaw.length).toBeLessThan(MAX_TOOL_CALL_ARGUMENTS_BYTES);
    expect(encoder.encode(exactRaw).byteLength).toBe(
      MAX_TOOL_CALL_ARGUMENTS_BYTES,
    );
    const ok = normalizeOllamaResponse(ollamaBody([ollamaCall(exact)]), TOOLS);
    expect(ok.toolCalls).toHaveLength(1);

    const over = { pad: "é".repeat(E_ACUTE_PAD_AT_BOUND + 1) };
    const overRaw = JSON.stringify(over);
    expect(overRaw.length).toBeLessThan(MAX_TOOL_CALL_ARGUMENTS_BYTES);
    expect(encoder.encode(overRaw).byteLength).toBeGreaterThan(
      MAX_TOOL_CALL_ARGUMENTS_BYTES,
    );
    try {
      normalizeOllamaResponse(ollamaBody([ollamaCall(over)]), TOOLS);
      expect.unreachable();
    } catch (error) {
      expectInvalidResponse(error);
    }
  });

  it("keeps malformed string JSON as tool_call_invalid without leaking", () => {
    try {
      normalizeOllamaResponse(
        ollamaBody([ollamaCall(`{broken ${SECRET_MARKER}`)]),
        TOOLS,
      );
      expect.unreachable();
    } catch (error) {
      expectToolCallInvalid(error);
    }
  });

  it("rejects the whole response when one of several calls is oversize", () => {
    const small = { q: "x" };
    const over = { pad: "a".repeat(ASCII_PAD_AT_BOUND + 1) };
    for (const calls of [
      [ollamaCall(small, "call_1"), ollamaCall(over, "call_2")],
      [ollamaCall(over, "call_1"), ollamaCall(small, "call_2")],
    ]) {
      try {
        normalizeOllamaResponse(ollamaBody(calls), TOOLS);
        expect.unreachable();
      } catch (error) {
        const err = expectInvalidResponse(error);
        expect(JSON.stringify(err)).not.toContain("aaaa");
      }
    }
  });

  it("never derives calls from free-text content", () => {
    const result = normalizeOllamaResponse(
      {
        message: {
          role: "assistant",
          content: JSON.stringify({ name: "notes.search", arguments: {} }),
        },
        done: true,
      },
      TOOLS,
    );
    expect(result.toolCalls).toEqual([]);
  });
});

describe("ollama provider-controlled keys size (r3944854879)", () => {
  it("counts __proto__/constructor/prototype keys without dropping or polluting", () => {
    // Build via JSON.parse so __proto__ stays an own property (an object
    // literal would invoke the prototype setter in the test itself).
    const args = JSON.parse(
      `{"__proto__":{"polluted":"${SECRET_MARKER}"},"constructor":{"x":1},"prototype":"v","a":1}`,
    ) as Record<string, unknown>;
    const canonical = canonicalToolArgumentsJson(args);
    expect(canonical).toContain('"__proto__"');
    expect(canonical).toContain('"constructor"');
    expect(canonical).toContain('"prototype"');
    expect(encoder.encode(canonical).byteLength).toBeGreaterThan(
      encoder.encode(`{"a":1}`).byteLength,
    );
    // Deterministic: key order does not affect measured bytes.
    expect(canonicalToolArgumentsJson({ b: 1, a: 1 })).toBe(
      canonicalToolArgumentsJson({ a: 1, b: 1 }),
    );
    // Legal JSON keys are accepted (never rejected by name).
    const ok = normalizeOllamaResponse(ollamaBody([ollamaCall(args)]), TOOLS);
    expect(ok.toolCalls).toHaveLength(1);
    const returned = ok.toolCalls[0]?.arguments as Record<string, unknown>;
    expect(Object.hasOwn(returned, "__proto__")).toBe(true);
    expect(Object.hasOwn(returned, "constructor")).toBe(true);
    expect(Object.hasOwn(returned, "prototype")).toBe(true);
    expect(
      (Object.prototype as Record<string, unknown>).polluted,
    ).toBeUndefined();
    expect({}).not.toHaveProperty("polluted");

    // Oversize bytes hidden inside __proto__ must reject (not undercount).
    const over = JSON.parse(
      `{"__proto__":{"pad":"${SECRET_MARKER}${"a".repeat(ASCII_PAD_AT_BOUND)}"}}`,
    ) as Record<string, unknown>;
    expect(
      encoder.encode(canonicalToolArgumentsJson(over)).byteLength,
    ).toBeGreaterThan(MAX_TOOL_CALL_ARGUMENTS_BYTES);
    try {
      normalizeOllamaResponse(ollamaBody([ollamaCall(over)]), TOOLS);
      expect.unreachable();
    } catch (error) {
      const err = expectInvalidResponse(error);
      expect(JSON.stringify(err)).not.toContain(SECRET_MARKER);
    }
    expect(
      (Object.prototype as Record<string, unknown>).polluted,
    ).toBeUndefined();
  });

  it("enforces exact boundary on nested __proto__ payload", () => {
    const nestedOverhead = encoder.encode(
      `{"__proto__":{"pad":""}}`,
    ).byteLength;
    const padAtBound = MAX_TOOL_CALL_ARGUMENTS_BYTES - nestedOverhead;
    const exact = JSON.parse(
      `{"__proto__":{"pad":"${"a".repeat(padAtBound)}"}}`,
    ) as Record<string, unknown>;
    expect(encoder.encode(canonicalToolArgumentsJson(exact)).byteLength).toBe(
      MAX_TOOL_CALL_ARGUMENTS_BYTES,
    );
    const ok = normalizeOllamaResponse(ollamaBody([ollamaCall(exact)]), TOOLS);
    expect(ok.toolCalls).toHaveLength(1);
    expect(
      (Object.prototype as Record<string, unknown>).polluted,
    ).toBeUndefined();

    const over = JSON.parse(
      `{"__proto__":{"pad":"${"a".repeat(padAtBound + 1)}"}}`,
    ) as Record<string, unknown>;
    expect(encoder.encode(canonicalToolArgumentsJson(over)).byteLength).toBe(
      MAX_TOOL_CALL_ARGUMENTS_BYTES + 1,
    );
    try {
      normalizeOllamaResponse(ollamaBody([ollamaCall(over)]), TOOLS);
      expect.unreachable();
    } catch (error) {
      const err = expectInvalidResponse(error);
      expect(JSON.stringify(err)).not.toContain("aaaa");
    }
    expect(
      (Object.prototype as Record<string, unknown>).polluted,
    ).toBeUndefined();
  });
});
