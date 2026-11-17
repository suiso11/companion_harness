// Companion diary: store bounds, the once-per-day pass, dry-run, rejection,
// scheduling, and the read API.

import type { WebSearchConfig } from "@companion/contracts";
import {
  closeKernelDatabase,
  createKernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
} from "@companion/kernel";
import type { ModelGateway } from "@companion/model-local";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import type { SpeechConfig } from "../src/config.js";
import { createDayActivityStore } from "../src/day_activity.js";
import { createDiaryStore } from "../src/diary_store.js";
import {
  createSpontaneousService,
  type SpontaneousServiceDeps,
} from "../src/spontaneous_service.js";
import { createThoughtStore } from "../src/thought_store.js";
import { createServerFixtureContext } from "./server_fixture.js";

const SCOPE = "personal/default";
const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-09-22T12:00:00Z");
const TARGET_DAY = "2026-09-21";

function config(overrides: Partial<SpeechConfig> = {}): SpeechConfig {
  return {
    enabled: true,
    mode: "live",
    thoughtIntervalMs: 24 * HOUR,
    speechIntervalMs: 24 * HOUR,
    minQuietMs: 5 * 60 * 1000,
    minGapMs: HOUR,
    maxSpeechPerDay: 1,
    memoryLimit: 30,
    maxChars: 200,
    quietHours: null,
    ...overrides,
  };
}

function webSearch(): WebSearchConfig {
  return {
    enabled: false,
    max_results: 5,
    timeout_ms: 1000,
    per_turn_budget: 3,
    max_response_bytes: 1024 * 1024,
  };
}

function envelope(items: unknown[]) {
  return { ok: true, code: "OK", data: { items }, deduplicated: false };
}

function gatewayWith(texts: string[]): ModelGateway {
  const queue = [...texts];
  return {
    provider: "openai-compatible",
    capabilities: { toolCalling: false },
    baseUrl: "http://127.0.0.1:9",
    chatUrl: "http://127.0.0.1:9/v1/chat/completions",
    chat: async () => ({
      text: queue.shift() ?? "",
      toolCalls: [],
      stopReason: "stop" as const,
    }),
  };
}

const ENTRY = JSON.stringify({ entry: "あ".repeat(150) });

async function setup(
  overrides: Partial<SpontaneousServiceDeps> = {},
  seedAt = Date.parse(`${TARGET_DAY}T12:00:00Z`),
) {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  const repo = createKernelRepository(handle.raw);
  const store = createThoughtStore(handle.raw);
  const diary = createDiaryStore(handle.raw);
  const sessionId = repo.createSession({
    key: crypto.randomUUID(),
    now: seedAt,
  }).body.sessionId;
  const posted = repo.postMessage(
    sessionId,
    { text: "今日は散歩に出かけた" },
    { key: crypto.randomUUID(), now: seedAt + 1 },
  );
  repo.cancelRun(sessionId, posted.body.run.id, { now: seedAt + 2 });
  let clock = NOW;
  const service = createSpontaneousService({
    repo,
    store,
    diary,
    activity: createDayActivityStore(handle.raw),
    config: config(),
    memory: {
      executable: "/bin/true",
      entry: "/bin/true",
      config: "/tmp/config.json",
      timeoutMs: 5000,
      maxResponseBytes: 65536,
    },
    scope: SCOPE,
    webSearch: webSearch(),
    gateway: null,
    model: "test-model",
    background: null,
    timeZone: "UTC",
    now: () => clock,
    memoryCall: async () => envelope([]),
    setTimeout: (() =>
      0 as unknown as ReturnType<
        typeof setTimeout
      >) as unknown as typeof setTimeout,
    ...overrides,
  });
  return {
    handle,
    repo,
    diary,
    service,
    setClock: (at: number) => {
      clock = at;
    },
  };
}

function close(
  handle: ReturnType<typeof openKernelDatabase>,
  service?: { stop(): Promise<void> },
) {
  void service?.stop();
  closeKernelDatabase(handle);
}

function recordingTimers() {
  const calls: { run: () => void; delay: number }[] = [];
  const setTimeoutFn = ((run: () => void, delay: number) => {
    calls.push({ run, delay });
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;
  return { calls, setTimeout: setTimeoutFn };
}

describe("diary store", () => {
  async function storeFixture() {
    const handle = openKernelDatabase(":memory:");
    await migrateKernelDatabase({ db: handle.raw });
    return { handle, store: createDiaryStore(handle.raw) };
  }

  it("round-trips one entry per day and reports duplicates as null", async () => {
    const { handle, store } = await storeFixture();
    try {
      const entry = store.insert(TARGET_DAY, "あ".repeat(150), NOW);
      expect(entry).toEqual({
        day: TARGET_DAY,
        body: "あ".repeat(150),
        createdAt: NOW,
      });
      expect(store.get(TARGET_DAY)).toEqual(entry);
      expect(store.insert(TARGET_DAY, "い".repeat(150), NOW + 1)).toBeNull();
      expect(store.get(TARGET_DAY)?.body).toBe("あ".repeat(150));
      expect(store.get("not-a-day")).toBeNull();
      expect(store.get("2026-02-30")).toBeNull();
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("throws on invalid insert input", async () => {
    const { handle, store } = await storeFixture();
    try {
      expect(() => store.insert("2026-02-30", "x", NOW)).toThrow();
      expect(() => store.insert("not-a-day", "x", NOW)).toThrow();
      expect(() => store.insert(TARGET_DAY, "", NOW)).toThrow();
      expect(() => store.insert(TARGET_DAY, "x".repeat(2001), NOW)).toThrow();
      expect(() => store.insert(TARGET_DAY, "a\0b", NOW)).toThrow();
      expect(() => store.insert(TARGET_DAY, "ok", -1)).toThrow();
      expect(() => store.insert(TARGET_DAY, "ok", 1.5)).toThrow();
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("lists newest day first and clamps the limit to 1..100", async () => {
    const { handle, store } = await storeFixture();
    try {
      const base = Date.parse("2026-01-01T00:00:00Z");
      for (let i = 0; i < 105; i += 1) {
        const day = new Date(base + i * 24 * HOUR).toISOString().slice(0, 10);
        store.insert(day, `entry ${i}`, NOW);
      }
      const newest = store.list(3);
      expect(newest.map((entry) => entry.day)).toEqual([
        "2026-04-15",
        "2026-04-14",
        "2026-04-13",
      ]);
      expect(store.list(0)).toHaveLength(1);
      expect(store.list(1000)).toHaveLength(100);
      expect(store.list()).toHaveLength(30);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

describe("diary listMonth", () => {
  it("returns one month ascending and rejects malformed months", async () => {
    const handle = openKernelDatabase(":memory:");
    await migrateKernelDatabase({ db: handle.raw });
    const store = createDiaryStore(handle.raw);
    try {
      for (const day of [
        "2026-11-30",
        "2026-12-01",
        "2026-12-31",
        "2027-01-01",
        "2026-12-15",
      ]) {
        store.insert(day, `entry ${day}`, NOW);
      }
      expect(store.listMonth("2026-12").map((entry) => entry.day)).toEqual([
        "2026-12-01",
        "2026-12-15",
        "2026-12-31",
      ]);
      expect(store.listMonth("2026-11").map((entry) => entry.day)).toEqual([
        "2026-11-30",
      ]);
      expect(store.listMonth("2026-10")).toEqual([]);
      for (const bad of [
        "2026-13",
        "2026-00",
        "2026-1",
        "26-12",
        "2026-12-01",
      ]) {
        expect(() => store.listMonth(bad)).toThrow();
      }
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

describe("diary pass", () => {
  it("writes exactly one entry for the previous local day", async () => {
    const { handle, diary, service } = await setup({
      gateway: gatewayWith([ENTRY]),
    });
    try {
      service.start();
      expect(await service.runDiaryPass()).toBe("written");
      const entry = diary.get(TARGET_DAY);
      expect(entry?.body).toBe("あ".repeat(150));
      expect(entry?.createdAt).toBe(NOW);
      expect(diary.list()).toHaveLength(1);
      expect(await service.runDiaryPass()).toBe("skipped");
      expect(diary.list()).toHaveLength(1);
    } finally {
      close(handle, service);
    }
  });

  it("accepts a concise entry the local model actually returns", async () => {
    const short =
      "### やったこと\n朝から散歩をして、駅前のカフェで本を読んだ。\n### コンパニオンの動き\n特になし\n### タスク\n特になし";
    const { handle, diary, service } = await setup({
      gateway: gatewayWith([JSON.stringify({ entry: short })]),
    });
    try {
      service.start();
      expect(await service.runDiaryPass()).toBe("written");
      expect(diary.get(TARGET_DAY)?.body).toBe(short);
    } finally {
      close(handle, service);
    }
  });

  it("puts the three headings and the day's activity in the prompt", async () => {
    const requests: Array<{
      messages: Array<{ role: string; content: string }>;
      maxOutputTokens?: number;
    }> = [];
    const gateway: ModelGateway = {
      ...gatewayWith([ENTRY]),
      chat: (async (request: (typeof requests)[number]) => {
        requests.push(request);
        return { text: ENTRY, toolCalls: [], stopReason: "stop" as const };
      }) as unknown as ModelGateway["chat"],
    };
    const { handle, repo, service } = await setup({ gateway });
    try {
      const [session] = repo.listSessions({ limit: 1 }).sessions;
      const sessionId = session?.id ?? "";
      repo.postCompanionMessage(sessionId, "お散歩どうだった？", {
        now: Date.parse(`${TARGET_DAY}T13:00:00Z`),
      });
      handle.raw
        .prepare(
          `INSERT INTO autonomy_tasks (id, session_id, scope, title, kind, speaker,
             status, version, created_at, updated_at)
           VALUES (?, ?, ?, '牛乳を買う', 'task', 'user', 'open', 1, ?, ?)`,
        )
        .run(
          crypto.randomUUID(),
          sessionId,
          SCOPE,
          Date.parse(`${TARGET_DAY}T14:00:00Z`),
          Date.parse(`${TARGET_DAY}T14:00:00Z`),
        );
      service.start();
      expect(await service.runDiaryPass()).toBe("written");
      const request = requests[0];
      expect(request?.maxOutputTokens).toBe(2600);
      const system = request?.messages[0]?.content ?? "";
      const headings = [
        "### やったこと",
        "### コンパニオンの動き",
        "### タスク",
      ];
      const positions = headings.map((heading) => system.indexOf(heading));
      expect(positions.every((p) => p >= 0)).toBe(true);
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
      const user = request?.messages[1]?.content ?? "";
      expect(user).toContain("User conversation:\nUser: 今日は散歩に出かけた");
      expect(user).toContain("Companion messages:\nお散歩どうだった？");
      expect(user).toContain("Tasks:\n- [open] task: 牛乳を買う");
      expect(user).toContain("Actions:\n(none)");
    } finally {
      close(handle, service);
    }
  });

  it("writes an entry for a day where only the companion acted", async () => {
    const { handle, repo, diary, service } = await setup(
      { gateway: gatewayWith([ENTRY]) },
      Date.parse("2026-09-22T08:00:00Z"),
    );
    try {
      const [session] = repo.listSessions({ limit: 1 }).sessions;
      repo.postCompanionMessage(session?.id ?? "", "ひとりごと", {
        now: Date.parse(`${TARGET_DAY}T10:00:00Z`),
      });
      service.start();
      expect(await service.runDiaryPass()).toBe("written");
      expect(diary.get(TARGET_DAY)).not.toBeNull();
    } finally {
      close(handle, service);
    }
  });

  it("skips when the previous day already has an entry", async () => {
    const { handle, diary, service } = await setup({
      gateway: gatewayWith([ENTRY]),
    });
    try {
      diary.insert(TARGET_DAY, "既存の日記", NOW - 1);
      service.start();
      expect(await service.runDiaryPass()).toBe("skipped");
      expect(diary.get(TARGET_DAY)?.body).toBe("既存の日記");
    } finally {
      close(handle, service);
    }
  });

  it("skips when the previous day has no user turn", async () => {
    const { handle, service } = await setup(
      { gateway: gatewayWith([ENTRY]) },
      Date.parse("2026-09-22T08:00:00Z"),
    );
    try {
      service.start();
      expect(await service.runDiaryPass()).toBe("skipped");
    } finally {
      close(handle, service);
    }
  });

  it("dry-run never inserts", async () => {
    const { handle, diary, service } = await setup({
      config: config({ mode: "dry-run" }),
      gateway: gatewayWith([ENTRY]),
    });
    try {
      service.start();
      expect(await service.runDiaryPass()).toBe("written");
      expect(diary.list()).toHaveLength(0);
    } finally {
      close(handle, service);
    }
  });

  it("returns error when the model call fails", async () => {
    const failing: ModelGateway = {
      provider: "openai-compatible",
      capabilities: { toolCalling: false },
      baseUrl: "http://127.0.0.1:9",
      chatUrl: "http://127.0.0.1:9/v1/chat/completions",
      chat: async () => {
        throw new Error("gateway down");
      },
    };
    const { handle, diary, service } = await setup({ gateway: failing });
    try {
      service.start();
      expect(await service.runDiaryPass()).toBe("error");
      expect(diary.list()).toHaveLength(0);
    } finally {
      close(handle, service);
    }
  });

  it("rejects a generated entry with a URL or UUID", async () => {
    const badEntries = [
      JSON.stringify({
        entry: `${"あ".repeat(150)} https://example.com`,
      }),
      JSON.stringify({
        entry: `${"あ".repeat(150)} 123e4567-e89b-12d3-a456-426614174000`,
      }),
    ];
    for (const text of badEntries) {
      const { handle, diary, service } = await setup({
        gateway: gatewayWith([text]),
      });
      try {
        service.start();
        expect(await service.runDiaryPass()).toBe("skipped");
        expect(diary.list()).toHaveLength(0);
      } finally {
        close(handle, service);
      }
    }
  });
});

describe("diary scheduling", () => {
  it("arms the catch-up at boot and the next 00:05 after a written pass", async () => {
    const timers = recordingTimers();
    const { handle, service } = await setup({
      setTimeout: timers.setTimeout,
      gateway: gatewayWith([ENTRY]),
      minutesOfDay: () => 12 * 60,
    });
    try {
      service.start();
      // thought, speech, diary catch-up.
      expect(timers.calls.map((call) => call.delay)).toEqual([
        300_000, 360_000, 120_000,
      ]);
      timers.calls[2]?.run();
      await vi.waitFor(() => expect(timers.calls).toHaveLength(4));
      // Noon -> 00:05 is 725 minutes away.
      expect(timers.calls[3]?.delay).toBe(725 * 60_000);
    } finally {
      close(handle, service);
    }
  });

  it("treats an exact 00:05 hit as a full day", async () => {
    const timers = recordingTimers();
    const { handle, service } = await setup({
      setTimeout: timers.setTimeout,
      gateway: gatewayWith([ENTRY]),
      minutesOfDay: () => 5,
    });
    try {
      service.start();
      timers.calls[2]?.run();
      await vi.waitFor(() => expect(timers.calls).toHaveLength(4));
      expect(timers.calls[3]?.delay).toBe(24 * HOUR);
    } finally {
      close(handle, service);
    }
  });

  it("retries on the short tick when a pass errors", async () => {
    const timers = recordingTimers();
    const failing: ModelGateway = {
      provider: "openai-compatible",
      capabilities: { toolCalling: false },
      baseUrl: "http://127.0.0.1:9",
      chatUrl: "http://127.0.0.1:9/v1/chat/completions",
      chat: async () => {
        throw new Error("gateway down");
      },
    };
    const { handle, service } = await setup({
      setTimeout: timers.setTimeout,
      gateway: failing,
      minutesOfDay: () => 12 * 60,
    });
    try {
      service.start();
      timers.calls[2]?.run();
      await vi.waitFor(() => expect(timers.calls).toHaveLength(4));
      expect(timers.calls[3]?.delay).toBe(10 * 60_000);
    } finally {
      close(handle, service);
    }
  });
});

describe("GET /api/diary", () => {
  function headers(): Record<string, string> {
    return { host: "127.0.0.1" };
  }

  async function appFixture(withDiary: boolean) {
    const cleanups: Array<() => void> = [];
    const {
      handle,
      repo,
      config: serverConfig,
      engine,
    } = await createServerFixtureContext(cleanups);
    const diary = withDiary ? createDiaryStore(handle.raw) : null;
    const { app } = createApp({
      config: serverConfig,
      repo,
      engine,
      ...(diary !== null ? { diary } : {}),
    });
    return {
      app,
      diary,
      close: () => {
        for (const fn of cleanups) fn();
      },
    };
  }

  it("returns items newest day first and validates the limit", async () => {
    const f = await appFixture(true);
    try {
      f.diary?.insert("2026-09-20", "古い日記", NOW - 1000);
      f.diary?.insert("2026-09-21", "新しい日記", NOW);
      const response = await f.app.request("/api/diary", {
        headers: headers(),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        items: [
          { day: "2026-09-21", body: "新しい日記", createdAt: NOW },
          { day: "2026-09-20", body: "古い日記", createdAt: NOW - 1000 },
        ],
      });
      const limited = await f.app.request("/api/diary?limit=1", {
        headers: headers(),
      });
      expect(await limited.json()).toEqual({
        items: [{ day: "2026-09-21", body: "新しい日記", createdAt: NOW }],
      });
      for (const limit of ["0", "abc", "101", "1.5", ""]) {
        const invalid = await f.app.request(`/api/diary?limit=${limit}`, {
          headers: headers(),
        });
        expect(invalid.status).toBe(400);
      }
      const extra = await f.app.request("/api/diary?cursor=x", {
        headers: headers(),
      });
      expect(extra.status).toBe(400);
    } finally {
      f.close();
    }
  });

  it("lists one month ascending and validates month/limit", async () => {
    const f = await appFixture(true);
    try {
      f.diary?.insert("2026-09-21", "b", NOW);
      f.diary?.insert("2026-09-02", "a", NOW);
      f.diary?.insert("2026-10-01", "c", NOW);
      const month = await f.app.request("/api/diary?month=2026-09", {
        headers: headers(),
      });
      expect(month.status).toBe(200);
      expect(await month.json()).toEqual({
        items: [
          { day: "2026-09-02", body: "a", createdAt: NOW },
          { day: "2026-09-21", body: "b", createdAt: NOW },
        ],
      });
      for (const bad of [
        "month=2026-13",
        "month=2026-9",
        "month=",
        "month=2026-09&limit=5",
      ]) {
        const res = await f.app.request(`/api/diary?${bad}`, {
          headers: headers(),
        });
        expect(res.status).toBe(400);
      }
    } finally {
      f.close();
    }
  });

  it("reads one day or null and rejects malformed days", async () => {
    const f = await appFixture(true);
    try {
      f.diary?.insert("2026-09-21", "b", NOW);
      const hit = await f.app.request("/api/diary/2026-09-21", {
        headers: headers(),
      });
      expect(hit.status).toBe(200);
      expect(await hit.json()).toEqual({
        entry: { day: "2026-09-21", body: "b", createdAt: NOW },
      });
      const miss = await f.app.request("/api/diary/2026-09-22", {
        headers: headers(),
      });
      expect(miss.status).toBe(200);
      expect(await miss.json()).toEqual({ entry: null });
      for (const bad of ["foo", "2026-02-30", "2026-9-1"]) {
        const res = await f.app.request(`/api/diary/${bad}`, {
          headers: headers(),
        });
        expect(res.status).toBe(400);
      }
    } finally {
      f.close();
    }
  });

  it("answers a fixed 404 when the store is absent", async () => {
    const f = await appFixture(false);
    try {
      const response = await f.app.request("/api/diary", {
        headers: headers(),
      });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: { code: "diary_unavailable", message: "diary is disabled" },
      });
    } finally {
      f.close();
    }
  });

  it("serves the /diary shell with a trailing slash", async () => {
    const f = await appFixture(true);
    try {
      for (const path of [
        "/diary",
        "/diary/",
        "/diary/2026-11-16",
        "/diary/2026-11-16/",
      ]) {
        const response = await f.app.request(path, { headers: headers() });
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("text/html");
      }
      const junk = await f.app.request("/diary/foo", { headers: headers() });
      expect(junk.status).toBe(404);
    } finally {
      f.close();
    }
  });
});
