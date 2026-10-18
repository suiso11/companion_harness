-- AV05 notifications durable-projection core (migration 0016).
--
-- Committed migration 0016: creates FOUR new STRICT tables for the durable
-- notification projection + explicit-deadline schedule. It touches NO
-- existing table (0001-0015 preserved byte-for-byte, including the 0011
-- autonomy slice, the 0012/0013 trial authority/lifecycle and the 0014/0015 shadow queue): the ONLY writer of the
-- new tables is `notifications.ts`, and NO import into the M5 receipt
-- writer (`action_executions.ts`) exists — old M6-historical / v9-fixture
-- paths that run modern M5 helpers before upgrade-16 must never need these
-- tables and never hit a silent no-such-table fallback on the write path.
--
-- What this is: a BORING durable PROJECTION from EXISTING append-only
-- sources. The sources (shadow_job_events, action_receipts,
-- autonomy_task_events) are already durable; the store advances a per-
-- (session, source) cursor and inserts notification / projection rows in
-- the SAME transaction. Catchup consumes only durable UNSEEN changes and
-- never re-executes work. There is NO model invoke, NO ToolBroker, NO
-- worker, NO calendar write, NO grant / capability / OAuth / secret column
-- anywhere here: a recorded `permission` CLAIM stays a claim, and an ack
-- changes NO purpose / task / control / Calendar grant / proposal.
--
-- Cursor baseline: migration 0016 INSERTs one cursor row per
-- (pre-existing session, source) at that session's current MAX(source
-- rowid) with a NULL key anchor (grandfathered: anchor checks are skipped
-- while the anchor is NULL, MAX-vs-cursor renumber checks still apply),
-- so historical pre-existing jobs / receipts are NOT mass-notified, and
-- an AFTER-INSERT-ON-sessions trigger initializes the three cursor rows
-- (rowid 0, NULL anchor) for every NEW session. The kernel NEVER lazily
-- baselines at MAX on first ingest: a new session's FIRST source event is
-- always consumed, and a missing cursor after migration/trigger is an
-- honest `notification_projection_reset_required`, never a silent skip.
-- Anchor: every cursor advance stores the source KEY at the frontier
-- rowid (`shadow_job_events.id`, `action_receipts.execution_id`,
-- `autonomy_task_events.id`) in the SAME transaction; before advancing
-- the kernel verifies the rowid at the stored cursor still carries the
-- anchored key for the OWN session, so a same-or-higher-MAX rowid
-- reuse / reorder / rebuild surfaces an honest reset with ZERO partial
-- progress instead of silently skipping. SQLite ROWID append-only sources
-- are acceptable while no VACUUM / DELETE runs against them.
--
-- Invariants (must not be weakened):
-- - All tables are STRICT, none WITHOUT ROWID (ROWID cursors required).
-- - Notifications are immutable original records: rows are never UPDATE-
--   rewritten except the derived `outdated` flag (source expired /
--   superseded questions stay HISTORY; the derived actionable state may
--   mark them outdated without assuming an answer or ack, and old
--   questions are never re-nudged after a purpose change).
-- - Dedup is semantic-state based: UNIQUE(session_id, fingerprint) where
--   the fingerprint covers (session / scope / scope-epoch / kind /
--   subject) and EXCLUDES paraphrased reason / model text / source job id
--   for the SAME state, so repeated explicit re-evaluation does not spam.
--   A do-nothing shadow completion inserts ZERO rows.
-- - Acks are separate immutable receipts: one row per notification, stable
--   key replay, same-body replay, drift 409. Reads never auto-ack.
-- - The deadline schedule is a DERIVED projection only: original task rows
--   are NEVER changed or deleted here; only derived schedule rows may be
--   upserted / removed (terminal tasks drop their schedule row). No queue,
--   no catchup of offline time, no window-as-deadline, no model dates.
-- - Query batches stay bounded (existing 50 / 100 list caps); no retry
--   spin, no unbounded arrays, no new numeric model bounds.

CREATE TABLE notification_cursors (
  session_id        TEXT NOT NULL REFERENCES sessions(id),
  source            TEXT NOT NULL
                    CHECK (source IN ('shadow_job_events','action_receipts','autonomy_task_events')),
  last_source_rowid INTEGER NOT NULL CHECK (last_source_rowid >= 0),
  last_source_key   TEXT,  -- immutable source key at the frontier rowid (NULL = grandfathered baseline / fresh session)
  updated_at        INTEGER NOT NULL,
  PRIMARY KEY (session_id, source)
) STRICT;

CREATE TABLE notifications (
  id              TEXT PRIMARY KEY,  -- UUID v4
  session_id      TEXT NOT NULL REFERENCES sessions(id),
  seq             INTEGER NOT NULL CHECK (seq >= 1),  -- per-session monotonic
  scope           TEXT NOT NULL
                  CHECK (length(scope) >= 1 AND length(scope) <= 128),
  kind            TEXT NOT NULL
                  CHECK (kind IN ('progress','proposal','question','deadline','commitment')),
  priority        TEXT NOT NULL
                  CHECK (priority IN ('routine','urgent')),
  brief_text      TEXT NOT NULL     -- fixed safe system provenance (+ UNTRUSTED model phrasing when present)
                  CHECK (length(brief_text) >= 1 AND length(brief_text) <= 500),
  source_kind     TEXT NOT NULL
                  CHECK (source_kind IN ('shadow_job','action_receipt','task_deadline')),
  source_id       TEXT NOT NULL     -- hidden link id (never a user-visible URL/UUID surface)
                  CHECK (length(source_id) >= 1 AND length(source_id) <= 128),
  source_version  INTEGER CHECK (source_version IS NULL OR source_version >= 1),
  source_epoch    INTEGER CHECK (source_epoch IS NULL OR source_epoch >= 1),
  cited_deadlines TEXT NOT NULL     -- JSON array of EXPLICIT cited deadlines (max 8, json_valid)
                  CHECK (json_valid(cited_deadlines)),
  fingerprint     TEXT NOT NULL     -- semantic-state dedup key (excludes paraphrase/model text/job id)
                  CHECK (length(fingerprint) >= 1 AND length(fingerprint) <= 500),
  outdated        INTEGER NOT NULL CHECK (outdated IN (0,1)) DEFAULT 0,
  context_expiry_at INTEGER  -- DERIVED question-context expiry (Unix-ms): min FUTURE applicability boundary at creation; NULL = no expiry
                    CHECK (context_expiry_at IS NULL OR context_expiry_at >= 0),
  created_at      INTEGER NOT NULL,
  UNIQUE (session_id, seq),
  UNIQUE (session_id, fingerprint)
) STRICT;

CREATE INDEX idx_notifications_session ON notifications(session_id, seq DESC);
CREATE INDEX idx_notifications_session_kind ON notifications(session_id, kind, seq DESC);

CREATE TABLE notification_acks (
  notification_id TEXT PRIMARY KEY REFERENCES notifications(id),
  session_id      TEXT NOT NULL REFERENCES sessions(id),
  ack_key         TEXT NOT NULL,  -- stable caller UUID v4 (lowercased)
  ack_body        TEXT NOT NULL CHECK (json_valid(ack_body)),
  created_at      INTEGER NOT NULL,
  UNIQUE (session_id, ack_key)
) STRICT;

CREATE INDEX idx_notification_acks_session ON notification_acks(session_id, created_at);

-- Derived explicit-deadline projection: source is user-explicit kind=task +
-- speaker=user + non-terminal + strict-RFC3339-deadline tasks ONLY. No
-- model dates, no goal validFrom/validUntil windows as deadlines.
CREATE TABLE notification_deadline_schedule (
  task_id              TEXT PRIMARY KEY,  -- owned task id (hidden link)
  session_id           TEXT NOT NULL REFERENCES sessions(id),
  scope                TEXT NOT NULL
                       CHECK (length(scope) >= 1 AND length(scope) <= 128),
  due_at               INTEGER NOT NULL CHECK (due_at >= 0),  -- numeric Unix-ms for indexed earliest query
  observed_task_version INTEGER NOT NULL CHECK (observed_task_version >= 1),
  source_updated_at    INTEGER NOT NULL,  -- task updated_at at observation (resume-cutoff comparison)
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  FOREIGN KEY (session_id, task_id) REFERENCES autonomy_tasks(session_id, id)
) STRICT;

CREATE INDEX idx_notification_deadline_session_due
  ON notification_deadline_schedule(session_id, due_at);

-- Baseline cursors for ALL pre-existing sessions at their current session-
-- scoped MAX(source rowid) (NULL anchor: grandfathered, see header), so
-- upgrading a populated store never mass-notifies historical rows.
INSERT INTO notification_cursors (session_id, source, last_source_rowid, last_source_key, updated_at)
SELECT s.id, 'shadow_job_events',
  COALESCE((SELECT MAX(rowid) FROM shadow_job_events e WHERE e.session_id = s.id), 0),
  NULL, CAST(strftime('%s','now') AS INTEGER) * 1000
FROM sessions s;
INSERT INTO notification_cursors (session_id, source, last_source_rowid, last_source_key, updated_at)
SELECT s.id, 'action_receipts',
  COALESCE((SELECT MAX(rowid) FROM action_receipts e WHERE e.session_id = s.id), 0),
  NULL, CAST(strftime('%s','now') AS INTEGER) * 1000
FROM sessions s;
INSERT INTO notification_cursors (session_id, source, last_source_rowid, last_source_key, updated_at)
SELECT s.id, 'autonomy_task_events',
  COALESCE((SELECT MAX(rowid) FROM autonomy_task_events e WHERE e.session_id = s.id), 0),
  NULL, CAST(strftime('%s','now') AS INTEGER) * 1000
FROM sessions s;

-- Every NEW session starts all three cursors at rowid 0 / NULL anchor
-- BEFORE any source row exists, so its first source event is consumed.
-- Session-idempotent replay (same id, no INSERT) never touches cursors.
CREATE TRIGGER trg_notification_cursors_init_session
AFTER INSERT ON sessions
BEGIN
  INSERT INTO notification_cursors (session_id, source, last_source_rowid, last_source_key, updated_at)
  VALUES (NEW.id, 'shadow_job_events', 0, NULL, NEW.created_at),
         (NEW.id, 'action_receipts', 0, NULL, NEW.created_at),
         (NEW.id, 'autonomy_task_events', 0, NULL, NEW.created_at);
END;
