// AV05 notifications durable-projection core: permanent behavioral proof.
//
// Proves through the REAL kernel repository + migrator on real SQLite
// (better-sqlite3, :memory:): no mocks, no echo fixtures, no source-text
// assertions.
//
// - Ingest consumes a REAL completed shadow job (requested + claimed +
//   fenced-completed through the production shadow core with a synthetic
//   validated model output — synthetic fixture, never a real model) and
//   records an immutable owned notice (per-session monotonic seq, scope,
//   kind, CODE-computed priority, source version/epoch, cited deadlines).
// - A do-nothing completion records ZERO notifications.
// - Repeated explicit re-evaluation of the SAME semantic state dedups
//   (paraphrased reason / new job id do not re-notify); a second catchup
//   ingests zero.
// - Source cursors baseline at MAX(rowid) on first ingest (historical rows
//   are not mass-notified); afterwards only durable unseen changes notify.
//   A renumbered source surfaces an honest projection-reset error with NO
//   partial cursor advance and NO partial inserts (atomic rollback).
// - Claims never become grants: ingest creates no executions / grants (the
//   honest CODE `missing_grant` diagnostic stays a diagnostic).
// - Ack is a separate immutable receipt (stable-key replay, drift 409,
//   foreign 404) with ZERO effect on purpose / task / control / grant
//   state; list / get / history / cursor are pure reads (no auto-ack) with
//   truthful latestSeq / unread counts.
// - An ACTUAL owned M5 receipt fixture (existing stager + approval +
//   execution service driven to a real `unknown` terminal — the same
//   production path as the receipt tests, never a fake worker outcome
//   written as "live") ingests to an URGENT commitment notice even while
//   autonomy is paused.
// - Deadline schedule rebuild ITERATES the whole task source (213-task
//   proof: no silent truncation, ineligible rows honestly excluded) and
//   reads the earliest due; terminal tasks drop only their derived row;
//   old past deadlines are NOT caught up after resume unless the task was
//   meaningfully updated after it; a newly created explicit past deadline
//   logs once; hold/resume cycles never re-alert; paused / stale callers
//   get honest zero-recording statuses, never fake alerts.

import { randomUUID } from "node:crypto";
import { SnapshotBodySchema } from "@companion/contracts";
import { describe, expect, it } from "vitest";
import { calendarEventBodyText } from "../src/calendar_tools.js";
import { canonicalJsonString } from "../src/canonical.js";
import {
  closeKernelDatabase,
  createActionExecutionService,
  createKernelRepository,
  createReferenceManager,
  generateId,
  migrateKernelDatabase,
  NotificationKeyConflictError,
  NotificationProjectionResetError,
  openKernelDatabase,
  RepositoryNotFoundError,
} from "../src/index.js";

const T0 = 1_700_001_000_000;
const FUTURE_DEADLINE = "2030-06-01T10:00:00Z";
const LATER_DEADLINE = "2031-01-01T10:00:00Z";
// Genuinely past relative to the frozen test clock T0 (2023-11): exercises
// the explicit-resume cutoff without depending on the wall clock.
const PAST_DEADLINE = "2020-01-01T10:00:00Z";

type Repo = ReturnType<typeof createKernelRepository>;
type Handle = ReturnType<typeof openKernelDatabase>;

async function makeRepo(): Promise<{
  handle: Handle;
  repo: Repo;
  sessionId: string;
  otherId: string;
}> {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  const repo = createKernelRepository(handle.raw, {
    actionProposals: { writeEnabled: true },
  });
  const session = repo.createSession({ key: randomUUID(), now: T0 });
  const other = repo.createSession({ key: randomUUID(), now: T0 + 1 });
  return {
    handle,
    repo,
    sessionId: session.body.sessionId,
    otherId: other.body.sessionId,
  };
}

function unpause(repo: Repo, expectedVersion: number, now: number) {
  return repo.setAutonomyControlState(
    { paused: false, expectedVersion },
    { key: randomUUID(), now },
  );
}

/** Seed one explicit user goal so the frozen context carries sP labels. */
function seedPurpose(
  repo: Repo,
  sessionId: string,
  scope: string,
  now: number,
) {
  return repo.createAutonomyPurpose(
    sessionId,
    {
      scope,
      statement: `goal for ${scope}`,
      kind: "goal",
      explicit: true,
      sourceKind: "user",
    },
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

interface FrozenLabels {
  purposes: string[];
  tasks: string[];
}

/**
 * Request + claim + fenced-complete one explicit job (unpaused control).
 * Evidence always uses the REAL frozen labels from the claim — never
 * invented ids — so completion fences honestly.
 */
function completeExplicitJob(
  repo: Repo,
  sessionId: string,
  scope: string,
  makeDecision: (labels: FrozenLabels) => unknown,
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
  const labels: FrozenLabels = {
    purposes: (claimed.context?.purposes ?? []).map((p) => p.label),
    tasks: (claimed.context?.tasks ?? []).map((t) => t.label),
  };
  const done = repo.completeShadowJob(
    sessionId,
    requested.body.id,
    makeDecision(labels),
    { expectedVersion: 2, leaseOwner: "worker-1", now: now + 2 },
  );
  return { requested, claimed, done };
}

function countRows(handle: Handle, table: string): number {
  return (
    handle.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
      n: number;
    }
  ).n;
}

/* M5 owned-receipt fixture: the EXISTING stager + approval + execution
 * service path (mirrors action_history_receipt.test.ts), driven to a real
 * `unknown` terminal. Synthetic calendar seed, never real Google. */
const CALENDAR_EVENT_BODY = calendarEventBodyText({
  canonicalKey: "cal|cal1|evt1",
  status: "confirmed",
  title: "Event",
  start: "2026-01-01T10:00:00Z",
  end: "2026-01-01T11:00:00Z",
  allDayEndExclusive: true,
  sourceRevision: "src@1",
  revisionBasis: "etag",
} as const);

function snapshotBodyJson(): string {
  return canonicalJsonString(
    SnapshotBodySchema.parse({ version: 1, text: CALENDAR_EVENT_BODY }),
  );
}

async function driveUnknownReceipt(
  repo: Repo,
  handle: Handle,
  sessionId: string,
): Promise<{ executionId: string }> {
  const service = createActionExecutionService({
    db: handle.raw,
    referenceManager: createReferenceManager(handle.raw),
  });
  const posted = repo.postMessage(
    sessionId,
    { text: "reschedule please" },
    { key: randomUUID(), now: T0 },
  ).body;
  await repo.startRun(posted.run.id, { now: T0 + 1 });
  const connectorId = generateId();
  const resourceId = generateId();
  const snapshotId = generateId();
  const refId = generateId();
  handle.raw
    .prepare(
      "INSERT INTO connector_instances (id, kind, display_name, config_json, created_at) VALUES (?, 'calendar', 'c', '{}', 1)",
    )
    .run(connectorId);
  handle.raw
    .prepare(
      "INSERT INTO resources (id, connector_instance_id, canonical_key, title, next_revision, created_at) VALUES (?, ?, 'cal|cal1|evt1', 'Event', 2, 1)",
    )
    .run(resourceId, connectorId);
  handle.raw
    .prepare(
      "INSERT INTO resource_snapshots (id, resource_id, revision, source_revision, content_hash, body_json, size_bytes, observed_at, created_at) VALUES (?, ?, 1, 'src@1', 'hash@1', ?, 10, 1, 1)",
    )
    .run(snapshotId, resourceId, snapshotBodyJson());
  handle.raw
    .prepare(
      "INSERT INTO session_references (id, session_id, ordinal, resource_id, snapshot_id, created_at) VALUES (?, ?, 1, ?, ?, 1)",
    )
    .run(refId, sessionId, resourceId, snapshotId);
  handle.raw
    .prepare("UPDATE sessions SET next_reference_ordinal = 2 WHERE id = ?")
    .run(sessionId);
  const staged = repo.actionProposalsStager?.stage(posted.run.id, {
    targetRefId: refId,
    end: "2026-02-01T11:00:00.000Z",
    start: "2026-02-01T10:00:00.000Z",
  });
  if (staged === undefined) {
    throw new Error("staging unavailable");
  }
  repo.completeRun(
    posted.run.id,
    { version: 1, text: "here is the plan" },
    { now: T0 + 2 },
  );
  const events = repo.getEvents(sessionId, posted.run.id, {
    after: 0,
    limit: 50,
  });
  const proposed = events.events.find((e) => e.type === "action.proposed") as
    | { payload: { proposalId: string } }
    | undefined;
  if (proposed === undefined) {
    throw new Error("expected a committed proposal");
  }
  const approved = repo.approveProposal(
    sessionId,
    proposed.payload.proposalId,
    { proposalHash: staged.hash },
    { key: randomUUID(), now: T0 + 3 },
  );
  expect(
    service.startActionRun(approved.body.runId, { now: T0 + 4 }).applied,
  ).toBe(true);
  expect(
    service.consumeActionGrant(approved.body.runId, { now: T0 + 5 }).granted,
  ).toBe(true);
  const finished = service.finishActionExecution(
    approved.body.runId,
    { outcome: "unknown" },
    { now: T0 + 6 },
  );
  expect(finished.applied).toBe(true);
  return { executionId: approved.body.executionId };
}

describe("notifications durable core", () => {
  it("baselines historical rows, then notifies only durable unseen completions", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      seedPurpose(repo, sessionId, "health", T0 + 5);
      unpause(repo, 1, T0 + 10);
      // Historical work BEFORE the first ingest completes honestly.
      const first = completeExplicitJob(
        repo,
        sessionId,
        "health",
        (labels) =>
          validOutput(labels.purposes, {
            decision: "execute",
            proposedAction: { kind: "message", summary: "ping the owner" },
          }),
        T0 + 20,
      );
      expect(first.done.outcome).toBe("completed");
      // First ingest baselines all three sources: history is NOT mass-notified.
      const baseline = repo.ingestNotifications(sessionId, { now: T0 + 30 });
      expect(baseline.ingested).toBe(0);
      expect(baseline.latestSeq).toBe(0);
      // New meaningful work (a different decision => different state) notifies once.
      const second = completeExplicitJob(
        repo,
        sessionId,
        "health",
        (labels) =>
          validOutput(labels.purposes, {
            decision: "ask",
            reason: "need a call time",
            proposedAction: null,
          }),
        T0 + 40,
      );
      expect(second.done.outcome).toBe("completed");
      const caught = repo.ingestNotifications(sessionId, { now: T0 + 50 });
      expect(caught.ingested).toBe(1);
      expect(caught.latestSeq).toBe(1);
      const listed = repo.listNotifications(sessionId, {});
      expect(listed.items).toHaveLength(1);
      const item = listed.items[0] as NonNullable<(typeof listed.items)[0]>;
      expect(item.seq).toBe(1);
      expect(item.scope).toBe("health");
      expect(item.kind).toBe("question");
      expect(item.priority).toBe("routine");
      expect(item.sourceKind).toBe("shadow_job");
      expect(item.sourceVersion).toBe(3);
      expect(item.sourceEpoch).toBeGreaterThanOrEqual(1);
      expect(item.outdated).toBe(false);
      expect(listed.latestSeq).toBe(1);
      expect(listed.unreadCount).toBe(1);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("do-nothing completes store ZERO notifications", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      repo.ingestNotifications(sessionId, { now: T0 + 5 });
      seedPurpose(repo, sessionId, "health", T0 + 6);
      unpause(repo, 1, T0 + 10);
      const done = completeExplicitJob(
        repo,
        sessionId,
        "health",
        (labels) => validOutput(labels.purposes),
        T0 + 20,
      );
      expect(done.done.outcome).toBe("completed");
      expect(done.done.policyCode).toBe("no_action");
      const out = repo.ingestNotifications(sessionId, { now: T0 + 30 });
      expect(out.ingested).toBe(0);
      expect(out.latestSeq).toBe(0);
      expect(repo.listNotifications(sessionId, {}).items).toHaveLength(0);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("dedups repeated re-evaluation of the SAME state and never re-notifies on catchup", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      repo.ingestNotifications(sessionId, { now: T0 + 5 });
      seedPurpose(repo, sessionId, "health", T0 + 6);
      unpause(repo, 1, T0 + 10);
      const decide = (labels: FrozenLabels, reason: string) =>
        validOutput(labels.purposes, {
          decision: "execute",
          reason,
          proposedAction: { kind: "message", summary: "ping the owner" },
        });
      const one = completeExplicitJob(
        repo,
        sessionId,
        "health",
        (labels) => decide(labels, "first phrasing"),
        T0 + 20,
      );
      expect(one.done.outcome).toBe("completed");
      expect(
        repo.ingestNotifications(sessionId, { now: T0 + 30 }).ingested,
      ).toBe(1);
      // SAME state, paraphrased reason, brand-new job id: no new notice.
      const two = completeExplicitJob(
        repo,
        sessionId,
        "health",
        (labels) => decide(labels, "totally reworded second phrasing"),
        T0 + 40,
      );
      expect(two.done.outcome).toBe("completed");
      const again = repo.ingestNotifications(sessionId, { now: T0 + 50 });
      expect(again.ingested).toBe(0);
      expect(repo.listNotifications(sessionId, {}).items).toHaveLength(1);
      // Pure catchup with nothing new: zero ingested, seq intact.
      const idle = repo.ingestNotifications(sessionId, { now: T0 + 60 });
      expect(idle.ingested).toBe(0);
      expect(idle.latestSeq).toBe(1);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("rolls back atomically when a source renumber is detected (no partial state)", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      repo.ingestNotifications(sessionId, { now: T0 + 5 });
      seedPurpose(repo, sessionId, "health", T0 + 6);
      unpause(repo, 1, T0 + 10);
      // Renumber the receipts cursor far beyond reality (simulated rebuild).
      handle.raw
        .prepare(
          "UPDATE notification_cursors SET last_source_rowid = 999999 WHERE session_id = ? AND source = 'action_receipts'",
        )
        .run(sessionId);
      // New shadow work exists, but the receipts source is renumbered.
      completeExplicitJob(
        repo,
        sessionId,
        "health",
        (labels) =>
          validOutput(labels.purposes, {
            decision: "execute",
            proposedAction: { kind: "message", summary: "ping" },
          }),
        T0 + 20,
      );
      let reset: unknown;
      try {
        repo.ingestNotifications(sessionId, { now: T0 + 30 });
      } catch (error) {
        reset = error;
      }
      expect(reset).toBeInstanceOf(NotificationProjectionResetError);
      expect((reset as { code: string }).code).toBe(
        "notification_projection_reset_required",
      );
      // Atomic: the shadow insert rolled back with the throw.
      expect(countRows(handle, "notifications")).toBe(0);
      const shadowCursor = handle.raw
        .prepare(
          "SELECT last_source_rowid AS n FROM notification_cursors WHERE session_id = ? AND source = 'shadow_job_events'",
        )
        .get(sessionId) as { n: number };
      const maxEvent = handle.raw
        .prepare(
          "SELECT MAX(rowid) AS n FROM shadow_job_events WHERE session_id = ?",
        )
        .get(sessionId) as { n: number };
      expect(shadowCursor.n).toBeLessThan(maxEvent.n);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("records claims without granting authority (no executions, no grants)", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      repo.ingestNotifications(sessionId, { now: T0 + 5 });
      seedPurpose(repo, sessionId, "health", T0 + 6);
      unpause(repo, 1, T0 + 10);
      const beforeExec = countRows(handle, "action_executions");
      const beforeGrants = countRows(handle, "action_execution_grants");
      completeExplicitJob(
        repo,
        sessionId,
        "health",
        (labels) =>
          validOutput(labels.purposes, {
            decision: "execute",
            proposedAction: { kind: "message", summary: "ping" },
          }),
        T0 + 20,
      );
      repo.ingestNotifications(sessionId, { now: T0 + 30 });
      expect(countRows(handle, "action_executions")).toBe(beforeExec);
      expect(countRows(handle, "action_execution_grants")).toBe(beforeGrants);
      // The honest CODE diagnostic names the missing grant; nothing spends one.
      const item = repo.listNotifications(sessionId, {})
        .items[0] as NonNullable<
        ReturnType<Repo["listNotifications"]>["items"][0]
      >;
      expect(item.briefText).toContain("missing_grant");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("acks with stable-key replay + drift 409 + foreign 404 and zero purpose/task/control effect", async () => {
    const { handle, repo, sessionId, otherId } = await makeRepo();
    try {
      repo.ingestNotifications(sessionId, { now: T0 + 5 });
      seedPurpose(repo, sessionId, "health", T0 + 6);
      unpause(repo, 1, T0 + 10);
      completeExplicitJob(
        repo,
        sessionId,
        "health",
        (labels) =>
          validOutput(labels.purposes, {
            decision: "ask",
            reason: "need a call time",
            proposedAction: null,
          }),
        T0 + 20,
      );
      repo.ingestNotifications(sessionId, { now: T0 + 30 });
      const item = repo.listNotifications(sessionId, {})
        .items[0] as NonNullable<
        ReturnType<Repo["listNotifications"]>["items"][0]
      >;
      // Pure reads first: no auto-ack, no delivered mutation.
      expect(countRows(handle, "notification_acks")).toBe(0);
      repo.getNotification(sessionId, item.id);
      repo.getNotificationHistory(sessionId, item.id);
      repo.getLatestNotificationCursor(sessionId);
      expect(countRows(handle, "notification_acks")).toBe(0);
      const purposesBefore = countRows(handle, "autonomy_purposes");
      const tasksBefore = countRows(handle, "autonomy_tasks");
      const controlBefore = repo.getAutonomyControlState();
      const key = randomUUID();
      const acked = repo.ackNotification(sessionId, item.id, {
        key,
        now: T0 + 40,
      });
      expect(acked.status).toBe(201);
      expect(acked.replayed).toBe(false);
      expect(acked.body.status).toBe("acknowledged");
      // Same key replays; a second key drifts 409.
      const replay = repo.ackNotification(sessionId, item.id, {
        key,
        now: T0 + 41,
      });
      expect(replay.replayed).toBe(true);
      expect(replay.body.createdAt).toBe(acked.body.createdAt);
      expect(() =>
        repo.ackNotification(sessionId, item.id, {
          key: randomUUID(),
          now: T0 + 42,
        }),
      ).toThrowError(NotificationKeyConflictError);
      // Foreign session ids are 404, never 403.
      expect(() => repo.getNotification(otherId, item.id)).toThrowError(
        RepositoryNotFoundError,
      );
      expect(() =>
        repo.ackNotification(otherId, item.id, {
          key: randomUUID(),
          now: T0 + 43,
        }),
      ).toThrowError(RepositoryNotFoundError);
      // Ack changed NOTHING else.
      expect(countRows(handle, "autonomy_purposes")).toBe(purposesBefore);
      expect(countRows(handle, "autonomy_tasks")).toBe(tasksBefore);
      expect(repo.getAutonomyControlState()).toEqual(controlBefore);
      // Truthful counts: one recorded, zero unread.
      const listed = repo.listNotifications(sessionId, {});
      expect(listed.latestSeq).toBe(1);
      expect(listed.unreadCount).toBe(0);
      const history = repo.getNotificationHistory(sessionId, item.id);
      expect(history.ack?.key).toBe(key.toLowerCase());
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("rejects ack-key reuse across notifications (drift 409)", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      repo.ingestNotifications(sessionId, { now: T0 + 5 });
      seedPurpose(repo, sessionId, "alpha", T0 + 6);
      seedPurpose(repo, sessionId, "beta", T0 + 7);
      unpause(repo, 1, T0 + 10);
      for (const scope of ["alpha", "beta"]) {
        completeExplicitJob(
          repo,
          sessionId,
          scope,
          (labels) =>
            validOutput(labels.purposes, {
              decision: "execute",
              proposedAction: { kind: "message", summary: `ping ${scope}` },
            }),
          T0 + 20,
        );
      }
      repo.ingestNotifications(sessionId, { now: T0 + 30 });
      const items = repo.listNotifications(sessionId, {}).items;
      expect(items).toHaveLength(2);
      const key = randomUUID();
      repo.ackNotification(sessionId, items[0]?.id as string, {
        key,
        now: T0 + 40,
      });
      expect(() =>
        repo.ackNotification(sessionId, items[1]?.id as string, {
          key,
          now: T0 + 41,
        }),
      ).toThrowError(NotificationKeyConflictError);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("records an URGENT commitment notice for a real unknown receipt while paused", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      // Control stays paused (new-install default): baseline, then drive a
      // human-approved M5 write to a REAL unknown terminal.
      repo.ingestNotifications(sessionId, { now: T0 + 5 });
      expect(repo.getAutonomyControlState().paused).toBe(true);
      await driveUnknownReceipt(repo, handle, sessionId);
      const out = repo.ingestNotifications(sessionId, { now: T0 + 50 });
      expect(out.ingested).toBe(1);
      const items = repo.listNotifications(sessionId, {}).items;
      expect(items).toHaveLength(1);
      const item = items[0] as NonNullable<(typeof items)[0]>;
      expect(item.kind).toBe("commitment");
      expect(item.priority).toBe("urgent");
      expect(item.sourceKind).toBe("action_receipt");
      expect(item.briefText).toContain("unknown");
      expect(item.briefText).not.toMatch(/https?:\/\//);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("asks with a cited explicit task deadline stay separate from general questions", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      repo.ingestNotifications(sessionId, { now: T0 + 5 });
      seedPurpose(repo, sessionId, "health", T0 + 6);
      unpause(repo, 1, T0 + 10);
      const taskCreated = repo.createAutonomyTask(
        sessionId,
        {
          scope: "health",
          title: "call the clinic",
          kind: "task",
          speaker: "user",
          deadline: FUTURE_DEADLINE,
        },
        { key: randomUUID(), now: T0 + 20 },
      );
      expect(taskCreated.body.id).toBeDefined();
      // Cited-deadline question: evidence cites the task, draft reuses its EXACT deadline.
      const cited = completeExplicitJob(
        repo,
        sessionId,
        "health",
        (labels) =>
          validOutput([labels.tasks[0] as string], {
            decision: "ask",
            reason: "which slot works",
            proposedAction: {
              kind: "message",
              summary: "ask for a slot",
              taskDraft: { title: "pick a slot", deadline: FUTURE_DEADLINE },
            },
          }),
        T0 + 30,
      );
      expect(cited.done.outcome).toBe("completed");
      // A general question in the same scope stays its own group.
      completeExplicitJob(
        repo,
        sessionId,
        "health",
        (labels) =>
          validOutput(labels.purposes, {
            decision: "ask",
            reason: "general wonder",
            proposedAction: null,
          }),
        T0 + 40,
      );
      const out = repo.ingestNotifications(sessionId, { now: T0 + 50 });
      expect(out.ingested).toBe(2);
      const items = repo.listNotifications(sessionId, {}).items;
      const withDeadline = items.find((n) => n.citedDeadlines.length > 0);
      const general = items.find((n) => n.citedDeadlines.length === 0);
      expect(withDeadline?.kind).toBe("question");
      expect(withDeadline?.citedDeadlines).toEqual([FUTURE_DEADLINE]);
      expect(general?.kind).toBe("question");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("rebuilds the deadline schedule over the whole task source and reads the earliest due", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      unpause(repo, 1, T0 + 10);
      // 210 eligible tasks: well past any 100-record silent truncation.
      for (let i = 0; i < 210; i += 1) {
        repo.createAutonomyTask(
          sessionId,
          {
            scope: `bulk${i}`,
            title: `bulk task ${i}`,
            kind: "task",
            speaker: "user",
            deadline: i === 0 ? FUTURE_DEADLINE : LATER_DEADLINE,
          },
          { key: randomUUID(), now: T0 + 20 + i },
        );
      }
      // Valid but schedule-ineligible rows: wrong kind, wrong speaker, no deadline.
      repo.createAutonomyTask(
        sessionId,
        {
          scope: "misc",
          title: "wishful note",
          kind: "wish",
          speaker: "user",
          deadline: FUTURE_DEADLINE,
        },
        { key: randomUUID(), now: T0 + 500 },
      );
      repo.createAutonomyTask(
        sessionId,
        {
          scope: "misc",
          title: "external ping",
          kind: "task",
          speaker: "external",
          deadline: FUTURE_DEADLINE,
        },
        { key: randomUUID(), now: T0 + 501 },
      );
      repo.createAutonomyTask(
        sessionId,
        {
          scope: "misc",
          title: "dateless chore",
          kind: "task",
          speaker: "user",
        },
        { key: randomUUID(), now: T0 + 502 },
      );
      const built = repo.buildDeadlineSchedule(sessionId, { now: T0 + 600 });
      expect(built.observed).toBe(213);
      expect(built.upserted).toBe(210);
      expect(built.removed).toBe(0);
      const next = repo.getNextDeadline(sessionId, { now: T0 + 601 });
      expect(next.status).toBe("ready");
      expect(next.paused).toBe(false);
      expect(next.deadline?.dueAt).toBe(Date.parse(FUTURE_DEADLINE));
      // Reconcile is idempotent: same state, zero churn.
      const again = repo.reconcileDeadlineSchedule(sessionId, {
        now: T0 + 602,
      });
      expect(again.upserted).toBe(0);
      expect(again.removed).toBe(0);
      expect(again.observed).toBe(213);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("skips old past deadlines after resume, logs a new past deadline once, and never re-alerts through hold/resume", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      // Old task with an old past deadline, created while paused.
      const old = repo.createAutonomyTask(
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
      const resumed = unpause(repo, 1, T0 + 10);
      const control = repo.getAutonomyControlState();
      expect(control.version).toBe(resumed.body.version);
      repo.buildDeadlineSchedule(sessionId, { now: T0 + 20 });
      // Offline-time rule: due long before the resume cutoff stays silent.
      const skipped = repo.recordDueDeadlines(sessionId, {
        expectedControlVersion: control.version,
        now: T0 + 30,
      });
      expect(skipped.status).toBe("recorded");
      expect(skipped.recorded).toBe(0);
      // A newly created explicit PAST deadline is NEW state: logs once.
      const fresh = repo.createAutonomyTask(
        sessionId,
        {
          scope: "health",
          title: "new past item",
          kind: "task",
          speaker: "user",
          deadline: PAST_DEADLINE,
        },
        { key: randomUUID(), now: T0 + 40 },
      );
      repo.reconcileDeadlineSchedule(sessionId, { now: T0 + 41 });
      const once = repo.recordDueDeadlines(sessionId, {
        expectedControlVersion: control.version,
        now: T0 + 50,
      });
      expect(once.recorded).toBe(1);
      const items = repo.listNotifications(sessionId, {}).items;
      expect(items).toHaveLength(1);
      expect(items[0]?.kind).toBe("deadline");
      expect(items[0]?.priority).toBe("routine");
      expect(items[0]?.citedDeadlines).toEqual([PAST_DEADLINE]);
      // Hold/resume status cycling never re-alerts the same deadline.
      const held = repo.holdAutonomyTask(
        sessionId,
        fresh.body.id,
        {
          expectedVersion: 1,
          reason: "waiting on clinic",
          reconsiderTrigger: "user_confirmed",
        },
        { key: randomUUID(), now: T0 + 60 },
      );
      expect(held.body.status).toBe("held");
      repo.resumeAutonomyTask(
        sessionId,
        fresh.body.id,
        {
          expectedVersion: 2,
          evidenceKind: "user_confirmed",
          evidence: "clinic called back",
        },
        { key: randomUUID(), now: T0 + 70 },
      );
      repo.reconcileDeadlineSchedule(sessionId, { now: T0 + 71 });
      const repeat = repo.recordDueDeadlines(sessionId, {
        expectedControlVersion: control.version,
        now: T0 + 80,
      });
      expect(repeat.recorded).toBe(0);
      expect(repo.listNotifications(sessionId, {}).items).toHaveLength(1);
      // Terminal removes ONLY the derived schedule row; history stays.
      repo.completeAutonomyTask(
        sessionId,
        fresh.body.id,
        { expectedVersion: 3 },
        { key: randomUUID(), now: T0 + 90 },
      );
      const reconciled = repo.reconcileDeadlineSchedule(sessionId, {
        now: T0 + 91,
      });
      expect(reconciled.removed).toBe(1);
      expect(
        repo.getNextDeadline(sessionId, { now: T0 + 92 }).deadline?.taskId,
      ).toBe(old.body.id);
      const terminal = repo.recordDueDeadlines(sessionId, {
        expectedControlVersion: control.version,
        now: T0 + 100,
      });
      expect(terminal.recorded).toBe(0);
      const history = repo.getNotificationHistory(
        sessionId,
        items[0]?.id as string,
      );
      expect(history.notification.outdated).toBe(true);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("reports paused / stale callers honestly with zero recordings", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const task = repo.createAutonomyTask(
        sessionId,
        {
          scope: "health",
          title: "due item",
          kind: "task",
          speaker: "user",
          deadline: FUTURE_DEADLINE,
        },
        { key: randomUUID(), now: T0 + 5 },
      );
      expect(task.body.id).toBeDefined();
      repo.buildDeadlineSchedule(sessionId, { now: T0 + 6 });
      // Paused control: earliest-deadline read still honest, recording off.
      const whilePaused = repo.getNextDeadline(sessionId, { now: T0 + 7 });
      expect(whilePaused.status).toBe("control_paused");
      expect(whilePaused.paused).toBe(true);
      expect(whilePaused.deadline?.dueAt).toBe(Date.parse(FUTURE_DEADLINE));
      const pausedRecord = repo.recordDueDeadlines(sessionId, {
        expectedControlVersion: 1,
        now: Date.parse(FUTURE_DEADLINE) + 1,
      });
      expect(pausedRecord.status).toBe("control_paused");
      expect(pausedRecord.recorded).toBe(0);
      // Resume, then call with a stale version: zero recordings.
      const resumed = unpause(repo, 1, T0 + 10);
      const stale = repo.recordDueDeadlines(sessionId, {
        expectedControlVersion: resumed.body.version - 1,
        now: Date.parse(FUTURE_DEADLINE) + 1,
      });
      expect(stale.status).toBe("stale_epoch");
      expect(stale.recorded).toBe(0);
      expect(stale.controlVersion).toBe(resumed.body.version);
      // Current version records the actually-due deadline once.
      const live = repo.recordDueDeadlines(sessionId, {
        expectedControlVersion: resumed.body.version,
        now: Date.parse(FUTURE_DEADLINE) + 1,
      });
      expect(live.status).toBe("recorded");
      expect(live.recorded).toBe(1);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("keeps notifications session-owned end to end (seq, cursors, feeds)", async () => {
    const { handle, repo, sessionId, otherId } = await makeRepo();
    try {
      repo.ingestNotifications(sessionId, { now: T0 + 5 });
      repo.ingestNotifications(otherId, { now: T0 + 5 });
      seedPurpose(repo, sessionId, "health", T0 + 6);
      unpause(repo, 1, T0 + 10);
      completeExplicitJob(
        repo,
        sessionId,
        "health",
        (labels) =>
          validOutput(labels.purposes, {
            decision: "execute",
            proposedAction: { kind: "message", summary: "ping" },
          }),
        T0 + 20,
      );
      repo.ingestNotifications(sessionId, { now: T0 + 30 });
      repo.ingestNotifications(otherId, { now: T0 + 31 });
      expect(repo.listNotifications(sessionId, {}).items).toHaveLength(1);
      expect(repo.listNotifications(otherId, {}).items).toHaveLength(0);
      expect(repo.listNotifications(sessionId, {}).latestSeq).toBe(1);
      expect(repo.listNotifications(otherId, {}).latestSeq).toBe(0);
      const feed = repo.getLatestNotificationCursor(sessionId);
      expect(feed.latestSeq).toBe(1);
      expect(feed.cursors.length).toBe(3);
      const otherFeed = repo.getLatestNotificationCursor(otherId);
      expect(otherFeed.latestSeq).toBe(0);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
