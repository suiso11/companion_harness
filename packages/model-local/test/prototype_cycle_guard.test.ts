// Prototype traversal cycle guard (m2-prototype-cycle-guard).
//
// `assertNoCustomToJSON` (via `canonicalToolArgumentsJson`) must stay finite
// against hostile `Proxy`/`getPrototypeOf` chains: self-cycles, two-node
// cycles, throwing traps, and excessive chains all reject with `TypeError`
// (mapped upstream to the existing fixed redacted codes) without invoking
// `toJSON`/getters and without leaking trap errors. Plain JSON stays valid.

import { describe, expect, it, vi } from "vitest";
import { ModelLocalError } from "../src/errors.js";
import {
  canonicalToolArgumentsJson,
  MAX_PROTOTYPE_CHAIN_LINKS,
} from "../src/gateway.js";
import { normalizeOpenAIResponse } from "../src/openai_compatible.js";

const ORDINARY_TOOLS = [{ name: "notes.search", description: "search" }];
const TRAP_SECRET = "trap-secret-must-not-leak-zyx";

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

function openaiCall(args: unknown): unknown {
  return {
    id: "call_1",
    type: "function",
    function: { name: "notes.search", arguments: args },
  };
}

describe("prototype traversal cycle guard", () => {
  it("rejects a self-cycling getPrototypeOf proxy without hanging", () => {
    const self: object = new Proxy({}, { getPrototypeOf: () => self });
    const args: Record<string, unknown> = {};
    Object.setPrototypeOf(args, self);
    expect(() => canonicalToolArgumentsJson(args)).toThrow(TypeError);
    try {
      normalizeOpenAIResponse(openaiBody([openaiCall(args)]), ORDINARY_TOOLS);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ModelLocalError);
      expect((error as ModelLocalError).code).toBe("tool_call_invalid");
    }
  });

  it("rejects a two-node prototype cycle without hanging", () => {
    const proxyB: object = new Proxy({}, { getPrototypeOf: () => proxyA });
    const proxyA: object = new Proxy({}, { getPrototypeOf: () => proxyB });
    const args: Record<string, unknown> = { ok: true };
    Object.setPrototypeOf(args, proxyA);
    expect(() => canonicalToolArgumentsJson(args)).toThrow(TypeError);
  });

  it("maps a throwing getPrototypeOf trap to TypeError without leaking", () => {
    const evil = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error(TRAP_SECRET);
        },
      },
    );
    const args: Record<string, unknown> = { ok: true };
    Object.setPrototypeOf(args, evil);
    try {
      canonicalToolArgumentsJson(args);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(TypeError);
      expect(String(error)).not.toContain(TRAP_SECRET);
      expect(JSON.stringify(error)).not.toContain(TRAP_SECRET);
    }
    try {
      normalizeOpenAIResponse(openaiBody([openaiCall(args)]), ORDINARY_TOOLS);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ModelLocalError);
      expect((error as ModelLocalError).code).toBe("tool_call_invalid");
      expect((error as ModelLocalError).message).not.toContain(TRAP_SECRET);
    }
  });

  it("rejects an excessive prototype chain with bounded getPrototypeOf calls", () => {
    let proto: object = Object.prototype;
    for (let index = 0; index < MAX_PROTOTYPE_CHAIN_LINKS + 8; index += 1) {
      proto = Object.create(proto);
    }
    const args: Record<string, unknown> = { ok: true };
    Object.setPrototypeOf(args, proto);
    const spy = vi.spyOn(Object, "getPrototypeOf");
    try {
      expect(() => canonicalToolArgumentsJson(args)).toThrow(TypeError);
      expect(spy.mock.calls.length).toBeLessThanOrEqual(
        MAX_PROTOTYPE_CHAIN_LINKS + 1,
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("accepts plain Object-prototype and null-prototype values", () => {
    expect(canonicalToolArgumentsJson({ a: 1 })).toBe(`{"a":1}`);
    const bare: Record<string, unknown> = Object.create(null);
    bare.q = "x";
    expect(canonicalToolArgumentsJson(bare)).toBe(`{"q":"x"}`);
    expect(canonicalToolArgumentsJson([1, { b: null }])).toBe(`[1,{"b":null}]`);
  });
});
