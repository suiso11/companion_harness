-- Additive ops-notification kind (branch feat/ops-inapp-notify).
--
-- The deploy / backup / health hooks notify through the EXISTING in-app
-- notification feed ("decision haruka 2026-10-19": option A, no external
-- send). The stored `notifications.kind` / `source_kind` CHECK constraints
-- from 0016 are closed enums, so widening them needs a table rebuild
-- (SQLite has no ALTER CHECK) — the same procedure as 0022.
--
-- Invariants (must not be weakened):
-- - All existing rows (notifications + notification_acks) are preserved
--   verbatim, including ids / seq / fingerprints / acks.
-- - Both tables stay STRICT with every 0016 column, UNIQUE, and CHECK
--   except the two widened closed sets:
--     kind IN ('progress','proposal','question','deadline','commitment','ops')
--     source_kind IN ('shadow_job','action_receipt','task_deadline','ops_event')
-- - Only `notification_acks` references `notifications`; it is rebuilt in
--   the same transaction (child first out, then rename keeps the FK name)
--   so the FK target never disappears.
-- - The three 0016 indexes are recreated with identical definitions.
-- - `notification_cursors` / `notification_deadline_schedule` are
--   untouched: ops notices are written directly (never via source
--   cursors), so ingest semantics for the three durable sources are
--   unchanged.
--
-- Ops notice conventions (kernel `recordSystemNotice`):
--   kind='ops', scope='ops', source_kind='ops_event',
--   source_id='ops:<hook>:<target>' (1..128), priority derived from the
--   CLI level (info -> routine, error -> urgent), briefText =
--   '<title> — <body>' truncated to 500 code points, context_expiry_at
--   NULL (never expires), cited_deadlines '[]'.

CREATE TABLE notifications_new (
  id              TEXT PRIMARY KEY,  -- UUID v4
  session_id      TEXT NOT NULL REFERENCES sessions(id),
  seq             INTEGER NOT NULL CHECK (seq >= 1),  -- per-session monotonic
  scope           TEXT NOT NULL
                  CHECK (length(scope) >= 1 AND length(scope) <= 128),
  kind            TEXT NOT NULL
                  CHECK (kind IN ('progress','proposal','question','deadline','commitment','ops')),
  priority        TEXT NOT NULL
                  CHECK (priority IN ('routine','urgent')),
  brief_text      TEXT NOT NULL     -- fixed safe system provenance (+ UNTRUSTED model phrasing when present)
                  CHECK (length(brief_text) >= 1 AND length(brief_text) <= 500),
  source_kind     TEXT NOT NULL
                  CHECK (source_kind IN ('shadow_job','action_receipt','task_deadline','ops_event')),
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

INSERT INTO notifications_new
  (id, session_id, seq, scope, kind, priority, brief_text, source_kind,
   source_id, source_version, source_epoch, cited_deadlines, fingerprint,
   outdated, context_expiry_at, created_at)
SELECT id, session_id, seq, scope, kind, priority, brief_text, source_kind,
       source_id, source_version, source_epoch, cited_deadlines, fingerprint,
       outdated, context_expiry_at, created_at
FROM notifications;

CREATE TABLE notification_acks_new (
  notification_id TEXT PRIMARY KEY REFERENCES notifications_new(id),
  session_id      TEXT NOT NULL REFERENCES sessions(id),
  ack_key         TEXT NOT NULL,  -- stable caller UUID v4 (lowercased)
  ack_body        TEXT NOT NULL CHECK (json_valid(ack_body)),
  created_at      INTEGER NOT NULL,
  UNIQUE (session_id, ack_key)
) STRICT;

INSERT INTO notification_acks_new
  (notification_id, session_id, ack_key, ack_body, created_at)
SELECT notification_id, session_id, ack_key, ack_body, created_at
FROM notification_acks;

-- Child table out first, then the (now unreferenced) parent.
DROP TABLE notification_acks;
DROP TABLE notifications;

ALTER TABLE notifications_new RENAME TO notifications;
ALTER TABLE notification_acks_new RENAME TO notification_acks;

CREATE INDEX idx_notifications_session ON notifications(session_id, seq DESC);
CREATE INDEX idx_notifications_session_kind ON notifications(session_id, kind, seq DESC);
CREATE INDEX idx_notification_acks_session ON notification_acks(session_id, created_at);
