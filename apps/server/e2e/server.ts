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
//   GET  /health    -> { status: "ok" }
//
// Temp DB dir is removed on shutdown (SIGINT/SIGTERM included).

import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import {
  createServer,
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
function releaseAll(): void {
  const pending = releaseHangers;
  releaseHangers = [];
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

const control = createServer(
  async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const rawBody = await readBody(req);
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
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
      failArmed = false;
      releaseAll();
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
