import { z } from "zod";
import { Sha256HexSchema, UuidSchema } from "./ids.js";

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
  text: z
    .string()
    .min(1)
    .max(MAX_USER_TEXT_LENGTH)
    .refine((t) => t.trim().length > 0, {
      message: "text must not be blank",
    }),
});
export type UserTextTurnInputV1 = z.infer<typeof UserTextTurnInputV1Schema>;

/**
 * M5 decision TurnInput variants (§18.3, exact): both carry the proposal
 * id plus its immutable content hash, so a decision is always bound to the
 * exact hash the UI button was rendered with.
 */
export const ActionApprovalTurnInputV1Schema = z.strictObject({
  kind: z.literal("action_approval"),
  version: z.literal(1),
  proposalId: UuidSchema,
  proposalHash: Sha256HexSchema,
});
export type ActionApprovalTurnInputV1 = z.infer<
  typeof ActionApprovalTurnInputV1Schema
>;

export const ActionRejectionTurnInputV1Schema = z.strictObject({
  kind: z.literal("action_rejection"),
  version: z.literal(1),
  proposalId: UuidSchema,
  proposalHash: Sha256HexSchema,
});
export type ActionRejectionTurnInputV1 = z.infer<
  typeof ActionRejectionTurnInputV1Schema
>;

/**
 * TurnInput union, version 1: `user_text` (M0) plus the two M5 decision
 * variants (`action_approval` / `action_rejection`). No other variants.
 */
export const TurnInputV1Schema = z.discriminatedUnion("kind", [
  UserTextTurnInputV1Schema,
  ActionApprovalTurnInputV1Schema,
  ActionRejectionTurnInputV1Schema,
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
