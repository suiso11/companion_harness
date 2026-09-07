// AgentStrategy audit for ordinary vs answer normalization (r3946441628).
//
// Strategy error mapping matrix (exactly one model_calls row + one coherent
// model.step.* event per step, no raw name/args/body/error persistence,
// at most one answer repair):
// - ordinary-only tool_call_invalid -> failed/model_unavailable, no repair
// - ordinary-only invalid_response -> failed/model_unavailable, no repair
// - mixed-batch ordinary failure (tool_call_invalid) -> failed/model_unavailable, no repair
// - answer-only answer_invalid -> failed/answer_invalid + one-time repair
import type {
  ChatRequest,
  ChatResult,
  ModelGateway,
  NormalizedToolCall,
} from "@companion/model-local";
import { ModelLocalError } from "@companion/model-local";
import { describe, expect, it } from "vitest";
import {
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
const SECRET = "ordinary-strategy-secret-xyz-999";

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

function toolCallInvalid(): ModelLocalError {
  return new ModelLocalError(
    "tool_call_invalid",
    "model returned an invalid tool call",
  );
}

function invalidResponse(): ModelLocalError {
  return new ModelLocalError(
    "invalid_response",
    "model returned an invalid response",
  );
}

function answerInvalid(): ModelLocalError {
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

function answered(toolCalls: NormalizedToolCall[]): ChatResult {
  return {
    text: "",
    toolCalls,
    stopReason: toolCalls.length > 0 ? "tool_calls" : "stop",
  };
}

describe("ordinary vs answer normalization audit", () => {
  it("ordinary-only tool_call_invalid audits model_unavailable with no repair", async () => {
    const { handle, repo } = await setup();
    try {
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [],
      });
      const { gateway, calls } = scriptGateway([
        toolCallInvalid(),
        answered([
          {
            id: "answer-late",
            name: "answer.submit",
            arguments: { version: 1, parts: [{ text: "late", citations: [] }] },
          },
        ]),
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
        errorCode: "execution_failed",
      });
      // Exactly one step consumed: no answer repair for ordinary failures.
      expect(calls).toHaveLength(1);
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
      expect(events.filter((e) => e.type === "model.step.completed")).toHaveLength(
        0,
      );
      expect(JSON.stringify({ rows, events })).not.toContain(SECRET);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("ordinary-only invalid_response audits model_unavailable with no repair", async () => {
    const { handle, repo } = await setup();
    try {
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [],
      });
      const { gateway, calls } = scriptGateway([invalidResponse()]);
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
      expect(calls).toHaveLength(1);
      const rows = repo.listModelCalls(runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        step: 1,
        outcome: "failed",
        errorCode: "model_unavailable",
      });
      const events = stepEvents(repo, sessionId, runId);
      expect(
        events.find((e) => e.type === "model.step.failed")?.payload,
      ).toMatchObject({ step: 1, errorCode: "model_unavailable" });
      expect(JSON.stringify({ rows, events })).not.toContain(SECRET);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("mixed-batch ordinary failure audits model_unavailable with no repair", async () => {
    const { handle, repo } = await setup();
    try {
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [],
      });
      // Mixed provider batch (one valid ordinary + one malformed ordinary)
      // normalizes to the ordinary failure leg: strategy must not repair it
      // as an answer.
      const { gateway, calls } = scriptGateway([toolCallInvalid()]);
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
      expect(calls).toHaveLength(1);
      const rows = repo.listModelCalls(runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        step: 1,
        outcome: "failed",
        errorCode: "model_unavailable",
      });
      expect(rows[0]?.errorCode).not.toBe("answer_invalid");
      const events = stepEvents(repo, sessionId, runId);
      expect(
        events.find((e) => e.type === "model.step.failed")?.payload,
      ).toMatchObject({ step: 1, errorCode: "model_unavailable" });
      // No repair hint issued for the ordinary leg.
      expect(calls).toHaveLength(1);
      expect(JSON.stringify({ rows, events })).not.toContain(SECRET);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("answer-only answer_invalid audits answer_invalid and repairs once", async () => {
    const { handle, repo } = await setup();
    try {
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [],
      });
      const { gateway, calls } = scriptGateway([
        answerInvalid(),
        answered([
          {
            id: "answer-ok",
            name: "answer.submit",
            arguments: {
              version: 1,
              parts: [{ text: "recovered", citations: [] }],
            },
          },
        ]),
      ]);
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway,
        model: "m",
      });
      const { sessionId, runId } = newRunningTurn(repo, T0);
      await expect(strategy(ctxFor(repo, runId))).resolves.toMatchObject({
        version: 2,
        text: "recovered",
      });
      // One repair maximum: exactly two steps.
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
      const hint = calls[1]?.messages.find(
        (m) => m.role === "user" && m.content.includes("Repair instruction:"),
      );
      expect(hint?.content).toContain(AGENT_REPAIR_HINTS.answer_invalid);
      expect(JSON.stringify({ rows, events, calls })).not.toContain(SECRET);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
