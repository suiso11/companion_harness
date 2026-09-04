-- M1 Markdown link graph (§14.5 related, §14.6 links, §14.10).
--
-- Committed migration 0003: adds the immutable `snapshot_links` table that
-- persists the per-snapshot Markdown link graph observed at materialization
-- time. One row per ordered link of a newly materialized snapshot, keyed by
-- (source_snapshot_id, ordinal). Rows are write-once: no UPDATE/DELETE API
-- exists; a reused snapshot never rewrites its graph and a refresh writes a
-- wholly new graph for the new snapshot.
--
-- Invariants (must not be weakened):
-- - Table is STRICT with default rowid behavior.
-- - `candidates_json` is a JSON array of path-free CanonicalKeySchema values
--   (same connector instance as the source). No raw URL / wiki target /
--   alias / fragment / absolute path is stored anywhere in this table.
-- - `kind IN ('standard','wiki')`, `status IN
--   ('resolved','ambiguous','unresolved')`, `ordinal >= 1`.
-- - State-dependent CHECK (never guess ambiguous targets):
--   resolved   => exactly one candidate AND target_resource_id NOT NULL;
--   ambiguous  => more than one candidate AND target_resource_id IS NULL;
--   unresolved => zero candidates AND target_resource_id IS NULL.
-- - `source_snapshot_id REFERENCES resource_snapshots(id)`,
--   `target_resource_id REFERENCES resources(id)` (nullable, only resolved).
-- - Candidate resources are ensured under the same connector instance with
--   title NULL when unseen; graph + candidates are inserted in the same
--   presentation transaction as the new snapshot so cancel rollback discards
--   them together.

CREATE TABLE snapshot_links (
  source_snapshot_id TEXT NOT NULL REFERENCES resource_snapshots(id),
  ordinal            INTEGER NOT NULL
                     CHECK (ordinal >= 1),
  kind               TEXT NOT NULL
                     CHECK (kind IN ('standard','wiki')),
  status             TEXT NOT NULL
                     CHECK (status IN ('resolved','ambiguous','unresolved')),
  target_resource_id TEXT REFERENCES resources(id),
  candidates_json    TEXT NOT NULL,
  PRIMARY KEY (source_snapshot_id, ordinal),
  CHECK (json_valid(candidates_json)),
  CHECK (
    (status = 'resolved' AND target_resource_id IS NOT NULL AND json_type(candidates_json) = 'array' AND json_array_length(candidates_json) = 1) OR
    (status = 'ambiguous' AND target_resource_id IS NULL AND json_type(candidates_json) = 'array' AND json_array_length(candidates_json) > 1) OR
    (status = 'unresolved' AND target_resource_id IS NULL AND json_type(candidates_json) = 'array' AND json_array_length(candidates_json) = 0)
  )
) STRICT;

-- Incoming-related lookup: resolved links pointing at a resource.
CREATE INDEX idx_snapshot_links_target ON snapshot_links(target_resource_id);
