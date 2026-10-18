// AV03 delegation handoff slice: human-driven pi-orch handoff records.
//
// Ownership: this module is the ONLY writer of the handoff tables
// (`delegation_handoffs`, `handoff_attempts`, `handoff_events`) plus the
// shared `api_idempotency` rows under the handoff scopes. It uses the
// caller-provided single better-sqlite3 connection, BEGIN IMMEDIATE
// transactions, version-CAS mutations, canonical JSON + SHA-256
// domain-separated idempotency hashing, and Zod validation on every JSON
// boundary — the same conventions as the autonomy/learning slices.
//
// Hard boundaries enforced here (no exceptions):
// - This module NEVER spawns workers/processes, NEVER performs execution,
//   NEVER writes purposes, tasks, conflicts, grants, receipts, controls,
//   budgets (numeric), permissions, notifications, calendar state, OAuth,
//   or config. Budget entries are human-entered TEXT labels only: no
//   numeric budget column exists, so nothing can be enforced numerically
//   or increased by us. Boundary flags are recorded claims that REQUIRE
//   SEPARATE AUTHORIZATION: storing them grants nothing and changes
//   nothing (verified by the consumer tests: boundary-flagged handoffs
//   change no purposes/control/grants/task state).
// - Frozen fields (target, acceptance criteria, op scope, budget labels,
//   boundary flags) are immutable once created: changing them requires a
//   NEW handoff that supersedes the old one (the old row keeps its frozen
//   content; `superseded_by` links forward). Criteria are never weakened
//   to pass: `verified` requires a per-criterion pass + evidence result
//   for EVERY frozen criterion, all passing.
// - A worker `reported` sandbox success NEVER implies production: the
//   environment is an UNTRUSTED claim stored verbatim, no production
//   column exists, and verification never flips it.
// - A verified handoff NEVER completes its task: no task write exists in
//   this module (the human may complete the task separately).
// - Retries are explicitly human-recorded attempt rows with a REQUIRED
//   closed cause: no automatic retry, no timer/spin, no invented numeric
//   cap (attempts are bounded only by explicit human action).
// - Parent-purpose revocation/supersede flags in-scope active handoffs
//   with the durable `needs_reevaluation` NOTICE in the SAME transaction
//   (never auto-cancel, never auto-resume). New dispatch is refused while
//   the notice is set; cancel is always allowed. Clearing happens only
//   via an explicit human reaffirm (CAS-checked, audited).

import {
  type HandoffBoundary,
  type HandoffEnvironment,
  type HandoffOpScope,
  type HandoffRetryCause,
  type HandoffStatus,
  type HandoffView,
  HandoffViewSchema,
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

/** CAS version mismatch on a handoff mutation (409). */
export class HandoffVersionConflictError extends KernelStorageError {
  readonly expectedVersion: number;
  readonly currentVersion: number;

  constructor(expectedVersion: number, currentVersion: number) {
    super(
      "handoff_version_conflict",
      `handoff version conflict: expected ${expectedVersion}, current ${currentVersion}`,
    );
    this.expectedVersion = expectedVersion;
    this.currentVersion = currentVersion;
  }
}

/** Illegal lifecycle transition or invalid verification input (409). */
export class HandoffStateConflictError extends KernelStorageError {
  constructor(message: string) {
    super("handoff_state_conflict", message);
  }
}

/* ------------------------------------------------------------------ */
/* Local strict helpers (same conventions as the learning slice).       */
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
    db.exec("SAVEPOINT av_handoff_nested_tx");
    try {
      const out = fn();
      db.exec("RELEASE av_handoff_nested_tx");
      return out;
    } catch (error) {
      try {
        db.exec("ROLLBACK TO av_handoff_nested_tx");
      } catch {
        // Best effort: the original error carries the failure.
      }
      try {
        db.exec("RELEASE av_handoff_nested_tx");
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

/* ------------------------------------------------------------------ */
/* Row shapes                                                          */
/* ------------------------------------------------------------------ */

interface RawHandoff {
  id: string;
  session_id: string;
  task_id: string;
  task_version: number;
  parent_purpose_id: string | null;
  parent_purpose_version: number | null;
  target: string;
  acceptance_criteria: string;
  op_scope: string;
  budget_label: string | null;
  boundaries: string;
  status: string;
  version: number;
  needs_reevaluation: number;
  active_attempt: number;
  external_ref: string | null;
  report_environment: string | null;
  report_summary: string | null;
  verification_results: string | null;
  supersedes_handoff_id: string | null;
  superseded_by: string | null;
  created_at: number;
  updated_at: number;
}

function parseJsonArray(raw: string, what: string): unknown[] {
  return parseOrValidation(() => {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error(`${what} is not an array`);
    }
    return parsed;
  }, what);
}

function toHandoffView(row: RawHandoff): HandoffView {
  return parseOrValidation(
    () =>
      HandoffViewSchema.parse({
        id: row.id,
        sessionId: row.session_id,
        taskId: row.task_id,
        taskVersion: row.task_version,
        parentPurposeId: row.parent_purpose_id,
        parentPurposeVersion: row.parent_purpose_version,
        target: row.target,
        acceptanceCriteria: parseJsonArray(row.acceptance_criteria, "criteria"),
        opScope: row.op_scope,
        budgetLabel: row.budget_label,
        boundaries: parseJsonArray(row.boundaries, "boundaries"),
        status: row.status,
        version: row.version,
        needsReevaluation: row.needs_reevaluation === 1,
        activeAttempt: row.active_attempt,
        externalRef: row.external_ref,
        reportEnvironment: row.report_environment,
        reportSummary: row.report_summary,
        verificationResults:
          row.verification_results === null
            ? null
            : parseJsonArray(row.verification_results, "verification"),
        supersedesHandoffId: row.supersedes_handoff_id,
        supersededBy: row.superseded_by,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }),
    "stored handoff",
  );
}

function readHandoff(
  db: Database.Database,
  handoffId: string,
): RawHandoff | null {
  return (
    (db
      .prepare("SELECT * FROM delegation_handoffs WHERE id = ?")
      .get(handoffId) as RawHandoff | undefined) ?? null
  );
}

/**
 * Ownership-first handoff lookup (foreign ids are 404, never 403).
 */
export function assertOwnedHandoff(
  db: Database.Database,
  sessionId: string,
  handoffId: string,
): RawHandoff {
  const session = requireId(sessionId, "sessionId");
  const handoff = requireId(handoffId, "handoffId");
  const row = readHandoff(db, handoff);
  if (row === null || row.session_id !== session) {
    throw new RepositoryNotFoundError(
      `handoff ${handoff} not found in session ${session}`,
    );
  }
  return row;
}

function appendHandoffEventInTx(
  db: Database.Database,
  handoffId: string,
  sessionId: string,
  event:
    | "prepared"
    | "dispatched"
    | "reported"
    | "verified"
    | "failed"
    | "cancelled"
    | "abnormal_exit"
    | "attempt_recorded"
    | "superseded"
    | "reaffirmed"
    | "reevaluation_flagged"
    | "reevaluation_cleared",
  fromStatus: string | null,
  toStatus: string,
  note: string | null,
  now: number,
): void {
  const seqRow = db
    .prepare(
      "SELECT COALESCE(MAX(seq), 0) AS max_seq FROM handoff_events WHERE handoff_id = ?",
    )
    .get(handoffId) as { max_seq: number };
  db.prepare(
    "INSERT INTO handoff_events (id, handoff_id, session_id, seq, event, from_status, to_status, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    generateId(),
    handoffId,
    sessionId,
    seqRow.max_seq + 1,
    event,
    fromStatus,
    toStatus,
    note,
    now,
  );
}

/**
 * Opaque paging cursor over the DURABLE APPEND ORDER of the append-only
 * delegation_handoffs table (STRICT rowid table; handoff rows are never
 * deleted, so SQLite rowids increase monotonically with INSERT order). A
 * (created_at, id) keyset would order equal-millisecond rows by RANDOM
 * UUID v4, which is nondeterministic against insertion order — the same
 * defect that flaked the learning evidence paging test (PR48 CI run
 * 39056812937). Rowid keyset convention is already used by the
 * notification bridge keysets (shadow_job_events / action_receipts /
 * autonomy_task_events).
 */
function encodeHandoffCursor(rowid: number): string {
  return Buffer.from(JSON.stringify({ rowid }), "utf8").toString("base64url");
}

function decodeHandoffCursor(cursor: string): { rowid: number } {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Number.isInteger((parsed as { rowid?: unknown }).rowid) ||
      (parsed as { rowid: number }).rowid < 0
    ) {
      throw new Error("bad cursor shape");
    }
    return { rowid: (parsed as { rowid: number }).rowid };
  } catch (error) {
    if (error instanceof KernelStorageError) {
      throw error;
    }
    throw new RepositoryValidationError("invalid handoff cursor");
  }
}

export interface AutonomyKeyOptions {
  key: string;
  now?: number;
}

export interface CreateHandoffInput {
  taskId: string;
  target: string;
  acceptanceCriteria: string[];
  opScope: HandoffOpScope;
  budgetLabel?: string;
  boundaries: HandoffBoundary[];
  supersedesHandoffId?: string;
}

/**
 * Trusted human creation: bound to an EXISTING session-owned task (frozen
 * task version + parent purpose snapshot). All frozen fields are stored
 * verbatim: the model can never reach this path. A superseding creation
 * links the old frozen record forward WITHOUT rewriting its frozen
 * content (the old criteria stay preserved on the old row): the old row
 * gets `superseded_by` AND a version bump inside the SAME transaction
 * (CAS-guarded, exactly-one-row asserted), and superseding an
 * ALREADY-superseded handoff refuses (409, no forward-link fork).
 * Creation against a completed/cancelled task refuses (409): frozen
 * records for terminal work are meaningless.
 */
export function createHandoff(
  db: Database.Database,
  sessionId: string,
  input: CreateHandoffInput,
  options: AutonomyKeyOptions,
): { status: number; body: HandoffView; replayed: boolean } {
  const session = requireId(sessionId, "sessionId");
  const key = requireKey(options.key);
  const now = nowMs(options.now);
  const scope = `session:${session}:handoff`;
  const hash = requestHash(
    IDEMPOTENCY_OPERATIONS.createHandoff.operation,
    IDEMPOTENCY_OPERATIONS.createHandoff.schemaVersion,
    {
      sessionId: session,
      taskId: input.taskId,
      target: input.target,
      acceptanceCriteria: input.acceptanceCriteria,
      opScope: input.opScope,
      budgetLabel: input.budgetLabel ?? null,
      boundaries: input.boundaries,
      supersedesHandoffId: input.supersedesHandoffId ?? null,
    },
  );
  return withImmediate(db, () => {
    const existing = toStoredResponse(db, scope, key);
    if (existing !== null) {
      if (existing.requestHash !== hash) {
        throw new IdempotencyConflictError(scope);
      }
      const body = parseOrValidation(
        () => HandoffViewSchema.parse(existing.responseBody),
        "stored handoff body",
      );
      return { status: existing.responseStatus, body, replayed: true };
    }
    requireSession(db, session);
    const taskId = requireId(input.taskId, "taskId");
    const task = db
      .prepare(
        "SELECT id, version, status, parent_purpose_id FROM autonomy_tasks WHERE session_id = ? AND id = ?",
      )
      .get(session, taskId) as
      | {
          id: string;
          version: number;
          status: string;
          parent_purpose_id: string | null;
        }
      | undefined;
    if (task === undefined) {
      throw new RepositoryNotFoundError(
        `task ${taskId} not found in session ${session}`,
      );
    }
    // A terminal task (completed/cancelled) accepts no new handoff: the
    // human can never dispatch frozen work against finished records.
    if (task.status === "completed" || task.status === "cancelled") {
      throw new HandoffStateConflictError(
        `task ${taskId} is ${task.status}: handoff refused`,
      );
    }
    let parentVersion: number | null = null;
    let parentInactive = false;
    if (task.parent_purpose_id !== null) {
      const parent = db
        .prepare(
          "SELECT version, status FROM autonomy_purposes WHERE session_id = ? AND id = ?",
        )
        .get(session, task.parent_purpose_id) as
        | { version: number; status: string }
        | undefined;
      if (parent === undefined) {
        throw new HandoffStateConflictError(
          "task parent purpose is missing: handoff refused",
        );
      }
      parentVersion = parent.version;
      parentInactive = parent.status !== "active";
    }
    let supersedes: RawHandoff | null = null;
    if (input.supersedesHandoffId !== undefined) {
      supersedes = assertOwnedHandoff(db, session, input.supersedesHandoffId);
      if (supersedes.task_id !== taskId) {
        throw new HandoffStateConflictError(
          "superseding handoff must bind the same task",
        );
      }
      // No fork: a handoff already linked forward can never be superseded
      // a second time (the frozen chain stays linear, one successor max).
      if (supersedes.superseded_by !== null) {
        throw new HandoffStateConflictError(
          "superseding handoff refused: the target is already superseded",
        );
      }
    }
    const id = generateId();
    db.prepare(
      "INSERT INTO delegation_handoffs (id, session_id, task_id, task_version, parent_purpose_id, parent_purpose_version, target, acceptance_criteria, op_scope, budget_label, boundaries, status, version, needs_reevaluation, active_attempt, external_ref, report_environment, report_summary, verification_results, supersedes_handoff_id, superseded_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', 1, ?, 0, NULL, NULL, NULL, NULL, ?, NULL, ?, ?)",
    ).run(
      id,
      session,
      taskId,
      task.version,
      task.parent_purpose_id,
      parentVersion,
      input.target,
      JSON.stringify(input.acceptanceCriteria),
      input.opScope,
      input.budgetLabel ?? null,
      JSON.stringify(input.boundaries),
      parentInactive ? 1 : 0,
      input.supersedesHandoffId ?? null,
      now,
      now,
    );
    appendHandoffEventInTx(
      db,
      id,
      session,
      "prepared",
      null,
      "prepared",
      input.supersedesHandoffId ?? null,
      now,
    );
    if (parentInactive) {
      appendHandoffEventInTx(
        db,
        id,
        session,
        "reevaluation_flagged",
        "prepared",
        "prepared",
        "parent purpose non-active at creation: reaffirm before dispatch",
        now,
      );
    }
    if (supersedes !== null) {
      // Same-TX forward link + version bump: every holder of the old row's
      // version alerts via CAS on the next mutation, and lifecycle
      // writers refusing `superseded_by !== null` made this airtight.
      const moved = db
        .prepare(
          "UPDATE delegation_handoffs SET superseded_by = ?, version = version + 1, updated_at = ? WHERE id = ? AND superseded_by IS NULL",
        )
        .run(id, now, supersedes.id);
      if (moved.changes !== 1) {
        throw new HandoffStateConflictError(
          "supersede refused: the old handoff became superseded inside the same transaction",
        );
      }
      appendHandoffEventInTx(
        db,
        supersedes.id,
        session,
        "superseded",
        supersedes.status,
        supersedes.status,
        JSON.stringify({
          by: id,
          frozenCriteria: parseJsonArray(
            supersedes.acceptance_criteria,
            "criteria",
          ),
        }),
        now,
      );
    }
    const row = readHandoff(db, id);
    if (row === null) {
      throw new RepositoryNotFoundError(`handoff ${id} not found`);
    }
    const body = toHandoffView(row);
    storeIdempotentResponse(db, scope, key, hash, 201, body, now);
    return { status: 201, body, replayed: false };
  });
}

/**
 * Owned handoff read (foreign ids are 404, never 403).
 */
export function getHandoff(
  db: Database.Database,
  sessionId: string,
  handoffId: string,
): HandoffView {
  return toHandoffView(assertOwnedHandoff(db, sessionId, handoffId));
}

export interface ListHandoffsQuery {
  limit?: number;
  cursor?: string;
  status?: HandoffStatus;
}

/**
 * Newest-first keyset handoff list plus the ACTIVE (dispatched/reported)
 * concurrency TRACKING count. The count is informational only: no numeric
 * limit is invented or enforced anywhere.
 */
export function listHandoffs(
  db: Database.Database,
  sessionId: string,
  query: ListHandoffsQuery = {},
): { items: HandoffView[]; nextCursor: string | null; hasMore: boolean } {
  const session = requireId(sessionId, "sessionId");
  requireSession(db, session);
  const capped = Math.min(Math.max(query.limit ?? 50, 1), 100);
  if (
    query.status !== undefined &&
    query.status !== "prepared" &&
    query.status !== "dispatched" &&
    query.status !== "reported" &&
    query.status !== "verified" &&
    query.status !== "failed" &&
    query.status !== "cancelled"
  ) {
    throw new RepositoryValidationError(
      "handoff status must be prepared, dispatched, reported, verified, failed, or cancelled",
    );
  }
  const bound =
    query.cursor === undefined ? null : decodeHandoffCursor(query.cursor);
  const clauses = ["session_id = ?"];
  const args: (string | number)[] = [session];
  if (query.status !== undefined) {
    clauses.push("status = ?");
    args.push(query.status);
  }
  if (bound !== null) {
    // Newest-first over the DURABLE APPEND ORDER: strictly before the
    // bound rowid (higher rowids were appended later and already appear
    // on earlier pages).
    clauses.push("rowid < ?");
    args.push(bound.rowid);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const rows = db
    .prepare(
      `SELECT rowid AS rid, * FROM delegation_handoffs ${where} ORDER BY rowid DESC LIMIT ?`,
    )
    .all(...args, capped + 1) as (RawHandoff & { rid: number })[];
  const hasMore = rows.length > capped;
  const page = hasMore ? rows.slice(0, capped) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map((row) => toHandoffView(row)),
    nextCursor:
      hasMore && last !== undefined ? encodeHandoffCursor(last.rid) : null,
    hasMore,
  };
}

/**
 * Session-owned ACTIVE (dispatched/reported) handoff count for the
 * concurrency panel. Tracking only: never a limit, never enforced.
 */
export function countActiveHandoffs(
  db: Database.Database,
  sessionId: string,
): number {
  const session = requireId(sessionId, "sessionId");
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM delegation_handoffs WHERE session_id = ? AND status IN ('dispatched','reported')",
    )
    .get(session) as { n: number };
  return row.n;
}

export function listHandoffEvents(
  db: Database.Database,
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
  const owned = assertOwnedHandoff(db, sessionId, handoffId);
  const rows = db
    .prepare(
      "SELECT seq, event, from_status, to_status, note, created_at FROM handoff_events WHERE handoff_id = ? ORDER BY seq DESC LIMIT 500",
    )
    .all(owned.id) as {
    seq: number;
    event: string;
    from_status: string | null;
    to_status: string;
    note: string | null;
    created_at: number;
  }[];
  // Newest-500 window, returned oldest-first (stable audit order).
  rows.reverse();
  return {
    handoffId: owned.id,
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

export function listHandoffAttempts(
  db: Database.Database,
  sessionId: string,
  handoffId: string,
): {
  handoffId: string;
  attempts: { attemptNo: number; cause: string; createdAt: number }[];
} {
  const owned = assertOwnedHandoff(db, sessionId, handoffId);
  const rows = db
    .prepare(
      "SELECT attempt_no, cause, created_at FROM handoff_attempts WHERE handoff_id = ? ORDER BY attempt_no DESC LIMIT 500",
    )
    .all(owned.id) as {
    attempt_no: number;
    cause: string;
    created_at: number;
  }[];
  // Newest-500 window, returned oldest-first (stable audit order).
  rows.reverse();
  return {
    handoffId: owned.id,
    attempts: rows.map((row) => ({
      attemptNo: row.attempt_no,
      cause: row.cause,
      createdAt: row.created_at,
    })),
  };
}

/* ------------------------------------------------------------------ */
/* Human lifecycle transitions (CAS, audited, no auto-completion)       */
/* ------------------------------------------------------------------ */

function casHandoff(row: RawHandoff, expectedVersion: number): void {
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw new RepositoryValidationError("expectedVersion must be >= 1");
  }
  if (row.version !== expectedVersion) {
    throw new HandoffVersionConflictError(expectedVersion, row.version);
  }
}

interface TransitionOptions extends AutonomyKeyOptions {
  operation: keyof Pick<
    typeof IDEMPOTENCY_OPERATIONS,
    | "dispatchHandoff"
    | "reportHandoff"
    | "verifyHandoff"
    | "failHandoff"
    | "cancelHandoff"
    | "abnormalExitHandoff"
    | "recordHandoffAttempt"
    | "reaffirmHandoff"
  >;
}

function mutateHandoff(
  db: Database.Database,
  sessionId: string,
  handoffId: string,
  expectedVersion: number,
  options: TransitionOptions,
  hashInput: Record<string, unknown>,
  apply: (
    row: RawHandoff,
    now: number,
  ) => { body: HandoffView; status: number },
): { status: number; body: HandoffView; replayed: boolean } {
  const session = requireId(sessionId, "sessionId");
  const key = requireKey(options.key);
  const now = nowMs(options.now);
  const op = IDEMPOTENCY_OPERATIONS[options.operation];
  const scope = `handoff:${requireId(handoffId, "handoffId")}:${options.operation}`;
  const hash = requestHash(op.operation, op.schemaVersion, {
    sessionId: session,
    handoffId,
    ...hashInput,
  });
  return withImmediate(db, () => {
    const existing = toStoredResponse(db, scope, key);
    if (existing !== null) {
      if (existing.requestHash !== hash) {
        throw new IdempotencyConflictError(scope);
      }
      const body = parseOrValidation(
        () => HandoffViewSchema.parse(existing.responseBody),
        "stored handoff body",
      );
      return { status: existing.responseStatus, body, replayed: true };
    }
    const row = assertOwnedHandoff(db, session, handoffId);
    casHandoff(row, expectedVersion);
    const out = apply(row, now);
    storeIdempotentResponse(db, scope, key, hash, out.status, out.body, now);
    return { ...out, replayed: false };
  });
}

function setHandoffStatusInTx(
  db: Database.Database,
  row: RawHandoff,
  to: HandoffStatus,
  event:
    | "dispatched"
    | "reported"
    | "verified"
    | "failed"
    | "cancelled"
    | "abnormal_exit"
    | "attempt_recorded"
    | "reaffirmed"
    | "reevaluation_cleared",
  note: string | null,
  now: number,
  extra?: { externalRef?: string; environment?: string; summary?: string },
): void {
  const moved = db
    .prepare(
      "UPDATE delegation_handoffs SET status = ?, version = version + 1, updated_at = ?, external_ref = COALESCE(?, external_ref), report_environment = COALESCE(?, report_environment), report_summary = COALESCE(?, report_summary) WHERE id = ? AND version = ?",
    )
    .run(
      to,
      now,
      extra?.externalRef ?? null,
      extra?.environment ?? null,
      extra?.summary ?? null,
      row.id,
      row.version,
    );
  if (moved.changes !== 1) {
    const current = readHandoff(db, row.id);
    throw new HandoffVersionConflictError(
      row.version,
      current?.version ?? row.version,
    );
  }
  appendHandoffEventInTx(
    db,
    row.id,
    row.session_id,
    event,
    row.status,
    to,
    note,
    now,
  );
}

/**
 * Human marks dispatched (optional external ref text, recorded never
 * resolved). Refused while a reevaluation notice is pending (cancel stays
 * available instead), for an already-superseded handoff (the successor
 * record owns the work now), and against a completed/cancelled task
 * (terminal work accepts no dispatch).
 */
export function dispatchHandoff(
  db: Database.Database,
  sessionId: string,
  handoffId: string,
  expectedVersion: number,
  externalRef: string | undefined,
  options: AutonomyKeyOptions,
): { status: number; body: HandoffView; replayed: boolean } {
  return mutateHandoff(
    db,
    sessionId,
    handoffId,
    expectedVersion,
    { ...options, operation: "dispatchHandoff" },
    { expectedVersion, externalRef: externalRef ?? null },
    (row, now) => {
      if (row.superseded_by !== null) {
        throw new HandoffStateConflictError(
          `handoff was superseded by ${row.superseded_by}: dispatch refused`,
        );
      }
      if (row.needs_reevaluation === 1) {
        throw new HandoffStateConflictError(
          "handoff needs reevaluation: reaffirm before dispatch",
        );
      }
      if (row.status !== "prepared") {
        throw new HandoffStateConflictError(
          `dispatch requires prepared status (current ${row.status})`,
        );
      }
      // The task's CURRENT status rules at dispatch time: a task that was
      // completed/cancelled after the handoff froze refuses the dispatch
      // (no frozen snapshot can re-open terminal work). The CURRENT
      // version/parent binding rules too: a task that was explicitly
      // resumed under a different parent (or otherwise advanced) leaves
      // the frozen snapshot stale, so dispatch refuses until the human
      // reaffirms the new binding (the reparent hook flags it; this is
      // defense-in-depth for a missed hook).
      const task = db
        .prepare(
          "SELECT status, version, parent_purpose_id FROM autonomy_tasks WHERE session_id = ? AND id = ?",
        )
        .get(row.session_id, row.task_id) as
        | { status: string; version: number; parent_purpose_id: string | null }
        | undefined;
      if (
        task === undefined ||
        task.status === "completed" ||
        task.status === "cancelled"
      ) {
        throw new HandoffStateConflictError(
          "task is completed or cancelled: dispatch refused",
        );
      }
      if (
        task.version !== row.task_version ||
        (task.parent_purpose_id ?? null) !== (row.parent_purpose_id ?? null)
      ) {
        throw new HandoffStateConflictError(
          "handoff task binding is stale (task resumed or reparented): reaffirm before dispatch",
        );
      }
      setHandoffStatusInTx(
        db,
        row,
        "dispatched",
        "dispatched",
        externalRef ?? null,
        now,
        {
          ...(externalRef !== undefined ? { externalRef } : {}),
        },
      );
      const next = readHandoff(db, row.id);
      if (next === null) {
        throw new RepositoryNotFoundError(`handoff ${row.id} not found`);
      }
      return { body: toHandoffView(next), status: 200 };
    },
  );
}

/**
 * Human records the UNTRUSTED worker report (sandbox NEVER production).
 * The environment claim is stored verbatim; nothing here proves or sets
 * a production deployment.
 */
export function reportHandoff(
  db: Database.Database,
  sessionId: string,
  handoffId: string,
  expectedVersion: number,
  environment: HandoffEnvironment,
  summary: string,
  options: AutonomyKeyOptions,
): { status: number; body: HandoffView; replayed: boolean } {
  return mutateHandoff(
    db,
    sessionId,
    handoffId,
    expectedVersion,
    { ...options, operation: "reportHandoff" },
    { expectedVersion, environment, summary },
    (row, now) => {
      if (row.superseded_by !== null) {
        throw new HandoffStateConflictError(
          `handoff was superseded by ${row.superseded_by}: report refused`,
        );
      }
      if (row.status !== "dispatched") {
        throw new HandoffStateConflictError(
          `report requires dispatched status (current ${row.status})`,
        );
      }
      const moved = db
        .prepare(
          "UPDATE delegation_handoffs SET status = 'reported', version = version + 1, updated_at = ?, report_environment = ?, report_summary = ? WHERE id = ? AND version = ?",
        )
        .run(now, environment, summary, row.id, row.version);
      if (moved.changes !== 1) {
        const current = readHandoff(db, row.id);
        throw new HandoffVersionConflictError(
          row.version,
          current?.version ?? row.version,
        );
      }
      appendHandoffEventInTx(
        db,
        row.id,
        row.session_id,
        "reported",
        row.status,
        "reported",
        `environment=${environment} (unverified claim; sandbox success never means production)`,
        now,
      );
      const next = readHandoff(db, row.id);
      if (next === null) {
        throw new RepositoryNotFoundError(`handoff ${row.id} not found`);
      }
      return { body: toHandoffView(next), status: 200 };
    },
  );
}

export interface VerifyHandoffResult {
  index: number;
  pass: boolean;
  evidence: string;
}

/**
 * Human verification: per-criterion pass + evidence for EVERY frozen
 * criterion, all passing. Any fail, any missing index, any duplicate
 * index, or any out-of-range index refuses. Frozen criteria are never
 * weakened to pass: changing them needs a NEW superseding handoff.
 * Verification NEVER completes the task and NEVER sets production.
 */
export function verifyHandoff(
  db: Database.Database,
  sessionId: string,
  handoffId: string,
  expectedVersion: number,
  results: VerifyHandoffResult[],
  options: AutonomyKeyOptions,
): { status: number; body: HandoffView; replayed: boolean } {
  return mutateHandoff(
    db,
    sessionId,
    handoffId,
    expectedVersion,
    { ...options, operation: "verifyHandoff" },
    { expectedVersion, results },
    (row, now) => {
      if (row.superseded_by !== null) {
        throw new HandoffStateConflictError(
          `handoff was superseded by ${row.superseded_by}: verify refused`,
        );
      }
      if (row.status !== "reported") {
        throw new HandoffStateConflictError(
          `verify requires reported status (current ${row.status})`,
        );
      }
      const criteria = parseJsonArray(row.acceptance_criteria, "criteria");
      if (results.length !== criteria.length) {
        throw new HandoffStateConflictError(
          `verify requires a result for every frozen criterion (${criteria.length} criteria, ${results.length} results)`,
        );
      }
      const seen = new Set<number>();
      for (const result of results) {
        if (
          !Number.isInteger(result.index) ||
          result.index < 0 ||
          result.index >= criteria.length
        ) {
          throw new HandoffStateConflictError(
            `verify result index ${result.index} is out of range`,
          );
        }
        if (seen.has(result.index)) {
          throw new HandoffStateConflictError(
            `verify result index ${result.index} is duplicated`,
          );
        }
        seen.add(result.index);
        if (result.pass !== true) {
          throw new HandoffStateConflictError(
            `criterion ${result.index} did not pass: handoff cannot be verified`,
          );
        }
        if (
          typeof result.evidence !== "string" ||
          result.evidence.length === 0
        ) {
          throw new HandoffStateConflictError(
            `criterion ${result.index} needs evidence text`,
          );
        }
      }
      const moved = db
        .prepare(
          "UPDATE delegation_handoffs SET status = 'verified', version = version + 1, updated_at = ?, verification_results = ? WHERE id = ? AND version = ?",
        )
        .run(now, JSON.stringify(results), row.id, row.version);
      if (moved.changes !== 1) {
        const current = readHandoff(db, row.id);
        throw new HandoffVersionConflictError(
          row.version,
          current?.version ?? row.version,
        );
      }
      appendHandoffEventInTx(
        db,
        row.id,
        row.session_id,
        "verified",
        row.status,
        "verified",
        `all ${criteria.length} frozen criteria passed; task NOT auto-completed; production NOT set`,
        now,
      );
      const next = readHandoff(db, row.id);
      if (next === null) {
        throw new RepositoryNotFoundError(`handoff ${row.id} not found`);
      }
      return { body: toHandoffView(next), status: 200 };
    },
  );
}

/**
 * Human marks failed (prepared/dispatched/reported only; terminal stays).
 * Refused for an already-superseded handoff (the successor record owns
 * the work now): cancel is the documented escape hatch.
 */
export function failHandoff(
  db: Database.Database,
  sessionId: string,
  handoffId: string,
  expectedVersion: number,
  options: AutonomyKeyOptions,
): { status: number; body: HandoffView; replayed: boolean } {
  return mutateHandoff(
    db,
    sessionId,
    handoffId,
    expectedVersion,
    { ...options, operation: "failHandoff" },
    { expectedVersion },
    (row, now) => {
      if (row.superseded_by !== null) {
        throw new HandoffStateConflictError(
          `handoff was superseded by ${row.superseded_by}: fail refused`,
        );
      }
      if (
        row.status !== "prepared" &&
        row.status !== "dispatched" &&
        row.status !== "reported"
      ) {
        throw new HandoffStateConflictError(
          `fail requires a non-terminal status (current ${row.status})`,
        );
      }
      setHandoffStatusInTx(db, row, "failed", "failed", null, now);
      const next = readHandoff(db, row.id);
      if (next === null) {
        throw new RepositoryNotFoundError(`handoff ${row.id} not found`);
      }
      return { body: toHandoffView(next), status: 200 };
    },
  );
}

/**
 * Human cancels (prepared/dispatched/reported only). Cancel is ALWAYS
 * allowed, including while a reevaluation notice is pending.
 */
export function cancelHandoff(
  db: Database.Database,
  sessionId: string,
  handoffId: string,
  expectedVersion: number,
  options: AutonomyKeyOptions,
): { status: number; body: HandoffView; replayed: boolean } {
  return mutateHandoff(
    db,
    sessionId,
    handoffId,
    expectedVersion,
    { ...options, operation: "cancelHandoff" },
    { expectedVersion },
    (row, now) => {
      if (
        row.status !== "prepared" &&
        row.status !== "dispatched" &&
        row.status !== "reported"
      ) {
        throw new HandoffStateConflictError(
          `cancel requires a non-terminal status (current ${row.status})`,
        );
      }
      setHandoffStatusInTx(db, row, "cancelled", "cancelled", null, now);
      const next = readHandoff(db, row.id);
      if (next === null) {
        throw new RepositoryNotFoundError(`handoff ${row.id} not found`);
      }
      return { body: toHandoffView(next), status: 200 };
    },
  );
}

/**
 * Human records an abnormal worker exit (event only, no status change):
 * the handoff stays in its current lifecycle state with an audited note.
 * Refused for an already-superseded handoff (the successor owns the work).
 */
export function abnormalExitHandoff(
  db: Database.Database,
  sessionId: string,
  handoffId: string,
  expectedVersion: number,
  options: AutonomyKeyOptions,
): { status: number; body: HandoffView; replayed: boolean } {
  return mutateHandoff(
    db,
    sessionId,
    handoffId,
    expectedVersion,
    { ...options, operation: "abnormalExitHandoff" },
    { expectedVersion },
    (row, now) => {
      if (row.superseded_by !== null) {
        throw new HandoffStateConflictError(
          `handoff was superseded by ${row.superseded_by}: abnormal exit refused`,
        );
      }
      if (
        row.status !== "prepared" &&
        row.status !== "dispatched" &&
        row.status !== "reported"
      ) {
        throw new HandoffStateConflictError(
          `abnormal exit requires a non-terminal status (current ${row.status})`,
        );
      }
      setHandoffStatusInTx(
        db,
        row,
        row.status as HandoffStatus,
        "abnormal_exit",
        "worker exited abnormally; outcome unverified",
        now,
      );
      const next = readHandoff(db, row.id);
      if (next === null) {
        throw new RepositoryNotFoundError(`handoff ${row.id} not found`);
      }
      return { body: toHandoffView(next), status: 200 };
    },
  );
}

/**
 * Human records one more attempt with an explicit REQUIRED closed-cause
 * label (never automatic, never invented by us; attempts are bounded only
 * by explicit human action). Allowed from any non-terminal state; a
 * `failed` handoff RETURNS TO `prepared` on a recorded attempt (the retry
 * then follows the normal dispatch→report→verify path). Already-superseded
 * handoffs and handoffs with a pending `needs_reevaluation` notice refuse
 * (reaffirm comes first, so a stale parent never gets silently retried).
 * Verified/cancelled stay terminal.
 */
export function recordHandoffAttempt(
  db: Database.Database,
  sessionId: string,
  handoffId: string,
  expectedVersion: number,
  cause: HandoffRetryCause,
  options: AutonomyKeyOptions,
): { status: number; body: HandoffView; replayed: boolean } {
  return mutateHandoff(
    db,
    sessionId,
    handoffId,
    expectedVersion,
    { ...options, operation: "recordHandoffAttempt" },
    { expectedVersion, cause },
    (row, now) => {
      if (row.status === "verified" || row.status === "cancelled") {
        throw new HandoffStateConflictError(
          `attempt requires a retryable status (current ${row.status})`,
        );
      }
      if (row.superseded_by !== null) {
        throw new HandoffStateConflictError(
          `handoff was superseded by ${row.superseded_by}: attempt refused`,
        );
      }
      // Same durable reevaluation gate as dispatch: a handoff whose parent
      // was revoked/superseded is never silently retried — reaffirm first.
      if (row.needs_reevaluation === 1) {
        throw new HandoffStateConflictError(
          "handoff needs reevaluation: reaffirm before recording an attempt",
        );
      }
      // A retry after `failed` goes back to `prepared` (same-TX status
      // move): the human can then dispatch→report→verify the new attempt
      // through the standard lifecycle. Every other status keeps its
      // current lifecycle state (an attempt row is only a record).
      const toStatus: HandoffStatus =
        row.status === "failed" ? "prepared" : (row.status as HandoffStatus);
      const attemptNo = row.active_attempt + 1;
      db.prepare(
        "INSERT INTO handoff_attempts (id, handoff_id, session_id, attempt_no, cause, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(generateId(), row.id, row.session_id, attemptNo, cause, now);
      const moved = db
        .prepare(
          "UPDATE delegation_handoffs SET active_attempt = ?, status = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?",
        )
        .run(attemptNo, toStatus, now, row.id, row.version);
      if (moved.changes !== 1) {
        const current = readHandoff(db, row.id);
        throw new HandoffVersionConflictError(
          row.version,
          current?.version ?? row.version,
        );
      }
      appendHandoffEventInTx(
        db,
        row.id,
        row.session_id,
        "attempt_recorded",
        row.status,
        toStatus,
        `attempt ${attemptNo} cause=${cause}${row.status === "failed" ? " (retry returns to prepared for a new dispatch)" : ""} (explicit human retry, never automatic)`,
        now,
      );
      const next = readHandoff(db, row.id);
      if (next === null) {
        throw new RepositoryNotFoundError(`handoff ${row.id} not found`);
      }
      return { body: toHandoffView(next), status: 200 };
    },
  );
}

/**
 * Explicit human reaffirm: keeps the status, clears a pending
 * `needs_reevaluation` notice (CAS on the expected version, allowed only
 * while the notice is set). A stale frozen task binding (task resumed or
 * reparented without a flag, e.g. a missed hook) may also be reaffirmed:
 * the binding staleness is the notice, so the human path never dead-ends.
 * Reaffirm adopts the CURRENT task binding into the frozen snapshot
 * (task_version + parent ids/version), so a later dispatch validates
 * against what the human just accepted.
 */
/** Current parent version for the reaffirm snapshot (null when parentless). */
function parentVersionForReaffirm(
  db: Database.Database,
  sessionId: string,
  parentPurposeId: string | null,
): number | null {
  if (parentPurposeId === null) return null;
  try {
    const parent = db
      .prepare(
        "SELECT version FROM autonomy_purposes WHERE session_id = ? AND id = ?",
      )
      .get(sessionId, parentPurposeId) as { version: number } | undefined;
    return parent?.version ?? null;
  } catch {
    return null;
  }
}

export function reaffirmHandoff(
  db: Database.Database,
  sessionId: string,
  handoffId: string,
  expectedVersion: number,
  options: AutonomyKeyOptions,
): { status: number; body: HandoffView; replayed: boolean } {
  return mutateHandoff(
    db,
    sessionId,
    handoffId,
    expectedVersion,
    { ...options, operation: "reaffirmHandoff" },
    { expectedVersion },
    (row, now) => {
      const task = db
        .prepare(
          "SELECT version, parent_purpose_id FROM autonomy_tasks WHERE session_id = ? AND id = ?",
        )
        .get(row.session_id, row.task_id) as
        | { version: number; parent_purpose_id: string | null }
        | undefined;
      const staleBinding =
        task !== undefined &&
        (task.version !== row.task_version ||
          (task.parent_purpose_id ?? null) !== (row.parent_purpose_id ?? null));
      if (row.needs_reevaluation !== 1 && !staleBinding) {
        throw new HandoffStateConflictError(
          "reaffirm requires a pending reevaluation notice",
        );
      }
      const moved = db
        .prepare(
          "UPDATE delegation_handoffs SET needs_reevaluation = 0, version = version + 1, updated_at = ?, task_version = ?, parent_purpose_id = ?, parent_purpose_version = ? WHERE id = ? AND version = ?",
        )
        .run(
          now,
          task?.version ?? row.task_version,
          (task?.parent_purpose_id ?? null) as string | null,
          parentVersionForReaffirm(
            db,
            sessionId,
            task?.parent_purpose_id ?? null,
          ),
          row.id,
          row.version,
        );
      if (moved.changes !== 1) {
        const current = readHandoff(db, row.id);
        throw new HandoffVersionConflictError(
          row.version,
          current?.version ?? row.version,
        );
      }
      appendHandoffEventInTx(
        db,
        row.id,
        row.session_id,
        "reaffirmed",
        row.status,
        row.status,
        "human reaffirmed after parent change",
        now,
      );
      const cleared = readHandoff(db, row.id);
      if (cleared === null) {
        throw new RepositoryNotFoundError(`handoff ${row.id} not found`);
      }
      appendHandoffEventInTx(
        db,
        cleared.id,
        cleared.session_id,
        "reevaluation_cleared",
        cleared.status,
        cleared.status,
        "reevaluation notice cleared by explicit human reaffirm",
        now,
      );
      const next = readHandoff(db, row.id);
      if (next === null) {
        throw new RepositoryNotFoundError(`handoff ${row.id} not found`);
      }
      return { body: toHandoffView(next), status: 200 };
    },
  );
}

/* ------------------------------------------------------------------ */
/* Revocation re-evaluation notice (same-TX hook for autonomy.ts)       */
/* ------------------------------------------------------------------ */

/**
 * Flag every ACTIVE (prepared/dispatched/reported/failed) handoff affected by a
 * revoked/superseded parent purpose with the durable `needs_reevaluation`
 * NOTICE plus a `reevaluation_flagged` history event. `failed` is included:
 * `recordHandoffAttempt` can return a failed handoff to `prepared` and
 * `dispatchHandoff` would then accept it, so a non-active parent must not
 * go unflagged on failed rows. Both binding
 * directions match: the FROZEN parent snapshot on the handoff row AND the
 * task's CURRENT parent (a task re-parented via `resumeTask` — including
 * a task that was parentless when the handoff froze — belongs to the
 * revoked purpose now, even when the handoff snapshot names an older
 * purpose or none). Called by autonomy.ts INSIDE the parent-transition
 * transaction, so the flag and the parent state change are atomic
 * (idempotent: flagged rows skipped).
 *
 * The flag ALSO bumps `version` under a CAS guard: a human holding a
 * stale loaded version can no longer dispatch over the notice. New
 * dispatch is refused while the notice is set; cancel stays allowed.
 *
 * This NEVER mutates a purpose, NEVER writes a task, NEVER completes a
 * task, NEVER writes a notification, and NEVER touches the stop control:
 * it is a visible notice only (human decides). Callers MUST treat a
 * missing-table error as a pre-0019 database and skip (best-effort
 * bridge, same pattern as the learning bridge in autonomy.ts).
 */
export function flagHandoffReevaluationInTx(
  db: Database.Database,
  sessionId: string,
  parentPurposeId: string,
  reason: string,
  now: number,
): void {
  const rows = db
    .prepare(
      "SELECT h.id AS id, h.status AS status, h.version AS version FROM delegation_handoffs h LEFT JOIN autonomy_tasks t ON t.session_id = h.session_id AND t.id = h.task_id WHERE h.session_id = ? AND (h.parent_purpose_id = ? OR t.parent_purpose_id = ?) AND h.status IN ('prepared','dispatched','reported','failed') AND h.needs_reevaluation = 0",
    )
    .all(sessionId, parentPurposeId, parentPurposeId) as {
    id: string;
    status: string;
    version: number;
  }[];
  for (const row of rows) {
    const moved = db
      .prepare(
        "UPDATE delegation_handoffs SET needs_reevaluation = 1, version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND needs_reevaluation = 0",
      )
      .run(now, row.id, row.version);
    if (moved.changes !== 1) {
      continue;
    }
    appendHandoffEventInTx(
      db,
      row.id,
      sessionId,
      "reevaluation_flagged",
      row.status,
      row.status,
      reason,
      now,
    );
  }
}

/**
 * Flag every non-terminal handoff bound to `taskId` whose frozen task
 * binding (version/parent snapshot) no longer matches the CURRENT task
 * row. Called by autonomy.ts `resumeTask` INSIDE the resume transaction
 * when the task is reparented (or its version advanced past the frozen
 * snapshot), so the frozen export can never silently delegate under the
 * old parent: new dispatch is refused while the notice is set, cancel
 * stays allowed, and explicit human reaffirm clears it (idempotent:
 * flagged rows skipped). Best-effort bridge: callers MUST treat a
 * missing-table error as a pre-0019 database and skip.
 */
export function flagHandoffTaskReparentInTx(
  db: Database.Database,
  sessionId: string,
  taskId: string,
  reason: string,
  now: number,
): void {
  const task = db
    .prepare(
      "SELECT version, parent_purpose_id FROM autonomy_tasks WHERE session_id = ? AND id = ?",
    )
    .get(sessionId, taskId) as
    | { version: number; parent_purpose_id: string | null }
    | undefined;
  if (task === undefined) return;
  const rows = db
    .prepare(
      "SELECT id, status, version, task_version, parent_purpose_id FROM delegation_handoffs WHERE session_id = ? AND task_id = ? AND status IN ('prepared','dispatched','reported','failed') AND needs_reevaluation = 0",
    )
    .all(sessionId, taskId) as {
    id: string;
    status: string;
    version: number;
    task_version: number;
    parent_purpose_id: string | null;
  }[];
  for (const row of rows) {
    if (
      row.task_version === task.version &&
      (row.parent_purpose_id ?? null) === (task.parent_purpose_id ?? null)
    ) {
      continue;
    }
    const moved = db
      .prepare(
        "UPDATE delegation_handoffs SET needs_reevaluation = 1, version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND needs_reevaluation = 0",
      )
      .run(now, row.id, row.version);
    if (moved.changes !== 1) {
      continue;
    }
    appendHandoffEventInTx(
      db,
      row.id,
      sessionId,
      "reevaluation_flagged",
      row.status,
      row.status,
      reason,
      now,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Exported handoff spec (deterministic plain text for manual pi-orch)  */
/* ------------------------------------------------------------------ */

/**
 * Build the deterministic plain-text handoff spec the human pastes into
 * pi-orch manually. Execution is NOT automated: this text only RECORDS
 * what the human frozen-entered. Sandbox claims stay labeled unverified;
 * boundary flags stay labeled as requiring separate authorization.
 */
export function buildHandoffSpec(
  db: Database.Database,
  sessionId: string,
  handoffId: string,
): string {
  const row = assertOwnedHandoff(db, sessionId, handoffId);
  const task = db
    .prepare(
      "SELECT title, body, kind, speaker, status FROM autonomy_tasks WHERE session_id = ? AND id = ?",
    )
    .get(sessionId, row.task_id) as
    | {
        title: string;
        body: string | null;
        kind: string;
        speaker: string;
        status: string;
      }
    | undefined;
  let purposeLine = "(no parent purpose: user-direct task)";
  if (row.parent_purpose_id !== null) {
    const parent = db
      .prepare(
        "SELECT statement, kind, status FROM autonomy_purposes WHERE session_id = ? AND id = ?",
      )
      .get(sessionId, row.parent_purpose_id) as
      | { statement: string; kind: string; status: string }
      | undefined;
    purposeLine =
      parent === undefined
        ? `(parent purpose ${row.parent_purpose_id} missing)`
        : `${parent.statement} [kind=${parent.kind} status=${parent.status} version=${row.parent_purpose_version}]`;
  }
  const criteria = parseJsonArray(row.acceptance_criteria, "criteria");
  const boundaries = parseJsonArray(row.boundaries, "boundaries");
  const lines: string[] = [
    `# Delegation handoff ${row.id}`,
    "",
    "Human-driven pi-orch handoff record. Execution is NOT automated:",
    "a human pastes this spec into pi-orch manually and records the",
    "verified outcome back. Worker ran never means success.",
    "",
    `## Purpose (parent snapshot v${row.parent_purpose_version ?? "-"})`,
    purposeLine,
    "",
    `## Task (frozen v${row.task_version})`,
    task === undefined
      ? `(task ${row.task_id} missing)`
      : `${task.title} [kind=${task.kind} speaker=${task.speaker} status=${task.status}]${task.body === null ? "" : `\n${task.body}`}`,
    "",
    "## Target (frozen, human-entered)",
    row.target,
    "",
    "## Acceptance criteria (frozen, immutable; all must pass)",
    ...criteria.map((criterion, index) => `${index + 1}. ${String(criterion)}`),
    "",
    "## Operation scope (frozen, closed vocab)",
    row.op_scope,
    "",
    "## Budget (human-entered TEXT labels only; never enforced numerically)",
    row.budget_label ?? "(none claimed)",
    "",
    "## Boundary flags (each REQUIRES SEPARATE AUTHORIZATION; store grants nothing)",
    ...(boundaries.length === 0
      ? ["(none requested)"]
      : boundaries.map(
          (boundary) =>
            `- ${String(boundary)}: 権限は別途承認 (separate authorization required)`,
        )),
    "",
    "## Environment note",
    "サンドボックス成功≠本番: a sandbox success never means production",
    "deployment. Production is a separate unverified claim.",
    row.report_environment === null
      ? "(no worker report recorded yet)"
      : `Worker claim (UNVERIFIED): environment=${row.report_environment}`,
    "",
    `## Lifecycle: status=${row.status} version=${row.version} attempts=${row.active_attempt}`,
  ];
  return `${lines.join("\n")}\n`;
}
