// Spontaneous thought/speech service: bounded passes, sensitive exclusion,
// dry-run, daily speech, and durable feedback.

import type { WebSearchConfig } from "@companion/contracts";
import {
  closeKernelDatabase,
  createKernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
} from "@companion/kernel";
import type { ModelGateway } from "@companion/model-local";
import { describe, expect, it } from "vitest";
import type { SpeechConfig } from "../src/config.js";
import {
  createSpontaneousService,
  type SpontaneousServiceDeps,
} from "../src/spontaneous_service.js";
import { createThoughtStore, type ThoughtStore } from "../src/thought_store.js";

const SCOPE = "personal/default";
const T0 = 1_790_000_000_000;
const HOUR = 60 * 60 * 1000;

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
    enabled: true,
    searxng_base_url: "http://127.0.0.1:8888",
    max_results: 5,
    timeout_ms: 1000,
    per_turn_budget: 3,
    max_response_bytes: 1024 * 1024,
  };
}

function envelope(items: unknown[]) {
  return {
    ok: true,
    code: "OK",
    data: { items },
    deduplicated: false,
  };
}

function memoryItem(
  id: string,
  snippet: string,
  sensitivity: "normal" | "sensitive" = "normal",
  kind: "user_fact" | "summary" = "user_fact",
) {
  return {
    id,
    kind,
    status: "active",
    snippet,
    createdAt: "2026-10-29T00:00:00.000Z",
    evidence: kind === "user_fact" ? snippet : null,
    privacy: { sensitivity, origin: "conversation" },
  };
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

async function setup(overrides: Partial<SpontaneousServiceDeps> = {}) {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  const repo = createKernelRepository(handle.raw);
  const store = createThoughtStore(handle.raw);
  const sessionId = repo.createSession({ key: crypto.randomUUID(), now: T0 })
    .body.sessionId;
  const posted = repo.postMessage(
    sessionId,
    { text: "先週、釣り道具を買い替えた" },
    { key: crypto.randomUUID(), now: T0 + 1 },
  );
  repo.cancelRun(sessionId, posted.body.run.id, { now: T0 + 2 });
  const service = createSpontaneousService({
    repo,
    store,
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
    now: () => T0 + 10 * 60 * 1000,
    setTimeout: (() =>
      0 as unknown as ReturnType<
        typeof setTimeout
      >) as unknown as typeof setTimeout,
    ...overrides,
  });
  service.start();
  return { handle, repo, store, sessionId, service };
}

function close(
  handle: ReturnType<typeof openKernelDatabase>,
  service?: { stop(): Promise<void> },
) {
  void service?.stop();
  closeKernelDatabase(handle);
}

const RESEARCH = JSON.stringify({
  action: "research",
  topic: "釣り道具の選び方",
  queries: ["釣り道具 買い替え 選び方"],
  memoryIndexes: [0],
});
const THOUGHT = JSON.stringify({
  kind: "survey",
  body: "道具を買い替えた話があった。どんな基準で選んだのか気になる。",
  topics: ["釣り"],
});

describe("spontaneous thought pass", () => {
  it("stores one thought from normal memories and web snippets", async () => {
    const { handle, store, service } = await setup({
      gateway: gatewayWith([RESEARCH, THOUGHT]),
      memoryCall: async () =>
        envelope([
          memoryItem("rec1", "ユーザーは釣り道具を買い替えた"),
          memoryItem("rec2", "sensitive note", "sensitive"),
          memoryItem("rec3", "inference note", "normal", "summary"),
        ]),
      search: async () => [
        {
          url: "https://example.com/a",
          title: "道具選び",
          snippet: "選び方の記事",
          canonicalKey: "k1",
        },
      ],
    });
    try {
      expect(await service.runThoughtPass()).toBe("created");
      const open = store.listOpen(10);
      expect(open).toHaveLength(1);
      expect(open[0]?.body).toContain("買い替えた");
      expect(open[0]?.memoryIds).toEqual(["rec1"]);
      expect(open[0]?.sources).toEqual([
        { title: "道具選び", url: "https://example.com/a" },
      ]);
      // Sensitive-only memory is not selected into the thought.
      expect(open[0]?.memoryIds).not.toContain("rec2");
    } finally {
      close(handle, service);
    }
  });

  it("skips when every memory is sensitive or absent", async () => {
    const { handle, store, service } = await setup({
      gateway: gatewayWith([RESEARCH, THOUGHT]),
      memoryCall: async () => envelope([memoryItem("rec1", "x", "sensitive")]),
    });
    try {
      expect(await service.runThoughtPass()).toBe("skipped");
      expect(store.listOpen(10)).toHaveLength(0);
    } finally {
      close(handle, service);
    }
  });
});

describe("spontaneous speech pass", () => {
  it("posts one observation+question, then respects the daily cap", async () => {
    const { handle, repo, store, sessionId, service } = await setup({
      gateway: gatewayWith([
        JSON.stringify({
          action: "speak",
          message: "釣り道具を買い替えた話、何が決め手だった？",
        }),
      ]),
    });
    try {
      store.insert({
        sessionId,
        kind: "survey",
        body: "道具の話",
        topics: ["釣り"],
        memoryIds: ["rec1"],
        sources: [],
        now: T0 + 3,
      });
      expect(await service.runSpeechPass()).toBe("spoken");
      const history = repo.getHistory(sessionId, { limit: 10 });
      expect(history.items.some((item) => item.kind === "companion_text")).toBe(
        true,
      );
      expect(await service.runSpeechPass()).toBe("skipped");
    } finally {
      close(handle, service);
    }
  });

  it("dry-run never posts", async () => {
    const { handle, repo, store, sessionId, service } = await setup({
      config: config({ mode: "dry-run" }),
      gateway: gatewayWith([
        JSON.stringify({ action: "speak", message: "何が決め手だった？" }),
      ]),
    });
    try {
      store.insert({
        sessionId,
        kind: "question",
        body: "道具の話",
        topics: [],
        memoryIds: [],
        sources: [],
        now: T0 + 3,
      });
      expect(await service.runSpeechPass()).toBe("dry-run");
      expect(
        repo
          .getHistory(sessionId, { limit: 10 })
          .items.some((item) => item.kind === "companion_text"),
      ).toBe(false);
    } finally {
      close(handle, service);
    }
  });

  it("records a reply on the thought as durable learning feedback", async () => {
    const { handle, repo, store, sessionId, service } = await setup({
      gateway: gatewayWith([
        JSON.stringify({ action: "speak", message: "何が決め手だった？" }),
      ]),
    });
    try {
      const thought = store.insert({
        sessionId,
        kind: "question",
        body: "道具の話",
        topics: [],
        memoryIds: [],
        sources: [],
        now: T0 + 3,
      });
      expect(await service.runSpeechPass()).toBe("spoken");
      const asked = store.get(thought.id);
      expect(asked?.status).toBe("asked");
      // A user turn after the companion message is the reply signal.
      const reply = repo.postMessage(
        sessionId,
        { text: "軽さで選んだ" },
        { key: crypto.randomUUID(), now: T0 + 11 * 60 * 1000 },
      );
      repo.cancelRun(sessionId, reply.body.run.id, {
        now: T0 + 11 * 60 * 1000 + 1,
      });
      await service.runSpeechPass();
      const after = store.get(thought.id);
      expect(after?.status).toBe("answered");
      expect(after?.outcome).toBe("replied");
      expect(after?.replyTurnId).toBe(reply.body.turnId);
    } finally {
      close(handle, service);
    }
  });

  it("requires exactly one question mark", async () => {
    const { handle, repo, store, sessionId, service } = await setup({
      gateway: gatewayWith([
        JSON.stringify({
          action: "speak",
          message: "何が決め手だった？ 次はどうする？",
        }),
      ]),
    });
    try {
      store.insert({
        sessionId,
        kind: "question",
        body: "道具の話",
        topics: [],
        memoryIds: [],
        sources: [],
        now: T0 + 3,
      });
      expect(await service.runSpeechPass()).toBe("skipped");
      expect(
        repo
          .getHistory(sessionId, { limit: 10 })
          .items.some((item) => item.kind === "companion_text"),
      ).toBe(false);
    } finally {
      close(handle, service);
    }
  });

  it("does not post a message without an open question", async () => {
    const { handle, repo, store, sessionId, service } = await setup({
      gateway: gatewayWith([
        JSON.stringify({ action: "speak", message: "道具を買い替えた。" }),
      ]),
    });
    try {
      store.insert({
        sessionId,
        kind: "observation",
        body: "道具の話",
        topics: [],
        memoryIds: [],
        sources: [],
        now: T0 + 3,
      });
      expect(await service.runSpeechPass()).toBe("skipped");
      expect(
        repo
          .getHistory(sessionId, { limit: 10 })
          .items.some((item) => item.kind === "companion_text"),
      ).toBe(false);
    } finally {
      close(handle, service);
    }
  });
});

describe("thought store", () => {
  it("round-trips and enforces bounded values", async () => {
    const handle = openKernelDatabase(":memory:");
    await migrateKernelDatabase({ db: handle.raw });
    try {
      const repo = createKernelRepository(handle.raw);
      const sessionId = repo.createSession({
        key: crypto.randomUUID(),
        now: T0,
      }).body.sessionId;
      const store: ThoughtStore = createThoughtStore(handle.raw);
      const thought = store.insert({
        sessionId,
        kind: "survey",
        body: "note",
        topics: ["topic"],
        memoryIds: ["rec1"],
        sources: [{ title: "t", url: "https://example.com" }],
        now: T0,
      });
      expect(store.get(thought.id)?.body).toBe("note");
      expect(() =>
        store.insert({
          sessionId,
          kind: "survey",
          body: "",
          topics: [],
          memoryIds: [],
          sources: [],
          now: T0,
        }),
      ).toThrow();
      expect(
        store.markAsked(thought.id, T0 + 1, crypto.randomUUID(), sessionId),
      ).toBe(true);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
