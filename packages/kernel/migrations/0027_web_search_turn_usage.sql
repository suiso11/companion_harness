-- Durable per-turn web search budget (branch feat/web-search-tool,
-- docs/plan/web_search_design.md section 6 / review P1 on web_tools.ts).
--
-- The per-turn web search allowance must be counted against the TURN, not
-- the process-local run: retrying a turn creates a new run id and a server
-- restart clears any in-memory map, both of which would reset the allowance
-- and permit more than `per_turn_budget` outbound searches for the same
-- turn. This additive table persists one charged counter per turn id.
--
-- Invariants:
-- - Additive only: no existing table is touched.
-- - STRICT table; PRIMARY KEY = turn_id (one counter row per turn).
-- - `used` is a monotonic reservation counter maintained atomically by the
--   write site (INSERT ... ON CONFLICT ... DO UPDATE ... WHERE used < cap);
--   no UPDATE path exists outside that guarded upsert.
-- - FK to turns(id) keeps rows verifiable with `foreign_key_check`.

CREATE TABLE web_search_turn_usage (
  turn_id TEXT PRIMARY KEY REFERENCES turns(id),
  used    INTEGER NOT NULL CHECK (used >= 0)
) STRICT;
