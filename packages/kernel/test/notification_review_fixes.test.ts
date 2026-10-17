// Review regression: P1 deadline head-of-line + P2 frozen-window expiry.
// REAL kernel repository + migrator on real SQLite (:memory:), no mocks.
// Each test FAILS on the pre-fix core and passes after the fix.

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  closeKernelDatabase,
  createKernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
} from "../src/index.js";

const T0 = 1_700_001_000_000;
const PAST_DEADLINE = "2020-01-01T10:00:00Z";
const FUTURE_START = "2030-06-01T10:00:00Z";

type Repo = ReturnType<typeof createKernelRepository>;
type Handle = ReturnType<typeof openKernelDatabase>;

async function makeRepo(): Promise<{
  handle: Handle;
  repo: Repo;
  sessionId: string;
}> {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  const repo = createKernelRepository(handle.raw, {
    actionProposals: { writeEnabled: true },
  });
  const session = repo.createSession({ key: randomUUID(), now: T0 });
  return { handle, repo, sessionId: session.body.sessionId };
}

function unpause(repo: Repo, expectedVersion: number, now: number) {
  return repo.setAutonomyControlState(
    { paused: false, expectedVersion },
    { key: randomUUID(), now },
  );
}

function validOutput(
  evidenceIds: string[],
  extra: Record<string, unknown> = {},
) {
  return {
    decision: "do-nothing",
    evidenceIds,
    reason: "nothing to do yet",
    proposedAction: null,
    completion: "none required",
    stopConditions: ["any new constraint appears"],
    uncertainty: "low",
    counterargument: "waiting could miss a window",
    ...extra,
  };
}

function completeAskJob(
  repo: Repo,
  sessionId: string,
  scope: string,
  pickEvidence: (labels: { purposes: string[]; tasks: string[] }) => string[],
  now: number,
) {
  const requested = repo.requestShadowDeliberation(
    sessionId,
    { scope },
    { key: randomUUID(), now },
  );
  const claimed = repo.claimShadowJob(
    sessionId,
    requested.body.id,
    { owner: "worker-1", expectedVersion: 1 },
    { now: now + 1 },
  );
  const labels = {
    purposes: (claimed.context?.purposes ?? []).map((p) => p.label),
    tasks: (claimed.context?.tasks ?? []).map((t) => t.label),
  };
  const done = repo.completeShadowJob(
    sessionId,
    requested.body.id,
    validOutput(pickEvidence(labels), {
      decision: "ask",
      reason: "needs a human answer",
    }),
    { expectedVersion: 2, leaseOwner: "worker-1", now: now + 2 },
  );
  return done;
}

describe("review fixes: deadline drain + frozen window expiry", () => {
  it("P1: one record pass drains >100 due past the cutoff-skipped head and the timer goes quiet", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      // Old past deadline created while paused: resume-skipped forever.
      repo.createAutonomyTask(
        sessionId,
        {
          scope: "health",
          title: "old past item",
          kind: "task",
          speaker: "user",
          deadline: PAST_DEADLINE,
        },
        { key: randomUUID(), now: T0 + 5 },
      );
      unpause(repo, 1, T0 + 10);
      // 105 newly created explicit past deadlines: NEW state, all eligible
      // in a SINGLE due scan even though the skipped head row sorts first
      // (same due, smaller task id order is not guaranteed — the head of
      // line is the cutoff-skipped + settled rows under LIMIT 100).
      const ids: string[] = [];
      for (let i = 0; i < 105; i += 1) {
        const created = repo.createAutonomyTask(
          sessionId,
          {
            scope: `bulk${i}`,
            title: `bulk task ${i}`,
            kind: "task",
            speaker: "user",
            deadline: PAST_DEADLINE,
          },
          { key: randomUUID(), now: T0 + 40 + i },
        );
        ids.push(created.body.id);
      }
      repo.buildDeadlineSchedule(sessionId, { now: T0 + 200 });
      const control = repo.getAutonomyControlState();
      // SINGLE pass must reach every eligible row past the 100-row head.
      const once = repo.recordDueDeadlines(sessionId, {
        expectedControlVersion: control.version,
        now: T0 + 300,
      });
      expect(once.status).toBe("recorded");
      expect(once.recorded).toBe(105);
      // Same-task same-deadline dedup: exactly one alert per actual
      // deadline, even after a meaningful hold/resume task update.
      repo.holdAutonomyTask(
        sessionId,
        ids[0] as string,
        {
          expectedVersion: 1,
          reason: "waiting",
          reconsiderTrigger: "user_confirmed",
        },
        { key: randomUUID(), now: T0 + 400 },
      );
      repo.resumeAutonomyTask(
        sessionId,
        ids[0] as string,
        {
          expectedVersion: 2,
          evidenceKind: "user_confirmed",
          evidence: "called back",
        },
        { key: randomUUID(), now: T0 + 410 },
      );
      repo.buildDeadlineSchedule(sessionId, { now: T0 + 420 });
      const repeat = repo.recordDueDeadlines(sessionId, {
        expectedControlVersion: control.version,
        now: T0 + 500,
      });
      expect(repeat.recorded).toBe(0);
      // No genuinely-pending deadline remains: the timer must stay OFF
      // (no 1-second re-poll on already-notified / cutoff-skipped rows).
      // A future deadline created on resume stays eligible.
      const fresh = repo.createAutonomyTask(
        sessionId,
        {
          scope: "health",
          title: "future item",
          kind: "task",
          speaker: "user",
          deadline: FUTURE_START,
        },
        { key: randomUUID(), now: T0 + 600 },
      );
      repo.buildDeadlineSchedule(sessionId, { now: T0 + 610 });
      const next = repo.getNextDeadline(sessionId, { now: T0 + 620 });
      expect(next.paused).toBe(false);
      expect(next.deadline?.taskId).toBe(fresh.body.id);
      const dueNow = repo.recordDueDeadlines(sessionId, {
        expectedControlVersion: control.version,
        now: Date.parse(FUTURE_START) + 1_000,
      });
      expect(dueNow.recorded).toBe(1);
      const quiet = repo.getNextDeadline(sessionId, {
        now: Date.parse(FUTURE_START) + 2_000,
      });
      expect(quiet.deadline).toBeNull();
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("P2: a question completed before validUntil but ingested after it still expires", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      // Window ends at T0+60s; the job completes before the end.
      const windowEnd = new Date(T0 + 60_000).toISOString();
      repo.createAutonomyPurpose(
        sessionId,
        {
          scope: "health",
          statement: "windowed goal",
          kind: "goal",
          explicit: true,
          sourceKind: "user",
          validUntil: windowEnd,
        },
        { key: randomUUID(), now: T0 + 5 },
      );
      unpause(repo, 1, T0 + 10);
      completeAskJob(
        repo,
        sessionId,
        "health",
        (labels) => [labels.purposes[0] as string],
        T0 + 20,
      );
      // Ingestion lands AFTER the frozen window already ended.
      const out = repo.ingestNotifications(sessionId, { now: T0 + 120_000 });
      expect(out.ingested).toBe(1);
      const item = repo.listNotifications(sessionId, { now: T0 + 120_000 })
        .items[0] as NonNullable<
        ReturnType<Repo["listNotifications"]>["items"][0]
      >;
      expect(item.kind).toBe("question");
      // The stale validUntil persists as the derived expiry (past), so the
      // stored original reads outdated with zero unread — never actionable
      // forever. The cited-deadline future-only rule is untouched: no cited
      // deadlines here, and the expiry is a purpose window, not a task
      // deadline alert.
      expect(item.contextExpiryAt).toBe(Date.parse(windowEnd));
      expect(item.outdated).toBe(true);
      expect(
        repo.listNotifications(sessionId, { now: T0 + 120_000 }).unreadCount,
      ).toBe(0);
      const stored = handle.raw
        .prepare("SELECT outdated AS outdated FROM notifications WHERE id = ?")
        .get(item.id) as { outdated: number };
      expect(stored.outdated).toBe(0);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("P2: a future active validFrom bounds a question even when inapplicable at claim", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      repo.createAutonomyPurpose(
        sessionId,
        {
          scope: "health",
          statement: "evergreen goal",
          kind: "goal",
          explicit: true,
          sourceKind: "user",
        },
        { key: randomUUID(), now: T0 + 5 },
      );
      // Active constraint whose window STARTS in the future: inapplicable
      // at claim, but the context changes at validFrom.
      repo.createAutonomyPurpose(
        sessionId,
        {
          scope: "health",
          statement: "future constraint",
          kind: "constraint",
          explicit: true,
          sourceKind: "user",
          validFrom: FUTURE_START,
        },
        { key: randomUUID(), now: T0 + 6 },
      );
      // Old expired history: must never become a future transition.
      repo.createAutonomyPurpose(
        sessionId,
        {
          scope: "health",
          statement: "long-dead goal",
          kind: "goal",
          explicit: true,
          sourceKind: "user",
          validFrom: "2019-01-01T10:00:00Z",
          validUntil: PAST_DEADLINE,
        },
        { key: randomUUID(), now: T0 + 7 },
      );
      unpause(repo, 1, T0 + 10);
      completeAskJob(
        repo,
        sessionId,
        "health",
        (labels) => [labels.purposes[0] as string],
        T0 + 20,
      );
      expect(
        repo.ingestNotifications(sessionId, { now: T0 + 30 }).ingested,
      ).toBe(1);
      const item = repo.listNotifications(sessionId, {})
        .items[0] as NonNullable<
        ReturnType<Repo["listNotifications"]>["items"][0]
      >;
      expect(item.kind).toBe("question");
      expect(item.citedDeadlines).toEqual([]);
      expect(item.contextExpiryAt).toBe(Date.parse(FUTURE_START));
      // At validFrom the SAME stored row reads outdated with NO new source
      // event and zero unread; the old expired window did not move the
      // expiry earlier.
      const atStart = repo.listNotifications(sessionId, {
        now: Date.parse(FUTURE_START),
      });
      expect(atStart.items[0]?.outdated).toBe(true);
      expect(atStart.unreadCount).toBe(0);
      const before = repo.listNotifications(sessionId, {
        now: Date.parse(FUTURE_START) - 1_000,
      });
      expect(before.items[0]?.outdated).toBe(false);
      expect(before.unreadCount).toBe(1);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
