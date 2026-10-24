// Online backup of the remind SQLite DB (read-only source, no CLI needed).
//
// remind has no backup command, so this uses node:sqlite's online backup
// API (Node >= 24). The source DB is opened read-only; the copy is written
// as `.partial`, verified with `PRAGMA integrity_check`, chmod 0600, and
// atomically renamed. Generations are pruned only after a successful
// rename, so a failed run never removes the newest good copy.
//
// The remind dbPath is resolved exactly like remind: relative paths are
// relative to the directory containing memory.config.json.
//
// CLI: `node remind-backup.mjs [--config PATH] [--out-dir DIR] [--keep N]`
// Prints only the new backup file's basename. Never prints paths or secrets
// on failure (stable error text only).

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export const DEFAULT_KEEP = 7;
export const FILE_MODE = 0o600;
export const DIR_MODE = 0o700;

/** UTC stamp matching the Companion backup convention (YYYYMMDDTHHMMSSZ). */
export function formatUtc(now = new Date()) {
  return now
    .toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(/\..+$/, "Z");
}

/** Resolve the remind DB path from memory.config.json (same as remind). */
export function resolveRemindDbPath(configPath) {
  const absoluteConfig = resolve(configPath);
  const raw = readFileSync(absoluteConfig, "utf8");
  const parsed = JSON.parse(raw);
  const dbPath = parsed?.dbPath;
  if (typeof dbPath !== "string" || dbPath.length === 0) {
    throw new Error("remind backup failed: config has no dbPath");
  }
  return resolve(dirname(absoluteConfig), dbPath);
}

export function defaultConfigPath(env = process.env) {
  const base =
    env.XDG_CONFIG_HOME !== undefined && env.XDG_CONFIG_HOME.length > 0
      ? env.XDG_CONFIG_HOME
      : join(homedir(), ".config");
  return join(base, "remind", "memory.config.json");
}

function ensurePrivateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  try {
    chmodSync(dir, DIR_MODE);
  } catch {
    // Windows has no POSIX mode guarantee; keep the current-user ACL.
  }
}

function secureFile(path) {
  try {
    chmodSync(path, FILE_MODE);
  } catch {
    // Windows: current-user ACL only.
  }
}

/** List generations newest-first (mtime, then name). */
export function listGenerations(dir, prefix = "remind-") {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const found = [];
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(".sqlite")) {
      continue;
    }
    const path = join(dir, name);
    try {
      const stat = statSync(path);
      if (!stat.isFile()) {
        continue;
      }
      found.push({ name, path, mtimeMs: stat.mtimeMs });
    } catch {
      // Raced with another prune; ignore.
    }
  }
  found.sort((a, b) =>
    b.mtimeMs === a.mtimeMs
      ? b.name.localeCompare(a.name)
      : b.mtimeMs - a.mtimeMs,
  );
  return found;
}

/** Keep the newest `keep` generations (minimum 1). Never deletes `protect`. */
export function pruneGenerations(
  dir,
  keep = DEFAULT_KEEP,
  protect,
  prefix = "remind-",
) {
  const limit = Math.max(1, Math.floor(keep));
  const generations = listGenerations(dir, prefix);
  const removed = [];
  for (const entry of generations.slice(limit)) {
    if (entry.name === protect) {
      continue;
    }
    try {
      unlinkSync(entry.path);
      removed.push(entry.name);
    } catch (error) {
      process.stderr.write(
        `backup prune skipped for ${entry.name}: ${error?.code ?? "error"}\n`,
      );
    }
  }
  return removed;
}

function inspectBackup(dbPath) {
  // Imported lazily so the CLI can report a stable error on old Node.
  return import("node:sqlite").then(({ DatabaseSync }) => {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db.prepare("PRAGMA integrity_check").get();
      const versionRow = db.prepare("PRAGMA user_version").get();
      const userVersion = versionRow?.user_version;
      return {
        ok: row?.integrity_check === "ok",
        userVersion: Number.isInteger(userVersion) ? userVersion : 0,
      };
    } finally {
      db.close();
    }
  });
}

/**
 * Back up one SQLite DB opened read-only (generic engine shared by the
 * remind and Companion online-backup CLIs). Returns { file, path, removed }.
 * Existing generations are untouched unless the new copy verified + renamed.
 */
export async function backupDb({
  dbPath,
  outDir,
  keep = DEFAULT_KEEP,
  prefix = "remind-",
  suffix,
  now = new Date(),
}) {
  ensurePrivateDir(outDir);
  const stamp = formatUtc(now);
  const finalName =
    typeof suffix === "string" && suffix.length > 0
      ? `${prefix}${stamp}-${suffix}.sqlite`
      : `${prefix}${stamp}-${process.pid}-${Math.random()
          .toString(16)
          .slice(2, 10)}.sqlite`;
  const finalPath = join(outDir, finalName);
  let renamed = false;
  let userVersion = 0;

  // Stage the copy inside a private temp dir and rename ONLY the final file
  // out of it. SQLite sidecars (`-wal` / `-shm`) that node:sqlite leaves next
  // to the staged copy then can never leak into the backup root (live bug
  // 2026-10-20: `.partial-shm` / `.partial-wal` accumulated per backup), and
  // failed runs are cleaned up wholesale.
  const { mkdtempSync, rmSync } = await import("node:fs");
  const tmpDir = mkdtempSync(join(outDir, ".tmp-"));
  const partialPath = join(tmpDir, `${finalName}.partial`);

  const { DatabaseSync, backup } = await import("node:sqlite");
  let source;
  try {
    source = new DatabaseSync(dbPath, { readOnly: true });
    await backup(source, partialPath);
    secureFile(partialPath);
    // Fold any WAL sidecars into the main DB file and switch it to
    // journal_mode=DELETE so the staged copy is a single self-contained
    // file (checkpoint first — renaming a hot-WAL DB would lose data).
    if (existsSync(`${partialPath}-wal`) || existsSync(`${partialPath}-shm`)) {
      const staged = new DatabaseSync(partialPath);
      try {
        staged.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        staged.exec("PRAGMA journal_mode=DELETE");
      } finally {
        staged.close();
      }
    }
    for (const sidecar of [`${partialPath}-wal`, `${partialPath}-shm`]) {
      if (existsSync(sidecar)) unlinkSync(sidecar);
    }
    const inspection = await inspectBackup(partialPath);
    if (!inspection.ok) {
      throw new Error("remind backup failed: integrity_check");
    }
    userVersion = inspection.userVersion;
    renameSync(partialPath, finalPath);
    renamed = true;
    secureFile(finalPath);
  } finally {
    try {
      source?.close();
    } catch {
      // already closed
    }
    if (!renamed) {
      try {
        unlinkSync(partialPath);
      } catch {
        // no partial to remove
      }
    }
    // Wholesale temp-dir cleanup: removes any sidecars left by a failed
    // SQLite operation, on success and failure alike.
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort only
    }
  }

  const removed = pruneGenerations(outDir, keep, finalName, prefix);
  return {
    file: basename(finalPath),
    path: finalPath,
    removed,
    userVersion,
  };
}

/**
 * Back up the remind DB resolved from memory.config.json.
 * Returns { file, path, removed }.
 */
export async function backupRemindDb({
  configPath = defaultConfigPath(),
  outDir = join(homedir(), ".local", "share", "companion-backups", "remind"),
  keep = DEFAULT_KEEP,
  prefix = "remind-",
  suffix,
  now = new Date(),
} = {}) {
  if (!existsSync(configPath)) {
    throw new Error("remind backup failed: config missing");
  }
  const dbPath = resolveRemindDbPath(configPath);
  if (!existsSync(dbPath)) {
    throw new Error("remind backup failed: database missing");
  }
  return backupDb({ dbPath, outDir, keep, prefix, suffix, now });
}

export const PREDEPLOY_PREFIX = "remind-pre-deploy-";
export const PREDEPLOY_KEEP = 10;

/**
 * Verified pre-symlink-flip backup for remind-deploy.sh. The file lives in
 * `<dbdir>/backups/` (next to the live DB) as
 * `remind-pre-deploy-<UTC>-<sha7>.sqlite`. A missing DB (fresh install) is a
 * clean skip; everything else rejects so the deploy can abort before flip.
 */
export async function backupRemindPreDeploy({
  configPath = defaultConfigPath(),
  sha,
  keep = PREDEPLOY_KEEP,
  now = new Date(),
} = {}) {
  if (typeof sha !== "string" || !/^[0-9a-f]{7,40}$/i.test(sha)) {
    throw new Error("remind backup failed: invalid sha");
  }
  if (!existsSync(configPath)) {
    throw new Error("remind backup failed: config missing");
  }
  const dbPath = resolveRemindDbPath(configPath);
  if (!existsSync(dbPath)) {
    return { skipped: true, reason: "database missing", dbPath };
  }
  const outDir = join(dirname(dbPath), "backups");
  const result = await backupDb({
    dbPath,
    outDir,
    keep,
    prefix: PREDEPLOY_PREFIX,
    suffix: sha.slice(0, 7).toLowerCase(),
    now,
  });
  return { ...result, skipped: false, dbPath };
}

function parseArgs(argv) {
  const out = { keep: DEFAULT_KEEP };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--config" && i + 1 < argv.length) {
      i += 1;
      out.configPath = argv[i];
    } else if (arg === "--out-dir" && i + 1 < argv.length) {
      i += 1;
      out.outDir = argv[i];
    } else if (arg === "--keep" && i + 1 < argv.length) {
      i += 1;
      out.keep = Number.parseInt(argv[i], 10);
    } else if (arg === "--prefix" && i + 1 < argv.length) {
      i += 1;
      out.prefix = argv[i];
    } else if (arg === "--suffix" && i + 1 < argv.length) {
      i += 1;
      out.suffix = argv[i];
    } else if (arg === "--pre-deploy") {
      out.preDeploy = true;
      out.keep = PREDEPLOY_KEEP;
    } else if (arg === "--sha" && i + 1 < argv.length) {
      i += 1;
      out.sha = argv[i];
    } else if (arg === "-h" || arg === "--help") {
      out.help = true;
    } else {
      throw new Error("remind backup failed: unknown argument");
    }
  }
  return out;
}

const invokedAsMain =
  process.argv[1] !== undefined &&
  import.meta.url.endsWith(
    process.argv[1].split("/").slice(-1)[0].split("\\").slice(-1)[0],
  );

if (invokedAsMain) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      process.stdout.write(
        "usage: remind-backup.mjs [--config PATH] [--out-dir DIR] [--keep N]\n" +
          "       remind-backup.mjs --pre-deploy --sha SHA [--config PATH] [--keep N]\n",
      );
      process.exit(0);
    }
    if (args.preDeploy) {
      const result = await backupRemindPreDeploy({
        configPath: args.configPath ?? defaultConfigPath(),
        sha: args.sha,
        keep: Number.isFinite(args.keep) ? args.keep : PREDEPLOY_KEEP,
      });
      if (result.skipped) {
        process.stdout.write(`skip=${result.reason}\n`);
      } else {
        process.stdout.write(
          `backup=${result.file} user_version=${result.userVersion} removed=${result.removed.length}\n`,
        );
      }
      process.exit(0);
    }
    const result = await backupRemindDb({
      configPath: args.configPath ?? defaultConfigPath(),
      outDir:
        args.outDir ??
        join(homedir(), ".local", "share", "companion-backups", "remind"),
      keep: Number.isFinite(args.keep) ? args.keep : DEFAULT_KEEP,
      prefix: args.prefix,
      suffix: args.suffix,
    });
    process.stdout.write(`${result.file}\n`);
  } catch (error) {
    process.stderr.write(`${error?.message ?? "remind backup failed"}\n`);
    process.exit(1);
  }
}
