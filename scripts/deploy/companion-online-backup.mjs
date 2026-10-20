// Online backup of the live Companion DB (read-only source, no downtime).
//
// The stopped-server-only CLI (`pnpm --filter @companion/server backup`)
// cannot be used from the daily timer: the timer may fire while
// companion.service is running. Instead this resolves the DB path exactly
// like the server (activeRuns.mjs: COMPANION_DB_PATH, else OS app-data),
// opens it read-only, and uses node:sqlite's online backup API (Node >= 24).
// The copy is written as `.partial`, verified with `PRAGMA integrity_check`,
// chmod 0600, and atomically renamed. Generations are pruned only after a
// successful rename.
//
// It also prunes legacy `companion-manual-*.sqlite` generations the old
// CLI wrote into the DB's own `<data>/backups` directory (newest N kept),
// which nothing else rotated.
//
// CLI: `node companion-online-backup.mjs [--db PATH] [--out-dir DIR] [--keep N]`
// Prints only the new backup file's basename on stdout.

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { resolveDbPath } from "./activeRuns.mjs";
import { backupDb, DEFAULT_KEEP, pruneGenerations } from "./remind-backup.mjs";

function defaultOutDir() {
  // Mirror of companion-backup.sh's BACKUP_ROOT default.
  return join(homedir(), ".local", "share", "companion-backups", "companion");
}

function parseArgs(argv) {
  const out = { keep: DEFAULT_KEEP };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--db" && i + 1 < argv.length) {
      i += 1;
      out.dbPath = argv[i];
    } else if (arg === "--out-dir" && i + 1 < argv.length) {
      i += 1;
      out.outDir = argv[i];
    } else if (arg === "--keep" && i + 1 < argv.length) {
      i += 1;
      out.keep = Number.parseInt(argv[i], 10);
    } else if (arg === "-h" || arg === "--help") {
      out.help = true;
    } else {
      throw new Error("companion backup failed: unknown argument");
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
        "usage: companion-online-backup.mjs [--db PATH] [--out-dir DIR] [--keep N]\n",
      );
      process.exit(0);
    }
    const dbPath = args.dbPath ?? resolveDbPath();
    const result = await backupDb({
      dbPath,
      outDir: args.outDir ?? defaultOutDir(),      keep: Number.isFinite(args.keep) ? args.keep : DEFAULT_KEEP,
      prefix: "companion-",
    });
    // Bound the legacy CLI generations in the DB's own backups dir.
    pruneGenerations(
      join(dirname(dbPath), "backups"),
      Number.isFinite(args.keep) ? args.keep : DEFAULT_KEEP,
      undefined,
      "companion-manual-",
    );
    process.stdout.write(`${result.file}\n`);
  } catch (error) {
    process.stderr.write(`${error?.message ?? "companion backup failed"}\n`);
    process.exit(1);
  }
}
