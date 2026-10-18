-- Persisted `correction` recall kind (additive).
--
-- Remind record kinds include `correction`, but the `memory_exposures.kind`
-- CHECK from 0021 only allows user_fact/model_inference/summary, so a
-- recalled correction was stored as NULL (unknown) instead of its real
-- kind. This migration widens the closed kind set to also accept
-- `correction` (table rebuild: SQLite has no ALTER CHECK).
--
-- Invariants (must not be weakened):
-- - All rows are preserved verbatim (immutable snapshots, never rewritten).
-- - `memory_exposures` stays STRICT with PRIMARY KEY (recall_id, record_id).
-- - `citation` still matches `m[1-9]*`; `revision` still NULL-or->=1.
-- - Only `idx_memory_exposures_run` exists on this table (no FKs reference
--   it, no triggers on it); the index is recreated after the rebuild.
-- - Extraction still never emits `correction` (closed extraction set is
--   unchanged); only recalled provenance may carry it, and it is never
--   presented as a fact (inference-framed downstream like summaries).
-- - `memory_grants` is untouched (revision-only, no kind column).

CREATE TABLE memory_exposures_new (
  recall_id  TEXT NOT NULL,
  record_id  TEXT NOT NULL,
  session_id TEXT NOT NULL,
  run_id     TEXT NOT NULL,
  scope      TEXT NOT NULL,
  citation   TEXT NOT NULL
             CHECK (citation GLOB 'm[1-9]*'),
  snippet    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revision   INTEGER
             CHECK (revision IS NULL OR revision >= 1),
  kind       TEXT
             CHECK (kind IS NULL OR kind IN ('user_fact','model_inference','summary','correction')),
  PRIMARY KEY (recall_id, record_id)
) STRICT;

INSERT INTO memory_exposures_new
  (recall_id, record_id, session_id, run_id, scope, citation, snippet, created_at, revision, kind)
  SELECT recall_id, record_id, session_id, run_id, scope, citation, snippet, created_at, revision, kind
  FROM memory_exposures;

DROP TABLE memory_exposures;

ALTER TABLE memory_exposures_new RENAME TO memory_exposures;

CREATE INDEX idx_memory_exposures_run ON memory_exposures(run_id, citation);
