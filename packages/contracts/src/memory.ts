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
  /** Remind record creation instant (canonical ISO-8601), when provided. */
  createdAt: z.string().min(20).max(30).optional(),
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
 * cross this boundary. I04: `revision`/`kind` are the provenance pinned
 * at exposure time (null = unknown/pre-I04); a record correction creates
 * a new revision and never rewrites this snapshot.
 */
export const MemoryRecallExposureResponseSchema = z.strictObject({
  runId: UuidSchema,
  citation: MemoryHandleSchema,
  snippet: z
    .string()
    .min(1)
    .refine(codePointsMax(512), { message: "snippet over 512 code points" }),
  revision: z.number().int().min(1).nullable(),
  kind: z
    .enum(["user_fact", "model_inference", "summary", "correction"])
    .nullable(),
});
export type MemoryRecallExposureResponse = z.infer<
  typeof MemoryRecallExposureResponseSchema
>;

/**
 * Conversation-memory graph (explicit read-only projection). Raw record ids
 * never cross this boundary: nodes/edges use the same opaque session-scoped
 * `mN` handles as search, and `searchId` names the durable graph snapshot so
 * the existing detail/mutation item routes resolve reused handles unchanged.
 */
export const MemoryGraphScopeSchema = z.enum(["global", "local"]);
export type MemoryGraphScope = z.infer<typeof MemoryGraphScopeSchema>;

export const MemoryGraphEpisodeSchema = z.strictObject({
  kind: z.enum(["session", "doc", "day"]),
  episodeKey: z.string().min(1).max(256),
  level: z.enum(["window", "episode"]),
});
export type MemoryGraphEpisode = z.infer<typeof MemoryGraphEpisodeSchema>;

/**
 * Derived general-category topics on one node (remind PR #29): at most
 * three short nouns, each 1..12 code points. Additive/optional: old remind
 * responses without topics still validate unchanged.
 */
export const MemoryGraphTopicSchema = z
  .string()
  .min(1)
  .refine(codePointsMax(12), { message: "topic over 12 code points" });

export const MemoryGraphNodeSchema = z.strictObject({
  handle: MemoryHandleSchema,
  label: z
    .string()
    .min(1)
    .refine(codePointsMax(512), { message: "label over 512 code points" }),
  status: z.enum(["active", "retired"]),
  kind: z.string().min(1).max(64),
  topics: z.array(MemoryGraphTopicSchema).max(3).optional(),
  /** Remind record creation instant (canonical ISO-8601), when provided. */
  createdAt: z.string().min(20).max(30).optional(),
  episode: MemoryGraphEpisodeSchema.nullable(),
});
export type MemoryGraphNode = z.infer<typeof MemoryGraphNodeSchema>;

export const MemoryGraphEdgeSchema = z.strictObject({
  from: MemoryHandleSchema,
  to: MemoryHandleSchema,
  kind: z.enum(["related", "consolidation", "similar"]),
});
export type MemoryGraphEdge = z.infer<typeof MemoryGraphEdgeSchema>;

export const MemoryGraphResponseSchema = z.strictObject({
  searchId: z.string().min(1).max(256),
  /** Opaque remind `graph.version` token (never interpreted by Companion). */
  version: z.string().min(1).max(256),
  scope: MemoryGraphScopeSchema,
  center: MemoryHandleSchema.nullable(),
  nodes: z.array(MemoryGraphNodeSchema).max(500),
  edges: z.array(MemoryGraphEdgeSchema).max(4000),
  truncated: z.boolean(),
});
export type MemoryGraphResponse = z.infer<typeof MemoryGraphResponseSchema>;

/** Local graph query: one already-bound handle expanded to `depth` hops. */
export const MemoryGraphLocalRequestSchema = z.strictObject({
  searchId: z.string().min(1).max(256),
  handle: MemoryHandleSchema,
  depth: z
    .union([z.literal(1), z.literal(2)])
    .optional()
    .default(1),
});
export type MemoryGraphLocalRequest = z.infer<
  typeof MemoryGraphLocalRequestSchema
>;

/** Global graph query: the whole (optionally retired-inclusive) scope. */
export const MemoryGraphGlobalRequestSchema = z.strictObject({
  includeRetired: z.boolean().optional().default(false),
});
export type MemoryGraphGlobalRequest = z.infer<
  typeof MemoryGraphGlobalRequestSchema
>;

/** HTTP GET global graph query (raw query-string values). */
export const MemoryGraphGlobalQuerySchema = z.strictObject({
  includeRetired: z.enum(["true", "false"]).optional(),
  runId: UuidSchema,
});
export type MemoryGraphGlobalQuery = z.infer<
  typeof MemoryGraphGlobalQuerySchema
>;

/** HTTP GET local graph query (raw query-string values). */
export const MemoryGraphLocalQuerySchema = z.strictObject({
  searchId: z.string().min(1).max(256),
  handle: MemoryHandleSchema,
  depth: z.enum(["1", "2"]).optional(),
  runId: UuidSchema,
});
export type MemoryGraphLocalQuery = z.infer<typeof MemoryGraphLocalQuerySchema>;

export const MemoryGraphVersionResponseSchema = z.strictObject({
  version: z.string().min(1).max(256),
});
export type MemoryGraphVersionResponse = z.infer<
  typeof MemoryGraphVersionResponseSchema
>;

/**
 * Read-only memory-content statistics for the configured scope. Counts are
 * numbers only (no record bodies, ids, or scopes). `byKind` covers ACTIVE
 * records; `truncated` means at least one status walk hit its server-side
 * row cap, so the numbers are lower bounds. Optional `importance` is reserved
 * for an aggregate reminder stats source (not emitted while remind has no
 * such op).
 */
export const MemoryStatsKindCountsSchema = z.strictObject({
  user_fact: z.number().int().min(0),
  model_inference: z.number().int().min(0),
  summary: z.number().int().min(0),
  correction: z.number().int().min(0),
});
export type MemoryStatsKindCounts = z.infer<typeof MemoryStatsKindCountsSchema>;

export const MemoryStatsStatusCountsSchema = z.strictObject({
  active: z.number().int().min(0),
  retired: z.number().int().min(0),
  superseded: z.number().int().min(0),
  archived: z.number().int().min(0),
});
export type MemoryStatsStatusCounts = z.infer<
  typeof MemoryStatsStatusCountsSchema
>;

export const MemoryImportanceBucketKeySchema = z.enum([
  "0-0.25",
  "0.25-0.5",
  "0.5-0.75",
  "0.75-1",
  "unscored",
]);
export type MemoryImportanceBucketKey = z.infer<
  typeof MemoryImportanceBucketKeySchema
>;

export const MemoryImportanceBucketSchema = z.strictObject({
  key: MemoryImportanceBucketKeySchema,
  count: z.number().int().min(0),
});
export type MemoryImportanceBucket = z.infer<
  typeof MemoryImportanceBucketSchema
>;

export const MemoryStatsImportanceSchema = z.strictObject({
  buckets: z.array(MemoryImportanceBucketSchema).length(5),
  sampled: z.number().int().min(0),
  total: z.number().int().min(0),
  truncated: z.boolean(),
});
export type MemoryStatsImportance = z.infer<typeof MemoryStatsImportanceSchema>;

export const MemoryStatsResponseSchema = z.strictObject({
  byKind: MemoryStatsKindCountsSchema,
  byStatus: MemoryStatsStatusCountsSchema,
  importance: MemoryStatsImportanceSchema.optional(),
  computedAt: z.number().int().min(0),
  truncated: z.boolean(),
});
export type MemoryStatsResponse = z.infer<typeof MemoryStatsResponseSchema>;

/** Fixed memory route error codes (lowercase, no values leak). */
export const MEMORY_ERROR_CODES = [
  "needs_clarification",
  "target_not_found",
  "state_conflict",
  "idempotency_key_reused",
  "memory_unavailable",
  "memory_graph_unavailable",
] as const;
export const MemoryErrorCodeSchema = z.enum(MEMORY_ERROR_CODES);
export type MemoryErrorCode = z.infer<typeof MemoryErrorCodeSchema>;
