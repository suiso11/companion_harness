-- Companion conversation-memory outbox (remind CLI integration).
--
-- Committed migration 0006: adds Companion-owned durable memory tables for
-- the CLI-based remind integration (docs/operations.md "Conversation
-- memory"). Remind remains a separate process/database: these tables only
-- stage Companion-side jobs, immutable recall-exposure snapshots, and
-- per-run memory citation grants. No remind state is mirrored here.
--
-- Invariants (must not be weakened):
-- - All tables are STRICT, none WITHOUT ROWID.
-- - `memory_outbox` is the sole durable queue for remind CLI writes:
--   `event.append`, `record.remember`, `record.feedback`, and
--   `maintain.distill`. One row per stable idempotency key
--   (UNIQUE(idempotency_key)): crash/unknown-outcome replay reuses the key
--   and never mints a duplicate write.
-- - `kind` is a closed CHECK set; `status` is pending/acked/failed only.
-- - `request_json` is CHECK(json_valid(...)): the exact CLI request line.
-- - `attempts` counts executed CLI attempts (bounded by the service, not
--   the DB); `next_due_at` is Unix-ms when the row is next eligible.
-- - `memory_exposures` is an immutable snapshot: one row per
--   (recall_id, record_id) actually exposed to a run. Rows are never
--   updated or deleted by the service (no TTL here; remind owns eviction).
--   `citation` is the structural `mN` label shown to the model.
-- - `memory_grants` binds an accepted completed run's cited `mN` labels to
--   concrete remind record ids. Only citations present in the accepted
--   answer's citation arrays grant: mere recall exposure or textual
--   mentions never insert here (enforced by the service, not the DB).
-- - Last-write columns only; prompt text, raw model output, and secrets are
--   NEVER columns here. `last_error` carries a fixed code only.

CREATE TABLE memory_outbox (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL
                  CHECK (kind IN ('event.append','record.remember','record.feedback','maintain.distill')),
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

CREATE INDEX idx_memory_outbox_due ON memory_outbox(status, next_due_at, id);
CREATE INDEX idx_memory_outbox_run ON memory_outbox(run_id);

CREATE TABLE memory_exposures (
  recall_id  TEXT NOT NULL,
  record_id  TEXT NOT NULL,
  session_id TEXT NOT NULL,
  run_id     TEXT NOT NULL,
  scope      TEXT NOT NULL,
  citation   TEXT NOT NULL
             CHECK (citation GLOB 'm[1-9]*'),
  snippet    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (recall_id, record_id)
) STRICT;

CREATE INDEX idx_memory_exposures_run ON memory_exposures(run_id, citation);

CREATE TABLE memory_grants (
  run_id     TEXT NOT NULL,
  citation   TEXT NOT NULL
             CHECK (citation GLOB 'm[1-9]*'),
  record_id  TEXT NOT NULL,
  recall_id  TEXT NOT NULL,
  session_id TEXT NOT NULL,
  scope      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, citation)
) STRICT;

CREATE INDEX idx_memory_grants_run ON memory_grants(run_id);
