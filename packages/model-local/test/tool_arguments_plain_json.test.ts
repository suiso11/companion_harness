// Plain-JSON tool-call arguments (r3949275132).
//
// Tool-call arguments are accepted only as plain JSON data, and the exact
// serialized representation measured against the 32KiB bound is the
// representation the adapters send. Custom `toJSON`, accessors, symbols,
// functions, non-plain prototypes, cycles, and unsupported values reject
// without invoking user code (no getter/`toJSON` call, no proxy-trap call
// beyond inert structural reads). Provider `JSON.parse` output (plain
// objects/arrays/primitives, including `__proto__` own keys) remains valid.
// All failures use fixed redacted codes with no raw arguments in errors.

import { describe, expect, it } from "vitest";
import { ModelLocalError } from "../src/errors.js";
import {
  canonicalToolArgumentsJson,
  MAX_TOOL_CALL_ARGUMENTS_BYTES,
  toWireToolArgumentsJson,
  toWireToolArgumentsObject,
  utf8ByteLength,
  validateChatRequest,
} from "../src/gateway.js";
import { normalizeOllamaResponse, toOllamaMessage } from "../src/ollama.js";
import {
  normalizeOpenAIResponse,
  toOpenAIMessage,
} from "../src/openai_compatible.js";
import type { ChatRequest } from "../src/types.js";

const SECRET_MARKER = "plain-json-secret-must-not-leak-xyz";
const ORDINARY_TOOLS = [{ name: "notes.search", description: "search" }];
const ANSWER_TOOLS = [{ name: "answer.submit", description: "submit" }];

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

function openaiCall(args: unknown, name = "notes.search"): unknown {
  return {
    id: "call_1",
    type: "function",
    function: { name, arguments: args },
  };
}

function ollamaCall(args: unknown, name = "notes.search"): unknown {
  return { id: "call_1", function: { name, arguments: args } };
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

function expectRedacted(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(ModelLocalError);
  expect((error as ModelLocalError).code).toBe(code);
  expect((error as ModelLocalError).message).not.toContain(SECRET_MARKER);
  expect(JSON.stringify(error)).not.toContain(SECRET_MARKER);
}

describe("custom toJSON is rejected without invocation", () => {
  it("rejects own toJSON on provider object form without calling it", () => {
    let invoked = false;
    const args: Record<string, unknown> = {
      pad: SECRET_MARKER,
      toJSON() {
        invoked = true;
        return { pad: "small" };
      },
    };
    for (const [normalize, body, call] of [
      [normalizeOpenAIResponse, openaiBody, openaiCall],
      [normalizeOllamaResponse, ollamaBody, ollamaCall],
    ] as const) {
      try {
        normalize(body([call(args)]), ORDINARY_TOOLS);
        expect.unreachable();
      } catch (error) {
        expectRedacted(error, "tool_call_invalid");
      }
    }
    expect(invoked).toBe(false);
  });

  it("rejects inherited toJSON without calling it", () => {
    let invoked = false;
    const args = Object.create({
      toJSON() {
        invoked = true;
        return {};
      },
    }) as Record<string, unknown>;
    args.q = SECRET_MARKER;
    try {
      normalizeOpenAIResponse(openaiBody([openaiCall(args)]), ORDINARY_TOOLS);
      expect.unreachable();
    } catch (error) {
      expectRedacted(error, "tool_call_invalid");
    }
    expect(invoked).toBe(false);
  });

  it("rejects toJSON replay and wire serialization without calling it", () => {
    let invoked = false;
    const args: Record<string, unknown> = {
      q: "x",
      toJSON() {
        invoked = true;
        return { q: "x" };
      },
    };
    try {
      validateChatRequest(replayRequest(args));
      expect.unreachable();
    } catch (error) {
      expectRedacted(error, "invalid_request");
    }
    expect(() => toWireToolArgumentsJson(args)).toThrow(TypeError);
    expect(() => toWireToolArgumentsObject(args)).toThrow(TypeError);
    expect(invoked).toBe(false);
  });

  it("maps answer.submit toJSON object form to answer_invalid", () => {
    const args = {
      version: 1,
      toJSON() {
        return { version: 1 };
      },
    };
    try {
      normalizeOpenAIResponse(
        openaiBody([openaiCall(args, "answer.submit")]),
        ANSWER_TOOLS,
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ModelLocalError);
      expect((error as ModelLocalError).code).toBe("answer_invalid");
    }
  });
});

describe("accessors are rejected without invocation", () => {
  it("rejects getters without calling them", () => {
    let invoked = false;
    const args: Record<string, unknown> = { ok: true };
    Object.defineProperty(args, "pad", {
      enumerable: true,
      get() {
        invoked = true;
        return SECRET_MARKER;
      },
    });
    for (const [normalize, body, call] of [
      [normalizeOpenAIResponse, openaiBody, openaiCall],
      [normalizeOllamaResponse, ollamaBody, ollamaCall],
    ] as const) {
      try {
        normalize(body([call(args)]), ORDINARY_TOOLS);
        expect.unreachable();
      } catch (error) {
        expectRedacted(error, "tool_call_invalid");
      }
    }
    try {
      validateChatRequest(replayRequest(args));
      expect.unreachable();
    } catch (error) {
      expectRedacted(error, "invalid_request");
    }
    expect(invoked).toBe(false);
  });

  it("rejects setter-only and nested accessors", () => {
    const setterOnly: Record<string, unknown> = {};
    Object.defineProperty(setterOnly, "x", {
      enumerable: true,
      set(_value: unknown) {},
    });
    expect(() => canonicalToolArgumentsJson(setterOnly)).toThrow(TypeError);
    const nested: Record<string, unknown> = { outer: {} };
    Object.defineProperty(nested.outer, "y", {
      enumerable: true,
      get() {
        return 1;
      },
    });
    expect(() => canonicalToolArgumentsJson(nested)).toThrow(TypeError);
  });
});

describe("symbols, functions, and unsupported values are rejected", () => {
  it("rejects symbol keys and symbol values", () => {
    const keyed = { a: 1, [Symbol("s")]: 2 };
    expect(() => canonicalToolArgumentsJson(keyed)).toThrow(TypeError);
    expect(() => canonicalToolArgumentsJson({ s: Symbol("x") })).toThrow(
      TypeError,
    );
    try {
      validateChatRequest(replayRequest(keyed));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ModelLocalError);
      expect((error as ModelLocalError).code).toBe("invalid_request");
    }
  });

  it("rejects function and undefined values (previously silently dropped)", () => {
    // Before the fix these serialized as `{}` and undercounted the bound.
    expect(() => canonicalToolArgumentsJson({ f: () => 1 })).toThrow(TypeError);
    expect(() => canonicalToolArgumentsJson({ u: undefined })).toThrow(
      TypeError,
    );
    expect(() => canonicalToolArgumentsJson({ arr: [undefined] })).toThrow(
      TypeError,
    );
    try {
      normalizeOllamaResponse(
        ollamaBody([ollamaCall({ f: () => 1, pad: SECRET_MARKER })]),
        ORDINARY_TOOLS,
      );
      expect.unreachable();
    } catch (error) {
      expectRedacted(error, "tool_call_invalid");
    }
  });

  it("rejects bigint and non-finite numbers", () => {
    expect(() => canonicalToolArgumentsJson({ n: 10n })).toThrow(TypeError);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => canonicalToolArgumentsJson({ n: bad })).toThrow(TypeError);
    }
    // Finite numbers stay valid.
    expect(canonicalToolArgumentsJson({ n: 1.5 })).toBe(`{"n":1.5}`);
  });
});

describe("prototypes, arrays, and cycles", () => {
  it("rejects class instances and array subclasses", () => {
    class ToolArgs {
      q = SECRET_MARKER;
    }
    expect(() => canonicalToolArgumentsJson(new ToolArgs())).toThrow(TypeError);
    const sub = [1, 2] as unknown[];
    Object.setPrototypeOf(sub, Object.create(Array.prototype));
    expect(() => canonicalToolArgumentsJson({ list: sub })).toThrow(TypeError);
  });

  it("rejects cycles without hanging", () => {
    const cyclic = { pad: SECRET_MARKER } as Record<string, unknown>;
    cyclic.self = cyclic;
    expect(() => canonicalToolArgumentsJson(cyclic)).toThrow(TypeError);
    try {
      normalizeOpenAIResponse(openaiBody([openaiCall(cyclic)]), ORDINARY_TOOLS);
      expect.unreachable();
    } catch (error) {
      expectRedacted(error, "tool_call_invalid");
    }
  });

  it("rejects array holes and extra array keys", () => {
    // biome-ignore lint/suspicious/noSparseArray: the hole is the test subject.
    const holey = { list: [1, , 3] as unknown[] };
    expect(() => canonicalToolArgumentsJson(holey)).toThrow(TypeError);
    const extra = [1, 2] as unknown as Record<string, unknown>;
    extra.note = SECRET_MARKER;
    expect(() => canonicalToolArgumentsJson({ list: extra })).toThrow(
      TypeError,
    );
  });

  it("accepts null-prototype objects as plain data", () => {
    const args: Record<string, unknown> = Object.create(null);
    args.q = "x";
    expect(canonicalToolArgumentsJson(args)).toBe(`{"q":"x"}`);
    expect(() => validateChatRequest(replayRequest(args))).not.toThrow();
  });
});

describe("provider JSON-parsed objects remain valid", () => {
  it("accepts parsed objects with __proto__/constructor keys", () => {
    const args = JSON.parse(
      `{"__proto__":{"x":1},"constructor":{"y":2},"a":[1,{"b":null}],"n":3}`,
    ) as unknown;
    const open = normalizeOpenAIResponse(
      openaiBody([openaiCall(args)]),
      ORDINARY_TOOLS,
    );
    expect(open.toolCalls).toHaveLength(1);
    const ollama = normalizeOllamaResponse(
      ollamaBody([ollamaCall(args)]),
      ORDINARY_TOOLS,
    );
    expect(ollama.toolCalls).toHaveLength(1);
    expect(() => validateChatRequest(replayRequest(args))).not.toThrow();
  });
});

describe("measured representation is the wire representation", () => {
  const ARGS = { z: 1, a: { d: [3, 2], c: "x" }, m: "y" };

  it("openai wire string equals the measured canonical string", () => {
    const canonical = canonicalToolArgumentsJson(ARGS);
    const message = toOpenAIMessage({
      role: "assistant",
      content: "",
      toolCalls: [{ id: "c0", name: "notes.search", arguments: ARGS }],
    });
    const wire = (
      message.tool_calls as Array<{ function: { arguments: string } }>
    )[0]?.function.arguments;
    expect(wire).toBe(canonical);
    expect(utf8ByteLength(wire as string)).toBe(
      utf8ByteLength(toWireToolArgumentsJson(ARGS)),
    );
  });

  it("ollama wire object re-serializes to the measured bytes", () => {
    const canonical = canonicalToolArgumentsJson(ARGS);
    const message = toOllamaMessage({
      role: "assistant",
      content: "",
      toolCalls: [{ id: "c0", name: "notes.search", arguments: ARGS }],
    });
    const wireObject = (
      message.tool_calls as Array<{ function: { arguments: unknown } }>
    )[0]?.function.arguments;
    expect(wireObject).toEqual(JSON.parse(canonical));
    expect(JSON.stringify(wireObject)).toBe(canonical);
    expect(toWireToolArgumentsObject(ARGS)).toEqual(JSON.parse(canonical));
    const outer = JSON.stringify({ messages: [message] });
    expect(outer).toContain(canonical);
  });

  it("exact-bound replay measures the wire form", () => {
    const overhead = utf8ByteLength(`{"pad":""}`);
    const exact = { pad: "a".repeat(MAX_TOOL_CALL_ARGUMENTS_BYTES - overhead) };
    const wire = toWireToolArgumentsJson(exact);
    expect(utf8ByteLength(wire)).toBe(MAX_TOOL_CALL_ARGUMENTS_BYTES);
    expect(() => validateChatRequest(replayRequest(exact))).not.toThrow();
  });

  it("wire serializers reject non-plain replay as invalid_request", () => {
    const bad = { q: SECRET_MARKER, f: () => 1 };
    for (const toMessage of [toOpenAIMessage, toOllamaMessage]) {
      try {
        toMessage({
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c0", name: "notes.search", arguments: bad }],
        });
        expect.unreachable();
      } catch (error) {
        expectRedacted(error, "invalid_request");
      }
    }
  });
});
