// M6 calendar.create stager + config gates (hermetic, no fork, no net).
//
// - DEFAULT_ACTION_CONFIG has createEnabled=false; parseActionConfig
//   defaults createEnabled to false and rejects unknown keys.
// - stageCreate requires explicit createEnabled (reschedule-only stagers
//   refuse); create rows are targetless (4 NULL) and commit targetless.
// - one pending proposal per session spans both tools.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createActionProposalStager } from "../src/action_proposals.js";
import { calendarEventBodyText } from "../src/calendar_tools.js";
import { generateId } from "../src/canonical.js";
import { RepositoryValidationError } from "../src/errors.js";
import {
  BUNDLED_SCHEMA_VERSION,
  closeKernelDatabase,
  migrateKernelDatabase,
  openKernelDatabase,
} from "../src/index.js";
import { createReferenceManager } from "../src/reference_manager.js";

const tempRoots: string[] = [];
afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop() as string;
    rmSync(dir, { recursive: true, force: true });
  }
});

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

async function setupDb(): Promise<{
  handle: ReturnType<typeof openKernelDatabase>;
  db: Database.Database;
}> {
  const dir = mkdtempSync(join(tmpdir(), "m6-create-"));
  tempRoots.push(dir);
  const handle = openKernelDatabase(join(dir, "kernel.sqlite"));
  await migrateKernelDatabase({
    db: handle.raw,
    targetVersion: BUNDLED_SCHEMA_VERSION,
  });
  return { handle, db: handle.raw };
}

function addRun(db: Database.Database): {
  sessionId: string;
  runId: string;
  connectorInstanceId: string;
} {
  const sessionId = generateId();
  const turnId = generateId();
  const runId = generateId();
  db.prepare(
    "INSERT INTO sessions (id, created_at, last_active_at, next_turn_position) VALUES (?, 1, 1, 1)",
  ).run(sessionId);
  db.prepare(
    "INSERT INTO turns (id, session_id, seq, input_json, frozen_context, created_at, next_run_attempt) VALUES (?, ?, 1, '{}', '{}', 1, 1)",
  ).run(turnId, sessionId);
  db.prepare(
    "INSERT INTO runs (id, turn_id, session_id, attempt, status, strategy, event_seq, select_on_success, tool_requests_used, created_at, started_at) VALUES (?, ?, ?, 1, 'running', 's', 0, 1, 0, 1, 1)",
  ).run(runId, turnId, sessionId);
  const rm = createReferenceManager(db);
  const connector = rm.ensureCalendarConnectorInstance("c", "cal1", { now: 1 });
  return { sessionId, runId, connectorInstanceId: connector.id };
}

function addTimedTarget(
  db: Database.Database,
  sessionId: string,
  runId: string,
) {
  const rm = createReferenceManager(db);
  const presented = rm.presentObservations(
    sessionId,
    runId,
    [
      {
        connectorInstanceId: rm.ensureCalendarConnectorInstance("c", "cal1", {
          now: 1,
        }).id,
        canonicalKey: "cal|cal1|evt1",
        title: "Event",
        text: calendarEventBodyText({
          canonicalKey: "cal|cal1|evt1",
          status: "confirmed",
          title: "Event",
          start: "2026-01-01T10:00:00Z",
          end: "2026-01-01T11:00:00Z",
          allDayEndExclusive: true,
          sourceRevision: "src@1",
          revisionBasis: "etag",
        }),
        sourceRevision: "src@1",
        observedAt: 1,
      },
    ],
    { freshness: "normal", now: 1 },
  );
  if (!presented.applied || presented.references.length !== 1)
    throw new Error("no reference");
  return presented.references[0]!;
}

describe("M6 create gates", () => {
  it("reschedule-only stagers refuse stageCreate; create stagers stage targetless", async () => {
    const { handle, db } = await setupDb();
    try {
      const { runId, connectorInstanceId } = addRun(db);
      const rescheduleOnly = createActionProposalStager({
        db,
        writeEnabled: true,
        events: sink() as never,
        clock: () => 1,
      });
      expect(() =>
        rescheduleOnly.stageCreate(
          runId,
          {
            title: "T",
            start: "2026-02-01T10:00:00Z",
            end: "2026-02-01T11:00:00Z",
          },
          { connectorInstanceId },
        ),
      ).toThrow(RepositoryValidationError);
      const createStager = createActionProposalStager({
        db,
        writeEnabled: true,
        createEnabled: true,
        events: sink() as never,
        clock: () => 1,
      });
      const staged = createStager.stageCreate(
        runId,
        {
          title: "T",
          start: "2026-02-01T10:00:00Z",
          end: "2026-02-01T11:00:00Z",
        },
        { connectorInstanceId },
      );
      expect(staged.tool).toBe("calendar.create");
      expect(staged.targetRefId).toBeNull();
      expect(staged.expectedRevision).toBeNull();
      // Disabled write staging still refuses even with createEnabled.
      const noWrite = createActionProposalStager({
        db,
        createEnabled: true,
        events: sink() as never,
        clock: () => 1,
      });
      expect(() =>
        noWrite.stageCreate(
          runId,
          {
            title: "T",
            start: "2026-02-01T10:00:00Z",
            end: "2026-02-01T11:00:00Z",
          },
          { connectorInstanceId },
        ),
      ).toThrow(RepositoryValidationError);
    } finally {
      await closeKernelDatabase(handle);
    }
  });

  it("one pending proposal per session spans reschedule and create", async () => {
    const { handle, db } = await setupDb();
    try {
      const { sessionId, runId } = addRun(db);
      const target = addTimedTarget(db, sessionId, runId);
      const events = sink();
      const stager = createActionProposalStager({
        db,
        writeEnabled: true,
        createEnabled: true,
        events: events as never,
        clock: () => 1,
      });
      stager.stage(runId, {
        targetRefId: target.referenceId,
        start: "2026-02-01T10:00:00Z",
        end: "2026-02-01T11:00:00Z",
      });
      const committed = stager.commitStaged(runId, 2);
      expect(committed.tool).toBe("calendar.reschedule");
      // Close the first run (one active run per session) before opening a
      // second run in the same session; the pending proposal row remains.
      db.prepare(
        "UPDATE runs SET status = 'abandoned', finished_at = 2 WHERE id = ?",
      ).run(runId);
      // Second run in the same session cannot stage create while one pending exists.
      const turn2 = generateId();
      const run2 = generateId();
      db.prepare(
        "INSERT INTO turns (id, session_id, seq, input_json, frozen_context, created_at, next_run_attempt) VALUES (?, ?, 2, '{}', '{}', 2, 1)",
      ).run(turn2, sessionId);
      db.prepare(
        "INSERT INTO runs (id, turn_id, session_id, attempt, status, strategy, event_seq, select_on_success, tool_requests_used, created_at, started_at) VALUES (?, ?, ?, 1, 'running', 's', 0, 1, 0, 2, 2)",
      ).run(run2, turn2, sessionId);
      const rm = createReferenceManager(db);
      const instanceId = rm.ensureCalendarConnectorInstance("c", "cal1", {
        now: 2,
      }).id;
      const stagedCreate = stager.stageCreate(
        run2,
        {
          title: "N",
          start: "2026-03-01T10:00:00Z",
          end: "2026-03-01T11:00:00Z",
        },
        { connectorInstanceId: instanceId },
      );
      expect(stagedCreate.tool).toBe("calendar.create");
      expect(() => stager.commitStaged(run2, 3)).toThrow(
        RepositoryValidationError,
      );
    } finally {
      await closeKernelDatabase(handle);
    }
  });
});
