/**
 * Boring calendar time primitives shared by the input mapper and the event
 * normalizer. No I/O, no clock, no locale/timezone reconstruction.
 *
 * Explicit-offset RFC3339 timestamps are the only accepted timed form
 * (timezone-naive strings are rejected here, never resolved against a host or
 * frozen zone). All-day DATE values stay DATE strings. Calendar-component
 * validation is explicit (leap years, month lengths, hour/minute/second
 * bounds, offset bounds) and does NOT rely on `Date.parse` permissiveness.
 */

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIMED =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * IANA shape copied from the existing server/contracts convention
 * (`UTC` or `Area/Location`), NOT a dependency on the server package.
 * Numeric/offset-only identifiers (e.g. `+09:00`) are rejected by shape.
 */
const IANA_SHAPE = /^(UTC|[A-Za-z_][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)+)$/;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  return 31;
}

/**
 * Year-safe UTC epoch ms. `Date.UTC` maps years 0..99 to 1900..1999, so for
 * early years the full year/month/day AND the time-of-day are written
 * explicitly on a known epoch. Setting only the year is not enough: 1900 is
 * not a leap year, so `0000-02-29` would be rolled to March 1 before the year
 * was corrected.
 */
function utcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  ms: number,
): number {
  if (year >= 100) {
    return Date.UTC(year, month - 1, day, hour, minute, second, ms);
  }
  const fixed = new Date(0);
  fixed.setUTCFullYear(year, month - 1, day);
  fixed.setUTCHours(hour, minute, second, ms);
  return fixed.getTime();
}

/** Real all-day DATE (YYYY-MM-DD) to midnight UTC ms, or undefined. */
export function parseDateOnly(value: string): number | undefined {
  const m = DATE_ONLY.exec(value);
  if (m === null) return undefined;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) return undefined;
  if (day < 1 || day > daysInMonth(year, month)) return undefined;
  return utcMs(year, month, day, 0, 0, 0, 0);
}

/**
 * Explicit-offset RFC3339 timestamp to epoch ms, or undefined. Rejects
 * impossible calendar dates, out-of-range components and offsets, and any
 * string without an explicit `Z`/`±HH:MM` offset.
 */
export function parseTimedInstant(value: string): number | undefined {
  const m = TIMED.exec(value);
  if (m === null) return undefined;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  if (month < 1 || month > 12) return undefined;
  if (day < 1 || day > daysInMonth(year, month)) return undefined;
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  const fraction = m[7];
  // Milliseconds are exactly the first three decimal digits, right-padded.
  // Parsing `0.<fraction>` as a float can round up to the next second (e.g.
  // `.999999999999999999`), so take the digits as a bounded small integer.
  const ms =
    fraction !== undefined ? Number(fraction.slice(1, 4).padEnd(3, "0")) : 0;
  // Group 8 `(Z|[+-]\d{2}:\d{2})` is mandatory, so the capture is always a string.
  const zone = m[8] as string;
  let offsetMs = 0;
  if (zone !== "Z") {
    const sign = zone.startsWith("-") ? -1 : 1;
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return undefined;
    offsetMs = sign * (offsetHour * 60 + offsetMinute) * 60_000;
  }
  const msValue = utcMs(year, month, day, hour, minute, second, ms) - offsetMs;
  return Number.isFinite(msValue) ? msValue : undefined;
}

/** Canonical UTC ISO representation of a validated instant. */
export function canonicalUtcIso(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

/**
 * True when `value` is an IANA-shaped name AND a real `Intl` membership.
 * `UTC` is accepted by shape; numeric/offset identifiers are not.
 */
export function isIanaTimeZone(value: string): boolean {
  if (value.length === 0 || value.length > 128) return false;
  if (!IANA_SHAPE.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
