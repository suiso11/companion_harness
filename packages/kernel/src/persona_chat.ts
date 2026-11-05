// Persona chat store: personas, chats and message history (migration 0044).
// Deletes rely on FK cascade (connection.ts sets foreign_keys=ON).

import { randomUUID } from "node:crypto";
import {
  ChatClientKeySchema,
  type ChatMessageSchema,
  ChatMessageTextSchema,
  type ChatSummarySchema,
  ChatTitleSchema,
  CreatePersonaRequestSchema,
  type PersonaSchema,
} from "@companion/contracts";
import type Database from "better-sqlite3";
import type { z } from "zod";

export type PersonaRow = z.infer<typeof PersonaSchema>;
export type ChatSummaryRow = z.infer<typeof ChatSummarySchema>;
export type ChatMessageRow = z.infer<typeof ChatMessageSchema>;
export type PersonaInput = z.infer<typeof CreatePersonaRequestSchema>;

export type PersonaChatStoreErrorCode =
  | "invalid_persona"
  | "invalid_title"
  | "invalid_text"
  | "invalid_client_key"
  | "invalid_cursor"
  | "chat_not_found";

const MESSAGES: Record<PersonaChatStoreErrorCode, string> = {
  invalid_persona: "invalid persona",
  invalid_title: "invalid chat title",
  invalid_text: "invalid message text",
  invalid_client_key: "invalid client key",
  invalid_cursor: "invalid message cursor",
  chat_not_found: "chat not found",
};

export class PersonaChatStoreError extends Error {
  constructor(readonly code: PersonaChatStoreErrorCode) {
    super(MESSAGES[code]);
    this.name = "PersonaChatStoreError";
  }
}

export interface PersonaChatStore {
  listPersonas(): PersonaRow[];
  getPersona(id: string): PersonaRow | null;
  createPersona(input: PersonaInput, now: number): PersonaRow;
  updatePersona(
    id: string,
    input: PersonaInput,
    now: number,
  ): PersonaRow | null;
  deletePersona(id: string): boolean;
  listChats(): ChatSummaryRow[];
  getChat(id: string): ChatSummaryRow | null;
  createChat(
    personaId: string,
    title: string | undefined,
    now: number,
    options?: { partnerId?: string; autotalk?: boolean },
  ): ChatSummaryRow | null;
  setAutotalk(
    chatId: string,
    autotalk: boolean,
    now: number,
  ): ChatSummaryRow | null;
  /** autotalk chats with a partner whose newest message is older than cutoff (or none yet). */
  listAutotalkDue(cutoff: number, limit: number): ChatSummaryRow[];
  appendParticipantMessage(
    chatId: string,
    personaId: string,
    content: string,
    now: number,
  ): ChatMessageRow;
  renameChat(id: string, title: string, now: number): ChatSummaryRow | null;
  deleteChat(id: string): boolean;
  listMessages(
    chatId: string,
    opts: { limit: number; beforeId?: string },
  ): { messages: ChatMessageRow[]; hasMore: boolean };
  findMessageByClientKey(
    chatId: string,
    clientKey: string,
  ): ChatMessageRow | null;
  /** Replay lookup: the user row for this client key plus its assistant reply. */
  findExchangeByClientKey(
    chatId: string,
    clientKey: string,
  ): { user: ChatMessageRow; assistant: ChatMessageRow } | null;
  appendExchange(
    chatId: string,
    input: { text: string; reply: string; clientKey?: string },
    now: number,
  ): { user: ChatMessageRow; assistant: ChatMessageRow };
}

const PERSONA_COLS =
  "id, name, avatar, provider, model, system_prompt AS systemPrompt, created_at AS createdAt, updated_at AS updatedAt";
const MSG_COLS =
  "id, role, content, created_at AS createdAt, persona_id AS personaId";
const CHAT_SELECT = `SELECT c.id, c.persona_id AS personaId, p.name AS personaName,
  p.avatar, p.provider, c.title, c.created_at AS createdAt, c.updated_at AS updatedAt,
  COALESCE((SELECT substr(m.content, 1, 80) FROM persona_chat_messages m
    WHERE m.chat_id = c.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1), '') AS preview,
  (SELECT count(*) FROM persona_chat_messages m WHERE m.chat_id = c.id) AS messageCount,
  c.partner_id AS partnerId, pp.name AS partnerName, pp.avatar AS partnerAvatar,
  c.autotalk <> 0 AS autotalk
  FROM persona_chats c JOIN personas p ON p.id = c.persona_id
  LEFT JOIN personas pp ON pp.id = c.partner_id`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function check<T>(
  ok: { success: boolean; data?: T },
  code: PersonaChatStoreErrorCode,
): T {
  if (!ok.success) throw new PersonaChatStoreError(code);
  return ok.data as T;
}

export function createPersonaChatStore(options: {
  db: Database.Database;
  id?: () => string;
}): PersonaChatStore {
  const { db } = options;
  const newId = options.id ?? randomUUID;

  const getPersona = (id: string) =>
    (db.prepare(`SELECT ${PERSONA_COLS} FROM personas WHERE id = ?`).get(id) as
      | PersonaRow
      | undefined) ?? null;
  const getChat = (id: string) => {
    const row = db.prepare(`${CHAT_SELECT} WHERE c.id = ?`).get(id) as
      | (Omit<ChatSummaryRow, "autotalk"> & { autotalk: number })
      | undefined;
    return row ? { ...row, autotalk: row.autotalk === 1 } : null;
  };
  const toRows = (rows: unknown[]) =>
    (rows as (Omit<ChatSummaryRow, "autotalk"> & { autotalk: number })[]).map(
      (r) => ({ ...r, autotalk: r.autotalk === 1 }),
    );
  const getMessage = (id: string) =>
    db
      .prepare(`SELECT ${MSG_COLS} FROM persona_chat_messages WHERE id = ?`)
      .get(id) as ChatMessageRow;
  const findMessageByClientKey = (chatId: string, clientKey: string) =>
    (db
      .prepare(
        `SELECT ${MSG_COLS} FROM persona_chat_messages WHERE chat_id = ? AND client_key = ?`,
      )
      .get(chatId, clientKey) as ChatMessageRow | undefined) ?? null;

  const appendTx = db.transaction(
    (
      chatId: string,
      text: string,
      reply: string,
      clientKey: string | null,
      now: number,
    ) => {
      const insert = db.prepare(
        "INSERT INTO persona_chat_messages (id, chat_id, role, content, client_key, created_at, persona_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      const userId = newId();
      const assistantId = newId();
      // Assistant is +1ms so (created_at, id) ordering keeps user first.
      insert.run(userId, chatId, "user", text, clientKey, now, null);
      const owner = getChat(chatId)?.personaId ?? null;
      insert.run(assistantId, chatId, "assistant", reply, null, now + 1, owner);
      db.prepare(
        "UPDATE persona_chats SET updated_at = max(updated_at, ?) WHERE id = ?",
      ).run(now + 1, chatId);
      return { user: getMessage(userId), assistant: getMessage(assistantId) };
    },
  );

  return {
    listPersonas: () =>
      db
        .prepare(`SELECT ${PERSONA_COLS} FROM personas ORDER BY created_at, id`)
        .all() as PersonaRow[],
    getPersona,
    createPersona(input, now) {
      const p = check(
        CreatePersonaRequestSchema.safeParse(input),
        "invalid_persona",
      );
      const id = newId();
      db.prepare(
        "INSERT INTO personas (id, name, avatar, provider, model, system_prompt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        id,
        p.name,
        p.avatar,
        p.provider,
        p.model,
        p.systemPrompt,
        now,
        now,
      );
      return getPersona(id) as PersonaRow;
    },
    updatePersona(id, input, now) {
      const p = check(
        CreatePersonaRequestSchema.safeParse(input),
        "invalid_persona",
      );
      const r = db
        .prepare(
          "UPDATE personas SET name = ?, avatar = ?, provider = ?, model = ?, system_prompt = ?, updated_at = max(created_at, ?) WHERE id = ?",
        )
        .run(p.name, p.avatar, p.provider, p.model, p.systemPrompt, now, id);
      return r.changes === 0 ? null : getPersona(id);
    },
    deletePersona: (id) =>
      db.prepare("DELETE FROM personas WHERE id = ?").run(id).changes > 0,
    listChats: () =>
      toRows(
        db
          .prepare(`${CHAT_SELECT} ORDER BY c.updated_at DESC, c.id LIMIT 100`)
          .all(),
      ),
    getChat,
    createChat(personaId, title, now, options) {
      const t =
        title === undefined
          ? undefined
          : check(ChatTitleSchema.safeParse(title), "invalid_title");
      const persona = getPersona(personaId);
      if (!persona) return null;
      const partnerId = options?.partnerId ?? null;
      if (partnerId !== null && !getPersona(partnerId)) return null;
      const id = newId();
      db.prepare(
        "INSERT INTO persona_chats (id, persona_id, title, created_at, updated_at, partner_id, autotalk) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(
        id,
        personaId,
        t ?? `${persona.name}との会話`.slice(0, 120),
        now,
        now,
        partnerId,
        options?.autotalk ? 1 : 0,
      );
      return getChat(id);
    },
    setAutotalk(chatId, autotalk, now) {
      const r = db
        .prepare(
          "UPDATE persona_chats SET autotalk = ?, updated_at = max(created_at, ?) WHERE id = ?",
        )
        .run(autotalk ? 1 : 0, now, chatId);
      return r.changes === 0 ? null : getChat(chatId);
    },
    listAutotalkDue: (cutoff, limit) =>
      toRows(
        db
          .prepare(
            `${CHAT_SELECT} WHERE c.autotalk = 1 AND c.partner_id IS NOT NULL
             AND COALESCE((SELECT max(m.created_at) FROM persona_chat_messages m WHERE m.chat_id = c.id), -1) < ?
             ORDER BY c.updated_at, c.id LIMIT ?`,
          )
          .all(cutoff, limit),
      ),
    appendParticipantMessage(chatId, personaId, content, now) {
      const text = check(
        ChatMessageTextSchema.safeParse(content),
        "invalid_text",
      );
      const chat = db
        .prepare(
          "SELECT persona_id, partner_id FROM persona_chats WHERE id = ?",
        )
        .get(chatId) as
        | { persona_id: string; partner_id: string | null }
        | undefined;
      if (!chat) throw new PersonaChatStoreError("chat_not_found");
      if (personaId !== chat.persona_id && personaId !== chat.partner_id)
        throw new PersonaChatStoreError("invalid_persona");
      const id = newId();
      db.transaction(() => {
        db.prepare(
          "INSERT INTO persona_chat_messages (id, chat_id, role, content, client_key, created_at, persona_id) VALUES (?, ?, 'assistant', ?, NULL, ?, ?)",
        ).run(id, chatId, text, now, personaId);
        db.prepare(
          "UPDATE persona_chats SET updated_at = max(updated_at, ?) WHERE id = ?",
        ).run(now, chatId);
      })();
      return getMessage(id);
    },
    renameChat(id, title, now) {
      const t = check(ChatTitleSchema.safeParse(title), "invalid_title");
      const r = db
        .prepare(
          "UPDATE persona_chats SET title = ?, updated_at = max(created_at, ?) WHERE id = ?",
        )
        .run(t, now, id);
      return r.changes === 0 ? null : getChat(id);
    },
    deleteChat: (id) =>
      db.prepare("DELETE FROM persona_chats WHERE id = ?").run(id).changes > 0,
    listMessages(chatId, { limit, beforeId }) {
      if (beforeId !== undefined && !UUID.test(beforeId))
        throw new PersonaChatStoreError("invalid_cursor");
      let cursor = { createdAt: Number.MAX_SAFE_INTEGER, id: "\uffff" };
      if (beforeId !== undefined) {
        const row = db
          .prepare(
            "SELECT created_at AS createdAt, id FROM persona_chat_messages WHERE id = ? AND chat_id = ?",
          )
          .get(beforeId, chatId) as typeof cursor | undefined;
        if (!row) return { messages: [], hasMore: false };
        cursor = row;
      }
      const rows = db
        .prepare(
          `SELECT ${MSG_COLS} FROM persona_chat_messages
           WHERE chat_id = ? AND (created_at < ? OR (created_at = ? AND id < ?))
           ORDER BY created_at DESC, id DESC LIMIT ?`,
        )
        .all(
          chatId,
          cursor.createdAt,
          cursor.createdAt,
          cursor.id,
          limit + 1,
        ) as ChatMessageRow[];
      const hasMore = rows.length > limit;
      return { messages: rows.slice(0, limit).reverse(), hasMore };
    },
    findMessageByClientKey,
    findExchangeByClientKey(chatId, clientKey) {
      const user = findMessageByClientKey(chatId, clientKey);
      if (!user) return null;
      const assistant = db
        .prepare(
          `SELECT ${MSG_COLS} FROM persona_chat_messages
           WHERE chat_id = ? AND role = 'assistant' AND (created_at > ? OR (created_at = ? AND id > ?))
           ORDER BY created_at, id LIMIT 1`,
        )
        .get(chatId, user.createdAt, user.createdAt, user.id) as
        | ChatMessageRow
        | undefined;
      return assistant ? { user, assistant } : null;
    },
    appendExchange(chatId, input, now) {
      const text = check(
        ChatMessageTextSchema.safeParse(input.text),
        "invalid_text",
      );
      const clientKey =
        input.clientKey === undefined
          ? null
          : check(
              ChatClientKeySchema.safeParse(input.clientKey),
              "invalid_client_key",
            );
      if (input.reply.length === 0 || input.reply.length > 32000)
        throw new PersonaChatStoreError("invalid_text");
      if (!getChat(chatId)) throw new PersonaChatStoreError("chat_not_found");
      return appendTx(chatId, text, input.reply, clientKey, now);
    },
  };
}
