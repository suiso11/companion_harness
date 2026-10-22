-- System monitor query index (additive, branch feat/system-monitor review).
--
-- The monitor's latest-calls feed orders ALL runs by created_at DESC
-- (rowid DESC tie-break) and the 24h totals filter by created_at >= since.
-- Without an index both full-scan model_calls, which grows one row per
-- model step for every run. The composite is unnecessary here: created_at
-- is the only predicate/sort key and the rowid tie-break follows the
-- index's natural rowid ordering.
--
-- Invariants:
-- - Additive only: no table, column, row, or existing index is touched.
-- - IF NOT EXISTS keeps re-runs/migrated duplicates safe.

CREATE INDEX IF NOT EXISTS idx_model_calls_created ON model_calls(created_at);
