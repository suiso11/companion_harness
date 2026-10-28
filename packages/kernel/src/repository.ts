// M0 kernel repository / domain persistence layer (§9-§12).
//
// Ownership: this module is the ONLY writer of domain rows (sessions,
// turns, runs, turn_selections, run_events, api_idempotency). It uses the
// caller-provided single better-sqlite3 connection, applies CAS state
// transitions with atomic event appends, allocator-based Turn/Run
// numbering (no MAX), canonical JSON + SHA-256 domain-separated
// idempotency hashing, and Zod validation on every JSON write and read.
//
// Out of scope: scheduler, ToolBroker, HTTP, server config.

import {
  type AcceptedRun,
  ActionApprovedPayloadSchema,
  type ActionExecutionStatus,
  ActionExecutionStatusSchema,
  type ActionReceiptView,
  ActionReceiptViewSchema,
  type ActionTargetCitation,
  ActionTargetCitationSchema,
  ActionToolInputSchema,
  type AutonomyActivityListResponse,
  AutonomyActivityListResponseSchema,
  AutonomyControlSetRequestSchema,
  type AutonomyControlView,
  AutonomyControlViewSchema,
  AutonomyHistoryQuerySchema,
  AutonomyListQuerySchema,
  AutonomyTaskListQuerySchema,
  type BuildDeadlineScheduleResponse,
  BuildDeadlineScheduleResponseSchema,
  ConversationProposalAcceptRequestSchema,
  type ConversationProposalAcceptResponse,
  ConversationProposalAcceptResponseSchema,
  ConversationProposalListQuerySchema,
  type ConversationProposalListResponse,
  ConversationProposalListResponseSchema,
  ConversationProposalRejectRequestSchema,
  type ConversationProposalRejectResponse,
  ConversationProposalRejectResponseSchema,
  type ConversationProposalView,
  ConversationProposalViewSchema,
  type CreateSessionResponse,
  CreateSessionResponseSchema,
  DeadlineScheduleViewSchema,
  EventsQuerySchema,
  type FrozenContext,
  FrozenContextSchema,
  HandoffAttemptRequestSchema,
  HandoffCreateRequestSchema,
  HandoffDispatchRequestSchema,
  HandoffListQuerySchema,
  type HandoffListResponse,
  HandoffListResponseSchema,
  HandoffReportRequestSchema,
  HandoffTransitionRequestSchema,
  HandoffVerifyRequestSchema,
  type HandoffView,
  HandoffViewSchema,
  HistoryQuerySchema,
  type HistoryResponse,
  HistoryResponseSchema,
  IDEMPOTENCY_SCOPE_AUTONOMY_CONTROL,
  IDEMPOTENCY_SCOPE_SESSIONS_CREATE,
  IdempotencyLookupQuerySchema,
  type IdempotencyLookupResponse,
  IdempotencyLookupResponseSchema,
  IdempotencyScopeSchema,
  type IngestNotificationsResponse,
  IngestNotificationsResponseSchema,
  isTerminalStatus,
  LatestEventsResponseSchema,
  type LatestRunEvent,
  type LatestRunEventType,
  LatestRunEventTypeSchema,
  LearningEvidenceAttachRequestSchema,
  LearningEvidenceListQuerySchema,
  type LearningEvidenceListResponse,
  LearningEvidenceListResponseSchema,
  type LearningEvidenceView,
  LearningEvidenceViewSchema,
  LearningHypothesisCreateRequestSchema,
  LearningHypothesisDecisionRequestSchema,
  LearningHypothesisListQuerySchema,
  type LearningHypothesisListResponse,
  LearningHypothesisListResponseSchema,
  LearningHypothesisTransitionRequestSchema,
  type LearningHypothesisView,
  LearningHypothesisViewSchema,
  LearningProposeRequestSchema,
  type M0RunEventType,
  type M2ModelErrorCode,
  M2ModelErrorCodeSchema,
  type M2ModelStepEventType,
  M2ModelStepEventTypeSchema,
  messageScope,
  type NextDeadlineResponse,
  NextDeadlineResponseSchema,
  type NotificationAckReceipt,
  NotificationAckReceiptSchema,
  type NotificationFeedCursorResponse,
  NotificationFeedCursorResponseSchema,
  type NotificationForwardPageResponse,
  NotificationForwardPageResponseSchema,
  NotificationForwardQuerySchema,
  type NotificationHistoryResponse,
  NotificationHistoryResponseSchema,
  NotificationListQuerySchema,
  type NotificationListResponse,
  NotificationListResponseSchema,
  NotificationReadQuerySchema,
  type NotificationView,
  NotificationViewSchema,
  PostMessageRequestSchema,
  type PostMessageResponse,
  PostMessageResponseSchema,
  PostRetryRequestSchema,
  type PostRetryResponse,
  type ProposalApprove202Response,
  ProposalApprove202ResponseSchema,
  ProposalApproveRequestSchema,
  type ProposalExecutionView,
  ProposalExecutionViewSchema,
  ProposalRejectRequestSchema,
  type ProposalRejectResponse,
  ProposalRejectResponseSchema,
  type ProposalSummary,
  ProposalSummarySchema,
  type ProposalsListResponse,
  ProposalsListResponseSchema,
  type PurposeConflictListResponse,
  PurposeConflictListResponseSchema,
  type PurposeConflictRecord,
  PurposeConflictRecordRequestSchema,
  PurposeConflictRecordSchema,
  PurposeCorrectRequestSchema,
  type PurposeCorrectResponse,
  PurposeCorrectResponseSchema,
  PurposeCreateRequestSchema,
  type PurposeCreateResponse,
  type PurposeHistoryResponse,
  PurposeHistoryResponseSchema,
  type PurposeListResponse,
  PurposeListResponseSchema,
  PurposeProposeRequestSchema,
  PurposeTransitionRequestSchema,
  type PurposeView,
  PurposeViewSchema,
  parseRunErrorCode,
  parseRunEvent,
  parseRunEventPayload,
  parseRunResult,
  parseTurnInput,
  proposalApproveScope,
  purposeCreateScope,
  type RecordDueDeadlinesResponse,
  RecordDueDeadlinesResponseSchema,
  type ReferenceContextGetResponse,
  ReferenceContextGetResponseSchema,
  ReferenceContextPutRequestSchema,
  type ReferenceContextPutResponse,
  ReferenceContextPutResponseSchema,
  type ReferenceDetailResponse,
  ReferenceDetailResponseSchema,
  type ReferenceListResponse,
  ReferenceListResponseSchema,
  type ReferenceSetDetailResponse,
  ReferenceSetDetailResponseSchema,
  RUN_EVENT_SCHEMA_VERSION,
  type RunMemoryStatus,
  RunMemoryStatusSchema,
  type RunResult,
  type RunStatus,
  RunStatusSchema,
  retryScope,
  SearchLimitSchema,
  ShadowExplicitRequestSchema,
  ShadowFailRequestSchema,
  ShadowHoldRequestSchema,
  type ShadowJobContext,
  ShadowJobContextSchema,
  type ShadowJobDeliberation,
  ShadowJobDeliberationSchema,
  type ShadowJobEventsResponse,
  ShadowJobEventsResponseSchema,
  type ShadowJobListResponse,
  ShadowJobListResponseSchema,
  type ShadowJobView,
  ShadowJobViewSchema,
  ShadowModelOutputSchema,
  SnapshotBodySchema,
  TaskCreateRequestSchema,
  type TaskCreateResponse,
  type TaskHistoryResponse,
  TaskHistoryResponseSchema,
  TaskHoldRequestSchema,
  type TaskListResponse,
  TaskListResponseSchema,
  TaskProposeRequestSchema,
  TaskResumeRequestSchema,
  TaskTransitionRequestSchema,
  type TaskView,
  TrialLaunchRequestSchema,
  type TrialProfileSnapshot,
  TrialProfileSnapshotSchema,
  type TrialProposalView,
  TrialProposalViewSchema,
  TrialStageRequestSchema,
  taskCreateScope,
  trialStageScope,
} from "@companion/contracts";
import type Database from "better-sqlite3";
import {
  type ActionExecutionService,
  createActionExecutionService,
} from "./action_executions.js";
import {
  type ActionProposalStager,
  type CommittedProposal,
  createActionProposalStager,
} from "./action_proposals.js";
import {
  type AuthorizeWithinPolicyOptions,
  type AutodispatchLimits,
  authorizeWithinPolicy as autodispatchAuthorize,
  createDispatchPlan as autodispatchCreatePlan,
  createStandingPolicy as autodispatchCreatePolicy,
  listDispatchExecutions as autodispatchListExecutions,
  listDispatchPlans as autodispatchListPlans,
  listStandingPolicies as autodispatchListPolicies,
  readDispatchExecution as autodispatchReadExecution,
  readIntentHistory as autodispatchReadIntentHistory,
  readDispatchMaterialization as autodispatchReadMaterialization,
  readDispatchPlan as autodispatchReadPlan,
  readStandingPolicy as autodispatchReadPolicy,
  readRunSessionId as autodispatchReadRunSessionId,
  revokeStandingPolicy as autodispatchRevokePolicy,
  type CreateStandingPolicyInput,
} from "./autodispatch.js";
import {
  type AutonomyKeyOptions,
  applyAutonomyRestartFence,
  assertOwnedPurpose,
  assertOwnedTask,
  acceptConversationProposal as autonomyAcceptProposal,
  achievePurpose as autonomyAchievePurpose,
  cancelTask as autonomyCancelTask,
  completeTask as autonomyCompleteTask,
  confirmPurpose as autonomyConfirmPurpose,
  correctPurpose as autonomyCorrectPurpose,
  createPurpose as autonomyCreatePurpose,
  createTask as autonomyCreateTask,
  getAutonomyControl as autonomyGetControl,
  getConversationProposal as autonomyGetProposal,
  getPurpose as autonomyGetPurpose,
  getTask as autonomyGetTask,
  holdTask as autonomyHoldTask,
  isPurposeApplicableAt as autonomyIsPurposeApplicableAt,
  listAutonomyActivity as autonomyListActivity,
  listConflictPairsInScope as autonomyListConflictPairsInScope,
  listPurposeConflicts as autonomyListConflicts,
  listConversationProposalEvents as autonomyListProposalEvents,
  listConversationProposals as autonomyListProposals,
  listPurposeEvents as autonomyListPurposeEvents,
  listPurposes as autonomyListPurposes,
  listPurposesFiltered as autonomyListPurposesFiltered,
  listPurposesInScope as autonomyListPurposesInScope,
  listTaskEvents as autonomyListTaskEvents,
  listTasks as autonomyListTasks,
  listTasksFiltered as autonomyListTasksFiltered,
  listTasksInScope as autonomyListTasksInScope,
  recordPurposeConflict as autonomyRecordConflict,
  rejectConversationProposal as autonomyRejectProposal,
  resumeTask as autonomyResumeTask,
  revokePurpose as autonomyRevokePurpose,
  setAutonomyControl as autonomySetControl,
  stageConversationProposal as autonomyStageProposal,
  startTask as autonomyStartTask,
  isStrictAutonomyDeadline,
  recordUserActivityInTx,
} from "./autonomy.js";
import {
  assertUuidV4,
  canonicalJsonString,
  generateId,
  IDEMPOTENCY_OPERATIONS,
  isUuidV4,
  requestHash,
  sha256Hex,
} from "./canonical.js";
import {
  DatabaseStateInvalidError,
  IdempotencyConflictError,
  InvalidReferenceError,
  KernelStorageError,
  ProposalHashMismatchError,
  ProposalStateConflictError,
  ReferenceNotFoundError,
  ReferenceVersionConflictError,
  RepositoryNotFoundError,
  RepositoryValidationError,
  SessionBusyError,
} from "./errors.js";
import {
  abnormalExitHandoff as handoffAbnormalExit,
  buildHandoffSpec as handoffBuildSpec,
  cancelHandoff as handoffCancel,
  countActiveHandoffs as handoffCountActive,
  createHandoff as handoffCreate,
  dispatchHandoff as handoffDispatch,
  failHandoff as handoffFail,
  getHandoff as handoffGet,
  listHandoffs as handoffList,
  listHandoffAttempts as handoffListAttempts,
  listHandoffEvents as handoffListEvents,
  reaffirmHandoff as handoffReaffirm,
  recordHandoffAttempt as handoffRecordAttempt,
  reportHandoff as handoffReport,
  verifyHandoff as handoffVerify,
} from "./handoff.js";
import {
  type HypothesisTransition,
  acceptStagedHypothesis as learningAcceptStaged,
  attachEvidence as learningAttachEvidence,
  createHypothesis as learningCreateHypothesis,
  getHypothesis as learningGetHypothesis,
  listHypothesisEvents as learningListEvents,
  listHypothesisEvidence as learningListEvidence,
  listHypotheses as learningListHypotheses,
  rejectStagedHypothesis as learningRejectStaged,
  stageHypothesisFromModel as learningStageFromModel,
  transitionHypothesis as learningTransition,
} from "./learning.js";
import {
  ackNotification as notifyAck,
  buildDeadlineSchedule as notifyBuildSchedule,
  getNotification as notifyGet,
  getNotificationHistory as notifyHistory,
  ingestNotifications as notifyIngest,
  getLatestNotificationCursor as notifyLatestCursor,
  listNotifications as notifyList,
  listNotificationsForward as notifyListForward,
  getNextDeadline as notifyNextDeadline,
  recordDueDeadlines as notifyRecordDue,
} from "./notifications.js";
import {
  type ShadowPolicyReader,
  type ShadowReaderPurpose,
  type ShadowReaderTask,
  cancelShadowJob as shadowCancelJob,
  claimShadowJob as shadowClaimJob,
  completeShadowJob as shadowCompleteJob,
  failShadowJob as shadowFailJob,
  getShadowJobContext as shadowGetContext,
  getShadowJobDecision as shadowGetDecision,
  getShadowJob as shadowGetJob,
  hasActiveUserRuns as shadowHasActiveRuns,
  holdShadowJob as shadowHoldJob,
  listShadowJobEvents as shadowListEvents,
  listShadowInbox as shadowListInbox,
  listShadowJobs as shadowListJobs,
  readPendingShadowJob as shadowReadPendingJob,
  requestShadowDeliberation as shadowRequest,
} from "./shadow.js";
import {
  approveTrialProposal,
  authorityDeadlineMs,
  beginTrialAdoption as beginTrialAdoptionFn,
  claimTrialGrant,
  clearAliasFence,
  expireTrialProposal,
  fenceUnknownExecution,
  finishTrialAdoption as finishTrialAdoptionFn,
  hashTrialRequest,
  issueLaunchPermit,
  listClaimedTrialWorkers,
  listQueuedTrialGrants,
  listTrialProposals,
  type QueuedTrialGrantCursor,
  readLaunchPermit,
  readQueuedTrialGrantHorizon,
  readTrialAdoption as readTrialAdoptionFn,
  readTrialCandidateRoots as readTrialCandidateRootsFn,
  readTrialIntent,
  readTrialProposal,
  readWorkerExecutionIdByProposal,
  readWorkerOutcome,
  readWorkerOutcomeByProposal,
  readWorkerReport,
  readWorkerReportByProposal,
  reconcileTrialExpiry,
  recordQuiescence,
  recordTrialAdoptionBaseSha as recordTrialAdoptionBaseShaFn,
  recordWorkerResult,
  recoverInterruptedTrialAdoptions as recoverInterruptedTrialAdoptionsFn,
  registerWorkerBoot,
  stageTrialProposal,
  type TrialWorkerReportInput,
  type TrustedObservation,
  isNeverLaunchedRevokedTrialGrant as trialGrantNeverLaunched,
} from "./trial_authority.js";

/**
 * C19: fixed safe error thrown when a generic Run lifecycle transition
 * (engine pickup, generic complete/fail) touches an `m5-action` Run. Such
 * Runs are owned exclusively by the concrete action execution service
 * (atomic terminal transactions); the engine never fails closed-through
 * them and no watchdog may destroy committed marker/receipt state.
 */
export class ActionRunDispatchRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionRunDispatchRequiredError";
  }
}

export {
  canonicalJson,
  canonicalJsonString,
  generateId,
  isUuidV4,
  requestHash,
  sha256Hex,
  uuidVersion,
} from "./canonical.js";
export {
  DatabaseStateInvalidError,
  IdempotencyConflictError,
  InvalidReferenceError,
  KernelStorageError,
  ReferenceNotFoundError,
  ReferenceVersionConflictError,
  RepositoryNotFoundError,
  RepositoryValidationError,
  SessionBusyError,
} from "./errors.js";

/* ------------------------------------------------------------------ */
/* Row views                                                           */
/* ------------------------------------------------------------------ */

export interface SessionRow {
  id: string;
  createdAt: number;
  lastActiveAt: number;
  nextTurnPosition: number;
}

export interface TurnRow {
  id: string;
  sessionId: string;
  seq: number;
  input: ReturnType<typeof parseTurnInput>;
  frozenContext: FrozenContext;
  createdAt: number;
  nextRunAttempt: number;
}

export interface RunRow {
  id: string;
  turnId: string;
  sessionId: string;
  attempt: number;
  status: RunStatus;
  strategy: string;
  result: RunResult | null;
  errorCode: string | null;
  eventSeq: number;
  selectOnSuccess: boolean;
  toolRequestsUsed: number;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  cancelRequestedAt: number | null;
  /** Per-run memory status (I01-06, metadata only); null = never recalled. */
  memoryStatus: RunMemoryStatus | null;
}

export interface StoredIdempotencyRecord {
  scope: string;
  key: string;
  requestHash: string;
  responseStatus: number;
  responseBody: unknown;
  createdAt: number;
}

export interface AcceptedResponse<T> {
  status: number;
  body: T;
  replayed: boolean;
}

/** Closed M2 model-call audit outcome (metadata only, never content). */
export type ModelCallOutcome = "completed" | "failed" | "timeout" | "cancelled";

export interface RecordModelCallOptions {
  step: number;
  adapter: string;
  model: string;
  outcome: ModelCallOutcome;
  errorCode?: M2ModelErrorCode | null;
  durationMs: number;
  /** Token counts only ({inputTokens, outputTokens}); null when unreported. */
  usage?: { inputTokens: number; outputTokens: number } | null;
  now?: number;
}

export interface ModelCallRow {
  id: string;
  runId: string;
  step: number;
  adapter: string;
  model: string;
  outcome: ModelCallOutcome;
  errorCode: M2ModelErrorCode | null;
  durationMs: number;
  usage: { inputTokens: number; outputTokens: number } | null;
  createdAt: number;
}

/** One latest model call for the monitor (metadata only). */
export interface MonitorModelCallRow {
  runId: string;
  step: number;
  model: string;
  outcome: ModelCallOutcome;
  errorCode: M2ModelErrorCode | null;
  durationMs: number;
  usage: { inputTokens: number; outputTokens: number } | null;
  createdAt: number;
}

/** 24h model-call totals for the monitor. */
export interface MonitorModelTotals {
  since: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  failures: number;
}

/** Active run counts for the monitor's live section. */
export interface MonitorRunCounts {
  running: number;
  queued: number;
  cancelRequested: number;
}

export interface EvidenceGrantRow {
  sessionId: string;
  runId: string;
  referenceId: string;
  exposure: "snippet" | "full";
  createdAt: number;
}

/** Closed conversation-memory outbox job kind (remind CLI op). */
export type MemoryJobKind =
  | "event.append"
  | "record.remember"
  | "record.feedback"
  | "maintain.distill"
  | "record.correct"
  | "record.retire"
  | "record.reactivate";

/** Closed explicit management operation kind (durable 202 ack). */
export type MemoryOperationKind =
  | "record.correct"
  | "record.retire"
  | "record.reactivate";

export interface MemoryOperationRow {
  id: string;
  kind: MemoryOperationKind;
  sessionId: string;
  runId: string;
  searchId: string | null;
  handle: string | null;
  recordId: string;
  revision: number | null;
  jobId: string;
  idempotencyKey: string;
  requestHash: string;
  status: "pending" | "acked" | "failed";
  createdAt: number;
  updatedAt: number;
}

export interface MemorySearchItemRow {
  searchId: string;
  handle: string;
  recordId: string;
  revision: number | null;
  status: string;
  snippet: string;
  createdAt: number;
}

export interface MemoryJobRow {
  id: string;
  kind: MemoryJobKind;
  sessionId: string;
  runId: string;
  turnId: string | null;
  eventId: string | null;
  scope: string;
  idempotencyKey: string;
  requestJson: string;
  status: "pending" | "acked" | "failed";
  attempts: number;
  nextDueAt: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Fixed background-maintenance operations shown in the activity view. */
export const MEMORY_MAINTENANCE_OPS = [
  "topic.backfill",
  "maintain.associate",
  "maintain.consolidate",
  "maintain.activation",
  "maintain.distill",
] as const;
export type MemoryMaintenanceOp = (typeof MEMORY_MAINTENANCE_OPS)[number];

/** Fixed numeric count keys accepted per op (never bodies or model text). */
const MEMORY_MAINTENANCE_COUNT_KEYS: Record<
  MemoryMaintenanceOp,
  readonly string[]
> = {
  "topic.backfill": [
    "pending",
    "processed",
    "assigned",
    "skipped",
    "failed",
    "degraded",
  ],
  "maintain.associate": ["remaining", "degraded"],
  "maintain.consolidate": [
    "applied",
    "written",
    "unchanged",
    "no_grounded",
    "deferred",
    "degraded",
  ],
  "maintain.activation": [
    "scored",
    "score_failed",
    "retired",
    "reactivated",
    "would_retire",
    "would_reactivate",
    "degraded",
  ],
  "maintain.distill": ["degraded"],
};

export const MEMORY_MAINTENANCE_RETENTION_ROWS = 2000;
export const MEMORY_MAINTENANCE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type MemoryMaintenanceCounts = Readonly<Record<string, number>>;

export interface MemoryMaintenanceRunInput {
  op: MemoryMaintenanceOp;
  scope: string;
  startedAt: number;
  finishedAt: number;
  ok: boolean;
  errorCode?: string | null;
  counts: MemoryMaintenanceCounts;
}

export interface MemoryMaintenanceRun {
  id: string;
  op: MemoryMaintenanceOp;
  scope: string;
  startedAt: number;
  finishedAt: number;
  ok: boolean;
  errorCode: string | null;
  counts: MemoryMaintenanceCounts;
  createdAt: number;
}

export interface MemoryMaintenanceRunListResponse {
  items: MemoryMaintenanceRun[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface MemoryMaintenanceOpWindow {
  runs: number;
  failed: number;
  counts: Record<string, number>;
}

export interface MemoryMaintenanceSummary {
  generatedAt: number;
  windows: {
    last24h: {
      runs: number;
      failed: number;
      ops: Record<MemoryMaintenanceOp, MemoryMaintenanceOpWindow>;
    };
    last7d: {
      runs: number;
      failed: number;
      ops: Record<MemoryMaintenanceOp, MemoryMaintenanceOpWindow>;
    };
  };
  latestByOp: Record<
    MemoryMaintenanceOp,
    {
      finishedAt: number;
      ok: boolean;
      errorCode: string | null;
      counts: MemoryMaintenanceCounts;
    } | null
  >;
}

export interface EnqueueMemoryJobOptions {
  turnId?: string;
  eventId?: string;
  now?: number;
}

export interface FailMemoryJobOptions {
  maxAttempts?: number;
  now?: number;
}

/** Additive recall-item provenance kind (I04; mirrors AgentMemorySnippet; 0022 adds correction). */
export type MemoryRecallItemKind =
  | "user_fact"
  | "model_inference"
  | "summary"
  | "correction";

export interface MemoryExposureInput {
  recallId: string;
  recordId: string;
  sessionId: string;
  runId: string;
  scope: string;
  citation: string;
  snippet: string;
  /** Record revision delivered at recall time (I04); undefined = unknown. */
  revision?: number;
  /** Provenance kind delivered at recall time (I04); undefined = unknown. */
  kind?: MemoryRecallItemKind;
}

export interface MemoryExposureRow {
  recallId: string;
  recordId: string;
  sessionId: string;
  runId: string;
  scope: string;
  citation: string;
  snippet: string;
  /** Delivered revision, or null when unknown/pre-I04 (immutable after insert). */
  revision: number | null;
  /** Delivered provenance kind, or null when unknown/pre-I04. */
  kind: MemoryRecallItemKind | null;
  createdAt: number;
}

export interface MemoryGrantInput {
  runId: string;
  citation: string;
  recordId: string;
  recallId: string;
  sessionId: string;
  scope: string;
}

export interface MemoryGrantRow {
  runId: string;
  citation: string;
  recordId: string;
  recallId: string;
  sessionId: string;
  scope: string;
  /** Revision pinned from the same-run exposure at grant creation (I04). */
  revision: number | null;
  createdAt: number;
}

interface RawMemoryMaintenanceRun {
  id: string;
  op: string;
  scope: string;
  started_at: number;
  finished_at: number;
  ok: number;
  error_code: string | null;
  counts_json: string;
  created_at: number;
}

interface RawMemoryJob {
  id: string;
  kind: string;
  session_id: string;
  run_id: string;
  turn_id: string | null;
  event_id: string | null;
  scope: string;
  idempotency_key: string;
  request_json: string;
  status: string;
  attempts: number;
  next_due_at: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

/* ------------------------------------------------------------------ */
/* C18 proposal decision types (§18.4).                                */
/* ------------------------------------------------------------------ */

export interface ApproveProposalOptions {
  key: string;
  now?: number;
  timeZone?: string;
}

export interface RejectProposalOptions {
  now?: number;
  timeZone?: string;
}

type DecisionConflict = {
  kind: "state_conflict";
  reason: "approved" | "rejected" | "expired";
  proposalId: string;
};
type DecisionBusy = { kind: "busy"; proposalId: string };
type DecisionOk<T> = {
  kind: "ok";
  status: number;
  body: T;
  replayed: boolean;
};

/* ------------------------------------------------------------------ */
/* Options                                                             */
/* ------------------------------------------------------------------ */

export interface CreateSessionOptions {
  key: string;
  now?: number;
}

export interface PostMessageOptions {
  key: string;
  now?: number;
  timeZone?: string;
  strategy?: string;
  selectOnSuccess?: boolean;
}

export interface PostRetryOptions {
  key: string;
  now?: number;
  strategy?: string;
  selectOnSuccess?: boolean;
}

export interface TransitionOptions {
  now?: number;
}

const ACTIVE_STATUSES_SQL = "('queued','running','cancel_requested')";

function nowMs(input?: number): number {
  const now = input ?? Date.now();
  if (!Number.isInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER) {
    throw new RepositoryValidationError(
      "now must be an integer Unix-ms timestamp",
    );
  }
  return now;
}

function parseOrValidation<T>(fn: () => T, what: string): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof KernelStorageError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new RepositoryValidationError(`${what}: ${message}`, {
      cause: error,
    });
  }
}

/**
 * Validate stored `usage_json` as token counts only. Rejects fractions,
 * negatives, non-numbers, and counts above MAX_SAFE_INTEGER (including
 * JSON-rounded values) so unsafe rows are never emitted. Token counts only;
 * no coercion, clamping, or truncation.
 */
function parseStoredModelUsage(usageJson: string): {
  inputTokens: number;
  outputTokens: number;
} {
  const parsed = parseOrValidation(
    () => JSON.parse(usageJson) as unknown,
    "stored model usage",
  );
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RepositoryValidationError("stored model usage is invalid");
  }
  const { inputTokens, outputTokens } = parsed as {
    inputTokens: unknown;
    outputTokens: unknown;
  };
  if (
    typeof inputTokens !== "number" ||
    !Number.isSafeInteger(inputTokens) ||
    inputTokens < 0 ||
    typeof outputTokens !== "number" ||
    !Number.isSafeInteger(outputTokens) ||
    outputTokens < 0
  ) {
    throw new RepositoryValidationError("stored model usage is invalid");
  }
  return { inputTokens, outputTokens };
}

function requireKey(key: unknown): string {
  if (!isUuidV4(key)) {
    throw new RepositoryValidationError("Idempotency-Key must be a UUID v4");
  }
  // Canonical form: lowercase. isUuidV4 accepts mixed case, so without this
  // the same logical key in different cases would store/lookup distinct rows.
  return key.toLowerCase();
}

function requireId(id: unknown, what: string): string {
  if (!isUuidV4(id)) {
    throw new RepositoryValidationError(`${what} must be a UUID v4`);
  }
  return id;
}

/**
 * C19: exported so the Action execution boundary service reuses the exact
 * same atomic transaction helper (same BEGIN IMMEDIATE semantics).
 */
export function withImmediate<T>(db: Database.Database, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Best effort: the original error carries the failure.
    }
    throw error;
  }
}

/** Validate fixed numeric maintenance counts (rejects text/shape drift). */
function parseMaintenanceCounts(
  op: MemoryMaintenanceOp,
  counts: unknown,
): Record<string, number> {
  if (typeof counts !== "object" || counts === null || Array.isArray(counts)) {
    throw new RepositoryValidationError("maintenance counts must be an object");
  }
  const allowed = new Set(MEMORY_MAINTENANCE_COUNT_KEYS[op]);
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(counts)) {
    if (!allowed.has(key)) {
      throw new RepositoryValidationError(
        "maintenance counts contain an unknown key",
      );
    }
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 0
    ) {
      throw new RepositoryValidationError(
        "maintenance counts must be non-negative safe integers",
      );
    }
    out[key] = value;
  }
  return out;
}

function parseMaintenanceRunRow(
  row: RawMemoryMaintenanceRun,
): MemoryMaintenanceRun {
  if (
    !MEMORY_MAINTENANCE_OPS.includes(row.op as MemoryMaintenanceOp) ||
    (row.ok !== 0 && row.ok !== 1) ||
    (row.ok === 1 && row.error_code !== null) ||
    (row.ok === 0 && row.error_code === null)
  ) {
    throw new RepositoryValidationError("stored maintenance run is invalid");
  }
  const counts = parseMaintenanceCounts(
    row.op as MemoryMaintenanceOp,
    parseOrValidation(
      () => JSON.parse(row.counts_json) as unknown,
      "stored maintenance counts",
    ),
  );
  return {
    id: row.id,
    op: row.op as MemoryMaintenanceOp,
    scope: row.scope,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    ok: row.ok === 1,
    errorCode: row.error_code,
    counts,
    createdAt: row.created_at,
  };
}

/** Opaque newest-first keyset cursor: base64url(JSON {t, id}). */
function encodeMaintenanceCursor(createdAt: number, id: string): string {
  return Buffer.from(JSON.stringify({ t: createdAt, id }), "utf8").toString(
    "base64url",
  );
}

function decodeMaintenanceCursor(cursor: string): {
  createdAt: number;
  id: string;
} {
  if (
    typeof cursor !== "string" ||
    cursor.length === 0 ||
    cursor.length > 512
  ) {
    throw new RepositoryValidationError("invalid activity cursor");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new RepositoryValidationError("invalid activity cursor");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    typeof (parsed as { t?: unknown }).t !== "number" ||
    !Number.isSafeInteger((parsed as { t: number }).t) ||
    (parsed as { t: number }).t < 0 ||
    !isUuidV4((parsed as { id?: unknown }).id)
  ) {
    throw new RepositoryValidationError("invalid activity cursor");
  }
  return {
    createdAt: (parsed as { t: number }).t,
    id: (parsed as { id: string }).id,
  };
}

function isBusyConstraint(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT";
}

function readSession(
  db: Database.Database,
  sessionId: string,
): SessionRow | null {
  const row = db
    .prepare(
      "SELECT id, created_at, last_active_at, next_turn_position FROM sessions WHERE id = ?",
    )
    .get(sessionId) as
    | {
        id: string;
        created_at: number;
        last_active_at: number;
        next_turn_position: number;
      }
    | undefined;
  if (row === undefined) {
    return null;
  }
  return {
    id: row.id,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
    nextTurnPosition: row.next_turn_position,
  };
}

interface RawTurn {
  id: string;
  session_id: string;
  seq: number;
  input_json: string;
  frozen_context: string;
  created_at: number;
  next_run_attempt: number;
}

function parseTurnRow(row: RawTurn): TurnRow {
  const input = parseOrValidation(
    () => parseTurnInput(JSON.parse(row.input_json)),
    "turn input_json",
  );
  const frozenContext = parseOrValidation(
    () => FrozenContextSchema.parse(JSON.parse(row.frozen_context)),
    "turn frozen_context",
  );
  return {
    id: row.id,
    sessionId: row.session_id,
    seq: row.seq,
    input,
    frozenContext,
    createdAt: row.created_at,
    nextRunAttempt: row.next_run_attempt,
  };
}

interface RawRun {
  id: string;
  turn_id: string;
  session_id: string;
  attempt: number;
  status: string;
  strategy: string;
  result_json: string | null;
  error_code: string | null;
  event_seq: number;
  select_on_success: number;
  tool_requests_used: number;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  cancel_requested_at: number | null;
  memory_status: string | null;
}

function parseRunRow(row: RawRun): RunRow {
  const result =
    row.result_json === null
      ? null
      : parseOrValidation(
          () => parseRunResult(JSON.parse(row.result_json as string)),
          "run result_json",
        );
  // `SELECT *` on a pre-0020 store (older migration target) yields no
  // memory_status key at all: undefined counts as absent/null here too.
  const memoryStatus =
    row.memory_status === null || row.memory_status === undefined
      ? null
      : parseOrValidation(
          () => RunMemoryStatusSchema.parse(row.memory_status),
          "run memory_status",
        );
  return {
    id: row.id,
    turnId: row.turn_id,
    sessionId: row.session_id,
    attempt: row.attempt,
    status: row.status as RunStatus,
    strategy: row.strategy,
    result,
    errorCode: row.error_code,
    eventSeq: row.event_seq,
    selectOnSuccess: row.select_on_success === 1,
    toolRequestsUsed: row.tool_requests_used,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    cancelRequestedAt: row.cancel_requested_at,
    memoryStatus,
  };
}

function readRun(db: Database.Database, runId: string): RawRun | null {
  return (
    (db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as
      | RawRun
      | undefined) ?? null
  );
}

/**
 * C19: exported for the concrete Action execution boundary service
 * (`action_executions.ts`), which is in-repo-only. The shared signature and
 * SEMANTICS keep a single guarded event allocator across domain modules.
 */
export type RunEventAppender = (
  db: Database.Database,
  runId: string,
  expectedPrevSeq: number,
  type: M0RunEventType | LatestRunEventType,
  payload: unknown,
  now: number,
) => number;

export const appendEventInTx: RunEventAppender = function appendEventInTx(
  db: Database.Database,
  runId: string,
  expectedPrevSeq: number,
  type: M0RunEventType | LatestRunEventType,
  payload: unknown,
  now: number,
): number {
  // Latest (M1) registry: exact M0 nine plus `reference.presented`.
  // M0 callers keep passing M0 types unchanged; they validate here too.
  const validType = parseOrValidation(
    () => LatestRunEventTypeSchema.parse(type),
    "run event type",
  );
  const validPayload = parseOrValidation(
    () => parseRunEventPayload(validType, payload),
    `run event payload for ${validType}`,
  );
  const next = expectedPrevSeq + 1;
  // Guarded atomic increment: caller cannot assign an arbitrary next seq.
  // The UPDATE + INSERT commit in the caller's transaction; a stale
  // expectedPrevSeq (or a concurrent bump) rolls the whole transition back.
  const moved = db
    .prepare("UPDATE runs SET event_seq = ? WHERE id = ? AND event_seq = ?")
    .run(next, runId, expectedPrevSeq);
  if (moved.changes !== 1) {
    throw new KernelStorageError(
      "kernel_concurrent_conflict",
      "concurrent event append conflict; retry the transition",
    );
  }
  db.prepare(
    "INSERT INTO run_events (run_id, seq, schema_version, type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    runId,
    next,
    RUN_EVENT_SCHEMA_VERSION,
    validType,
    JSON.stringify(validPayload),
    now,
  );
  return next;
};

function toStoredResponse(
  db: Database.Database,
  scope: string,
  key: string,
): StoredIdempotencyRecord | null {
  const row = db
    .prepare(
      "SELECT scope, key, request_hash, response_status, response_body, created_at FROM api_idempotency WHERE scope = ? AND key = ?",
    )
    .get(scope, key) as
    | {
        scope: string;
        key: string;
        request_hash: string;
        response_status: number;
        response_body: string;
        created_at: number;
      }
    | undefined;
  if (row === undefined) {
    return null;
  }
  return {
    scope: row.scope,
    key: row.key,
    requestHash: row.request_hash,
    responseStatus: row.response_status,
    responseBody: parseOrValidation(
      () => JSON.parse(row.response_body),
      "stored idempotency body",
    ),
    createdAt: row.created_at,
  };
}

function storeIdempotentResponse(
  db: Database.Database,
  scope: string,
  key: string,
  hash: string,
  status: number,
  body: unknown,
  now: number,
): void {
  db.prepare(
    "INSERT INTO api_idempotency (scope, key, request_hash, response_status, response_body, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(scope, key, hash, status, JSON.stringify(body), now);
}

/**
 * AV autonomy activity gate: `autonomy_activity` exists only on schema
 * version >= 11 (migration 0011). Pre-11 databases (legit old migration
 * fixtures at versions <= 10) skip the activity write so normal chat keeps
 * working; on version >= 11 the write is mandatory and any failure (e.g. a
 * corrupt DB with the table dropped) propagates unmasked. Explicit
 * `user_version` check only — never a broad catch, never a message-text
 * match on `no such table`.
 */
function shouldRecordAutonomyActivity(db: Database.Database): boolean {
  const version = Number(db.pragma("user_version", { simple: true }));
  return Number.isInteger(version) && version >= 11;
}

/* ------------------------------------------------------------------ */
/* Repository                                                          */
/* ------------------------------------------------------------------ */

/**
 * C17 composition options. `actionProposals.writeEnabled` is an EXPLICIT
 * opt-in (never derived from any mutable state); the stager is created and
 * owned by this repository instance so the broker/agent path, the completeRun
 * commit hook, and the terminal cleanup share ONE staged map per process.
 * `clock` is deterministic-test only.
 */
export interface CreateKernelRepositoryOptions {
  readonly actionProposals?: {
    readonly writeEnabled?: boolean;
    /**
     * M6 create gate (default FALSE, never implied by `writeEnabled`):
     * `calendar.create` staging/commits require this explicit opt-in.
     */
    readonly createEnabled?: boolean;
    readonly clock?: () => number;
  };
}

export function createKernelRepository(
  db: Database.Database,
  options: CreateKernelRepositoryOptions = {},
) {
  // C17: repository-OWNED proposal stager (single shared instance). The
  // repository supplies the action.proposed `appendEventInTx` sink, so the
  // stager's commits address the exact same events/journal as every other
  // RunEvent append (same CAS conflict semantics). `writeEnabled` defaults
  // to FALSE: proposal staging is an explicit composition opt-in.
  const stager: ActionProposalStager | undefined =
    options.actionProposals === undefined
      ? undefined
      : createActionProposalStager({
          db,
          writeEnabled: options.actionProposals.writeEnabled === true,
          createEnabled: options.actionProposals.createEnabled === true,
          ...(options.actionProposals.clock === undefined
            ? {}
            : { clock: options.actionProposals.clock }),
          events: {
            appendEventTx(runId, expectedPrevSeq, type, payload, now) {
              return appendEventInTx(
                db,
                runId,
                expectedPrevSeq,
                type,
                payload,
                now,
              );
            },
          },
        });

  /**
   * C21: lazily composed Action execution service. It owns the `m5-action`
   * cancel boundary and the `m5-action` recovery/drain disposition. It shares
   * THIS repository's single connection, so it opens its own
   * `BEGIN IMMEDIATE` with the exact same CAS/event primitives.
   */
  let cancelBoundary: ActionExecutionService | null = null;
  const actionCancelService = (): ActionExecutionService => {
    cancelBoundary ??= createActionExecutionService({ db });
    return cancelBoundary;
  };

  /**
   * Terminal cleanup is NOT part of the commit hook: apply only after the
   * OUTER transaction of a terminal transition has committed successfully,
   * so a rollback never loses a staged entry that a retry may still commit.
   */
  const clearStagedAfterTerminalCommit = (runId: string): void => {
    if (stager !== undefined) {
      stager.removeStaged(runId);
    }
  };

  function getSession(sessionId: string): SessionRow {
    const id = requireId(sessionId, "sessionId");
    const row = readSession(db, id);
    if (row === null) {
      throw new RepositoryNotFoundError(`session ${id} not found`);
    }
    return row;
  }

  function getTurn(turnId: string): TurnRow {
    const id = requireId(turnId, "turnId");
    const row = db.prepare("SELECT * FROM turns WHERE id = ?").get(id) as
      | RawTurn
      | undefined;
    if (row === undefined) {
      throw new RepositoryNotFoundError(`turn ${id} not found`);
    }
    return parseTurnRow(row);
  }

  function getRun(runId: string): RunRow {
    const id = requireId(runId, "runId");
    const row = readRun(db, id);
    if (row === null) {
      throw new RepositoryNotFoundError(`run ${id} not found`);
    }
    return parseRunRow(row);
  }

  function requireOwnedRun(sessionId: string, runId: string): RawRun {
    const session = requireId(sessionId, "sessionId");
    const run = requireId(runId, "runId");
    const row = readRun(db, run);
    if (row === null || row.session_id !== session) {
      throw new RepositoryNotFoundError(
        `run ${run} not found in session ${session}`,
      );
    }
    return row;
  }

  function requireOwnedTurn(sessionId: string, turnId: string): RawTurn {
    const session = requireId(sessionId, "sessionId");
    const turn = requireId(turnId, "turnId");
    const row = db.prepare("SELECT * FROM turns WHERE id = ?").get(turn) as
      | RawTurn
      | undefined;
    if (row === undefined || row.session_id !== session) {
      throw new RepositoryNotFoundError(
        `turn ${turn} not found in session ${session}`,
      );
    }
    return row;
  }

  function requireOwnedTrialProposal(
    sessionId: string,
    proposalId: string,
  ): void {
    const session = requireId(sessionId, "sessionId");
    const proposal = requireId(proposalId, "proposalId");
    const row = db
      .prepare("SELECT session_id FROM trial_proposals WHERE id = ?")
      .get(proposal) as { session_id: string } | undefined;
    if (row === undefined || row.session_id !== session) {
      throw new RepositoryNotFoundError(
        `proposal ${proposal} not found in session ${session}`,
      );
    }
  }

  function requireOwnedTrialGrant(
    sessionId: string,
    executionId: string,
  ): void {
    const session = requireId(sessionId, "sessionId");
    const execution = requireId(executionId, "executionId");
    const row = db
      .prepare("SELECT session_id FROM trial_grants WHERE execution_id = ?")
      .get(execution) as { session_id: string } | undefined;
    if (row === undefined || row.session_id !== session) {
      throw new RepositoryNotFoundError(
        `grant ${execution} not found in session ${session}`,
      );
    }
  }

  function requireOwnedProposal(
    sessionId: string,
    proposalId: string,
  ): {
    id: string;
    session_id: string;
  } {
    const session = requireId(sessionId, "sessionId");
    const proposal = requireId(proposalId, "proposalId");
    const row = loadProposal(proposal);
    if (row === null || row.session_id !== session) {
      throw new RepositoryNotFoundError(
        `proposal ${proposal} not found in session ${session}`,
      );
    }
    return row;
  }

  function createSession(
    options: CreateSessionOptions,
  ): AcceptedResponse<CreateSessionResponse> {
    const key = requireKey(options.key);
    const now = nowMs(options.now);
    const scope = IDEMPOTENCY_SCOPE_SESSIONS_CREATE;
    const hash = requestHash(
      IDEMPOTENCY_OPERATIONS.createSession.operation,
      IDEMPOTENCY_OPERATIONS.createSession.schemaVersion,
      {},
    );
    return withImmediate(db, () => {
      const existing = toStoredResponse(db, scope, key);
      if (existing !== null) {
        if (existing.requestHash !== hash) {
          throw new IdempotencyConflictError(scope);
        }
        const body = parseOrValidation(
          () => CreateSessionResponseSchema.parse(existing.responseBody),
          "stored create-session body",
        );
        return { status: existing.responseStatus, body, replayed: true };
      }
      const id = generateId();
      db.prepare(
        "INSERT INTO sessions (id, created_at, last_active_at, next_turn_position) VALUES (?, ?, ?, 1)",
      ).run(id, now, now);
      // M1: every session owns exactly one versioned reference context,
      // initialized to `version = 1, items = []` in the same transaction.
      db.prepare(
        "INSERT INTO session_reference_context (session_id, version, items_json, updated_at) VALUES (?, 1, '[]', ?)",
      ).run(id, now);
      const body = parseOrValidation(
        () =>
          CreateSessionResponseSchema.parse({ sessionId: id, createdAt: now }),
        "create-session response",
      );
      storeIdempotentResponse(db, scope, key, hash, 201, body, now);
      return { status: 201, body, replayed: false };
    });
  }

  function postMessage(
    sessionId: string,
    request: { text: string; uiContext?: Record<string, unknown> },
    options: PostMessageOptions,
  ): AcceptedResponse<PostMessageResponse> {
    const session = requireId(sessionId, "sessionId");
    const key = requireKey(options.key);
    const now = nowMs(options.now);
    const parsed = parseOrValidation(
      () =>
        PostMessageRequestSchema.parse({
          text: request.text,
          uiContext: request.uiContext ?? {},
        }),
      "post-message request",
    );
    const strategy =
      options.strategy === undefined ? "m0-default" : options.strategy;
    if (strategy.length === 0 || strategy.length > 128) {
      throw new RepositoryValidationError("strategy must be 1..128 chars");
    }
    const selectOnSuccess = options.selectOnSuccess ?? true;
    const timeZone = options.timeZone ?? "UTC";
    const turnInput = parseOrValidation(
      () =>
        parseTurnInput({ kind: "user_text", version: 1, text: parsed.text }),
      "post-message turn input",
    );
    const scope = messageScope(session);
    parseOrValidation(
      () => IdempotencyScopeSchema.parse(scope),
      "message scope",
    );
    // Idempotency hash covers every normalized operation-affecting field:
    // text/uiContext plus the strategy, selectOnSuccess, and timeZone values
    // that alter the persisted turn/run rows. Zod-defaulted canonical JSON
    // with operation/version domain separation (via requestHash).
    const hash = requestHash(
      IDEMPOTENCY_OPERATIONS.postMessage.operation,
      IDEMPOTENCY_OPERATIONS.postMessage.schemaVersion,
      {
        text: parsed.text,
        uiContext: parsed.uiContext,
        strategy,
        selectOnSuccess,
        timeZone: options.timeZone ?? "UTC",
      },
    );
    return withImmediate(db, () => {
      const existing = toStoredResponse(db, scope, key);
      if (existing !== null) {
        if (existing.requestHash !== hash) {
          throw new IdempotencyConflictError(scope);
        }
        const body = parseOrValidation(
          () => PostMessageResponseSchema.parse(existing.responseBody),
          "stored post-message body",
        );
        return { status: existing.responseStatus, body, replayed: true };
      }
      const sessionRow = readSession(db, session);
      if (sessionRow === null) {
        throw new RepositoryNotFoundError(`session ${session} not found`);
      }
      // M1: freeze the current ordered reference context into the new Turn.
      // Retry reuses the original Turn row unchanged (no refreeze).
      // Fail closed: createSession + 0002 backfill guarantee the row.
      const contextRow = db
        .prepare(
          "SELECT version, items_json FROM session_reference_context WHERE session_id = ?",
        )
        .get(session) as { version: number; items_json: string } | undefined;
      if (contextRow === undefined) {
        throw new DatabaseStateInvalidError(
          `reference context missing for session ${session}`,
        );
      }
      const frozenItems = parseOrValidation(
        () =>
          ReferenceContextGetResponseSchema.parse({
            version: contextRow.version,
            items: JSON.parse(contextRow.items_json),
          }),
        "session reference context",
      );
      const frozen = parseOrValidation(
        () =>
          FrozenContextSchema.parse({
            version: 1,
            temporal: { now, timeZone },
            uiContext: parsed.uiContext,
            referenceContext: {
              version: frozenItems.version,
              items: frozenItems.items,
            },
          }),
        "post-message frozen context",
      );
      const seq = sessionRow.nextTurnPosition;
      const turnId = generateId();
      const runId = generateId();
      try {
        db.prepare(
          "INSERT INTO turns (id, session_id, seq, input_json, frozen_context, created_at, next_run_attempt) VALUES (?, ?, ?, ?, ?, ?, 2)",
        ).run(
          turnId,
          session,
          seq,
          JSON.stringify(turnInput),
          JSON.stringify(frozen),
          now,
        );
        db.prepare(
          `INSERT INTO runs (id, turn_id, session_id, attempt, status, strategy,
            result_json, error_code, event_seq, select_on_success,
            tool_requests_used, created_at, started_at, finished_at, cancel_requested_at)
           VALUES (?, ?, ?, 1, 'queued', ?, NULL, NULL, 0, ?, 0, ?, NULL, NULL, NULL)`,
        ).run(runId, turnId, session, strategy, selectOnSuccess ? 1 : 0, now);
        // Creation starts from an event_seq 0 row; the guarded append
        // atomically produces the persisted run.queued seq 1.
        appendEventInTx(db, runId, 0, "run.queued", { attempt: 1 }, now);
        const moved = db
          .prepare(
            "UPDATE sessions SET next_turn_position = ?, last_active_at = ? WHERE id = ? AND next_turn_position = ?",
          )
          .run(seq + 1, now, session, seq);
        if (moved.changes !== 1) {
          throw new RepositoryValidationError(
            "concurrent turn allocation conflict",
          );
        }
      } catch (error) {
        if (error instanceof KernelStorageError) {
          throw error;
        }
        if (isBusyConstraint(error)) {
          throw new SessionBusyError(session);
        }
        throw error;
      }
      const accepted: AcceptedRun = { id: runId, attempt: 1, status: "queued" };
      const body = parseOrValidation(
        () =>
          PostMessageResponseSchema.parse({
            sessionId: session,
            turnId,
            run: accepted,
          }),
        "post-message response",
      );
      // AV autonomy: accepted (non-replayed) user activity is recorded in
      // the SAME transaction. Replayed/rejected requests never reach here.
      // Pre-11 databases skip the write (table absent by construction);
      // version >= 11 failures propagate unmasked (never swallowed).
      if (shouldRecordAutonomyActivity(db)) {
        recordUserActivityInTx(db, session, now);
      }
      storeIdempotentResponse(db, scope, key, hash, 202, body, now);
      return { status: 202, body, replayed: false };
    });
  }

  function postRetry(
    sessionId: string,
    turnId: string,
    options: PostRetryOptions,
  ): AcceptedResponse<PostRetryResponse> {
    const session = requireId(sessionId, "sessionId");
    const turn = requireId(turnId, "turnId");
    const key = requireKey(options.key);
    const now = nowMs(options.now);
    parseOrValidation(
      () => PostRetryRequestSchema.parse({}),
      "post-retry request",
    );
    const strategy =
      options.strategy === undefined ? "m0-default" : options.strategy;
    if (strategy.length === 0 || strategy.length > 128) {
      throw new RepositoryValidationError("strategy must be 1..128 chars");
    }
    const selectOnSuccess = options.selectOnSuccess ?? true;
    const scope = retryScope(turn);
    parseOrValidation(() => IdempotencyScopeSchema.parse(scope), "retry scope");
    // Retry hash includes the normalized strategy/selectOnSuccess inputs
    // that alter the persisted run row (retry reuses immutable turn input).
    const hash = requestHash(
      IDEMPOTENCY_OPERATIONS.postRetry.operation,
      IDEMPOTENCY_OPERATIONS.postRetry.schemaVersion,
      { sessionId: session, turnId: turn, strategy, selectOnSuccess },
    );
    return withImmediate(db, () => {
      // Ownership first: session/turn binding is verified BEFORE any
      // idempotency lookup so a foreign key can never replay (or probe)
      // another session's stored response.
      if (readSession(db, session) === null) {
        throw new RepositoryNotFoundError(`session ${session} not found`);
      }
      const ownedTurnRow = db
        .prepare("SELECT * FROM turns WHERE id = ?")
        .get(turn) as RawTurn | undefined;
      if (ownedTurnRow === undefined || ownedTurnRow.session_id !== session) {
        throw new RepositoryNotFoundError(
          `turn ${turn} not found in session ${session}`,
        );
      }
      const turnRow = ownedTurnRow;
      // M5 decision-turn retry denial (§18.4/§18.6): the generic generation
      // retry is user_text-only. A rejection Turn owns no Run and an
      // approval Turn owns its Action Run; re-running either through this
      // path could duplicate or fabricate an external write, so both are
      // rejected BEFORE any idempotency lookup (no replay of a stored
      // success), allocator CAS, Run/event insert, or grant side effect.
      const turnInput = parseOrValidation(
        () => parseTurnInput(JSON.parse(turnRow.input_json)),
        "retry turn input_json",
      );
      if (turnInput.kind !== "user_text") {
        throw new RepositoryValidationError(
          "retry is only available for user_text turns",
        );
      }
      parseOrValidation(
        () => FrozenContextSchema.parse(JSON.parse(turnRow.frozen_context)),
        "retry turn frozen_context",
      );
      const existing = toStoredResponse(db, scope, key);
      if (existing !== null) {
        if (existing.requestHash !== hash) {
          throw new IdempotencyConflictError(scope);
        }
        const body = parseOrValidation(
          () => PostMessageResponseSchema.parse(existing.responseBody),
          "stored post-retry body",
        );
        if (body.sessionId !== session || body.turnId !== turn) {
          throw new IdempotencyConflictError(scope);
        }
        return { status: existing.responseStatus, body, replayed: true };
      }
      const busy = db
        .prepare(
          `SELECT id FROM runs WHERE session_id = ? AND status IN ${ACTIVE_STATUSES_SQL} LIMIT 1`,
        )
        .get(session) as { id: string } | undefined;
      if (busy !== undefined) {
        throw new SessionBusyError(session);
      }
      const attempt = turnRow.next_run_attempt;
      const moved = db
        .prepare(
          "UPDATE turns SET next_run_attempt = ? WHERE id = ? AND next_run_attempt = ?",
        )
        .run(attempt + 1, turn, attempt);
      if (moved.changes !== 1) {
        throw new RepositoryValidationError(
          "concurrent run-attempt allocation conflict",
        );
      }
      const runId = generateId();
      try {
        db.prepare(
          `INSERT INTO runs (id, turn_id, session_id, attempt, status, strategy,
            result_json, error_code, event_seq, select_on_success,
            tool_requests_used, created_at, started_at, finished_at, cancel_requested_at)
           VALUES (?, ?, ?, ?, 'queued', ?, NULL, NULL, 0, ?, 0, ?, NULL, NULL, NULL)`,
        ).run(
          runId,
          turn,
          session,
          attempt,
          strategy,
          selectOnSuccess ? 1 : 0,
          now,
        );
        appendEventInTx(db, runId, 0, "run.queued", { attempt }, now);
        db.prepare("UPDATE sessions SET last_active_at = ? WHERE id = ?").run(
          now,
          session,
        );
      } catch (error) {
        if (error instanceof KernelStorageError) {
          throw error;
        }
        if (isBusyConstraint(error)) {
          throw new SessionBusyError(session);
        }
        throw error;
      }
      const accepted: AcceptedRun = { id: runId, attempt, status: "queued" };
      const body = parseOrValidation(
        () =>
          PostMessageResponseSchema.parse({
            sessionId: session,
            turnId: turn,
            run: accepted,
          }),
        "post-retry response",
      );
      // AV autonomy: accepted (non-replayed) user activity is recorded in
      // the SAME transaction. Same pre-11 skip / >= 11 fail-loud rule as
      // postMessage (explicit user_version gate, never a broad catch).
      if (shouldRecordAutonomyActivity(db)) {
        recordUserActivityInTx(db, session, now);
      }
      storeIdempotentResponse(db, scope, key, hash, 202, body, now);
      return { status: 202, body, replayed: false };
    });
  }

  function startRun(
    runId: string,
    options: TransitionOptions = {},
  ): { applied: boolean; run: RunRow } {
    const id = requireId(runId, "runId");
    const now = nowMs(options.now);
    // C23: an `m5-action` Run is dispatched to the SAME concrete
    // ActionExecutionService that the strategy itself uses, so the generic
    // scheduler pickup performs the REAL atomic pickup instead of throwing
    // (which the engine's pump swallowed, leaving every approved Action
    // queued forever). `startActionRun` moves the queued Run `-> running` AND
    // the queued ActionExecution `-> preflight` and appends `run.started` +
    // `action.preflight_started` in ONE transaction on this same connection.
    // No `ReferenceManager` is needed for pickup, so the repository-owned
    // lazy singleton (the cancel/recovery boundary) is reused as-is: one
    // lifecycle owner, no cyclic import, no second state owner. The generic
    // `{ applied, run }` result shape is preserved exactly. Terminalization
    // still stays exclusively in the action service: completeRun/failRun
    // below keep rejecting Action Runs outright.
    const preflightRow = readRun(db, id);
    if (preflightRow === null) {
      throw new RepositoryNotFoundError(`run ${id} not found`);
    }
    if (preflightRow.strategy === "m5-action") {
      const pickup = actionCancelService().startActionRun(id, { now });
      const picked = readRun(db, id);
      if (picked === null) {
        throw new RepositoryNotFoundError(`run ${id} not found`);
      }
      return { applied: pickup.applied, run: parseRunRow(picked) };
    }
    return withImmediate(db, () => {
      const row = readRun(db, id);
      if (row === null) {
        throw new RepositoryNotFoundError(`run ${id} not found`);
      }
      if (row.status !== "queued") {
        return { applied: false, run: parseRunRow(row) };
      }
      const moved = db
        .prepare(
          "UPDATE runs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'",
        )
        .run(now, id);
      if (moved.changes !== 1) {
        const current = readRun(db, id);
        if (current === null) {
          throw new RepositoryNotFoundError(`run ${id} not found`);
        }
        return { applied: false, run: parseRunRow(current) };
      }
      appendEventInTx(
        db,
        id,
        row.event_seq,
        "run.started",
        { attempt: row.attempt },
        now,
      );
      const current = readRun(db, id);
      if (current === null) {
        throw new RepositoryNotFoundError(`run ${id} not found`);
      }
      return { applied: true, run: parseRunRow(current) };
    });
  }

  function completeRun(
    runId: string,
    result: unknown,
    options: TransitionOptions = {},
  ): { applied: boolean; run: RunRow } {
    const id = requireId(runId, "runId");
    const now = nowMs(options.now);
    const valid = parseOrValidation(() => parseRunResult(result), "run result");
    // C17: a staged proposal is committed INSIDE the same successful CAS
    // transaction, BEFORE the terminal transition/event. commitStaged never
    // persists on its own: any failure throws out of withImmediate and rolls
    // back the whole completion, preserving the staged entry until a retry
    // (or a failure/cancel cleaning it) — clear only after the outer commit.
    let committedProposal: CommittedProposal | null = null;
    const outcome = withImmediate(db, () => {
      const row = readRun(db, id);
      if (row === null) {
        throw new RepositoryNotFoundError(`run ${id} not found`);
      }
      // C19: never generic-complete an Action Run — already terminalized
      // action state is computed and committed atomically by the action
      // execution service (receipt + events + Run terminal together), and
      // any generic overwrite could contradict a committed marker.
      if (row.strategy === "m5-action") {
        throw new ActionRunDispatchRequiredError(
          `m5-action run ${id} is terminally owned by the action execution service`,
        );
      }
      // Cancel-first: only status='running' may complete. cancel_requested
      // (even within grace) and terminal states discard the result with no
      // event append and no selection change.
      if (row.status !== "running") {
        return { applied: false, run: parseRunRow(row) };
      }
      if (stager !== undefined && stager.getStaged(id) !== null) {
        committedProposal = stager.commitStaged(id, now);
      }
      const moved = db
        .prepare(
          "UPDATE runs SET status = 'completed', result_json = ?, finished_at = ? WHERE id = ? AND status = 'running'",
        )
        .run(JSON.stringify(valid), now, id);
      if (moved.changes !== 1) {
        // Fail CLOSED: a concurrent CAS loss must never leave the appended
        // action.proposed event persisted while the run stays running.
        throw new KernelStorageError(
          "kernel_concurrent_conflict",
          "concurrent completion conflict; retry the transition",
        );
      }
      appendEventInTx(
        db,
        id,
        committedProposal === null ? row.event_seq : committedProposal.eventSeq,
        "run.completed",
        { result: valid },
        now,
      );
      if (row.select_on_success === 1) {
        const selected = db
          .prepare("SELECT status FROM runs WHERE id = ?")
          .get(id) as { status: string } | undefined;
        if (selected?.status === "completed") {
          db.prepare(
            "INSERT INTO turn_selections (turn_id, run_id, selected_at) VALUES (?, ?, ?) ON CONFLICT(turn_id) DO UPDATE SET run_id = excluded.run_id, selected_at = excluded.selected_at",
          ).run(row.turn_id, id, now);
        }
      }
      const current = readRun(db, id);
      if (current === null) {
        throw new RepositoryNotFoundError(`run ${id} not found`);
      }
      return { applied: true, run: parseRunRow(current) };
    });
    // Post-COMMIT only: clear the acknowledged staged entry exactly when the
    // proposal transaction committed. Nothing is cleared on failure paths.
    if (outcome.applied && committedProposal !== null) {
      clearStagedAfterTerminalCommit(id);
    }
    committedProposal = null;
    return outcome;
  }

  function failRun(
    runId: string,
    errorCode: unknown,
    options: TransitionOptions = {},
  ): { applied: boolean; run: RunRow } {
    const id = requireId(runId, "runId");
    const now = nowMs(options.now);
    // Never persist raw error strings: fixed snake_case code only.
    const code = parseOrValidation(
      () => parseRunErrorCode(errorCode),
      "run error_code",
    );
    const outcome = withImmediate(db, () => {
      const row = readRun(db, id);
      if (row === null) {
        throw new RepositoryNotFoundError(`run ${id} not found`);
      }
      // C19: an Action Run is never generic-failed. Its lifecycle is owned
      // by the action execution service (atomic preflight/terminal
      // transactions); the generic watchdog/abandon path must never destroy
      // marker or receipt state.
      if (row.strategy === "m5-action") {
        throw new ActionRunDispatchRequiredError(
          `m5-action run ${id} is terminally owned by the action execution service`,
        );
      }
      if (row.status !== "running") {
        return { applied: false, run: parseRunRow(row) };
      }
      const moved = db
        .prepare(
          "UPDATE runs SET status = 'failed', error_code = ?, finished_at = ? WHERE id = ? AND status = 'running'",
        )
        .run(code, now, id);
      if (moved.changes !== 1) {
        const current = readRun(db, id);
        if (current === null) {
          throw new RepositoryNotFoundError(`run ${id} not found`);
        }
        return { applied: false, run: parseRunRow(current) };
      }
      appendEventInTx(
        db,
        id,
        row.event_seq,
        "run.failed",
        { errorCode: code },
        now,
      );
      const current = readRun(db, id);
      if (current === null) {
        throw new RepositoryNotFoundError(`run ${id} not found`);
      }
      return { applied: true, run: parseRunRow(current) };
    });
    // A failed run's staged proposal is dead: clean immediately (leak-free).
    if (outcome.applied) {
      clearStagedAfterTerminalCommit(id);
    }
    return outcome;
  }

  function cancelRun(
    sessionId: string,
    runId: string,
    options: TransitionOptions = {},
  ): { status: string; run: RunRow } {
    const now = nowMs(options.now);
    // C21 dispatch: an `m5-action` Run NEVER uses the generic cancel path.
    // The concrete action execution service owns its cancellation boundary:
    // ownership-first 404, terminal runs return their ACTUAL status unchanged,
    // a committed `external_call_started_at` marker is a fixed
    // `action_not_cancellable` 409 with ZERO writes, and only a queued /
    // unmarkered-preflight run cancels atomically (grant left unconsumed, no
    // external call). Dispatched OUTSIDE any transaction — the service opens
    // its own single `BEGIN IMMEDIATE`.
    const session = requireId(sessionId, "sessionId");
    const dispatchId = requireId(runId, "runId");
    const dispatchRow = readRun(db, dispatchId);
    if (dispatchRow !== null && dispatchRow.strategy === "m5-action") {
      const outcome = actionCancelService().cancelActionRun(
        session,
        dispatchId,
        now,
      );
      return { status: outcome.runStatus, run: getRun(dispatchId) };
    }
    const outcome = withImmediate(db, () => {
      const row = requireOwnedRun(sessionId, runId);
      if (isTerminalStatus(row.status as RunStatus)) {
        return { status: row.status, run: parseRunRow(row) };
      }
      if (row.status === "queued") {
        // Queued cancel goes directly to cancelled (never via cancel_requested).
        const moved = db
          .prepare(
            "UPDATE runs SET status = 'cancelled', cancel_requested_at = ?, finished_at = ? WHERE id = ? AND status = 'queued'",
          )
          .run(now, now, row.id);
        if (moved.changes !== 1) {
          const current = readRun(db, row.id);
          if (current === null) {
            throw new RepositoryNotFoundError(`run ${row.id} not found`);
          }
          return { status: current.status, run: parseRunRow(current) };
        }
        appendEventInTx(db, row.id, row.event_seq, "run.cancelled", {}, now);
        const current = readRun(db, row.id);
        if (current === null) {
          throw new RepositoryNotFoundError(`run ${row.id} not found`);
        }
        return { status: "cancelled", run: parseRunRow(current) };
      }
      if (row.status === "running") {
        // Running cancel commits cancel_requested before any caller abort.
        const moved = db
          .prepare(
            "UPDATE runs SET status = 'cancel_requested', cancel_requested_at = ? WHERE id = ? AND status = 'running'",
          )
          .run(now, row.id);
        if (moved.changes !== 1) {
          const current = readRun(db, row.id);
          if (current === null) {
            throw new RepositoryNotFoundError(`run ${row.id} not found`);
          }
          return { status: current.status, run: parseRunRow(current) };
        }
        appendEventInTx(
          db,
          row.id,
          row.event_seq,
          "run.cancel_requested",
          {},
          now,
        );
        const current = readRun(db, row.id);
        if (current === null) {
          throw new RepositoryNotFoundError(`run ${row.id} not found`);
        }
        return { status: "cancel_requested", run: parseRunRow(current) };
      }
      // cancel_requested is state-idempotent: return current state, no new event.
      return { status: row.status, run: parseRunRow(row) };
    });
    // Cancellation kills any staged proposal, including the cancel_requested
    // intermediate (the run can never complete a proposal afterwards).
    if (
      outcome.status === "cancelled" ||
      outcome.status === "cancel_requested"
    ) {
      clearStagedAfterTerminalCommit(runId);
    }
    return outcome;
  }

  function finalizeCancelRequested(
    runId: string,
    options: TransitionOptions = {},
  ): { applied: boolean; run: RunRow } {
    const id = requireId(runId, "runId");
    const now = nowMs(options.now);
    const outcome = withImmediate(db, () => {
      const row = readRun(db, id);
      if (row === null) {
        throw new RepositoryNotFoundError(`run ${id} not found`);
      }
      if (row.status !== "cancel_requested") {
        return { applied: false, run: parseRunRow(row) };
      }
      const moved = db
        .prepare(
          "UPDATE runs SET status = 'cancelled', finished_at = ? WHERE id = ? AND status = 'cancel_requested'",
        )
        .run(now, id);
      if (moved.changes !== 1) {
        const current = readRun(db, id);
        if (current === null) {
          throw new RepositoryNotFoundError(`run ${id} not found`);
        }
        return { applied: false, run: parseRunRow(current) };
      }
      appendEventInTx(db, id, row.event_seq, "run.cancelled", {}, now);
      const current = readRun(db, id);
      if (current === null) {
        throw new RepositoryNotFoundError(`run ${id} not found`);
      }
      return { applied: true, run: parseRunRow(current) };
    });
    if (outcome.applied) {
      clearStagedAfterTerminalCommit(id);
    }
    return outcome;
  }

  function sweepTerminals(
    cause: "restart_recovery" | "drain",
    now: number,
  ): { abandoned: number; cancelled: number } {
    // C21: Action Runs NEVER use the generic sweep. An `m5-action` run is
    // recovered by the action execution service (execution CAS + receipt +
    // run abandoned, marker/receipt/grant coherent) in its OWN single
    // transaction. It runs FIRST and fail-closed: an impossible Action pair
    // throws before the generic sweep opens its transaction, so nothing is
    // swept and no Action execution is left dangling.
    actionCancelService().validateAndRecoverActionRuns(cause, now);
    return withImmediate(db, () => {
      const running = db
        .prepare(
          `SELECT * FROM runs WHERE status = 'running' AND strategy <> 'm5-action' ORDER BY created_at ASC`,
        )
        .all() as RawRun[];
      const cancelling = db
        .prepare(
          `SELECT * FROM runs WHERE status = 'cancel_requested' AND strategy <> 'm5-action' ORDER BY created_at ASC`,
        )
        .all() as RawRun[];
      let abandoned = 0;
      for (const row of running) {
        const moved = db
          .prepare(
            "UPDATE runs SET status = 'abandoned', finished_at = ? WHERE id = ? AND status = 'running'",
          )
          .run(now, row.id);
        if (moved.changes === 1) {
          appendEventInTx(
            db,
            row.id,
            row.event_seq,
            "run.abandoned",
            { cause },
            now,
          );
          // Abandonment kills any staged proposal (leak-free sweeps).
          clearStagedAfterTerminalCommit(row.id);
          abandoned += 1;
        }
      }
      let cancelled = 0;
      for (const row of cancelling) {
        const moved = db
          .prepare(
            "UPDATE runs SET status = 'cancelled', finished_at = ? WHERE id = ? AND status = 'cancel_requested'",
          )
          .run(now, row.id);
        if (moved.changes === 1) {
          appendEventInTx(db, row.id, row.event_seq, "run.cancelled", {}, now);
          clearStagedAfterTerminalCommit(row.id);
          cancelled += 1;
        }
      }
      // queued rows are intentionally unchanged (requeue on next startup).
      return { abandoned, cancelled };
    });
  }

  function recover(options: TransitionOptions = {}): {
    abandoned: number;
    cancelled: number;
  } {
    return sweepTerminals("restart_recovery", nowMs(options.now));
  }

  function drain(options: TransitionOptions = {}): {
    abandoned: number;
    cancelled: number;
  } {
    return sweepTerminals("drain", nowMs(options.now));
  }

  /**
   * C21: safe disposition of a run the engine orphaned while it was
   * `running` (post-pickup snapshot/read failure, watchdog finalization).
   * An `m5-action` Run is NEVER generically failed: it is dispatched to the
   * action execution service, which applies the SAME pre/post-marker
   * disposition as recovery/drain (failed receipt + abandoned, or unknown
   * receipt + abandoned) so no dangling execution survives. Every other
   * strategy keeps the generic `running -> abandoned` transition.
   */
  function settleAbandonedRunningRun(
    runId: string,
    options: TransitionOptions & { cause?: "restart_recovery" | "drain" } = {},
  ): { applied: boolean; status: string } {
    const id = requireId(runId, "runId");
    const now = nowMs(options.now);
    const cause = options.cause ?? "restart_recovery";
    const row = readRun(db, id);
    if (row === null) {
      throw new RepositoryNotFoundError(`run ${id} not found`);
    }
    if (row.strategy === "m5-action") {
      const outcome = actionCancelService().recoverAbandonedActionRun(
        id,
        cause,
        now,
      );
      return { applied: outcome.applied, status: outcome.runStatus };
    }
    const outcome = withImmediate(db, () => {
      const current = readRun(db, id);
      if (current === null) {
        throw new RepositoryNotFoundError(`run ${id} not found`);
      }
      if (current.status !== "running") {
        return { applied: false, status: current.status };
      }
      const moved = db
        .prepare(
          "UPDATE runs SET status = 'abandoned', finished_at = ? WHERE id = ? AND status = 'running'",
        )
        .run(now, id);
      if (moved.changes !== 1) {
        return { applied: false, status: "running" };
      }
      appendEventInTx(
        db,
        id,
        current.event_seq,
        "run.abandoned",
        { cause },
        now,
      );
      return { applied: true, status: "abandoned" };
    });
    if (outcome.applied) {
      clearStagedAfterTerminalCommit(id);
    }
    return outcome;
  }

  function appendToolEvent(
    runId: string,
    type: "tool.requested" | "tool.completed",
    payload: unknown,
    options: TransitionOptions = {},
  ): LatestRunEvent {
    const id = requireId(runId, "runId");
    const now = nowMs(options.now);
    if (type !== "tool.requested" && type !== "tool.completed") {
      throw new RepositoryValidationError(
        "appendToolEvent accepts only tool.requested/tool.completed",
      );
    }
    return withImmediate(db, () => {
      const row = readRun(db, id);
      if (row === null) {
        throw new RepositoryNotFoundError(`run ${id} not found`);
      }
      if (
        ["completed", "failed", "cancelled", "abandoned"].includes(row.status)
      ) {
        throw new RepositoryValidationError(
          "cannot append events to a terminal run",
        );
      }
      const next = appendEventInTx(db, id, row.event_seq, type, payload, now);
      const stored = db
        .prepare(
          "SELECT run_id, seq, schema_version, type, payload, created_at FROM run_events WHERE run_id = ? AND seq = ?",
        )
        .get(id, next) as
        | {
            run_id: string;
            seq: number;
            schema_version: number;
            type: string;
            payload: string;
            created_at: number;
          }
        | undefined;
      if (stored === undefined) {
        throw new RepositoryNotFoundError(
          `event ${next} for run ${id} not found`,
        );
      }
      return parseOrValidation(
        () =>
          parseRunEvent({
            schemaVersion: stored.schema_version,
            runId: stored.run_id,
            seq: stored.seq,
            createdAt: stored.created_at,
            type: stored.type,
            payload: JSON.parse(stored.payload),
          }),
        "tool event envelope",
      );
    });
  }

  function getHistory(
    sessionId: string,
    query: { beforePosition?: number; limit?: number },
  ): HistoryResponse {
    const session = requireId(sessionId, "sessionId");
    if (readSession(db, session) === null) {
      throw new RepositoryNotFoundError(`session ${session} not found`);
    }
    const parsed = parseOrValidation(
      () =>
        HistoryQuerySchema.parse({
          beforePosition: query.beforePosition,
          limit: query.limit,
        }),
      "history query",
    );
    const limit = parsed.limit;
    const rows =
      parsed.beforePosition === undefined
        ? (db
            .prepare(
              "SELECT * FROM turns WHERE session_id = ? ORDER BY seq DESC LIMIT ?",
            )
            .all(session, limit + 1) as RawTurn[])
        : (db
            .prepare(
              "SELECT * FROM turns WHERE session_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?",
            )
            .all(session, parsed.beforePosition, limit + 1) as RawTurn[]);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).reverse();
    const nextBefore =
      hasMore && page.length > 0 ? (page[0] as RawTurn).seq : null;
    /** T1: actual receipt view for an OWNED execution id (null else). */
    const receiptViewForExecution = (
      executionId: string,
    ): ActionReceiptView | null => {
      const receipt = db
        .prepare(
          "SELECT outcome, summary_json, created_at FROM action_receipts WHERE execution_id = ?",
        )
        .get(executionId) as
        | { outcome: string; summary_json: string; created_at: number }
        | undefined;
      if (receipt === undefined) {
        return null;
      }
      return parseOrValidation(
        () =>
          ActionReceiptViewSchema.parse({
            outcome: receipt.outcome,
            summary: JSON.parse(receipt.summary_json) as unknown,
            createdAt: receipt.created_at,
          }),
        "action receipt view",
      );
    };
    /**
     * T1: ACTUAL owned Action execution + receipt projection for an
     * approval Turn, INDEPENDENT of `turn_selections` (which stays
     * completed-only for the `user_text` path). Exact FK ownership:
     * execution.session_id = history session AND
     * execution.approval_turn_id = this turn AND
     * run.session_id = session AND run.turn_id = turn. Never fabricates a
     * selection or success: non-completed terminals carry `result: null`
     * with the actual receipt; active runs carry `receipt: null` with live
     * statuses (frozen intent + progress, never a fake failure).
     */
    const approvalRunProjection = (
      turnId: string,
    ): {
      runId: string;
      attempt: number;
      runStatus: RunStatus;
      finishedAt: number | null;
      result: RunResult | null;
      receipt: ActionReceiptView | null;
      executionStatus: ActionExecutionStatus | null;
      targetCitation: ActionTargetCitation | null;
    } | null => {
      const execution = db
        .prepare(
          `SELECT id, proposal_id, action_run_id, status FROM action_executions
           WHERE session_id = ? AND approval_turn_id = ?`,
        )
        .get(session, turnId) as
        | {
            id: string;
            proposal_id: string;
            action_run_id: string;
            status: string;
          }
        | undefined;
      if (execution === undefined) {
        return null;
      }
      const proposalRow = loadProposal(execution.proposal_id);
      if (proposalRow === null) {
        throw new DatabaseStateInvalidError(
          `execution ${execution.id} has no proposal (impossible state)`,
        );
      }
      const runRow = readRun(db, execution.action_run_id);
      if (
        runRow === null ||
        runRow.session_id !== session ||
        runRow.turn_id !== turnId
      ) {
        return null;
      }
      const runStatus = parseOrValidation(
        () => RunStatusSchema.parse(runRow.status),
        "history action run status",
      );
      const executionStatus = parseOrValidation(
        () => ActionExecutionStatusSchema.parse(execution.status),
        "history action execution status",
      );
      const result =
        runRow.result_json === null
          ? null
          : parseOrValidation(
              () => parseRunResult(JSON.parse(runRow.result_json as string)),
              "history selected result",
            );
      return {
        runId: runRow.id,
        attempt: runRow.attempt,
        runStatus,
        finishedAt: runRow.finished_at,
        result,
        receipt: receiptViewForExecution(execution.id),
        executionStatus,
        // ORIGINAL-only BEFORE label from the owning proposal's immutable
        // target (fail closed when unresolvable — never a fabricated AFTER).
        targetCitation: targetCitationForProposal(session, proposalRow),
      };
    };
    const items = page.map((row) => {
      const turn = parseTurnRow(row);
      // C18 (§18.4): the two M5 decision kinds project as exact
      // hash-bound decision items; a rejection carries no Run ever (the
      // kind is the discriminant, selectedRun stays null).
      if (turn.input.kind === "action_rejection") {
        return {
          turnId: row.id,
          seq: row.seq,
          kind: turn.input.kind,
          proposalId: turn.input.proposalId,
          proposalHash: turn.input.proposalHash,
          createdAt: row.created_at,
          selectedRun: null,
        };
      }
      if (turn.input.kind === "action_approval") {
        return {
          turnId: row.id,
          seq: row.seq,
          kind: turn.input.kind,
          proposalId: turn.input.proposalId,
          proposalHash: turn.input.proposalHash,
          createdAt: row.created_at,
          selectedRun: approvalRunProjection(row.id),
        };
      }
      if (turn.input.kind !== "user_text") {
        throw new RepositoryValidationError(`unsupported turn kind in history`);
      }
      const selection = db
        .prepare("SELECT run_id FROM turn_selections WHERE turn_id = ?")
        .get(row.id) as { run_id: string } | undefined;
      let selectedRun: {
        runId: string;
        attempt: number;
        finishedAt: number;
        result: RunResult;
      } | null = null;
      if (selection !== undefined) {
        const runRow = readRun(db, selection.run_id);
        if (runRow !== null && runRow.finished_at !== null) {
          const result = parseOrValidation(
            () =>
              runRow.result_json === null
                ? (() => {
                    throw new Error("selected run has no result");
                  })()
                : parseRunResult(JSON.parse(runRow.result_json)),
            "history selected result",
          );
          selectedRun = {
            runId: runRow.id,
            attempt: runRow.attempt,
            finishedAt: runRow.finished_at,
            result,
          };
        }
      }
      return {
        turnId: row.id,
        seq: row.seq,
        kind: "user_text" as const,
        text: turn.input.kind === "user_text" ? turn.input.text : "",
        createdAt: row.created_at,
        selectedRun,
      };
    });
    return parseOrValidation(
      () => HistoryResponseSchema.parse({ items, nextBefore, hasMore }),
      "history response",
    );
  }

  function getEvents(
    sessionId: string,
    runId: string,
    query: { after?: number; limit?: number },
  ): {
    events: LatestRunEvent[];
    nextAfter: number;
    hasMore: boolean;
    terminal: boolean;
  } {
    const owned = requireOwnedRun(sessionId, runId);
    const parsed = parseOrValidation(
      () =>
        EventsQuerySchema.parse({
          after: query.after ?? 0,
          limit: query.limit,
        }),
      "events query",
    );
    const rows = db
      .prepare(
        "SELECT run_id, seq, schema_version, type, payload, created_at FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?",
      )
      .all(owned.id, parsed.after, parsed.limit + 1) as Array<{
      run_id: string;
      seq: number;
      schema_version: number;
      type: string;
      payload: string;
      created_at: number;
    }>;
    const hasMore = rows.length > parsed.limit;
    const page = rows.slice(0, parsed.limit);
    const events = page.map((row) =>
      parseOrValidation(
        () =>
          parseRunEvent({
            schemaVersion: row.schema_version,
            runId: row.run_id,
            seq: row.seq,
            createdAt: row.created_at,
            type: row.type,
            payload: JSON.parse(row.payload),
          }),
        "run event envelope",
      ),
    );
    const nextAfter =
      page.length > 0
        ? (page[page.length - 1] as { seq: number }).seq
        : parsed.after;
    const terminal = isTerminalStatus(owned.status as RunStatus);
    // Latest (M1) page: same cursor semantics as M0, but the envelope
    // registry understands `reference.presented`. The exact M0 schemas stay
    // pinned in contracts for M0 assertions; only this read is upgraded.
    return parseOrValidation(
      () =>
        LatestEventsResponseSchema.parse({
          events,
          nextAfter,
          hasMore,
          terminal,
        }),
      "events response",
    );
  }

  /* ---------------------------------------------------------------- */
  /* M1 stored-only reference reads + versioned context (§14.8).        */
  /*                                                                     */
  /* Stored-only: no connector calls, no grants, no events. Session      */
  /* ownership is checked before every read; mismatches are 404.         */
  /* ---------------------------------------------------------------- */

  function listReferences(sessionId: string): ReferenceListResponse {
    const session = requireId(sessionId, "sessionId");
    if (readSession(db, session) === null) {
      throw new RepositoryNotFoundError(`session ${session} not found`);
    }
    const rows = db
      .prepare(
        "SELECT id, ordinal, resource_id, snapshot_id FROM session_references WHERE session_id = ? ORDER BY ordinal ASC",
      )
      .all(session) as Array<{
      id: string;
      ordinal: number;
      resource_id: string;
      snapshot_id: string;
    }>;
    return parseOrValidation(
      () =>
        ReferenceListResponseSchema.parse({
          items: rows.map((row) => ({
            id: row.id,
            ordinal: row.ordinal,
            resourceId: row.resource_id,
            snapshotId: row.snapshot_id,
          })),
        }),
      "reference list response",
    );
  }

  function getReferenceDetail(
    sessionId: string,
    referenceId: string,
  ): ReferenceDetailResponse {
    const session = requireId(sessionId, "sessionId");
    const reference = requireId(referenceId, "referenceId");
    if (readSession(db, session) === null) {
      throw new RepositoryNotFoundError(`session ${session} not found`);
    }
    const row = db
      .prepare(
        `SELECT sr.id AS id, sr.ordinal AS ordinal, sr.resource_id AS resource_id,
                sr.snapshot_id AS snapshot_id, sr.created_at AS created_at,
                r.connector_instance_id AS connector_instance_id,
                r.canonical_key AS canonical_key, r.title AS title,
                r.next_revision AS next_revision, r.created_at AS resource_created_at,
                s.revision AS revision, s.source_revision AS source_revision,
                s.content_hash AS content_hash, s.size_bytes AS size_bytes,
                 s.observed_at AS observed_at, s.created_at AS snapshot_created_at,
                 s.body_json AS body_json, w.url AS web_result_url
           FROM session_references sr
           JOIN resources r ON r.id = sr.resource_id
           JOIN connector_instances ci ON ci.id = r.connector_instance_id
           JOIN resource_snapshots s ON s.id = sr.snapshot_id
           LEFT JOIN web_result_urls w ON w.snapshot_id = s.id
             AND ci.kind = 'web'
          WHERE sr.session_id = ? AND sr.id = ?`,
      )
      .get(session, reference) as
      | {
          id: string;
          ordinal: number;
          resource_id: string;
          snapshot_id: string;
          created_at: number;
          connector_instance_id: string;
          canonical_key: string;
          title: string | null;
          next_revision: number;
          resource_created_at: number;
          revision: number;
          source_revision: string | null;
          content_hash: string;
          size_bytes: number;
          observed_at: number;
          snapshot_created_at: number;
          body_json: string;
          web_result_url: string | null;
        }
      | undefined;
    if (row === undefined) {
      throw new ReferenceNotFoundError(
        `reference ${reference} not found in session ${session}`,
      );
    }
    const body = parseOrValidation(
      () => SnapshotBodySchema.parse(JSON.parse(row.body_json)),
      "stored snapshot body",
    );
    // Fail-closed web URL surfacing (design §5): the side table only ever
    // receives connector-validated http(s) URLs, but a stored value that
    // fails the scheme allowlist/bound degrades to null instead of ever
    // reaching the UI as a link target.
    const storedWebUrl = row.web_result_url;
    const webResultUrl =
      typeof storedWebUrl === "string" &&
      storedWebUrl.length <= 2048 &&
      /^https?:\/\//.test(storedWebUrl)
        ? storedWebUrl
        : null;
    return parseOrValidation(
      () =>
        ReferenceDetailResponseSchema.parse({
          reference: {
            sessionId: session,
            id: row.id,
            ordinal: row.ordinal,
            resourceId: row.resource_id,
            snapshotId: row.snapshot_id,
            createdAt: row.created_at,
          },
          resource: {
            id: row.resource_id,
            canonicalKey: row.canonical_key,
            title: row.title,
          },
          snapshot: {
            id: row.snapshot_id,
            resourceId: row.resource_id,
            revision: row.revision,
            sourceRevision: row.source_revision,
            contentHash: row.content_hash,
            sizeBytes: row.size_bytes,
            observedAt: row.observed_at,
          },
          body,
          webResultUrl,
        }),
      "reference detail response",
    );
  }

  function getReferenceSet(
    sessionId: string,
    setId: string,
  ): ReferenceSetDetailResponse {
    const session = requireId(sessionId, "sessionId");
    const set = requireId(setId, "setId");
    if (readSession(db, session) === null) {
      throw new RepositoryNotFoundError(`session ${session} not found`);
    }
    const setRow = db
      .prepare(
        "SELECT id, session_id, created_at FROM reference_sets WHERE id = ?",
      )
      .get(set) as
      | { id: string; session_id: string; created_at: number }
      | undefined;
    if (setRow === undefined || setRow.session_id !== session) {
      throw new ReferenceNotFoundError(
        `reference set ${set} not found in session ${session}`,
      );
    }
    const itemRows = db
      .prepare(
        "SELECT ordinal, reference_id FROM reference_set_items WHERE session_id = ? AND set_id = ? ORDER BY ordinal ASC",
      )
      .all(session, set) as Array<{ ordinal: number; reference_id: string }>;
    const references = itemRows.map((item) => {
      const ref = db
        .prepare(
          "SELECT id, ordinal, resource_id, snapshot_id FROM session_references WHERE session_id = ? AND id = ?",
        )
        .get(session, item.reference_id) as
        | {
            id: string;
            ordinal: number;
            resource_id: string;
            snapshot_id: string;
          }
        | undefined;
      if (ref === undefined) {
        throw new ReferenceNotFoundError(
          `reference ${item.reference_id} not found in session ${session}`,
        );
      }
      return {
        id: ref.id,
        ordinal: ref.ordinal,
        resourceId: ref.resource_id,
        snapshotId: ref.snapshot_id,
      };
    });
    return parseOrValidation(
      () =>
        ReferenceSetDetailResponseSchema.parse({
          set: {
            sessionId: session,
            id: setRow.id,
            createdAt: setRow.created_at,
            items: itemRows.map((item) => ({
              ordinal: item.ordinal,
              referenceId: item.reference_id,
            })),
          },
          references,
        }),
      "reference set response",
    );
  }

  function getReferenceContext(sessionId: string): ReferenceContextGetResponse {
    const session = requireId(sessionId, "sessionId");
    if (readSession(db, session) === null) {
      throw new RepositoryNotFoundError(`session ${session} not found`);
    }
    // Stored-only read: never mutates. createSession + 0002 backfill
    // guarantee the row; a missing row is invalid DB state (fail closed).
    const row = db
      .prepare(
        "SELECT version, items_json FROM session_reference_context WHERE session_id = ?",
      )
      .get(session) as { version: number; items_json: string } | undefined;
    if (row === undefined) {
      throw new DatabaseStateInvalidError(
        `reference context missing for session ${session}`,
      );
    }
    return parseOrValidation(
      () =>
        ReferenceContextGetResponseSchema.parse({
          version: row.version,
          items: JSON.parse(row.items_json),
        }),
      "reference context response",
    );
  }

  function putReferenceContext(
    sessionId: string,
    request: { version: number; items: string[] },
    options: TransitionOptions = {},
  ): ReferenceContextPutResponse {
    const session = requireId(sessionId, "sessionId");
    const now = nowMs(options.now);
    const parsed = parseOrValidation(
      () => ReferenceContextPutRequestSchema.parse(request),
      "reference context request",
    );
    if (new Set(parsed.items).size !== parsed.items.length) {
      throw new InvalidReferenceError(
        "duplicate reference id in context items",
      );
    }
    return withImmediate(db, () => {
      if (readSession(db, session) === null) {
        throw new RepositoryNotFoundError(`session ${session} not found`);
      }
      const current = db
        .prepare(
          "SELECT version, items_json FROM session_reference_context WHERE session_id = ?",
        )
        .get(session) as { version: number; items_json: string } | undefined;
      if (current === undefined) {
        throw new DatabaseStateInvalidError(
          `reference context missing for session ${session}`,
        );
      }
      // Every item must belong to the path session (JSON cannot be a DB FK).
      for (const id of parsed.items) {
        const owned = db
          .prepare(
            "SELECT id FROM session_references WHERE session_id = ? AND id = ?",
          )
          .get(session, id) as { id: string } | undefined;
        if (owned === undefined) {
          throw new InvalidReferenceError(
            `reference ${id} does not belong to session ${session}`,
          );
        }
      }
      // CAS: the request carries the expected CURRENT version; the commit
      // stores exactly expected + 1. Anything else is a version conflict.
      const nextVersion = parsed.version + 1;
      const moved = db
        .prepare(
          "UPDATE session_reference_context SET version = ?, items_json = ?, updated_at = ? WHERE session_id = ? AND version = ?",
        )
        .run(
          nextVersion,
          JSON.stringify(parsed.items),
          now,
          session,
          parsed.version,
        );
      if (moved.changes !== 1) {
        const fresh = db
          .prepare(
            "SELECT version FROM session_reference_context WHERE session_id = ?",
          )
          .get(session) as { version: number } | undefined;
        throw new ReferenceVersionConflictError(
          parsed.version,
          fresh?.version ?? -1,
        );
      }
      return parseOrValidation(
        () =>
          ReferenceContextPutResponseSchema.parse({
            version: nextVersion,
            items: parsed.items,
          }),
        "reference context put response",
      );
    });
  }

  function backfillReferenceContexts(options: TransitionOptions = {}): {
    backfilled: number;
  } {
    const now = nowMs(options.now);
    return withImmediate(db, () => {
      const before = (
        db
          .prepare("SELECT COUNT(*) AS n FROM session_reference_context")
          .get() as { n: number }
      ).n;
      db.prepare(
        `INSERT OR IGNORE INTO session_reference_context (session_id, version, items_json, updated_at)
         SELECT id, 1, '[]', ? FROM sessions`,
      ).run(now);
      const after = (
        db
          .prepare("SELECT COUNT(*) AS n FROM session_reference_context")
          .get() as { n: number }
      ).n;
      return { backfilled: after - before };
    });
  }

  /* ---------------------------------------------------------------- */
  /* C18 proposal decisions (§18.4).                                    */
  /*                                                                    */
  /* Session-owned, single BEGIN IMMEDIATE per decision. approve is     */
  /* keyed (scope `proposal:{id}:approve`) and idempotently replays     */
  /* the exact stored 202; reject is keyless and state-idempotent       */
  /* (at most one `action_rejection` Turn ever). No execution runtime   */
  /* exists yet: the approved Action Run stays QUEUED (never started    */
  /* by the engine until the C18+ strategy registers — pickup only      */
  /* selects registered strategies), so no external write can happen.   */
  /* ---------------------------------------------------------------- */

  interface RawProposal {
    id: string;
    session_id: string;
    source_turn_id: string;
    source_run_id: string;
    decision_turn_id: string | null;
    tool: string;
    input_json: string;
    target_ref_id: string;
    target_resource_id: string;
    based_on_snapshot_id: string;
    expected_revision: string;
    preview_json: string;
    hash: string;
    status: string;
    created_at: number;
    expires_at: number;
    resolved_at: number | null;
  }

  function loadProposal(proposalId: string): RawProposal | null {
    const id = requireId(proposalId, "proposalId");
    return (
      (db.prepare("SELECT * FROM action_proposals WHERE id = ?").get(id) as
        | RawProposal
        | undefined) ?? null
    );
  }

  function parseProposalSummary(row: RawProposal): ProposalSummary {
    return parseOrValidation(
      () =>
        ProposalSummarySchema.parse({
          proposalId: row.id,
          tool: row.tool,
          input: JSON.parse(row.input_json),
          preview: JSON.parse(row.preview_json),
          hash: row.hash,
          status: row.status,
          createdAt: row.created_at,
          expiresAt: row.expires_at,
          resolvedAt: row.resolved_at,
          decisionTurnId: row.decision_turn_id,
        }),
      "proposal summary",
    );
  }

  /**
   * ORIGINAL-only session citation label (BEFORE evidence navigation) for a
   * session-owned proposal: the `rN` ordinal of the exact source
   * SessionReference the proposal's immutable `target_ref_id` points at.
   * Display metadata only — never a verified AFTER claim, never parsed from
   * preview prose, never a new read of the current upstream. The composite
   * DB FK (`action_proposals_target_fk`) guarantees the owned reference row
   * exists; a missing row is impossible state and fails closed (no
   * fabricated label, no cross-session info).
   */
  function targetCitationForProposal(
    session: string,
    proposal: RawProposal,
  ): ActionTargetCitation | null {
    if (proposal.session_id !== session) {
      throw new RepositoryNotFoundError(
        `proposal ${proposal.id} not found in session ${session}`,
      );
    }
    // M6 targetless `calendar.create` proposals carry a NULL target by
    // contract (no source event, no BEFORE label): the view carries null,
    // never a fabricated `rN`. Reschedule proposals always bind a target;
    // a missing row there stays fail-closed below.
    if (proposal.target_ref_id === null) {
      return null;
    }
    const reference = db
      .prepare(
        "SELECT ordinal FROM session_references WHERE session_id = ? AND id = ?",
      )
      .get(session, proposal.target_ref_id) as { ordinal: number } | undefined;
    if (reference === undefined) {
      throw new DatabaseStateInvalidError(
        `proposal ${proposal.id} has no owned target reference (impossible state)`,
      );
    }
    return parseOrValidation(
      () => ActionTargetCitationSchema.parse(`r${reference.ordinal}`),
      "proposal target citation",
    );
  }

  /**
   * Freeze a decision Turn: the same immutable FrozenContext shape as an
   * M0 message Turn (current ordering/sets of the session reference
   * context + temporal now), with an empty UI context (decisions carry no
   * UI payload). Missing context row is corrupt state (fail closed).
   */
  function freezeDecisionContext(
    sessionId: string,
    now: number,
    timeZone: string,
  ): FrozenContext {
    const contextRow = db
      .prepare(
        "SELECT version, items_json FROM session_reference_context WHERE session_id = ?",
      )
      .get(sessionId) as { version: number; items_json: string } | undefined;
    if (contextRow === undefined) {
      throw new DatabaseStateInvalidError(
        `reference context missing for session ${sessionId}`,
      );
    }
    return parseOrValidation(
      () =>
        FrozenContextSchema.parse({
          version: 1,
          temporal: { now, timeZone },
          uiContext: {},
          referenceContext: {
            version: contextRow.version,
            items: JSON.parse(contextRow.items_json) as unknown[],
          },
        }),
      "decision frozen context",
    );
  }

  /**
   * Shared Turn-allocator CAS (`next_turn_position`): mirrors postMessage
   * exactly so a concurrent decision/message in the same session cannot
   * interleave sequencing.
   */
  function allocateDecisionTurn(
    session: string,
    inputJson: string,
    frozen: FrozenContext,
    now: number,
  ): string {
    const sessionRow = readSession(db, session);
    if (sessionRow === null) {
      throw new RepositoryNotFoundError(`session ${session} not found`);
    }
    const seq = sessionRow.nextTurnPosition;
    const turnId = generateId();
    db.prepare(
      "INSERT INTO turns (id, session_id, seq, input_json, frozen_context, created_at, next_run_attempt) VALUES (?, ?, ?, ?, ?, ?, 1)",
    ).run(turnId, session, seq, inputJson, JSON.stringify(frozen), now);
    const moved = db
      .prepare(
        "UPDATE sessions SET next_turn_position = ?, last_active_at = ? WHERE id = ? AND next_turn_position = ?",
      )
      .run(seq + 1, now, session, seq);
    if (moved.changes !== 1) {
      throw new RepositoryValidationError(
        "concurrent turn allocation conflict",
      );
    }
    return turnId;
  }

  /** Ordered, already-completed proposals first (bounded read, no writes). */
  function listProposals(sessionId: string): ProposalsListResponse {
    const session = requireId(sessionId, "sessionId");
    if (readSession(db, session) === null) {
      throw new RepositoryNotFoundError(`session ${session} not found`);
    }
    const rows = db
      .prepare(
        "SELECT * FROM action_proposals WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
      )
      .all(session, 100) as RawProposal[];
    return parseOrValidation(
      () =>
        ProposalsListResponseSchema.parse({
          proposals: rows.map((row) => parseProposalSummary(row)),
        }),
      "proposals list response",
    );
  }

  /**
   * Actual execution + receipt read for ONE session-owned proposal (C22).
   * Bounded single-row joins, no writes: the approval UX polls this to show
   * the real `queued`/`preflight`/`executing` progress, the real terminal
   * receipt, and the exact Stop boundary (`markerCommitted`). A proposal
   * that was never approved reads back nulls (never a fabricated run).
   */
  function getProposalExecution(
    sessionId: string,
    proposalId: string,
  ): ProposalExecutionView {
    const session = requireId(sessionId, "sessionId");
    const proposal = requireId(proposalId, "proposalId");
    if (readSession(db, session) === null) {
      throw new RepositoryNotFoundError(`session ${session} not found`);
    }
    const row = loadProposal(proposal);
    if (row === null || row.session_id !== session) {
      throw new RepositoryNotFoundError(
        `proposal ${proposal} not found in session ${session}`,
      );
    }
    const execution = db
      .prepare(
        `SELECT id, action_run_id, status, external_call_started_at, error_code
         FROM action_executions WHERE session_id = ? AND proposal_id = ?`,
      )
      .get(session, proposal) as
      | {
          id: string;
          action_run_id: string;
          status: string;
          external_call_started_at: number | null;
          error_code: string | null;
        }
      | undefined;
    const receiptRow =
      execution === undefined
        ? undefined
        : (db
            .prepare(
              "SELECT outcome, summary_json, created_at FROM action_receipts WHERE execution_id = ?",
            )
            .get(execution.id) as
            | { outcome: string; summary_json: string; created_at: number }
            | undefined);
    const status =
      execution === undefined
        ? null
        : (parseOrValidation(
            () => ActionExecutionStatusSchema.parse(execution.status),
            "execution status",
          ) as ActionExecutionStatus);
    const markerCommitted =
      execution !== undefined && execution.external_call_started_at !== null;
    const live =
      status !== null &&
      status !== "succeeded" &&
      status !== "succeeded_unverified" &&
      status !== "blocked_stale" &&
      status !== "failed" &&
      status !== "unknown";
    return parseOrValidation(
      () =>
        ProposalExecutionViewSchema.parse({
          proposalId: proposal,
          proposalStatus: row.status,
          runId: execution === undefined ? null : execution.action_run_id,
          status,
          markerCommitted,
          cancellable: live && !markerCommitted,
          errorCode: execution === undefined ? null : execution.error_code,
          receipt:
            receiptRow === undefined
              ? null
              : {
                  outcome: receiptRow.outcome,
                  summary: JSON.parse(receiptRow.summary_json) as unknown,
                  createdAt: receiptRow.created_at,
                },
          targetCitation: targetCitationForProposal(session, row),
        }),
      "proposal execution view",
    );
  }

  function approveProposal(
    sessionId: string,
    proposalId: string,
    request: { proposalHash: string },
    options: ApproveProposalOptions,
  ): AcceptedResponse<ProposalApprove202Response> {
    const session = requireId(sessionId, "sessionId");
    const proposal = requireId(proposalId, "proposalId");
    const key = requireKey(options.key);
    const now = nowMs(options.now);
    const timeZone = options.timeZone ?? "UTC";
    const parsed = parseOrValidation(
      () => ProposalApproveRequestSchema.parse(request),
      "approve request",
    );
    const scope = parseOrValidation(
      () => IdempotencyScopeSchema.parse(proposalApproveScope(proposal)),
      "approve scope",
    );
    const hash = requestHash(
      IDEMPOTENCY_OPERATIONS.approveProposal.operation,
      IDEMPOTENCY_OPERATIONS.approveProposal.schemaVersion,
      { proposalId: proposal, proposalHash: parsed.proposalHash },
    );
    type ApproveOutcome =
      | DecisionOk<ProposalApprove202Response>
      | DecisionConflict
      | DecisionBusy;
    const outcome: ApproveOutcome = withImmediate(db, () => {
      if (readSession(db, session) === null) {
        throw new RepositoryNotFoundError(`session ${session} not found`);
      }
      // Ownership first: a foreign proposal id is 404, never a replay/probe.
      const row = loadProposal(proposal);
      if (row === null || row.session_id !== session) {
        throw new RepositoryNotFoundError(
          `proposal ${proposal} not found in session ${session}`,
        );
      }
      // Keyed idempotency BEFORE any state check; the stored body must also
      // carry THIS proposal (owner drift is a key misuse, not a replay).
      const existing = toStoredResponse(db, scope, key);
      if (existing !== null) {
        if (existing.requestHash !== hash) {
          throw new IdempotencyConflictError(scope);
        }
        const body = parseOrValidation(
          () => ProposalApprove202ResponseSchema.parse(existing.responseBody),
          "stored approve body",
        );
        if (body.proposalId !== proposal) {
          throw new IdempotencyConflictError(scope);
        }
        return {
          kind: "ok",
          status: existing.responseStatus,
          body,
          replayed: true,
        };
      }
      // Exact binding: the request must carry the stored immutable hash.
      if (row.hash !== parsed.proposalHash) {
        throw new ProposalHashMismatchError();
      }
      // Terminal states are conflicts (reject cannot approve and vice versa).
      if (row.status !== "pending") {
        return {
          kind: "state_conflict",
          reason: row.status as "approved" | "rejected" | "expired",
          proposalId: proposal,
        };
      }
      // Expired pending: resolve expired SAFELY inside this same
      // transaction (CAS pending -> expired + resolved_at), then report a
      // conflict AFTER commit so the resolution persists.
      if (now >= row.expires_at) {
        const expired = db
          .prepare(
            "UPDATE action_proposals SET status = 'expired', resolved_at = ? WHERE id = ? AND session_id = ? AND status = 'pending'",
          )
          .run(now, proposal, session);
        if (expired.changes !== 1) {
          throw new KernelStorageError(
            "kernel_concurrent_conflict",
            "concurrent proposal decision conflict; retry",
          );
        }
        return {
          kind: "state_conflict",
          reason: "expired",
          proposalId: proposal,
        };
      }
      // §18.4: no active Run may exist in the session at decision time.
      const busy = db
        .prepare(
          `SELECT id FROM runs WHERE session_id = ? AND status IN ${ACTIVE_STATUSES_SQL} LIMIT 1`,
        )
        .get(session) as { id: string } | undefined;
      if (busy !== undefined) {
        return { kind: "busy", proposalId: proposal };
      }
      const frozen = freezeDecisionContext(session, now, timeZone);
      // Exact action_approval TurnInput (contracts variant, version 1).
      const turnInput = parseOrValidation(
        () =>
          parseTurnInput({
            kind: "action_approval",
            version: 1,
            proposalId: proposal,
            proposalHash: parsed.proposalHash,
          }),
        "approval turn input",
      );
      const decisionTurnId = allocateDecisionTurn(
        session,
        JSON.stringify(turnInput),
        frozen,
        now,
      );
      const runId = generateId();
      const executionId = generateId();
      // CAS the exact single transition BEFORE the execution/grant/runs.
      const moved = db
        .prepare(
          "UPDATE action_proposals SET status = 'approved', resolved_at = ?, decision_turn_id = ? WHERE id = ? AND session_id = ? AND status = 'pending'",
        )
        .run(now, decisionTurnId, proposal, session);
      if (moved.changes !== 1) {
        throw new KernelStorageError(
          "kernel_concurrent_conflict",
          "concurrent proposal decision conflict; retry",
        );
      }
      // Queued Action Run on the decision Turn; no execution runtime
      // exists, so it stays queued (engine pickup only selects REGISTERED
      // strategies) until the deterministic action strategy is wired.
      db.prepare(
        `INSERT INTO runs (id, turn_id, session_id, attempt, status, strategy,
          result_json, error_code, event_seq, select_on_success,
          tool_requests_used, created_at, started_at, finished_at, cancel_requested_at)
         VALUES (?, ?, ?, 1, 'queued', 'm5-action', NULL, NULL, 0, 1, 0, ?, NULL, NULL, NULL)`,
      ).run(runId, decisionTurnId, session, now);
      appendEventInTx(db, runId, 0, "run.queued", { attempt: 1 }, now);
      appendEventInTx(
        db,
        runId,
        1,
        "action.approved",
        ActionApprovedPayloadSchema.parse({
          proposalId: proposal,
          proposalHash: parsed.proposalHash,
          executionId,
        }),
        now,
      );
      db.prepare(
        `INSERT INTO action_executions (id, session_id, proposal_id, approval_turn_id, action_run_id, status, external_call_started_at, finished_at, error_code, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'queued', NULL, NULL, NULL, ?, ?)`,
      ).run(executionId, session, proposal, decisionTurnId, runId, now, now);
      // One-shot exact grant: inputHash over the canonical proposed input
      // (per-tool exact shape: reschedule start/end or create title/start/end).
      const proposedInput = parseOrValidation(
        () => ActionToolInputSchema.parse(JSON.parse(row.input_json)),
        "proposal input",
      );
      db.prepare(
        `INSERT INTO action_execution_grants (execution_id, session_id, proposal_id, proposal_hash, tool, input_hash, consumed_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
      ).run(
        executionId,
        session,
        proposal,
        row.hash,
        row.tool,
        sha256Hex(canonicalJsonString(proposedInput)),
        now,
      );
      const body = parseOrValidation(
        () =>
          ProposalApprove202ResponseSchema.parse({
            proposalId: proposal,
            executionId,
            runId,
            status: "queued",
          }),
        "approve response",
      );
      storeIdempotentResponse(db, scope, key, hash, 202, body, now);
      return { kind: "ok", status: 202, body, replayed: false };
    });
    // Post-commit mapping so conflict-time state changes (the safe expired
    // resolution) persist before the error is observed.
    if (outcome.kind === "state_conflict") {
      throw new ProposalStateConflictError(
        `proposal ${outcome.proposalId} is ${outcome.reason}, not pending`,
      );
    }
    if (outcome.kind === "busy") {
      throw new SessionBusyError(session);
    }
    return {
      status: outcome.status,
      body: outcome.body,
      replayed: outcome.replayed,
    };
  }

  /**
   * Reject is KEYLESS and state-idempotent (§18.4): exactly one
   * `pending -> rejected` CAS per proposal plus at most ONE
   * `action_rejection` Turn; repeat rejects return the same deterministic
   * body without creating anything. No Run, no events, no external call.
   */
  function rejectProposal(
    sessionId: string,
    proposalId: string,
    request: { proposalHash: string },
    options: RejectProposalOptions = {},
  ): { status: number; body: ProposalRejectResponse } {
    const session = requireId(sessionId, "sessionId");
    const proposal = requireId(proposalId, "proposalId");
    const now = nowMs(options.now);
    const timeZone = options.timeZone ?? "UTC";
    const parsed = parseOrValidation(
      () => ProposalRejectRequestSchema.parse(request),
      "reject request",
    );
    type RejectOutcome = DecisionOk<ProposalRejectResponse> | DecisionConflict;
    const outcome: RejectOutcome = withImmediate(db, () => {
      if (readSession(db, session) === null) {
        throw new RepositoryNotFoundError(`session ${session} not found`);
      }
      const row = loadProposal(proposal);
      if (row === null || row.session_id !== session) {
        throw new RepositoryNotFoundError(
          `proposal ${proposal} not found in session ${session}`,
        );
      }
      // Keyless, so exact hash binding is the request's full integrity.
      if (row.hash !== parsed.proposalHash) {
        throw new ProposalHashMismatchError();
      }
      if (row.status === "rejected") {
        // State-idempotent: the same deterministic state, nothing new.
        return {
          kind: "ok",
          status: 200,
          body: parseOrValidation(
            () =>
              ProposalRejectResponseSchema.parse({
                proposalId: proposal,
                status: "rejected",
                decisionTurnId: row.decision_turn_id,
                resolvedAt: row.resolved_at,
              }),
            "reject response",
          ),
          replayed: true,
        };
      }
      if (row.status !== "pending") {
        return {
          kind: "state_conflict",
          reason: row.status as "approved" | "expired",
          proposalId: proposal,
        };
      }
      // Expired pending: safe same-tx resolution (expired has NO decision
      // Turn and NO rejection body), then a post-commit conflict.
      if (now >= row.expires_at) {
        const expired = db
          .prepare(
            "UPDATE action_proposals SET status = 'expired', resolved_at = ? WHERE id = ? AND session_id = ? AND status = 'pending'",
          )
          .run(now, proposal, session);
        if (expired.changes !== 1) {
          throw new KernelStorageError(
            "kernel_concurrent_conflict",
            "concurrent proposal decision conflict; retry",
          );
        }
        return {
          kind: "state_conflict",
          reason: "expired",
          proposalId: proposal,
        };
      }
      const frozen = freezeDecisionContext(session, now, timeZone);
      const turnInput = parseOrValidation(
        () =>
          parseTurnInput({
            kind: "action_rejection",
            version: 1,
            proposalId: proposal,
            proposalHash: parsed.proposalHash,
          }),
        "rejection turn input",
      );
      const decisionTurnId = allocateDecisionTurn(
        session,
        JSON.stringify(turnInput),
        frozen,
        now,
      );
      const moved = db
        .prepare(
          "UPDATE action_proposals SET status = 'rejected', resolved_at = ?, decision_turn_id = ? WHERE id = ? AND session_id = ? AND status = 'pending'",
        )
        .run(now, decisionTurnId, proposal, session);
      if (moved.changes !== 1) {
        throw new KernelStorageError(
          "kernel_concurrent_conflict",
          "concurrent proposal decision conflict; retry",
        );
      }
      return {
        kind: "ok",
        status: 200,
        body: parseOrValidation(
          () =>
            ProposalRejectResponseSchema.parse({
              proposalId: proposal,
              status: "rejected",
              decisionTurnId,
              resolvedAt: now,
            }),
          "reject response",
        ),
        replayed: false,
      };
    });
    if (outcome.kind === "state_conflict") {
      throw new ProposalStateConflictError(
        `proposal ${outcome.proposalId} is ${outcome.reason}, not pending`,
      );
    }
    return { status: outcome.status, body: outcome.body };
  }

  function lookupIdempotency(
    scope: string,
    key: string,
  ): IdempotencyLookupResponse {
    const validScope = parseOrValidation(
      () => IdempotencyScopeSchema.parse(scope),
      "idempotency scope",
    );
    const validKey = requireKey(key);
    const existing = toStoredResponse(db, validScope, validKey);
    if (existing === null) {
      return { found: false, code: "resend_required" };
    }
    return parseOrValidation(
      () =>
        IdempotencyLookupResponseSchema.parse({
          found: true,
          status: existing.responseStatus,
          body: existing.responseBody,
        }),
      "idempotency lookup response",
    );
  }

  function lookupIdempotencyForSession(
    sessionId: string,
    key: string,
    scope: string,
  ): IdempotencyLookupResponse {
    const session = requireId(sessionId, "sessionId");
    const validScope = parseOrValidation(
      () => IdempotencyScopeSchema.parse(scope),
      "idempotency scope",
    );
    const validKey = requireKey(key);
    parseOrValidation(
      () => IdempotencyLookupQuerySchema.parse({ scope: validScope }),
      "idempotency lookup query",
    );
    if (validScope === IDEMPOTENCY_SCOPE_SESSIONS_CREATE) {
      return lookupIdempotency(validScope, validKey);
    }
    if (validScope === messageScope(session)) {
      if (readSession(db, session) === null) {
        throw new RepositoryNotFoundError(`session ${session} not found`);
      }
      return lookupIdempotency(validScope, validKey);
    }
    const turnMatch = /^turn:([^:]+):retry$/.exec(validScope);
    if (turnMatch?.[1] !== undefined) {
      requireOwnedTurn(session, assertUuidV4(turnMatch[1], "turnId"));
      return lookupIdempotency(validScope, validKey);
    }
    const proposalMatch = /^proposal:([^:]+):approve$/.exec(validScope);
    if (proposalMatch?.[1] !== undefined) {
      requireOwnedProposal(
        session,
        assertUuidV4(proposalMatch[1], "proposalId"),
      );
      return lookupIdempotency(validScope, validKey);
    }
    // AV autonomy session-create/entity scopes: the embedded session must
    // equal the path session (foreign sessions are 404, never 403), and the
    // session must exist. Global `autonomy:control` is NEVER exposed here:
    // control retry reuses the same POST key (no foreign-session lookup).
    const purposeCreateMatch = /^session:([^:]+):purpose$/.exec(validScope);
    if (purposeCreateMatch?.[1] !== undefined) {
      const embedded = assertUuidV4(purposeCreateMatch[1], "sessionId");
      if (embedded.toLowerCase() !== session.toLowerCase()) {
        throw new RepositoryNotFoundError(
          `scope ${validScope} not found in session ${session}`,
        );
      }
      if (readSession(db, session) === null) {
        throw new RepositoryNotFoundError(`session ${session} not found`);
      }
      return lookupIdempotency(validScope, validKey);
    }
    // Global stop-control scope is NEVER exposed via a session lookup
    // (merged master session-read + feat never-expose; both layers' tests
    // require 404 — control retry reuses the same POST key).
    if (validScope === IDEMPOTENCY_SCOPE_AUTONOMY_CONTROL) {
      throw new RepositoryNotFoundError(
        `scope ${validScope} not found in session ${session}`,
      );
    }
    // Session-bound create scopes (purpose / task / trial-stage): the
    // embedded session must be this session, which must exist.
    if (
      validScope === purposeCreateScope(session) ||
      validScope === taskCreateScope(session) ||
      validScope === trialStageScope(session)
    ) {
      if (readSession(db, session) === null) {
        throw new RepositoryNotFoundError(`session ${session} not found`);
      }
      return lookupIdempotency(validScope, validKey);
    }
    // Conflict scope: embedded session must be this session and both
    // purposes must be session-owned (foreign ids are 404, never 403).
    const conflictMatch = /^session:([^:]+):conflict:([^:]+):([^:]+)$/.exec(
      validScope,
    );
    if (
      conflictMatch?.[1] !== undefined &&
      conflictMatch[2] !== undefined &&
      conflictMatch[3] !== undefined
    ) {
      if (conflictMatch[1] !== session) {
        throw new RepositoryNotFoundError(
          `scope ${validScope} not found in session ${session}`,
        );
      }
      assertOwnedPurpose(
        db,
        session,
        assertUuidV4(conflictMatch[2], "purposeAId"),
      );
      assertOwnedPurpose(
        db,
        session,
        assertUuidV4(conflictMatch[3], "purposeBId"),
      );
      return lookupIdempotency(validScope, validKey);
    }
    // Purpose/task mutation scopes: the referenced row must be
    // session-owned (foreign ids are 404, never 403).
    const purposeOpMatch = /^purpose:([^:]+):(correct|revoke|achieve)$/.exec(
      validScope,
    );
    if (purposeOpMatch?.[1] !== undefined) {
      assertOwnedPurpose(
        db,
        session,
        assertUuidV4(purposeOpMatch[1], "purposeId"),
      );
      return lookupIdempotency(validScope, validKey);
    }
    const taskOpMatch =
      /^task:([^:]+):(start|hold|resume|complete|cancel)$/.exec(validScope);
    if (taskOpMatch?.[1] !== undefined) {
      assertOwnedTask(db, session, assertUuidV4(taskOpMatch[1], "taskId"));
      return lookupIdempotency(validScope, validKey);
    }
    // AV shadow explicit-request scope: the embedded session must equal the
    // path session (foreign sessions are 404, never 403), and the session
    // must exist. The stored job ownership is re-verified on replay inside
    // `requestShadowDeliberation` (stored session must still match).
    const shadowRequestMatch = /^session:([^:]+):shadow-request$/.exec(
      validScope,
    );
    if (shadowRequestMatch?.[1] !== undefined) {
      const embedded = assertUuidV4(shadowRequestMatch[1], "sessionId");
      if (embedded.toLowerCase() !== session.toLowerCase()) {
        throw new RepositoryNotFoundError(
          `scope ${validScope} not found in session ${session}`,
        );
      }
      if (readSession(db, session) === null) {
        throw new RepositoryNotFoundError(`session ${session} not found`);
      }
      return lookupIdempotency(validScope, validKey);
    }
    // Trial approve/claim/permit scopes: the referenced proposal/grant must
    // be session-owned (foreign ids are 404, never 403).
    const trialProposalMatch = /^trial-proposal:([^:]+)$/.exec(validScope);
    if (trialProposalMatch?.[1] !== undefined) {
      requireOwnedTrialProposal(
        session,
        assertUuidV4(trialProposalMatch[1], "proposalId"),
      );
      return lookupIdempotency(validScope, validKey);
    }
    const trialClaimMatch = /^trial-claim:([^:]+)$/.exec(validScope);
    if (trialClaimMatch?.[1] !== undefined) {
      requireOwnedTrialGrant(
        session,
        assertUuidV4(trialClaimMatch[1], "executionId"),
      );
      return lookupIdempotency(validScope, validKey);
    }
    const trialPermitMatch = /^trial-permit:([^:]+)$/.exec(validScope);
    if (trialPermitMatch?.[1] !== undefined) {
      requireOwnedTrialGrant(
        session,
        assertUuidV4(trialPermitMatch[1], "executionId"),
      );
      return lookupIdempotency(validScope, validKey);
    }
    throw new RepositoryNotFoundError(
      `scope ${validScope} not found in session ${session}`,
    );
  }

  /**
   * M5 normal-startup host-owned resolver basis (§18.6): read-only lookup of
   * the IMMUTABLE committed grant (execution + proposal + hash +
   * `expected_revision`). Returns the stored proposal hash and expected
   * revision for an approved execution's grant, or null when no such
   * committed grant exists. Pure SELECT (no writes, no transactions); exposes
   * only the opaque revision + hash the write port must equality-check —
   * never provider ids, credentials, or resource bodies. The caller still
   * equality-checks all three grant fields and applies the source-etag proof.
   */
  function readCommittedGrantRevision(
    executionId: string,
    proposalId: string,
  ): { proposalHash: string; expectedRevision: string } | null {
    const execution = requireId(executionId, "executionId");
    const proposal = requireId(proposalId, "proposalId");
    const grant = db
      .prepare(
        "SELECT proposal_hash FROM action_execution_grants WHERE execution_id = ? AND proposal_id = ?",
      )
      .get(execution, proposal) as { proposal_hash: string } | undefined;
    if (grant === undefined) {
      return null;
    }
    const row = db
      .prepare(
        "SELECT hash, expected_revision FROM action_proposals WHERE id = ?",
      )
      .get(proposal) as { hash: string; expected_revision: string } | undefined;
    if (row === undefined) {
      return null;
    }
    if (
      typeof row.hash !== "string" ||
      typeof row.expected_revision !== "string"
    ) {
      return null;
    }
    return { proposalHash: row.hash, expectedRevision: row.expected_revision };
  }

  function getActiveRun(sessionId: string): RunRow | null {
    const session = requireId(sessionId, "sessionId");
    const row = db
      .prepare(
        `SELECT * FROM runs WHERE session_id = ? AND status IN ${ACTIVE_STATUSES_SQL} LIMIT 1`,
      )
      .get(session) as RawRun | undefined;
    return row === undefined ? null : parseRunRow(row);
  }

  function getSelection(
    turnId: string,
  ): { runId: string; selectedAt: number } | null {
    const turn = requireId(turnId, "turnId");
    const row = db
      .prepare(
        "SELECT run_id, selected_at FROM turn_selections WHERE turn_id = ?",
      )
      .get(turn) as { run_id: string; selected_at: number } | undefined;
    return row === undefined
      ? null
      : { runId: row.run_id, selectedAt: row.selected_at };
  }

  /* ---------------------------------------------------------------- */
  /* M2 Agent audit: typed model-step events + metadata-only model_calls  */
  /* + current-run EvidenceGrant persistence (§15.7, §15.10).              */
  /*                                                                     */
  /* - Model-step events (`model.step.started/completed/failed`) are      */
  /*   non-final Agent-Run extensions validated by the latest contracts   */
  /*   registry; payloads carry structural metadata only (step, timing,   */
  /*   token counts, fixed codes). Prompts, raw output, reasoning, and    */
  /*   secrets are never accepted here (strict schemas reject them).      */
  /* - `model_calls` rows are metadata only (adapter/model/outcome/fixed  */
  /*   code/timing/usage); terminal runs reject appends with the same     */
  /*   stored-only rule as tool events.                                   */
  /* - EvidenceGrants record only actual model-facing exposure            */
  /*   (snippet/full) for the CURRENT run; frozen summaries, membership,  */
  /*   or past-run citations never create rows. Exposure upgrades         */
  /*   snippet -> full and never downgrades.                              */
  /* ---------------------------------------------------------------- */

  const MODEL_CALL_OUTCOMES = [
    "completed",
    "failed",
    "timeout",
    "cancelled",
  ] as const;

  function appendModelStepEvent(
    runId: string,
    type: M2ModelStepEventType,
    payload: unknown,
    options: TransitionOptions = {},
  ): LatestRunEvent {
    const id = requireId(runId, "runId");
    const now = nowMs(options.now);
    const validType = parseOrValidation(
      () => M2ModelStepEventTypeSchema.parse(type),
      "model step event type",
    );
    if (
      validType !== "model.step.started" &&
      validType !== "model.step.completed" &&
      validType !== "model.step.failed"
    ) {
      throw new RepositoryValidationError(
        "appendModelStepEvent accepts only model.step.started/model.step.completed/model.step.failed",
      );
    }
    return withImmediate(db, () => {
      const row = readRun(db, id);
      if (row === null) {
        throw new RepositoryNotFoundError(`run ${id} not found`);
      }
      if (isTerminalStatus(row.status as RunStatus)) {
        throw new RepositoryValidationError(
          "cannot append events to a terminal run",
        );
      }
      const next = appendEventInTx(
        db,
        id,
        row.event_seq,
        validType,
        payload,
        now,
      );
      const stored = db
        .prepare(
          "SELECT run_id, seq, schema_version, type, payload, created_at FROM run_events WHERE run_id = ? AND seq = ?",
        )
        .get(id, next) as
        | {
            run_id: string;
            seq: number;
            schema_version: number;
            type: string;
            payload: string;
            created_at: number;
          }
        | undefined;
      if (stored === undefined) {
        throw new RepositoryNotFoundError(
          `event ${next} for run ${id} not found`,
        );
      }
      return parseOrValidation(
        () =>
          parseRunEvent({
            schemaVersion: stored.schema_version,
            runId: stored.run_id,
            seq: stored.seq,
            createdAt: stored.created_at,
            type: stored.type,
            payload: JSON.parse(stored.payload),
          }),
        "model step event envelope",
      );
    });
  }

  function recordModelCall(
    runId: string,
    entry: RecordModelCallOptions,
  ): ModelCallRow {
    const id = requireId(runId, "runId");
    const now = nowMs(entry.now);
    if (!Number.isInteger(entry.step) || entry.step < 1 || entry.step > 8) {
      throw new RepositoryValidationError("model step must be an integer 1..8");
    }
    if (
      typeof entry.adapter !== "string" ||
      entry.adapter.length < 1 ||
      entry.adapter.length > 128
    ) {
      throw new RepositoryValidationError("adapter must be 1..128 chars");
    }
    if (
      typeof entry.model !== "string" ||
      entry.model.length < 1 ||
      entry.model.length > 256
    ) {
      throw new RepositoryValidationError("model must be 1..256 chars");
    }
    if (!(MODEL_CALL_OUTCOMES as readonly string[]).includes(entry.outcome)) {
      throw new RepositoryValidationError(
        "outcome must be completed|failed|timeout|cancelled",
      );
    }
    const errorCode =
      entry.errorCode === undefined || entry.errorCode === null
        ? null
        : parseOrValidation(
            () => M2ModelErrorCodeSchema.parse(entry.errorCode),
            "model error_code",
          );
    if (
      !Number.isInteger(entry.durationMs) ||
      entry.durationMs < 0 ||
      entry.durationMs > Number.MAX_SAFE_INTEGER
    ) {
      throw new RepositoryValidationError(
        "durationMs must be an integer Unix-ms duration >= 0",
      );
    }
    let usageJson: string | null = null;
    let usage: ModelCallRow["usage"] = null;
    if (entry.usage !== undefined && entry.usage !== null) {
      const { inputTokens, outputTokens } = entry.usage as {
        inputTokens: unknown;
        outputTokens: unknown;
      };
      if (
        typeof inputTokens !== "number" ||
        !Number.isSafeInteger(inputTokens) ||
        (inputTokens as number) < 0 ||
        typeof outputTokens !== "number" ||
        !Number.isSafeInteger(outputTokens) ||
        (outputTokens as number) < 0
      ) {
        throw new RepositoryValidationError(
          "usage must carry safe-integer token counts >= 0",
        );
      }
      usage = {
        inputTokens: inputTokens as number,
        outputTokens: outputTokens as number,
      };
      usageJson = JSON.stringify(usage);
    }
    return withImmediate(db, () => {
      const run = readRun(db, id);
      if (run === null) {
        throw new RepositoryNotFoundError(`run ${id} not found`);
      }
      if (isTerminalStatus(run.status as RunStatus)) {
        throw new RepositoryValidationError(
          "cannot append events to a terminal run",
        );
      }
      const callId = generateId();
      try {
        db.prepare(
          "INSERT INTO model_calls (id, run_id, step, adapter, model, outcome, error_code, duration_ms, usage_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          callId,
          id,
          entry.step,
          entry.adapter,
          entry.model,
          entry.outcome,
          errorCode,
          entry.durationMs,
          usageJson,
          now,
        );
      } catch (error) {
        if (isBusyConstraint(error)) {
          throw new RepositoryValidationError(
            "duplicate model step for this run",
          );
        }
        throw error;
      }
      return {
        id: callId,
        runId: id,
        step: entry.step,
        adapter: entry.adapter,
        model: entry.model,
        outcome: entry.outcome,
        errorCode,
        durationMs: entry.durationMs,
        usage,
        createdAt: now,
      };
    });
  }

  function listModelCalls(runId: string): ModelCallRow[] {
    const id = requireId(runId, "runId");
    if (readRun(db, id) === null) {
      throw new RepositoryNotFoundError(`run ${id} not found`);
    }
    const rows = db
      .prepare(
        "SELECT id, run_id, step, adapter, model, outcome, error_code, duration_ms, usage_json, created_at FROM model_calls WHERE run_id = ? ORDER BY step ASC",
      )
      .all(id) as Array<{
      id: string;
      run_id: string;
      step: number;
      adapter: string;
      model: string;
      outcome: string;
      error_code: string | null;
      duration_ms: number;
      usage_json: string | null;
      created_at: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      step: row.step,
      adapter: row.adapter,
      model: row.model,
      outcome: row.outcome as ModelCallOutcome,
      errorCode: row.error_code as M2ModelErrorCode | null,
      durationMs: row.duration_ms,
      usage:
        row.usage_json === null
          ? null
          : parseStoredModelUsage(row.usage_json as string),
      createdAt: row.created_at,
    }));
  }

  /* ---------------------------------------------------------------- */
  /* System monitor (read-only, bounded SQL; no schema change).        */
  /* ---------------------------------------------------------------- */

  /** Latest model calls across ALL runs, newest first (default 20). */
  function listRecentModelCalls(limit = 20): MonitorModelCallRow[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new RepositoryValidationError("monitor call limit must be 1..100");
    }
    const rows = db
      .prepare(
        "SELECT run_id, step, model, outcome, error_code, duration_ms, usage_json, created_at FROM model_calls ORDER BY created_at DESC, rowid DESC LIMIT ?",
      )
      .all(limit) as Array<{
      run_id: string;
      step: number;
      model: string;
      outcome: string;
      error_code: string | null;
      duration_ms: number;
      usage_json: string | null;
      created_at: number;
    }>;
    return rows.map((row) => ({
      runId: row.run_id,
      step: row.step,
      model: row.model,
      outcome: row.outcome as ModelCallOutcome,
      errorCode: row.error_code as M2ModelErrorCode | null,
      durationMs: row.duration_ms,
      usage:
        row.usage_json === null
          ? null
          : parseStoredModelUsage(row.usage_json as string),
      createdAt: row.created_at,
    }));
  }

  /**
   * Aggregate model calls since `since`. `failures` counts failed/timeout
   * (a user-requested cancellation is not an infrastructure failure).
   * Unreported usage contributes 0 tokens.
   */
  function getModelCallTotals(since: number): MonitorModelTotals {
    if (
      !Number.isSafeInteger(since) ||
      since < 0 ||
      since > Number.MAX_SAFE_INTEGER
    ) {
      throw new RepositoryValidationError(
        "monitor totals since must be a Unix-ms timestamp",
      );
    }
    const row = db
      .prepare(
        `SELECT COUNT(*) AS calls,
                COALESCE(SUM(COALESCE(json_extract(usage_json, '$.inputTokens'), 0)), 0) AS input_tokens,
                COALESCE(SUM(COALESCE(json_extract(usage_json, '$.outputTokens'), 0)), 0) AS output_tokens,
                COALESCE(SUM(CASE WHEN outcome IN ('failed', 'timeout') THEN 1 ELSE 0 END), 0) AS failures
           FROM model_calls
          WHERE created_at >= ?`,
      )
      .get(since) as {
      calls: number;
      input_tokens: number;
      output_tokens: number;
      failures: number;
    };
    return {
      since,
      calls: row.calls,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      failures: row.failures,
    };
  }

  /** Count active runs by status (running + cancel_requested + queued). */
  function countRunsByStatus(): MonitorRunCounts {
    const rows = db
      .prepare(
        "SELECT status, COUNT(*) AS count FROM runs WHERE status IN ('running', 'queued', 'cancel_requested') GROUP BY status",
      )
      .all() as Array<{ status: string; count: number }>;
    const counts: MonitorRunCounts = {
      running: 0,
      queued: 0,
      cancelRequested: 0,
    };
    for (const row of rows) {
      if (row.status === "running") counts.running = row.count;
      else if (row.status === "queued") counts.queued = row.count;
      else if (row.status === "cancel_requested") {
        counts.cancelRequested = row.count;
      }
    }
    return counts;
  }

  /**
   * Persist (or upgrade snippet -> full, never downgrade) one current-run
   * EvidenceGrant. Session ownership of both the run and the reference is
   * verified first; mismatches are 404. Only actual model-facing exposure
   * may call this (the agent calls it solely for delivered reference
   * snippet/full payloads). Terminal runs (completed/failed/cancelled/
   * abandoned) reject inside the same transaction before any insert or
   * snippet -> full upgrade, so post-finalization grants never mutate rows.
   */
  function upsertEvidenceGrant(
    sessionId: string,
    runId: string,
    referenceId: string,
    exposure: "snippet" | "full",
    options: TransitionOptions = {},
  ): EvidenceGrantRow {
    const session = requireId(sessionId, "sessionId");
    const run = requireId(runId, "runId");
    const reference = requireId(referenceId, "referenceId");
    if (exposure !== "snippet" && exposure !== "full") {
      throw new RepositoryValidationError("exposure must be snippet|full");
    }
    const now = nowMs(options.now);
    return withImmediate(db, () => {
      const runRow = readRun(db, run);
      if (runRow === null || runRow.session_id !== session) {
        throw new RepositoryNotFoundError(
          `run ${run} not found in session ${session}`,
        );
      }
      const owned = db
        .prepare(
          "SELECT id FROM session_references WHERE session_id = ? AND id = ?",
        )
        .get(session, reference) as { id: string } | undefined;
      if (owned === undefined) {
        throw new ReferenceNotFoundError(
          `reference ${reference} not found in session ${session}`,
        );
      }
      // Finality: reject grants on terminal runs inside the same BEGIN
      // IMMEDIATE transaction, before any insert/upgrade. Matches the
      // stored-only rule for tool/model-step events and model_calls:
      // completed/failed/cancelled/abandoned never mutate; running and
      // cancel_requested still grant (late-output result rules are separate).
      if (isTerminalStatus(runRow.status as RunStatus)) {
        throw new RepositoryValidationError(
          "cannot grant evidence to a terminal run",
        );
      }
      const existing = db
        .prepare(
          "SELECT exposure, created_at FROM evidence_grants WHERE run_id = ? AND reference_id = ?",
        )
        .get(run, reference) as
        | { exposure: string; created_at: number }
        | undefined;
      if (existing === undefined) {
        db.prepare(
          "INSERT INTO evidence_grants (session_id, run_id, reference_id, exposure, created_at) VALUES (?, ?, ?, ?, ?)",
        ).run(session, run, reference, exposure, now);
        return {
          sessionId: session,
          runId: run,
          referenceId: reference,
          exposure,
          createdAt: now,
        };
      }
      if (existing.exposure === "full" || exposure === "snippet") {
        return {
          sessionId: session,
          runId: run,
          referenceId: reference,
          exposure: existing.exposure as "snippet" | "full",
          createdAt: existing.created_at,
        };
      }
      db.prepare(
        "UPDATE evidence_grants SET exposure = 'full' WHERE run_id = ? AND reference_id = ?",
      ).run(run, reference);
      return {
        sessionId: session,
        runId: run,
        referenceId: reference,
        exposure: "full" as const,
        createdAt: existing.created_at,
      };
    });
  }

  function listEvidenceGrants(runId: string): EvidenceGrantRow[] {
    const id = requireId(runId, "runId");
    if (readRun(db, id) === null) {
      throw new RepositoryNotFoundError(`run ${id} not found`);
    }
    const rows = db
      .prepare(
        "SELECT session_id, run_id, reference_id, exposure, created_at FROM evidence_grants WHERE run_id = ? ORDER BY created_at ASC, reference_id ASC",
      )
      .all(id) as Array<{
      session_id: string;
      run_id: string;
      reference_id: string;
      exposure: string;
      created_at: number;
    }>;
    return rows.map((row) => ({
      sessionId: row.session_id,
      runId: row.run_id,
      referenceId: row.reference_id,
      exposure: row.exposure as "snippet" | "full",
      createdAt: row.created_at,
    }));
  }

  /* ---------------------------------------------------------------- */
  /* Conversation-memory outbox (remind CLI integration, migration 0008) */
  /* ---------------------------------------------------------------- */
  //
  // Companion-owned durable queue only: remind stays a separate
  // process/database and is never imported or opened here. Crash/unknown
  // outcome replay reuses the stable idempotency key, so the same logical
  // write never mints a duplicate CLI request.

  function requireMemoryToken(value: unknown, what: string): string {
    if (typeof value !== "string" || value.length < 1 || value.length > 256) {
      throw new RepositoryValidationError(`${what} must be 1..256 chars`);
    }
    for (const unit of value) {
      const code = unit.codePointAt(0) ?? 0;
      if ((code >= 0x00 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f)) {
        throw new RepositoryValidationError(
          `${what} must not contain controls`,
        );
      }
    }
    return value;
  }

  function requireMemoryScope(value: unknown): string {
    return requireMemoryToken(value, "scope");
  }

  function requireMemoryCitation(value: unknown): string {
    if (typeof value !== "string" || !/^m[1-9][0-9]*$/.test(value)) {
      throw new RepositoryValidationError(
        "citation must be a structural mN identifier",
      );
    }
    return value;
  }

  /** Closed recall-item provenance kind validation (I04; additive; 0022 adds correction). */
  function parseMemoryRecallItemKind(
    value: unknown,
  ): MemoryRecallItemKind | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (
      value === "user_fact" ||
      value === "model_inference" ||
      value === "summary" ||
      value === "correction"
    ) {
      return value;
    }
    throw new RepositoryValidationError("memory kind is invalid");
  }

  /** Positive safe-integer revision validation (I04; additive). */
  function parseMemoryRevision(value: unknown): number | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (
      typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 1
    ) {
      return value;
    }
    throw new RepositoryValidationError(
      "memory revision must be a positive safe integer",
    );
  }

  function requireMemoryKind(value: unknown): MemoryJobKind {
    if (
      value !== "event.append" &&
      value !== "record.remember" &&
      value !== "record.feedback" &&
      value !== "maintain.distill" &&
      value !== "record.correct" &&
      value !== "record.retire" &&
      value !== "record.reactivate"
    ) {
      throw new RepositoryValidationError("memory job kind is invalid");
    }
    return value;
  }

  function parseMemoryJobRow(row: RawMemoryJob): MemoryJobRow {
    return {
      id: row.id,
      kind: row.kind as MemoryJobKind,
      sessionId: row.session_id,
      runId: row.run_id,
      turnId: row.turn_id,
      eventId: row.event_id,
      scope: row.scope,
      idempotencyKey: row.idempotency_key,
      requestJson: row.request_json,
      status: row.status as "pending" | "acked" | "failed",
      attempts: row.attempts,
      nextDueAt: row.next_due_at,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function enqueueMemoryJob(
    kind: unknown,
    sessionId: string,
    runId: string,
    scope: unknown,
    idempotencyKey: string,
    requestJson: string,
    options: EnqueueMemoryJobOptions = {},
  ): { row: MemoryJobRow; deduplicated: boolean } {
    const validKind = requireMemoryKind(kind);
    const session = requireId(sessionId, "sessionId");
    const run = requireId(runId, "runId");
    const validScope = requireMemoryScope(scope);
    const key = requireKey(idempotencyKey);
    if (typeof requestJson !== "string" || requestJson.length < 1) {
      throw new RepositoryValidationError("requestJson must be non-empty");
    }
    parseOrValidation(
      () => JSON.parse(requestJson) as unknown,
      "memory requestJson",
    );
    const turnId =
      options.turnId === undefined ? null : requireId(options.turnId, "turnId");
    const eventId =
      options.eventId === undefined
        ? null
        : requireMemoryToken(options.eventId, "eventId");
    const now = nowMs(options.now);
    return withImmediate(db, () => {
      const existing = db
        .prepare("SELECT * FROM memory_outbox WHERE idempotency_key = ?")
        .get(key) as RawMemoryJob | undefined;
      if (existing !== undefined) {
        return { row: parseMemoryJobRow(existing), deduplicated: true };
      }
      const id = generateId();
      db.prepare(
        "INSERT INTO memory_outbox (id, kind, session_id, run_id, turn_id, event_id, scope, idempotency_key, request_json, status, attempts, next_due_at, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, ?, ?)",
      ).run(
        id,
        validKind,
        session,
        run,
        turnId,
        eventId,
        validScope,
        key,
        requestJson,
        now,
        now,
        now,
      );
      const row = db
        .prepare("SELECT * FROM memory_outbox WHERE id = ?")
        .get(id) as RawMemoryJob;
      return { row: parseMemoryJobRow(row), deduplicated: false };
    });
  }

  function getMemoryJob(id: string): MemoryJobRow | null {
    const row = db
      .prepare("SELECT * FROM memory_outbox WHERE id = ?")
      .get(requireId(id, "id")) as RawMemoryJob | undefined;
    return row === undefined ? null : parseMemoryJobRow(row);
  }

  function claimDueMemoryJobs(limit: number, now?: number): MemoryJobRow[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new RepositoryValidationError("limit must be 1..100");
    }
    const at = nowMs(now);
    const rows = db
      .prepare(
        "SELECT * FROM memory_outbox WHERE status = 'pending' AND next_due_at <= ? ORDER BY next_due_at ASC, id ASC LIMIT ?",
      )
      .all(at, limit) as RawMemoryJob[];
    return rows.map(parseMemoryJobRow);
  }

  function ackMemoryJob(id: string, options: TransitionOptions = {}): void {
    const now = nowMs(options.now);
    withImmediate(db, () => {
      const moved = db
        .prepare(
          "UPDATE memory_outbox SET status = 'acked', updated_at = ? WHERE id = ? AND status = 'pending'",
        )
        .run(now, requireId(id, "id"));
      if (moved.changes !== 1) {
        const row = db
          .prepare("SELECT status FROM memory_outbox WHERE id = ?")
          .get(id) as { status: string } | undefined;
        if (row === undefined) {
          throw new RepositoryNotFoundError(`memory job ${id} not found`);
        }
        // Already acked/failed: state-idempotent no-op (replay safe).
      }
    });
  }

  function failMemoryJob(
    id: string,
    errorCode: string,
    options: FailMemoryJobOptions = {},
  ): { status: "pending" | "failed" } {
    if (
      typeof errorCode !== "string" ||
      !/^[a-z][a-z0-9_]{0,63}$/.test(errorCode)
    ) {
      throw new RepositoryValidationError("errorCode must be a fixed code");
    }
    const maxAttempts =
      options.maxAttempts === undefined ? 8 : options.maxAttempts;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new RepositoryValidationError("maxAttempts must be >= 1");
    }
    const now = nowMs(options.now);
    return withImmediate(db, () => {
      const row = db
        .prepare("SELECT * FROM memory_outbox WHERE id = ?")
        .get(requireId(id, "id")) as RawMemoryJob | undefined;
      if (row === undefined) {
        throw new RepositoryNotFoundError(`memory job ${id} not found`);
      }
      if (row.status !== "pending") {
        return { status: row.status as "pending" | "failed" };
      }
      const attempts = row.attempts + 1;
      if (attempts >= maxAttempts) {
        db.prepare(
          "UPDATE memory_outbox SET status = 'failed', attempts = ?, last_error = ?, updated_at = ? WHERE id = ?",
        ).run(attempts, errorCode, now, id);
        return { status: "failed" as const };
      }
      const delay = Math.min(1000 * 2 ** Math.min(attempts, 6), 60_000);
      db.prepare(
        "UPDATE memory_outbox SET attempts = ?, next_due_at = ?, last_error = ?, updated_at = ? WHERE id = ?",
      ).run(attempts, now + delay, errorCode, now, id);
      return { status: "pending" as const };
    });
  }

  function countPendingMemoryJobs(now?: number): number {
    const at = nowMs(now);
    const row = db
      .prepare(
        "SELECT COUNT(*) AS n FROM memory_outbox WHERE status = 'pending' AND next_due_at <= ?",
      )
      .get(at) as { n: number };
    return row.n;
  }

  /**
   * Every `pending` outbox job, INCLUDING ones whose bounded retry backoff
   * has not expired yet. Used by derived maintenance to defer work that
   * must observe all acknowledged writes (e.g. association after remember).
   */
  function countOutstandingMemoryJobs(): number {
    const row = db
      .prepare(
        "SELECT COUNT(*) AS n FROM memory_outbox WHERE status = 'pending'",
      )
      .get() as { n: number };
    return row.n;
  }

  /**
   * Immutable recall-exposure snapshot: one row per actually exposed
   * (recallId, recordId). INSERT OR IGNORE keeps replays idempotent and
   * never updates an existing snapshot row. I04: the delivered revision
   * and provenance kind are pinned here at exposure time (additive,
   * undefined = unknown); rows are immutable after creation.
   */
  /**
   * Record one completed background-maintenance pass. The counts are the
   * SAME fixed numeric summaries the service logs (no bodies/text), and the
   * retention sweep keeps the newest 2000 rows and drops anything older
   * than 30 days in the same transaction.
   */
  function insertMemoryMaintenanceRun(
    input: MemoryMaintenanceRunInput,
  ): MemoryMaintenanceRun {
    if (
      typeof input !== "object" ||
      input === null ||
      !MEMORY_MAINTENANCE_OPS.includes(input.op)
    ) {
      throw new RepositoryValidationError("maintenance op is invalid");
    }
    if (
      typeof input.scope !== "string" ||
      input.scope.length < 1 ||
      input.scope.length > 128
    ) {
      throw new RepositoryValidationError("maintenance scope is invalid");
    }
    const startedAt = nowMs(input.startedAt);
    const finishedAt = nowMs(input.finishedAt);
    if (finishedAt < startedAt) {
      throw new RepositoryValidationError(
        "maintenance finishedAt precedes startedAt",
      );
    }
    if (typeof input.ok !== "boolean") {
      throw new RepositoryValidationError("maintenance ok must be a boolean");
    }
    const errorCode = input.errorCode ?? null;
    if (input.ok) {
      if (errorCode !== null) {
        throw new RepositoryValidationError(
          "successful maintenance run cannot carry an error code",
        );
      }
    } else if (
      typeof errorCode !== "string" ||
      !/^[a-z][a-z0-9_]{0,63}$/.test(errorCode)
    ) {
      throw new RepositoryValidationError(
        "failed maintenance run requires a fixed error code",
      );
    }
    const counts = parseMaintenanceCounts(input.op, input.counts);
    const createdAt = finishedAt;
    const id = generateId();
    return withImmediate(db, () => {
      db.prepare(
        "INSERT INTO memory_maintenance_runs (id, op, scope, started_at, finished_at, ok, error_code, counts_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        id,
        input.op,
        input.scope,
        startedAt,
        finishedAt,
        input.ok ? 1 : 0,
        errorCode,
        JSON.stringify(counts),
        createdAt,
      );
      db.prepare(
        "DELETE FROM memory_maintenance_runs WHERE created_at < ?",
      ).run(createdAt - MEMORY_MAINTENANCE_RETENTION_MS);
      db.prepare(
        "DELETE FROM memory_maintenance_runs WHERE id IN (SELECT id FROM memory_maintenance_runs ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?)",
      ).run(MEMORY_MAINTENANCE_RETENTION_ROWS);
      const row = db
        .prepare("SELECT * FROM memory_maintenance_runs WHERE id = ?")
        .get(id) as RawMemoryMaintenanceRun;
      return parseMaintenanceRunRow(row);
    });
  }

  /** Newest-first bounded keyset page of completed maintenance runs. */
  function listMemoryMaintenanceRuns(
    query: { limit?: number; cursor?: string } = {},
  ): MemoryMaintenanceRunListResponse {
    const limit = query.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new RepositoryValidationError("limit must be 1..100");
    }
    const bound =
      query.cursor === undefined ? null : decodeMaintenanceCursor(query.cursor);
    const rows =
      bound === null
        ? (db
            .prepare(
              "SELECT * FROM memory_maintenance_runs ORDER BY created_at DESC, id DESC LIMIT ?",
            )
            .all(limit + 1) as RawMemoryMaintenanceRun[])
        : (db
            .prepare(
              "SELECT * FROM memory_maintenance_runs WHERE (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?",
            )
            .all(
              bound.createdAt,
              bound.createdAt,
              bound.id,
              limit + 1,
            ) as RawMemoryMaintenanceRun[]);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const items = page.map(parseMaintenanceRunRow);
    const last = page[page.length - 1];
    return {
      items,
      nextCursor:
        hasMore && last !== undefined
          ? encodeMaintenanceCursor(last.created_at, last.id)
          : null,
      hasMore,
    };
  }

  /**
   * Per-op totals for the last 24h/7d plus the latest run per op. Reads at
   * most the retained 2000 rows; no unbounded scan.
   */
  function memoryMaintenanceSummary(at?: number): MemoryMaintenanceSummary {
    const generatedAt = nowMs(at);
    const rows = db
      .prepare(
        "SELECT * FROM memory_maintenance_runs ORDER BY created_at DESC, id DESC",
      )
      .all() as RawMemoryMaintenanceRun[];
    const emptyOps = (): Record<
      MemoryMaintenanceOp,
      MemoryMaintenanceOpWindow
    > => {
      const ops = {} as Record<MemoryMaintenanceOp, MemoryMaintenanceOpWindow>;
      for (const op of MEMORY_MAINTENANCE_OPS) {
        ops[op] = { runs: 0, failed: 0, counts: {} };
      }
      return ops;
    };
    const last24h = {
      runs: 0,
      failed: 0,
      ops: emptyOps(),
    };
    const last7d = {
      runs: 0,
      failed: 0,
      ops: emptyOps(),
    };
    const latestByOp = {} as MemoryMaintenanceSummary["latestByOp"];
    for (const op of MEMORY_MAINTENANCE_OPS) {
      latestByOp[op] = null;
    }
    const cutoff24 = generatedAt - 24 * 60 * 60 * 1000;
    const cutoff7 = generatedAt - 7 * 24 * 60 * 60 * 1000;
    for (const raw of rows) {
      const run = parseMaintenanceRunRow(raw);
      if (latestByOp[run.op] === null) {
        latestByOp[run.op] = {
          finishedAt: run.finishedAt,
          ok: run.ok,
          errorCode: run.errorCode,
          counts: run.counts,
        };
      }
      for (const window of [
        { since: cutoff24, target: last24h },
        { since: cutoff7, target: last7d },
      ]) {
        if (run.createdAt < window.since) {
          continue;
        }
        const bucket = window.target.ops[run.op];
        window.target.runs += 1;
        bucket.runs += 1;
        if (!run.ok) {
          window.target.failed += 1;
          bucket.failed += 1;
        }
        for (const [key, value] of Object.entries(run.counts)) {
          bucket.counts[key] = (bucket.counts[key] ?? 0) + value;
        }
      }
    }
    return { generatedAt, windows: { last24h, last7d }, latestByOp };
  }

  function recordMemoryExposure(
    exposure: MemoryExposureInput,
    options: TransitionOptions = {},
  ): void {
    const recallId = requireMemoryToken(exposure.recallId, "recallId");
    const recordId = requireMemoryToken(exposure.recordId, "recordId");
    const sessionId = requireId(exposure.sessionId, "sessionId");
    const runId = requireId(exposure.runId, "runId");
    const scope = requireMemoryScope(exposure.scope);
    const citation = requireMemoryCitation(exposure.citation);
    const revision = parseMemoryRevision(exposure.revision);
    const kind = parseMemoryRecallItemKind(exposure.kind);
    if (
      typeof exposure.snippet !== "string" ||
      exposure.snippet.length < 1 ||
      Array.from(exposure.snippet).length > 512
    ) {
      throw new RepositoryValidationError("snippet must be 1..512 code points");
    }
    const now = nowMs(options.now);
    db.prepare(
      "INSERT OR IGNORE INTO memory_exposures (recall_id, record_id, session_id, run_id, scope, citation, snippet, revision, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      recallId,
      recordId,
      sessionId,
      runId,
      scope,
      citation,
      exposure.snippet,
      revision === undefined ? null : revision,
      kind === undefined ? null : kind,
      now,
    );
  }

  function listMemoryExposures(runId: string): MemoryExposureRow[] {
    const rows = db
      .prepare(
        "SELECT recall_id, record_id, session_id, run_id, scope, citation, snippet, revision, kind, created_at FROM memory_exposures WHERE run_id = ? ORDER BY citation ASC, record_id ASC",
      )
      .all(requireId(runId, "runId")) as Array<{
      recall_id: string;
      record_id: string;
      session_id: string;
      run_id: string;
      scope: string;
      citation: string;
      snippet: string;
      revision: number | null;
      kind: string | null;
      created_at: number;
    }>;
    return rows.map((row) => ({
      recallId: row.recall_id,
      recordId: row.record_id,
      sessionId: row.session_id,
      runId: row.run_id,
      scope: row.scope,
      citation: row.citation,
      snippet: row.snippet,
      revision: row.revision,
      kind:
        row.kind === "user_fact" ||
        row.kind === "model_inference" ||
        row.kind === "summary" ||
        row.kind === "correction"
          ? row.kind
          : null,
      createdAt: row.created_at,
    }));
  }

  /**
   * Explicit per-run memory status (I01-06, additive): metadata only over a
   * closed union, never memory content. Recall happens at most once per run
   * attempt, so a plain UPDATE is idempotent in practice; a run that never
   * reaches the recall boundary keeps NULL. Unknown run ids are rejected
   * like every other row write. Best-effort at the call site: the marker
   * never fails the run (memoryless continuation is preserved).
   */
  function recordRunMemoryStatus(runId: string, status: RunMemoryStatus): void {
    const id = requireId(runId, "runId");
    const valid = parseOrValidation(
      () => RunMemoryStatusSchema.parse(status),
      "run memory status",
    );
    const moved = db
      .prepare("UPDATE runs SET memory_status = ? WHERE id = ?")
      .run(valid, id);
    if (moved.changes !== 1) {
      throw new RepositoryNotFoundError(`run ${id} not found`);
    }
  }

  /**
   * Bind an accepted completed run's cited `mN` to its exposed record.
   * Only citations present in the accepted answer's citation arrays may
   * call this (the service parses citation arrays, never prose): mere
   * recall exposure or textual mentions never insert here. Scope must
   * equal the exposure scope (cross-scope grants rejected). INSERT OR
   * IGNORE keeps completion replays idempotent. I04: the grant's revision
   * is COPIED from the same-run exposure (citation pinned to the
   * delivered revision); grants are immutable after creation — no UPDATE
   * path ever rewrites this column.
   */
  function grantMemoryCitation(
    grant: MemoryGrantInput,
    options: TransitionOptions = {},
  ): void {
    const runId = requireId(grant.runId, "runId");
    const citation = requireMemoryCitation(grant.citation);
    const recordId = requireMemoryToken(grant.recordId, "recordId");
    const recallId = requireMemoryToken(grant.recallId, "recallId");
    const sessionId = requireId(grant.sessionId, "sessionId");
    const scope = requireMemoryScope(grant.scope);
    const now = nowMs(options.now);
    withImmediate(db, () => {
      const exposure = db
        .prepare(
          "SELECT scope, revision FROM memory_exposures WHERE recall_id = ? AND record_id = ? AND run_id = ? AND citation = ?",
        )
        .get(recallId, recordId, runId, citation) as
        | { scope: string; revision: number | null }
        | undefined;
      if (exposure === undefined) {
        throw new RepositoryValidationError(
          "memory grant requires a matching exposure",
        );
      }
      if (exposure.scope !== scope) {
        throw new RepositoryValidationError(
          "memory grant scope must match the exposure scope",
        );
      }
      db.prepare(
        "INSERT OR IGNORE INTO memory_grants (run_id, citation, record_id, recall_id, session_id, scope, revision, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        runId,
        citation,
        recordId,
        recallId,
        sessionId,
        scope,
        exposure.revision,
        now,
      );
    });
  }

  function listMemoryGrants(runId: string): MemoryGrantRow[] {
    const rows = db
      .prepare(
        "SELECT run_id, citation, record_id, recall_id, session_id, scope, revision, created_at FROM memory_grants WHERE run_id = ? ORDER BY citation ASC",
      )
      .all(requireId(runId, "runId")) as Array<{
      run_id: string;
      citation: string;
      record_id: string;
      recall_id: string;
      session_id: string;
      scope: string;
      revision: number | null;
      created_at: number;
    }>;
    return rows.map((row) => ({
      runId: row.run_id,
      citation: row.citation,
      recordId: row.record_id,
      recallId: row.recall_id,
      sessionId: row.session_id,
      scope: row.scope,
      revision: row.revision,
      createdAt: row.created_at,
    }));
  }

  /* ---------------------------------------------------------------- */
  /* Explicit memory management (migration 0009): immutable search     */
  /* snapshots + durable operation status. Search snapshots are never */
  /* rewritten; operations mirror their outbox job ack/fail.          */
  /* ---------------------------------------------------------------- */

  function requireMemoryOperationKind(value: unknown): MemoryOperationKind {
    if (
      value !== "record.correct" &&
      value !== "record.retire" &&
      value !== "record.reactivate"
    ) {
      throw new RepositoryValidationError("memory operation kind is invalid");
    }
    return value;
  }

  function requireMemoryRevision(value: unknown): number {
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < 1 ||
      value > 1_000_000
    ) {
      throw new RepositoryValidationError("revision must be an integer >= 1");
    }
    return value;
  }

  /**
   * Persist one explicit search and its immutable per-handle snapshot rows.
   * INSERT OR IGNORE: replays never rewrite a historical snapshot, and a
   * redelivered search id keeps the FIRST snapshot rows.
   */
  function recordMemorySearch(
    input: {
      searchId: string;
      sessionId: string;
      runId: string;
      scope: string;
      query: string;
      items: Array<{
        handle: string;
        recordId: string;
        revision: number | null;
        status: string;
        snippet: string;
      }>;
    },
    options: TransitionOptions = {},
  ): void {
    const searchId = requireMemoryToken(input.searchId, "searchId");
    const sessionId = requireId(input.sessionId, "sessionId");
    const runId = requireId(input.runId, "runId");
    const scope = requireMemoryScope(input.scope);
    if (
      typeof input.query !== "string" ||
      input.query.length < 1 ||
      Array.from(input.query).length > 500
    ) {
      throw new RepositoryValidationError("query must be 1..500 code points");
    }
    if (!Array.isArray(input.items) || input.items.length > 8) {
      throw new RepositoryValidationError("items must be 0..8 entries");
    }
    const now = nowMs(options.now);
    withImmediate(db, () => {
      db.prepare(
        "INSERT OR IGNORE INTO memory_searches (search_id, session_id, run_id, scope, query, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(searchId, sessionId, runId, scope, input.query, now);
      for (const item of input.items) {
        const handle = requireMemoryCitation(item.handle);
        const recordId = requireMemoryToken(item.recordId, "recordId");
        if (item.status !== "active" && item.status !== "retired") {
          throw new RepositoryValidationError(
            "search item status must be active or retired",
          );
        }
        if (
          typeof item.snippet !== "string" ||
          item.snippet.length < 1 ||
          Array.from(item.snippet).length > 512
        ) {
          throw new RepositoryValidationError(
            "snippet must be 1..512 code points",
          );
        }
        const revision =
          item.revision === null ? null : requireMemoryRevision(item.revision);
        if (revision === null) {
          db.prepare(
            "INSERT OR IGNORE INTO memory_search_items (search_id, handle, record_id, revision, status, snippet, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?)",
          ).run(searchId, handle, recordId, item.status, item.snippet, now);
        } else {
          db.prepare(
            "INSERT OR IGNORE INTO memory_search_items (search_id, handle, record_id, revision, status, snippet, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          ).run(
            searchId,
            handle,
            recordId,
            revision,
            item.status,
            item.snippet,
            now,
          );
        }
      }
    });
  }

  function getMemorySearch(searchId: string): {
    searchId: string;
    sessionId: string;
    runId: string;
    scope: string;
    query: string;
    createdAt: number;
  } | null {
    const row = db
      .prepare(
        "SELECT search_id, session_id, run_id, scope, query, created_at FROM memory_searches WHERE search_id = ?",
      )
      .get(requireMemoryToken(searchId, "searchId")) as
      | {
          search_id: string;
          session_id: string;
          run_id: string;
          scope: string;
          query: string;
          created_at: number;
        }
      | undefined;
    return row === undefined
      ? null
      : {
          searchId: row.search_id,
          sessionId: row.session_id,
          runId: row.run_id,
          scope: row.scope,
          query: row.query,
          createdAt: row.created_at,
        };
  }

  function listMemorySearchItems(searchId: string): MemorySearchItemRow[] {
    const rows = db
      .prepare(
        "SELECT search_id, handle, record_id, revision, status, snippet, created_at FROM memory_search_items WHERE search_id = ? ORDER BY handle ASC",
      )
      .all(requireMemoryToken(searchId, "searchId")) as Array<{
      search_id: string;
      handle: string;
      record_id: string;
      revision: number | null;
      status: string;
      snippet: string;
      created_at: number;
    }>;
    return rows.map((row) => ({
      searchId: row.search_id,
      handle: row.handle,
      recordId: row.record_id,
      revision: row.revision,
      status: row.status,
      snippet: row.snippet,
      createdAt: row.created_at,
    }));
  }

  function getMemorySearchItem(
    searchId: string,
    handle: string,
  ): MemorySearchItemRow | null {
    const row = db
      .prepare(
        "SELECT search_id, handle, record_id, revision, status, snippet, created_at FROM memory_search_items WHERE search_id = ? AND handle = ?",
      )
      .get(
        requireMemoryToken(searchId, "searchId"),
        requireMemoryCitation(handle),
      ) as
      | {
          search_id: string;
          handle: string;
          record_id: string;
          revision: number | null;
          status: string;
          snippet: string;
          created_at: number;
        }
      | undefined;
    return row === undefined
      ? null
      : {
          searchId: row.search_id,
          handle: row.handle,
          recordId: row.record_id,
          revision: row.revision,
          status: row.status,
          snippet: row.snippet,
          createdAt: row.created_at,
        };
  }

  /**
   * Return the durable graph search id for one (session, scope) or create
   * it. The row is a NORMAL `memory_searches` row with query='graph' so
   * the existing snapshot/detail/mutation routes work unchanged.
   */
  function getOrCreateMemoryGraphSearch(
    input: {
      searchId: string;
      sessionId: string;
      runId: string;
      scope: string;
    },
    options: TransitionOptions = {},
  ): string {
    const candidate = requireMemoryToken(input.searchId, "searchId");
    const sessionId = requireId(input.sessionId, "sessionId");
    const runId = requireId(input.runId, "runId");
    const scope = requireMemoryScope(input.scope);
    const now = nowMs(options.now);
    return withImmediate(db, () => {
      const existing = db
        .prepare(
          "SELECT search_id FROM memory_graph_searches WHERE session_id = ? AND scope = ?",
        )
        .get(sessionId, scope) as { search_id: string } | undefined;
      if (existing !== undefined) {
        return existing.search_id;
      }
      const collision = db
        .prepare(
          "SELECT session_id, query FROM memory_searches WHERE search_id = ?",
        )
        .get(candidate) as { session_id: string; query: string } | undefined;
      if (collision !== undefined) {
        throw new RepositoryValidationError(
          "graph search id already belongs to another snapshot",
        );
      }
      db.prepare(
        "INSERT INTO memory_searches (search_id, session_id, run_id, scope, query, created_at) VALUES (?, ?, ?, ?, 'graph', ?)",
      ).run(candidate, sessionId, runId, scope, now);
      db.prepare(
        "INSERT INTO memory_graph_searches (session_id, scope, search_id, created_at) VALUES (?, ?, ?, ?)",
      ).run(sessionId, scope, candidate, now);
      return candidate;
    });
  }

  /**
   * Mint/reuse opaque handles for one graph projection into its durable
   * graph search. Reuse key = (record_id, status): an unchanged re-open
   * inserts ZERO rows, while a retired/re-activated record gets a new
   * handle. Existing rows are never rewritten.
   */
  function mintMemoryGraphItems(
    input: {
      searchId: string;
      items: ReadonlyArray<{
        recordId: string;
        status: string;
        snippet: string;
      }>;
    },
    options: TransitionOptions = {},
  ): Array<{
    handle: string;
    recordId: string;
    status: string;
    snippet: string;
  }> {
    const searchId = requireMemoryToken(input.searchId, "searchId");
    if (!Array.isArray(input.items) || input.items.length > 500) {
      throw new RepositoryValidationError("items must be 0..500 entries");
    }
    const now = nowMs(options.now);
    return withImmediate(db, () => {
      const header = db
        .prepare("SELECT search_id FROM memory_searches WHERE search_id = ?")
        .get(searchId) as { search_id: string } | undefined;
      if (header === undefined) {
        throw new RepositoryValidationError("graph search does not exist");
      }
      const rows = db
        .prepare(
          "SELECT handle, record_id, status FROM memory_search_items WHERE search_id = ?",
        )
        .all(searchId) as Array<{
        handle: string;
        record_id: string;
        status: string;
      }>;
      let maxHandle = 0;
      const byRecordStatus = new Map<string, string>();
      for (const row of rows) {
        const ordinal = Number.parseInt(row.handle.slice(1), 10);
        if (Number.isInteger(ordinal) && ordinal > maxHandle) {
          maxHandle = ordinal;
        }
        const key = `${row.record_id}\u0000${row.status}`;
        if (!byRecordStatus.has(key)) {
          byRecordStatus.set(key, row.handle);
        }
      }
      const out: Array<{
        handle: string;
        recordId: string;
        status: string;
        snippet: string;
      }> = [];
      for (const item of input.items) {
        const recordId = requireMemoryToken(item.recordId, "recordId");
        if (item.status !== "active" && item.status !== "retired") {
          throw new RepositoryValidationError(
            "graph node status must be active or retired",
          );
        }
        if (
          typeof item.snippet !== "string" ||
          item.snippet.length < 1 ||
          Array.from(item.snippet).length > 512
        ) {
          throw new RepositoryValidationError(
            "graph node label must be 1..512 code points",
          );
        }
        const key = `${recordId}\u0000${item.status}`;
        let handle = byRecordStatus.get(key);
        if (handle === undefined) {
          maxHandle += 1;
          handle = `m${maxHandle}`;
          db.prepare(
            "INSERT INTO memory_search_items (search_id, handle, record_id, revision, status, snippet, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?)",
          ).run(searchId, handle, recordId, item.status, item.snippet, now);
          byRecordStatus.set(key, handle);
        }
        out.push({
          handle,
          recordId,
          status: item.status,
          snippet: item.snippet,
        });
      }
      return out;
    });
  }

  function parseMemoryOperationRow(row: {
    id: string;
    kind: string;
    session_id: string;
    run_id: string;
    search_id: string | null;
    handle: string | null;
    record_id: string;
    revision: number | null;
    job_id: string;
    idempotency_key: string;
    request_hash: string;
    status: string;
    created_at: number;
    updated_at: number;
  }): MemoryOperationRow {
    return {
      id: row.id,
      kind: row.kind as MemoryOperationKind,
      sessionId: row.session_id,
      runId: row.run_id,
      searchId: row.search_id,
      handle: row.handle,
      recordId: row.record_id,
      revision: row.revision,
      jobId: row.job_id,
      idempotencyKey: row.idempotency_key,
      requestHash: row.request_hash,
      status: row.status as "pending" | "acked" | "failed",
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Stage one management operation durably (202 ack, never "applied" while
   * queued). Same key + same request hash replays the stored row; same key
   * + drifted body throws IdempotencyConflictError (409, no silent rebind).
   */
  function createMemoryOperation(
    input: {
      kind: unknown;
      sessionId: string;
      runId: string;
      searchId?: string | null;
      handle?: string | null;
      recordId: string;
      revision?: number | null;
      jobId: string;
      idempotencyKey: string;
      requestHash: string;
    },
    options: TransitionOptions = {},
  ): { row: MemoryOperationRow; deduplicated: boolean } {
    const kind = requireMemoryOperationKind(input.kind);
    const sessionId = requireId(input.sessionId, "sessionId");
    const runId = requireId(input.runId, "runId");
    const searchId =
      input.searchId === undefined || input.searchId === null
        ? null
        : requireMemoryToken(input.searchId, "searchId");
    const handle =
      input.handle === undefined || input.handle === null
        ? null
        : requireMemoryCitation(input.handle);
    const recordId = requireMemoryToken(input.recordId, "recordId");
    const revision =
      input.revision === undefined || input.revision === null
        ? null
        : requireMemoryRevision(input.revision);
    const jobId = requireId(input.jobId, "jobId");
    const key = requireKey(input.idempotencyKey);
    if (
      typeof input.requestHash !== "string" ||
      input.requestHash.length < 1 ||
      input.requestHash.length > 512
    ) {
      throw new RepositoryValidationError("requestHash must be non-empty");
    }
    const now = nowMs(options.now);
    return withImmediate(db, () => {
      const existing = db
        .prepare("SELECT * FROM memory_operations WHERE idempotency_key = ?")
        .get(key) as
        | {
            id: string;
            kind: string;
            session_id: string;
            run_id: string;
            search_id: string | null;
            handle: string | null;
            record_id: string;
            revision: number | null;
            job_id: string;
            idempotency_key: string;
            request_hash: string;
            status: string;
            created_at: number;
            updated_at: number;
          }
        | undefined;
      if (existing !== undefined) {
        if (existing.request_hash !== input.requestHash) {
          throw new IdempotencyConflictError(`memory-operation:${existing.id}`);
        }
        return {
          row: parseMemoryOperationRow(existing),
          deduplicated: true,
        };
      }
      const id = generateId();
      db.prepare(
        "INSERT INTO memory_operations (id, kind, session_id, run_id, search_id, handle, record_id, revision, job_id, idempotency_key, request_hash, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
      ).run(
        id,
        kind,
        sessionId,
        runId,
        searchId,
        handle,
        recordId,
        revision,
        jobId,
        key,
        input.requestHash,
        now,
        now,
      );
      const row = db
        .prepare("SELECT * FROM memory_operations WHERE id = ?")
        .get(id) as {
        id: string;
        kind: string;
        session_id: string;
        run_id: string;
        search_id: string | null;
        handle: string | null;
        record_id: string;
        revision: number | null;
        job_id: string;
        idempotency_key: string;
        request_hash: string;
        status: string;
        created_at: number;
        updated_at: number;
      };
      return { row: parseMemoryOperationRow(row), deduplicated: false };
    });
  }

  function getMemoryOperation(id: string): MemoryOperationRow | null {
    const row = db
      .prepare("SELECT * FROM memory_operations WHERE id = ?")
      .get(requireId(id, "id")) as
      | {
          id: string;
          kind: string;
          session_id: string;
          run_id: string;
          search_id: string | null;
          handle: string | null;
          record_id: string;
          revision: number | null;
          job_id: string;
          idempotency_key: string;
          request_hash: string;
          status: string;
          created_at: number;
          updated_at: number;
        }
      | undefined;
    return row === undefined ? null : parseMemoryOperationRow(row);
  }

  function getMemoryOperationByKey(
    idempotencyKey: string,
  ): MemoryOperationRow | null {
    const row = db
      .prepare("SELECT * FROM memory_operations WHERE idempotency_key = ?")
      .get(requireKey(idempotencyKey)) as
      | {
          id: string;
          kind: string;
          session_id: string;
          run_id: string;
          search_id: string | null;
          handle: string | null;
          record_id: string;
          revision: number | null;
          job_id: string;
          idempotency_key: string;
          request_hash: string;
          status: string;
          created_at: number;
          updated_at: number;
        }
      | undefined;
    return row === undefined ? null : parseMemoryOperationRow(row);
  }

  /** Mirror an outbox job ack/fail onto its management operation row. */
  function setMemoryOperationStatus(
    id: string,
    status: "pending" | "acked" | "failed",
    options: TransitionOptions = {},
  ): void {
    if (status !== "pending" && status !== "acked" && status !== "failed") {
      throw new RepositoryValidationError("operation status is invalid");
    }
    const now = nowMs(options.now);
    withImmediate(db, () => {
      const moved = db
        .prepare(
          "UPDATE memory_operations SET status = ?, updated_at = ? WHERE id = ?",
        )
        .run(status, now, requireId(id, "id"));
      if (moved.changes !== 1) {
        throw new RepositoryNotFoundError(`memory operation ${id} not found`);
      }
    });
  }

  function setMemoryOperationStatusByJob(
    jobId: string,
    status: "pending" | "acked" | "failed",
    options: TransitionOptions = {},
  ): void {
    const now = nowMs(options.now);
    db.prepare(
      "UPDATE memory_operations SET status = ?, updated_at = ? WHERE job_id = ?",
    ).run(status, now, requireId(jobId, "jobId"));
  }

  /** Rebind an operation to its follow-up job (correction event -> correct). */
  function setMemoryOperationJob(
    id: string,
    jobId: string,
    options: TransitionOptions = {},
  ): void {
    const now = nowMs(options.now);
    withImmediate(db, () => {
      const moved = db
        .prepare(
          "UPDATE memory_operations SET job_id = ?, updated_at = ? WHERE id = ?",
        )
        .run(requireId(jobId, "jobId"), now, requireId(id, "id"));
      if (moved.changes !== 1) {
        throw new RepositoryNotFoundError(`memory operation ${id} not found`);
      }
    });
  }

  /**
   * Atomic stage of one management mutation: the initial outbox job row and
   * its durable operation row commit in ONE transaction. A preexisting job
   * key with a DIFFERENT request payload is an idempotency conflict (never
   * silently rebound); a preexisting operation key with a drifted request
   * hash is likewise a conflict. No runnable orphan job and no operation
   * bound to the wrong body can survive a crash between the two inserts.
   */
  function stageMemoryMutationAtomic(
    input: {
      jobKind: unknown;
      jobSessionId: string;
      jobRunId: string;
      jobScope: unknown;
      jobKey: string;
      requestJson: string;
      jobTurnId?: string;
      operation: {
        kind: unknown;
        sessionId: string;
        runId: string;
        searchId?: string | null;
        handle?: string | null;
        recordId: string;
        revision?: number | null;
        idempotencyKey: string;
        requestHash: string;
      };
    },
    options: TransitionOptions = {},
  ): {
    job: MemoryJobRow;
    operation: MemoryOperationRow;
    deduplicated: boolean;
  } {
    const validKind = requireMemoryKind(input.jobKind);
    const jobSession = requireId(input.jobSessionId, "sessionId");
    const jobRun = requireId(input.jobRunId, "runId");
    const validScope = requireMemoryScope(input.jobScope);
    const jobKey = requireKey(input.jobKey);
    if (typeof input.requestJson !== "string" || input.requestJson.length < 1) {
      throw new RepositoryValidationError("requestJson must be non-empty");
    }
    parseOrValidation(
      () => JSON.parse(input.requestJson) as unknown,
      "memory requestJson",
    );
    const jobTurnId =
      input.jobTurnId === undefined
        ? null
        : requireId(input.jobTurnId, "turnId");
    const opKind = requireMemoryOperationKind(input.operation.kind);
    const opSession = requireId(input.operation.sessionId, "sessionId");
    const opRun = requireId(input.operation.runId, "runId");
    const opSearch =
      input.operation.searchId === undefined ||
      input.operation.searchId === null
        ? null
        : requireMemoryToken(input.operation.searchId, "searchId");
    const opHandle =
      input.operation.handle === undefined || input.operation.handle === null
        ? null
        : requireMemoryCitation(input.operation.handle);
    const opRecord = requireMemoryToken(input.operation.recordId, "recordId");
    const opRevision =
      input.operation.revision === undefined ||
      input.operation.revision === null
        ? null
        : requireMemoryRevision(input.operation.revision);
    const opKey = requireKey(input.operation.idempotencyKey);
    if (
      typeof input.operation.requestHash !== "string" ||
      input.operation.requestHash.length < 1 ||
      input.operation.requestHash.length > 512
    ) {
      throw new RepositoryValidationError("requestHash must be non-empty");
    }
    const now = nowMs(options.now);
    return withImmediate(db, () => {
      const existingOp = db
        .prepare("SELECT * FROM memory_operations WHERE idempotency_key = ?")
        .get(opKey) as
        | {
            id: string;
            kind: string;
            session_id: string;
            run_id: string;
            search_id: string | null;
            handle: string | null;
            record_id: string;
            revision: number | null;
            job_id: string;
            idempotency_key: string;
            request_hash: string;
            status: string;
            created_at: number;
            updated_at: number;
          }
        | undefined;
      if (existingOp !== undefined) {
        if (existingOp.request_hash !== input.operation.requestHash) {
          throw new IdempotencyConflictError(
            `memory-operation:${existingOp.id}`,
          );
        }
        const boundJob = db
          .prepare("SELECT * FROM memory_outbox WHERE id = ?")
          .get(existingOp.job_id) as RawMemoryJob | undefined;
        if (boundJob === undefined) {
          throw new DatabaseStateInvalidError(
            `memory operation ${existingOp.id} has no bound job`,
          );
        }
        return {
          job: parseMemoryJobRow(boundJob),
          operation: parseMemoryOperationRow(existingOp),
          deduplicated: true,
        };
      }
      const existingJob = db
        .prepare("SELECT * FROM memory_outbox WHERE idempotency_key = ?")
        .get(jobKey) as RawMemoryJob | undefined;
      let jobRow: RawMemoryJob;
      if (existingJob !== undefined) {
        if (existingJob.request_json !== input.requestJson) {
          throw new IdempotencyConflictError(`memory-job:${existingJob.id}`);
        }
        jobRow = existingJob;
      } else {
        const jobId = generateId();
        db.prepare(
          "INSERT INTO memory_outbox (id, kind, session_id, run_id, turn_id, event_id, scope, idempotency_key, request_json, status, attempts, next_due_at, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, 'pending', 0, ?, NULL, ?, ?)",
        ).run(
          jobId,
          validKind,
          jobSession,
          jobRun,
          jobTurnId,
          validScope,
          jobKey,
          input.requestJson,
          now,
          now,
          now,
        );
        jobRow = db
          .prepare("SELECT * FROM memory_outbox WHERE id = ?")
          .get(jobId) as RawMemoryJob;
      }
      const opId = generateId();
      db.prepare(
        "INSERT INTO memory_operations (id, kind, session_id, run_id, search_id, handle, record_id, revision, job_id, idempotency_key, request_hash, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
      ).run(
        opId,
        opKind,
        opSession,
        opRun,
        opSearch,
        opHandle,
        opRecord,
        opRevision,
        jobRow.id,
        opKey,
        input.operation.requestHash,
        now,
        now,
      );
      const opRow = db
        .prepare("SELECT * FROM memory_operations WHERE id = ?")
        .get(opId) as {
        id: string;
        kind: string;
        session_id: string;
        run_id: string;
        search_id: string | null;
        handle: string | null;
        record_id: string;
        revision: number | null;
        job_id: string;
        idempotency_key: string;
        request_hash: string;
        status: string;
        created_at: number;
        updated_at: number;
      };
      return {
        job: parseMemoryJobRow(jobRow),
        operation: parseMemoryOperationRow(opRow),
        deduplicated: existingJob !== undefined,
      };
    });
  }

  /**
   * Atomic correction-chain follow-up: enqueue (or reuse) the real
   * `record.correct` job AND rebind the staged operation to it in ONE
   * transaction. Throws on any failure so the caller never acks the source
   * event while its follow-up is lost. Idempotent: replaying the same
   * source event reuses the same correct job and rebinds again.
   */
  function bindCorrectionFollowupAtomic(
    input: {
      sessionId: string;
      runId: string;
      scope: unknown;
      correctJobKey: string;
      correctRequestJson: string;
      turnId?: string;
      clientKey: string;
    },
    options: TransitionOptions = {},
  ): { correctJobId: string; deduplicated: boolean } {
    const session = requireId(input.sessionId, "sessionId");
    const run = requireId(input.runId, "runId");
    const validScope = requireMemoryScope(input.scope);
    const correctKey = requireKey(input.correctJobKey);
    if (
      typeof input.correctRequestJson !== "string" ||
      input.correctRequestJson.length < 1
    ) {
      throw new RepositoryValidationError("requestJson must be non-empty");
    }
    parseOrValidation(
      () => JSON.parse(input.correctRequestJson) as unknown,
      "memory requestJson",
    );
    const turnId =
      input.turnId === undefined ? null : requireId(input.turnId, "turnId");
    const clientKey = requireKey(input.clientKey);
    const now = nowMs(options.now);
    return withImmediate(db, () => {
      const existing = db
        .prepare("SELECT * FROM memory_outbox WHERE idempotency_key = ?")
        .get(correctKey) as RawMemoryJob | undefined;
      let correctJobId: string;
      let deduplicated = false;
      if (existing !== undefined) {
        if (existing.request_json !== input.correctRequestJson) {
          throw new IdempotencyConflictError(`memory-job:${existing.id}`);
        }
        correctJobId = existing.id;
        deduplicated = true;
      } else {
        correctJobId = generateId();
        db.prepare(
          "INSERT INTO memory_outbox (id, kind, session_id, run_id, turn_id, event_id, scope, idempotency_key, request_json, status, attempts, next_due_at, last_error, created_at, updated_at) VALUES (?, 'record.correct', ?, ?, ?, NULL, ?, ?, ?, 'pending', 0, ?, NULL, ?, ?)",
        ).run(
          correctJobId,
          session,
          run,
          turnId,
          validScope,
          correctKey,
          input.correctRequestJson,
          now,
          now,
          now,
        );
      }
      const operation = db
        .prepare("SELECT * FROM memory_operations WHERE idempotency_key = ?")
        .get(clientKey) as { id: string } | undefined;
      if (operation === undefined) {
        throw new RepositoryNotFoundError(
          `memory operation for key ${clientKey} not found`,
        );
      }
      const moved = db
        .prepare(
          "UPDATE memory_operations SET job_id = ?, updated_at = ? WHERE id = ?",
        )
        .run(correctJobId, now, operation.id);
      if (moved.changes !== 1) {
        throw new RepositoryNotFoundError(
          `memory operation ${operation.id} not found`,
        );
      }
      return { correctJobId, deduplicated };
    });
  }

  /**
   * Atomic job failure + operation mirror: the outbox attempts/status bump
   * and the bound operation's terminal `failed` flip commit together, so an
   * exhausted transient (8 attempts) or a terminal domain rejection can
   * never leave the operation polling `pending` forever. Non-terminal
   * backoff rearms commit without touching the operation. Zero bound rows
   * is a no-op (event/remember/feedback/distill jobs own no operation).
   */
  function failMemoryJobWithOperationMirror(
    id: string,
    errorCode: string,
    options: FailMemoryJobOptions = {},
  ): { status: "pending" | "failed" } {
    if (
      typeof errorCode !== "string" ||
      !/^[a-z][a-z0-9_]{0,63}$/.test(errorCode)
    ) {
      throw new RepositoryValidationError("errorCode must be a fixed code");
    }
    const maxAttempts =
      options.maxAttempts === undefined ? 8 : options.maxAttempts;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new RepositoryValidationError("maxAttempts must be >= 1");
    }
    const now = nowMs(options.now);
    return withImmediate(db, () => {
      const row = db
        .prepare("SELECT * FROM memory_outbox WHERE id = ?")
        .get(requireId(id, "id")) as RawMemoryJob | undefined;
      if (row === undefined) {
        throw new RepositoryNotFoundError(`memory job ${id} not found`);
      }
      if (row.status !== "pending") {
        return { status: row.status as "pending" | "failed" };
      }
      const attempts = row.attempts + 1;
      if (attempts >= maxAttempts) {
        db.prepare(
          "UPDATE memory_outbox SET status = 'failed', attempts = ?, last_error = ?, updated_at = ? WHERE id = ?",
        ).run(attempts, errorCode, now, id);
        db.prepare(
          "UPDATE memory_operations SET status = 'failed', updated_at = ? WHERE job_id = ? AND status = 'pending'",
        ).run(now, id);
        return { status: "failed" as const };
      }
      const delay = Math.min(1000 * 2 ** Math.min(attempts, 6), 60_000);
      db.prepare(
        "UPDATE memory_outbox SET attempts = ?, next_due_at = ?, last_error = ?, updated_at = ? WHERE id = ?",
      ).run(attempts, now + delay, errorCode, now, id);
      return { status: "pending" as const };
    });
  }

  /**
   * Atomic job ack + operation mirror: the outbox `pending -> acked` flip
   * and the bound operation's `acked` flip commit together (management
   * writes only; other kinds match zero operation rows). Already-settled
   * jobs are state-idempotent no-ops.
   */
  function ackMemoryJobWithOperationMirror(
    id: string,
    options: TransitionOptions = {},
  ): void {
    const now = nowMs(options.now);
    withImmediate(db, () => {
      const moved = db
        .prepare(
          "UPDATE memory_outbox SET status = 'acked', updated_at = ? WHERE id = ? AND status = 'pending'",
        )
        .run(now, requireId(id, "id"));
      if (moved.changes !== 1) {
        const row = db
          .prepare("SELECT status FROM memory_outbox WHERE id = ?")
          .get(id) as { status: string } | undefined;
        if (row === undefined) {
          throw new RepositoryNotFoundError(`memory job ${id} not found`);
        }
        return;
      }
      db.prepare(
        "UPDATE memory_operations SET status = 'acked', updated_at = ? WHERE job_id = ? AND status = 'pending'",
      ).run(now, id);
    });
  }

  /* ---------------------------------------------------------------- */
  /* AV autonomy facade (purposes + tasks + stop control).              */
  /*                                                                  */
  /* Ownership: every method below delegates to `autonomy.ts`, the     */
  /* ONLY writer of the autonomy tables. This facade adds the HTTP-    */
  /* facing strict Zod boundary (request schemas, list-query bounds,   */
  /* UUID checks) and returns the kernel `{ status, body, replayed }`  */
  /* shape so routes can replay verbatim. No calendar / scheduling /   */
  /* permission-grant behavior lives here.                             */
  /* AV autonomy slice facade (§AV01). Thin validated delegation to      */
  /* `autonomy.ts` (the ONLY writer of the autonomy tables): Zod on the  */
  /* JSON boundary, session/target ownership enforced inside the         */
  /* transaction BEFORE any idempotency-cache read (foreign ids are 404, */
  /* never 409), version/state checked AFTER the cache so owned terminal */
  /* same-key replay returns the stored body verbatim. A recorded        */
  /* `permission` purpose is ONLY a claim here: no grant, receipt,       */
  /* capability, OAuth, or config write exists on any of these paths.   */
  /* Tasks are explicit LOCAL entities with a coherent public `scope`   */
  /* (contract default applies; the facade neither extends nor strips    */
  /* variants): the same-session/scope owned parent rule, strict         */
  /* EXPLICIT deadlines, and no invented scheduling.                     */
  /* ---------------------------------------------------------------- */

  function createAutonomyPurpose(
    sessionId: string,
    request: unknown,
    options: AutonomyKeyOptions,
  ): { status: number; body: PurposeCreateResponse; replayed: boolean } {
    const parsed = parseOrValidation(
      () => PurposeCreateRequestSchema.parse(request),
      "purpose create request",
    );
    return autonomyCreatePurpose(
      db,
      sessionId,
      {
        scope: parsed.scope,
        statement: parsed.statement,
        kind: parsed.kind,
        explicit: parsed.explicit,
        sourceKind: parsed.sourceKind,
        ...(parsed.sourceTurnId !== undefined
          ? { sourceTurnId: parsed.sourceTurnId }
          : {}),
        ...(parsed.interpretation !== undefined
          ? { interpretation: parsed.interpretation }
          : {}),
        ...(parsed.validFrom !== undefined
          ? { validFrom: parsed.validFrom }
          : {}),
        ...(parsed.validUntil !== undefined
          ? { validUntil: parsed.validUntil }
          : {}),
        ...("constraintRule" in parsed &&
        (parsed as { constraintRule?: unknown }).constraintRule !== undefined
          ? {
              constraintRule: (parsed as { constraintRule?: unknown })
                .constraintRule,
              constraintRulePresent: true,
            }
          : {}),
      },
      options,
    );
  }

  function listAutonomyPurposes(
    sessionId: string,
    query: unknown = {},
  ): PurposeListResponse {
    const parsed = parseOrValidation(
      () => AutonomyListQuerySchema.parse(query ?? {}),
      "purpose list query",
    );
    const out = autonomyListPurposes(db, sessionId, parsed.limit);
    return parseOrValidation(
      () => PurposeListResponseSchema.parse(out),
      "purpose list response",
    );
  }

  function getAutonomyPurpose(
    sessionId: string,
    purposeId: string,
  ): PurposeView {
    return parseOrValidation(
      () =>
        PurposeViewSchema.parse(autonomyGetPurpose(db, sessionId, purposeId)),
      "purpose response",
    );
  }

  function listAutonomyPurposesInScope(
    sessionId: string,
    scope: string,
  ): PurposeListResponse {
    const out = autonomyListPurposesInScope(db, sessionId, scope, 101);
    return parseOrValidation(
      () => PurposeListResponseSchema.parse(out),
      "purpose scope list response",
    );
  }

  /**
   * Filtered bounded purpose reader for the readonly agent tools
   * (NOT the public HTTP list): scope/status/kind filters apply in SQL
   * BEFORE the limit, and up to `limit + 1` matching rows are returned so
   * the caller reports a truthful `hasMore` for the FILTERED set (never a
   * falsely complete result while older matching records exist).
   */
  function listAutonomyPurposesFiltered(
    sessionId: string,
    filters: { scope?: string; status?: string; kind?: string },
    limit: number,
  ): PurposeListResponse {
    // Tool-family bound (default 10 / max 20): the `limit + 1` probe row
    // must fit the list DTO (max 100 items), so larger limits are rejected
    // loudly instead of truncating the probe.
    const capped = parseOrValidation(
      () => SearchLimitSchema.parse(limit),
      "purpose filtered list limit",
    );
    const out = autonomyListPurposesFiltered(db, sessionId, filters, capped);
    return parseOrValidation(
      () => PurposeListResponseSchema.parse(out),
      "purpose filtered list response",
    );
  }

  function getAutonomyPurposeHistory(
    sessionId: string,
    purposeId: string,
    query: unknown = {},
  ): PurposeHistoryResponse {
    const parsed = parseOrValidation(
      () =>
        AutonomyHistoryQuerySchema.parse({
          afterSeq: (query as { afterSeq?: unknown } | null)?.afterSeq ?? 0,
          limit: (query as { limit?: unknown } | null)?.limit,
        }),
      "purpose history query",
    );
    const out = autonomyListPurposeEvents(db, sessionId, purposeId, {
      afterSeq: parsed.afterSeq,
      limit: parsed.limit,
    });
    return parseOrValidation(
      () => PurposeHistoryResponseSchema.parse(out),
      "purpose history response",
    );
  }

  function correctAutonomyPurpose(
    sessionId: string,
    request: unknown,
    options: AutonomyKeyOptions,
  ): {
    status: number;
    body: PurposeCorrectResponse;
    replayed: boolean;
  } {
    const parsed = parseOrValidation(
      () => PurposeCorrectRequestSchema.parse(request),
      "purpose correct request",
    );
    const out = autonomyCorrectPurpose(
      db,
      sessionId,
      {
        scope: parsed.scope,
        statement: parsed.statement,
        kind: parsed.kind,
        explicit: parsed.explicit,
        sourceKind: parsed.sourceKind,
        purposeId: parsed.purposeId,
        expectedVersion: parsed.expectedVersion,
        ...(parsed.sourceTurnId !== undefined
          ? { sourceTurnId: parsed.sourceTurnId }
          : {}),
        ...(parsed.interpretation !== undefined
          ? { interpretation: parsed.interpretation }
          : {}),
        ...(parsed.validFrom !== undefined
          ? { validFrom: parsed.validFrom }
          : {}),
        ...(parsed.validUntil !== undefined
          ? { validUntil: parsed.validUntil }
          : {}),
        ...("constraintRule" in parsed
          ? {
              constraintRule:
                (parsed as { constraintRule?: unknown }).constraintRule ?? null,
            }
          : {}),
      },
      options,
    );
    const body = parseOrValidation(
      () => PurposeCorrectResponseSchema.parse(out.body),
      "purpose correct response",
    );
    return { status: out.status, body, replayed: out.replayed };
  }

  function revokeAutonomyPurpose(
    sessionId: string,
    purposeId: string,
    request: unknown,
    options: AutonomyKeyOptions,
  ): { status: number; body: PurposeView; replayed: boolean } {
    const parsed = parseOrValidation(
      () => PurposeTransitionRequestSchema.parse(request),
      "purpose revoke request",
    );
    const out = autonomyRevokePurpose(
      db,
      sessionId,
      purposeId,
      parsed.expectedVersion,
      options,
    );
    const body = parseOrValidation(
      () => PurposeViewSchema.parse(out.body),
      "purpose response",
    );
    return { status: out.status, body, replayed: out.replayed };
  }

  function achieveAutonomyPurpose(
    sessionId: string,
    purposeId: string,
    request: unknown,
    options: AutonomyKeyOptions,
  ): { status: number; body: PurposeView; replayed: boolean } {
    const parsed = parseOrValidation(
      () => PurposeTransitionRequestSchema.parse(request),
      "purpose achieve request",
    );
    const out = autonomyAchievePurpose(
      db,
      sessionId,
      purposeId,
      parsed.expectedVersion,
      options,
    );
    const body = parseOrValidation(
      () => PurposeViewSchema.parse(out.body),
      "purpose response",
    );
    return { status: out.status, body, replayed: out.replayed };
  }

  function confirmAutonomyPurpose(
    sessionId: string,
    purposeId: string,
    request: unknown,
    options: AutonomyKeyOptions,
  ): { status: number; body: PurposeView; replayed: boolean } {
    const parsed = parseOrValidation(
      () => PurposeTransitionRequestSchema.parse(request),
      "purpose confirm request",
    );
    const out = autonomyConfirmPurpose(
      db,
      sessionId,
      purposeId,
      parsed.expectedVersion,
      options,
    );
    const body = parseOrValidation(
      () => PurposeViewSchema.parse(out.body),
      "purpose response",
    );
    return { status: out.status, body, replayed: out.replayed };
  }

  function listAutonomyPurposeConflicts(
    sessionId: string,
  ): PurposeConflictListResponse {
    const out = autonomyListConflicts(db, sessionId);
    return parseOrValidation(
      () => PurposeConflictListResponseSchema.parse(out),
      "purpose conflict response",
    );
  }

  function recordAutonomyPurposeConflict(
    sessionId: string,
    request: unknown,
    options: AutonomyKeyOptions,
  ): {
    status: number;
    body: PurposeConflictRecord;
    replayed: boolean;
  } {
    const parsed = parseOrValidation(
      () => PurposeConflictRecordRequestSchema.parse(request),
      "purpose conflict record request",
    );
    const out = autonomyRecordConflict(
      db,
      sessionId,
      { purposeAId: parsed.purposeAId, purposeBId: parsed.purposeBId },
      options,
    );
    const body = parseOrValidation(
      () => PurposeConflictRecordSchema.parse(out.body),
      "purpose conflict record response",
    );
    return { status: out.status, body, replayed: out.replayed };
  }

  function createAutonomyTask(
    sessionId: string,
    request: unknown,
    options: AutonomyKeyOptions,
  ): { status: number; body: TaskCreateResponse; replayed: boolean } {
    const parsed = parseOrValidation(
      () => TaskCreateRequestSchema.parse(request),
      "task create request",
    );
    const out = autonomyCreateTask(
      db,
      sessionId,
      {
        scope: parsed.scope,
        title: parsed.title,
        ...(parsed.body !== undefined ? { body: parsed.body } : {}),
        kind: parsed.kind,
        speaker: parsed.speaker,
        ...(parsed.deadline !== undefined ? { deadline: parsed.deadline } : {}),
        ...(parsed.parentPurposeId !== undefined
          ? { parentPurposeId: parsed.parentPurposeId }
          : {}),
      },
      options,
    );
    return { status: out.status, body: out.body, replayed: out.replayed };
  }

  function listAutonomyTasks(
    sessionId: string,
    query: unknown = {},
  ): TaskListResponse {
    const parsed = parseOrValidation(
      () => AutonomyTaskListQuerySchema.parse(query ?? {}),
      "task list query",
    );
    if (parsed.status === undefined && parsed.kind === undefined) {
      const out = autonomyListTasks(db, sessionId, parsed.limit);
      return parseOrValidation(
        () => TaskListResponseSchema.parse(out),
        "task list response",
      );
    }
    // SQL filters status/kind BEFORE the limit; the probe row (+1) is
    // dropped so the public DTO never exceeds the requested page.
    const out = autonomyListTasksFiltered(
      db,
      sessionId,
      {
        ...(parsed.status !== undefined ? { status: parsed.status } : {}),
        ...(parsed.kind !== undefined ? { kind: parsed.kind } : {}),
      },
      parsed.limit,
    );
    return parseOrValidation(
      () =>
        TaskListResponseSchema.parse({
          items: out.items.slice(0, parsed.limit),
        }),
      "task list response",
    );
  }

  function getAutonomyTask(sessionId: string, taskId: string): TaskView {
    return autonomyGetTask(db, sessionId, taskId);
  }

  function listAutonomyTasksInScope(
    sessionId: string,
    scope: string,
  ): TaskListResponse {
    const out = autonomyListTasksInScope(db, sessionId, scope, 101);
    return parseOrValidation(
      () => TaskListResponseSchema.parse(out),
      "task scope list response",
    );
  }

  /**
   * Filtered bounded task reader for the readonly agent tools (NOT the
   * public HTTP list): same SQL-before-limit + `limit + 1` probe contract
   * as `listAutonomyPurposesFiltered` (see above).
   */
  function listAutonomyTasksFiltered(
    sessionId: string,
    filters: { scope?: string; status?: string; kind?: string },
    limit: number,
  ): TaskListResponse {
    // Tool-family bound (see `listAutonomyPurposesFiltered` above).
    const capped = parseOrValidation(
      () => SearchLimitSchema.parse(limit),
      "task filtered list limit",
    );
    const out = autonomyListTasksFiltered(db, sessionId, filters, capped);
    return parseOrValidation(
      () => TaskListResponseSchema.parse(out),
      "task filtered list response",
    );
  }

  function getAutonomyTaskHistory(
    sessionId: string,
    taskId: string,
    query: unknown = {},
  ): TaskHistoryResponse {
    const parsed = parseOrValidation(
      () =>
        AutonomyHistoryQuerySchema.parse({
          afterSeq: (query as { afterSeq?: unknown } | null)?.afterSeq ?? 0,
          limit: (query as { limit?: unknown } | null)?.limit,
        }),
      "task history query",
    );
    const out = autonomyListTaskEvents(db, sessionId, taskId, {
      afterSeq: parsed.afterSeq,
      limit: parsed.limit,
    });
    return parseOrValidation(
      () => TaskHistoryResponseSchema.parse(out),
      "task history response",
    );
  }

  function startAutonomyTask(
    sessionId: string,
    taskId: string,
    request: unknown,
    options: AutonomyKeyOptions,
  ): { status: number; body: TaskView; replayed: boolean } {
    const parsed = parseOrValidation(
      () => TaskTransitionRequestSchema.parse(request),
      "task start request",
    );
    return autonomyStartTask(
      db,
      sessionId,
      taskId,
      parsed.expectedVersion,
      options,
    );
  }

  function holdAutonomyTask(
    sessionId: string,
    taskId: string,
    request: unknown,
    options: AutonomyKeyOptions,
  ): { status: number; body: TaskView; replayed: boolean } {
    const parsed = parseOrValidation(
      () => TaskHoldRequestSchema.parse(request),
      "task hold request",
    );
    return autonomyHoldTask(
      db,
      sessionId,
      taskId,
      {
        expectedVersion: parsed.expectedVersion,
        reason: parsed.reason,
        reconsiderTrigger: parsed.reconsiderTrigger,
      },
      options,
    );
  }

  function resumeAutonomyTask(
    sessionId: string,
    taskId: string,
    request: unknown,
    options: AutonomyKeyOptions,
  ): { status: number; body: TaskView; replayed: boolean } {
    const parsed = parseOrValidation(
      () => TaskResumeRequestSchema.parse(request),
      "task resume request",
    );
    return autonomyResumeTask(
      db,
      sessionId,
      taskId,
      {
        expectedVersion: parsed.expectedVersion,
        evidenceKind: parsed.evidenceKind,
        evidence: parsed.evidence,
        ...(parsed.newParentPurposeId !== undefined
          ? { newParentPurposeId: parsed.newParentPurposeId }
          : {}),
      },
      options,
    );
  }

  function completeAutonomyTask(
    sessionId: string,
    taskId: string,
    request: unknown,
    options: AutonomyKeyOptions,
  ): { status: number; body: TaskView; replayed: boolean } {
    const parsed = parseOrValidation(
      () => TaskTransitionRequestSchema.parse(request),
      "task complete request",
    );
    return autonomyCompleteTask(
      db,
      sessionId,
      taskId,
      parsed.expectedVersion,
      options,
    );
  }

  function cancelAutonomyTask(
    sessionId: string,
    taskId: string,
    request: unknown,
    options: AutonomyKeyOptions,
  ): { status: number; body: TaskView; replayed: boolean } {
    const parsed = parseOrValidation(
      () => TaskTransitionRequestSchema.parse(request),
      "task cancel request",
    );
    return autonomyCancelTask(
      db,
      sessionId,
      taskId,
      parsed.expectedVersion,
      options,
    );
  }

  function getAutonomyControlState(): AutonomyControlView {
    return parseOrValidation(
      () => AutonomyControlViewSchema.parse(autonomyGetControl(db)),
      "autonomy control response",
    );
  }

  /* ---------------------------------------------------------------- */
  /* AV03 conversation-proposal facade (durable inferred drafts).       */
  /*                                                                  */
  /* Ownership: every method below delegates to `autonomy.ts`, the     */
  /* ONLY writer of the proposal tables. Staging is model-origin ONLY */
  /* via `stageConversationProposalFromModel` (source derived          */
  /* server-side from the calling run's CURRENT ordinary `user_text`   */
  /* turn — never model input). Accept/reject are the trusted-human    */
  /* kernel API used by the NEXT HTTP/UI worker; this slice ships the  */
  /* bounded owned list/get readers and the atomic adoption core ONLY  */
  /* (no HTTP routes in this slice). No calendar / scheduling /        */
  /* permission-grant behavior lives here.                            */
  /* ---------------------------------------------------------------- */

  function stageConversationProposalFromModel(
    runId: string,
    request: unknown,
    options: AutonomyKeyOptions,
  ): {
    status: number;
    body: ConversationProposalView;
    replayed: boolean;
  } {
    const run = getRun(runId);
    const turn = getTurn(run.turnId);
    if (run.sessionId !== turn.sessionId) {
      throw new RepositoryValidationError("run/turn session mismatch");
    }
    if (turn.input.kind !== "user_text") {
      // Only CURRENT ordinary user_text is an eligible source: action
      // approval/rejection decisions (or any non-text turn) can never be
      // quoted as a user instruction.
      throw new RepositoryValidationError(
        "only ordinary user_text turns can source a proposal",
      );
    }
    const userText = turn.input.text;
    const target =
      typeof request === "object" && request !== null
        ? (request as { target?: unknown }).target
        : undefined;
    // Strip the dispatch discriminator before strict validation (the
    // model-facing tool schemas never carry a target field; the
    // registration name fixes it).
    const { target: _discarded, ...rest } =
      typeof request === "object" && request !== null
        ? (request as Record<string, unknown>)
        : {};
    void _discarded;
    if (target === "purpose") {
      const parsed = parseOrValidation(
        () => PurposeProposeRequestSchema.parse(rest),
        "purpose propose request",
      );
      const out = autonomyStageProposal(
        db,
        run.sessionId,
        {
          scope: parsed.scope,
          target: "purpose",
          draftKind: parsed.draftKind,
          purposeKind: parsed.purposeKind,
          sourceQuote: parsed.sourceQuote,
          interpretation: parsed.interpretation,
        },
        { sourceRunId: run.id, sourceTurnId: turn.id, userText },
        options,
      );
      const body = parseOrValidation(
        () => ConversationProposalViewSchema.parse(out.body),
        "proposal stage response",
      );
      return { status: out.status, body, replayed: out.replayed };
    }
    if (target === "task") {
      const parsed = parseOrValidation(
        () => TaskProposeRequestSchema.parse(rest),
        "task propose request",
      );
      const out = autonomyStageProposal(
        db,
        run.sessionId,
        {
          scope: parsed.scope,
          target: "task",
          draftKind: parsed.draftKind,
          taskKind: parsed.taskKind,
          sourceQuote: parsed.sourceQuote,
          interpretation: parsed.interpretation,
          parentPurposeId: parsed.parentPurposeId,
          expectedParentVersion: parsed.expectedParentVersion,
        },
        { sourceRunId: run.id, sourceTurnId: turn.id, userText },
        options,
      );
      const body = parseOrValidation(
        () => ConversationProposalViewSchema.parse(out.body),
        "proposal stage response",
      );
      return { status: out.status, body, replayed: out.replayed };
    }
    throw new RepositoryValidationError(
      "proposal target must be purpose or task",
    );
  }

  function listConversationProposals(
    sessionId: string,
    query: unknown = {},
  ): ConversationProposalListResponse {
    const parsed = parseOrValidation(
      () => ConversationProposalListQuerySchema.parse(query ?? {}),
      "proposal list query",
    );
    const out = autonomyListProposals(db, sessionId, {
      limit: parsed.limit,
      ...(parsed.cursor !== undefined ? { cursor: parsed.cursor } : {}),
      ...(parsed.status !== undefined ? { status: parsed.status } : {}),
    });
    return parseOrValidation(
      () => ConversationProposalListResponseSchema.parse(out),
      "proposal list response",
    );
  }

  function getConversationProposal(
    sessionId: string,
    proposalId: string,
  ): ConversationProposalView {
    return parseOrValidation(
      () =>
        ConversationProposalViewSchema.parse(
          autonomyGetProposal(db, sessionId, proposalId),
        ),
      "proposal response",
    );
  }

  function listConversationProposalEvents(
    sessionId: string,
    proposalId: string,
  ): {
    proposalId: string;
    events: {
      seq: number;
      event: string;
      fromStatus: string | null;
      toStatus: string;
      createdAt: number;
    }[];
  } {
    return autonomyListProposalEvents(db, sessionId, proposalId);
  }

  function acceptConversationProposal(
    sessionId: string,
    proposalId: string,
    request: unknown,
    options: AutonomyKeyOptions,
  ): {
    status: number;
    body: ConversationProposalAcceptResponse;
    replayed: boolean;
  } {
    const parsed = parseOrValidation(
      () => ConversationProposalAcceptRequestSchema.parse(request),
      "proposal accept request",
    );
    const out = autonomyAcceptProposal(
      db,
      sessionId,
      proposalId,
      {
        expectedVersion: parsed.expectedVersion,
        ...(parsed.deadline !== undefined ? { deadline: parsed.deadline } : {}),
        ...(parsed.validFrom !== undefined
          ? { validFrom: parsed.validFrom }
          : {}),
        ...(parsed.validUntil !== undefined
          ? { validUntil: parsed.validUntil }
          : {}),
      },
      options,
    );
    const body = parseOrValidation(
      () => ConversationProposalAcceptResponseSchema.parse(out.body),
      "proposal accept response",
    );
    return { status: out.status, body, replayed: out.replayed };
  }

  function rejectConversationProposal(
    sessionId: string,
    proposalId: string,
    request: unknown,
    options: AutonomyKeyOptions,
  ): {
    status: number;
    body: ConversationProposalRejectResponse;
    replayed: boolean;
  } {
    const parsed = parseOrValidation(
      () => ConversationProposalRejectRequestSchema.parse(request),
      "proposal reject request",
    );
    const out = autonomyRejectProposal(
      db,
      sessionId,
      proposalId,
      parsed.expectedVersion,
      options,
    );
    const body = parseOrValidation(
      () => ConversationProposalRejectResponseSchema.parse(out.body),
      "proposal reject response",
    );
    return { status: out.status, body, replayed: out.replayed };
  }

  /* ---------------------------------------------------------------- */
  /* AV04 learning facade (hypotheses + anchored evidence).             */
  /*                                                                  */
  /* Ownership: every method below delegates to `learning.ts`, the     */
  /* ONLY writer of the learning tables. Human routes create /        */
  /* transition / attach / accept / reject; the model reaches ONLY    */
  /* the staged proposal path (`proposeLearningHypothesisFromModel`,  */
  /* source derived server-side from the calling run's CURRENT        */
  /* ordinary `user_text` turn) and the read-only list/get readers.   */
  /* No purpose / task / grant / control / notification behavior.     */
  /* ---------------------------------------------------------------- */

  function createLearningHypothesis(
    sessionId: string,
    request: unknown,
    options: AutonomyKeyOptions,
  ): { status: number; body: LearningHypothesisView; replayed: boolean } {
    const parsed = parseOrValidation(
      () => LearningHypothesisCreateRequestSchema.parse(request),
      "learning create request",
    );
    const out = learningCreateHypothesis(
      db,
      sessionId,
      {
        scope: parsed.scope,
        kind: parsed.kind,
        statement: parsed.statement,
      },
      options,
    );
    const body = parseOrValidation(
      () => LearningHypothesisViewSchema.parse(out.body),
      "learning create response",
    );
    return { status: out.status, body, replayed: out.replayed };
  }

  function proposeLearningHypothesisFromModel(
    runId: string,
    request: unknown,
    options: AutonomyKeyOptions,
  ): {
    status: number;
    body: LearningHypothesisView;
    replayed: boolean;
  } {
    const run = getRun(runId);
    const turn = getTurn(run.turnId);
    if (run.sessionId !== turn.sessionId) {
      throw new RepositoryValidationError("run/turn session mismatch");
    }
    if (turn.input.kind !== "user_text") {
      // Only CURRENT ordinary user_text is an eligible source: action
      // approval/rejection decisions (or any non-text turn) can never
      // source a learning proposal.
      throw new RepositoryValidationError(
        "only ordinary user_text turns can source a learning proposal",
      );
    }
    const parsed = parseOrValidation(
      () => LearningProposeRequestSchema.parse(request),
      "learning propose request",
    );
    const out = learningStageFromModel(
      db,
      run.sessionId,
      {
        scope: parsed.scope,
        kind: parsed.kind,
        statement: parsed.statement,
      },
      { sourceRunId: run.id, sourceTurnId: turn.id },
      options,
    );
    const body = parseOrValidation(
      () => LearningHypothesisViewSchema.parse(out.body),
      "learning propose response",
    );
    return { status: out.status, body, replayed: out.replayed };
  }

  function listLearningHypotheses(
    sessionId: string,
    query: unknown = {},
  ): LearningHypothesisListResponse {
    const parsed = parseOrValidation(
      () => LearningHypothesisListQuerySchema.parse(query ?? {}),
      "learning list query",
    );
    const out = learningListHypotheses(db, sessionId, {
      limit: parsed.limit,
      ...(parsed.cursor !== undefined ? { cursor: parsed.cursor } : {}),
      ...(parsed.scope !== undefined ? { scope: parsed.scope } : {}),
      ...(parsed.status !== undefined ? { status: parsed.status } : {}),
      ...(parsed.kind !== undefined ? { kind: parsed.kind } : {}),
    });
    return parseOrValidation(
      () => LearningHypothesisListResponseSchema.parse(out),
      "learning list response",
    );
  }

  function getLearningHypothesis(
    sessionId: string,
    hypothesisId: string,
  ): LearningHypothesisView {
    return parseOrValidation(
      () =>
        LearningHypothesisViewSchema.parse(
          learningGetHypothesis(db, sessionId, hypothesisId),
        ),
      "learning hypothesis response",
    );
  }

  function listLearningHypothesisEvidence(
    sessionId: string,
    hypothesisId: string,
    query: unknown = {},
  ): LearningEvidenceListResponse {
    const parsed = parseOrValidation(
      () => LearningEvidenceListQuerySchema.parse(query ?? {}),
      "learning evidence list query",
    );
    const out = learningListEvidence(db, sessionId, hypothesisId, {
      limit: parsed.limit,
      ...(parsed.cursor !== undefined ? { cursor: parsed.cursor } : {}),
    });
    return parseOrValidation(
      () => LearningEvidenceListResponseSchema.parse(out),
      "learning evidence response",
    );
  }

  function listLearningHypothesisEvents(
    sessionId: string,
    hypothesisId: string,
  ): {
    hypothesisId: string;
    events: {
      seq: number;
      event: string;
      fromStatus: string | null;
      toStatus: string;
      createdAt: number;
    }[];
  } {
    return learningListEvents(db, sessionId, hypothesisId);
  }

  function transitionLearningHypothesis(
    sessionId: string,
    hypothesisId: string,
    request: unknown,
    options: AutonomyKeyOptions,
  ): { status: number; body: LearningHypothesisView; replayed: boolean } {
    const parsed = parseOrValidation(
      () => LearningHypothesisTransitionRequestSchema.parse(request),
      "learning transition request",
    );
    const out = learningTransition(
      db,
      sessionId,
      hypothesisId,
      parsed.transition as HypothesisTransition,
      parsed.expectedVersion,
      options,
    );
    const body = parseOrValidation(
      () => LearningHypothesisViewSchema.parse(out.body),
      "learning transition response",
    );
    return { status: out.status, body, replayed: out.replayed };
  }

  function reaffirmLearningHypothesis(
    sessionId: string,
    hypothesisId: string,
    request: unknown,
    options: AutonomyKeyOptions,
  ): { status: number; body: LearningHypothesisView; replayed: boolean } {
    // Explicit human reaffirm: same CAS-checked transition core with the
    // fixed `reaffirm` transition (keeps status, clears the reevaluation
    // notice, allowed only while the notice is set).
    const parsed = parseOrValidation(
      () => LearningHypothesisDecisionRequestSchema.parse(request),
      "learning reaffirm request",
    );
    const out = learningTransition(
      db,
      sessionId,
      hypothesisId,
      "reaffirm",
      parsed.expectedVersion,
      options,
    );
    const body = parseOrValidation(
      () => LearningHypothesisViewSchema.parse(out.body),
      "learning reaffirm response",
    );
    return { status: out.status, body, replayed: out.replayed };
  }

  function acceptLearningHypothesis(
    sessionId: string,
    hypothesisId: string,
    request: unknown,
    options: AutonomyKeyOptions,
  ): { status: number; body: LearningHypothesisView; replayed: boolean } {
    const parsed = parseOrValidation(
      () => LearningHypothesisDecisionRequestSchema.parse(request),
      "learning accept request",
    );
    const out = learningAcceptStaged(
      db,
      sessionId,
      hypothesisId,
      parsed.expectedVersion,
      options,
    );
    const body = parseOrValidation(
      () => LearningHypothesisViewSchema.parse(out.body),
      "learning accept response",
    );
    return { status: out.status, body, replayed: out.replayed };
  }

  function rejectLearningHypothesis(
    sessionId: string,
    hypothesisId: string,
    request: unknown,
    options: AutonomyKeyOptions,
  ): { status: number; body: LearningHypothesisView; replayed: boolean } {
    const parsed = parseOrValidation(
      () => LearningHypothesisDecisionRequestSchema.parse(request),
      "learning reject request",
    );
    const out = learningRejectStaged(
      db,
      sessionId,
      hypothesisId,
      parsed.expectedVersion,
      options,
    );
    const body = parseOrValidation(
      () => LearningHypothesisViewSchema.parse(out.body),
      "learning reject response",
    );
    return { status: out.status, body, replayed: out.replayed };
  }

  function attachLearningEvidence(
    sessionId: string,
    hypothesisId: string,
    request: unknown,
    options: AutonomyKeyOptions,
  ): { status: number; body: LearningEvidenceView; replayed: boolean } {
    const parsed = parseOrValidation(
      () => LearningEvidenceAttachRequestSchema.parse(request),
      "learning evidence request",
    );
    const out = learningAttachEvidence(
      db,
      sessionId,
      hypothesisId,
      {
        polarity: parsed.polarity,
        sourceKind: parsed.sourceKind,
        sourceId: parsed.sourceId,
        ...(parsed.note !== undefined ? { note: parsed.note } : {}),
      },
      options,
    );
    const body = parseOrValidation(
      () => LearningEvidenceViewSchema.parse(out.body),
      "learning evidence response",
    );
    return { status: out.status, body, replayed: out.replayed };
  }

  /* ---------------- AV03 delegation handoffs (human-driven only) -------- */
  // Session-owned handoffs bound to an existing task. The model can never
  // reach these writers (no model tool registration exists): every frozen
  // field is human-entered, verification needs all frozen criteria passing,
  // and boundary flags grant nothing.

  function createHandoff(
    sessionId: string,
    request: unknown,
    options: AutonomyKeyOptions,
  ): { status: number; body: HandoffView; replayed: boolean } {
    const parsed = parseOrValidation(
      () => HandoffCreateRequestSchema.parse(request),
      "handoff create request",
    );
    const out = handoffCreate(
      db,
      sessionId,
      {
        taskId: parsed.taskId,
        target: parsed.target,
        acceptanceCriteria: [...parsed.acceptanceCriteria],
        opScope: parsed.opScope,
        ...(parsed.budgetLabel !== undefined
          ? { budgetLabel: parsed.budgetLabel }
          : {}),
        boundaries: [...new Set(parsed.boundaries)],
        ...(parsed.supersedesHandoffId !== undefined
          ? { supersedesHandoffId: parsed.supersedesHandoffId }
          : {}),
      },
      options,
    );
    const body = parseOrValidation(
      () => HandoffViewSchema.parse(out.body),
      "handoff create response",
    );
    return { status: out.status, body, replayed: out.replayed };
  }

  function getHandoff(sessionId: string, handoffId: string): HandoffView {
    return parseOrValidation(
      () => HandoffViewSchema.parse(handoffGet(db, sessionId, handoffId)),
      "handoff response",
    );
  }

  function listHandoffs(
    sessionId: string,
    query: unknown = {},
  ): HandoffListResponse {
    const parsed = parseOrValidation(
      () => HandoffListQuerySchema.parse(query ?? {}),
      "handoff list query",
    );
    const out = handoffList(db, sessionId, {
      limit: parsed.limit,
      ...(parsed.cursor !== undefined ? { cursor: parsed.cursor } : {}),
      ...(parsed.status !== undefined ? { status: parsed.status } : {}),
    });
    const activeCount = handoffCountActive(db, sessionId);
    return parseOrValidation(
      () =>
        HandoffListResponseSchema.parse({
          items: out.items,
          nextCursor: out.nextCursor,
          hasMore: out.hasMore,
          activeCount,
        }),
      "handoff list response",
    );
  }

  function getHandoffSpec(sessionId: string, handoffId: string): string {
    return handoffBuildSpec(db, sessionId, handoffId);
  }

  function listHandoffEvents(
    sessionId: string,
    handoffId: string,
  ): {
    handoffId: string;
    events: {
      seq: number;
      event: string;
      fromStatus: string | null;
      toStatus: string;
      note: string | null;
      createdAt: number;
    }[];
  } {
    return handoffListEvents(db, sessionId, handoffId);
  }

  function listHandoffAttempts(
    sessionId: string,
    handoffId: string,
  ): {
    handoffId: string;
    attempts: { attemptNo: number; cause: string; createdAt: number }[];
  } {
    return handoffListAttempts(db, sessionId, handoffId);
  }

  function dispatchHandoff(
    sessionId: string,
    handoffId: string,
    request: unknown,
    options: AutonomyKeyOptions,
  ): { status: number; body: HandoffView; replayed: boolean } {
    const parsed = parseOrValidation(
      () => HandoffDispatchRequestSchema.parse(request),
      "handoff dispatch request",
    );
    const out = handoffDispatch(
      db,
      sessionId,
      handoffId,
      parsed.expectedVersion,
      parsed.externalRef,
      options,
    );
    const body = parseOrValidation(
      () => HandoffViewSchema.parse(out.body),
      "handoff dispatch response",
    );
    return { status: out.status, body, replayed: out.replayed };
  }

  function reportHandoff(
    sessionId: string,
    handoffId: string,
    request: unknown,
    options: AutonomyKeyOptions,
  ): { status: number; body: HandoffView; replayed: boolean } {
    const parsed = parseOrValidation(
      () => HandoffReportRequestSchema.parse(request),
      "handoff report request",
    );
    const out = handoffReport(
      db,
      sessionId,
      handoffId,
      parsed.expectedVersion,
      parsed.environment,
      parsed.summary,
      options,
    );
    const body = parseOrValidation(
      () => HandoffViewSchema.parse(out.body),
      "handoff report response",
    );
    return { status: out.status, body, replayed: out.replayed };
  }

  function verifyHandoff(
    sessionId: string,
    handoffId: string,
    request: unknown,
    options: AutonomyKeyOptions,
  ): { status: number; body: HandoffView; replayed: boolean } {
    const parsed = parseOrValidation(
      () => HandoffVerifyRequestSchema.parse(request),
      "handoff verify request",
    );
    const out = handoffVerify(
      db,
      sessionId,
      handoffId,
      parsed.expectedVersion,
      parsed.results.map((result) => ({
        index: result.index,
        pass: result.pass,
        evidence: result.evidence,
      })),
      options,
    );
    const body = parseOrValidation(
      () => HandoffViewSchema.parse(out.body),
      "handoff verify response",
    );
    return { status: out.status, body, replayed: out.replayed };
  }

  function failHandoff(
    sessionId: string,
    handoffId: string,
    request: unknown,
    options: AutonomyKeyOptions,
  ): { status: number; body: HandoffView; replayed: boolean } {
    const parsed = parseOrValidation(
      () => HandoffTransitionRequestSchema.parse(request),
      "handoff fail request",
    );
    const out = handoffFail(
      db,
      sessionId,
      handoffId,
      parsed.expectedVersion,
      options,
    );
    const body = parseOrValidation(
      () => HandoffViewSchema.parse(out.body),
      "handoff fail response",
    );
    return { status: out.status, body, replayed: out.replayed };
  }

  function cancelHandoff(
    sessionId: string,
    handoffId: string,
    request: unknown,
    options: AutonomyKeyOptions,
  ): { status: number; body: HandoffView; replayed: boolean } {
    const parsed = parseOrValidation(
      () => HandoffTransitionRequestSchema.parse(request),
      "handoff cancel request",
    );
    const out = handoffCancel(
      db,
      sessionId,
      handoffId,
      parsed.expectedVersion,
      options,
    );
    const body = parseOrValidation(
      () => HandoffViewSchema.parse(out.body),
      "handoff cancel response",
    );
    return { status: out.status, body, replayed: out.replayed };
  }

  function abnormalExitHandoff(
    sessionId: string,
    handoffId: string,
    request: unknown,
    options: AutonomyKeyOptions,
  ): { status: number; body: HandoffView; replayed: boolean } {
    const parsed = parseOrValidation(
      () => HandoffTransitionRequestSchema.parse(request),
      "handoff abnormal exit request",
    );
    const out = handoffAbnormalExit(
      db,
      sessionId,
      handoffId,
      parsed.expectedVersion,
      options,
    );
    const body = parseOrValidation(
      () => HandoffViewSchema.parse(out.body),
      "handoff abnormal exit response",
    );
    return { status: out.status, body, replayed: out.replayed };
  }

  function recordHandoffAttempt(
    sessionId: string,
    handoffId: string,
    request: unknown,
    options: AutonomyKeyOptions,
  ): { status: number; body: HandoffView; replayed: boolean } {
    const parsed = parseOrValidation(
      () => HandoffAttemptRequestSchema.parse(request),
      "handoff attempt request",
    );
    const out = handoffRecordAttempt(
      db,
      sessionId,
      handoffId,
      parsed.expectedVersion,
      parsed.cause,
      options,
    );
    const body = parseOrValidation(
      () => HandoffViewSchema.parse(out.body),
      "handoff attempt response",
    );
    return { status: out.status, body, replayed: out.replayed };
  }

  function reaffirmHandoff(
    sessionId: string,
    handoffId: string,
    request: unknown,
    options: AutonomyKeyOptions,
  ): { status: number; body: HandoffView; replayed: boolean } {
    const parsed = parseOrValidation(
      () => HandoffTransitionRequestSchema.parse(request),
      "handoff reaffirm request",
    );
    const out = handoffReaffirm(
      db,
      sessionId,
      handoffId,
      parsed.expectedVersion,
      options,
    );
    const body = parseOrValidation(
      () => HandoffViewSchema.parse(out.body),
      "handoff reaffirm response",
    );
    return { status: out.status, body, replayed: out.replayed };
  }

  function setAutonomyControlState(
    request: unknown,
    options: AutonomyKeyOptions,
  ): { status: number; body: AutonomyControlView; replayed: boolean } {
    const parsed = parseOrValidation(
      () => AutonomyControlSetRequestSchema.parse(request),
      "autonomy control request",
    );
    const out = autonomySetControl(
      db,
      {
        paused: parsed.paused,
        expectedVersion: parsed.expectedVersion,
        ...(parsed.reason !== undefined ? { reason: parsed.reason } : {}),
      },
      options,
    );
    const body = parseOrValidation(
      () => AutonomyControlViewSchema.parse(out.body),
      "autonomy control response",
    );
    return { status: out.status, body, replayed: out.replayed };
  }

  function listAutonomyActivityLog(
    query: unknown = {},
  ): AutonomyActivityListResponse {
    const parsed = parseOrValidation(
      () => AutonomyListQuerySchema.parse(query ?? {}),
      "activity list query",
    );
    const out = autonomyListActivity(db, parsed.limit);
    return parseOrValidation(
      () => AutonomyActivityListResponseSchema.parse({ items: out.items }),
      "activity list response",
    );
  }

  function applyAutonomyRestartFenceNow(now?: number): {
    paused: boolean;
    version: number;
  } {
    return applyAutonomyRestartFence(db, now);
  }

  /* ---------------------------------------------------------------- */
  /* AV02 shadow-deliberation facade (durable queue + fenced core).    */
  /*                                                                  */
  /* Ownership: every method below delegates to `shadow.ts`, the ONLY */
  /* writer of the shadow tables. This facade adds the strict Zod     */
  /* boundary and implements the narrow `ShadowPolicyReader` port     */
  /* from the EXISTING autonomy getters (no duplicated purpose        */
  /* mapper, no runtime cycle: `shadow.ts` never imports this         */
  /* module or `autonomy.ts`). Completed jobs store a MODEL decision  */
  /* SEPARATE from the CODE policy with ZERO execution performed.     */
  /* ---------------------------------------------------------------- */

  const shadowPolicyReader: ShadowPolicyReader = {
    listScopePurposes(sessionId: string, scope: string): ShadowReaderPurpose[] {
      const out = autonomyListPurposesInScope(db, sessionId, scope, 101);
      return out.items.map((purpose) => ({
        id: purpose.id,
        scope: purpose.scope,
        kind: purpose.kind,
        explicit: purpose.explicit,
        sourceKind: purpose.sourceKind,
        statement: purpose.statement,
        interpretation: purpose.interpretation,
        status: purpose.status,
        version: purpose.version,
        supersededBy: purpose.supersededBy,
        validFrom: purpose.validFrom,
        validUntil: purpose.validUntil,
        createdAt: purpose.createdAt,
      }));
    },
    listScopeTasks(sessionId: string, scope: string): ShadowReaderTask[] {
      const out = autonomyListTasksInScope(db, sessionId, scope, 101);
      return out.items.map((task) => ({
        id: task.id,
        scope: task.scope,
        title: task.title,
        body: task.body,
        kind: task.kind,
        speaker: task.speaker,
        deadline: task.deadline,
        parentPurposeId: task.parentPurposeId,
        status: task.status,
        version: task.version,
        holdReason: task.holdReason,
        reconsiderTrigger: task.reconsiderTrigger,
      }));
    },
    listScopeConflictPairs(
      sessionId: string,
      scope: string,
    ): [string, string][] {
      return autonomyListConflictPairsInScope(db, sessionId, scope, 101);
    },
    isStrictDeadline: (value: string): boolean =>
      isStrictAutonomyDeadline(value),
    isPurposeApplicableAt: (
      purpose: { validFrom: string | null; validUntil: string | null },
      now: number,
    ): boolean => autonomyIsPurposeApplicableAt(purpose, now),
  };

  function requestShadowDeliberation(
    sessionId: string,
    request: unknown,
    options: AutonomyKeyOptions,
  ): { status: number; body: ShadowJobView; replayed: boolean } {
    const parsed = parseOrValidation(
      () => ShadowExplicitRequestSchema.parse(request),
      "shadow explicit request",
    );
    const out = shadowRequest(
      db,
      sessionId,
      parsed.scope,
      parsed.reason,
      options,
    );
    const body = parseOrValidation(
      () => ShadowJobViewSchema.parse(out.body),
      "shadow job response",
    );
    return { status: out.status, body, replayed: out.replayed };
  }

  /* Trial authority facade: DATA-only stage, one-grant approve, claim. */
  /* Auto-dispatch ledger: policy/plan/execution + host authorization. */
  function createAutodispatchPolicy(
    sessionId: string,
    input: CreateStandingPolicyInput,
    options: {
      key: string;
      now?: number;
      limits: AutodispatchLimits;
      parent: {
        statement: string;
        sourceTurnId: string;
        interpretation?: string;
        validFrom?: string | null;
        validUntil?: string | null;
      };
    },
  ) {
    return autodispatchCreatePolicy(
      db,
      sessionId,
      input,
      options as Parameters<typeof autodispatchCreatePolicy>[3],
    );
  }
  function listAutodispatchPolicies(sessionId: string, limit?: number) {
    return autodispatchListPolicies(db, sessionId, limit);
  }
  function readAutodispatchPolicy(sessionId: string, policyId: string) {
    return autodispatchReadPolicy(db, sessionId, policyId);
  }
  function revokeAutodispatchPolicy(
    sessionId: string,
    policyId: string,
    options: { now?: number; reason?: string } = {},
  ) {
    return autodispatchRevokePolicy(db, sessionId, policyId, options);
  }
  function createAutodispatchPlan(
    sessionId: string,
    input: Parameters<typeof autodispatchCreatePlan>[2],
    options: { now?: number } = {},
  ) {
    return autodispatchCreatePlan(db, sessionId, input, options);
  }
  function listAutodispatchPlans(sessionId: string, limit?: number) {
    return autodispatchListPlans(db, sessionId, limit);
  }
  function readAutodispatchPlan(sessionId: string, planId: string) {
    return autodispatchReadPlan(db, sessionId, planId);
  }
  function authorizeAutodispatch(
    sessionId: string,
    planId: string,
    options: AuthorizeWithinPolicyOptions,
  ) {
    return autodispatchAuthorize(db, sessionId, planId, options);
  }
  function readAutodispatchIntentHistory(sessionId: string, limit?: number) {
    return autodispatchReadIntentHistory(db, sessionId, limit);
  }
  function readAutodispatchRunSession(runId: string): string | null {
    return autodispatchReadRunSessionId(db, runId);
  }
  function listAutodispatchExecutions(sessionId: string, limit?: number) {
    return autodispatchListExecutions(db, sessionId, limit);
  }
  function readAutodispatchExecution(sessionId: string, executionId: string) {
    return autodispatchReadExecution(db, sessionId, executionId);
  }
  function readAutodispatchMaterialization(
    sessionId: string,
    executionId: string,
  ) {
    return autodispatchReadMaterialization(db, sessionId, executionId);
  }

  function stageTrial(
    sessionId: string,
    request: unknown,
    options: AutonomyKeyOptions & {
      profile: TrialProfileSnapshot;
      workspaceAlias: string;
    },
  ): { status: number; body: TrialProposalView; replayed: boolean } {
    const parsed = parseOrValidation(
      () => TrialStageRequestSchema.parse(request),
      "trial stage request",
    );
    const profile = parseOrValidation(
      () => TrialProfileSnapshotSchema.parse(options.profile),
      "trial profile snapshot",
    );
    const out = stageTrialProposal(
      db,
      sessionId,
      {
        taskId: parsed.taskId,
        objective: parsed.objective,
        acceptance: [...parsed.acceptance],
        literalPatchPaths: [...parsed.literalPatchPaths],
        operation: parsed.operation,
        readOnlyMode: parsed.readOnlyMode,
        expiry: parsed.expiry,
        possibleExternalDataConsent: parsed.possibleExternalDataConsent,
        timeoutMs: parsed.objectiveResourceCaps.timeoutMs,
        maxOutputBytes: parsed.objectiveResourceCaps.maxOutputBytes,
        requiredChecks: [...parsed.requiredChecks],
        workspaceAlias: options.workspaceAlias,
      },
      {
        key: options.key,
        ...(options.now !== undefined ? { now: options.now } : {}),
        profile,
      },
    );
    const body = parseOrValidation(
      () => TrialProposalViewSchema.parse(out.body),
      "trial proposal response",
    );
    return { status: out.status, body, replayed: out.replayed };
  }

  function listShadowJobs(
    sessionId: string,
    query: unknown = {},
  ): ShadowJobListResponse {
    const parsed = parseOrValidation(
      () => AutonomyListQuerySchema.parse(query ?? {}),
      "shadow job list query",
    );
    const out = shadowListJobs(db, sessionId, parsed.limit);
    return parseOrValidation(
      () => ShadowJobListResponseSchema.parse(out),
      "shadow job list response",
    );
  }

  function getShadowJob(sessionId: string, jobId: string): ShadowJobView {
    return parseOrValidation(
      () => ShadowJobViewSchema.parse(shadowGetJob(db, sessionId, jobId)),
      "shadow job response",
    );
  }

  function listShadowJobEvents(
    sessionId: string,
    jobId: string,
  ): ShadowJobEventsResponse {
    const out = shadowListEvents(db, sessionId, jobId);
    return parseOrValidation(
      () => ShadowJobEventsResponseSchema.parse(out),
      "shadow job events response",
    );
  }

  function listShadowInbox(
    sessionId: string,
    query: unknown = {},
  ): {
    items: {
      id: string;
      sessionId: string;
      scope: string;
      kind: "policy_change" | "explicit_request";
      triggerEvent: string;
      triggerId: string | null;
      controlVersion: number;
      scopeEpoch: number;
      disposition: "recorded" | "consumed" | "skipped";
      jobId: string | null;
      createdAt: number;
    }[];
  } {
    const parsed = parseOrValidation(
      () => AutonomyListQuerySchema.parse(query ?? {}),
      "shadow inbox list query",
    );
    return shadowListInbox(db, sessionId, parsed.limit);
  }

  function getShadowJobContext(
    sessionId: string,
    jobId: string,
  ): ShadowJobContext {
    return parseOrValidation(
      () =>
        ShadowJobContextSchema.parse(shadowGetContext(db, sessionId, jobId)),
      "shadow job context response",
    );
  }

  function getShadowJobDeliberation(
    sessionId: string,
    jobId: string,
  ): ShadowJobDeliberation {
    return parseOrValidation(
      () =>
        ShadowJobDeliberationSchema.parse({
          context: shadowGetContext(db, sessionId, jobId),
          modelDecision: shadowGetDecision(db, sessionId, jobId),
        }),
      "shadow job deliberation response",
    );
  }

  function claimShadowJob(
    sessionId: string,
    jobId: string,
    request: unknown,
    options: { now?: number },
  ): {
    outcome: "claimed" | "held";
    job: ShadowJobView;
    context: ShadowJobContext | null;
  } {
    const candidate = request as {
      owner?: unknown;
      expectedVersion?: unknown;
      leaseMs?: unknown;
      memories?: unknown;
    };
    if (
      typeof candidate.owner !== "string" ||
      candidate.owner.length === 0 ||
      candidate.owner.length > 128 ||
      !Number.isInteger(candidate.expectedVersion) ||
      (candidate.expectedVersion as number) < 1
    ) {
      throw new RepositoryValidationError("shadow claim request is invalid");
    }
    if (
      candidate.leaseMs !== undefined &&
      (!Number.isInteger(candidate.leaseMs) ||
        (candidate.leaseMs as number) < 1000 ||
        (candidate.leaseMs as number) > 3_600_000)
    ) {
      throw new RepositoryValidationError("leaseMs must be 1000..3600000");
    }
    const owner = candidate.owner as string;
    const expectedVersion = candidate.expectedVersion as number;
    // Trusted server-only memory freeze: valid snippet entries only; any
    // other shape is dropped (never a validation throw into the claim).
    const memories =
      Array.isArray(candidate.memories) &&
      candidate.memories.every(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as { snippet?: unknown }).snippet === "string",
      )
        ? (candidate.memories as Array<{ snippet: string }>)
        : undefined;
    const out = shadowClaimJob(db, sessionId, jobId, shadowPolicyReader, {
      owner,
      expectedVersion,
      ...(candidate.leaseMs !== undefined
        ? { leaseMs: candidate.leaseMs as number }
        : {}),
      ...(memories !== undefined ? { memories } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
    const job = parseOrValidation(
      () => ShadowJobViewSchema.parse(out.job),
      "shadow job response",
    );
    const context =
      out.context === null
        ? null
        : parseOrValidation(
            () => ShadowJobContextSchema.parse(out.context),
            "shadow job context response",
          );
    return { outcome: out.outcome, job, context };
  }

  function completeShadowJob(
    sessionId: string,
    jobId: string,
    modelOutput: unknown,
    options: { expectedVersion: number; leaseOwner: string; now?: number },
  ): {
    outcome: "completed" | "held";
    job: ShadowJobView;
    policyCode:
      | "shadow_only"
      | "missing_grant"
      | "wish_not_command"
      | "external_no_authority"
      | "needs_clarification"
      | "no_action"
      | null;
  } {
    if (
      !Number.isInteger(options.expectedVersion) ||
      options.expectedVersion < 1 ||
      typeof options.leaseOwner !== "string"
    ) {
      throw new RepositoryValidationError(
        "shadow complete options are invalid",
      );
    }
    const parsedOutput = parseOrValidation(
      () => ShadowModelOutputSchema.parse(modelOutput),
      "shadow model output",
    );
    const out = shadowCompleteJob(
      db,
      sessionId,
      jobId,
      shadowPolicyReader,
      parsedOutput,
      {
        expectedVersion: options.expectedVersion,
        leaseOwner: options.leaseOwner,
        ...(options.now !== undefined ? { now: options.now } : {}),
      },
    );
    const job = parseOrValidation(
      () => ShadowJobViewSchema.parse(out.job),
      "shadow job response",
    );
    return { outcome: out.outcome, job, policyCode: out.policyCode };
  }

  function holdShadowJob(
    sessionId: string,
    jobId: string,
    request: unknown,
    options: { now?: number },
  ): ShadowJobView {
    const parsed = parseOrValidation(
      () => ShadowHoldRequestSchema.parse(request),
      "shadow hold request",
    );
    const job = shadowHoldJob(db, sessionId, jobId, parsed.reason, {
      expectedVersion: parsed.expectedVersion,
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
    return parseOrValidation(
      () => ShadowJobViewSchema.parse(job),
      "shadow job response",
    );
  }

  function failShadowJob(
    sessionId: string,
    jobId: string,
    request: unknown,
    options: { now?: number },
  ): ShadowJobView {
    const parsed = parseOrValidation(
      () => ShadowFailRequestSchema.parse(request),
      "shadow fail request",
    );
    const job = shadowFailJob(db, sessionId, jobId, parsed.code, {
      expectedVersion: parsed.expectedVersion,
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
    return parseOrValidation(
      () => ShadowJobViewSchema.parse(job),
      "shadow job response",
    );
  }

  function cancelShadowJob(
    sessionId: string,
    jobId: string,
    request: unknown,
    options: { now?: number },
  ): ShadowJobView {
    const candidate = request as { expectedVersion?: unknown };
    if (
      !Number.isInteger(candidate.expectedVersion) ||
      (candidate.expectedVersion as number) < 1
    ) {
      throw new RepositoryValidationError("shadow cancel request is invalid");
    }
    const job = shadowCancelJob(db, sessionId, jobId, {
      expectedVersion: candidate.expectedVersion as number,
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
    return parseOrValidation(
      () => ShadowJobViewSchema.parse(job),
      "shadow job response",
    );
  }

  /**
   * Narrow trusted global pending selector for the runtime shadow worker
   * ONLY (never called from HTTP): oldest pending job across sessions in
   * one bounded SQL statement. Null when the queue is empty.
   */
  function readPendingShadowJob(): {
    sessionId: string;
    jobId: string;
    version: number;
  } | null {
    return shadowReadPendingJob(db);
  }

  /**
   * Trusted foreground-activity read for the runtime shadow worker ONLY:
   * true while ANY user run is queued/running/cancel_requested.
   */
  function hasActiveShadowBlock(): boolean {
    return shadowHasActiveRuns(db);
  }

  function listTrials(
    sessionId: string,
    query: unknown = {},
  ): { items: TrialProposalView[] } {
    const parsed = parseOrValidation(
      () => AutonomyListQuerySchema.parse(query ?? {}),
      "trial list query",
    );
    const out = listTrialProposals(db, sessionId, parsed.limit);
    return {
      items: out.items.map((item) =>
        parseOrValidation(
          () => TrialProposalViewSchema.parse(item),
          "trial proposal",
        ),
      ),
    };
  }

  function readTrial(sessionId: string, proposalId: string): TrialProposalView {
    return parseOrValidation(
      () =>
        TrialProposalViewSchema.parse(
          readTrialProposal(db, sessionId, proposalId),
        ),
      "trial proposal",
    );
  }

  function approveTrial(
    sessionId: string,
    proposalId: string,
    options: AutonomyKeyOptions & {
      profile: TrialProfileSnapshot;
      workspaceAlias: string;
    },
  ): { status: number; body: { executionId: string }; replayed: boolean } {
    const profile = parseOrValidation(
      () => TrialProfileSnapshotSchema.parse(options.profile),
      "trial profile snapshot",
    );
    const out = approveTrialProposal(db, sessionId, proposalId, {
      key: options.key,
      ...(options.now !== undefined ? { now: options.now } : {}),
      profile,
      workspaceAlias: options.workspaceAlias,
    });
    return { status: out.status, body: out.body, replayed: out.replayed };
  }

  function claimTrial(
    sessionId: string,
    executionId: string,
    options: AutonomyKeyOptions & {
      profile: TrialProfileSnapshot;
      workspaceAlias: string;
      candidateStateDir?: string | null;
      candidateSourceDir?: string | null;
    },
  ): { status: number; body: unknown; replayed: boolean } {
    const profile = parseOrValidation(
      () => TrialProfileSnapshotSchema.parse(options.profile),
      "trial profile snapshot",
    );
    const out = claimTrialGrant(db, sessionId, executionId, {
      key: options.key,
      ...(options.now !== undefined ? { now: options.now } : {}),
      profile,
      workspaceAlias: options.workspaceAlias,
      ...(options.candidateStateDir !== undefined
        ? { candidateStateDir: options.candidateStateDir }
        : {}),
      ...(options.candidateSourceDir !== undefined
        ? { candidateSourceDir: options.candidateSourceDir }
        : {}),
    });
    const req = parseOrValidation(
      () =>
        TrialLaunchRequestSchema.parse(
          (out.body as { request: unknown }).request,
        ),
      "trial launch request",
    );
    void req;
    return { status: out.status, body: out.body, replayed: out.replayed };
  }

  function expireTrial(
    sessionId: string,
    proposalId: string,
    now?: number,
  ): void {
    expireTrialProposal(db, sessionId, proposalId, now ?? Date.now());
  }

  function fenceTrialUnknown(
    sessionId: string,
    opts: {
      workspaceAlias: string;
      executionId: string;
      taskHash?: string | null;
      pid?: number | null;
      bootId?: string | null;
      reason: string;
    },
    now?: number,
  ): number {
    return fenceUnknownExecution(db, sessionId, now ?? Date.now(), opts);
  }

  function hashTrialLaunchRequest(request: unknown): string {
    const parsed = parseOrValidation(
      () => TrialLaunchRequestSchema.parse(request),
      "trial launch request",
    );
    return hashTrialRequest(parsed);
  }

  /* Internal execution-lifecycle facade (Root service only, never browser). */
  function readTrialLaunchIntent(sessionId: string, executionId: string) {
    return readTrialIntent(db, sessionId, executionId);
  }

  function readTrialCandidateRoots(sessionId: string, executionId: string) {
    return readTrialCandidateRootsFn(db, sessionId, executionId);
  }

  function beginTrialAdoption(
    sessionId: string,
    proposalId: string,
    executionId: string,
    artifactSha256: string,
    now: number,
  ) {
    return beginTrialAdoptionFn(
      db,
      sessionId,
      proposalId,
      executionId,
      artifactSha256,
      now,
    );
  }

  function finishTrialAdoption(
    proposalId: string,
    result: {
      status: "done" | "failed";
      branch: string | null;
      prUrl: string | null;
      commitSha: string | null;
      errorCode: string | null;
    },
    now: number,
  ) {
    return finishTrialAdoptionFn(db, proposalId, result, now);
  }

  function recordTrialAdoptionBaseSha(
    proposalId: string,
    baseSha: string,
    now: number,
  ) {
    return recordTrialAdoptionBaseShaFn(db, proposalId, baseSha, now);
  }

  function readTrialAdoption(
    sessionId: string,
    proposalId: string,
    now?: number,
  ) {
    return readTrialAdoptionFn(db, sessionId, proposalId, now);
  }

  function recoverInterruptedTrialAdoptions(now?: number) {
    return recoverInterruptedTrialAdoptionsFn(db, now);
  }

  /** Internal proof read only: owned, revoked, never claimed/launched grant.
   * Missing/foreign => false; DB errors propagate; no mutation. */
  function isNeverLaunchedRevokedTrialGrant(
    sessionId: string,
    executionId: string,
  ): boolean {
    return trialGrantNeverLaunched(db, sessionId, executionId);
  }

  function registerTrialWorkerBoot(
    input: {
      executionId: string;
      sessionId?: string;
      pid: number;
      bootId: string;
      processStartTicks: string;
      observedAt?: number;
    },
    now?: number,
  ) {
    return registerWorkerBoot(db, {
      ...input,
      ...(now !== undefined ? { now } : {}),
    });
  }

  function issueTrialLaunchPermit(
    sessionId: string,
    executionId: string,
    deps: AutonomyKeyOptions & {
      observation: TrustedObservation;
      profile: TrialProfileSnapshot;
      requestHash: string;
    },
  ) {
    return issueLaunchPermit(db, sessionId, executionId, {
      key: deps.key,
      ...(deps.now !== undefined ? { now: deps.now } : {}),
      observation: deps.observation,
      profile: deps.profile,
      requestHash: deps.requestHash,
    });
  }

  function readTrialLaunchPermit(sessionId: string, executionId: string) {
    return readLaunchPermit(db, sessionId, executionId);
  }

  function readTrialWorkerOutcome(sessionId: string, executionId: string) {
    return readWorkerOutcome(db, sessionId, executionId);
  }

  function readTrialWorkerOutcomeByProposal(
    sessionId: string,
    proposalId: string,
  ) {
    return readWorkerOutcomeByProposal(db, sessionId, proposalId);
  }

  function readTrialWorkerReport(sessionId: string, executionId: string) {
    return readWorkerReport(db, sessionId, executionId);
  }

  function readTrialWorkerReportByProposal(
    sessionId: string,
    proposalId: string,
  ) {
    return readWorkerReportByProposal(db, sessionId, proposalId);
  }

  function readTrialExecutionIdByProposal(
    sessionId: string,
    proposalId: string,
  ) {
    return readWorkerExecutionIdByProposal(db, sessionId, proposalId);
  }

  function recordTrialWorkerResult(
    sessionId: string,
    executionId: string,
    input: {
      detail: string;
      observation: TrustedObservation;
      result: {
        taskHash: string;
        exitCode: number;
        checks: { id: string; ok: boolean }[];
        outputMatched: boolean;
        noTimeout: boolean;
      };
      report?: TrialWorkerReportInput | null;
    },
    now?: number,
  ) {
    return recordWorkerResult(db, sessionId, executionId, {
      ...input,
      ...(now !== undefined ? { now } : {}),
    });
  }

  function recordTrialQuiescence(
    sessionId: string,
    scope: string,
    executionId: string | null,
    now?: number,
    opts?: {
      workspaceAlias: string;
      executionId?: string;
      taskHash?: string | null;
      pid?: number | null;
      bootId?: string | null;
      reason: string;
      report?: TrialWorkerReportInput | null;
    },
  ) {
    return recordQuiescence(db, sessionId, scope, executionId, now, opts);
  }

  function clearTrialAliasFence(
    workspaceAlias: string,
    executionId: string,
    observation: TrustedObservation,
  ) {
    return clearAliasFence(db, workspaceAlias, executionId, observation);
  }

  function trialAuthorityDeadline(
    sessionId: string,
    taskId: string,
    operation: "investigate" | "implement" | "verify" | "maintenance_trial",
    writePaths: string[],
    workspaceAlias: string,
    proposalExpiry: string,
    now: number,
  ) {
    return authorityDeadlineMs(
      db,
      sessionId,
      taskId,
      operation,
      writePaths,
      workspaceAlias,
      proposalExpiry,
      now,
    );
  }

  function reconcileTrialExpiries(now?: number) {
    return reconcileTrialExpiry(db, now);
  }

  /**
   * Runner pick read (pure SELECT): oldest queued grant for an alias.
   * Empty array when nothing is queued (runNext no-op).
   *
   * `after` is an exclusive `(createdAt, executionId)` keyset cursor and
   * `through` an inclusive snapshot boundary, so one pick can page past
   * permanently blocked heads without re-reading them while staying bounded
   * to the cohort that existed when the pick started.
   */
  function listQueuedTrialGrantsForAlias(
    workspaceAlias: string,
    limit = 1,
    after?: QueuedTrialGrantCursor,
    through?: QueuedTrialGrantCursor,
  ) {
    return listQueuedTrialGrants(db, workspaceAlias, limit, after, through);
  }

  /** Runner snapshot boundary (pure SELECT): newest queued grant cursor. */
  function readQueuedTrialGrantHorizonForAlias(workspaceAlias: string) {
    return readQueuedTrialGrantHorizon(db, workspaceAlias);
  }

  /** Runner recovery scan (pure SELECT): claimed grants with boot rows. */
  function listClaimedTrialWorkersForRecovery() {
    return listClaimedTrialWorkers(db);
  }

  /* AV05 notifications durable-projection facade (core only).          */
  /*                                                                  */
  /* Ownership: every method below delegates to `notifications.ts`,   */
  /* the ONLY writer of the notification tables. This facade adds the */
  /* strict Zod boundary and returns kernel shapes so the NEXT       */
  /* service / HTTP worker can consume them verbatim. No model       */
  /* invoke, no worker, no calendar write, no authorization lives     */
  /* here: notifications never become execution authority and an ack  */
  /* changes NO purpose / task / control / grant state.               */
  /* ---------------------------------------------------------------- */

  function ingestNotifications(
    sessionId: string,
    options: { now?: number } = {},
  ): IngestNotificationsResponse {
    const out = notifyIngest(db, sessionId, options);
    return parseOrValidation(
      () => IngestNotificationsResponseSchema.parse(out),
      "ingest notifications response",
    );
  }

  function listNotifications(
    sessionId: string,
    query: unknown = {},
  ): NotificationListResponse {
    const parsed = parseOrValidation(
      () => NotificationListQuerySchema.parse(query ?? {}),
      "notification list query",
    );
    const out = notifyList(db, sessionId, {
      limit: parsed.limit,
      ...(parsed.beforeSeq !== undefined
        ? { beforeSeq: parsed.beforeSeq }
        : {}),
      ...(parsed.now !== undefined ? { now: parsed.now } : {}),
    });
    return parseOrValidation(
      () => NotificationListResponseSchema.parse(out),
      "notification list response",
    );
  }

  function listNotificationsForward(
    sessionId: string,
    query: unknown = {},
  ): NotificationForwardPageResponse {
    const parsed = parseOrValidation(
      () => NotificationForwardQuerySchema.parse(query ?? {}),
      "notification forward query",
    );
    const out = notifyListForward(db, sessionId, {
      after: parsed.after,
      limit: parsed.limit,
      ...(parsed.now !== undefined ? { now: parsed.now } : {}),
    });
    return parseOrValidation(
      () => NotificationForwardPageResponseSchema.parse(out),
      "notification forward page response",
    );
  }

  function getNotification(
    sessionId: string,
    notificationId: string,
    options: { now?: number } = {},
  ): NotificationView {
    const parsed = parseOrValidation(
      () => NotificationReadQuerySchema.parse(options ?? {}),
      "notification read query",
    );
    return parseOrValidation(
      () =>
        NotificationViewSchema.parse(
          notifyGet(db, sessionId, notificationId, {
            ...(parsed.now !== undefined ? { now: parsed.now } : {}),
          }),
        ),
      "notification response",
    );
  }

  function getNotificationHistory(
    sessionId: string,
    notificationId: string,
    options: { now?: number } = {},
  ): NotificationHistoryResponse {
    const parsed = parseOrValidation(
      () => NotificationReadQuerySchema.parse(options ?? {}),
      "notification read query",
    );
    const out = notifyHistory(db, sessionId, notificationId, {
      ...(parsed.now !== undefined ? { now: parsed.now } : {}),
    });
    return parseOrValidation(
      () => NotificationHistoryResponseSchema.parse(out),
      "notification history response",
    );
  }

  function getLatestNotificationCursor(
    sessionId: string,
  ): NotificationFeedCursorResponse {
    const out = notifyLatestCursor(db, sessionId);
    return parseOrValidation(
      () => NotificationFeedCursorResponseSchema.parse(out),
      "notification feed cursor response",
    );
  }

  function ackNotification(
    sessionId: string,
    notificationId: string,
    options: { key: string; now?: number },
  ): {
    status: number;
    body: NotificationAckReceipt;
    replayed: boolean;
  } {
    if (typeof options.key !== "string") {
      throw new RepositoryValidationError("ack key must be a UUID v4");
    }
    const out = notifyAck(db, sessionId, notificationId, options);
    const body = parseOrValidation(
      () => NotificationAckReceiptSchema.parse(out.body),
      "notification ack receipt",
    );
    return { status: out.status, body, replayed: out.replayed };
  }

  function buildDeadlineSchedule(
    sessionId: string,
    options: { now?: number } = {},
  ): BuildDeadlineScheduleResponse {
    const out = notifyBuildSchedule(db, sessionId, options);
    return parseOrValidation(
      () => BuildDeadlineScheduleResponseSchema.parse(out),
      "build deadline schedule response",
    );
  }

  function getNextDeadline(
    sessionId: string,
    options: { now?: number } = {},
  ): NextDeadlineResponse {
    const out = notifyNextDeadline(db, sessionId, options);
    const deadline =
      out.deadline === null
        ? null
        : parseOrValidation(
            () => DeadlineScheduleViewSchema.parse(out.deadline),
            "deadline schedule response",
          );
    return parseOrValidation(
      () =>
        NextDeadlineResponseSchema.parse({
          status: out.status,
          paused: out.paused,
          controlVersion: out.controlVersion,
          deadline,
        }),
      "next deadline response",
    );
  }

  function recordDueDeadlines(
    sessionId: string,
    options: { expectedControlVersion: number; now?: number },
  ): RecordDueDeadlinesResponse {
    if (
      !Number.isInteger(options.expectedControlVersion) ||
      options.expectedControlVersion < 1
    ) {
      throw new RepositoryValidationError(
        "expectedControlVersion must be >= 1",
      );
    }
    const out = notifyRecordDue(db, sessionId, {
      expectedControlVersion: options.expectedControlVersion,
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
    return parseOrValidation(
      () => RecordDueDeadlinesResponseSchema.parse(out),
      "record due deadlines response",
    );
  }

  return {
    createSession,
    postMessage,
    postRetry,
    startRun,
    completeRun,
    failRun,
    cancelRun,
    finalizeCancelRequested,
    recover,
    drain,
    settleAbandonedRunningRun,
    appendToolEvent,
    appendModelStepEvent,
    recordModelCall,
    listModelCalls,
    listRecentModelCalls,
    getModelCallTotals,
    countRunsByStatus,
    upsertEvidenceGrant,
    listEvidenceGrants,
    enqueueMemoryJob,
    getMemoryJob,
    claimDueMemoryJobs,
    ackMemoryJob,
    failMemoryJob,
    countPendingMemoryJobs,
    countOutstandingMemoryJobs,
    insertMemoryMaintenanceRun,
    listMemoryMaintenanceRuns,
    memoryMaintenanceSummary,
    recordMemoryExposure,
    listMemoryExposures,
    recordRunMemoryStatus,
    grantMemoryCitation,
    listMemoryGrants,
    recordMemorySearch,
    getMemorySearch,
    listMemorySearchItems,
    getMemorySearchItem,
    getOrCreateMemoryGraphSearch,
    mintMemoryGraphItems,
    createMemoryOperation,
    getMemoryOperation,
    getMemoryOperationByKey,
    setMemoryOperationStatus,
    setMemoryOperationStatusByJob,
    setMemoryOperationJob,
    stageMemoryMutationAtomic,
    bindCorrectionFollowupAtomic,
    failMemoryJobWithOperationMirror,
    ackMemoryJobWithOperationMirror,
    getSession,
    getTurn,
    getRun,
    getActiveRun,
    getSelection,
    getHistory,
    getEvents,
    listProposals,
    getProposalExecution,
    readCommittedGrantRevision,
    approveProposal,
    rejectProposal,
    listReferences,
    getReferenceDetail,
    getReferenceSet,
    getReferenceContext,
    putReferenceContext,
    backfillReferenceContexts,
    lookupIdempotency,
    lookupIdempotencyForSession,
    requireOwnedRun: (sessionId: string, runId: string): RunRow =>
      parseRunRow(requireOwnedRun(sessionId, runId)),
    requireOwnedTurn: (sessionId: string, turnId: string): TurnRow =>
      parseTurnRow(requireOwnedTurn(sessionId, turnId)),
    actionProposalsStager: stager,
    createAutonomyPurpose,
    listAutonomyPurposes,
    getAutonomyPurpose,
    listAutonomyPurposesInScope,
    listAutonomyPurposesFiltered,
    getAutonomyPurposeHistory,
    correctAutonomyPurpose,
    revokeAutonomyPurpose,
    achieveAutonomyPurpose,
    confirmAutonomyPurpose,
    listAutonomyPurposeConflicts,
    recordAutonomyPurposeConflict,
    createAutonomyTask,
    listAutonomyTasks,
    getAutonomyTask,
    listAutonomyTasksInScope,
    listAutonomyTasksFiltered,
    getAutonomyTaskHistory,
    startAutonomyTask,
    holdAutonomyTask,
    resumeAutonomyTask,
    completeAutonomyTask,
    cancelAutonomyTask,
    getAutonomyControlState,
    setAutonomyControlState,
    listAutonomyActivityLog,
    applyAutonomyRestartFenceNow,
    stageConversationProposalFromModel,
    listConversationProposals,
    getConversationProposal,
    listConversationProposalEvents,
    acceptConversationProposal,
    rejectConversationProposal,
    createLearningHypothesis,
    proposeLearningHypothesisFromModel,
    listLearningHypotheses,
    getLearningHypothesis,
    listLearningHypothesisEvidence,
    listLearningHypothesisEvents,
    transitionLearningHypothesis,
    reaffirmLearningHypothesis,
    acceptLearningHypothesis,
    rejectLearningHypothesis,
    attachLearningEvidence,
    createHandoff,
    getHandoff,
    listHandoffs,
    getHandoffSpec,
    listHandoffEvents,
    listHandoffAttempts,
    dispatchHandoff,
    reportHandoff,
    verifyHandoff,
    failHandoff,
    cancelHandoff,
    abnormalExitHandoff,
    recordHandoffAttempt,
    reaffirmHandoff,
    requestShadowDeliberation,
    listShadowJobs,
    getShadowJob,
    listShadowJobEvents,
    listShadowInbox,
    getShadowJobContext,
    getShadowJobDeliberation,
    claimShadowJob,
    completeShadowJob,
    holdShadowJob,
    failShadowJob,
    cancelShadowJob,
    readPendingShadowJob,
    hasActiveShadowBlock,

    createAutodispatchPolicy,
    listAutodispatchPolicies,
    readAutodispatchPolicy,
    revokeAutodispatchPolicy,
    createAutodispatchPlan,
    listAutodispatchPlans,
    readAutodispatchPlan,
    authorizeAutodispatch,
    readAutodispatchIntentHistory,
    readAutodispatchRunSession,
    listAutodispatchExecutions,
    readAutodispatchExecution,
    readAutodispatchMaterialization,
    stageTrial,
    listTrials,
    readTrial,
    approveTrial,
    claimTrial,
    expireTrial,
    fenceTrialUnknown,
    hashTrialLaunchRequest,
    readTrialLaunchIntent,
    readTrialCandidateRoots,
    readTrialAdoption,
    recoverInterruptedTrialAdoptions,
    beginTrialAdoption,
    finishTrialAdoption,
    recordTrialAdoptionBaseSha,
    isNeverLaunchedRevokedTrialGrant,
    registerTrialWorkerBoot,
    issueTrialLaunchPermit,
    readTrialLaunchPermit,
    readTrialWorkerOutcome,
    readTrialWorkerOutcomeByProposal,
    readTrialWorkerReport,
    readTrialWorkerReportByProposal,
    readTrialExecutionIdByProposal,
    recordTrialWorkerResult,
    recordTrialQuiescence,
    clearTrialAliasFence,
    trialAuthorityDeadline,
    reconcileTrialExpiries,
    listQueuedTrialGrantsForAlias,
    readQueuedTrialGrantHorizonForAlias,
    listClaimedTrialWorkersForRecovery,
    ingestNotifications,
    listNotifications,
    listNotificationsForward,
    getNotification,
    getNotificationHistory,
    getLatestNotificationCursor,
    ackNotification,
    buildDeadlineSchedule,
    getNextDeadline,
    recordDueDeadlines,
  };
}

export type KernelRepository = ReturnType<typeof createKernelRepository>;
