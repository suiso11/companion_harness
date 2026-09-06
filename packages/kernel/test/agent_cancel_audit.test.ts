// M2 cancelled-step audit coherence (r3943625951): user/engine cancellation
// records model_calls outcome=cancelled with errorCode null and emits NO
// model.step.failed/model_unavailable event (the closed M2 error family has
// no cancellation code; the RunEngine alone owns the terminal lifecycle).
// Timeout stays timeout/model_step_timeout + failed event; transport failure
// stays failed/model_unavailable + failed event. Exactly one model_calls row
// per started generateTurn; never a contradictory completed+failed pair.
import type {
  ChatRequest,
  ChatResult,
  ModelGateway,
} from "@companion/model-local";
import { ModelLocalError } from "@companion/model-local";
import { describe, expect, it } from "vitest";
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

function stepEvents(repo: KernelRepository, sessionId: string, runId: string) {
  return repo
    .getEvents(sessionId, runId, {})
    .events.filter((e) => e.type.startsWith("model.step."));
}

function hangingGateway(seen: { aborted?: boolean }): ModelGateway {
  return {
    provider: "ollama",
    capabilities: { toolCalling: true },
    baseUrl: "http://127.0.0.1:11434",
    chatUrl: "http://127.0.0.1:11434/api/chat",
    chat: (_request: ChatRequest, options?: { signal?: AbortSignal }) =>
      new Promise<ChatResult>((_resolve, reject) => {
        options?.signal?.addEventListener(
          "abort",
          () => {
            seen.aborted = true;
            reject(
              new DOMException("The operation was aborted.", "AbortError"),
            );
          },
          { once: true },
        );
      }),
  };
}

describe("cancelled vs timeout vs unavailable audit matrix", () => {
  it("engine cancellation audits cancelled/null with no failed event", async () => {
    const { handle, repo } = await setup();
    try {
      const seen: { aborted?: boolean } = {};
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [],
      });
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway: hangingGateway(seen),
        model: "m",
        stepTimeoutMs: 120_000,
      });
      const { sessionId, runId } = newRunningTurn(repo, T0);
      const controller = new AbortController();
      const pending = strategy(ctxFor(repo, runId, controller.signal));
      await new Promise((resolve) => setTimeout(resolve, 5));
      controller.abort();
      await expect(pending).rejects.toMatchObject({
        errorCode: "execution_cancelled",
      });
      expect(seen.aborted).toBe(true);
      const rows = repo.listModelCalls(runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        step: 1,
        outcome: "cancelled",
        errorCode: null,
      });
      const events = stepEvents(repo, sessionId, runId);
      expect(
        events.filter((e) => e.type === "model.step.started"),
      ).toHaveLength(1);
      expect(
        events.filter((e) => e.type === "model.step.completed"),
      ).toHaveLength(0);
      expect(events.filter((e) => e.type === "model.step.failed")).toHaveLength(
        0,
      );
      expect(JSON.stringify({ rows, events })).not.toContain(
        "model_unavailable",
      );
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("late abort discards the non-cooperative result with one cancelled row", async () => {
    const { handle, repo } = await setup();
    try {
      let chatCalls = 0;
      const gateway: ModelGateway = {
        provider: "ollama",
        capabilities: { toolCalling: true },
        baseUrl: "http://127.0.0.1:11434",
        chatUrl: "http://127.0.0.1:11434/api/chat",
        // Ignores the abort signal and resolves late with a would-be answer.
        chat: async () => {
          chatCalls += 1;
          await new Promise((resolve) => setTimeout(resolve, 60));
          return {
            text: "",
            toolCalls: [
              {
                id: "late-answer",
                name: "answer.submit",
                arguments: {
                  version: 1,
                  parts: [{ text: "late", citations: [] }],
                },
              },
            ],
            stopReason: "tool_calls",
          };
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
        model: "m",
        stepTimeoutMs: 120_000,
      });
      const { sessionId, runId } = newRunningTurn(repo, T0);
      const controller = new AbortController();
      const pending = strategy(ctxFor(repo, runId, controller.signal));
      await new Promise((resolve) => setTimeout(resolve, 5));
      controller.abort();
      await expect(pending).rejects.toMatchObject({
        errorCode: "execution_cancelled",
      });
      // Let the late non-cooperative settlement land: no second row, no flip.
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(chatCalls).toBe(1);
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
      expect(JSON.stringify({ rows, events })).not.toContain(
        "model_unavailable",
      );
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("step timeout audits timeout/model_step_timeout with one failed event", async () => {
    const { handle, repo } = await setup();
    try {
      const seen: { aborted?: boolean } = {};
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [],
      });
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway: hangingGateway(seen),
        model: "m",
        stepTimeoutMs: 20,
      });
      const { sessionId, runId } = newRunningTurn(repo, T0);
      await expect(strategy(ctxFor(repo, runId))).rejects.toMatchObject({
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
      expect(events.filter((e) => e.type === "model.step.failed")).toHaveLength(
        1,
      );
      expect(
        events.find((e) => e.type === "model.step.failed")?.payload,
      ).toMatchObject({ step: 1, errorCode: "model_step_timeout" });
      expect(
        events.filter((e) => e.type === "model.step.completed"),
      ).toHaveLength(0);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("transport failure audits failed/model_unavailable with one failed event", async () => {
    const { handle, repo } = await setup();
    try {
      const gateway: ModelGateway = {
        provider: "ollama",
        capabilities: { toolCalling: true },
        baseUrl: "http://127.0.0.1:11434",
        chatUrl: "http://127.0.0.1:11434/api/chat",
        chat: async () => {
          throw new ModelLocalError("transport_error", "connection refused");
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
        model: "m",
      });
      const { sessionId, runId } = newRunningTurn(repo, T0);
      await expect(strategy(ctxFor(repo, runId))).rejects.toMatchObject({
        errorCode: "execution_failed",
      });
      const rows = repo.listModelCalls(runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        step: 1,
        outcome: "failed",
        errorCode: "model_unavailable",
      });
      const events = stepEvents(repo, sessionId, runId);
      expect(events.filter((e) => e.type === "model.step.failed")).toHaveLength(
        1,
      );
      expect(
        events.find((e) => e.type === "model.step.failed")?.payload,
      ).toMatchObject({ step: 1, errorCode: "model_unavailable" });
      expect(
        events.filter((e) => e.type === "model.step.completed"),
      ).toHaveLength(0);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
