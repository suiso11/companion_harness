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
  createCreateWritePort,
  createRescheduleWritePort,
  DEFAULT_CALENDAR_ADAPTER_TOOLS,
  isSourceEtagBasis,
} from "@companion/connector-calendar";
import { createMarkdownConnector } from "@companion/connector-markdown";
import {
  assertStdioEnvClosed,
  type McpBindingDefinition,
  McpConnector,
  type McpConnectorConfig,
  startupEnvTransportFactory,
  type TransportFactory,
} from "@companion/connector-mcp";
import type { KernelRepository } from "@companion/kernel";
import {
  type ActionCreateReadPort,
  type ActionProposalStager,
  applyAutonomyRestartFence,
  BUNDLED_SCHEMA_VERSION,
  CalendarActionWriteCapabilitySchema,
  type CalendarActionWritePort,
  type CalendarConnectorBinding,
  type CalendarConnectorPort,
  CalendarCreateWriteCapabilitySchema,
  type CalendarCreateWritePort,
  type CalendarTargetStore,
  closeKernelDatabase,
  createActionExecutionService,
  createActionStrategy,
  createAgentStrategy,
  createAutonomyReadRegistrations,
  createCalendarActionReadPort,
  createCalendarActionTargetResolver,
  createCalendarCreateProposalRegistration,
  createCalendarRescheduleProposalRegistration,
  createConversationProposalRegistrations,
  createDurableCalendarTargetStore,
  createKernelRepository,
  createM1ToolRegistrations,
  createMemorySearchRegistration,
  createMemoryStageRegistrations,
  createReferenceManager,
  createToolBroker,
  getSchemaVersion,
  type KernelDatabaseHandle,
  type MarkdownConnectorBinding,
  type MemoryManagePort,
  type MemoryManageStageResult,
  migrateKernelDatabase,
  NewerDatabaseError,
  openKernelDatabase,
  quickCheck,
  RunEngine,
  reconcileShadowRestartInTx,
  StrategyRegistry,
  type ToolBroker,
  ToolError,
  type ToolRegistration,
  toCalendarObservation,
} from "@companion/kernel";
import {
  createOllamaGateway,
  createOpenAICompatibleGateway,
  type FetchImpl,
  type ModelGateway,
} from "@companion/model-local";
import { serve } from "@hono/node-server";
import { createApp, type EnginePort, type ServerControls } from "./app.js";
import { createBackgroundResourceGate } from "./background_resource.js";
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
  type MemoryConfig,
  type ModelConfig,
  type ServerConfig,
  ServerConfigError,
} from "./config.js";
import {
  assertCreateWriteAccountCompatible,
  assertCreateWriteHintCompatible,
  assertCreateWriteReadonlyPathVisible,
  buildCreateWriteConnectorConfig,
  CREATE_WRITE_CONNECTOR_ENV,
  CREATE_WRITE_PROFILE_ENV,
  type CreateWriteConnectorHint,
  getCreateWriteDefinitions,
  parseCreateWriteConnectorHint,
  parseCreateWriteProfileName,
} from "./createWriteProfile.js";
import { createStdServerLogger, type ServerLogger } from "./logger.js";
import {
  measureStoreSize,
  type StatFn,
  shouldWarnStoreSize,
} from "./maintenance.js";
import { createMemoryService, type MemoryService } from "./memory_service.js";
import {
  createNotificationService,
  type NotificationService,
  wrapRepoWithNotifications,
} from "./notification_service.js";
import {
  assertRescheduleWriteAccountCompatible,
  assertRescheduleWriteHintCompatible,
  assertRescheduleWriteReadonlyPathVisible,
  buildRescheduleWriteConnectorConfig,
  getRescheduleWriteDefinitions,
  parseRescheduleWriteConnectorHint,
  parseRescheduleWriteProfileName,
  RESCHEDULE_WRITE_CONNECTOR_ENV,
  RESCHEDULE_WRITE_PROFILE_ENV,
  type RescheduleWriteConnectorHint,
} from "./rescheduleWriteProfile.js";
import { createShadowService, type ShadowService } from "./shadow_service.js";
import { childFailedStatusForError } from "./supervisor.js";

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
   * M5 (tests / trusted harness): injectable DEDICATED write MCP transport
   * factory used ONLY when the host-owned reschedule write profile
   * (`M5_RESCHEDULE_WRITE_PROFILE`) is selected. Production never passes
   * this field (the real default stdio factory spawns the pinned fork CLI).
   * This is the explicit trusted test seam: fixture transports arrive only
   * through this option, never through production endpoint env bypass.
   */
  writeMcpTransportFactory?: TransportFactory;
  /**
   * M5 (tests only): explicit trusted test-seam wire identity override for
   * the dedicated write connector (e.g. the tracked fixture server name/
   * version). Options-injected only, never env. Production never passes
   * this field (the pinned fork identity always applies).
   */
  writeTestIdentity?: {
    readonly expectedServerName: string;
    readonly version: string;
  };
  /**
   * M6 (tests / trusted harness): injectable DEDICATED create MCP transport
   * factory used ONLY when the host-owned create profile
   * (`M6_CALENDAR_CREATE_PROFILE`) is selected. Production never passes
   * this field. Fixture transports arrive only through this option, never
   * through production endpoint env bypass.
   */
  createMcpTransportFactory?: TransportFactory;
  /**
   * M6 (tests only): explicit trusted test-seam wire identity override for
   * the dedicated create connector. Options-injected only, never env.
   * Production never passes this field.
   */
  createTestIdentity?: {
    readonly expectedServerName: string;
    readonly version: string;
  };
  /**
   * C21: the DEDICATED trusted CalendarActionWritePort seam, injected ONLY by
   * trusted host code — NEVER from env/config, which cannot carry a capability,
   * a category or a connector instance id. It becomes live ONLY when
   * `config.actions.optIn` AND `config.actions.writeEnabled` are both true AND
   * its enabled capability names the EXACT active Calendar instance.
   *
   * There is no other production write binding in this codebase beyond the
   * host-owned write profile (`M5_RESCHEDULE_WRITE_PROFILE`, composed by the
   * server itself with no injection); tests and the C22 fake browser harness
   * inject their own deterministic fake ports here (mutually exclusive with
   * the profile).
   */
  actionWriteBinding?: ActionWriteBinding | null;
  /**
   * M6: the DEDICATED trusted CalendarCreateWritePort seam, injected ONLY by
   * trusted host code — NEVER from env/config. It becomes live ONLY when
   * `config.actions.optIn` AND `config.actions.writeEnabled` AND the
   * explicit `config.actions.createEnabled` are all true AND its enabled
   * capability names the EXACT active Calendar instance AND an active
   * Calendar composition exists. Old reschedule-only compositions (no
   * `createEnabled`, no binding here) never autocreate: without this seam
   * no `calendar.create` registration, strategy seam, or external insert
   * exists. Tests and harnesses inject their own deterministic fake ports
   * here; the env-profile transport (`M6_CALENDAR_CREATE_PROFILE`, fork
   * `google-calendar-create` entrypoint) composes separately once the fork
   * CLI + wire pin land.
   */
  actionCreateBinding?: ActionCreateBinding | null;
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
   * Invoked ONLY when a Calendar composition is active (owned config OR
   * injected binding) and exactly once.
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

/**
 * One injected dedicated create binding plus its EXPLICIT lifecycle
 * ownership. Mirrors {@link ActionWriteBinding}: a caller-owned port is
 * never shut down by the server; shutdown happens only when `owned === true`
 * and a `shutdown` function is supplied. Exactly one of `port` /
 * `derivePort` must be supplied; both/neither stays unusable and fails
 * closed when the create gate is open (never a silently half-enabled
 * surface).
 */
export interface ActionCreateBinding {
  /** The exact trusted port (enabled capability, title/start/end only). */
  readonly port?: CalendarCreateWritePort;
  /**
   * Derive the trusted port from the EXACT Calendar instance the server
   * itself just registered (owned-composition hosts that cannot know the
   * stored `connector_instances.id` beforehand). Invoked ONLY when a
   * Calendar composition is active and exactly once. The derived capability
   * MUST name the registered id; the exact-identity check still fails
   * closed on any mismatch.
   */
  readonly derivePort?: (active: {
    readonly connectorInstanceId: string;
    readonly calendarId: string;
    readonly account?: string;
  }) => CalendarCreateWritePort;
  /** Optional close hook; used only together with `owned === true`. */
  readonly shutdown?: () => Promise<void>;
  /**
   * Explicit ownership transfer to the server. Default FALSE: the caller
   * keeps ownership and the server never closes this port.
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
  /** Conversation-memory service when COMPANION_MEMORY_JSON is set, else null. */
  memory: MemoryService | null;
  /** Shadow-deliberation worker when a model gateway resolved, else null. */
  shadow: ShadowService | null;
  /** Notification projector (always on: durable feed + deadline alerts). */
  notifications: NotificationService | null;
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
 * Race an adopted owned write-port close hook against the outer backstop
 * budget (C21). The hook continues in the background when the budget loses;
 * the server-shutdown path never hangs on it. Returns true only when the
 * hook completed inside the budget. An absent hook trivially completes.
 */
export async function boundedActionShutdown(
  hook: (() => Promise<void>) | undefined,
  ms: number,
): Promise<boolean> {
  if (hook === undefined) return true;
  let completed = false;
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    });
    await Promise.race([
      hook().then(() => {
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

/** Fixed shutdown-reason vocabulary: arbitrary caller reasons never enter
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
 * AV07 supervisor IPC (best-effort, fixed codes only). Active ONLY when the
 * server was spawned by the opt-in supervisor, which sets the fixed
 * `COMPANION_SUPERVISED=1` marker in the child's environment (never accepted
 * from any other parent: test workers and embedders that happen to own an
 * IPC channel never receive supervisor traffic). When active, the child
 * reports genuine lifecycle events: `companion-ready` ONLY after listen
 * succeeds, `companion-failed` on startup failure, `companion-drained` /
 * `companion-drain-failed` after a supervisor-requested graceful shutdown.
 * Never carries paths, secrets, or model content.
 */
function isSupervisorManaged(): boolean {
  return process.env.COMPANION_SUPERVISED === "1";
}

function notifySupervisor(message: Record<string, unknown>): void {
  if (!isSupervisorManaged()) {
    return;
  }
  try {
    if (typeof process.send === "function") {
      process.send(message);
    }
  } catch {
    // Best effort: the supervisor treats silence as not-ready/failed.
  }
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
  // single decision used later. The M5 dedicated write selector + connector
  // hints freeze the same way (same rationale, same single decision).
  let frozenCalendarProfile: string | undefined;
  let frozenWriteProfile: string | undefined;
  let frozenWriteConnectorHint: string | undefined;
  let frozenCreateProfile: string | undefined;
  let frozenCreateConnectorHint: string | undefined;
  // M5 write-child env fix: freeze the WHOLE startup environment snapshot
  // synchronously with the selectors above (same rationale — `options.env` /
  // `process.env` stay mutable). The lazy dedicated write child is spawned
  // from THIS snapshot (never a later live read), so an embedding that
  // passes `M5_RESCHEDULE_*` credentials via `startServer({ env })` runs the
  // first approved execution under the same account it configured.
  let frozenStartupEnv: Readonly<Record<string, string | undefined>>;
  try {
    config = loadServerConfig(options.env);
    frozenStartupEnv = Object.freeze({ ...(options.env ?? process.env) });
    frozenCalendarProfile = (options.env ?? process.env)[CALENDAR_PROFILE_ENV];
    frozenWriteProfile = (options.env ?? process.env)[
      RESCHEDULE_WRITE_PROFILE_ENV
    ];
    frozenWriteConnectorHint = (options.env ?? process.env)[
      RESCHEDULE_WRITE_CONNECTOR_ENV
    ];
    frozenCreateProfile = (options.env ?? process.env)[
      CREATE_WRITE_PROFILE_ENV
    ];
    frozenCreateConnectorHint = (options.env ?? process.env)[
      CREATE_WRITE_CONNECTOR_ENV
    ];
  } catch (error) {
    const earlyLogger =
      options.logger ?? createStdServerLogger(DEFAULT_LOG_LEVEL);
    earlyLogger.error("server.start_failed", {
      status: sanitizeStartupErrorStatus(error),
    });
    // AV07: early (pre-config) startup failure still reported when a
    // supervisor channel exists; otherwise the non-zero exit alone marks
    // the crash on the supervisor side.
    notifySupervisor({
      type: "companion-failed",
      status: childFailedStatusForError(error),
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
  /**
   * M5: the ONE server-owned DEDICATED reschedule write MCP connector
   * (undefined = none). Separate transport identity from the readonly
   * connector above; shares the active Calendar instance id in its
   * capability only. Constructed lazily (no I/O); shut down bounded exactly
   * like the owned read connector on every startup/shutdown path, and only
   * when adopted (actions triple gate open with the write profile selected).
   */
  let ownedWriteMcp: McpConnector | undefined;
  /**
   * M6: the ONE server-owned DEDICATED create MCP connector (undefined =
   * none). Separate transport identity (`google-calendar-create` /
   * `1.0.0-create.1`, tool `create-event` only); shares the active Calendar
   * instance id in its capability only. Old reschedule-only compositions
   * never construct it.
   */
  let ownedCreateMcp: McpConnector | undefined;
  /** C21: EXPLICITLY owned injected write-port close hook (see gate below). */
  let ownedActionShutdown: (() => Promise<void>) | undefined;
  let onSigint: (() => void) | undefined;
  let onSigterm: (() => void) | undefined;
  /** Conversation-memory service (null = memoryless; set inside try). */
  let memory: MemoryService | null = null;
  /** Shadow-deliberation worker (null = no gateway; set inside try). */
  let shadow: ShadowService | null = null;
  /** Notification projector (always on; set inside try). */
  let notifications: NotificationService | null = null;
  // Shared background admission (bootstrap-owned, created up front so every
  // teardown path — including the outer startup-failure catch — can shut it
  // down; construction never throws and touches no I/O).
  const backgroundResource = createBackgroundResourceGate();
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
    // M5 host-owned dedicated write profile (normal `pnpm start`
    // selection): `M5_RESCHEDULE_WRITE_PROFILE=google-reschedule` together
    // with `M5_RESCHEDULE_CONNECTOR_JSON` stdio hints composes the SEPARATE
    // write entrypoint hostside. Unset profile keeps the previous behavior
    // unchanged (injected `actionWriteBinding` seam or fail-closed
    // incomplete opt-in). Selected profile requires: no competing injected
    // write binding, an active Calendar composition (owned config or
    // injected binding — the capability names that exact instance), the
    // existing actions opt-in + writeEnabled pair, and strict valid hints.
    // Identity/schema/category authority stays host-pinned (never the
    // hint); TEST-namespace env names are rejected. ALL fail closed here,
    // BEFORE ensureDbDir/open/migrations or any DB side effect. Uses the
    // frozen values captured synchronously at startup (see above).
    const writeProfile = parseRescheduleWriteProfileName(frozenWriteProfile);
    let writeConnectorHint: RescheduleWriteConnectorHint | null = null;
    if (writeProfile !== null) {
      if ((options.actionWriteBinding ?? null) !== null) {
        throw new ServerConfigError(
          "reschedule write profile and an injected write binding are mutually exclusive",
        );
      }
      if (calendarConfig === null && calendarBinding === null) {
        throw new ServerConfigError(
          "reschedule write profile requires calendar config",
        );
      }
      if (
        config.actions.optIn !== true ||
        config.actions.writeEnabled !== true
      ) {
        throw new ServerConfigError(
          "reschedule write profile requires action write opt-in",
        );
      }
      writeConnectorHint = parseRescheduleWriteConnectorHint(
        frozenWriteConnectorHint,
      );
      assertRescheduleWriteHintCompatible(writeConnectorHint);
      // Canonical write-connector validation BEFORE any DB side effect. The
      // build below is pure (no I/O) and owns the EXACT identity rules
      // (non-empty serverName <= 128 / version <= 64 — the same validation
      // the normal composition runs at line ~1043, never a second divergent
      // rule), so an overlong TEST identity fails here regardless of the
      // transport factory. The production env-allowlist gate
      // (`assertStdioEnvClosed`, which rejects before spawn) additionally
      // runs ONLY for the default factory: explicit inert-transport test
      // seams (`writeMcpTransportFactory` injected) need no OS env and
      // production is never weakened for them. Fixed redacted messages only
      // (no env values).
      let preflightWriteConfig: ReturnType<
        typeof buildRescheduleWriteConnectorConfig
      >;
      try {
        preflightWriteConfig = buildRescheduleWriteConnectorConfig({
          connectorInstanceId: "preflight",
          hint: writeConnectorHint,
          ...(options.writeTestIdentity !== undefined
            ? { testIdentity: options.writeTestIdentity }
            : {}),
        });
      } catch (error) {
        if (error instanceof ServerConfigError) {
          throw error;
        }
        throw new ServerConfigError(
          "reschedule write connector hints are invalid",
        );
      }
      // P1: the production default stdio factory deterministically requires
      // every platform SDK implicit env name (`STDIO_IMPLICIT_ENV_VARS`) in
      // the hint allowlist (`assertStdioEnvClosed` rejects before spawn, and
      // the first approved action would otherwise commit a grant then land a
      // deterministic `unknown` with no write dispatched). Reject the unusable
      // production configuration here, BEFORE any DB side effect or write
      // adoption. Explicit inert-transport test seams
      // (`writeMcpTransportFactory` injected) skip this: fixtures need no OS
      // env and production is never weakened for them. Fixed redacted message
      // only (no env values).
      if (options.writeMcpTransportFactory === undefined) {
        try {
          assertStdioEnvClosed(preflightWriteConfig);
        } catch (error) {
          if (error instanceof ServerConfigError) {
            throw error;
          }
          throw new ServerConfigError(
            "reschedule write connector env allowlist is invalid",
          );
        }
      }
      // Fail-closed write-account/selection consistency + custom
      // readonly-path visibility, BEFORE any DB side effect. Pure string
      // checks over the frozen startup snapshot and the active selection
      // (owned config or injected binding): no grant/token file is loaded,
      // no credential value is inspected, and the manual-env-credential
      // fork mode needs no new wiring. A mismatch or an invisible custom
      // readonly path would otherwise surface only as a late per-action
      // refusal (or a missed collision) behind green readiness.
      {
        const writeSelection =
          calendarConfig !== null
            ? calendarConfig.selection
            : calendarBinding?.selection;
        assertRescheduleWriteAccountCompatible(
          frozenStartupEnv.M5_RESCHEDULE_ACCOUNT,
          writeSelection?.account,
        );
        assertRescheduleWriteReadonlyPathVisible(
          writeConnectorHint,
          frozenStartupEnv,
        );
      }
    } else if (frozenWriteConnectorHint !== undefined) {
      // Hints without the profile selector are never silently adopted or
      // ignored: fail closed (no connection, no credential read).
      throw new ServerConfigError(
        "reschedule write connector hints require a write profile",
      );
    }
    // M6 host-owned dedicated create profile (normal `pnpm start`
    // selection): `M6_CALENDAR_CREATE_PROFILE=google-create` together with
    // `M6_CREATE_CONNECTOR_JSON` stdio hints composes the SEPARATE create
    // entrypoint hostside. Unset profile keeps previous behavior unchanged
    // (injected `actionCreateBinding` seam or fail-closed incomplete
    // opt-in). Selected profile requires: no competing injected create
    // binding, an active Calendar composition, and the explicit config
    // triple (optIn + writeEnabled + createEnabled). Old reschedule-only
    // compositions (no createEnabled, no binding) never reach here. ALL
    // fail closed BEFORE any DB side effect.
    const createProfile = parseCreateWriteProfileName(frozenCreateProfile);
    let createConnectorHint: CreateWriteConnectorHint | null = null;
    if (createProfile !== null) {
      if ((options.actionCreateBinding ?? null) !== null) {
        throw new ServerConfigError(
          "create write profile and an injected create binding are mutually exclusive",
        );
      }
      if (calendarConfig === null && calendarBinding === null) {
        throw new ServerConfigError(
          "create write profile requires calendar config",
        );
      }
      if (
        config.actions.optIn !== true ||
        config.actions.writeEnabled !== true ||
        config.actions.createEnabled !== true
      ) {
        throw new ServerConfigError(
          "create write profile requires action create opt-in",
        );
      }
      createConnectorHint = parseCreateWriteConnectorHint(
        frozenCreateConnectorHint,
      );
      assertCreateWriteHintCompatible(createConnectorHint);
      try {
        buildCreateWriteConnectorConfig({
          connectorInstanceId: "preflight",
          hint: createConnectorHint,
          ...(options.createTestIdentity !== undefined
            ? { testIdentity: options.createTestIdentity }
            : {}),
        });
      } catch (error) {
        if (error instanceof ServerConfigError) {
          throw error;
        }
        throw new ServerConfigError("create write connector hints are invalid");
      }
      if (options.createMcpTransportFactory === undefined) {
        try {
          assertStdioEnvClosed(
            buildCreateWriteConnectorConfig({
              connectorInstanceId: "preflight",
              hint: createConnectorHint,
              ...(options.createTestIdentity !== undefined
                ? { testIdentity: options.createTestIdentity }
                : {}),
            }),
          );
        } catch (error) {
          if (error instanceof ServerConfigError) {
            throw error;
          }
          throw new ServerConfigError(
            "create write connector env allowlist is invalid",
          );
        }
      }
      {
        const createSelection =
          calendarConfig !== null
            ? calendarConfig.selection
            : calendarBinding?.selection;
        assertCreateWriteAccountCompatible(
          frozenStartupEnv.M5_RESCHEDULE_ACCOUNT,
          createSelection?.account,
        );
        assertCreateWriteReadonlyPathVisible(
          createConnectorHint,
          frozenStartupEnv,
        );
      }
    } else if (frozenCreateConnectorHint !== undefined) {
      throw new ServerConfigError(
        "create write connector hints require a create profile",
      );
    }
    // M6 injected create-binding static shape preflight: when the explicit
    // config triple (optIn + writeEnabled + createEnabled) is on, a
    // non-null `actionCreateBinding` must supply EXACTLY ONE of a `port` or
    // a function `derivePort` — both/neither (or a non-function derive) is
    // never intent and fails closed here, BEFORE ensureDbDir/open/
    // migrations or any DB side effect (the shape is validatable from the
    // options object alone; no instance id is needed). When the triple is
    // off the binding is ignored entirely (existing disabled-composition
    // policy: no derive call, no capability read, no new opt requirement).
    // A missing binding stays on the existing post-DB incomplete-opt-in
    // path (same as reschedule); a derive that resolves to null is
    // rejected post-DB before listen (same contract).
    {
      const injectedCreateBinding = options.actionCreateBinding ?? null;
      if (
        config.actions.optIn === true &&
        config.actions.writeEnabled === true &&
        config.actions.createEnabled === true &&
        injectedCreateBinding !== null
      ) {
        const hasPort = injectedCreateBinding.port !== undefined;
        const hasDerive =
          typeof injectedCreateBinding.derivePort === "function";
        if (hasPort === hasDerive) {
          throw new ServerConfigError(
            "action create binding does not match the active calendar binding",
          );
        }
      }
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

    // AV autonomy restart fence: runs on every start AFTER migration. When
    // the control was left UNPAUSED it flips back to PAUSED with a version
    // advance and appends `restart_fence` + `interrupted_note` activity rows
    // recording that background intent does NOT resume implicitly; an
    // already-paused control stays untouched. Migration 0012 (the latest
    // committed migration) REQUIRES the autonomy + shadow tables: a missing
    // slice fails closed here (no legacy best-effort suppression — a
    // partially-migrated database must never start unsafe). Shadow restart
    // reconciliation then holds every pending/claimed job
    // (`restart_interrupted`, terminal for those jobs): a restart never
    // resumes or replays old work, and the paused control admits no new
    // claims until meaningful new state arrives.
    applyAutonomyRestartFence(handle.raw, now());
    reconcileShadowRestartInTx(handle.raw, now());

    // Gate admission starts from the ACTUAL persisted control state AFTER
    // the fence above (never optimistically open): a fence-paused control
    // (or an already-paused one) closes admission BEFORE any service starts,
    // so a fresh restart's first ordinary chat cannot launch background
    // extraction until an explicit current-version resume reopens it.
    // Ordinary foreground chat and explicit memory management stay
    // available while paused; they never consult this gate.
    try {
      const persisted = handle.raw
        .prepare("SELECT paused FROM autonomy_control WHERE id = 'global'")
        .get() as { paused: number } | undefined;
      if (persisted === undefined || persisted.paused === 1) {
        backgroundResource.close();
      }
    } catch {
      backgroundResource.close();
    }

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

    const baseRepo = createKernelRepository(handle.raw);
    // M2 gateway resolution first (opt-in): the memory service reuses the
    // SAME loopback gateway for structured extraction (no new service, no
    // provisioning). Null here means extraction conservatively yields no
    // memory; recall/outbox still function.
    let modelGateway: ModelGateway | null = null;
    let modelName = "memory-extraction";
    if (config.model !== null) {
      const built =
        options.modelGateway !== undefined
          ? options.modelGateway
          : createModelGateway(config.model, options.modelFetch);
      if (built !== null) {
        modelGateway = built;
        modelName = config.model.model;
      }
    }
    // Conversation memory (strict opt-in, default memoryless): when
    // COMPANION_MEMORY_JSON is set, create the service BEFORE the engine
    // and agent so every consumer shares one wrapped repo. The wrapper is
    // the intake hook: fresh intakes and cancels preempt idle cultivation,
    // and durably completed runs trigger authoritative cultivation. Without
    // memory config the raw repo is shared unchanged (old behavior).
    let repo: KernelRepository = baseRepo;
    // (Service instance assigned to the outer `memory` binding so every
    // post-start failure path can stop/await it before the DB close.)
    // Intake-hook wrapper (shared by the pre-gate memory setup below and
    // the post-gate repository rebuild, so the memory hooks always wrap the
    // final gated repo and never a stale pre-gate instance).
    const wrapRepoWithMemoryIntake = (
      inner: KernelRepository,
      service: MemoryService,
    ): KernelRepository => ({
      ...inner,
      postMessage: (...args) => {
        const out = inner.postMessage(...args);
        service.notifyForeground();
        return out;
      },
      postRetry: (...args) => {
        const out = inner.postRetry(...args);
        service.notifyForeground();
        return out;
      },
      completeRun: (...args) => {
        const out = inner.completeRun(...args);
        if (out.applied) {
          service.onRunCompleted(args[0]);
        }
        return out;
      },
      cancelRun: (...args) => {
        const out = inner.cancelRun(...args);
        service.notifyForeground();
        return out;
      },
    });
    /**
     * Shadow priority wrapper (server-owned): accepted foreground work
     * (userMessage/retry/cancel) aborts the shadow's OWN call
     * synchronously; actual run settlement (any terminal outcome) re-wakes
     * eligible pending shadow jobs. Every hook is throw-guarded: a shadow
     * wake/abort can never unwind a committed user command. Composes OUTSIDE
     * the memory wrapper so both observe every call.
     */
    const wrapRepoWithShadowPriority = (
      inner: KernelRepository,
      service: ShadowService,
    ): KernelRepository => ({
      ...inner,
      postMessage: (...args) => {
        const out = inner.postMessage(...args);
        try {
          service.notifyForeground();
        } catch {
          // Best effort: the message already committed.
        }
        return out;
      },
      postRetry: (...args) => {
        const out = inner.postRetry(...args);
        try {
          service.notifyForeground();
        } catch {
          // Best effort: the retry already committed.
        }
        return out;
      },
      cancelRun: (...args) => {
        const out = inner.cancelRun(...args);
        try {
          service.notifyForeground();
        } catch {
          // Best effort: the cancel already committed.
        }
        return out;
      },
      completeRun: (...args) => {
        const out = inner.completeRun(...args);
        try {
          service.onRunSettled();
        } catch {
          // Best effort: the completion already committed.
        }
        return out;
      },
      failRun: (...args) => {
        const out = inner.failRun(...args);
        try {
          service.onRunSettled();
        } catch {
          // Best effort: the failure already committed.
        }
        return out;
      },
      finalizeCancelRequested: (...args) => {
        const out = inner.finalizeCancelRequested(...args);
        try {
          service.onRunSettled();
        } catch {
          // Best effort: the settlement already committed.
        }
        return out;
      },
    });
    // Shared background admission (bootstrap-owned, repo-independent so the
    // gated repository rebuild below can never drop it): at most ONE
    // model-heavy background unit — memory extraction, shadow deliberation,
    // idle distill — runs at a time. Foreground work and notifications never
    // acquire it. Created once above with the other service bindings.
    if (config.memory !== null) {
      const memoryConfig: MemoryConfig = config.memory;
      memory = createMemoryService({
        address: {
          executable: memoryConfig.executable,
          entry: memoryConfig.entry,
          config: memoryConfig.config,
          timeoutMs: memoryConfig.timeoutMs,
          maxResponseBytes: memoryConfig.maxResponseBytes,
        },
        scope: memoryConfig.scope,
        recallLimit: memoryConfig.recallLimit,
        idleMs: memoryConfig.idleMs,
        repo: baseRepo,
        gateway: modelGateway,
        model: modelName,
        logger,
        // Shared background admission (bootstrap-owned): post-completion
        // extraction and idle-distill drains admit ONE unit at a time
        // against the shadow worker below. Foreground memory paths
        // (recall/search/stage) never consult it.
        background: backgroundResource,
      });
      repo = wrapRepoWithMemoryIntake(baseRepo, memory);
      logger.info("server.memory_ready", { status: 1 });
    }
    // AV05 notification projector (always on, no config gate): durable
    // background projection AFTER committed sources — never inside the M5
    // receipt writer, so a projection failure can never lose a Calendar
    // receipt. The wrapper composes here (outside memory intake) so the
    // shadow worker's creation-time repo already wakes on settlement; the
    // gated rebuild below re-applies it on the final repo the engine and
    // app share (same rule as the memory intake + shadow priority
    // wrappers — none of them is dropped by the recovery rebuild).
    notifications = createNotificationService({
      db: handle.raw,
      repo,
      logger,
      now,
    });
    {
      const activeNotifications = notifications;
      repo = wrapRepoWithNotifications(repo, activeNotifications);
      logger.info("server.notifications_ready", { status: 1 });
    }
    // AV shadow worker (model-gated): uses the EXACT SAME configured
    // gateway/modelName as the ordinary agent above (no model selection,
    // download, provider, or fake response) plus the SAME bounded memory
    // recall scope when memory is configured (recall only: no feedback,
    // heat, or mutation from shadow). Null gateway (or null model config)
    // means NO worker: pending jobs honestly wait (claim fences paused
    // work; completions fail closed) instead of producing fake output.
    if (modelGateway !== null) {
      shadow = createShadowService({
        repo,
        gateway: modelGateway,
        model: modelName,
        recall: memory !== null ? memory.recallHook : null,
        logger,
        now,
        // Same shared gate: each shadow job admits BEFORE claim and defers
        // untouched while another background unit holds it.
        background: backgroundResource,
      });
      // Priority composition OUTSIDE the memory intake wrapper: accepted
      // foreground work aborts shadow's OWN call; run settlement re-wakes.
      repo = wrapRepoWithShadowPriority(repo, shadow);
      logger.info("server.shadow_ready", { status: 1 });
    }
    // M1 (plan 14.1/14.5-14.6): after migration and before engine
    // recovery/listen, when roots are configured create one connector
    // owning all roots, ensure one fingerprint-bound instance, then the
    // four M1 registrations and a ToolBroker on the same db/repo. No
    // invocation endpoint here. No roots => toolBroker stays null (M0).
    let toolBroker: ToolBroker | null = null;
    // Agent base registrations captured from the composition above (empty
    // without roots/memory). The agent broker always appends the four
    // strictly-readonly autonomy tools below.
    const agentBaseRegistrations: ToolRegistration[] = [];
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
      // M5 host-owned dedicated write MCP lifecycle (normal startup). Built
      // ONLY when the write profile is selected (validated pre-DB above):
      // a SEPARATE stdio transport to the pinned dedicated entrypoint under
      // the exact `["write"]` category gate with the host-pinned `write`
      // definition, bound to the SAME active Calendar instance id as the
      // read binding above. Constructor does NO I/O (lazy connect, per-call
      // fixed errors, no resend); the readonly connector/profile above is
      // never widened, rebound, or replaced.
      if (writeProfile !== null && writeConnectorHint !== null) {
        if (
          kernelCalendarBinding === undefined ||
          calendarTargetStore === undefined
        ) {
          throw new ServerConfigError(
            "action write binding does not match the active calendar binding",
          );
        }
        ownedWriteMcp = new McpConnector(
          buildRescheduleWriteConnectorConfig({
            connectorInstanceId: kernelCalendarBinding.connectorInstanceId,
            hint: writeConnectorHint,
            ...(options.writeTestIdentity !== undefined
              ? { testIdentity: options.writeTestIdentity }
              : {}),
          }),
          getRescheduleWriteDefinitions(),
          // Default write transport reads child env from the FROZEN startup
          // snapshot captured above — never the live `process.env` — so the
          // write child always inherits the same environment the profile and
          // hints were selected from. An explicitly injected
          // `writeMcpTransportFactory` (trusted test seam) still wins.
          options.writeMcpTransportFactory ??
            startupEnvTransportFactory(frozenStartupEnv),
          { permittedCategories: ["write"] },
        );
      }
      // M6 host-owned dedicated create MCP lifecycle (normal startup). Built
      // ONLY when the create profile is selected (validated pre-DB above):
      // a SEPARATE stdio transport to the pinned dedicated create
      // entrypoint under the exact `["write"]` category gate with the
      // host-pinned `write` definition, bound to the SAME active Calendar
      // instance id as the read binding above. Never widens/rebinds the
      // readonly or reschedule connectors.
      if (createProfile !== null && createConnectorHint !== null) {
        if (
          kernelCalendarBinding === undefined ||
          calendarTargetStore === undefined
        ) {
          throw new ServerConfigError(
            "action create binding does not match the active calendar binding",
          );
        }
        ownedCreateMcp = new McpConnector(
          buildCreateWriteConnectorConfig({
            connectorInstanceId: kernelCalendarBinding.connectorInstanceId,
            hint: createConnectorHint,
            ...(options.createTestIdentity !== undefined
              ? { testIdentity: options.createTestIdentity }
              : {}),
          }),
          getCreateWriteDefinitions(),
          options.createMcpTransportFactory ??
            startupEnvTransportFactory(frozenStartupEnv),
          { permittedCategories: ["write"] },
        );
      }
    }

    // C21 M5 composition: TRIPLE gate. `m5-action` and the proposal-only
    // `calendar.reschedule` registration exist ONLY when ALL of these hold:
    //   1. config.actions.optIn        (strict env opt-in, default false),
    //   2. config.actions.writeEnabled (staging + approval opt-in),
    //   3. a DEDICATED trusted CalendarActionWritePort — either injected by
    //      host code (never env/config) whose enabled capability binds the
    //      EXACT same active Calendar instance as the read binding, or the
    //      host-owned write profile (`M5_RESCHEDULE_WRITE_PROFILE`, composed
    //      below from the pinned provider + the repository-immutable
    //      committed-grant resolver, capability on the same active
    //      instance).
    // There is deliberately NO caller-supplied production write binding in
    // this codebase beyond these two seams: an injected port whose
    // capability does not match the active instance is a fail-closed startup
    // error (never a silently half-enabled surface).
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
        (calendarConfig !== null || calendarBinding !== null)
      ) {
        // Owned AND injected compositions both expose the active selection:
        // the owned config selection or the injected binding selection. The
        // derived capability MUST name the server-registered instance id
        // (`kernelCalendarBinding`, verified above for injected bindings and
        // registered here for owned ones); the exact-identity check below
        // still fails closed on any mismatch.
        const selection =
          calendarConfig !== null
            ? calendarConfig.selection
            : calendarBinding?.selection;
        if (selection !== undefined) {
          actionWritePort = deriveFn({
            connectorInstanceId: kernelCalendarBinding.connectorInstanceId,
            calendarId: selection.calendarId,
            ...(selection.account === undefined
              ? {}
              : { account: selection.account }),
          });
        }
      }
    }
    let actionsEnabled = false;
    // M6 create-only normal start: a genuinely configured create path (the
    // selected host-owned create profile, validated above, or an injected
    // create binding together with the explicit config triple) satisfies
    // the write opt-in WITHOUT a separate reschedule binding. A bare
    // createEnabled flag with no usable binding is not intent and keeps the
    // old fail-closed behavior below; reschedule-only compositions without
    // any create intent are unchanged.
    const createIntent =
      createProfile !== null ||
      (config.actions.optIn === true &&
        config.actions.writeEnabled === true &&
        config.actions.createEnabled === true &&
        (options.actionCreateBinding ?? null) !== null);
    if (
      actionConfigEnabled &&
      actionWritePort === null &&
      writeProfile === null &&
      !createIntent
    ) {
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

    // M6 create gate (explicit `createEnabled` AND the reschedule pair AND
    // a trusted create binding on the active Calendar instance — never
    // implied by the old flags). Disabled compositions never adopt the
    // binding below: no derive call, no capability read, no use.
    const actionCreate = options.actionCreateBinding ?? null;
    const createConfigAllowed =
      config.actions.optIn === true &&
      config.actions.writeEnabled === true &&
      config.actions.createEnabled === true;
    let actionCreatePort: CalendarCreateWritePort | null = null;
    if (createConfigAllowed && actionCreate !== null) {
      const suppliedCreatePort = actionCreate.port !== undefined;
      const deriveCreateFn =
        typeof actionCreate.derivePort === "function"
          ? actionCreate.derivePort
          : undefined;
      // Exactly ONE of the two: supplying BOTH or NEITHER stays unusable
      // (NEITHER/BOTH already fail closed in the pre-DB preflight above;
      // this keeps the post-DB gate total under the same rule).
      if (suppliedCreatePort === (deriveCreateFn !== undefined)) {
        actionCreatePort = null;
      } else if (suppliedCreatePort) {
        actionCreatePort = actionCreate.port ?? null;
      } else if (
        deriveCreateFn !== undefined &&
        kernelCalendarBinding !== undefined &&
        (calendarConfig !== null || calendarBinding !== null)
      ) {
        const selection =
          calendarConfig !== null
            ? calendarConfig.selection
            : calendarBinding?.selection;
        if (selection !== undefined) {
          actionCreatePort = deriveCreateFn({
            connectorInstanceId: kernelCalendarBinding.connectorInstanceId,
            calendarId: selection.calendarId,
            ...(selection.account === undefined
              ? {}
              : { account: selection.account }),
          });
        }
      }
    }
    let createEnabled = false;
    if (actionCreatePort !== null) {
      const createCapability = CalendarCreateWriteCapabilitySchema.safeParse(
        actionCreatePort.capability,
      );
      const createMatchesActiveCalendar =
        kernelCalendarBinding !== undefined &&
        calendarTargetStore !== undefined &&
        createCapability.success &&
        createCapability.data.connectorInstanceId ===
          kernelCalendarBinding.connectorInstanceId;
      if (createConfigAllowed) {
        // Create opted in: an unusable/mismatched binding is an incomplete
        // opt-in and fails closed BEFORE listen (never a silent disable,
        // never a fallback to the reschedule binding).
        if (!createMatchesActiveCalendar) {
          throw new ServerConfigError(
            "action create binding does not match the active calendar binding",
          );
        }
        createEnabled = true;
      }
      // Create disabled: any injected create port is simply never used (no
      // staging, no approval, no strategy, no external insert).
    }
    if (
      createConfigAllowed &&
      actionCreate !== null &&
      actionCreatePort === null
    ) {
      // Create opted in with an injected binding that resolved to no usable
      // port (a `derivePort` that returned null, or an explicit null port):
      // an incomplete opt-in — fail closed BEFORE listen, never a silently
      // disabled create surface. A non-null port with a null/invalid
      // capability already fails closed above.
      throw new ServerConfigError(
        "action create binding does not match the active calendar binding",
      );
    }

    // M6 host-owned dedicated create port (normal startup, no injection).
    // Composes the DEDICATED create port from the owned create connector
    // above (single `create-event` call per consumed grant, no retry). The
    // readonly and reschedule connectors are never widened or rebound.
    if (createProfile !== null) {
      const createConnector = ownedCreateMcp;
      if (
        createConnector === undefined ||
        kernelCalendarBinding === undefined ||
        calendarTargetStore === undefined
      ) {
        throw new ServerConfigError(
          "action create binding does not match the active calendar binding",
        );
      }
      if (!createConfigAllowed) {
        throw new ServerConfigError(
          "create write profile requires action create opt-in",
        );
      }
      const activeInstanceId = kernelCalendarBinding.connectorInstanceId;
      const hostCreatePort = createCreateWritePort({
        connectorInstanceId: activeInstanceId,
        caller: {
          callTool: (
            upstreamTool: string,
            args: unknown,
            signal?: AbortSignal,
          ) => createConnector.callTool(upstreamTool, args, signal),
        },
        upstreamTool: "create-event",
      });
      const hostCreateCapability =
        CalendarCreateWriteCapabilitySchema.safeParse(
          hostCreatePort.capability,
        );
      if (
        !hostCreateCapability.success ||
        hostCreateCapability.data.connectorInstanceId !== activeInstanceId
      ) {
        throw new ServerConfigError(
          "action create binding does not match the active calendar binding",
        );
      }
      actionCreatePort = hostCreatePort as unknown as CalendarCreateWritePort;
      createEnabled = true;
    }

    // Repository (with its SINGLE shared proposal stager) is constructed here
    // so `writeEnabled` is exactly the triple-gated value above and
    // `createEnabled` is exactly the M6 create-gated value above. When memory
    // is configured the intake hooks re-wrap THIS gated repo (the pre-gate
    // baseRepo wrapper above is superseded here, never shared onward). A
    // selected host-owned write profile implies the config pair already
    // (enforced in the pre-DB preflight), so the stager is enabled for it
    // here; the dedicated port itself is composed immutably from this
    // repository below.
    const gatedRepo = createKernelRepository(
      handle.raw,
      actionsEnabled || writeProfile !== null || createEnabled
        ? {
            actionProposals: {
              ...(actionsEnabled || writeProfile !== null
                ? { writeEnabled: true }
                : {}),
              ...(createEnabled
                ? { writeEnabled: true, createEnabled: true }
                : {}),
            },
          }
        : {},
    );
    if (memory !== null) {
      repo = wrapRepoWithMemoryIntake(gatedRepo, memory);
    } else {
      repo = gatedRepo;
    }
    // AV shadow priority composition (server-owned): the gated rebuild above
    // supersedes the pre-gate repo object, so re-apply the foreground-abort
    // + settlement-wake wrapper HERE, outside the memory intake wrapper, on
    // the repo the app/engine actually share. Without this, accepted
    // foreground work never aborts the shadow's OWN call and run settlement
    // never re-wakes eligible pending jobs (the worker only wakes on explicit
    // requests). The shadow service itself keeps operating on the same
    // database through its creation-time repo reference.
    if (shadow !== null) {
      const activeShadow = shadow;
      repo = wrapRepoWithShadowPriority(repo, activeShadow);
    }
    // AV05 recovery-rebuild rule (PR42 pattern preserved): the gated repo
    // above supersedes the pre-gate object, so re-apply the notification
    // wake wrapper OUTSIDE the memory/shadow wrappers on the repo the app
    // and engine actually share. Without this, HTTP-committed mutations
    // and engine run settlement never re-drive the projector.
    if (notifications !== null) {
      const activeNotifications = notifications;
      repo = wrapRepoWithNotifications(repo, activeNotifications);
    }

    // M5 host-owned dedicated port (normal startup, no injection). The
    // conditional etag resolves concretely from the REPOSITORY-immutable
    // committed grant (execution/proposal/hash -> `expected_revision` read
    // back here, never the latest resource and never a host-prepared map):
    // the stored triple must equal the grant triple exactly and the stored
    // revision must carry a real source-etag basis, otherwise null — a safe
    // definite rejection with NO dispatch. Single owned write MCP lifecycle
    // (lazy, no resend, `["write"]` only); the readonly connector/profile
    // above is never widened or rebound.
    if (writeProfile !== null) {
      const writeConnector = ownedWriteMcp;
      if (
        writeConnector === undefined ||
        kernelCalendarBinding === undefined ||
        calendarTargetStore === undefined
      ) {
        throw new ServerConfigError(
          "action write binding does not match the active calendar binding",
        );
      }
      const activeInstanceId = kernelCalendarBinding.connectorInstanceId;
      const resolveExpectedEtag = (grant: {
        readonly executionId: string;
        readonly proposalId: string;
        readonly proposalHash: string;
        readonly expectedRevision: string;
      }): string | null => {
        let stored: {
          proposalHash: string;
          expectedRevision: string;
        } | null;
        try {
          stored = repo.readCommittedGrantRevision(
            grant.executionId,
            grant.proposalId,
          );
        } catch {
          return null;
        }
        if (stored === null) {
          return null;
        }
        if (stored.proposalHash !== grant.proposalHash) {
          return null;
        }
        if (stored.expectedRevision !== grant.expectedRevision) {
          return null;
        }
        if (!isSourceEtagBasis(stored.expectedRevision)) {
          return null;
        }
        return stored.expectedRevision;
      };
      const hostPort = createRescheduleWritePort({
        connectorInstanceId: activeInstanceId,
        caller: {
          callTool: (
            upstreamTool: string,
            args: unknown,
            signal?: AbortSignal,
          ) => writeConnector.callTool(upstreamTool, args, signal),
        },
        upstreamTool: "reschedule-event",
        resolveExpectedEtag,
      });
      const hostCapability = CalendarActionWriteCapabilitySchema.safeParse(
        hostPort.capability,
      );
      if (
        !hostCapability.success ||
        hostCapability.data.connectorInstanceId !== activeInstanceId
      ) {
        throw new ServerConfigError(
          "action write binding does not match the active calendar binding",
        );
      }
      actionWritePort = hostPort as unknown as CalendarActionWritePort;
      actionsEnabled = true;
    }

    const needsMarkdownTools =
      config.markdownRoots.length > 0 ||
      calendarBinding !== null ||
      calendarConfig !== null ||
      actionsEnabled ||
      createEnabled;
    if (needsMarkdownTools || memory !== null) {
      // Agent-visible base: the M1/M6/memory registrations below are ALSO
      // the agent's base toolset. Captured here so the agent broker (built
      // later) reuses the exact same registrations plus the always-on
      // readonly autonomy tools, while `toolBroker` keeps its exact
      // existing composition.
      const registrations = needsMarkdownTools
        ? [
            ...createM1ToolRegistrations({
              db: handle.raw,
              repo,
              referenceManager,
              bindings: markdownBindings,
              ...(kernelCalendarBinding !== undefined
                ? { calendarBinding: kernelCalendarBinding }
                : {}),
              ...(calendarTargetStore !== undefined
                ? { calendarTargetStore }
                : {}),
            }),
          ]
        : [];
      if (actionsEnabled) {
        // Proposal-only: stages a proposal, never executes an external write.
        registrations.push(
          createCalendarRescheduleProposalRegistration({
            stager: repo.actionProposalsStager as ActionProposalStager,
          }),
        );
      }
      if (createEnabled) {
        // M6 proposal-only `calendar.create`: stages a targetless creation
        // on the host-owned active Calendar instance (never model input),
        // never executes an external insert. Requires the explicit
        // `createEnabled` gate above; reschedule-only hosts never reach here.
        const createSelection =
          calendarConfig !== null
            ? calendarConfig.selection
            : calendarBinding?.selection;
        if (
          kernelCalendarBinding !== undefined &&
          createSelection !== undefined
        ) {
          registrations.push(
            createCalendarCreateProposalRegistration({
              stager: repo.actionProposalsStager as ActionProposalStager,
              connectorInstanceId: kernelCalendarBinding.connectorInstanceId,
            }),
          );
        }
      }
      if (memory !== null) {
        // Explicit memory management tools (staging-only, no external-write
        // widening): the shared broker keeps the existing budgets; the
        // server-owned port stages mutations ONLY as durable outbox +
        // operation rows (the broker handler never performs a CLI mutation).
        const activeMemory = memory;
        const port: MemoryManagePort = {
          search: (input, options) =>
            activeMemory.searchMemories({
              sessionId: input.sessionId,
              runId: input.runId,
              query: input.query,
              limit: input.limit,
              ...(options?.signal !== undefined
                ? { signal: options.signal }
                : {}),
            }),
          stage: async (input, options): Promise<MemoryManageStageResult> => {
            let out: Awaited<
              ReturnType<typeof activeMemory.stageMemoryMutation>
            >;
            try {
              out = await activeMemory.stageMemoryMutation({
                sessionId: input.sessionId,
                runId: input.runId,
                kind: input.kind,
                searchId: input.searchId,
                ...(input.handle !== undefined ? { handle: input.handle } : {}),
                ...(input.correctionBody !== undefined
                  ? { correctionBody: input.correctionBody }
                  : {}),
                idempotencyKey: input.idempotencyKey,
                // Server-known model origin: the kernel handler hardcodes
                // false and model args carry no such field, so this can
                // never be smuggled to true from the model side.
                trustedSelection: false,
                ...(options?.signal !== undefined
                  ? { signal: options.signal }
                  : {}),
              });
            } catch (error) {
              if (
                typeof error === "object" &&
                error !== null &&
                (error as { name?: unknown }).name === "MemoryManageCancelled"
              ) {
                throw new ToolError("execution_cancelled");
              }
              throw error;
            }
            if (out.ok) {
              return {
                status: "staged",
                operationId: out.operationId,
                operationStatus: out.status,
              };
            }
            if (
              out.code === "needs_clarification" ||
              out.code === "target_not_found" ||
              out.code === "state_conflict"
            ) {
              return {
                status: out.code,
                candidates: [...(out.candidates ?? [])],
              };
            }
            if (out.code === "validation_error") {
              throw new ToolError("execution_failed");
            }
            if (out.code === "service_unavailable") {
              throw new ToolError("execution_failed");
            }
            throw new ToolError("execution_failed");
          },
        };
        registrations.push(createMemorySearchRegistration({ repo, port }));
        registrations.push(...createMemoryStageRegistrations({ repo, port }));
      }
      toolBroker = createToolBroker({ db: handle.raw, repo, registrations });
      agentBaseRegistrations.push(...registrations);
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
    // M6 lifecycle: ONLY an adopted (createEnabled) EXPLICITLY owned
    // injected create port is shut down, same single-use semantics as the
    // write hook above. Caller-owned (default) or disabled compositions
    // are never closed by the server.
    if (
      createEnabled &&
      actionCreate?.owned === true &&
      actionCreate.shutdown !== undefined
    ) {
      const shutdownFn = actionCreate.shutdown;
      const prevHook = ownedActionShutdown;
      ownedActionShutdown = async (): Promise<void> => {
        try {
          if (prevHook !== undefined) {
            await prevHook();
          }
        } catch {
          // Best effort; continue with the create hook below.
        }
        try {
          await shutdownFn();
        } catch {
          // The port's own cleanup is the caller's; never fail shutdown.
        }
      };
    }
    // M2 (opt-in): when a gateway resolved above, register the agent under
    // m0-default before engine.start/listen. The agent reuses the M1
    // ToolBroker composition (or a private broker when no Markdown roots
    // exist and toolBroker stays null) PLUS the four strictly-readonly
    // autonomy tools (`purpose.list` / `purpose.open` / `task.list` /
    // `task.open`), registered regardless of Markdown roots or memory
    // configuration: without roots the agent broker contains exactly
    // those four. With memory configured the agent additionally gets the
    // bounded pre-answer recall hook (fail-open memoryless otherwise).
    // No model gateway => empty registry: runs fail closed with a fixed
    // code instead of producing fake LLM output. No direct model endpoint
    // is added; only counts are logged (never URLs/keys).
    const registry = new StrategyRegistry();
    if (modelGateway !== null) {
      // AV autonomy read tools: SELECT-only over the runtime session's
      // owned records (session derived from the calling run, never model
      // input). Same existing broker budgets, no widening, no mutations.
      // AV03 proposal tools: proposal-only staging of inferred drafts
      // (purpose.propose / task.propose); the model stages but never
      // creates, and approval lives outside it. Same budgets, no new step.
      const agentBroker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [
          ...agentBaseRegistrations,
          ...createAutonomyReadRegistrations({ repo }),
          ...createConversationProposalRegistrations({ repo }),
        ],
      });
      registry.register(
        AGENT_STRATEGY_NAME,
        createAgentStrategy({
          db: handle.raw,
          repo,
          broker: agentBroker,
          gateway: modelGateway,
          model: modelName,
          ...(memory !== null ? { memory: memory.recallHook } : {}),
        }),
      );
      logger.info("server.model_ready", {
        status: agentBroker.toolNames().length + 1,
      });
    }
    // C21: the deterministic M5 Action strategy over the SAME database:
    // existing ReferenceManager + ActionExecutionService, the authoritative
    // read port derived from the ACTIVE Calendar read binding + durable
    // private target store, the injected dedicated write port, and the
    // durable private target resolver. No model path, no placeholder port.
    // Registered when the reschedule triple gate opened above OR when the
    // M6 create gate opened (create-only normal start has no reschedule
    // binding: reschedule runs then fail closed through the real
    // preflight-failure terminal while create runs take the dedicated
    // flow), so an approval can never queue a Run with no strategy behind
    // it.
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
    // M6 create seams: live ONLY when the explicit create gate opened
    // above (config triple + trusted create binding on the active
    // instance). The authoritative create read-back is a GET by the
    // stable insert id through the ACTIVE read binding (never a POST
    // fallback, never a resend); the selection is the host-owned active
    // calendar/account (never model input). Reschedule-only compositions
    // pass no create seams and create runs fail closed.
    const activeCreateSelection =
      calendarConfig !== null
        ? calendarConfig.selection
        : calendarBinding?.selection;
    const activeCreateBindings =
      createEnabled &&
      actionCreatePort !== null &&
      activeCreateSelection !== undefined &&
      kernelCalendarBinding !== undefined &&
      calendarTargetStore !== undefined
        ? {
            createPort: actionCreatePort,
            selection: {
              calendarId: activeCreateSelection.calendarId,
              ...(activeCreateSelection.account !== undefined
                ? { account: activeCreateSelection.account }
                : {}),
            },
          }
        : null;
    if (
      (activeActionBindings !== null || activeCreateBindings !== null) &&
      kernelCalendarBinding !== undefined &&
      calendarTargetStore !== undefined
    ) {
      const activeBinding = kernelCalendarBinding;
      const targetStore = calendarTargetStore;
      const readPort = createCalendarActionReadPort({
        db: handle.raw,
        binding: activeBinding.connector,
        targetStore,
        now,
      });
      const actionService = createActionExecutionService({
        db: handle.raw,
        referenceManager,
        preflightRead: readPort,
        targetStore,
        clock: now,
      });
      const createRead: ActionCreateReadPort | undefined =
        activeCreateBindings === null
          ? undefined
          : {
              read: async (request, signal) => {
                if (signal?.aborted === true) {
                  throw new Error("calendar create read aborted");
                }
                if (
                  request.connectorInstanceId !==
                  activeBinding.connectorInstanceId
                ) {
                  return { status: "schema_invalid" };
                }
                let getResult: Awaited<
                  ReturnType<typeof activeBinding.connector.get>
                >;
                try {
                  getResult = await activeBinding.connector.get(
                    {
                      calendarId: request.calendarId,
                      eventId: request.stableEventId,
                      ...(request.account !== undefined
                        ? { account: request.account }
                        : {}),
                    },
                    signal === undefined ? undefined : { signal },
                  );
                } catch {
                  return { status: "unavailable" };
                }
                if (!getResult.ok) {
                  const code = getResult.code;
                  if (
                    code === "mcp_schema_mismatch" ||
                    code === "calendar_response_invalid" ||
                    code === "calendar_range_invalid"
                  ) {
                    return { status: "schema_invalid" };
                  }
                  return { status: "unavailable" };
                }
                const observation = toCalendarObservation(
                  getResult.event,
                  activeBinding.connectorInstanceId,
                  now(),
                );
                const title = observation.title;
                return {
                  status: "ok",
                  observation: {
                    connectorInstanceId: activeBinding.connectorInstanceId,
                    resourceCanonicalKey: getResult.event.canonicalKey,
                    title: title === null ? null : title.slice(0, 128),
                    text: observation.text.normalize("NFC"),
                    sourceRevision: observation.sourceRevision ?? null,
                    eventStatus: getResult.event.status,
                    observedAt: observation.observedAt,
                  },
                };
              },
            };
      registry.register(
        ACTION_STRATEGY_NAME,
        createActionStrategy({
          db: handle.raw,
          service: actionService,
          preflightRead: readPort,
          ...(activeActionBindings !== null
            ? {
                writePort: activeActionBindings.port,
                resolveTarget: createCalendarActionTargetResolver({
                  db: handle.raw,
                  targetStore,
                }),
              }
            : {}),
          ...(activeCreateBindings !== null && createRead !== undefined
            ? {
                createWritePort: activeCreateBindings.createPort,
                createRead,
                createSelection: activeCreateBindings.selection,
              }
            : {}),
        }),
      );
      if (activeCreateBindings !== null) {
        // Counts only: no provider id, capability or connector detail logged.
        logger.info("server.create_ready", { status: 1 });
      }
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
    // Memory service starts after engine recovery: crash-recovered pending
    // jobs drain with stable keys before the idle timer arms.
    if (memory !== null) {
      memory.start();
    }
    // Shadow worker starts after engine recovery (reconciled restart state
    // is already paused + held above): NO automatic job pickup — only
    // meaningful new state (or a new explicit request) wakes it.
    if (shadow !== null) {
      shadow.start();
    }
    // Notification projector starts after engine recovery: startup ingest
    // from the migration-14 baselines + derived deadline rebuild (no
    // old-deadline catchup, no mass-notify of history), then armed on
    // committed writes + the single deadline timer.
    if (notifications !== null) {
      notifications.start();
    }

    const activeShadowWake = shadow;
    const activeMemoryControl = memory;
    const { app, controls } = createApp({
      config,
      repo,
      engine,
      logger,
      now,
      assets: loadUiAssets(),
      actionsEnabled,
      createEnabled,
      ...(memory !== null ? { memory } : {}),
      ...(activeShadowWake !== null
        ? {
            shadowWake: (): void => {
              try {
                activeShadowWake.wake();
              } catch {
                // Best effort: wake never throws into the caller.
              }
            },
            // Committed control changes (pause OR resume, including a
            // replayed old resume): the worker reads the ACTUAL control
            // state and aborts its OWN in-flight call when paused, so a
            // pure STOP aborts model/recall work with no foreground chat.
            // The memory service is notified on the same hook: STOP aborts
            // its OWN parked extraction call and closes shared background
            // admission (resume reopens it). Both reads are live-state and
            // never throw into the committed command.
            shadowControlChanged: (): void => {
              try {
                activeShadowWake.notifyControl();
              } catch {
                // Best effort: notify never throws into the caller.
              }
              try {
                activeMemoryControl?.notifyControl();
              } catch {
                // Best effort: notify never throws into the caller.
              }
            },
          }
        : {}),
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
                  notifySupervisor({
                    type: "companion-ready",
                    port: info.port,
                  });
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
      // AV07: genuine failure signal BEFORE any cleanup, so the supervisor
      // never mistakes silence for readiness. A port collision
      // (`address_in_use`) degrades to bounded retry on the supervisor side —
      // the foreign listener is never touched.
      notifySupervisor({
        type: "companion-failed",
        status: childFailedStatusForError(listenError),
      });
      // Listen failed: stop the shadow worker FIRST (its in-flight gateway
      // call aborts and is awaited: no orphan model calls), then the memory
      // service (its crash-recovered CLI children and timer must not outlive
      // the rejected startup or touch the repo/DB after close), then drain
      // the started engine, stop the owned Calendar connector, close any
      // created listener, and finally close the DB (in that order). Handlers
      // were not yet registered, but remove defensively before rethrowing.
      // Every step is best-effort: the listen error carries the startup
      // failure even when a cleanup step also fails.
      try {
        if (shadow !== null) {
          await shadow.stop();
        }
      } catch {
        // Best effort: the listen error carries the startup failure.
      }
      try {
        if (memory !== null) {
          await memory.stop();
        }
      } catch {
        // Best effort: the listen error carries the startup failure.
      }
      try {
        if (notifications !== null) {
          await notifications.stop();
        }
      } catch {
        // Best effort: the listen error carries the startup failure.
      }
      // Shared background admission: closed by both service stops above;
      // clear deferred wakes here so nothing fires after the DB close.
      try {
        backgroundResource.shutdown();
      } catch {
        // Best effort: the listen error carries the startup failure.
      }
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
      try {
        if (ownedWriteMcp !== undefined) {
          await boundedMcpShutdown(ownedWriteMcp, mcpShutdownMs);
        }
      } catch {
        // Best effort: the listen error carries the startup failure.
      }
      try {
        if (ownedCreateMcp !== undefined) {
          await boundedMcpShutdown(ownedCreateMcp, mcpShutdownMs);
        }
      } catch {
        // Best effort: the listen error carries the startup failure.
      }
      const ownedListenShutdown = takeOwnedActionShutdown();
      try {
        await boundedActionShutdown(ownedListenShutdown, mcpShutdownMs);
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
        // Stop shadow first: the in-flight gateway call aborts and is
        // awaited (no orphan model calls) before memory/engine/DB teardown.
        if (shadow !== null) {
          try {
            await shadow.stop();
          } catch {
            // Best effort: the engine drain below still runs.
          }
        }
        // Stop memory second: the idle timer is cancelled, in-flight CLI
        // children are hard-killed and awaited (no orphans), and no new
        // cultivation starts while the engine drains.
        if (memory !== null) {
          try {
            await memory.stop();
          } catch {
            // Best effort: the engine drain below still runs.
          }
        }
        // Stop notifications third: the single deadline timer is cleared
        // and the in-flight drain awaited (no post-close DB reads), before
        // the engine drain and the DB close below.
        if (notifications !== null) {
          try {
            await notifications.stop();
          } catch {
            // Best effort: the engine drain below still runs.
          }
        }
        // Shared background admission: closed by both service stops above;
        // clear deferred wakes here (no DB-after-close) before the engine
        // drain and the DB close below.
        try {
          backgroundResource.shutdown();
        } catch {
          // Best effort: the engine drain below still runs.
        }
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
        // M5: the adopted owned dedicated write connector shuts down
        // bounded exactly like the read connector above (after the engine
        // drain, before the DB close). A budget loss never blocks shutdown.
        // Unadopted/disabled compositions never construct it, so there is
        // nothing to own or close for them.
        if (ownedWriteMcp !== undefined) {
          let writeStopped = false;
          try {
            writeStopped = await boundedMcpShutdown(
              ownedWriteMcp,
              mcpShutdownMs,
            );
          } catch {
            // The connector's own cleanup is bounded; proceed with close.
          }
          if (!writeStopped) {
            logger.warn("server.reschedule_write_shutdown_timeout", {
              status: safeReason,
            });
          }
        }
        if (ownedCreateMcp !== undefined) {
          let createStopped = false;
          try {
            createStopped = await boundedMcpShutdown(
              ownedCreateMcp,
              mcpShutdownMs,
            );
          } catch {
            // The connector's own cleanup is bounded; proceed with close.
          }
          if (!createStopped) {
            logger.warn("server.create_write_shutdown_timeout", {
              status: safeReason,
            });
          }
        }
        // C21: the adopted hook is consumed before invoke (single-use even
        // across a drain-failure retry: the retry re-enters shutdown only
        // after the memo reset above, and the first pass never reached here).
        // Bounded like the owned MCP connector: a hanging hook never stalls
        // the shutdown path past the backstop budget.
        const ownedNormalShutdown = takeOwnedActionShutdown();
        let actionStopped = true;
        try {
          actionStopped = await boundedActionShutdown(
            ownedNormalShutdown,
            mcpShutdownMs,
          );
        } catch {
          // The adopted wrapper never throws; proceed with close.
        }
        if (!actionStopped) {
          logger.warn("server.action_write_shutdown_timeout", {
            status: safeReason,
          });
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

    // AV07 supervisor handshake: an EXPLICIT operator request relayed by the
    // supervisor (`stop` or `planned-restart`) runs the EXISTING graceful
    // shutdown (mark draining -> shadow/memory/notifications stop -> engine
    // drain -> bounded connector shutdown -> DB close -> listener close).
    // That drain IS the safe boundary: queued/running work either completes
    // inside SHUTDOWN_DRAIN_MS or shutdown throws and stays draining (never
    // a forced immediate kill for a normal planned restart). Unknown-commit
    // rows are durable and allow restart but are NEVER retried (unchanged
    // engine recovery rule). On success the child reports `companion-drained`
    // and exits so the supervisor can respawn (planned restart) or hold
    // (operator stop); on drain failure it reports `companion-drain-failed`
    // and stays alive so the supervisor HOLDS instead of forcing unsafe
    // work. Registered ONLY for supervisor-managed children (fixed marker in
    // the supervisor-set environment): test workers, embedders, and any
    // other IPC parent never see this channel. Only messages from the
    // supervisor IPC channel are honored — never model output, HTTP input,
    // or any untrusted channel.
    if (isSupervisorManaged()) {
      // Parent-death cleanup: if the supervisor crashes or is killed before
      // its own signal handler runs, the IPC channel disconnects while this
      // child still holds the DB and the listening port. Without this the
      // orphan stays alive and a replacement supervisor's child gets
      // EADDRINUSE until manual cleanup. Shut down gracefully (EXISTING
      // shutdown path, idempotent) and exit so the port/DB are released.
      process.on("disconnect", () => {
        void (async (): Promise<void> => {
          try {
            await shutdown("signal");
          } catch {
            // Best effort: exit below still releases the port/DB.
          }
          process.exit(1);
        })();
      });
      process.on("message", (message: unknown) => {
        if (
          typeof message !== "object" ||
          message === null ||
          (message as { type?: unknown }).type !== "supervisor-shutdown"
        ) {
          return;
        }
        const mode = (message as { mode?: unknown }).mode;
        if (mode !== "stop" && mode !== "planned-restart") {
          return;
        }
        void (async (): Promise<void> => {
          try {
            await shutdown("signal");
          } catch {
            notifySupervisor({ type: "companion-drain-failed" });
            return;
          }
          notifySupervisor({ type: "companion-drained" });
          process.exit(0);
        })();
      });
    }

    return {
      config,
      controls,
      engine: activeEngine,
      port,
      shutdown,
      toolBroker,
      memory,
      shadow,
      notifications,
    };
  } catch (error) {
    removeSignalHandlers();
    // Any post-start failure path stops the shadow worker FIRST (abort +
    // await in-flight gateway work: no orphan model calls), then the memory
    // service (crash-recovery CLI/timer must not outlive startup), BEFORE
    // the DB close below. The original error still carries the failure.
    if (shadow !== null) {
      try {
        await shadow.stop();
      } catch {
        // Best effort: the original startup error carries the failure.
      }
    }
    // Any post-start failure path (including memory started above) stops
    // and awaits the memory service BEFORE the DB close below: a rejected
    // startup must never leave its crash-recovery CLI/timer alive. The
    // original error still carries the failure.
    if (memory !== null) {
      try {
        await memory.stop();
      } catch {
        // Best effort: the original startup error carries the failure.
      }
    }
    // Same rule for the notification projector: clear the deadline timer
    // and await the in-flight drain BEFORE the DB close below.
    if (notifications !== null) {
      try {
        await notifications.stop();
      } catch {
        // Best effort: the original startup error carries the failure.
      }
    }
    // Shared background admission: clear deferred wakes BEFORE the DB close
    // below (both services already stopped and closed above).
    try {
      backgroundResource.shutdown();
    } catch {
      // Best effort: the original startup error carries the failure.
    }
    if (ownedMcp !== undefined) {
      try {
        await boundedMcpShutdown(ownedMcp, mcpShutdownMs);
      } catch {
        // Best effort: the original startup error carries the failure.
      }
    }
    if (ownedWriteMcp !== undefined) {
      try {
        await boundedMcpShutdown(ownedWriteMcp, mcpShutdownMs);
      } catch {
        // Best effort: the original startup error carries the failure.
      }
    }
    if (ownedCreateMcp !== undefined) {
      try {
        await boundedMcpShutdown(ownedCreateMcp, mcpShutdownMs);
      } catch {
        // Best effort: the original startup error carries the failure.
      }
    }
    const ownedStartupShutdown = takeOwnedActionShutdown();
    try {
      await boundedActionShutdown(ownedStartupShutdown, mcpShutdownMs);
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
    // AV07: report startup failure to the supervisor (when present) with the
    // fixed status vocabulary. `newer_database` holds with the DB preserved
    // (never restore an old backup); `address_in_use` degrades to bounded
    // retry (never kill any listener).
    notifySupervisor({
      type: "companion-failed",
      status: childFailedStatusForError(error),
    });
    throw error;
  }
}

export async function startServerFromEnv(): Promise<StartedServer> {
  return startServer({});
}
