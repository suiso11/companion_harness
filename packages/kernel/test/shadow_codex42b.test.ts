// Codex review regressions on PR #42 (batch 2/3): shadow queue P1s.
//
// Proves through the REAL kernel repository + migrator:
// - a repeat trigger emitted while its job is CLAIMED queues a pending
//   successor (never coalesces into the claimed job, whose completion is
//   fenced by the epoch bump);
// - correcting a purpose into a NEW scope enqueues a job for the OLD scope
//   too (supersession + dependent holds are deliberated, and an in-flight
//   old-scope job gets a successor).

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  closeKernelDatabase,
  createKernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
} from "../src/index.js";
import { enqueueShadowSourceInTx } from "../src/shadow.js";

const T0 = 1_700_002_000_000;

async function makeRepo() {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  const repo = createKernelRepository(handle.raw);
  const session = repo.createSession({ key: randomUUID(), now: T0 });
  return {
    handle,
    repo,
    sessionId: session.body.sessionId,
  };
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

function unpause(
  repo: ReturnType<typeof createKernelRepository>,
  expectedVersion: number,
  now: number,
) {
  return repo.setAutonomyControlState(
    { paused: false, expectedVersion },
    { key: randomUUID(), now },
  );
}

describe("codex #42 batch 2 shadow queue P1s", () => {
  it("queues a pending successor when the same trigger fires while claimed", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      unpause(repo, 1, T0 + 10);
      const created = repo.createAutonomyPurpose(
        sessionId,
        goalBody("walk daily"),
        { key: randomUUID(), now: T0 + 20 },
      );
      const trigger = {
        sessionId,
        scope: "health",
        source: "purpose" as const,
        sourceId: created.body.id,
        triggerEvent: "purpose.updated",
        kind: "policy_change" as const,
      };
      const first = enqueueShadowSourceInTx(handle.raw, trigger, T0 + 30);
      expect(first.reused).toBe(false);
      const claimed = repo.claimShadowJob(
        sessionId,
        first.jobId as string,
        { owner: "worker-1", expectedVersion: 1 },
        { now: T0 + 40 },
      );
      expect(claimed.outcome).toBe("claimed");
      // Same source re-emits the same trigger during the model call.
      const second = enqueueShadowSourceInTx(handle.raw, trigger, T0 + 50);
      expect(second.reused).toBe(false);
      expect(second.jobId).not.toBeNull();
      expect(second.jobId).not.toBe(first.jobId);
      const jobs = repo.listShadowJobs(sessionId, { limit: 50 });
      const pair = jobs.items.filter(
        (j) => j.triggerEvent === "purpose.updated",
      );
      expect(pair.map((j) => j.status).sort()).toEqual(["claimed", "pending"]);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("enqueues both scopes when a correction moves a purpose", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      unpause(repo, 1, T0 + 10);
      const created = repo.createAutonomyPurpose(
        sessionId,
        goalBody("walk daily"),
        { key: randomUUID(), now: T0 + 20 },
      );
      const corrected = repo.correctAutonomyPurpose(
        sessionId,
        {
          ...goalBody("walk daily", { scope: "finance" }),
          purposeId: created.body.id,
          expectedVersion: 1,
        },
        { key: randomUUID(), now: T0 + 30 },
      );
      expect(corrected.status).toBe(201);
      const jobs = repo.listShadowJobs(sessionId, { limit: 50 });
      const scopes = jobs.items.map((j) => j.scope);
      expect(scopes).toContain("finance");
      // The creation-time health job is NOT enough: the correction itself
      // must leave a fresh pending job for the retired old scope.
      const oldScopeJob = jobs.items.find(
        (j) => j.scope === "health" && j.triggerEvent === "purpose.superseded",
      );
      expect(oldScopeJob?.status).toBe("pending");
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
