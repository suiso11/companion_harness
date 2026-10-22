// Conversation-memory graph HTTP routes: strict query gates, owned-run
// binding, memory-disabled 404, fixed unavailable 503, opaque handles only,
// and read-only behavior (never feedback/heat). Real Hono app + real
// migrated in-memory kernel DB; injected MemoryHttpPort (no CLI child).

import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryGraphResponse } from "@companion/contracts";
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

function graphResult(scope: "global" | "local"): MemoryGraphResponse {
  return {
    searchId: "graph-search-1",
    // Real remind graph.version is an opaque STRING, passed through as-is.
    version: "o12:r3.2:a40:e0.0.",
    scope,
    center: scope === "local" ? "m1" : null,
    nodes: [
      {
        handle: "m1",
        label: "alpha",
        status: "active",
        kind: "user_fact",
        episode: {
          kind: "day",
          episodeKey: "2026-10-21",
          level: "window",
        },
      },
      {
        handle: "m2",
        label: "beta",
        status: "retired",
        kind: "summary",
        episode: null,
      },
    ],
    edges: [{ from: "m1", to: "m2", kind: "related" }],
    truncated: false,
  };
}

interface PortCalls {
  global: Array<{ sessionId: string; includeRetired?: boolean; runId: string }>;
  local: Array<{
    sessionId: string;
    searchId: string;
    handle: string;
    depth?: number;
    runId: string;
  }>;
}

function fakeMemory(
  calls: PortCalls,
  overrides: Partial<MemoryHttpPort> = {},
): MemoryHttpPort {
  const base: MemoryHttpPort = {
    searchMemories: async () => {
      throw new Error("search not used by graph routes");
    },
    getMemoryDetail: async () => {
      throw new Error("detail not used by graph routes");
    },
    getMemoryGraphGlobal: async (sessionId, input) => {
      calls.global.push({
        sessionId,
        ...(input.includeRetired !== undefined
          ? { includeRetired: input.includeRetired }
          : {}),
        runId: input.runId,
      });
      return graphResult("global");
    },
    getMemoryGraphLocal: async (sessionId, input) => {
      calls.local.push({
        sessionId,
        searchId: input.searchId,
        handle: input.handle,
        ...(input.depth !== undefined ? { depth: input.depth } : {}),
        runId: input.runId,
      });
      return graphResult("local");
    },
    stageMemoryMutation: async () => {
      throw new Error("mutation not used by graph routes");
    },
    getMemoryOperation: () => null,
    getMemoryRecallExposure: () => null,
    hashDrainingReplay: () => null,
  };
  return { ...base, ...overrides };
}

async function makeApp(memory?: MemoryHttpPort): Promise<
  CreatedServerApp & {
    repo: KernelRepository;
    close: () => void;
  }
> {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  const repo = createKernelRepository(handle.raw);
  const config = loadServerConfig({
    COMPANION_DB_PATH: join(
      mkdtempSync(join(tmpdir(), "companion-graph-http-")),
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

function makeSessionRun(repo: KernelRepository): {
  sessionId: string;
  runId: string;
} {
  const sessionId = repo.createSession({ key: randomUUID(), now: T0 }).body
    .sessionId;
  const posted = repo.postMessage(
    sessionId,
    { text: "hello" },
    { key: randomUUID(), now: T0 + 1 },
  );
  return { sessionId, runId: posted.body.run.id };
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

function basePath(sessionId: string): string {
  return `/api/sessions/${sessionId}/memory/graph`;
}

describe("memory graph HTTP routes", () => {
  it("returns the global graph with opaque handles and a string version", async () => {
    const calls: PortCalls = { global: [], local: [] };
    const fixture = await makeApp(fakeMemory(calls));
    try {
      const { sessionId, runId } = makeSessionRun(fixture.repo);
      const out = await get(
        fixture.app,
        `${basePath(sessionId)}?includeRetired=true&runId=${runId}`,
      );
      expect(out.status).toBe(200);
      expect(calls.global).toEqual([
        { sessionId, includeRetired: true, runId },
      ]);
      const body = out.body as MemoryGraphResponse;
      expect(body.scope).toBe("global");
      expect(body.center).toBeNull();
      expect(body.version).toBe("o12:r3.2:a40:e0.0.");
      expect(body.nodes.map((node) => node.handle)).toEqual(["m1", "m2"]);
      expect(body.nodes[0]?.episode).toEqual({
        kind: "day",
        episodeKey: "2026-10-21",
        level: "window",
      });
      expect(body.edges).toEqual([{ from: "m1", to: "m2", kind: "related" }]);
      // Raw canonical record ids must never cross the boundary.
      expect(JSON.stringify(body)).not.toContain("rec-");
    } finally {
      fixture.close();
    }
  });

  it("defaults includeRetired to false and returns the local graph", async () => {
    const calls: PortCalls = { global: [], local: [] };
    const fixture = await makeApp(fakeMemory(calls));
    try {
      const { sessionId, runId } = makeSessionRun(fixture.repo);
      const global = await get(
        fixture.app,
        `${basePath(sessionId)}?runId=${runId}`,
      );
      expect(global.status).toBe(200);
      expect(calls.global[0]?.includeRetired).toBe(false);

      const local = await get(
        fixture.app,
        `${basePath(sessionId)}/local?searchId=search-1&handle=m1&depth=2&runId=${runId}`,
      );
      expect(local.status).toBe(200);
      expect(calls.local).toEqual([
        {
          sessionId,
          searchId: "search-1",
          handle: "m1",
          depth: 2,
          runId,
        },
      ]);
      const body = local.body as MemoryGraphResponse;
      expect(body.scope).toBe("local");
      expect(body.center).toBe("m1");
      expect(body.nodes.map((node) => node.handle)).toEqual(["m1", "m2"]);
      expect(JSON.stringify(body)).not.toContain("rec-");
    } finally {
      fixture.close();
    }
  });

  it("rejects malformed or extra query parameters with 400", async () => {
    const calls: PortCalls = { global: [], local: [] };
    const fixture = await makeApp(fakeMemory(calls));
    try {
      const { sessionId, runId } = makeSessionRun(fixture.repo);
      const paths = [
        `${basePath(sessionId)}?runId=${runId}&includeRetired=maybe`,
        `${basePath(sessionId)}?runId=${runId}&includeRetired=true&extra=1`,
        `${basePath(sessionId)}?runId=${runId}&runId=${runId}`,
        `${basePath(sessionId)}?includeRetired=true`,
        `${basePath(sessionId)}?runId=not-a-uuid`,
        `${basePath(sessionId)}/local?searchId=search-1&handle=m1&depth=3&runId=${runId}`,
        `${basePath(sessionId)}/local?searchId=search-1&handle=rec-1&runId=${runId}`,
        `${basePath(sessionId)}/local?searchId=&handle=m1&runId=${runId}`,
        `${basePath(sessionId)}/local?handle=m1&runId=${runId}`,
        `${basePath(sessionId)}/local?searchId=search-1&handle=m1&runId=${runId}&unknown=1`,
      ];
      for (const path of paths) {
        const out = await get(fixture.app, path);
        expect(out.status, path).toBe(400);
      }
      // Nothing reached the service for invalid queries.
      expect(calls.global).toHaveLength(0);
      expect(calls.local).toHaveLength(0);
    } finally {
      fixture.close();
    }
  });

  it("maps an unknown handle to 404 target_not_found", async () => {
    const calls: PortCalls = { global: [], local: [] };
    const fixture = await makeApp(
      fakeMemory(calls, {
        getMemoryGraphLocal: async () => {
          throw new MemoryManageError("target_not_found");
        },
      }),
    );
    try {
      const { sessionId, runId } = makeSessionRun(fixture.repo);
      const out = await get(
        fixture.app,
        `${basePath(sessionId)}/local?searchId=search-1&handle=m9&runId=${runId}`,
      );
      expect(out.status).toBe(404);
      expect((out.body as { error: { code: string } }).error.code).toBe(
        "target_not_found",
      );
    } finally {
      fixture.close();
    }
  });

  it("rejects a run that belongs to another session", async () => {
    const calls: PortCalls = { global: [], local: [] };
    const fixture = await makeApp(fakeMemory(calls));
    try {
      const owner = makeSessionRun(fixture.repo);
      const other = makeSessionRun(fixture.repo);
      for (const path of [
        `${basePath(owner.sessionId)}?runId=${other.runId}`,
        `${basePath(owner.sessionId)}/local?searchId=search-1&handle=m1&runId=${other.runId}`,
      ]) {
        const out = await get(fixture.app, path);
        expect(out.status, path).toBe(404);
        expect((out.body as { error: { code: string } }).error.code).toBe(
          "target_not_found",
        );
      }
      expect(calls.global).toHaveLength(0);
      expect(calls.local).toHaveLength(0);
    } finally {
      fixture.close();
    }
  });

  it("returns 404 memory_unavailable when memory is disabled", async () => {
    const fixture = await makeApp();
    try {
      const { sessionId, runId } = makeSessionRun(fixture.repo);
      for (const path of [
        `${basePath(sessionId)}?runId=${runId}`,
        `${basePath(sessionId)}/local?searchId=search-1&handle=m1&runId=${runId}`,
      ]) {
        const out = await get(fixture.app, path);
        expect(out.status, path).toBe(404);
        expect((out.body as { error: { code: string } }).error.code).toBe(
          "memory_unavailable",
        );
      }
    } finally {
      fixture.close();
    }
  });

  it("returns 503 memory_graph_unavailable for an old remind build", async () => {
    const calls: PortCalls = { global: [], local: [] };
    const fixture = await makeApp(
      fakeMemory(calls, {
        getMemoryGraphGlobal: async () => {
          throw new MemoryManageError("memory_graph_unavailable");
        },
        getMemoryGraphLocal: async () => {
          throw new MemoryManageError("memory_graph_unavailable");
        },
      }),
    );
    try {
      const { sessionId, runId } = makeSessionRun(fixture.repo);
      for (const path of [
        `${basePath(sessionId)}?runId=${runId}`,
        `${basePath(sessionId)}/local?searchId=search-1&handle=m1&runId=${runId}`,
      ]) {
        const out = await get(fixture.app, path);
        expect(out.status, path).toBe(503);
        expect((out.body as { error: { code: string } }).error.code).toBe(
          "memory_graph_unavailable",
        );
      }
    } finally {
      fixture.close();
    }
  });
});
