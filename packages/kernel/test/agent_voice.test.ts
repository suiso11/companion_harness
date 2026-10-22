// Voice-layer wiring in the real AgentStrategy: an accepted answer may carry
// an auxiliary voice projection, while canonical text/history/audit stay
// unchanged. Deterministic in-memory DBs + scripted fake gateways only.
import { buildRunResultV2, type RunResultV2 } from "@companion/contracts";
import type {
  ChatRequest,
  ChatResult,
  ModelGateway,
  NormalizedToolCall,
} from "@companion/model-local";
import { describe, expect, it } from "vitest";
import {
  type AgentVoiceLayer,
  closeKernelDatabase,
  createAgentStrategy,
  createKernelRepository,
  createToolBroker,
  createVoiceRenderer,
  freezeStrategyContext,
  type KernelRepository,
  loadBundledVoiceProfile,
  migrateKernelDatabase,
  openKernelDatabase,
  type RunStrategyContext,
  voiceProfileFingerprint,
} from "../src/index.js";

const T0 = 1790000000000;

const canonicalParts = ["明日は晴れです。", "十時に会いましょう。"];
const voicedParts = ["明日は晴れでござります。", "十時にお会いしとくれやす。"];

function answerCall(
  parts: Array<{ text: string; citations: string[] }>,
): NormalizedToolCall {
  return {
    id: "answer-1",
    name: "answer.submit",
    arguments: { version: 1, parts },
  };
}

function chatResult(
  toolCalls: NormalizedToolCall[] = [],
  text = "",
): ChatResult {
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
  sessionId?: string,
): { sessionId: string; runId: string } {
  const sid =
    sessionId ??
    repo.createSession({ key: crypto.randomUUID(), now }).body.sessionId;
  const posted = repo.postMessage(
    sid,
    { text: "research this" },
    { key: crypto.randomUUID(), now },
  );
  const runId = posted.body.run.id;
  repo.startRun(runId, { now: now + 1 });
  return { sessionId: sid, runId };
}

function ctxFor(
  repo: KernelRepository,
  runId: string,
  signal: AbortSignal = new AbortController().signal,
): RunStrategyContext {
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
    signal,
  );
}

function voiceLayerFor(gateway: ModelGateway): AgentVoiceLayer {
  const profile = loadBundledVoiceProfile();
  return {
    render: createVoiceRenderer({ gateway, model: "test-model", profile }),
    profileId: profile.id,
    profileVersion: voiceProfileFingerprint(profile),
  };
}

function renderedVoiceText(parts: string[] = voicedParts): string {
  return JSON.stringify({ parts: parts.map((text) => ({ text })) });
}

function asV2(
  result: Awaited<ReturnType<ReturnType<typeof createAgentStrategy>>>,
) {
  if (result.version !== 2) {
    throw new Error("expected a V2 run result");
  }
  return result as RunResultV2;
}

describe("agent voice wiring", () => {
  it("attaches a gated rendered voice while keeping canonical text and one model_calls row", async () => {
    const { handle, repo } = await setup();
    try {
      const { gateway, calls } = scriptGateway([
        chatResult([
          answerCall(canonicalParts.map((text) => ({ text, citations: [] }))),
        ]),
        chatResult([], renderedVoiceText()),
      ]);
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
        voice: voiceLayerFor(gateway),
      });
      const { sessionId, runId } = newRunningTurn(repo, T0);
      const result = asV2(await strategy(ctxFor(repo, runId)));
      expect(result.text).toBe(canonicalParts.join("\n\n"));
      expect(result.answer.parts.map((part) => part.text)).toEqual(
        canonicalParts,
      );
      expect(result.voice).toMatchObject({ status: "rendered" });
      expect(result.voice?.parts?.map((part) => part.text)).toEqual(
        voicedParts,
      );
      // One agent step + one auxiliary voice call; only the agent step is
      // audited as a model_call/model.step.
      expect(calls).toHaveLength(2);
      expect(repo.listModelCalls(runId)).toHaveLength(1);
      const events = repo
        .getEvents(sessionId, runId, {})
        .events.filter((event) => event.type.startsWith("model.step."));
      // The single agent step writes its normal started+completed pair; the
      // auxiliary voice call adds no model.step event of its own.
      expect(events.map((event) => event.type)).toEqual([
        "model.step.started",
        "model.step.completed",
      ]);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("projects canonical history only (never voiced text)", async () => {
    const { handle, repo } = await setup();
    try {
      const first = scriptGateway([
        chatResult([
          answerCall(canonicalParts.map((text) => ({ text, citations: [] }))),
        ]),
        chatResult([], renderedVoiceText()),
      ]);
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [],
      });
      const firstStrategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway: first.gateway,
        model: "test-model",
        voice: voiceLayerFor(first.gateway),
      });
      const { sessionId, runId } = newRunningTurn(repo, T0);
      const firstResult = asV2(await firstStrategy(ctxFor(repo, runId)));
      expect(firstResult.voice?.status).toBe("rendered");
      repo.completeRun(runId, firstResult, { now: T0 + 5 });

      const second = scriptGateway([
        chatResult([answerCall([{ text: "follow up answer", citations: [] }])]),
      ]);
      const secondStrategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway: second.gateway,
        model: "test-model",
      });
      const next = newRunningTurn(repo, T0 + 10, sessionId);
      const secondResult = asV2(await secondStrategy(ctxFor(repo, next.runId)));
      expect(secondResult.text).toBe("follow up answer");
      expect("voice" in secondResult).toBe(false);

      const messages = second.calls[0]?.messages ?? [];
      const historyAssistant = messages.find(
        (message) =>
          message.role === "assistant" &&
          message.content === canonicalParts.join("\n\n"),
      );
      expect(historyAssistant).toBeDefined();
      const historyText = messages
        .filter((message) => message.role !== "system")
        .map((message) => message.content)
        .join("\n");
      for (const voiced of voicedParts) {
        expect(historyText).not.toContain(voiced);
      }
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("keeps the run completed with a fallback marker when the renderer rejects output", async () => {
    const { handle, repo } = await setup();
    try {
      const { gateway } = scriptGateway([
        chatResult([answerCall([{ text: "final answer", citations: [] }])]),
        chatResult([], "not json"),
      ]);
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
        voice: voiceLayerFor(gateway),
      });
      const { runId } = newRunningTurn(repo, T0);
      const result = asV2(await strategy(ctxFor(repo, runId)));
      expect(result.text).toBe("final answer");
      expect(result.voice).toMatchObject({
        status: "fallback",
        reason: "invalid_output",
      });
      expect(repo.listModelCalls(runId)).toHaveLength(1);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("is byte-identical to the previous result when voice is disabled", async () => {
    const { handle, repo } = await setup();
    try {
      const { gateway } = scriptGateway([
        chatResult([answerCall([{ text: "final answer", citations: [] }])]),
      ]);
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
      });
      const { runId } = newRunningTurn(repo, T0);
      const result = asV2(await strategy(ctxFor(repo, runId)));
      const expected = buildRunResultV2({
        version: 1,
        parts: [{ text: "final answer", citations: [] }],
      });
      expect("voice" in result).toBe(false);
      expect(JSON.stringify(result)).toBe(JSON.stringify(expected));
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("skips the renderer when less than 2s of the wall budget remains", async () => {
    const { handle, repo } = await setup();
    try {
      let now = T0;
      let renderCalls = 0;
      const { gateway } = scriptGateway([
        chatResult([answerCall([{ text: "final answer", citations: [] }])]),
      ]);
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [],
      });
      const voice: AgentVoiceLayer = {
        render: async () => {
          renderCalls += 1;
          return {
            profileId: "shunkin",
            profileVersion: "1-000000000000",
            status: "skipped",
            reason: "timeout",
          };
        },
        profileId: "shunkin",
        profileVersion: "1-000000000000",
      };
      const advancingGateway: ModelGateway = {
        ...gateway,
        chat: async (request) => {
          now = T0 + 9_000;
          return gateway.chat(request);
        },
      };
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway: advancingGateway,
        model: "test-model",
        clock: { now: () => now },
        wallMs: 10_000,
        voice,
      });
      const { runId } = newRunningTurn(repo, T0);
      const result = asV2(await strategy(ctxFor(repo, runId)));
      expect(renderCalls).toBe(0);
      expect(result.text).toBe("final answer");
      expect(result.voice).toEqual({
        profileId: "shunkin",
        profileVersion: "1-000000000000",
        status: "skipped",
        reason: "timeout",
      });
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("keeps engine cancellation semantics while voice is rendering", async () => {
    const { handle, repo } = await setup();
    try {
      const { gateway } = scriptGateway([
        chatResult([answerCall([{ text: "final answer", citations: [] }])]),
      ]);
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [],
      });
      const controller = new AbortController();
      const voice: AgentVoiceLayer = {
        render: async (_answer, input) => {
          controller.abort();
          expect(input.signal.aborted).toBe(true);
          return {
            profileId: "shunkin",
            profileVersion: "1-000000000000",
            status: "skipped",
            reason: "cancelled",
          };
        },
        profileId: "shunkin",
        profileVersion: "1-000000000000",
      };
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway,
        model: "test-model",
        voice,
      });
      const { runId } = newRunningTurn(repo, T0);
      await expect(
        strategy(ctxFor(repo, runId, controller.signal)),
      ).rejects.toMatchObject({
        name: "StrategyError",
        errorCode: "execution_cancelled",
      });
      // The delivered step was finalized before voice started, so
      // cancellation during voice cannot erase its audit row/event.
      expect(repo.listModelCalls(runId)).toHaveLength(1);
      const events = repo
        .getEvents(repo.getRun(runId).sessionId, runId, {})
        .events.filter((event) => event.type.startsWith("model.step."));
      expect(events.map((event) => event.type)).toEqual([
        "model.step.started",
        "model.step.completed",
      ]);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
