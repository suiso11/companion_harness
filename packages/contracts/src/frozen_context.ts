import { z } from "zod";
import { UnixMsSchema } from "./ids.js";

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
 */
export const FrozenContextSchema = z.strictObject({
  version: z.literal(1),
  temporal: TemporalContextSchema,
  uiContext: z.record(z.string(), z.json()).optional().default({}),
});
export type FrozenContext = z.infer<typeof FrozenContextSchema>;
