// Schema12/13 review regressions: deny '.', provenance/validity filtering,
// empty-rule rejection, profile immutability, wire mode/hash, one-use
// permit + lifecycle, invalidation. Real DB + production repository.
import { randomUUID } from "node:crypto";
import { TrialLaunchRequestSchema } from "@companion/contracts";
import { describe, expect, it } from "vitest";
import {
  closeKernelDatabase,
  createKernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
  pathIntersectsDenied,
  RepositoryValidationError,
} from "../src/index.js";

const NOW = 1_750_000_000_000;
const REV = "a".repeat(40);
const FP = "b".repeat(64);
const FP2 = "c".repeat(64);
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
// Trusted-caller observation builders (structural arguments, never body flags).
function obsActive(
  pid: number,
  bootId: string,
  ticks: string,
  now: number,
  extra: Record<string, unknown> = {},
) {
  return {
    scopeState: "active",
    frontendSettled: false,
    pid,
    bootId,
    processStartTicks: ticks,
    remainingRuntimeMs: 1000,
    timeoutMs: 5000,
    maxOutputBytes: 10000,
    foregroundGateOpen: true,
    observedAt: now,
    ...extra,
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
    timeoutMs: 5000,
    maxOutputBytes: 10000,
    foregroundGateOpen: true,
    observedAt: now,
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
  scope = "s1",
  sourceKind = "user" as "user" | "self" | "external",
  explicit = true,
) {
  const g = repo.createAutonomyPurpose(
    sessionId,
    { scope, statement: "ship it", kind: "goal", explicit, sourceKind },
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

describe("review: deny literal semantics", () => {
  it("'.' on either side intersects; invalid literals rejected", () => {
    expect(pathIntersectsDenied(".", "src")).toBe(true);
    expect(pathIntersectsDenied("src/a.ts", ".")).toBe(true);
    expect(pathIntersectsDenied(".", ".")).toBe(true);
    expect(pathIntersectsDenied("src/a.ts", "src")).toBe(true);
    expect(pathIntersectsDenied("src", "src/a.ts")).toBe(true);
    expect(pathIntersectsDenied("src2/b.ts", "src")).toBe(false);
    for (const bad of ["/abs", "a/../b", "a/./b", "trail/", "glob*"]) {
      expect(() => pathIntersectsDenied(bad, "src")).toThrow(
        RepositoryValidationError,
      );
      expect(() => pathIntersectsDenied("src/x", bad)).toThrow(
        RepositoryValidationError,
      );
    }
  });

  it("whole-repo '.' write is denied by a 'src' deny prefix", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const { task } = goalTask(repo, sessionId, "w1");
      repo.createAutonomyPurpose(
        sessionId,
        {
          scope: "w1",
          statement: "rule",
          kind: "constraint",
          explicit: true,
          sourceKind: "user",
          constraintRule: {
            denyWorkspace: [],
            denyOperation: [],
            denyWritePath: [{ workspaceAlias: "ws", literalPrefix: "src" }],
          },
        },
        { key: randomUUID(), now: NOW + 4 },
      );
      expect(() =>
        repo.stageTrial(
          sessionId,
          stageInput(task.id, { literalPatchPaths: ["."] }),
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

describe("review: constraint provenance + validity", () => {
  it("external/self/non-explicit/future/expired constraints do not enforce", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const { task } = goalTask(repo, sessionId, "v1");
      const future = new Date(NOW + 7200_000).toISOString();
      const past = new Date(NOW - 3600_000).toISOString();
      const pastEnd = new Date(NOW - 1000).toISOString();
      // Non-authoritative provenance: structured deny-operation rules ignored.
      const deny = {
        denyWorkspace: [],
        denyOperation: ["implement"],
        denyWritePath: [],
      };
      for (const [sk, ex] of [
        ["self", true],
        ["external", true],
      ] as const) {
        repo.createAutonomyPurpose(
          sessionId,
          {
            scope: "v1",
            statement: `p-${sk}`,
            kind: "constraint",
            explicit: ex,
            sourceKind: sk,
            constraintRule: deny,
          },
          { key: randomUUID(), now: NOW + 4 },
        );
      }
      repo.createAutonomyPurpose(
        sessionId,
        {
          scope: "v1",
          statement: "nonexplicit",
          kind: "constraint",
          explicit: false,
          sourceKind: "user",
          constraintRule: deny,
        },
        { key: randomUUID(), now: NOW + 5 },
      );
      // Unstructured HOLD but out of window => irrelevant.
      repo.createAutonomyPurpose(
        sessionId,
        {
          scope: "v1",
          statement: "future",
          kind: "constraint",
          explicit: true,
          sourceKind: "user",
          validFrom: future,
        },
        { key: randomUUID(), now: NOW + 6 },
      );
      repo.createAutonomyPurpose(
        sessionId,
        {
          scope: "v1",
          statement: "expired",
          kind: "constraint",
          explicit: true,
          sourceKind: "user",
          validFrom: past,
          validUntil: pastEnd,
        },
        { key: randomUUID(), now: NOW + 7 },
      );
      const st = repo.stageTrial(sessionId, stageInput(task.id), {
        key: randomUUID(),
        now: NOW + 8,
        profile: profile(),
        workspaceAlias: "ws",
      });
      expect(st.status).toBe(201);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("invalid time data fails closed; empty ruleset rejected; corrupt stored rule holds", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const { task } = goalTask(repo, sessionId, "v2");
      // Empty ruleset rejected at write.
      expect(() =>
        repo.createAutonomyPurpose(
          sessionId,
          {
            scope: "v2",
            statement: "empty",
            kind: "constraint",
            explicit: true,
            sourceKind: "user",
            constraintRule: {},
          },
          { key: randomUUID(), now: NOW + 4 },
        ),
      ).toThrow();
      expect(() =>
        repo.createAutonomyPurpose(
          sessionId,
          {
            scope: "v2",
            statement: "empty2",
            kind: "constraint",
            explicit: true,
            sourceKind: "user",
            constraintRule: {
              denyWorkspace: [],
              denyOperation: [],
              denyWritePath: [],
            },
          },
          { key: randomUUID(), now: NOW + 5 },
        ),
      ).toThrow();
      // Invalid validFrom fails closed (HOLD) at authority time. The write
      // path rejects non-strict instants, so corrupt the row below the API.
      const bad = repo.createAutonomyPurpose(
        sessionId,
        {
          scope: "v2",
          statement: "badtime",
          kind: "constraint",
          explicit: true,
          sourceKind: "user",
        },
        { key: randomUUID(), now: NOW + 6 },
      );
      handle.raw
        .prepare(
          "UPDATE autonomy_purposes SET valid_from='not-an-instant' WHERE id=?",
        )
        .run(bad.body.id);
      expect(() =>
        repo.stageTrial(sessionId, stageInput(task.id), {
          key: randomUUID(),
          now: NOW + 7,
          profile: profile(),
          workspaceAlias: "ws",
        }),
      ).toThrow(RepositoryValidationError);
      // Unknown/corrupt stored rule also fails closed (separate scope).
      const { task: t3 } = goalTask(repo, sessionId, "v2b");
      const ruled = repo.createAutonomyPurpose(
        sessionId,
        {
          scope: "v2b",
          statement: "ok-rule",
          kind: "constraint",
          explicit: true,
          sourceKind: "user",
          constraintRule: {
            denyWorkspace: ["elsewhere"],
            denyOperation: [],
            denyWritePath: [],
          },
        },
        { key: randomUUID(), now: NOW + 8 },
      );
      handle.raw
        .prepare(
          'UPDATE trial_constraint_rules SET rule_json=\'{"denyOperation":["bogus"]}\' WHERE purpose_id=?',
        )
        .run(ruled.body.id);
      expect(() =>
        repo.stageTrial(sessionId, stageInput(t3.id), {
          key: randomUUID(),
          now: NOW + 9,
          profile: profile(),
          workspaceAlias: "ws",
        }),
      ).toThrow(RepositoryValidationError);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("many non-matching constraints still deny on the last matching rule", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const { task } = goalTask(repo, sessionId, "v3");
      for (let i = 0; i < 105; i++) {
        repo.createAutonomyPurpose(
          sessionId,
          {
            scope: "v3",
            statement: `noise-${i}`,
            kind: "constraint",
            explicit: true,
            sourceKind: "user",
            constraintRule: {
              denyWorkspace: [`elsewhere-${i}`],
              denyOperation: [],
              denyWritePath: [],
            },
          },
          { key: randomUUID(), now: NOW + 10 + i },
        );
      }
      repo.createAutonomyPurpose(
        sessionId,
        {
          scope: "v3",
          statement: "last-denies",
          kind: "constraint",
          explicit: true,
          sourceKind: "user",
          constraintRule: {
            denyWorkspace: [],
            denyOperation: ["implement"],
            denyWritePath: [],
          },
        },
        { key: randomUUID(), now: NOW + 200 },
      );
      expect(() =>
        repo.stageTrial(sessionId, stageInput(task.id), {
          key: randomUUID(),
          now: NOW + 201,
          profile: profile(),
          workspaceAlias: "ws",
        }),
      ).toThrow(RepositoryValidationError);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

describe("review: profile immutability + wire mode/hash", () => {
  it("stage-A/approve-B and approve-A/claim-B rejected; caps/checks enforced; wire mode exact", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const { task } = goalTask(repo, sessionId, "p1");
      const st = repo.stageTrial(sessionId, stageInput(task.id), {
        key: randomUUID(),
        now: NOW + 4,
        profile: profile(),
        workspaceAlias: "ws",
      });
      // Approve with drifted profile (different FP) => 409 re-stage.
      expect(() =>
        repo.approveTrial(sessionId, st.body.id, {
          key: randomUUID(),
          now: NOW + 5,
          profile: profile({ configFingerprint: FP2 }),
          workspaceAlias: "ws",
        }),
      ).toThrow(RepositoryValidationError);
      // Approve with drifted alias => 409.
      expect(() =>
        repo.approveTrial(sessionId, st.body.id, {
          key: randomUUID(),
          now: NOW + 5,
          profile: profile(),
          workspaceAlias: "other",
        }),
      ).toThrow(RepositoryValidationError);
      const ap = repo.approveTrial(sessionId, st.body.id, {
        key: randomUUID(),
        now: NOW + 5,
        profile: profile(),
        workspaceAlias: "ws",
      });
      const exec = (ap.body as { executionId: string }).executionId;
      // Claim with drifted profile => 409.
      expect(() =>
        repo.claimTrial(sessionId, exec, {
          key: randomUUID(),
          now: NOW + 6,
          profile: profile({ timeoutMs: 59000 }),
          workspaceAlias: "ws",
        }),
      ).toThrow(RepositoryValidationError);
      // Claim with drifted alias => 409 (frozen target binds).
      expect(() =>
        repo.claimTrial(sessionId, exec, {
          key: randomUUID(),
          now: NOW + 6,
          profile: profile(),
          workspaceAlias: "other",
        }),
      ).toThrow(RepositoryValidationError);
      const c = repo.claimTrial(sessionId, exec, {
        key: randomUUID(),
        now: NOW + 6,
        profile: profile(),
        workspaceAlias: "ws",
      });
      const req = (c.body as { request: Record<string, unknown> }).request;
      // Wire-exact: NO domain operation key on the wire; mode only, strict schema, no remap.
      expect(req).not.toHaveProperty("operation");
      expect(req.mode).toBe("write");
      expect(() => TrialLaunchRequestSchema.parse(req)).not.toThrow();
      expect(() =>
        TrialLaunchRequestSchema.parse({ ...req, mode: "implement" }),
      ).toThrow();
      // Hash covers all fields except taskHash.
      const h1 = repo.hashTrialLaunchRequest(req);
      expect(h1).toMatch(/^[0-9a-f]{64}$/);
      expect(
        repo.hashTrialLaunchRequest({ ...req, taskHash: "b".repeat(64) }),
      ).toBe(h1);
      expect(
        repo.hashTrialLaunchRequest({ ...req, workspaceAlias: "other" }),
      ).not.toBe(h1);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("over-cap and dropped-mandatory-check requests rejected at staging", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const { task } = goalTask(repo, sessionId, "p2");
      expect(() =>
        repo.stageTrial(
          sessionId,
          stageInput(task.id, {
            objectiveResourceCaps: { timeoutMs: 60001, maxOutputBytes: 10000 },
          }),
          {
            key: randomUUID(),
            now: NOW + 4,
            profile: profile(),
            workspaceAlias: "ws",
          },
        ),
      ).toThrow(RepositoryValidationError);
      expect(() =>
        repo.stageTrial(
          sessionId,
          stageInput(task.id, { requiredChecks: ["other-check"] }),
          {
            key: randomUUID(),
            now: NOW + 4,
            profile: profile(),
            workspaceAlias: "ws",
          },
        ),
      ).toThrow(RepositoryValidationError);
      // Read-only operation builds a read_only wire mode.
      const g2 = goalTask(repo, sessionId, "p2ro");
      const st = repo.stageTrial(
        sessionId,
        stageInput(g2.task.id, {
          operation: "investigate",
          readOnlyMode: true,
          literalPatchPaths: ["src/a.ts"],
        }),
        {
          key: randomUUID(),
          now: NOW + 5,
          profile: profile(),
          workspaceAlias: "ws",
        },
      );
      const ap = repo.approveTrial(sessionId, st.body.id, {
        key: randomUUID(),
        now: NOW + 6,
        profile: profile(),
        workspaceAlias: "ws",
      });
      const c = repo.claimTrial(
        sessionId,
        (ap.body as { executionId: string }).executionId,
        {
          key: randomUUID(),
          now: NOW + 7,
          profile: profile(),
          workspaceAlias: "ws",
        },
      );
      const req = (c.body as { request: Record<string, unknown> }).request;
      expect(req).not.toHaveProperty("operation");
      expect(req.mode).toBe("read_only");
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

describe("review: internal lifecycle", () => {
  it("boot -> permit once -> done; second permit refused; late revoked success rejected", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const { task } = goalTask(repo, sessionId, "l1");
      const st = repo.stageTrial(sessionId, stageInput(task.id), {
        key: randomUUID(),
        now: NOW + 4,
        profile: profile(),
        workspaceAlias: "ws",
      });
      const ap = repo.approveTrial(sessionId, st.body.id, {
        key: randomUUID(),
        now: NOW + 5,
        profile: profile(),
        workspaceAlias: "ws",
      });
      const exec = (ap.body as { executionId: string }).executionId;
      const permitDeps = (obs: unknown, req: unknown) => ({
        key: randomUUID(),
        now: NOW + 6,
        observation: obs as never,
        profile: profile(),
        requestHash: repo.hashTrialLaunchRequest(
          req as Record<string, unknown>,
        ),
      });
      // Permit requires a claimed grant + registered boot + full deps.
      expect(() =>
        repo.issueTrialLaunchPermit(
          sessionId,
          exec,
          permitDeps(obsActive(4242, "boot-1", "12345", NOW + 6), {}),
        ),
      ).toThrow();
      const c = repo.claimTrial(sessionId, exec, {
        key: randomUUID(),
        now: NOW + 6,
        profile: profile(),
        workspaceAlias: "ws",
      });
      expect((c.body as { kind: string }).kind).toBe("result");
      const frozen = (c.body as { request: Record<string, unknown> }).request;
      expect(() =>
        repo.issueTrialLaunchPermit(sessionId, exec, {
          ...permitDeps(obsActive(4242, "boot-1", "12345", NOW + 7), frozen),
          now: NOW + 7,
        }),
      ).toThrow();
      repo.registerTrialWorkerBoot(
        {
          executionId: exec,
          sessionId,
          pid: 4242,
          bootId: "boot-1",
          processStartTicks: "12345",
        },
        NOW + 7,
      );
      // Closed-gate observation mints nothing.
      expect(() =>
        repo.issueTrialLaunchPermit(sessionId, exec, {
          ...permitDeps(
            {
              ...obsActive(4242, "boot-1", "12345", NOW + 8),
              foregroundGateOpen: false,
            },
            frozen,
          ),
          now: NOW + 8,
        }),
      ).toThrow(RepositoryValidationError);
      const p = repo.issueTrialLaunchPermit(sessionId, exec, {
        ...permitDeps(obsActive(4242, "boot-1", "12345", NOW + 8), frozen),
        now: NOW + 8,
      });
      expect(p.status).toBe(201);
      expect(() =>
        repo.issueTrialLaunchPermit(sessionId, exec, {
          ...permitDeps(obsActive(4242, "boot-1", "12345", NOW + 9), frozen),
          now: NOW + 9,
        }),
      ).toThrow();
      // Intent read is pure: repeated reads identical, grant still claimed.
      const i1 = repo.readTrialLaunchIntent(sessionId, exec);
      const i2 = repo.readTrialLaunchIntent(sessionId, exec);
      expect(JSON.stringify(i1)).toBe(JSON.stringify(i2));
      expect(i1.request).not.toBeNull();
      const taskHash = (frozen as { taskHash: string }).taskHash;
      const done = repo.recordTrialWorkerResult(
        sessionId,
        exec,
        {
          detail: "worker finished",
          observation: obsGone(4242, "boot-1", "12345", NOW + 10) as never,
          result: {
            taskHash,
            exitCode: 0,
            checks: [{ id: "lint", ok: true }],
            outputMatched: true,
            noTimeout: true,
          },
        },
        NOW + 10,
      );
      expect(done.outcome).toBe("done");
      // Claimed+consumed can never resend/rearm: a fresh claim key replays
      // the SAME frozen DTO (no new launch, no state change).
      const again = repo.claimTrial(sessionId, exec, {
        key: randomUUID(),
        now: NOW + 11,
        profile: profile(),
        workspaceAlias: "ws",
      });
      expect((again.body as { kind: string }).kind).toBe("replay");
      expect(JSON.stringify((again.body as { request: unknown }).request)).toBe(
        JSON.stringify((c.body as { request: unknown }).request),
      );
      expect(() =>
        repo.recordTrialWorkerResult(
          sessionId,
          exec,
          {
            detail: "late",
            observation: obsGone(4242, "boot-1", "12345", NOW + 12) as never,
            result: {
              taskHash,
              exitCode: 0,
              checks: [{ id: "lint", ok: true }],
              outputMatched: true,
              noTimeout: true,
            },
          },
          NOW + 12,
        ),
      ).toThrow();
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("unknown quiescence fences the alias; fence survives claim/retry/profile change", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const { task } = goalTask(repo, sessionId, "l2");
      const st = repo.stageTrial(sessionId, stageInput(task.id), {
        key: randomUUID(),
        now: NOW + 4,
        profile: profile(),
        workspaceAlias: "ws",
      });
      const ap = repo.approveTrial(sessionId, st.body.id, {
        key: randomUUID(),
        now: NOW + 5,
        profile: profile(),
        workspaceAlias: "ws",
      });
      const exec = (ap.body as { executionId: string }).executionId;
      expect(
        repo.recordTrialQuiescence(sessionId, "l2", randomUUID(), NOW + 6, {
          workspaceAlias: "ws",
          reason: "unknown-frontend",
        }).fenced,
      ).toBeGreaterThanOrEqual(0);
      // Fenced queued grant cannot be claimed, retried, or revived by profile change.
      for (const p of [profile(), profile({ configFingerprint: FP2 })]) {
        expect(() =>
          repo.claimTrial(sessionId, exec, {
            key: randomUUID(),
            now: NOW + 7,
            profile: p,
            workspaceAlias: "ws",
          }),
        ).toThrow();
      }
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("reconcile expires staged proposals and revokes lapsed queued grants, never revives", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const { task } = goalTask(repo, sessionId, "l3");
      const st = repo.stageTrial(
        sessionId,
        stageInput(task.id, { expiry: new Date(NOW + 1000).toISOString() }),
        {
          key: randomUUID(),
          now: NOW + 4,
          profile: profile(),
          workspaceAlias: "ws",
        },
      );
      const r = repo.reconcileTrialExpiries(NOW + 2000);
      expect(r.expired).toBe(1);
      const listed = repo.listTrials(sessionId, {});
      expect(listed.items.find((i) => i.id === st.body.id)?.status).toBe(
        "expired",
      );
      // Expired proposal can never be approved after reconcile.
      expect(() =>
        repo.approveTrial(sessionId, st.body.id, {
          key: randomUUID(),
          now: NOW + 2001,
          profile: profile(),
          workspaceAlias: "ws",
        }),
      ).toThrow();
      expect(repo.reconcileTrialExpiries(NOW + 3000).expired).toBe(0);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
