// Fixed, non-sensitive reason codes for answer_invalid (observability):
// provider normalization (malformed/oversize), parse failures (zod issue +
// allowlisted path), version sentinel, and every repair class. The reason
// must be persisted on model.step.failed and never carry model text/args.
import type {
  ChatRequest,
  ChatResult,
  ModelGateway,
  NormalizedToolCall,
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
const LEAK = "model-authored-secret-text-xyz";

function toolCall(
  name: string,
  args: unknown = {},
  id = `call-${name}`,
): NormalizedToolCall {
  return { id, name, arguments: args };
}

function answerCall(
  parts: unknown = [{ text: "final", citations: [] }],
  id = "answer-1",
  extra: Record<string, unknown> = {},
): NormalizedToolCall {
  return toolCall("answer.submit", { version: 1, parts, ...extra }, id);
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

/** Run a two-step script and return the persisted model.step.* payloads. */
async function runScript(script: Array<ChatResult | Error>) {
  const { handle, repo } = await setup();
  try {
    const broker = createToolBroker({
      db: handle.raw,
      repo,
      registrations: [],
    });
    const { gateway, calls } = scriptGateway(script);
    const strategy = createAgentStrategy({
      db: handle.raw,
      repo,
      broker,
      gateway,
      model: "m",
    });
    const { sessionId, runId } = newRunningTurn(repo, T0);
    let thrown: unknown;
    try {
      await strategy(ctxFor(repo, runId));
    } catch (error) {
      thrown = error;
    }
    const payloads = repo
      .getEvents(sessionId, runId, {})
      .events.filter((event) => event.type === "model.step.failed")
      .map((event) => event.payload);
    return {
      thrown,
      payloads,
      rows: repo.listModelCalls(runId),
      calls,
    };
  } finally {
    closeKernelDatabase(handle);
  }
}

describe("answer_invalid reason codes", () => {
  it("records provider malformed/oversize normalization causes", async () => {
    for (const reason of [
      "model_args_malformed",
      "model_args_oversize",
    ] as const) {
      const error = new ModelLocalError(
        "answer_invalid",
        "model returned an invalid answer",
        reason,
      );
      const { thrown, payloads, rows } = await runScript([error, error]);
      expect(thrown).toMatchObject({ errorCode: "output_invalid" });
      expect(payloads[0]).toMatchObject({
        step: 1,
        errorCode: "answer_invalid",
        reason,
      });
      expect(rows[0]).toMatchObject({
        outcome: "failed",
        errorCode: "answer_invalid",
      });
    }
  });

  it("records model_args_malformed for a custom-gateway non-object answer", async () => {
    const bad = toolCall("answer.submit", "not-an-object");
    const { payloads } = await runScript([
      chatResult([bad]),
      chatResult([bad]),
    ]);
    expect(payloads[0]).toMatchObject({ reason: "model_args_malformed" });
  });

  it("records version_invalid for an unsupported protocol version", async () => {
    const bad = toolCall("answer.submit", {
      version: 2,
      parts: [{ text: LEAK, citations: [] }],
    });
    const { payloads } = await runScript([
      chatResult([bad]),
      chatResult([bad]),
    ]);
    expect(payloads[0]).toMatchObject({ reason: "version_invalid" });
    expect(JSON.stringify(payloads)).not.toContain(LEAK);
  });

  it("records parse issue code + allowlisted path", async () => {
    const cases: Array<[NormalizedToolCall, string]> = [
      [answerCall([]), "parse:too_small@parts"],
      [answerCall([{ citations: [] }]), "parse:invalid_type@parts.0.text"],
      [
        answerCall([{ text: "ok", citations: [] }], "answer-1", {
          leakedKey: LEAK,
        }),
        "parse:unrecognized_keys@answer",
      ],
    ];
    for (const [bad, expected] of cases) {
      const { payloads } = await runScript([
        chatResult([bad]),
        chatResult([bad]),
      ]);
      expect(payloads[0]).toMatchObject({ reason: expected });
      expect(JSON.stringify(payloads)).not.toContain(LEAK);
    }
  });

  it("records repair-class reasons (mixed/duplicate/reserved/free_text)", async () => {
    const cases: Array<[ChatResult, string]> = [
      [
        chatResult([
          toolCall("markdown.search", { query: LEAK }),
          answerCall(),
        ]),
        "mixed_tool_calls",
      ],
      [
        chatResult([answerCall(undefined, "a"), answerCall(undefined, "b")]),
        "duplicate_answer",
      ],
      [chatResult([toolCall("answer.list", {})]), "reserved_namespace"],
      [chatResult([], LEAK), "free_text"],
    ];
    for (const [bad, expected] of cases) {
      const { payloads } = await runScript([bad, bad]);
      expect(payloads[0]).toMatchObject({
        errorCode: "answer_invalid",
        reason: expected,
      });
      expect(JSON.stringify(payloads)).not.toContain(LEAK);
    }
  });

  it("records citation_not_granted when the cited ordinal is not granted", async () => {
    const bad = answerCall([{ text: LEAK, citations: ["r1"] }]);
    const { payloads } = await runScript([
      chatResult([bad]),
      chatResult([bad]),
    ]);
    expect(payloads[0]).toMatchObject({
      errorCode: "citation_invalid",
      reason: "citation_not_granted",
    });
    expect(JSON.stringify(payloads)).not.toContain(LEAK);
  });
});
