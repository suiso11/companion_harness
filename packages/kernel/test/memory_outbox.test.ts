// Conversation-memory durable state (migration 0008): outbox queue
// transitions, stable-key dedup, exposure snapshots, citation grants.
//
// Every assertion reads actual SQL rows back through the repository (or a
// direct COUNT for row-absence): no source-text or mock-echo checks. The
// remind database is never touched here; these tables are Companion-owned
// staging only.

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  closeKernelDatabase,
  createKernelRepository,
  generateId,
  migrateKernelDatabase,
  openKernelDatabase,
  RepositoryNotFoundError,
  RepositoryValidationError,
} from "../src/index.js";

const T0 = 1790000000000;

async function openRepo() {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  const repo = createKernelRepository(handle.raw);
  return { handle, repo };
}

function memoryJobRequest(op: string, params: Record<string, unknown>): string {
  return JSON.stringify({ op, params });
}

describe("memory outbox queue transitions", () => {
  it("enqueues pending, claims due, and acks with SQL-visible state", async () => {
    const { handle, repo } = await openRepo();
    try {
      const sessionId = generateId();
      const runId = generateId();
      const key = randomUUID();
      const first = repo.enqueueMemoryJob(
        "event.append",
        sessionId,
        runId,
        "test-scope",
        key,
        memoryJobRequest("event.append", { eventId: "evt-1" }),
        { now: T0 },
      );
      expect(first.deduplicated).toBe(false);
      expect(first.row.status).toBe("pending");
      expect(first.row.attempts).toBe(0);
      expect(first.row.idempotencyKey).toBe(key.toLowerCase());

      const due = repo.claimDueMemoryJobs(5, T0);
      expect(due.map((job) => job.id)).toContain(first.row.id);

      repo.ackMemoryJob(first.row.id, { now: T0 + 1 });
      const stored = repo.getMemoryJob(first.row.id);
      expect(stored?.status).toBe("acked");
      expect(repo.claimDueMemoryJobs(5, T0 + 1)).toHaveLength(0);
      expect(repo.countPendingMemoryJobs(T0 + 1)).toBe(0);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("re-enqueueing the same stable key dedups instead of duplicating", async () => {
    const { handle, repo } = await openRepo();
    try {
      const sessionId = generateId();
      const runId = generateId();
      const key = randomUUID();
      const first = repo.enqueueMemoryJob(
        "record.remember",
        sessionId,
        runId,
        "test-scope",
        key,
        memoryJobRequest("record.remember", { body: "b" }),
        { now: T0 },
      );
      const second = repo.enqueueMemoryJob(
        "record.remember",
        sessionId,
        runId,
        "test-scope",
        key,
        memoryJobRequest("record.remember", { body: "changed" }),
        { now: T0 + 5 },
      );
      expect(second.deduplicated).toBe(true);
      expect(second.row.id).toBe(first.row.id);
      // The first write wins: no duplicate row, original payload preserved.
      expect(second.row.requestJson).toBe(first.row.requestJson);
      const count = handle.raw
        .prepare("SELECT COUNT(*) AS n FROM memory_outbox")
        .get() as { n: number };
      expect(count.n).toBe(1);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("backs off transient failures and caps attempts terminally", async () => {
    const { handle, repo } = await openRepo();
    try {
      const { row } = repo.enqueueMemoryJob(
        "record.feedback",
        generateId(),
        generateId(),
        "test-scope",
        randomUUID(),
        memoryJobRequest("record.feedback", { recallId: "r" }),
        { now: T0 },
      );
      const once = repo.failMemoryJob(row.id, "cli_unavailable", {
        maxAttempts: 3,
        now: T0,
      });
      expect(once.status).toBe("pending");
      const stored = repo.getMemoryJob(row.id);
      expect(stored?.attempts).toBe(1);
      expect(stored?.lastError).toBe("cli_unavailable");
      // Backoff rearms in the future: not due immediately, due after.
      expect(stored !== null && stored.nextDueAt > T0).toBe(true);
      expect(repo.claimDueMemoryJobs(5, T0)).toHaveLength(0);
      expect(
        repo.claimDueMemoryJobs(5, (stored as { nextDueAt: number }).nextDueAt),
      ).toHaveLength(1);
      const terminal = repo.failMemoryJob(row.id, "cli_unavailable", {
        maxAttempts: 2,
        now: T0 + 60_000,
      });
      expect(terminal.status).toBe("failed");
      expect(repo.getMemoryJob(row.id)?.status).toBe("failed");
      // Terminal rows never become due again.
      expect(repo.claimDueMemoryJobs(5, T0 + 3_600_000)).toHaveLength(0);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("acks are replay-safe and unknown ids fail closed", async () => {
    const { handle, repo } = await openRepo();
    try {
      const { row } = repo.enqueueMemoryJob(
        "maintain.distill",
        generateId(),
        generateId(),
        "test-scope",
        randomUUID(),
        memoryJobRequest("maintain.distill", { scope: "s" }),
        { now: T0 },
      );
      repo.ackMemoryJob(row.id, { now: T0 + 1 });
      // Second ack is a state-idempotent no-op, not an error.
      repo.ackMemoryJob(row.id, { now: T0 + 2 });
      expect(repo.getMemoryJob(row.id)?.status).toBe("acked");
      expect(() => repo.ackMemoryJob(generateId(), { now: T0 })).toThrow(
        RepositoryNotFoundError,
      );
      expect(() => repo.failMemoryJob(generateId(), "cli_timeout")).toThrow(
        RepositoryNotFoundError,
      );
      expect(repo.getMemoryJob(generateId())).toBeNull();
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("rejects invalid kinds, scopes, keys, and payloads", async () => {
    const { handle, repo } = await openRepo();
    try {
      const sessionId = generateId();
      const runId = generateId();
      const valid = memoryJobRequest("event.append", {});
      expect(() =>
        repo.enqueueMemoryJob(
          "record.delete",
          sessionId,
          runId,
          "s",
          randomUUID(),
          valid,
        ),
      ).toThrow(RepositoryValidationError);
      expect(() =>
        repo.enqueueMemoryJob(
          "event.append",
          sessionId,
          runId,
          "",
          randomUUID(),
          valid,
        ),
      ).toThrow(RepositoryValidationError);
      expect(() =>
        repo.enqueueMemoryJob(
          "event.append",
          sessionId,
          runId,
          "s",
          "not a uuid",
          valid,
        ),
      ).toThrow(RepositoryValidationError);
      expect(() =>
        repo.enqueueMemoryJob(
          "event.append",
          sessionId,
          runId,
          "s",
          randomUUID(),
          "",
        ),
      ).toThrow(RepositoryValidationError);
      expect(() =>
        repo.enqueueMemoryJob(
          "event.append",
          sessionId,
          runId,
          "s",
          randomUUID(),
          "{oops",
        ),
      ).toThrow(RepositoryValidationError);
      expect(() =>
        repo.enqueueMemoryJob(
          "event.append",
          "nope",
          runId,
          "s",
          randomUUID(),
          valid,
        ),
      ).toThrow(RepositoryValidationError);
      expect(() => repo.claimDueMemoryJobs(0, T0)).toThrow(
        RepositoryValidationError,
      );
      expect(() => repo.failMemoryJob(generateId(), "HAS CAPS")).toThrow(
        RepositoryValidationError,
      );
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

describe("memory exposure snapshots and citation grants", () => {
  function exposureOf(
    overrides: {
      recallId?: string;
      recordId?: string;
      sessionId?: string;
      runId?: string;
      scope?: string;
      citation?: string;
      snippet?: string;
    } = {},
  ) {
    return {
      recallId: "recall-1",
      recordId: "record-1",
      sessionId: generateId(),
      runId: generateId(),
      scope: "test-scope",
      citation: "m1",
      snippet: "a recalled snippet",
      ...overrides,
    };
  }

  it("snapshots exposures per run and keeps replays immutable", async () => {
    const { handle, repo } = await openRepo();
    try {
      const sessionId = generateId();
      const runId = generateId();
      repo.recordMemoryExposure(
        exposureOf({ sessionId, runId, citation: "m1", snippet: "first" }),
        { now: T0 },
      );
      repo.recordMemoryExposure(
        exposureOf({
          sessionId,
          runId,
          recallId: "recall-2",
          recordId: "record-2",
          citation: "m2",
          snippet: "second",
        }),
        { now: T0 + 1 },
      );
      // Replay of the same (recallId, recordId) never updates the snapshot.
      repo.recordMemoryExposure(
        exposureOf({ sessionId, runId, citation: "m9", snippet: "mutated" }),
        { now: T0 + 2 },
      );
      const listed = repo.listMemoryExposures(runId);
      expect(listed).toHaveLength(2);
      expect(listed.map((item) => item.citation).sort()).toEqual(["m1", "m2"]);
      expect(listed.find((item) => item.citation === "m1")?.snippet).toBe(
        "first",
      );
      expect(repo.listMemoryExposures(generateId())).toHaveLength(0);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("grants only same-run, same-scope cited exposures", async () => {
    const { handle, repo } = await openRepo();
    try {
      const sessionId = generateId();
      const runId = generateId();
      repo.recordMemoryExposure(exposureOf({ sessionId, runId }), { now: T0 });
      repo.grantMemoryCitation(
        {
          runId,
          citation: "m1",
          recordId: "record-1",
          recallId: "recall-1",
          sessionId,
          scope: "test-scope",
        },
        { now: T0 + 1 },
      );
      // Grant replay is idempotent: still exactly one row.
      repo.grantMemoryCitation(
        {
          runId,
          citation: "m1",
          recordId: "record-1",
          recallId: "recall-1",
          sessionId,
          scope: "test-scope",
        },
        { now: T0 + 2 },
      );
      const grants = repo.listMemoryGrants(runId);
      expect(grants).toHaveLength(1);
      expect(grants[0]).toMatchObject({
        citation: "m1",
        recordId: "record-1",
        recallId: "recall-1",
        scope: "test-scope",
      });
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("rejects grants without a matching exposure or with a wrong scope", async () => {
    const { handle, repo } = await openRepo();
    try {
      const sessionId = generateId();
      const runId = generateId();
      const otherRunId = generateId();
      repo.recordMemoryExposure(exposureOf({ sessionId, runId }), { now: T0 });
      // No exposure for this citation: uncited mN grants nothing.
      expect(() =>
        repo.grantMemoryCitation({
          runId,
          citation: "m2",
          recordId: "record-1",
          recallId: "recall-1",
          sessionId,
          scope: "test-scope",
        }),
      ).toThrow(RepositoryValidationError);
      // Cross-run exposure: the grant run must own the exposure.
      expect(() =>
        repo.grantMemoryCitation({
          runId: otherRunId,
          citation: "m1",
          recordId: "record-1",
          recallId: "recall-1",
          sessionId,
          scope: "test-scope",
        }),
      ).toThrow(RepositoryValidationError);
      // Cross-scope citation: rejected even with a same-run exposure.
      expect(() =>
        repo.grantMemoryCitation({
          runId,
          citation: "m1",
          recordId: "record-1",
          recallId: "recall-1",
          sessionId,
          scope: "other-scope",
        }),
      ).toThrow(RepositoryValidationError);
      expect(repo.listMemoryGrants(runId)).toHaveLength(0);
      expect(repo.listMemoryGrants(otherRunId)).toHaveLength(0);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("validates exposure shape bounds", async () => {
    const { handle, repo } = await openRepo();
    try {
      const base = exposureOf();
      expect(() =>
        repo.recordMemoryExposure({ ...base, citation: "m0" }),
      ).toThrow(RepositoryValidationError);
      expect(() =>
        repo.recordMemoryExposure({ ...base, citation: "r1" }),
      ).toThrow(RepositoryValidationError);
      expect(() => repo.recordMemoryExposure({ ...base, scope: "" })).toThrow(
        RepositoryValidationError,
      );
      expect(() => repo.recordMemoryExposure({ ...base, snippet: "" })).toThrow(
        RepositoryValidationError,
      );
      expect(() =>
        repo.recordMemoryExposure({ ...base, snippet: "x".repeat(513) }),
      ).toThrow(RepositoryValidationError);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

describe("I04 revision-pinned memory evidence", () => {
  function exposureOf(
    overrides: {
      recallId?: string;
      recordId?: string;
      sessionId?: string;
      runId?: string;
      scope?: string;
      citation?: string;
      snippet?: string;
    } = {},
  ) {
    return {
      recallId: "recall-1",
      recordId: "record-1",
      sessionId: generateId(),
      runId: generateId(),
      scope: "test-scope",
      citation: "m1",
      snippet: "a recalled snippet",
      ...overrides,
    };
  }

  it("keeps pre-I04 exposure and grant rows with NULL revision through the 0022/0023 upgrade", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mem-i04-"));
    const backups = join(dir, "backups");
    const handle = openKernelDatabase(":memory:");
    try {
      // Build the pre-I04 database (through migration 0021) and seed
      // old-shape rows with raw SQL (the v21 repo API has no correction kind).
      await migrateKernelDatabase({ db: handle.raw, targetVersion: 21 });
      const sessionId = generateId();
      const runId = generateId();
      handle.raw
        .prepare(
          "INSERT INTO memory_exposures (recall_id, record_id, session_id, run_id, scope, citation, snippet, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          "recall-old",
          "record-old",
          sessionId,
          runId,
          "s",
          "m1",
          "old",
          T0,
        );
      handle.raw
        .prepare(
          "INSERT INTO memory_grants (run_id, citation, record_id, recall_id, session_id, scope, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(runId, "m1", "record-old", "recall-old", sessionId, "s", T0);
      // Upgrade to the bundled (0025) schema: 0022 correction-kind table
      // rebuild, 0023 additive remote_sessions, 0024 additive
      // remote_login_lockout, and 0025 additive ops-notification kind;
      // old rows survive with NULL revision/kind (never backfilled).
      const result = await migrateKernelDatabase({
        db: handle.raw,
        backupDir: backups,
      });
      expect(result.applied).toEqual([22, 23, 24, 25]);
      const repo = createKernelRepository(handle.raw);
      const exposures = repo.listMemoryExposures(runId);
      expect(exposures).toHaveLength(1);
      expect(exposures[0]).toMatchObject({
        recallId: "recall-old",
        recordId: "record-old",
        snippet: "old",
        revision: null,
        kind: null,
      });
      const grants = repo.listMemoryGrants(runId);
      expect(grants).toHaveLength(1);
      expect(grants[0]).toMatchObject({
        citation: "m1",
        recordId: "record-old",
        revision: null,
      });
      // New rows on the upgraded schema still pin a revision.
      repo.recordMemoryExposure(
        {
          recallId: "recall-new",
          recordId: "record-new",
          sessionId,
          runId,
          scope: "s",
          citation: "m2",
          snippet: "new",
          revision: 2,
          kind: "model_inference",
        },
        { now: T0 + 1 },
      );
      const fresh = repo
        .listMemoryExposures(runId)
        .find((item) => item.recallId === "recall-new");
      expect(fresh?.revision).toBe(2);
      expect(fresh?.kind).toBe("model_inference");
    } finally {
      closeKernelDatabase(handle);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves every exposure row through the 0022 rebuild and stores correction", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mem-kind22-"));
    const backups = join(dir, "backups");
    const handle = openKernelDatabase(":memory:");
    try {
      // Seed one row per pre-0022 kind (plus an unknown/NULL row) through
      // migration 0021, then upgrade: the rebuild must preserve all rows.
      await migrateKernelDatabase({ db: handle.raw, targetVersion: 21 });
      const sessionId = generateId();
      const runId = generateId();
      const seeds = [
        { recall: "recall-fact", kind: "user_fact", revision: 1 },
        { recall: "recall-inf", kind: "model_inference", revision: 2 },
        { recall: "recall-sum", kind: "summary", revision: 3 },
      ] as const;
      seeds.forEach(({ recall, kind, revision }, index) => {
        handle.raw
          .prepare(
            "INSERT INTO memory_exposures (recall_id, record_id, session_id, run_id, scope, citation, snippet, created_at, revision, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            recall,
            `record-${index}`,
            sessionId,
            runId,
            "s",
            `m${index + 1}`,
            `snippet ${kind}`,
            T0 + index,
            revision,
            kind,
          );
      });
      handle.raw
        .prepare(
          "INSERT INTO memory_exposures (recall_id, record_id, session_id, run_id, scope, citation, snippet, created_at, revision, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          "recall-null",
          "record-null",
          sessionId,
          runId,
          "s",
          "m9",
          "unknown provenance",
          T0 + 9,
          null,
          null,
        );
      const result = await migrateKernelDatabase({
        db: handle.raw,
        backupDir: backups,
      });
      // Bundled schema is 0025 (0022 rebuild + additive remote_sessions +
      // additive remote_login_lockout + additive ops-notification kind).
      expect(result.applied).toEqual([22, 23, 24, 25]);
      const repo = createKernelRepository(handle.raw);
      const exposures = repo.listMemoryExposures(runId);
      expect(exposures).toHaveLength(4);
      expect(
        exposures.map((item) => [item.recallId, item.kind, item.revision]),
      ).toEqual([
        ["recall-fact", "user_fact", 1],
        ["recall-inf", "model_inference", 2],
        ["recall-sum", "summary", 3],
        ["recall-null", null, null],
      ]);
      // A recalled correction now persists with its own kind (0022).
      repo.recordMemoryExposure(
        {
          recallId: "recall-correction",
          recordId: "record-correction",
          sessionId,
          runId,
          scope: "s",
          citation: "m4",
          snippet: "corrected text",
          revision: 4,
          kind: "correction",
        },
        { now: T0 + 10 },
      );
      const stored = repo
        .listMemoryExposures(runId)
        .find((item) => item.recallId === "recall-correction");
      expect(stored?.kind).toBe("correction");
      expect(stored?.revision).toBe(4);
      // The closed kind set still rejects anything outside it, at both the
      // repository boundary and the rebuilt CHECK constraint.
      const base = {
        recallId: "recall-bad",
        recordId: "record-bad",
        sessionId,
        runId,
        scope: "s",
        citation: "m5",
        snippet: "bad kind",
      };
      expect(() =>
        repo.recordMemoryExposure(
          { ...base, kind: "fact" as "summary" },
          { now: T0 + 11 },
        ),
      ).toThrow(RepositoryValidationError);
      expect(() =>
        handle.raw
          .prepare(
            "INSERT INTO memory_exposures (recall_id, record_id, session_id, run_id, scope, citation, snippet, created_at, revision, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            "recall-raw-bad",
            "record-raw-bad",
            sessionId,
            runId,
            "s",
            "m6",
            "raw bad kind",
            T0 + 12,
            null,
            "fact",
          ),
      ).toThrow();
      const indexes = handle.raw
        .prepare("PRAGMA index_list(memory_exposures)")
        .all() as Array<{ name: string }>;
      expect(indexes.map((index) => index.name)).toContain(
        "idx_memory_exposures_run",
      );
    } finally {
      closeKernelDatabase(handle);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pins the delivered revision/kind on the exposure and copies the revision into the grant", async () => {
    const { handle, repo } = await openRepo();
    try {
      const sessionId = generateId();
      const runId = generateId();
      repo.recordMemoryExposure(
        {
          recallId: "recall-1",
          recordId: "record-1",
          sessionId,
          runId,
          scope: "test-scope",
          citation: "m1",
          snippet: "delivered at revision 3",
          revision: 3,
          kind: "user_fact",
        },
        { now: T0 },
      );
      const exposures = repo.listMemoryExposures(runId);
      expect(exposures[0]?.revision).toBe(3);
      expect(exposures[0]?.kind).toBe("user_fact");
      repo.grantMemoryCitation(
        {
          runId,
          citation: "m1",
          recordId: "record-1",
          recallId: "recall-1",
          sessionId,
          scope: "test-scope",
        },
        { now: T0 + 1 },
      );
      // The grant is pinned to the DELIVERED revision copied from the
      // same-run exposure (not whatever the record looks like now).
      const grants = repo.listMemoryGrants(runId);
      expect(grants).toHaveLength(1);
      expect(grants[0]?.revision).toBe(3);
      // Replay with a drifted revision never rewrites the snapshot row:
      // exposures/grants are immutable after creation (F-I04-06).
      repo.recordMemoryExposure(
        {
          recallId: "recall-1",
          recordId: "record-1",
          sessionId,
          runId,
          scope: "test-scope",
          citation: "m9",
          snippet: "drifted",
          revision: 4,
        },
        { now: T0 + 2 },
      );
      const after = repo.listMemoryExposures(runId);
      expect(after).toHaveLength(1);
      expect(after[0]?.revision).toBe(3);
      expect(after[0]?.snippet).toBe("delivered at revision 3");
      // Exposure without provenance stores NULL (unknown), not zero.
      repo.recordMemoryExposure(
        {
          recallId: "recall-2",
          recordId: "record-2",
          sessionId,
          runId: generateId(),
          scope: "test-scope",
          citation: "m1",
          snippet: "no provenance",
        },
        { now: T0 + 3 },
      );
      const plain = repo.listMemoryGrants(runId);
      expect(plain).toHaveLength(1);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("pins later citations to a newer revision while the earlier grant keeps the old one", async () => {
    const { handle, repo } = await openRepo();
    try {
      const sessionId = generateId();
      const firstRunId = generateId();
      const secondRunId = generateId();
      // Run 1 delivers revision 3 and the answer cites m1.
      repo.recordMemoryExposure(
        {
          recallId: "recall-1",
          recordId: "record-1",
          sessionId,
          runId: firstRunId,
          scope: "test-scope",
          citation: "m1",
          snippet: "v3 text",
          revision: 3,
          kind: "user_fact",
        },
        { now: T0 },
      );
      repo.grantMemoryCitation(
        {
          runId: firstRunId,
          citation: "m1",
          recordId: "record-1",
          recallId: "recall-1",
          sessionId,
          scope: "test-scope",
        },
        { now: T0 + 1 },
      );
      // A correction makes revision 4; a later recall delivers it as a
      // NEW exposure row (new recallId; the old snapshot is untouched).
      repo.recordMemoryExposure(
        {
          recallId: "recall-2",
          recordId: "record-1",
          sessionId,
          runId: secondRunId,
          scope: "test-scope",
          citation: "m1",
          snippet: "v4 text",
          revision: 4,
          kind: "user_fact",
        },
        { now: T0 + 2 },
      );
      repo.grantMemoryCitation(
        {
          runId: secondRunId,
          citation: "m1",
          recordId: "record-1",
          recallId: "recall-2",
          sessionId,
          scope: "test-scope",
        },
        { now: T0 + 3 },
      );
      const firstGrant = repo
        .listMemoryGrants(firstRunId)
        .find((grant) => grant.citation === "m1");
      const secondGrant = repo
        .listMemoryGrants(secondRunId)
        .find((grant) => grant.citation === "m1");
      expect(firstGrant?.revision).toBe(3);
      expect(secondGrant?.revision).toBe(4);
      // Both exposure snapshots survive side by side, each pinned.
      const exposureByRun = [
        ...repo.listMemoryExposures(firstRunId),
        ...repo.listMemoryExposures(secondRunId),
      ];
      expect(exposureByRun.map((item) => item.revision).sort()).toEqual([3, 4]);
      expect(exposureByRun.map((item) => item.snippet).sort()).toEqual([
        "v3 text",
        "v4 text",
      ]);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("rejects invalid revisions and kinds at exposure time", async () => {
    const { handle, repo } = await openRepo();
    try {
      const base = exposureOf();
      expect(() => repo.recordMemoryExposure({ ...base, revision: 0 })).toThrow(
        RepositoryValidationError,
      );
      expect(() =>
        repo.recordMemoryExposure({ ...base, revision: -2 }),
      ).toThrow(RepositoryValidationError);
      expect(() =>
        repo.recordMemoryExposure({ ...base, revision: 1.5 }),
      ).toThrow(RepositoryValidationError);
      expect(() =>
        repo.recordMemoryExposure({ ...base, kind: "fact" as "summary" }),
      ).toThrow(RepositoryValidationError);
      // Valid boundaries are accepted.
      repo.recordMemoryExposure(
        { ...base, revision: 1, kind: "summary" },
        { now: T0 },
      );
      expect(repo.listMemoryExposures(base.runId)[0]?.revision).toBe(1);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
