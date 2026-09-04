import { z } from "zod";

/**
 * RFC 4122 UUID v4, case-insensitive: version nibble `4`, variant `8/9/a/b`.
 * All harness-generated ids (sessions / turns / runs / tool_calls) and all
 * client idempotency keys must match this exact shape. UUID v1 / v7 / nil
 * and any malformed value are rejected.
 */
const UUID_V4_CORE =
  "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
export const UUID_V4_REGEX = new RegExp(`^${UUID_V4_CORE}$`, "i");

/** UUID v4 for all harness-generated ids (sessions / turns / runs / tool_calls). */
export const UuidSchema = z.string().regex(UUID_V4_REGEX, {
  message: "must be a UUID v4",
});
export type Uuid = z.infer<typeof UuidSchema>;

/** Client-generated idempotency key. Must be a UUID v4. */
export const IdempotencyKeySchema = z.string().regex(UUID_V4_REGEX, {
  message: "must be a UUID v4",
});
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
  const valid = UuidSchema.parse(sessionId);
  return `session:${valid}:message`;
}

export function retryScope(turnId: string): string {
  const valid = UuidSchema.parse(turnId);
  return `turn:${valid}:retry`;
}

/**
 * Closed M0 idempotency scopes (exactly three shapes). Parent ids embedded
 * in `session:*` / `turn:*` scopes must be exact UUID v4 values
 * (case-insensitive); UUID v1/v7/nil and malformed ids are rejected.
 * Unknown scope strings are rejected.
 */
export const IdempotencyScopeSchema = z.union([
  z.literal(IDEMPOTENCY_SCOPE_SESSIONS_CREATE),
  z
    .string()
    .regex(new RegExp(`^session:${UUID_V4_CORE}:message$`, "i"), {
      message: "session scope id must be a UUID v4",
    })
    .max(320),
  z
    .string()
    .regex(new RegExp(`^turn:${UUID_V4_CORE}:retry$`, "i"), {
      message: "turn scope id must be a UUID v4",
    })
    .max(320),
]);
export type IdempotencyScope = z.infer<typeof IdempotencyScopeSchema>;
