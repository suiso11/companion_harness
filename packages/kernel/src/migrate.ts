// Schema migration / version management for the M0+M1 kernel store.
//
// - Versions are tracked with `PRAGMA user_version`.
// - The bundled version is BUNDLED_SCHEMA_VERSION (2 for M1).
// - Startup rule: a database NEWER than the bundle fails BEFORE any
//   migration work (no backup, no writes). An EQUAL version is a no-op
//   without a backup. An OLDER database with user tables requires a
//   valid pre-upgrade backup (backup API -> .partial -> quick_check ->
//   atomic rename) BEFORE any migration SQL runs; the initial empty DB
//   (user_version 0, no tables) migrates without a backup.
// - Only committed SQL files (NNNN_name.sql, ascending) are applied, in
//   order, inside one transaction per file. Runtime schema pushes via the
//   external kit CLI are never used.
// - Migration failure keeps the pre-upgrade backup and throws.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { createPreMigrationBackup } from "./backup.js";
import {
  BackupRequiredError,
  MigrationFailedError,
  MigrationMissingError,
  NewerDatabaseError,
} from "./errors.js";

/** Bundled M1 schema version. Bump only with a new committed migration. */
export const BUNDLED_SCHEMA_VERSION = 3;

export interface BundledMigration {
  version: number;
  file: string;
}

export interface MigrateOptions {
  /** Open kernel connection (single connection; caller owns lifetime). */
  db: Database.Database;
  /**
   * Backups directory for pre-upgrade backups. Required when upgrading a
   * database that already holds user tables; unused for fresh/equal DBs.
   */
  backupDir?: string;
  /** Override for tests. Defaults to packages/kernel/migrations. */
  migrationsDir?: string;
  /** Override for tests. Defaults to BUNDLED_SCHEMA_VERSION. */
  targetVersion?: number;
  /** Injected clock for deterministic backup names in tests. */
  now?: Date;
  /** Injected id for deterministic backup names in tests. */
  backupId?: string;
}

export interface MigrateResult {
  migrated: boolean;
  fromVersion: number;
  toVersion: number;
  backupPath?: string;
  applied: number[];
}

export function defaultMigrationsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
}

/** Committed NNNN_name.sql migrations in ascending version order. */
export function listMigrations(migrationsDir: string): BundledMigration[] {
  const entries = readdirSync(migrationsDir);
  const found: BundledMigration[] = [];
  for (const entry of entries) {
    const match = /^(\d+)_.+\.sql$/.exec(entry);
    if (match?.[1] === undefined) {
      continue;
    }
    found.push({ version: Number(match[1]), file: entry });
  }
  found.sort((a, b) => a.version - b.version);
  return found;
}

export function getSchemaVersion(db: Database.Database): number {
  return Number(db.pragma("user_version", { simple: true }));
}

export function setSchemaVersion(db: Database.Database, version: number): void {
  if (!Number.isInteger(version) || version < 0) {
    throw new RangeError(`invalid schema version: ${version}`);
  }
  db.exec(`PRAGMA user_version = ${version}`);
}

/** True once any user table exists (fresh empty DBs report false). */
export function hasUserTables(db: Database.Database): boolean {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .get() as { n: number };
  return row.n > 0;
}

export async function migrateKernelDatabase(
  options: MigrateOptions,
): Promise<MigrateResult> {
  const { db } = options;
  const migrationsDir = options.migrationsDir ?? defaultMigrationsDir();
  const target = options.targetVersion ?? BUNDLED_SCHEMA_VERSION;
  const current = getSchemaVersion(db);

  // Fail BEFORE migration on a newer DB: no backup, no writes.
  if (current > target) {
    throw new NewerDatabaseError(current, target);
  }
  // Equal version: no backup, no migration.
  if (current === target) {
    return {
      migrated: false,
      fromVersion: current,
      toVersion: target,
      applied: [],
    };
  }

  const available = listMigrations(migrationsDir);
  const pending = available.filter(
    (entry) => entry.version > current && entry.version <= target,
  );
  for (let version = current + 1; version <= target; version += 1) {
    if (!pending.some((entry) => entry.version === version)) {
      throw new MigrationMissingError(current, target);
    }
  }

  // Older DBs with content require a valid backup BEFORE migration.
  // The initial empty DB (version 0, no tables) migrates without one.
  let backupPath: string | undefined;
  if (hasUserTables(db)) {
    if (options.backupDir === undefined) {
      throw new BackupRequiredError();
    }
    backupPath = await createPreMigrationBackup({
      source: db,
      backupDir: options.backupDir,
      fromVersion: current,
      toVersion: target,
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.backupId !== undefined ? { backupId: options.backupId } : {}),
    });
  }

  const applied: number[] = [];
  try {
    for (const entry of pending) {
      const sqlText = readFileSync(join(migrationsDir, entry.file), "utf8");
      // Each file commits its own user_version inside the same transaction
      // so a failure after version N leaves user_version=N and a retry
      // resumes at N+1 instead of replaying committed migrations.
      const apply = db.transaction(() => {
        db.exec(sqlText);
        db.exec(`PRAGMA user_version = ${entry.version}`);
        applied.push(entry.version);
      });
      apply();
    }
  } catch (error) {
    // The pre-upgrade backup (if any) is deliberately kept.
    throw new MigrationFailedError(
      `migration ${current} -> ${target} failed after applying [${applied.join(", ")}]`,
      { cause: error },
    );
  }
  return {
    migrated: true,
    fromVersion: current,
    toVersion: target,
    ...(backupPath !== undefined ? { backupPath } : {}),
    applied,
  };
}
