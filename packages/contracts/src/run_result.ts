import { z } from "zod";

/**
 * Bounds for the completed assistant answer text.
 *
 * AMBIGUITY: the plan requires a "versioned, normalized, validated"
 * RunResult carried only by `run.completed` (§9 blocker 5) but gives no
 * exact fields or bound. M0 adopts `{ version: 1, text }` with a 65_536-char
 * cap (== the 64KiB per-call model-facing output budget).
 */
export const MAX_ASSISTANT_TEXT_LENGTH = 65_536;

export const RunResultV1Schema = z.strictObject({
  version: z.literal(1),
  text: z.string().min(1).max(MAX_ASSISTANT_TEXT_LENGTH),
});
export type RunResultV1 = z.infer<typeof RunResultV1Schema>;

export const RunResultSchema = RunResultV1Schema;
export type RunResult = z.infer<typeof RunResultSchema>;

/** Schema-versioned RunResult registry. M0 serves version 1 only. */
export const RUN_RESULT_REGISTRY = {
  1: RunResultV1Schema,
} as const;

export function parseRunResult(data: unknown): RunResult {
  return RUN_RESULT_REGISTRY[1].parse(data);
}
