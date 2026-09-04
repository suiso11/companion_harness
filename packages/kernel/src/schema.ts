// M0 kernel storage: Drizzle schema ownership.
//
// This module is the single owner of the M0 table shapes in TypeScript.
// It mirrors packages/kernel/migrations/0001_m0_foundation.sql, which is
// the authoritative DDL applied at runtime. The two must be kept in sync
// manually: runtime migration applies the committed SQL file only and
// never uses `drizzle-kit push`.
//
// Conventions (from the implementation plan):
// - All PK ids are UUID v4 strings (generated with crypto.randomUUID()).
// - All timestamps are Unix milliseconds (INTEGER).
// - JSON columns are TEXT; DB-level shape is json_valid CHECKs only.
// - `run_events.type` intentionally has NO closed-set DB CHECK.

import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    createdAt: integer("created_at").notNull(),
    lastActiveAt: integer("last_active_at").notNull(),
    nextTurnPosition: integer("next_turn_position").notNull(),
  },
  (t) => [
    check("sessions_next_turn_position_check", sql`${t.nextTurnPosition} >= 1`),
  ],
);

export const turns = sqliteTable(
  "turns",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id),
    seq: integer("seq").notNull(),
    inputJson: text("input_json").notNull(),
    frozenContext: text("frozen_context").notNull(),
    createdAt: integer("created_at").notNull(),
    nextRunAttempt: integer("next_run_attempt").notNull(),
  },
  (t) => [
    unique("turns_session_seq_unique").on(t.sessionId, t.seq),
    unique("turns_session_id_unique").on(t.sessionId, t.id),
    check("turns_seq_check", sql`${t.seq} >= 1`),
    check("turns_next_run_attempt_check", sql`${t.nextRunAttempt} >= 1`),
    check("turns_input_json_check", sql`json_valid(${t.inputJson})`),
    check("turns_frozen_context_check", sql`json_valid(${t.frozenContext})`),
  ],
);

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    turnId: text("turn_id")
      .notNull()
      .references(() => turns.id),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id),
    attempt: integer("attempt").notNull(),
    status: text("status").notNull(),
    strategy: text("strategy").notNull(),
    resultJson: text("result_json"),
    errorCode: text("error_code"),
    eventSeq: integer("event_seq").notNull(),
    selectOnSuccess: integer("select_on_success").notNull(),
    toolRequestsUsed: integer("tool_requests_used").notNull(),
    createdAt: integer("created_at").notNull(),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
    cancelRequestedAt: integer("cancel_requested_at"),
  },
  (t) => [
    unique("runs_turn_attempt_unique").on(t.turnId, t.attempt),
    unique("runs_turn_id_unique").on(t.turnId, t.id),
    unique("runs_session_id_unique").on(t.sessionId, t.id),
    foreignKey({
      name: "runs_session_turn_fk",
      columns: [t.sessionId, t.turnId],
      foreignColumns: [turns.sessionId, turns.id],
    }),
    check("runs_attempt_check", sql`${t.attempt} >= 1`),
    check(
      "runs_status_check",
      sql`${t.status} IN ('queued','running','cancel_requested','completed','failed','cancelled','abandoned')`,
    ),
    check("runs_event_seq_check", sql`${t.eventSeq} >= 0`),
    check("runs_select_on_success_check", sql`${t.selectOnSuccess} IN (0,1)`),
    check("runs_tool_requests_used_check", sql`${t.toolRequestsUsed} >= 0`),
    check(
      "runs_result_json_check",
      sql`${t.resultJson} IS NULL OR json_valid(${t.resultJson})`,
    ),
    check(
      "runs_lifecycle_check",
      sql`(${t.status} = 'queued' AND ${t.startedAt} IS NULL AND ${t.finishedAt} IS NULL AND ${t.resultJson} IS NULL AND ${t.errorCode} IS NULL AND ${t.cancelRequestedAt} IS NULL) OR
        (${t.status} = 'running' AND ${t.startedAt} IS NOT NULL AND ${t.finishedAt} IS NULL AND ${t.resultJson} IS NULL AND ${t.errorCode} IS NULL AND ${t.cancelRequestedAt} IS NULL) OR
        (${t.status} = 'cancel_requested' AND ${t.startedAt} IS NOT NULL AND ${t.cancelRequestedAt} IS NOT NULL AND ${t.finishedAt} IS NULL AND ${t.resultJson} IS NULL AND ${t.errorCode} IS NULL) OR
        (${t.status} = 'completed' AND ${t.startedAt} IS NOT NULL AND ${t.resultJson} IS NOT NULL AND ${t.finishedAt} IS NOT NULL AND ${t.errorCode} IS NULL AND ${t.cancelRequestedAt} IS NULL) OR
        (${t.status} = 'failed' AND ${t.startedAt} IS NOT NULL AND ${t.errorCode} IS NOT NULL AND ${t.finishedAt} IS NOT NULL AND ${t.resultJson} IS NULL AND ${t.cancelRequestedAt} IS NULL) OR
        (${t.status} = 'cancelled' AND ${t.cancelRequestedAt} IS NOT NULL AND ${t.finishedAt} IS NOT NULL AND ${t.resultJson} IS NULL AND ${t.errorCode} IS NULL) OR
        (${t.status} = 'abandoned' AND ${t.startedAt} IS NOT NULL AND ${t.finishedAt} IS NOT NULL AND ${t.resultJson} IS NULL AND ${t.errorCode} IS NULL AND ${t.cancelRequestedAt} IS NULL)`,
    ),
  ],
);

// One active (queued | running | cancel_requested) Run per session.
//
// NOTE: the partial unique index idx_runs_one_active_per_session is owned
// by the committed migration SQL only (see 0001_m0_foundation.sql). It is
// intentionally not declared as a Drizzle index object, so the SQL file
// remains the single source of truth for its WHERE predicate.

export const turnSelections = sqliteTable(
  "turn_selections",
  {
    turnId: text("turn_id").notNull(),
    runId: text("run_id").notNull(),
    selectedAt: integer("selected_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.turnId] }),
    unique("turn_selections_turn_run_unique").on(t.turnId, t.runId),
    foreignKey({
      name: "turn_selections_turn_run_fk",
      columns: [t.turnId, t.runId],
      foreignColumns: [runs.turnId, runs.id],
    }),
  ],
);

export const runEvents = sqliteTable(
  "run_events",
  {
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    seq: integer("seq").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    type: text("type").notNull(),
    payload: text("payload").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.seq] }),
    check("run_events_seq_check", sql`${t.seq} >= 1`),
    check("run_events_schema_version_check", sql`${t.schemaVersion} >= 1`),
    check("run_events_payload_check", sql`json_valid(${t.payload})`),
  ],
);

export const toolCalls = sqliteTable(
  "tool_calls",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    callIndex: integer("call_index").notNull(),
    lifecycleStatus: text("lifecycle_status").notNull(),
    tool: text("tool").notNull(),
    argsHash: text("args_hash").notNull(),
    reportedOutcome: text("reported_outcome"),
    actualOutcome: text("actual_outcome"),
    resultDisposition: text("result_disposition").notNull().default("none"),
    // Self-FK target (dedup canon: actual_outcome='deduplicated' +
    // reused_from_call_id). Declared table-level below to avoid a
    // circular type reference.
    reusedFromCallId: text("reused_from_call_id"),
    errorCode: text("error_code"),
    resultDigest: text("result_digest"),
    requestedAt: integer("requested_at").notNull(),
    startedAt: integer("started_at"),
    reportedAt: integer("reported_at"),
    actualFinishedAt: integer("actual_finished_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    unique("tool_calls_run_call_index_unique").on(t.runId, t.callIndex),
    foreignKey({
      name: "tool_calls_reused_from_fk",
      columns: [t.reusedFromCallId],
      foreignColumns: [t.id],
    }),
    check("tool_calls_call_index_check", sql`${t.callIndex} >= 1`),
    check(
      "tool_calls_lifecycle_status_check",
      sql`${t.lifecycleStatus} IN ('requested','running','finished')`,
    ),
    check(
      "tool_calls_reported_outcome_check",
      sql`${t.reportedOutcome} IS NULL OR ${t.reportedOutcome} IN ('succeeded','failed','cancelled')`,
    ),
    check(
      "tool_calls_actual_outcome_check",
      sql`${t.actualOutcome} IS NULL OR ${t.actualOutcome} IN ('succeeded','failed','denied','invalid','deduplicated','timed_out','cancelled','unknown')`,
    ),
    check(
      "tool_calls_result_disposition_check",
      sql`${t.resultDisposition} IN ('accepted','discarded','none')`,
    ),
  ],
);

export const apiIdempotency = sqliteTable(
  "api_idempotency",
  {
    scope: text("scope").notNull(),
    key: text("key").notNull(),
    requestHash: text("request_hash").notNull(),
    responseStatus: integer("response_status").notNull(),
    responseBody: text("response_body").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.scope, t.key] }),
    check(
      "api_idempotency_response_status_check",
      sql`${t.responseStatus} BETWEEN 200 AND 299`,
    ),
    check(
      "api_idempotency_response_body_check",
      sql`json_valid(${t.responseBody})`,
    ),
  ],
);

export const kernelSchema = {
  sessions,
  turns,
  runs,
  turnSelections,
  runEvents,
  toolCalls,
  apiIdempotency,
};
