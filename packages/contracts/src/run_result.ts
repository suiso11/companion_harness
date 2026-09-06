import { z } from "zod";
import {
  StructuredAnswerSchema,
  type StructuredAnswer,
} from "./structured_answer.js";

/**
 * Bounds for the completed assistant answer text.
 *
 * AMBIGUITY: the plan requires a "versioned, normalized, validated"
 * RunResult carried only by `run.completed` (§9 blocker 5) but gives no
 * exact fields or bound. M0 adopts `{ version: 1, text }` with a 65_536-char
 * cap (== the 64KiB per-call model-facing output budget).
 *
 * M2 adds `{ version: 2, text, answer }`: the durable completed RunResult
 * persists the validated StructuredAnswer (exact part-to-citations mapping)
 * alongside its deterministic rendering. `text` MUST equal
 * `answer.parts.map((part) => part.text).join("\n\n")` (see
 * `renderRunResultText`); mismatches are rejected, never repaired, so no
 * citation is ever silently dropped. V1 rows stay valid forever
 * (historical M0/M1 runs); only `run.completed` carries either shape.
 */
export const MAX_ASSISTANT_TEXT_LENGTH = 65_536;

/** Exact M0 RunResult shape. Frozen: never altered (M0 assertions pin it). */
export const RunResultV1Schema = z.strictObject({
  version: z.literal(1),
  text: z.string().min(1).max(MAX_ASSISTANT_TEXT_LENGTH),
});
export type RunResultV1 = z.infer<typeof RunResultV1Schema>;

/** M2 RunResult schema version (structured persistence). */
export const RUN_RESULT_V2_VERSION = 2 as const;

/**
 * Deterministic rendering of a validated StructuredAnswer to RunResult
 * text: parts joined by exactly one blank line. The single rendering used
 * by the durable result, history projection, and the agent prompt.
 */
export function renderRunResultText(answer: StructuredAnswer): string {
  return answer.parts.map((part) => part.text).join("\n\n");
}

/**
 * Exact M2 RunResult shape: validated StructuredAnswer plus its
 * deterministic rendering. The nested answer is revalidated with the exact
 * 16KiB / parts / text / citation boundaries (never truncated), and the
 * rendered text must deterministically equal the answer parts joined by
 * blank lines (no silent citation drop, no semantic-verification claim).
 */
export const RunResultV2Schema = z
  .strictObject({
    version: z.literal(RUN_RESULT_V2_VERSION),
    text: z.string().min(1).max(MAX_ASSISTANT_TEXT_LENGTH),
    answer: StructuredAnswerSchema,
  })
  .refine((value) => value.text === renderRunResultText(value.answer), {
    message: "run result text must equal answer parts joined by blank lines",
  });
export type RunResultV2 = z.infer<typeof RunResultV2Schema>;

/**
 * Latest RunResult: V1 historical rows plus V2 M2 rows. M0 callers keep
 * using `RunResultV1Schema` / `parseM0RunResult` semantics unchanged.
 */
export const RunResultSchema = z.discriminatedUnion("version", [
  RunResultV1Schema,
  RunResultV2Schema,
]);
export type RunResult = z.infer<typeof RunResultSchema>;

/** Schema-versioned RunResult registry. M0 serves version 1 only. */
export const RUN_RESULT_REGISTRY = {
  1: RunResultV1Schema,
  2: RunResultV2Schema,
} as const;
export type RunResultSchemaVersion = keyof typeof RUN_RESULT_REGISTRY;

/**
 * Parse the exact M0 RunResult (version 1 only). Rejects V2 M2 rows and
 * any other version; used by exact M0 assertions.
 */
export function parseM0RunResult(data: unknown): RunResultV1 {
  return RUN_RESULT_REGISTRY[1].parse(data);
}

/** Parse a RunResult; accepts V1 historical rows and V2 M2 rows. */
export function parseRunResult(data: unknown): RunResult {
  if (typeof data === "object" && data !== null && "version" in data) {
    const version = (data as { version: unknown }).version;
    if (version === 2) {
      return RUN_RESULT_REGISTRY[2].parse(data);
    }
    if (version !== 1) {
      throw new Error(`Unsupported RunResult version: ${String(version)}`);
    }
  }
  return RUN_RESULT_REGISTRY[1].parse(data);
}

/**
 * Build the durable V2 result for a validated StructuredAnswer.
 * Revalidates the exact answer bounds and the deterministic rendering.
 */
export function buildRunResultV2(answer: StructuredAnswer): RunResultV2 {
  return RunResultV2Schema.parse({
    version: RUN_RESULT_V2_VERSION,
    text: renderRunResultText(answer),
    answer,
  });
}
