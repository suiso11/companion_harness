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
import { afterEach, describe, expect, it } from "vitest";
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

  it("admits extraction through the shared background gate and releases it", async () => {
    // Busy gate: another background unit holds the single model slot, so the
    // optional reflection is skipped without calling the gateway.
    const busyRepo = await openRepo();
    const busyGate = createBackgroundResourceGate();
    const held = busyGate.tryAcquire(BACKGROUND_OWNER_MEMORY_EXTRACTION);
    expect(held).not.toBeNull();
    const busy = gatewayReturning(EXTRACTION);
    const skipped = makeService(busyRepo, busy.gateway, busyGate);
    const skippedRun = completeRun(busyRepo, {
      text: "Please use ISO dates when you change calendar events.",
      answer: "Understood. I will use ISO dates.",
    });
    skipped.onRunCompleted(skippedRun.runId);
    await skipped.stop();
    expect(busy.calls).toHaveLength(0);
    busyGate.release(held as Exclude<typeof held, null>);

    // Free gate: extraction runs under a learning lease and releases it, so a
    // subsequent background unit can be admitted.
    const repo = await openRepo();
    const gate = createBackgroundResourceGate();
    const free = gatewayReturning(EXTRACTION);
    const service = makeService(repo, free.gateway, gate);
    const run = completeRun(repo, {
      text: "Please use ISO dates when you change calendar events.",
      answer: "Understood. I will use ISO dates.",
    });
    service.onRunCompleted(run.runId);
    await waitFor(() => free.calls.length === 1);
    await waitFor(() => service.store.listReflections().length === 1);
    const after = gate.tryAcquire(BACKGROUND_OWNER_LEARNING_EXTRACTION);
    expect(after).not.toBeNull();
    expect(after?.owner).toBe(BACKGROUND_OWNER_LEARNING_EXTRACTION);
    if (after !== null) gate.release(after);
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
