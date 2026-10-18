// AV02 shadow-deliberation durable core: queue + frozen context + fenced
// completion + CODE policy (kernel-internal handoff, no HTTP/UI here).
//
// Ownership: this module is the ONLY writer of the shadow tables
// (`shadow_scope_epochs`, `shadow_inbox`, `shadow_jobs`, `shadow_job_events`)
// plus explicit-request rows under `api_idempotency`. It uses the
// caller-provided single better-sqlite3 connection, joins the CALLER's
// `BEGIN IMMEDIATE` transaction for every `*InTx` function (never opening
// its own inside them), version-CAS mutations, canonical JSON + SHA-256
// domain-separated idempotency hashing, and Zod validation on every JSON
// boundary — the same conventions as the M0 repository and `autonomy.ts`.
//
// Import direction (cycle firewall): `autonomy.ts` imports the enqueue /
// reconcile entry points FROM this module. This module MUST NEVER
// runtime-import `autonomy.ts` (or `repository.ts`): policy reads arrive
// through the narrow `ShadowPolicyReader` port, which the repository
// implements from the existing autonomy getters. Only `import type`-free
// structural interfaces are used here, so there is not even a type-level
// cycle to break. Deadline strictness likewise arrives via the port
// (`isStrictDeadline`) instead of duplicating the calendar grammar.
//
// Hard boundaries enforced here (no exceptions):
// - Model proposals NEVER become execution authority. This module imports
//   no ToolBroker, no calendar connector, no child-process, no device, no
//   secret store, and performs ZERO execution on completion: a completed
//   job stores the validated MODEL decision SEPARATE from the CODE policy
//   code (`missing_grant` / `wish_not_command` /
//   `external_no_authority` / `needs_clarification` / `no_action` /
//   `shadow_only`). A recorded permission CLAIM never removes
//   `missing_grant`: there is no runtime grant anywhere in this core.
// - A recorded `permission` purpose is ONLY a claim: the CODE policy may
//   record `missing_grant`, but a recorded permission NEVER becomes a
//   grant and NOTHING here can spend or create one.
// - Wish / self / external records can be REASONED ABOUT (they appear in
//   the frozen context with their provenance) but never OBEYED as
//   instructions: `execute` evidence touching external text maps to
//   `external_no_authority`, and wish-kind evidence maps to
//   `wish_not_command`.
// - `do-nothing` is genuinely representable (validated completion with a
//   null action and `no_action` policy), never a fake failure fallback.
// - Queueing happens ONLY for meaningful task/purpose policy changes (via
//   `enqueueShadowSourceInTx`, called from the autonomy mutation path in
//   the SAME transaction) or an explicit deliberation request. There is no
//   timer, no poll, no retry loop, no model-call budget, and ordinary user
//   chat (`user_message` activity) NEVER enqueues anything.
// - The durable event source is written in the SAME transaction as the
//   state change (the caller owns the TX; this module only appends into
//   it), so there is no enqueue-after-commit crash window. Shadow's OWN
//   writes never enqueue further work.
// - Scope epochs bump on EVERY purpose/task/conflict state change, even
//   while paused. Completion CAS-fences the global paused flag, the global
//   control version, the per-scope epoch (so a constraint created DURING
//   the model call invalidates the output even when every existing record
//   version is unchanged), every referenced target's version + lifecycle +
//   time applicability, and the job lease. Any fence failure HOLDS the job
//   with a fixed redacted reason — never a silent drop, never an implicit
//   retry.
// - Pause holds pending jobs (never bulk-replays); resume marks
//   paused-time inbox rows `skipped` (NO catchup: new meaningful state or
//   a new explicit request is required); restart holds pending/claimed
//   jobs (the 0011 restart fence already re-pauses the control first, and
//   replaying an OLD resume key still never unpauses).
// - A foreground abort may HOLD a pending/claimed job with
//   `aborted_foreground` without pretending a model decision was made.

import {
  type ShadowDecision,
  ShadowFailCodeSchema,
  ShadowHoldReasonSchema,
  type ShadowJobContext,
  ShadowJobContextSchema,
  type ShadowJobKind,
  ShadowJobViewSchema,
  type ShadowModelOutput,
  ShadowModelOutputSchema,
  type ShadowPolicyCode,
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

/** CAS version mismatch on a shadow job mutation (409). */
export class ShadowVersionConflictError extends KernelStorageError {
  readonly expectedVersion: number;
  readonly currentVersion: number;

  constructor(expectedVersion: number, currentVersion: number) {
    super(
      "shadow_version_conflict",
      `shadow version conflict: expected ${expectedVersion}, current ${currentVersion}`,
    );
    this.expectedVersion = expectedVersion;
    this.currentVersion = currentVersion;
  }
}

/** Illegal shadow lifecycle transition or paused-control work attempt (409). */
export class ShadowStateConflictError extends KernelStorageError {
  constructor(message: string) {
    super("shadow_state_conflict", message);
  }
}

/** Job lease held by a different worker (409, no state change). */
export class ShadowLeaseConflictError extends KernelStorageError {
  constructor(message: string) {
    super("shadow_lease_conflict", message);
  }
}

/**
 * GLOBAL one-claimed-job-at-once fence: another shadow job already holds
 * the single live service lease (409, no state change, no loss). The new
 * pending job is NOT dropped/failed and the old lease is NOT stolen: the
 * runtime defers honestly until settlement/reconcile re-drives it. Lease
 * expiry never auto-reruns work; startup already holds old claims.
 */
export class ShadowWorkerBusyError extends KernelStorageError {
  constructor(message: string) {
    super("shadow_worker_busy", message);
  }
}

/**
 * Frozen context exceeds the bounded policy window: the job is honestly
 * HELD with `context_too_large` BEFORE any gateway call instead of
 * silently dropping permissions / constraints.
 */
export class ShadowContextTooLargeError extends KernelStorageError {
  constructor(message: string) {
    super("shadow_state_conflict", message);
  }
}

/* ------------------------------------------------------------------ */
/* Narrow read port (implemented by the repository, no cycle)           */
/* ------------------------------------------------------------------ */

/** Minimal purpose projection the repository maps from its own views. */
export interface ShadowReaderPurpose {
  id: string;
  scope: string;
  kind: string;
  explicit: boolean;
  sourceKind: string;
  statement: string;
  interpretation: string | null;
  status: string;
  version: number;
  supersededBy: string | null;
  validFrom: string | null;
  validUntil: string | null;
  createdAt: number;
}

/** Minimal task projection the repository maps from its own views. */
export interface ShadowReaderTask {
  id: string;
  scope: string;
  title: string;
  /** Bounded operative detail (null when the task carries none). */
  body: string | null;
  kind: string;
  speaker: string;
  deadline: string | null;
  parentPurposeId: string | null;
  status: string;
  version: number;
  holdReason: string | null;
  /** Reconsideration condition (held tasks only; null otherwise). */
  reconsiderTrigger: string | null;
}

/**
 * Narrow read port into existing policy state. The repository implements
 * this from the existing autonomy getters (no duplicated purpose mapper,
 * no runtime import of `autonomy.ts` from here).
 */
export interface ShadowPolicyReader {
  /**
   * ALL purposes in (session, scope), newest first, SQL scope-filtered
   * BEFORE the limit, up to 101 rows so the builder detects REAL overflow
   * (101 in => `context_too_large`). Internal port only: never exposed
   * through the public max-100 list DTO.
   */
  listScopePurposes(sessionId: string, scope: string): ShadowReaderPurpose[];
  /**
   * ALL tasks in (session, scope), newest first, SQL scope-filtered BEFORE
   * the limit, up to 101 rows for overflow detection (internal port only).
   */
  listScopeTasks(sessionId: string, scope: string): ShadowReaderTask[];
  /** Explicit conflict pairs in (session, scope), scope-filtered, up to 101. */
  listScopeConflictPairs(sessionId: string, scope: string): [string, string][];
  /** Strict explicit-offset RFC3339 check (borrowed grammar, no copy). */
  isStrictDeadline(value: string): boolean;
  /**
   * Trusted time-applicability check (borrowed autonomy grammar, no copy):
   * true when the stored window covers `now` (NULL bounds unbounded, end
   * exclusive). Status is checked by callers; this covers the window only.
   */
  isPurposeApplicableAt(
    purpose: { validFrom: string | null; validUntil: string | null },
    now: number,
  ): boolean;
}

/* ------------------------------------------------------------------ */
/* Local strict helpers (same conventions as the M0 repository).        */
/* ------------------------------------------------------------------ */

/**
 * Bounded frozen-context window, borrowed from the existing list
 * pagination cap (`AutonomyListQuery` max 100): a scope whose purposes +
 * tasks exceed it is honestly held (`context_too_large`) rather than
 * truncated. This is a storage-completeness bound, never a model setting.
 */
const SHADOW_CONTEXT_RECORD_CAP = 100;

/** Bounded worker-claim lease window (ms): default 5 min, max 1 h. */
export const SHADOW_CLAIM_LEASE_DEFAULT_MS = 300_000;
const SHADOW_CLAIM_LEASE_MAX_MS = 3_600_000;

/** Max REAL retrieved-memory snippets frozen per claim (recall-limit family). */
export const SHADOW_MEMORY_SNIPPET_CAP = 8;
/** Max memory snippet size (code points; borrowed from recall snippet bound). */
export const SHADOW_MEMORY_SNIPPET_MAX_CP = 512;

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

/**
 * True for better-sqlite3 lock-contention failures (`SQLITE_BUSY` /
 * `SQLITE_BUSY_SNAPSHOT`): another connection holds the write lock. The
 * runtime maps these to honest busy-deferral, never to a dropped job.
 */
function isSqliteBusy(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code !== undefined &&
    String((error as { code?: unknown }).code).startsWith("SQLITE_BUSY")
  );
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
/* Row shapes                                                           */
/* ------------------------------------------------------------------ */

interface RawControl {
  paused: number;
  version: number;
}

function readControlInTx(db: Database.Database): RawControl {
  const row = db
    .prepare("SELECT paused, version FROM autonomy_control WHERE id = 'global'")
    .get() as RawControl | undefined;
  if (row !== undefined) {
    return row;
  }
  // Defensive heal (migration 0011 seeds this row): paused wins, never resumed.
  db.prepare(
    "INSERT INTO autonomy_control (id, paused, version, reason, updated_at) VALUES ('global', 1, 1, 'default_paused', 0) ON CONFLICT(id) DO NOTHING",
  ).run();
  const healed = db
    .prepare("SELECT paused, version FROM autonomy_control WHERE id = 'global'")
    .get() as RawControl | undefined;
  if (healed === undefined) {
    throw new RepositoryNotFoundError("autonomy control not found");
  }
  return healed;
}

interface RawJob {
  id: string;
  session_id: string;
  scope: string;
  kind: string;
  status: string;
  trigger_event: string;
  trigger_id: string | null;
  request_key: string | null;
  request_reason: string | null;
  control_version: number;
  scope_epoch: number;
  claim_control_version: number | null;
  claim_scope_epoch: number | null;
  context_json: string | null;
  model_decision_json: string | null;
  policy_code: string | null;
  version: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
  hold_reason: string | null;
  fail_code: string | null;
  created_at: number;
  updated_at: number;
}

function toJobView(row: RawJob): {
  id: string;
  sessionId: string;
  scope: string;
  kind: ShadowJobKind;
  status: "pending" | "claimed" | "completed" | "held" | "failed" | "cancelled";
  triggerEvent: string;
  triggerId: string | null;
  requestKey: string | null;
  controlVersion: number;
  scopeEpoch: number;
  claimControlVersion: number | null;
  claimScopeEpoch: number | null;
  version: number;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  policyCode: ShadowPolicyCode | null;
  holdReason: string | null;
  failCode: string | null;
  createdAt: number;
  updatedAt: number;
} {
  return parseOrValidation(
    () =>
      ShadowJobViewSchema.parse({
        id: row.id,
        sessionId: row.session_id,
        scope: row.scope,
        kind: row.kind,
        status: row.status,
        triggerEvent: row.trigger_event,
        triggerId: row.trigger_id,
        requestKey: row.request_key,
        controlVersion: row.control_version,
        scopeEpoch: row.scope_epoch,
        claimControlVersion: row.claim_control_version,
        claimScopeEpoch: row.claim_scope_epoch,
        version: row.version,
        leaseOwner: row.lease_owner,
        leaseExpiresAt: row.lease_expires_at,
        policyCode: row.policy_code,
        holdReason: row.hold_reason,
        failCode: row.fail_code,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }),
    "stored shadow job",
  );
}

function readJob(db: Database.Database, jobId: string): RawJob | null {
  return (
    (db.prepare("SELECT * FROM shadow_jobs WHERE id = ?").get(jobId) as
      | RawJob
      | undefined) ?? null
  );
}

/** Ownership-first job lookup (foreign ids are 404, never 403). */
function assertOwnedJob(
  db: Database.Database,
  sessionId: string,
  jobId: string,
): RawJob {
  const session = requireId(sessionId, "sessionId");
  const job = requireId(jobId, "jobId");
  const row = readJob(db, job);
  if (row === null || row.session_id !== session) {
    throw new RepositoryNotFoundError(
      `shadow job ${job} not found in session ${session}`,
    );
  }
  return row;
}

function appendJobEventInTx(
  db: Database.Database,
  jobId: string,
  sessionId: string,
  event:
    | "enqueued"
    | "claimed"
    | "completed"
    | "held"
    | "failed"
    | "cancelled"
    | "superseded",
  fromStatus: string | null,
  toStatus: string,
  note: string | null,
  now: number,
): void {
  const seqRow = db
    .prepare(
      "SELECT COALESCE(MAX(seq), 0) AS max_seq FROM shadow_job_events WHERE job_id = ?",
    )
    .get(jobId) as { max_seq: number };
  db.prepare(
    "INSERT INTO shadow_job_events (id, job_id, session_id, seq, event, from_status, to_status, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    generateId(),
    jobId,
    sessionId,
    seqRow.max_seq + 1,
    event,
    fromStatus,
    toStatus,
    note,
    now,
  );
}

/* ------------------------------------------------------------------ */
/* Scope epochs                                                         */
/* ------------------------------------------------------------------ */

/**
 * Bump the per-(session, scope) epoch and return the NEW value. Called for
 * EVERY purpose/task/conflict state change — even while the global control
 * is paused — so a constraint created DURING a model call invalidates the
 * in-flight output even when every existing record version is unchanged.
 * Per-scope epochs keep unrelated-scope work from invalidating this job.
 * MUST be called inside the caller's transaction (no own TX here).
 */
export function bumpShadowScopeEpochInTx(
  db: Database.Database,
  sessionId: string,
  scope: string,
  now: number,
): number {
  const session = requireId(sessionId, "sessionId");
  if (scope.length === 0 || scope.length > 128) {
    throw new RepositoryValidationError("scope must be 1..128 chars");
  }
  const at = nowMs(now);
  db.prepare(
    "INSERT INTO shadow_scope_epochs (session_id, scope, epoch, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT(session_id, scope) DO UPDATE SET epoch = epoch + 1, updated_at = excluded.updated_at",
  ).run(session, scope, at);
  const row = db
    .prepare(
      "SELECT epoch FROM shadow_scope_epochs WHERE session_id = ? AND scope = ?",
    )
    .get(session, scope) as { epoch: number } | undefined;
  if (row === undefined) {
    throw new RepositoryNotFoundError(
      `shadow scope epoch missing for session ${session}`,
    );
  }
  return row.epoch;
}

/** Read the current per-(session, scope) epoch (null when never bumped). */
export function readShadowScopeEpoch(
  db: Database.Database,
  sessionId: string,
  scope: string,
): number | null {
  const row = db
    .prepare(
      "SELECT epoch FROM shadow_scope_epochs WHERE session_id = ? AND scope = ?",
    )
    .get(sessionId, scope) as { epoch: number } | undefined;
  return row?.epoch ?? null;
}

/* ------------------------------------------------------------------ */
/* Durable enqueue (same-TX event source)                                */
/* ------------------------------------------------------------------ */

export interface EnqueueShadowSourceInput {
  /** Owning session (jobs are always session-owned). */
  sessionId: string;
  /**
   * Explicit scope when the caller already knows it (conflict records);
   * otherwise resolved from the purpose/task row for `sourceId`.
   */
  scope?: string;
  /** Which autonomy table the source lives in. */
  source: "purpose" | "task" | "conflict";
  /** Purpose / task / conflict id (null only for scope-level requests). */
  sourceId: string | null;
  /** Durable trigger name, e.g. `purpose.created`, `task.held`. */
  triggerEvent: string;
  kind: ShadowJobKind;
}

/**
 * Durable enqueue written in the SAME transaction as the autonomy state
 * change: bumps the scope epoch, appends EXACTLY ONE inbox row, and — when
 * the global control is UNPAUSED and the event qualifies — inserts (or
 * reuses) a pending job. When paused, NO job is created: the inbox row
 * stays `recorded` until a resume marks it `skipped` (no catchup, no bulk
 * replay). MUST be called inside the caller's `BEGIN IMMEDIATE`
 * transaction: the state change + epoch bump + inbox + job commit
 * atomically, leaving no enqueue-after-commit crash window.
 *
 * Shadow's OWN writes never call this (no jobs from own job/log writes),
 * and ordinary user chat never routes here (no every-chat taskization).
 */
export function enqueueShadowSourceInTx(
  db: Database.Database,
  input: EnqueueShadowSourceInput,
  now: number,
): { jobId: string | null; scopeEpoch: number; reused: boolean } {
  const session = requireId(input.sessionId, "sessionId");
  if (input.triggerEvent.length === 0 || input.triggerEvent.length > 128) {
    throw new RepositoryValidationError("triggerEvent must be 1..128 chars");
  }
  if (input.sourceId !== null) {
    requireId(input.sourceId, "sourceId");
  }
  const at = nowMs(now);
  let scope = input.scope;
  if (scope === undefined) {
    if (input.sourceId === null) {
      throw new RepositoryValidationError(
        "scope is required when sourceId is null",
      );
    }
    const table =
      input.source === "purpose" ? "autonomy_purposes" : "autonomy_tasks";
    if (input.source === "conflict") {
      throw new RepositoryValidationError(
        "scope is required for conflict sources",
      );
    }
    const row = db
      .prepare(`SELECT scope FROM ${table} WHERE id = ? AND session_id = ?`)
      .get(input.sourceId, session) as { scope: string } | undefined;
    if (row === undefined) {
      throw new RepositoryNotFoundError(
        `shadow source ${input.sourceId} not found in session ${session}`,
      );
    }
    scope = row.scope;
  }
  if (scope.length === 0 || scope.length > 128) {
    throw new RepositoryValidationError("scope must be 1..128 chars");
  }
  const epoch = bumpShadowScopeEpochInTx(db, session, scope, at);
  const control = readControlInTx(db);
  if (control.paused === 1) {
    // Paused: durable record only, NO job (no catchup on resume).
    const inboxId = generateId();
    db.prepare(
      "INSERT INTO shadow_inbox (id, session_id, scope, kind, trigger_event, trigger_id, control_version, scope_epoch, disposition, job_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'recorded', NULL, ?)",
    ).run(
      inboxId,
      session,
      scope,
      input.kind,
      input.triggerEvent,
      input.sourceId,
      control.version,
      epoch,
      at,
    );
    return { jobId: null, scopeEpoch: epoch, reused: false };
  }
  // Unpaused: reuse a live PENDING job for the same trigger (no duplicate
  // queue bursts from multi-row mutations such as parent-held cascades).
  // A CLAIMED job is never reused: the epoch bump below fences its
  // in-flight completion to held-on-drift, so coalescing into it would
  // leave the new state with no pending successor (event lost). The new
  // event therefore queues its own pending job behind the live lease.
  const live = db
    .prepare(
      "SELECT id FROM shadow_jobs WHERE session_id = ? AND scope = ? AND trigger_event = ? AND ((trigger_id IS NULL AND ? IS NULL) OR trigger_id = ?) AND status = 'pending' ORDER BY created_at ASC, id ASC LIMIT 1",
    )
    .get(session, scope, input.triggerEvent, input.sourceId, input.sourceId) as
    | { id: string }
    | undefined;
  if (live !== undefined) {
    db.prepare(
      "INSERT INTO shadow_inbox (id, session_id, scope, kind, trigger_event, trigger_id, control_version, scope_epoch, disposition, job_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'consumed', ?, ?)",
    ).run(
      generateId(),
      session,
      scope,
      input.kind,
      input.triggerEvent,
      input.sourceId,
      control.version,
      epoch,
      live.id,
      at,
    );
    return { jobId: live.id, scopeEpoch: epoch, reused: true };
  }
  const jobId = generateId();
  db.prepare(
    "INSERT INTO shadow_jobs (id, session_id, scope, kind, status, trigger_event, trigger_id, request_key, control_version, scope_epoch, claim_control_version, claim_scope_epoch, context_json, model_decision_json, policy_code, version, lease_owner, lease_expires_at, hold_reason, fail_code, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, NULL, ?, ?, NULL, NULL, NULL, NULL, NULL, 1, NULL, NULL, NULL, NULL, ?, ?)",
  ).run(
    jobId,
    session,
    scope,
    input.kind,
    input.triggerEvent,
    input.sourceId,
    control.version,
    epoch,
    at,
    at,
  );
  appendJobEventInTx(db, jobId, session, "enqueued", null, "pending", null, at);
  db.prepare(
    "INSERT INTO shadow_inbox (id, session_id, scope, kind, trigger_event, trigger_id, control_version, scope_epoch, disposition, job_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'consumed', ?, ?)",
  ).run(
    generateId(),
    session,
    scope,
    input.kind,
    input.triggerEvent,
    input.sourceId,
    control.version,
    epoch,
    jobId,
    at,
  );
  return { jobId, scopeEpoch: epoch, reused: false };
}

/**
 * Pause transition (same TX as the control flip): hold every live pending
 * job GLOBALLY with `control_paused` — never bulk-replayed later. Claimed
 * jobs stay claimed; their completion fences on the paused flag and holds
 * them then. MUST be called inside the caller's transaction.
 */
export function holdPendingShadowJobsInTx(
  db: Database.Database,
  reason:
    | "control_paused"
    | "restart_interrupted"
    | "requested_while_paused" = "control_paused",
  now: number,
): { held: number } {
  const at = nowMs(now);
  const pending = db
    .prepare("SELECT * FROM shadow_jobs WHERE status = 'pending'")
    .all() as RawJob[];
  for (const job of pending) {
    const moved = db
      .prepare(
        "UPDATE shadow_jobs SET status = 'held', version = ?, updated_at = ?, hold_reason = ? WHERE id = ? AND status = 'pending' AND version = ?",
      )
      .run(job.version + 1, at, reason, job.id, job.version);
    if (moved.changes === 1) {
      appendJobEventInTx(
        db,
        job.id,
        job.session_id,
        "held",
        "pending",
        "held",
        reason,
        at,
      );
    }
  }
  return { held: pending.length };
}

/**
 * Resume transition (same TX as the control flip): mark every
 * paused-time inbox row `skipped` — resume performs NO catchup for
 * paused-time events; new meaningful state or a new explicit request is
 * required to deliberate. MUST be called inside the caller's transaction.
 */
export function skipRecordedInboxInTx(
  db: Database.Database,
  now: number,
): { skipped: number } {
  const at = nowMs(now);
  void at;
  const moved = db
    .prepare(
      "UPDATE shadow_inbox SET disposition = 'skipped' WHERE disposition = 'recorded'",
    )
    .run();
  return { skipped: Number(moved.changes) };
}

/**
 * Startup reconcile (same TX as the 0011 restart fence, which already
 * re-pauses the control first): hold every pending job AND every claimed
 * job (leases die with the restart; old outputs must re-fence, never
 * silently continue) with `restart_interrupted`. MUST be called inside the
 * caller's transaction.
 */
export function reconcileShadowRestartInTx(
  db: Database.Database,
  now: number,
): { held: number } {
  const at = nowMs(now);
  const live = db
    .prepare("SELECT * FROM shadow_jobs WHERE status IN ('pending','claimed')")
    .all() as RawJob[];
  for (const job of live) {
    const moved = db
      .prepare(
        "UPDATE shadow_jobs SET status = 'held', version = ?, updated_at = ?, hold_reason = 'restart_interrupted', lease_owner = NULL, lease_expires_at = NULL WHERE id = ? AND status = ? AND version = ?",
      )
      .run(job.version + 1, at, job.id, job.status, job.version);
    if (moved.changes === 1) {
      appendJobEventInTx(
        db,
        job.id,
        job.session_id,
        "held",
        job.status,
        "held",
        "restart_interrupted",
        at,
      );
    }
  }
  return { held: live.length };
}

/* ------------------------------------------------------------------ */
/* Explicit requests (stable-key replay + drift + ownership)            */
/* ------------------------------------------------------------------ */

export interface ShadowKeyOptions {
  key: string;
  now?: number;
}

/**
 * Explicit deliberation request with stable-key replay: the same key +
 * same payload replays the stored job; the same key + a DIFFERENT payload
 * is a 409 drift (never silently rewritten); ownership is session-first
 * (foreign sessions 404, never 403). While paused, the request is durably
 * recorded but the job is created `held` (`requested_while_paused`): no
 * background model work starts paused, and the caller sees the hold
 * honestly. Opens its own transaction.
 */
export function requestShadowDeliberation(
  db: Database.Database,
  sessionId: string,
  scope: string,
  reason: string | undefined,
  options: ShadowKeyOptions,
): {
  status: number;
  body: ReturnType<typeof toJobView>;
  replayed: boolean;
} {
  const session = requireId(sessionId, "sessionId");
  const key = requireKey(options.key);
  const now = nowMs(options.now);
  if (scope.length === 0 || scope.length > 128) {
    throw new RepositoryValidationError("scope must be 1..128 chars");
  }
  const idemScope = `session:${session}:shadow-request`;
  const hash = requestHash(
    IDEMPOTENCY_OPERATIONS.requestShadowDeliberation.operation,
    IDEMPOTENCY_OPERATIONS.requestShadowDeliberation.schemaVersion,
    { sessionId: session, scope, reason: reason ?? null },
  );
  return withImmediate(db, () => {
    const existing = toStoredResponse(db, idemScope, key);
    if (existing !== null) {
      if (existing.requestHash !== hash) {
        throw new IdempotencyConflictError(idemScope);
      }
      const body = parseOrValidation(
        () =>
          ShadowJobViewSchema.parse(existing.responseBody) as ReturnType<
            typeof toJobView
          >,
        "stored shadow request body",
      );
      // Ownership: the stored job must still belong to this session.
      if (body.sessionId !== session) {
        throw new IdempotencyConflictError(idemScope);
      }
      // Replay returns the CURRENT lifecycle view of the SAME job under the
      // STORED status code (never a state mutation): after a stop/resume
      // epoch the replay shows HELD, never a revived pending — old work is
      // never revived by replaying an old key. Falls back to the stored
      // snapshot only when the job row is gone (never expected).
      const current = readJob(db, body.id);
      if (current !== null && current.session_id === session) {
        return {
          status: existing.responseStatus,
          body: toJobView(current),
          replayed: true,
        };
      }
      return { status: existing.responseStatus, body, replayed: true };
    }
    requireSession(db, session);
    const control = readControlInTx(db);
    // Explicit requests do not mutate policy state, so they read (or
    // initialise) the scope epoch WITHOUT bumping it: a request alone must
    // not invalidate in-flight jobs for the scope.
    db.prepare(
      "INSERT INTO shadow_scope_epochs (session_id, scope, epoch, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT(session_id, scope) DO NOTHING",
    ).run(session, scope, now);
    const epochRow = db
      .prepare(
        "SELECT epoch FROM shadow_scope_epochs WHERE session_id = ? AND scope = ?",
      )
      .get(session, scope) as { epoch: number } | undefined;
    const epoch = epochRow?.epoch ?? 1;
    const paused = control.paused === 1;
    const jobId = generateId();
    const status = paused ? "held" : "pending";
    // The explicit request text is persisted on the job row (NULL when the
    // caller passes no reason): the claim path copies it into the frozen
    // context as UNTRUSTED request evidence (citable ONLY as `sQ1`), so
    // different requested focuses freeze different deliberation input.
    // Policy-change jobs (the other INSERT below) always store NULL.
    const storedReason = reason ?? null;
    db.prepare(
      "INSERT INTO shadow_jobs (id, session_id, scope, kind, status, trigger_event, trigger_id, request_key, request_reason, control_version, scope_epoch, claim_control_version, claim_scope_epoch, context_json, model_decision_json, policy_code, version, lease_owner, lease_expires_at, hold_reason, fail_code, created_at, updated_at) VALUES (?, ?, ?, 'explicit_request', ?, 'explicit.request', NULL, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, 1, NULL, NULL, ?, NULL, ?, ?)",
    ).run(
      jobId,
      session,
      scope,
      status,
      key,
      storedReason,
      control.version,
      epoch,
      paused ? "requested_while_paused" : null,
      now,
      now,
    );
    appendJobEventInTx(
      db,
      jobId,
      session,
      paused ? "held" : "enqueued",
      null,
      status,
      paused ? "requested_while_paused" : null,
      now,
    );
    db.prepare(
      "INSERT INTO shadow_inbox (id, session_id, scope, kind, trigger_event, trigger_id, control_version, scope_epoch, disposition, job_id, created_at) VALUES (?, ?, ?, 'explicit_request', 'explicit.request', NULL, ?, ?, ?, ?, ?)",
    ).run(
      generateId(),
      session,
      scope,
      control.version,
      epoch,
      paused ? "recorded" : "consumed",
      paused ? null : jobId,
      now,
    );
    const row = readJob(db, jobId);
    if (row === null) {
      throw new RepositoryNotFoundError(`shadow job ${jobId} not found`);
    }
    const body = toJobView(row);
    storeIdempotentResponse(db, idemScope, key, hash, 201, body, now);
    return { status: 201, body, replayed: false };
  });
}

/* ------------------------------------------------------------------ */
/* Runtime queue reads (service-only, never HTTP-exposed)                */
/* ------------------------------------------------------------------ */

/**
 * Narrow trusted global pending selector for the runtime worker ONLY
 * (never exposed over HTTP, never a foreign-session read): the single
 * oldest `pending` job across ALL sessions in one bounded SQL statement
 * (no per-session iteration, no truncation). Returns null when the queue
 * is empty OR when another job already holds the single live lease: the
 * runtime must not spin on an unclaimable queue — the pending job stays
 * `pending` (no loss) and the next meaningful wake (after settlement or
 * reconcile) re-drives it. Callers still claim under CAS + the global
 * live-lease fence, so a concurrent claimer wins exactly once.
 */
export function readPendingShadowJob(db: Database.Database): {
  sessionId: string;
  jobId: string;
  version: number;
} | null {
  const claimed = db
    .prepare("SELECT id FROM shadow_jobs WHERE status = 'claimed' LIMIT 1")
    .get() as { id: string } | undefined;
  if (claimed !== undefined) {
    // GLOBAL one-claimed-job-at-once: deferred, never spun on.
    return null;
  }
  const row = db
    .prepare(
      "SELECT id, session_id, version FROM shadow_jobs WHERE status = 'pending' ORDER BY created_at ASC, id ASC LIMIT 1",
    )
    .get() as { id: string; session_id: string; version: number } | undefined;
  if (row === undefined) {
    return null;
  }
  return { sessionId: row.session_id, jobId: row.id, version: row.version };
}

/**
 * Trusted foreground-activity read for the runtime worker ONLY: true
 * while ANY user run is queued/running/cancel_requested (global, one
 * bounded SQL statement). While true the shadow worker must not start
 * new work; it defers (no polling loop — the settlement path wakes it).
 */
export function hasActiveUserRuns(db: Database.Database): boolean {
  const row = db
    .prepare(
      "SELECT id FROM runs WHERE status IN ('queued','running','cancel_requested') LIMIT 1",
    )
    .get() as { id: string } | undefined;
  return row !== undefined;
}

/* ------------------------------------------------------------------ */
/* Reads                                                                */
/* ------------------------------------------------------------------ */

export function listShadowJobs(
  db: Database.Database,
  sessionId: string,
  limit = 50,
): { items: ReturnType<typeof toJobView>[] } {
  const session = requireId(sessionId, "sessionId");
  requireSession(db, session);
  const capped = Math.min(Math.max(limit, 1), 100);
  const rows = db
    .prepare(
      "SELECT * FROM shadow_jobs WHERE session_id = ? ORDER BY created_at DESC, id ASC LIMIT ?",
    )
    .all(session, capped) as RawJob[];
  return { items: rows.map(toJobView) };
}

export function getShadowJob(
  db: Database.Database,
  sessionId: string,
  jobId: string,
): ReturnType<typeof toJobView> {
  return toJobView(assertOwnedJob(db, sessionId, jobId));
}

export function listShadowJobEvents(
  db: Database.Database,
  sessionId: string,
  jobId: string,
): {
  jobId: string;
  events: {
    seq: number;
    event: string;
    fromStatus: string | null;
    toStatus: string;
    note: string | null;
    createdAt: number;
  }[];
} {
  const owned = assertOwnedJob(db, sessionId, jobId);
  const rows = db
    .prepare(
      "SELECT seq, event, from_status, to_status, note, created_at FROM shadow_job_events WHERE job_id = ? ORDER BY seq ASC",
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
    jobId: owned.id,
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

export function listShadowInbox(
  db: Database.Database,
  sessionId: string,
  limit = 50,
): {
  items: {
    id: string;
    sessionId: string;
    scope: string;
    kind: ShadowJobKind;
    triggerEvent: string;
    triggerId: string | null;
    controlVersion: number;
    scopeEpoch: number;
    disposition: "recorded" | "consumed" | "skipped";
    jobId: string | null;
    createdAt: number;
  }[];
} {
  const session = requireId(sessionId, "sessionId");
  requireSession(db, session);
  const capped = Math.min(Math.max(limit, 1), 100);
  const rows = db
    .prepare(
      "SELECT * FROM shadow_inbox WHERE session_id = ? ORDER BY created_at DESC, id ASC LIMIT ?",
    )
    .all(session, capped) as {
    id: string;
    session_id: string;
    scope: string;
    kind: string;
    trigger_event: string;
    trigger_id: string | null;
    control_version: number;
    scope_epoch: number;
    disposition: string;
    job_id: string | null;
    created_at: number;
  }[];
  return {
    items: rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      scope: row.scope,
      kind: row.kind as ShadowJobKind,
      triggerEvent: row.trigger_event,
      triggerId: row.trigger_id,
      controlVersion: row.control_version,
      scopeEpoch: row.scope_epoch,
      disposition: row.disposition as "recorded" | "consumed" | "skipped",
      jobId: row.job_id,
      createdAt: row.created_at,
    })),
  };
}

/** Read the frozen context captured at claim (404-owned, 409 when never claimed). */
export function getShadowJobContext(
  db: Database.Database,
  sessionId: string,
  jobId: string,
): ShadowJobContext {
  const owned = assertOwnedJob(db, sessionId, jobId);
  if (owned.context_json === null) {
    throw new ShadowStateConflictError(
      `shadow job ${owned.id} has no frozen context (never claimed)`,
    );
  }
  return parseOrValidation(
    () =>
      ShadowJobContextSchema.parse(JSON.parse(owned.context_json as string)),
    "stored shadow context",
  );
}

/**
 * Read the stored MODEL decision (404-owned, null until a fenced
 * completion stores one). SELECT-only: never mutates the job, never
 * confers authority — the decision stays a frozen record next to the
 * CODE policy, and `execute` still means "proposal, unexecuted".
 */
export function getShadowJobDecision(
  db: Database.Database,
  sessionId: string,
  jobId: string,
): ShadowModelOutput | null {
  const owned = assertOwnedJob(db, sessionId, jobId);
  if (owned.model_decision_json === null) {
    return null;
  }
  return parseOrValidation(
    () =>
      ShadowModelOutputSchema.parse(
        JSON.parse(owned.model_decision_json as string),
      ),
    "stored shadow decision",
  );
}

/* ------------------------------------------------------------------ */
/* Claim (freeze full context + epochs under a lease)                   */
/* ------------------------------------------------------------------ */

export interface ClaimShadowJobOptions {
  /** Worker identity bound to the lease (non-empty, ≤128 chars). */
  owner: string;
  /** Lease duration ms (default 5 min, max 1 h — a worker-claim bound). */
  leaseMs?: number;
  /** CAS on the job version (prevents double-claim races). */
  expectedVersion: number;
  /**
   * REAL retrieved-memory snippets to freeze atomically at claim
   * (server-constructed `sR` labels, snippet-only provenance: canonical
   * record ids never enter the frozen context). `[]`/absent means no
   * available evidence, never "no memory exists". At most
   * `SHADOW_MEMORY_SNIPPET_CAP` valid snippets are kept; invalid entries
   * are dropped (never repaired).
   */
  memories?: ReadonlyArray<{ snippet: string }>;
  now?: number;
}

/**
 * Claim a single pending work unit: freezes the FULL policy context +
 * both epochs under a bounded lease. The claim fences the global paused
 * flag (no new background work while paused) and CAS-fences the job
 * version. When the scope exceeds the bounded window, the job is honestly
 * HELD with `context_too_large` BEFORE any gateway call instead of
 * silently dropping permissions / constraints. Opens its own transaction.
 */
export function claimShadowJob(
  db: Database.Database,
  sessionId: string,
  jobId: string,
  reader: ShadowPolicyReader,
  options: ClaimShadowJobOptions,
): {
  outcome: "claimed" | "held";
  job: ReturnType<typeof toJobView>;
  context: ShadowJobContext | null;
} {
  const session = requireId(sessionId, "sessionId");
  const job = requireId(jobId, "jobId");
  if (options.owner.length === 0 || options.owner.length > 128) {
    throw new RepositoryValidationError("owner must be 1..128 chars");
  }
  const leaseMs = options.leaseMs ?? SHADOW_CLAIM_LEASE_DEFAULT_MS;
  if (
    !Number.isInteger(leaseMs) ||
    leaseMs < 1000 ||
    leaseMs > SHADOW_CLAIM_LEASE_MAX_MS
  ) {
    throw new RepositoryValidationError("leaseMs must be 1000..3600000");
  }
  const now = nowMs(options.now);
  try {
    return withImmediate(db, () => {
      const row = assertOwnedJob(db, session, job);
      if (row.version !== options.expectedVersion) {
        throw new ShadowVersionConflictError(
          options.expectedVersion,
          row.version,
        );
      }
      if (row.status !== "pending") {
        throw new ShadowStateConflictError(
          `shadow job ${row.id} is ${row.status} and cannot be claimed`,
        );
      }
      const control = readControlInTx(db);
      if (control.paused === 1) {
        throw new ShadowStateConflictError(
          "autonomous work is paused; shadow jobs cannot be claimed",
        );
      }
      // GLOBAL one-claimed-job-at-once (parent kernel contract): at most
      // one live lease exists across ALL sessions/scopes/jobs. The check
      // runs atomically inside this BEGIN IMMEDIATE transaction, and the
      // partial unique index `ux_shadow_jobs_single_claimed` backstops it
      // across connections. A busy newcomer is NOT dropped/failed and
      // NEVER steals the old lease: it throws `ShadowWorkerBusyError` and
      // stays `pending` until settlement/reconcile re-drives it. Per-job
      // CAS + lease ownership still serialize SAME-job races; the runtime
      // worker is the ONLY production claimer (claim/complete/fail are
      // trusted runtime-only, never HTTP-exposed) and lands every
      // post-claim path terminal before the next claim. Lease expiry never
      // auto-reruns work; startup already holds old claims.
      const liveLease = db
        .prepare(
          "SELECT id FROM shadow_jobs WHERE status = 'claimed' AND id != ? LIMIT 1",
        )
        .get(row.id) as { id: string } | undefined;
      if (liveLease !== undefined) {
        throw new ShadowWorkerBusyError(
          "another shadow job already holds the live lease; deferred until settlement",
        );
      }
      let context: ShadowJobContext;
      try {
        context = buildShadowContext(db, reader, session, row.scope, now, {
          ...(options.memories !== undefined
            ? { memories: options.memories }
            : {}),
          // Durable explicit-request text (NULL for policy-change jobs):
          // frozen as UNTRUSTED request evidence (citable ONLY as `sQ1`).
          requestReason: row.request_reason,
        });
      } catch (error) {
        if (error instanceof ShadowContextTooLargeError) {
          const held = holdJobInTx(db, row, "context_too_large", now);
          return { outcome: "held" as const, job: held, context: null };
        }
        throw error;
      }
      const epoch = readShadowScopeEpoch(db, session, row.scope) ?? 1;
      const moved = db
        .prepare(
          "UPDATE shadow_jobs SET status = 'claimed', version = ?, updated_at = ?, claim_control_version = ?, claim_scope_epoch = ?, context_json = ?, lease_owner = ?, lease_expires_at = ? WHERE id = ? AND status = 'pending' AND version = ?",
        )
        .run(
          row.version + 1,
          now,
          control.version,
          epoch,
          JSON.stringify(context),
          options.owner,
          now + leaseMs,
          row.id,
          row.version,
        );
      if (moved.changes !== 1) {
        throw new ShadowVersionConflictError(
          options.expectedVersion,
          row.version,
        );
      }
      appendJobEventInTx(
        db,
        row.id,
        session,
        "claimed",
        "pending",
        "claimed",
        options.owner,
        now,
      );
      const current = readJob(db, row.id);
      if (current === null) {
        throw new RepositoryNotFoundError(`shadow job ${row.id} not found`);
      }
      return {
        outcome: "claimed" as const,
        job: toJobView(current),
        context,
      };
    });
  } catch (error) {
    if (isSqliteBusy(error)) {
      // A second connection holds the write lock (its claim transaction
      // is mid-flight): honest busy-deferral, never a dropped/failed job
      // and never a stolen lease. The job stays `pending` for the next
      // meaningful wake after settlement/reconcile.
      throw new ShadowWorkerBusyError(
        "shadow store busy: another claim transaction holds the write lock; deferred until settlement",
      );
    }
    throw error;
  }
}

/**
 * Bounded context builder: captures the FULL active policy records for
 * (session, scope) — every purpose with original-vs-interpretation, kind +
 * explicit/inferred, source/scope/applicability, lifecycle/supersession;
 * every task with versions + parent links + bounded body +
 * reconsiderTrigger; explicit conflict pairs; ALL
 * active constraints and ALL permission CLAIMs unranked (created order is
 * preserved, never relevance-ranked); prior failure codes (task hold
 * reasons + earlier shadow holds in scope); EXPLICIT deadlines verbatim;
 * plus the UNTRUSTED explicit-request text (`options.requestReason`,
 * citable ONLY as `sQ1`, null for policy-change jobs).
 * Throws `ShadowContextTooLargeError` when the scope exceeds the bounded
 * window instead of silently dropping records.
 */
export function buildShadowContext(
  db: Database.Database,
  reader: ShadowPolicyReader,
  sessionId: string,
  scope: string,
  now: number,
  options: {
    memories?: ReadonlyArray<{ snippet: string }>;
    /**
     * UNTRUSTED explicit-request text persisted on the job row (NULL for
     * policy-change jobs): frozen verbatim into the context so different
     * requested focuses deliberate different input, citable ONLY as `sQ1`.
     */
    requestReason?: string | null;
  } = {},
): ShadowJobContext {
  const at = nowMs(now);
  const purposes = reader.listScopePurposes(sessionId, scope);
  const tasks = reader.listScopeTasks(sessionId, scope);
  if (purposes.length + tasks.length > SHADOW_CONTEXT_RECORD_CAP) {
    throw new ShadowContextTooLargeError(
      `scope ${scope} holds ${purposes.length + tasks.length} records (cap ${SHADOW_CONTEXT_RECORD_CAP}); job must hold context_too_large`,
    );
  }
  const control = readControlInTx(db);
  const epoch = readShadowScopeEpoch(db, sessionId, scope) ?? 1;
  // Trusted applicability is computed here (status + borrowed window
  // grammar via the read port) and frozen per purpose. ALL records stay
  // in the context (history preserved, never TTL-deleted); only
  // currently-applicable records populate the constraint/claim allowlists.
  const frozenPurposes = purposes.map((purpose, index) => {
    const applicableAtClaim =
      purpose.status === "active" &&
      reader.isPurposeApplicableAt(
        { validFrom: purpose.validFrom, validUntil: purpose.validUntil },
        at,
      );
    return {
      label: `sP${index + 1}`,
      id: purpose.id,
      version: purpose.version,
      status: purpose.status,
      kind: purpose.kind,
      explicitness: purpose.explicit
        ? ("explicit" as const)
        : ("inferred" as const),
      source: purpose.sourceKind,
      scope: purpose.scope,
      statement: purpose.statement,
      interpretation: purpose.interpretation,
      validFrom: purpose.validFrom,
      validUntil: purpose.validUntil,
      supersededBy: purpose.supersededBy,
      applicableAtClaim,
    };
  });
  const frozenTasks = tasks.map((task, index) => ({
    label: `sT${index + 1}`,
    id: task.id,
    version: task.version,
    status: task.status,
    kind: task.kind,
    speaker: task.speaker,
    title: task.title,
    body: task.body,
    deadline: task.deadline,
    parentPurposeId: task.parentPurposeId,
    reconsiderTrigger: task.reconsiderTrigger,
  }));
  const permissionClaims = frozenPurposes
    .filter(
      (p) =>
        p.status === "active" && p.applicableAtClaim && p.kind === "permission",
    )
    .map((p, index) => ({
      label: `sM${index + 1}`,
      purposeId: p.id,
      statement: p.statement,
    }));
  const activeConstraintIds = frozenPurposes
    .filter(
      (p) =>
        p.status === "active" && p.applicableAtClaim && p.kind === "constraint",
    )
    .map((p) => p.id);
  // EXPLICIT TASK deadlines only: purpose applicability windows
  // (validFrom/validUntil) are NEVER deadlines and never enter this list.
  const explicitDeadlines: string[] = [];
  for (const task of frozenTasks) {
    if (task.deadline !== null && !explicitDeadlines.includes(task.deadline)) {
      explicitDeadlines.push(task.deadline);
    }
  }
  const failureCodes: string[] = [];
  for (const task of tasks) {
    if (task.holdReason !== null && !failureCodes.includes(task.holdReason)) {
      failureCodes.push(task.holdReason);
    }
  }
  const priorHolds = db
    .prepare(
      "SELECT DISTINCT hold_reason FROM shadow_jobs WHERE session_id = ? AND scope = ? AND status = 'held'",
    )
    .all(sessionId, scope) as { hold_reason: string }[];
  for (const prior of priorHolds) {
    if (!failureCodes.includes(prior.hold_reason)) {
      failureCodes.push(prior.hold_reason);
    }
  }
  const priorFailures = failureCodes.slice(0, 32).map((code, index) => ({
    label: `sF${index + 1}`,
    code,
  }));
  const rawPairs = reader.listScopeConflictPairs(sessionId, scope);
  if (rawPairs.length > SHADOW_CONTEXT_RECORD_CAP) {
    // The reader returns up to 101 rows precisely so REAL overflow is
    // detectable: 16 active purposes already yield 120 explicit pairs,
    // BELOW the purpose/task cap, and silently dropping 19 relations
    // would corrupt CODE policy. Hold honestly BEFORE the claim freeze.
    throw new ShadowContextTooLargeError(
      `scope ${scope} holds ${rawPairs.length} explicit conflict pairs (cap ${SHADOW_CONTEXT_RECORD_CAP}); job must hold context_too_large`,
    );
  }
  const conflictPairs = rawPairs.map(([a, b]) => [a, b] as [string, string]);
  // Server-frozen REAL memory evidence: valid snippets only (1..512 code
  // points), first-valid order, capped. Canonical record ids never enter.
  const memories = (options.memories ?? [])
    .filter(
      (entry): entry is { snippet: string } =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { snippet?: unknown }).snippet === "string",
    )
    .map((entry) => entry.snippet)
    .filter(
      (snippet) =>
        snippet.length >= 1 &&
        Array.from(snippet).length <= SHADOW_MEMORY_SNIPPET_MAX_CP,
    )
    .slice(0, SHADOW_MEMORY_SNIPPET_CAP)
    .map((snippet, index) => ({ label: `sR${index + 1}`, snippet }));
  return parseOrValidation(
    () =>
      ShadowJobContextSchema.parse({
        sessionId,
        scope,
        purposes: frozenPurposes,
        tasks: frozenTasks,
        conflictPairs,
        activeConstraintIds,
        permissionClaims,
        explicitDeadlines,
        priorFailures,
        memories,
        // UNTRUSTED requester text (never obeyed): null for policy-change
        // jobs and reason-less requests (no `sQ1` label exists for them).
        requestReason: options.requestReason ?? null,
        claimControlVersion: control.version,
        claimScopeEpoch: epoch,
        capturedAt: at,
      }),
    "shadow job context",
  );
}

/* ------------------------------------------------------------------ */
/* Completion (validated MODEL output + CODE policy, zero execution)    */
/* ------------------------------------------------------------------ */

export interface CompleteShadowJobOptions {
  expectedVersion: number;
  leaseOwner: string;
  now?: number;
}

/**
 * Complete a claimed job with a validated MODEL result. The output is
 * parsed against the STRICT model schema (unknown grant/permission/budget/
 * bypass fields rejected; evidence ids MUST be frozen context labels; task
 * draft deadlines MUST match an EXPLICIT input deadline), then fenced:
 * global paused flag, global control version, per-scope epoch (a constraint
 * created DURING the model call invalidates the output even when existing
 * record versions are unchanged), every referenced target's version +
 * lifecycle + time applicability, and the job lease. Any fence failure
 * HOLDS the job with a fixed redacted reason (late output held, never
 * applied, never retried). On success the CODE policy classifies the MODEL
 * decision (`missing_grant` et al.) and the job completes with ZERO
 * execution performed. Opens its own transaction.
 */
export function completeShadowJob(
  db: Database.Database,
  sessionId: string,
  jobId: string,
  reader: ShadowPolicyReader,
  modelOutput: unknown,
  options: CompleteShadowJobOptions,
): {
  outcome: "completed" | "held";
  job: ReturnType<typeof toJobView>;
  policyCode: ShadowPolicyCode | null;
} {
  const session = requireId(sessionId, "sessionId");
  const job = requireId(jobId, "jobId");
  if (options.leaseOwner.length === 0 || options.leaseOwner.length > 128) {
    throw new RepositoryValidationError("leaseOwner must be 1..128 chars");
  }
  const now = nowMs(options.now);
  // Validate the MODEL output BEFORE touching state: malformed output is a
  // caller error (no state change), never a hold.
  const parsed = parseOrValidation(
    () => ShadowModelOutputSchema.parse(modelOutput),
    "shadow model output",
  );
  return withImmediate(db, () => {
    const row = assertOwnedJob(db, session, job);
    if (row.version !== options.expectedVersion) {
      throw new ShadowVersionConflictError(
        options.expectedVersion,
        row.version,
      );
    }
    if (row.status !== "claimed") {
      throw new ShadowStateConflictError(
        `shadow job ${row.id} is ${row.status} and cannot complete`,
      );
    }
    if (row.lease_owner !== options.leaseOwner) {
      throw new ShadowLeaseConflictError(
        `shadow job ${row.id} is leased by another worker`,
      );
    }
    if (
      row.context_json === null ||
      row.claim_scope_epoch === null ||
      row.claim_control_version === null
    ) {
      throw new ShadowStateConflictError(
        `shadow job ${row.id} has no frozen claim to complete against`,
      );
    }
    const context = parseOrValidation(
      () =>
        ShadowJobContextSchema.parse(JSON.parse(row.context_json as string)),
      "stored shadow context",
    );
    validateEvidenceAndDraft(parsed, context, reader);
    // Fences (each failure HOLDS with a fixed redacted reason).
    const control = readControlInTx(db);
    if (control.paused === 1) {
      return {
        outcome: "held" as const,
        job: holdJobInTx(db, row, "control_paused", now),
        policyCode: null,
      };
    }
    if (control.version !== row.claim_control_version) {
      return {
        outcome: "held" as const,
        job: holdJobInTx(db, row, "control_version_drift", now),
        policyCode: null,
      };
    }
    const epoch = readShadowScopeEpoch(db, session, row.scope) ?? 1;
    if (epoch !== row.claim_scope_epoch) {
      return {
        outcome: "held" as const,
        job: holdJobInTx(db, row, "scope_epoch_drift", now),
        policyCode: null,
      };
    }
    if (row.lease_expires_at === null || now > row.lease_expires_at) {
      return {
        outcome: "held" as const,
        job: holdJobInTx(db, row, "lease_expired", now),
        policyCode: null,
      };
    }
    const targetFence = fenceClaimedTargets(db, context, reader, now);
    if (targetFence !== null) {
      return {
        outcome: "held" as const,
        job: holdJobInTx(db, row, targetFence, now),
        policyCode: null,
      };
    }
    // CODE policy (never model-chosen): classify the MODEL decision.
    const policyCode = deriveShadowPolicyCode(
      parsed.decision,
      context,
      parsed.evidenceIds,
    );
    const moved = db
      .prepare(
        "UPDATE shadow_jobs SET status = 'completed', version = ?, updated_at = ?, model_decision_json = ?, policy_code = ?, lease_owner = NULL, lease_expires_at = NULL WHERE id = ? AND status = 'claimed' AND version = ?",
      )
      .run(
        row.version + 1,
        now,
        JSON.stringify(parsed),
        policyCode,
        row.id,
        row.version,
      );
    if (moved.changes !== 1) {
      throw new ShadowVersionConflictError(
        options.expectedVersion,
        row.version,
      );
    }
    appendJobEventInTx(
      db,
      row.id,
      session,
      "completed",
      "claimed",
      "completed",
      policyCode,
      now,
    );
    const current = readJob(db, row.id);
    if (current === null) {
      throw new RepositoryNotFoundError(`shadow job ${row.id} not found`);
    }
    return {
      outcome: "completed" as const,
      job: toJobView(current),
      policyCode,
    };
  });
}

/**
 * Validate MODEL evidence + task-draft deadline against the FROZEN
 * context: every evidence id MUST be a frozen label (no arbitrary source
 * ids, no foreign-session ids, no free-form citations); a task-draft
 * deadline is accepted ONLY when it matches the EXPLICIT deadline of a
 * task ACTUALLY cited in `evidenceIds` (no creative calendar dates, no
 * window-as-deadline, no borrowing an uncited task's date) and satisfies
 * the strict grammar via the read port.
 */
function validateEvidenceAndDraft(
  parsed: ShadowModelOutput,
  context: ShadowJobContext,
  reader: ShadowPolicyReader,
): void {
  const labels = new Set<string>();
  for (const p of context.purposes) labels.add(p.label);
  for (const t of context.tasks) labels.add(t.label);
  for (const c of context.permissionClaims) labels.add(c.label);
  for (const f of context.priorFailures) labels.add(f.label);
  for (const m of context.memories) labels.add(m.label);
  // The explicit-request text is citable ONLY as the single `sQ1` label,
  // and only when a reason was actually frozen (reason-less and
  // policy-change jobs have no `sQ1`; the nullish read keeps pre-reason
  // frozen payloads on the honest branch).
  if ((context.requestReason ?? null) !== null) labels.add("sQ1");
  for (const id of parsed.evidenceIds) {
    if (!labels.has(id)) {
      throw new RepositoryValidationError(
        `evidence id ${id} is not a frozen job-context label`,
      );
    }
  }
  const draftDeadline = parsed.proposedAction?.taskDraft?.deadline;
  if (draftDeadline !== undefined) {
    if (!context.explicitDeadlines.includes(draftDeadline)) {
      throw new RepositoryValidationError(
        "task draft deadline must match an explicit input deadline",
      );
    }
    if (!reader.isStrictDeadline(draftDeadline)) {
      throw new RepositoryValidationError(
        "task draft deadline must satisfy the strict deadline grammar",
      );
    }
    const citedTaskDeadlines = new Set(
      context.tasks
        .filter(
          (task) =>
            parsed.evidenceIds.includes(task.label) && task.deadline !== null,
        )
        .map((task) => task.deadline as string),
    );
    if (!citedTaskDeadlines.has(draftDeadline)) {
      throw new RepositoryValidationError(
        "task draft deadline must match a cited task's explicit deadline",
      );
    }
  }
}

/**
 * Fence every frozen target against CURRENT lifecycle state: version +
 * status must be unchanged, and time applicability must be UNCHANGED since
 * the claim (computed via the borrowed grammar on the read port, never a
 * local copy). An already-inapplicable record stays context data and never
 * holds unrelated work; a window boundary crossed DURING the call holds
 * the stale proposal. Returns the hold reason, or null when every target
 * still matches.
 */
function fenceClaimedTargets(
  db: Database.Database,
  context: ShadowJobContext,
  reader: ShadowPolicyReader,
  now: number,
): "target_changed" | "target_inapplicable" | null {
  for (const purpose of context.purposes) {
    const row = db
      .prepare(
        "SELECT version, status, valid_from, valid_until FROM autonomy_purposes WHERE id = ?",
      )
      .get(purpose.id) as
      | {
          version: number;
          status: string;
          valid_from: string | null;
          valid_until: string | null;
        }
      | undefined;
    if (
      row === undefined ||
      row.version !== purpose.version ||
      row.status !== purpose.status
    ) {
      return "target_changed";
    }
    const nowApplicable =
      row.status === "active" &&
      reader.isPurposeApplicableAt(
        { validFrom: row.valid_from, validUntil: row.valid_until },
        now,
      );
    if (nowApplicable !== purpose.applicableAtClaim) {
      return "target_inapplicable";
    }
  }
  for (const task of context.tasks) {
    const row = db
      .prepare("SELECT version, status FROM autonomy_tasks WHERE id = ?")
      .get(task.id) as { version: number; status: string } | undefined;
    if (
      row === undefined ||
      row.version !== task.version ||
      row.status !== task.status
    ) {
      return "target_changed";
    }
  }
  return null;
}

/**
 * CODE policy mapping (never model-chosen, never a grant): `do-nothing` →
 * `no_action`; `ask` → `needs_clarification`; `hold` → `shadow_only`;
 * `execute` evidence touching external text → `external_no_authority`;
 * wish-kind evidence → `wish_not_command`; otherwise (including WITH a
 * recorded permission CLAIM) → `missing_grant`. A CLAIM never becomes a
 * grant and NOTHING executes: `execute` always stays unauthorized.
 */
export function deriveShadowPolicyCode(
  decision: ShadowDecision,
  context: ShadowJobContext,
  evidenceIds: string[],
): ShadowPolicyCode {
  if (decision === "do-nothing") return "no_action";
  if (decision === "ask") return "needs_clarification";
  if (decision === "hold") return "shadow_only";
  const byLabel = new Map<string, { kind: string; provenance: string }>();
  for (const p of context.purposes) {
    byLabel.set(p.label, { kind: p.kind, provenance: p.source });
  }
  for (const t of context.tasks) {
    byLabel.set(t.label, { kind: t.kind, provenance: t.speaker });
  }
  for (const claim of context.permissionClaims) {
    const owner = context.purposes.find((p) => p.id === claim.purposeId);
    byLabel.set(claim.label, {
      kind: "permission",
      provenance: owner?.source ?? "user",
    });
  }
  // REAL retrieved memory is untrusted external text data (never a
  // permission, never authority): `execute` evidence touching it maps to
  // `external_no_authority` like any other external provenance.
  for (const memory of context.memories) {
    byLabel.set(memory.label, { kind: "memory", provenance: "external" });
  }
  const evidence = evidenceIds
    .map((id) => byLabel.get(id))
    .filter((entry) => entry !== undefined);
  if (evidence.some((entry) => entry.provenance === "external")) {
    return "external_no_authority";
  }
  if (evidence.some((entry) => entry.kind === "wish")) {
    return "wish_not_command";
  }
  // CLAIM != GRANT: presence of a permission CLAIM never removes the
  // missing-grant diagnostic. `execute` always stays unauthorized (unless
  // the higher-priority external/wish boundaries above applied).
  void context;
  return "missing_grant";
}

/* ------------------------------------------------------------------ */
/* Hold / fail / cancel (fixed redacted reasons, no model pretense)     */
/* ------------------------------------------------------------------ */

function holdJobInTx(
  db: Database.Database,
  row: RawJob,
  reason: string,
  now: number,
): ReturnType<typeof toJobView> {
  const parsed = parseOrValidation(
    () => ShadowHoldReasonSchema.parse(reason),
    "shadow hold reason",
  );
  const moved = db
    .prepare(
      "UPDATE shadow_jobs SET status = 'held', version = ?, updated_at = ?, hold_reason = ?, lease_owner = NULL, lease_expires_at = NULL WHERE id = ? AND status = ? AND version = ?",
    )
    .run(row.version + 1, now, parsed, row.id, row.status, row.version);
  if (moved.changes !== 1) {
    throw new ShadowVersionConflictError(row.version, row.version);
  }
  appendJobEventInTx(
    db,
    row.id,
    row.session_id,
    "held",
    row.status,
    "held",
    parsed,
    now,
  );
  const current = readJob(db, row.id);
  if (current === null) {
    throw new RepositoryNotFoundError(`shadow job ${row.id} not found`);
  }
  return toJobView(current);
}

export interface HoldShadowJobOptions {
  expectedVersion: number;
  now?: number;
}

/**
 * Hold a pending/claimed job with a fixed REDACTED reason: a foreground
 * abort path that never pretends a model decision was made. No auto-retry,
 * no budget expansion — the hold is terminal for this job. Opens its own
 * transaction.
 */
export function holdShadowJob(
  db: Database.Database,
  sessionId: string,
  jobId: string,
  reason: string,
  options: HoldShadowJobOptions,
): ReturnType<typeof toJobView> {
  const session = requireId(sessionId, "sessionId");
  const job = requireId(jobId, "jobId");
  const now = nowMs(options.now);
  return withImmediate(db, () => {
    const row = assertOwnedJob(db, session, job);
    if (row.version !== options.expectedVersion) {
      throw new ShadowVersionConflictError(
        options.expectedVersion,
        row.version,
      );
    }
    if (row.status !== "pending" && row.status !== "claimed") {
      throw new ShadowStateConflictError(
        `shadow job ${row.id} is ${row.status} and cannot hold`,
      );
    }
    return holdJobInTx(db, row, reason, now);
  });
}

export interface FailShadowJobOptions {
  expectedVersion: number;
  now?: number;
}

/**
 * Mark a pending/claimed job failed with a fixed REDACTED code (gateway /
 * model transport failure, already redacted upstream). Opens its own
 * transaction.
 */
export function failShadowJob(
  db: Database.Database,
  sessionId: string,
  jobId: string,
  code: string,
  options: FailShadowJobOptions,
): ReturnType<typeof toJobView> {
  const session = requireId(sessionId, "sessionId");
  const job = requireId(jobId, "jobId");
  const now = nowMs(options.now);
  return withImmediate(db, () => {
    const row = assertOwnedJob(db, session, job);
    if (row.version !== options.expectedVersion) {
      throw new ShadowVersionConflictError(
        options.expectedVersion,
        row.version,
      );
    }
    if (row.status !== "pending" && row.status !== "claimed") {
      throw new ShadowStateConflictError(
        `shadow job ${row.id} is ${row.status} and cannot fail`,
      );
    }
    const failCode = parseOrValidation(
      () => ShadowFailCodeSchema.parse(code),
      "shadow fail code",
    );
    const moved = db
      .prepare(
        "UPDATE shadow_jobs SET status = 'failed', version = ?, updated_at = ?, fail_code = ?, lease_owner = NULL, lease_expires_at = NULL WHERE id = ? AND status = ? AND version = ?",
      )
      .run(row.version + 1, now, failCode, row.id, row.status, row.version);
    if (moved.changes !== 1) {
      throw new ShadowVersionConflictError(
        options.expectedVersion,
        row.version,
      );
    }
    appendJobEventInTx(
      db,
      row.id,
      session,
      "failed",
      row.status,
      "failed",
      failCode,
      now,
    );
    const current = readJob(db, row.id);
    if (current === null) {
      throw new RepositoryNotFoundError(`shadow job ${row.id} not found`);
    }
    return toJobView(current);
  });
}

export interface CancelShadowJobOptions {
  expectedVersion: number;
  now?: number;
}

/**
 * Cancel a pending job (session owner withdraws it, e.g. superseded by a
 * newer explicit request). Claimed jobs must be held, never silently
 * cancelled under a worker. Opens its own transaction.
 */
export function cancelShadowJob(
  db: Database.Database,
  sessionId: string,
  jobId: string,
  options: CancelShadowJobOptions,
): ReturnType<typeof toJobView> {
  const session = requireId(sessionId, "sessionId");
  const job = requireId(jobId, "jobId");
  const now = nowMs(options.now);
  return withImmediate(db, () => {
    const row = assertOwnedJob(db, session, job);
    if (row.version !== options.expectedVersion) {
      throw new ShadowVersionConflictError(
        options.expectedVersion,
        row.version,
      );
    }
    if (row.status !== "pending") {
      throw new ShadowStateConflictError(
        `shadow job ${row.id} is ${row.status} and cannot cancel`,
      );
    }
    const moved = db
      .prepare(
        "UPDATE shadow_jobs SET status = 'cancelled', version = ?, updated_at = ? WHERE id = ? AND status = 'pending' AND version = ?",
      )
      .run(row.version + 1, now, row.id, row.version);
    if (moved.changes !== 1) {
      throw new ShadowVersionConflictError(
        options.expectedVersion,
        row.version,
      );
    }
    appendJobEventInTx(
      db,
      row.id,
      session,
      "cancelled",
      "pending",
      "cancelled",
      null,
      now,
    );
    const current = readJob(db, row.id);
    if (current === null) {
      throw new RepositoryNotFoundError(`shadow job ${row.id} not found`);
    }
    return toJobView(current);
  });
}
