// C23 regression: an APPROVED `m5-action` Run queued by the decision path
// must execute AUTOMATICALLY through the REAL generic RunEngine scheduler.
//
// Before the fix, `repository.startRun` threw
// `ActionRunDispatchRequiredError` for every `m5-action` Run; the engine's
// `pump()` swallowed the throw, so the approved Run stayed `queued` forever
// and never reached its receipt. This test drives ONLY the real scheduler
// (`engine.start()` + `engine.pump()`): it never calls `startActionRun` and
// never invokes the strategy directly. It asserts the durable atomic pickup
// events, exactly ONE external write, and the committed receipt.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ActionExecutionService,
  ActionPreflightReadPort,
  CalendarActionWritePort,
  CalendarWriteOutcome,
} from "../src/index.js";
import {
  BUNDLED_SCHEMA_VERSION,
  canonicalJsonString,
  closeKernelDatabase,
  createActionExecutionService,
  createActionStrategy,
  createKernelRepository,
  createReferenceManager,
  generateId,
  migrateKernelDatabase,
  openKernelDatabase,
  RunEngine,
  StrategyRegistry,
  sha256Hex,
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
const CANONICAL_KEY = "cal|cal1|evt1";

interface Fixture {
  handle: ReturnType<typeof openKernelDatabase>;
  db: Database.Database;
  actionRunId: string;
  executionId: string;
  connectorId: string;
  writes: CalendarActionWriteRequestRecord[];
}

interface CalendarActionWriteRequestRecord {
  readonly start: string;
  readonly end: string;
}

function eventTypes(db: Database.Database, runId: string): string[] {
  return (
    db
      .prepare("SELECT type FROM run_events WHERE run_id = ? ORDER BY seq ASC")
      .all(runId) as Array<{ type: string }>
  ).map((row) => row.type);
}

/**
 * A committed APPROVED proposal + its queued ActionExecution, exactly as the
 * repository approve transaction leaves it in production.
 */
async function setupApprovedQueuedAction(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "c23-pickup-"));
  tempRoots.push(dir);
  const handle = openKernelDatabase(join(dir, "kernel.sqlite"));
  const db = handle.raw;
  const migrated = await migrateKernelDatabase({
    db,
    targetVersion: BUNDLED_SCHEMA_VERSION,
    migrationsDir: MIGRATIONS_DIR,
  });
  if (migrated.toVersion !== BUNDLED_SCHEMA_VERSION) {
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
    'INSERT INTO turns (id, session_id, seq, input_json, frozen_context, created_at, next_run_attempt) VALUES (?, ?, 1, \'{"version":1,"kind":"user_text","text":"hi"}\', \'{"version":1,"temporal":{"now":1,"timeZone":"UTC"}}\', 1, 1)',
  ).run(agentTurnId, sessionId);
  db.prepare(
    'INSERT INTO turns (id, session_id, seq, input_json, frozen_context, created_at, next_run_attempt) VALUES (?, ?, 2, ?, \'{"version":1,"temporal":{"now":1,"timeZone":"UTC"}}\', 1, 1)',
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
  db.prepare(
    "INSERT INTO runs (id, turn_id, session_id, attempt, status, strategy, result_json, event_seq, select_on_success, tool_requests_used, created_at, started_at, finished_at) VALUES (?, ?, ?, 1, 'completed', 'agent', '{\"version\":1,\"text\":\"ok\"}', 2, 1, 0, 1, 1, 1)",
  ).run(agentRunId, agentTurnId, sessionId);
  db.prepare(
    "INSERT INTO connector_instances (id, kind, display_name, config_json, created_at) VALUES (?, 'calendar', 'c', '{}', 1)",
  ).run(connectorId);
  db.prepare(
    "INSERT INTO resources (id, connector_instance_id, canonical_key, title, next_revision, created_at) VALUES (?, ?, ?, 'Event', 2, 1)",
  ).run(resourceId, connectorId, CANONICAL_KEY);
  db.prepare(
    'INSERT INTO resource_snapshots (id, resource_id, revision, source_revision, content_hash, body_json, size_bytes, observed_at, created_at) VALUES (?, ?, 1, \'src@1\', \'hash@1\', \'{"version":1,"status":"confirmed","title":"Event"}\', 10, 1, 1)',
  ).run(basedSnapshotId, resourceId);
  db.prepare(
    "INSERT INTO session_references (id, session_id, ordinal, resource_id, snapshot_id, created_at) VALUES (?, ?, 1, ?, ?, 1)",
  ).run(refId, sessionId, resourceId, basedSnapshotId);

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
    JSON.stringify(TIMED_INPUT),
    refId,
    resourceId,
    basedSnapshotId,
    JSON.stringify(PREVIEW),
    PROPOSAL_SHA,
  );

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
    JSON.stringify({ proposalId, proposalHash: PROPOSAL_SHA, executionId }),
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
    sha256Hex(canonicalJsonString(TIMED_INPUT)),
  );

  return { handle, db, actionRunId, executionId, connectorId, writes: [] };
}

/** Deterministic authoritative port: first read `src@1`, later `src@2`
 *  reflecting the intended boundaries, exactly as the write would land. */
function readPortFor(fx: Fixture): ActionPreflightReadPort {
  let calls = 0;
  return {
    read: async () => {
      calls += 1;
      return {
        status: "ok" as const,
        observation: {
          connectorInstanceId: fx.connectorId,
          resourceCanonicalKey: CANONICAL_KEY,
          eventStatus: "confirmed" as const,
          title: "Event",
          text: JSON.stringify({
            start: TIMED_INPUT.start,
            end: TIMED_INPUT.end,
          }),
          sourceRevision: calls === 1 ? "src@1" : "src@2",
          observedAt: 100,
        },
      };
    },
  };
}

describe("C23 automatic scheduler pickup of an approved Action Run", () => {
  it("picks up atomically through the real RunEngine and completes with one write and a receipt", async () => {
    const fx = await setupApprovedQueuedAction();
    let now = 100;
    try {
      const repo = createKernelRepository(fx.db);
      const readPort = readPortFor(fx);
      const service: ActionExecutionService = createActionExecutionService({
        db: fx.db,
        referenceManager: createReferenceManager(fx.db),
        preflightRead: readPort,
        clock: () => now,
      });
      const writePort: CalendarActionWritePort = {
        capability: {
          tool: "calendar.reschedule",
          editableFields: ["start", "end"],
          connectorInstanceId: fx.connectorId,
          writeEnabled: true,
        },
        update: async (request): Promise<CalendarWriteOutcome> => {
          fx.writes.push({ start: request.start, end: request.end });
          return { status: "succeeded" };
        },
      };
      const registry = new StrategyRegistry();
      registry.register(
        "m5-action",
        createActionStrategy({
          db: fx.db,
          service,
          preflightRead: readPort,
          writePort,
          resolveTarget: (canonicalKey) =>
            canonicalKey === CANONICAL_KEY
              ? { calendarId: "cal1", eventId: "evt1" }
              : undefined,
        }),
      );

      const engine = new RunEngine({
        db: fx.db,
        repo,
        registry,
        // Long poll cadence: this test drives `pump()` explicitly so the
        // pickup is observed exactly once, deterministically.
        pollIntervalMs: 3_600_000,
        clock: {
          now: () => (now += 1),
          sleep: () => Promise.resolve(),
          setTimeout: () => 0,
          clearTimeout: () => undefined,
        },
      });
      engine.start();

      // REAL generic scheduler pickup — nothing else is called by hand.
      expect(engine.pump()).toBe(1);
      for (let attempt = 0; attempt < 500; attempt += 1) {
        if (engine.inflightCount() === 0) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      expect(engine.inflightCount()).toBe(0);

      // A further pump never re-picks the terminal Run up.
      expect(engine.pump()).toBe(0);

      const view = service.getActionRunView(fx.actionRunId);
      expect(view.run.status).toBe("completed");
      expect(view.execution?.status).toBe("succeeded");
      expect(view.receipt).toMatchObject({
        outcome: "succeeded",
        observedRevision: "src@2",
      });

      // EXACTLY ONE external write through the injected port.
      expect(fx.writes).toEqual([
        { start: TIMED_INPUT.start, end: TIMED_INPUT.end },
      ]);

      // The pickup is durable and atomic: run.started + action.preflight_started
      // were committed together by the scheduler pass, exactly once each.
      const types = eventTypes(fx.db, fx.actionRunId);
      expect(types.slice(0, 4)).toEqual([
        "run.queued",
        "action.approved",
        "run.started",
        "action.preflight_started",
      ]);
      expect(types.filter((type) => type === "run.started")).toHaveLength(1);
      expect(types).toContain("action.execution_started");
      expect(types.at(-1)).toBe("run.completed");
      expect(
        types.filter((type) => type === "action.execution_finished"),
      ).toHaveLength(1);

      await engine.shutdown({ drainMs: 0 });
    } finally {
      await closeKernelDatabase(fx.handle);
    }
  });

  it("keeps an unapproved-bound action run queued rather than failing closed through pickup", async () => {
    // The generic pump must never own an action terminal: with no registered
    // `m5-action` runtime the run is simply LEFT QUEUED (§18.6).
    const fx = await setupApprovedQueuedAction();
    try {
      const repo = createKernelRepository(fx.db);
      const engine = new RunEngine({
        db: fx.db,
        repo,
        pollIntervalMs: 3_600_000,
        clock: {
          now: () => 100,
          sleep: () => Promise.resolve(),
          setTimeout: () => 0,
          clearTimeout: () => undefined,
        },
      });
      engine.start();
      expect(engine.pump()).toBe(0);
      const row = fx.db
        .prepare("SELECT status FROM runs WHERE id = ?")
        .get(fx.actionRunId) as { status: string };
      expect(row.status).toBe("queued");
      await engine.shutdown({ drainMs: 0 });
    } finally {
      await closeKernelDatabase(fx.handle);
    }
  });
});
