/**
 * M0 contracts public API: strict Zod v4 schemas + inferred types for ids,
 * Run status, TurnInput, frozen context, RunResult, RunEvents, tools, and
 * the M0 HTTP DTOs. All boundary objects are strict (unknown keys rejected).
 */
export {
  UuidSchema,
  UUID_V4_REGEX,
  IdempotencyKeySchema,
  UnixMsSchema,
  Sha256HexSchema,
  IDEMPOTENCY_SCOPE_SESSIONS_CREATE,
  IdempotencyScopeSchema,
  messageScope,
  retryScope,
} from "./ids.js";
export type { Uuid, IdempotencyKey, UnixMs, Sha256Hex, IdempotencyScope } from "./ids.js";

export {
  RunStatusSchema,
  TerminalStatusSchema,
  ActiveStatusSchema,
  TERMINAL_STATUSES,
  ACTIVE_STATUSES,
  isTerminalStatus,
  isActiveStatus,
} from "./run_status.js";
export type { RunStatus, TerminalStatus, ActiveStatus } from "./run_status.js";

export {
  MAX_USER_TEXT_LENGTH,
  UserTextTurnInputV1Schema,
  TurnInputV1Schema,
  TURN_INPUT_REGISTRY,
  parseTurnInput,
} from "./turn_input.js";
export type {
  UserTextTurnInputV1,
  TurnInputV1,
  TurnInputSchemaVersion,
} from "./turn_input.js";

export { TemporalContextSchema, FrozenContextSchema } from "./frozen_context.js";
export type { TemporalContext, FrozenContext } from "./frozen_context.js";

export {
  MAX_ASSISTANT_TEXT_LENGTH,
  RunResultV1Schema,
  RunResultSchema,
  RUN_RESULT_REGISTRY,
  parseRunResult,
} from "./run_result.js";
export type { RunResultV1, RunResult } from "./run_result.js";

export {
  RUN_EVENT_SCHEMA_VERSION,
  M0_RUN_EVENT_TYPES,
  M0RunEventTypeSchema,
  TERMINAL_EVENT_TYPES,
  TerminalEventTypeSchema,
  isTerminalEventType,
  RunQueuedPayloadSchema,
  RunStartedPayloadSchema,
  RunCancelRequestedPayloadSchema,
  RunCompletedPayloadSchema,
  RunFailedPayloadSchema,
  RunCancelledPayloadSchema,
  RunAbandonedPayloadSchema,
  ToolRequestedPayloadSchema,
  ToolCompletedPayloadSchema,
  RunEventSchema,
  RUN_EVENT_PAYLOAD_SCHEMAS,
  parseRunEvent,
  parseRunEventPayload,
} from "./events.js";
export type { M0RunEventType, TerminalEventType, RunEvent } from "./events.js";

export {
  ToolNameSchema,
  ToolCategorySchema,
  ToolDescriptorSchema,
  TOOL_BUDGET_DEFAULTS,
  ReportedOutcomeSchema,
  ActualOutcomeSchema,
  ResultDispositionSchema,
  ToolErrorCodeSchema,
  M0_TOOL_ERROR_CODES,
  KNOWN_M0_TOOL_ERROR_CODES,
  TOOL_ERROR_CODE_REGISTRY,
  parseToolErrorCode,
  RunErrorCodeSchema,
  M0_RUN_ERROR_CODES,
  RUN_ERROR_CODE_REGISTRY,
  parseRunErrorCode,
  ToolResultSchema,
} from "./tools.js";
export type {
  ToolName,
  ToolCategory,
  ToolDescriptor,
  ReportedOutcome,
  ActualOutcome,
  ResultDisposition,
  ToolErrorCode,
  ToolErrorSchemaVersion,
  RunErrorCode,
  RunErrorSchemaVersion,
  ToolResult,
} from "./tools.js";

export {
  SessionParamsSchema,
  TurnParamsSchema,
  RunParamsSchema,
  CreateSessionRequestSchema,
  CreateSessionResponseSchema,
  PostMessageRequestSchema,
  AcceptedRunSchema,
  PostMessageResponseSchema,
  PostRetryRequestSchema,
  PostRetryResponseSchema,
  CancelRunRequestSchema,
  CancelRunResponseSchema,
  HistoryQuerySchema,
  HistoryItemSchema,
  HistoryResponseSchema,
  EventsQuerySchema,
  EventsResponseSchema,
  IdempotencyLookupQuerySchema,
  IdempotencyLookupResponseSchema,
  ApiErrorCodeSchema,
  ApiErrorSchema,
  HealthLiveResponseSchema,
  HealthReadyResponseSchema,
} from "./http.js";
export type {
  SessionParams,
  TurnParams,
  RunParams,
  CreateSessionRequest,
  CreateSessionResponse,
  PostMessageRequest,
  AcceptedRun,
  PostMessageResponse,
  PostRetryRequest,
  PostRetryResponse,
  CancelRunRequest,
  CancelRunResponse,
  HistoryQuery,
  HistoryQueryInput,
  HistoryItem,
  HistoryResponse,
  EventsQuery,
  EventsQueryInput,
  EventsResponse,
  IdempotencyLookupQuery,
  IdempotencyLookupResponse,
  ApiErrorCode,
  ApiError,
  HealthLiveResponse,
  HealthReadyResponse,
} from "./http.js";
