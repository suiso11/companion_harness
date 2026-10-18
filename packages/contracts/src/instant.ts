/**
 * Shared strict RFC3339 instant contract (B2/C10-08, 2026-10-18).
 *
 * ONE calendar-validated, explicit-offset instant parser shared by every
 * inbound instant path: the readonly consumer input (`calendar.search`
 * start/end), the provider readonly output normalization (candidate event
 * `start`/`end`/`updated`), the M5 proposal staging boundaries, the dedicated
 * write ports (`reschedule-event` / `create-event` inputs), and the kernel's
 * read-back comparisons / autonomy deadlines. Previously each of those paths
 * carried its own near-identical regex + epoch-ms parser (or silently
 * truncated fine-than-ms fractions); this module is now the single source so
 * the rules can never diverge again.
 *
 * Grammar (mirrors the former `packages/connector-calendar/src/
 * rescheduleWrite.ts` `isStrictCalendarInstant` wire contract exactly):
 *   - `YYYY-MM-DDTHH:MM:SS(.fraction)?(Z|±HH:MM)` — seconds precision with an
 *     optional fraction, or minute precision `YYYY-MM-DDTHH:MM(Z|±HH:MM)`.
 *   - Real calendar validation: month lengths, leap years, component bounds,
 *     offset bounds. `Date.parse` rollover (`2023-02-30` -> March 2) is
 *     rejected, never accepted.
 *   - Precision rule: a fraction is accepted ONLY when it is
 *     millisecond-expressible (`isStrictCalendarInstant` trailing-zero rule —
 *     a nonzero digit past the millisecond position, e.g. `.1234`, is
 *     genuine sub-millisecond precision and is REJECTED, never truncated
 *     silently). `.12`, `.123` and `.123000` all name the same ms and are
 *     accepted; genuine sub-ms names no expressible instant.
 *   - Length bound: non-empty, at most 128 chars.
 *   - All-day DATE strings, timezone-naive strings and empty strings are
 *     rejected (fail closed), never resolved against a host zone.
 *
 * Pure: no I/O, no clock, no locale/timezone reconstruction, no imports.
 */

const STRICT_INSTANT_SECONDS =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const STRICT_INSTANT_MINUTES =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(Z|[+-]\d{2}:\d{2})$/;
const SUBSECOND_FRACTION = /T\d{2}:\d{2}:\d{2}\.(\d+)/;

/** True when `value` carries genuine sub-millisecond precision. */
function hasSubMillisecondPrecision(value: string): boolean {
  const match = SUBSECOND_FRACTION.exec(value);
  if (match === null) return false;
  const digits = match[1] as string;
  return digits.length > 3 && /[^0]/.test(digits.slice(3));
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInStrictMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  return 31;
}

/**
 * Year-safe UTC epoch ms. `Date.UTC` maps years 0..99 to 1900..1999, so for
 * early years the full year/month/day AND the time-of-day are written
 * explicitly on a known epoch. Setting only the year is not enough: 1900 is
 * not a leap year, so `0000-02-29` would be rolled to March 1 before the
 * year was corrected.
 */
function strictUtcMs(
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

/**
 * Strict explicit-offset RFC3339 instant to epoch ms, or `undefined`.
 * Whole seconds and millisecond-expressible fractions (trailing-zero tails
 * included) parse to their exact epoch ms; genuine sub-millisecond input,
 * impossible calendar values, missing offsets, all-day dates and overlong
 * strings all return `undefined` (fail closed) — never a silent truncate
 * of the fraction, never a loose `Date.parse` on the seconds form.
 */
export function parseStrictCalendarInstantMs(
  value: string,
): number | undefined {
  if (value.length === 0 || value.length > 128) return undefined;
  if (hasSubMillisecondPrecision(value)) return undefined;
  const seconds = STRICT_INSTANT_SECONDS.exec(value);
  if (seconds !== null) {
    const year = Number(seconds[1]);
    const month = Number(seconds[2]);
    const day = Number(seconds[3]);
    const hour = Number(seconds[4]);
    const minute = Number(seconds[5]);
    const second = Number(seconds[6]);
    if (month < 1 || month > 12) return undefined;
    if (day < 1 || day > daysInStrictMonth(year, month)) return undefined;
    if (hour > 23 || minute > 59 || second > 59) return undefined;
    // The sub-ms gate above guarantees ms-expressibility, so taking the
    // first three decimal digits, right-padded, is exact (float parsing
    // could round up into the next second; digit arithmetic cannot).
    const fraction = seconds[7] as string | undefined;
    const ms =
      fraction !== undefined ? Number(fraction.slice(1, 4).padEnd(3, "0")) : 0;
    const zone = seconds[8] as string;
    let offsetMs = 0;
    if (zone !== "Z") {
      const sign = zone.startsWith("-") ? -1 : 1;
      const offsetHour = Number(zone.slice(1, 3));
      const offsetMinute = Number(zone.slice(4, 6));
      if (offsetHour > 23 || offsetMinute > 59) return undefined;
      offsetMs = sign * (offsetHour * 60 + offsetMinute) * 60_000;
    }
    const epochMs =
      strictUtcMs(year, month, day, hour, minute, second, ms) - offsetMs;
    return Number.isFinite(epochMs) ? epochMs : undefined;
  }
  const minutes = STRICT_INSTANT_MINUTES.exec(value);
  if (minutes === null) return undefined;
  const year = Number(minutes[1]);
  const month = Number(minutes[2]);
  const day = Number(minutes[3]);
  const hour = Number(minutes[4]);
  const minute = Number(minutes[5]);
  if (month < 1 || month > 12) return undefined;
  if (day < 1 || day > daysInStrictMonth(year, month)) return undefined;
  if (hour > 23 || minute > 59) return undefined;
  const zone = minutes[6] as string;
  if (zone !== "Z") {
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return undefined;
  }
  const epochMs = Date.parse(value);
  return Number.isNaN(epochMs) ? undefined : epochMs;
}

/**
 * True for a strict, explicit-offset, millisecond-expressible RFC3339
 * instant under the shared grammar above. The single named predicate every
 * inbound instant path validates through (the write wire contract name the
 * connector and kernel tests already pin).
 */
export function isStrictCalendarInstant(value: string): boolean {
  return parseStrictCalendarInstantMs(value) !== undefined;
}
