-- Human approval may widen a staged read-only trial to write inside the SAME
-- frozen allowedPaths. The staged proposal keeps its own read_only value; the
-- human's choice is recorded on the grant.
ALTER TABLE trial_grants ADD COLUMN allow_write INTEGER NOT NULL DEFAULT 0
  CHECK (allow_write IN (0, 1));
