// PR38 P2 review fixes (r4295943253/269/272/284/294): create-terminal regressions.
//
// - Fractional millis discriminate (.123 vs .999 unverified); equivalent
//   offsets verify; year 0099 vs 1999 does NOT verify (year-safe UTC).
// - Verified create without a durable target store throws BEFORE any
//   snapshot/resource/ref/receipt materialization (no falsely-verified rN).
// - Timed-only bodies: allDayEndExclusive true/missing/wrong-type stay
//   unverified through the direct terminal AND the full strategy.
// - U+0085 (and all C1 controls) rejected at staging; valid Unicode stages.
// - Wrong-key observations (right title/times, syntactically valid but not
//   the stable-ID-derived key) throw at the direct terminal with zero
//   pollution and stay unverified through the strategy.

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
} from "../src/index.js";

const tempRoots: string[] = [];
afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop() as string;
    rmSync(dir, { recursive: true, force: true });
  }
});

const T0 = 1_700_000_000_000;

function expectedKey(connectorId: string, stableEventId: string): string {
  return `calendar:${sha256Hex(
    JSON.stringify([connectorId, "cal1", stableEventId]),
  )}`;
}

function timedText(
  title: string,
  start: string,
  end: string,
  ...flag: [unknown?]
): string {
  const body = calendarEventBodyText({
    canonicalKey: "unused-in-text",
    status: "confirmed",
    title,
    start,
    end,
    allDayEndExclusive: false,
    sourceRevision: "src@1",
    revisionBasis: "etag",
  });
  // No flag: the natural timed body. An explicitly passed `undefined` must
  // delete the key (missing), NOT fall back to the default parameter.
  if (flag.length === 0) return body;
  const [allDay] = flag;
  if (allDay === false) return body;
  const parsed = JSON.parse(body) as Record<string, unknown>;
  if (allDay === undefined) {
    delete parsed.allDayEndExclusive;
  } else {
    parsed.allDayEndExclusive = allDay;
  }
  return JSON.stringify(parsed);
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

async function setupDirectCreate(
  db: Database.Database,
  connectorId: string,
  title: string,
  start: string,
  end: string,
  now: number,
  withTargetStore: boolean,
) {
  const sessionId = setupSession(db, now);
  const run = openRun(db, sessionId, 1, now);
  const stager = createActionProposalStager({
    db,
    writeEnabled: true,
    createEnabled: true,
    events: { appendEventTx: () => 1 } as never,
    clock: () => now,
  });
  const created = stager.stageCreate(
    run.runId,
    { title, start, end },
    { connectorInstanceId: connectorId },
  );
  const committed = stager.commitStaged(run.runId, now + 1);
  const approved = approve(
    db,
    sessionId,
    committed.proposalId,
    created.hash,
    now + 10,
  );
  const rm = createReferenceManager(db);
  const service = createActionExecutionService({
    db,
    referenceManager: rm,
    ...(withTargetStore
      ? { targetStore: createDurableCalendarTargetStore(db) }
      : {}),
    preflightRead: {
      read: async () => {
        throw new Error("create flow performs no event GET");
      },
    } as never,
    clock: () => now + 20,
  });
  service.startActionRun(approved.actionRunId, { now: now + 11 });
  const preflight = await service.runActionPreflight(approved.actionRunId);
  if (preflight.outcome !== "granted" || preflight.stableEventId === null) {
    throw new Error("create grant was not issued");
  }
  expect(preflight.stableEventId).toBe(
    deriveCreateEventId(approved.executionId),
  );
  return {
    service,
    actionRunId: approved.actionRunId,
    executionId: approved.executionId,
    stableEventId: preflight.stableEventId,
    connectorId,
  };
}

function refCount(db: Database.Database): number {
  return (
    db.prepare("SELECT COUNT(*) AS c FROM session_references").get() as {
      c: number;
    }
  ).c;
}

function resourceCountForKey(db: Database.Database, key: string): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS c FROM resources WHERE canonical_key = ?")
      .get(key) as { c: number }
  ).c;
}

async function freshDb(): Promise<{
  handle: ReturnType<typeof openKernelDatabase>;
  db: Database.Database;
  connectorId: string;
}> {
  const dir = mkdtempSync(join(tmpdir(), "m6-create-review-"));
  tempRoots.push(dir);
  const handle = openKernelDatabase(join(dir, "kernel.sqlite"));
  await migrateKernelDatabase({ db: handle.raw, backupDir: join(dir, "b") });
  const db = handle.raw;
  const connector = createReferenceManager(db).ensureCalendarConnectorInstance(
    "c",
    "cal1",
    { now: T0 },
  );
  return { handle, db, connectorId: connector.id };
}

describe("PR38 create-terminal review fixes", () => {
  it("r4295943253: .123 vs .999 stays unverified (fractional millis preserved)", async () => {
    const { handle, db, connectorId } = await freshDb();
    try {
      const title = "Millis review";
      const ctx = await setupDirectCreate(
        db,
        connectorId,
        title,
        "2026-03-01T10:00:00.123Z",
        "2026-03-01T11:00:00.123Z",
        T0,
        true,
      );
      const before = refCount(db);
      const finished = ctx.service.finishCreateExecution(
        ctx.actionRunId,
        {
          outcome: "succeeded",
          observation: {
            connectorInstanceId: connectorId,
            resourceCanonicalKey: expectedKey(connectorId, ctx.stableEventId),
            title,
            text: timedText(
              title,
              "2026-03-01T10:00:00.999Z",
              "2026-03-01T11:00:00.999Z",
            ),
            sourceRevision: ctx.stableEventId,
            eventStatus: "confirmed",
            observedAt: T0 + 20,
          },
          calendarId: "cal1",
          stableEventId: ctx.stableEventId,
        },
        { now: T0 + 21 },
      );
      expect(finished).toMatchObject({
        applied: true,
        outcome: "succeeded_unverified",
      });
      expect(refCount(db)).toBe(before);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("r4295943253: equivalent offset forms verify; year 0099 vs 1999 does not", async () => {
    const { handle, db, connectorId } = await freshDb();
    try {
      // Equivalent representation (+09:00 staged, canonical UTC observed).
      const title = "Offset review";
      const ok = await setupDirectCreate(
        db,
        connectorId,
        title,
        "2026-03-01T10:00:00+09:00",
        "2026-03-01T11:00:00+09:00",
        T0,
        true,
      );
      const before = refCount(db);
      const verified = ok.service.finishCreateExecution(
        ok.actionRunId,
        {
          outcome: "succeeded",
          observation: {
            connectorInstanceId: connectorId,
            resourceCanonicalKey: expectedKey(connectorId, ok.stableEventId),
            title,
            text: timedText(
              title,
              "2026-03-01T01:00:00.000Z",
              "2026-03-01T02:00:00.000Z",
            ),
            sourceRevision: ok.stableEventId,
            eventStatus: "confirmed",
            observedAt: T0 + 20,
          },
          calendarId: "cal1",
          stableEventId: ok.stableEventId,
        },
        { now: T0 + 21 },
      );
      expect(verified).toMatchObject({ applied: true, outcome: "succeeded" });
      expect(refCount(db)).toBe(before + 1);
      // Persisted target refreshes after reopen (durable store, same DB).
      const stored = createDurableCalendarTargetStore(db).get(
        expectedKey(connectorId, ok.stableEventId),
      );
      expect(stored).toMatchObject({
        calendarId: "cal1",
        eventId: ok.stableEventId,
      });

      // Different century, same month/day/clock: must NOT verify (the old
      // Date.UTC path mapped year 99 onto 1999 and falsely equated these).
      const ancient = await setupDirectCreate(
        db,
        connectorId,
        "Ancient review",
        "0099-01-01T10:00:00Z",
        "0099-01-01T11:00:00Z",
        T0 + 100,
        true,
      );
      const beforeAncient = refCount(db);
      const drifted = ancient.service.finishCreateExecution(
        ancient.actionRunId,
        {
          outcome: "succeeded",
          observation: {
            connectorInstanceId: connectorId,
            resourceCanonicalKey: expectedKey(
              connectorId,
              ancient.stableEventId,
            ),
            title: "Ancient review",
            text: timedText(
              "Ancient review",
              "1999-01-01T10:00:00Z",
              "1999-01-01T11:00:00Z",
            ),
            sourceRevision: ancient.stableEventId,
            eventStatus: "confirmed",
            observedAt: T0 + 120,
          },
          calendarId: "cal1",
          stableEventId: ancient.stableEventId,
        },
        { now: T0 + 121 },
      );
      expect(drifted).toMatchObject({
        applied: true,
        outcome: "succeeded_unverified",
      });
      expect(refCount(db)).toBe(beforeAncient);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("r4295943269: verified create without a target store throws before any materialization", async () => {
    const { handle, db, connectorId } = await freshDb();
    try {
      const title = "No store review";
      const ctx = await setupDirectCreate(
        db,
        connectorId,
        title,
        "2026-03-01T10:00:00Z",
        "2026-03-01T11:00:00Z",
        T0,
        false,
      );
      const before = refCount(db);
      expect(() =>
        ctx.service.finishCreateExecution(
          ctx.actionRunId,
          {
            outcome: "succeeded",
            observation: {
              connectorInstanceId: connectorId,
              resourceCanonicalKey: expectedKey(connectorId, ctx.stableEventId),
              title,
              text: timedText(
                title,
                "2026-03-01T10:00:00Z",
                "2026-03-01T11:00:00Z",
              ),
              sourceRevision: ctx.stableEventId,
              eventStatus: "confirmed",
              observedAt: T0 + 20,
            },
            calendarId: "cal1",
            stableEventId: ctx.stableEventId,
          },
          { now: T0 + 21 },
        ),
      ).toThrow(RepositoryValidationError);
      // No snapshot/resource/ref/success receipt was materialized.
      expect(refCount(db)).toBe(before);
      expect(
        resourceCountForKey(db, expectedKey(connectorId, ctx.stableEventId)),
      ).toBe(0);
      expect(ctx.service.getActionRunView(ctx.actionRunId).receipt).toBeNull();
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("r4295943272: allDay true/missing/wrong-type bodies stay unverified at the terminal", async () => {
    const { handle, db, connectorId } = await freshDb();
    try {
      const title = "Timed review";
      for (const flag of [true, undefined, "false"] as const) {
        const ctx = await setupDirectCreate(
          db,
          connectorId,
          `${title} ${String(flag)}`,
          "2026-03-01T10:00:00Z",
          "2026-03-01T11:00:00Z",
          T0 + refCount(db),
          true,
        );
        const name = `${title} ${String(flag)}`;
        const before = refCount(db);
        const finished = ctx.service.finishCreateExecution(
          ctx.actionRunId,
          {
            outcome: "succeeded",
            observation: {
              connectorInstanceId: connectorId,
              resourceCanonicalKey: expectedKey(connectorId, ctx.stableEventId),
              title: name,
              text: timedText(
                name,
                "2026-03-01T10:00:00Z",
                "2026-03-01T11:00:00Z",
                flag,
              ),
              sourceRevision: ctx.stableEventId,
              eventStatus: "confirmed",
              observedAt: T0 + 20,
            },
            calendarId: "cal1",
            stableEventId: ctx.stableEventId,
          },
          { now: T0 + 21 },
        );
        expect(finished).toMatchObject({
          applied: true,
          outcome: "succeeded_unverified",
        });
        expect(refCount(db)).toBe(before);
      }
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("r4295943272+r4295943294: strategy stays unverified on allDay bodies and wrong keys", async () => {
    async function driveStrategy(
      text: string,
      keyFor: (connectorId: string, stableEventId: string) => string,
    ): Promise<{
      outcome: string | undefined;
      inserts: number;
      refs: number;
      wrongKey: string | null;
    }> {
      const { handle, db, connectorId } = await freshDb();
      try {
        const title = "Strategy review";
        const sessionId = setupSession(db, T0);
        const run = openRun(db, sessionId, 1, T0);
        const stager = createActionProposalStager({
          db,
          writeEnabled: true,
          createEnabled: true,
          events: { appendEventTx: () => 1 } as never,
          clock: () => T0,
        });
        const created = stager.stageCreate(
          run.runId,
          {
            title,
            start: "2026-03-01T10:00:00Z",
            end: "2026-03-01T11:00:00Z",
          },
          { connectorInstanceId: connectorId },
        );
        const committed = stager.commitStaged(run.runId, T0 + 1);
        const approved = approve(
          db,
          sessionId,
          committed.proposalId,
          created.hash,
          T0 + 10,
        );
        const before = refCount(db);
        let inserts = 0;
        const createWritePort: CalendarCreateWritePort = {
          capability: {
            tool: "calendar.create",
            editableFields: ["title", "start", "end"],
            connectorInstanceId: connectorId,
            writeEnabled: true,
          },
          insert: async () => {
            inserts += 1;
            return { status: "succeeded" };
          },
        };
        const service = createActionExecutionService({
          db,
          referenceManager: createReferenceManager(db),
          targetStore: createDurableCalendarTargetStore(db),
          preflightRead: {
            read: async () => {
              throw new Error("no GET");
            },
          } as never,
          clock: () => T0 + 20,
        });
        let wrongKey: string | null = null;
        const strategy = createActionStrategy({
          db,
          service,
          preflightRead: {
            read: async () => {
              throw new Error("no GET");
            },
          } as never,
          createWritePort,
          createRead: {
            read: async (request: { stableEventId: string }) => {
              const key = keyFor(connectorId, request.stableEventId);
              if (key !== expectedKey(connectorId, request.stableEventId)) {
                wrongKey = key;
              }
              return {
                status: "ok" as const,
                observation: {
                  connectorInstanceId: connectorId,
                  resourceCanonicalKey: key,
                  eventStatus: "confirmed" as const,
                  title,
                  text,
                  sourceRevision: request.stableEventId,
                  observedAt: T0 + 20,
                },
              };
            },
          } as never,
          createSelection: { calendarId: "cal1" },
        });
        await strategy({
          run: { id: approved.actionRunId },
          signal: new AbortController().signal,
        } as unknown as Parameters<typeof strategy>[0]);
        const outcome = service.getActionRunView(approved.actionRunId).receipt
          ?.outcome;
        if (wrongKey !== null) {
          expect(
            createDurableCalendarTargetStore(db).get(wrongKey),
          ).toBeUndefined();
          expect(resourceCountForKey(db, wrongKey)).toBe(0);
        }
        return { outcome, inserts, refs: refCount(db) - before, wrongKey };
      } finally {
        closeKernelDatabase(handle);
      }
    }
    // allDayEndExclusive: true with right title/times/key -> unverified.
    const timed = await driveStrategy(
      timedText(
        "Strategy review",
        "2026-03-01T10:00:00Z",
        "2026-03-01T11:00:00Z",
      ),
      (c, s) => expectedKey(c, s),
    );
    expect(timed.outcome).toBe("succeeded");
    expect(timed.inserts).toBe(1);
    expect(timed.refs).toBe(1);
    const allDay = await driveStrategy(
      timedText(
        "Strategy review",
        "2026-03-01T10:00:00Z",
        "2026-03-01T11:00:00Z",
        true,
      ),
      (c, s) => expectedKey(c, s),
    );
    expect(allDay.outcome).toBe("succeeded_unverified");
    expect(allDay.inserts).toBe(1);
    expect(allDay.refs).toBe(0);
    // Right title/times but a merely syntactic calendar:hash -> unverified,
    // exactly one POST, no ref, and no target mapping for the wrong key.
    const wrong = await driveStrategy(
      timedText(
        "Strategy review",
        "2026-03-01T10:00:00Z",
        "2026-03-01T11:00:00Z",
      ),
      () => `calendar:${"cd".repeat(32)}`,
    );
    expect(wrong.outcome).toBe("succeeded_unverified");
    expect(wrong.inserts).toBe(1);
    expect(wrong.refs).toBe(0);
    expect(wrong.wrongKey).toBe(`calendar:${"cd".repeat(32)}`);
  });

  it("r4295943294: wrong derived key throws at the terminal with zero pollution", async () => {
    const { handle, db, connectorId } = await freshDb();
    try {
      const title = "Key review";
      const ctx = await setupDirectCreate(
        db,
        connectorId,
        title,
        "2026-03-01T10:00:00Z",
        "2026-03-01T11:00:00Z",
        T0,
        true,
      );
      const wrongKey = `calendar:${"ab".repeat(32)}`;
      const before = refCount(db);
      expect(() =>
        ctx.service.finishCreateExecution(
          ctx.actionRunId,
          {
            outcome: "succeeded",
            observation: {
              connectorInstanceId: connectorId,
              resourceCanonicalKey: wrongKey,
              title,
              text: timedText(
                title,
                "2026-03-01T10:00:00Z",
                "2026-03-01T11:00:00Z",
              ),
              sourceRevision: ctx.stableEventId,
              eventStatus: "confirmed",
              observedAt: T0 + 20,
            },
            calendarId: "cal1",
            stableEventId: ctx.stableEventId,
          },
          { now: T0 + 21 },
        ),
      ).toThrow(RepositoryValidationError);
      expect(refCount(db)).toBe(before);
      expect(resourceCountForKey(db, wrongKey)).toBe(0);
      expect(ctx.service.getActionRunView(ctx.actionRunId).receipt).toBeNull();
      expect(
        createDurableCalendarTargetStore(db).get(wrongKey),
      ).toBeUndefined();
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("r4295943284: U+0085 and C1 controls rejected at staging; valid Unicode stages", async () => {
    const { handle, db, connectorId } = await freshDb();
    try {
      const { runId } = (() => {
        const sessionId = setupSession(db, T0);
        return { runId: openRun(db, sessionId, 1, T0).runId };
      })();
      const stager = createActionProposalStager({
        db,
        writeEnabled: true,
        createEnabled: true,
        events: { appendEventTx: () => 1 } as never,
        clock: () => T0,
      });
      const input = (title: string) => ({
        title,
        start: "2026-03-01T10:00:00Z",
        end: "2026-03-01T11:00:00Z",
      });
      expect(() =>
        stager.stageCreate(runId, input("\u0085"), {
          connectorInstanceId: connectorId,
        }),
      ).toThrow(RepositoryValidationError);
      expect(() =>
        stager.stageCreate(runId, input("a\u0085b"), {
          connectorInstanceId: connectorId,
        }),
      ).toThrow(RepositoryValidationError);
      expect(() =>
        stager.stageCreate(runId, input("a\u0001b"), {
          connectorInstanceId: connectorId,
        }),
      ).toThrow(RepositoryValidationError);
      const staged = stager.stageCreate(runId, input("日本語 🎉 café"), {
        connectorInstanceId: connectorId,
      });
      expect(staged.tool).toBe("calendar.create");
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
