// AgentStrategy wall-abort propagation (PR r3943508125): the Run-scoped
// 300s wall signal is shared by model steps and ToolBroker invocations, so
// queued/running connector work is aborted/detached when the wall expires
// before the Run fails with execution_failed (never execution_cancelled).
// Deterministic: in-memory DBs, scripted gateways, fake timers/clocks.
// No network, no real models.

import type {
  ChatRequest,
  ChatResult,
  ModelGateway,
  NormalizedToolCall,
} from "@companion/model-local";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  closeKernelDatabase,
  createAgentStrategy,
  createKernelRepository,
  createToolBroker,
  freezeStrategyContext,
  type KernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
  type ToolRegistration,
} from "../src/index.js";

const T0 = 1790000000000;

afterEach(() => {
  vi.useRealTimers();
});

function toolCall(
  name: string,
  args: unknown = {},
  id?: string,
): NormalizedToolCall {
  return {
    id: id ?? `call-${name}-${Math.random().toString(36).slice(2)}`,
    name,
    arguments: args,
  };
}

function answerCall(): NormalizedToolCall {
  return toolCall(
    "answer.submit",
    { version: 1, parts: [{ text: "final", citations: [] }] },
    "answer-1",
  );
}

function readReg(
  handler: ToolRegistration["handler"],
  name = "test.read",
): ToolRegistration {
  return {
    descriptor: {
      name,
      version: 1,
      title: "t",
      description: "d",
      category: "read",
      defaultTimeoutMs: 5000,
      maxTimeoutMs: 10_000,
      supportsRefresh: true,
    },
    inputSchema: z.strictObject({ q: z.string().default("hi") }),
    outputSchema: z.strictObject({ text: z.string() }),
    handler,
  };
}

async function setup(): Promise<{
  handle: ReturnType<typeof openKernelDatabase>;
  repo: KernelRepository;
}> {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  return { handle, repo: createKernelRepository(handle.raw) };
}

function newRunningTurn(
  repo: KernelRepository,
  now: number,
): { sessionId: string; runId: string } {
  const sessionId = repo.createSession({ key: crypto.randomUUID(), now }).body
    .sessionId;
  const posted = repo.postMessage(
    sessionId,
    { text: "research this" },
    { key: crypto.randomUUID(), now },
  );
  const runId = posted.body.run.id;
  repo.startRun(runId, { now: now + 1 });
  return { sessionId, runId };
}

function ctxFor(repo: KernelRepository, runId: string, signal?: AbortSignal) {
  const run = repo.getRun(runId);
  const turn = repo.getTurn(run.turnId);
  return freezeStrategyContext(
    {
      id: run.id,
      turnId: run.turnId,
      sessionId: run.sessionId,
      attempt: run.attempt,
      strategy: run.strategy,
    },
    {
      id: turn.id,
      sessionId: turn.sessionId,
      seq: turn.seq,
      input: turn.input,
      frozenContext: turn.frozenContext,
    },
    signal ?? new AbortController().signal,
  );
}

function ordinaryGateway(calls: ChatRequest[], first: NormalizedToolCall[]) {
  const gateway: ModelGateway = {
    provider: "ollama",
    capabilities: { toolCalling: true },
    baseUrl: "http://127.0.0.1:11434",
    chatUrl: "http://127.0.0.1:11434/api/chat",
    chat: async (request: ChatRequest): Promise<ChatResult> => {
      calls.push(request);
      if (calls.length === 1) {
        return { text: "", toolCalls: first, stopReason: "tool_calls" };
      }
      return { text: "", toolCalls: [answerCall()], stopReason: "tool_calls" };
    },
  };
  return gateway;
}

describe("agent wall abort propagation", () => {
  it("aborts cooperative tool work on wall expiry and fails without a second model step", async () => {
    vi.useFakeTimers();
    const { handle, repo } = await setup();
    try {
      let abortSeen = false;
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [
          readReg(async (_input, ctx) => {
            // Cooperative connector: stops when the shared wall signal fires.
            if (ctx.signal.aborted) {
              abortSeen = true;
              throw new Error("cancelled");
            }
            await new Promise<void>((_resolve, reject) => {
              if (ctx.signal.aborted) {
                abortSeen = true;
                reject(new Error("cancelled"));
                return;
              }
              ctx.signal.addEventListener(
                "abort",
                () => {
                  abortSeen = true;
                  reject(new Error("cancelled"));
                },
                { once: true },
              );
            });
            return { text: "never" };
          }),
        ],
      });
      const calls: ChatRequest[] = [];
      const gateway = ordinaryGateway(calls, [
        toolCall("test.read", { q: "a" }, "c0"),
      ]);
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway,
        model: "m",
        wallMs: 100,
        stepTimeoutMs: 10_000,
      });
      const { runId } = newRunningTurn(repo, T0);
      const pending = strategy(ctxFor(repo, runId));
      const assertion = expect(pending).rejects.toMatchObject({
        name: "StrategyError",
        errorCode: "execution_failed",
      });
      await vi.advanceTimersByTimeAsync(150);
      await assertion;
      // Wall abort reached the connector before the Run failed.
      expect(abortSeen).toBe(true);
      // No second model step, no grants, no completed step after the wall.
      expect(calls).toHaveLength(1);
      expect(repo.listEvidenceGrants(runId)).toEqual([]);
      expect(
        repo.listModelCalls(runId).filter((r) => r.outcome === "completed"),
      ).toHaveLength(1);
      // Broker detached the aborted call as cancelled (strategy layer still
      // reports the wall as execution_failed: no misclassification).
      const rows = handle.raw
        .prepare("SELECT actual_outcome AS o FROM tool_calls")
        .all() as Array<{ o: string }>;
      expect(rows.map((r) => r.o)).toEqual(["cancelled"]);
      // Wall timer/listeners cleared: no lingering timers.
      expect(vi.getTimerCount()).toBe(0);
      // No post-terminal output lands late.
      await vi.advanceTimersByTimeAsync(5000);
      expect(calls).toHaveLength(1);
      expect(repo.listModelCalls(runId)).toHaveLength(1);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("detaches non-cooperative tool work on wall expiry (no post-wall feedback)", async () => {
    vi.useFakeTimers();
    const { handle, repo } = await setup();
    try {
      let started = 0;
      let signalAborted = false;
      let signal: AbortSignal | null = null;
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [
          readReg(async (_input, ctx) => {
            started += 1;
            signal = ctx.signal;
            // Non-cooperative connector: ignores the signal forever.
            await new Promise<never>(() => {});
            return { text: "never" };
          }),
        ],
      });
      const calls: ChatRequest[] = [];
      const gateway = ordinaryGateway(calls, [
        toolCall("test.read", { q: "a" }, "c0"),
      ]);
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway,
        model: "m",
        wallMs: 50,
        stepTimeoutMs: 10_000,
      });
      const { runId } = newRunningTurn(repo, T0);
      const pending = strategy(ctxFor(repo, runId));
      const assertion = expect(pending).rejects.toMatchObject({
        name: "StrategyError",
        errorCode: "execution_failed",
      });
      await vi.advanceTimersByTimeAsync(80);
      await assertion;
      expect(started).toBe(1);
      signalAborted = (signal as AbortSignal | null)?.aborted === true;
      // The broker was told to abort (detach) before the Run failed, even
      // though the handler never cooperates.
      expect(signalAborted).toBe(true);
      expect(calls).toHaveLength(1);
      expect(repo.listEvidenceGrants(runId)).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(5000);
      expect(calls).toHaveLength(1);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("never starts queued tool calls after the wall expires", async () => {
    vi.useFakeTimers();
    const { handle, repo } = await setup();
    try {
      const started: string[] = [];
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [
          readReg(async (input: { q: string }) => {
            started.push(input.q);
            // Hang every started call; the wall must detach them.
            await new Promise<never>(() => {});
            return { text: "never" };
          }),
        ],
      });
      const calls: ChatRequest[] = [];
      const first = ["a", "b", "c", "d"].map((q, i) =>
        toolCall("test.read", { q }, `c${i}`),
      );
      const gateway = ordinaryGateway(calls, first);
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway,
        model: "m",
        wallMs: 40,
        stepTimeoutMs: 10_000,
      });
      const { runId } = newRunningTurn(repo, T0);
      const pending = strategy(ctxFor(repo, runId));
      const assertion = expect(pending).rejects.toMatchObject({
        errorCode: "execution_failed",
      });
      await vi.advanceTimersByTimeAsync(100);
      await assertion;
      // Concurrency 3 starts three; the queued fourth never executes.
      expect(started).toHaveLength(3);
      expect(started.sort()).toEqual(["a", "b", "c"]);
      expect(calls).toHaveLength(1);
      expect(repo.listEvidenceGrants(runId)).toEqual([]);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("fails on fake-clock wall expiry after tools with no second step", async () => {
    const { handle, repo } = await setup();
    try {
      let now = T0;
      const clock = { now: () => now };
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [
          readReg(async () => {
            now += 2000;
            return { text: "late" };
          }),
        ],
      });
      const calls: ChatRequest[] = [];
      const gateway = ordinaryGateway(calls, [
        toolCall("test.read", { q: "a" }, "c0"),
      ]);
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway,
        model: "m",
        clock,
        wallMs: 1000,
        stepTimeoutMs: 10_000,
      });
      const { runId } = newRunningTurn(repo, T0);
      await expect(strategy(ctxFor(repo, runId))).rejects.toMatchObject({
        name: "StrategyError",
        errorCode: "execution_failed",
      });
      expect(calls).toHaveLength(1);
      expect(repo.listEvidenceGrants(runId)).toEqual([]);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("clears the wall timer on success and keeps engine cancellation distinct", async () => {
    vi.useFakeTimers();
    const { handle, repo } = await setup();
    try {
      // Success path: a long wall budget leaves no timers behind.
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [],
      });
      const calls: ChatRequest[] = [];
      const gateway: ModelGateway = {
        provider: "ollama",
        capabilities: { toolCalling: true },
        baseUrl: "http://127.0.0.1:11434",
        chatUrl: "http://127.0.0.1:11434/api/chat",
        chat: async (request: ChatRequest): Promise<ChatResult> => {
          calls.push(request);
          return {
            text: "",
            toolCalls: [answerCall()],
            stopReason: "tool_calls",
          };
        },
      };
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway,
        model: "m",
        wallMs: 10_000,
        stepTimeoutMs: 10_000,
      });
      const ok = newRunningTurn(repo, T0);
      await expect(strategy(ctxFor(repo, ok.runId))).resolves.toEqual({
        version: 2,
        text: "final",
        answer: { version: 1, parts: [{ text: "final", citations: [] }] },
      });
      expect(vi.getTimerCount()).toBe(0);

      // Engine cancellation during tools stays execution_cancelled even
      // with a live wall budget (never misclassified as wall failure).
      const hanging = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [
          readReg(async () => new Promise<{ text: string }>(() => {})),
        ],
      });
      const calls2: ChatRequest[] = [];
      const gateway2 = ordinaryGateway(calls2, [
        toolCall("test.read", { q: "a" }, "c0"),
      ]);
      const strategy2 = createAgentStrategy({
        db: handle.raw,
        repo,
        broker: hanging,
        gateway: gateway2,
        model: "m",
        wallMs: 10_000,
        stepTimeoutMs: 10_000,
      });
      const { runId } = newRunningTurn(repo, T0 + 100);
      const controller = new AbortController();
      const pending = strategy2(ctxFor(repo, runId, controller.signal));
      const assertion = expect(pending).rejects.toMatchObject({
        errorCode: "execution_cancelled",
      });
      await vi.advanceTimersByTimeAsync(10);
      controller.abort();
      await assertion;
      expect(calls2).toHaveLength(1);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
