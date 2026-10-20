-- Remote login lockout persistence (additive).
-- - Single-row global failure counter for `/api/remote/login`. The row is
--   seeded here so reads and writes are plain UPDATEs (no race to create).
-- - `failures` counts consecutive failed logins; `locked_until` is the
--   epoch-ms end of the current lockout (0 = never locked); `updated_at`
--   records the last mutation for operators.
-- - The counter is global (never keyed by IP) and survives process
--   restarts, so an auto-deploy restart cannot clear a lockout.
-- - No secrets: this table never holds credentials or session tokens.
CREATE TABLE IF NOT EXISTS remote_login_lockout (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  failures     INTEGER NOT NULL CHECK (failures >= 0),
  locked_until INTEGER NOT NULL CHECK (locked_until >= 0),
  updated_at   INTEGER NOT NULL CHECK (updated_at >= 0)
) STRICT;

INSERT OR IGNORE INTO remote_login_lockout (id, failures, locked_until, updated_at)
VALUES (1, 0, 0, 0);
