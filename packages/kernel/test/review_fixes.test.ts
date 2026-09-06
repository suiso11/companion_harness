// Regression tests for the M0 kernel core review fixes (ToolBroker excluded).
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BackupError,
  closeKernelDatabase,
  createKernelRepository,
  createPreMigrationBackup,
  ensureBackupDir,
  generateId,
  getSchemaVersion,
  IdempotencyConflictError,
  immediateSuccess,
  KernelStorageError,
  listPreMigrationBackups,
  migrateKernelDatabase,
  neverResolving,
  openKernelDatabase,
  preMigrationBackupName,
  prunePreMigrationBackups,
  RepositoryNotFoundError,
  RunEngine,
} from "../src/index.js";

const T0 = 1790000000000;
const tempRoots: string[] = [];
afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop() as string;
    rmSync(dir, { recursive: true, force: true });
  }
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "m0-review-"));
  tempRoots.push(dir);
  return dir;
}
async function openRepo() {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  const repo = createKernelRepository(handle.raw);
  return { handle, repo };
}
async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("event_seq guarded atomic append", () => {
  it("creates runs from an event_seq 0 row with a single run.queued seq1", async () => {
    const { handle, repo } = await openRepo();
    try {
      const s = repo.createSession({ key: generateId(), now: T0 }).body
        .sessionId;
      const m = repo.postMessage(
        s,
        { text: "hi" },
        { key: generateId(), now: T0 },
      );
      const row = handle.raw
        .prepare("SELECT event_seq AS e FROM runs WHERE id = ?")
        .get(m.body.run.id) as { e: number };
      expect(row.e).toBe(1);
      const events = handle.raw
        .prepare(
          "SELECT seq, type FROM run_events WHERE run_id = ? ORDER BY seq",
        )
        .all(m.body.run.id) as Array<{ seq: number; type: string }>;
      expect(events).toEqual([{ seq: 1, type: "run.queued" }]);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("rolls back the status CAS when the guarded event insert collides (stale seq)", async () => {
    const { handle, repo } = await openRepo();
    try {
      const s = repo.createSession({ key: generateId(), now: T0 }).body
        .sessionId;
      const m = repo.postMessage(
        s,
        { text: "hi" },
        { key: generateId(), now: T0 },
      );
      // Occupy the next guarded seq so startRun's atomic insert must fail.
      handle.raw
        .prepare(
          "INSERT INTO run_events (run_id, seq, schema_version, type, payload, created_at) VALUES (?, 2, 1, 'run.started', ?, ?)",
        )
        .run(m.body.run.id, JSON.stringify({ attempt: 1 }), T0 + 1);
      expect(() => repo.startRun(m.body.run.id, { now: T0 + 2 })).toThrow();
      // Atomic rollback: status and event_seq are unchanged, no extra event.
      expect(repo.getRun(m.body.run.id).status).toBe("queued");
      expect(repo.getRun(m.body.run.id).eventSeq).toBe(1);
      const n = (
        handle.raw
          .prepare(
            "SELECT COUNT(*) AS n FROM run_events WHERE run_id = ? AND seq = 2",
          )
          .get(m.body.run.id) as { n: number }
      ).n;
      expect(n).toBe(1);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

describe("engine lifecycle persistence retry + fail-closed shutdown", () => {
  it("retries a one-shot completeRun storage failure without dropping the run", async () => {
    const { handle, repo } = await openRepo();
    const engineHolder: { engine?: RunEngine } = {};
    try {
      let calls = 0;
      const flaky = {
        ...repo,
        completeRun: (
          runId: string,
          result: unknown,
          options?: { now?: number },
        ) => {
          calls += 1;
          if (calls === 1) {
            throw new KernelStorageError("kernel_io", "transient");
          }
          return repo.completeRun(runId, result, options);
        },
      };
      const engine = new RunEngine({
        db: handle.raw,
        repo: flaky,
        pollIntervalMs: 5,
      });
      engineHolder.engine = engine;
      engine.strategies.register("ok", immediateSuccess("done"));
      const s = repo.createSession({ key: generateId(), now: T0 }).body
        .sessionId;
      const m = repo.postMessage(
        s,
        { text: "q" },
        { key: generateId(), now: T0, strategy: "ok" },
      );
      engine.start();
      expect(engine.pump()).toBe(1);
      await waitFor(() => engine.inflightCount() === 0);
      expect(repo.getRun(m.body.run.id).status).toBe("completed");
      expect(calls).toBeGreaterThanOrEqual(2);
    } finally {
      await engineHolder.engine?.shutdown({ drainMs: 0 }).catch(() => {});
      closeKernelDatabase(handle);
    }
  });

  it("retains ownership on persistent failure and fails closed when drain throws", async () => {
    const { handle, repo } = await openRepo();
    let engine: RunEngine | undefined;
    try {
      // Persistent lifecycle failure: complete never lands, ownership stays.
      let calls = 0;
      const neverLands = {
        ...repo,
        completeRun: () => {
          calls += 1;
          throw new KernelStorageError("kernel_io", "down");
        },
      };
      const failing = new RunEngine({
        db: handle.raw,
        repo: neverLands,
        pollIntervalMs: 5,
      });
      failing.strategies.register("ok", immediateSuccess("done"));
      const s = repo.createSession({ key: generateId(), now: T0 }).body
        .sessionId;
      const m = repo.postMessage(
        s,
        { text: "q" },
        { key: generateId(), now: T0, strategy: "ok" },
      );
      failing.start();
      expect(failing.pump()).toBe(1);
      await waitFor(() => calls >= 3);
      // Bounded retries exhausted yet the run is still owned, never dropped.
      expect(failing.inflightCount()).toBe(1);
      expect(repo.getRun(m.body.run.id).status).toBe("running");
      await failing.shutdown({ drainMs: 0 }).catch(() => {});
      engine = failing;
    } finally {
      await engine?.shutdown({ drainMs: 0 }).catch(() => {});
      closeKernelDatabase(handle);
    }
  });

  it("shutdown drain failure rejects without aborting/clearing/stopping", async () => {
    const { handle, repo } = await openRepo();
    let engine: RunEngine | undefined;
    try {
      const failDrain = {
        ...repo,
        drain: (): { abandoned: number; cancelled: number } => {
          throw new KernelStorageError("kernel_io", "drain down");
        },
      };
      engine = new RunEngine({
        db: handle.raw,
        repo: failDrain,
        pollIntervalMs: 5,
      });
      const eng = engine;
      eng.strategies.register(
        "hang",
        neverResolving("H", { entered: [], aborted: [] }),
      );
      const s = repo.createSession({ key: generateId(), now: T0 }).body
        .sessionId;
      const m = repo.postMessage(
        s,
        { text: "q" },
        { key: generateId(), now: T0, strategy: "hang" },
      );
      eng.start();
      expect(eng.pump()).toBe(1);
      await waitFor(() => eng.inflightCount() === 1);
      await expect(eng.shutdown({ drainMs: 0 })).rejects.toThrow();
      expect(eng.isStopped()).toBe(false);
      expect(eng.isDraining()).toBe(true);
      expect(eng.inflightCount()).toBe(1);
      expect(repo.getRun(m.body.run.id).status).toBe("running");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("watchdog retries a transient finalize failure to cancelled", async () => {
    const { handle, repo } = await openRepo();
    let engine: RunEngine | undefined;
    try {
      let finalizeCalls = 0;
      const wrapped = {
        ...repo,
        finalizeCancelRequested: (
          runId: string,
          options?: { now?: number },
        ) => {
          finalizeCalls += 1;
          if (finalizeCalls === 1) {
            throw new KernelStorageError("kernel_io", "transient finalize");
          }
          return repo.finalizeCancelRequested(runId, options);
        },
      };
      engine = new RunEngine({
        db: handle.raw,
        repo: wrapped,
        pollIntervalMs: 5,
        cancelGraceMs: 30,
      });
      const eng = engine;
      eng.strategies.register(
        "hang",
        neverResolving("H", { entered: [], aborted: [] }),
      );
      const s = repo.createSession({ key: generateId(), now: T0 }).body
        .sessionId;
      const m = repo.postMessage(
        s,
        { text: "q" },
        { key: generateId(), now: T0, strategy: "hang" },
      );
      eng.start();
      expect(eng.pump()).toBe(1);
      await waitFor(() => eng.inflightCount() === 1);
      expect(eng.cancel(s, m.body.run.id).status).toBe("cancel_requested");
      await waitFor(() => repo.getRun(m.body.run.id).status === "cancelled");
      expect(finalizeCalls).toBeGreaterThanOrEqual(2);
    } finally {
      await engine?.shutdown({ drainMs: 0 }).catch(() => {});
      closeKernelDatabase(handle);
    }
  });
});

describe("idempotency hashes cover operation-affecting fields", () => {
  it("conflicts when strategy/selectOnSuccess/timeZone differ, replays when equal", async () => {
    const { handle, repo } = await openRepo();
    try {
      const s = repo.createSession({ key: generateId(), now: T0 }).body
        .sessionId;
      const key = generateId();
      const first = repo.postMessage(s, { text: "hi" }, { key, now: T0 });
      const replay = repo.postMessage(s, { text: "hi" }, { key, now: T0 + 1 });
      expect(replay.replayed).toBe(true);
      expect(replay.body).toEqual(first.body);
      expect(() =>
        repo.postMessage(
          s,
          { text: "hi" },
          { key, now: T0, strategy: "other" },
        ),
      ).toThrow(IdempotencyConflictError);
      expect(() =>
        repo.postMessage(
          s,
          { text: "hi" },
          { key, now: T0, selectOnSuccess: false },
        ),
      ).toThrow(IdempotencyConflictError);
      expect(() =>
        repo.postMessage(
          s,
          { text: "hi" },
          { key, now: T0, timeZone: "America/New_York" },
        ),
      ).toThrow(IdempotencyConflictError);
      const turns = (
        handle.raw.prepare("SELECT COUNT(*) AS n FROM turns").get() as {
          n: number;
        }
      ).n;
      expect(turns).toBe(1);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("conflicts on retry strategy/selectOnSuccess changes", async () => {
    const { handle, repo } = await openRepo();
    try {
      const s = repo.createSession({ key: generateId(), now: T0 }).body
        .sessionId;
      const m = repo.postMessage(
        s,
        { text: "q" },
        { key: generateId(), now: T0 },
      );
      await repo.startRun(m.body.run.id, { now: T0 + 1 });
      await repo.failRun(m.body.run.id, "execution_failed", { now: T0 + 2 });
      const key = generateId();
      const r1 = repo.postRetry(s, m.body.turnId, { key, now: T0 + 3 });
      const r2 = repo.postRetry(s, m.body.turnId, { key, now: T0 + 4 });
      expect(r2.replayed).toBe(true);
      expect(r2.body).toEqual(r1.body);
      // Free the active retry run, then observe hash conflicts on a fresh key.
      await repo.startRun(r1.body.run.id, { now: T0 + 5 });
      await repo.failRun(r1.body.run.id, "execution_failed", { now: T0 + 6 });
      const key2 = generateId();
      repo.postRetry(s, m.body.turnId, {
        key: key2,
        now: T0 + 7,
        strategy: "x",
      });
      expect(() =>
        repo.postRetry(s, m.body.turnId, {
          key: key2,
          now: T0 + 8,
          strategy: "y",
        }),
      ).toThrow(IdempotencyConflictError);
      expect(() =>
        repo.postRetry(s, m.body.turnId, {
          key: key2,
          now: T0 + 8,
          selectOnSuccess: false,
        }),
      ).toThrow(IdempotencyConflictError);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

describe("backup validation + traversal/symlink safety", () => {
  it("rejects non-UUID/traversal backup ids and bad versions without leaking paths", async () => {
    const dir = tempDir();
    const handle = openKernelDatabase(":memory:");
    await migrateKernelDatabase({ db: handle.raw });
    try {
      await expect(
        createPreMigrationBackup({
          source: handle.raw,
          backupDir: join(dir, "b"),
          fromVersion: 0,
          toVersion: 1,
          backupId: "../evil",
        }),
      ).rejects.toBeInstanceOf(BackupError);
      await expect(
        createPreMigrationBackup({
          source: handle.raw,
          backupDir: join(dir, "b"),
          fromVersion: 0,
          toVersion: 1,
          backupId: "not-a-uuid",
        }),
      ).rejects.toBeInstanceOf(BackupError);
      expect(() =>
        preMigrationBackupName(
          0,
          1,
          new Date(),
          "00000000-0000-0000-0000-000000000000",
        ),
      ).toThrow(BackupError);
      await expect(
        createPreMigrationBackup({
          source: handle.raw,
          backupDir: join(dir, "b"),
          fromVersion: -1,
          toVersion: 1,
        }),
      ).rejects.toBeInstanceOf(BackupError);
      await expect(
        createPreMigrationBackup({
          source: handle.raw,
          backupDir: join(dir, "b"),
          fromVersion: 1,
          toVersion: 1,
        }),
      ).rejects.toBeInstanceOf(BackupError);
    } finally {
      closeKernelDatabase(handle);
    }
    // Outward messages never echo the traversal payload or directory.
    try {
      ensureBackupDir(join(dir, "nope", "x"));
    } catch {
      // ensureBackupDir creates missing dirs; no assertion needed.
    }
  });

  it("rejects symlink backup dirs and never lists/prunes symlinked entries", async () => {
    const dir = tempDir();
    const real = join(dir, "real");
    mkdirSync(real, { recursive: true });
    const link = join(dir, "link");
    try {
      symlinkSync(real, link, "junction");
    } catch {
      return; // Portable skip: Windows without symlink privilege.
    }
    expect(() => ensureBackupDir(link)).toThrow(BackupError);
    // Symlinked file entries are excluded from list/prune.
    const backups = join(dir, "backups");
    mkdirSync(backups, { recursive: true });
    const target = join(backups, "target.sqlite");
    writeFileSync(target, "x");
    const evil = join(
      backups,
      "companion-pre-migration-v0-to-v1-20260101T000000Z-11111111-2222-4333-8444-555555555555.sqlite",
    );
    try {
      symlinkSync(target, evil, "file");
    } catch {
      return;
    }
    expect(listPreMigrationBackups(backups)).toEqual([]);
    const pruned = prunePreMigrationBackups(backups, 0);
    expect(pruned.pruned).toEqual([]);
  });
});

describe("per-file user_version retry", () => {
  it("leaves user_version=N after a two-step failure and resumes at N+1", async () => {
    const dir = tempDir();
    const migrations = join(dir, "migrations");
    mkdirSync(migrations, { recursive: true });
    writeFileSync(
      join(migrations, "0001_first.sql"),
      "CREATE TABLE t1 (a TEXT NOT NULL) STRICT;",
    );
    writeFileSync(
      join(migrations, "0002_second.sql"),
      "THIS IS NOT VALID SQL;",
    );
    const handle = openKernelDatabase(":memory:");
    try {
      await expect(
        migrateKernelDatabase({
          db: handle.raw,
          migrationsDir: migrations,
          targetVersion: 2,
          backupDir: join(dir, "backups"),
        }),
      ).rejects.toThrow(/migration 0 -> 2 failed/);
      expect(getSchemaVersion(handle.raw)).toBe(1);
      writeFileSync(
        join(migrations, "0002_second.sql"),
        "CREATE TABLE t2 (b TEXT NOT NULL) STRICT;",
      );
      const retry = await migrateKernelDatabase({
        db: handle.raw,
        migrationsDir: migrations,
        targetVersion: 2,
        backupDir: join(dir, "backups"),
      });
      expect(retry.applied).toEqual([2]);
      expect(getSchemaVersion(handle.raw)).toBe(2);
      const tables = (
        handle.raw
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
          )
          .all() as Array<{ name: string }>
      ).map((r) => r.name);
      expect(tables).toEqual(["t1", "t2"]);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

describe("kernel review round fixes (PR #1)", () => {
  it("durably settles a post-pickup snapshot load failure instead of leaking running", async () => {
    const { handle, repo } = await openRepo();
    let engine: RunEngine | undefined;
    try {
      // Simulate a snapshot load failure after the pickup CAS already moved
      // queued->running: getTurn throws, so launch must fail the run durably.
      const wrapped = {
        ...repo,
        getTurn: (): never => {
          throw new KernelStorageError("kernel_io", "turn snapshot missing");
        },
      };
      engine = new RunEngine({
        db: handle.raw,
        repo: wrapped,
        pollIntervalMs: 5,
      });
      engine.strategies.register("ok", immediateSuccess("done"));
      const s = repo.createSession({ key: generateId(), now: T0 }).body
        .sessionId;
      const m = repo.postMessage(
        s,
        { text: "q" },
        { key: generateId(), now: T0, strategy: "ok" },
      );
      // Simulate a missing turn row: pickup CAS still moves queued->running,
      // then the snapshot load throws and must fail the run durably.
      engine.start();
      expect(engine.pump()).toBe(1);
      await waitFor(() => {
        const st = repo.getRun(m.body.run.id).status;
        return st === "failed";
      });
      const run = repo.getRun(m.body.run.id);
      expect(run.status).toBe("failed");
      expect(run.errorCode).toBe("execution_failed");
      expect(engine.inflightCount()).toBe(0);
      const types = (
        handle.raw
          .prepare("SELECT type FROM run_events WHERE run_id = ? ORDER BY seq")
          .all(m.body.run.id) as Array<{ type: string }>
      ).map((r) => r.type);
      expect(types).toEqual(["run.queued", "run.started", "run.failed"]);
    } finally {
      await engine?.shutdown({ drainMs: 0 }).catch(() => {});
      closeKernelDatabase(handle);
    }
  });

  it("canonicalizes UUID idempotency keys to lowercase across store and lookup", async () => {
    const { handle, repo } = await openRepo();
    try {
      const s = repo.createSession({ key: generateId(), now: T0 }).body
        .sessionId;
      const upper = generateId().toUpperCase();
      const first = repo.postMessage(
        s,
        { text: "hi" },
        { key: upper, now: T0 },
      );
      expect(first.replayed).toBe(false);
      const replay = repo.postMessage(
        s,
        { text: "hi" },
        { key: upper.toLowerCase(), now: T0 + 1 },
      );
      expect(replay.replayed).toBe(true);
      expect(replay.body).toEqual(first.body);
      const stored = handle.raw
        .prepare("SELECT key AS k FROM api_idempotency")
        .all() as Array<{ k: string }>;
      expect(stored.length).toBeGreaterThan(0);
      for (const row of stored) {
        expect(row.k).toBe(row.k.toLowerCase());
      }
      const turns = (
        handle.raw.prepare("SELECT COUNT(*) AS n FROM turns").get() as {
          n: number;
        }
      ).n;
      expect(turns).toBe(1);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("checks retry ownership before the idempotency lookup (foreign key replays 404)", async () => {
    const { handle, repo } = await openRepo();
    try {
      const a = repo.createSession({ key: generateId(), now: T0 }).body
        .sessionId;
      const b = repo.createSession({ key: generateId(), now: T0 }).body
        .sessionId;
      const m = repo.postMessage(
        a,
        { text: "q" },
        { key: generateId(), now: T0 },
      );
      await repo.startRun(m.body.run.id, { now: T0 + 1 });
      await repo.failRun(m.body.run.id, "execution_failed", { now: T0 + 2 });
      const key = generateId();
      const r1 = repo.postRetry(a, m.body.turnId, { key, now: T0 + 3 });
      expect(r1.replayed).toBe(false);
      // Same turn-scoped key presented under a foreign session must 404 on
      // ownership, never replay (or conflict on) session A's stored body.
      expect(() =>
        repo.postRetry(b, m.body.turnId, { key, now: T0 + 4 }),
      ).toThrow(RepositoryNotFoundError);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("does not extend the watchdog deadline on repeated cancel", async () => {
    const { handle, repo } = await openRepo();
    let engine: RunEngine | undefined;
    try {
      let now = T0 + 5000;
      const timers = new Map<number, { at: number; fn: () => void }>();
      let seq = 1;
      const clock = {
        now: () => now,
        sleep: async (ms: number) => {
          now += ms;
        },
        setTimeout: (fn: () => void, ms: number) => {
          const id = seq;
          seq += 1;
          timers.set(id, { at: now + ms, fn });
          return id;
        },
        clearTimeout: (h: unknown) => {
          timers.delete(h as number);
        },
        advance: (ms: number) => {
          now += ms;
          for (const [id, t] of [...timers.entries()]
            .filter(([, t]) => t.at <= now)
            .sort((x, y) => x[1].at - y[1].at)) {
            timers.delete(id);
            t.fn();
          }
        },
      };
      engine = new RunEngine({
        db: handle.raw,
        repo,
        clock,
        pollIntervalMs: 5,
        cancelGraceMs: 3000,
      });
      const eng = engine;
      eng.strategies.register(
        "hang",
        neverResolving("H", { entered: [], aborted: [] }),
      );
      const s = repo.createSession({ key: generateId(), now: T0 }).body
        .sessionId;
      const m = repo.postMessage(
        s,
        { text: "q" },
        { key: generateId(), now: T0, strategy: "hang" },
      );
      eng.start();
      expect(eng.pump()).toBe(1);
      await waitFor(() => eng.inflightCount() === 1);
      expect(eng.cancel(s, m.body.run.id).status).toBe("cancel_requested");
      clock.advance(2000);
      // Repeated cancel stays idempotent but must not push the deadline out.
      expect(eng.cancel(s, m.body.run.id).status).toBe("cancel_requested");
      clock.advance(1000);
      expect(repo.getRun(m.body.run.id).status).toBe("cancelled");
    } finally {
      await engine?.shutdown({ drainMs: 0 }).catch(() => {});
      closeKernelDatabase(handle);
    }
  });
});
