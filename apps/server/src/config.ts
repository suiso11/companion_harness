// M0 server config (plan §9 blocker 7.9, §19.6). C14 adds the strict
// opt-in Calendar/MCP config (COMPANION_CALENDAR_JSON, default disabled),
// which is a config HINT only: it never carries trusted read-only binding
// definitions or any authorization category — those must be injected by
// trusted host code at bootstrap.
//
// Minimal frozen env config: DB path / loopback bind host / port / IANA
// time zone / log level, all with defaults and Zod validation. The config
// object is frozen at load time and never reloaded.
//
// Fail-closed rules:
// - bind host accepts only 127.0.0.1 or localhost (loopback only).
// - timeZone must be a real IANA name: membership is verified with
//   Intl.DateTimeFormat, not shape alone.
// - the default DB lives under the OS app-data directory.
// - a DB path that is itself a symlink, or that passes through any
//   existing symlinked parent component, is rejected (fail-closed).

import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  type McpConnectorConfig,
  mcpConnectorConfigSchema,
} from "@companion/connector-mcp";
import {
  parseWebSearchConfig,
  type WebSearchConfig,
} from "@companion/contracts";
import {
  MAX_RESPONSE_BYTES as GATEWAY_MAX_RESPONSE_BYTES,
  isValidApiKeyHeaderValue,
  normalizeLoopbackBaseUrl,
} from "@companion/model-local";
import { z } from "zod";

export const DEFAULT_HOST = "127.0.0.1" as const;
export const DEFAULT_PORT = 3000;
export const DEFAULT_TIME_ZONE = "UTC";
export const DEFAULT_LOG_LEVEL = "info" as const;
export const DB_FILE_NAME = "companion.sqlite";

const HostSchema = z.enum(["127.0.0.1", "localhost"]);
export type ServerHost = z.infer<typeof HostSchema>;

const LogLevelSchema = z.enum(["debug", "info", "warn", "error"]);
export type ServerLogLevel = z.infer<typeof LogLevelSchema>;

/** Validated Markdown vault root (path-private at runtime). */
export interface MarkdownRootConfig {
  readonly path: string;
  readonly alias?: string;
}

export const MAX_MARKDOWN_ROOTS = 1024;
export const MAX_MARKDOWN_ROOT_PATH_LENGTH = 4096;
const MARKDOWN_ROOT_ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * MCP connector config shape WITHOUT the persisted `connectorInstanceId`
 * (C14): that field is filled in at bootstrap from the exact instance row the
 * server registers itself, so an env hint can never claim a stored instance
 * id it does not own. Everything else is the connector-mcp frozen schema —
 * transport bounds, exact identity fields and binding hashes come from this
 * CONFIG HINT only; there is no category/authorization field here and none
 * can be added: trusted read-only binding definitions remain host code
 * (bootstrap injection), never env config.
 */
const CalendarMcpConnectorSchema = mcpConnectorConfigSchema.omit({
  connectorInstanceId: true,
});
export type CalendarMcpConnectorConfig = z.infer<
  typeof CalendarMcpConnectorSchema
>;

/** Trusted single-calendar HOST selection hint (metadata only, no secrets). */
export interface CalendarSelectionConfig {
  readonly calendarId: string;
  readonly account?: string;
}

export const MAX_CALENDAR_SELECTION_LENGTH = 512;

/** Validated strict opt-in Calendar/MCP config (deep-frozen at runtime). */
export interface CalendarConfig {
  /** Host-controlled single-calendar selection persisted as metadata. */
  readonly selection: CalendarSelectionConfig;
  /**
   * MCP connector config HINT (transport, identity, binding names + schema
   * hashes). Authorization is NOT here: no `category`, no definition data,
   * no env path can ever enable a call. Read-only binding definitions must
   * be injected separately by trusted host code.
   */
  readonly connector: CalendarMcpConnectorConfig;
}

const ServerConfigSchema = z.strictObject({
  dbPath: z.string().min(1).max(4096),
  host: HostSchema,
  port: z.number().int().min(0).max(65535),
  timeZone: z.string().min(1).max(128),
  logLevel: LogLevelSchema,
});

/**
 * C21: strict opt-in M5 Action config + M6 opt-in creation extension
 * (deep-frozen). DEFAULT DISABLED on all flags. These are HINTS only —
 * they never authorize anything:
 *
 * - `optIn` (default false): the host opts into the M5 Action surface at
 *   all (proposal-only `calendar.reschedule` registration + decision APIs).
 * - `writeEnabled` (default false): the host additionally allows a queued
 *   Action Run to be APPROVED (the repository stager is created with exactly
 *   this flag, so staging/approval is an explicit composition opt-in).
 * - `createEnabled` (default false, M6): the host additionally allows
 *   `calendar.create` staging/commits on top of the two flags above. An old
 *   `writeEnabled === true` composition NEVER implicitly authorizes
 *   creation: reschedule-only hosts keep working with zero behavior change
 *   and no new registration appears.
 *
 * No flag can supply or select a real binding: the exact trusted write ports
 * are injected separately by trusted host code, and the server registers
 * `m5-action` only when config flags AND dedicated write bindings matching
 * the active owned Calendar instance are ALL present. No env value can ever
 * enable a category, a provider, a write capability or an OAuth/pin flow.
 */
export interface ActionConfig {
  readonly optIn: boolean;
  readonly writeEnabled: boolean;
  readonly createEnabled: boolean;
}

/** Default M5 Action config: fully disabled (fail-closed). */
export const DEFAULT_ACTION_CONFIG: ActionConfig = Object.freeze({
  optIn: false,
  writeEnabled: false,
  createEnabled: false,
});

/**
 * Strict M5 Action opt-in parser: exact
 * `{ optIn?, writeEnabled?, createEnabled? }` object with optional booleans
 * defaulting to FALSE. Any unknown key, non-boolean value or non-object
 * input fails closed with a fixed message; the result is deep-frozen.
 */
export function parseActionConfig(raw: string | undefined): ActionConfig {
  if (raw === undefined) {
    return DEFAULT_ACTION_CONFIG;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw configError("action config must be a JSON object");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw configError("action config must be a JSON object");
  }
  for (const key of Object.keys(parsed)) {
    if (key !== "optIn" && key !== "writeEnabled" && key !== "createEnabled") {
      throw configError("action config has an unknown key");
    }
  }
  const record = parsed as {
    optIn?: unknown;
    writeEnabled?: unknown;
    createEnabled?: unknown;
  };
  const optIn = record.optIn ?? false;
  const writeEnabled = record.writeEnabled ?? false;
  const createEnabled = record.createEnabled ?? false;
  if (
    typeof optIn !== "boolean" ||
    typeof writeEnabled !== "boolean" ||
    typeof createEnabled !== "boolean"
  ) {
    throw configError("action config flags must be booleans");
  }
  return Object.freeze({ optIn, writeEnabled, createEnabled });
}

/**
 * Strict opt-in remote (tailnet) access config (slice a: Origin/Host
 * allowlist, slice b: single-user password login + sessions, DEFAULT
 * DISABLED). This is a HINT for the allowlist check in app.ts plus the
 * session enforcement only — it never changes the bind host
 * (loopback-only, HostSchema unchanged).
 *
 * - Env `COMPANION_REMOTE_JSON` is strict JSON only; unset means disabled
 *   with an empty allowlist (current loopback behavior, zero change), and
 *   any unparseable/non-object value fails startup fail-closed (never a
 *   silent disable).
 * - Must be an exact object with only `{ enabled?, allowedOrigins?,
 *   passwordFile?, absoluteTimeoutMs?, idleTimeoutMs?, maxFailures?,
 *   lockoutMs? }`. `enabled` defaults to false; `allowedOrigins`
 *   defaults to `[]`.
 * - Each allowlist entry must be an exact `https://<host>` origin: https
 *   scheme, no credentials, no explicit port, no path/query/fragment and
 *   no trailing slash (the entry must equal its own `URL.origin`
 *   serialization). Duplicate entries are rejected.
 * - `enabled: true` with an empty allowlist fails startup fail-closed.
 * - `enabled: true` requires `passwordFile` (absolute path to the
 *   scrypt password file created by the `set-password` CLI, stored
 *   OUTSIDE SQLite). Missing/unreadable/world-readable/invalid files fail
 *   startup fail-closed. The password itself never travels via env/argv.
 * - Timeout/lockout tunables below carry 案 defaults (design §3):
 *   absolute session expiry 30d, idle timeout 7d, 5 failures → 15 min
 *   global lockout. The failure counter/lockout is persisted in SQLite
 *   (`remote_login_lockout`, migration 0024), so restarts cannot clear
 *   an active lockout.
 * - Failures carry fixed messages only: no values escape.
 * - The returned object (including the origins array) is deep-frozen.
 */
export interface RemoteConfig {
  readonly enabled: boolean;
  readonly allowedOrigins: readonly string[];
  /** Absolute path to the password hash file; null means unset. */
  readonly passwordFile: string | null;
  /** Absolute session lifetime in ms (案 default 30d). */
  readonly absoluteTimeoutMs: number;
  /** Idle session timeout in ms (案 default 7d). */
  readonly idleTimeoutMs: number;
  /** Consecutive failed logins before the global lockout (案 default 5). */
  readonly maxFailures: number;
  /** Global login lockout duration in ms (案 default 15 min). */
  readonly lockoutMs: number;
}

/** Default remote config: fully disabled with an empty allowlist. */
export const DEFAULT_REMOTE_CONFIG: RemoteConfig = Object.freeze({
  enabled: false,
  allowedOrigins: Object.freeze([]),
  passwordFile: null,
  absoluteTimeoutMs: 30 * 24 * 60 * 60 * 1000,
  idleTimeoutMs: 7 * 24 * 60 * 60 * 1000,
  maxFailures: 5,
  lockoutMs: 15 * 60 * 1000,
});

export const MAX_REMOTE_ORIGINS = 16;
export const MAX_REMOTE_ORIGIN_LENGTH = 256;
export const MAX_REMOTE_PATH_LENGTH = 4096;
/** 案 defaults (design §3, still open to haruka confirmation). */
export const DEFAULT_REMOTE_ABSOLUTE_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_REMOTE_IDLE_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_REMOTE_MAX_FAILURES = 5;
export const DEFAULT_REMOTE_LOCKOUT_MS = 15 * 60 * 1000;
export const MIN_REMOTE_ABSOLUTE_TIMEOUT_MS = 60 * 60 * 1000;
export const MAX_REMOTE_ABSOLUTE_TIMEOUT_MS = 90 * 24 * 60 * 60 * 1000;
export const MIN_REMOTE_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
export const MAX_REMOTE_IDLE_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1000;
export const MIN_REMOTE_MAX_FAILURES = 3;
export const MAX_REMOTE_MAX_FAILURES = 20;
export const MIN_REMOTE_LOCKOUT_MS = 60 * 1000;
export const MAX_REMOTE_LOCKOUT_MS = 24 * 60 * 60 * 1000;

function requireRemoteOrigin(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_REMOTE_ORIGIN_LENGTH ||
    value.includes("\0")
  ) {
    throw configError("remote origin allowlist entry is invalid");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw configError("remote origin allowlist entry is invalid");
  }
  // IPv6 literals are rejected at config time: Node keeps the brackets
  // in URL.hostname while Host-header parsing strips them, so an IPv6
  // entry could never pass the Host check. Tailscale MagicDNS hostnames
  // are the documented form; this keeps parsing simple and fail-closed.
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.origin !== value ||
    url.hostname.includes(":") ||
    url.hostname.includes("[") ||
    url.hostname.includes("]")
  ) {
    throw configError("remote origin allowlist entry is invalid");
  }
  return value;
}

export function parseRemoteConfig(raw: string | undefined): RemoteConfig {
  if (raw === undefined) {
    return DEFAULT_REMOTE_CONFIG;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw configError("remote config must be a JSON object");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw configError("remote config must be a JSON object");
  }
  for (const key of Object.keys(parsed)) {
    if (
      key !== "enabled" &&
      key !== "allowedOrigins" &&
      key !== "passwordFile" &&
      key !== "absoluteTimeoutMs" &&
      key !== "idleTimeoutMs" &&
      key !== "maxFailures" &&
      key !== "lockoutMs"
    ) {
      throw configError("remote config has an unknown key");
    }
  }
  const record = parsed as {
    enabled?: unknown;
    allowedOrigins?: unknown;
    passwordFile?: unknown;
    absoluteTimeoutMs?: unknown;
    idleTimeoutMs?: unknown;
    maxFailures?: unknown;
    lockoutMs?: unknown;
  };
  // Defaults apply only when keys are absent: an explicit `null` is a
  // malformed shape (strict `{ enabled?, allowedOrigins? }` contract),
  // not an omitted key. `??` would silently swallow null, so branch on
  // key presence and let the type checks below reject null.
  const hasEnabled = Object.hasOwn(parsed, "enabled");
  const hasOrigins = Object.hasOwn(parsed, "allowedOrigins");
  const enabled = hasEnabled ? record.enabled : false;
  if (typeof enabled !== "boolean") {
    throw configError("remote config enabled flag is invalid");
  }
  const rawOrigins = hasOrigins ? record.allowedOrigins : [];
  if (!Array.isArray(rawOrigins) || rawOrigins.length > MAX_REMOTE_ORIGINS) {
    throw configError("remote origin allowlist is invalid");
  }
  const seen = new Set<string>();
  const allowedOrigins: string[] = [];
  for (const entry of rawOrigins) {
    const origin = requireRemoteOrigin(entry);
    if (seen.has(origin)) {
      throw configError("remote origin allowlist is invalid");
    }
    seen.add(origin);
    allowedOrigins.push(origin);
  }
  let passwordFile: string | null = null;
  if (record.passwordFile !== undefined) {
    if (
      typeof record.passwordFile !== "string" ||
      record.passwordFile.length === 0 ||
      record.passwordFile.length > MAX_REMOTE_PATH_LENGTH ||
      record.passwordFile.includes("\0") ||
      !isAbsolute(record.passwordFile)
    ) {
      throw configError("remote password file path is invalid");
    }
    passwordFile = record.passwordFile;
  }
  const absoluteTimeoutMs = requireRemoteBoundedInt(
    record.absoluteTimeoutMs,
    DEFAULT_REMOTE_ABSOLUTE_TIMEOUT_MS,
    MIN_REMOTE_ABSOLUTE_TIMEOUT_MS,
    MAX_REMOTE_ABSOLUTE_TIMEOUT_MS,
    "remote absolute session timeout",
  );
  const idleTimeoutMs = requireRemoteBoundedInt(
    record.idleTimeoutMs,
    DEFAULT_REMOTE_IDLE_TIMEOUT_MS,
    MIN_REMOTE_IDLE_TIMEOUT_MS,
    MAX_REMOTE_IDLE_TIMEOUT_MS,
    "remote idle session timeout",
  );
  const maxFailures = requireRemoteBoundedInt(
    record.maxFailures,
    DEFAULT_REMOTE_MAX_FAILURES,
    MIN_REMOTE_MAX_FAILURES,
    MAX_REMOTE_MAX_FAILURES,
    "remote login failure limit",
  );
  const lockoutMs = requireRemoteBoundedInt(
    record.lockoutMs,
    DEFAULT_REMOTE_LOCKOUT_MS,
    MIN_REMOTE_LOCKOUT_MS,
    MAX_REMOTE_LOCKOUT_MS,
    "remote login lockout",
  );
  return Object.freeze({
    enabled,
    allowedOrigins: Object.freeze(allowedOrigins),
    passwordFile,
    absoluteTimeoutMs,
    idleTimeoutMs,
    maxFailures,
    lockoutMs,
  });
}

function requireRemoteBoundedInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  what: string,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw configError(`${what} must be an integer`);
  }
  if (value < min || value > max) {
    throw configError(`${what} is out of bounds`);
  }
  return value;
}

export interface ServerConfig {
  readonly dbPath: string;
  readonly host: ServerHost;
  /** TCP port. 0 means an OS-assigned ephemeral port (tests only). */
  readonly port: number;
  /** Verified IANA time-zone name (Intl membership). */
  readonly timeZone: string;
  readonly logLevel: ServerLogLevel;
  /** Validated Markdown vault roots (deep-frozen, default empty). */
  readonly markdownRoots: readonly MarkdownRootConfig[];
  /** Strict opt-in local model config; null (unset) means no model. */
  readonly model: ModelConfig | null;
  /** Strict opt-in Calendar/MCP config; null (unset) means disabled. */
  readonly calendar: CalendarConfig | null;
  /** Strict opt-in M5 Action config (default fully disabled). */
  readonly actions: ActionConfig;
  /**
   * Strict opt-in web search config (SearXNG, deep-frozen). Unset means
   * disabled; parsing failures fail startup closed.
   */
  readonly webSearch: WebSearchConfig;
  /** Strict opt-in remind memory config; null (unset) means memoryless. */
  readonly memory: MemoryConfig | null;
  /** Opt-in private execution records; null (unset) means disabled. */
  readonly executionRecords: ExecutionRecordsConfig | null;
  /** Strict opt-in remote (tailnet) Origin/Host allowlist (default off). */
  readonly remote: RemoteConfig;
  /**
   * Strict opt-in trial proposal/approval surface config; null (unset)
   * means trials disabled. When set, the profile snapshot plus the
   * workspace alias come ONLY from this frozen config, never from a
   * request body. No defaults for caps/checks: every field required.
   */
  readonly trial: TrialConfig | null;
}

/** Local model adapter (loopback-only, strict opt-in). */
export type ModelAdapter = "ollama" | "openai-compatible";

/** Validated local model config (value-private at runtime, deep-frozen). */
export interface ModelConfig {
  readonly adapter: ModelAdapter;
  /** Normalized loopback base URL (no trailing slash, no query/fragment). */
  readonly baseUrl: string;
  /** Model identifier sent with each chat request (1..256 chars). */
  readonly model: string;
  /** Optional bearer token (never logged, never persisted). */
  readonly apiKey?: string;
  /**
   * Optional OpenAI-compatible `tool_choice` policy for tool-bearing
   * requests. Unset defaults to `required` so a model that would answer in
   * prose must call a tool instead (the kernel classifies a content-only
   * step as `free_text`). `auto` restores provider defaults. Ignored by the
   * Ollama adapter.
   */
  readonly toolChoice?: "auto" | "required";
}

export const MAX_MODEL_NAME_LENGTH = 256;
export const MAX_MODEL_API_KEY_LENGTH = 4096;

export class ServerConfigError extends Error {
  readonly code = "server_config_invalid" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ServerConfigError";
  }
}

/** Opt-in private local execution-record store configuration. */
export interface ExecutionRecordsConfig {
  readonly directory: string;
  readonly retentionDays: number;
}

export const EXECUTION_RECORDS_RETENTION_DEFAULT_DAYS = 30;
export const MAX_EXECUTION_RECORDS_RETENTION_DAYS = 3650;

const EXECUTION_RECORD_DIR_KEYS = new Set(["directory", "retentionDays"]);

/**
 * Strict opt-in execution-record parser (COMPANION_EXECUTION_RECORDS_JSON).
 * Unset = null (disabled). The directory must be absolute; it is validated
 * again (symlink-safe) by the store at construction.
 */
export function parseExecutionRecordsConfig(
  raw: string | undefined,
): ExecutionRecordsConfig | null {
  if (raw === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw configError("execution records config must be a JSON object");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw configError("execution records config must be a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!EXECUTION_RECORD_DIR_KEYS.has(key)) {
      throw configError("execution records config has an unknown key");
    }
  }
  const directory = record.directory;
  if (
    typeof directory !== "string" ||
    directory.length === 0 ||
    directory.length > 4096 ||
    directory.includes("\0") ||
    !isAbsolute(directory)
  ) {
    throw configError("execution records directory must be absolute");
  }
  const rawRetention = record.retentionDays;
  let retentionDays = EXECUTION_RECORDS_RETENTION_DEFAULT_DAYS;
  if (rawRetention !== undefined) {
    if (
      typeof rawRetention !== "number" ||
      !Number.isInteger(rawRetention) ||
      rawRetention < 0 ||
      rawRetention > MAX_EXECUTION_RECORDS_RETENTION_DAYS
    ) {
      throw configError("execution records retentionDays is out of bounds");
    }
    retentionDays = rawRetention;
  }
  return Object.freeze({ directory, retentionDays });
}

/** OS app-data directory for the default DB (plan §9 blocker 7.9). */
export function appDataDir(): string {
  const home = homedir();
  if (process.platform === "win32") {
    const base = process.env.APPDATA;
    const root =
      base !== undefined && base.length > 0
        ? base
        : join(home, "AppData", "Roaming");
    return join(root, "companion-harness");
  }
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "companion-harness");
  }
  const xdg = process.env.XDG_DATA_HOME;
  const root =
    xdg !== undefined && xdg.length > 0 ? xdg : join(home, ".local", "share");
  return join(root, "companion-harness");
}

export function defaultDbPath(): string {
  return join(appDataDir(), DB_FILE_NAME);
}

/** True when the value names a real IANA time zone (Intl membership). */
export function isIanaTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function configError(message: string): ServerConfigError {
  return new ServerConfigError(message);
}

/**
 * Fail-closed symlink guard: rejects the path when the DB file itself or
 * any existing parent component is a symlink. Missing (not yet created)
 * components are skipped.
 */
export function assertDbPathHasNoSymlink(resolvedDbPath: string): void {
  try {
    const self = lstatSync(resolvedDbPath);
    if (self.isSymbolicLink()) {
      throw configError("database path must not be a symlink");
    }
    if (self.isDirectory()) {
      throw configError("database path must not be a directory");
    }
  } catch (error) {
    if (error instanceof ServerConfigError) {
      throw error;
    }
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      (error as { code?: string }).code !== "ENOENT"
    ) {
      throw configError("database path is not accessible");
    }
    // Missing DB file is fine; parents are checked below.
  }
  let dir = dirname(resolvedDbPath);
  for (;;) {
    try {
      const stat = lstatSync(dir);
      if (stat.isSymbolicLink()) {
        throw configError("database path must not pass through a symlink");
      }
    } catch (error) {
      if (error instanceof ServerConfigError) {
        throw error;
      }
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: string }).code === "ENOENT"
      ) {
        // Missing parent is fine (created at startup); keep walking up.
      } else {
        throw configError("database parent path is not accessible");
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.length === 0) {
    return DEFAULT_PORT;
  }
  if (!/^\d{1,5}$/.test(raw)) {
    throw configError("port must be an integer 0..65535");
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw configError("port must be an integer 0..65535");
  }
  return port;
}

/**
 * Strict Markdown roots parser (plan 14.1/14.6 server wiring).
 *
 * - Env COMPANION_MARKDOWN_ROOTS_JSON is strict JSON only; unset means [].
 * - Top level must be an array (scalar/object rejected), max 1024 entries.
 * - Each entry must be an exact { path, alias? } object: unknown keys
 *   rejected, path must be a non-empty absolute path with no NUL byte and
 *   at most 4096 chars, alias when present must be a safe 1..64 token
 *   matching /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/ with no duplicates.
 * - Failures carry fixed messages only: no raw values or paths escape.
 * - The returned array and every entry are deep-frozen.
 */
export function parseMarkdownRoots(
  raw: string | undefined,
): readonly MarkdownRootConfig[] {
  if (raw === undefined) {
    return Object.freeze([]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw configError("markdown roots must be a JSON array");
  }
  if (!Array.isArray(parsed)) {
    throw configError("markdown roots must be a JSON array");
  }
  if (parsed.length > MAX_MARKDOWN_ROOTS) {
    throw configError("markdown roots exceed the maximum count");
  }
  const seenAliases = new Set<string>();
  const entries: MarkdownRootConfig[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw configError("markdown roots entry must be an object");
    }
    const keys = Object.keys(item);
    for (const key of keys) {
      if (key !== "path" && key !== "alias") {
        throw configError("markdown roots entry has an unknown key");
      }
    }
    const record = item as { path?: unknown; alias?: unknown };
    const pathValue = record.path;
    if (
      typeof pathValue !== "string" ||
      pathValue.length === 0 ||
      pathValue.length > MAX_MARKDOWN_ROOT_PATH_LENGTH
    ) {
      throw configError("markdown roots path is invalid");
    }
    if (pathValue.includes("\0")) {
      throw configError("markdown roots path is invalid");
    }
    if (!isAbsolute(pathValue)) {
      throw configError("markdown roots path is invalid");
    }
    if (record.alias !== undefined) {
      if (
        typeof record.alias !== "string" ||
        !MARKDOWN_ROOT_ALIAS_PATTERN.test(record.alias)
      ) {
        throw configError("markdown roots alias is invalid");
      }
      if (seenAliases.has(record.alias)) {
        throw configError("markdown roots alias is invalid");
      }
      seenAliases.add(record.alias);
    }
    entries.push(
      Object.freeze(
        record.alias === undefined
          ? { path: pathValue }
          : { path: pathValue, alias: record.alias as string },
      ),
    );
  }
  return Object.freeze(entries);
}

/**
 * Strict local model parser (M2 server wiring).
 *
 * - Env COMPANION_MODEL_JSON is strict JSON only; unset means null (no model).
 * - Must be an exact object with only { adapter, baseUrl, model, apiKey? }.
 * - adapter must be 'ollama' or 'openai-compatible'.
 * - baseUrl is validated with model-local's loopback URL rules (plain http,
 *   127.0.0.1/localhost/::1, no credentials/query/fragment); the normalized
 *   form is stored.
 * - model must be 1..256 chars with no NUL byte.
 * - apiKey when present must be a non-empty string up to 4096 chars with
 *   no NUL byte and a legal HTTP Authorization header value: printable
 *   ASCII U+0020..U+007E plus Latin-1 U+00A0..U+00FF only (C0/C1
 *   controls, DEL, CR/LF, and code points above U+00FF rejected).
 * - Failures carry fixed messages only: no URL, model, or key material escapes.
 * - The returned object is deep-frozen.
 */
export function parseModelConfig(raw: string | undefined): ModelConfig | null {
  if (raw === undefined) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw configError("model config must be a JSON object");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw configError("model config must be a JSON object");
  }
  const keys = Object.keys(parsed);
  for (const key of keys) {
    if (
      key !== "adapter" &&
      key !== "baseUrl" &&
      key !== "model" &&
      key !== "apiKey" &&
      key !== "toolChoice"
    ) {
      throw configError("model config has an unknown key");
    }
  }
  const record = parsed as {
    adapter?: unknown;
    baseUrl?: unknown;
    model?: unknown;
    apiKey?: unknown;
    toolChoice?: unknown;
  };
  if (record.adapter !== "ollama" && record.adapter !== "openai-compatible") {
    throw configError("model adapter is invalid");
  }
  let baseUrl: string;
  try {
    baseUrl = normalizeLoopbackBaseUrl(record.baseUrl);
  } catch {
    throw configError("model base URL is invalid");
  }
  if (
    typeof record.model !== "string" ||
    record.model.length === 0 ||
    record.model.length > MAX_MODEL_NAME_LENGTH ||
    record.model.includes("\0")
  ) {
    throw configError("model identifier is invalid");
  }
  if (
    record.toolChoice !== undefined &&
    record.toolChoice !== "auto" &&
    record.toolChoice !== "required"
  ) {
    throw configError("model tool choice is invalid");
  }
  if (record.apiKey !== undefined) {
    if (
      typeof record.apiKey !== "string" ||
      record.apiKey.length === 0 ||
      record.apiKey.length > MAX_MODEL_API_KEY_LENGTH ||
      record.apiKey.includes("\0") ||
      !isValidApiKeyHeaderValue(record.apiKey)
    ) {
      throw configError("model auth is invalid");
    }
  }
  return Object.freeze(
    record.apiKey === undefined
      ? {
          adapter: record.adapter,
          baseUrl,
          model: record.model as string,
          ...(record.toolChoice === undefined
            ? {}
            : { toolChoice: record.toolChoice }),
        }
      : {
          adapter: record.adapter,
          baseUrl,
          model: record.model as string,
          apiKey: record.apiKey as string,
          ...(record.toolChoice === undefined
            ? {}
            : { toolChoice: record.toolChoice }),
        },
  );
}

/**
 * Strict Calendar/MCP opt-in parser (C14).
 *
 * - Env COMPANION_CALENDAR_JSON is strict JSON only; unset means null
 *   (DEFAULT DISABLED). There is no discovered or model-defined registration:
 *   only this explicit env opt-in can ever create a Calendar connector.
 * - Must be an exact object with only { selection, connector }.
 * - selection must be an exact { calendarId, account? } object: calendarId
 *   is a required 1..512 string with no NUL byte; account when present is a
 *   1..512 string with no NUL byte. These are HOST-selected metadata values
 *   (never model input) and are persisted only as connector_instances
 *   metadata — never as provider credentials.
 * - connector must match the shared connector-mcp schema WITHOUT the
 *   connectorInstanceId field (the server fills the id it registers itself).
 *   Derived MCP schema hashes here are config HINTS bound to the exact
 *   identity/transport; the trusted read-only binding definitions (with
 *   their categories) are NOT part of this config and can never be provided
 *   through env — they must be injected separately by trusted host code.
 * - Failures carry fixed messages only: no raw values escape.
 * - The returned object and its nested parts are deep-frozen.
 */
export function parseCalendarConfig(
  raw: string | undefined,
): CalendarConfig | null {
  if (raw === undefined) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw configError("calendar config must be a JSON object");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw configError("calendar config must be a JSON object");
  }
  const keys = Object.keys(parsed);
  for (const key of keys) {
    if (key !== "selection" && key !== "connector") {
      throw configError("calendar config has an unknown key");
    }
  }
  const record = parsed as {
    selection?: unknown;
    connector?: unknown;
  };
  const selectionRaw = record.selection;
  if (
    typeof selectionRaw !== "object" ||
    selectionRaw === null ||
    Array.isArray(selectionRaw)
  ) {
    throw configError("calendar selection is invalid");
  }
  const selectionKeys = Object.keys(selectionRaw);
  for (const key of selectionKeys) {
    if (key !== "calendarId" && key !== "account") {
      throw configError("calendar selection has an unknown key");
    }
  }
  const selectionRecord = selectionRaw as {
    calendarId?: unknown;
    account?: unknown;
  };
  const calendarId = selectionRecord.calendarId;
  if (
    typeof calendarId !== "string" ||
    calendarId.length === 0 ||
    calendarId.length > MAX_CALENDAR_SELECTION_LENGTH ||
    calendarId.includes("\0")
  ) {
    throw configError("calendar selection calendarId is invalid");
  }
  const account = selectionRecord.account;
  let selection: CalendarSelectionConfig = { calendarId };
  if (account !== undefined) {
    if (
      typeof account !== "string" ||
      account.length === 0 ||
      account.length > MAX_CALENDAR_SELECTION_LENGTH ||
      account.includes("\0")
    ) {
      throw configError("calendar selection account is invalid");
    }
    selection = { calendarId, account };
  }
  const connectorRaw = record.connector;
  if (
    typeof connectorRaw !== "object" ||
    connectorRaw === null ||
    Array.isArray(connectorRaw)
  ) {
    throw configError("calendar connector config is invalid");
  }
  const connectorResult = CalendarMcpConnectorSchema.safeParse(connectorRaw);
  if (!connectorResult.success) {
    throw configError("calendar connector config is invalid");
  }
  const connector = deepFreeze(connectorResult.data) as McpConnectorConfig &
    object;
  return Object.freeze({
    selection: Object.freeze(selection),
    connector,
  });
}

/** Recursively freeze a plain JSON-shaped parsed value in place. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Strict remind memory integration config (conversation memory + bounded
 * automatic cultivation). Trusted startup opt-in only: unset (default)
 * means fully memoryless and preserves current behavior.
 *
 * - Env `COMPANION_MEMORY_JSON` is strict JSON only; unset means null.
 * - Must be an exact object with only `{ executable, entry, config,
 *   scope, timeoutMs?, extractTimeoutMs?, maxResponseBytes?, recallLimit?,
 *   idleMs? }`.
 * - `executable`: absolute path to the child-process binary (usually the
 *   Node.js binary that runs the remind CLI). `entry`: absolute path to
 *   the remind CLI script. `config`: absolute path to the remind startup
 *   config file the CLI opens. No shell is ever used; the child is
 *   spawned with `shell: false` and exactly `[entry, --config, config]`.
 * - `scope`: remind scope (1..256 chars, no control characters). All
 *   Companion CLI calls carry this scope; cross-scope records are
 *   rejected (FORBIDDEN_SCOPE) and never surfaced.
 * - `timeoutMs` (default 5000, bounds 500..30000): per-CLI-call deadline
 *   with hard kill afterwards. `extractTimeoutMs` (default 120000, bounds
 *   5000..300000): SEPARATE budget for the extraction model call only —
 *   a local reasoning model needs far longer than one CLI call; the CLI
 *   `timeoutMs` is never changed by it. `maxResponseBytes` (default 65536, bounds
 *   4096..1048576): stdout byte cap. `recallLimit` (default 5, bounds
 *   1..8): pre-answer recall item cap. `idleMs` (default 30000, bounds
 *   5000..300000): idle delay before one bounded cultivation batch.
 * - Failures carry fixed messages only: no paths, scopes, or values escape.
 * - The returned object is deep-frozen.
 */
export interface MemoryConfig {
  /** Absolute path to the child-process binary (no shell, no lookup). */
  readonly executable: string;
  /** Absolute path to the remind CLI entry script. */
  readonly entry: string;
  /** Absolute path to the remind startup config file. */
  readonly config: string;
  /** Remind scope for every Companion CLI call. */
  readonly scope: string;
  /** Per-CLI-call deadline in ms (default 5000). */
  readonly timeoutMs: number;
  /** Extraction model-call budget in ms (default 120000); never the CLI deadline. */
  readonly extractTimeoutMs: number;
  /** Stdout byte cap per CLI call (default 65536). */
  readonly maxResponseBytes: number;
  /** Pre-answer recall item cap (default 5, never above 8). */
  readonly recallLimit: number;
  /** Idle delay in ms before one bounded cultivation batch (default 30000). */
  readonly idleMs: number;
}

export const DEFAULT_MEMORY_TIMEOUT_MS = 5000;
export const MIN_MEMORY_TIMEOUT_MS = 500;
export const MAX_MEMORY_TIMEOUT_MS = 30000;
export const DEFAULT_MEMORY_EXTRACT_TIMEOUT_MS = 120000;
export const MIN_MEMORY_EXTRACT_TIMEOUT_MS = 5000;
export const MAX_MEMORY_EXTRACT_TIMEOUT_MS = 300000;
export const DEFAULT_MEMORY_MAX_RESPONSE_BYTES = 65536;
export const MIN_MEMORY_MAX_RESPONSE_BYTES = 4096;
export const MAX_MEMORY_MAX_RESPONSE_BYTES = 1048576;
export const DEFAULT_MEMORY_RECALL_LIMIT = 5;
export const MAX_MEMORY_RECALL_LIMIT = 8;
export const DEFAULT_MEMORY_IDLE_MS = 30000;
export const MIN_MEMORY_IDLE_MS = 5000;
export const MAX_MEMORY_IDLE_MS = 300000;

function requireAbsolutePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4096 ||
    value.includes("\0") ||
    !isAbsolute(value)
  ) {
    throw configError("memory executable/entry/config must be absolute paths");
  }
  return value;
}

function requireMemoryScope(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256) {
    throw configError("memory scope must be 1..256 chars");
  }
  for (const unit of value) {
    const code = unit.codePointAt(0) ?? 0;
    if ((code >= 0x00 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f)) {
      throw configError("memory scope must not contain controls");
    }
  }
  return value;
}

function requireBoundedInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  what: string,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw configError(`${what} must be an integer`);
  }
  if (value < min || value > max) {
    throw configError(`${what} is out of bounds`);
  }
  return value;
}

export function parseMemoryConfig(
  raw: string | undefined,
): MemoryConfig | null {
  if (raw === undefined) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw configError("memory config must be a JSON object");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw configError("memory config must be a JSON object");
  }
  const keys = Object.keys(parsed);
  for (const key of keys) {
    if (
      key !== "executable" &&
      key !== "entry" &&
      key !== "config" &&
      key !== "scope" &&
      key !== "timeoutMs" &&
      key !== "extractTimeoutMs" &&
      key !== "maxResponseBytes" &&
      key !== "recallLimit" &&
      key !== "idleMs"
    ) {
      throw configError("memory config has an unknown key");
    }
  }
  const record = parsed as {
    executable?: unknown;
    entry?: unknown;
    config?: unknown;
    scope?: unknown;
    timeoutMs?: unknown;
    extractTimeoutMs?: unknown;
    maxResponseBytes?: unknown;
    recallLimit?: unknown;
    idleMs?: unknown;
  };
  const executable = requireAbsolutePath(record.executable);
  const entry = requireAbsolutePath(record.entry);
  const configPath = requireAbsolutePath(record.config);
  const scope = requireMemoryScope(record.scope);
  const timeoutMs = requireBoundedInt(
    record.timeoutMs,
    DEFAULT_MEMORY_TIMEOUT_MS,
    MIN_MEMORY_TIMEOUT_MS,
    MAX_MEMORY_TIMEOUT_MS,
    "memory timeoutMs",
  );
  const extractTimeoutMs = requireBoundedInt(
    record.extractTimeoutMs,
    DEFAULT_MEMORY_EXTRACT_TIMEOUT_MS,
    MIN_MEMORY_EXTRACT_TIMEOUT_MS,
    MAX_MEMORY_EXTRACT_TIMEOUT_MS,
    "memory extractTimeoutMs",
  );
  const maxResponseBytes = requireBoundedInt(
    record.maxResponseBytes,
    DEFAULT_MEMORY_MAX_RESPONSE_BYTES,
    MIN_MEMORY_MAX_RESPONSE_BYTES,
    MAX_MEMORY_MAX_RESPONSE_BYTES,
    "memory maxResponseBytes",
  );
  const recallLimit = requireBoundedInt(
    record.recallLimit,
    DEFAULT_MEMORY_RECALL_LIMIT,
    1,
    MAX_MEMORY_RECALL_LIMIT,
    "memory recallLimit",
  );
  const idleMs = requireBoundedInt(
    record.idleMs,
    DEFAULT_MEMORY_IDLE_MS,
    MIN_MEMORY_IDLE_MS,
    MAX_MEMORY_IDLE_MS,
    "memory idleMs",
  );
  return Object.freeze({
    executable,
    entry,
    config: configPath,
    scope,
    timeoutMs,
    extractTimeoutMs,
    maxResponseBytes,
    recallLimit,
    idleMs,
  });
}

/**
 * Strict opt-in trial proposal/approval surface config (frozen profile
 * snapshot + workspace alias, deep-frozen). Unset (default) means trials
 * disabled. No defaults for caps/checks: every field is required and must
 * satisfy the TrialProfileSnapshotSchema bounds from
 * packages/contracts/src/trial_authority.ts, plus the workspace alias
 * wire rule (`/^[a-z0-9_-]{1,64}$/`).
 *
 * - Env `COMPANION_AUTONOMY_JSON` is strict JSON only; unset means null.
 * - Must be an exact object with only the ten snapshot/alias fields below;
 *   any unknown key fails closed (a request body can never smuggle a
 *   `profile`/`workspaceAlias` override through this config either).
 * - Failures carry fixed messages only: no values escape.
 * - The returned object (including the checks array) is deep-frozen.
 */
export interface TrialRunnerRelayCapsConfig {
  readonly maxRequestBytes: number;
  readonly maxModelCalls: number;
  readonly maxOutputTokens: number;
  readonly maxResponseBytes: number;
  readonly perCallTimeoutMs: number;
  readonly maxConcurrent: number;
}

export interface TrialRunnerObserveConfig {
  readonly activeTimeoutMs: number;
  readonly goneTimeoutMs: number;
  readonly pollIntervalMs: number;
}

export interface TrialRunnerHostConfig {
  readonly nodeRealpath: string;
  readonly bridgeScriptPath: string;
  readonly bridgeConfigTemplatePath: string;
  readonly systemctlRealpath: string;
  readonly xdgRuntimeDir: string;
  readonly relay: TrialRunnerRelayCapsConfig;
  readonly observe: TrialRunnerObserveConfig;
  readonly pollMs: number;
}

export interface TrialConfig {
  /** Snapshot: profile data is available for new grants. */
  readonly available: boolean;
  /** Snapshot: profile is enabled for new grants. */
  readonly enabled: boolean;
  /** Mandatory checks: strict non-empty unique operator set, no defaults. */
  readonly mandatoryChecks: readonly string[];
  /** 64 lowercase hex config fingerprint. */
  readonly configFingerprint: string;
  /** 40 lowercase hex source revision. */
  readonly sourceRevision: string;
  /** Current model identifier (1..256 chars). */
  readonly currentModel: string;
  /** Whole-repo READ disclosure attested. */
  readonly disclosedWholeRepoRead: boolean;
  /** Explicit operator timeout cap in ms (no default). */
  readonly timeoutMs: number;
  /** Explicit operator output cap in bytes (no default). */
  readonly maxOutputBytes: number;
  /** Frozen workspace alias under which proposals stage/approve. */
  readonly workspaceAlias: string;
  /** Required root-side runner host config (no defaults, absolute paths). */
  readonly runner: TrialRunnerHostConfig;
}

const TRIAL_CHECK_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const TRIAL_ALIAS_PATTERN = /^[a-z0-9_-]{1,64}$/;

function requireRunnerAbsolutePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4096 ||
    value.includes("\0") ||
    !isAbsolute(value)
  ) {
    throw configError("trial runner path must be absolute");
  }
  return value;
}

function requireRunnerInt(
  value: unknown,
  min: number,
  max: number,
  what: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw configError(what);
  }
  return value;
}

function parseTrialRunnerConfig(raw: unknown): TrialRunnerHostConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw configError("trial runner config is invalid");
  }
  const keys = Object.keys(raw);
  for (const key of keys) {
    if (
      key !== "nodeRealpath" &&
      key !== "bridgeScriptPath" &&
      key !== "bridgeConfigTemplatePath" &&
      key !== "systemctlRealpath" &&
      key !== "xdgRuntimeDir" &&
      key !== "relay" &&
      key !== "observe" &&
      key !== "pollMs"
    ) {
      throw configError("trial runner config has an unknown key");
    }
  }
  const record = raw as {
    nodeRealpath?: unknown;
    bridgeScriptPath?: unknown;
    bridgeConfigTemplatePath?: unknown;
    systemctlRealpath?: unknown;
    xdgRuntimeDir?: unknown;
    relay?: unknown;
    observe?: unknown;
    pollMs?: unknown;
  };
  const nodeRealpath = requireRunnerAbsolutePath(record.nodeRealpath);
  const bridgeScriptPath = requireRunnerAbsolutePath(record.bridgeScriptPath);
  const bridgeConfigTemplatePath = requireRunnerAbsolutePath(
    record.bridgeConfigTemplatePath,
  );
  const systemctlRealpath = requireRunnerAbsolutePath(record.systemctlRealpath);
  const xdgRuntimeDir = requireRunnerAbsolutePath(record.xdgRuntimeDir);
  const relayRaw = record.relay;
  if (
    typeof relayRaw !== "object" ||
    relayRaw === null ||
    Array.isArray(relayRaw)
  ) {
    throw configError("trial runner relay caps are invalid");
  }
  for (const key of Object.keys(relayRaw)) {
    if (
      key !== "maxRequestBytes" &&
      key !== "maxModelCalls" &&
      key !== "maxOutputTokens" &&
      key !== "maxResponseBytes" &&
      key !== "perCallTimeoutMs" &&
      key !== "maxConcurrent"
    ) {
      throw configError("trial runner relay caps have an unknown key");
    }
  }
  const relayRecord = relayRaw as Record<string, unknown>;
  const relay: TrialRunnerRelayCapsConfig = Object.freeze({
    maxRequestBytes: requireRunnerInt(
      relayRecord.maxRequestBytes,
      1024,
      16777216,
      "trial runner relay caps are invalid",
    ),
    maxModelCalls: requireRunnerInt(
      relayRecord.maxModelCalls,
      1,
      64,
      "trial runner relay caps are invalid",
    ),
    maxOutputTokens: requireRunnerInt(
      relayRecord.maxOutputTokens,
      1,
      32768,
      "trial runner relay caps are invalid",
    ),
    maxResponseBytes: requireRunnerInt(
      relayRecord.maxResponseBytes,
      1024,
      GATEWAY_MAX_RESPONSE_BYTES,
      "trial runner relay caps are invalid",
    ),
    perCallTimeoutMs: requireRunnerInt(
      relayRecord.perCallTimeoutMs,
      100,
      60000,
      "trial runner relay caps are invalid",
    ),
    maxConcurrent: requireRunnerInt(
      relayRecord.maxConcurrent,
      1,
      16,
      "trial runner relay caps are invalid",
    ),
  });
  const observeRaw = record.observe;
  if (
    typeof observeRaw !== "object" ||
    observeRaw === null ||
    Array.isArray(observeRaw)
  ) {
    throw configError("trial runner observe timeouts are invalid");
  }
  for (const key of Object.keys(observeRaw)) {
    if (
      key !== "activeTimeoutMs" &&
      key !== "goneTimeoutMs" &&
      key !== "pollIntervalMs"
    ) {
      throw configError("trial runner observe timeouts have an unknown key");
    }
  }
  const observeRecord = observeRaw as Record<string, unknown>;
  const observe: TrialRunnerObserveConfig = Object.freeze({
    activeTimeoutMs: requireRunnerInt(
      observeRecord.activeTimeoutMs,
      500,
      120000,
      "trial runner observe timeouts are invalid",
    ),
    goneTimeoutMs: requireRunnerInt(
      observeRecord.goneTimeoutMs,
      500,
      120000,
      "trial runner observe timeouts are invalid",
    ),
    pollIntervalMs: requireRunnerInt(
      observeRecord.pollIntervalMs,
      5,
      5000,
      "trial runner observe timeouts are invalid",
    ),
  });
  const pollMs = requireRunnerInt(
    record.pollMs,
    100,
    60000,
    "trial runner poll interval is invalid",
  );
  return Object.freeze({
    nodeRealpath,
    bridgeScriptPath,
    bridgeConfigTemplatePath,
    systemctlRealpath,
    xdgRuntimeDir,
    relay,
    observe,
    pollMs,
  });
}

export function parseTrialConfig(raw: string | undefined): TrialConfig | null {
  if (raw === undefined) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw configError("trial config must be a JSON object");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw configError("trial config must be a JSON object");
  }
  const keys = Object.keys(parsed);
  for (const key of keys) {
    if (
      key !== "available" &&
      key !== "enabled" &&
      key !== "mandatoryChecks" &&
      key !== "configFingerprint" &&
      key !== "sourceRevision" &&
      key !== "currentModel" &&
      key !== "disclosedWholeRepoRead" &&
      key !== "timeoutMs" &&
      key !== "maxOutputBytes" &&
      key !== "workspaceAlias" &&
      key !== "runner"
    ) {
      throw configError("trial config has an unknown key");
    }
  }
  const record = parsed as {
    available?: unknown;
    enabled?: unknown;
    mandatoryChecks?: unknown;
    configFingerprint?: unknown;
    sourceRevision?: unknown;
    currentModel?: unknown;
    disclosedWholeRepoRead?: unknown;
    timeoutMs?: unknown;
    maxOutputBytes?: unknown;
    workspaceAlias?: unknown;
    runner?: unknown;
  };
  if (typeof record.available !== "boolean") {
    throw configError("trial config availability is invalid");
  }
  if (typeof record.enabled !== "boolean") {
    throw configError("trial config availability is invalid");
  }
  if (
    !Array.isArray(record.mandatoryChecks) ||
    record.mandatoryChecks.length < 1 ||
    record.mandatoryChecks.length > 16
  ) {
    throw configError("trial config mandatory checks are invalid");
  }
  const checks: string[] = [];
  const seen = new Set<string>();
  for (const entry of record.mandatoryChecks) {
    if (
      typeof entry !== "string" ||
      entry.length < 1 ||
      entry.length > 64 ||
      !TRIAL_CHECK_PATTERN.test(entry)
    ) {
      throw configError("trial config mandatory checks are invalid");
    }
    if (seen.has(entry)) {
      throw configError("trial config mandatory checks are invalid");
    }
    seen.add(entry);
    checks.push(entry);
  }
  if (
    typeof record.configFingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.configFingerprint)
  ) {
    throw configError("trial config fingerprint is invalid");
  }
  if (
    typeof record.sourceRevision !== "string" ||
    !/^[0-9a-f]{40}$/.test(record.sourceRevision)
  ) {
    throw configError("trial config source revision is invalid");
  }
  if (
    typeof record.currentModel !== "string" ||
    record.currentModel.length < 1 ||
    record.currentModel.length > 256 ||
    record.currentModel.includes("\0")
  ) {
    throw configError("trial config model is invalid");
  }
  if (typeof record.disclosedWholeRepoRead !== "boolean") {
    throw configError("trial config disclosure flag is invalid");
  }
  if (
    typeof record.timeoutMs !== "number" ||
    !Number.isInteger(record.timeoutMs) ||
    record.timeoutMs < 1000 ||
    record.timeoutMs > 3600000
  ) {
    throw configError("trial config timeout is invalid");
  }
  if (
    typeof record.maxOutputBytes !== "number" ||
    !Number.isInteger(record.maxOutputBytes) ||
    record.maxOutputBytes < 1024 ||
    record.maxOutputBytes > 268435456
  ) {
    throw configError("trial config output cap is invalid");
  }
  if (
    typeof record.workspaceAlias !== "string" ||
    !TRIAL_ALIAS_PATTERN.test(record.workspaceAlias)
  ) {
    throw configError("trial config workspace alias is invalid");
  }
  if (record.runner === undefined) {
    throw configError("trial config runner is required");
  }
  const runner = parseTrialRunnerConfig(record.runner);
  return Object.freeze({
    available: record.available,
    enabled: record.enabled,
    mandatoryChecks: Object.freeze(checks),
    configFingerprint: record.configFingerprint,
    sourceRevision: record.sourceRevision,
    currentModel: record.currentModel,
    disclosedWholeRepoRead: record.disclosedWholeRepoRead,
    timeoutMs: record.timeoutMs,
    maxOutputBytes: record.maxOutputBytes,
    workspaceAlias: record.workspaceAlias,
    runner,
  });
}

/**
 * Load + freeze the server config from the environment. Never logs paths,
 * secrets, or raw values: failures carry a fixed code only.
 */
export function loadServerConfig(
  env: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  const hostRaw = env.COMPANION_HOST ?? DEFAULT_HOST;
  const host = HostSchema.safeParse(hostRaw);
  if (!host.success) {
    throw configError("bind host must be 127.0.0.1 or localhost");
  }
  let port: number;
  try {
    port = parsePort(env.COMPANION_PORT);
  } catch (error) {
    if (error instanceof ServerConfigError) {
      throw error;
    }
    throw configError("port must be an integer 0..65535");
  }
  const timeZone = env.COMPANION_TIME_ZONE ?? DEFAULT_TIME_ZONE;
  if (!isIanaTimeZone(timeZone)) {
    throw configError("time zone must be a valid IANA time zone name");
  }
  const levelRaw = env.COMPANION_LOG_LEVEL ?? DEFAULT_LOG_LEVEL;
  const logLevel = LogLevelSchema.safeParse(levelRaw);
  if (!logLevel.success) {
    throw configError("log level must be debug, info, warn, or error");
  }
  const dbRaw = env.COMPANION_DB_PATH ?? defaultDbPath();
  if (dbRaw.length === 0 || dbRaw.length > 4096) {
    throw configError("database path has an invalid length");
  }
  const dbPath = isAbsolute(dbRaw) ? dbRaw : resolve(dbRaw);
  assertDbPathHasNoSymlink(dbPath);
  const markdownRoots = parseMarkdownRoots(env.COMPANION_MARKDOWN_ROOTS_JSON);
  const model = parseModelConfig(env.COMPANION_MODEL_JSON);
  const calendar = parseCalendarConfig(env.COMPANION_CALENDAR_JSON);
  const actions = parseActionConfig(env.COMPANION_ACTIONS_JSON);
  let webSearch: WebSearchConfig;
  try {
    webSearch = Object.freeze(
      parseWebSearchConfig(env.COMPANION_WEB_SEARCH_JSON) as WebSearchConfig,
    );
  } catch {
    throw configError("web search config is invalid");
  }
  const memory = parseMemoryConfig(env.COMPANION_MEMORY_JSON);
  const executionRecords = parseExecutionRecordsConfig(
    env.COMPANION_EXECUTION_RECORDS_JSON,
  );
  const remote = parseRemoteConfig(env.COMPANION_REMOTE_JSON);
  if (remote.enabled && remote.allowedOrigins.length === 0) {
    throw configError(
      "remote origin allowlist must not be empty when remote mode is enabled",
    );
  }
  if (remote.enabled && remote.passwordFile === null) {
    throw configError(
      "remote mode requires a password file (set one with the set-password command)",
    );
  }
  const trial = parseTrialConfig(env.COMPANION_AUTONOMY_JSON);
  if (trial !== null && model === null) {
    throw configError("trial config requires model config");
  }
  const parsed = ServerConfigSchema.safeParse({
    dbPath,
    host: host.data,
    port,
    timeZone,
    logLevel: logLevel.data,
  });
  if (!parsed.success) {
    throw configError("server configuration failed validation");
  }
  return Object.freeze({
    dbPath: parsed.data.dbPath,
    host: parsed.data.host,
    port: parsed.data.port,
    timeZone: parsed.data.timeZone,
    logLevel: parsed.data.logLevel,
    markdownRoots,
    model,
    calendar,
    actions,
    webSearch,
    memory,
    executionRecords,
    remote,
    trial,
  });
}
