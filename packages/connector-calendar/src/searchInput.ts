import { z } from "zod";

/**
 * `calendar.search` exact input contract (§17.4, agreed):
 * query? / start (ISO, req) / end (ISO, req) / limit (default 10, max 20) /
 * cursor? (opaque). start<end, range <= 90d, one page per call.
 */
export const calendarSearchInputSchema = z
  .object({
    query: z.string().min(1).max(256).optional(),
    start: z.string().datetime({ offset: true }),
    end: z.string().datetime({ offset: true }),
    limit: z.number().int().min(1).max(20).default(10),
    cursor: z.string().min(1).max(2048).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const start = Date.parse(v.start);
    const end = Date.parse(v.end);
    if (!(start < end)) {
      ctx.addIssue({
        code: "custom",
        message: "start must be before end",
        path: ["start"],
      });
      return;
    }
    const rangeMs = end - start;
    if (rangeMs > 90 * 24 * 60 * 60 * 1000) {
      ctx.addIssue({
        code: "custom",
        message: "range must be at most 90 days",
        path: ["end"],
      });
    }
  });

export type CalendarSearchInput = z.infer<typeof calendarSearchInputSchema>;
