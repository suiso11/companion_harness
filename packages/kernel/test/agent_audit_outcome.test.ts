// M2 audit-outcome coherence (PR #4 r3943445774): exactly one model_calls
// row + one matching model.step terminal event per generateTurn, finalized
// only after classification/answer/citation validation.
import type {
  ChatRequest,
  ChatResult,
  ModelGateway,
  NormalizedToolCall,
} from "@companion/model-local";
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
  type ToolRegistration,
} from "../src/index.js";

const T0 = 1790000000000;
const SECRET = "audit-secret-xyz-987";

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

function readReg(): ToolRegistration {
  return {
    descriptor: {
      name: "test.read",
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
    { text: "research this" },
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

describe("audit-outcome coherence: one row + one terminal event per step", () => {
  it("valid ordinary-tool-only step records completed with no contradiction", async () => {
    const { handle, repo } = await setup();
    try {
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [readReg()],
      });
      const { gateway, calls } = scriptGateway([
        chatResult([toolCall("test.read", { q: "hi" }, "c-ordinary")]),
        chatResult([answerCall([{ text: "done", citations: [] }], "a-final")]),
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
      expect(calls).toHaveLength(2);
      const rows = repo.listModelCalls(runId);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        step: 1,
        outcome: "completed",
        errorCode: null,
      });
      expect(rows[1]).toMatchObject({
        step: 2,
        outcome: "completed",
        errorCode: null,
      });
      const events = stepEvents(repo, sessionId, runId);
      expect(
        events.filter((e) => e.type === "model.step.started"),
      ).toHaveLength(2);
      expect(
        events.filter((e) => e.type === "model.step.completed"),
      ).toHaveLength(2);
      expect(events.filter((e) => e.type === "model.step.failed")).toHaveLength(
        0,
      );
      const blob = JSON.stringify({ rows, events });
      expect(blob).not.toContain(SECRET);
      expect(blob).not.toContain("research this");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("valid single answer records one completed row/event", async () => {
    const { handle, repo } = await setup();
    try {
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [],
      });
      const { gateway, calls } = scriptGateway([
        chatResult([answerCall([{ text: "hi", citations: [] }])]),
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
      expect(calls).toHaveLength(1);
      expect(repo.listModelCalls(runId)).toHaveLength(1);
      expect(repo.listModelCalls(runId)[0]).toMatchObject({
        step: 1,
        outcome: "completed",
        errorCode: null,
      });
      const events = stepEvents(repo, sessionId, runId);
      expect(
        events.filter((e) => e.type === "model.step.started"),
      ).toHaveLength(1);
      expect(
        events.filter((e) => e.type === "model.step.completed"),
      ).toHaveLength(1);
      expect(events.filter((e) => e.type === "model.step.failed")).toHaveLength(
        0,
      );
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it.each([
    ["free_text"],
    ["mixed"],
    ["duplicate"],
    ["reserved"],
    ["answer_invalid"],
  ])(
    "invalid %s step records single failed answer_invalid then repairs to completed",
    async (kind) => {
      const { handle, repo } = await setup();
      try {
        const broker = createToolBroker({
          db: handle.raw,
          repo,
          registrations: [readReg()],
        });
        let first: NormalizedToolCall[];
        if (kind === "free_text") {
          first = [];
        } else if (kind === "mixed") {
          first = [
            toolCall("test.read", { q: SECRET }, "c-mx-ord"),
            toolCall(
              "answer.submit",
              { version: 1, parts: [{ text: SECRET, citations: [] }] },
              "c-mx-ans",
            ),
          ];
        } else if (kind === "duplicate") {
          first = [
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
        } else if (kind === "reserved") {
          first = [toolCall("answer.draft", { payload: SECRET }, "c-rsv")];
        } else {
          first = [
            toolCall(
              "answer.submit",
              { version: 2, parts: [{ text: SECRET, citations: [] }] },
              "a-bad",
            ),
          ];
        }
        const { gateway } = scriptGateway([
          chatResult(first, kind === "free_text" ? SECRET : ""),
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
        await strategy(ctxFor(repo, runId));
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
        // Exactly one started + one terminal per recorded step; step 1 must
        // not carry a contradictory completed event.
        expect(
          events.filter(
            (e) =>
              e.type === "model.step.started" &&
              (e.payload as { step: number }).step === 1,
          ),
        ).toHaveLength(1);
        expect(
          events.filter(
            (e) =>
              e.type === "model.step.failed" &&
              (e.payload as { step: number }).step === 1,
          ),
        ).toHaveLength(1);
        expect(
          events.filter(
            (e) =>
              e.type === "model.step.completed" &&
              (e.payload as { step: number }).step === 1,
          ),
        ).toHaveLength(0);
        expect(
          events.filter(
            (e) =>
              e.type === "model.step.completed" &&
              (e.payload as { step: number }).step === 2,
          ),
        ).toHaveLength(1);
        const failedOne = events.find(
          (e) =>
            e.type === "model.step.failed" &&
            (e.payload as { step: number }).step === 1,
        );
        expect(failedOne?.payload).toMatchObject({
          step: 1,
          errorCode: "answer_invalid",
        });
        expect(JSON.stringify({ rows, events })).not.toContain(SECRET);
      } finally {
        closeKernelDatabase(handle);
      }
    },
  );

  it("grant-invalid citation records single failed citation_invalid then repairs", async () => {
    const { handle, repo } = await setup();
    try {
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [],
      });
      const { gateway } = scriptGateway([
        chatResult([
          toolCall(
            "answer.submit",
            { version: 1, parts: [{ text: "cited", citations: ["r9"] }] },
            "a-cite-bad",
          ),
        ]),
        chatResult([answerCall([{ text: "clean", citations: [] }])]),
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
      const rows = repo.listModelCalls(runId);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        step: 1,
        outcome: "failed",
        errorCode: "citation_invalid",
      });
      const events = stepEvents(repo, sessionId, runId);
      expect(
        events.filter(
          (e) =>
            e.type === "model.step.completed" &&
            (e.payload as { step: number }).step === 1,
        ),
      ).toHaveLength(0);
      expect(
        events.filter(
          (e) =>
            e.type === "model.step.failed" &&
            (e.payload as { step: number }).step === 1,
        ),
      ).toHaveLength(1);
      expect(
        events.find(
          (e) =>
            e.type === "model.step.failed" &&
            (e.payload as { step: number }).step === 1,
        )?.payload,
      ).toMatchObject({ step: 1, errorCode: "citation_invalid" });
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("double-invalid exhausts the single repair with two failed rows and output_invalid", async () => {
    const { handle, repo } = await setup();
    try {
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [],
      });
      const { gateway, calls } = scriptGateway([
        chatResult([]),
        chatResult([]),
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
      // Repair counts as a normal step: exactly 2 generateTurn calls.
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
        outcome: "failed",
        errorCode: "answer_invalid",
      });
      const events = stepEvents(repo, sessionId, runId);
      expect(
        events.filter((e) => e.type === "model.step.started"),
      ).toHaveLength(2);
      expect(events.filter((e) => e.type === "model.step.failed")).toHaveLength(
        2,
      );
      expect(
        events.filter((e) => e.type === "model.step.completed"),
      ).toHaveLength(0);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
