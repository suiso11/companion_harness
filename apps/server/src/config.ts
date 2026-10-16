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

export interface ServerConfig {
  readonly dbPath: string;
  readonly host: ServerHost;
  /** TCP port. 0 means an OS-assigned ephemeral port (tests only). */
  readonly port: number;
  /** Verified IANA time-zone name (Intl membership, not shape). */
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
  /** Strict opt-in remind memory config; null (unset) means memoryless. */
  readonly memory: MemoryConfig | null;
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
      key !== "apiKey"
    ) {
      throw configError("model config has an unknown key");
    }
  }
  const record = parsed as {
    adapter?: unknown;
    baseUrl?: unknown;
    model?: unknown;
    apiKey?: unknown;
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
        }
      : {
          adapter: record.adapter,
          baseUrl,
          model: record.model as string,
          apiKey: record.apiKey as string,
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
 *   scope, timeoutMs?, maxResponseBytes?, recallLimit?, idleMs? }`.
 * - `executable`: absolute path to the child-process binary (usually the
 *   Node.js binary that runs the remind CLI). `entry`: absolute path to
 *   the remind CLI script. `config`: absolute path to the remind startup
 *   config file the CLI opens. No shell is ever used; the child is
 *   spawned with `shell: false` and exactly `[entry, --config, config]`.
 * - `scope`: remind scope (1..256 chars, no control characters). All
 *   Companion CLI calls carry this scope; cross-scope records are
 *   rejected (FORBIDDEN_SCOPE) and never surfaced.
 * - `timeoutMs` (default 5000, bounds 500..30000): per-CLI-call deadline
 *   with hard kill afterwards. `maxResponseBytes` (default 65536, bounds
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
    value.includes(" ") ||
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
    maxResponseBytes,
    recallLimit,
    idleMs,
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
  const memory = parseMemoryConfig(env.COMPANION_MEMORY_JSON);
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
    memory,
  });
}
