// Custom-gateway ChatResult validation: duplicate native ids reject before
// execution (zero broker calls, fixed model_unavailable audit, no grants).
import type {
  ChatRequest,
  ChatResult,
  ModelGateway,
} from "@companion/model-local";
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

describe("custom-gateway result validation", () => {
  it("duplicate custom-gateway ids execute zero broker calls", async () => {
    const { handle, repo } = await setup();
    try {
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [],
      });
      let brokerCalls = 0;
      const inner = broker.invoke.bind(broker);
      broker.invoke = (async (...args: Parameters<typeof inner>) => {
        brokerCalls += 1;
        return inner(...args);
      }) as typeof broker.invoke;
      const duplicate: ChatResult = {
        text: "",
        toolCalls: [
          { id: "dup-1", name: "markdown.search", arguments: { query: "hi" } },
          { id: "dup-1", name: "markdown.search", arguments: { query: "hi" } },
        ],
        stopReason: "tool_calls",
      };
      const calls: ChatRequest[] = [];
      const gateway: ModelGateway = {
        provider: "openai-compatible",
        capabilities: { toolCalling: true },
        baseUrl: "http://127.0.0.1:11434",
        chatUrl: "http://127.0.0.1:11434/v1/chat/completions",
        chat: async (request: ChatRequest): Promise<ChatResult> => {
          calls.push(request);
          return duplicate;
        },
      };
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway,
        model: "m",
      });
      const sessionId = repo.createSession({
        key: crypto.randomUUID(),
        now: T0,
      }).body.sessionId;
      const posted = repo.postMessage(
        sessionId,
        { text: "q" },
        { key: crypto.randomUUID(), now: T0 },
      );
      const runId = posted.body.run.id;
      repo.startRun(runId, { now: T0 + 1 });
      await expect(strategy(ctxFor(repo, runId))).rejects.toMatchObject({
        errorCode: "execution_failed",
      });
      expect(calls).toHaveLength(1);
      expect(brokerCalls).toBe(0);
      const rows = repo.listModelCalls(runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        step: 1,
        outcome: "failed",
        errorCode: "model_unavailable",
      });
      expect(repo.listEvidenceGrants(runId)).toHaveLength(0);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("stateful result getters never execute a second value", async () => {
    const { handle, repo } = await setup();
    try {
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [],
      });
      let brokerCalls = 0;
      const seenQueries: unknown[] = [];
      const inner = broker.invoke.bind(broker);
      broker.invoke = (async (...args: Parameters<typeof inner>) => {
        brokerCalls += 1;
        seenQueries.push((args[2] as { query?: unknown })?.query);
        return inner(...args);
      }) as typeof broker.invoke;
      let textReads = 0;
      let toolCallsReads = 0;
      const duplicateFirst = [
        { id: "dup-1", name: "markdown.search", arguments: { query: "hi" } },
        { id: "dup-1", name: "markdown.search", arguments: { query: "hi" } },
      ];
      const evilSecond = [
        {
          id: "evil-1",
          name: "markdown.search",
          arguments: { query: "evil-second-read" },
        },
      ];
      const hostile = {} as Record<string, unknown>;
      Object.defineProperty(hostile, "text", {
        enumerable: true,
        configurable: true,
        get() {
          textReads += 1;
          return textReads === 1 ? "" : "evil-second-text";
        },
      });
      Object.defineProperty(hostile, "stopReason", {
        enumerable: true,
        configurable: true,
        value: "tool_calls",
        writable: true,
      });
      Object.defineProperty(hostile, "toolCalls", {
        enumerable: true,
        configurable: true,
        get() {
          toolCallsReads += 1;
          return toolCallsReads === 1 ? duplicateFirst : evilSecond;
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
      const sessionId = repo.createSession({
        key: crypto.randomUUID(),
        now: T0,
      }).body.sessionId;
      const posted = repo.postMessage(
        sessionId,
        { text: "q" },
        { key: crypto.randomUUID(), now: T0 },
      );
      const runId = posted.body.run.id;
      repo.startRun(runId, { now: T0 + 1 });
      await expect(strategy(ctxFor(repo, runId))).rejects.toMatchObject({
        errorCode: "execution_failed",
      });
      // Malformed snapshot executes/grants nothing: the evil second value is
      // never executed (zero broker calls, never seen as broker input).
      expect(brokerCalls).toBe(0);
      expect(seenQueries).not.toContain("evil-second-read");
      expect(textReads).toBeLessThanOrEqual(1);
      expect(toolCallsReads).toBeLessThanOrEqual(1);
      expect(repo.listEvidenceGrants(runId)).toHaveLength(0);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
