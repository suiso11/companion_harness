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
//
// Symlink TOCTOU note: better-sqlite3 opens by filesystem path with no
// portable O_NOFOLLOW/no-follow open option, so a symlink swap between the
// pre-open check and open() cannot be fully eliminated on this stack. The
// bootstrap narrows the window with an immediate post-open recheck of the
// configured DB path (fail closed) before any migration writes.

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

interface ListenerHandle {
  address(): unknown;
  close(callback?: (error?: unknown) => void): void;
  on(event: "error", listener: (error: unknown) => void): void;
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
  let engine: RunEngine | undefined;
  let startedListener: ListenerHandle | undefined;
  let onSigint: (() => void) | undefined;
  let onSigterm: (() => void) | undefined;
  const removeSignalHandlers = (): void => {
    if (onSigint !== undefined) {
      try {
        process.off("SIGINT", onSigint);
      } catch {
        // Best effort.
      }
      onSigint = undefined;
    }
    if (onSigterm !== undefined) {
      try {
        process.off("SIGTERM", onSigterm);
      } catch {
        // Best effort.
      }
      onSigterm = undefined;
    }
  };
  try {
    handle = openKernelDatabase(config.dbPath);
    // Immediate post-open symlink recheck before any migration writes.
    // Residual TOCTOU: better-sqlite3 has no portable no-follow open, so a
    // concurrent path swap in the narrow open->recheck window is still
    // theoretically possible; the recheck only narrows, not eliminates it.
    assertDbPathHasNoSymlink(config.dbPath);
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
    engine = new RunEngine({
      db: handle.raw,
      repo,
      registry: new StrategyRegistry(),
    });
    const recovery = engine.start();
    logger.info("server.recovered", {
      status: recovery.abandoned + recovery.cancelled,
    });

    const { app, controls } = createApp({ config, repo, engine, logger, now });
    const activeEngine = engine;
    const activeHandle = handle;
    let server: ListenerHandle;
    try {
      server = await new Promise<ListenerHandle>(
        (resolvePromise, rejectPromise) => {
          let settled = false;
          let listener: ListenerHandle | undefined;
          try {
            listener = serve(
              { fetch: app.fetch, port: config.port, hostname: config.host },
              (info) => {
                if (!settled) {
                  settled = true;
                  logger.info("server.listening", { port: info.port });
                  if (listener !== undefined) {
                    resolvePromise(listener);
                  } else {
                    rejectPromise(new Error("listener unavailable"));
                  }
                }
              },
            ) as unknown as ListenerHandle;
            if (listener !== undefined) {
              startedListener = listener;
            }
          } catch (error) {
            rejectPromise(error);
            return;
          }
          listener?.on("error", (error: unknown) => {
            if (!settled) {
              settled = true;
              rejectPromise(error);
            }
          });
        },
      );
    } catch (listenError) {
      // Listen failed: drain the started engine, close any created
      // listener, then close the DB (in that order). Handlers were not
      // yet registered, but remove defensively before rethrowing.
      try {
        if (engine !== undefined) {
          await engine.shutdown({ drainMs });
        }
      } catch {
        // Best effort: the listen error carries the startup failure.
      }
      try {
        if (startedListener !== undefined) {
          await new Promise<void>((resolveClose) => {
            try {
              startedListener?.close(() => resolveClose());
            } catch {
              resolveClose();
            }
          });
        }
      } catch {
        // Best effort.
      }
      throw listenError;
    }
    startedListener = server;

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
          await activeEngine.shutdown({ drainMs });
        } catch {
          // Fail closed: leave DB + listener open and stay draining
          // (ready remains not_ready); do not report stopped so a later
          // shutdown retry can still drain. Reset the memo to permit retry.
          logger.error("server.drain_failed", { status: reason });
          shutdownPromise = undefined;
          throw new Error("server drain failed");
        }
        try {
          closeKernelDatabase(activeHandle);
        } catch {
          logger.error("server.db_close_failed", { status: reason });
        }
        await new Promise<void>((resolveClose) => {
          try {
            server.close(() => resolveClose());
          } catch {
            resolveClose();
          }
        });
        logger.info("server.stopped", { status: reason });
        removeSignalHandlers();
      })();
      await shutdownPromise;
    };

    onSigint = () => {
      void shutdown("SIGINT").catch(() => undefined);
    };
    onSigterm = () => {
      void shutdown("SIGTERM").catch(() => undefined);
    };
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);

    return { config, controls, engine: activeEngine, port, shutdown };
  } catch (error) {
    removeSignalHandlers();
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
