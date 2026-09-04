-- M0 kernel storage foundation (§10 of docs/implementation_plan.md).
--
-- GENERATED-STYLE committed migration: this file is the authoritative DDL
-- artifact. packages/kernel/src/schema.ts (Drizzle) mirrors it for typed
-- access, but the runtime applies THIS file only. Runtime use of
-- `drizzle-kit push` is prohibited; schema changes land as new versioned
-- SQL files applied in order by src/migrate.ts via PRAGMA user_version.
--
-- Invariants (must not be weakened):
-- - Exactly seven tables, all STRICT, none WITHOUT ROWID.
-- - No `messages` table.
-- - `run_events.type` has NO closed-set DB CHECK (enforced by the
--   contracts Zod registry per schemaVersion instead).
-- - No UNIQUE(resource_id, content_hash) concept (M1 idea, absent here).
-- - Active-run partial unique index below (queued/running/cancel_requested).
-- - Compound FKs: runs(session_id, turn_id) -> turns(session_id, id) and
--   turn_selections(turn_id, run_id) -> runs(turn_id, id).
-- - JSON columns: NOT NULL columns use CHECK (json_valid(col));
--   the single nullable JSON column (runs.result_json) uses
--   CHECK (col IS NULL OR json_valid(col)).

-- セッション
CREATE TABLE sessions (
  id                 TEXT PRIMARY KEY,
  created_at         INTEGER NOT NULL,
  last_active_at     INTEGER NOT NULL,
  next_turn_position INTEGER NOT NULL
                     CHECK (next_turn_position >= 1)
) STRICT;

-- 不変の Turn: バージョン化 TurnInput union + 凍結済み UI コンテキスト
CREATE TABLE turns (
  id               TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL REFERENCES sessions(id),
  seq              INTEGER NOT NULL
                   CHECK (seq >= 1),
  input_json       TEXT NOT NULL,
  frozen_context   TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  next_run_attempt INTEGER NOT NULL
                   CHECK (next_run_attempt >= 1),
  UNIQUE (session_id, seq),
  UNIQUE (session_id, id),
  CHECK (json_valid(input_json)),
  CHECK (json_valid(frozen_context))
) STRICT;

-- Run: 1 回の生成試行（バージョン化された結果を持つ）
CREATE TABLE runs (
  id                 TEXT PRIMARY KEY,
  turn_id            TEXT NOT NULL REFERENCES turns(id),
  session_id         TEXT NOT NULL REFERENCES sessions(id),
  attempt            INTEGER NOT NULL
                     CHECK (attempt >= 1),
  status             TEXT NOT NULL
                     CHECK (status IN ('queued','running','cancel_requested','completed','failed','cancelled','abandoned')),
  strategy           TEXT NOT NULL,
  result_json        TEXT,
  error_code         TEXT,
  event_seq          INTEGER NOT NULL
                     CHECK (event_seq >= 0),
  select_on_success  INTEGER NOT NULL
                     CHECK (select_on_success IN (0,1)),
  tool_requests_used INTEGER NOT NULL
                     CHECK (tool_requests_used >= 0),
  created_at         INTEGER NOT NULL,
  started_at         INTEGER,
  finished_at        INTEGER,
  cancel_requested_at INTEGER,
  UNIQUE (turn_id, attempt),
  UNIQUE (turn_id, id),
  UNIQUE (session_id, id),
  FOREIGN KEY (session_id, turn_id) REFERENCES turns(session_id, id),
  CHECK (result_json IS NULL OR json_valid(result_json)),
  CHECK (
    (status = 'queued' AND started_at IS NULL AND finished_at IS NULL AND result_json IS NULL AND error_code IS NULL AND cancel_requested_at IS NULL) OR
    (status = 'running' AND started_at IS NOT NULL AND finished_at IS NULL AND result_json IS NULL AND error_code IS NULL AND cancel_requested_at IS NULL) OR
    (status = 'cancel_requested' AND started_at IS NOT NULL AND cancel_requested_at IS NOT NULL AND finished_at IS NULL AND result_json IS NULL AND error_code IS NULL) OR
    (status = 'completed' AND started_at IS NOT NULL AND result_json IS NOT NULL AND finished_at IS NOT NULL AND error_code IS NULL AND cancel_requested_at IS NULL) OR
    (status = 'failed' AND started_at IS NOT NULL AND error_code IS NOT NULL AND finished_at IS NOT NULL AND result_json IS NULL AND cancel_requested_at IS NULL) OR
    (status = 'cancelled' AND cancel_requested_at IS NOT NULL AND finished_at IS NOT NULL AND result_json IS NULL AND error_code IS NULL) OR
    (status = 'abandoned' AND started_at IS NOT NULL AND finished_at IS NOT NULL AND result_json IS NULL AND error_code IS NULL AND cancel_requested_at IS NULL)
  )
) STRICT;

-- completed Run の選択（1 Turn につき 0..1）
CREATE TABLE turn_selections (
  turn_id     TEXT NOT NULL,
  run_id      TEXT NOT NULL,
  selected_at INTEGER NOT NULL,
  PRIMARY KEY (turn_id),
  FOREIGN KEY (turn_id, run_id) REFERENCES runs(turn_id, id),
  UNIQUE (turn_id, run_id)
) STRICT;

-- Run イベント（状態変更と同一トランザクションで追記）
CREATE TABLE run_events (
  run_id         TEXT NOT NULL REFERENCES runs(id),
  seq            INTEGER NOT NULL
                 CHECK (seq >= 1),
  schema_version INTEGER NOT NULL
                 CHECK (schema_version >= 1),
  type           TEXT NOT NULL,
  payload        TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (run_id, seq),
  CHECK (json_valid(payload))
) STRICT;

-- ツール呼び出し監査
CREATE TABLE tool_calls (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL REFERENCES runs(id),
  call_index          INTEGER NOT NULL
                      CHECK (call_index >= 1),
  lifecycle_status    TEXT NOT NULL
                      CHECK (lifecycle_status IN ('requested','running','finished')),
  tool                TEXT NOT NULL,
  args_hash           TEXT NOT NULL,
  reported_outcome    TEXT
                      CHECK (reported_outcome IS NULL OR reported_outcome IN ('succeeded','failed','cancelled')),
  actual_outcome      TEXT
                      CHECK (actual_outcome IS NULL OR actual_outcome IN ('succeeded','failed','denied','invalid','deduplicated','timed_out','cancelled','unknown')),
  result_disposition  TEXT NOT NULL DEFAULT 'none'
                      CHECK (result_disposition IN ('accepted','discarded','none')),
  reused_from_call_id TEXT REFERENCES tool_calls(id),
  error_code          TEXT,
  result_digest       TEXT,
  requested_at        INTEGER NOT NULL,
  started_at          INTEGER,
  reported_at         INTEGER,
  actual_finished_at  INTEGER,
  created_at          INTEGER NOT NULL,
  UNIQUE (run_id, call_index)
) STRICT;

-- 冪等性ストア
CREATE TABLE api_idempotency (
  scope           TEXT NOT NULL,
  key             TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  response_status INTEGER NOT NULL
                  CHECK (response_status BETWEEN 200 AND 299),
  response_body   TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (scope, key),
  CHECK (json_valid(response_body))
) STRICT;

-- active Run の部分一意インデックス:
-- セッションごとに active (queued | running | cancel_requested) は最大 1
CREATE UNIQUE INDEX idx_runs_one_active_per_session
  ON runs(session_id)
  WHERE status IN ('queued', 'running', 'cancel_requested');
