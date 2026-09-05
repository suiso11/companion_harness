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

import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createMarkdownConnector } from "@companion/connector-markdown";
import {
  BUNDLED_SCHEMA_VERSION,
  closeKernelDatabase,
  createKernelRepository,
  createM1ToolRegistrations,
  createReferenceManager,
  createToolBroker,
  getSchemaVersion,
  type KernelDatabaseHandle,
  migrateKernelDatabase,
  NewerDatabaseError,
  openKernelDatabase,
  quickCheck,
  RunEngine,
  StrategyRegistry,
  type ToolBroker,
} from "@companion/kernel";
import { serve } from "@hono/node-server";
import { createApp, type EnginePort, type ServerControls } from "./app.js";
import {
  assertDbPathHasNoSymlink,
  DEFAULT_LOG_LEVEL,
  loadServerConfig,
  type ServerConfig,
  ServerConfigError,
} from "./config.js";
import { createStdServerLogger, type ServerLogger } from "./logger.js";
import {
  measureStoreSize,
  type StatFn,
  shouldWarnStoreSize,
} from "./maintenance.js";

/** Graceful-drain natural-completion budget (§11.5: max 10s). */
export const SHUTDOWN_DRAIN_MS = 10_000;

export interface StartServerOptions {
  env?: NodeJS.ProcessEnv;
  /** Drain budget override (tests). Defaults to 10s. */
  drainMs?: number;
  logger?: ServerLogger;
  now?: () => number;
  /** Injectable stat for the DB+WAL size warning (tests). */
  stat?: StatFn;
  /** Injectable platform override (tests). Defaults to process.platform. */
  platform?: string;
  /** Injectable chmod for the app-dir mode (tests). Defaults to chmodSync. */
  chmod?: (path: string, mode: number) => void;
}

export interface StartedServer {
  config: ServerConfig;
  controls: ServerControls;
  engine: EnginePort;
  port: number;
  shutdown: (reason?: string) => Promise<void>;
  /** M1 ToolBroker when Markdown roots are configured, else null (M2 hook). */
  toolBroker: ToolBroker | null;
}

/** Fixed path-free display name for the single M1 Markdown connector. */
export const MARKDOWN_CONNECTOR_DISPLAY_NAME = "markdown-vault";

function ensureDbDir(
  dbPath: string,
  deps: {
    platform?: string;
    chmod?: (path: string, mode: number) => void;
  } = {},
): void {
  // Re-check fail-closed guards, then create missing parents.
  assertDbPathHasNoSymlink(dbPath);
  mkdirSync(dirname(dbPath), { recursive: true });
  // Private POSIX permissions (0700) for the app dir. Windows: current-user
  // ACL reliance, no chmod guarantee. POSIX chmod failure is fail-closed:
  // startup aborts with a fixed safe error (no path in the message).
  const platform = deps.platform ?? process.platform;
  if (platform !== "win32") {
    const chmod = deps.chmod ?? chmodSync;
    try {
      chmod(dirname(dbPath), 0o700);
    } catch (error) {
      throw new ServerConfigError("database directory permissions failed", {
        cause: error,
      });
    }
  }
  assertDbPathHasNoSymlink(dbPath);
}

interface ListenerHandle {
  address(): unknown;
  close(callback?: (error?: unknown) => void): void;
  on(event: "error", listener: (error: unknown) => void): void;
}

/**
 * Fixed shutdown-reason vocabulary. Arbitrary caller reasons never enter
 * logs verbatim (logger also enforces a pattern + "unknown" fallback).
 */
export function sanitizeShutdownReason(reason: string): string {
  const lowered = reason.toLowerCase();
  if (lowered === "sigint" || lowered === "sigterm" || lowered === "signal") {
    return lowered;
  }
  return "unknown";
}

/** Closed startup-error vocabulary: only known M0 codes pass, else "unknown". */
const STARTUP_STATUS_ALLOWLIST: ReadonlySet<string> = new Set([
  "newer_database",
  "unknown",
  "server_config_invalid",
  "kernel_pragmas_invalid",
  "kernel_quick_check_failed",
  "kernel_backup_failed",
  "kernel_database_newer_than_bundle",
  "kernel_migration_missing",
  "kernel_migration_failed",
  "kernel_backup_required",
]);

/** Fixed startup-error vocabulary: error names never enter logs verbatim. */
export function sanitizeStartupErrorStatus(error: unknown): string {
  if (error instanceof NewerDatabaseError) {
    return "newer_database";
  }
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") {
      const lowered = code.toLowerCase();
      if (STARTUP_STATUS_ALLOWLIST.has(lowered)) {
        return lowered;
      }
    }
  }
  return "unknown";
}

export async function startServer(
  options: StartServerOptions = {},
): Promise<StartedServer> {
  // Early config load: failures have no valid logLevel, so log exactly once
  // through the injected logger or a safe default. Only the sanitized fixed
  // status is emitted (never paths or raw values). Later startup failures
  // are logged exactly once by the post-config catch below, which this
  // early throw never reaches, so no double logging occurs.
  let config: ServerConfig;
  try {
    config = loadServerConfig(options.env);
  } catch (error) {
    const earlyLogger =
      options.logger ?? createStdServerLogger(DEFAULT_LOG_LEVEL);
    earlyLogger.error("server.start_failed", {
      status: sanitizeStartupErrorStatus(error),
    });
    throw error;
  }
  const logger = options.logger ?? createStdServerLogger(config.logLevel);
  const now = options.now ?? Date.now;
  const drainMs = options.drainMs ?? SHUTDOWN_DRAIN_MS;

  logger.info("server.starting", { port: config.port });

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
    ensureDbDir(config.dbPath, {
      ...(options.platform !== undefined ? { platform: options.platform } : {}),
      ...(options.chmod !== undefined ? { chmod: options.chmod } : {}),
    });
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
    // DB+WAL combined size warning (§19.1): warning only above exactly
    // 1 GiB. No vacuum/delete. Never logs the DB path.
    try {
      const size =
        options.stat !== undefined
          ? measureStoreSize(config.dbPath, options.stat)
          : measureStoreSize(config.dbPath);
      if (shouldWarnStoreSize(size.totalBytes)) {
        logger.warn("server.store_size_warning", { bytes: size.totalBytes });
      }
    } catch {
      // Best effort: sizing never blocks startup.
    }
    const migrated = await migrateKernelDatabase({
      db: handle.raw,
      backupDir: join(dirname(config.dbPath), "backups"),
    });
    logger.info("server.migrated", { status: migrated.toVersion });

    // Bound-roots guard: removing every Markdown root while a Markdown
    // connector instance remains bound must fail closed before the engine
    // or listener starts. Fixed path-free ServerConfigError, no DB writes.
    if (config.markdownRoots.length === 0) {
      const bound = handle.raw
        .prepare(
          "SELECT COUNT(*) AS n FROM connector_instances WHERE kind = 'markdown'",
        )
        .get() as { n: number };
      if (bound.n > 0) {
        throw new ServerConfigError(
          "markdown roots must not be removed while bound",
        );
      }
    }

    const repo = createKernelRepository(handle.raw);
    // M1 (plan 14.1/14.5-14.6): after migration and before engine
    // recovery/listen, when roots are configured create one connector
    // owning all roots, ensure one fingerprint-bound instance, then the
    // four M1 registrations and a ToolBroker on the same db/repo. No M2
    // strategy and no invocation endpoint here. No roots => null (M0).
    let toolBroker: ToolBroker | null = null;
    if (config.markdownRoots.length > 0) {
      const connector = await createMarkdownConnector(
        config.markdownRoots.map((root) =>
          root.alias === undefined
            ? { path: root.path }
            : { path: root.path, alias: root.alias },
        ),
      );
      const referenceManager = createReferenceManager(handle.raw);
      const instance = referenceManager.ensureMarkdownConnectorInstance(
        MARKDOWN_CONNECTOR_DISPLAY_NAME,
        config.markdownRoots.length,
        { configFingerprint: connector.identityFingerprint },
      );
      const registrations = createM1ToolRegistrations({
        db: handle.raw,
        repo,
        referenceManager,
        bindings: [{ connectorInstanceId: instance.id, connector }],
      });
      toolBroker = createToolBroker({ db: handle.raw, repo, registrations });
      logger.info("server.markdown_ready", { status: registrations.length });
    }
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
        const safeReason = sanitizeShutdownReason(reason);
        logger.info("server.draining", { status: safeReason });
        try {
          await activeEngine.shutdown({ drainMs });
        } catch {
          // Fail closed: leave DB + listener open and stay draining
          // (ready remains not_ready); do not report stopped so a later
          // shutdown retry can still drain. Reset the memo to permit retry.
          logger.error("server.drain_failed", { status: safeReason });
          shutdownPromise = undefined;
          throw new Error("server drain failed");
        }
        try {
          closeKernelDatabase(activeHandle);
        } catch {
          logger.error("server.db_close_failed", { status: safeReason });
        }
        await new Promise<void>((resolveClose) => {
          try {
            server.close(() => resolveClose());
          } catch {
            resolveClose();
          }
        });
        logger.info("server.stopped", { status: safeReason });
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

    return {
      config,
      controls,
      engine: activeEngine,
      port,
      shutdown,
      toolBroker,
    };
  } catch (error) {
    removeSignalHandlers();
    if (handle !== undefined) {
      try {
        closeKernelDatabase(handle);
      } catch {
        // Best effort: the original startup error carries the failure.
      }
    }
    const code = sanitizeStartupErrorStatus(error);
    logger.error("server.start_failed", { status: code });
    throw error;
  }
}

export async function startServerFromEnv(): Promise<StartedServer> {
  return startServer({});
}
