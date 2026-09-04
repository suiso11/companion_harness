import { z } from "zod";
import { RunEventSchema } from "./events.js";
import { IdempotencyScopeSchema, UnixMsSchema, UuidSchema } from "./ids.js";
import { RunResultSchema } from "./run_result.js";
import { ActiveStatusSchema, RunStatusSchema } from "./run_status.js";
import { MAX_USER_TEXT_LENGTH } from "./turn_input.js";

/* ------------------------------------------------------------------ */
/* Path params                                                         */
/* ------------------------------------------------------------------ */

export const SessionParamsSchema = z.strictObject({
  sessionId: UuidSchema,
});
export type SessionParams = z.infer<typeof SessionParamsSchema>;

export const TurnParamsSchema = z.strictObject({
  sessionId: UuidSchema,
  turnId: UuidSchema,
});
export type TurnParams = z.infer<typeof TurnParamsSchema>;

export const RunParamsSchema = z.strictObject({
  sessionId: UuidSchema,
  runId: UuidSchema,
});
export type RunParams = z.infer<typeof RunParamsSchema>;

/* ------------------------------------------------------------------ */
/* Sessions                                                            */
/* ------------------------------------------------------------------ */

/**
 * POST /api/sessions request. Session creation takes no body in M0;
 * the strict empty object rejects unknown keys at the boundary.
 */
export const CreateSessionRequestSchema = z.strictObject({});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;

/**
 * POST /api/sessions response.
 *
 * AMBIGUITY: the plan fixes the Idempotency-Key scope but not the exact
 * status/body. M0 uses `201 Created` with the new id + timestamp; the
 * original status/body is replayed verbatim on key reuse (§9 blocker 4).
 */
export const CreateSessionResponseSchema = z.strictObject({
  sessionId: UuidSchema,
  createdAt: UnixMsSchema,
});
export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>;

/* ------------------------------------------------------------------ */
/* Messages / retries                                                  */
/* ------------------------------------------------------------------ */

/**
 * POST /api/sessions/:sessionId/messages request (§12.2). `text` is
 * normalized into `turns.input_json` (`user_text` variant); `uiContext`
 * seeds the frozen context. Strict: unknown keys rejected.
 */
export const PostMessageRequestSchema = z.strictObject({
  text: z.string().min(1).max(MAX_USER_TEXT_LENGTH).refine((t) => t.trim().length > 0, {
    message: "text must not be blank",
  }),
  uiContext: z.record(z.string(), z.json()).optional().default({}),
});
export type PostMessageRequest = z.infer<typeof PostMessageRequestSchema>;

export const AcceptedRunSchema = z.strictObject({
  id: UuidSchema,
  attempt: z.number().int().min(1),
  status: z.literal("queued"),
});
export type AcceptedRun = z.infer<typeof AcceptedRunSchema>;

/** 202 Accepted: generation is async, the Run is queued (§12.2). */
export const PostMessageResponseSchema = z.strictObject({
  sessionId: UuidSchema,
  turnId: UuidSchema,
  run: AcceptedRunSchema,
});
export type PostMessageResponse = z.infer<typeof PostMessageResponseSchema>;

/**
 * POST /api/sessions/:sessionId/turns/:turnId/retries request. Retry
 * reuses the Turn's frozen input, so the body is empty (strict).
 */
export const PostRetryRequestSchema = z.strictObject({});
export type PostRetryRequest = z.infer<typeof PostRetryRequestSchema>;

export const PostRetryResponseSchema = PostMessageResponseSchema;
export type PostRetryResponse = z.infer<typeof PostRetryResponseSchema>;

/* ------------------------------------------------------------------ */
/* Cancel                                                              */
/* ------------------------------------------------------------------ */

/**
 * POST /api/sessions/:sessionId/runs/:runId/cancel. Keyless and
 * state-idempotent: terminal Runs return their current state with 200.
 */
export const CancelRunRequestSchema = z.strictObject({});
export type CancelRunRequest = z.infer<typeof CancelRunRequestSchema>;

export const CancelRunResponseSchema = z.strictObject({
  run: z.strictObject({
    id: UuidSchema,
    status: RunStatusSchema,
  }),
});
export type CancelRunResponse = z.infer<typeof CancelRunResponseSchema>;

/* ------------------------------------------------------------------ */
/* History                                                             */
/* ------------------------------------------------------------------ */

/**
 * GET /api/sessions/:sessionId/history query. `beforePosition` is
 * exclusive; `limit` defaults to 50 and caps at 100 (§12.1).
 */
export const HistoryQuerySchema = z.strictObject({
  beforePosition: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type HistoryQuery = z.infer<typeof HistoryQuerySchema>;
export type HistoryQueryInput = z.input<typeof HistoryQuerySchema>;

/**
 * History projection: Turn × selected Run (§11.6). Unselected / failed /
 * cancelled / abandoned Runs never appear; a Turn with no selection shows
 * a null `selectedRun` ("no response").
 */
export const HistoryItemSchema = z.strictObject({
  turnId: UuidSchema,
  seq: z.number().int().min(1),
  kind: z.literal("user_text"),
  text: z.string().min(1).max(MAX_USER_TEXT_LENGTH),
  createdAt: UnixMsSchema,
  selectedRun: z
    .strictObject({
      runId: UuidSchema,
      attempt: z.number().int().min(1),
      finishedAt: UnixMsSchema,
      result: RunResultSchema,
    })
    .nullable(),
});
export type HistoryItem = z.infer<typeof HistoryItemSchema>;

export const HistoryResponseSchema = z.strictObject({
  items: z.array(HistoryItemSchema).max(100),
  nextBefore: z.number().int().min(1).nullable(),
  hasMore: z.boolean(),
});
export type HistoryResponse = z.infer<typeof HistoryResponseSchema>;

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

/**
 * GET /api/sessions/:sessionId/runs/:runId/events query. `after` is the
 * exclusive per-run seq cursor.
 *
 * AMBIGUITY: the plan fixes `after`/`limit` semantics but no events limit
 * bound (history caps at 100). M0 adopts default 50 / max 200.
 */
export const EventsQuerySchema = z.strictObject({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type EventsQuery = z.infer<typeof EventsQuerySchema>;
export type EventsQueryInput = z.input<typeof EventsQuerySchema>;

/**
 * Events page (§12.2): `nextAfter` is the max returned seq (or the request
 * `after` when empty); `terminal` derives from Run status, never from the
 * event list.
 */
export const EventsResponseSchema = z.strictObject({
  events: z.array(RunEventSchema),
  nextAfter: z.number().int().min(0),
  hasMore: z.boolean(),
  terminal: z.boolean(),
});
export type EventsResponse = z.infer<typeof EventsResponseSchema>;

/* ------------------------------------------------------------------ */
/* Idempotency lookup                                                  */
/* ------------------------------------------------------------------ */

/**
 * GET /api/sessions/:sessionId/idempotency/:key?scope= (§12.1, §16.7).
 * Returns the stored status/body for replay, or a fixed resend-required
 * marker without creating anything. Bodies/snapshots are never stored in
 * the browser.
 */
export const IdempotencyLookupQuerySchema = z.strictObject({
  scope: IdempotencyScopeSchema,
});
export type IdempotencyLookupQuery = z.infer<typeof IdempotencyLookupQuerySchema>;

export const IdempotencyLookupResponseSchema = z.discriminatedUnion("found", [
  z.strictObject({
    found: z.literal(true),
    status: z.number().int().min(200).max(299),
    body: z.json(),
  }),
  z.strictObject({
    found: z.literal(false),
    code: z.literal("resend_required"),
  }),
]);
export type IdempotencyLookupResponse = z.infer<typeof IdempotencyLookupResponseSchema>;

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

/** Exact M0 API error codes: lowercase fixed codes (§12.3). */
export const ApiErrorCodeSchema = z.enum([
  "validation_error",
  "not_found",
  "idempotency_key_reused",
  "session_busy",
  "server_shutting_down",
  "internal_error",
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

export const ApiErrorSchema = z.strictObject({
  error: z.strictObject({
    code: ApiErrorCodeSchema,
    message: z.string().min(1).max(500),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

/* ------------------------------------------------------------------ */
/* Health (exact, §12.5)                                               */
/* ------------------------------------------------------------------ */

export const HealthLiveResponseSchema = z.strictObject({
  status: z.literal("live"),
});
export type HealthLiveResponse = z.infer<typeof HealthLiveResponseSchema>;

export const HealthReadyResponseSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("ready") }),
  z.strictObject({
    status: z.literal("not_ready"),
    code: z.literal("server_shutting_down"),
  }),
]);
export type HealthReadyResponse = z.infer<typeof HealthReadyResponseSchema>;

/** Re-export for route layers that validate the active-run guard. */
export { ActiveStatusSchema };
