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
      // Missing scope and unknown wire fields both reject (closed contract).
      expect(() =>
        repo.createAutonomyTask(
          sessionId,
          {
            title: "no scope",
            kind: "task",
            speaker: "user",
          } as unknown as Parameters<typeof repo.createAutonomyTask>[1],
          { key: randomUUID() },
        ),
      ).toThrow(RepositoryValidationError);
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

  it("correction idempotency distinguishes omitted bounds (preserve) from explicit null (clear)", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const from = "2026-01-05T09:00:00+09:00";
      const until = "2026-02-05T09:00:00+09:00";
      const created = repo.createAutonomyPurpose(
        sessionId,
        purposeBody("windowed goal", { validFrom: from, validUntil: until }),
        { key: randomUUID() },
      );
      expect(created.body.validFrom).toBe(from);
      const key = randomUUID();
      const base = {
        purposeId: created.body.id,
        expectedVersion: 1,
        scope: "health",
        statement: "windowed goal v2",
        kind: "goal",
        explicit: true,
        sourceKind: "user",
      } as const;
      // Omit both bounds: the old window is preserved.
      const omitted = repo.correctAutonomyPurpose(sessionId, base, { key });
      expect(omitted.status).toBe(201);
      expect(omitted.body.current.validFrom).toBe(from);
      expect(omitted.body.current.validUntil).toBe(until);
      // Same key with explicit null validUntil (clear) MUST 409 conflict,
      // never silently replay the omit-bounds response.
      expect(() =>
        repo.correctAutonomyPurpose(
          sessionId,
          { ...base, validUntil: null },
          { key },
        ),
      ).toThrow(IdempotencyConflictError);
      // Same key with explicit null validFrom MUST also 409.
      expect(() =>
        repo.correctAutonomyPurpose(
          sessionId,
          { ...base, validFrom: null },
          { key },
        ),
      ).toThrow(IdempotencyConflictError);
      // Exact replay of the omit-bounds body on the same key replays.
      const replay = repo.correctAutonomyPurpose(sessionId, base, { key });
      expect(replay.replayed).toBe(true);
      expect(replay.body.current.id).toBe(omitted.body.current.id);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("session idempotency lookup routes owned purpose/task/conflict scopes and 404s foreign sessions", async () => {
    const { handle, repo, sessionId, otherId } = await makeRepo();
    try {
      const key = randomUUID();
      const created = repo.createAutonomyPurpose(
        sessionId,
        purposeBody("lookup probe"),
        { key },
      );
      const scope = `session:${sessionId}:purpose`;
      const found = repo.lookupIdempotencyForSession(sessionId, key, scope);
      expect(found.found).toBe(true);
      // Foreign session path with the same scope+key: 404, never leaked.
      expect(() =>
        repo.lookupIdempotencyForSession(otherId, key, scope),
      ).toThrow(RepositoryNotFoundError);
      // Entity-operation scope for the owned purpose resolves.
      const opKey = randomUUID();
      repo.correctAutonomyPurpose(
        sessionId,
        {
          purposeId: created.body.id,
          expectedVersion: 1,
          scope: "health",
          statement: "lookup probe v2",
          kind: "goal",
          explicit: true,
          sourceKind: "user",
        },
        { key: opKey },
      );
      const opScope = `purpose:${created.body.id}:correct`;
      expect(
        repo.lookupIdempotencyForSession(sessionId, opKey, opScope).found,
      ).toBe(true);
      expect(() =>
        repo.lookupIdempotencyForSession(otherId, opKey, opScope),
      ).toThrow(RepositoryNotFoundError);
      // Global control scope is never exposed via a session lookup.
      expect(() =>
        repo.lookupIdempotencyForSession(
          sessionId,
          randomUUID(),
          "autonomy:control",
        ),
      ).toThrow(RepositoryNotFoundError);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
