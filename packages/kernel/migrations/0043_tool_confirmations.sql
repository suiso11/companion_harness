-- Voice slot confirmation (additive): one row per refused mutating call whose
-- number/entity slot came from a dictated turn. The byte-identical call is
-- allowed only in the immediately following user turn, once (15 min TTL).
--
-- Only the post-Zod args hash and the blocking run are stored; the argument
-- values never reach this table (they live in the audit tool_calls row and
-- the delivered RunResult, never duplicated here).
CREATE TABLE tool_confirmations (
  id               TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL REFERENCES sessions(id),
  tool_name        TEXT NOT NULL,
  args_hash        TEXT NOT NULL CHECK (length(args_hash) = 64),
  blocked_run_id   TEXT NOT NULL,
  created_at       INTEGER NOT NULL CHECK (created_at >= 0),
  consumed_at      INTEGER CHECK (consumed_at IS NULL OR consumed_at >= created_at),
  consumed_run_id  TEXT,
  CHECK ((consumed_at IS NULL) = (consumed_run_id IS NULL))
) STRICT;

CREATE UNIQUE INDEX uq_tool_confirmations_pending
  ON tool_confirmations(session_id, tool_name, args_hash)
  WHERE consumed_at IS NULL;

CREATE INDEX idx_tool_confirmations_blocked_run
  ON tool_confirmations(blocked_run_id);
