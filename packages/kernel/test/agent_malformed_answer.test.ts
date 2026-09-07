// Malformed native answer.submit repair (r3944753213): gateway
// answer_invalid audits failed/answer_invalid and enters the one-time repair
// path without replaying the invalid assistant message; a second malformed
// answer fails fixed answer_invalid within budget; ordinary malformed calls
// never gain answer repair.
import type {
  ChatRequest,
  ChatResult,
  ModelGateway,
  NormalizedToolCall,
} from "@companion/model-local";
import { ModelLocalError } from "@companion/model-local";
import { describe, expect, it } from "vitest";
import {
  AGENT_MAX_STEPS,
  AGENT_REPAIR_HINTS,
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
const SECRET = "malformed-answer-secret-xyz-999";

function toolCall(
  name: string,
  args: unknown = {},
  id?: string,
): NormalizedToolCall {
  return {
    id: id ?? `call-${Math.random().toString(36).slice(2)}`,
    name,
    arguments: args,
  };
}

function answerCall(
  parts = [{ text: "final", citations: [] as string[] }],
  id = "answer-1",
): NormalizedToolCall {
  return toolCall("answer.submit", { version: 1, parts }, id);
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
    provider: "openai-compatible",
    capabilities: { toolCalling: true },
    baseUrl: "http://127.0.0.1:11434",
    chatUrl: "http://127.0.0.1:11434/v1/chat/completions",
    chat: async (request: ChatRequest): Promise<ChatResult> => {
      calls.push(request);
      const next = script[Math.min(calls.length - 1, script.length - 1)];
      if (next instanceof Error) throw next;
      return next as ChatResult;
    },
  };
  return { gateway, calls };
}

function answerInvalidError(): ModelLocalError {
  return new ModelLocalError(
    "answer_invalid",
    "model returned an invalid answer",
  );
}

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
    { text: "q" },
    { key: crypto.randomUUID(), now },
  );
  const runId = posted.body.run.id;
  repo.startRun(runId, { now: now + 1 });
  return { sessionId, runId };
}

function stepEvents(repo: KernelRepository, sessionId: string, runId: string) {
  return repo
    .getEvents(sessionId, runId, {})
    .events.filter((e) => e.type.startsWith("model.step."));
}

describe("malformed answer.submit repair", () => {
  it("first malformed answer audits answer_invalid and repairs to completed", async () => {
    const { handle, repo } = await setup();
    try {
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [],
      });
      const { gateway, calls } = scriptGateway([
        answerInvalidError(),
        chatResult([answerCall([{ text: "recovered", citations: [] }])]),
      ]);
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway,
        model: "m",
      });
      const { sessionId, runId } = newRunningTurn(repo, T0);
      await expect(strategy(ctxFor(repo, runId))).resolves.toEqual({
        version: 2,
        text: "recovered",
        answer: {
          version: 1,
          parts: [{ text: "recovered", citations: [] }],
        },
      });
      expect(calls).toHaveLength(2);
      const rows = repo.listModelCalls(runId);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        step: 1,
        outcome: "failed",
        errorCode: "answer_invalid",
      });
      expect(rows[1]).toMatchObject({
        step: 2,
        outcome: "completed",
        errorCode: null,
      });
      const events = stepEvents(repo, sessionId, runId);
      expect(
        events.find(
          (e) =>
            e.type === "model.step.failed" &&
            (e.payload as { step: number }).step === 1,
        )?.payload,
      ).toMatchObject({ step: 1, errorCode: "answer_invalid" });
      // No invalid assistant replay: second request carries no toolCalls
      // assistant message and only the fixed repair hint, with no raw leak.
      const replayed = calls[1]?.messages ?? [];
      expect(
        replayed.filter(
          (m) => m.role === "assistant" && m.toolCalls !== undefined,
        ),
      ).toHaveLength(0);
      const hint = replayed.find(
        (m) => m.role === "user" && m.content.includes("Repair instruction:"),
      );
      expect(hint?.content).toContain(AGENT_REPAIR_HINTS.answer_invalid);
      expect(JSON.stringify({ rows, events, calls })).not.toContain(SECRET);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("second malformed answer fails answer_invalid within budget (never ninth call)", async () => {
    const { handle, repo } = await setup();
    try {
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [],
      });
      const { gateway, calls } = scriptGateway([
        answerInvalidError(),
        answerInvalidError(),
      ]);
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway,
        model: "m",
      });
      const { sessionId, runId } = newRunningTurn(repo, T0);
      await expect(strategy(ctxFor(repo, runId))).rejects.toMatchObject({
        errorCode: "output_invalid",
      });
      expect(calls).toHaveLength(2);
      expect(calls.length).toBeLessThanOrEqual(AGENT_MAX_STEPS);
      const rows = repo.listModelCalls(runId);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        step: 1,
        outcome: "failed",
        errorCode: "answer_invalid",
      });
      expect(rows[1]).toMatchObject({
        step: 2,
        outcome: "failed",
        errorCode: "answer_invalid",
      });
      const events = stepEvents(repo, sessionId, runId);
      expect(events.filter((e) => e.type === "model.step.failed")).toHaveLength(
        2,
      );
      expect(
        events.filter((e) => e.type === "model.step.completed"),
      ).toHaveLength(0);
      void sessionId;
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("ordinary malformed tool call does not gain answer repair", async () => {
    const { handle, repo } = await setup();
    try {
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [],
      });
      const ordinaryInvalid = new ModelLocalError(
        "tool_call_invalid",
        "model returned an invalid tool call",
      );
      const { gateway, calls } = scriptGateway([
        ordinaryInvalid,
        chatResult([answerCall([{ text: "late", citations: [] }])]),
      ]);
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway,
        model: "m",
      });
      const { runId } = newRunningTurn(repo, T0);
      await expect(strategy(ctxFor(repo, runId))).rejects.toMatchObject({
        errorCode: "execution_failed",
      });
      // No repair: exactly one generateTurn call consumed.
      expect(calls).toHaveLength(1);
      const rows = repo.listModelCalls(runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        step: 1,
        outcome: "failed",
        errorCode: "answer_invalid",
      });
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("ordinary oversize stays model_unavailable without repair", async () => {
    const { handle, repo } = await setup();
    try {
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [],
      });
      const oversize = new ModelLocalError(
        "invalid_response",
        "model returned an invalid response",
      );
      const { gateway, calls } = scriptGateway([oversize]);
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway,
        model: "m",
      });
      const { runId } = newRunningTurn(repo, T0);
      await expect(strategy(ctxFor(repo, runId))).rejects.toMatchObject({
        errorCode: "execution_failed",
      });
      expect(calls).toHaveLength(1);
      expect(repo.listModelCalls(runId)[0]).toMatchObject({
        step: 1,
        outcome: "failed",
        errorCode: "model_unavailable",
      });
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
