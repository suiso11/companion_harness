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
  AutonomyHistoryQuerySchema,
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
import { parseStrictInstantMs } from "./action_strategy.js";
import {
  generateId,
  IDEMPOTENCY_OPERATIONS,
  isUuidV4,
  requestHash,
} from "./canonical.js";
import {
  invalidateTrialsForScope,
  parseConstraintRule,
  revokeAllClaimedForStop,
} from "./trial_authority.js";
import {
  IdempotencyConflictError,
  KernelStorageError,
  RepositoryNotFoundError,
  RepositoryValidationError,
} from "./errors.js";

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
/* Strict deadline grammar (reuses the existing kernel helper).          */
/*                                                                     */
/* Task deadlines + purpose applicability windows share the kernel's    */
/* existing strict explicit-offset RFC3339 grammar (`parseStrictInstant  */
/* Ms` in `action_strategy.ts`, owned by the kernel so the               */
/* dependency-inverted direction stays intact). The autonomy layer adds */
/* only its own 128-char cap and genuine sub-millisecond rejection      */
/* (fractions with nonzero digits past millis reject, never truncate).  */
/* ------------------------------------------------------------------ */

const SUBSECOND_FRACTION = /T\d{2}:\d{2}:\d{2}\.(\d+)/;

/** True for a strict explicit-offset RFC3339 instant (never inferred). */
export function isStrictAutonomyDeadline(value: string): boolean {
  if (value.length === 0 || value.length > 128) return false;
  const fraction = SUBSECOND_FRACTION.exec(value);
  if (fraction?.[1] !== undefined) {
    const digits = fraction[1] as string;
    if (digits.length > 3 && /[^0]/.test(digits.slice(3))) return false;
  }
  return parseStrictInstantMs(value) !== undefined;
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

function readRuleJson(
  db: Database.Database,
  purposeId: string,
): unknown {
  try {
    const r = db
      .prepare("SELECT rule_json FROM trial_constraint_rules WHERE purpose_id = ?")
      .get(purposeId) as { rule_json: string | null } | undefined;
    if (!r || r.rule_json === null) return null;
    return JSON.parse(r.rule_json);
  } catch {
    return null;
  }
}

/** Persist/clear a structured rule; strict shape, kind=constraint only. */
function writeConstraintRuleInTx(
  db: Database.Database,
  session: string,
  scope: string,
  purposeId: string,
  kind: string,
  rule: unknown,
  rulePresent: boolean,
  now: number,
): void {
  if (!rulePresent) return;
  if (rule === null || rule === undefined) {
    db.prepare("DELETE FROM trial_constraint_rules WHERE purpose_id = ?").run(purposeId);
    return;
  }
  if (kind !== "constraint") {
    throw new RepositoryValidationError("constraintRule requires kind=constraint");
  }
  const parsed = parseConstraintRule(rule);
  db.prepare(
    "INSERT INTO trial_constraint_rules (purpose_id, session_id, scope, rule_json, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(purpose_id) DO UPDATE SET rule_json = excluded.rule_json",
  ).run(purposeId, session, scope, JSON.stringify(parsed), now);
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
  constraintRule: unknown;
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
        constraintRule: (row as { __rule?: unknown }).__rule ?? null,
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
  const row =
    (db
      .prepare("SELECT * FROM autonomy_purposes WHERE id = ?")
      .get(purposeId) as RawPurpose | undefined) ?? null;
  if (row !== null) {
    (row as { __rule?: unknown }).__rule = readRuleJson(db, row.id);
  }
  return row;
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
  constraintRule?: unknown;
  constraintRulePresent?: boolean;
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
  const rulePresent = input.constraintRulePresent ?? input.constraintRule !== undefined;
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
      ...(rulePresent ? { constraintRule: input.constraintRule ?? null } : {}),
    },
  );
  return withImmediate(db, () => {
    // Ownership-first: unknown/foreign sessions are 404 before any
    // idempotency-cache read (never a 409 on a replayed key).
    requireSession(db, session);
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
    writeConstraintRuleInTx(
      db,
      session,
      input.scope,
      id,
      input.kind,
      input.constraintRule,
      rulePresent,
      now,
    );
    if (input.kind === "constraint") {
      invalidateTrialsForScope(db, session, input.scope, "constraint_created", now);
    }
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
  for (const r of rows) {
    (r as { __rule?: unknown }).__rule = readRuleJson(db, r.id);
  }
  return { items: rows.map(toPurposeView) };
}

export function getPurpose(
  db: Database.Database,
  sessionId: string,
  purposeId: string,
): ReturnType<typeof toPurposeView> {
  return toPurposeView(assertOwnedPurpose(db, sessionId, purposeId));
}

export function listPurposeEvents(
  db: Database.Database,
  sessionId: string,
  purposeId: string,
  query: { afterSeq?: number; limit?: number } = {},
): {
  purposeId: string;
  events: {
    seq: number;
    event: string;
    fromStatus: string | null;
    toStatus: string;
    createdAt: number;
  }[];
  nextAfterSeq: number | null;
} {
  // Ownership-first: a foreign id is 404 before any history read (never a
  // 403, never an existence probe via the idempotency cache — mutations
  // keep the same order, reads have no cache at all).
  const owned = assertOwnedPurpose(db, sessionId, purposeId);
  const parsed = parseOrValidation(
    () =>
      AutonomyHistoryQuerySchema.parse({
        afterSeq: query.afterSeq ?? 0,
        limit: query.limit,
      }),
    "purpose history query",
  );
  const rows = db
    .prepare(
      "SELECT seq, event, from_status, to_status, created_at FROM autonomy_purpose_events WHERE purpose_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?",
    )
    .all(owned.id, parsed.afterSeq, parsed.limit + 1) as {
    seq: number;
    event: string;
    from_status: string | null;
    to_status: string;
    created_at: number;
  }[];
  const hasMore = rows.length > parsed.limit;
  const page = rows.slice(0, parsed.limit);
  return {
    purposeId: owned.id,
    events: page.map((row) => ({
      seq: row.seq,
      event: row.event,
      fromStatus: row.from_status,
      toStatus: row.to_status,
      createdAt: row.created_at,
    })),
    nextAfterSeq:
      hasMore && page.length > 0
        ? (page[page.length - 1] as { seq: number }).seq
        : null,
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
    // Ownership-first: foreign ids are 404 (assertOwned throws 404)
    // before any idempotency-cache read.
    const a = assertOwnedPurpose(db, session, first);
    const b = assertOwnedPurpose(db, session, second);
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
    invalidateTrialsForScope(db, session, a.scope, "conflict_recorded", now);
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
  /** undefined = preserve rule; null = clear; object = set. */
  constraintRule?: unknown;
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
  // Presence-sensitive hash: `undefined` (preserve the old window bound)  // and `null` (clear it to unbounded) are DIFFERENT commands, so the
  // canonical payload carries explicit presence flags alongside the
  // nullable values. The same key with a changed presence/value is a
  // conflict, never a silent merge.
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
      validFromPresent: input.validFrom !== undefined,
      validFrom: input.validFrom ?? null,
      validUntilPresent: input.validUntil !== undefined,
      validUntil: input.validUntil ?? null,
      rulePresent: input.constraintRule !== undefined,
      constraintRule: input.constraintRule ?? null,
    },
  );
  return withImmediate(db, () => {
    // Ownership-first: foreign ids are 404 before any idempotency-cache
    // read. Version/state checks stay AFTER the cache so verbatim replay
    // of an accepted key is preserved.
    const oldRow = assertOwnedPurpose(db, session, input.purposeId);
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
    // Rule correction: omission preserves, null clears, object sets.
    // Kind change away from constraint with a live rule must explicitly
    // clear (null) or the correction is rejected.
    const oldRule = readRuleJson(db, oldRow.id);
    if (input.kind !== "constraint" && input.constraintRule !== undefined && input.constraintRule !== null) {
      throw new RepositoryValidationError("constraintRule requires kind=constraint: clear it explicitly");
    }
    if (input.kind !== "constraint" && oldRule !== null && input.constraintRule === undefined) {
      throw new RepositoryValidationError("kind change away from constraint must explicitly clear constraintRule");
    }
    if (input.constraintRule !== undefined) {
      if (input.constraintRule === null) {
        db.prepare("DELETE FROM trial_constraint_rules WHERE purpose_id = ?").run(oldRow.id);
      } else {
        writeConstraintRuleInTx(db, session, input.scope, newId, input.kind, input.constraintRule, true, now);
      }
    } else if (oldRule !== null && input.kind === "constraint") {
      db.prepare(
        "INSERT INTO trial_constraint_rules (purpose_id, session_id, scope, rule_json, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(newId, session, input.scope, JSON.stringify(oldRule), now);
    }
    invalidateTrialsForScope(db, session, oldRow.scope, "purpose_corrected", now);
    if (input.scope !== oldRow.scope) {
      invalidateTrialsForScope(db, session, input.scope, "purpose_corrected", now);
    }
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
    // Ownership-first: foreign ids are 404 before any idempotency-cache
    // read. Version/state checks stay AFTER the cache (verbatim replay).
    const row = assertOwnedPurpose(db, session, purpose);
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
    invalidateTrialsForScope(db, session, row.scope, `purpose_${operation}d`, now);
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
    // Ownership-first: unknown/foreign sessions are 404 before any
    // idempotency-cache read (never a 409 on a replayed key).
    requireSession(db, session);
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
  query: { afterSeq?: number; limit?: number } = {},
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
  nextAfterSeq: number | null;
} {
  // Ownership-first (same guarantee as purpose history): foreign ids are
  // 404 before any row read.
  const owned = assertOwnedTask(db, sessionId, taskId);
  const parsed = parseOrValidation(
    () =>
      AutonomyHistoryQuerySchema.parse({
        afterSeq: query.afterSeq ?? 0,
        limit: query.limit,
      }),
    "task history query",
  );
  const rows = db
    .prepare(
      "SELECT seq, event, from_status, to_status, note, created_at FROM autonomy_task_events WHERE task_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?",
    )
    .all(owned.id, parsed.afterSeq, parsed.limit + 1) as {
    seq: number;
    event: string;
    from_status: string | null;
    to_status: string;
    note: string | null;
    created_at: number;
  }[];
  const hasMore = rows.length > parsed.limit;
  const page = rows.slice(0, parsed.limit);
  return {
    taskId: owned.id,
    events: page.map((row) => ({
      seq: row.seq,
      event: row.event,
      fromStatus: row.from_status,
      toStatus: row.to_status,
      note: row.note,
      createdAt: row.created_at,
    })),
    nextAfterSeq:
      hasMore && page.length > 0
        ? (page[page.length - 1] as { seq: number }).seq
        : null,
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
    // Ownership-first: foreign ids are 404 before any idempotency-cache
    // read. Version/state checks stay AFTER the cache (verbatim replay).
    const row = assertOwnedTask(db, session, task);
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
    const current = readTask(db, row.id);
    if (current === null) {
      throw new RepositoryNotFoundError(`task ${row.id} not found`);
    }
    const body = toTaskView(current);
    invalidateTrialsForScope(db, session, row.scope, `task_${operation}`, now);
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
    // Ownership-first: foreign ids are 404 before any idempotency-cache
    // read. Version/state checks stay AFTER the cache (verbatim replay).
    const row = assertOwnedTask(db, session, task);
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
    const current = readTask(db, row.id);
    if (current === null) {
      throw new RepositoryNotFoundError(`task ${row.id} not found`);
    }
    const body = toTaskView(current);
    invalidateTrialsForScope(db, session, row.scope, "task_held", now);
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
    // Ownership-first: foreign ids are 404 before any idempotency-cache
    // read. Version/state checks stay AFTER the cache (verbatim replay).
    const row = assertOwnedTask(db, session, task);
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
    const current = readTask(db, row.id);
    if (current === null) {
      throw new RepositoryNotFoundError(`task ${row.id} not found`);
    }
    const body = toTaskView(current);
    // Reparenting changes authority scope: invalidate BOTH old and new.
    invalidateTrialsForScope(db, session, row.scope, "task_resumed", now);
    if (nextParent !== row.parent_purpose_id) {
      const np = readPurpose(db, nextParent as string);
      if (np !== null && np.scope !== row.scope) {
        invalidateTrialsForScope(db, session, np.scope, "task_reparented", now);
      }
    }
    storeIdempotentResponse(db, scope, canonical, hash, 200, body, now);
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
    if (input.paused) {
      // STOP: DB pause first + revoke CLAIMED/inflight, cancelRequested.
      // QUEUED-unconsumed otherwise-valid grants SURVIVE pause but can
      // claim only after a fresh explicit global resume (gated at claim).
      revokeAllClaimedForStop(db, now);
    }
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
    recordActivityInTx(db, "restart_fence", null, at);
    recordActivityInTx(db, "interrupted_note", null, at);
    // Restart never revives: inflight claimed grants are revoked.
    revokeAllClaimedForStop(db, at);
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
