// Codex review regressions on PR #42 (batch 3/3): shadow reason freeze,
// filtered tool reads, and frozen task detail.
//
// Proves through the REAL kernel repository + migrator (+ ToolBroker for
// the agent-tool surface):
// - an explicit request `reason` is persisted on the job row AND frozen
//   into the claim context, so two requests for the same scope with
//   different requested focuses deliberate DIFFERENT input; the frozen
//   request text is citable ONLY as `sQ1` (reason-less / policy-change
//   jobs have no `sQ1`);
// - `purpose.list` / `task.list` apply status/kind filters in a bounded
//   SQL read (limit+1 probe), so older matching records are never hidden
//   behind newest-first truncation with a falsely complete `hasMore`;
// - frozen shadow tasks carry the bounded `body` + `reconsiderTrigger`.

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  closeKernelDatabase,
  createAutonomyReadRegistrations,
  createKernelRepository,
  createToolBroker,
  type KernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
} from "../src/index.js";

const T0 = 1_700_004_000_000;
const CTX = { origin: "test-origin", caller: "test-caller" };

async function makeRepo() {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  const repo = createKernelRepository(handle.raw);
  const session = repo.createSession({ key: randomUUID(), now: T0 });
  return {
    handle,
    repo,
    sessionId: session.body.sessionId as string,
  };
}

function unpause(repo: KernelRepository, expectedVersion: number, now: number) {
  return repo.setAutonomyControlState(
    { paused: false, expectedVersion },
    { key: randomUUID(), now },
  );
}

function newRunningRun(
  repo: KernelRepository,
  sessionId: string,
  now: number,
): string {
  const posted = repo.postMessage(
    sessionId,
    { text: "hello" },
    { key: randomUUID(), now },
  );
  const runId = (posted.body as { run: { id: string } }).run.id;
  repo.startRun(runId, { now: now + 1 });
  return runId;
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

function validOutput(evidenceIds: string[]) {
  return {
    decision: "do-nothing",
    evidenceIds,
    reason: "nothing to do yet",
    proposedAction: null,
    completion: "none required",
    stopConditions: ["any new constraint appears"],
    uncertainty: "low",
    counterargument: "waiting could misread intent",
  };
}

describe("codex #42 batch 3 reason freeze + filtered reads + task detail", () => {
  it("persists the explicit reason on the job and freezes different input per reason", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      unpause(repo, 1, T0 + 10);
      const first = repo.requestShadowDeliberation(
        sessionId,
        { scope: "health", reason: "focus on morning walks" },
        { key: randomUUID(), now: T0 + 20 },
      );
      expect(first.status).toBe(201);
      const row = handle.raw
        .prepare("SELECT request_reason FROM shadow_jobs WHERE id = ?")
        .get(first.body.id) as { request_reason: string | null };
      expect(row.request_reason).toBe("focus on morning walks");
      const claimed = repo.claimShadowJob(
        sessionId,
        first.body.id,
        { owner: "worker-1", expectedVersion: 1 },
        { now: T0 + 30 },
      );
      expect(claimed.outcome).toBe("claimed");
      expect(claimed.context?.requestReason).toBe("focus on morning walks");
      // Settle the first job (single live lease) before claiming the next.
      repo.completeShadowJob(sessionId, first.body.id, validOutput(["sQ1"]), {
        expectedVersion: claimed.job.version,
        leaseOwner: "worker-1",
        now: T0 + 35,
      });
      // A second request for the SAME scope with a DIFFERENT focus freezes
      // different deliberation input (not identical context text).
      const second = repo.requestShadowDeliberation(
        sessionId,
        { scope: "health", reason: "focus on evening meals" },
        { key: randomUUID(), now: T0 + 40 },
      );
      const claimedSecond = repo.claimShadowJob(
        sessionId,
        second.body.id,
        { owner: "worker-1", expectedVersion: 1 },
        { now: T0 + 50 },
      );
      expect(claimedSecond.context?.requestReason).toBe(
        "focus on evening meals",
      );
      expect(JSON.stringify(claimedSecond.context)).not.toBe(
        JSON.stringify(claimed.context),
      );
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("cites the frozen reason ONLY as sQ1 (absent for reason-less jobs)", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      unpause(repo, 1, T0 + 10);
      const withReason = repo.requestShadowDeliberation(
        sessionId,
        { scope: "health", reason: "focus on sleep" },
        { key: randomUUID(), now: T0 + 20 },
      );
      const claimed = repo.claimShadowJob(
        sessionId,
        withReason.body.id,
        { owner: "worker-1", expectedVersion: 1 },
        { now: T0 + 30 },
      );
      const done = repo.completeShadowJob(
        sessionId,
        withReason.body.id,
        validOutput(["sQ1"]),
        {
          expectedVersion: claimed.job.version,
          leaseOwner: "worker-1",
          now: T0 + 40,
        },
      );
      expect(done.outcome).toBe("completed");
      // Reason-less request: no `sQ1` label exists, so citing it is rejected
      // as a non-frozen evidence id (never silently accepted).
      const bare = repo.requestShadowDeliberation(
        sessionId,
        { scope: "health" },
        { key: randomUUID(), now: T0 + 50 },
      );
      const claimedBare = repo.claimShadowJob(
        sessionId,
        bare.body.id,
        { owner: "worker-1", expectedVersion: 1 },
        { now: T0 + 60 },
      );
      expect(claimedBare.context?.requestReason).toBeNull();
      expect(() =>
        repo.completeShadowJob(sessionId, bare.body.id, validOutput(["sQ1"]), {
          expectedVersion: claimedBare.job.version,
          leaseOwner: "worker-1",
          now: T0 + 70,
        }),
      ).toThrow();
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("purpose.list finds older kind matches past the newest-100 window", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      unpause(repo, 1, T0 + 10);
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: createAutonomyReadRegistrations({ repo }),
      });
      const runId = newRunningRun(repo, sessionId, T0 + 20);
      // The single oldest record matches; 100 newer records do not.
      const target = repo.createAutonomyPurpose(
        sessionId,
        goalBody("old constraint", { kind: "constraint" }),
        { key: randomUUID(), now: T0 + 30 },
      );
      for (let i = 0; i < 100; i += 1) {
        repo.createAutonomyPurpose(sessionId, goalBody(`goal ${i}`), {
          key: randomUUID(),
          now: T0 + 40 + i,
        });
      }
      const out = await broker.invoke(
        runId,
        "purpose.list",
        { kind: "constraint", limit: 20 },
        CTX,
      );
      expect(out.result.actualOutcome).toBe("succeeded");
      const model = out.modelFacing as {
        items: { purposeId: string }[];
        hasMore: boolean;
      };
      expect(model.items.map((i) => i.purposeId)).toEqual([target.body.id]);
      expect(model.hasMore).toBe(false);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("task.list finds older kind matches past the newest-100 window", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      unpause(repo, 1, T0 + 10);
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: createAutonomyReadRegistrations({ repo }),
      });
      const runId = newRunningRun(repo, sessionId, T0 + 20);
      const target = repo.createAutonomyTask(
        sessionId,
        {
          scope: "health",
          title: "old problem",
          kind: "problem",
          speaker: "user",
        },
        { key: randomUUID(), now: T0 + 30 },
      );
      for (let i = 0; i < 100; i += 1) {
        repo.createAutonomyTask(
          sessionId,
          {
            scope: "health",
            title: `task ${i}`,
            kind: "task",
            speaker: "user",
          },
          { key: randomUUID(), now: T0 + 40 + i },
        );
      }
      const out = await broker.invoke(
        runId,
        "task.list",
        { kind: "problem", limit: 20 },
        CTX,
      );
      expect(out.result.actualOutcome).toBe("succeeded");
      const model = out.modelFacing as {
        items: { taskId: string }[];
        hasMore: boolean;
      };
      expect(model.items.map((i) => i.taskId)).toEqual([target.body.id]);
      expect(model.hasMore).toBe(false);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("freezes bounded task body + reconsiderTrigger in the claim context", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      unpause(repo, 1, T0 + 10);
      const task = repo.createAutonomyTask(
        sessionId,
        {
          scope: "health",
          title: "take pills",
          body: "take pills after breakfast",
          kind: "task",
          speaker: "user",
        },
        { key: randomUUID(), now: T0 + 20 },
      );
      repo.holdAutonomyTask(
        sessionId,
        task.body.id,
        {
          expectedVersion: 1,
          reason: "waiting_on_doctor",
          reconsiderTrigger: "doctor replies",
        },
        { key: randomUUID(), now: T0 + 30 },
      );
      const requested = repo.requestShadowDeliberation(
        sessionId,
        { scope: "health", reason: "review held task" },
        { key: randomUUID(), now: T0 + 40 },
      );
      const claimed = repo.claimShadowJob(
        sessionId,
        requested.body.id,
        { owner: "worker-1", expectedVersion: 1 },
        { now: T0 + 50 },
      );
      expect(claimed.outcome).toBe("claimed");
      expect(claimed.context?.tasks).toHaveLength(1);
      expect(claimed.context?.tasks[0]?.body).toBe(
        "take pills after breakfast",
      );
      expect(claimed.context?.tasks[0]?.reconsiderTrigger).toBe(
        "doctor replies",
      );
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
