// Array length snapshot (r3951302277).
//
// Strict canonicalization captures the own data descriptor for
// `length` exactly once before traversal: `arr.length` is never read
// (each read would invoke a hostile Proxy `get` trap), accessor /
// invalid / over-bound lengths reject, a finite item-count bound derived
// from the 32KiB arguments budget prevents huge sparse allocations and
// unbounded loops, and only the captured length is iterated. Holes,
// extra keys, and symbol properties remain rejected without invoking
// getters/toJSON. Failures are `TypeError` (callers map to fixed
// redacted codes).

import { describe, expect, it } from "vitest";
import { ModelLocalError } from "../src/errors.js";
import {
  canonicalToolArgumentsJson,
  MAX_CANONICAL_ARRAY_ITEMS,
  MAX_TOOL_CALL_ARGUMENTS_BYTES,
} from "../src/gateway.js";
import { normalizeOpenAIResponse } from "../src/openai_compatible.js";

const SECRET_MARKER = "array-length-secret-must-not-leak-xyz";
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

function openaiCall(args: unknown): unknown {
  return {
    id: "call_1",
    type: "function",
    function: { name: "notes.search", arguments: args },
  };
}

describe("array length is snapshotted once via own descriptor", () => {
  it("never reads length through the get trap", () => {
    const target = [1, 2, 3];
    let getLengthCalls = 0;
    let descriptorLengthCalls = 0;
    const proxy = new Proxy(target, {
      get(t, p, receiver) {
        if (p === "length") {
          getLengthCalls += 1;
        }
        return Reflect.get(t, p, receiver);
      },
      getOwnPropertyDescriptor(t, p) {
        if (p === "length") {
          descriptorLengthCalls += 1;
        }
        return Reflect.getOwnPropertyDescriptor(
          t as object,
          p as string | symbol,
        );
      },
    });
    expect(canonicalToolArgumentsJson({ list: proxy })).toBe(
      `{"list":[1,2,3]}`,
    );
    expect(getLengthCalls).toBe(0);
    // One explicit snapshot read plus the engine's own enumerability probe
    // inside `Object.keys`; the `length` property itself (`get` trap) is
    // never touched and the snapshot value drives traversal.
    expect(descriptorLengthCalls).toBeLessThanOrEqual(2);
  });

  it("uses the first snapshot even if later descriptor reads change", () => {
    let calls = 0;
    const shifting = new Proxy([1, 2, 3], {
      getOwnPropertyDescriptor(t, p) {
        if (p === "length") {
          calls += 1;
          if (calls > 1) {
            return {
              value: 999_999,
              writable: true,
              enumerable: false,
              configurable: false,
            };
          }
        }
        return Reflect.getOwnPropertyDescriptor(
          t as object,
          p as string | symbol,
        );
      },
    });
    expect(canonicalToolArgumentsJson({ list: shifting })).toBe(
      `{"list":[1,2,3]}`,
    );
  });

  it("ignores a hostile changing get trap", () => {
    let reads = 0;
    const evil = new Proxy([1, 2], {
      get(t, p, receiver) {
        if (p === "length") {
          reads += 1;
          return reads === 1 ? 2 : 1_000_000;
        }
        return Reflect.get(t, p, receiver);
      },
      getOwnPropertyDescriptor(t, p) {
        if (p === "length") {
          return {
            value: 2,
            writable: true,
            enumerable: false,
            configurable: false,
          };
        }
        return Reflect.getOwnPropertyDescriptor(
          t as object,
          p as string | symbol,
        );
      },
    });
    expect(canonicalToolArgumentsJson({ list: evil })).toBe(`{"list":[1,2]}`);
  });

  it("rejects accessor length without invoking the getter", () => {
    let invoked = false;
    const proxy = new Proxy([1, 2], {
      getOwnPropertyDescriptor(t, p) {
        if (p === "length") {
          return {
            get() {
              invoked = true;
              return 2;
            },
            enumerable: false,
            configurable: true,
          };
        }
        return Reflect.getOwnPropertyDescriptor(
          t as object,
          p as string | symbol,
        );
      },
    });
    expect(() => canonicalToolArgumentsJson({ list: proxy })).toThrow(
      TypeError,
    );
    expect(invoked).toBe(false);
  });

  it("rejects invalid length shapes", () => {
    for (const bad of ["2", 1.5, Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      const proxy = new Proxy([1, 2], {
        getOwnPropertyDescriptor(t, p) {
          if (p === "length") {
            return {
              value: bad,
              writable: true,
              enumerable: false,
              configurable: false,
            };
          }
          return Reflect.getOwnPropertyDescriptor(
            t as object,
            p as string | symbol,
          );
        },
      });
      expect(() => canonicalToolArgumentsJson({ list: proxy })).toThrow(
        TypeError,
      );
    }
  });
});

describe("finite item-count bound from the 32KiB budget", () => {
  it("exposes a finite bound at or under the byte budget", () => {
    expect(Number.isSafeInteger(MAX_CANONICAL_ARRAY_ITEMS)).toBe(true);
    expect(MAX_CANONICAL_ARRAY_ITEMS).toBeLessThanOrEqual(
      MAX_TOOL_CALL_ARGUMENTS_BYTES,
    );
  });

  it("rejects huge sparse lengths without a huge allocation or loop", () => {
    const sparse: unknown[] = [];
    sparse.length = MAX_CANONICAL_ARRAY_ITEMS + 1;
    const started = Date.now();
    expect(() => canonicalToolArgumentsJson({ list: sparse })).toThrow(
      TypeError,
    );
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("rejects a huge Proxy length before traversal", () => {
    const huge = new Proxy([], {
      getOwnPropertyDescriptor(t, p) {
        if (p === "length") {
          return {
            value: 1_000_000,
            writable: true,
            enumerable: false,
            configurable: false,
          };
        }
        return Reflect.getOwnPropertyDescriptor(
          t as object,
          p as string | symbol,
        );
      },
    });
    expect(() => canonicalToolArgumentsJson({ list: huge })).toThrow(TypeError);
  });
});

describe("mutation, holes, extras, and symbols", () => {
  it("rejects an index that vanishes mid-traversal", () => {
    const proxy = new Proxy([1, 2], {
      getOwnPropertyDescriptor(t, p) {
        if (p === "1") {
          return undefined;
        }
        return Reflect.getOwnPropertyDescriptor(
          t as object,
          p as string | symbol,
        );
      },
    });
    expect(() => canonicalToolArgumentsJson({ list: proxy })).toThrow(
      TypeError,
    );
  });

  it("rejects index getters without invocation", () => {
    let invoked = false;
    const proxy = new Proxy([1, 2], {
      getOwnPropertyDescriptor(t, p) {
        if (p === "0") {
          return {
            get() {
              invoked = true;
              return 1;
            },
            enumerable: true,
            configurable: true,
          };
        }
        return Reflect.getOwnPropertyDescriptor(
          t as object,
          p as string | symbol,
        );
      },
    });
    expect(() => canonicalToolArgumentsJson({ list: proxy })).toThrow(
      TypeError,
    );
    expect(invoked).toBe(false);
  });

  it("still rejects holes, extra keys, and symbols", () => {
    // biome-ignore lint/suspicious/noSparseArray: the hole is the subject.
    expect(() => canonicalToolArgumentsJson({ list: [1, , 3] })).toThrow(
      TypeError,
    );
    const extra = [1, 2] as unknown as Record<string, unknown>;
    extra.note = SECRET_MARKER;
    expect(() => canonicalToolArgumentsJson({ list: extra })).toThrow(
      TypeError,
    );
    const keyed = { list: [1] as unknown[] };
    (keyed.list as unknown as Record<symbol, number>)[Symbol("s")] = 1;
    expect(() => canonicalToolArgumentsJson(keyed)).toThrow(TypeError);
  });
});

describe("normal arrays and redacted mapping", () => {
  it("leaves valid plain JSON arrays unchanged", () => {
    expect(canonicalToolArgumentsJson({ list: [] })).toBe(`{"list":[]}`);
    expect(canonicalToolArgumentsJson({ list: [1, "a", null, true] })).toBe(
      `{"list":[1,"a",null,true]}`,
    );
    const nested = { list: [[1, 2], { a: [3] }] };
    expect(canonicalToolArgumentsJson(nested)).toBe(
      JSON.stringify({ list: [[1, 2], { a: [3] }] }),
    );
    const many = { list: Array.from({ length: 1000 }, () => 0) };
    expect(canonicalToolArgumentsJson(many)).toBe(
      JSON.stringify({ list: (many.list as number[]).slice() }),
    );
  });

  it("maps hostile arrays to fixed redacted codes without leaking", () => {
    const sparse: unknown[] = [];
    sparse.length = MAX_CANONICAL_ARRAY_ITEMS + 1;
    const args = { pad: SECRET_MARKER, list: sparse };
    try {
      normalizeOpenAIResponse(openaiBody([openaiCall(args)]), TOOLS);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ModelLocalError);
      expect((error as ModelLocalError).code).toBe("tool_call_invalid");
      expect((error as ModelLocalError).message).not.toContain(SECRET_MARKER);
      expect(JSON.stringify(error)).not.toContain(SECRET_MARKER);
    }
  });
});
