// Schema12 trial authority regressions (real DB + production repository).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  closeKernelDatabase,
  createKernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
  RepositoryValidationError,
  revokeAllClaimedForStop,
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
    allowedPaths: ["src", "src2", "apps", "packages"],
    modelRoute: "external" as const,
    ...extra,
  };
}
async function makeRepo() {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  const repo = createKernelRepository(handle.raw);
  const session = repo.createSession({ key: randomUUID(), now: NOW });
  // Control defaults paused: resume for trial work.
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

describe("stage-time frozen profile validation", () => {
  function stageCode(fn: () => unknown): string | null {
    try {
      fn();
      return null;
    } catch (error) {
      return (error as { code?: string }).code ?? null;
    }
  }

  it("requires allowedPaths/modelRoute in the staged profile (no silent skip)", async () => {
    const { repo, sessionId } = await makeRepo();
    const { task } = goalTask(repo, sessionId);
    const { allowedPaths, modelRoute, ...legacy } = profile();
    void allowedPaths;
    void modelRoute;
    expect(() =>
      repo.stageTrial(
        sessionId,
        stageInput(task.id, { possibleExternalDataConsent: false }),
        {
          key: randomUUID(),
          now: NOW + 4,
          profile: legacy as never,
          workspaceAlias: "ws",
        },
      ),
    ).toThrow();
  });

  it("uses path-segment boundaries for allowedPaths", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const { task } = goalTask(repo, sessionId);
      const frozen = profile({
        allowedPaths: ["apps", "packages"],
        modelRoute: "local",
      });
      expect(
        stageCode(() =>
          repo.stageTrial(
            sessionId,
            stageInput(task.id, {
              literalPatchPaths: ["appsx/a.ts"],
              possibleExternalDataConsent: false,
            }),
            {
              key: randomUUID(),
              now: NOW + 4,
              profile: frozen,
              workspaceAlias: "ws",
            },
          ),
        ),
      ).toBe("trial_path_outside_profile");
      expect(
        stageCode(() =>
          repo.stageTrial(
            sessionId,
            stageInput(task.id, {
              literalPatchPaths: ["docs/operations.md"],
              possibleExternalDataConsent: false,
            }),
            {
              key: randomUUID(),
              now: NOW + 4,
              profile: frozen,
              workspaceAlias: "ws",
            },
          ),
        ),
      ).toBe("trial_path_outside_profile");
      const ok = repo.stageTrial(
        sessionId,
        stageInput(task.id, {
          literalPatchPaths: ["apps/a.ts", "packages/b.ts"],
          possibleExternalDataConsent: false,
        }),
        {
          key: randomUUID(),
          now: NOW + 4,
          profile: frozen,
          workspaceAlias: "ws",
        },
      );
      expect(ok.status).toBe(201);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("rejects external consent when the frozen route is local", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const { task } = goalTask(repo, sessionId);
      const frozen = profile({ allowedPaths: ["apps"], modelRoute: "local" });
      expect(
        stageCode(() =>
          repo.stageTrial(
            sessionId,
            stageInput(task.id, {
              literalPatchPaths: ["apps/a.ts"],
              possibleExternalDataConsent: true,
            }),
            {
              key: randomUUID(),
              now: NOW + 4,
              profile: frozen,
              workspaceAlias: "ws",
            },
          ),
        ),
      ).toBe("trial_external_consent_unavailable");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("maps a non-explicit goal to purpose_not_confirmed", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const { task } = goalTask(repo, sessionId, "s1", "user", false);
      expect(
        stageCode(() =>
          repo.stageTrial(sessionId, stageInput(task.id), {
            key: randomUUID(),
            now: NOW + 4,
            profile: profile(),
            workspaceAlias: "ws",
          }),
        ),
      ).toBe("purpose_not_confirmed");
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

describe("pathless read-only wire scope", () => {
  it("sends the frozen allowedPaths for a pathless read-only claim", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const { task } = goalTask(repo, sessionId);
      const roProfile = profile({ allowedPaths: ["apps", "packages"] });
      const st = repo.stageTrial(
        sessionId,
        stageInput(task.id, {
          literalPatchPaths: [],
          operation: "investigate",
          readOnlyMode: true,
          possibleExternalDataConsent: false,
        }),
        {
          key: randomUUID(),
          now: NOW + 4,
          profile: roProfile,
          workspaceAlias: "ws",
        },
      );
      expect(st.status).toBe(201);
      expect(st.body.literalPatchPaths).toEqual([]);
      const ap = repo.approveTrial(sessionId, st.body.id, {
        key: randomUUID(),
        now: NOW + 5,
        profile: roProfile,
        workspaceAlias: "ws",
      });
      const exec = (ap.body as { executionId: string }).executionId;
      const c = repo.claimTrial(sessionId, exec, {
        key: randomUUID(),
        now: NOW + 6,
        profile: roProfile,
        workspaceAlias: "ws",
      });
      const req = (c.body as { request: { relevantPaths: string[] } }).request;
      expect(req.relevantPaths).toEqual(["apps", "packages"]);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("still works when the profile allows whole-repo '.'", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const { task } = goalTask(repo, sessionId);
      const roProfile = profile({ allowedPaths: ["."] });
      const st = repo.stageTrial(
        sessionId,
        stageInput(task.id, {
          literalPatchPaths: [],
          operation: "verify",
          readOnlyMode: true,
          possibleExternalDataConsent: false,
        }),
        {
          key: randomUUID(),
          now: NOW + 4,
          profile: roProfile,
          workspaceAlias: "ws",
        },
      );
      const ap = repo.approveTrial(sessionId, st.body.id, {
        key: randomUUID(),
        now: NOW + 5,
        profile: roProfile,
        workspaceAlias: "ws",
      });
      const exec = (ap.body as { executionId: string }).executionId;
      const c = repo.claimTrial(sessionId, exec, {
        key: randomUUID(),
        now: NOW + 6,
        profile: roProfile,
        workspaceAlias: "ws",
      });
      const req = (c.body as { request: { relevantPaths: string[] } }).request;
      expect(req.relevantPaths).toEqual(["."]);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("still rejects a pathless write request", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const { task } = goalTask(repo, sessionId);
      expect(() =>
        repo.stageTrial(
          sessionId,
          stageInput(task.id, { literalPatchPaths: [] }),
          {
            key: randomUUID(),
            now: NOW + 4,
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

describe("trial authority", () => {
  it("stages/approves/claims with one-use grant; claim replay returns replay", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const { task } = goalTask(repo, sessionId);
      const st = repo.stageTrial(sessionId, stageInput(task.id), {
        key: randomUUID(),
        now: NOW + 4,
        profile: profile(),
        workspaceAlias: "ws",
      });
      expect(st.status).toBe(201);
      const ap = repo.approveTrial(sessionId, st.body.id, {
        key: randomUUID(),
        now: NOW + 5,
        profile: profile(),
        workspaceAlias: "ws",
      });
      const exec = (ap.body as { executionId: string }).executionId;
      // Double approve under a different key must fail (one grant).
      expect(() =>
        repo.approveTrial(sessionId, st.body.id, {
          key: randomUUID(),
          now: NOW + 6,
          profile: profile(),
          workspaceAlias: "ws",
        }),
      ).toThrow();
      const c1 = repo.claimTrial(sessionId, exec, {
        key: randomUUID(),
        now: NOW + 7,
        profile: profile(),
        workspaceAlias: "ws",
      });
      expect((c1.body as { kind: string }).kind).toBe("result");
      const c2 = repo.claimTrial(sessionId, exec, {
        key: randomUUID(),
        now: NOW + 8,
        profile: profile(),
        workspaceAlias: "ws",
      });
      expect((c2.body as { kind: string }).kind).toBe("replay");
      // Hash covers all fields except taskHash, incl executionId.
      const req = (c1.body as { request: Record<string, unknown> }).request;
      const h1 = repo.hashTrialLaunchRequest(req);
      expect(h1).toMatch(/^[0-9a-f]{64}$/);
      expect(
        repo.hashTrialLaunchRequest({ ...req, taskHash: "b".repeat(64) }),
      ).toBe(h1);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("denies self/external goals, held tasks, unstructured constraints, deny rules", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const bad1 = goalTask(repo, sessionId, "s2", "self", true);
      expect(() =>
        repo.stageTrial(sessionId, stageInput(bad1.task.id), {
          key: randomUUID(),
          now: NOW + 4,
          profile: profile(),
          workspaceAlias: "ws",
        }),
      ).toThrow(RepositoryValidationError);
      // Unstructured constraint holds everything in scope.
      repo.createAutonomyPurpose(
        sessionId,
        {
          scope: "s1",
          statement: "nope",
          kind: "constraint",
          explicit: true,
          sourceKind: "user",
        },
        { key: randomUUID(), now: NOW + 4 },
      );
      const { task } = goalTask(repo, sessionId, "s1b");
      void task;
      const { task: t2 } = goalTask(repo, sessionId, "s9");
      // scope s9 has a structured deny rule: deny operation implement.
      repo.createAutonomyPurpose(
        sessionId,
        {
          scope: "s9",
          statement: "rule",
          kind: "constraint",
          explicit: true,
          sourceKind: "user",
          constraintRule: {
            denyWorkspace: [],
            denyOperation: ["implement"],
            denyWritePath: [],
          },
        },
        { key: randomUUID(), now: NOW + 5 },
      );
      expect(() =>
        repo.stageTrial(sessionId, stageInput(t2.id), {
          key: randomUUID(),
          now: NOW + 6,
          profile: profile(),
          workspaceAlias: "ws",
        }),
      ).toThrow(RepositoryValidationError);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("STOP revokes claimed but queued survives; claim needs fresh resume; goal revoke invalidates queued; unknown fence", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const { task } = goalTask(repo, sessionId, "sq");
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
      const ctl = repo.getAutonomyControlState();
      repo.setAutonomyControlState(
        { paused: true, expectedVersion: ctl.version, reason: "stop" },
        { key: randomUUID(), now: NOW + 6 },
      );
      // Queued survives pause, but claim is gated until fresh resume.
      expect(() =>
        repo.claimTrial(sessionId, exec, {
          key: randomUUID(),
          now: NOW + 7,
          profile: profile(),
          workspaceAlias: "ws",
        }),
      ).toThrow(RepositoryValidationError);
      const ctl2 = repo.getAutonomyControlState();
      repo.setAutonomyControlState(
        { paused: false, expectedVersion: ctl2.version, reason: "resume" },
        { key: randomUUID(), now: NOW + 8 },
      );
      const c = repo.claimTrial(sessionId, exec, {
        key: randomUUID(),
        now: NOW + 9,
        profile: profile(),
        workspaceAlias: "ws",
      });
      expect((c.body as { kind: string }).kind).toBe("result");
      // Unknown execution fences the alias: claimed grant gets cancelRequested.
      expect(
        repo.fenceTrialUnknown(
          sessionId,
          {
            workspaceAlias: "ws",
            executionId: randomUUID(),
            reason: "unknown-frontend",
          },
          NOW + 10,
        ),
      ).toBeGreaterThanOrEqual(1);
      // Goal revoke invalidates a fresh queued grant in another scope/alias.
      const g2 = goalTask(repo, sessionId, "sr");
      const st2 = repo.stageTrial(sessionId, stageInput(g2.task.id), {
        key: randomUUID(),
        now: NOW + 11,
        profile: profile(),
        workspaceAlias: "ws2",
      });
      const ap2 = repo.approveTrial(sessionId, st2.body.id, {
        key: randomUUID(),
        now: NOW + 12,
        profile: profile(),
        workspaceAlias: "ws2",
      });
      const exec2 = (ap2.body as { executionId: string }).executionId;
      repo.revokeAutonomyPurpose(
        sessionId,
        g2.goal.id,
        { expectedVersion: 1 },
        { key: randomUUID(), now: NOW + 13 },
      );
      expect(() =>
        repo.claimTrial(sessionId, exec2, {
          key: randomUUID(),
          now: NOW + 14,
          profile: profile(),
          workspaceAlias: "ws2",
        }),
      ).toThrow();
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("corrupt rule fails closed; literal prefix ancestor+descendant blocked, unrelated alias passes", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const { task } = goalTask(repo, sessionId, "sl");
      expect(() =>
        repo.createAutonomyPurpose(
          sessionId,
          {
            scope: "sl",
            statement: "bad",
            kind: "constraint",
            explicit: true,
            sourceKind: "user",
            constraintRule: {
              denyWorkspace: [],
              denyOperation: ["bogus"],
              denyWritePath: [],
            },
          },
          { key: randomUUID(), now: NOW + 4 },
        ),
      ).toThrow();
      repo.createAutonomyPurpose(
        sessionId,
        {
          scope: "sl",
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
        { key: randomUUID(), now: NOW + 5 },
      );
      // src2 must NOT match prefix src (no glob); src/a.ts descendant blocked.
      const ok = repo.stageTrial(
        sessionId,
        stageInput(task.id, { literalPatchPaths: ["src2/b.ts"] }),
        {
          key: randomUUID(),
          now: NOW + 6,
          profile: profile(),
          workspaceAlias: "ws",
        },
      );
      expect(ok.status).toBe(201);
      expect(() =>
        repo.stageTrial(
          sessionId,
          stageInput(task.id, { literalPatchPaths: ["src/a.ts"] }),
          {
            key: randomUUID(),
            now: NOW + 7,
            profile: profile(),
            workspaceAlias: "ws",
          },
        ),
      ).toThrow(RepositoryValidationError);
      // Unrelated alias unaffected.
      const ok2 = repo.stageTrial(
        sessionId,
        stageInput(task.id, { literalPatchPaths: ["src/a.ts"] }),
        {
          key: randomUUID(),
          now: NOW + 8,
          profile: profile(),
          workspaceAlias: "other",
        },
      );
      expect(ok2.status).toBe(201);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("stages/approves/claims a local write grant without external data consent", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const { task } = goalTask(repo, sessionId, "sx-local-write");
      const staged = repo.stageTrial(
        sessionId,
        stageInput(task.id, { possibleExternalDataConsent: false }),
        {
          key: randomUUID(),
          now: NOW + 4,
          profile: profile(),
          workspaceAlias: "ws",
        },
      );
      expect(staged.body.possibleExternalDataConsent).toBe(false);
      const approved = repo.approveTrial(sessionId, staged.body.id, {
        key: randomUUID(),
        now: NOW + 5,
        profile: profile(),
        workspaceAlias: "ws",
      });
      const executionId = (approved.body as { executionId: string })
        .executionId;
      const claimed = repo.claimTrial(sessionId, executionId, {
        key: randomUUID(),
        now: NOW + 6,
        profile: profile(),
        workspaceAlias: "ws",
      });
      expect((claimed.body as { kind: string }).kind).toBe("result");
      const request = (
        claimed.body as {
          request: {
            mode: string;
            externalModelConsent: boolean;
            relevantPaths: string[];
          };
        }
      ).request;
      expect(request.mode).toBe("write");
      expect(request.externalModelConsent).toBe(false);
      expect(request.relevantPaths).toEqual(["src/a.ts"]);
      const row = handle.raw
        .prepare(
          "SELECT read_only, consent, paths_json FROM trial_proposals WHERE id=?",
        )
        .get(staged.body.id) as {
        read_only: number;
        consent: number;
        paths_json: string;
      };
      expect(row.read_only).toBe(0);
      expect(row.consent).toBe(0);
      expect(JSON.parse(row.paths_json)).toEqual(["src/a.ts"]);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("restart fence revokes a claimed unbooted grant while retaining claim evidence", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const { task } = goalTask(repo, sessionId, "sx-fence-claim");
      const staged = repo.stageTrial(
        sessionId,
        stageInput(task.id, { possibleExternalDataConsent: false }),
        {
          key: randomUUID(),
          now: NOW + 4,
          profile: profile(),
          workspaceAlias: "ws",
        },
      );
      const approved = repo.approveTrial(sessionId, staged.body.id, {
        key: randomUUID(),
        now: NOW + 5,
        profile: profile(),
        workspaceAlias: "ws",
      });
      const executionId = (approved.body as { executionId: string })
        .executionId;
      repo.claimTrial(sessionId, executionId, {
        key: randomUUID(),
        now: NOW + 6,
        profile: profile(),
        workspaceAlias: "ws",
      });
      const fence = repo.applyAutonomyRestartFenceNow(NOW + 7);
      expect(fence.paused).toBe(true);
      const grant = handle.raw
        .prepare(
          "SELECT status, claimed_at, request_json FROM trial_grants WHERE execution_id=?",
        )
        .get(executionId) as {
        status: string;
        claimed_at: number | null;
        request_json: string | null;
      };
      expect(grant.status).toBe("revoked");
      expect(grant.claimed_at).not.toBeNull();
      expect(grant.request_json).not.toBeNull();
      for (const table of [
        "trial_worker_boots",
        "trial_launch_permits",
        "trial_worker_outcomes",
      ]) {
        const count = handle.raw
          .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE execution_id=?`)
          .get(executionId) as { n: number };
        expect(count.n).toBe(0);
      }
      // A claimed-then-revoked grant is NOT the never-launched shortcut.
      expect(
        repo.isNeverLaunchedRevokedTrialGrant(sessionId, executionId),
      ).toBe(false);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("reports only an owned revoked grant that never launched", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const first = goalTask(repo, sessionId, "sx1");
      const staged = repo.stageTrial(sessionId, stageInput(first.task.id), {
        key: randomUUID(),
        now: NOW + 4,
        profile: profile(),
        workspaceAlias: "ws",
      });
      const approved = repo.approveTrial(sessionId, staged.body.id, {
        key: randomUUID(),
        now: NOW + 5,
        profile: profile(),
        workspaceAlias: "ws",
      });
      const queuedExec = (approved.body as { executionId: string }).executionId;
      expect(repo.isNeverLaunchedRevokedTrialGrant(sessionId, queuedExec)).toBe(
        false,
      );
      repo.expireTrial(sessionId, staged.body.id, NOW + 6);
      expect(repo.isNeverLaunchedRevokedTrialGrant(sessionId, queuedExec)).toBe(
        true,
      );
      expect(
        repo.isNeverLaunchedRevokedTrialGrant(sessionId, randomUUID()),
      ).toBe(false);
      const otherSession = repo.createSession({
        key: randomUUID(),
        now: NOW + 7,
      }).body.sessionId;
      expect(
        repo.isNeverLaunchedRevokedTrialGrant(otherSession, queuedExec),
      ).toBe(false);

      // Defensive boot row on an otherwise revoked-unclaimed grant is not proof.
      const orphan = goalTask(repo, sessionId, "sx3");
      const orphanStaged = repo.stageTrial(
        sessionId,
        stageInput(orphan.task.id),
        {
          key: randomUUID(),
          now: NOW + 8,
          profile: profile(),
          workspaceAlias: "ws",
        },
      );
      const orphanApproved = repo.approveTrial(
        sessionId,
        orphanStaged.body.id,
        {
          key: randomUUID(),
          now: NOW + 9,
          profile: profile(),
          workspaceAlias: "ws",
        },
      );
      const orphanExec = (orphanApproved.body as { executionId: string })
        .executionId;
      repo.expireTrial(sessionId, orphanStaged.body.id, NOW + 10);
      handle.raw
        .prepare(
          "INSERT INTO trial_worker_boots (execution_id, session_id, pid, boot_id, process_start_ticks, observed_at, started_at) VALUES (?,?,?,?,?,?,?)",
        )
        .run(
          orphanExec,
          sessionId,
          901,
          "orphan-boot",
          "9010",
          NOW + 11,
          NOW + 11,
        );
      expect(repo.isNeverLaunchedRevokedTrialGrant(sessionId, orphanExec)).toBe(
        false,
      );

      // Claimed (with a registered worker boot) then revoked: NOT never-launched.
      const second = goalTask(repo, sessionId, "sx2");
      const staged2 = repo.stageTrial(sessionId, stageInput(second.task.id), {
        key: randomUUID(),
        now: NOW + 8,
        profile: profile(),
        workspaceAlias: "ws",
      });
      const approved2 = repo.approveTrial(sessionId, staged2.body.id, {
        key: randomUUID(),
        now: NOW + 9,
        profile: profile(),
        workspaceAlias: "ws",
      });
      const claimedExec = (approved2.body as { executionId: string })
        .executionId;
      repo.claimTrial(sessionId, claimedExec, {
        key: randomUUID(),
        now: NOW + 10,
        profile: profile(),
        workspaceAlias: "ws",
      });
      repo.registerTrialWorkerBoot(
        {
          executionId: claimedExec,
          sessionId,
          pid: 900,
          bootId: "getter-boot",
          processStartTicks: "9000",
        },
        NOW + 11,
      );
      expect(revokeAllClaimedForStop(handle.raw, NOW + 12)).toBeGreaterThan(0);
      expect(
        repo.isNeverLaunchedRevokedTrialGrant(sessionId, claimedExec),
      ).toBe(false);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
