// M0 server config (plan §9 blocker 7.9, §19.6).
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

const ServerConfigSchema = z.strictObject({
  dbPath: z.string().min(1).max(4096),
  host: HostSchema,
  port: z.number().int().min(0).max(65535),
  timeZone: z.string().min(1).max(128),
  logLevel: LogLevelSchema,
});

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
}

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
  });
}
