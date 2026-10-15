// Conversation-memory durable state (migration 0006): outbox queue
// transitions, stable-key dedup, exposure snapshots, citation grants.
//
// Every assertion reads actual SQL rows back through the repository (or a
// direct COUNT for row-absence): no source-text or mock-echo checks. The
// remind database is never touched here; these tables are Companion-owned
// staging only.

import { randomUUID } from "node:crypto";
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
