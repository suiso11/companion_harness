// Trial runner behavioral tests (real kernel on a temp file DB + fakes).
//
// Covers: happy path authorized done without Task/Goal completion, permit
// denied when the foreground is busy, mid-run cancel revocation, failed
// launch when the scope never activates, unknown-after-exit fencing with a
// follow-up no-op, and the paused no-claim gate. The bridge child, the
// observer, and the relay are fakes; the kernel is production.

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeKernelDatabase,
  createKernelRepository,
  type KernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
} from "@companion/kernel";
import type { ModelGateway } from "@companion/model-local";
import { describe, expect, it } from "vitest";
import { createCollectingLogger } from "../src/logger.js";
import {
  TrialRunner,
  type TrialRunnerObserverFns,
  type TrialRunnerRelay,
  type TrialRunnerSpawn,
} from "../src/trial_runner.js";

const FP = "b".repeat(64);
const REV = "a".repeat(40);
const NOW = 1_750_000_000_000;

function profile() {
  return {
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
}

function stageInput(taskId: string) {
  return {
    taskId,
    objective: "obj",
    acceptance: ["done"],
    literalPatchPaths: ["src/a.ts"],
    operation: "implement",
    readOnlyMode: false,
    expiry: new Date(NOW + 3600_000).toISOString(),
    possibleExternalDataConsent: true,
    objectiveResourceCaps: { timeoutMs: 5000, maxOutputBytes: 10000 },
    requiredChecks: ["lint"],
  };
}

async function makeKernel() {
  const dir = mkdtempSync(join(tmpdir(), "trial-runner-db-"));
  const handle = openKernelDatabase(join(dir, "db.sqlite"));
  await migrateKernelDatabase({ db: handle.raw });
  const repo = createKernelRepository(handle.raw);
  const session = repo.createSession({ key: randomUUID(), now: NOW });
  const ctl = repo.getAutonomyControlState();
  repo.setAutonomyControlState(
    { paused: false, expectedVersion: ctl.version },
    { key: randomUUID(), now: NOW + 1 },
  );
  return { handle, repo, sessionId: session.body.sessionId as string };
}

function makeAuthority(
  repo: KernelRepository,
  sessionId: string,
  scope: string,
) {
  const goal = repo.createAutonomyPurpose(
    sessionId,
    {
      scope,
      statement: "ship it",
      kind: "goal",
      explicit: true,
      sourceKind: "user",
    },
    { key: randomUUID(), now: NOW + 2 },
  );
  const task = repo.createAutonomyTask(
    sessionId,
    {
      scope,
      title: "do work",
      kind: "task",
      speaker: "user",
      parentPurposeId: (goal.body as { id: string }).id,
    },
    { key: randomUUID(), now: NOW + 3 },
  );
  return {
    goalId: (goal.body as { id: string }).id,
    taskId: (task.body as { id: string }).id,
  };
}

function queueGrant(
  repo: KernelRepository,
  sessionId: string,
  scope: string,
  alias: string,
  taskId?: string,
) {
  const owned = taskId ?? makeAuthority(repo, sessionId, scope).taskId;
  const staged = repo.stageTrial(sessionId, stageInput(owned) as never, {
    key: randomUUID(),
    now: NOW + 4,
    profile: profile(),
    workspaceAlias: alias,
  });
  const approved = repo.approveTrial(
    sessionId,
    (staged.body as { id: string }).id,
    {
      key: randomUUID(),
      now: NOW + 5,
      profile: profile(),
      workspaceAlias: alias,
    },
  );
  return {
    executionId: (approved.body as { executionId: string }).executionId,
    taskId: owned,
  };
}

/* ---------------- fakes ---------------- */

interface FakeBridgeBehavior {
  /** When true, the bridge hangs until fd3 is destroyed, then exits. */
  hangUntilFd3?: boolean;
  /** Line emitter: defaults to a valid done line derived from the request. */
  lineForRequest?: ((request: Record<string, unknown>) => string) | undefined;
  exitCode?: number | undefined;
}

interface FakeChild extends EventEmitter {
  pid: number;
  stdin: { write: (c: string) => void; end: () => void } | null;
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdio: unknown[];
  kill: () => void;
}

function validDoneLine(request: Record<string, unknown>): string {
  return JSON.stringify({
    taskHash: request["taskHash"],
    exitCode: 0,
    checks: ((request["requiredChecks"] as string[]) ?? ["lint"]).map((id) => ({
      id,
      ok: true,
    })),
    outputMatched: true,
    noTimeout: true,
  });
}

let fakePidCounter = 5000;

function createFakeSpawn(behavior: FakeBridgeBehavior = {}) {
  const state = {
    calls: 0,
    lastConfigPath: null as string | null,
    lastConfigOk: false,
    lastSockPath: null as string | null,
    stdinText: "",
    fd3Destroyed: false,
    exited: false,
    child: null as FakeChild | null,
  };
  const spawnImpl = ((_cmd: string, args: string[], _opts: unknown) => {
    state.calls += 1;
    const configIndex = args.indexOf("--config");
    state.lastConfigPath =
      configIndex === -1 ? null : (args[configIndex + 1] as string);
    const child = new EventEmitter() as FakeChild;
    child.pid = fakePidCounter += 1;
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    let stdinBuf = "";
    let ended = false;
    const finish = (line: string | null, code: number): void => {
      if (state.exited) return;
      state.exited = true;
      if (line !== null) stdout.emit("data", Buffer.from(`${line}\n`));
      child.emit("exit", code, null);
    };
    const fd3 = {
      destroyed: false,
      destroy() {
        this.destroyed = true;
        state.fd3Destroyed = true;
        if (behavior.hangUntilFd3 === true) {
          const req = JSON.parse(stdinBuf.split("\n")[0] as string) as Record<
            string,
            unknown
          >;
          const line = behavior.lineForRequest?.(req) ?? validDoneLine(req);
          setTimeout(() => finish(line, behavior.exitCode ?? 1), 5);
        }
      },
    };
    child.stdin = {
      write(chunk: string) {
        stdinBuf += chunk;
        state.stdinText = stdinBuf;
      },
      end() {
        if (ended) return;
        ended = true;
        if (behavior.hangUntilFd3 === true) return;
        try {
          const req = JSON.parse(stdinBuf.split("\n")[0] as string) as Record<
            string,
            unknown
          >;
          const line = behavior.lineForRequest?.(req) ?? validDoneLine(req);
          setTimeout(() => finish(line, behavior.exitCode ?? 0), 5);
        } catch {
          setTimeout(() => finish(null, 1), 5);
        }
      },
    };
    child.stdout = stdout;
    child.stderr = stderr;
    child.stdio = [child.stdin, stdout, stderr, fd3];
    child.kill = () => {
      finish(null, 1);
    };
    state.child = child;
    return child;
  }) as unknown as TrialRunnerSpawn;
  return { spawnImpl, state };
}

function createFakeRelayFactory() {
  const relays: (TrialRunnerRelay & {
    revoked: boolean;
    permitted: boolean;
    closed: boolean;
    sock: string;
  })[] = [];
  const factory = (sockPath: string): TrialRunnerRelay => {
    const relay = {
      sock: sockPath,
      permitted: false,
      revoked: false,
      closed: false,
      path: sockPath,
      setPermitted(v: boolean) {
        relay.permitted = v === true;
      },
      revoke() {
        relay.permitted = false;
        relay.revoked = true;
      },
      async start() {
        return undefined;
      },
      async close() {
        relay.closed = true;
        return undefined;
      },
    };
    relays.push(relay);
    return relay;
  };
  return { factory, relays };
}

function createObserver(script: {
  scopeBeforeExit: "active" | "gone" | "unknown";
  scopeAfterExit: "active" | "gone" | "unknown";
  identity: { pid: number; bootId: string; processStartTicks: string };
  exited: () => boolean;
}): TrialRunnerObserverFns {
  return {
    expectedScopeUnit: (executionId: string) =>
      `capsule-${executionId}-${"c".repeat(64)}.scope`,
    queryScope: async () => {
      const after = script.exited();
      const state = after ? script.scopeAfterExit : script.scopeBeforeExit;
      if (state === "active")
        return { scopeState: "active" as const, remainingRuntimeMs: 5000 };
      return { scopeState: state };
    },
    readIdentity: async (pid: number) => {
      if (script.exited()) return "gone";
      if (pid !== script.identity.pid) return "unknown";
      return { ...script.identity };
    },
  };
}

const stubGateway = {
  provider: "openai-compatible",
  capabilities: { toolCalling: true },
  baseUrl: "http://127.0.0.1:9",
  chatUrl: "http://127.0.0.1:9/v1/chat/completions",
  async chat() {
    return { text: "stub", toolCalls: [], stopReason: "stop" as const };
  },
} as unknown as ModelGateway;

function runnerConfigBase(
  alias: string,
  templatePath: string,
  runDirBase: string,
) {
  return {
    nodeRealpath: process.execPath,
    bridgeScriptPath: "/fake/bridge.mjs",
    bridgeConfigTemplatePath: templatePath,
    systemctlRealpath: "/usr/bin/systemctl",
    xdgRuntimeDir: "/run/user/1000",
    workspaceAlias: alias,
    profile: profile(),
    relayCaps: {
      maxRequestBytes: 1024 * 1024,
      maxModelCalls: 8,
      maxOutputTokens: 256,
      maxResponseBytes: 1024 * 1024,
      perCallTimeoutMs: 500,
      maxConcurrent: 1,
    },
    fixedModel: "test-model",
    gateway: stubGateway,
    observe: { activeTimeoutMs: 2000, goneTimeoutMs: 2000, pollIntervalMs: 5 },
    runDirBase,
  };
}

function makeClock() {
  const t0 = Date.now();
  return () => NOW + (Date.now() - t0);
}

function writeTemplate(dir: string): string {
  const path = join(dir, "bridge.template.json");
  writeFileSync(
    path,
    JSON.stringify({ modelSockHostPath: "/placeholder", otherKey: "keep" }),
  );
  return path;
}

describe("trial_runner", () => {
  it("maps the real bridge wire result line to an authorized done proof", async () => {
    const { handle, repo, sessionId } = await makeKernel();
    try {
      const { executionId, taskId } = queueGrant(repo, sessionId, "b1", "ws");
      void executionId;
      const exited = { current: false };
      const identity = {
        pid: 4243,
        bootId: "boot-wire",
        processStartTicks: "12346",
      };
      const wireLineForRequest = (request: Record<string, unknown>): string =>
        JSON.stringify({
          version: 1,
          executionId: request["executionId"],
          taskHash: request["taskHash"],
          status: "done",
          verified: true,
          report: {
            summary: "fixed",
            files: ["calc.mjs"],
            findings: ["EDIT_APPLIED"],
            unresolved: [],
          },
          evidence: {
            workerIds: ["w1"],
            workspaceTrial: true,
            productionApplied: false,
            checks: ((request["requiredChecks"] as string[]) ?? ["lint"]).map(
              (id) => ({
                id,
                exitCode: 0,
                timedOut: false,
                outputMatched: true,
              }),
            ),
          },
        });
      const { spawnImpl, state } = createFakeSpawn({
        lineForRequest: wireLineForRequest,
      });
      const spawnProxy = ((cmd: string, args: string[], opts: unknown) => {
        const child = (
          spawnImpl as unknown as (
            c: string,
            a: string[],
            o: unknown,
          ) => FakeChild
        )(cmd, args, opts);
        child.pid = identity.pid;
        exited.current = false;
        const origEmit = child.emit.bind(child);
        child.emit = ((event: string, ...rest: unknown[]) => {
          if (event === "exit") exited.current = true;
          return (origEmit as (...a: unknown[]) => boolean)(event, ...rest);
        }) as FakeChild["emit"];
        return child;
      }) as unknown as TrialRunnerSpawn;
      const observer = createObserver({
        scopeBeforeExit: "active",
        scopeAfterExit: "gone",
        identity,
        exited: () => exited.current,
      });
      const { factory, relays } = createFakeRelayFactory();
      const { logger } = createCollectingLogger("debug");
      const dir = mkdtempSync(join(tmpdir(), "trial-run-"));
      const runner = new TrialRunner({
        repo,
        config: runnerConfigBase("ws", writeTemplate(dir), join(dir, "runs")),
        isForegroundBusy: () => false,
        logger,
        observer,
        createRelay: factory,
        spawnImpl: spawnProxy,
        clock: makeClock(),
      });
      const out = await runner.runNext();
      expect(out).toMatchObject({
        ran: true,
        outcome: "done",
        authorized: true,
      });
      expect(relays.length).toBe(1);
      expect(state.fd3Destroyed).toBe(false);
      const stored = handle.raw
        .prepare(
          "SELECT authorized, quiescent, detail FROM trial_worker_outcomes WHERE execution_id=?",
        )
        .get(out.executionId) as {
        authorized: number;
        quiescent: number;
        detail: string;
      };
      expect(stored.authorized).toBe(1);
      expect(stored.detail).toContain("bridge-exit:0");
      const taskView = repo.getAutonomyTask(sessionId, taskId);
      expect(taskView.status).not.toBe("completed");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("maps the REAL observed bridge error line (empty checks) to terminal observed", async () => {
    const { handle, repo, sessionId } = await makeKernel();
    try {
      const { executionId } = queueGrant(repo, sessionId, "b1", "ws");
      const exited = { current: false };
      const identity = {
        pid: 4247,
        bootId: "boot-real",
        processStartTicks: "12347",
      };
      // Exact shape of the real e2e bridge final line: status error, verified
      // false, evidence.checks [] (wholejob capsule failed before checks ran).
      const realErrorLineForRequest = (
        request: Record<string, unknown>,
      ): string =>
        JSON.stringify({
          version: 1,
          executionId: request["executionId"],
          taskHash: request["taskHash"],
          status: "error",
          verified: false,
          report: {
            summary: "companion bridge: wholejob capsule failed",
            files: [],
            findings: [],
            unresolved: [],
          },
          evidence: {
            workerIds: [],
            workspaceTrial: true,
            productionApplied: false,
            checks: [],
          },
        });
      const { spawnImpl } = createFakeSpawn({
        lineForRequest: realErrorLineForRequest,
      });
      const spawnProxy = ((cmd: string, args: string[], opts: unknown) => {
        const child = (
          spawnImpl as unknown as (
            c: string,
            a: string[],
            o: unknown,
          ) => FakeChild
        )(cmd, args, opts);
        child.pid = identity.pid;
        const origEmit = child.emit.bind(child);
        child.emit = ((event: string, ...rest: unknown[]) => {
          if (event === "exit") exited.current = true;
          return (origEmit as (...a: unknown[]) => boolean)(event, ...rest);
        }) as FakeChild["emit"];
        return child;
      }) as unknown as TrialRunnerSpawn;
      const observer = createObserver({
        scopeBeforeExit: "active",
        scopeAfterExit: "gone",
        identity,
        exited: () => exited.current,
      });
      const { factory } = createFakeRelayFactory();
      const { logger } = createCollectingLogger("debug");
      const dir = mkdtempSync(join(tmpdir(), "trial-run-"));
      const runner = new TrialRunner({
        repo,
        config: runnerConfigBase("ws", writeTemplate(dir), join(dir, "runs")),
        isForegroundBusy: () => false,
        logger,
        observer,
        createRelay: factory,
        spawnImpl: spawnProxy,
        clock: makeClock(),
      });
      const out = await runner.runNext();
      expect(out).toMatchObject({
        ran: true,
        outcome: "observed",
        authorized: false,
      });
      const stored = handle.raw
        .prepare(
          "SELECT authorized, quiescent, detail FROM trial_worker_outcomes WHERE execution_id=?",
        )
        .get(out.executionId) as {
        authorized: number;
        quiescent: number;
        detail: string;
      };
      expect(stored.authorized).toBe(0);
      expect(stored.quiescent).toBe(0);
      expect(stored.detail).toContain("bridge-exit:1");
      // Terminal: the grant leaves claimed for interrupted (never re-arms).
      expect(
        repo.readTrialLaunchIntent(sessionId, executionId).grant.status,
      ).toBe("interrupted");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("happy path records authorized done without completing Task/Goal", async () => {
    const { handle, repo, sessionId } = await makeKernel();
    try {
      const { executionId, taskId } = queueGrant(repo, sessionId, "b1", "ws");
      void executionId;
      const exited = { current: false };
      const identity = {
        pid: 4242,
        bootId: "boot-1",
        processStartTicks: "12345",
      };
      const { spawnImpl, state } = createFakeSpawn();
      // Align the fake pid with the observer identity.
      const spawnProxy = ((cmd: string, args: string[], opts: unknown) => {
        const child = (
          spawnImpl as unknown as (
            c: string,
            a: string[],
            o: unknown,
          ) => FakeChild
        )(cmd, args, opts);
        child.pid = identity.pid;
        exited.current = false;
        const origEmit = child.emit.bind(child);
        child.emit = ((event: string, ...rest: unknown[]) => {
          if (event === "exit") exited.current = true;
          return (origEmit as (...a: unknown[]) => boolean)(event, ...rest);
        }) as FakeChild["emit"];
        return child;
      }) as unknown as TrialRunnerSpawn;
      const observer = createObserver({
        scopeBeforeExit: "active",
        scopeAfterExit: "gone",
        identity,
        exited: () => exited.current,
      });
      const { factory, relays } = createFakeRelayFactory();
      const { logger } = createCollectingLogger("debug");
      const dir = mkdtempSync(join(tmpdir(), "trial-run-"));
      const runner = new TrialRunner({
        repo,
        config: runnerConfigBase("ws", writeTemplate(dir), join(dir, "runs")),
        isForegroundBusy: () => false,
        logger,
        observer,
        createRelay: factory,
        spawnImpl: spawnProxy,
        clock: makeClock(),
      });
      const out = await runner.runNext();
      expect(out).toMatchObject({
        ran: true,
        outcome: "done",
        authorized: true,
      });
      expect(relays.length).toBe(1);
      expect(relays[0]?.permitted).toBe(true);
      expect(state.fd3Destroyed).toBe(false);
      // Frozen request reached the bridge on stdin.
      expect(state.stdinText.endsWith("\n")).toBe(true);
      const sent = JSON.parse(
        state.stdinText.split("\n")[0] as string,
      ) as Record<string, unknown>;
      expect(sent["executionId"]).toBe(out.executionId);
      // Kernel outcome is authorized done; Task/Goal untouched.
      const stored = handle.raw
        .prepare(
          "SELECT authorized, quiescent FROM trial_worker_outcomes WHERE execution_id=?",
        )
        .get(out.executionId) as { authorized: number; quiescent: number };
      expect(stored.authorized).toBe(1);
      expect(stored.quiescent).toBe(0);
      expect(
        repo.readTrialLaunchIntent(sessionId, executionId).grant.status,
      ).toBe("consumed");
      const taskView = repo.getAutonomyTask(sessionId, taskId);
      expect(taskView.status).not.toBe("completed");
      expect(taskView.status).not.toBe("cancelled");
      expect(taskView.parentPurposeId).not.toBeNull();
      expect(
        repo.getAutonomyPurpose(sessionId, taskView.parentPurposeId as string)
          .status,
      ).toBe("active");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("permit denied when the foreground is busy: no relay permit, fd3 closed", async () => {
    const { handle, repo, sessionId } = await makeKernel();
    try {
      queueGrant(repo, sessionId, "b1", "ws");
      const exited = { current: false };
      const identity = {
        pid: 4243,
        bootId: "boot-2",
        processStartTicks: "777",
      };
      const { spawnImpl, state } = createFakeSpawn();
      const spawnProxy = ((cmd: string, args: string[], opts: unknown) => {
        const child = (
          spawnImpl as unknown as (
            c: string,
            a: string[],
            o: unknown,
          ) => FakeChild
        )(cmd, args, opts);
        child.pid = identity.pid;
        const origEmit = child.emit.bind(child);
        child.emit = ((event: string, ...rest: unknown[]) => {
          if (event === "exit") exited.current = true;
          return (origEmit as (...a: unknown[]) => boolean)(event, ...rest);
        }) as FakeChild["emit"];
        return child;
      }) as unknown as TrialRunnerSpawn;
      const observer = createObserver({
        scopeBeforeExit: "active",
        scopeAfterExit: "gone",
        identity,
        exited: () => exited.current,
      });
      const { factory, relays } = createFakeRelayFactory();
      const { logger } = createCollectingLogger("debug");
      const dir = mkdtempSync(join(tmpdir(), "trial-run-"));
      // Foreground becomes busy only after the run starts (permit-time denial).
      let started = false;
      const busyProxy = (
        orig: TrialRunnerObserverFns,
      ): TrialRunnerObserverFns => orig;
      void busyProxy;
      const runner = new TrialRunner({
        repo,
        config: runnerConfigBase("ws", writeTemplate(dir), join(dir, "runs")),
        isForegroundBusy: () => started,
        logger,
        observer,
        createRelay: factory,
        spawnImpl: ((cmd: string, args: string[], opts: unknown) => {
          started = true;
          return (
            spawnProxy as unknown as (
              c: string,
              a: string[],
              o: unknown,
            ) => unknown
          )(cmd, args, opts);
        }) as unknown as import("../src/trial_runner.js").TrialRunnerSpawn,
        clock: makeClock(),
      });
      const out = await runner.runNext();
      expect(out).toMatchObject({ ran: true, outcome: "permit-denied" });
      expect(relays.length).toBe(1);
      expect(relays[0]?.permitted).toBe(false);
      expect(state.fd3Destroyed).toBe(true);
      // No permit row was minted and no authorized outcome exists.
      expect(
        repo.readTrialLaunchPermit(sessionId, out.executionId as string),
      ).toBeNull();
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("cancel mid-run revokes the relay, closes fd3, and stays unauthorized", async () => {
    const { handle, repo, sessionId } = await makeKernel();
    try {
      const { executionId } = queueGrant(repo, sessionId, "b1", "ws");
      const exited = { current: false };
      const identity = {
        pid: 4244,
        bootId: "boot-3",
        processStartTicks: "888",
      };
      const { spawnImpl, state } = createFakeSpawn({ hangUntilFd3: true });
      const spawnProxy = ((cmd: string, args: string[], opts: unknown) => {
        const child = (
          spawnImpl as unknown as (
            c: string,
            a: string[],
            o: unknown,
          ) => FakeChild
        )(cmd, args, opts);
        child.pid = identity.pid;
        const origEmit = child.emit.bind(child);
        child.emit = ((event: string, ...rest: unknown[]) => {
          if (event === "exit") exited.current = true;
          return (origEmit as (...a: unknown[]) => boolean)(event, ...rest);
        }) as FakeChild["emit"];
        return child;
      }) as unknown as TrialRunnerSpawn;
      const observer = createObserver({
        scopeBeforeExit: "active",
        scopeAfterExit: "gone",
        identity,
        exited: () => exited.current,
      });
      const { factory, relays } = createFakeRelayFactory();
      const { logger } = createCollectingLogger("debug");
      const dir = mkdtempSync(join(tmpdir(), "trial-run-"));
      const runner = new TrialRunner({
        repo,
        config: runnerConfigBase("ws", writeTemplate(dir), join(dir, "runs")),
        isForegroundBusy: () => false,
        logger,
        observer,
        createRelay: factory,
        spawnImpl: spawnProxy,
        clock: makeClock(),
      });
      const pending = runner.runNext();
      // Wait for the bridge to be running, then flag cancel_requested.
      for (let i = 0; i < 400 && state.stdinText === ""; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(state.stdinText).not.toBe("");
      handle.raw
        .prepare(
          "UPDATE trial_grants SET cancel_requested=1 WHERE execution_id=?",
        )
        .run(executionId);
      const out = await pending;
      expect(out.executionId).toBe(executionId);
      expect(out.authorized).toBe(false);
      expect(out.outcome).toBe("observed");
      expect(relays[0]?.revoked).toBe(true);
      expect(state.fd3Destroyed).toBe(true);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("scope never active records a failed launch", async () => {
    const { handle, repo, sessionId } = await makeKernel();
    try {
      const { executionId } = queueGrant(repo, sessionId, "b1", "ws");
      const identity = {
        pid: 4245,
        bootId: "boot-4",
        processStartTicks: "999",
      };
      const { spawnImpl, state } = createFakeSpawn();
      const spawnProxy = ((cmd: string, args: string[], opts: unknown) => {
        const child = (
          spawnImpl as unknown as (
            c: string,
            a: string[],
            o: unknown,
          ) => FakeChild
        )(cmd, args, opts);
        child.pid = identity.pid;
        return child;
      }) as unknown as TrialRunnerSpawn;
      const observer = createObserver({
        scopeBeforeExit: "unknown",
        scopeAfterExit: "unknown",
        identity,
        exited: () => false,
      });
      const { factory, relays } = createFakeRelayFactory();
      const { logger } = createCollectingLogger("debug");
      const dir = mkdtempSync(join(tmpdir(), "trial-run-"));
      const runner = new TrialRunner({
        repo,
        config: {
          ...runnerConfigBase("ws", writeTemplate(dir), join(dir, "runs")),
          observe: {
            activeTimeoutMs: 400,
            goneTimeoutMs: 100,
            pollIntervalMs: 5,
          },
        },
        isForegroundBusy: () => false,
        logger,
        observer,
        createRelay: factory,
        spawnImpl: spawnProxy,
        clock: makeClock(),
      });
      const out = await runner.runNext();
      expect(out).toMatchObject({
        ran: true,
        outcome: "launch-failed",
        executionId,
      });
      expect(state.fd3Destroyed).toBe(true);
      expect(relays[0]?.revoked).toBe(true);
      expect(
        repo.readTrialLaunchIntent(sessionId, executionId).grant.status,
      ).toBe("interrupted");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("unknown scope after exit fences the alias and the next runNext is a no-op", async () => {
    const { handle, repo, sessionId } = await makeKernel();
    try {
      queueGrant(repo, sessionId, "b1", "ws");
      queueGrant(repo, sessionId, "b2", "ws");
      const exited = { current: false };
      const identity = {
        pid: 4246,
        bootId: "boot-5",
        processStartTicks: "111",
      };
      const { spawnImpl } = createFakeSpawn();
      const spawnProxy = ((cmd: string, args: string[], opts: unknown) => {
        const child = (
          spawnImpl as unknown as (
            c: string,
            a: string[],
            o: unknown,
          ) => FakeChild
        )(cmd, args, opts);
        child.pid = identity.pid;
        const origEmit = child.emit.bind(child);
        child.emit = ((event: string, ...rest: unknown[]) => {
          if (event === "exit") exited.current = true;
          return (origEmit as (...a: unknown[]) => boolean)(event, ...rest);
        }) as FakeChild["emit"];
        return child;
      }) as unknown as TrialRunnerSpawn;
      const observer = createObserver({
        scopeBeforeExit: "active",
        scopeAfterExit: "unknown",
        identity,
        exited: () => exited.current,
      });
      const { factory } = createFakeRelayFactory();
      const { logger } = createCollectingLogger("debug");
      const dir = mkdtempSync(join(tmpdir(), "trial-run-"));
      const runner = new TrialRunner({
        repo,
        config: runnerConfigBase("ws", writeTemplate(dir), join(dir, "runs")),
        isForegroundBusy: () => false,
        logger,
        observer,
        createRelay: factory,
        spawnImpl: spawnProxy,
        clock: makeClock(),
      });
      const out = await runner.runNext();
      expect(out).toMatchObject({
        ran: true,
        outcome: "fenced-unknown",
        authorized: false,
      });
      // The fence revoked the second queued grant: the next pick is a no-op.
      const again = await runner.runNext();
      expect(again).toMatchObject({ ran: false, outcome: "empty" });
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("paused control performs no claim", async () => {
    const { handle, repo, sessionId } = await makeKernel();
    try {
      const { executionId } = queueGrant(repo, sessionId, "b1", "ws");
      const ctl = repo.getAutonomyControlState();
      repo.setAutonomyControlState(
        { paused: true, expectedVersion: ctl.version },
        { key: randomUUID(), now: NOW + 10 },
      );
      const { spawnImpl, state } = createFakeSpawn();
      const { factory } = createFakeRelayFactory();
      const { logger } = createCollectingLogger("debug");
      const dir = mkdtempSync(join(tmpdir(), "trial-run-"));
      const runner = new TrialRunner({
        repo,
        config: runnerConfigBase("ws", writeTemplate(dir), join(dir, "runs")),
        isForegroundBusy: () => false,
        logger,
        observer: createObserver({
          scopeBeforeExit: "active",
          scopeAfterExit: "gone",
          identity: { pid: 1, bootId: "b", processStartTicks: "1" },
          exited: () => false,
        }),
        createRelay: factory,
        spawnImpl: spawnImpl as unknown as TrialRunnerSpawn,
        clock: makeClock(),
      });
      const out = await runner.runNext();
      expect(out).toMatchObject({ ran: false, outcome: "paused" });
      expect(state.calls).toBe(0);
      expect(
        repo.readTrialLaunchIntent(sessionId, executionId).grant.status,
      ).toBe("queued");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("waits for scope creation when the unit is not-found while the bridge is alive", async () => {
    const { handle, repo, sessionId } = await makeKernel();
    try {
      const { executionId, taskId } = queueGrant(repo, sessionId, "b1", "ws");
      void executionId;
      void taskId;
      const identity = {
        pid: 4260,
        bootId: "boot-race",
        processStartTicks: "444",
      };
      // Bespoke fake bridge: emits nothing until the test triggers finish()
      // (proving the runner waited through initial not-found polls instead of
      // failing the launch while the bridge was still alive).
      let stdinBuf = "";
      let finished = false;
      let scopeQueries = 0;
      let fd3Destroyed = false;
      const child = new EventEmitter() as FakeChild;
      child.pid = identity.pid;
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      child.stdin = {
        write(chunk: string) {
          stdinBuf += chunk;
        },
        end() {
          // No auto-finish: the test drives completion after the permit.
        },
      };
      child.stdout = stdout;
      child.stderr = stderr;
      child.stdio = [
        child.stdin,
        stdout,
        stderr,
        {
          destroy() {
            fd3Destroyed = true;
          },
        },
      ];
      child.kill = () => undefined;
      const spawnImpl = (() => child) as unknown as TrialRunnerSpawn;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        const req = JSON.parse(stdinBuf.split("\n")[0] as string) as Record<
          string,
          unknown
        >;
        stdout.emit("data", Buffer.from(`${validDoneLine(req)}\n`));
        child.emit("exit", 0, null);
      };
      const observer: TrialRunnerObserverFns = {
        expectedScopeUnit: (eid: string) =>
          `capsule-${eid}-${"c".repeat(64)}.scope`,
        queryScope: async () => {
          scopeQueries += 1;
          if (finished) return { scopeState: "gone" as const };
          // First polls race capsule startup (unit not created yet); the
          // scope activates while the bridge is still alive.
          if (scopeQueries < 3) return { scopeState: "gone" as const };
          return { scopeState: "active" as const, remainingRuntimeMs: 5000 };
        },
        readIdentity: async () => ({ ...identity }),
      };
      const { factory, relays } = createFakeRelayFactory();
      const { logger } = createCollectingLogger("debug");
      const dir = mkdtempSync(join(tmpdir(), "trial-run-"));
      const runner = new TrialRunner({
        repo,
        config: runnerConfigBase("ws", writeTemplate(dir), join(dir, "runs")),
        isForegroundBusy: () => false,
        logger,
        observer,
        createRelay: factory,
        spawnImpl,
        clock: makeClock(),
      });
      const pending = runner.runNext();
      for (let i = 0; i < 400 && relays.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(relays.length).toBe(1);
      for (let i = 0; i < 400 && !relays[0]?.permitted; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(relays[0]?.permitted).toBe(true);
      // The runner reached the permit THROUGH initial not-found polls.
      expect(scopeQueries).toBeGreaterThanOrEqual(3);
      expect(fd3Destroyed).toBe(false);
      finish();
      const out = await pending;
      expect(out).toMatchObject({
        ran: true,
        outcome: "done",
        authorized: true,
      });
      expect(fd3Destroyed).toBe(false);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("recoverOnBoot settles gone workers and fences unsettled ones without killing", async () => {
    const { handle, repo, sessionId } = await makeKernel();
    try {
      const clock = makeClock();
      const first = queueGrant(repo, sessionId, "b1", "ws");
      repo.claimTrial(sessionId, first.executionId, {
        key: randomUUID(),
        now: clock(),
        profile: profile(),
        workspaceAlias: "ws",
      });
      repo.registerTrialWorkerBoot(
        {
          executionId: first.executionId,
          sessionId,
          pid: 4249,
          bootId: "boot-r",
          processStartTicks: "222",
        },
        clock(),
      );
      const second = queueGrant(repo, sessionId, "b2", "ws");
      repo.claimTrial(sessionId, second.executionId, {
        key: randomUUID(),
        now: clock(),
        profile: profile(),
        workspaceAlias: "ws",
      });
      repo.registerTrialWorkerBoot(
        {
          executionId: second.executionId,
          sessionId,
          pid: 4250,
          bootId: "boot-s",
          processStartTicks: "333",
        },
        clock(),
      );
      const dir = mkdtempSync(join(tmpdir(), "trial-run-"));
      const { logger } = createCollectingLogger("debug");
      // First worker is fully gone; second still has a live scope.
      const seen: string[] = [];
      const observer: TrialRunnerObserverFns = {
        expectedScopeUnit: (executionId: string) =>
          `capsule-${executionId}-${"c".repeat(64)}.scope`,
        queryScope: async (_realpath: string, unit: string) => {
          seen.push(unit);
          if (unit.includes(second.executionId))
            return { scopeState: "active" as const, remainingRuntimeMs: 5000 };
          return { scopeState: "gone" as const };
        },
        readIdentity: async (pid: number) => {
          if (pid === 4249) return "gone";
          return { pid: 4250, bootId: "boot-s", processStartTicks: "333" };
        },
      };
      const { factory } = createFakeRelayFactory();
      const { spawnImpl } = createFakeSpawn();
      const runner = new TrialRunner({
        repo,
        config: runnerConfigBase("ws", writeTemplate(dir), join(dir, "runs")),
        isForegroundBusy: () => false,
        logger,
        observer,
        createRelay: factory,
        spawnImpl: spawnImpl as unknown as TrialRunnerSpawn,
        clock,
      });
      const out = await runner.recoverOnBoot();
      expect(out).toEqual({ settled: 1, fenced: 1 });
      expect(seen.length).toBe(2);
      expect(
        repo.readTrialLaunchIntent(sessionId, first.executionId).grant.status,
      ).toBe("interrupted");
      // The fence revoked nothing claimed but holds the alias: stage blocked.
      expect(() =>
        repo.stageTrial(
          sessionId,
          stageInput(makeAuthority(repo, sessionId, "b3").taskId) as never,
          {
            key: randomUUID(),
            now: clock(),
            profile: profile(),
            workspaceAlias: "ws",
          },
        ),
      ).toThrow();
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("claim-window revoke latches: no spawn, no permit (finding 1)", async () => {
    const { handle, repo, sessionId } = await makeKernel();
    try {
      const { executionId } = queueGrant(repo, sessionId, "b1", "ws");
      const identity = {
        pid: 4310,
        bootId: "boot-latch",
        processStartTicks: "555",
      };
      let releaseStart!: () => void;
      const startGate = new Promise<void>((r) => {
        releaseStart = r;
      });
      const { factory, relays } = createFakeRelayFactory();
      const latchFactory = (sockPath: string): TrialRunnerRelay => {
        const relay = factory(sockPath);
        relay.start = async () => {
          await startGate;
        };
        return relay;
      };
      const { spawnImpl, state } = createFakeSpawn();
      const spawnProxy = ((cmd: string, args: string[], opts: unknown) => {
        const child = (
          spawnImpl as unknown as (
            c: string,
            a: string[],
            o: unknown,
          ) => FakeChild
        )(cmd, args, opts);
        child.pid = identity.pid;
        return child;
      }) as unknown as TrialRunnerSpawn;
      const exited = { current: false };
      const observer = createObserver({
        scopeBeforeExit: "active",
        scopeAfterExit: "gone",
        identity,
        exited: () => exited.current,
      });
      const { logger } = createCollectingLogger("debug");
      const dir = mkdtempSync(join(tmpdir(), "trial-run-"));
      const runner = new TrialRunner({
        repo,
        config: runnerConfigBase("ws", writeTemplate(dir), join(dir, "runs")),
        isForegroundBusy: () => false,
        logger,
        observer,
        createRelay: latchFactory,
        spawnImpl: spawnProxy,
        clock: makeClock(),
      });
      const pending = runner.runNext();
      for (let i = 0; i < 400 && relays.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(relays.length).toBe(1);
      runner.revokeForForeground();
      releaseStart();
      const out = await pending;
      expect(out).toMatchObject({
        ran: true,
        outcome: "launch-failed",
        executionId,
      });
      expect(state.calls).toBe(0);
      expect(relays[0]?.permitted).toBe(false);
      expect(repo.readTrialLaunchPermit(sessionId, executionId)).toBeNull();
      expect(
        repo.readTrialLaunchIntent(sessionId, executionId).grant.status,
      ).toBe("interrupted");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("shutdown after claim never spawns and leaves interrupted (finding 5)", async () => {
    const { handle, repo, sessionId } = await makeKernel();
    try {
      const { executionId } = queueGrant(repo, sessionId, "b1", "ws");
      const identity = {
        pid: 4311,
        bootId: "boot-shut",
        processStartTicks: "556",
      };
      let releaseStart!: () => void;
      const startGate = new Promise<void>((r) => {
        releaseStart = r;
      });
      const { factory, relays } = createFakeRelayFactory();
      const gateFactory = (sockPath: string): TrialRunnerRelay => {
        const relay = factory(sockPath);
        relay.start = async () => {
          await startGate;
        };
        return relay;
      };
      const { spawnImpl, state } = createFakeSpawn();
      const spawnProxy = ((cmd: string, args: string[], opts: unknown) => {
        const child = (
          spawnImpl as unknown as (
            c: string,
            a: string[],
            o: unknown,
          ) => FakeChild
        )(cmd, args, opts);
        child.pid = identity.pid;
        return child;
      }) as unknown as TrialRunnerSpawn;
      const observer = createObserver({
        scopeBeforeExit: "active",
        scopeAfterExit: "gone",
        identity,
        exited: () => false,
      });
      const { logger } = createCollectingLogger("debug");
      const dir = mkdtempSync(join(tmpdir(), "trial-run-"));
      const runner = new TrialRunner({
        repo,
        config: runnerConfigBase("ws", writeTemplate(dir), join(dir, "runs")),
        isForegroundBusy: () => false,
        logger,
        observer,
        createRelay: gateFactory,
        spawnImpl: spawnProxy,
        clock: makeClock(),
      });
      const pending = runner.runNext();
      for (let i = 0; i < 400 && relays.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(relays.length).toBe(1);
      const shut = runner.shutdown(5000);
      releaseStart();
      const out = await pending;
      await shut;
      expect(out).toMatchObject({
        ran: true,
        outcome: "launch-failed",
        executionId,
      });
      expect(state.calls).toBe(0);
      expect(
        repo.readTrialLaunchIntent(sessionId, executionId).grant.status,
      ).toBe("interrupted");
      const stored = handle.raw
        .prepare(
          "SELECT authorized FROM trial_worker_outcomes WHERE execution_id=?",
        )
        .get(executionId) as { authorized: number } | undefined;
      if (stored !== undefined) expect(stored.authorized).toBe(0);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("stderr flood keeps draining without dropping the listener (finding 3)", async () => {
    const { handle, repo, sessionId } = await makeKernel();
    try {
      queueGrant(repo, sessionId, "b1", "ws");
      const exited = { current: false };
      const identity = {
        pid: 4312,
        bootId: "boot-err",
        processStartTicks: "557",
      };
      const seen: { child: FakeChild | null } = { child: null };
      const spawnImpl = ((cmd: string, args: string[], _opts: unknown) => {
        void cmd;
        void args;
        const child = new EventEmitter() as FakeChild;
        child.pid = identity.pid;
        const stdout = new EventEmitter();
        const stderr = new EventEmitter();
        let stdinBuf = "";
        child.stdin = {
          write(chunk: string) {
            stdinBuf += chunk;
          },
          end() {
            for (let i = 0; i < 40; i++) {
              stderr.emit("data", Buffer.alloc(4096, "e"));
            }
            stdout.emit("data", Buffer.alloc(20000, "x"));
            const req = JSON.parse(stdinBuf.split("\n")[0] as string) as Record<
              string,
              unknown
            >;
            stdout.emit("data", Buffer.from(`${validDoneLine(req)}\n`));
            child.emit("exit", 0, null);
          },
        };
        child.stdout = stdout;
        child.stderr = stderr;
        child.stdio = [
          child.stdin,
          stdout,
          stderr,
          {
            destroy() {
              /* noop */
            },
          },
        ];
        child.kill = () => undefined;
        const origEmit = child.emit.bind(child);
        child.emit = ((event: string, ...rest: unknown[]) => {
          if (event === "exit") exited.current = true;
          return (origEmit as (...a: unknown[]) => boolean)(event, ...rest);
        }) as FakeChild["emit"];
        seen.child = child;
        return child;
      }) as unknown as TrialRunnerSpawn;
      const observer = createObserver({
        scopeBeforeExit: "active",
        scopeAfterExit: "gone",
        identity,
        exited: () => exited.current,
      });
      const { factory } = createFakeRelayFactory();
      const { logger } = createCollectingLogger("debug");
      const dir = mkdtempSync(join(tmpdir(), "trial-run-"));
      const runner = new TrialRunner({
        repo,
        config: runnerConfigBase("ws", writeTemplate(dir), join(dir, "runs")),
        isForegroundBusy: () => false,
        logger,
        observer,
        createRelay: factory,
        spawnImpl,
        clock: makeClock(),
      });
      const out = await runner.runNext();
      expect(out.ran).toBe(true);
      if (seen.child === null)
        throw new Error("expected bridge child to be spawned");
      expect(seen.child.stderr.listenerCount("data")).toBe(1);
      expect(seen.child.stdout.listenerCount("data")).toBe(1);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("elapsed RuntimeMax pre-permit denies without relay permit (finding 4 permit path)", async () => {
    const { handle, repo, sessionId } = await makeKernel();
    try {
      const { executionId } = queueGrant(repo, sessionId, "b1", "ws");
      const exited = { current: false };
      const identity = {
        pid: 4313,
        bootId: "boot-elapsed",
        processStartTicks: "558",
      };
      const { spawnImpl, state } = createFakeSpawn();
      const spawnProxy = ((cmd: string, args: string[], opts: unknown) => {
        const child = (
          spawnImpl as unknown as (
            c: string,
            a: string[],
            o: unknown,
          ) => FakeChild
        )(cmd, args, opts);
        child.pid = identity.pid;
        const origEmit = child.emit.bind(child);
        child.emit = ((event: string, ...rest: unknown[]) => {
          if (event === "exit") exited.current = true;
          return (origEmit as (...a: unknown[]) => boolean)(event, ...rest);
        }) as FakeChild["emit"];
        return child;
      }) as unknown as TrialRunnerSpawn;
      const observer: TrialRunnerObserverFns = {
        expectedScopeUnit: (eid: string) =>
          `capsule-${eid}-${"c".repeat(64)}.scope`,
        queryScope: async () => ({
          scopeState: "active" as const,
          remainingRuntimeMs: 0,
        }),
        readIdentity: async () => ({ ...identity }),
      };
      const { factory, relays } = createFakeRelayFactory();
      const { logger } = createCollectingLogger("debug");
      const dir = mkdtempSync(join(tmpdir(), "trial-run-"));
      const runner = new TrialRunner({
        repo,
        config: runnerConfigBase("ws", writeTemplate(dir), join(dir, "runs")),
        isForegroundBusy: () => false,
        logger,
        observer,
        createRelay: factory,
        spawnImpl: spawnProxy,
        clock: makeClock(),
      });
      const out = await runner.runNext();
      expect(out).toMatchObject({
        ran: true,
        outcome: "permit-denied",
        executionId,
      });
      expect(relays[0]?.permitted).toBe(false);
      expect(state.fd3Destroyed).toBe(true);
      expect(repo.readTrialLaunchPermit(sessionId, executionId)).toBeNull();
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("post-exit elapsed/transient states keep polling until gone (finding 4 post-exit)", async () => {
    const { handle, repo, sessionId } = await makeKernel();
    try {
      queueGrant(repo, sessionId, "b1", "ws");
      const exited = { current: false };
      const identity = {
        pid: 4314,
        bootId: "boot-gone",
        processStartTicks: "559",
      };
      const { spawnImpl } = createFakeSpawn();
      const spawnProxy = ((cmd: string, args: string[], opts: unknown) => {
        const child = (
          spawnImpl as unknown as (
            c: string,
            a: string[],
            o: unknown,
          ) => FakeChild
        )(cmd, args, opts);
        child.pid = identity.pid;
        const origEmit = child.emit.bind(child);
        child.emit = ((event: string, ...rest: unknown[]) => {
          if (event === "exit") exited.current = true;
          return (origEmit as (...a: unknown[]) => boolean)(event, ...rest);
        }) as FakeChild["emit"];
        return child;
      }) as unknown as TrialRunnerSpawn;
      let afterExitQueries = 0;
      const observer: TrialRunnerObserverFns = {
        expectedScopeUnit: (eid: string) =>
          `capsule-${eid}-${"c".repeat(64)}.scope`,
        queryScope: async () => {
          if (!exited.current)
            return { scopeState: "active" as const, remainingRuntimeMs: 5000 };
          afterExitQueries += 1;
          if (afterExitQueries === 1)
            return { scopeState: "active" as const, remainingRuntimeMs: 0 };
          if (afterExitQueries === 2) return { scopeState: "unknown" as const };
          return { scopeState: "gone" as const };
        },
        readIdentity: async (pid: number) => {
          if (exited.current) return "gone";
          if (pid !== identity.pid) return "unknown";
          return { ...identity };
        },
      };
      const { factory } = createFakeRelayFactory();
      const { logger } = createCollectingLogger("debug");
      const dir = mkdtempSync(join(tmpdir(), "trial-run-"));
      const runner = new TrialRunner({
        repo,
        config: runnerConfigBase("ws", writeTemplate(dir), join(dir, "runs")),
        isForegroundBusy: () => false,
        logger,
        observer,
        createRelay: factory,
        spawnImpl: spawnProxy,
        clock: makeClock(),
      });
      const out = await runner.runNext();
      expect(afterExitQueries).toBeGreaterThanOrEqual(3);
      expect(out.outcome).not.toBe("fenced-unknown");
      expect(out.authorized).toBe(true);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
