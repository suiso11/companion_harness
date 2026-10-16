-- AV autonomy slice: durable PURPOSE records + explicit TASK lifecycle +
-- persistent global autonomous-work stop control.
--
-- Committed migration 0011: creates SEVEN new STRICT tables. It touches NO
-- existing table (0007 M5 action tables, 0008/0009 memory tables, and the M6
-- 0010 rebuild are preserved byte-for-byte), so it cannot collide with the
-- M6 migration 0010 reserved on the stacked base.
--
-- Invariants (must not be weakened):
-- - All tables are STRICT, none WITHOUT ROWID.
-- - `autonomy_purposes.statement` is the immutable ORIGINAL source text:
--   rows are never UPDATE-rewritten except for `status` / `version` /
--   `updated_at` / `superseded_by`. An explicit correction appends a NEW row
--   and CAS-transitions the exact referenced old row to `superseded` in one
--   transaction (never latest-wins over an unrelated row). The AI
--   interpretation lives in a SEPARATE nullable column, never merged into the
--   source statement.
-- - `kind` is the closed goal/preference/constraint/permission/wish/
--   temporary_state set; `source_kind` is the closed user/self/external set;
--   `status` is active/superseded/revoked/achieved. A recorded `permission`
--   row is ONLY a claim: no executable grant, capability write, OAuth, or
--   config row exists in this migration.
-- - `valid_from` / `valid_until` are the explicit applicability window
--   (AV01): NULL bounds are unbounded, present bounds are TEXT validated by
--   the service against the existing strict RFC3339-with-explicit-offset
--   grammar with validUntil after validFrom. No TTL, auto-archive, or
--   auto-revocation exists: expiry only gates task start/resume and holds
--   dependents, never deletes or rewrites.
-- - `autonomy_tasks` is an explicit LOCAL entity only: title/body/kind/
--   speaker/nullable deadline/optional parent purpose/status. There is NO
--   calendar/provider/scheduling column here — tasks never become calendar
--   events. `deadline` is TEXT validated by the service against the existing
--   strict RFC3339-with-explicit-offset grammar (NULL preserved, never
--   inferred). `hold_reason` + `reconsider_trigger` are NOT NULL exactly
--   while `status = 'held'`.
-- - Completed/cancelled tasks are terminal: revival is rejected by the
--   service (no physical DELETE exists anywhere here).
-- - `autonomy_control` is a singleton (`id = 'global'` CHECK): `paused`
--   survives restarts by construction (plain durable row). It is SEEDED
--   paused (new installs default to stopped autonomous work). Every server
--   start runs the restart fence AFTER migration: a previously UNPAUSED
--   control is flipped back to PAUSED (version advance, restart reason) in
--   the same transaction that appends `restart_fence` + `interrupted_note`
--   rows; an already-paused control stays paused with no version change.
-- - `autonomy_activity` is an append-only log with a closed kind set
--   (user_message/autonomy_stopped/autonomy_resumed/restart_fence/
--   interrupted_note). User content, secrets, and provider ids are NEVER
--   columns here.
-- - Every purpose/task event row is append-only history
--   (`autonomy_purpose_events` / `autonomy_task_events`); rows are never
--   updated or deleted by the service.

CREATE TABLE autonomy_purposes (
  id                 TEXT PRIMARY KEY,  -- UUID v4
  session_id         TEXT NOT NULL REFERENCES sessions(id),
  scope              TEXT NOT NULL
                     CHECK (length(scope) >= 1 AND length(scope) <= 128),
  kind               TEXT NOT NULL
                     CHECK (kind IN ('goal','preference','constraint','permission','wish','temporary_state')),
  is_explicit        INTEGER NOT NULL CHECK (is_explicit IN (0,1)),
  source_kind        TEXT NOT NULL
                     CHECK (source_kind IN ('user','self','external')),
  source_turn_id     TEXT,              -- same-session turn, NULL when absent
  statement          TEXT NOT NULL     -- immutable ORIGINAL source statement
                     CHECK (length(statement) >= 1),
  interpretation     TEXT              -- separate AI interpretation, NULL when absent
                     CHECK (interpretation IS NULL OR length(interpretation) >= 1),
  status             TEXT NOT NULL
                     CHECK (status IN ('active','superseded','revoked','achieved')),
  version            INTEGER NOT NULL CHECK (version >= 1),
  superseded_by      TEXT,              -- correction successor, NULL otherwise
  valid_from         TEXT,              -- explicit applicability start (strict RFC3339) or NULL unbounded
  valid_until        TEXT,              -- explicit applicability end (strict RFC3339) or NULL unbounded
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  FOREIGN KEY (session_id, source_turn_id) REFERENCES turns(session_id, id),
  UNIQUE (session_id, id)
) STRICT;

CREATE INDEX idx_autonomy_purposes_session ON autonomy_purposes(session_id, created_at);
CREATE INDEX idx_autonomy_purposes_scope ON autonomy_purposes(session_id, scope, kind, status);

CREATE TABLE autonomy_purpose_events (
  id           TEXT PRIMARY KEY,  -- UUID v4
  purpose_id   TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  seq          INTEGER NOT NULL CHECK (seq >= 1),
  event        TEXT NOT NULL
               CHECK (event IN ('created','corrected','superseded','revoked','achieved')),
  from_status  TEXT,
  to_status    TEXT NOT NULL
               CHECK (to_status IN ('active','superseded','revoked','achieved')),
  statement    TEXT NOT NULL CHECK (length(statement) >= 1),
  created_at   INTEGER NOT NULL,
  FOREIGN KEY (session_id, purpose_id) REFERENCES autonomy_purposes(session_id, id),
  UNIQUE (purpose_id, seq)
) STRICT;

CREATE INDEX idx_autonomy_purpose_events_purpose ON autonomy_purpose_events(purpose_id, seq);

-- Explicit owner-recorded conflict relations (append-only, immutable).
-- Same-session/scope pairs only; cross-kind (goal vs constraint) allowed.
-- Same-kind prose similarity alone is NEVER a conflict: only rows here list.
-- Both purposes must be active at record time; inactive pairs stay in
-- history but are filtered from the active listing (never auto-resolved).
CREATE TABLE autonomy_purpose_conflicts (
  id           TEXT PRIMARY KEY,  -- UUID v4
  session_id   TEXT NOT NULL REFERENCES sessions(id),
  purpose_a_id TEXT NOT NULL,     -- canonically ordered (a < b)
  purpose_b_id TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  FOREIGN KEY (session_id, purpose_a_id) REFERENCES autonomy_purposes(session_id, id),
  FOREIGN KEY (session_id, purpose_b_id) REFERENCES autonomy_purposes(session_id, id),
  UNIQUE (session_id, purpose_a_id, purpose_b_id),
  CHECK (purpose_a_id != purpose_b_id)
) STRICT;

CREATE INDEX idx_autonomy_purpose_conflicts_session ON autonomy_purpose_conflicts(session_id, created_at);

CREATE TABLE autonomy_tasks (
  id                  TEXT PRIMARY KEY,  -- UUID v4
  session_id          TEXT NOT NULL REFERENCES sessions(id),
  scope               TEXT NOT NULL     -- explicit metadata scope (parent must share it)
                      CHECK (length(scope) >= 1 AND length(scope) <= 128),
  title               TEXT NOT NULL
                      CHECK (length(title) >= 1 AND length(title) <= 256),
  body                TEXT
                      CHECK (body IS NULL OR length(body) >= 1),
  kind                TEXT NOT NULL
                      CHECK (kind IN ('chat','wish','problem','task')),
  speaker             TEXT NOT NULL
                      CHECK (speaker IN ('user','self','external')),
  deadline            TEXT,              -- strict RFC3339 explicit-offset or NULL (never inferred)
  parent_purpose_id   TEXT,              -- same-session/scope owned purpose, NULL when standalone
  status              TEXT NOT NULL
                      CHECK (status IN ('open','in_progress','held','completed','cancelled')),
  version             INTEGER NOT NULL CHECK (version >= 1),
  hold_reason         TEXT,              -- NOT NULL exactly while held
  reconsider_trigger  TEXT,              -- NOT NULL exactly while held
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  FOREIGN KEY (session_id, parent_purpose_id) REFERENCES autonomy_purposes(session_id, id),
  UNIQUE (session_id, id),
  CHECK (
    (status = 'held' AND hold_reason IS NOT NULL AND reconsider_trigger IS NOT NULL) OR
    (status != 'held' AND hold_reason IS NULL AND reconsider_trigger IS NULL)
  )
) STRICT;

CREATE INDEX idx_autonomy_tasks_session ON autonomy_tasks(session_id, created_at);
CREATE INDEX idx_autonomy_tasks_parent ON autonomy_tasks(parent_purpose_id);

CREATE TABLE autonomy_task_events (
  id          TEXT PRIMARY KEY,  -- UUID v4
  task_id     TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  seq         INTEGER NOT NULL CHECK (seq >= 1),
  event       TEXT NOT NULL
              CHECK (event IN ('created','started','held','resumed','completed','cancelled','parent_held')),
  from_status TEXT,
  to_status   TEXT NOT NULL
              CHECK (to_status IN ('open','in_progress','held','completed','cancelled')),
  note        TEXT,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (session_id, task_id) REFERENCES autonomy_tasks(session_id, id),
  UNIQUE (task_id, seq)
) STRICT;

CREATE INDEX idx_autonomy_task_events_task ON autonomy_task_events(task_id, seq);

-- Singleton stop control (exactly one row, seeded PAUSED for new installs).
CREATE TABLE autonomy_control (
  id         TEXT PRIMARY KEY CHECK (id = 'global'),
  paused     INTEGER NOT NULL CHECK (paused IN (0,1)),
  version    INTEGER NOT NULL CHECK (version >= 1),
  reason     TEXT CHECK (reason IS NULL OR length(reason) <= 500),
  updated_at INTEGER NOT NULL
) STRICT;

INSERT INTO autonomy_control (id, paused, version, reason, updated_at)
  VALUES ('global', 1, 1, 'default_paused', 0);

-- Append-only activity log (fixed kinds; no user content/secrets/ids).
CREATE TABLE autonomy_activity (
  id         TEXT PRIMARY KEY,  -- UUID v4
  kind       TEXT NOT NULL
             CHECK (kind IN ('user_message','autonomy_stopped','autonomy_resumed','restart_fence','interrupted_note')),
  session_id TEXT,              -- NULL for global control/restart entries
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
) STRICT;

CREATE INDEX idx_autonomy_activity_session ON autonomy_activity(session_id, created_at);
