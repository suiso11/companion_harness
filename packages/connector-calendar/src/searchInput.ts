import { z } from "zod";
import { isIanaTimeZone, parseTimedInstant } from "./time.js";

/**
 * `calendar.search` exact input contract (§17.4, agreed):
 * query? / start (ISO, req) / end (ISO, req) / limit (default 10, max 20) /
 * cursor? (opaque). start<end, elapsed range <= 90d, one page per call.
 *
 * Start/end are validated with the shared explicit-offset parser so impossible
 * calendar dates, missing offsets and whole-string rollovers are rejected
 * without relying on `Date.parse`. Fractional seconds remain part of the
 * agreed ISO contract (never silently narrowed to the candidate's whole-second
 * regex).
 */
const isoInstant = (field: "start" | "end") =>
  z
    .string()
    .min(1)
    .max(128)
    .refine((value) => parseTimedInstant(value) !== undefined, {
      message: `${field} must be an RFC3339 datetime with an explicit offset`,
    });

export const calendarSearchInputSchema = z
  .object({
    query: z.string().min(1).max(256).optional(),
    start: isoInstant("start"),
    end: isoInstant("end"),
    limit: z.number().int().min(1).max(20).default(10),
    cursor: z.string().min(1).max(2048).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const start = parseTimedInstant(v.start);
    const end = parseTimedInstant(v.end);
    if (start === undefined || end === undefined) return;
    if (!(start < end)) {
      ctx.addIssue({
        code: "custom",
        message: "start must be before end",
        path: ["start"],
      });
      return;
    }
    if (end - start > 90 * 24 * 60 * 60 * 1000) {
      ctx.addIssue({
        code: "custom",
        message: "range must be at most 90 days",
        path: ["end"],
      });
    }
  });

export type CalendarSearchInput = z.infer<typeof calendarSearchInputSchema>;

/** Trusted HOST selection; never model-controlled. */
export interface CalendarSelection {
  calendarId: string;
  account?: string;
}

/**
 * Upstream MCP arguments for the candidate custom tool schemas. The candidate
 * MCP layer exposes `query`/`pageSize`/`pageToken`/`timeMin`/`timeMax`/
 * `timeZone`/`calendarId`/`account`; it is the PROVIDER, not this consumer,
 * that translates `query`→Google `q` and `pageSize`→`maxResults`. This mapper
 * never emits `q`/`maxResults`.
 */
export interface CalendarSearchRequest {
  upstreamTool: "list-events" | "search-events";
  arguments: {
    calendarId: string;
    account?: string;
    timeMin: string;
    timeMax: string;
    timeZone: string;
    pageSize: number;
    pageToken?: string;
    query?: string;
  };
}

const REQUEST_INVALID = "calendar_range_invalid";

/**
 * Pure, validated `calendar.search` → candidate MCP request mapping.
 *
 * `input` is the raw model input (strict-validated here); `selection` is the
 * trusted single-calendar HOST choice; `frozenTimeZone` is the frozen IANA
 * zone. Start/end are forwarded byte-for-byte (explicit offset preserved, not
 * reinterpreted in the frozen zone). The queryless case selects `list-events`;
 * any query selects `search-events`. The opaque cursor is forwarded verbatim
 * as `pageToken` (no trim/base64/JSON decode/synthesis, no auto-pagination).
 *
 * Absolute inputs need no clock, so no `now` is accepted or read.
 */
export function mapCalendarSearchRequest(
  input: unknown,
  selection: CalendarSelection,
  frozenTimeZone: string,
): CalendarSearchRequest {
  let parsed: CalendarSearchInput;
  try {
    parsed = calendarSearchInputSchema.parse(input);
  } catch {
    throw new Error(REQUEST_INVALID);
  }
  if (
    typeof selection.calendarId !== "string" ||
    selection.calendarId.length === 0
  ) {
    throw new Error(REQUEST_INVALID);
  }
  if (
    selection.account !== undefined &&
    (typeof selection.account !== "string" || selection.account.length === 0)
  ) {
    throw new Error(REQUEST_INVALID);
  }
  if (!isIanaTimeZone(frozenTimeZone)) {
    throw new Error(REQUEST_INVALID);
  }
  const withQuery = parsed.query !== undefined;
  return {
    upstreamTool: withQuery ? "search-events" : "list-events",
    arguments: {
      calendarId: selection.calendarId,
      ...(selection.account !== undefined
        ? { account: selection.account }
        : {}),
      timeMin: parsed.start,
      timeMax: parsed.end,
      timeZone: frozenTimeZone,
      pageSize: parsed.limit,
      ...(parsed.cursor !== undefined ? { pageToken: parsed.cursor } : {}),
      ...(parsed.query !== undefined ? { query: parsed.query } : {}),
    },
  };
}
