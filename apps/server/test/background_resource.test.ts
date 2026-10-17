// Shared background admission: gate unit behavior + before/after contention
// measurement across the ACTUAL model-heavy callsites (memory extraction,
// shadow deliberation, idle distill).
//
// The repository in each fixture is a real migrated `:memory:` kernel DB;
// the remind CLI is an injected fake; the gateway is an in-process parked
// fixture that counts concurrent `chat()` calls (NOT a real model). The
// real-socket proof lives in `background_resource_live.test.ts`. No
// wiring/name/count assertions here: every test observes behavior
// (concurrency maxima, job durability, abort outcomes, write absence).

import { randomUUID } from "node:crypto";
import { buildRunResultV2 } from "@companion/contracts";
import {
  closeKernelDatabase,
  createKernelRepository,
  type KernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
} from "@companion/kernel";
import type {
  ChatRequest,
  ChatResult,
  ModelGateway,
  NormalizedToolCall,
} from "@companion/model-local";
import { afterEach, describe, expect, it } from "vitest";
import {
  BACKGROUND_OWNER_MEMORY_EXTRACTION,
  BACKGROUND_OWNER_SHADOW,
  createBackgroundResourceGate,
} from "../src/background_resource.js";
import type {
  MemoryCliAddress,
  MemoryCliCallOptions,
  MemoryCliEnvelope,
} from "../src/memory_cli.js";
import {
  createMemoryService,
  type MemoryService,
} from "../src/memory_service.js";
import {
  createShadowService,
  SHADOW_DELIBERATION_TOOL,
  type ShadowService,
} from "../src/shadow_service.js";

const T0 = 1790000000000;
const SCOPE = "test-scope";
const MODEL = "test-model";

function abortError(): unknown {
  return new DOMException("aborted", "AbortError");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  condition: () => boolean,
  timeoutMs = 8000,
): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (condition()) {
      return;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error("waitFor timed out waiting for service state");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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

type CliCall = (
  address: MemoryCliAddress,
  op: string,
  params: Record<string, unknown>,
  idempotencyKey: string | undefined,
  options?: MemoryCliCallOptions,
) => Promise<MemoryCliEnvelope>;

function okEnvelope(data: Record<string, unknown> | null): MemoryCliEnvelope {
  return { ok: true, code: "OK", data, deduplicated: false };
}

const memoryServices: MemoryService[] = [];
const shadowServices: ShadowService[] = [];

afterEach(async () => {
  for (const service of shadowServices.splice(0)) {
    await service.stop().catch(() => undefined);
  }
  for (const service of memoryServices.splice(0)) {
    await service.stop().catch(() => undefined);
  }
});

function makeMemoryService(
  repo: KernelRepository,
  cliCall: CliCall,
  extra: {
    gateway?: ModelGateway | null;
    idleMs?: number;
    background?: ReturnType<typeof createBackgroundResourceGate> | null;
  } = {},
): MemoryService {
  const service = createMemoryService({
    address: {
      executable: "/bin/true",
      entry: "/cli.js",
      config: "/mem.json",
      timeoutMs: 30_000,
      maxResponseBytes: 65536,
    },
    scope: SCOPE,
    recallLimit: 5,
    idleMs: extra.idleMs ?? 300_000,
    repo,
    gateway: extra.gateway ?? null,
    model: MODEL,
    cliCall,
    ...(extra.background !== undefined ? { background: extra.background } : {}),
  });
  memoryServices.push(service);
  return service;
}

function makeShadowService(
  repo: KernelRepository,
  gateway: ModelGateway | null,
  extra: {
    background?: ReturnType<typeof createBackgroundResourceGate> | null;
  } = {},
): ShadowService {
  const service = createShadowService({
    repo,
    gateway,
    model: MODEL,
    recall: null,
    now: () => Date.now(),
    ...(extra.background !== undefined ? { background: extra.background } : {}),
  });
  shadowServices.push(service);
  service.start();
  return service;
}

/** Post, start, and durably complete one V2 run; returns its ids. */
function completeV2Run(
  repo: KernelRepository,
  text = "hello",
): { sessionId: string; turnId: string; runId: string } {
  const sessionId = repo.createSession({ key: randomUUID(), now: T0 }).body
    .sessionId;
  const posted = repo.postMessage(
    sessionId,
    { text },
    { key: randomUUID(), now: T0 + 1 },
  );
  const runId = posted.body.run.id;
  const turnId = posted.body.turnId;
  repo.startRun(runId, { now: T0 + 2 });
  const result = buildRunResultV2({
    version: 1,
    parts: [{ text: "answered", citations: [] }],
  });
  expect(repo.completeRun(runId, result, { now: T0 + 3 }).applied).toBe(true);
  return { sessionId, turnId, runId };
}

function pauseControl(repo: KernelRepository): void {
  const version = repo.getAutonomyControlState().version;
  repo.setAutonomyControlState(
    { paused: true, expectedVersion: version },
    { key: randomUUID(), now: T0 + 100 },
  );
}

function unpauseControl(repo: KernelRepository): void {
  const version = repo.getAutonomyControlState().version;
  repo.setAutonomyControlState(
    { paused: false, expectedVersion: version },
    { key: randomUUID(), now: T0 + 100 },
  );
}

function requestShadowJob(repo: KernelRepository, sessionId: string): void {
  repo.createAutonomyPurpose(
    sessionId,
    {
      scope: "health",
      statement: "walk daily",
      kind: "goal",
      explicit: true,
      sourceKind: "user",
    },
    { key: randomUUID(), now: T0 + 20 },
  );
}

function deliberationResult(): ChatResult {
  const call: NormalizedToolCall = {
    id: "shadow-call-1",
    name: SHADOW_DELIBERATION_TOOL,
    arguments: {
      decision: "do-nothing",
      evidenceIds: ["sP1"],
      reason: "nothing to do yet",
      proposedAction: null,
      completion: "none required",
      stopConditions: ["any new constraint appears"],
      uncertainty: "low",
      counterargument: "waiting could miss a window",
    },
  };
  return { text: "", toolCalls: [call], stopReason: "tool_calls" };
}

function extractionResult(): ChatResult {
  return {
    text: JSON.stringify({
      memories: [{ body: "user likes tea", kind: "user_fact" }],
    }),
    toolCalls: [],
    stopReason: "stop",
  };
}

type ParkKind = "extract" | "shadow";

/**
 * Shared parked gateway fixture: counts concurrent in-flight `chat()`
 * calls across BOTH background callsites and parks scripted kinds until
 * the test releases them (abort-aware, like a real socket closing).
 */
function makeContentionGateway() {
  const state = {
    current: 0,
    max: 0,
    parkExtract: true,
    parkShadow: true,
    aborted: [] as ParkKind[],
    releases: [] as Array<{
      kind: ParkKind;
      resolve: (result: ChatResult) => void;
    }>,
  };
  const classify = (request: ChatRequest): ParkKind | "other" => {
    const names = (request.tools ?? []).map((tool) => tool.name);
    if (names.includes(SHADOW_DELIBERATION_TOOL)) {
      return "shadow";
    }
    const system = request.messages[0]?.content ?? "";
    if (system.startsWith("Extract durable memories")) {
      return "extract";
    }
    return "other";
  };
  const gateway: ModelGateway = {
    provider: "openai-compatible",
    capabilities: { toolCalling: true },
    baseUrl: "http://127.0.0.1:1",
    chatUrl: "http://127.0.0.1:1/v1/chat/completions",
    chat: async (
      request: ChatRequest,
      options?: { signal?: AbortSignal },
    ): Promise<ChatResult> => {
      const kind = classify(request);
      state.current += 1;
      state.max = Math.max(state.max, state.current);
      const signal = options?.signal;
      const isAborted = (): boolean => signal?.aborted === true;
      try {
        if (isAborted()) {
          if (kind !== "other") {
            state.aborted.push(kind);
          }
          throw abortError();
        }
        const park =
          (kind === "extract" && state.parkExtract) ||
          (kind === "shadow" && state.parkShadow);
        if (park) {
          const parkKind = kind as ParkKind;
          await new Promise<void>((resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => {
                state.aborted.push(parkKind);
                reject(abortError());
              },
              { once: true },
            );
            state.releases.push({
              kind: parkKind,
              resolve: () => resolve(),
            });
          });
        }
        if (isAborted()) {
          if (kind !== "other") {
            state.aborted.push(kind);
          }
          throw abortError();
        }
        if (kind === "shadow") {
          return deliberationResult();
        }
        return extractionResult();
      } finally {
        state.current -= 1;
      }
    },
  } as unknown as ModelGateway;
  return {
    gateway,
    state,
    releaseKind: (kind: ParkKind): void => {
      const index = state.releases.findIndex((entry) => entry.kind === kind);
      if (index >= 0) {
        const [entry] = state.releases.splice(index, 1);
        entry?.resolve(deliberationResult());
      }
    },
    releaseAll: (): void => {
      for (const entry of state.releases.splice(0)) {
        entry.resolve(
          entry.kind === "shadow" ? deliberationResult() : extractionResult(),
        );
      }
    },
  };
}

async function settleShadow(
  service: ShadowService,
  timeoutMs = 8000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (!service.busy) {
      await sleep(10);
      if (!service.busy) {
        return;
      }
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error("shadow service did not settle");
    }
    await sleep(5);
  }
}

describe("background admission gate (unit)", () => {
  it("admits one owner; a second contender sees busy until release", () => {
    const gate = createBackgroundResourceGate();
    const first = gate.tryAcquire(BACKGROUND_OWNER_MEMORY_EXTRACTION);
    expect(first).not.toBeNull();
    expect(gate.tryAcquire(BACKGROUND_OWNER_SHADOW)).toBeNull();
    gate.release(first as NonNullable<typeof first>);
    const second = gate.tryAcquire(BACKGROUND_OWNER_SHADOW);
    expect(second).not.toBeNull();
    gate.release(second as NonNullable<typeof second>);
  });

  it("a stale owner can never release a newer lease", () => {
    const gate = createBackgroundResourceGate();
    const first = gate.tryAcquire(BACKGROUND_OWNER_SHADOW);
    expect(first).not.toBeNull();
    gate.release(first as NonNullable<typeof first>);
    const second = gate.tryAcquire(BACKGROUND_OWNER_MEMORY_EXTRACTION);
    expect(second).not.toBeNull();
    // Stale replay of the first reservation frees nothing.
    gate.release(first as NonNullable<typeof first>);
    expect(gate.tryAcquire(BACKGROUND_OWNER_SHADOW)).toBeNull();
    gate.release(second as NonNullable<typeof second>);
    expect(gate.tryAcquire(BACKGROUND_OWNER_SHADOW)).not.toBeNull();
  });

  it("close blocks admission; reopen admits; shutdown clears wakes", () => {
    const gate = createBackgroundResourceGate();
    let wakes = 0;
    const unsubscribe = gate.onSettled(() => {
      wakes += 1;
    });
    gate.close();
    expect(gate.closed).toBe(true);
    expect(gate.tryAcquire(BACKGROUND_OWNER_SHADOW)).toBeNull();
    gate.reopen();
    const lease = gate.tryAcquire(BACKGROUND_OWNER_SHADOW);
    expect(lease).not.toBeNull();
    gate.release(lease as NonNullable<typeof lease>);
    expect(wakes).toBe(1);
    unsubscribe();
    gate.shutdown();
    expect(gate.closed).toBe(true);
    expect(gate.tryAcquire(BACKGROUND_OWNER_SHADOW)).toBeNull();
    // A release after shutdown frees the hold but fires no cleared wake.
    const held = createBackgroundResourceGate();
    let cleared = 0;
    held.onSettled(() => {
      cleared += 1;
    });
    const lease2 = held.tryAcquire(BACKGROUND_OWNER_SHADOW);
    held.shutdown();
    held.release(lease2 as NonNullable<typeof lease2>);
    expect(cleared).toBe(0);
  });

  it("one release wakes each subscriber once; a throwing wake breaks nothing", () => {
    const gate = createBackgroundResourceGate();
    const seen: string[] = [];
    gate.onSettled(() => {
      seen.push("a");
    });
    gate.onSettled(() => {
      throw new Error("wake must never break release");
    });
    gate.onSettled(() => {
      seen.push("b");
    });
    const lease = gate.tryAcquire(BACKGROUND_OWNER_SHADOW);
    gate.release(lease as NonNullable<typeof lease>);
    expect(seen).toEqual(["a", "b"]);
  });
});

describe("background contention across actual callsites", () => {
  it("BEFORE (no gate): extraction and shadow overlap at concurrency 2", async () => {
    const memory = await openRepo();
    const shadowDb = await openRepo();
    try {
      const contention = makeContentionGateway();
      const ops: string[] = [];
      const cliCall: CliCall = async (_address, op) => {
        ops.push(op);
        return okEnvelope(null);
      };
      const memoryService = makeMemoryService(memory.repo, cliCall, {
        gateway: contention.gateway,
      });
      memoryService.start();
      const shadowService = makeShadowService(
        shadowDb.repo,
        contention.gateway,
      );
      unpauseControl(shadowDb.repo);
      const sessionId = shadowDb.repo.createSession({
        key: randomUUID(),
        now: T0,
      }).body.sessionId;
      requestShadowJob(shadowDb.repo, sessionId);

      const run = completeV2Run(memory.repo);
      memoryService.onRunCompleted(run.runId);
      await waitFor(() => contention.state.current >= 1);
      shadowService.wake();
      // Both background units park at once: the legacy shape overlaps.
      await waitFor(() => contention.state.current >= 2);
      expect(contention.state.max).toBeGreaterThanOrEqual(2);
      contention.releaseAll();
      await settleShadow(shadowService);
      await waitFor(() => ops.includes("event.append"));
    } finally {
      memory.close();
      shadowDb.close();
    }
  });

  it("AFTER (shared gate): max concurrency 1, busy job defers pending then completes", async () => {
    const memory = await openRepo();
    const shadowDb = await openRepo();
    try {
      const gate = createBackgroundResourceGate();
      const contention = makeContentionGateway();
      const ops: string[] = [];
      const cliCall: CliCall = async (_address, op) => {
        ops.push(op);
        return okEnvelope(null);
      };
      const memoryService = makeMemoryService(memory.repo, cliCall, {
        gateway: contention.gateway,
        background: gate,
      });
      memoryService.start();
      const shadowService = makeShadowService(
        shadowDb.repo,
        contention.gateway,
        {
          background: gate,
        },
      );
      unpauseControl(shadowDb.repo);
      const sessionId = shadowDb.repo.createSession({
        key: randomUUID(),
        now: T0,
      }).body.sessionId;
      requestShadowJob(shadowDb.repo, sessionId);

      // Extraction parks FIRST and holds the gate.
      const run = completeV2Run(memory.repo);
      memoryService.onRunCompleted(run.runId);
      await waitFor(
        () =>
          contention.state.current === 1 &&
          contention.state.releases.some((entry) => entry.kind === "extract"),
      );
      // The shadow candidate now contends: it must DEFER BEFORE claim —
      // never a second concurrent call, never claimed-then-starved.
      shadowService.wake();
      await sleep(300);
      expect(contention.state.max).toBe(1);
      const jobs = shadowDb.repo.listShadowJobs(sessionId, { limit: 10 });
      expect(jobs.items).toHaveLength(1);
      expect(jobs.items[0]?.status).toBe("pending");

      // Release the extraction: it completes, frees the gate, and the
      // single release-wake re-drives the eligible shadow job (which parks
      // alone), then completes after its own release.
      contention.releaseKind("extract");
      await waitFor(() =>
        contention.state.releases.some((entry) => entry.kind === "shadow"),
      );
      expect(contention.state.max).toBe(1);
      contention.releaseKind("shadow");
      await settleShadow(shadowService);
      const done = shadowDb.repo.listShadowJobs(sessionId, { limit: 10 });
      expect(done.items[0]?.status).toBe("completed");
      expect(contention.state.max).toBe(1);
      // The extraction's durable outbox was never lost behind admission.
      await waitFor(() => ops.includes("event.append"));
    } finally {
      memory.close();
      shadowDb.close();
    }
  });

  it("a throwing shadow job releases the gate (no wedged lease)", async () => {
    const shadowDb = await openRepo();
    try {
      const gate = createBackgroundResourceGate();
      const throwing: ModelGateway = {
        provider: "openai-compatible",
        capabilities: { toolCalling: true },
        baseUrl: "http://127.0.0.1:1",
        chatUrl: "http://127.0.0.1:1/v1/chat/completions",
        chat: async (): Promise<ChatResult> => {
          throw new Error("provider down");
        },
      } as unknown as ModelGateway;
      const shadowService = makeShadowService(shadowDb.repo, throwing, {
        background: gate,
      });
      unpauseControl(shadowDb.repo);
      const sessionId = shadowDb.repo.createSession({
        key: randomUUID(),
        now: T0,
      }).body.sessionId;
      requestShadowJob(shadowDb.repo, sessionId);
      shadowService.wake();
      await settleShadow(shadowService);
      const jobs = shadowDb.repo.listShadowJobs(sessionId, { limit: 10 });
      expect(jobs.items[0]?.status).toBe("failed");
      // The failed unit released: a fresh contender admits immediately.
      expect(
        gate.tryAcquire(BACKGROUND_OWNER_MEMORY_EXTRACTION),
      ).not.toBeNull();
    } finally {
      shadowDb.close();
    }
  });

  it("foreground activity aborts a parked extraction; late output never writes", async () => {
    const memory = await openRepo();
    try {
      const contention = makeContentionGateway();
      const ops: string[] = [];
      const cliCall: CliCall = async (_address, op) => {
        ops.push(op);
        return okEnvelope(null);
      };
      const memoryService = makeMemoryService(memory.repo, cliCall, {
        gateway: contention.gateway,
        background: createBackgroundResourceGate(),
      });
      memoryService.start();
      const run = completeV2Run(memory.repo);
      memoryService.onRunCompleted(run.runId);
      await waitFor(() => contention.state.current >= 1);
      // A newly starting foreground prompt aborts OUR OWN parked call.
      memoryService.notifyForeground();
      await waitFor(() => contention.state.aborted.includes("extract"));
      // Even though the provider would answer late, the late output is
      // discarded: release the park and prove no memory write lands.
      contention.releaseAll();
      await sleep(300);
      expect(ops.includes("event.append")).toBe(false);
      expect(memory.repo.countPendingMemoryJobs(Date.now())).toBe(0);
    } finally {
      memory.close();
    }
  });

  it("STOP closes admission and aborts extraction; resume reopens honestly", async () => {
    const memory = await openRepo();
    try {
      const gate = createBackgroundResourceGate();
      const contention = makeContentionGateway();
      contention.state.parkExtract = false;
      const ops: string[] = [];
      const cliCall: CliCall = async (_address, op) => {
        ops.push(op);
        return okEnvelope(null);
      };
      const memoryService = makeMemoryService(memory.repo, cliCall, {
        gateway: contention.gateway,
        background: gate,
      });
      memoryService.start();
      pauseControl(memory.repo);
      memoryService.notifyControl();
      expect(gate.closed).toBe(true);
      // A completion while STOPped skips extraction with no write and no
      // claim on the gate — the durable anchor remains for later idle work.
      const run = completeV2Run(memory.repo);
      memoryService.onRunCompleted(run.runId);
      await sleep(300);
      expect(memory.repo.countPendingMemoryJobs(Date.now())).toBe(0);
      // Resume reopens: a new completion cultivates normally again.
      unpauseControl(memory.repo);
      memoryService.notifyControl();
      expect(gate.closed).toBe(false);
      const run2 = completeV2Run(memory.repo);
      memoryService.onRunCompleted(run2.runId);
      await waitFor(() => ops.includes("event.append"));
    } finally {
      memory.close();
    }
  });

  it("idle distill defers while the gate is held; foreground recall ignores the gate", async () => {
    const memory = await openRepo();
    try {
      const gate = createBackgroundResourceGate();
      const ops: string[] = [];
      const cliCall: CliCall = async (_address, op, _params) => {
        ops.push(op);
        if (op === "record.recall") {
          return okEnvelope({
            recallId: "recall-1",
            items: [{ id: "record-1", snippet: "foreground snippet" }],
          });
        }
        return okEnvelope(null);
      };
      const memoryService = makeMemoryService(memory.repo, cliCall, {
        idleMs: 50,
        background: gate,
      });
      // An external background holder occupies the gate.
      const held = gate.tryAcquire(BACKGROUND_OWNER_SHADOW);
      expect(held).not.toBeNull();
      const run = completeV2Run(memory.repo);
      memoryService.start();
      memoryService.onRunCompleted(run.runId);
      // Idle ticks fire but the distill drain never claims the CLI while
      // held: no maintain.distill execution, no loss (anchor persists).
      await sleep(400);
      expect(ops.includes("maintain.distill")).toBe(false);
      gate.release(held as NonNullable<typeof held>);
      // Foreground recall never consults the gate: it answers even while
      // STOPped and closed.
      pauseControl(memory.repo);
      gate.close();
      const controller = new AbortController();
      const items = await memoryService.recallHook.recall(
        "tea",
        controller.signal,
      );
      expect(items).toHaveLength(1);
      gate.reopen();
    } finally {
      memory.close();
    }
  });
});
