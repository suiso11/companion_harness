// Pre-upgrade backup via the better-sqlite3 backup API only.
//
// Procedure (exact, §19.2): `.partial` backup -> `quick_check` of the copy
// -> atomic rename to the final name. Any failure (backup, quick_check,
// rename, prune) aborts the caller: migrate.ts will not migrate without a
// valid backup.
//
// - Final name: companion-pre-migration-v<from>-to-v<to>-<UTC>-<uuid>.sqlite
//   where <UTC> is YYYYMMDDTHHMMSSZ.
// - Rotation: after each valid atomic backup, keep the newest 3 files with
//   the exact `companion-pre-migration-` prefix. Manual backups
//   (`companion-manual-*`) are never touched.
// - Symlink-safe: the backups directory itself must not be a symlink, and
//   rotation never follows or deletes symlinked entries.
// - No VACUUM, no file copy, no automatic domain deletion.

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { quickCheck } from "./connection.js";
import { BackupError } from "./errors.js";

export const PRE_MIGRATION_PREFIX = "companion-pre-migration-";
export const PRE_MIGRATION_SUFFIX = ".sqlite";
export const PRE_MIGRATION_PARTIAL_SUFFIX = ".partial";
export const PRE_MIGRATION_KEEP_GENERATIONS = 3;

/** YYYYMMDDTHHMMSSZ, e.g. 20260904T035959Z. */
export function formatBackupUtc(now: Date): string {
  return now
    .toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(/\..+$/, "Z");
}

export function preMigrationBackupName(
  fromVersion: number,
  toVersion: number,
  now: Date,
  backupId: string,
): string {
  return `${PRE_MIGRATION_PREFIX}v${fromVersion}-to-v${toVersion}-${formatBackupUtc(now)}-${backupId}${PRE_MIGRATION_SUFFIX}`;
}

/**
 * Ensure the backups directory exists and is not a symlink.
 *
 * @throws {BackupError} when the path is (or resolves through) a symlink.
 */
export function ensureBackupDir(backupDir: string): string {
  let stat;
  try {
    stat = lstatSync(backupDir);
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
    ) {
      mkdirSync(backupDir, { recursive: true });
      stat = lstatSync(backupDir);
    } else {
      throw new BackupError(`cannot stat backup directory: ${backupDir}`, {
        cause: error,
      });
    }
  }
  if (!stat.isDirectory()) {
    throw new BackupError(`backup path is not a directory: ${backupDir}`);
  }
  if (stat.isSymbolicLink()) {
    throw new BackupError(`backup directory must not be a symlink: ${backupDir}`);
  }
  return backupDir;
}

export interface PreMigrationBackupOptions {
  /** Open source handle. The SOLE copy method is its backup() API. */
  source: Database.Database;
  backupDir: string;
  fromVersion: number;
  toVersion: number;
  /** Injectable for deterministic tests. Defaults to new Date(). */
  now?: Date;
  /** Injectable for deterministic tests. Defaults to randomUUID(). */
  backupId?: string;
}

/**
 * Take a pre-migration backup: backup API -> .partial file, quick_check
 * the copy, atomic rename to the final name, then 3-generation rotation.
 *
 * @returns the final backup file path.
 * @throws {BackupError} on any backup/quick_check/rename/prune failure.
 */
export async function createPreMigrationBackup(
  options: PreMigrationBackupOptions,
): Promise<string> {
  const { source, backupDir, fromVersion, toVersion } = options;
  const now = options.now ?? new Date();
  const backupId = options.backupId ?? randomUUID();
  ensureBackupDir(backupDir);
  const finalName = preMigrationBackupName(
    fromVersion,
    toVersion,
    now,
    backupId,
  );
  const finalPath = join(backupDir, finalName);
  const partialPath = `${finalPath}${PRE_MIGRATION_PARTIAL_SUFFIX}`;

  try {
    try {
      unlinkSync(partialPath);
    } catch {
      // Best effort: stale partials must not block a fresh backup.
    }
    // SOLE copy method: the online backup API. No VACUUM INTO, no copy.
    await source.backup(partialPath);
    const copy = new Database(partialPath, { readonly: true });
    try {
      quickCheck(copy);
    } finally {
      copy.close();
    }
    renameSync(partialPath, finalPath);
  } catch (error) {
    try {
      unlinkSync(partialPath);
    } catch {
      // Best effort cleanup of the unverified partial.
    }
    throw new BackupError(`pre-migration backup failed: ${finalName}`, {
      cause: error,
    });
  }
  try {
    prunePreMigrationBackups(backupDir, PRE_MIGRATION_KEEP_GENERATIONS);
  } catch (error) {
    throw new BackupError("pre-migration backup rotation failed", {
      cause: error,
    });
  }
  return finalPath;
}

interface BackupCandidate {
  path: string;
  name: string;
  mtimeMs: number;
}

/** Newest-first list of valid pre-migration backup files (symlinks excluded). */
export function listPreMigrationBackups(backupDir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(backupDir);
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }
  const candidates: BackupCandidate[] = [];
  for (const name of entries) {
    if (
      !name.startsWith(PRE_MIGRATION_PREFIX) ||
      !name.endsWith(PRE_MIGRATION_SUFFIX) ||
      name.endsWith(`${PRE_MIGRATION_SUFFIX}${PRE_MIGRATION_PARTIAL_SUFFIX}`)
    ) {
      continue;
    }
    const path = join(backupDir, name);
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      continue;
    }
    // Symlink-safe: never follow or count symlinked entries.
    if (stat.isSymbolicLink() || !stat.isFile()) {
      continue;
    }
    candidates.push({ path, name, mtimeMs: stat.mtimeMs });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? 1 : -1));
  return candidates.map((candidate) => candidate.path);
}

/**
 * Keep the newest `keep` pre-migration backups; delete the rest.
 * Only exact-prefix matches are considered; manual backups and symlinks
 * are never deleted. Runs only after a valid atomic backup exists.
 */
export function prunePreMigrationBackups(
  backupDir: string,
  keep: number = PRE_MIGRATION_KEEP_GENERATIONS,
): { kept: string[]; pruned: string[] } {
  const ranked = listPreMigrationBackups(backupDir);
  const kept = ranked.slice(0, Math.max(0, keep));
  const pruned = ranked.slice(Math.max(0, keep));
  for (const path of pruned) {
    unlinkSync(path);
  }
  return { kept, pruned };
}
