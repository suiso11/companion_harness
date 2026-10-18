// M0 Hono composition root (plan §3, §9 blockers 4+7, §11-§12, §16.7, §19.5).
//
// The kernel stays HTTP-unaware: this module owns route assembly, security
// middleware, domain-error mapping, and the draining admission gate. All
// domain work (including idempotent persistence/replay of accepted 2xx
// only) is delegated to the kernel repository; cancel goes through the
// engine so the DB transition commits before any abort.

import {
  ActiveRunResponseSchema,
  type ApiErrorCode,
  AutonomyControlSetRequestSchema,
  AutonomyHistoryQuerySchema,
  AutonomyListQuerySchema,
  CancelRunRequestSchema,
  CancelRunResponseSchema,
  ConversationProposalAcceptRequestSchema,
  ConversationProposalRejectRequestSchema,
  CreateSessionRequestSchema,
  CreateSessionResponseSchema,
  EventsQuerySchema,
  HandoffAttemptRequestSchema,
  HandoffCreateRequestSchema,
  HandoffDispatchRequestSchema,
  HandoffReportRequestSchema,
  HandoffTransitionRequestSchema,
  HandoffVerifyRequestSchema,
  HistoryQuerySchema,
  IDEMPOTENCY_SCOPE_SESSIONS_CREATE,
  IdempotencyLookupQuerySchema,
  LearningEvidenceAttachRequestSchema,
  LearningHypothesisCreateRequestSchema,
  LearningHypothesisDecisionRequestSchema,
  LearningHypothesisTransitionRequestSchema,
  MemoryDetailResponseSchema,
  MemoryMutationRequestSchema,
  MemoryMutationResponseSchema,
  MemoryOperationResponseSchema,
  MemoryRecallExposureResponseSchema,
  MemorySearchRequestSchema,
  MemorySearchResponseSchema,
  messageScope,
  NotificationAckReceiptSchema,
  NotificationForwardQuerySchema,
  NotificationHistoryResponseSchema,
  NotificationListQuerySchema,
  NotificationListResponseSchema,
  NotificationReadQuerySchema,
  NotificationViewSchema,
  PostMessageRequestSchema,
  PostMessageResponseSchema,
  PostRetryRequestSchema,
  ProposalApprove202ResponseSchema,
  ProposalApproveRequestSchema,
  ProposalExecutionViewSchema,
  ProposalRejectRequestSchema,
  ProposalRejectResponseSchema,
  ProposalsListResponseSchema,
  PurposeConflictRecordRequestSchema,
  PurposeCorrectRequestSchema,
  PurposeCreateRequestSchema,
  PurposeTransitionRequestSchema,
  proposalApproveScope,
  ReferenceContextGetResponseSchema,
  ReferenceContextPutRequestSchema,
  ReferenceContextPutResponseSchema,
  ReferenceDetailResponseSchema,
  ReferenceListResponseSchema,
  ReferenceSetDetailResponseSchema,
  RunStatusResponseSchema,
  retryScope,
  ShadowExplicitRequestSchema,
  shadowRequestScope,
  TaskCreateRequestSchema,
  TaskHoldRequestSchema,
  TaskResumeRequestSchema,
  TaskTransitionRequestSchema,
  type TrialProfileSnapshot,
  TrialProposalViewSchema,
  TrialStageRequestSchema,
} from "@companion/contracts";
import {
  ActionNotCancellableError,
  AutonomyStateConflictError,
  AutonomyVersionConflictError,
  HandoffStateConflictError,
  HandoffVersionConflictError,
  IdempotencyConflictError,
  InvalidReferenceError,
  isUuidV4,
  type KernelRepository,
  LearningStateConflictError,
  LearningVersionConflictError,
  NotificationKeyConflictError,
  NotificationProjectionResetError,
  ProposalHashMismatchError,
  ProposalStateConflictError,
  ReferenceNotFoundError,
  ReferenceVersionConflictError,
  RepositoryNotFoundError,
  RepositoryValidationError,
  SessionBusyError,
  ShadowLeaseConflictError,
  ShadowStateConflictError,
  ShadowVersionConflictError,
} from "@companion/kernel";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { RemoteConfig, ServerConfig } from "./config.js";
import { ServerConfigError } from "./config.js";
import { createStdServerLogger, type ServerLogger } from "./logger.js";
import {
  createRemoteLoginRateLimiter,
  hashRemoteToken,
  issueRemoteToken,
  type RemoteLoginRateLimiter,
  type RemoteSessionStore,
  remoteSessionClearCookie,
  remoteSessionSetCookie,
  remoteTokenFromCookieHeader,
} from "./remote_session.js";
import { createNotificationFeedSseResponse, createSseResponse } from "./sse.js";
import {
  renderConversationShell,
  renderRemoteLogin,
  STRICT_CSP,
} from "./ui/page.js";
import { effectiveCursor } from "./ui/reducer.js";

/** Minimal engine surface the routes need (RunEngine satisfies this). */
export interface EnginePort {
  cancel(sessionId: string, runId: string): { status: string };
  shutdown(options?: {
    drainMs?: number;
  }): Promise<{ abandoned: number; cancelled: number }>;
}

/**
 * Minimal server-owned memory management surface the HTTP routes need.
 * Satisfied by the Companion memory service when COMPANION_MEMORY_JSON
 * is set; null keeps the existing memory-disabled behavior (404).
 */
export interface MemoryHttpPort {
  searchMemories(input: {
    sessionId: string;
    runId: string;
    query: string;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<{
    searchId: string;
    hits: readonly {
      handle: string;
      snippet: string;
      status: "active" | "retired";
    }[];
  }>;
  getMemoryDetail(input: {
    sessionId: string;
    searchId: string;
    handle: string;
  }): Promise<{
    snapshot: {
      searchId: string;
      handle: string;
      snippet: string;
      status: "active" | "retired";
    };
    current: {
      body: string;
      kind: string;
      status: string;
      revision: number;
      source: string;
      observedAt: string;
      createdAt: string;
    };
    stale: boolean;
  }>;
  stageMemoryMutation(input: {
    sessionId: string;
    runId: string;
    kind: "record.correct" | "record.retire" | "record.reactivate";
    searchId: string;
    handle?: string;
    correctionBody?: string;
    idempotencyKey: string;
    signal?: AbortSignal;
    trustedSelection?: boolean;
  }): Promise<
    | {
        ok: true;
        operationId: string;
        status: "pending" | "acked" | "failed";
        deduplicated: boolean;
      }
    | {
        ok: false;
        code:
          | "needs_clarification"
          | "target_not_found"
          | "state_conflict"
          | "validation_error"
          | "service_unavailable"
          | "idempotency_conflict";
        candidates?: readonly {
          handle: string;
          snippet: string;
          status: "active" | "retired";
        }[];
      }
  >;
  getMemoryOperation(
    sessionId: string,
    operationId: string,
  ): {
    operationId: string;
    kind: "record.correct" | "record.retire" | "record.reactivate";
    recordRevision: number | null;
    status: "pending" | "acked" | "failed";
  } | null;
  getMemoryRecallExposure(input: {
    sessionId: string;
    runId: string;
    citation: string;
  }): {
    runId: string;
    citation: string;
    snippet: string;
    revision: number | null;
    kind: "user_fact" | "model_inference" | "summary" | "correction" | null;
  } | null;
  hashDrainingReplay(input: {
    kind: "record.correct" | "record.retire" | "record.reactivate";
    sessionId: string;
    searchId: string;
    handle?: string;
    correctionBody?: string;
  }): { requestHash: string; recordId: string } | null;
}

/**
 * Slice (b) password verifier (server-owned). Production verifies against
 * the scrypt record in the remote config `passwordFile` (re-read per
 * attempt so rotation needs no restart); tests inject a stub. The
 * password itself never crosses this boundary except as the login
 * attempt argument (never logged, never persisted).
 */
export interface RemotePasswordVerifier {
  verify(password: string): boolean;
}

export interface CreateAppDeps {
  config: ServerConfig;
  repo: KernelRepository;
  engine: EnginePort;
  logger?: ServerLogger;
  now?: () => number;
  /**
   * M3 static UI assets (plan §16.1, §16.7). Populated by bootstrap from
   * `dist/assets` (esbuild bundle); tests inject inline. Missing entries
   * serve 404 while the SSR shell keeps working.
   */
  assets?: { clientJs?: string; clientCss?: string };
  /**
   * C21: true only when the M5 triple gate is open (config opt-in +
   * writeEnabled + a dedicated trusted write binding on the active Calendar
   * instance). While false, decision READS still list existing proposal
   * state, but APPROVE is refused before any state change, so a disabled
   * configuration can never stage or queue an external action. Default
   * false (fail closed).
   */
  actionsEnabled?: boolean;
  /**
   * M6: true only when the explicit create gate is open (config opt-in +
   * writeEnabled + createEnabled + a dedicated trusted create binding on
   * the active Calendar instance). APPROVE admits per proposal tool BEFORE
   * any repository mutation: `calendar.create` rows require this flag,
   * `calendar.reschedule` rows require actionsEnabled; the disabled tool
   * is refused with fixed 409 `action_execution_disabled`. Default false
   * (fail closed).
   */
  createEnabled?: boolean;
  /**
   * Explicit memory management service (server-owned). Null (default)
   * preserves the existing memory-disabled behavior: every
   * `/memory/*` route answers 404 without touching the repository.
   */
  memory?: MemoryHttpPort;
  /**
   * AV shadow worker wake hook (server-owned). Called synchronously AFTER a
   * committed autonomy mutation / control change / explicit shadow request
   * so meaningful new state re-drives the worker. Never throws back into
   * the committed command (the app guards every call); absent (default)
   * keeps the existing no-worker behavior.
   */
  shadowWake?: () => void;
  /**
   * AV shadow worker control hook (server-owned). Called synchronously
   * AFTER a committed control change (pause OR resume, INCLUDING a
   * replayed old resume): the worker reads the ACTUAL current control
   * state and aborts its OWN in-flight call immediately when paused, so a
   * pure STOP aborts model/recall work even with no foreground chat. Never
   * throws back into the committed command (guarded like `shadowWake`);
   * absent (default) keeps wake-only behavior.
   */
  shadowControlChanged?: () => void;
  /**
   * Slice (b) remote session wiring. BOTH are REQUIRED when the remote
   * config is enabled (createApp throws fail-closed otherwise) and both
   * are IGNORED when remote mode is disabled (zero behavior change).
   * `remoteStore` persists only SHA-256 token hashes (never tokens);
   * `remotePassword` verifies login attempts in constant time.
   */
  remoteStore?: RemoteSessionStore;
  remotePassword?: RemotePasswordVerifier;
}

export interface ServerControls {
  readonly draining: boolean;
  markDraining(): void;
}

export interface CreatedServerApp {
  app: Hono;
  controls: ServerControls;
}

/** Retry-After seconds advertised with 503 drain rejections (§12.3). */
export const DRAIN_RETRY_AFTER_SECONDS = 5;
/** Upper bound for a mutation body (bounded logging/processing). */
export const MAX_BODY_BYTES = 256 * 1024;

function apiError(
  c: Context,
  status: number,
  code: ApiErrorCode,
  message: string,
): Response {
  return c.json({ error: { code, message } }, status as 400);
}

function validationError(
  c: Context,
  message = "request validation failed",
): Response {
  return apiError(c, 400, "validation_error", message);
}

function shuttingDown(c: Context): Response {
  c.header("Retry-After", String(DRAIN_RETRY_AFTER_SECONDS));
  return apiError(c, 503, "server_shutting_down", "server is shutting down");
}

function isLoopbackHostName(name: string): boolean {
  return name === "127.0.0.1" || name === "localhost";
}

/** Extract the hostname from a Host header (loopback names only). */
export function hostNameOfHeader(value: string): string | null {
  if (value.length === 0 || value.length > 256) {
    return null;
  }
  for (const unit of value) {
    const code = unit.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f) {
      return null;
    }
  }
  let name = value;
  if (name.startsWith("[")) {
    const end = name.indexOf("]");
    if (end < 0) {
      return null;
    }
    const rest = name.slice(end + 1);
    if (rest.length > 0 && !/^:\d+$/.test(rest)) {
      return null;
    }
    name = name.slice(1, end);
  } else {
    const lastColon = name.lastIndexOf(":");
    if (lastColon >= 0 && /^\d+$/.test(name.slice(lastColon + 1))) {
      name = name.slice(0, lastColon);
    } else if (lastColon >= 0) {
      return null;
    }
  }
  return name.toLowerCase();
}

/**
 * Slice (a) remote mode switch. The config is default-off; when disabled
 * every check below behaves byte-identically to the historical loopback
 * logic. Decisions use only the Host/Origin/Sec-Fetch-Site headers —
 * never remoteAddress or X-Forwarded-* — and no CORS headers are emitted.
 */
function remoteConfigOf(config: ServerConfig): RemoteConfig | null {
  const remote = (config as { remote?: RemoteConfig }).remote;
  return remote !== undefined && remote.enabled === true ? remote : null;
}

function isRemoteEnabled(config: ServerConfig): boolean {
  return remoteConfigOf(config) !== null;
}

/** Lowercased hostnames of the validated `https://<host>` allowlist. */
function allowedRemoteHosts(config: ServerConfig): Set<string> {
  const hosts = new Set<string>();
  const remote = remoteConfigOf(config);
  if (remote === null) {
    return hosts;
  }
  for (const origin of remote.allowedOrigins) {
    try {
      hosts.add(new URL(origin).hostname.toLowerCase());
    } catch {
      // Entries are validated at startup; a bad entry never opens access.
    }
  }
  return hosts;
}

/**
 * Exact-match allowlist for one request: the configured remote origins
 * plus the loopback same-origin (`http://<host header>`). The loopback
 * exception applies only when the Host is a loopback name
 * (127.0.0.1/localhost, optional port): an allowlisted remote Host with
 * Origin `http://<same-host>` is rejected (remote origins must be
 * explicit https allowlist entries). The Host header value (with port)
 * is used verbatim so a spoofed Host can never widen the entry.
 * Disabled remote keeps the historical behavior: Host is loopback-only
 * there, so the loopback gate is a no-op (byte-identical decisions).
 */
function originAllowedForRequest(c: Context, config: ServerConfig): boolean {
  const origin = c.req.header("origin");
  if (origin === undefined || origin === "null") {
    return false;
  }
  const host = c.req.header("host") ?? "";
  if (origin === `http://${host}`) {
    const hostName = hostNameOfHeader(host);
    if (hostName !== null && isLoopbackHostName(hostName)) {
      return true;
    }
  }
  const remote = remoteConfigOf(config);
  if (remote === null) {
    return false;
  }
  return (remote.allowedOrigins as readonly string[]).includes(origin);
}

/** Strict Host validation: loopback hostnames only, header required. */
function checkHost(c: Context, config: ServerConfig): Response | null {
  const header = c.req.header("host");
  if (header === undefined) {
    return validationError(c, "missing host header");
  }
  const name = hostNameOfHeader(header);
  if (
    name === null ||
    (!isLoopbackHostName(name) &&
      !(isRemoteEnabled(config) && allowedRemoteHosts(config).has(name)))
  ) {
    return validationError(c, "invalid host header");
  }
  return null;
}

function isMutationMethod(method: string): boolean {
  return (
    method === "POST" ||
    method === "PUT" ||
    method === "PATCH" ||
    method === "DELETE"
  );
}

/**
 * Mutation security (§16.7): same-origin Origin only (Origin:null
 * rejected), application/json required, no CORS headers ever emitted.
 * A missing Origin is accepted only for local CLI-style requests without
 * any browser Sec-Fetch metadata; a missing-Origin request that carries
 * Sec-Fetch-Site/Mode/Dest/User is treated as browser-like and rejected.
 */
function isBrowserLikeFetch(c: Context): boolean {
  for (const name of [
    "sec-fetch-site",
    "sec-fetch-mode",
    "sec-fetch-dest",
    "sec-fetch-user",
  ]) {
    if (c.req.header(name) !== undefined) {
      return true;
    }
  }
  return false;
}

function checkMutationSecurity(
  c: Context,
  config: ServerConfig,
): Response | null {
  const contentType = c.req.header("content-type");
  const mediaType =
    contentType === undefined
      ? null
      : (contentType.split(";")[0]?.trim().toLowerCase() ?? null);
  if (mediaType !== "application/json") {
    return validationError(c, "content-type must be application/json");
  }
  const origin = c.req.header("origin");
  if (origin === undefined) {
    if (isBrowserLikeFetch(c)) {
      return apiError(
        c,
        403,
        "validation_error",
        "cross-origin request rejected",
      );
    }
    return null;
  }
  if (origin === "null") {
    return apiError(
      c,
      403,
      "validation_error",
      "cross-origin request rejected",
    );
  }
  if (originAllowedForRequest(c, config)) {
    return null;
  }
  return apiError(c, 403, "validation_error", "cross-origin request rejected");
}

/**
 * Slice (a) read-path security for GET/HEAD API routes (SSE included).
 * Disabled remote behaves as today (no read check at all). Enabled
 * remote: a present Origin (including `null`) must be exactly allowed;
 * an absent Origin is normal for same-origin GETs, so only an explicit
 * `Sec-Fetch-Site: cross-site` is rejected.
 */
function checkReadSecurity(c: Context, config: ServerConfig): Response | null {
  if (!isRemoteEnabled(config)) {
    return null;
  }
  const origin = c.req.header("origin");
  if (origin !== undefined) {
    if (!originAllowedForRequest(c, config)) {
      return apiError(
        c,
        403,
        "validation_error",
        "cross-origin request rejected",
      );
    }
    return null;
  }
  const site = c.req.header("sec-fetch-site");
  if (site !== undefined && site.trim().toLowerCase() === "cross-site") {
    return apiError(
      c,
      403,
      "validation_error",
      "cross-origin request rejected",
    );
  }
  return null;
}

/**
 * Slice (b) session gate. When remote mode is disabled this is never
 * consulted (zero behavior change). When enabled, a request carries a
 * valid session only when its `companion_remote` cookie holds a 256-bit
 * hex token whose SHA-256 hash is stored, unexpired (absolute timeout)
 * and recently seen (idle timeout). Validation refreshes `last_seen_at`;
 * expired/idle rows are revoked on sight. Only the token HASH is ever
 * compared or stored; the token itself never touches the DB or logs.
 */
function hasValidRemoteSession(
  c: Context,
  config: ServerConfig,
  store: RemoteSessionStore,
  now: () => number,
): boolean {
  const remote = remoteConfigOf(config);
  if (remote === null) {
    return false;
  }
  const token = remoteTokenFromCookieHeader(c.req.header("cookie"));
  if (token === null) {
    return false;
  }
  const tokenHash = hashRemoteToken(token);
  const row = store.lookup(tokenHash);
  if (row === null) {
    return false;
  }
  const t = now();
  if (t >= row.expiresAt || t - row.lastSeenAt > remote.idleTimeoutMs) {
    try {
      store.revoke(tokenHash);
    } catch {
      // Best effort: the session is rejected regardless.
    }
    return false;
  }
  try {
    store.touch(tokenHash, t);
  } catch {
    // Best effort: the session is still valid for this request.
  }
  return true;
}

function remoteUnauthenticated(c: Context): Response {
  return c.json(
    { error: { code: "unauthenticated", message: "authentication required" } },
    401,
  );
}

/**
 * Slice (b) login origin gate. The login route is exempt from the global
 * mutation gate (which mandates `application/json`) so the minimal
 * no-asset login form can POST `application/x-www-form-urlencoded`
 * without any script. The Origin rules are identical to the global ones:
 * absent is fine for non-browser callers, present (including `null`)
 * must be exactly allowed.
 */
function checkLoginOrigin(c: Context, config: ServerConfig): Response | null {
  const origin = c.req.header("origin");
  if (origin === undefined) {
    if (isBrowserLikeFetch(c)) {
      return apiError(
        c,
        403,
        "validation_error",
        "cross-origin request rejected",
      );
    }
    return null;
  }
  if (origin === "null") {
    return apiError(
      c,
      403,
      "validation_error",
      "cross-origin request rejected",
    );
  }
  if (originAllowedForRequest(c, config)) {
    return null;
  }
  return apiError(c, 403, "validation_error", "cross-origin request rejected");
}

/** Upper bound for the urlencoded login form body (bytes on the wire). */
export const MAX_LOGIN_FORM_BYTES = 8192;

/** Bounded `application/x-www-form-urlencoded` parser for the login form. */
function parseLoginFormBody(
  text: string,
): { ok: true; password: unknown } | { ok: false } {
  if (text.length > 8192) {
    return { ok: false };
  }
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(text);
  } catch {
    return { ok: false };
  }
  const seen = new Set<string>();
  for (const key of params.keys()) {
    seen.add(key);
  }
  if (seen.size !== 1 || !seen.has("password")) {
    return { ok: false };
  }
  return { ok: true, password: params.get("password") };
}

/**
 * Byte-bounded text reader for the urlencoded login form. Mirrors the
 * Content-Length pre-check + streaming byte cap of `readJsonBody` so an
 * unauthenticated client cannot force the server to buffer an unbounded
 * body: oversized declared lengths are rejected without reading, and
 * chunked bodies are cancelled as soon as the cap is crossed. Never
 * calls `req.text()` on an unbounded stream.
 */
async function readLoginFormBody(
  c: Context,
): Promise<{ ok: true; text: string } | { ok: false }> {
  const lengthHeader = c.req.header("content-length");
  if (lengthHeader !== undefined) {
    const trimmed = lengthHeader.trim();
    if (!/^\d+$/.test(trimmed)) {
      return { ok: false };
    }
    const declared = Number(trimmed);
    if (!Number.isSafeInteger(declared) || declared > MAX_LOGIN_FORM_BYTES) {
      try {
        await c.req.raw.body?.cancel();
      } catch {
        // Best effort: the request is rejected regardless.
      }
      return { ok: false };
    }
  }
  const stream = c.req.raw.body;
  if (stream === null || stream === undefined) {
    return { ok: true, text: "" };
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value !== undefined) {
        total += value.byteLength;
        if (total > MAX_LOGIN_FORM_BYTES) {
          try {
            await reader.cancel();
          } catch {
            // Best effort: the request is rejected regardless.
          }
          return { ok: false };
        }
        chunks.push(value);
      }
    }
  } catch {
    return { ok: false };
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Best effort.
    }
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return {
      ok: true,
      text: new TextDecoder("utf-8", { fatal: true }).decode(combined),
    };
  } catch {
    return { ok: false };
  }
}

function requireIdempotencyKey(
  c: Context,
): { key: string } | { response: Response } {
  const key = c.req.header("idempotency-key");
  if (key === undefined || !isUuidV4(key)) {
    return {
      response: validationError(c, "idempotency-key must be a UUID v4"),
    };
  }
  return { key };
}

function requireUuid(
  c: Context,
  value: string,
  what: string,
): { id: string } | { response: Response } {
  if (!isUuidV4(value)) {
    return { response: validationError(c, `${what} must be a UUID v4`) };
  }
  return { id: value };
}

async function readJsonBody(
  c: Context,
): Promise<{ ok: true; value: unknown; bytes: number } | { ok: false }> {
  // Early Content-Length gate: reject without streaming when the declared
  // size already exceeds the byte cap. Malformed lengths fail closed.
  const lengthHeader = c.req.header("content-length");
  if (lengthHeader !== undefined) {
    const trimmed = lengthHeader.trim();
    if (!/^\d+$/.test(trimmed)) {
      return { ok: false };
    }
    const declared = Number(trimmed);
    if (!Number.isSafeInteger(declared) || declared > MAX_BODY_BYTES) {
      try {
        await c.req.raw.body?.cancel();
      } catch {
        // Best effort: the request is rejected regardless.
      }
      return { ok: false };
    }
  }
  const stream = c.req.raw.body;
  if (stream === null || stream === undefined) {
    return { ok: true, value: {}, bytes: 0 };
  }
  // Byte-bounded streaming accumulation: count raw UTF-8 bytes per chunk
  // (multibyte sequences count as their encoded length) and stop/cancel
  // as soon as the cap is crossed. Never call req.text()/arrayBuffer().
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value !== undefined) {
        total += value.byteLength;
        if (total > MAX_BODY_BYTES) {
          try {
            await reader.cancel();
          } catch {
            // Best effort: the request is rejected regardless.
          }
          return { ok: false };
        }
        chunks.push(value);
      }
    }
  } catch {
    return { ok: false };
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Best effort.
    }
  }
  if (total === 0) {
    return { ok: true, value: {}, bytes: 0 };
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(combined);
    if (text.length === 0) {
      return { ok: true, value: {}, bytes: 0 };
    }
    return { ok: true, value: JSON.parse(text) as unknown, bytes: total };
  } catch {
    return { ok: false };
  }
}

/**
 * Strict query gate: unknown keys and duplicated keys are validation
 * errors. Returns first-value mappings for the exact allowed keys so Zod
 * defaults/coercions keep their agreed behavior.
 */
function strictQuery(
  c: Context,
  allowed: readonly string[],
): { ok: true; values: Record<string, string | undefined> } | { ok: false } {
  const params = new URL(c.req.url).searchParams;
  const seen = new Map<string, number>();
  for (const key of params.keys()) {
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  for (const count of seen.values()) {
    if (count > 1) {
      return { ok: false };
    }
  }
  for (const key of seen.keys()) {
    if (!allowed.includes(key)) {
      return { ok: false };
    }
  }
  const values: Record<string, string | undefined> = {};
  for (const name of allowed) {
    const value = params.get(name);
    values[name] = value ?? undefined;
  }
  return { ok: true, values };
}

/** Fixed domain-error to HTTP mapping (§12.3). No raw errors leak. */
function mapDomainError(c: Context, error: unknown): Response {
  if (
    error instanceof RepositoryValidationError ||
    error instanceof ServerConfigError
  ) {
    return validationError(c);
  }
  if (error instanceof RepositoryNotFoundError) {
    return apiError(c, 404, "not_found", "resource not found");
  }
  if (error instanceof IdempotencyConflictError) {
    return apiError(
      c,
      409,
      "idempotency_key_reused",
      "idempotency key already used",
    );
  }
  if (error instanceof SessionBusyError) {
    return apiError(
      c,
      409,
      "session_busy",
      "session already has an active run",
    );
  }
  // M5 proposal decision mapping (§18.4): both are 409 with fixed
  // lowercase codes and fixed safe messages (same pattern as the M1
  // reference codes; the codes live outside the frozen ApiErrorCode enum).
  if (error instanceof ProposalStateConflictError) {
    return c.json(
      {
        error: {
          code: "proposal_state_conflict",
          message: "proposal state conflict",
        },
      },
      409,
    );
  }
  if (error instanceof ProposalHashMismatchError) {
    return c.json(
      {
        error: {
          code: "proposal_hash_mismatch",
          message: "proposal hash mismatch",
        },
      },
      409,
    );
  }
  // C21 cancellation boundary (§18.5): a committed external-call marker can
  // never be "cancelled after the fact" — fixed 409 with a fixed safe message.
  if (error instanceof ActionNotCancellableError) {
    return c.json(
      {
        error: {
          code: "action_not_cancellable",
          message: "action run is no longer cancellable",
        },
      },
      409,
    );
  }
  // M1 stored-only reference mapping (§14.8): fixed lowercase codes with
  // fixed safe messages. Domain messages/IDs/content never leak.
  if (error instanceof ReferenceNotFoundError) {
    return c.json(
      {
        error: { code: "reference_not_found", message: "reference not found" },
      },
      404,
    );
  }
  if (error instanceof ReferenceVersionConflictError) {
    return c.json(
      {
        error: {
          code: "reference_version_conflict",
          message: "reference version conflict",
        },
      },
      409,
    );
  }
  if (error instanceof InvalidReferenceError) {
    return c.json(
      { error: { code: "invalid_reference", message: "invalid reference" } },
      400,
    );
  }
  // AV autonomy slice: CAS version conflicts and illegal lifecycle
  // transitions map to fixed 409 codes (same shape as the M5 proposal
  // codes above; outside the frozen ApiErrorCode enum).
  if (error instanceof AutonomyVersionConflictError) {
    return c.json(
      {
        error: {
          code: "autonomy_version_conflict",
          message: "autonomy version conflict",
        },
      },
      409,
    );
  }
  if (error instanceof AutonomyStateConflictError) {
    return c.json(
      {
        error: {
          code: "autonomy_state_conflict",
          message: "autonomy state conflict",
        },
      },
      409,
    );
  }
  // AV04 learning slice: CAS version conflicts and illegal lifecycle
  // transitions / invalid evidence anchors map to fixed 409 codes (same
  // shape as the autonomy codes above; outside the frozen ApiErrorCode
  // enum). Ownership failures stay 404 above.
  if (error instanceof LearningVersionConflictError) {
    return c.json(
      {
        error: {
          code: "learning_version_conflict",
          message: "learning version conflict",
        },
      },
      409,
    );
  }
  if (error instanceof LearningStateConflictError) {
    return c.json(
      {
        error: {
          code: "learning_state_conflict",
          message: "learning state conflict",
        },
      },
      409,
    );
  }
  // AV03 delegation-handoff slice: CAS version conflicts and illegal
  // lifecycle transitions / invalid verification inputs map to fixed 409
  // codes (same shape as the autonomy codes above). Ownership failures
  // stay 404 above.
  if (error instanceof HandoffVersionConflictError) {
    return c.json(
      {
        error: {
          code: "handoff_version_conflict",
          message: "handoff version conflict",
        },
      },
      409,
    );
  }
  if (error instanceof HandoffStateConflictError) {
    return c.json(
      {
        error: {
          code: "handoff_state_conflict",
          message: "handoff state conflict",
        },
      },
      409,
    );
  }
  // AV shadow slice: CAS version conflicts, illegal lifecycle transitions,
  // and lease races map to fixed 409 codes (same shape as the autonomy
  // codes above; outside the frozen ApiErrorCode enum). No 500 swallows a
  // security-relevant conflict; ownership failures stay 404 above.
  if (error instanceof ShadowVersionConflictError) {
    return c.json(
      {
        error: {
          code: "shadow_version_conflict",
          message: "shadow version conflict",
        },
      },
      409,
    );
  }
  if (error instanceof ShadowStateConflictError) {
    return c.json(
      {
        error: {
          code: "shadow_state_conflict",
          message: "shadow state conflict",
        },
      },
      409,
    );
  }
  if (error instanceof ShadowLeaseConflictError) {
    return c.json(
      {
        error: {
          code: "shadow_lease_conflict",
          message: "shadow lease conflict",
        },
      },
      409,
    );
  }
  // AV05 notification slice: an explicit ack under a stable key on a
  // DIFFERENT notification (or a second key on an acked one) is a fixed
  // 409; a renumbered durable source refuses with a fixed 409 (never an
  // auto-reset, never dropped notices). Ownership stays 404 above.
  if (error instanceof NotificationKeyConflictError) {
    return c.json(
      {
        error: {
          code: "notification_key_conflict",
          message: "notification ack key conflict",
        },
      },
      409,
    );
  }
  if (error instanceof NotificationProjectionResetError) {
    return c.json(
      {
        error: {
          code: "notification_projection_reset_required",
          message: "notification projection reset required",
        },
      },
      409,
    );
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "server_shutting_down"
  ) {
    return shuttingDown(c);
  }
  return apiError(c, 500, "internal_error", "internal error");
}

export function createApp(deps: CreateAppDeps): CreatedServerApp {
  const { config, repo, engine } = deps;
  const actionsEnabled = deps.actionsEnabled === true;
  const createEnabled = deps.createEnabled === true;
  const memory = deps.memory ?? null;
  const shadowWake = deps.shadowWake;
  const shadowControlChanged = deps.shadowControlChanged;
  const logger = deps.logger ?? createStdServerLogger(config.logLevel);
  const now = deps.now ?? Date.now;
  const assets = deps.assets ?? {};
  /**
   * Slice (b) remote session wiring. Fail closed at composition time:
   * an enabled remote config without BOTH the token-hash store and the
   * password verifier refuses to compose (bootstrap supplies both from
   * the password file + migrated DB). Disabled remote ignores both.
   */
  const remote = remoteConfigOf(config);
  const remoteStore = deps.remoteStore ?? null;
  const remotePassword = deps.remotePassword ?? null;
  if (remote !== null && (remoteStore === null || remotePassword === null)) {
    throw new ServerConfigError("remote mode requires session wiring");
  }
  /**
   * Global login failure counter with lockout (design §3). Deliberately
   * NOT keyed by IP: every proxied request arrives from 127.0.0.1, so an
   * IP key would either lock the single operator out behind any failure
   * or never trigger. In-memory only: RESETS ON RESTART (README).
   */
  const loginLimiter: RemoteLoginRateLimiter | null =
    remote !== null
      ? createRemoteLoginRateLimiter({
          maxFailures: remote.maxFailures,
          lockoutMs: remote.lockoutMs,
        })
      : null;
  const hasSession = (c: Context): boolean => {
    if (remote === null || remoteStore === null) {
      return false;
    }
    return hasValidRemoteSession(c, config, remoteStore, now);
  };
  let draining = false;
  const controls: ServerControls = {
    get draining() {
      return draining;
    },
    markDraining: () => {
      draining = true;
    },
  };
  /**
   * Wake the shadow worker after a COMMITTED state change. Synchronous and
   * throw-guarded: a wake failure can never unwind a committed user command
   * (or a committed control/explicit-request write).
   */
  const wakeShadow = (): void => {
    try {
      shadowWake?.();
    } catch {
      // Best effort: the mutation already committed.
    }
  };
  /**
   * Notify the shadow worker of a COMMITTED control change. Synchronous
   * and throw-guarded like `wakeShadow`: the worker reads the ACTUAL
   * current control state (never a stored replay reply) and aborts its OWN
   * in-flight call when paused, so a pure STOP aborts model/recall work
   * with no foreground chat involved.
   */
  const notifyShadowControl = (): void => {
    try {
      shadowControlChanged?.();
    } catch {
      // Best effort: the control change already committed.
    }
  };

  const app = new Hono();

  // Strict Host validation for every route (health included).
  app.use(async (c, next) => {
    const rejected = checkHost(c, config);
    if (rejected !== null) {
      return rejected;
    }
    await next();
  });

  // Mutation security for every mutation route; slice (a) read-path
  // security additionally covers GET/HEAD API routes (SSE included) when
  // remote mode is enabled. Disabled remote leaves reads untouched.
  // Slice (b): the login route is exempt here and enforces its own
  // Origin + content-type gate (it must also accept the no-asset HTML
  // login form's urlencoded POST, which the JSON-only gate would refuse).
  app.use(async (c, next) => {
    if (isMutationMethod(c.req.method)) {
      if (
        !(
          remote !== null &&
          c.req.method === "POST" &&
          c.req.path === "/api/remote/login"
        )
      ) {
        const rejected = checkMutationSecurity(c, config);
        if (rejected !== null) {
          return rejected;
        }
      }
    } else if (
      (c.req.method === "GET" || c.req.method === "HEAD") &&
      c.req.path.startsWith("/api/")
    ) {
      const rejected = checkReadSecurity(c, config);
      if (rejected !== null) {
        return rejected;
      }
    }
    await next();
  });

  // Slice (b) session enforcement. Disabled remote: no-op (every route
  // behaves exactly as before). Enabled remote: EVERY API route and the
  // SSE handshake requires a valid session (401 JSON, including SSE —
  // the EventSource handshake carries the HttpOnly cookie automatically).
  // `/health/live` stays unauthenticated (process liveness only);
  // `/health/ready` requires a session (it reflects internal state).
  // The login/logout endpoints and the UI shell path stay reachable so
  // an unauthenticated browser can reach the no-asset login form.
  app.use(async (c, next) => {
    if (remote === null) {
      await next();
      return;
    }
    const path = c.req.path;
    const method = c.req.method;
    if (method === "GET" && path === "/health/live") {
      await next();
      return;
    }
    if (path === "/api/remote/login" || path === "/api/remote/logout") {
      await next();
      return;
    }
    if ((method === "GET" || method === "HEAD") && path === "/") {
      await next();
      return;
    }
    if (!hasSession(c)) {
      return remoteUnauthenticated(c);
    }
    await next();
  });

  app.onError((error, c) => mapDomainError(c, error));

  app.notFound((c) => apiError(c, 404, "not_found", "resource not found"));

  /**
   * Draining replay for POST messages: returns the stored response verbatim
   * (exact status/body) when this exact request was already accepted, else
   * null so the caller rejects with 503. A lookup miss means the key is
   * fresh and the kernel is never invoked (no persistence during drain). A
   * lookup hit delegates hash verification to repo.postMessage, which
   * replays without side effects on match and throws (no persistence) on
   * request-hash mismatch; both non-replay outcomes map to null (→ 503).
   * Fully synchronous: no await between the draining re-check and the
   * queue call, so no drain can interleave.
   */
  function tryReplayStoredMessage(
    c: Context,
    sessionId: string,
    key: string,
    text: string,
    uiContext: Record<string, unknown>,
    started: number,
  ): Response | null {
    let stored: ReturnType<typeof repo.lookupIdempotencyForSession>;
    try {
      stored = repo.lookupIdempotencyForSession(
        sessionId,
        key,
        messageScope(sessionId),
      );
    } catch {
      return null;
    }
    if (!stored.found) {
      return null;
    }
    try {
      const out = repo.postMessage(
        sessionId,
        { text, uiContext },
        { key, now: now(), timeZone: config.timeZone },
      );
      if (!out.replayed) {
        return null;
      }
      const body = PostMessageResponseSchema.parse(out.body);
      logger.info("http.sessions.messages", {
        sessionId,
        turnId: body.turnId,
        status: out.status,
        durationMs: Math.max(now() - started, 0),
      });
      return c.json(body, out.status as 202);
    } catch {
      return null;
    }
  }

  /**
   * Draining replay for POST retries: same contract as
   * tryReplayStoredMessage but scoped to `turn:{turnId}:retry` via
   * repo.postRetry (which additionally enforces session/turn ownership on
   * the stored body; drift maps to null → 503).
   */
  function tryReplayStoredRetry(
    c: Context,
    sessionId: string,
    turnId: string,
    key: string,
    started: number,
  ): Response | null {
    let stored: ReturnType<typeof repo.lookupIdempotencyForSession>;
    try {
      stored = repo.lookupIdempotencyForSession(
        sessionId,
        key,
        retryScope(turnId),
      );
    } catch {
      return null;
    }
    if (!stored.found) {
      return null;
    }
    try {
      const out = repo.postRetry(sessionId, turnId, {
        key,
        now: now(),
      });
      if (!out.replayed) {
        return null;
      }
      const body = PostMessageResponseSchema.parse(out.body);
      logger.info("http.sessions.retries", {
        sessionId,
        turnId,
        status: out.status,
        durationMs: Math.max(now() - started, 0),
      });
      return c.json(body, out.status as 202);
    } catch {
      return null;
    }
  }

  /**
   * Draining replay for POST proposal approve: same contract as
   * tryReplayStoredMessage but scoped to `proposal:{proposalId}:approve`
   * via repo.approveProposal (which additionally enforces session/proposal
   * ownership on the stored body; drift maps to null → 503).
   *
   * A stored key is authoritative: a permanent stored-key conflict (same
   * committed key, different request hash) replays as the existing 409
   * `idempotency_key_reused` via mapDomainError, and a session/proposal
   * ownership drift replays as the existing 404. Only a fresh key (lookup
   * miss, kernel never invoked, nothing persisted) or a transient failure
   * falls through to null (→ 503).
   */
  function tryReplayStoredApprove(
    c: Context,
    sessionId: string,
    proposalId: string,
    proposalHash: string,
    key: string,
    started: number,
  ): Response | null {
    let stored: ReturnType<typeof repo.lookupIdempotencyForSession>;
    try {
      stored = repo.lookupIdempotencyForSession(
        sessionId,
        key,
        proposalApproveScope(proposalId),
      );
    } catch {
      return null;
    }
    if (!stored.found) {
      return null;
    }
    try {
      const out = repo.approveProposal(
        sessionId,
        proposalId,
        { proposalHash },
        { key, now: now() },
      );
      if (!out.replayed) {
        return null;
      }
      const body = ProposalApprove202ResponseSchema.parse(out.body);
      logger.info("http.proposals.approve", {
        sessionId,
        proposalId,
        status: out.status,
        durationMs: Math.max(now() - started, 0),
      });
      return c.json(body, out.status as 202);
    } catch (error) {
      if (
        error instanceof IdempotencyConflictError ||
        error instanceof RepositoryNotFoundError
      ) {
        return mapDomainError(c, error);
      }
      return null;
    }
  }

  /* ---------------- health (exact, §12.5) ---------------- */

  app.get("/health/live", (c) => c.json({ status: "live" }, 200));

  app.get("/health/ready", (c) => {
    // Slice (b): readiness reflects internal state, so remote mode
    // requires a session here (liveness stays open above). Disabled
    // remote keeps the historical open behavior.
    if (remote !== null && !hasSession(c)) {
      return remoteUnauthenticated(c);
    }
    if (draining) {
      return c.json({ status: "not_ready", code: "server_shutting_down" }, 503);
    }
    return c.json({ status: "ready" }, 200);
  });

  /* ---------------- slice (b) remote login/logout ---------------- */
  //
  // Single-user password login issuing the opaque session cookie.
  // Uniform failure message (no user enumeration): a wrong password and
  // a missing account state are indistinguishable. The global lockout
  // answers 429 only while a lockout is already in force; the attempt
  // that TRIGGERS the lockout still answers the uniform 401.

  app.post("/api/remote/login", async (c) => {
    if (remote === null || remoteStore === null || remotePassword === null) {
      return apiError(c, 404, "not_found", "resource not found");
    }
    if (!strictQuery(c, []).ok) {
      return validationError(c);
    }
    const originRejected = checkLoginOrigin(c, config);
    if (originRejected !== null) {
      return originRejected;
    }
    const contentType = c.req.header("content-type");
    const mediaType =
      contentType === undefined
        ? null
        : (contentType.split(";")[0]?.trim().toLowerCase() ?? null);
    let password: unknown;
    if (mediaType === "application/json") {
      const raw = await readJsonBody(c);
      if (!raw.ok || typeof raw.value !== "object" || raw.value === null) {
        return validationError(c);
      }
      const keys = Object.keys(raw.value as Record<string, unknown>);
      if (keys.length !== 1 || keys[0] !== "password") {
        return validationError(c);
      }
      password = (raw.value as { password?: unknown }).password;
    } else if (mediaType === "application/x-www-form-urlencoded") {
      const formRaw = await readLoginFormBody(c);
      if (!formRaw.ok) {
        return validationError(c);
      }
      const form = parseLoginFormBody(formRaw.text);
      if (!form.ok) {
        return validationError(c);
      }
      password = form.password;
    } else {
      return validationError(c, "content-type must be application/json");
    }
    if (typeof password !== "string") {
      return validationError(c);
    }
    const t = now();
    if (loginLimiter?.isLocked(t) === true) {
      return c.json(
        { error: { code: "rate_limited", message: "too many attempts" } },
        429,
      );
    }
    let ok = false;
    try {
      ok = remotePassword.verify(password);
    } catch {
      ok = false;
    }
    if (!ok) {
      loginLimiter?.recordFailure(t);
      return c.json(
        {
          error: {
            code: "invalid_credentials",
            message: "invalid credentials",
          },
        },
        401,
      );
    }
    loginLimiter?.reset();
    const token = issueRemoteToken();
    try {
      remoteStore.create(
        hashRemoteToken(token),
        t,
        t + remote.absoluteTimeoutMs,
      );
    } catch {
      return apiError(c, 500, "internal_error", "internal error");
    }
    logger.info("http.remote.login", {
      status: 200,
      durationMs: Math.max(now() - t, 0),
    });
    c.header(
      "Set-Cookie",
      remoteSessionSetCookie(
        token,
        Math.max(Math.floor(remote.absoluteTimeoutMs / 1000), 1),
      ),
    );
    c.header("cache-control", "no-store");
    if (mediaType === "application/x-www-form-urlencoded") {
      // No-script browser form: redirect into the app shell so the login
      // lands on the conversation UI. API (JSON) clients keep the JSON
      // response below; the session cookie is already set above.
      return c.redirect("/", 303);
    }
    return c.json({ ok: true }, 200);
  });

  app.post("/api/remote/logout", async (c) => {
    if (remote === null || remoteStore === null) {
      return apiError(c, 404, "not_found", "resource not found");
    }
    if (!strictQuery(c, []).ok) {
      return validationError(c);
    }
    const token = remoteTokenFromCookieHeader(c.req.header("cookie"));
    if (token !== null) {
      try {
        remoteStore.revoke(hashRemoteToken(token));
      } catch {
        // Best effort: the cookie is cleared regardless.
      }
    }
    logger.info("http.remote.logout", { status: 200 });
    c.header("Set-Cookie", remoteSessionClearCookie());
    c.header("cache-control", "no-store");
    return c.json({ ok: true }, 200);
  });

  /* ---------------- sessions ---------------- */

  app.post("/api/sessions", async (c) => {
    const started = now();
    const keyed = requireIdempotencyKey(c);
    if ("response" in keyed) {
      return keyed.response;
    }
    const raw = await readJsonBody(c);
    if (!raw.ok) {
      return validationError(c);
    }
    if (CreateSessionRequestSchema.safeParse(raw.value).success !== true) {
      return validationError(c);
    }
    try {
      const out = repo.createSession({ key: keyed.key, now: now() });
      const body = CreateSessionResponseSchema.parse(out.body);
      logger.info("http.sessions.create", {
        status: out.status,
        durationMs: Math.max(now() - started, 0),
      });
      return c.json(body, out.status as 201);
    } catch (error) {
      return mapDomainError(c, error);
    }
  });

  /* ---------------- messages ---------------- */

  app.post("/api/sessions/:sessionId/messages", async (c) => {
    const started = now();
    // No early draining reject here: the admission gate runs after body
    // await/validation so a stored idempotency replay wins over 503.
    const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
    if ("response" in session) {
      return session.response;
    }
    const keyed = requireIdempotencyKey(c);
    if ("response" in keyed) {
      return keyed.response;
    }
    const raw = await readJsonBody(c);
    if (!raw.ok) {
      return validationError(c);
    }
    const parsedBody = PostMessageRequestSchema.safeParse(raw.value);
    if (!parsedBody.success) {
      return validationError(c);
    }
    // Draining admission re-check immediately before queueing (no await
    // between here and repo.postMessage, so a drain that begins mid-flight
    // cannot slip a fresh mutation into the queue). A stored response for
    // this exact request replays verbatim instead of 503; everything else
    // is rejected without persisting.
    if (draining) {
      const replayed = tryReplayStoredMessage(
        c,
        session.id,
        keyed.key,
        parsedBody.data.text,
        parsedBody.data.uiContext as Record<string, unknown>,
        started,
      );
      if (replayed !== null) {
        return replayed;
      }
      return shuttingDown(c);
    }
    try {
      const out = repo.postMessage(
        session.id,
        {
          text: parsedBody.data.text,
          uiContext: parsedBody.data.uiContext as Record<string, unknown>,
        },
        { key: keyed.key, now: now(), timeZone: config.timeZone },
      );
      const body = PostMessageResponseSchema.parse(out.body);
      logger.info("http.sessions.messages", {
        sessionId: session.id,
        turnId: body.turnId,
        status: out.status,
        bytes: raw.bytes,
        durationMs: Math.max(now() - started, 0),
      });
      return c.json(body, out.status as 202);
    } catch (error) {
      return mapDomainError(c, error);
    }
  });

  /* ---------------- retries ---------------- */

  app.post("/api/sessions/:sessionId/turns/:turnId/retries", async (c) => {
    const started = now();
    // No early draining reject here: the admission gate runs after body
    // await/validation so a stored idempotency replay wins over 503.
    const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
    if ("response" in session) {
      return session.response;
    }
    const turn = requireUuid(c, c.req.param("turnId"), "turnId");
    if ("response" in turn) {
      return turn.response;
    }
    const keyed = requireIdempotencyKey(c);
    if ("response" in keyed) {
      return keyed.response;
    }
    const raw = await readJsonBody(c);
    if (!raw.ok) {
      return validationError(c);
    }
    if (PostRetryRequestSchema.safeParse(raw.value).success !== true) {
      return validationError(c);
    }
    // Draining admission re-check immediately before queueing (no await
    // between here and repo.postRetry, so a drain that begins mid-flight
    // cannot slip a fresh mutation into the queue). A stored response for
    // this exact request replays verbatim instead of 503; everything else
    // is rejected without persisting.
    if (draining) {
      const replayed = tryReplayStoredRetry(
        c,
        session.id,
        turn.id,
        keyed.key,
        started,
      );
      if (replayed !== null) {
        return replayed;
      }
      return shuttingDown(c);
    }
    try {
      const out = repo.postRetry(session.id, turn.id, {
        key: keyed.key,
        now: now(),
      });
      const body = PostMessageResponseSchema.parse(out.body);
      logger.info("http.sessions.retries", {
        sessionId: session.id,
        turnId: turn.id,
        status: out.status,
        durationMs: Math.max(now() - started, 0),
      });
      return c.json(body, out.status as 202);
    } catch (error) {
      return mapDomainError(c, error);
    }
  });

  /* ---------------- cancel (keyless, state-idempotent) ---------------- */

  app.post("/api/sessions/:sessionId/runs/:runId/cancel", async (c) => {
    const started = now();
    const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
    if ("response" in session) {
      return session.response;
    }
    const run = requireUuid(c, c.req.param("runId"), "runId");
    if ("response" in run) {
      return run.response;
    }
    const raw = await readJsonBody(c);
    if (!raw.ok) {
      return validationError(c);
    }
    // Strict cancel body: exactly {} (reject arrays/scalars/unknown keys).
    if (CancelRunRequestSchema.safeParse(raw.value).success !== true) {
      return validationError(c);
    }
    try {
      // Engine.cancel commits the DB transition first, then aborts (§11.3).
      const out = engine.cancel(session.id, run.id);
      const body = CancelRunResponseSchema.parse({
        run: { id: run.id, status: out.status },
      });
      logger.info("http.runs.cancel", {
        sessionId: session.id,
        runId: run.id,
        status: out.status,
        durationMs: Math.max(now() - started, 0),
      });
      return c.json(body, 200);
    } catch (error) {
      return mapDomainError(c, error);
    }
  });

  /* ---------------- C18 proposals (§18.4) ---------------- */

  // Bounded proposed-action list (session-scoped, ordered newest-first).
  app.get("/api/sessions/:sessionId/proposals", (c) => {
    const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
    if ("response" in session) {
      return session.response;
    }
    if (!strictQuery(c, []).ok) {
      return validationError(c);
    }
    try {
      const body = repo.listProposals(session.id);
      ProposalsListResponseSchema.parse(body);
      return c.json(body, 200);
    } catch (error) {
      return mapDomainError(c, error);
    }
  });

  // Approve (keyed, exactly-once external write): strict `{ proposalHash }`
  // body. No early draining reject: a stored idempotency replay wins over
  // 503 (same admission pattern as messages/retries).
  app.post(
    "/api/sessions/:sessionId/proposals/:proposalId/approve",
    async (c) => {
      const started = now();
      const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
      if ("response" in session) {
        return session.response;
      }
      const proposal = requireUuid(c, c.req.param("proposalId"), "proposalId");
      if ("response" in proposal) {
        return proposal.response;
      }
      const keyed = requireIdempotencyKey(c);
      if ("response" in keyed) {
        return keyed.response;
      }
      const raw = await readJsonBody(c);
      if (!raw.ok) {
        return validationError(c);
      }
      const parsedBody = ProposalApproveRequestSchema.safeParse(raw.value);
      if (!parsedBody.success) {
        return validationError(c);
      }
      // Per-tool disabled composition: resolve the proposal FIRST
      // (ownership-safe bounded read, no mutation), then admit ONLY the
      // tool's own surface BEFORE any repository mutation/grant/queue.
      // A pending create staged before restart is refused after
      // createEnabled is turned off even while reschedule stays enabled,
      // and vice versa. Fixed 409 code, no ids or content in the body.
      // Foreign/unknown proposals stay 404; hash/replay semantics live
      // inside repo.approveProposal below and are unchanged here.
      let proposalTool: string;
      try {
        const listed = repo.listProposals(session.id);
        const found = listed.proposals.find(
          (entry) => entry.proposalId === proposal.id,
        );
        if (found === undefined) {
          return apiError(c, 404, "not_found", "resource not found");
        }
        proposalTool = found.tool;
      } catch (error) {
        return mapDomainError(c, error);
      }
      const toolEnabled =
        proposalTool === "calendar.create"
          ? createEnabled === true
          : proposalTool === "calendar.reschedule"
            ? actionsEnabled === true
            : false;
      if (toolEnabled !== true) {
        return c.json(
          {
            error: {
              code: "action_execution_disabled",
              message: "action execution is disabled",
            },
          },
          409,
        );
      }
      // Draining admission re-check immediately before the repository call
      // (no await between here and repo.approveProposal). A stored response
      // for this exact request replays verbatim instead of 503; anything
      // else is rejected without persisting.
      if (draining) {
        const replayed = tryReplayStoredApprove(
          c,
          session.id,
          proposal.id,
          parsedBody.data.proposalHash,
          keyed.key,
          started,
        );
        if (replayed !== null) {
          return replayed;
        }
        return shuttingDown(c);
      }
      try {
        const out = repo.approveProposal(
          session.id,
          proposal.id,
          { proposalHash: parsedBody.data.proposalHash },
          { key: keyed.key, now: now(), timeZone: config.timeZone },
        );
        const body = ProposalApprove202ResponseSchema.parse(out.body);
        logger.info("http.proposals.approve", {
          sessionId: session.id,
          proposalId: proposal.id,
          status: out.status,
          bytes: raw.bytes,
          durationMs: Math.max(now() - started, 0),
        });
        return c.json(body, out.status as 202);
      } catch (error) {
        return mapDomainError(c, error);
      }
    },
  );

  // Execution + receipt read for ONE session-owned proposal (C22): the real
  // persisted execution status, the external-call marker (the exact Stop
  // boundary), and the real receipt once terminal. Bounded read, no writes.
  app.get("/api/sessions/:sessionId/proposals/:proposalId/execution", (c) => {
    const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
    if ("response" in session) {
      return session.response;
    }
    const proposal = requireUuid(c, c.req.param("proposalId"), "proposalId");
    if ("response" in proposal) {
      return proposal.response;
    }
    if (!strictQuery(c, []).ok) {
      return validationError(c);
    }
    try {
      const body = ProposalExecutionViewSchema.parse(
        repo.getProposalExecution(session.id, proposal.id),
      );
      return c.json(body, 200);
    } catch (error) {
      return mapDomainError(c, error);
    }
  });

  // Reject (KEYLESS, state-idempotent): strict `{ proposalHash }` body;
  // Idempotency-Key is deliberately not used (§18.4). No draining gate: a
  // reject creates no Run and no queued work (same family as Cancel).
  app.post(
    "/api/sessions/:sessionId/proposals/:proposalId/reject",
    async (c) => {
      const started = now();
      const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
      if ("response" in session) {
        return session.response;
      }
      const proposal = requireUuid(c, c.req.param("proposalId"), "proposalId");
      if ("response" in proposal) {
        return proposal.response;
      }
      if (c.req.header("idempotency-key") !== undefined) {
        // Keyless route: carrying a key is not this route's invention.
        return validationError(c, "idempotency-key is not used for reject");
      }
      const raw = await readJsonBody(c);
      if (!raw.ok) {
        return validationError(c);
      }
      const parsedBody = ProposalRejectRequestSchema.safeParse(raw.value);
      if (!parsedBody.success) {
        return validationError(c);
      }
      try {
        const out = repo.rejectProposal(
          session.id,
          proposal.id,
          { proposalHash: parsedBody.data.proposalHash },
          { now: now(), timeZone: config.timeZone },
        );
        const body = ProposalRejectResponseSchema.parse(out.body);
        logger.info("http.proposals.reject", {
          sessionId: session.id,
          proposalId: proposal.id,
          status: out.status,
          bytes: raw.bytes,
          durationMs: Math.max(now() - started, 0),
        });
        return c.json(body, 200);
      } catch (error) {
        return mapDomainError(c, error);
      }
    },
  );

  /* ---------------- history ---------------- */

  app.get("/api/sessions/:sessionId/history", (c) => {
    const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
    if ("response" in session) {
      return session.response;
    }
    const gated = strictQuery(c, ["beforePosition", "limit"]);
    if (!gated.ok) {
      return validationError(c);
    }
    const parsed = HistoryQuerySchema.safeParse({
      beforePosition: gated.values.beforePosition,
      limit: gated.values.limit,
    });
    if (!parsed.success) {
      return validationError(c);
    }
    try {
      const historyQuery: { beforePosition?: number; limit?: number } = {
        limit: parsed.data.limit,
      };
      if (parsed.data.beforePosition !== undefined) {
        historyQuery.beforePosition = parsed.data.beforePosition;
      }
      const body = repo.getHistory(session.id, historyQuery);
      return c.json(body, 200);
    } catch (error) {
      return mapDomainError(c, error);
    }
  });

  /* ---------------- events ---------------- */

  app.get("/api/sessions/:sessionId/runs/:runId/events", (c) => {
    const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
    if ("response" in session) {
      return session.response;
    }
    const run = requireUuid(c, c.req.param("runId"), "runId");
    if ("response" in run) {
      return run.response;
    }
    const gatedEvents = strictQuery(c, ["after", "limit"]);
    if (!gatedEvents.ok) {
      return validationError(c);
    }
    const parsed = EventsQuerySchema.safeParse({
      after: gatedEvents.values.after,
      limit: gatedEvents.values.limit,
    });
    if (!parsed.success) {
      return validationError(c);
    }
    try {
      const body = repo.getEvents(session.id, run.id, {
        after: parsed.data.after,
        limit: parsed.data.limit,
      });
      return c.json(body, 200);
    } catch (error) {
      return mapDomainError(c, error);
    }
  });

  /* ---------------- run status (M3 cursor validation, §16.7) ---------------- */
  // Lightweight validated run status: exposes the authoritative
  // `runs.event_seq` (+ status) so the client can detect an over-large
  // stored cursor on an ACTIVE run. The frozen events pages cannot serve
  // this: an empty page echoes the request `after` as `nextAfter`, making
  // the over-large cursor invisible there. Session ownership enforced
  // (foreign runs are 404, never 403); strict empty query.
  app.get("/api/sessions/:sessionId/runs/:runId/status", (c) => {
    const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
    if ("response" in session) {
      return session.response;
    }
    const run = requireUuid(c, c.req.param("runId"), "runId");
    if ("response" in run) {
      return run.response;
    }
    if (!strictQuery(c, []).ok) {
      return validationError(c);
    }
    try {
      const owned = repo.getRun(run.id);
      if (owned.sessionId !== session.id) {
        return apiError(c, 404, "not_found", "resource not found");
      }
      const body = RunStatusResponseSchema.parse({
        run: {
          id: owned.id,
          status: owned.status,
          eventSeq: owned.eventSeq,
          // Additive (I01-06): per-run memory status, metadata only; null
          // stays visible as null (the run reached recall but no marker).
          memoryStatus: owned.memoryStatus,
        },
      });
      return c.json(body, 200);
    } catch (error) {
      return mapDomainError(c, error);
    }
  });

  /* ---------------- active run discovery (C06 reload recovery) ---------------- */
  // Minimal additive read (§16.7): the session's single active Run
  // (queued/running/cancel_requested) projected as `{ id, turnId, status,
  // eventSeq }` for the browser's accepted-202 reload resubscription, or
  // `{ run: null }` for a known session without one. Strict empty query,
  // UUID path param; a missing session 404s before any projection read.
  // Session isolation is inherent: getActiveRun is session-scoped.
  app.get("/api/sessions/:sessionId/active-run", (c) => {
    const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
    if ("response" in session) {
      return session.response;
    }
    if (!strictQuery(c, []).ok) {
      return validationError(c);
    }
    try {
      repo.getSession(session.id);
      const active = repo.getActiveRun(session.id);
      const body = ActiveRunResponseSchema.parse({
        run:
          active === null
            ? null
            : {
                id: active.id,
                turnId: active.turnId,
                status: active.status,
                eventSeq: active.eventSeq,
              },
      });
      return c.json(body, 200);
    } catch (error) {
      return mapDomainError(c, error);
    }
  });

  /* ---------------- idempotency lookup ---------------- */

  app.get("/api/sessions/:sessionId/idempotency/:key", (c) => {
    const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
    if ("response" in session) {
      return session.response;
    }
    const key = requireUuid(c, c.req.param("key"), "idempotency key");
    if ("response" in key) {
      return key.response;
    }
    const gatedScope = strictQuery(c, ["scope"]);
    if (!gatedScope.ok) {
      return validationError(c);
    }
    const parsedQuery = IdempotencyLookupQuerySchema.safeParse({
      scope: gatedScope.values.scope,
    });
    if (!parsedQuery.success) {
      return validationError(c);
    }
    // sessions:create lookups require the path session to exist first,
    // even when nothing is stored (fail closed on ghost sessions).
    if (parsedQuery.data.scope === IDEMPOTENCY_SCOPE_SESSIONS_CREATE) {
      try {
        repo.getSession(session.id);
      } catch (error) {
        return mapDomainError(c, error);
      }
    }
    try {
      const found = repo.lookupIdempotencyForSession(
        session.id,
        key.id,
        parsedQuery.data.scope,
      );
      if (
        found.found &&
        parsedQuery.data.scope === IDEMPOTENCY_SCOPE_SESSIONS_CREATE
      ) {
        // Ownership: the stored session must equal the path session.
        const stored = CreateSessionResponseSchema.safeParse(found.body);
        if (!stored.success || stored.data.sessionId !== session.id) {
          return apiError(c, 404, "not_found", "resource not found");
        }
      }
      return c.json(found, 200);
    } catch (error) {
      return mapDomainError(c, error);
    }
  });

  /* ---------------- M3 conversation UI + SSE (§16) ---------------- */
  // SSR shell (Hono JSX, §16.1) with the strict CSP (§16.7 exact). The shell
  // references only the self-hosted esbuild bundle; no inline scripts.

  app.get("/", (c) => {
    if (!strictQuery(c, []).ok) {
      return validationError(c);
    }
    c.header("Content-Security-Policy", STRICT_CSP);
    c.header("cache-control", "no-store");
    // Slice (b): an unauthenticated browser in remote mode gets the
    // minimal script-free login form (plain HTML form, no script, no
    // external assets; only the shared self-hosted stylesheet for the
    // slice (c) smartphone rules) instead of the app shell. Disabled
    // remote always serves the shell as before.
    if (remote !== null && !hasSession(c)) {
      return c.html(renderRemoteLogin().toString(), 200);
    }
    return c.html(renderConversationShell().toString(), 200);
  });

  app.get("/assets/client.js", (c) => {
    if (!strictQuery(c, []).ok) {
      return validationError(c);
    }
    if (assets.clientJs === undefined) {
      return apiError(c, 404, "not_found", "resource not found");
    }
    c.header("content-type", "text/javascript; charset=utf-8");
    c.header("cache-control", "no-cache");
    return c.body(assets.clientJs, 200);
  });

  app.get("/assets/client.css", (c) => {
    if (!strictQuery(c, []).ok) {
      return validationError(c);
    }
    if (assets.clientCss === undefined) {
      return apiError(c, 404, "not_found", "resource not found");
    }
    c.header("content-type", "text/css; charset=utf-8");
    c.header("cache-control", "no-cache");
    return c.body(assets.clientCss, 200);
  });

  // SSE delivery (§16.4 exact): session ownership enforced (foreign runs are
  // 404), effective cursor = max(valid ?after, valid Last-Event-ID), wire via
  // sse.ts (id = seq, event = run-event, full DTO data, 250ms poll, 15s
  // heartbeat, 5s backpressure grace, terminal + cursor >= event_seq close).
  // Disconnect never cancels the Run (no engine call here).

  app.get("/api/sessions/:sessionId/runs/:runId/events/stream", (c) => {
    const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
    if ("response" in session) {
      return session.response;
    }
    const run = requireUuid(c, c.req.param("runId"), "runId");
    if ("response" in run) {
      return run.response;
    }
    const gated = strictQuery(c, ["after"]);
    if (!gated.ok) {
      return validationError(c);
    }
    const cursor = effectiveCursor(
      gated.values.after,
      c.req.header("last-event-id"),
    );
    try {
      const owned = repo.getRun(run.id);
      if (owned.sessionId !== session.id) {
        return apiError(c, 404, "not_found", "resource not found");
      }
      return createSseResponse(repo, session.id, run.id, cursor);
    } catch (error) {
      return mapDomainError(c, error);
    }
  });

  /* ---------------- explicit memory management (opt-in) ---------------- */
  // Closed explicit management surface over active+retired (archived /
  // superseded excluded by remind `record.search`). Reads never heat,
  // reactivate, or grant feedback; mutations stage EXACTLY ONE durable
  // outbox operation (queued 202, never applied here) for a single
  // explicit mN target (or exactly one same-scope search candidate).
  // Raw canonical ids never cross this boundary; historical mN snapshots
  // are never rebound. While `memory` is null every route 404s (existing
  // memory-disabled behavior preserved).

  function memoryUnavailable(c: Context): Response {
    return c.json(
      { error: { code: "memory_unavailable", message: "memory is disabled" } },
      404,
    );
  }

  function memoryRouteError(
    c: Context,
    code:
      | "needs_clarification"
      | "target_not_found"
      | "state_conflict"
      | "idempotency_conflict"
      | "validation_error"
      | "service_unavailable",
    candidates?: readonly { handle: string; snippet: string; status: string }[],
  ): Response {
    switch (code) {
      case "needs_clarification":
        return c.json(
          {
            error: {
              code: "needs_clarification",
              message: "ambiguous memory target",
            },
            candidates: (candidates ?? []).map((hit) => ({
              handle: hit.handle,
              snippet: hit.snippet,
              status: hit.status,
            })),
          },
          409,
        );
      case "target_not_found":
        return c.json(
          { error: { code: "target_not_found", message: "memory not found" } },
          404,
        );
      case "state_conflict":
        return c.json(
          {
            error: { code: "state_conflict", message: "memory state conflict" },
          },
          409,
        );
      case "idempotency_conflict":
        return apiError(
          c,
          409,
          "idempotency_key_reused",
          "idempotency key already used",
        );
      case "service_unavailable":
        return c.json(
          {
            error: {
              code: "memory_unavailable",
              message: "memory unavailable",
            },
          },
          503,
        );
      default:
        return validationError(c);
    }
  }

  /** Originating run+session binding: the run must belong to the session. */
  function requireOwnedRun(
    c: Context,
    sessionId: string,
    runId: string,
  ): { ok: true } | { ok: false; response: Response } {
    let run: { sessionId: string };
    try {
      run = repo.getRun(runId);
    } catch {
      return { ok: false, response: memoryRouteError(c, "target_not_found") };
    }
    if (run.sessionId !== sessionId) {
      return { ok: false, response: memoryRouteError(c, "target_not_found") };
    }
    return { ok: true };
  }

  function validSearchId(value: string): boolean {
    return value.length >= 1 && value.length <= 256;
  }

  function validHandle(value: string): boolean {
    return /^m[1-9][0-9]*$/.test(value);
  }

  // Explicit search (read, no idempotency key, allowed while draining:
  // reads never stage and never heat). Body carries the originating runId
  // so hits bind to their (sessionId, searchId) scope.
  app.post("/api/sessions/:sessionId/memory/search", async (c) => {
    if (memory === null) {
      return memoryUnavailable(c);
    }
    const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
    if ("response" in session) {
      return session.response;
    }
    const raw = await readJsonBody(c);
    if (!raw.ok) {
      return validationError(c);
    }
    const parsed = MemorySearchRequestSchema.safeParse(raw.value);
    if (!parsed.success) {
      return validationError(c);
    }
    const owned = requireOwnedRun(c, session.id, parsed.data.runId);
    if (!owned.ok) {
      return owned.response;
    }
    try {
      repo.getSession(session.id);
    } catch (error) {
      return mapDomainError(c, error);
    }
    try {
      const out = await memory.searchMemories({
        sessionId: session.id,
        runId: parsed.data.runId,
        query: parsed.data.query,
        limit: parsed.data.limit,
      });
      const body = MemorySearchResponseSchema.parse({
        searchId: out.searchId,
        hits: out.hits.map((hit) => ({ ...hit })),
      });
      return c.json(body, 200);
    } catch (error) {
      const code =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof (error as { code?: unknown }).code === "string"
          ? ((error as { code: string }).code as
              | "validation_error"
              | "service_unavailable")
          : "service_unavailable";
      if (
        error !== null &&
        typeof error === "object" &&
        "name" in error &&
        (error as { name?: unknown }).name === "MemoryManageError"
      ) {
        return memoryRouteError(
          c,
          code === "validation_error"
            ? "validation_error"
            : "service_unavailable",
        );
      }
      return memoryRouteError(c, "service_unavailable");
    }
  });

  // Confirmation detail: immutable cited snapshot vs live current record.
  app.get(
    "/api/sessions/:sessionId/memory/searches/:searchId/items/:handle",
    async (c) => {
      if (memory === null) {
        return memoryUnavailable(c);
      }
      const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
      if ("response" in session) {
        return session.response;
      }
      const searchId = c.req.param("searchId");
      const handle = c.req.param("handle");
      if (!validSearchId(searchId) || !validHandle(handle)) {
        return validationError(c);
      }
      if (!strictQuery(c, []).ok) {
        return validationError(c);
      }
      try {
        repo.getSession(session.id);
      } catch (error) {
        return mapDomainError(c, error);
      }
      try {
        const out = await memory.getMemoryDetail({
          sessionId: session.id,
          searchId,
          handle,
        });
        const body = MemoryDetailResponseSchema.parse({
          snapshot: { ...out.snapshot },
          current: { ...out.current },
          stale: out.stale,
        });
        return c.json(body, 200);
      } catch (error) {
        if (
          error !== null &&
          typeof error === "object" &&
          "name" in error &&
          (error as { name?: unknown }).name === "MemoryManageError"
        ) {
          const code =
            "code" in error &&
            typeof (error as { code?: unknown }).code === "string"
              ? ((error as { code: string }).code as
                  | "target_not_found"
                  | "service_unavailable"
                  | "validation_error")
              : "service_unavailable";
          if (code === "target_not_found") {
            return memoryRouteError(c, "target_not_found");
          }
          if (code === "validation_error") {
            return memoryRouteError(c, "validation_error");
          }
          return memoryRouteError(c, "service_unavailable");
        }
        return memoryRouteError(c, "service_unavailable");
      }
    },
  );

  // Per-run recall exposure for answer citations (read-only, allowed
  // while draining): returns the exact snippet the model saw as `mN`
  // during ONE run. Answer citations bind to their own run's recall
  // exposure, never to the latest explicit management search.
  app.get(
    "/api/sessions/:sessionId/memory/recall/:runId/items/:citation",
    async (c) => {
      if (memory === null) {
        return memoryUnavailable(c);
      }
      const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
      if ("response" in session) {
        return session.response;
      }
      const runId = c.req.param("runId");
      const citation = c.req.param("citation");
      if (!validHandle(citation)) {
        return validationError(c);
      }
      if (!strictQuery(c, []).ok) {
        return validationError(c);
      }
      const owned = requireOwnedRun(c, session.id, runId);
      if (!owned.ok) {
        return owned.response;
      }
      try {
        repo.getSession(session.id);
      } catch (error) {
        return mapDomainError(c, error);
      }
      const out = memory.getMemoryRecallExposure({
        sessionId: session.id,
        runId,
        citation,
      });
      if (out === null) {
        return memoryRouteError(c, "target_not_found");
      }
      const body = MemoryRecallExposureResponseSchema.parse({
        runId: out.runId,
        citation: out.citation,
        snippet: out.snippet,
        revision: out.revision,
        kind: out.kind,
      });
      return c.json(body, 200);
    },
  );

  // Stage one mutation (keyed 202, draining-aware: a stored operation for
  // the same key replays verbatim instead of 503; fresh keys get 503
  // without staging anything).
  app.post("/api/sessions/:sessionId/memory/mutations", async (c) => {
    const started = now();
    if (memory === null) {
      return memoryUnavailable(c);
    }
    const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
    if ("response" in session) {
      return session.response;
    }
    const keyed = requireIdempotencyKey(c);
    if ("response" in keyed) {
      return keyed.response;
    }
    const raw = await readJsonBody(c);
    if (!raw.ok) {
      return validationError(c);
    }
    const parsed = MemoryMutationRequestSchema.safeParse(raw.value);
    if (!parsed.success) {
      return validationError(c);
    }
    if (
      parsed.data.kind === "record.correct" &&
      parsed.data.correctionBody === undefined
    ) {
      return validationError(c);
    }
    if (
      parsed.data.kind !== "record.correct" &&
      parsed.data.correctionBody !== undefined
    ) {
      return validationError(c);
    }
    const owned = requireOwnedRun(c, session.id, parsed.data.runId);
    if (!owned.ok) {
      return owned.response;
    }
    try {
      repo.getSession(session.id);
    } catch (error) {
      return mapDomainError(c, error);
    }
    if (draining) {
      // No staging while draining: replay the stored operation for this
      // exact key (same frozen request/key retry wins over 503), else 503
      // without persisting anything. The immutable request hash is
      // recomputed for the incoming (kind/body/target): a same-key request
      // with drifted content is a 409 `idempotency_key_reused` here exactly
      // as on the normal path, never a silent "deduplicated" replay of a
      // different mutation.
      try {
        const existing = repo.getMemoryOperationByKey(keyed.key.toLowerCase());
        if (existing !== null && existing.sessionId === session.id) {
          const replay = memory.hashDrainingReplay({
            kind: parsed.data.kind,
            sessionId: session.id,
            searchId: parsed.data.searchId,
            ...(parsed.data.handle !== undefined
              ? { handle: parsed.data.handle }
              : {}),
            ...(parsed.data.correctionBody !== undefined
              ? { correctionBody: parsed.data.correctionBody }
              : {}),
          });
          if (replay === null) {
            return shuttingDown(c);
          }
          if (
            replay.requestHash !== existing.requestHash ||
            existing.kind !== parsed.data.kind ||
            existing.recordId !== replay.recordId
          ) {
            return memoryRouteError(c, "idempotency_conflict");
          }
          const body = MemoryMutationResponseSchema.parse({
            operationId: existing.id,
            status: existing.status,
            deduplicated: true,
          });
          logger.info("http.memory.mutations", {
            sessionId: session.id,
            status: 202,
            durationMs: Math.max(now() - started, 0),
          });
          return c.json(body, 202);
        }
      } catch {
        // Fall through to 503 below.
      }
      return shuttingDown(c);
    }
    try {
      const out = await memory.stageMemoryMutation({
        sessionId: session.id,
        runId: parsed.data.runId,
        kind: parsed.data.kind,
        searchId: parsed.data.searchId,
        ...(parsed.data.handle !== undefined
          ? { handle: parsed.data.handle }
          : {}),
        ...(parsed.data.correctionBody !== undefined
          ? { correctionBody: parsed.data.correctionBody }
          : {}),
        idempotencyKey: keyed.key,
        // Trusted USER UI selection: hardcoded server-side for the HTTP
        // user path only. The model tool path hardcodes false instead.
        trustedSelection: true,
      });
      if (!out.ok) {
        return memoryRouteError(c, out.code, out.candidates);
      }
      const body = MemoryMutationResponseSchema.parse({
        operationId: out.operationId,
        status: out.status,
        deduplicated: out.deduplicated,
      });
      logger.info("http.memory.mutations", {
        sessionId: session.id,
        status: 202,
        durationMs: Math.max(now() - started, 0),
      });
      return c.json(body, 202);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "name" in error &&
        (error as { name?: unknown }).name === "MemoryManageCancelled"
      ) {
        return shuttingDown(c);
      }
      return memoryRouteError(c, "service_unavailable");
    }
  });

  // Durable operation status (queued vs acked/error; session-guarded).
  app.get("/api/sessions/:sessionId/memory/operations/:operationId", (c) => {
    if (memory === null) {
      return memoryUnavailable(c);
    }
    const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
    if ("response" in session) {
      return session.response;
    }
    const operation = requireUuid(c, c.req.param("operationId"), "operationId");
    if ("response" in operation) {
      return operation.response;
    }
    if (!strictQuery(c, []).ok) {
      return validationError(c);
    }
    try {
      repo.getSession(session.id);
    } catch (error) {
      return mapDomainError(c, error);
    }
    const out = memory.getMemoryOperation(session.id, operation.id);
    if (out === null) {
      return apiError(c, 404, "not_found", "resource not found");
    }
    const body = MemoryOperationResponseSchema.parse({
      operationId: out.operationId,
      kind: out.kind,
      recordRevision: out.recordRevision,
      status: out.status,
    });
    return c.json(body, 200);
  });

  /* ---------------- M1 stored-only references (§14.8) ---------------- */
  // Session-scoped stored-only GETs + reference-context GET/PUT. No direct
  // POST search/open/refresh/related routes exist. GETs never create
  // events/grants (repository reads are stored-only, no connector read).

  app.get("/api/sessions/:sessionId/references", (c) => {
    const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
    if ("response" in session) {
      return session.response;
    }
    if (!strictQuery(c, []).ok) {
      return validationError(c);
    }
    try {
      const body = ReferenceListResponseSchema.parse(
        repo.listReferences(session.id),
      );
      return c.json(body, 200);
    } catch (error) {
      return mapDomainError(c, error);
    }
  });

  app.get("/api/sessions/:sessionId/references/:referenceId", (c) => {
    const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
    if ("response" in session) {
      return session.response;
    }
    const reference = requireUuid(c, c.req.param("referenceId"), "referenceId");
    if ("response" in reference) {
      return reference.response;
    }
    if (!strictQuery(c, []).ok) {
      return validationError(c);
    }
    try {
      // Stored-only: returns the saved normalized full body, no read.
      const body = ReferenceDetailResponseSchema.parse(
        repo.getReferenceDetail(session.id, reference.id),
      );
      return c.json(body, 200);
    } catch (error) {
      return mapDomainError(c, error);
    }
  });

  app.get("/api/sessions/:sessionId/reference-sets/:setId", (c) => {
    const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
    if ("response" in session) {
      return session.response;
    }
    const set = requireUuid(c, c.req.param("setId"), "setId");
    if ("response" in set) {
      return set.response;
    }
    if (!strictQuery(c, []).ok) {
      return validationError(c);
    }
    try {
      const body = ReferenceSetDetailResponseSchema.parse(
        repo.getReferenceSet(session.id, set.id),
      );
      return c.json(body, 200);
    } catch (error) {
      return mapDomainError(c, error);
    }
  });

  app.get("/api/sessions/:sessionId/reference-context", (c) => {
    const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
    if ("response" in session) {
      return session.response;
    }
    if (!strictQuery(c, []).ok) {
      return validationError(c);
    }
    try {
      const body = ReferenceContextGetResponseSchema.parse(
        repo.getReferenceContext(session.id),
      );
      return c.json(body, 200);
    } catch (error) {
      return mapDomainError(c, error);
    }
  });

  app.put("/api/sessions/:sessionId/reference-context", async (c) => {
    const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
    if ("response" in session) {
      return session.response;
    }
    if (!strictQuery(c, []).ok) {
      return validationError(c);
    }
    const raw = await readJsonBody(c);
    if (!raw.ok) {
      return validationError(c);
    }
    const parsed = ReferenceContextPutRequestSchema.safeParse(raw.value);
    if (!parsed.success) {
      return validationError(c);
    }
    try {
      const body = ReferenceContextPutResponseSchema.parse(
        repo.putReferenceContext(
          session.id,
          { version: parsed.data.version, items: [...parsed.data.items] },
          { now: now() },
        ),
      );
      return c.json(body, 200);
    } catch (error) {
      return mapDomainError(c, error);
    }
  });

  /* ---------------- AV autonomy: purposes + tasks + stop control -------- */
  // Session-owned durable purpose/task records plus the global stop
  // control. Strict Zod bodies, UUID ids, Idempotency-Key on every
  // mutation, exact query gates, ownership-first 404s, CAS 409s. Recorded
  // `permission` purposes are claims only: no route here creates a grant,
  // a capability write, or an external action. Histories are immutable
  // append-only trails (original / correction / lifecycle all visible).

  app.post("/api/sessions/:sessionId/purposes", async (c) => {
    const started = now();
    const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
    if ("response" in session) {
      return session.response;
    }
    const keyed = requireIdempotencyKey(c);
    if ("response" in keyed) {
      return keyed.response;
    }
    if (!strictQuery(c, []).ok) {
      return validationError(c);
    }
    const raw = await readJsonBody(c);
    if (!raw.ok) {
      return validationError(c);
    }
    if (PurposeCreateRequestSchema.safeParse(raw.value).success !== true) {
      return validationError(c);
    }
    if (draining) {
      return shuttingDown(c);
    }
    try {
      const out = repo.createAutonomyPurpose(session.id, raw.value, {
        key: keyed.key,
        now: now(),
      });
      logger.info("http.autonomy.purposes.create", {
        sessionId: session.id,
        status: out.status,
        durationMs: Math.max(now() - started, 0),
      });
      wakeShadow();
      return c.json(out.body, out.status as 200 | 201);
    } catch (error) {
      return mapDomainError(c, error);
    }
  });

  app.get("/api/sessions/:sessionId/purposes", (c) => {
    const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
    if ("response" in session) {
      return session.response;
    }
    const query = strictQuery(c, ["limit"]);
    if (!query.ok) {
      return validationError(c);
    }
    try {
      return c.json(
        repo.listAutonomyPurposes(session.id, {
          ...(query.values.limit !== undefined
            ? { limit: query.values.limit }
            : {}),
        }),
        200,
      );
    } catch (error) {
      return mapDomainError(c, error);
    }
  });

  app.get("/api/sessions/:sessionId/purposes/:purposeId", (c) => {
    const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
    if ("response" in session) {
      return session.response;
    }
    const purpose = requireUuid(c, c.req.param("purposeId"), "purposeId");
    if ("response" in purpose) {
      return purpose.response;
    }
    if (!strictQuery(c, []).ok) {
      return validationError(c);
    }
    try {
      return c.json(repo.getAutonomyPurpose(session.id, purpose.id), 200);
    } catch (error) {
      return mapDomainError(c, error);
    }
  });

  app.get("/api/sessions/:sessionId/purposes/:purposeId/history", (c) => {
    const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
    if ("response" in session) {
      return session.response;
    }
    const purpose = requireUuid(c, c.req.param("purposeId"), "purposeId");
    if ("response" in purpose) {
      return purpose.response;
    }
    const query = strictQuery(c, ["afterSeq", "limit"]);
    if (!query.ok) {
      return validationError(c);
    }
    const parsed = AutonomyHistoryQuerySchema.safeParse({
      ...(query.values.afterSeq !== undefined
        ? { afterSeq: query.values.afterSeq }
        : {}),
      ...(query.values.limit !== undefined
        ? { limit: query.values.limit }
        : {}),
    });
    if (parsed.success !== true) {
      return validationError(c);
    }
    try {
      return c.json(
        repo.getAutonomyPurposeHistory(session.id, purpose.id, {
          afterSeq: parsed.data.afterSeq,
          limit: parsed.data.limit,
        }),
        200,
      );
    } catch (error) {
      return mapDomainError(c, error);
    }
  });

  app.post(
    "/api/sessions/:sessionId/purposes/:purposeId/correct",
    async (c) => {
      const started = now();
      const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
      if ("response" in session) {
        return session.response;
      }
      const purpose = requireUuid(c, c.req.param("purposeId"), "purposeId");
      if ("response" in purpose) {
        return purpose.response;
      }
      const keyed = requireIdempotencyKey(c);
      if ("response" in keyed) {
        return keyed.response;
      }
      if (!strictQuery(c, []).ok) {
        return validationError(c);
      }
      const raw = await readJsonBody(c);
      if (!raw.ok) {
        return validationError(c);
      }
      // The path id is authoritative: the body carries the new statement but
      // never selects a different record (no latest-wins rebinding).
      const withId =
        typeof raw.value === "object" && raw.value !== null
          ? { ...(raw.value as Record<string, unknown>), purposeId: purpose.id }
          : raw.value;
      if (PurposeCorrectRequestSchema.safeParse(withId).success !== true) {
        return validationError(c);
      }
      if (draining) {
        return shuttingDown(c);
      }
      try {
        const out = repo.correctAutonomyPurpose(session.id, withId, {
          key: keyed.key,
          now: now(),
        });
        logger.info("http.autonomy.purposes.correct", {
          sessionId: session.id,
          status: out.status,
          durationMs: Math.max(now() - started, 0),
        });
        wakeShadow();
        return c.json(out.body, out.status as 201);
      } catch (error) {
        return mapDomainError(c, error);
      }
    },
  );

  app.post("/api/sessions/:sessionId/purposes/:purposeId/revoke", async (c) => {
    const started = now();
    const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
    if ("response" in session) {
      return session.response;
    }
    const purpose = requireUuid(c, c.req.param("purposeId"), "purposeId");
    if ("response" in purpose) {
      return purpose.response;
    }
    const keyed = requireIdempotencyKey(c);
    if ("response" in keyed) {
      return keyed.response;
    }
    if (!strictQuery(c, []).ok) {
      return validationError(c);
    }
    const raw = await readJsonBody(c);
    if (!raw.ok) {
      return validationError(c);
    }
    if (PurposeTransitionRequestSchema.safeParse(raw.value).success !== true) {
      return validationError(c);
    }
    if (draining) {
      return shuttingDown(c);
    }
    try {
      const out = repo.revokeAutonomyPurpose(
        session.id,
        purpose.id,
        raw.value,
        { key: keyed.key, now: now() },
      );
      logger.info("http.autonomy.purposes.revoke", {
        sessionId: session.id,
        status: out.status,
        durationMs: Math.max(now() - started, 0),
      });
      wakeShadow();
      return c.json(out.body, out.status as 200);
    } catch (error) {
      return mapDomainError(c, error);
    }
  });

  app.post(
    "/api/sessions/:sessionId/purposes/:purposeId/achieve",
    async (c) => {
      const started = now();
      const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
      if ("response" in session) {
        return session.response;
      }
      const purpose = requireUuid(c, c.req.param("purposeId"), "purposeId");
      if ("response" in purpose) {
        return purpose.response;
      }
      const keyed = requireIdempotencyKey(c);
      if ("response" in keyed) {
        return keyed.response;
      }
      if (!strictQuery(c, []).ok) {
        return validationError(c);
      }
      const raw = await readJsonBody(c);
      if (!raw.ok) {
        return validationError(c);
      }
      if (
        PurposeTransitionRequestSchema.safeParse(raw.value).success !== true
      ) {
        return validationError(c);
      }
      if (draining) {
        return shuttingDown(c);
      }
      try {
        const out = repo.achieveAutonomyPurpose(
          session.id,
          purpose.id,
          raw.value,
          { key: keyed.key, now: now() },
        );
        logger.info("http.autonomy.purposes.achieve", {
          sessionId: session.id,
          status: out.status,
          durationMs: Math.max(now() - started, 0),
        });
        wakeShadow();
        return c.json(out.body, out.status as 200);
      } catch (error) {
        return mapDomainError(c, error);
      }
    },
  );

  app.get("/api/sessions/:sessionId/purpose-conflicts", (c) => {
    const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
    if ("response" in session) {
      return session.response;
    }
    if (!strictQuery(c, []).ok) {
      return validationError(c);
    }
    try {
      return c.json(repo.listAutonomyPurposeConflicts(session.id), 200);
    } catch (error) {
      return mapDomainError(c, error);
    }
  });

  // Explicit conflict record (idempotent, versioned via CAS on members at
  // use time, never derived): same-session/scope owned active pair only.
  // Cross-session ids are 404; scope mismatch / inactive members are 400 /
  // 409; recording grants no authority and never auto-resolves anything.
  app.post("/api/sessions/:sessionId/purpose-conflicts", async (c) => {
    const started = now();
    const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
    if ("response" in session) {
      return session.response;
    }
    const keyed = requireIdempotencyKey(c);
    if ("response" in keyed) {
      return keyed.response;
    }
    if (!strictQuery(c, []).ok) {
      return validationError(c);
    }
    const raw = await readJsonBody(c);
    if (!raw.ok) {
      return validationError(c);
    }
    if (
      PurposeConflictRecordRequestSchema.safeParse(raw.value).success !== true
    ) {
      return validationError(c);
    }
    if (draining) {
      return shuttingDown(c);
    }
    try {
      const out = repo.recordAutonomyPurposeConflict(session.id, raw.value, {
        key: keyed.key,
        now: now(),
      });
      logger.info("http.autonomy.purposes.conflict.record", {
        sessionId: session.id,
        status: out.status,
        durationMs: Math.max(now() - started, 0),
      });
      wakeShadow();
      return c.json(out.body, out.status as 200 | 201);
    } catch (error) {
      return mapDomainError(c, error);
    }
  });

  app.post("/api/sessions/:sessionId/tasks", async (c) => {
    const started = now();
    const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
    if ("response" in session) {
      return session.response;
    }
    const keyed = requireIdempotencyKey(c);
    if ("response" in keyed) {
      return keyed.response;
    }
    if (!strictQuery(c, []).ok) {
      return validationError(c);
    }
    const raw = await readJsonBody(c);
    if (!raw.ok) {
      return validationError(c);
    }
    if (TaskCreateRequestSchema.safeParse(raw.value).success !== true) {
      return validationError(c);
    }
    if (draining) {
      return shuttingDown(c);
    }
    try {
      const out = repo.createAutonomyTask(session.id, raw.value, {
        key: keyed.key,
        now: now(),
      });
      logger.info("http.autonomy.tasks.create", {
        sessionId: session.id,
        status: out.status,
        durationMs: Math.max(now() - started, 0),
      });
      wakeShadow();
      return c.json(out.body, out.status as 200 | 201);
    } catch (error) {
      return mapDomainError(c, error);
    }
  });

  app.get("/api/sessions/:sessionId/tasks", (c) => {
    const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
    if ("response" in session) {
      return session.response;
    }
    const query = strictQuery(c, ["limit"]);
    if (!query.ok) {
      return validationError(c);
    }
    try {
      return c.json(
        repo.listAutonomyTasks(session.id, {
          ...(query.values.limit !== undefined
            ? { limit: query.values.limit }
            : {}),
        }),
        200,
      );
    } catch (error) {
      return mapDomainError(c, error);
    }
  });

  app.get("/api/sessions/:sessionId/tasks/:taskId", (c) => {
    const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
    if ("response" in session) {
      return session.response;
    }
    const task = requireUuid(c, c.req.param("taskId"), "taskId");
    if ("response" in task) {
      return task.response;
    }
    if (!strictQuery(c, []).ok) {
      return validationError(c);
    }
    try {
      return c.json(repo.getAutonomyTask(session.id, task.id), 200);
    } catch (error) {
      return mapDomainError(c, error);
    }
  });

  app.get("/api/sessions/:sessionId/tasks/:taskId/history", (c) => {
    const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
    if ("response" in session) {
      return session.response;
    }
    const task = requireUuid(c, c.req.param("taskId"), "taskId");
    if ("response" in task) {
      return task.response;
    }
    const query = strictQuery(c, ["afterSeq", "limit"]);
    if (!query.ok) {
      return validationError(c);
    }
    const parsed = AutonomyHistoryQuerySchema.safeParse({
      ...(query.values.afterSeq !== undefined
        ? { afterSeq: query.values.afterSeq }
        : {}),
      ...(query.values.limit !== undefined
        ? { limit: query.values.limit }
        : {}),
    });
    if (parsed.success !== true) {
      return validationError(c);
    }
    try {
      return c.json(
        repo.getAutonomyTaskHistory(session.id, task.id, {
          afterSeq: parsed.data.afterSeq,
          limit: parsed.data.limit,
        }),
        200,
      );
    } catch (error) {
      return mapDomainError(c, error);
    }
  });

  function autonomyTaskTransition(
    op: "start" | "hold" | "resume" | "complete" | "cancel",
  ): (c: Context) => Promise<Response> {
    const schema =
      op === "hold"
        ? TaskHoldRequestSchema
        : op === "resume"
          ? TaskResumeRequestSchema
          : TaskTransitionRequestSchema;
    return async (c) => {
      const started = now();
      const session = requireUuid(
        c,
        c.req.param("sessionId") ?? "",
        "sessionId",
      );
      if ("response" in session) {
        return session.response;
      }
      const task = requireUuid(c, c.req.param("taskId") ?? "", "taskId");
      if ("response" in task) {
        return task.response;
      }
      const keyed = requireIdempotencyKey(c);
      if ("response" in keyed) {
        return keyed.response;
      }
      if (!strictQuery(c, []).ok) {
        return validationError(c);
      }
      const raw = await readJsonBody(c);
      if (!raw.ok) {
        return validationError(c);
      }
      if (schema.safeParse(raw.value).success !== true) {
        return validationError(c);
      }
      if (draining) {
        return shuttingDown(c);
      }
      try {
        const options = { key: keyed.key, now: now() };
        const out =
          op === "start"
            ? repo.startAutonomyTask(session.id, task.id, raw.value, options)
            : op === "hold"
              ? repo.holdAutonomyTask(session.id, task.id, raw.value, options)
              : op === "resume"
                ? repo.resumeAutonomyTask(
                    session.id,
                    task.id,
                    raw.value,
                    options,
                  )
                : op === "complete"
                  ? repo.completeAutonomyTask(
                      session.id,
                      task.id,
                      raw.value,
                      options,
                    )
                  : repo.cancelAutonomyTask(
                      session.id,
                      task.id,
                      raw.value,
                      options,
                    );
        logger.info("http.autonomy.tasks.transition", {
          sessionId: session.id,
          status: out.status,
          durationMs: Math.max(now() - started, 0),
        });
        wakeShadow();
        return c.json(out.body, out.status as 200);
      } catch (error) {
        return mapDomainError(c, error);
      }
    };
  }

  app.post(
    "/api/sessions/:sessionId/tasks/:taskId/start",
    autonomyTaskTransition("start"),
  );
  app.post(
    "/api/sessions/:sessionId/tasks/:taskId/hold",
    autonomyTaskTransition("hold"),
  );
  app.post(
    "/api/sessions/:sessionId/tasks/:taskId/resume",
    autonomyTaskTransition("resume"),
  );
  app.post(
    "/api/sessions/:sessionId/tasks/:taskId/complete",
    autonomyTaskTransition("complete"),
  );
  app.post(
    "/api/sessions/:sessionId/tasks/:taskId/cancel",
    autonomyTaskTransition("cancel"),
  );

  /* ---------------- AV03 conversation proposals: review + adopt ------- */
  // Session-owned durable INFERRED drafts staged ONLY by the model-only
  // tools `purpose.propose` / `task.propose` (no staging route exists).
  // Strict Zod bodies, UUID ids, Idempotency-Key on every POST, exact query
  // gates, ownership-first 404s, CAS 409s. The accept decision atomically
  // creates the actual purpose/task (+ accepted-target link); reject
  // creates nothing. Human date args only (strict RFC3339, explicit
  // offset); model dates never exist. Draining rejects fresh keys with 503
  // without persisting (same admission as the autonomy mutations above:
  // no lookup replay — the frozen client key retries after drain).
  // Recorded `permission` adoptions stay claims only (no grant anywhere).

  app.get("/api/sessions/:sessionId/conversation-proposals", (c) => {
    const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
    if ("response" in session) {
      return session.response;
    }
    const query = strictQuery(c, ["limit", "cursor", "status"]);
    if (!query.ok) {
      return validationError(c);
    }
    try {
      return c.json(
        repo.listConversationProposals(session.id, {
          ...(query.values.limit !== undefined
            ? { limit: query.values.limit }
            : {}),
          ...(query.values.cursor !== undefined
            ? { cursor: query.values.cursor }
            : {}),
          ...(query.values.status !== undefined
            ? { status: query.values.status }
            : {}),
        }),
        200,
      );
    } catch (error) {
      return mapDomainError(c, error);
    }
  });

  app.get(
    "/api/sessions/:sessionId/conversation-proposals/:proposalId",
    (c) => {
      const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
      if ("response" in session) {
        return session.response;
      }
      const proposal = requireUuid(c, c.req.param("proposalId"), "proposalId");
      if ("response" in proposal) {
        return proposal.response;
      }
      if (!strictQuery(c, []).ok) {
        return validationError(c);
      }
      try {
        return c.json(
          repo.getConversationProposal(session.id, proposal.id),
          200,
        );
      } catch (error) {
        return mapDomainError(c, error);
      }
    },
  );

  app.post(
    "/api/sessions/:sessionId/conversation-proposals/:proposalId/accept",
    async (c) => {
      const started = now();
      const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
      if ("response" in session) {
        return session.response;
      }
      const proposal = requireUuid(c, c.req.param("proposalId"), "proposalId");
      if ("response" in proposal) {
        return proposal.response;
      }
      const keyed = requireIdempotencyKey(c);
      if ("response" in keyed) {
        return keyed.response;
      }
      if (!strictQuery(c, []).ok) {
        return validationError(c);
      }
      const raw = await readJsonBody(c);
      if (!raw.ok) {
        return validationError(c);
      }
      if (
        ConversationProposalAcceptRequestSchema.safeParse(raw.value).success !==
        true
      ) {
        return validationError(c);
      }
      if (draining) {
        return shuttingDown(c);
      }
      try {
        const out = repo.acceptConversationProposal(
          session.id,
          proposal.id,
          raw.value,
          { key: keyed.key, now: now() },
        );
        logger.info("http.proposals.conversation.accept", {
          sessionId: session.id,
          status: out.status,
          durationMs: Math.max(now() - started, 0),
        });
        wakeShadow();
        return c.json(out.body, out.status as 201);
      } catch (error) {
        return mapDomainError(c, error);
      }
    },
  );

  app.post(
    "/api/sessions/:sessionId/conversation-proposals/:proposalId/reject",
    async (c) => {
      const started = now();
      const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
      if ("response" in session) {
        return session.response;
      }
      const proposal = requireUuid(c, c.req.param("proposalId"), "proposalId");
      if ("response" in proposal) {
        return proposal.response;
      }
      const keyed = requireIdempotencyKey(c);
      if ("response" in keyed) {
        return keyed.response;
      }
      if (!strictQuery(c, []).ok) {
        return validationError(c);
      }
      const raw = await readJsonBody(c);
      if (!raw.ok) {
        return validationError(c);
      }
      if (
        ConversationProposalRejectRequestSchema.safeParse(raw.value).success !==
        true
      ) {
        return validationError(c);
      }
      if (draining) {
        return shuttingDown(c);
      }
      try {
        const out = repo.rejectConversationProposal(
          session.id,
          proposal.id,
          raw.value,
          { key: keyed.key, now: now() },
        );
        logger.info("http.proposals.conversation.reject", {
          sessionId: session.id,
          status: out.status,
          durationMs: Math.max(now() - started, 0),
        });
        return c.json(out.body, out.status as 200);
      } catch (error) {
        return mapDomainError(c, error);
      }
    },
  );

  /* ---------------- AV04 learning: hypotheses + evidence ------------- */
  // Session-owned durable METHODS / HYPOTHESES plus append-only EVIDENCE
  // anchored to existing durable sources only. Human-explicit CRUD:
  // create / transition (support/refute/retire, CAS) / evidence attach /
  // staged accept-reject. Model tools are proposal-only + read-only (no
  // staging route exists). Strict Zod bodies, UUID ids, Idempotency-Key on
  // every POST, exact query gates, ownership-first 404s, CAS 409s. Every
  // read DTO carries the explicit hypothesis label (kind + status +
  // evidence counts); refuted is never surfaced as fact. Routine learning
  // writes NO notifications and never touches control/grants/budget.
  app.get("/api/sessions/:sessionId/learning/hypotheses", (c) => {
    const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
    if ("response" in session) {
      return session.response;
    }
    const query = strictQuery(c, [
      "limit",
      "cursor",
      "scope",
      "status",
      "kind",
    ]);
    if (!query.ok) {
      return validationError(c);
    }
    try {
      return c.json(
        repo.listLearningHypotheses(session.id, {
          ...(query.values.limit !== undefined
            ? { limit: query.values.limit }
            : {}),
          ...(query.values.cursor !== undefined
            ? { cursor: query.values.cursor }
            : {}),
          ...(query.values.scope !== undefined
            ? { scope: query.values.scope }
            : {}),
          ...(query.values.status !== undefined
            ? { status: query.values.status }
            : {}),
          ...(query.values.kind !== undefined
            ? { kind: query.values.kind }
            : {}),
        }),
        200,
      );
    } catch (error) {
      return mapDomainError(c, error);
    }
  });

  app.post("/api/sessions/:sessionId/learning/hypotheses", async (c) => {
    const started = now();
    const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
    if ("response" in session) {
      return session.response;
    }
    const keyed = requireIdempotencyKey(c);
    if ("response" in keyed) {
      return keyed.response;
    }
    if (!strictQuery(c, []).ok) {
      return validationError(c);
    }
    const raw = await readJsonBody(c);
    if (!raw.ok) {
      return validationError(c);
    }
    if (
      LearningHypothesisCreateRequestSchema.safeParse(raw.value).success !==
      true
    ) {
      return validationError(c);
    }
    if (draining) {
      return shuttingDown(c);
    }
    try {
      const out = repo.createLearningHypothesis(session.id, raw.value, {
        key: keyed.key,
        now: now(),
      });
      logger.info("http.learning.hypotheses.create", {
        sessionId: session.id,
        status: out.status,
        durationMs: Math.max(now() - started, 0),
      });
      return c.json(out.body, out.status as 201);
    } catch (error) {
      return mapDomainError(c, error);
    }
  });

  app.get("/api/sessions/:sessionId/learning/hypotheses/:hypothesisId", (c) => {
    const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
    if ("response" in session) {
      return session.response;
    }
    const hypothesis = requireUuid(
      c,
      c.req.param("hypothesisId"),
      "hypothesisId",
    );
    if ("response" in hypothesis) {
      return hypothesis.response;
    }
    if (!strictQuery(c, []).ok) {
      return validationError(c);
    }
    try {
      return c.json(repo.getLearningHypothesis(session.id, hypothesis.id), 200);
    } catch (error) {
      return mapDomainError(c, error);
    }
  });

  app.get(
    "/api/sessions/:sessionId/learning/hypotheses/:hypothesisId/evidence",
    (c) => {
      const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
      if ("response" in session) {
        return session.response;
      }
      const hypothesis = requireUuid(
        c,
        c.req.param("hypothesisId"),
        "hypothesisId",
      );
      if ("response" in hypothesis) {
        return hypothesis.response;
      }
      const listQuery = strictQuery(c, ["limit", "cursor"]);
      if (!listQuery.ok) {
        return validationError(c);
      }
      try {
        return c.json(
          repo.listLearningHypothesisEvidence(session.id, hypothesis.id, {
            ...(listQuery.values.limit !== undefined
              ? { limit: listQuery.values.limit }
              : {}),
            ...(listQuery.values.cursor !== undefined
              ? { cursor: listQuery.values.cursor }
              : {}),
          }),
          200,
        );
      } catch (error) {
        return mapDomainError(c, error);
      }
    },
  );

  function learningHypothesisMutation(
    suffix: string,
    logName: string,
    schemaName: "transition" | "evidence" | "decision",
    apply: (
      sessionId: string,
      hypothesisId: string,
      body: unknown,
      options: { key: string; now: number },
    ) => { status: number; body: unknown; replayed: boolean },
  ): void {
    app.post(
      `/api/sessions/:sessionId/learning/hypotheses/:hypothesisId/${suffix}`,
      async (c) => {
        const started = now();
        const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
        if ("response" in session) {
          return session.response;
        }
        const hypothesis = requireUuid(
          c,
          c.req.param("hypothesisId"),
          "hypothesisId",
        );
        if ("response" in hypothesis) {
          return hypothesis.response;
        }
        const keyed = requireIdempotencyKey(c);
        if ("response" in keyed) {
          return keyed.response;
        }
        if (!strictQuery(c, []).ok) {
          return validationError(c);
        }
        const raw = await readJsonBody(c);
        if (!raw.ok) {
          return validationError(c);
        }
        const schema =
          schemaName === "transition"
            ? LearningHypothesisTransitionRequestSchema
            : schemaName === "evidence"
              ? LearningEvidenceAttachRequestSchema
              : LearningHypothesisDecisionRequestSchema;
        if (schema.safeParse(raw.value).success !== true) {
          return validationError(c);
        }
        if (draining) {
          return shuttingDown(c);
        }
        try {
          const out = apply(session.id, hypothesis.id, raw.value, {
            key: keyed.key,
            now: now(),
          });
          logger.info(logName, {
            sessionId: session.id,
            status: out.status,
            durationMs: Math.max(now() - started, 0),
          });
          return c.json(out.body, out.status as 200);
        } catch (error) {
          return mapDomainError(c, error);
        }
      },
    );
  }

  learningHypothesisMutation(
    "transition",
    "http.learning.hypotheses.transition",
    "transition",
    (sessionId, hypothesisId, body, options) =>
      repo.transitionLearningHypothesis(sessionId, hypothesisId, body, options),
  );
  // Explicit human reaffirm: keeps the status, clears a pending
  // `needs_reevaluation` notice (CAS on the expected version, allowed only
  // while the notice is set). Decision-shaped body (no status fields).
  learningHypothesisMutation(
    "reaffirm",
    "http.learning.hypotheses.reaffirm",
    "decision",
    (sessionId, hypothesisId, body, options) =>
      repo.reaffirmLearningHypothesis(sessionId, hypothesisId, body, options),
  );
  learningHypothesisMutation(
    "evidence",
    "http.learning.hypotheses.evidence",
    "evidence",
    (sessionId, hypothesisId, body, options) =>
      repo.attachLearningEvidence(sessionId, hypothesisId, body, options),
  );
  learningHypothesisMutation(
    "accept",
    "http.learning.hypotheses.accept",
    "decision",
    (sessionId, hypothesisId, body, options) =>
      repo.acceptLearningHypothesis(sessionId, hypothesisId, body, options),
  );
  learningHypothesisMutation(
    "reject",
    "http.learning.hypotheses.reject",
    "decision",
    (sessionId, hypothesisId, body, options) =>
      repo.rejectLearningHypothesis(sessionId, hypothesisId, body, options),
  );

  /* ----------------- AV03 delegation handoffs (human-driven) --------- */
  // Session-owned handoffs bound to an existing task (+ frozen parent
  // purpose snapshot). Human-explicit CRUD: create (prepared) / dispatch /
  // report / verify / fail / cancel / abnormal-exit / attempt / reaffirm.
  // No execution, no spawning, no grants, no numeric budgets (budget text
  // labels only), no task auto-complete. Strict Zod bodies, UUID ids,
  // Idempotency-Key on every POST, exact query gates, ownership-first
  // 404s, CAS 409s. Sandbox claims never imply production; boundary flags
  // are recorded claims requiring separate authorization.
  app.get("/api/sessions/:sessionId/handoffs", (c) => {
    const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
    if ("response" in session) {
      return session.response;
    }
    const query = strictQuery(c, ["limit", "cursor", "status"]);
    if (!query.ok) {
      return validationError(c);
    }
    try {
      return c.json(
        repo.listHandoffs(session.id, {
          ...(query.values.limit !== undefined
            ? { limit: query.values.limit }
            : {}),
          ...(query.values.cursor !== undefined
            ? { cursor: query.values.cursor }
            : {}),
          ...(query.values.status !== undefined
            ? { status: query.values.status }
            : {}),
        }),
        200,
      );
    } catch (error) {
      return mapDomainError(c, error);
    }
  });

  app.post("/api/sessions/:sessionId/handoffs", async (c) => {
    const started = now();
    const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
    if ("response" in session) {
      return session.response;
    }
    const keyed = requireIdempotencyKey(c);
    if ("response" in keyed) {
      return keyed.response;
    }
    if (!strictQuery(c, []).ok) {
      return validationError(c);
    }
    const raw = await readJsonBody(c);
    if (!raw.ok) {
      return validationError(c);
    }
    if (HandoffCreateRequestSchema.safeParse(raw.value).success !== true) {
      return validationError(c);
    }
    if (draining) {
      return shuttingDown(c);
    }
    try {
      const out = repo.createHandoff(session.id, raw.value, {
        key: keyed.key,
        now: now(),
      });
      logger.info("http.handoffs.create", {
        sessionId: session.id,
        status: out.status,
        durationMs: Math.max(now() - started, 0),
      });
      return c.json(out.body, out.status as 201);
    } catch (error) {
      return mapDomainError(c, error);
    }
  });

  app.get("/api/sessions/:sessionId/handoffs/:handoffId", (c) => {
    const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
    if ("response" in session) {
      return session.response;
    }
    const handoff = requireUuid(c, c.req.param("handoffId"), "handoffId");
    if ("response" in handoff) {
      return handoff.response;
    }
    if (!strictQuery(c, []).ok) {
      return validationError(c);
    }
    try {
      return c.json(repo.getHandoff(session.id, handoff.id), 200);
    } catch (error) {
      return mapDomainError(c, error);
    }
  });

  // Deterministic plain-text handoff spec for manual paste into pi-orch.
  // Execution is NOT automated by this export: the human hands the task
  // over and records verified outcomes back through the routes above.
  app.get("/api/sessions/:sessionId/handoffs/:handoffId/spec", (c) => {
    const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
    if ("response" in session) {
      return session.response;
    }
    const handoff = requireUuid(c, c.req.param("handoffId"), "handoffId");
    if ("response" in handoff) {
      return handoff.response;
    }
    if (!strictQuery(c, []).ok) {
      return validationError(c);
    }
    try {
      return c.text(repo.getHandoffSpec(session.id, handoff.id), 200);
    } catch (error) {
      return mapDomainError(c, error);
    }
  });

  app.get("/api/sessions/:sessionId/handoffs/:handoffId/events", (c) => {
    const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
    if ("response" in session) {
      return session.response;
    }
    const handoff = requireUuid(c, c.req.param("handoffId"), "handoffId");
    if ("response" in handoff) {
      return handoff.response;
    }
    if (!strictQuery(c, []).ok) {
      return validationError(c);
    }
    try {
      return c.json(repo.listHandoffEvents(session.id, handoff.id), 200);
    } catch (error) {
      return mapDomainError(c, error);
    }
  });

  app.get("/api/sessions/:sessionId/handoffs/:handoffId/attempts", (c) => {
    const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
    if ("response" in session) {
      return session.response;
    }
    const handoff = requireUuid(c, c.req.param("handoffId"), "handoffId");
    if ("response" in handoff) {
      return handoff.response;
    }
    if (!strictQuery(c, []).ok) {
      return validationError(c);
    }
    try {
      return c.json(repo.listHandoffAttempts(session.id, handoff.id), 200);
    } catch (error) {
      return mapDomainError(c, error);
    }
  });

  function handoffMutation(
    suffix: string,
    logName: string,
    schemaName: "transition" | "dispatch" | "report" | "verify" | "attempt",
    apply: (
      sessionId: string,
      handoffId: string,
      body: unknown,
      options: { key: string; now: number },
    ) => { status: number; body: unknown; replayed: boolean },
  ): void {
    app.post(
      `/api/sessions/:sessionId/handoffs/:handoffId/${suffix}`,
      async (c) => {
        const started = now();
        const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
        if ("response" in session) {
          return session.response;
        }
        const handoff = requireUuid(c, c.req.param("handoffId"), "handoffId");
        if ("response" in handoff) {
          return handoff.response;
        }
        const keyed = requireIdempotencyKey(c);
        if ("response" in keyed) {
          return keyed.response;
        }
        if (!strictQuery(c, []).ok) {
          return validationError(c);
        }
        const raw = await readJsonBody(c);
        if (!raw.ok) {
          return validationError(c);
        }
        const schema =
          schemaName === "dispatch"
            ? HandoffDispatchRequestSchema
            : schemaName === "report"
              ? HandoffReportRequestSchema
              : schemaName === "verify"
                ? HandoffVerifyRequestSchema
                : schemaName === "attempt"
                  ? HandoffAttemptRequestSchema
                  : HandoffTransitionRequestSchema;
        if (schema.safeParse(raw.value).success !== true) {
          return validationError(c);
        }
        if (draining) {
          return shuttingDown(c);
        }
        try {
          const out = apply(session.id, handoff.id, raw.value, {
            key: keyed.key,
            now: now(),
          });
          logger.info(logName, {
            sessionId: session.id,
            status: out.status,
            durationMs: Math.max(now() - started, 0),
          });
          return c.json(out.body, out.status as 200);
        } catch (error) {
          return mapDomainError(c, error);
        }
      },
    );
  }

  handoffMutation(
    "dispatch",
    "http.handoffs.dispatch",
    "dispatch",
    (sessionId, handoffId, body, options) =>
      repo.dispatchHandoff(sessionId, handoffId, body, options),
  );
  handoffMutation(
    "report",
    "http.handoffs.report",
    "report",
    (sessionId, handoffId, body, options) =>
      repo.reportHandoff(sessionId, handoffId, body, options),
  );
  handoffMutation(
    "verify",
    "http.handoffs.verify",
    "verify",
    (sessionId, handoffId, body, options) =>
      repo.verifyHandoff(sessionId, handoffId, body, options),
  );
  handoffMutation(
    "fail",
    "http.handoffs.fail",
    "transition",
    (sessionId, handoffId, body, options) =>
      repo.failHandoff(sessionId, handoffId, body, options),
  );
  handoffMutation(
    "cancel",
    "http.handoffs.cancel",
    "transition",
    (sessionId, handoffId, body, options) =>
      repo.cancelHandoff(sessionId, handoffId, body, options),
  );
  handoffMutation(
    "abnormal-exit",
    "http.handoffs.abnormal-exit",
    "transition",
    (sessionId, handoffId, body, options) =>
      repo.abnormalExitHandoff(sessionId, handoffId, body, options),
  );
  handoffMutation(
    "attempt",
    "http.handoffs.attempt",
    "attempt",
    (sessionId, handoffId, body, options) =>
      repo.recordHandoffAttempt(sessionId, handoffId, body, options),
  );
  handoffMutation(
    "reaffirm",
    "http.handoffs.reaffirm",
    "transition",
    (sessionId, handoffId, body, options) =>
      repo.reaffirmHandoff(sessionId, handoffId, body, options),
  );

  app.get("/api/autonomy/control", (c) => {
    if (!strictQuery(c, []).ok) {
      return validationError(c);
    }
    try {
      return c.json(repo.getAutonomyControlState(), 200);
    } catch (error) {
      return mapDomainError(c, error);
    }
  });

  app.post("/api/autonomy/control", async (c) => {
    const started = now();
    const keyed = requireIdempotencyKey(c);
    if ("response" in keyed) {
      return keyed.response;
    }
    if (!strictQuery(c, []).ok) {
      return validationError(c);
    }
    const raw = await readJsonBody(c);
    if (!raw.ok) {
      return validationError(c);
    }
    if (AutonomyControlSetRequestSchema.safeParse(raw.value).success !== true) {
      return validationError(c);
    }
    if (draining) {
      return shuttingDown(c);
    }
    try {
      const out = repo.setAutonomyControlState(raw.value, {
        key: keyed.key,
        now: now(),
      });
      logger.info("http.autonomy.control", {
        status: out.status,
        durationMs: Math.max(now() - started, 0),
      });
      // Committed control change: abort the shadow's OWN in-flight call
      // FIRST when the actual state is paused (pure STOP aborts model /
      // recall work with no foreground chat), then wake for new state.
      // Both hooks read live state and never throw into the command.
      notifyShadowControl();
      wakeShadow();
      return c.json(out.body, out.status as 200);
    } catch (error) {
      return mapDomainError(c, error);
    }
  });

  app.get("/api/autonomy/activity", (c) => {
    const query = strictQuery(c, ["limit"]);
    if (!query.ok) {
      return validationError(c);
    }
    try {
      return c.json(
        repo.listAutonomyActivityLog({
          ...(query.values.limit !== undefined
            ? { limit: query.values.limit }
            : {}),
        }),
        200,
      );
    } catch (error) {
      return mapDomainError(c, error);
    }
  });

  /* ---------------- trial proposals/approvals (opt-in, config profile) --- */
  // Human-facing trial proposal/approval surface. The trusted profile
  // snapshot + workspace alias come ONLY from the frozen server config
  // (COMPANION_AUTONOMY_JSON); request bodies can never supply them (the
  // strict stage schema rejects unknown keys, and approve/expire take an
  // exactly-empty body). Worker launch, scope observation, permit issuance
  // and result recording stay internal and are never exposed here. Pure
  // reads never expire or mutate; expiry is an explicit POST only.

  /** Fixed disabled response: GETs 404, POSTs 409, never touching the DB. */
  function trialsDisabled(c: Context, mutation: boolean): Response {
    return c.json(
      { error: { code: "trials_disabled", message: "trials are disabled" } },
      (mutation ? 409 : 404) as 404,
    );
  }

  /** Frozen config profile snapshot + workspace alias (never body flags). */
  function trialProfileOf(cfg: ServerConfig): {
    profile: TrialProfileSnapshot;
    workspaceAlias: string;
  } | null {
    const trial = cfg.trial;
    if (trial === null) {
      return null;
    }
    return {
      profile: {
        available: trial.available,
        enabled: trial.enabled,
        mandatoryChecks: [...trial.mandatoryChecks],
        configFingerprint: trial.configFingerprint,
        sourceRevision: trial.sourceRevision,
        currentModel: trial.currentModel,
        disclosedWholeRepoRead: trial.disclosedWholeRepoRead,
        timeoutMs: trial.timeoutMs,
        maxOutputBytes: trial.maxOutputBytes,
      },
      workspaceAlias: trial.workspaceAlias,
    };
  }

  /** Strict exactly-empty body (approve/expire carry no inputs). */
  function isEmptyBody(value: unknown): boolean {
    return (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0
    );
  }

  // Stage a DATA-only trial proposal (keyed, exactly-once): strict
  // `TrialStageRequestSchema` body (unknown keys rejected, so no
  // profile/alias override is possible).
  app.post("/api/sessions/:sessionId/trials", async (c) => {
    const started = now();
    const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
    if ("response" in session) {
      return session.response;
    }
    const keyed = requireIdempotencyKey(c);
    if ("response" in keyed) {
      return keyed.response;
    }
    if (!strictQuery(c, []).ok) {
      return validationError(c);
    }
    const raw = await readJsonBody(c);
    if (!raw.ok) {
      return validationError(c);
    }
    const parsedBody = TrialStageRequestSchema.safeParse(raw.value);
    if (!parsedBody.success) {
      return validationError(c);
    }
    const frozen = trialProfileOf(config);
    if (frozen === null) {
      return trialsDisabled(c, true);
    }
    if (draining) {
      return shuttingDown(c);
    }
    try {
      const out = repo.stageTrial(session.id, parsedBody.data, {
        key: keyed.key,
        now: now(),
        profile: frozen.profile,
        workspaceAlias: frozen.workspaceAlias,
      });
      const body = TrialProposalViewSchema.parse(out.body);
      logger.info("http.trials.stage", {
        sessionId: session.id,
        proposalId: body.id,
        status: out.status,
        bytes: raw.bytes,
        durationMs: Math.max(now() - started, 0),
      });
      return c.json(body, out.status as 201);
    } catch (error) {
      return mapDomainError(c, error);
    }
  });

  // Approve a staged proposal (keyed, one grant): the frozen config
  // profile/alias are re-checked against the staged snapshot inside the
  // kernel (drift is a 409 re-stage).
  app.post("/api/sessions/:sessionId/trials/:proposalId/approve", async (c) => {
    const started = now();
    const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
    if ("response" in session) {
      return session.response;
    }
    const proposal = requireUuid(c, c.req.param("proposalId"), "proposalId");
    if ("response" in proposal) {
      return proposal.response;
    }
    const keyed = requireIdempotencyKey(c);
    if ("response" in keyed) {
      return keyed.response;
    }
    if (!strictQuery(c, []).ok) {
      return validationError(c);
    }
    const raw = await readJsonBody(c);
    if (!raw.ok) {
      return validationError(c);
    }
    if (!isEmptyBody(raw.value)) {
      return validationError(c);
    }
    const frozen = trialProfileOf(config);
    if (frozen === null) {
      return trialsDisabled(c, true);
    }
    if (draining) {
      return shuttingDown(c);
    }
    try {
      const out = repo.approveTrial(session.id, proposal.id, {
        key: keyed.key,
        now: now(),
        profile: frozen.profile,
        workspaceAlias: frozen.workspaceAlias,
      });
      logger.info("http.trials.approve", {
        sessionId: session.id,
        proposalId: proposal.id,
        status: out.status,
        durationMs: Math.max(now() - started, 0),
      });
      return c.json(out.body, out.status as 201);
    } catch (error) {
      return mapDomainError(c, error);
    }
  });

  // List proposals for a session (pure read, never expires/mutates).
  app.get("/api/sessions/:sessionId/trials", (c) => {
    const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
    if ("response" in session) {
      return session.response;
    }
    const query = strictQuery(c, ["limit"]);
    if (!query.ok) {
      return validationError(c);
    }
    const parsed = AutonomyListQuerySchema.safeParse({
      ...(query.values.limit !== undefined
        ? { limit: query.values.limit }
        : {}),
    });
    if (!parsed.success) {
      return validationError(c);
    }
    if (trialProfileOf(config) === null) {
      return trialsDisabled(c, false);
    }
    try {
      const body = repo.listTrials(session.id, { limit: parsed.data.limit });
      const items = body.items.map((item) => ({
        ...item,
        outcome: repo.readTrialWorkerOutcomeByProposal(session.id, item.id),
      }));
      return c.json({ ...body, items }, 200);
    } catch (error) {
      return mapDomainError(c, error);
    }
  });

  // Read one session-owned proposal (pure read, never expires/mutates).
  // Carries the grant outcome alongside (null until granted) so the UI
  // trial section renders consumed/interrupted/revoked + authorized.
  app.get("/api/sessions/:sessionId/trials/:proposalId", (c) => {
    const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
    if ("response" in session) {
      return session.response;
    }
    const proposal = requireUuid(c, c.req.param("proposalId"), "proposalId");
    if ("response" in proposal) {
      return proposal.response;
    }
    if (!strictQuery(c, []).ok) {
      return validationError(c);
    }
    if (trialProfileOf(config) === null) {
      return trialsDisabled(c, false);
    }
    try {
      // Read by id directly: paging the list would 404 proposals that fall
      // outside the default list limit (pure read, never expires/mutates).
      const found = repo.readTrial(session.id, proposal.id);
      const outcome = repo.readTrialWorkerOutcomeByProposal(
        session.id,
        proposal.id,
      );
      return c.json({ ...found, outcome }, 200);
    } catch (error) {
      return mapDomainError(c, error);
    }
  });

  // Read the grant + frozen launch intent for one session-owned execution
  // (pure read, never expires/mutates/claims). The durable worker outcome
  // (grant status + authorized flag + fixed observed summary) rides along
  // so the UI can render consumed/interrupted/revoked without a second
  // read. The summary is fixed vocabulary (bridge-exit code or fixed
  // fence/invalid reasons), never free text.
  app.get("/api/sessions/:sessionId/trial-grants/:executionId", (c) => {
    const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
    if ("response" in session) {
      return session.response;
    }
    const execution = requireUuid(c, c.req.param("executionId"), "executionId");
    if ("response" in execution) {
      return execution.response;
    }
    if (!strictQuery(c, []).ok) {
      return validationError(c);
    }
    if (trialProfileOf(config) === null) {
      return trialsDisabled(c, false);
    }
    try {
      const body = repo.readTrialLaunchIntent(session.id, execution.id);
      const outcome = repo.readTrialWorkerOutcome(session.id, execution.id);
      return c.json({ ...body, outcome }, 200);
    } catch (error) {
      return mapDomainError(c, error);
    }
  });

  // Read one session-owned proposal WITH its grant outcome (pure read).
  // The outcome (grant status + authorized + fixed summary) renders in the
  // trial section; absent when no grant exists yet (staged proposals).

  // Explicit expire/cancel of a staged proposal (KEYLESS, state-idempotent):
  // Idempotency-Key is deliberately not used (same family as reject). No
  // draining gate: expiring creates no Run and no queued work.
  app.post("/api/sessions/:sessionId/trials/:proposalId/expire", async (c) => {
    const started = now();
    const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
    if ("response" in session) {
      return session.response;
    }
    const proposal = requireUuid(c, c.req.param("proposalId"), "proposalId");
    if ("response" in proposal) {
      return proposal.response;
    }
    if (c.req.header("idempotency-key") !== undefined) {
      return validationError(c, "idempotency-key is not used for expire");
    }
    if (!strictQuery(c, []).ok) {
      return validationError(c);
    }
    const raw = await readJsonBody(c);
    if (!raw.ok) {
      return validationError(c);
    }
    if (!isEmptyBody(raw.value)) {
      return validationError(c);
    }
    if (trialProfileOf(config) === null) {
      return trialsDisabled(c, true);
    }
    try {
      repo.expireTrial(session.id, proposal.id, now());
      // Read by id directly: paging the list would 404 proposals that fall
      // outside the default list limit even though expire succeeded.
      const found = repo.readTrial(session.id, proposal.id);
      const body = TrialProposalViewSchema.parse(found);
      logger.info("http.trials.expire", {
        sessionId: session.id,
        proposalId: proposal.id,
        status: body.status,
        durationMs: Math.max(now() - started, 0),
      });
      return c.json(body, 200);
    } catch (error) {
      return mapDomainError(c, error);
    }
  });

  /* ---------------- AV shadow: explicit requests + read-only views ------- */
  // Session-owned explicit deliberation requests plus read-only job views.
  // Strict Zod bodies, UUID ids, Idempotency-Key on every POST, exact query
  // gates, ownership-first 404s, CAS 409s. Claim/complete/fail/lease-owner/
  // model-grant surfaces are TRUSTED runtime-only and are NEVER exposed
  // here (no such route exists). GET list/detail/events/context reads
  // carry NO ack side effect; the context read additionally projects the
  // stored MODEL decision next to the frozen context (both frozen
  // records, never authority). A successful explicit request wakes the
  // worker (same throw-guarded semantics as the autonomy mutations
  // above).

  app.post("/api/sessions/:sessionId/shadow-jobs", async (c) => {
    const started = now();
    const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
    if ("response" in session) {
      return session.response;
    }
    const keyed = requireIdempotencyKey(c);
    if ("response" in keyed) {
      return keyed.response;
    }
    if (!strictQuery(c, []).ok) {
      return validationError(c);
    }
    const raw = await readJsonBody(c);
    if (!raw.ok) {
      return validationError(c);
    }
    if (ShadowExplicitRequestSchema.safeParse(raw.value).success !== true) {
      return validationError(c);
    }
    if (draining) {
      // Draining replay-first (consistent with message/retry admission):
      // an already-ACCEPTED key replays its stored response verbatim; a
      // fresh key is rejected with 503 and persists nothing.
      try {
        const stored = repo.lookupIdempotencyForSession(
          session.id,
          keyed.key,
          shadowRequestScope(session.id),
        );
        if (stored.found) {
          const out = repo.requestShadowDeliberation(session.id, raw.value, {
            key: keyed.key,
            now: now(),
          });
          return c.json(out.body, out.status as 201);
        }
      } catch {
        // Lookup/replay failure while draining still rejects below.
      }
      return shuttingDown(c);
    }
    try {
      const out = repo.requestShadowDeliberation(session.id, raw.value, {
        key: keyed.key,
        now: now(),
      });
      logger.info("http.shadow.jobs.request", {
        sessionId: session.id,
        status: out.status,
        durationMs: Math.max(now() - started, 0),
      });
      wakeShadow();
      return c.json(out.body, out.status as 200 | 201);
    } catch (error) {
      return mapDomainError(c, error);
    }
  });

  app.get("/api/sessions/:sessionId/shadow-jobs", (c) => {
    const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
    if ("response" in session) {
      return session.response;
    }
    const query = strictQuery(c, ["limit"]);
    if (!query.ok) {
      return validationError(c);
    }
    try {
      return c.json(
        repo.listShadowJobs(session.id, {
          ...(query.values.limit !== undefined
            ? { limit: query.values.limit }
            : {}),
        }),
        200,
      );
    } catch (error) {
      return mapDomainError(c, error);
    }
  });

  app.get("/api/sessions/:sessionId/shadow-jobs/:jobId", (c) => {
    const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
    if ("response" in session) {
      return session.response;
    }
    const job = requireUuid(c, c.req.param("jobId"), "jobId");
    if ("response" in job) {
      return job.response;
    }
    if (!strictQuery(c, []).ok) {
      return validationError(c);
    }
    try {
      return c.json(repo.getShadowJob(session.id, job.id), 200);
    } catch (error) {
      return mapDomainError(c, error);
    }
  });

  app.get("/api/sessions/:sessionId/shadow-jobs/:jobId/events", (c) => {
    const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
    if ("response" in session) {
      return session.response;
    }
    const job = requireUuid(c, c.req.param("jobId"), "jobId");
    if ("response" in job) {
      return job.response;
    }
    if (!strictQuery(c, []).ok) {
      return validationError(c);
    }
    try {
      return c.json(repo.listShadowJobEvents(session.id, job.id), 200);
    } catch (error) {
      return mapDomainError(c, error);
    }
  });

  app.get("/api/sessions/:sessionId/shadow-jobs/:jobId/context", (c) => {
    const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
    if ("response" in session) {
      return session.response;
    }
    const job = requireUuid(c, c.req.param("jobId"), "jobId");
    if ("response" in job) {
      return job.response;
    }
    if (!strictQuery(c, []).ok) {
      return validationError(c);
    }
    try {
      // Deliberation envelope: frozen claim-time context + stored MODEL
      // decision (null until fenced completion). Read-only projection of
      // already-stored rows: no ack, no mutation, no authority conferred.
      return c.json(repo.getShadowJobDeliberation(session.id, job.id), 200);
    } catch (error) {
      return mapDomainError(c, error);
    }
  });

  /* ---------------- AV05 notifications: durable feed + explicit ack --- */
  // Session-owned durable notification feed (projection reads) plus
  // explicit ack receipts. Reads are pure SELECTs: no ingest, no ack, no
  // model nudge, no authority. An ack records ONLY the receipt: it changes
  // no purpose / task / control / Calendar grant / proposal / hypothesis,
  // and the strict `{}` body carries no job / purpose / task / action /
  // grant / resume selector (an ack can never imply a question answer or a
  // consent). Ownership-first 404s; stable-key replays 200; key drift 409.

  /**
   * App-local notification read queries: the contracts `now` read clock
   * stays kernel-only (deterministic tests inject it there). Production
   * HTTP reads MUST use the trusted server clock (`now()` below), never an
   * untrusted `?now=` override — unknown `now` keys are strict 400 via the
   * query gates. `omit` reuses the exact contract bounds (no duplication);
   * the single-field read schema omits to a strict empty object.
   */
  const NotificationListHttpQuerySchema = NotificationListQuerySchema.omit({
    now: true,
  });
  const NotificationForwardHttpQuerySchema =
    NotificationForwardQuerySchema.omit({ now: true });
  const NotificationReadHttpQuerySchema = NotificationReadQuerySchema.omit({
    now: true,
  });

  /**
   * HTTP cursor/seq safe-integer gate: contracts `.int()` alone admits
   * unsafe magnitudes (SQLite-unfriendly). Reads reject non-safe values
   * with 400; no arbitrary new bounds are introduced.
   */
  function isSafeSeq(value: number | undefined): boolean {
    if (value === undefined) {
      return true;
    }
    return Number.isSafeInteger(value);
  }

  /**
   * Strict ack body: exactly `{}`. Any key (job / purpose / task / action
   * / grant / resume / answer / consent …) is rejected: an ack selects
   * its notification ONLY via the path id + the Idempotency-Key header.
   */
  const NotificationAckRequestSchema = z.strictObject({});

  /**
   * Draining replay for POST acks: read-only. A stored ack under the SAME
   * key replays verbatim (200); a stored ack under a DIFFERENT key replays
   * the fixed 409; anything without a stored ack rejects 503 without
   * persisting. Never writes during drain.
   */
  function tryReplayStoredAck(
    c: Context,
    sessionId: string,
    notificationId: string,
    key: string,
  ): Response | null {
    try {
      const history = NotificationHistoryResponseSchema.parse(
        repo.getNotificationHistory(sessionId, notificationId),
      );
      if (history.ack === null) {
        return null;
      }
      if (history.ack.key !== key) {
        return c.json(
          {
            error: {
              code: "notification_key_conflict",
              message: "notification ack key conflict",
            },
          },
          409,
        );
      }
      const body = NotificationAckReceiptSchema.parse(history.ack);
      return c.json(body, 200);
    } catch (error) {
      if (
        error instanceof RepositoryNotFoundError ||
        error instanceof NotificationKeyConflictError ||
        error instanceof NotificationProjectionResetError
      ) {
        return mapDomainError(c, error);
      }
      return null;
    }
  }

  // Newest-page history (no hidden cap: strict 1..100 `limit` +
  // `beforeSeq` paging with truthful `hasMore`/`nextBefore`). Production
  // reads use the trusted server clock; `?now=` is rejected as unknown.
  app.get("/api/sessions/:sessionId/notifications", (c) => {
    const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
    if ("response" in session) {
      return session.response;
    }
    const gated = strictQuery(c, ["beforeSeq", "limit"]);
    if (!gated.ok) {
      return validationError(c);
    }
    const parsed = NotificationListHttpQuerySchema.safeParse({
      beforeSeq: gated.values.beforeSeq,
      limit: gated.values.limit,
    });
    if (!parsed.success) {
      return validationError(c);
    }
    if (!isSafeSeq(parsed.data.beforeSeq) || !isSafeSeq(parsed.data.limit)) {
      return validationError(c);
    }
    try {
      const body = NotificationListResponseSchema.parse(
        repo.listNotifications(session.id, {
          limit: parsed.data.limit,
          ...(parsed.data.beforeSeq !== undefined
            ? { beforeSeq: parsed.data.beforeSeq }
            : {}),
          now: now(),
        }),
      );
      return c.json(body, 200);
    } catch (error) {
      return mapDomainError(c, error);
    }
  });

  // Forward read-after page (`seq > after` oldest-first, strict 1..100):
  // the durable counterpart of SSE replay (same SQL paging). Trusted clock.
  app.get("/api/sessions/:sessionId/notifications/forward", (c) => {
    const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
    if ("response" in session) {
      return session.response;
    }
    const gated = strictQuery(c, ["after", "limit"]);
    if (!gated.ok) {
      return validationError(c);
    }
    const parsed = NotificationForwardHttpQuerySchema.safeParse({
      after: gated.values.after,
      limit: gated.values.limit,
    });
    if (!parsed.success) {
      return validationError(c);
    }
    if (!isSafeSeq(parsed.data.after) || !isSafeSeq(parsed.data.limit)) {
      return validationError(c);
    }
    try {
      const body = repo.listNotificationsForward(session.id, {
        after: parsed.data.after,
        limit: parsed.data.limit,
        now: now(),
      });
      return c.json(body, 200);
    } catch (error) {
      return mapDomainError(c, error);
    }
  });

  // Pure-read feed cursor (per-source cursors + latest notification seq):
  // strictly a SELECT, never an ack/ingest/baseline.
  app.get("/api/sessions/:sessionId/notifications/feed/cursor", (c) => {
    const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
    if ("response" in session) {
      return session.response;
    }
    if (!strictQuery(c, []).ok) {
      return validationError(c);
    }
    try {
      return c.json(repo.getLatestNotificationCursor(session.id), 200);
    } catch (error) {
      return mapDomainError(c, error);
    }
  });

  // Durable SSE replay: `seq > cursor ORDER BY seq ASC` in bounded pages,
  // cursor = max(valid ?after, valid Last-Event-ID), strict safe integer,
  // session-owned (foreign sessions 404). Reading never acks; disconnect
  // never touches delivery state. The stream is never terminal by itself:
  // it ends on client disconnect or on the synchronous drain gate (which
  // fires BEFORE the DB close, so an open feed can never throw a
  // closed-DB error).
  app.get("/api/sessions/:sessionId/notifications/feed/stream", (c) => {
    const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
    if ("response" in session) {
      return session.response;
    }
    const gated = strictQuery(c, ["after"]);
    if (!gated.ok) {
      return validationError(c);
    }
    const cursor = effectiveCursor(
      gated.values.after,
      c.req.header("last-event-id"),
    );
    try {
      repo.getLatestNotificationCursor(session.id);
      return createNotificationFeedSseResponse(repo, session.id, cursor, {
        isDraining: () => draining,
      });
    } catch (error) {
      return mapDomainError(c, error);
    }
  });

  // Single immutable record (pure read, foreign ids 404). Trusted clock.
  app.get("/api/sessions/:sessionId/notifications/:notificationId", (c) => {
    const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
    if ("response" in session) {
      return session.response;
    }
    const notification = requireUuid(
      c,
      c.req.param("notificationId"),
      "notificationId",
    );
    if ("response" in notification) {
      return notification.response;
    }
    const gated = strictQuery(c, []);
    if (!gated.ok) {
      return validationError(c);
    }
    if (!NotificationReadHttpQuerySchema.safeParse({}).success) {
      return validationError(c);
    }
    try {
      const body = NotificationViewSchema.parse(
        repo.getNotification(session.id, notification.id, { now: now() }),
      );
      return c.json(body, 200);
    } catch (error) {
      return mapDomainError(c, error);
    }
  });

  // Record + explicit ack receipt (pure read, foreign ids 404).
  app.get(
    "/api/sessions/:sessionId/notifications/:notificationId/history",
    (c) => {
      const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
      if ("response" in session) {
        return session.response;
      }
      const notification = requireUuid(
        c,
        c.req.param("notificationId"),
        "notificationId",
      );
      if ("response" in notification) {
        return notification.response;
      }
      const gated = strictQuery(c, []);
      if (!gated.ok) {
        return validationError(c);
      }
      if (!NotificationReadHttpQuerySchema.safeParse({}).success) {
        return validationError(c);
      }
      try {
        const body = NotificationHistoryResponseSchema.parse(
          repo.getNotificationHistory(session.id, notification.id, {
            now: now(),
          }),
        );
        return c.json(body, 200);
      } catch (error) {
        return mapDomainError(c, error);
      }
    },
  );

  // Explicit ack (keyed): same key replays the stored receipt, key drift
  // is 409, foreign ids 404 — all BEFORE any other dispatch (the kernel
  // asserts ownership first). Strict `{}` body: no job/purpose/task/
  // action/grant/resume/answer/consent selector is accepted here.
  app.post(
    "/api/sessions/:sessionId/notifications/:notificationId/ack",
    async (c) => {
      const started = now();
      // No early draining reject: the admission gate runs after body
      // await/validation so a stored ack replay wins over 503.
      const session = requireUuid(c, c.req.param("sessionId"), "sessionId");
      if ("response" in session) {
        return session.response;
      }
      const notification = requireUuid(
        c,
        c.req.param("notificationId"),
        "notificationId",
      );
      if ("response" in notification) {
        return notification.response;
      }
      const keyed = requireIdempotencyKey(c);
      if ("response" in keyed) {
        return keyed.response;
      }
      const raw = await readJsonBody(c);
      if (!raw.ok) {
        return validationError(c);
      }
      if (NotificationAckRequestSchema.safeParse(raw.value).success !== true) {
        return validationError(c);
      }
      // Draining admission re-check immediately before the repository
      // call (no await between here and repo.ackNotification, so a drain
      // that begins mid-flight cannot slip a fresh ack into the store).
      // A stored receipt for this exact key replays verbatim instead of
      // 503; anything else is rejected without persisting.
      if (draining) {
        const replayed = tryReplayStoredAck(
          c,
          session.id,
          notification.id,
          keyed.key,
        );
        if (replayed !== null) {
          return replayed;
        }
        return shuttingDown(c);
      }
      try {
        const out = repo.ackNotification(session.id, notification.id, {
          key: keyed.key,
          now: now(),
        });
        const body = NotificationAckReceiptSchema.parse(out.body);
        logger.info("http.notifications.ack", {
          sessionId: session.id,
          status: out.status,
          durationMs: Math.max(now() - started, 0),
        });
        return c.json(body, out.status as 200);
      } catch (error) {
        return mapDomainError(c, error);
      }
    },
  );

  return { app, controls };
}
