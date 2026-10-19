// Model-agnostic answer.submit protocol version (Gemma 4 compatibility):
// the kernel authors the StructuredAnswer protocol `version` itself, so the
// model may omit it or send an exact alternate spelling of 1 (1, "1",
// "1.0"); any other present value (2, "2", "x", ...) stays invalid and the
// one-shot repair hint carries the fixed field-level reason.

import { parseStructuredAnswer } from "@companion/contracts";
import type {
  ChatRequest,
  ChatResult,
  ModelGateway,
  NormalizedToolCall,
} from "@companion/model-local";
import { describe, expect, it } from "vitest";
import {
  AGENT_REPAIR_HINTS,
  answerSubmitToolDefinition,
  closeKernelDatabase,
  createAgentStrategy,
  createKernelRepository,
  createToolBroker,
  freezeStrategyContext,
  type KernelRepository,
  migrateKernelDatabase,
  normalizeAnswerSubmitVersion,
  openKernelDatabase,
} from "../src/index.js";

const T0 = 1790000000000;

function toolCall(
  name: string,
  args: unknown = {},
  id = "call-1",
): NormalizedToolCall {
  return { id, name, arguments: args };
}

function answer(
  version: unknown,
  parts = [{ text: "final", citations: [] as string[] }],
): unknown {
  return typeof version === "undefined" ? { parts } : { version, parts };
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

describe("answer.submit protocol version normalization", () => {
  it('accepts omitted / 1 / "1" / "1.0" through strict contract parsing', () => {
    for (const raw of [
      answer(undefined),
      answer(1),
      answer("1"),
      answer("1.0"),
      answer(1.0),
    ]) {
      const parsed = parseStructuredAnswer(normalizeAnswerSubmitVersion(raw));
      expect(parsed.version).toBe(1);
      expect(parsed.parts).toEqual([{ text: "final", citations: [] }]);
    }
  });

  it("keeps other present values untouched so strict parsing rejects them", () => {
    for (const raw of [answer("2"), answer(2), answer("x"), answer(false)]) {
      expect(() =>
        parseStructuredAnswer(normalizeAnswerSubmitVersion(raw)),
      ).toThrow();
    }
    // No silent upgrade: the sent value is never rewritten to 1.
    expect(
      (normalizeAnswerSubmitVersion(answer("2")) as { version: unknown })
        .version,
    ).toBe("2");
  });

  it("normalization is a pass-through for non-objects and only rewrites version", () => {
    expect(normalizeAnswerSubmitVersion("not an object")).toBe("not an object");
    expect(normalizeAnswerSubmitVersion(null)).toBe(null);
    expect(normalizeAnswerSubmitVersion(42)).toBe(42);
    const extra = { version: "1.0", parts: [{ text: "t", citations: [] }] } as {
      version: unknown;
      parts: [{ text: string; citations: string[] }];
    };
    const normalized = normalizeAnswerSubmitVersion(extra) as {
      version: unknown;
      parts: unknown;
    };
    expect(normalized.version).toBe(1);
    expect(normalized.parts).toBe(extra.parts);
  });

  it("no longer requires the model to author the protocol version in the schema", () => {
    const parameters = answerSubmitToolDefinition().parameters as {
      properties: Record<string, unknown>;
      required: string[];
      additionalProperties: boolean;
    };
    expect(parameters.properties).not.toHaveProperty("version");
    expect(parameters.required).toEqual(["parts"]);
    // Still a closed schema.
    expect(parameters.additionalProperties).toBe(false);
  });
});

describe("strategy-level answer version handling", () => {
  it('completes when the model sends version "1.0" (Gemma 4 shape)', async () => {
    const { handle, repo } = await setup();
    try {
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [],
      });
      const { gateway, calls } = scriptGateway([
        chatResult([toolCall("answer.submit", answer("1.0"))]),
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
        text: "final",
        answer: { version: 1, parts: [{ text: "final", citations: [] }] },
      });
      expect(calls).toHaveLength(1);
      expect(repo.listModelCalls(runId)[0]).toMatchObject({
        outcome: "completed",
      });
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it('repairs "2" once with the fixed version detail, then completes', async () => {
    const { handle, repo } = await setup();
    try {
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [],
      });
      const { gateway, calls } = scriptGateway([
        chatResult([toolCall("answer.submit", answer("2"), "answer-bad")]),
        chatResult([toolCall("answer.submit", answer(undefined), "answer-ok")]),
      ]);
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway,
        model: "m",
      });
      const { runId } = newRunningTurn(repo, T0);
      await expect(strategy(ctxFor(repo, runId))).resolves.toMatchObject({
        version: 2,
        answer: { parts: [{ text: "final", citations: [] }] },
      });
      expect(calls).toHaveLength(2);
      const rows = repo.listModelCalls(runId);
      expect(rows[0]).toMatchObject({
        step: 1,
        outcome: "failed",
        errorCode: "answer_invalid",
      });
      expect(rows[1]).toMatchObject({ step: 2, outcome: "completed" });
      // The repair hint carries the fixed field-level reason, never the
      // model's own value ("2" is not echoed).
      const hint = calls[1]?.messages.find(
        (m) => m.role === "user" && m.content.includes("Repair instruction:"),
      );
      expect(hint?.content).toContain(AGENT_REPAIR_HINTS.answer_invalid);
      expect(hint?.content).toContain("unsupported value");
      expect(hint?.content).toContain("version");
      expect(hint?.content).not.toContain('"2"');
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("repairs shape errors with the first zod field path, never the payload", async () => {
    const { handle, repo } = await setup();
    try {
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [],
      });
      const { gateway, calls } = scriptGateway([
        chatResult([toolCall("answer.submit", answer(undefined, []))]),
        chatResult([toolCall("answer.submit", answer(undefined))]),
      ]);
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway,
        model: "m",
      });
      const { runId } = newRunningTurn(repo, T0);
      await expect(strategy(ctxFor(repo, runId))).resolves.toMatchObject({
        version: 2,
      });
      const hint = calls[1]?.messages.find(
        (m) => m.role === "user" && m.content.includes("Repair instruction:"),
      );
      expect(hint?.content).toContain("parts: ");
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
