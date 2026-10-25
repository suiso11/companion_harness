// AGORA participation: fixed-host public reads + exact-content human approval
// for every public write.
//
// Safety model:
// - Transport destinations are fixed by operation. There is no generic URL,
//   no redirect following, and no model-callable send/approve surface.
// - A registration/thread/reply is durable as a pending proposal. Nothing is
//   sent until an operator approves the EXACT payload hash, and every
//   approval is consumed at most once (approved -> sending -> terminal).
// - Writes share one durable per-store interval (>=10s by default); the
//   interval is recorded before the request so a crash/ambiguous outcome
//   cannot lead to a blind immediate resend. The interval is NOT per API key:
//   all operations against this store share the same `last_write_at`.
// - An ambiguous outcome (transport throw, redirect, 5xx, unparseable
//   registration response) is terminal `unknown`: it can never be resent.
//   A 4xx is terminal `failed`. In both cases the operator must create a NEW
//   proposal to try again.
// - The API key is host-held (env) or stored privately from a successful
//   registration response. It is never returned by list/show/send, never
//   logged, and never placed in a proposal.

import type Database from "better-sqlite3";
import { canonicalJsonString, generateId, sha256Hex } from "./canonical.js";
import {
  AgoraPayloadHashMismatchError,
  AgoraProposalNotFoundError,
  AgoraProposalStateConflictError,
  RepositoryValidationError,
} from "./errors.js";
import {
  closePrivateSqlite,
  hardenPrivateSidecars,
  openPrivateSqlite,
} from "./private_sqlite.js";

export const AGORA_HOST = "agora.grimoire-fio.workers.dev" as const;
export const AGORA_BASE_URL = `https://${AGORA_HOST}` as const;
export const AGORA_HELLO_PATH = "/api/hello" as const;
export const AGORA_REGISTER_PATH = "/api/register" as const;
export const AGORA_THREADS_PATH = "/api/threads" as const;
export const AGORA_THREAD_PAGE_PREFIX = "/t/" as const;
export const AGORA_MIN_WRITE_INTERVAL_MS = 10_000;
export const AGORA_PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const AGORA_APPROVED_TTL_MS = 60 * 60 * 1000;
// A live send holds this lease. Another process never converts a `sending`
// row to terminal `unknown` while the lease is valid, so opening a second
// CLI cannot clobber an in-flight operation. A crashed send is recovered as
// ambiguous (`unknown`) only after the lease expires; it is never retried.
export const AGORA_SEND_LEASE_MS = 5 * 60 * 1000;
export const AGORA_MAX_NAME_CP = 100;
export const AGORA_MAX_DESCRIPTION_CP = 2000;
export const AGORA_MAX_TITLE_CP = 200;
export const AGORA_MAX_BODY_CP = 10_000;
export const AGORA_MAX_READ_TEXT_CP = 20_000;
export const AGORA_MAX_RESPONSE_BYTES_DEFAULT = 256 * 1024;
export const AGORA_TIMEOUT_MS_DEFAULT = 15_000;

/** Suggested registration draft. It is NEVER sent automatically. */
export const AGORA_SUGGESTED_REGISTRATION = Object.freeze({
  name: "Companion Harness",
  description:
    "A local-first companion assistant that shares concise, human-reviewed technical notes and lessons. Public posts are authored only after explicit operator approval of the exact content.",
});

export type AgoraOperation = "register" | "thread" | "reply";
/**
 * Durable provenance of the human approval that authorized a proposal.
 * NULL is only possible for rows created before provenance existed; those
 * legacy approvals keep operator semantics (see `approvalAllowsModelSend`).
 */
export type AgoraApprovalSource = "operator" | "browser";
/** Who is attempting a send. Never model-supplied: the tool hard-codes it. */
export type AgoraSendActor = "model" | "human";
export type AgoraProposalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "sending"
  | "sent"
  | "unknown"
  | "failed";

export interface AgoraRegisterPayload {
  readonly name: string;
  readonly description: string;
}
export interface AgoraThreadPayload {
  readonly title: string;
  readonly body: string;
}
export interface AgoraReplyPayload {
  readonly threadId: string;
  readonly body: string;
}
export type AgoraPayload =
  | AgoraRegisterPayload
  | AgoraThreadPayload
  | AgoraReplyPayload;

export interface AgoraProposalRow {
  readonly id: string;
  readonly operation: AgoraOperation;
  readonly payload: AgoraPayload;
  readonly payloadHash: string;
  readonly status: AgoraProposalStatus;
  /**
   * How the row was approved. `operator` (the local exact-hash CLI) permits a
   * later model-requested send; `browser` only authorizes a human Send click.
   * NULL is a legacy approval and is treated as `operator`.
   */
  readonly approvalSource: AgoraApprovalSource | null;
  /**
   * Owning conversation session for a model-created proposal, or null for an
   * operator-created (CLI) proposal. Model tools only ever see/send rows with
   * their own non-null session; null rows are operator-only.
   */
  readonly sessionId: string | null;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly decidedAt: number | null;
  readonly consumedAt: number | null;
  readonly httpStatus: number | null;
  readonly resultCode: string | null;
  /** Sanitized thread id parsed from the actual successful API response. */
  readonly resultThreadId: string | null;
  /** Canonical AGORA thread URL, only when verified from that response. */
  readonly resultUrl: string | null;
}

export interface AgoraTransportGetResult {
  readonly status: number;
  readonly text: string;
  readonly contentType: string;
}
export interface AgoraTransportPostResult {
  readonly status: number;
  readonly text: string;
}
export interface AgoraTransport {
  get(
    path: string,
    options?: { signal?: AbortSignal },
  ): Promise<AgoraTransportGetResult>;
  post(
    path: string,
    body: unknown,
    headers: Readonly<Record<string, string>>,
    options?: { signal?: AbortSignal },
  ): Promise<AgoraTransportPostResult>;
}

export interface AgoraService {
  readonly suggestedRegistration: typeof AGORA_SUGGESTED_REGISTRATION;
  propose(input: {
    operation: AgoraOperation;
    payload: unknown;
    now?: number;
    /** Model tools bind their conversation session; CLI omits it. */
    sessionId?: string | null;
  }): AgoraProposalRow;
  list(status?: AgoraProposalStatus): AgoraProposalRow[];
  /** Only proposals owned by this exact session (never operator rows). */
  listForSession(
    sessionId: string,
    status?: AgoraProposalStatus,
  ): AgoraProposalRow[];
  show(id: string): AgoraProposalRow;
  /** Session-scoped lookup: a different owner is reported as not found. */
  showForSession(id: string, sessionId: string): AgoraProposalRow;
  approve(
    id: string,
    expectedHash: string,
    now?: number,
  ): AgoraProposalRow;
  /** Session-owned approve: a mismatch/foreign row is a fixed not-found. */
  approveForSession(
    id: string,
    expectedHash: string,
    sessionId: string,
    now?: number,
  ): AgoraProposalRow;
  reject(id: string, now?: number): AgoraProposalRow;
  /** Session-owned exact-hash reject (stale hash refuses before mutation). */
  rejectForSession(
    id: string,
    expectedHash: string,
    sessionId: string,
    now?: number,
  ): AgoraProposalRow;
  readHello(options?: { signal?: AbortSignal }): Promise<{
    status: number;
    untrusted: true;
    body: unknown;
  }>;
  readThread(
    threadId: string,
    options?: { signal?: AbortSignal },
  ): Promise<{
    status: number;
    untrusted: true;
    threadId: string;
    body: string;
  }>;
  send(
    id: string,
    expectedHash: string,
    options?: {
      signal?: AbortSignal;
      now?: number;
      /** When set, the proposal MUST be owned by this exact session. */
      sessionId?: string;
      /**
       * Trusted caller identity, never model input. Defaults to `model` for
       * session-bound calls and `human` otherwise; the model tool and the
       * human HTTP/CLI routes set it explicitly.
       */
      actor?: AgoraSendActor;
    },
  ): Promise<
    | { kind: "sent" | "unknown" | "failed"; proposal: AgoraProposalRow }
    | { kind: "throttled"; retryAfterMs: number }
    | { kind: "key_missing" }
  >;
  close(): void;
}

export interface AgoraStore extends AgoraService {
  readonly path: string;
  beginSend(input: {
    id: string;
    expectedHash: string;
    now: number;
    sessionId?: string;
    actor?: AgoraSendActor;
  }):
    | { kind: "sending"; proposal: AgoraProposalRow }
    | { kind: "throttled"; retryAfterMs: number };
  finishSend(input: {
    id: string;
    outcome: "sent" | "unknown" | "failed";
    httpStatus: number | null;
    resultCode: string;
    apiKey?: string;
    resultThreadId?: string | null;
    resultUrl?: string | null;
    now: number;
  }): AgoraProposalRow;
  getCredential(): string | null;
  setCredential(apiKey: string, now?: number): void;
  getLastWriteAt(): number | null;
}

export interface AgoraStoreOptions {
  readonly path: string;
  readonly clock?: { now(): number };
  readonly minWriteIntervalMs?: number;
  readonly hostApiKey?: string | null;
  readonly transport: AgoraTransport;
}

const OPERATIONS = new Set<AgoraOperation>(["register", "thread", "reply"]);
const STATUSES = new Set<AgoraProposalStatus>([
  "pending",
  "approved",
  "rejected",
  "sending",
  "sent",
  "unknown",
  "failed",
]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const THREAD_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const RESULT_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

function countCodePoints(value: string): number {
  return Array.from(value).length;
}

function requireText(
  value: unknown,
  min: number,
  max: number,
  what: string,
): string {
  if (
    typeof value !== "string" ||
    countCodePoints(value) < min ||
    countCodePoints(value) > max ||
    value.includes("\0")
  ) {
    throw new RepositoryValidationError(`${what} is invalid`);
  }
  for (const unit of value) {
    const code = unit.codePointAt(0) ?? 0;
    if (
      (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
      (code >= 0x7f && code <= 0x9f)
    ) {
      throw new RepositoryValidationError(`${what} is invalid`);
    }
  }
  return value;
}

function requireOperation(value: unknown): AgoraOperation {
  if (typeof value !== "string" || !OPERATIONS.has(value as AgoraOperation)) {
    throw new RepositoryValidationError("agora operation is invalid");
  }
  return value as AgoraOperation;
}

function requireStatus(value: unknown): AgoraProposalStatus {
  if (typeof value !== "string" || !STATUSES.has(value as AgoraProposalStatus)) {
    throw new RepositoryValidationError("agora status is invalid");
  }
  return value as AgoraProposalStatus;
}

function requireId(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new RepositoryValidationError("agora proposal id is invalid");
  }
  return value;
}

function requireHash(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new RepositoryValidationError("agora payload hash is invalid");
  }
  return value;
}

function requireCredential(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 4096 ||
    value.includes("\0")
  ) {
    throw new RepositoryValidationError("agora credential is invalid");
  }
  return value;
}

function requireNow(value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new RepositoryValidationError("agora clock is invalid");
  }
  return value;
}

function requireThreadId(value: unknown): string {
  if (typeof value !== "string" || !THREAD_ID_PATTERN.test(value)) {
    throw new RepositoryValidationError("agora thread id is invalid");
  }
  return value;
}

function requireApprovalSource(
  value: unknown,
): AgoraApprovalSource | null {
  if (value === null || value === undefined) return null;
  if (value === "operator" || value === "browser") return value;
  throw new RepositoryValidationError("agora approval source is invalid");
}

function requireActor(value: unknown): AgoraSendActor {
  if (value === "model" || value === "human") return value;
  throw new RepositoryValidationError("agora send actor is invalid");
}

function requireSessionId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 256 ||
    value.includes("\0")
  ) {
    throw new RepositoryValidationError("agora session id is invalid");
  }
  return value;
}

function requireExactKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const set = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!set.has(key)) {
      throw new RepositoryValidationError("agora payload is invalid");
    }
  }
  for (const key of allowed) {
    if (!(key in record)) {
      throw new RepositoryValidationError("agora payload is invalid");
    }
  }
}

function validatePayload(
  operation: AgoraOperation,
  payload: unknown,
): AgoraPayload {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new RepositoryValidationError("agora payload is invalid");
  }
  const record = payload as Record<string, unknown>;
  if (operation === "register") {
    requireExactKeys(record, ["name", "description"]);
    return Object.freeze({
      name: requireText(record.name, 1, AGORA_MAX_NAME_CP, "agora name"),
      description: requireText(
        record.description,
        1,
        AGORA_MAX_DESCRIPTION_CP,
        "agora description",
      ),
    });
  }
  if (operation === "thread") {
    requireExactKeys(record, ["title", "body"]);
    return Object.freeze({
      title: requireText(record.title, 1, AGORA_MAX_TITLE_CP, "agora title"),
      body: requireText(record.body, 1, AGORA_MAX_BODY_CP, "agora body"),
    });
  }
  requireExactKeys(record, ["threadId", "body"]);
  return Object.freeze({
    threadId: requireThreadId(record.threadId),
    body: requireText(record.body, 1, AGORA_MAX_BODY_CP, "agora body"),
  });
}

/** Exact payload hash shown by the CLI and bound by approve/send. */
export function agoraPayloadHash(
  operation: AgoraOperation,
  payload: unknown,
): string {
  const op = requireOperation(operation);
  return sha256Hex(
    canonicalJsonString({
      version: 1,
      operation: op,
      payload: validatePayload(op, payload),
    }),
  );
}

interface RawProposal {
  id: string;
  operation: string;
  payload_json: string;
  payload_hash: string;
  status: string;
  approval_source: string | null;
  session_id: string | null;
  created_at: number;
  expires_at: number;
  decided_at: number | null;
  consumed_at: number | null;
  http_status: number | null;
  result_code: string | null;
  result_thread_id: string | null;
  result_url: string | null;
}

function toProposal(raw: RawProposal): AgoraProposalRow {
  let payload: unknown;
  try {
    payload = JSON.parse(raw.payload_json);
  } catch {
    throw new RepositoryValidationError("stored agora payload is invalid");
  }
  const operation = requireOperation(raw.operation);
  const normalized = validatePayload(operation, payload);
  // Never trust a stored hash: recompute it from the exact payload that will
  // be sent. If the row was mutated after approval, the recomputed hash no
  // longer matches the human-approved hash and send refuses before transport.
  const payloadHash = agoraPayloadHash(operation, normalized);
  return Object.freeze({
    id: raw.id,
    operation,
    payload: normalized,
    payloadHash,
    status: requireStatus(raw.status),
    approvalSource: requireApprovalSource(raw.approval_source),
    sessionId: raw.session_id,
    createdAt: raw.created_at,
    expiresAt: raw.expires_at,
    decidedAt: raw.decided_at,
    consumedAt: raw.consumed_at,
    httpStatus: raw.http_status,
    resultCode: raw.result_code,
    resultThreadId: safeResultThreadId(raw.result_thread_id),
    // Never trust a persisted URL: re-validate origin/protocol/shape on read.
    resultUrl: safeResultUrl(raw.result_url),
  });
}

function readJsonField(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function extractRegistrationKey(text: string): string | null {
  const body = readJsonField(text);
  if (body === null) return null;
  const candidate = body.api_key;
  if (
    typeof candidate !== "string" ||
    candidate.length < 1 ||
    candidate.length > 4096 ||
    candidate.includes("\0")
  ) {
    return null;
  }
  return candidate;
}

function safeResultCode(value: string): string {
  if (!RESULT_CODE_PATTERN.test(value)) {
    return "unknown";
  }
  return value;
}

function safeResultThreadId(value: unknown): string | null {
  return typeof value === "string" && THREAD_ID_PATTERN.test(value)
    ? value
    : null;
}

/**
 * Normalize one response-provided result URL. Only the fixed AGORA origin and
 * the public thread page shape are accepted: no credentials, port, query,
 * fragment, path traversal, other host, or non-HTTPS protocol. Invalid values
 * are simply absent (never echoed back).
 */
function safeResultUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname.toLowerCase() !== AGORA_HOST ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    return null;
  }
  if (!parsed.pathname.startsWith(AGORA_THREAD_PAGE_PREFIX)) return null;
  const id = parsed.pathname.slice(AGORA_THREAD_PAGE_PREFIX.length);
  if (!THREAD_ID_PATTERN.test(id)) return null;
  return `${AGORA_BASE_URL}${AGORA_THREAD_PAGE_PREFIX}${encodeURIComponent(id)}`;
}

/**
 * Extract ONLY a safe result target from an actual 2xx response body. The raw
 * provider body is never persisted or returned. Registration has no public
 * result page. Thread/reply accept a bounded id field or an AGORA thread URL.
 */
function extractResultTarget(
  operation: AgoraOperation,
  text: string,
): { resultThreadId: string | null; resultUrl: string | null } {
  if (operation === "register") {
    return { resultThreadId: null, resultUrl: null };
  }
  const body = readJsonField(text);
  if (body === null) {
    return { resultThreadId: null, resultUrl: null };
  }
  const nested =
    typeof body.thread === "object" && body.thread !== null
      ? (body.thread as Record<string, unknown>)
      : null;
  const candidateId =
    operation === "thread"
      ? body.threadId ??
        body.thread_id ??
        body.id ??
        nested?.id ??
        nested?.threadId
      : body.threadId ??
        body.thread_id ??
        nested?.id ??
        nested?.threadId;
  const resultThreadId = safeResultThreadId(candidateId);
  const resultUrl =
    safeResultUrl(body.url ?? body.threadUrl ?? body.thread_url ?? nested?.url) ??
    (resultThreadId === null
      ? null
      : `${AGORA_BASE_URL}${AGORA_THREAD_PAGE_PREFIX}${encodeURIComponent(resultThreadId)}`);
  return { resultThreadId, resultUrl };
}

/** Build one fixed destination for an operation; no caller-supplied URL. */
export function agoraWritePath(
  operation: AgoraOperation,
  payload: AgoraPayload,
): string {
  if (operation === "register") return AGORA_REGISTER_PATH;
  if (operation === "thread") return AGORA_THREADS_PATH;
  const threadId = (payload as AgoraReplyPayload).threadId;
  return `${AGORA_THREADS_PATH}/${encodeURIComponent(threadId)}/posts`;
}

export function createAgoraStore(options: AgoraStoreOptions): AgoraStore {
  if (typeof options !== "object" || options === null) {
    throw new RepositoryValidationError("agora options are required");
  }
  if (
    options.transport === undefined ||
    typeof options.transport.get !== "function" ||
    typeof options.transport.post !== "function"
  ) {
    throw new RepositoryValidationError("agora transport is required");
  }
  const path = options.path;
  const minWriteIntervalMs =
    options.minWriteIntervalMs ?? AGORA_MIN_WRITE_INTERVAL_MS;
  if (
    !Number.isInteger(minWriteIntervalMs) ||
    minWriteIntervalMs < AGORA_MIN_WRITE_INTERVAL_MS ||
    minWriteIntervalMs > 24 * 60 * 60 * 1000
  ) {
    throw new RepositoryValidationError(
      "agora write interval must be at least 10000ms",
    );
  }
  const db: Database.Database = openPrivateSqlite(path);
  try {
    // Upgrade the whole schema atomically, in dependency order. A store from
    // before session ownership has an agora_proposals table with no
    // session_id column, so the session index must be created only AFTER the
    // legacy column has been added. Doing it earlier made startup fail with
    // "no such column: session_id" before the service could become ready.
    const upgrade = db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS agora_proposals (
          id            TEXT PRIMARY KEY,
          operation     TEXT NOT NULL
                        CHECK (operation IN ('register','thread','reply')),
          payload_json  TEXT NOT NULL,
          payload_hash  TEXT NOT NULL,
          status        TEXT NOT NULL
                        CHECK (status IN ('pending','approved','rejected','sending','sent','unknown','failed')),
          approval_source TEXT
                        CHECK (approval_source IN ('operator','browser')),
          session_id    TEXT,
          created_at    INTEGER NOT NULL,
          expires_at    INTEGER NOT NULL,
          decided_at    INTEGER,
          consumed_at   INTEGER,
          http_status   INTEGER,
          result_code   TEXT,
          result_thread_id TEXT,
          result_url    TEXT,
          send_token    TEXT,
          send_lease_until INTEGER
        ) STRICT;
        CREATE TABLE IF NOT EXISTS agora_state (
          id            TEXT PRIMARY KEY CHECK (id = 'default'),
          last_write_at INTEGER
        ) STRICT;
        CREATE TABLE IF NOT EXISTS agora_credentials (
          id            TEXT PRIMARY KEY CHECK (id = 'default'),
          api_key       TEXT NOT NULL,
          updated_at    INTEGER NOT NULL
        ) STRICT;
      `);
      // Migrate stores created by the earlier partial implementation.
      // Missing columns are nullable, so existing rows keep their data and a
      // legacy proposal remains operator-owned (session_id IS NULL).
      const proposalColumns = new Set(
        (
          db.prepare("PRAGMA table_info(agora_proposals)").all() as Array<{
            name: string;
          }>
        ).map((column) => column.name),
      );
      if (!proposalColumns.has("session_id")) {
        db.exec("ALTER TABLE agora_proposals ADD COLUMN session_id TEXT");
      }
      if (!proposalColumns.has("approval_source")) {
        db.exec(`
          ALTER TABLE agora_proposals ADD COLUMN approval_source TEXT
            CHECK (approval_source IN ('operator','browser'))
        `);
        // Ordered backfill after the additive column: every approval that
        // existed before provenance was recorded came from the local operator
        // CLI, so it keeps operator semantics (model send stays allowed).
        db.exec(
          "UPDATE agora_proposals SET approval_source = 'operator' WHERE status = 'approved' AND approval_source IS NULL",
        );
      }
      if (!proposalColumns.has("result_thread_id")) {
        db.exec(
          "ALTER TABLE agora_proposals ADD COLUMN result_thread_id TEXT",
        );
      }
      if (!proposalColumns.has("result_url")) {
        db.exec("ALTER TABLE agora_proposals ADD COLUMN result_url TEXT");
      }
      if (!proposalColumns.has("send_token")) {
        db.exec("ALTER TABLE agora_proposals ADD COLUMN send_token TEXT");
      }
      if (!proposalColumns.has("send_lease_until")) {
        db.exec(
          "ALTER TABLE agora_proposals ADD COLUMN send_lease_until INTEGER",
        );
      }
      db.exec(`
        CREATE INDEX IF NOT EXISTS agora_proposals_status_idx
          ON agora_proposals(status, created_at);
        CREATE INDEX IF NOT EXISTS agora_proposals_session_idx
          ON agora_proposals(session_id, status, created_at);
      `);
    });
    upgrade.immediate();
    db.pragma("busy_timeout = 5000");
    // Do NOT mark all `sending` rows unknown here: another live CLI may be
    // inside a send. Recovery is lease-based and happens lazily per row.
    hardenPrivateSidecars(path);
  } catch (error) {
    closePrivateSqlite(db, path);
    if (error instanceof RepositoryValidationError) throw error;
    throw new RepositoryValidationError("agora store is unavailable");
  }
  const clock = options.clock ?? { now: () => Date.now() };
  const hostApiKey =
    options.hostApiKey === undefined ? null : options.hostApiKey;

  function read(id: string): AgoraProposalRow | null {
    const raw = db
      .prepare("SELECT * FROM agora_proposals WHERE id = ?")
      .get(id) as RawProposal | undefined;
    return raw === undefined ? null : toProposal(raw);
  }

  function getLastWriteAt(): number | null {
    const row = db
      .prepare("SELECT last_write_at FROM agora_state WHERE id = 'default'")
      .get() as { last_write_at: number | null } | undefined;
    return row?.last_write_at ?? null;
  }

  function getCredential(): string | null {
    if (hostApiKey !== null) return hostApiKey;
    const row = db
      .prepare("SELECT api_key FROM agora_credentials WHERE id = 'default'")
      .get() as { api_key: string } | undefined;
    return row?.api_key ?? null;
  }

  function propose(input: {
    operation: AgoraOperation;
    payload: unknown;
    now?: number;
    sessionId?: string | null;
  }): AgoraProposalRow {
    const operation = requireOperation(input.operation);
    const payload = validatePayload(operation, input.payload);
    const now = requireNow(input.now ?? clock.now());
    const sessionId =
      input.sessionId === undefined || input.sessionId === null
        ? null
        : requireSessionId(input.sessionId);
    const hash = agoraPayloadHash(operation, payload);
    // Same-session dedupe only: a model must never receive (or accidentally
    // share) an operator/other-session row merely because the bytes match.
    const existing = db
      .prepare(
        "SELECT * FROM agora_proposals WHERE operation = ? AND payload_hash = ? AND status IN ('pending','approved') AND ((session_id IS NULL AND ? IS NULL) OR session_id = ?) ORDER BY created_at DESC LIMIT 1",
      )
      .get(operation, hash, sessionId, sessionId) as RawProposal | undefined;
    if (existing !== undefined) {
      return toProposal(existing);
    }
    const id = generateId();
    db.prepare(
      "INSERT INTO agora_proposals (id, operation, payload_json, payload_hash, status, session_id, created_at, expires_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)",
    ).run(
      id,
      operation,
      JSON.stringify(payload),
      hash,
      sessionId,
      now,
      now + AGORA_PENDING_TTL_MS,
    );
    const row = read(id);
    if (row === null) {
      throw new RepositoryValidationError("agora proposal insert failed");
    }
    return row;
  }

  function expire(id: string, now: number): void {
    db.prepare(
      "UPDATE agora_proposals SET status = 'failed', result_code = 'approval_expired', decided_at = ? WHERE id = ? AND status IN ('pending','approved') AND expires_at <= ?",
    ).run(now, id, now);
  }

  // A `sending` row whose lease has expired belonged to a process that is no
  // longer demonstrably alive. It becomes terminal `unknown` (never retried)
  // but only then; a live lease is left untouched.
  const staleSending =
    `COALESCE(send_lease_until, COALESCE(consumed_at, 0) + ${AGORA_SEND_LEASE_MS})`;

  function recoverSending(now: number, id?: string): void {
    if (id === undefined) {
      db.prepare(
        `UPDATE agora_proposals SET status = 'unknown', result_code = 'interrupted_before_completion', send_token = NULL, send_lease_until = NULL WHERE status = 'sending' AND ${staleSending} <= ?`,
      ).run(now);
      return;
    }
    db.prepare(
      `UPDATE agora_proposals SET status = 'unknown', result_code = 'interrupted_before_completion', send_token = NULL, send_lease_until = NULL WHERE id = ? AND status = 'sending' AND ${staleSending} <= ?`,
    ).run(id, now);
  }

  function refreshExpiry(now: number): void {
    db.prepare(
      "UPDATE agora_proposals SET status = 'failed', result_code = 'approval_expired', decided_at = ? WHERE status IN ('pending','approved') AND expires_at <= ?",
    ).run(now, now);
    recoverSending(now);
  }

  function list(statusFilter?: AgoraProposalStatus): AgoraProposalRow[] {
    refreshExpiry(clock.now());
    const rows =
      statusFilter === undefined
        ? (db
            .prepare(
              "SELECT * FROM agora_proposals ORDER BY created_at DESC, rowid DESC",
            )
            .all() as RawProposal[])
        : (db
            .prepare(
              "SELECT * FROM agora_proposals WHERE status = ? ORDER BY created_at DESC, rowid DESC",
            )
            .all(requireStatus(statusFilter)) as RawProposal[]);
    return rows.map(toProposal);
  }

  function listForSession(
    sessionIdRaw: string,
    statusFilter?: AgoraProposalStatus,
  ): AgoraProposalRow[] {
    const sessionId = requireSessionId(sessionIdRaw);
    refreshExpiry(clock.now());
    const rows =
      statusFilter === undefined
        ? (db
            .prepare(
              "SELECT * FROM agora_proposals WHERE session_id = ? ORDER BY created_at DESC, rowid DESC",
            )
            .all(sessionId) as RawProposal[])
        : (db
            .prepare(
              "SELECT * FROM agora_proposals WHERE session_id = ? AND status = ? ORDER BY created_at DESC, rowid DESC",
            )
            .all(sessionId, requireStatus(statusFilter)) as RawProposal[]);
    return rows.map(toProposal);
  }

  function show(id: string): AgoraProposalRow {
    const wanted = requireId(id);
    const now = clock.now();
    expire(wanted, now);
    recoverSending(now, wanted);
    const row = read(wanted);
    if (row === null) {
      throw new AgoraProposalNotFoundError();
    }
    return row;
  }

  function showForSession(id: string, sessionIdRaw: string): AgoraProposalRow {
    const sessionId = requireSessionId(sessionIdRaw);
    const row = show(id);
    // Never reveal whether another session/operator row exists.
    if (row.sessionId === null || row.sessionId !== sessionId) {
      throw new AgoraProposalNotFoundError();
    }
    return row;
  }

  function approveInternal(
    id: string,
    expectedHash: string,
    now: number,
    source: AgoraApprovalSource,
  ): AgoraProposalRow {
    const wanted = requireId(id);
    const hash = requireHash(expectedHash);
    const at = requireNow(now);
    expire(wanted, at);
    const current = read(wanted);
    if (current === null) {
      throw new AgoraProposalNotFoundError();
    }
    if (current.payloadHash !== hash) {
      throw new AgoraPayloadHashMismatchError();
    }
    if (current.status === "approved") {
      // Idempotent repeat. Never downgrade an operator approval on a browser
      // repeat; an explicit operator CLI approval upgrades a browser one.
      if (source === "operator" && current.approvalSource !== "operator") {
        db.prepare(
          "UPDATE agora_proposals SET approval_source = 'operator' WHERE id = ? AND status = 'approved' AND payload_hash = ?",
        ).run(wanted, hash);
        const promoted = read(wanted);
        if (promoted === null) {
          throw new AgoraProposalNotFoundError();
        }
        return promoted;
      }
      return current;
    }
    if (current.status !== "pending") {
      throw new AgoraProposalStateConflictError(
        "agora proposal is not pending",
      );
    }
    const moved = db
      .prepare(
        "UPDATE agora_proposals SET status = 'approved', approval_source = ?, decided_at = ?, expires_at = ? WHERE id = ? AND status = 'pending' AND payload_hash = ?",
      )
      .run(
        source,
        at,
        at + AGORA_APPROVED_TTL_MS,
        wanted,
        hash,
      );
    if (moved.changes !== 1) {
      throw new AgoraProposalStateConflictError(
        "agora proposal changed concurrently",
      );
    }
    const row = read(wanted);
    if (row === null) {
      throw new AgoraProposalNotFoundError();
    }
    return row;
  }

  /** Exact-hash operator CLI approval. */
  function approve(
    id: string,
    expectedHash: string,
    now = clock.now(),
  ): AgoraProposalRow {
    return approveInternal(id, expectedHash, now, "operator");
  }

  function approveForSession(
    id: string,
    expectedHash: string,
    sessionIdRaw: string,
    now = clock.now(),
  ): AgoraProposalRow {
    const sessionId = requireSessionId(sessionIdRaw);
    // Ownership is checked BEFORE the hash/state decision so another
    // session's or an operator-created row is always a fixed not-found.
    showForSession(id, sessionId);
    // Browser approval authorizes ONE human Send click, never a model send.
    return approveInternal(id, expectedHash, now, "browser");
  }

  function rejectInternal(
    wanted: string,
    expectedHash: string | null,
    at: number,
  ): AgoraProposalRow {
    expire(wanted, at);
    const current = read(wanted);
    if (current === null) {
      throw new AgoraProposalNotFoundError();
    }
    if (expectedHash !== null && current.payloadHash !== expectedHash) {
      throw new AgoraPayloadHashMismatchError();
    }
    if (current.status === "rejected") return current;
    if (current.status !== "pending" && current.status !== "approved") {
      throw new AgoraProposalStateConflictError(
        "agora proposal is already terminal",
      );
    }
    const moved = db
      .prepare(
        "UPDATE agora_proposals SET status = 'rejected', decided_at = ? WHERE id = ? AND status IN ('pending','approved')",
      )
      .run(at, wanted);
    if (moved.changes !== 1) {
      throw new AgoraProposalStateConflictError(
        "agora proposal changed concurrently",
      );
    }
    const row = read(wanted);
    if (row === null) {
      throw new AgoraProposalNotFoundError();
    }
    return row;
  }

  function reject(id: string, now = clock.now()): AgoraProposalRow {
    return rejectInternal(requireId(id), null, requireNow(now));
  }

  function rejectForSession(
    id: string,
    expectedHash: string,
    sessionIdRaw: string,
    now = clock.now(),
  ): AgoraProposalRow {
    const sessionId = requireSessionId(sessionIdRaw);
    const hash = requireHash(expectedHash);
    // Ownership is checked before the hash to keep foreign rows hidden.
    showForSession(id, sessionId);
    return rejectInternal(requireId(id), hash, requireNow(now));
  }

  // BEGIN IMMEDIATE reserves the single write slot before the throttle/status
  // reads, so two CLI processes cannot both observe `approved` and both send.
  const beginTx = db.transaction(
    (input: {
      id: string;
      expectedHash: string;
      now: number;
      sessionId?: string;
      actor: AgoraSendActor;
    }):
      | { kind: "sending"; proposal: AgoraProposalRow }
      | { kind: "throttled"; retryAfterMs: number } => {
      expire(input.id, input.now);
      recoverSending(input.now, input.id);
      const current = read(input.id);
      if (current === null) {
        throw new AgoraProposalNotFoundError();
      }
      if (
        input.sessionId !== undefined &&
        (current.sessionId === null || current.sessionId !== input.sessionId)
      ) {
        throw new AgoraProposalNotFoundError();
      }
      if (current.payloadHash !== input.expectedHash) {
        throw new AgoraPayloadHashMismatchError();
      }
      if (current.status !== "approved") {
        throw new AgoraProposalStateConflictError(
          "agora proposal is not approved for send",
        );
      }
      // A model-requested send may only consume an operator (CLI) approval.
      // Browser approvals require the separate human Send click. This check
      // is inside the IMMEDIATE transaction, BEFORE throttle/lease/transport.
      if (
        input.actor === "model" &&
        current.approvalSource === "browser"
      ) {
        throw new AgoraProposalStateConflictError(
          "agora proposal browser approval requires an explicit human send",
        );
      }
      const last = getLastWriteAt();
      if (last !== null && input.now - last < minWriteIntervalMs) {
        return {
          kind: "throttled",
          retryAfterMs: minWriteIntervalMs - (input.now - last),
        };
      }
      const sendToken = generateId();
      const moved = db
        .prepare(
          "UPDATE agora_proposals SET status = 'sending', consumed_at = ?, send_token = ?, send_lease_until = ? WHERE id = ? AND status = 'approved' AND payload_hash = ? AND expires_at > ?",
        )
        .run(
          input.now,
          sendToken,
          input.now + AGORA_SEND_LEASE_MS,
          input.id,
          input.expectedHash,
          input.now,
        );
      if (moved.changes !== 1) {
        throw new AgoraProposalStateConflictError(
          "agora proposal changed concurrently",
        );
      }
      db.prepare(
        "INSERT INTO agora_state (id, last_write_at) VALUES ('default', ?) ON CONFLICT(id) DO UPDATE SET last_write_at = excluded.last_write_at",
      ).run(input.now);
      const row = read(input.id);
      if (row === null) {
        throw new AgoraProposalNotFoundError();
      }
      return { kind: "sending", proposal: row };
    },
  );

  function beginSend(input: {
    id: string;
    expectedHash: string;
    now: number;
    sessionId?: string;
    actor?: AgoraSendActor;
  }):
    | { kind: "sending"; proposal: AgoraProposalRow }
    | { kind: "throttled"; retryAfterMs: number } {
    const wanted = requireId(input.id);
    const hash = requireHash(input.expectedHash);
    const now = requireNow(input.now);
    const sessionId =
      input.sessionId === undefined
        ? undefined
        : requireSessionId(input.sessionId);
    const actor =
      input.actor === undefined
        ? sessionId === undefined
          ? "human"
          : "model"
        : requireActor(input.actor);
    return beginTx.immediate({
      id: wanted,
      expectedHash: hash,
      now,
      actor,
      ...(sessionId === undefined ? {} : { sessionId }),
    });
  }

  const finishTx = db.transaction(
    (input: {
      id: string;
      outcome: "sent" | "unknown" | "failed";
      httpStatus: number | null;
      resultCode: string;
      apiKey?: string;
      resultThreadId?: string | null;
      resultUrl?: string | null;
      now: number;
    }): AgoraProposalRow => {
      const moved = db
        .prepare(
          "UPDATE agora_proposals SET status = ?, http_status = ?, result_code = ?, result_thread_id = ?, result_url = ?, send_token = NULL, send_lease_until = NULL WHERE id = ? AND status = 'sending'",
        )
        .run(
          input.outcome,
          input.httpStatus,
          safeResultCode(input.resultCode),
          safeResultThreadId(input.resultThreadId),
          safeResultUrl(input.resultUrl),
          input.id,
        );
      if (moved.changes !== 1) {
        throw new AgoraProposalStateConflictError(
          "agora proposal is not awaiting completion",
        );
      }
      if (input.apiKey !== undefined) {
        db.prepare(
          "INSERT INTO agora_credentials (id, api_key, updated_at) VALUES ('default', ?, ?) ON CONFLICT(id) DO UPDATE SET api_key = excluded.api_key, updated_at = excluded.updated_at",
        ).run(input.apiKey, input.now);
      }
      const row = read(input.id);
      if (row === null) {
        throw new AgoraProposalNotFoundError();
      }
      return row;
    },
  );

  function finishSend(input: {
    id: string;
    outcome: "sent" | "unknown" | "failed";
    httpStatus: number | null;
    resultCode: string;
    apiKey?: string;
    resultThreadId?: string | null;
    resultUrl?: string | null;
    now: number;
  }): AgoraProposalRow {
    const normalized = {
      id: requireId(input.id),
      outcome: input.outcome,
      httpStatus:
        input.httpStatus === null
          ? null
          : Number.isInteger(input.httpStatus) &&
              input.httpStatus >= 0 &&
              input.httpStatus <= 999
            ? input.httpStatus
            : null,
      resultCode: safeResultCode(input.resultCode),
      resultThreadId: safeResultThreadId(input.resultThreadId),
      resultUrl: safeResultUrl(input.resultUrl),
      now: requireNow(input.now),
      ...(input.apiKey === undefined
        ? {}
        : { apiKey: requireCredential(input.apiKey) }),
    };
    return finishTx(normalized);
  }

  function setCredential(apiKey: string, now = clock.now()): void {
    const credential = requireCredential(apiKey);
    db.prepare(
      "INSERT INTO agora_credentials (id, api_key, updated_at) VALUES ('default', ?, ?) ON CONFLICT(id) DO UPDATE SET api_key = excluded.api_key, updated_at = excluded.updated_at",
    ).run(credential, requireNow(now));
  }

  // Transport text is an untrusted boundary value: never pass an object (or
  // any non-string) into string helpers. A malformed transport response is a
  // fixed public-read failure, not a TypeError escaping to the caller.
  function requireReaderText(value: unknown): string {
    if (typeof value !== "string") {
      throw new RepositoryValidationError("agora public read failed");
    }
    return value;
  }

  async function readHello(optionsArg: { signal?: AbortSignal } = {}) {
    const out = await options.transport.get(AGORA_HELLO_PATH, optionsArg);
    if (out.status < 200 || out.status >= 300) {
      throw new RepositoryValidationError("agora public read failed");
    }
    const text = requireReaderText(out.text).slice(
      0,
      AGORA_MAX_READ_TEXT_CP * 4,
    );
    const parsed = readJsonField(text);
    return {
      status: out.status,
      untrusted: true as const,
      body:
        parsed === null
          ? text.slice(0, AGORA_MAX_READ_TEXT_CP)
          : parsed,
    };
  }

  async function readThread(
    threadId: string,
    optionsArg: { signal?: AbortSignal } = {},
  ) {
    const id = requireThreadId(threadId);
    const out = await options.transport.get(
      `${AGORA_THREAD_PAGE_PREFIX}${encodeURIComponent(id)}`,
      optionsArg,
    );
    if (out.status < 200 || out.status >= 300) {
      throw new RepositoryValidationError("agora public read failed");
    }
    return {
      status: out.status,
      untrusted: true as const,
      threadId: id,
      body: requireReaderText(out.text).slice(0, AGORA_MAX_READ_TEXT_CP),
    };
  }

  async function send(
    id: string,
    expectedHash: string,
    sendOptions: {
      signal?: AbortSignal;
      now?: number;
      sessionId?: string;
      actor?: AgoraSendActor;
    } = {},
  ): Promise<
    | { kind: "sent" | "unknown" | "failed"; proposal: AgoraProposalRow }
    | { kind: "throttled"; retryAfterMs: number }
    | { kind: "key_missing" }
  > {
    const wanted = requireId(id);
    const current =
      sendOptions.sessionId === undefined
        ? show(wanted)
        : showForSession(wanted, sendOptions.sessionId);
    if (current.operation !== "register" && getCredential() === null) {
      return { kind: "key_missing" };
    }
    const begun = beginSend({
      id: wanted,
      expectedHash,
      now: sendOptions.now ?? clock.now(),
      ...(sendOptions.sessionId === undefined
        ? {}
        : { sessionId: sendOptions.sessionId }),
      ...(sendOptions.actor === undefined ? {} : { actor: sendOptions.actor }),
    });
    if (begun.kind === "throttled") return begun;
    const now = sendOptions.now ?? clock.now();
    const payload = begun.proposal.payload;
    const operation = begun.proposal.operation;
    const path = agoraWritePath(operation, payload);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
    };
    if (operation !== "register") {
      const key = getCredential();
      if (key === null) {
        // Defensive: the key check above should have caught this.
        return {
          kind: "failed",
          proposal: finishSend({
            id: wanted,
            outcome: "failed",
            httpStatus: null,
            resultCode: "key_missing",
            now,
          }),
        };
      }
      headers["x-agent-key"] = key;
    }
    const body =
      operation === "register"
        ? {
            name: (payload as AgoraRegisterPayload).name,
            description: (payload as AgoraRegisterPayload).description,
          }
        : operation === "thread"
          ? {
              title: (payload as AgoraThreadPayload).title,
              body: (payload as AgoraThreadPayload).body,
            }
          : { body: (payload as AgoraReplyPayload).body };
    let response: AgoraTransportPostResult;
    try {
      response = await options.transport.post(path, body, headers, {
        ...(sendOptions.signal !== undefined
          ? { signal: sendOptions.signal }
          : {}),
      });
    } catch {
      return {
        kind: "unknown",
        proposal: finishSend({
          id: wanted,
          outcome: "unknown",
          httpStatus: null,
          resultCode: "transport_error",
          now,
        }),
      };
    }
    const httpStatus = Number.isInteger(response.status)
      ? response.status
      : null;
    if (httpStatus !== null && httpStatus >= 200 && httpStatus < 300) {
      if (operation === "register") {
        const apiKey = extractRegistrationKey(response.text);
        if (apiKey === null) {
          // Registration may have succeeded but the key could not be parsed.
          // Never retry automatically: a second registration is ambiguous.
          return {
            kind: "unknown",
            proposal: finishSend({
              id: wanted,
              outcome: "unknown",
              httpStatus,
              resultCode: "registration_response_unparseable",
              now,
            }),
          };
        }
        return {
          kind: "sent",
          proposal: finishSend({
            id: wanted,
            outcome: "sent",
            httpStatus,
            resultCode: "sent",
            apiKey,
            now,
          }),
        };
      }
      const target = extractResultTarget(operation, response.text);
      return {
        kind: "sent",
        proposal: finishSend({
          id: wanted,
          outcome: "sent",
          httpStatus,
          resultCode: "sent",
          resultThreadId: target.resultThreadId,
          resultUrl: target.resultUrl,
          now,
        }),
      };
    }
    if (httpStatus !== null && httpStatus >= 400 && httpStatus < 500) {
      return {
        kind: "failed",
        proposal: finishSend({
          id: wanted,
          outcome: "failed",
          httpStatus,
          resultCode: "http_rejected",
          now,
        }),
      };
    }
    return {
      kind: "unknown",
      proposal: finishSend({
        id: wanted,
        outcome: "unknown",
        httpStatus,
        resultCode: "ambiguous_http",
        now,
      }),
    };
  }

  return {
    path,
    suggestedRegistration: AGORA_SUGGESTED_REGISTRATION,
    propose,
    list,
    listForSession,
    show,
    showForSession,
    approve,
    approveForSession,
    reject,
    rejectForSession,
    readHello,
    readThread,
    send,
    beginSend,
    finishSend,
    getCredential,
    setCredential,
    getLastWriteAt,
    close() {
      closePrivateSqlite(db, path);
    },
  };
}
