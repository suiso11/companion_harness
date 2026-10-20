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
      memories: [
        { body: "user likes tea", kind: "summary" },
        { body: "user likes tea", kind: "user_fact" },
      ],
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
    if (system.startsWith("Extract memories from the conversation")) {
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

  it("I03-09: paused autonomy keeps memory admission open; a paused turn still cultivates", async () => {
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
      // Committed autonomy pause: memory admission stays OPEN (memory
      // writes and cultivation are autonomous, no-approval work).
      pauseControl(memory.repo);
      expect(gate.closed).toBe(false);
      // A completion while paused cultivates normally: extraction runs,
      // and the durable write pipeline (append -> remember) progresses.
      const run = completeV2Run(memory.repo);
      memoryService.onRunCompleted(run.runId);
      await waitFor(() => ops.includes("event.append"));
      // The remember fan-out lands after the event ack (same stable-key
      // chain); one more bounded drain tick executes it — still paused.
      await memoryService.drainOnce();
      expect(ops.includes("record.remember")).toBe(true);
    } finally {
      memory.close();
    }
  });

  it("shutdown closes admission and extraction skips; reopen admits honestly", async () => {
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
      // Shutdown closes the gate: a completion while closed skips
      // extraction with no write and no claim on the gate — the durable
      // anchor remains for later idle work.
      gate.close();
      expect(gate.closed).toBe(true);
      const run = completeV2Run(memory.repo);
      memoryService.onRunCompleted(run.runId);
      await sleep(300);
      expect(memory.repo.countPendingMemoryJobs(Date.now())).toBe(0);
      // Reopen: a new completion cultivates normally again.
      gate.reopen();
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

describe("P1 review fixes: automatic-distill admission boundary", () => {
  function parkingCli(state: {
    parked: boolean;
    calls: string[];
    releases: Array<() => void>;
  }): CliCall {
    return async (_address, op, _params, _key, options) => {
      state.calls.push(op);
      if (op === "maintain.distill" && state.parked) {
        await new Promise<void>((resolve, reject) => {
          const signal = options?.signal;
          if (signal?.aborted === true) {
            reject(abortError());
            return;
          }
          signal?.addEventListener(
            "abort",
            () => {
              reject(abortError());
            },
            { once: true },
          );
          state.releases.push(() => resolve());
        });
      }
      return okEnvelope(null);
    };
  }

  function enqueueDistill(repo: KernelRepository): string {
    const sessionId = repo.createSession({ key: randomUUID(), now: T0 }).body
      .sessionId;
    const posted = repo.postMessage(
      sessionId,
      { text: "tea" },
      { key: randomUUID(), now: T0 + 1 },
    );
    const runId = posted.body.run.id;
    const { row } = repo.enqueueMemoryJob(
      "maintain.distill",
      sessionId,
      runId,
      SCOPE,
      randomUUID(),
      JSON.stringify({
        op: "maintain.distill",
        params: { scope: SCOPE, cursor: null, limit: 20, runId: null },
      }),
      { now: T0 + 2 },
    );
    return row.id;
  }

  function enqueueRetire(repo: KernelRepository): string {
    const sessionId = repo.createSession({ key: randomUUID(), now: T0 }).body
      .sessionId;
    const posted = repo.postMessage(
      sessionId,
      { text: "tea" },
      { key: randomUUID(), now: T0 + 1 },
    );
    const runId = posted.body.run.id;
    const { row } = repo.enqueueMemoryJob(
      "record.retire",
      sessionId,
      runId,
      SCOPE,
      randomUUID(),
      JSON.stringify({
        op: "record.retire",
        params: { id: "rec-1", scope: SCOPE, reasonCode: "USER_REQUESTED" },
      }),
      { now: T0 + 2 },
    );
    return row.id;
  }

  it("BEFORE (reported fault): shutdown while a distill CLI child is parked must abort it and keep it durable", async () => {
    const memory = await openRepo();
    try {
      const gate = createBackgroundResourceGate();
      const parking = {
        parked: true,
        calls: [] as string[],
        releases: [] as Array<() => void>,
      };
      const memoryService = makeMemoryService(
        memory.repo,
        parkingCli(parking),
        {
          idleMs: 300_000,
          background: gate,
        },
      );
      const distillId = enqueueDistill(memory.repo);
      const tick = memoryService.drainOnce();
      await waitFor(() => parking.calls.includes("maintain.distill"));
      // Shutdown with no other chat anywhere: aborts the background-owned
      // CLI child (not the whole tick) and closes admission.
      gate.close();
      await memoryService.stop();
      await tick;
      const distill = memory.repo.getMemoryJob(distillId);
      // Durable pending (existing preempted path), never acked, never failed.
      expect(distill?.status).toBe("pending");
    } finally {
      memory.close();
    }
  });

  it("AFTER: explicit work drains while shutdown-closed; distill skips untouched (no attempt poisoning, no head-of-line)", async () => {
    const memory = await openRepo();
    try {
      const gate = createBackgroundResourceGate();
      const parking = {
        parked: false,
        calls: [] as string[],
        releases: [] as Array<() => void>,
      };
      const memoryService = makeMemoryService(
        memory.repo,
        parkingCli(parking),
        {
          idleMs: 300_000,
          background: gate,
        },
      );
      const distillId = enqueueDistill(memory.repo);
      const retireId = enqueueRetire(memory.repo);
      // Shutdown BEFORE the drain: the whole tick used to strand everything.
      gate.close();
      expect(gate.closed).toBe(true);
      const out = await memoryService.drainOnce();
      // The explicit retire executed in the SAME tick the distill skipped.
      expect(out.executed).toBe(1);
      expect(parking.calls).toEqual(["record.retire"]);
      expect(memory.repo.getMemoryJob(retireId)?.status).toBe("acked");
      // The automatic distill is skipped WITHOUT a state touch: still
      // pending with attempts unchanged (no busy-fail, no backoff poison).
      const distill = memory.repo.getMemoryJob(distillId);
      expect(distill?.status).toBe("pending");
      expect(distill?.attempts).toBe(0);
      // Reopen: the SAME distill id drains normally (no duplicate).
      gate.reopen();
      expect(gate.closed).toBe(false);
      await memoryService.drainOnce();
      expect(memory.repo.getMemoryJob(distillId)?.status).toBe("acked");
      expect(parking.calls).toEqual(["record.retire", "maintain.distill"]);
    } finally {
      memory.close();
    }
  });

  it("AFTER: a held gate defers distill but never the explicit job behind it (busy path)", async () => {
    const memory = await openRepo();
    try {
      const gate = createBackgroundResourceGate();
      const parking = {
        parked: false,
        calls: [] as string[],
        releases: [] as Array<() => void>,
      };
      const memoryService = makeMemoryService(
        memory.repo,
        parkingCli(parking),
        {
          idleMs: 300_000,
          background: gate,
        },
      );
      const distillId = enqueueDistill(memory.repo);
      const retireId = enqueueRetire(memory.repo);
      const held = gate.tryAcquire(BACKGROUND_OWNER_SHADOW);
      expect(held).not.toBeNull();
      const out = await memoryService.drainOnce();
      expect(out.executed).toBe(1);
      expect(parking.calls).toEqual(["record.retire"]);
      expect(memory.repo.getMemoryJob(retireId)?.status).toBe("acked");
      const distill = memory.repo.getMemoryJob(distillId);
      expect(distill?.status).toBe("pending");
      expect(distill?.attempts).toBe(0);
      gate.release(held as NonNullable<typeof held>);
      await memoryService.drainOnce();
      expect(memory.repo.getMemoryJob(distillId)?.status).toBe("acked");
    } finally {
      memory.close();
    }
  });

  it("AFTER: foreground activity aborts a parked distill from ANY drain origin without touching explicit calls", async () => {
    const memory = await openRepo();
    try {
      const gate = createBackgroundResourceGate();
      const parking = {
        parked: true,
        calls: [] as string[],
        releases: [] as Array<() => void>,
      };
      const memoryService = makeMemoryService(
        memory.repo,
        parkingCli(parking),
        {
          idleMs: 300_000,
          background: gate,
        },
      );
      const distillId = enqueueDistill(memory.repo);
      const tick = memoryService.drainOnce();
      await waitFor(() => parking.calls.includes("maintain.distill"));
      // Foreground intent preempts the automatic child (completion-origin
      // ticks included: the abort tracks the actual background controller,
      // not an idle-origin flag) without authorizing autonomous distill.
      memoryService.notifyForeground();
      await tick;
      expect(memory.repo.getMemoryJob(distillId)?.status).toBe("pending");
    } finally {
      memory.close();
    }
  });

  it("AFTER: an explicit staged retire reaches terminal done while STOPped with a due distill pending", async () => {
    const memory = await openRepo();
    try {
      const gate = createBackgroundResourceGate();
      const ledger = { liveStatus: new Map([["rec-stop", "active"]]) };
      const calls: string[] = [];
      const cliCall: CliCall = async (_address, op, params) => {
        calls.push(op);
        if (op === "record.search") {
          return okEnvelope({
            searchId: `search-${randomUUID()}`,
            items: [{ id: "rec-stop", snippet: "stop me", status: "active" }],
          });
        }
        if (op === "record.get") {
          const id = String((params as { id?: unknown }).id ?? "");
          return okEnvelope({
            record: {
              id,
              body: `body-of-${id}`,
              kind: "user_fact",
              status: ledger.liveStatus.get(id) ?? "active",
              revision: 3,
              source: "companion:conversation",
              observedAt: new Date(T0).toISOString(),
              createdAt: new Date(T0).toISOString(),
              scope: SCOPE,
            },
          });
        }
        return okEnvelope({ ok: true });
      };
      const memoryService = makeMemoryService(memory.repo, cliCall, {
        idleMs: 60_000,
        background: gate,
      });
      const { sessionId, runId } = completeV2Run(memory.repo);
      memoryService.start();
      // Shutdown with no completion/chat in flight: closes admission.
      gate.close();
      expect(gate.closed).toBe(true);
      // Explicit user-authorized staging still works while shutdown-closed.
      const search = await memoryService.searchMemories({
        sessionId,
        runId,
        query: "stop",
      });
      const staged = await memoryService.stageMemoryMutation({
        sessionId,
        runId,
        kind: "record.retire",
        searchId: search.searchId,
        handle: "m1",
        idempotencyKey: randomUUID(),
        trustedSelection: true,
      });
      expect(staged.ok).toBe(true);
      if (!staged.ok) {
        throw new Error("explicit retire stage failed while STOPped");
      }
      // A due automatic distill is pending beside the explicit job.
      const distillId = enqueueDistill(memory.repo);
      // Idle ticks fire while STOPped: no whole-batch block anymore.
      await memoryService.drainOnce();
      const status = memoryService.getMemoryOperation(
        sessionId,
        staged.operationId,
      );
      expect(status?.status).toBe("acked");
      // The automatic distill stayed durable pending, attempts untouched.
      const distill = memory.repo.getMemoryJob(distillId);
      expect(distill?.status).toBe("pending");
      expect(distill?.attempts).toBe(0);
      expect(calls).not.toContain("maintain.distill");
    } finally {
      memory.close();
    }
  });

  it("AFTER (P1 review): a batch-filling gated skip ends the tick instead of spinning forever", async () => {
    const memory = await openRepo();
    try {
      const gate = createBackgroundResourceGate();
      const parking = {
        parked: false,
        calls: [] as string[],
        releases: [] as Array<() => void>,
      };
      const memoryService = makeMemoryService(
        memory.repo,
        parkingCli(parking),
        {
          idleMs: 300_000,
          background: gate,
        },
      );
      // Fill exactly one drain batch (MEMORY_DRAIN_BATCH = 5): one
      // automatic distill plus four explicit retires. The closed gate
      // skips the distill untouched; without a no-progress bound the
      // follow-up page re-reads the same skipped distill with
      // due.length == requested and spins forever.
      const distillId = enqueueDistill(memory.repo);
      const retireIds = [
        enqueueRetire(memory.repo),
        enqueueRetire(memory.repo),
        enqueueRetire(memory.repo),
        enqueueRetire(memory.repo),
      ];
      gate.close();
      expect(gate.closed).toBe(true);
      const out = (await Promise.race([
        memoryService.drainOnce(),
        sleep(8000).then(() => {
          throw new Error("drainOnce did not settle: gated skip spins");
        }),
      ])) as { executed: number };
      // All four explicit jobs drained in the same tick the distill
      // skipped; the distill stays durable pending, attempts unchanged.
      expect(out.executed).toBe(4);
      for (const retireId of retireIds) {
        expect(memory.repo.getMemoryJob(retireId)?.status).toBe("acked");
      }
      const distill = memory.repo.getMemoryJob(distillId);
      expect(distill?.status).toBe("pending");
      expect(distill?.attempts).toBe(0);
      expect(parking.calls).not.toContain("maintain.distill");
    } finally {
      memory.close();
    }
  });

  it("I03-09: idle distill runs while autonomy is paused (gate stays open)", async () => {
    const memory = await openRepo();
    try {
      const gate = createBackgroundResourceGate();
      const parking = {
        parked: false,
        calls: [] as string[],
        releases: [] as Array<() => void>,
      };
      const memoryService = makeMemoryService(
        memory.repo,
        parkingCli(parking),
        {
          idleMs: 300_000,
          background: gate,
        },
      );
      // Committed pause FIRST: cultivation is autonomous no-approval work
      // and must not be gated by it.
      pauseControl(memory.repo);
      expect(gate.closed).toBe(false);
      const distillId = enqueueDistill(memory.repo);
      const out = await memoryService.drainOnce();
      expect(out.executed).toBe(1);
      expect(parking.calls).toEqual(["maintain.distill"]);
      expect(memory.repo.getMemoryJob(distillId)?.status).toBe("acked");
    } finally {
      memory.close();
    }
  });
});
