-- Slice (b) remote-mode login sessions (additive).
-- - `remote_sessions` holds ONLY the SHA-256 hex of the opaque session
--   token (never the token itself; tokens are 256-bit random values sent
--   only in the HttpOnly/Secure/SameSite=Strict cookie). A token hash is
--   not a secret at rest, but it is still lookup-only (no listing route).
-- - `created_at` / `expires_at` enforce the absolute timeout (案 default
--   30d, see COMPANION_REMOTE_JSON); `last_seen_at` enforces the idle
--   timeout (案 default 7d) and is refreshed on every authenticated use.
-- - The password hash itself is NEVER stored here: it lives in the
--   password file named by the remote config (outside SQLite).
-- - No foreign keys: remote logins are operator-level, not session-level.
CREATE TABLE IF NOT EXISTS remote_sessions (
  token_hash   TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
  created_at   INTEGER NOT NULL CHECK (created_at >= 0),
  last_seen_at INTEGER NOT NULL CHECK (last_seen_at >= 0),
  expires_at   INTEGER NOT NULL CHECK (expires_at >= 0)
) STRICT;
