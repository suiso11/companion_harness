// PR-2 server deltas: ephemeral bus coalescing, SSE multiplexing, and
// fallback/durability isolation (deltas never persisted, never polled).
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MODEL_DELTA_EVENT_TYPES,
  parseModelDeltaEvent,
} from "@companion/contracts";
import {
  closeKernelDatabase,
  createKernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
  RunEngine,
} from "@companion/kernel";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadServerConfig } from "../src/config.js";
import {
  formatModelDeltaSse,
  MODEL_DELTA_COALESCE_CHARS,
  MODEL_DELTA_COALESCE_MS,
  ModelDeltaBus,
} from "../src/model_deltas.js";
import { createSseResponse } from "../src/sse.js";

function manualTimers(): {
  timers: {
    now: () => number;
    setTimeout: typeof setTimeout;
    clearTimeout: typeof clearTimeout;
  };
  pending: Array<() => void>;
} {
  const pending: Array<() => void> = [];
  const setTimeoutFn = ((fn: () => void) => {
    pending.push(fn);
    return pending.length as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  const clearTimeoutFn = ((_id: unknown) => {}) as typeof clearTimeout;
  return {
    timers: {
      now: () => 1790000000000,
      setTimeout: setTimeoutFn,
      clearTimeout: clearTimeoutFn,
    },
    pending,
  };
}

function parseChunkData(chunk: string): { type: string; payload: unknown } {
  const dataLine = chunk.split("\n").find((line) => line.startsWith("data: "));
  expect(dataLine).toBeDefined();
  return JSON.parse((dataLine as string).slice("data: ".length)) as {
    type: string;
    payload: unknown;
  };
}

describe("ephemeral delta bus (PR-2)", () => {
  it("coalesces rapid pieces into one envelope per flush", () => {
    const { timers, pending } = manualTimers();
    const bus = new ModelDeltaBus(timers);
    const runId = randomUUID();
    const chunks: string[] = [];
    const unsubscribe = bus.subscribe(runId, (chunk) => {
      chunks.push(chunk);
    });
    try {
      bus.publishPiece({
        runId,
        step: 1,
        kind: "reasoning",
        text: "a",
        now: 1,
      });
      bus.publishPiece({
        runId,
        step: 1,
        kind: "reasoning",
        text: "b",
        now: 2,
      });
      bus.publishPiece({ runId, step: 1, kind: "draft", text: "x", now: 3 });
      expect(chunks).toHaveLength(0);
      expect(pending).toHaveLength(2);
      for (const fire of pending.splice(0)) {
        fire();
      }
      expect(chunks).toHaveLength(2);
      const first = parseChunkData(chunks[0] as string);
      const second = parseChunkData(chunks[1] as string);
      expect(first.type).toBe("model.reasoning.delta");
      expect(first.payload).toEqual({ step: 1, text: "ab" });
      expect(second.type).toBe("answer.draft.delta");
      expect(second.payload).toEqual({ step: 1, text: "x" });
      // Full envelope validates; seq is 0 (never a cursor).
      const envelope = JSON.parse(
        (
          (chunks[0] as string)
            .split("\n")
            .find((l) => l.startsWith("data: ")) as string
        ).slice(6),
      );
      expect(parseModelDeltaEvent(envelope).seq).toBe(0);
    } finally {
      unsubscribe();
    }
  });

  it("flushes early at the char bound and passes usage through", () => {
    const { timers } = manualTimers();
    const bus = new ModelDeltaBus(timers);
    const runId = randomUUID();
    const chunks: string[] = [];
    const unsubscribe = bus.subscribe(runId, (chunk) => {
      chunks.push(chunk);
    });
    try {
      bus.publishPiece({
        runId,
        step: 2,
        kind: "draft",
        text: "z".repeat(MODEL_DELTA_COALESCE_CHARS),
        now: 1,
      });
      expect(chunks).toHaveLength(1);
      expect(parseChunkData(chunks[0] as string).payload).toEqual({
        step: 2,
        text: "z".repeat(MODEL_DELTA_COALESCE_CHARS),
      });
      bus.publishUsage({
        runId,
        step: 2,
        promptTokens: 10,
        completionTokens: 45,
        elapsedMs: 2800,
        now: 2,
      });
      expect(chunks).toHaveLength(2);
      const usage = parseChunkData(chunks[1] as string) as {
        type: string;
        payload: unknown;
      };
      expect(usage.type).toBe("model.usage");
      expect(usage.payload).toEqual({
        promptTokens: 10,
        completionTokens: 45,
        elapsedMs: 2800,
      });
    } finally {
      unsubscribe();
    }
  });

  it("isolates runs, drops invalid pieces, tolerates no listeners", () => {
    const bus = new ModelDeltaBus();
    const runA = randomUUID();
    const runB = randomUUID();
    const seenA: string[] = [];
    const unsubscribe = bus.subscribe(runA, (chunk) => {
      seenA.push(chunk);
    });
    try {
      // Other runs never leak across.
      bus.publishPiece({
        runId: runB,
        step: 1,
        kind: "draft",
        text: "nope",
        now: 1,
      });
      bus.flush(runB);
      expect(seenA).toHaveLength(0);
      // Invalid step (0) drops without throwing or logging content.
      bus.publishPiece({
        runId: runA,
        step: 0,
        kind: "draft",
        text: "bad",
        now: 1,
      });
      bus.flush(runA);
      expect(seenA).toHaveLength(0);
      // Publishing with no listeners at all never throws.
      bus.publishPiece({
        runId: randomUUID(),
        step: 1,
        kind: "draft",
        text: "void",
        now: 1,
      });
      bus.flush();
    } finally {
      unsubscribe();
    }
  });

  it("delta wire omits id so polling/replay never lands on it", () => {
    const { timers } = manualTimers();
    const bus = new ModelDeltaBus(timers);
    const runId = randomUUID();
    const chunks: string[] = [];
    const unsubscribe = bus.subscribe(runId, (chunk) => {
      chunks.push(chunk);
    });
    try {
      bus.publishPiece({
        runId,
        step: 1,
        kind: "reasoning",
        text: "t",
        now: 1,
      });
      bus.flush(runId);
      expect(chunks).toHaveLength(1);
      expect(chunks[0] as string).not.toMatch(/^id: /m);
      expect(chunks[0] as string).toMatch(/^event: run-event$/m);
    } finally {
      unsubscribe();
    }
    // Formatter upholds the same shape for every delta type.
    for (const type of MODEL_DELTA_EVENT_TYPES) {
      const payload =
        type === "model.usage"
          ? { promptTokens: 1, completionTokens: 2, elapsedMs: 3 }
          : { step: 1, text: "t" };
      const chunk = formatModelDeltaSse(
        parseModelDeltaEvent({
          schemaVersion: 1,
          runId,
          seq: 0,
          createdAt: 1,
          type,
          payload,
        }),
      );
      expect(chunk).not.toMatch(/^id: /m);
    }
  });
});

describe("SSE delta multiplexing (PR-2)", () => {
  function fakeTimers(): {
    created: Array<{ id: number; fn: () => void; ms: number }>;
    cleared: number[];
    setInterval: typeof setInterval;
    clearInterval: typeof clearInterval;
    setTimeout: typeof setTimeout;
  } {
    let next = 1;
    const created: Array<{ id: number; fn: () => void; ms: number }> = [];
    const cleared: number[] = [];
    const setIntervalFn = ((fn: () => void, ms?: number) => {
      const id = next++;
      created.push({ id, fn, ms: ms ?? 0 });
      return id as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    const clearIntervalFn = ((id: unknown) => {
      cleared.push(id as number);
    }) as typeof clearInterval;
    const setTimeoutFn = ((fn: () => void, _ms?: number) => {
      const id = next++;
      queueMicrotask(fn);
      return id as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    return {
      created,
      cleared,
      setInterval: setIntervalFn,
      clearInterval: clearIntervalFn,
      setTimeout: setTimeoutFn,
    };
  }

  async function drain(): Promise<void> {
    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
    }
  }

  it("delivers live deltas alongside durable events on one stream", async () => {
    const timers = fakeTimers();
    const runId = randomUUID();
    const durable = {
      schemaVersion: 1,
      runId,
      seq: 1,
      createdAt: 1,
      type: "run.started",
      payload: { attempt: 1 },
    };
    const source = {
      getEvents: () => ({
        events: [durable],
        nextAfter: 1,
        hasMore: false,
        terminal: false,
      }),
      getRun: () => ({ status: "running", eventSeq: 1 }),
    };
    const bus = new ModelDeltaBus();
    const res = createSseResponse(source, "s", runId, 0, timers, bus);
    const reader = res.body?.getReader();
    // Durable poll first.
    const first = await reader?.read();
    expect(first?.done).toBe(false);
    expect(new TextDecoder().decode(first?.value)).toContain("run.started");
    // Live delta next (coalesced flush, same `run-event` name).
    bus.publishPiece({
      runId,
      step: 1,
      kind: "reasoning",
      text: "live",
      now: 2,
    });
    bus.flush(runId);
    await drain();
    const second = await reader?.read();
    expect(second?.done).toBe(false);
    const text = new TextDecoder().decode(second?.value);
    expect(text).toContain("model.reasoning.delta");
    expect(text).not.toMatch(/^id: /m);
    await reader?.cancel().catch(() => {});
    await res.body?.cancel().catch(() => {});
  });

  it("keeps the durable-only stream byte-identical without a bus", async () => {
    const timers = fakeTimers();
    const runId = randomUUID();
    const durable = {
      schemaVersion: 1,
      runId,
      seq: 1,
      createdAt: 1,
      type: "run.started",
      payload: { attempt: 1 },
    };
    const source = {
      getEvents: () => ({
        events: [durable],
        nextAfter: 1,
        hasMore: false,
        terminal: false,
      }),
      getRun: () => ({ status: "running", eventSeq: 1 }),
    };
    const res = createSseResponse(source, "s", runId, 0, timers);
    const reader = res.body?.getReader();
    const first = await reader?.read();
    expect(new TextDecoder().decode(first?.value)).toContain("run.started");
    await reader?.cancel().catch(() => {});
    await res.body?.cancel().catch(() => {});
  });

  it("a throwing delta subscribe never breaks the durable stream", async () => {
    const timers = fakeTimers();
    const source = {
      getEvents: () => ({
        events: [],
        nextAfter: 0,
        hasMore: false,
        terminal: false,
      }),
      getRun: () => ({ status: "running", eventSeq: 0 }),
    };
    const broken = {
      subscribe: (): (() => void) => {
        throw new Error("bus boom");
      },
    };
    const res = createSseResponse(source, "s", "r", 0, timers, broken);
    expect(res.status).toBe(200);
    await drain();
    await res.body?.cancel().catch(() => {});
  });
});

describe("SSE delivery guarantees (PR-2)", () => {
  it("pins the coalescing bounds (50ms window, 256 chars)", () => {
    expect(MODEL_DELTA_COALESCE_MS).toBe(50);
    expect(MODEL_DELTA_COALESCE_CHARS).toBe(256);
    const { timers, pending } = manualTimers();
    const bus = new ModelDeltaBus(timers);
    const runId = randomUUID();
    const chunks: string[] = [];
    const unsubscribe = bus.subscribe(runId, (chunk) => {
      chunks.push(chunk);
    });
    try {
      // One small piece waits out the window (no immediate emission).
      bus.publishPiece({
        runId,
        step: 1,
        kind: "draft",
        text: "hello",
        now: 1,
      });
      expect(chunks).toHaveLength(0);
      expect(pending).toHaveLength(1);
      for (const fire of pending.splice(0)) {
        fire();
      }
      expect(chunks).toHaveLength(1);
      const data = parseChunkData(chunks[0] as string);
      expect(data.type).toBe("answer.draft.delta");
      expect(data.payload).toEqual({ step: 1, text: "hello" });
    } finally {
      unsubscribe();
    }
  });

  it("never replays missed deltas to late or resubscribed clients", () => {
    const bus = new ModelDeltaBus();
    const runId = randomUUID();
    // Published + flushed with nobody listening: dropped, not buffered.
    bus.publishPiece({
      runId,
      step: 1,
      kind: "reasoning",
      text: "missed",
      now: 1,
    });
    bus.flush(runId);
    const late: string[] = [];
    const unsubscribeLate = bus.subscribe(runId, (chunk) => {
      late.push(chunk);
    });
    unsubscribeLate();
    const second: string[] = [];
    const unsubscribeSecond = bus.subscribe(runId, (chunk) => {
      second.push(chunk);
    });
    try {
      // A late (re)subscriber sees no history on flush.
      bus.flush(runId);
      expect(late).toHaveLength(0);
      expect(second).toHaveLength(0);
      // The bus still delivers new pieces after (re)subscribe.
      bus.publishPiece({
        runId,
        step: 1,
        kind: "reasoning",
        text: "live",
        now: 2,
      });
      bus.flush(runId);
      expect(second).toHaveLength(1);
      expect(parseChunkData(second[0] as string).type).toBe(
        "model.reasoning.delta",
      );
    } finally {
      unsubscribeSecond();
    }
  });

  it("deltas never persist: events table + JSON fallback see durable only", async () => {
    const T0 = Date.parse("2026-02-01T00:00:00.000Z");
    const handle = openKernelDatabase(":memory:");
    await migrateKernelDatabase({ db: handle.raw });
    try {
      const config = loadServerConfig({
        COMPANION_DB_PATH: join(
          mkdtempSync(join(tmpdir(), "companion-deltas-")),
          "db.sqlite",
        ),
        COMPANION_HOST: "127.0.0.1",
        COMPANION_PORT: "3000",
        COMPANION_TIME_ZONE: "UTC",
        COMPANION_LOG_LEVEL: "error",
      });
      const repo = createKernelRepository(handle.raw, {});
      const engine = new RunEngine({ db: handle.raw, repo, cancelGraceMs: 30 });
      const bus = new ModelDeltaBus();
      const created = createApp({ config, repo, engine, modelDeltas: bus });
      const sessionId = repo.createSession({ key: randomUUID(), now: T0 }).body
        .sessionId;
      const posted = repo.postMessage(
        sessionId,
        { text: "hello" },
        { key: randomUUID(), now: T0 },
      ).body;
      await repo.startRun(posted.run.id, { now: T0 + 1 });
      // Stream every delta kind the way bootstrap's onModelDelta does.
      bus.publishPiece({
        runId: posted.run.id,
        step: 1,
        kind: "reasoning",
        text: "thinking",
        now: T0 + 2,
      });
      bus.publishPiece({
        runId: posted.run.id,
        step: 1,
        kind: "draft",
        text: "answer",
        now: T0 + 3,
      });
      bus.publishUsage({
        runId: posted.run.id,
        step: 1,
        promptTokens: 7,
        completionTokens: 9,
        elapsedMs: 12,
        now: T0 + 4,
      });
      bus.flush(posted.run.id);
      // Events table: durable rows only, every seq a real cursor (>= 1).
      const page = repo.getEvents(sessionId, posted.run.id, {
        after: 0,
        limit: 100,
      });
      for (const event of page.events) {
        expect(MODEL_DELTA_EVENT_TYPES as readonly string[]).not.toContain(
          event.type,
        );
        expect(event.seq).toBeGreaterThanOrEqual(1);
      }
      // JSON fallback polling over HTTP: the same durable rows, no deltas.
      const res = await created.app.request(
        `/api/sessions/${sessionId}/runs/${posted.run.id}/events?after=0`,
        { headers: { host: "127.0.0.1" } },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        events: Array<{ type: string; seq: number }>;
      };
      expect(body.events.map((event) => event.type)).toEqual(
        page.events.map((event) => event.type),
      );
      for (const event of body.events) {
        expect(MODEL_DELTA_EVENT_TYPES as readonly string[]).not.toContain(
          event.type,
        );
      }
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
