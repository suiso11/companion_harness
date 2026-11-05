-- Persona-to-persona autotalk: local provider, chat partner, autotalk flag,
-- per-message author. The 0044 provider CHECK is a closed enum, so the three
-- tables are rebuilt (SQLite has no ALTER CHECK). Dropping personas with FKs ON
-- would cascade-delete chats, so data is parked in temp tables first and the
-- children are dropped before the parent. All rows are preserved verbatim;
-- new columns: persona_chats.partner_id / autotalk, persona_chat_messages.persona_id.
CREATE TEMP TABLE personas_old AS SELECT * FROM personas;
CREATE TEMP TABLE persona_chats_old AS SELECT * FROM persona_chats;
CREATE TEMP TABLE persona_chat_messages_old AS SELECT * FROM persona_chat_messages;

DROP TABLE persona_chat_messages;
DROP TABLE persona_chats;
DROP TABLE personas;

CREATE TABLE personas (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  avatar        TEXT NOT NULL CHECK (length(avatar) BETWEEN 1 AND 16),
  provider      TEXT NOT NULL CHECK (provider IN ('openai', 'deepseek', 'local')),
  model         TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 256),
  system_prompt TEXT NOT NULL CHECK (length(system_prompt) BETWEEN 1 AND 8000),
  created_at    INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at    INTEGER NOT NULL CHECK (updated_at >= created_at)
) STRICT;

CREATE TABLE persona_chats (
  id         TEXT PRIMARY KEY,
  persona_id TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  title      TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  partner_id TEXT REFERENCES personas(id) ON DELETE SET NULL,
  autotalk   INTEGER NOT NULL DEFAULT 0 CHECK (autotalk IN (0, 1))
) STRICT;

CREATE TABLE persona_chat_messages (
  id         TEXT PRIMARY KEY,
  chat_id    TEXT NOT NULL REFERENCES persona_chats(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content    TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 32000),
  client_key TEXT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  persona_id TEXT REFERENCES personas(id) ON DELETE SET NULL
) STRICT;

INSERT INTO personas SELECT * FROM personas_old;
INSERT INTO persona_chats (id, persona_id, title, created_at, updated_at)
  SELECT id, persona_id, title, created_at, updated_at FROM persona_chats_old;
-- Legacy assistant rows were written by the chat's persona.
INSERT INTO persona_chat_messages (id, chat_id, role, content, client_key, created_at, persona_id)
  SELECT m.id, m.chat_id, m.role, m.content, m.client_key, m.created_at,
         CASE m.role WHEN 'assistant' THEN c.persona_id END
  FROM persona_chat_messages_old m JOIN persona_chats_old c ON c.id = m.chat_id;

DROP TABLE personas_old;
DROP TABLE persona_chats_old;
DROP TABLE persona_chat_messages_old;

CREATE INDEX persona_chats_updated_idx ON persona_chats(updated_at DESC, id);
CREATE INDEX persona_chat_messages_chat_idx
  ON persona_chat_messages(chat_id, created_at, id);
CREATE UNIQUE INDEX persona_chat_messages_client_key_uq
  ON persona_chat_messages(chat_id, client_key) WHERE client_key IS NOT NULL;
CREATE INDEX idx_persona_chats_autotalk ON persona_chats(autotalk, updated_at);
