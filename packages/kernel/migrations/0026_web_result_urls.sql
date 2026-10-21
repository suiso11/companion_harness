-- Additive verified-URL metadata store for web result snapshots (branch
-- feat/web-search-tool, docs/plan/web_search_design.md section 5).
--
-- Web search hits become ReferenceManager resources under connector instance
-- kind 'web' (resource identity = versioned SHA-256 of the normalized URL,
-- canonical key 'web-v1-<hex>' per contracts `WebCanonicalKeySchema`). The
-- validated URL itself must survive for the citation drawer (the UI opens
-- the exact URL even when the answer keeps only the rN citation).
--
-- Design section 5 offers two storage options; this migration follows the
-- SEPARATE verified immutable metadata store option: snapshot id -> url.
-- Rationale: `resource_snapshots.body_json` is a strict `{version:1, text}`
-- shape (already the immutability boundary, parsed verbatim at every read),
-- so widening it would touch every parse path; the URL is invariant per
-- resource (it IS the identity derivation input) and fits a one-row-per-
-- snapshot side table with no schema version bump of the body contract.
--
-- Why NOT a `connector_instances.kind` CHECK rebuild:
-- connector_instances (migration 0002) carries `kind TEXT NOT NULL` WITHOUT
-- any CHECK constraint (the UNIQUE(kind, display_name) stays), so kind='web'
-- rows are already insertable at schema version 25. A rebuild of
-- connector_instances would cascade through every referencing child
-- (resources -> resource_snapshots -> session_references/links, actions,
-- calendar targets) while foreign_keys stays enforced in migration runs;
-- the rebuild conventions (0022/0025) apply when a CHECK exists and only
-- its closed set needs widening. Nothing must be widened here.
--
-- Invariants:
-- - Additive only: no existing table is touched; all existing rows are
--   preserved verbatim (provable: this file executes no DROP/UPDATE).
-- - STRICT table, one immutable row per snapshot (PRIMARY KEY = snapshot_id,
--   INSERT ... ON CONFLICT DO NOTHING at the write site; no UPDATE path).
-- - The URL is length-bounded to the design bound (<=2048 code units) at the
--   SQL layer; scheme allowlist + fragmentation/port stays a kernel concern
--   (kernel validates before INSERT, mirroring `WebResultUrlSchema`).
-- - FK to resource_snapshots(id) keeps the store verifiable with
--   `foreign_key_check`; rows can only exist for real snapshots.

CREATE TABLE web_result_urls (
  snapshot_id TEXT PRIMARY KEY REFERENCES resource_snapshots(id),
  url         TEXT NOT NULL CHECK (length(url) >= 1 AND length(url) <= 2048)
) STRICT;
