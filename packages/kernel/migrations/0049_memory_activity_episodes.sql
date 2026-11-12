-- Schema49: `maintain.episodes` joins the fixed maintenance-op set.
--
-- SQLite has no ALTER CHECK, so the table is rebuilt with the same columns,
-- constraints, and retention/keyset indexes; every existing row is copied
-- verbatim. The op list stays fixed and numeric-only.
CREATE TABLE memory_maintenance_runs_new (
  id          TEXT PRIMARY KEY,
  op          TEXT NOT NULL CHECK (op IN (
    'topic.backfill',
    'maintain.associate',
    'maintain.consolidate',
    'maintain.activation',
    'maintain.distill',
    'maintain.episodes'
  )),
  scope       TEXT NOT NULL CHECK (length(scope) >= 1 AND length(scope) <= 128),
  started_at  INTEGER NOT NULL CHECK (started_at >= 0),
  finished_at INTEGER NOT NULL CHECK (finished_at >= started_at),
  ok          INTEGER NOT NULL CHECK (ok IN (0, 1)),
  error_code  TEXT CHECK (
    error_code IS NULL OR
    (length(error_code) >= 1 AND length(error_code) <= 64)
  ),
  counts_json TEXT NOT NULL CHECK (length(counts_json) >= 2),
  created_at  INTEGER NOT NULL CHECK (created_at >= 0),
  CHECK ((ok = 1 AND error_code IS NULL) OR (ok = 0 AND error_code IS NOT NULL))
) STRICT;

INSERT INTO memory_maintenance_runs_new
  (id, op, scope, started_at, finished_at, ok, error_code, counts_json, created_at)
  SELECT id, op, scope, started_at, finished_at, ok, error_code, counts_json, created_at
  FROM memory_maintenance_runs;

DROP TABLE memory_maintenance_runs;

ALTER TABLE memory_maintenance_runs_new RENAME TO memory_maintenance_runs;

CREATE INDEX idx_memory_maintenance_runs_recent
  ON memory_maintenance_runs(created_at DESC, id DESC);

CREATE INDEX idx_memory_maintenance_runs_op_time
  ON memory_maintenance_runs(op, created_at DESC);
