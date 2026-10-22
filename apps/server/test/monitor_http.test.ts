// GET /api/monitor behavioral test (real Hono app + real kernel DB).
//
// Seeds REAL model_calls rows through the kernel repository (latest-20 +
// 24h totals), one running run and one queued run, and injects a degraded
// hardware sampler (all host values null). Proves the exact response
// contract, output tokens/s math, the web-search down state without leaking
// the upstream URL/healthz path/raw errors, strict query rejection, and the
// `/monitor` Svelte shell route.

import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KernelRepository } from "@companion/kernel";
import {
  closeKernelDatabase,
  createKernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
} from "@companion/kernel";
import { describe, expect, it } from "vitest";
import {
  type CreatedServerApp,
  createApp,
  type EnginePort,
} from "../src/app.js";
import { loadServerConfig } from "../src/config.js";
import { createCollectingLogger } from "../src/logger.js";
import type { MonitorSampler } from "../src/monitor.js";

const T = 1_800_000_000_000;

const degradedSampler: MonitorSampler = {
  read: async () => ({
    hardware: {
      gpus: [],
      cpuPct: null,
      ramUsedMiB: null,
      ramTotalMiB: null,
    },
    history: {
      t: [T - 2000],
      cpuPct: [null],
      ramUsedMiB: [null],
      gpus: [],
    },
  }),
  stop: async () => undefined,
};

const engine: EnginePort = {
  cancel: () => ({ status: "cancelled" }),
  shutdown: async () => ({ abandoned: 0, cancelled: 0 }),
};

async function makeApp(): Promise<
  CreatedServerApp & { close: () => void; repo: KernelRepository }
> {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  const repo = createKernelRepository(handle.raw);
  const config = loadServerConfig({
    COMPANION_DB_PATH: join(
      mkdtempSync(join(tmpdir(), "companion-monitor-")),
      "db.sqlite",
    ),
    COMPANION_HOST: "127.0.0.1",
    COMPANION_PORT: "3000",
    COMPANION_TIME_ZONE: "UTC",
    COMPANION_LOG_LEVEL: "debug",
    COMPANION_MODEL_JSON: JSON.stringify({
      adapter: "openai-compatible",
      baseUrl: "http://127.0.0.1:9",
      model: "test-model",
    }),
    COMPANION_WEB_SEARCH_JSON: JSON.stringify({
      enabled: true,
      searxng_base_url: "http://127.0.0.1:9",
    }),
  });
  const { logger } = createCollectingLogger("debug");
  const created = createApp({
    config,
    repo,
    engine,
    logger,
    now: () => T,
    monitor: degradedSampler,
  });
  return { ...created, close: () => closeKernelDatabase(handle), repo };
}

async function get(
  app: CreatedServerApp["app"],
  path: string,
): Promise<Response> {
  return app.request(path, { headers: { host: "127.0.0.1" } });
}

interface Seeded {
  completedRunId: string;
  failedRunId: string;
}

function seed(repo: KernelRepository): Seeded {
  const first = repo.createSession({ key: randomUUID(), now: T - 20_000 });
  const sessionId = first.body.sessionId;
  const one = repo.postMessage(
    sessionId,
    { text: "first" },
    { key: randomUUID(), now: T - 5000 },
  ).body;
  repo.startRun(one.run.id, { now: T - 4000 });
  repo.recordModelCall(one.run.id, {
    step: 1,
    adapter: "openai-compatible",
    model: "local-test",
    outcome: "completed",
    durationMs: 1000,
    usage: { inputTokens: 100, outputTokens: 50 },
    now: T - 3000,
  });
  repo.completeRun(one.run.id, { version: 1, text: "done" }, { now: T - 2500 });

  const two = repo.postMessage(
    sessionId,
    { text: "second" },
    { key: randomUUID(), now: T - 1500 },
  ).body;
  repo.startRun(two.run.id, { now: T - 1400 });
  repo.recordModelCall(two.run.id, {
    step: 1,
    adapter: "openai-compatible",
    model: "local-test",
    outcome: "failed",
    errorCode: "model_unavailable",
    durationMs: 2000,
    now: T - 100,
  });

  const queued = repo.createSession({ key: randomUUID(), now: T - 1000 });
  repo.postMessage(
    queued.body.sessionId,
    { text: "queued" },
    { key: randomUUID(), now: T - 500 },
  );

  return { completedRunId: one.run.id, failedRunId: two.run.id };
}

describe("GET /api/monitor", () => {
  it("returns the exact contract for seeded calls and degraded hardware", async () => {
    const f = await makeApp();
    try {
      const seeded = seed(f.repo);
      const response = await get(f.app, "/api/monitor");
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const raw = await response.text();
      // No upstream URL, health path, or raw fetch/socket error may leak.
      expect(raw).not.toContain("127.0.0.1");
      expect(raw).not.toContain("/healthz");
      expect(raw).not.toContain("ECONNREFUSED");
      expect(raw).not.toContain("fetch failed");
      const body = JSON.parse(raw) as Record<string, unknown>;

      expect(body).toEqual({
        version: 1,
        time: T,
        live: { state: "generating", runningRuns: 1, queuedRuns: 1 },
        services: {
          model: {
            configured: true,
            model: "test-model",
            lastOutcome: "failed",
            lastAt: T - 100,
          },
          webSearch: { status: "down" },
        },
        requests: [
          {
            at: T - 100,
            runId: seeded.failedRunId,
            step: 1,
            model: "local-test",
            outcome: "failed",
            errorCode: "model_unavailable",
            durationMs: 2000,
            inputTokens: null,
            outputTokens: null,
            outputTokS: null,
          },
          {
            at: T - 3000,
            runId: seeded.completedRunId,
            step: 1,
            model: "local-test",
            outcome: "completed",
            errorCode: null,
            durationMs: 1000,
            inputTokens: 100,
            outputTokens: 50,
            outputTokS: 50,
          },
        ],
        totals: {
          since: T - 24 * 60 * 60 * 1000,
          calls: 2,
          inputTokens: 100,
          outputTokens: 50,
          failures: 1,
        },
        hardware: {
          gpus: [],
          cpuPct: null,
          ramUsedMiB: null,
          ramTotalMiB: null,
        },
        history: {
          t: [T - 2000],
          cpuPct: [null],
          ramUsedMiB: [null],
          gpus: [],
        },
      });
    } finally {
      f.close();
    }
  });

  it("rejects unknown query params and serves the /monitor shell", async () => {
    const f = await makeApp();
    try {
      const invalid = await get(f.app, "/api/monitor?scope=x");
      expect(invalid.status).toBe(400);

      const shell = await get(f.app, "/monitor");
      expect(shell.status).toBe(200);
      expect(shell.headers.get("cache-control")).toBe("no-store");
      expect(await shell.text()).toContain("svelte-app");
    } finally {
      f.close();
    }
  });
});
