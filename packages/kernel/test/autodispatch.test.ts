// Conversation -> plan -> standing-policy grant regressions (real DB/layout).
// Synthetic user turns only: no production data, bridge, model, or network.

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  closeKernelDatabase,
  createKernelRepository,
  DEFAULT_POLICY_CAPS,
  migrateKernelDatabase,
  openKernelDatabase,
  type PolicyCaps,
  RepositoryValidationError,
} from "../src/index.js";

const NOW = 1_760_000_000_000;
const FP = "b".repeat(64);
const REV = "a".repeat(40);

function profile(extra: Record<string, unknown> = {}) {
  return {
    available: true,
    enabled: true,
    mandatoryChecks: ["lint"],
    configFingerprint: FP,
    sourceRevision: REV,
    currentModel: "test-model",
    disclosedWholeRepoRead: true,
    timeoutMs: 1_000_000,
    maxOutputBytes: 1_000_000,
    ...extra,
  };
}
const limits = {
  operations: ["investigate", "implement"] as ("investigate" | "implement")[],
  checks: ["lint"],
  caps: DEFAULT_POLICY_CAPS,
};
const caps: PolicyCaps = {
  ...DEFAULT_POLICY_CAPS,
  timeoutMs: 60_000,
  maxOutputBytes: 4096,
  jobsPerDay: 3,
};

async function fixture() {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  const repo = createKernelRepository(handle.raw);
  const session = repo.createSession({ key: randomUUID(), now: NOW });
  const sessionId = session.body.sessionId;
  const ctl = repo.getAutonomyControlState();
  repo.setAutonomyControlState(
    { paused: false, expectedVersion: ctl.version },
    { key: randomUUID(), now: NOW + 1 },
  );
  return { handle, repo, sessionId };
}

function completedTurn(
  repo: ReturnType<typeof createKernelRepository>,
  sessionId: string,
  text: string,
  now: number,
) {
  const posted = repo.postMessage(
    sessionId,
    { text },
    { key: randomUUID(), now },
  );
  repo.startRun(posted.body.run.id, { now: now + 1 });
  repo.completeRun(posted.body.run.id, { version: 1, text: "ack" } as never, {
    now: now + 2,
  });
  return {
    turnId: posted.body.turnId,
    runId: posted.body.run.id,
  };
}

function createPolicy(
  repo: ReturnType<typeof createKernelRepository>,
  sessionId: string,
  turnId: string,
  now: number,
  extra: { caps?: PolicyCaps; expiresAt?: string | null } = {},
) {
  return repo.createAutodispatchPolicy(
    sessionId,
    {
      workspaceAlias: "companion-harness",
      operations: ["investigate", "implement"],
      readScopes: ["src", "docs"],
      writeScopes: ["src"],
      checks: ["lint"],
      caps: extra.caps ?? caps,
      expiresAt: extra.expiresAt ?? null,
    },
    {
      key: randomUUID(),
      now,
      limits,
      parent: {
        statement: "Use the standing auto-dispatch policy for this workspace",
        sourceTurnId: turnId,
      },
    },
  );
}

function planInput(
  policyId: string,
  anchor: { turnId: string; runId: string },
  kind: "execute" | "discuss" | "unclear" = "execute",
  paths: string[] = ["src/app.ts"],
) {
  return {
    policyId,
    operation: "implement" as const,
    content: {
      goal: "Implement the accepted feature in src/app.ts",
      decisions: ["Use the existing pipeline"],
      nongoals: ["No production deployment"],
      steps: ["Edit src/app.ts"],
      acceptance: ["lint passes"],
      missing: [] as string[],
      relevantPaths: paths,
    },
    intent: {
      kind,
      quotes: [
        {
          turnId: anchor.turnId,
          runId: anchor.runId,
          text: "implement the feature",
        },
      ],
      latestUserTurnId: anchor.turnId,
      latestUserRunId: anchor.runId,
    },
  };
}

function obsActive(pid: number, bootId: string, ticks: string, now: number) {
  return {
    scopeState: "active",
    frontendSettled: false,
    pid,
    bootId,
    processStartTicks: ticks,
    remainingRuntimeMs: 1000,
    timeoutMs: 60_000,
    maxOutputBytes: 4096,
    foregroundGateOpen: true,
    observedAt: now,
  };
}

function obsGone(pid: number, bootId: string, ticks: string, now: number) {
  return {
    scopeState: "gone",
    frontendSettled: true,
    pid,
    bootId,
    processStartTicks: ticks,
    remainingRuntimeMs: 1000,
    timeoutMs: 60_000,
    maxOutputBytes: 4096,
    foregroundGateOpen: true,
    observedAt: now,
  };
}

function authorizePolicyGrant(
  repo: ReturnType<typeof createKernelRepository>,
  sessionId: string,
  policyId: string,
  anchor: { turnId: string; runId: string },
  now: number,
) {
  const plan = repo.createAutodispatchPlan(
    sessionId,
    planInput(policyId, anchor),
    { now },
  );
  const auth = repo.authorizeAutodispatch(sessionId, plan.plan.id, {
    profile: profile(),
    workspaceAlias: "companion-harness",
    limits,
    now: now + 1,
  });
  return { plan: plan.plan, auth };
}

function claimPolicyGrant(
  repo: ReturnType<typeof createKernelRepository>,
  sessionId: string,
  executionId: string,
  now: number,
) {
  const claimed = repo.claimTrial(sessionId, executionId, {
    key: randomUUID(),
    now,
    profile: profile(),
    workspaceAlias: "companion-harness",
  });
  return (claimed.body as { request: { taskHash: string } }).request;
}

async function fileFixture() {
  const dir = mkdtempSync(join(tmpdir(), "companion-autodispatch-"));
  const dbPath = join(dir, "db.sqlite");
  const handleA = openKernelDatabase(dbPath);
  await migrateKernelDatabase({ db: handleA.raw });
  const repoA = createKernelRepository(handleA.raw);
  const sessionId = repoA.createSession({
    key: randomUUID(),
    now: NOW,
  }).body.sessionId;
  const ctl = repoA.getAutonomyControlState();
  repoA.setAutonomyControlState(
    { paused: false, expectedVersion: ctl.version },
    { key: randomUUID(), now: NOW + 1 },
  );
  const handleB = openKernelDatabase(dbPath);
  const repoB = createKernelRepository(handleB.raw);
  return { dir, handleA, handleB, repoA, repoB, sessionId };
}

describe("autodispatch policy/plan/authority", () => {
  it("creates exactly one queued grant and dedups duplicate delivery", async () => {
    const { handle, repo, sessionId } = await fixture();
    try {
      const anchor = completedTurn(
        repo,
        sessionId,
        "Please implement the feature in src/app.ts. Yes, go ahead.",
        NOW + 10,
      );
      const policy = createPolicy(repo, sessionId, anchor.turnId, NOW + 20);
      const created = repo.createAutodispatchPlan(
        sessionId,
        planInput(policy.id, anchor),
        { now: NOW + 30 },
      );
      expect(created.plan.status).toBe("frozen");
      expect(created.plan.intent.provenance).toBe("user-conversation");
      const auth = repo.authorizeAutodispatch(sessionId, created.plan.id, {
        profile: profile(),
        workspaceAlias: "companion-harness",
        limits,
        now: NOW + 40,
      });
      expect(auth.execution.status).toBe("authorized");
      expect(auth.execution.executionId).toMatch(/^[0-9a-f-]{36}$/);
      const again = repo.authorizeAutodispatch(sessionId, created.plan.id, {
        profile: profile(),
        workspaceAlias: "companion-harness",
        limits,
        now: NOW + 41,
      });
      expect(again.replayed).toBe(true);
      expect(again.execution.executionId).toBe(auth.execution.executionId);
      const grants = handle.raw
        .prepare("SELECT COUNT(*) AS n FROM trial_grants")
        .get() as { n: number };
      expect(grants.n).toBe(1);
      const proposals = handle.raw
        .prepare("SELECT COUNT(*) AS n FROM trial_proposals")
        .get() as { n: number };
      expect(proposals.n).toBe(1);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("does not execute for discuss/unclear/negation/out-of-scope", async () => {
    const { handle, repo, sessionId } = await fixture();
    try {
      const anchor = completedTurn(
        repo,
        sessionId,
        "Maybe we could implement the feature later. Don't do it yet.",
        NOW + 10,
      );
      const policy = createPolicy(repo, sessionId, anchor.turnId, NOW + 20);
      for (const kind of ["discuss", "unclear"] as const) {
        const out = repo.createAutodispatchPlan(
          sessionId,
          planInput(policy.id, anchor, kind),
          { now: NOW + 30 },
        );
        expect(out.plan.status).not.toBe("frozen");
        const denied = repo.authorizeAutodispatch(sessionId, out.plan.id, {
          profile: profile(),
          workspaceAlias: "companion-harness",
          limits,
          now: NOW + 31,
        });
        expect(denied.execution.status).toBe("denied");
      }
      expect(() =>
        repo.createAutodispatchPlan(
          sessionId,
          planInput(policy.id, anchor, "execute", ["other/secret.ts"]),
          { now: NOW + 40 },
        ),
      ).toThrow();
      // Negation is re-checked by the host even if the model says execute.
      const negated = repo.createAutodispatchPlan(
        sessionId,
        planInput(policy.id, anchor, "execute"),
        { now: NOW + 50 },
      );
      expect(negated.plan.status).not.toBe("frozen");
      const grants = handle.raw
        .prepare("SELECT COUNT(*) AS n FROM trial_grants")
        .get() as { n: number };
      expect(grants.n).toBe(0);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("denies expired/revoked/paused policy and stale turn/plan", async () => {
    const { handle, repo, sessionId } = await fixture();
    try {
      const anchor = completedTurn(
        repo,
        sessionId,
        "Please implement the feature in src/app.ts. Go.",
        NOW + 10,
      );
      const expiring = createPolicy(repo, sessionId, anchor.turnId, NOW + 20, {
        expiresAt: new Date(NOW + 25).toISOString(),
      });
      const p1 = repo.createAutodispatchPlan(
        sessionId,
        planInput(expiring.id, anchor),
        { now: NOW + 21 },
      );
      const expired = repo.authorizeAutodispatch(sessionId, p1.plan.id, {
        profile: profile(),
        workspaceAlias: "companion-harness",
        limits,
        now: NOW + 30,
      });
      expect(expired.execution.status).toBe("denied");
      expect(expired.execution.reason).toBe("policy-inactive");

      const policy = createPolicy(repo, sessionId, anchor.turnId, NOW + 40);
      const p2 = repo.createAutodispatchPlan(
        sessionId,
        planInput(policy.id, anchor),
        { now: NOW + 41 },
      );
      // A new latest user turn invalidates the frozen candidate before spawn.
      const newer = completedTurn(
        repo,
        sessionId,
        "Actually change the plan: implement the feature differently.",
        NOW + 50,
      );
      expect(newer.turnId).not.toBe(anchor.turnId);
      const stale = repo.authorizeAutodispatch(sessionId, p2.plan.id, {
        profile: profile(),
        workspaceAlias: "companion-harness",
        limits,
        now: NOW + 60,
      });
      expect(stale.execution.status).toBe("denied");
      expect(stale.execution.reason).toBe("intent-stale");

      const p3 = repo.createAutodispatchPlan(
        sessionId,
        planInput(policy.id, newer),
        { now: NOW + 61 },
      );
      repo.revokeAutodispatchPolicy(sessionId, policy.id, { now: NOW + 62 });
      const revoked = repo.authorizeAutodispatch(sessionId, p3.plan.id, {
        profile: profile(),
        workspaceAlias: "companion-harness",
        limits,
        now: NOW + 63,
      });
      expect(revoked.execution.status).toBe("denied");

      const policy2 = createPolicy(repo, sessionId, newer.turnId, NOW + 70);
      const p4 = repo.createAutodispatchPlan(
        sessionId,
        planInput(policy2.id, newer),
        { now: NOW + 71 },
      );
      const ctl = repo.getAutonomyControlState();
      repo.setAutonomyControlState(
        { paused: true, expectedVersion: ctl.version },
        { key: randomUUID(), now: NOW + 72 },
      );
      const paused = repo.authorizeAutodispatch(sessionId, p4.plan.id, {
        profile: profile(),
        workspaceAlias: "companion-harness",
        limits,
        now: NOW + 73,
      });
      expect(paused.execution.status).toBe("denied");
      expect(paused.execution.reason).toBe("control-paused");
      const grants = handle.raw
        .prepare("SELECT COUNT(*) AS n FROM trial_grants")
        .get() as { n: number };
      expect(grants.n).toBe(0);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("enforces daily and concurrent quota atomically", async () => {
    const { handle, repo, sessionId } = await fixture();
    try {
      const anchor = completedTurn(
        repo,
        sessionId,
        "Please implement the feature in src/app.ts. Do it.",
        NOW + 10,
      );
      const policy = createPolicy(repo, sessionId, anchor.turnId, NOW + 20, {
        caps: { ...caps, jobsPerDay: 1 },
      });
      const p1 = repo.createAutodispatchPlan(
        sessionId,
        planInput(policy.id, anchor),
        { now: NOW + 21 },
      );
      const first = repo.authorizeAutodispatch(sessionId, p1.plan.id, {
        profile: profile(),
        workspaceAlias: "companion-harness",
        limits,
        now: NOW + 30,
      });
      expect(first.execution.status).toBe("authorized");
      const anchor2 = completedTurn(
        repo,
        sessionId,
        "Please implement the feature second part in src/other.ts. Go.",
        NOW + 40,
      );
      const p2 = repo.createAutodispatchPlan(
        sessionId,
        {
          ...planInput(policy.id, anchor2),
          content: {
            ...planInput(policy.id, anchor2).content,
            goal: "Implement the second part",
            relevantPaths: ["src/other.ts"],
          },
        },
        { now: NOW + 41 },
      );
      const second = repo.authorizeAutodispatch(sessionId, p2.plan.id, {
        profile: profile(),
        workspaceAlias: "companion-harness",
        limits,
        now: NOW + 42,
      });
      expect(second.execution.status).toBe("denied");
      expect(second.execution.reason).toBe("quota-daily");
      const grants = handle.raw
        .prepare("SELECT COUNT(*) AS n FROM trial_grants")
        .get() as { n: number };
      expect(grants.n).toBe(1);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

describe("autodispatch lifecycle fences against the existing trial authority", () => {
  it("never claims a queued grant after the policy is revoked", async () => {
    const { handle, repo, sessionId } = await fixture();
    try {
      const anchor = completedTurn(
        repo,
        sessionId,
        "Please implement the feature in src/app.ts. Go.",
        NOW + 10,
      );
      const policy = createPolicy(repo, sessionId, anchor.turnId, NOW + 20);
      const { auth } = authorizePolicyGrant(
        repo,
        sessionId,
        policy.id,
        anchor,
        NOW + 21,
      );
      expect(auth.execution.status).toBe("authorized");
      const executionId = auth.execution.executionId as string;
      repo.revokeAutodispatchPolicy(sessionId, policy.id, { now: NOW + 30 });
      expect(() =>
        claimPolicyGrant(repo, sessionId, executionId, NOW + 31),
      ).toThrow(/revoked/);
      const grant = handle.raw
        .prepare("SELECT status FROM trial_grants WHERE execution_id=?")
        .get(executionId) as { status: string };
      expect(grant.status).toBe("revoked");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("never issues a permit after claim when the policy is revoked or expires", async () => {
    const { handle, repo, sessionId } = await fixture();
    try {
      const anchor = completedTurn(
        repo,
        sessionId,
        "Please implement the feature in src/app.ts. Go.",
        NOW + 10,
      );
      const revokedPolicy = createPolicy(
        repo,
        sessionId,
        anchor.turnId,
        NOW + 20,
      );
      const revokedGrant = authorizePolicyGrant(
        repo,
        sessionId,
        revokedPolicy.id,
        anchor,
        NOW + 21,
      );
      const revokedExec = revokedGrant.auth.execution.executionId as string;
      const revokedReq = claimPolicyGrant(
        repo,
        sessionId,
        revokedExec,
        NOW + 30,
      );
      repo.registerTrialWorkerBoot(
        {
          executionId: revokedExec,
          sessionId,
          pid: 100,
          bootId: "revoke-boot",
          processStartTicks: "1000",
        },
        NOW + 31,
      );
      repo.revokeAutodispatchPolicy(sessionId, revokedPolicy.id, {
        now: NOW + 32,
      });
      expect(() =>
        repo.issueTrialLaunchPermit(sessionId, revokedExec, {
          key: randomUUID(),
          now: NOW + 33,
          observation: obsActive(100, "revoke-boot", "1000", NOW + 33) as never,
          profile: profile(),
          requestHash: repo.hashTrialLaunchRequest(revokedReq),
        }),
      ).toThrow(RepositoryValidationError);

      const anchor2 = completedTurn(
        repo,
        sessionId,
        "Please implement the feature in src/other.ts. Go.",
        NOW + 40,
      );
      // readStandingPolicy uses wall-clock time, so the expiry must be
      // future relative to real now while still preceding the synthetic
      // permit instant below.
      const expiryMs = Date.now() + 30_000;
      const expiringPolicy = createPolicy(
        repo,
        sessionId,
        anchor2.turnId,
        NOW + 50,
        { expiresAt: new Date(expiryMs).toISOString() },
      );
      const expiringGrant = authorizePolicyGrant(
        repo,
        sessionId,
        expiringPolicy.id,
        anchor2,
        NOW + 51,
      );
      expect(expiringGrant.auth.execution.status).toBe("authorized");
      const expiringExec = expiringGrant.auth.execution.executionId as string;
      const expiringReq = claimPolicyGrant(
        repo,
        sessionId,
        expiringExec,
        NOW + 60,
      );
      repo.registerTrialWorkerBoot(
        {
          executionId: expiringExec,
          sessionId,
          pid: 200,
          bootId: "expiry-boot",
          processStartTicks: "2000",
        },
        NOW + 61,
      );
      expect(() =>
        repo.issueTrialLaunchPermit(sessionId, expiringExec, {
          key: randomUUID(),
          now: expiryMs + 1,
          observation: obsActive(
            200,
            "expiry-boot",
            "2000",
            expiryMs + 1,
          ) as never,
          profile: profile(),
          requestHash: repo.hashTrialLaunchRequest(expiringReq),
        }),
      ).toThrow(/policy-expired/);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("stop+resume control generation drift cannot launch a claimed grant", async () => {
    const { handle, repo, sessionId } = await fixture();
    try {
      const anchor = completedTurn(
        repo,
        sessionId,
        "Please implement the feature in src/app.ts. Go.",
        NOW + 10,
      );
      const policy = createPolicy(repo, sessionId, anchor.turnId, NOW + 20);
      const { auth } = authorizePolicyGrant(
        repo,
        sessionId,
        policy.id,
        anchor,
        NOW + 21,
      );
      const executionId = auth.execution.executionId as string;
      const req = claimPolicyGrant(repo, sessionId, executionId, NOW + 30);
      repo.registerTrialWorkerBoot(
        {
          executionId,
          sessionId,
          pid: 300,
          bootId: "control-boot",
          processStartTicks: "3000",
        },
        NOW + 31,
      );
      const stopped = repo.getAutonomyControlState();
      repo.setAutonomyControlState(
        { paused: true, expectedVersion: stopped.version },
        { key: randomUUID(), now: NOW + 32 },
      );
      const pausedCtl = repo.getAutonomyControlState();
      repo.setAutonomyControlState(
        { paused: false, expectedVersion: pausedCtl.version },
        { key: randomUUID(), now: NOW + 33 },
      );
      expect(repo.getAutonomyControlState().version).toBeGreaterThan(
        stopped.version,
      );
      // STOP already revoked the claimed grant (no launch), even after the
      // explicit resume restores the generation.
      expect(() =>
        repo.issueTrialLaunchPermit(sessionId, executionId, {
          key: randomUUID(),
          now: NOW + 34,
          observation: obsActive(
            300,
            "control-boot",
            "3000",
            NOW + 34,
          ) as never,
          profile: profile(),
          requestHash: repo.hashTrialLaunchRequest(req),
        }),
      ).toThrow(RepositoryValidationError);

      // A grant claimed after resume binds that generation; a later control
      // version change is refused at permit time.
      const anchor2 = completedTurn(
        repo,
        sessionId,
        "Please implement the feature in src/app.ts again. Go.",
        NOW + 40,
      );
      const second = authorizePolicyGrant(
        repo,
        sessionId,
        policy.id,
        anchor2,
        NOW + 50,
      );
      const secondExec = second.auth.execution.executionId as string;
      const secondReq = claimPolicyGrant(repo, sessionId, secondExec, NOW + 60);
      repo.registerTrialWorkerBoot(
        {
          executionId: secondExec,
          sessionId,
          pid: 301,
          bootId: "control-boot-2",
          processStartTicks: "3001",
        },
        NOW + 61,
      );
      const claimedCtl = repo.getAutonomyControlState();
      repo.setAutonomyControlState(
        { paused: false, expectedVersion: claimedCtl.version },
        { key: randomUUID(), now: NOW + 62 },
      );
      expect(repo.getAutonomyControlState().version).toBeGreaterThan(
        claimedCtl.version,
      );
      expect(() =>
        repo.issueTrialLaunchPermit(sessionId, secondExec, {
          key: randomUUID(),
          now: NOW + 63,
          observation: obsActive(
            301,
            "control-boot-2",
            "3001",
            NOW + 63,
          ) as never,
          profile: profile(),
          requestHash: repo.hashTrialLaunchRequest(secondReq),
        }),
      ).toThrow(/control-generation/);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("never verifies or accepts a late result after revoke, retaining raw evidence", async () => {
    const { handle, repo, sessionId } = await fixture();
    try {
      const anchor = completedTurn(
        repo,
        sessionId,
        "Please implement the feature in src/app.ts. Go.",
        NOW + 10,
      );
      const policy = createPolicy(repo, sessionId, anchor.turnId, NOW + 20);
      const { auth } = authorizePolicyGrant(
        repo,
        sessionId,
        policy.id,
        anchor,
        NOW + 21,
      );
      const executionId = auth.execution.executionId as string;
      const req = claimPolicyGrant(repo, sessionId, executionId, NOW + 30);
      repo.registerTrialWorkerBoot(
        {
          executionId,
          sessionId,
          pid: 400,
          bootId: "late-boot",
          processStartTicks: "4000",
        },
        NOW + 31,
      );
      repo.issueTrialLaunchPermit(sessionId, executionId, {
        key: randomUUID(),
        now: NOW + 32,
        observation: obsActive(400, "late-boot", "4000", NOW + 32) as never,
        profile: profile(),
        requestHash: repo.hashTrialLaunchRequest(req),
      });
      repo.revokeAutodispatchPolicy(sessionId, policy.id, { now: NOW + 33 });
      const late = repo.recordTrialWorkerResult(
        sessionId,
        executionId,
        {
          detail: "late native done",
          observation: obsGone(400, "late-boot", "4000", NOW + 34) as never,
          result: {
            taskHash: req.taskHash,
            exitCode: 0,
            checks: [{ id: "lint", ok: true }],
            outputMatched: true,
            noTimeout: true,
          },
        },
        NOW + 34,
      );
      expect(late.authorized).toBe(false);
      expect(late.outcome).toBe("observed");
      const outcome = handle.raw
        .prepare(
          "SELECT authorized, task_hash AS taskHash, detail FROM trial_worker_outcomes WHERE execution_id=?",
        )
        .get(executionId) as {
        authorized: number;
        taskHash: string;
        detail: string;
      };
      expect(outcome.authorized).toBe(0);
      expect(outcome.taskHash).toBe(req.taskHash);
      expect(outcome.detail).toContain("observed-not-authorized");
      const grant = handle.raw
        .prepare("SELECT status FROM trial_grants WHERE execution_id=?")
        .get(executionId) as { status: string };
      expect(grant.status).toBe("interrupted");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("rejects forged and foreign source turns before any purpose write", async () => {
    const { handle, repo, sessionId } = await fixture();
    try {
      const otherSession = repo.createSession({
        key: randomUUID(),
        now: NOW + 5,
      }).body.sessionId;
      const foreign = completedTurn(
        repo,
        otherSession,
        "Please implement the feature in the other session. Go.",
        NOW + 10,
      );
      const purposesBefore = handle.raw
        .prepare("SELECT COUNT(*) AS n FROM autonomy_purposes")
        .get() as { n: number };
      for (const sourceTurnId of [foreign.turnId, randomUUID()]) {
        expect(() =>
          createPolicy(repo, sessionId, sourceTurnId, NOW + 20),
        ).toThrow(RepositoryValidationError);
      }
      const purposesAfter = handle.raw
        .prepare("SELECT COUNT(*) AS n FROM autonomy_purposes")
        .get() as { n: number };
      expect(purposesAfter.n).toBe(purposesBefore.n);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("two handles cannot overreserve the daily quota", async () => {
    const { dir, handleA, handleB, repoA, repoB, sessionId } =
      await fileFixture();
    try {
      const anchor = completedTurn(
        repoA,
        sessionId,
        "Please implement the feature in src/app.ts. Go.",
        NOW + 10,
      );
      const policy = createPolicy(repoA, sessionId, anchor.turnId, NOW + 20, {
        caps: { ...caps, jobsPerDay: 1 },
      });
      const firstPlan = repoA.createAutodispatchPlan(
        sessionId,
        planInput(policy.id, anchor),
        { now: NOW + 21 },
      );
      const first = repoA.authorizeAutodispatch(sessionId, firstPlan.plan.id, {
        profile: profile(),
        workspaceAlias: "companion-harness",
        limits,
        now: NOW + 30,
      });
      expect(first.execution.status).toBe("authorized");

      const anchor2 = completedTurn(
        repoA,
        sessionId,
        "Please implement the feature in src/other.ts. Go.",
        NOW + 40,
      );
      const secondPlan = repoA.createAutodispatchPlan(
        sessionId,
        {
          ...planInput(policy.id, anchor2),
          content: {
            ...planInput(policy.id, anchor2).content,
            goal: "Implement the second feature",
            relevantPaths: ["src/other.ts"],
          },
        },
        { now: NOW + 41 },
      );
      // The second connection re-reads the committed reservation; it must
      // see the slot spent instead of reserving a second grant.
      const second = repoB.authorizeAutodispatch(
        sessionId,
        secondPlan.plan.id,
        {
          profile: profile(),
          workspaceAlias: "companion-harness",
          limits,
          now: NOW + 42,
        },
      );
      expect(second.execution.status).toBe("denied");
      expect(second.execution.reason).toBe("quota-daily");
      const grants = handleA.raw
        .prepare("SELECT COUNT(*) AS n FROM trial_grants")
        .get() as { n: number };
      const authorized = handleB.raw
        .prepare(
          "SELECT COUNT(*) AS n FROM autodispatch_executions WHERE status='authorized'",
        )
        .get() as { n: number };
      expect(grants.n).toBe(1);
      expect(authorized.n).toBe(1);
    } finally {
      closeKernelDatabase(handleA);
      closeKernelDatabase(handleB);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
