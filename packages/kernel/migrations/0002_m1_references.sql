-- M1 reference storage (§14.3 of docs/implementation_plan.md).
--
-- Committed migration 0002: adds the exact section 14.3 tables
-- connector_instances, resources, resource_snapshots, session_references,
-- reference_sets, reference_set_items, session_reference_context and
-- evidence_grants, plus sessions.next_reference_ordinal.
--
-- Invariants (must not be weakened):
-- - All new tables STRICT with default rowid behavior.
-- - JSON columns use CHECK (json_valid(col)) (all NOT NULL here).
-- - UUID v4 TEXT primary keys; rN ordinals stay sequential integers.
-- - No per-content unique constraint on snapshots: duplicate content
--   across snapshots is legitimate (a refresh makes a new snapshot even
--   when the normalized content is identical).
-- - rN allocation via sessions.next_reference_ordinal (CHECK >= 1, CAS
--   increment; MAX(ordinal)+1 is prohibited). Revision allocation via
--   resources.next_revision (CHECK >= 1, CAS increment).
-- - Exact compound FKs / UNIQUE parents from the plan (session ownership).
-- - evidence_grants is prepared in M1 as planned (consumed in M2).
-- - No link graph table here; a connector migration may add one if needed.

-- Connector instances (M1: markdown only)
CREATE TABLE connector_instances (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  config_json   TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  UNIQUE (kind, display_name),
  CHECK (json_valid(config_json))
) STRICT;

-- Canonical resources
CREATE TABLE resources (
  id                    TEXT PRIMARY KEY,
  connector_instance_id TEXT NOT NULL REFERENCES connector_instances(id),
  canonical_key         TEXT NOT NULL,
  title                 TEXT,
  next_revision         INTEGER NOT NULL
                        CHECK (next_revision >= 1),
  created_at            INTEGER NOT NULL,
  UNIQUE (connector_instance_id, canonical_key),
  UNIQUE (connector_instance_id, id)
) STRICT;

-- Immutable snapshots (full normalized evidence JSON in body_json)
CREATE TABLE resource_snapshots (
  id            TEXT PRIMARY KEY,
  resource_id   TEXT NOT NULL REFERENCES resources(id),
  revision      INTEGER NOT NULL
                CHECK (revision >= 1),
  source_revision TEXT,
  content_hash  TEXT NOT NULL,
  body_json     TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL
                CHECK (size_bytes >= 0),
  observed_at   INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  UNIQUE (resource_id, revision),
  UNIQUE (resource_id, id),
  CHECK (json_valid(body_json))
) STRICT;

-- Session references (rN)
CREATE TABLE session_references (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions(id),
  ordinal      INTEGER NOT NULL
               CHECK (ordinal >= 1),
  resource_id  TEXT NOT NULL,
  snapshot_id  TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  FOREIGN KEY (resource_id, snapshot_id) REFERENCES resource_snapshots(resource_id, id),
  UNIQUE (session_id, ordinal),
  UNIQUE (session_id, snapshot_id),
  UNIQUE (session_id, id),
  UNIQUE (session_id, id, resource_id, snapshot_id)
) STRICT;

-- Reference sets
CREATE TABLE reference_sets (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  created_at  INTEGER NOT NULL,
  UNIQUE (session_id, id)
) STRICT;

CREATE TABLE reference_set_items (
  session_id   TEXT NOT NULL REFERENCES sessions(id),
  set_id       TEXT NOT NULL,
  ordinal      INTEGER NOT NULL
               CHECK (ordinal >= 1),
  reference_id TEXT NOT NULL,
  PRIMARY KEY (set_id, ordinal),
  UNIQUE (set_id, reference_id),
  FOREIGN KEY (session_id, set_id) REFERENCES reference_sets(session_id, id),
  FOREIGN KEY (session_id, reference_id) REFERENCES session_references(session_id, id)
) STRICT;

-- Versioned per-session reference context (implicit UI selection)
CREATE TABLE session_reference_context (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id),
  version    INTEGER NOT NULL
             CHECK (version >= 1),
  items_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (json_valid(items_json))
) STRICT;

-- Evidence grants (prepared in M1, consumed in M2)
CREATE TABLE evidence_grants (
  session_id   TEXT NOT NULL REFERENCES sessions(id),
  run_id       TEXT NOT NULL,
  reference_id TEXT NOT NULL,
  exposure     TEXT NOT NULL
               CHECK (exposure IN ('snippet','full')),
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (run_id, reference_id),
  FOREIGN KEY (session_id, run_id) REFERENCES runs(session_id, id),
  FOREIGN KEY (session_id, reference_id) REFERENCES session_references(session_id, id)
) STRICT;

-- rN allocator on sessions (CAS increment; MAX(ordinal)+1 is prohibited)
ALTER TABLE sessions ADD COLUMN next_reference_ordinal INTEGER NOT NULL DEFAULT 1 CHECK (next_reference_ordinal >= 1);

-- Backfill versioned reference context for pre-M1 sessions (§14.3, §14.8).
-- Fresh databases hold no sessions yet, so the SELECT inserts zero rows.
-- Existing sessions each gain exactly one `version = 1, items = []` row.
-- New sessions gain the same row inside `createSession` (same transaction).
INSERT OR IGNORE INTO session_reference_context (session_id, version, items_json, updated_at)
  SELECT id, 1, '[]', created_at FROM sessions;
