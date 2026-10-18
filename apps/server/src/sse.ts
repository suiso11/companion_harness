// M3 SSE delivery (plan §16.4, exact).
//
// Route: GET /api/sessions/:sessionId/runs/:runId/events/stream.
// - Session ownership enforced (foreign runs are 404, never 403).
// - Wire: SSE `id` = per-run seq (string), `event` = `run-event` fixed,
//   `data` = the full RunEvent DTO as one JSON line. No internal type name
//   in `event`.
// - Server loop: 250ms SQLite poll, `:` comment heartbeat every 15s,
//   awaited writes (backpressure respected), no unbounded queue, 5s
//   backpressure grace before closing a slow client, multi-client safe.
// - Disconnect never cancels the Run. The stream closes normally only when
//   the Run is terminal AND cursor >= runs.event_seq.

export const SSE_POLL_MS = 250;
export const SSE_HEARTBEAT_MS = 15_000;
export const SSE_BACKPRESSURE_GRACE_MS = 5_000;
export const SSE_PAGE_LIMIT = 50;

/** Minimal RunEvent DTO surface the SSE wire needs. */
export interface SseRunEventDto {
  readonly schemaVersion: number;
  readonly runId: string;
  readonly seq: number;
  readonly type: string;
  readonly createdAt: number;
  readonly payload: unknown;
}

/** Minimal repository surface the SSE loop needs (KernelRepository satisfies it). */
export interface SseEventSource {
  getEvents(
    sessionId: string,
    runId: string,
    query: { after?: number; limit?: number },
  ): {
    events: SseRunEventDto[];
    nextAfter: number;
    hasMore: boolean;
    terminal: boolean;
  };
  getRun(runId: string): { status: string; eventSeq: number };
}

/**
 * Format one RunEvent as SSE bytes (plan §16.4 exact):
 * `id` = seq string, `event` = `run-event`, `data` = full DTO one line.
 */
export function formatRunEventSse(event: SseRunEventDto): string {
  const data = JSON.stringify({
    schemaVersion: event.schemaVersion,
    runId: event.runId,
    seq: event.seq,
    type: event.type,
    createdAt: event.createdAt,
    payload: event.payload,
  });
  return `id: ${event.seq}\nevent: run-event\ndata: ${data}\n\n`;
}

/** SSE heartbeat: a `:` comment line every 15s (plan §16.4 exact). */
export const SSE_HEARTBEAT_CHUNK = ": heartbeat\n\n";

/** SSE response headers (plan §16.4; no buffering, no caching). */
export function sseHeaders(): Record<string, string> {
  return {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  };
}

/**
 * One poll step of the server loop. Returns the SSE chunks for events after
 * `cursor`, the advanced cursor, and whether the stream may close normally
 * (terminal AND cursor >= runs.event_seq, plan §16.4 exact).
 */
export function pollSseStep(
  source: SseEventSource,
  sessionId: string,
  runId: string,
  cursor: number,
): {
  readonly chunks: string[];
  readonly cursor: number;
  readonly done: boolean;
} {
  const page = source.getEvents(sessionId, runId, {
    after: cursor,
    limit: SSE_PAGE_LIMIT,
  });
  const chunks = page.events.map((event) => formatRunEventSse(event));
  const advanced = page.events.length > 0 ? page.nextAfter : cursor;
  if (!page.terminal) {
    return { chunks, cursor: advanced, done: false };
  }
  // Terminal: close only once the client cursor has reached event_seq.
  const run = source.getRun(runId);
  return { chunks, cursor: advanced, done: advanced >= run.eventSeq };
}

/**
 * Serve the SSE stream as a Response. The loop polls SQLite every 250ms,
 * heartbeats every 15s, awaits every write (backpressure respected, no
 * unbounded queue), and gives a slow client 5s of grace before closing.
 * Abort (client disconnect) ends the loop without touching the Run.
 */
export function createSseResponse(
  source: SseEventSource,
  sessionId: string,
  runId: string,
  cursor: number,
  timers: {
    setInterval?: typeof setInterval;
    clearInterval?: typeof clearInterval;
    setTimeout?: typeof setTimeout;
  } = {},
): Response {
  const setIntervalFn = timers.setInterval ?? setInterval;
  const clearIntervalFn = timers.clearInterval ?? clearInterval;
  const setTimeoutFn = timers.setTimeout ?? setTimeout;
  const encoder = new TextEncoder();
  let current = cursor;
  let closed = false;
  let stepping = false;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  // waiters woken by `pull` when the consumer drains the queue.
  let pullWaiters: Array<() => void> = [];

  const stream = new ReadableStream<Uint8Array>({
    pull() {
      const waiters = pullWaiters;
      pullWaiters = [];
      for (const wake of waiters) {
        wake();
      }
    },
    start(controller) {
      const cleanup = (): void => {
        if (closed) {
          return;
        }
        closed = true;
        if (pollTimer !== undefined) {
          clearIntervalFn(pollTimer);
        }
        if (heartbeatTimer !== undefined) {
          clearIntervalFn(heartbeatTimer);
        }
        const waiters = pullWaiters;
        pullWaiters = [];
        for (const wake of waiters) {
          wake();
        }
        try {
          controller.close();
        } catch {
          // Already closed by the consumer; nothing to do.
        }
      };
      /**
       * Awaited write honoring backpressure (§16.4): enqueue immediately
       * while the queue has room; otherwise wait up to the 5s grace for
       * the consumer to drain (`pull`) and close the slow client after it.
       */
      const writeWithGrace = async (chunk: string): Promise<boolean> => {
        if (closed) {
          return false;
        }
        const bytes = encoder.encode(chunk);
        const desired = controller.desiredSize;
        if (desired === null || desired > 0) {
          try {
            controller.enqueue(bytes);
            return true;
          } catch {
            cleanup();
            return false;
          }
        }
        const drained = await new Promise<boolean>((resolve) => {
          const timer = setTimeoutFn(
            () => resolve(false),
            SSE_BACKPRESSURE_GRACE_MS,
          );
          pullWaiters.push(() => {
            clearIntervalFn(timer as unknown as ReturnType<typeof setInterval>);
            resolve(true);
          });
        });
        if (!drained || closed) {
          cleanup();
          return false;
        }
        try {
          controller.enqueue(bytes);
          return true;
        } catch {
          cleanup();
          return false;
        }
      };
      const step = async (): Promise<void> => {
        if (closed || stepping) {
          return;
        }
        stepping = true;
        try {
          let chunks: string[];
          let done: boolean;
          try {
            const out = pollSseStep(source, sessionId, runId, current);
            chunks = [...out.chunks];
            current = out.cursor;
            done = out.done;
          } catch {
            cleanup();
            return;
          }
          for (const chunk of chunks) {
            const ok = await writeWithGrace(chunk);
            if (!ok || closed) {
              return;
            }
          }
          if (done) {
            cleanup();
          }
        } finally {
          stepping = false;
        }
      };
      // Timers are armed before the first tick so an initially terminal
      // run (first step closes the stream) never leaks an interval.
      pollTimer = setIntervalFn(() => {
        void step();
      }, SSE_POLL_MS);
      heartbeatTimer = setIntervalFn(() => {
        void writeWithGrace(SSE_HEARTBEAT_CHUNK);
      }, SSE_HEARTBEAT_MS);
      void step();
    },
    cancel() {
      closed = true;
      if (pollTimer !== undefined) {
        clearIntervalFn(pollTimer);
      }
      if (heartbeatTimer !== undefined) {
        clearIntervalFn(heartbeatTimer);
      }
    },
  });

  return new Response(stream, { status: 200, headers: sseHeaders() });
}

/* ---------------- AV05 notification feed (§SSE conventions reused) ------ */
// Owned durable feed: notifications `seq > cursor ORDER BY seq ASC` in
// bounded pages, so >100 new notices replay exactly once (never a
// latest-100 window filtered client-side). Reading never acks, never
// ingests. The stream is NEVER terminal by itself (done is always false):
// it ends only on client disconnect or on the server drain signal, which
// aborts SYNCHRONOUSLY before any further DB read (the run stream may rely
// on terminal close; this feed must not — shutdown closes the DB after the
// engine drain, and a post-close poll would throw).

/** Forward-page bound for the notification feed (contract max, exact-once). */
export const NOTIFICATION_SSE_PAGE_LIMIT = 100;

/** Fixed SSE event name for notification records (never an internal name). */
export const NOTIFICATION_SSE_EVENT = "notification" as const;

/** Minimal notification DTO surface the feed wire needs. */
export interface SseNotificationDto {
  readonly seq: number;
  readonly id: string;
  readonly sessionId: string;
  readonly scope: string;
  readonly kind: string;
  readonly priority: string;
  readonly briefText: string;
  readonly sourceKind: string;
  readonly sourceId: string;
  readonly outdated: boolean;
  readonly createdAt: number;
}

/** Minimal repository surface the notification feed loop needs. */
export interface NotificationFeedSource {
  listNotificationsForward(
    sessionId: string,
    query: { after?: number; limit?: number },
  ): {
    items: SseNotificationDto[];
    nextAfter: number | null;
    hasMore: boolean;
  };
}

/**
 * Format one notification as SSE bytes (same envelope as run events):
 * `id` = seq string, `event` = `notification` fixed, `data` = the full
 * notification DTO as one JSON line.
 */
export function formatNotificationSse(event: SseNotificationDto): string {
  const data = JSON.stringify({
    id: event.id,
    sessionId: event.sessionId,
    seq: event.seq,
    scope: event.scope,
    kind: event.kind,
    priority: event.priority,
    briefText: event.briefText,
    sourceKind: event.sourceKind,
    sourceId: event.sourceId,
    outdated: event.outdated,
    createdAt: event.createdAt,
  });
  return `id: ${event.seq}\nevent: ${NOTIFICATION_SSE_EVENT}\ndata: ${data}\n\n`;
}

/**
 * One poll step of the feed loop. Reads strictly after `cursor`
 * (`seq > cursor ORDER BY seq ASC`, bounded page): reconnect dedupes by
 * seq (the client replays `Last-Event-ID`), and every notice is delivered
 * exactly once even across >100-notice backlogs (later ticks continue
 * from the advanced cursor). Never terminal: `done` is always false.
 */
export function pollNotificationFeedStep(
  source: NotificationFeedSource,
  sessionId: string,
  cursor: number,
): {
  readonly chunks: string[];
  readonly cursor: number;
  readonly done: false;
} {
  const page = source.listNotificationsForward(sessionId, {
    after: cursor,
    limit: NOTIFICATION_SSE_PAGE_LIMIT,
  });
  const chunks = page.items.map((item) => formatNotificationSse(item));
  const advanced =
    page.items.length > 0
      ? (page.items[page.items.length - 1]?.seq ?? cursor)
      : cursor;
  return { chunks, cursor: advanced, done: false };
}

/**
 * Serve the notification feed as a Response. Same boring loop as run
 * events (250ms SQLite poll, 15s heartbeat, awaited writes with the 5s
 * backpressure grace, multi-client safe), except:
 * - ownership is session-scoped (the source read is already session-owned;
 *   no event from a foreign session can appear);
 * - the `isDraining` gate aborts the stream SYNCHRONOUSLY before any DB
 *   read (checked at the top of every tick): shutdown marks draining
 *   FIRST and only closes the DB after the engine drain, so an open feed
 *   always ends before the close and never throws a closed-DB error;
 * - abort (client disconnect) ends the loop and cleans the timers.
 * Reading the feed never acks: delivery state is untouched.
 */
export function createNotificationFeedSseResponse(
  source: NotificationFeedSource,
  sessionId: string,
  cursor: number,
  options: {
    isDraining?: () => boolean;
    setInterval?: typeof setInterval;
    clearInterval?: typeof clearInterval;
    setTimeout?: typeof setTimeout;
  } = {},
): Response {
  const isDraining = options.isDraining ?? (() => false);
  const setIntervalFn = options.setInterval ?? setInterval;
  const clearIntervalFn = options.clearInterval ?? clearInterval;
  const setTimeoutFn = options.setTimeout ?? setTimeout;
  const encoder = new TextEncoder();
  let current = cursor;
  let closed = false;
  let stepping = false;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let waiters: Array<() => void> = [];

  const stream = new ReadableStream<Uint8Array>({
    pull() {
      const pending = waiters;
      waiters = [];
      for (const wake of pending) {
        wake();
      }
    },
    start(controller) {
      const cleanup = (): void => {
        if (closed) {
          return;
        }
        closed = true;
        if (pollTimer !== undefined) {
          clearIntervalFn(pollTimer);
        }
        if (heartbeatTimer !== undefined) {
          clearIntervalFn(heartbeatTimer);
        }
        const pending = waiters;
        waiters = [];
        for (const wake of pending) {
          wake();
        }
        try {
          controller.close();
        } catch {
          // Already closed by the consumer; nothing to do.
        }
      };
      const writeWithGrace = async (chunk: string): Promise<boolean> => {
        if (closed) {
          return false;
        }
        const bytes = encoder.encode(chunk);
        const desired = controller.desiredSize;
        if (desired === null || desired > 0) {
          try {
            controller.enqueue(bytes);
            return true;
          } catch {
            cleanup();
            return false;
          }
        }
        const drained = await new Promise<boolean>((resolve) => {
          const timer = setTimeoutFn(
            () => resolve(false),
            SSE_BACKPRESSURE_GRACE_MS,
          );
          waiters.push(() => {
            clearIntervalFn(timer as unknown as ReturnType<typeof setInterval>);
            resolve(true);
          });
        });
        if (!drained || closed) {
          cleanup();
          return false;
        }
        try {
          controller.enqueue(bytes);
          return true;
        } catch {
          cleanup();
          return false;
        }
      };
      const step = async (): Promise<void> => {
        if (closed || stepping) {
          return;
        }
        // Synchronous drain gate BEFORE any DB read: a draining server
        // ends the open feed here, never after the DB close.
        if (isDraining()) {
          cleanup();
          return;
        }
        stepping = true;
        try {
          let chunks: string[];
          try {
            const out = pollNotificationFeedStep(source, sessionId, current);
            chunks = [...out.chunks];
            current = out.cursor;
          } catch {
            cleanup();
            return;
          }
          for (const chunk of chunks) {
            const ok = await writeWithGrace(chunk);
            if (!ok || closed || isDraining()) {
              if (isDraining()) {
                cleanup();
              }
              return;
            }
          }
        } finally {
          stepping = false;
        }
      };
      pollTimer = setIntervalFn(() => {
        void step();
      }, SSE_POLL_MS);
      heartbeatTimer = setIntervalFn(() => {
        void writeWithGrace(SSE_HEARTBEAT_CHUNK);
      }, SSE_HEARTBEAT_MS);
      void step();
    },
    cancel() {
      closed = true;
      if (pollTimer !== undefined) {
        clearIntervalFn(pollTimer);
      }
      if (heartbeatTimer !== undefined) {
        clearIntervalFn(heartbeatTimer);
      }
    },
  });

  return new Response(stream, { status: 200, headers: sseHeaders() });
}
