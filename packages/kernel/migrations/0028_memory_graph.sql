-- Conversation-memory graph projection (additive, branch feat/memory-graph).
--
-- Remind owns graph traversal (graph.local / graph.page / graph.version);
-- Companion only stores the opaque `mN` handles it shows to the model/UI.
-- One durable graph snapshot per (session, memory scope): its `search_id`
-- is a NORMAL `memory_searches` row with `query = 'graph'`, so the existing
-- detail/mutation item routes resolve graph handles with no new route or
-- snapshot semantics. Nodes are ordinary immutable `memory_search_items`
-- rows (`revision` NULL is allowed, `snippet` = current label).
--
-- Handle minting (service + repository):
-- - Reuse the existing handle when the same (record_id, status) pair is
--   already present in this graph search; otherwise INSERT exactly one new
--   row with the next handle m{max+1}. Rows are never updated or deleted.
-- - Re-opening an unchanged graph inserts ZERO rows; a status change for a
--   record gets a NEW handle (the old row stays as immutable history).
-- - Raw record ids never leave the server: graph responses carry handles
--   only, and edges are rewritten to handles before serialization.
--
-- Invariants:
-- - Additive only: no existing table/row is touched.
-- - STRICT, no WITHOUT ROWID, no foreign keys (same ownership boundary as
--   0008/0009 memory tables; remind stays a separate database).
-- - The composite index serves the (search_id, record_id, status) handle
--   reuse lookup without scanning the whole search snapshot.

CREATE TABLE memory_graph_searches (
  session_id TEXT NOT NULL,
  scope      TEXT NOT NULL,
  search_id  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, scope)
) STRICT;

CREATE UNIQUE INDEX idx_memory_graph_searches_search
  ON memory_graph_searches(search_id);

CREATE INDEX idx_memory_search_items_graph
  ON memory_search_items(search_id, record_id, status);
