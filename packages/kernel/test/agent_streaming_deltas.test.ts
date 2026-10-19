// PR-2 kernel streaming deltas: provisional gateway pieces forward with
// run/step correlation, never touch durable writes, validated path same.
import type {
  ChatRequest,
  ChatResult,
  ModelGateway,
  ModelStreamDelta,
  NormalizedToolCall,
} from "@companion/model-local";
import { describe, expect, it } from "vitest";
import {
  type AgentModelDelta,
  closeKernelDatabase,
  createAgentStrategy,
  createKernelRepository,
  createToolBroker,
  freezeStrategyContext,
  type KernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
} from "../src/index.js";

const T0 = 1790000000000;

function answerCall(
  parts = [{ text: "final", citations: [] as string[] }],
  id = "answer-1",
): NormalizedToolCall {
  return {
    id,
    name: "answer.submit",
    arguments: { version: 1, parts },
  };
}

/** Fake streaming gateway: emits deltas via onDelta, then resolves. */
function streamingGateway(
  script: Array<{ deltas: ModelStreamDelta[]; result: ChatResult }>,
): ModelGateway {
  let calls = 0;
  return {
    provider: "openai-compatible",
    capabilities: { toolCalling: true },
    baseUrl: "http://127.0.0.1:8000",
    chatUrl: "http://127.0.0.1:8000/v1/chat/completions",
    chat: async (
      _request: ChatRequest,
      options?: {
        signal?: AbortSignal;
        onDelta?: (d: ModelStreamDelta) => void;
      },
    ): Promise<ChatResult> => {
      const next = script[Math.min(calls, script.length - 1)] as {
        deltas: ModelStreamDelta[];
        result: ChatResult;
      };
      calls += 1;
      for (const delta of next.deltas) {
        options?.onDelta?.(delta);
      }
      return next.result;
    },
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

function newRunningTurn(
  repo: KernelRepository,
  now: number,
): { sessionId: string; runId: string } {
  const sessionId = repo.createSession({ key: crypto.randomUUID(), now }).body
    .sessionId;
  const posted = repo.postMessage(
    sessionId,
    { text: "stream this" },
    { key: crypto.randomUUID(), now },
  );
  const runId = posted.body.run.id;
  repo.startRun(runId, { now: now + 1 });
  return { sessionId, runId };
}

/** Gateway that aborts mid-call, then keeps emitting deltas (non-cooperative). */
function abortingGateway(late: ModelStreamDelta[]): ModelGateway {
  return {
    provider: "openai-compatible",
    capabilities: { toolCalling: true },
    baseUrl: "http://127.0.0.1:8000",
    chatUrl: "http://127.0.0.1:8000/v1/chat/completions",
    chat: async (
      _request: ChatRequest,
      options?: {
        signal?: AbortSignal;
        onDelta?: (d: ModelStreamDelta) => void;
      },
    ): Promise<ChatResult> => {
      const signal = options?.signal;
      await new Promise<void>((resolve) => {
        if (signal?.aborted) {
          resolve();
          return;
        }
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      // The step controller already aborted; these late deltas must be
      // dropped by the kernel's settlement/abort gate.
      for (const delta of late) {
        options?.onDelta?.(delta);
      }
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      throw error;
    },
  };
}

describe("agent streaming deltas (PR-2)", () => {
  it("forwards provisional deltas with run/step correlation, durables unchanged", async () => {
    const { handle, repo } = await setup();
    try {
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [],
      });
      const gateway = streamingGateway([
        {
          deltas: [
            { kind: "reasoning", text: "thinking…" },
            { kind: "draft", text: "fin" },
            { kind: "draft", text: "al" },
            { kind: "usage", inputTokens: 10, outputTokens: 5 },
          ],
          result: {
            text: "",
            toolCalls: [answerCall()],
            stopReason: "tool_calls",
            usage: { inputTokens: 10, outputTokens: 5 },
          },
        },
      ]);
      const seen: AgentModelDelta[] = [];
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway,
        model: "m",
        onModelDelta: (delta) => {
          seen.push(delta);
        },
      });
      const { sessionId, runId } = newRunningTurn(repo, T0);
      const candidate = await strategy(ctxFor(repo, runId));
      expect(seen).toHaveLength(4);
      expect(seen[0]).toMatchObject({
        runId,
        step: 1,
        delta: { kind: "reasoning", text: "thinking…" },
      });
      expect(seen[1]).toMatchObject({
        runId,
        step: 1,
        delta: { kind: "draft", text: "fin" },
      });
      expect(seen[3]).toMatchObject({
        runId,
        step: 1,
        delta: { kind: "usage", inputTokens: 10, outputTokens: 5 },
      });
      for (const delta of seen) {
        expect(delta.elapsedMs).toBeGreaterThanOrEqual(0);
      }
      // Durable writes carry no delta content: same rows/events as M2.
      expect(repo.listModelCalls(runId)).toHaveLength(1);
      const types = repo
        .getEvents(sessionId, runId, {})
        .events.map((e) => e.type);
      expect(types).not.toContain("model.reasoning.delta");
      expect(types).not.toContain("answer.draft.delta");
      expect(types).not.toContain("model.usage");
      expect(types).toContain("model.step.completed");
      // The strategy returns the validated candidate (engine owns the
      // terminal event): deltas never substitute for it.
      expect(JSON.stringify(candidate)).toContain("final");
      const completed = repo
        .getEvents(sessionId, runId, {})
        .events.find((e) => e.type === "run.completed");
      expect(completed).toBeUndefined();
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("a throwing delta sink never fails the step", async () => {
    const { handle, repo } = await setup();
    try {
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [],
      });
      const gateway = streamingGateway([
        {
          deltas: [{ kind: "content", text: "x" }],
          result: {
            text: "",
            toolCalls: [answerCall([{ text: "ok", citations: [] }])],
            stopReason: "tool_calls",
          },
        },
      ]);
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway,
        model: "m",
        onModelDelta: () => {
          throw new Error("sink boom");
        },
      });
      const { runId } = newRunningTurn(repo, T0);
      await strategy(ctxFor(repo, runId));
      expect(repo.listModelCalls(runId)).toHaveLength(1);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("drops deltas emitted after the step settled/aborted", async () => {
    const { handle, repo } = await setup();
    try {
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [],
      });
      const gateway = abortingGateway([
        { kind: "draft", text: "stale" },
        { kind: "usage", inputTokens: 1, outputTokens: 1 },
      ]);
      const seen: AgentModelDelta[] = [];
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway,
        model: "m",
        onModelDelta: (delta) => {
          seen.push(delta);
        },
      });
      const { runId } = newRunningTurn(repo, T0);
      // Cancel the run while the gateway is mid-call: the step controller
      // aborts, then the non-cooperative gateway keeps emitting deltas.
      const external = new AbortController();
      setTimeout(() => external.abort(), 10);
      try {
        await strategy(ctxFor(repo, runId, external.signal));
      } catch {
        // Abort settlement may surface as a rejection; the assertion below
        // is about deltas, not the run fate.
      }
      expect(seen).toHaveLength(0);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
