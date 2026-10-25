// Private SQLite file plumbing shared by the new opt-in stores.
//
// These stores hold operator-only state (learning reflections/approvals and
// AGORA proposals). They must not be world/group readable, must not traverse
// symlinked ancestors, and must never be created through a permissive
// window. The approach mirrors the existing Web approval store: validate
// every ancestor with lstat, create missing directories 0700, pre-create the
// leaf with O_EXCL|O_NOFOLLOW and mode 0600, then force 0600 for the file and
// its WAL/SHM sidecars.

import {
  chmodSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";
import Database from "better-sqlite3";
import { RepositoryValidationError } from "./errors.js";

function assertPrivateParent(path: string): void {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.length > 4096 ||
    !isAbsolute(path)
  ) {
    throw new RepositoryValidationError("private store path must be absolute");
  }
  const chain: string[] = [dirname(path)];
  let tip = dirname(path);
  for (;;) {
    const parent = dirname(tip);
    if (parent === tip) break;
    chain.push(parent);
    tip = parent;
  }
  chain.reverse();
  for (let index = 0; index < chain.length; index += 1) {
    const current = chain[index] as string;
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new RepositoryValidationError(
          "private store path must not use symlinks",
        );
      }
    } catch (error) {
      if (error instanceof RepositoryValidationError) throw error;
      if (
        typeof error !== "object" ||
        error === null ||
        (error as { code?: unknown }).code !== "ENOENT"
      ) {
        throw new RepositoryValidationError(
          "private store path is not accessible",
        );
      }
      for (let create = index; create < chain.length; create += 1) {
        const target = chain[create] as string;
        try {
          const existing = lstatSync(target);
          if (existing.isSymbolicLink() || !existing.isDirectory()) {
            throw new RepositoryValidationError(
              "private store path must not use symlinks",
            );
          }
          continue;
        } catch (check) {
          if (check instanceof RepositoryValidationError) throw check;
          if (
            typeof check !== "object" ||
            check === null ||
            (check as { code?: unknown }).code !== "ENOENT"
          ) {
            throw new RepositoryValidationError(
              "private store path is not accessible",
            );
          }
        }
        mkdirSync(target, { mode: 0o700 });
        if (process.platform !== "win32") chmodSync(target, 0o700);
      }
      return;
    }
  }
}

function assertRegularPrivateFile(path: string): boolean {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new RepositoryValidationError(
        "private store path must not be a symlink",
      );
    }
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
      chmodSync(path, 0o600);
    }
    return true;
  } catch (error) {
    if (error instanceof RepositoryValidationError) throw error;
    if (
      typeof error !== "object" ||
      error === null ||
      (error as { code?: unknown }).code !== "ENOENT"
    ) {
      throw new RepositoryValidationError(
        "private store path is not accessible",
      );
    }
    return false;
  }
}

function secureFile(path: string): void {
  if (assertRegularPrivateFile(path)) return;
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === "EEXIST"
    ) {
      if (!assertRegularPrivateFile(path)) {
        throw new RepositoryValidationError(
          "private store path is not accessible",
        );
      }
      return;
    }
    throw new RepositoryValidationError("private store path is not accessible");
  }
  try {
    if (process.platform !== "win32") chmodSync(path, 0o600);
  } finally {
    closeSync(fd);
  }
}

export function hardenPrivateSidecars(path: string): void {
  if (process.platform === "win32") return;
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${path}${suffix}`;
    try {
      const stat = lstatSync(sidecar);
      if (stat.isSymbolicLink() || !stat.isFile()) continue;
      if ((stat.mode & 0o077) !== 0) chmodSync(sidecar, 0o600);
    } catch {
      // Not created yet (or already removed on close).
    }
  }
}

/**
 * Open + initialise one private SQLite database. The caller owns `close()`
 * via {@link closePrivateSqlite}. Connection errors are mapped to a fixed
 * validation error that never contains the path.
 */
export function openPrivateSqlite(path: string): Database.Database {
  assertPrivateParent(path);
  secureFile(path);
  const previousUmask = process.umask(0o077);
  let db: Database.Database | undefined;
  try {
    db = new Database(path);
    if (process.platform !== "win32") chmodSync(path, 0o600);
    db.pragma("journal_mode = WAL");
    hardenPrivateSidecars(path);
    return db;
  } catch (error) {
    try {
      db?.close();
    } catch {
      // Best effort.
    }
    throw new RepositoryValidationError("private store is unavailable");
  } finally {
    process.umask(previousUmask);
  }
}

export function closePrivateSqlite(
  db: Database.Database | undefined,
  path: string,
): void {
  if (db !== undefined) {
    try {
      db.pragma("wal_checkpoint(TRUNCATE)");
    } catch {
      // A concurrent/blocked checkpoint must not prevent close.
    }
  }
  hardenPrivateSidecars(path);
  try {
    db?.close();
  } finally {
    hardenPrivateSidecars(path);
  }
}
