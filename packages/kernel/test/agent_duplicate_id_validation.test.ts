// Duplicate answer.submit ID repair validation: original IDs are validated
// per-call before deterministic remap (no raw IDs leak).
import type {
  ChatRequest,
  ChatResult,
  ModelGateway,
  NormalizedToolCall,
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

function answerCall(
  parts = [{ text: "final", citations: [] as string[] }],
  id = "answer-1",
): NormalizedToolCall {
  return { id, name: "answer.submit", arguments: { version: 1, parts } };
}

function chatResult(toolCalls: NormalizedToolCall[], text = ""): ChatResult {
  return {
    text,
    toolCalls,
    stopReason: toolCalls.length > 0 ? "tool_calls" : "stop",
  };
}

function scriptGateway(script: Array<ChatResult | Error>): {
  gateway: ModelGateway;
  calls: ChatRequest[];
} {
  const calls: ChatRequest[] = [];
  const gateway: ModelGateway = {
    provider: "ollama",
    capabilities: { toolCalling: true },
    baseUrl: "http://127.0.0.1:11434",
    chatUrl: "http://127.0.0.1:11434/api/chat",
    chat: async (request: ChatRequest): Promise<ChatResult> => {
      calls.push(request);
      const next = script[Math.min(calls.length - 1, script.length - 1)];
      if (next instanceof Error) throw next;
      return next as ChatResult;
    },
  };
  return { gateway, calls };
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
): { runId: string } {
  const sessionId = repo.createSession({ key: crypto.randomUUID(), now }).body
    .sessionId;
  const posted = repo.postMessage(
    sessionId,
    { text: "q" },
    { key: crypto.randomUUID(), now },
  );
  const runId = posted.body.run.id;
  repo.startRun(runId, { now: now + 1 });
  return { runId };
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

describe("duplicate answer.submit id validation before remap", () => {
  it("valid duplicate ids still repair once", async () => {
    const { handle, repo } = await setup();
    try {
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [],
      });
      const dup = [
        answerCall([{ text: "a", citations: [] }], "dup-same"),
        answerCall([{ text: "b", citations: [] }], "dup-same"),
      ];
      const { gateway, calls } = scriptGateway([
        chatResult(dup),
        chatResult([answerCall([{ text: "fixed", citations: [] }], "ok-1")]),
      ]);
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway,
        model: "m",
      });
      const { runId } = newRunningTurn(repo, T0);
      await expect(strategy(ctxFor(repo, runId))).resolves.toEqual({
        version: 2,
        text: "fixed",
        answer: { version: 1, parts: [{ text: "fixed", citations: [] }] },
      });
      expect(calls).toHaveLength(2);
      expect(
        handle.raw.prepare("SELECT COUNT(*) AS n FROM tool_calls").get(),
      ).toMatchObject({ n: 0 });
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("oversized duplicate ids fail as model_unavailable with no repair", async () => {
    const { handle, repo } = await setup();
    try {
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [],
      });
      const oversizedId = "x".repeat(300);
      const dup = [
        answerCall([{ text: "a", citations: [] }], oversizedId),
        answerCall([{ text: "b", citations: [] }], oversizedId),
      ];
      const { gateway, calls } = scriptGateway([chatResult(dup)]);
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway,
        model: "m",
      });
      const { runId } = newRunningTurn(repo, T0);
      const failure = await strategy(ctxFor(repo, runId)).catch(
        (error: unknown) => error,
      );
      expect(failure).toMatchObject({ errorCode: "execution_failed" });
      expect(String((failure as Error)?.message ?? "")).not.toContain(
        oversizedId,
      );
      // Atomic: no repair leg, nothing executed.
      expect(calls).toHaveLength(1);
      expect(
        handle.raw.prepare("SELECT COUNT(*) AS n FROM tool_calls").get(),
      ).toMatchObject({ n: 0 });
      expect(repo.listModelCalls(runId)).toHaveLength(1);
      expect(repo.listModelCalls(runId)[0]).toMatchObject({
        step: 1,
        outcome: "failed",
        errorCode: "model_unavailable",
      });
      const rows = handle.raw
        .prepare("SELECT type, payload FROM run_events WHERE run_id = ?")
        .all(runId) as Array<{ type: string; payload: string }>;
      expect(rows.some((row) => row.payload.includes(oversizedId))).toBe(false);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
