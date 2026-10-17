// M0+M1 kernel storage: Drizzle schema ownership.
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
    // M1 rN allocator (§14.3). DB default keeps pre-M1 rows valid;
    // allocation is a same-transaction CAS increment, never MAX()+1.
    nextReferenceOrdinal: integer("next_reference_ordinal")
      .notNull()
      .default(1),
  },
  (t) => [
    check("sessions_next_turn_position_check", sql`${t.nextTurnPosition} >= 1`),
    check(
      "sessions_next_reference_ordinal_check",
      sql`${t.nextReferenceOrdinal} >= 1`,
    ),
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

// M1 reference storage (§14.3). Mirrors
// packages/kernel/migrations/0002_m1_references.sql, which is authoritative.
// All M1 tables are STRICT in SQL; JSON columns carry json_valid CHECKs;
// there is intentionally NO UNIQUE (resource_id, content_hash).

export const connectorInstances = sqliteTable(
  "connector_instances",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    displayName: text("display_name").notNull(),
    configJson: text("config_json").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    unique("connector_instances_kind_display_name_unique").on(
      t.kind,
      t.displayName,
    ),
    check(
      "connector_instances_config_json_check",
      sql`json_valid(${t.configJson})`,
    ),
  ],
);

export const resources = sqliteTable(
  "resources",
  {
    id: text("id").primaryKey(),
    connectorInstanceId: text("connector_instance_id")
      .notNull()
      .references(() => connectorInstances.id),
    canonicalKey: text("canonical_key").notNull(),
    title: text("title"),
    nextRevision: integer("next_revision").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    unique("resources_connector_canonical_key_unique").on(
      t.connectorInstanceId,
      t.canonicalKey,
    ),
    unique("resources_connector_id_unique").on(t.connectorInstanceId, t.id),
    check("resources_next_revision_check", sql`${t.nextRevision} >= 1`),
  ],
);

export const resourceSnapshots = sqliteTable(
  "resource_snapshots",
  {
    id: text("id").primaryKey(),
    resourceId: text("resource_id")
      .notNull()
      .references(() => resources.id),
    revision: integer("revision").notNull(),
    sourceRevision: text("source_revision"),
    contentHash: text("content_hash").notNull(),
    bodyJson: text("body_json").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    observedAt: integer("observed_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    unique("resource_snapshots_resource_revision_unique").on(
      t.resourceId,
      t.revision,
    ),
    unique("resource_snapshots_resource_id_unique").on(t.resourceId, t.id),
    check("resource_snapshots_revision_check", sql`${t.revision} >= 1`),
    check("resource_snapshots_size_bytes_check", sql`${t.sizeBytes} >= 0`),
    check("resource_snapshots_body_json_check", sql`json_valid(${t.bodyJson})`),
  ],
);

export const sessionReferences = sqliteTable(
  "session_references",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id),
    ordinal: integer("ordinal").notNull(),
    resourceId: text("resource_id").notNull(),
    snapshotId: text("snapshot_id").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    foreignKey({
      name: "session_references_resource_snapshot_fk",
      columns: [t.resourceId, t.snapshotId],
      foreignColumns: [resourceSnapshots.resourceId, resourceSnapshots.id],
    }),
    unique("session_references_session_ordinal_unique").on(
      t.sessionId,
      t.ordinal,
    ),
    unique("session_references_session_snapshot_unique").on(
      t.sessionId,
      t.snapshotId,
    ),
    unique("session_references_session_id_unique").on(t.sessionId, t.id),
    unique("session_references_session_target_unique").on(
      t.sessionId,
      t.id,
      t.resourceId,
      t.snapshotId,
    ),
    check("session_references_ordinal_check", sql`${t.ordinal} >= 1`),
  ],
);

export const referenceSets = sqliteTable(
  "reference_sets",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [unique("reference_sets_session_id_unique").on(t.sessionId, t.id)],
);

export const referenceSetItems = sqliteTable(
  "reference_set_items",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id),
    setId: text("set_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    referenceId: text("reference_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.setId, t.ordinal] }),
    unique("reference_set_items_set_reference_unique").on(
      t.setId,
      t.referenceId,
    ),
    foreignKey({
      name: "reference_set_items_session_set_fk",
      columns: [t.sessionId, t.setId],
      foreignColumns: [referenceSets.sessionId, referenceSets.id],
    }),
    foreignKey({
      name: "reference_set_items_session_reference_fk",
      columns: [t.sessionId, t.referenceId],
      foreignColumns: [sessionReferences.sessionId, sessionReferences.id],
    }),
    check("reference_set_items_ordinal_check", sql`${t.ordinal} >= 1`),
  ],
);

export const sessionReferenceContext = sqliteTable(
  "session_reference_context",
  {
    sessionId: text("session_id")
      .primaryKey()
      .references(() => sessions.id),
    version: integer("version").notNull(),
    itemsJson: text("items_json").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    check("session_reference_context_version_check", sql`${t.version} >= 1`),
    check(
      "session_reference_context_items_json_check",
      sql`json_valid(${t.itemsJson})`,
    ),
  ],
);

// M1 Markdown link graph (§14.5 related, §14.6 links). Mirrors
// packages/kernel/migrations/0003_m1_snapshot_links.sql, which is
// authoritative. One immutable row per ordered link of a newly materialized
// snapshot, keyed by (source_snapshot_id, ordinal). No raw URL / wiki
// target / alias / fragment is stored: only kind / status / path-free
// canonical candidates / nullable target resource. State CHECK enforces:
// resolved => exactly one candidate + target; ambiguous => >1 candidates,
// no target (never guessed); unresolved => zero candidates, no target.
// NOTE: the incoming-lookup index idx_snapshot_links_target is owned by the
// committed migration SQL only (as with the M0 active-run partial index).

export const snapshotLinks = sqliteTable(
  "snapshot_links",
  {
    sourceSnapshotId: text("source_snapshot_id")
      .notNull()
      .references(() => resourceSnapshots.id),
    ordinal: integer("ordinal").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    targetResourceId: text("target_resource_id").references(() => resources.id),
    candidatesJson: text("candidates_json").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sourceSnapshotId, t.ordinal] }),
    check("snapshot_links_ordinal_check", sql`${t.ordinal} >= 1`),
    check("snapshot_links_kind_check", sql`${t.kind} IN ('standard','wiki')`),
    check(
      "snapshot_links_status_check",
      sql`${t.status} IN ('resolved','ambiguous','unresolved')`,
    ),
    check(
      "snapshot_links_candidates_json_check",
      sql`json_valid(${t.candidatesJson})`,
    ),
    check(
      "snapshot_links_state_check",
      sql`(${t.status} = 'resolved' AND ${t.targetResourceId} IS NOT NULL AND json_type(${t.candidatesJson}) = 'array' AND json_array_length(${t.candidatesJson}) = 1) OR
        (${t.status} = 'ambiguous' AND ${t.targetResourceId} IS NULL AND json_type(${t.candidatesJson}) = 'array' AND json_array_length(${t.candidatesJson}) > 1) OR
        (${t.status} = 'unresolved' AND ${t.targetResourceId} IS NULL AND json_type(${t.candidatesJson}) = 'array' AND json_array_length(${t.candidatesJson}) = 0)`,
    ),
  ],
);

export const evidenceGrants = sqliteTable(
  "evidence_grants",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id),
    runId: text("run_id").notNull(),
    referenceId: text("reference_id").notNull(),
    exposure: text("exposure").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.referenceId] }),
    foreignKey({
      name: "evidence_grants_session_run_fk",
      columns: [t.sessionId, t.runId],
      foreignColumns: [runs.sessionId, runs.id],
    }),
    foreignKey({
      name: "evidence_grants_session_reference_fk",
      columns: [t.sessionId, t.referenceId],
      foreignColumns: [sessionReferences.sessionId, sessionReferences.id],
    }),
    check(
      "evidence_grants_exposure_check",
      sql`${t.exposure} IN ('snippet','full')`,
    ),
  ],
);

// M2 model-call audit (metadata-only, §15.10). Mirrors
// packages/kernel/migrations/0005_m2_model_calls.sql, which is authoritative.
// One row per AgentStrategy `generateTurn` call (repair included): step
// ordinal, adapter/model identity, fixed outcome, fixed M2 error code,
// timing, optional token-count usage, created_at. Prompt text, raw model
// output, reasoning, and secrets are NEVER columns here. `run_events` is
// untouched (typed `model.step.*` events validate via contracts only).

export const modelCalls = sqliteTable(
  "model_calls",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    step: integer("step").notNull(),
    adapter: text("adapter").notNull(),
    model: text("model").notNull(),
    outcome: text("outcome").notNull(),
    errorCode: text("error_code"),
    durationMs: integer("duration_ms").notNull(),
    usageJson: text("usage_json"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    unique("model_calls_run_step_unique").on(t.runId, t.step),
    check("model_calls_step_check", sql`${t.step} >= 1 AND ${t.step} <= 8`),
    check(
      "model_calls_outcome_check",
      sql`${t.outcome} IN ('completed','failed','timeout','cancelled')`,
    ),
    check(
      "model_calls_error_code_check",
      sql`${t.errorCode} IS NULL OR ${t.errorCode} IN ('model_unavailable','model_step_timeout','answer_invalid','citation_invalid')`,
    ),
    check("model_calls_duration_ms_check", sql`${t.durationMs} >= 0`),
    check(
      "model_calls_usage_json_check",
      sql`${t.usageJson} IS NULL OR json_valid(${t.usageJson})`,
    ),
  ],
);

// NOTE: the per-run lookup index idx_model_calls_run is owned by the
// committed migration SQL only (as with the M0 active-run partial index
// and the M1 snapshot-links target index).

// Conversation-memory outbox (remind CLI integration). Mirrors
// packages/kernel/migrations/0008_memory_outbox.sql, which is authoritative.
// Companion-owned durable queue + immutable recall-exposure snapshots +
// per-run memory citation grants. Prompt text, raw model output, and
// secrets are NEVER columns here; `last_error` carries a fixed code only.

export const memoryOutbox = sqliteTable("memory_outbox", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  sessionId: text("session_id").notNull(),
  runId: text("run_id").notNull(),
  turnId: text("turn_id"),
  eventId: text("event_id"),
  scope: text("scope").notNull(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  requestJson: text("request_json").notNull(),
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  nextDueAt: integer("next_due_at").notNull().default(0),
  lastError: text("last_error"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const memoryExposures = sqliteTable(
  "memory_exposures",
  {
    recallId: text("recall_id").notNull(),
    recordId: text("record_id").notNull(),
    sessionId: text("session_id").notNull(),
    runId: text("run_id").notNull(),
    scope: text("scope").notNull(),
    citation: text("citation").notNull(),
    snippet: text("snippet").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.recallId, t.recordId] })],
);

export const memoryGrants = sqliteTable(
  "memory_grants",
  {
    runId: text("run_id").notNull(),
    citation: text("citation").notNull(),
    recordId: text("record_id").notNull(),
    recallId: text("recall_id").notNull(),
    sessionId: text("session_id").notNull(),
    scope: text("scope").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.citation] })],
);

// NOTE: the memory lookup indexes (idx_memory_outbox_due,
// idx_memory_outbox_run, idx_memory_exposures_run, idx_memory_grants_run,
// idx_memory_searches_session, idx_memory_search_items_record,
// idx_memory_operations_session, idx_memory_operations_job)
// are owned by the committed migration SQL only.

// Explicit management snapshots (migration 0009, authoritative SQL).
// One explicit `record.search` (active+retired, no heat/reactivation) plus
// its immutable per-handle snapshot rows, plus the durable 202-ack status
// for one staged correct/retire/reactivate mutation.

export const memorySearches = sqliteTable("memory_searches", {
  searchId: text("search_id").primaryKey(),
  sessionId: text("session_id").notNull(),
  runId: text("run_id").notNull(),
  scope: text("scope").notNull(),
  query: text("query").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const memorySearchItems = sqliteTable(
  "memory_search_items",
  {
    searchId: text("search_id").notNull(),
    handle: text("handle").notNull(),
    recordId: text("record_id").notNull(),
    revision: integer("revision"),
    status: text("status").notNull(),
    snippet: text("snippet").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.searchId, t.handle] })],
);

export const memoryOperations = sqliteTable("memory_operations", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  sessionId: text("session_id").notNull(),
  runId: text("run_id").notNull(),
  searchId: text("search_id"),
  handle: text("handle"),
  recordId: text("record_id").notNull(),
  revision: integer("revision"),
  jobId: text("job_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  requestHash: text("request_hash").notNull(),
  status: text("status").notNull().default("pending"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// M5 action storage + M6 opt-in calendar.create extension (§18 + agreed
// M6 follow-up). Mirrors packages/kernel/migrations/0010_m6_calendar_create.sql,
// which is authoritative (0007 rebuilt leaf-first/root-first with the
// per-tool target NULL-ability CHECK). Four STRICT tables with the exact
// §18.3 compound FKs, the 4-column target FK (NULL create columns simply do
// not constrain), decision-turn uniqueness, status/marker/receipt CHECKs,
// and grant one-shot semantics. The pending-per-session partial unique index
// idx_proposals_one_pending_per_session is owned by the committed SQL file
// only (as with the M0 active-run partial index). Proposal content
// (input/target/expectedRevision/preview/hash) is immutable; only
// status / resolved_at / decision_turn_id may ever be written again.
// `calendar.reschedule` rows keep all four target columns NON-NULL;
// `calendar.create` rows carry all four NULL (no source event, no etag,
// no preflight snapshot — never a fake placeholder).

export const actionProposals = sqliteTable(
  "action_proposals",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id),
    sourceTurnId: text("source_turn_id").notNull(),
    sourceRunId: text("source_run_id").notNull(),
    decisionTurnId: text("decision_turn_id"),
    tool: text("tool").notNull(),
    connectorInstanceId: text("connector_instance_id")
      .notNull()
      .references(() => connectorInstances.id),
    inputJson: text("input_json").notNull(),
    targetRefId: text("target_ref_id"),
    targetResourceId: text("target_resource_id"),
    basedOnSnapshotId: text("based_on_snapshot_id"),
    expectedRevision: text("expected_revision"),
    previewJson: text("preview_json").notNull(),
    hash: text("hash").notNull(),
    status: text("status").notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    resolvedAt: integer("resolved_at"),
  },
  (t) => [
    unique("action_proposals_source_run_id_unique").on(t.sourceRunId, t.id),
    unique("action_proposals_session_id_unique").on(t.sessionId, t.id),
    unique("action_proposals_decision_turn_unique").on(t.decisionTurnId),
    foreignKey({
      name: "action_proposals_session_source_turn_fk",
      columns: [t.sessionId, t.sourceTurnId],
      foreignColumns: [turns.sessionId, turns.id],
    }),
    foreignKey({
      name: "action_proposals_session_source_run_fk",
      columns: [t.sessionId, t.sourceRunId],
      foreignColumns: [runs.sessionId, runs.id],
    }),
    foreignKey({
      name: "action_proposals_turn_run_fk",
      columns: [t.sourceTurnId, t.sourceRunId],
      foreignColumns: [runs.turnId, runs.id],
    }),
    foreignKey({
      name: "action_proposals_decision_turn_fk",
      columns: [t.sessionId, t.decisionTurnId],
      foreignColumns: [turns.sessionId, turns.id],
    }),
    foreignKey({
      name: "action_proposals_target_fk",
      columns: [
        t.sessionId,
        t.targetRefId,
        t.targetResourceId,
        t.basedOnSnapshotId,
      ],
      foreignColumns: [
        sessionReferences.sessionId,
        sessionReferences.id,
        sessionReferences.resourceId,
        sessionReferences.snapshotId,
      ],
    }),
    foreignKey({
      name: "action_proposals_connector_resource_fk",
      columns: [t.connectorInstanceId, t.targetResourceId],
      foreignColumns: [resources.connectorInstanceId, resources.id],
    }),
    foreignKey({
      name: "action_proposals_resource_snapshot_fk",
      columns: [t.targetResourceId, t.basedOnSnapshotId],
      foreignColumns: [resourceSnapshots.resourceId, resourceSnapshots.id],
    }),
    check(
      "action_proposals_tool_check",
      sql`${t.tool} IN ('calendar.reschedule', 'calendar.create')`,
    ),
    check("action_proposals_input_json_check", sql`json_valid(${t.inputJson})`),
    check(
      "action_proposals_preview_json_check",
      sql`json_valid(${t.previewJson})`,
    ),
    check("action_proposals_ttl_check", sql`${t.expiresAt} > ${t.createdAt}`),
    check(
      "action_proposals_create_target_check",
      sql`(${t.tool} = 'calendar.reschedule' AND ${t.targetRefId} IS NOT NULL AND ${t.targetResourceId} IS NOT NULL AND ${t.basedOnSnapshotId} IS NOT NULL AND ${t.expectedRevision} IS NOT NULL) OR (${t.tool} = 'calendar.create' AND ${t.targetRefId} IS NULL AND ${t.targetResourceId} IS NULL AND ${t.basedOnSnapshotId} IS NULL AND ${t.expectedRevision} IS NULL)`,
    ),
    check(
      "action_proposals_status_check",
      sql`${t.status} IN ('pending','approved','rejected','expired')`,
    ),
    check(
      "action_proposals_lifecycle_check",
      sql`(${t.status} = 'pending' AND ${t.resolvedAt} IS NULL AND ${t.decisionTurnId} IS NULL) OR
        (${t.status} = 'approved' AND ${t.resolvedAt} IS NOT NULL AND ${t.decisionTurnId} IS NOT NULL) OR
        (${t.status} = 'rejected' AND ${t.resolvedAt} IS NOT NULL AND ${t.decisionTurnId} IS NOT NULL) OR
        (${t.status} = 'expired' AND ${t.resolvedAt} IS NOT NULL AND ${t.decisionTurnId} IS NULL)`,
    ),
  ],
);

export const actionExecutions = sqliteTable(
  "action_executions",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id),
    proposalId: text("proposal_id").notNull(),
    approvalTurnId: text("approval_turn_id").notNull(),
    actionRunId: text("action_run_id").notNull(),
    status: text("status").notNull(),
    externalCallStartedAt: integer("external_call_started_at"),
    finishedAt: integer("finished_at"),
    errorCode: text("error_code"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    unique("action_executions_proposal_unique").on(t.proposalId),
    unique("action_executions_action_run_unique").on(t.actionRunId),
    unique("action_executions_session_proposal_id_unique").on(
      t.sessionId,
      t.proposalId,
      t.id,
    ),
    foreignKey({
      name: "action_executions_session_proposal_fk",
      columns: [t.sessionId, t.proposalId],
      foreignColumns: [actionProposals.sessionId, actionProposals.id],
    }),
    foreignKey({
      name: "action_executions_session_approval_turn_fk",
      columns: [t.sessionId, t.approvalTurnId],
      foreignColumns: [turns.sessionId, turns.id],
    }),
    foreignKey({
      name: "action_executions_session_action_run_fk",
      columns: [t.sessionId, t.actionRunId],
      foreignColumns: [runs.sessionId, runs.id],
    }),
    foreignKey({
      name: "action_executions_approval_turn_run_fk",
      columns: [t.approvalTurnId, t.actionRunId],
      foreignColumns: [runs.turnId, runs.id],
    }),
    check(
      "action_executions_status_check",
      sql`${t.status} IN ('queued','preflight','executing','succeeded','succeeded_unverified','blocked_stale','failed','unknown')`,
    ),
    check(
      "action_executions_updated_at_check",
      sql`${t.updatedAt} >= ${t.createdAt}`,
    ),
    check(
      "action_executions_marker_terminal_check",
      sql`(${t.status} = 'queued' AND ${t.externalCallStartedAt} IS NULL AND ${t.finishedAt} IS NULL AND ${t.errorCode} IS NULL) OR
        (${t.status} = 'preflight' AND ${t.externalCallStartedAt} IS NULL AND ${t.finishedAt} IS NULL AND ${t.errorCode} IS NULL) OR
        (${t.status} = 'executing' AND ${t.externalCallStartedAt} IS NOT NULL AND ${t.finishedAt} IS NULL AND ${t.errorCode} IS NULL) OR
        (${t.status} = 'succeeded' AND ${t.externalCallStartedAt} IS NOT NULL AND ${t.finishedAt} IS NOT NULL AND ${t.errorCode} IS NULL) OR
        (${t.status} = 'succeeded_unverified' AND ${t.externalCallStartedAt} IS NOT NULL AND ${t.finishedAt} IS NOT NULL AND ${t.errorCode} IS NULL) OR
        (${t.status} = 'unknown' AND ${t.externalCallStartedAt} IS NOT NULL AND ${t.finishedAt} IS NOT NULL AND ${t.errorCode} IS NULL) OR
        (${t.status} = 'blocked_stale' AND ${t.externalCallStartedAt} IS NULL AND ${t.finishedAt} IS NOT NULL AND ${t.errorCode} IS NULL) OR
        (${t.status} = 'failed' AND ${t.finishedAt} IS NOT NULL AND ${t.errorCode} IS NOT NULL)`,
    ),
  ],
);

export const actionExecutionGrants = sqliteTable(
  "action_execution_grants",
  {
    executionId: text("execution_id")
      .primaryKey()
      .references(() => actionExecutions.id),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id),
    proposalId: text("proposal_id").notNull(),
    proposalHash: text("proposal_hash").notNull(),
    tool: text("tool").notNull(),
    inputHash: text("input_hash").notNull(),
    consumedAt: integer("consumed_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    foreignKey({
      name: "action_execution_grants_execution_fk",
      columns: [t.sessionId, t.proposalId, t.executionId],
      foreignColumns: [
        actionExecutions.sessionId,
        actionExecutions.proposalId,
        actionExecutions.id,
      ],
    }),
    foreignKey({
      name: "action_execution_grants_session_proposal_fk",
      columns: [t.sessionId, t.proposalId],
      foreignColumns: [actionProposals.sessionId, actionProposals.id],
    }),
    check(
      "action_execution_grants_tool_check",
      sql`${t.tool} IN ('calendar.reschedule', 'calendar.create')`,
    ),
    check(
      "action_execution_grants_consumed_check",
      sql`(${t.consumedAt} IS NULL) OR (${t.consumedAt} IS NOT NULL)`,
    ),
  ],
);

export const actionReceipts = sqliteTable(
  "action_receipts",
  {
    executionId: text("execution_id")
      .primaryKey()
      .references(() => actionExecutions.id),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id),
    proposalId: text("proposal_id").notNull(),
    proposalHash: text("proposal_hash").notNull(),
    outcome: text("outcome").notNull(),
    preflightRevision: text("preflight_revision"),
    preflightSnapshotId: text("preflight_snapshot_id"),
    observedRevision: text("observed_revision"),
    resultSnapshotId: text("result_snapshot_id"),
    summaryJson: text("summary_json").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    foreignKey({
      name: "action_receipts_execution_fk",
      columns: [t.sessionId, t.proposalId, t.executionId],
      foreignColumns: [
        actionExecutions.sessionId,
        actionExecutions.proposalId,
        actionExecutions.id,
      ],
    }),
    foreignKey({
      name: "action_receipts_session_proposal_fk",
      columns: [t.sessionId, t.proposalId],
      foreignColumns: [actionProposals.sessionId, actionProposals.id],
    }),
    foreignKey({
      name: "action_receipts_preflight_snapshot_fk",
      columns: [t.preflightSnapshotId],
      foreignColumns: [resourceSnapshots.id],
    }),
    foreignKey({
      name: "action_receipts_result_snapshot_fk",
      columns: [t.resultSnapshotId],
      foreignColumns: [resourceSnapshots.id],
    }),
    check(
      "action_receipts_outcome_check",
      sql`${t.outcome} IN ('succeeded','succeeded_unverified','blocked_stale','failed','unknown')`,
    ),
    check(
      "action_receipts_summary_json_check",
      sql`json_valid(${t.summaryJson})`,
    ),
    check(
      "action_receipts_observation_check",
      sql`(${t.outcome} = 'succeeded' AND ${t.observedRevision} IS NOT NULL AND ${t.resultSnapshotId} IS NOT NULL) OR
        (${t.outcome} = 'succeeded_unverified' AND ${t.observedRevision} IS NULL AND ${t.resultSnapshotId} IS NULL) OR
        (${t.outcome} = 'blocked_stale' AND ${t.preflightRevision} IS NOT NULL AND ${t.preflightSnapshotId} IS NOT NULL AND ${t.observedRevision} IS NULL AND ${t.resultSnapshotId} IS NULL) OR
        (${t.outcome} IN ('failed','unknown') AND ${t.observedRevision} IS NULL AND ${t.resultSnapshotId} IS NULL)`,
    ),
  ],
);
// AV autonomy slice (purposes + tasks + stop control). Mirrors
// packages/kernel/migrations/0011_autonomy.sql, which is authoritative.
// Purposes carry the immutable ORIGINAL statement plus a SEPARATE nullable
// interpretation; only status / version / updated_at / superseded_by are
// ever rewritten. Tasks are explicit LOCAL entities with no calendar /
// provider / scheduling columns. The stop control is a singleton seeded
// paused; the activity log is append-only with a closed kind set.

export const autonomyPurposes = sqliteTable(
  "autonomy_purposes",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id),
    scope: text("scope").notNull(),
    kind: text("kind").notNull(),
    isExplicit: integer("is_explicit").notNull(),
    sourceKind: text("source_kind").notNull(),
    sourceTurnId: text("source_turn_id"),
    statement: text("statement").notNull(),
    interpretation: text("interpretation"),
    status: text("status").notNull(),
    version: integer("version").notNull(),
    supersededBy: text("superseded_by"),
    validFrom: text("valid_from"),
    validUntil: text("valid_until"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    unique("autonomy_purposes_session_id_unique").on(t.sessionId, t.id),
    foreignKey({
      name: "autonomy_purposes_session_source_turn_fk",
      columns: [t.sessionId, t.sourceTurnId],
      foreignColumns: [turns.sessionId, turns.id],
    }),
    check(
      "autonomy_purposes_kind_check",
      sql`${t.kind} IN ('goal','preference','constraint','permission','wish','temporary_state')`,
    ),
    check("autonomy_purposes_is_explicit_check", sql`${t.isExplicit} IN (0,1)`),
    check(
      "autonomy_purposes_source_kind_check",
      sql`${t.sourceKind} IN ('user','self','external')`,
    ),
    check("autonomy_purposes_version_check", sql`${t.version} >= 1`),
    check(
      "autonomy_purposes_status_check",
      sql`${t.status} IN ('active','superseded','revoked','achieved')`,
    ),
  ],
);

export const autonomyPurposeEvents = sqliteTable(
  "autonomy_purpose_events",
  {
    id: text("id").primaryKey(),
    purposeId: text("purpose_id").notNull(),
    sessionId: text("session_id").notNull(),
    seq: integer("seq").notNull(),
    event: text("event").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    statement: text("statement").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    unique("autonomy_purpose_events_purpose_seq_unique").on(t.purposeId, t.seq),
    foreignKey({
      name: "autonomy_purpose_events_session_purpose_fk",
      columns: [t.sessionId, t.purposeId],
      foreignColumns: [autonomyPurposes.sessionId, autonomyPurposes.id],
    }),
    check("autonomy_purpose_events_seq_check", sql`${t.seq} >= 1`),
    check(
      "autonomy_purpose_events_event_check",
      sql`${t.event} IN ('created','corrected','superseded','revoked','achieved')`,
    ),
  ],
);

export const autonomyTasks = sqliteTable(
  "autonomy_tasks",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id),
    scope: text("scope").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    kind: text("kind").notNull(),
    speaker: text("speaker").notNull(),
    deadline: text("deadline"),
    parentPurposeId: text("parent_purpose_id"),
    status: text("status").notNull(),
    version: integer("version").notNull(),
    holdReason: text("hold_reason"),
    reconsiderTrigger: text("reconsider_trigger"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    unique("autonomy_tasks_session_id_unique").on(t.sessionId, t.id),
    foreignKey({
      name: "autonomy_tasks_session_parent_fk",
      columns: [t.sessionId, t.parentPurposeId],
      foreignColumns: [autonomyPurposes.sessionId, autonomyPurposes.id],
    }),
    check(
      "autonomy_tasks_kind_check",
      sql`${t.kind} IN ('chat','wish','problem','task')`,
    ),
    check(
      "autonomy_tasks_speaker_check",
      sql`${t.speaker} IN ('user','self','external')`,
    ),
    check(
      "autonomy_tasks_status_check",
      sql`${t.status} IN ('open','in_progress','held','completed','cancelled')`,
    ),
    check("autonomy_tasks_version_check", sql`${t.version} >= 1`),
    check(
      "autonomy_tasks_hold_check",
      sql`(${t.status} = 'held' AND ${t.holdReason} IS NOT NULL AND ${t.reconsiderTrigger} IS NOT NULL) OR (${t.status} != 'held' AND ${t.holdReason} IS NULL AND ${t.reconsiderTrigger} IS NULL)`,
    ),
  ],
);

export const autonomyPurposeConflicts = sqliteTable(
  "autonomy_purpose_conflicts",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id),
    purposeAId: text("purpose_a_id").notNull(),
    purposeBId: text("purpose_b_id").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    unique("autonomy_purpose_conflicts_session_pair_unique").on(
      t.sessionId,
      t.purposeAId,
      t.purposeBId,
    ),
    foreignKey({
      name: "autonomy_purpose_conflicts_session_a_fk",
      columns: [t.sessionId, t.purposeAId],
      foreignColumns: [autonomyPurposes.sessionId, autonomyPurposes.id],
    }),
    foreignKey({
      name: "autonomy_purpose_conflicts_session_b_fk",
      columns: [t.sessionId, t.purposeBId],
      foreignColumns: [autonomyPurposes.sessionId, autonomyPurposes.id],
    }),
    check(
      "autonomy_purpose_conflicts_distinct_check",
      sql`${t.purposeAId} != ${t.purposeBId}`,
    ),
  ],
);

export const autonomyTaskEvents = sqliteTable(
  "autonomy_task_events",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull(),
    sessionId: text("session_id").notNull(),
    seq: integer("seq").notNull(),
    event: text("event").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    note: text("note"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    unique("autonomy_task_events_task_seq_unique").on(t.taskId, t.seq),
    foreignKey({
      name: "autonomy_task_events_session_task_fk",
      columns: [t.sessionId, t.taskId],
      foreignColumns: [autonomyTasks.sessionId, autonomyTasks.id],
    }),
    check("autonomy_task_events_seq_check", sql`${t.seq} >= 1`),
    check(
      "autonomy_task_events_event_check",
      sql`${t.event} IN ('created','started','held','resumed','completed','cancelled','parent_held')`,
    ),
  ],
);

export const autonomyControl = sqliteTable(
  "autonomy_control",
  {
    id: text("id").primaryKey(),
    paused: integer("paused").notNull(),
    version: integer("version").notNull(),
    reason: text("reason"),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    check("autonomy_control_id_check", sql`${t.id} = 'global'`),
    check("autonomy_control_paused_check", sql`${t.paused} IN (0,1)`),
    check("autonomy_control_version_check", sql`${t.version} >= 1`),
  ],
);

export const autonomyActivity = sqliteTable(
  "autonomy_activity",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    sessionId: text("session_id"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    check(
      "autonomy_activity_kind_check",
      sql`${t.kind} IN ('user_message','autonomy_stopped','autonomy_resumed','restart_fence','interrupted_note')`,
    ),
  ],
);

// AV02 shadow-deliberation durable core. Mirrors
// packages/kernel/migrations/0012_shadow.sql, which is authoritative.
// Shadow jobs reason ABOUT policy state but NEVER execute: no grant /
// capability / calendar / ToolBroker / child-process / device / secret
// column exists here. A recorded `permission` purpose stays a CLAIM; a
// completed job stores a MODEL decision SEPARATE from the CODE policy code.

export const shadowScopeEpochs = sqliteTable(
  "shadow_scope_epochs",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id),
    scope: text("scope").notNull(),
    epoch: integer("epoch").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [check("shadow_scope_epochs_epoch_check", sql`${t.epoch} >= 1`)],
);

export const shadowInbox = sqliteTable(
  "shadow_inbox",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id),
    scope: text("scope").notNull(),
    kind: text("kind").notNull(),
    triggerEvent: text("trigger_event").notNull(),
    triggerId: text("trigger_id"),
    controlVersion: integer("control_version").notNull(),
    scopeEpoch: integer("scope_epoch").notNull(),
    disposition: text("disposition").notNull(),
    jobId: text("job_id"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    check(
      "shadow_inbox_kind_check",
      sql`${t.kind} IN ('policy_change','explicit_request')`,
    ),
    check("shadow_inbox_control_version_check", sql`${t.controlVersion} >= 1`),
    check("shadow_inbox_scope_epoch_check", sql`${t.scopeEpoch} >= 1`),
    check(
      "shadow_inbox_disposition_check",
      sql`${t.disposition} IN ('recorded','consumed','skipped')`,
    ),
  ],
);

export const shadowJobs = sqliteTable(
  "shadow_jobs",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id),
    scope: text("scope").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    triggerEvent: text("trigger_event").notNull(),
    triggerId: text("trigger_id"),
    requestKey: text("request_key"),
    controlVersion: integer("control_version").notNull(),
    scopeEpoch: integer("scope_epoch").notNull(),
    claimControlVersion: integer("claim_control_version"),
    claimScopeEpoch: integer("claim_scope_epoch"),
    contextJson: text("context_json"),
    modelDecisionJson: text("model_decision_json"),
    policyCode: text("policy_code"),
    version: integer("version").notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: integer("lease_expires_at"),
    holdReason: text("hold_reason"),
    failCode: text("fail_code"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    check(
      "shadow_jobs_kind_check",
      sql`${t.kind} IN ('policy_change','explicit_request')`,
    ),
    check(
      "shadow_jobs_status_check",
      sql`${t.status} IN ('pending','claimed','completed','held','failed','cancelled')`,
    ),
    check("shadow_jobs_control_version_check", sql`${t.controlVersion} >= 1`),
    check("shadow_jobs_scope_epoch_check", sql`${t.scopeEpoch} >= 1`),
    check("shadow_jobs_version_check", sql`${t.version} >= 1`),
    check(
      "shadow_jobs_policy_code_check",
      sql`${t.policyCode} IS NULL OR ${t.policyCode} IN ('shadow_only','missing_grant','wish_not_command','external_no_authority','needs_clarification','no_action')`,
    ),
    check(
      "shadow_jobs_context_json_check",
      sql`${t.contextJson} IS NULL OR json_valid(${t.contextJson})`,
    ),
    check(
      "shadow_jobs_model_decision_json_check",
      sql`${t.modelDecisionJson} IS NULL OR json_valid(${t.modelDecisionJson})`,
    ),
  ],
);

export const shadowJobEvents = sqliteTable(
  "shadow_job_events",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => shadowJobs.id),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id),
    seq: integer("seq").notNull(),
    event: text("event").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    note: text("note"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    unique("shadow_job_events_job_seq_unique").on(t.jobId, t.seq),
    check("shadow_job_events_seq_check", sql`${t.seq} >= 1`),
    check(
      "shadow_job_events_event_check",
      sql`${t.event} IN ('enqueued','claimed','completed','held','failed','cancelled','superseded')`,
    ),
  ],
);

// AV05 notifications durable projection (kernel core only). Mirrors
// packages/kernel/migrations/0014_notifications.sql, which is authoritative.
export const notificationCursors = sqliteTable(
  "notification_cursors",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id),
    source: text("source").notNull(),
    lastSourceRowid: integer("last_source_rowid").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.source] }),
    check(
      "notification_cursors_source_check",
      sql`${t.source} IN ('shadow_job_events','action_receipts','autonomy_task_events')`,
    ),
    check("notification_cursors_rowid_check", sql`${t.lastSourceRowid} >= 0`),
  ],
);

export const notifications = sqliteTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id),
    seq: integer("seq").notNull(),
    scope: text("scope").notNull(),
    kind: text("kind").notNull(),
    priority: text("priority").notNull(),
    briefText: text("brief_text").notNull(),
    sourceKind: text("source_kind").notNull(),
    sourceId: text("source_id").notNull(),
    sourceVersion: integer("source_version"),
    sourceEpoch: integer("source_epoch"),
    citedDeadlines: text("cited_deadlines").notNull(),
    fingerprint: text("fingerprint").notNull(),
    outdated: integer("outdated").notNull().default(0),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    unique("notifications_session_seq_unique").on(t.sessionId, t.seq),
    unique("notifications_session_fingerprint_unique").on(
      t.sessionId,
      t.fingerprint,
    ),
    check("notifications_seq_check", sql`${t.seq} >= 1`),
    check(
      "notifications_kind_check",
      sql`${t.kind} IN ('progress','proposal','question','deadline','commitment')`,
    ),
    check(
      "notifications_priority_check",
      sql`${t.priority} IN ('routine','urgent')`,
    ),
    check(
      "notifications_source_kind_check",
      sql`${t.sourceKind} IN ('shadow_job','action_receipt','task_deadline')`,
    ),
    check(
      "notifications_cited_deadlines_check",
      sql`json_valid(${t.citedDeadlines})`,
    ),
    check("notifications_outdated_check", sql`${t.outdated} IN (0,1)`),
  ],
);

export const notificationAcks = sqliteTable(
  "notification_acks",
  {
    notificationId: text("notification_id")
      .primaryKey()
      .references(() => notifications.id),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id),
    ackKey: text("ack_key").notNull(),
    ackBody: text("ack_body").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    unique("notification_acks_session_key_unique").on(t.sessionId, t.ackKey),
    check("notification_acks_body_check", sql`json_valid(${t.ackBody})`),
  ],
);

export const notificationDeadlineSchedule = sqliteTable(
  "notification_deadline_schedule",
  {
    taskId: text("task_id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id),
    scope: text("scope").notNull(),
    dueAt: integer("due_at").notNull(),
    observedTaskVersion: integer("observed_task_version").notNull(),
    sourceUpdatedAt: integer("source_updated_at").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.sessionId, t.taskId],
      foreignColumns: [autonomyTasks.sessionId, autonomyTasks.id],
      name: "notification_deadline_session_task_fk",
    }),
    check("notification_deadline_due_at_check", sql`${t.dueAt} >= 0`),
    check(
      "notification_deadline_version_check",
      sql`${t.observedTaskVersion} >= 1`,
    ),
  ],
);

export const kernelSchema = {
  sessions,
  autonomyPurposes,
  autonomyPurposeConflicts,
  turns,
  runs,
  turnSelections,
  runEvents,
  toolCalls,
  apiIdempotency,
  connectorInstances,
  resources,
  resourceSnapshots,
  snapshotLinks,
  sessionReferences,
  referenceSets,
  referenceSetItems,
  sessionReferenceContext,
  evidenceGrants,
  modelCalls,
  memoryOutbox,
  memoryExposures,
  memoryGrants,
  memorySearches,
  memorySearchItems,
  memoryOperations,
  actionProposals,
  actionExecutions,
  actionExecutionGrants,
  actionReceipts,
  shadowScopeEpochs,
  shadowInbox,
  shadowJobs,
  shadowJobEvents,
  notificationCursors,
  notifications,
  notificationAcks,
  notificationDeadlineSchedule,
};
