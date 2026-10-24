// Idle derived maintenance beyond association (remind >=795c476):
// `maintain.consolidate` runs after `maintain.associate`, re-arms while
// its response reports remaining work, and `maintain.activation` runs its
// preview-only scoring at most once per idle pass after a remember.
// Foreground preemption aborts an in-flight consolidate, and an old remind
// that answers BAD_REQUEST latches each op off until restart.
//
// Real migrated `:memory:` kernel DB + injected fake remind CLI (behavioral
// contract only). No child, no remind DB, no network.

import {
  closeKernelDatabase,
  createKernelRepository,
  generateId,
  type KernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
} from "@companion/kernel";
import { afterEach, describe, expect, it } from "vitest";
import type {
  MemoryCliAddress,
  MemoryCliCallOptions,
  MemoryCliEnvelope,
} from "../src/memory_cli.js";
import {
  createMemoryService,
  MEMORY_ACTIVATION_LIMIT,
  MEMORY_CONSOLIDATE_LIMIT,
  MEMORY_DISTILL_TIMEOUT_MS,
  type MemoryService,
  stableMemoryJobKey,
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

interface Fixture {
  repo: KernelRepository;
  close: () => void;
}

async function openRepo(): Promise<Fixture> {
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

function okEnvelope(data: Record<string, unknown> | null): MemoryCliEnvelope {
  return { ok: true, code: "OK", data, deduplicated: false };
}

function rejectedEnvelope(code: string): MemoryCliEnvelope {
  return { ok: false, code, data: null, deduplicated: false };
}

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
    idleMs: 30,
    repo,
    gateway: null,
    model: "test-model",
    cliCall,
  });
  services.push(service);
  return service;
}

async function waitFor(
  condition: () => boolean,
  timeoutMs = 5000,
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function enqueueRememberChain(
  repo: KernelRepository,
  memories: Array<Record<string, unknown>>,
): string {
  const sessionId = generateId();
  const runId = generateId();
  const { row } = repo.enqueueMemoryJob(
    "event.append",
    sessionId,
    runId,
    SCOPE,
    stableMemoryJobKey("event", runId),
    JSON.stringify({
      op: "event.append",
      params: { eventId: `evt-${runId}`, scope: SCOPE, sessionId, runId },
      chain: {
        eventId: `evt-${runId}`,
        sessionId,
        runId,
        provenance: {
          source: "companion:conversation",
          observedAt: new Date(T0).toISOString(),
        },
        memories,
      },
    }),
    { now: T0 },
  );
  return row.id;
}

describe("idle consolidation + activation scheduling", () => {
  it("consolidates after association and re-arms while remaining>0; activation stays preview-only", async () => {
    const f = await openRepo();
    try {
      const order: string[] = [];
      const consolidateKeys: Array<string | undefined> = [];
      let consolidateRuns = 0;
      const activationCalls: Array<{
        params: Record<string, unknown>;
        key: string | undefined;
        timeoutMs: number | undefined;
      }> = [];
      const cliCall: CliCall = async (_address, op, params, key, options) => {
        if (op === "maintain.associate") {
          order.push("associate");
          return okEnvelope({ associate: { remaining: 0 } });
        }
        if (op === "maintain.consolidate") {
          order.push("consolidate");
          consolidateKeys.push(key);
          consolidateRuns += 1;
          // Two passes report remaining work (re-arm), the third is done.
          return okEnvelope({
            consolidate: {
              processed: 2,
              unchanged: 1,
              deferred: 0,
              remaining: consolidateRuns <= 2 ? { topics: 1 } : 0,
            },
          });
        }
        if (op === "maintain.activation") {
          order.push("activation");
          activationCalls.push({
            params,
            key,
            timeoutMs: options?.timeoutMs,
          });
          return okEnvelope({
            activation: {
              scored: 5,
              scoreFailed: 0,
              retired: 0,
              reactivated: 0,
              wouldRetire: 1,
              wouldReactivate: 2,
              degraded: false,
            },
          });
        }
        return okEnvelope(null);
      };
      const service = makeService(f.repo, cliCall);
      service.start();

      await waitFor(() => consolidateRuns >= 3, 5000);
      await sleep(150);

      // Association always precedes the first consolidation pass.
      expect(order.indexOf("associate")).toBeGreaterThanOrEqual(0);
      expect(order.indexOf("associate")).toBeLessThan(
        order.indexOf("consolidate"),
      );
      expect(order).toContain("activation");
      expect(consolidateRuns).toBe(3);
      // Per-pass keys (fresh nonce) make remind recompute every pass.
      expect(new Set(consolidateKeys).size).toBe(3);

      expect(activationCalls.length).toBeGreaterThanOrEqual(1);
      for (const call of activationCalls) {
        expect(call.params).toEqual({
          scope: SCOPE,
          limit: MEMORY_ACTIVATION_LIMIT,
        });
        // Preview-only: never send apply=true.
        expect(call.params).not.toHaveProperty("apply");
        expect(call.key).toBeDefined();
        expect(call.timeoutMs).toBe(MEMORY_DISTILL_TIMEOUT_MS);
      }
      expect(MEMORY_CONSOLIDATE_LIMIT).toBeGreaterThan(0);
    } finally {
      f.close();
    }
  });

  it("runs activation once per idle pass after a remember", async () => {
    const f = await openRepo();
    try {
      let activationCalls = 0;
      const cliCall: CliCall = async (_address, op) => {
        if (op === "maintain.associate") {
          return okEnvelope({ associate: { remaining: 0 } });
        }
        if (op === "maintain.consolidate") {
          return okEnvelope({
            consolidate: {
              processed: 1,
              unchanged: 0,
              deferred: 0,
              remaining: 0,
            },
          });
        }
        if (op === "maintain.activation") {
          activationCalls += 1;
          return okEnvelope({ activation: { scored: 1, degraded: false } });
        }
        return okEnvelope(null);
      };
      const service = makeService(f.repo, cliCall);
      service.start();
      await waitFor(() => activationCalls >= 1, 5000);
      await sleep(120);
      const beforeRemember = activationCalls;
      // Steady state: no repeated activation without a new dirty signal.
      expect(beforeRemember).toBe(1);

      enqueueRememberChain(f.repo, [{ body: "new fact", kind: "user_fact" }]);
      await service.drainOnce();
      await waitFor(() => activationCalls > beforeRemember, 5000);
      await sleep(150);
      // Exactly one extra preview pass for the new remember+consolidation.
      expect(activationCalls).toBe(beforeRemember + 1);
    } finally {
      f.close();
    }
  });
});

describe("foreground preemption of consolidation", () => {
  it("aborts an in-flight consolidate and skips activation for that pass", async () => {
    const f = await openRepo();
    try {
      let activationCalls = 0;
      let consolidateAborted = false;
      let consolidateCalls = 0;
      const cliCall: CliCall = async (_address, op, _params, _key, options) => {
        if (op === "maintain.consolidate") {
          consolidateCalls += 1;
          if (consolidateCalls === 1) {
            return new Promise<MemoryCliEnvelope>((_resolve, reject) => {
              const signal = options?.signal;
              const abort = (): void => {
                consolidateAborted = true;
                reject(new Error("preempted"));
              };
              if (signal?.aborted === true) {
                abort();
              } else {
                signal?.addEventListener("abort", abort, { once: true });
              }
            });
          }
          return okEnvelope({ consolidate: { remaining: 0 } });
        }
        if (op === "maintain.activation") {
          activationCalls += 1;
          return okEnvelope({ activation: { scored: 1, degraded: false } });
        }
        if (op === "maintain.associate") {
          return okEnvelope({ associate: { remaining: 0 } });
        }
        return okEnvelope(null);
      };
      const service = makeService(f.repo, cliCall);
      service.start();
      await waitFor(() => consolidateCalls === 1, 5000);
      service.notifyForeground();
      await waitFor(() => consolidateAborted, 5000);
      // The preempted pass ends before activation.
      expect(activationCalls).toBe(0);

      // A later idle tick is a new pass and may consolidate/activate again.
      await waitFor(() => activationCalls >= 1, 5000);
    } finally {
      f.close();
    }
  });
});

describe("old remind compatibility for derived maintenance", () => {
  it("latches BAD_REQUEST from consolidate and activation until restart", async () => {
    const f = await openRepo();
    try {
      let consolidateCalls = 0;
      let activationCalls = 0;
      const cliCall: CliCall = async (_address, op) => {
        if (op === "maintain.consolidate") {
          consolidateCalls += 1;
          return rejectedEnvelope("BAD_REQUEST");
        }
        if (op === "maintain.activation") {
          activationCalls += 1;
          return rejectedEnvelope("BAD_REQUEST");
        }
        return okEnvelope(null);
      };
      const service = makeService(f.repo, cliCall);
      service.start();
      // Activation is armed by a new remember even when consolidate latched.
      enqueueRememberChain(f.repo, [{ body: "new fact", kind: "user_fact" }]);
      await service.drainOnce();
      await waitFor(() => consolidateCalls >= 1 && activationCalls >= 1, 5000);
      await sleep(250);
      // Latched until restart: no per-tick retry storm.
      expect(consolidateCalls).toBe(1);
      expect(activationCalls).toBe(1);
    } finally {
      f.close();
    }
  });
});
