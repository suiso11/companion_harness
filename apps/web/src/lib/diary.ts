// Pure parsing/formatting for `GET /api/diary` (no Svelte, unit tested).
export interface DiaryEntry {
  day: string;
  body: string;
  createdAt: number;
}

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_ITEMS = 100;
const MAX_BODY_CODE_POINTS = 2000;

/** `2026-02-30` matches the pattern but is not a calendar date. */
function isRealDay(day: string): boolean {
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

/** Strict: any invalid item invalidates the whole response. */
export function parseDiaryResponse(body: unknown): DiaryEntry[] | null {
  if (typeof body !== "object" || body === null) return null;
  if (!("items" in body)) return null;
  const items = body.items;
  if (!Array.isArray(items) || items.length > MAX_ITEMS) return null;
  const entries: DiaryEntry[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) return null;
    if (!("day" in item && "body" in item && "createdAt" in item)) return null;
    const { day, body: text, createdAt } = item;
    if (typeof day !== "string" || !isRealDay(day)) return null;
    if (typeof text !== "string") return null;
    // Code points, not UTF-16 units: the server bounds the same way.
    const length = [...text].length;
    if (length < 1 || length > MAX_BODY_CODE_POINTS) return null;
    if (
      typeof createdAt !== "number" ||
      !Number.isInteger(createdAt) ||
      createdAt < 0
    ) {
      return null;
    }
    entries.push({ day, body: text, createdAt });
  }
  return entries;
}

/** `2026-11-16` -> `2026年11月16日`; unknown shapes pass through unchanged. */
export function formatDiaryDay(day: string): string {
  const match = DAY_PATTERN.exec(day);
  if (match === null) return day;
  return `${Number(match[1])}年${Number(match[2])}月${Number(match[3])}日`;
}
