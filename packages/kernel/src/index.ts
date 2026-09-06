// @companion/kernel — M0 kernel storage + RunEngine/scheduler domain.
//
// M0 scope: SQLite durable storage (Drizzle schema ownership, single
// better-sqlite3 connection + PRAGMAs, committed SQL migrations with
// version guard, pre-upgrade backup API, safe close/quick-check),
// repository (CAS lifecycle transactions), the RunEngine durable
// scheduler with its replaceable RunStrategy contract, and the ToolBroker
// policy pipeline (static registry, fixed ordering, metadata-only audit).
// HTTP lives in later milestones and is NOT part of this module.

export type {
  AgentRepairReason,
  AgentStrategyOptions,
  CitationVerification,
  ProjectedHistoryItem,
  ProjectedReferenceSummary,
  ProjectPromptArgs,
  StepClassification,
} from "./agent.js";
export {
  AGENT_INVALID_TOOL_FEEDBACK_CONTENT,
  AGENT_MARKDOWN_SEARCH_PARAMETERS,
  AGENT_MAX_HISTORY_ITEMS,
  AGENT_MAX_STEPS,
  AGENT_REFERENCE_OPEN_PARAMETERS,
  AGENT_REFERENCE_REFRESH_PARAMETERS,
  AGENT_REFERENCE_RELATED_PARAMETERS,
  AGENT_REPAIR_HINTS,
  AGENT_RN_PATTERN,
  AGENT_STEP_TIMEOUT_MS,
  AGENT_SYSTEM_PROMPT,
  AGENT_TOOL_CALLER,
  AGENT_TOOL_CONCURRENCY,
  AGENT_TOOL_ORIGIN,
  AGENT_TOOL_OUTPUT_TOO_LARGE_CODE,
  AGENT_UNMAPPED_REFERENCE_ID,
  AGENT_UUID_V4_PATTERN,
  AGENT_WALL_MS,
  answerSubmitToolDefinition,
  buildAgentToolDefinitions,
  buildOversizedToolFeedbackContent,
  buildToolFeedbackContent,
  classifyStep,
  createAgentStrategy,
  extractGrantCandidates,
  formatReferenceOmittedMarker,
  isToolFeedbackOversized,
  loadFrozenOrdinalMap,
  projectPrompt,
  renderAnswerText,
  sanitizeModelFacingForFeedback,
  translateReferenceArgs,
  verifyCitations,
} from "./agent.js";
export type {
  ManualBackupOptions,
  PreMigrationBackupOptions,
} from "./backup.js";
export {
  applyPrivatePosixMode,
  createManualBackup,
  createPreMigrationBackup,
  ensureBackupDir,
  formatBackupUtc,
  listPreMigrationBackups,
  MANUAL_BACKUP_PARTIAL_SUFFIX,
  MANUAL_BACKUP_PREFIX,
  MANUAL_BACKUP_SUFFIX,
  manualBackupName,
  PRE_MIGRATION_KEEP_GENERATIONS,
  PRE_MIGRATION_PARTIAL_SUFFIX,
  PRE_MIGRATION_PREFIX,
  PRE_MIGRATION_SUFFIX,
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  preMigrationBackupName,
  prunePreMigrationBackups,
} from "./backup.js";
export type {
  BrokerCallResult,
  NormalizedToolOutput,
  PipelineStep,
  PipelineStepInfo,
  ToolBrokerBudgets,
  ToolBrokerOptions,
  ToolDedupMode,
  ToolFreshness,
  ToolHandler,
  ToolHandlerContext,
  ToolInvokeContext,
  ToolNormalizer,
  ToolRegistration,
  ToolSchema,
} from "./broker.js";
export {
  BROKER_PIPELINE_ORDER,
  createToolBroker,
  ToolBroker,
  ToolError,
} from "./broker.js";
export {
  canonicalJson,
  canonicalJsonString,
  generateId,
  IDEMPOTENCY_OPERATIONS,
  isUuidV4,
  requestHash,
  sha256Hex,
  uuidVersion,
} from "./canonical.js";
export type {
  KernelDatabaseHandle,
  KernelDrizzle,
  KernelPragmas,
} from "./connection.js";
export {
  applyPrivateDbFileMode,
  closeKernelDatabase,
  getKernelPragmas,
  KERNEL_BUSY_TIMEOUT_MS,
  KERNEL_DB_FILE_MODE,
  KERNEL_JOURNAL_MODE,
  KERNEL_SYNCHRONOUS_NORMAL,
  openKernelDatabase,
  quickCheck,
} from "./connection.js";
export type {
  EngineClock,
  EngineRecovery,
  RunEngineOptions,
} from "./engine.js";
export {
  DEFAULT_CANCEL_GRACE_MS,
  DEFAULT_DRAIN_MS,
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_POLL_INTERVAL_MS,
  RunEngine,
} from "./engine.js";
export {
  BackupError,
  BackupRequiredError,
  DatabaseStateInvalidError,
  IdempotencyConflictError,
  InvalidReferenceError,
  KernelStorageError,
  LinkGraphTooLargeError,
  MigrationFailedError,
  MigrationMissingError,
  NewerDatabaseError,
  PragmasError,
  QuickCheckError,
  ReferenceNotFoundError,
  ReferenceVersionConflictError,
  RepositoryNotFoundError,
  RepositoryValidationError,
  SessionBusyError,
} from "./errors.js";
export type { Deferred, GateObserver } from "./fakes.js";
export {
  abortOnly,
  deferred,
  explodingStrategy,
  failingStrategy,
  gatedSuccess,
  immediateSuccess,
  invalidResultStrategy,
  neverResolving,
  nonCooperativeDelayed,
  successResult,
} from "./fakes.js";
export type {
  CreateM1ToolRegistrationsOptions,
  MarkdownConnectorBinding,
  MarkdownConnectorPort,
  MarkdownPortDocument,
  MarkdownPortSearchHit,
  MarkdownPortSearchResult,
  MarkdownPortSkipped,
  MarkdownPortStandardLink,
  MarkdownPortWikiLink,
} from "./markdown_tools.js";
export {
  createM1ReferenceTools,
  createM1ToolRegistrations,
} from "./markdown_tools.js";
export type {
  BundledMigration,
  MigrateOptions,
  MigrateResult,
} from "./migrate.js";
export {
  BUNDLED_SCHEMA_VERSION,
  defaultMigrationsDir,
  getSchemaVersion,
  hasUserTables,
  listMigrations,
  migrateKernelDatabase,
  setSchemaVersion,
} from "./migrate.js";
export type {
  EnsureMarkdownConnectorOptions,
  FreshnessKind,
  MarkdownConnectorView,
  ObservationLink,
  PresentedReferenceView,
  PresentObservationsResult,
  PresentStoredResult,
  ReferenceManager,
  RelatedStoredView,
  ResourceObservation,
} from "./reference_manager.js";
export {
  createReferenceManager,
  deriveSnippet,
  RELATED_DEFAULT_LIMIT,
  RELATED_MAX_LIMIT,
} from "./reference_manager.js";
export type {
  ReferenceResolver,
  ResolverOutcome,
  ResolverReferenceView,
  ResolveStringOptions,
} from "./reference_resolver.js";
export { createReferenceResolver } from "./reference_resolver.js";
export type {
  AcceptedResponse,
  CreateSessionOptions,
  EvidenceGrantRow,
  KernelRepository,
  ModelCallOutcome,
  ModelCallRow,
  PostMessageOptions,
  PostRetryOptions,
  RecordModelCallOptions,
  RunRow,
  SessionRow,
  StoredIdempotencyRecord,
  TransitionOptions,
  TurnRow,
} from "./repository.js";
export { createKernelRepository } from "./repository.js";
export {
  apiIdempotency,
  connectorInstances,
  evidenceGrants,
  kernelSchema,
  modelCalls,
  referenceSetItems,
  referenceSets,
  resourceSnapshots,
  resources,
  runEvents,
  runs,
  sessionReferenceContext,
  sessionReferences,
  sessions,
  snapshotLinks,
  toolCalls,
  turnSelections,
  turns,
} from "./schema.js";
export type {
  RunStrategy,
  RunStrategyContext,
  StrategyRunView,
  StrategyTurnView,
} from "./strategy.js";
export {
  freezeStrategyContext,
  StrategyError,
  StrategyRegistry,
} from "./strategy.js";
