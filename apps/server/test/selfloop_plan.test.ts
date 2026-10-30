// Self-improvement loop closure (P4): the daily plan stages ONE read-only
// investigation under an operator-configured standing task. Nothing runs.

import { randomUUID } from "node:crypto";
import type { TrialProfileSnapshot } from "@companion/contracts";
import {
  closeKernelDatabase,
  createKernelRepository,
  type KernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
} from "@companion/kernel";
import { describe, expect, it } from "vitest";
import { parseSelfLoopConfig } from "../src/config.js";
import { createReflectService } from "../src/reflect_service.js";

const T0 = 1_790_100_000_000;
const PROFILE: TrialProfileSnapshot = {
  available: true,
  enabled: true,
  mandatoryChecks: ["lint"],
  configFingerprint: "a".repeat(64),
  sourceRevision: "b".repeat(40),
  currentModel: "test-model",
  disclosedWholeRepoRead: true,
  timeoutMs: 900_000,
  maxOutputBytes: 262_144,
  allowedPaths: ["apps", "packages"],
  modelRoute: "local",
};

describe("self loop config", () => {
  it("is disabled when unset and strict when present", () => {
    expect(parseSelfLoopConfig(undefined)).toBeNull();
    expect(
      parseSelfLoopConfig(
        JSON.stringify({
          enabled: true,
          sessionId: randomUUID(),
          taskId: randomUUID(),
        }),
      ),
    ).toMatchObject({ enabled: true, minEvidence: 3, dailyProposals: 1 });
    expect(() =>
      parseSelfLoopConfig(
        JSON.stringify({
          enabled: true,
          sessionId: randomUUID(),
          taskId: randomUUID(),
          extra: 1,
        }),
      ),
    ).toThrow(/unknown key/);
    expect(() =>
      parseSelfLoopConfig(
        JSON.stringify({
          enabled: true,
          sessionId: "nope",
          taskId: randomUUID(),
        }),
      ),
    ).toThrow(/sessionId/);
  });
});

async function seed(repo: KernelRepository): Promise<{
  sessionId: string;
  taskId: string;
  hypothesisId: string;
}> {
  const control = repo.getAutonomyControlState();
  repo.setAutonomyControlState(
    { paused: false, expectedVersion: control.version },
    { key: randomUUID(), now: T0 },
  );
  const sessionId = repo.createSession({ key: randomUUID(), now: T0 }).body
    .sessionId as string;
  const goal = repo.createAutonomyPurpose(
    sessionId,
    {
      scope: "default",
      statement: "companion self-improvement",
      kind: "goal",
      explicit: true,
      sourceKind: "user",
    },
    { key: randomUUID(), now: T0 + 1 },
  );
  const task = repo.createAutonomyTask(
    sessionId,
    {
      scope: "default",
      title: "standing self-improvement task",
      kind: "task",
      speaker: "user",
      parentPurposeId: goal.body.id,
    },
    { key: randomUUID(), now: T0 + 2 },
  );
  // Three settled failed runs, then one staged hypothesis anchored to each.
  let lastRunId = "";
  for (let i = 0; i < 3; i += 1) {
    const posted = repo.postMessage(
      sessionId,
      { text: "もっと短く答えて" },
      { key: randomUUID(), now: T0 + 10 + i * 10 },
    );
    const runId = (posted.body as { run: { id: string } }).run.id;
    repo.startRun(runId, { now: T0 + 11 + i * 10 });
    repo.failRun(runId, "execution_failed", { now: T0 + 12 + i * 10 });
    lastRunId = runId;
  }
  const hypothesis = repo.proposeLearningHypothesisFromModel(
    lastRunId,
    { scope: "default", kind: "hypothesis", statement: "keep answers short" },
    { key: randomUUID(), now: T0 + 100 },
  );
  const runs = repo.readLoopRunFacts(10);
  for (const fact of runs.slice(0, 3)) {
    repo.attachLearningEvidence(
      sessionId,
      hypothesis.body.id,
      { polarity: "supports", sourceKind: "run", sourceId: fact.runId },
      { key: randomUUID(), now: T0 + 101 },
    );
  }
  return { sessionId, taskId: task.body.id, hypothesisId: hypothesis.body.id };
}

describe("daily plan", () => {
  it("stages one read-only investigation under the standing task", async () => {
    const handle = openKernelDatabase(":memory:");
    await migrateKernelDatabase({ db: handle.raw });
    try {
      const repo = createKernelRepository(handle.raw);
      const { sessionId, taskId, hypothesisId } = await seed(repo);
      const service = createReflectService({
        repo,
        gateway: null,
        model: "test",
        now: () => T0 + 200,
        selfLoop: {
          enabled: true,
          sessionId,
          taskId,
          minEvidence: 3,
          dailyProposals: 1,
        },
        trialProfile: PROFILE,
        workspaceAlias: "ws",
      });
      await service.plan();
      const trials = repo.listTrials(sessionId);
      expect(trials.items).toHaveLength(1);
      expect(trials.items[0]).toMatchObject({
        taskId,
        operation: "investigate",
        readOnlyMode: true,
        literalPatchPaths: [],
      });
      expect((trials.items[0] as { objective: string }).objective).toContain(
        "keep answers short",
      );
      // The plan marks the hypothesis as proposed: a second pass is a no-op.
      await service.plan();
      expect(repo.listTrials(sessionId).items).toHaveLength(1);
      expect(hypothesisId).toBeTruthy();
      await service.stop();
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("does nothing when disabled, frozen, or below the evidence threshold", async () => {
    const handle = openKernelDatabase(":memory:");
    await migrateKernelDatabase({ db: handle.raw });
    try {
      const repo = createKernelRepository(handle.raw);
      const { sessionId, taskId } = await seed(repo);
      const disabled = createReflectService({
        repo,
        gateway: null,
        model: "test",
        now: () => T0 + 200,
        selfLoop: null,
        trialProfile: PROFILE,
        workspaceAlias: "ws",
      });
      await disabled.plan();
      expect(repo.listTrials(sessionId).items).toHaveLength(0);
      await disabled.stop();

      const control = repo.getAutonomyControlState();
      repo.setAutonomyControlState(
        {
          paused: false,
          learningFrozen: true,
          expectedVersion: control.version,
        },
        { key: randomUUID(), now: T0 + 201 },
      );
      const frozen = createReflectService({
        repo,
        gateway: null,
        model: "test",
        now: () => T0 + 202,
        selfLoop: {
          enabled: true,
          sessionId,
          taskId,
          minEvidence: 3,
          dailyProposals: 1,
        },
        trialProfile: PROFILE,
        workspaceAlias: "ws",
      });
      await frozen.plan();
      expect(repo.listTrials(sessionId).items).toHaveLength(0);
      await frozen.stop();

      repo.setAutonomyControlState(
        {
          paused: false,
          learningFrozen: false,
          expectedVersion: repo.getAutonomyControlState().version,
        },
        { key: randomUUID(), now: T0 + 203 },
      );
      const highBar = createReflectService({
        repo,
        gateway: null,
        model: "test",
        now: () => T0 + 204,
        selfLoop: {
          enabled: true,
          sessionId,
          taskId,
          minEvidence: 4,
          dailyProposals: 1,
        },
        trialProfile: PROFILE,
        workspaceAlias: "ws",
      });
      await highBar.plan();
      expect(repo.listTrials(sessionId).items).toHaveLength(0);
      await highBar.stop();
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
