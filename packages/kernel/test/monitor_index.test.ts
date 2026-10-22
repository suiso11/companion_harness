// System-monitor model_calls index (migration 0029).
//
// The monitor feed and 24h totals both scan model_calls by created_at. This
// test migrates a fresh DB to the bundled schema, seeds rows through the
// real repository API, and proves with EXPLAIN QUERY PLAN that the exact
// repository queries use idx_model_calls_created instead of a full scan.

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BUNDLED_SCHEMA_VERSION,
  createKernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
} from "../src/index.js";

const RECENT_MODEL_CALLS_SQL = `SELECT run_id, step, model, outcome, error_code, duration_ms, usage_json, created_at
   FROM model_calls
  ORDER BY created_at DESC, rowid DESC
  LIMIT ?`;

const MODEL_CALL_TOTALS_SQL = `SELECT COUNT(*) AS calls,
          COALESCE(SUM(COALESCE(json_extract(usage_json, '$.inputTokens'), 0)), 0) AS input_tokens,
          COALESCE(SUM(COALESCE(json_extract(usage_json, '$.outputTokens'), 0)), 0) AS output_tokens,
          COALESCE(SUM(CASE WHEN outcome IN ('failed', 'timeout') THEN 1 ELSE 0 END), 0) AS failures
     FROM model_calls
    WHERE created_at >= ?`;

function queryPlan(
  db: ReturnType<typeof openKernelDatabase>["raw"],
  sql: string,
  params: unknown[],
): string {
  return (
    db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{
      detail: string;
    }>
  )
    .map((row) => row.detail)
    .join("\n");
}

describe("model_calls created_at index (0029)", () => {
  it("is used by listRecentModelCalls and getModelCallTotals", async () => {
    const handle = openKernelDatabase(":memory:");
    try {
      const migrated = await migrateKernelDatabase({ db: handle.raw });
      expect(migrated.toVersion).toBe(BUNDLED_SCHEMA_VERSION);
      expect(BUNDLED_SCHEMA_VERSION).toBeGreaterThanOrEqual(29);

      const indexes = handle.raw
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'model_calls'",
        )
        .all() as Array<{ name: string }>;
      expect(indexes.map((row) => row.name)).toContain(
        "idx_model_calls_created",
      );

      // Seed a real run so model_calls rows pass the FK constraint.
      const sessionId = randomUUID();
      const turnId = randomUUID();
      const runId = randomUUID();
      handle.raw
        .prepare(
          "INSERT INTO sessions (id, created_at, last_active_at, next_turn_position) VALUES (?, 1, 1, 1)",
        )
        .run(sessionId);
      handle.raw
        .prepare(
          "INSERT INTO turns (id, session_id, seq, input_json, frozen_context, created_at, next_run_attempt) VALUES (?, ?, 1, '{}', '{}', 1, 1)",
        )
        .run(turnId, sessionId);
      handle.raw
        .prepare(
          "INSERT INTO runs (id, turn_id, session_id, attempt, status, strategy, event_seq, select_on_success, tool_requests_used, created_at, started_at) VALUES (?, ?, ?, 1, 'running', 's', 0, 1, 0, 1, 1)",
        )
        .run(runId, turnId, sessionId);
      const repo = createKernelRepository(handle.raw);
      for (let step = 1; step <= 3; step += 1) {
        repo.recordModelCall(runId, {
          step,
          adapter: "test",
          model: "test-model",
          outcome: step === 2 ? "failed" : "completed",
          durationMs: step,
          usage: { inputTokens: 10, outputTokens: 5 },
          now: 1_000 + step,
        });
      }

      expect(repo.listRecentModelCalls(20)).toHaveLength(3);
      expect(repo.getModelCallTotals(1_000)).toMatchObject({
        calls: 3,
        inputTokens: 30,
        outputTokens: 15,
        failures: 1,
      });

      const recentPlan = queryPlan(handle.raw, RECENT_MODEL_CALLS_SQL, [20]);
      expect(recentPlan).toContain("USING INDEX idx_model_calls_created");

      const totalsPlan = queryPlan(handle.raw, MODEL_CALL_TOTALS_SQL, [1_000]);
      expect(totalsPlan).toContain("USING INDEX idx_model_calls_created");
    } finally {
      handle.raw.close();
    }
  });
});
