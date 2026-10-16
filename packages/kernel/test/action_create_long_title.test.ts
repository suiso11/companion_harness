// F1: full-authoritative-title verification (never the 128-bounded display).
//
// - 129-char approved title with the CORRECT full body verifies (the old
//   display-title compare falsely left this `succeeded_unverified`).
// - Same 128-char prefix with a WRONG final char stays `succeeded_unverified`
//   with no new rN (no false verified claim via prefix truncation).
// - Short title where the DISPLAY field matches but the canonical JSON text
//   title drifted stays `succeeded_unverified` through the full strategy AND
//   through a direct `finishCreateExecution` terminal call that bypasses the
//   strategy pre-verify (proves the terminal re-verifies fail-closed too).

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveCreateEventId } from "@companion/contracts";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createActionExecutionService } from "../src/action_executions.js";
import { createActionProposalStager } from "../src/action_proposals.js";
import {
  type CalendarCreateWritePort,
  createActionStrategy,
} from "../src/action_strategy.js";
import {
  authoritativeCreateTitleMatches,
  calendarEventBodyText,
} from "../src/calendar_tools.js";
import { generateId } from "../src/canonical.js";
import {
  closeKernelDatabase,
  createKernelRepository,
  createReferenceManager,
  migrateKernelDatabase,
  openKernelDatabase,
} from "../src/index.js";

const tempRoots: string[] = [];
afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop() as string;
    rmSync(dir, { recursive: true, force: true });
  }
});

const T0 = 1_700_000_000_000;
const CREATE_START = "2026-03-01T10:00:00Z";
const CREATE_END = "2026-03-01T11:00:00Z";
const LONG_TITLE = `${"A".repeat(128)}B`;
const LONG_TITLE_WRONG_SUFFIX = `${"A".repeat(128)}C`;
const SHORT_TITLE = "Short create title";

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

function setupSession(db: Database.Database, now: number): string {
  const sessionId = generateId();
  db.prepare(
    "INSERT INTO sessions (id, created_at, last_active_at, next_turn_position) VALUES (?, ?, ?, 1)",
  ).run(sessionId, now, now);
  db.prepare(
    "INSERT INTO session_reference_context (session_id, version, items_json, updated_at) VALUES (?, 1, '[]', ?)",
  ).run(sessionId, now);
  return sessionId;
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
  db.prepare(
    "UPDATE sessions SET next_turn_position = ? WHERE id = ? AND next_turn_position <= ?",
  ).run(seq + 1, sessionId, seq);
  db.prepare(
    "INSERT INTO runs (id, turn_id, session_id, attempt, status, strategy, event_seq, select_on_success, tool_requests_used, created_at, started_at) VALUES (?, ?, ?, 1, 'running', 's', 0, 1, 0, ?, ?)",
  ).run(runId, turnId, sessionId, now, now);
  return { turnId, runId };
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
  if (accepted.status !== 202) throw new Error("approve did not accept");
  const row = db
    .prepare(
      "SELECT id, action_run_id FROM action_executions WHERE proposal_id = ?",
    )
    .get(proposalId) as { id: string; action_run_id: string };
  return { executionId: row.id, actionRunId: row.action_run_id };
}

function bodyText(stableEventId: string, title: string): string {
  return calendarEventBodyText({
    canonicalKey: `calendar:${stableEventId}${"0".repeat(32)}`,
    status: "confirmed",
    title,
    start: CREATE_START,
    end: CREATE_END,
    allDayEndExclusive: true,
    sourceRevision: stableEventId,
    revisionBasis: "etag",
  });
}

/** Drive one approved create run through the REAL strategy with a fixed read-back. */
async function driveCreate(
  db: Database.Database,
  connectorId: string,
  actionRunId: string,
  inserts: Array<{ stableEventId: string; title: string }>,
  readback: (stableEventId: string) => {
    title: string | null;
    text: string;
  },
  now: number,
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
    read: async (request: { stableEventId: string }) => ({
      status: "ok" as const,
      observation: {
        connectorInstanceId: connectorId,
        resourceCanonicalKey: `calendar:${request.stableEventId}${"0".repeat(32)}`,
        eventStatus: "confirmed" as const,
        ...readback(request.stableEventId),
        sourceRevision: request.stableEventId,
        observedAt: now,
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

async function setupApprovedCreate(
  db: Database.Database,
  connectorId: string,
  title: string,
  now: number,
): Promise<{ actionRunId: string; executionId: string }> {
  const sessionId = setupSession(db, now);
  const run = openRun(db, sessionId, 1, now);
  const stager = createActionProposalStager({
    db,
    writeEnabled: true,
    createEnabled: true,
    events: sink() as never,
    clock: () => now,
  });
  const created = stager.stageCreate(
    run.runId,
    { title, start: CREATE_START, end: CREATE_END },
    { connectorInstanceId: connectorId },
  );
  const committed = stager.commitStaged(run.runId, now + 1);
  return approve(db, sessionId, committed.proposalId, created.hash, now + 10);
}

function refCount(db: Database.Database): number {
  return (
    db.prepare("SELECT COUNT(*) AS c FROM session_references").get() as {
      c: number;
    }
  ).c;
}

describe("create verifies the FULL authoritative text title (F1)", () => {
  it("verifies a correct 129-char title (display truncation must not unverified it)", async () => {
    expect(LONG_TITLE.length).toBe(129);
    const dir = mkdtempSync(join(tmpdir(), "m6-create-long-"));
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
      const approved = await setupApprovedCreate(
        db,
        connector.id,
        LONG_TITLE,
        T0,
      );
      const before = refCount(db);
      const inserts: Array<{ stableEventId: string; title: string }> = [];
      const view = await driveCreate(
        db,
        connector.id,
        approved.actionRunId,
        inserts,
        (stableEventId) => ({
          // Display contract stays bounded at 128; the canonical text keeps all 129.
          title: LONG_TITLE.slice(0, 128),
          text: bodyText(stableEventId, LONG_TITLE),
        }),
        T0 + 20,
      );
      expect(view.receipt?.outcome).toBe("succeeded");
      expect(inserts).toHaveLength(1);
      expect(refCount(db)).toBe(before + 1);
      // The fresh citation body binds the FULL title, not the card truncation.
      const latestBody = db
        .prepare(
          "SELECT s.body_json AS bodyJson FROM session_references r JOIN resource_snapshots s ON s.id = r.snapshot_id ORDER BY r.ordinal DESC LIMIT 1",
        )
        .get() as { bodyJson: string } | undefined;
      expect(latestBody?.bodyJson).toContain(LONG_TITLE);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("leaves a same-128-prefix wrong-suffix 129-char read-back unverified", async () => {
    const dir = mkdtempSync(join(tmpdir(), "m6-create-long-"));
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
      const approved = await setupApprovedCreate(
        db,
        connector.id,
        LONG_TITLE,
        T0,
      );
      const before = refCount(db);
      const inserts: Array<{ stableEventId: string; title: string }> = [];
      const view = await driveCreate(
        db,
        connector.id,
        approved.actionRunId,
        inserts,
        (stableEventId) => ({
          title: LONG_TITLE_WRONG_SUFFIX.slice(0, 128),
          text: bodyText(stableEventId, LONG_TITLE_WRONG_SUFFIX),
        }),
        T0 + 20,
      );
      expect(view.receipt?.outcome).toBe("succeeded_unverified");
      expect(inserts).toHaveLength(1);
      expect(refCount(db)).toBe(before);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("fails closed when the display title matches but the authoritative text title drifted", async () => {
    // Unit shape: the shared helper never consults the display field, so a
    // matching display + drifted text is false; malformed/missing/non-string
    // text titles are false too (no truncation fallback).
    expect(
      authoritativeCreateTitleMatches(
        bodyText("s", SHORT_TITLE),
        SHORT_TITLE.normalize("NFC"),
      ),
    ).toBe(true);
    expect(
      authoritativeCreateTitleMatches(
        bodyText("s", "Drifted title"),
        SHORT_TITLE.normalize("NFC"),
      ),
    ).toBe(false);
    expect(
      authoritativeCreateTitleMatches("not-json", SHORT_TITLE.normalize("NFC")),
    ).toBe(false);
    expect(
      authoritativeCreateTitleMatches(
        JSON.stringify({ start: 1 }),
        SHORT_TITLE.normalize("NFC"),
      ),
    ).toBe(false);

    // Full strategy: display correct, text drifted -> unverified, no new rN.
    const dir = mkdtempSync(join(tmpdir(), "m6-create-drift-"));
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
      const approved = await setupApprovedCreate(
        db,
        connector.id,
        SHORT_TITLE,
        T0,
      );
      const before = refCount(db);
      const inserts: Array<{ stableEventId: string; title: string }> = [];
      const view = await driveCreate(
        db,
        connector.id,
        approved.actionRunId,
        inserts,
        (stableEventId) => ({
          title: SHORT_TITLE,
          text: bodyText(stableEventId, "Drifted title"),
        }),
        T0 + 20,
      );
      expect(view.receipt?.outcome).toBe("succeeded_unverified");
      expect(inserts).toHaveLength(1);
      expect(refCount(db)).toBe(before);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("terminal re-verifies fail-closed when the strategy pre-verify is bypassed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "m6-create-terminal-"));
    tempRoots.push(dir);
    const handle = openKernelDatabase(join(dir, "kernel.sqlite"));
    try {
      await migrateKernelDatabase({
        db: handle.raw,
        backupDir: join(dir, "b"),
      });
      const db = handle.raw;
      const rm = createReferenceManager(db);
      const connector = rm.ensureCalendarConnectorInstance("c", "cal1", {
        now: T0,
      });
      const approved = await setupApprovedCreate(
        db,
        connector.id,
        SHORT_TITLE,
        T0,
      );
      const before = refCount(db);
      const dummyPreflightRead = {
        read: async () => {
          throw new Error("create flow performs no event GET");
        },
      };
      const service = createActionExecutionService({
        db,
        referenceManager: rm,
        preflightRead: dummyPreflightRead as never,
        clock: () => T0 + 20,
      });
      // Move the run to executing WITHOUT the strategy (pickup + grant gate
      // commits the external-call marker, derives the stable insert id).
      service.startActionRun(approved.actionRunId, { now: T0 + 11 });
      const preflight = await service.runActionPreflight(approved.actionRunId);
      if (preflight.outcome !== "granted" || preflight.stableEventId === null) {
        throw new Error("create grant was not issued");
      }
      const stableEventId = preflight.stableEventId;
      expect(stableEventId).toBe(deriveCreateEventId(approved.executionId));
      // Bypass the strategy: hand the terminal a display-matching but
      // text-drifted observation directly. It must NOT verify.
      const finished = service.finishCreateExecution(
        approved.actionRunId,
        {
          outcome: "succeeded",
          observation: {
            connectorInstanceId: connector.id,
            resourceCanonicalKey: `calendar:${stableEventId}${"0".repeat(32)}`,
            title: SHORT_TITLE,
            text: bodyText(stableEventId, "Drifted title"),
            sourceRevision: stableEventId,
            eventStatus: "confirmed",
            observedAt: T0 + 20,
          },
          calendarId: "cal1",
          stableEventId,
        },
        { now: T0 + 21 },
      );
      expect(finished).toMatchObject({
        applied: true,
        outcome: "succeeded_unverified",
      });
      expect(refCount(db)).toBe(before);
      expect(
        service.getActionRunView(approved.actionRunId).receipt?.outcome,
      ).toBe("succeeded_unverified");
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
