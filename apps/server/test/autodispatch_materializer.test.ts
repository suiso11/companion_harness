// Behavioral tests for the per-execution auto-dispatch materializer.
// Real temp source/state, a fake operator fixed executor/check, a synthetic
// pinned "Pi" runtime path, and a real migrated kernel repository. No model,
// live Pi, production source, network, or user task is used.

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  closeKernelDatabase,
  createKernelRepository,
  type KernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
} from "@companion/kernel";
import type { ModelGateway } from "@companion/model-local";
import { describe, expect, it } from "vitest";
import { verifySealedWorkspaceSnapshot } from "../../../packages/kernel/src/autonomous_workspace.js";
import {
  cleanupTerminalAutodispatchMaterialization,
  createAutodispatchMaterializer,
  pruneAutodispatchMaterializations,
  resolveAutodispatchMaterialization,
  verifyAutodispatchMaterialization,
} from "../src/autodispatch_materializer.js";
import {
  type AutodispatchPlanner,
  createAutodispatchService,
} from "../src/autodispatch_service.js";
import { createBackgroundResourceGate } from "../src/background_resource.js";
import type { AutodispatchConfig } from "../src/config.js";
import { createCollectingLogger } from "../src/logger.js";
import { TrialModelRelay } from "../src/trial_model_relay.js";
import {
  TrialRunner,
  type TrialRunnerObserverFns,
  type TrialRunnerRelay,
  type TrialRunnerSpawn,
} from "../src/trial_runner.js";

const linuxDescribe = process.platform === "linux" ? describe : describe.skip;

const NOW = 1_760_000_000_000;
const CAPS: AutodispatchConfig["caps"] = {
  timeoutMs: 60_000,
  maxOutputBytes: 1_000_000,
  maxModelCalls: 8,
  maxOutputTokens: 256,
  perCallTimeoutMs: 5_000,
  maxRequestBytes: 1_048_576,
  maxResponseBytes: 1_048_576,
  maxConcurrent: 1,
  jobsPerDay: 3,
  concurrentExecutions: 1,
};

interface Fixture {
  readonly dir: string;
  readonly source: string;
  readonly stateDir: string;
  readonly runtimeDir: string;
  readonly executor: string;
  readonly check: string;
  readonly depSource: string;
  readonly config: AutodispatchConfig;
  readonly cleanup: () => void;
}

function write(path: string, body: string, mode = 0o600): void {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(path, body, { mode });
}

function removeTree(path: string): void {
  // Materialized dependency depots are intentionally read-only (0555/0444);
  // restore owner write bits so the test fixture can clean itself up.
  const walk = (absolute: string): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(absolute, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(absolute, entry.name);
      if (entry.isDirectory()) walk(child);
    }
    try {
      chmodSync(absolute, 0o700);
    } catch {
      // Best effort cleanup after an intentional fail-closed path.
    }
  };
  walk(path);
  rmSync(path, { recursive: true, force: true });
}

function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "autodispatch-materializer-"));
  const source = join(dir, "source");
  write(join(source, "package.json"), '{"name":"fixture"}\n');
  write(join(source, "src", "app.ts"), "export const app = 1;\n");
  write(join(source, "src", "nested", "deep.ts"), "export const deep = 2;\n");
  write(join(source, "src", ".env"), "SECRET=forbidden\n");
  write(join(source, ".env"), "ROOT_SECRET=forbidden\n");
  write(join(source, ".git", "config"), "[remote]\n");
  write(join(source, "build", "evil.ts"), "export const evil = 1;\n");
  const stateDir = join(dir, "state");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  // Short, owned, private O/S temp dir standing in for the trusted host
  // runner runtime dir (e.g. /run/user/<uid>).
  const runtimeDir = mkdtempSync(join(tmpdir(), "ad-rt-"));
  chmodSync(runtimeDir, 0o700);
  const executor = join(dir, "bin", "executor.mjs");
  write(
    executor,
    `#!${process.execPath}\nconsole.log('fixed executor');\n`,
    0o700,
  );
  const check = join(dir, "bin", "check.mjs");
  write(check, `#!${process.execPath}\nconsole.log('check-ok');\n`, 0o700);
  const depSource = join(dir, "dep-source");
  write(
    join(
      depSource,
      "node_modules",
      "better-sqlite3",
      "build",
      "Release",
      "better_sqlite3.node",
    ),
    "native-placeholder",
  );
  write(
    join(depSource, "node_modules", "better-sqlite3", "package.json"),
    '{"name":"better-sqlite3"}\n',
  );
  const config: AutodispatchConfig = {
    enabled: true,
    workspaceAlias: "companion-harness",
    sourceRoot: source,
    operations: ["investigate", "implement"],
    readScopes: ["src"],
    writeScopes: ["src"],
    checks: ["lint"],
    caps: CAPS,
    dependencyRoot: null,
    bridgeScriptPath: join(dir, "bridge.mjs"),
    bridgeConfigTemplatePath: join(dir, "bridge.template.json"),
    materialization: {
      stateDir,
      executionBackend: "offline-fixture",
      executor: { executable: executor, args: [] },
      checks: { lint: { executable: check, args: [] } },
      runtime: { nodeRealpath: process.execPath },
      dependencySourceNodeModules: join(depSource, "node_modules"),
      allowedTopLevelFiles: ["package.json"],
      maxDurationMs: 60_000,
      modelRoute: "local",
    },
  };
  return {
    dir,
    source,
    stateDir,
    runtimeDir,
    executor,
    check,
    depSource,
    config,
    cleanup: () => {
      removeTree(dir);
      removeTree(runtimeDir);
    },
  };
}

const PLAN = {
  id: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  policyId: "33333333-3333-4333-8333-333333333333",
  policyVersion: 1,
  revision: 1,
  planHash: "a".repeat(64),
  status: "frozen" as const,
  goal: "Implement the feature",
  decisions: [],
  nongoals: [],
  steps: ["edit src/app.ts"],
  acceptance: ["lint passes"],
  missing: [],
  relevantPaths: ["src/app.ts"],
  operation: "implement" as const,
  workspaceAlias: "companion-harness",
  intent: {
    kind: "execute" as const,
    quotes: [],
    latestUserTurnId: "44444444-4444-4444-8444-444444444444",
    latestUserRunId: "55555555-5555-4555-8555-555555555555",
    provenance: "user-conversation" as const,
  },
  sourceTurnId: "44444444-4444-4444-8444-444444444444",
  sourceRunId: "55555555-5555-4555-8555-555555555555",
  createdAt: NOW,
};

const POLICY = {
  id: "33333333-3333-4333-8333-333333333333",
  sessionId: "22222222-2222-4222-8222-222222222222",
  parentPurposeId: "66666666-6666-4666-8666-666666666666",
  workspaceAlias: "companion-harness",
  version: 1,
  status: "active" as const,
  operations: ["investigate", "implement"] as Array<
    "investigate" | "implement"
  >,
  readScopes: ["src"],
  writeScopes: ["src"],
  checks: ["lint"],
  caps: CAPS,
  expiresAt: null,
  revokedAt: null,
  createdAt: NOW,
};

const EXECUTION_ID = "77777777-7777-4777-8777-777777777777";

function materializerFor(fixture: Fixture, platform?: NodeJS.Platform) {
  return createAutodispatchMaterializer({
    config: fixture.config,
    runtimeDir: fixture.runtimeDir,
    currentModel: "test-model",
    available: true,
    enabled: true,
    disclosedWholeRepoRead: true,
    now: () => NOW,
    ...(platform === undefined ? {} : { platform }),
  });
}

linuxDescribe("autodispatch materializer (Linux)", () => {
  it("prepares an exact sealed snapshot/depot/profile and excludes secrets", async () => {
    const fx = makeFixture();
    try {
      const result = await materializerFor(fx).prepare({
        plan: PLAN,
        policy: POLICY,
        executionId: EXECUTION_ID,
        now: NOW,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const m = result.materialization;
      expect(m.profile.configFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(m.profile.sourceRevision).toMatch(/^[0-9a-f]{40}$/);
      expect(m.state.socketHostPath.startsWith(fx.runtimeDir)).toBe(true);
      expect(m.state.socketHostPath).not.toContain(
        join(fx.stateDir, "jobs", EXECUTION_ID),
      );
      expect(
        Buffer.byteLength(m.state.socketHostPath, "utf8"),
      ).toBeLessThanOrEqual(107);
      expect(m.state.socketDir.startsWith(fx.runtimeDir)).toBe(true);
      expect(statSync(m.state.socketDir).mode & 0o077).toBe(0);
      expect(m.state.dependencyDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(m.state.executorDigest).toMatch(/^[0-9a-f]{64}$/);
      const verified = await verifySealedWorkspaceSnapshot(
        {
          schemaVersion: 1,
          canonicalRoot: m.state.sourceRootCanonical,
          snapshotRoot: m.state.snapshotRoot,
          manifestPath: m.state.manifestPath,
          manifest: JSON.parse(readFileSync(m.state.manifestPath, "utf8"))
            .entries,
          manifestDigest: m.state.sourceManifestDigest,
          sourceIdentity: JSON.parse(readFileSync(m.state.manifestPath, "utf8"))
            .sourceIdentity,
          maxSourceBytes: 256 * 1024 * 1024,
          maxArtifactBytes: 256 * 1024,
          maxFiles: 20_000,
        },
        { expectedManifestDigest: m.state.sourceManifestDigest },
      );
      expect(verified.ok).toBe(true);
      const manifest = JSON.parse(
        readFileSync(m.state.manifestPath, "utf8"),
      ) as { entries: { path: string }[] };
      const paths = manifest.entries.map((entry) => entry.path);
      expect(paths).toContain("src/app.ts");
      expect(paths).toContain("package.json");
      expect(paths).not.toContain("src/.env");
      expect(paths).not.toContain(".env");
      expect(paths).not.toContain(".git/config");
      expect(paths).not.toContain("build/evil.ts");
      expect(await verifyAutodispatchMaterialization(m)).toEqual({ ok: true });
    } finally {
      fx.cleanup();
    }
  });

  it("binds a short private socket for a long state path and starts the real relay", async () => {
    const fx = makeFixture();
    try {
      const longStateDir = join(
        fx.dir,
        "very-long-state-segment-".repeat(6),
        "state",
      );
      mkdirSync(longStateDir, { recursive: true, mode: 0o700 });
      const config: AutodispatchConfig = {
        ...fx.config,
        materialization: {
          ...fx.config.materialization!,
          stateDir: longStateDir,
        },
      };
      const result = await createAutodispatchMaterializer({
        config,
        runtimeDir: fx.runtimeDir,
        currentModel: "test-model",
        available: true,
        enabled: true,
        disclosedWholeRepoRead: true,
        now: () => NOW,
      }).prepare({
        plan: PLAN,
        policy: POLICY,
        executionId: EXECUTION_ID,
        now: NOW,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const m = result.materialization;
      // The former (in-job) socket shape is over the Linux UDS bound; the
      // materialized bind must be short, private, and outside that job root.
      const former = join(
        longStateDir,
        "jobs",
        EXECUTION_ID,
        "run",
        "relay",
        "model.sock",
      );
      expect(Buffer.byteLength(former, "utf8")).toBeGreaterThan(107);
      expect(
        Buffer.byteLength(m.state.socketHostPath, "utf8"),
      ).toBeLessThanOrEqual(107);
      expect(m.state.runtimeDir).toBe(fx.runtimeDir);
      expect(dirname(m.state.socketHostPath)).toBe(m.state.socketDir);
      expect(m.state.socketHostPath.startsWith(longStateDir)).toBe(false);
      expect(statSync(m.state.socketDir).mode & 0o077).toBe(0);

      const relay = new TrialModelRelay({
        sockPath: m.state.socketHostPath,
        gateway: {
          provider: "openai-compatible",
          capabilities: { toolCalling: true },
          baseUrl: "http://127.0.0.1:9",
          chatUrl: "http://127.0.0.1:9/v1/chat/completions",
          async chat() {
            return { text: "stub", toolCalls: [], stopReason: "stop" as const };
          },
        } as unknown as ModelGateway,
        fixedModel: "test-model",
        caps: {
          maxRequestBytes: 1_048_576,
          maxModelCalls: 8,
          maxOutputTokens: 256,
          maxResponseBytes: 1_048_576,
          perCallTimeoutMs: 5_000,
          maxConcurrent: 1,
        },
      });
      // Real UDS bind on the exact materialized path, then quiescent cleanup
      // removes only this socket dir (never the trusted runtime dir).
      await relay.start();
      expect(statSync(m.state.socketHostPath).isSocket()).toBe(true);
      await relay.close();
      expect(existsSync(m.state.socketHostPath)).toBe(false);
      cleanupTerminalAutodispatchMaterialization(m, NOW + 1);
      expect(existsSync(m.state.socketDir)).toBe(false);
      expect(existsSync(fx.runtimeDir)).toBe(true);
    } finally {
      fx.cleanup();
    }
  });

  it("fails closed when the dependency depot is missing and rejects out-of-scope plans", async () => {
    const fx = makeFixture();
    try {
      const noDeps = {
        ...fx.config,
        materialization: {
          ...fx.config.materialization!,
          dependencySourceNodeModules: null,
        },
      } as AutodispatchConfig;
      const missing = await createAutodispatchMaterializer({
        config: noDeps,
        currentModel: "test-model",
        available: true,
        enabled: true,
        disclosedWholeRepoRead: true,
      }).prepare({ plan: PLAN, policy: POLICY, executionId: EXECUTION_ID });
      expect(missing.ok).toBe(false);
      if (!missing.ok) expect(missing.code).toBe("dependency_unavailable");

      const outside = await materializerFor(fx).prepare({
        plan: { ...PLAN, relevantPaths: ["docs/other.md"] },
        policy: POLICY,
        executionId: "88888888-8888-4888-8888-888888888888",
      });
      expect(outside.ok).toBe(false);
      if (!outside.ok) expect(outside.code).toBe("plan_scope_violation");
    } finally {
      fx.cleanup();
    }
  });

  it("rejects tampered snapshot/profile/depot before launch", async () => {
    const fx = makeFixture();
    try {
      const result = await materializerFor(fx).prepare({
        plan: PLAN,
        policy: POLICY,
        executionId: EXECUTION_ID,
        now: NOW,
      });
      if (!result.ok) throw new Error("prepare failed");
      const m = result.materialization;
      write(join(m.state.snapshotRoot, "src", "app.ts"), "tampered\n");
      const tamperedSnapshot = await verifyAutodispatchMaterialization(m);
      expect(tamperedSnapshot.ok).toBe(false);

      const result2 = await materializerFor({
        ...fx,
        config: fx.config,
      }).prepare({
        plan: PLAN,
        policy: POLICY,
        executionId: "99999999-9999-4999-8999-999999999999",
        now: NOW,
      });
      if (!result2.ok) throw new Error("prepare failed");
      const clone = JSON.parse(
        JSON.stringify(result2.materialization),
      ) as typeof result2.materialization;
      (clone.profile as { configFingerprint: string }).configFingerprint =
        "0".repeat(64);
      const tamperedProfile = await verifyAutodispatchMaterialization(clone);
      expect(tamperedProfile.ok).toBe(false);
    } finally {
      fx.cleanup();
    }
  });
});

async function openRepo(): Promise<{
  repo: KernelRepository;
  close: () => void;
}> {
  const dir = mkdtempSync(join(tmpdir(), "autodispatch-materializer-db-"));
  const handle = openKernelDatabase(join(dir, "db.sqlite"));
  await migrateKernelDatabase({ db: handle.raw });
  return {
    repo: createKernelRepository(handle.raw),
    close: () => {
      closeKernelDatabase(handle);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

linuxDescribe(
  "autodispatch materializer + existing ledger/runner resolver (Linux)",
  () => {
    it("persists the exact materialization with the grant and resolves it before claim", async () => {
      const fx = makeFixture();
      const db = await openRepo();
      try {
        const repo = db.repo;
        const ctl = repo.getAutonomyControlState();
        repo.setAutonomyControlState(
          { paused: false, expectedVersion: ctl.version },
          { key: randomUUID(), now: NOW },
        );
        const sessionId = repo.createSession({ key: randomUUID(), now: NOW })
          .body.sessionId;
        const posted = repo.postMessage(
          sessionId,
          { text: "Please implement the feature. Go ahead." },
          { key: randomUUID(), now: NOW + 10 },
        );
        repo.startRun(posted.body.run.id, { now: NOW + 11 });
        repo.completeRun(
          posted.body.run.id,
          { version: 1, text: "ok" } as never,
          { now: NOW + 12 },
        );
        const policy = repo.createAutodispatchPolicy(
          sessionId,
          {
            workspaceAlias: fx.config.workspaceAlias,
            operations: ["investigate", "implement"],
            readScopes: ["src"],
            writeScopes: ["src"],
            checks: ["lint"],
            caps: CAPS,
            expiresAt: null,
          },
          {
            key: randomUUID(),
            now: NOW + 20,
            limits: {
              operations: ["investigate", "implement"],
              checks: ["lint"],
              caps: CAPS,
            },
            parent: {
              statement: "Standing policy for the approved workspace",
              sourceTurnId: posted.body.turnId,
            },
          },
        );
        const planner: AutodispatchPlanner = {
          async propose(input) {
            return {
              operation: "implement",
              content: {
                goal: "Implement the accepted feature",
                decisions: [],
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
          },
        };
        const service = createAutodispatchService({
          repo,
          config: fx.config,
          profile: {
            available: true,
            enabled: true,
            mandatoryChecks: ["lint"],
            configFingerprint: "b".repeat(64),
            sourceRevision: "a".repeat(40),
            currentModel: "test-model",
            disclosedWholeRepoRead: true,
            timeoutMs: CAPS.timeoutMs,
            maxOutputBytes: CAPS.maxOutputBytes,
          },
          background: createBackgroundResourceGate(),
          planner,
          materializer: materializerFor(fx),
          maxOutputTokens: 256,
          now: () => NOW + 30,
        });
        service.onRunCompleted(posted.body.run.id);
        const deadline = Date.now() + 3000;
        let authorized:
          | ReturnType<KernelRepository["listAutodispatchExecutions"]>[number]
          | undefined;
        while (Date.now() < deadline) {
          authorized = repo
            .listAutodispatchExecutions(sessionId, 10)
            .find((item) => item.status === "authorized");
          if (authorized !== undefined) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(authorized).toBeDefined();
        expect(policy.status).toBe("active");
        expect(authorized?.executionId).not.toBeNull();
        expect(authorized?.materialization?.sourceManifestDigest).toMatch(
          /^[0-9a-f]{64}$/,
        );
        const resolved = await resolveAutodispatchMaterialization(
          repo,
          {
            workspaceAlias: fx.config.workspaceAlias,
            sourceRoot: fx.config.sourceRoot,
            dependencyRoot: null,
            checks: ["lint"],
          },
          {
            sessionId,
            executionId: authorized!.executionId!,
            proposalId: "",
          },
        );
        expect(resolved.kind).toBe("policy");
        if (resolved.kind === "policy") {
          expect(resolved.profile.configFingerprint).toMatch(/^[0-9a-f]{64}$/);
          expect(resolved.socketHostPath.startsWith(fx.runtimeDir)).toBe(true);
          expect(resolved.socketHostPath).not.toContain(
            join("jobs", authorized!.executionId!),
          );
          expect(statSync(resolved.runDir).isDirectory()).toBe(true);
        }
        await service.stop();
      } finally {
        db.close();
        fx.cleanup();
      }
    });
    it("uses the exact narrow non-whole-second policy timeout for profile, wire, and observed permit", async () => {
      const base = makeFixture();
      const fx: Fixture = {
        ...base,
        config: {
          ...base.config,
          materialization: {
            ...base.config.materialization!,
            maxDurationMs: 30_000,
          },
        },
      };
      // Policy is narrower than BOTH operator caps and not a whole second. The
      // actual profile/budget/observed unit must all be exactly 12_345ms.
      const narrowCaps = {
        ...CAPS,
        timeoutMs: 12_345,
      };
      const db = await openRepo();
      try {
        const repo = db.repo;
        const ctl = repo.getAutonomyControlState();
        repo.setAutonomyControlState(
          { paused: false, expectedVersion: ctl.version },
          { key: randomUUID(), now: NOW },
        );
        const sessionId = repo.createSession({ key: randomUUID(), now: NOW })
          .body.sessionId;
        const posted = repo.postMessage(
          sessionId,
          { text: "Please implement the feature. Go ahead." },
          { key: randomUUID(), now: NOW + 10 },
        );
        repo.startRun(posted.body.run.id, { now: NOW + 11 });
        repo.completeRun(
          posted.body.run.id,
          { version: 1, text: "ok" } as never,
          { now: NOW + 12 },
        );
        repo.createAutodispatchPolicy(
          sessionId,
          {
            workspaceAlias: fx.config.workspaceAlias,
            operations: ["investigate", "implement"],
            readScopes: ["src"],
            writeScopes: ["src"],
            checks: ["lint"],
            caps: narrowCaps,
            expiresAt: null,
          },
          {
            key: randomUUID(),
            now: NOW + 20,
            limits: {
              operations: ["investigate", "implement"],
              checks: ["lint"],
              caps: narrowCaps,
            },
            parent: {
              statement: "Standing policy for the approved workspace",
              sourceTurnId: posted.body.turnId,
            },
          },
        );
        const planner: AutodispatchPlanner = {
          async propose(input) {
            return {
              operation: "implement",
              content: {
                goal: "Implement the accepted feature",
                decisions: [],
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
          },
        };
        const service = createAutodispatchService({
          repo,
          config: fx.config,
          profile: {
            available: true,
            enabled: true,
            mandatoryChecks: ["lint"],
            configFingerprint: "b".repeat(64),
            sourceRevision: "a".repeat(40),
            currentModel: "test-model",
            disclosedWholeRepoRead: true,
            timeoutMs: CAPS.timeoutMs,
            maxOutputBytes: CAPS.maxOutputBytes,
          },
          background: createBackgroundResourceGate(),
          planner,
          materializer: materializerFor(fx),
          maxOutputTokens: 256,
          now: () => NOW + 30,
        });
        service.onRunCompleted(posted.body.run.id);
        const deadline = Date.now() + 3000;
        let executionId: string | null = null;
        while (Date.now() < deadline) {
          const item = repo
            .listAutodispatchExecutions(sessionId, 10)
            .find((entry) => entry.status === "authorized");
          if (item !== undefined) {
            executionId = item.executionId;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(executionId).not.toBeNull();
        const stored = repo.readAutodispatchMaterialization(
          sessionId,
          executionId as string,
        );
        const materialization = JSON.parse(
          stored?.materializationJson as string,
        ) as {
          profile: { timeoutMs: number };
          state: {
            jobRoot: string;
            runDir: string;
            snapshotRoot: string;
            dependencyRoot: string;
          };
        };
        expect(materialization.profile.timeoutMs).toBe(12_345);

        const identity = {
          pid: 5252,
          bootId: "boot-narrow",
          processStartTicks: "4242",
        };
        const exited = { current: false };
        const observer: TrialRunnerObserverFns = {
          expectedScopeUnit: (id: string) =>
            `capsule-${id}-${"c".repeat(64)}.scope`,
          queryScope: async () =>
            exited.current
              ? { scopeState: "gone" as const }
              : {
                  scopeState: "active" as const,
                  remainingRuntimeMs: 12_345,
                  // Exact unit bound: the wire budget below must match it.
                  runtimeMaxUsec: 12_345_000n,
                },
          readIdentity: async () => (exited.current ? "gone" : { ...identity }),
        };
        const relayFactory = (sockPath: string): TrialRunnerRelay => ({
          path: sockPath,
          setPermitted() {},
          revoke() {},
          async start() {},
          async close() {},
        });
        const spawnImpl = (() => {
          const child = new EventEmitter() as EventEmitter & {
            pid?: number;
            stdin: { write: (chunk: string) => void; end: () => void };
            stdout: EventEmitter;
            stderr: EventEmitter;
            stdio: unknown[];
            kill: () => void;
          };
          child.pid = identity.pid;
          child.stdin = { write() {}, end() {} };
          child.stdout = new EventEmitter();
          child.stderr = new EventEmitter();
          child.stdio = [
            child.stdin,
            child.stdout,
            child.stderr,
            { destroy() {} },
          ];
          child.kill = () => {
            exited.current = true;
            child.emit("exit", 1, null);
          };
          setTimeout(() => {
            exited.current = true;
            child.emit("exit", 1, null);
          }, 20);
          return child;
        }) as unknown as TrialRunnerSpawn;
        const { logger } = createCollectingLogger("debug");
        const runner = new TrialRunner({
          repo,
          config: {
            nodeRealpath: process.execPath,
            bridgeScriptPath: "/fake/bridge.mjs",
            bridgeConfigTemplatePath: "/fake/template.json",
            systemctlRealpath: "/usr/bin/systemctl",
            xdgRuntimeDir: "/run/user/1000",
            workspaceAlias: fx.config.workspaceAlias,
            profile: {
              available: true,
              enabled: true,
              mandatoryChecks: ["lint"],
              configFingerprint: "b".repeat(64),
              sourceRevision: "a".repeat(40),
              currentModel: "test-model",
              disclosedWholeRepoRead: true,
              timeoutMs: CAPS.timeoutMs,
              maxOutputBytes: CAPS.maxOutputBytes,
            },
            relayCaps: {
              maxRequestBytes: 1_048_576,
              maxModelCalls: 8,
              maxOutputTokens: 256,
              maxResponseBytes: 1_048_576,
              perCallTimeoutMs: 5_000,
              maxConcurrent: 1,
            },
            fixedModel: "test-model",
            gateway: {
              provider: "openai-compatible",
              capabilities: { toolCalling: true },
              baseUrl: "http://127.0.0.1:9",
              chatUrl: "http://127.0.0.1:9/v1/chat/completions",
              async chat() {
                return {
                  text: "stub",
                  toolCalls: [],
                  stopReason: "stop" as const,
                };
              },
            } as unknown as ModelGateway,
            observe: {
              activeTimeoutMs: 2_000,
              goneTimeoutMs: 2_000,
              pollIntervalMs: 5,
            },
            resolveMaterialization: (input) =>
              resolveAutodispatchMaterialization(
                repo,
                {
                  workspaceAlias: fx.config.workspaceAlias,
                  sourceRoot: fx.config.sourceRoot,
                  dependencyRoot: null,
                  checks: ["lint"],
                  runtimeDir: fx.runtimeDir,
                },
                input,
              ),
          },
          isForegroundBusy: () => false,
          logger,
          observer,
          createRelay: relayFactory,
          spawnImpl,
          clock: () => NOW + 100,
        });
        const result = await runner.runNext();
        expect(result.executionId).toBe(executionId);
        const intent = repo.readTrialLaunchIntent(
          sessionId,
          executionId as string,
        );
        if (intent.request === null)
          throw new Error("claimed launch intent request missing");
        expect(intent.request.budget.timeoutMs).toBe(12_345);
        expect(
          repo.readTrialLaunchPermit(sessionId, executionId as string),
        ).not.toBeNull();
        // Gone was observed before cleanup: heavy copies are reclaimed, the
        // small run dir + retention metadata stay for review.
        expect(existsSync(materialization.state.snapshotRoot)).toBe(false);
        expect(existsSync(materialization.state.dependencyRoot)).toBe(false);
        expect(existsSync(materialization.state.runDir)).toBe(true);
        expect(
          JSON.parse(
            readFileSync(
              join(materialization.state.jobRoot, "retention.json"),
              "utf8",
            ),
          ).status,
        ).toBe("cleaned");
        await service.stop();
      } finally {
        db.close();
        base.cleanup();
      }
    });

    it("retains active/unknown jobs and shared depots; terminal cleanup is idempotent", async () => {
      const fx = makeFixture();
      const db = await openRepo();
      try {
        const repo = db.repo;
        const activeExecution = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        const active = await materializerFor(fx).prepare({
          plan: PLAN,
          policy: POLICY,
          executionId: activeExecution,
          now: NOW,
        });
        if (!active.ok) throw new Error("prepare failed");
        const pruned = pruneAutodispatchMaterializations(
          repo,
          fx.config,
          NOW + 1,
        );
        expect(pruned.retained).toBe(1);
        expect(pruned.prepared).toBe(1);
        expect(existsSync(active.materialization.state.snapshotRoot)).toBe(
          true,
        );

        const terminalExecution = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        const terminal = await materializerFor(fx).prepare({
          plan: PLAN,
          policy: POLICY,
          executionId: terminalExecution,
          now: NOW + 2,
        });
        if (!terminal.ok) throw new Error("prepare failed");
        const sharedDepot = join(fx.dir, "shared-depot");
        write(join(sharedDepot, "node_modules", "pkg", "index.js"), "shared\n");
        const forged = {
          ...terminal.materialization,
          state: {
            ...terminal.materialization.state,
            dependencyRoot: sharedDepot,
          },
        };
        cleanupTerminalAutodispatchMaterialization(forged, NOW + 3);
        // Idempotent repeat (already removed heavy roots).
        cleanupTerminalAutodispatchMaterialization(forged, NOW + 4);
        expect(existsSync(terminal.materialization.state.snapshotRoot)).toBe(
          false,
        );
        expect(
          existsSync(join(sharedDepot, "node_modules", "pkg", "index.js")),
        ).toBe(true);
        expect(
          JSON.parse(
            readFileSync(
              join(terminal.materialization.state.jobRoot, "retention.json"),
              "utf8",
            ),
          ).status,
        ).toBe("cleaned");
      } finally {
        db.close();
        fx.cleanup();
      }
    });
  },
);

describe("unsupported host contract", () => {
  it.each(["darwin", "win32"] as const)(
    "fails closed on %s before any job output, grant, or host execution",
    async (platform) => {
      const fx = makeFixture();
      try {
        const result = await materializerFor(fx, platform).prepare({
          plan: PLAN,
          policy: POLICY,
          executionId: EXECUTION_ID,
          now: NOW,
        });
        expect(result).toMatchObject({
          ok: false,
          code: "unsupported_platform",
        });
        // No job/state tree and no relay socket were created, so no grant may
        // reference a fabricated materialization and no host child can launch.
        expect(existsSync(join(fx.stateDir, "jobs"))).toBe(false);
        expect(readdirSync(fx.runtimeDir)).toEqual([]);
      } finally {
        fx.cleanup();
      }
    },
  );
});
