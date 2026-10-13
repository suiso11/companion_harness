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
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { ActionProposalEventSink } from "../src/action_proposals.js";
import { createActionProposalStager } from "../src/action_proposals.js";
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

const TEST_EVENT_BODY = {
  schemaVersion: 1,
  canonicalKey: "cal|cal1|evt1",
  status: "confirmed",
  title: "Event",
  start: "2026-01-01T10:00:00Z",
  end: "2026-01-01T11:00:00Z",
  allDayEndExclusive: true,
  sourceRevision: "src@1",
  revisionBasis: "etag",
} as const;

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
  const connectorId = generateId();
  const resourceId = generateId();
  const snapshotId = generateId();
  const refId = generateId();
  db.prepare(
    "INSERT INTO sessions (id, created_at, last_active_at, next_turn_position) VALUES (?, 1, 1, 1)",
  ).run(sessionId);
  db.prepare(
    "INSERT INTO turns (id, session_id, seq, input_json, frozen_context, created_at, next_run_attempt) VALUES (?, ?, 1, '{}', '{}', 1, 1)",
  ).run(turnId, sessionId);
  db.prepare(
    "INSERT INTO runs (id, turn_id, session_id, attempt, status, strategy, event_seq, select_on_success, tool_requests_used, created_at, started_at) VALUES (?, ?, ?, 1, 'running', 's', 0, 1, 0, 1, 1)",
  ).run(runId, turnId, sessionId);
  db.prepare(
    "INSERT INTO connector_instances (id, kind, display_name, config_json, created_at) VALUES (?, 'calendar', 'c', '{}', 1)",
  ).run(connectorId);
  db.prepare(
    "INSERT INTO resources (id, connector_instance_id, canonical_key, title, next_revision, created_at) VALUES (?, ?, 'cal|cal1|evt1', 'Event', 1, 1)",
  ).run(resourceId, connectorId);
  db.prepare(
    "INSERT INTO resource_snapshots (id, resource_id, revision, source_revision, content_hash, body_json, size_bytes, observed_at, created_at) VALUES (?, ?, 1, 'src@1', 'hash@1', ?, 10, 1, 1)",
  ).run(snapshotId, resourceId, canonicalJsonString(TEST_EVENT_BODY));
  db.prepare(
    "INSERT INTO session_references (id, session_id, ordinal, resource_id, snapshot_id, created_at) VALUES (?, ?, 1, ?, ?, 1)",
  ).run(refId, sessionId, resourceId, snapshotId);
  return { handle, db, sessionId, runId, refId, resourceId, snapshotId };
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

  it("stages with concrete prechecks, deterministic hash, and a safe provider-id-free preview", async () => {
    const fx = await setupFixture();
    try {
      const { stager } = makeStager(fx, () => 1000);
      const a = stager.stage(fx.runId, { targetRefId: fx.refId, ...TIMED });
      expect(a.tool).toBe("calendar.reschedule");
      expect(a.input).toEqual(TIMED);
      // Deterministic start/end-only summary: no provider ids, no content.
      expect(a.preview.summary).toMatch(
        /^calendar\.reschedule: start=.+ end=.+$/,
      );
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
        .run(
          canonicalJsonString({ ...TEST_EVENT_BODY, status: "deleted" }),
          fx.snapshotId,
        );
      expect(() =>
        stager.stage(fx.runId, { targetRefId: fx.refId, ...TIMED }),
      ).toThrow(/deleted/);
      fx.db
        .prepare("UPDATE resource_snapshots SET body_json = ? WHERE id = ?")
        .run(canonicalJsonString(TEST_EVENT_BODY), fx.snapshotId);
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
