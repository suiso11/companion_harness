// Manual backup CLI (stopped-server only, §19.2).
//
// - Sole copy method: better-sqlite3 Database.backup via
//   kernel createManualBackup (.partial -> 0600 -> quick_check -> rename).
// - Never starts a listener or scheduler; no HTTP backup/restore/delete
//   endpoints exist. Run ONLY while the server is stopped.
// - Usage: tsx src/cli.ts backup
//   The DB path comes only from the frozen server config (COMPANION_DB_PATH
//   or the OS default); the backup dir is always <data>/backups. There are
//   no path override flags. Exit 0 on success (prints only the backup file
//   basename), non-zero with fixed safe text on failure (no paths, no raw
//   error text).

import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  closeKernelDatabase,
  createManualBackup,
  openKernelDatabase,
} from "@companion/kernel";
import { loadServerConfig } from "./config.js";

const STOPPED_ONLY_NOTICE =
  "Stopped-server only: stop the server before running this command.";
const CLI_USAGE = "Use: backup";
const ERR_UNKNOWN_COMMAND = `manual backup failed: unknown command. ${CLI_USAGE}`;
const ERR_EXTRA_ARGS = "manual backup failed: backup accepts no arguments";
const ERR_DB_MISSING = "manual backup failed: database missing";
const ERR_FAILED = "manual backup failed";

/** Fixed safe CLI errors: never carry paths or raw error text. */
export class ManualBackupCliError extends Error {
  readonly cliCode: string;

  constructor(cliCode: string, message: string) {
    super(message);
    this.name = "ManualBackupCliError";
    this.cliCode = cliCode;
  }
}

function cliError(cliCode: string, message: string): ManualBackupCliError {
  return new ManualBackupCliError(cliCode, message);
}

/** Map any failure to a fixed safe message (no path, no raw error text). */
export function toSafeCliMessage(error: unknown): string {
  if (error instanceof ManualBackupCliError) {
    return error.message;
  }
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (code === "server_config_invalid") {
      return "manual backup failed: invalid configuration";
    }
  }
  return ERR_FAILED;
}

export async function runManualBackupCli(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const [command, ...rest] = argv;
  if (command !== "backup") {
    throw cliError("unknown_command", ERR_UNKNOWN_COMMAND);
  }
  if (rest.length > 0) {
    throw cliError("extra_arguments", ERR_EXTRA_ARGS);
  }
  let config;
  try {
    config = loadServerConfig(env);
  } catch {
    throw cliError("invalid_configuration", "manual backup failed: invalid configuration");
  }
  const dbPath = config.dbPath;
  const backupDir = join(dirname(dbPath), "backups");
  process.stderr.write(`${STOPPED_ONLY_NOTICE}\n`);
  // Fail closed on a missing DB: better-sqlite3 would otherwise create an
  // empty file on open. No DB and no backups are created on this path.
  if (!existsSync(dbPath)) {
    throw cliError("database_missing", ERR_DB_MISSING);
  }
  const handle = openKernelDatabase(dbPath);
  try {
    const backupPath = await createManualBackup({
      source: handle.raw,
      backupDir,
    });
    // Print only the basename: the absolute path never leaves the process.
    const name = basename(backupPath);
    if (
      name.length === 0 ||
      name.length > 256 ||
      name !== backupPath.slice(-name.length) ||
      name.includes("/") ||
      name.includes("\\") ||
      !/^companion-manual-.*\.sqlite$/.test(name)
    ) {
      throw cliError("backup_failed", ERR_FAILED);
    }
    return name;
  } catch (error) {
    if (error instanceof ManualBackupCliError) {
      throw error;
    }
    throw cliError("backup_failed", ERR_FAILED);
  } finally {
    closeKernelDatabase(handle);
  }
}

function isMainModule(): boolean {
  const invoked = process.argv[1];
  return invoked !== undefined && invoked.endsWith("cli.ts");
}

if (isMainModule()) {
  runManualBackupCli()
    .then((backupName) => {
      process.stdout.write(`${backupName}\n`);
    })
    .catch((error: unknown) => {
      process.stderr.write(`${toSafeCliMessage(error)}\n`);
      process.exitCode = 1;
    });
}
