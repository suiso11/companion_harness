// Codex #51 P2 (3/3) regressions: trial detail by id, autonomy/trial
// idempotency scope lookup, proposal view bound parity, approve expiry
// persistence, malformed future-constraint fail-closed deadline.
// Real DB + production repository.
import { randomUUID } from "node:crypto";
import {
  IDEMPOTENCY_SCOPE_AUTONOMY_CONTROL,
  IdempotencyScopeSchema,
  purposeConflictScope,
  purposeCreateScope,
  purposeOpScope,
  taskCreateScope,
  taskOpScope,
  trialClaimScope,
  trialPermitScope,
  trialProposalScope,
  trialStageScope,
} from "@companion/contracts";
import { describe, expect, it } from "vitest";
import {
  closeKernelDatabase,
  createKernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
  RepositoryNotFoundError,
  RepositoryValidationError,
} from "../src/index.js";

const NOW = 1_750_000_000_000;
const REV = "a".repeat(40);
const FP = "b".repeat(64);
function profile(extra: Record<string, unknown> = {}) {
  return {
    available: true,
    enabled: true,
    mandatoryChecks: ["lint"],
    configFingerprint: FP,
    sourceRevision: REV,
    currentModel: "test-model",
    disclosedWholeRepoRead: true,
    timeoutMs: 60000,
    maxOutputBytes: 1000000,
    ...extra,
  };
}
async function makeRepo() {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  const repo = createKernelRepository(handle.raw);
  const session = repo.createSession({ key: randomUUID(), now: NOW });
  const ctl = repo.getAutonomyControlState();
  repo.setAutonomyControlState(
    { paused: false, expectedVersion: ctl.version },
    { key: randomUUID(), now: NOW + 1 },
  );
  return { handle, repo, sessionId: session.body.sessionId };
}
function goalTask(
  repo: ReturnType<typeof createKernelRepository>,
  sessionId: string,
  scope: string,
) {
  const g = repo.createAutonomyPurpose(
    sessionId,
    {
      scope,
      statement: "ship it",
      kind: "goal",
      explicit: true,
      sourceKind: "user",
    },
    { key: randomUUID(), now: NOW + 2 },
  );
  const t = repo.createAutonomyTask(
    sessionId,
    {
      scope,
      title: "do work",
      kind: "task",
      speaker: "user",
      parentPurposeId: g.body.id,
    },
    { key: randomUUID(), now: NOW + 3 },
  );
  return { goal: g.body, task: t.body };
}
function stageInput(taskId: string, extra: Record<string, unknown> = {}) {
  return {
    taskId,
    objective: "obj",
    acceptance: ["done"],
    literalPatchPaths: ["src/a.ts"],
    operation: "implement",
    readOnlyMode: false,
    expiry: new Date(NOW + 3600_000).toISOString(),
    possibleExternalDataConsent: true,
    objectiveResourceCaps: { timeoutMs: 5000, maxOutputBytes: 10000 },
    requiredChecks: ["lint"],
    ...extra,
  };
}

describe("codex3/3: trial detail reads by id, not by list page", () => {
  it("returns a proposal that falls outside the default list window", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const { task } = goalTask(repo, sessionId, "b1");
      const ids: string[] = [];
      for (let i = 0; i < 55; i++) {
        const st = repo.stageTrial(sessionId, stageInput(task.id), {
          key: randomUUID(),
          now: NOW + 4 + i,
          profile: profile(),
          workspaceAlias: "ws",
        });
        ids.push(st.body.id);
      }
      const oldest = ids[0] as string;
      const listed = repo.listTrials(sessionId, {});
      expect(listed.items).toHaveLength(50);
      expect(listed.items.map((item) => item.id)).not.toContain(oldest);
      // Direct by-id read still resolves the tail item.
      const single = repo.readTrial(sessionId, oldest);
      expect(single.id).toBe(oldest);
      // Foreign session stays 404.
      const other = repo.createSession({ key: randomUUID(), now: NOW + 5000 })
        .body.sessionId;
      expect(() => repo.readTrial(other, oldest)).toThrow(
        RepositoryNotFoundError,
      );
      expect(() => repo.readTrial(sessionId, randomUUID())).toThrow(
        RepositoryNotFoundError,
      );
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

describe("codex3/3: autonomy/trial idempotency scope lookup", () => {
  it("accepts the new scopes and rejects unknown ones", () => {
    const sid = randomUUID();
    const pid = randomUUID();
    const eid = randomUUID();
    expect(() =>
      IdempotencyScopeSchema.parse(trialStageScope(sid)),
    ).not.toThrow();
    expect(() =>
      IdempotencyScopeSchema.parse(trialProposalScope(pid)),
    ).not.toThrow();
    expect(() =>
      IdempotencyScopeSchema.parse(trialClaimScope(eid)),
    ).not.toThrow();
    expect(() =>
      IdempotencyScopeSchema.parse(trialPermitScope(eid)),
    ).not.toThrow();
    expect(() =>
      IdempotencyScopeSchema.parse(purposeConflictScope(sid, pid, eid)),
    ).not.toThrow();
    expect(() =>
      IdempotencyScopeSchema.parse(`session:${sid}:purpose`),
    ).not.toThrow();
    expect(() =>
      IdempotencyScopeSchema.parse(`session:${sid}:task`),
    ).not.toThrow();
    expect(() =>
      IdempotencyScopeSchema.parse(`purpose:${pid}:correct`),
    ).not.toThrow();
    expect(() =>
      IdempotencyScopeSchema.parse(`task:${pid}:hold`),
    ).not.toThrow();
    expect(() => IdempotencyScopeSchema.parse("trial-bogus:x")).toThrow();
  });

  it("resolves stored autonomy/trial rows for the owning session", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      // Global stop control.
      const ctlKey = randomUUID();
      const ctl = repo.getAutonomyControlState();
      repo.setAutonomyControlState(
        { paused: false, expectedVersion: ctl.version },
        { key: ctlKey, now: NOW + 2 },
      );
      expect(
        repo.lookupIdempotencyForSession(
          sessionId,
          ctlKey,
          IDEMPOTENCY_SCOPE_AUTONOMY_CONTROL,
        ),
      ).toMatchObject({ found: true });

      // Session-bound creates: purpose + task + trial-stage.
      const pKey = randomUUID();
      const created = repo.createAutonomyPurpose(
        sessionId,
        {
          scope: "b1",
          statement: "s",
          kind: "goal",
          explicit: true,
          sourceKind: "user",
        },
        { key: pKey, now: NOW + 3 },
      );
      expect(
        repo.lookupIdempotencyForSession(
          sessionId,
          pKey,
          purposeCreateScope(sessionId),
        ),
      ).toMatchObject({ found: true });
      const tKey = randomUUID();
      const tasked = repo.createAutonomyTask(
        sessionId,
        {
          scope: "b1",
          title: "t",
          kind: "task",
          speaker: "user",
          parentPurposeId: created.body.id,
        },
        { key: tKey, now: NOW + 4 },
      );
      void tasked;
      expect(
        repo.lookupIdempotencyForSession(
          sessionId,
          tKey,
          taskCreateScope(sessionId),
        ),
      ).toMatchObject({ found: true });

      const sKey = randomUUID();
      // Fresh pair for the trial flow: the purpose correction above bumps
      // versions, and approve re-checks frozen goal/task versions.
      const trialPair = goalTask(repo, sessionId, "b1trial");
      const staged = repo.stageTrial(sessionId, stageInput(trialPair.task.id), {
        key: sKey,
        now: NOW + 5,
        profile: profile(),
        workspaceAlias: "ws",
      });
      expect(
        repo.lookupIdempotencyForSession(
          sessionId,
          sKey,
          trialStageScope(sessionId),
        ),
      ).toMatchObject({ found: true, status: 201 });

      // Purpose/task mutation scopes.
      const cKey = randomUUID();
      const corrected = repo.correctAutonomyPurpose(
        sessionId,
        {
          purposeId: created.body.id,
          expectedVersion: created.body.version,
          scope: "b1",
          statement: "s2",
          kind: "goal",
          explicit: true,
          sourceKind: "user",
        },
        { key: cKey, now: NOW + 6 },
      );
      void corrected;
      expect(
        repo.lookupIdempotencyForSession(
          sessionId,
          cKey,
          purposeOpScope(created.body.id, "correct"),
        ),
      ).toMatchObject({ found: true });
      const hKey = randomUUID();
      // Hold a fresh task: correcting the parent goal above may move the
      // first task out of a holdable state.
      const holdPair = goalTask(repo, sessionId, "b1hold");
      const freshTask = repo.getAutonomyTask(sessionId, holdPair.task.id);
      const held = repo.holdAutonomyTask(
        sessionId,
        holdPair.task.id,
        {
          expectedVersion: freshTask.version,
          reason: "hold it",
          reconsiderTrigger: "later",
        },
        { key: hKey, now: NOW + 7 },
      );
      void held;
      expect(
        repo.lookupIdempotencyForSession(
          sessionId,
          hKey,
          taskOpScope(holdPair.task.id, "hold"),
        ),
      ).toMatchObject({ found: true });

      // Conflict scope (fresh active pair: the first purpose was corrected
      // above and is no longer active).
      const mkGoal = (statement: string, now: number) =>
        repo.createAutonomyPurpose(
          sessionId,
          {
            scope: "b1",
            statement,
            kind: "goal",
            explicit: true,
            sourceKind: "user",
          },
          { key: randomUUID(), now },
        ).body;
      const first = mkGoal("k-one", NOW + 8);
      const second = mkGoal("k-two", NOW + 9);
      const kKey = randomUUID();
      repo.recordAutonomyPurposeConflict(
        sessionId,
        { purposeAId: first.id, purposeBId: second.id },
        { key: kKey, now: NOW + 10 },
      );
      expect(
        repo.lookupIdempotencyForSession(
          sessionId,
          kKey,
          purposeConflictScope(sessionId, first.id, second.id),
        ),
      ).toMatchObject({ found: true });

      // Trial approve scope.
      const aKey = randomUUID();
      const approved = repo.approveTrial(sessionId, staged.body.id, {
        key: aKey,
        now: NOW + 10,
        profile: profile(),
        workspaceAlias: "ws",
      });
      const execId = (approved.body as { executionId: string }).executionId;
      expect(
        repo.lookupIdempotencyForSession(
          sessionId,
          aKey,
          trialProposalScope(staged.body.id),
        ),
      ).toMatchObject({ found: true, status: 201 });

      // Trial claim scope.
      const clKey = randomUUID();
      repo.claimTrial(sessionId, execId, {
        key: clKey,
        now: NOW + 11,
        profile: profile(),
        workspaceAlias: "ws",
      });
      expect(
        repo.lookupIdempotencyForSession(
          sessionId,
          clKey,
          trialClaimScope(execId),
        ),
      ).toMatchObject({ found: true });

      // Trial permit scope.
      repo.registerTrialWorkerBoot(
        {
          executionId: execId,
          sessionId,
          pid: 100,
          bootId: "boot-x",
          processStartTicks: "999",
        },
        NOW + 12,
      );
      const pmtKey = randomUUID();
      const claim = repo.claimTrial(sessionId, execId, {
        key: randomUUID(),
        now: NOW + 11,
        profile: profile(),
        workspaceAlias: "ws",
      });
      const req = (claim.body as { request: unknown }).request;
      repo.issueTrialLaunchPermit(sessionId, execId, {
        key: pmtKey,
        now: NOW + 13,
        observation: {
          scopeState: "active",
          frontendSettled: false,
          pid: 100,
          bootId: "boot-x",
          processStartTicks: "999",
          remainingRuntimeMs: 1000,
          timeoutMs: 5000,
          maxOutputBytes: 10000,
          foregroundGateOpen: true,
          observedAt: NOW + 13,
        } as never,
        profile: profile(),
        requestHash: repo.hashTrialLaunchRequest(req),
      });
      expect(
        repo.lookupIdempotencyForSession(
          sessionId,
          pmtKey,
          trialPermitScope(execId),
        ),
      ).toMatchObject({ found: true, status: 201 });

      // Unknown key resends; foreign session 404s.
      expect(
        repo.lookupIdempotencyForSession(
          sessionId,
          randomUUID(),
          trialStageScope(sessionId),
        ),
      ).toEqual({ found: false, code: "resend_required" });
      const foreign = repo.createSession({ key: randomUUID(), now: NOW + 5000 })
        .body.sessionId;
      expect(() =>
        repo.lookupIdempotencyForSession(
          foreign,
          sKey,
          trialStageScope(sessionId),
        ),
      ).toThrow(RepositoryNotFoundError);
      expect(() =>
        repo.lookupIdempotencyForSession(
          foreign,
          aKey,
          trialProposalScope(staged.body.id),
        ),
      ).toThrow(RepositoryNotFoundError);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

describe("codex3/3: proposal view objective bound matches staging", () => {
  it("stages a staging-max objective end to end", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const { task } = goalTask(repo, sessionId, "b1long");
      const big = "o".repeat(8192);
      const st = repo.stageTrial(
        sessionId,
        stageInput(task.id, { objective: big }),
        {
          key: randomUUID(),
          now: NOW + 4,
          profile: profile(),
          workspaceAlias: "ws",
        },
      );
      expect(st.status).toBe(201);
      expect(st.body.objective).toBe(big);
      expect(() =>
        repo.stageTrial(
          sessionId,
          stageInput(task.id, { objective: "o".repeat(8193) }),
          {
            key: randomUUID(),
            now: NOW + 5,
            profile: profile(),
            workspaceAlias: "ws",
          },
        ),
      ).toThrow(RepositoryValidationError);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

describe("codex3/3: approve persists expiry before reporting", () => {
  it("marks the proposal expired even though approval throws", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const { task } = goalTask(repo, sessionId, "b1");
      const expiry = new Date(NOW + 3600_000).toISOString();
      const st = repo.stageTrial(sessionId, stageInput(task.id, { expiry }), {
        key: randomUUID(),
        now: NOW + 4,
        profile: profile(),
        workspaceAlias: "ws",
      });
      expect(() =>
        repo.approveTrial(sessionId, st.body.id, {
          key: randomUUID(),
          now: NOW + 3600_000 + 1,
          profile: profile(),
          workspaceAlias: "ws",
        }),
      ).toThrow(/proposal expired/);
      const row = handle.raw
        .prepare("SELECT status FROM trial_proposals WHERE id=?")
        .get(st.body.id) as { status: string };
      expect(row.status).toBe("expired");
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

describe("codex3/3: malformed future-constraint timestamps fail closed", () => {
  it("treats an unparseable valid_from as an immediate deadline", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const { task } = goalTask(repo, sessionId, "b1");
      const expiry = new Date(NOW + 3600_000).toISOString();
      const bad = repo.createAutonomyPurpose(
        sessionId,
        {
          scope: "b1",
          statement: "badtime",
          kind: "constraint",
          explicit: true,
          sourceKind: "user",
        },
        { key: randomUUID(), now: NOW + 4 },
      );
      handle.raw
        .prepare(
          "UPDATE autonomy_purposes SET valid_from='not-an-instant' WHERE id=?",
        )
        .run(bad.body.id);
      expect(
        repo.trialAuthorityDeadline(
          sessionId,
          task.id,
          "implement",
          ["src/a.ts"],
          "ws",
          expiry,
          NOW + 5,
        ),
      ).toBe(0);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
