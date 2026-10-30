-- Schema41: self-improvement loop P2 (observer tier).
--
-- - `autonomy_control.learning_frozen` is a SEPARATE freeze from the global
--   pause: the loop's own writes stop, user-facing memory keeps working, and
--   only a human clears it. The global resume never clears it.
-- - `learning_evidence.source_kind` gains `run` and `trial_outcome` so loop
--   evidence anchors to the exact host-observed episode. The table is
--   rebuilt (SQLite has no ALTER CHECK) with the same columns and the same
--   hypothesis FK. Duplicate anchors stay legal (humans may annotate the
--   same episode twice); the loop counts DISTINCT source ids instead.
ALTER TABLE autonomy_control ADD COLUMN learning_frozen INTEGER NOT NULL DEFAULT 0
  CHECK (learning_frozen IN (0, 1));

CREATE TABLE learning_evidence_new (
  id              TEXT PRIMARY KEY,
  hypothesis_id   TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  polarity        TEXT NOT NULL
                  CHECK (polarity IN ('supports','refutes','neutral')),
  source_kind     TEXT NOT NULL
                  CHECK (source_kind IN ('shadow_job','conversation_proposal','action_receipt','task_event','run','trial_outcome')),
  source_id       TEXT NOT NULL
                  CHECK (length(source_id) >= 1),
  note            TEXT
                  CHECK (note IS NULL OR length(note) >= 1),
  created_at      INTEGER NOT NULL,
  FOREIGN KEY (session_id, hypothesis_id) REFERENCES learning_hypotheses(session_id, id),
  UNIQUE (session_id, id)
) STRICT;

INSERT INTO learning_evidence_new
  (id, hypothesis_id, session_id, polarity, source_kind, source_id, note, created_at)
  SELECT id, hypothesis_id, session_id, polarity, source_kind, source_id, note, created_at
  FROM learning_evidence;

DROP TABLE learning_evidence;

ALTER TABLE learning_evidence_new RENAME TO learning_evidence;

CREATE INDEX idx_learning_evidence_hypothesis
  ON learning_evidence(hypothesis_id, created_at);
