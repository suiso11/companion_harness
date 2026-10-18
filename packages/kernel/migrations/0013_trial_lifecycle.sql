-- Schema13 trial authority lifecycle: frozen profile/alias snapshots +
-- internal execution-lifecycle tables. Touches NO existing column.
ALTER TABLE trial_proposals ADD COLUMN workspace_alias TEXT;
ALTER TABLE trial_proposals ADD COLUMN profile_json TEXT;
ALTER TABLE trial_grants ADD COLUMN workspace_alias TEXT;
ALTER TABLE trial_grants ADD COLUMN approved_profile_json TEXT;
-- Known native frontend birth identity (PID + Linux boot ID + process start
-- ticks canonical decimal TEXT + session ownership + observation time).
CREATE TABLE trial_worker_boots (
  execution_id TEXT PRIMARY KEY REFERENCES trial_grants(execution_id),
  session_id TEXT NOT NULL REFERENCES sessions(id),
  pid INTEGER NOT NULL CHECK (pid >= 1),
  boot_id TEXT NOT NULL CHECK (length(boot_id) >= 1 AND length(boot_id) <= 128),
  process_start_ticks TEXT NOT NULL CHECK (length(process_start_ticks) >= 1),
  observed_at INTEGER NOT NULL,
  started_at INTEGER NOT NULL
) STRICT;
-- One-use Root-service launch permits (one row per grant, never re-armed;
-- one ISSUE immediately consumes: consumed_at always set, never NULL).
CREATE TABLE trial_launch_permits (
  permit_id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL UNIQUE REFERENCES trial_grants(execution_id),
  session_id TEXT NOT NULL REFERENCES sessions(id),
  issued_at INTEGER NOT NULL,
  consumed_at INTEGER NOT NULL
) STRICT;
-- Host-observed vs authorized worker outcomes (one row per grant, immutable).
CREATE TABLE trial_worker_outcomes (
  execution_id TEXT PRIMARY KEY REFERENCES trial_grants(execution_id),
  session_id TEXT NOT NULL REFERENCES sessions(id),
  succeeded INTEGER NOT NULL CHECK (succeeded IN (0,1)),
  quiescent INTEGER NOT NULL CHECK (quiescent IN (0,1)),
  authorized INTEGER NOT NULL DEFAULT 0 CHECK (authorized IN (0,1)),
  task_hash TEXT,
  detail TEXT NOT NULL CHECK (length(detail) >= 1 AND length(detail) <= 2000),
  recorded_at INTEGER NOT NULL
) STRICT;
-- Durable per-(workspace-alias, execution) unknown fence (global by alias,
-- survives restart; one row PER (alias, executionId) so a second unknown on
-- the same alias keeps the fence after the first row clears; cleared only by
-- trusted gone+settled reconciliation of the exact row).
CREATE TABLE trial_alias_fences (
  workspace_alias TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  task_hash TEXT,
  pid INTEGER,
  boot_id TEXT,
  reason TEXT NOT NULL CHECK (length(reason) >= 1 AND length(reason) <= 256),
  created_at INTEGER NOT NULL,
  cleared_at INTEGER,
  PRIMARY KEY (workspace_alias, execution_id)
) STRICT;
