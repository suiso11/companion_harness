// Server bootstrap: exact startup order + graceful shutdown.
//
// Startup order (§9 blocker 7.8, §19.4):
//   config -> single DB/PRAGMA/version -> pre-migration backup +
//   quick_check/migrate -> RunEngine recovery/start -> listen.
// Recovery completes before the scheduler or HTTP accept anything.
//
// C14 Calendar/MCP composition: the strict opt-in
// COMPANION_CALENDAR_JSON config hint, TOGETHER with host-trusted
// read-only binding definitions injected as options (never env/config),
// makes the server OWN one MCP connector + one Calendar adapter:
// exact metadata-only instance registration before any connection,
// lazy (never startup-blocking) connect, bounded outer shutdown bound.
// Disabled (no config) and unavailable (dead upstream) never block
// server start; Calendar is usable without any Markdown root.
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

import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createCalendarConnector,
  DEFAULT_CALENDAR_ADAPTER_TOOLS,
} from "@companion/connector-calendar";
import { createMarkdownConnector } from "@companion/connector-markdown";
import {
  type McpBindingDefinition,
  McpConnector,
  type McpConnectorConfig,
  type TransportFactory,
} from "@companion/connector-mcp";
import {
  type ActionProposalStager,
  BUNDLED_SCHEMA_VERSION,
  CalendarActionWriteCapabilitySchema,
  type CalendarActionWritePort,
  type CalendarConnectorBinding,
  type CalendarConnectorPort,
  type CalendarTargetStore,
  closeKernelDatabase,
  createActionExecutionService,
  createActionStrategy,
  createAgentStrategy,
  createCalendarActionReadPort,
  createCalendarActionTargetResolver,
  createCalendarRescheduleProposalRegistration,
  createDurableCalendarTargetStore,
  createKernelRepository,
  createM1ToolRegistrations,
  createReferenceManager,
  createToolBroker,
  getSchemaVersion,
  type KernelDatabaseHandle,
  type MarkdownConnectorBinding,
  migrateKernelDatabase,
  NewerDatabaseError,
  openKernelDatabase,
  quickCheck,
  RunEngine,
  StrategyRegistry,
  type ToolBroker,
} from "@companion/kernel";
import {
  createOllamaGateway,
  createOpenAICompatibleGateway,
  type FetchImpl,
  type ModelGateway,
} from "@companion/model-local";
import { serve } from "@hono/node-server";
import { createApp, type EnginePort, type ServerControls } from "./app.js";
import {
  assertGoogleReadonlyHintCompatible,
  CALENDAR_PROFILE_ENV,
  GOOGLE_READONLY_CONNECTOR_DISPLAY_NAME,
  getGoogleReadonlyDefinitions,
  parseCalendarProfileName,
} from "./calendarReadonlyProfile.js";
import {
  assertDbPathHasNoSymlink,
  type CalendarConfig,
  DEFAULT_LOG_LEVEL,
  loadServerConfig,
  type ModelConfig,
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

/**
 * C14: outer bound for the ONE owned Calendar MCP connector's shutdown wait
 * during server shutdown. The connector already enforces its own bounded
 * stdio cleanup (config shutdownWaitMs + fixed force-kill window); this
 * outer race only guarantees the NORMAL server shutdown path cannot hang on
 * a pathological transport beyond this budget. Purely a backstop, never a
 * truncation of the connector's own guarantees.
 */
export const MCP_SHUTDOWN_BOUND_MS = 10_000;

/**
 * Fixed path-free display name for the single C14 owned Calendar MCP
 * connector instance (`connector_instances.kind = 'calendar'`). No path /
 * separator characters: the kernel displayName rules reject them.
 */
export const CALENDAR_CONNECTOR_DISPLAY_NAME = "calendar-mcp";

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
  /**
   * Injectable model gateway (tests). `undefined` (default) builds the
   * gateway from `config.model` via {@link createModelGateway}; an explicit
   * `null` disables the agent even when `config.model` is set. Production
   * never passes this field.
   */
  modelGateway?: ModelGateway | null;
  /**
   * Injectable fetch for gateway construction (tests). Only used when
   * `modelGateway` is `undefined` and `config.model` is set. Production
   * never passes this field (global fetch is used).
   */
  modelFetch?: FetchImpl;
  /**
   * Injectable Calendar composition seam (C12). Supplying an
   * already-constructed adapter over a trusted/validated MCP binding wires
   * `calendar.search` plus kind-dispatched `reference.refresh` over the DB's
   * durable private target store. `null`/absent keeps the production registry
   * network-disabled (no Calendar binding). The caller owns the MCP transport
   * and the stored `connector_instances` row for `connectorInstanceId`.
   */
  calendarBinding?: CalendarServerBinding | null;
  /**
   * C14: host-trusted MCP read-only binding definitions for the OWNED
   * Calendar composition. These come ONLY from trusted host code — NEVER
   * from env/config (no category flags as trusted authorization, no
   * provider adoption/profile shipped with this codebase). When
   * `config.calendar` is set, these definitions are REQUIRED (fail closed
   * otherwise) and act as the enable gate on top of the config hint: a
   * binding is compatible only when its configured name has exactly one
   * non-ambiguous definition, category `read`, whose canonical schema hash
   * links to the config hint hash AND the live tools/list hash (the latter
   * enforced internally by the connector). Absent definitions keep the
   * produced registry network-disabled only when Calendar is entirely
   * unconfigured/uninjected; a set config without them is an incomplete
   * opt-in and fails closed BEFORE listen.
   */
  mcpDefinitions?: readonly McpBindingDefinition[];
  /**
   * C14 (tests / fake E2E): injectable MCP transport factory used when
   * constructing the owned Calendar connector. Production never passes this
   * field (the real default stdio/loopback-HTTP factory is used).
   */
  mcpTransportFactory?: TransportFactory;
  /**
   * C14 (tests): outer bound override for the owned connector shutdown
   * wait. Production uses {@link MCP_SHUTDOWN_BOUND_MS}.
   */
  mcpShutdownMs?: number;
  /**
   * C21: the DEDICATED trusted CalendarActionWritePort seam, injected ONLY by
   * trusted host code — NEVER from env/config, which cannot carry a capability,
   * a category or a connector instance id. It becomes live ONLY when
   * `config.actions.optIn` AND `config.actions.writeEnabled` are both true AND
   * its enabled capability names the EXACT active Calendar instance.
   *
   * There is no production write binding in this codebase; tests and the C22
   * fake browser harness inject their own deterministic fake ports here.
   */
  actionWriteBinding?: ActionWriteBinding | null;
}

/**
 * One injected dedicated write binding plus its EXPLICIT lifecycle
 * ownership. A caller-owned port is never shut down by the server: shutdown
 * happens only when `owned === true` and a `shutdown` function is supplied.
 */
export interface ActionWriteBinding {
  /**
   * The exact trusted port (enabled capability, start/end fields only).
   * Mutually exclusive with {@link ActionWriteBinding.derivePort}; exactly one
   * of the two must be supplied.
   */
  readonly port?: CalendarActionWritePort;
  /**
   * C22 seam: derive the trusted port from the EXACT Calendar instance the
   * server itself just registered, so a host that cannot know the stored
   * `connector_instances.id` before `startServer` (the owned-composition
   * case) can still bind hostside without weakening the match rule: the
   * derived port's capability MUST name the id the server registered, and the
   * existing exact-identity check below still fails closed on any mismatch.
   * Invoked ONLY when `config.calendar` is configured (i.e. only after the
   * owned instance exists) and exactly once.
   */
  readonly derivePort?: (active: {
    readonly connectorInstanceId: string;
    readonly calendarId: string;
    readonly account?: string;
  }) => CalendarActionWritePort;
  /** Optional close hook; used only together with `owned === true`. */
  readonly shutdown?: () => Promise<void>;
  /**
   * Explicit ownership transfer to the server. Default FALSE: the caller
   * keeps ownership and the server never closes this port. Extra
   * caller-owned ports passed alongside it are never closed arbitrarily.
   */
  readonly owned?: boolean;
}

/** One trusted, already-validated Calendar binding injected by composition. */
export interface CalendarServerBinding {
  /** Stored `connector_instances.id` (kind `calendar`) the port is bound to. */
  readonly connectorInstanceId: string;
  /** Already-constructed, policy-validated Calendar adapter. */
  readonly connector: CalendarConnectorPort;
  /** Trusted single-calendar HOST selection (never model-controlled). */
  readonly selection: {
    readonly calendarId: string;
    readonly account?: string;
  };
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

/**
 * Engine strategy name the M2 agent registers under. Runs default to this
 * strategy (repository default), so without a registration they fail
 * closed with a fixed code instead of producing fake LLM output.
 */
export const AGENT_STRATEGY_NAME = "m0-default";

/**
 * C21: the M5 Action Run strategy name approved proposals are dispatched
 * under. Registered ONLY when the triple gate is open; without it an
 * approved proposal can never be queued, and a queued row would fail closed
 * on the missing strategy instead of running anything.
 */
export const ACTION_STRATEGY_NAME = "m5-action";

/**
 * Build the loopback-only model gateway for a validated model config.
 * `ollama` targets `{base}/api/chat`; `openai-compatible` targets
 * `{base}/v1/chat/completions` (or `{base}/chat/completions` when the base
 * already ends in `/v1`). An optional fetch override exists for tests only;
 * production uses the global fetch. Never logs its inputs.
 */
export function createModelGateway(
  model: ModelConfig,
  fetchImpl?: FetchImpl,
): ModelGateway {
  const options = {
    baseUrl: model.baseUrl,
    ...(model.apiKey !== undefined ? { apiKey: model.apiKey } : {}),
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
  };
  if (model.adapter === "ollama") {
    return createOllamaGateway(options);
  }
  return createOpenAICompatibleGateway(options);
}

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

/**
 * Fail-closed check that a Calendar connector instance owns an existing
 * `connector_instances` row of kind `calendar` whose metadata-only selection
 * matches the trusted selection. Never logs or returns provider ids.
 * When `expectedDisplayName` is supplied the stored `display_name` must
 * equal it exactly: a legacy/mismatched row (e.g. a generic `calendar-mcp`
 * row reused by the google-readonly profile, or vice versa) fails closed
 * instead of being rebound.
 */
function verifyCalendarBinding(
  db: KernelDatabaseHandle["raw"],
  binding: Pick<CalendarServerBinding, "connectorInstanceId" | "selection">,
  expectedDisplayName?: string,
): void {
  const row = db
    .prepare(
      "SELECT kind, display_name, config_json FROM connector_instances WHERE id = ?",
    )
    .get(binding.connectorInstanceId) as
    | { kind: string; display_name: string; config_json: string }
    | undefined;
  if (row === undefined || row.kind !== "calendar") {
    throw new ServerConfigError("calendar connector binding not provisioned");
  }
  if (
    expectedDisplayName !== undefined &&
    row.display_name !== expectedDisplayName
  ) {
    throw new ServerConfigError("calendar connector binding invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.config_json);
  } catch {
    throw new ServerConfigError("calendar connector binding invalid");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { version?: unknown }).version !== 1 ||
    typeof (parsed as { calendarId?: unknown }).calendarId !== "string"
  ) {
    throw new ServerConfigError("calendar connector binding invalid");
  }
  const stored = parsed as { calendarId: string; account?: unknown };
  if (stored.calendarId !== binding.selection.calendarId) {
    throw new ServerConfigError("calendar connector selection mismatch");
  }
  if (
    (stored.account ?? undefined) !== (binding.selection.account ?? undefined)
  ) {
    throw new ServerConfigError("calendar connector selection mismatch");
  }
}

interface ListenerHandle {
  address(): unknown;
  close(callback?: (error?: unknown) => void): void;
  on(event: "error", listener: (error: unknown) => void): void;
}

/**
 * C14 fail-closed preflight for a COMPATIBLE configured binding: every exact
 * upstream tool the Calendar adapter calls (`list-events`/`search-events`/
 * `get-event` defaults) must be present in the config hint bindings AND
 * linked to exactly one non-ambiguous host-trusted definition of category
 * `read` whose canonical schema hash equals the config binding hash. This
 * mirrors — and remains strictly narrower than — the connector's own
 * connect-time policy (config/definition hash link + live tools/list schema
 * hash + default-deny): it can only RESPOND to definitions the host already
 * injected; it never authorizes anything by itself. No I/O, no registration,
 * fixed path-free messages only.
 */
function assertCalendarMcpCompatibility(
  calendar: CalendarConfig,
  definitions: readonly McpBindingDefinition[],
): void {
  const names = Object.values(DEFAULT_CALENDAR_ADAPTER_TOOLS);
  for (const name of names) {
    const binding = calendar.connector.bindings.find(
      (entry) => entry.upstreamTool === name,
    );
    if (binding === undefined) {
      throw new ServerConfigError(
        "calendar MCP config misses a required read binding",
      );
    }
    const matching = definitions.filter(
      (definition) => definition.upstreamTool === name,
    );
    if (matching.length !== 1) {
      throw new ServerConfigError(
        "calendar MCP binding has no exact trusted read definition",
      );
    }
    const definition = matching[0] as McpBindingDefinition;
    if (
      definition.category !== "read" ||
      definition.canonicalSchemaHash !== binding.canonicalSchemaHash
    ) {
      throw new ServerConfigError(
        "calendar MCP binding is not linked to a trusted read definition",
      );
    }
  }
}

/** Resolve the outer MCP shutdown bound (tests may shrink/raise within 60s). */
function resolveMcpShutdownMs(value: number | undefined): number {
  if (
    value !== undefined &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= 60000
  ) {
    return value;
  }
  return MCP_SHUTDOWN_BOUND_MS;
}

/**
 * Race the owned connector's already-bounded shutdown against the outer
 * backstop budget. The connector's cleanup continues in the background when
 * the budget loses; the server-shutdown path never hangs on it. Returns true
 * only when the connector shutdown completed inside the budget.
 */
export async function boundedMcpShutdown(
  connector: McpConnector,
  ms: number,
): Promise<boolean> {
  let completed = false;
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    });
    await Promise.race([
      connector.shutdown().then(() => {
        completed = true;
      }),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
  return completed;
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

/**
 * M3 static UI assets (plan §16.1, §16.7). Best-effort load of the esbuild
 * bundle (`scripts/build-ui.mjs` output, `dist/assets/`): missing files
 * only mean the asset routes serve 404, never a startup failure. Never logs
 * paths or file contents — only the loaded count.
 */
export function loadUiAssets(fromDir?: string): {
  clientJs?: string;
  clientCss?: string;
} {
  const dir =
    fromDir ??
    join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "assets");
  const assets: { clientJs?: string; clientCss?: string } = {};
  try {
    assets.clientJs = readFileSync(join(dir, "client.js"), "utf-8");
  } catch {
    // Best effort: the route serves 404 when the bundle was not built.
  }
  try {
    assets.clientCss = readFileSync(join(dir, "client.css"), "utf-8");
  } catch {
    // Best effort: the route serves 404 when the bundle was not built.
  }
  return assets;
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
  // Ownership: this function is the single owner of the sanitized
  // `server.start_failed` log (exactly once per failure, fixed safe fields
  // only). The `index.ts` top-level handler stays silent and only sets the
  // exit code, so CLI and programmatic callers never double-log.
  // Early config load: failures have no valid logLevel, so log exactly once
  // through the injected logger or a safe default. Only the sanitized fixed
  // status is emitted (never paths or raw values). Later startup failures
  // are logged exactly once by the post-config catch below, which this
  // early throw never reaches, so no double logging occurs.
  let config: ServerConfig;
  // C14 profile selector freeze: capture the raw opt-in selector
  // synchronously with the initial frozen startup config, BEFORE the first
  // await below. `options.env` / `process.env` stay mutable, so a later
  // read could observe a different decision; the captured const is the
  // single decision used later.
  let frozenCalendarProfile: string | undefined;
  try {
    config = loadServerConfig(options.env);
    frozenCalendarProfile = (options.env ?? process.env)[CALENDAR_PROFILE_ENV];
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
  const mcpShutdownMs = resolveMcpShutdownMs(options.mcpShutdownMs);

  logger.info("server.starting", { port: config.port });

  let handle: KernelDatabaseHandle | undefined;
  let engine: RunEngine | undefined;
  let startedListener: ListenerHandle | undefined;
  /** C14: the ONE server-owned Calendar MCP connector (undefined = none). */
  let ownedMcp: McpConnector | undefined;
  /** C21: EXPLICITLY owned injected write-port close hook (see gate below). */
  let ownedActionShutdown: (() => Promise<void>) | undefined;
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
  // C21: an adopted owned write-port hook is single-use. It is CONSUMED
  // (cleared) BEFORE invoke, so a sync throw or a rejected promise still
  // counts as used and the listen-failure path (inner catch) plus the
  // outer startup-failure catch can never close it twice. The injected
  // hook itself is never required to be idempotent.
  const takeOwnedActionShutdown = (): (() => Promise<void>) | undefined => {
    const hook = ownedActionShutdown;
    ownedActionShutdown = undefined;
    return hook;
  };
  try {
    // Initial synchronous Calendar composition preflight: frozen selector,
    // config completeness, injected binding/definitions conflicts, and exact
    // profile compatibility — ALL before ensureDbDir/open/migrations or any
    // DB side effect. Still synchronous (before the first await below), so
    // the frozen selector decision cannot be mutated mid-flight. Failures
    // carry fixed path-free ServerConfigError messages and are logged
    // exactly once by the single startup-failure catch below.
    const calendarBinding = options.calendarBinding ?? null;
    // C14 owned composition: the exact opt-in calendar config (with the
    // separate host-trusted definitions) makes the SERVER itself own the
    // MCP connector + adapter lifecycle. Mutually exclusive with the C12
    // injected-adapter seam (fail closed on a conflicting composition).
    let calendarConfig: CalendarConfig | null = null;
    if (calendarBinding === null) {
      calendarConfig = config.calendar;
    } else if (config.calendar !== null) {
      throw new ServerConfigError(
        "calendar config and an injected calendar binding are mutually exclusive",
      );
    }
    // Host-owned pinned readonly profile (normal `pnpm start` selection):
    // COMPANION_CALENDAR_PROFILE=google-readonly supplies the exact
    // reviewed definitions from trusted host code (never env/config). It
    // requires the JSON hint to describe exactly the adopted candidate
    // (identity + stdio + 3 pinned live-wire hashes + profile account
    // grammar); any deviation fails closed. Unset profile keeps the
    // previous behavior: explicit `mcpDefinitions` injection or an
    // INCOMPLETE-opt-in failure. Uses the selector captured synchronously
    // at startup (see above): later mutations of options.env/process.env
    // cannot change the decision.
    const calendarProfile = parseCalendarProfileName(frozenCalendarProfile);
    let effectiveMcpDefinitions: readonly McpBindingDefinition[] | undefined =
      options.mcpDefinitions;
    if (calendarProfile !== null) {
      if (calendarBinding !== null) {
        throw new ServerConfigError(
          "calendar profile and an injected calendar binding are mutually exclusive",
        );
      }
      if (calendarConfig === null) {
        throw new ServerConfigError(
          "calendar profile requires calendar config",
        );
      }
      if (options.mcpDefinitions !== undefined) {
        throw new ServerConfigError(
          "calendar profile and explicit binding definitions are mutually exclusive",
        );
      }
      assertGoogleReadonlyHintCompatible(calendarConfig);
      effectiveMcpDefinitions = getGoogleReadonlyDefinitions();
    }
    if (calendarConfig !== null && effectiveMcpDefinitions === undefined) {
      // An opt-in config without the separate host-trusted definitions is an
      // INCOMPLETE opt-in: fail closed (never a silent disable and never a
      // discovered/model-defined registration) BEFORE any DB side effect.
      throw new ServerConfigError(
        "calendar config requires host trusted binding definitions",
      );
    }
    // Boring profile-specific persisted identity: the profile registers
    // under its own display name so a previously host-injected generic
    // `calendar-mcp` row with the same selection can never be reused.
    const calendarDisplayName =
      calendarProfile !== null
        ? GOOGLE_READONLY_CONNECTOR_DISPLAY_NAME
        : CALENDAR_CONNECTOR_DISPLAY_NAME;
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

    // M1 (plan 14.1/14.5-14.6): after migration and before engine
    // recovery/listen, when roots are configured create one connector
    // owning all roots, ensure one fingerprint-bound instance, then the
    // four M1 registrations and a ToolBroker on the same db/repo. No
    // invocation endpoint here. No roots => toolBroker stays null (M0).
    let toolBroker: ToolBroker | null = null;
    // Calendar composition was fully resolved synchronously BEFORE any DB
    // side effect above (frozen selector, completeness, conflicts, exact
    // profile compatibility); reuse it here without re-reading env.
    // C21: the binding resolution runs BEFORE the repository is constructed,
    // because the M5 triple gate depends on the ACTIVE Calendar instance id
    // while the repository owns the shared proposal stager.
    const referenceManager = createReferenceManager(handle.raw);
    const markdownBindings: MarkdownConnectorBinding[] = [];
    let kernelCalendarBinding: CalendarConnectorBinding | undefined;
    let calendarTargetStore: CalendarTargetStore | undefined;
    if (
      config.markdownRoots.length > 0 ||
      calendarBinding !== null ||
      calendarConfig !== null
    ) {
      if (config.markdownRoots.length > 0) {
        const connector = await createMarkdownConnector(
          config.markdownRoots.map((root) =>
            root.alias === undefined
              ? { path: root.path }
              : { path: root.path, alias: root.alias },
          ),
        );
        const instance = referenceManager.ensureMarkdownConnectorInstance(
          MARKDOWN_CONNECTOR_DISPLAY_NAME,
          config.markdownRoots.length,
          { configFingerprint: connector.identityFingerprint },
        );
        markdownBindings.push({
          connectorInstanceId: instance.id,
          connector,
        });
      }
      if (calendarBinding !== null) {
        // Fail closed: the injected binding must own an existing `calendar`
        // instance whose private selection matches. The adapter itself is
        // already policy-validated; only its stored identity is re-checked.
        // The injected seam keeps its existing contract (any display name):
        // narrowing it would break unprofiled composition callers, and the
        // reuse isolation is enforced on the OWNED path below via the
        // profile-specific display name.
        verifyCalendarBinding(handle.raw, calendarBinding);
        kernelCalendarBinding = {
          connectorInstanceId: calendarBinding.connectorInstanceId,
          connector: calendarBinding.connector,
        };
        // Durable private get-target store: survives restart, never a public
        // DTO. The kernel default in-memory store is NEVER used in production.
        calendarTargetStore = createDurableCalendarTargetStore(handle.raw);
      } else if (
        calendarConfig !== null &&
        effectiveMcpDefinitions !== undefined
      ) {
        // C14 OWNED Calendar MCP lifecycle. Fail-closed preflight first (no
        // DB write for an incompatible, never-authorizable configuration).
        assertCalendarMcpCompatibility(calendarConfig, effectiveMcpDefinitions);
        // Exact persisted registration: ONE metadata-only `calendar` instance
        // (kind/display-name/version/selection checked and reconciled by
        // the kernel; a changed selection or a legacy/mismatched display
        // name fails closed). No provider ids beyond the
        // host-selected calendar id/account labels; no discovered or
        // model-defined registration exists.
        const calendarInstance =
          referenceManager.ensureCalendarConnectorInstance(
            calendarDisplayName,
            calendarConfig.selection.calendarId,
            calendarConfig.selection.account === undefined
              ? {}
              : { account: calendarConfig.selection.account },
          );
        const ownedConnectorConfig = Object.freeze({
          ...calendarConfig.connector,
          // The server fills the exact id IT registered: an env hint can
          // never claim a stored instance id it does not own.
          connectorInstanceId: calendarInstance.id,
        }) as McpConnectorConfig;
        // Constructor does NO I/O: an unavailable upstream can never block
        // startup (lazy connect, per-call fixed `mcp_unavailable`).
        ownedMcp = new McpConnector(
          ownedConnectorConfig,
          effectiveMcpDefinitions,
          options.mcpTransportFactory,
        );
        // Defense-in-depth exact-identity re-check of the stored row AFTER
        // registration (read-only; the adapter is then bound to the same id).
        // The expected display name pins the profile/generic identity so a
        // legacy row with the same selection but the other name fails closed.
        verifyCalendarBinding(
          handle.raw,
          {
            connectorInstanceId: calendarInstance.id,
            selection: calendarConfig.selection,
          },
          calendarDisplayName,
        );
        const calendarAdapter = createCalendarConnector({
          connectorInstanceId: calendarInstance.id,
          connector: ownedMcp,
          selection: calendarConfig.selection,
        });
        kernelCalendarBinding = {
          connectorInstanceId: calendarInstance.id,
          connector: calendarAdapter,
        };
        calendarTargetStore = createDurableCalendarTargetStore(handle.raw);
      }
    }

    // C21 M5 composition: TRIPLE gate. `m5-action` and the proposal-only
    // `calendar.reschedule` registration exist ONLY when ALL of these hold:
    //   1. config.actions.optIn        (strict env opt-in, default false),
    //   2. config.actions.writeEnabled (staging + approval opt-in),
    //   3. a DEDICATED trusted CalendarActionWritePort injected by host code
    //      (never env/config) whose enabled capability binds the EXACT same
    //      active Calendar instance as the read binding.
    // There is deliberately NO production write binding in this codebase: the
    // third condition is unreachable unless a trusted host injects one, and
    // an injected port whose capability does not match the active instance is
    // a fail-closed startup error (never a silently half-enabled surface).
    const actionWrite = options.actionWriteBinding ?? null;
    const actionConfigEnabled =
      config.actions.optIn === true && config.actions.writeEnabled === true;
    // C22 seam: a host that cannot know the owned instance id beforehand
    // derives the trusted port from the identity the server just registered.
    // Exactly one of `port` / `derivePort` is accepted; a binding supplying
    // both or neither stays unusable and fails closed when the config opted
    // in (never a silently half-enabled surface). When the config is
    // disabled the binding is never adopted: no derive call, no capability
    // read, no use, no owned shutdown.
    let actionWritePort: CalendarActionWritePort | null = null;
    if (actionConfigEnabled && actionWrite !== null) {
      const suppliedPort = actionWrite.port !== undefined;
      const deriveFn = actionWrite.derivePort;
      // Exactly ONE of the two: supplying BOTH or NEITHER is an incomplete
      // binding and stays unusable (fail closed below when config opted in).
      if (suppliedPort === (deriveFn !== undefined)) {
        actionWritePort = null;
      } else if (suppliedPort) {
        actionWritePort = actionWrite.port ?? null;
      } else if (
        deriveFn !== undefined &&
        kernelCalendarBinding !== undefined &&
        calendarConfig !== null
      ) {
        actionWritePort = deriveFn({
          connectorInstanceId: kernelCalendarBinding.connectorInstanceId,
          calendarId: calendarConfig.selection.calendarId,
          ...(calendarConfig.selection.account === undefined
            ? {}
            : { account: calendarConfig.selection.account }),
        });
      }
    }
    let actionsEnabled = false;
    if (actionConfigEnabled && actionWritePort === null) {
      // Config opted in without a usable write binding (absent binding, or
      // a binding supplying both/neither of port/derivePort): an incomplete
      // opt-in and fails closed BEFORE listen (never a silent disable).
      throw new ServerConfigError(
        "action write binding does not match the active calendar binding",
      );
    }
    if (actionWritePort !== null) {
      const capability = CalendarActionWriteCapabilitySchema.safeParse(
        actionWritePort.capability,
      );
      const matchesActiveCalendar =
        kernelCalendarBinding !== undefined &&
        calendarTargetStore !== undefined &&
        capability.success &&
        capability.data.connectorInstanceId ===
          kernelCalendarBinding.connectorInstanceId;
      if (actionConfigEnabled) {
        // Config opted in: an unusable/mismatched binding is an incomplete
        // opt-in and fails closed BEFORE listen (never a silent disable).
        if (!matchesActiveCalendar) {
          throw new ServerConfigError(
            "action write binding does not match the active calendar binding",
          );
        }
        actionsEnabled = true;
      }
      // Config disabled: any injected port is simply never used (no staging,
      // no approval, no strategy, no external write).
    }

    // Repository (with its SINGLE shared proposal stager) is constructed here
    // so `writeEnabled` is exactly the triple-gated value above.
    const repo = createKernelRepository(
      handle.raw,
      actionsEnabled ? { actionProposals: { writeEnabled: true } } : {},
    );

    if (
      config.markdownRoots.length > 0 ||
      calendarBinding !== null ||
      calendarConfig !== null ||
      actionsEnabled
    ) {
      const registrations = [
        ...createM1ToolRegistrations({
          db: handle.raw,
          repo,
          referenceManager,
          bindings: markdownBindings,
          ...(kernelCalendarBinding !== undefined
            ? { calendarBinding: kernelCalendarBinding }
            : {}),
          ...(calendarTargetStore !== undefined ? { calendarTargetStore } : {}),
        }),
      ];
      if (actionsEnabled) {
        // Proposal-only: stages a proposal, never executes an external write.
        registrations.push(
          createCalendarRescheduleProposalRegistration({
            stager: repo.actionProposalsStager as ActionProposalStager,
          }),
        );
      }
      toolBroker = createToolBroker({ db: handle.raw, repo, registrations });
      logger.info("server.markdown_ready", {
        status: registrations.length,
      });
      if (kernelCalendarBinding !== undefined) {
        // Counts only: never an upstream URL, calendar id or account label.
        logger.info("server.calendar_ready", { status: 1 });
      }
    }
    if (actionsEnabled) {
      // Counts only: no provider id, capability or connector detail is logged.
      logger.info("server.actions_ready", { status: 1 });
    }

    // C21 lifecycle: ONLY an adopted (actionsEnabled) EXPLICITLY owned
    // injected write port is shut down (after the engine drain, before the
    // DB close). A caller-owned port (default) is never closed by the
    // server, and a disabled composition never adopts the port at all.
    if (
      actionsEnabled &&
      actionWrite?.owned === true &&
      actionWrite.shutdown !== undefined
    ) {
      const shutdownFn = actionWrite.shutdown;
      ownedActionShutdown = async (): Promise<void> => {
        try {
          await shutdownFn();
        } catch {
          // The port's own cleanup is the caller's; never fail shutdown.
        }
      };
    }
    // M2 (opt-in): when config.model is set, build the loopback gateway
    // and register the agent under m0-default before engine.start/listen.
    // The agent reuses the M1 ToolBroker, or a private empty-registration
    // broker when no Markdown roots exist (toolBroker stays null without
    // roots). No model config => empty registry: runs fail closed with a
    // fixed code instead of producing fake LLM output. No direct model
    // endpoint is added; only counts are logged (never URLs/keys).
    const registry = new StrategyRegistry();
    if (config.model !== null) {
      const gateway =
        options.modelGateway !== undefined
          ? options.modelGateway
          : createModelGateway(config.model, options.modelFetch);
      if (gateway !== null) {
        const agentBroker =
          toolBroker ??
          createToolBroker({ db: handle.raw, repo, registrations: [] });
        registry.register(
          AGENT_STRATEGY_NAME,
          createAgentStrategy({
            db: handle.raw,
            repo,
            broker: agentBroker,
            gateway,
            model: config.model.model,
          }),
        );
        logger.info("server.model_ready", {
          status: agentBroker.toolNames().length + 1,
        });
      }
    }
    // C21: the deterministic M5 Action strategy over the SAME database:
    // existing ReferenceManager + ActionExecutionService, the authoritative
    // read port derived from the ACTIVE Calendar read binding + durable
    // private target store, the injected dedicated write port, and the
    // durable private target resolver. No model path, no placeholder port.
    // Registered ONLY when the triple gate opened above, so an approval can
    // never queue a Run with no strategy behind it.
    const activeActionBindings =
      actionsEnabled &&
      actionWritePort !== null &&
      kernelCalendarBinding !== undefined &&
      calendarTargetStore !== undefined
        ? {
            port: actionWritePort,
            binding: kernelCalendarBinding,
            targetStore: calendarTargetStore,
          }
        : null;
    if (activeActionBindings !== null) {
      const { port, targetStore } = activeActionBindings;
      const readPort = createCalendarActionReadPort({
        db: handle.raw,
        binding: activeActionBindings.binding.connector,
        targetStore,
        now,
      });
      const actionService = createActionExecutionService({
        db: handle.raw,
        referenceManager,
        preflightRead: readPort,
        clock: now,
      });
      registry.register(
        ACTION_STRATEGY_NAME,
        createActionStrategy({
          db: handle.raw,
          service: actionService,
          preflightRead: readPort,
          writePort: port,
          resolveTarget: createCalendarActionTargetResolver({
            db: handle.raw,
            targetStore,
          }),
        }),
      );
    }

    engine = new RunEngine({
      db: handle.raw,
      repo,
      registry,
    });
    const recovery = engine.start();
    logger.info("server.recovered", {
      status: recovery.abandoned + recovery.cancelled,
    });

    const { app, controls } = createApp({
      config,
      repo,
      engine,
      logger,
      now,
      assets: loadUiAssets(),
      actionsEnabled,
    });
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
      // Listen failed: drain the started engine, stop the owned Calendar
      // connector, close any created listener, then close the DB (in that
      // order). Handlers were not yet registered, but remove defensively
      // before rethrowing.
      try {
        if (engine !== undefined) {
          await engine.shutdown({ drainMs });
        }
      } catch {
        // Best effort: the listen error carries the startup failure.
      }
      try {
        if (ownedMcp !== undefined) {
          await boundedMcpShutdown(ownedMcp, mcpShutdownMs);
        }
      } catch {
        // Best effort: the listen error carries the startup failure.
      }
      const ownedListenShutdown = takeOwnedActionShutdown();
      try {
        await ownedListenShutdown?.();
      } catch {
        // Best effort.
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
        // C14 bounded owned MCP shutdown: after the engine drain (no more
        // incoming calendar calls), stop the owned connector inside the
        // backstop budget before the DB close. A budget loss never blocks
        // the shutdown path; the connector's own cleanup remains bounded.
        if (ownedMcp !== undefined) {
          let mcpStopped = false;
          try {
            mcpStopped = await boundedMcpShutdown(ownedMcp, mcpShutdownMs);
          } catch {
            // The connector's own cleanup is bounded; proceed with close.
          }
          if (!mcpStopped) {
            logger.warn("server.calendar_mcp_shutdown_timeout", {
              status: safeReason,
            });
          }
        }
        // C21: the adopted hook is consumed before invoke (single-use even
        // across a drain-failure retry: the retry re-enters shutdown only
        // after the memo reset above, and the first pass never reached here).
        await takeOwnedActionShutdown()?.();
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
    if (ownedMcp !== undefined) {
      try {
        await boundedMcpShutdown(ownedMcp, mcpShutdownMs);
      } catch {
        // Best effort: the original startup error carries the failure.
      }
    }
    const ownedStartupShutdown = takeOwnedActionShutdown();
    try {
      await ownedStartupShutdown?.();
    } catch {
      // Best effort: the original startup error carries the failure.
    }
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
