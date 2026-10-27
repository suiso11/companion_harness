-- Schema33 sealed trial report surface: persist the bounded report the
-- bridge already returns on its wire result line so the Companion API/UI can
-- show it without reading the frozen bridge journal. Guest-owned text
-- (summary/findings/unresolved) is stored as UNATTESTED presentation data
-- only; checks/artifact/verified stay host-checked. Additive: one immutable
-- row per execution, written in the same transaction as the worker outcome.
CREATE TABLE trial_worker_reports (
  execution_id TEXT PRIMARY KEY REFERENCES trial_grants(execution_id),
  session_id TEXT NOT NULL REFERENCES sessions(id),
  summary TEXT NOT NULL CHECK (length(summary) <= 2048),
  findings_json TEXT NOT NULL CHECK (length(findings_json) <= 32768),
  unresolved_json TEXT NOT NULL CHECK (length(unresolved_json) <= 16384),
  checks_json TEXT NOT NULL CHECK (length(checks_json) <= 8192),
  artifact_json TEXT CHECK (artifact_json IS NULL OR length(artifact_json) <= 512),
  verified INTEGER NOT NULL CHECK (verified IN (0,1)),
  recorded_at INTEGER NOT NULL
) STRICT;
