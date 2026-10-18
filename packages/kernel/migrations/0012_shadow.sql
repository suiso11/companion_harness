-- AV02 shadow-deliberation durable core (migration 0012).
--
-- Committed migration 0012: creates FOUR new STRICT tables for durable
-- shadow deliberation. It touches NO existing table (0001-0011 preserved
-- byte-for-byte, including the 0011 autonomy slice): purposes/tasks/
-- conflicts/control/activity keep their exact shapes, and the ONLY writer
-- of the autonomy tables stays `autonomy.ts`.
--
-- What shadow deliberation is: model proposals about policy state that are
-- recorded and classified by CODE, but NEVER execution authority. There is
-- NO grant / capability / calendar / ToolBroker / child-process / device /
-- secret column anywhere here: a recorded `permission` purpose stays a
-- CLAIM, and a completed shadow job stores a MODEL decision SEPARATE from
-- the CODE policy code (`missing_grant` /
-- `wish_not_command` / `external_no_authority` / `needs_clarification` /
-- `no_action`). NOTHING in this migration can trigger external execution.
--
-- Durability contract (enforced by the service, same-transaction writes):
-- - `shadow_scope_epochs` holds ONE monotonically increasing epoch per
--   (session, scope). EVERY purpose/task/conflict state change bumps the
--   epoch for its scope — even while the global control is paused — so a
--   constraint created DURING a model call invalidates the in-flight output
--   even when every existing record version is unchanged. Per-scope epochs
--   keep unrelated-scope work from invalidating this job.
-- - `shadow_inbox` is the durable event source: `enqueueShadowSourceInTx`
--   appends EXACTLY ONE inbox row in the SAME transaction as the autonomy
--   state change (no enqueue-after-commit crash window). Rows recorded
--   while the control is paused carry disposition `recorded` and create NO
--   job; a later resume marks them `skipped` (no catchup, no bulk replay).
--   Rows recorded while unpaused create (or reuse) a pending job in the
--   same transaction and carry disposition `consumed`.
-- - `shadow_jobs` is the durable queue. `pending` awaits a worker claim;
--   `claimed` freezes the FULL context + both epochs under a lease;
--   `completed` stores the validated MODEL decision + CODE policy with
--   ZERO execution; `held`/`failed`/`cancelled` are terminal for that job
--   (new work always arrives as a NEW job). Lease columns are set EXACTLY
--   while claimed; context is present EXACTLY once claimed/completed; the
--   model decision + policy are present EXACTLY once completed.
-- - `shadow_job_events` is append-only per-job history (never updated or
--   deleted). Shadow's OWN writes never enqueue further work (no jobs from
--   own job/log writes, no timers, no polling).
-- - `shadow_jobs.request_reason` is plain nullable TEXT holding the
--   UNTRUSTED explicit-request text (NULL for policy-change / reason-less
--   jobs; length is enforced at the Zod boundary, 1..500 chars). Folded
--   into this CREATE TABLE (not a later ALTER) to keep the migration
--   numbering collision-free.
--
-- Invariants (must not be weakened):
-- - All tables are STRICT, none WITHOUT ROWID.
-- - Original purpose/task rows are never rewritten here: only version/
--   status/epoch reads fence a late completion into `held`.
-- - A global pause holds pending jobs (never bulk-replays them); a resume
--   never catches up paused-time events; a restart holds claimed/pending
--   jobs (the 0011 restart fence already re-pauses the control first).

CREATE TABLE shadow_scope_epochs (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  scope      TEXT NOT NULL
             CHECK (length(scope) >= 1 AND length(scope) <= 128),
  epoch      INTEGER NOT NULL CHECK (epoch >= 1),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, scope)
) STRICT;

CREATE TABLE shadow_inbox (
  id              TEXT PRIMARY KEY,  -- UUID v4
  session_id      TEXT NOT NULL REFERENCES sessions(id),
  scope           TEXT NOT NULL
                  CHECK (length(scope) >= 1 AND length(scope) <= 128),
  kind            TEXT NOT NULL
                  CHECK (kind IN ('policy_change','explicit_request')),
  trigger_event   TEXT NOT NULL     -- e.g. purpose.created, task.held, conflict.recorded, explicit.request
                  CHECK (length(trigger_event) >= 1 AND length(trigger_event) <= 128),
  trigger_id      TEXT,              -- purpose/task/conflict id, NULL for scope-level requests
  control_version INTEGER NOT NULL CHECK (control_version >= 1),
  scope_epoch     INTEGER NOT NULL CHECK (scope_epoch >= 1),
  disposition     TEXT NOT NULL
                  CHECK (disposition IN ('recorded','consumed','skipped')),
  job_id          TEXT,              -- set when consumed by a job, NULL otherwise
  created_at      INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_shadow_inbox_session ON shadow_inbox(session_id, created_at);
CREATE INDEX idx_shadow_inbox_disposition ON shadow_inbox(session_id, disposition, created_at);

CREATE TABLE shadow_jobs (
  id                    TEXT PRIMARY KEY,  -- UUID v4
  session_id            TEXT NOT NULL REFERENCES sessions(id),
  scope                 TEXT NOT NULL
                        CHECK (length(scope) >= 1 AND length(scope) <= 128),
  kind                  TEXT NOT NULL
                        CHECK (kind IN ('policy_change','explicit_request')),
  status                TEXT NOT NULL
                        CHECK (status IN ('pending','claimed','completed','held','failed','cancelled')),
  trigger_event         TEXT NOT NULL
                        CHECK (length(trigger_event) >= 1 AND length(trigger_event) <= 128),
  trigger_id            TEXT,
  request_key           TEXT,              -- stable caller key (explicit requests only)
  request_reason        TEXT,              -- UNTRUSTED explicit-request text (NULL for policy-change / reason-less jobs)
  control_version       INTEGER NOT NULL CHECK (control_version >= 1),
  scope_epoch           INTEGER NOT NULL CHECK (scope_epoch >= 1),
  claim_control_version INTEGER CHECK (claim_control_version IS NULL OR claim_control_version >= 1),
  claim_scope_epoch     INTEGER CHECK (claim_scope_epoch IS NULL OR claim_scope_epoch >= 1),
  context_json          TEXT               -- frozen FULL context (claim time), json_valid
                        CHECK (context_json IS NULL OR json_valid(context_json)),
  model_decision_json   TEXT               -- validated MODEL output (complete time), json_valid
                        CHECK (model_decision_json IS NULL OR json_valid(model_decision_json)),
  policy_code           TEXT               -- CODE policy (complete time only, never model-chosen)
                         CHECK (policy_code IS NULL OR policy_code IN ('shadow_only','missing_grant','wish_not_command','external_no_authority','needs_clarification','no_action')),
  version               INTEGER NOT NULL CHECK (version >= 1),
  lease_owner           TEXT CHECK (lease_owner IS NULL OR length(lease_owner) >= 1),
  lease_expires_at      INTEGER,
  hold_reason           TEXT               -- fixed redacted code (held only)
                        CHECK (hold_reason IS NULL OR hold_reason IN ('control_paused','control_version_drift','scope_epoch_drift','target_changed','target_inapplicable','lease_expired','lease_mismatch','aborted_foreground','context_too_large','requested_while_paused','restart_interrupted')),
  fail_code             TEXT               -- fixed redacted code (failed only)
                        CHECK (fail_code IS NULL OR fail_code IN ('model_error','gateway_empty','aborted')),
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  CHECK (
    (status = 'claimed' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL AND context_json IS NOT NULL AND model_decision_json IS NULL AND policy_code IS NULL AND hold_reason IS NULL AND fail_code IS NULL) OR
    (status = 'pending' AND lease_owner IS NULL AND lease_expires_at IS NULL AND context_json IS NULL AND model_decision_json IS NULL AND policy_code IS NULL AND hold_reason IS NULL AND fail_code IS NULL) OR
    (status = 'completed' AND lease_owner IS NULL AND lease_expires_at IS NULL AND context_json IS NOT NULL AND model_decision_json IS NOT NULL AND policy_code IS NOT NULL AND hold_reason IS NULL AND fail_code IS NULL) OR
    (status = 'held' AND lease_owner IS NULL AND lease_expires_at IS NULL AND model_decision_json IS NULL AND policy_code IS NULL AND hold_reason IS NOT NULL AND fail_code IS NULL) OR
    (status = 'failed' AND lease_owner IS NULL AND lease_expires_at IS NULL AND model_decision_json IS NULL AND policy_code IS NULL AND hold_reason IS NULL AND fail_code IS NOT NULL) OR
    (status = 'cancelled' AND lease_owner IS NULL AND lease_expires_at IS NULL AND model_decision_json IS NULL AND policy_code IS NULL AND hold_reason IS NULL AND fail_code IS NULL)
  )
) STRICT;

CREATE INDEX idx_shadow_jobs_session ON shadow_jobs(session_id, status, created_at);
CREATE INDEX idx_shadow_jobs_trigger ON shadow_jobs(session_id, scope, trigger_event, trigger_id, status);
-- Stable explicit-request keys replay per session (policy-change jobs use NULL keys).
CREATE UNIQUE INDEX ux_shadow_jobs_explicit_key ON shadow_jobs(session_id, request_key) WHERE kind = 'explicit_request' AND request_key IS NOT NULL;

CREATE TABLE shadow_job_events (
  id          TEXT PRIMARY KEY,  -- UUID v4
  job_id      TEXT NOT NULL REFERENCES shadow_jobs(id),
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  seq         INTEGER NOT NULL CHECK (seq >= 1),
  event       TEXT NOT NULL
              CHECK (event IN ('enqueued','claimed','completed','held','failed','cancelled','superseded')),
  from_status TEXT
              CHECK (from_status IS NULL OR from_status IN ('pending','claimed','completed','held','failed','cancelled')),
  to_status   TEXT NOT NULL
              CHECK (to_status IN ('pending','claimed','completed','held','failed','cancelled')),
  note        TEXT CHECK (note IS NULL OR length(note) <= 500),
  created_at  INTEGER NOT NULL,
  UNIQUE (job_id, seq)
) STRICT;

CREATE INDEX idx_shadow_job_events_job ON shadow_job_events(job_id, seq);
