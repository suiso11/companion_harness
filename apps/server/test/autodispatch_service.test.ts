// Cancellation/lifecycle regression for the durable auto-dispatch intake
// service. Uses a real migrated SQLite repository on a temporary file. The
// gateway/planner are synthetic: no model, job, or production input runs.

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeKernelDatabase,
  createKernelRepository,
  type KernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
} from "@companion/kernel";
import { describe, expect, it } from "vitest";
import type {
  AutodispatchMaterialization,
  AutodispatchMaterializer,
} from "../src/autodispatch_materializer.js";
import {
  type AutodispatchChatGateway,
  type AutodispatchPlanner,
  type AutodispatchPlanProposal,
  type AutodispatchServiceDeps,
  createAutodispatchService,
} from "../src/autodispatch_service.js";
import {
  BACKGROUND_OWNER_AUTODISPATCH,
  BACKGROUND_OWNER_MEMORY_EXTRACTION,
  type BackgroundResourceGate,
  createBackgroundResourceGate,
} from "../src/background_resource.js";
import type { AutodispatchConfig } from "../src/config.js";

const FP = "b".repeat(64);
const REV = "a".repeat(40);
const NOW = 1_760_000_000_000;

const CAPS: AutodispatchConfig["caps"] = {
  timeoutMs: 60000,
  maxOutputBytes: 1000000,
  maxModelCalls: 8,
  maxOutputTokens: 256,
  perCallTimeoutMs: 5000,
  maxRequestBytes: 1048576,
  maxResponseBytes: 1048576,
  maxConcurrent: 1,
  jobsPerDay: 3,
  concurrentExecutions: 1,
};

const CONFIG: AutodispatchConfig = {
  enabled: true,
  workspaceAlias: "companion-harness",
  sourceRoot: "/synthetic/source",
  operations: ["investigate", "implement"],
  readScopes: ["src", "docs"],
  writeScopes: ["src"],
  checks: ["lint"],
  caps: CAPS,
  dependencyRoot: "/synthetic/deps",
  bridgeScriptPath: "/opt/bridge.mjs",
  bridgeConfigTemplatePath: "/opt/bridge.template.json",
  materialization: null,
};

const PROFILE: AutodispatchServiceDeps["profile"] = {
  available: true,
  enabled: true,
  mandatoryChecks: ["lint"],
  configFingerprint: FP,
  sourceRevision: REV,
  currentModel: "test-model",
  disclosedWholeRepoRead: true,
  timeoutMs: 60000,
  maxOutputBytes: 1000000,
};

interface Fixture {
  readonly repo: KernelRepository;
  readonly close: () => void;
}

async function makeFixture(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "companion-autodispatch-service-"));
  const handle = openKernelDatabase(join(dir, "db.sqlite"));
  await migrateKernelDatabase({ db: handle.raw });
  const repo = createKernelRepository(handle.raw);
  return {
    repo,
    close: () => {
      closeKernelDatabase(handle);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function resume(repo: KernelRepository): void {
  const control = repo.getAutonomyControlState();
  repo.setAutonomyControlState(
    { paused: false, expectedVersion: control.version },
    { key: randomUUID(), now: NOW },
  );
}

function completeTurn(
  repo: KernelRepository,
  sessionId: string,
  text: string,
  now: number,
): { turnId: string; runId: string } {
  const posted = repo.postMessage(
    sessionId,
    { text },
    { key: randomUUID(), now },
  );
  repo.startRun(posted.body.run.id, { now: now + 1 });
  repo.completeRun(posted.body.run.id, { version: 1, text: "ok" } as never, {
    now: now + 2,
  });
  return { turnId: posted.body.turnId, runId: posted.body.run.id };
}

function createPolicy(
  repo: KernelRepository,
  sessionId: string,
  sourceTurnId: string,
  now = NOW + 20,
) {
  return repo.createAutodispatchPolicy(
    sessionId,
    {
      workspaceAlias: CONFIG.workspaceAlias,
      operations: ["investigate", "implement"],
      readScopes: [...CONFIG.readScopes],
      writeScopes: [...CONFIG.writeScopes],
      checks: [...CONFIG.checks],
      caps: CONFIG.caps,
      expiresAt: null,
    },
    {
      key: randomUUID(),
      now,
      limits: {
        operations: [...CONFIG.operations],
        checks: [...CONFIG.checks],
        caps: CONFIG.caps,
      },
      parent: {
        statement: "Standing policy for the approved workspace",
        sourceTurnId,
      },
    },
  );
}

function proposalFor(input: {
  latestUserTurnId: string;
  latestUserRunId: string;
}): AutodispatchPlanProposal {
  return {
    operation: "implement",
    content: {
      goal: "Implement the accepted feature",
      decisions: ["Use the existing runner"],
      nongoals: [],
      steps: ["Edit src/app.ts"],
      acceptance: ["lint passes"],
      missing: [],
      relevantPaths: ["src/app.ts"],
    },
    intent: {
      kind: "execute",
      quotes: [
        {
          turnId: input.latestUserTurnId,
          runId: input.latestUserRunId,
          text: "implement the feature",
        },
      ],
      latestUserTurnId: input.latestUserTurnId,
      latestUserRunId: input.latestUserRunId,
    },
  };
}

async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Deterministic drain turn: no timers/sleeps, just pending macrotasks. */
async function flushDrain(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function waitForGateRelease(gate: BackgroundResourceGate): Promise<void> {
  await waitFor(() => {
    const reservation = gate.tryAcquire(BACKGROUND_OWNER_AUTODISPATCH);
    if (reservation === null) return false;
    gate.release(reservation);
    return true;
  }, "background gate release");
}

function fakeMaterialization(
  plan: { id: string; revision: number; planHash: string },
  policy: { id: string; version: number },
  executionId: string,
): AutodispatchMaterialization {
  const now = NOW + 30;
  const base = {
    schemaVersion: 1 as const,
    reference: {
      planId: plan.id,
      planRevision: plan.revision,
      planHash: plan.planHash,
      policyId: policy.id,
      policyVersion: policy.version,
      workspaceAlias: CONFIG.workspaceAlias,
      executionId,
      createdAt: now,
    },
    profile: PROFILE,
    budget: {
      maxRequestBytes: CAPS.maxRequestBytes,
      maxModelCalls: CAPS.maxModelCalls,
      maxOutputTokens: CAPS.maxOutputTokens,
      maxResponseBytes: CAPS.maxResponseBytes,
      perCallTimeoutMs: CAPS.perCallTimeoutMs,
      maxConcurrent: CAPS.maxConcurrent,
    },
    config: {} as never,
    state: {
      jobRoot: "/synthetic/job",
      runDir: "/synthetic/job/run",
      runtimeDir: "/synthetic/runtime",
      socketDir: "/synthetic/runtime/companion-ad-synthetic",
      socketHostPath: "/synthetic/runtime/companion-ad-synthetic/model.sock",
      sourceRootCanonical: "/synthetic/source",
      snapshotRoot: "/synthetic/job/sealed/snapshot",
      manifestPath: "/synthetic/job/sealed/workspace-manifest.json",
      sourceManifestDigest: "c".repeat(64),
      dependencyRoot: "/synthetic/deps",
      dependencyManifestPath: "/synthetic/deps.closure-manifest.json",
      dependencyDigest: "d".repeat(64),
      executorDigest: "e".repeat(64),
      checks: { lint: "f".repeat(64) },
      runtime: { nodeRealpath: "1".repeat(64) },
      configDigest: "2".repeat(64),
    },
  };
  return {
    ...base,
    digests: { materialization: "3".repeat(64) },
  } as AutodispatchMaterialization;
}

function fakeMaterializer(): AutodispatchMaterializer {
  return {
    async prepare(input) {
      return {
        ok: true,
        materialization: fakeMaterialization(
          input.plan,
          input.policy,
          input.executionId,
        ),
      };
    },
    discard() {
      return undefined;
    },
  };
}

function makeService(
  repo: KernelRepository,
  gate: BackgroundResourceGate,
  overrides: Pick<
    Partial<AutodispatchServiceDeps>,
    "planner" | "gateway" | "model" | "timeoutMs" | "materializer"
  >,
) {
  return createAutodispatchService({
    repo,
    config: CONFIG,
    profile: PROFILE,
    background: gate,
    maxOutputTokens: 256,
    now: () => NOW + 30,
    ...overrides,
  });
}

describe("autodispatch service cancellation", () => {
  it("stop settles a hung gateway that ignores abort and releases the gate", async () => {
    const fx = await makeFixture();
    try {
      resume(fx.repo);
      const sessionId = fx.repo.createSession({
        key: randomUUID(),
        now: NOW,
      }).body.sessionId;
      const anchor = completeTurn(
        fx.repo,
        sessionId,
        "Please implement the feature in src/app.ts. Go ahead.",
        NOW + 10,
      );
      const policy = createPolicy(fx.repo, sessionId, anchor.turnId);
      expect(policy.status).toBe("active");

      const gate = createBackgroundResourceGate();
      let chatSignal: AbortSignal | undefined;
      let releaseChat: ((value: { text: string }) => void) | undefined;
      const gateway: AutodispatchChatGateway = {
        chat(_request, options) {
          chatSignal = options?.signal;
          return new Promise((resolve) => {
            releaseChat = resolve;
          });
        },
      };
      const service = makeService(fx.repo, gate, {
        gateway,
        model: "test-model",
        timeoutMs: 25,
      });
      service.onRunCompleted(anchor.runId);
      expect(chatSignal).toBeDefined();

      await service.stop();
      expect(chatSignal?.aborted).toBe(true);
      await waitForGateRelease(gate);

      // A late model completion after stop must never create or authorize.
      releaseChat?.({
        text: JSON.stringify({
          ...proposalFor({
            latestUserTurnId: anchor.turnId,
            latestUserRunId: anchor.runId,
          }),
        }),
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(fx.repo.listAutodispatchPlans(sessionId, 100)).toHaveLength(0);
      expect(fx.repo.listAutodispatchExecutions(sessionId, 10)).toHaveLength(0);
    } finally {
      fx.close();
    }
  });

  it("processes duplicate completion of one run exactly once", async () => {
    const fx = await makeFixture();
    try {
      resume(fx.repo);
      const sessionId = fx.repo.createSession({
        key: randomUUID(),
        now: NOW,
      }).body.sessionId;
      const anchor = completeTurn(
        fx.repo,
        sessionId,
        "Please implement the feature in src/app.ts. Go ahead.",
        NOW + 10,
      );
      expect(createPolicy(fx.repo, sessionId, anchor.turnId).status).toBe(
        "active",
      );

      const gate = createBackgroundResourceGate();
      let calls = 0;
      let release: (() => void) | undefined;
      const planner: AutodispatchPlanner = {
        propose(input) {
          calls += 1;
          return new Promise((resolve) => {
            release = () => resolve(proposalFor(input));
          });
        },
      };
      const service = makeService(fx.repo, gate, {
        planner,
        materializer: fakeMaterializer(),
      });

      service.onRunCompleted(anchor.runId);
      service.onRunCompleted(anchor.runId);
      expect(calls).toBe(1);
      release?.();

      await waitFor(
        () =>
          fx.repo
            .listAutodispatchExecutions(sessionId, 10)
            .some((item) => item.status === "authorized"),
        "one authorized execution",
      );
      expect(calls).toBe(1);
      expect(fx.repo.listAutodispatchPlans(sessionId, 100)).toHaveLength(1);
      expect(fx.repo.listAutodispatchExecutions(sessionId, 10)).toHaveLength(1);
      await service.stop();
    } finally {
      fx.close();
    }
  });

  it("drops intake when the latest user turn or active policy changes after planning starts", async () => {
    const fx = await makeFixture();
    try {
      resume(fx.repo);
      const sessionId = fx.repo.createSession({
        key: randomUUID(),
        now: NOW,
      }).body.sessionId;
      const anchor = completeTurn(
        fx.repo,
        sessionId,
        "Please implement the feature in src/app.ts. Go ahead.",
        NOW + 10,
      );
      const policy = createPolicy(fx.repo, sessionId, anchor.turnId);
      expect(policy.status).toBe("active");

      const gate = createBackgroundResourceGate();
      const pending: Array<() => void> = [];
      const planner: AutodispatchPlanner = {
        propose(input) {
          return new Promise((resolve) => {
            pending.push(() => resolve(proposalFor(input)));
          });
        },
      };
      const service = makeService(fx.repo, gate, { planner });

      // The latest user run moves while the planner is still in flight.
      service.onRunCompleted(anchor.runId);
      await waitFor(() => pending.length === 1, "first planner call");
      const next = completeTurn(
        fx.repo,
        sessionId,
        "Now implement something else.",
        NOW + 50,
      );
      pending.shift()?.();
      await waitForGateRelease(gate);
      expect(fx.repo.listAutodispatchPlans(sessionId, 100)).toHaveLength(0);
      expect(fx.repo.listAutodispatchExecutions(sessionId, 10)).toHaveLength(0);

      // The selected active policy is revoked while planning is in flight.
      service.onRunCompleted(next.runId);
      await waitFor(() => pending.length === 1, "second planner call");
      fx.repo.revokeAutodispatchPolicy(sessionId, policy.id, {
        now: NOW + 60,
        reason: "test",
      });
      pending.shift()?.();
      await waitForGateRelease(gate);
      expect(fx.repo.listAutodispatchPlans(sessionId, 100)).toHaveLength(0);
      expect(fx.repo.listAutodispatchExecutions(sessionId, 10)).toHaveLength(0);
      await service.stop();
    } finally {
      fx.close();
    }
  });
});
describe("autodispatch service background-gate intake queue", () => {
  it("keeps intake pending while memory holds the shared gate, then plans/grant once", async () => {
    const fx = await makeFixture();
    try {
      resume(fx.repo);
      const sessionId = fx.repo.createSession({
        key: randomUUID(),
        now: NOW,
      }).body.sessionId;
      const anchor = completeTurn(
        fx.repo,
        sessionId,
        "Please implement the feature in src/app.ts. Go ahead.",
        NOW + 10,
      );
      expect(createPolicy(fx.repo, sessionId, anchor.turnId).status).toBe(
        "active",
      );
      const gate = createBackgroundResourceGate();
      const memoryLease = gate.tryAcquire(BACKGROUND_OWNER_MEMORY_EXTRACTION);
      expect(memoryLease).not.toBeNull();
      let calls = 0;
      const planner: AutodispatchPlanner = {
        propose(input) {
          calls += 1;
          return Promise.resolve(proposalFor(input));
        },
      };
      const service = makeService(fx.repo, gate, {
        planner,
        materializer: fakeMaterializer(),
      });

      // Memory owns the shared slot: the completion is queued, not dropped,
      // and duplicate notifications are deduplicated.
      service.onRunCompleted(anchor.runId);
      service.onRunCompleted(anchor.runId);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(calls).toBe(0);
      expect(fx.repo.listAutodispatchPlans(sessionId, 100)).toHaveLength(0);

      if (memoryLease !== null) gate.release(memoryLease);
      await waitFor(
        () =>
          fx.repo
            .listAutodispatchExecutions(sessionId, 10)
            .some((item) => item.status === "authorized"),
        "one authorized execution after release",
      );
      expect(calls).toBe(1);
      expect(fx.repo.listAutodispatchPlans(sessionId, 100)).toHaveLength(1);
      expect(fx.repo.listAutodispatchExecutions(sessionId, 10)).toHaveLength(1);
      await service.stop();
    } finally {
      fx.close();
    }
  });

  it("drops queued intent invalidated by a newer turn or revoked policy before release", async () => {
    const fx = await makeFixture();
    try {
      resume(fx.repo);
      const sessionId = fx.repo.createSession({
        key: randomUUID(),
        now: NOW,
      }).body.sessionId;
      const anchor = completeTurn(
        fx.repo,
        sessionId,
        "Please implement the feature in src/app.ts. Go ahead.",
        NOW + 10,
      );
      const policy = createPolicy(fx.repo, sessionId, anchor.turnId);
      expect(policy.status).toBe("active");
      const gate = createBackgroundResourceGate();
      let calls = 0;
      const planner: AutodispatchPlanner = {
        propose(input) {
          calls += 1;
          return Promise.resolve(proposalFor(input));
        },
      };
      const service = makeService(fx.repo, gate, {
        planner,
        materializer: fakeMaterializer(),
      });

      // Newer user turn while the slot is held: the queued old intent must
      // never reach the planner after release.
      const memoryLease = gate.tryAcquire(BACKGROUND_OWNER_MEMORY_EXTRACTION);
      service.onRunCompleted(anchor.runId);
      completeTurn(fx.repo, sessionId, "Do something different.", NOW + 50);
      if (memoryLease !== null) gate.release(memoryLease);
      await waitForGateRelease(gate);
      expect(calls).toBe(0);
      expect(fx.repo.listAutodispatchPlans(sessionId, 100)).toHaveLength(0);

      // Revoked policy while a fresh intake is queued: same result.
      const next = completeTurn(
        fx.repo,
        sessionId,
        "Implement the feature again.",
        NOW + 80,
      );
      const nextPolicy = createPolicy(
        fx.repo,
        sessionId,
        next.turnId,
        NOW + 80,
      );
      expect(nextPolicy.status).toBe("active");
      const held = gate.tryAcquire(BACKGROUND_OWNER_MEMORY_EXTRACTION);
      expect(held).not.toBeNull();
      service.onRunCompleted(next.runId);
      fx.repo.revokeAutodispatchPolicy(sessionId, nextPolicy.id, {
        now: NOW + 90,
        reason: "test",
      });
      if (held !== null) gate.release(held);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(calls).toBe(0);
      expect(fx.repo.listAutodispatchExecutions(sessionId, 10)).toHaveLength(0);
      await service.stop();
    } finally {
      fx.close();
    }
  });

  it("does not resurrect queued intent after a closed gate is reopened", async () => {
    const fx = await makeFixture();
    try {
      resume(fx.repo);
      const sessionId = fx.repo.createSession({
        key: randomUUID(),
        now: NOW,
      }).body.sessionId;
      const anchor = completeTurn(
        fx.repo,
        sessionId,
        "Please implement the feature in src/app.ts. Go ahead.",
        NOW + 10,
      );
      expect(createPolicy(fx.repo, sessionId, anchor.turnId).status).toBe(
        "active",
      );
      const gate = createBackgroundResourceGate();
      let calls = 0;
      const planner: AutodispatchPlanner = {
        propose(input) {
          calls += 1;
          return Promise.resolve(proposalFor(input));
        },
      };
      const service = makeService(fx.repo, gate, {
        planner,
        materializer: fakeMaterializer(),
      });
      const held = gate.tryAcquire(BACKGROUND_OWNER_MEMORY_EXTRACTION);
      service.onRunCompleted(anchor.runId);
      gate.close();
      if (held !== null) gate.release(held);
      await new Promise((resolve) => setTimeout(resolve, 20));
      gate.reopen();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(calls).toBe(0);
      expect(fx.repo.listAutodispatchPlans(sessionId, 100)).toHaveLength(0);
      await service.stop();
    } finally {
      fx.close();
    }
  });

  it("stop settles a queued intake before DB close and ignores the later release", async () => {
    const fx = await makeFixture();
    let closed = false;
    try {
      resume(fx.repo);
      const sessionId = fx.repo.createSession({
        key: randomUUID(),
        now: NOW,
      }).body.sessionId;
      const anchor = completeTurn(
        fx.repo,
        sessionId,
        "Please implement the feature in src/app.ts. Go ahead.",
        NOW + 10,
      );
      expect(createPolicy(fx.repo, sessionId, anchor.turnId).status).toBe(
        "active",
      );
      const gate = createBackgroundResourceGate();
      const held = gate.tryAcquire(BACKGROUND_OWNER_MEMORY_EXTRACTION);
      let calls = 0;
      const service = makeService(fx.repo, gate, {
        planner: {
          propose(input) {
            calls += 1;
            return Promise.resolve(proposalFor(input));
          },
        },
        materializer: fakeMaterializer(),
      });
      service.onRunCompleted(anchor.runId);
      await service.stop();
      const plansBeforeClose = fx.repo.listAutodispatchPlans(sessionId, 100);
      expect(plansBeforeClose).toHaveLength(0);
      fx.close();
      closed = true;
      // The closed DB must never be touched by a post-stop wake.
      if (held !== null) gate.release(held);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(calls).toBe(0);
    } finally {
      if (!closed) fx.close();
    }
  });

  it("drops a queued intake after a pause/resume generation change (0 planner/grant)", async () => {
    const fx = await makeFixture();
    try {
      resume(fx.repo);
      const sessionId = fx.repo.createSession({
        key: randomUUID(),
        now: NOW,
      }).body.sessionId;
      const anchor = completeTurn(
        fx.repo,
        sessionId,
        "Please implement the feature in src/app.ts. Go ahead.",
        NOW + 10,
      );
      expect(createPolicy(fx.repo, sessionId, anchor.turnId).status).toBe(
        "active",
      );
      const gate = createBackgroundResourceGate();
      const memoryLease = gate.tryAcquire(BACKGROUND_OWNER_MEMORY_EXTRACTION);
      expect(memoryLease).not.toBeNull();
      let calls = 0;
      const service = makeService(fx.repo, gate, {
        planner: {
          propose(input) {
            calls += 1;
            return Promise.resolve(proposalFor(input));
          },
        },
        materializer: fakeMaterializer(),
      });

      // Capture happens here (resumed generation), then STOP and resume
      // move the monotonic control version before the slot is released.
      service.onRunCompleted(anchor.runId);
      const paused = fx.repo.getAutonomyControlState();
      fx.repo.setAutonomyControlState(
        { paused: true, expectedVersion: paused.version },
        { key: randomUUID(), now: NOW + 40 },
      );
      resume(fx.repo);
      if (memoryLease !== null) gate.release(memoryLease);
      await flushDrain();

      expect(calls).toBe(0);
      expect(fx.repo.listAutodispatchPlans(sessionId, 100)).toHaveLength(0);
      expect(fx.repo.listAutodispatchExecutions(sessionId, 10)).toHaveLength(0);
      await service.stop();
    } finally {
      fx.close();
    }
  });

  it("coalesced closed wake never revives old intent and old duplicates stay dead", async () => {
    const fx = await makeFixture();
    try {
      resume(fx.repo);
      const sessionId = fx.repo.createSession({
        key: randomUUID(),
        now: NOW,
      }).body.sessionId;
      const anchor = completeTurn(
        fx.repo,
        sessionId,
        "Please implement the feature in src/app.ts. Go ahead.",
        NOW + 10,
      );
      expect(createPolicy(fx.repo, sessionId, anchor.turnId).status).toBe(
        "active",
      );
      const gate = createBackgroundResourceGate();
      const held = gate.tryAcquire(BACKGROUND_OWNER_MEMORY_EXTRACTION);
      expect(held).not.toBeNull();
      let calls = 0;
      const service = makeService(fx.repo, gate, {
        planner: {
          propose(input) {
            calls += 1;
            return Promise.resolve(proposalFor(input));
          },
        },
        materializer: fakeMaterializer(),
      });

      // The async drain is still unwinding while STOP + release arrive in
      // the SAME tick: the wake coalesces, so only the closed branches can
      // drop pending intent before a reopen.
      service.onRunCompleted(anchor.runId);
      gate.close();
      if (held !== null) gate.release(held);
      await flushDrain();
      gate.reopen();
      const fresh = gate.tryAcquire(BACKGROUND_OWNER_MEMORY_EXTRACTION);
      if (fresh !== null) gate.release(fresh);
      await flushDrain();
      expect(calls).toBe(0);
      expect(fx.repo.listAutodispatchPlans(sessionId, 100)).toHaveLength(0);

      // A duplicate of the stopped-old completion must never requeue it.
      service.onRunCompleted(anchor.runId);
      await flushDrain();
      expect(calls).toBe(0);
      expect(fx.repo.listAutodispatchPlans(sessionId, 100)).toHaveLength(0);

      // A genuinely fresh completed run after resume is still eligible.
      const next = completeTurn(
        fx.repo,
        sessionId,
        "Please implement the feature again. Go ahead.",
        NOW + 60,
      );
      expect(
        createPolicy(fx.repo, sessionId, next.turnId, NOW + 70).status,
      ).toBe("active");
      service.onRunCompleted(next.runId);
      await flushDrain();
      expect(calls).toBe(1);
      const plans = fx.repo.listAutodispatchPlans(sessionId, 100);
      expect(plans).toHaveLength(1);
      expect(
        fx.repo
          .listAutodispatchExecutions(sessionId, 10)
          .some((item) => item.status === "authorized"),
      ).toBe(true);
      await service.stop();
    } finally {
      fx.close();
    }
  });
});
