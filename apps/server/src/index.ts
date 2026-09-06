// @companion/server — M0 Hono composition root.
//
// Re-exports the testable composition surface (config, redacted logging,
// app factory, bootstrap). The process listens only when this module is
// the executed entrypoint; importing it (tests, tooling) never listens.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type {
  CreateAppDeps,
  CreatedServerApp,
  EnginePort,
  ServerControls,
} from "./app.js";
export { createApp, hostNameOfHeader } from "./app.js";
export type { StartedServer, StartServerOptions } from "./bootstrap.js";
export {
  AGENT_STRATEGY_NAME,
  createModelGateway,
  SHUTDOWN_DRAIN_MS,
  sanitizeShutdownReason,
  sanitizeStartupErrorStatus,
  startServer,
  startServerFromEnv,
} from "./bootstrap.js";
export type {
  ModelAdapter,
  ModelConfig,
  ServerConfig,
  ServerHost,
  ServerLogLevel,
} from "./config.js";
export {
  assertDbPathHasNoSymlink,
  defaultDbPath,
  isIanaTimeZone,
  loadServerConfig,
  parseModelConfig,
  ServerConfigError,
} from "./config.js";
export type {
  ServerLogFields,
  ServerLogger,
  ServerLogRecord,
} from "./logger.js";
export {
  createCollectingLogger,
  createServerLogger,
  createStdServerLogger,
  sanitizeLogStatus,
} from "./logger.js";
export type { StoreSize } from "./maintenance.js";
export {
  measureStoreSize,
  STORE_SIZE_WARN_BYTES,
  shouldWarnStoreSize,
} from "./maintenance.js";

function isMainModule(): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined) {
    return false;
  }
  try {
    return resolve(invoked) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

/**
 * Startup-failure ownership: `startServer`/`startServerFromEnv` in
 * `bootstrap.ts` is the single owner of the sanitized `server.start_failed`
 * log (exactly once per failure, config-parse and late bootstrap paths, no
 * raw errors or paths). This top-level handler stays silent and only sets
 * the exit code so programmatic callers and the CLI never double-log.
 */
export function handleStartupError(_error: unknown): void {
  void _error;
  process.exitCode = 1;
}

if (isMainModule()) {
  const { startServerFromEnv: start } = await import("./bootstrap.js");
  start().catch((error: unknown) => {
    handleStartupError(error);
  });
}
