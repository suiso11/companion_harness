-- Schema12 trial authority: structured constraint rules + DATA-only
-- trial proposals + one-shot grants. Touches NO existing table.
CREATE TABLE trial_constraint_rules (
  purpose_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  scope TEXT NOT NULL CHECK (length(scope) >= 1 AND length(scope) <= 128),
  rule_json TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id, purpose_id) REFERENCES autonomy_purposes(session_id, id)
) STRICT;
CREATE TABLE trial_proposals (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  scope TEXT NOT NULL CHECK (length(scope) >= 1 AND length(scope) <= 128),
  task_id TEXT NOT NULL,
  goal_id TEXT,
  goal_version INTEGER,
  task_version INTEGER NOT NULL CHECK (task_version >= 1),
  objective TEXT NOT NULL CHECK (length(objective) >= 1),
  acceptance_json TEXT NOT NULL,
  paths_json TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('investigate','implement','verify','maintenance_trial')),
  read_only INTEGER NOT NULL CHECK (read_only IN (0,1)),
  expiry TEXT NOT NULL,
  consent INTEGER NOT NULL CHECK (consent IN (0,1)),
  timeout_ms INTEGER NOT NULL CHECK (timeout_ms >= 1),
  max_output_bytes INTEGER NOT NULL CHECK (max_output_bytes >= 1),
  checks_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('staged','granted','expired','invalidated')),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id, task_id) REFERENCES autonomy_tasks(session_id, id)
) STRICT;
CREATE INDEX idx_trial_proposals_session ON trial_proposals(session_id, created_at);
CREATE TABLE trial_grants (
  execution_id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  scope TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','claimed','revoked','consumed','interrupted')),
  cancel_requested INTEGER NOT NULL CHECK (cancel_requested IN (0,1)),
  control_generation INTEGER NOT NULL CHECK (control_generation >= 1),
  request_json TEXT,
  created_at INTEGER NOT NULL,
  claimed_at INTEGER
) STRICT;
CREATE INDEX idx_trial_grants_session ON trial_grants(session_id, scope, status);
