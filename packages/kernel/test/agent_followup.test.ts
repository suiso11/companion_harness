// M2 kernel gateway follow-up: assistant replay, usage audit, timeout mapping.
import type {
  ChatRequest,
  ChatResult,
  ModelGateway,
  NormalizedToolCall,
} from "@companion/model-local";
import { ModelLocalError } from "@companion/model-local";
import { describe, expect, it } from "vitest";
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
  type ToolBroker,
  type ToolRegistration,
} from "../src/index.js";

const T0 = 1790000000000;

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
function answerCall(
  parts = [{ text: "final", citations: [] as string[] }],
): NormalizedToolCall {
  return toolCall("answer.submit", { version: 1, parts }, "answer-1");
}
function chatResult(
  toolCalls: NormalizedToolCall[],
  text = "",
  usage?: ChatResult["usage"],
): ChatResult {
  return {
    text,
    toolCalls,
    stopReason: toolCalls.length > 0 ? "tool_calls" : "stop",
    ...(usage === undefined ? {} : { usage }),
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
function readReg(
  overrides?: Partial<ToolRegistration> & { name?: string },
): ToolRegistration {
  return {
    descriptor: {
      name: overrides?.name ?? "test.read",
      version: 1,
      title: "t",
      description: "d",
      category: "read",
      defaultTimeoutMs: 5000,
      maxTimeoutMs: 10000,
      supportsRefresh: true,
    },
    inputSchema: z.strictObject({ q: z.string().default("hi") }),
    outputSchema: z.strictObject({ text: z.string() }),
    handler: async (input: { q: string }) => ({ text: `out:${input.q}` }),
  };
}
function makeBroker(
  handle: ReturnType<typeof openKernelDatabase>,
  repo: KernelRepository,
): ToolBroker {
  return createToolBroker({ db: handle.raw, repo, registrations: [readReg()] });
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

describe("gateway follow-up: replay, usage, timeout", () => {
  it("preserves assistant toolCalls before tool results with order intact", async () => {
    const { handle, repo } = await setup();
    try {
      const broker = makeBroker(handle, repo);
      const ordinary = [
        toolCall("test.read", { q: "a" }, "c0"),
        toolCall("test.read", { q: "b" }, "c1"),
      ];
      const { gateway, calls } = scriptGateway([
        chatResult(ordinary, "helper text"),
        chatResult([answerCall([{ text: "done", citations: [] }])]),
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
        version: 1,
        text: "done",
      });
      expect(calls).toHaveLength(2);
      const replayed = calls[1]?.messages ?? [];
      const assistantIdx = replayed.findIndex(
        (m) =>
          m.role === "assistant" &&
          Array.isArray(m.toolCalls) &&
          m.toolCalls.length === 2,
      );
      const toolIdx = replayed.findIndex((m) => m.role === "tool");
      expect(assistantIdx).toBeGreaterThanOrEqual(0);
      expect(toolIdx).toBeGreaterThan(assistantIdx);
      const assistant = replayed[assistantIdx] as {
        content: string;
        toolCalls: NormalizedToolCall[];
      };
      expect(assistant.toolCalls.map((c) => c.id)).toEqual(["c0", "c1"]);
      // One role:tool message per call, in request order with matching ids.
      const tools = replayed.filter((m) => m.role === "tool");
      expect(tools.map((m) => m.toolCallId)).toEqual(["c0", "c1"]);
      const feedback = tools.map(
        (m) =>
          JSON.parse((m as { content: string }).content) as {
            output: { text: string };
          },
      );
      expect(feedback.map((e) => e.output.text)).toEqual(["out:a", "out:b"]);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("persists and emits usage token counts only, without raw text", async () => {
    const { handle, repo } = await setup();
    try {
      const broker = makeBroker(handle, repo);
      const { gateway } = scriptGateway([
        chatResult([answerCall([{ text: "hi", citations: [] }])], "", {
          inputTokens: 7,
          outputTokens: 9,
        }),
      ]);
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway,
        model: "m",
      });
      const { sessionId, runId } = newRunningTurn(repo, T0);
      await strategy(ctxFor(repo, runId));
      expect(repo.listModelCalls(runId)[0]).toMatchObject({
        outcome: "completed",
        usage: { inputTokens: 7, outputTokens: 9 },
      });
      const events = repo.getEvents(sessionId, runId, {});
      const completed = events.events.find(
        (e) => e.type === "model.step.completed",
      );
      expect(completed?.payload).toMatchObject({
        step: 1,
        usage: { inputTokens: 7, outputTokens: 9 },
      });
      expect(JSON.stringify(events.events)).not.toContain("hi");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("maps ModelLocalError timeout distinctly with no retry", async () => {
    const { handle, repo } = await setup();
    try {
      const broker = makeBroker(handle, repo);
      const { gateway, calls } = scriptGateway([
        new ModelLocalError("timeout", "model request timed out"),
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
      expect(calls).toHaveLength(1);
      expect(repo.listModelCalls(runId)[0]).toMatchObject({
        outcome: "timeout",
        errorCode: "model_step_timeout",
      });
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
