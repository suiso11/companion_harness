import { z } from "zod";

/** UUID v4 for all harness-generated ids (sessions / turns / runs / tool_calls). */
export const UuidSchema = z.uuid();
export type Uuid = z.infer<typeof UuidSchema>;

/** Client-generated idempotency key. Must be a UUID. */
export const IdempotencyKeySchema = z.uuid();
export type IdempotencyKey = z.infer<typeof IdempotencyKeySchema>;

/** Unix milliseconds (INTEGER in SQLite). */
export const UnixMsSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export type UnixMs = z.infer<typeof UnixMsSchema>;

/** SHA-256 hex digest (request_hash / args_hash / result_digest). */
export const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);
export type Sha256Hex = z.infer<typeof Sha256HexSchema>;

/** Idempotency scope separates parent resources (§9 blockers 4+7). */
export const IDEMPOTENCY_SCOPE_SESSIONS_CREATE = "sessions:create" as const;

export function messageScope(sessionId: string): string {
  return `session:${sessionId}:message`;
}

export function retryScope(turnId: string): string {
  return `turn:${turnId}:retry`;
}

/**
 * Closed shape (not closed vocabulary): the three M0 scopes only.
 * Unknown scope strings are rejected.
 */
export const IdempotencyScopeSchema = z.union([
  z.literal(IDEMPOTENCY_SCOPE_SESSIONS_CREATE),
  z.string().regex(/^session:[^:]+:message$/).max(320),
  z.string().regex(/^turn:[^:]+:retry$/).max(320),
]);
export type IdempotencyScope = z.infer<typeof IdempotencyScopeSchema>;
