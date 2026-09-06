import { z } from "zod";
import { Sha256HexSchema, UnixMsSchema, UuidSchema } from "./ids.js";

/** Tool name in `namespace.verb` form, lowercase (§9 blocker 6). */
export const ToolNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9]+(?:_[a-z0-9]+)*\.[a-z0-9]+(?:_[a-z0-9]+)*$/, {
    message: "tool must be lowercase namespace.verb",
  });
export type ToolName = z.infer<typeof ToolNameSchema>;

/**
 * Risk category driving the M0 read-only policy: `read` tools are allowed;
 * `write` / `sensitive` / `unclassified` are default-deny (§9 blocker 6).
 */
export const ToolCategorySchema = z.enum([
  "read",
  "write",
  "sensitive",
  "unclassified",
]);
export type ToolCategory = z.infer<typeof ToolCategorySchema>;

/**
 * Serializable tool definition owned by contracts (§9 blocker 6, §9.7.10).
 * Contains NO runtime Zod schema and NO handler: those live in the kernel
 * registry. JSON round-trip safe by construction (primitives + enums only).
 */
export const ToolDescriptorSchema = z.strictObject({
  name: ToolNameSchema,
  version: z.literal(1),
  title: z.string().min(1).max(128),
  description: z.string().min(1).max(1024),
  category: ToolCategorySchema,
  defaultTimeoutMs: z.number().int().min(1).max(60_000).default(15_000),
  maxTimeoutMs: z.number().int().min(1).max(60_000).default(60_000),
  supportsRefresh: z.boolean().default(false),
});
export type ToolDescriptor = z.infer<typeof ToolDescriptorSchema>;

/** M0 default budgets, exact values from §9 blocker 6. */
export const TOOL_BUDGET_DEFAULTS = {
  maxToolRequestsPerRun: 8,
  maxConcurrentPerRun: 3,
  maxConcurrentProcess: 8,
  maxInputBytesPerCall: 32 * 1024,
  maxNormalizedOutputBytesPerCall: 256 * 1024,
  maxModelFacingOutputBytesPerCall: 64 * 1024,
  maxModelFacingOutputBytesPerRun: 128 * 1024,
  maxObservationsPerCall: 20,
  maxObservationsPerRun: 50,
  defaultTimeoutMs: 15_000,
  maxTimeoutMs: 60_000,
} as const;

/** Handler-reported outcome (`tool_calls.reported_outcome`). */
export const ReportedOutcomeSchema = z.enum([
  "succeeded",
  "failed",
  "cancelled",
]);
export type ReportedOutcome = z.infer<typeof ReportedOutcomeSchema>;

/** Broker-observed conclusion (`tool_calls.actual_outcome`). */
export const ActualOutcomeSchema = z.enum([
  "succeeded",
  "failed",
  "denied",
  "invalid",
  "deduplicated",
  "timed_out",
  "cancelled",
  "unknown",
]);
export type ActualOutcome = z.infer<typeof ActualOutcomeSchema>;

/** How the tool result was used (`tool_calls.result_disposition`). */
export const ResultDispositionSchema = z.enum([
  "accepted",
  "discarded",
  "none",
]);
export type ResultDisposition = z.infer<typeof ResultDispositionSchema>;

/**
 * Closed M0 tool error vocabulary (schemaVersion=1): exactly the nine codes
 * produced by the M0 kernel tool broker. No other code is valid in M0;
 * M1+ codes must be added via an explicit versioned registry entry, never
 * free text. Raw errors/content are never stored.
 */
export const M0_TOOL_ERROR_CODES = [
  "budget_exceeded",
  "unknown_tool",
  "tool_denied",
  "invalid_input",
  "execution_timeout",
  "execution_cancelled",
  "execution_failed",
  "output_invalid",
  "output_too_large",
] as const;

/** Exact M0 tool error-code schema (schemaVersion=1, exactly nine codes). */
export const M0ToolErrorCodeSchema = z.enum(M0_TOOL_ERROR_CODES);
export type M0ToolErrorCode = z.infer<typeof M0ToolErrorCodeSchema>;

/**
 * Exact M1 additions only (deterministic Markdown connector failure codes
 * plus the reference-handler code, §14.6): per-file oversize/invalid UTF-8
 * are NEVER errors (they belong in the search `skipped` list); unsafe
 * paths and vault >10000 fail the whole call.
 */
export const M1_TOOL_ERROR_CODES = [
  "markdown_vault_too_large",
  "markdown_path_unsafe",
  "markdown_read_failed",
  "markdown_read_changed",
  "reference_not_found",
] as const;
export type M1ToolErrorCodeNew = (typeof M1_TOOL_ERROR_CODES)[number];
export const M1ToolErrorCodeNewSchema = z.enum(M1_TOOL_ERROR_CODES);

/**
 * Closed M1 tool error vocabulary: the exact M0 nine plus the exact M1
 * five (14 total, explicit closed union, never regex/free text; no M2+
 * codes). Generic/latest validation accepts all fourteen; exact M0
 * validation accepts only the nine above.
 */
export const LATEST_TOOL_ERROR_CODES = [
  ...M0_TOOL_ERROR_CODES,
  ...M1_TOOL_ERROR_CODES,
] as const;
export type LatestToolErrorCode = (typeof LATEST_TOOL_ERROR_CODES)[number];

/** Latest (M1) tool error-code schema: closed M0+M1 union (14 codes). */
export const M1ToolErrorCodeSchema = z.enum(LATEST_TOOL_ERROR_CODES);
export type M1ToolErrorCode = z.infer<typeof M1ToolErrorCodeSchema>;

/** Alias: M1 is the latest schema version served. */
export const LatestToolErrorCodeSchema = M1ToolErrorCodeSchema;
export type ToolErrorCode = z.infer<typeof LatestToolErrorCodeSchema>;

/** Generic tool error-code schema: latest (M0+M1, 14 codes). */
export const ToolErrorCodeSchema = LatestToolErrorCodeSchema;

/** Known M0 tool error codes (alias of the closed M0 vocabulary). */
export const KNOWN_M0_TOOL_ERROR_CODES = M0_TOOL_ERROR_CODES;

/** Known latest (M0+M1) tool error codes (closed 14-code vocabulary). */
export const KNOWN_LATEST_TOOL_ERROR_CODES = LATEST_TOOL_ERROR_CODES;

/** Exact M0 schema-versioned tool error-code registry (version 1 only). */
export const TOOL_ERROR_CODE_REGISTRY = {
  1: M0ToolErrorCodeSchema,
} as const;
export type ToolErrorSchemaVersion = keyof typeof TOOL_ERROR_CODE_REGISTRY;

/** Latest (M1) schema-versioned tool error-code registry. */
export const M1_TOOL_ERROR_CODE_REGISTRY = {
  1: M1ToolErrorCodeSchema,
} as const;
export type M1ToolErrorSchemaVersion = keyof typeof M1_TOOL_ERROR_CODE_REGISTRY;

/** Alias: M1 is the latest schema version served. */
export const LATEST_TOOL_ERROR_CODE_REGISTRY = M1_TOOL_ERROR_CODE_REGISTRY;
export type LatestToolErrorSchemaVersion = M1ToolErrorSchemaVersion;

/** Parse a tool error code with the exact M0 registry (rejects M1+ codes). */
export function parseM0ToolErrorCode(data: unknown): M0ToolErrorCode {
  return TOOL_ERROR_CODE_REGISTRY[1].parse(data);
}

/** Parse a tool error code with the latest (M0+M1) registry. */
export function parseM1ToolErrorCode(data: unknown): M1ToolErrorCode {
  return M1_TOOL_ERROR_CODE_REGISTRY[1].parse(data);
}

/** Alias: M1 is the latest schema version served. */
export const parseLatestToolErrorCode = parseM1ToolErrorCode;

/** Parse a tool error code for the latest schema version (M0+M1). */
export function parseToolErrorCode(data: unknown): ToolErrorCode {
  return LATEST_TOOL_ERROR_CODE_REGISTRY[1].parse(data);
}

/**
 * Closed M0 Run error vocabulary (schemaVersion=1): exactly the three codes
 * the M0 RunEngine persists (`execution_failed` for strategy failure or
 * unknown strategy, `execution_cancelled` for abort/cancel, `output_invalid`
 * for an unparsable RunResult candidate). No tool-only or future M1+ codes.
 */
export const M0_RUN_ERROR_CODES = [
  "execution_failed",
  "execution_cancelled",
  "output_invalid",
] as const;

export const RunErrorCodeSchema = z.enum(M0_RUN_ERROR_CODES);
export type RunErrorCode = z.infer<typeof RunErrorCodeSchema>;

/** Schema-versioned Run error-code registry. M0 serves version 1 only. */
export const RUN_ERROR_CODE_REGISTRY = {
  1: RunErrorCodeSchema,
} as const;
export type RunErrorSchemaVersion = keyof typeof RUN_ERROR_CODE_REGISTRY;

/** Parse a Run error code for the M0 schema version; rejects unknown codes. */
export function parseRunErrorCode(data: unknown): RunErrorCode {
  return RUN_ERROR_CODE_REGISTRY[1].parse(data);
}

/**
 * Exact M0 tool outcome record: error codes limited to the M0 nine.
 * Retained verbatim for M0 assertions.
 */
export const M0ToolResultSchema = z.strictObject({
  tool: ToolNameSchema,
  callIndex: z.number().int().min(1),
  actualOutcome: ActualOutcomeSchema,
  reportedOutcome: ReportedOutcomeSchema.nullable().default(null),
  disposition: ResultDispositionSchema,
  errorCode: M0ToolErrorCodeSchema.nullable().default(null),
  resultDigest: Sha256HexSchema.nullable().default(null),
  reusedFromCallId: UuidSchema.nullable().default(null),
  finishedAt: UnixMsSchema.nullable().default(null),
});
export type M0ToolResult = z.infer<typeof M0ToolResultSchema>;

/**
 * Serializable tool outcome record. Audit-only: digests and codes, never
 * raw args / results / content (§12.4). Generic/latest accepts M0+M1 codes.
 */
export const ToolResultSchema = z.strictObject({
  tool: ToolNameSchema,
  callIndex: z.number().int().min(1),
  actualOutcome: ActualOutcomeSchema,
  reportedOutcome: ReportedOutcomeSchema.nullable().default(null),
  disposition: ResultDispositionSchema,
  errorCode: LatestToolErrorCodeSchema.nullable().default(null),
  resultDigest: Sha256HexSchema.nullable().default(null),
  reusedFromCallId: UuidSchema.nullable().default(null),
  finishedAt: UnixMsSchema.nullable().default(null),
});
export type ToolResult = z.infer<typeof ToolResultSchema>;

/** Alias: M1/latest tool outcome record (M0+M1 codes). */
export const M1ToolResultSchema = ToolResultSchema;
export type M1ToolResult = ToolResult;
export const LatestToolResultSchema = ToolResultSchema;
export type LatestToolResult = ToolResult;
