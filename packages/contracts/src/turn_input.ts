import { z } from "zod";

/**
 * Bounds for M0 `user_text` input.
 *
 * AMBIGUITY (plan §12.2 gives no exact bound): the implementation plan
 * specifies a normalized `text` payload but no max length for message text.
 * M0 adopts 32_768 chars (== the 32KiB per-call tool input budget order of
 * magnitude). Empty / whitespace-only text is rejected.
 */
export const MAX_USER_TEXT_LENGTH = 32_768;

export const UserTextTurnInputV1Schema = z.strictObject({
  kind: z.literal("user_text"),
  version: z.literal(1),
  text: z.string().min(1).max(MAX_USER_TEXT_LENGTH).refine((t) => t.trim().length > 0, {
    message: "text must not be blank",
  }),
});
export type UserTextTurnInputV1 = z.infer<typeof UserTextTurnInputV1Schema>;

/**
 * M0 TurnInput union, version 1. Exactly one variant (`user_text`).
 * Do NOT add M1+ variants here.
 */
export const TurnInputV1Schema = z.discriminatedUnion("kind", [
  UserTextTurnInputV1Schema,
]);
export type TurnInputV1 = z.infer<typeof TurnInputV1Schema>;

/** Schema-versioned TurnInput registry. M0 serves version 1 only. */
export const TURN_INPUT_REGISTRY = {
  1: TurnInputV1Schema,
} as const;
export type TurnInputSchemaVersion = keyof typeof TURN_INPUT_REGISTRY;

/** Parse versioned TurnInput; rejects unknown versions / kinds. */
export function parseTurnInput(data: unknown): TurnInputV1 {
  if (typeof data !== "object" || data === null || !("version" in data)) {
    throw new Error("TurnInput must carry a version");
  }
  const version = (data as { version: unknown }).version;
  if (version !== 1) {
    throw new Error(`Unsupported TurnInput version: ${String(version)}`);
  }
  return TURN_INPUT_REGISTRY[1].parse(data);
}
