// Voice slot-confirmation gate (the "confirm before a dictated write" rule).
//
// The taxonomy is checked directly, and the broker path is exercised on a
// real in-memory DB with an injected clock: a dictated calendar write is
// refused once, the byte-identical call passes only in the immediately
// following user turn, once, within the 15-minute window. Typed turns and
// read-only tools never see the gate.

import { buildRunResultV2 } from "@companion/contracts";
import type {
  ChatRequest,
  ChatResult,
  ModelGateway,
} from "@companion/model-local";
import type Database from "better-sqlite3";
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
  type RunStrategyContext,
  riskySlotValues,
  type ToolBroker,
  type ToolRegistration,
} from "../src/index.js";

const T0 = 1_790_000_000_000;
const CTX = { origin: "test-origin", caller: "test-caller" };

const RESULT = buildRunResultV2({
  version: 1,
  parts: [{ text: "done", citations: [] }],
});

function calendarRegistration(): ToolRegistration {
  return {
    descriptor: {
      name: "calendar.reschedule",
      version: 1,
      title: "Reschedule",
      description: "test staged write",
      category: "write",
      defaultTimeoutMs: 5_000,
      maxTimeoutMs: 10_000,
      supportsRefresh: false,
    },
    inputSchema: z.strictObject({
      start: z.string().min(1),
      end: z.string().min(1),
      reason: z.string().default(""),
    }),
    outputSchema: z.strictObject({ ok: z.literal(true) }),
    handler: async () => ({ ok: true as const }),
    proposalOnly: true,
  };
}

interface Fixture {
  readonly db: Database.Database;
  readonly repo: KernelRepository;
  readonly broker: ToolBroker;
  readonly clock: { now: number };
  newRun(): { sessionId: string; runId: string };
  postTurn(sessionId: string): { sessionId: string; runId: string };
  close(): void;
}

async function setup(): Promise<Fixture> {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  const repo = createKernelRepository(handle.raw);
  const clock = { now: T0 };
  const broker = createToolBroker({
    db: handle.raw,
    repo,
    registrations: [calendarRegistration()],
    clock: { now: () => clock.now },
  });
  const start = (
    sessionId: string,
    runId: string,
  ): { sessionId: string; runId: string } => {
    repo.startRun(runId, { now: clock.now });
    return { sessionId, runId };
  };
  return {
    db: handle.raw,
    repo,
    broker,
    clock,
    newRun() {
      const sessionId = repo.createSession({
        key: crypto.randomUUID(),
        now: clock.now,
      }).body.sessionId;
      const posted = repo.postMessage(
        sessionId,
        { text: "明日の会議をずらして" },
        { key: crypto.randomUUID(), now: clock.now },
      );
      return start(sessionId, posted.body.run.id);
    },
    postTurn(sessionId) {
      const posted = repo.postMessage(
        sessionId,
        { text: "はい" },
        { key: crypto.randomUUID(), now: clock.now },
      );
      return start(sessionId, posted.body.run.id);
    },
    close() {
      closeKernelDatabase(handle);
    },
  };
}

function pendingRows(f: Fixture): number {
  const row = f.db
    .prepare("SELECT COUNT(*) AS n FROM tool_confirmations")
    .get() as { n: number };
  return row.n;
}

const ARGS = {
  start: "2026-04-03T15:00:00+09:00",
  end: "2026-04-03T16:00:00+09:00",
  reason: "部長の都合",
};

describe("riskySlotValues", () => {
  it("extracts number and entity slots from mutating tools", () => {
    expect(riskySlotValues("calendar.reschedule", ARGS).sort()).toEqual(
      [ARGS.start, ARGS.end, ARGS.reason].sort(),
    );
    expect(
      riskySlotValues("memory.correct", {
        searchId: "s-1",
        correctionBody: "会議は15時どす",
      }),
    ).toEqual(["会議は15時どす"]);
    expect(
      riskySlotValues("trial.propose", {
        taskId: "t-1",
        objective: "掃除",
        acceptance: ["床", "窓"],
        literalPatchPaths: ["notes.md"],
        operation: "shell",
        expiryMinutes: 30,
      }).sort(),
    ).toEqual(["30", "notes.md", "床", "掃除", "窓"].sort());
  });

  it("ignores read tools, unknown tools, and empty values", () => {
    expect(riskySlotValues("web.search", { query: "天気" })).toEqual([]);
    expect(riskySlotValues("calendar.search", {})).toEqual([]);
    expect(
      riskySlotValues("calendar.reschedule", {
        start: "2026-04-03T15:00:00+09:00",
        end: "2026-04-03T16:00:00+09:00",
        reason: "   ",
      }),
    ).toHaveLength(2);
  });
});

describe("voice slot-confirmation gate", () => {
  it("refuses a dictated write, then allows the identical call in the next turn only", async () => {
    const f = await setup();
    try {
      const first = f.newRun();
      const refused = await f.broker.invoke(
        first.runId,
        "calendar.reschedule",
        ARGS,
        {
          ...CTX,
          voiceInput: true,
        },
      );
      expect(refused.result.errorCode).toBe("confirmation_required");
      expect(refused.result.disposition).toBe("none");
      expect(refused.pipeline).toContain("confirm");
      expect(pendingRows(f)).toBe(1);

      // Same-run retry never passes: a confirmation must be a separate turn.
      const again = await f.broker.invoke(
        first.runId,
        "calendar.reschedule",
        ARGS,
        {
          ...CTX,
          voiceInput: true,
        },
      );
      expect(again.result.errorCode).toBe("confirmation_required");

      f.repo.completeRun(first.runId, RESULT, { now: f.clock.now });
      const second = f.postTurn(first.sessionId);
      const confirmed = await f.broker.invoke(
        second.runId,
        "calendar.reschedule",
        ARGS,
        { ...CTX, voiceInput: true },
      );
      expect(confirmed.result.actualOutcome).toBe("succeeded");
      expect(confirmed.result.errorCode).toBeNull();

      // One use: a third identical call is gated again.
      f.repo.completeRun(second.runId, RESULT, { now: f.clock.now });
      const third = f.postTurn(first.sessionId);
      const thirdOut = await f.broker.invoke(
        third.runId,
        "calendar.reschedule",
        ARGS,
        { ...CTX, voiceInput: true },
      );
      expect(thirdOut.result.errorCode).toBe("confirmation_required");
    } finally {
      f.close();
    }
  });

  it("keeps typed turns and read-only tools ungated", async () => {
    const f = await setup();
    try {
      const typed = f.newRun();
      const out = await f.broker.invoke(
        typed.runId,
        "calendar.reschedule",
        ARGS,
        CTX,
      );
      expect(out.result.actualOutcome).toBe("succeeded");
      expect(pendingRows(f)).toBe(0);
    } finally {
      f.close();
    }
  });

  it("does not accept a confirmation when another user turn came first", async () => {
    const f = await setup();
    try {
      const first = f.newRun();
      await f.broker.invoke(first.runId, "calendar.reschedule", ARGS, {
        ...CTX,
        voiceInput: true,
      });
      f.repo.completeRun(first.runId, RESULT, { now: f.clock.now });
      const second = f.postTurn(first.sessionId);
      await f.broker.invoke(second.runId, "calendar.reschedule", ARGS, {
        ...CTX,
        voiceInput: true,
      });
      f.repo.completeRun(second.runId, RESULT, { now: f.clock.now });
      const third = f.postTurn(first.sessionId);
      const out = await f.broker.invoke(
        third.runId,
        "calendar.reschedule",
        ARGS,
        {
          ...CTX,
          voiceInput: true,
        },
      );
      expect(out.result.errorCode).toBe("confirmation_required");
    } finally {
      f.close();
    }
  });

  it("expires the pending confirmation after the 15-minute window", async () => {
    const f = await setup();
    try {
      const first = f.newRun();
      await f.broker.invoke(first.runId, "calendar.reschedule", ARGS, {
        ...CTX,
        voiceInput: true,
      });
      f.repo.completeRun(first.runId, RESULT, { now: f.clock.now });
      f.clock.now += 15 * 60 * 1000 + 1;
      const stale = f.postTurn(first.sessionId);
      const staleOut = await f.broker.invoke(
        stale.runId,
        "calendar.reschedule",
        ARGS,
        { ...CTX, voiceInput: true },
      );
      expect(staleOut.result.errorCode).toBe("confirmation_required");
      // The refreshed row belongs to the stale attempt, so the next turn works.
      f.repo.completeRun(stale.runId, RESULT, { now: f.clock.now });
      const fresh = f.postTurn(first.sessionId);
      const freshOut = await f.broker.invoke(
        fresh.runId,
        "calendar.reschedule",
        ARGS,
        { ...CTX, voiceInput: true },
      );
      expect(freshOut.result.actualOutcome).toBe("succeeded");
    } finally {
      f.close();
    }
  });
});

describe("agent wiring", () => {
  it("refuses a dictated write inside the real strategy and tells the model", async () => {
    const f = await setup();
    try {
      const sessionId = f.repo.createSession({
        key: crypto.randomUUID(),
        now: T0,
      }).body.sessionId;
      const posted = f.repo.postMessage(
        sessionId,
        { text: "明日の会議をずらして", uiContext: { inputOrigin: "voice" } },
        { key: crypto.randomUUID(), now: T0 },
      );
      const runId = posted.body.run.id;
      f.repo.startRun(runId, { now: T0 + 1 });
      const calls: ChatRequest[] = [];
      const gateway: ModelGateway = {
        provider: "ollama",
        capabilities: { toolCalling: true },
        baseUrl: "http://127.0.0.1:11434",
        chatUrl: "http://127.0.0.1:11434/api/chat",
        chat: async (request: ChatRequest): Promise<ChatResult> => {
          calls.push(request);
          return calls.length === 1
            ? {
                text: "",
                toolCalls: [
                  {
                    id: "call-1",
                    name: "calendar.reschedule",
                    arguments: ARGS,
                  },
                ],
                stopReason: "tool_calls",
              }
            : {
                text: "",
                toolCalls: [
                  {
                    id: "answer-1",
                    name: "answer.submit",
                    arguments: {
                      version: 1,
                      parts: [{ text: "確認します", citations: [] }],
                    },
                  },
                ],
                stopReason: "tool_calls",
              };
        },
      };
      const strategy = createAgentStrategy({
        db: f.db,
        repo: f.repo,
        broker: f.broker,
        gateway,
        model: "test-model",
      });
      const run = f.repo.getRun(runId);
      const turn = f.repo.getTurn(run.turnId);
      const ctx: RunStrategyContext = freezeStrategyContext(
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
      await strategy(ctx);

      const rows = f.db
        .prepare("SELECT error_code FROM tool_calls WHERE run_id = ?")
        .all(runId) as Array<{ error_code: string | null }>;
      expect(rows.map((row) => row.error_code)).toEqual([
        "confirmation_required",
      ]);
      expect(JSON.stringify(calls[1])).toContain("confirmation_required");
    } finally {
      f.close();
    }
  });
});
