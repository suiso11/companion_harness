-- M2 model-call audit (§15.10 of docs/implementation_plan.md).
--
-- Committed migration 0005: adds the metadata-only `model_calls` table that
-- audits one row per AgentStrategy model step (every `generateTurn` call,
-- repair included). Adapter / model identity lives here, never in events.
--
-- Invariants (must not be weakened):
-- - Table is STRICT with default rowid behavior.
-- - Metadata only: step ordinal, adapter/model identifiers, fixed outcome,
--   fixed M2 error code, timing, optional token-count usage summary,
--   created_at. Prompt text, raw model output, reasoning, and secrets are
--   NEVER columns here (nothing to redact: they are never stored).
-- - `step` is 1-based and bounded by the agreed model-step budget
--   (MAX_MODEL_STEPS_PER_RUN = 8, repair included, never a ninth call).
-- - `outcome IN ('completed','failed','timeout','cancelled')` (closed).
-- - `error_code` is NULL or one of the exact closed M2 vocabulary
--   (`model_unavailable` / `model_step_timeout` / `answer_invalid` /
--   `citation_invalid`). No raw errors, prompts, or reasoning are valid.
-- - `usage_json` (nullable) carries token counts only when the provider
--   reports them (`{"inputTokens": N, "outputTokens": M}`); otherwise NULL.
-- - One row per (run_id, step): UNIQUE (run_id, step).
-- - `run_events` is untouched: no rebuild, no new columns. Typed
--   `model.step.*` events are validated by the contracts M2 registry only.

CREATE TABLE model_calls (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES runs(id),
  step        INTEGER NOT NULL
              CHECK (step >= 1 AND step <= 8),
  adapter     TEXT NOT NULL,
  model       TEXT NOT NULL,
  outcome     TEXT NOT NULL
              CHECK (outcome IN ('completed','failed','timeout','cancelled')),
  error_code  TEXT
              CHECK (error_code IS NULL OR error_code IN ('model_unavailable','model_step_timeout','answer_invalid','citation_invalid')),
  duration_ms INTEGER NOT NULL
              CHECK (duration_ms >= 0),
  usage_json  TEXT,
  created_at  INTEGER NOT NULL,
  UNIQUE (run_id, step),
  CHECK (usage_json IS NULL OR json_valid(usage_json))
) STRICT;

-- Per-run step lookup for the M2 audit trail.
CREATE INDEX idx_model_calls_run ON model_calls(run_id);
