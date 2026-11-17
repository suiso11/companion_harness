-- Background agent sessions (persona autotalk main turns) are execution
-- vehicles, not user conversations: they must not appear in the session
-- selector and must never be the companion-message default target.
ALTER TABLE sessions ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0
  CHECK (hidden IN (0, 1));

CREATE INDEX idx_sessions_visible_activity
  ON sessions(last_active_at DESC, created_at DESC, id DESC) WHERE hidden = 0;
