// AV autonomy slice: durable PURPOSE records + explicit TASK lifecycle +
// persistent global autonomous-work stop control.
//
// Ownership: this module is the ONLY writer of the autonomy tables
// (`autonomy_purposes`, `autonomy_purpose_events`, `autonomy_tasks`,
// `autonomy_task_events`, `autonomy_control`, `autonomy_activity`) plus the
// shared `api_idempotency` rows under the autonomy scopes. It uses the
// caller-provided single better-sqlite3 connection, BEGIN IMMEDIATE
// transactions, version-CAS mutations, canonical JSON + SHA-256
// domain-separated idempotency hashing, and Zod validation on every JSON
// boundary — the same conventions as the M0 kernel repository.
//
// Hard boundaries enforced here (no exceptions):
// - A recorded `permission` purpose is ONLY a claim. This module never
//   writes `action_proposals`, `action_executions`, grants, receipts,
//   connector instances, OAuth state, or config. Goals, confidence, and
//   silence never grant authority (no authority column exists at all).
// - Tasks are explicit LOCAL entities. There is no calendar / provider /
//   scheduling column; a task can never become a calendar event and never
//   triggers external execution.
// - Deadlines are NEVER inferred: absent stays NULL; present must satisfy
//   the existing strict RFC3339-with-explicit-offset grammar (borrowed from
//   the calendar connector's `isStrictCalendarInstant` contract, re-expressed
//   locally so this module keeps zero connector dependencies).
// - Corrections append a NEW record and CAS exactly the referenced old
//   record to `superseded` (never latest-wins over an unrelated record).
//   Conflicts are EXPLICIT owner-recorded relations between two purpose ids
//   (same session + scope, both active at record time, cross-kind allowed):
//   same-kind prose similarity alone is never a conflict. Inactive pairs
//   stay in history but are not listed; only an explicit correct / revoke /
//   achieve changes membership (never auto-resolved, never auto-overwritten).
// - Parent-purpose revocation atomically holds every dependent
//   non-terminal task (`purpose_revoked`) and blocks resume until an
//   explicit new parent is supplied. Resume always requires explicit
//   state-change evidence (closed kind enum — no timer/clock member exists).
// - Completed / cancelled tasks are terminal and are never revived. No
//   physical DELETE exists on any autonomy table.
// - The stop control defaults to PAUSED (migration seed). Every server
//   start runs the restart fence AFTER migration: a previously UNPAUSED
//   control is flipped back to PAUSED (version advance + restart reason) in
//   the same transaction that appends `restart_fence` + `interrupted_note`
//   history rows; an already-paused control stays paused with no version
//   change. Replaying an OLD resume idempotency key returns its stored
//   response but never flips current DB state: a fresh resume command with a
//   fresh key + current version is required. The flag gates ONLY new
//   autonomous background work
//   (queried via `isAutonomousWorkAllowed`); normal user chat and
//   already-dispatched human-approved M5 writes are never gated here.
// - Purposes carry an explicit nullable applicability window
//   (`validFrom`/`validUntil`, AV01): absent is unbounded NULL, present
//   bounds must satisfy the same strict RFC3339 grammar as deadlines with
//   validUntil after validFrom. Corrections preserve the window unless
//   explicitly changed. Only an active + applicable parent gates task
//   start/resume (checked at frozen `now`); correct/revoke/achieve hold
//   every dependent non-terminal task (never complete) when the parent
//   becomes non-active. No TTL forgetting, auto-archive, auto-revocation,
//   or automatic reparenting exists.

import {
  AutonomyControlViewSchema,
  type ConversationDraftKind,
  type ConversationProposalTarget,
  ConversationProposalViewSchema,
  IDEMPOTENCY_SCOPE_AUTONOMY_CONTROL,
  type ProvenanceSource,
  type PurposeKind,
  PurposeViewSchema,
  type ResumeEvidenceKind,
  type TaskKind,
  type TaskSpeaker,
  TaskViewSchema,
} from "@companion/contracts";
import type Database from "better-sqlite3";
import {
  generateId,
  IDEMPOTENCY_OPERATIONS,
  isUuidV4,
  requestHash,
} from "./canonical.js";
import {
  IdempotencyConflictError,
  KernelStorageError,
  RepositoryNotFoundError,
  RepositoryValidationError,
} from "./errors.js";
import {
  enqueueShadowSourceInTx,
  holdPendingShadowJobsInTx,
  reconcileShadowRestartInTx,
  skipRecordedInboxInTx,
} from "./shadow.js";

/** CAS version mismatch on a purpose / task / control mutation (409). */
export class AutonomyVersionConflictError extends KernelStorageError {
  readonly expectedVersion: number;
  readonly currentVersion: number;

  constructor(expectedVersion: number, currentVersion: number) {
    super(
      "autonomy_version_conflict",
      `autonomy version conflict: expected ${expectedVersion}, current ${currentVersion}`,
    );
    this.expectedVersion = expectedVersion;
    this.currentVersion = currentVersion;
  }
}

/** Illegal lifecycle transition or missing explicit evidence (409). */
export class AutonomyStateConflictError extends KernelStorageError {
  constructor(message: string) {
    super("autonomy_state_conflict", message);
  }
}

/* ------------------------------------------------------------------ */
/* Local strict helpers (same conventions as the M0 repository).        */
/* ------------------------------------------------------------------ */

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

function requireKey(key: unknown): string {
  if (!isUuidV4(key)) {
    throw new RepositoryValidationError("Idempotency-Key must be a UUID v4");
  }
  return (key as string).toLowerCase();
}

function requireId(id: unknown, what: string): string {
  if (!isUuidV4(id)) {
    throw new RepositoryValidationError(`${what} must be a UUID v4`);
  }
  return id as string;
}

function withImmediate<T>(db: Database.Database, fn: () => T): T {
  if (db.inTransaction) {
    // Nested inside a caller's BEGIN IMMEDIATE (proposal adoption composes
    // purpose/task creation atomically in ONE outer transaction): join via
    // SAVEPOINT so an inner failure rolls back to the savepoint without
    // breaking the outer transaction. Same-name stacking is safe (SQLite
    // releases them LIFO). Top-level callers keep the exact BEGIN
    // IMMEDIATE ... COMMIT behavior below (no consumer change).
    db.exec("SAVEPOINT av_nested_tx");
    try {
      const out = fn();
      db.exec("RELEASE av_nested_tx");
      return out;
    } catch (error) {
      try {
        db.exec("ROLLBACK TO av_nested_tx");
      } catch {
        // Best effort: the original error carries the failure.
      }
      try {
        db.exec("RELEASE av_nested_tx");
      } catch {
        // Best effort: the original error carries the failure.
      }
      throw error;
    }
  }
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

function toStoredResponse(
  db: Database.Database,
  scope: string,
  key: string,
): {
  requestHash: string;
  responseStatus: number;
  responseBody: unknown;
} | null {
  const row = db
    .prepare(
      "SELECT request_hash, response_status, response_body FROM api_idempotency WHERE scope = ? AND key = ?",
    )
    .get(scope, key) as
    | { request_hash: string; response_status: number; response_body: string }
    | undefined;
  if (row === undefined) {
    return null;
  }
  return {
    requestHash: row.request_hash,
    responseStatus: row.response_status,
    responseBody: parseOrValidation(
      () => JSON.parse(row.response_body),
      "stored idempotency body",
    ),
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

function requireSession(db: Database.Database, sessionId: string): void {
  const id = requireId(sessionId, "sessionId");
  const row = db.prepare("SELECT id FROM sessions WHERE id = ?").get(id) as
    | { id: string }
    | undefined;
  if (row === undefined) {
    throw new RepositoryNotFoundError(`session ${id} not found`);
  }
}

/**
 * Shadow-durability bridge (AV02): run a shadow-table write inside the
 * caller's autonomy transaction, best-effort on pre-0012 databases (missing
 * tables): the conversation / autonomy path must never break because the
 * shadow slice is absent. On migrated databases the write is atomic with
 * the state change (no enqueue-after-commit crash window). Shadow's OWN
 * writes never route here (no jobs from own job/log writes), and ordinary
 * user chat never routes here (no every-chat taskization).
 */
function shadowBestEffort(fn: () => void): void {
  try {
    fn();
  } catch (error) {
    if (error instanceof Error && /no such table/i.test(error.message)) {
      return;
    }
    throw error;
  }
}

/** Queue one durable shadow source in-TX (paused controls record, not queue). */
function enqueueShadowPolicyChangeInTx(
  db: Database.Database,
  sessionId: string,
  scope: string,
  source: "purpose" | "task" | "conflict",
  sourceId: string,
  triggerEvent: string,
  now: number,
): void {
  shadowBestEffort(() => {
    enqueueShadowSourceInTx(
      db,
      {
        sessionId,
        scope,
        source,
        sourceId,
        triggerEvent,
        kind: "policy_change",
      },
      now,
    );
  });
}

/* ------------------------------------------------------------------ */
/* Strict deadline grammar (borrowed, dependency-free).                 */
/*                                                                     */
/* Borrowed from the calendar connector's existing strict contract      */
/* (`isStrictCalendarInstant` over `parseTimedInstant` in               */
/* `connector-calendar/src/time.ts` + `rescheduleWrite.ts`): explicit-  */
/* offset RFC3339 only (bare dates rejected), real calendar validation  */
/* (month lengths, leap years, component/offset bounds, no Date.parse   */
/* rollover), genuine sub-millisecond precision rejected. Re-expressed  */
/* locally so this module keeps zero connector dependencies.            */
/* ------------------------------------------------------------------ */

const TIMED_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const MINUTE_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(Z|[+-](\d{2}):(\d{2}))$/;
const SUBSECOND_FRACTION = /T\d{2}:\d{2}:\d{2}\.(\d+)/;

function autonomyDaysInMonth(year: number, month: number): number {
  if (month === 2) {
    return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  }
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  return 31;
}

/** True for a strict explicit-offset RFC3339 instant (never inferred). */
export function isStrictAutonomyDeadline(value: string): boolean {
  if (value.length === 0 || value.length > 128) return false;
  const fraction = SUBSECOND_FRACTION.exec(value);
  if (fraction?.[1] !== undefined) {
    const digits = fraction[1] as string;
    if (digits.length > 3 && /[^0]/.test(digits.slice(3))) return false;
  }
  const timed = TIMED_INSTANT.exec(value);
  if (timed !== null) {
    const year = Number(timed[1]);
    const month = Number(timed[2]);
    const day = Number(timed[3]);
    const hour = Number(timed[4]);
    const minute = Number(timed[5]);
    const second = Number(timed[6]);
    if (month < 1 || month > 12) return false;
    if (day < 1 || day > autonomyDaysInMonth(year, month)) return false;
    if (hour > 23 || minute > 59 || second > 59) return false;
    const zone = timed[8] as string;
    if (zone !== "Z") {
      const offsetHour = Number(zone.slice(1, 3));
      const offsetMinute = Number(zone.slice(4, 6));
      if (offsetHour > 23 || offsetMinute > 59) return false;
    }
    return !Number.isNaN(Date.parse(value));
  }
  const minute = MINUTE_INSTANT.exec(value);
  if (minute === null) return false;
  const year = Number(minute[1]);
  const month = Number(minute[2]);
  const day = Number(minute[3]);
  const hour = Number(minute[4]);
  const minutePart = Number(minute[5]);
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > autonomyDaysInMonth(year, month)) return false;
  if (hour > 23 || minutePart > 59) return false;
  if (minute[6] !== "Z") {
    const offsetHour = Number(minute[7]);
    const offsetMinute = Number(minute[8]);
    if (offsetHour > 23 || offsetMinute > 59) return false;
  }
  return !Number.isNaN(Date.parse(value));
}

/**
 * Validate an explicit purpose applicability window (AV01). Absent bounds
 * stay NULL (unbounded); present bounds must satisfy the strict
 * explicit-offset RFC3339 grammar and validUntil must be after validFrom.
 * No TTL/auto-archive inference: invalid or inverted windows are rejected.
 */
function requireApplicabilityWindow(
  validFrom: string | undefined,
  validUntil: string | undefined,
): { from: string | null; until: string | null } {
  if (validFrom !== undefined && !isStrictAutonomyDeadline(validFrom)) {
    throw new RepositoryValidationError(
      "validFrom must be a strict RFC3339 instant with an explicit offset",
    );
  }
  if (validUntil !== undefined && !isStrictAutonomyDeadline(validUntil)) {
    throw new RepositoryValidationError(
      "validUntil must be a strict RFC3339 instant with an explicit offset",
    );
  }
  if (
    validFrom !== undefined &&
    validUntil !== undefined &&
    Date.parse(validUntil) <= Date.parse(validFrom)
  ) {
    throw new RepositoryValidationError("validUntil must be after validFrom");
  }
  return {
    from: validFrom ?? null,
    until: validUntil ?? null,
  };
}

/**
 * True when a purpose row is applicable at the frozen `now` (Unix-ms):
 * active status is checked by callers; here only the window applies
 * (NULL bounds are unbounded; the end bound is exclusive).
 */
export function isPurposeApplicableAt(
  purpose: { validFrom: string | null; validUntil: string | null },
  now: number,
): boolean {
  if (
    purpose.validFrom !== null &&
    Date.parse(purpose.validFrom) > nowMs(now)
  ) {
    return false;
  }
  if (
    purpose.validUntil !== null &&
    nowMs(now) >= Date.parse(purpose.validUntil)
  ) {
    return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Row shapes                                                           */
/* ------------------------------------------------------------------ */

interface RawPurpose {
  id: string;
  session_id: string;
  scope: string;
  kind: string;
  is_explicit: number;
  source_kind: string;
  source_turn_id: string | null;
  statement: string;
  interpretation: string | null;
  status: string;
  version: number;
  superseded_by: string | null;
  valid_from: string | null;
  valid_until: string | null;
  created_at: number;
  updated_at: number;
}

interface RawTask {
  id: string;
  session_id: string;
  scope: string;
  title: string;
  body: string | null;
  kind: string;
  speaker: string;
  deadline: string | null;
  parent_purpose_id: string | null;
  status: string;
  version: number;
  hold_reason: string | null;
  reconsider_trigger: string | null;
  created_at: number;
  updated_at: number;
}

function toPurposeView(row: RawPurpose): {
  id: string;
  sessionId: string;
  scope: string;
  statement: string;
  kind: PurposeKind;
  explicit: boolean;
  sourceKind: ProvenanceSource;
  sourceTurnId: string | null;
  interpretation: string | null;
  status: "active" | "superseded" | "revoked" | "achieved";
  version: number;
  supersededBy: string | null;
  validFrom: string | null;
  validUntil: string | null;
  createdAt: number;
  updatedAt: number;
} {
  return parseOrValidation(
    () =>
      PurposeViewSchema.parse({
        id: row.id,
        sessionId: row.session_id,
        scope: row.scope,
        statement: row.statement,
        kind: row.kind,
        explicit: row.is_explicit === 1,
        sourceKind: row.source_kind,
        sourceTurnId: row.source_turn_id,
        interpretation: row.interpretation,
        status: row.status,
        version: row.version,
        supersededBy: row.superseded_by,
        validFrom: row.valid_from,
        validUntil: row.valid_until,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }),
    "stored purpose",
  );
}

function toTaskView(row: RawTask): {
  id: string;
  sessionId: string;
  scope: string;
  title: string;
  body: string | null;
  kind: TaskKind;
  speaker: TaskSpeaker;
  deadline: string | null;
  parentPurposeId: string | null;
  status: "open" | "in_progress" | "held" | "completed" | "cancelled";
  version: number;
  holdReason: string | null;
  reconsiderTrigger: string | null;
  createdAt: number;
  updatedAt: number;
} {
  return parseOrValidation(
    () =>
      TaskViewSchema.parse({
        id: row.id,
        sessionId: row.session_id,
        scope: row.scope,
        title: row.title,
        body: row.body,
        kind: row.kind,
        speaker: row.speaker,
        deadline: row.deadline,
        parentPurposeId: row.parent_purpose_id,
        status: row.status,
        version: row.version,
        holdReason: row.hold_reason,
        reconsiderTrigger: row.reconsider_trigger,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }),
    "stored task",
  );
}

function readPurpose(
  db: Database.Database,
  purposeId: string,
): RawPurpose | null {
  return (
    (db
      .prepare("SELECT * FROM autonomy_purposes WHERE id = ?")
      .get(purposeId) as RawPurpose | undefined) ?? null
  );
}

function readTask(db: Database.Database, taskId: string): RawTask | null {
  return (
    (db.prepare("SELECT * FROM autonomy_tasks WHERE id = ?").get(taskId) as
      | RawTask
      | undefined) ?? null
  );
}

/**
 * Ownership-first purpose lookup (foreign ids are 404, never 403).
 * Exported for the repository's session-scoped idempotency lookup.
 */
export function assertOwnedPurpose(
  db: Database.Database,
  sessionId: string,
  purposeId: string,
): RawPurpose {
  const session = requireId(sessionId, "sessionId");
  const purpose = requireId(purposeId, "purposeId");
  const row = readPurpose(db, purpose);
  if (row === null || row.session_id !== session) {
    throw new RepositoryNotFoundError(
      `purpose ${purpose} not found in session ${session}`,
    );
  }
  return row;
}

/** Ownership-first task lookup (foreign ids are 404, never 403). */
export function assertOwnedTask(
  db: Database.Database,
  sessionId: string,
  taskId: string,
): RawTask {
  const session = requireId(sessionId, "sessionId");
  const task = requireId(taskId, "taskId");
  const row = readTask(db, task);
  if (row === null || row.session_id !== session) {
    throw new RepositoryNotFoundError(
      `task ${task} not found in session ${session}`,
    );
  }
  return row;
}

function requireOwnedTurnInSession(
  db: Database.Database,
  sessionId: string,
  turnId: string,
): void {
  const row = db
    .prepare("SELECT session_id FROM turns WHERE id = ?")
    .get(turnId) as { session_id: string } | undefined;
  if (row === undefined || row.session_id !== sessionId) {
    throw new RepositoryNotFoundError(
      `turn ${turnId} not found in session ${sessionId}`,
    );
  }
}

function appendPurposeEventInTx(
  db: Database.Database,
  purposeId: string,
  sessionId: string,
  event: "created" | "corrected" | "superseded" | "revoked" | "achieved",
  fromStatus: string | null,
  toStatus: string,
  statement: string,
  now: number,
): void {
  const seqRow = db
    .prepare(
      "SELECT COALESCE(MAX(seq), 0) AS max_seq FROM autonomy_purpose_events WHERE purpose_id = ?",
    )
    .get(purposeId) as { max_seq: number };
  db.prepare(
    "INSERT INTO autonomy_purpose_events (id, purpose_id, session_id, seq, event, from_status, to_status, statement, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    generateId(),
    purposeId,
    sessionId,
    seqRow.max_seq + 1,
    event,
    fromStatus,
    toStatus,
    statement,
    now,
  );
}

function appendTaskEventInTx(
  db: Database.Database,
  taskId: string,
  sessionId: string,
  event:
    | "created"
    | "started"
    | "held"
    | "resumed"
    | "completed"
    | "cancelled"
    | "parent_held",
  fromStatus: string | null,
  toStatus: string,
  note: string | null,
  now: number,
): void {
  const seqRow = db
    .prepare(
      "SELECT COALESCE(MAX(seq), 0) AS max_seq FROM autonomy_task_events WHERE task_id = ?",
    )
    .get(taskId) as { max_seq: number };
  db.prepare(
    "INSERT INTO autonomy_task_events (id, task_id, session_id, seq, event, from_status, to_status, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    generateId(),
    taskId,
    sessionId,
    seqRow.max_seq + 1,
    event,
    fromStatus,
    toStatus,
    note,
    now,
  );
}

function recordActivityInTx(
  db: Database.Database,
  kind:
    | "user_message"
    | "autonomy_stopped"
    | "autonomy_resumed"
    | "restart_fence"
    | "interrupted_note",
  sessionId: string | null,
  now: number,
): void {
  db.prepare(
    "INSERT INTO autonomy_activity (id, kind, session_id, created_at) VALUES (?, ?, ?, ?)",
  ).run(generateId(), kind, sessionId, now);
}

/* ------------------------------------------------------------------ */
/* Purposes                                                             */
/* ------------------------------------------------------------------ */

export interface CreatePurposeInput {
  scope: string;
  statement: string;
  kind: PurposeKind;
  explicit: boolean;
  sourceKind: ProvenanceSource;
  sourceTurnId?: string;
  interpretation?: string;
  validFrom?: string | null;
  validUntil?: string | null;
}

export interface AutonomyKeyOptions {
  key: string;
  now?: number;
}

export function createPurpose(
  db: Database.Database,
  sessionId: string,
  input: CreatePurposeInput,
  options: AutonomyKeyOptions,
): {
  status: number;
  body: ReturnType<typeof toPurposeView>;
  replayed: boolean;
} {
  const session = requireId(sessionId, "sessionId");
  const key = requireKey(options.key);
  const now = nowMs(options.now);
  const scope = `session:${session}:purpose`;
  const hash = requestHash(
    IDEMPOTENCY_OPERATIONS.createPurpose.operation,
    IDEMPOTENCY_OPERATIONS.createPurpose.schemaVersion,
    {
      sessionId: session,
      scope: input.scope,
      statement: input.statement,
      kind: input.kind,
      explicit: input.explicit,
      sourceKind: input.sourceKind,
      sourceTurnId: input.sourceTurnId ?? null,
      interpretation: input.interpretation ?? null,
      validFrom: input.validFrom ?? null,
      validUntil: input.validUntil ?? null,
    },
  );
  return withImmediate(db, () => {
    const existing = toStoredResponse(db, scope, key);
    if (existing !== null) {
      if (existing.requestHash !== hash) {
        throw new IdempotencyConflictError(scope);
      }
      // The stored body is already a validated PurposeView (camelCase):
      // return it verbatim, never re-mapped through the snake_case row
      // reader (which would see undefined columns).
      const body = parseOrValidation(
        () => PurposeViewSchema.parse(existing.responseBody),
        "stored purpose body",
      );
      return { status: existing.responseStatus, body, replayed: true };
    }
    requireSession(db, session);
    if (input.sourceTurnId !== undefined) {
      requireId(input.sourceTurnId, "sourceTurnId");
      requireOwnedTurnInSession(db, session, input.sourceTurnId);
    }
    const window = requireApplicabilityWindow(
      input.validFrom ?? undefined,
      input.validUntil ?? undefined,
    );
    const id = generateId();
    db.prepare(
      "INSERT INTO autonomy_purposes (id, session_id, scope, kind, is_explicit, source_kind, source_turn_id, statement, interpretation, status, version, superseded_by, valid_from, valid_until, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, NULL, ?, ?, ?, ?)",
    ).run(
      id,
      session,
      input.scope,
      input.kind,
      input.explicit ? 1 : 0,
      input.sourceKind,
      input.sourceTurnId ?? null,
      input.statement,
      input.interpretation ?? null,
      window.from,
      window.until,
      now,
      now,
    );
    appendPurposeEventInTx(
      db,
      id,
      session,
      "created",
      null,
      "active",
      input.statement,
      now,
    );
    // Same-TX durable shadow source (paused controls record, not queue).
    enqueueShadowPolicyChangeInTx(
      db,
      session,
      input.scope,
      "purpose",
      id,
      "purpose.created",
      now,
    );
    const row = readPurpose(db, id);
    if (row === null) {
      throw new RepositoryNotFoundError(`purpose ${id} not found`);
    }
    const body = toPurposeView(row);
    storeIdempotentResponse(db, scope, key, hash, 201, body, now);
    return { status: 201, body, replayed: false };
  });
}

export function listPurposes(
  db: Database.Database,
  sessionId: string,
  limit = 50,
): { items: ReturnType<typeof toPurposeView>[] } {
  const session = requireId(sessionId, "sessionId");
  requireSession(db, session);
  const capped = Math.min(Math.max(limit, 1), 100);
  const rows = db
    .prepare(
      "SELECT * FROM autonomy_purposes WHERE session_id = ? ORDER BY created_at DESC, id ASC LIMIT ?",
    )
    .all(session, capped) as RawPurpose[];
  return { items: rows.map(toPurposeView) };
}

export function getPurpose(
  db: Database.Database,
  sessionId: string,
  purposeId: string,
): ReturnType<typeof toPurposeView> {
  return toPurposeView(assertOwnedPurpose(db, sessionId, purposeId));
}

/**
 * Scope-filtered internal reader for the shadow port (NOT a public list
 * DTO): SQL filters `(session, scope)` BEFORE the limit and reads up to
 * `limit` rows (callers pass 101) so the builder detects REAL overflow
 * instead of silently dropping in-scope constraints / permission claims
 * hidden behind newest-first truncation of other-scope records. Reuses the
 * exact `toPurposeView` mapper + session/scope validation (no second
 * projection, no unbounded reads).
 */
export function listPurposesInScope(
  db: Database.Database,
  sessionId: string,
  scope: string,
  limit = 101,
): { items: ReturnType<typeof toPurposeView>[] } {
  const session = requireId(sessionId, "sessionId");
  if (scope.length === 0 || scope.length > 128) {
    throw new RepositoryValidationError("scope must be 1..128 chars");
  }
  requireSession(db, session);
  const capped = Math.min(Math.max(limit, 1), 101);
  const rows = db
    .prepare(
      "SELECT * FROM autonomy_purposes WHERE session_id = ? AND scope = ? ORDER BY created_at DESC, id ASC LIMIT ?",
    )
    .all(session, scope, capped) as RawPurpose[];
  return { items: rows.map(toPurposeView) };
}

export function listPurposeEvents(
  db: Database.Database,
  sessionId: string,
  purposeId: string,
): {
  purposeId: string;
  events: {
    seq: number;
    event: string;
    fromStatus: string | null;
    toStatus: string;
    createdAt: number;
  }[];
} {
  const owned = assertOwnedPurpose(db, sessionId, purposeId);
  const rows = db
    .prepare(
      "SELECT seq, event, from_status, to_status, created_at FROM autonomy_purpose_events WHERE purpose_id = ? ORDER BY seq ASC",
    )
    .all(owned.id) as {
    seq: number;
    event: string;
    from_status: string | null;
    to_status: string;
    created_at: number;
  }[];
  return {
    purposeId: owned.id,
    events: rows.map((row) => ({
      seq: row.seq,
      event: row.event,
      fromStatus: row.from_status,
      toStatus: row.to_status,
      createdAt: row.created_at,
    })),
  };
}

/**
 * Explicit unresolved conflicts: ONLY owner-recorded pairs from
 * `autonomy_purpose_conflicts` where BOTH purposes are still active.
 * Inactive pairs stay in history but are never listed. Same-kind prose
 * similarity alone is never a conflict; cross-kind pairs are allowed.
 */
export function listPurposeConflicts(
  db: Database.Database,
  sessionId: string,
): { conflicts: { scope: string; purposeIds: string[] }[] } {
  const session = requireId(sessionId, "sessionId");
  requireSession(db, session);
  const rows = db
    .prepare(
      "SELECT c.purpose_a_id AS a, c.purpose_b_id AS b, pa.scope AS scope FROM autonomy_purpose_conflicts c JOIN autonomy_purposes pa ON pa.id = c.purpose_a_id JOIN autonomy_purposes pb ON pb.id = c.purpose_b_id WHERE c.session_id = ? AND pa.status = 'active' AND pb.status = 'active' ORDER BY c.created_at ASC, c.id ASC LIMIT 100",
    )
    .all(session) as { a: string; b: string; scope: string }[];
  return {
    conflicts: rows.map((row) => ({
      scope: row.scope,
      purposeIds: [row.a, row.b],
    })),
  };
}

/**
 * Scope-filtered internal conflict reader for the shadow port: SQL filters
 * `(session, scope)` BEFORE the limit (up to 101) so an in-scope explicit
 * pair is never hidden behind other-scope truncation. Active-membership
 * semantics are unchanged (both members still active).
 */
export function listConflictPairsInScope(
  db: Database.Database,
  sessionId: string,
  scope: string,
  limit = 101,
): [string, string][] {
  const session = requireId(sessionId, "sessionId");
  if (scope.length === 0 || scope.length > 128) {
    throw new RepositoryValidationError("scope must be 1..128 chars");
  }
  requireSession(db, session);
  const capped = Math.min(Math.max(limit, 1), 101);
  const rows = db
    .prepare(
      "SELECT c.purpose_a_id AS a, c.purpose_b_id AS b FROM autonomy_purpose_conflicts c JOIN autonomy_purposes pa ON pa.id = c.purpose_a_id JOIN autonomy_purposes pb ON pb.id = c.purpose_b_id WHERE c.session_id = ? AND pa.scope = ? AND pa.status = 'active' AND pb.status = 'active' ORDER BY c.created_at ASC, c.id ASC LIMIT ?",
    )
    .all(session, scope, capped) as { a: string; b: string }[];
  return rows.map((row) => [row.a, row.b] as [string, string]);
}

export interface RecordConflictInput {
  purposeAId: string;
  purposeBId: string;
}

/**
 * Record an EXPLICIT conflict relation between two purpose ids. Both must
 * be owned by the same session, share the same scope, and be active;
 * cross-session pairs are 404 (never 403), scope mismatch or inactive
 * members are rejected, and self-pairs are rejected. The pair is stored
 * canonically ordered (a < b) exactly once; re-recording returns the
 * existing row. Relations are immutable: correcting/revoking/achieving a
 * member only drops it from the ACTIVE listing (history preserved), never
 * auto-overwrites the unrelated member. Recording grants no authority.
 */
export function recordPurposeConflict(
  db: Database.Database,
  sessionId: string,
  input: RecordConflictInput,
  options: AutonomyKeyOptions,
): {
  status: number;
  body: {
    id: string;
    sessionId: string;
    scope: string;
    purposeAId: string;
    purposeBId: string;
    createdAt: number;
  };
  replayed: boolean;
} {
  const session = requireId(sessionId, "sessionId");
  const key = requireKey(options.key);
  const now = nowMs(options.now);
  const aId = requireId(input.purposeAId, "purposeAId");
  const bId = requireId(input.purposeBId, "purposeBId");
  if (aId === bId) {
    throw new RepositoryValidationError("conflict pair must be distinct");
  }
  const [first, second] = aId < bId ? [aId, bId] : [bId, aId];
  const scope = `session:${session}:conflict:${first}:${second}`;
  const hash = requestHash(
    IDEMPOTENCY_OPERATIONS.recordPurposeConflict.operation,
    IDEMPOTENCY_OPERATIONS.recordPurposeConflict.schemaVersion,
    { sessionId: session, purposeAId: first, purposeBId: second },
  );
  return withImmediate(db, () => {
    const existing = toStoredResponse(db, scope, key);
    if (existing !== null) {
      if (existing.requestHash !== hash) {
        throw new IdempotencyConflictError(scope);
      }
      return {
        status: existing.responseStatus,
        body: existing.responseBody as {
          id: string;
          sessionId: string;
          scope: string;
          purposeAId: string;
          purposeBId: string;
          createdAt: number;
        },
        replayed: true,
      };
    }
    // Ownership-first: foreign ids are 404 (assertOwned throws 404).
    const a = assertOwnedPurpose(db, session, first);
    const b = assertOwnedPurpose(db, session, second);
    if (a.scope !== b.scope) {
      throw new RepositoryValidationError(
        "conflicting purposes must share the same scope",
      );
    }
    if (a.status !== "active" || b.status !== "active") {
      throw new AutonomyStateConflictError(
        "conflicting purposes must both be active",
      );
    }
    const prior = db
      .prepare(
        "SELECT id, created_at FROM autonomy_purpose_conflicts WHERE session_id = ? AND purpose_a_id = ? AND purpose_b_id = ?",
      )
      .get(session, first, second) as
      | { id: string; created_at: number }
      | undefined;
    if (prior !== undefined) {
      const body = {
        id: prior.id,
        sessionId: session,
        scope: a.scope,
        purposeAId: first,
        purposeBId: second,
        createdAt: prior.created_at,
      };
      storeIdempotentResponse(db, scope, key, hash, 200, body, now);
      return { status: 200, body, replayed: false };
    }
    const id = generateId();
    db.prepare(
      "INSERT INTO autonomy_purpose_conflicts (id, session_id, purpose_a_id, purpose_b_id, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(id, session, first, second, now);
    // Same-TX durable shadow source: an explicit conflict invalidates old
    // deliberation candidates for the scope.
    enqueueShadowPolicyChangeInTx(
      db,
      session,
      a.scope,
      "conflict",
      id,
      "conflict.recorded",
      now,
    );
    const body = {
      id,
      sessionId: session,
      scope: a.scope,
      purposeAId: first,
      purposeBId: second,
      createdAt: now,
    };
    storeIdempotentResponse(db, scope, key, hash, 201, body, now);
    return { status: 201, body, replayed: false };
  });
}

export interface CorrectPurposeInput extends CreatePurposeInput {
  purposeId: string;
  expectedVersion: number;
  /** undefined = preserve old window; null = clear bound; string = set. */
  validFrom?: string | null;
  validUntil?: string | null;
}

export function correctPurpose(
  db: Database.Database,
  sessionId: string,
  input: CorrectPurposeInput,
  options: AutonomyKeyOptions,
): {
  status: number;
  body: {
    old: ReturnType<typeof toPurposeView>;
    current: ReturnType<typeof toPurposeView>;
  };
  replayed: boolean;
} {
  const session = requireId(sessionId, "sessionId");
  const key = requireKey(options.key);
  const now = nowMs(options.now);
  const scope = `purpose:${requireId(input.purposeId, "purposeId")}:correct`;
  // Presence-sensitive hash (v2): omitted (preserve) vs explicit null
  // (clear) vs string (set) must hash differently. `canonicalJson` drops
  // `undefined`, so presence is encoded with explicit tags; otherwise an
  // omit-bounds correction and a clear-bounds correction on the same key
  // would falsely replay instead of 409 IdempotencyConflict.
  const hash = requestHash(
    IDEMPOTENCY_OPERATIONS.correctPurpose.operation,
    IDEMPOTENCY_OPERATIONS.correctPurpose.schemaVersion,
    {
      sessionId: session,
      purposeId: input.purposeId,
      expectedVersion: input.expectedVersion,
      scope: input.scope,
      statement: input.statement,
      kind: input.kind,
      explicit: input.explicit,
      sourceKind: input.sourceKind,
      sourceTurnId: input.sourceTurnId ?? null,
      interpretation: input.interpretation ?? null,
      validFrom:
        input.validFrom === undefined
          ? { present: false }
          : { present: true, value: input.validFrom },
      validUntil:
        input.validUntil === undefined
          ? { present: false }
          : { present: true, value: input.validUntil },
    },
  );
  return withImmediate(db, () => {
    const existing = toStoredResponse(db, scope, key);
    if (existing !== null) {
      if (existing.requestHash !== hash) {
        throw new IdempotencyConflictError(scope);
      }
      const body = parseOrValidation(
        () =>
          ({
            old: PurposeViewSchema.parse(
              (existing.responseBody as { old: unknown }).old,
            ),
            current: PurposeViewSchema.parse(
              (existing.responseBody as { current: unknown }).current,
            ),
          }) as unknown as {
            old: ReturnType<typeof toPurposeView>;
            current: ReturnType<typeof toPurposeView>;
          },
        "stored correction body",
      );
      return { status: existing.responseStatus, body, replayed: true };
    }
    const oldRow = assertOwnedPurpose(db, session, input.purposeId);
    if (oldRow.status !== "active") {
      throw new AutonomyStateConflictError(
        `purpose ${oldRow.id} is ${oldRow.status} and cannot be corrected`,
      );
    }
    if (oldRow.version !== input.expectedVersion) {
      throw new AutonomyVersionConflictError(
        input.expectedVersion,
        oldRow.version,
      );
    }
    if (input.sourceTurnId !== undefined) {
      requireId(input.sourceTurnId, "sourceTurnId");
      requireOwnedTurnInSession(db, session, input.sourceTurnId);
    }
    // Applicability correction: undefined preserves the old window, null
    // clears that bound, a string sets it (strict RFC3339, end after start).
    const nextFrom =
      input.validFrom === undefined ? oldRow.valid_from : input.validFrom;
    const nextUntil =
      input.validUntil === undefined ? oldRow.valid_until : input.validUntil;
    requireApplicabilityWindow(nextFrom ?? undefined, nextUntil ?? undefined);
    // Append the NEW record first (explicit-target only: never latest-wins
    // over an unrelated record), then CAS the exact referenced old record.
    const newId = generateId();
    db.prepare(
      "INSERT INTO autonomy_purposes (id, session_id, scope, kind, is_explicit, source_kind, source_turn_id, statement, interpretation, status, version, superseded_by, valid_from, valid_until, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, NULL, ?, ?, ?, ?)",
    ).run(
      newId,
      session,
      input.scope,
      input.kind,
      input.explicit ? 1 : 0,
      input.sourceKind,
      input.sourceTurnId ?? null,
      input.statement,
      input.interpretation ?? null,
      nextFrom,
      nextUntil,
      now,
      now,
    );
    appendPurposeEventInTx(
      db,
      newId,
      session,
      "corrected",
      null,
      "active",
      input.statement,
      now,
    );
    const moved = db
      .prepare(
        "UPDATE autonomy_purposes SET status = 'superseded', version = ?, updated_at = ?, superseded_by = ? WHERE id = ? AND status = 'active' AND version = ?",
      )
      .run(oldRow.version + 1, now, newId, oldRow.id, oldRow.version);
    if (moved.changes !== 1) {
      throw new AutonomyVersionConflictError(
        input.expectedVersion,
        oldRow.version,
      );
    }
    appendPurposeEventInTx(
      db,
      oldRow.id,
      session,
      "superseded",
      "active",
      "superseded",
      oldRow.statement,
      now,
    );
    // Same-TX durable shadow source: one deliberation unit covers the
    // correction + supersession + dependent holds (same scope epoch).
    enqueueShadowPolicyChangeInTx(
      db,
      session,
      input.scope,
      "purpose",
      newId,
      "purpose.corrected",
      now,
    );
    // The superseded parent is non-active: hold every dependent
    // non-terminal task (never complete) so no background execution
    // continues under the superseded goal.
    holdDependentsForNonActiveParent(
      db,
      oldRow.id,
      session,
      "purpose_superseded",
      now,
    );
    const oldCurrent = readPurpose(db, oldRow.id);
    const newCurrent = readPurpose(db, newId);
    if (oldCurrent === null || newCurrent === null) {
      throw new RepositoryNotFoundError("corrected purpose not found");
    }
    const body = {
      old: toPurposeView(oldCurrent),
      current: toPurposeView(newCurrent),
    };
    storeIdempotentResponse(db, scope, key, hash, 201, body, now);
    return { status: 201, body, replayed: false };
  });
}

/**
 * Hold every dependent NON-TERMINAL task of a purpose that just became
 * non-active (corrected/superseded, revoked, or achieved): open/in_progress
 * tasks move to held, already-held tasks keep an audit event. Terminal
 * (completed/cancelled) tasks are never touched. The hold reason names the
 * parent transition; resume always needs explicit evidence (+ an explicit
 * new parent when the recorded parent is revoked).
 */
function holdDependentsForNonActiveParent(
  db: Database.Database,
  purposeId: string,
  session: string,
  holdReason: string,
  now: number,
): void {
  const dependents = db
    .prepare(
      "SELECT * FROM autonomy_tasks WHERE parent_purpose_id = ? AND status IN ('open','in_progress','held')",
    )
    .all(purposeId) as RawTask[];
  for (const dependent of dependents) {
    if (dependent.session_id !== session) {
      continue;
    }
    if (dependent.status === "held") {
      appendTaskEventInTx(
        db,
        dependent.id,
        session,
        "parent_held",
        "held",
        "held",
        holdReason,
        now,
      );
      continue;
    }
    const held = db
      .prepare(
        "UPDATE autonomy_tasks SET status = 'held', version = ?, updated_at = ?, hold_reason = ?, reconsider_trigger = 'explicit_new_parent' WHERE id = ? AND status = ? AND version = ?",
      )
      .run(
        dependent.version + 1,
        now,
        holdReason,
        dependent.id,
        dependent.status,
        dependent.version,
      );
    if (held.changes !== 1) {
      throw new AutonomyVersionConflictError(
        dependent.version,
        dependent.version,
      );
    }
    appendTaskEventInTx(
      db,
      dependent.id,
      session,
      "parent_held",
      dependent.status,
      "held",
      holdReason,
      now,
    );
  }
}

/**
 * Require the recorded parent to be active AND applicable at frozen `now`
 * before a task may start/resume under it. Inactive or out-of-window
 * parents block with a state conflict; no automatic reparenting exists.
 */
function requireApplicableParentForWork(
  db: Database.Database,
  session: string,
  taskScope: string,
  parentPurposeId: string,
  now: number,
): void {
  const parent = readPurpose(db, parentPurposeId);
  if (
    parent === null ||
    parent.session_id !== session ||
    parent.scope !== taskScope
  ) {
    throw new RepositoryNotFoundError(
      `parent purpose ${parentPurposeId} not found in session ${session}`,
    );
  }
  if (parent.status !== "active") {
    throw new AutonomyStateConflictError(
      `parent purpose ${parent.id} is ${parent.status}`,
    );
  }
  if (
    !isPurposeApplicableAt(
      { validFrom: parent.valid_from, validUntil: parent.valid_until },
      now,
    )
  ) {
    throw new AutonomyStateConflictError(
      `parent purpose ${parent.id} is not applicable now`,
    );
  }
}

function transitionPurpose(
  db: Database.Database,
  operation: "revoke" | "achieve",
  sessionId: string,
  purposeId: string,
  expectedVersion: number,
  key: string,
  now: number,
): {
  status: number;
  body: ReturnType<typeof toPurposeView>;
  replayed: boolean;
} {
  const session = requireId(sessionId, "sessionId");
  const purpose = requireId(purposeId, "purposeId");
  const scope = `purpose:${purpose}:${operation}`;
  const canonical = requireKey(key);
  const op =
    operation === "revoke"
      ? IDEMPOTENCY_OPERATIONS.revokePurpose
      : IDEMPOTENCY_OPERATIONS.achievePurpose;
  const hash = requestHash(op.operation, op.schemaVersion, {
    sessionId: session,
    purposeId: purpose,
    expectedVersion,
  });
  return withImmediate(db, () => {
    const existing = toStoredResponse(db, scope, canonical);
    if (existing !== null) {
      if (existing.requestHash !== hash) {
        throw new IdempotencyConflictError(scope);
      }
      const stored = parseOrValidation(
        () => PurposeViewSchema.parse(existing.responseBody),
        "stored purpose body",
      );
      return { status: existing.responseStatus, body: stored, replayed: true };
    }
    const row = assertOwnedPurpose(db, session, purpose);
    // Version (CAS) is checked before lifecycle state so a stale writer
    // always sees `autonomy_version_conflict` — the same order as the task
    // transitions below (version first, state second).
    if (row.version !== expectedVersion) {
      throw new AutonomyVersionConflictError(expectedVersion, row.version);
    }
    if (row.status !== "active") {
      throw new AutonomyStateConflictError(
        `purpose ${row.id} is ${row.status} and cannot be ${operation}d`,
      );
    }
    const terminal = operation === "revoke" ? "revoked" : "achieved";
    const moved = db
      .prepare(
        "UPDATE autonomy_purposes SET status = ?, version = ?, updated_at = ? WHERE id = ? AND status = 'active' AND version = ?",
      )
      .run(terminal, row.version + 1, now, row.id, row.version);
    if (moved.changes !== 1) {
      throw new AutonomyVersionConflictError(expectedVersion, row.version);
    }
    appendPurposeEventInTx(
      db,
      row.id,
      session,
      operation === "revoke" ? "revoked" : "achieved",
      "active",
      terminal,
      row.statement,
      now,
    );
    // The parent just became non-active (revoked or achieved): hold every
    // dependent NON-TERMINAL task atomically (never complete), so no
    // continued background execution under the superseded goal.
    holdDependentsForNonActiveParent(
      db,
      row.id,
      session,
      operation === "revoke" ? "purpose_revoked" : "purpose_achieved",
      now,
    );
    // Same-TX durable shadow source (covers the dependent holds too).
    enqueueShadowPolicyChangeInTx(
      db,
      session,
      row.scope,
      "purpose",
      row.id,
      operation === "revoke" ? "purpose.revoked" : "purpose.achieved",
      now,
    );
    const current = readPurpose(db, row.id);
    if (current === null) {
      throw new RepositoryNotFoundError(`purpose ${row.id} not found`);
    }
    const body = toPurposeView(current);
    storeIdempotentResponse(db, scope, canonical, hash, 200, body, now);
    return { status: 200, body, replayed: false };
  });
}

export function revokePurpose(
  db: Database.Database,
  sessionId: string,
  purposeId: string,
  expectedVersion: number,
  options: AutonomyKeyOptions,
): {
  status: number;
  body: ReturnType<typeof toPurposeView>;
  replayed: boolean;
} {
  return transitionPurpose(
    db,
    "revoke",
    sessionId,
    purposeId,
    expectedVersion,
    options.key,
    nowMs(options.now),
  );
}

export function achievePurpose(
  db: Database.Database,
  sessionId: string,
  purposeId: string,
  expectedVersion: number,
  options: AutonomyKeyOptions,
): {
  status: number;
  body: ReturnType<typeof toPurposeView>;
  replayed: boolean;
} {
  return transitionPurpose(
    db,
    "achieve",
    sessionId,
    purposeId,
    expectedVersion,
    options.key,
    nowMs(options.now),
  );
}

/* ------------------------------------------------------------------ */
/* Tasks                                                                */
/* ------------------------------------------------------------------ */

export interface CreateTaskInput {
  scope: string;
  title: string;
  body?: string;
  kind: TaskKind;
  speaker: TaskSpeaker;
  deadline?: string;
  parentPurposeId?: string;
}

export function createTask(
  db: Database.Database,
  sessionId: string,
  input: CreateTaskInput,
  options: AutonomyKeyOptions,
): { status: number; body: ReturnType<typeof toTaskView>; replayed: boolean } {
  const session = requireId(sessionId, "sessionId");
  const key = requireKey(options.key);
  const now = nowMs(options.now);
  const scope = `session:${session}:task`;
  const hash = requestHash(
    IDEMPOTENCY_OPERATIONS.createTask.operation,
    IDEMPOTENCY_OPERATIONS.createTask.schemaVersion,
    {
      sessionId: session,
      scope: input.scope,
      title: input.title,
      body: input.body ?? null,
      kind: input.kind,
      speaker: input.speaker,
      deadline: input.deadline ?? null,
      parentPurposeId: input.parentPurposeId ?? null,
    },
  );
  return withImmediate(db, () => {
    const existing = toStoredResponse(db, scope, key);
    if (existing !== null) {
      if (existing.requestHash !== hash) {
        throw new IdempotencyConflictError(scope);
      }
      const stored = parseOrValidation(
        () => TaskViewSchema.parse(existing.responseBody),
        "stored task body",
      );
      return {
        status: existing.responseStatus,
        body: stored as unknown as ReturnType<typeof toTaskView>,
        replayed: true,
      };
    }
    requireSession(db, session);
    if (
      input.deadline !== undefined &&
      !isStrictAutonomyDeadline(input.deadline)
    ) {
      throw new RepositoryValidationError(
        "deadline must be a strict RFC3339 instant with an explicit offset",
      );
    }
    if (input.parentPurposeId !== undefined) {
      const parent = assertOwnedPurpose(db, session, input.parentPurposeId);
      if (parent.scope !== input.scope) {
        throw new RepositoryValidationError(
          "parent purpose must share the task scope",
        );
      }
    } else if (input.speaker === "self") {
      // Derived self-proposed tasks require a parent trace; user-direct
      // tasks may stand alone.
      throw new RepositoryValidationError(
        "self-proposed tasks require a parent purpose",
      );
    }
    const id = generateId();
    db.prepare(
      "INSERT INTO autonomy_tasks (id, session_id, scope, title, body, kind, speaker, deadline, parent_purpose_id, status, version, hold_reason, reconsider_trigger, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 1, NULL, NULL, ?, ?)",
    ).run(
      id,
      session,
      input.scope,
      input.title,
      input.body ?? null,
      input.kind,
      input.speaker,
      input.deadline ?? null,
      input.parentPurposeId ?? null,
      now,
      now,
    );
    appendTaskEventInTx(db, id, session, "created", null, "open", null, now);
    // Same-TX durable shadow source (paused controls record, not queue).
    enqueueShadowPolicyChangeInTx(
      db,
      session,
      input.scope,
      "task",
      id,
      "task.created",
      now,
    );
    const row = readTask(db, id);
    if (row === null) {
      throw new RepositoryNotFoundError(`task ${id} not found`);
    }
    const body = toTaskView(row);
    storeIdempotentResponse(db, scope, key, hash, 201, body, now);
    return { status: 201, body, replayed: false };
  });
}

export function listTasks(
  db: Database.Database,
  sessionId: string,
  limit = 50,
): { items: ReturnType<typeof toTaskView>[] } {
  const session = requireId(sessionId, "sessionId");
  requireSession(db, session);
  const capped = Math.min(Math.max(limit, 1), 100);
  const rows = db
    .prepare(
      "SELECT * FROM autonomy_tasks WHERE session_id = ? ORDER BY created_at DESC, id ASC LIMIT ?",
    )
    .all(session, capped) as RawTask[];
  return { items: rows.map(toTaskView) };
}

/**
 * Scope-filtered internal reader for the shadow port (NOT a public list
 * DTO): SQL filters `(session, scope)` BEFORE the limit and reads up to
 * `limit` rows (callers pass 101) so the builder detects REAL overflow.
 * Reuses the exact `toTaskView` mapper (no second projection).
 */
export function listTasksInScope(
  db: Database.Database,
  sessionId: string,
  scope: string,
  limit = 101,
): { items: ReturnType<typeof toTaskView>[] } {
  const session = requireId(sessionId, "sessionId");
  if (scope.length === 0 || scope.length > 128) {
    throw new RepositoryValidationError("scope must be 1..128 chars");
  }
  requireSession(db, session);
  const capped = Math.min(Math.max(limit, 1), 101);
  const rows = db
    .prepare(
      "SELECT * FROM autonomy_tasks WHERE session_id = ? AND scope = ? ORDER BY created_at DESC, id ASC LIMIT ?",
    )
    .all(session, scope, capped) as RawTask[];
  return { items: rows.map(toTaskView) };
}

export function getTask(
  db: Database.Database,
  sessionId: string,
  taskId: string,
): ReturnType<typeof toTaskView> {
  return toTaskView(assertOwnedTask(db, sessionId, taskId));
}

export function listTaskEvents(
  db: Database.Database,
  sessionId: string,
  taskId: string,
): {
  taskId: string;
  events: {
    seq: number;
    event: string;
    fromStatus: string | null;
    toStatus: string;
    note: string | null;
    createdAt: number;
  }[];
} {
  const owned = assertOwnedTask(db, sessionId, taskId);
  const rows = db
    .prepare(
      "SELECT seq, event, from_status, to_status, note, created_at FROM autonomy_task_events WHERE task_id = ? ORDER BY seq ASC",
    )
    .all(owned.id) as {
    seq: number;
    event: string;
    from_status: string | null;
    to_status: string;
    note: string | null;
    created_at: number;
  }[];
  return {
    taskId: owned.id,
    events: rows.map((row) => ({
      seq: row.seq,
      event: row.event,
      fromStatus: row.from_status,
      toStatus: row.to_status,
      note: row.note,
      createdAt: row.created_at,
    })),
  };
}

function transitionTask(
  db: Database.Database,
  operation: "start" | "complete" | "cancel",
  sessionId: string,
  taskId: string,
  expectedVersion: number,
  key: string,
  now: number,
): {
  status: number;
  body: ReturnType<typeof toTaskView>;
  replayed: boolean;
} {
  const session = requireId(sessionId, "sessionId");
  const task = requireId(taskId, "taskId");
  const scope = `task:${task}:${operation}`;
  const canonical = requireKey(key);
  const op =
    operation === "start"
      ? IDEMPOTENCY_OPERATIONS.startTask
      : operation === "complete"
        ? IDEMPOTENCY_OPERATIONS.completeTask
        : IDEMPOTENCY_OPERATIONS.cancelTask;
  const hash = requestHash(op.operation, op.schemaVersion, {
    sessionId: session,
    taskId: task,
    expectedVersion,
  });
  return withImmediate(db, () => {
    const existing = toStoredResponse(db, scope, canonical);
    if (existing !== null) {
      if (existing.requestHash !== hash) {
        throw new IdempotencyConflictError(scope);
      }
      const stored = parseOrValidation(
        () => TaskViewSchema.parse(existing.responseBody),
        "stored task body",
      );
      return {
        status: existing.responseStatus,
        body: stored as unknown as ReturnType<typeof toTaskView>,
        replayed: true,
      };
    }
    const row = assertOwnedTask(db, session, task);
    if (row.version !== expectedVersion) {
      throw new AutonomyVersionConflictError(expectedVersion, row.version);
    }
    let from: string;
    let to: string;
    if (operation === "start") {
      if (row.status !== "open") {
        throw new AutonomyStateConflictError(
          `task ${row.id} is ${row.status} and cannot start`,
        );
      }
      // Only an active + applicable parent gates start (frozen now); no
      // automatic reparenting: an explicit new parent must be resumed in.
      if (row.parent_purpose_id !== null) {
        requireApplicableParentForWork(
          db,
          session,
          row.scope,
          row.parent_purpose_id,
          now,
        );
      }
      from = "open";
      to = "in_progress";
    } else if (operation === "complete") {
      if (
        row.status !== "open" &&
        row.status !== "in_progress" &&
        row.status !== "held"
      ) {
        throw new AutonomyStateConflictError(
          `task ${row.id} is ${row.status} and cannot complete`,
        );
      }
      from = row.status;
      to = "completed";
    } else {
      if (
        row.status !== "open" &&
        row.status !== "in_progress" &&
        row.status !== "held"
      ) {
        throw new AutonomyStateConflictError(
          `task ${row.id} is ${row.status} and cannot cancel`,
        );
      }
      from = row.status;
      to = "cancelled";
    }
    const moved = db
      .prepare(
        "UPDATE autonomy_tasks SET status = ?, version = ?, updated_at = ?, hold_reason = NULL, reconsider_trigger = NULL WHERE id = ? AND status = ? AND version = ?",
      )
      .run(to, row.version + 1, now, row.id, from, row.version);
    if (moved.changes !== 1) {
      throw new AutonomyVersionConflictError(expectedVersion, row.version);
    }
    appendTaskEventInTx(
      db,
      row.id,
      session,
      operation === "start"
        ? "started"
        : operation === "complete"
          ? "completed"
          : "cancelled",
      from,
      to,
      null,
      now,
    );
    // Same-TX durable shadow source (paused controls record, not queue).
    enqueueShadowPolicyChangeInTx(
      db,
      session,
      row.scope,
      "task",
      row.id,
      operation === "start"
        ? "task.started"
        : operation === "complete"
          ? "task.completed"
          : "task.cancelled",
      now,
    );
    const current = readTask(db, row.id);
    if (current === null) {
      throw new RepositoryNotFoundError(`task ${row.id} not found`);
    }
    const body = toTaskView(current);
    storeIdempotentResponse(db, scope, canonical, hash, 200, body, now);
    return { status: 200, body, replayed: false };
  });
}

export function startTask(
  db: Database.Database,
  sessionId: string,
  taskId: string,
  expectedVersion: number,
  options: AutonomyKeyOptions,
): {
  status: number;
  body: ReturnType<typeof toTaskView>;
  replayed: boolean;
} {
  return transitionTask(
    db,
    "start",
    sessionId,
    taskId,
    expectedVersion,
    options.key,
    nowMs(options.now),
  );
}

export function completeTask(
  db: Database.Database,
  sessionId: string,
  taskId: string,
  expectedVersion: number,
  options: AutonomyKeyOptions,
): {
  status: number;
  body: ReturnType<typeof toTaskView>;
  replayed: boolean;
} {
  return transitionTask(
    db,
    "complete",
    sessionId,
    taskId,
    expectedVersion,
    options.key,
    nowMs(options.now),
  );
}

export function cancelTask(
  db: Database.Database,
  sessionId: string,
  taskId: string,
  expectedVersion: number,
  options: AutonomyKeyOptions,
): {
  status: number;
  body: ReturnType<typeof toTaskView>;
  replayed: boolean;
} {
  return transitionTask(
    db,
    "cancel",
    sessionId,
    taskId,
    expectedVersion,
    options.key,
    nowMs(options.now),
  );
}

export interface HoldTaskInput {
  expectedVersion: number;
  reason: string;
  reconsiderTrigger: string;
}

export function holdTask(
  db: Database.Database,
  sessionId: string,
  taskId: string,
  input: HoldTaskInput,
  options: AutonomyKeyOptions,
): {
  status: number;
  body: ReturnType<typeof toTaskView>;
  replayed: boolean;
} {
  const session = requireId(sessionId, "sessionId");
  const task = requireId(taskId, "taskId");
  const scope = `task:${task}:hold`;
  const canonical = requireKey(options.key);
  const now = nowMs(options.now);
  const hash = requestHash(
    IDEMPOTENCY_OPERATIONS.holdTask.operation,
    IDEMPOTENCY_OPERATIONS.holdTask.schemaVersion,
    {
      sessionId: session,
      taskId: task,
      expectedVersion: input.expectedVersion,
      reason: input.reason,
      reconsiderTrigger: input.reconsiderTrigger,
    },
  );
  return withImmediate(db, () => {
    const existing = toStoredResponse(db, scope, canonical);
    if (existing !== null) {
      if (existing.requestHash !== hash) {
        throw new IdempotencyConflictError(scope);
      }
      const stored = parseOrValidation(
        () => TaskViewSchema.parse(existing.responseBody),
        "stored task body",
      );
      return {
        status: existing.responseStatus,
        body: stored as unknown as ReturnType<typeof toTaskView>,
        replayed: true,
      };
    }
    const row = assertOwnedTask(db, session, task);
    if (row.version !== input.expectedVersion) {
      throw new AutonomyVersionConflictError(
        input.expectedVersion,
        row.version,
      );
    }
    // Hold requires a reason AND a reconsideration trigger, and applies to
    // open / in_progress tasks only. A hold is never resumed from a timer
    // alone (no timer field exists on resume either).
    if (row.status !== "open" && row.status !== "in_progress") {
      throw new AutonomyStateConflictError(
        `task ${row.id} is ${row.status} and cannot hold`,
      );
    }
    const moved = db
      .prepare(
        "UPDATE autonomy_tasks SET status = 'held', version = ?, updated_at = ?, hold_reason = ?, reconsider_trigger = ? WHERE id = ? AND status = ? AND version = ?",
      )
      .run(
        row.version + 1,
        now,
        input.reason,
        input.reconsiderTrigger,
        row.id,
        row.status,
        row.version,
      );
    if (moved.changes !== 1) {
      throw new AutonomyVersionConflictError(
        input.expectedVersion,
        row.version,
      );
    }
    appendTaskEventInTx(
      db,
      row.id,
      session,
      "held",
      row.status,
      "held",
      input.reason,
      now,
    );
    // Same-TX durable shadow source (paused controls record, not queue).
    enqueueShadowPolicyChangeInTx(
      db,
      session,
      row.scope,
      "task",
      row.id,
      "task.held",
      now,
    );
    const current = readTask(db, row.id);
    if (current === null) {
      throw new RepositoryNotFoundError(`task ${row.id} not found`);
    }
    const body = toTaskView(current);
    storeIdempotentResponse(db, scope, canonical, hash, 200, body, now);
    return { status: 200, body, replayed: false };
  });
}

export interface ResumeTaskInput {
  expectedVersion: number;
  evidenceKind: ResumeEvidenceKind;
  evidence: string;
  newParentPurposeId?: string;
}

export function resumeTask(
  db: Database.Database,
  sessionId: string,
  taskId: string,
  input: ResumeTaskInput,
  options: AutonomyKeyOptions,
): {
  status: number;
  body: ReturnType<typeof toTaskView>;
  replayed: boolean;
} {
  const session = requireId(sessionId, "sessionId");
  const task = requireId(taskId, "taskId");
  const scope = `task:${task}:resume`;
  const canonical = requireKey(options.key);
  const now = nowMs(options.now);
  const hash = requestHash(
    IDEMPOTENCY_OPERATIONS.resumeTask.operation,
    IDEMPOTENCY_OPERATIONS.resumeTask.schemaVersion,
    {
      sessionId: session,
      taskId: task,
      expectedVersion: input.expectedVersion,
      evidenceKind: input.evidenceKind,
      evidence: input.evidence,
      newParentPurposeId: input.newParentPurposeId ?? null,
    },
  );
  return withImmediate(db, () => {
    const existing = toStoredResponse(db, scope, canonical);
    if (existing !== null) {
      if (existing.requestHash !== hash) {
        throw new IdempotencyConflictError(scope);
      }
      const stored = parseOrValidation(
        () => TaskViewSchema.parse(existing.responseBody),
        "stored task body",
      );
      return {
        status: existing.responseStatus,
        body: stored as unknown as ReturnType<typeof toTaskView>,
        replayed: true,
      };
    }
    const row = assertOwnedTask(db, session, task);
    if (row.version !== input.expectedVersion) {
      throw new AutonomyVersionConflictError(
        input.expectedVersion,
        row.version,
      );
    }
    if (row.status !== "held") {
      throw new AutonomyStateConflictError(
        `task ${row.id} is ${row.status} and cannot resume`,
      );
    }
    // A non-active parent blocks blind resume: an explicit new parent
    // (same-session/scope owned, active + applicable at frozen now) must
    // be supplied. The new parent may itself be a permission CLAIM —
    // recording it is still only a claim and grants nothing. No automatic
    // reparenting exists: without an explicit new parent the resume fails.
    let nextParent = row.parent_purpose_id;
    if (row.parent_purpose_id !== null) {
      const parent = readPurpose(db, row.parent_purpose_id);
      if (
        parent === null ||
        parent.session_id !== session ||
        parent.status !== "active" ||
        !isPurposeApplicableAt(
          { validFrom: parent.valid_from, validUntil: parent.valid_until },
          now,
        )
      ) {
        if (input.newParentPurposeId === undefined) {
          throw new AutonomyStateConflictError(
            `task ${row.id} parent is not active and applicable; an explicit new parent is required`,
          );
        }
        const replacement = assertOwnedPurpose(
          db,
          session,
          input.newParentPurposeId,
        );
        if (replacement.status !== "active") {
          throw new AutonomyStateConflictError(
            `replacement parent ${replacement.id} is ${replacement.status}`,
          );
        }
        if (replacement.scope !== row.scope) {
          throw new RepositoryValidationError(
            "replacement parent must share the task scope",
          );
        }
        if (
          !isPurposeApplicableAt(
            {
              validFrom: replacement.valid_from,
              validUntil: replacement.valid_until,
            },
            now,
          )
        ) {
          throw new AutonomyStateConflictError(
            `replacement parent ${replacement.id} is not applicable now`,
          );
        }
        nextParent = replacement.id;
      } else if (input.newParentPurposeId !== undefined) {
        const replacement = assertOwnedPurpose(
          db,
          session,
          input.newParentPurposeId,
        );
        if (replacement.status !== "active") {
          throw new AutonomyStateConflictError(
            `replacement parent ${replacement.id} is ${replacement.status}`,
          );
        }
        if (replacement.scope !== row.scope) {
          throw new RepositoryValidationError(
            "replacement parent must share the task scope",
          );
        }
        if (
          !isPurposeApplicableAt(
            {
              validFrom: replacement.valid_from,
              validUntil: replacement.valid_until,
            },
            now,
          )
        ) {
          throw new AutonomyStateConflictError(
            `replacement parent ${replacement.id} is not applicable now`,
          );
        }
        nextParent = replacement.id;
      }
    } else if (input.newParentPurposeId !== undefined) {
      const replacement = assertOwnedPurpose(
        db,
        session,
        input.newParentPurposeId,
      );
      if (replacement.status !== "active") {
        throw new AutonomyStateConflictError(
          `replacement parent ${replacement.id} is ${replacement.status}`,
        );
      }
      if (replacement.scope !== row.scope) {
        throw new RepositoryValidationError(
          "replacement parent must share the task scope",
        );
      }
      if (
        !isPurposeApplicableAt(
          {
            validFrom: replacement.valid_from,
            validUntil: replacement.valid_until,
          },
          now,
        )
      ) {
        throw new AutonomyStateConflictError(
          `replacement parent ${replacement.id} is not applicable now`,
        );
      }
      nextParent = replacement.id;
    }
    // The effective parent (kept or replaced) must be active + applicable
    // at frozen now before the task may resume.
    if (nextParent !== null) {
      requireApplicableParentForWork(db, session, row.scope, nextParent, now);
    }
    const moved = db
      .prepare(
        "UPDATE autonomy_tasks SET status = 'in_progress', version = ?, updated_at = ?, parent_purpose_id = ?, hold_reason = NULL, reconsider_trigger = NULL WHERE id = ? AND status = 'held' AND version = ?",
      )
      .run(row.version + 1, now, nextParent, row.id, row.version);
    if (moved.changes !== 1) {
      throw new AutonomyVersionConflictError(
        input.expectedVersion,
        row.version,
      );
    }
    appendTaskEventInTx(
      db,
      row.id,
      session,
      "resumed",
      "held",
      "in_progress",
      `${input.evidenceKind}: ${input.evidence}`,
      now,
    );
    // Same-TX durable shadow source: resume needs new meaningful state, so
    // a resumed task re-enters deliberation (no catchup for paused time).
    enqueueShadowPolicyChangeInTx(
      db,
      session,
      row.scope,
      "task",
      row.id,
      "task.resumed",
      now,
    );
    const current = readTask(db, row.id);
    if (current === null) {
      throw new RepositoryNotFoundError(`task ${row.id} not found`);
    }
    const body = toTaskView(current);
    storeIdempotentResponse(db, scope, canonical, hash, 200, body, now);
    return { status: 200, body, replayed: false };
  });
}

/* ------------------------------------------------------------------ */
/* Conversation proposals (AV03 proposal-only staging core)             */
/*                                                                     */
/* A proposal is a durable INFERRED draft staged ONLY by the model-only */
/* tools `purpose.propose` / `task.propose` (never by the human UI,     */
/* never by background work). Staging creates NO purpose, NO task, NO  */
/* grant, NO calendar write, NO notification, and never touches the     */
/* stop control. The quote is the immutable ORIGINAL exact substring   */
/* of the CURRENT ordinary `user_text` turn body the calling run was   */
/* dispatched from (server-derived, never model input); the model      */
/* interpretation is stored SEPARATELY and can never rewrite the quote */
/* or bind an external/injected read record as a user instruction.     */
/* Source kind is hardcoded `model` (inference, never user instruction */
/* and never an actual permission grant). Only `user_text` turns are   */
/* eligible sources: action approval/rejection/system/tool turns fail  */
/* closed. Draft kind is explicit (casual/wish/problem/task/deadline): */
/* a casual remark stays casual (no mandatory taskization); a model    */
/* do-nothing stages nothing. Model tools accept NO date fields at     */
/* all: task drafts adopt with a NULL deadline and purpose drafts with */
/* a NULL window unless the trusted human supplies an explicit strict  */
/* value at accept time. Task drafts REQUIRE an explicit parent        */
/* (id + expected version, same session/scope, active — checked at    */
/* stage AND re-checked at adopt); the model can never auto-pick one.  */
/* Decisions are trusted-human only (accept = atomic create + accept,  */
/* reject = terminal with zero side effects) and NEVER resume the     */
/* global stop control.                                                */
/* ------------------------------------------------------------------ */

/** Closed conversation-proposal target vocabulary. */
export type ConversationTarget = ConversationProposalTarget;
/** Closed explicit draft-kind vocabulary. */
export type ConversationDraftKindValue = ConversationDraftKind;

/** Max PENDING drafts per session (borrowed tool-list cap, not a budget). */
const MAX_PENDING_PROPOSALS_PER_SESSION = 20;

interface RawProposal {
  id: string;
  session_id: string;
  scope: string;
  target: string;
  draft_kind: string;
  purpose_kind: string | null;
  task_kind: string | null;
  source_quote: string;
  interpretation: string;
  source_kind: string;
  source_turn_id: string;
  source_run_id: string;
  parent_purpose_id: string | null;
  expected_parent_version: number | null;
  request_hash: string;
  stage_call_id: string;
  status: string;
  version: number;
  accepted_target_id: string | null;
  created_at: number;
  updated_at: number;
}

function toProposalView(row: RawProposal): {
  id: string;
  sessionId: string;
  scope: string;
  target: ConversationProposalTarget;
  draftKind: ConversationDraftKind;
  purposeKind: PurposeKind | null;
  taskKind: TaskKind | null;
  sourceQuote: string;
  interpretation: string;
  sourceKind: "model";
  sourceTurnId: string;
  sourceRunId: string;
  parentPurposeId: string | null;
  expectedParentVersion: number | null;
  status: "pending" | "accepted" | "rejected";
  version: number;
  acceptedTargetId: string | null;
  createdAt: number;
  updatedAt: number;
} {
  return parseOrValidation(
    () =>
      ConversationProposalViewSchema.parse({
        id: row.id,
        sessionId: row.session_id,
        scope: row.scope,
        target: row.target,
        draftKind: row.draft_kind,
        purposeKind: row.purpose_kind,
        taskKind: row.task_kind,
        sourceQuote: row.source_quote,
        interpretation: row.interpretation,
        sourceKind: row.source_kind,
        sourceTurnId: row.source_turn_id,
        sourceRunId: row.source_run_id,
        parentPurposeId: row.parent_purpose_id,
        expectedParentVersion: row.expected_parent_version,
        status: row.status,
        version: row.version,
        acceptedTargetId: row.accepted_target_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }),
    "stored conversation proposal",
  );
}

function readProposal(
  db: Database.Database,
  proposalId: string,
): RawProposal | null {
  return (
    (db
      .prepare("SELECT * FROM conversation_proposals WHERE id = ?")
      .get(proposalId) as RawProposal | undefined) ?? null
  );
}

/**
 * Ownership-first proposal lookup (foreign ids are 404, never 403).
 */
export function assertOwnedProposal(
  db: Database.Database,
  sessionId: string,
  proposalId: string,
): RawProposal {
  const session = requireId(sessionId, "sessionId");
  const proposal = requireId(proposalId, "proposalId");
  const row = readProposal(db, proposal);
  if (row === null || row.session_id !== session) {
    throw new RepositoryNotFoundError(
      `proposal ${proposal} not found in session ${session}`,
    );
  }
  return row;
}

function appendProposalEventInTx(
  db: Database.Database,
  proposalId: string,
  sessionId: string,
  event: "proposed" | "accepted" | "rejected",
  fromStatus: string | null,
  toStatus: string,
  note: string | null,
  now: number,
): void {
  const seqRow = db
    .prepare(
      "SELECT COALESCE(MAX(seq), 0) AS max_seq FROM conversation_proposal_events WHERE proposal_id = ?",
    )
    .get(proposalId) as { max_seq: number };
  db.prepare(
    "INSERT INTO conversation_proposal_events (id, proposal_id, session_id, seq, event, from_status, to_status, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    generateId(),
    proposalId,
    sessionId,
    seqRow.max_seq + 1,
    event,
    fromStatus,
    toStatus,
    note,
    now,
  );
}

function codePointsOf(text: string): number {
  return Array.from(text).length;
}

/**
 * Count EXACT occurrences of `quote` inside `body`, including overlaps
 * (e.g. quote "aa" occurs twice in body "aaa"). Matching is exact on the
 * ORIGINAL strings: no normalization, no case folding, no trimming — the
 * stored quote must identify exactly ONE passage of the source body.
 */
function countExactOccurrences(body: string, quote: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = body.indexOf(quote, from);
    if (at === -1) return count;
    count += 1;
    from = at + 1;
  }
}

export interface StageConversationProposalDraft {
  scope: string;
  target: ConversationProposalTarget;
  draftKind: ConversationDraftKind;
  purposeKind?: PurposeKind;
  taskKind?: TaskKind;
  sourceQuote: string;
  interpretation: string;
  parentPurposeId?: string;
  expectedParentVersion?: number;
}

export interface StageConversationProposalSource {
  sourceRunId: string;
  sourceTurnId: string;
  /** CURRENT ordinary `user_text` body the calling run was dispatched from. */
  userText: string;
}

/**
 * Stage one durable inferred draft. The caller derives the source
 * (session/run/turn/text) server-side; this function re-verifies the
 * quote is a nonempty EXACT substring of the CURRENT source body, the
 * parent (task drafts) is owned + same-scope + active + version-matched,
 * and dedups semantically (same exact input replays the pending draft).
 * Creates NO purpose/task/grant/calendar/notification and never touches
 * the stop control.
 */
export function stageConversationProposal(
  db: Database.Database,
  sessionId: string,
  draft: StageConversationProposalDraft,
  source: StageConversationProposalSource,
  options: AutonomyKeyOptions,
): {
  status: number;
  body: ReturnType<typeof toProposalView>;
  replayed: boolean;
} {
  const session = requireId(sessionId, "sessionId");
  const key = requireKey(options.key);
  const now = nowMs(options.now);
  const sourceRun = requireId(source.sourceRunId, "sourceRunId");
  const sourceTurn = requireId(source.sourceTurnId, "sourceTurnId");
  if (draft.scope.length === 0 || draft.scope.length > 128) {
    throw new RepositoryValidationError("scope must be 1..128 chars");
  }
  if (draft.target !== "purpose" && draft.target !== "task") {
    throw new RepositoryValidationError("target must be purpose or task");
  }
  const quote = draft.sourceQuote;
  if (quote.length === 0 || quote.trim().length === 0) {
    throw new RepositoryValidationError("sourceQuote must be nonempty");
  }
  if (!source.userText.includes(quote)) {
    throw new RepositoryValidationError(
      "sourceQuote must be an exact substring of the current source body",
    );
  }
  // The quote must identify EXACTLY ONE passage: a repeated (or
  // overlapping) quote is ambiguous and stages nothing. Checked here,
  // before any pending insert, against the server-bound source body.
  if (countExactOccurrences(source.userText, quote) !== 1) {
    throw new RepositoryValidationError(
      "sourceQuote must occur exactly once in the current source body",
    );
  }
  const quoteCap = draft.target === "task" ? 256 : 2000;
  if (codePointsOf(quote) > quoteCap) {
    throw new RepositoryValidationError(
      `sourceQuote over ${quoteCap} code points`,
    );
  }
  if (
    draft.interpretation.length === 0 ||
    codePointsOf(draft.interpretation) > 2000
  ) {
    throw new RepositoryValidationError(
      "interpretation must be 1..2000 code points",
    );
  }
  if (draft.target === "purpose") {
    if (draft.purposeKind === undefined) {
      throw new RepositoryValidationError(
        "purposeKind is required for purpose drafts",
      );
    }
    if (draft.taskKind !== undefined) {
      throw new RepositoryValidationError(
        "taskKind is not accepted for purpose drafts",
      );
    }
    if (
      draft.parentPurposeId !== undefined ||
      draft.expectedParentVersion !== undefined
    ) {
      throw new RepositoryValidationError(
        "parent is not accepted for purpose drafts",
      );
    }
  } else {
    if (draft.taskKind === undefined) {
      throw new RepositoryValidationError(
        "taskKind is required for task drafts",
      );
    }
    if (draft.purposeKind !== undefined) {
      throw new RepositoryValidationError(
        "purposeKind is not accepted for task drafts",
      );
    }
    if (draft.parentPurposeId === undefined) {
      throw new RepositoryValidationError(
        "task drafts require an explicit parent purpose",
      );
    }
    requireId(draft.parentPurposeId, "parentPurposeId");
    if (
      draft.expectedParentVersion === undefined ||
      !Number.isInteger(draft.expectedParentVersion) ||
      draft.expectedParentVersion < 1
    ) {
      throw new RepositoryValidationError(
        "task drafts require an explicit expectedParentVersion >= 1",
      );
    }
  }
  // Semantic dedup key: the source RUN is audit only (stored on the row)
  // and must not participate in dedup — a retry runs under a new run id
  // for the same turn/draft and must replay the still-pending draft.
  const hash = requestHash(
    IDEMPOTENCY_OPERATIONS.stageConversationProposal.operation,
    IDEMPOTENCY_OPERATIONS.stageConversationProposal.schemaVersion,
    {
      sessionId: session,
      scope: draft.scope,
      target: draft.target,
      draftKind: draft.draftKind,
      purposeKind: draft.purposeKind ?? null,
      taskKind: draft.taskKind ?? null,
      sourceQuote: quote,
      interpretation: draft.interpretation,
      parentPurposeId: draft.parentPurposeId ?? null,
      expectedParentVersion: draft.expectedParentVersion ?? null,
      sourceTurnId: sourceTurn,
    },
  );
  const scope = `session:${session}:conv_proposal`;
  return withImmediate(db, () => {
    const existing = toStoredResponse(db, scope, key);
    if (existing !== null) {
      if (existing.requestHash !== hash) {
        throw new IdempotencyConflictError(scope);
      }
      const body = parseOrValidation(
        () => ConversationProposalViewSchema.parse(existing.responseBody),
        "stored proposal body",
      );
      return { status: existing.responseStatus, body, replayed: true };
    }
    requireSession(db, session);
    // Semantic replay: an identical exact draft that is still pending
    // replays instead of duplicating (ordinary repeated model calls with
    // the same source quote stage nothing new; a meaningfully new source
    // hashes differently and stages a new draft).
    const dup = db
      .prepare(
        "SELECT * FROM conversation_proposals WHERE session_id = ? AND request_hash = ? AND status = 'pending' ORDER BY created_at ASC, id ASC LIMIT 1",
      )
      .get(session, hash) as RawProposal | undefined;
    if (dup !== undefined) {
      const body = toProposalView(dup);
      storeIdempotentResponse(db, scope, key, hash, 200, body, now);
      return { status: 200, body, replayed: true };
    }
    if (draft.target === "task") {
      // Parent checked at stage (owned, same scope, active, CAS version);
      // adoption re-checks before creating anything.
      const parent = assertOwnedPurpose(
        db,
        session,
        draft.parentPurposeId as string,
      );
      if (parent.scope !== draft.scope) {
        throw new RepositoryValidationError(
          "parent purpose must share the draft scope",
        );
      }
      if (parent.status !== "active") {
        throw new AutonomyStateConflictError(
          `parent purpose ${parent.id} is ${parent.status}`,
        );
      }
      if (parent.version !== draft.expectedParentVersion) {
        throw new AutonomyVersionConflictError(
          draft.expectedParentVersion as number,
          parent.version,
        );
      }
    }
    const pending = db
      .prepare(
        "SELECT COUNT(*) AS n FROM conversation_proposals WHERE session_id = ? AND status = 'pending'",
      )
      .get(session) as { n: number };
    if (pending.n >= MAX_PENDING_PROPOSALS_PER_SESSION) {
      throw new RepositoryValidationError("proposal backlog full");
    }
    const id = generateId();
    db.prepare(
      "INSERT INTO conversation_proposals (id, session_id, scope, target, draft_kind, purpose_kind, task_kind, source_quote, interpretation, source_kind, source_turn_id, source_run_id, parent_purpose_id, expected_parent_version, request_hash, stage_call_id, status, version, accepted_target_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'model', ?, ?, ?, ?, ?, ?, 'pending', 1, NULL, ?, ?)",
    ).run(
      id,
      session,
      draft.scope,
      draft.target,
      draft.draftKind,
      draft.purposeKind ?? null,
      draft.taskKind ?? null,
      quote,
      draft.interpretation,
      sourceTurn,
      sourceRun,
      draft.parentPurposeId ?? null,
      draft.expectedParentVersion ?? null,
      hash,
      key,
      now,
      now,
    );
    appendProposalEventInTx(
      db,
      id,
      session,
      "proposed",
      null,
      "pending",
      `staged from user_text turn ${sourceTurn}`,
      now,
    );
    // Deliberately NO shadow projection, NO notification, NO control
    // write: drafts stay quiet until the human reviews them.
    const row = readProposal(db, id);
    if (row === null) {
      throw new RepositoryNotFoundError(`proposal ${id} not found`);
    }
    const body = toProposalView(row);
    storeIdempotentResponse(db, scope, key, hash, 201, body, now);
    return { status: 201, body, replayed: false };
  });
}

const PROPOSAL_CURSOR_BYTES =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function encodeProposalCursor(createdAt: number, id: string): string {
  const raw = `${createdAt}:${id}`;
  let out = "";
  for (let i = 0; i < raw.length; i += 3) {
    const a = raw.charCodeAt(i);
    const b = i + 1 < raw.length ? raw.charCodeAt(i + 1) : NaN;
    const c = i + 2 < raw.length ? raw.charCodeAt(i + 2) : NaN;
    out += PROPOSAL_CURSOR_BYTES[(a >> 2) & 63];
    out +=
      PROPOSAL_CURSOR_BYTES[
        ((a & 3) << 4) | (Number.isNaN(b) ? 0 : (b >> 4) & 15)
      ];
    out += Number.isNaN(b)
      ? ""
      : PROPOSAL_CURSOR_BYTES[
          ((b & 15) << 2) | (Number.isNaN(c) ? 0 : (c >> 6) & 3)
        ];
    out += Number.isNaN(c) ? "" : PROPOSAL_CURSOR_BYTES[c & 63];
  }
  return out;
}

function decodeProposalCursor(cursor: string): {
  createdAt: number;
  id: string;
} {
  const fail = (): never => {
    throw new RepositoryValidationError("invalid proposal cursor");
  };
  if (cursor.length === 0 || cursor.length > 2048) fail();
  const vals = new Array<number>(cursor.length);
  for (let i = 0; i < cursor.length; i += 1) {
    const v = PROPOSAL_CURSOR_BYTES.indexOf(cursor[i] as string);
    if (v === -1) fail();
    vals[i] = v;
  }
  let raw = "";
  for (let i = 0; i < vals.length; i += 4) {
    const a = vals[i] as number;
    const b = (vals[i + 1] ?? 0) as number;
    const c = (vals[i + 2] ?? -1) as number;
    const d = (vals[i + 3] ?? -1) as number;
    raw += String.fromCharCode(((a << 2) | (b >> 4)) & 255);
    if (c !== -1)
      raw += String.fromCharCode((((b & 15) << 4) | (c >> 2)) & 255);
    if (d !== -1) raw += String.fromCharCode((((c & 3) << 6) | d) & 255);
  }
  const sep = raw.indexOf(":");
  if (sep === -1) fail();
  const createdAt = Number(raw.slice(0, sep));
  const id = raw.slice(sep + 1);
  if (!Number.isInteger(createdAt) || createdAt < 0 || !isUuidV4(id)) fail();
  return { createdAt, id };
}

export interface ListConversationProposalsQuery {
  limit?: number;
  /** Opaque cursor: the next older page strictly below this position. */
  cursor?: string;
  /** Optional status filter (e.g. the pending review queue). */
  status?: "pending" | "accepted" | "rejected";
}

/**
 * Newest-first proposal history with a stable opaque keyset
 * (created_at, id) and a LIMIT+1 probe, so every owned row — including an
 * old pending draft buried under newer decisions — stays reachable.
 * `pendingCount` always covers ALL owned pending drafts (never the page).
 * Pure read: no mutations, no cursor advancement writes. An unknown cursor
 * id is just a keyset bound (never a 404 oracle for foreign ids).
 */
export function listConversationProposals(
  db: Database.Database,
  sessionId: string,
  query: ListConversationProposalsQuery = {},
): {
  items: ReturnType<typeof toProposalView>[];
  nextCursor: string | null;
  hasMore: boolean;
  pendingCount: number;
} {
  const session = requireId(sessionId, "sessionId");
  requireSession(db, session);
  const capped = Math.min(Math.max(query.limit ?? 50, 1), 100);
  if (
    query.status !== undefined &&
    query.status !== "pending" &&
    query.status !== "accepted" &&
    query.status !== "rejected"
  ) {
    throw new RepositoryValidationError(
      "proposal status must be pending, accepted, or rejected",
    );
  }
  const bound =
    query.cursor === undefined ? null : decodeProposalCursor(query.cursor);
  const clauses = ["session_id = ?"];
  const args: (string | number)[] = [session];
  if (query.status !== undefined) {
    clauses.push("status = ?");
    args.push(query.status);
  }
  if (bound !== null) {
    clauses.push("(created_at < ? OR (created_at = ? AND id > ?))");
    args.push(bound.createdAt, bound.createdAt, bound.id);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const rows = db
    .prepare(
      `SELECT * FROM conversation_proposals ${where} ORDER BY created_at DESC, id ASC LIMIT ?`,
    )
    .all(...args, capped + 1) as RawProposal[];
  const hasMore = rows.length > capped;
  const page = hasMore ? rows.slice(0, capped) : rows;
  const last = page[page.length - 1];
  const pending = db
    .prepare(
      "SELECT COUNT(*) AS n FROM conversation_proposals WHERE session_id = ? AND status = 'pending'",
    )
    .get(session) as { n: number };
  return {
    items: page.map(toProposalView),
    nextCursor:
      hasMore && last !== undefined
        ? encodeProposalCursor(last.created_at, last.id)
        : null,
    hasMore,
    pendingCount: pending.n,
  };
}

export function getConversationProposal(
  db: Database.Database,
  sessionId: string,
  proposalId: string,
): ReturnType<typeof toProposalView> {
  return toProposalView(assertOwnedProposal(db, sessionId, proposalId));
}

export function listConversationProposalEvents(
  db: Database.Database,
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
  const owned = assertOwnedProposal(db, sessionId, proposalId);
  const rows = db
    .prepare(
      "SELECT seq, event, from_status, to_status, created_at FROM conversation_proposal_events WHERE proposal_id = ? ORDER BY seq ASC",
    )
    .all(owned.id) as {
    seq: number;
    event: string;
    from_status: string | null;
    to_status: string;
    created_at: number;
  }[];
  return {
    proposalId: owned.id,
    events: rows.map((row) => ({
      seq: row.seq,
      event: row.event,
      fromStatus: row.from_status,
      toStatus: row.to_status,
      createdAt: row.created_at,
    })),
  };
}

export interface AcceptConversationProposalInput {
  expectedVersion: number;
  /** Human-explicit deadline (task targets only; absent stays NULL). */
  deadline?: string;
  /** Human-explicit window (purpose targets only; absent stays NULL). */
  validFrom?: string;
  validUntil?: string;
}

/**
 * Trusted human adoption: creates the actual purpose/task AND records the
 * accept decision in ONE atomic transaction (no check-then-write gap, no
 * crash window). The adopted purpose keeps the original quote +
 * interpretation with inferred `self` provenance; the adopted task keeps
 * the quote as title, the interpretation as body, hardcoded `self`
 * speaker, and a NULL deadline unless the human supplies an explicit
 * strict instant. Parent drift/revocation/scope mismatch fails WITHOUT
 * creating anything. Never resumes the global stop control.
 */
export function acceptConversationProposal(
  db: Database.Database,
  sessionId: string,
  proposalId: string,
  input: AcceptConversationProposalInput,
  options: AutonomyKeyOptions,
): {
  status: number;
  body: {
    proposal: ReturnType<typeof toProposalView>;
    purpose: ReturnType<typeof toPurposeView> | null;
    task: ReturnType<typeof toTaskView> | null;
  };
  replayed: boolean;
} {
  const session = requireId(sessionId, "sessionId");
  const proposal = requireId(proposalId, "proposalId");
  const key = requireKey(options.key);
  const now = nowMs(options.now);
  const scope = `proposal:${proposal}:accept`;
  const hash = requestHash(
    IDEMPOTENCY_OPERATIONS.acceptConversationProposal.operation,
    IDEMPOTENCY_OPERATIONS.acceptConversationProposal.schemaVersion,
    {
      sessionId: session,
      proposalId: proposal,
      expectedVersion: input.expectedVersion,
      deadline: input.deadline ?? null,
      validFrom: input.validFrom ?? null,
      validUntil: input.validUntil ?? null,
    },
  );
  return withImmediate(db, () => {
    const existing = toStoredResponse(db, scope, key);
    if (existing !== null) {
      if (existing.requestHash !== hash) {
        throw new IdempotencyConflictError(scope);
      }
      const stored = existing.responseBody as {
        proposal: unknown;
        purpose: unknown;
        task: unknown;
      };
      const body = parseOrValidation(
        () =>
          ({
            proposal: ConversationProposalViewSchema.parse(stored.proposal),
            purpose:
              stored.purpose === null
                ? null
                : PurposeViewSchema.parse(stored.purpose),
            task:
              stored.task === null ? null : TaskViewSchema.parse(stored.task),
          }) as unknown as {
            proposal: ReturnType<typeof toProposalView>;
            purpose: ReturnType<typeof toPurposeView> | null;
            task: ReturnType<typeof toTaskView> | null;
          },
        "stored proposal accept body",
      );
      return { status: existing.responseStatus, body, replayed: true };
    }
    const row = assertOwnedProposal(db, session, proposal);
    if (row.status !== "pending") {
      throw new AutonomyStateConflictError(
        `proposal ${row.id} is ${row.status} and cannot be accepted`,
      );
    }
    if (row.version !== input.expectedVersion) {
      throw new AutonomyVersionConflictError(
        input.expectedVersion,
        row.version,
      );
    }
    const target = row.target as ConversationProposalTarget;
    // Human date args are validated BEFORE any write; model dates never
    // exist (staging accepts no date fields at all).
    let deadline: string | undefined;
    let window: { from: string | null; until: string | null } | undefined;
    if (target === "task") {
      if (input.validFrom !== undefined || input.validUntil !== undefined) {
        throw new RepositoryValidationError(
          "validity window is not accepted for task drafts",
        );
      }
      if (input.deadline !== undefined) {
        if (!isStrictAutonomyDeadline(input.deadline)) {
          throw new RepositoryValidationError(
            "deadline must be a strict RFC3339 instant with an explicit offset",
          );
        }
        deadline = input.deadline;
      }
      // Re-check the explicit parent at adopt time (drift/revocation/scope
      // mismatch fails WITHOUT creating anything).
      const parent = readProposalParent(db, session, row);
      if (parent.scope !== row.scope) {
        throw new RepositoryValidationError(
          "parent purpose must share the draft scope",
        );
      }
      if (parent.status !== "active") {
        throw new AutonomyStateConflictError(
          `parent purpose ${parent.id} is ${parent.status}`,
        );
      }
      if (parent.version !== row.expected_parent_version) {
        throw new AutonomyVersionConflictError(
          row.expected_parent_version as number,
          parent.version,
        );
      }
      if (
        !isPurposeApplicableAt(
          { validFrom: parent.valid_from, validUntil: parent.valid_until },
          now,
        )
      ) {
        throw new AutonomyStateConflictError(
          `parent purpose ${parent.id} is not applicable now`,
        );
      }
    } else {
      if (input.deadline !== undefined) {
        throw new RepositoryValidationError(
          "deadline is not accepted for purpose drafts",
        );
      }
      window = requireApplicabilityWindow(input.validFrom, input.validUntil);
    }
    // The inner create joins THIS transaction via SAVEPOINT (nest-safe
    // withImmediate): purpose/task rows, their events, their shadow
    // source, and their idempotency row commit or roll back atomically
    // with the accept decision below. The inner key is the proposal id
    // (deterministic per proposal, never a reused human key).
    const adopted =
      target === "purpose"
        ? createPurpose(
            db,
            session,
            {
              scope: row.scope,
              statement: row.source_quote,
              kind: row.purpose_kind as PurposeKind,
              explicit: false,
              sourceKind: "self",
              sourceTurnId: row.source_turn_id,
              interpretation: row.interpretation,
              ...(window?.from != null ? { validFrom: window.from } : {}),
              ...(window?.until != null ? { validUntil: window.until } : {}),
            },
            { key: row.id, now },
          ).body
        : createTask(
            db,
            session,
            {
              scope: row.scope,
              title: row.source_quote,
              body: row.interpretation,
              kind: row.task_kind as TaskKind,
              speaker: "self",
              ...(deadline !== undefined ? { deadline } : {}),
              parentPurposeId: row.parent_purpose_id as string,
            },
            { key: row.id, now },
          ).body;
    const acceptedTargetId =
      target === "purpose"
        ? (adopted as ReturnType<typeof toPurposeView>).id
        : (adopted as ReturnType<typeof toTaskView>).id;
    const moved = db
      .prepare(
        "UPDATE conversation_proposals SET status = 'accepted', version = ?, updated_at = ?, accepted_target_id = ? WHERE id = ? AND status = 'pending' AND version = ?",
      )
      .run(row.version + 1, now, acceptedTargetId, row.id, row.version);
    if (moved.changes !== 1) {
      throw new AutonomyVersionConflictError(
        input.expectedVersion,
        row.version,
      );
    }
    appendProposalEventInTx(
      db,
      row.id,
      session,
      "accepted",
      "pending",
      "accepted",
      `adopted ${target} ${acceptedTargetId}`,
      now,
    );
    // The stop control is NEVER touched here: a paused control stays
    // paused (manual adoption while paused is allowed, like existing
    // manual purpose/task creation) and never resumes globally.
    const current = readProposal(db, row.id);
    if (current === null) {
      throw new RepositoryNotFoundError(`proposal ${row.id} not found`);
    }
    const body = {
      proposal: toProposalView(current),
      purpose:
        target === "purpose"
          ? (adopted as ReturnType<typeof toPurposeView>)
          : null,
      task:
        target === "task" ? (adopted as ReturnType<typeof toTaskView>) : null,
    };
    storeIdempotentResponse(db, scope, key, hash, 201, body, now);
    return { status: 201, body, replayed: false };
  });
}

/** Adopt-time parent re-read (owned, same session; scope checked by caller). */
function readProposalParent(
  db: Database.Database,
  session: string,
  row: RawProposal,
): RawPurpose {
  if (row.parent_purpose_id === null) {
    throw new RepositoryValidationError(
      "task drafts require an explicit parent purpose",
    );
  }
  return assertOwnedPurpose(db, session, row.parent_purpose_id);
}

/**
 * Trusted human rejection: terminal, CAS-guarded, creates NOTHING (no
 * purpose/task/preference/learning/grant write — only the proposal row +
 * its decision history + the idempotency receipt). Never touches the stop
 * control.
 */
export function rejectConversationProposal(
  db: Database.Database,
  sessionId: string,
  proposalId: string,
  expectedVersion: number,
  options: AutonomyKeyOptions,
): {
  status: number;
  body: ReturnType<typeof toProposalView>;
  replayed: boolean;
} {
  const session = requireId(sessionId, "sessionId");
  const proposal = requireId(proposalId, "proposalId");
  const key = requireKey(options.key);
  const now = nowMs(options.now);
  const scope = `proposal:${proposal}:reject`;
  const hash = requestHash(
    IDEMPOTENCY_OPERATIONS.rejectConversationProposal.operation,
    IDEMPOTENCY_OPERATIONS.rejectConversationProposal.schemaVersion,
    { sessionId: session, proposalId: proposal, expectedVersion },
  );
  return withImmediate(db, () => {
    const existing = toStoredResponse(db, scope, key);
    if (existing !== null) {
      if (existing.requestHash !== hash) {
        throw new IdempotencyConflictError(scope);
      }
      const body = parseOrValidation(
        () => ConversationProposalViewSchema.parse(existing.responseBody),
        "stored proposal reject body",
      );
      return { status: existing.responseStatus, body, replayed: true };
    }
    const row = assertOwnedProposal(db, session, proposal);
    if (row.status !== "pending") {
      throw new AutonomyStateConflictError(
        `proposal ${row.id} is ${row.status} and cannot be rejected`,
      );
    }
    if (row.version !== expectedVersion) {
      throw new AutonomyVersionConflictError(expectedVersion, row.version);
    }
    const moved = db
      .prepare(
        "UPDATE conversation_proposals SET status = 'rejected', version = ?, updated_at = ? WHERE id = ? AND status = 'pending' AND version = ?",
      )
      .run(row.version + 1, now, row.id, row.version);
    if (moved.changes !== 1) {
      throw new AutonomyVersionConflictError(expectedVersion, row.version);
    }
    appendProposalEventInTx(
      db,
      row.id,
      session,
      "rejected",
      "pending",
      "rejected",
      null,
      now,
    );
    const current = readProposal(db, row.id);
    if (current === null) {
      throw new RepositoryNotFoundError(`proposal ${row.id} not found`);
    }
    const body = toProposalView(current);
    storeIdempotentResponse(db, scope, key, hash, 200, body, now);
    return { status: 200, body, replayed: false };
  });
}

/* ------------------------------------------------------------------ */
/* Global stop control + activity                                       */
/* ------------------------------------------------------------------ */

export interface AutonomyControlView {
  paused: boolean;
  version: number;
  reason: string | null;
  updatedAt: number;
}

function readControlRow(db: Database.Database): {
  paused: number;
  version: number;
  reason: string | null;
  updated_at: number;
} {
  const row = db
    .prepare(
      "SELECT paused, version, reason, updated_at FROM autonomy_control WHERE id = 'global'",
    )
    .get() as
    | {
        paused: number;
        version: number;
        reason: string | null;
        updated_at: number;
      }
    | undefined;
  if (row === undefined) {
    // Defensive seed (migration 0011 seeds this row; a missing row is
    // healed to the safe default, never to resumed).
    db.prepare(
      "INSERT INTO autonomy_control (id, paused, version, reason, updated_at) VALUES ('global', 1, 1, 'default_paused', 0) ON CONFLICT(id) DO NOTHING",
    ).run();
    const healed = db
      .prepare(
        "SELECT paused, version, reason, updated_at FROM autonomy_control WHERE id = 'global'",
      )
      .get() as
      | {
          paused: number;
          version: number;
          reason: string | null;
          updated_at: number;
        }
      | undefined;
    if (healed === undefined) {
      throw new RepositoryNotFoundError("autonomy control not found");
    }
    return healed;
  }
  return row;
}

export function getAutonomyControl(db: Database.Database): AutonomyControlView {
  const row = readControlRow(db);
  return parseOrValidation(
    () =>
      AutonomyControlViewSchema.parse({
        paused: row.paused === 1,
        version: row.version,
        reason: row.reason,
        updatedAt: row.updated_at,
      }),
    "stored autonomy control",
  );
}

/**
 * Clean query interface for the later shadow/deliberation service: true
 * only when NEW autonomous background work may start. Normal user chat is
 * never gated by this flag.
 */
export function isAutonomousWorkAllowed(db: Database.Database): boolean {
  return !getAutonomyControl(db).paused;
}

export interface SetControlInput {
  paused: boolean;
  expectedVersion: number;
  reason?: string;
}

export function setAutonomyControl(
  db: Database.Database,
  input: SetControlInput,
  options: AutonomyKeyOptions,
): { status: number; body: AutonomyControlView; replayed: boolean } {
  const key = requireKey(options.key);
  const now = nowMs(options.now);
  const scope = IDEMPOTENCY_SCOPE_AUTONOMY_CONTROL;
  const hash = requestHash(
    IDEMPOTENCY_OPERATIONS.setAutonomyControl.operation,
    IDEMPOTENCY_OPERATIONS.setAutonomyControl.schemaVersion,
    {
      paused: input.paused,
      expectedVersion: input.expectedVersion,
      reason: input.reason ?? null,
    },
  );
  return withImmediate(db, () => {
    const existing = toStoredResponse(db, scope, key);
    if (existing !== null) {
      if (existing.requestHash !== hash) {
        throw new IdempotencyConflictError(scope);
      }
      const stored = parseOrValidation(
        () => AutonomyControlViewSchema.parse(existing.responseBody),
        "stored autonomy control body",
      );
      return { status: existing.responseStatus, body: stored, replayed: true };
    }
    const row = readControlRow(db);
    if (row.version !== input.expectedVersion) {
      throw new AutonomyVersionConflictError(
        input.expectedVersion,
        row.version,
      );
    }
    const moved = db
      .prepare(
        "UPDATE autonomy_control SET paused = ?, version = ?, reason = ?, updated_at = ? WHERE id = 'global' AND version = ?",
      )
      .run(
        input.paused ? 1 : 0,
        row.version + 1,
        input.reason ?? null,
        now,
        row.version,
      );
    if (moved.changes !== 1) {
      throw new AutonomyVersionConflictError(
        input.expectedVersion,
        row.version,
      );
    }
    if ((row.paused === 1) !== input.paused) {
      recordActivityInTx(
        db,
        input.paused ? "autonomy_stopped" : "autonomy_resumed",
        null,
        now,
      );
    }
    // Same-TX shadow transition: pausing holds every live pending job
    // globally (never bulk-replayed); resuming marks paused-time inbox rows
    // skipped (NO catchup — new meaningful state or a new explicit request
    // is required to deliberate).
    shadowBestEffort(() => {
      if (input.paused) {
        holdPendingShadowJobsInTx(db, "control_paused", now);
      } else {
        skipRecordedInboxInTx(db, now);
      }
    });
    const body = getAutonomyControl(db);
    storeIdempotentResponse(db, scope, key, hash, 200, body, now);
    return { status: 200, body, replayed: false };
  });
}

export function listAutonomyActivity(
  db: Database.Database,
  limit = 50,
): {
  items: {
    id: string;
    kind: string;
    sessionId: string | null;
    createdAt: number;
  }[];
} {
  const capped = Math.min(Math.max(limit, 1), 100);
  const rows = db
    .prepare(
      "SELECT id, kind, session_id, created_at FROM autonomy_activity ORDER BY created_at DESC, id ASC LIMIT ?",
    )
    .all(capped) as {
    id: string;
    kind: string;
    session_id: string | null;
    created_at: number;
  }[];
  return {
    items: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      sessionId: row.session_id,
      createdAt: row.created_at,
    })),
  };
}

/**
 * Mark normal user activity. Called ONLY from the accepted (non-replayed)
 * message / retry admission path, inside the same transaction: rejected or
 * idempotently-replayed requests never write activity, and the write can
 * never block the conversation (same-transaction INSERT, no I/O).
 */
export function recordUserActivityInTx(
  db: Database.Database,
  sessionId: string,
  now: number,
): void {
  recordActivityInTx(
    db,
    "user_message",
    requireId(sessionId, "sessionId"),
    now,
  );
}

/**
 * Bootstrap restart fence. Runs on every server start AFTER migration:
 * - ensures the singleton control row exists (defensive; seeded paused),
 * - when the control was left UNPAUSED (explicit resume followed by a
 *   restart/crash), flips it back to PAUSED with a version advance and a
 *   `restart_fence_paused` reason IN THE SAME transaction,
 * - appends `restart_fence` + `interrupted_note` activity rows recording
 *   that background intent does NOT resume implicitly (no replay burst),
 * - an already-paused control stays paused with NO version change and no
 *   fake worker claims; creates no purposes/tasks, dispatches nothing.
 * Replaying an OLD resume idempotency key afterwards returns its stored
 * response but never flips current DB state (same idempotency semantics as
 * every other command): a fresh resume needs a fresh key + current version.
 */
export function applyAutonomyRestartFence(
  db: Database.Database,
  now?: number,
): { paused: boolean; version: number } {
  const at = nowMs(now);
  return withImmediate(db, () => {
    const row = readControlRow(db);
    if (row.paused === 0) {
      const moved = db
        .prepare(
          "UPDATE autonomy_control SET paused = 1, version = ?, reason = 'restart_fence_paused', updated_at = ? WHERE id = 'global' AND version = ?",
        )
        .run(row.version + 1, at, row.version);
      if (moved.changes !== 1) {
        throw new AutonomyVersionConflictError(row.version, row.version);
      }
    }
    // Same-TX shadow reconcile: leases die with the restart — hold every
    // pending/claimed job (old outputs must re-fence, never continue).
    shadowBestEffort(() => {
      reconcileShadowRestartInTx(db, at);
    });
    recordActivityInTx(db, "restart_fence", null, at);
    recordActivityInTx(db, "interrupted_note", null, at);
    const current = readControlRow(db);
    return { paused: current.paused === 1, version: current.version };
  });
}

/**
 * Reusable interface for the later shadow deliberation / notification /
 * handoff continuation: read-only queries plus the stop-control command.
 * Purpose applicability is read at a frozen `now` (no clock inside);
 * conflicts are explicit owner-recorded pairs only. No timers,
 * no auto-execution, no background work live here.
 */
export interface AutonomyQueryPort {
  getControl(): AutonomyControlView;
  isWorkAllowed(): boolean;
  listActivity(limit?: number): ReturnType<typeof listAutonomyActivity>;
  getPurpose(
    sessionId: string,
    purposeId: string,
  ): ReturnType<typeof toPurposeView>;
  isPurposeApplicable(
    sessionId: string,
    purposeId: string,
    now: number,
  ): boolean;
  listConflicts(sessionId: string): ReturnType<typeof listPurposeConflicts>;
}

export function createAutonomyQueryPort(
  db: Database.Database,
): AutonomyQueryPort {
  return {
    getControl: () => getAutonomyControl(db),
    isWorkAllowed: () => isAutonomousWorkAllowed(db),
    listActivity: (limit?: number) => listAutonomyActivity(db, limit ?? 50),
    getPurpose: (sessionId: string, purposeId: string) =>
      toPurposeView(assertOwnedPurpose(db, sessionId, purposeId)),
    isPurposeApplicable: (
      sessionId: string,
      purposeId: string,
      now: number,
    ): boolean => {
      const row = assertOwnedPurpose(db, sessionId, purposeId);
      return (
        row.status === "active" &&
        isPurposeApplicableAt(
          { validFrom: row.valid_from, validUntil: row.valid_until },
          now,
        )
      );
    },
    listConflicts: (sessionId: string) => listPurposeConflicts(db, sessionId),
  };
}
