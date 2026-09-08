// Replay-side per-call tool arguments bound (r3946625239).
//
// Every replayed assistant `toolCalls[].arguments` shares the 32KiB UTF-8
// deterministic serialized bound (`MAX_TOOL_CALL_ARGUMENTS_BYTES`) enforced
// on provider output. The check runs during `validateChatRequest`/history
// validation — before either adapter JSON.stringify/request construction —
// so oversize/cyclic/non-serializable replay rejects with fixed redacted
// `invalid_request` without allocating the wire body. Never truncated, never
// echoes raw args, never touches ToolBroker budget (validation only).

import { describe, expect, it } from "vitest";
import { ModelLocalError } from "../src/errors.js";
import {
  canonicalToolArgumentsJson,
  MAX_TOOL_CALL_ARGUMENTS_BYTES,
  utf8ByteLength,
  validateChatRequest,
} from "../src/gateway.js";
import { createOllamaGateway } from "../src/ollama.js";
import { createOpenAICompatibleGateway } from "../src/openai_compatible.js";
import type { ChatRequest, FetchImpl } from "../src/types.js";

const SECRET_MARKER = "replay-secret-must-not-leak-xyz";
const encoder = new TextEncoder();

function expectInvalidRequest(error: unknown): ModelLocalError {
  expect(error).toBeInstanceOf(ModelLocalError);
  const err = error as ModelLocalError;
  expect(err.code).toBe("invalid_request");
  expect(err.message).toBe("model message carries invalid tool calls");
  expect(err.message).not.toContain(SECRET_MARKER);
  expect(JSON.stringify(err)).not.toContain(SECRET_MARKER);
  return err;
}

function replayRequest(args: unknown): ChatRequest {
  return {
    model: "m",
    messages: [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c0", name: "notes.search", arguments: args }],
      },
    ],
  };
}

/** ASCII `{"pad":"..."}` overhead: 10 bytes, so pad length fills the rest. */
const ASCII_OVERHEAD = encoder.encode(`{"pad":""}`).byteLength;
const ASCII_PAD_AT_BOUND = MAX_TOOL_CALL_ARGUMENTS_BYTES - ASCII_OVERHEAD;

/** Multibyte `é` is 2 UTF-8 bytes: exact-bound pad count is integral. */
const E_ACUTE_PAD_AT_BOUND =
  (MAX_TOOL_CALL_ARGUMENTS_BYTES - ASCII_OVERHEAD) / 2;

function mockFetch(): {
  fetchImpl: FetchImpl;
  calls: unknown[];
} {
  const calls: unknown[] = [];
  const fetchImpl: FetchImpl = async () => {
    calls.push(1);
    return new Response(
      JSON.stringify({
        message: { role: "assistant", content: "done" },
        choices: [
          {
            message: { role: "assistant", content: "done" },
            finish_reason: "stop",
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  return { fetchImpl, calls };
}

describe("replay arguments bound via validateChatRequest", () => {
  it("accepts exactly 32KiB ascii replay and rejects 32KiB + 1", () => {
    const exact = { pad: "a".repeat(ASCII_PAD_AT_BOUND) };
    expect(encoder.encode(canonicalToolArgumentsJson(exact)).byteLength).toBe(
      MAX_TOOL_CALL_ARGUMENTS_BYTES,
    );
    expect(() => validateChatRequest(replayRequest(exact))).not.toThrow();

    const over = { pad: "a".repeat(ASCII_PAD_AT_BOUND + 1) };
    expect(encoder.encode(canonicalToolArgumentsJson(over)).byteLength).toBe(
      MAX_TOOL_CALL_ARGUMENTS_BYTES + 1,
    );
    try {
      validateChatRequest(replayRequest(over));
      expect.unreachable();
    } catch (error) {
      const err = expectInvalidRequest(error);
      expect(JSON.stringify(err)).not.toContain("aaaa");
    }
  });

  it("enforces bytes not characters with multibyte replay payloads", () => {
    const exact = { pad: "é".repeat(E_ACUTE_PAD_AT_BOUND) };
    const exactRaw = canonicalToolArgumentsJson(exact);
    expect(exactRaw.length).toBeLessThan(MAX_TOOL_CALL_ARGUMENTS_BYTES);
    expect(encoder.encode(exactRaw).byteLength).toBe(
      MAX_TOOL_CALL_ARGUMENTS_BYTES,
    );
    expect(() => validateChatRequest(replayRequest(exact))).not.toThrow();

    const over = { pad: "é".repeat(E_ACUTE_PAD_AT_BOUND + 1) };
    const overRaw = canonicalToolArgumentsJson(over);
    expect(overRaw.length).toBeLessThan(MAX_TOOL_CALL_ARGUMENTS_BYTES);
    expect(encoder.encode(overRaw).byteLength).toBeGreaterThan(
      MAX_TOOL_CALL_ARGUMENTS_BYTES,
    );
    try {
      validateChatRequest(replayRequest(over));
      expect.unreachable();
    } catch (error) {
      expectInvalidRequest(error);
    }
  });

  it("enforces exact boundary on nested replay payloads", () => {
    const nestedOverhead = encoder.encode(`{"outer":{"pad":""}}`).byteLength;
    const padAtBound = MAX_TOOL_CALL_ARGUMENTS_BYTES - nestedOverhead;
    const exact = { outer: { pad: "a".repeat(padAtBound) } };
    expect(encoder.encode(canonicalToolArgumentsJson(exact)).byteLength).toBe(
      MAX_TOOL_CALL_ARGUMENTS_BYTES,
    );
    expect(() => validateChatRequest(replayRequest(exact))).not.toThrow();

    const over = { outer: { pad: "a".repeat(padAtBound + 1) } };
    expect(encoder.encode(canonicalToolArgumentsJson(over)).byteLength).toBe(
      MAX_TOOL_CALL_ARGUMENTS_BYTES + 1,
    );
    try {
      validateChatRequest(replayRequest(over));
      expect.unreachable();
    } catch (error) {
      const err = expectInvalidRequest(error);
      expect(JSON.stringify(err)).not.toContain("aaaa");
    }
  });

  it("is deterministic: key order does not change the measured bound", () => {
    const a = { b: 1, a: "x".repeat(100) };
    const b = { a: "x".repeat(100), b: 1 };
    expect(canonicalToolArgumentsJson(a)).toBe(canonicalToolArgumentsJson(b));
    expect(utf8ByteLength(canonicalToolArgumentsJson(a))).toBeLessThan(
      MAX_TOOL_CALL_ARGUMENTS_BYTES,
    );
    expect(() => validateChatRequest(replayRequest(b))).not.toThrow();
  });

  it("rejects cyclic replay without leaking or allocating the wire body", () => {
    const cyclic = { pad: "x" } as Record<string, unknown>;
    cyclic.self = cyclic;
    try {
      validateChatRequest(replayRequest(cyclic));
      expect.unreachable();
    } catch (error) {
      expectInvalidRequest(error);
    }
  });

  it("rejects non-serializable (BigInt) replay without leaking", () => {
    const args = { pad: 10n } as unknown as Record<string, unknown>;
    try {
      validateChatRequest(replayRequest(args));
      expect.unreachable();
    } catch (error) {
      expectInvalidRequest(error);
    }
  });

  it("rejects oversize secret-bearing replay without echoing it", () => {
    const over = {
      pad: `${SECRET_MARKER}${"a".repeat(ASCII_PAD_AT_BOUND)}`,
    };
    try {
      validateChatRequest(replayRequest(over));
      expect.unreachable();
    } catch (error) {
      expectInvalidRequest(error);
    }
  });
});

describe.each([
  ["ollama", createOllamaGateway, "http://localhost:11434"],
  ["openai-compatible", createOpenAICompatibleGateway, "http://localhost:8000"],
] as const)(
  "replay bound before %s request construction",
  (_label, make, baseUrl) => {
    it("rejects oversized replay with invalid_request before fetch", async () => {
      const { fetchImpl, calls } = mockFetch();
      const gateway = make({ baseUrl, fetchImpl });
      const over = { pad: "a".repeat(ASCII_PAD_AT_BOUND + 1) };
      await expect(gateway.chat(replayRequest(over))).rejects.toMatchObject({
        code: "invalid_request",
      });
      expect(calls).toHaveLength(0);
    });

    it("rejects cyclic replay with invalid_request before fetch", async () => {
      const { fetchImpl, calls } = mockFetch();
      const gateway = make({ baseUrl, fetchImpl });
      const cyclic = { pad: "x" } as Record<string, unknown>;
      cyclic.self = cyclic;
      await expect(gateway.chat(replayRequest(cyclic))).rejects.toMatchObject({
        code: "invalid_request",
      });
      expect(calls).toHaveLength(0);
    });

    it("accepts exact-bound ascii, multibyte, and nested replay", async () => {
      const nestedOverhead = encoder.encode(`{"outer":{"pad":""}}`).byteLength;
      const cases: unknown[] = [
        { pad: "a".repeat(ASCII_PAD_AT_BOUND) },
        { pad: "é".repeat(E_ACUTE_PAD_AT_BOUND) },
        {
          outer: {
            pad: "a".repeat(MAX_TOOL_CALL_ARGUMENTS_BYTES - nestedOverhead),
          },
        },
      ];
      for (const args of cases) {
        const { fetchImpl, calls } = mockFetch();
        const gateway = make({ baseUrl, fetchImpl });
        await gateway.chat(replayRequest(args));
        expect(calls).toHaveLength(1);
      }
    });
  },
);
