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
// - Sole copy method is the online backup API; no vacuum-into, no file
//   copy, no automatic domain deletion.

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { isUuidV4 } from "./canonical.js";
import { quickCheck } from "./connection.js";
import { BackupError } from "./errors.js";

export const PRE_MIGRATION_PREFIX = "companion-pre-migration-";
export const PRE_MIGRATION_SUFFIX = ".sqlite";
export const PRE_MIGRATION_PARTIAL_SUFFIX = ".partial";
export const PRE_MIGRATION_KEEP_GENERATIONS = 3;

function requireMigrationVersions(fromVersion: number, toVersion: number): void {
  if (!Number.isInteger(fromVersion) || fromVersion < 0) {
    throw new BackupError("invalid pre-migration source version");
  }
  if (!Number.isInteger(toVersion) || toVersion < 0) {
    throw new BackupError("invalid pre-migration target version");
  }
  if (toVersion <= fromVersion) {
    throw new BackupError("invalid pre-migration version range");
  }
}

function requireBackupId(backupId: string): string {
  if (!isUuidV4(backupId)) {
    throw new BackupError("invalid pre-migration backup id");
  }
  return backupId;
}

/** Absolute ancestor chain from filesystem root to `abs` (inclusive). */
function ancestorChain(abs: string): string[] {
  const chain: string[] = [];
  let current = abs;
  for (;;) {
    chain.push(current);
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return chain.reverse();
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

/**
 * Assert every EXISTING prefix of `absDir` is a non-symlink directory.
 * Missing trailing components are allowed (they will be created); any
 * existing ancestor that is a symlink or a non-directory is rejected
 * without following it. Never includes paths in the outward message.
 */
function assertSafeExistingAncestors(absDir: string): void {
  for (const prefix of ancestorChain(absDir)) {
    let stat;
    try {
      stat = lstatSync(prefix);
    } catch (error: unknown) {
      if (isEnoent(error)) {
        continue;
      }
      throw new BackupError("cannot validate backup directory");
    }
    if (stat.isSymbolicLink()) {
      throw new BackupError("backup directory must not traverse a symlink");
    }
    if (!stat.isDirectory()) {
      throw new BackupError("backup directory ancestor is not a directory");
    }
  }
}

/** True when `target` provably remains under `base` (both absolute). */
function isPathUnderBase(base: string, target: string): boolean {
  if (target === base) {
    return true;
  }
  return target.startsWith(base + sep);
}

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
  requireMigrationVersions(fromVersion, toVersion);
  requireBackupId(backupId);
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new BackupError("invalid pre-migration backup timestamp");
  }
  return `${PRE_MIGRATION_PREFIX}v${fromVersion}-to-v${toVersion}-${formatBackupUtc(now)}-${backupId}${PRE_MIGRATION_SUFFIX}`;
}

/**
 * Ensure the backups directory exists and is not a symlink.
 *
 * Existing ancestors must all be non-symlink directories (checked with
 * lstat, never followed). The leaf itself must not be a symlink.
 *
 * @throws {BackupError} when the path traverses a symlink or is unusable.
 *   Messages never include filesystem paths or raw native text.
 */
export function ensureBackupDir(backupDir: string): string {
  if (typeof backupDir !== "string" || backupDir.length === 0) {
    throw new BackupError("invalid backup directory");
  }
  const absDir = resolve(backupDir);
  // Validate existing ancestors BEFORE creating anything, so mkdir can
  // never create through a symlinked parent.
  const parent = dirname(absDir);
  if (parent !== absDir) {
    assertSafeExistingAncestors(parent);
  }
  let stat;
  try {
    stat = lstatSync(absDir);
  } catch (error: unknown) {
    if (isEnoent(error)) {
      try {
        mkdirSync(absDir, { recursive: true });
      } catch (cause: unknown) {
        throw new BackupError("cannot create backup directory", { cause });
      }
      try {
        stat = lstatSync(absDir);
      } catch (cause: unknown) {
        throw new BackupError("cannot validate backup directory", { cause });
      }
    } else {
      throw new BackupError("cannot validate backup directory", { cause: error });
    }
  }
  if (stat.isSymbolicLink()) {
    throw new BackupError("backup directory must not be a symlink");
  }
  if (!stat.isDirectory()) {
    throw new BackupError("backup path is not a directory");
  }
  return absDir;
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
  requireMigrationVersions(fromVersion, toVersion);
  requireBackupId(backupId);
  const absDir = ensureBackupDir(backupDir);
  const finalName = preMigrationBackupName(
    fromVersion,
    toVersion,
    now,
    backupId,
  );
  // Prevent filename traversal even if a future caller passes an
  // unchecked name: both outputs must provably remain under absDir.
  const finalPath = resolve(absDir, finalName);
  const partialPath = `${finalPath}${PRE_MIGRATION_PARTIAL_SUFFIX}`;
  if (!isPathUnderBase(absDir, finalPath) || !isPathUnderBase(absDir, partialPath)) {
    throw new BackupError("invalid pre-migration backup path");
  }

  try {
    try {
      unlinkSync(partialPath);
    } catch {
      // Best effort: stale partials must not block a fresh backup.
    }
    // SOLE copy method: the online backup API (no vacuum-into, no copy).
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
    throw new BackupError("pre-migration backup failed", {
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
  if (typeof backupDir !== "string" || backupDir.length === 0) {
    throw new BackupError("invalid backup directory");
  }
  const absDir = resolve(backupDir);
  // Enforce non-symlink existing ancestors/directories before reading.
  try {
    assertSafeExistingAncestors(absDir);
  } catch (error: unknown) {
    if (error instanceof BackupError) {
      // A missing directory lists as empty; a symlinked/blocked path fails.
      try {
        lstatSync(absDir);
      } catch (statError: unknown) {
        if (isEnoent(statError)) {
          return [];
        }
      }
      throw error;
    }
    throw error;
  }
  let entries: string[];
  try {
    entries = readdirSync(absDir);
  } catch (error: unknown) {
    if (isEnoent(error)) {
      return [];
    }
    throw new BackupError("cannot list backup directory", { cause: error });
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
    // Reject traversal names from readdir as well as future callers.
    if (name.includes("/") || name.includes("\\") || name.includes("..")) {
      continue;
    }
    const path = join(absDir, name);
    if (!isPathUnderBase(absDir, resolve(path))) {
      continue;
    }
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
  const absDir = resolve(backupDir);
  const kept = ranked.slice(0, Math.max(0, keep));
  const pruned = ranked.slice(Math.max(0, keep));
  for (const path of pruned) {
    // Re-verify containment + non-symlink immediately before delete
    // (best-effort TOCTOU narrowing; see residual limitation).
    const absPath = resolve(path);
    if (!isPathUnderBase(absDir, absPath)) {
      throw new BackupError("invalid pre-migration backup path");
    }
    let stat;
    try {
      stat = lstatSync(absPath);
    } catch (error: unknown) {
      throw new BackupError("cannot prune backup directory", { cause: error });
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      continue;
    }
    try {
      unlinkSync(absPath);
    } catch (error: unknown) {
      throw new BackupError("cannot prune backup directory", { cause: error });
    }
  }
  return { kept, pruned };
}
