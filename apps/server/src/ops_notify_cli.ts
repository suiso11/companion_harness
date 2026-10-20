// Ops in-app notification CLI (branch feat/ops-inapp-notify).
//
// Decision (haruka 2026-10-19): ops events notify via Companion in-app
// notifications ONLY (option A, no external send), both success and
// failure. This CLI writes the notice directly to the kernel SQLite store
// via `recordSystemNotice` — WAL mode + short busy timeout make it safe to
// run while the server is running, and the notification SSE feed polls the
// DB, so the running server picks the new row up without a restart.
//
// No HTTP endpoint, no network send, best-effort only.
//
// Usage:
//   tsx src/ops_notify_cli.ts notify --level info|error \
//     --title "..." --body "..." --source ops:deploy:<sha8> \
//     --subject "<dedupe subject>"
//
// - `--level` maps numerically: info -> routine, error -> urgent priority.
// - Text arguments are validated and length-capped (title 1..120, body
//   1..300, source 8..128, subject 1..200 code points). The contract is
//   that hooks pass fixed safe text with NO secrets; this CLI never reads
//   environment secret material and prints only fixed safe output.
// - Exit 0 on a recorded (or deduped) notice; exit 1 with a fixed safe
//   message on validation / storage failure.

import { existsSync } from "node:fs";
import {
  closeKernelDatabase,
  openKernelDatabase,
  recordSystemNotice,
  type SystemNotice,
} from "@companion/kernel";
import { loadServerConfig } from "./config.js";

export const NOTIFY_USAGE =
  "Use: notify --level info|error --title <1..120> --body <1..300> --source <8..128> --subject <1..200>";

/** Fixed safe CLI errors: never carry paths or raw error text. */
export class OpsNotifyCliError extends Error {
  readonly cliCode: string;

  constructor(cliCode: string, message: string) {
    super(message);
    this.name = "OpsNotifyCliError";
    this.cliCode = cliCode;
  }
}

function cliError(cliCode: string, message: string): OpsNotifyCliError {
  return new OpsNotifyCliError(cliCode, message);
}

export interface NotifyCliArgs {
  readonly level: "info" | "error";
  readonly title: string;
  readonly body: string;
  readonly source: string;
  readonly subject: string;
}

/** Parse + validate the bounded argv surface (no free-form extras). */
export function parseNotifyArgv(argv: string[]): NotifyCliArgs {
  let level: string | undefined;
  let title: string | undefined;
  let body: string | undefined;
  let source: string | undefined;
  let subject: string | undefined;
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) {
      throw cliError("bad_arguments", NOTIFY_USAGE);
    }
    switch (flag) {
      case "--level":
        level = value;
        break;
      case "--title":
        title = value;
        break;
      case "--body":
        body = value;
        break;
      case "--source":
        source = value;
        break;
      case "--subject":
        subject = value;
        break;
      default:
        throw cliError("bad_arguments", NOTIFY_USAGE);
    }
  }
  if (level !== "info" && level !== "error") {
    throw cliError("bad_level", NOTIFY_USAGE);
  }
  if (
    title === undefined ||
    body === undefined ||
    source === undefined ||
    subject === undefined
  ) {
    throw cliError("bad_arguments", NOTIFY_USAGE);
  }
  return { level, title, body, source, subject };
}

/** Run the notify subcommand; returns the fixed safe summary line. */
export function runNotifyCli(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): string {
  const args = parseNotifyArgv(argv);
  let config;
  try {
    config = loadServerConfig(env);
  } catch {
    throw cliError("invalid_configuration", "ops notify failed: invalid configuration");
  }
  const dbPath = config.dbPath;
  // Fail closed on a missing DB: better-sqlite3 would otherwise create an
  // empty file on open (which the running server would then migrate).
  if (!existsSync(dbPath)) {
    throw cliError("database_missing", "ops notify failed: database missing");
  }
  const handle = openKernelDatabase(dbPath);
  try {
    const notice: SystemNotice = recordSystemNotice(
      handle.raw,
      {
        level: args.level,
        title: args.title,
        body: args.body,
        sourceId: args.source,
        fingerprintSubject: args.subject,
      },
    );
    return `ops notify ${args.level}: recorded=${notice.recorded} deduped=${notice.deduped}`;
  } catch (error) {
    if (error instanceof OpsNotifyCliError) {
      throw error;
    }
    throw cliError("notify_failed", "ops notify failed");
  } finally {
    closeKernelDatabase(handle);
  }
}

function isMainModule(): boolean {
  const invoked = process.argv[1];
  return invoked?.endsWith("ops_notify_cli.ts") ?? false;
}

if (isMainModule()) {
  const [command, ...rest] = process.argv.slice(2);
  if (command !== "notify") {
    process.stderr.write(`ops notify failed: unknown command. ${NOTIFY_USAGE}\n`);
    process.exit(1);
  }
  try {
    process.stdout.write(`${runNotifyCli(rest)}\n`);
  } catch (error) {
    const message =
      error instanceof OpsNotifyCliError ? error.message : "ops notify failed";
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}
