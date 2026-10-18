// E2E fake HTTP server harness: real production UI/server/core on loopback.
//
// Boots the REAL Hono createApp over @hono/node-server with a temp-file
// SQLite DB, a REAL RunEngine, and a deterministic fake RunStrategy
// registered under the repository default ("m0-default"). No real LLM:
// the strategy chooses predictable behavior from the turn input text
// (see e2e/ports.ts TEXT_* constants). Production UI assets come from
// loadUiAssets(), so the webServer command must build the UI first.
//
// A second loopback-only control server exposes test-only failure
// injection the specs drive via Playwright's Node-side `request`
// fixture (never from the page, never mocked API responses):
//   POST /arm-fail  -> the next TEXT_FAIL run throws execution_failed once
//   POST /release   -> release hanging TEXT_HANG strategies (also on abort)
//   POST /arm-cancel-hold -> ignore cooperative abort until release; the
//     real RunEngine's production 3s cancellation watchdog remains active
//   POST /reset     -> clear controls + release hangers
//   POST /seed-citation { sessionId } -> store one immutable snapshot +
//     session reference (ordinal rN) for that session via direct SQL
//     (fixture setup only; drawer/CAS/rendering stay on real routes/UI)
//   POST /seed-proposal { sessionId, target, quote, ... } -> stage one
//     conversation proposal from the session's latest user_text turn via
//     the real model-only kernel path (fixture setup only)
//   POST /seed-proposal-burst { sessionId, decided, pendingQuote } -> one
//     old pending + `decided` rejected drafts via the real kernel paths
//     (fixture setup only; paging/badge/review stay on real routes/UI)
//   POST /seed-history { sessionId, count, prefix } -> store `count`
//     completed user_text turns (+ selected V1 runs with queued/started/
//     completed events) for that session via direct SQL (fixture setup
//     only; pagination/rendering stay on the real history routes/UI)
//   GET  /health    -> { status: "ok" }
//
// A third loopback-only transport-fault proxy (E2E_PROXY_PORT) forwards
// successful requests to the real app without fabricated DTOs:
//   POST /proxy/reset -> release held transports/streams + clear controls
//   POST /proxy/arm-drop { seq } -> drop one actual SSE frame
//   POST /proxy/drop-sse -> destroy all live proxied SSE sockets
//   POST /proxy/configure { unavailableSse?, holdPages?, failures?,
//     duplicateSeqs? } -> bounded transport faults; failures is a boolean
//     request schedule, duplicates resend the actual frame byte-for-byte
//   POST /proxy/release-pages -> forward held genuine upstream responses
//   GET /proxy/status -> counters and bounded page lifecycle timings
//
// Temp DB dir is removed on shutdown (SIGINT/SIGTERM included).

import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeKernelDatabase,
  createKernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
  RunEngine,
  type RunStrategyContext,
  StrategyError,
  StrategyRegistry,
} from "@companion/kernel";
import { serve } from "@hono/node-server";
import { createApp } from "../src/app.js";
import { loadUiAssets } from "../src/bootstrap.js";
import { loadServerConfig } from "../src/config.js";
import { createStdServerLogger } from "../src/logger.js";
import {
  CITATION_SNAPSHOT_TEXT,
  E2E_APP_PORT,
  E2E_CONTROL_PORT,
  E2E_PROXY_PORT,
  TEXT_CITE,
  TEXT_CITE_MEM,
  TEXT_CITE_TWO,
  TEXT_FAIL,
  TEXT_HANG,
} from "./ports.js";

const dir = mkdtempSync(join(tmpdir(), "companion-e2e-"));
const dbPath = join(dir, "companion.sqlite");

const config = loadServerConfig({
  COMPANION_DB_PATH: dbPath,
  COMPANION_HOST: "127.0.0.1",
  COMPANION_PORT: String(E2E_APP_PORT),
  COMPANION_TIME_ZONE: "UTC",
  COMPANION_LOG_LEVEL: "error",
});
const logger = createStdServerLogger("error");

// Shared control state (single process, no persistence).
let failArmed = false;
let releaseHangers: Array<() => void> = [];
let holdCancel = false;
let pendingReleases = 0;
function releaseAll(): void {
  const pending = releaseHangers;
  releaseHangers = [];
  if (pending.length === 0) {
    // Sticky release: a /release that lands before the TEXT_HANG strategy
    // registers its hanger must not be lost, otherwise the next hang waits
    // forever (malformed-cursor race). The next hang consumes one credit
    // and resolves immediately.
    pendingReleases += 1;
    return;
  }
  for (const release of pending) {
    try {
      release();
    } catch {
      // Best effort.
    }
  }
}

function inputText(ctx: RunStrategyContext): string {
  const text = (ctx.turn.input as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
}

// Deterministic fake strategy: predictable behavior from input text only.
const registry = new StrategyRegistry();
registry.register("m0-default", async (ctx: RunStrategyContext) => {
  const text = inputText(ctx);
  if (text.includes(TEXT_HANG)) {
    // Consume a sticky early release so a /release that raced ahead of
    // strategy registration still unblocks this hang deterministically.
    if (pendingReleases > 0) {
      pendingReleases -= 1;
      return { version: 1, text: `echo:${text}` };
    }
    // Hang until released or aborted (cooperative cancel).
    await new Promise<void>((resolve, reject) => {
      if (ctx.signal.aborted) {
        reject(new StrategyError("execution_cancelled"));
        return;
      }
      const onRelease = (): void => {
        ctx.signal.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = (): void => {
        // Drop the stale releaser so a later /release or /reset cannot
        // resolve an already-rejected hang (avoids a releaser leak).
        releaseHangers = releaseHangers.filter((fn) => fn !== onRelease);
        if (!holdCancel) {
          reject(new StrategyError("execution_cancelled"));
        } else {
          // Non-cooperative fake only: the real engine's production 3s
          // watchdog still bounds cancellation; /release can settle sooner.
          releaseHangers.push(onRelease);
        }
      };
      releaseHangers.push(onRelease);
      ctx.signal.addEventListener("abort", onAbort, { once: true });
    });
    if (ctx.signal.aborted) {
      throw new StrategyError("execution_cancelled");
    }
    return { version: 1, text: `echo:${text}` };
  }
  if (text.includes(TEXT_FAIL) && failArmed) {
    // Fail exactly once per arm so the retry succeeds deterministically.
    failArmed = false;
    throw new StrategyError("execution_failed");
  }
  if (text.includes(TEXT_CITE_TWO)) {
    // V2 structured answer with structural r1+r2 citations for
    // deterministic drawer races (two distinct stored snapshots).
    return {
      version: 2,
      text: "cited answer two",
      answer: {
        version: 1,
        parts: [{ text: "cited answer two", citations: ["r1", "r2"] }],
      },
    };
  }
  if (text.includes(TEXT_CITE_MEM)) {
    // V2 structured answer with a structural m1 citation bound to the
    // originating run. The recall exposure itself stays on the real route
    // (genuine 404 in this harness, which has no memory backend).
    return {
      version: 2,
      text: "cited mem answer",
      answer: {
        version: 1,
        parts: [{ text: "cited mem answer", citations: ["m1"] }],
      },
    };
  }
  if (text.includes(TEXT_CITE)) {
    // V2 structured answer with a structural r1 citation. The engine only
    // schema-validates the candidate (no grant check for this fake), so the
    // UI renders a real citation button; the stored r1 snapshot itself is
    // seeded per-session via POST /seed-citation (test fixture setup, never
    // a mocked API response). Text equals parts joined by blank lines.
    return {
      version: 2,
      text: "cited answer",
      answer: {
        version: 1,
        parts: [{ text: "cited answer", citations: ["r1"] }],
      },
    };
  }
  return { version: 1, text: `echo:${text}` };
});

const handle = openKernelDatabase(dbPath);
await migrateKernelDatabase({ db: handle.raw });
const repo = createKernelRepository(handle.raw);
const engine = new RunEngine({
  db: handle.raw,
  repo,
  registry,
  cancelGraceMs: 3000,
});
engine.start();

const { app } = createApp({
  config,
  repo,
  engine,
  logger,
  assets: loadUiAssets(),
});

const appServer = serve(
  { fetch: app.fetch, port: config.port, hostname: config.host },
  (info) => {
    // eslint-disable-next-line no-console
    console.log(`e2e-server-ready http://127.0.0.1:${info.port}`);
  },
);

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", () => resolve(""));
  });
}

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Test-fixture seed (narrow): store one immutable snapshot + session
 * reference (ordinal rN) for the given session via direct SQL. This is
 * fixture setup only — the drawer fetch, CAS PUT, and escaped rendering
 * under test all run through the real production routes/UI. The snapshot
 * body carries markup-significant characters to prove escaped rendering.
 */
function seedCitation(
  sessionId: string,
  text?: unknown,
): {
  referenceId: string;
  ordinal: number;
  snapshotId: string;
} {
  const db = handle.raw as unknown as {
    prepare(sql: string): {
      get(...params: unknown[]): Record<string, unknown> | undefined;
      run(...params: unknown[]): { changes: number };
    };
  };
  const now = Date.now();
  const session = db
    .prepare("SELECT id FROM sessions WHERE id = ?")
    .get(sessionId) as { id: string } | undefined;
  if (session === undefined) {
    throw new Error("session not found");
  }
  let connector = db
    .prepare("SELECT id FROM connector_instances WHERE kind = ?")
    .get("e2e-fake") as { id: string } | undefined;
  if (connector === undefined) {
    const id = randomUUID();
    db.prepare(
      "INSERT INTO connector_instances (id, kind, display_name, config_json, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(id, "e2e-fake", "e2e fake vault", '{"version":1,"rootCount":1}', now);
    connector = { id };
  }
  const connectorId = connector.id;
  // One fresh resource per seed call (unique canonical key, revision 1):
  // the shared-key form could seed only once per server lifetime
  // (UNIQUE(resource_id, revision)), which blocks a second citation test in
  // the same webServer run. Ordinals stay per-session via MAX(ordinal)+1.
  const resourceId = randomUUID();
  db.prepare(
    "INSERT INTO resources (id, connector_instance_id, canonical_key, title, next_revision, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    resourceId,
    connectorId,
    `e2e-citation-doc-${resourceId}`,
    "E2E citation doc",
    2,
    now,
  );
  const resource = { id: resourceId };
  // Plain-text only: no control characters, stays escaped in the drawer.
  let customText: string | null = null;
  if (typeof text === "string" && text.length > 0 && text.length <= 500) {
    let hasControl = false;
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
        hasControl = true;
        break;
      }
    }
    if (!hasControl) {
      customText = text;
    }
  }
  const snapshotText = customText ?? CITATION_SNAPSHOT_TEXT;
  const normalized = snapshotText.normalize("NFC");
  const contentHash = createHash("sha256")
    .update(normalized, "utf8")
    .digest("hex");
  const sizeBytes = Buffer.byteLength(normalized, "utf8");
  const snapshotId = randomUUID();
  db.prepare(
    "INSERT INTO resource_snapshots (id, resource_id, revision, source_revision, content_hash, body_json, size_bytes, observed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    snapshotId,
    (resource as { id: string }).id,
    1,
    null,
    contentHash,
    JSON.stringify({ version: 1, text: normalized }),
    sizeBytes,
    now,
    now,
  );
  const maxRow = db
    .prepare(
      "SELECT COALESCE(MAX(ordinal), 0) AS maxOrdinal FROM session_references WHERE session_id = ?",
    )
    .get(sessionId) as { maxOrdinal: number } | undefined;
  const ordinal = (maxRow?.maxOrdinal ?? 0) + 1;
  const referenceId = randomUUID();
  db.prepare(
    "INSERT INTO session_references (id, session_id, ordinal, resource_id, snapshot_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    referenceId,
    sessionId,
    ordinal,
    (resource as { id: string }).id,
    snapshotId,
    now,
  );
  try {
    db.prepare(
      "UPDATE sessions SET next_reference_ordinal = ? WHERE id = ?",
    ).run(ordinal + 1, sessionId);
  } catch {
    // Column predates some DBs; the ordinal itself is authoritative.
  }
  return { referenceId, ordinal, snapshotId };
}

/**
 * Test-fixture seed (narrow): store `count` completed `user_text` turns
 * (+ one selected V1 Run each, with queued/started/completed events) for
 * the given session via direct SQL. Fixture setup only — pagination and
 * rendering under test run through the real history routes/UI. Texts are
 * `${prefix}-NNN` (user) / `${prefix}-answer-NNN` (V1 result) so specs can
 * assert chronological order and absence of duplicates.
 */
function seedHistory(
  sessionId: string,
  count: number,
  prefix: string,
): { count: number; firstSeq: number; lastSeq: number } {
  const db = handle.raw as unknown as {
    prepare(sql: string): {
      get(...params: unknown[]): Record<string, unknown> | undefined;
      run(...params: unknown[]): { changes: number };
    };
  };
  const now = Date.now();
  const session = db
    .prepare(
      "SELECT id, next_turn_position AS nextTurn FROM sessions WHERE id = ?",
    )
    .get(sessionId) as { id: string; nextTurn: number } | undefined;
  if (session === undefined) {
    throw new Error("session not found");
  }
  const contextRow = db
    .prepare(
      "SELECT version FROM session_reference_context WHERE session_id = ?",
    )
    .get(sessionId) as { version: number } | undefined;
  const contextVersion =
    contextRow !== undefined && Number.isSafeInteger(contextRow.version)
      ? contextRow.version
      : 1;
  const startSeq = session.nextTurn;
  for (let index = 0; index < count; index += 1) {
    const seq = startSeq + index;
    const padded = String(index).padStart(3, "0");
    const text = `${prefix}-${padded}`;
    const answer = `${prefix}-answer-${padded}`;
    const turnId = randomUUID();
    const runId = randomUUID();
    const inputJson = JSON.stringify({
      kind: "user_text",
      version: 1,
      text,
    });
    const frozen = JSON.stringify({
      version: 1,
      temporal: { now, timeZone: "UTC" },
      uiContext: {},
      referenceContext: { version: contextVersion, items: [] },
    });
    db.prepare(
      "INSERT INTO turns (id, session_id, seq, input_json, frozen_context, created_at, next_run_attempt) VALUES (?, ?, ?, ?, ?, ?, 2)",
    ).run(turnId, sessionId, seq, inputJson, frozen, now);
    db.prepare(
      `INSERT INTO runs (id, turn_id, session_id, attempt, status, strategy,
        result_json, error_code, event_seq, select_on_success,
        tool_requests_used, created_at, started_at, finished_at, cancel_requested_at)
       VALUES (?, ?, ?, 1, 'completed', 'm0-default', ?, NULL, 3, 1, 0, ?, ?, ?, NULL)`,
    ).run(
      runId,
      turnId,
      sessionId,
      JSON.stringify({ version: 1, text: answer }),
      now,
      now,
      now,
    );
    const events: Array<{ seq: number; type: string; payload: string }> = [
      { seq: 1, type: "run.queued", payload: JSON.stringify({ attempt: 1 }) },
      { seq: 2, type: "run.started", payload: JSON.stringify({ attempt: 1 }) },
      {
        seq: 3,
        type: "run.completed",
        payload: JSON.stringify({
          result: { version: 1, text: answer },
        }),
      },
    ];
    for (const event of events) {
      db.prepare(
        "INSERT INTO run_events (run_id, seq, schema_version, type, payload, created_at) VALUES (?, ?, 1, ?, ?, ?)",
      ).run(runId, event.seq, event.type, event.payload, now);
    }
    db.prepare(
      "INSERT INTO turn_selections (turn_id, run_id, selected_at) VALUES (?, ?, ?)",
    ).run(turnId, runId, now);
  }
  db.prepare(
    "UPDATE sessions SET next_turn_position = ?, last_active_at = ? WHERE id = ?",
  ).run(startSeq + count, now, sessionId);
  return { count, firstSeq: startSeq, lastSeq: startSeq + count - 1 };
}

/* ------------------------------------------------------------------ */
/* Loopback SSE fault proxy (observation + real transport faults only)  */
/* ------------------------------------------------------------------ */

const RUN_STREAM_RE =
  /\/api\/sessions\/[0-9a-f-]{36}\/runs\/([0-9a-f-]{36})\/events\/stream/;
const RUN_EVENTS_PAGE_RE =
  /\/api\/sessions\/[0-9a-f-]{36}\/runs\/([0-9a-f-]{36})\/events(\?|$)/;
const RUN_STATUS_RE =
  /\/api\/sessions\/[0-9a-f-]{36}\/runs\/([0-9a-f-]{36})\/status(\?|$)/;

interface ProxyState {
  sseActive: number;
  sseConnections: number;
  sseReconnects: number;
  /** Last `Last-Event-ID` request header seen on a (re)connecting stream. */
  lastLastEventId: string | null;
  /** Last SSE `id:` frame value actually forwarded to the browser. */
  lastForwardedId: number;
  lastStreamRunId: string | null;
  droppedFrames: number;
  eventsPageRequests: number;
  statusRequests: number;
  blockedSse: number;
  duplicatedFrames: number;
  failedPages: number;
  pagesInFlight: number;
  pagesFinished: number;
  maxPagesInFlight: number;
  heldPages: number;
  historyRequests: number;
  cancelRequests: number;
  pageTimings: Array<{ start: number; finish: number | null; status: number }>;
}

const proxyState: ProxyState = {
  sseActive: 0,
  sseConnections: 0,
  sseReconnects: 0,
  lastLastEventId: null,
  lastForwardedId: 0,
  lastStreamRunId: null,
  droppedFrames: 0,
  eventsPageRequests: 0,
  statusRequests: 0,
  blockedSse: 0,
  duplicatedFrames: 0,
  failedPages: 0,
  pagesInFlight: 0,
  pagesFinished: 0,
  maxPagesInFlight: 0,
  heldPages: 0,
  historyRequests: 0,
  cancelRequests: 0,
  pageTimings: [],
};

/** Armed frame seq to drop once (fault injection over real SSE bytes). */
let dropFrameSeq: number | null = null;
const activeSseDownstreams = new Set<ServerResponse>();
let unavailableSse = false;
let pageFailures: boolean[] = [];
let holdPages = false;
const duplicateSeqs = new Set<number>();
const heldTransports = new Set<() => void>();
let proxyGeneration = 0;

function releaseTransports(): void {
  for (const release of [...heldTransports]) {
    release();
  }
}

/** Every hold is bounded and released on reset/shutdown or socket close. */
function holdTransport(res: ServerResponse, release: () => void): void {
  const finish = (): void => {
    if (!heldTransports.delete(finish)) {
      return;
    }
    clearTimeout(timer);
    res.removeListener("close", finish);
    release();
  };
  const timer = setTimeout(finish, 15_000);
  heldTransports.add(finish);
  res.once("close", finish);
}

function resetControlState(): void {
  failArmed = false;
  for (const release of releaseHangers) {
    release();
  }
  releaseHangers = [];
  holdCancel = false;
  pendingReleases = 0;
}
function resetProxyState(): void {
  proxyGeneration += 1;
  unavailableSse = false;
  holdPages = false;
  pageFailures = [];
  duplicateSeqs.clear();
  releaseTransports();
  dropAllSse();
  for (const key of Object.keys(proxyState) as Array<keyof ProxyState>) {
    if (key === "pageTimings") {
      proxyState.pageTimings = [];
    } else if (key === "lastLastEventId" || key === "lastStreamRunId") {
      proxyState[key] = null;
    } else {
      proxyState[key] = 0;
    }
  }
  dropFrameSeq = null;
}

const proxy = createServer((req, res) => {
  // Never let a destroyed test socket crash the harness process.
  res.on("error", () => {});
  req.on("error", () => {});
  const path = req.url ?? "/";
  // Test-only proxy controls (loopback-only, never part of the app).
  if (req.method === "POST" && path === "/proxy/reset") {
    resetProxyState();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ reset: true }));
    return;
  }
  if (req.method === "POST" && path === "/proxy/drop-sse") {
    const dropped = dropAllSse();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ dropped }));
    return;
  }
  if (req.method === "GET" && path === "/proxy/status") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ...proxyState }));
    return;
  }
  if (req.method === "POST" && path === "/proxy/release-pages") {
    holdPages = false;
    releaseTransports();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ released: true }));
    return;
  }
  if (req.method === "POST" && path === "/proxy/configure") {
    void readBody(req).then((raw) => {
      try {
        const body = JSON.parse(raw) as {
          unavailableSse?: boolean;
          holdPages?: boolean;
          failures?: boolean[];
          duplicateSeqs?: number[];
        };
        if (
          (body.unavailableSse !== undefined &&
            typeof body.unavailableSse !== "boolean") ||
          (body.holdPages !== undefined &&
            typeof body.holdPages !== "boolean") ||
          (body.failures !== undefined &&
            (!Array.isArray(body.failures) ||
              body.failures.length > 20 ||
              body.failures.some((item) => typeof item !== "boolean"))) ||
          (body.duplicateSeqs !== undefined &&
            (!Array.isArray(body.duplicateSeqs) ||
              body.duplicateSeqs.length > 10 ||
              body.duplicateSeqs.some(
                (seq) => !Number.isSafeInteger(seq) || seq < 1,
              )))
        ) {
          throw new Error("invalid control");
        }
        unavailableSse = body.unavailableSse ?? unavailableSse;
        holdPages = body.holdPages ?? holdPages;
        pageFailures = body.failures ?? pageFailures;
        for (const seq of body.duplicateSeqs ?? []) {
          duplicateSeqs.add(seq);
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ configured: true }));
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "validation_error" } }));
      }
    });
    return;
  }
  if (req.method === "POST" && path === "/proxy/arm-drop") {
    void readBody(req).then((raw) => {
      let seq: unknown = null;
      try {
        seq = (JSON.parse(raw === "" ? "{}" : raw) as { seq?: unknown }).seq;
      } catch {
        seq = null;
      }
      if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "validation_error" } }));
        return;
      }
      dropFrameSeq = seq;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ armed: seq }));
    });
    return;
  }
  if (RUN_STREAM_RE.test(path) && unavailableSse) {
    proxyState.blockedSse += 1;
    // Do not send headers: native EventSource never establishes.
    holdTransport(res, () => res.destroy());
    return;
  }
  const isPage = RUN_EVENTS_PAGE_RE.test(path);
  if (isPage) {
    proxyState.eventsPageRequests += 1;
    proxyState.pagesInFlight += 1;
    proxyState.maxPagesInFlight = Math.max(
      proxyState.maxPagesInFlight,
      proxyState.pagesInFlight,
    );
    const timing = {
      start: Date.now(),
      finish: null as number | null,
      status: 0,
    };
    const generation = proxyGeneration;
    if (proxyState.pageTimings.length < 200) {
      proxyState.pageTimings.push(timing);
    }
    res.once("close", () => {
      if (generation !== proxyGeneration) {
        return;
      }
      timing.finish = Date.now();
      timing.status = res.statusCode;
      proxyState.pagesInFlight = Math.max(0, proxyState.pagesInFlight - 1);
      proxyState.pagesFinished += 1;
    });
    if (pageFailures.shift() === true) {
      proxyState.failedPages += 1;
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "transport_fault" } }));
      return;
    }
  }
  if (/\/history(\?|$)/.test(path)) {
    proxyState.historyRequests += 1;
  }
  if (req.method === "POST" && /\/cancel$/.test(path)) {
    proxyState.cancelRequests += 1;
  }
  if (RUN_STATUS_RE.test(path)) {
    proxyState.statusRequests += 1;
  }
  const upstream = httpRequest(
    {
      host: "127.0.0.1",
      port: E2E_APP_PORT,
      path,
      method: req.method,
      headers: req.headers,
    },
    (upRes) => {
      upRes.on("error", () => {});
      upRes.on("aborted", () => {});
      const contentType = String(upRes.headers["content-type"] ?? "");
      const streamMatch = RUN_STREAM_RE.exec(path);
      if (streamMatch !== null && contentType.includes("text/event-stream")) {
        // Observe the SSE stream: forward byte-for-byte except one armed
        // frame, and expose the wire cursor for deterministic fault timing.
        proxyState.sseActive += 1;
        proxyState.sseConnections += 1;
        activeSseDownstreams.add(res);
        proxyState.lastStreamRunId = streamMatch[1] ?? null;
        const lastEventId = req.headers["last-event-id"];
        if (typeof lastEventId === "string" && lastEventId.length > 0) {
          proxyState.sseReconnects += 1;
          proxyState.lastLastEventId = lastEventId;
        }
        let buffer = "";
        const generation = proxyGeneration;
        const cleanup = (): void => {
          if (!activeSseDownstreams.has(res)) {
            return;
          }
          if (generation === proxyGeneration) {
            proxyState.sseActive = Math.max(0, proxyState.sseActive - 1);
          }
          activeSseDownstreams.delete(res);
          upRes.destroy();
        };
        res.on("close", cleanup);
        res.writeHead(upRes.statusCode ?? 200, upRes.headers);
        upRes.setEncoding("utf8");
        upRes.on("data", (chunk: string) => {
          buffer += chunk;
          for (;;) {
            const end = buffer.indexOf("\n\n");
            if (end < 0) {
              break;
            }
            const frame = buffer.slice(0, end + 2);
            buffer = buffer.slice(end + 2);
            const idMatch = /^id: (\d+)$/m.exec(frame);
            if (
              idMatch !== null &&
              dropFrameSeq !== null &&
              Number(idMatch[1]) === dropFrameSeq
            ) {
              dropFrameSeq = null;
              proxyState.droppedFrames += 1;
              continue;
            }
            if (idMatch !== null) {
              proxyState.lastForwardedId = Number(idMatch[1]);
            }
            res.write(frame);
            if (idMatch !== null && duplicateSeqs.delete(Number(idMatch[1]))) {
              // Duplicate the actual complete frame, never a synthetic DTO.
              res.write(frame);
              proxyState.duplicatedFrames += 1;
            }
          }
        });
        upRes.on("end", () => {
          if (buffer.length > 0) {
            res.write(buffer);
          }
          res.end();
          cleanup();
        });
      } else {
        const forward = (): void => {
          if (!res.destroyed) {
            res.writeHead(upRes.statusCode ?? 502, upRes.headers);
            upRes.pipe(res);
          } else {
            upRes.destroy();
          }
        };
        if (isPage && holdPages) {
          proxyState.heldPages += 1;
          upRes.pause();
          holdTransport(res, forward);
        } else {
          forward();
        }
      }
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
    }
    try {
      res.end(JSON.stringify({ error: { code: "upstream_unavailable" } }));
    } catch {
      // Socket already gone.
    }
  });
  req.pipe(upstream);
});

proxy.listen(E2E_PROXY_PORT, "127.0.0.1", () => {
  // eslint-disable-next-line no-console
  console.log(`e2e-proxy-ready http://127.0.0.1:${E2E_PROXY_PORT}`);
});

function dropAllSse(): number {
  const targets = [...activeSseDownstreams];
  for (const res of targets) {
    res.destroy();
  }
  return targets.length;
}

const control = createServer(
  async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const rawBody = await readBody(req);
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const parseJsonBody = (): Record<string, unknown> | null => {
      try {
        const parsed: unknown =
          rawBody === "" ? {} : (JSON.parse(rawBody) as unknown);
        return typeof parsed === "object" && parsed !== null
          ? (parsed as Record<string, unknown>)
          : null;
      } catch {
        return null;
      }
    };
    if (req.method === "GET" && url.pathname === "/health") {
      json(200, { status: "ok" });
      return;
    }
    if (req.method === "POST" && url.pathname === "/arm-fail") {
      failArmed = true;
      json(200, { armed: true });
      return;
    }
    if (req.method === "POST" && url.pathname === "/arm-cancel-hold") {
      holdCancel = true;
      json(200, { armed: true });
      return;
    }
    if (req.method === "POST" && url.pathname === "/release") {
      releaseAll();
      json(200, { released: true });
      return;
    }
    if (req.method === "POST" && url.pathname === "/reset") {
      resetControlState();
      json(200, { reset: true });
      return;
    }
    if (req.method === "POST" && url.pathname === "/seed-citation") {
      let sessionId: unknown = null;
      let text: unknown = null;
      try {
        const parsed = JSON.parse(rawBody === "" ? "{}" : rawBody) as {
          sessionId?: unknown;
          text?: unknown;
        };
        sessionId = parsed.sessionId;
        text = parsed.text;
      } catch {
        json(400, { error: { code: "validation_error" } });
        return;
      }
      if (typeof sessionId !== "string" || !UUID_V4_RE.test(sessionId)) {
        json(400, { error: { code: "validation_error" } });
        return;
      }
      try {
        json(200, seedCitation(sessionId, text));
      } catch {
        json(404, { error: { code: "not_found" } });
      }
      return;
    }
    if (req.method === "POST" && url.pathname === "/seed-history") {
      const parsed = parseJsonBody();
      const sessionId = parsed?.sessionId;
      const count = parsed?.count;
      const prefix = parsed?.prefix;
      if (
        typeof sessionId !== "string" ||
        !UUID_V4_RE.test(sessionId) ||
        typeof count !== "number" ||
        !Number.isInteger(count) ||
        count < 1 ||
        count > 200 ||
        typeof prefix !== "string" ||
        !/^[A-Za-z0-9-]{1,32}$/.test(prefix)
      ) {
        json(400, { error: { code: "validation_error" } });
        return;
      }
      try {
        json(200, seedHistory(sessionId, count, prefix));
      } catch {
        json(404, { error: { code: "not_found" } });
      }
      return;
    }
    if (req.method === "POST" && url.pathname === "/seed-proposal") {
      // Test-fixture seed (narrow): stage ONE conversation proposal from the
      // session's LATEST ordinary `user_text` turn via the REAL kernel
      // model-only path (`stageConversationProposalFromModel`, the exact
      // function the `purpose.propose` / `task.propose` tool registrations
      // call). The quote must be an exact substring of that OWN turn text;
      // the model-native toolcall half is proven in the kernel agent test.
      // Fixture setup only — listing/review/adopt all run through the real
      // production routes/UI. `{ sessionId, target, quote, scope?,
      // draftKind?, purposeKind?, taskKind?, interpretation?,
      // parentPurposeId?, expectedParentVersion? }`.
      const parsed = parseJsonBody();
      const sessionId = parsed?.sessionId;
      const target = parsed?.target;
      const quote = parsed?.quote;
      const scope = typeof parsed?.scope === "string" ? parsed.scope : "health";
      const draftKind =
        typeof parsed?.draftKind === "string" ? parsed.draftKind : "wish";
      const interpretation =
        typeof parsed?.interpretation === "string"
          ? parsed.interpretation
          : "e2e inferred interpretation";
      if (
        typeof sessionId !== "string" ||
        !UUID_V4_RE.test(sessionId) ||
        (target !== "purpose" && target !== "task") ||
        typeof quote !== "string" ||
        quote.length === 0
      ) {
        json(400, { error: { code: "validation_error" } });
        return;
      }
      try {
        const db = handle.raw as unknown as {
          prepare(sql: string): {
            get(...params: unknown[]): Record<string, unknown> | undefined;
            all(...params: unknown[]): Array<Record<string, unknown>>;
          };
        };
        const turns = db
          .prepare(
            "SELECT id, input_json FROM turns WHERE session_id = ? ORDER BY seq DESC LIMIT 25",
          )
          .all(sessionId) as Array<{ id: string; input_json: string }>;
        let sourceRunId: string | null = null;
        let sourceText: string | null = null;
        for (const turn of turns) {
          let input: unknown = null;
          try {
            input = JSON.parse(turn.input_json) as unknown;
          } catch {
            continue;
          }
          if (
            typeof input !== "object" ||
            input === null ||
            (input as { kind?: unknown }).kind !== "user_text" ||
            typeof (input as { text?: unknown }).text !== "string"
          ) {
            continue;
          }
          const runRow = db
            .prepare(
              "SELECT id FROM runs WHERE turn_id = ? ORDER BY created_at DESC LIMIT 1",
            )
            .get(turn.id) as { id: string } | undefined;
          if (runRow === undefined) {
            continue;
          }
          sourceRunId = runRow.id;
          sourceText = (input as { text: string }).text;
          break;
        }
        if (sourceRunId === null || sourceText === null) {
          json(404, { error: { code: "not_found" } });
          return;
        }
        if (!sourceText.includes(quote)) {
          json(400, { error: { code: "validation_error" } });
          return;
        }
        const draft: Record<string, unknown> = {
          target,
          scope,
          draftKind,
          sourceQuote: quote,
          interpretation,
        };
        if (target === "purpose") {
          draft.purposeKind =
            typeof parsed?.purposeKind === "string"
              ? parsed.purposeKind
              : "goal";
        } else {
          draft.taskKind =
            typeof parsed?.taskKind === "string" ? parsed.taskKind : "task";
          if (
            typeof parsed?.parentPurposeId !== "string" ||
            !UUID_V4_RE.test(parsed.parentPurposeId) ||
            typeof parsed?.expectedParentVersion !== "number"
          ) {
            json(400, { error: { code: "validation_error" } });
            return;
          }
          draft.parentPurposeId = parsed.parentPurposeId;
          draft.expectedParentVersion = parsed.expectedParentVersion;
        }
        const staged = repo.stageConversationProposalFromModel(
          sourceRunId,
          draft,
          { key: randomUUID() },
        );
        json(staged.status, staged.body);
      } catch {
        json(400, { error: { code: "validation_error" } });
      }
      return;
    }
    if (req.method === "POST" && url.pathname === "/seed-proposal-burst") {
      // Test-fixture bulk history (narrow): ONE old pending draft first,
      // then N decided (rejected) drafts, all through the REAL kernel
      // paths (`postMessage`/`startRun` + `stageConversationProposalFromModel`
      // + `rejectConversationProposal`). Each quote occurs exactly once in
      // its own source text. Fixture setup only — paging, badge, and review
      // all run through the real production routes/UI.
      // `{ sessionId, decided, pendingQuote }` (1 <= decided <= 80).
      const parsed = parseJsonBody();
      const sessionId = parsed?.sessionId;
      const decided = parsed?.decided;
      const pendingQuote = parsed?.pendingQuote;
      if (
        typeof sessionId !== "string" ||
        !UUID_V4_RE.test(sessionId) ||
        typeof decided !== "number" ||
        !Number.isInteger(decided) ||
        decided < 1 ||
        decided > 80 ||
        typeof pendingQuote !== "string" ||
        pendingQuote.length === 0
      ) {
        json(400, { error: { code: "validation_error" } });
        return;
      }
      try {
        const now = Date.now();
        let priorRun: string | null = null;
        const postTurn = (text: string): string => {
          if (priorRun !== null) {
            repo.failRun(priorRun, "execution_failed", { now });
          }
          const posted = repo.postMessage(
            sessionId,
            { text },
            { key: randomUUID(), now },
          );
          const runId = (posted.body as { run: { id: string } }).run.id;
          repo.startRun(runId, { now: now + 1 });
          priorRun = runId;
          return runId;
        };
        const keeperRun = postTurn(`note ${pendingQuote} end`);
        if (!`note ${pendingQuote} end`.includes(pendingQuote)) {
          json(400, { error: { code: "validation_error" } });
          return;
        }
        const keeper = repo.stageConversationProposalFromModel(
          keeperRun,
          {
            target: "purpose",
            scope: "health",
            draftKind: "wish",
            purposeKind: "goal",
            sourceQuote: pendingQuote,
            interpretation: "burst keeper draft",
          },
          { key: randomUUID() },
        );
        for (let i = 0; i < (decided as number); i += 1) {
          const text = `burst filler ${i} marker`;
          const runId = postTurn(text);
          const staged = repo.stageConversationProposalFromModel(
            runId,
            {
              target: "purpose",
              scope: "health",
              draftKind: "wish",
              purposeKind: "goal",
              sourceQuote: `filler ${i} marker`,
              interpretation: `burst decided ${i}`,
            },
            { key: randomUUID() },
          );
          repo.rejectConversationProposal(
            sessionId,
            (staged.body as { id: string }).id,
            { expectedVersion: 1 },
            { key: randomUUID(), now },
          );
        }
        json(201, {
          pendingId: (keeper.body as { id: string }).id,
          decided,
        });
      } catch {
        json(400, { error: { code: "validation_error" } });
      }
      return;
    }
    json(404, { error: { code: "not_found", message: "resource not found" } });
  },
);
control.listen(E2E_CONTROL_PORT, "127.0.0.1", () => {
  // eslint-disable-next-line no-console
  console.log(`e2e-control-ready http://127.0.0.1:${E2E_CONTROL_PORT}`);
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  resetControlState();
  resetProxyState();
  await new Promise<void>((resolve) => {
    proxy.close(() => resolve());
    proxy.closeAllConnections();
  });
  try {
    await engine.shutdown({ drainMs: 1000 });
  } catch {
    // Best effort: still close the DB/listener/temp dir.
  }
  try {
    closeKernelDatabase(handle);
  } catch {
    // Best effort.
  }
  await new Promise<void>((resolve) => {
    control.close(() => resolve());
  });
  await new Promise<void>((resolve) => {
    appServer.close(() => resolve());
  });
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
process.on("SIGINT", () => {
  void shutdown().then(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void shutdown().then(() => process.exit(0));
});
