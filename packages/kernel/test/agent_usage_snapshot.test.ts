// Usage snapshot preservation (r3950938866): validateChatResult captures
// optional usage exactly once (no getters), validates token counts only, and
// AgentStrategy sanitizes/persists/emits the validated snapshot into
// model_calls + model.step.completed. Invalid/stateful usage fails before
// success audit.
import type {
  ChatRequest,
  ChatResult,
  FetchImpl,
  ModelGateway,
} from "@companion/model-local";
import { createOllamaGateway } from "@companion/model-local";
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

function ctxFor(repo: KernelRepository, runId: string) {
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
    new AbortController().signal,
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
    { text: "summarize" },
    { key: crypto.randomUUID(), now },
  );
  const runId = posted.body.run.id;
  repo.startRun(runId, { now: now + 1 });
  return { sessionId, runId };
}

function answerResult(usage: ChatResult["usage"], id = "answer-1"): ChatResult {
  const result: ChatResult = {
    text: "",
    toolCalls: [
      {
        id,
        name: "answer.submit",
        arguments: { version: 1, parts: [{ text: "done", citations: [] }] },
      },
    ],
    stopReason: "tool_calls",
  };
  if (usage !== undefined) {
    (result as { usage?: unknown }).usage = usage;
  }
  return result;
}

function stepEvents(repo: KernelRepository, sessionId: string, runId: string) {
  return repo
    .getEvents(sessionId, runId, {})
    .events.filter((e) => e.type.startsWith("model.step."));
}

function customGateway(result: ChatResult): ModelGateway {
  return {
    provider: "openai-compatible",
    capabilities: { toolCalling: true },
    baseUrl: "http://127.0.0.1:11434",
    chatUrl: "http://127.0.0.1:11434/v1/chat/completions",
    chat: async (_request: ChatRequest): Promise<ChatResult> => result,
  };
}

describe("usage snapshot preservation (r3950938866)", () => {
  it("custom gateway usage survives snapshot into model_calls and completed (detached)", async () => {
    const { handle, repo } = await setup();
    try {
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [],
      });
      const sourceUsage = { inputTokens: 12, outputTokens: 34 };
      const gateway = customGateway(answerResult(sourceUsage));
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway,
        model: "m",
      });
      const { sessionId, runId } = newRunningTurn(repo, T0);
      await strategy(ctxFor(repo, runId));
      const rows = repo.listModelCalls(runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        step: 1,
        outcome: "completed",
        errorCode: null,
        usage: { inputTokens: 12, outputTokens: 34 },
      });
      // Detached: persisted usage shares no reference with the source object.
      expect(rows[0]?.usage).not.toBe(sourceUsage);
      const events = stepEvents(repo, sessionId, runId);
      const completed = events.filter((e) => e.type === "model.step.completed");
      expect(completed).toHaveLength(1);
      expect(completed[0]?.payload).toMatchObject({
        step: 1,
        usage: { inputTokens: 12, outputTokens: 34 },
      });
      // Late mutation of the source cannot change what was validated.
      sourceUsage.inputTokens = 9999;
      expect(repo.listModelCalls(runId)[0]?.usage).toEqual({
        inputTokens: 12,
        outputTokens: 34,
      });
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("built-in ollama adapter usage survives snapshot into model_calls and completed", async () => {
    const { handle, repo } = await setup();
    try {
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [],
      });
      const body = {
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "a-1",
              function: {
                name: "answer.submit",
                arguments: {
                  version: 1,
                  parts: [{ text: "done", citations: [] }],
                },
              },
            },
          ],
        },
        done_reason: "stop",
        prompt_eval_count: 7,
        eval_count: 9,
      };
      const fetchImpl: FetchImpl = async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      const gateway = createOllamaGateway({
        baseUrl: "http://127.0.0.1:11434",
        fetchImpl,
      });
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway,
        model: "m",
      });
      const { sessionId, runId } = newRunningTurn(repo, T0);
      await strategy(ctxFor(repo, runId));
      const rows = repo.listModelCalls(runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        step: 1,
        outcome: "completed",
        errorCode: null,
        usage: { inputTokens: 7, outputTokens: 9 },
      });
      const events = stepEvents(repo, sessionId, runId);
      const completed = events.filter((e) => e.type === "model.step.completed");
      expect(completed).toHaveLength(1);
      expect(completed[0]?.payload).toMatchObject({
        step: 1,
        usage: { inputTokens: 7, outputTokens: 9 },
      });
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it.each([
    ["negative", { inputTokens: -1, outputTokens: 2 }],
    ["fraction", { inputTokens: 1.5, outputTokens: 2 }],
    ["string", { inputTokens: "12", outputTokens: 34 }],
    ["missing-output", { inputTokens: 12 }],
    ["extra-field", { inputTokens: 12, outputTokens: 34, total_tokens: 46 }],
    ["raw-blob", { inputTokens: 12, outputTokens: 34, raw: "x" }],
    ["reasoning", { inputTokens: 12, outputTokens: 34, reasoning: "r" }],
  ])(
    "invalid custom usage %s fails before success audit",
    async (_label, usage) => {
      const { handle, repo } = await setup();
      try {
        const broker = createToolBroker({
          db: handle.raw,
          repo,
          registrations: [],
        });
        const gateway = customGateway(
          answerResult(usage as ChatResult["usage"]),
        );
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
        expect(
          events.filter((e) => e.type === "model.step.completed"),
        ).toHaveLength(0);
        expect(
          events.filter((e) => e.type === "model.step.failed"),
        ).toHaveLength(1);
      } finally {
        closeKernelDatabase(handle);
      }
    },
  );

  it("stateful usage getter fails before success audit without a second read", async () => {
    const { handle, repo } = await setup();
    try {
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [],
      });
      let usageReads = 0;
      const hostile = {
        text: "",
        toolCalls: [
          {
            id: "answer-1",
            name: "answer.submit",
            arguments: { version: 1, parts: [{ text: "done", citations: [] }] },
          },
        ],
        stopReason: "tool_calls",
      } as Record<string, unknown>;
      Object.defineProperty(hostile, "usage", {
        enumerable: true,
        configurable: true,
        get() {
          usageReads += 1;
          return usageReads === 1
            ? { inputTokens: 12, outputTokens: 34 }
            : { inputTokens: 9999, outputTokens: 9999 };
        },
      });
      const gateway: ModelGateway = {
        provider: "openai-compatible",
        capabilities: { toolCalling: true },
        baseUrl: "http://127.0.0.1:11434",
        chatUrl: "http://127.0.0.1:11434/v1/chat/completions",
        chat: async (): Promise<ChatResult> => hostile as unknown as ChatResult,
      };
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
      // Top-level accessor rejects without invoking a second value.
      expect(usageReads).toBeLessThanOrEqual(1);
      const rows = repo.listModelCalls(runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        outcome: "failed",
        errorCode: "model_unavailable",
      });
      const events = stepEvents(repo, sessionId, runId);
      expect(
        events.filter((e) => e.type === "model.step.completed"),
      ).toHaveLength(0);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
