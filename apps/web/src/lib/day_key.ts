// Calendar-day key validation shared by the router (entry bundle) and the
// diary view models (lazy chunks). Kept in its own module so the router does
// not pull the whole diary view-model into the page entry bundle.

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `2026-02-30` matches the pattern but is not a calendar date. */
export function isRealDay(day: string): boolean {
  const match = DAY_PATTERN.exec(day);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const date = Number(match[3]);
  // Fewer than 100 years: Date.UTC would otherwise map 0-99 to 1900-1999.
  if (year < 100) return false;
  const utc = new Date(Date.UTC(year, month - 1, date));
  return (
    utc.getUTCFullYear() === year &&
    utc.getUTCMonth() === month - 1 &&
    utc.getUTCDate() === date
  );
}
