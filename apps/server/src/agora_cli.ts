// Operator CLI for AGORA participation.
//
// There is no HTTP route, no model tool, and no arbitrary URL surface. The
// host and write paths are fixed in the kernel. Public reads are unauthenticated.
// Every public write requires BOTH an exact-payload approval and a send step
// that consumes it once. The API key (host env or private post-registration
// store) is never printed.
//
// Usage:
//   pnpm agora draft-register
//   pnpm agora hello
//   pnpm agora thread <threadId>
//   pnpm agora propose-register <name> <description>
//   pnpm agora propose-thread <title> <body>
//   pnpm agora propose-reply <threadId> <body>
//   pnpm agora list [status]
//   pnpm agora show <proposalId>
//   pnpm agora approve <proposalId> <payloadSha256>
//   pnpm agora reject <proposalId>
//   pnpm agora send <proposalId> <payloadSha256>
//
// stdout is JSON. stderr carries fixed safe messages only: never a key,
// path, arbitrary URL, or raw provider text.

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGORA_SUGGESTED_REGISTRATION,
  type AgoraProposalStatus,
  type AgoraService,
  createAgoraHttpTransport,
  createAgoraStore,
} from "@companion/kernel";
import {
  AGORA_API_KEY_ENV,
  loadServerConfig,
  parseAgoraApiKey,
} from "./config.js";

const USAGE =
  "Use: agora <draft-register|hello|thread <id>|propose-register <name> <description>|propose-thread <title> <body>|propose-reply <threadId> <body>|list [status]|show <id>|approve <id> <hash>|reject <id>|send <id> <hash>>";

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const THREAD_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export class AgoraCliError extends Error {
  readonly cliCode: string;

  constructor(cliCode: string, message: string) {
    super(message);
    this.name = "AgoraCliError";
    this.cliCode = cliCode;
  }
}

function cliError(code: string, message: string): AgoraCliError {
  return new AgoraCliError(code, message);
}

export function toSafeAgoraCliMessage(error: unknown): string {
  if (error instanceof AgoraCliError) return error.message;
  return "agora command failed";
}

function openService(env: NodeJS.ProcessEnv): AgoraService {
  let config: ReturnType<typeof loadServerConfig>;
  let hostApiKey: string | null;
  try {
    config = loadServerConfig(env);
    hostApiKey = parseAgoraApiKey(env[AGORA_API_KEY_ENV]);
  } catch {
    throw cliError(
      "invalid_configuration",
      "agora failed: invalid configuration",
    );
  }
  if (config.agora === null) {
    throw cliError(
      "agora_disabled",
      "agora failed: disabled; set COMPANION_AGORA_JSON",
    );
  }
  try {
    return createAgoraStore({
      path: config.agora.dbPath,
      minWriteIntervalMs: config.agora.minWriteIntervalMs,
      hostApiKey,
      transport: createAgoraHttpTransport({
        timeoutMs: config.agora.timeoutMs,
        maxResponseBytes: config.agora.maxResponseBytes,
      }),
    });
  } catch {
    throw cliError("store_unavailable", "agora failed: store unavailable");
  }
}

function requireId(value: string | undefined): string {
  if (value === undefined || !UUID_PATTERN.test(value)) {
    throw cliError("usage", `agora failed: ${USAGE}`);
  }
  return value;
}

function requireHash(value: string | undefined): string {
  if (value === undefined || !HASH_PATTERN.test(value)) {
    throw cliError("usage", `agora failed: ${USAGE}`);
  }
  return value;
}

function requireText(value: string | undefined): string {
  if (value === undefined || value.length === 0) {
    throw cliError("usage", `agora failed: ${USAGE}`);
  }
  return value;
}

function print(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Execute one agora subcommand. Exported for the permanent CLI tests. */
export async function runAgoraCli(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  serviceOverride?: AgoraService,
): Promise<string> {
  const args = [...argv];
  if (args[0] === "--") args.shift();
  const [command, ...rest] = args;
  if (command === undefined) {
    throw cliError("usage", `agora failed: ${USAGE}`);
  }
  if (command === "draft-register") {
    if (rest.length !== 0) {
      throw cliError("usage", `agora failed: ${USAGE}`);
    }
    return print({
      suggested: AGORA_SUGGESTED_REGISTRATION,
      sent: false,
      note: "Draft only. Create a proposal, approve its exact hash, then send explicitly.",
    });
  }
  if (command === "hello") {
    if (rest.length !== 0) {
      throw cliError("usage", `agora failed: ${USAGE}`);
    }
  } else if (command === "thread") {
    if (
      rest.length !== 1 ||
      rest[0] === undefined ||
      !THREAD_ID_PATTERN.test(rest[0])
    ) {
      throw cliError("usage", `agora failed: ${USAGE}`);
    }
  } else if (command === "propose-register") {
    if (rest.length !== 2) {
      throw cliError("usage", `agora failed: ${USAGE}`);
    }
  } else if (command === "propose-thread") {
    if (rest.length !== 2) {
      throw cliError("usage", `agora failed: ${USAGE}`);
    }
  } else if (command === "propose-reply") {
    if (
      rest.length !== 2 ||
      rest[0] === undefined ||
      !THREAD_ID_PATTERN.test(rest[0])
    ) {
      throw cliError("usage", `agora failed: ${USAGE}`);
    }
  } else if (command === "list") {
    if (
      rest.length > 1 ||
      (rest[0] !== undefined &&
        ![
          "pending",
          "approved",
          "rejected",
          "sending",
          "sent",
          "unknown",
          "failed",
        ].includes(rest[0]))
    ) {
      throw cliError("usage", `agora failed: ${USAGE}`);
    }
  } else if (command === "show" || command === "reject") {
    if (rest.length !== 1) {
      throw cliError("usage", `agora failed: ${USAGE}`);
    }
  } else if (command === "approve" || command === "send") {
    if (rest.length !== 2) {
      throw cliError("usage", `agora failed: ${USAGE}`);
    }
  } else {
    throw cliError("usage", `agora failed: ${USAGE}`);
  }

  const service = serviceOverride ?? openService(env);
  try {
    if (command === "hello") {
      return print(await service.readHello());
    }
    if (command === "thread") {
      return print(await service.readThread(requireText(rest[0])));
    }
    if (command === "propose-register") {
      return print(
        service.propose({
          operation: "register",
          payload: {
            name: requireText(rest[0]),
            description: requireText(rest[1]),
          },
        }),
      );
    }
    if (command === "propose-thread") {
      return print(
        service.propose({
          operation: "thread",
          payload: {
            title: requireText(rest[0]),
            body: requireText(rest[1]),
          },
        }),
      );
    }
    if (command === "propose-reply") {
      return print(
        service.propose({
          operation: "reply",
          payload: {
            threadId: requireText(rest[0]),
            body: requireText(rest[1]),
          },
        }),
      );
    }
    if (command === "list") {
      return print(service.list(rest[0] as AgoraProposalStatus | undefined));
    }
    if (command === "show") {
      return print(service.show(requireId(rest[0])));
    }
    if (command === "reject") {
      return print(service.reject(requireId(rest[0])));
    }
    if (command === "approve") {
      const id = requireId(rest[0]);
      const hash = requireHash(rest[1]);
      const current = service.show(id);
      if (current.payloadHash !== hash) {
        throw cliError(
          "hash_mismatch",
          "agora failed: payload hash does not match; nothing approved",
        );
      }
      return print(service.approve(id, hash));
    }
    // send
    const id = requireId(rest[0]);
    const hash = requireHash(rest[1]);
    const current = service.show(id);
    if (current.payloadHash !== hash) {
      throw cliError(
        "hash_mismatch",
        "agora failed: payload hash does not match; nothing sent",
      );
    }
    return print(await service.send(id, hash));
  } finally {
    if (serviceOverride === undefined) {
      try {
        service.close();
      } catch {
        // Best effort: the command result/error above is authoritative.
      }
    }
  }
}

function isMainModule(): boolean {
  const main = (import.meta as ImportMeta & { main?: boolean }).main;
  if (main === true) return true;
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  try {
    return (
      realpathSync(resolve(invoked)) ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (isMainModule()) {
  try {
    process.stdout.write(await runAgoraCli());
  } catch (error) {
    process.stderr.write(`${toSafeAgoraCliMessage(error)}\n`);
    process.exitCode = 1;
  }
}
