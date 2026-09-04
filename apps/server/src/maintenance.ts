// Server maintenance helpers (§19.1-§19.2 operations).
//
// - Store size: DB + WAL combined bytes, warning-only above exactly 1 GiB.
//   No vacuum, no delete, no auto-shrink. Never logs the DB path.
// - No HTTP backup/restore/delete endpoints (CLI + documented manual
//   procedures only). No session delete/export. No telemetry/log files.

import { statSync } from "node:fs";

/** Warning threshold: strictly greater than 1 GiB warns (exact, §19.1). */
export const STORE_SIZE_WARN_BYTES = 1024 * 1024 * 1024;

export interface StoreSize {
  readonly dbBytes: number;
  readonly walBytes: number;
  readonly totalBytes: number;
}

export type StatFn = (path: string) => { size: number };

function safeSize(stat: StatFn, path: string): number {
  try {
    const size = stat(path).size;
    if (typeof size !== "number" || !Number.isFinite(size) || size < 0) {
      return 0;
    }
    return Math.floor(size);
  } catch {
    // Missing WAL/SHM sidecars report 0; a missing DB reports 0 here and
    // surfaces through the normal startup failure, not the size warning.
    return 0;
  }
}

function defaultStat(path: string): { size: number } {
  return statSync(path);
}

/**
 * Measure DB + WAL combined size. SHM is intentionally excluded (transient).
 * The stat function is injectable so tests never allocate a real 1 GiB file.
 * Never includes the DB path in any return value or log field.
 */
export function measureStoreSize(
  dbPath: string,
  stat: StatFn = defaultStat,
): StoreSize {
  const dbBytes = safeSize(stat, dbPath);
  const walBytes = safeSize(stat, `${dbPath}-wal`);
  return { dbBytes, walBytes, totalBytes: dbBytes + walBytes };
}

/** True only when total strictly exceeds 1 GiB (exact threshold). */
export function shouldWarnStoreSize(totalBytes: number): boolean {
  return totalBytes > STORE_SIZE_WARN_BYTES;
}
