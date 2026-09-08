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
//   GET  /health    -> { status: "ok" }
//
// Temp DB dir is removed on shutdown (SIGINT/SIGTERM included).

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
  E2E_APP_PORT,
  E2E_CONTROL_PORT,
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

function readBody(req: IncomingMessage): Promise<void> {
  return new Promise((resolve) => {
    req.on("data", () => undefined);
    req.on("end", () => resolve());
    req.on("error", () => resolve());
  });
}

const control = createServer(
  async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    await readBody(req);
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
