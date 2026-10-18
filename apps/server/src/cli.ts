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

import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import * as readline from "node:readline";
import {
  closeKernelDatabase,
  createManualBackup,
  openKernelDatabase,
} from "@companion/kernel";
import { loadServerConfig, type ServerConfig } from "./config.js";
import {
  checkPasswordFileStat,
  createPasswordFileContent,
} from "./remote_password.js";

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
  let config: ServerConfig;
  try {
    config = loadServerConfig(env);
  } catch {
    throw cliError(
      "invalid_configuration",
      "manual backup failed: invalid configuration",
    );
  }
  const dbPath = config.dbPath;
  const backupDir = join(dirname(dbPath), "backups");
  // Success emits only the safe basename (no stderr notice); failure paths
  // below stay fixed/redacted.
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
  return invoked?.endsWith("cli.ts") ?? false;
}

// Slice (b) `set-password`: creates/rotates the single-user remote login
// password hash file OUTSIDE SQLite (design §3).
//
// - Usage: tsx src/cli.ts set-password  (or pnpm --filter server set-password)
// - The password is read TWICE from TTY/stdin with echo suppressed and
//   must match; it NEVER comes from env/argv (no flags carry it, and the
//   process environment is never consulted for secret material).
// - The target path comes ONLY from the frozen remote config
//   (`COMPANION_REMOTE_JSON.passwordFile`); there is no path override
//   flag. The file is written with POSIX mode 0600 (enforced after write)
//   and re-validated before success is reported.
// - Exit 0 prints a fixed confirmation line; failures print fixed safe
//   text (no paths, no raw error text).

const SET_PASSWORD_USAGE = "Use: set-password";
const ERR_SET_PASSWORD_FAILED = "set password failed";

/** Injectable secret reader (default: TTY/stdin without echo). */
export type ReadSecretFn = (prompt: string) => Promise<string>;

function readPasswordNoEcho(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    const mutable = rl as unknown as {
      _writeToOutput: (text: string) => void;
    };
    const original = mutable._writeToOutput.bind(rl);
    mutable._writeToOutput = (text: string) => {
      // Echo the prompt itself only; mask every typed/pasted char and
      // turn line breaks into a single newline.
      if (text === prompt || text === `\r${prompt}` || text.startsWith(prompt)) {
        rl.output?.write(text);
        return;
      }
      if (/[\r\n]/.test(text)) {
        rl.output?.write("\n");
      }
    };
    rl.question(prompt, (answer) => {
      mutable._writeToOutput = original;
      rl.close();
      resolve(answer);
    });
  });
}

export async function runSetPasswordCli(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  readSecret: ReadSecretFn = readPasswordNoEcho,
): Promise<string> {
  const [command, ...rest] = argv;
  if (command !== "set-password") {
    throw cliError(
      "unknown_command",
      `set password failed: unknown command. ${SET_PASSWORD_USAGE}`,
    );
  }
  if (rest.length > 0) {
    throw cliError(
      "extra_arguments",
      "set password failed: set-password accepts no arguments",
    );
  }
  let config: ServerConfig;
  try {
    config = loadServerConfig(env);
  } catch {
    throw cliError(
      "invalid_configuration",
      "set password failed: invalid configuration",
    );
  }
  const passwordFile = config.remote.passwordFile;
  if (passwordFile === null) {
    throw cliError(
      "password_file_unconfigured",
      "set password failed: remote password file is not configured",
    );
  }
  let first: string;
  let second: string;
  try {
    first = await readSecret("New password: ");
    second = await readSecret("Confirm password: ");
  } catch {
    throw cliError("read_failed", ERR_SET_PASSWORD_FAILED);
  }
  if (first.length === 0 || first !== second) {
    throw cliError("mismatch", "set password failed: passwords do not match");
  }
  let content: string;
  try {
    content = createPasswordFileContent(first);
  } catch {
    throw cliError("weak_password", "set password failed: password too weak");
  }
  try {
    mkdirSync(dirname(passwordFile), { recursive: true });
    writeFileSync(passwordFile, content, { mode: 0o600 });
    if (process.platform !== "win32") {
      chmodSync(passwordFile, 0o600);
    }
    checkPasswordFileStat(passwordFile);
  } catch (error) {
    if (error instanceof ManualBackupCliError) {
      throw error;
    }
    throw cliError("write_failed", ERR_SET_PASSWORD_FAILED);
  }
  return "password updated";
}

if (isMainModule()) {
  const [command] = process.argv.slice(2);
  if (command === "set-password") {
    runSetPasswordCli()
      .then((message) => {
        process.stdout.write(`${message}\n`);
      })
      .catch((error: unknown) => {
        process.stderr.write(`${toSafeCliMessage(error)}\n`);
        process.exitCode = 1;
      });
  } else {
    runManualBackupCli()
      .then((backupName) => {
        process.stdout.write(`${backupName}\n`);
      })
      .catch((error: unknown) => {
        process.stderr.write(`${toSafeCliMessage(error)}\n`);
        process.exitCode = 1;
      });
  }
}
