-- Schema40: self-improvement loop measurement foundation (P0/P1).
-- Additive only: no existing row changes shape, no behaviour change.
-- - learning hypotheses carry the deterministic task class and the
--   applicability note the loop uses to group evidence.
-- - trial proposals carry the hypothesis they test and the model's stated
--   success probability recorded BEFORE execution (calibration input).
-- - loop_daily is a rebuildable rollup (no authority, never read by grants).
ALTER TABLE learning_hypotheses ADD COLUMN task_class TEXT;
ALTER TABLE learning_hypotheses ADD COLUMN applies_when TEXT;

ALTER TABLE trial_proposals ADD COLUMN hypothesis_id TEXT;
ALTER TABLE trial_proposals ADD COLUMN predicted_p REAL
  CHECK (predicted_p IS NULL OR (predicted_p >= 0 AND predicted_p <= 1));

CREATE TABLE loop_daily (
  day            TEXT NOT NULL,          -- UTC YYYY-MM-DD
  task_class     TEXT NOT NULL
                 CHECK (length(task_class) >= 1 AND length(task_class) <= 64),
  n              INTEGER NOT NULL CHECK (n >= 0),
  ok             INTEGER NOT NULL CHECK (ok >= 0 AND ok <= n),
  dprime         REAL,
  gv_gap         REAL,
  claimed_calls  INTEGER NOT NULL CHECK (claimed_calls >= 0),
  dropped        INTEGER NOT NULL CHECK (dropped >= 0),
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (day, task_class)
) STRICT;
