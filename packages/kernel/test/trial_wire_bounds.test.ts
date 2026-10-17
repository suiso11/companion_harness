// Wire-subset boundary: over-wire input fails BEFORE grant/claim, and the
// claimed request carries the wire-exact key set (no domain operation).
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
  return { task: t.body };
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

describe("wire-subset boundary fails before grant", () => {
  it("rejects over-wire acceptance/alias/budget/unadvertised checks at staging", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const { task } = goalTask(repo, sessionId, "wb1");
      expect(() =>
        repo.stageTrial(
          sessionId,
          stageInput(task.id, { acceptance: Array(17).fill("ok") }),
          {
            key: randomUUID(),
            now: NOW + 4,
            profile: profile(),
            workspaceAlias: "ws",
          },
        ),
      ).toThrow(RepositoryValidationError);
      expect(() =>
        repo.stageTrial(sessionId, stageInput(task.id), {
          key: randomUUID(),
          now: NOW + 4,
          profile: profile(),
          workspaceAlias: "Bad_Alias!",
        }),
      ).toThrow(RepositoryValidationError);
      expect(() =>
        repo.stageTrial(
          sessionId,
          stageInput(task.id, {
            objectiveResourceCaps: { timeoutMs: 500, maxOutputBytes: 10000 },
          }),
          {
            key: randomUUID(),
            now: NOW + 4,
            profile: profile(),
            workspaceAlias: "ws",
          },
        ),
      ).toThrow(RepositoryValidationError);
      // Unadvertised optional ID rejected even though the mandatory subset matches.
      expect(() =>
        repo.stageTrial(
          sessionId,
          stageInput(task.id, { requiredChecks: ["lint", "extra-check"] }),
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

  it("claimed request is wire-exact: 15 keys, no operation, hash covers executionId", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const { task } = goalTask(repo, sessionId, "wb2");
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
      const c = repo.claimTrial(sessionId, exec, {
        key: randomUUID(),
        now: NOW + 6,
        profile: profile(),
        workspaceAlias: "ws",
      });
      const req = (c.body as { request: Record<string, unknown> }).request;
      expect(Object.keys(req).sort()).toEqual(
        [
          "acceptance",
          "budget",
          "configFingerprint",
          "constraints",
          "executionId",
          "externalModelConsent",
          "mode",
          "objective",
          "purpose",
          "relevantPaths",
          "requiredChecks",
          "sourceRevision",
          "taskHash",
          "version",
          "workspaceAlias",
        ].sort(),
      );
      // Frozen-body drift under the same grant key replays (409 on conflicting reuse
      // is covered by the idempotency scope); hash is stable and executionId-bound.
      const h1 = repo.hashTrialLaunchRequest(req);
      expect(
        repo.hashTrialLaunchRequest({ ...req, taskHash: "c".repeat(64) }),
      ).toBe(h1);
      expect(
        repo.hashTrialLaunchRequest({ ...req, executionId: randomUUID() }),
      ).not.toBe(h1);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
