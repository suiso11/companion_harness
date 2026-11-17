// Companion private diary.
//
// Exactly one entry per local calendar day (primary key), so a concurrent
// second writer is a safe no-op. This is the companion's own first-person
// diary, NOT user memory: the model never writes here directly, the service
// validates every field before insert, and the owner reads it back through
// GET /api/diary.

import type Database from "better-sqlite3";

export interface DiaryEntry {
  readonly day: string;
  readonly body: string;
  readonly createdAt: number;
}

export interface DiaryStore {
  get(day: string): DiaryEntry | null;
  insert(day: string, body: string, now: number): DiaryEntry | null;
  list(limit?: number): DiaryEntry[];
  /** Entries of one YYYY-MM month, day ascending. */
  listMonth(month: string): DiaryEntry[];
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_LIST_LIMIT = 30;
const MAX_LIST_LIMIT = 100;
const MAX_BODY_CP = 2000;
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** YYYY-MM-DD that is also a real calendar date (no 2026-02-30 rollover). */
export function isDiaryDay(value: string): boolean {
  if (!DAY_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

export function createDiaryStore(db: Database.Database): DiaryStore {
  function get(day: string): DiaryEntry | null {
    if (!isDiaryDay(day)) return null;
    const row = db
      .prepare(
        `SELECT day, body, created_at FROM companion_diary WHERE day = ?`,
      )
      .get(day) as
      | { day: string; body: string; created_at: number }
      | undefined;
    return row === undefined
      ? null
      : { day: row.day, body: row.body, createdAt: row.created_at };
  }

  function insert(day: string, body: string, now: number): DiaryEntry | null {
    if (!isDiaryDay(day)) throw new Error("diary day invalid");
    const size = Array.from(body).length;
    if (size < 1 || size > MAX_BODY_CP || body.includes("\0")) {
      throw new Error("diary body invalid");
    }
    if (!Number.isInteger(now) || now < 0) throw new Error("diary now invalid");
    const result = db
      .prepare(
        `INSERT INTO companion_diary(day, body, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(day) DO NOTHING`,
      )
      .run(day, body, now);
    return result.changes === 1 ? { day, body, createdAt: now } : null;
  }

  function list(limit = DEFAULT_LIST_LIMIT): DiaryEntry[] {
    const capped = Number.isFinite(limit)
      ? Math.max(1, Math.min(MAX_LIST_LIMIT, Math.floor(limit)))
      : DEFAULT_LIST_LIMIT;
    const rows = db
      .prepare(
        `SELECT day, body, created_at FROM companion_diary ORDER BY day DESC LIMIT ?`,
      )
      .all(capped) as Array<{ day: string; body: string; created_at: number }>;
    return rows.map((row) => ({
      day: row.day,
      body: row.body,
      createdAt: row.created_at,
    }));
  }

  function listMonth(month: string): DiaryEntry[] {
    const m = MONTH_RE.exec(month);
    if (m === null) throw new Error("diary month invalid");
    const year = Number(m[1]);
    const mon = Number(m[2]);
    const next =
      mon === 12
        ? `${String(year + 1).padStart(4, "0")}-01`
        : `${m[1]}-${String(mon + 1).padStart(2, "0")}`;
    const rows = db
      .prepare(
        `SELECT day, body, created_at FROM companion_diary
          WHERE day >= ? AND day < ? ORDER BY day ASC`,
      )
      .all(`${month}-01`, `${next}-01`) as Array<{
      day: string;
      body: string;
      created_at: number;
    }>;
    return rows.map((row) => ({
      day: row.day,
      body: row.body,
      createdAt: row.created_at,
    }));
  }

  return { get, insert, list, listMonth };
}
