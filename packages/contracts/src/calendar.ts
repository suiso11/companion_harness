import { z } from "zod";
import { UuidSchema } from "./ids.js";
import {
  CanonicalKeySchema,
  ReferenceTitleSchema,
  SnippetSchema,
} from "./references.js";

/**
 * M4 Calendar tool contracts (`calendar.search`, §17.4).
 *
 * These are the SERIALIZABLE broker-boundary shapes only. The authoritative
 * ISO/time-zone/90-day validation lives in `@companion/connector-calendar`
 * (`mapCalendarSearchRequest`) which the kernel reaches through a
 * dependency-inverted port, never by importing the connector package. The
 * kernel schema is intentionally strict on shape/type/range while leaving the
 * exact instant grammar to the port (start/end are opaque non-empty strings
 * here; the port rejects an imprecise instant with `calendar_range_invalid`).
 *
 * PRIVACY: neither the input nor the output carries an upstream calendar id,
 * event id, attendee, organizer, join URL, token or raw MCP payload. The
 * private `get-event` target is persisted by the kernel in a non-public store
 * and is never part of these DTOs.
 */

/** Exact `calendar.search` input (§17.4). */
export const CalendarSearchToolInputSchema = z
  .strictObject({
    query: z.string().min(1).max(256).optional(),
    start: z.string().min(1).max(128),
    end: z.string().min(1).max(128),
    limit: z.number().int().min(1).max(20).default(10),
    cursor: z.string().min(1).max(2048).optional(),
  })
  .superRefine((value, ctx) => {
    // Cheap structural pre-check only; exact instant/range validation stays in
    // the port. Whole-string rollovers and missing offsets are rejected there.
    if (value.start === value.end) {
      ctx.addIssue({
        code: "custom",
        message: "start must be before end",
        path: ["start"],
      });
    }
  });
export type CalendarSearchToolInput = z.infer<
  typeof CalendarSearchToolInputSchema
>;
export type CalendarSearchToolInputInput = z.input<
  typeof CalendarSearchToolInputSchema
>;

/** Normalized Calendar event status (4-value snapshot vocabulary, §17.4). */
export const CalendarEventStatusSchema = z.enum([
  "confirmed",
  "tentative",
  "cancelled",
  "deleted",
]);
export type CalendarEventStatus = z.infer<typeof CalendarEventStatusSchema>;

/** One persisted search hit: structural ids + display fields + snippet only. */
export const CalendarSearchHitSchema = z.strictObject({
  referenceId: UuidSchema,
  ordinal: z.number().int().min(1),
  snapshotId: UuidSchema,
  resourceId: UuidSchema,
  canonicalKey: CanonicalKeySchema,
  title: ReferenceTitleSchema.nullable(),
  status: CalendarEventStatusSchema,
  snippet: SnippetSchema,
});
export type CalendarSearchHit = z.infer<typeof CalendarSearchHitSchema>;

/**
 * `calendar.search` output: one upstream page only (never auto-paginated) plus
 * the verbatim opaque cursor, if any. No upstream ids, no raw MCP payload.
 */
export const CalendarSearchToolOutputSchema = z.strictObject({
  hits: z.array(CalendarSearchHitSchema).max(20),
  cursor: z.string().min(1).max(2048).optional(),
});
export type CalendarSearchToolOutput = z.infer<
  typeof CalendarSearchToolOutputSchema
>;

/**
 * Stored private `get-event` target. Provider ids are ONLY valid inside this
 * host-private shape: it is persisted by the kernel in a non-public store and
 * is never returned to the model, embedded in a Snapshot/body, or placed in a
 * public DTO/error.
 */
export const CalendarGetTargetSchema = z.strictObject({
  calendarId: z.string().min(1).max(512),
  eventId: z.string().min(1).max(1024),
  account: z.string().min(1).max(512).optional(),
});
export type CalendarGetTarget = z.infer<typeof CalendarGetTargetSchema>;
