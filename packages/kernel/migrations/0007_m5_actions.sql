-- M5 Action storage (§18 of docs/implementation_plan.md, exact §18.3 DDL).
--
-- Committed migration 0007: adds the four STRICT action tables
-- action_proposals / action_executions / action_execution_grants /
-- action_receipts. No runtime service lands yet (C17+).
--
-- Invariants (must not be weakened):
-- - All tables STRICT with default rowid behavior; JSON columns use
--   CHECK (json_valid(col)) only (kind/version closure is contracts).
-- - Exact compound FKs from §18.3: session/turn/run provenance ownership for
--   proposals; the 4-column target FK
--   (session_id, target_ref_id, target_resource_id, based_on_snapshot_id)
--   -> session_references(session_id, id, resource_id, snapshot_id) binds a
--   proposal to an exact reference of its session WITHOUT any weaker
--   (session_id, target_ref_id) sibling FK; connector/resource and
--   resource/snapshot consistency FKs; execution/grant/receipt compound
--   session ownership FKs; receipt snapshot FKs.
-- - decision_turn_id is UNIQUE (at most one proposal per decision Turn) and
--   partnership with status is enforced by the lifecycle CHECK.
-- - Exactly ONE pending proposal per session: the partial unique index
--   idx_proposals_one_pending_per_session (owned by this SQL file only).
-- - Proposal content (input/target/expectedRevision/preview/hash) is
--   immutable; only status / resolved_at / decision_turn_id may be updated.
-- - Execution marker/terminal CHECK distinguishes pre-marker states,
--   executing (marker set, unfinished), markered terminals and the
--   failed-with-error row (marker either way: cancel-before-write or
--   post-marker failure).
-- - Grant consumption is a one-shot `consumed_at IS NULL` CAS.
-- - Receipt outcome CHECK mirrors the exact §18.7 observation rules.
-- - 15-minute expiry is a repository (clock) decision, NOT a DB CHECK
--   beyond expires_at > created_at.

CREATE TABLE action_proposals (
  id                     TEXT PRIMARY KEY,  -- UUID v4
  session_id             TEXT NOT NULL REFERENCES sessions(id),
  source_turn_id         TEXT NOT NULL,
  source_run_id          TEXT NOT NULL,
  decision_turn_id       TEXT,              -- approval/rejection Turn; NULL for pending/expired
  tool                   TEXT NOT NULL CHECK (tool = 'calendar.reschedule'),
  connector_instance_id  TEXT NOT NULL REFERENCES connector_instances(id),
  input_json             TEXT NOT NULL,     -- proposed input {start,end} (JSON)
  target_ref_id          TEXT NOT NULL,
  target_resource_id     TEXT NOT NULL,
  based_on_snapshot_id   TEXT NOT NULL,
  expected_revision      TEXT NOT NULL,     -- source revision key (source_revision else content_hash)
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
  tool          TEXT NOT NULL CHECK (tool = 'calendar.reschedule'),
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
