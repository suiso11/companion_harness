import { z } from "zod";
import { UuidSchema } from "./ids.js";

/**
 * User-facing text bound in Unicode code points (not UTF-16 units): Zod
 * `.max()` counts UTF-16 code units and would reject valid astral-plane
 * input (e.g. 300 emoji against a 500-code-point limit). Server storage
 * enforces the same code-point budgets.
 */
function codePointsMax(maxCp: number): (value: string) => boolean {
  return (value: string): boolean => Array.from(value).length <= maxCp;
}

/** Opaque session-scoped memory handle (`m1..mN`, never a raw record id). */
export const MemoryHandleSchema = z
  .string()
  .regex(/^m[1-9][0-9]*$/)
  .max(32);
export type MemoryHandle = z.infer<typeof MemoryHandleSchema>;

export const MemoryHitSchema = z.strictObject({
  handle: MemoryHandleSchema,
  snippet: z
    .string()
    .min(1)
    .refine(codePointsMax(512), { message: "snippet over 512 code points" }),
  status: z.enum(["active", "retired"]),
});
export type MemoryHit = z.infer<typeof MemoryHitSchema>;

/** POST .../memory/search request: explicit user-directed query only. */
export const MemorySearchRequestSchema = z.strictObject({
  query: z
    .string()
    .min(1)
    .refine(codePointsMax(500), { message: "query over 500 code points" }),
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
    snippet: z
      .string()
      .min(1)
      .refine(codePointsMax(512), { message: "snippet over 512 code points" }),
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
  correctionBody: z
    .string()
    .min(1)
    .refine(codePointsMax(2000), {
      message: "correctionBody over 2000 code points",
    })
    .optional(),
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

/**
 * GET per-run recall exposure: the exact snippet the model saw as `mN`
 * during one run (answer-citation drawer). Raw record/recall ids never
 * cross this boundary.
 */
export const MemoryRecallExposureResponseSchema = z.strictObject({
  runId: UuidSchema,
  citation: MemoryHandleSchema,
  snippet: z
    .string()
    .min(1)
    .refine(codePointsMax(512), { message: "snippet over 512 code points" }),
});
export type MemoryRecallExposureResponse = z.infer<
  typeof MemoryRecallExposureResponseSchema
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
