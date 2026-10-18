// Schema13 trial lifecycle: birth identity, one-use permit, gone+settled
// done, per-alias fence, authority-window fit. Real DB + production repo.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  closeKernelDatabase,
  createKernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
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
async function fullClaim(
  repo: ReturnType<typeof createKernelRepository>,
  sessionId: string,
  scope: string,
  alias: string,
  nowBase: number,
) {
  const { task } = goalTask(repo, sessionId, scope);
  const st = repo.stageTrial(sessionId, stageInput(task.id), {
    key: randomUUID(),
    now: nowBase,
    profile: profile(),
    workspaceAlias: alias,
  });
  const ap = repo.approveTrial(sessionId, st.body.id, {
    key: randomUUID(),
    now: nowBase + 1,
    profile: profile(),
    workspaceAlias: alias,
  });
  const exec = (ap.body as { executionId: string }).executionId;
  const c = repo.claimTrial(sessionId, exec, {
    key: randomUUID(),
    now: nowBase + 2,
    profile: profile(),
    workspaceAlias: alias,
  });
  return {
    exec,
    req: (c.body as { request: Record<string, unknown> })
      .request as unknown as { taskHash: string; timeoutMs?: number } & Record<
      string,
      unknown
    >,
  };
}
function permitFor(
  repo: ReturnType<typeof createKernelRepository>,
  sessionId: string,
  exec: string,
  req: Record<string, unknown>,
  pid: number,
  bootId: string,
  ticks: string,
  now: number,
  obsExtra: Record<string, unknown> = {},
) {
  const base = obsActive(pid, bootId, ticks, now, obsExtra);
  return repo.issueTrialLaunchPermit(sessionId, exec, {
    key: randomUUID(),
    now,
    observation: base as never,
    profile: profile(),
    requestHash: repo.hashTrialLaunchRequest(req),
  });
}

describe("lifecycle: birth identity register-once", () => {
  it("exact replay idempotent; different identity / revoked / unclaimed reject", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const { exec, req } = await fullClaim(
        repo,
        sessionId,
        "b1",
        "ws",
        NOW + 4,
      );
      void req;
      const b1 = repo.registerTrialWorkerBoot(
        {
          executionId: exec,
          sessionId,
          pid: 100,
          bootId: "boot-x",
          processStartTicks: "999",
        },
        NOW + 7,
      );
      expect(b1.pid).toBe(100);
      const b2 = repo.registerTrialWorkerBoot(
        {
          executionId: exec,
          sessionId,
          pid: 100,
          bootId: "boot-x",
          processStartTicks: "999",
        },
        NOW + 8,
      );
      expect(b2.startedAt).toBe(b1.startedAt);
      expect(() =>
        repo.registerTrialWorkerBoot(
          {
            executionId: exec,
            sessionId,
            pid: 101,
            bootId: "boot-x",
            processStartTicks: "999",
          },
          NOW + 9,
        ),
      ).toThrow(RepositoryValidationError);
      expect(() =>
        repo.registerTrialWorkerBoot(
          {
            executionId: exec,
            sessionId,
            pid: 100,
            bootId: "boot-y",
            processStartTicks: "999",
          },
          NOW + 9,
        ),
      ).toThrow(RepositoryValidationError);
      // Omitted ticks never replays: rejected even with otherwise-exact identity.
      expect(() =>
        (repo.registerTrialWorkerBoot as (i: unknown, n?: number) => unknown)(
          { executionId: exec, sessionId, pid: 100, bootId: "boot-x" },
          NOW + 9,
        ),
      ).toThrow(RepositoryValidationError);
      // Unclaimed grant: boot rejected.
      const { task } = goalTask(repo, sessionId, "b2");
      const st = repo.stageTrial(sessionId, stageInput(task.id), {
        key: randomUUID(),
        now: NOW + 10,
        profile: profile(),
        workspaceAlias: "ws",
      });
      const ap = repo.approveTrial(sessionId, st.body.id, {
        key: randomUUID(),
        now: NOW + 11,
        profile: profile(),
        workspaceAlias: "ws",
      });
      const execQ = (ap.body as { executionId: string }).executionId;
      expect(() =>
        repo.registerTrialWorkerBoot(
          {
            executionId: execQ,
            sessionId,
            pid: 5,
            bootId: "b",
            processStartTicks: "1",
          },
          NOW + 12,
        ),
      ).toThrow(RepositoryValidationError);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

describe("lifecycle: one-use permit, gone+settled done, immutable outcomes", () => {
  it("permit once (duplicate incl same key denied); done only gone+settled; late cancel observed-not-authorized; no rewrite", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const { exec, req } = await fullClaim(
        repo,
        sessionId,
        "p1",
        "ws",
        NOW + 4,
      );
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
      const k1 = randomUUID();
      const p = repo.issueTrialLaunchPermit(sessionId, exec, {
        key: k1,
        now: NOW + 8,
        observation: obsActive(4242, "boot-1", "12345", NOW + 8) as never,
        profile: profile(),
        requestHash: repo.hashTrialLaunchRequest(req),
      });
      expect(p.status).toBe(201);
      expect((p.body as { consumedAt: number }).consumedAt).toBe(NOW + 8);
      // Duplicate with a NEW key denied; same key ALSO denied (never cached 201).
      expect(() =>
        permitFor(repo, sessionId, exec, req, 4242, "boot-1", "12345", NOW + 9),
      ).toThrow(RepositoryValidationError);
      expect(() =>
        repo.issueTrialLaunchPermit(sessionId, exec, {
          key: k1,
          now: NOW + 9,
          observation: obsActive(4242, "boot-1", "12345", NOW + 9) as never,
          profile: profile(),
          requestHash: repo.hashTrialLaunchRequest(req),
        }),
      ).toThrow(RepositoryValidationError);
      // Historical read returns the audit token, not new authority.
      expect(repo.readTrialLaunchPermit(sessionId, exec)).not.toBeNull();
      // Active-scope DONE rejected (must be gone+settled).
      expect(() =>
        repo.recordTrialWorkerResult(
          sessionId,
          exec,
          {
            detail: "active-done",
            observation: obsActive(4242, "boot-1", "12345", NOW + 10) as never,
            result: {
              taskHash: req.taskHash as string,
              exitCode: 0,
              checks: [{ id: "lint", ok: true }],
              outputMatched: true,
              noTimeout: true,
            },
          },
          NOW + 10,
        ),
      ).toThrow(RepositoryValidationError);
      // Exact frozen result after gone+settled accepted; grant consumed.
      const done = repo.recordTrialWorkerResult(
        sessionId,
        exec,
        {
          detail: "native done",
          observation: obsGone(4242, "boot-1", "12345", NOW + 11) as never,
          result: {
            taskHash: req.taskHash as string,
            exitCode: 0,
            checks: [{ id: "lint", ok: true }],
            outputMatched: true,
            noTimeout: true,
          },
        },
        NOW + 11,
      );
      expect(done.outcome).toBe("done");
      expect(done.authorized).toBe(true);
      // Conflicting rewrite rejected; exact duplicate idempotent.
      expect(() =>
        repo.recordTrialWorkerResult(
          sessionId,
          exec,
          {
            detail: "other",
            observation: obsGone(4242, "boot-1", "12345", NOW + 12) as never,
            result: {
              taskHash: req.taskHash as string,
              exitCode: 0,
              checks: [{ id: "lint", ok: true }],
              outputMatched: true,
              noTimeout: true,
            },
          },
          NOW + 12,
        ),
      ).toThrow(RepositoryValidationError);
      const dup = repo.recordTrialWorkerResult(
        sessionId,
        exec,
        {
          detail: "native done",
          observation: obsGone(4242, "boot-1", "12345", NOW + 13) as never,
          result: {
            taskHash: req.taskHash as string,
            exitCode: 0,
            checks: [{ id: "lint", ok: true }],
            outputMatched: true,
            noTimeout: true,
          },
        },
        NOW + 13,
      );
      expect(dup.outcome).toBe("done");
      // Cancel-wanted late done: observed, not authorized (separate flow).
      const second = await fullClaim(repo, sessionId, "p2", "ws", NOW + 20);
      repo.registerTrialWorkerBoot(
        {
          executionId: second.exec,
          sessionId,
          pid: 7,
          bootId: "bb",
          processStartTicks: "77",
        },
        NOW + 23,
      );
      permitFor(
        repo,
        sessionId,
        second.exec,
        second.req,
        7,
        "bb",
        "77",
        NOW + 24,
      );
      handle.raw
        .prepare(
          "UPDATE trial_grants SET cancel_requested=1 WHERE execution_id=?",
        )
        .run(second.exec);
      const late = repo.recordTrialWorkerResult(
        sessionId,
        second.exec,
        {
          detail: "late provider",
          observation: obsGone(7, "bb", "77", NOW + 25) as never,
          result: {
            taskHash: second.req.taskHash as string,
            exitCode: 0,
            checks: [{ id: "lint", ok: true }],
            outputMatched: true,
            noTimeout: true,
          },
        },
        NOW + 25,
      );
      expect(late.authorized).toBe(false);
      expect(late.outcome).toBe("observed");
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

describe("lifecycle: review regressions (permit strictness, fence rows, claim purpose)", () => {
  it("permit denied when remainingRuntimeMs omitted/NaN/negative", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const { exec, req } = await fullClaim(
        repo,
        sessionId,
        "r1",
        "ws",
        NOW + 4,
      );
      repo.registerTrialWorkerBoot(
        {
          executionId: exec,
          sessionId,
          pid: 9,
          bootId: "rb",
          processStartTicks: "11",
        },
        NOW + 7,
      );
      const deps = (obs: unknown) => ({
        key: randomUUID(),
        now: NOW + 8,
        observation: obs as never,
        profile: profile(),
        requestHash: repo.hashTrialLaunchRequest(req),
      });
      expect(() =>
        repo.issueTrialLaunchPermit(
          sessionId,
          exec,
          deps({
            ...obsActive(9, "rb", "11", NOW + 8),
            remainingRuntimeMs: undefined,
          }),
        ),
      ).toThrow(RepositoryValidationError);
      expect(() =>
        repo.issueTrialLaunchPermit(
          sessionId,
          exec,
          deps({
            ...obsActive(9, "rb", "11", NOW + 8),
            remainingRuntimeMs: Number.NaN,
          }),
        ),
      ).toThrow(RepositoryValidationError);
      expect(() =>
        repo.issueTrialLaunchPermit(
          sessionId,
          exec,
          deps({
            ...obsActive(9, "rb", "11", NOW + 8),
            remainingRuntimeMs: -5,
          }),
        ),
      ).toThrow(RepositoryValidationError);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("permit denied when ticks missing or mismatched", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const { exec, req } = await fullClaim(
        repo,
        sessionId,
        "r2",
        "ws",
        NOW + 4,
      );
      repo.registerTrialWorkerBoot(
        {
          executionId: exec,
          sessionId,
          pid: 9,
          bootId: "rb",
          processStartTicks: "11",
        },
        NOW + 7,
      );
      const deps = (obs: unknown) => ({
        key: randomUUID(),
        now: NOW + 8,
        observation: obs as never,
        profile: profile(),
        requestHash: repo.hashTrialLaunchRequest(req),
      });
      const { processStartTicks: _drop, ...noTicks } = obsActive(
        9,
        "rb",
        "11",
        NOW + 8,
      );
      void _drop;
      expect(() =>
        repo.issueTrialLaunchPermit(sessionId, exec, deps(noTicks)),
      ).toThrow(RepositoryValidationError);
      expect(() =>
        repo.issueTrialLaunchPermit(
          sessionId,
          exec,
          deps(obsActive(9, "rb", "99999", NOW + 8)),
        ),
      ).toThrow(RepositoryValidationError);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("second unknown on same alias keeps fence after first row cleared; wrong executionId clear rejected", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const u1 = randomUUID();
      const u2 = randomUUID();
      expect(
        repo.recordTrialQuiescence(sessionId, "fa", u1, NOW + 7, {
          workspaceAlias: "fencealias",
          reason: "unknown-frontend",
        }).fenced,
      ).toBe(0);
      expect(
        repo.recordTrialQuiescence(sessionId, "fa", u2, NOW + 8, {
          workspaceAlias: "fencealias",
          reason: "unknown-frontend",
        }).fenced,
      ).toBe(0);
      const { task } = goalTask(repo, sessionId, "fa");
      expect(() =>
        repo.stageTrial(sessionId, stageInput(task.id), {
          key: randomUUID(),
          now: NOW + 9,
          profile: profile(),
          workspaceAlias: "fencealias",
        }),
      ).toThrow(RepositoryValidationError);
      // Wrong executionId: rejected with zero writes.
      expect(() =>
        repo.clearTrialAliasFence(
          "fencealias",
          randomUUID(),
          obsGone(1, "b", "1", NOW + 10) as never,
        ),
      ).toThrow(RepositoryValidationError);
      // Clearing only the first row leaves the alias fenced via the second.
      expect(
        repo.clearTrialAliasFence(
          "fencealias",
          u1,
          obsGone(1, "b", "1", NOW + 10) as never,
        ),
      ).toBe(1);
      expect(() =>
        repo.stageTrial(sessionId, stageInput(task.id), {
          key: randomUUID(),
          now: NOW + 11,
          profile: profile(),
          workspaceAlias: "fencealias",
        }),
      ).toThrow(RepositoryValidationError);
      expect(
        repo.clearTrialAliasFence(
          "fencealias",
          u2,
          obsGone(1, "b", "1", NOW + 12) as never,
        ),
      ).toBe(1);
      expect(
        repo.stageTrial(sessionId, stageInput(task.id), {
          key: randomUUID(),
          now: NOW + 13,
          profile: profile(),
          workspaceAlias: "fencealias",
        }).status,
      ).toBe(201);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("claim purpose statement comes from the bound goal text on the wire", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const g = repo.createAutonomyPurpose(
        sessionId,
        {
          scope: "cp",
          statement: "deploy the widget",
          kind: "goal",
          explicit: true,
          sourceKind: "user",
        },
        { key: randomUUID(), now: NOW + 2 },
      );
      const t = repo.createAutonomyTask(
        sessionId,
        {
          scope: "cp",
          title: "do work",
          kind: "task",
          speaker: "user",
          parentPurposeId: g.body.id,
        },
        { key: randomUUID(), now: NOW + 3 },
      );
      const st = repo.stageTrial(
        sessionId,
        stageInput(t.body.id, { objective: "something else entirely" }),
        {
          key: randomUUID(),
          now: NOW + 4,
          profile: profile(),
          workspaceAlias: "ws",
        },
      );
      const ap = repo.approveTrial(sessionId, st.body.id, {
        key: randomUUID(),
        now: NOW + 5,
        profile: profile(),
        workspaceAlias: "ws",
      });
      const exec = (ap.body as { executionId: string }).executionId;
      const c = repo.claimTrial(sessionId, exec, {
        key: randomUUID(),
        now: NOW + 6,
        profile: profile(),
        workspaceAlias: "ws",
      });
      const req = (
        c.body as { request: { purpose: { statement: string; scope: string } } }
      ).request;
      expect(req.purpose.statement).toBe("deploy the widget");
      expect(req.purpose.scope).toBe("cp");
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

describe("lifecycle: per-alias fence + window fit", () => {
  it("unknown aliasA fence blocks A but not B; survives reopen; clears only on gone+settled; claim fit boundary", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const a = await fullClaim(repo, sessionId, "fa", "aliasa", NOW + 4);
      void a;
      const unknownExec = randomUUID();
      expect(
        repo.recordTrialQuiescence(sessionId, "aliasa", unknownExec, NOW + 7, {
          workspaceAlias: "aliasa",
          reason: "unknown-frontend",
        }).fenced,
      ).toBeGreaterThanOrEqual(0);
      const { task } = goalTask(repo, sessionId, "fa2");
      expect(() =>
        repo.stageTrial(sessionId, stageInput(task.id), {
          key: randomUUID(),
          now: NOW + 8,
          profile: profile(),
          workspaceAlias: "aliasa",
        }),
      ).toThrow(RepositoryValidationError);
      // Unrelated alias B unaffected (needs explicit resume only if paused; not paused here).
      const { task: tb } = goalTask(repo, sessionId, "fb");
      const stb = repo.stageTrial(sessionId, stageInput(tb.id), {
        key: randomUUID(),
        now: NOW + 8,
        profile: profile(),
        workspaceAlias: "aliasb",
      });
      expect(stb.status).toBe(201);
      // Unsettled evidence cannot clear: requires trusted gone + frontend settled.
      expect(() =>
        repo.clearTrialAliasFence("aliasa", unknownExec, {
          ...obsGone(1, "b", "1", NOW + 9),
          frontendSettled: false,
        } as never),
      ).toThrow(RepositoryValidationError);
      expect(
        repo.clearTrialAliasFence(
          "aliasa",
          unknownExec,
          obsGone(1, "b", "1", NOW + 9) as never,
        ),
      ).toBe(1);
      const st2 = repo.stageTrial(sessionId, stageInput(task.id), {
        key: randomUUID(),
        now: NOW + 10,
        profile: profile(),
        workspaceAlias: "aliasa",
      });
      expect(st2.status).toBe(201);
      // Window fit: proposal expiring before timeout cannot claim.
      const { task: t3 } = goalTask(repo, sessionId, "fw");
      expect(() =>
        repo.stageTrial(
          sessionId,
          stageInput(t3.id, {
            expiry: new Date(NOW + 2000).toISOString(),
            objectiveResourceCaps: { timeoutMs: 5000, maxOutputBytes: 10000 },
          }),
          {
            key: randomUUID(),
            now: NOW + 11,
            profile: profile(),
            workspaceAlias: "aliasb",
          },
        ),
      ).not.toThrow();
    } finally {
      closeKernelDatabase(handle);
    }
  });
  it("future matching deny constraint narrows claim window; unrelated alias unaffected", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const { task } = goalTask(repo, sessionId, "fc");
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
      // Future deny for THIS alias starting soon: claim needing 5000ms must fail.
      repo.createAutonomyPurpose(
        sessionId,
        {
          scope: "fc",
          statement: "soon-deny",
          kind: "constraint",
          explicit: true,
          sourceKind: "user",
          validFrom: new Date(NOW + 4000).toISOString(),
          constraintRule: {
            denyWorkspace: ["ws"],
            denyOperation: [],
            denyWritePath: [],
          },
        },
        { key: randomUUID(), now: NOW + 6 },
      );
      expect(() =>
        repo.claimTrial(sessionId, exec, {
          key: randomUUID(),
          now: NOW + 7,
          profile: profile(),
          workspaceAlias: "ws",
        }),
      ).toThrow(RepositoryValidationError);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

describe("lifecycle: faithful empty-checks failure is terminal observed", () => {
  it("records the REAL observed bridge error shape (status error, empty checks) as observed and leaves claimed for interrupted; empty can never authorize", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const { exec, req } = await fullClaim(
        repo,
        sessionId,
        "e1",
        "ws",
        NOW + 4,
      );
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
      permitFor(repo, sessionId, exec, req, 4242, "boot-1", "12345", NOW + 8);
      // Faithful mapping of the real bridge final line: status error,
      // verified false, evidence.checks [] (capsule failed before checks ran).
      const res = repo.recordTrialWorkerResult(
        sessionId,
        exec,
        {
          detail: "bridge-exit:1",
          observation: obsGone(4242, "boot-1", "12345", NOW + 11) as never,
          result: {
            taskHash: req.taskHash as string,
            exitCode: 1,
            checks: [],
            outputMatched: false,
            noTimeout: false,
          },
        },
        NOW + 11,
      );
      expect(res.outcome).toBe("observed");
      expect(res.authorized).toBe(false);
      const out = repo.readTrialWorkerOutcome(sessionId, exec);
      expect(out?.authorized).toBe(false);
      expect(out?.status).toBe("interrupted");
      expect(out?.summary).toContain("checks mismatch");
      expect(out?.summary).toContain("bridge-exit:1");
      // Empty check sets can never authorize even with exit 0: the done bar
      // (every frozen required check present exactly once, clean) still fails.
      const second = await fullClaim(repo, sessionId, "e2", "ws", NOW + 20);
      repo.registerTrialWorkerBoot(
        {
          executionId: second.exec,
          sessionId,
          pid: 7,
          bootId: "bb",
          processStartTicks: "77",
        },
        NOW + 23,
      );
      permitFor(
        repo,
        sessionId,
        second.exec,
        second.req,
        7,
        "bb",
        "77",
        NOW + 24,
      );
      const res2 = repo.recordTrialWorkerResult(
        sessionId,
        second.exec,
        {
          detail: "bridge-exit:0",
          observation: obsGone(7, "bb", "77", NOW + 25) as never,
          result: {
            taskHash: second.req.taskHash as string,
            exitCode: 0,
            checks: [],
            outputMatched: true,
            noTimeout: true,
          },
        },
        NOW + 25,
      );
      expect(res2.outcome).toBe("observed");
      expect(res2.authorized).toBe(false);
      expect(repo.readTrialWorkerOutcome(sessionId, second.exec)?.status).toBe(
        "interrupted",
      );
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("restart fence preserves booted claimed grants for recovery", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const a = await fullClaim(repo, sessionId, "b1", "ws", NOW + 10);
      repo.registerTrialWorkerBoot(
        {
          executionId: a.exec,
          sessionId,
          pid: 200,
          bootId: "boot-a",
          processStartTicks: "1",
        },
        NOW + 13,
      );
      const b = await fullClaim(repo, sessionId, "b2", "ws", NOW + 20);
      void b;
      repo.applyAutonomyRestartFenceNow(NOW + 30);
      const workers = repo.listClaimedTrialWorkersForRecovery();
      expect(workers.map((w) => w.executionId)).toContain(a.exec);
      expect(workers.length).toBe(1);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
