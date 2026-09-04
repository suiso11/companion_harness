// M1 ReferenceManager tests (§4, §14.2-§14.4, §14.10): identity, reuse vs
// refresh, CAS allocators, atomicity, stored-only paths, metadata-only config.

import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  closeKernelDatabase,
  createKernelRepository,
  createReferenceManager,
  generateId,
  InvalidReferenceError,
  migrateKernelDatabase,
  openKernelDatabase,
  ReferenceNotFoundError,
  RepositoryNotFoundError,
  type ResourceObservation,
  sha256Hex,
} from "../src/index.js";

const T0 = 1790000000000;

async function openStack() {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  const repo = createKernelRepository(handle.raw);
  const manager = createReferenceManager(handle.raw);
  return { handle, repo, manager, db: handle.raw };
}

function key(): string {
  return generateId();
}

/** Session + running Run ready for presentation. */
function runningFixture(
  repo: ReturnType<typeof createKernelRepository>,
  now = T0,
) {
  const sessionId = repo.createSession({ key: key(), now }).body.sessionId;
  const posted = repo.postMessage(
    sessionId,
    { text: "q" },
    { key: key(), now },
  );
  const runId = posted.body.run.id;
  repo.startRun(runId, { now: now + 1 });
  return { sessionId, runId };
}

function obs(
  connectorInstanceId: string,
  canonicalKey: string,
  text: string,
  extra: Partial<ResourceObservation> = {},
): ResourceObservation {
  return {
    connectorInstanceId,
    canonicalKey,
    title: null,
    text,
    sourceRevision: "rev-1",
    observedAt: T0,
    ...extra,
  };
}

function counts(db: Database.Database) {
  const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    resources: n("SELECT COUNT(*) AS n FROM resources"),
    snapshots: n("SELECT COUNT(*) AS n FROM resource_snapshots"),
    references: n("SELECT COUNT(*) AS n FROM session_references"),
    sets: n("SELECT COUNT(*) AS n FROM reference_sets"),
    events: n("SELECT COUNT(*) AS n FROM run_events"),
  };
}

describe("markdown connector instance (metadata-only)", () => {
  it("stores only {version,rootCount} and rejects paths", async () => {
    const { handle, manager, db } = await openStack();
    try {
      const first = manager.ensureMarkdownConnectorInstance("vault", 2, {
        now: T0,
      });
      expect(first.kind).toBe("markdown");
      expect(first.rootCount).toBe(2);
      const row = db
        .prepare("SELECT config_json FROM connector_instances WHERE id = ?")
        .get(first.id) as { config_json: string };
      expect(JSON.parse(row.config_json)).toEqual({ version: 1, rootCount: 2 });
      expect(row.config_json).not.toMatch(/[/\\]/);
      // Idempotent re-ensure returns the same row.
      const second = manager.ensureMarkdownConnectorInstance("vault", 2, {
        now: T0 + 1,
      });
      expect(second.id).toBe(first.id);
      expect(() =>
        manager.ensureMarkdownConnectorInstance("../escape", 1, { now: T0 }),
      ).toThrow();
      expect(() =>
        manager.ensureMarkdownConnectorInstance("C:\\abs", 1, { now: T0 }),
      ).toThrow();
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

describe("presentObservations: materialization and reuse", () => {
  it("materializes ordered observations with CAS ordinals and one event per reference", async () => {
    const { handle, repo, manager, db } = await openStack();
    try {
      const connector = manager.ensureMarkdownConnectorInstance("vault", 1, {
        now: T0,
      });
      const { sessionId, runId } = runningFixture(repo);
      const result = manager.presentObservations(
        sessionId,
        runId,
        [
          obs(connector.id, "notes/a.md", "# A\nbody a", { title: "A" }),
          obs(connector.id, "notes/b.md", "# B\nbody b", { title: "B" }),
        ],
        { freshness: "normal", now: T0 + 5 },
      );
      if (!result.applied) {
        throw new Error("expected presentation to apply");
      }
      expect(result.references.map((r) => r.ordinal)).toEqual([1, 2]);
      expect(result.references.map((r) => r.canonicalKey)).toEqual([
        "notes/a.md",
        "notes/b.md",
      ]);
      expect(result.setId).toMatch(/^[0-9a-f-]{36}$/);
      // Ordered set items match presentation order.
      const items = db
        .prepare(
          "SELECT ordinal, reference_id FROM reference_set_items WHERE set_id = ? ORDER BY ordinal ASC",
        )
        .all(result.setId) as Array<{ ordinal: number; reference_id: string }>;
      expect(items.map((i) => i.ordinal)).toEqual([1, 2]);
      expect(items.map((i) => i.reference_id)).toEqual(
        result.references.map((r) => r.referenceId),
      );
      // One structural reference.presented event per reference, same setId.
      const events = db
        .prepare(
          "SELECT type, payload FROM run_events WHERE run_id = ? ORDER BY seq ASC",
        )
        .all(runId) as Array<{ type: string; payload: string }>;
      const presented = events.filter((e) => e.type === "reference.presented");
      expect(presented).toHaveLength(2);
      for (const event of presented) {
        const payload = JSON.parse(event.payload) as Record<string, unknown>;
        expect(Object.keys(payload).sort()).toEqual([
          "ordinal",
          "referenceId",
          "resourceId",
          "setId",
          "snapshotId",
        ]);
        expect(payload.setId).toBe(result.setId);
      }
      // Allocators advanced by CAS: rN 1..2 consumed, revisions at 2.
      const session = db
        .prepare("SELECT next_reference_ordinal FROM sessions WHERE id = ?")
        .get(sessionId) as { next_reference_ordinal: number };
      expect(session.next_reference_ordinal).toBe(3);
      // Kernel recomputed NFC hash/size; connector hash never trusted.
      const snaps = db
        .prepare(
          "SELECT content_hash, size_bytes, body_json FROM resource_snapshots",
        )
        .all() as Array<{
        content_hash: string;
        size_bytes: number;
        body_json: string;
      }>;
      expect(snaps).toHaveLength(2);
      expect(snaps[0]?.content_hash).toBe(sha256Hex("# A\nbody a"));
      expect(JSON.parse(snaps[0]?.body_json ?? "")).toEqual({
        version: 1,
        text: "# A\nbody a",
      });
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("normal reuses latest snapshot+rN on identical revision+content", async () => {
    const { handle, repo, manager, db } = await openStack();
    try {
      const connector = manager.ensureMarkdownConnectorInstance("vault", 1, {
        now: T0,
      });
      const { sessionId, runId } = runningFixture(repo);
      const first = manager.presentObservations(
        sessionId,
        runId,
        [obs(connector.id, "notes/a.md", "same text")],
        { freshness: "normal", now: T0 + 5 },
      );
      if (!first.applied) {
        throw new Error("expected first presentation to apply");
      }
      const before = counts(db);
      const second = manager.presentObservations(
        sessionId,
        runId,
        [obs(connector.id, "notes/a.md", "same text")],
        { freshness: "normal", now: T0 + 6 },
      );
      if (!second.applied) {
        throw new Error("expected second presentation to apply");
      }
      // Same snapshot and same rN reused.
      expect(second.references[0]?.snapshotId).toBe(
        first.references[0]?.snapshotId,
      );
      expect(second.references[0]?.referenceId).toBe(
        first.references[0]?.referenceId,
      );
      expect(second.references[0]?.ordinal).toBe(1);
      const after = counts(db);
      expect(after.snapshots).toBe(before.snapshots);
      expect(after.references).toBe(before.references);
      // Re-presentation still records a new set + new events.
      expect(after.sets).toBe(before.sets + 1);
      expect(after.events).toBe(before.events + 1);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("changed revision with identical content creates a new snapshot+rN (no content UNIQUE)", async () => {
    const { handle, repo, manager, db } = await openStack();
    try {
      const connector = manager.ensureMarkdownConnectorInstance("vault", 1, {
        now: T0,
      });
      const { sessionId, runId } = runningFixture(repo);
      const first = manager.presentObservations(
        sessionId,
        runId,
        [obs(connector.id, "notes/a.md", "same text")],
        { freshness: "normal", now: T0 + 5 },
      );
      if (!first.applied) {
        throw new Error("expected first presentation to apply");
      }
      const second = manager.presentObservations(
        sessionId,
        runId,
        [
          obs(connector.id, "notes/a.md", "same text", {
            sourceRevision: "rev-2",
          }),
        ],
        { freshness: "normal", now: T0 + 6 },
      );
      if (!second.applied) {
        throw new Error("expected second presentation to apply");
      }
      expect(second.references[0]?.snapshotId).not.toBe(
        first.references[0]?.snapshotId,
      );
      expect(second.references[0]?.ordinal).toBe(2);
      // Same content hash legitimately appears on two snapshots.
      const hashes = db
        .prepare("SELECT content_hash FROM resource_snapshots")
        .all() as Array<{ content_hash: string }>;
      expect(hashes).toHaveLength(2);
      expect(hashes[0]?.content_hash).toBe(hashes[1]?.content_hash);
      const revisions = db
        .prepare(
          "SELECT revision FROM resource_snapshots ORDER BY revision ASC",
        )
        .all() as Array<{ revision: number }>;
      expect(revisions.map((r) => r.revision)).toEqual([1, 2]);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("refresh always creates a new snapshot+rN even when identical", async () => {
    const { handle, repo, manager } = await openStack();
    try {
      const connector = manager.ensureMarkdownConnectorInstance("vault", 1, {
        now: T0,
      });
      const { sessionId, runId } = runningFixture(repo);
      const first = manager.presentObservations(
        sessionId,
        runId,
        [obs(connector.id, "notes/a.md", "same text")],
        { freshness: "normal", now: T0 + 5 },
      );
      if (!first.applied) {
        throw new Error("expected first presentation to apply");
      }
      const second = manager.presentObservations(
        sessionId,
        runId,
        [obs(connector.id, "notes/a.md", "same text")],
        { freshness: "refresh", now: T0 + 6 },
      );
      if (!second.applied) {
        throw new Error("expected refresh to apply");
      }
      expect(second.references[0]?.snapshotId).not.toBe(
        first.references[0]?.snapshotId,
      );
      expect(second.references[0]?.referenceId).not.toBe(
        first.references[0]?.referenceId,
      );
      expect(second.references[0]?.ordinal).toBe(2);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("NFC-normalizes text and enforces the 1MiB bound without truncation", async () => {
    const { handle, repo, manager, db } = await openStack();
    try {
      const connector = manager.ensureMarkdownConnectorInstance("vault", 1, {
        now: T0,
      });
      const { sessionId, runId } = runningFixture(repo);
      const nfd = "é".normalize("NFD");
      const result = manager.presentObservations(
        sessionId,
        runId,
        [obs(connector.id, "notes/nfc.md", nfd)],
        { freshness: "normal", now: T0 + 5 },
      );
      if (!result.applied) {
        throw new Error("expected presentation to apply");
      }
      const snap = db
        .prepare("SELECT content_hash, body_json FROM resource_snapshots")
        .get() as { content_hash: string; body_json: string };
      expect(snap.content_hash).toBe(sha256Hex(nfd.normalize("NFC")));
      expect(JSON.parse(snap.body_json)).toEqual({
        version: 1,
        text: nfd.normalize("NFC"),
      });
      const before = counts(db);
      expect(() =>
        manager.presentObservations(
          sessionId,
          runId,
          [obs(connector.id, "notes/big.md", "x".repeat(1_048_577))],
          { freshness: "normal", now: T0 + 6 },
        ),
      ).toThrow();
      expect(counts(db)).toEqual(before);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("reuses snapshots across sessions but numbers rN per session", async () => {
    const { handle, repo, manager } = await openStack();
    try {
      const connector = manager.ensureMarkdownConnectorInstance("vault", 1, {
        now: T0,
      });
      const a = runningFixture(repo, T0);
      const first = manager.presentObservations(
        a.sessionId,
        a.runId,
        [obs(connector.id, "notes/a.md", "shared")],
        { freshness: "normal", now: T0 + 5 },
      );
      if (!first.applied) {
        throw new Error("expected first presentation to apply");
      }
      const b = runningFixture(repo, T0 + 10);
      const second = manager.presentObservations(
        b.sessionId,
        b.runId,
        [obs(connector.id, "notes/a.md", "shared")],
        { freshness: "normal", now: T0 + 15 },
      );
      if (!second.applied) {
        throw new Error("expected second presentation to apply");
      }
      // Same global Snapshot, independent session rN starting at 1.
      expect(second.references[0]?.snapshotId).toBe(
        first.references[0]?.snapshotId,
      );
      expect(second.references[0]?.ordinal).toBe(1);
      expect(second.references[0]?.referenceId).not.toBe(
        first.references[0]?.referenceId,
      );
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("writes nothing for zero-hit presentations", async () => {
    const { handle, repo, manager, db } = await openStack();
    try {
      const { sessionId, runId } = runningFixture(repo);
      const before = counts(db);
      const result = manager.presentObservations(sessionId, runId, [], {
        freshness: "normal",
        now: T0 + 5,
      });
      expect(result.applied).toBe(true);
      expect(result.setId).toBeNull();
      expect(result.references).toEqual([]);
      expect(counts(db)).toEqual(before);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

describe("presentObservations: transactional atomicity", () => {
  it("rejects ownership mismatches without writing", async () => {
    const { handle, repo, manager, db } = await openStack();
    try {
      const connector = manager.ensureMarkdownConnectorInstance("vault", 1, {
        now: T0,
      });
      const a = runningFixture(repo, T0);
      const other = repo.createSession({ key: key(), now: T0 }).body.sessionId;
      const before = counts(db);
      expect(() =>
        manager.presentObservations(
          other,
          a.runId,
          [obs(connector.id, "notes/a.md", "x")],
          { freshness: "normal", now: T0 + 5 },
        ),
      ).toThrow(RepositoryNotFoundError);
      expect(counts(db)).toEqual(before);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("discards everything post-cancel, including title updates", async () => {
    const { handle, repo, manager, db } = await openStack();
    try {
      const connector = manager.ensureMarkdownConnectorInstance("vault", 1, {
        now: T0,
      });
      const { sessionId, runId } = runningFixture(repo);
      const first = manager.presentObservations(
        sessionId,
        runId,
        [obs(connector.id, "notes/a.md", "v1", { title: "Old" })],
        { freshness: "normal", now: T0 + 5 },
      );
      if (!first.applied) {
        throw new Error("expected first presentation to apply");
      }
      repo.cancelRun(sessionId, runId, { now: T0 + 6 });
      const before = counts(db);
      const result = manager.presentObservations(
        sessionId,
        runId,
        [
          obs(connector.id, "notes/a.md", "v2", {
            title: "New",
            sourceRevision: "rev-2",
          }),
        ],
        { freshness: "normal", now: T0 + 7 },
      );
      expect(result.applied).toBe(false);
      expect(counts(db)).toEqual(before);
      const resource = db.prepare("SELECT title FROM resources").get() as {
        title: string;
      };
      expect(resource.title).toBe("Old");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("writes nothing once the run is terminal and appends no event", async () => {
    const { handle, repo, manager, db } = await openStack();
    try {
      const connector = manager.ensureMarkdownConnectorInstance("vault", 1, {
        now: T0,
      });
      const { sessionId, runId } = runningFixture(repo);
      await repo.completeRun(
        runId,
        { version: 1, text: "done" },
        { now: T0 + 5 },
      );
      const before = counts(db);
      const result = manager.presentObservations(
        sessionId,
        runId,
        [obs(connector.id, "notes/a.md", "late")],
        { freshness: "normal", now: T0 + 6 },
      );
      if (result.applied) {
        throw new Error("expected terminal presentation to discard");
      }
      expect(result.status).toBe("completed");
      expect(counts(db)).toEqual(before);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("refuses presentation on a queued (not running) run", async () => {
    const { handle, repo, manager } = await openStack();
    try {
      const connector = manager.ensureMarkdownConnectorInstance("vault", 1, {
        now: T0,
      });
      const sessionId = repo.createSession({ key: key(), now: T0 }).body
        .sessionId;
      const posted = repo.postMessage(
        sessionId,
        { text: "q" },
        { key: key(), now: T0 },
      );
      const result = manager.presentObservations(
        sessionId,
        posted.body.run.id,
        [obs(connector.id, "notes/a.md", "x")],
        { freshness: "normal", now: T0 + 5 },
      );
      if (result.applied) {
        throw new Error("expected queued presentation to discard");
      }
      expect(result.status).toBe("queued");
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

describe("presentStored (stored-only, active run)", () => {
  it("creates only set/items/presented without rereading", async () => {
    const { handle, repo, manager, db } = await openStack();
    try {
      const connector = manager.ensureMarkdownConnectorInstance("vault", 1, {
        now: T0,
      });
      const { sessionId, runId } = runningFixture(repo);
      const first = manager.presentObservations(
        sessionId,
        runId,
        [
          obs(connector.id, "notes/a.md", "text a"),
          obs(connector.id, "notes/b.md", "text b"),
        ],
        { freshness: "normal", now: T0 + 5 },
      );
      if (!first.applied) {
        throw new Error("expected presentation to apply");
      }
      const before = counts(db);
      const stored = manager.presentStored(
        sessionId,
        runId,
        [first.references[1]?.referenceId as string],
        { now: T0 + 6 },
      );
      if (!stored.applied) {
        throw new Error("expected stored presentation to apply");
      }
      expect(stored.references).toHaveLength(1);
      expect(stored.references[0]?.ordinal).toBe(2);
      const after = counts(db);
      expect(after.resources).toBe(before.resources);
      expect(after.snapshots).toBe(before.snapshots);
      expect(after.references).toBe(before.references);
      expect(after.sets).toBe(before.sets + 1);
      expect(after.events).toBe(before.events + 1);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("rejects unknown, foreign-session, and duplicate ids", async () => {
    const { handle, repo, manager } = await openStack();
    try {
      const connector = manager.ensureMarkdownConnectorInstance("vault", 1, {
        now: T0,
      });
      const a = runningFixture(repo, T0);
      const presented = manager.presentObservations(
        a.sessionId,
        a.runId,
        [obs(connector.id, "notes/a.md", "text a")],
        { freshness: "normal", now: T0 + 5 },
      );
      if (!presented.applied) {
        throw new Error("expected presentation to apply");
      }
      const refId = presented.references[0]?.referenceId as string;
      const b = runningFixture(repo, T0 + 10);
      expect(() =>
        manager.presentStored(b.sessionId, b.runId, [refId], { now: T0 + 11 }),
      ).toThrow(ReferenceNotFoundError);
      expect(() =>
        manager.presentStored(a.sessionId, a.runId, [generateId()], {
          now: T0 + 11,
        }),
      ).toThrow(ReferenceNotFoundError);
      expect(() =>
        manager.presentStored(a.sessionId, a.runId, [refId, refId], {
          now: T0 + 11,
        }),
      ).toThrow(InvalidReferenceError);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

describe("allocator and schema invariants", () => {
  it("rejects next_reference_ordinal underflow via CHECK", async () => {
    const { handle, repo } = await openStack();
    try {
      const sessionId = repo.createSession({ key: key(), now: T0 }).body
        .sessionId;
      expect(() =>
        handle.raw
          .prepare(
            "UPDATE sessions SET next_reference_ordinal = 0 WHERE id = ?",
          )
          .run(sessionId),
      ).toThrow();
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("exposes no UNIQUE(resource_id, content_hash)", async () => {
    const { handle } = await openStack();
    try {
      const indexes = handle.raw
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'resource_snapshots'",
        )
        .all() as Array<{ sql: string | null }>;
      const ddl = indexes.map((i) => i.sql ?? "").join("\n");
      expect(ddl).not.toMatch(/content_hash/);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
