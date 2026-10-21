// Local operator CLI for the opt-in PRIVATE execution-record store.
//
// There is deliberately NO HTTP route that returns raw records. stdout is
// the explicit operator request; stderr carries only fixed safe messages
// (never a path, record id echo, payload, or raw error text). The store is
// addressed only by COMPANION_EXECUTION_RECORDS_JSON; when unset the CLI
// fails closed with actionable usage instead of creating a default store.
//
// Usage:
//   pnpm --filter @companion/server records list
//   pnpm --filter @companion/server records show <recordId>
//   pnpm --filter @companion/server records export <runId>
//   pnpm --filter @companion/server records delete <recordId>
//   pnpm --filter @companion/server records prune [retentionDays]
//
// `export` prints the complete stored records for one run as JSON on
// stdout. IDs are validated by the store (record ids are UUID-v4; run ids
// are hashed before becoming a path segment), so traversal strings fail.

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExecutionRecordStore } from "@companion/kernel";
import {
  createExecutionRecordStore,
  ExecutionRecordError,
} from "@companion/kernel";
import {
  type ExecutionRecordsConfig,
  loadServerConfig,
  MAX_EXECUTION_RECORDS_RETENTION_DAYS,
} from "./config.js";

const USAGE =
  "Use: records <list|show <id>|export <runId>|delete <id>|prune [days]>";

export class RecordsCliError extends Error {
  readonly cliCode: string;

  constructor(cliCode: string, message: string) {
    super(message);
    this.name = "RecordsCliError";
    this.cliCode = cliCode;
  }
}

function cliError(cliCode: string, message: string): RecordsCliError {
  return new RecordsCliError(cliCode, message);
}

/** Map any failure to fixed safe text (no payload/path/id/raw message). */
export function toSafeRecordsCliMessage(error: unknown): string {
  if (error instanceof RecordsCliError) {
    return error.message;
  }
  if (error instanceof ExecutionRecordError) {
    switch (error.code) {
      case "record_read_failed":
        return "records failed: storage read failed";
      case "record_write_failed":
        return "records failed: storage write failed";
      case "record_path_unsafe":
        return "records failed: unsafe record path";
      case "record_too_large":
        return "records failed: record too large";
      default:
        return "records failed: record not found or invalid";
    }
  }
  return "records failed";
}

function requireRecordsConfig(env: NodeJS.ProcessEnv): ExecutionRecordsConfig {
  let config: ReturnType<typeof loadServerConfig>;
  try {
    config = loadServerConfig(env);
  } catch {
    throw cliError(
      "invalid_configuration",
      "records failed: invalid configuration",
    );
  }
  if (config.executionRecords === null) {
    throw cliError(
      "records_disabled",
      "records failed: disabled; set COMPANION_EXECUTION_RECORDS_JSON",
    );
  }
  return config.executionRecords;
}

function openStore(records: ExecutionRecordsConfig): ExecutionRecordStore {
  try {
    return createExecutionRecordStore({ directory: records.directory });
  } catch {
    throw cliError(
      "store_unavailable",
      "records failed: private record directory unavailable",
    );
  }
}

function requireStore(env: NodeJS.ProcessEnv): ExecutionRecordStore {
  return openStore(requireRecordsConfig(env));
}

function requireSingleArgument(rest: readonly string[]): string {
  if (rest.length !== 1 || rest[0] === undefined || rest[0].length === 0) {
    throw cliError("usage", `records failed: ${USAGE}`);
  }
  return rest[0];
}

function parseRetention(raw: string | undefined, fallback: number): number {
  if (raw === undefined) {
    return fallback;
  }
  if (!/^[0-9]{1,5}$/.test(raw)) {
    throw cliError("usage", `records failed: ${USAGE}`);
  }
  const days = Number(raw);
  if (!Number.isInteger(days) || days > MAX_EXECUTION_RECORDS_RETENTION_DAYS) {
    throw cliError("usage", `records failed: ${USAGE}`);
  }
  return days;
}

/**
 * Execute one records subcommand and return the exact stdout text. The
 * caller writes it verbatim; no other code path prints record contents.
 */
export function runRecordsCli(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): string {
  // `pnpm records -- list` passes the separator through; never treat it as
  // a subcommand.
  const effective = argv[0] === "--" ? argv.slice(1) : argv;
  const [command, ...rest] = effective;
  if (command === undefined) {
    throw cliError("usage", `records failed: ${USAGE}`);
  }
  if (command === "list") {
    if (rest.length > 0) {
      throw cliError("usage", `records failed: ${USAGE}`);
    }
    const listing = requireStore(env).list();
    return `${JSON.stringify(listing, null, 2)}\n`;
  }
  if (command === "show") {
    const id = requireSingleArgument(rest);
    const record = requireStore(env).inspect(id);
    return `${JSON.stringify(record, null, 2)}\n`;
  }
  if (command === "export") {
    const runId = requireSingleArgument(rest);
    const records = requireStore(env).exportRun(runId);
    return `${JSON.stringify({ runId, records }, null, 2)}\n`;
  }
  if (command === "delete") {
    const id = requireSingleArgument(rest);
    const deleted = requireStore(env).deleteRecord(id);
    return `${JSON.stringify({ deleted }, null, 2)}\n`;
  }
  if (command === "prune") {
    if (rest.length > 1) {
      throw cliError("usage", `records failed: ${USAGE}`);
    }
    const records = requireRecordsConfig(env);
    const store = openStore(records);
    // No explicit argument: use the configured retentionDays, not a global
    // default, so `prune` matches the operator's opt-in policy.
    const days = parseRetention(rest[0], records.retentionDays);
    const removed = store.prune(days);
    return `${JSON.stringify({ removed }, null, 2)}\n`;
  }
  throw cliError("usage", `records failed: ${USAGE}`);
}

function isMainModule(): boolean {
  // Filename-suffix matching silently skipped the CLI for renamed/compiled
  // entrypoints; use the runtime's entry-module flag with a path fallback.
  const main = (import.meta as ImportMeta & { main?: boolean }).main;
  if (main === true) {
    return true;
  }
  const invoked = process.argv[1];
  if (invoked === undefined) {
    return false;
  }
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
    const output = runRecordsCli();
    process.stdout.write(output);
  } catch (error) {
    process.stderr.write(`${toSafeRecordsCliMessage(error)}\n`);
    process.exitCode = 1;
  }
}
