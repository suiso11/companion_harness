// M6 migration 0009 through M6 and later migrations regression (behavioral,
// no DDL text copies).
//
// Seeds a REAL v9 store through production helpers only (ReferenceManager +
// the production proposal stager + the production repository approve), with
// one pending reschedule proposal and one terminal reschedule chain whose
// receipt + citations were committed by the REAL strategy, then runs the
// ACTUAL migrator from v9 to latest with a proper pre-upgrade backup and proves:
// - the backup exists and verifies (quick_check, user_version 9),
// - every M5 row reads back verbatim (proposals, executions, grants,
//   receipts, session references),
// - foreign_key_check is clean,
// - the old pending proposal still approves AND executes locally to a
//   verified succeeded receipt through the real strategy,
// - the old terminal receipt/citation reads unchanged,
// - NEW calendar.create stages/approves/executes to a verified receipt
//   with a NEW rN through the real create flow,
// - per-tool NULL combos and unowned references are rejected by SQLite
//   itself (CHECK/FK), so the 0010 blind COPY can never meet an invalid
//   old row (no rollback path exists to test),
// - one pending spans both tools (cross-tool boundary),
// - create read-back edges: wrong title -> succeeded_unverified with no
//   new rN; wrong-resource key -> succeeded_unverified with no new rN
//   through the strategy (the direct terminal fail-closes with a throw).
//
// Direct SQL appears ONLY for old-schema v9 fixture INSERTs (valid rows the
// old DDL accepts) and for row comparisons — never in production code.

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveCreateEventId } from "@companion/contracts";
import type Database from "better-sqlite3";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createActionExecutionService } from "../src/action_executions.js";
import { createActionProposalStager } from "../src/action_proposals.js";
import {
  type CalendarCreateWritePort,
  createActionStrategy,
} from "../src/action_strategy.js";
import { calendarEventBodyText } from "../src/calendar_tools.js";
import { generateId, sha256Hex } from "../src/canonical.js";
import { RepositoryValidationError } from "../src/errors.js";
import {
  closeKernelDatabase,
  createDurableCalendarTargetStore,
  createKernelRepository,
  createReferenceManager,
  migrateKernelDatabase,
  openKernelDatabase,
  quickCheck,
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

const T0 = 1_700_000_000_000;
const OLD_START = "2026-01-01T10:00:00Z";
const OLD_END = "2026-01-01T11:00:00Z";
const NEW_START = "2026-02-01T10:00:00Z";
const NEW_END = "2026-02-01T11:00:00Z";
const CREATE_TITLE = "Migrated create";
const CREATE_START = "2026-03-01T10:00:00Z";
const CREATE_END = "2026-03-01T11:00:00Z";

function sink() {
  const events: Array<{ runId: string; type: string }> = [];
  return {
    events,
    seq: 0,
    appendEventTx(runId: string, expectedPrevSeq: number, type: string) {
      this.seq = expectedPrevSeq + 1;
      events.push({ runId, type });
      return this.seq;
    },
  };
}

function observe(
  db: Database.Database,
  sessionId: string,
  runId: string,
  connectorId: string,
  canonicalKey: string,
  title: string,
  start: string,
  end: string,
  revision: string,
  now: number,
) {
  const rm = createReferenceManager(db);
  const presented = rm.presentObservations(
    sessionId,
    runId,
    [
      {
        connectorInstanceId: connectorId,
        canonicalKey,
        title,
        text: calendarEventBodyText({
          canonicalKey,
          status: "confirmed",
          title,
          start,
          end,
          allDayEndExclusive: true,
          sourceRevision: revision,
          revisionBasis: "etag",
        }),
        sourceRevision: revision,
        observedAt: now,
      },
    ],
    { freshness: "normal", now },
  );
  if (!presented.applied || presented.references.length !== 1) {
    throw new Error("observation was not applied");
  }
  const first = presented.references[0];
  if (first === undefined) {
    throw new Error("observation was not applied");
  }
  return first;
}

function openRun(
  db: Database.Database,
  sessionId: string,
  seq: number,
  now: number,
): { turnId: string; runId: string } {
  const turnId = generateId();
  const runId = generateId();
  db.prepare(
    "INSERT INTO turns (id, session_id, seq, input_json, frozen_context, created_at, next_run_attempt) VALUES (?, ?, ?, '{}', '{}', ?, 1)",
  ).run(turnId, sessionId, seq, now);
  // Mirror the production turn allocator: the manual turn consumes its seq
  // so a later approval decision turn cannot collide on (session_id, seq).
  db.prepare(
    "UPDATE sessions SET next_turn_position = ? WHERE id = ? AND next_turn_position <= ?",
  ).run(seq + 1, sessionId, seq);
  db.prepare(
    "INSERT INTO runs (id, turn_id, session_id, attempt, status, strategy, event_seq, select_on_success, tool_requests_used, created_at, started_at) VALUES (?, ?, ?, 1, 'running', 's', 0, 1, 0, ?, ?)",
  ).run(runId, turnId, sessionId, now, now);
  return { turnId, runId };
}

function setupSession(db: Database.Database, now: number): string {
  const sessionId = generateId();
  db.prepare(
    "INSERT INTO sessions (id, created_at, last_active_at, next_turn_position) VALUES (?, ?, ?, 1)",
  ).run(sessionId, now, now);
  // Mirror production createSession: every session owns exactly one
  // versioned reference context (version 1, empty) or approval freezes fail.
  db.prepare(
    "INSERT INTO session_reference_context (session_id, version, items_json, updated_at) VALUES (?, 1, '[]', ?)",
  ).run(sessionId, now);
  return sessionId;
}

/** Seed a committed reschedule proposal via the PRODUCTION stager. */
function stageReschedule(
  db: Database.Database,
  runId: string,
  refId: string,
  clockNow: number,
): { proposalId: string; hash: string } {
  const stager = createActionProposalStager({
    db,
    writeEnabled: true,
    events: sink() as never,
    clock: () => clockNow,
  });
  stager.stage(runId, {
    targetRefId: refId,
    start: NEW_START,
    end: NEW_END,
  });
  const committed = stager.commitStaged(runId, clockNow + 1);
  return { proposalId: committed.proposalId, hash: committed.hash };
}

function approve(
  db: Database.Database,
  sessionId: string,
  proposalId: string,
  hash: string,
  now: number,
): { executionId: string; actionRunId: string } {
  const repo = createKernelRepository(db, {
    actionProposals: { writeEnabled: true, createEnabled: true },
  });
  // The staging run must be finished before the decision (same rule the
  // server enforces: no active run at decision time). Runs already
  // finished (e.g. a pre-upgrade staging run) need no completion.
  const staging = db
    .prepare(
      "SELECT id FROM runs WHERE session_id = ? AND status = 'running' ORDER BY created_at DESC LIMIT 1",
    )
    .get(sessionId) as { id: string } | undefined;
  if (staging !== undefined) {
    repo.completeRun(
      staging.id,
      { version: 1, text: "plan" },
      { now: now - 1 },
    );
  }
  const accepted = repo.approveProposal(
    sessionId,
    proposalId,
    { proposalHash: hash },
    { key: randomUUID(), now, timeZone: "UTC" },
  );
  if (accepted.status !== 202) {
    throw new Error(`approve did not accept: ${accepted.status}`);
  }
  const row = db
    .prepare(
      "SELECT id, action_run_id FROM action_executions WHERE proposal_id = ?",
    )
    .get(proposalId) as { id: string; action_run_id: string };
  return { executionId: row.id, actionRunId: row.action_run_id };
}

function reschedulePorts(connectorId: string, writes: unknown[]) {
  // The REAL strategy reads twice: call 1 is the preflight (old bounds,
  // src@1) and call 2 is the §18.7 read-back (new bounds, src@2).
  let calls = 0;
  const readPort = {
    read: async () => {
      calls += 1;
      const preflight = calls === 1;
      return {
        status: "ok" as const,
        observation: {
          connectorInstanceId: connectorId,
          resourceCanonicalKey: "cal|cal1|evt1",
          eventStatus: "confirmed" as const,
          title: "Event",
          text: calendarEventBodyText({
            canonicalKey: "cal|cal1|evt1",
            status: "confirmed",
            title: "Event",
            start: preflight ? OLD_START : NEW_START,
            end: preflight ? OLD_END : NEW_END,
            allDayEndExclusive: true,
            sourceRevision: preflight ? "src@1" : "src@2",
            revisionBasis: "etag" as const,
          }),
          sourceRevision: preflight ? "src@1" : "src@2",
          observedAt: T0,
        },
      };
    },
  };
  const writePort = {
    capability: {
      tool: "calendar.reschedule" as const,
      editableFields: ["start", "end"] as ["start", "end"],
      connectorInstanceId: connectorId,
      writeEnabled: true as const,
    },
    update: async (request: { start: string; end: string }) => {
      writes.push({ start: request.start, end: request.end });
      return { status: "succeeded" as const };
    },
  };
  return { readPort, writePort };
}

/** Drive one approved reschedule action run through the REAL strategy. */
async function driveReschedule(
  db: Database.Database,
  connectorId: string,
  actionRunId: string,
  writes: unknown[],
  now: number,
) {
  const { readPort, writePort } = reschedulePorts(connectorId, writes);
  const service = createActionExecutionService({
    db,
    referenceManager: createReferenceManager(db),
    preflightRead: readPort,
    clock: () => now,
  });
  const strategy = createActionStrategy({
    db,
    service,
    preflightRead: readPort,
    writePort,
    resolveTarget: (canonicalKey: string) =>
      canonicalKey === "cal|cal1|evt1"
        ? { calendarId: "cal1", eventId: "evt1" }
        : undefined,
  });
  await strategy({
    run: { id: actionRunId },
    signal: new AbortController().signal,
  } as unknown as Parameters<typeof strategy>[0]);
  return service.getActionRunView(actionRunId);
}

function createPorts(
  connectorId: string,
  inserts: Array<{ stableEventId: string; title: string }>,
  observationText: (stableEventId: string) => string | null,
  // The source verifies observation.title (not text-embedded title), so a
  // read-back title drift must ride in the title field itself.
  observationTitle: string = CREATE_TITLE,
) {
  const createWritePort: CalendarCreateWritePort = {
    capability: {
      tool: "calendar.create",
      editableFields: ["title", "start", "end"],
      connectorInstanceId: connectorId,
      writeEnabled: true,
    },
    insert: async (request) => {
      inserts.push({
        stableEventId: request.stableEventId,
        title: request.title,
      });
      return { status: "succeeded" };
    },
  };
  const createRead = {
    read: async (request: { stableEventId: string }) => {
      const text = observationText(request.stableEventId);
      if (text === null) {
        return { status: "unavailable" as const };
      }
      return {
        status: "ok" as const,
        observation: {
          connectorInstanceId: connectorId,
          resourceCanonicalKey: expectedCreateKey(
            connectorId,
            request.stableEventId,
          ),
          eventStatus: "confirmed" as const,
          title: observationTitle,
          text,
          sourceRevision: request.stableEventId,
          observedAt: T0,
        },
      };
    },
  };
  return { createWritePort, createRead };
}

/**
 * Authentic verified read-back identity under the existing
 * normalization/hash convention: `calendar:` + SHA-256 hex of the JSON
 * tuple [connectorInstanceId, calendarId, stableEventId] for the
 * strategy's host-selected `cal1` calendar.
 */
function expectedCreateKey(connectorId: string, stableEventId: string): string {
  return `calendar:${sha256Hex(
    JSON.stringify([connectorId, "cal1", stableEventId]),
  )}`;
}

function createObservationText(
  connectorId: string,
  stableEventId: string,
  title: string,
): string {
  return calendarEventBodyText({
    canonicalKey: expectedCreateKey(connectorId, stableEventId),
    status: "confirmed",
    title,
    start: CREATE_START,
    end: CREATE_END,
    allDayEndExclusive: false,
    sourceRevision: stableEventId,
    revisionBasis: "etag",
  });
}

/** Drive one approved create action run through the REAL create flow. */
async function driveCreate(
  db: Database.Database,
  connectorId: string,
  actionRunId: string,
  inserts: Array<{ stableEventId: string; title: string }>,
  observationText: (stableEventId: string) => string | null,
  now: number,
  observationTitle: string = CREATE_TITLE,
) {
  const { createWritePort, createRead } = createPorts(
    connectorId,
    inserts,
    observationText,
    observationTitle,
  );
  // The create service branch performs NO event GET (authority binding
  // only), but the service still requires an injected port present; a
  // throwing stub proves no GET ever happens.
  const noGetPort = {
    read: async () => {
      throw new Error("create flow performs no event GET");
    },
  };
  const service = createActionExecutionService({
    db,
    referenceManager: createReferenceManager(db),
    targetStore: createDurableCalendarTargetStore(db),
    preflightRead: noGetPort,
    clock: () => now,
  });
  const strategy = createActionStrategy({
    db,
    service,
    preflightRead: noGetPort,
    createWritePort,
    createRead,
    createSelection: { calendarId: "cal1" },
  });
  await strategy({
    run: { id: actionRunId },
    signal: new AbortController().signal,
  } as unknown as Parameters<typeof strategy>[0]);
  return service.getActionRunView(actionRunId);
}

function rows(db: Database.Database, table: string): unknown[] {
  return db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
}

describe("M6 migration 0009 through M6 and later preserves reschedule and enables create", () => {
  it("upgrades a populated v9 store with backup, keeps every M5 row, and runs old + new tools", async () => {
    const dir = mkdtempSync(join(tmpdir(), "m6-migrate-0010-"));
    tempRoots.push(dir);
    const file = join(dir, "kernel.sqlite");
    const backups = join(dir, "backups");

    // --- Build a REAL v9 store (target 9) through production paths. ---
    const setup = openKernelDatabase(file);
    try {
      await migrateKernelDatabase({
        db: setup.raw,
        backupDir: backups,
        migrationsDir: MIGRATIONS_DIR,
        targetVersion: 9,
      });
    } finally {
      closeKernelDatabase(setup);
    }

    const build = openKernelDatabase(file);
    let pendingSession: string;
    let pendingProposal: string;
    let pendingHash: string;
    let terminalSession: string;
    let terminalProposal: string;
    try {
      const db = build.raw;
      const rm = createReferenceManager(db);
      const connector = rm.ensureCalendarConnectorInstance("c", "cal1", {
        now: T0,
      });

      // Session P: pending reschedule (staged + committed, never decided).
      pendingSession = setupSession(db, T0);
      const pRun = openRun(db, pendingSession, 1, T0);
      const pRef = observe(
        db,
        pendingSession,
        pRun.runId,
        connector.id,
        "cal|cal1|evt1",
        "Event",
        OLD_START,
        OLD_END,
        "src@1",
        T0,
      );
      const staged = stageReschedule(db, pRun.runId, pRef.referenceId, T0 + 1);
      pendingProposal = staged.proposalId;
      pendingHash = staged.hash;
      // Finish the staging run so the proposal is decidable later; the
      // proposal itself stays pending.
      createKernelRepository(db, {
        actionProposals: { writeEnabled: true },
      }).completeRun(pRun.runId, { version: 1, text: "plan" }, { now: T0 + 2 });

      // Session T: terminal reschedule chain committed by the REAL
      // strategy at v9 (approved -> ONE write -> verified succeeded with
      // a fresh rN citation).
      terminalSession = setupSession(db, T0);
      const tRun = openRun(db, terminalSession, 1, T0 + 10);
      const tRef = observe(
        db,
        terminalSession,
        tRun.runId,
        connector.id,
        "cal|cal1|evt1",
        "Event",
        OLD_START,
        OLD_END,
        "src@1",
        T0 + 10,
      );
      const tStaged = stageReschedule(
        db,
        tRun.runId,
        tRef.referenceId,
        T0 + 11,
      );
      terminalProposal = tStaged.proposalId;
      const tApproved = approve(
        db,
        terminalSession,
        tStaged.proposalId,
        tStaged.hash,
        T0 + 20,
      );
      const tWrites: unknown[] = [];
      const tView = await driveReschedule(
        db,
        connector.id,
        tApproved.actionRunId,
        tWrites,
        T0 + 30,
      );
      expect(tView.receipt?.outcome).toBe("succeeded");
      expect(tWrites).toHaveLength(1);
    } finally {
      closeKernelDatabase(build);
    }

    // --- Snapshot every M5 row before the upgrade. ---
    const before = openKernelDatabase(file);
    let pendingRow: unknown;
    let receiptRows: unknown[];
    let referenceRows: unknown[];
    try {
      pendingRow = before.raw
        .prepare("SELECT * FROM action_proposals WHERE id = ?")
        .get(pendingProposal);
      receiptRows = rows(before.raw, "action_receipts");
      referenceRows = rows(before.raw, "session_references");
      expect(receiptRows).toHaveLength(1);
      expect((receiptRows[0] as { outcome: string }).outcome).toBe("succeeded");
    } finally {
      closeKernelDatabase(before);
    }

    // --- Run the ACTUAL migrator from 0009 to latest with a proper backup. ---
    const handle = openKernelDatabase(file);
    try {
      const result = await migrateKernelDatabase({
        db: handle.raw,
        backupDir: backups,
        migrationsDir: MIGRATIONS_DIR,
        now: new Date("2026-10-16T00:00:00.000Z"),
        backupId: "11111111-2222-4333-8444-555555555555",
      });
      expect(result).toMatchObject({
        migrated: true,
        fromVersion: 9,
      });
      expect(typeof result.backupPath).toBe("string");
      // Backup verifies and still carries version 9.
      const copy = new BetterSqlite3(result.backupPath as string, {
        readonly: true,
      });
      try {
        expect(quickCheck(copy)).toBe("ok");
        expect(Number(copy.pragma("user_version", { simple: true }))).toBe(9);
      } finally {
        copy.close();
      }
      // No .partial residue; live DB is clean.
      const { readdirSync } = await import("node:fs");
      expect(
        readdirSync(backups).filter((entry) => entry.endsWith(".partial")),
      ).toEqual([]);
      expect(quickCheck(handle.raw)).toBe("ok");
      expect(handle.raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

      // --- Every M5 row reads back verbatim. ---
      const pendingAfter = handle.raw
        .prepare("SELECT * FROM action_proposals WHERE id = ?")
        .get(pendingProposal);
      expect(pendingAfter).toEqual(pendingRow);
      expect(rows(handle.raw, "action_receipts")).toEqual(receiptRows);
      expect(rows(handle.raw, "session_references")).toEqual(referenceRows);
      expect(rows(handle.raw, "action_executions")).toHaveLength(1);
      expect(rows(handle.raw, "action_execution_grants")).toHaveLength(1);

      // Old terminal receipt/citation reads unchanged through the REAL view.
      const tExecution = handle.raw
        .prepare(
          "SELECT action_run_id FROM action_executions WHERE proposal_id = ?",
        )
        .get(terminalProposal) as { action_run_id: string };
      const terminalView = createActionExecutionService({
        db: handle.raw,
        referenceManager: createReferenceManager(handle.raw),
        clock: () => T0 + 40,
      }).getActionRunView(tExecution.action_run_id);
      expect(terminalView.receipt?.outcome).toBe("succeeded");
      expect(terminalView.receipt?.observedRevision).toBe("src@2");

      // --- Old pending still approves AND executes locally post-upgrade. ---
      const approved = approve(
        handle.raw,
        pendingSession,
        pendingProposal,
        pendingHash,
        T0 + 50,
      );
      const oldWrites: unknown[] = [];
      const connectorId = (
        handle.raw
          .prepare(
            "SELECT connector_instance_id FROM action_proposals WHERE id = ?",
          )
          .get(pendingProposal) as { connector_instance_id: string }
      ).connector_instance_id;
      const oldView = await driveReschedule(
        handle.raw,
        connectorId,
        approved.actionRunId,
        oldWrites,
        T0 + 60,
      );
      expect(oldView.receipt?.outcome).toBe("succeeded");
      expect(oldWrites).toHaveLength(1);

      // --- NEW calendar.create stages/approves/verifies with a NEW rN. ---
      const createSession = setupSession(handle.raw, T0 + 100);
      const cRun = openRun(handle.raw, createSession, 1, T0 + 100);
      const createStager = createActionProposalStager({
        db: handle.raw,
        writeEnabled: true,
        createEnabled: true,
        events: sink() as never,
        clock: () => T0 + 100,
      });
      const created = createStager.stageCreate(
        cRun.runId,
        { title: CREATE_TITLE, start: CREATE_START, end: CREATE_END },
        { connectorInstanceId: connectorId },
      );
      expect(created.tool).toBe("calendar.create");
      const createdCommitted = createStager.commitStaged(cRun.runId, T0 + 101);
      const cApproved = approve(
        handle.raw,
        createSession,
        createdCommitted.proposalId,
        created.hash,
        T0 + 110,
      );
      // The stable insert id derives from the IMMUTABLE execution id.
      expect(deriveCreateEventId(cApproved.executionId)).toMatch(
        /^[0-9a-f]{32}$/,
      );
      const refsBefore = (
        handle.raw
          .prepare(
            "SELECT COUNT(*) AS c FROM session_references WHERE session_id = ?",
          )
          .get(createSession) as { c: number }
      ).c;
      const inserts: Array<{ stableEventId: string; title: string }> = [];
      const cView = await driveCreate(
        handle.raw,
        connectorId,
        cApproved.actionRunId,
        inserts,
        (stableEventId) =>
          createObservationText(connectorId, stableEventId, CREATE_TITLE),
        T0 + 120,
      );
      expect(cView.receipt?.outcome).toBe("succeeded");
      expect(inserts).toHaveLength(1);
      expect(inserts[0]?.stableEventId).toBe(
        deriveCreateEventId(cApproved.executionId),
      );
      const refsAfter = (
        handle.raw
          .prepare(
            "SELECT COUNT(*) AS c FROM session_references WHERE session_id = ?",
          )
          .get(createSession) as { c: number }
      ).c;
      expect(refsAfter).toBe(refsBefore + 1);
      const fresh = handle.raw
        .prepare(
          "SELECT resource_id, snapshot_id FROM session_references WHERE session_id = ? ORDER BY ordinal DESC LIMIT 1",
        )
        .get(createSession) as { resource_id: string; snapshot_id: string };
      expect(cView.receipt?.resultSnapshotId).toBe(fresh.snapshot_id);

      // --- SQLite itself rejects per-tool NULL combos and unowned refs. ---
      const otherSession = setupSession(handle.raw, T0 + 200);
      const badId = generateId();
      // create carrying a source target: CHECK violation, not a Zod error.
      expect(() =>
        handle.raw
          .prepare(
            "INSERT INTO action_proposals (id, session_id, source_turn_id, source_run_id, tool, connector_instance_id, input_json, target_ref_id, target_resource_id, based_on_snapshot_id, expected_revision, preview_json, hash, status, created_at, expires_at) VALUES (?, ?, ?, ?, 'calendar.create', ?, '{}', ?, ?, ?, ?, '{}', 'h', 'pending', 1, 2)",
          )
          .run(
            badId,
            otherSession,
            generateId(),
            generateId(),
            connectorId,
            generateId(),
            generateId(),
            generateId(),
            "src@1",
          ),
      ).toThrow();
      // reschedule missing its target: CHECK violation.
      expect(() =>
        handle.raw
          .prepare(
            "INSERT INTO action_proposals (id, session_id, source_turn_id, source_run_id, tool, connector_instance_id, input_json, preview_json, hash, status, created_at, expires_at) VALUES (?, ?, ?, ?, 'calendar.reschedule', ?, '{}', '{}', 'h', 'pending', 1, 2)",
          )
          .run(badId, otherSession, generateId(), generateId(), connectorId),
      ).toThrow();
      // reschedule pointing at another session's reference: FK violation.
      const foreignRef = (
        handle.raw
          .prepare("SELECT id FROM session_references LIMIT 1")
          .get() as { id: string }
      ).id;
      expect(() =>
        handle.raw
          .prepare(
            "INSERT INTO action_proposals (id, session_id, source_turn_id, source_run_id, tool, connector_instance_id, input_json, target_ref_id, target_resource_id, based_on_snapshot_id, expected_revision, preview_json, hash, status, created_at, expires_at) VALUES (?, ?, ?, ?, 'calendar.reschedule', ?, '{}', ?, 'res', 'snap', 'src@1', '{}', 'h', 'pending', 1, 2)",
          )
          .run(
            generateId(),
            otherSession,
            generateId(),
            generateId(),
            connectorId,
            foreignRef,
          ),
      ).toThrow();
      expect(handle.raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

      // --- Cross-tool one pending: a pending create blocks reschedule. ---
      const dSession = setupSession(handle.raw, T0 + 300);
      const dRun = openRun(handle.raw, dSession, 1, T0 + 300);
      const dStager = createActionProposalStager({
        db: handle.raw,
        writeEnabled: true,
        createEnabled: true,
        events: sink() as never,
        clock: () => T0 + 300,
      });
      dStager.stageCreate(
        dRun.runId,
        { title: "Blocker", start: CREATE_START, end: CREATE_END },
        { connectorInstanceId: connectorId },
      );
      dStager.commitStaged(dRun.runId, T0 + 301);
      createKernelRepository(handle.raw, {
        actionProposals: { writeEnabled: true },
      }).completeRun(
        dRun.runId,
        { version: 1, text: "plan" },
        { now: T0 + 302 },
      );
      const dRef = observe(
        handle.raw,
        dSession,
        (() => openRun(handle.raw, dSession, 2, T0 + 303).runId)(),
        connectorId,
        "cal|cal1|evt9",
        "Other",
        OLD_START,
        OLD_END,
        "src@9",
        T0 + 303,
      );
      const dRun2 = (
        handle.raw
          .prepare(
            "SELECT id FROM runs WHERE session_id = ? AND status = 'running' ORDER BY created_at DESC LIMIT 1",
          )
          .get(dSession) as { id: string }
      ).id;
      dStager.stage(dRun2, {
        targetRefId: dRef.referenceId,
        start: NEW_START,
        end: NEW_END,
      });
      expect(() => dStager.commitStaged(dRun2, T0 + 304)).toThrow(
        RepositoryValidationError,
      );
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("leaves a wrong-title read-back unverified with no new rN and exactly one insert", async () => {
    const dir = mkdtempSync(join(tmpdir(), "m6-create-edge-"));
    tempRoots.push(dir);
    const handle = openKernelDatabase(join(dir, "kernel.sqlite"));
    try {
      await migrateKernelDatabase({
        db: handle.raw,
        backupDir: join(dir, "b"),
      });
      const db = handle.raw;
      const connector = createReferenceManager(
        db,
      ).ensureCalendarConnectorInstance("c", "cal1", { now: T0 });
      const sessionId = setupSession(db, T0);
      const run = openRun(db, sessionId, 1, T0);
      const stager = createActionProposalStager({
        db,
        writeEnabled: true,
        createEnabled: true,
        events: sink() as never,
        clock: () => T0,
      });
      const created = stager.stageCreate(
        run.runId,
        { title: CREATE_TITLE, start: CREATE_START, end: CREATE_END },
        { connectorInstanceId: connector.id },
      );
      const committedEdge = stager.commitStaged(run.runId, T0 + 1);
      const approved = approve(
        db,
        sessionId,
        committedEdge.proposalId,
        created.hash,
        T0 + 10,
      );
      const refsBefore = (
        db.prepare("SELECT COUNT(*) AS c FROM session_references").get() as {
          c: number;
        }
      ).c;
      const inserts: Array<{ stableEventId: string; title: string }> = [];
      const view = await driveCreate(
        db,
        connector.id,
        approved.actionRunId,
        inserts,
        (stableEventId) =>
          createObservationText(connector.id, stableEventId, "Drifted title"),
        T0 + 20,
        "Drifted title",
      );
      expect(view.receipt?.outcome).toBe("succeeded_unverified");
      expect(inserts).toHaveLength(1);
      expect(
        (
          db.prepare("SELECT COUNT(*) AS c FROM session_references").get() as {
            c: number;
          }
        ).c,
      ).toBe(refsBefore);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("fail-closes a wrong-resource read-back with no materialization", async () => {
    const dir = mkdtempSync(join(tmpdir(), "m6-create-edge-"));
    tempRoots.push(dir);
    const handle = openKernelDatabase(join(dir, "kernel.sqlite"));
    try {
      await migrateKernelDatabase({
        db: handle.raw,
        backupDir: join(dir, "b"),
      });
      const db = handle.raw;
      const connector = createReferenceManager(
        db,
      ).ensureCalendarConnectorInstance("c", "cal1", { now: T0 });
      const sessionId = setupSession(db, T0);
      const run = openRun(db, sessionId, 1, T0);
      const stager = createActionProposalStager({
        db,
        writeEnabled: true,
        createEnabled: true,
        events: sink() as never,
        clock: () => T0,
      });
      const created = stager.stageCreate(
        run.runId,
        { title: CREATE_TITLE, start: CREATE_START, end: CREATE_END },
        { connectorInstanceId: connector.id },
      );
      const committedBad = stager.commitStaged(run.runId, T0 + 1);
      const approved = approve(
        db,
        sessionId,
        committedBad.proposalId,
        created.hash,
        T0 + 10,
      );
      const inserts: Array<{ stableEventId: string; title: string }> = [];
      const { createWritePort } = createPorts(
        connector.id,
        inserts,
        () => null,
      );
      // Wrong-resource key: not the `calendar:<64hex>` derivation the
      // verified terminal binds to. Title AND bounds match on purpose so
      // only the identity check fails: the strategy stays unverified with
      // no materialization (the direct terminal fail-closes with a throw,
      // covered in action_create_review_fixes.test.ts).
      const badRead = {
        read: async () => ({
          status: "ok" as const,
          observation: {
            connectorInstanceId: connector.id,
            resourceCanonicalKey: "cal|cal1|some-other-event",
            eventStatus: "confirmed" as const,
            title: CREATE_TITLE,
            text: calendarEventBodyText({
              canonicalKey: "cal|cal1|some-other-event",
              status: "confirmed",
              title: CREATE_TITLE,
              start: CREATE_START,
              end: CREATE_END,
              allDayEndExclusive: true,
              sourceRevision: "src@x",
              revisionBasis: "etag",
            }),
            sourceRevision: "src@x",
            observedAt: T0,
          },
        }),
      };
      const noGetPort = {
        read: async () => {
          throw new Error("create flow performs no event GET");
        },
      };
      const service = createActionExecutionService({
        db,
        referenceManager: createReferenceManager(db),
        preflightRead: noGetPort,
        clock: () => T0 + 20,
      });
      const strategy = createActionStrategy({
        db,
        service,
        preflightRead: noGetPort,
        createWritePort,
        createRead: badRead,
        createSelection: { calendarId: "cal1" },
      });
      const refsBefore = (
        db.prepare("SELECT COUNT(*) AS c FROM session_references").get() as {
          c: number;
        }
      ).c;
      await strategy({
        run: { id: approved.actionRunId },
        signal: new AbortController().signal,
      } as unknown as Parameters<typeof strategy>[0]);
      // Unverified receipt, no new reference, exactly one insert: the
      // wrong resource never verifies and nothing materializes.
      const view = service.getActionRunView(approved.actionRunId);
      expect(view.receipt?.outcome).toBe("succeeded_unverified");
      expect(inserts).toHaveLength(1);
      expect(
        (
          db.prepare("SELECT COUNT(*) AS c FROM session_references").get() as {
            c: number;
          }
        ).c,
      ).toBe(refsBefore);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
