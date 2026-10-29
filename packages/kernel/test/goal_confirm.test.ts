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
    allowedPaths: ["src", "apps", "packages"],
    modelRoute: "external" as const,
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
  it("promotes an adopted goal to user provenance", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const { goal, task } = adoptedGoal(repo, sessionId);
      // A self goal already stages a trial (the human approves the trial),
      // so confirmation is a provenance upgrade, not an authority switch.
      const staged = repo.stageTrial(sessionId, stageInput(task.id), {
        key: randomUUID(),
        now: NOW + 4,
        profile: profile(),
        workspaceAlias: "ws",
      });
      expect(staged.status).toBe(201);
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
      // Confirmation is a policy change (provenance + version), so it
      // must enqueue shadow work in the same transaction instead of
      // letting an in-flight job fence with no successor.
      const jobs = repo
        .listShadowJobs(sessionId, { limit: 50 })
        .items.filter(
          (job) =>
            job.triggerEvent === "purpose.confirmed" &&
            job.triggerId === goal.id,
        );
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.status).toBe("pending");
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

  it("rejects non-goal purposes without writing", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const constraint = repo.createAutonomyPurpose(
        sessionId,
        {
          scope: "s1",
          statement: "never deploy on fridays",
          kind: "constraint",
          explicit: false,
          sourceKind: "self",
        },
        { key: randomUUID(), now: NOW + 2 },
      );
      expect(() =>
        repo.confirmAutonomyPurpose(
          sessionId,
          constraint.body.id,
          { expectedVersion: constraint.body.version },
          { key: randomUUID(), now: NOW + 4 },
        ),
      ).toThrow(/purpose kind constraint cannot be confirmed as a goal/);
      const row = handle.raw
        .prepare(
          "SELECT kind, is_explicit, version, confirmed_from, confirmed_at FROM autonomy_purposes WHERE id = ?",
        )
        .get(constraint.body.id) as {
        kind: string;
        is_explicit: number;
        version: number;
        confirmed_from: string | null;
        confirmed_at: number | null;
      };
      expect(row).toEqual({
        kind: "constraint",
        is_explicit: 0,
        version: constraint.body.version,
        confirmed_from: null,
        confirmed_at: null,
      });
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("refuses an explicit self-sourced purpose without writing", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const forged = repo.createAutonomyPurpose(
        sessionId,
        {
          scope: "s1",
          statement: "ship it",
          kind: "goal",
          explicit: true,
          sourceKind: "self",
        },
        { key: randomUUID(), now: NOW + 2 },
      );
      expect(() =>
        repo.confirmAutonomyPurpose(
          sessionId,
          forged.body.id,
          { expectedVersion: forged.body.version },
          { key: randomUUID(), now: NOW + 4 },
        ),
      ).toThrow(/already explicit from self and cannot be confirmed/);
      const row = handle.raw
        .prepare(
          "SELECT is_explicit, source_kind, version, confirmed_from, confirmed_at FROM autonomy_purposes WHERE id = ?",
        )
        .get(forged.body.id) as {
        is_explicit: number;
        source_kind: string;
        version: number;
        confirmed_from: string | null;
        confirmed_at: number | null;
      };
      expect(row).toEqual({
        is_explicit: 1,
        source_kind: "self",
        version: forged.body.version,
        confirmed_from: null,
        confirmed_at: null,
      });
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
