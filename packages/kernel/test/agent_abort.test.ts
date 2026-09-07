// AgentStrategy abort propagation: the per-step AbortSignal must reach
// gateway.chat, actually cancel the underlying fetch, classify deadline
// timeout as model_step_timeout versus engine cancellation distinctly, and
// discard late/non-cooperative results. Deterministic: in-memory DBs,
// scripted gateways, fake timers or tiny real timeouts. No network.

import type {
  ChatRequest,
  ChatResult,
  ModelGateway,
  NormalizedToolCall,
} from "@companion/model-local";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
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

afterEach(() => {
  vi.useRealTimers();
});

function answerCall(): NormalizedToolCall {
  return {
    id: "answer-1",
    name: "answer.submit",
    arguments: { version: 1, parts: [{ text: "final", citations: [] }] },
  };
}

function answerResult(): ChatResult {
  return { text: "", toolCalls: [answerCall()], stopReason: "tool_calls" };
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

describe("agent per-step abort propagation", () => {
  it("aborts the gateway fetch on the 120s step timeout (fake timers, cooperative gateway)", async () => {
    vi.useFakeTimers();
    const { handle, repo } = await setup();
    try {
      const seen: { signal?: AbortSignal | null } = {};
      const gateway: ModelGateway = {
        provider: "ollama",
        capabilities: { toolCalling: true },
        baseUrl: "http://127.0.0.1:11434",
        chatUrl: "http://127.0.0.1:11434/api/chat",
        chat: (_request: ChatRequest, options?: { signal?: AbortSignal }) => {
          seen.signal = options?.signal ?? null;
          return new Promise<ChatResult>((_resolve, reject) => {
            const signal = options?.signal ?? null;
            if (signal?.aborted === true) {
              reject(
                new DOMException("The operation was aborted.", "AbortError"),
              );
              return;
            }
            signal?.addEventListener(
              "abort",
              () =>
                reject(
                  new DOMException("The operation was aborted.", "AbortError"),
                ),
              { once: true },
            );
          });
        },
      };
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [],
      });
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway,
        model: "test-model",
        stepTimeoutMs: 120_000,
      });
      const { runId } = newRunningTurn(repo, T0);
      const pending = strategy(ctxFor(repo, runId));
      const assertion = expect(pending).rejects.toMatchObject({
        errorCode: "execution_failed",
      });
      await vi.advanceTimersByTimeAsync(120_000);
      await assertion;
      expect(seen.signal?.aborted).toBe(true);
      expect(repo.listModelCalls(runId)[0]).toMatchObject({
        outcome: "timeout",
        errorCode: "model_step_timeout",
      });
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("forwards engine cancellation to the gateway signal and audits cancelled", async () => {
    const { handle, repo } = await setup();
    try {
      const seen: { signal?: AbortSignal | null } = {};
      let observedAbort = false;
      const gateway: ModelGateway = {
        provider: "ollama",
        capabilities: { toolCalling: true },
        baseUrl: "http://127.0.0.1:11434",
        chatUrl: "http://127.0.0.1:11434/api/chat",
        chat: (_request: ChatRequest, options?: { signal?: AbortSignal }) =>
          new Promise<ChatResult>((_resolve, reject) => {
            seen.signal = options?.signal ?? null;
            const signal = options?.signal;
            if (signal === undefined) {
              reject(new Error("signal missing"));
              return;
            }
            signal.addEventListener(
              "abort",
              () => {
                observedAbort = true;
                reject(
                  new DOMException("The operation was aborted.", "AbortError"),
                );
              },
              { once: true },
            );
          }),
      };
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [],
      });
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway,
        model: "test-model",
        stepTimeoutMs: 120_000,
      });
      const { runId } = newRunningTurn(repo, T0);
      const controller = new AbortController();
      const pending = strategy(ctxFor(repo, runId, controller.signal));
      // Let the strategy enter gateway.chat, then cancel the run.
      await new Promise((resolve) => setTimeout(resolve, 5));
      controller.abort();
      await expect(pending).rejects.toMatchObject({
        errorCode: "execution_cancelled",
      });
      expect(seen.signal?.aborted).toBe(true);
      expect(observedAbort).toBe(true);
      expect(repo.listModelCalls(runId)[0]).toMatchObject({
        outcome: "cancelled",
        errorCode: null,
      });
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("discards late results from a non-cooperative gateway after the deadline", async () => {
    const { handle, repo } = await setup();
    try {
      let chatCalls = 0;
      const gateway: ModelGateway = {
        provider: "ollama",
        capabilities: { toolCalling: true },
        baseUrl: "http://127.0.0.1:11434",
        chatUrl: "http://127.0.0.1:11434/api/chat",
        // Ignores the signal and resolves late with a would-be answer.
        chat: async () => {
          chatCalls += 1;
          await new Promise((resolve) => setTimeout(resolve, 60));
          return answerResult();
        },
      };
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [],
      });
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway,
        model: "test-model",
        stepTimeoutMs: 20,
      });
      const { runId } = newRunningTurn(repo, T0);
      await expect(strategy(ctxFor(repo, runId))).rejects.toMatchObject({
        errorCode: "execution_failed",
      });
      expect(chatCalls).toBe(1);
      expect(repo.listModelCalls(runId)[0]).toMatchObject({
        outcome: "timeout",
        errorCode: "model_step_timeout",
      });
      // Let the late settlement land; it must not create a second audit row
      // or flip the outcome.
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(repo.listModelCalls(runId)).toHaveLength(1);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("keeps cooperative deadline aborts as timeout (no double cancellation)", async () => {
    const { handle, repo } = await setup();
    try {
      const gateway: ModelGateway = {
        provider: "openai-compatible",
        capabilities: { toolCalling: true },
        baseUrl: "http://127.0.0.1:8000",
        chatUrl: "http://127.0.0.1:8000/v1/chat/completions",
        chat: (_request: ChatRequest, options?: { signal?: AbortSignal }) =>
          new Promise<ChatResult>((_resolve, reject) => {
            options?.signal?.addEventListener(
              "abort",
              () =>
                reject(
                  new DOMException("The operation was aborted.", "AbortError"),
                ),
              { once: true },
            );
          }),
      };
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [],
      });
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway,
        model: "test-model",
        stepTimeoutMs: 20,
      });
      const { runId } = newRunningTurn(repo, T0);
      await expect(strategy(ctxFor(repo, runId))).rejects.toMatchObject({
        errorCode: "execution_failed",
      });
      expect(repo.listModelCalls(runId)[0]).toMatchObject({
        outcome: "timeout",
        errorCode: "model_step_timeout",
      });
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
