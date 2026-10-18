// Slice (b) remote login sessions (design §3).
//
// - Session tokens are opaque 256-bit random values (hex) sent ONLY in the
//   `companion_remote` cookie (HttpOnly; Secure; SameSite=Strict; Path=/).
//   The server stores ONLY the SHA-256 hex of the token in SQLite
//   (`remote_sessions`, additive migration 0023): the token itself never
//   touches the DB or logs, so a DB read alone cannot impersonate anyone.
// - Absolute expiry + idle timeout come from the remote config (案 defaults
//   30d / 7d). Every authenticated use refreshes `last_seen_at`.
// - Rate limiting is a GLOBAL failed-attempt counter (never keyed by IP:
//   all proxied requests arrive from 127.0.0.1, so an IP key would lock out
//   the single operator behind every failure — or never trigger). The
//   counter lives in memory and RESETS ON RESTART (documented in README);
//   SQLite persistence was considered and deliberately skipped: a restart
//   clearing a lockout is the fail-open-safe direction for a single-user
//   box, and it keeps the hot path free of extra writes.
// - Decisions use only Host/Origin/Sec-Fetch-Site/Cookie headers — never
//   remoteAddress or X-Forwarded-*.

import { createHash, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";

/** Session cookie name (fixed, never configurable). */
export const REMOTE_SESSION_COOKIE = "companion_remote" as const;
/** 256-bit random token, hex-encoded (64 chars). */
export const REMOTE_TOKEN_BYTES = 32;

export interface RemoteSessionRow {
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly expiresAt: number;
}

export interface RemoteSessionStore {
  create(tokenHashHex: string, createdAt: number, expiresAt: number): void;
  lookup(tokenHashHex: string): RemoteSessionRow | null;
  touch(tokenHashHex: string, lastSeenAt: number): void;
  revoke(tokenHashHex: string): void;
}

/** SHA-256 hex of the opaque token (what is stored/compared). */
export function hashRemoteToken(tokenHex: string): string {
  return createHash("sha256").update(tokenHex, "utf-8").digest("hex");
}

/** Issue a fresh 256-bit hex token (caller hashes before storing). */
export function issueRemoteToken(): string {
  return randomBytes(REMOTE_TOKEN_BYTES).toString("hex");
}

function isHex64(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

export function createSqliteRemoteSessionStore(
  db: Database.Database,
): RemoteSessionStore {
  const insert = db.prepare(
    "INSERT INTO remote_sessions (token_hash, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?)",
  );
  const select = db.prepare(
    "SELECT created_at AS createdAt, last_seen_at AS lastSeenAt, expires_at AS expiresAt FROM remote_sessions WHERE token_hash = ?",
  );
  const update = db.prepare(
    "UPDATE remote_sessions SET last_seen_at = ? WHERE token_hash = ?",
  );
  const remove = db.prepare("DELETE FROM remote_sessions WHERE token_hash = ?");
  return {
    create(tokenHashHex, createdAt, expiresAt) {
      if (!isHex64(tokenHashHex)) {
        throw new Error("remote session token hash is invalid");
      }
      insert.run(tokenHashHex, createdAt, createdAt, expiresAt);
    },
    lookup(tokenHashHex) {
      if (!isHex64(tokenHashHex)) {
        return null;
      }
      const row = select.get(tokenHashHex) as
        | { createdAt: number; lastSeenAt: number; expiresAt: number }
        | undefined;
      if (row === undefined) {
        return null;
      }
      return {
        createdAt: row.createdAt,
        lastSeenAt: row.lastSeenAt,
        expiresAt: row.expiresAt,
      };
    },
    touch(tokenHashHex, lastSeenAt) {
      if (!isHex64(tokenHashHex)) {
        return;
      }
      update.run(lastSeenAt, tokenHashHex);
    },
    revoke(tokenHashHex) {
      if (!isHex64(tokenHashHex)) {
        return;
      }
      remove.run(tokenHashHex);
    },
  };
}

/** In-memory store (tests / disabled-mode placeholder; never production). */
export function createMemoryRemoteSessionStore(): RemoteSessionStore & {
  readonly size: number;
} {
  const rows = new Map<string, RemoteSessionRow>();
  return {
    get size() {
      return rows.size;
    },
    create(tokenHashHex, createdAt, expiresAt) {
      rows.set(tokenHashHex, {
        createdAt,
        lastSeenAt: createdAt,
        expiresAt,
      });
    },
    lookup(tokenHashHex) {
      return rows.get(tokenHashHex) ?? null;
    },
    touch(tokenHashHex, lastSeenAt) {
      const row = rows.get(tokenHashHex);
      if (row !== undefined) {
        rows.set(tokenHashHex, { ...row, lastSeenAt });
      }
    },
    revoke(tokenHashHex) {
      rows.delete(tokenHashHex);
    },
  };
}

export interface RemoteLoginRateLimiter {
  /** True while the global lockout is in force. */
  isLocked(now: number): boolean;
  /** Record one failed attempt; returns true when this failure locks. */
  recordFailure(now: number): boolean;
  /** Clear failures + lockout (called on any successful login). */
  reset(): void;
}

/**
 * Global failed-attempt counter with lockout (design §3, 案 defaults
 * 5 failures → 15 min). In-memory only: resets on restart.
 */
export function createRemoteLoginRateLimiter(options: {
  maxFailures: number;
  lockoutMs: number;
}): RemoteLoginRateLimiter {
  let failures = 0;
  let lockedUntil = 0;
  return {
    isLocked(now: number): boolean {
      return now < lockedUntil;
    },
    recordFailure(now: number): boolean {
      failures += 1;
      if (failures >= options.maxFailures) {
        failures = 0;
        lockedUntil = now + options.lockoutMs;
        return true;
      }
      return false;
    },
    reset(): void {
      failures = 0;
      lockedUntil = 0;
    },
  };
}

/** Extract the session token from a Cookie header (fixed name only). */
export function remoteTokenFromCookieHeader(
  header: string | undefined,
): string | null {
  if (header === undefined || header.length > 4096) {
    return null;
  }
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) {
      continue;
    }
    const name = part.slice(0, index).trim();
    if (name !== REMOTE_SESSION_COOKIE) {
      continue;
    }
    const value = part.slice(index + 1).trim();
    if (!isHex64(value)) {
      return null;
    }
    return value;
  }
  return null;
}

/** `Set-Cookie` value for an issued session (flags per design §3). */
export function remoteSessionSetCookie(
  tokenHex: string,
  maxAgeSec: number,
): string {
  return (
    `${REMOTE_SESSION_COOKIE}=${tokenHex}; Path=/; HttpOnly; ` +
    `Secure; SameSite=Strict; Max-Age=${maxAgeSec}`
  );
}

/** `Set-Cookie` value that clears the session cookie. */
export function remoteSessionClearCookie(): string {
  return (
    `${REMOTE_SESSION_COOKIE}=; Path=/; HttpOnly; ` +
    `Secure; SameSite=Strict; Max-Age=0`
  );
}
