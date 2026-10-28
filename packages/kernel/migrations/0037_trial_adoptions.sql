-- Schema37 human-only adoption of verified write-trial candidates.
-- One row per proposal: idempotent (done replays the same PR result) and a
-- pending row blocks concurrent adoptions. No automatic adoption path exists.
CREATE TABLE trial_adoptions (
  proposal_id TEXT PRIMARY KEY REFERENCES trial_proposals(id),
  execution_id TEXT NOT NULL,
  artifact_sha256 TEXT NOT NULL CHECK (length(artifact_sha256) = 64),
  status TEXT NOT NULL CHECK (status IN ('pending','done','failed')),
  branch TEXT,
  base_sha TEXT CHECK (base_sha IS NULL OR length(base_sha) BETWEEN 40 AND 64),
  pr_url TEXT,
  commit_sha TEXT,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
