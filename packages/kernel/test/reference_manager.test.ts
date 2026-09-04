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
  RepositoryValidationError,
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

describe("markdown connector instance identity (fingerprint)", () => {
  const FP_A = "a".repeat(64);
  const FP_B = "b".repeat(64);

  it("stores the opaque hash without paths and reuses on exact match", async () => {
    const { handle, manager, db } = await openStack();
    try {
      const first = manager.ensureMarkdownConnectorInstance("vault", 1, {
        now: T0,
        configFingerprint: FP_A,
      });
      const row = db
        .prepare("SELECT config_json FROM connector_instances WHERE id = ?")
        .get(first.id) as { config_json: string };
      expect(JSON.parse(row.config_json)).toEqual({
        version: 1,
        rootCount: 1,
        configFingerprint: FP_A,
      });
      expect(row.config_json).toContain(FP_A);
      expect(row.config_json).not.toMatch(/vault-[0-9]/);
      // Exact reuse returns the same row without rebinding.
      const second = manager.ensureMarkdownConnectorInstance("vault", 1, {
        now: T0 + 1,
        configFingerprint: FP_A,
      });
      expect(second.id).toBe(first.id);
      expect(second.rootCount).toBe(1);
      const count = (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM connector_instances WHERE display_name = 'vault'",
          )
          .get() as { n: number }
      ).n;
      expect(count).toBe(1);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("fails closed on fingerprint mismatch, count mismatch, and legacy rows", async () => {
    const { handle, manager, db } = await openStack();
    try {
      const first = manager.ensureMarkdownConnectorInstance("vault", 1, {
        now: T0,
        configFingerprint: FP_A,
      });
      // Different fingerprint for the same display name rejects.
      expect(() =>
        manager.ensureMarkdownConnectorInstance("vault", 1, {
          now: T0 + 1,
          configFingerprint: FP_B,
        }),
      ).toThrow(RepositoryValidationError);
      // Different root count rejects even with the same fingerprint.
      expect(() =>
        manager.ensureMarkdownConnectorInstance("vault", 2, {
          now: T0 + 1,
          configFingerprint: FP_A,
        }),
      ).toThrow(RepositoryValidationError);
      // Legacy caller without a fingerprint also rejects a changed count.
      expect(() =>
        manager.ensureMarkdownConnectorInstance("vault", 2, { now: T0 + 1 }),
      ).toThrow(RepositoryValidationError);
      // The stored row was never updated or rebound.
      const row = db
        .prepare("SELECT config_json FROM connector_instances WHERE id = ?")
        .get(first.id) as { config_json: string };
      expect(JSON.parse(row.config_json)).toEqual({
        version: 1,
        rootCount: 1,
        configFingerprint: FP_A,
      });

      // A fingerprinted startup meeting a legacy row fails closed.
      const legacy = manager.ensureMarkdownConnectorInstance("legacy", 1, {
        now: T0,
      });
      expect(() =>
        manager.ensureMarkdownConnectorInstance("legacy", 1, {
          now: T0 + 1,
          configFingerprint: FP_A,
        }),
      ).toThrow(RepositoryValidationError);
      const legacyRow = db
        .prepare("SELECT config_json FROM connector_instances WHERE id = ?")
        .get(legacy.id) as { config_json: string };
      expect(JSON.parse(legacyRow.config_json)).toEqual({
        version: 1,
        rootCount: 1,
      });
      // Legacy callers still reuse a legacy row with a matching count.
      const reused = manager.ensureMarkdownConnectorInstance("legacy", 1, {
        now: T0 + 2,
      });
      expect(reused.id).toBe(legacy.id);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("validates the fingerprint shape without leaking values", async () => {
    const { handle, manager } = await openStack();
    try {
      for (const bad of [
        "short",
        "A".repeat(64),
        "g".repeat(64),
        "a".repeat(63),
        "a".repeat(65),
        42,
      ]) {
        expect(() =>
          manager.ensureMarkdownConnectorInstance("vault", 1, {
            now: T0,
            configFingerprint: bad as string,
          }),
        ).toThrow(RepositoryValidationError);
      }
      try {
        manager.ensureMarkdownConnectorInstance("vault", 1, {
          now: T0,
          configFingerprint: "z".repeat(64),
        });
        expect.unreachable("expected fingerprint validation");
      } catch (error) {
        expect(error).toBeInstanceOf(RepositoryValidationError);
        expect(String(error)).not.toContain("z".repeat(64));
      }
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

describe("snapshot link graph persistence", () => {
  function linkCounts(db: Database.Database) {
    const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    return {
      links: n("SELECT COUNT(*) AS n FROM snapshot_links"),
      resources: n("SELECT COUNT(*) AS n FROM resources"),
      snapshots: n("SELECT COUNT(*) AS n FROM resource_snapshots"),
    };
  }

  it("persists ordered links with candidate resources only on new snapshots", async () => {
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
          obs(connector.id, "notes/a.md", "body a", {
            links: [
              {
                kind: "standard",
                status: "resolved",
                candidates: ["notes/b.md"],
              },
              {
                kind: "wiki",
                status: "ambiguous",
                candidates: ["notes/b.md", "notes/c.md"],
              },
              { kind: "wiki", status: "unresolved", candidates: [] },
            ],
          }),
        ],
        { freshness: "normal", now: T0 + 5 },
      );
      if (!result.applied) {
        throw new Error("expected presentation to apply");
      }
      const snapshotId = result.references[0]?.snapshotId as string;
      const rows = db
        .prepare(
          "SELECT ordinal, kind, status, target_resource_id, candidates_json FROM snapshot_links WHERE source_snapshot_id = ? ORDER BY ordinal ASC",
        )
        .all(snapshotId) as Array<{
        ordinal: number;
        kind: string;
        status: string;
        target_resource_id: string | null;
        candidates_json: string;
      }>;
      expect(rows.map((r) => r.ordinal)).toEqual([1, 2, 3]);
      expect(rows.map((r) => r.kind)).toEqual(["standard", "wiki", "wiki"]);
      expect(rows.map((r) => r.status)).toEqual([
        "resolved",
        "ambiguous",
        "unresolved",
      ]);
      expect(JSON.parse(rows[0]?.candidates_json ?? "")).toEqual([
        "notes/b.md",
      ]);
      expect(rows[0]?.target_resource_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(JSON.parse(rows[1]?.candidates_json ?? "")).toEqual([
        "notes/b.md",
        "notes/c.md",
      ]);
      expect(rows[1]?.target_resource_id).toBeNull();
      expect(JSON.parse(rows[2]?.candidates_json ?? "")).toEqual([]);
      expect(rows[2]?.target_resource_id).toBeNull();
      // Candidate resources ensured under the same connector, title NULL.
      const b = db
        .prepare(
          "SELECT title, connector_instance_id FROM resources WHERE canonical_key = 'notes/b.md'",
        )
        .get() as { title: string | null; connector_instance_id: string };
      expect(b.title).toBeNull();
      expect(b.connector_instance_id).toBe(connector.id);
      const c = db
        .prepare(
          "SELECT title FROM resources WHERE canonical_key = 'notes/c.md'",
        )
        .get() as { title: string | null };
      expect(c.title).toBeNull();
      // No raw link text stored anywhere in the graph table.
      const ddl = (
        db
          .prepare(
            "SELECT sql FROM sqlite_master WHERE name = 'snapshot_links'",
          )
          .get() as { sql: string }
      ).sql.toLowerCase();
      expect(ddl).not.toContain("raw_url");
      expect(ddl).not.toContain("fragment");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("never rewrites the graph when a snapshot is reused", async () => {
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
          obs(connector.id, "notes/a.md", "same", {
            links: [
              {
                kind: "standard",
                status: "resolved",
                candidates: ["notes/b.md"],
              },
            ],
          }),
        ],
        { freshness: "normal", now: T0 + 5 },
      );
      if (!first.applied) {
        throw new Error("expected first presentation to apply");
      }
      const before = linkCounts(db);
      const second = manager.presentObservations(
        sessionId,
        runId,
        [
          obs(connector.id, "notes/a.md", "same", {
            links: [
              {
                kind: "standard",
                status: "resolved",
                candidates: ["notes/z.md"],
              },
            ],
          }),
        ],
        { freshness: "normal", now: T0 + 6 },
      );
      if (!second.applied) {
        throw new Error("expected second presentation to apply");
      }
      expect(second.references[0]?.snapshotId).toBe(
        first.references[0]?.snapshotId,
      );
      // Reuse wrote no new graph rows and created no new candidate resource.
      expect(linkCounts(db)).toEqual({
        ...before,
        resources: before.resources,
        snapshots: before.snapshots,
      });
      const z = db
        .prepare("SELECT id FROM resources WHERE canonical_key = 'notes/z.md'")
        .get() as { id: string } | undefined;
      expect(z).toBeUndefined();
      const rows = db
        .prepare("SELECT candidates_json FROM snapshot_links")
        .all() as Array<{ candidates_json: string }>;
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0]?.candidates_json ?? "")).toEqual([
        "notes/b.md",
      ]);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("writes a new graph on refresh and rolls back graph plus candidates on cancel", async () => {
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
          obs(connector.id, "notes/a.md", "same", {
            links: [
              {
                kind: "standard",
                status: "resolved",
                candidates: ["notes/b.md"],
              },
            ],
          }),
        ],
        { freshness: "normal", now: T0 + 5 },
      );
      if (!first.applied) {
        throw new Error("expected first presentation to apply");
      }
      const refreshed = manager.presentObservations(
        sessionId,
        runId,
        [
          obs(connector.id, "notes/a.md", "same", {
            links: [
              {
                kind: "standard",
                status: "resolved",
                candidates: ["notes/c.md"],
              },
            ],
          }),
        ],
        { freshness: "refresh", now: T0 + 6 },
      );
      if (!refreshed.applied) {
        throw new Error("expected refresh to apply");
      }
      expect(refreshed.references[0]?.snapshotId).not.toBe(
        first.references[0]?.snapshotId,
      );
      const oldRows = db
        .prepare(
          "SELECT candidates_json FROM snapshot_links WHERE source_snapshot_id = ?",
        )
        .all(first.references[0]?.snapshotId) as Array<{
        candidates_json: string;
      }>;
      const newRows = db
        .prepare(
          "SELECT candidates_json FROM snapshot_links WHERE source_snapshot_id = ?",
        )
        .all(refreshed.references[0]?.snapshotId) as Array<{
        candidates_json: string;
      }>;
      expect(JSON.parse(oldRows[0]?.candidates_json ?? "")).toEqual([
        "notes/b.md",
      ]);
      expect(JSON.parse(newRows[0]?.candidates_json ?? "")).toEqual([
        "notes/c.md",
      ]);

      // Cancel rollback discards the new graph and its unseen candidates.
      repo.cancelRun(sessionId, runId, { now: T0 + 7 });
      const before = linkCounts(db);
      const late = manager.presentObservations(
        sessionId,
        runId,
        [
          obs(connector.id, "notes/a.md", "later", {
            sourceRevision: "rev-2",
            links: [
              {
                kind: "standard",
                status: "resolved",
                candidates: ["notes/new.md"],
              },
            ],
          }),
        ],
        { freshness: "normal", now: T0 + 8 },
      );
      expect(late.applied).toBe(false);
      expect(linkCounts(db)).toEqual(before);
      const unseen = db
        .prepare(
          "SELECT id FROM resources WHERE canonical_key = 'notes/new.md'",
        )
        .get() as { id: string } | undefined;
      expect(unseen).toBeUndefined();
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("rejects malformed link metadata without writing", async () => {
    const { handle, repo, manager, db } = await openStack();
    try {
      const connector = manager.ensureMarkdownConnectorInstance("vault", 1, {
        now: T0,
      });
      const { sessionId, runId } = runningFixture(repo);
      const before = counts(db);
      expect(() =>
        manager.presentObservations(
          sessionId,
          runId,
          [
            obs(connector.id, "notes/a.md", "x", {
              links: [
                // Resolved with zero candidates violates the state rule.
                { kind: "standard", status: "resolved", candidates: [] },
              ],
            }),
          ],
          { freshness: "normal", now: T0 + 5 },
        ),
      ).toThrow();
      expect(counts(db)).toEqual(before);
      expect(() =>
        manager.presentObservations(
          sessionId,
          runId,
          [
            obs(connector.id, "notes/a.md", "x", {
              links: [
                // Path-shaped candidate is not a CanonicalKeySchema value.
                {
                  kind: "wiki",
                  status: "unresolved",
                  candidates: ["../escape"],
                },
              ],
            }),
          ],
          { freshness: "normal", now: T0 + 5 },
        ),
      ).toThrow();
      expect(counts(db)).toEqual(before);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

describe("getRelatedStored (stored graph only)", () => {
  function present(
    manager: ReturnType<typeof createReferenceManager>,
    sessionId: string,
    runId: string,
    observation: ResourceObservation,
    freshness: "normal" | "refresh" = "normal",
  ) {
    const result = manager.presentObservations(
      sessionId,
      runId,
      [observation],
      {
        freshness,
        now: T0 + 5,
      },
    );
    if (!result.applied) {
      throw new Error("expected presentation to apply");
    }
    return result.references[0] as NonNullable<(typeof result.references)[0]>;
  }

  it("returns outgoing links first, then incoming, deterministically", async () => {
    const { handle, repo, manager, db } = await openStack();
    try {
      const connector = manager.ensureMarkdownConnectorInstance("vault", 1, {
        now: T0,
      });
      const { sessionId, runId } = runningFixture(repo);
      // a -> b (resolved), a -> c (ambiguous, never guessed), a -> d (unresolved).
      const a = present(
        manager,
        sessionId,
        runId,
        obs(connector.id, "notes/a.md", "body a", {
          links: [
            {
              kind: "standard",
              status: "resolved",
              candidates: ["notes/b.md"],
            },
            {
              kind: "wiki",
              status: "ambiguous",
              candidates: ["notes/b.md", "notes/c.md"],
            },
            { kind: "wiki", status: "unresolved", candidates: [] },
          ],
        }),
      );
      const b = present(
        manager,
        sessionId,
        runId,
        obs(connector.id, "notes/b.md", "body b"),
      );
      // c and d are referenced but only reachable ambiguously / not at all.
      const c = present(
        manager,
        sessionId,
        runId,
        obs(connector.id, "notes/c.md", "body c"),
      );
      const d = present(
        manager,
        sessionId,
        runId,
        obs(connector.id, "notes/d.md", "body d"),
      );
      // e -> a (incoming to a).
      const e = present(
        manager,
        sessionId,
        runId,
        obs(connector.id, "notes/e.md", "body e", {
          links: [
            {
              kind: "standard",
              status: "resolved",
              candidates: ["notes/a.md"],
            },
          ],
        }),
      );
      void d;
      const related = manager.getRelatedStored(sessionId, a.referenceId);
      // Outgoing b first, then incoming e. Ambiguous c is never guessed.
      expect(related.map((r) => r.canonicalKey)).toEqual([
        "notes/b.md",
        "notes/e.md",
      ]);
      expect(related[0]?.referenceId).toBe(b.referenceId);
      expect(related[1]?.referenceId).toBe(e.referenceId);
      expect(related.map((r) => r.referenceId)).not.toContain(c.referenceId);
      // Stored-only: no new sets, events, snapshots, or references.
      const sets = (
        db.prepare("SELECT COUNT(*) AS n FROM reference_sets").get() as {
          n: number;
        }
      ).n;
      const events = (
        db.prepare("SELECT COUNT(*) AS n FROM run_events").get() as {
          n: number;
        }
      ).n;
      const snapshots = (
        db.prepare("SELECT COUNT(*) AS n FROM resource_snapshots").get() as {
          n: number;
        }
      ).n;
      const second = manager.getRelatedStored(sessionId, a.referenceId);
      expect(second).toEqual(related);
      expect(
        (
          db.prepare("SELECT COUNT(*) AS n FROM reference_sets").get() as {
            n: number;
          }
        ).n,
      ).toBe(sets);
      expect(
        (
          db.prepare("SELECT COUNT(*) AS n FROM run_events").get() as {
            n: number;
          }
        ).n,
      ).toBe(events);
      expect(
        (
          db.prepare("SELECT COUNT(*) AS n FROM resource_snapshots").get() as {
            n: number;
          }
        ).n,
      ).toBe(snapshots);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("uses the exact base snapshot for outgoing and skips unreferenced targets", async () => {
    const { handle, repo, manager } = await openStack();
    try {
      const connector = manager.ensureMarkdownConnectorInstance("vault", 1, {
        now: T0,
      });
      const { sessionId, runId } = runningFixture(repo);
      const v1 = present(
        manager,
        sessionId,
        runId,
        obs(connector.id, "notes/a.md", "v1", {
          links: [
            {
              kind: "standard",
              status: "resolved",
              candidates: ["notes/b.md"],
            },
          ],
        }),
      );
      present(
        manager,
        sessionId,
        runId,
        obs(connector.id, "notes/b.md", "body b"),
      );
      // Refresh a with identical content but a different graph (a -> c).
      const v2 = present(
        manager,
        sessionId,
        runId,
        obs(connector.id, "notes/a.md", "v1"),
        "refresh",
      );
      void v2;
      // v1 still resolves outgoing b from its exact snapshot.
      expect(
        manager
          .getRelatedStored(sessionId, v1.referenceId)
          .map((r) => r.canonicalKey),
      ).toEqual(["notes/b.md"]);
      // A base whose target was never referenced in this session yields [].
      const lonely = present(
        manager,
        sessionId,
        runId,
        obs(connector.id, "notes/lonely.md", "lonely", {
          links: [
            {
              kind: "standard",
              status: "resolved",
              candidates: ["notes/ghost.md"],
            },
          ],
        }),
      );
      expect(manager.getRelatedStored(sessionId, lonely.referenceId)).toEqual(
        [],
      );
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("validates session ownership, unknown ids, and limits", async () => {
    const { handle, repo, manager } = await openStack();
    try {
      const connector = manager.ensureMarkdownConnectorInstance("vault", 1, {
        now: T0,
      });
      const a = runningFixture(repo, T0);
      const presented = manager.presentObservations(
        a.sessionId,
        a.runId,
        [obs(connector.id, "notes/a.md", "x")],
        { freshness: "normal", now: T0 + 5 },
      );
      if (!presented.applied) {
        throw new Error("expected presentation to apply");
      }
      const refId = presented.references[0]?.referenceId as string;
      const other = repo.createSession({ key: key(), now: T0 }).body.sessionId;
      expect(() => manager.getRelatedStored(other, refId)).toThrow(
        ReferenceNotFoundError,
      );
      expect(() => manager.getRelatedStored(a.sessionId, generateId())).toThrow(
        ReferenceNotFoundError,
      );
      expect(() => manager.getRelatedStored(a.sessionId, refId, 0)).toThrow();
      expect(() => manager.getRelatedStored(a.sessionId, refId, 21)).toThrow();
      expect(manager.getRelatedStored(a.sessionId, refId, 1)).toEqual([]);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
