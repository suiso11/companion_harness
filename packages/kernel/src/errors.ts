// Kernel storage error taxonomy. All errors thrown by connection,
// backup, and migration helpers extend KernelStorageError so callers can
// narrow storage failures without matching on message text.

export class KernelStorageError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = this.constructor.name;
    this.code = code;
  }
}

/** PRAGMA application/verification failed on the single connection. */
export class PragmasError extends KernelStorageError {
  constructor(message: string, options?: ErrorOptions) {
    super("kernel_pragmas_invalid", message, options);
  }
}

/** PRAGMA quick_check reported corruption or could not run. */
export class QuickCheckError extends KernelStorageError {
  readonly details: readonly string[];

  constructor(details: readonly string[]) {
    // Keep raw native output out of the outward message; details stay
    // available programmatically on the field.
    super("kernel_quick_check_failed", "quick_check failed");
    this.details = details;
  }
}

/** Backup (.partial -> quick_check -> atomic rename) failed. */
export class BackupError extends KernelStorageError {
  constructor(message: string, options?: ErrorOptions) {
    super("kernel_backup_failed", message, options);
  }
}

/** Database schema/user_version is newer than the bundled migrations. */
export class NewerDatabaseError extends KernelStorageError {
  readonly currentVersion: number;
  readonly bundledVersion: number;

  constructor(currentVersion: number, bundledVersion: number) {
    super(
      "kernel_database_newer_than_bundle",
      `database schema version ${currentVersion} exceeds bundled version ${bundledVersion}; refusing to migrate or open for writes`,
    );
    this.currentVersion = currentVersion;
    this.bundledVersion = bundledVersion;
  }
}

/** An upgrade was requested but no migration SQL covers the gap. */
export class MigrationMissingError extends KernelStorageError {
  readonly fromVersion: number;
  readonly toVersion: number;

  constructor(fromVersion: number, toVersion: number) {
    super(
      "kernel_migration_missing",
      `no committed migration covers schema version ${fromVersion} -> ${toVersion}`,
    );
    this.fromVersion = fromVersion;
    this.toVersion = toVersion;
  }
}

/** Applying committed migration SQL failed. The pre-upgrade backup is kept. */
export class MigrationFailedError extends KernelStorageError {
  constructor(message: string, options?: ErrorOptions) {
    super("kernel_migration_failed", message, options);
  }
}

/** An upgrade needs a backup but no backup directory was provided. */
export class BackupRequiredError extends KernelStorageError {
  constructor() {
    super(
      "kernel_backup_required",
      "a pre-upgrade backup is required before migration but no backup directory was provided",
    );
  }
}

/* ------------------------------------------------------------------ */
/* Repository / domain errors (M0 §9 blockers 2-4, §12.3).             */
/*                                                                     */
/* Only raw-code-free, fixed lowercase API codes are exposed. No raw   */
/* error text, message bodies, or paths are ever persisted.            */
/* ------------------------------------------------------------------ */

/** Request failed Zod/contract validation (HTTP 400 `validation_error`). */
export class RepositoryValidationError extends KernelStorageError {
  readonly details: string;

  constructor(message: string, options?: ErrorOptions) {
    super("validation_error", message, options);
    this.details = message;
  }
}

/** Session / turn / run (or scoped ownership) not found (404 `not_found`). */
export class RepositoryNotFoundError extends KernelStorageError {
  constructor(message: string, options?: ErrorOptions) {
    super("not_found", message, options);
  }
}

/** Same idempotency key reused with a different request (409). */
export class IdempotencyConflictError extends KernelStorageError {
  readonly scope: string;

  constructor(
    scope: string,
    message = "idempotency key already used for a different request",
  ) {
    super("idempotency_key_reused", `${message} (scope ${scope})`);
    this.scope = scope;
  }
}

/** Session already holds an active run (409 `session_busy`). */
export class SessionBusyError extends KernelStorageError {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super("session_busy", `session ${sessionId} already has an active run`);
    this.sessionId = sessionId;
  }
}

/* ------------------------------------------------------------------ */
/* M1 reference errors (§14.8, fixed lowercase codes).                  */
/*                                                                     */
/* Transport status mapping (404 / 409 / 400) is a server concern;      */
/* kernel exposes the closed M1 vocabulary from contracts               */
/* (`reference_not_found` / `reference_version_conflict` /              */
/* `invalid_reference`) as typed errors.                                */
/* ------------------------------------------------------------------ */

/** Unknown reference/set id in this session (404 `reference_not_found`). */
export class ReferenceNotFoundError extends KernelStorageError {
  constructor(message: string, options?: ErrorOptions) {
    super("reference_not_found", message, options);
  }
}

/** CAS version mismatch on reference-context PUT (409). */
export class ReferenceVersionConflictError extends KernelStorageError {
  readonly expectedVersion: number;
  readonly currentVersion: number;

  constructor(expectedVersion: number, currentVersion: number) {
    super(
      "reference_version_conflict",
      `reference context version conflict: expected ${expectedVersion}, current ${currentVersion}`,
    );
    this.expectedVersion = expectedVersion;
    this.currentVersion = currentVersion;
  }
}

/** Context items fail membership/duplication rules (400). */
export class InvalidReferenceError extends KernelStorageError {
  constructor(message: string, options?: ErrorOptions) {
    super("invalid_reference", message, options);
  }
}

/**
 * Required reference-context row is missing (M1 invariant violation).
 * Fresh sessions gain the row in `createSession`; pre-M1 sessions gain it
 * via the 0002 backfill. A missing row is corrupt DB state, never healed
 * on a stored-only read: fail closed with this fixed safe code.
 */
export class DatabaseStateInvalidError extends KernelStorageError {
  constructor(message: string, options?: ErrorOptions) {
    super("database_state_invalid", message, options);
  }
}
