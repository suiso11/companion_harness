// Conversation-learning service behavior over a real migrated kernel DB and
// a deterministic fake local gateway. No network, no throwaway server: the
// service itself is the production implementation.
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRunResultV2 } from "@companion/contracts";
import {
  closeKernelDatabase,
  createKernelRepository,
  createLearningStore,
  type KernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
} from "@companion/kernel";
import type { ModelGateway } from "@companion/model-local";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BACKGROUND_OWNER_LEARNING_EXTRACTION,
  BACKGROUND_OWNER_MEMORY_EXTRACTION,
  type BackgroundResourceGate,
  createBackgroundResourceGate,
} from "../src/background_resource.js";
import {
  createLearningService,
  type LearningService,
  parseLearningExtraction,
} from "../src/learning_service.js";

const T0 = 1790000000000;
const dirs: string[] = [];
const services: LearningService[] = [];
const fixtures: Array<() => void> = [];

afterEach(async () => {
  for (const service of services) {
    await service.stop().catch(() => undefined);
  }
  services.length = 0;
  for (const close of fixtures) close();
  fixtures.length = 0;
  while (dirs.length > 0) {
    rmSync(dirs.pop() as string, { recursive: true, force: true });
  }
});

async function openRepo(): Promise<KernelRepository> {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  fixtures.push(() => closeKernelDatabase(handle));
  return createKernelRepository(handle.raw);
}

function tempStore(): string {
  const dir = mkdtempSync(join(tmpdir(), "learning-service-"));
  dirs.push(dir);
  return join(dir, "state", "learning.sqlite");
}

function gatewayReturning(text: string): {
  gateway: ModelGateway;
  calls: unknown[];
} {
  const calls: unknown[] = [];
  return {
    calls,
    gateway: {
      provider: "openai-compatible",
      capabilities: { toolCalling: false },
      baseUrl: "http://127.0.0.1:9",
      chatUrl: "http://127.0.0.1:9/v1/chat/completions",
      chat: async (request) => {
        calls.push(request);
        return { text, toolCalls: [], stopReason: "stop" };
      },
    },
  };
}

function deferredGateway(text: string): {
  gateway: ModelGateway;
  calls: unknown[];
  release: () => void;
} {
  const calls: unknown[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    calls,
    release,
    gateway: {
      provider: "openai-compatible",
      capabilities: { toolCalling: false },
      baseUrl: "http://127.0.0.1:9",
      chatUrl: "http://127.0.0.1:9/v1/chat/completions",
      chat: async (request) => {
        calls.push(request);
        await gate;
        return { text, toolCalls: [], stopReason: "stop" };
      },
    },
  };
}

function makeService(
  repo: KernelRepository,
  gateway: ModelGateway | null,
  background?: BackgroundResourceGate,
): LearningService {
  const service = createLearningService({
    storePath: tempStore(),
    repo,
    gateway,
    model: "extract-model",
    now: () => T0,
    ...(background === undefined ? {} : { background }),
  });
  service.start();
  services.push(service);
  return service;
}

function completeRun(
  repo: KernelRepository,
  input: { text: string; answer: string },
): { sessionId: string; turnId: string; runId: string } {
  const sessionId = repo.createSession({ key: randomUUID(), now: T0 }).body
    .sessionId;
  const posted = repo.postMessage(
    sessionId,
    { text: input.text },
    { key: randomUUID(), now: T0 + 1 },
  );
  const runId = posted.body.run.id;
  const turnId = posted.body.turnId;
  repo.startRun(runId, { now: T0 + 2 });
  const result = buildRunResultV2({
    version: 1,
    parts: [{ text: input.answer, citations: [] }],
  });
  expect(repo.completeRun(runId, result, { now: T0 + 3 }).applied).toBe(true);
  return { sessionId, turnId, runId };
}

async function waitFor(
  condition: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (condition()) return;
    if (Date.now() - started > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Yield one macrotask so already-started async drains settle deterministically. */
function flushTasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const EXTRACTION = JSON.stringify({
  lessons: [
    {
      kind: "user_confirmed_feedback",
      lesson: "Use ISO dates when changing calendar events",
      evidence: "use ISO dates",
      applicability: "calendar date changes",
    },
    {
      kind: "observation",
      lesson: "The assistant acknowledged the correction",
      evidence: "I will use ISO dates",
      applicability: "calendar date changes",
    },
    {
      kind: "user_confirmed_feedback",
      lesson: "Never invent quoted text",
      evidence: "this quote is not in the user message",
      applicability: "any answer",
    },
  ],
});

describe("learning service extraction", () => {
  it("captures only grounded same-turn reflections and keeps them pending", async () => {
    const repo = await openRepo();
    const { gateway, calls } = gatewayReturning(EXTRACTION);
    const service = makeService(repo, gateway);
    const run = completeRun(repo, {
      text: "Please use ISO dates when you change calendar events.",
      answer: "Understood. I will use ISO dates.",
    });
    service.onRunCompleted(run.runId);
    await waitFor(() => service.store.listProposals().length > 0);
    expect(calls).toHaveLength(1);

    const proposals = service.store.listProposals();
    // The assistant-only "observation" is grounded; the fabricated quote is
    // dropped. Both retained items remain pending until human approval.
    expect(proposals).toHaveLength(2);
    expect(proposals.map((row) => row.kind)).toEqual(
      expect.arrayContaining(["user_confirmed_feedback", "observation"]),
    );
    expect(proposals.every((row) => row.status === "pending")).toBe(true);
    expect(
      proposals.find((row) => row.kind === "user_confirmed_feedback")?.lesson,
    ).toBe("Use ISO dates when changing calendar events");
  });

  it("requires evidence to be an exact case- and whitespace-sensitive quote", async () => {
    const repo = await openRepo();
    const exactness = JSON.stringify({
      lessons: [
        {
          kind: "user_confirmed_feedback",
          lesson: "Case changed",
          evidence: "Use ISO dates",
          applicability: "calendar date changes",
        },
        {
          kind: "user_confirmed_feedback",
          lesson: "Whitespace changed",
          evidence: "use  ISO dates",
          applicability: "calendar date changes",
        },
        {
          kind: "observation",
          lesson: "Exact assistant quote",
          evidence: "I will use ISO dates.",
          applicability: "calendar date changes",
        },
      ],
    });
    const { gateway, calls } = gatewayReturning(exactness);
    const service = makeService(repo, gateway);
    const run = completeRun(repo, {
      text: "Please use ISO dates when you change calendar events.",
      answer: "Understood. I will use ISO dates.",
    });
    service.onRunCompleted(run.runId);
    await waitFor(() => service.store.listReflections().length === 1);
    expect(calls).toHaveLength(1);
    expect(service.store.listProposals()).toHaveLength(1);
    expect(service.store.listProposals()[0]?.lesson).toBe(
      "Exact assistant quote",
    );
  });

  it("dedups repeated completion notifications before the gateway call", async () => {
    const repo = await openRepo();
    const deferred = deferredGateway(EXTRACTION);
    const service = makeService(repo, deferred.gateway);
    const run = completeRun(repo, {
      text: "Please use ISO dates when you change calendar events.",
      answer: "Understood. I will use ISO dates.",
    });
    service.onRunCompleted(run.runId);
    service.onRunCompleted(run.runId);
    await waitFor(() => deferred.calls.length === 1);
    deferred.release();
    await waitFor(() => service.store.listProposals().length > 0);
    // A late duplicate after capture is also a no-op.
    service.onRunCompleted(run.runId);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(deferred.calls).toHaveLength(1);
  });

  it("aborts and awaits in-flight extraction on stop", async () => {
    const repo = await openRepo();
    let signal: AbortSignal | undefined;
    const gateway: ModelGateway = {
      provider: "openai-compatible",
      capabilities: { toolCalling: false },
      baseUrl: "http://127.0.0.1:9",
      chatUrl: "http://127.0.0.1:9/v1/chat/completions",
      chat: async (_request, options) =>
        await new Promise((_resolve, reject) => {
          signal = options?.signal;
          options?.signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        }),
    };
    const service = makeService(repo, gateway);
    const run = completeRun(repo, {
      text: "Please use ISO dates when you change calendar events.",
      answer: "Understood. I will use ISO dates.",
    });
    service.onRunCompleted(run.runId);
    await waitFor(() => signal !== undefined);
    await service.stop();
    expect(signal?.aborted).toBe(true);
    // The store was closed only after the aborted task settled; nothing was
    // captured afterwards.
    const probe = createLearningStore({ path: service.store.path });
    try {
      expect(probe.listReflections()).toHaveLength(0);
    } finally {
      probe.close();
    }
  });

  it("retains an accepted turn while memory holds the slot beyond the old retry window", async () => {
    // Regression: the merged implementation retried a busy slot for only
    // 100ms x 20 (about 2s), then dropped the accepted turn even after the
    // legitimate memory lease was released. Valid background work may hold
    // the slot longer than that; only the gate can decide admission.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const repo = await openRepo();
      const gate = createBackgroundResourceGate();
      const held = gate.tryAcquire(BACKGROUND_OWNER_MEMORY_EXTRACTION);
      expect(held).not.toBeNull();
      const deferred = deferredGateway(EXTRACTION);
      const service = makeService(repo, deferred.gateway, gate);
      const run = completeRun(repo, {
        text: "Please use ISO dates when you change calendar events.",
        answer: "Understood. I will use ISO dates.",
      });
      service.onRunCompleted(run.runId);
      // A duplicate while queued must coalesce with the same pending run.
      service.onRunCompleted(run.runId);
      await flushTasks();
      expect(deferred.calls).toHaveLength(0);
      expect(service.store.listReflections()).toHaveLength(0);

      // Hold the legitimate memory lease for 2500ms: past the old bounded
      // retry window, still below the extraction deadline. The accepted turn
      // must stay pending without polling or a gateway call.
      await vi.advanceTimersByTimeAsync(2500);
      await flushTasks();
      expect(deferred.calls).toHaveLength(0);
      expect(service.store.listReflections()).toHaveLength(0);

      gate.release(held as Exclude<typeof held, null>);
      // The release wake starts the one owned drain; the turn is still valid.
      expect(deferred.calls).toHaveLength(1);
      // A duplicate after admission is also a no-op.
      service.onRunCompleted(run.runId);
      await flushTasks();
      expect(deferred.calls).toHaveLength(1);

      deferred.release();
      await flushTasks();
      expect(service.store.listReflections()).toHaveLength(1);
      // The gateway lease was released before capture, so another background
      // unit can be admitted immediately.
      const after = gate.tryAcquire(BACKGROUND_OWNER_LEARNING_EXTRACTION);
      expect(after).not.toBeNull();
      if (after !== null) gate.release(after);
      await service.stop();

      // The reflection is durable across a fresh store handle.
      const probe = createLearningStore({ path: service.store.path });
      try {
        expect(probe.listReflections()).toHaveLength(1);
      } finally {
        probe.close();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-reads selection on wake and never extracts a superseded run", async () => {
    const repo = await openRepo();
    const gate = createBackgroundResourceGate();
    const held = gate.tryAcquire(BACKGROUND_OWNER_MEMORY_EXTRACTION);
    expect(held).not.toBeNull();
    const deferred = deferredGateway(EXTRACTION);
    const service = makeService(repo, deferred.gateway, gate);
    const run = completeRun(repo, {
      text: "Please use ISO dates when you change calendar events.",
      answer: "Understood. I will use ISO dates.",
    });
    service.onRunCompleted(run.runId);
    await flushTasks();
    expect(deferred.calls).toHaveLength(0);

    // Supersede with a retry that completes and becomes the selected run
    // BEFORE the deferred wake is released.
    const retry = repo.postRetry(run.sessionId, run.turnId, {
      key: randomUUID(),
      now: T0 + 10,
    });
    repo.startRun(retry.body.run.id, { now: T0 + 11 });
    repo.completeRun(
      retry.body.run.id,
      buildRunResultV2({
        version: 1,
        parts: [{ text: "Retry answer", citations: [] }],
      }),
      { now: T0 + 12 },
    );

    gate.release(held as Exclude<typeof held, null>);
    await flushTasks();
    expect(deferred.calls).toHaveLength(0);
    expect(service.store.listReflections()).toHaveLength(0);
    await service.stop();

    const probe = createLearningStore({ path: service.store.path });
    try {
      expect(probe.listReflections()).toHaveLength(0);
    } finally {
      probe.close();
    }
  });

  it("drops a queued reflection when the gate closes before release", async () => {
    const repo = await openRepo();
    const gate = createBackgroundResourceGate();
    const held = gate.tryAcquire(BACKGROUND_OWNER_MEMORY_EXTRACTION);
    expect(held).not.toBeNull();
    const { gateway, calls } = gatewayReturning(EXTRACTION);
    const service = makeService(repo, gateway, gate);
    const run = completeRun(repo, {
      text: "Please use ISO dates when you change calendar events.",
      answer: "Understood. I will use ISO dates.",
    });
    service.onRunCompleted(run.runId);
    await flushTasks();
    expect(calls).toHaveLength(0);

    gate.close();
    gate.release(held as Exclude<typeof held, null>);
    await flushTasks();
    expect(calls).toHaveLength(0);
    // Reopening must not revive the run that was queued before the close.
    gate.reopen();
    await flushTasks();
    expect(calls).toHaveLength(0);
    expect(service.store.listReflections()).toHaveLength(0);
    await service.stop();
  });

  it("shutdown drops pending work without a late gateway call or DB touch", async () => {
    const repo = await openRepo();
    const gate = createBackgroundResourceGate();
    const held = gate.tryAcquire(BACKGROUND_OWNER_MEMORY_EXTRACTION);
    expect(held).not.toBeNull();
    const { gateway, calls } = gatewayReturning(EXTRACTION);
    const service = makeService(repo, gateway, gate);
    const run = completeRun(repo, {
      text: "Please use ISO dates when you change calendar events.",
      answer: "Understood. I will use ISO dates.",
    });
    service.onRunCompleted(run.runId);
    await flushTasks();
    await service.stop();

    // The wake was unsubscribed before store close, and the queued run was
    // dropped without touching the closed store.
    gate.release(held as Exclude<typeof held, null>);
    await flushTasks();
    expect(calls).toHaveLength(0);
    const probe = createLearningStore({ path: service.store.path });
    try {
      expect(probe.listReflections()).toHaveLength(0);
    } finally {
      probe.close();
    }
  });

  it("drains multiple queued runs serially with one model call at a time", async () => {
    const repo = await openRepo();
    const rawGate = createBackgroundResourceGate();
    let acquireAttempts = 0;
    const gate: BackgroundResourceGate = {
      tryAcquire(owner) {
        acquireAttempts += 1;
        return rawGate.tryAcquire(owner);
      },
      release: (reservation) => rawGate.release(reservation),
      close: () => rawGate.close(),
      reopen: () => rawGate.reopen(),
      get closed() {
        return rawGate.closed;
      },
      onSettled: (wake) => rawGate.onSettled(wake),
      shutdown: () => rawGate.shutdown(),
    };
    const held = rawGate.tryAcquire(BACKGROUND_OWNER_MEMORY_EXTRACTION);
    expect(held).not.toBeNull();
    let active = 0;
    let maxActive = 0;
    const calls: unknown[] = [];
    const releases: Array<() => void> = [];
    const gateway: ModelGateway = {
      provider: "openai-compatible",
      capabilities: { toolCalling: false },
      baseUrl: "http://127.0.0.1:9",
      chatUrl: "http://127.0.0.1:9/v1/chat/completions",
      async chat(request) {
        calls.push(request);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => {
          releases.push(resolve);
        });
        active -= 1;
        return { text: EXTRACTION, toolCalls: [], stopReason: "stop" };
      },
    };
    const service = makeService(repo, gateway, gate);
    const first = completeRun(repo, {
      text: "Please use ISO dates when you change calendar events.",
      answer: "Understood. I will use ISO dates.",
    });
    const second = completeRun(repo, {
      text: "Please use ISO dates when you change calendar events.",
      answer: "Understood. I will use ISO dates.",
    });
    service.onRunCompleted(first.runId);
    service.onRunCompleted(second.runId);
    // Duplicate notifications while both runs are still queued.
    service.onRunCompleted(first.runId);
    service.onRunCompleted(second.runId);
    await flushTasks();
    // One failed admission for the head of the queue, then no timer/poll spin
    // while the foreign lease is still held.
    const attemptsWhileBusy = acquireAttempts;
    await flushTasks();
    expect(acquireAttempts).toBe(attemptsWhileBusy);
    expect(calls).toHaveLength(0);

    rawGate.release(held as Exclude<typeof held, null>);
    expect(calls).toHaveLength(1);
    expect(active).toBe(1);
    // The second run stays queued while the first model call is in flight.
    await flushTasks();
    expect(calls).toHaveLength(1);
    releases[0]?.();
    await flushTasks();
    expect(calls).toHaveLength(2);
    expect(maxActive).toBe(1);
    releases[1]?.();
    await flushTasks();
    expect(maxActive).toBe(1);
    expect(service.store.listReflections()).toHaveLength(2);
    await service.stop();
  });

  it("does not learn from malformed output or an unavailable gateway", async () => {
    const repo = await openRepo();
    const invalid = makeService(repo, gatewayReturning("not json").gateway);
    const run = completeRun(repo, { text: "hello", answer: "hi" });
    invalid.onRunCompleted(run.runId);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(invalid.store.listReflections()).toHaveLength(0);

    const repo2 = await openRepo();
    const unavailable = makeService(repo2, null);
    const run2 = completeRun(repo2, { text: "hello", answer: "hi" });
    unavailable.onRunCompleted(run2.runId);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(unavailable.store.listReflections()).toHaveLength(0);
  });

  it("never reflects a cancelled or superseded run", async () => {
    const repo = await openRepo();
    const { gateway, calls } = gatewayReturning(EXTRACTION);
    const service = makeService(repo, gateway);

    const sessionId = repo.createSession({ key: randomUUID(), now: T0 }).body
      .sessionId;
    const posted = repo.postMessage(
      sessionId,
      { text: "use ISO dates" },
      { key: randomUUID(), now: T0 + 1 },
    );
    repo.startRun(posted.body.run.id, { now: T0 + 2 });
    repo.cancelRun(sessionId, posted.body.run.id, { now: T0 + 3 });
    service.onRunCompleted(posted.body.run.id);

    const run = completeRun(repo, {
      text: "use ISO dates",
      answer: "Understood",
    });
    // Supersede by a retry that completes and becomes the selected run.
    const retry = repo.postRetry(run.sessionId, run.turnId, {
      key: randomUUID(),
      now: T0 + 10,
    });
    repo.startRun(retry.body.run.id, { now: T0 + 11 });
    repo.completeRun(
      retry.body.run.id,
      buildRunResultV2({
        version: 1,
        parts: [{ text: "Retry answer", citations: [] }],
      }),
      { now: T0 + 12 },
    );
    service.onRunCompleted(run.runId);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(calls).toHaveLength(0);
    expect(service.store.listReflections()).toHaveLength(0);
  });
});

describe("learning prompt budget and provider thinking", () => {
  it("sends reasoning off on the extraction request", async () => {
    const repo = await openRepo();
    const { gateway, calls } = gatewayReturning(EXTRACTION);
    const service = makeService(repo, gateway);
    const run = completeRun(repo, {
      text: "Please use ISO dates when you change calendar events.",
      answer: "Understood. I will use ISO dates.",
    });
    service.onRunCompleted(run.runId);
    await waitFor(() => calls.length > 0);
    expect((calls[0] as { reasoning?: string }).reasoning).toBe("off");
  });

  it("records applications only for lessons kept by the prompt budget", async () => {
    const repo = await openRepo();
    // Three grounded lessons at the field caps render past formatLessonPromptBlock's
    // 4096-character limit, so exactly the last one is dropped.
    const quote = `I will use ISO dates ${"z".repeat(470)}`;
    const applicability = `calendar date changes ${"y".repeat(270)}`;
    const lessons = [1, 2, 3].map((index) => ({
      kind: "observation",
      lesson: `calendar lesson ${index} ${"x".repeat(480)}`,
      evidence: quote,
      applicability,
    }));
    const { gateway } = gatewayReturning(JSON.stringify({ lessons }));
    const service = makeService(repo, gateway);
    const run = completeRun(repo, {
      text: "Please use ISO dates when you change calendar events.",
      answer: `Understood. ${quote}`,
    });
    service.onRunCompleted(run.runId);
    await waitFor(() => service.store.listProposals().length === 3);
    const proposals = service.store.listProposals();
    for (const proposal of proposals) {
      service.store.approve(proposal.id, proposal.contentHash);
    }
    const signal = new AbortController().signal;
    const returned = await service.recallHook.recall({
      sessionId: run.sessionId,
      runId: "run-budget",
      query: "calendar date change",
      signal,
    });
    expect(returned).toHaveLength(2);
    const applications = service.store.listApplications(run.sessionId);
    expect(applications).toHaveLength(returned.length);
    expect(applications.map((row) => row.proposalId).sort()).toEqual(
      returned.map((row) => row.id).sort(),
    );
  });
});

describe("learning retrieval", () => {
  it("returns approved relevant same-session lessons only", async () => {
    const repo = await openRepo();
    const { gateway } = gatewayReturning(EXTRACTION);
    const service = makeService(repo, gateway);
    const run = completeRun(repo, {
      text: "Please use ISO dates when you change calendar events.",
      answer: "Understood. I will use ISO dates.",
    });
    service.onRunCompleted(run.runId);
    await waitFor(() => service.store.listProposals().length > 0);
    const approved = service.store.listProposals()[0];
    service.store.approve(
      approved?.id as string,
      approved?.contentHash as string,
    );

    const signal = new AbortController().signal;
    const relevant = await service.recallHook.recall({
      sessionId: run.sessionId,
      runId: "run-next",
      query: "How do I change a calendar event date?",
      signal,
    });
    expect(relevant).toHaveLength(1);
    expect(relevant[0]?.lesson).toBe(approved?.lesson);
    expect(relevant[0]?.evidence).toBe(approved?.evidence);
    expect(relevant[0]?.provenance).toContain(run.runId);
    expect(service.store.listApplications(run.sessionId)).toHaveLength(1);

    const unrelated = await service.recallHook.recall({
      sessionId: run.sessionId,
      runId: "run-joke",
      query: "Tell me a joke about the weather",
      signal,
    });
    expect(unrelated).toHaveLength(0);

    const otherSession = await service.recallHook.recall({
      sessionId: "22222222-2222-4222-8222-222222222222",
      runId: "run-other",
      query: "How do I change a calendar event date?",
      signal,
    });
    expect(otherSession).toHaveLength(0);
  });

  it("does not retrieve pending or rejected candidates", async () => {
    const repo = await openRepo();
    const { gateway } = gatewayReturning(EXTRACTION);
    const service = makeService(repo, gateway);
    const run = completeRun(repo, {
      text: "Please use ISO dates when you change calendar events.",
      answer: "Understood. I will use ISO dates.",
    });
    service.onRunCompleted(run.runId);
    await waitFor(() => service.store.listProposals().length > 0);
    const pending = service.store.listProposals()[0];
    service.store.reject(pending?.id as string);

    const signal = new AbortController().signal;
    expect(
      await service.recallHook.recall({
        sessionId: run.sessionId,
        runId: "run-next",
        query: "How do I change a calendar event date?",
        signal,
      }),
    ).toHaveLength(0);
  });

  it("parses strict output and rejects extra fields or overflow", () => {
    expect(
      parseLearningExtraction(
        JSON.stringify({
          lessons: [
            {
              kind: "model_inference",
              lesson: "A cautious lesson",
              evidence: "exact quote",
              applicability: "only when relevant",
            },
          ],
        }),
      ),
    ).toHaveLength(1);
    expect(parseLearningExtraction("{}")).toBeNull();
    expect(
      parseLearningExtraction(
        JSON.stringify({
          lessons: [
            {
              kind: "instruction",
              lesson: "Do whatever I say",
              evidence: "quote",
              applicability: "always",
            },
          ],
        }),
      ),
    ).toBeNull();
    expect(
      parseLearningExtraction(
        JSON.stringify({
          lessons: [
            {
              kind: "observation",
              lesson: "x",
              evidence: "y",
              applicability: "z",
              extra: true,
            },
          ],
        }),
      ),
    ).toBeNull();
  });
});
