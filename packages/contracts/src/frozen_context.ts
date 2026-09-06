import { z } from "zod";
import { UnixMsSchema, UuidSchema } from "./ids.js";

/**
 * Temporal context frozen into the Turn at creation (§9 blocker 2, §17.4).
 *
 * AMBIGUITY: the plan requires an IANA time-zone name but contracts cannot
 * ship the full IANA database. This schema enforces `Area/Location` shape
 * (plus `UTC`); full IANA membership is verified server-side via
 * `Intl.DateTimeFormat` and rejected otherwise.
 */
export const TemporalContextSchema = z.strictObject({
  now: UnixMsSchema,
  timeZone: z
    .string()
    .min(1)
    .max(128)
    .regex(/^(UTC|[A-Za-z_][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)+)$/, {
      message: "timeZone must be an IANA-shaped name (Area/Location) or UTC",
    }),
});
export type TemporalContext = z.infer<typeof TemporalContextSchema>;

/**
 * Frozen UI context stored in `turns.frozen_context`. Immutable: never
 * rewritten, including on Retry. `uiContext` is an opaque JSON record so
 * future UI keys do not break M0 parsing; the outer object stays strict.
 *
 * M1 adds an optional immutable reference-context snapshot: the session
 * reference-context `{ version, items }` (ordered SessionReference ids)
 * frozen at Turn creation (§14.2, §9 blocker 2). Optional so stored M0
 * Turns (no key) still parse; an empty `items` array is a frozen empty
 * selection, distinct from an absent (M0) snapshot. Post-Run-start UI
 * changes never affect the frozen copy.
 */
export const ReferenceContextSnapshotSchema = z.strictObject({
  version: z.number().int().min(1),
  items: z.array(UuidSchema),
});
export type ReferenceContextSnapshot = z.infer<
  typeof ReferenceContextSnapshotSchema
>;

export const FrozenContextSchema = z.strictObject({
  version: z.literal(1),
  temporal: TemporalContextSchema,
  uiContext: z.record(z.string(), z.json()).optional().default({}),
  referenceContext: ReferenceContextSnapshotSchema.optional(),
});
export type FrozenContext = z.infer<typeof FrozenContextSchema>;
