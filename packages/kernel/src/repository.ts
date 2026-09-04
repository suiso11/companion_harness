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

import type Database from "better-sqlite3";
import {
  type AcceptedRun,
  type FrozenContext,
  type CreateSessionResponse,
  CreateSessionResponseSchema,
  EventsQuerySchema,
  type EventsResponse,
  EventsResponseSchema,
  FrozenContextSchema,
  HistoryQuerySchema,
  type HistoryResponse,
  HistoryResponseSchema,
  IDEMPOTENCY_SCOPE_SESSIONS_CREATE,
  IdempotencyLookupQuerySchema,
  type IdempotencyLookupResponse,
  IdempotencyLookupResponseSchema,
  IdempotencyScopeSchema,
  M0RunEventTypeSchema,
  type M0RunEventType,
  PostMessageRequestSchema,
  type PostMessageResponse,
  PostMessageResponseSchema,
  PostRetryRequestSchema,
  type PostRetryResponse,
  RUN_EVENT_SCHEMA_VERSION,
  type RunEvent,
  type RunResult,
  type RunStatus,
  RunErrorCodeSchema,
  isTerminalStatus,
  messageScope,
  parseRunEvent,
  parseRunEventPayload,
  parseRunResult,
  parseTurnInput,
  retryScope,
} from "@companion/contracts";
import {
  IDEMPOTENCY_OPERATIONS,
  assertUuidV4,
  generateId,
  isUuidV4,
  requestHash,
} from "./canonical.js";
import {
  IdempotencyConflictError,
  KernelStorageError,
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
  IdempotencyConflictError,
  KernelStorageError,
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
    throw new RepositoryValidationError("now must be an integer Unix-ms timestamp");
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
    throw new RepositoryValidationError(`${what}: ${message}`, { cause: error });
  }
}

function requireKey(key: unknown): string {
  if (!isUuidV4(key)) {
    throw new RepositoryValidationError("Idempotency-Key must be a UUID v4");
  }
  return key;
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

function readSession(db: Database.Database, sessionId: string): SessionRow | null {
  const row = db
    .prepare("SELECT id, created_at, last_active_at, next_turn_position FROM sessions WHERE id = ?")
    .get(sessionId) as
    | { id: string; created_at: number; last_active_at: number; next_turn_position: number }
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
  const input = parseOrValidation(() => parseTurnInput(JSON.parse(row.input_json)), "turn input_json");
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
      : parseOrValidation(() => parseRunResult(JSON.parse(row.result_json as string)), "run result_json");
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
    (db
      .prepare("SELECT * FROM runs WHERE id = ?")
      .get(runId) as RawRun | undefined) ?? null
  );
}

function appendEventInTx(
  db: Database.Database,
  runId: string,
  eventSeq: number,
  type: M0RunEventType,
  payload: unknown,
  now: number,
): void {
  const validType = parseOrValidation(() => M0RunEventTypeSchema.parse(type), "run event type");
  const validPayload = parseOrValidation(
    () => parseRunEventPayload(validType, payload),
    `run event payload for ${validType}`,
  );
  db.prepare(
    "INSERT INTO run_events (run_id, seq, schema_version, type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(runId, eventSeq, RUN_EVENT_SCHEMA_VERSION, validType, JSON.stringify(validPayload), now);
  db.prepare("UPDATE runs SET event_seq = ? WHERE id = ?").run(eventSeq, runId);
}

function toStoredResponse(
  db: Database.Database,
  scope: string,
  key: string,
): StoredIdempotencyRecord | null {
  const row = db
    .prepare("SELECT scope, key, request_hash, response_status, response_body, created_at FROM api_idempotency WHERE scope = ? AND key = ?")
    .get(scope, key) as
    | { scope: string; key: string; request_hash: string; response_status: number; response_body: string; created_at: number }
    | undefined;
  if (row === undefined) {
    return null;
  }
  return {
    scope: row.scope,
    key: row.key,
    requestHash: row.request_hash,
    responseStatus: row.response_status,
    responseBody: parseOrValidation(() => JSON.parse(row.response_body), "stored idempotency body"),
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
    const row = db.prepare("SELECT * FROM turns WHERE id = ?").get(id) as RawTurn | undefined;
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
      throw new RepositoryNotFoundError(`run ${run} not found in session ${session}`);
    }
    return row;
  }

  function requireOwnedTurn(sessionId: string, turnId: string): RawTurn {
    const session = requireId(sessionId, "sessionId");
    const turn = requireId(turnId, "turnId");
    const row = db.prepare("SELECT * FROM turns WHERE id = ?").get(turn) as RawTurn | undefined;
    if (row === undefined || row.session_id !== session) {
      throw new RepositoryNotFoundError(`turn ${turn} not found in session ${session}`);
    }
    return row;
  }

  function createSession(options: CreateSessionOptions): AcceptedResponse<CreateSessionResponse> {
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
      const body = parseOrValidation(
        () => CreateSessionResponseSchema.parse({ sessionId: id, createdAt: now }),
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
    const frozen = parseOrValidation(
      () =>
        FrozenContextSchema.parse({
          version: 1,
          temporal: { now, timeZone: options.timeZone ?? "UTC" },
          uiContext: parsed.uiContext,
        }),
      "post-message frozen context",
    );
    const turnInput = parseOrValidation(
      () => parseTurnInput({ kind: "user_text", version: 1, text: parsed.text }),
      "post-message turn input",
    );
    const scope = messageScope(session);
    parseOrValidation(() => IdempotencyScopeSchema.parse(scope), "message scope");
    const hash = requestHash(
      IDEMPOTENCY_OPERATIONS.postMessage.operation,
      IDEMPOTENCY_OPERATIONS.postMessage.schemaVersion,
      parsed,
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
      const seq = sessionRow.nextTurnPosition;
      const turnId = generateId();
      const runId = generateId();
      try {
        db.prepare(
          "INSERT INTO turns (id, session_id, seq, input_json, frozen_context, created_at, next_run_attempt) VALUES (?, ?, ?, ?, ?, ?, 2)",
        ).run(turnId, session, seq, JSON.stringify(turnInput), JSON.stringify(frozen), now);
        db.prepare(
          `INSERT INTO runs (id, turn_id, session_id, attempt, status, strategy,
            result_json, error_code, event_seq, select_on_success,
            tool_requests_used, created_at, started_at, finished_at, cancel_requested_at)
           VALUES (?, ?, ?, 1, 'queued', ?, NULL, NULL, 1, ?, 0, ?, NULL, NULL, NULL)`,
        ).run(runId, turnId, session, strategy, selectOnSuccess ? 1 : 0, now);
        appendEventInTx(db, runId, 1, "run.queued", { attempt: 1 }, now);
        const moved = db
          .prepare("UPDATE sessions SET next_turn_position = ?, last_active_at = ? WHERE id = ? AND next_turn_position = ?")
          .run(seq + 1, now, session, seq);
        if (moved.changes !== 1) {
          throw new RepositoryValidationError("concurrent turn allocation conflict");
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
        () => PostMessageResponseSchema.parse({ sessionId: session, turnId, run: accepted }),
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
    parseOrValidation(() => PostRetryRequestSchema.parse({}), "post-retry request");
    const strategy = options.strategy === undefined ? "m0-default" : options.strategy;
    if (strategy.length === 0 || strategy.length > 128) {
      throw new RepositoryValidationError("strategy must be 1..128 chars");
    }
    const selectOnSuccess = options.selectOnSuccess ?? true;
    const scope = retryScope(turn);
    parseOrValidation(() => IdempotencyScopeSchema.parse(scope), "retry scope");
    const hash = requestHash(
      IDEMPOTENCY_OPERATIONS.postRetry.operation,
      IDEMPOTENCY_OPERATIONS.postRetry.schemaVersion,
      { sessionId: session, turnId: turn },
    );
    return withImmediate(db, () => {
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
      if (readSession(db, session) === null) {
        throw new RepositoryNotFoundError(`session ${session} not found`);
      }
      const turnRow = db.prepare("SELECT * FROM turns WHERE id = ?").get(turn) as RawTurn | undefined;
      if (turnRow === undefined || turnRow.session_id !== session) {
        throw new RepositoryNotFoundError(`turn ${turn} not found in session ${session}`);
      }
      // Retry reuses the original immutable input/frozen context: read + validate only.
      parseOrValidation(() => parseTurnInput(JSON.parse(turnRow.input_json)), "retry turn input_json");
      parseOrValidation(
        () => FrozenContextSchema.parse(JSON.parse(turnRow.frozen_context)),
        "retry turn frozen_context",
      );
      const busy = db
        .prepare(`SELECT id FROM runs WHERE session_id = ? AND status IN ${ACTIVE_STATUSES_SQL} LIMIT 1`)
        .get(session) as { id: string } | undefined;
      if (busy !== undefined) {
        throw new SessionBusyError(session);
      }
      const attempt = turnRow.next_run_attempt;
      const moved = db
        .prepare("UPDATE turns SET next_run_attempt = ? WHERE id = ? AND next_run_attempt = ?")
        .run(attempt + 1, turn, attempt);
      if (moved.changes !== 1) {
        throw new RepositoryValidationError("concurrent run-attempt allocation conflict");
      }
      const runId = generateId();
      try {
        db.prepare(
          `INSERT INTO runs (id, turn_id, session_id, attempt, status, strategy,
            result_json, error_code, event_seq, select_on_success,
            tool_requests_used, created_at, started_at, finished_at, cancel_requested_at)
           VALUES (?, ?, ?, ?, 'queued', ?, NULL, NULL, 1, ?, 0, ?, NULL, NULL, NULL)`,
        ).run(runId, turn, session, attempt, strategy, selectOnSuccess ? 1 : 0, now);
        appendEventInTx(db, runId, 1, "run.queued", { attempt }, now);
        db.prepare("UPDATE sessions SET last_active_at = ? WHERE id = ?").run(now, session);
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
        () => PostMessageResponseSchema.parse({ sessionId: session, turnId: turn, run: accepted }),
        "post-retry response",
      );
      storeIdempotentResponse(db, scope, key, hash, 202, body, now);
      return { status: 202, body, replayed: false };
    });
  }

  function startRun(runId: string, options: TransitionOptions = {}): { applied: boolean; run: RunRow } {
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
        .prepare("UPDATE runs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'")
        .run(now, id);
      if (moved.changes !== 1) {
        const current = readRun(db, id);
        if (current === null) {
          throw new RepositoryNotFoundError(`run ${id} not found`);
        }
        return { applied: false, run: parseRunRow(current) };
      }
      appendEventInTx(db, id, row.event_seq + 1, "run.started", { attempt: row.attempt }, now);
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
        .prepare("UPDATE runs SET status = 'completed', result_json = ?, finished_at = ? WHERE id = ? AND status = 'running'")
        .run(JSON.stringify(valid), now, id);
      if (moved.changes !== 1) {
        const current = readRun(db, id);
        if (current === null) {
          throw new RepositoryNotFoundError(`run ${id} not found`);
        }
        return { applied: false, run: parseRunRow(current) };
      }
      appendEventInTx(db, id, row.event_seq + 1, "run.completed", { result: valid }, now);
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
    const code = parseOrValidation(() => RunErrorCodeSchema.parse(errorCode), "run error_code");
    return withImmediate(db, () => {
      const row = readRun(db, id);
      if (row === null) {
        throw new RepositoryNotFoundError(`run ${id} not found`);
      }
      if (row.status !== "running") {
        return { applied: false, run: parseRunRow(row) };
      }
      const moved = db
        .prepare("UPDATE runs SET status = 'failed', error_code = ?, finished_at = ? WHERE id = ? AND status = 'running'")
        .run(code, now, id);
      if (moved.changes !== 1) {
        const current = readRun(db, id);
        if (current === null) {
          throw new RepositoryNotFoundError(`run ${id} not found`);
        }
        return { applied: false, run: parseRunRow(current) };
      }
      appendEventInTx(db, id, row.event_seq + 1, "run.failed", { errorCode: code }, now);
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
          .prepare("UPDATE runs SET status = 'cancelled', cancel_requested_at = ?, finished_at = ? WHERE id = ? AND status = 'queued'")
          .run(now, now, row.id);
        if (moved.changes !== 1) {
          const current = readRun(db, row.id);
          if (current === null) {
            throw new RepositoryNotFoundError(`run ${row.id} not found`);
          }
          return { status: current.status, run: parseRunRow(current) };
        }
        appendEventInTx(db, row.id, row.event_seq + 1, "run.cancelled", {}, now);
        const current = readRun(db, row.id);
        if (current === null) {
          throw new RepositoryNotFoundError(`run ${row.id} not found`);
        }
        return { status: "cancelled", run: parseRunRow(current) };
      }
      if (row.status === "running") {
        // Running cancel commits cancel_requested before any caller abort.
        const moved = db
          .prepare("UPDATE runs SET status = 'cancel_requested', cancel_requested_at = ? WHERE id = ? AND status = 'running'")
          .run(now, row.id);
        if (moved.changes !== 1) {
          const current = readRun(db, row.id);
          if (current === null) {
            throw new RepositoryNotFoundError(`run ${row.id} not found`);
          }
          return { status: current.status, run: parseRunRow(current) };
        }
        appendEventInTx(db, row.id, row.event_seq + 1, "run.cancel_requested", {}, now);
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
        .prepare("UPDATE runs SET status = 'cancelled', finished_at = ? WHERE id = ? AND status = 'cancel_requested'")
        .run(now, id);
      if (moved.changes !== 1) {
        const current = readRun(db, id);
        if (current === null) {
          throw new RepositoryNotFoundError(`run ${id} not found`);
        }
        return { applied: false, run: parseRunRow(current) };
      }
      appendEventInTx(db, id, row.event_seq + 1, "run.cancelled", {}, now);
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
        .prepare(`SELECT * FROM runs WHERE status = 'running' ORDER BY created_at ASC`)
        .all() as RawRun[];
      const cancelling = db
        .prepare(`SELECT * FROM runs WHERE status = 'cancel_requested' ORDER BY created_at ASC`)
        .all() as RawRun[];
      let abandoned = 0;
      for (const row of running) {
        const moved = db
          .prepare("UPDATE runs SET status = 'abandoned', finished_at = ? WHERE id = ? AND status = 'running'")
          .run(now, row.id);
        if (moved.changes === 1) {
          appendEventInTx(db, row.id, row.event_seq + 1, "run.abandoned", { cause }, now);
          abandoned += 1;
        }
      }
      let cancelled = 0;
      for (const row of cancelling) {
        const moved = db
          .prepare("UPDATE runs SET status = 'cancelled', finished_at = ? WHERE id = ? AND status = 'cancel_requested'")
          .run(now, row.id);
        if (moved.changes === 1) {
          appendEventInTx(db, row.id, row.event_seq + 1, "run.cancelled", {}, now);
          cancelled += 1;
        }
      }
      // queued rows are intentionally unchanged (requeue on next startup).
      return { abandoned, cancelled };
    });
  }

  function recover(options: TransitionOptions = {}): { abandoned: number; cancelled: number } {
    return sweepTerminals("restart_recovery", nowMs(options.now));
  }

  function drain(options: TransitionOptions = {}): { abandoned: number; cancelled: number } {
    return sweepTerminals("drain", nowMs(options.now));
  }

  function appendToolEvent(
    runId: string,
    type: "tool.requested" | "tool.completed",
    payload: unknown,
    options: TransitionOptions = {},
  ): RunEvent {
    const id = requireId(runId, "runId");
    const now = nowMs(options.now);
    if (type !== "tool.requested" && type !== "tool.completed") {
      throw new RepositoryValidationError("appendToolEvent accepts only tool.requested/tool.completed");
    }
    return withImmediate(db, () => {
      const row = readRun(db, id);
      if (row === null) {
        throw new RepositoryNotFoundError(`run ${id} not found`);
      }
      if (["completed", "failed", "cancelled", "abandoned"].includes(row.status)) {
        throw new RepositoryValidationError("cannot append events to a terminal run");
      }
      const next = row.event_seq + 1;
      appendEventInTx(db, id, next, type, payload, now);
      const stored = db
        .prepare("SELECT run_id, seq, schema_version, type, payload, created_at FROM run_events WHERE run_id = ? AND seq = ?")
        .get(id, next) as
        | { run_id: string; seq: number; schema_version: number; type: string; payload: string; created_at: number }
        | undefined;
      if (stored === undefined) {
        throw new RepositoryNotFoundError(`event ${next} for run ${id} not found`);
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
      () => HistoryQuerySchema.parse({ beforePosition: query.beforePosition, limit: query.limit }),
      "history query",
    );
    const limit = parsed.limit;
    const rows =
      parsed.beforePosition === undefined
        ? (db
            .prepare("SELECT * FROM turns WHERE session_id = ? ORDER BY seq DESC LIMIT ?")
            .all(session, limit + 1) as RawTurn[])
        : (db
            .prepare("SELECT * FROM turns WHERE session_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?")
            .all(session, parsed.beforePosition, limit + 1) as RawTurn[]);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).reverse();
    const nextBefore = hasMore && page.length > 0 ? (page[0] as RawTurn).seq : null;
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
  ): EventsResponse {
    const owned = requireOwnedRun(sessionId, runId);
    const parsed = parseOrValidation(
      () => EventsQuerySchema.parse({ after: query.after ?? 0, limit: query.limit }),
      "events query",
    );
    const rows = db
      .prepare("SELECT run_id, seq, schema_version, type, payload, created_at FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?")
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
    const nextAfter = page.length > 0 ? (page[page.length - 1] as { seq: number }).seq : parsed.after;
    const terminal = isTerminalStatus(owned.status as RunStatus);
    return parseOrValidation(
      () => EventsResponseSchema.parse({ events, nextAfter, hasMore, terminal }),
      "events response",
    );
  }

  function lookupIdempotency(scope: string, key: string): IdempotencyLookupResponse {
    const validScope = parseOrValidation(() => IdempotencyScopeSchema.parse(scope), "idempotency scope");
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
    const validScope = parseOrValidation(() => IdempotencyScopeSchema.parse(scope), "idempotency scope");
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
    throw new RepositoryNotFoundError(`scope ${validScope} not found in session ${session}`);
  }

  function getActiveRun(sessionId: string): RunRow | null {
    const session = requireId(sessionId, "sessionId");
    const row = db
      .prepare(`SELECT * FROM runs WHERE session_id = ? AND status IN ${ACTIVE_STATUSES_SQL} LIMIT 1`)
      .get(session) as RawRun | undefined;
    return row === undefined ? null : parseRunRow(row);
  }

  function getSelection(turnId: string): { runId: string; selectedAt: number } | null {
    const turn = requireId(turnId, "turnId");
    const row = db
      .prepare("SELECT run_id, selected_at FROM turn_selections WHERE turn_id = ?")
      .get(turn) as { run_id: string; selected_at: number } | undefined;
    return row === undefined ? null : { runId: row.run_id, selectedAt: row.selected_at };
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
    getSession,
    getTurn,
    getRun,
    getActiveRun,
    getSelection,
    getHistory,
    getEvents,
    lookupIdempotency,
    lookupIdempotencyForSession,
    requireOwnedRun: (sessionId: string, runId: string): RunRow => parseRunRow(requireOwnedRun(sessionId, runId)),
    requireOwnedTurn: (sessionId: string, turnId: string): TurnRow =>
      parseTurnRow(requireOwnedTurn(sessionId, turnId)),
  };
}

export type KernelRepository = ReturnType<typeof createKernelRepository>;
