/**
 * M0 contracts public API: strict Zod v4 schemas + inferred types for ids,
 * Run status, TurnInput, frozen context, RunResult, RunEvents, tools, and
 * the M0 HTTP DTOs. All boundary objects are strict (unknown keys rejected).
 */

export type { M0RunEventType, RunEvent, TerminalEventType } from "./events.js";
export {
  isTerminalEventType,
  M0_RUN_EVENT_TYPES,
  M0RunEventTypeSchema,
  parseRunEvent,
  parseRunEventPayload,
  RUN_EVENT_PAYLOAD_SCHEMAS,
  RUN_EVENT_SCHEMA_VERSION,
  RunAbandonedPayloadSchema,
  RunCancelledPayloadSchema,
  RunCancelRequestedPayloadSchema,
  RunCompletedPayloadSchema,
  RunEventSchema,
  RunFailedPayloadSchema,
  RunQueuedPayloadSchema,
  RunStartedPayloadSchema,
  TERMINAL_EVENT_TYPES,
  TerminalEventTypeSchema,
  ToolCompletedPayloadSchema,
  ToolRequestedPayloadSchema,
} from "./events.js";
export type { FrozenContext, TemporalContext } from "./frozen_context.js";
export {
  FrozenContextSchema,
  TemporalContextSchema,
} from "./frozen_context.js";
export type {
  AcceptedRun,
  ApiError,
  ApiErrorCode,
  CancelRunRequest,
  CancelRunResponse,
  CreateSessionRequest,
  CreateSessionResponse,
  EventsQuery,
  EventsQueryInput,
  EventsResponse,
  HealthLiveResponse,
  HealthReadyResponse,
  HistoryItem,
  HistoryQuery,
  HistoryQueryInput,
  HistoryResponse,
  IdempotencyLookupQuery,
  IdempotencyLookupResponse,
  PostMessageRequest,
  PostMessageResponse,
  PostRetryRequest,
  PostRetryResponse,
  RunParams,
  SessionParams,
  TurnParams,
} from "./http.js";
export {
  AcceptedRunSchema,
  ApiErrorCodeSchema,
  ApiErrorSchema,
  CancelRunRequestSchema,
  CancelRunResponseSchema,
  CreateSessionRequestSchema,
  CreateSessionResponseSchema,
  EventsQuerySchema,
  EventsResponseSchema,
  HealthLiveResponseSchema,
  HealthReadyResponseSchema,
  HistoryItemSchema,
  HistoryQuerySchema,
  HistoryResponseSchema,
  IdempotencyLookupQuerySchema,
  IdempotencyLookupResponseSchema,
  PostMessageRequestSchema,
  PostMessageResponseSchema,
  PostRetryRequestSchema,
  PostRetryResponseSchema,
  RunParamsSchema,
  SessionParamsSchema,
  TurnParamsSchema,
} from "./http.js";
export type {
  IdempotencyKey,
  IdempotencyScope,
  Sha256Hex,
  UnixMs,
  Uuid,
} from "./ids.js";
export {
  IDEMPOTENCY_SCOPE_SESSIONS_CREATE,
  IdempotencyKeySchema,
  IdempotencyScopeSchema,
  messageScope,
  retryScope,
  Sha256HexSchema,
  UnixMsSchema,
  UUID_V4_REGEX,
  UuidSchema,
} from "./ids.js";
export type { RunResult, RunResultV1 } from "./run_result.js";
export {
  MAX_ASSISTANT_TEXT_LENGTH,
  parseRunResult,
  RUN_RESULT_REGISTRY,
  RunResultSchema,
  RunResultV1Schema,
} from "./run_result.js";
export type { ActiveStatus, RunStatus, TerminalStatus } from "./run_status.js";
export {
  ACTIVE_STATUSES,
  ActiveStatusSchema,
  isActiveStatus,
  isTerminalStatus,
  RunStatusSchema,
  TERMINAL_STATUSES,
  TerminalStatusSchema,
} from "./run_status.js";
export type {
  ActualOutcome,
  ReportedOutcome,
  ResultDisposition,
  RunErrorCode,
  RunErrorSchemaVersion,
  ToolCategory,
  ToolDescriptor,
  ToolErrorCode,
  ToolErrorSchemaVersion,
  ToolName,
  ToolResult,
} from "./tools.js";
export {
  ActualOutcomeSchema,
  KNOWN_M0_TOOL_ERROR_CODES,
  M0_RUN_ERROR_CODES,
  M0_TOOL_ERROR_CODES,
  parseRunErrorCode,
  parseToolErrorCode,
  ReportedOutcomeSchema,
  ResultDispositionSchema,
  RUN_ERROR_CODE_REGISTRY,
  RunErrorCodeSchema,
  TOOL_BUDGET_DEFAULTS,
  TOOL_ERROR_CODE_REGISTRY,
  ToolCategorySchema,
  ToolDescriptorSchema,
  ToolErrorCodeSchema,
  ToolNameSchema,
  ToolResultSchema,
} from "./tools.js";
export type {
  TurnInputSchemaVersion,
  TurnInputV1,
  UserTextTurnInputV1,
} from "./turn_input.js";
export {
  MAX_USER_TEXT_LENGTH,
  parseTurnInput,
  TURN_INPUT_REGISTRY,
  TurnInputV1Schema,
  UserTextTurnInputV1Schema,
} from "./turn_input.js";
