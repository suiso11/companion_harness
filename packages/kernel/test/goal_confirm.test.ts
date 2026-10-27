// Human-only promotion of chat-adopted goals (real DB + production repo).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildAgentToolDefinitions,
  closeKernelDatabase,
  createKernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
} from "../src/index.js";

const NOW = 1_750_000_000_000;
const REV = "a".repeat(40);
const FP = "b".repeat(64);

function profile() {
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

/** Goal adopted from a chat proposal: non-explicit, source_kind='self'. */
function adoptedGoal(
  repo: ReturnType<typeof createKernelRepository>,
  sessionId: string,
  scope = "s1",
) {
  const g = repo.createAutonomyPurpose(
    sessionId,
    {
      scope,
      statement: "ship it",
      kind: "goal",
      explicit: false,
      sourceKind: "self",
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

function stageInput(taskId: string) {
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
  };
}

describe("goal confirmation", () => {
  it("promotes an adopted goal so trial authority passes", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const { goal, task } = adoptedGoal(repo, sessionId);
      expect(() =>
        repo.stageTrial(sessionId, stageInput(task.id), {
          key: randomUUID(),
          now: NOW + 4,
          profile: profile(),
          workspaceAlias: "ws",
        }),
      ).toThrow();
      const out = repo.confirmAutonomyPurpose(
        sessionId,
        goal.id,
        { expectedVersion: goal.version },
        { key: randomUUID(), now: NOW + 5 },
      );
      expect(out.status).toBe(200);
      expect(out.body.explicit).toBe(true);
      expect(out.body.sourceKind).toBe("user");
      const row = handle.raw
        .prepare(
          "SELECT confirmed_from, confirmed_at FROM autonomy_purposes WHERE id = ?",
        )
        .get(goal.id) as { confirmed_from: string; confirmed_at: number };
      expect(row.confirmed_from).toBe("conversation_proposal");
      expect(row.confirmed_at).toBe(NOW + 5);
      const st = repo.stageTrial(sessionId, stageInput(task.id), {
        key: randomUUID(),
        now: NOW + 6,
        profile: profile(),
        workspaceAlias: "ws",
      });
      expect(st.status).toBe(201);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("is an idempotent no-op for an already explicit goal", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const { goal } = adoptedGoal(repo, sessionId);
      const first = repo.confirmAutonomyPurpose(
        sessionId,
        goal.id,
        { expectedVersion: goal.version },
        { key: randomUUID(), now: NOW + 4 },
      );
      const again = repo.confirmAutonomyPurpose(
        sessionId,
        goal.id,
        { expectedVersion: first.body.version },
        { key: randomUUID(), now: NOW + 5 },
      );
      expect(again.status).toBe(200);
      expect(again.body.version).toBe(first.body.version);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("rejects CAS mismatch and terminal goals", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const { goal } = adoptedGoal(repo, sessionId);
      expect(() =>
        repo.confirmAutonomyPurpose(
          sessionId,
          goal.id,
          { expectedVersion: goal.version + 9 },
          { key: randomUUID(), now: NOW + 4 },
        ),
      ).toThrow(/version conflict/);
      repo.revokeAutonomyPurpose(
        sessionId,
        goal.id,
        { expectedVersion: goal.version },
        { key: randomUUID(), now: NOW + 5 },
      );
      expect(() =>
        repo.confirmAutonomyPurpose(
          sessionId,
          goal.id,
          { expectedVersion: goal.version + 1 },
          { key: randomUUID(), now: NOW + 6 },
        ),
      ).toThrow();
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("never advertises a model tool for confirmation", () => {
    const tools = buildAgentToolDefinitions([
      {
        name: "purpose.confirm",
        version: 1,
        title: "confirm a goal",
        description: "confirm a goal",
        category: "write",
      },
    ] as never);
    expect(tools.some((tool) => /confirm/.test(tool.name))).toBe(false);
  });
});
