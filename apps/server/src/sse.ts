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
        if (closed) {
          return;
        }
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
      };
      void step();
      pollTimer = setIntervalFn(() => {
        void step();
      }, SSE_POLL_MS);
      heartbeatTimer = setIntervalFn(() => {
        void writeWithGrace(SSE_HEARTBEAT_CHUNK);
      }, SSE_HEARTBEAT_MS);
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
