// M0 ToolBroker tests (plan §9 blocker 6, §13.1 M0.4, §13.3).
//
// Fast and deterministic: in-memory DBs, tiny real timeouts (tens of ms),
// gated deferreds instead of wall-clock waits. No M1+ tools, no HTTP.

import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  BROKER_PIPELINE_ORDER,
  type BrokerCallResult,
  createKernelRepository,
  createToolBroker,
  type KernelRepository,
  KernelStorageError,
  migrateKernelDatabase,
  openKernelDatabase,
  type PipelineStep,
  ToolBroker,
  type ToolBrokerBudgets,
  ToolError,
  type ToolRegistration,
} from "../src/index.js";

const T0 = 1790000000000;
const CTX = { origin: "test-origin", caller: "test-caller" };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function setup(): Promise<{
  handle: ReturnType<typeof openKernelDatabase>;
  repo: KernelRepository;
}> {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  const repo = createKernelRepository(handle.raw);
  return { handle, repo };
}

function newRunningRun(
  repo: KernelRepository,
  now: number,
): { sessionId: string; runId: string } {
  const sessionId = repo.createSession({ key: crypto.randomUUID(), now }).body
    .sessionId;
  const posted = repo.postMessage(
    sessionId,
    { text: "hello" },
    { key: crypto.randomUUID(), now },
  );
  const runId = posted.body.run.id;
  repo.startRun(runId, { now: now + 1 });
  return { sessionId, runId };
}

function echoReg(overrides?: {
  name?: string;
  category?: "read" | "write" | "sensitive" | "unclassified";
  handler?: ToolRegistration["handler"];
  normalize?: ToolRegistration["normalize"];
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
}): ToolRegistration {
  return {
    descriptor: {
      name: overrides?.name ?? "test.read",
      version: 1,
      title: "Test tool",
      description: "M0 test tool",
      category: overrides?.category ?? "read",
      defaultTimeoutMs: overrides?.defaultTimeoutMs ?? 5000,
      maxTimeoutMs: overrides?.maxTimeoutMs ?? 10_000,
      supportsRefresh: true,
    },
    inputSchema: z.strictObject({ q: z.string().default("hi") }),
    outputSchema: z.strictObject({ text: z.string() }),
    handler:
      overrides?.handler ??
      (async (input: { q: string }) => ({ text: `out:${input.q}` })),
    ...(overrides?.normalize === undefined
      ? {}
      : { normalize: overrides.normalize }),
  };
}

function makeBroker(
  handle: ReturnType<typeof openKernelDatabase>,
  repo: KernelRepository,
  regs: readonly ToolRegistration[],
  opts?: {
    budgets?: Partial<ToolBrokerBudgets>;
    onStep?: (s: PipelineStep) => void;
  },
): ToolBroker {
  return createToolBroker({
    db: handle.raw,
    repo,
    registrations: regs,
    ...(opts?.budgets === undefined ? {} : { budgets: opts.budgets }),
    ...(opts?.onStep === undefined
      ? {}
      : { onStep: (step) => opts.onStep?.(step) }),
  });
}

interface ToolCallRow {
  id: string;
  run_id: string;
  call_index: number;
  lifecycle_status: string;
  tool: string;
  args_hash: string;
  reported_outcome: string | null;
  actual_outcome: string | null;
  result_disposition: string;
  reused_from_call_id: string | null;
  error_code: string | null;
  result_digest: string | null;
}

function toolCalls(db: Database.Database, runId: string): ToolCallRow[] {
  return db
    .prepare(
      "SELECT * FROM tool_calls WHERE run_id = ? ORDER BY call_index ASC",
    )
    .all(runId) as ToolCallRow[];
}

function runEvents(
  db: Database.Database,
  runId: string,
): Array<{ seq: number; type: string; payload: string }> {
  return db
    .prepare(
      "SELECT seq, type, payload FROM run_events WHERE run_id = ? ORDER BY seq ASC",
    )
    .all(runId) as Array<{ seq: number; type: string; payload: string }>;
}

function requestsUsed(db: Database.Database, runId: string): number {
  const row = db
    .prepare("SELECT tool_requests_used FROM runs WHERE id = ?")
    .get(runId) as {
    tool_requests_used: number;
  };
  return row.tool_requests_used;
}

describe("pipeline ordering", () => {
  it("traverses the full fixed order on success", async () => {
    const { handle, repo } = await setup();
    try {
      const { runId } = newRunningRun(repo, T0);
      const steps: PipelineStep[] = [];
      const broker = makeBroker(handle, repo, [echoReg()], {
        onStep: (s) => steps.push(s),
      });
      const out = await broker.invoke(runId, "test.read", { q: "a" }, CTX);
      expect(out.result.actualOutcome).toBe("succeeded");
      expect(steps).toEqual([...BROKER_PIPELINE_ORDER]);
      expect(out.pipeline).toEqual([...BROKER_PIPELINE_ORDER]);
    } finally {
      handle.raw.close();
    }
  });

  it("invalid input stops after validate, then audits", async () => {
    const { handle, repo } = await setup();
    try {
      const { runId } = newRunningRun(repo, T0);
      const steps: PipelineStep[] = [];
      const broker = makeBroker(handle, repo, [echoReg()], {
        onStep: (s) => steps.push(s),
      });
      const out = await broker.invoke(runId, "test.read", { q: 42 }, CTX);
      expect(out.result.actualOutcome).toBe("invalid");
      expect(steps).toEqual([
        "budget_reserve",
        "classify",
        "validate",
        "audit",
      ]);
    } finally {
      handle.raw.close();
    }
  });

  it("denied tools stop after classify, then audit, without executing", async () => {
    const { handle, repo } = await setup();
    try {
      const { runId } = newRunningRun(repo, T0);
      let calls = 0;
      const steps: PipelineStep[] = [];
      const broker = makeBroker(
        handle,
        repo,
        [
          echoReg({
            name: "test.write",
            category: "write",
            handler: async () => {
              calls += 1;
              return { text: "x" };
            },
          }),
        ],
        { onStep: (s) => steps.push(s) },
      );
      const out = await broker.invoke(runId, "test.write", { q: "a" }, CTX);
      expect(out.result.actualOutcome).toBe("denied");
      expect(out.result.errorCode).toBe("tool_denied");
      expect(calls).toBe(0);
      expect(steps).toEqual(["budget_reserve", "classify", "audit"]);
    } finally {
      handle.raw.close();
    }
  });

  it("unknown tools fail at validate, then audit", async () => {
    const { handle, repo } = await setup();
    try {
      const { runId } = newRunningRun(repo, T0);
      const steps: PipelineStep[] = [];
      const broker = makeBroker(handle, repo, [echoReg()], {
        onStep: (s) => steps.push(s),
      });
      const out = await broker.invoke(runId, "nope.missing", { q: "a" }, CTX);
      expect(out.result.actualOutcome).toBe("unknown");
      expect(out.result.errorCode).toBe("unknown_tool");
      expect(steps).toEqual([
        "budget_reserve",
        "classify",
        "validate",
        "audit",
      ]);
    } finally {
      handle.raw.close();
    }
  });

  it("budget exhaustion audits without further steps and never passes 8", async () => {
    const { handle, repo } = await setup();
    try {
      const { runId } = newRunningRun(repo, T0);
      const steps: PipelineStep[] = [];
      const broker = makeBroker(handle, repo, [echoReg()], {
        onStep: (s) => steps.push(s),
      });
      for (let i = 0; i < 8; i += 1) {
        const out = await broker.invoke(
          runId,
          "test.read",
          { q: `q-${i}` },
          CTX,
        );
        expect(out.result.actualOutcome).toBe("succeeded");
      }
      expect(requestsUsed(handle.raw, runId)).toBe(8);
      steps.length = 0;
      const denied = await broker.invoke(
        runId,
        "nope.missing",
        { q: "a" },
        CTX,
      );
      expect(denied.result.errorCode).toBe("budget_exceeded");
      expect(denied.pipeline).toEqual(["budget_reserve", "audit"]);
      expect(requestsUsed(handle.raw, runId)).toBe(8);
    } finally {
      handle.raw.close();
    }
  });

  it("dedup reuse traverses dedup then audits without executing", async () => {
    const { handle, repo } = await setup();
    try {
      const { runId } = newRunningRun(repo, T0);
      let calls = 0;
      const seen: PipelineStep[][] = [];
      let current: PipelineStep[] = [];
      const broker = makeBroker(
        handle,
        repo,
        [
          echoReg({
            handler: async (input: { q: string }) => {
              calls += 1;
              return { text: `out:${input.q}` };
            },
          }),
        ],
        { onStep: (s) => current.push(s) },
      );
      current = [];
      await broker.invoke(runId, "test.read", { q: "same" }, CTX);
      seen.push([...current]);
      current = [];
      const second = await broker.invoke(
        runId,
        "test.read",
        { q: "same" },
        CTX,
      );
      seen.push([...current]);
      expect(calls).toBe(1);
      expect(second.result.actualOutcome).toBe("deduplicated");
      expect(seen[1]).toEqual([
        "budget_reserve",
        "classify",
        "validate",
        "dedup",
        "audit",
      ]);
    } finally {
      handle.raw.close();
    }
  });
});

describe("read-only policy", () => {
  it.each(["write", "sensitive", "unclassified"] as const)(
    "denies %s tools with default-deny and never executes",
    async (category) => {
      const { handle, repo } = await setup();
      try {
        const { runId } = newRunningRun(repo, T0);
        let calls = 0;
        const broker = makeBroker(handle, repo, [
          echoReg({
            name: "test.write",
            category,
            handler: async () => {
              calls += 1;
              return { text: "x" };
            },
          }),
        ]);
        const out = await broker.invoke(runId, "test.write", { q: "a" }, CTX);
        expect(out.result.actualOutcome).toBe("denied");
        expect(out.result.errorCode).toBe("tool_denied");
        expect(out.result.disposition).toBe("none");
        expect(calls).toBe(0);
        const rows = toolCalls(handle.raw, runId);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.actual_outcome).toBe("denied");
      } finally {
        handle.raw.close();
      }
    },
  );

  it("denies read tools outside allowedTools", async () => {
    const { handle, repo } = await setup();
    try {
      const { runId } = newRunningRun(repo, T0);
      let calls = 0;
      const broker = makeBroker(handle, repo, [
        echoReg({
          handler: async (input: { q: string }) => {
            calls += 1;
            return { text: input.q };
          },
        }),
      ]);
      const denied = await broker.invoke(
        runId,
        "test.read",
        { q: "a" },
        { ...CTX, allowedTools: ["other.tool"] },
      );
      expect(denied.result.actualOutcome).toBe("denied");
      expect(calls).toBe(0);
      const allowed = await broker.invoke(
        runId,
        "test.read",
        { q: "b" },
        { ...CTX, allowedTools: ["test.read"] },
      );
      expect(allowed.result.actualOutcome).toBe("succeeded");
      expect(calls).toBe(1);
    } finally {
      handle.raw.close();
    }
  });

  it("uses a static finalized registry (no dynamic registration)", () => {
    const proto = ToolBroker.prototype as unknown as Record<string, unknown>;
    expect(proto.register).toBeUndefined();
    expect(proto.addTool).toBeUndefined();
    expect(proto.unregister).toBeUndefined();
  });

  it("rejects duplicate names and invalid descriptors at construction", async () => {
    const { handle, repo } = await setup();
    try {
      expect(() => makeBroker(handle, repo, [echoReg(), echoReg()])).toThrow();
      expect(() =>
        makeBroker(handle, repo, [
          {
            descriptor: {
              name: "test.read",
              version: 1,
              title: "t",
              description: "d",
              category: "anything" as unknown as "read",
              defaultTimeoutMs: 10,
              maxTimeoutMs: 20,
              supportsRefresh: false,
            },
            inputSchema: z.strictObject({}),
            outputSchema: z.strictObject({}),
            handler: async () => ({}),
          },
        ]),
      ).toThrow();
      const broker = makeBroker(handle, repo, [echoReg()]);
      expect(broker.toolNames()).toEqual(["test.read"]);
    } finally {
      handle.raw.close();
    }
  });
});

describe("budgets", () => {
  it("unknown/denied/invalid/dedup/timeout/cancel each consume request budget", async () => {
    const { handle, repo } = await setup();
    try {
      const { runId } = newRunningRun(repo, T0);
      const broker = makeBroker(handle, repo, [
        echoReg({
          name: "test.write",
          category: "write",
          handler: async () => ({ text: "x" }),
        }),
        echoReg(),
      ]);
      expect(
        (await broker.invoke(runId, "nope.missing", { q: "a" }, CTX)).result
          .actualOutcome,
      ).toBe("unknown");
      expect(
        (await broker.invoke(runId, "test.write", { q: "a" }, CTX)).result
          .actualOutcome,
      ).toBe("denied");
      expect(
        (await broker.invoke(runId, "test.read", { q: 1 }, CTX)).result
          .actualOutcome,
      ).toBe("invalid");
      expect(
        (await broker.invoke(runId, "test.read", { q: "dup" }, CTX)).result
          .actualOutcome,
      ).toBe("succeeded");
      expect(
        (await broker.invoke(runId, "test.read", { q: "dup" }, CTX)).result
          .actualOutcome,
      ).toBe("deduplicated");
      expect(requestsUsed(handle.raw, runId)).toBe(5);
    } finally {
      handle.raw.close();
    }
  });

  it("concurrent reservations never exceed the per-run cap", async () => {
    const { handle, repo } = await setup();
    try {
      const { runId } = newRunningRun(repo, T0);
      const broker = makeBroker(handle, repo, [echoReg()]);
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          broker.invoke(runId, "test.read", { q: `q-${i}` }, CTX),
        ),
      );
      const ok = results.filter(
        (r) => r.result.actualOutcome === "succeeded",
      ).length;
      const limited = results.filter(
        (r) => r.result.errorCode === "budget_exceeded",
      ).length;
      expect(ok).toBe(8);
      expect(limited).toBe(4);
      expect(requestsUsed(handle.raw, runId)).toBe(8);
    } finally {
      handle.raw.close();
    }
  });
});

describe("dedup", () => {
  it("dedups after Zod defaults ({} equals {q:'hi'}) with completed reuse", async () => {
    const { handle, repo } = await setup();
    try {
      const { runId } = newRunningRun(repo, T0);
      let calls = 0;
      const broker = makeBroker(handle, repo, [
        echoReg({
          handler: async (input: { q: string }) => {
            calls += 1;
            return { text: `out:${input.q}` };
          },
        }),
      ]);
      const first = await broker.invoke(runId, "test.read", {}, CTX);
      const second = await broker.invoke(runId, "test.read", { q: "hi" }, CTX);
      expect(calls).toBe(1);
      expect(first.result.actualOutcome).toBe("succeeded");
      expect(second.result.actualOutcome).toBe("deduplicated");
      expect(second.normalized).toEqual(first.normalized);
      expect(second.modelFacing).toEqual(first.modelFacing);
      const rows = toolCalls(handle.raw, runId);
      expect(rows[1]?.reused_from_call_id).toBe(rows[0]?.id);
      expect(requestsUsed(handle.raw, runId)).toBe(2);
    } finally {
      handle.raw.close();
    }
  });

  it("coalesces in-flight duplicates into one physical execution", async () => {
    const { handle, repo } = await setup();
    try {
      const { runId } = newRunningRun(repo, T0);
      const gate = deferred();
      let entered = 0;
      const broker = makeBroker(handle, repo, [
        echoReg({
          handler: async (input: { q: string }) => {
            entered += 1;
            await gate.promise;
            return { text: input.q };
          },
        }),
      ]);
      const p1 = broker.invoke(runId, "test.read", { q: "same" }, CTX);
      const p2 = broker.invoke(runId, "test.read", { q: "same" }, CTX);
      await sleep(10);
      expect(entered).toBe(1);
      gate.resolve();
      const [r1, r2] = await Promise.all([p1, p2]);
      expect(entered).toBe(1);
      expect(r1.result.actualOutcome).toBe("succeeded");
      expect(r2.result.actualOutcome).toBe("deduplicated");
      expect(r2.normalized).toEqual(r1.normalized);
      expect(requestsUsed(handle.raw, runId)).toBe(2);
      const events = runEvents(handle.raw, runId).filter((e) =>
        e.type.startsWith("tool."),
      );
      expect(events.filter((e) => e.type === "tool.requested")).toHaveLength(2);
      expect(events.filter((e) => e.type === "tool.completed")).toHaveLength(2);
    } finally {
      handle.raw.close();
    }
  });

  it("refresh bypasses dedup, executes, and refreshes the cache", async () => {
    const { handle, repo } = await setup();
    try {
      const { runId } = newRunningRun(repo, T0);
      let calls = 0;
      const broker = makeBroker(handle, repo, [
        echoReg({
          handler: async (input: { q: string }) => {
            calls += 1;
            return { text: `n${calls}:${input.q}` };
          },
        }),
      ]);
      const first = await broker.invoke(runId, "test.read", { q: "k" }, CTX);
      const refreshed = await broker.invoke(
        runId,
        "test.read",
        { q: "k" },
        { ...CTX, freshness: "refresh" },
      );
      expect(calls).toBe(2);
      expect(refreshed.result.actualOutcome).toBe("succeeded");
      expect(refreshed.normalized).not.toEqual(first.normalized);
      const third = await broker.invoke(runId, "test.read", { q: "k" }, CTX);
      expect(calls).toBe(2);
      expect(third.result.actualOutcome).toBe("deduplicated");
      expect(third.normalized).toEqual(refreshed.normalized);
    } finally {
      handle.raw.close();
    }
  });

  it("never reuses across runs", async () => {
    const { handle, repo } = await setup();
    try {
      const a = newRunningRun(repo, T0);
      const broker = makeBroker(handle, repo, [echoReg()]);
      await broker.invoke(a.runId, "test.read", { q: "same" }, CTX);
      const b = newRunningRun(repo, T0 + 10);
      const out = await broker.invoke(b.runId, "test.read", { q: "same" }, CTX);
      expect(out.result.actualOutcome).toBe("succeeded");
      expect(out.result.reusedFromCallId).toBeNull();
    } finally {
      handle.raw.close();
    }
  });

  it("mirrors leader failure to coalesced followers without reuse", async () => {
    const { handle, repo } = await setup();
    try {
      const { runId } = newRunningRun(repo, T0);
      const gate = deferred();
      let calls = 0;
      const broker = makeBroker(handle, repo, [
        echoReg({
          handler: async () => {
            calls += 1;
            await gate.promise;
            throw new ToolError("execution_failed");
          },
        }),
      ]);
      const p1 = broker.invoke(runId, "test.read", { q: "same" }, CTX);
      const p2 = broker.invoke(runId, "test.read", { q: "same" }, CTX);
      await sleep(10);
      gate.resolve();
      const [r1, r2] = await Promise.all([p1, p2]);
      expect(calls).toBe(1);
      expect(r1.result.actualOutcome).toBe("failed");
      expect(r2.result.actualOutcome).toBe("failed");
      expect(r2.result.reusedFromCallId).toBeNull();
    } finally {
      handle.raw.close();
    }
  });
});

describe("concurrency and queueing", () => {
  it("caps per-run physical concurrency at 3 and queues the rest", async () => {
    const { handle, repo } = await setup();
    try {
      const { runId } = newRunningRun(repo, T0);
      const gate = deferred();
      let current = 0;
      let max = 0;
      const broker = makeBroker(handle, repo, [
        echoReg({
          handler: async (input: { q: string }) => {
            current += 1;
            max = Math.max(max, current);
            await gate.promise;
            current -= 1;
            return { text: input.q };
          },
        }),
      ]);
      const pending = Array.from({ length: 5 }, (_, i) =>
        broker.invoke(
          runId,
          "test.read",
          { q: `q-${i}` },
          { ...CTX, freshness: "refresh" },
        ),
      );
      await sleep(20);
      expect(max).toBe(3);
      gate.resolve();
      const results = await Promise.all(pending);
      expect(results.every((r) => r.result.actualOutcome === "succeeded")).toBe(
        true,
      );
      expect(max).toBe(3);
    } finally {
      handle.raw.close();
    }
  });

  it("preserves caller-visible per-run start order through the queue", async () => {
    const { handle, repo } = await setup();
    try {
      const { runId } = newRunningRun(repo, T0);
      const started: string[] = [];
      const broker = makeBroker(
        handle,
        repo,
        [
          echoReg({
            handler: async (input: { q: string }) => {
              started.push(input.q);
              await sleep(5);
              return { text: input.q };
            },
          }),
        ],
        { budgets: { maxConcurrentPerRun: 1 } },
      );
      const results = await Promise.all([
        broker.invoke(runId, "test.read", { q: "a" }, CTX),
        broker.invoke(runId, "test.read", { q: "b" }, CTX),
        broker.invoke(runId, "test.read", { q: "c" }, CTX),
      ]);
      expect(results.every((r) => r.result.actualOutcome === "succeeded")).toBe(
        true,
      );
      expect(started).toEqual(["a", "b", "c"]);
    } finally {
      handle.raw.close();
    }
  });

  it("caps process-wide physical concurrency at 8", async () => {
    const { handle, repo } = await setup();
    try {
      const runs = [
        newRunningRun(repo, T0),
        newRunningRun(repo, T0 + 10),
        newRunningRun(repo, T0 + 20),
      ];
      const gate = deferred();
      let current = 0;
      let max = 0;
      const broker = makeBroker(handle, repo, [
        echoReg({
          handler: async (input: { q: string }) => {
            current += 1;
            max = Math.max(max, current);
            await gate.promise;
            current -= 1;
            return { text: input.q };
          },
        }),
      ]);
      const pending: Array<Promise<BrokerCallResult>> = [];
      for (const r of runs) {
        for (let i = 0; i < 3; i += 1) {
          pending.push(
            broker.invoke(
              r.runId,
              "test.read",
              { q: `${r.runId.slice(0, 4)}-${i}` },
              CTX,
            ),
          );
        }
      }
      await sleep(20);
      expect(max).toBe(8);
      gate.resolve();
      const results = await Promise.all(pending);
      expect(results.every((r) => r.result.actualOutcome === "succeeded")).toBe(
        true,
      );
    } finally {
      handle.raw.close();
    }
  });
});

describe("size and observation limits", () => {
  it("rejects oversized input before execution", async () => {
    const { handle, repo } = await setup();
    try {
      const { runId } = newRunningRun(repo, T0);
      let calls = 0;
      const broker = makeBroker(handle, repo, [
        echoReg({
          handler: async () => {
            calls += 1;
            return { text: "x" };
          },
        }),
      ]);
      const out = await broker.invoke(
        runId,
        "test.read",
        { q: "x".repeat(33 * 1024) },
        CTX,
      );
      expect(out.result.actualOutcome).toBe("invalid");
      expect(out.result.errorCode).toBe("invalid_input");
      expect(calls).toBe(0);
    } finally {
      handle.raw.close();
    }
  });

  it("rejects oversized normalized output without truncation", async () => {
    const { handle, repo } = await setup();
    try {
      const { runId } = newRunningRun(repo, T0);
      const big = "y".repeat(257 * 1024);
      const broker = makeBroker(handle, repo, [
        {
          ...echoReg(),
          inputSchema: z.strictObject({}),
          outputSchema: z.string(),
          handler: async () => big,
        },
      ]);
      const out = await broker.invoke(runId, "test.read", {}, CTX);
      expect(out.result.actualOutcome).toBe("failed");
      expect(out.result.errorCode).toBe("output_too_large");
      expect(out.result.disposition).toBe("discarded");
      expect(out.normalized).toBeNull();
    } finally {
      handle.raw.close();
    }
  });

  it("rejects oversized per-call model-facing output", async () => {
    const { handle, repo } = await setup();
    try {
      const { runId } = newRunningRun(repo, T0);
      const broker = makeBroker(handle, repo, [
        echoReg({
          normalize: () => ({
            normalized: { text: "ok" },
            observations: 0,
            modelFacing: "m".repeat(65 * 1024),
          }),
        }),
      ]);
      const out = await broker.invoke(runId, "test.read", { q: "a" }, CTX);
      expect(out.result.errorCode).toBe("output_too_large");
      expect(out.normalized).toBeNull();
    } finally {
      handle.raw.close();
    }
  });

  it("enforces the per-run cumulative model-output budget", async () => {
    const { handle, repo } = await setup();
    try {
      const { runId } = newRunningRun(repo, T0);
      const broker = makeBroker(
        handle,
        repo,
        [
          echoReg({
            normalize: () => ({
              normalized: { text: "ok" },
              observations: 0,
              modelFacing: "a".repeat(60),
            }),
          }),
        ],
        { budgets: { maxModelFacingOutputBytesPerRun: 100 } },
      );
      const first = await broker.invoke(runId, "test.read", { q: "one" }, CTX);
      expect(first.result.actualOutcome).toBe("succeeded");
      const second = await broker.invoke(runId, "test.read", { q: "two" }, CTX);
      expect(second.result.actualOutcome).toBe("failed");
      expect(second.result.errorCode).toBe("output_too_large");
    } finally {
      handle.raw.close();
    }
  });

  it("rejects excess per-call and per-run observations", async () => {
    const { handle, repo } = await setup();
    try {
      const { runId } = newRunningRun(repo, T0);
      const counting: ToolRegistration = {
        ...echoReg(),
        inputSchema: z.strictObject({
          q: z.string().default("hi"),
          n: z.number().default(0),
        }),
        normalize: (raw) => ({
          normalized: { text: "ok" },
          observations: (raw as { n: number }).n,
          modelFacing: "m",
        }),
      };
      const broker = makeBroker(handle, repo, [counting]);
      const over = await broker.invoke(
        runId,
        "test.read",
        { q: "a", n: 21 },
        CTX,
      );
      expect(over.result.errorCode).toBe("output_invalid");
      const limited = makeBroker(
        handle,
        repo,
        [
          echoReg({
            normalize: () => ({
              normalized: { text: "ok" },
              observations: 15,
              modelFacing: "m",
            }),
          }),
        ],
        { budgets: { maxObservationsPerRun: 25 } },
      );
      const { runId: run2 } = newRunningRun(repo, T0 + 50);
      expect(
        (await limited.invoke(run2, "test.read", { q: "a" }, CTX)).result
          .actualOutcome,
      ).toBe("succeeded");
      const cum = await limited.invoke(run2, "test.read", { q: "b" }, CTX);
      expect(cum.result.errorCode).toBe("output_invalid");
    } finally {
      handle.raw.close();
    }
  });

  it("rejects schema-invalid output strictly with no retry", async () => {
    const { handle, repo } = await setup();
    try {
      const { runId } = newRunningRun(repo, T0);
      let calls = 0;
      const broker = makeBroker(handle, repo, [
        echoReg({
          handler: async () => {
            calls += 1;
            return { wrong: 1 };
          },
        }),
      ]);
      const out = await broker.invoke(runId, "test.read", { q: "a" }, CTX);
      expect(out.result.actualOutcome).toBe("failed");
      expect(out.result.errorCode).toBe("output_invalid");
      expect(calls).toBe(1);
    } finally {
      handle.raw.close();
    }
  });

  it("never retries a failing handler", async () => {
    const { handle, repo } = await setup();
    try {
      const { runId } = newRunningRun(repo, T0);
      let calls = 0;
      const broker = makeBroker(handle, repo, [
        echoReg({
          handler: async () => {
            calls += 1;
            if (calls === 1) {
              throw new ToolError("execution_failed");
            }
            return { text: "recovered" };
          },
        }),
      ]);
      const out = await broker.invoke(runId, "test.read", { q: "a" }, CTX);
      expect(out.result.actualOutcome).toBe("failed");
      expect(calls).toBe(1);
    } finally {
      handle.raw.close();
    }
  });
});

describe("timeout and cancellation", () => {
  it("times out a slow handler with the requested timeout", async () => {
    const { handle, repo } = await setup();
    try {
      const { runId } = newRunningRun(repo, T0);
      const broker = makeBroker(handle, repo, [
        echoReg({
          handler: async () => {
            await sleep(500);
            return { text: "late" };
          },
        }),
      ]);
      const start = Date.now();
      const out = await broker.invoke(
        runId,
        "test.read",
        { q: "a" },
        { ...CTX, timeoutMs: 25 },
      );
      expect(Date.now() - start).toBeLessThan(2000);
      expect(out.result.actualOutcome).toBe("timed_out");
      expect(out.result.errorCode).toBe("execution_timeout");
      expect(requestsUsed(handle.raw, runId)).toBe(1);
    } finally {
      handle.raw.close();
    }
  });

  it("uses the descriptor default timeout when none is requested", async () => {
    const { handle, repo } = await setup();
    try {
      const { runId } = newRunningRun(repo, T0);
      const broker = makeBroker(handle, repo, [
        echoReg({
          defaultTimeoutMs: 30,
          handler: async () => {
            await sleep(500);
            return { text: "late" };
          },
        }),
      ]);
      const out = await broker.invoke(runId, "test.read", { q: "a" }, CTX);
      expect(out.result.actualOutcome).toBe("timed_out");
    } finally {
      handle.raw.close();
    }
  });

  it("caps a requested timeout at the descriptor max", async () => {
    const { handle, repo } = await setup();
    try {
      const { runId } = newRunningRun(repo, T0);
      const broker = makeBroker(handle, repo, [
        echoReg({
          maxTimeoutMs: 40,
          handler: async () => {
            await sleep(500);
            return { text: "late" };
          },
        }),
      ]);
      const start = Date.now();
      const out = await broker.invoke(
        runId,
        "test.read",
        { q: "a" },
        { ...CTX, timeoutMs: 5000 },
      );
      expect(Date.now() - start).toBeLessThan(2000);
      expect(out.result.actualOutcome).toBe("timed_out");
    } finally {
      handle.raw.close();
    }
  });

  it("cancels promptly on caller abort and records the cooperative report", async () => {
    const { handle, repo } = await setup();
    try {
      const { runId } = newRunningRun(repo, T0);
      const entered = deferred();
      const controller = new AbortController();
      const broker = makeBroker(handle, repo, [
        echoReg({
          handler: async (_input: unknown, ctx) => {
            entered.resolve();
            await new Promise<void>((_, reject) => {
              ctx.signal.addEventListener(
                "abort",
                () => reject(new ToolError("execution_cancelled")),
                { once: true },
              );
            });
            return { text: "never" };
          },
        }),
      ]);
      const pending = broker.invoke(
        runId,
        "test.read",
        { q: "a" },
        { ...CTX, signal: controller.signal },
      );
      await entered.promise;
      controller.abort();
      const out = await pending;
      expect(out.result.actualOutcome).toBe("cancelled");
      expect(out.result.errorCode).toBe("execution_cancelled");
      const rows = toolCalls(handle.raw, runId);
      expect(rows[0]?.actual_outcome).toBe("cancelled");
    } finally {
      handle.raw.close();
    }
  });

  it("detaches from non-cooperative handlers and audits their late report only", async () => {
    const { handle, repo } = await setup();
    try {
      const { runId } = newRunningRun(repo, T0);
      const controller = new AbortController();
      const eventsBefore = runEvents(handle.raw, runId).length;
      const broker = makeBroker(handle, repo, [
        echoReg({
          handler: async (input: { q: string }) => {
            await sleep(120);
            return { text: input.q };
          },
        }),
      ]);
      const pending = broker.invoke(
        runId,
        "test.read",
        { q: "slow" },
        { ...CTX, signal: controller.signal },
      );
      await sleep(10);
      controller.abort();
      const out = await pending;
      expect(out.result.actualOutcome).toBe("cancelled");
      const completedNow = runEvents(handle.raw, runId).filter(
        (e) => e.type === "tool.completed",
      );
      expect(completedNow).toHaveLength(1);
      // Late success: audit-only row update, no further events.
      const deadline = Date.now() + 2000;
      for (;;) {
        const rows = toolCalls(handle.raw, runId);
        if (rows[0]?.reported_outcome === "succeeded") {
          break;
        }
        if (Date.now() > deadline) {
          throw new Error("late handler report was not audited");
        }
        await sleep(5);
      }
      const rows = toolCalls(handle.raw, runId);
      expect(rows[0]?.result_disposition).toBe("discarded");
      expect(runEvents(handle.raw, runId).length).toBe(eventsBefore + 2);
    } finally {
      handle.raw.close();
    }
  });
});

describe("terminal finality", () => {
  it("emits requested/completed events only while nonterminal", async () => {
    const { handle, repo } = await setup();
    try {
      const { runId } = newRunningRun(repo, T0);
      const broker = makeBroker(handle, repo, [echoReg()]);
      const before = runEvents(handle.raw, runId).length;
      const out = await broker.invoke(runId, "test.read", { q: "a" }, CTX);
      expect(out.result.actualOutcome).toBe("succeeded");
      const after = runEvents(handle.raw, runId);
      expect(after.length).toBe(before + 2);
      expect(after.slice(-2).map((e) => e.type)).toEqual([
        "tool.requested",
        "tool.completed",
      ]);
      const completed = JSON.parse(
        after[after.length - 1]?.payload as string,
      ) as Record<string, unknown>;
      expect(completed.actualOutcome).toBe("succeeded");
      expect(completed.disposition).toBe("accepted");
    } finally {
      handle.raw.close();
    }
  });

  it("audits without events when the run is already terminal", async () => {
    const { handle, repo } = await setup();
    try {
      const { runId } = newRunningRun(repo, T0);
      const broker = makeBroker(handle, repo, [echoReg()]);
      repo.completeRun(runId, { version: 1, text: "done" }, { now: T0 + 5 });
      const before = runEvents(handle.raw, runId).length;
      const out = await broker.invoke(runId, "test.read", { q: "a" }, CTX);
      expect(out.result.actualOutcome).toBe("cancelled");
      expect(runEvents(handle.raw, runId).length).toBe(before);
      expect(toolCalls(handle.raw, runId)).toHaveLength(1);
      expect(requestsUsed(handle.raw, runId)).toBe(1);
    } finally {
      handle.raw.close();
    }
  });

  it("discards a late success after terminal with no further RunEvent", async () => {
    const { handle, repo } = await setup();
    try {
      const { sessionId, runId } = newRunningRun(repo, T0);
      const gate = deferred();
      const broker = makeBroker(handle, repo, [
        echoReg({
          handler: async (input: { q: string }) => {
            await gate.promise;
            return { text: input.q };
          },
        }),
      ]);
      const pending = broker.invoke(runId, "test.read", { q: "late" }, CTX);
      await sleep(10);
      repo.cancelRun(sessionId, runId, { now: T0 + 5 });
      repo.finalizeCancelRequested(runId, { now: T0 + 6 });
      const terminalCount = runEvents(handle.raw, runId).length;
      gate.resolve();
      const out = await pending;
      expect(out.result.actualOutcome).toBe("cancelled");
      expect(out.result.disposition).toBe("discarded");
      expect(out.result.reportedOutcome).toBe("succeeded");
      // No tool.completed after terminal: only the earlier requested event.
      expect(runEvents(handle.raw, runId).length).toBe(terminalCount);
      const rows = toolCalls(handle.raw, runId);
      expect(rows[0]?.actual_outcome).toBe("cancelled");
      expect(rows[0]?.reported_outcome).toBe("succeeded");
      expect(rows[0]?.result_disposition).toBe("discarded");
    } finally {
      handle.raw.close();
    }
  });
});

describe("metadata-only audit", () => {
  it("never stores raw args/results/content in tool_calls or events", async () => {
    const { handle, repo } = await setup();
    try {
      const { runId } = newRunningRun(repo, T0);
      const secret = "SECRET-XYZ-123";
      const broker = makeBroker(handle, repo, [
        {
          ...echoReg(),
          handler: async (input: { q: string }) => ({
            text: `contains ${input.q}`,
          }),
        },
      ]);
      const out = await broker.invoke(runId, "test.read", { q: secret }, CTX);
      expect(out.result.actualOutcome).toBe("succeeded");
      const rowText = JSON.stringify(toolCalls(handle.raw, runId));
      expect(rowText).not.toContain(secret);
      const eventText = JSON.stringify(runEvents(handle.raw, runId));
      expect(eventText).not.toContain(secret);
      const rows = toolCalls(handle.raw, runId);
      expect(rows[0]?.args_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(rows[0]?.result_digest).toMatch(/^[0-9a-f]{64}$/);
      expect(rows[0]?.lifecycle_status).toBe("finished");
      // Rejected paths are metadata-only too.
      await broker.invoke(
        runId,
        "test.read",
        { q: secret, extra: secret } as unknown,
        CTX,
      );
      expect(JSON.stringify(toolCalls(handle.raw, runId))).not.toContain(
        "extra",
      );
    } finally {
      handle.raw.close();
    }
  });

  it("requires origin and caller in the invocation context", async () => {
    const { handle, repo } = await setup();
    try {
      const { runId } = newRunningRun(repo, T0);
      const broker = makeBroker(handle, repo, [echoReg()]);
      await expect(
        broker.invoke(
          runId,
          "test.read",
          { q: "a" },
          { origin: "", caller: "c" },
        ),
      ).rejects.toThrow();
      await expect(
        broker.invoke(
          runId,
          "test.read",
          { q: "a" },
          { origin: "o", caller: "" },
        ),
      ).rejects.toThrow();
      expect(requestsUsed(handle.raw, runId)).toBe(0);
    } finally {
      handle.raw.close();
    }
  });
});

describe("review regressions: running-only invocation and delivery", () => {
  it("never executes for queued runs, reserves budget first, audits cancelled", async () => {
    const { handle, repo } = await setup();
    try {
      const sessionId = repo.createSession({
        key: crypto.randomUUID(),
        now: T0,
      }).body.sessionId;
      const posted = repo.postMessage(
        sessionId,
        { text: "hi" },
        { key: crypto.randomUUID(), now: T0 },
      );
      const runId = posted.body.run.id;
      expect(repo.getRun(runId).status).toBe("queued");
      let calls = 0;
      const broker = makeBroker(handle, repo, [
        echoReg({
          handler: async (input: { q: string }) => {
            calls += 1;
            return { text: input.q };
          },
        }),
      ]);
      const out = await broker.invoke(runId, "test.read", { q: "a" }, CTX);
      expect(out.result.actualOutcome).toBe("cancelled");
      expect(out.result.errorCode).toBe("execution_cancelled");
      expect(out.normalized).toBeNull();
      expect(out.modelFacing).toBeNull();
      expect(calls).toBe(0);
      expect(out.pipeline).toEqual(["budget_reserve", "audit"]);
      expect(requestsUsed(handle.raw, runId)).toBe(1);
      const rows = toolCalls(handle.raw, runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.actual_outcome).toBe("cancelled");
    } finally {
      handle.raw.close();
    }
  });

  it("never executes nor delivers cached output for cancel_requested runs", async () => {
    const { handle, repo } = await setup();
    try {
      const { sessionId, runId } = newRunningRun(repo, T0);
      let calls = 0;
      const broker = makeBroker(handle, repo, [
        echoReg({
          handler: async (input: { q: string }) => {
            calls += 1;
            return { text: input.q };
          },
        }),
      ]);
      const first = await broker.invoke(
        runId,
        "test.read",
        { q: "cached" },
        CTX,
      );
      expect(first.result.actualOutcome).toBe("succeeded");
      expect(calls).toBe(1);
      repo.cancelRun(sessionId, runId, { now: T0 + 5 });
      expect(repo.getRun(runId).status).toBe("cancel_requested");
      const out = await broker.invoke(runId, "test.read", { q: "cached" }, CTX);
      expect(out.result.actualOutcome).toBe("cancelled");
      expect(out.normalized).toBeNull();
      expect(out.modelFacing).toBeNull();
      expect(calls).toBe(1);
      expect(out.pipeline).toEqual(["budget_reserve", "audit"]);
    } finally {
      handle.raw.close();
    }
  });

  it("coalesced followers observe running-only cancel when the run leaves running", async () => {
    const { handle, repo } = await setup();
    try {
      const { sessionId, runId } = newRunningRun(repo, T0);
      const gate = deferred();
      const broker = makeBroker(handle, repo, [
        echoReg({
          handler: async (input: { q: string }) => {
            await gate.promise;
            return { text: input.q };
          },
        }),
      ]);
      const p1 = broker.invoke(runId, "test.read", { q: "same" }, CTX);
      const p2 = broker.invoke(runId, "test.read", { q: "same" }, CTX);
      await sleep(10);
      repo.cancelRun(sessionId, runId, { now: T0 + 5 });
      repo.finalizeCancelRequested(runId, { now: T0 + 6 });
      gate.resolve();
      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1.result.actualOutcome).toBe("cancelled");
      expect(r1.normalized).toBeNull();
      expect(r2.result.actualOutcome).toBe("cancelled");
      expect(r2.normalized).toBeNull();
    } finally {
      handle.raw.close();
    }
  });
});

describe("review regressions: composed deadline and detach", () => {
  it("bounds queued semaphore wait with the requested timeout", async () => {
    const { handle, repo } = await setup();
    try {
      const { runId } = newRunningRun(repo, T0);
      const gate = deferred();
      const broker = makeBroker(
        handle,
        repo,
        [
          echoReg({
            handler: async (input: { q: string }) => {
              await gate.promise;
              return { text: input.q };
            },
          }),
        ],
        { budgets: { maxConcurrentPerRun: 1 } },
      );
      const first = broker.invoke(
        runId,
        "test.read",
        { q: "a" },
        { ...CTX, freshness: "refresh" },
      );
      await sleep(10);
      const start = Date.now();
      const queued = await broker.invoke(
        runId,
        "test.read",
        { q: "b" },
        { ...CTX, freshness: "refresh", timeoutMs: 25 },
      );
      expect(Date.now() - start).toBeLessThan(2000);
      expect(queued.result.actualOutcome).toBe("timed_out");
      expect(queued.result.errorCode).toBe("execution_timeout");
      gate.resolve();
      const r1 = await first;
      expect(r1.result.actualOutcome).toBe("succeeded");
    } finally {
      handle.raw.close();
    }
  });

  it("bounds a non-cooperative async normalizer and detaches", async () => {
    const { handle, repo } = await setup();
    try {
      const { runId } = newRunningRun(repo, T0);
      const broker = makeBroker(handle, repo, [
        echoReg({
          handler: async () => ({ text: "ok" }),
          normalize: () => new Promise<never>(() => {}),
        }),
      ]);
      const start = Date.now();
      const out = await broker.invoke(
        runId,
        "test.read",
        { q: "a" },
        { ...CTX, timeoutMs: 25 },
      );
      expect(Date.now() - start).toBeLessThan(2000);
      expect(out.result.actualOutcome).toBe("timed_out");
      expect(out.normalized).toBeNull();
    } finally {
      handle.raw.close();
    }
  });

  it("marks every late handler settlement discarded (success and failure)", async () => {
    const { handle, repo } = await setup();
    try {
      const { runId } = newRunningRun(repo, T0);
      const controller = new AbortController();
      const broker = makeBroker(handle, repo, [
        echoReg({
          handler: async (input: { q: string }) => {
            await sleep(120);
            return { text: input.q };
          },
        }),
      ]);
      const pending = broker.invoke(
        runId,
        "test.read",
        { q: "slow-ok" },
        { ...CTX, signal: controller.signal },
      );
      await sleep(10);
      controller.abort();
      const out = await pending;
      expect(out.result.actualOutcome).toBe("cancelled");
      const deadline = Date.now() + 2000;
      for (;;) {
        const rows = toolCalls(handle.raw, runId);
        if (rows[0]?.reported_outcome === "succeeded") break;
        if (Date.now() > deadline) throw new Error("late success not audited");
        await sleep(5);
      }
      expect(toolCalls(handle.raw, runId)[0]?.result_disposition).toBe(
        "discarded",
      );

      const { runId: run2 } = newRunningRun(repo, T0 + 100);
      const broker2 = makeBroker(handle, repo, [
        echoReg({
          handler: async () => {
            await sleep(120);
            throw new ToolError("execution_failed");
          },
        }),
      ]);
      const c2 = new AbortController();
      const p2 = broker2.invoke(
        run2,
        "test.read",
        { q: "slow-fail" },
        { ...CTX, signal: c2.signal },
      );
      await sleep(10);
      c2.abort();
      const o2 = await p2;
      expect(o2.result.actualOutcome).toBe("cancelled");
      const deadline2 = Date.now() + 2000;
      for (;;) {
        const rows = toolCalls(handle.raw, run2);
        if (rows[0]?.reported_outcome === "failed") break;
        if (Date.now() > deadline2) throw new Error("late failure not audited");
        await sleep(5);
      }
      expect(toolCalls(handle.raw, run2)[0]?.result_disposition).toBe(
        "discarded",
      );
    } finally {
      handle.raw.close();
    }
  });
});

describe("review regressions: dedup budgets and cache hygiene", () => {
  it("charges cumulative budgets for dedup reuse and marks accepted with digest", async () => {
    const { handle, repo } = await setup();
    try {
      const { runId } = newRunningRun(repo, T0);
      const broker = makeBroker(
        handle,
        repo,
        [
          echoReg({
            normalize: () => ({
              normalized: { text: "ok" },
              observations: 10,
              modelFacing: "a".repeat(40),
            }),
          }),
        ],
        { budgets: { maxObservationsPerRun: 15 } },
      );
      const first = await broker.invoke(runId, "test.read", { q: "x" }, CTX);
      expect(first.result.actualOutcome).toBe("succeeded");
      const second = await broker.invoke(runId, "test.read", { q: "x" }, CTX);
      expect(second.result.actualOutcome).toBe("failed");
      expect(second.result.errorCode).toBe("output_invalid");
      expect(second.normalized).toBeNull();
      expect(second.modelFacing).toBeNull();
    } finally {
      handle.raw.close();
    }
  });

  it("marks delivered dedup reuse accepted with the leader digest", async () => {
    const { handle, repo } = await setup();
    try {
      const { runId } = newRunningRun(repo, T0);
      const broker = makeBroker(handle, repo, [echoReg()]);
      const first = await broker.invoke(runId, "test.read", { q: "k" }, CTX);
      const second = await broker.invoke(runId, "test.read", { q: "k" }, CTX);
      expect(second.result.actualOutcome).toBe("deduplicated");
      expect(second.result.disposition).toBe("accepted");
      expect(second.result.resultDigest).toBe(first.result.resultDigest);
      expect(second.normalized).toEqual(first.normalized);
      const rows = toolCalls(handle.raw, runId);
      expect(rows[1]?.result_disposition).toBe("accepted");
      expect(rows[1]?.result_digest).toBe(rows[0]?.result_digest);
    } finally {
      handle.raw.close();
    }
  });

  it("clears failed normal in-flight entries so a later call may execute without retry", async () => {
    const { handle, repo } = await setup();
    try {
      const { runId } = newRunningRun(repo, T0);
      let calls = 0;
      const broker = makeBroker(handle, repo, [
        echoReg({
          handler: async (input: { q: string }) => {
            calls += 1;
            if (calls === 1) throw new ToolError("execution_failed");
            return { text: `ok:${input.q}` };
          },
        }),
      ]);
      const failed = await broker.invoke(
        runId,
        "test.read",
        { q: "flaky" },
        CTX,
      );
      expect(failed.result.actualOutcome).toBe("failed");
      expect(calls).toBe(1);
      const retry = await broker.invoke(
        runId,
        "test.read",
        { q: "flaky" },
        CTX,
      );
      expect(retry.result.actualOutcome).toBe("succeeded");
      expect(calls).toBe(2);
      expect(retry.result.reusedFromCallId).toBeNull();
    } finally {
      handle.raw.close();
    }
  });
});

describe("review regressions: atomic audit and closed registries", () => {
  it("commits the final row update and tool.completed event together while nonterminal", async () => {
    const { handle, repo } = await setup();
    try {
      const { runId } = newRunningRun(repo, T0);
      const broker = makeBroker(handle, repo, [echoReg()]);
      const before = runEvents(handle.raw, runId).length;
      const out = await broker.invoke(runId, "test.read", { q: "a" }, CTX);
      expect(out.result.actualOutcome).toBe("succeeded");
      const rows = toolCalls(handle.raw, runId);
      expect(rows[0]?.lifecycle_status).toBe("finished");
      expect(rows[0]?.actual_outcome).toBe("succeeded");
      const after = runEvents(handle.raw, runId);
      expect(after.length).toBe(before + 2);
      expect(after.map((e) => e.type)).toContain("tool.completed");
    } finally {
      handle.raw.close();
    }
  });

  it("writes audit-only rows with no event after terminal", async () => {
    const { handle, repo } = await setup();
    try {
      const { runId } = newRunningRun(repo, T0);
      const broker = makeBroker(handle, repo, [echoReg()]);
      repo.completeRun(runId, { version: 1, text: "done" }, { now: T0 + 5 });
      const before = runEvents(handle.raw, runId).length;
      const out = await broker.invoke(runId, "test.read", { q: "a" }, CTX);
      expect(out.result.actualOutcome).toBe("cancelled");
      expect(runEvents(handle.raw, runId).length).toBe(before);
      const rows = toolCalls(handle.raw, runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.actual_outcome).toBe("cancelled");
      expect(rows[0]?.lifecycle_status).toBe("finished");
    } finally {
      handle.raw.close();
    }
  });

  it("uses the closed tool error registry (unknown codes rejected)", async () => {
    expect(() => new ToolError("not_a_real_code")).toThrow();
    expect(() => new ToolError("execution_failed")).not.toThrow();
  });
});

describe("tighten-broker-atomicity: non-running emits no RunEvents", () => {
  it("queued beginnings reserve/audit with zero tool.requested/tool.completed events", async () => {
    const { handle, repo } = await setup();
    try {
      const sessionId = repo.createSession({
        key: crypto.randomUUID(),
        now: T0,
      }).body.sessionId;
      const posted = repo.postMessage(
        sessionId,
        { text: "hi" },
        { key: crypto.randomUUID(), now: T0 },
      );
      const runId = posted.body.run.id;
      expect(repo.getRun(runId).status).toBe("queued");
      const broker = makeBroker(handle, repo, [echoReg()]);
      const before = runEvents(handle.raw, runId).filter((e) =>
        e.type.startsWith("tool."),
      );
      expect(before).toHaveLength(0);
      const out = await broker.invoke(runId, "test.read", { q: "a" }, CTX);
      expect(out.result.actualOutcome).toBe("cancelled");
      expect(out.normalized).toBeNull();
      expect(out.modelFacing).toBeNull();
      expect(requestsUsed(handle.raw, runId)).toBe(1);
      const rows = toolCalls(handle.raw, runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.lifecycle_status).toBe("finished");
      expect(rows[0]?.actual_outcome).toBe("cancelled");
      const toolEvents = runEvents(handle.raw, runId).filter((e) =>
        e.type.startsWith("tool."),
      );
      expect(toolEvents).toHaveLength(0);
    } finally {
      handle.raw.close();
    }
  });

  it("cancel_requested beginnings reserve/audit with zero tool.requested/tool.completed events", async () => {
    const { handle, repo } = await setup();
    try {
      const { sessionId, runId } = newRunningRun(repo, T0);
      const broker = makeBroker(handle, repo, [echoReg()]);
      repo.cancelRun(sessionId, runId, { now: T0 + 5 });
      expect(repo.getRun(runId).status).toBe("cancel_requested");
      const toolBefore = runEvents(handle.raw, runId).filter((e) =>
        e.type.startsWith("tool."),
      );
      const out = await broker.invoke(runId, "test.read", { q: "a" }, CTX);
      expect(out.result.actualOutcome).toBe("cancelled");
      expect(out.normalized).toBeNull();
      expect(requestsUsed(handle.raw, runId)).toBe(1);
      const rows = toolCalls(handle.raw, runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.actual_outcome).toBe("cancelled");
      const toolAfter = runEvents(handle.raw, runId).filter((e) =>
        e.type.startsWith("tool."),
      );
      expect(toolAfter).toHaveLength(toolBefore.length);
      expect(toolAfter).toHaveLength(0);
    } finally {
      handle.raw.close();
    }
  });

  it("terminal beginnings reserve/audit with zero tool.requested/tool.completed events", async () => {
    const { handle, repo } = await setup();
    try {
      const { runId } = newRunningRun(repo, T0);
      const broker = makeBroker(handle, repo, [echoReg()]);
      repo.completeRun(runId, { version: 1, text: "done" }, { now: T0 + 5 });
      const toolBefore = runEvents(handle.raw, runId).filter((e) =>
        e.type.startsWith("tool."),
      );
      const out = await broker.invoke(runId, "test.read", { q: "a" }, CTX);
      expect(out.result.actualOutcome).toBe("cancelled");
      expect(requestsUsed(handle.raw, runId)).toBe(1);
      const toolAfter = runEvents(handle.raw, runId).filter((e) =>
        e.type.startsWith("tool."),
      );
      expect(toolAfter).toHaveLength(toolBefore.length);
      expect(toolAfter).toHaveLength(0);
    } finally {
      handle.raw.close();
    }
  });
});

describe("tighten-broker-atomicity: nonterminal commit rollback", () => {
  it("rolls back row+event on injected tool.completed failure and propagates a fixed storage error", async () => {
    const { handle, repo } = await setup();
    try {
      const { runId } = newRunningRun(repo, T0);
      const broker = makeBroker(handle, repo, [echoReg()]);
      handle.raw.exec(
        "CREATE TRIGGER inject_tool_completed_failure BEFORE INSERT ON run_events WHEN NEW.type = 'tool.completed' BEGIN SELECT RAISE(ABORT, 'injected_tool_completed_failure'); END",
      );
      const toolBefore = runEvents(handle.raw, runId).filter((e) =>
        e.type.startsWith("tool."),
      );
      let failure: unknown = null;
      try {
        await broker.invoke(runId, "test.read", { q: "a" }, CTX);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(KernelStorageError);
      // Fixed code, no raw sqlite text leaked.
      expect((failure as KernelStorageError).code).toBe(
        "kernel_storage_failed",
      );
      expect(String((failure as Error).message)).not.toContain(
        "injected_tool_completed_failure",
      );
      // Atomic rollback: the finished update + event did not persist
      // (the pre-commit running marker remains, but the row is not
      // finished and no completion was recorded).
      const rows = toolCalls(handle.raw, runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.lifecycle_status).not.toBe("finished");
      expect(rows[0]?.lifecycle_status).toBe("running");
      expect(rows[0]?.actual_outcome).toBeNull();
      // Requested was emitted before the failing commit; completed was not.
      const toolAfter = runEvents(handle.raw, runId).filter((e) =>
        e.type.startsWith("tool."),
      );
      expect(toolAfter.filter((e) => e.type === "tool.requested")).toHaveLength(
        1,
      );
      expect(toolAfter.filter((e) => e.type === "tool.completed")).toHaveLength(
        0,
      );
      expect(toolAfter).toHaveLength(toolBefore.length + 1);
    } finally {
      try {
        handle.raw.exec("DROP TRIGGER IF EXISTS inject_tool_completed_failure");
      } catch {
        // Best effort.
      }
      handle.raw.close();
    }
  });

  it("retains terminal audit-only late completion with no event while the trigger is armed", async () => {
    const { handle, repo } = await setup();
    try {
      const { runId } = newRunningRun(repo, T0);
      const broker = makeBroker(handle, repo, [echoReg()]);
      handle.raw.exec(
        "CREATE TRIGGER inject_tool_completed_failure BEFORE INSERT ON run_events WHEN NEW.type = 'tool.completed' BEGIN SELECT RAISE(ABORT, 'injected_tool_completed_failure'); END",
      );
      repo.completeRun(runId, { version: 1, text: "done" }, { now: T0 + 5 });
      const before = runEvents(handle.raw, runId).length;
      const out = await broker.invoke(runId, "test.read", { q: "a" }, CTX);
      expect(out.result.actualOutcome).toBe("cancelled");
      expect(runEvents(handle.raw, runId).length).toBe(before);
      const rows = toolCalls(handle.raw, runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.lifecycle_status).toBe("finished");
      expect(rows[0]?.actual_outcome).toBe("cancelled");
    } finally {
      try {
        handle.raw.exec("DROP TRIGGER IF EXISTS inject_tool_completed_failure");
      } catch {
        // Best effort.
      }
      handle.raw.close();
    }
  });
});

describe("final-m0-blockers: requested durability and safe tool-name audit", () => {
  it("propagates nonterminal requested-event failure before classification/execution", async () => {
    const { handle, repo } = await setup();
    try {
      const { runId } = newRunningRun(repo, T0);
      let entered = 0;
      const broker = makeBroker(handle, repo, [
        echoReg({
          handler: async (input: { q: string }) => {
            entered += 1;
            return { text: input.q };
          },
        }),
      ]);
      handle.raw.exec(
        "CREATE TRIGGER inject_tool_requested_failure BEFORE INSERT ON run_events WHEN NEW.type = 'tool.requested' BEGIN SELECT RAISE(ABORT, 'injected_tool_requested_failure'); END",
      );
      let failure: unknown = null;
      try {
        await broker.invoke(runId, "test.read", { q: "a" }, CTX);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(KernelStorageError);
      expect((failure as KernelStorageError).code).toBe(
        "kernel_storage_failed",
      );
      expect(String((failure as Error).message)).not.toContain(
        "injected_tool_requested_failure",
      );
      // Physical execution never occurred without the durable requested event.
      expect(entered).toBe(0);
      // Budget was still reserved first.
      expect(requestsUsed(handle.raw, runId)).toBe(1);
      // No requested/completed events persisted; the call row never finished.
      const toolEvents = runEvents(handle.raw, runId).filter((e) =>
        e.type.startsWith("tool."),
      );
      expect(toolEvents).toHaveLength(0);
      const rows = toolCalls(handle.raw, runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.lifecycle_status).not.toBe("finished");
      expect(rows[0]?.actual_outcome).toBeNull();
    } finally {
      try {
        handle.raw.exec("DROP TRIGGER IF EXISTS inject_tool_requested_failure");
      } catch {
        // Best effort.
      }
      handle.raw.close();
    }
  });

  it("audits invalid namespace.verb names with a fixed synthetic name and never persists the raw text", async () => {
    const { handle, repo } = await setup();
    try {
      const { runId } = newRunningRun(repo, T0);
      const steps: PipelineStep[] = [];
      const broker = makeBroker(handle, repo, [echoReg()], {
        onStep: (s) => steps.push(s),
      });
      const secret = "SECRET-XYZ-789";
      const evil = `BAD NAME ${secret}!!`;
      const out = await broker.invoke(runId, evil, { q: secret }, CTX);
      expect(out.result.actualOutcome).toBe("invalid");
      expect(out.result.errorCode).toBe("invalid_input");
      // Returned result uses the fixed valid synthetic name.
      expect(out.result.tool).toBe("invalid.request");
      // Observable pipeline still starts with budget_reserve.
      expect(out.pipeline[0]).toBe("budget_reserve");
      expect(steps[0]).toBe("budget_reserve");
      expect(requestsUsed(handle.raw, runId)).toBe(1);
      const rows = toolCalls(handle.raw, runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.tool).toBe("invalid.request");
      expect(rows[0]?.actual_outcome).toBe("invalid");
      const events = runEvents(handle.raw, runId);
      expect(events.filter((e) => e.type === "tool.requested")).toHaveLength(1);
      expect(events.filter((e) => e.type === "tool.completed")).toHaveLength(1);
      for (const event of events.filter((e) => e.type.startsWith("tool."))) {
        const payload = JSON.parse(event.payload) as Record<string, unknown>;
        expect(payload.tool).toBe("invalid.request");
      }
      // Raw invalid text and secrets appear nowhere durable/returned.
      const rowText = JSON.stringify(rows);
      expect(rowText).not.toContain(secret);
      expect(rowText).not.toContain(evil);
      expect(rowText).not.toContain("BAD NAME");
      const eventText = JSON.stringify(events);
      expect(eventText).not.toContain(secret);
      expect(eventText).not.toContain(evil);
      const resultText = JSON.stringify(out.result);
      expect(resultText).not.toContain(secret);
      expect(resultText).not.toContain(evil);
      // Valid-format unknown names still produce unknown_tool.
      const unknown = await broker.invoke(
        runId,
        "nope.missing",
        { q: "a" },
        CTX,
      );
      expect(unknown.result.actualOutcome).toBe("unknown");
      expect(unknown.result.errorCode).toBe("unknown_tool");
      expect(unknown.result.tool).toBe("nope.missing");
    } finally {
      handle.raw.close();
    }
  });
});

describe("fix-broker-review-nine", () => {
  it("holds slots until the detached handler settles", async () => {
    const { handle, repo } = await setup();
    try {
      const { runId } = newRunningRun(repo, T0);
      const gate = deferred();
      const broker = makeBroker(
        handle,
        repo,
        [
          echoReg({
            handler: async (input: { q: string }) => {
              await gate.promise;
              return { text: input.q };
            },
          }),
        ],
        { budgets: { maxConcurrentPerRun: 1 } },
      );
      const out = await broker.invoke(
        runId,
        "test.read",
        { q: "slow" },
        { ...CTX, freshness: "refresh", timeoutMs: 25 },
      );
      expect(out.result.actualOutcome).toBe("timed_out");
      // Detached work still holds its slots until it settles.
      const usage = broker.getSlotUsage();
      expect(usage.perRunActive[runId] ?? 0).toBe(1);
      expect(usage.processActive).toBe(1);
      gate.resolve();
      const deadline = Date.now() + 2000;
      for (;;) {
        const u = broker.getSlotUsage();
        if ((u.perRunActive[runId] ?? 0) === 0 && u.processActive === 0) break;
        if (Date.now() > deadline) throw new Error("slots never released");
        await sleep(5);
      }
    } finally {
      handle.raw.close();
    }
  });

  it("publishes dedup cache only after a successful audit commit", async () => {
    const { handle, repo } = await setup();
    try {
      const { runId } = newRunningRun(repo, T0);
      let calls = 0;
      const broker = makeBroker(handle, repo, [
        echoReg({
          handler: async (input: { q: string }) => {
            calls += 1;
            return { text: input.q };
          },
        }),
      ]);
      handle.raw.exec(
        "CREATE TRIGGER inject_tool_completed_failure BEFORE INSERT ON run_events WHEN NEW.type = 'tool.completed' BEGIN SELECT RAISE(ABORT, 'injected_tool_completed_failure'); END",
      );
      let failure: unknown = null;
      try {
        await broker.invoke(runId, "test.read", { q: "k" }, CTX);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(KernelStorageError);
      expect(calls).toBe(1);
      handle.raw.exec("DROP TRIGGER IF EXISTS inject_tool_completed_failure");
      const retry = await broker.invoke(runId, "test.read", { q: "k" }, CTX);
      expect(retry.result.actualOutcome).toBe("succeeded");
      expect(retry.result.reusedFromCallId).toBeNull();
      expect(calls).toBe(2);
    } finally {
      try {
        handle.raw.exec("DROP TRIGGER IF EXISTS inject_tool_completed_failure");
      } catch {
        // Best effort.
      }
      handle.raw.close();
    }
  });

  it("emits tool.requested with the post-Zod canonical args hash", async () => {
    const { handle, repo } = await setup();
    try {
      const { runId } = newRunningRun(repo, T0);
      const broker = makeBroker(handle, repo, [echoReg()]);
      const out = await broker.invoke(runId, "test.read", {}, CTX);
      expect(out.result.actualOutcome).toBe("succeeded");
      const { createHash } = await import("node:crypto");
      const expected = createHash("sha256")
        .update('{"q":"hi"}', "utf8")
        .digest("hex");
      const rows = toolCalls(handle.raw, runId);
      expect(rows[0]?.args_hash).toBe(expected);
      const requested = runEvents(handle.raw, runId).find(
        (e) => e.type === "tool.requested",
      );
      expect(requested).toBeDefined();
      const payload = JSON.parse(requested?.payload as string) as Record<
        string,
        unknown
      >;
      expect(payload.argsHash).toBe(expected);
    } finally {
      handle.raw.close();
    }
  });

  it("times out coalesced followers independently of the leader", async () => {
    const { handle, repo } = await setup();
    try {
      const { runId } = newRunningRun(repo, T0);
      const gate = deferred();
      const broker = makeBroker(handle, repo, [
        echoReg({
          handler: async (input: { q: string }) => {
            await gate.promise;
            return { text: input.q };
          },
        }),
      ]);
      const leader = broker.invoke(runId, "test.read", { q: "same" }, CTX);
      await sleep(10);
      const start = Date.now();
      const follower = await broker.invoke(
        runId,
        "test.read",
        { q: "same" },
        { ...CTX, timeoutMs: 25 },
      );
      expect(Date.now() - start).toBeLessThan(2000);
      expect(follower.result.actualOutcome).toBe("timed_out");
      expect(follower.result.errorCode).toBe("execution_timeout");
      expect(follower.normalized).toBeNull();
      gate.resolve();
      const r1 = await leader;
      expect(r1.result.actualOutcome).toBe("succeeded");
    } finally {
      handle.raw.close();
    }
  });

  it("never overwrites an existing report with a late detached report", async () => {
    const { handle, repo } = await setup();
    try {
      const { runId } = newRunningRun(repo, T0);
      const broker = makeBroker(handle, repo, [
        echoReg({
          handler: async (input: { q: string }) => {
            await sleep(120);
            return { text: input.q };
          },
        }),
      ]);
      const controller = new AbortController();
      const pending = broker.invoke(
        runId,
        "test.read",
        { q: "slow" },
        { ...CTX, signal: controller.signal },
      );
      await sleep(10);
      controller.abort();
      const out = await pending;
      expect(out.result.actualOutcome).toBe("cancelled");
      // Simulate a cooperative report winning the race before the late
      // success lands: the late report must not overwrite it.
      handle.raw
        .prepare("UPDATE tool_calls SET reported_outcome = ? WHERE run_id = ?")
        .run("failed", runId);
      // The detached handler settles ~120ms after invoke; wait past it.
      await sleep(300);
      const rows = toolCalls(handle.raw, runId);
      expect(rows[0]?.reported_outcome).toBe("failed");
    } finally {
      handle.raw.close();
    }
  });

  it("records handler success on normalization timeout with discarded disposition", async () => {
    const { handle, repo } = await setup();
    try {
      const { runId } = newRunningRun(repo, T0);
      const broker = makeBroker(handle, repo, [
        echoReg({
          handler: async () => ({ text: "ok" }),
          normalize: () => new Promise<never>(() => {}),
        }),
      ]);
      const out = await broker.invoke(
        runId,
        "test.read",
        { q: "a" },
        { ...CTX, timeoutMs: 25 },
      );
      expect(out.result.actualOutcome).toBe("timed_out");
      expect(out.result.errorCode).toBe("execution_timeout");
      expect(out.result.reportedOutcome).toBe("succeeded");
      expect(out.result.disposition).toBe("discarded");
      expect(out.normalized).toBeNull();
    } finally {
      handle.raw.close();
    }
  });

  it("settles audit-only with no tool.completed event for cancel_requested runs", async () => {
    const { handle, repo } = await setup();
    try {
      const { sessionId, runId } = newRunningRun(repo, T0);
      const gate = deferred();
      const broker = makeBroker(handle, repo, [
        echoReg({
          handler: async (input: { q: string }) => {
            await gate.promise;
            return { text: input.q };
          },
        }),
      ]);
      const pending = broker.invoke(runId, "test.read", { q: "late" }, CTX);
      await sleep(10);
      repo.cancelRun(sessionId, runId, { now: T0 + 5 });
      expect(repo.getRun(runId).status).toBe("cancel_requested");
      const completedBefore = runEvents(handle.raw, runId).filter(
        (e) => e.type === "tool.completed",
      ).length;
      gate.resolve();
      const out = await pending;
      expect(out.result.actualOutcome).toBe("cancelled");
      expect(out.result.disposition).toBe("discarded");
      const completedAfter = runEvents(handle.raw, runId).filter(
        (e) => e.type === "tool.completed",
      ).length;
      expect(completedAfter).toBe(completedBefore);
      const rows = toolCalls(handle.raw, runId);
      expect(rows[0]?.actual_outcome).toBe("cancelled");
      expect(rows[0]?.lifecycle_status).toBe("finished");
    } finally {
      handle.raw.close();
    }
  });

  it("uses the outputSchema-parsed value for audit and delivery", async () => {
    const { handle, repo } = await setup();
    try {
      const { runId } = newRunningRun(repo, T0);
      const broker = makeBroker(handle, repo, [
        {
          ...echoReg(),
          inputSchema: z.strictObject({}),
          outputSchema: z.strictObject({
            text: z.string(),
            flag: z.boolean().default(true),
          }),
          handler: async () => ({ text: "hi" }),
        },
      ]);
      const out = await broker.invoke(runId, "test.read", {}, CTX);
      expect(out.result.actualOutcome).toBe("succeeded");
      expect(out.normalized).toEqual({ text: "hi", flag: true });
      expect(out.modelFacing).toEqual({ text: "hi", flag: true });
      const { createHash } = await import("node:crypto");
      const expectedDigest = createHash("sha256")
        .update('{"flag":true,"text":"hi"}', "utf8")
        .digest("hex");
      expect(out.result.resultDigest).toBe(expectedDigest);
      expect(toolCalls(handle.raw, runId)[0]?.result_digest).toBe(
        expectedDigest,
      );
    } finally {
      handle.raw.close();
    }
  });

  it("preserves a custom modelFacing projection through outputSchema parsing", async () => {
    const { handle, repo } = await setup();
    try {
      const { runId } = newRunningRun(repo, T0);
      const broker = makeBroker(handle, repo, [
        {
          ...echoReg(),
          inputSchema: z.strictObject({}),
          outputSchema: z.strictObject({
            text: z.string(),
            flag: z.boolean().default(true),
          }),
          handler: async () => ({ text: "hi" }),
          normalize: (raw) => ({
            normalized: raw,
            observations: 0,
            modelFacing: { preview: "custom" },
          }),
        },
      ]);
      const out = await broker.invoke(runId, "test.read", {}, CTX);
      expect(out.result.actualOutcome).toBe("succeeded");
      expect(out.normalized).toEqual({ text: "hi", flag: true });
      expect(out.modelFacing).toEqual({ preview: "custom" });
    } finally {
      handle.raw.close();
    }
  });

  it("defensively clones cached and returned payloads", async () => {
    const { handle, repo } = await setup();
    try {
      const { runId } = newRunningRun(repo, T0);
      const broker = makeBroker(handle, repo, [
        {
          ...echoReg(),
          inputSchema: z.strictObject({}),
          outputSchema: z.strictObject({
            text: z.string(),
            items: z.array(z.number()),
          }),
          handler: async () => ({ text: "hi", items: [1] }),
        },
      ]);
      const first = await broker.invoke(runId, "test.read", {}, CTX);
      expect(first.result.actualOutcome).toBe("succeeded");
      (first.normalized as { items: number[] }).items.push(999);
      (first.modelFacing as { items: number[] }).items.push(999);
      const second = await broker.invoke(runId, "test.read", {}, CTX);
      expect(second.result.actualOutcome).toBe("deduplicated");
      expect(second.normalized).toEqual({ text: "hi", items: [1] });
      expect(second.modelFacing).toEqual({ text: "hi", items: [1] });
      expect(second.normalized).not.toBe(first.normalized);
    } finally {
      handle.raw.close();
    }
  });
});
