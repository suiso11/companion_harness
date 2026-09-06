import { z } from "zod";
import { countCodePoints, utf8ByteLength } from "./references.js";

/**
 * M2 StructuredAnswer contracts (§15.8): the exact validated shape submitted
 * via the reserved `answer.submit` terminal protocol.
 *
 * Exact bounds (agreed): parts 1-20, each part text 1-4000 Unicode code
 * points, each part citations 0-8, whole-answer serialized UTF-8 size at
 * most 16KiB (16384 bytes). Oversize input is rejected, never truncated
 * (no silent truncation, same policy as §9 blocker 6).
 *
 * Citations are structurally valid rN identifiers only (`r` + a positive
 * integer with no leading zeros, e.g. `r1`, `r12`). Whether a cited rN was
 * granted to the current Run (current-run grant required, exposure
 * snippet/full consistency) is kernel validation (CitationVerifier); it is
 * not, and cannot be, decided at this layer.
 */

/** Reserved `answer.submit` terminal protocol name (non-Broker, §15.3). */
export const ANSWER_SUBMIT_TOOL_NAME = "answer.submit" as const;

/**
 * Reserved `answer` namespace: no other tool may register or call
 * `answer.*` (§15.3).
 */
export const RESERVED_ANSWER_NAMESPACE = "answer" as const;

/** StructuredAnswer schema version. M2 serves version 1 only. */
export const STRUCTURED_ANSWER_VERSION = 1 as const;

/** Exact part-count bounds: 1-20 parts (agreed, §15.8). */
export const MIN_STRUCTURED_ANSWER_PARTS = 1 as const;
export const MAX_STRUCTURED_ANSWER_PARTS = 20 as const;

/**
 * Exact per-part text bounds: 1-4000 Unicode code points (agreed, §15.8).
 * Code points, not UTF-16 units or UTF-8 bytes, so astral characters
 * (e.g. emoji) count once — the same unit as the M1 query/snippet bounds.
 */
export const MIN_PART_TEXT_CODE_POINTS = 1 as const;
export const MAX_PART_TEXT_CODE_POINTS = 4000 as const;

/** Exact per-part citation bound: 0-8 citations (agreed, §15.8). */
export const MAX_CITATIONS_PER_PART = 8 as const;

/**
 * Exact whole-answer bound: at most 16KiB (16384 UTF-8 bytes) of the
 * canonical `JSON.stringify` serialization (agreed, §15.8). 16384 bytes
 * accepted, 16385 rejected. Oversize input is rejected, never truncated.
 */
export const MAX_STRUCTURED_ANSWER_BYTES = 16_384 as const;

/**
 * Structural rN citation identifier: `r` followed by a positive integer
 * with no leading zeros (`r1`, `r12`). `r0`, `r01`, bare numbers, UUIDs,
 * paths, and any other shape are rejected. String length is capped at 11
 * (`r` + up to 10 digits) to keep the identifier bounded.
 */
export const CITATION_ID_REGEX = /^r[1-9][0-9]*$/;
export const CitationIdSchema = z
  .string()
  .min(2)
  .max(11)
  .regex(CITATION_ID_REGEX, {
    message: "citation must be a structural rN identifier (e.g. r1)",
  });
export type CitationId = z.infer<typeof CitationIdSchema>;

/** One answer part: display text plus structural rN citations. */
export const StructuredAnswerPartSchema = z.strictObject({
  text: z.string().refine(
    (text) => {
      const size = countCodePoints(text);
      return (
        size >= MIN_PART_TEXT_CODE_POINTS && size <= MAX_PART_TEXT_CODE_POINTS
      );
    },
    { message: "part text must be 1-4000 Unicode code points" },
  ),
  citations: z.array(CitationIdSchema).max(MAX_CITATIONS_PER_PART),
});
export type StructuredAnswerPart = z.infer<typeof StructuredAnswerPartSchema>;

const StructuredAnswerBaseSchema = z.strictObject({
  version: z.literal(STRUCTURED_ANSWER_VERSION),
  parts: z
    .array(StructuredAnswerPartSchema)
    .min(MIN_STRUCTURED_ANSWER_PARTS)
    .max(MAX_STRUCTURED_ANSWER_PARTS),
});

/**
 * Exact byte size of the canonical serialization (`JSON.stringify`,
 * measured in UTF-8 bytes via the dependency-free `utf8ByteLength`).
 */
export function measureStructuredAnswerBytes(answer: {
  version: 1;
  parts: readonly { text: string; citations: readonly string[] }[];
}): number {
  return utf8ByteLength(JSON.stringify(answer));
}

/**
 * Strict versioned StructuredAnswer: exact part/text/citation bounds plus
 * the 16KiB whole-answer cap. Rejects oversize input; never truncates.
 */
export const StructuredAnswerSchema = StructuredAnswerBaseSchema.refine(
  (answer) =>
    measureStructuredAnswerBytes(answer) <= MAX_STRUCTURED_ANSWER_BYTES,
  { message: "structured answer must fit 16KiB UTF-8 without truncation" },
);
export type StructuredAnswer = z.infer<typeof StructuredAnswerSchema>;

/**
 * `answer.submit` tool input: exactly one StructuredAnswer. The protocol
 * itself (single-only submission, no ToolBroker, no budget consumption,
 * one-only, one repair max) is a kernel concern; contracts fix the shape.
 */
export const AnswerSubmitToolInputSchema = StructuredAnswerSchema;
export type AnswerSubmitToolInput = z.infer<typeof AnswerSubmitToolInputSchema>;

/** Schema-versioned StructuredAnswer registry. M2 serves version 1 only. */
export const STRUCTURED_ANSWER_REGISTRY = {
  1: StructuredAnswerSchema,
} as const;
export type StructuredAnswerSchemaVersion =
  keyof typeof STRUCTURED_ANSWER_REGISTRY;

/** Parse a StructuredAnswer; rejects unknown versions and oversize input. */
export function parseStructuredAnswer(data: unknown): StructuredAnswer {
  if (typeof data !== "object" || data === null || !("version" in data)) {
    throw new Error("StructuredAnswer must carry a version");
  }
  const version = (data as { version: unknown }).version;
  if (version !== 1) {
    throw new Error(`Unsupported StructuredAnswer version: ${String(version)}`);
  }
  return STRUCTURED_ANSWER_REGISTRY[1].parse(data);
}
