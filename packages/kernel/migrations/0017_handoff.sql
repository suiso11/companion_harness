-- AV03 delegation handoffs: human-driven pi-orch handoff records (migration 0017).
--
-- Committed migration 0017: creates THREE new STRICT tables. It touches NO
-- existing table (0001-0016 preserved byte-for-byte, including the 0011
-- autonomy slice, the 0012/0013 shadow queue, the 0014 notification
-- projection, the 0015 conversation-proposal staging, and the 0016
-- learning core): the ONLY writer of the new tables is the handoff core
-- in `handoff.ts` (trusted human HTTP API + model read-only tools). No
-- import into any purpose / task / grant / control / budget / notification
-- / calendar / OAuth writer exists.
--
-- What this is: a BORING durable record of HUMAN-entered delegation
-- handoffs. A handoff binds one EXISTING session-owned task (+ a frozen
-- parent-purpose id/version snapshot) to human-frozen fields: target text,
-- an acceptance-criteria array, a closed operation scope
-- (investigate|implement), human-entered budget TEXT labels, and recorded
-- boundary flags. The model can never create, edit, dispatch, verify, or
-- spawn a handoff: there is NO automatic spawning of any worker/process.
-- Execution stays BLOCKED until a human hands the exported spec to pi-orch
-- manually and records the verified outcome back here.
--
-- Invariants (must not be weakened):
-- - All tables are STRICT, none WITHOUT ROWID.
-- - `target`, `acceptance_criteria`, `op_scope`, `budget_label`,
--   `boundaries` are the immutable FROZEN human input: rows are never
--   UPDATE-rewritten except for `status` / `version` /
--   `needs_reevaluation` / `active_attempt` / `external_ref` /
--   `report_environment` / `report_summary` / `verification_results` /
--   `superseded_by` / `updated_at`. Changing frozen content requires a NEW
--   handoff that supersedes the old one (the old row keeps its frozen
--   content; `superseded_by` links forward, `supersedes_handoff_id` back).
-- - `op_scope` is the closed investigate|implement set. `boundaries` is a
--   JSON array of the CLOSED external_publication|shared_branch|payment|
--   deletion|secret|access_change set: each stored flag means REQUIRES
--   SEPARATE AUTHORIZATION and grants nothing (no grant/control/task
--   column exists at all).
-- - `budget_label` is a human-entered TEXT label only: this migration has
--   no numeric budget column, so nothing here can be enforced numerically
--   or increased by us.
-- - `status` is the closed
--   prepared|dispatched|reported|verified|failed|cancelled set. Verification
--   (`verified`) requires a per-criterion pass + evidence result for EVERY
--   frozen criterion, all passing: the service refuses otherwise (any fail
--   or any missing index can never verify, and frozen criteria are never
--   weakened to pass).
-- - `report_environment` is an UNTRUSTED worker claim (sandbox|production):
--   a sandbox success NEVER sets production. No production-deployment
--   column exists: the spec export labels production as an unverified
--   claim, and verification never flips it.
-- - A verified handoff NEVER completes its task: no task write exists in
--   this migration or its writer module.
-- - `handoff_attempts` is append-only: rows are never updated or deleted.
--   A retry is an explicitly human-recorded attempt row with a REQUIRED
--   closed cause (transient_infra|worker_error|criteria_unmet|
--   environment). No automatic retry exists (no timer/spin column), and no
--   numeric attempt cap is invented: attempts are bounded only by explicit
--   human action.
-- - `needs_reevaluation` is a durable NOTICE (not a mutation of any user
--   purpose): when a parent purpose is revoked/superseded, active handoffs
--   bound to it are flagged in the SAME transaction (never auto-cancelled,
--   never auto-resumed, never auto-completed). New dispatch is refused
--   while the notice is set; cancel is always allowed. Clearing happens
--   only via an explicit human reaffirm (CAS-checked, audited).
-- - Every handoff lifecycle row is append-only history in
--   `handoff_events`; rows are never updated or deleted.
-- - Query batches stay bounded (existing 50/100 list caps); no retry spin,
--   no unbounded arrays, no new numeric model bounds.

CREATE TABLE delegation_handoffs (
  id                      TEXT PRIMARY KEY,  -- UUID v4
  session_id              TEXT NOT NULL REFERENCES sessions(id),
  task_id                 TEXT NOT NULL
                          CHECK (length(task_id) >= 1),
  task_version            INTEGER NOT NULL CHECK (task_version >= 1),
  parent_purpose_id       TEXT,              -- frozen snapshot, may be NULL
  parent_purpose_version  INTEGER            -- frozen snapshot, may be NULL
                          CHECK (parent_purpose_version IS NULL OR parent_purpose_version >= 1),
  target                  TEXT NOT NULL     -- frozen human-entered target
                          CHECK (length(target) >= 1),
  acceptance_criteria     TEXT NOT NULL     -- frozen JSON array of criterion texts
                          CHECK (json_valid(acceptance_criteria)),
  op_scope                TEXT NOT NULL
                          CHECK (op_scope IN ('investigate','implement')),
  budget_label            TEXT              -- human-entered TEXT label only
                          CHECK (budget_label IS NULL OR length(budget_label) >= 1),
  boundaries              TEXT NOT NULL     -- JSON array of the closed boundary set
                          CHECK (json_valid(boundaries)),
  status                  TEXT NOT NULL
                          CHECK (status IN ('prepared','dispatched','reported','verified','failed','cancelled')),
  version                 INTEGER NOT NULL CHECK (version >= 1),
  needs_reevaluation      INTEGER NOT NULL DEFAULT 0 CHECK (needs_reevaluation IN (0,1)),
  active_attempt          INTEGER NOT NULL DEFAULT 0 CHECK (active_attempt >= 0),
  external_ref            TEXT              -- human external ref, recorded never resolved
                          CHECK (external_ref IS NULL OR length(external_ref) >= 1),
  report_environment      TEXT              -- UNTRUSTED worker claim, never production proof
                          CHECK (report_environment IS NULL OR report_environment IN ('sandbox','production')),
  report_summary          TEXT              -- UNTRUSTED worker text
                          CHECK (report_summary IS NULL OR length(report_summary) >= 1),
  verification_results    TEXT              -- JSON array of per-criterion results
                          CHECK (verification_results IS NULL OR json_valid(verification_results)),
  supersedes_handoff_id   TEXT,              -- older frozen record this one replaces
  superseded_by           TEXT,              -- newer record that replaced this one
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL,
  FOREIGN KEY (session_id, task_id) REFERENCES autonomy_tasks(session_id, id),
  UNIQUE (session_id, id),
  CHECK (
    (parent_purpose_id IS NULL AND parent_purpose_version IS NULL)
    OR
    (parent_purpose_id IS NOT NULL AND parent_purpose_version IS NOT NULL)
  )
) STRICT;

CREATE INDEX idx_handoffs_session ON delegation_handoffs(session_id, created_at);
CREATE INDEX idx_handoffs_status ON delegation_handoffs(session_id, status, created_at);
CREATE INDEX idx_handoffs_task ON delegation_handoffs(session_id, task_id, created_at);

CREATE TABLE handoff_attempts (
  id              TEXT PRIMARY KEY,  -- UUID v4
  handoff_id      TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  attempt_no      INTEGER NOT NULL CHECK (attempt_no >= 1),
  cause           TEXT NOT NULL     -- REQUIRED explicit human cause
                  CHECK (cause IN ('transient_infra','worker_error','criteria_unmet','environment')),
  created_at      INTEGER NOT NULL,
  FOREIGN KEY (session_id, handoff_id) REFERENCES delegation_handoffs(session_id, id),
  UNIQUE (handoff_id, attempt_no)
) STRICT;

CREATE INDEX idx_handoff_attempts_handoff ON handoff_attempts(handoff_id, attempt_no);

CREATE TABLE handoff_events (
  id            TEXT PRIMARY KEY,  -- UUID v4
  handoff_id    TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  seq           INTEGER NOT NULL CHECK (seq >= 1),
  event         TEXT NOT NULL
                CHECK (event IN ('prepared','dispatched','reported','verified','failed','cancelled','abnormal_exit','attempt_recorded','superseded','reaffirmed','reevaluation_flagged','reevaluation_cleared')),
  from_status   TEXT,
  to_status     TEXT NOT NULL
                CHECK (to_status IN ('prepared','dispatched','reported','verified','failed','cancelled')),
  note          TEXT,
  created_at    INTEGER NOT NULL,
  FOREIGN KEY (session_id, handoff_id) REFERENCES delegation_handoffs(session_id, id),
  UNIQUE (handoff_id, seq)
) STRICT;

CREATE INDEX idx_handoff_events_handoff ON handoff_events(handoff_id, seq);
