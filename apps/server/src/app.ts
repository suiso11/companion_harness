// M0 Hono composition root (plan §3, §9 blockers 4+7, §11-§12, §16.7, §19.5).
//
// The kernel stays HTTP-unaware: this module owns route assembly, security
// middleware, domain-error mapping, and the draining admission gate. All
// domain work (including idempotent persistence/replay of accepted 2xx
// only) is delegated to the kernel repository; cancel goes through the
// engine so the DB transition commits before any abort.

import {
  type ApiErrorCode,
  CancelRunResponseSchema,
  CreateSessionRequestSchema,
  CreateSessionResponseSchema,
  EventsQuerySchema,
  HistoryQuerySchema,
  IDEMPOTENCY_SCOPE_SESSIONS_CREATE,
  IdempotencyLookupQuerySchema,
  PostMessageRequestSchema,
  PostMessageResponseSchema,
  PostRetryRequestSchema,
} from "@companion/contracts";
import {
  IdempotencyConflictError,
  isUuidV4,
  type KernelRepository,
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
 * A missing Origin is accepted as a documented local CLI-style request.
 */
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
): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const text = await c.req.text();
  if (text.length === 0) {
    return { ok: true, value: {} };
  }
  if (text.length > MAX_BODY_BYTES) {
    return { ok: false };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
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
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "server_shutting_down"
  ) {
    return shuttingDown(c);
  }
  return apiError(c, 500, "validation_error", "internal error");
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
      return c.json(body, out.status === 201 ? 201 : 201);
    } catch (error) {
      return mapDomainError(c, error);
    }
  });

  /* ---------------- messages ---------------- */

  app.post("/api/sessions/:sessionId/messages", async (c) => {
    const started = now();
    if (draining) {
      // Rejected before any domain work: never persisted for replay.
      return shuttingDown(c);
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
    const parsedBody = PostMessageRequestSchema.safeParse(raw.value);
    if (!parsedBody.success) {
      return validationError(c);
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
        bytes: rawBodySize(raw.value),
        durationMs: Math.max(now() - started, 0),
      });
      return c.json(body, out.status === 202 ? 202 : 202);
    } catch (error) {
      return mapDomainError(c, error);
    }
  });

  /* ---------------- retries ---------------- */

  app.post("/api/sessions/:sessionId/turns/:turnId/retries", async (c) => {
    const started = now();
    if (draining) {
      return shuttingDown(c);
    }
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
      return c.json(body, out.status === 202 ? 202 : 202);
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
    const parsed = HistoryQuerySchema.safeParse({
      beforePosition: c.req.query("beforePosition"),
      limit: c.req.query("limit"),
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
    const parsed = EventsQuerySchema.safeParse({
      after: c.req.query("after"),
      limit: c.req.query("limit"),
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
    const parsedQuery = IdempotencyLookupQuerySchema.safeParse({
      scope: c.req.query("scope"),
    });
    if (!parsedQuery.success) {
      return validationError(c);
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

  return { app, controls };
}

function rawBodySize(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}
