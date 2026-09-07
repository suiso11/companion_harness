// M2 review-history SQL limit (r3943653525): selected-completed history is
// bounded at the SQLite query (DESC+LIMIT) before any JSON.parse, then
// restored to chronological order for prompt projection. Predicates
// (session/current-turn/selected/completed/non-null) stay exact; V1/V2
// rows validate; failed/cancelled/unselected/current/future rows excluded.

import type {
  ChatRequest,
  ChatResult,
  ModelGateway,
} from "@companion/model-local";
import { validateChatRequest } from "@companion/model-local";
import { describe, expect, it } from "vitest";
import {
  AGENT_HISTORY_USER_PREFIX,
  AGENT_MAX_HISTORY_ITEMS,
  closeKernelDatabase,
  createAgentStrategy,
  createKernelRepository,
  createToolBroker,
  freezeStrategyContext,
  migrateKernelDatabase,
  openKernelDatabase,
} from "../src/index.js";

function historyMessages(req: ChatRequest) {
  return req.messages.slice(1, -1);
}

function v1Result(text: string) {
  return { version: 1, text } as const;
}

function v2Result(text: string) {
  return {
    version: 2,
    text,
    answer: { version: 1, parts: [{ text, citations: [] }] },
  } as const;
}

async function seedSelectedCompleted(
  repo: ReturnType<typeof createKernelRepository>,
  sessionId: string,
  count: number,
  baseNow: number,
) {
  for (let i = 1; i <= count; i += 1) {
    const posted = repo.postMessage(
      sessionId,
      { text: `q${i}` },
      { key: crypto.randomUUID(), now: baseNow + i * 10 },
    );
    repo.startRun(posted.body.run.id, { now: baseNow + i * 10 + 1 });
    const result = i % 2 === 0 ? v2Result(`r${i}`) : v1Result(`r${i}`);
    repo.completeRun(posted.body.run.id, result, {
      now: baseNow + i * 10 + 2,
    });
  }
}

async function runCurrentTurn(
  handle: ReturnType<typeof openKernelDatabase>,
  repo: ReturnType<typeof createKernelRepository>,
  sessionId: string,
  currentText: string,
  now: number,
): Promise<ChatRequest> {
  const broker = createToolBroker({ db: handle.raw, repo, registrations: [] });
  const posted = repo.postMessage(
    sessionId,
    { text: currentText },
    { key: crypto.randomUUID(), now },
  );
  repo.startRun(posted.body.run.id, { now: now + 1 });
  const calls: ChatRequest[] = [];
  const gateway: ModelGateway = {
    provider: "ollama",
    capabilities: { toolCalling: true },
    baseUrl: "http://127.0.0.1:11434",
    chatUrl: "http://127.0.0.1:11434/api/chat",
    chat: async (request: ChatRequest): Promise<ChatResult> => {
      calls.push(request);
      validateChatRequest(request);
      return {
        text: "",
        toolCalls: [
          {
            id: "answer-1",
            name: "answer.submit",
            arguments: {
              version: 1,
              parts: [{ text: "done", citations: [] }],
            },
          },
        ],
        stopReason: "tool_calls",
      };
    },
  };
  const strategy = createAgentStrategy({
    db: handle.raw,
    repo,
    broker,
    gateway,
    model: "m",
  });
  const run = repo.getRun(posted.body.run.id);
  const turn = repo.getTurn(run.turnId);
  await strategy(
    freezeStrategyContext(
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
    ),
  );
  const request = calls[0];
  if (request === undefined) throw new Error("gateway was not called");
  return request;
}

describe("review-history SQL limit", () => {
  it("retains exactly the latest selected-completed pairs oldest-to-newest", async () => {
    expect(AGENT_MAX_HISTORY_ITEMS).toBe(63);
    const handle = openKernelDatabase(":memory:");
    await migrateKernelDatabase({ db: handle.raw });
    try {
      const repo = createKernelRepository(handle.raw);
      const sessionId = repo.createSession({
        key: crypto.randomUUID(),
        now: 1790000000000,
      }).body.sessionId;
      // 70 selected-completed (alternating V1/V2) + non-history decoys.
      await seedSelectedCompleted(repo, sessionId, 70, 1790000001000);
      const failed = repo.postMessage(
        sessionId,
        { text: "failed-q" },
        { key: crypto.randomUUID(), now: 1790000010000 },
      );
      repo.startRun(failed.body.run.id, { now: 1790000010001 });
      repo.failRun(failed.body.run.id, "execution_failed", {
        now: 1790000010002,
      });
      const cancelled = repo.postMessage(
        sessionId,
        { text: "cancelled-q" },
        { key: crypto.randomUUID(), now: 1790000010010 },
      );
      repo.cancelRun(sessionId, cancelled.body.run.id, {
        now: 1790000010011,
      });
      const unselected = repo.postMessage(
        sessionId,
        { text: "unselected-q" },
        {
          key: crypto.randomUUID(),
          now: 1790000010020,
          selectOnSuccess: false,
        },
      );
      repo.startRun(unselected.body.run.id, { now: 1790000010021 });
      repo.completeRun(unselected.body.run.id, v1Result("unselected-r"), {
        now: 1790000010022,
      });
      const req = await runCurrentTurn(
        handle,
        repo,
        sessionId,
        "current-q",
        1790000010030,
      );
      const hist = historyMessages(req);
      // Exactly the latest 63 selected-completed pairs: seqs 8..70.
      expect(hist).toHaveLength(AGENT_MAX_HISTORY_ITEMS * 2);
      expect(hist[0]?.content).toBe(`${AGENT_HISTORY_USER_PREFIX}q8`);
      expect(hist[1]?.content).toBe("r8");
      expect(hist[hist.length - 2]?.content).toBe(
        `${AGENT_HISTORY_USER_PREFIX}q70`,
      );
      expect(hist[hist.length - 1]?.content).toBe("r70");
      const blob = req.messages.map((m) => m.content).join("\n");
      // Oldest selected-completed rows fall outside the SQL window.
      expect(blob).not.toContain(`${AGENT_HISTORY_USER_PREFIX}q7\n`);
      expect(blob).not.toContain(`${AGENT_HISTORY_USER_PREFIX}q1\n`);
      // Predicates stay exact: failed/cancelled/unselected/current excluded.
      expect(blob).not.toContain("failed-q");
      expect(blob).not.toContain("cancelled-q");
      expect(blob).not.toContain("unselected-q");
      expect(blob).not.toContain("unselected-r");
      // V1 (odd) and V2 (even) rows both validate and project in the window.
      expect(blob).toContain("q9");
      expect(blob).toContain("r9");
      expect(blob).toContain("q10");
      expect(blob).toContain("r10");
      // Current request rides last; whole request fits the 128-message cap.
      expect(req.messages[req.messages.length - 1]?.content).toContain(
        "current-q",
      );
      expect(req.messages.length).toBeLessThanOrEqual(128);
      expect(() => validateChatRequest(req)).not.toThrow();
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("never loads/parses excluded older oversized/malformed rows", async () => {
    const handle = openKernelDatabase(":memory:");
    await migrateKernelDatabase({ db: handle.raw });
    const origParse = JSON.parse;
    const seen: string[] = [];
    (JSON as unknown as { parse: typeof JSON.parse }).parse = ((
      text: string,
      reviver?: unknown,
    ) => {
      if (typeof text === "string") seen.push(text);
      return origParse(text, reviver as never);
    }) as typeof JSON.parse;
    try {
      const repo = createKernelRepository(handle.raw);
      const sessionId = repo.createSession({
        key: crypto.randomUUID(),
        now: 1790000020000,
      }).body.sessionId;
      await seedSelectedCompleted(repo, sessionId, 70, 1790000021000);
      // Poison the excluded window (seqs 1..5): oversized + malformed shapes.
      // All stay json_valid so the UPDATE succeeds, but carry a sentinel that
      // must never reach JSON.parse or the prompt when the SQL LIMIT holds.
      const poisonBig = `POISON_OLD_BIG:${"X".repeat(200_000)}`;
      const seqToRun = (seq: number): string => {
        const row = handle.raw
          .prepare(
            "SELECT r.id AS id FROM turns t JOIN turn_selections s ON s.turn_id = t.id JOIN runs r ON r.id = s.run_id WHERE t.session_id = ? AND t.seq = ?",
          )
          .get(sessionId, seq) as { id: string } | undefined;
        if (row === undefined) throw new Error(`no selected run at seq ${seq}`);
        return row.id;
      };
      for (const seq of [1, 2, 3]) {
        handle.raw
          .prepare("UPDATE runs SET result_json = ? WHERE id = ?")
          .run(
            JSON.stringify(v1Result(`${poisonBig}-seq${seq}`)),
            seqToRun(seq),
          );
      }
      // Malformed shapes: valid JSON, invalid RunResult/history shape.
      handle.raw
        .prepare("UPDATE runs SET result_json = ? WHERE id = ?")
        .run(
          JSON.stringify({ version: 1, text: 12345, POISON_OLD_MALFORMED: 1 }),
          seqToRun(4),
        );
      handle.raw.prepare("UPDATE runs SET result_json = ? WHERE id = ?").run(
        JSON.stringify({
          version: 99,
          text: "POISON_OLD_MALFORMED-seq5",
        }),
        seqToRun(5),
      );
      seen.length = 0;
      const req = await runCurrentTurn(
        handle,
        repo,
        sessionId,
        "current-poison-q",
        1790000030030,
      );
      const blob = req.messages.map((m) => m.content).join("\n");
      expect(blob).not.toContain("POISON_OLD");
      // Excluded rows were never loaded/parsed: no parse input saw them.
      expect(seen.some((s) => s.includes("POISON_OLD"))).toBe(false);
      // Exact latest window still retained oldest-to-newest despite poison.
      const hist = historyMessages(req);
      expect(hist).toHaveLength(AGENT_MAX_HISTORY_ITEMS * 2);
      expect(hist[0]?.content).toBe(`${AGENT_HISTORY_USER_PREFIX}q8`);
      expect(hist[hist.length - 1]?.content).toBe("r70");
      expect(() => validateChatRequest(req)).not.toThrow();
    } finally {
      (JSON as unknown as { parse: typeof JSON.parse }).parse = origParse;
      closeKernelDatabase(handle);
    }
  });
});
