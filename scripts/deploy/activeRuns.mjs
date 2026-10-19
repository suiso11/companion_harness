// Active-run gate for the polling auto-deploy timer.
//
// Read-only check: counts runs in queued/running/cancel_requested in the
// server SQLite DB. The DB path resolves exactly like the server default
// (COMPANION_DB_PATH, else OS app-data companion-harness/companion.sqlite).
// Opens the DB read-only (node:sqlite); never writes, never prints secrets.
//
// CLI: `node activeRuns.mjs [--db <path>]`
//   prints {"db": "...", "active": N} on stdout.
//   exit 0 = no active runs (deploy may proceed), 2 = active runs present
//   (skip this tick), 1 = error.
// Also importable: `import { countActiveRuns, resolveDbPath } from ...`.

import { homedir } from "node:os";
import { join } from "node:path";

export const ACTIVE_STATUSES = Object.freeze([
  "queued",
  "running",
  "cancel_requested",
]);

/** Mirror of the server default DB location (apps/server/src/config.ts). */
export function resolveDbPath(env = process.env) {
  const raw = env.COMPANION_DB_PATH;
  if (raw !== undefined && raw.length > 0) {
    return raw;
  }
  if (process.platform === "win32") {
    const base = env.APPDATA;
    const root =
      base !== undefined && base.length > 0
        ? base
        : join(homedir(), "AppData", "Roaming");
    return join(root, "companion-harness", "companion.sqlite");
  }
  if (process.platform === "darwin") {
    return join(
      homedir(),
      "Library",
      "Application Support",
      "companion-harness",
      "companion.sqlite",
    );
  }
  const xdg = env.XDG_DATA_HOME;
  const root =
    xdg !== undefined && xdg.length > 0
      ? xdg
      : join(homedir(), ".local", "share");
  return join(root, "companion-harness", "companion.sqlite");
}

/**
 * Count active (non-terminal, deploy-blocking) runs. Read-only; a missing
 * DB file or a DB without a `runs` table counts as 0 (nothing to block).
 */
export async function countActiveRuns(dbPath) {
  const { DatabaseSync } = await import("node:sqlite");
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (error) {
    if (
      error?.code === "ERR_SQLITE_CANTOPEN" ||
      /unable to open/i.test(error?.message ?? "")
    ) {
      return { db: dbPath, active: 0, note: "no-db" };
    }
    throw error;
  }
  try {
    const tables = db
      .prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'runs'",
      )
      .get();
    if (tables.n === 0) {
      return { db: dbPath, active: 0, note: "no-runs-table" };
    }
    const row = db
      .prepare(
        "SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued', 'running', 'cancel_requested')",
      )
      .get();
    return { db: dbPath, active: row.n };
  } finally {
    db.close();
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--db" && i + 1 < argv.length) {
      out.db = argv[i + 1];
      i += 1;
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
  const args = parseArgs(process.argv.slice(2));
  const dbPath = args.db ?? resolveDbPath();
  countActiveRuns(dbPath).then(
    (result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      process.exit(result.active > 0 ? 2 : 0);
    },
    (error) => {
      process.stderr.write(`activeRuns: ${error?.message ?? error}\n`);
      process.exit(1);
    },
  );
}
