import { isRealDay } from "./day_key.js";

// Pure parsing/formatting for `GET /api/diary` (no Svelte, unit tested).
export interface DiaryEntry {
  day: string;
  body: string;
  createdAt: number;
}

const MAX_ITEMS = 100;
const MAX_BODY_CODE_POINTS = 2000;
const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Strict item validation shared by the list and single-entry parsers. */
function parseEntry(item: unknown): DiaryEntry | null {
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
  return { day, body: text, createdAt };
}

/** Strict: any invalid item invalidates the whole response. */
export function parseDiaryResponse(body: unknown): DiaryEntry[] | null {
  if (typeof body !== "object" || body === null) return null;
  if (!("items" in body)) return null;
  const items = body.items;
  if (!Array.isArray(items) || items.length > MAX_ITEMS) return null;
  const entries: DiaryEntry[] = [];
  for (const item of items) {
    const entry = parseEntry(item);
    if (entry === null) return null;
    entries.push(entry);
  }
  return entries;
}

/** `GET /api/diary/<day>`: entry, explicit `null` (no entry), or `undefined` (invalid). */
export function parseDiaryEntryResponse(
  body: unknown,
): DiaryEntry | null | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  if (!("entry" in body)) return undefined;
  if (body.entry === null) return null;
  return parseEntry(body.entry) ?? undefined;
}

const MONTH_PATTERN = /^(\d{4})-(\d{2})$/;
const SNIPPET_CODE_POINTS = 30;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Sunday-first grid cells for `YYYY-MM`: `null` pads before day 1 and after
 * the last day so the length is always a multiple of 7. Invalid month -> [].
 */
export function monthCells(month: string): Array<string | null> {
  const match = MONTH_PATTERN.exec(month);
  if (match === null) return [];
  const year = Number(match[1]);
  const mon = Number(match[2]);
  if (year < 100 || mon < 1 || mon > 12) return [];
  const lead = new Date(Date.UTC(year, mon - 1, 1)).getUTCDay();
  const days = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  const cells: Array<string | null> = Array.from({ length: lead }, () => null);
  for (let d = 1; d <= days; d++) cells.push(`${month}-${pad2(d)}`);
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

/** `2026-12` + 1 -> `2027-01`; unknown shapes pass through unchanged. */
export function shiftMonth(month: string, delta: number): string {
  const match = MONTH_PATTERN.exec(month);
  if (match === null) return month;
  const total = Number(match[1]) * 12 + Number(match[2]) - 1 + delta;
  return `${String(Math.floor(total / 12)).padStart(4, "0")}-${pad2((total % 12) + 1)}`;
}

/** `2026-11` -> `2026年11月`; unknown shapes pass through unchanged. */
export function formatMonth(month: string): string {
  const match = MONTH_PATTERN.exec(month);
  if (match === null) return month;
  return `${Number(match[1])}年${Number(match[2])}月`;
}

/** One-line calendar-cell preview: heading lines and Markdown markup dropped. */
export function diarySnippet(body: string): string {
  const lines = body.split("\n");
  // Heading-only bodies still get a preview from the heading text.
  const prose = lines.filter((line) => !/^\s*#/.test(line));
  const source = prose.some((line) => line.trim() !== "") ? prose : lines;
  const text = source
    .map((line) => line.replace(/^\s*#+\s*/, "").replace(/^\s*[-+]\s+/, ""))
    .join(" ")
    .replace(/[*>`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const points = [...text];
  return points.length > SNIPPET_CODE_POINTS
    ? `${points.slice(0, SNIPPET_CODE_POINTS).join("")}…`
    : text;
}

/** `2026-11-16` -> `2026年11月16日`; unknown shapes pass through unchanged. */
export function formatDiaryDay(day: string): string {
  const match = DAY_PATTERN.exec(day);
  if (match === null) return day;
  return `${Number(match[1])}年${Number(match[2])}月${Number(match[3])}日`;
}
