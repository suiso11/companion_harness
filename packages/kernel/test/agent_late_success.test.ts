// Late-success race (r3946441626): a non-cooperative gateway that ignores
// its AbortSignal and resolves at/after a deadline must not complete the
// Run past budget. After gateway.chat resolves, the step rechecks the
// composed step timeout, the 300s wall deadline, and engine cancellation
// against authoritative state before the result can succeed or reach
// answer.submit classification. Deterministic: in-memory DBs, deferred
// (manually-resolved) gateways, injectable fake clocks, real timers (the
// 120s/300s race timers never fire; only the recheck decides). No network.

import type {
  ChatRequest,
  ChatResult,
  ModelGateway,
  NormalizedToolCall,
} from "@companion/model-local";
import { describe, expect, it } from "vitest";
import {
  AGENT_STEP_TIMEOUT_MS,
  AGENT_WALL_MS,
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

/** Non-cooperative gateway: ignores the signal, resolves only when released. */
function deferredGateway(release: {
  resolve: ((value: ChatResult) => void) | null;
}): ModelGateway {
  return {
    provider: "ollama",
    capabilities: { toolCalling: true },
    baseUrl: "http://127.0.0.1:11434",
    chatUrl: "http://127.0.0.1:11434/api/chat",
    chat: (_request: ChatRequest): Promise<ChatResult> =>
      new Promise<ChatResult>((resolve) => {
        release.resolve = resolve;
      }),
  };
}

function stepEvents(repo: KernelRepository, sessionId: string, runId: string) {
  return repo
    .getEvents(sessionId, runId, {})
    .events.filter((e) => e.type.startsWith("model.step."));
}

/** Let the strategy run synchronously up to the deferred gateway.chat. */
async function flushToGateway(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

describe("late gateway success race", () => {
  it("discards a non-cooperative success resolving exactly at the 120s step deadline", async () => {
    expect(AGENT_STEP_TIMEOUT_MS).toBe(120_000);
    const { handle, repo } = await setup();
    try {
      let now = T0;
      const clock = { now: () => now };
      const release: {
        resolve: ((value: ChatResult) => void) | null;
      } = { resolve: null };
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [],
      });
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway: deferredGateway(release),
        model: "m",
        clock,
      });
      const { sessionId, runId } = newRunningTurn(repo, T0);
      const pending = strategy(ctxFor(repo, runId));
      await flushToGateway();
      expect(release.resolve).not.toBeNull();
      // Exact boundary is past budget (fail-closed): the real 120s race
      // timer has not fired, so only the authoritative recheck discards.
      now = T0 + AGENT_STEP_TIMEOUT_MS;
      (release.resolve as (value: ChatResult) => void)(answerResult());
      await expect(pending).rejects.toMatchObject({
        name: "StrategyError",
        errorCode: "execution_failed",
      });
      const rows = repo.listModelCalls(runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        step: 1,
        outcome: "timeout",
        errorCode: "model_step_timeout",
      });
      const events = stepEvents(repo, sessionId, runId);
      expect(
        events.filter((e) => e.type === "model.step.completed"),
      ).toHaveLength(0);
      expect(events.filter((e) => e.type === "model.step.failed")).toHaveLength(
        1,
      );
      // The Run never completes past budget; the strategy writes no lifecycle.
      expect(repo.getRun(runId).status).toBe("running");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("discards a non-cooperative success resolving exactly at the 300s wall deadline", async () => {
    expect(AGENT_WALL_MS).toBe(300_000);
    const { handle, repo } = await setup();
    try {
      let now = T0;
      const clock = { now: () => now };
      const release: {
        resolve: ((value: ChatResult) => void) | null;
      } = { resolve: null };
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [],
      });
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway: deferredGateway(release),
        model: "m",
        clock,
        // Oversized step budget isolates the wall: only the wall recheck
        // can discard this result.
        stepTimeoutMs: 600_000,
      });
      const { sessionId, runId } = newRunningTurn(repo, T0);
      const pending = strategy(ctxFor(repo, runId));
      await flushToGateway();
      expect(release.resolve).not.toBeNull();
      now = T0 + AGENT_WALL_MS;
      (release.resolve as (value: ChatResult) => void)(answerResult());
      await expect(pending).rejects.toMatchObject({
        name: "StrategyError",
        errorCode: "execution_failed",
      });
      const rows = repo.listModelCalls(runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        step: 1,
        outcome: "timeout",
        errorCode: "model_step_timeout",
      });
      const events = stepEvents(repo, sessionId, runId);
      expect(
        events.filter((e) => e.type === "model.step.completed"),
      ).toHaveLength(0);
      expect(events.filter((e) => e.type === "model.step.failed")).toHaveLength(
        1,
      );
      expect(repo.getRun(runId).status).toBe("running");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("completes a valid success resolving just before the step deadline", async () => {
    const { handle, repo } = await setup();
    try {
      let now = T0;
      const clock = { now: () => now };
      const release: {
        resolve: ((value: ChatResult) => void) | null;
      } = { resolve: null };
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [],
      });
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway: deferredGateway(release),
        model: "m",
        clock,
      });
      const { sessionId, runId } = newRunningTurn(repo, T0);
      const pending = strategy(ctxFor(repo, runId));
      await flushToGateway();
      expect(release.resolve).not.toBeNull();
      now = T0 + AGENT_STEP_TIMEOUT_MS - 1;
      (release.resolve as (value: ChatResult) => void)(answerResult());
      await expect(pending).resolves.toEqual({
        version: 2,
        text: "final",
        answer: { version: 1, parts: [{ text: "final", citations: [] }] },
      });
      const rows = repo.listModelCalls(runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        step: 1,
        outcome: "completed",
        errorCode: null,
      });
      const events = stepEvents(repo, sessionId, runId);
      expect(
        events.filter((e) => e.type === "model.step.completed"),
      ).toHaveLength(1);
      expect(events.filter((e) => e.type === "model.step.failed")).toHaveLength(
        0,
      );
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("engine abort discards a late success as cancelled even past the step deadline", async () => {
    const { handle, repo } = await setup();
    try {
      let now = T0;
      const clock = { now: () => now };
      const release: {
        resolve: ((value: ChatResult) => void) | null;
      } = { resolve: null };
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [],
      });
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway: deferredGateway(release),
        model: "m",
        clock,
      });
      const { sessionId, runId } = newRunningTurn(repo, T0);
      const controller = new AbortController();
      const pending = strategy(ctxFor(repo, runId, controller.signal));
      await flushToGateway();
      expect(release.resolve).not.toBeNull();
      // Cancellation wins over the also-expired step deadline: the late
      // answer must audit cancelled (never timeout, never completed).
      controller.abort();
      now = T0 + AGENT_STEP_TIMEOUT_MS + 1000;
      (release.resolve as (value: ChatResult) => void)(answerResult());
      await expect(pending).rejects.toMatchObject({
        name: "StrategyError",
        errorCode: "execution_cancelled",
      });
      const rows = repo.listModelCalls(runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        step: 1,
        outcome: "cancelled",
        errorCode: null,
      });
      const events = stepEvents(repo, sessionId, runId);
      expect(events.filter((e) => e.type === "model.step.failed")).toHaveLength(
        0,
      );
      expect(
        events.filter((e) => e.type === "model.step.completed"),
      ).toHaveLength(0);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("a committed engine cancel wins over timeout for a late success", async () => {
    const { handle, repo } = await setup();
    try {
      let now = T0;
      const clock = { now: () => now };
      const release: {
        resolve: ((value: ChatResult) => void) | null;
      } = { resolve: null };
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [],
      });
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway: deferredGateway(release),
        model: "m",
        clock,
      });
      const { sessionId, runId } = newRunningTurn(repo, T0);
      // No signal abort here: the RunEngine committed cancellation first
      // (cancel_requested), so the Run is no longer running. RunEngine
      // ownership wins even though the step deadline also expired.
      const pending = strategy(ctxFor(repo, runId));
      await flushToGateway();
      expect(release.resolve).not.toBeNull();
      repo.cancelRun(sessionId, runId, { now });
      now = T0 + AGENT_STEP_TIMEOUT_MS + 1000;
      (release.resolve as (value: ChatResult) => void)(answerResult());
      await expect(pending).rejects.toMatchObject({
        name: "StrategyError",
        errorCode: "execution_cancelled",
      });
      const rows = repo.listModelCalls(runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        step: 1,
        outcome: "cancelled",
        errorCode: null,
      });
      const events = stepEvents(repo, sessionId, runId);
      expect(events.filter((e) => e.type === "model.step.failed")).toHaveLength(
        0,
      );
      expect(
        events.filter((e) => e.type === "model.step.completed"),
      ).toHaveLength(0);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

describe("post-validation deadline (r3950636369)", () => {
  // Synchronous validateChatResult consumes real budget, so a snapshot that
  // was in-time at gateway resolve may be past budget when validation
  // returns. The step re-runs the authoritative late-success gate immediately
  // after validation returns, before success audit, classifyStep, answer
  // acceptance, broker execution, or evidence grants. Deterministic: the
  // custom gateway returns a Proxy-wrapped ChatResult whose first validation
  // descriptor read advances (or aborts) the fake clock mid-validation, so
  // pre-validation rechecks pass while the post-validation recheck decides.
  function validationTimebomb(
    base: ChatResult,
    onValidate: () => void,
  ): ChatResult {
    let fired = false;
    return new Proxy(base, {
      getOwnPropertyDescriptor(target, prop) {
        if (
          !fired &&
          (prop === "text" || prop === "stopReason" || prop === "toolCalls")
        ) {
          fired = true;
          onValidate();
        }
        return Reflect.getOwnPropertyDescriptor(target, prop);
      },
    });
  }

  it("discards a snapshot whose validation crosses the 120s step deadline", async () => {
    expect(AGENT_STEP_TIMEOUT_MS).toBe(120_000);
    const { handle, repo } = await setup();
    try {
      let now = T0;
      const clock = { now: () => now };
      const release: {
        resolve: ((value: ChatResult) => void) | null;
      } = { resolve: null };
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [],
      });
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway: deferredGateway(release),
        model: "m",
        clock,
      });
      const { sessionId, runId } = newRunningTurn(repo, T0);
      const pending = strategy(ctxFor(repo, runId));
      await flushToGateway();
      expect(release.resolve).not.toBeNull();
      // In-time at gateway resolve; validation consumes the remaining time
      // and lands exactly on the step boundary (fail-closed).
      const bomb = validationTimebomb(answerResult(), () => {
        now = T0 + AGENT_STEP_TIMEOUT_MS;
      });
      (release.resolve as (value: ChatResult) => void)(bomb);
      await expect(pending).rejects.toMatchObject({
        name: "StrategyError",
        errorCode: "execution_failed",
      });
      const rows = repo.listModelCalls(runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        step: 1,
        outcome: "timeout",
        errorCode: "model_step_timeout",
      });
      const events = stepEvents(repo, sessionId, runId);
      expect(
        events.filter((e) => e.type === "model.step.completed"),
      ).toHaveLength(0);
      expect(events.filter((e) => e.type === "model.step.failed")).toHaveLength(
        1,
      );
      expect(repo.getRun(runId).status).toBe("running");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("discards a snapshot whose validation crosses the 300s wall deadline", async () => {
    expect(AGENT_WALL_MS).toBe(300_000);
    const { handle, repo } = await setup();
    try {
      let now = T0;
      const clock = { now: () => now };
      const release: {
        resolve: ((value: ChatResult) => void) | null;
      } = { resolve: null };
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [],
      });
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway: deferredGateway(release),
        model: "m",
        clock,
        // Oversized step budget isolates the wall: only the wall recheck
        // can discard this snapshot.
        stepTimeoutMs: 600_000,
      });
      const { sessionId, runId } = newRunningTurn(repo, T0);
      const pending = strategy(ctxFor(repo, runId));
      await flushToGateway();
      expect(release.resolve).not.toBeNull();
      const bomb = validationTimebomb(answerResult(), () => {
        now = T0 + AGENT_WALL_MS;
      });
      (release.resolve as (value: ChatResult) => void)(bomb);
      await expect(pending).rejects.toMatchObject({
        name: "StrategyError",
        errorCode: "execution_failed",
      });
      const rows = repo.listModelCalls(runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        step: 1,
        outcome: "timeout",
        errorCode: "model_step_timeout",
      });
      const events = stepEvents(repo, sessionId, runId);
      expect(
        events.filter((e) => e.type === "model.step.completed"),
      ).toHaveLength(0);
      expect(events.filter((e) => e.type === "model.step.failed")).toHaveLength(
        1,
      );
      expect(repo.getRun(runId).status).toBe("running");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("accepts a snapshot whose validation stays just before the step deadline", async () => {
    const { handle, repo } = await setup();
    try {
      let now = T0;
      const clock = { now: () => now };
      const release: {
        resolve: ((value: ChatResult) => void) | null;
      } = { resolve: null };
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [],
      });
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway: deferredGateway(release),
        model: "m",
        clock,
      });
      const { sessionId, runId } = newRunningTurn(repo, T0);
      const pending = strategy(ctxFor(repo, runId));
      await flushToGateway();
      expect(release.resolve).not.toBeNull();
      // Validation consumes nearly all remaining time but lands 1ms inside
      // budget: the post-validation recheck must not false-positive.
      const bomb = validationTimebomb(answerResult(), () => {
        now = T0 + AGENT_STEP_TIMEOUT_MS - 1;
      });
      (release.resolve as (value: ChatResult) => void)(bomb);
      await expect(pending).resolves.toEqual({
        version: 2,
        text: "final",
        answer: { version: 1, parts: [{ text: "final", citations: [] }] },
      });
      const rows = repo.listModelCalls(runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        step: 1,
        outcome: "completed",
        errorCode: null,
      });
      const events = stepEvents(repo, sessionId, runId);
      expect(
        events.filter((e) => e.type === "model.step.completed"),
      ).toHaveLength(1);
      expect(events.filter((e) => e.type === "model.step.failed")).toHaveLength(
        0,
      );
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("engine abort during validation discards the snapshot as cancelled", async () => {
    const { handle, repo } = await setup();
    try {
      const now = T0;
      const clock = { now: () => now };
      const release: {
        resolve: ((value: ChatResult) => void) | null;
      } = { resolve: null };
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [],
      });
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway: deferredGateway(release),
        model: "m",
        clock,
      });
      const { sessionId, runId } = newRunningTurn(repo, T0);
      const controller = new AbortController();
      const pending = strategy(ctxFor(repo, runId, controller.signal));
      await flushToGateway();
      expect(release.resolve).not.toBeNull();
      // Cancellation lands mid-validation while still in budget: it must win
      // as cancelled (never timeout, never completed).
      const bomb = validationTimebomb(answerResult(), () => {
        controller.abort();
      });
      (release.resolve as (value: ChatResult) => void)(bomb);
      await expect(pending).rejects.toMatchObject({
        name: "StrategyError",
        errorCode: "execution_cancelled",
      });
      const rows = repo.listModelCalls(runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        step: 1,
        outcome: "cancelled",
        errorCode: null,
      });
      const events = stepEvents(repo, sessionId, runId);
      expect(events.filter((e) => e.type === "model.step.failed")).toHaveLength(
        0,
      );
      expect(
        events.filter((e) => e.type === "model.step.completed"),
      ).toHaveLength(0);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
