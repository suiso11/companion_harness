// Idle derived maintenance beyond association (remind >=795c476):
// `maintain.consolidate` runs after `maintain.associate` with `{scope}`
// only (remind's batchMax rejects a larger limit), re-arms for the next
// tick only when the real response reports `applied > 0`, and
// `maintain.activation` runs its flat preview-only scoring at most once
// per idle pass after a remember. Foreground preemption aborts an
// in-flight consolidate, and BAD_REQUEST/LIMIT_EXCEEDED latch each op off
// until restart.
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
  it("consolidates after association with {scope} only, re-arming on applied>0 but not on a deferred/unchanged pass", async () => {
    const f = await openRepo();
    try {
      const order: string[] = [];
      const consolidateKeys: Array<string | undefined> = [];
      const consolidateParams: Array<Record<string, unknown>> = [];
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
          consolidateParams.push(params);
          consolidateRuns += 1;
          // Two passes applied real writes (re-arm); the third is only
          // deferred/unchanged work, which must NOT re-arm on its own.
          return consolidateRuns <= 2
            ? okEnvelope({
                clusters: [
                  {
                    topic: "food",
                    members: 2,
                    sentencesKept: 1,
                    outcome: "written",
                  },
                ],
                applied: 1,
                degraded: false,
              })
            : okEnvelope({
                clusters: [
                  {
                    topic: "food",
                    members: 1,
                    sentencesKept: 0,
                    outcome: "deferred",
                  },
                  {
                    topic: "work",
                    members: 1,
                    sentencesKept: 0,
                    outcome: "unchanged",
                  },
                ],
                applied: 0,
                degraded: false,
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
            scored: 5,
            scoreFailed: 0,
            retired: 0,
            reactivated: 0,
            wouldRetire: 1,
            wouldReactivate: 2,
            degraded: false,
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
      // applied=1 twice re-arms; applied=0 with deferred/unchanged does not.
      expect(consolidateRuns).toBe(3);
      // Per-pass keys (fresh nonce) make remind recompute every pass.
      expect(new Set(consolidateKeys).size).toBe(3);
      for (const params of consolidateParams) {
        expect(params).toEqual({ scope: SCOPE });
        expect(params).not.toHaveProperty("limit");
      }

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
            clusters: [
              {
                topic: "work",
                members: 1,
                sentencesKept: 0,
                outcome: "unchanged",
              },
            ],
            applied: 0,
            degraded: false,
          });
        }
        if (op === "maintain.activation") {
          activationCalls += 1;
          return okEnvelope({
            scored: 1,
            scoreFailed: 0,
            retired: 0,
            reactivated: 0,
            wouldRetire: 0,
            wouldReactivate: 0,
            degraded: false,
          });
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
          return okEnvelope({ clusters: [], applied: 0, degraded: false });
        }
        if (op === "maintain.activation") {
          activationCalls += 1;
          return okEnvelope({
            scored: 1,
            scoreFailed: 0,
            retired: 0,
            reactivated: 0,
            wouldRetire: 0,
            wouldReactivate: 0,
            degraded: false,
          });
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

describe("permanent derived-maintenance misconfiguration", () => {
  it("latches LIMIT_EXCEEDED from consolidate and activation until restart", async () => {
    const f = await openRepo();
    try {
      let consolidateCalls = 0;
      let activationCalls = 0;
      const cliCall: CliCall = async (_address, op) => {
        if (op === "maintain.consolidate") {
          consolidateCalls += 1;
          return rejectedEnvelope("LIMIT_EXCEEDED");
        }
        if (op === "maintain.activation") {
          activationCalls += 1;
          return rejectedEnvelope("LIMIT_EXCEEDED");
        }
        return okEnvelope(null);
      };
      const service = makeService(f.repo, cliCall);
      service.start();
      enqueueRememberChain(f.repo, [{ body: "new fact", kind: "user_fact" }]);
      await service.drainOnce();
      await waitFor(() => consolidateCalls >= 1 && activationCalls >= 1, 5000);
      await sleep(250);
      // A permanent misconfig is logged once and latched, never retried.
      expect(consolidateCalls).toBe(1);
      expect(activationCalls).toBe(1);
    } finally {
      f.close();
    }
  });
});

describe("background activity rows", () => {
  it("records consolidate/activation success with the logged numeric counts", async () => {
    const f = await openRepo();
    try {
      const cliCall: CliCall = async (_address, op) => {
        if (op === "maintain.associate") {
          return okEnvelope({ associate: { remaining: 0 } });
        }
        if (op === "maintain.consolidate") {
          return okEnvelope({
            clusters: [
              {
                topic: "topic-a",
                members: 2,
                sentencesKept: 1,
                outcome: "written",
              },
              {
                topic: "topic-b",
                members: 1,
                sentencesKept: 0,
                outcome: "deferred",
              },
            ],
            applied: 1,
            degraded: false,
          });
        }
        if (op === "maintain.activation") {
          return okEnvelope({
            scored: 4,
            scoreFailed: 1,
            retired: 2,
            reactivated: 1,
            wouldRetire: 3,
            wouldReactivate: 2,
            degraded: false,
          });
        }
        return okEnvelope({});
      };
      const service = makeService(f.repo, cliCall);
      service.start();
      await waitFor(
        () =>
          f.repo
            .listMemoryMaintenanceRuns({ limit: 100 })
            .items.some((run) => run.op === "maintain.activation"),
        5000,
      );
      const runs = f.repo.listMemoryMaintenanceRuns({ limit: 100 }).items;
      const consolidate = runs.find((run) => run.op === "maintain.consolidate");
      const activation = runs.find((run) => run.op === "maintain.activation");
      expect(consolidate).toMatchObject({
        ok: true,
        errorCode: null,
        counts: {
          applied: 1,
          written: 1,
          unchanged: 0,
          no_grounded: 0,
          deferred: 1,
          degraded: 0,
        },
      });
      expect(activation).toMatchObject({
        ok: true,
        errorCode: null,
        counts: {
          scored: 4,
          score_failed: 1,
          retired: 2,
          reactivated: 1,
          would_retire: 3,
          would_reactivate: 2,
          degraded: 0,
        },
      });
      const summary = f.repo.memoryMaintenanceSummary(Date.now());
      expect(
        summary.windows.last24h.ops["maintain.consolidate"].counts.applied,
      ).toBe(1);
      expect(
        summary.windows.last24h.ops["maintain.activation"].counts.retired,
      ).toBe(2);
      expect(summary.latestByOp["maintain.activation"]).not.toBeNull();
      expect(summary.latestByOp["maintain.distill"]).toBeNull();
    } finally {
      f.close();
    }
  });

  it("records a fixed failure code for a rejected consolidate", async () => {
    const f = await openRepo();
    try {
      const cliCall: CliCall = async (_address, op) => {
        if (op === "maintain.associate") {
          return okEnvelope({ associate: { remaining: 0 } });
        }
        if (op === "maintain.consolidate") {
          return rejectedEnvelope("TIMEOUT");
        }
        return okEnvelope({});
      };
      const service = makeService(f.repo, cliCall);
      service.start();
      await waitFor(
        () =>
          f.repo
            .listMemoryMaintenanceRuns({ limit: 100 })
            .items.some((run) => run.op === "maintain.consolidate"),
        5000,
      );
      const runs = f.repo.listMemoryMaintenanceRuns({ limit: 100 }).items;
      const consolidate = runs.find((run) => run.op === "maintain.consolidate");
      expect(consolidate).toMatchObject({
        ok: false,
        errorCode: "timeout",
        counts: {},
      });
      // A failed consolidate does not schedule activation for that pass.
      expect(runs.some((run) => run.op === "maintain.activation")).toBe(false);
      // No memory bodies/text fields exist on an activity row.
      expect(Object.keys(consolidate ?? {})).not.toContain("body");
    } finally {
      f.close();
    }
  });

  it("records a fixed failure code for a rejected activation", async () => {
    const f = await openRepo();
    try {
      const cliCall: CliCall = async (_address, op) => {
        if (op === "maintain.associate") {
          return okEnvelope({ associate: { remaining: 0 } });
        }
        if (op === "maintain.consolidate") {
          return okEnvelope({ clusters: [], applied: 0, degraded: false });
        }
        if (op === "maintain.activation") {
          return rejectedEnvelope("TIMEOUT");
        }
        return okEnvelope({});
      };
      const service = makeService(f.repo, cliCall);
      service.start();
      await waitFor(
        () =>
          f.repo
            .listMemoryMaintenanceRuns({ limit: 100 })
            .items.some((run) => run.op === "maintain.activation"),
        5000,
      );
      const runs = f.repo.listMemoryMaintenanceRuns({ limit: 100 }).items;
      const activation = runs.find((run) => run.op === "maintain.activation");
      expect(activation).toMatchObject({
        ok: false,
        errorCode: "timeout",
        counts: {},
      });
      // No memory bodies/text fields exist on an activity row.
      expect(Object.keys(activation ?? {})).not.toContain("text");
    } finally {
      f.close();
    }
  });
});
