// M2 evidence-grant finality (r3946554124): grantEvidence rejects
// completed/failed/cancelled/abandoned runs inside the same BEGIN IMMEDIATE
// transaction before insert/upgrade; no post-finalization mutation even when
// the row already exists and the request is an upgrade.

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  closeKernelDatabase,
  createKernelRepository,
  type KernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
  RepositoryNotFoundError,
  RepositoryValidationError,
} from "../src/index.js";

const T0 = 1790000000000;

async function setup(): Promise<{
  handle: ReturnType<typeof openKernelDatabase>;
  repo: KernelRepository;
}> {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  return { handle, repo: createKernelRepository(handle.raw) };
}

function newRunningTurn(
  repo: KernelRepository,
  now: number,
): { sessionId: string; runId: string } {
  const sessionId = repo.createSession({ key: randomUUID(), now }).body
    .sessionId;
  const posted = repo.postMessage(
    sessionId,
    { text: "research this" },
    { key: randomUUID(), now },
  );
  const runId = posted.body.run.id;
  repo.startRun(runId, { now: now + 1 });
  return { sessionId, runId };
}

function insertReference(
  db: Database.Database,
  sessionId: string,
  ordinal: number,
  now: number,
): string {
  const conn = randomUUID();
  const res = randomUUID();
  const snap = randomUUID();
  const ref = randomUUID();
  db.prepare(
    "INSERT INTO connector_instances (id, kind, display_name, config_json, created_at) VALUES (?, 'markdown', ?, '{}', ?)",
  ).run(conn, `vault-${conn.slice(0, 8)}`, now);
  db.prepare(
    "INSERT INTO resources (id, connector_instance_id, canonical_key, title, next_revision, created_at) VALUES (?, ?, ?, ?, 2, ?)",
  ).run(
    res,
    conn,
    `vault/doc-${ordinal}-${ref.slice(0, 8)}.md`,
    `Doc ${ordinal}`,
    now,
  );
  db.prepare(
    "INSERT INTO resource_snapshots (id, resource_id, revision, source_revision, content_hash, body_json, size_bytes, observed_at, created_at) VALUES (?, ?, 1, 's1', 'h', ?, ?, ?, ?)",
  ).run(
    snap,
    res,
    JSON.stringify({ version: 1, text: "evidence text" }),
    13,
    now,
    now,
  );
  db.prepare(
    "INSERT INTO session_references (id, session_id, ordinal, resource_id, snapshot_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(ref, sessionId, ordinal, res, snap, now);
  return ref;
}

function validResult(): unknown {
  return {
    version: 2,
    text: "done",
    answer: { version: 1, parts: [{ text: "done", citations: [] }] },
  };
}

describe("evidence-grant run finality", () => {
  it("running and cancel_requested runs still grant", async () => {
    const { handle, repo } = await setup();
    try {
      const { sessionId, runId } = newRunningTurn(repo, T0);
      const ref = insertReference(handle.raw, sessionId, 1, T0);
      expect(
        repo.upsertEvidenceGrant(sessionId, runId, ref, "snippet", {
          now: T0 + 2,
        }).exposure,
      ).toBe("snippet");
      // cancel_requested is non-terminal for audit-style writes (same rule
      // as tool/model-step events and model_calls): grants still apply.
      repo.cancelRun(sessionId, runId, { now: T0 + 3 });
      expect(repo.getRun(runId).status).toBe("cancel_requested");
      expect(
        repo.upsertEvidenceGrant(sessionId, runId, ref, "full", {
          now: T0 + 4,
        }).exposure,
      ).toBe("full");
      expect(repo.listEvidenceGrants(runId)).toHaveLength(1);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("rejects inserts on all terminal states with no row written", async () => {
    const { handle, repo } = await setup();
    try {
      // completed
      {
        const { sessionId, runId } = newRunningTurn(repo, T0);
        const ref = insertReference(handle.raw, sessionId, 11, T0);
        repo.completeRun(runId, validResult(), { now: T0 + 10 });
        expect(() =>
          repo.upsertEvidenceGrant(sessionId, runId, ref, "snippet", {
            now: T0 + 11,
          }),
        ).toThrow(RepositoryValidationError);
        expect(repo.listEvidenceGrants(runId)).toEqual([]);
      }
      // failed
      {
        const { sessionId, runId } = newRunningTurn(repo, T0 + 20);
        const ref = insertReference(handle.raw, sessionId, 12, T0 + 20);
        repo.failRun(runId, "output_invalid", { now: T0 + 30 });
        expect(() =>
          repo.upsertEvidenceGrant(sessionId, runId, ref, "snippet", {
            now: T0 + 31,
          }),
        ).toThrow(RepositoryValidationError);
        expect(repo.listEvidenceGrants(runId)).toEqual([]);
      }
      // cancelled (queued -> cancelled)
      {
        const sessionId = repo.createSession({
          key: randomUUID(),
          now: T0 + 40,
        }).body.sessionId;
        const posted = repo.postMessage(
          sessionId,
          { text: "q" },
          { key: randomUUID(), now: T0 + 40 },
        );
        const runId = posted.body.run.id;
        const ref = insertReference(handle.raw, sessionId, 13, T0 + 40);
        repo.cancelRun(sessionId, runId, { now: T0 + 41 });
        expect(repo.getRun(runId).status).toBe("cancelled");
        expect(() =>
          repo.upsertEvidenceGrant(sessionId, runId, ref, "snippet", {
            now: T0 + 42,
          }),
        ).toThrow(RepositoryValidationError);
        expect(repo.listEvidenceGrants(runId)).toEqual([]);
      }
      // abandoned (running -> recover)
      {
        const { sessionId, runId } = newRunningTurn(repo, T0 + 60);
        const ref = insertReference(handle.raw, sessionId, 14, T0 + 60);
        repo.recover({ now: T0 + 70 });
        expect(repo.getRun(runId).status).toBe("abandoned");
        expect(() =>
          repo.upsertEvidenceGrant(sessionId, runId, ref, "snippet", {
            now: T0 + 71,
          }),
        ).toThrow(RepositoryValidationError);
        expect(repo.listEvidenceGrants(runId)).toEqual([]);
      }
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("race: post-finalization upgrade never mutates the existing row", async () => {
    const { handle, repo } = await setup();
    try {
      const { sessionId, runId } = newRunningTurn(repo, T0);
      const refA = insertReference(handle.raw, sessionId, 21, T0);
      const refB = insertReference(handle.raw, sessionId, 22, T0);
      const first = repo.upsertEvidenceGrant(
        sessionId,
        runId,
        refA,
        "snippet",
        {
          now: T0 + 2,
        },
      );
      expect(first.exposure).toBe("snippet");
      // Finalize after the snippet grant (simulates the losing racer).
      repo.completeRun(runId, validResult(), { now: T0 + 3 });
      // Upgrade attempt on the pre-existing row must reject and leave the
      // stored row byte-identical (exposure + createdAt unchanged).
      expect(() =>
        repo.upsertEvidenceGrant(sessionId, runId, refA, "full", {
          now: T0 + 4,
        }),
      ).toThrow(RepositoryValidationError);
      // Fresh insert on a second reference must also reject atomically.
      expect(() =>
        repo.upsertEvidenceGrant(sessionId, runId, refB, "snippet", {
          now: T0 + 5,
        }),
      ).toThrow(RepositoryValidationError);
      const grants = repo.listEvidenceGrants(runId);
      expect(grants).toHaveLength(1);
      expect(grants[0]).toMatchObject({
        referenceId: refA,
        exposure: "snippet",
        createdAt: first.createdAt,
      });
      const stored = handle.raw
        .prepare(
          "SELECT exposure, created_at FROM evidence_grants WHERE run_id = ? AND reference_id = ?",
        )
        .get(runId, refA) as { exposure: string; created_at: number };
      expect(stored.exposure).toBe("snippet");
      expect(stored.created_at).toBe(first.createdAt);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("ownership checks still return 404", async () => {
    const { handle, repo } = await setup();
    try {
      const a = newRunningTurn(repo, T0);
      const b = newRunningTurn(repo, T0 + 100);
      const refA = insertReference(handle.raw, a.sessionId, 31, T0);
      // Foreign run in own session scope -> 404; foreign reference -> 404.
      expect(() =>
        repo.upsertEvidenceGrant(a.sessionId, b.runId, refA, "snippet", {
          now: T0 + 101,
        }),
      ).toThrow(RepositoryNotFoundError);
      const refB = insertReference(handle.raw, b.sessionId, 32, T0 + 100);
      expect(() =>
        repo.upsertEvidenceGrant(a.sessionId, a.runId, refB, "snippet", {
          now: T0 + 102,
        }),
      ).toThrow(expect.anything());
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
