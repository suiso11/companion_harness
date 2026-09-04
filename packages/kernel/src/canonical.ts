// Canonical JSON + domain-separated request hashing (M0 §9 blocker 7.7).
//
// - Canonical form: object keys sorted recursively (UTF-16 code-unit order
//   via direct string comparison), array order preserved, no whitespace.
// - `undefined` values and function/symbol values are dropped from objects
//   (matching JSON.stringify object semantics); a top-level `undefined`
//   behaves like JSON.stringify and yields `undefined`.
// - Request hash input: "<operation>:<schemaVersion>:<canonicalPayload>"
//   (operation/version domain separation), SHA-256 hex.

import { createHash, randomUUID } from "node:crypto";

type JsonObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function canonicalize(value: unknown): unknown {
  if (value === null) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }
  if (isPlainObject(value)) {
    const sorted: JsonObject = {};
    for (const key of Object.keys(value).sort()) {
      const entry = (value as JsonObject)[key];
      if (entry === undefined || typeof entry === "function" || typeof entry === "symbol") {
        continue;
      }
      sorted[key] = canonicalize(entry);
    }
    return sorted;
  }
  return value;
}

/**
 * Canonical JSON string for hashing/comparison.
 * Returns `undefined` only when the top-level value is `undefined`
 * (mirroring JSON.stringify).
 */
export function canonicalJson(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return JSON.stringify(canonicalize(value));
}

/** Canonical JSON that rejects top-level `undefined`. */
export function canonicalJsonString(value: unknown): string {
  const text = canonicalJson(value);
  if (text === undefined) {
    throw new TypeError("cannot canonicalize undefined");
  }
  return text;
}

/** SHA-256 hex digest of a UTF-8 string. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Domain-separated request hash: SHA-256 hex of
 * `<operation>:<schemaVersion>:<canonicalPayload>`.
 */
export function requestHash(
  operation: string,
  schemaVersion: number,
  payload: unknown,
): string {
  if (operation.length === 0) {
    throw new TypeError("operation must not be empty");
  }
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
    throw new TypeError("schemaVersion must be an integer >= 1");
  }
  return sha256Hex(`${operation}:${schemaVersion}:${canonicalJsonString(payload)}`);
}

/** Operation ids + schema versions used for M0 idempotency hashing. */
export const IDEMPOTENCY_OPERATIONS = {
  createSession: { operation: "create_session", schemaVersion: 1 },
  postMessage: { operation: "post_message", schemaVersion: 1 },
  postRetry: { operation: "post_retry", schemaVersion: 1 },
} as const;

/** Generate a new UUID v4 harness id. */
export function generateId(): string {
  return randomUUID();
}

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** True when `value` is a UUID whose version nibble is 4. */
export function isUuidV4(value: unknown): value is string {
  return typeof value === "string" && UUID_V4_RE.test(value);
}

/** Decode the version nibble of a UUID string, or null when malformed. */
export function uuidVersion(value: string): number | null {
  const match = /^[0-9a-f]{8}-[0-9a-f]{4}-([0-9a-f])[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i.exec(
    value,
  );
  if (match?.[1] === undefined) {
    return null;
  }
  return Number.parseInt(match[1] as string, 16);
}

/** Throw when `value` is not a UUID v4. Returns the value for chaining. */
export function assertUuidV4(value: unknown, what = "id"): string {
  if (!isUuidV4(value)) {
    throw new TypeError(`${what} must be a UUID v4`);
  }
  return value as string;
}
