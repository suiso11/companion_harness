// Final wire-side tool arguments bound (m2-wire-size-recheck).
//
// `toWireToolArgumentsJson` enforces the final 32KiB UTF-8 check on the
// canonical string immediately before adapters send it, and
// `toWireToolArgumentsObject` derives only from that checked string (no
// independent path). Stateful small-then-large arguments (small during
// history validation, large at wire serialization) reject with fixed
// redacted `invalid_request` before fetch on both adapters. Never
// truncated, never echoes raw arguments.

import { describe, expect, it } from "vitest";
import { ModelLocalError } from "../src/errors.js";
import {
  canonicalToolArgumentsJson,
  MAX_TOOL_CALL_ARGUMENTS_BYTES,
  toWireToolArgumentsJson,
  toWireToolArgumentsObject,
  utf8ByteLength,
} from "../src/gateway.js";
import { createOllamaGateway, toOllamaMessage } from "../src/ollama.js";
import {
  createOpenAICompatibleGateway,
  toOpenAIMessage,
} from "../src/openai_compatible.js";
import type { ChatRequest, FetchImpl } from "../src/types.js";

const SECRET_MARKER = "wire-final-secret-must-not-leak-xyz";
const encoder = new TextEncoder();

/** ASCII `{"pad":"..."}` overhead: 10 bytes, so pad length fills the rest. */
const ASCII_OVERHEAD = encoder.encode(`{"pad":""}`).byteLength;
const ASCII_PAD_AT_BOUND = MAX_TOOL_CALL_ARGUMENTS_BYTES - ASCII_OVERHEAD;

function expectInvalidRequest(error: unknown): ModelLocalError {
  expect(error).toBeInstanceOf(ModelLocalError);
  const err = error as ModelLocalError;
  expect(err.code).toBe("invalid_request");
  expect(err.message).toBe("model message carries invalid tool calls");
  expect(err.message).not.toContain(SECRET_MARKER);
  expect(JSON.stringify(err)).not.toContain(SECRET_MARKER);
  return err;
}

function mockFetch(): { fetchImpl: FetchImpl; calls: unknown[] } {
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

/**
 * Stateful arguments: the first `pad` descriptor read (history validation)
 * serves a small value, every later read (wire serialization) serves an
 * oversize value. Models a TOCTOU mutation between validation and send.
 * Only the inert `getOwnPropertyDescriptor` trap is stateful; no getter,
 * setter, or `toJSON` is ever invoked.
 */
function smallThenLargeArgs(): unknown {
  const large = `${SECRET_MARKER}${"a".repeat(ASCII_PAD_AT_BOUND)}`;
  const target: Record<string, unknown> = { pad: "x" };
  let reads = 0;
  return new Proxy(target, {
    getOwnPropertyDescriptor(t, p) {
      if (p === "pad") {
        reads += 1;
        const value = reads <= 1 ? "x" : large;
        return {
          configurable: true,
          enumerable: true,
          writable: true,
          value,
        };
      }
      return Reflect.getOwnPropertyDescriptor(t, p);
    },
  });
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

describe("final wire bound on the canonical string", () => {
  it("accepts exactly 32KiB and rejects 32KiB + 1 with fixed invalid_request", () => {
    const exact = { pad: "a".repeat(ASCII_PAD_AT_BOUND) };
    const wire = toWireToolArgumentsJson(exact);
    expect(utf8ByteLength(wire)).toBe(MAX_TOOL_CALL_ARGUMENTS_BYTES);
    expect(wire).toBe(canonicalToolArgumentsJson(exact));

    const over = { pad: "a".repeat(ASCII_PAD_AT_BOUND + 1) };
    expect(encoder.encode(canonicalToolArgumentsJson(over)).byteLength).toBe(
      MAX_TOOL_CALL_ARGUMENTS_BYTES + 1,
    );
    try {
      toWireToolArgumentsJson(over);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ModelLocalError);
      expect((error as ModelLocalError).code).toBe("invalid_request");
    }
    try {
      toWireToolArgumentsJson({
        pad: `${SECRET_MARKER}${"a".repeat(ASCII_PAD_AT_BOUND)}`,
      });
      expect.unreachable();
    } catch (error) {
      expectInvalidRequest(error);
    }
  });

  it("object form derives only from the checked string", () => {
    const exact = { pad: "a".repeat(ASCII_PAD_AT_BOUND) };
    const obj = toWireToolArgumentsObject(exact) as unknown;
    expect(JSON.stringify(obj)).toBe(toWireToolArgumentsJson(exact));
    const over = { pad: "a".repeat(ASCII_PAD_AT_BOUND + 1) };
    try {
      toWireToolArgumentsObject(over);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ModelLocalError);
      expect((error as ModelLocalError).code).toBe("invalid_request");
    }
  });

  it("wire serializers map oversize replay to invalid_request without fetch", () => {
    const over = { pad: "a".repeat(ASCII_PAD_AT_BOUND + 1) };
    for (const toMessage of [toOpenAIMessage, toOllamaMessage]) {
      try {
        toMessage({
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c0", name: "notes.search", arguments: over }],
        });
        expect.unreachable();
      } catch (error) {
        expectInvalidRequest(error);
      }
    }
  });
});

describe.each([
  ["openai-compatible", createOpenAICompatibleGateway, "http://localhost:8000"],
  ["ollama", createOllamaGateway, "http://localhost:11434"],
] as const)(
  "stateful small-then-large replay before %s fetch",
  (_label, make, baseUrl) => {
    it("fails with fixed invalid_request before fetch and never sends", async () => {
      const { fetchImpl, calls } = mockFetch();
      const gateway = make({ baseUrl, fetchImpl });
      await expect(
        gateway.chat(replayRequest(smallThenLargeArgs())),
      ).rejects.toMatchObject({
        code: "invalid_request",
        message: "model message carries invalid tool calls",
      });
      expect(calls).toHaveLength(0);
    });

    it("sends small replay but blocks the large follow-up on the same gateway", async () => {
      const { fetchImpl, calls } = mockFetch();
      const gateway = make({ baseUrl, fetchImpl });
      await gateway.chat(
        replayRequest({ pad: "a".repeat(ASCII_PAD_AT_BOUND) }),
      );
      expect(calls).toHaveLength(1);
      await expect(
        gateway.chat(replayRequest(smallThenLargeArgs())),
      ).rejects.toMatchObject({
        code: "invalid_request",
      });
      expect(calls).toHaveLength(1);
    });
  },
);
