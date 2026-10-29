// Companion-initiated chat message CLI (local operator / automation hook).
//
// Writes ONE `companion_text` Turn (no Run) into the kernel SQLite store via
// the shared repository. The running server replays it to the open chat
// through the session companion-message SSE feed (and history on reload).
//
// Usage:
//   tsx src/companion_message_cli.ts send --text "..." [--session <uuid>]
//
// - `--session` is optional; the default target is the most recently active
//   session (the chat the user is actually using).
// - Text is the real user-visible message: bounded, trimmed-non-empty, no
//   fixed safe-text masking (unlike ops notices).
// - Exit 0 after the Turn commits; exit 1 with fixed safe text on
//   validation / storage failure.

import { existsSync } from "node:fs";
import { MAX_USER_TEXT_LENGTH } from "@companion/contracts";
import {
  closeKernelDatabase,
  createKernelRepository,
  openKernelDatabase,
} from "@companion/kernel";
import { loadServerConfig, type ServerConfig } from "./config.js";

export const MESSAGE_USAGE =
  "Use: send --text <1..32768 chars> [--session <uuid>]";

/** Fixed safe CLI errors: never carry paths or raw error text. */
export class CompanionMessageCliError extends Error {
  readonly cliCode: string;

  constructor(cliCode: string, message: string) {
    super(message);
    this.name = "CompanionMessageCliError";
    this.cliCode = cliCode;
  }
}

function cliError(cliCode: string, message: string): CompanionMessageCliError {
  return new CompanionMessageCliError(cliCode, message);
}

export interface SendMessageCliArgs {
  readonly text: string;
  readonly sessionId?: string;
}

/** Parse + validate the bounded argv surface (no free-form extras). */
export function parseSendMessageArgv(argv: string[]): SendMessageCliArgs {
  let text: string | undefined;
  let sessionId: string | undefined;
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) {
      throw cliError("bad_arguments", MESSAGE_USAGE);
    }
    switch (flag) {
      case "--text":
        text = value;
        break;
      case "--session":
        sessionId = value;
        break;
      default:
        throw cliError("bad_arguments", MESSAGE_USAGE);
    }
  }
  if (
    text === undefined ||
    text.trim().length === 0 ||
    text.length > MAX_USER_TEXT_LENGTH
  ) {
    throw cliError("bad_text", MESSAGE_USAGE);
  }
  return sessionId === undefined ? { text } : { text, sessionId };
}

/** Run the send subcommand; returns the fixed safe summary line. */
export function runSendMessageCli(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): string {
  const args = parseSendMessageArgv(argv);
  let config: ServerConfig;
  try {
    config = loadServerConfig(env);
  } catch {
    throw cliError(
      "invalid_configuration",
      "companion message failed: invalid configuration",
    );
  }
  const dbPath = config.dbPath;
  // Fail closed on a missing DB: better-sqlite3 would otherwise create an
  // empty file that the running server would then migrate.
  if (!existsSync(dbPath)) {
    throw cliError(
      "database_missing",
      "companion message failed: database missing",
    );
  }
  const handle = openKernelDatabase(dbPath);
  try {
    const repo = createKernelRepository(handle.raw);
    const sessionId = args.sessionId ?? repo.latestSessionId();
    if (sessionId === null) {
      throw cliError(
        "no_session",
        "companion message failed: no session to address",
      );
    }
    const message = repo.postCompanionMessage(sessionId, args.text, {
      timeZone: config.timeZone,
    });
    return `companion message sent: session=${sessionId} turn=${message.turnId} seq=${message.seq}`;
  } catch (error) {
    if (error instanceof CompanionMessageCliError) {
      throw error;
    }
    throw cliError("send_failed", "companion message failed");
  } finally {
    closeKernelDatabase(handle);
  }
}

function isMainModule(): boolean {
  const invoked = process.argv[1];
  return invoked?.endsWith("companion_message_cli.ts") ?? false;
}

if (isMainModule()) {
  const [command, ...rest] = process.argv.slice(2);
  if (command !== "send") {
    process.stderr.write(
      `companion message failed: unknown command. ${MESSAGE_USAGE}\n`,
    );
    process.exit(1);
  }
  try {
    process.stdout.write(`${runSendMessageCli(rest)}\n`);
  } catch (error) {
    const message =
      error instanceof CompanionMessageCliError
        ? error.message
        : "companion message failed";
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}
