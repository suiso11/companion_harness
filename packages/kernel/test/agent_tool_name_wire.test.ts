// AgentStrategy populates originating toolName on every role:tool feedback.
import type {
  ChatRequest,
  ChatResult,
  ModelGateway,
  NormalizedToolCall,
} from "@companion/model-local";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AGENT_INVALID_TOOL_FEEDBACK_CONTENT,
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
  id: string,
): NormalizedToolCall {
  return { id, name, arguments: args };
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

function readReg(name = "test.read"): ToolRegistration {
  return {
    descriptor: {
      name,
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

function strategyCtx(repo: KernelRepository, runId: string) {
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

describe("agent role:tool toolName ordering", () => {
  it("ordinary multi-tool feedback preserves order with toolCallId + toolName", async () => {
    const { handle, repo } = await setup();
    try {
      const broker: ToolBroker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [readReg("test.read"), readReg("test.other")],
      });
      const ordinary = [
        toolCall("test.read", { q: "a" }, "c0"),
        toolCall("test.other", { q: "b" }, "c1"),
      ];
      const { gateway, calls } = scriptGateway([
        chatResult(ordinary),
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
      await strategy(strategyCtx(repo, runId));
      expect(calls).toHaveLength(2);
      const replayed = calls[1]?.messages ?? [];
      const assistantIdx = replayed.findIndex(
        (m) => m.role === "assistant" && Array.isArray(m.toolCalls),
      );
      expect(assistantIdx).toBeGreaterThanOrEqual(0);
      const tools = replayed.filter((m) => m.role === "tool");
      expect(tools).toHaveLength(2);
      expect(tools.map((m) => m.toolCallId)).toEqual(["c0", "c1"]);
      expect(tools.map((m) => m.toolName)).toEqual(["test.read", "test.other"]);
      // Contiguous, in request order, immediately after the assistant replay.
      expect(replayed.indexOf(tools[0] as (typeof replayed)[number])).toBe(
        assistantIdx + 1,
      );
      expect(replayed.indexOf(tools[1] as (typeof replayed)[number])).toBe(
        assistantIdx + 2,
      );
      // Framed feedback names the originating tool; raw arguments never leak.
      for (const m of tools) {
        const parsed = JSON.parse((m as { content: string }).content) as {
          tool: string;
          ok: boolean;
        };
        expect(["test.read", "test.other"]).toContain(parsed.tool);
        expect(parsed.ok).toBe(true);
      }
      expect(JSON.stringify(tools)).not.toContain("super-secret");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("synthetic repair feedback carries one toolName per call id in order", async () => {
    const { handle, repo } = await setup();
    try {
      const broker: ToolBroker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [readReg("test.read")],
      });
      const mixed = [
        toolCall("test.read", { q: "x" }, "c-mixed-ordinary"),
        toolCall(
          "answer.submit",
          { version: 1, parts: [{ text: "x", citations: [] }] },
          "c-mixed-answer",
        ),
      ];
      const { gateway, calls } = scriptGateway([
        chatResult(mixed, "mixed"),
        chatResult([answerCall([{ text: "recovered", citations: [] }])]),
      ]);
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway,
        model: "m",
      });
      const { runId } = newRunningTurn(repo, T0);
      await strategy(strategyCtx(repo, runId));
      const replayed = calls[1]?.messages ?? [];
      const assistantIdx = replayed.findIndex(
        (m) => m.role === "assistant" && Array.isArray(m.toolCalls),
      );
      const tools = replayed.filter((m) => m.role === "tool");
      expect(tools).toHaveLength(2);
      expect(tools.map((m) => m.toolCallId)).toEqual([
        "c-mixed-ordinary",
        "c-mixed-answer",
      ]);
      expect(tools.map((m) => m.toolName)).toEqual([
        "test.read",
        "answer.submit",
      ]);
      for (const [i, m] of tools.entries()) {
        expect(replayed.indexOf(m)).toBe(assistantIdx + 1 + i);
        expect((m as { content: string }).content).toBe(
          AGENT_INVALID_TOOL_FEEDBACK_CONTENT,
        );
      }
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
