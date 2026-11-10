-- Main-conversation persona: a single optional instruction block appended to
-- the immutable AGENT_SYSTEM_PROMPT (it never replaces the safety contract).
-- An empty value is represented by no row; /api/main-persona clears it.
CREATE TABLE main_persona (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  instructions TEXT NOT NULL CHECK (length(instructions) BETWEEN 1 AND 4000),
  updated_at   INTEGER NOT NULL CHECK (updated_at >= 0)
) STRICT;
