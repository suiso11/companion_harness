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
  type CreateSessionResponse,
  CreateSessionResponseSchema,
  EventsQuerySchema,
  type FrozenContext,
  FrozenContextSchema,
  HistoryQuerySchema,
  type HistoryResponse,
  HistoryResponseSchema,
  IDEMPOTENCY_SCOPE_SESSIONS_CREATE,
  IdempotencyLookupQuerySchema,
  type IdempotencyLookupResponse,
  IdempotencyLookupResponseSchema,
  IdempotencyScopeSchema,
  isTerminalStatus,
  LatestEventsResponseSchema,
  type LatestRunEvent,
  type LatestRunEventType,
  LatestRunEventTypeSchema,
  type M0RunEventType,
  type M2ModelErrorCode,
  M2ModelErrorCodeSchema,
  type M2ModelStepEventType,
  M2ModelStepEventTypeSchema,
  messageScope,
  PostMessageRequestSchema,
  type PostMessageResponse,
  PostMessageResponseSchema,
  PostRetryRequestSchema,
  type PostRetryResponse,
  parseRunErrorCode,
  parseRunEvent,
  parseRunEventPayload,
  parseRunResult,
  parseTurnInput,
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
  type RunResult,
  type RunStatus,
  retryScope,
  SnapshotBodySchema,
} from "@companion/contracts";
import type Database from "better-sqlite3";
import {
  assertUuidV4,
  generateId,
  IDEMPOTENCY_OPERATIONS,
  isUuidV4,
  requestHash,
} from "./canonical.js";
import {
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

export interface EvidenceGrantRow {
  sessionId: string;
  runId: string;
  referenceId: string;
  exposure: "snippet" | "full";
  createdAt: number;
}

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
}

function parseRunRow(row: RawRun): RunRow {
  const result =
    row.result_json === null
      ? null
      : parseOrValidation(
          () => parseRunResult(JSON.parse(row.result_json as string)),
          "run result_json",
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
  };
}

function readRun(db: Database.Database, runId: string): RawRun | null {
  return (
    (db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as
      | RawRun
      | undefined) ?? null
  );
}

function appendEventInTx(
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
}

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

/* ------------------------------------------------------------------ */
/* Repository                                                          */
/* ------------------------------------------------------------------ */

export function createKernelRepository(db: Database.Database) {
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
      const turnRow = ownedTurnRow;
      // Retry reuses the original immutable input/frozen context: read + validate only.
      parseOrValidation(
        () => parseTurnInput(JSON.parse(turnRow.input_json)),
        "retry turn input_json",
      );
      parseOrValidation(
        () => FrozenContextSchema.parse(JSON.parse(turnRow.frozen_context)),
        "retry turn frozen_context",
      );
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
    return withImmediate(db, () => {
      const row = readRun(db, id);
      if (row === null) {
        throw new RepositoryNotFoundError(`run ${id} not found`);
      }
      // Cancel-first: only status='running' may complete. cancel_requested
      // (even within grace) and terminal states discard the result with no
      // event append and no selection change.
      if (row.status !== "running") {
        return { applied: false, run: parseRunRow(row) };
      }
      const moved = db
        .prepare(
          "UPDATE runs SET status = 'completed', result_json = ?, finished_at = ? WHERE id = ? AND status = 'running'",
        )
        .run(JSON.stringify(valid), now, id);
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
    return withImmediate(db, () => {
      const row = readRun(db, id);
      if (row === null) {
        throw new RepositoryNotFoundError(`run ${id} not found`);
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
  }

  function cancelRun(
    sessionId: string,
    runId: string,
    options: TransitionOptions = {},
  ): { status: string; run: RunRow } {
    const now = nowMs(options.now);
    return withImmediate(db, () => {
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
  }

  function finalizeCancelRequested(
    runId: string,
    options: TransitionOptions = {},
  ): { applied: boolean; run: RunRow } {
    const id = requireId(runId, "runId");
    const now = nowMs(options.now);
    return withImmediate(db, () => {
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
  }

  function sweepTerminals(
    cause: "restart_recovery" | "drain",
    now: number,
  ): { abandoned: number; cancelled: number } {
    return withImmediate(db, () => {
      const running = db
        .prepare(
          `SELECT * FROM runs WHERE status = 'running' ORDER BY created_at ASC`,
        )
        .all() as RawRun[];
      const cancelling = db
        .prepare(
          `SELECT * FROM runs WHERE status = 'cancel_requested' ORDER BY created_at ASC`,
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
    const items = page.map((row) => {
      const turn = parseTurnRow(row);
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
                s.body_json AS body_json
           FROM session_references sr
           JOIN resources r ON r.id = sr.resource_id
           JOIN resource_snapshots s ON s.id = sr.snapshot_id
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
    throw new RepositoryNotFoundError(
      `scope ${validScope} not found in session ${session}`,
    );
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
        !Number.isInteger(inputTokens) ||
        (inputTokens as number) < 0 ||
        !Number.isInteger(outputTokens) ||
        (outputTokens as number) < 0
      ) {
        throw new RepositoryValidationError(
          "usage must carry integer token counts >= 0",
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
          : (parseOrValidation(
              () => JSON.parse(row.usage_json as string),
              "stored model usage",
            ) as { inputTokens: number; outputTokens: number }),
      createdAt: row.created_at,
    }));
  }

  /**
   * Persist (or upgrade snippet -> full, never downgrade) one current-run
   * EvidenceGrant. Session ownership of both the run and the reference is
   * verified first; mismatches are 404. Only actual model-facing exposure
   * may call this (the agent calls it solely for delivered reference
   * snippet/full payloads).
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
    appendToolEvent,
    appendModelStepEvent,
    recordModelCall,
    listModelCalls,
    upsertEvidenceGrant,
    listEvidenceGrants,
    getSession,
    getTurn,
    getRun,
    getActiveRun,
    getSelection,
    getHistory,
    getEvents,
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
  };
}

export type KernelRepository = ReturnType<typeof createKernelRepository>;
