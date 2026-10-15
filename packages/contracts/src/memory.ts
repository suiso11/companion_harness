import { z } from "zod";
import { UuidSchema } from "./ids.js";

/** Opaque session-scoped memory handle (`m1..mN`, never a raw record id). */
export const MemoryHandleSchema = z
  .string()
  .regex(/^m[1-9][0-9]*$/)
  .max(32);
export type MemoryHandle = z.infer<typeof MemoryHandleSchema>;

export const MemoryHitSchema = z.strictObject({
  handle: MemoryHandleSchema,
  snippet: z.string().min(1).max(512),
  status: z.enum(["active", "retired"]),
});
export type MemoryHit = z.infer<typeof MemoryHitSchema>;

/** POST .../memory/search request: explicit user-directed query only. */
export const MemorySearchRequestSchema = z.strictObject({
  query: z.string().min(1).max(500),
  limit: z.number().int().min(1).max(8).optional().default(5),
  runId: UuidSchema,
});
export type MemorySearchRequest = z.infer<typeof MemorySearchRequestSchema>;

export const MemorySearchResponseSchema = z.strictObject({
  searchId: z.string().min(1).max(256),
  hits: z.array(MemoryHitSchema).max(8),
});
export type MemorySearchResponse = z.infer<typeof MemorySearchResponseSchema>;

/** GET detail response: immutable cited snapshot vs live current record. */
export const MemoryDetailResponseSchema = z.strictObject({
  snapshot: z.strictObject({
    searchId: z.string().min(1).max(256),
    handle: MemoryHandleSchema,
    snippet: z.string().min(1).max(512),
    status: z.enum(["active", "retired"]),
  }),
  current: z.strictObject({
    body: z.string().min(1),
    kind: z.string().min(1),
    status: z.string().min(1),
    revision: z.number().int().min(1),
    source: z.string().min(1),
    observedAt: z.string().min(1),
    createdAt: z.string().min(1),
  }),
  stale: z.boolean(),
});
export type MemoryDetailResponse = z.infer<typeof MemoryDetailResponseSchema>;

/** POST .../memory/mutations request: exactly one explicit target. */
export const MemoryMutationRequestSchema = z.strictObject({
  kind: z.enum(["record.correct", "record.retire", "record.reactivate"]),
  searchId: z.string().min(1).max(256),
  handle: MemoryHandleSchema.optional(),
  correctionBody: z.string().min(1).max(2000).optional(),
  runId: UuidSchema,
});
export type MemoryMutationRequest = z.infer<typeof MemoryMutationRequestSchema>;

export const MemoryMutationResponseSchema = z.strictObject({
  operationId: UuidSchema,
  status: z.enum(["pending", "acked", "failed"]),
  deduplicated: z.boolean(),
});
export type MemoryMutationResponse = z.infer<
  typeof MemoryMutationResponseSchema
>;

/** GET operation response: durable 202-ack status (queued vs acked/error). */
export const MemoryOperationResponseSchema = z.strictObject({
  operationId: UuidSchema,
  kind: z.enum(["record.correct", "record.retire", "record.reactivate"]),
  recordRevision: z.number().int().min(1).nullable(),
  status: z.enum(["pending", "acked", "failed"]),
});
export type MemoryOperationResponse = z.infer<
  typeof MemoryOperationResponseSchema
>;

/** Fixed memory route error codes (lowercase, no values leak). */
export const MEMORY_ERROR_CODES = [
  "needs_clarification",
  "target_not_found",
  "state_conflict",
  "idempotency_key_reused",
  "memory_unavailable",
] as const;
export const MemoryErrorCodeSchema = z.enum(MEMORY_ERROR_CODES);
export type MemoryErrorCode = z.infer<typeof MemoryErrorCodeSchema>;
