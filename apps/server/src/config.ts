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
  });
}
