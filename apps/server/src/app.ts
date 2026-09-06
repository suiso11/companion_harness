// M0 Hono composition root (plan §3, §9 blockers 4+7, §11-§12, §16.7, §19.5).
//
// The kernel stays HTTP-unaware: this module owns route assembly, security
// middleware, domain-error mapping, and the draining admission gate. All
// domain work (including idempotent persistence/replay of accepted 2xx
// only) is delegated to the kernel repository; cancel goes through the
// engine so the DB transition commits before any abort.

import {
  type ApiErrorCode,
  CancelRunRequestSchema,
  CancelRunResponseSchema,
  CreateSessionRequestSchema,
  CreateSessionResponseSchema,
  EventsQuerySchema,
  HistoryQuerySchema,
  IDEMPOTENCY_SCOPE_SESSIONS_CREATE,
  IdempotencyLookupQuerySchema,
  messageScope,
  PostMessageRequestSchema,
  PostMessageResponseSchema,
  PostRetryRequestSchema,
  ReferenceContextGetResponseSchema,
  ReferenceContextPutRequestSchema,
  ReferenceContextPutResponseSchema,
  ReferenceDetailResponseSchema,
  ReferenceListResponseSchema,
  ReferenceSetDetailResponseSchema,
  retryScope,
} from "@companion/contracts";
import {
  IdempotencyConflictError,
  InvalidReferenceError,
  isUuidV4,
  type KernelRepository,
  ReferenceNotFoundError,
  ReferenceVersionConflictError,
  RepositoryNotFoundError,
  RepositoryValidationError,
  SessionBusyError,
} from "@companion/kernel";
import type { Context } from "hono";
import { Hono } from "hono";
import type { ServerConfig } from "./config.js";
import { ServerConfigError } from "./config.js";
import { createStdServerLogger, type ServerLogger } from "./logger.js";

/** Minimal engine surface the routes need (RunEngine satisfies this). */
export interface EnginePort {
  cancel(sessionId: string, runId: string): { status: string };
  shutdown(options?: {
    drainMs?: number;
  }): Promise<{ abandoned: number; cancelled: number }>;
}

export interface CreateAppDeps {
  config: ServerConfig;
  repo: KernelRepository;
  engine: EnginePort;
  logger?: ServerLogger;
  now?: () => number;
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

/** Strict Host validation: loopback hostnames only, header required. */
function checkHost(c: Context): Response | null {
  const header = c.req.header("host");
  if (header === undefined) {
    return validationError(c, "missing host header");
  }
  const name = hostNameOfHeader(header);
  if (name === null || !isLoopbackHostName(name)) {
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

function checkMutationSecurity(c: Context): Response | null {
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
  const host = c.req.header("host") ?? "";
  if (origin !== `http://${host}`) {
    return apiError(
      c,
      403,
      "validation_error",
      "cross-origin request rejected",
    );
  }
  return null;
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
  const logger = deps.logger ?? createStdServerLogger(config.logLevel);
  const now = deps.now ?? Date.now;
  let draining = false;
  const controls: ServerControls = {
    get draining() {
      return draining;
    },
    markDraining: () => {
      draining = true;
    },
  };

  const app = new Hono();

  // Strict Host validation for every route (health included).
  app.use(async (c, next) => {
    const rejected = checkHost(c);
    if (rejected !== null) {
      return rejected;
    }
    await next();
  });

  // Mutation security for every mutation route.
  app.use(async (c, next) => {
    if (isMutationMethod(c.req.method)) {
      const rejected = checkMutationSecurity(c);
      if (rejected !== null) {
        return rejected;
      }
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

  /* ---------------- health (exact, §12.5) ---------------- */

  app.get("/health/live", (c) => c.json({ status: "live" }, 200));

  app.get("/health/ready", (c) => {
    if (draining) {
      return c.json({ status: "not_ready", code: "server_shutting_down" }, 503);
    }
    return c.json({ status: "ready" }, 200);
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

  return { app, controls };
}
