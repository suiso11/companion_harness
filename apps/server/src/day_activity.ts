// Read-only per-day activity summary feeding the companion diary.
//
// Every repository list method is session-scoped, but a diary day spans
// sessions, so this store reads raw rows over a bounded UTC window around the
// day and re-checks each timestamp with the caller's local-day function (no
// timezone math in SQL). It never writes and never throws: any failure
// degrades to empty arrays so a diary pass cannot be broken by it.

import type Database from "better-sqlite3";

export interface DayActivity {
  readonly companionMessages: string[];
  readonly tasks: string[];
  readonly actions: string[];
}

export interface DayActivityStore {
  read(day: string, dayOf: (at: number) => string): DayActivity;
}

const DAY_MS = 86_400_000;
const WINDOW_DAYS = 2;
const SCAN_LIMIT = 60;
const MAX_MESSAGES = 8;
const MESSAGE_CP = 300;
const MAX_TASKS = 12;
const MAX_TASK_LINES = 16;
const TASK_LINE_CP = 160;
const MAX_ACTION_LINES = 6;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** One-line, NUL-free text clipped to `max` code points; null when empty. */
function clip(value: unknown, max: number): string | null {
  if (typeof value !== "string" || value.includes("\0")) return null;
  const flat = value.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return null;
  return Array.from(flat).slice(0, max).join("");
}

export function createDayActivityStore(
  db: Database.Database,
): DayActivityStore {
  function window(day: string): [number, number] | null {
    const m = DAY_RE.exec(day);
    if (m === null) return null;
    const start = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (!Number.isFinite(start)) return null;
    return [start - WINDOW_DAYS * DAY_MS, start + (WINDOW_DAYS + 1) * DAY_MS];
  }

  function companionMessages(
    from: number,
    to: number,
    day: string,
    dayOf: (at: number) => string,
  ): string[] {
    const rows = db
      .prepare(
        `SELECT json_extract(t.input_json, '$.text') AS text, t.created_at AS at
           FROM turns t JOIN sessions s ON s.id = t.session_id
          WHERE s.hidden = 0
            AND json_extract(t.input_json, '$.kind') = 'companion_text'
            AND t.created_at >= ? AND t.created_at < ?
          ORDER BY t.created_at DESC LIMIT ?`,
      )
      .all(from, to, SCAN_LIMIT) as Array<{ text: unknown; at: number }>;
    const out: string[] = [];
    for (const row of rows) {
      if (out.length >= MAX_MESSAGES) break;
      if (dayOf(row.at) !== day) continue;
      const text = clip(row.text, MESSAGE_CP);
      if (text !== null) out.push(text);
    }
    return out.reverse();
  }

  function tasks(
    from: number,
    to: number,
    day: string,
    dayOf: (at: number) => string,
  ): string[] {
    const out: string[] = [];
    const taskRows = db
      .prepare(
        `SELECT a.title, a.kind, a.status, a.created_at, a.updated_at
           FROM autonomy_tasks a JOIN sessions s ON s.id = a.session_id
          WHERE s.hidden = 0
            AND ((a.created_at >= ? AND a.created_at < ?)
              OR (a.updated_at >= ? AND a.updated_at < ?))
          ORDER BY a.updated_at DESC LIMIT ?`,
      )
      .all(from, to, from, to, SCAN_LIMIT) as Array<{
      title: string;
      kind: string;
      status: string;
      created_at: number;
      updated_at: number;
    }>;
    for (const row of taskRows) {
      if (out.length >= MAX_TASKS) break;
      if (dayOf(row.created_at) !== day && dayOf(row.updated_at) !== day) {
        continue;
      }
      const line = clip(
        `- [${row.status}] ${row.kind}: ${row.title}`,
        TASK_LINE_CP,
      );
      if (line !== null) out.push(line);
    }
    const eventRows = db
      .prepare(
        `SELECT a.title, e.event, e.to_status, e.note, e.created_at
           FROM autonomy_task_events e
           JOIN autonomy_tasks a ON a.session_id = e.session_id AND a.id = e.task_id
           JOIN sessions s ON s.id = e.session_id
          WHERE s.hidden = 0 AND e.created_at >= ? AND e.created_at < ?
          ORDER BY e.created_at ASC LIMIT ?`,
      )
      .all(from, to, SCAN_LIMIT) as Array<{
      title: string;
      event: string;
      to_status: string;
      note: string | null;
      created_at: number;
    }>;
    for (const row of eventRows) {
      if (out.length >= MAX_TASK_LINES) break;
      if (dayOf(row.created_at) !== day) continue;
      const note = clip(row.note, TASK_LINE_CP);
      const line = clip(
        `- ${row.title}: ${row.event} -> ${row.to_status}${note === null ? "" : ` (${note})`}`,
        TASK_LINE_CP,
      );
      if (line !== null) out.push(line);
    }
    return out;
  }

  function actions(
    from: number,
    to: number,
    day: string,
    dayOf: (at: number) => string,
  ): string[] {
    const rows = db
      .prepare(
        `SELECT x.status AS status, COALESCE(x.finished_at, x.created_at) AS at
           FROM action_executions x JOIN sessions s ON s.id = x.session_id
          WHERE s.hidden = 0
            AND COALESCE(x.finished_at, x.created_at) >= ?
            AND COALESCE(x.finished_at, x.created_at) < ?
          LIMIT 500`,
      )
      .all(from, to) as Array<{ status: string; at: number }>;
    const counts = new Map<string, number>();
    for (const row of rows) {
      if (dayOf(row.at) !== day) continue;
      counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
    }
    return [...counts]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, MAX_ACTION_LINES)
      .map(([status, count]) => `${status} ${count}`);
  }

  function read(day: string, dayOf: (at: number) => string): DayActivity {
    const range = window(day);
    const empty = (): DayActivity => ({
      companionMessages: [],
      tasks: [],
      actions: [],
    });
    if (range === null) return empty();
    const [from, to] = range;
    // Each source degrades independently to empty.
    const safe = (fn: () => string[]): string[] => {
      try {
        return fn();
      } catch {
        return [];
      }
    };
    return {
      companionMessages: safe(() => companionMessages(from, to, day, dayOf)),
      tasks: safe(() => tasks(from, to, day, dayOf)),
      actions: safe(() => actions(from, to, day, dayOf)),
    };
  }

  return { read };
}
