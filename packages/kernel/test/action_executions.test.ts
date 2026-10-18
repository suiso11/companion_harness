// C19 boundary tests for the concrete Action execution service
// (`createActionExecutionService`): atomic pickup (run.started +
// action.preflight_started together, impossible-pair fail closed), the exact
// §18.5 preflight order (compare BEFORE materialize), zero-write
// blocked_stale terminal, atomic preflight-failed terminal
// (action.preflight_failed -> run.failed), same-DB ReferenceManager fresh
// snapshot/rN materialization, the one-shot grant CAS gate (exact provenance,
// executing + external_call_started_at + action.execution_started committed
// BEFORE any caller write), default-deny contentions, and the single
// controlled observation port.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ActionPreflightReadPort } from "../src/action_executions.js";
import { createActionExecutionService } from "../src/action_executions.js";
import {
  canonicalJsonString,
  generateId,
  sha256Hex,
} from "../src/canonical.js";
import {
  ActionNotCancellableError,
  DatabaseStateInvalidError,
} from "../src/errors.js";
import {
  BUNDLED_SCHEMA_VERSION,
  closeKernelDatabase,
  createReferenceManager,
  migrateKernelDatabase,
  openKernelDatabase,
} from "../src/index.js";

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
);

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop() as string;
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Fixture {
  handle: ReturnType<typeof openKernelDatabase>;
  db: Database.Database;
  sessionId: string;
  agentTurnId: string;
  agentRunId: string;
  decisionTurnId: string;
  connectorId: string;
  resourceId: string;
  basedSnapshotId: string;
  refId: string;
  proposalId: string;
  actionRunId: string;
  executionId: string;
  service: ReturnType<typeof createActionExecutionService>;
}

function makeService(
  db: Database.Database,
  clock: () => number,
  port?: ActionPreflightReadPort,
) {
  return createActionExecutionService({
    db,
    referenceManager: createReferenceManager(db),
    clock,
    ...(port === undefined ? {} : { preflightRead: port }),
  });
}

async function setupApprovedProposalFixture(
  clock: () => number,
): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "c19-exec-"));
  tempRoots.push(dir);
  const handle = openKernelDatabase(join(dir, "kernel.sqlite"));
  const db = handle.raw;
  const result = await migrateKernelDatabase({
    db,
    targetVersion: BUNDLED_SCHEMA_VERSION,
    migrationsDir: MIGRATIONS_DIR,
  });
  if (result.toVersion !== BUNDLED_SCHEMA_VERSION) {
    throw new Error("migration failed");
  }

  const sessionId = generateId();
  const agentTurnId = generateId();
  const agentRunId = generateId();
  const decisionTurnId = generateId();
  const connectorId = generateId();
  const resourceId = generateId();
  const basedSnapshotId = generateId();
  const refId = generateId();
  const proposalId = generateId();
  const actionRunId = generateId();
  const executionId = generateId();

  db.prepare(
    "INSERT INTO sessions (id, created_at, last_active_at, next_turn_position, next_reference_ordinal) VALUES (?, 1, 1, 1, 2)",
  ).run(sessionId);
  db.prepare(
    'INSERT INTO turns (id, session_id, seq, input_json, frozen_context, created_at, next_run_attempt) VALUES (?, ?, 1, \'{"version":1,"kind":"user_text","text":"hi"}\', \'{}\', 1, 1)',
  ).run(agentTurnId, sessionId);
  db.prepare(
    `INSERT INTO turns (id, session_id, seq, input_json, frozen_context, created_at, next_run_attempt) VALUES (?, ?, 2, ?, '{}', 1, 1)`,
  ).run(
    decisionTurnId,
    sessionId,
    JSON.stringify({
      version: 1,
      kind: "action_approval",
      proposalId,
      proposalHash: PROPOSAL_SHA,
    }),
  );

  // Agent Run (source_run ownership FK) already carries seq 1-2 here.
  db.prepare(
    "INSERT INTO runs (id, turn_id, session_id, attempt, status, strategy, result_json, event_seq, select_on_success, tool_requests_used, created_at, started_at, finished_at) VALUES (?, ?, ?, 1, 'completed', 'agent', '{\"version\":1,\"text\":\"ok\"}', 2, 1, 0, 1, 1, 1)",
  ).run(agentRunId, agentTurnId, sessionId);

  db.prepare(
    "INSERT INTO connector_instances (id, kind, display_name, config_json, created_at) VALUES (?, 'calendar', 'c', '{}', 1)",
  ).run(connectorId);
  db.prepare(
    "INSERT INTO resources (id, connector_instance_id, canonical_key, title, next_revision, created_at) VALUES (?, ?, 'cal|cal1|evt1', 'Event', 2, 1)",
  ).run(resourceId, connectorId);
  db.prepare(
    'INSERT INTO resource_snapshots (id, resource_id, revision, source_revision, content_hash, body_json, size_bytes, observed_at, created_at) VALUES (?, ?, 1, \'src@1\', \'hash@1\', \'{"version":1,"status":"confirmed","title":"Event"}\', 10, 1, 1)',
  ).run(basedSnapshotId, resourceId);
  db.prepare(
    "INSERT INTO session_references (id, session_id, ordinal, resource_id, snapshot_id, created_at) VALUES (?, ?, 1, ?, ?, 1)",
  ).run(refId, sessionId, resourceId, basedSnapshotId);

  // Approved proposal + persisted approve cascade (committed by the repository
  // approve transaction in production; C19 starts from a committed approve).
  const input = TIMED_INPUT;
  db.prepare(
    `INSERT INTO action_proposals (id, session_id, source_turn_id, source_run_id, decision_turn_id,
       tool, connector_instance_id, input_json, target_ref_id, target_resource_id,
       based_on_snapshot_id, expected_revision, preview_json, hash, status, created_at, expires_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, 'calendar.reschedule', ?, ?, ?, ?, ?, 'src@1', ?, ?, 'approved', 1, 2, 1)`,
  ).run(
    proposalId,
    sessionId,
    agentTurnId,
    agentRunId,
    decisionTurnId,
    connectorId,
    JSON.stringify(input),
    refId,
    resourceId,
    basedSnapshotId,
    JSON.stringify(PREVIEW),
    PROPOSAL_SHA,
  );

  // Queued Action Run with the committed approve event trail
  // (seq 1 = run.queued, seq 2 = action.approved).
  db.prepare(
    "INSERT INTO runs (id, turn_id, session_id, attempt, status, strategy, event_seq, select_on_success, tool_requests_used, created_at, started_at) VALUES (?, ?, ?, 1, 'queued', 'm5-action', 2, 1, 0, 1, NULL)",
  ).run(actionRunId, decisionTurnId, sessionId);
  db.prepare(
    "INSERT INTO run_events (run_id, seq, schema_version, type, payload, created_at) VALUES (?, 1, 1, 'run.queued', '{\"attempt\":1}', 1)",
  ).run(actionRunId);
  db.prepare(
    "INSERT INTO run_events (run_id, seq, schema_version, type, payload, created_at) VALUES (?, 2, 1, 'action.approved', ?, 1)",
  ).run(
    actionRunId,
    JSON.stringify({
      proposalId,
      proposalHash: PROPOSAL_SHA,
      executionId,
    }),
  );

  db.prepare(
    `INSERT INTO action_executions (id, session_id, proposal_id, approval_turn_id, action_run_id, status,
       external_call_started_at, finished_at, error_code, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'queued', NULL, NULL, NULL, 1, 1)`,
  ).run(executionId, sessionId, proposalId, decisionTurnId, actionRunId);
  db.prepare(
    `INSERT INTO action_execution_grants (execution_id, session_id, proposal_id, proposal_hash, tool,
       input_hash, consumed_at, created_at)
     VALUES (?, ?, ?, ?, 'calendar.reschedule', ?, NULL, 1)`,
  ).run(
    executionId,
    sessionId,
    proposalId,
    PROPOSAL_SHA,
    sha256Hex(canonicalJsonString(input)),
  );

  const service = makeService(db, clock);
  return {
    handle,
    db,
    sessionId,
    agentTurnId,
    agentRunId,
    decisionTurnId,
    connectorId,
    resourceId,
    basedSnapshotId,
    refId,
    proposalId,
    actionRunId,
    executionId,
    service,
  };
}

function eventTypes(db: Database.Database, runId: string): string[] {
  return (
    db
      .prepare("SELECT type FROM run_events WHERE run_id = ? ORDER BY seq ASC")
      .all(runId) as Array<{ type: string }>
  ).map((row) => row.type);
}

const TIMED_INPUT = {
  start: "2026-02-01T10:00:00Z",
  end: "2026-02-01T11:00:00Z",
} as const;
const PREVIEW = {
  summary:
    "calendar.reschedule: start=2026-02-01T10:00:00Z end=2026-02-01T11:00:00Z",
} as const;
const PROPOSAL_SHA = sha256Hex(
  canonicalJsonString({
    tool: "calendar.reschedule",
    input: TIMED_INPUT,
    target: { refId: "REF", resourceId: "RES", snapshotId: "SNAP" },
    expectedRevision: "src@1",
    preview: PREVIEW,
  }),
);
void PROPOSAL_SHA;

const OK_OBSERVATION = {
  eventStatus: "confirmed" as const,
  title: "Event",
  text: "Event body",
};

describe("C19 Action execution boundaries", () => {
  describe("startActionRun (atomic pickup)", () => {
    it("moves run + execution together and appends run.started then action.preflight_started atomically", async () => {
      const fx = await setupApprovedProposalFixture(() => 100);
      try {
        fx.service.startActionRun(fx.actionRunId, { now: 100 });
        const view = fx.service.getActionRunView(fx.actionRunId);
        expect(view.run.status).toBe("running");
        expect(view.run.eventSeq).toBe(4);
        expect(view.execution?.status).toBe("preflight");
        expect(eventTypes(fx.db, fx.actionRunId).slice(2)).toEqual([
          "run.started",
          "action.preflight_started",
        ]);
      } finally {
        await closeKernelDatabase(fx.handle);
      }
      // Full-migration fixture + parallel workers on Windows CI can exceed
      // vitest's 5s default (observed 6.4s); the assertion itself is
      // synchronous, so a bounded explicit timeout keeps it deterministic.
    }, 20000);

    it("is one-shot (applied:false once picked up) and fails closed on an impossible queued pair", async () => {
      const fx = await setupApprovedProposalFixture(() => 100);
      try {
        expect(
          fx.service.startActionRun(fx.actionRunId, { now: 100 }).applied,
        ).toBe(true);
        expect(fx.service.startActionRun(fx.actionRunId, { now: 101 })).toEqual(
          {
            applied: false,
            reason: "run_not_queued",
            status: "running",
          },
        );
        // impossible pair: queued run with no queued execution
        const orphanSession = generateId();
        const orphanTurn = generateId();
        fx.db
          .prepare(
            "INSERT INTO sessions (id, created_at, last_active_at, next_turn_position) VALUES (?, 1, 1, 1)",
          )
          .run(orphanSession);
        fx.db
          .prepare(
            "INSERT INTO turns (id, session_id, seq, input_json, frozen_context, created_at, next_run_attempt) VALUES (?, ?, 1, '{}', '{}', 1, 1)",
          )
          .run(orphanTurn, orphanSession);
        const orphan = generateId();
        fx.db
          .prepare(
            "INSERT INTO runs (id, turn_id, session_id, attempt, status, strategy, event_seq, select_on_success, tool_requests_used, created_at, started_at) VALUES (?, ?, ?, 1, 'queued', 'm5-action', 0, 1, 0, 1, NULL)",
          )
          .run(orphan, orphanTurn, orphanSession);
        expect(() => fx.service.startActionRun(orphan, { now: 102 })).toThrow(
          DatabaseStateInvalidError,
        );
      } finally {
        await closeKernelDatabase(fx.handle);
      }
    });
  });

  describe("runActionPreflight (compare BEFORE materialize)", () => {
    function snapshotsCount(db: Database.Database): number {
      return (
        db.prepare("SELECT COUNT(*) AS c FROM resource_snapshots").get() as {
          c: number;
        }
      ).c;
    }
    function referencesCount(db: Database.Database): number {
      return (
        db.prepare("SELECT COUNT(*) AS c FROM session_references").get() as {
          c: number;
        }
      ).c;
    }

    it("blocks stale observations with a zero-write blocked_stale terminal and Action Run completed", async () => {
      const clockNow = 100; // anchor deterministic clock per test
      const fx = await setupApprovedProposalFixture(() => clockNow);
      try {
        fx.service.startActionRun(fx.actionRunId, { now: 100 });
        const before = snapshotsCount(fx.db);
        const port: ActionPreflightReadPort = {
          read: async () => ({
            status: "ok",
            observation: {
              connectorInstanceId: fx.connectorId,
              resourceCanonicalKey: "cal|cal1|evt1",
              sourceRevision: "src@2",
              ...OK_OBSERVATION,
              observedAt: 100,
            },
          }),
        };
        const second = makeService(fx.db, () => clockNow, port);
        const outcome = await second.runActionPreflight(fx.actionRunId, {
          now: 101,
        });
        expect(outcome).toMatchObject({
          outcome: "blocked_stale",
          reason: "stale",
          preflightRevision: "src@2",
          preflightSnapshotId: fx.basedSnapshotId,
        });
        // ZERO writes: no fresh snapshot / rN materialized on a block.
        expect(snapshotsCount(fx.db)).toBe(before);
        const view = second.getActionRunView(fx.actionRunId);
        expect(view.run.status).toBe("completed");
        expect(view.execution?.status).toBe("blocked_stale");
        expect(view.execution?.externalCallStartedAt).toBeNull();
        expect(view.grant?.consumedAt).toBeNull();
        expect(view.receipt).toEqual({
          outcome: "blocked_stale",
          preflightRevision: "src@2",
          preflightSnapshotId: fx.basedSnapshotId,
          // The stale observation is NOT persisted: no post-write snapshot.
          observedRevision: null,
          resultSnapshotId: null,
        });
        expect(eventTypes(fx.db, fx.actionRunId).slice(4)).toEqual([
          "action.preflight_blocked",
          "action.execution_finished",
          "run.completed",
        ]);
      } finally {
        await closeKernelDatabase(fx.handle);
      }
    });

    it("renders a tool-prefixed event title in full: new preview survives the legacy strip", async () => {
      const clockNow = 100;
      const fx = await setupApprovedProposalFixture(() => clockNow);
      try {
        // Stored NEW-format preview whose event title itself begins with the
        // legacy tool prefix: the rendered RunResult text and the durable
        // receipt must keep the whole title (the unambiguous marker keeps
        // the legacy strip from triggering).
        const adversarialTitle = "calendar.reschedule: quarterly planning";
        const summary =
          `対象イベント: ${adversarialTitle} (r1): 変更前 [時刻指定] ` +
          `2026-01-01T10:00:00Z ～ 2026-01-01T11:00:00Z → 変更後 [時刻指定] ` +
          `${TIMED_INPUT.start} ～ ${TIMED_INPUT.end}`;
        fx.db
          .prepare("UPDATE action_proposals SET preview_json = ? WHERE id = ?")
          .run(JSON.stringify({ summary }), fx.proposalId);
        fx.service.startActionRun(fx.actionRunId, { now: 100 });
        const blocked = fx.service.recordActionPreflightBlocked(
          fx.actionRunId,
          {
            reason: "stale",
            preflightRevision: "src@2",
            now: 101,
          },
        );
        expect(blocked.applied).toBe(true);
        const stored = fx.db
          .prepare("SELECT result_json FROM runs WHERE id = ?")
          .get(fx.actionRunId) as { result_json: string };
        const result = JSON.parse(stored.result_json) as { text: string };
        expect(result.text).toContain(adversarialTitle);
        expect(result.text.startsWith("calendar.reschedule:")).toBe(false);
        const receipt = fx.db
          .prepare(
            "SELECT summary_json FROM action_receipts WHERE execution_id = ?",
          )
          .get(fx.executionId) as { summary_json: string };
        expect(
          (JSON.parse(receipt.summary_json) as { summary: string }).summary,
        ).toBe(summary);
      } finally {
        await closeKernelDatabase(fx.handle);
      }
    });

    it("blocks a deleted authoritative event the same way", async () => {
      const fx = await setupApprovedProposalFixture(() => 100);
      try {
        fx.service.startActionRun(fx.actionRunId, { now: 100 });
        const port: ActionPreflightReadPort = {
          read: async () => ({
            status: "ok",
            observation: {
              connectorInstanceId: fx.connectorId,
              resourceCanonicalKey: "cal|cal1|evt1",
              title: null,
              text: "",
              sourceRevision: "src@1",
              eventStatus: "deleted",
              observedAt: 100,
            },
          }),
        };
        const svc = makeService(fx.db, () => 100, port);
        expect(
          await svc.runActionPreflight(fx.actionRunId, { now: 101 }),
        ).toMatchObject({
          outcome: "blocked_stale",
          reason: "deleted",
        });
        expect(
          fx.db.prepare("SELECT status FROM action_executions").get() as {
            status: string;
          },
        ).toEqual({ status: "blocked_stale" });
      } finally {
        await closeKernelDatabase(fx.handle);
      }
    });

    it("commits the atomic preflight-failed terminal on a read failure (zero writes, action.preflight_failed before run.failed)", async () => {
      const fx = await setupApprovedProposalFixture(() => 100);
      try {
        fx.service.startActionRun(fx.actionRunId, { now: 100 });
        const before = snapshotsCount(fx.db);
        const port: ActionPreflightReadPort = {
          read: async () => ({ status: "unavailable" as const }),
        };
        const svc = makeService(fx.db, () => 100, port);
        expect(
          await svc.runActionPreflight(fx.actionRunId, { now: 101 }),
        ).toMatchObject({
          outcome: "preflight_failed",
          portRead: "unavailable",
        });
        expect(snapshotsCount(fx.db)).toBe(before);
        const view = svc.getActionRunView(fx.actionRunId);
        expect(view.run.status).toBe("failed");
        expect(view.execution?.status).toBe("failed");
        expect(view.execution?.externalCallStartedAt).toBeNull();
        expect(view.grant?.consumedAt).toBeNull();
        expect(view.receipt).toEqual({
          outcome: "failed",
          preflightRevision: null,
          preflightSnapshotId: null,
          observedRevision: null,
          resultSnapshotId: null,
        });
        expect(eventTypes(fx.db, fx.actionRunId).slice(4)).toEqual([
          "action.preflight_failed",
          "run.failed",
        ]);
      } finally {
        await closeKernelDatabase(fx.handle);
      }
    });

    it("materializes a fresh snapshot + rN through the SAME-DB ReferenceManager after a matching compare, then returns the committed grant gate", async () => {
      const fx = await setupApprovedProposalFixture(() => 100);
      try {
        fx.service.startActionRun(fx.actionRunId, { now: 100 });
        const port: ActionPreflightReadPort = {
          read: async () => ({
            status: "ok",
            observation: {
              connectorInstanceId: fx.connectorId,
              resourceCanonicalKey: "cal|cal1|evt1",
              title: "Event",
              text: "Event body",
              sourceRevision: "src@1",
              eventStatus: "confirmed",
              observedAt: 100,
            },
          }),
        };
        const svc = makeService(fx.db, () => 100, port);
        const outcome = await svc.runActionPreflight(fx.actionRunId, {
          now: 101,
        });
        expect(outcome).toMatchObject({ outcome: "granted" });
        const granted = outcome as {
          preflightReferenceId: string;
          preflightSnapshotId: string;
        };
        expect(granted.preflightSnapshotId).not.toBe(fx.basedSnapshotId);
        // Exactly one fresh snapshot + one new rN (§14.2 refresh semantics).
        expect(snapshotsCount(fx.db)).toBe(2);
        expect(referencesCount(fx.db)).toBe(2);
        const view = svc.getActionRunView(fx.actionRunId);
        expect(view.run.status).toBe("running");
        expect(view.execution?.status).toBe("executing");
        expect(view.execution?.externalCallStartedAt).not.toBeNull();
        expect(view.grant?.consumedAt).not.toBeNull();
        expect(eventTypes(fx.db, fx.actionRunId).slice(4)).toEqual([
          "reference.presented",
          "action.execution_started",
        ]);
        // The gate is one-shot: a second demand is default-denied.
        const gate = svc.consumeActionGrant(fx.actionRunId, { now: 102 });
        expect(gate).toEqual({
          granted: false,
          reason: "execution_not_preflight",
        });
      } finally {
        await closeKernelDatabase(fx.handle);
      }
    });

    it("fails closed when the returned observation does not bind the proposal target", async () => {
      const fx = await setupApprovedProposalFixture(() => 100);
      try {
        fx.service.startActionRun(fx.actionRunId, { now: 100 });
        const port: ActionPreflightReadPort = {
          read: async () => ({
            status: "ok",
            observation: {
              connectorInstanceId: generateId(),
              resourceCanonicalKey: "cal|other",
              title: null,
              text: "x",
              sourceRevision: "src@1",
              eventStatus: "confirmed",
              observedAt: 100,
            },
          }),
        };
        const svc = makeService(fx.db, () => 100, port);
        await expect(
          svc.runActionPreflight(fx.actionRunId, { now: 101 }),
        ).rejects.toThrow(DatabaseStateInvalidError);
        expect(
          (
            fx.db
              .prepare("SELECT id FROM resource_snapshots WHERE revision = 2")
              .all() as unknown[]
          ).length,
        ).toBe(0);
      } finally {
        await closeKernelDatabase(fx.handle);
      }
    });
  });

  describe("consumeActionGrant (one-shot exact gate)", () => {
    let fx: Fixture;

    beforeEach(async () => {
      fx = await setupApprovedProposalFixture(() => 100);
      fx.service.startActionRun(fx.actionRunId, { now: 100 });
    });

    const getGrant = (): { consumed_at: number | null } =>
      fx.db
        .prepare(
          "SELECT consumed_at FROM action_execution_grants WHERE execution_id = ?",
        )
        .all(fx.executionId)
        .at(0) as { consumed_at: number | null };

    afterEach(async () => {
      await closeKernelDatabase(fx.handle);
    });

    it("denies with zero writes when the run is not running (pre-marker cancel contention)", async () => {
      fx.db
        .prepare(
          "UPDATE runs SET status = 'cancelled', cancel_requested_at = 100, finished_at = 100 WHERE id = ?",
        )
        .run(fx.actionRunId);
      const gate = fx.service.consumeActionGrant(fx.actionRunId, { now: 101 });
      expect(gate).toEqual({ granted: false, reason: "run_not_running" });
      expect(getGrant().consumed_at).toBeNull();
      const view = fx.service.getActionRunView(fx.actionRunId);
      expect(view.execution?.status).toBe("preflight");
    });

    it("trusts only the exact grant provenance; a tampered input hash fails closed with nothing consumed", async () => {
      fx.db
        .prepare("UPDATE action_execution_grants SET input_hash = ?")
        .run(sha256Hex("tampered"));
      expect(() =>
        fx.service.consumeActionGrant(fx.actionRunId, { now: 101 }),
      ).toThrow(DatabaseStateInvalidError);
      expect(getGrant().consumed_at).toBeNull();
    });

    it("denies a missing grant (default deny) without consuming anything", async () => {
      fx.db
        .prepare("DELETE FROM action_execution_grants WHERE execution_id = ?")
        .run(fx.executionId);
      expect(
        fx.service.consumeActionGrant(fx.actionRunId, { now: 101 }),
      ).toEqual({ granted: false, reason: "grant_missing" });
    });
  });

  describe("execute -> finish lifecycle (marker, one-shot, readback, cancel)", () => {
    /** Drives pickup + the committed preflight gate, exactly as the real
     *  `m5-action` strategy does, and returns the committed gate. */
    async function driveToExecuting(
      fx: Fixture,
      port: ActionPreflightReadPort,
    ): Promise<{ preflightSnapshotId: string }> {
      fx.service.startActionRun(fx.actionRunId, { now: 100 });
      const outcome = await makeService(
        fx.db,
        () => 100,
        port,
      ).runActionPreflight(fx.actionRunId, { now: 101 });
      expect(outcome).toMatchObject({ outcome: "granted" });
      return outcome as { preflightSnapshotId: string };
    }

    const readPort = (fx: Fixture): ActionPreflightReadPort => ({
      read: async () => ({
        status: "ok",
        observation: {
          connectorInstanceId: fx.connectorId,
          resourceCanonicalKey: "cal|cal1|evt1",
          ...OK_OBSERVATION,
          sourceRevision: "src@1",
          observedAt: 100,
        },
      }),
    });

    it("commits the external-call marker and the consumed grant BEFORE the write callback observes the DB", async () => {
      const fx = await setupApprovedProposalFixture(() => 100);
      try {
        const gate = await driveToExecuting(fx, readPort(fx));
        // The "write port" inspects the SAME durable DB at the exact moment
        // it would call the provider: marker + consumed grant must already be
        // committed (no await ever spans an open transaction here).
        const seenAtWrite = fx.db
          .prepare(
            "SELECT e.status, e.external_call_started_at, g.consumed_at FROM action_executions e JOIN action_execution_grants g ON g.execution_id = e.id WHERE e.id = ?",
          )
          .get(fx.executionId) as {
          status: string;
          external_call_started_at: number | null;
          consumed_at: number | null;
        };
        expect(seenAtWrite).toEqual({
          status: "executing",
          external_call_started_at: 101,
          consumed_at: 101,
        });
        expect(gate.preflightSnapshotId).not.toBe(fx.basedSnapshotId);
        expect(eventTypes(fx.db, fx.actionRunId).slice(4)).toEqual([
          "reference.presented",
          "action.execution_started",
        ]);
      } finally {
        await closeKernelDatabase(fx.handle);
      }
    });

    it("finishes a verified succeeded write with a fresh rN result snapshot and is strictly one-shot", async () => {
      const fx = await setupApprovedProposalFixture(() => 100);
      try {
        const gate = await driveToExecuting(fx, readPort(fx));
        const finish = fx.service.finishActionExecution(
          fx.actionRunId,
          {
            outcome: "succeeded",
            observation: {
              connectorInstanceId: fx.connectorId,
              resourceCanonicalKey: "cal|cal1|evt1",
              ...OK_OBSERVATION,
              sourceRevision: "src@2",
              observedAt: 105,
            },
            preflightRevision: "src@1",
            preflightSnapshotId: gate.preflightSnapshotId,
          },
          { now: 105 },
        );
        expect(finish).toMatchObject({
          applied: true,
          outcome: "succeeded",
          runStatus: "completed",
          observedRevision: "src@2",
        });
        const view = fx.service.getActionRunView(fx.actionRunId);
        expect(view.run.status).toBe("completed");
        expect(view.execution?.status).toBe("succeeded");
        expect(view.receipt).toMatchObject({
          outcome: "succeeded",
          observedRevision: "src@2",
        });
        // One-shot: a second terminal request is refused with zero new writes.
        expect(
          fx.service.finishActionExecution(
            fx.actionRunId,
            { outcome: "unknown" },
            { now: 106 },
          ),
        ).toEqual({
          applied: false,
          reason: "run_not_running",
        });
      } finally {
        await closeKernelDatabase(fx.handle);
      }
    });

    it("reports an unverified read-back as succeeded_unverified with no claimed result snapshot", async () => {
      const fx = await setupApprovedProposalFixture(() => 100);
      try {
        const gate = await driveToExecuting(fx, readPort(fx));
        const finish = fx.service.finishActionExecution(
          fx.actionRunId,
          {
            outcome: "succeeded_unverified",
            preflightRevision: "src@1",
            preflightSnapshotId: gate.preflightSnapshotId,
          },
          { now: 105 },
        );
        expect(finish).toMatchObject({
          applied: true,
          outcome: "succeeded_unverified",
          observedRevision: null,
          resultSnapshotId: null,
          referenceId: null,
        });
        const view = fx.service.getActionRunView(fx.actionRunId);
        expect(view.run.status).toBe("completed");
        expect(view.execution?.status).toBe("succeeded_unverified");
        // The grant stays consumed and NO retry ever follows.
        expect(
          fx.db
            .prepare(
              "SELECT consumed_at FROM action_execution_grants WHERE execution_id = ?",
            )
            .get(fx.executionId),
        ).toEqual({ consumed_at: 101 });
      } finally {
        await closeKernelDatabase(fx.handle);
      }
    });

    it("cancels a still-unmarkered run atomically and refuses a cancel once the external call started", async () => {
      const fx = await setupApprovedProposalFixture(() => 100);
      try {
        await driveToExecuting(fx, readPort(fx));
        // Post-marker cancel would be a lie about the external call: refused
        // with zero writes and the run stays executing.
        expect(() =>
          fx.service.cancelActionRun(fx.sessionId, fx.actionRunId, 104),
        ).toThrow(ActionNotCancellableError);
        expect(eventTypes(fx.db, fx.actionRunId).at(-1)).toBe(
          "action.execution_started",
        );
        expect(fx.service.getActionRunView(fx.actionRunId).run.status).toBe(
          "running",
        );
        // A late write terminal still commits normally for this run.
        expect(
          fx.service.finishActionExecution(
            fx.actionRunId,
            { outcome: "unknown" },
            { now: 105 },
          ),
        ).toMatchObject({
          applied: true,
          outcome: "unknown",
          runStatus: "failed",
        });
      } finally {
        await closeKernelDatabase(fx.handle);
      }
    });

    it("cancels a pre-marker run atomically (failed receipt, no write marker) and stays idempotent", async () => {
      const fx = await setupApprovedProposalFixture(() => 100);
      try {
        fx.service.startActionRun(fx.actionRunId, { now: 100 });
        const cancelled = fx.service.cancelActionRun(
          fx.sessionId,
          fx.actionRunId,
          103,
        );
        expect(cancelled).toMatchObject({
          applied: true,
          runStatus: "cancelled",
          executionStatus: "failed",
        });
        const view = fx.service.getActionRunView(fx.actionRunId);
        expect(view.execution?.externalCallStartedAt).toBeNull();
        expect(view.receipt).toMatchObject({ outcome: "failed" });
        // State-idempotent: a second cancel mutates nothing and appends no event.
        const before = eventTypes(fx.db, fx.actionRunId).length;
        expect(
          fx.service.cancelActionRun(fx.sessionId, fx.actionRunId, 104),
        ).toMatchObject({ applied: false, reason: "run_terminal" });
        expect(eventTypes(fx.db, fx.actionRunId).length).toBe(before);
        // A late write terminal can no longer commit.
        expect(
          fx.service.finishActionExecution(
            fx.actionRunId,
            { outcome: "unknown" },
            { now: 105 },
          ),
        ).toEqual({ applied: false, reason: "run_not_running" });
      } finally {
        await closeKernelDatabase(fx.handle);
      }
    });

    it("recovers an executing run after restart as abandoned+unknown, never as a retryable write", async () => {
      const fx = await setupApprovedProposalFixture(() => 100);
      try {
        await driveToExecuting(fx, readPort(fx));
        const summary = fx.service.validateAndRecoverActionRuns(
          "restart_recovery",
          120,
        );
        expect(summary).toMatchObject({
          recoveredPostMarker: 1,
          recoveredPreMarker: 0,
          unchanged: 0,
        });
        const view = fx.service.getActionRunView(fx.actionRunId);
        expect(view.run.status).toBe("abandoned");
        // Post-marker recovery is `unknown` (the write may have happened).
        expect(view.execution?.status).toBe("unknown");
        expect(view.receipt).toMatchObject({ outcome: "unknown" });
        // Idempotent: a second sweep changes nothing.
        expect(
          fx.service.validateAndRecoverActionRuns("restart_recovery", 121),
        ).toMatchObject({ recoveredPostMarker: 0, unchanged: 1 });
      } finally {
        await closeKernelDatabase(fx.handle);
      }
    });

    it("accepts an ALREADY-terminal post-marker definite_failure pair as unchanged (marker + consumed grant + failed receipt)", async () => {
      const fx = await setupApprovedProposalFixture(() => 100);
      try {
        // The connector returned `definite_failure` AFTER the committed
        // gate: execution failed WITH the marker + consumed grant.
        await driveToExecuting(fx, readPort(fx));
        expect(
          fx.service.finishActionExecution(
            fx.actionRunId,
            { outcome: "failed" },
            { now: 105 },
          ),
        ).toMatchObject({ applied: true, outcome: "failed" });
        // Startup/drain sweep is IDEMPOTENT on this real terminal pair: no
        // abandonment, no state change.
        const summary = fx.service.validateAndRecoverActionRuns(
          "restart_recovery",
          120,
        );
        expect(summary).toMatchObject({
          unchanged: 1,
          recoveredPreMarker: 0,
          recoveredPostMarker: 0,
        });
        const view = fx.service.getActionRunView(fx.actionRunId);
        expect(view.run.status).toBe("failed");
        expect(view.execution?.status).toBe("failed");
        expect(view.receipt).toMatchObject({ outcome: "failed" });
        expect(view.execution?.externalCallStartedAt).not.toBeNull();
        expect(
          fx.db
            .prepare(
              "SELECT consumed_at FROM action_execution_grants WHERE execution_id = ?",
            )
            .get(fx.executionId),
        ).toEqual({ consumed_at: 101 });
      } finally {
        await closeKernelDatabase(fx.handle);
      }
    });

    it("fails closed on a pre-marker failed execution with a consumed grant (impossible combo)", async () => {
      const fx = await setupApprovedProposalFixture(() => 100);
      try {
        fx.service.startActionRun(fx.actionRunId, { now: 100 });
        // Forge the impossible pair directly: failed, marker NULL, but the
        // grant row CONSUMED (the consume CAS always commits the marker in
        // the same transaction, so this can never be produced).
        fx.db
          .prepare(
            `UPDATE action_executions SET status = 'failed',
               error_code = 'action_preflight_failed', finished_at = 105,
               updated_at = 105 WHERE id = ?`,
          )
          .run(fx.executionId);
        fx.db
          .prepare(
            "UPDATE action_execution_grants SET consumed_at = 101 WHERE execution_id = ?",
          )
          .run(fx.executionId);
        fx.db
          .prepare(
            "UPDATE runs SET status = 'failed', error_code = 'execution_failed', finished_at = 105 WHERE id = ?",
          )
          .run(fx.actionRunId);
        expect(() =>
          fx.service.validateAndRecoverActionRuns("restart_recovery", 120),
        ).toThrow(DatabaseStateInvalidError);
        // Fail closed: the forged rows are untouched (zero mutations).
        const status = fx.db
          .prepare("SELECT status FROM runs WHERE id = ?")
          .get(fx.actionRunId) as { status: string };
        expect(status.status).toBe("failed");
      } finally {
        await closeKernelDatabase(fx.handle);
      }
    });

    it("fail-closes the WHOLE sweep when an m5-action run has NO execution row (real orphan is never silently skipped)", async () => {
      const fx = await setupApprovedProposalFixture(() => 100);
      try {
        // Pair 1: a genuinely recoverable executing orphan.
        await driveToExecuting(fx, readPort(fx));
        // Pair 2: an m5-action run whose execution row is missing — the
        // previous INNER JOIN never even saw it, so the sweep skipped the
        // orphan while sweeping (and mutating) pair 1.
        const orphanTurnId = generateId();
        const orphanRunId = generateId();
        const orphanSessionId = generateId();
        fx.db
          .prepare(
            "INSERT INTO sessions (id, created_at, last_active_at, next_turn_position) VALUES (?, 2, 2, 1)",
          )
          .run(orphanSessionId);
        fx.db
          .prepare(
            "INSERT INTO turns (id, session_id, seq, input_json, frozen_context, created_at, next_run_attempt) VALUES (?, ?, 1, '{}', '{}', 2, 1)",
          )
          .run(orphanTurnId, orphanSessionId);
        fx.db
          .prepare(
            "INSERT INTO runs (id, turn_id, session_id, attempt, status, strategy, event_seq, select_on_success, tool_requests_used, created_at, started_at) VALUES (?, ?, ?, 1, 'running', 'm5-action', 0, 1, 0, 2, 2)",
          )
          .run(orphanRunId, orphanTurnId, orphanSessionId);
        const before = fx.db
          .prepare("SELECT status FROM runs WHERE id = ?")
          .get(fx.actionRunId) as { status: string };
        expect(() =>
          fx.service.validateAndRecoverActionRuns("restart_recovery", 120),
        ).toThrow(/has no execution/);
        // Fail closed: ZERO mutations anywhere — the real orphan pair is
        // left exactly as found.
        const after = fx.db
          .prepare("SELECT status FROM runs WHERE id = ?")
          .get(fx.actionRunId) as { status: string };
        expect(after.status).toBe(before.status);
        expect(after.status).toBe("running");
      } finally {
        await closeKernelDatabase(fx.handle);
      }
    });
  });
});
