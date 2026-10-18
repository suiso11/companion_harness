// AV autonomy slice behavioral test (real DB + production repository).
//
// Proves through the REAL kernel repository + migrator (no mocks):
// - purpose create/get/list, correction appends new + supersedes exact old
//   (original statement preserved, unrelated records untouched),
// - explicit owner-recorded conflicts appear and clear only via explicit
//   transitions (same-kind prose alone never conflicts; cross-kind allowed),
// - revoking a parent holds dependent non-terminal tasks atomically and
//   blocks blind resume until an explicit new parent is supplied,
// - nullable applicability windows are unbounded by default, invalid or
//   inverted ranges reject, and only active + applicable parents gate work,
// - completed/cancelled tasks are terminal (never revived),
// - deadlines are never inferred (absent stays null; invalid rejected),
// - wrong-session ids are 404, idempotent replay returns the stored body
//   once, key reuse with a different body conflicts, stale CAS is 409,
// - the stop control defaults paused, survives the restart fence, and
//   accepted (non-replayed) chat messages append user activity.

import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AutonomyStateConflictError,
  AutonomyVersionConflictError,
} from "../src/autonomy.js";
import {
  IdempotencyConflictError,
  RepositoryNotFoundError,
} from "../src/errors.js";
import {
  closeKernelDatabase,
  createKernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
  RepositoryValidationError,
} from "../src/index.js";

async function makeRepo() {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  const repo = createKernelRepository(handle.raw);
  const session = repo.createSession({
    key: randomUUID(),
    now: 1_700_000_000_000,
  });
  const other = repo.createSession({
    key: randomUUID(),
    now: 1_700_000_000_001,
  });
  return {
    handle,
    repo,
    sessionId: session.body.sessionId,
    otherId: other.body.sessionId,
  };
}

function purposeBody(statement: string, extra: Record<string, unknown> = {}) {
  return {
    scope: "health",
    statement,
    kind: "goal",
    explicit: true,
    sourceKind: "user",
    ...extra,
  };
}

describe("autonomy slice", () => {
  it("creates, corrects (append + supersede), and preserves the original", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const created = repo.createAutonomyPurpose(
        sessionId,
        purposeBody("walk daily"),
        {
          key: randomUUID(),
          now: 1_700_000_000_010,
        },
      );
      expect(created.status).toBe(201);
      expect(created.body.status).toBe("active");
      const listed = repo.listAutonomyPurposes(sessionId, { limit: 50 });
      expect(listed.items).toHaveLength(1);

      const corrected = repo.correctAutonomyPurpose(
        sessionId,
        {
          ...purposeBody("walk twice daily"),
          purposeId: created.body.id,
          expectedVersion: 1,
        },
        { key: randomUUID(), now: 1_700_000_000_020 },
      );
      expect(corrected.status).toBe(201);
      // Original statement immutable on the old record; old is superseded.
      expect(corrected.body.old.statement).toBe("walk daily");
      expect(corrected.body.old.status).toBe("superseded");
      expect(corrected.body.current.statement).toBe("walk twice daily");
      expect(corrected.body.current.status).toBe("active");
      // Correcting a superseded record is a state conflict (never revived).
      expect(() =>
        repo.correctAutonomyPurpose(
          sessionId,
          {
            ...purposeBody("walk thrice"),
            purposeId: created.body.id,
            expectedVersion: 2,
          },
          { key: randomUUID(), now: 1_700_000_000_030 },
        ),
      ).toThrow(AutonomyStateConflictError);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("records explicit conflicts only (no same-kind heuristic)", async () => {
    const { handle, repo, sessionId, otherId } = await makeRepo();
    try {
      const first = repo.createAutonomyPurpose(
        sessionId,
        purposeBody("learn Japanese"),
        {
          key: randomUUID(),
        },
      );
      const second = repo.createAutonomyPurpose(
        sessionId,
        purposeBody("water plants"),
        {
          key: randomUUID(),
        },
      );
      // Two independent same-kind goals are NOT automatically contradictory.
      expect(
        repo.listAutonomyPurposeConflicts(sessionId).conflicts,
      ).toHaveLength(0);
      // Cross-kind explicit pair is allowed.
      const pref = repo.createAutonomyPurpose(
        sessionId,
        purposeBody("avoid overtime", { kind: "constraint" }),
        { key: randomUUID() },
      );
      const recorded = repo.recordAutonomyPurposeConflict(
        sessionId,
        { purposeAId: first.body.id, purposeBId: pref.body.id },
        { key: randomUUID() },
      );
      expect(recorded.status).toBe(201);
      const conflicts = repo.listAutonomyPurposeConflicts(sessionId).conflicts;
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]?.purposeIds).toHaveLength(2);
      // Cross-session pair is 404 (ownership-first, never 403).
      expect(() =>
        repo.recordAutonomyPurposeConflict(
          otherId,
          { purposeAId: first.body.id, purposeBId: second.body.id },
          { key: randomUUID() },
        ),
      ).toThrow(RepositoryNotFoundError);
      // Revoking one member clears the ACTIVE listing; the unrelated record
      // stays active and untouched.
      repo.revokeAutonomyPurpose(
        sessionId,
        first.body.id,
        { expectedVersion: 1 },
        { key: randomUUID() },
      );
      expect(
        repo.listAutonomyPurposeConflicts(sessionId).conflicts,
      ).toHaveLength(0);
      expect(repo.getAutonomyPurpose(sessionId, second.body.id).status).toBe(
        "active",
      );
      expect(repo.getAutonomyPurpose(sessionId, pref.body.id).status).toBe(
        "active",
      );
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("revoke holds dependents, blocks blind resume, accepts explicit new parent", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const parent = repo.createAutonomyPurpose(
        sessionId,
        purposeBody("train daily"),
        {
          key: randomUUID(),
        },
      );
      const replacement = repo.createAutonomyPurpose(
        sessionId,
        purposeBody("train weekly", { kind: "preference" }),
        { key: randomUUID() },
      );
      const task = repo.createAutonomyTask(
        sessionId,
        {
          scope: "health",
          title: "morning run",
          kind: "task",
          speaker: "user",
          parentPurposeId: parent.body.id,
        },
        { key: randomUUID() },
      );
      expect(task.body.status).toBe("open");
      const done = repo.createAutonomyTask(
        sessionId,
        {
          scope: "health",
          title: "done item",
          kind: "task",
          speaker: "user",
          parentPurposeId: parent.body.id,
        },
        { key: randomUUID() },
      );
      repo.completeAutonomyTask(
        sessionId,
        done.body.id,
        { expectedVersion: 1 },
        { key: randomUUID() },
      );

      repo.revokeAutonomyPurpose(
        sessionId,
        parent.body.id,
        { expectedVersion: 1 },
        { key: randomUUID() },
      );
      // Dependent non-terminal task is held; terminal task untouched.
      expect(repo.getAutonomyTask(sessionId, task.body.id).status).toBe("held");
      expect(repo.getAutonomyTask(sessionId, done.body.id).status).toBe(
        "completed",
      );

      // Hold first (required reason + trigger), then blind resume is refused.
      const held = repo.getAutonomyTask(sessionId, task.body.id);
      expect(() =>
        repo.resumeAutonomyTask(
          sessionId,
          task.body.id,
          {
            expectedVersion: held.version,
            evidenceKind: "user_confirmed",
            evidence: "go",
          },
          { key: randomUUID() },
        ),
      ).toThrow(AutonomyStateConflictError);
      // Explicit new active parent resumes.
      const resumed = repo.resumeAutonomyTask(
        sessionId,
        task.body.id,
        {
          expectedVersion: held.version,
          evidenceKind: "user_confirmed",
          evidence: "switched plan",
          newParentPurposeId: replacement.body.id,
        },
        { key: randomUUID() },
      );
      expect(resumed.body.status).toBe("in_progress");
      // Terminal tasks never revive.
      expect(() =>
        repo.startAutonomyTask(
          sessionId,
          done.body.id,
          { expectedVersion: 2 },
          { key: randomUUID() },
        ),
      ).toThrow(AutonomyStateConflictError);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("never invents deadlines and enforces task lifecycle + ownership + CAS", async () => {
    const { handle, repo, sessionId, otherId } = await makeRepo();
    try {
      const noDeadline = repo.createAutonomyTask(
        sessionId,
        { scope: "home", title: "tidy room", kind: "task", speaker: "user" },
        { key: randomUUID() },
      );
      expect(noDeadline.body.deadline).toBeNull();
      // Bare date without an explicit offset is rejected (never inferred).
      expect(() =>
        repo.createAutonomyTask(
          sessionId,
          {
            scope: "home",
            title: "bad",
            kind: "task",
            speaker: "user",
            deadline: "2026-10-20",
          },
          { key: randomUUID() },
        ),
      ).toThrow(RepositoryValidationError);
      const dated = repo.createAutonomyTask(
        sessionId,
        {
          scope: "home",
          title: "dated",
          kind: "task",
          speaker: "user",
          deadline: "2026-10-20T10:00:00+09:00",
        },
        { key: randomUUID() },
      );
      expect(dated.body.deadline).toBe("2026-10-20T10:00:00+09:00");
      // Self-proposed tasks require an explicit parent trace.
      expect(() =>
        repo.createAutonomyTask(
          sessionId,
          { scope: "home", title: "derived", kind: "task", speaker: "self" },
          { key: randomUUID() },
        ),
      ).toThrow(RepositoryValidationError);
      // Wrong-session reads are 404 (never 403).
      expect(() => repo.getAutonomyTask(otherId, dated.body.id)).toThrow(
        RepositoryNotFoundError,
      );
      // Stale CAS is a version conflict.
      repo.startAutonomyTask(
        sessionId,
        dated.body.id,
        { expectedVersion: 1 },
        { key: randomUUID() },
      );
      expect(() =>
        repo.completeAutonomyTask(
          sessionId,
          dated.body.id,
          { expectedVersion: 1 },
          { key: randomUUID() },
        ),
      ).toThrow(AutonomyVersionConflictError);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("replays idempotent admissions once and rejects reused keys", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const key = randomUUID();
      const first = repo.createAutonomyPurpose(
        sessionId,
        purposeBody("read nightly"),
        { key },
      );
      const replay = repo.createAutonomyPurpose(
        sessionId,
        purposeBody("read nightly"),
        { key },
      );
      expect(replay.replayed).toBe(true);
      expect(replay.body.id).toBe(first.body.id);
      expect(repo.listAutonomyPurposes(sessionId, {}).items).toHaveLength(1);
      expect(() =>
        repo.createAutonomyPurpose(sessionId, purposeBody("different body"), {
          key,
        }),
      ).toThrow(IdempotencyConflictError);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("defaults control to paused, restart fence re-pauses a resumed control", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      expect(repo.getAutonomyControlState().paused).toBe(true);
      const resumeKey = randomUUID();
      const resumed = repo.setAutonomyControlState(
        { paused: false, expectedVersion: 1 },
        { key: resumeKey },
      );
      expect(resumed.body.paused).toBe(false);
      expect(resumed.body.version).toBe(2);
      // Restart when the previous control was RESUMED flips back to PAUSED
      // with a version advance and never resumes implicitly.
      const fence = repo.applyAutonomyRestartFenceNow(1_700_000_000_100);
      expect(fence.paused).toBe(true);
      expect(fence.version).toBe(3);
      expect(repo.getAutonomyControlState().paused).toBe(true);
      expect(repo.getAutonomyControlState().version).toBe(3);
      // Replaying the OLD resume key returns its stored response but never
      // flips current state back to unpaused: a fresh key + version is needed.
      const replayed = repo.setAutonomyControlState(
        { paused: false, expectedVersion: 1 },
        { key: resumeKey },
      );
      expect(replayed.replayed).toBe(true);
      expect(replayed.body.paused).toBe(false);
      expect(repo.getAutonomyControlState().paused).toBe(true);
      // Already-paused restart stays paused; activity still records the fence.
      const again = repo.applyAutonomyRestartFenceNow(1_700_000_000_200);
      expect(again.paused).toBe(true);
      expect(again.version).toBe(3);
      const kinds = repo
        .listAutonomyActivityLog({})
        .items.map((item) => item.kind);
      expect(kinds).toContain("restart_fence");

      // A fresh resume needs a fresh key + current version.
      const fresh = repo.setAutonomyControlState(
        { paused: false, expectedVersion: 3 },
        { key: randomUUID() },
      );
      expect(fresh.body.paused).toBe(false);
      expect(repo.getAutonomyControlState().paused).toBe(false);

      const before = repo.listAutonomyActivityLog({}).items.length;
      const posted = repo.postMessage(
        sessionId,
        { text: "hello" },
        { key: randomUUID() },
      );
      expect(posted.replayed).toBe(false);
      const afterAccept = repo.listAutonomyActivityLog({}).items.length;
      expect(afterAccept).toBe(before + 1);
      // Replayed admissions never duplicate activity (fresh session avoids
      // the single-active-run gate; the replay check is about idempotency).
      const freshSession = repo.createSession({ key: randomUUID() });
      const freshId = freshSession.body.sessionId;
      const key = randomUUID();
      repo.postMessage(freshId, { text: "again" }, { key });
      const mid = repo.listAutonomyActivityLog({}).items.length;
      const replayedMsg = repo.postMessage(freshId, { text: "again" }, { key });
      expect(replayedMsg.replayed).toBe(true);
      expect(repo.listAutonomyActivityLog({}).items.length).toBe(mid);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("treats null applicability bounds as unbounded and rejects invalid ranges", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const unbounded = repo.createAutonomyPurpose(
        sessionId,
        purposeBody("open goal"),
        { key: randomUUID() },
      );
      expect(unbounded.body.validFrom).toBeNull();
      expect(unbounded.body.validUntil).toBeNull();
      // Bare date without an explicit offset is rejected (never inferred).
      expect(() =>
        repo.createAutonomyPurpose(
          sessionId,
          purposeBody("bad window", {
            validFrom: "2026-10-20",
          }),
          { key: randomUUID() },
        ),
      ).toThrow(RepositoryValidationError);
      // Inverted window is rejected.
      expect(() =>
        repo.createAutonomyPurpose(
          sessionId,
          purposeBody("inverted", {
            validFrom: "2026-10-21T10:00:00+09:00",
            validUntil: "2026-10-20T10:00:00+09:00",
          }),
          { key: randomUUID() },
        ),
      ).toThrow(RepositoryValidationError);
      // A future window parents a task that cannot start yet; clearing the
      // bound via correction restores applicability.
      const future = repo.createAutonomyPurpose(
        sessionId,
        purposeBody("future goal", {
          validFrom: "2026-12-01T00:00:00+09:00",
          validUntil: "2026-12-31T00:00:00+09:00",
        }),
        { key: randomUUID() },
      );
      const gated = repo.createAutonomyTask(
        sessionId,
        {
          scope: "health",
          title: "gated work",
          kind: "task",
          speaker: "user",
          parentPurposeId: future.body.id,
        },
        { key: randomUUID() },
      );
      expect(() =>
        repo.startAutonomyTask(
          sessionId,
          gated.body.id,
          { expectedVersion: 1 },
          { key: randomUUID(), now: 1_700_000_000_000 },
        ),
      ).toThrow(AutonomyStateConflictError);
      const cleared = repo.correctAutonomyPurpose(
        sessionId,
        {
          ...purposeBody("future goal revised"),
          purposeId: future.body.id,
          expectedVersion: 1,
          validFrom: null,
          validUntil: null,
        },
        { key: randomUUID() },
      );
      expect(cleared.body.current.validFrom).toBeNull();
      expect(cleared.body.current.validUntil).toBeNull();
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("achieve and correct hold dependent non-terminal tasks without completing them", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const parent = repo.createAutonomyPurpose(
        sessionId,
        purposeBody("finish report"),
        { key: randomUUID() },
      );
      const open = repo.createAutonomyTask(
        sessionId,
        {
          scope: "health",
          title: "draft",
          kind: "task",
          speaker: "user",
          parentPurposeId: parent.body.id,
        },
        { key: randomUUID() },
      );
      const done = repo.createAutonomyTask(
        sessionId,
        {
          scope: "health",
          title: "already done",
          kind: "task",
          speaker: "user",
          parentPurposeId: parent.body.id,
        },
        { key: randomUUID() },
      );
      repo.completeAutonomyTask(
        sessionId,
        done.body.id,
        { expectedVersion: 1 },
        { key: randomUUID() },
      );
      repo.achieveAutonomyPurpose(
        sessionId,
        parent.body.id,
        { expectedVersion: 1 },
        { key: randomUUID() },
      );
      // Achieve holds the open dependent (never completes it); terminal stays.
      expect(repo.getAutonomyTask(sessionId, open.body.id).status).toBe("held");
      expect(repo.getAutonomyTask(sessionId, done.body.id).status).toBe(
        "completed",
      );
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("round-trips task scope, refuses cross-scope parents, rejects unknown fields", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const parent = repo.createAutonomyPurpose(
        sessionId,
        purposeBody("scoped parent"),
        { key: randomUUID() },
      );
      const task = repo.createAutonomyTask(
        sessionId,
        {
          scope: "health",
          title: "scoped work",
          kind: "task",
          speaker: "user",
          parentPurposeId: parent.body.id,
        },
        { key: randomUUID() },
      );
      expect(task.body.scope).toBe("health");
      expect(repo.getAutonomyTask(sessionId, task.body.id).scope).toBe(
        "health",
      );
      expect(repo.listAutonomyTasks(sessionId, {}).items[0]?.scope).toBe(
        "health",
      );
      // A parent owned by the same session but a different scope is refused.
      expect(() =>
        repo.createAutonomyTask(
          sessionId,
          {
            scope: "work",
            title: "cross scope",
            kind: "task",
            speaker: "user",
            parentPurposeId: parent.body.id,
          },
          { key: randomUUID() },
        ),
      ).toThrow(RepositoryValidationError);
      // Absent scope falls back to the contract default (single-scope
      // clients stay working); unknown wire fields reject (closed contract).
      const defaulted = repo.createAutonomyTask(
        sessionId,
        {
          title: "no scope",
          kind: "task",
          speaker: "user",
        } as unknown as Parameters<typeof repo.createAutonomyTask>[1],
        { key: randomUUID() },
      );
      expect(defaulted.body.scope).toBe("default");
      expect(() =>
        repo.createAutonomyTask(
          sessionId,
          {
            scope: "health",
            title: "extra field",
            kind: "task",
            speaker: "user",
            bogus: true,
          } as unknown as Parameters<typeof repo.createAutonomyTask>[1],
          { key: randomUUID() },
        ),
      ).toThrow(RepositoryValidationError);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("keeps immutable purpose/task history with the original text intact", async () => {
    const { handle, repo, sessionId, otherId } = await makeRepo();
    try {
      const created = repo.createAutonomyPurpose(
        sessionId,
        purposeBody("original wording"),
        { key: randomUUID(), now: 1_700_000_000_010 },
      );
      const corrected = repo.correctAutonomyPurpose(
        sessionId,
        {
          ...purposeBody("revised wording"),
          purposeId: created.body.id,
          expectedVersion: 1,
        },
        { key: randomUUID(), now: 1_700_000_000_020 },
      );
      // Old record history: created -> superseded, original text preserved.
      const oldHistory = repo.getAutonomyPurposeHistory(
        sessionId,
        created.body.id,
      );
      expect(oldHistory.purposeId).toBe(created.body.id);
      expect(oldHistory.events.map((event) => event.event)).toEqual([
        "created",
        "superseded",
      ]);
      expect(oldHistory.events[1]?.toStatus).toBe("superseded");
      expect(corrected.body.old.statement).toBe("original wording");
      // New record history starts its own trail (never rewrites the old).
      const newHistory = repo.getAutonomyPurposeHistory(
        sessionId,
        corrected.body.current.id,
      );
      expect(newHistory.events.map((event) => event.event)).toEqual([
        "corrected",
      ]);
      // Task trail records every transition including parent holds.
      const task = repo.createAutonomyTask(
        sessionId,
        {
          scope: "health",
          title: "trailed work",
          kind: "task",
          speaker: "user",
          parentPurposeId: corrected.body.current.id,
        },
        { key: randomUUID(), now: 1_700_000_000_030 },
      );
      repo.startAutonomyTask(
        sessionId,
        task.body.id,
        { expectedVersion: 1 },
        { key: randomUUID(), now: 1_700_000_000_040 },
      );
      repo.revokeAutonomyPurpose(
        sessionId,
        corrected.body.current.id,
        { expectedVersion: 1 },
        { key: randomUUID(), now: 1_700_000_000_050 },
      );
      const trail = repo.getAutonomyTaskHistory(sessionId, task.body.id);
      expect(trail.taskId).toBe(task.body.id);
      expect(trail.events.map((event) => event.event)).toEqual([
        "created",
        "started",
        "parent_held",
      ]);
      expect(trail.events[2]?.toStatus).toBe("held");
      // Foreign sessions see 404 on history too (ownership-first, never 403).
      expect(() =>
        repo.getAutonomyPurposeHistory(otherId, created.body.id),
      ).toThrow(RepositoryNotFoundError);
      expect(() => repo.getAutonomyTaskHistory(otherId, task.body.id)).toThrow(
        RepositoryNotFoundError,
      );
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("checks ownership before the idempotency cache on every mutation", async () => {
    const { handle, repo, sessionId, otherId } = await makeRepo();
    try {
      const created = repo.createAutonomyPurpose(
        sessionId,
        purposeBody("owned intent"),
        { key: randomUUID() },
      );
      // A foreign session replaying an accepted mutation key is 404 (the
      // owner check runs before any cache read), never a 409 conflict.
      const acceptedKey = randomUUID();
      repo.revokeAutonomyPurpose(
        sessionId,
        created.body.id,
        { expectedVersion: 1 },
        { key: acceptedKey },
      );
      expect(() =>
        repo.revokeAutonomyPurpose(
          otherId,
          created.body.id,
          { expectedVersion: 2 },
          { key: acceptedKey },
        ),
      ).toThrow(RepositoryNotFoundError);
      // Owned terminal same-key replay returns the stored body verbatim.
      const task = repo.createAutonomyTask(
        sessionId,
        { scope: "home", title: "finish me", kind: "task", speaker: "user" },
        { key: randomUUID() },
      );
      const finishKey = randomUUID();
      const finished = repo.completeAutonomyTask(
        sessionId,
        task.body.id,
        { expectedVersion: 1 },
        { key: finishKey },
      );
      expect(finished.body.status).toBe("completed");
      const replayed = repo.completeAutonomyTask(
        sessionId,
        task.body.id,
        { expectedVersion: 1 },
        { key: finishKey },
      );
      expect(replayed.replayed).toBe(true);
      expect(replayed.body.status).toBe("completed");
      expect(replayed.body.version).toBe(finished.body.version);
      // Creates validate the session before the cache: unknown sessions are
      // 404 even for a fresh key, and the key is never stored for them.
      const ghost = randomUUID();
      const ghostKey = randomUUID();
      expect(() =>
        repo.createAutonomyPurpose(ghost, purposeBody("ghost intent"), {
          key: ghostKey,
        }),
      ).toThrow(RepositoryNotFoundError);
      const retry = repo.createAutonomyPurpose(
        sessionId,
        purposeBody("ghost intent"),
        { key: ghostKey },
      );
      expect(retry.replayed).toBe(false);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("distinguishes omitted vs explicit-null applicability bounds in correction idempotency", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const window = {
        validFrom: "2026-11-01T00:00:00+09:00",
        validUntil: "2026-11-30T00:00:00+09:00",
      };
      const base = (statement: string) => ({
        ...purposeBody(statement),
        ...window,
      });
      // validFrom, omit-then-null: omission preserves, explicit null clears,
      // and the same key with a changed presence conflicts (never merges).
      const pFrom = repo.createAutonomyPurpose(sessionId, base("windowed"), {
        key: randomUUID(),
      });
      const keepKey = randomUUID();
      const kept = repo.correctAutonomyPurpose(
        sessionId,
        {
          ...purposeBody("kept window"),
          purposeId: pFrom.body.id,
          expectedVersion: 1,
        },
        { key: keepKey },
      );
      expect(kept.body.current.validFrom).toBe(window.validFrom);
      expect(() =>
        repo.correctAutonomyPurpose(
          sessionId,
          {
            ...purposeBody("kept window"),
            purposeId: pFrom.body.id,
            expectedVersion: 1,
            validFrom: null,
          },
          { key: keepKey },
        ),
      ).toThrow(IdempotencyConflictError);
      // validFrom, null-then-omit: the reverse direction also conflicts.
      const qFrom = repo.createAutonomyPurpose(sessionId, base("windowed q"), {
        key: randomUUID(),
      });
      const clearKey = randomUUID();
      const cleared = repo.correctAutonomyPurpose(
        sessionId,
        {
          ...purposeBody("cleared from"),
          purposeId: qFrom.body.id,
          expectedVersion: 1,
          validFrom: null,
        },
        { key: clearKey },
      );
      expect(cleared.body.current.validFrom).toBeNull();
      expect(cleared.body.current.validUntil).toBe(window.validUntil);
      expect(() =>
        repo.correctAutonomyPurpose(
          sessionId,
          {
            ...purposeBody("cleared from"),
            purposeId: qFrom.body.id,
            expectedVersion: 1,
          },
          { key: clearKey },
        ),
      ).toThrow(IdempotencyConflictError);
      // validUntil, omit-then-null.
      const pUntil = repo.createAutonomyPurpose(sessionId, base("windowed u"), {
        key: randomUUID(),
      });
      const keepUKey = randomUUID();
      const keptU = repo.correctAutonomyPurpose(
        sessionId,
        {
          ...purposeBody("kept until"),
          purposeId: pUntil.body.id,
          expectedVersion: 1,
        },
        { key: keepUKey },
      );
      expect(keptU.body.current.validUntil).toBe(window.validUntil);
      expect(() =>
        repo.correctAutonomyPurpose(
          sessionId,
          {
            ...purposeBody("kept until"),
            purposeId: pUntil.body.id,
            expectedVersion: 1,
            validUntil: null,
          },
          { key: keepUKey },
        ),
      ).toThrow(IdempotencyConflictError);
      // validUntil, null-then-omit.
      const qUntil = repo.createAutonomyPurpose(sessionId, base("windowed v"), {
        key: randomUUID(),
      });
      const clearUKey = randomUUID();
      const clearedU = repo.correctAutonomyPurpose(
        sessionId,
        {
          ...purposeBody("cleared until"),
          purposeId: qUntil.body.id,
          expectedVersion: 1,
          validUntil: null,
        },
        { key: clearUKey },
      );
      expect(clearedU.body.current.validUntil).toBeNull();
      expect(clearedU.body.current.validFrom).toBe(window.validFrom);
      expect(() =>
        repo.correctAutonomyPurpose(
          sessionId,
          {
            ...purposeBody("cleared until"),
            purposeId: qUntil.body.id,
            expectedVersion: 1,
          },
          { key: clearUKey },
        ),
      ).toThrow(IdempotencyConflictError);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("replays a terminal correction verbatim after later state changes", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const created = repo.createAutonomyPurpose(
        sessionId,
        purposeBody("original"),
        { key: randomUUID() },
      );
      const key = randomUUID();
      const corrected = repo.correctAutonomyPurpose(
        sessionId,
        {
          ...purposeBody("revised"),
          purposeId: created.body.id,
          expectedVersion: 1,
        },
        { key },
      );
      // A later state change: revoke the NEW record (the old stays
      // superseded; the stored correction body must not change).
      repo.revokeAutonomyPurpose(
        sessionId,
        corrected.body.current.id,
        { expectedVersion: 1 },
        { key: randomUUID() },
      );
      expect(
        repo.getAutonomyPurpose(sessionId, corrected.body.current.id).status,
      ).toBe("revoked");
      // Exact terminal replay: same key + byte-identical command returns the
      // stored body verbatim (ownership first, cache before state checks).
      const replayed = repo.correctAutonomyPurpose(
        sessionId,
        {
          ...purposeBody("revised"),
          purposeId: created.body.id,
          expectedVersion: 1,
        },
        { key },
      );
      expect(replayed.replayed).toBe(true);
      expect(replayed.status).toBe(201);
      expect(replayed.body.old.id).toBe(corrected.body.old.id);
      expect(replayed.body.current.id).toBe(corrected.body.current.id);
      expect(replayed.body.current.statement).toBe("revised");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("pages task history losslessly past 200 events and validates cursors", async () => {
    const { handle, repo, sessionId, otherId } = await makeRepo();
    try {
      const task = repo.createAutonomyTask(
        sessionId,
        { scope: "health", title: "cycled", kind: "task", speaker: "user" },
        { key: randomUUID() },
      );
      // 100 hold/resume cycles => 1 created + 200 transitions = 201 events.
      let version = 1;
      for (let cycle = 0; cycle < 100; cycle += 1) {
        const held = repo.holdAutonomyTask(
          sessionId,
          task.body.id,
          {
            expectedVersion: version,
            reason: `waiting ${cycle}`,
            reconsiderTrigger: `signal ${cycle}`,
          },
          { key: randomUUID() },
        );
        version = held.body.version;
        const resumed = repo.resumeAutonomyTask(
          sessionId,
          task.body.id,
          {
            expectedVersion: version,
            evidenceKind: "user_confirmed",
            evidence: `signal arrived ${cycle}`,
          },
          { key: randomUUID() },
        );
        version = resumed.body.version;
      }
      // A single default page is bounded (never the full 201 at once).
      const first = repo.getAutonomyTaskHistory(sessionId, task.body.id);
      expect(first.events.length).toBeLessThanOrEqual(200);
      expect(first.events).toHaveLength(50);
      expect(first.nextAfterSeq).toBe(50);
      // Consecutive pages yield exactly all ordered distinct events.
      const seen: number[] = [];
      const kinds: string[] = [];
      let after = 0;
      for (;;) {
        const page = repo.getAutonomyTaskHistory(sessionId, task.body.id, {
          afterSeq: after,
          limit: 50,
        });
        expect(page.events.length).toBeLessThanOrEqual(50);
        for (const event of page.events) {
          seen.push(event.seq);
          kinds.push(event.event);
        }
        if (page.nextAfterSeq === null) {
          break;
        }
        after = page.nextAfterSeq;
      }
      expect(seen).toHaveLength(201);
      expect(seen).toEqual(
        Array.from({ length: 201 }, (_, index) => index + 1),
      );
      expect(kinds[0]).toBe("created");
      expect(kinds.slice(1)).toEqual(
        Array.from({ length: 100 }, () => ["held", "resumed"]).flat(),
      );
      // Small histories stay exact: a fresh task fits one page, cursor null.
      const solo = repo.createAutonomyTask(
        sessionId,
        { scope: "health", title: "solo", kind: "task", speaker: "user" },
        { key: randomUUID() },
      );
      const soloHistory = repo.getAutonomyTaskHistory(sessionId, solo.body.id);
      expect(soloHistory.events.map((event) => event.event)).toEqual([
        "created",
      ]);
      expect(soloHistory.nextAfterSeq).toBeNull();
      // Ownership runs before history: foreign sessions are 404 even with a
      // cursor, and invalid cursors/limits are rejected (never clamped).
      expect(() =>
        repo.getAutonomyTaskHistory(otherId, task.body.id, { afterSeq: 50 }),
      ).toThrow(RepositoryNotFoundError);
      expect(() =>
        repo.getAutonomyTaskHistory(sessionId, task.body.id, { afterSeq: -1 }),
      ).toThrow(RepositoryValidationError);
      expect(() =>
        repo.getAutonomyTaskHistory(sessionId, task.body.id, { limit: 201 }),
      ).toThrow(RepositoryValidationError);
      // Purpose history pages the same way (small trail, exact + null).
      const purpose = repo.createAutonomyPurpose(
        sessionId,
        purposeBody("paged purpose"),
        { key: randomUUID() },
      );
      const purposeHistory = repo.getAutonomyPurposeHistory(
        sessionId,
        purpose.body.id,
      );
      expect(purposeHistory.events.map((event) => event.event)).toEqual([
        "created",
      ]);
      expect(purposeHistory.nextAfterSeq).toBeNull();
      expect(() =>
        repo.getAutonomyPurposeHistory(otherId, purpose.body.id),
      ).toThrow(RepositoryNotFoundError);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("keeps normal chat working on pre-11 stores and fails loud on corrupt v11 stores", async () => {
    // Pre-11 fixture: a legit old store migrated only to version 10.
    const handle = openKernelDatabase(":memory:");
    try {
      const first = await migrateKernelDatabase({
        db: handle.raw,
        targetVersion: 10,
      });
      expect(first.applied).toContain(10);
      const repo = createKernelRepository(handle.raw);
      const session = repo.createSession({
        key: randomUUID(),
        now: 1_700_000_000_000,
      });
      const sessionId = session.body.sessionId;
      // Normal chat is accepted without the autonomy tables present.
      const posted = repo.postMessage(
        sessionId,
        { text: "hello from v10" },
        { key: randomUUID(), now: 1_700_000_000_010 },
      );
      expect(posted.status).toBe(202);
      // Autonomy reads fail closed on the old version (never silently empty).
      expect(() => repo.getAutonomyControlState()).toThrow();
      expect(() => repo.listAutonomyActivityLog({})).toThrow();
      // Upgrading to latest seeds the paused control; chat activity resumes.
      const backups = join(
        mkdtempSync(join(tmpdir(), "av-migrate-11-")),
        "backups",
      );
      const upgrade = await migrateKernelDatabase({
        db: handle.raw,
        backupDir: backups,
      });
      expect(upgrade.applied.length).toBeGreaterThanOrEqual(2);
      expect(upgrade.applied).toContain(11);
      expect(repo.getAutonomyControlState().paused).toBe(true);
      const before = repo.listAutonomyActivityLog({}).items.length;
      const v11Session = repo.createSession({ key: randomUUID() });
      repo.postMessage(
        v11Session.body.sessionId,
        { text: "hello from v11" },
        { key: randomUUID(), now: 1_700_000_000_020 },
      );
      expect(repo.listAutonomyActivityLog({}).items.length).toBe(before + 1);
    } finally {
      closeKernelDatabase(handle);
    }

    // Corrupt v11 store: the activity table was dropped. Accepted chat must
    // fail loud (the missing-table failure is never masked as acceptance).
    const broken = openKernelDatabase(":memory:");
    try {
      await migrateKernelDatabase({ db: broken.raw });
      const repo = createKernelRepository(broken.raw);
      const session = repo.createSession({ key: randomUUID() });
      broken.raw.exec("DROP TABLE autonomy_activity");
      expect(() =>
        repo.postMessage(
          session.body.sessionId,
          { text: "should not be masked" },
          { key: randomUUID() },
        ),
      ).toThrow(/no such table/i);
    } finally {
      closeKernelDatabase(broken);
    }
  });
});
