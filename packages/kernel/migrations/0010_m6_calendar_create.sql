-- M6 approved calendar.create extension (agreed follow-up superseding ONLY the
-- M5 create-nongoal for this new opt-in feature; historical M5 claims stay).
--
-- Committed migration 0010: extends the four STRICT M5 action tables for the
-- opt-in `calendar.create` tool WITHOUT weakening any M5 invariant:
--
-- - `action_proposals.tool` admits exactly `calendar.reschedule` OR
--   `calendar.create` (closed two-value CHECK, never free text).
-- - The existing-event target columns (`target_ref_id`,
--   `target_resource_id`, `based_on_snapshot_id`, `expected_revision`) stay
--   NOT NULL for `calendar.reschedule` and are NULL ONLY for
--   `calendar.create` (per-tool CHECK): a create proposal carries NO source
--   event, NO etag, NO preflight snapshot — never a fake placeholder. All
--   reschedule FKs (exact 4-column target FK, connector/resource and
--   resource/snapshot consistency FKs) are unchanged; NULL FK columns simply
--   do not constrain create rows.
-- - `action_execution_grants.tool` admits the same closed two values.
-- - `action_executions` / `action_receipts` schemas are byte-identical to
--   0007 (the stable create insert id derives deterministically from the
--   immutable execution id, so no new column exists to drift).
-- - Exactly ONE pending proposal per session still holds across BOTH tools
--   (the partial unique index is recreated verbatim).
-- - Existing rows are preserved verbatim: every M5 reschedule row satisfies
--   the new CHECKs (tool reschedule + full target), so old proposals,
--   executions, grants, and receipts read back unchanged.
--
-- Upgrade shape (fail-closed, FK-safe inside the migration transaction):
-- leaf-first DROP (receipts -> grants -> executions -> proposals) then
-- root-first CREATE + COPY (proposals -> executions -> grants -> receipts),
-- so no DROP ever removes a table another live table still references.
-- No shims, no deprecated aliases, no unused paths.

-- Preserve every existing M5 row verbatim across the rebuild (column order
-- below matches 0007 exactly, so whole-row SELECT * round-trips).
CREATE TABLE _m6_action_proposals_backup AS SELECT * FROM action_proposals;
CREATE TABLE _m6_action_executions_backup AS SELECT * FROM action_executions;
CREATE TABLE _m6_action_execution_grants_backup AS SELECT * FROM action_execution_grants;
CREATE TABLE _m6_action_receipts_backup AS SELECT * FROM action_receipts;

DROP TABLE action_receipts;
DROP TABLE action_execution_grants;
DROP TABLE action_executions;
DROP TABLE action_proposals;

CREATE TABLE action_proposals (
  id                     TEXT PRIMARY KEY,  -- UUID v4
  session_id             TEXT NOT NULL REFERENCES sessions(id),
  source_turn_id         TEXT NOT NULL,
  source_run_id          TEXT NOT NULL,
  decision_turn_id       TEXT,              -- approval/rejection Turn; NULL for pending/expired
  tool                   TEXT NOT NULL CHECK (tool IN ('calendar.reschedule', 'calendar.create')),
  connector_instance_id  TEXT NOT NULL REFERENCES connector_instances(id),
  input_json             TEXT NOT NULL,     -- proposed input JSON (per-tool exact shape)
  target_ref_id          TEXT,              -- NULL ONLY for calendar.create (no source event)
  target_resource_id     TEXT,              -- NULL ONLY for calendar.create (no source event)
  based_on_snapshot_id   TEXT,              -- NULL ONLY for calendar.create (no snapshot)
  expected_revision      TEXT,              -- NULL ONLY for calendar.create (no etag)
  preview_json           TEXT NOT NULL,     -- deterministic safe preview (JSON)
  hash                   TEXT NOT NULL,     -- normalized exact content hash
  status                 TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','expired')),
  created_at             INTEGER NOT NULL,
  expires_at             INTEGER NOT NULL,  -- created_at + 15min (judged by repository clock)
  resolved_at            INTEGER,           -- resolution time (NULL while pending)
  FOREIGN KEY (session_id, source_turn_id) REFERENCES turns(session_id, id),
  FOREIGN KEY (session_id, source_run_id) REFERENCES runs(session_id, id),
  FOREIGN KEY (source_turn_id, source_run_id) REFERENCES runs(turn_id, id),
  FOREIGN KEY (session_id, decision_turn_id) REFERENCES turns(session_id, id),
  FOREIGN KEY (session_id, target_ref_id, target_resource_id, based_on_snapshot_id)
    REFERENCES session_references(session_id, id, resource_id, snapshot_id),
  FOREIGN KEY (connector_instance_id, target_resource_id)
    REFERENCES resources(connector_instance_id, id),
  FOREIGN KEY (target_resource_id, based_on_snapshot_id)
    REFERENCES resource_snapshots(resource_id, id),
  UNIQUE (source_run_id, id),               -- execution compound FK parent
  UNIQUE (session_id, id),                  -- execution/grants session compound FK parent
  UNIQUE (decision_turn_id),                -- at most one proposal per decision Turn
  CHECK (json_valid(input_json)),
  CHECK (json_valid(preview_json)),
  CHECK (expires_at > created_at),
  CHECK (
    (tool = 'calendar.reschedule' AND target_ref_id IS NOT NULL AND target_resource_id IS NOT NULL AND based_on_snapshot_id IS NOT NULL AND expected_revision IS NOT NULL) OR
    (tool = 'calendar.create' AND target_ref_id IS NULL AND target_resource_id IS NULL AND based_on_snapshot_id IS NULL AND expected_revision IS NULL)
  ),
  CHECK (
    (status = 'pending' AND resolved_at IS NULL AND decision_turn_id IS NULL) OR
    (status = 'approved' AND resolved_at IS NOT NULL AND decision_turn_id IS NOT NULL) OR
    (status = 'rejected' AND resolved_at IS NOT NULL AND decision_turn_id IS NOT NULL) OR
    (status = 'expired' AND resolved_at IS NOT NULL AND decision_turn_id IS NULL)
  )
) STRICT;

CREATE UNIQUE INDEX idx_proposals_one_pending_per_session
  ON action_proposals(session_id) WHERE status = 'pending';

CREATE TABLE action_executions (
  id                       TEXT PRIMARY KEY,  -- UUID v4
  session_id               TEXT NOT NULL REFERENCES sessions(id),
  proposal_id              TEXT NOT NULL,
  approval_turn_id         TEXT NOT NULL,
  action_run_id            TEXT NOT NULL,
  status                   TEXT NOT NULL
                           CHECK (status IN ('queued','preflight','executing','succeeded','succeeded_unverified','blocked_stale','failed','unknown')),
  external_call_started_at INTEGER,            -- external-call marker (committed with the executing transition)
  finished_at              INTEGER,            -- terminal-only
  error_code               TEXT,               -- fixed redacted safe code; NOT NULL only for failed
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL,
  FOREIGN KEY (session_id, proposal_id) REFERENCES action_proposals(session_id, id),
  FOREIGN KEY (session_id, approval_turn_id) REFERENCES turns(session_id, id),
  FOREIGN KEY (session_id, action_run_id) REFERENCES runs(session_id, id),
  FOREIGN KEY (approval_turn_id, action_run_id) REFERENCES runs(turn_id, id),
  UNIQUE (proposal_id),                     -- 1 execution per proposal
  UNIQUE (action_run_id),                   -- 1 execution per Action Run
  UNIQUE (session_id, proposal_id, id),     -- grants/receipts compound FK parent
  CHECK (updated_at >= created_at),
  -- Status/marker/terminal CHECK (§18.3): queued/preflight carry no marker,
  -- finish, or error; executing carries the marker only; succeeded/
  -- succeeded_unverified/unknown are markered terminals; blocked_stale is an
  -- unmarkered terminal; failed is finished with a fixed error code and MAY
  -- or may not have the marker (cancel-before-write vs post-marker failure).
  CHECK (
    (status = 'queued' AND external_call_started_at IS NULL AND finished_at IS NULL AND error_code IS NULL) OR
    (status = 'preflight' AND external_call_started_at IS NULL AND finished_at IS NULL AND error_code IS NULL) OR
    (status = 'executing' AND external_call_started_at IS NOT NULL AND finished_at IS NULL AND error_code IS NULL) OR
    (status = 'succeeded' AND external_call_started_at IS NOT NULL AND finished_at IS NOT NULL AND error_code IS NULL) OR
    (status = 'succeeded_unverified' AND external_call_started_at IS NOT NULL AND finished_at IS NOT NULL AND error_code IS NULL) OR
    (status = 'unknown' AND external_call_started_at IS NOT NULL AND finished_at IS NOT NULL AND error_code IS NULL) OR
    (status = 'blocked_stale' AND external_call_started_at IS NULL AND finished_at IS NOT NULL AND error_code IS NULL) OR
    (status = 'failed' AND finished_at IS NOT NULL AND error_code IS NOT NULL)
  )
) STRICT;

CREATE TABLE action_execution_grants (
  execution_id  TEXT PRIMARY KEY REFERENCES action_executions(id),
  session_id    TEXT NOT NULL REFERENCES sessions(id),
  proposal_id   TEXT NOT NULL,
  proposal_hash TEXT NOT NULL,
  tool          TEXT NOT NULL CHECK (tool IN ('calendar.reschedule', 'calendar.create')),
  input_hash    TEXT NOT NULL,
  consumed_at   INTEGER,                     -- set at most once via consumed_at IS NULL CAS
  created_at    INTEGER NOT NULL,
  FOREIGN KEY (session_id, proposal_id, execution_id)
    REFERENCES action_executions(session_id, proposal_id, id),
  FOREIGN KEY (session_id, proposal_id) REFERENCES action_proposals(session_id, id),
  CHECK ((consumed_at IS NULL) OR (consumed_at IS NOT NULL))
) STRICT;

CREATE TABLE action_receipts (
  execution_id          TEXT PRIMARY KEY REFERENCES action_executions(id),
  session_id            TEXT NOT NULL REFERENCES sessions(id),
  proposal_id           TEXT NOT NULL,
  proposal_hash         TEXT NOT NULL,
  outcome               TEXT NOT NULL
                        CHECK (outcome IN ('succeeded','succeeded_unverified','blocked_stale','failed','unknown')),
  preflight_revision    TEXT,                -- source revision key observed at preflight (NULL allowed)
  preflight_snapshot_id TEXT,                -- preflight observation Snapshot (NULL allowed)
  observed_revision     TEXT,                -- post-write verified source revision key (verified only)
  result_snapshot_id    TEXT,                -- post-write verified Snapshot (verified only)
  summary_json          TEXT NOT NULL,       -- safe receipt summary (JSON)
  created_at            INTEGER NOT NULL,
  FOREIGN KEY (session_id, proposal_id, execution_id)
    REFERENCES action_executions(session_id, proposal_id, id),
  FOREIGN KEY (session_id, proposal_id) REFERENCES action_proposals(session_id, id),
  FOREIGN KEY (preflight_snapshot_id) REFERENCES resource_snapshots(id),
  FOREIGN KEY (result_snapshot_id) REFERENCES resource_snapshots(id),
  CHECK (json_valid(summary_json)),
  CHECK (
    (outcome = 'succeeded' AND observed_revision IS NOT NULL AND result_snapshot_id IS NOT NULL) OR
    (outcome = 'succeeded_unverified' AND observed_revision IS NULL AND result_snapshot_id IS NULL) OR
    (outcome = 'blocked_stale' AND preflight_revision IS NOT NULL AND preflight_snapshot_id IS NOT NULL AND observed_revision IS NULL AND result_snapshot_id IS NULL) OR
    (outcome IN ('failed','unknown') AND observed_revision IS NULL AND result_snapshot_id IS NULL)
  )
) STRICT;

-- Restore every preserved row verbatim (old reschedule rows satisfy the new
-- per-tool CHECKs: tool reschedule + full non-NULL target).
INSERT INTO action_proposals SELECT * FROM _m6_action_proposals_backup;
INSERT INTO action_executions SELECT * FROM _m6_action_executions_backup;
INSERT INTO action_execution_grants SELECT * FROM _m6_action_execution_grants_backup;
INSERT INTO action_receipts SELECT * FROM _m6_action_receipts_backup;

DROP TABLE _m6_action_receipts_backup;
DROP TABLE _m6_action_execution_grants_backup;
DROP TABLE _m6_action_executions_backup;
DROP TABLE _m6_action_proposals_backup;
