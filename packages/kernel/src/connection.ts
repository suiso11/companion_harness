// Single better-sqlite3 connection factory + safe helpers.
//
// Exactly one better-sqlite3 connection exists per kernel instance: this
// factory creates it, applies the agreed PRAGMAs, and Drizzle wraps the
// SAME connection object (drizzle() never opens another connection).
// No connection pooling, no implicit connections elsewhere.

import Database from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { chmodSync } from "node:fs";
import { PragmasError, QuickCheckError } from "./errors.js";
import { kernelSchema } from "./schema.js";

export type KernelDrizzle = BetterSQLite3Database<typeof kernelSchema>;

export interface KernelDatabaseHandle {
  /** The single raw better-sqlite3 connection. */
  readonly raw: Database.Database;
  /** Drizzle wrapping the SAME connection (no additional connection). */
  readonly drizzle: KernelDrizzle;
  /** Filesystem path passed at open time (":memory:" for ephemeral DBs). */
  readonly path: string;
  /** journal_mode observed right after PRAGMA application. */
  readonly journalMode: string;
}

export interface KernelPragmas {
  journalMode: string;
  /** synchronous level: 1 == NORMAL. */
  synchronous: number;
  /** foreign_keys flag: 1 == ON. */
  foreignKeys: number;
  busyTimeoutMs: number;
}

/** Private POSIX file mode for the DB (0600). Windows: current-user ACL reliance. */
export const KERNEL_DB_FILE_MODE = 0o600;

/**
 * Apply 0600 to a file-backed DB path. No-op for :memory: and Windows.
 * Fail-closed: chmod failure closes nothing here; the caller maps it.
 */
export function applyPrivateDbFileMode(dbPath: string): void {
  if (dbPath === ":memory:" || process.platform === "win32") {
    return;
  }
  try {
    chmodSync(dbPath, KERNEL_DB_FILE_MODE);
  } catch (error) {
    throw new PragmasError("kernel database file permissions failed", {
      cause: error,
    });
  }
}
export const KERNEL_JOURNAL_MODE = "wal";
export const KERNEL_SYNCHRONOUS_NORMAL = 1;
export const KERNEL_BUSY_TIMEOUT_MS = 5000;

function readPragmas(raw: Database.Database): KernelPragmas {
  return {
    journalMode: String(
      raw.pragma("journal_mode", { simple: true }),
    ).toLowerCase(),
    synchronous: Number(raw.pragma("synchronous", { simple: true })),
    foreignKeys: Number(raw.pragma("foreign_keys", { simple: true })),
    busyTimeoutMs: Number(raw.pragma("busy_timeout", { simple: true })),
  };
}

/**
 * Open the single kernel connection and apply PRAGMAs:
 * journal_mode=WAL, foreign_keys=ON, synchronous=NORMAL, busy_timeout=5000.
 *
 * For ":memory:" databases journal_mode stays "memory" (SQLite has no WAL
 * for ephemeral DBs); that case is accepted and reported via
 * handle.journalMode. File-backed databases must land on WAL.
 *
 * @throws {PragmasError} when the applied PRAGMAs do not read back.
 */
export function openKernelDatabase(dbPath: string): KernelDatabaseHandle {
  const raw: Database.Database = new Database(dbPath);
  try {
    raw.pragma("journal_mode = WAL");
    raw.pragma("synchronous = NORMAL");
    raw.pragma("foreign_keys = ON");
    raw.pragma(`busy_timeout = ${KERNEL_BUSY_TIMEOUT_MS}`);
    const applied = readPragmas(raw);
    const isMemory = dbPath === ":memory:";
    if (!isMemory && applied.journalMode !== KERNEL_JOURNAL_MODE) {
      throw new PragmasError("kernel PRAGMA journal_mode verification failed");
    }
    if (applied.synchronous !== KERNEL_SYNCHRONOUS_NORMAL) {
      throw new PragmasError("kernel PRAGMA synchronous verification failed");
    }
    if (applied.foreignKeys !== 1) {
      throw new PragmasError("kernel PRAGMA foreign_keys verification failed");
    }
    if (applied.busyTimeoutMs !== KERNEL_BUSY_TIMEOUT_MS) {
      throw new PragmasError("kernel PRAGMA busy_timeout verification failed");
    }
    const wrapped: KernelDrizzle = drizzle(raw, { schema: kernelSchema });
    // Private POSIX permissions (0600) for file-backed DBs. No-op on
    // :memory:/Windows. Fail-closed: chmod failure aborts open.
    if (!isMemory) {
      try {
        applyPrivateDbFileMode(dbPath);
      } catch (error) {
        raw.close();
        throw error;
      }
    }
    return { raw, drizzle: wrapped, path: dbPath, journalMode: applied.journalMode };
  } catch (error) {
    raw.close();
    throw error;
  }
}

/** Current PRAGMA readings for an open kernel connection. */
export function getKernelPragmas(handle: KernelDatabaseHandle): KernelPragmas {
  return readPragmas(handle.raw);
}

/**
 * Run `PRAGMA quick_check` and return "ok".
 *
 * @throws {QuickCheckError} when integrity issues are reported.
 */
export function quickCheck(raw: Database.Database): "ok" {
  const rows = raw.prepare("PRAGMA quick_check").all() as Array<
    Record<string, unknown>
  >;
  const details = rows
    .map((row) => String(Object.values(row)[0]))
    .filter((value) => value !== "ok");
  if (details.length > 0 || rows.length === 0) {
    throw new QuickCheckError(details);
  }
  return "ok";
}

/** Idempotent close of the single kernel connection. */
export function closeKernelDatabase(handle: KernelDatabaseHandle): void {
  if (handle.raw.open) {
    handle.raw.close();
  }
}
