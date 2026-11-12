-- Read-only memory graph/browse snapshots may exist without an originating
-- Run. A fresh session has no completed Run to bind `runId` to, yet the user
-- must be able to browse the global memory graph/list; the snapshot stays
-- session-scoped (and read-only), so `run_id` becomes nullable.
--
-- Explicit searches and every management mutation still carry a Run: only
-- the graph projection (`query = 'graph'`) may be minted run-less. SQLite
-- cannot relax a NOT NULL column in place, hence the table rebuild; the
-- snapshot items and the (session, scope) graph mapping carry no foreign key
-- to this table, so rebuilding touches no other row.
CREATE TABLE memory_searches_new (
  search_id  TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  run_id     TEXT,
  scope      TEXT NOT NULL,
  query      TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

INSERT INTO memory_searches_new (search_id, session_id, run_id, scope, query, created_at)
  SELECT search_id, session_id, run_id, scope, query, created_at
  FROM memory_searches;

DROP TABLE memory_searches;

ALTER TABLE memory_searches_new RENAME TO memory_searches;

CREATE INDEX idx_memory_searches_session ON memory_searches(session_id, created_at);
