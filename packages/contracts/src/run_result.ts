import { z } from "zod";
import { countCodePoints } from "./references.js";
import {
  type StructuredAnswer,
  StructuredAnswerSchema,
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
 * Opt-in voice layer (voice-core): an optional, additive projection of the
 * canonical StructuredAnswer through a fixed persona profile. `text` stays
 * canonical (never the voiced text): voice is a separate rendering that is
 * never used to reconstruct citations or durable answer content.
 *
 * Contract:
 * - `profileId` is a lowercase slug, `profileVersion` is a bounded runtime
 *   fingerprint string.
 * - `status: "rendered"` REQUIRES exactly `answer.parts.length` non-empty
 *   parts (1-8000 code points each) and forbids `reason`.
 * - `status: "fallback" | "skipped"` REQUIRES a reason and forbids parts.
 * - Rows without `voice` (historical M2 rows) remain valid.
 */
export const VOICE_RENDER_STATUSES = [
  "rendered",
  "fallback",
  "skipped",
] as const;
export const VoiceRenderStatusSchema = z.enum(VOICE_RENDER_STATUSES);
export type VoiceRenderStatus = z.infer<typeof VoiceRenderStatusSchema>;

export const VOICE_RENDER_REASONS = [
  "timeout",
  "error",
  "invalid_output",
  "part_count",
  "citation_marker",
  "number",
  "negation",
  "latin",
  "url",
  "code_block",
  "length",
  "cancelled",
] as const;
export const VoiceRenderReasonSchema = z.enum(VOICE_RENDER_REASONS);
export type VoiceRenderReason = z.infer<typeof VoiceRenderReasonSchema>;

/** Lowercase slug: starts with a letter, 1-32 chars total. */
export const VOICE_PROFILE_ID_REGEX = /^[a-z][a-z0-9-]{0,31}$/;
export const VOICE_PROFILE_ID_PATTERN = VOICE_PROFILE_ID_REGEX;
export const MAX_VOICE_PROFILE_VERSION_LENGTH = 64;
export const MIN_VOICE_RENDER_PART_CODE_POINTS = 1;
export const MAX_VOICE_RENDER_PART_CODE_POINTS = 8000;

/** One voiced part: text only (citations stay in the canonical answer). */
export const VoiceRenderPartSchema = z.strictObject({
  text: z.string().refine(
    (text) => {
      const size = countCodePoints(text);
      return (
        size >= MIN_VOICE_RENDER_PART_CODE_POINTS &&
        size <= MAX_VOICE_RENDER_PART_CODE_POINTS
      );
    },
    { message: "voice part text must be 1-8000 Unicode code points" },
  ),
});
export type VoiceRenderPart = z.infer<typeof VoiceRenderPartSchema>;

export const VoiceRenderSchema = z
  .strictObject({
    profileId: z.string().regex(VOICE_PROFILE_ID_REGEX, {
      message: "voice profileId must be a lowercase slug",
    }),
    profileVersion: z.string().min(1).max(MAX_VOICE_PROFILE_VERSION_LENGTH),
    status: VoiceRenderStatusSchema,
    reason: VoiceRenderReasonSchema.optional(),
    parts: z.array(VoiceRenderPartSchema).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.status === "rendered") {
      if (value.parts === undefined) {
        ctx.addIssue({
          code: "custom",
          message: "rendered voice requires parts",
          path: ["parts"],
        });
      }
      if (value.reason !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: "rendered voice must not carry a reason",
          path: ["reason"],
        });
      }
      return;
    }
    if (value.reason === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "non-rendered voice requires a reason",
        path: ["reason"],
      });
    }
    if (value.parts !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "non-rendered voice must not carry parts",
        path: ["parts"],
      });
    }
  });
export type VoiceRender = z.infer<typeof VoiceRenderSchema>;

/**
 * Exact M2 RunResult shape: validated StructuredAnswer plus its
 * deterministic rendering. The nested answer is revalidated with the exact
 * 16KiB / parts / text / citation boundaries (never truncated), and the
 * rendered text must deterministically equal the answer parts joined by
 * blank lines (no silent citation drop, no semantic-verification claim).
 * An optional voice projection must align one-to-one with answer parts.
 */
export const RunResultV2Schema = z
  .strictObject({
    version: z.literal(RUN_RESULT_V2_VERSION),
    text: z.string().min(1).max(MAX_ASSISTANT_TEXT_LENGTH),
    answer: StructuredAnswerSchema,
    voice: VoiceRenderSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.text !== renderRunResultText(value.answer)) {
      ctx.addIssue({
        code: "custom",
        message:
          "run result text must equal answer parts joined by blank lines",
        path: ["text"],
      });
    }
    if (
      value.voice?.status === "rendered" &&
      value.voice.parts !== undefined &&
      value.voice.parts.length !== value.answer.parts.length
    ) {
      ctx.addIssue({
        code: "custom",
        message: "rendered voice parts must match answer parts length",
        path: ["voice", "parts"],
      });
    }
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
 * Revalidates the exact answer bounds, the deterministic rendering, and
 * (when supplied) the voice projection's part alignment.
 */
export function buildRunResultV2(
  answer: StructuredAnswer,
  voice?: VoiceRender,
): RunResultV2 {
  return RunResultV2Schema.parse({
    version: RUN_RESULT_V2_VERSION,
    text: renderRunResultText(answer),
    answer,
    ...(voice === undefined ? {} : { voice }),
  });
}
