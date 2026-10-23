// Pure time-zone rendering helpers shared by the kernel and the server.
//
// All memory-facing timestamps are rendered in the CONFIGURED IANA time zone
// (COMPANION_TIME_ZONE / the Turn's frozen temporal), never in the host's
// local zone: the frozen Turn temporal carries the zone for extraction/recall,
// and the UI passes the browser zone explicitly. Invalid zones/timestamps fail
// closed (null), so a caller can omit the date rather than print a wrong one.

/** `2026-10-23 (金) 15:42` in `timeZone`, or null when invalid. */
export function formatZonedDateTime(
  now: number,
  timeZone: string,
): string | null {
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) {
    return null;
  }
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const value = (type: Intl.DateTimeFormatPartTypes): string =>
      parts.find((part) => part.type === type)?.value ?? "";
    const year = value("year");
    const month = value("month");
    const day = value("day");
    const hour = value("hour");
    const minute = value("minute");
    if (
      year.length === 0 ||
      month.length === 0 ||
      day.length === 0 ||
      hour.length === 0 ||
      minute.length === 0
    ) {
      return null;
    }
    const weekday = new Intl.DateTimeFormat("ja-JP", {
      timeZone,
      weekday: "short",
    }).format(date);
    return `${year}-${month}-${day} (${weekday}) ${hour}:${minute}`;
  } catch {
    return null;
  }
}

/** `YYYY-MM-DD` in `timeZone`, or null when invalid/absent. */
export function formatZonedDate(
  value: string | number,
  timeZone: string,
): string | null {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return null;
  }
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const partValue = (type: Intl.DateTimeFormatPartTypes): string =>
      parts.find((part) => part.type === type)?.value ?? "";
    const year = partValue("year");
    const month = partValue("month");
    const day = partValue("day");
    if (year.length === 0 || month.length === 0 || day.length === 0) {
      return null;
    }
    return `${year}-${month}-${day}`;
  } catch {
    return null;
  }
}

/** ` (記録: YYYY-MM-DD)` in `timeZone`, or null when invalid/absent. */
export function formatMemoryDateSuffix(
  createdAt: string,
  timeZone: string,
): string | null {
  const day = formatZonedDate(createdAt, timeZone);
  return day === null ? null : ` (記録: ${day})`;
}

/** `現在日時: YYYY-MM-DD (曜) HH:MM <tz>`, or null when invalid/absent. */
export function formatCurrentDateTimeLine(
  now: number,
  timeZone: string,
): string | null {
  const dateTime = formatZonedDateTime(now, timeZone);
  return dateTime === null ? null : `現在日時: ${dateTime} ${timeZone}`;
}

/**
 * Strict canonical ISO-8601 instant: exactly the `Date#toISOString` form
 * (UTC, millisecond precision). Offset forms, date-only values, and any
 * non-round-tripping string are treated as absent rather than re-rendered,
 * so recall items never carry a rewritten timestamp.
 */
export function isCanonicalIsoInstant(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 20 || value.length > 30) {
    return false;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

/** Browser/UI default zone (the UI has no server config access). */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
