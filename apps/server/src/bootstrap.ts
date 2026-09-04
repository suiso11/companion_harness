// Server bootstrap: exact startup order + graceful shutdown.
//
// Startup order (§9 blocker 7.8, §19.4):
//   config -> single DB/PRAGMA/version -> pre-migration backup +
//   quick_check/migrate -> RunEngine recovery/start -> listen.
// Recovery completes before the scheduler or HTTP accept anything.
//
// Graceful shutdown (§11.5, §19.4): mark draining (ready 503 / live 200,
// new message/retry rejected with Retry-After and no idempotency
// persistence), engine 10s drain, DB close, listener close last.

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  BUNDLED_SCHEMA_VERSION,
  closeKernelDatabase,
  createKernelRepository,
  getSchemaVersion,
  type KernelDatabaseHandle,
  migrateKernelDatabase,
  NewerDatabaseError,
  openKernelDatabase,
  quickCheck,
  RunEngine,
  StrategyRegistry,
} from "@companion/kernel";
import { serve } from "@hono/node-server";
import { createApp, type EnginePort, type ServerControls } from "./app.js";
import {
  assertDbPathHasNoSymlink,
  loadServerConfig,
  type ServerConfig,
} from "./config.js";
import { createStdServerLogger, type ServerLogger } from "./logger.js";

/** Graceful-drain natural-completion budget (§11.5: max 10s). */
export const SHUTDOWN_DRAIN_MS = 10_000;

export interface StartServerOptions {
  env?: NodeJS.ProcessEnv;
  /** Drain budget override (tests). Defaults to 10s. */
  drainMs?: number;
  logger?: ServerLogger;
  now?: () => number;
}

export interface StartedServer {
  config: ServerConfig;
  controls: ServerControls;
  engine: EnginePort;
  port: number;
  shutdown: (reason?: string) => Promise<void>;
}

function ensureDbDir(dbPath: string): void {
  // Re-check fail-closed guards, then create missing parents.
  assertDbPathHasNoSymlink(dbPath);
  mkdirSync(dirname(dbPath), { recursive: true });
  assertDbPathHasNoSymlink(dbPath);
}

export async function startServer(
  options: StartServerOptions = {},
): Promise<StartedServer> {
  const config = loadServerConfig(options.env);
  const logger = options.logger ?? createStdServerLogger(config.logLevel);
  const now = options.now ?? Date.now;
  const drainMs = options.drainMs ?? SHUTDOWN_DRAIN_MS;

  logger.info("server.starting", { port: config.port });
  ensureDbDir(config.dbPath);

  let handle: KernelDatabaseHandle | undefined;
  try {
    handle = openKernelDatabase(config.dbPath);
    const version = getSchemaVersion(handle.raw);
    if (version > BUNDLED_SCHEMA_VERSION) {
      throw new NewerDatabaseError(version, BUNDLED_SCHEMA_VERSION);
    }
    quickCheck(handle.raw);
    const migrated = await migrateKernelDatabase({
      db: handle.raw,
      backupDir: join(dirname(config.dbPath), "backups"),
    });
    logger.info("server.migrated", { status: migrated.toVersion });

    const repo = createKernelRepository(handle.raw);
    // M0 production registers no model strategy: without the M2 agent,
    // runs fail closed with a fixed code instead of pretending to be an LLM.
    const engine = new RunEngine({
      db: handle.raw,
      repo,
      registry: new StrategyRegistry(),
    });
    const recovery = engine.start();
    logger.info("server.recovered", {
      status: recovery.abandoned + recovery.cancelled,
    });

    const { app, controls } = createApp({ config, repo, engine, logger, now });
    interface ListenerHandle {
      address(): unknown;
      close(callback?: () => void): void;
      on(event: "error", listener: (error: unknown) => void): void;
    }
    const server = (await new Promise<ListenerHandle>(
      (resolvePromise, rejectPromise) => {
        let settled = false;
        let listener: ListenerHandle;
        try {
          listener = serve(
            { fetch: app.fetch, port: config.port, hostname: config.host },
            (info) => {
              if (!settled) {
                settled = true;
                logger.info("server.listening", { port: info.port });
                resolvePromise(listener);
              }
            },
          ) as unknown as ListenerHandle;
        } catch (error) {
          rejectPromise(error);
          return;
        }
        listener.on("error", (error: unknown) => {
          if (!settled) {
            settled = true;
            rejectPromise(error);
          }
        });
      },
    )) as ListenerHandle;

    const address = server.address() as { port?: unknown } | string | null;
    const port =
      typeof address === "object" &&
      address !== null &&
      typeof address.port === "number"
        ? address.port
        : config.port;

    let shutdownPromise: Promise<void> | undefined;
    const shutdown = async (reason = "signal"): Promise<void> => {
      if (shutdownPromise !== undefined) {
        await shutdownPromise;
        return;
      }
      shutdownPromise = (async (): Promise<void> => {
        controls.markDraining();
        logger.info("server.draining", { status: reason });
        try {
          await engine.shutdown({ drainMs });
        } catch {
          logger.error("server.drain_failed", { status: reason });
        }
        try {
          if (handle !== undefined) {
            closeKernelDatabase(handle);
          }
        } catch {
          logger.error("server.db_close_failed", { status: reason });
        }
        await new Promise<void>((resolveClose) => {
          server.close(() => resolveClose());
        });
        logger.info("server.stopped", { status: reason });
      })();
      await shutdownPromise;
    };

    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.on(signal, () => {
        void shutdown(signal);
      });
    }

    return { config, controls, engine, port, shutdown };
  } catch (error) {
    if (handle !== undefined) {
      try {
        closeKernelDatabase(handle);
      } catch {
        // Best effort: the original startup error carries the failure.
      }
    }
    const code = error instanceof Error ? error.name : "startup_failed";
    logger.error("server.start_failed", { status: code });
    throw error;
  }
}

export async function startServerFromEnv(): Promise<StartedServer> {
  return startServer({});
}
