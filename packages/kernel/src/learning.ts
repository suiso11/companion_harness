// AV04 learning slice: durable METHODS / HYPOTHESES + anchored EVIDENCE.
//
// Ownership: this module is the ONLY writer of the learning tables
// (`learning_hypotheses`, `learning_evidence`, `learning_hypothesis_events`)
// plus the shared `api_idempotency` rows under the learning scopes. It uses
// the caller-provided single better-sqlite3 connection, BEGIN IMMEDIATE
// transactions, version-CAS mutations, canonical JSON + SHA-256
// domain-separated idempotency hashing, and Zod validation on every JSON
// boundary — the same conventions as the autonomy slice.
//
// Hard boundaries enforced here (no exceptions):
// - Learning NEVER writes purposes, tasks, conflicts, grants, receipts,
//   controls, budgets, permissions, notifications, calendar state, OAuth,
//   or config. There is no such column anywhere in migration 0016, and no
//   such write exists in this module (verified by the consumer tests:
//   rejection evidence changes no purposes/control/grants; success evidence
//   changes no control/budget).
// - Evidence anchors ONLY to EXISTING durable rows (same session): a
//   completed shadow job, a DECIDED (accepted/rejected) conversation
//   proposal, a durable action receipt, or a durable task event. Model
//   free-text claims are never valid sources (unknown source kinds and
//   missing/foreign/undecided rows are rejected, never recorded).
// - A rejected conversation proposal anchors ONLY `refutes` polarity for
//   the proposal-method hypothesis at most (rejected + supports is
//   rejected; accepted + refutes is rejected). Attaching evidence NEVER
//   creates/updates purposes, preferences, permissions, or standing
//   authorization.
// - Status changes ONLY via explicit human transitions (support / refute /
//   retire, CAS-checked). There is NO automatic promotion to fact: success
//   evidence never flips a status, and a `refuted` row is still labeled
//   `refuted` on every read (read DTOs carry kind + status + per-polarity
//   evidence counts, explicitly labeled hypotheses).
// - Derived subgoals trace to user goals via the existing parent-purpose
//   links (tasks) and hypothesis scope. When a parent purpose becomes
//   non-active, `flagLearningReevaluationInTx` marks in-scope hypotheses
//   with the durable `needs_reevaluation` NOTICE in the SAME transaction
//   (never auto-cancel, never auto-resume, never a purpose mutation).
//   Clearing happens only via an explicit human transition.
// - Routine learning writes NO notifications (no make-work) and never
//   touches the stop control. Stopping always wins: no self-preservation
//   overriding stop exists here (this module cannot even read the control).

import {
  type LearningEvidencePolarity,
  type LearningEvidenceSourceKind,
  LearningEvidenceViewSchema,
  type LearningHypothesisKind,
  LearningHypothesisViewSchema,
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

/** CAS version mismatch on a hypothesis mutation (409). */
export class LearningVersionConflictError extends KernelStorageError {
  readonly expectedVersion: number;
  readonly currentVersion: number;

  constructor(expectedVersion: number, currentVersion: number) {
    super(
      "learning_version_conflict",
      `learning version conflict: expected ${expectedVersion}, current ${currentVersion}`,
    );
    this.expectedVersion = expectedVersion;
    this.currentVersion = currentVersion;
  }
}

/** Illegal lifecycle transition or invalid evidence anchor (409). */
export class LearningStateConflictError extends KernelStorageError {
  constructor(message: string) {
    super("learning_state_conflict", message);
  }
}

/* ------------------------------------------------------------------ */
/* Local strict helpers (same conventions as the autonomy slice).       */
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
    db.exec("SAVEPOINT av_learning_nested_tx");
    try {
      const out = fn();
      db.exec("RELEASE av_learning_nested_tx");
      return out;
    } catch (error) {
      try {
        db.exec("ROLLBACK TO av_learning_nested_tx");
      } catch {
        // Best effort: the original error carries the failure.
      }
      try {
        db.exec("RELEASE av_learning_nested_tx");
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

interface RawHypothesis {
  id: string;
  session_id: string;
  scope: string;
  kind: string;
  statement: string;
  status: string;
  version: number;
  origin: string;
  staged: number;
  needs_reevaluation: number;
  source_run_id: string | null;
  source_turn_id: string | null;
  created_at: number;
  updated_at: number;
}

interface EvidenceCounts {
  supports: number;
  refutes: number;
  neutral: number;
}

function readEvidenceCounts(
  db: Database.Database,
  hypothesisId: string,
): EvidenceCounts {
  const rows = db
    .prepare(
      "SELECT polarity, COUNT(*) AS n FROM learning_evidence WHERE hypothesis_id = ? GROUP BY polarity",
    )
    .all(hypothesisId) as { polarity: string; n: number }[];
  const counts: EvidenceCounts = { supports: 0, refutes: 0, neutral: 0 };
  for (const row of rows) {
    if (row.polarity === "supports") counts.supports = row.n;
    else if (row.polarity === "refutes") counts.refutes = row.n;
    else if (row.polarity === "neutral") counts.neutral = row.n;
  }
  return counts;
}

function toHypothesisView(
  row: RawHypothesis,
  counts: EvidenceCounts,
): {
  id: string;
  sessionId: string;
  scope: string;
  kind: LearningHypothesisKind;
  statement: string;
  status: "open" | "supported" | "refuted" | "retired";
  version: number;
  origin: "human" | "model";
  staged: boolean;
  needsReevaluation: boolean;
  evidenceCounts: EvidenceCounts;
  createdAt: number;
  updatedAt: number;
} {
  return parseOrValidation(
    () =>
      LearningHypothesisViewSchema.parse({
        id: row.id,
        sessionId: row.session_id,
        scope: row.scope,
        kind: row.kind,
        statement: row.statement,
        status: row.status,
        version: row.version,
        origin: row.origin,
        staged: row.staged === 1,
        needsReevaluation: row.needs_reevaluation === 1,
        evidenceCounts: counts,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }),
    "stored hypothesis",
  );
}

function readHypothesis(
  db: Database.Database,
  hypothesisId: string,
): RawHypothesis | null {
  return (
    (db
      .prepare("SELECT * FROM learning_hypotheses WHERE id = ?")
      .get(hypothesisId) as RawHypothesis | undefined) ?? null
  );
}

/**
 * Ownership-first hypothesis lookup (foreign ids are 404, never 403).
 */
export function assertOwnedHypothesis(
  db: Database.Database,
  sessionId: string,
  hypothesisId: string,
): RawHypothesis {
  const session = requireId(sessionId, "sessionId");
  const hypothesis = requireId(hypothesisId, "hypothesisId");
  const row = readHypothesis(db, hypothesis);
  if (row === null || row.session_id !== session) {
    throw new RepositoryNotFoundError(
      `hypothesis ${hypothesis} not found in session ${session}`,
    );
  }
  return row;
}

function appendHypothesisEventInTx(
  db: Database.Database,
  hypothesisId: string,
  sessionId: string,
  event:
    | "created"
    | "proposed"
    | "accepted"
    | "rejected"
    | "evidence_attached"
    | "supported"
    | "refuted"
    | "retired"
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
      "SELECT COALESCE(MAX(seq), 0) AS max_seq FROM learning_hypothesis_events WHERE hypothesis_id = ?",
    )
    .get(hypothesisId) as { max_seq: number };
  db.prepare(
    "INSERT INTO learning_hypothesis_events (id, hypothesis_id, session_id, seq, event, from_status, to_status, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    generateId(),
    hypothesisId,
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
/* Creation (human explicit + model proposal-only staging)             */
/* ------------------------------------------------------------------ */

export interface CreateHypothesisInput {
  scope: string;
  kind: LearningHypothesisKind;
  statement: string;
}

export interface AutonomyKeyOptions {
  key: string;
  now?: number;
}

function insertHypothesisInTx(
  db: Database.Database,
  session: string,
  input: CreateHypothesisInput,
  origin: "human" | "model",
  staged: boolean,
  sourceRunId: string | null,
  sourceTurnId: string | null,
  now: number,
): RawHypothesis {
  const id = generateId();
  db.prepare(
    "INSERT INTO learning_hypotheses (id, session_id, scope, kind, statement, status, version, origin, staged, needs_reevaluation, source_run_id, source_turn_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'open', 1, ?, ?, 0, ?, ?, ?, ?)",
  ).run(
    id,
    session,
    input.scope,
    input.kind,
    input.statement,
    origin,
    staged ? 1 : 0,
    sourceRunId,
    sourceTurnId,
    now,
    now,
  );
  appendHypothesisEventInTx(
    db,
    id,
    session,
    origin === "model" ? "proposed" : "created",
    null,
    "open",
    input.statement,
    now,
  );
  const row = readHypothesis(db, id);
  if (row === null) {
    throw new RepositoryNotFoundError(`hypothesis ${id} not found`);
  }
  return row;
}

/**
 * Trusted human creation: scope/kind/statement only. The model can never
 * reach this path (no status/source fields exist on the input).
 */
export function createHypothesis(
  db: Database.Database,
  sessionId: string,
  input: CreateHypothesisInput,
  options: AutonomyKeyOptions,
): {
  status: number;
  body: ReturnType<typeof toHypothesisView>;
  replayed: boolean;
} {
  const session = requireId(sessionId, "sessionId");
  const key = requireKey(options.key);
  const now = nowMs(options.now);
  const scope = `session:${session}:learning`;
  const hash = requestHash(
    IDEMPOTENCY_OPERATIONS.createLearningHypothesis.operation,
    IDEMPOTENCY_OPERATIONS.createLearningHypothesis.schemaVersion,
    {
      sessionId: session,
      scope: input.scope,
      kind: input.kind,
      statement: input.statement,
    },
  );
  return withImmediate(db, () => {
    const existing = toStoredResponse(db, scope, key);
    if (existing !== null) {
      if (existing.requestHash !== hash) {
        throw new IdempotencyConflictError(scope);
      }
      const body = parseOrValidation(
        () => LearningHypothesisViewSchema.parse(existing.responseBody),
        "stored hypothesis body",
      );
      return { status: existing.responseStatus, body, replayed: true };
    }
    requireSession(db, session);
    const row = insertHypothesisInTx(
      db,
      session,
      input,
      "human",
      false,
      null,
      null,
      now,
    );
    const body = toHypothesisView(row, {
      supports: 0,
      refutes: 0,
      neutral: 0,
    });
    storeIdempotentResponse(db, scope, key, hash, 201, body, now);
    return { status: 201, body, replayed: false };
  });
}

export interface StageHypothesisSource {
  sourceRunId: string;
  sourceTurnId: string;
}

/**
 * Model proposal-only staging (server-bound run/turn, like purpose.propose):
 * the source run/turn are resolved by the caller from `ctx.runId` (never
 * model input) and must be the CURRENT ordinary `user_text` turn in the same
 * session. The record is staged pending (`staged = true`, still `open`) and
 * REQUIRES an explicit human accept/reject before it counts as adopted.
 * Staging creates no purpose, task, grant, notification, or control change.
 */
export function stageHypothesisFromModel(
  db: Database.Database,
  sessionId: string,
  input: CreateHypothesisInput,
  source: StageHypothesisSource,
  options: AutonomyKeyOptions,
): {
  status: number;
  body: ReturnType<typeof toHypothesisView>;
  replayed: boolean;
} {
  const session = requireId(sessionId, "sessionId");
  const key = requireKey(options.key);
  const now = nowMs(options.now);
  const scope = `session:${session}:learning-propose`;
  const hash = requestHash(
    IDEMPOTENCY_OPERATIONS.proposeLearningHypothesis.operation,
    IDEMPOTENCY_OPERATIONS.proposeLearningHypothesis.schemaVersion,
    {
      sessionId: session,
      scope: input.scope,
      kind: input.kind,
      statement: input.statement,
      sourceRunId: source.sourceRunId,
      sourceTurnId: source.sourceTurnId,
    },
  );
  return withImmediate(db, () => {
    const existing = toStoredResponse(db, scope, key);
    if (existing !== null) {
      if (existing.requestHash !== hash) {
        throw new IdempotencyConflictError(scope);
      }
      const body = parseOrValidation(
        () => LearningHypothesisViewSchema.parse(existing.responseBody),
        "stored hypothesis body",
      );
      return { status: existing.responseStatus, body, replayed: true };
    }
    requireSession(db, session);
    const runId = requireId(source.sourceRunId, "sourceRunId");
    const turnId = requireId(source.sourceTurnId, "sourceTurnId");
    const run = db
      .prepare("SELECT id, session_id FROM runs WHERE id = ?")
      .get(runId) as { id: string; session_id: string } | undefined;
    const turn = db
      .prepare("SELECT id, session_id FROM turns WHERE id = ?")
      .get(turnId) as { id: string; session_id: string } | undefined;
    if (
      run === undefined ||
      turn === undefined ||
      run.session_id !== session ||
      turn.session_id !== session
    ) {
      throw new RepositoryNotFoundError(
        `source run/turn not found in session ${session}`,
      );
    }
    const row = insertHypothesisInTx(
      db,
      session,
      input,
      "model",
      true,
      runId,
      turnId,
      now,
    );
    const body = toHypothesisView(row, {
      supports: 0,
      refutes: 0,
      neutral: 0,
    });
    storeIdempotentResponse(db, scope, key, hash, 201, body, now);
    return { status: 201, body, replayed: false };
  });
}

/* ------------------------------------------------------------------ */
/* Reads (paged keyset list + owned get + evidence list + events)      */
/* ------------------------------------------------------------------ */

function encodeLearningCursor(createdAt: number, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt, id }), "utf8").toString(
    "base64url",
  );
}

function decodeLearningCursor(cursor: string): {
  createdAt: number;
  id: string;
} {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Number.isInteger((parsed as { createdAt?: unknown }).createdAt) ||
      typeof (parsed as { id?: unknown }).id !== "string" ||
      !isUuidV4((parsed as { id: string }).id)
    ) {
      throw new Error("bad cursor shape");
    }
    return {
      createdAt: (parsed as { createdAt: number }).createdAt,
      id: (parsed as { id: string }).id,
    };
  } catch (error) {
    if (error instanceof KernelStorageError) {
      throw error;
    }
    throw new RepositoryValidationError("invalid learning cursor");
  }
}

export interface ListHypothesesQuery {
  limit?: number;
  cursor?: string;
  scope?: string;
  status?: "open" | "supported" | "refuted" | "retired";
  kind?: LearningHypothesisKind;
}

export function listHypotheses(
  db: Database.Database,
  sessionId: string,
  query: ListHypothesesQuery = {},
): {
  items: ReturnType<typeof toHypothesisView>[];
  nextCursor: string | null;
  hasMore: boolean;
} {
  const session = requireId(sessionId, "sessionId");
  requireSession(db, session);
  const capped = Math.min(Math.max(query.limit ?? 50, 1), 100);
  if (
    query.status !== undefined &&
    query.status !== "open" &&
    query.status !== "supported" &&
    query.status !== "refuted" &&
    query.status !== "retired"
  ) {
    throw new RepositoryValidationError(
      "hypothesis status must be open, supported, refuted, or retired",
    );
  }
  if (query.scope !== undefined) {
    // Pushed into SQL (covered by idx_learning_hypotheses_scope): fetching
    // only the requested scope means an older row in that scope is never
    // hidden behind a newer other-scope page.
    if (
      typeof query.scope !== "string" ||
      query.scope.length === 0 ||
      query.scope.length > 128
    ) {
      throw new RepositoryValidationError(
        "hypothesis scope must be 1..128 characters",
      );
    }
  }
  if (
    query.kind !== undefined &&
    query.kind !== "method" &&
    query.kind !== "hypothesis"
  ) {
    throw new RepositoryValidationError(
      "hypothesis kind must be method or hypothesis",
    );
  }
  const bound =
    query.cursor === undefined ? null : decodeLearningCursor(query.cursor);
  const clauses = ["session_id = ?"];
  const args: (string | number)[] = [session];
  if (query.scope !== undefined) {
    clauses.push("scope = ?");
    args.push(query.scope);
  }
  if (query.status !== undefined) {
    clauses.push("status = ?");
    args.push(query.status);
  }
  if (query.kind !== undefined) {
    clauses.push("kind = ?");
    args.push(query.kind);
  }
  if (bound !== null) {
    clauses.push("(created_at < ? OR (created_at = ? AND id > ?))");
    args.push(bound.createdAt, bound.createdAt, bound.id);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const rows = db
    .prepare(
      `SELECT * FROM learning_hypotheses ${where} ORDER BY created_at DESC, id ASC LIMIT ?`,
    )
    .all(...args, capped + 1) as RawHypothesis[];
  const hasMore = rows.length > capped;
  const page = hasMore ? rows.slice(0, capped) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map((row) =>
      toHypothesisView(row, readEvidenceCounts(db, row.id)),
    ),
    nextCursor:
      hasMore && last !== undefined
        ? encodeLearningCursor(last.created_at, last.id)
        : null,
    hasMore,
  };
}

export function getHypothesis(
  db: Database.Database,
  sessionId: string,
  hypothesisId: string,
): ReturnType<typeof toHypothesisView> {
  const owned = assertOwnedHypothesis(db, sessionId, hypothesisId);
  return toHypothesisView(owned, readEvidenceCounts(db, owned.id));
}

export interface ListEvidenceQuery {
  limit?: number;
  cursor?: string;
}

export function listHypothesisEvidence(
  db: Database.Database,
  sessionId: string,
  hypothesisId: string,
  query: ListEvidenceQuery = {},
): {
  hypothesisId: string;
  items: {
    id: string;
    hypothesisId: string;
    sessionId: string;
    polarity: LearningEvidencePolarity;
    sourceKind: LearningEvidenceSourceKind;
    sourceId: string;
    note: string | null;
    createdAt: number;
  }[];
  nextCursor: string | null;
  hasMore: boolean;
} {
  const owned = assertOwnedHypothesis(db, sessionId, hypothesisId);
  const capped = Math.min(Math.max(query.limit ?? 50, 1), 100);
  const bound =
    query.cursor === undefined ? null : decodeLearningCursor(query.cursor);
  const clauses = ["hypothesis_id = ?"];
  const args: (string | number)[] = [owned.id];
  if (bound !== null) {
    // Oldest-first keyset: strictly after (created_at, id).
    clauses.push("(created_at > ? OR (created_at = ? AND id > ?))");
    args.push(bound.createdAt, bound.createdAt, bound.id);
  }
  const rows = db
    .prepare(
      `SELECT * FROM learning_evidence WHERE ${clauses.join(" AND ")} ORDER BY created_at ASC, id ASC LIMIT ?`,
    )
    .all(...args, capped + 1) as {
    id: string;
    hypothesis_id: string;
    session_id: string;
    polarity: string;
    source_kind: string;
    source_id: string;
    note: string | null;
    created_at: number;
  }[];
  const hasMore = rows.length > capped;
  const page = hasMore ? rows.slice(0, capped) : rows;
  const last = page[page.length - 1];
  return {
    hypothesisId: owned.id,
    items: page.map((row) =>
      parseOrValidation(
        () =>
          LearningEvidenceViewSchema.parse({
            id: row.id,
            hypothesisId: row.hypothesis_id,
            sessionId: row.session_id,
            polarity: row.polarity,
            sourceKind: row.source_kind,
            sourceId: row.source_id,
            note: row.note,
            createdAt: row.created_at,
          }),
        "stored evidence",
      ),
    ),
    nextCursor:
      hasMore && last !== undefined
        ? encodeLearningCursor(last.created_at, last.id)
        : null,
    hasMore,
  };
}

export function listHypothesisEvents(
  db: Database.Database,
  sessionId: string,
  hypothesisId: string,
): {
  hypothesisId: string;
  events: {
    seq: number;
    event: string;
    fromStatus: string | null;
    toStatus: string;
    createdAt: number;
  }[];
} {
  const owned = assertOwnedHypothesis(db, sessionId, hypothesisId);
  const rows = db
    .prepare(
      "SELECT seq, event, from_status, to_status, created_at FROM learning_hypothesis_events WHERE hypothesis_id = ? ORDER BY seq ASC",
    )
    .all(owned.id) as {
    seq: number;
    event: string;
    from_status: string | null;
    to_status: string;
    created_at: number;
  }[];
  return {
    hypothesisId: owned.id,
    events: rows.map((row) => ({
      seq: row.seq,
      event: row.event,
      fromStatus: row.from_status,
      toStatus: row.to_status,
      createdAt: row.created_at,
    })),
  };
}

/* ------------------------------------------------------------------ */
/* Human transitions (support / refute / retire — CAS, no promotion)   */
/* ------------------------------------------------------------------ */

export type HypothesisTransition = "support" | "refute" | "retire" | "reaffirm";

const TRANSITION_EVENT: Record<
  HypothesisTransition,
  "supported" | "refuted" | "retired" | "reaffirmed"
> = {
  support: "supported",
  refute: "refuted",
  retire: "retired",
  reaffirm: "reaffirmed",
};

const TRANSITION_TARGET: Record<
  Exclude<HypothesisTransition, "reaffirm">,
  string
> = {
  support: "supported",
  refute: "refuted",
  retire: "retired",
};

function allowedTransition(
  from: string,
  transition: HypothesisTransition,
): boolean {
  if (transition === "reaffirm") {
    // Keeps the current status; the needs_reevaluation=1 requirement is
    // checked separately (a reaffirm without a pending notice is rejected).
    return from === "open" || from === "supported" || from === "refuted";
  }
  if (transition === "support") {
    return from === "open";
  }
  if (transition === "refute") {
    return from === "open" || from === "supported";
  }
  return from === "open" || from === "supported" || from === "refuted";
}

/**
 * Trusted human transition. CAS-checked; staged proposals must be
 * accepted/rejected first (never transitioned directly). Clearing a
 * `needs_reevaluation` notice happens ONLY here (same transaction), never
 * automatically. Success evidence never reaches this path (evidence attach
 * never mutates status), so no promotion to fact is possible.
 */
export function transitionHypothesis(
  db: Database.Database,
  sessionId: string,
  hypothesisId: string,
  transition: HypothesisTransition,
  expectedVersion: number,
  options: AutonomyKeyOptions,
): {
  status: number;
  body: ReturnType<typeof toHypothesisView>;
  replayed: boolean;
} {
  const session = requireId(sessionId, "sessionId");
  const hypothesis = requireId(hypothesisId, "hypothesisId");
  const key = requireKey(options.key);
  const now = nowMs(options.now);
  const op = IDEMPOTENCY_OPERATIONS.transitionLearningHypothesis;
  const hash = requestHash(op.operation, op.schemaVersion, {
    sessionId: session,
    hypothesisId: hypothesis,
    transition,
    expectedVersion,
  });
  const scope = `learning:${hypothesis}:transition:${transition}`;
  return withImmediate(db, () => {
    const existing = toStoredResponse(db, scope, key);
    if (existing !== null) {
      if (existing.requestHash !== hash) {
        throw new IdempotencyConflictError(scope);
      }
      const body = parseOrValidation(
        () => LearningHypothesisViewSchema.parse(existing.responseBody),
        "stored hypothesis body",
      );
      return { status: existing.responseStatus, body, replayed: true };
    }
    const row = assertOwnedHypothesis(db, session, hypothesis);
    if (row.version !== expectedVersion) {
      throw new LearningVersionConflictError(expectedVersion, row.version);
    }
    if (row.staged === 1) {
      throw new LearningStateConflictError(
        `hypothesis ${row.id} is staged and must be accepted or rejected first`,
      );
    }
    if (!allowedTransition(row.status, transition)) {
      throw new LearningStateConflictError(
        `hypothesis ${row.id} is ${row.status} and cannot be ${transition}ed`,
      );
    }
    // Explicit human reaffirm: keeps the current status, clears a pending
    // `needs_reevaluation` notice (CAS-checked like every transition), and
    // is allowed ONLY while the notice is set. Never mutates purposes,
    // tasks, controls, grants, or notifications.
    if (transition === "reaffirm" && row.needs_reevaluation !== 1) {
      throw new LearningStateConflictError(
        `hypothesis ${row.id} has no pending reevaluation to reaffirm`,
      );
    }
    const target =
      transition === "reaffirm" ? row.status : TRANSITION_TARGET[transition];
    const event = TRANSITION_EVENT[transition];
    const wasFlagged = row.needs_reevaluation === 1;
    const moved = db
      .prepare(
        "UPDATE learning_hypotheses SET status = ?, version = ?, updated_at = ?, needs_reevaluation = 0 WHERE id = ? AND status = ? AND version = ?",
      )
      .run(target, row.version + 1, now, row.id, row.status, row.version);
    if (moved.changes !== 1) {
      throw new LearningVersionConflictError(expectedVersion, row.version);
    }
    appendHypothesisEventInTx(
      db,
      row.id,
      session,
      event,
      row.status,
      target,
      null,
      now,
    );
    // A reaffirm's own event already records the explicit human clearing;
    // other transitions that clear a pending notice append the audit event.
    if (wasFlagged && transition !== "reaffirm") {
      appendHypothesisEventInTx(
        db,
        row.id,
        session,
        "reevaluation_cleared",
        target,
        target,
        "explicit human transition",
        now,
      );
    }
    const current = readHypothesis(db, row.id);
    if (current === null) {
      throw new RepositoryNotFoundError(`hypothesis ${row.id} not found`);
    }
    const body = toHypothesisView(current, readEvidenceCounts(db, row.id));
    storeIdempotentResponse(db, scope, key, hash, 200, body, now);
    return { status: 200, body, replayed: false };
  });
}

/* ------------------------------------------------------------------ */
/* Staged accept / reject (human only)                                 */
/* ------------------------------------------------------------------ */

function decideStagedHypothesis(
  db: Database.Database,
  decision: "accept" | "reject",
  sessionId: string,
  hypothesisId: string,
  expectedVersion: number,
  options: AutonomyKeyOptions,
): {
  status: number;
  body: ReturnType<typeof toHypothesisView>;
  replayed: boolean;
} {
  const session = requireId(sessionId, "sessionId");
  const hypothesis = requireId(hypothesisId, "hypothesisId");
  const key = requireKey(options.key);
  const now = nowMs(options.now);
  const op = IDEMPOTENCY_OPERATIONS.decideLearningHypothesis;
  const hash = requestHash(op.operation, op.schemaVersion, {
    sessionId: session,
    hypothesisId: hypothesis,
    decision,
    expectedVersion,
  });
  const scope = `learning:${hypothesis}:decide:${decision}`;
  return withImmediate(db, () => {
    const existing = toStoredResponse(db, scope, key);
    if (existing !== null) {
      if (existing.requestHash !== hash) {
        throw new IdempotencyConflictError(scope);
      }
      const body = parseOrValidation(
        () => LearningHypothesisViewSchema.parse(existing.responseBody),
        "stored hypothesis body",
      );
      return { status: existing.responseStatus, body, replayed: true };
    }
    const row = assertOwnedHypothesis(db, session, hypothesis);
    if (row.version !== expectedVersion) {
      throw new LearningVersionConflictError(expectedVersion, row.version);
    }
    if (row.staged !== 1) {
      throw new LearningStateConflictError(
        `hypothesis ${row.id} is not staged (origin ${row.origin})`,
      );
    }
    if (decision === "accept") {
      const moved = db
        .prepare(
          "UPDATE learning_hypotheses SET staged = 0, version = ?, updated_at = ? WHERE id = ? AND staged = 1 AND version = ?",
        )
        .run(row.version + 1, now, row.id, row.version);
      if (moved.changes !== 1) {
        throw new LearningVersionConflictError(expectedVersion, row.version);
      }
      appendHypothesisEventInTx(
        db,
        row.id,
        session,
        "accepted",
        "open",
        "open",
        null,
        now,
      );
    } else {
      const moved = db
        .prepare(
          "UPDATE learning_hypotheses SET staged = 0, status = 'retired', version = ?, updated_at = ? WHERE id = ? AND staged = 1 AND version = ?",
        )
        .run(row.version + 1, now, row.id, row.version);
      if (moved.changes !== 1) {
        throw new LearningVersionConflictError(expectedVersion, row.version);
      }
      appendHypothesisEventInTx(
        db,
        row.id,
        session,
        "rejected",
        "open",
        "retired",
        null,
        now,
      );
    }
    const current = readHypothesis(db, row.id);
    if (current === null) {
      throw new RepositoryNotFoundError(`hypothesis ${row.id} not found`);
    }
    const body = toHypothesisView(current, readEvidenceCounts(db, row.id));
    storeIdempotentResponse(db, scope, key, hash, 200, body, now);
    return { status: 200, body, replayed: false };
  });
}

export function acceptStagedHypothesis(
  db: Database.Database,
  sessionId: string,
  hypothesisId: string,
  expectedVersion: number,
  options: AutonomyKeyOptions,
): {
  status: number;
  body: ReturnType<typeof toHypothesisView>;
  replayed: boolean;
} {
  return decideStagedHypothesis(
    db,
    "accept",
    sessionId,
    hypothesisId,
    expectedVersion,
    options,
  );
}

export function rejectStagedHypothesis(
  db: Database.Database,
  sessionId: string,
  hypothesisId: string,
  expectedVersion: number,
  options: AutonomyKeyOptions,
): {
  status: number;
  body: ReturnType<typeof toHypothesisView>;
  replayed: boolean;
} {
  return decideStagedHypothesis(
    db,
    "reject",
    sessionId,
    hypothesisId,
    expectedVersion,
    options,
  );
}

/* ------------------------------------------------------------------ */
/* Evidence attach (human only; durable anchors; polarity rules)        */
/* ------------------------------------------------------------------ */

export interface AttachEvidenceInput {
  polarity: LearningEvidencePolarity;
  sourceKind: LearningEvidenceSourceKind;
  sourceId: string;
  note?: string;
}

/**
 * Validate that the anchored source is an EXISTING durable row in the same
 * session with a terminal/decided state — and enforce the polarity rules:
 * a REJECTED conversation proposal anchors ONLY `refutes`; an ACCEPTED one
 * anchors NEVER `refutes`. Unknown source kinds, missing rows, foreign
 * rows, and undecided proposals are rejected (never recorded).
 */
function requireAnchoredSourceInTx(
  db: Database.Database,
  session: string,
  sourceKind: LearningEvidenceSourceKind,
  sourceId: string,
  polarity: LearningEvidencePolarity,
): void {
  const id = requireId(sourceId, "sourceId");
  if (sourceKind === "shadow_job") {
    const row = db
      .prepare("SELECT session_id, status FROM shadow_jobs WHERE id = ?")
      .get(id) as { session_id: string; status: string } | undefined;
    if (row === undefined || row.session_id !== session) {
      throw new RepositoryNotFoundError(
        `shadow job ${id} not found in session ${session}`,
      );
    }
    if (row.status !== "completed") {
      throw new LearningStateConflictError(
        `shadow job ${id} is ${row.status} (only completed jobs anchor evidence)`,
      );
    }
    return;
  }
  if (sourceKind === "conversation_proposal") {
    const row = db
      .prepare(
        "SELECT session_id, status FROM conversation_proposals WHERE id = ?",
      )
      .get(id) as { session_id: string; status: string } | undefined;
    if (row === undefined || row.session_id !== session) {
      throw new RepositoryNotFoundError(
        `conversation proposal ${id} not found in session ${session}`,
      );
    }
    // A rejected proposal is `refutes` for the proposal-method hypothesis
    // at most: rejected + supports would launder a rejection into an
    // endorsement, and accepted + refutes would launder an adoption into a
    // refutation. Both are rejected; neither creates permissions or goals.
    if (row.status === "rejected" && polarity !== "refutes") {
      throw new LearningStateConflictError(
        `rejected proposal ${id} anchors only refutes polarity`,
      );
    }
    if (row.status === "accepted" && polarity === "refutes") {
      throw new LearningStateConflictError(
        `accepted proposal ${id} never anchors refutes polarity`,
      );
    }
    if (row.status !== "accepted" && row.status !== "rejected") {
      throw new LearningStateConflictError(
        `conversation proposal ${id} is ${row.status} (only decided proposals anchor evidence)`,
      );
    }
    return;
  }
  if (sourceKind === "action_receipt") {
    const row = db
      .prepare(
        "SELECT session_id, outcome FROM action_receipts WHERE execution_id = ?",
      )
      .get(id) as { session_id: string; outcome: string } | undefined;
    if (row === undefined || row.session_id !== session) {
      throw new RepositoryNotFoundError(
        `action receipt ${id} not found in session ${session}`,
      );
    }
    return;
  }
  const row = db
    .prepare("SELECT session_id FROM autonomy_task_events WHERE id = ?")
    .get(id) as { session_id: string } | undefined;
  if (row === undefined || row.session_id !== session) {
    throw new RepositoryNotFoundError(
      `task event ${id} not found in session ${session}`,
    );
  }
}

/**
 * Trusted human evidence attach. NEVER mutates status, purposes, tasks,
 * controls, grants, or budgets: it appends exactly one evidence row plus one
 * `evidence_attached` history event. Attaching to a staged or retired
 * hypothesis is rejected.
 */
export function attachEvidence(
  db: Database.Database,
  sessionId: string,
  hypothesisId: string,
  input: AttachEvidenceInput,
  options: AutonomyKeyOptions,
): {
  status: number;
  body: {
    id: string;
    hypothesisId: string;
    sessionId: string;
    polarity: LearningEvidencePolarity;
    sourceKind: LearningEvidenceSourceKind;
    sourceId: string;
    note: string | null;
    createdAt: number;
  };
  replayed: boolean;
} {
  const session = requireId(sessionId, "sessionId");
  const hypothesis = requireId(hypothesisId, "hypothesisId");
  const key = requireKey(options.key);
  const now = nowMs(options.now);
  const op = IDEMPOTENCY_OPERATIONS.attachLearningEvidence;
  const hash = requestHash(op.operation, op.schemaVersion, {
    sessionId: session,
    hypothesisId: hypothesis,
    polarity: input.polarity,
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    note: input.note ?? null,
  });
  const scope = `learning:${hypothesis}:evidence`;
  return withImmediate(db, () => {
    const existing = toStoredResponse(db, scope, key);
    if (existing !== null) {
      if (existing.requestHash !== hash) {
        throw new IdempotencyConflictError(scope);
      }
      const body = parseOrValidation(
        () => LearningEvidenceViewSchema.parse(existing.responseBody),
        "stored evidence body",
      );
      return { status: existing.responseStatus, body, replayed: true };
    }
    const row = assertOwnedHypothesis(db, session, hypothesis);
    if (row.staged === 1) {
      throw new LearningStateConflictError(
        `hypothesis ${row.id} is staged and must be accepted first`,
      );
    }
    if (row.status === "retired") {
      throw new LearningStateConflictError(
        `hypothesis ${row.id} is retired and takes no new evidence`,
      );
    }
    requireAnchoredSourceInTx(
      db,
      session,
      input.sourceKind,
      input.sourceId,
      input.polarity,
    );
    const id = generateId();
    db.prepare(
      "INSERT INTO learning_evidence (id, hypothesis_id, session_id, polarity, source_kind, source_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      id,
      row.id,
      session,
      input.polarity,
      input.sourceKind,
      input.sourceId,
      input.note ?? null,
      now,
    );
    appendHypothesisEventInTx(
      db,
      row.id,
      session,
      "evidence_attached",
      row.status,
      row.status,
      `${input.polarity}:${input.sourceKind}`,
      now,
    );
    const body = parseOrValidation(
      () =>
        LearningEvidenceViewSchema.parse({
          id,
          hypothesisId: row.id,
          sessionId: session,
          polarity: input.polarity,
          sourceKind: input.sourceKind,
          sourceId: input.sourceId,
          note: input.note ?? null,
          createdAt: now,
        }),
      "evidence body",
    );
    storeIdempotentResponse(db, scope, key, hash, 201, body, now);
    return { status: 201, body, replayed: false };
  });
}

/* ------------------------------------------------------------------ */
/* Revocation re-evaluation notice (same-TX hook for autonomy.ts)       */
/* ------------------------------------------------------------------ */

/**
 * Flag every in-scope non-terminal hypothesis with the durable
 * `needs_reevaluation` NOTICE plus an `reevaluation_flagged` history event.
 * Called by autonomy.ts INSIDE the revoke/supersede transaction (same TX as
 * the parent transition + dependent task holds), so the flag and the parent
 * state change are atomic (idempotent: already-flagged rows are skipped).
 *
 * The flag ALSO bumps `version` under a CAS guard (`AND version = ? AND
 * needs_reevaluation = 0`): a human holding a stale loaded version can no
 * longer transition over the notice — the stale CAS fails with
 * `LearningVersionConflictError` instead of silently clearing the notice
 * (the transition path clears the flag only when it wins the CAS).
 *
 * This NEVER mutates a purpose, NEVER cancels/resumes a task, NEVER writes
 * a notification, and NEVER touches the stop control: it is a visible
 * notice only (human decides). Callers MUST treat a missing-table error as
 * a pre-0016 database and skip (best-effort bridge, same pattern as the
 * shadow-durability bridge in autonomy.ts).
 */
export function flagLearningReevaluationInTx(
  db: Database.Database,
  sessionId: string,
  scope: string,
  reason: string,
  now: number,
): void {
  const rows = db
    .prepare(
      "SELECT id, status, version FROM learning_hypotheses WHERE session_id = ? AND scope = ? AND status IN ('open','supported') AND needs_reevaluation = 0",
    )
    .all(sessionId, scope) as { id: string; status: string; version: number }[];
  for (const row of rows) {
    const moved = db
      .prepare(
        "UPDATE learning_hypotheses SET needs_reevaluation = 1, version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND needs_reevaluation = 0",
      )
      .run(now, row.id, row.version);
    if (moved.changes !== 1) {
      continue;
    }
    appendHypothesisEventInTx(
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
