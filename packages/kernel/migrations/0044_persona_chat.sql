-- Persona chat: API-provider personas, their chats and message history.
CREATE TABLE personas (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  avatar        TEXT NOT NULL CHECK (length(avatar) BETWEEN 1 AND 16),
  provider      TEXT NOT NULL CHECK (provider IN ('openai', 'deepseek')),
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
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
) STRICT;

CREATE INDEX persona_chats_updated_idx ON persona_chats(updated_at DESC, id);

CREATE TABLE persona_chat_messages (
  id         TEXT PRIMARY KEY,
  chat_id    TEXT NOT NULL REFERENCES persona_chats(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content    TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 32000),
  client_key TEXT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
) STRICT;

CREATE INDEX persona_chat_messages_chat_idx
  ON persona_chat_messages(chat_id, created_at, id);
CREATE UNIQUE INDEX persona_chat_messages_client_key_uq
  ON persona_chat_messages(chat_id, client_key) WHERE client_key IS NOT NULL;
