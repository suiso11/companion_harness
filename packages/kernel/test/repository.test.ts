// M0 kernel repository / domain tests: idempotency, allocators, CAS
// transitions, cancel-first, recovery/drain, selection, history/events.

import { randomUUID } from "node:crypto";
import { messageScope } from "@companion/contracts";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  closeKernelDatabase,
  createKernelRepository,
  generateId,
  IdempotencyConflictError,
  isUuidV4,
  migrateKernelDatabase,
  openKernelDatabase,
  RepositoryNotFoundError,
  RepositoryValidationError,
  requestHash,
  SessionBusyError,
} from "../src/index.js";

async function openRepo() {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  const repo = createKernelRepository(handle.raw);
  return { handle, repo, db: handle.raw };
}

const T0 = 1790000000000;

function messageKey(): string {
  return generateId();
}

describe("canonical json + hashing + uuid", () => {
  it("sorts object keys recursively and preserves array order", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ o: { d: 1, c: 2 }, a: [3, 2, 1] })).toBe(
      '{"a":[3,2,1],"o":{"c":2,"d":1}}',
    );
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
  });

  it("separates request hashes by operation and schema version", () => {
    const payload = { text: "hi" };
    const a = requestHash("post_message", 1, payload);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(requestHash("post_message", 1, { text: "hi" })).toBe(a);
    expect(requestHash("post_retry", 1, payload)).not.toBe(a);
    expect(requestHash("post_message", 2, payload)).not.toBe(a);
    // Key order alone does not change the hash.
    expect(requestHash("op", 1, { a: 1, b: 2 })).toBe(
      requestHash("op", 1, { b: 2, a: 1 }),
    );
  });

  it("generates UUID v4 ids and validates keys", () => {
    const id = generateId();
    expect(isUuidV4(id)).toBe(true);
    expect(isUuidV4("not-a-uuid")).toBe(false);
    expect(isUuidV4(randomUUID())).toBe(true);
    // Non-v4 (nil) rejected.
    expect(isUuidV4("00000000-0000-0000-0000-000000000000")).toBe(false);
  });
});

describe("create-session idempotency", () => {
  it("replays the same session on same key", async () => {
    const { handle, repo } = await openRepo();
    try {
      const key = messageKey();
      const first = repo.createSession({ key, now: T0 });
      expect(first.status).toBe(201);
      expect(first.replayed).toBe(false);
      const second = repo.createSession({ key, now: T0 + 5 });
      expect(second.replayed).toBe(true);
      expect(second.status).toBe(201);
      expect(second.body).toEqual(first.body);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("rejects non-UUID keys without persisting", async () => {
    const { handle, repo, db } = await openRepo();
    try {
      expect(() => repo.createSession({ key: "bad", now: T0 })).toThrow(
        RepositoryValidationError,
      );
      const n = (
        db.prepare("SELECT COUNT(*) AS n FROM api_idempotency").get() as {
          n: number;
        }
      ).n;
      expect(n).toBe(0);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

describe("message idempotency + active uniqueness", () => {
  it("replays exact status/body and conflicts on different hash", async () => {
    const { handle, repo, db } = await openRepo();
    try {
      const s = repo.createSession({ key: messageKey(), now: T0 }).body
        .sessionId;
      const key = messageKey();
      const first = repo.postMessage(s, { text: "hello" }, { key, now: T0 });
      expect(first.status).toBe(202);
      const replay = repo.postMessage(
        s,
        { text: "hello" },
        { key, now: T0 + 1 },
      );
      expect(replay.replayed).toBe(true);
      expect(replay.body).toEqual(first.body);
      expect(replay.status).toBe(202);
      expect(() =>
        repo.postMessage(s, { text: "different" }, { key, now: T0 }),
      ).toThrow(IdempotencyConflictError);
      const turns = (
        db.prepare("SELECT COUNT(*) AS n FROM turns").get() as { n: number }
      ).n;
      expect(turns).toBe(1);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("does not persist validation failures or session_busy", async () => {
    const { handle, repo, db } = await openRepo();
    try {
      const s = repo.createSession({ key: messageKey(), now: T0 }).body
        .sessionId;
      const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
      expect(() =>
        repo.postMessage(s, { text: "   " }, { key: messageKey(), now: T0 }),
      ).toThrow(RepositoryValidationError);
      expect(count("SELECT COUNT(*) AS n FROM turns")).toBe(0);
      expect(
        count(
          "SELECT COUNT(*) AS n FROM api_idempotency WHERE scope LIKE 'session:%'",
        ),
      ).toBe(0);
      repo.postMessage(s, { text: "one" }, { key: messageKey(), now: T0 });
      expect(() =>
        repo.postMessage(s, { text: "two" }, { key: messageKey(), now: T0 }),
      ).toThrow(SessionBusyError);
      expect(count("SELECT COUNT(*) AS n FROM turns")).toBe(1);
      expect(
        count(
          "SELECT COUNT(*) AS n FROM api_idempotency WHERE scope LIKE 'session:%'",
        ),
      ).toBe(1);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("isolates active runs across sessions and 404s unknown sessions", async () => {
    const { handle, repo } = await openRepo();
    try {
      const a = repo.createSession({ key: messageKey(), now: T0 }).body
        .sessionId;
      const b = repo.createSession({ key: messageKey(), now: T0 }).body
        .sessionId;
      repo.postMessage(a, { text: "a" }, { key: messageKey(), now: T0 });
      expect(() =>
        repo.postMessage(b, { text: "b" }, { key: messageKey(), now: T0 }),
      ).not.toThrow();
      expect(() =>
        repo.postMessage(
          generateId(),
          { text: "x" },
          { key: messageKey(), now: T0 },
        ),
      ).toThrow(RepositoryNotFoundError);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

describe("retry + allocators", () => {
  it("allocates seq/attempt without MAX and reuses immutable input", async () => {
    const { handle, repo, db } = await openRepo();
    try {
      const s = repo.createSession({ key: messageKey(), now: T0 }).body
        .sessionId;
      const first = repo.postMessage(
        s,
        { text: "q" },
        { key: messageKey(), now: T0 },
      );
      const turnId = first.body.turnId;
      const before = repo.getTurn(turnId);
      expect(before.seq).toBe(1);
      expect(before.nextRunAttempt).toBe(2);
      const run = repo.getRun(first.body.run.id);
      await repo.startRun(run.id, { now: T0 + 1 });
      await repo.failRun(run.id, "execution_failed", { now: T0 + 2 });
      const retry = repo.postRetry(s, turnId, {
        key: messageKey(),
        now: T0 + 3,
      });
      expect(retry.body.turnId).toBe(turnId);
      expect(retry.body.run.attempt).toBe(2);
      const after = repo.getTurn(turnId);
      expect(after.nextRunAttempt).toBe(3);
      expect(after.input).toEqual(before.input);
      expect(after.frozenContext).toEqual(before.frozenContext);
      const pos = (
        db
          .prepare("SELECT next_turn_position AS p FROM sessions WHERE id = ?")
          .get(s) as { p: number }
      ).p;
      expect(pos).toBe(2);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("replays retry on same key and rejects cross-session turns", async () => {
    const { handle, repo } = await openRepo();
    try {
      const s = repo.createSession({ key: messageKey(), now: T0 }).body
        .sessionId;
      const other = repo.createSession({ key: messageKey(), now: T0 }).body
        .sessionId;
      const m = repo.postMessage(
        s,
        { text: "q" },
        { key: messageKey(), now: T0 },
      );
      const run = repo.getRun(m.body.run.id);
      await repo.startRun(run.id, { now: T0 + 1 });
      await repo.failRun(run.id, "execution_failed", { now: T0 + 2 });
      const key = messageKey();
      const r1 = repo.postRetry(s, m.body.turnId, { key, now: T0 + 3 });
      const r2 = repo.postRetry(s, m.body.turnId, { key, now: T0 + 4 });
      expect(r2.replayed).toBe(true);
      expect(r2.body).toEqual(r1.body);
      expect(() =>
        repo.postRetry(other, m.body.turnId, { key: messageKey(), now: T0 }),
      ).toThrow(RepositoryNotFoundError);
      expect(() =>
        repo.postRetry(s, generateId(), { key: messageKey(), now: T0 }),
      ).toThrow(RepositoryNotFoundError);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("blocks retry while a run is active regardless of terminal history", async () => {
    const { handle, repo } = await openRepo();
    try {
      const s = repo.createSession({ key: messageKey(), now: T0 }).body
        .sessionId;
      const m = repo.postMessage(
        s,
        { text: "q" },
        { key: messageKey(), now: T0 },
      );
      expect(() =>
        repo.postRetry(s, m.body.turnId, { key: messageKey(), now: T0 }),
      ).toThrow(SessionBusyError);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

describe("transitions + event atomicity", () => {
  it("starts queued runs once and appends run.started atomically", async () => {
    const { handle, repo, db } = await openRepo();
    try {
      const s = repo.createSession({ key: messageKey(), now: T0 }).body
        .sessionId;
      const m = repo.postMessage(
        s,
        { text: "q" },
        { key: messageKey(), now: T0 },
      );
      const started = repo.startRun(m.body.run.id, { now: T0 + 1 });
      expect(started.applied).toBe(true);
      expect(started.run.status).toBe("running");
      expect(started.run.eventSeq).toBe(2);
      const again = repo.startRun(m.body.run.id, { now: T0 + 2 });
      expect(again.applied).toBe(false);
      const n = (
        db
          .prepare("SELECT COUNT(*) AS n FROM run_events WHERE run_id = ?")
          .get(m.body.run.id) as { n: number }
      ).n;
      expect(n).toBe(2);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("completes only from running and upserts selection in the same commit", async () => {
    const { handle, repo } = await openRepo();
    try {
      const s = repo.createSession({ key: messageKey(), now: T0 }).body
        .sessionId;
      const m = repo.postMessage(
        s,
        { text: "q" },
        { key: messageKey(), now: T0 },
      );
      // Complete from queued is discarded: no event, no selection.
      const early = repo.completeRun(
        m.body.run.id,
        { version: 1, text: "ans" },
        { now: T0 + 1 },
      );
      expect(early.applied).toBe(false);
      expect(repo.getSelection(m.body.turnId)).toBeNull();
      await repo.startRun(m.body.run.id, { now: T0 + 2 });
      const done = repo.completeRun(
        m.body.run.id,
        { version: 1, text: "ans" },
        { now: T0 + 3 },
      );
      expect(done.applied).toBe(true);
      expect(done.run.status).toBe("completed");
      const sel = repo.getSelection(m.body.turnId);
      expect(sel?.runId).toBe(m.body.run.id);
      // Second complete is discarded; terminal event stays exactly one.
      const late = repo.completeRun(
        m.body.run.id,
        { version: 1, text: "other" },
        { now: T0 + 4 },
      );
      expect(late.applied).toBe(false);
      const types = handle.raw
        .prepare("SELECT type FROM run_events WHERE run_id = ? ORDER BY seq")
        .all(m.body.run.id) as Array<{ type: string }>;
      expect(types.map((t) => t.type)).toEqual([
        "run.queued",
        "run.started",
        "run.completed",
      ]);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("fails only from running without touching selection and rejects raw errors", async () => {
    const { handle, repo } = await openRepo();
    try {
      const s = repo.createSession({ key: messageKey(), now: T0 }).body
        .sessionId;
      const m = repo.postMessage(
        s,
        { text: "q" },
        { key: messageKey(), now: T0 },
      );
      await repo.startRun(m.body.run.id, { now: T0 + 1 });
      expect(() =>
        repo.failRun(m.body.run.id, "Raw error with details!!", { now: T0 }),
      ).toThrow(RepositoryValidationError);
      const failed = repo.failRun(m.body.run.id, "execution_failed", {
        now: T0 + 2,
      });
      expect(failed.applied).toBe(true);
      expect(failed.run.errorCode).toBe("execution_failed");
      expect(repo.getSelection(m.body.turnId)).toBeNull();
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("refuses event append after a terminal event", async () => {
    const { handle, repo } = await openRepo();
    try {
      const s = repo.createSession({ key: messageKey(), now: T0 }).body
        .sessionId;
      const m = repo.postMessage(
        s,
        { text: "q" },
        { key: messageKey(), now: T0 },
      );
      await repo.startRun(m.body.run.id, { now: T0 + 1 });
      await repo.completeRun(
        m.body.run.id,
        { version: 1, text: "ans" },
        { now: T0 + 2 },
      );
      expect(() =>
        repo.appendToolEvent(
          m.body.run.id,
          "tool.completed",
          {
            callId: generateId(),
            callIndex: 1,
            tool: "docs.search",
            actualOutcome: "succeeded",
            reportedOutcome: "succeeded",
            disposition: "accepted",
            errorCode: null,
            resultDigest: "a".repeat(64),
            reusedFromCallId: null,
          },
          { now: T0 + 3 },
        ),
      ).toThrow(RepositoryValidationError);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

describe("cancel-first semantics", () => {
  it("cancels queued directly to cancelled with both timestamps", async () => {
    const { handle, repo } = await openRepo();
    try {
      const s = repo.createSession({ key: messageKey(), now: T0 }).body
        .sessionId;
      const m = repo.postMessage(
        s,
        { text: "q" },
        { key: messageKey(), now: T0 },
      );
      const out = repo.cancelRun(s, m.body.run.id, { now: T0 + 1 });
      expect(out.status).toBe("cancelled");
      expect(out.run.cancelRequestedAt).toBe(T0 + 1);
      expect(out.run.finishedAt).toBe(T0 + 1);
      const types = handle.raw
        .prepare("SELECT type FROM run_events WHERE run_id = ? ORDER BY seq")
        .all(m.body.run.id) as Array<{ type: string }>;
      expect(types.map((t) => t.type)).toEqual(["run.queued", "run.cancelled"]);
      expect(repo.getSelection(m.body.turnId)).toBeNull();
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("discards completion after cancel_requested and finalizes via watchdog", async () => {
    const { handle, repo } = await openRepo();
    try {
      const s = repo.createSession({ key: messageKey(), now: T0 }).body
        .sessionId;
      const m = repo.postMessage(
        s,
        { text: "q" },
        { key: messageKey(), now: T0 },
      );
      await repo.startRun(m.body.run.id, { now: T0 + 1 });
      const cancelled = repo.cancelRun(s, m.body.run.id, { now: T0 + 2 });
      expect(cancelled.status).toBe("cancel_requested");
      const attempt = repo.completeRun(
        m.body.run.id,
        { version: 1, text: "late" },
        { now: T0 + 3 },
      );
      expect(attempt.applied).toBe(false);
      expect(repo.getRun(m.body.run.id).status).toBe("cancel_requested");
      expect(repo.getSelection(m.body.turnId)).toBeNull();
      const fin = repo.finalizeCancelRequested(m.body.run.id, { now: T0 + 4 });
      expect(fin.applied).toBe(true);
      expect(fin.run.status).toBe("cancelled");
      const types = handle.raw
        .prepare("SELECT type FROM run_events WHERE run_id = ? ORDER BY seq")
        .all(m.body.run.id) as Array<{ type: string }>;
      expect(types.map((t) => t.type)).toEqual([
        "run.queued",
        "run.started",
        "run.cancel_requested",
        "run.cancelled",
      ]);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("is state-idempotent on terminal runs and enforces ownership", async () => {
    const { handle, repo, db } = await openRepo();
    try {
      const s = repo.createSession({ key: messageKey(), now: T0 }).body
        .sessionId;
      const other = repo.createSession({ key: messageKey(), now: T0 }).body
        .sessionId;
      const m = repo.postMessage(
        s,
        { text: "q" },
        { key: messageKey(), now: T0 },
      );
      await repo.startRun(m.body.run.id, { now: T0 + 1 });
      await repo.completeRun(
        m.body.run.id,
        { version: 1, text: "ans" },
        { now: T0 + 2 },
      );
      const again = repo.cancelRun(s, m.body.run.id, { now: T0 + 3 });
      expect(again.status).toBe("completed");
      const n = (
        db
          .prepare("SELECT COUNT(*) AS n FROM run_events WHERE run_id = ?")
          .get(m.body.run.id) as { n: number }
      ).n;
      expect(n).toBe(3);
      expect(() => repo.cancelRun(other, m.body.run.id, { now: T0 })).toThrow(
        RepositoryNotFoundError,
      );
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

describe("recovery and drain", () => {
  async function seedThree() {
    const { handle, repo } = await openRepo();
    const mk = async (text: string) => {
      const s = repo.createSession({ key: messageKey(), now: T0 }).body
        .sessionId;
      const m = repo.postMessage(s, { text }, { key: messageKey(), now: T0 });
      return { s, runId: m.body.run.id };
    };
    const a = await mk("a");
    const b = await mk("b");
    const c = await mk("c");
    await repo.startRun(a.runId, { now: T0 + 1 });
    await repo.startRun(b.runId, { now: T0 + 1 });
    await repo.cancelRun(b.s, b.runId, { now: T0 + 2 });
    return { handle, repo, a, b, c };
  }

  it("recover: running->abandoned, cancel_requested->cancelled, queued unchanged", async () => {
    const { handle, repo, a, b, c } = await seedThree();
    try {
      const out = repo.recover({ now: T0 + 9 });
      expect(out).toEqual({ abandoned: 1, cancelled: 1 });
      expect(repo.getRun(a.runId).status).toBe("abandoned");
      expect(repo.getRun(b.runId).status).toBe("cancelled");
      expect(repo.getRun(c.runId).status).toBe("queued");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("recover keeps queued and records restart_recovery cause", async () => {
    const { handle, repo } = await seedThree();
    try {
      await repo.recover({ now: T0 + 9 });
      // Re-seed references from the same repo instead of rebuilding.
      const running = handle.raw
        .prepare("SELECT id, status FROM runs WHERE status = 'abandoned'")
        .all() as Array<{ id: string; status: string }>;
      expect(running.length).toBe(1);
      const payload = handle.raw
        .prepare(
          "SELECT payload FROM run_events WHERE run_id = ? AND type = 'run.abandoned'",
        )
        .get(running[0]?.id) as { payload: string };
      expect(JSON.parse(payload.payload)).toEqual({
        cause: "restart_recovery",
      });
      const queued = handle.raw
        .prepare("SELECT COUNT(*) AS n FROM runs WHERE status = 'queued'")
        .get() as { n: number };
      expect(queued.n).toBe(1);
      expect(repo.getRun(running[0]?.id as string).eventSeq).toBe(3);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("drain mirrors recovery with drain cause", async () => {
    const { handle, repo } = await seedThree();
    try {
      const out = repo.drain({ now: T0 + 9 });
      expect(out).toEqual({ abandoned: 1, cancelled: 1 });
      const payload = handle.raw
        .prepare("SELECT payload FROM run_events WHERE type = 'run.abandoned'")
        .get() as { payload: string };
      expect(JSON.parse(payload.payload)).toEqual({ cause: "drain" });
      const queued = handle.raw
        .prepare("SELECT COUNT(*) AS n FROM runs WHERE status = 'queued'")
        .get() as { n: number };
      expect(queued.n).toBe(1);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

describe("selection rules", () => {
  it("failed/cancelled/abandoned never select; select_on_success=false keeps prior", async () => {
    const { handle, repo } = await openRepo();
    try {
      const s = repo.createSession({ key: messageKey(), now: T0 }).body
        .sessionId;
      const m1 = repo.postMessage(
        s,
        { text: "q1" },
        { key: messageKey(), now: T0 },
      );
      await repo.startRun(m1.body.run.id, { now: T0 + 1 });
      await repo.failRun(m1.body.run.id, "execution_failed", { now: T0 + 2 });
      expect(repo.getSelection(m1.body.turnId)).toBeNull();

      const r1 = repo.postRetry(s, m1.body.turnId, {
        key: messageKey(),
        now: T0 + 3,
      });
      await repo.startRun(r1.body.run.id, { now: T0 + 4 });
      await repo.completeRun(
        r1.body.run.id,
        { version: 1, text: "first" },
        { now: T0 + 5 },
      );
      expect(repo.getSelection(m1.body.turnId)?.runId).toBe(r1.body.run.id);

      const r2 = repo.postRetry(s, m1.body.turnId, {
        key: messageKey(),
        now: T0 + 6,
        selectOnSuccess: false,
      });
      await repo.startRun(r2.body.run.id, { now: T0 + 7 });
      await repo.completeRun(
        r2.body.run.id,
        { version: 1, text: "second" },
        { now: T0 + 8 },
      );
      expect(repo.getSelection(m1.body.turnId)?.runId).toBe(r1.body.run.id);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

describe("history + events pagination + idempotency lookup", () => {
  it("projects history with exclusive paging and hides unselected runs", async () => {
    const { handle, repo } = await openRepo();
    try {
      const s = repo.createSession({ key: messageKey(), now: T0 }).body
        .sessionId;
      const m1 = repo.postMessage(
        s,
        { text: "first" },
        { key: messageKey(), now: T0 },
      );
      await repo.startRun(m1.body.run.id, { now: T0 + 1 });
      await repo.completeRun(
        m1.body.run.id,
        { version: 1, text: "ans1" },
        { now: T0 + 2 },
      );
      const m2 = repo.postMessage(
        s,
        { text: "second" },
        { key: messageKey(), now: T0 + 3 },
      );
      await repo.startRun(m2.body.run.id, { now: T0 + 4 });
      await repo.failRun(m2.body.run.id, "execution_failed", { now: T0 + 5 });

      const full = repo.getHistory(s, { limit: 50 });
      expect(full.items.map((i) => i.text)).toEqual(["first", "second"]);
      expect(full.items[0]?.selectedRun?.result.text).toBe("ans1");
      expect(full.items[1]?.selectedRun).toBeNull();
      expect(full.hasMore).toBe(false);

      const page1 = repo.getHistory(s, { limit: 1 });
      expect(page1.items.length).toBe(1);
      expect(page1.hasMore).toBe(true);
      expect(page1.nextBefore).not.toBeNull();
      const page2 = repo.getHistory(s, {
        beforePosition: page1.nextBefore ?? 1,
        limit: 10,
      });
      expect(page2.items.map((i) => i.text)).toEqual(["first"]);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("pages events exclusively with terminal derived from status", async () => {
    const { handle, repo } = await openRepo();
    try {
      const s = repo.createSession({ key: messageKey(), now: T0 }).body
        .sessionId;
      const m = repo.postMessage(
        s,
        { text: "q" },
        { key: messageKey(), now: T0 },
      );
      const live = repo.getEvents(s, m.body.run.id, { after: 0, limit: 50 });
      expect(live.terminal).toBe(false);
      await repo.startRun(m.body.run.id, { now: T0 + 1 });
      const p1 = repo.getEvents(s, m.body.run.id, { after: 0, limit: 1 });
      expect(p1.events.map((e) => e.seq)).toEqual([1]);
      expect(p1.nextAfter).toBe(1);
      expect(p1.hasMore).toBe(true);
      const p2 = repo.getEvents(s, m.body.run.id, {
        after: p1.nextAfter,
        limit: 10,
      });
      expect(p2.events.map((e) => e.seq)).toEqual([2]);
      expect(p2.nextAfter).toBe(2);
      const empty = repo.getEvents(s, m.body.run.id, {
        after: p2.nextAfter,
        limit: 10,
      });
      expect(empty.events).toEqual([]);
      expect(empty.nextAfter).toBe(p2.nextAfter);
      expect(empty.hasMore).toBe(false);
      await repo.completeRun(
        m.body.run.id,
        { version: 1, text: "ans" },
        { now: T0 + 2 },
      );
      const done = repo.getEvents(s, m.body.run.id, { after: 0, limit: 50 });
      expect(done.terminal).toBe(true);
      expect(() =>
        repo.getEvents(generateId(), m.body.run.id, { after: 0 }),
      ).toThrow(RepositoryNotFoundError);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("looks up idempotency scoped to the session", async () => {
    const { handle, repo } = await openRepo();
    try {
      const s = repo.createSession({ key: messageKey(), now: T0 }).body
        .sessionId;
      const key = messageKey();
      const first = repo.postMessage(s, { text: "q" }, { key, now: T0 });
      const found = repo.lookupIdempotencyForSession(s, key, messageScope(s));
      expect(found).toEqual({ found: true, status: 202, body: first.body });
      const missing = repo.lookupIdempotencyForSession(
        s,
        messageKey(),
        messageScope(s),
      );
      expect(missing).toEqual({ found: false, code: "resend_required" });
      const other = repo.createSession({ key: messageKey(), now: T0 }).body
        .sessionId;
      expect(() =>
        repo.lookupIdempotencyForSession(other, key, messageScope(s)),
      ).toThrow(RepositoryNotFoundError);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
