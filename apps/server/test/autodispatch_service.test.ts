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
import { type AutodispatchConfig } from "../src/config.js";
import {
  type AutodispatchChatGateway,
  type AutodispatchPlanProposal,
  type AutodispatchPlanner,
  type AutodispatchServiceDeps,
  createAutodispatchService,
} from "../src/autodispatch_service.js";
import type {
  AutodispatchMaterialization,
  AutodispatchMaterializer,
} from "../src/autodispatch_materializer.js";
import {
  BACKGROUND_OWNER_AUTODISPATCH,
  type BackgroundResourceGate,
  createBackgroundResourceGate,
} from "../src/background_resource.js";

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
  repo.completeRun(
    posted.body.run.id,
    { version: 1, text: "ok" } as never,
    { now: now + 2 },
  );
  return { turnId: posted.body.turnId, runId: posted.body.run.id };
}

function createPolicy(
  repo: KernelRepository,
  sessionId: string,
  sourceTurnId: string,
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
      now: NOW + 20,
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

async function waitForGateRelease(
  gate: BackgroundResourceGate,
): Promise<void> {
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
