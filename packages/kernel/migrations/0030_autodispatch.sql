-- Schema30 conversation -> plan -> standing-policy auto dispatch.
-- Reuses autonomy purposes/tasks and trial_authority grants; no new engine,
-- queue, scheduler, or learning store is introduced. Default-off at the
-- server config layer: no policy exists until an authenticated human creates
-- one, and autonomy_control still defaults to paused.
CREATE TABLE autodispatch_policies (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  parent_purpose_id TEXT NOT NULL,
  workspace_alias TEXT NOT NULL CHECK (length(workspace_alias) >= 1 AND length(workspace_alias) <= 64),
  version INTEGER NOT NULL CHECK (version >= 1),
  status TEXT NOT NULL CHECK (status IN ('active','revoked','expired')),
  operations_json TEXT NOT NULL,
  read_scopes_json TEXT NOT NULL,
  write_scopes_json TEXT NOT NULL,
  checks_json TEXT NOT NULL,
  caps_json TEXT NOT NULL,
  expires_at TEXT,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (session_id, id),
  FOREIGN KEY (session_id, parent_purpose_id)
    REFERENCES autonomy_purposes(session_id, id)
) STRICT;
CREATE INDEX idx_autodispatch_policies_session
  ON autodispatch_policies(session_id, status, created_at);

CREATE TABLE autodispatch_plans (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  policy_id TEXT NOT NULL,
  policy_version INTEGER NOT NULL CHECK (policy_version >= 1),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  plan_hash TEXT NOT NULL CHECK (length(plan_hash) = 64),
  status TEXT NOT NULL CHECK (status IN ('frozen','needs_decision','discuss','blocked','superseded','dispatched')),
  goal TEXT NOT NULL CHECK (length(goal) >= 1),
  decisions_json TEXT NOT NULL,
  nongoals_json TEXT NOT NULL,
  steps_json TEXT NOT NULL,
  acceptance_json TEXT NOT NULL,
  missing_json TEXT NOT NULL,
  relevant_paths_json TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('investigate','implement','verify','maintenance_trial')),
  workspace_alias TEXT NOT NULL CHECK (length(workspace_alias) >= 1 AND length(workspace_alias) <= 64),
  intent_json TEXT NOT NULL,
  source_turn_id TEXT NOT NULL,
  source_run_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (session_id, plan_hash),
  UNIQUE (session_id, id),
  FOREIGN KEY (session_id, source_turn_id) REFERENCES turns(session_id, id),
  FOREIGN KEY (session_id, source_run_id) REFERENCES runs(session_id, id),
  FOREIGN KEY (session_id, policy_id) REFERENCES autodispatch_policies(session_id, id)
) STRICT;
CREATE INDEX idx_autodispatch_plans_session
  ON autodispatch_plans(session_id, revision, created_at);

CREATE TABLE autodispatch_executions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  plan_id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  policy_version INTEGER NOT NULL CHECK (policy_version >= 1),
  dedup_key TEXT NOT NULL CHECK (length(dedup_key) = 64),
  status TEXT NOT NULL CHECK (status IN ('reserved','authorized','blocked','denied','superseded')),
  reason TEXT,
  task_id TEXT,
  execution_id TEXT UNIQUE,
  dependency_digest TEXT CHECK (dependency_digest IS NULL OR length(dependency_digest) = 64),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (session_id, id),
  UNIQUE (session_id, dedup_key),
  FOREIGN KEY (session_id, plan_id) REFERENCES autodispatch_plans(session_id, id),
  FOREIGN KEY (session_id, policy_id) REFERENCES autodispatch_policies(session_id, id)
) STRICT;
CREATE INDEX idx_autodispatch_executions_policy
  ON autodispatch_executions(session_id, policy_id, status, created_at);
