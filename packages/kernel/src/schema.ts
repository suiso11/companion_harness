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

export const kernelSchema = {
  sessions,
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
};
