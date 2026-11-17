// Per-day activity reader: raw read-only SQL over turns / tasks / actions.

import {
  closeKernelDatabase,
  createKernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
} from "@companion/kernel";
import { describe, expect, it } from "vitest";
import { createDayActivityStore } from "../src/day_activity.js";

const DAY = "2026-09-21";
const AT = Date.parse(`${DAY}T12:00:00Z`);
const HOUR = 60 * 60 * 1000;
const utcDay = (at: number): string => new Date(at).toISOString().slice(0, 10);

async function fixture() {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  const repo = createKernelRepository(handle.raw);
  const newSession = () =>
    repo.createSession({ key: crypto.randomUUID(), now: AT }).body.sessionId;
  const task = (
    sessionId: string,
    title: string,
    status: string,
    at: number,
  ): string => {
    const id = crypto.randomUUID();
    handle.raw
      .prepare(
        `INSERT INTO autonomy_tasks (id, session_id, scope, title, kind, speaker,
           status, version, created_at, updated_at)
         VALUES (?, ?, 'personal/default', ?, 'task', 'user', ?, 1, ?, ?)`,
      )
      .run(id, sessionId, title, status, at, at);
    return id;
  };
  const event = (
    sessionId: string,
    taskId: string,
    name: string,
    toStatus: string,
    note: string | null,
    at: number,
    seq: number,
  ): void => {
    handle.raw
      .prepare(
        `INSERT INTO autonomy_task_events (id, task_id, session_id, seq, event,
           to_status, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        taskId,
        sessionId,
        seq,
        name,
        toStatus,
        note,
        at,
      );
  };
  const action = (
    sessionId: string,
    status: "succeeded" | "blocked_stale",
    finishedAt: number,
  ): void => {
    // Execution FKs (proposal/run/turn) are irrelevant to the reader.
    handle.raw.pragma("foreign_keys = OFF");
    handle.raw
      .prepare(
        `INSERT INTO action_executions (id, session_id, proposal_id, approval_turn_id,
           action_run_id, status, external_call_started_at, finished_at,
           created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        sessionId,
        crypto.randomUUID(),
        crypto.randomUUID(),
        crypto.randomUUID(),
        status,
        status === "succeeded" ? finishedAt : null,
        finishedAt,
        finishedAt,
        finishedAt,
      );
    handle.raw.pragma("foreign_keys = ON");
  };
  return {
    handle,
    repo,
    store: createDayActivityStore(handle.raw),
    newSession,
    task,
    event,
    action,
  };
}

describe("day activity store", () => {
  it("returns companion messages of the day chronologically, bounded", async () => {
    const f = await fixture();
    try {
      const s = f.newSession();
      f.repo.postCompanionMessage(s, "前日のひとこと", { now: AT - 24 * HOUR });
      f.repo.postCompanionMessage(s, "朝のひとこと", { now: AT });
      f.repo.postCompanionMessage(s, "あ".repeat(500), { now: AT + HOUR });
      f.repo.postCompanionMessage(s, "翌日のひとこと", { now: AT + 24 * HOUR });
      const out = f.store.read(DAY, utcDay);
      expect(out.companionMessages).toEqual(["朝のひとこと", "あ".repeat(300)]);
    } finally {
      closeKernelDatabase(f.handle);
    }
  });

  it("keeps only the 8 newest messages", async () => {
    const f = await fixture();
    try {
      const s = f.newSession();
      for (let i = 0; i < 10; i += 1) {
        f.repo.postCompanionMessage(s, `m${i}`, { now: AT + i });
      }
      const out = f.store.read(DAY, utcDay);
      expect(out.companionMessages).toEqual([
        "m2",
        "m3",
        "m4",
        "m5",
        "m6",
        "m7",
        "m8",
        "m9",
      ]);
    } finally {
      closeKernelDatabase(f.handle);
    }
  });

  it("excludes hidden sessions from every source", async () => {
    const f = await fixture();
    try {
      const hidden = f.newSession();
      f.handle.raw
        .prepare("UPDATE sessions SET hidden = 1 WHERE id = ?")
        .run(hidden);
      f.repo.postCompanionMessage(hidden, "見えない", { now: AT });
      const t = f.task(hidden, "隠しタスク", "open", AT);
      f.event(hidden, t, "created", "open", null, AT, 1);
      f.action(hidden, "succeeded", AT);
      expect(f.store.read(DAY, utcDay)).toEqual({
        companionMessages: [],
        tasks: [],
        actions: [],
      });
    } finally {
      closeKernelDatabase(f.handle);
    }
  });

  it("formats tasks, task events, and action counts for the day only", async () => {
    const f = await fixture();
    try {
      const s = f.newSession();
      const t = f.task(s, "牛乳を買う", "completed", AT);
      f.event(s, t, "created", "open", null, AT, 1);
      f.event(s, t, "completed", "completed", "買えた", AT + HOUR, 2);
      f.event(s, t, "resumed", "open", null, AT + 30 * HOUR, 3);
      f.task(s, "別の日のタスク", "open", AT - 5 * 24 * HOUR);
      f.action(s, "succeeded", AT);
      f.action(s, "succeeded", AT + HOUR);
      f.action(s, "blocked_stale", AT + 2 * HOUR);
      f.action(s, "succeeded", AT + 30 * HOUR);
      const out = f.store.read(DAY, utcDay);
      expect(out.tasks).toEqual([
        "- [completed] task: 牛乳を買う",
        "- 牛乳を買う: created -> open",
        "- 牛乳を買う: completed -> completed (買えた)",
      ]);
      expect(out.actions).toEqual(["succeeded 2", "blocked_stale 1"]);
    } finally {
      closeKernelDatabase(f.handle);
    }
  });

  it("bounds task lines by count and code points", async () => {
    const f = await fixture();
    try {
      const s = f.newSession();
      for (let i = 0; i < 20; i += 1) {
        f.task(s, `${"タ".repeat(200)}${i}`, "open", AT + i);
      }
      const out = f.store.read(DAY, utcDay);
      expect(out.tasks).toHaveLength(12);
      for (const line of out.tasks) {
        expect(Array.from(line).length).toBeLessThanOrEqual(160);
      }
    } finally {
      closeKernelDatabase(f.handle);
    }
  });

  it("degrades to empty arrays on a malformed day or broken database", async () => {
    const f = await fixture();
    try {
      const empty = { companionMessages: [], tasks: [], actions: [] };
      expect(f.store.read("nope", utcDay)).toEqual(empty);
      const broken = createDayActivityStore({
        prepare: () => {
          throw new Error("db closed");
        },
      } as never);
      expect(broken.read(DAY, utcDay)).toEqual(empty);
    } finally {
      closeKernelDatabase(f.handle);
    }
  });
});
