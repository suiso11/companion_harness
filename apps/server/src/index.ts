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
  SHUTDOWN_DRAIN_MS,
  startServer,
  startServerFromEnv,
} from "./bootstrap.js";
export type { ServerConfig, ServerHost, ServerLogLevel } from "./config.js";
export {
  assertDbPathHasNoSymlink,
  defaultDbPath,
  isIanaTimeZone,
  loadServerConfig,
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
} from "./logger.js";

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

if (isMainModule()) {
  const { startServerFromEnv: start } = await import("./bootstrap.js");
  start().catch((error: unknown) => {
    const name = error instanceof Error ? error.name : "startup_failed";
    process.stderr.write(
      `${JSON.stringify({ level: "error", code: "server.start_failed", status: name })}\n`,
    );
    process.exitCode = 1;
  });
}
