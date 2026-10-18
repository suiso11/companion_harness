// AV02 shadow-deliberation durable-core behavioral test (real DB +
// production repository, no mocks).
//
// Proves through the REAL kernel repository + migrator:
// - unpaused policy changes enqueue a durable pending job + consumed inbox
//   row in the SAME transaction as the state change (no crash window);
// - paused-time changes record inbox rows but create NO jobs, and resume
//   marks them skipped (NO catchup, no bulk replay);
// - explicit requests replay on stable keys, 409 on drift, and are
//   session-owned (foreign ids 404);
// - claim freezes the full context + epochs under a lease; a constraint
//   created DURING the model call invalidates the output (scope-epoch drift
//   holds the late completion even when record versions are unchanged);
// - pausing holds pending jobs and fences late completions to held;
// - restart holds pending/claimed jobs (leases die with the restart);
// - MODEL outputs validate strictly (unknown grant/budget/bypass fields
//   rejected; evidence MUST be frozen sP/sT/sM/sF labels; task-draft
//   deadlines MUST match an EXPLICIT input deadline; execute/do-nothing
//   action combinations enforced);
// - CODE policy classifies execute proposals without executing anything:
//   wish -> wish_not_command, external text -> external_no_authority,
//   execute -> missing_grant WITH or WITHOUT a recorded permission claim
//   (a CLAIM never becomes a grant; zero execution performed);
// - do-nothing is genuinely representable (completed/no_action), never a
//   fake failure fallback;
// - a foreground abort holds without pretending a decision was made.

import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  IdempotencyConflictError,
  RepositoryNotFoundError,
  RepositoryValidationError,
} from "../src/errors.js";
import {
  closeKernelDatabase,
  createKernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
} from "../src/index.js";
import {
  ShadowLeaseConflictError,
  ShadowStateConflictError,
  ShadowVersionConflictError,
  ShadowWorkerBusyError,
} from "../src/shadow.js";

const T0 = 1_700_001_000_000;

async function makeRepo() {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  const repo = createKernelRepository(handle.raw);
  const session = repo.createSession({ key: randomUUID(), now: T0 });
  const other = repo.createSession({ key: randomUUID(), now: T0 + 1 });
  return {
    handle,
    repo,
    sessionId: session.body.sessionId,
    otherId: other.body.sessionId,
  };
}

function goalBody(statement: string, extra: Record<string, unknown> = {}) {
  return {
    scope: "health",
    statement,
    kind: "goal",
    explicit: true,
    sourceKind: "user",
    ...extra,
  };
}

function unpause(
  repo: ReturnType<typeof createKernelRepository>,
  expectedVersion: number,
  now: number,
) {
  return repo.setAutonomyControlState(
    { paused: false, expectedVersion },
    { key: randomUUID(), now },
  );
}

function validOutput(
  evidenceIds: string[],
  extra: Record<string, unknown> = {},
) {
  return {
    decision: "do-nothing",
    evidenceIds,
    reason: "nothing to do yet",
    proposedAction: null,
    completion: "none required",
    stopConditions: ["any new constraint appears"],
    uncertainty: "low",
    counterargument: "waiting could miss a window",
    ...extra,
  };
}

/** Raw stored explicit-conflict count (the public list caps at 100). */
function storedConflictPairs(
  handle: ReturnType<typeof openKernelDatabase>,
): number {
  return (
    handle.raw
      .prepare("SELECT COUNT(*) AS n FROM autonomy_purpose_conflicts")
      .get() as { n: number }
  ).n;
}

describe("shadow durable core", () => {
  it("enqueues a durable pending job in the same TX as an unpaused policy change", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      unpause(repo, 1, T0 + 10);
      const created = repo.createAutonomyPurpose(
        sessionId,
        goalBody("walk daily"),
        { key: randomUUID(), now: T0 + 20 },
      );
      const jobs = repo.listShadowJobs(sessionId, { limit: 50 });
      expect(jobs.items).toHaveLength(1);
      const job = jobs.items[0] as (typeof jobs.items)[number];
      expect(job).toMatchObject({
        sessionId,
        scope: "health",
        kind: "policy_change",
        status: "pending",
        triggerEvent: "purpose.created",
        triggerId: created.body.id,
        version: 1,
      });
      expect(job.controlVersion).toBeGreaterThanOrEqual(1);
      expect(job.scopeEpoch).toBeGreaterThanOrEqual(1);
      // Durable event source: exactly one consumed inbox row, same TX.
      const inbox = repo.listShadowInbox(sessionId, { limit: 50 });
      expect(inbox.items).toHaveLength(1);
      expect(inbox.items[0]).toMatchObject({
        scope: "health",
        kind: "policy_change",
        triggerEvent: "purpose.created",
        triggerId: created.body.id,
        disposition: "consumed",
        jobId: job.id,
      });
      const events = repo.listShadowJobEvents(sessionId, job.id);
      expect(events.events.map((e) => e.event)).toEqual(["enqueued"]);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("records but never queues while paused, and resume performs no catchup", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      // Control defaults paused: changes record inbox rows, no jobs.
      const created = repo.createAutonomyPurpose(
        sessionId,
        goalBody("walk daily"),
        { key: randomUUID(), now: T0 + 20 },
      );
      expect(created.status).toBe(201);
      expect(repo.listShadowJobs(sessionId, {}).items).toHaveLength(0);
      const inbox = repo.listShadowInbox(sessionId, {});
      expect(inbox.items).toHaveLength(1);
      expect(inbox.items[0]?.disposition).toBe("recorded");
      expect(inbox.items[0]?.jobId).toBeNull();
      // Resume skips paused-time rows: still no jobs (no catchup).
      unpause(repo, 1, T0 + 30);
      expect(repo.listShadowJobs(sessionId, {}).items).toHaveLength(0);
      const after = repo.listShadowInbox(sessionId, {});
      expect(after.items[0]?.disposition).toBe("skipped");
      // Only NEW meaningful state deliberates after resume.
      repo.createAutonomyPurpose(sessionId, goalBody("stretch nightly"), {
        key: randomUUID(),
        now: T0 + 40,
      });
      const jobs = repo.listShadowJobs(sessionId, {});
      expect(jobs.items).toHaveLength(1);
      expect(jobs.items[0]?.triggerEvent).toBe("purpose.created");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("replays explicit requests on stable keys, 409s on drift, 404s foreign sessions", async () => {
    const { handle, repo, sessionId, otherId } = await makeRepo();
    try {
      unpause(repo, 1, T0 + 10);
      const key = randomUUID();
      const first = repo.requestShadowDeliberation(
        sessionId,
        { scope: "health", reason: "weekly review" },
        { key, now: T0 + 20 },
      );
      expect(first.status).toBe(201);
      expect(first.body.kind).toBe("explicit_request");
      expect(first.body.status).toBe("pending");
      expect(first.body.requestKey).toBe(key.toLowerCase());
      const replay = repo.requestShadowDeliberation(
        sessionId,
        { scope: "health", reason: "weekly review" },
        { key, now: T0 + 21 },
      );
      expect(replay.replayed).toBe(true);
      expect(replay.body.id).toBe(first.body.id);
      expect(() =>
        repo.requestShadowDeliberation(
          sessionId,
          { scope: "other-scope", reason: "weekly review" },
          { key, now: T0 + 22 },
        ),
      ).toThrow(IdempotencyConflictError);
      expect(() => repo.getShadowJob(otherId, first.body.id)).toThrow(
        RepositoryNotFoundError,
      );
      expect(() =>
        repo.claimShadowJob(
          otherId,
          first.body.id,
          { owner: "worker-1", expectedVersion: 1 },
          { now: T0 + 23 },
        ),
      ).toThrow(RepositoryNotFoundError);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("holds paused-time explicit requests honestly instead of queueing background work", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const out = repo.requestShadowDeliberation(
        sessionId,
        { scope: "health" },
        { key: randomUUID(), now: T0 + 20 },
      );
      expect(out.body.status).toBe("held");
      expect(out.body.holdReason).toBe("requested_while_paused");
      const events = repo.listShadowJobEvents(sessionId, out.body.id);
      expect(events.events.map((e) => e.event)).toEqual(["held"]);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("holds late completions on scope-epoch drift from a mid-call constraint", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      unpause(repo, 1, T0 + 10);
      repo.createAutonomyPurpose(sessionId, goalBody("walk daily"), {
        key: randomUUID(),
        now: T0 + 20,
      });
      const requested = repo.requestShadowDeliberation(
        sessionId,
        { scope: "health" },
        { key: randomUUID(), now: T0 + 30 },
      );
      const claimed = repo.claimShadowJob(
        sessionId,
        requested.body.id,
        { owner: "worker-1", expectedVersion: 1 },
        { now: T0 + 40 },
      );
      expect(claimed.outcome).toBe("claimed");
      expect(claimed.context).not.toBeNull();
      const labels = (claimed.context?.purposes ?? []).map((p) => p.label);
      expect(labels.length).toBeGreaterThan(0);
      // A new constraint lands DURING the model call: no record version the
      // job saw changes, but the scope epoch advances.
      repo.createAutonomyPurpose(
        sessionId,
        {
          scope: "health",
          statement: "no walks after 22:00",
          kind: "constraint",
          explicit: true,
          sourceKind: "user",
        },
        { key: randomUUID(), now: T0 + 50 },
      );
      const done = repo.completeShadowJob(
        sessionId,
        requested.body.id,
        validOutput([labels[0] as string]),
        { expectedVersion: 2, leaseOwner: "worker-1", now: T0 + 60 },
      );
      expect(done.outcome).toBe("held");
      expect(done.policyCode).toBeNull();
      expect(done.job.status).toBe("held");
      expect(done.job.holdReason).toBe("scope_epoch_drift");
      const events = repo.listShadowJobEvents(sessionId, requested.body.id);
      expect(events.events.map((e) => e.event)).toEqual([
        "enqueued",
        "claimed",
        "held",
      ]);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("pausing holds pending jobs and fences in-flight completions to held", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      unpause(repo, 1, T0 + 10);
      repo.createAutonomyPurpose(sessionId, goalBody("walk daily"), {
        key: randomUUID(),
        now: T0 + 20,
      });
      const requested = repo.requestShadowDeliberation(
        sessionId,
        { scope: "health" },
        { key: randomUUID(), now: T0 + 30 },
      );
      const claimed = repo.claimShadowJob(
        sessionId,
        requested.body.id,
        { owner: "worker-1", expectedVersion: 1 },
        { now: T0 + 40 },
      );
      const labels = (claimed.context?.purposes ?? []).map((p) => p.label);
      // Pausing holds the OTHER pending (policy-change) job immediately.
      const paused = repo.setAutonomyControlState(
        { paused: true, expectedVersion: 2 },
        { key: randomUUID(), now: T0 + 50 },
      );
      expect(paused.body.paused).toBe(true);
      const jobs = repo.listShadowJobs(sessionId, {});
      const policyJob = jobs.items.find((j) => j.kind === "policy_change");
      expect(policyJob?.status).toBe("held");
      expect(policyJob?.holdReason).toBe("control_paused");
      // The claimed job's late completion is held, never applied.
      const done = repo.completeShadowJob(
        sessionId,
        requested.body.id,
        validOutput([labels[0] as string]),
        { expectedVersion: 2, leaseOwner: "worker-1", now: T0 + 60 },
      );
      expect(done.outcome).toBe("held");
      expect(done.job.holdReason).toBe("control_paused");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("holds claimed and pending jobs across the restart fence", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      unpause(repo, 1, T0 + 10);
      const requested = repo.requestShadowDeliberation(
        sessionId,
        { scope: "health" },
        { key: randomUUID(), now: T0 + 20 },
      );
      repo.claimShadowJob(
        sessionId,
        requested.body.id,
        { owner: "worker-1", expectedVersion: 1 },
        { now: T0 + 30 },
      );
      const fence = repo.applyAutonomyRestartFenceNow(T0 + 40);
      expect(fence.paused).toBe(true);
      const job = repo.getShadowJob(sessionId, requested.body.id);
      expect(job.status).toBe("held");
      expect(job.holdReason).toBe("restart_interrupted");
      expect(job.leaseOwner).toBeNull();
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("classifies execute proposals by CODE policy with zero execution", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      unpause(repo, 1, T0 + 10);
      // Wish-kind record (self): reasoned about, never obeyed.
      repo.createAutonomyPurpose(
        sessionId,
        {
          scope: "dreams",
          statement: "i wish meetings would vanish",
          kind: "wish",
          explicit: false,
          sourceKind: "self",
        },
        { key: randomUUID(), now: T0 + 20 },
      );
      const wishReq = repo.requestShadowDeliberation(
        sessionId,
        { scope: "dreams" },
        { key: randomUUID(), now: T0 + 30 },
      );
      const wishClaim = repo.claimShadowJob(
        sessionId,
        wishReq.body.id,
        { owner: "worker-1", expectedVersion: 1 },
        { now: T0 + 40 },
      );
      const wishLabel = wishClaim.context?.purposes[0]?.label as string;
      const wishDone = repo.completeShadowJob(
        sessionId,
        wishReq.body.id,
        validOutput([wishLabel], {
          decision: "execute",
          proposedAction: {
            kind: "local_task",
            summary: "draft a local meeting note",
          },
        }),
        { expectedVersion: 2, leaseOwner: "worker-1", now: T0 + 50 },
      );
      expect(wishDone.outcome).toBe("completed");
      expect(wishDone.policyCode).toBe("wish_not_command");
      // External text: reasoned about, never authority.
      repo.createAutonomyPurpose(
        sessionId,
        {
          scope: "ext",
          statement: "vendor says upgrade now",
          kind: "goal",
          explicit: false,
          sourceKind: "external",
        },
        { key: randomUUID(), now: T0 + 60 },
      );
      const extReq = repo.requestShadowDeliberation(
        sessionId,
        { scope: "ext" },
        { key: randomUUID(), now: T0 + 70 },
      );
      const extClaim = repo.claimShadowJob(
        sessionId,
        extReq.body.id,
        { owner: "worker-1", expectedVersion: 1 },
        { now: T0 + 80 },
      );
      const extLabel = extClaim.context?.purposes[0]?.label as string;
      const extDone = repo.completeShadowJob(
        sessionId,
        extReq.body.id,
        validOutput([extLabel], {
          decision: "execute",
          proposedAction: { kind: "message", summary: "tell vendor no" },
        }),
        { expectedVersion: 2, leaseOwner: "worker-1", now: T0 + 90 },
      );
      expect(extDone.outcome).toBe("completed");
      expect(extDone.policyCode).toBe("external_no_authority");
      // Goal without any permission claim: missing grant, still no execution.
      repo.createAutonomyPurpose(sessionId, goalBody("walk daily"), {
        key: randomUUID(),
        now: T0 + 95,
      });
      const goalReq = repo.requestShadowDeliberation(
        sessionId,
        { scope: "health" },
        { key: randomUUID(), now: T0 + 100 },
      );
      const goalClaim = repo.claimShadowJob(
        sessionId,
        goalReq.body.id,
        { owner: "worker-1", expectedVersion: 1 },
        { now: T0 + 110 },
      );
      const goalLabel = goalClaim.context?.purposes[0]?.label as string;
      const goalDone = repo.completeShadowJob(
        sessionId,
        goalReq.body.id,
        validOutput([goalLabel], {
          decision: "execute",
          proposedAction: { kind: "message", summary: "nudge the user" },
        }),
        { expectedVersion: 2, leaseOwner: "worker-1", now: T0 + 120 },
      );
      expect(goalDone.outcome).toBe("completed");
      expect(goalDone.policyCode).toBe("missing_grant");
      // Goal WITH a recorded permission claim: still shadow only — the
      // recorded permission NEVER becomes a grant.
      repo.createAutonomyPurpose(
        sessionId,
        {
          scope: "health",
          statement: "user permits local reminders",
          kind: "permission",
          explicit: true,
          sourceKind: "user",
        },
        { key: randomUUID(), now: T0 + 130 },
      );
      const grantReq = repo.requestShadowDeliberation(
        sessionId,
        { scope: "health" },
        { key: randomUUID(), now: T0 + 140 },
      );
      const grantClaim = repo.claimShadowJob(
        sessionId,
        grantReq.body.id,
        { owner: "worker-1", expectedVersion: 1 },
        { now: T0 + 150 },
      );
      expect(
        (grantClaim.context?.permissionClaims ?? []).length,
      ).toBeGreaterThan(0);
      const goalEvidence = grantClaim.context?.purposes.find(
        (p) => p.kind === "goal",
      )?.label as string;
      const grantDone = repo.completeShadowJob(
        sessionId,
        grantReq.body.id,
        validOutput([goalEvidence], {
          decision: "execute",
          proposedAction: { kind: "message", summary: "send a reminder" },
        }),
        { expectedVersion: 2, leaseOwner: "worker-1", now: T0 + 160 },
      );
      expect(grantDone.outcome).toBe("completed");
      // CLAIM != GRANT: even WITH a recorded permission claim, execute
      // stays unauthorized (missing_grant); nothing executes.
      expect(grantDone.policyCode).toBe("missing_grant");
      // Zero execution surface: no grant/calendar/tool columns exist, and
      // stored decisions carry no grant keys.
      const cols = (
        handle.raw.prepare("PRAGMA table_info(shadow_jobs)").all() as {
          name: string;
        }[]
      ).map((c) => c.name);
      expect(cols.join(" ")).not.toMatch(/grant|calendar|tool|budget/i);
      const stored = handle.raw
        .prepare(
          "SELECT model_decision_json AS j, policy_code AS p FROM shadow_jobs WHERE id = ?",
        )
        .get(grantReq.body.id) as { j: string; p: string };
      expect(stored.p).toBe("missing_grant");
      expect(Object.keys(JSON.parse(stored.j)).sort()).toEqual(
        [
          "completion",
          "counterargument",
          "decision",
          "evidenceIds",
          "proposedAction",
          "reason",
          "stopConditions",
          "uncertainty",
        ].sort(),
      );
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("completes do-nothing genuinely and validates task-draft deadlines", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      unpause(repo, 1, T0 + 10);
      const deadline = "2026-10-20T10:00:00+00:00";
      const task = repo.createAutonomyTask(
        sessionId,
        {
          scope: "health",
          title: "evening walk",
          kind: "task",
          speaker: "user",
          deadline,
        },
        { key: randomUUID(), now: T0 + 20 },
      );
      expect(task.body.deadline).toBe(deadline);
      const requested = repo.requestShadowDeliberation(
        sessionId,
        { scope: "health" },
        { key: randomUUID(), now: T0 + 30 },
      );
      const claimed = repo.claimShadowJob(
        sessionId,
        requested.body.id,
        { owner: "worker-1", expectedVersion: 1 },
        { now: T0 + 40 },
      );
      expect(claimed.context?.explicitDeadlines).toContain(deadline);
      const taskLabel = claimed.context?.tasks[0]?.label as string;
      // do-nothing with a null action completes genuinely (no_action).
      const calm = repo.completeShadowJob(
        sessionId,
        requested.body.id,
        validOutput([taskLabel]),
        { expectedVersion: 2, leaseOwner: "worker-1", now: T0 + 50 },
      );
      expect(calm.outcome).toBe("completed");
      expect(calm.policyCode).toBe("no_action");
      // A matching explicit deadline is accepted on a task draft.
      const requested2 = repo.requestShadowDeliberation(
        sessionId,
        { scope: "health" },
        { key: randomUUID(), now: T0 + 60 },
      );
      repo.claimShadowJob(
        sessionId,
        requested2.body.id,
        { owner: "worker-1", expectedVersion: 1 },
        { now: T0 + 70 },
      );
      const matched = repo.completeShadowJob(
        sessionId,
        requested2.body.id,
        validOutput([taskLabel], {
          decision: "execute",
          proposedAction: {
            kind: "local_task",
            summary: "local reminder draft",
            taskDraft: { title: "evening walk reminder", deadline },
          },
        }),
        { expectedVersion: 2, leaseOwner: "worker-1", now: T0 + 80 },
      );
      expect(matched.outcome).toBe("completed");
      expect(matched.policyCode).toBe("missing_grant");
      // A creative calendar date (not an explicit input) is rejected.
      const requested3 = repo.requestShadowDeliberation(
        sessionId,
        { scope: "health" },
        { key: randomUUID(), now: T0 + 90 },
      );
      repo.claimShadowJob(
        sessionId,
        requested3.body.id,
        { owner: "worker-1", expectedVersion: 1 },
        { now: T0 + 100 },
      );
      expect(() =>
        repo.completeShadowJob(
          sessionId,
          requested3.body.id,
          validOutput([taskLabel], {
            decision: "execute",
            proposedAction: {
              kind: "local_task",
              summary: "invented schedule",
              taskDraft: {
                title: "surprise party",
                deadline: "2026-12-25T10:00:00+00:00",
              },
            },
          }),
          { expectedVersion: 2, leaseOwner: "worker-1", now: T0 + 110 },
        ),
      ).toThrow(RepositoryValidationError);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("keeps scope completeness: other-scope flood never drops an in-scope constraint; same-scope overflow holds", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      unpause(repo, 1, T0 + 10);
      // Old in-scope constraint created FIRST.
      const oldConstraint = repo.createAutonomyPurpose(
        sessionId,
        {
          scope: "work",
          statement: "no deploys after 18:00",
          kind: "constraint",
          explicit: true,
          sourceKind: "user",
        },
        { key: randomUUID(), now: T0 + 20 },
      );
      // Flood ANOTHER scope with >100 records (newest-first truncation
      // would previously hide the old in-scope record).
      for (let i = 0; i < 105; i++) {
        repo.createAutonomyPurpose(
          sessionId,
          {
            scope: "noise",
            statement: `noise goal ${i}`,
            kind: "goal",
            explicit: true,
            sourceKind: "user",
          },
          { key: randomUUID(), now: T0 + 30 + i },
        );
      }
      const req = repo.requestShadowDeliberation(
        sessionId,
        { scope: "work" },
        { key: randomUUID(), now: T0 + 500 },
      );
      const claimed = repo.claimShadowJob(
        sessionId,
        req.body.id,
        { owner: "worker-1", expectedVersion: 1 },
        { now: T0 + 510 },
      );
      expect(claimed.outcome).toBe("claimed");
      // The old in-scope constraint survives the other-scope flood.
      expect(
        (claimed.context?.activeConstraintIds ?? []).includes(
          oldConstraint.body.id,
        ),
      ).toBe(true);
      // GLOBAL one-claimed-job-at-once: land this claim terminal before the
      // overflow claim below (concurrent live leases are refused, never
      // silently shared).
      const workLabel = claimed.context?.purposes[0]?.label as string;
      const workDone = repo.completeShadowJob(
        sessionId,
        req.body.id,
        validOutput([workLabel]),
        { expectedVersion: 2, leaseOwner: "worker-1", now: T0 + 520 },
      );
      expect(workDone.outcome).toBe("completed");
      // Same-scope overflow (101 in-scope purposes) holds honestly.
      for (let i = 0; i < 101; i++) {
        repo.createAutonomyPurpose(
          sessionId,
          {
            scope: "packed",
            statement: `packed goal ${i}`,
            kind: "goal",
            explicit: true,
            sourceKind: "user",
          },
          { key: randomUUID(), now: T0 + 600 + i },
        );
      }
      const overflowReq = repo.requestShadowDeliberation(
        sessionId,
        { scope: "packed" },
        { key: randomUUID(), now: T0 + 800 },
      );
      const overflowClaim = repo.claimShadowJob(
        sessionId,
        overflowReq.body.id,
        { owner: "worker-1", expectedVersion: 1 },
        { now: T0 + 810 },
      );
      expect(overflowClaim.outcome).toBe("held");
      expect(overflowClaim.job.status).toBe("held");
      expect(overflowClaim.job.holdReason).toBe("context_too_large");
      expect(overflowClaim.context).toBeNull();
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("applies time applicability: expired constraints never gate unrelated work, crossings hold stale proposals", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      unpause(repo, 1, T0 + 10);
      // A temporary feeling that already EXPIRED before the claim.
      repo.createAutonomyPurpose(
        sessionId,
        {
          scope: "health",
          statement: "temporary quiet hours",
          kind: "constraint",
          explicit: true,
          sourceKind: "user",
          validFrom: "2020-01-01T00:00:00+00:00",
          validUntil: "2020-01-02T00:00:00+00:00",
        },
        { key: randomUUID(), now: T0 + 20 },
      );
      const goal = repo.createAutonomyPurpose(
        sessionId,
        goalBody("walk daily"),
        { key: randomUUID(), now: T0 + 30 },
      );
      void goal;
      const req = repo.requestShadowDeliberation(
        sessionId,
        { scope: "health" },
        { key: randomUUID(), now: T0 + 40 },
      );
      const claimed = repo.claimShadowJob(
        sessionId,
        req.body.id,
        { owner: "worker-1", expectedVersion: 1 },
        { now: T0 + 50 },
      );
      expect(claimed.outcome).toBe("claimed");
      // The expired constraint stays in history but is NOT promoted.
      expect(claimed.context?.purposes.length ?? 0).toBeGreaterThanOrEqual(2);
      expect(claimed.context?.activeConstraintIds ?? []).toHaveLength(0);
      // Genuine do-nothing completes despite the retained expired record.
      const goalLabel = claimed.context?.purposes.find((p) => p.kind === "goal")
        ?.label as string;
      const done = repo.completeShadowJob(
        sessionId,
        req.body.id,
        validOutput([goalLabel]),
        { expectedVersion: 2, leaseOwner: "worker-1", now: T0 + 60 },
      );
      expect(done.outcome).toBe("completed");
      expect(done.policyCode).toBe("no_action");
      // A window boundary crossed DURING the call holds the stale proposal.
      const windowUntil = "2026-06-01T00:00:00+00:00";
      const crossing = repo.createAutonomyPurpose(
        sessionId,
        {
          scope: "focus",
          statement: "focus block",
          kind: "constraint",
          explicit: true,
          sourceKind: "user",
          validFrom: "2020-01-01T00:00:00+00:00",
          validUntil: windowUntil,
        },
        { key: randomUUID(), now: T0 + 70 },
      );
      void crossing;
      const windowMs = Date.parse(windowUntil);
      const req2 = repo.requestShadowDeliberation(
        sessionId,
        { scope: "focus" },
        { key: randomUUID(), now: T0 + 80 },
      );
      const claim2 = repo.claimShadowJob(
        sessionId,
        req2.body.id,
        { owner: "worker-1", expectedVersion: 1 },
        { now: windowMs - 60_000 },
      );
      expect(claim2.outcome).toBe("claimed");
      expect(claim2.context?.activeConstraintIds ?? []).toHaveLength(1);
      const focusLabel = claim2.context?.purposes[0]?.label as string;
      const late = repo.completeShadowJob(
        sessionId,
        req2.body.id,
        validOutput([focusLabel]),
        {
          expectedVersion: 2,
          leaseOwner: "worker-1",
          now: windowMs + 1,
        },
      );
      expect(late.outcome).toBe("held");
      expect(late.job.holdReason).toBe("target_inapplicable");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("never invents deadlines: windows are not deadlines and uncited dates cannot be adopted", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      unpause(repo, 1, T0 + 10);
      // A purpose window alone creates NO deadline allowlist entry.
      const windowUntil = "2026-11-02T10:00:00+00:00";
      const win = repo.createAutonomyPurpose(
        sessionId,
        {
          scope: "health",
          statement: "seasonal goal",
          kind: "goal",
          explicit: true,
          sourceKind: "user",
          validFrom: "2026-11-01T10:00:00+00:00",
          validUntil: windowUntil,
        },
        { key: randomUUID(), now: T0 + 20 },
      );
      void win;
      const req = repo.requestShadowDeliberation(
        sessionId,
        { scope: "health" },
        { key: randomUUID(), now: T0 + 30 },
      );
      const claimed = repo.claimShadowJob(
        sessionId,
        req.body.id,
        { owner: "worker-1", expectedVersion: 1 },
        { now: T0 + 40 },
      );
      // No dated task exists: the window must NOT appear as a deadline.
      expect(claimed.context?.explicitDeadlines ?? []).not.toContain(
        windowUntil,
      );
      expect(claimed.context?.explicitDeadlines ?? []).toHaveLength(0);
      const goalLabel = claimed.context?.purposes.find((p) => p.kind === "goal")
        ?.label as string;
      expect(() =>
        repo.completeShadowJob(
          sessionId,
          req.body.id,
          validOutput([goalLabel], {
            decision: "execute",
            proposedAction: {
              kind: "local_task",
              summary: "window-as-deadline",
              taskDraft: { title: "borrowed window", deadline: windowUntil },
            },
          }),
          { expectedVersion: 2, leaseOwner: "worker-1", now: T0 + 50 },
        ),
      ).toThrow(RepositoryValidationError);
      // The rejected claim stays owned until landed terminal: fail it
      // honestly (GLOBAL one-claimed-job-at-once forbids a second live
      // lease while it sits CLAIMED).
      const windowFailed = repo.failShadowJob(
        sessionId,
        req.body.id,
        { expectedVersion: 2, code: "model_error" },
        { now: T0 + 55 },
      );
      expect(windowFailed.status).toBe("failed");
      // Two dated tasks: borrowing the UNCITED task's date is rejected,
      // citing the task's own date is allowed.
      const dateA = "2026-10-20T10:00:00+00:00";
      const dateB = "2026-10-21T10:00:00+00:00";
      repo.createAutonomyTask(
        sessionId,
        {
          scope: "health",
          title: "task A",
          kind: "task",
          speaker: "user",
          deadline: dateA,
        },
        { key: randomUUID(), now: T0 + 60 },
      );
      repo.createAutonomyTask(
        sessionId,
        {
          scope: "health",
          title: "task B",
          kind: "task",
          speaker: "user",
          deadline: dateB,
        },
        { key: randomUUID(), now: T0 + 70 },
      );
      const req2 = repo.requestShadowDeliberation(
        sessionId,
        { scope: "health" },
        { key: randomUUID(), now: T0 + 80 },
      );
      const claim2 = repo.claimShadowJob(
        sessionId,
        req2.body.id,
        { owner: "worker-1", expectedVersion: 1 },
        { now: T0 + 90 },
      );
      const labelA = claim2.context?.tasks.find((t) => t.title === "task A")
        ?.label as string;
      const labelB = claim2.context?.tasks.find((t) => t.title === "task B")
        ?.label as string;
      // Cite only task A but borrow task B's date: rejected.
      expect(() =>
        repo.completeShadowJob(
          sessionId,
          req2.body.id,
          validOutput([labelA], {
            decision: "execute",
            proposedAction: {
              kind: "local_task",
              summary: "borrowed date",
              taskDraft: { title: "draft", deadline: dateB },
            },
          }),
          { expectedVersion: 2, leaseOwner: "worker-1", now: T0 + 100 },
        ),
      ).toThrow(RepositoryValidationError);
      // Cite task B with its own date: allowed (still unauthorized).
      const ok = repo.completeShadowJob(
        sessionId,
        req2.body.id,
        validOutput([labelB], {
          decision: "execute",
          proposedAction: {
            kind: "local_task",
            summary: "own date",
            taskDraft: { title: "draft", deadline: dateB },
          },
        }),
        { expectedVersion: 2, leaseOwner: "worker-1", now: T0 + 110 },
      );
      expect(ok.outcome).toBe("completed");
      expect(ok.policyCode).toBe("missing_grant");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("rejects non-frozen evidence, forbidden fields, and bad combinations", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      unpause(repo, 1, T0 + 10);
      repo.createAutonomyPurpose(sessionId, goalBody("walk daily"), {
        key: randomUUID(),
        now: T0 + 20,
      });
      const requested = repo.requestShadowDeliberation(
        sessionId,
        { scope: "health" },
        { key: randomUUID(), now: T0 + 30 },
      );
      const claimed = repo.claimShadowJob(
        sessionId,
        requested.body.id,
        { owner: "worker-1", expectedVersion: 1 },
        { now: T0 + 40 },
      );
      const label = claimed.context?.purposes[0]?.label as string;
      const attempt = (output: unknown) =>
        repo.completeShadowJob(sessionId, requested.body.id, output, {
          expectedVersion: 2,
          leaseOwner: "worker-1",
          now: T0 + 50,
        });
      // Arbitrary conversation-style ids are not frozen labels.
      expect(() => attempt(validOutput(["r1"]))).toThrow(
        RepositoryValidationError,
      );
      // Grant/permission/budget/bypass fields are strictly rejected.
      expect(() =>
        attempt({
          ...validOutput([label]),
          grant: "calendar.write",
        }),
      ).toThrow(RepositoryValidationError);
      expect(() =>
        attempt({
          ...validOutput([label]),
          budget: 100,
        }),
      ).toThrow(RepositoryValidationError);
      // execute requires an action; do-nothing forbids one.
      expect(() =>
        attempt(validOutput([label], { decision: "execute" })),
      ).toThrow(RepositoryValidationError);
      expect(() =>
        attempt(
          validOutput([label], {
            proposedAction: { kind: "message", summary: "hi" },
          }),
        ),
      ).toThrow(RepositoryValidationError);
      // The job is untouched by rejected outputs: still claimed, same version.
      const job = repo.getShadowJob(sessionId, requested.body.id);
      expect(job.status).toBe("claimed");
      expect(job.version).toBe(2);
      expect(
        (job as unknown as Record<string, unknown>).modelDecisionJson,
      ).toBeUndefined();
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("aborts from the foreground without pretending a decision", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      unpause(repo, 1, T0 + 10);
      const requested = repo.requestShadowDeliberation(
        sessionId,
        { scope: "health" },
        { key: randomUUID(), now: T0 + 20 },
      );
      repo.claimShadowJob(
        sessionId,
        requested.body.id,
        { owner: "worker-1", expectedVersion: 1 },
        { now: T0 + 30 },
      );
      const held = repo.holdShadowJob(
        sessionId,
        requested.body.id,
        { expectedVersion: 2, reason: "aborted_foreground" },
        { now: T0 + 40 },
      );
      expect(held.status).toBe("held");
      expect(held.holdReason).toBe("aborted_foreground");
      expect(() =>
        repo.completeShadowJob(
          sessionId,
          requested.body.id,
          validOutput(["sP1"]),
          { expectedVersion: 3, leaseOwner: "worker-1", now: T0 + 50 },
        ),
      ).toThrow(ShadowStateConflictError);
      // Wrong worker cannot steal the lease; stale versions conflict.
      const requested2 = repo.requestShadowDeliberation(
        sessionId,
        { scope: "health" },
        { key: randomUUID(), now: T0 + 60 },
      );
      repo.claimShadowJob(
        sessionId,
        requested2.body.id,
        { owner: "worker-1", expectedVersion: 1 },
        { now: T0 + 70 },
      );
      const ctx = repo.getShadowJobContext(sessionId, requested2.body.id);
      const label = ctx.purposes[0]?.label ?? "sP1";
      expect(() =>
        repo.completeShadowJob(
          sessionId,
          requested2.body.id,
          validOutput([label]),
          { expectedVersion: 2, leaseOwner: "worker-2", now: T0 + 80 },
        ),
      ).toThrow(ShadowLeaseConflictError);
      expect(() =>
        repo.holdShadowJob(
          sessionId,
          requested2.body.id,
          { expectedVersion: 1, reason: "aborted_foreground" },
          { now: T0 + 90 },
        ),
      ).toThrow(ShadowVersionConflictError);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("fails with fixed redacted codes and versions conflict on stale writers", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      unpause(repo, 1, T0 + 10);
      const requested = repo.requestShadowDeliberation(
        sessionId,
        { scope: "health" },
        { key: randomUUID(), now: T0 + 20 },
      );
      const failed = repo.failShadowJob(
        sessionId,
        requested.body.id,
        { expectedVersion: 1, code: "gateway_empty" },
        { now: T0 + 30 },
      );
      expect(failed.status).toBe("failed");
      expect(failed.failCode).toBe("gateway_empty");
      expect(() =>
        repo.failShadowJob(
          sessionId,
          requested.body.id,
          { expectedVersion: 2, code: "free text leak" },
          { now: T0 + 40 },
        ),
      ).toThrow();
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

describe("shadow review safety fixes", () => {
  it("enforces GLOBAL one-claimed-job-at-once: busy newcomer stays pending, never spins, claims after the first lands terminal", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      unpause(repo, 1, T0 + 10);
      repo.createAutonomyPurpose(
        sessionId,
        {
          scope: "alpha",
          statement: "alpha goal",
          kind: "goal",
          explicit: true,
          sourceKind: "user",
        },
        { key: randomUUID(), now: T0 + 15 },
      );
      const reqA = repo.requestShadowDeliberation(
        sessionId,
        { scope: "alpha" },
        { key: randomUUID(), now: T0 + 20 },
      );
      const reqB = repo.requestShadowDeliberation(
        sessionId,
        { scope: "beta" },
        { key: randomUUID(), now: T0 + 30 },
      );
      const claimA = repo.claimShadowJob(
        sessionId,
        reqA.body.id,
        { owner: "worker-1", expectedVersion: 1 },
        { now: T0 + 40 },
      );
      expect(claimA.outcome).toBe("claimed");
      // A second live lease is refused: the newcomer is NOT dropped/failed
      // and NEVER steals the old lease.
      expect(() =>
        repo.claimShadowJob(
          sessionId,
          reqB.body.id,
          { owner: "worker-2", expectedVersion: 1 },
          { now: T0 + 50 },
        ),
      ).toThrow(ShadowWorkerBusyError);
      const stillPending = repo.getShadowJob(sessionId, reqB.body.id);
      expect(stillPending.status).toBe("pending");
      expect(stillPending.leaseOwner).toBeNull();
      expect(stillPending.version).toBe(1);
      // The queue read does not spin while a live lease exists.
      expect(repo.readPendingShadowJob()).toBeNull();
      // At most one claimed job exists across all sessions/scopes.
      const claimedCount = (
        handle.raw
          .prepare(
            "SELECT COUNT(*) AS n FROM shadow_jobs WHERE status = 'claimed'",
          )
          .get() as { n: number }
      ).n;
      expect(claimedCount).toBe(1);
      // After the first job lands terminal, the second claims normally.
      const alphaLabel = claimA.context?.purposes[0]?.label as string;
      const doneA = repo.completeShadowJob(
        sessionId,
        reqA.body.id,
        validOutput([alphaLabel]),
        { expectedVersion: 2, leaseOwner: "worker-1", now: T0 + 60 },
      );
      expect(doneA.outcome).toBe("completed");
      const claimB = repo.claimShadowJob(
        sessionId,
        reqB.body.id,
        { owner: "worker-2", expectedVersion: 1 },
        { now: T0 + 70 },
      );
      expect(claimB.outcome).toBe("claimed");
      const claimedAgain = (
        handle.raw
          .prepare(
            "SELECT COUNT(*) AS n FROM shadow_jobs WHERE status = 'claimed'",
          )
          .get() as { n: number }
      ).n;
      expect(claimedAgain).toBe(1);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("holds the global fence across two actual SQLite connections on the same file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "companion-shadow-fence-"));
    const dbPath = join(dir, "fence.sqlite");
    const first = openKernelDatabase(dbPath);
    try {
      await migrateKernelDatabase({ db: first.raw });
      // The cross-connection backstop index ships with the migration.
      const index = first.raw
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'ux_shadow_jobs_single_claimed'",
        )
        .get() as { name: string } | undefined;
      expect(index?.name).toBe("ux_shadow_jobs_single_claimed");
      const repo1 = createKernelRepository(first.raw);
      const session = repo1.createSession({ key: randomUUID(), now: T0 });
      const sessionId = session.body.sessionId;
      repo1.setAutonomyControlState(
        { paused: false, expectedVersion: 1 },
        { key: randomUUID(), now: T0 + 10 },
      );
      repo1.createAutonomyPurpose(sessionId, goalBody("alpha goal"), {
        key: randomUUID(),
        now: T0 + 20,
      });
      const second = openKernelDatabase(dbPath);
      try {
        const repo2 = createKernelRepository(second.raw);
        const jobs = repo1.listShadowJobs(sessionId, { limit: 10 });
        const policyJobs = jobs.items.filter(
          (job) => job.kind === "policy_change" && job.status === "pending",
        );
        expect(policyJobs.length).toBeGreaterThanOrEqual(1);
        const jobA = policyJobs[0]?.id as string;
        const reqB = repo1.requestShadowDeliberation(
          sessionId,
          { scope: "beta" },
          { key: randomUUID(), now: T0 + 30 },
        );
        // First connection claims; the second connection (DIFFERENT job,
        // different scope) sees BUSY-pending, never steals the lease.
        const claimA = repo1.claimShadowJob(
          sessionId,
          jobA,
          { owner: "worker-1", expectedVersion: 1 },
          { now: T0 + 40 },
        );
        expect(claimA.outcome).toBe("claimed");
        expect(repo2.readPendingShadowJob()).toBeNull();
        expect(() =>
          repo2.claimShadowJob(
            sessionId,
            reqB.body.id,
            { owner: "worker-2", expectedVersion: 1 },
            { now: T0 + 50 },
          ),
        ).toThrow(ShadowWorkerBusyError);
        expect(repo2.getShadowJob(sessionId, reqB.body.id).status).toBe(
          "pending",
        );
        const claimedCount = (
          first.raw
            .prepare(
              "SELECT COUNT(*) AS n FROM shadow_jobs WHERE status = 'claimed'",
            )
            .get() as { n: number }
        ).n;
        expect(claimedCount).toBe(1);
        // First job terminal => the second connection can claim.
        const label = claimA.context?.purposes[0]?.label as string;
        repo1.completeShadowJob(sessionId, jobA, validOutput([label]), {
          expectedVersion: 2,
          leaseOwner: "worker-1",
          now: T0 + 60,
        });
        const claimB = repo2.claimShadowJob(
          sessionId,
          reqB.body.id,
          { owner: "worker-2", expectedVersion: 1 },
          { now: T0 + 70 },
        );
        expect(claimB.outcome).toBe("claimed");
      } finally {
        closeKernelDatabase(second);
      }
    } finally {
      closeKernelDatabase(first);
    }
  });

  it("holds honestly on 120 explicit conflict pairs (no silent truncation) and still claims exactly 100", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      unpause(repo, 1, T0 + 10);
      // 16 active purposes => 120 explicit pairs, BELOW the 100-record
      // purpose/task cap: every relation must survive or the job holds.
      const ids: string[] = [];
      for (let i = 0; i < 16; i += 1) {
        const created = repo.createAutonomyPurpose(
          sessionId,
          {
            scope: "rel",
            statement: `standing goal ${i}`,
            kind: "goal",
            explicit: true,
            sourceKind: "user",
          },
          { key: randomUUID(), now: T0 + 20 + i },
        );
        ids.push(created.body.id);
      }
      for (let a = 0; a < ids.length; a += 1) {
        for (let b = a + 1; b < ids.length; b += 1) {
          repo.recordAutonomyPurposeConflict(
            sessionId,
            { purposeAId: ids[a] as string, purposeBId: ids[b] as string },
            { key: randomUUID(), now: T0 + 100 },
          );
        }
      }
      expect(storedConflictPairs(handle)).toBe(120);
      const req = repo.requestShadowDeliberation(
        sessionId,
        { scope: "rel" },
        { key: randomUUID(), now: T0 + 200 },
      );
      const held = repo.claimShadowJob(
        sessionId,
        req.body.id,
        { owner: "worker-1", expectedVersion: 1 },
        { now: T0 + 210 },
      );
      expect(held.outcome).toBe("held");
      expect(held.job.status).toBe("held");
      expect(held.job.holdReason).toBe("context_too_large");
      expect(held.context).toBeNull();
      // No history rewritten, no pairs deleted: the relations stand.
      expect(storedConflictPairs(handle)).toBe(120);
      // Exactly 100 pairs still claims when the context fits.
      const other = repo.createSession({ key: randomUUID(), now: T0 + 300 });
      const otherId = other.body.sessionId as string;
      const twenty: string[] = [];
      for (let i = 0; i < 20; i += 1) {
        const created = repo.createAutonomyPurpose(
          otherId,
          {
            scope: "mesh",
            statement: `mesh goal ${i}`,
            kind: "goal",
            explicit: true,
            sourceKind: "user",
          },
          { key: randomUUID(), now: T0 + 310 + i },
        );
        twenty.push(created.body.id);
      }
      let recorded = 0;
      for (let a = 0; a < twenty.length && recorded < 100; a += 1) {
        for (let b = a + 1; b < twenty.length && recorded < 100; b += 1) {
          repo.recordAutonomyPurposeConflict(
            otherId,
            {
              purposeAId: twenty[a] as string,
              purposeBId: twenty[b] as string,
            },
            { key: randomUUID(), now: T0 + 400 },
          );
          recorded += 1;
        }
      }
      expect(recorded).toBe(100);
      const reqFit = repo.requestShadowDeliberation(
        otherId,
        { scope: "mesh" },
        { key: randomUUID(), now: T0 + 500 },
      );
      const fit = repo.claimShadowJob(
        otherId,
        reqFit.body.id,
        { owner: "worker-1", expectedVersion: 1 },
        { now: T0 + 510 },
      );
      expect(fit.outcome).toBe("claimed");
      expect(fit.context?.conflictPairs).toHaveLength(100);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("leaves a semantically rejected completion CLAIMED under its lease (never silently terminal)", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      unpause(repo, 1, T0 + 10);
      repo.createAutonomyPurpose(sessionId, goalBody("walk daily"), {
        key: randomUUID(),
        now: T0 + 20,
      });
      const deadline = "2026-10-21T10:00:00+00:00";
      repo.createAutonomyTask(
        sessionId,
        {
          scope: "health",
          title: "evening walk",
          kind: "task",
          speaker: "user",
          deadline,
        },
        { key: randomUUID(), now: T0 + 25 },
      );
      const req = repo.requestShadowDeliberation(
        sessionId,
        { scope: "health" },
        { key: randomUUID(), now: T0 + 30 },
      );
      const claimed = repo.claimShadowJob(
        sessionId,
        req.body.id,
        { owner: "worker-1", expectedVersion: 1 },
        { now: T0 + 40 },
      );
      const purposeLabel = claimed.context?.purposes.find(
        (p) => p.kind === "goal",
      )?.label as string;
      // Unknown frozen label: syntactically valid output the fence rejects.
      expect(() =>
        repo.completeShadowJob(sessionId, req.body.id, validOutput(["sP999"]), {
          expectedVersion: 2,
          leaseOwner: "worker-1",
          now: T0 + 50,
        }),
      ).toThrow(RepositoryValidationError);
      // Uncited draft deadline (matches an explicit deadline no evidence
      // cites): likewise rejected, lease untouched.
      expect(() =>
        repo.completeShadowJob(
          sessionId,
          req.body.id,
          validOutput([purposeLabel], {
            decision: "execute",
            proposedAction: {
              kind: "local_task",
              summary: "borrowed date draft",
              taskDraft: { title: "borrowed", deadline },
            },
          }),
          { expectedVersion: 2, leaseOwner: "worker-1", now: T0 + 60 },
        ),
      ).toThrow(RepositoryValidationError);
      // The TX rolled back: the job is STILL claimed under OUR lease with
      // no terminal outcome recorded — the runtime (not the kernel) lands
      // it failed before the next claim.
      const current = repo.getShadowJob(sessionId, req.body.id);
      expect(current.status).toBe("claimed");
      expect(current.version).toBe(2);
      expect(current.leaseOwner).toBe("worker-1");
      expect(current.policyCode).toBeNull();
      expect(current.holdReason).toBeNull();
      expect(current.failCode).toBeNull();
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
