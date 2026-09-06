// M2 structured-result persistence (PR #4 r3943445771): the durable
// completed RunResult is an additive V2 `{ version: 2, text, answer }` that
// retains the exact validated part-to-citations mapping while history
// prompts project only the rendered text. No table rebuild, no migration:
// `runs.result_json` stays a json_valid TEXT column holding V1 or V2.

import { buildRunResultV2, parseRunResult } from "@companion/contracts";
import type {
  ChatRequest,
  ChatResult,
  ModelGateway,
  NormalizedToolCall,
} from "@companion/model-local";
import { describe, expect, it } from "vitest";
import {
  createAgentStrategy,
  createKernelRepository,
  createToolBroker,
  freezeStrategyContext,
  type KernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
  projectPrompt,
} from "../src/index.js";

const T0 = 1790000000000;

function toolCall(
  name: string,
  args: unknown = {},
  id = `call-${name}-1`,
): NormalizedToolCall {
  return { id, name, arguments: args };
}

function answerCall(
  parts: { text: string; citations: string[] }[] = [
    { text: "final", citations: [] },
  ],
): NormalizedToolCall {
  return toolCall("answer.submit", { version: 1, parts }, "answer-1");
}

function chatResult(toolCalls: NormalizedToolCall[]): ChatResult {
  return { text: "", toolCalls, stopReason: "tool_calls" };
}

function scriptGateway(script: ChatResult[]): ModelGateway {
  let n = 0;
  return {
    provider: "ollama",
    capabilities: { toolCalling: true },
    baseUrl: "http://127.0.0.1:11434",
    chatUrl: "http://127.0.0.1:11434/api/chat",
    chat: async (request: ChatRequest): Promise<ChatResult> => {
      void request;
      const next = script[Math.min(n, script.length - 1)] as ChatResult;
      n += 1;
      return next;
    },
  };
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
): { sessionId: string; turnId: string; runId: string } {
  const sessionId = repo.createSession({ key: crypto.randomUUID(), now }).body
    .sessionId;
  const posted = repo.postMessage(
    sessionId,
    { text: "research this" },
    { key: crypto.randomUUID(), now },
  );
  repo.startRun(posted.body.run.id, { now: now + 1 });
  return { sessionId, turnId: posted.body.turnId, runId: posted.body.run.id };
}

describe("structured result persistence (V2 RunResult)", () => {
  it("agent returns durable V2 with exact part-to-citations mapping", async () => {
    const { handle, repo } = await setup();
    try {
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [],
      });
      const gateway = scriptGateway([
        chatResult([
          answerCall([
            { text: "first", citations: [] },
            { text: "second", citations: [] },
          ]),
        ]),
      ]);
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway,
        model: "test-model",
      });
      const { runId } = newRunningTurn(repo, T0);
      const run = repo.getRun(runId);
      const turn = repo.getTurn(run.turnId);
      const ctx = freezeStrategyContext(
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
      const result = await strategy(ctx);
      expect(result).toEqual({
        version: 2,
        text: "first\n\nsecond",
        answer: {
          version: 1,
          parts: [
            { text: "first", citations: [] },
            { text: "second", citations: [] },
          ],
        },
      });
      // The candidate commits durably with no migration.
      expect(repo.completeRun(runId, result, { now: T0 + 5 }).applied).toBe(
        true,
      );
      expect(repo.getRun(runId).result).toEqual(result);
    } finally {
      const { closeKernelDatabase } = await import("../src/index.js");
      closeKernelDatabase(handle);
    }
  });

  it("completeRun persists V2 JSON; history keeps citations, V1 rows still parse", async () => {
    const { handle, repo } = await setup();
    try {
      // Historical V1 row still completes and parses.
      const v1 = newRunningTurn(repo, T0);
      const v1Completed = repo.completeRun(
        v1.runId,
        { version: 1, text: "legacy" },
        { now: T0 + 2 },
      );
      expect(v1Completed.applied).toBe(true);
      expect(repo.getRun(v1.runId).result).toEqual({
        version: 1,
        text: "legacy",
      });

      // V2 row with exact citations persists without any migration.
      const v2 = newRunningTurn(repo, T0 + 10);
      const durable = buildRunResultV2({
        version: 1,
        parts: [
          { text: "first", citations: [] },
          { text: "second", citations: ["r1", "r2"] },
        ],
      });
      expect(durable.text).toBe("first\n\nsecond");
      const completed = repo.completeRun(v2.runId, durable, { now: T0 + 12 });
      expect(completed.applied).toBe(true);
      const stored = repo.getRun(v2.runId);
      expect(stored.result).toEqual(durable);
      // Raw JSON keeps the full mapping (no silent citation drop).
      const raw = handle.raw
        .prepare("SELECT result_json FROM runs WHERE id = ?")
        .get(v2.runId) as { result_json: string };
      expect(parseRunResult(JSON.parse(raw.result_json))).toEqual(durable);
      expect(raw.result_json).toContain('"r1"');
      expect(raw.result_json).toContain('"r2"');

      // run.completed event payload retains the V2 answer.
      const events = repo.getEvents(v2.sessionId, v2.runId, {}).events;
      const done = events.find((e) => e.type === "run.completed");
      expect(done).toMatchObject({ payload: { result: durable } });

      // Selected-completed history retains citations in durable/API data…
      const history = repo.getHistory(v2.sessionId, {});
      const item = history.items.find((entry) => entry.turnId === v2.turnId);
      expect(item?.selectedRun?.result).toEqual(durable);

      // …while the prompt projection receives rendered text only (never
      // the raw answer JSON, tool events, or provider output).
      const prompt = projectPrompt({
        requestText: "follow-up",
        history: [
          {
            turnSeq: item?.seq ?? 1,
            requestText: "research this",
            resultText:
              item?.selectedRun?.result.version === 2
                ? item.selectedRun.result.text
                : "legacy",
          },
        ],
        references: [],
        tools: [],
        model: "test-model",
      });
      const blob = JSON.stringify(prompt);
      // Rendered text only: the projected assistant message equals the
      // deterministic rendering (JSON escapes newlines as \\n).
      const assistant = prompt.messages.find((m) => m.role === "assistant");
      expect(assistant?.content).toBe("first\n\nsecond");
      expect(blob).toContain("first\\n\\nsecond");
      expect(blob).not.toContain('"citations"');
      expect(blob).not.toContain('"answer"');
      expect(blob).not.toContain("toolCalls");
    } finally {
      const { closeKernelDatabase } = await import("../src/index.js");
      closeKernelDatabase(handle);
    }
  });

  it("needs no migration: result_json stays a json_valid TEXT column", async () => {
    const { handle } = await setup();
    try {
      const ddl = handle.raw
        .prepare("SELECT sql FROM sqlite_master WHERE name = 'runs'")
        .get() as { sql: string };
      expect(ddl.sql).toContain("json_valid");
      expect(ddl.sql).not.toContain("version");
    } finally {
      const { closeKernelDatabase } = await import("../src/index.js");
      closeKernelDatabase(handle);
    }
  });
});
