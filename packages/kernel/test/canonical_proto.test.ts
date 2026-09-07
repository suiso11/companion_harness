// M2 kernel canonical __proto__ regression: own enumerable __proto__ keys
// must survive canonicalization without prototype pollution, and broker
// input accounting/dedup must distinguish args differing only by __proto__.
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  canonicalJsonString,
  createKernelRepository,
  createToolBroker,
  migrateKernelDatabase,
  openKernelDatabase,
  requestHash,
  type ToolRegistration,
} from "../src/index.js";

const T0 = 1790000000000;
const CTX = { origin: "test-origin", caller: "test-caller" };

function ownProto(value: unknown): Record<string, unknown> {
  return JSON.parse(`{"__proto__":${JSON.stringify(value)},"q":"a"}`) as Record<
    string,
    unknown
  >;
}

describe("canonical __proto__ preservation", () => {
  it("keeps own __proto__ keys with deterministic sorted JSON", () => {
    const input = JSON.parse('{"b":2,"__proto__":{"a":1},"a":0}');
    expect(canonicalJson(input)).toBe('{"__proto__":{"a":1},"a":0,"b":2}');
    // Plain-object sorting behavior unchanged.
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("distinguishes __proto__ payloads in hashes", () => {
    const left = JSON.parse('{"__proto__":{"x":1}}');
    const right = JSON.parse('{"__proto__":{"x":2}}');
    expect(canonicalJson(left)).not.toBe(canonicalJson(right));
    expect(requestHash("op", 1, left)).not.toBe(requestHash("op", 1, right));
    // Missing vs present __proto__ also differ (no key-drop collapse).
    expect(canonicalJson(JSON.parse('{"q":"a"}'))).not.toBe(
      canonicalJson(JSON.parse('{"q":"a","__proto__":1}')),
    );
  });

  it("never pollutes Object.prototype", () => {
    const proto = Object.prototype as Record<string, unknown>;
    const before = proto.polluted;
    canonicalJson(JSON.parse('{"__proto__":{"polluted":true}}'));
    canonicalJsonString(ownProto({ polluted: true }));
    expect(proto.polluted).toBe(before);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("broker __proto__ size/dedup", () => {
  async function setup() {
    const handle = openKernelDatabase(":memory:");
    await migrateKernelDatabase({ db: handle.raw });
    const repo = createKernelRepository(handle.raw);
    const sessionId = repo.createSession({
      key: crypto.randomUUID(),
      now: T0,
    }).body.sessionId;
    const posted = repo.postMessage(
      sessionId,
      { text: "hello" },
      { key: crypto.randomUUID(), now: T0 },
    );
    const runId = posted.body.run.id;
    repo.startRun(runId, { now: T0 + 1 });
    return { handle, repo, runId };
  }

  function protoReg(counter: { calls: number }): ToolRegistration {
    return {
      descriptor: {
        name: "test.read",
        version: 1,
        title: "Test tool",
        description: "M2 proto test tool",
        category: "read",
        defaultTimeoutMs: 5000,
        maxTimeoutMs: 10_000,
        supportsRefresh: true,
      },
      // Identity schema: preserves own __proto__ keys (a strict zod object
      // would strip/reject them before the broker ever hashes input).
      inputSchema: { parse: (data: unknown) => data },
      outputSchema: { parse: (data: unknown) => data },
      handler: (async (input: never) => {
        counter.calls += 1;
        return { echo: input };
      }) as ToolRegistration["handler"],
    };
  }

  it("dedups on the post-validation canonical fingerprint including __proto__", async () => {
    const { handle, repo, runId } = await setup();
    try {
      const counter = { calls: 0 };
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [protoReg(counter)],
      });
      const first = await broker.invoke(
        runId,
        "test.read",
        JSON.parse('{"q":"a","__proto__":{"x":1}}'),
        CTX,
      );
      const same = await broker.invoke(
        runId,
        "test.read",
        JSON.parse('{"__proto__":{"x":1},"q":"a"}'),
        CTX,
      );
      expect(first.result.actualOutcome).toBe("succeeded");
      expect(same.result.actualOutcome).toBe("deduplicated");
      const different = await broker.invoke(
        runId,
        "test.read",
        JSON.parse('{"q":"a","__proto__":{"x":2}}'),
        CTX,
      );
      expect(different.result.actualOutcome).toBe("succeeded");
      expect(counter.calls).toBe(2);
    } finally {
      handle.raw.close();
    }
  });

  it("counts __proto__ bytes in per-call input accounting", async () => {
    const { handle, repo, runId } = await setup();
    try {
      const counter = { calls: 0 };
      const small = JSON.parse('{"q":"a"}');
      const limit = Buffer.byteLength(canonicalJsonString(small), "utf8") + 1;
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [protoReg(counter)],
        budgets: { maxInputBytesPerCall: limit },
      });
      const ok = await broker.invoke(runId, "test.read", small, CTX);
      expect(ok.result.actualOutcome).toBe("succeeded");
      const oversized = await broker.invoke(
        runId,
        "test.read",
        JSON.parse('{"q":"a","__proto__":{"x":1}}'),
        CTX,
      );
      expect(oversized.result.actualOutcome).toBe("invalid");
      expect(oversized.result.errorCode).toBe("invalid_input");
      expect(counter.calls).toBe(1);
    } finally {
      handle.raw.close();
    }
  });
});
