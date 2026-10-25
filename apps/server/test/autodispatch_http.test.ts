// Conversation -> plan -> standing-policy -> EXISTING trial grant, through
// the real Hono app, real migrated DB, and the real kernel repository. The
// model/planner and bridge are synthetic: this makes no claim about a real
// Pi dependency adapter, real model, or production runtime.

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TrialProfileSnapshot } from "@companion/contracts";
import {
  closeKernelDatabase,
  createKernelRepository,
  type KernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
  RunEngine,
} from "@companion/kernel";
import { describe, expect, it } from "vitest";
import { type CreatedServerApp, createApp } from "../src/app.js";
import {
  type AutodispatchPlanner,
  createAutodispatchService,
} from "../src/autodispatch_service.js";
import {
  type BackgroundResourceGate,
  createBackgroundResourceGate,
} from "../src/background_resource.js";
import { type AutodispatchConfig, loadServerConfig } from "../src/config.js";
import { createCollectingLogger } from "../src/logger.js";

const linuxIt = process.platform === "linux" ? it : it.skip;

const FP = "b".repeat(64);
const REV = "a".repeat(40);
const NOW = 1_760_000_000_000;

function envConfig(): NodeJS.ProcessEnv {
  const trial = {
    available: true,
    enabled: true,
    mandatoryChecks: ["lint"],
    configFingerprint: FP,
    sourceRevision: REV,
    currentModel: "test-model",
    disclosedWholeRepoRead: true,
    timeoutMs: 60000,
    maxOutputBytes: 1000000,
    workspaceAlias: "companion-harness",
    runner: {
      nodeRealpath: "/usr/bin/node",
      bridgeScriptPath: "/opt/bridge.mjs",
      bridgeConfigTemplatePath: "/opt/bridge.template.json",
      systemctlRealpath: "/usr/bin/systemctl",
      xdgRuntimeDir: "/run/user/1000",
      relay: {
        maxRequestBytes: 1048576,
        maxModelCalls: 8,
        maxOutputTokens: 256,
        maxResponseBytes: 1048576,
        perCallTimeoutMs: 5000,
        maxConcurrent: 1,
      },
      observe: {
        activeTimeoutMs: 5000,
        goneTimeoutMs: 5000,
        pollIntervalMs: 50,
      },
      pollMs: 500,
    },
  };
  const autodispatch = {
    enabled: true,
    workspaceAlias: "companion-harness",
    sourceRoot: "/synthetic/source",
    operations: ["investigate", "implement"],
    readScopes: ["src", "docs"],
    writeScopes: ["src"],
    checks: ["lint"],
    caps: {
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
    },
    dependencyRoot: "/synthetic/deps",
    bridgeScriptPath: "/opt/bridge.mjs",
    bridgeConfigTemplatePath: "/opt/bridge.template.json",
  };
  return {
    COMPANION_DB_PATH: join(
      mkdtempSync(join(tmpdir(), "companion-autodispatch-")),
      "db.sqlite",
    ),
    COMPANION_HOST: "127.0.0.1",
    COMPANION_PORT: "3000",
    COMPANION_TIME_ZONE: "UTC",
    COMPANION_LOG_LEVEL: "debug",
    COMPANION_MODEL_JSON: JSON.stringify({
      adapter: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      model: "test-model",
    }),
    COMPANION_AUTONOMY_JSON: JSON.stringify(trial),
    COMPANION_AUTODISPATCH_JSON: JSON.stringify(autodispatch),
  };
}

interface MaterializerFixture {
  readonly dir: string;
  readonly source: string;
  readonly stateDir: string;
  readonly runtimeDir: string;
  readonly config: AutodispatchConfig;
  readonly cleanup: () => void;
}

function write(path: string, body: string, mode = 0o600): void {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(path, body, { mode });
}

function removeTree(path: string): void {
  const walk = (absolute: string): void => {
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = readdirSync(absolute, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) walk(join(absolute, entry.name));
    }
    try {
      chmodSync(absolute, 0o700);
    } catch {
      // Best effort fixture cleanup.
    }
  };
  walk(path);
  rmSync(path, { recursive: true, force: true });
}

/** REAL materializer fixture: temp source/depot + fixed executor/check. No
 * model, live Pi, production source, or shared depot is touched. */
function makeMaterializerFixture(): MaterializerFixture {
  const dir = mkdtempSync(join(tmpdir(), "autodispatch-http-real-"));
  const source = join(dir, "source");
  write(join(source, "package.json"), '{"name":"fixture"}\n');
  write(join(source, "src", "app.ts"), "export const app = 1;\n");
  const stateDir = join(dir, "state");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const runtimeDir = join(dir, "rt");
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
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
  const caps = {
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
  const config: AutodispatchConfig = {
    enabled: true,
    workspaceAlias: "companion-harness",
    sourceRoot: source,
    operations: ["investigate", "implement"],
    readScopes: ["src"],
    writeScopes: ["src"],
    checks: ["lint"],
    caps,
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
      maxDurationMs: 30_000,
      modelRoute: "local",
    },
  };
  return {
    dir,
    source,
    stateDir,
    runtimeDir,
    config,
    cleanup: () => removeTree(dir),
  };
}

interface Fixture extends CreatedServerApp {
  repo: KernelRepository;
  db: ReturnType<typeof openKernelDatabase>;
  close: () => void;
}

async function makeApp(): Promise<Fixture> {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  const repo = createKernelRepository(handle.raw);
  const config = loadServerConfig(envConfig());
  const { logger } = createCollectingLogger("debug");
  const engine = new RunEngine({ db: handle.raw, repo, cancelGraceMs: 30 });
  const created = createApp({ config, repo, engine, logger });
  return {
    ...created,
    repo,
    db: handle,
    close: () => closeKernelDatabase(handle),
  };
}

function headers(key?: string): Record<string, string> {
  return {
    "content-type": "application/json",
    host: "127.0.0.1",
    ...(key === undefined ? {} : { "idempotency-key": key }),
  };
}

async function call(
  app: CreatedServerApp["app"],
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  key?: string,
) {
  const response = await app.request(path, {
    method,
    headers: headers(key),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

function completeTurn(
  repo: KernelRepository,
  sessionId: string,
  text: string,
  now: number,
) {
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

function resume(repo: KernelRepository, now: number): void {
  const ctl = repo.getAutonomyControlState();
  repo.setAutonomyControlState(
    { paused: false, expectedVersion: ctl.version },
    { key: randomUUID(), now },
  );
}

function policyBody(turnId: string) {
  return {
    statement: "Auto-dispatch inside the approved companion-harness scope",
    sourceTurnId: turnId,
  };
}

function planBody(policyId: string, anchor: { turnId: string; runId: string }) {
  return {
    policyId,
    operation: "implement",
    content: {
      goal: "Implement the accepted feature in src/app.ts",
      decisions: ["Use the existing runner"],
      nongoals: ["No deployment"],
      steps: ["Edit src/app.ts"],
      acceptance: ["lint passes"],
      missing: [],
      relevantPaths: ["src/app.ts"],
    },
    intent: {
      kind: "execute",
      quotes: [
        {
          turnId: anchor.turnId,
          runId: anchor.runId,
          text: "implement the feature",
        },
      ],
      latestUserTurnId: anchor.turnId,
      latestUserRunId: anchor.runId,
    },
  };
}

describe("autodispatch HTTP + existing trial boundary", () => {
  it("creates one grant per plan revision and replays duplicate authorize", async () => {
    const fx = await makeApp();
    try {
      resume(fx.repo, NOW);
      const anchor = completeTurn(
        fx.repo,
        fx.repo.createSession({ key: randomUUID(), now: NOW - 1 }).body
          .sessionId,
        "Please implement the feature in src/app.ts. Go ahead.",
        NOW + 10,
      );
      // Recover the session id from the turn owner for the route paths.
      const sessionRow = fx.db.raw
        .prepare("SELECT session_id AS sessionId FROM turns WHERE id=?")
        .get(anchor.turnId) as { sessionId: string };
      const sessionId = sessionRow.sessionId;

      const policy = await call(
        fx.app,
        "POST",
        `/api/sessions/${sessionId}/autodispatch/policies`,
        policyBody(anchor.turnId),
        randomUUID(),
      );
      expect(policy.status).toBe(201);
      const policyId = (policy.body as { id: string }).id;

      const plan = await call(
        fx.app,
        "POST",
        `/api/sessions/${sessionId}/autodispatch/plans`,
        planBody(policyId, anchor),
      );
      expect(plan.status).toBe(201);
      const planId = (plan.body as { plan: { id: string } }).plan.id;

      const first = await call(
        fx.app,
        "POST",
        `/api/sessions/${sessionId}/autodispatch/plans/${planId}/authorize`,
        {},
      );
      expect(first.status).toBe(201);
      const executionId = (first.body as { execution: { executionId: string } })
        .execution.executionId;
      expect(executionId).toMatch(/^[0-9a-f-]{36}$/);

      const second = await call(
        fx.app,
        "POST",
        `/api/sessions/${sessionId}/autodispatch/plans/${planId}/authorize`,
        {},
      );
      expect(second.status).toBe(200);
      expect(
        (second.body as { execution: { executionId: string } }).execution
          .executionId,
      ).toBe(executionId);

      const grants = fx.db.raw
        .prepare("SELECT COUNT(*) AS n FROM trial_grants")
        .get() as { n: number };
      expect(grants.n).toBe(1);

      const listing = await call(
        fx.app,
        "GET",
        `/api/sessions/${sessionId}/autodispatch`,
      );
      expect(listing.status).toBe(200);
      expect(
        (listing.body as { executions: { status: string }[] }).executions[0]
          ?.status,
      ).toBe("authorized");
    } finally {
      fx.close();
    }
  });

  linuxIt(
    "intake service creates a plan and hands a queued grant to the existing runner",
    async () => {
      const handle = openKernelDatabase(":memory:");
      await migrateKernelDatabase({ db: handle.raw });
      const repo = createKernelRepository(handle.raw);
      const fx = makeMaterializerFixture();
      const ad = fx.config;
      const { logger } = createCollectingLogger("debug");
      try {
        resume(repo, NOW);
        const session = repo.createSession({ key: randomUUID(), now: NOW });
        const sessionId = session.body.sessionId;
        const anchor = completeTurn(
          repo,
          sessionId,
          "Please implement the feature in src/app.ts. Go ahead.",
          NOW + 10,
        );
        const policy = repo.createAutodispatchPolicy(
          sessionId,
          {
            workspaceAlias: ad.workspaceAlias,
            operations: ["investigate", "implement"],
            readScopes: [...ad.readScopes],
            writeScopes: [...ad.writeScopes],
            checks: [...ad.checks],
            caps: ad.caps,
            expiresAt: null,
          },
          {
            key: randomUUID(),
            now: NOW + 20,
            limits: {
              operations: [...ad.operations],
              checks: [...ad.checks],
              caps: ad.caps,
            },
            parent: {
              statement: "Standing policy for the approved workspace",
              sourceTurnId: anchor.turnId,
            },
          },
        );
        expect(policy.status).toBe("active");
        const gate: BackgroundResourceGate = createBackgroundResourceGate();
        const planner: AutodispatchPlanner = {
          async propose(input) {
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
          },
        };
        const service = createAutodispatchService({
          repo,
          config: ad,
          runtimeDir: fx.runtimeDir,
          profile: {
            available: true,
            enabled: true,
            mandatoryChecks: ["lint"],
            configFingerprint: FP,
            sourceRevision: REV,
            currentModel: "test-model",
            disclosedWholeRepoRead: true,
            timeoutMs: ad.caps.timeoutMs,
            maxOutputBytes: ad.caps.maxOutputBytes,
          },
          // No injected materializer: the service constructs the REAL
          // per-execution sealed-profile materializer from fx.config.
          background: gate,
          planner,
          maxOutputTokens: 256,
          logger,
          now: () => NOW + 30,
        });
        service.onRunCompleted(anchor.runId);
        const deadline = Date.now() + 2000;
        let execution:
          | { executionId: string | null; status: string }
          | undefined;
        while (Date.now() < deadline) {
          const items = repo.listAutodispatchExecutions(sessionId, 10);
          execution = items[0];
          if (execution !== undefined && execution.status !== "reserved") break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(execution?.status).toBe("authorized");
        const executionId = execution?.executionId;
        expect(typeof executionId).toBe("string");

        // EXISTING TrialRunner boundary: claim the queued grant exactly once
        // with the ACTUAL materialized profile bound at approval (never the
        // wider static service snapshot).
        const stored = repo.readAutodispatchMaterialization(
          sessionId,
          executionId as string,
        );
        const materialized = JSON.parse(
          stored?.materializationJson ?? "null",
        ) as { profile: TrialProfileSnapshot } | null;
        if (materialized === null) throw new Error("materialization missing");
        const claimed = repo.claimTrial(sessionId, executionId as string, {
          key: randomUUID(),
          now: NOW + 40,
          profile: materialized.profile,
          workspaceAlias: "companion-harness",
        });
        expect(claimed.body).toMatchObject({
          request: {
            objective: "Implement the accepted feature",
            executionId,
            budget: {
              // The ACTUAL narrow materialized runtime cap, never widened to
              // the policy maximum.
              timeoutMs: 30_000,
              maxOutputBytes: 1_000_000,
            },
          },
        });
        expect(stored?.materializationJson).not.toBeNull();
        expect(stored?.digest).toMatch(/^[0-9a-f]{64}$/);
      } finally {
        closeKernelDatabase(handle);
        fx.cleanup();
      }
    },
  );
});

describe("trial grant outcome projection through the actual API", () => {
  it("distinguishes pending from a durable authorized worker outcome without dropping legacy fields", async () => {
    const fixture = await makeApp();
    const { app, repo } = fixture;
    try {
      const created = await call(
        app,
        "POST",
        "/api/sessions",
        {},
        randomUUID(),
      );
      expect(created.status).toBe(201);
      const sessionId = (created.body as { sessionId: string }).sessionId;
      const now = Date.now();
      const ctl = repo.getAutonomyControlState();
      repo.setAutonomyControlState(
        { paused: false, expectedVersion: ctl.version },
        { key: randomUUID(), now },
      );
      const goal = repo.createAutonomyPurpose(
        sessionId,
        {
          scope: "proj-api",
          statement: "ship it",
          kind: "goal",
          explicit: true,
          sourceKind: "user",
        },
        { key: randomUUID(), now: now + 1 },
      );
      const task = repo.createAutonomyTask(
        sessionId,
        {
          scope: "proj-api",
          title: "do work",
          kind: "task",
          speaker: "user",
          parentPurposeId: goal.body.id,
        },
        { key: randomUUID(), now: now + 2 },
      );
      const trialProfile = {
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
      const staged = repo.stageTrial(
        sessionId,
        {
          taskId: task.body.id,
          objective: "implement through the real API",
          acceptance: ["works"],
          literalPatchPaths: ["src/a.ts"],
          operation: "implement",
          readOnlyMode: false,
          expiry: new Date(now + 3600_000).toISOString(),
          possibleExternalDataConsent: true,
          objectiveResourceCaps: { timeoutMs: 5000, maxOutputBytes: 10000 },
          requiredChecks: ["lint"],
        },
        {
          key: randomUUID(),
          now: now + 3,
          profile: trialProfile,
          workspaceAlias: "companion-harness",
        },
      );
      const approved = repo.approveTrial(sessionId, staged.body.id, {
        key: randomUUID(),
        now: now + 4,
        profile: trialProfile,
        workspaceAlias: "companion-harness",
      });
      const executionId = (approved.body as { executionId: string })
        .executionId;

      const pending = await call(
        app,
        "GET",
        `/api/sessions/${sessionId}/trial-grants/${executionId}`,
      );
      expect(pending.status).toBe(200);
      expect((pending.body as { outcome: unknown }).outcome).toMatchObject({
        status: "queued",
        authorized: false,
        summary: "",
        recorded: false,
        succeeded: false,
        quiescent: false,
        detail: "",
      });

      const claimed = repo.claimTrial(sessionId, executionId, {
        key: randomUUID(),
        now: now + 5,
        profile: trialProfile,
        workspaceAlias: "companion-harness",
      });
      const request = (claimed.body as { request: Record<string, unknown> })
        .request;
      const identity = {
        pid: 6401,
        bootId: "boot-proj-api",
        processStartTicks: "64011",
      };
      repo.registerTrialWorkerBoot(
        { executionId, sessionId, ...identity },
        now + 6,
      );
      repo.issueTrialLaunchPermit(sessionId, executionId, {
        key: randomUUID(),
        now: now + 7,
        observation: {
          scopeState: "active",
          frontendSettled: false,
          ...identity,
          remainingRuntimeMs: 1000,
          timeoutMs: 5000,
          maxOutputBytes: 10000,
          foregroundGateOpen: true,
          observedAt: now + 7,
        } as never,
        profile: trialProfile,
        requestHash: repo.hashTrialLaunchRequest(request),
      });
      repo.recordTrialWorkerResult(
        sessionId,
        executionId,
        {
          detail: "bridge-exit:0",
          observation: {
            scopeState: "gone",
            frontendSettled: true,
            ...identity,
            remainingRuntimeMs: 1000,
            timeoutMs: 5000,
            maxOutputBytes: 10000,
            foregroundGateOpen: true,
            observedAt: now + 8,
          } as never,
          result: {
            taskHash: request.taskHash as string,
            exitCode: 0,
            checks: [{ id: "lint", ok: true }],
            outputMatched: true,
            noTimeout: true,
          },
        },
        now + 8,
      );

      const done = await call(
        app,
        "GET",
        `/api/sessions/${sessionId}/trial-grants/${executionId}`,
      );
      expect(done.status).toBe(200);
      expect((done.body as { outcome: unknown }).outcome).toMatchObject({
        status: "consumed",
        authorized: true,
        summary: "bridge-exit:0",
        recorded: true,
        succeeded: true,
        quiescent: false,
        detail: "bridge-exit:0",
      });
    } finally {
      fixture.close();
    }
  });
});
