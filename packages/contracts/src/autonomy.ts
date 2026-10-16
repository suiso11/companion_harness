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
  interpretation: PurposeInterpretationSchema.nullable(),
  status: PurposeStatusSchema,
  version: z.number().int().min(1),
  supersededBy: UuidSchema.nullable(),
  /** Explicit applicability window; NULL bounds are unbounded. */
  validFrom: PurposeApplicabilityInstantSchema.nullable(),
  validUntil: PurposeApplicabilityInstantSchema.nullable(),
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
