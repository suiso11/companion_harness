// Web result snapshot tests (design §5, kernel-side persistence):
// URL normalization/identity, same-normalized-URL reuse, content-change
// revisions, verified-URL side table retrieval, and the pre-0026 upgrade.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeKernelDatabase,
  createKernelRepository,
  createReferenceManager,
  generateId,
  getSchemaVersion,
  migrateKernelDatabase,
  normalizeWebResultUrl,
  openKernelDatabase,
  RepositoryValidationError,
  type WebResultHit,
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

function hit(url: string, extra: Partial<WebResultHit> = {}): WebResultHit {
  return {
    url,
    title: "Example Site",
    snippet: "A useful snippet",
    observedAt: T0,
    ...extra,
  };
}

function revisionOf(db: Database.Database, snapshotId: string): number {
  return (
    db
      .prepare("SELECT revision FROM resource_snapshots WHERE id = ?")
      .get(snapshotId) as { revision: number }
  ).revision;
}

const tempRoots: string[] = [];
afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop() as string, { recursive: true, force: true });
  }
});

describe("web result URL normalization", () => {
  it("lowercases scheme/host, drops fragments and default ports, keeps query", () => {
    const a = normalizeWebResultUrl("https://Example.com");
    const b = normalizeWebResultUrl("https://EXAMPLE.COM/#Section");
    const c = normalizeWebResultUrl("http://example.com:80/doc?x=1");
    const d = normalizeWebResultUrl("http://example.com/doc?x=1");
    const e = normalizeWebResultUrl("https://example.com/search?q=A#frag");
    const f = normalizeWebResultUrl("https://example.com/search?q=A");
    expect(a.normalizedUrl).toBe("https://example.com");
    expect(b.normalizedUrl).toBe("https://example.com");
    expect(c.normalizedUrl).toBe("http://example.com/doc?x=1");
    expect(c.normalizedUrl).toBe(d.normalizedUrl);
    expect(e.normalizedUrl).toBe("https://example.com/search?q=A");
    expect(e.normalizedUrl).toBe(f.normalizedUrl);
    expect(a.canonicalKey).toBe(b.canonicalKey);
    expect(c.canonicalKey).toBe(d.canonicalKey);
    expect(a.normalizedUrl).not.toBe(c.normalizedUrl);
    expect(a.normalizedUrl).not.toBe(e.normalizedUrl);
    // Fails closed: wrong scheme / whitespace / control chars / unparseable.
    expect(() => normalizeWebResultUrl("ftp://example.com/x")).toThrow(
      RepositoryValidationError,
    );
    expect(() => normalizeWebResultUrl("https://exa mple.com")).toThrow(
      RepositoryValidationError,
    );
    expect(() => normalizeWebResultUrl("javascript:alert(1)")).toThrow(
      RepositoryValidationError,
    );
    expect(() => normalizeWebResultUrl("not-a-url")).toThrow();
  });
});

describe("web result snapshots", () => {
  it("same normalized URL from different spellings reuses one resource", async () => {
    const { handle, repo, manager } = await openStack();
    try {
      const inst = manager.ensureWebConnectorInstance("web", { now: T0 });
      expect(inst.kind).toBe("web");
      const { sessionId, runId } = runningFixture(repo);
      const first = manager.presentWebResults(sessionId, runId, inst.id, [
        hit("https://Example.com"),
      ]);
      expect(first.applied).toBe(true);
      expect(first.references).toHaveLength(1);
      // A later presentation in the same session maps to the same resource
      // identity (same canonical key derived from the normalized URL).
      const second = manager.presentWebResults(sessionId, runId, inst.id, [
        hit("https://EXAMPLE.COM/#top"),
      ]);
      expect(second.applied).toBe(true);
      const refB = second.references[0];
      if (refB === undefined) throw new Error("no reference");
      expect(refB.resourceId).toBe(first.references[0]?.resourceId);
      expect(refB.canonicalKey).toBe(first.references[0]?.canonicalKey);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("content change creates a new snapshot revision; unchanged content reuses", async () => {
    const { handle, repo, manager, db } = await openStack();
    try {
      const inst = manager.ensureWebConnectorInstance("web", { now: T0 });
      const { sessionId, runId } = runningFixture(repo);
      const first = manager.presentWebResults(sessionId, runId, inst.id, [
        hit("https://example.com/article", { title: "T" }),
      ]);
      expect(first.applied).toBe(true);
      if (first.references.length !== 1) throw new Error("no reference");
      const refA = first.references[0];
      if (refA === undefined) throw new Error("no reference");
      expect(revisionOf(db, refA.snapshotId)).toBe(1);
      // Same content in a later observation: session reuse path (same
      // snapshot, rN).
      const second = manager.presentWebResults(sessionId, runId, inst.id, [
        hit("https://example.com/article", { title: "T" }),
      ]);
      expect(second.applied).toBe(true);
      const refSame = second.references[0];
      if (refSame === undefined) throw new Error("no reference");
      expect(refSame.snapshotId).toBe(refA.snapshotId);
      expect(refSame.ordinal).toBe(refA.ordinal);
      // Changed content: fresh snapshot, next revision.
      const third = manager.presentWebResults(sessionId, runId, inst.id, [
        hit("https://example.com/article", { title: "Changed" }),
      ]);
      const refC = third.references[0];
      if (refC === undefined) throw new Error("no reference");
      expect(refC.snapshotId).not.toBe(refA.snapshotId);
      expect(revisionOf(db, refC.snapshotId)).toBe(2);
      // A repeated normalized URL inside one batch dedupes to a single rN.
      const dups = manager.presentWebResults(sessionId, runId, inst.id, [
        hit("https://example.com/other"),
        hit("https://example.com/other#x"),
      ]);
      expect(dups.applied).toBe(true);
      expect(dups.references).toHaveLength(1);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

describe("verified URL side table (0026)", () => {
  it("stores the validated URL per snapshot and fetches it back; reuse never rewrites", async () => {
    const { handle, repo, manager, db } = await openStack();
    try {
      const inst = manager.ensureWebConnectorInstance("web", { now: T0 });
      const { sessionId, runId } = runningFixture(repo);
      const first = manager.presentWebResults(sessionId, runId, inst.id, [
        hit("https://Example.com/docs?a=1"),
      ]);
      if (first.references.length !== 1) throw new Error("no reference");
      const snap = first.references[0]?.snapshotId;
      if (snap === undefined) throw new Error("no snapshot");
      expect(manager.getWebResultUrl(snap)).toBe(
        "https://example.com/docs?a=1",
      );
      // Re-presenting the same URL in a later observation reuses the
      // snapshot; the ON CONFLICT DO NOTHING keeps the verified spelling.
      manager.presentWebResults(sessionId, runId, inst.id, [
        hit("https://example.com/docs?a=1#anchor"),
      ]);
      expect(
        (
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM web_result_urls WHERE snapshot_id = ?",
            )
            .get(snap) as { n: number }
        ).n,
      ).toBe(1);
      expect(manager.getWebResultUrl(snap)).toBe(
        "https://example.com/docs?a=1",
      );
      expect(manager.getWebResultUrl(generateId())).toBe(null);
      // Foreign keys keep the store verifiable.
      expect(handle.raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("reference detail surfaces the stored web URL; non-web/invalid values fail closed to null", async () => {
    const { handle, repo, manager, db } = await openStack();
    try {
      const inst = manager.ensureWebConnectorInstance("web", { now: T0 });
      const { sessionId, runId } = runningFixture(repo);
      const presented = manager.presentWebResults(sessionId, runId, inst.id, [
        hit("https://example.com/alpha"),
      ]);

      const referenceId = presented.references[0]?.referenceId;
      if (referenceId === undefined) throw new Error("no reference");
      const detail = repo.getReferenceDetail(sessionId, referenceId);
      expect(detail.webResultUrl).toBe("https://example.com/alpha");
      // Non-web reference (markdown connector): null, never a URL.
      const mdInst = manager.ensureMarkdownConnectorInstance("vault", 1, {
        now: T0,
      });
      const mdPresented = manager.presentObservations(
        sessionId,
        runId,
        [
          {
            connectorInstanceId: mdInst.id,
            canonicalKey: "notes/a.md",
            title: "A",
            text: "text a",
            sourceRevision: "rev-1",
            observedAt: T0,
          },
        ],
        { freshness: "normal", now: T0 + 2 },
      );
      const mdReferenceId = mdPresented.references[0]?.referenceId;
      if (mdReferenceId === undefined) throw new Error("no md reference");
      expect(
        repo.getReferenceDetail(sessionId, mdReferenceId).webResultUrl,
      ).toBe(null);
      // Defensive fail-closed: a row that bypassed the connector allowlist
      // (e.g. a javascript: URL) degrades to null, never a link target.
      const snapId = presented.references[0]?.snapshotId;
      if (snapId === undefined) throw new Error("no snapshot");
      db.prepare(
        "UPDATE web_result_urls SET url = 'javascript:alert(1)' WHERE snapshot_id = ?",
      ).run(snapId);
      expect(repo.getReferenceDetail(sessionId, referenceId).webResultUrl).toBe(
        null,
      );
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

describe("pre-0026 upgrade", () => {
  it("applies 0026 on a v25 database without losing data", async () => {
    const dir = mkdtempSync(join(tmpdir(), "web-0026-"));
    tempRoots.push(dir);
    const handle = openKernelDatabase(":memory:");
    try {
      // Build the pre-web database (through migration 0025) and seed
      // representative rows through the repo API available at that schema.
      await migrateKernelDatabase({ db: handle.raw, targetVersion: 25 });
      const repo = createKernelRepository(handle.raw);
      const sessionId = repo.createSession({ key: key(), now: T0 }).body
        .sessionId;
      repo.postMessage(
        sessionId,
        { text: "old question" },
        { key: key(), now: T0 + 1 },
      );
      const backups = join(dir, "backups");
      const result = await migrateKernelDatabase({
        db: handle.raw,
        backupDir: backups,
      });
      // Migration 0026 (web_result_urls) and 0027 (web_search_turn_usage)
      // both apply on the pre-web v25 schema; 0028 (memory graph) is the
      // bundled head and applies in the same upgrade.
      expect(result.applied).toEqual([26, 27, 28]);
      expect(getSchemaVersion(handle.raw)).toBe(28);
      // Existing rows survive verbatim; the new table starts empty.
      const sessions = handle.raw
        .prepare("SELECT COUNT(*) AS n FROM sessions")
        .get() as { n: number };
      expect(sessions.n).toBe(1);
      const urlRows = handle.raw
        .prepare("SELECT COUNT(*) AS n FROM web_result_urls")
        .get() as { n: number };
      expect(urlRows.n).toBe(0);
      expect(handle.raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      // The manager still works against the upgraded schema.
      const manager = createReferenceManager(handle.raw);
      const inst = manager.ensureWebConnectorInstance("web", { now: T0 + 5 });
      expect(inst.kind).toBe("web");
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
