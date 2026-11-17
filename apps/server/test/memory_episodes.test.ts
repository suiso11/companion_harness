// Episodic reference layer: service re-shaping (raw record/event ids never
// leave the service), bounded limits, fixed failures, and the two read-only
// HTTP routes (strict query gates, defaults, 404/503).
//
// Real migrated `:memory:` kernel DB + injected fake remind CLI / fake
// MemoryHttpPort. No child process, no remind DB, no network.

import { randomUUID } from "node:crypto";
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
import { afterEach, describe, expect, it } from "vitest";
import type { MemoryHttpPort } from "../src/app.js";
import { type CreatedServerApp, createApp } from "../src/app.js";
import { loadServerConfig } from "../src/config.js";
import { createCollectingLogger } from "../src/logger.js";
import type {
  MemoryCliAddress,
  MemoryCliCallOptions,
  MemoryCliEnvelope,
} from "../src/memory_cli.js";
import {
  createMemoryService,
  MemoryManageError,
  type MemoryService,
} from "../src/memory_service.js";

const T0 = 1790000000000;
const SCOPE = "test-scope";

type CliCall = (
  address: MemoryCliAddress,
  op: string,
  params: Record<string, unknown>,
  idempotencyKey: string | undefined,
  options?: MemoryCliCallOptions,
) => Promise<MemoryCliEnvelope>;

const START = "2026-10-21T00:00:00.000Z";
const END = "2026-10-21T01:00:00.000Z";

function okEnvelope(data: Record<string, unknown> | null): MemoryCliEnvelope {
  return { ok: true, code: "OK", data, deduplicated: false };
}

/** Raw remind `episode.list` data (ids/counters are server-only). */
function rawEpisodeList(): Record<string, unknown> {
  return {
    items: [
      {
        kind: "session",
        episodeKey: "session-a",
        startAt: START,
        endAt: END,
        eventCount: 3,
        totalCp: 1200,
        summaryRecordIds: ["rec-1"],
        summarySnippet: "episode summary",
        summaryTruncated: false,
        stale: true,
      },
    ],
    nextCursor: "cursor-1",
  };
}

/** Raw remind `episode.windows` data (record/event ids server-only). */
function rawEpisodeWindows(): Record<string, unknown> {
  return {
    items: [
      {
        recordId: "rec-1",
        eventId: "evt-1",
        span: { start: 0, end: 120 },
        snippet: "window summary",
        truncated: true,
      },
    ],
    nextCursor: null,
  };
}

async function openRepo(): Promise<{
  repo: KernelRepository;
  close: () => void;
}> {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  return {
    repo: createKernelRepository(handle.raw),
    close: () => closeKernelDatabase(handle),
  };
}

let services: MemoryService[] = [];
afterEach(async () => {
  for (const service of services) {
    await service.stop().catch(() => undefined);
  }
  services = [];
});

function makeService(repo: KernelRepository, cliCall: CliCall): MemoryService {
  const service = createMemoryService({
    address: {
      executable: "/bin/true",
      entry: "/cli.js",
      config: "/mem.json",
      timeoutMs: 5000,
      maxResponseBytes: 65536,
    },
    scope: SCOPE,
    recallLimit: 5,
    idleMs: 300_000,
    repo,
    gateway: null,
    model: "test-model",
    cliCall,
  });
  services.push(service);
  return service;
}

/** Records every episode CLI call and answers with the given envelope. */
function episodeCli(
  calls: Array<{ op: string; params: Record<string, unknown> }>,
  envelope: MemoryCliEnvelope | (() => Promise<MemoryCliEnvelope>),
): CliCall {
  return async (_address, op, params) => {
    calls.push({ op, params });
    return typeof envelope === "function" ? envelope() : envelope;
  };
}

describe("memory episodes service", () => {
  it("maps episode.list to snippets only and applies the 20 default", async () => {
    const f = await openRepo();
    try {
      const calls: Array<{ op: string; params: Record<string, unknown> }> = [];
      const service = makeService(
        f.repo,
        episodeCli(calls, okEnvelope(rawEpisodeList())),
      );

      const out = await service.getMemoryEpisodes({});
      expect(calls).toEqual([
        {
          op: "episode.list",
          params: { scope: SCOPE, kind: "session", limit: 20 },
        },
      ]);
      expect(out).toEqual({
        items: [
          {
            episodeKey: "session-a",
            startAt: START,
            endAt: END,
            eventCount: 3,
            summarySnippet: "episode summary",
            summaryTruncated: false,
            stale: true,
          },
        ],
        nextCursor: "cursor-1",
      });
      const serialized = JSON.stringify(out);
      for (const leaked of [
        "rec-1",
        "evt-1",
        "totalCp",
        "summaryRecordIds",
        "kind",
      ]) {
        expect(serialized).not.toContain(leaked);
      }
    } finally {
      f.close();
    }
  });

  it("passes limit/cursor and clamps to 1..50", async () => {
    const f = await openRepo();
    try {
      const calls: Array<{ op: string; params: Record<string, unknown> }> = [];
      const service = makeService(
        f.repo,
        episodeCli(calls, okEnvelope({ items: [], nextCursor: null })),
      );

      await service.getMemoryEpisodes({ limit: 7, cursor: "c-1" });
      await service.getMemoryEpisodes({ limit: 0 });
      await service.getMemoryEpisodes({ limit: 999 });

      expect(calls).toEqual([
        {
          op: "episode.list",
          params: {
            scope: SCOPE,
            kind: "session",
            limit: 7,
            cursor: "c-1",
          },
        },
        {
          op: "episode.list",
          params: { scope: SCOPE, kind: "session", limit: 1 },
        },
        {
          op: "episode.list",
          params: { scope: SCOPE, kind: "session", limit: 50 },
        },
      ]);
    } finally {
      f.close();
    }
  });

  it("maps episode.windows to span+snippet only and applies the 50 default", async () => {
    const f = await openRepo();
    try {
      const calls: Array<{ op: string; params: Record<string, unknown> }> = [];
      const service = makeService(
        f.repo,
        episodeCli(calls, okEnvelope(rawEpisodeWindows())),
      );

      const out = await service.getMemoryEpisodeWindows({
        episodeKey: "session-a",
      });
      expect(calls).toEqual([
        {
          op: "episode.windows",
          params: {
            scope: SCOPE,
            kind: "session",
            episodeKey: "session-a",
            limit: 50,
          },
        },
      ]);
      expect(out).toEqual({
        items: [
          {
            spanStart: 0,
            spanEnd: 120,
            snippet: "window summary",
            truncated: true,
          },
        ],
        nextCursor: null,
      });
      const serialized = JSON.stringify(out);
      expect(serialized).not.toContain("rec-1");
      expect(serialized).not.toContain("evt-1");
    } finally {
      f.close();
    }
  });

  it("fails closed with service_unavailable on an invalid shape", async () => {
    const f = await openRepo();
    try {
      const bad = rawEpisodeList();
      bad.items = [{ ...(rawEpisodeList().items as object[])[0], endAt: 7 }];
      const service = makeService(f.repo, episodeCli([], okEnvelope(bad)));

      await expect(service.getMemoryEpisodes({})).rejects.toMatchObject({
        name: "MemoryManageError",
        code: "service_unavailable",
      });

      const badWindows = rawEpisodeWindows();
      badWindows.items = [
        { span: { start: 0 }, snippet: "x", truncated: false },
      ];
      const windowsService = makeService(
        f.repo,
        episodeCli([], okEnvelope(badWindows)),
      );
      await expect(
        windowsService.getMemoryEpisodeWindows({ episodeKey: "session-a" }),
      ).rejects.toMatchObject({ code: "service_unavailable" });
    } finally {
      f.close();
    }
  });

  it("fails closed with service_unavailable on CLI failure or non-OK", async () => {
    const f = await openRepo();
    try {
      const throwing = makeService(f.repo, async () => {
        throw new Error("child died");
      });
      await expect(throwing.getMemoryEpisodes({})).rejects.toBeInstanceOf(
        MemoryManageError,
      );

      // An old remind that does not know the op answers BAD_REQUEST.
      const old = makeService(
        f.repo,
        episodeCli([], {
          ok: false,
          code: "BAD_REQUEST",
          data: null,
          deduplicated: false,
        }),
      );
      await expect(old.getMemoryEpisodes({})).rejects.toMatchObject({
        code: "service_unavailable",
      });
      await expect(
        old.getMemoryEpisodeWindows({ episodeKey: "session-a" }),
      ).rejects.toMatchObject({ code: "service_unavailable" });
    } finally {
      f.close();
    }
  });
});

/* ------------------------------ HTTP ------------------------------ */

interface PortCalls {
  episodes: Array<{ limit?: number; cursor?: string }>;
  windows: Array<{ episodeKey: string; limit?: number; cursor?: string }>;
}

function fakeMemory(
  calls: PortCalls,
  overrides: Partial<MemoryHttpPort> = {},
): MemoryHttpPort {
  const base: MemoryHttpPort = {
    searchMemories: async () => {
      throw new Error("search not used by episode routes");
    },
    getMemoryStats: async () => {
      throw new Error("stats not used by episode routes");
    },
    getMemoryDetail: async () => {
      throw new Error("detail not used by episode routes");
    },
    getMemoryGraphGlobal: async () => {
      throw new Error("graph not used by episode routes");
    },
    getMemoryGraphLocal: async () => {
      throw new Error("graph not used by episode routes");
    },
    getMemoryEpisodes: async (input) => {
      calls.episodes.push({
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
      });
      return {
        items: [
          {
            episodeKey: "session-a",
            startAt: START,
            endAt: END,
            eventCount: 3,
            summarySnippet: "episode summary",
            summaryTruncated: false,
            stale: true,
          },
        ],
        nextCursor: "cursor-1",
      };
    },
    getMemoryEpisodeWindows: async (input) => {
      calls.windows.push({
        episodeKey: input.episodeKey,
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
      });
      return {
        items: [
          {
            spanStart: 0,
            spanEnd: 120,
            snippet: "window summary",
            truncated: true,
          },
        ],
        nextCursor: null,
      };
    },
    stageMemoryMutation: async () => {
      throw new Error("mutation not used by episode routes");
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
      mkdtempSync(join(tmpdir(), "companion-episodes-http-")),
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

function makeSession(repo: KernelRepository): string {
  return repo.createSession({ key: randomUUID(), now: T0 }).body.sessionId;
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

function episodesPath(sessionId: string): string {
  return `/api/sessions/${sessionId}/memory/episodes`;
}

function windowsPath(sessionId: string): string {
  return `/api/sessions/${sessionId}/memory/episodes/windows`;
}

describe("memory episodes HTTP routes", () => {
  it("returns the episode list with opaque keys and a default limit of 20", async () => {
    const calls: PortCalls = { episodes: [], windows: [] };
    const fixture = await makeApp(fakeMemory(calls));
    try {
      const sessionId = makeSession(fixture.repo);
      const out = await get(fixture.app, episodesPath(sessionId));
      expect(out.status).toBe(200);
      expect(calls.episodes).toEqual([{ limit: 20 }]);
      expect(out.body).toEqual({
        items: [
          {
            episodeKey: "session-a",
            startAt: START,
            endAt: END,
            eventCount: 3,
            summarySnippet: "episode summary",
            summaryTruncated: false,
            stale: true,
          },
        ],
        nextCursor: "cursor-1",
      });
      const serialized = JSON.stringify(out.body);
      expect(serialized).not.toContain("rec-");
      expect(serialized).not.toContain("evt-");
    } finally {
      fixture.close();
    }
  });

  it("passes explicit limit/cursor and serves windows with a default of 50", async () => {
    const calls: PortCalls = { episodes: [], windows: [] };
    const fixture = await makeApp(fakeMemory(calls));
    try {
      const sessionId = makeSession(fixture.repo);
      const list = await get(
        fixture.app,
        `${episodesPath(sessionId)}?limit=3&cursor=c-9`,
      );
      expect(list.status).toBe(200);
      expect(calls.episodes).toEqual([{ limit: 3, cursor: "c-9" }]);

      const windows = await get(
        fixture.app,
        `${windowsPath(sessionId)}?episodeKey=session-a`,
      );
      expect(windows.status).toBe(200);
      expect(calls.windows).toEqual([{ episodeKey: "session-a", limit: 50 }]);
      expect(windows.body).toEqual({
        items: [
          {
            spanStart: 0,
            spanEnd: 120,
            snippet: "window summary",
            truncated: true,
          },
        ],
        nextCursor: null,
      });
      expect(JSON.stringify(windows.body)).not.toContain("evt-");
    } finally {
      fixture.close();
    }
  });

  it("rejects out-of-range or malformed limits with 400 before any port call", async () => {
    const calls: PortCalls = { episodes: [], windows: [] };
    const fixture = await makeApp(fakeMemory(calls));
    try {
      const sessionId = makeSession(fixture.repo);
      for (const suffix of [
        "?limit=0",
        "?limit=51",
        "?limit=abc",
        "?cursor=abc!",
      ]) {
        const list = await get(
          fixture.app,
          `${episodesPath(sessionId)}${suffix}`,
        );
        expect(list.status).toBe(400);
        expect(list.body).toMatchObject({
          error: { code: "validation_error" },
        });
        const windows = await get(
          fixture.app,
          `${windowsPath(sessionId)}${suffix}${
            suffix.includes("?") ? "&" : "?"
          }episodeKey=session-a`,
        );
        expect(windows.status).toBe(400);
      }
      // Control characters cannot be a remind episode key.
      expect(
        (await get(fixture.app, `${windowsPath(sessionId)}?episodeKey=%00`))
          .status,
      ).toBe(400);
      expect(calls).toEqual({ episodes: [], windows: [] });
    } finally {
      fixture.close();
    }
  });

  it("rejects unknown or missing query keys", async () => {
    const calls: PortCalls = { episodes: [], windows: [] };
    const fixture = await makeApp(fakeMemory(calls));
    try {
      const sessionId = makeSession(fixture.repo);
      expect(
        (await get(fixture.app, `${episodesPath(sessionId)}?extra=1`)).status,
      ).toBe(400);
      expect((await get(fixture.app, windowsPath(sessionId))).status).toBe(400);
      expect(calls).toEqual({ episodes: [], windows: [] });
    } finally {
      fixture.close();
    }
  });

  it("404s when memory is disabled", async () => {
    const fixture = await makeApp();
    try {
      const sessionId = makeSession(fixture.repo);
      for (const path of [
        episodesPath(sessionId),
        `${windowsPath(sessionId)}?episodeKey=session-a`,
      ]) {
        const out = await get(fixture.app, path);
        expect(out.status).toBe(404);
        expect(out.body).toMatchObject({
          error: { code: "memory_unavailable" },
        });
      }
    } finally {
      fixture.close();
    }
  });

  it("503s on a fixed service failure (old remind BAD_REQUEST)", async () => {
    const calls: PortCalls = { episodes: [], windows: [] };
    const fixture = await makeApp(
      fakeMemory(calls, {
        getMemoryEpisodes: async () => {
          throw new MemoryManageError("service_unavailable");
        },
        getMemoryEpisodeWindows: async () => {
          throw new MemoryManageError("service_unavailable");
        },
      }),
    );
    try {
      const sessionId = makeSession(fixture.repo);
      for (const path of [
        episodesPath(sessionId),
        `${windowsPath(sessionId)}?episodeKey=session-a`,
      ]) {
        const out = await get(fixture.app, path);
        expect(out.status).toBe(503);
        expect(out.body).toMatchObject({
          error: { code: "memory_unavailable" },
        });
      }
    } finally {
      fixture.close();
    }
  });
});
