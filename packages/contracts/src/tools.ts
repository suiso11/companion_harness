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
export const ToolCategorySchema = z.enum(["read", "write", "sensitive", "unclassified"]);
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
export const ReportedOutcomeSchema = z.enum(["succeeded", "failed", "cancelled"]);
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
export const ResultDispositionSchema = z.enum(["accepted", "discarded", "none"]);
export type ResultDisposition = z.infer<typeof ResultDispositionSchema>;

/**
 * Fixed error-code shape: lowercase snake_case, never raw errors/content.
 *
 * AMBIGUITY: the plan mandates "typed fixed codes" but enumerates no exact
 * M0 tool vocabulary (only M4/M5 codes, which are out of scope). Contracts
 * therefore fix the shape and document the known M0 codes below; the closed
 * vocabulary grows only via explicit registry additions, never free text.
 */
export const ToolErrorCodeSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/, {
    message: "error code must be lowercase snake_case",
  });
export type ToolErrorCode = z.infer<typeof ToolErrorCodeSchema>;

/** Known M0 tool error codes (documentation of current vocabulary). */
export const KNOWN_M0_TOOL_ERROR_CODES = [
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

/** Run failure code: fixed, redacted; raw errors are never stored. */
export const RunErrorCodeSchema = ToolErrorCodeSchema;
export type RunErrorCode = z.infer<typeof RunErrorCodeSchema>;

/**
 * Serializable tool outcome record. Audit-only: digests and codes, never
 * raw args / results / content (§12.4).
 */
export const ToolResultSchema = z.strictObject({
  tool: ToolNameSchema,
  callIndex: z.number().int().min(1),
  actualOutcome: ActualOutcomeSchema,
  reportedOutcome: ReportedOutcomeSchema.nullable().default(null),
  disposition: ResultDispositionSchema,
  errorCode: ToolErrorCodeSchema.nullable().default(null),
  resultDigest: Sha256HexSchema.nullable().default(null),
  reusedFromCallId: UuidSchema.nullable().default(null),
  finishedAt: UnixMsSchema.nullable().default(null),
});
export type ToolResult = z.infer<typeof ToolResultSchema>;
