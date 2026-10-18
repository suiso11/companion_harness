// Slice (b) single-user password store (design §3).
//
// - The password HASH lives in a file OUTSIDE SQLite (path from the remote
//   config `passwordFile`, required when remote mode is enabled). The hash
//   is NEVER stored in SQLite and the password NEVER travels via env/argv:
//   it is read from TTY/stdin only (see cli.ts `set-password`).
// - Hashing uses Node built-in crypto.scrypt (no new native dep) with a
//   random 128-bit salt; params travel with the hash. Verification is a
//   constant-time compare.
// - File guard (fail closed): the file must exist, be a regular file, fit
//   a byte cap, parse as the exact record shape, and — on POSIX — must not
//   be readable by group/other (mode 0600 enforced: any group/other access
//   bit refuses startup/login). All failures carry fixed messages only.

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { ServerConfigError } from "./config.js";

const PASSWORD_FILE_VERSION = 1;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LEN = 32;
const SALT_BYTES = 16;
/** Upper bound for the password file on disk (a small JSON record). */
export const MAX_PASSWORD_FILE_BYTES = 64 * 1024;
/** Password policy for `set-password` (and login acceptance bounds). */
export const MIN_PASSWORD_CHARS = 8;
export const MAX_PASSWORD_CHARS = 1024;

export interface RemotePasswordRecord {
  readonly version: 1;
  readonly algo: "scrypt";
  readonly n: number;
  readonly r: number;
  readonly p: number;
  readonly keyLen: number;
  readonly saltB64: string;
  readonly hashB64: string;
}

function passwordError(message: string): ServerConfigError {
  return new ServerConfigError(message);
}

export function assertPasswordUsable(password: string): void {
  if (
    typeof password !== "string" ||
    password.length < MIN_PASSWORD_CHARS ||
    password.length > MAX_PASSWORD_CHARS
  ) {
    throw passwordError("password must be 8..1024 characters");
  }
}

/** Create a fresh password-file JSON record (for `set-password`). */
export function createPasswordFileContent(password: string): string {
  assertPasswordUsable(password);
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(password, salt, SCRYPT_KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  const record: RemotePasswordRecord = {
    version: PASSWORD_FILE_VERSION,
    algo: "scrypt",
    n: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    keyLen: SCRYPT_KEY_LEN,
    saltB64: salt.toString("base64"),
    hashB64: hash.toString("base64"),
  };
  return `${JSON.stringify(record)}\n`;
}

function parsePasswordRecord(text: string): RemotePasswordRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw passwordError("remote password file is invalid");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw passwordError("remote password file is invalid");
  }
  const keys = Object.keys(parsed);
  for (const key of keys) {
    if (
      key !== "version" &&
      key !== "algo" &&
      key !== "n" &&
      key !== "r" &&
      key !== "p" &&
      key !== "keyLen" &&
      key !== "saltB64" &&
      key !== "hashB64"
    ) {
      throw passwordError("remote password file is invalid");
    }
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== PASSWORD_FILE_VERSION || record.algo !== "scrypt") {
    throw passwordError("remote password file is invalid");
  }
  if (
    record.n !== SCRYPT_N ||
    record.r !== SCRYPT_R ||
    record.p !== SCRYPT_P ||
    record.keyLen !== SCRYPT_KEY_LEN
  ) {
    throw passwordError("remote password file is invalid");
  }
  if (
    typeof record.saltB64 !== "string" ||
    typeof record.hashB64 !== "string"
  ) {
    throw passwordError("remote password file is invalid");
  }
  let salt: Buffer;
  let hash: Buffer;
  try {
    salt = Buffer.from(record.saltB64, "base64");
    hash = Buffer.from(record.hashB64, "base64");
  } catch {
    throw passwordError("remote password file is invalid");
  }
  if (salt.byteLength !== SALT_BYTES || hash.byteLength !== SCRYPT_KEY_LEN) {
    throw passwordError("remote password file is invalid");
  }
  return {
    version: 1,
    algo: "scrypt",
    n: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    keyLen: SCRYPT_KEY_LEN,
    saltB64: record.saltB64,
    hashB64: record.hashB64,
  };
}

/**
 * Fail-closed file guard: regular file, byte cap, exact record shape, and
 * POSIX 0600 (any group/other access bit refuses). Fixed messages only.
 */
export function checkPasswordFileStat(path: string): void {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch {
    throw passwordError("remote password file is not accessible");
  }
  if (!stat.isFile()) {
    throw passwordError("remote password file is invalid");
  }
  if (stat.size <= 0 || stat.size > MAX_PASSWORD_FILE_BYTES) {
    throw passwordError("remote password file is invalid");
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw passwordError("remote password file permissions are invalid");
  }
}

/** Load + validate the password record (guard first, then parse). */
export async function loadRemotePasswordRecord(
  path: string,
): Promise<RemotePasswordRecord> {
  checkPasswordFileStat(path);
  let text: string;
  try {
    const data = await readFile(path);
    if (data.byteLength > MAX_PASSWORD_FILE_BYTES) {
      throw passwordError("remote password file is invalid");
    }
    text = data.toString("utf-8");
  } catch (error) {
    if (error instanceof ServerConfigError) {
      throw error;
    }
    throw passwordError("remote password file is not accessible");
  }
  return parsePasswordRecord(text);
}

/** Synchronous variant for the login hot path (same guards). */
export function loadRemotePasswordRecordSync(
  path: string,
): RemotePasswordRecord {
  checkPasswordFileStat(path);
  let text: string;
  try {
    const data = readFileSyncStrict(path);
    text = data;
  } catch (error) {
    if (error instanceof ServerConfigError) {
      throw error;
    }
    throw passwordError("remote password file is not accessible");
  }
  return parsePasswordRecord(text);
}

function readFileSyncStrict(path: string): string {
  const data = readFileSync(path);
  if (data.byteLength > MAX_PASSWORD_FILE_BYTES) {
    throw passwordError("remote password file is invalid");
  }
  return data.toString("utf-8");
}

/**
 * Constant-time password verification against a parsed record. Returns
 * false (never throws) on any mismatch so callers can keep a uniform
 * failure message.
 */
export function verifyPasswordAgainstRecord(
  password: string,
  record: RemotePasswordRecord,
): boolean {
  if (
    typeof password !== "string" ||
    password.length === 0 ||
    password.length > MAX_PASSWORD_CHARS
  ) {
    return false;
  }
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(record.saltB64, "base64");
    expected = Buffer.from(record.hashB64, "base64");
  } catch {
    return false;
  }
  if (
    salt.byteLength !== SALT_BYTES ||
    expected.byteLength !== SCRYPT_KEY_LEN
  ) {
    return false;
  }
  let derived: Buffer;
  try {
    derived = scryptSync(password, salt, SCRYPT_KEY_LEN, {
      N: record.n,
      r: record.r,
      p: record.p,
    });
  } catch {
    return false;
  }
  if (derived.byteLength !== expected.byteLength) {
    return false;
  }
  try {
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}
