-- M4 (C12) private Calendar get-target store.
--
-- Committed migration 0006: adds a NON-PUBLIC table that maps an opaque
-- Calendar canonical key to the host-private upstream `get-event` target
-- (calendarId / eventId / optional account). It is what lets `reference.refresh`
-- re-read a stored Calendar reference across process restarts WITHOUT exposing
-- provider ids in any Snapshot/body, model-facing output, public DTO or error.
--
-- Invariants (must not be weakened):
-- - STRICT table, default rowid behavior.
-- - `canonical_key` is the ONLY identity: the opaque Calendar key already
--   binds connectorInstanceId + calendarId + eventId, so no provider id is a
--   key column.
-- - `target_json` is the private target only (`{calendarId,eventId,account?}`);
--   it MUST be valid JSON. It is never joined into any public read path.
-- - Writes are issued by the kernel INSIDE the same observation transaction
--   (after its running-status/CAS recheck), so a cancelled/late/failed call
--   writes nothing and a committed Snapshot/rN can never exist without its
--   target (and vice versa).
-- - No secret/token/credential is ever stored here.

CREATE TABLE calendar_get_targets (
  canonical_key TEXT PRIMARY KEY
                CHECK (length(canonical_key) >= 1 AND length(canonical_key) <= 512),
  target_json   TEXT NOT NULL
                CHECK (json_valid(target_json)),
  updated_at    INTEGER NOT NULL
                CHECK (updated_at >= 0)
) STRICT;
