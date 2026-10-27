import { z } from "zod";
import { Sha256HexSchema, UnixMsSchema, UuidSchema } from "./ids.js";

/**
 * AV autonomy slice (purposes + tasks + global stop control).
 *
 * A PURPOSE records a durable user/self/external intent statement with
 * explicit provenance. A recorded `permission` is ONLY a claim: these
 * contracts create NO executable grant, NO capability write, and NO OAuth /
 * config change anywhere in this codebase. Goals, confidence values, and
 * silence never grant authority; conflicts stay unresolved until an
 * explicit user correction / revocation / achievement changes membership.
 *
 * A TASK is an explicit local entity (`chat` / `wish` / `problem` / `task`),
 * NOT a CalendarAction: tasks never create/reschedule calendar events and
 * never perform external execution.
 *
 * Borrowed bounds (documented, not newly measured): statement/interpretation
 * bodies cap at 2000 code points (borrowed from the explicit memory
 * `correctionBody` cap); task titles cap at 256 (borrowed from the
 * `calendar.create` title cap); hold reasons / reconsider triggers cap at
 * 500 code points (borrowed from the fixed API error message cap); list
 * limits default 50 / max 100 (borrowed from history pagination); history
 * pages default 50 / max 200 with an exclusive `afterSeq` cursor and a
 * `nextAfterSeq` cursor (borrowed from the run-events pagination cap); scope
 * strings cap at 128 (borrowed from the strategy-name length cap). No new
 * model / threshold / authority settings are introduced here.
 */

function codePointsMax(maxCp: number): (value: string) => boolean {
  return (value: string): boolean => Array.from(value).length <= maxCp;
}

/** Closed purpose-kind vocabulary (goal vs wish vs constraint ...). */
export const PurposeKindSchema = z.enum([
  "goal",
  "preference",
  "constraint",
  "permission",
  "wish",
  "temporary_state",
]);
export type PurposeKind = z.infer<typeof PurposeKindSchema>;

/** Closed provenance-source vocabulary (who stated it). */
export const ProvenanceSourceSchema = z.enum(["user", "self", "external"]);
export type ProvenanceSource = z.infer<typeof ProvenanceSourceSchema>;

/** Closed purpose lifecycle (terminal: superseded / revoked / achieved). */
export const PurposeStatusSchema = z.enum([
  "active",
  "superseded",
  "revoked",
  "achieved",
]);
export type PurposeStatus = z.infer<typeof PurposeStatusSchema>;

/** Closed task-kind vocabulary (explicit local entity, never Calendar). */
export const TaskKindSchema = z.enum(["chat", "wish", "problem", "task"]);
export type TaskKind = z.infer<typeof TaskKindSchema>;

/** Closed task-speaker vocabulary (who raised the task). */
export const TaskSpeakerSchema = z.enum(["user", "self", "external"]);
export type TaskSpeaker = z.infer<typeof TaskSpeakerSchema>;

/** Closed task lifecycle (terminal: completed / cancelled, never revived). */
export const TaskStatusSchema = z.enum([
  "open",
  "in_progress",
  "held",
  "completed",
  "cancelled",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/** Non-terminal task statuses (revocation holds exactly these). */
export const NON_TERMINAL_TASK_STATUSES = [
  "open",
  "in_progress",
  "held",
] as const;

/** Explicit metadata scope string attached to every purpose/task. */
export const AutonomyScopeSchema = z.string().min(1).max(128);
export type AutonomyScope = z.infer<typeof AutonomyScopeSchema>;

/** User/self/external statement text (original source, immutable). */
export const PurposeStatementSchema = z
  .string()
  .min(1)
  .refine(codePointsMax(2000), { message: "statement over 2000 code points" });
export type PurposeStatement = z.infer<typeof PurposeStatementSchema>;

/** AI interpretation text (kept separate from the original statement). */
export const PurposeInterpretationSchema = z
  .string()
  .min(1)
  .refine(codePointsMax(2000), {
    message: "interpretation over 2000 code points",
  });
export type PurposeInterpretation = z.infer<typeof PurposeInterpretationSchema>;

/** Nullable explicit applicability instant (strict RFC3339, explicit offset). */
export const PurposeApplicabilityInstantSchema = z.string().min(1).max(128);
export type PurposeApplicabilityInstant = z.infer<
  typeof PurposeApplicabilityInstantSchema
>;

/** Task title (bounded, borrowed cap). */
export const TaskTitleSchema = z.string().min(1).max(256);
export type TaskTitle = z.infer<typeof TaskTitleSchema>;

/** Task body (optional detail, borrowed cap). */
export const TaskBodySchema = z
  .string()
  .min(1)
  .refine(codePointsMax(2000), { message: "body over 2000 code points" });
export type TaskBody = z.infer<typeof TaskBodySchema>;

/** Hold reason / reconsideration trigger (both required on hold). */
export const HoldReasonSchema = z
  .string()
  .min(1)
  .refine(codePointsMax(500), { message: "reason over 500 code points" });
export type HoldReason = z.infer<typeof HoldReasonSchema>;

/**
 * Resume evidence: a meaningful state-change description. Timer-only or
 * clock-only resumption is structurally impossible: there is NO timer /
 * duration / timestamp field on the resume request, and `evidenceKind` is a
 * closed enum with no timer member.
 */
export const ResumeEvidenceKindSchema = z.enum([
  "parent_changed",
  "dependency_completed",
  "user_confirmed",
  "correction_applied",
  "external_input",
]);
export type ResumeEvidenceKind = z.infer<typeof ResumeEvidenceKindSchema>;

export const ResumeEvidenceSchema = z
  .string()
  .min(1)
  .refine(codePointsMax(2000), { message: "evidence over 2000 code points" });
export type ResumeEvidence = z.infer<typeof ResumeEvidenceSchema>;

/* ------------------------------------------------------------------ */
/* Idempotency scopes                                                   */
/* ------------------------------------------------------------------ */

/** Global (non-session) idempotency scope for the singleton stop control. */
export const IDEMPOTENCY_SCOPE_AUTONOMY_CONTROL = "autonomy:control" as const;

/** Purpose-create scope: one key space per owning session. */
export function purposeCreateScope(sessionId: string): string {
  return `session:${UuidSchema.parse(sessionId)}:purpose`;
}

/** Task-create scope: one key space per owning session. */
export function taskCreateScope(sessionId: string): string {
  return `session:${UuidSchema.parse(sessionId)}:task`;
}

export const PurposeOpSchema = z.enum(["correct", "revoke", "achieve"]);
export type PurposeOp = z.infer<typeof PurposeOpSchema>;

/** Purpose-mutation scope: one key space per purpose + operation. */
export function purposeOpScope(purposeId: string, op: PurposeOp): string {
  return `purpose:${UuidSchema.parse(purposeId)}:${op}`;
}

export const TaskOpSchema = z.enum([
  "start",
  "hold",
  "resume",
  "complete",
  "cancel",
]);
export type TaskOp = z.infer<typeof TaskOpSchema>;

/** Task-transition scope: one key space per task + operation. */
export function taskOpScope(taskId: string, op: TaskOp): string {
  return `task:${UuidSchema.parse(taskId)}:${op}`;
}

/** Purpose-conflict scope: one key space per owning session + id pair. */
export function purposeConflictScope(
  sessionId: string,
  purposeAId: string,
  purposeBId: string,
): string {
  const session = UuidSchema.parse(sessionId);
  const a = UuidSchema.parse(purposeAId);
  const b = UuidSchema.parse(purposeBId);
  const [first, second] = a < b ? [a, b] : [b, a];
  return `session:${session}:conflict:${first}:${second}`;
}

/* ------------------------------------------------------------------ */
/* Purpose DTOs                                                         */
/* ------------------------------------------------------------------ */

export const PurposeCreateRequestSchema = z.strictObject({
  scope: AutonomyScopeSchema,
  statement: PurposeStatementSchema,
  kind: PurposeKindSchema,
  /** True = explicit user statement; false = model inference record. */
  explicit: z.boolean(),
  sourceKind: ProvenanceSourceSchema,
  /** Optional same-session turn the statement was recorded from. */
  sourceTurnId: UuidSchema.optional(),
  /** AI interpretation, stored SEPARATELY from the original statement. */
  interpretation: PurposeInterpretationSchema.optional(),
  /**
   * Optional explicit applicability window (AV01 temporal applicability).
   * Absent stays NULL (unbounded); when present each bound MUST be a strict
   * RFC3339-with-explicit-offset instant and validUntil must be after
   * validFrom. Never inferred, never a TTL/auto-archive.
   */
  validFrom: PurposeApplicabilityInstantSchema.optional(),
  validUntil: PurposeApplicabilityInstantSchema.optional(),
  /**
   * Optional structured constraint rule (ONLY kind=constraint; strict shape
   * validated server-side: deny_workspace/deny_operation/deny_write_path).
   * Present passes through hashing; absent leaves stored rule unchanged.
   */
  constraintRule: z.unknown().optional(),
});
export type PurposeCreateRequest = z.infer<typeof PurposeCreateRequestSchema>;

export const PurposeViewSchema = z.strictObject({
  id: UuidSchema,
  sessionId: UuidSchema,
  scope: AutonomyScopeSchema,
  statement: PurposeStatementSchema,
  kind: PurposeKindSchema,
  explicit: z.boolean(),
  sourceKind: ProvenanceSourceSchema,
  sourceTurnId: UuidSchema.nullable(),
  /** Confirmation provenance: null unless a person confirmed this purpose. */
  confirmedFrom: z.string().nullable().default(null),
  confirmedAt: UnixMsSchema.nullable().default(null),
  interpretation: PurposeInterpretationSchema.nullable(),
  status: PurposeStatusSchema,
  version: z.number().int().min(1),
  supersededBy: UuidSchema.nullable(),
  /** Explicit applicability window; NULL bounds are unbounded. */
  validFrom: PurposeApplicabilityInstantSchema.nullable(),
  validUntil: PurposeApplicabilityInstantSchema.nullable(),
  /** Structured constraint rule payload (kind=constraint only), else null. */
  constraintRule: z.unknown().nullable().default(null),
  createdAt: UnixMsSchema,
  updatedAt: UnixMsSchema,
});
export type PurposeView = z.infer<typeof PurposeViewSchema>;

export const PurposeCreateResponseSchema = PurposeViewSchema;
export type PurposeCreateResponse = z.infer<typeof PurposeCreateResponseSchema>;

export const PurposeListResponseSchema = z.strictObject({
  items: z.array(PurposeViewSchema).max(100),
});
export type PurposeListResponse = z.infer<typeof PurposeListResponseSchema>;

/**
 * Explicit correction: appends a NEW purpose record and CAS-transitions the
 * exact referenced old record to `superseded` atomically. Never latest-wins
 * over an unrelated record: the target id + expected version are mandatory.
 */
export const PurposeCorrectRequestSchema = z.strictObject({
  purposeId: UuidSchema,
  expectedVersion: z.number().int().min(1),
  scope: AutonomyScopeSchema,
  statement: PurposeStatementSchema,
  kind: PurposeKindSchema,
  explicit: z.boolean(),
  sourceKind: ProvenanceSourceSchema,
  sourceTurnId: UuidSchema.optional(),
  interpretation: PurposeInterpretationSchema.optional(),
  /**
   * Applicability correction: `undefined` preserves the old window, `null`
   * clears that bound to unbounded, a string sets it (strict RFC3339).
   */
  validFrom: z.union([PurposeApplicabilityInstantSchema, z.null()]).optional(),
  validUntil: z.union([PurposeApplicabilityInstantSchema, z.null()]).optional(),
  /**
   * Rule correction: `undefined` preserves, `null` clears, object sets
   * (kind=constraint only; kind change away with non-null rule must
   * explicitly clear or the correction is rejected).
   */
  constraintRule: z.unknown().optional().nullable(),
});
export type PurposeCorrectRequest = z.infer<typeof PurposeCorrectRequestSchema>;

export const PurposeCorrectResponseSchema = z.strictObject({
  old: PurposeViewSchema,
  current: PurposeViewSchema,
});
export type PurposeCorrectResponse = z.infer<
  typeof PurposeCorrectResponseSchema
>;

/** Revoke / achieve: CAS-transition one active record to terminal. */
export const PurposeTransitionRequestSchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
});
export type PurposeTransitionRequest = z.infer<
  typeof PurposeTransitionRequestSchema
>;

/**
 * One unresolved conflict: an EXPLICIT owner-recorded relation between two
 * purpose ids (same session + scope, both active). Cross-kind pairs (goal vs
 * constraint) are allowed; same-kind prose similarity alone is NEVER a
 * conflict. Inactive relations stay in history but are not listed.
 */
export const PurposeConflictGroupSchema = z.strictObject({
  scope: AutonomyScopeSchema,
  purposeIds: z.array(UuidSchema).min(2).max(2),
});
export type PurposeConflictGroup = z.infer<typeof PurposeConflictGroupSchema>;

/** Explicit conflict record request (ordered canonically server-side). */
export const PurposeConflictRecordRequestSchema = z.strictObject({
  purposeAId: UuidSchema,
  purposeBId: UuidSchema,
});
export type PurposeConflictRecordRequest = z.infer<
  typeof PurposeConflictRecordRequestSchema
>;

/** Stored explicit conflict relation (immutable, append-only). */
export const PurposeConflictRecordSchema = z.strictObject({
  id: UuidSchema,
  sessionId: UuidSchema,
  scope: AutonomyScopeSchema,
  purposeAId: UuidSchema,
  purposeBId: UuidSchema,
  createdAt: UnixMsSchema,
});
export type PurposeConflictRecord = z.infer<typeof PurposeConflictRecordSchema>;

export const PurposeConflictListResponseSchema = z.strictObject({
  conflicts: z.array(PurposeConflictGroupSchema).max(100),
});
export type PurposeConflictListResponse = z.infer<
  typeof PurposeConflictListResponseSchema
>;

/* ------------------------------------------------------------------ */
/* Task DTOs                                                            */
/* ------------------------------------------------------------------ */

export const TaskCreateRequestSchema = z.strictObject({
  /**
   * Explicit metadata scope: the parent purpose (when given) must share it.
   * Absent defaults to `"default"` (single-scope clients stay working);
   * present must satisfy the shared scope bound.
   */
  scope: AutonomyScopeSchema.default("default"),
  title: TaskTitleSchema,
  body: TaskBodySchema.optional(),
  kind: TaskKindSchema,
  speaker: TaskSpeakerSchema,
  /**
   * Nullable explicit deadline: when present it MUST be a strict
   * RFC3339-with-explicit-offset instant (existing calendar grammar);
   * absent stays null and is never inferred.
   */
  deadline: z.string().min(1).max(128).optional(),
  /**
   * Optional same-session/scope owned parent purpose. REQUIRED for
   * self-proposed (derived) tasks; user-direct tasks may stand alone.
   */
  parentPurposeId: UuidSchema.optional(),
});
export type TaskCreateRequest = z.infer<typeof TaskCreateRequestSchema>;

export const TaskViewSchema = z.strictObject({
  id: UuidSchema,
  sessionId: UuidSchema,
  scope: AutonomyScopeSchema,
  title: TaskTitleSchema,
  body: z.string().nullable(),
  kind: TaskKindSchema,
  speaker: TaskSpeakerSchema,
  deadline: z.string().nullable(),
  parentPurposeId: UuidSchema.nullable(),
  status: TaskStatusSchema,
  version: z.number().int().min(1),
  holdReason: z.string().nullable(),
  reconsiderTrigger: z.string().nullable(),
  createdAt: UnixMsSchema,
  updatedAt: UnixMsSchema,
});
export type TaskView = z.infer<typeof TaskViewSchema>;

export const TaskCreateResponseSchema = TaskViewSchema;
export type TaskCreateResponse = z.infer<typeof TaskCreateResponseSchema>;

export const TaskListResponseSchema = z.strictObject({
  items: z.array(TaskViewSchema).max(100),
});
export type TaskListResponse = z.infer<typeof TaskListResponseSchema>;

export const TaskTransitionRequestSchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
});
export type TaskTransitionRequest = z.infer<typeof TaskTransitionRequestSchema>;

export const TaskHoldRequestSchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
  reason: HoldReasonSchema,
  reconsiderTrigger: HoldReasonSchema,
});
export type TaskHoldRequest = z.infer<typeof TaskHoldRequestSchema>;

export const TaskResumeRequestSchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
  evidenceKind: ResumeEvidenceKindSchema,
  evidence: ResumeEvidenceSchema,
  /** Required when the recorded parent is revoked: an explicit new parent. */
  newParentPurposeId: UuidSchema.optional(),
});
export type TaskResumeRequest = z.infer<typeof TaskResumeRequestSchema>;

/* ------------------------------------------------------------------ */
/* Global stop control DTOs                                             */
/* ------------------------------------------------------------------ */

/**
 * Durable singleton stop control. `paused === true` (the new-install
 * default) forbids starting NEW autonomous background work. It never gates
 * normal user chat and never cancels already-dispatched human-approved M5
 * writes.
 */
export const AutonomyControlViewSchema = z.strictObject({
  paused: z.boolean(),
  version: z.number().int().min(1),
  reason: z.string().max(500).nullable(),
  updatedAt: UnixMsSchema,
});
export type AutonomyControlView = z.infer<typeof AutonomyControlViewSchema>;

export const AutonomyControlSetRequestSchema = z.strictObject({
  paused: z.boolean(),
  expectedVersion: z.number().int().min(1),
  reason: z.string().min(1).max(500).optional(),
});
export type AutonomyControlSetRequest = z.infer<
  typeof AutonomyControlSetRequestSchema
>;

/** Bounded activity-log entry (fixed kinds; user content never stored). */
export const AutonomyActivityKindSchema = z.enum([
  "user_message",
  "autonomy_stopped",
  "autonomy_resumed",
  "restart_fence",
  "interrupted_note",
]);
export type AutonomyActivityKind = z.infer<typeof AutonomyActivityKindSchema>;

export const AutonomyActivityItemSchema = z.strictObject({
  id: UuidSchema,
  kind: AutonomyActivityKindSchema,
  sessionId: UuidSchema.nullable(),
  createdAt: UnixMsSchema,
});
export type AutonomyActivityItem = z.infer<typeof AutonomyActivityItemSchema>;

export const AutonomyActivityListResponseSchema = z.strictObject({
  items: z.array(AutonomyActivityItemSchema).max(100),
});
export type AutonomyActivityListResponse = z.infer<
  typeof AutonomyActivityListResponseSchema
>;

/** Bounded purpose/task list query (borrowed history pagination caps). */
export const AutonomyListQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type AutonomyListQuery = z.infer<typeof AutonomyListQuerySchema>;
export type AutonomyListQueryInput = z.input<typeof AutonomyListQuerySchema>;

/**
 * Public task-list query. `status`/`kind` filter in SQL BEFORE `limit`, so an
 * older actionable task is never hidden behind newer unrelated records.
 */
export const AutonomyTaskListQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  status: TaskStatusSchema.optional(),
  kind: TaskKindSchema.optional(),
});
export type AutonomyTaskListQuery = z.infer<typeof AutonomyTaskListQuerySchema>;

/**
 * Bounded immutable-history page query (borrowed run-events pagination
 * caps: default 50 / max 200). `afterSeq` is the exclusive per-record event
 * cursor (0 = from the start); the server reads `seq > afterSeq ORDER BY
 * seq ASC LIMIT limit+1` so pages are lossless and never rewritten.
 */
export const AutonomyHistoryQuerySchema = z.strictObject({
  afterSeq: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type AutonomyHistoryQuery = z.infer<typeof AutonomyHistoryQuerySchema>;
export type AutonomyHistoryQueryInput = z.input<
  typeof AutonomyHistoryQuerySchema
>;

/** Fixed autonomy error codes (transport mapping is a server concern). */
export const AutonomyErrorCodeSchema = z.enum([
  "autonomy_version_conflict",
  "autonomy_state_conflict",
]);
export type AutonomyErrorCode = z.infer<typeof AutonomyErrorCodeSchema>;

/** Request-hash payload for integrity checks (mirrors stored hash input). */
export const AutonomyRequestHashSchema = z.strictObject({
  requestHash: Sha256HexSchema,
});
export type AutonomyRequestHash = z.infer<typeof AutonomyRequestHashSchema>;

/* ------------------------------------------------------------------ */

/* History DTOs (immutable original / correction / revocation trail)    */
/* ------------------------------------------------------------------ */

/** One immutable purpose event (append-only; rows never updated). */
export const PurposeHistoryEventSchema = z.strictObject({
  seq: z.number().int().min(1),
  event: z.enum(["created", "corrected", "superseded", "revoked", "achieved"]),
  fromStatus: PurposeStatusSchema.nullable(),
  toStatus: PurposeStatusSchema,
  createdAt: UnixMsSchema,
});
export type PurposeHistoryEvent = z.infer<typeof PurposeHistoryEventSchema>;

export const PurposeHistoryResponseSchema = z.strictObject({
  purposeId: UuidSchema,
  events: z.array(PurposeHistoryEventSchema).max(200),
  /**
   * Forward cursor: the last returned `seq` when more rows remain, else
   * null. Clients pass it back as `afterSeq` to fetch the next lossless
   * page; rows are immutable so already-read pages never change.
   */
  nextAfterSeq: z.number().int().min(1).nullable(),
});
export type PurposeHistoryResponse = z.infer<
  typeof PurposeHistoryResponseSchema
>;

/** One immutable task event (append-only; rows never updated). */
export const TaskHistoryEventSchema = z.strictObject({
  seq: z.number().int().min(1),
  event: z.enum([
    "created",
    "started",
    "held",
    "resumed",
    "completed",
    "cancelled",
    "parent_held",
  ]),
  fromStatus: TaskStatusSchema.nullable(),
  toStatus: TaskStatusSchema,
  note: z.string().nullable(),
  createdAt: UnixMsSchema,
});
export type TaskHistoryEvent = z.infer<typeof TaskHistoryEventSchema>;

export const TaskHistoryResponseSchema = z.strictObject({
  taskId: UuidSchema,
  events: z.array(TaskHistoryEventSchema).max(200),
  /**
   * Forward cursor: the last returned `seq` when more rows remain, else
   * null. Same lossless `afterSeq` paging contract as purpose history.
   */
  nextAfterSeq: z.number().int().min(1).nullable(),
});
export type TaskHistoryResponse = z.infer<typeof TaskHistoryResponseSchema>;
/* Conversation-proposal DTOs (AV03 proposal-only staging core)        */
/*                                                                     */
/* A proposal is a durable INFERRED draft staged by the model-only      */
/* tools `purpose.propose` / `task.propose`. Staging creates NO         */
/* purpose, NO task, NO grant, NO calendar write, and never resumes    */
/* the stop control. Only the explicit trusted human adoption API       */
/* creates the actual purpose/task, atomically with the accept          */
/* decision. A recorded `permission` purpose-kind proposal is ONLY a   */
/* claim (never an executable grant). Model tools accept NO deadline / */
/* window fields at all: task drafts adopt with a NULL deadline and    */
/* purpose drafts with a NULL window unless the human supplies an      */
/* explicit strict-RFC3339 value at accept time. Source identity       */
/* (session/run/turn/quote) is ALWAYS server-derived from the calling  */
/* run's CURRENT ordinary `user_text` turn — never model input.        */
/* ------------------------------------------------------------------ */

/** Adoption shape selected by the staging tool. */
export const ConversationProposalTargetSchema = z.enum(["purpose", "task"]);
export type ConversationProposalTarget = z.infer<
  typeof ConversationProposalTargetSchema
>;

/**
 * Explicit draft kind: a casual remark stays casual (no mandatory
 * taskization). A model do-nothing stages nothing.
 */
export const ConversationDraftKindSchema = z.enum([
  "casual",
  "wish",
  "problem",
  "task",
  "deadline",
]);
export type ConversationDraftKind = z.infer<typeof ConversationDraftKindSchema>;

/** Proposal lifecycle (terminal: accepted / rejected, never revived). */
export const ConversationProposalStatusSchema = z.enum([
  "pending",
  "accepted",
  "rejected",
]);
export type ConversationProposalStatus = z.infer<
  typeof ConversationProposalStatusSchema
>;

/** Immutable original quote: exact verbatim substring of the source body. */
export const ConversationSourceQuoteSchema = z
  .string()
  .min(1)
  .refine(codePointsMax(2000), { message: "quote over 2000 code points" });
export type ConversationSourceQuote = z.infer<
  typeof ConversationSourceQuoteSchema
>;

/** Task-draft quote bound (borrowed title cap: adoption title is the quote). */
export const ConversationTaskQuoteSchema = z.string().min(1).max(256);
export type ConversationTaskQuote = z.infer<typeof ConversationTaskQuoteSchema>;

/** Inference provenance is hardcoded `model` (never user instruction). */
export const ConversationProposalSourceKindSchema = z.literal("model");
export type ConversationProposalSourceKind = z.infer<
  typeof ConversationProposalSourceKindSchema
>;

/**
 * Model-side `purpose.propose` draft input. Carries NO source identity and
 * NO dates: scope/kind/quote/interpretation only. The parent is never a
 * purpose-proposal field.
 */
export const PurposeProposeRequestSchema = z.strictObject({
  scope: AutonomyScopeSchema,
  draftKind: ConversationDraftKindSchema,
  purposeKind: PurposeKindSchema,
  sourceQuote: ConversationSourceQuoteSchema,
  interpretation: PurposeInterpretationSchema,
});
export type PurposeProposeRequest = z.infer<typeof PurposeProposeRequestSchema>;

/**
 * Model-side `task.propose` draft input. An EXPLICIT parent purpose
 * (id + expected version, same session/scope, active) is REQUIRED: the
 * model can never auto-pick a parent, and task drafts carry NO deadline
 * (NULL until a human adopts with an explicit strict instant).
 */
export const TaskProposeRequestSchema = z.strictObject({
  scope: AutonomyScopeSchema,
  draftKind: ConversationDraftKindSchema,
  taskKind: TaskKindSchema,
  sourceQuote: ConversationTaskQuoteSchema,
  interpretation: PurposeInterpretationSchema,
  parentPurposeId: UuidSchema,
  expectedParentVersion: z.number().int().min(1),
});
export type TaskProposeRequest = z.infer<typeof TaskProposeRequestSchema>;

export const ConversationProposalViewSchema = z.strictObject({
  id: UuidSchema,
  sessionId: UuidSchema,
  scope: AutonomyScopeSchema,
  target: ConversationProposalTargetSchema,
  draftKind: ConversationDraftKindSchema,
  purposeKind: PurposeKindSchema.nullable(),
  taskKind: TaskKindSchema.nullable(),
  sourceQuote: z.string().min(1),
  interpretation: z.string().min(1),
  sourceKind: ConversationProposalSourceKindSchema,
  sourceTurnId: UuidSchema,
  sourceRunId: UuidSchema,
  parentPurposeId: UuidSchema.nullable(),
  expectedParentVersion: z.number().int().min(1).nullable(),
  status: ConversationProposalStatusSchema,
  version: z.number().int().min(1),
  acceptedTargetId: UuidSchema.nullable(),
  createdAt: UnixMsSchema,
  updatedAt: UnixMsSchema,
});
export type ConversationProposalView = z.infer<
  typeof ConversationProposalViewSchema
>;

export const ConversationProposalListResponseSchema = z.strictObject({
  items: z.array(ConversationProposalViewSchema).max(100),
  /** Opaque keyset cursor for the next older page; null when exhausted. */
  nextCursor: z.string().min(1).max(2048).nullable(),
  /** True when an older page remains (LIMIT+1 probe, never truncated). */
  hasMore: z.boolean(),
  /** ALL owned pending drafts in this session (never page-limited). */
  pendingCount: z.number().int().min(0),
});
export type ConversationProposalListResponse = z.infer<
  typeof ConversationProposalListResponseSchema
>;

/**
 * Bounded proposal list query: strict caps, optional opaque keyset cursor
 * (older page strictly below the cursor in newest-first order), optional
 * status filter for the pending review queue. Unknown keys are rejected
 * by the server's strict query gate.
 */
export const ConversationProposalListQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(2048).optional(),
  status: ConversationProposalStatusSchema.optional(),
});
export type ConversationProposalListQuery = z.infer<
  typeof ConversationProposalListQuerySchema
>;
export type ConversationProposalListQueryInput = z.input<
  typeof ConversationProposalListQuerySchema
>;

/**
 * Trusted human adoption: CAS on the expected proposal version. The human
 * MAY supply an explicit strict-RFC3339 deadline (task target) or window
 * (purpose target); absent stays NULL and is never inferred. Replays with
 * the same key + same body; parent drift/revocation/scope mismatch fails
 * WITHOUT creating anything.
 */
export const ConversationProposalAcceptRequestSchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
  deadline: z.string().min(1).max(128).optional(),
  validFrom: z.string().min(1).max(128).optional(),
  validUntil: z.string().min(1).max(128).optional(),
});
export type ConversationProposalAcceptRequest = z.infer<
  typeof ConversationProposalAcceptRequestSchema
>;

export const ConversationProposalAcceptResponseSchema = z.strictObject({
  proposal: ConversationProposalViewSchema,
  purpose: PurposeViewSchema.nullable(),
  task: TaskViewSchema.nullable(),
});
export type ConversationProposalAcceptResponse = z.infer<
  typeof ConversationProposalAcceptResponseSchema
>;

/** Trusted human rejection: CAS on the expected version; creates nothing. */
export const ConversationProposalRejectRequestSchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
});
export type ConversationProposalRejectRequest = z.infer<
  typeof ConversationProposalRejectRequestSchema
>;

export const ConversationProposalRejectResponseSchema =
  ConversationProposalViewSchema;
export type ConversationProposalRejectResponse = z.infer<
  typeof ConversationProposalRejectResponseSchema
>;

/* ------------------------------------------------------------------ */
/* AV04 learning: methods / hypotheses + anchored evidence (read-only  */
/* facts about learning state; NEVER permissions / budgets / goals).  */
/*                                                                     */
/* A hypothesis is EXPLICITLY labeled as such in every read DTO        */
/* (kind + status + evidence counts): a `refuted` row is NEVER         */
/* surfaced as supported/fact, and no transition promotes a            */
/* hypothesis to a permission, grant, budget, or user goal. Evidence   */
/* anchors ONLY to existing durable rows (shadow_job /                */
/* conversation_proposal / action_receipt / task_event); model         */
/* free-text claims are never valid sources.                           */
/* ------------------------------------------------------------------ */

/** What is being learned: a reusable method or a testable hypothesis. */
export const LearningHypothesisKindSchema = z.enum(["method", "hypothesis"]);
export type LearningHypothesisKind = z.infer<
  typeof LearningHypothesisKindSchema
>;

/** Learning lifecycle (terminal: retired; refuted stays labeled refuted). */
export const LearningHypothesisStatusSchema = z.enum([
  "open",
  "supported",
  "refuted",
  "retired",
]);
export type LearningHypothesisStatus = z.infer<
  typeof LearningHypothesisStatusSchema
>;

/** Evidence polarity toward the hypothesis (refutes at most for rejects). */
export const LearningEvidencePolaritySchema = z.enum([
  "supports",
  "refutes",
  "neutral",
]);
export type LearningEvidencePolarity = z.infer<
  typeof LearningEvidencePolaritySchema
>;

/** Closed evidence-source vocabulary (existing durable rows only). */
export const LearningEvidenceSourceKindSchema = z.enum([
  "shadow_job",
  "conversation_proposal",
  "action_receipt",
  "task_event",
]);
export type LearningEvidenceSourceKind = z.infer<
  typeof LearningEvidenceSourceKindSchema
>;

/** Hypothesis origin: explicit human record vs staged model proposal. */
export const LearningHypothesisOriginSchema = z.enum(["human", "model"]);
export type LearningHypothesisOrigin = z.infer<
  typeof LearningHypothesisOriginSchema
>;

/** Human-explicit transition (CAS-checked; no automatic promotion). */
export const LearningHypothesisTransitionSchema = z.enum([
  "support",
  "refute",
  "retire",
  "reaffirm",
]);
export type LearningHypothesisTransition = z.infer<
  typeof LearningHypothesisTransitionSchema
>;

/** Per-polarity evidence counts (computed at read time, never stored). */
export const LearningEvidenceCountsSchema = z.strictObject({
  supports: z.number().int().min(0),
  refutes: z.number().int().min(0),
  neutral: z.number().int().min(0),
});
export type LearningEvidenceCounts = z.infer<
  typeof LearningEvidenceCountsSchema
>;

export const LearningHypothesisViewSchema = z.strictObject({
  id: UuidSchema,
  sessionId: UuidSchema,
  scope: AutonomyScopeSchema,
  kind: LearningHypothesisKindSchema,
  statement: z.string().min(1),
  /** Explicit hypothesis label: open / supported / refuted / retired. */
  status: LearningHypothesisStatusSchema,
  version: z.number().int().min(1),
  origin: LearningHypothesisOriginSchema,
  /** True while a model-staged record awaits human accept/reject. */
  staged: z.boolean(),
  /**
   * Durable NOTICE that the parent purpose was revoked/superseded (same
   * transaction as the revocation). Never auto-cancels or auto-resumes.
   */
  needsReevaluation: z.boolean(),
  evidenceCounts: LearningEvidenceCountsSchema,
  createdAt: UnixMsSchema,
  updatedAt: UnixMsSchema,
});
export type LearningHypothesisView = z.infer<
  typeof LearningHypothesisViewSchema
>;

/** Trusted human creation: scope/kind/statement only (no status/source). */
export const LearningHypothesisCreateRequestSchema = z.strictObject({
  scope: AutonomyScopeSchema,
  kind: LearningHypothesisKindSchema,
  statement: PurposeStatementSchema,
});
export type LearningHypothesisCreateRequest = z.infer<
  typeof LearningHypothesisCreateRequestSchema
>;

/** Trusted human transition: CAS on the expected version. */
export const LearningHypothesisTransitionRequestSchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
  transition: LearningHypothesisTransitionSchema,
});
export type LearningHypothesisTransitionRequest = z.infer<
  typeof LearningHypothesisTransitionRequestSchema
>;

/** Trusted human accept/reject of a staged model proposal (CAS). */
export const LearningHypothesisDecisionRequestSchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
});
export type LearningHypothesisDecisionRequest = z.infer<
  typeof LearningHypothesisDecisionRequestSchema
>;

export const LearningEvidenceViewSchema = z.strictObject({
  id: UuidSchema,
  hypothesisId: UuidSchema,
  sessionId: UuidSchema,
  polarity: LearningEvidencePolaritySchema,
  sourceKind: LearningEvidenceSourceKindSchema,
  sourceId: UuidSchema,
  note: z.string().min(1).nullable(),
  createdAt: UnixMsSchema,
});
export type LearningEvidenceView = z.infer<typeof LearningEvidenceViewSchema>;

/**
 * Trusted human evidence attach: polarity + closed durable source anchor.
 * A rejected conversation proposal anchors ONLY `refutes` polarity.
 */
export const LearningEvidenceAttachRequestSchema = z.strictObject({
  polarity: LearningEvidencePolaritySchema,
  sourceKind: LearningEvidenceSourceKindSchema,
  sourceId: UuidSchema,
  note: z.string().min(1).max(500).optional(),
});
export type LearningEvidenceAttachRequest = z.infer<
  typeof LearningEvidenceAttachRequestSchema
>;

/** Bounded hypothesis list query (keyset cursor, newest-first). */
export const LearningHypothesisListQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(2048).optional(),
  scope: AutonomyScopeSchema.optional(),
  status: LearningHypothesisStatusSchema.optional(),
  kind: LearningHypothesisKindSchema.optional(),
});
export type LearningHypothesisListQuery = z.infer<
  typeof LearningHypothesisListQuerySchema
>;
export type LearningHypothesisListQueryInput = z.input<
  typeof LearningHypothesisListQuerySchema
>;

export const LearningHypothesisListResponseSchema = z.strictObject({
  items: z.array(LearningHypothesisViewSchema).max(100),
  /** Opaque keyset cursor for the next older page; null when exhausted. */
  nextCursor: z.string().min(1).max(2048).nullable(),
  /** True when an older page remains (LIMIT+1 probe, never truncated). */
  hasMore: z.boolean(),
});
export type LearningHypothesisListResponse = z.infer<
  typeof LearningHypothesisListResponseSchema
>;

export const LearningEvidenceListResponseSchema = z.strictObject({
  hypothesisId: UuidSchema,
  items: z.array(LearningEvidenceViewSchema).max(100),
  /** Opaque keyset cursor for the next older page; null when exhausted. */
  nextCursor: z.string().min(1).max(2048).nullable(),
  /** True when an older page remains (LIMIT+1 probe, never truncated). */
  hasMore: z.boolean(),
});
export type LearningEvidenceListResponse = z.infer<
  typeof LearningEvidenceListResponseSchema
>;

/** Bounded evidence list query (keyset cursor, oldest-first). */
export const LearningEvidenceListQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(2048).optional(),
});
export type LearningEvidenceListQuery = z.infer<
  typeof LearningEvidenceListQuerySchema
>;
export type LearningEvidenceListQueryInput = z.input<
  typeof LearningEvidenceListQuerySchema
>;

/**
 * Model-side `learning.propose` input. Carries NO status/source: scope /
 * kind / statement only. The record is staged pending (human accept /
 * reject); staging creates no purpose, task, grant, or notification.
 */
export const LearningProposeRequestSchema = z.strictObject({
  scope: AutonomyScopeSchema,
  kind: LearningHypothesisKindSchema,
  statement: PurposeStatementSchema,
});
export type LearningProposeRequest = z.infer<
  typeof LearningProposeRequestSchema
>;

/* ------------------------------------------------------------------ */
/* AV03 delegation handoffs: human-driven pi-orch handoff records.     */
/*                                                                     */
/* A handoff is a session-owned record bound to an EXISTING task (+ a  */
/* parent purpose snapshot). ALL frozen fields (target, acceptance      */
/* criteria, operation scope, budget labels, boundary flags) are       */
/* entered by the HUMAN at creation: the model can never create, edit, */
/* or spawn a handoff. This module performs NO execution, NO spawning  */
/* of workers/processes, NO grants, NO permission changes, NO numeric  */
/* budget enforcement, and NO task auto-completion. Budget entries are  */
/* human-entered TEXT labels only (never enforced numerically, never   */
/* increased by us). Boundary flags are recorded as REQUIRES SEPARATE  */
/* AUTHORIZATION claims: storing them grants nothing and changes       */
/* nothing. A verified handoff never completes its task automatically. */
/* ------------------------------------------------------------------ */

/** Handoff lifecycle (terminal: verified / failed / cancelled). */
export const HandoffStatusSchema = z.enum([
  "prepared",
  "dispatched",
  "reported",
  "verified",
  "failed",
  "cancelled",
]);
export type HandoffStatus = z.infer<typeof HandoffStatusSchema>;

/** Closed operation-scope vocabulary (no automatic spawning implied). */
export const HandoffOpScopeSchema = z.enum(["investigate", "implement"]);
export type HandoffOpScope = z.infer<typeof HandoffOpScopeSchema>;

/**
 * Closed boundary-flag vocabulary. Each recorded flag means REQUIRES
 * SEPARATE AUTHORIZATION: storing it grants nothing, changes no control,
 * task, grant, or config anywhere in this codebase.
 */
export const HandoffBoundarySchema = z.enum([
  "external_publication",
  "shared_branch",
  "payment",
  "deletion",
  "secret",
  "access_change",
]);
export type HandoffBoundary = z.infer<typeof HandoffBoundarySchema>;

/** Closed retry-cause vocabulary (explicit human cause, every time). */
export const HandoffRetryCauseSchema = z.enum([
  "transient_infra",
  "worker_error",
  "criteria_unmet",
  "environment",
]);
export type HandoffRetryCause = z.infer<typeof HandoffRetryCauseSchema>;

/**
 * Worker-reported environment claim (UNTRUSTED text from the report).
 * A `sandbox` success NEVER implies production deployment: production is
 * a SEPARATE unverified claim field, never set by verification.
 */
export const HandoffEnvironmentSchema = z.enum(["sandbox", "production"]);
export type HandoffEnvironment = z.infer<typeof HandoffEnvironmentSchema>;

/** Append-only handoff lifecycle events (never updated or deleted). */
export const HandoffEventSchema = z.enum([
  "prepared",
  "dispatched",
  "reported",
  "verified",
  "failed",
  "cancelled",
  "abnormal_exit",
  "attempt_recorded",
  "superseded",
  "reaffirmed",
  "reevaluation_flagged",
  "reevaluation_cleared",
]);
export type HandoffEvent = z.infer<typeof HandoffEventSchema>;

/** Human frozen handoff target (bounded, immutable once created). */
export const HandoffTargetSchema = z
  .string()
  .min(1)
  .refine(codePointsMax(2000), { message: "target over 2000 code points" });
export type HandoffTarget = z.infer<typeof HandoffTargetSchema>;

/** One immutable acceptance criterion (bounded text, never weakened). */
export const HandoffCriterionSchema = z
  .string()
  .min(1)
  .refine(codePointsMax(2000), { message: "criterion over 2000 code points" });
export type HandoffCriterion = z.infer<typeof HandoffCriterionSchema>;

/**
 * Human-entered resource/budget claim TEXT label only (never enforced
 * numerically by us, never increased by us, never a numeric cap).
 */
export const HandoffBudgetLabelSchema = z
  .string()
  .min(1)
  .refine(codePointsMax(500), {
    message: "budget label over 500 code points",
  });
export type HandoffBudgetLabel = z.infer<typeof HandoffBudgetLabelSchema>;

/** Optional human external reference text (recorded, never resolved). */
export const HandoffExternalRefSchema = z
  .string()
  .min(1)
  .refine(codePointsMax(500), {
    message: "external ref over 500 code points",
  });
export type HandoffExternalRef = z.infer<typeof HandoffExternalRefSchema>;

/** Untrusted worker report summary text (verification evidence, not fact). */
export const HandoffReportSummarySchema = z
  .string()
  .min(1)
  .refine(codePointsMax(2000), { message: "summary over 2000 code points" });
export type HandoffReportSummary = z.infer<typeof HandoffReportSummarySchema>;

/** Per-criterion verification result (human-entered pass + evidence). */
export const HandoffCriterionResultSchema = z.strictObject({
  index: z.number().int().min(0),
  pass: z.boolean(),
  evidence: z.string().min(1).refine(codePointsMax(2000), {
    message: "evidence over 2000 code points",
  }),
});
export type HandoffCriterionResult = z.infer<
  typeof HandoffCriterionResultSchema
>;

export const HandoffViewSchema = z.strictObject({
  id: UuidSchema,
  sessionId: UuidSchema,
  taskId: UuidSchema,
  /** Frozen task version the handoff was recorded against. */
  taskVersion: z.number().int().min(1),
  /** Frozen parent purpose snapshot (ids/versions from the owning task). */
  parentPurposeId: UuidSchema.nullable(),
  parentPurposeVersion: z.number().int().min(1).nullable(),
  /** Frozen human-entered target (immutable; change needs a new handoff). */
  target: HandoffTargetSchema,
  /** Frozen human-entered acceptance criteria (immutable array). */
  acceptanceCriteria: z.array(HandoffCriterionSchema).min(1).max(20),
  /** Frozen closed operation scope. */
  opScope: HandoffOpScopeSchema,
  /** Human-entered budget TEXT labels only (never numeric enforcement). */
  budgetLabel: HandoffBudgetLabelSchema.nullable(),
  /**
   * Recorded boundary flags: each REQUIRES SEPARATE AUTHORIZATION.
   * Storing them grants nothing.
   */
  boundaries: z.array(HandoffBoundarySchema).max(6),
  status: HandoffStatusSchema,
  version: z.number().int().min(1),
  /**
   * Durable NOTICE that the parent purpose was revoked/superseded (same
   * transaction as the revocation). New dispatch is refused while set;
   * cancel is always allowed.
   */
  needsReevaluation: z.boolean(),
  /** Count of explicitly human-recorded attempts (no automatic retry). */
  activeAttempt: z.number().int().min(0),
  /** Optional human external reference text (recorded, never resolved). */
  externalRef: HandoffExternalRefSchema.nullable(),
  /** Untrusted worker environment claim (sandbox NEVER means production). */
  reportEnvironment: HandoffEnvironmentSchema.nullable(),
  /** Untrusted worker report summary text. */
  reportSummary: HandoffReportSummarySchema.nullable(),
  /** Per-criterion verification results (all frozen criteria, all pass). */
  verificationResults: z.array(HandoffCriterionResultSchema).nullable(),
  /** This handoff supersedes an older frozen record, if any. */
  supersedesHandoffId: UuidSchema.nullable(),
  /** Newer handoff that superseded this record, if any. */
  supersededBy: UuidSchema.nullable(),
  createdAt: UnixMsSchema,
  updatedAt: UnixMsSchema,
});
export type HandoffView = z.infer<typeof HandoffViewSchema>;

/** Trusted human creation: bound to an existing task, frozen on write. */
export const HandoffCreateRequestSchema = z.strictObject({
  taskId: UuidSchema,
  target: HandoffTargetSchema,
  acceptanceCriteria: z.array(HandoffCriterionSchema).min(1).max(20),
  opScope: HandoffOpScopeSchema,
  budgetLabel: HandoffBudgetLabelSchema.optional(),
  boundaries: z.array(HandoffBoundarySchema).max(6).default([]),
  /** Create this record as the superseding successor of a frozen handoff. */
  supersedesHandoffId: UuidSchema.optional(),
});
export type HandoffCreateRequest = z.infer<typeof HandoffCreateRequestSchema>;

/** Trusted human CAS guard (no status/body fields beyond the version). */
export const HandoffTransitionRequestSchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
});
export type HandoffTransitionRequest = z.infer<
  typeof HandoffTransitionRequestSchema
>;

/** Human marks dispatched, with an optional external reference text. */
export const HandoffDispatchRequestSchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
  externalRef: HandoffExternalRefSchema.optional(),
});
export type HandoffDispatchRequest = z.infer<
  typeof HandoffDispatchRequestSchema
>;

/** Human records the untrusted worker report (sandbox NEVER production). */
export const HandoffReportRequestSchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
  environment: HandoffEnvironmentSchema,
  summary: HandoffReportSummarySchema,
});
export type HandoffReportRequest = z.infer<typeof HandoffReportRequestSchema>;

/**
 * Human verification: per-criterion pass + evidence for EVERY frozen
 * criterion (all must pass). Any fail or any missing index refuses.
 */
export const HandoffVerifyRequestSchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
  results: z.array(HandoffCriterionResultSchema).min(1).max(20),
});
export type HandoffVerifyRequest = z.infer<typeof HandoffVerifyRequestSchema>;

/** Human records one more attempt with an explicit cause (never auto). */
export const HandoffAttemptRequestSchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
  cause: HandoffRetryCauseSchema,
});
export type HandoffAttemptRequest = z.infer<typeof HandoffAttemptRequestSchema>;

/** Bounded handoff list query (keyset cursor, newest-first). */
export const HandoffListQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(2048).optional(),
  status: HandoffStatusSchema.optional(),
});
export type HandoffListQuery = z.infer<typeof HandoffListQuerySchema>;
export type HandoffListQueryInput = z.input<typeof HandoffListQuerySchema>;

export const HandoffListResponseSchema = z.strictObject({
  items: z.array(HandoffViewSchema).max(100),
  /** Opaque keyset cursor for the next older page; null when exhausted. */
  nextCursor: z.string().min(1).max(2048).nullable(),
  /** True when an older page remains (LIMIT+1 probe, never truncated). */
  hasMore: z.boolean(),
  /**
   * Count of session-owned ACTIVE (dispatched/reported) handoffs. A
   * concurrency TRACKING count only: no numeric limit is invented or
   * enforced anywhere.
   */
  activeCount: z.number().int().min(0),
});
export type HandoffListResponse = z.infer<typeof HandoffListResponseSchema>;

/** Handoff-create scope: one key space per owning session. */
export function handoffCreateScope(sessionId: string): string {
  return `session:${UuidSchema.parse(sessionId)}:handoff`;
}

/** Handoff-mutation scope: one key space per handoff + operation. */
export function handoffOpScope(handoffId: string, op: string): string {
  return `handoff:${UuidSchema.parse(handoffId)}:${op}`;
}
