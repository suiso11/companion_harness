// Behavioral tests for the per-execution auto-dispatch materializer.
// Real temp source/state, a fake operator fixed executor/check, a synthetic
// pinned "Pi" runtime path, and a real migrated kernel repository. No model,
// live Pi, production source, network, or user task is used.

import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
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
import { prepareDependencyClosure } from "../../../scripts/pi-orch-bridge/execution-profile.mjs";
import { verifyAutodispatchDependency } from "../src/autodispatch_dependencies.js";
import {
  type AutodispatchMaterialization,
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
  readonly config: AutodispatchConfig & {
    readonly materialization: NonNullable<
      AutodispatchConfig["materialization"]
    >;
  };
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

function postRelay(
  sockPath: string,
  body: string,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        socketPath: sockPath,
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

function relayChatBody(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    model: "companion/companion-current",
    messages: [{ role: "user", content: "hi" }],
    ...over,
  });
}

function relayTestGateway(
  onChat?: (options?: { signal?: AbortSignal }) => Promise<void> | void,
): ModelGateway & { calls: Array<{ maxOutputTokens?: number }> } {
  const calls: Array<{ maxOutputTokens?: number }> = [];
  return {
    calls,
    provider: "openai-compatible",
    capabilities: { toolCalling: true },
    baseUrl: "http://127.0.0.1:9",
    chatUrl: "http://127.0.0.1:9/v1/chat/completions",
    async chat(
      request: { maxOutputTokens?: number },
      options?: { signal?: AbortSignal },
    ) {
      calls.push(
        request.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: request.maxOutputTokens },
      );
      if (onChat !== undefined) await onChat(options);
      return { text: "hello", toolCalls: [], stopReason: "stop" as const };
    },
  } as unknown as ModelGateway & { calls: Array<{ maxOutputTokens?: number }> };
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
  const config = {
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
  } satisfies AutodispatchConfig & {
    readonly materialization: NonNullable<
      AutodispatchConfig["materialization"]
    >;
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
          ...fx.config.materialization,
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
          ...fx.config.materialization,
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
      const cloneMaterialization = () =>
        JSON.parse(
          JSON.stringify(result2.materialization),
        ) as typeof result2.materialization;
      // Each tamper starts from a FRESH valid clone: reusing a clone already
      // invalidated by the profile change would pass for the wrong reason.
      const profileClone = cloneMaterialization();
      (
        profileClone.profile as { configFingerprint: string }
      ).configFingerprint = "0".repeat(64);
      const tamperedProfile =
        await verifyAutodispatchMaterialization(profileClone);
      expect(tamperedProfile.ok).toBe(false);
      const budgetClone = cloneMaterialization();
      (budgetClone.budget as { maxModelCalls: number }).maxModelCalls = 9;
      const tamperedBudget =
        await verifyAutodispatchMaterialization(budgetClone);
      expect(tamperedBudget.ok).toBe(false);
    } finally {
      fx.cleanup();
    }
  });

  it("derives the policy∩operator relay budget and the real relay enforces it", async () => {
    const fx = makeFixture();
    try {
      const narrowPolicy = {
        ...POLICY,
        caps: {
          ...CAPS,
          maxModelCalls: 1,
          maxOutputTokens: 32,
          maxRequestBytes: 256,
          maxResponseBytes: 512,
        },
      };
      const result = await materializerFor(fx).prepare({
        plan: PLAN,
        policy: narrowPolicy,
        executionId: EXECUTION_ID,
        now: NOW,
      });
      if (!result.ok) throw new Error("prepare failed");
      const m = result.materialization;
      // Policy narrows the operator caps (1 < 8 etc.): never the reverse.
      expect(m.budget).toMatchObject({
        maxModelCalls: 1,
        maxOutputTokens: 32,
        maxRequestBytes: 256,
        maxResponseBytes: 512,
        perCallTimeoutMs: CAPS.perCallTimeoutMs,
        maxConcurrent: 1,
      });
      // The guest profile carries the same four frozen limits.
      expect(
        (m.config.profile.limits as Record<string, number>).maxModelCalls,
      ).toBe(1);
      expect(
        (m.config.profile.limits as Record<string, number>).maxOutputTokens,
      ).toBe(32);
      expect(
        (m.config.profile.limits as Record<string, number>).maxModelCallMs,
      ).toBe(CAPS.perCallTimeoutMs);
      expect(
        (m.config.profile.limits as Record<string, number>).modelConcurrency,
      ).toBe(1);

      const gw = relayTestGateway();
      const relay = new TrialModelRelay({
        sockPath: m.state.socketHostPath,
        gateway: gw,
        fixedModel: "test-model",
        caps: m.budget,
      });
      await relay.start();
      try {
        relay.setPermitted(true);
        const oversize = await postRelay(
          m.state.socketHostPath,
          relayChatBody({
            messages: [{ role: "user", content: "x".repeat(1024) }],
          }),
        );
        expect(oversize.status).toBe(413);
        expect(JSON.parse(oversize.text).error.message).toBe(
          "request_cap_exceeded",
        );
        expect(gw.calls.length).toBe(0);

        const first = await postRelay(m.state.socketHostPath, relayChatBody());
        expect(first.status).toBe(200);
        expect(gw.calls.length).toBe(1);
        // Frozen maxOutputTokens (32) is forwarded, not the operator 256.
        expect(gw.calls[0]?.maxOutputTokens).toBe(32);

        const second = await postRelay(m.state.socketHostPath, relayChatBody());
        expect(second.status).toBe(429);
        expect(JSON.parse(second.text).error.message).toBe(
          "model_call_cap_exceeded",
        );
        expect(gw.calls.length).toBe(1);
      } finally {
        await relay.close();
      }
    } finally {
      fx.cleanup();
    }
  });

  it("frozen concurrency 1 rejects a second overlapping relay call until the first settles", async () => {
    const fx = makeFixture();
    try {
      const config: AutodispatchConfig = {
        ...fx.config,
        caps: { ...CAPS, maxConcurrent: 4 },
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
        policy: { ...POLICY, caps: { ...CAPS, maxConcurrent: 1 } },
        executionId: EXECUTION_ID,
        now: NOW,
      });
      if (!result.ok) throw new Error("prepare failed");
      const m = result.materialization;
      expect(m.budget.maxConcurrent).toBe(1);

      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const gw = relayTestGateway(() => gate);
      const relay = new TrialModelRelay({
        sockPath: m.state.socketHostPath,
        gateway: gw,
        fixedModel: "test-model",
        caps: m.budget,
      });
      await relay.start();
      try {
        relay.setPermitted(true);
        const first = postRelay(m.state.socketHostPath, relayChatBody());
        const deadline = Date.now() + 2000;
        while (gw.calls.length === 0 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        expect(gw.calls.length).toBe(1);
        const second = await postRelay(m.state.socketHostPath, relayChatBody());
        expect(second.status).toBe(429);
        expect(JSON.parse(second.text).error.message).toBe("relay_busy");
        release?.();
        expect((await first).status).toBe(200);
      } finally {
        await relay.close();
      }
    } finally {
      fx.cleanup();
    }
  });

  it("frozen per-call timeout aborts the actual relay request at the narrowed 100ms", async () => {
    const fx = makeFixture();
    try {
      const result = await materializerFor(fx).prepare({
        plan: PLAN,
        policy: { ...POLICY, caps: { ...CAPS, perCallTimeoutMs: 100 } },
        executionId: EXECUTION_ID,
        now: NOW,
      });
      if (!result.ok) throw new Error("prepare failed");
      const m = result.materialization;
      expect(m.budget.perCallTimeoutMs).toBe(100);
      expect(
        (m.config.profile.limits as Record<string, number>).maxModelCallMs,
      ).toBe(100);
      const gw = relayTestGateway(
        (options) =>
          new Promise<void>((_resolve, reject) => {
            options?.signal?.addEventListener(
              "abort",
              () => reject(new Error("aborted")),
              { once: true },
            );
          }),
      );
      const relay = new TrialModelRelay({
        sockPath: m.state.socketHostPath,
        gateway: gw,
        fixedModel: "test-model",
        caps: m.budget,
      });
      await relay.start();
      try {
        relay.setPermitted(true);
        const started = Date.now();
        const res = await postRelay(m.state.socketHostPath, relayChatBody());
        const elapsed = Date.now() - started;
        expect(res.status).toBe(504);
        expect(JSON.parse(res.text).error.message).toBe("model_timeout");
        expect(elapsed).toBeLessThan(2_000);
        expect(gw.calls.length).toBe(1);
      } finally {
        await relay.close();
      }
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

/** Real session/policy/frozen plan used as the genuine human source for
 * cleanup regressions. Each caller gets its own session/policy so real
 * authorize/revoke calls never conflict with daily/concurrent quotas. */
async function seedAutodispatchLedger(
  repo: KernelRepository,
  config: Fixture["config"],
) {
  const ctl = repo.getAutonomyControlState();
  repo.setAutonomyControlState(
    { paused: false, expectedVersion: ctl.version },
    { key: randomUUID(), now: NOW },
  );
  const sessionId = repo.createSession({ key: randomUUID(), now: NOW }).body
    .sessionId;
  const posted = repo.postMessage(
    sessionId,
    { text: "Please implement the feature. Go ahead." },
    { key: randomUUID(), now: NOW + 10 },
  );
  repo.startRun(posted.body.run.id, { now: NOW + 11 });
  repo.completeRun(posted.body.run.id, { version: 1, text: "ok" } as never, {
    now: NOW + 12,
  });
  const policy = repo.createAutodispatchPolicy(
    sessionId,
    {
      workspaceAlias: config.workspaceAlias,
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
  const plan = repo.createAutodispatchPlan(
    sessionId,
    {
      policyId: policy.id,
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
            turnId: posted.body.turnId,
            runId: posted.body.run.id,
            text: "implement the feature",
          },
        ],
        latestUserTurnId: posted.body.turnId,
        latestUserRunId: posted.body.run.id,
      },
    },
    { now: NOW + 30 },
  ).plan;
  return {
    sessionId,
    policy,
    plan,
    runId: posted.body.run.id,
    turnId: posted.body.turnId,
  };
}

type SeededAutodispatch = Awaited<ReturnType<typeof seedAutodispatchLedger>>;

/** Prepare real bytes for an already-frozen human plan. */
async function prepareRealJob(
  fx: Fixture,
  seed: SeededAutodispatch,
  now: number,
): Promise<AutodispatchMaterialization> {
  const prepared = await materializerFor(fx).prepare({
    plan: seed.plan,
    policy: seed.policy,
    executionId: randomUUID(),
    now,
  });
  if (!prepared.ok) throw new Error(`prepare failed: ${prepared.code}`);
  return prepared.materialization;
}

/** Create the actual one-use grant bound to the exact prepared bytes. */
function authorizePreparedJob(
  repo: KernelRepository,
  seed: SeededAutodispatch,
  materialization: AutodispatchMaterialization,
  now: number,
): void {
  const authorized = repo.authorizeAutodispatch(seed.sessionId, seed.plan.id, {
    profile: materialization.profile,
    workspaceAlias: seed.policy.workspaceAlias,
    limits: {
      operations: ["investigate", "implement"],
      checks: ["lint"],
      caps: CAPS,
    },
    executionId: materialization.reference.executionId,
    dependencyDigest: materialization.state.dependencyDigest,
    materialization,
    materializationDigest: materialization.digests.materialization,
    now,
  });
  if (authorized.execution.status !== "authorized") {
    throw new Error(`authorize failed: ${authorized.execution.status}`);
  }
}

/** Claim through the real lifecycle so claimed/boot evidence is authentic. */
function claimPreparedJob(
  repo: KernelRepository,
  seed: SeededAutodispatch,
  materialization: AutodispatchMaterialization,
  now: number,
): void {
  repo.claimTrial(seed.sessionId, materialization.reference.executionId, {
    key: randomUUID(),
    now,
    profile: materialization.profile,
    workspaceAlias: seed.policy.workspaceAlias,
  });
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
        const authorizedExecutionId = authorized?.executionId;
        expect(authorizedExecutionId).not.toBeNull();
        if (
          authorizedExecutionId === undefined ||
          authorizedExecutionId === null
        ) {
          throw new Error("authorized execution missing");
        }
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
            executionId: authorizedExecutionId,
            proposalId: "",
          },
        );
        expect(resolved.kind).toBe("policy");
        if (resolved.kind === "policy") {
          expect(resolved.profile.configFingerprint).toMatch(/^[0-9a-f]{64}$/);
          expect(resolved.socketHostPath.startsWith(fx.runtimeDir)).toBe(true);
          expect(resolved.socketHostPath).not.toContain(
            join("jobs", authorizedExecutionId),
          );
          expect(statSync(resolved.runDir).isDirectory()).toBe(true);
        }
        await service.stop();
      } finally {
        db.close();
        fx.cleanup();
      }
    });
    it("enforces the materialized 1-call policy through the production runner relay", async () => {
      const base = makeFixture();
      const fx: Fixture = {
        ...base,
        config: {
          ...base.config,
          materialization: {
            ...base.config.materialization,
            maxDurationMs: 30_000,
          },
        },
      };
      // Narrow policy: exactly one model call, non-whole-second timeout. The
      // production TrialRunner must default-construct the REAL relay (no
      // injected/fake factory) and pass the materialized budget through.
      const narrowCaps = {
        ...CAPS,
        maxModelCalls: 1,
        timeoutMs: 12_345,
      };
      const childScript = join(fx.dir, "trial-child.mjs");
      write(
        childScript,
        [
          'import { readFileSync, writeFileSync } from "node:fs";',
          'import { request } from "node:http";',
          'import { dirname, join } from "node:path";',
          "const configPath = process.argv[process.argv.length - 1];",
          'const config = JSON.parse(readFileSync(configPath, "utf8"));',
          "const sockPath = config.profile.model.sockHostPath;",
          'const req = JSON.parse(readFileSync(0, "utf8").trim());',
          "function post() {",
          "  return new Promise((resolve, reject) => {",
          '    const body = JSON.stringify({ model: "companion/companion-current", messages: [{ role: "user", content: "hi" }] });',
          '    const r = request({ socketPath: sockPath, path: "/v1/chat/completions", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => {',
          "      const chunks = [];",
          '      res.on("data", (c) => chunks.push(c));',
          '      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));',
          "    });",
          '    r.on("error", reject);',
          "    r.end(body);",
          "  });",
          "}",
          "const first = await post();",
          "const second = await post();",
          'writeFileSync(join(dirname(configPath), "child-requests.json"), JSON.stringify({ first, second }));',
          'const checks = (req.requiredChecks || ["lint"]).map((id) => ({ id, ok: true }));',
          'process.stdout.write(JSON.stringify({ taskHash: req.taskHash, exitCode: 0, checks, outputMatched: true, noTimeout: true }) + "\\n");',
        ].join("\n"),
      );
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
        if (executionId === null) throw new Error("execution missing");
        const stored = repo.readAutodispatchMaterialization(
          sessionId,
          executionId,
        );
        const materialization = JSON.parse(
          stored?.materializationJson as string,
        ) as {
          profile: { timeoutMs: number };
          budget: {
            maxModelCalls: number;
            perCallTimeoutMs: number;
            maxConcurrent: number;
          };
          state: {
            jobRoot: string;
            runDir: string;
            snapshotRoot: string;
            dependencyRoot: string;
          };
        };
        expect(materialization.profile.timeoutMs).toBe(12_345);
        expect(materialization.budget.maxModelCalls).toBe(1);

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
        const gatewayCalls: number[] = [];
        const spawnImpl = ((
          command: string,
          args: string[],
          options: unknown,
        ) => {
          const child = nodeSpawn(command, args, options as never);
          child.once("exit", () => {
            exited.current = true;
          });
          return child;
        }) as unknown as TrialRunnerSpawn;
        const { logger } = createCollectingLogger("debug");
        const runner = new TrialRunner({
          repo,
          config: {
            nodeRealpath: process.execPath,
            bridgeScriptPath: childScript,
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
            // Deliberately the static operator ceiling (8): the runner must
            // use the materialized policy budget (1) instead.
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
                gatewayCalls.push(Date.now());
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
          spawnImpl,
          clock: () => NOW + 100,
        });
        const result = await runner.runNext();
        expect(result.executionId).toBe(executionId);
        expect(result.authorized).toBe(true);
        expect(result.outcome).toBe("done");
        // The real child made two actual OpenAI requests over the resolved
        // materialized UDS: the first forwarded, the second hit the frozen
        // 1-call consumer cap (429), and the real gateway was called once.
        const childRequests = JSON.parse(
          readFileSync(
            join(materialization.state.runDir, "child-requests.json"),
            "utf8",
          ),
        ) as {
          first: { status: number; body: string };
          second: { status: number; body: string };
        };
        expect(childRequests.first.status).toBe(200);
        expect(childRequests.second.status).toBe(429);
        expect(
          (
            JSON.parse(childRequests.second.body) as {
              error: { message: string };
            }
          ).error.message,
        ).toBe("model_call_cap_exceeded");
        expect(gatewayCalls).toHaveLength(1);

        const intent = repo.readTrialLaunchIntent(sessionId, executionId);
        if (intent.request === null)
          throw new Error("claimed launch intent request missing");
        expect(intent.request.budget.timeoutMs).toBe(12_345);
        expect(
          repo.readTrialLaunchPermit(sessionId, executionId),
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

    it("collapses nested snapshot roots without widening policy write scopes", async () => {
      const fx = makeFixture();
      try {
        write(
          join(fx.source, "src", "feature", "app.ts"),
          "export const feature = 1;\n",
        );
        const config = {
          ...fx.config,
          readScopes: ["src"],
          writeScopes: ["src/feature"],
        };
        const materializer = createAutodispatchMaterializer({
          config,
          runtimeDir: fx.runtimeDir,
          currentModel: "test-model",
          available: true,
          enabled: true,
          disclosedWholeRepoRead: true,
          now: () => NOW,
        });
        const result = await materializer.prepare({
          plan: { ...PLAN, relevantPaths: ["src/feature/app.ts"] },
          policy: POLICY,
          executionId: randomUUID(),
          now: NOW,
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const materialization = result.materialization;
        const manifest = JSON.parse(
          readFileSync(materialization.state.manifestPath, "utf8"),
        ) as { entries: { path: string }[] };
        const paths = manifest.entries.map((entry) => entry.path);
        // read src + write src/feature is copied as the approved ancestor
        // once, not as overlapping roots (which used to reject the plan).
        expect(paths.filter((path) => path === "src/app.ts")).toHaveLength(1);
        expect(
          paths.filter((path) => path === "src/feature/app.ts"),
        ).toHaveLength(1);
        // Snapshot collapse must not collapse the separate policy scopes,
        // plan paths, or check authority.
        expect(materialization.config.profile.allowedPaths).toEqual(
          expect.arrayContaining(["src", "src/feature"]),
        );
        expect(materialization.profile.mandatoryChecks).toEqual(["lint"]);
      } finally {
        fx.cleanup();
      }
    });

    it("prepares a literal file read scope with only that file and top-level files", async () => {
      const fx = makeFixture();
      try {
        const materializer = createAutodispatchMaterializer({
          config: {
            ...fx.config,
            readScopes: ["src/app.ts"],
            writeScopes: [],
          },
          runtimeDir: fx.runtimeDir,
          currentModel: "test-model",
          available: true,
          enabled: true,
          disclosedWholeRepoRead: true,
          now: () => NOW,
        });
        const result = await materializer.prepare({
          plan: {
            ...PLAN,
            operation: "investigate",
            relevantPaths: ["src/app.ts"],
          },
          policy: {
            ...POLICY,
            readScopes: ["src/app.ts"],
            writeScopes: [],
          },
          executionId: randomUUID(),
          now: NOW,
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const manifest = JSON.parse(
          readFileSync(result.materialization.state.manifestPath, "utf8"),
        ) as { entries: { path: string }[] };
        expect(manifest.entries.map((entry) => entry.path)).toEqual([
          "package.json",
          "src/app.ts",
        ]);
      } finally {
        fx.cleanup();
      }
    });

    it("collapses a literal file scope under a directory scope and keeps the directory", async () => {
      const fx = makeFixture();
      try {
        const materializer = createAutodispatchMaterializer({
          config: {
            ...fx.config,
            readScopes: ["src/app.ts"],
            writeScopes: ["src"],
          },
          runtimeDir: fx.runtimeDir,
          currentModel: "test-model",
          available: true,
          enabled: true,
          disclosedWholeRepoRead: true,
          now: () => NOW,
        });
        const result = await materializer.prepare({
          plan: { ...PLAN, operation: "implement" },
          policy: {
            ...POLICY,
            readScopes: ["src/app.ts"],
            writeScopes: ["src"],
          },
          executionId: randomUUID(),
          now: NOW,
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const manifest = JSON.parse(
          readFileSync(result.materialization.state.manifestPath, "utf8"),
        ) as { entries: { path: string }[] };
        const paths = manifest.entries.map((entry) => entry.path);
        // The file scope is covered by the directory scope, while the
        // directory itself is never collapsed under a file scope.
        expect(paths.filter((path) => path === "src/app.ts")).toHaveLength(1);
        expect(paths).toContain("src/nested/deep.ts");
      } finally {
        fx.cleanup();
      }
    });

    it("materializes pnpm links whose copied packages real Node can import, with .pnpm native evidence", async () => {
      const fx = makeFixture();
      const sourceRoot = mkdtempSync(join(tmpdir(), "pnpm-closure-"));
      const escapeSource = mkdtempSync(join(tmpdir(), "pnpm-escape-"));
      const outside = mkdtempSync(join(tmpdir(), "pnpm-outside-"));
      const destinationRoot = join(fx.dir, "pnpm-destination");
      const escapeDestination = join(fx.dir, "pnpm-escape-destination");
      try {
        const nm = join(sourceRoot, "node_modules");
        write(
          join(
            nm,
            ".pnpm",
            "example@1.0.0",
            "node_modules",
            "example",
            "package.json",
          ),
          '{"name":"example","type":"module"}\n',
        );
        write(
          join(
            nm,
            ".pnpm",
            "example@1.0.0",
            "node_modules",
            "example",
            "index.js",
          ),
          'import { scoped } from "@scope/dep";\nexport const value = 42;\nexport { scoped };\n',
        );
        write(
          join(
            nm,
            ".pnpm",
            "@scope+dep@1.0.0",
            "node_modules",
            "@scope",
            "dep",
            "package.json",
          ),
          '{"name":"@scope/dep","type":"module"}\n',
        );
        write(
          join(
            nm,
            ".pnpm",
            "@scope+dep@1.0.0",
            "node_modules",
            "@scope",
            "dep",
            "index.js",
          ),
          'export const scoped = "dep";\n',
        );
        mkdirSync(
          join(nm, ".pnpm", "example@1.0.0", "node_modules", "@scope"),
          { recursive: true, mode: 0o700 },
        );
        symlinkSync(
          "../../../@scope+dep@1.0.0/node_modules/@scope/dep",
          join(nm, ".pnpm", "example@1.0.0", "node_modules", "@scope", "dep"),
        );
        write(
          join(
            nm,
            ".pnpm",
            "@scope+pkg@1.0.0",
            "node_modules",
            "@scope",
            "pkg",
            "package.json",
          ),
          '{"name":"@scope/pkg","type":"module"}\n',
        );
        write(
          join(
            nm,
            ".pnpm",
            "@scope+pkg@1.0.0",
            "node_modules",
            "@scope",
            "pkg",
            "index.js",
          ),
          'export const pkg = "pkg";\n',
        );
        write(
          join(
            nm,
            ".pnpm",
            "better-sqlite3@1.0.0",
            "node_modules",
            "better-sqlite3",
            "package.json",
          ),
          '{"name":"better-sqlite3","version":"1.0.0"}\n',
        );
        write(
          join(
            nm,
            ".pnpm",
            "better-sqlite3@1.0.0",
            "node_modules",
            "better-sqlite3",
            "build",
            "Release",
            "better_sqlite3.node",
          ),
          "native-pnpm-placeholder",
        );
        symlinkSync(
          ".pnpm/example@1.0.0/node_modules/example",
          join(nm, "example"),
        );
        mkdirSync(join(nm, "@scope"), { recursive: true, mode: 0o700 });
        symlinkSync(
          "../.pnpm/@scope+pkg@1.0.0/node_modules/@scope/pkg",
          join(nm, "@scope", "pkg"),
        );
        symlinkSync(
          ".pnpm/better-sqlite3@1.0.0/node_modules/better-sqlite3",
          join(nm, "better-sqlite3"),
        );

        const prepared = prepareDependencyClosure({
          sourceNodeModules: nm,
          destinationRoot,
          nodeRealpath: process.execPath,
          maxBytes: 10 * 1024 * 1024,
          maxEntries: 10_000,
        });
        const native = prepared.nativeModules.find(
          (entry) => entry.package === "better-sqlite3",
        );
        const expectedNativePath =
          "node_modules/.pnpm/better-sqlite3@1.0.0/node_modules/better-sqlite3/build/Release/better_sqlite3.node";
        expect(native?.path).toBe(expectedNativePath);
        expect(native?.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(existsSync(join(prepared.root, expectedNativePath))).toBe(true);
        // The real consumer accepts the canonical .pnpm path and re-hashes it.
        expect(verifyAutodispatchDependency(prepared.root)).toMatchObject({
          ok: true,
        });

        // Actual Node imports through the copied root symlink, a scoped
        // root symlink, and the package's transitive scoped link.
        const example = await import(
          `${pathToFileURL(join(prepared.root, "node_modules", "example", "index.js")).href}?v=${randomUUID()}`
        );
        expect(example.value).toBe(42);
        expect(example.scoped).toBe("dep");
        const scoped = await import(
          `${pathToFileURL(join(prepared.root, "node_modules", "@scope", "pkg", "index.js")).href}?v=${randomUUID()}`
        );
        expect(scoped.pkg).toBe("pkg");

        // Escaping links remain rejected; no external workspace allowance.
        const escapeNm = join(escapeSource, "node_modules");
        mkdirSync(escapeNm, { recursive: true, mode: 0o700 });
        write(join(outside, "index.js"), "export const escaped = 1;\n");
        symlinkSync(outside, join(escapeNm, "escape"));
        expect(() =>
          prepareDependencyClosure({
            sourceNodeModules: escapeNm,
            destinationRoot: escapeDestination,
            nodeRealpath: process.execPath,
          }),
        ).toThrow(/escapes the approved depot/);
      } finally {
        removeTree(sourceRoot);
        removeTree(escapeSource);
        removeTree(outside);
        removeTree(destinationRoot);
        removeTree(escapeDestination);
        fx.cleanup();
      }
    });

    it("immediately expires revoked never-launched jobs and frees admission capacity", async () => {
      const fx = makeFixture();
      const db = await openRepo();
      try {
        const materializations: AutodispatchMaterialization[] = [];
        for (let index = 0; index < 20; index += 1) {
          // A fresh human session/policy/plan per job keeps the real daily
          // and concurrent quota honest instead of bypassing it.
          const seed = await seedAutodispatchLedger(db.repo, fx.config);
          const at = NOW + 100 + index * 10;
          const materialization = await prepareRealJob(fx, seed, at);
          authorizePreparedJob(db.repo, seed, materialization, at + 1);
          db.repo.revokeAutodispatchPolicy(seed.sessionId, seed.policy.id, {
            now: at + 2,
            reason: "test cancellation",
          });
          materializations.push(materialization);
        }
        const pruned = pruneAutodispatchMaterializations(
          db.repo,
          fx.config,
          NOW + 1000,
        );
        expect(pruned).toEqual({
          cleaned: 0,
          expired: 20,
          retained: 0,
          prepared: 0,
        });
        for (const materialization of materializations) {
          expect(existsSync(materialization.state.snapshotRoot)).toBe(false);
          expect(existsSync(materialization.state.dependencyRoot)).toBe(false);
          expect(existsSync(materialization.state.runDir)).toBe(false);
          expect(
            existsSync(join(materialization.state.jobRoot, "bridge-state")),
          ).toBe(false);
          expect(existsSync(materialization.state.socketDir)).toBe(false);
          expect(
            JSON.parse(
              readFileSync(
                join(materialization.state.jobRoot, "retention.json"),
                "utf8",
              ),
            ).status,
          ).toBe("artifact-expired");
        }
        // Original source and the operator/shared dependency source are
        // never touched by reclamation.
        expect(
          readFileSync(join(fx.source, "src", "app.ts"), "utf8"),
        ).toContain("export const app");
        expect(
          readFileSync(
            join(
              fx.depSource,
              "node_modules",
              "better-sqlite3",
              "build",
              "Release",
              "better_sqlite3.node",
            ),
            "utf8",
          ),
        ).toBe("native-placeholder");

        // Admission capacity is free now, not after the retained window.
        // prepare() alone does not enforce admission, so run the REAL service
        // intake (prune -> prepare -> authorize) on a fresh completed human
        // turn and observe the actual authorized grant.
        const nextSeed = await seedAutodispatchLedger(db.repo, fx.config);
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
          repo: db.repo,
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
          now: () => NOW + 2000,
        });
        service.onRunCompleted(nextSeed.runId);
        const deadline = Date.now() + 3000;
        let admitted:
          | ReturnType<KernelRepository["listAutodispatchExecutions"]>[number]
          | undefined;
        while (Date.now() < deadline) {
          admitted = db.repo
            .listAutodispatchExecutions(nextSeed.sessionId, 10)
            .find((item) => item.status === "authorized");
          if (admitted !== undefined) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(admitted?.status).toBe("authorized");
        expect(admitted?.executionId).not.toBeNull();
        await service.stop();
      } finally {
        db.close();
        fx.cleanup();
      }
    });

    it("holds revoked jobs with claimed/restart/boot/unknown-worker evidence", async () => {
      const fx = makeFixture();
      const db = await openRepo();
      try {
        const materializations: AutodispatchMaterialization[] = [];
        let tick = NOW + 100;
        const addCancelled = async (
          mode: "claimed" | "boot" | "restart",
        ): Promise<void> => {
          const seed = await seedAutodispatchLedger(db.repo, fx.config);
          const materialization = await prepareRealJob(fx, seed, tick++);
          authorizePreparedJob(db.repo, seed, materialization, tick++);
          claimPreparedJob(db.repo, seed, materialization, tick++);
          if (mode !== "claimed") {
            const pid = 4100 + materializations.length;
            db.repo.registerTrialWorkerBoot(
              {
                executionId: materialization.reference.executionId,
                sessionId: seed.sessionId,
                pid,
                bootId: `boot-cleanup-${materializations.length}`,
                processStartTicks: String(pid),
              },
              tick++,
            );
          }
          if (mode === "restart") {
            // The real restart-recovery boundary must not erase in-flight
            // worker evidence; cleanup still has to hold.
            db.repo.recover({ now: tick++ });
          }
          db.repo.revokeAutodispatchPolicy(seed.sessionId, seed.policy.id, {
            now: tick++,
            reason: "test cancellation",
          });
          materializations.push(materialization);
        };
        await addCancelled("claimed");
        await addCancelled("boot");
        await addCancelled("restart");
        // Materialized bytes with no ledger grant at all (crash window before
        // authorize) are unknown, not proof of an unlaunched worker.
        const unknownSeed = await seedAutodispatchLedger(db.repo, fx.config);
        materializations.push(await prepareRealJob(fx, unknownSeed, tick++));

        const pruned = pruneAutodispatchMaterializations(
          db.repo,
          fx.config,
          NOW + 1000,
        );
        expect(pruned).toEqual({
          cleaned: 0,
          expired: 0,
          retained: 4,
          prepared: 4,
        });
        for (const materialization of materializations) {
          expect(existsSync(materialization.state.snapshotRoot)).toBe(true);
          expect(existsSync(materialization.state.dependencyRoot)).toBe(true);
          expect(existsSync(materialization.state.socketDir)).toBe(true);
          expect(
            JSON.parse(
              readFileSync(
                join(materialization.state.jobRoot, "retention.json"),
                "utf8",
              ),
            ).status,
          ).toBe("prepared");
        }
      } finally {
        db.close();
        fx.cleanup();
      }
    });

    it("does not let expired audit tombstones consume retained-artifact admission", async () => {
      const fx = makeFixture();
      const db = await openRepo();
      try {
        const repo = db.repo;
        const jobsRoot = join(fx.stateDir, "jobs");
        mkdirSync(jobsRoot, { recursive: true, mode: 0o700 });
        for (let i = 0; i < 25; i += 1) {
          const executionId = `expired-audit-${i}`;
          const jobRoot = join(jobsRoot, executionId);
          mkdirSync(jobRoot, { recursive: true, mode: 0o700 });
          write(
            join(jobRoot, "retention.json"),
            JSON.stringify({
              schemaVersion: 1,
              executionId,
              sessionId: "tombstone-session",
              createdAt: NOW,
              status: "artifact-expired",
              expiredAt: NOW,
            }),
          );
        }
        const pruned = pruneAutodispatchMaterializations(
          repo,
          fx.config,
          NOW + 100,
        );
        // Tombstones are audit-only and free capacity; they are not
        // "re-expired" on every prune.
        expect(pruned.retained).toBe(0);
        expect(pruned.expired).toBe(0);
        expect(
          readFileSync(
            join(jobsRoot, "expired-audit-0", "retention.json"),
            "utf8",
          ),
        ).toContain("artifact-expired");

        const validExecution = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
        const valid = await materializerFor(fx).prepare({
          plan: PLAN,
          policy: POLICY,
          executionId: validExecution,
          now: NOW + 200,
        });
        if (!valid.ok) throw new Error("prepare failed");
        const after = pruneAutodispatchMaterializations(
          repo,
          fx.config,
          NOW + 300,
        );
        // A genuinely prepared active job still counts and is retained.
        expect(after.retained).toBe(1);
        expect(after.prepared).toBe(1);
        expect(existsSync(valid.materialization.state.snapshotRoot)).toBe(true);
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
