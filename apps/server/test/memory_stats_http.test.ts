// GET /api/memory/stats: strict query gate, memory-disabled 404, fixed 503
// mapping, numbers-only response, and no service call on a bad query. Real
// Hono app + migrated in-memory kernel DB; injected MemoryHttpPort (no CLI).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeKernelDatabase,
  createKernelRepository,
  type KernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
  RunEngine,
} from "@companion/kernel";
import { describe, expect, it } from "vitest";
import type { MemoryHttpPort } from "../src/app.js";
import { type CreatedServerApp, createApp } from "../src/app.js";
import { loadServerConfig } from "../src/config.js";
import { createCollectingLogger } from "../src/logger.js";
import { MemoryManageError } from "../src/memory_service.js";

const T0 = 1790000000000;

function fakeMemory(
  getMemoryStats: MemoryHttpPort["getMemoryStats"],
): MemoryHttpPort {
  return {
    searchMemories: async () => {
      throw new Error("search not used by stats route");
    },
    getMemoryStats,
    getMemoryDetail: async () => {
      throw new Error("detail not used by stats route");
    },
    getMemoryGraphGlobal: async () => {
      throw new Error("graph not used by stats route");
    },
    getMemoryGraphLocal: async () => {
      throw new Error("graph not used by stats route");
    },
    stageMemoryMutation: async () => {
      throw new Error("mutation not used by stats route");
    },
    getMemoryOperation: () => null,
    getMemoryRecallExposure: () => null,
    hashDrainingReplay: () => null,
  };
}

async function makeApp(
  memory?: MemoryHttpPort,
): Promise<CreatedServerApp & { repo: KernelRepository; close: () => void }> {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  const repo = createKernelRepository(handle.raw);
  const config = loadServerConfig({
    COMPANION_DB_PATH: join(
      mkdtempSync(join(tmpdir(), "companion-stats-http-")),
      "db.sqlite",
    ),
    COMPANION_HOST: "127.0.0.1",
    COMPANION_PORT: "3000",
    COMPANION_TIME_ZONE: "UTC",
    COMPANION_LOG_LEVEL: "debug",
  });
  const { logger } = createCollectingLogger("debug");
  const engine = new RunEngine({ db: handle.raw, repo, cancelGraceMs: 30 });
  const created = createApp({
    config,
    repo,
    engine,
    logger,
    ...(memory !== undefined ? { memory } : {}),
  });
  return { ...created, repo, close: () => closeKernelDatabase(handle) };
}

async function get(
  app: CreatedServerApp["app"],
  path: string,
): Promise<{ status: number; body: unknown }> {
  const response = await app.request(path, {
    method: "GET",
    headers: { host: "127.0.0.1" },
  });
  return { status: response.status, body: await response.json() };
}

describe("GET /api/memory/stats", () => {
  it("returns numbers only", async () => {
    const fixture = await makeApp(
      fakeMemory(async () => ({
        byKind: {
          user_fact: 3,
          model_inference: 2,
          summary: 1,
          correction: 0,
        },
        byStatus: { active: 6, retired: 2, superseded: 1, archived: 0 },
        computedAt: T0,
        truncated: false,
      })),
    );
    try {
      const out = await get(fixture.app, "/api/memory/stats");
      expect(out.status).toBe(200);
      expect(out.body).toEqual({
        byKind: {
          user_fact: 3,
          model_inference: 2,
          summary: 1,
          correction: 0,
        },
        byStatus: { active: 6, retired: 2, superseded: 1, archived: 0 },
        computedAt: T0,
        truncated: false,
      });
      expect(JSON.stringify(out.body)).not.toContain("body");
      expect(JSON.stringify(out.body)).not.toContain("snippet");
    } finally {
      fixture.close();
    }
  });

  it("rejects any query parameter before calling the service", async () => {
    let calls = 0;
    const fixture = await makeApp(
      fakeMemory(async () => {
        calls += 1;
        throw new Error("must not be called");
      }),
    );
    try {
      for (const query of [
        "?limit=1",
        "?unknown=1",
        "?limit=1&limit=2",
        "?scope=other",
      ]) {
        const out = await get(fixture.app, `/api/memory/stats${query}`);
        expect(out.status, query).toBe(400);
      }
      expect(calls).toBe(0);
    } finally {
      fixture.close();
    }
  });

  it("returns 404 when memory is disabled", async () => {
    const fixture = await makeApp();
    try {
      const out = await get(fixture.app, "/api/memory/stats");
      expect(out.status).toBe(404);
      expect((out.body as { error: { code: string } }).error.code).toBe(
        "memory_unavailable",
      );
    } finally {
      fixture.close();
    }
  });

  it("maps a CLI/service failure to a fixed 503", async () => {
    const fixture = await makeApp(
      fakeMemory(async () => {
        throw new MemoryManageError("service_unavailable");
      }),
    );
    try {
      const out = await get(fixture.app, "/api/memory/stats");
      expect(out.status).toBe(503);
      expect(out.body).toEqual({
        error: { code: "memory_unavailable", message: "memory unavailable" },
      });
    } finally {
      fixture.close();
    }
  });
});
