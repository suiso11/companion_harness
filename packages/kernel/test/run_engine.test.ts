// M0 RunEngine / durable scheduler tests (plan §11, §13.3).
//
// Deterministic: intake timestamps are explicit, the scheduler is driven
// via pump() or a fake clock, and strategies are fixed fakes. No ToolBroker,
// no HTTP, no M1+ concepts.

import { describe, expect, it } from "vitest";
import {
  closeKernelDatabase,
  createKernelRepository,
  deferred,
  type EngineClock,
  failingStrategy,
  type GateObserver,
  gatedSuccess,
  immediateSuccess,
  invalidResultStrategy,
  type KernelRepository,
  migrateKernelDatabase,
  neverResolving,
  openKernelDatabase,
  RunEngine,
  StrategyRegistry,
} from "../src/index.js";

const T0 = 1790000000000;

function observer(): GateObserver {
  return { entered: [], aborted: [] };
}

async function openRepo() {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  const repo = createKernelRepository(handle.raw);
  return { handle, repo };
}

async function post(sessions: {
  repo: KernelRepository;
  sessionId: string;
  text: string;
  key: string;
  now: number;
  strategy?: string;
}) {
  return sessions.repo.postMessage(
    sessions.sessionId,
    { text: sessions.text },
    {
      key: sessions.key,
      now: sessions.now,
      ...(sessions.strategy === undefined
        ? {}
        : { strategy: sessions.strategy }),
    },
  );
}

function newSession(repo: KernelRepository, now: number): string {
  return repo.createSession({ key: crypto.randomUUID(), now }).body.sessionId;
}

function eventTypes(
  handle: {
    raw: {
      prepare: (sql: string) => {
        all: (id: string) => Array<{ type: string }>;
      };
    };
  },
  runId: string,
): string[] {
  const rows = handle.raw
    .prepare("SELECT type FROM run_events WHERE run_id = ? ORDER BY seq")
    .all(runId);
  return rows.map((row) => row.type);
}

async function waitFor(
  condition: () => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (condition()) {
      return;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function settle(engine: RunEngine, timeoutMs = 5000): Promise<void> {
  await waitFor(() => engine.inflightCount() === 0, timeoutMs);
}

/** Controllable fake clock: manual time + timer queue, no real waiting. */
function createFakeClock(start = T0 + 1000) {
  let now = start;
  let seq = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  function fire(): void {
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= now)
        .sort((a, b) => a[1].at - b[1].at);
      if (due.length === 0) {
        return;
      }
      for (const [id, timer] of due) {
        timers.delete(id);
        timer.fn();
      }
    }
  }
  const clock: EngineClock & {
    advance(ms: number): void;
    pendingTimers(): number;
  } = {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
      fire();
      await Promise.resolve();
    },
    setTimeout: (fn: () => void, ms: number) => {
      const id = seq;
      seq += 1;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (handle: unknown) => {
      timers.delete(handle as number);
    },
    advance: (ms: number) => {
      now += ms;
      fire();
    },
    pendingTimers: () => timers.size,
  };
  return clock;
}

describe("pickup ordering + single execution", () => {
  it("executes queued runs oldest-first exactly once with terminal events", async () => {
    const { handle, repo } = await openRepo();
    const engine = new RunEngine({
      db: handle.raw,
      repo,
      registry: new StrategyRegistry(),
      pollIntervalMs: 5,
    });
    try {
      const calls: string[] = [];
      engine.strategies.register("fake-ok", async () => {
        calls.push("run");
        return { version: 1, text: "answer" };
      });
      const s1 = newSession(repo, T0);
      const s2 = newSession(repo, T0);
      const m1 = await post({
        repo,
        sessionId: s1,
        text: "first",
        key: crypto.randomUUID(),
        now: T0,
        strategy: "fake-ok",
      });
      const m2 = await post({
        repo,
        sessionId: s2,
        text: "second",
        key: crypto.randomUUID(),
        now: T0 + 1,
        strategy: "fake-ok",
      });
      engine.start();
      expect(engine.pump()).toBe(2);
      await settle(engine);
      expect(calls).toEqual(["run", "run"]);
      expect(repo.getRun(m1.body.run.id).status).toBe("completed");
      expect(repo.getRun(m2.body.run.id).status).toBe("completed");
      expect(eventTypes(handle, m1.body.run.id)).toEqual([
        "run.queued",
        "run.started",
        "run.completed",
      ]);
      expect(repo.getSelection(m1.body.turnId)?.runId).toBe(m1.body.run.id);
      // Double pump after completion cannot re-execute terminal runs.
      expect(engine.pump()).toBe(0);
      expect(calls.length).toBe(2);
    } finally {
      await engine.shutdown({ drainMs: 0 });
      closeKernelDatabase(handle);
    }
  });

  it("hands strategies a frozen immutable view plus a live AbortSignal", async () => {
    const { handle, repo } = await openRepo();
    const engine = new RunEngine({ db: handle.raw, repo, pollIntervalMs: 5 });
    try {
      let checked = false;
      engine.strategies.register("fake-inspect", async (ctx) => {
        expect(Object.isFrozen(ctx)).toBe(true);
        expect(Object.isFrozen(ctx.run)).toBe(true);
        expect(Object.isFrozen(ctx.turn)).toBe(true);
        expect(Object.isFrozen(ctx.turn.input)).toBe(true);
        expect(Object.isFrozen(ctx.turn.frozenContext)).toBe(true);
        expect(ctx.signal).toBeInstanceOf(AbortSignal);
        expect(ctx.turn.input).toEqual({
          kind: "user_text",
          version: 1,
          text: "q",
        });
        checked = true;
        return { version: 1, text: "ok" };
      });
      const s = newSession(repo, T0);
      const m = await post({
        repo,
        sessionId: s,
        text: "q",
        key: crypto.randomUUID(),
        now: T0,
        strategy: "fake-inspect",
      });
      engine.start();
      expect(engine.pump()).toBe(1);
      await settle(engine);
      expect(checked).toBe(true);
      expect(repo.getRun(m.body.run.id).status).toBe("completed");
    } finally {
      await engine.shutdown({ drainMs: 0 });
      closeKernelDatabase(handle);
    }
  });
});

describe("parallel sessions with bounded concurrency", () => {
  it("runs different sessions concurrently and respects maxConcurrency", async () => {
    const { handle, repo } = await openRepo();
    const engine = new RunEngine({
      db: handle.raw,
      repo,
      pollIntervalMs: 5,
      maxConcurrency: 2,
    });
    try {
      const obs = observer();
      const gateA = deferred();
      const gateB = deferred();
      engine.strategies.register(
        "fake-a",
        gatedSuccess(gateA, "a-done", "A", obs),
      );
      engine.strategies.register(
        "fake-b",
        gatedSuccess(gateB, "b-done", "B", obs),
      );
      const sa = newSession(repo, T0);
      const sb = newSession(repo, T0);
      const ma = await post({
        repo,
        sessionId: sa,
        text: "a",
        key: crypto.randomUUID(),
        now: T0,
        strategy: "fake-a",
      });
      const mb = await post({
        repo,
        sessionId: sb,
        text: "b",
        key: crypto.randomUUID(),
        now: T0 + 1,
        strategy: "fake-b",
      });
      engine.start();
      await waitFor(() => obs.entered.length === 2);
      expect(new Set(obs.entered)).toEqual(new Set(["A", "B"]));
      expect(engine.inflightCount()).toBe(2);
      gateA.resolve();
      gateB.resolve();
      await settle(engine);
      expect(repo.getRun(ma.body.run.id).status).toBe("completed");
      expect(repo.getRun(mb.body.run.id).status).toBe("completed");
    } finally {
      await engine.shutdown({ drainMs: 0 });
      closeKernelDatabase(handle);
    }
  });

  it("serializes pickup when maxConcurrency is 1", async () => {
    const { handle, repo } = await openRepo();
    const engine = new RunEngine({
      db: handle.raw,
      repo,
      pollIntervalMs: 5,
      maxConcurrency: 1,
    });
    try {
      const obs = observer();
      const gateA = deferred();
      engine.strategies.register(
        "fake-a",
        gatedSuccess(gateA, "a-done", "A", obs),
      );
      engine.strategies.register("fake-b", immediateSuccess("b-done"));
      const sa = newSession(repo, T0);
      const sb = newSession(repo, T0);
      const ma = await post({
        repo,
        sessionId: sa,
        text: "a",
        key: crypto.randomUUID(),
        now: T0,
        strategy: "fake-a",
      });
      const mb = await post({
        repo,
        sessionId: sb,
        text: "b",
        key: crypto.randomUUID(),
        now: T0 + 1,
        strategy: "fake-b",
      });
      engine.start();
      await waitFor(() => obs.entered.length === 1);
      expect(engine.inflightCount()).toBe(1);
      expect(repo.getRun(mb.body.run.id).status).toBe("queued");
      gateA.resolve();
      await settle(engine);
      expect(repo.getRun(ma.body.run.id).status).toBe("completed");
      expect(repo.getRun(mb.body.run.id).status).toBe("completed");
    } finally {
      await engine.shutdown({ drainMs: 0 });
      closeKernelDatabase(handle);
    }
  });
});

describe("completion/failure through CAS only", () => {
  it("fails runs for unknown strategies and invalid results without raw text", async () => {
    const { handle, repo } = await openRepo();
    const engine = new RunEngine({ db: handle.raw, repo, pollIntervalMs: 5 });
    try {
      engine.strategies.register("fake-bad", invalidResultStrategy());
      engine.strategies.register(
        "fake-throw",
        failingStrategy("execution_failed"),
      );
      const s1 = newSession(repo, T0);
      const s2 = newSession(repo, T0);
      const s3 = newSession(repo, T0);
      const m1 = await post({
        repo,
        sessionId: s1,
        text: "u",
        key: crypto.randomUUID(),
        now: T0,
        strategy: "missing",
      });
      const m2 = await post({
        repo,
        sessionId: s2,
        text: "v",
        key: crypto.randomUUID(),
        now: T0,
        strategy: "fake-bad",
      });
      const m3 = await post({
        repo,
        sessionId: s3,
        text: "w",
        key: crypto.randomUUID(),
        now: T0,
        strategy: "fake-throw",
      });
      engine.start();
      expect(engine.pump()).toBe(3);
      await settle(engine);
      expect(repo.getRun(m1.body.run.id).status).toBe("failed");
      expect(repo.getRun(m1.body.run.id).errorCode).toBe("execution_failed");
      expect(repo.getRun(m2.body.run.id).errorCode).toBe("output_invalid");
      expect(repo.getRun(m3.body.run.id).errorCode).toBe("execution_failed");
      expect(repo.getSelection(m1.body.turnId)).toBeNull();
      expect(eventTypes(handle, m1.body.run.id)).toEqual([
        "run.queued",
        "run.started",
        "run.failed",
      ]);
    } finally {
      await engine.shutdown({ drainMs: 0 });
      closeKernelDatabase(handle);
    }
  });

  it("supports a replaceable strategy registry", async () => {
    const { handle, repo } = await openRepo();
    const engine = new RunEngine({ db: handle.raw, repo, pollIntervalMs: 5 });
    try {
      engine.strategies.register("fake-x", immediateSuccess("v1"));
      engine.strategies.register("fake-x", immediateSuccess("v2"));
      const s = newSession(repo, T0);
      const m = await post({
        repo,
        sessionId: s,
        text: "q",
        key: crypto.randomUUID(),
        now: T0,
        strategy: "fake-x",
      });
      engine.start();
      expect(engine.pump()).toBe(1);
      await settle(engine);
      expect(repo.getRun(m.body.run.id).result).toEqual({
        version: 1,
        text: "v2",
      });
    } finally {
      await engine.shutdown({ drainMs: 0 });
      closeKernelDatabase(handle);
    }
  });
});

describe("cancel: DB commit before abort, cancel-first, late output", () => {
  it("commits cancel_requested before firing AbortSignal", async () => {
    const { handle, repo } = await openRepo();
    const order: string[] = [];
    const wrappedRepo: KernelRepository = {
      ...repo,
      cancelRun: (
        sessionId: string,
        runId: string,
        options?: { now?: number },
      ) => {
        const out = repo.cancelRun(sessionId, runId, options);
        order.push("db-commit");
        return out;
      },
    };
    const engine = new RunEngine({
      db: handle.raw,
      repo: wrappedRepo,
      pollIntervalMs: 5,
    });
    try {
      engine.strategies.register(
        "fake-hang",
        (ctx) =>
          new Promise<never>((_resolve, reject) => {
            ctx.signal.addEventListener(
              "abort",
              () => {
                order.push("abort");
                reject(new Error("aborted"));
              },
              { once: true },
            );
          }),
      );
      const s = newSession(repo, T0);
      const m = await post({
        repo,
        sessionId: s,
        text: "q",
        key: crypto.randomUUID(),
        now: T0,
        strategy: "fake-hang",
      });
      engine.start();
      await waitFor(() => engine.inflightCount() === 1);
      const out = engine.cancel(s, m.body.run.id);
      expect(out.status).toBe("cancel_requested");
      expect(order).toEqual(["db-commit", "abort"]);
      await settle(engine);
      expect(repo.getRun(m.body.run.id).status).toBe("cancelled");
    } finally {
      await engine.shutdown({ drainMs: 0 });
      closeKernelDatabase(handle);
    }
  });

  it("discards late success after cancel_requested; terminal stays final", async () => {
    const { handle, repo } = await openRepo();
    const clock = createFakeClock();
    const engine = new RunEngine({
      db: handle.raw,
      repo,
      clock,
      cancelGraceMs: 3000,
    });
    try {
      const gate = deferred();
      engine.strategies.register("fake-late", async () => {
        await gate.promise;
        return { version: 1, text: "too-late" };
      });
      const s = newSession(repo, T0);
      const m = await post({
        repo,
        sessionId: s,
        text: "q",
        key: crypto.randomUUID(),
        now: T0,
        strategy: "fake-late",
      });
      engine.start();
      expect(engine.pump()).toBe(1);
      await waitFor(() => engine.inflightCount() === 1);
      expect(engine.cancel(s, m.body.run.id).status).toBe("cancel_requested");
      // The strategy resolves AFTER cancel: CAS must discard it.
      gate.resolve();
      await settle(engine);
      clock.advance(3000);
      const run = repo.getRun(m.body.run.id);
      expect(run.status).toBe("cancelled");
      expect(run.result).toBeNull();
      expect(repo.getSelection(m.body.turnId)).toBeNull();
      expect(eventTypes(handle, m.body.run.id)).toEqual([
        "run.queued",
        "run.started",
        "run.cancel_requested",
        "run.cancelled",
      ]);
    } finally {
      await engine.shutdown({ drainMs: 0 });
      closeKernelDatabase(handle);
    }
  });
});

describe("normal-cancel watchdog", () => {
  it("settles cancel_requested no later than the 3000ms default", async () => {
    const { handle, repo } = await openRepo();
    const clock = createFakeClock();
    const engine = new RunEngine({ db: handle.raw, repo, clock });
    try {
      const obs = observer();
      engine.strategies.register("fake-never", neverResolving("N", obs));
      const s = newSession(repo, T0);
      const m = await post({
        repo,
        sessionId: s,
        text: "q",
        key: crypto.randomUUID(),
        now: T0,
        strategy: "fake-never",
      });
      engine.start();
      expect(engine.pump()).toBe(1);
      expect(engine.cancel(s, m.body.run.id).status).toBe("cancel_requested");
      clock.advance(2999);
      expect(repo.getRun(m.body.run.id).status).toBe("cancel_requested");
      clock.advance(1);
      expect(repo.getRun(m.body.run.id).status).toBe("cancelled");
      expect(eventTypes(handle, m.body.run.id)).toEqual([
        "run.queued",
        "run.started",
        "run.cancel_requested",
        "run.cancelled",
      ]);
    } finally {
      await engine.shutdown({ drainMs: 0 });
      closeKernelDatabase(handle);
    }
  });
});

describe("startup recovery", () => {
  it("recovers abandoned/cancelled before pickup and requeues queued", async () => {
    const { handle, repo } = await openRepo();
    const clock = createFakeClock();
    const engine = new RunEngine({ db: handle.raw, repo, clock });
    try {
      engine.strategies.register("fake-ok", immediateSuccess("requeued"));
      const sa = newSession(repo, T0);
      const sb = newSession(repo, T0);
      const sc = newSession(repo, T0);
      const ma = await post({
        repo,
        sessionId: sa,
        text: "a",
        key: crypto.randomUUID(),
        now: T0,
        strategy: "fake-ok",
      });
      const mb = await post({
        repo,
        sessionId: sb,
        text: "b",
        key: crypto.randomUUID(),
        now: T0 + 1,
        strategy: "fake-ok",
      });
      const mc = await post({
        repo,
        sessionId: sc,
        text: "c",
        key: crypto.randomUUID(),
        now: T0 + 2,
        strategy: "fake-ok",
      });
      // Simulate pre-restart state without a running engine.
      repo.startRun(ma.body.run.id, { now: T0 + 3 });
      repo.startRun(mb.body.run.id, { now: T0 + 3 });
      repo.cancelRun(sb, mb.body.run.id, { now: T0 + 4 });
      const recovery = engine.start();
      expect(recovery).toEqual({ abandoned: 1, cancelled: 1 });
      expect(repo.getRun(ma.body.run.id).status).toBe("abandoned");
      expect(repo.getRun(mb.body.run.id).status).toBe("cancelled");
      expect(repo.getRun(mc.body.run.id).status).toBe("queued");
      expect(engine.pump()).toBe(1);
      await settle(engine);
      expect(repo.getRun(mc.body.run.id).status).toBe("completed");
    } finally {
      await engine.shutdown({ drainMs: 0 });
      closeKernelDatabase(handle);
    }
  });
});

describe("graceful drain", () => {
  it("accepts natural completion, sweeps residuals pre-abort, leaves queued, drops late results", async () => {
    const { handle, repo } = await openRepo();
    const clock = createFakeClock();
    const engine = new RunEngine({
      db: handle.raw,
      repo,
      clock,
      maxConcurrency: 3,
      pollIntervalMs: 10,
      cancelGraceMs: 60_000,
    });
    try {
      const obs = observer();
      const gateNatural = deferred();
      const gateLate = deferred();
      engine.strategies.register(
        "fake-natural",
        gatedSuccess(gateNatural, "natural", "natural", obs),
      );
      engine.strategies.register("fake-late", async (ctx) => {
        obs.entered.push("late");
        ctx.signal.addEventListener("abort", () => obs.aborted.push("late"));
        await gateLate.promise;
        return { version: 1, text: "late-write" };
      });
      engine.strategies.register("fake-hang", neverResolving("hang", obs));
      const s1 = newSession(repo, T0);
      const s2 = newSession(repo, T0);
      const s3 = newSession(repo, T0);
      const m1 = await post({
        repo,
        sessionId: s1,
        text: "one",
        key: crypto.randomUUID(),
        now: T0,
        strategy: "fake-natural",
      });
      const m2 = await post({
        repo,
        sessionId: s2,
        text: "two",
        key: crypto.randomUUID(),
        now: T0 + 1,
        strategy: "fake-late",
      });
      const m3 = await post({
        repo,
        sessionId: s3,
        text: "three",
        key: crypto.randomUUID(),
        now: T0 + 2,
        strategy: "fake-hang",
      });
      engine.start();
      expect(engine.pump()).toBe(3);
      await waitFor(() => engine.inflightCount() === 3);
      expect(engine.cancel(s3, m3.body.run.id).status).toBe("cancel_requested");
      // Queued after pickup started: must stay queued through drain.
      const s4 = newSession(repo, T0 + 3);
      const m4 = await post({
        repo,
        sessionId: s4,
        text: "four",
        key: crypto.randomUUID(),
        now: T0 + 3,
        strategy: "fake-natural",
      });
      // Natural completion lands mid-drain via a clock-driven gate.
      clock.setTimeout(() => gateNatural.resolve(), 50);
      const startedAt = clock.now();
      const swept = await engine.shutdown({ drainMs: 500 });
      expect(clock.now() - startedAt <= 500).toBe(true);
      expect(engine.isDraining()).toBe(true);
      expect(swept).toEqual({ abandoned: 1, cancelled: 1 });
      expect(repo.getRun(m1.body.run.id).status).toBe("completed");
      expect(repo.getSelection(m1.body.turnId)?.runId).toBe(m1.body.run.id);
      expect(repo.getRun(m2.body.run.id).status).toBe("abandoned");
      expect(repo.getRun(m3.body.run.id).status).toBe("cancelled");
      expect(repo.getRun(m4.body.run.id).status).toBe("queued");
      expect(eventTypes(handle, m4.body.run.id)).toEqual(["run.queued"]);
      // No pickup once draining, even with free capacity.
      expect(engine.pump()).toBe(0);
      expect(repo.getRun(m4.body.run.id).status).toBe("queued");
      // Late non-cooperative output can never commit after the sweep.
      gateLate.resolve();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(repo.getRun(m2.body.run.id).status).toBe("abandoned");
      expect(repo.getRun(m2.body.run.id).result).toBeNull();
      expect(eventTypes(handle, m2.body.run.id)).toEqual([
        "run.queued",
        "run.started",
        "run.abandoned",
      ]);
      expect(repo.getSelection(m2.body.turnId)).toBeNull();
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
