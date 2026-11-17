// Read-only episodic (chronological) memory view model.
//
// Episode summaries are a separate reference layer from the semantic graph:
// the server returns bounded snippets only, keyed by an opaque episodeKey.
// This module strictly validates those responses (exact keys, typed fields,
// unexpected fields drop the row) and formats the displayed span. No DOM and
// no Svelte state.

export interface MemoryEpisode {
  readonly episodeKey: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly eventCount: number;
  readonly summarySnippet: string;
  readonly summaryTruncated: boolean;
  readonly stale: boolean;
}

export interface MemoryEpisodeWindow {
  readonly spanStart: number;
  readonly spanEnd: number;
  readonly snippet: string;
  readonly truncated: boolean;
}

export interface EpisodePage<T> {
  readonly items: T[];
  readonly nextCursor: string | null;
}

const EPISODE_KEYS = [
  "episodeKey",
  "startAt",
  "endAt",
  "eventCount",
  "summarySnippet",
  "summaryTruncated",
  "stale",
] as const;

const WINDOW_KEYS = ["spanStart", "spanEnd", "snippet", "truncated"] as const;

/** `null` for anything that is not a plain JSON object. */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/** Exact key set: unknown fields are never ignored. */
function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function isBoundedString(
  value: unknown,
  min: number,
  max: number,
): value is string {
  return (
    typeof value === "string" && value.length >= min && value.length <= max
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isCursor(value: unknown): value is string | null {
  return value === null || isBoundedString(value, 1, 512);
}

function parseEpisode(value: unknown): MemoryEpisode | null {
  const raw = asRecord(value);
  if (raw === null || !hasExactKeys(raw, EPISODE_KEYS)) return null;
  if (
    !isBoundedString(raw.episodeKey, 1, 256) ||
    !isBoundedString(raw.startAt, 20, 40) ||
    !isBoundedString(raw.endAt, 20, 40) ||
    !isNonNegativeInteger(raw.eventCount) ||
    typeof raw.summarySnippet !== "string" ||
    typeof raw.summaryTruncated !== "boolean" ||
    typeof raw.stale !== "boolean"
  ) {
    return null;
  }
  return {
    episodeKey: raw.episodeKey,
    startAt: raw.startAt,
    endAt: raw.endAt,
    eventCount: raw.eventCount,
    summarySnippet: raw.summarySnippet,
    summaryTruncated: raw.summaryTruncated,
    stale: raw.stale,
  };
}

function parseWindow(value: unknown): MemoryEpisodeWindow | null {
  const raw = asRecord(value);
  if (raw === null || !hasExactKeys(raw, WINDOW_KEYS)) return null;
  if (
    !isNonNegativeInteger(raw.spanStart) ||
    !isNonNegativeInteger(raw.spanEnd) ||
    typeof raw.snippet !== "string" ||
    typeof raw.truncated !== "boolean"
  ) {
    return null;
  }
  return {
    spanStart: raw.spanStart,
    spanEnd: raw.spanEnd,
    snippet: raw.snippet,
    truncated: raw.truncated,
  };
}

function parsePage<T>(
  value: unknown,
  parseItem: (item: unknown) => T | null,
): EpisodePage<T> | null {
  const raw = asRecord(value);
  if (
    raw === null ||
    !hasExactKeys(raw, ["items", "nextCursor"]) ||
    !Array.isArray(raw.items) ||
    !isCursor(raw.nextCursor)
  ) {
    return null;
  }
  const items: T[] = [];
  for (const item of raw.items) {
    const parsed = parseItem(item);
    if (parsed !== null) items.push(parsed);
  }
  return { items, nextCursor: raw.nextCursor };
}

/** Malformed rows are dropped; a malformed envelope means "not a response". */
export function parseEpisodePage(
  value: unknown,
): EpisodePage<MemoryEpisode> | null {
  return parsePage(value, parseEpisode);
}

export function parseEpisodeWindowsPage(
  value: unknown,
): EpisodePage<MemoryEpisodeWindow> | null {
  return parsePage(value, parseWindow);
}

/** `YYYY-MM-DD HH:mm` in the viewer's local time, or null for an invalid ISO. */
function formatInstant(value: string): string | null {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const pad = (part: number): string => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Displayed episode period; unparseable instants are shown as unknown. */
export function formatEpisodePeriod(startAt: string, endAt: string): string {
  const start = formatInstant(startAt);
  const end = formatInstant(endAt);
  if (start === null || end === null) return "期間不明";
  return `${start} – ${end}`;
}
