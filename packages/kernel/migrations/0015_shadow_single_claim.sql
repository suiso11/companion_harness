-- AV02 shadow-deliberation GLOBAL one-claimed-job-at-once backstop
-- (migration 0015, renumbered from 0013 at merge time; parent kernel contract).
--
-- Committed migration 0015: adds ONE partial unique index over the 0014
-- shadow queue and touches NOTHING else (0001-0014 preserved, including
-- the 0011 autonomy slice and the 0014 shadow tables/constraints).
--
-- What this enforces: at most ONE `shadow_jobs` row may carry
-- `status = 'claimed'` at any time, across ALL sessions/scopes/jobs.
-- The kernel claim transaction already checks this atomically under
-- `BEGIN IMMEDIATE`; this index backstops the bound across connections
-- (a second concurrent claim fails on the unique violation instead of
-- landing a second live lease). A busy newcomer is never dropped/failed
-- and never steals the old lease: it stays `pending` until settlement or
-- reconcile re-drives it. Lease expiry never auto-reruns work; startup
-- already holds old claims (leases die with the restart fence).
--
-- Single-app-DB ownership: one app owns the file; this index makes no
-- multiprocess hardware claim beyond SQLite's own locking.
--
-- Invariants (must not be weakened):
-- - No new tables, no new columns, no grant/capability/calendar surface.
-- - `IF NOT EXISTS` so a partially-applied 0013 resumes honestly.

CREATE UNIQUE INDEX IF NOT EXISTS ux_shadow_jobs_single_claimed
  ON shadow_jobs(status) WHERE status = 'claimed';
