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
  IdempotencyConflictError,
  KernelStorageError,
  MigrationFailedError,
  MigrationMissingError,
  NewerDatabaseError,
  PragmasError,
  QuickCheckError,
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
  AcceptedResponse,
  CreateSessionOptions,
  KernelRepository,
  PostMessageOptions,
  PostRetryOptions,
  RunRow,
  SessionRow,
  StoredIdempotencyRecord,
  TransitionOptions,
  TurnRow,
} from "./repository.js";
export { createKernelRepository } from "./repository.js";
export {
  apiIdempotency,
  kernelSchema,
  runEvents,
  runs,
  sessions,
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
