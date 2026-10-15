// C17 focused service invariants for the calendar.reschedule proposal
// stager (`createActionProposalStager`): write-enabled gating, running-run
// check, exact Calendar target binding, fresh (non-deleted) snapshot,
// start<end timed/all-day range semantics, deterministic canonical hash,
// one-staged-per-run TTL, transaction-scoped commit, one-pending-per-session
// revalidation, and abort/discard semantics.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SnapshotBodySchema } from "@companion/contracts";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { ActionProposalEventSink } from "../src/action_proposals.js";
import { createActionProposalStager } from "../src/action_proposals.js";
import { calendarEventBodyText } from "../src/calendar_tools.js";
import {
  canonicalJsonString,
  generateId,
  sha256Hex,
} from "../src/canonical.js";
import {
  RepositoryNotFoundError,
  RepositoryValidationError,
} from "../src/errors.js";
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

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
);

function makeSink(): ActionProposalEventSink & {
  events: Array<{ runId: string; type: string; payload: unknown }>;
  seq: number;
} {
  const events: Array<{ runId: string; type: string; payload: unknown }> = [];
  return {
    events,
    seq: 0,
    appendEventTx(runId, expectedPrevSeq, type, payload, now) {
      this.seq = expectedPrevSeq + 1;
      events.push({ runId, type, payload });
      void now;
      return this.seq;
    },
  };
}

/**
 * Real normalized event text (the exact document ReferenceManager stores
 * inside the SnapshotBody wrapper). Never hand-written JSON.
 */
const TEST_EVENT_TEXT = calendarEventBodyText({
  canonicalKey: "cal|cal1|evt1",
  status: "confirmed",
  title: "Event",
  start: "2026-01-01T10:00:00Z",
  end: "2026-01-01T11:00:00Z",
  allDayEndExclusive: true,
  sourceRevision: "src@1",
  revisionBasis: "etag",
});

const TEST_EVENT_DELETED_TEXT = calendarEventBodyText({
  canonicalKey: "cal|cal1|evt1",
  status: "deleted",
  title: "Event",
  start: "2026-01-01T10:00:00Z",
  end: "2026-01-01T11:00:00Z",
  allDayEndExclusive: true,
  sourceRevision: "src@1",
  revisionBasis: "etag",
});

/** The exact stored `body_json` shape ReferenceManager writes. */
function snapshotBodyJson(text: string): string {
  return canonicalJsonString(SnapshotBodySchema.parse({ version: 1, text }));
}

interface Fixture {
  readonly handle: ReturnType<typeof openKernelDatabase>;
  db: Database.Database;
  sessionId: string;
  runId: string;
  refId: string;
  resourceId: string;
  snapshotId: string;
}

async function setupFixture(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "c17-stager-"));
  tempRoots.push(dir);
  const handle = openKernelDatabase(join(dir, "kernel.sqlite"));
  const db = handle.raw;
  const result = await migrateKernelDatabase({
    db,
    targetVersion: BUNDLED_SCHEMA_VERSION,
    migrationsDir: MIGRATIONS_DIR,
  });
  if (result.toVersion !== BUNDLED_SCHEMA_VERSION) {
    await closeKernelDatabase(handle);
    throw new Error("migration failed");
  }

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
  // REAL ReferenceManager observation: this is the exact write path that
  // stores `resource_snapshots.body_json` as a SnapshotBody wrapper
  // `{ version: 1, text }`. The fixture never hand-inserts a snapshot.
  const referenceManager = createReferenceManager(db);
  const connector = referenceManager.ensureCalendarConnectorInstance(
    "c",
    "cal1",
    { now: 1 },
  );
  const presented = referenceManager.presentObservations(
    sessionId,
    runId,
    [
      {
        connectorInstanceId: connector.id,
        canonicalKey: "cal|cal1|evt1",
        title: "Event",
        text: TEST_EVENT_TEXT,
        sourceRevision: "src@1",
        observedAt: 1,
      },
    ],
    { freshness: "normal", now: 1 },
  );
  if (!presented.applied || presented.references.length !== 1) {
    throw new Error("reference observation was not applied");
  }
  const stored = presented.references[0];
  if (stored === undefined) {
    throw new Error("no presented reference");
  }
  return {
    handle,
    db,
    sessionId,
    runId,
    refId: stored.referenceId,
    resourceId: stored.resourceId,
    snapshotId: stored.snapshotId,
  };
}

const TIMED = { start: "2026-02-01T10:00:00Z", end: "2026-02-01T11:00:00Z" };

function makeStager(
  fx: Fixture,
  clock: () => number,
): {
  stager: ReturnType<typeof createActionProposalStager>;
  sink: ReturnType<typeof makeSink>;
} {
  const sink = makeSink();
  const stager = createActionProposalStager({
    db: fx.db,
    writeEnabled: true,
    events: sink,
    clock,
  });
  return { stager, sink };
}

describe("action proposal stager", () => {
  it("refuses staging and committing when writeEnabled is not explicitly true", async () => {
    const fx = await setupFixture();
    try {
      const stager = createActionProposalStager({
        db: fx.db,
        events: makeSink(),
        clock: () => 1000,
      });
      expect(() =>
        stager.stage(fx.runId, { targetRefId: fx.refId, ...TIMED }),
      ).toThrow(RepositoryValidationError);
    } finally {
      await closeKernelDatabase(fx.handle);
    }
  });

  it("reads the stored SnapshotBody wrapper text produced by the real ReferenceManager", async () => {
    const fx = await setupFixture();
    try {
      // The stored row is the SnapshotBody wrapper, NOT the raw event: the
      // stager must unwrap `.text` and strictly parse that document.
      const row = fx.db
        .prepare("SELECT body_json FROM resource_snapshots WHERE id = ?")
        .get(fx.snapshotId) as { body_json: string };
      const wrapper = SnapshotBodySchema.parse(
        JSON.parse(row.body_json) as unknown,
      );
      expect(JSON.parse(wrapper.text)).toMatchObject({
        status: "confirmed",
        start: "2026-01-01T10:00:00Z",
        end: "2026-01-01T11:00:00Z",
      });
      const { stager } = makeStager(fx, () => 1000);
      expect(
        stager.stage(fx.runId, { targetRefId: fx.refId, ...TIMED }),
      ).toMatchObject({
        basedOnSnapshotId: fx.snapshotId,
        expectedRevision: "src@1",
      });
      stager.removeStaged(fx.runId);
      // A RAW event body stored where the wrapper belongs is rejected: no
      // guessing of alternate stored shapes.
      fx.db
        .prepare("UPDATE resource_snapshots SET body_json = ? WHERE id = ?")
        .run(
          canonicalJsonString(JSON.parse(wrapper.text) as object),
          fx.snapshotId,
        );
      expect(() =>
        stager.stage(fx.runId, { targetRefId: fx.refId, ...TIMED }),
      ).toThrow(/stored SnapshotBody/);
    } finally {
      closeKernelDatabase(fx.handle);
    }
  });

  it("stages with concrete prechecks, deterministic hash, and a target-aware provider-id-free preview", async () => {
    const fx = await setupFixture();
    try {
      const { stager } = makeStager(fx, () => 1000);
      const a = stager.stage(fx.runId, { targetRefId: fx.refId, ...TIMED });
      expect(a.tool).toBe("calendar.reschedule");
      expect(a.input).toEqual(TIMED);
      // Target-aware human preview: immutable normalized title + session rN
      // + staged range; no tool-name prefix, no raw ids.
      expect(a.preview.summary).toContain("Event");
      expect(a.preview.summary).toContain("(r1)");
      expect(a.preview.summary).toContain(`start=${TIMED.start}`);
      expect(a.preview.summary).toContain(`end=${TIMED.end}`);
      expect(a.preview.summary).not.toContain("calendar.reschedule");
      expect(a.preview.summary).not.toContain(fx.refId);
      expect(a.preview.summary).not.toContain(fx.resourceId);
      expect(a.preview.summary).not.toContain(fx.snapshotId);
      const expectedHash = sha256Hex(
        canonicalJsonString({
          tool: "calendar.reschedule",
          input: TIMED,
          target: {
            refId: fx.refId,
            resourceId: fx.resourceId,
            snapshotId: fx.snapshotId,
          },
          expectedRevision: "src@1",
          preview: a.preview,
        }),
      );
      expect(a.hash).toBe(expectedHash);
      expect(a.expiresAt).toBe(a.createdAt + 15 * 60 * 1000);
      expect(stager.getStaged(fx.runId)).not.toBeNull();
    } finally {
      await closeKernelDatabase(fx.handle);
    }
  });

  it("preview tracks the immutable normalized title and session rN, stays plaintext, and leaks no provider content", async () => {
    const fx = await setupFixture();
    try {
      // Retitle the frozen normalized event (plus a description that must
      // never leak) through a fresh observation on the SAME resource.
      const referenceManager = createReferenceManager(fx.db);
      const connector = referenceManager.ensureCalendarConnectorInstance(
        "c",
        "cal1",
        { now: 2 },
      );
      const evilTitle = "Standup\n<b>bold</b>\troom";
      const retitled = calendarEventBodyText({
        canonicalKey: "cal|cal1|evt1",
        status: "confirmed",
        title: evilTitle,
        start: "2026-01-01T10:00:00Z",
        end: "2026-01-01T11:00:00Z",
        allDayEndExclusive: true,
        sourceRevision: "src@2",
        revisionBasis: "etag",
      });
      const presented = referenceManager.presentObservations(
        fx.sessionId,
        fx.runId,
        [
          {
            connectorInstanceId: connector.id,
            canonicalKey: "cal|cal1|evt1",
            title: evilTitle,
            text: retitled,
            sourceRevision: "src@2",
            observedAt: 2,
          },
        ],
        { freshness: "normal", now: 2 },
      );
      expect(presented.applied).toBe(true);
      // A changed revision materializes a new snapshot + a new session rN.
      const currentRefs = fx.db
        .prepare(
          "SELECT id, ordinal FROM session_references WHERE session_id = ? ORDER BY ordinal ASC",
        )
        .all(fx.sessionId) as Array<{ id: string; ordinal: number }>;
      expect(currentRefs).toHaveLength(2);
      const latest = currentRefs[currentRefs.length - 1] as {
        id: string;
        ordinal: number;
      };
      expect(latest.ordinal).toBe(2);
      const refId = latest.id;
      const { stager } = makeStager(fx, () => 3000);
      const staged = stager.stage(fx.runId, {
        targetRefId: refId,
        ...TIMED,
      });
      // Plaintext single line: raw newlines/tabs collapse to spaces (the
      // client renders via textContent, so any residual markup stays inert).
      expect(staged.preview.summary).not.toMatch(/[\n\r\t]/);
      // The session rN tracks the CURRENT ordinal, not a stale r1.
      expect(staged.preview.summary).toContain("(r2)");
      expect(staged.preview.summary).toContain("Standup");
      expect(staged.preview.summary).toContain("bold");
      // Privacy: description/location/provider ids never appear.
      expect(staged.preview.summary).not.toContain("cal|cal1|evt1");
      expect(staged.preview.summary).not.toContain("src@2");
      expect(staged.preview.summary).not.toContain(staged.targetRefId);
      expect(staged.preview.summary).not.toContain(staged.targetResourceId);
      expect(staged.preview.summary).not.toContain(staged.basedOnSnapshotId);
      expect(staged.preview.summary).not.toContain(staged.connectorInstanceId);
      expect(staged.preview.summary.length).toBeLessThanOrEqual(1024);
    } finally {
      await closeKernelDatabase(fx.handle);
    }
  });

  it("keeps a tool-prefixed event title whole: unambiguous marker defeats the legacy strip", async () => {
    const fx = await setupFixture();
    try {
      // An adversarial normalized title that begins with the LEGACY stored-
      // preview prefix: the new preview must still carry it in FULL, with the
      // fixed marker at position 0 so receipt/history renderers never mistake
      // it for the legacy prefix and cut the real title.
      const adversarialTitle = "calendar.reschedule: quarterly planning";
      const referenceManager = createReferenceManager(fx.db);
      const connector = referenceManager.ensureCalendarConnectorInstance(
        "c",
        "cal1",
        { now: 2 },
      );
      const retitled = calendarEventBodyText({
        canonicalKey: "cal|cal1|evt1",
        status: "confirmed",
        title: adversarialTitle,
        start: "2026-01-01T10:00:00Z",
        end: "2026-01-01T11:00:00Z",
        allDayEndExclusive: true,
        sourceRevision: "src@2",
        revisionBasis: "etag",
      });
      const presented = referenceManager.presentObservations(
        fx.sessionId,
        fx.runId,
        [
          {
            connectorInstanceId: connector.id,
            canonicalKey: "cal|cal1|evt1",
            title: adversarialTitle,
            text: retitled,
            sourceRevision: "src@2",
            observedAt: 2,
          },
        ],
        { freshness: "normal", now: 2 },
      );
      expect(presented.applied).toBe(true);
      const currentRefs = fx.db
        .prepare(
          "SELECT id, ordinal FROM session_references WHERE session_id = ? ORDER BY ordinal ASC",
        )
        .all(fx.sessionId) as Array<{ id: string; ordinal: number }>;
      const latest = currentRefs[currentRefs.length - 1] as {
        id: string;
        ordinal: number;
      };
      expect(latest.ordinal).toBe(2);
      const { stager } = makeStager(fx, () => 3000);
      const staged = stager.stage(fx.runId, {
        targetRefId: latest.id,
        ...TIMED,
      });
      // The whole title survives verbatim, behind the unambiguous marker.
      expect(staged.preview.summary.startsWith("対象イベント: ")).toBe(true);
      expect(staged.preview.summary).toContain(adversarialTitle);
      expect(staged.preview.summary).toContain("(r2)");
      // Never at position 0: the legacy tool-prefix strip cannot trigger.
      expect(staged.preview.summary.startsWith("calendar.reschedule:")).toBe(
        false,
      );
      expect(staged.preview.summary).not.toMatch(/[\n\r\t]/);
      expect(staged.preview.summary.length).toBeLessThanOrEqual(1024);
    } finally {
      await closeKernelDatabase(fx.handle);
    }
  });

  it("rejects:  non-running run, non-calendar target, deleted snapshot, mixed boundary classes, inverted range", async () => {
    const fx = await setupFixture();
    try {
      const { stager } = makeStager(fx, () => 1000);
      // Non-calendar target.
      const nonCalId = generateId();
      const otherResource = generateId();
      const otherRef = generateId();
      const otherSnap = generateId();
      fx.db
        .prepare(
          "INSERT INTO connector_instances (id, kind, display_name, config_json, created_at) VALUES (?, 'model', 'm', '{}', 1)",
        )
        .run(nonCalId);
      fx.db
        .prepare(
          "INSERT INTO resources (id, connector_instance_id, canonical_key, title, next_revision, created_at) VALUES (?, ?, 'md|x', 'X', 1, 1)",
        )
        .run(otherResource, nonCalId);
      fx.db
        .prepare(
          "INSERT INTO resource_snapshots (id, resource_id, revision, source_revision, content_hash, body_json, size_bytes, observed_at, created_at) VALUES (?, ?, 1, 's2', 'h2', '{}', 2, 1, 1)",
        )
        .run(otherSnap, otherResource);
      fx.db
        .prepare(
          "INSERT INTO session_references (id, session_id, ordinal, resource_id, snapshot_id, created_at) VALUES (?, ?, 2, ?, ?, 1)",
        )
        .run(otherRef, fx.sessionId, otherResource, otherSnap);
      expect(() =>
        stager.stage(fx.runId, { targetRefId: otherRef, ...TIMED }),
      ).toThrow(/Calendar connector/);
      // Deleted snapshot.
      fx.db
        .prepare("UPDATE resource_snapshots SET body_json = ? WHERE id = ?")
        .run(snapshotBodyJson(TEST_EVENT_DELETED_TEXT), fx.snapshotId);
      expect(() =>
        stager.stage(fx.runId, { targetRefId: fx.refId, ...TIMED }),
      ).toThrow(/deleted/);
      fx.db
        .prepare("UPDATE resource_snapshots SET body_json = ? WHERE id = ?")
        .run(snapshotBodyJson(TEST_EVENT_TEXT), fx.snapshotId);
      // Mixed boundary classes (all-day start vs timed end).
      expect(() =>
        stager.stage(fx.runId, {
          targetRefId: fx.refId,
          start: "2026-02-01",
          end: TIMED.end,
        }),
      ).toThrow(/boundary classes/);
      // Inverted range.
      expect(() =>
        stager.stage(fx.runId, {
          targetRefId: fx.refId,
          start: TIMED.end,
          end: TIMED.start,
        }),
      ).toThrow(/before end/);
      // Non-running run.
      fx.db
        .prepare(
          "UPDATE runs SET status = 'failed', error_code = 'x', finished_at = 1 WHERE id = ?",
        )
        .run(fx.runId);
      expect(() =>
        stager.stage(fx.runId, { targetRefId: fx.refId, ...TIMED }),
      ).toThrow(/running/);
    } finally {
      await closeKernelDatabase(fx.handle);
    }
  });

  it("caps one staged proposal per run and honors the 15-minute TTL", async () => {
    let now = 1000;
    const fx = await setupFixture();
    try {
      const { stager } = makeStager(fx, () => now);
      stager.stage(fx.runId, { targetRefId: fx.refId, ...TIMED });
      expect(() =>
        stager.stage(fx.runId, { targetRefId: fx.refId, ...TIMED }),
      ).toThrow(/at most one/);
      now = 1000 + 15 * 60 * 1000;
      expect(stager.getStaged(fx.runId)).toBeNull();
    } finally {
      await closeKernelDatabase(fx.handle);
    }
  });

  it("commitStaged only persists inside the caller transaction; rollback leaves nothing for a retry to redo", async () => {
    const fx = await setupFixture();
    try {
      const { stager, sink } = makeStager(fx, () => 1000);
      stager.stage(fx.runId, { targetRefId: fx.refId, ...TIMED });
      // Simulate a repository rollback of completeRun: commitStaged succeeds
      // inside the caller tx but the caller throws afterwards, so the whole
      // transaction (row + event) is undone. C17 rollback-safe lifecycle: the
      // staged entry is NOT consumed, so a retry can commit it directly.
      const forcedRollback = fx.db.transaction(() => {
        stager.commitStaged(fx.runId, 2000);
        throw new Error("forced rollback");
      });
      expect(() => forcedRollback()).toThrow(/forced rollback/);
      // The sink array is in-memory (not transactional): the rolled-back
      // append is not durable. Clear it; the durable DB state is what counts.
      sink.events.length = 0;
      const countAfterRollback = fx.db
        .prepare(
          "SELECT COUNT(*) AS n FROM action_proposals WHERE source_run_id = ?",
        )
        .get(fx.runId) as { n: number };
      expect(countAfterRollback.n).toBe(0);
      // Unknown run commit fails cleanly without persisting anything.
      expect(() =>
        fx.db.transaction(() => stager.commitStaged(generateId(), 2000))(),
      ).toThrow(RepositoryNotFoundError);
      // Retry: the staged entry survived the rollback — commit it directly,
      // exactly one row and one event.
      const committed = fx.db.transaction(() =>
        stager.commitStaged(fx.runId, 2000),
      )();
      expect(committed.status).toBe("pending");
      expect(sink.events.map((e) => e.type)).toEqual(["action.proposed"]);
      const rows = fx.db
        .prepare(
          "SELECT id, status FROM action_proposals WHERE source_run_id = ?",
        )
        .all(fx.runId) as Array<{ id: string; status: string }>;
      expect(rows).toEqual([{ id: committed.proposalId, status: "pending" }]);
    } finally {
      await closeKernelDatabase(fx.handle);
    }
  });

  it("revalidates one-pending-per-session and expiry at commit time", async () => {
    let now = 1000;
    const fx = await setupFixture();
    try {
      const { stager } = makeStager(fx, () => now);
      stager.stage(fx.runId, { targetRefId: fx.refId, ...TIMED });
      fx.db.transaction(() => stager.commitStaged(fx.runId, now))();
      // C17: the committed staged entry stays staged until the outer commit
      // acknowledges it; a second commit inside the tx hits the
      // one-pending-per-session rule even though the entry is still staged.
      expect(() =>
        fx.db.transaction(() => stager.commitStaged(fx.runId, now))(),
      ).toThrow(/pending/);
      stager.removeStaged(fx.runId);
      stager.stage(fx.runId, { targetRefId: fx.refId, ...TIMED });
      now = 1000 + 15 * 60 * 1000 + 1;
      expect(() =>
        fx.db.transaction(() => stager.commitStaged(fx.runId, now))(),
      ).toThrow(/expired/);
    } finally {
      await closeKernelDatabase(fx.handle);
    }
  });

  it("expires an unattended pending proposal at commit time and frees the session cap (exact 15min boundary)", async () => {
    const TTL = 15 * 60 * 1000;
    let now = 1000;
    const fx = await setupFixture();
    try {
      const { stager } = makeStager(fx, () => now);
      stager.stage(fx.runId, { targetRefId: fx.refId, ...TIMED });
      const first = fx.db.transaction(() =>
        stager.commitStaged(fx.runId, now),
      )();
      stager.removeStaged(fx.runId);

      // A SECOND staging on the SAME run after the outer commit acked the
      // staged entry: its commit is blocked by the one-pending-per-session
      // cap while the first proposal is still pending — unless the old one
      // has expired.
      // EXACT 15-minute boundary: now === first.expires_at. The OLD pending
      // row is expired (expires_at <= now) and the NEW staged entry (fresh
      // TTL from the boundary `now`) commits successfully.
      now = 1000 + TTL;
      stager.stage(fx.runId, { targetRefId: fx.refId, ...TIMED });
      const second = fx.db.transaction(() =>
        stager.commitStaged(fx.runId, now),
      )();
      expect(second.status).toBe("pending");
      const old = fx.db
        .prepare(
          "SELECT status, resolved_at, decision_turn_id FROM action_proposals WHERE id = ?",
        )
        .get(first.proposalId) as {
        status: string;
        resolved_at: number;
        decision_turn_id: string | null;
      };
      expect(old).toEqual({
        status: "expired",
        resolved_at: now,
        decision_turn_id: null,
      });
      // ROLLBACK-SAFETY: a failed completion rolls the sweep back too — the
      // second pending row (now expired) is restored un-swept (nothing
      // committed).
      stager.removeStaged(fx.runId);
      now += TTL;
      stager.stage(fx.runId, { targetRefId: fx.refId, ...TIMED });
      const forcedRollback = fx.db.transaction(() => {
        stager.commitStaged(fx.runId, now);
        throw new Error("forced rollback");
      });
      expect(() => forcedRollback()).toThrow(/forced rollback/);
      const pendingRows = fx.db
        .prepare(
          "SELECT id FROM action_proposals WHERE session_id = ? AND status = 'pending'",
        )
        .all(fx.sessionId);
      expect(pendingRows).toHaveLength(1);
      expect(pendingRows[0]).toMatchObject({ id: second.proposalId });
    } finally {
      await closeKernelDatabase(fx.handle);
    }
  });

  it("removeStaged discards staged content for failed/cancelled runs (idempotent)", async () => {
    const fx = await setupFixture();
    try {
      const { stager } = makeStager(fx, () => 1000);
      stager.stage(fx.runId, { targetRefId: fx.refId, ...TIMED });
      expect(stager.removeStaged(fx.runId)).toBe(true);
      expect(stager.removeStaged(fx.runId)).toBe(false);
      expect(stager.getStaged(fx.runId)).toBeNull();
    } finally {
      await closeKernelDatabase(fx.handle);
    }
  });
});
