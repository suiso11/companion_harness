// Readback same-instant regression: the approved proposal stores the intended
// instants exactly as staged (`+09:00`, no millis), while the authoritative
// read-back carries the REAL normalized Google serialization (canonical UTC
// `Z` with millis, `allDayEndExclusive: false`). Verification MUST compare
// the same INSTANT with strict RFC3339 semantics — never exact strings (a
// representation mismatch is not a content mismatch) and never `Date.parse`
// (rollover/loose parsing could verify a wrong date).
//
// Failing-before: the UTC read-back of the exact intended bounds finished as
// `succeeded_unverified` although the write had landed. Countercases (wrong
// date/start/end, deleted, identity mismatch, read failure, malformed body,
// stale all-day body) MUST stay `succeeded_unverified` with no resend.

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
  calendarEventBodyText,
  canonicalJsonString,
  closeKernelDatabase,
  createActionExecutionService,
  createActionStrategy,
  createReferenceManager,
  generateId,
  migrateKernelDatabase,
  openKernelDatabase,
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

// Intended bounds exactly as staged/approved (Tokyo wall time, no millis).
const PROPOSAL_START = "2026-10-16T15:00:00+09:00";
const PROPOSAL_END = "2026-10-16T16:00:00+09:00";
// The SAME instants as the real readonly normalization emits them
// (canonical UTC ISO with millis, `allDayEndExclusive: false`).
const GOOGLE_START = "2026-10-16T06:00:00.000Z";
const GOOGLE_END = "2026-10-16T07:00:00.000Z";

const PREVIEW = {
  summary: `calendar.reschedule: start=${PROPOSAL_START} end=${PROPOSAL_END}`,
} as const;
const TIMED_INPUT = { start: PROPOSAL_START, end: PROPOSAL_END } as const;
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
  writes: Array<{ start: string; end: string }>;
}

async function setupApprovedQueuedAction(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "readback-instant-"));
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

/** Google-shaped normalized observation body (canonical UTC, timed). */
function googleTimedBody(start: string, end: string): string {
  return calendarEventBodyText({
    canonicalKey: CANONICAL_KEY,
    status: "confirmed",
    title: "Event",
    start,
    end,
    allDayEndExclusive: false,
    sourceRevision: "src@2",
    revisionBasis: "etag",
  } as const);
}

type ReadbackCase =
  | { kind: "ok"; text: string; status?: "confirmed"; key?: string }
  | { kind: "deleted" }
  | { kind: "port"; portStatus: "unavailable" | "schema_invalid" };

/**
 * Drive the REAL strategy: preflight (call 1) always observes the approved
 * `src@1` revision; the §18.7 read-back (call 2) observes the case body.
 */
async function driveStrategy(
  fx: Fixture,
  readback: ReadbackCase,
): Promise<{ status: string | null; outcome: unknown }> {
  let calls = 0;
  const readPort: ActionPreflightReadPort = {
    read: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          status: "ok" as const,
          observation: {
            connectorInstanceId: fx.connectorId,
            resourceCanonicalKey: CANONICAL_KEY,
            eventStatus: "confirmed" as const,
            title: "Event",
            text: calendarEventBodyText({
              canonicalKey: CANONICAL_KEY,
              status: "confirmed",
              title: "Event",
              start: "2026-10-16",
              end: "2026-10-17",
              allDayEndExclusive: true,
              sourceRevision: "src@1",
              revisionBasis: "etag",
            } as const),
            sourceRevision: "src@1",
            observedAt: 100,
          },
        };
      }
      if (readback.kind === "port") {
        return { status: readback.portStatus };
      }
      if (readback.kind === "deleted") {
        return {
          status: "ok" as const,
          observation: {
            connectorInstanceId: fx.connectorId,
            resourceCanonicalKey: CANONICAL_KEY,
            eventStatus: "deleted" as const,
            title: "Event",
            text: googleTimedBody(GOOGLE_START, GOOGLE_END),
            sourceRevision: "src@2",
            observedAt: 100,
          },
        };
      }
      return {
        status: "ok" as const,
        observation: {
          connectorInstanceId: fx.connectorId,
          resourceCanonicalKey: readback.key ?? CANONICAL_KEY,
          eventStatus: readback.status ?? ("confirmed" as const),
          title: "Event",
          text: readback.text,
          sourceRevision: "src@2",
          observedAt: 100,
        },
      };
    },
  };
  const service: ActionExecutionService = createActionExecutionService({
    db: fx.db,
    referenceManager: createReferenceManager(fx.db),
    preflightRead: readPort,
    clock: () => 100,
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
  const strategy = createActionStrategy({
    db: fx.db,
    service,
    preflightRead: readPort,
    writePort,
    resolveTarget: (canonicalKey) =>
      canonicalKey === CANONICAL_KEY
        ? { calendarId: "cal1", eventId: "evt1" }
        : undefined,
  });
  await strategy({
    run: { id: fx.actionRunId },
    signal: new AbortController().signal,
  } as unknown as Parameters<typeof strategy>[0]);
  const view = service.getActionRunView(fx.actionRunId);
  return {
    status: view.execution?.status ?? null,
    outcome: view.receipt?.outcome,
  };
}

describe("§18.7 read-back same-instant verification (real normalized Google shape)", () => {
  it("verifies the intended bounds when the read-back is the same instant in canonical UTC", async () => {
    const fx = await setupApprovedQueuedAction();
    try {
      const result = await driveStrategy(fx, {
        kind: "ok",
        text: googleTimedBody(GOOGLE_START, GOOGLE_END),
      });
      expect(result.status).toBe("succeeded");
      expect(result.outcome).toBe("succeeded");
      // Exactly ONE write: verification never resends.
      expect(fx.writes).toHaveLength(1);
    } finally {
      await closeKernelDatabase(fx.handle);
    }
  });

  it("leaves a wrong-date read-back unverified with no resend", async () => {
    const fx = await setupApprovedQueuedAction();
    try {
      const result = await driveStrategy(fx, {
        kind: "ok",
        text: googleTimedBody(
          "2026-10-17T06:00:00.000Z",
          "2026-10-17T07:00:00.000Z",
        ),
      });
      expect(result.status).toBe("succeeded_unverified");
      expect(result.outcome).toBe("succeeded_unverified");
      expect(fx.writes).toHaveLength(1);
    } finally {
      await closeKernelDatabase(fx.handle);
    }
  });

  it("leaves a start-only mismatch unverified", async () => {
    const fx = await setupApprovedQueuedAction();
    try {
      const result = await driveStrategy(fx, {
        kind: "ok",
        text: googleTimedBody("2026-10-16T07:00:00.000Z", GOOGLE_END),
      });
      expect(result.status).toBe("succeeded_unverified");
      expect(fx.writes).toHaveLength(1);
    } finally {
      await closeKernelDatabase(fx.handle);
    }
  });

  it("leaves an end-only mismatch unverified", async () => {
    const fx = await setupApprovedQueuedAction();
    try {
      const result = await driveStrategy(fx, {
        kind: "ok",
        text: googleTimedBody(GOOGLE_START, "2026-10-16T08:00:00.000Z"),
      });
      expect(result.status).toBe("succeeded_unverified");
      expect(fx.writes).toHaveLength(1);
    } finally {
      await closeKernelDatabase(fx.handle);
    }
  });

  it("leaves a stale all-day (date-only) read-back unverified", async () => {
    const fx = await setupApprovedQueuedAction();
    try {
      const result = await driveStrategy(fx, {
        kind: "ok",
        text: calendarEventBodyText({
          canonicalKey: CANONICAL_KEY,
          status: "confirmed",
          title: "Event",
          start: "2026-10-16",
          end: "2026-10-17",
          allDayEndExclusive: true,
          sourceRevision: "src@2",
          revisionBasis: "etag",
        } as const),
      });
      expect(result.status).toBe("succeeded_unverified");
      expect(fx.writes).toHaveLength(1);
    } finally {
      await closeKernelDatabase(fx.handle);
    }
  });

  it("leaves a deleted read-back unverified", async () => {
    const fx = await setupApprovedQueuedAction();
    try {
      const result = await driveStrategy(fx, { kind: "deleted" });
      expect(result.status).toBe("succeeded_unverified");
      expect(fx.writes).toHaveLength(1);
    } finally {
      await closeKernelDatabase(fx.handle);
    }
  });

  it("leaves an identity-mismatched read-back unverified", async () => {
    const fx = await setupApprovedQueuedAction();
    try {
      const result = await driveStrategy(fx, {
        kind: "ok",
        text: googleTimedBody(GOOGLE_START, GOOGLE_END),
        key: "cal|cal1|other",
      });
      expect(result.status).toBe("succeeded_unverified");
      expect(fx.writes).toHaveLength(1);
    } finally {
      await closeKernelDatabase(fx.handle);
    }
  });

  it("leaves a failed read-back unverified with no resend", async () => {
    const fx = await setupApprovedQueuedAction();
    try {
      const result = await driveStrategy(fx, {
        kind: "port",
        portStatus: "unavailable",
      });
      expect(result.status).toBe("succeeded_unverified");
      expect(fx.writes).toHaveLength(1);
    } finally {
      await closeKernelDatabase(fx.handle);
    }
  });

  it("leaves a malformed read-back body unverified", async () => {
    const fx = await setupApprovedQueuedAction();
    try {
      const result = await driveStrategy(fx, {
        kind: "ok",
        text: "not-json",
      });
      expect(result.status).toBe("succeeded_unverified");
      expect(fx.writes).toHaveLength(1);
    } finally {
      await closeKernelDatabase(fx.handle);
    }
  });
});
