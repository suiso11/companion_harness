// Strict OpenAI-compatible repair replay + exact SnapshotBody version gate.
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
  AGENT_REPAIR_HINTS,
  closeKernelDatabase,
  createAgentStrategy,
  createKernelRepository,
  createToolBroker,
  extractGrantCandidates,
  freezeStrategyContext,
  type KernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
  type ToolBroker,
  type ToolRegistration,
} from "../src/index.js";

const T0 = 1790000000000;
const SECRET = "super-secret-payload-xyz-123";

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
    handler: async () => ({ text: "ok" }),
  };
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

/** Assert strict wire: assistant(toolCalls) + one fixed tool per id + repair hint. */
function expectStrictRepairWire(
  calls: ChatRequest[],
  expectedIds: readonly string[],
  hintSnippet: string,
) {
  expect(calls).toHaveLength(2);
  const replayed = calls[1]?.messages ?? [];
  const assistantIdx = replayed.findIndex(
    (m) =>
      m.role === "assistant" &&
      Array.isArray(m.toolCalls) &&
      m.toolCalls.length === expectedIds.length,
  );
  expect(assistantIdx).toBeGreaterThanOrEqual(0);
  const assistant = replayed[assistantIdx] as {
    toolCalls: NormalizedToolCall[];
  };
  expect(assistant.toolCalls.map((c) => c.id)).toEqual([...expectedIds]);
  // Exactly the invalid-call tools, contiguous, in order, before repair hint.
  const after = replayed.slice(assistantIdx + 1);
  const tools = after.filter((m) => m.role === "tool");
  expect(tools).toHaveLength(expectedIds.length);
  expect(tools.map((m) => m.toolCallId)).toEqual([...expectedIds]);
  for (const [i, m] of tools.entries()) {
    expect(replayed.indexOf(m)).toBe(assistantIdx + 1 + i);
    expect((m as { content: string }).content).toBe(
      AGENT_INVALID_TOOL_FEEDBACK_CONTENT,
    );
    expect((m as { content: string }).content).not.toContain(SECRET);
  }
  const repairIdx = replayed.findIndex(
    (m) =>
      m.role === "user" &&
      typeof m.content === "string" &&
      m.content.includes(hintSnippet),
  );
  expect(repairIdx).toBe(assistantIdx + 1 + expectedIds.length);
  // Synthetic payloads alone must be fixed and leak nothing; the retained
  // assistant toolCalls echo is provider-required replay, not synthetic
  // feedback, so it is excluded from this non-sensitivity check.
}

describe("strict OpenAI-compatible repair replay", () => {
  it("mixed answer+ordinary emits one fixed tool per id, executes nothing", async () => {
    const { handle, repo } = await setup();
    try {
      let executions = 0;
      const broker: ToolBroker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [
          {
            ...readReg(),
            handler: async () => {
              executions += 1;
              return { text: "x" };
            },
          },
        ],
      });
      const mixed = [
        toolCall("test.read", { q: SECRET }, "c-mixed-ordinary"),
        toolCall(
          "answer.submit",
          { version: 1, parts: [{ text: SECRET, citations: [] }] },
          "c-mixed-answer",
        ),
      ];
      const { gateway, calls } = scriptGateway([
        chatResult(mixed, "mixed text"),
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
      await expect(strategy(ctxFor(repo, runId))).resolves.toEqual({
        version: 1,
        text: "recovered",
      });
      expect(executions).toBe(0);
      expect(
        handle.raw.prepare("SELECT COUNT(*) AS n FROM tool_calls").get(),
      ).toMatchObject({ n: 0 });
      expectStrictRepairWire(
        calls,
        ["c-mixed-ordinary", "c-mixed-answer"],
        "never both",
      );
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("duplicate answer.submit emits one fixed tool per occurrence, executes nothing", async () => {
    const { handle, repo } = await setup();
    try {
      const broker: ToolBroker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [],
      });
      const dup = [
        toolCall(
          "answer.submit",
          { version: 1, parts: [{ text: SECRET, citations: [] }] },
          "dup-a",
        ),
        toolCall(
          "answer.submit",
          { version: 1, parts: [{ text: SECRET, citations: [] }] },
          "dup-b",
        ),
      ];
      const { gateway, calls } = scriptGateway([
        chatResult(dup),
        chatResult([answerCall([{ text: "fixed", citations: [] }])]),
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
        text: "fixed",
      });
      expect(
        handle.raw.prepare("SELECT COUNT(*) AS n FROM tool_calls").get(),
      ).toMatchObject({ n: 0 });
      expectStrictRepairWire(calls, ["dup-a", "dup-b"], "exactly once");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("reserved answer.* emits one fixed tool, executes nothing, leaks nothing", async () => {
    const { handle, repo } = await setup();
    try {
      const broker: ToolBroker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [readReg()],
      });
      const { gateway, calls } = scriptGateway([
        chatResult([
          toolCall("answer.draft", { payload: SECRET }, "c-reserved"),
        ]),
        chatResult([answerCall([{ text: "ok", citations: [] }])]),
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
        text: "ok",
      });
      expect(
        handle.raw.prepare("SELECT COUNT(*) AS n FROM tool_calls").get(),
      ).toMatchObject({ n: 0 });
      expectStrictRepairWire(calls, ["c-reserved"], "Only answer.submit");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("structurally invalid single answer.submit gets one fixed tool before repair", async () => {
    const { handle, repo } = await setup();
    try {
      const broker: ToolBroker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [],
      });
      const bad = toolCall(
        "answer.submit",
        { version: 2, parts: [{ text: SECRET, citations: [] }] },
        "a-bad",
      );
      const { gateway, calls } = scriptGateway([
        chatResult([bad]),
        chatResult([answerCall([{ text: "good", citations: [] }])]),
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
        text: "good",
      });
      expectStrictRepairWire(calls, ["a-bad"], "structurally invalid");
      expect(AGENT_REPAIR_HINTS.answer_invalid).toContain("version 1");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("citation-invalid single answer.submit gets one fixed tool before repair", async () => {
    const { handle, repo } = await setup();
    try {
      const broker: ToolBroker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [],
      });
      const badCitation = toolCall(
        "answer.submit",
        { version: 1, parts: [{ text: "cited", citations: ["r9"] }] },
        "a-cite-bad",
      );
      const { gateway, calls } = scriptGateway([
        chatResult([badCitation]),
        chatResult([answerCall([{ text: "clean", citations: [] }])]),
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
        text: "clean",
      });
      expectStrictRepairWire(calls, ["a-cite-bad"], "not granted");
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

describe("full EvidenceGrant requires exact SnapshotBody version 1", () => {
  it("grants full only for body { version: 1, text }", () => {
    const ref = crypto.randomUUID();
    expect(
      extractGrantCandidates({
        referenceId: ref,
        body: { version: 1, text: "full" },
      }),
    ).toEqual([{ referenceId: ref, exposure: "full" }]);
    // Empty text with version 1 is still full evidence.
    expect(
      extractGrantCandidates({
        referenceId: ref,
        body: { version: 1, text: "" },
      }),
    ).toEqual([{ referenceId: ref, exposure: "full" }]);
    // Wrong/missing versions never grant full.
    expect(
      extractGrantCandidates({
        referenceId: ref,
        body: { version: 2, text: "full" },
      }),
    ).toEqual([]);
    expect(
      extractGrantCandidates({
        referenceId: ref,
        body: { text: "full" },
      }),
    ).toEqual([]);
    expect(
      extractGrantCandidates({
        referenceId: ref,
        body: { version: "1", text: "full" },
      }),
    ).toEqual([]);
    expect(
      extractGrantCandidates({
        referenceId: ref,
        body: { version: 1 },
      }),
    ).toEqual([]);
    // Version-mismatched body falls back to snippet only when a snippet exists.
    expect(
      extractGrantCandidates({
        referenceId: ref,
        snippet: "s",
        body: { version: 2, text: "full" },
      }),
    ).toEqual([{ referenceId: ref, exposure: "snippet" }]);
  });
});
