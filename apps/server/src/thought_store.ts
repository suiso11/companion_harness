// Companion private thought journal (internal only).
//
// This is deliberately NOT user memory: thoughts never enter remind and are
// never written by the model directly. The service validates every field
// before insert; reads are bounded. `body` is a short note, `sources_json`
// holds bounded web title/url pairs, and `memory_ids_json` holds the opaque
// remind record ids the note was based on.

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export type ThoughtKind = "survey" | "question" | "hypothesis" | "observation";

export interface ThoughtSource {
  readonly title: string | null;
  readonly url: string;
}

export interface ThoughtInput {
  readonly sessionId: string;
  readonly kind: ThoughtKind;
  readonly body: string;
  readonly topics: readonly string[];
  readonly memoryIds: readonly string[];
  readonly sources: readonly ThoughtSource[];
  readonly now: number;
}

export interface ThoughtRow {
  readonly id: string;
  readonly sessionId: string;
  readonly speechSessionId: string | null;
  readonly kind: ThoughtKind;
  readonly body: string;
  readonly topics: string[];
  readonly memoryIds: string[];
  readonly sources: ThoughtSource[];
  readonly status: "open" | "asked" | "answered" | "archived";
  readonly createdAt: number;
  readonly askedAt: number | null;
  readonly replyAt: number | null;
  readonly replyTurnId: string | null;
  readonly speechTurnId: string | null;
  readonly outcome: "replied" | "ignored" | "refused" | null;
}

export interface ThoughtStore {
  insert(input: ThoughtInput): ThoughtRow;
  get(id: string): ThoughtRow | null;
  listOpen(limit?: number): ThoughtRow[];
  markAsked(id: string, at: number, turnId: string, sessionId: string): boolean;
  markReplied(id: string, at: number, turnId: string): boolean;
  markIgnored(id: string): boolean;
  listAskedWithoutReply(limit?: number): ThoughtRow[];
  lastSpeechAt(): number | null;
  lastThoughtAt(): number | null;
  countAskedSince(since: number): number;
  lastUserTurnAt(sessionId: string): number | null;
  lastTurnKind(sessionId: string): string | null;
  findUserTurnAfter(
    sessionId: string,
    after: number,
  ): {
    turnId: string;
    createdAt: number;
  } | null;
}

const THOUGHT_KINDS: readonly ThoughtKind[] = [
  "survey",
  "question",
  "hypothesis",
  "observation",
];

export function isThoughtKind(value: unknown): value is ThoughtKind {
  return (
    typeof value === "string" &&
    (THOUGHT_KINDS as readonly string[]).includes(value)
  );
}
const MAX_BODY_CP = 2000;
const MAX_TOPICS = 3;
const MAX_TOPIC_CP = 32;
const MAX_MEMORY_IDS = 20;
const MAX_SOURCES = 5;
const MAX_TITLE_CP = 200;
const MAX_URL_CP = 2048;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cpLength(text: string): number {
  return Array.from(text).length;
}

function boundedText(value: unknown, min: number, max: number): string | null {
  if (typeof value !== "string") return null;
  const size = cpLength(value);
  if (size < min || size > max) return null;
  if (value.includes("\0")) return null;
  return value;
}

function parseJsonArray(raw: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function rowFrom(raw: {
  id: string;
  session_id: string;
  kind: string;
  body: string;
  topics_json: string;
  memory_ids_json: string;
  sources_json: string;
  status: string;
  created_at: number;
  asked_at: number | null;
  reply_at: number | null;
  reply_turn_id: string | null;
  speech_turn_id: string | null;
  speech_session_id: string | null;
  outcome: string | null;
}): ThoughtRow {
  const topics = parseJsonArray(raw.topics_json).filter(
    (v): v is string => typeof v === "string",
  );
  const memoryIds = parseJsonArray(raw.memory_ids_json).filter(
    (v): v is string => typeof v === "string",
  );
  const sources = parseJsonArray(raw.sources_json).flatMap((value) => {
    if (typeof value !== "object" || value === null) return [];
    const record = value as { title?: unknown; url?: unknown };
    if (typeof record.url !== "string") return [];
    return [
      {
        title: typeof record.title === "string" ? record.title : null,
        url: record.url,
      },
    ];
  });
  return {
    id: raw.id,
    sessionId: raw.session_id,
    speechSessionId: raw.speech_session_id,
    kind: raw.kind as ThoughtKind,
    body: raw.body,
    topics,
    memoryIds,
    sources,
    status: raw.status as ThoughtRow["status"],
    createdAt: raw.created_at,
    askedAt: raw.asked_at,
    replyAt: raw.reply_at,
    replyTurnId: raw.reply_turn_id,
    speechTurnId: raw.speech_turn_id,
    outcome: raw.outcome as ThoughtRow["outcome"],
  };
}

export function createThoughtStore(db: Database.Database): ThoughtStore {
  function insert(input: ThoughtInput): ThoughtRow {
    if (!UUID_RE.test(input.sessionId))
      throw new Error("thought session invalid");
    if (!isThoughtKind(input.kind)) throw new Error("thought kind invalid");
    const body = boundedText(input.body, 1, MAX_BODY_CP);
    if (body === null) throw new Error("thought body invalid");
    if (input.topics.length > MAX_TOPICS)
      throw new Error("thought topics invalid");
    const topics = input.topics.map((topic) => {
      const value = boundedText(topic, 1, MAX_TOPIC_CP);
      if (value === null) throw new Error("thought topic invalid");
      return value;
    });
    if (input.memoryIds.length > MAX_MEMORY_IDS) {
      throw new Error("thought memory ids invalid");
    }
    const memoryIds = input.memoryIds.map((id) => {
      const value = boundedText(id, 1, 128);
      if (value === null) throw new Error("thought memory id invalid");
      return value;
    });
    if (input.sources.length > MAX_SOURCES) {
      throw new Error("thought sources invalid");
    }
    const sources = input.sources.map((source) => {
      const url = boundedText(source.url, 1, MAX_URL_CP);
      if (url === null || !/^https?:\/\//i.test(url)) {
        throw new Error("thought source url invalid");
      }
      const title =
        source.title === null
          ? null
          : boundedText(source.title, 0, MAX_TITLE_CP);
      if (source.title !== null && title === null) {
        throw new Error("thought source title invalid");
      }
      return { title, url };
    });
    const id = randomUUID();
    db.prepare(
      `INSERT INTO companion_thoughts(
         id, session_id, kind, body, topics_json, memory_ids_json,
         sources_json, status, created_at, asked_at, reply_at,
         reply_turn_id, speech_turn_id, speech_session_id, outcome)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, NULL, NULL, NULL, NULL, NULL, NULL)`,
    ).run(
      id,
      input.sessionId,
      input.kind,
      body,
      JSON.stringify(topics),
      JSON.stringify(memoryIds),
      JSON.stringify(sources),
      input.now,
    );
    const row = get(id);
    if (row === null) throw new Error("thought insert failed");
    return row;
  }

  function get(id: string): ThoughtRow | null {
    if (!UUID_RE.test(id)) return null;
    const row = db
      .prepare(`SELECT * FROM companion_thoughts WHERE id = ?`)
      .get(id) as Parameters<typeof rowFrom>[0] | undefined;
    return row === undefined ? null : rowFrom(row);
  }

  function page(
    sql: string,
    limit: number,
    ...args: Array<string | number>
  ): ThoughtRow[] {
    const capped = Math.max(1, Math.min(20, Math.floor(limit)));
    const rows = db.prepare(`${sql} LIMIT ?`).all(...args, capped) as Array<
      Parameters<typeof rowFrom>[0]
    >;
    return rows.map(rowFrom);
  }

  return {
    insert,
    get,
    listOpen: (limit = 10) =>
      page(
        `SELECT * FROM companion_thoughts WHERE status = 'open' ORDER BY created_at ASC, id ASC`,
        limit,
      ),
    markAsked: (id, at, turnId, sessionId) => {
      if (
        !UUID_RE.test(id) ||
        !UUID_RE.test(turnId) ||
        !UUID_RE.test(sessionId)
      ) {
        return false;
      }
      const result = db
        .prepare(
          `UPDATE companion_thoughts
           SET status = 'asked', asked_at = ?, speech_turn_id = ?,
               speech_session_id = ?
           WHERE id = ? AND status = 'open' AND asked_at IS NULL`,
        )
        .run(at, turnId, sessionId, id);
      return result.changes === 1;
    },
    markReplied: (id, at, turnId) => {
      if (!UUID_RE.test(id) || !UUID_RE.test(turnId)) return false;
      const result = db
        .prepare(
          `UPDATE companion_thoughts
           SET status = 'answered', reply_at = ?, reply_turn_id = ?, outcome = 'replied'
           WHERE id = ? AND status = 'asked' AND reply_at IS NULL`,
        )
        .run(at, turnId, id);
      return result.changes === 1;
    },
    markIgnored: (id) => {
      if (!UUID_RE.test(id)) return false;
      const result = db
        .prepare(
          `UPDATE companion_thoughts SET outcome = 'ignored'
           WHERE id = ? AND status = 'asked' AND reply_at IS NULL AND outcome IS NULL`,
        )
        .run(id);
      return result.changes === 1;
    },
    listAskedWithoutReply: (limit = 10) =>
      page(
        `SELECT * FROM companion_thoughts
         WHERE status = 'asked' AND reply_at IS NULL AND outcome IS NULL
         ORDER BY asked_at ASC, id ASC`,
        limit,
      ),
    lastSpeechAt: () => {
      const row = db
        .prepare(`SELECT MAX(asked_at) AS at FROM companion_thoughts`)
        .get() as { at: number | null } | undefined;
      return row?.at ?? null;
    },
    lastThoughtAt: () => {
      const row = db
        .prepare(`SELECT MAX(created_at) AS at FROM companion_thoughts`)
        .get() as { at: number | null } | undefined;
      return row?.at ?? null;
    },
    countAskedSince: (since) => {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS n FROM companion_thoughts WHERE asked_at IS NOT NULL AND asked_at >= ?`,
        )
        .get(since) as { n: number };
      return row.n;
    },
    lastUserTurnAt: (sessionId) => {
      if (!UUID_RE.test(sessionId)) return null;
      const row = db
        .prepare(
          `SELECT created_at FROM turns
           WHERE session_id = ?
             AND json_extract(input_json, '$.kind') = 'user_text'
           ORDER BY created_at DESC, id DESC LIMIT 1`,
        )
        .get(sessionId) as { created_at: number } | undefined;
      return row?.created_at ?? null;
    },
    lastTurnKind: (sessionId) => {
      if (!UUID_RE.test(sessionId)) return null;
      const row = db
        .prepare(
          `SELECT json_extract(input_json, '$.kind') AS kind FROM turns
           WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
        )
        .get(sessionId) as { kind: string | null } | undefined;
      return row?.kind ?? null;
    },
    findUserTurnAfter: (sessionId, after) => {
      if (!UUID_RE.test(sessionId)) return null;
      const row = db
        .prepare(
          `SELECT id, created_at FROM turns
           WHERE session_id = ? AND created_at > ?
             AND json_extract(input_json, '$.kind') = 'user_text'
           ORDER BY created_at ASC, id ASC LIMIT 1`,
        )
        .get(sessionId, after) as
        | { id: string; created_at: number }
        | undefined;
      return row === undefined
        ? null
        : { turnId: row.id, createdAt: row.created_at };
    },
  };
}
