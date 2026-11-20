// Character card helpers: status meters and the "今日のあなた" block.
// Pure TS (no Svelte); the panel feeds it already-fetched JSON bodies.

export const CHARACTER_METER_CAPS = {
  memory: 200,
  diary: 30,
} as const;

export type CharacterMeterKey = keyof typeof CHARACTER_METER_CAPS;

export interface CharacterMeter {
  readonly key: CharacterMeterKey;
  readonly label: string;
  readonly value: number;
  readonly percent: number;
}

const LABELS: Record<CharacterMeterKey, string> = {
  memory: "記憶",
  diary: "日記",
};

/** Meters for the non-null inputs, in fixed memory→diary order. */
export function buildCharacterMeters(input: {
  readonly activeMemories: number | null;
  readonly diaryEntries: number | null;
}): CharacterMeter[] {
  const raw: ReadonlyArray<readonly [CharacterMeterKey, number | null]> = [
    ["memory", input.activeMemories],
    ["diary", input.diaryEntries],
  ];
  const meters: CharacterMeter[] = [];
  for (const [key, count] of raw) {
    if (count === null) {
      continue;
    }
    const value = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
    const percent = Math.round(
      Math.min(1, value / CHARACTER_METER_CAPS[key]) * 100,
    );
    meters.push({ key, label: LABELS[key], value, percent });
  }
  return meters;
}

function record(body: unknown): Record<string, unknown> | null {
  return typeof body === "object" && body !== null
    ? (body as Record<string, unknown>)
    : null;
}

/** Entry count from `GET /api/diary`; null when malformed. */
export function countDiaryEntries(body: unknown): number | null {
  const items = record(body)?.items;
  return Array.isArray(items) ? items.length : null;
}

export interface CharacterToday {
  readonly day: string;
  readonly companionMessages: readonly string[];
  readonly tasks: readonly string[];
  readonly actions: readonly string[];
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.includes("\0")) {
      return null;
    }
    out.push(entry);
  }
  return out;
}

/** Strict parse of `GET /api/character/today`; null on any deviation. */
export function parseCharacterToday(body: unknown): CharacterToday | null {
  const raw = record(body);
  if (raw === null) {
    return null;
  }
  const { day } = raw;
  const companionMessages = stringList(raw.companionMessages);
  const tasks = stringList(raw.tasks);
  const actions = stringList(raw.actions);
  if (
    typeof day !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
    companionMessages === null ||
    tasks === null ||
    actions === null
  ) {
    return null;
  }
  return { day, companionMessages, tasks, actions };
}

/** One activity line; `day_activity` clips at 300 cp, too long for the card. */
const ACTIVITY_LINE_CP = 48;

/** Labelled lines for the activity block, capped at `max`. */
export function todayLines(today: CharacterToday | null, max = 6): string[] {
  if (today === null) {
    return [];
  }
  const groups: ReadonlyArray<readonly [string, readonly string[]]> = [
    ["声かけ: ", today.companionMessages],
    ["タスク: ", today.tasks],
    ["実行: ", today.actions],
  ];
  const lines: string[] = [];
  for (const [prefix, entries] of groups) {
    for (const entry of entries) {
      if (entry.trim() !== "") {
        lines.push(`${prefix}${bubbleText(entry, ACTIVITY_LINE_CP)}`);
      }
    }
  }
  return lines.slice(0, Math.max(0, max));
}

/** Collapse whitespace and cut to `max` code points with an ellipsis. */
export function bubbleText(text: string, max = 60): string {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  return chars.length > max
    ? `${chars.slice(0, max).join("")}…`
    : chars.join("");
}

/**
 * Active count from `GET /api/memory/stats`; null when malformed. Kept here
 * instead of importing the full memory-stats parser so the lazy character
 * panel does not add a module-preload entry to the first-page bundle.
 */
export function activeMemoryCount(body: unknown): number | null {
  const active = record(record(body)?.byStatus)?.active;
  return typeof active === "number" && Number.isFinite(active) && active >= 0
    ? Math.floor(active)
    : null;
}

/** Japanese relative time for the bubble tag ("3時間前"). */
export function relativeTimeLabel(now: number, then: number): string {
  const sec = Math.max(0, Math.floor((now - then) / 1000));
  if (sec < 60) return "たった今";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}分前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}時間前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day}日前`;
  return new Date(then).toLocaleDateString("ja-JP");
}
