// Operator CLI for conversation learning.
//
// There is deliberately no HTTP route and no model-callable approve/reject.
// Candidates are model output: only an operator can approve the EXACT
// content hash shown by `show`. Retrieval then uses approved same-session
// lessons as untrusted advisory context.
//
// Usage:
//   pnpm learning list [pending|approved|rejected]
//   pnpm learning show <proposalId>
//   pnpm learning approve <proposalId> <contentSha256>
//   pnpm learning reject <proposalId>
//   pnpm learning reflections
//   pnpm learning applied [sessionId]
//
// stdout is the explicit operator response (JSON). stderr carries fixed
// safe messages only (never a path, raw error, or conversation text).

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createLearningStore,
  type LearningProposalStatus,
  type LearningStore,
} from "@companion/kernel";
import { loadServerConfig } from "./config.js";

const USAGE =
  "Use: learning <list [pending|approved|rejected]|show <id>|approve <id> <contentSha256>|reject <id>|reflections|applied [sessionId]>";

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const SESSION_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class LearningCliError extends Error {
  readonly cliCode: string;

  constructor(cliCode: string, message: string) {
    super(message);
    this.name = "LearningCliError";
    this.cliCode = cliCode;
  }
}

function cliError(code: string, message: string): LearningCliError {
  return new LearningCliError(code, message);
}

export function toSafeLearningCliMessage(error: unknown): string {
  if (error instanceof LearningCliError) return error.message;
  return "learning command failed";
}

function openStore(env: NodeJS.ProcessEnv): LearningStore {
  let config: ReturnType<typeof loadServerConfig>;
  try {
    config = loadServerConfig(env);
  } catch {
    throw cliError(
      "invalid_configuration",
      "learning failed: invalid configuration",
    );
  }
  if (config.learning === null) {
    throw cliError(
      "learning_disabled",
      "learning failed: disabled; set COMPANION_LEARNING_JSON",
    );
  }
  try {
    return createLearningStore({ path: config.learning.dbPath });
  } catch {
    throw cliError("store_unavailable", "learning failed: store unavailable");
  }
}

function requireId(rest: readonly string[]): string {
  if (
    rest.length !== 1 ||
    rest[0] === undefined ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      rest[0],
    )
  ) {
    throw cliError("usage", `learning failed: ${USAGE}`);
  }
  return rest[0];
}

export function runLearningCli(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const args = [...argv];
  if (args[0] === "--") args.shift();
  const [command, ...rest] = args;
  if (command === undefined) {
    throw cliError("usage", `learning failed: ${USAGE}`);
  }
  if (command === "list") {
    if (
      rest.length > 1 ||
      (rest[0] !== undefined &&
        rest[0] !== "pending" &&
        rest[0] !== "approved" &&
        rest[0] !== "rejected")
    ) {
      throw cliError("usage", `learning failed: ${USAGE}`);
    }
  } else if (command === "approve") {
    if (rest.length !== 2 || !HASH_PATTERN.test(rest[1] as string)) {
      throw cliError("usage", `learning failed: ${USAGE}`);
    }
  } else if (command === "show" || command === "reject") {
    if (rest.length !== 1) {
      throw cliError("usage", `learning failed: ${USAGE}`);
    }
  } else if (command === "reflections") {
    if (rest.length !== 0) {
      throw cliError("usage", `learning failed: ${USAGE}`);
    }
  } else if (command === "applied") {
    if (
      rest.length > 1 ||
      (rest[0] !== undefined && !SESSION_PATTERN.test(rest[0]))
    ) {
      throw cliError("usage", `learning failed: ${USAGE}`);
    }
  } else {
    throw cliError("usage", `learning failed: ${USAGE}`);
  }

  const store = openStore(env);
  try {
    if (command === "list") {
      const status = rest[0] as LearningProposalStatus | undefined;
      return `${JSON.stringify(store.listProposals(status), null, 2)}\n`;
    }
    if (command === "reflections") {
      return `${JSON.stringify(store.listReflections(), null, 2)}\n`;
    }
    if (command === "applied") {
      return `${JSON.stringify(store.listApplications(rest[0]), null, 2)}\n`;
    }
    if (command === "show") {
      return `${JSON.stringify(store.show(requireId(rest)), null, 2)}\n`;
    }
    if (command === "reject") {
      return `${JSON.stringify(store.reject(requireId(rest)), null, 2)}\n`;
    }
    // approve: second argument MUST be the exact content hash from `show`.
    const id = requireId([rest[0] as string]);
    const expected = rest[1] as string;
    const current = store.show(id);
    if (current.contentHash !== expected) {
      throw cliError(
        "hash_mismatch",
        "learning failed: content hash does not match; nothing approved",
      );
    }
    return `${JSON.stringify(store.approve(id, expected), null, 2)}\n`;
  } finally {
    try {
      store.close();
    } catch {
      // Best effort: the command result/error above is authoritative.
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
    process.stdout.write(runLearningCli());
  } catch (error) {
    process.stderr.write(`${toSafeLearningCliMessage(error)}\n`);
    process.exitCode = 1;
  }
}
