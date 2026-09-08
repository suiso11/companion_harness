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
//   POST /reset     -> clear armed failure + release hangers
//   POST /seed-citation { sessionId } -> store one immutable snapshot +
//     session reference (ordinal rN) for that session via direct SQL
//     (fixture setup only; drawer/CAS/rendering stay on real routes/UI)
//   POST /seed-history { sessionId, count, prefix } -> store `count`
//     completed user_text turns (+ selected V1 runs with queued/started/
//     completed events) for that session via direct SQL (fixture setup
//     only; pagination/rendering stay on the real history routes/UI)
//   GET  /health    -> { status: "ok" }
//
// A third loopback-only SSE fault proxy (E2E_PROXY_PORT) forwards every
// request 1:1 to the real app (no mocking); it only observes SSE streams
// and can destroy them / drop one armed SSE frame so the page's NATIVE
// EventSource exercises real reconnect + Last-Event-ID resume:
//   POST /proxy/reset            -> clear counters + frame-drop arm
//   POST /proxy/arm-drop { seq } -> drop the next SSE frame with `id: seq`
//   POST /proxy/drop-sse         -> destroy all live proxied SSE sockets
//   GET  /proxy/status           -> counters (connections/reconnects/ids)
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
        reject(new StrategyError("execution_cancelled"));
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
  cancelGraceMs: 50,
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
function seedCitation(sessionId: string): {
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
  let resource = db
    .prepare(
      "SELECT id FROM resources WHERE connector_instance_id = ? AND canonical_key = ?",
    )
    .get(connectorId, "e2e-citation-doc") as { id: string } | undefined;
  if (resource === undefined) {
    const id = randomUUID();
    db.prepare(
      "INSERT INTO resources (id, connector_instance_id, canonical_key, title, next_revision, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(id, connectorId, "e2e-citation-doc", "E2E citation doc", 2, now);
    resource = { id };
  }
  const normalized = CITATION_SNAPSHOT_TEXT.normalize("NFC");
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
    JSON.stringify({ version: 1, text: CITATION_SNAPSHOT_TEXT }),
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
};

/** Armed frame seq to drop once (fault injection over real SSE bytes). */
let dropFrameSeq: number | null = null;
const activeSseDownstreams = new Set<ServerResponse>();

function resetControlState(): void {
  failArmed = false;
  releaseHangers = [];
  pendingReleases = 0;
}
function resetProxyState(): void {
  for (const key of Object.keys(proxyState) as Array<keyof ProxyState>) {
    if (key === "lastLastEventId" || key === "lastStreamRunId") {
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
  if (RUN_EVENTS_PAGE_RE.test(path)) {
    proxyState.eventsPageRequests += 1;
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
        const cleanup = (): void => {
          proxyState.sseActive = Math.max(0, proxyState.sseActive - 1);
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
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
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
    activeSseDownstreams.delete(res);
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
      try {
        sessionId = (
          JSON.parse(rawBody === "" ? "{}" : rawBody) as {
            sessionId?: unknown;
          }
        ).sessionId;
      } catch {
        json(400, { error: { code: "validation_error" } });
        return;
      }
      if (typeof sessionId !== "string" || !UUID_V4_RE.test(sessionId)) {
        json(400, { error: { code: "validation_error" } });
        return;
      }
      try {
        json(200, seedCitation(sessionId));
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
