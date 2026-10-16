-- Companion explicit memory management (search + correct/retire/reactivate).
--
-- Committed migration 0009: extends the Companion-owned durable memory
-- tables for explicit user-directed management (docs/operations.md
-- "Conversation memory"). Remind remains a separate process/database:
-- these tables only stage Companion-side jobs, immutable explicit-search
-- snapshots, and durable management-operation status. No remind state is
-- mirrored here. No physical delete/export/perception surface exists.
--
-- Invariants (must not be weakened):
-- - All tables are STRICT, none WITHOUT ROWID.
-- - `memory_outbox.kind` is a closed CHECK set, now also covering the
--   real management writes `record.correct`, `record.retire`, and
--   `record.reactivate`. `record.search`/`record.get` are reads and never
--   enter the outbox. `status` stays pending/acked/failed only.
-- - One outbox row per stable idempotency key (UNIQUE(idempotency_key)):
--   crash/unknown-outcome replay reuses the key and never mints a
--   duplicate write. Correction chains as NEW `event.append` (raw source
--   with the user's replacement) followed by `record.correct`, so an
--   append-unknown-outcome replay recovers the event before any revision.
-- - `memory_searches`/`memory_search_items` are immutable snapshots of one
--   explicit `record.search` (active+retired, never archived/superseded):
--   rows are never updated or deleted by the service. `handle` is the
--   session-scoped opaque `mN` label shown to the model/UI, never a raw
--   canonical id. A search never heats, reactivates, or grants feedback.
-- - `memory_operations` is the durable 202-ack status for one staged
--   management mutation (correct/retire/reactivate): the UI must never
--   claim "applied" while the outbox job is only queued. Same
--   idempotency key + same body replays the stored operation; same key +
--   drifted body is a 409 (no silent rebind).
-- - Prompt text, raw model output, and secrets are NEVER columns here.
--   `last_error` carries a fixed code only.

-- Widen the closed outbox kind set (table rebuild: SQLite has no ALTER CHECK).
CREATE TABLE memory_outbox_new (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL
                  CHECK (kind IN ('event.append','record.remember','record.feedback','maintain.distill','record.correct','record.retire','record.reactivate')),
  session_id      TEXT NOT NULL,
  run_id          TEXT NOT NULL,
  turn_id         TEXT,
  event_id        TEXT,
  scope           TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_json    TEXT NOT NULL
                  CHECK (json_valid(request_json)),
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','acked','failed')),
  attempts        INTEGER NOT NULL DEFAULT 0
                  CHECK (attempts >= 0),
  next_due_at     INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
) STRICT;

INSERT INTO memory_outbox_new
  (id, kind, session_id, run_id, turn_id, event_id, scope, idempotency_key,
   request_json, status, attempts, next_due_at, last_error, created_at, updated_at)
  SELECT id, kind, session_id, run_id, turn_id, event_id, scope, idempotency_key,
   request_json, status, attempts, next_due_at, last_error, created_at, updated_at
  FROM memory_outbox;

DROP TABLE memory_outbox;

ALTER TABLE memory_outbox_new RENAME TO memory_outbox;

CREATE INDEX idx_memory_outbox_due ON memory_outbox(status, next_due_at, id);
CREATE INDEX idx_memory_outbox_run ON memory_outbox(run_id);

-- One explicit search invocation (durable, immutable, no heat).
CREATE TABLE memory_searches (
  search_id  TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  run_id     TEXT NOT NULL,
  scope      TEXT NOT NULL,
  query      TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_memory_searches_session ON memory_searches(session_id, created_at);

-- Immutable per-handle snapshot rows for one search (never rewritten).
CREATE TABLE memory_search_items (
  search_id  TEXT NOT NULL,
  handle     TEXT NOT NULL
             CHECK (handle GLOB 'm[1-9]*'),
  record_id  TEXT NOT NULL,
  revision   INTEGER CHECK (revision IS NULL OR revision >= 1),
  status     TEXT NOT NULL
             CHECK (status IN ('active','retired')),
  snippet    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (search_id, handle)
) STRICT;

CREATE INDEX idx_memory_search_items_record ON memory_search_items(record_id);

-- Durable status for one staged management mutation (202 ack, never "applied" while queued).
CREATE TABLE memory_operations (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL
                  CHECK (kind IN ('record.correct','record.retire','record.reactivate')),
  session_id      TEXT NOT NULL,
  run_id          TEXT NOT NULL,
  search_id       TEXT,
  handle          TEXT,
  record_id       TEXT NOT NULL,
  revision        INTEGER CHECK (revision IS NULL OR revision >= 1),
  job_id          TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_hash    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','acked','failed')),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_memory_operations_session ON memory_operations(session_id, created_at);
CREATE INDEX idx_memory_operations_job ON memory_operations(job_id);
