-- Companion private thought journal (additive, internal only).
--
-- One row per bounded research/question pass. This is NOT user memory and is
-- never written to remind. `body` is the companion's own note; `sources_json`
-- carries bounded web title/url pairs; `memory_ids_json` carries the opaque
-- remind record ids the note was based on. No raw conversation text,
-- credentials, or model prompts are stored here.
--
-- Feedback is durable on the same row: asked_at/speech_turn_id bind the
-- delivered chat Turn, reply_at/reply_turn_id the first user turn after it.
CREATE TABLE companion_thoughts (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('survey','question','hypothesis','observation')),
  body          TEXT NOT NULL CHECK (length(body) >= 1 AND length(body) <= 2000),
  topics_json   TEXT NOT NULL CHECK (length(topics_json) >= 2),
  memory_ids_json TEXT NOT NULL CHECK (length(memory_ids_json) >= 2),
  sources_json  TEXT NOT NULL CHECK (length(sources_json) >= 2),
  status        TEXT NOT NULL CHECK (status IN ('open','asked','answered','archived')),
  created_at    INTEGER NOT NULL CHECK (created_at >= 0),
  asked_at      INTEGER CHECK (asked_at IS NULL OR asked_at >= created_at),
  reply_at      INTEGER CHECK (reply_at IS NULL OR (asked_at IS NOT NULL AND reply_at >= asked_at)),
  reply_turn_id TEXT,
  speech_turn_id TEXT,
  speech_session_id TEXT,
  outcome       TEXT CHECK (outcome IS NULL OR outcome IN ('replied','ignored','refused'))
) STRICT;

CREATE INDEX idx_companion_thoughts_open
  ON companion_thoughts(status, created_at ASC, id ASC);

CREATE INDEX idx_companion_thoughts_asked
  ON companion_thoughts(status, asked_at ASC, id ASC);
