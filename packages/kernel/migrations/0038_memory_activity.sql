-- Read-only browser view of background memory maintenance (additive).
--
-- One row per completed idle maintenance pass. Companion writes this table
-- from the SAME parsed numeric summaries it already logs; it never stores
-- memory bodies, scopes' content, prompts, or model text. `counts_json` is a
-- small fixed numeric object validated by the repository (allowlisted keys
-- per op), so the table stays auditable and privacy-neutral.
--
-- Retention: the repository keeps the newest 2000 rows AND removes rows
-- older than 30 days on every insert (same transaction).
--
-- Op codes are fixed. `error_code` is a fixed snake_case code and is NULL
-- exactly when `ok = 1`; `counts_json` always carries fixed numeric fields
-- only (a degraded pass is `ok = 1` with `counts_json.degraded = 1`).
CREATE TABLE memory_maintenance_runs (
  id          TEXT PRIMARY KEY,
  op          TEXT NOT NULL CHECK (op IN (
    'topic.backfill',
    'maintain.associate',
    'maintain.consolidate',
    'maintain.activation',
    'maintain.distill'
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

-- Newest-first keyset page: (created_at DESC, id DESC).
CREATE INDEX idx_memory_maintenance_runs_recent
  ON memory_maintenance_runs(created_at DESC, id DESC);

-- Retention sweep + per-op window aggregation.
CREATE INDEX idx_memory_maintenance_runs_op_time
  ON memory_maintenance_runs(op, created_at DESC);
