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
//   wish -> wish_not_command, external text -> external_no_authority, no
//   permission claim -> missing_grant, claim present -> shadow_noexecution
//   (recorded permission NEVER becomes a grant; zero execution performed);
// - do-nothing is genuinely representable (completed/no_action), never a
//   fake failure fallback;
// - a foreground abort holds without pretending a decision was made.

import { randomUUID } from "node:crypto";
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
      expect(grantDone.policyCode).toBe("shadow_noexecution");
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
      expect(stored.p).toBe("shadow_noexecution");
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
