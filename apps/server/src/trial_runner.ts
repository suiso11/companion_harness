// Root-side trial runner: executes ONE approved trial at a time.
//
// Owns the bridge child lifecycle for a single claimed grant: relay socket
// in a private run dir, per-execution bridge config copy, fd3 launch gate,
// kernel permit, mid-run revocation, and result/quiescence recording. No
// Task/Goal completion ever happens here (manual `trialOutcome` stays
// separate); user autonomy state is only read (pause/cancel/fence checks).

import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  TrialLaunchRequest,
  TrialProfileSnapshot,
  TrustedRuntimeObservation,
} from "@companion/contracts";
import type { KernelRepository } from "@companion/kernel";
import type { ModelGateway } from "@companion/model-local";
import type { ServerLogger } from "./logger.js";
import {
  TrialModelRelay,
  type TrialModelRelayCaps,
} from "./trial_model_relay.js";
import {
  expectedTrialScopeUnit,
  type ProcessIdentity,
  queryScopeUnit,
  readProcessIdentity,
  type ScopeUnitProps,
} from "./trial_observer.js";

/** Stdout framing allowance beyond the frozen budget (one trailing line). */
export const TRIAL_STDOUT_FRAMING_ALLOWANCE = 4096;
/** Fixed stderr drain cap (diagnostics only, never forwarded). */
export const TRIAL_STDERR_CAP_BYTES = 65536;
/** Fixed reason codes (never free text into the kernel fence/detail). */
export const TRIAL_REASON_INVALID_RESULT = "bridge-result-invalid";
export const TRIAL_REASON_FENCE_UNKNOWN_SCOPE = "scope-unknown-after-exit";
export const TRIAL_REASON_FENCE_RECOVER_UNSETTLED = "recover-unsettled-worker";

export interface TrialRunnerObserveTimeouts {
  /** Bound for the scope to become active after spawn. */
  activeTimeoutMs: number;
  /** Bound for the scope to read gone after bridge exit. */
  goneTimeoutMs: number;
  /** Poll cadence for scope/exit/cancel checks. */
  pollIntervalMs: number;
}

export interface TrialRunnerConfig {
  nodeRealpath: string;
  bridgeScriptPath: string;
  /** Absolute JSON template path; only modelSockHostPath is replaced. */
  bridgeConfigTemplatePath: string;
  systemctlRealpath: string;
  xdgRuntimeDir: string;
  workspaceAlias: string;
  profile: TrialProfileSnapshot;
  relayCaps: TrialModelRelayCaps;
  fixedModel: string;
  gateway: ModelGateway;
  observe: TrialRunnerObserveTimeouts;
  runDirBase?: string | undefined;
}

export interface TrialRunnerObserverFns {
  expectedScopeUnit: (executionId: string, taskHash: string) => string;
  queryScope: (
    systemctlRealpath: string,
    unit: string,
    opts: { xdgRuntimeDir: string; timeoutMs?: number },
  ) => Promise<ScopeUnitProps>;
  readIdentity: (pid: number) => Promise<ProcessIdentity>;
}

export interface TrialRunnerRelay {
  readonly path: string;
  setPermitted(permitted: boolean): void;
  revoke(): void;
  start(): Promise<void>;
  close(): Promise<void>;
}

export type TrialRunnerSpawn = typeof nodeSpawn;

export interface TrialRunnerDeps {
  repo: KernelRepository;
  config: TrialRunnerConfig;
  isForegroundBusy: () => boolean;
  logger: ServerLogger;
  observer?: TrialRunnerObserverFns | undefined;
  createRelay?: ((sockPath: string) => TrialRunnerRelay) | undefined;
  spawnImpl?: TrialRunnerSpawn | undefined;
  clock?: (() => number) | undefined;
  randomKey?: (() => string) | undefined;
}

export interface TrialRunNextResult {
  ran: boolean;
  outcome:
    | "empty"
    | "paused"
    | "foreground-busy"
    | "active"
    | "fenced"
    | "claim-failed"
    | "launch-failed"
    | "permit-denied"
    | "done"
    | "observed"
    | "quiescent"
    | "fenced-unknown";
  executionId?: string | undefined;
  authorized?: boolean | undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isFenceError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /fence/i.test(message);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  return value as Record<string, unknown>;
}

export class TrialRunner {
  private readonly repo: KernelRepository;
  private readonly config: TrialRunnerConfig;
  private readonly isForegroundBusy: () => boolean;
  private readonly logger: ServerLogger;
  private readonly observer: TrialRunnerObserverFns;
  private readonly createRelay: (sockPath: string) => TrialRunnerRelay;
  private readonly spawnImpl: TrialRunnerSpawn;
  private readonly clock: () => number;
  private readonly randomKey: () => string;
  private active = false;
  private readonly ownedPids = new Set<number>();
  private shuttingDown = false;
  private currentRelay: TrialRunnerRelay | null = null;
  private currentCloseFd3: (() => void) | null = null;
  private currentRun: Promise<TrialRunNextResult> | null = null;
  /**
   * Per-run sticky revoke latch: set by ANY revoke trigger (foreground
   * preempt, shutdown, mid-run pause/cancel) at ANY point of the run,
   * including the claim-before-spawn window when currentRelay is still null
   * (where a bare currentRelay?.revoke() would no-op). Cleared at the start
   * of each runNext pick; checked (plus fresh paused/FG/cancel) right before
   * relay.start, before spawn, and before setPermitted(true). When set, the
   * run aborts with no permit (fd3 closed, relay revoked).
   */
  private stopLatch = false;

  constructor(deps: TrialRunnerDeps) {
    if (!deps || typeof deps !== "object")
      throw new Error("trial_runner: deps are required");
    if (!deps.repo) throw new Error("trial_runner: repo is required");
    if (!deps.config) throw new Error("trial_runner: config is required");
    if (typeof deps.isForegroundBusy !== "function")
      throw new Error("trial_runner: isForegroundBusy is required");
    if (!deps.logger) throw new Error("trial_runner: logger is required");
    const cfg = deps.config;
    for (const key of [
      "nodeRealpath",
      "bridgeScriptPath",
      "bridgeConfigTemplatePath",
      "systemctlRealpath",
      "xdgRuntimeDir",
      "workspaceAlias",
      "fixedModel",
    ] as const) {
      if (typeof cfg[key] !== "string" || (cfg[key] as string).length === 0) {
        throw new Error(
          `trial_runner: config ${key} must be a non-empty string`,
        );
      }
    }
    if (!cfg.profile || !cfg.relayCaps || !cfg.gateway || !cfg.observe) {
      throw new Error(
        "trial_runner: config profile/relayCaps/gateway/observe are required",
      );
    }
    this.repo = deps.repo;
    this.config = cfg;
    this.isForegroundBusy = deps.isForegroundBusy;
    this.logger = deps.logger;
    this.observer = deps.observer ?? {
      expectedScopeUnit: expectedTrialScopeUnit,
      queryScope: (realpath, unit, opts) =>
        queryScopeUnit(realpath, unit, opts),
      readIdentity: (pid) => readProcessIdentity(pid),
    };
    const relayCaps = cfg.relayCaps;
    const gateway = cfg.gateway;
    const fixedModel = cfg.fixedModel;
    this.createRelay =
      deps.createRelay ??
      ((sockPath: string) =>
        new TrialModelRelay({
          sockPath,
          gateway,
          fixedModel,
          caps: { ...relayCaps },
          logger: this.logger,
        }));
    this.spawnImpl = deps.spawnImpl ?? nodeSpawn;
    this.clock = deps.clock ?? Date.now;
    // Random idempotency keys: crypto.randomUUID at call time (never cached).
    this.randomKey = deps.randomKey ?? (() => randomUUID());
  }

  get busy(): boolean {
    return this.active;
  }

  /**
   * Foreground preemption (user chat run started): revoke the in-flight
   * relay permit and close fd3 so the bridge cancels. Never kills the
   * bridge; the natural exit is recorded below with authorized=false.
   * Safe to call when idle (no-op). ALWAYS sets the per-run sticky latch
   * first, so a preempt arriving in the claim-before-spawn window (when
   * currentRelay/currentCloseFd3 are still null) is not lost.
   */
  revokeForForeground(): void {
    this.stopLatch = true;
    try {
      this.currentRelay?.revoke();
    } catch {
      // Best effort.
    }
    try {
      this.currentCloseFd3?.();
    } catch {
      // Best effort.
    }
  }

  /**
   * Bounded shutdown: stop new claims, revoke the relay + close fd3, then
   * await the in-flight run (which awaits the bridge exit) bounded by
   * `boundMs`. Never leaves a bridge orphaned (the child always exits
   * naturally after fd3 close); records nothing as authorized (the
   * in-flight path records quiescent/observed with authorized=false).
   */
  async shutdown(boundMs = 10_000): Promise<void> {
    this.shuttingDown = true;
    this.revokeForForeground();
    const run = this.currentRun;
    if (run === null) return;
    const bound = Math.max(0, boundMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, bound);
      });
      await Promise.race([run.then(() => undefined), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Startup recovery: settle claimed grants booted by a previous process. Never kills. */
  async recoverOnBoot(): Promise<{ settled: number; fenced: number }> {
    let settled = 0;
    let fenced = 0;
    let workers: ReturnType<
      KernelRepository["listClaimedTrialWorkersForRecovery"]
    >;
    try {
      workers = this.repo.listClaimedTrialWorkersForRecovery();
    } catch (error) {
      this.logger.warn("trial.recover_scan_failed", {});
      void error;
      return { settled, fenced };
    }
    for (const worker of workers) {
      if (this.ownedPids.has(worker.pid)) continue;
      try {
        const intent = this.repo.readTrialLaunchIntent(
          worker.sessionId,
          worker.executionId,
        );
        const request = intent.request as TrialLaunchRequest | null;
        const scope = intent.grant.scope as string;
        const alias = (request?.workspaceAlias ??
          worker.workspaceAlias ??
          this.config.workspaceAlias) as string;
        const taskHash = request?.taskHash ?? null;
        let unit = "";
        if (typeof taskHash === "string") {
          try {
            unit = this.observer.expectedScopeUnit(
              worker.executionId,
              taskHash,
            );
          } catch {
            unit = "";
          }
        }
        const [scopeProps, identity] = await Promise.all([
          unit === ""
            ? Promise.resolve<ScopeUnitProps>({
                scopeState: "unknown" as const,
              })
            : this.observer.queryScope(this.config.systemctlRealpath, unit, {
                xdgRuntimeDir: this.config.xdgRuntimeDir,
              }),
          this.observer.readIdentity(worker.pid),
        ]);
        if (scopeProps.scopeState === "gone" && identity === "gone") {
          this.repo.recordTrialQuiescence(
            worker.sessionId,
            scope,
            worker.executionId,
            this.clock(),
          );
          settled += 1;
          this.logger.info("trial.recover_quiescent", {});
        } else {
          this.repo.recordTrialQuiescence(
            worker.sessionId,
            scope,
            null,
            this.clock(),
            {
              workspaceAlias: alias,
              executionId: worker.executionId,
              ...(taskHash === null ? {} : { taskHash }),
              reason: TRIAL_REASON_FENCE_RECOVER_UNSETTLED,
            },
          );
          fenced += 1;
          this.logger.warn("trial.recover_fenced", {});
        }
      } catch (error) {
        this.logger.warn("trial.recover_worker_failed", {});
        void error;
      }
    }
    return { settled, fenced };
  }

  /** Execute ONE oldest queued grant for the alias, or no-op with a reason. */
  async runNext(): Promise<TrialRunNextResult> {
    if (this.active) return { ran: false, outcome: "active" };
    if (this.shuttingDown) return { ran: false, outcome: "empty" };
    // Fresh per-pick latch: idle revokes are no-ops and must not leak into
    // the next pick; any revoke after this point sticks for the whole run.
    this.stopLatch = false;
    try {
      if (this.repo.getAutonomyControlState().paused) {
        return { ran: false, outcome: "paused" };
      }
    } catch {
      return { ran: false, outcome: "paused" };
    }
    if (this.isForegroundBusy())
      return { ran: false, outcome: "foreground-busy" };
    let queued: { executionId: string; sessionId: string; scope: string }[];
    try {
      queued = this.repo.listQueuedTrialGrantsForAlias(
        this.config.workspaceAlias,
        1,
      );
    } catch {
      return { ran: false, outcome: "empty" };
    }
    const next = queued[0];
    if (next === undefined) return { ran: false, outcome: "empty" };

    let claimBody: { request: TrialLaunchRequest; grant: { scope: string } };
    try {
      const out = this.repo.claimTrial(next.sessionId, next.executionId, {
        key: this.randomKey(),
        now: this.clock(),
        profile: this.config.profile,
        workspaceAlias: this.config.workspaceAlias,
      });
      // claimTrial body is { kind, grant, request, applied? }: normalize.
      const raw = out.body as unknown as Record<string, unknown>;
      claimBody = {
        request: raw["request"] as TrialLaunchRequest,
        grant: raw["grant"] as { scope: string },
      };
    } catch (error) {
      if (isFenceError(error)) {
        this.logger.warn("trial.claim_fenced", {});
        return { ran: false, outcome: "fenced", executionId: next.executionId };
      }
      this.logger.warn("trial.claim_failed", {});
      void error;
      return {
        ran: true,
        outcome: "claim-failed",
        executionId: next.executionId,
      };
    }

    this.active = true;
    try {
      this.logger.info("trial.claimed", { runId: next.executionId });
      // Shutdown re-check after claim, before any boot: never spawn while
      // shutting down. The grant stays claimed-with-no-boot; record known
      // quiescence (→ interrupted, never authorized) via the existing API.
      if (this.shuttingDown || this.stopLatch) {
        try {
          const scope = (claimBody.grant as { scope: string }).scope as string;
          this.repo.recordTrialQuiescence(
            next.sessionId,
            scope,
            next.executionId,
            this.clock(),
          );
        } catch {
          // Best effort: quiescence evidence never fails the outcome.
        }
        return {
          ran: true,
          outcome: "launch-failed",
          executionId: next.executionId,
        };
      }
      const run = this.executeClaimed(
        next.sessionId,
        next.executionId,
        claimBody.request,
      );
      this.currentRun = run;
      return await run;
    } finally {
      this.currentRun = null;
      this.active = false;
    }
  }

  /**
   * Fresh stop check: sticky latch, shutdown, paused, foreground-busy, or
   * kernel cancel-requested. Best-effort reads never throw (a lost read
   * never stops on its own, except paused which fails closed).
   */
  private stopRequested(sessionId: string, executionId: string): boolean {
    if (this.stopLatch) return true;
    if (this.shuttingDown) return true;
    try {
      if (this.repo.getAutonomyControlState().paused) return true;
    } catch {
      return true;
    }
    if (this.isForegroundBusy()) return true;
    try {
      const intent = this.repo.readTrialLaunchIntent(sessionId, executionId);
      if (
        (intent.grant as { cancelRequested?: boolean }).cancelRequested === true
      )
        return true;
    } catch {
      // Best effort: a lost read never stops on its own.
    }
    return false;
  }

  /** Known-quiescence abort for a claimed grant that never booted (no child). */
  private abortClaimedBeforeBoot(
    sessionId: string,
    executionId: string,
    scopeFallback: string,
  ): void {
    try {
      let scope = scopeFallback;
      try {
        const intent = this.repo.readTrialLaunchIntent(sessionId, executionId);
        scope = intent.grant.scope as string;
      } catch {
        // Fall back to the claim-time scope.
      }
      this.repo.recordTrialQuiescence(
        sessionId,
        scope,
        executionId,
        this.clock(),
      );
    } catch {
      // Best effort.
    }
  }

  private async executeClaimed(
    sessionId: string,
    executionId: string,
    request: TrialLaunchRequest,
  ): Promise<TrialRunNextResult> {
    const now = this.clock();
    void now;
    this.logger.info("trial.run_start", {});
    const base = this.config.runDirBase ?? tmpdir();
    mkdirSync(base, { recursive: true, mode: 0o700 });
    const runDir = mkdtempSync(join(base, "trial-exec-"));
    chmodSync(runDir, 0o700);
    const sockPath = join(runDir, "relay", "model.sock");
    const relay = this.createRelay(sockPath);
    this.currentRelay = relay;
    const cleanup = async (): Promise<void> => {
      this.currentRelay = null;
      this.currentCloseFd3 = null;
      try {
        await relay.close();
      } catch {
        // Best effort: close is idempotent.
      }
      try {
        rmSync(runDir, { recursive: true, force: true });
      } catch {
        // Best effort: run dir removal never fails the outcome.
      }
    };

    try {
      // Gate 1 (pre-start): a STOP/foreground/cancel/shutdown arriving in
      // the claim-before-spawn window sets the sticky latch while
      // currentRelay is still null — check it (plus fresh state) here so the
      // permit is never issued and the relay never opens.
      if (this.stopRequested(sessionId, executionId)) {
        try {
          relay.revoke();
        } catch {
          // Best effort.
        }
        this.abortClaimedBeforeBoot(
          sessionId,
          executionId,
          request.workspaceAlias,
        );
        await cleanup();
        return { ran: true, outcome: "launch-failed", executionId };
      }
      await relay.start();
    } catch {
      await cleanup();
      return { ran: true, outcome: "launch-failed", executionId };
    }

    // Per-execution bridge config: 0700 dir already set; 0600 file; ONLY
    // modelSockHostPath is replaced from the absolute JSON template.
    const execConfigPath = join(runDir, "bridge.config.json");
    try {
      const template = JSON.parse(
        readFileSync(this.config.bridgeConfigTemplatePath, "utf8"),
      ) as Record<string, unknown>;
      const execConfig = { ...template, modelSockHostPath: sockPath };
      writeFileSync(execConfigPath, JSON.stringify(execConfig), {
        mode: 0o600,
      });
      chmodSync(execConfigPath, 0o600);
    } catch {
      await cleanup();
      return { ran: true, outcome: "launch-failed", executionId };
    }

    // Spawn bridge with an fd3 launch-gate pipe (index 3). stdout is capped
    // at budget.maxOutputBytes + a small fixed framing allowance (one
    // trailing result line); stderr has a fixed diagnostic cap.
    // Gate 2 (pre-spawn): re-check shutdown + sticky latch + fresh state so
    // a revoke in the relay-start/config window never spawns the bridge.
    if (this.stopRequested(sessionId, executionId)) {
      try {
        relay.revoke();
      } catch {
        // Best effort.
      }
      this.abortClaimedBeforeBoot(
        sessionId,
        executionId,
        request.workspaceAlias,
      );
      await cleanup();
      return { ran: true, outcome: "launch-failed", executionId };
    }
    const stdoutCap =
      request.budget.maxOutputBytes + TRIAL_STDOUT_FRAMING_ALLOWANCE;
    let child: ChildProcess;
    try {
      child = this.spawnImpl(
        this.config.nodeRealpath,
        [this.config.bridgeScriptPath, "--config", execConfigPath],
        {
          stdio: ["pipe", "pipe", "pipe", "pipe"],
        },
      ) as ChildProcess;
    } catch {
      await cleanup();
      return { ran: true, outcome: "launch-failed", executionId };
    }
    const pid = child.pid;
    if (pid === undefined) {
      try {
        child.kill();
      } catch {
        // Best effort.
      }
      await cleanup();
      return { ran: true, outcome: "launch-failed", executionId };
    }
    this.ownedPids.add(pid);

    // Eager exit latch: the bridge may exit before any waiter attaches
    // (fake or fast bridges), so the 'exit' event is captured once here
    // and every later wait observes the latched outcome.
    let childExit: { exitCode: number | null; signal: string | null } | null =
      null;
    const childExitWaiters: Array<
      (v: { exitCode: number | null; signal: string | null }) => void
    > = [];
    const settleChildExit = (v: {
      exitCode: number | null;
      signal: string | null;
    }): void => {
      if (childExit !== null) return;
      childExit = v;
      const waiters = childExitWaiters.splice(0);
      for (const waiter of waiters) {
        try {
          waiter(v);
        } catch {
          // Best effort.
        }
      }
    };
    child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      settleChildExit({ exitCode: code, signal });
    });
    child.once("error", () => {
      settleChildExit({ exitCode: null, signal: null });
    });
    const awaitChildExit = (): Promise<{
      exitCode: number | null;
      signal: string | null;
    }> => {
      if (childExit !== null) return Promise.resolve(childExit);
      return new Promise((resolve) => {
        childExitWaiters.push(resolve);
      });
    };

    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stdoutTruncated = false;
    // Both caps keep draining (discard beyond cap, listener stays attached)
    // so the child can never block on a full pipe.
    child.stdout?.on("data", (chunk: Buffer | string) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      if (stdoutTruncated) return;
      if (stdoutBytes + buf.length > stdoutCap) {
        stdoutTruncated = true;
        return;
      }
      stdoutChunks.push(buf);
      stdoutBytes += buf.length;
    });
    let stderrBytes = 0;
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      stderrBytes += buf.length;
      // Discard beyond the cap: keep the listener attached so stderr keeps
      // draining and the bridge can never block on a full pipe.
      void buf;
    });

    const closeFd3 = (): void => {
      try {
        const fd3 = (child.stdio?.[3] ?? null) as {
          destroy?: () => void;
        } | null;
        fd3?.destroy?.();
      } catch {
        // Best effort: bridge cancel signal never throws the runner.
      }
    };
    this.currentCloseFd3 = closeFd3;
    const failLaunch = async (): Promise<TrialRunNextResult> => {
      try {
        relay.revoke();
      } catch {
        // Best effort.
      }
      closeFd3();
      const bridgeExit = await awaitChildExit();
      // Redacted launch-failure trace: exit code + signal only.
      this.logger.info("trial.bridge_exit", {
        runId: executionId,
        status: bridgeExit.exitCode ?? "unknown",
        ...(bridgeExit.signal === null
          ? {}
          : { reason: bridgeExit.signal.toLowerCase() }),
      });
      try {
        const intent = this.repo.readTrialLaunchIntent(sessionId, executionId);
        this.repo.recordTrialQuiescence(
          sessionId,
          intent.grant.scope as string,
          executionId,
          this.clock(),
        );
      } catch {
        // Best effort: quiescence evidence never fails the outcome.
      }
      await cleanup();
      this.ownedPids.delete(pid);
      return { ran: true, outcome: "launch-failed", executionId };
    };

    // Birth identity BEFORE any payload.
    const bootIdentity = await this.observer.readIdentity(pid);
    if (bootIdentity === "gone" || bootIdentity === "unknown") {
      return await failLaunch();
    }
    try {
      this.repo.registerTrialWorkerBoot(
        {
          executionId,
          sessionId,
          pid: bootIdentity.pid,
          bootId: bootIdentity.bootId,
          processStartTicks: bootIdentity.processStartTicks,
        },
        this.clock(),
      );
    } catch {
      return await failLaunch();
    }
    this.logger.info("trial.boot_registered", { runId: executionId });

    // Canonical request + newline, then end stdin.
    try {
      const stdin = child.stdin;
      if (stdin === null || stdin === undefined) throw new Error("no stdin");
      stdin.write(`${JSON.stringify(request)}\n`);
      stdin.end();
    } catch {
      return await failLaunch();
    }

    // Poll until the expected scope unit is active.
    let unit = "";
    try {
      unit = this.observer.expectedScopeUnit(executionId, request.taskHash);
    } catch {
      return await failLaunch();
    }
    const activeDeadline = this.clock() + this.config.observe.activeTimeoutMs;
    const scopeWaitStart = this.clock();
    let remainingRuntimeMs = request.budget.timeoutMs;
    let scopeActive = false;
    while (this.clock() < activeDeadline) {
      let props: ScopeUnitProps;
      try {
        props = await this.observer.queryScope(
          this.config.systemctlRealpath,
          unit,
          {
            xdgRuntimeDir: this.config.xdgRuntimeDir,
          },
        );
      } catch {
        props = { scopeState: "unknown" };
      }
      if (props.scopeState === "active") {
        scopeActive = true;
        if (typeof props.remainingRuntimeMs === "number")
          remainingRuntimeMs = props.remainingRuntimeMs;
        break;
      }
      if (props.scopeState === "gone" && childExit !== null) {
        // The bridge already exited without ever activating the scope, so
        // the unit will never be created. While the bridge is still alive
        // the unit may simply not exist yet (capsule startup races the
        // first poll), so keep waiting until the active deadline.
        return await failLaunch();
      }
      await sleep(this.config.observe.pollIntervalMs);
    }
    if (!scopeActive) {
      return await failLaunch();
    }
    this.logger.info("trial.scope_active", {
      runId: executionId,
      durationMs: Math.max(0, this.clock() - scopeWaitStart),
    });

    // Kernel permit with a fresh pid identity + frozen budget props.
    const permitIdentity = await this.observer.readIdentity(pid);
    if (permitIdentity === "gone" || permitIdentity === "unknown") {
      return await failLaunch();
    }
    let requestHash = "";
    try {
      requestHash = this.repo.hashTrialLaunchRequest(request);
    } catch {
      return await failLaunch();
    }
    const observation: TrustedRuntimeObservation = {
      scopeState: "active",
      frontendSettled: false,
      pid: permitIdentity.pid,
      bootId: permitIdentity.bootId,
      processStartTicks: permitIdentity.processStartTicks,
      // Elapsed RuntimeMax surfaces as remaining 0 (active/tearing down):
      // clamp to the schema floor for the local object, but the explicit
      // remaining<=0 check below still routes to permit-denied (kernel fit).
      remainingRuntimeMs: remainingRuntimeMs <= 0 ? 1 : remainingRuntimeMs,
      timeoutMs: request.budget.timeoutMs,
      maxOutputBytes: request.budget.maxOutputBytes,
      foregroundGateOpen: !this.isForegroundBusy(),
      observedAt: this.clock(),
    };
    // Gate 3 (pre-permit): sticky latch + fresh paused/FG/cancel/shutdown,
    // plus elapsed-RuntimeMax (remaining<=0) deny — never setPermitted(true)
    // when any stop is requested. Elapsed remaining denies via the same
    // permit-denied path the kernel fit would take (never authorized).
    if (this.stopRequested(sessionId, executionId) || remainingRuntimeMs <= 0) {
      this.logger.warn("trial.permit_denied", {
        runId: executionId,
        reason: "unknown",
      });
      try {
        relay.revoke();
      } catch {
        // Best effort.
      }
      closeFd3();
      await awaitChildExit();
      try {
        const intent = this.repo.readTrialLaunchIntent(sessionId, executionId);
        this.repo.recordTrialQuiescence(
          sessionId,
          intent.grant.scope as string,
          executionId,
          this.clock(),
        );
      } catch {
        // Best effort.
      }
      await cleanup();
      this.ownedPids.delete(pid);
      return { ran: true, outcome: "permit-denied", executionId };
    }
    try {
      this.repo.issueTrialLaunchPermit(sessionId, executionId, {
        key: this.randomKey(),
        now: this.clock(),
        observation,
        profile: this.config.profile,
        requestHash,
      });
      this.logger.info("trial.permit_issued", { runId: executionId });
    } catch (error) {
      this.logger.warn("trial.permit_denied", {
        runId: executionId,
        reason: isFenceError(error) ? "fence" : "unknown",
      });
      try {
        relay.revoke();
      } catch {
        // Best effort.
      }
      closeFd3();
      await awaitChildExit();
      try {
        const intent = this.repo.readTrialLaunchIntent(sessionId, executionId);
        this.repo.recordTrialQuiescence(
          sessionId,
          intent.grant.scope as string,
          executionId,
          this.clock(),
        );
      } catch {
        // Best effort.
      }
      await cleanup();
      this.ownedPids.delete(pid);
      return { ran: true, outcome: "permit-denied", executionId };
    }
    try {
      relay.setPermitted(true);
    } catch {
      this.logger.warn("trial.permit_denied", {
        runId: executionId,
        reason: "relay",
      });
      try {
        relay.revoke();
      } catch {
        // Best effort.
      }
      closeFd3();
      await awaitChildExit();
      await cleanup();
      this.ownedPids.delete(pid);
      return { ran: true, outcome: "permit-denied", executionId };
    }

    // While running: pause / cancelRequested / foreground-busy revokes the
    // relay and closes fd3 (bridge cancels); the child is never SIGKILLed
    // here — its natural exit is recorded below. Every trigger also sets the
    // sticky stop latch so the pre-permit gates observe it.
    let revoked = false;
    const revokeForStop = (): void => {
      if (revoked) return;
      revoked = true;
      this.stopLatch = true;
      try {
        relay.revoke();
      } catch {
        // Best effort.
      }
      closeFd3();
    };
    const exitPromise = awaitChildExit();
    const bridgeExit = await raceWithPoll(
      exitPromise,
      async () => {
        try {
          if (this.repo.getAutonomyControlState().paused) {
            revokeForStop();
            return;
          }
        } catch {
          revokeForStop();
          return;
        }
        if (this.isForegroundBusy()) {
          revokeForStop();
          return;
        }
        try {
          const intent = this.repo.readTrialLaunchIntent(
            sessionId,
            executionId,
          );
          if (
            (intent.grant as { cancelRequested: boolean }).cancelRequested ===
            true
          ) {
            revokeForStop();
          }
        } catch {
          // Best effort: a lost read never revokes on its own.
        }
      },
      this.config.observe.pollIntervalMs,
    );
    // Redacted bridge-exit trace: exit code + signal only.
    this.logger.info("trial.bridge_exit", {
      runId: executionId,
      status: bridgeExit.exitCode ?? "unknown",
      ...(bridgeExit.signal === null
        ? {}
        : { reason: bridgeExit.signal.toLowerCase() }),
    });

    // Wait for the unit to read gone (bounded). Semantics: ONLY 'gone'
    // counts. 'active' — including remaining 0 from an elapsed RuntimeMax
    // (tearing down, not unknown) — and transient 'unknown' (single query
    // failure/garbage) keep polling until the deadline. Fence only when
    // still not gone at the deadline with a terminally-unknown scope, or
    // when queries fail persistently (consecutive exceptions); a still-active
    // scope at the deadline records known quiescence (interrupted).
    const goneDeadline = this.clock() + this.config.observe.goneTimeoutMs;
    let gone = false;
    let lastState: ScopeUnitProps["scopeState"] = "active";
    let queryFailStreak = 0;
    let persistentQueryFailure = false;
    while (this.clock() < goneDeadline) {
      let props: ScopeUnitProps;
      try {
        props = await this.observer.queryScope(
          this.config.systemctlRealpath,
          unit,
          {
            xdgRuntimeDir: this.config.xdgRuntimeDir,
          },
        );
        queryFailStreak = 0;
      } catch {
        queryFailStreak += 1;
        if (queryFailStreak >= 10) {
          persistentQueryFailure = true;
          break;
        }
        await sleep(this.config.observe.pollIntervalMs);
        continue;
      }
      if (props.scopeState === "gone") {
        gone = true;
        break;
      }
      lastState = props.scopeState;
      await sleep(this.config.observe.pollIntervalMs);
    }
    if (!gone && (persistentQueryFailure || lastState === "unknown")) {
      try {
        const intent = this.repo.readTrialLaunchIntent(sessionId, executionId);
        this.repo.recordTrialQuiescence(
          sessionId,
          intent.grant.scope as string,
          null,
          this.clock(),
          {
            workspaceAlias: request.workspaceAlias,
            executionId,
            taskHash: request.taskHash,
            reason: TRIAL_REASON_FENCE_UNKNOWN_SCOPE,
          },
        );
      } catch {
        // Best effort: fence evidence never fails the outcome.
      }
      await cleanup();
      this.ownedPids.delete(pid);
      return {
        ran: true,
        outcome: "fenced-unknown",
        executionId,
        authorized: false,
      };
    }
    if (!gone) {
      try {
        const intent = this.repo.readTrialLaunchIntent(sessionId, executionId);
        this.repo.recordTrialQuiescence(
          sessionId,
          intent.grant.scope as string,
          executionId,
          this.clock(),
        );
      } catch {
        // Best effort.
      }
      await cleanup();
      this.ownedPids.delete(pid);
      return {
        ran: true,
        outcome: "quiescent",
        executionId,
        authorized: false,
      };
    }

    // Final stdout line is the wire result JSON.
    const stdoutText = Buffer.concat(stdoutChunks).toString("utf8");
    const proof = parseBridgeResult(stdoutText, request);
    const detail =
      proof.kind === "valid"
        ? `bridge-exit:${proof.exitCode}`
        : TRIAL_REASON_INVALID_RESULT;
    const result =
      proof.kind === "valid"
        ? {
            taskHash: proof.taskHash,
            exitCode: proof.exitCode,
            checks: proof.checks,
            outputMatched: proof.outputMatched && !stdoutTruncated,
            noTimeout: proof.noTimeout,
          }
        : {
            taskHash: request.taskHash,
            exitCode: proof.exitCode,
            checks: request.requiredChecks.map((id) => ({
              id,
              ok: false as const,
            })),
            outputMatched: false as const,
            noTimeout: false as const,
          };
    const goneObservation: TrustedRuntimeObservation = {
      scopeState: "gone",
      frontendSettled: true,
      pid: bootIdentity.pid,
      bootId: bootIdentity.bootId,
      processStartTicks: bootIdentity.processStartTicks,
      remainingRuntimeMs: 1,
      timeoutMs: request.budget.timeoutMs,
      maxOutputBytes: request.budget.maxOutputBytes,
      foregroundGateOpen: !this.isForegroundBusy(),
      observedAt: this.clock(),
    };
    let authorized = false;
    let outcome: TrialRunNextResult["outcome"] = "observed";
    try {
      const recorded = this.repo.recordTrialWorkerResult(
        sessionId,
        executionId,
        { detail, observation: goneObservation, result },
        this.clock(),
      );
      authorized = recorded.authorized === true;
      outcome = recorded.outcome === "done" ? "done" : "observed";
    } catch (error) {
      this.logger.warn("trial.result_failed", {});
      void error;
      outcome = "observed";
    }
    // Redacted result trace: outcome + authorized-as-1/0 only.
    this.logger.info("trial.result_recorded", {
      runId: executionId,
      status: outcome,
      attempt: authorized ? 1 : 0,
    });
    await cleanup();
    this.ownedPids.delete(pid);
    this.logger.info("trial.run_end", {});
    return { ran: true, outcome, executionId, authorized };
  }
}
async function raceWithPoll<T>(
  done: Promise<T>,
  poll: () => Promise<void>,
  intervalMs: number,
): Promise<T> {
  let finished = false;
  const guarded = done.then((value) => {
    finished = true;
    return value;
  });
  while (!finished) {
    const timeout = await Promise.race([
      guarded.then(() => "done" as const),
      sleep(Math.max(1, intervalMs)).then(() => "tick" as const),
    ]);
    if (timeout === "done") break;
    await poll();
  }
  return guarded;
}

type ParsedBridgeResult =
  | {
      kind: "valid";
      taskHash: string;
      exitCode: number;
      checks: { id: string; ok: boolean }[];
      outputMatched: boolean;
      noTimeout: boolean;
    }
  | { kind: "invalid"; exitCode: number };

function parseWireCheckEntry(
  entry: unknown,
): { id: string; ok: boolean } | null {
  const item = asRecord(entry);
  if (
    item === null ||
    typeof item["id"] !== "string" ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(item["id"] as string)
  ) {
    return null;
  }
  const exitCode = item["exitCode"];
  const timedOut = item["timedOut"];
  const outputMatched = item["outputMatched"];
  if (
    (typeof exitCode !== "number" || !Number.isSafeInteger(exitCode)) &&
    exitCode !== null
  )
    return null;
  if (typeof timedOut !== "boolean" || typeof outputMatched !== "boolean")
    return null;
  const ok = exitCode === 0 && timedOut === false && outputMatched === true;
  return { id: item["id"] as string, ok };
}

/** Map a real bridge wire result line to the kernel result proof. */
function parseWireBridgeResult(parsed: unknown): ParsedBridgeResult | null {
  const record = asRecord(parsed);
  if (record === null) return null;
  // Distinguish wire format (version/status/verified/report/evidence) from
  // the legacy test format ({taskHash, exitCode, checks:[{id,ok}], ...}).
  if (
    record["version"] === undefined &&
    record["status"] === undefined &&
    record["evidence"] === undefined
  ) {
    return null;
  }
  if (record["version"] !== 1) return { kind: "invalid", exitCode: 1 };
  const taskHash = record["taskHash"];
  const status = record["status"];
  const verified = record["verified"];
  if (typeof taskHash !== "string" || !/^[0-9a-f]{64}$/.test(taskHash)) {
    return { kind: "invalid", exitCode: 1 };
  }
  if (
    status !== "done" &&
    status !== "error" &&
    status !== "cancelled" &&
    status !== "unknown"
  ) {
    return { kind: "invalid", exitCode: 1 };
  }
  if (typeof verified !== "boolean") return { kind: "invalid", exitCode: 1 };
  const evidence = asRecord(record["evidence"]);
  if (evidence === null || !Array.isArray(evidence["checks"]))
    return { kind: "invalid", exitCode: 1 };
  const rawChecks = evidence["checks"] as unknown[];
  const mapped: { id: string; ok: boolean }[] = [];
  for (const entry of rawChecks) {
    const check = parseWireCheckEntry(entry);
    if (check === null)
      return { kind: "invalid", exitCode: status === "cancelled" ? 143 : 1 };
    if (mapped.length < 16) mapped.push(check);
  }
  if (mapped.length !== rawChecks.length)
    return { kind: "invalid", exitCode: status === "cancelled" ? 143 : 1 };
  // An empty check set is well-formed only for non-done results: the bridge
  // reports status done exclusively with the exact required check set, so a
  // done line with no checks is malformed. Empty error/cancelled/unknown
  // lines (e.g. the capsule failed before checks ran) stay valid-shaped so
  // the kernel records the faithful observed failure instead of a
  // synthesized bridge-result-invalid.
  if (mapped.length === 0 && status === "done")
    return { kind: "invalid", exitCode: 1 };
  const exitCode =
    status === "done" && verified === true
      ? 0
      : status === "cancelled"
        ? 143
        : 1;
  const outputMatched = mapped.length > 0 && mapped.every((c) => c.ok);
  const noTimeout =
    mapped.length > 0 &&
    (evidence["checks"] as unknown[]).every(
      (entry) => asRecord(entry)?.["timedOut"] === false,
    );
  return {
    kind: "valid",
    taskHash,
    exitCode,
    checks: mapped,
    outputMatched,
    noTimeout,
  };
}

function parseBridgeResult(
  text: string,
  request: TrialLaunchRequest,
): ParsedBridgeResult {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const last = lines[lines.length - 1];
  if (last === undefined) return { kind: "invalid", exitCode: 1 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(last);
  } catch {
    return { kind: "invalid", exitCode: 1 };
  }
  const record = asRecord(parsed);
  if (record === null) return { kind: "invalid", exitCode: 1 };
  const wire = parseWireBridgeResult(parsed);
  if (wire !== null) return wire;
  const taskHash = record["taskHash"];
  const exitCode = record["exitCode"];
  const checks = record["checks"];
  const outputMatched = record["outputMatched"];
  const noTimeout = record["noTimeout"];
  if (typeof taskHash !== "string" || !/^[0-9a-f]{64}$/.test(taskHash)) {
    return {
      kind: "invalid",
      exitCode:
        typeof exitCode === "number" && Number.isInteger(exitCode)
          ? exitCode
          : 1,
    };
  }
  if (typeof exitCode !== "number" || !Number.isInteger(exitCode)) {
    return { kind: "invalid", exitCode: 1 };
  }
  if (!Array.isArray(checks) || checks.length === 0 || checks.length > 16) {
    return { kind: "invalid", exitCode };
  }
  const mapped: { id: string; ok: boolean }[] = [];
  for (const entry of checks) {
    const item = asRecord(entry);
    if (
      item === null ||
      typeof item["id"] !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(item["id"] as string) ||
      typeof item["ok"] !== "boolean"
    ) {
      return { kind: "invalid", exitCode };
    }
    mapped.push({ id: item["id"] as string, ok: item["ok"] as boolean });
  }
  if (outputMatched !== true && outputMatched !== false)
    return { kind: "invalid", exitCode };
  if (noTimeout !== true && noTimeout !== false)
    return { kind: "invalid", exitCode };
  void request;
  return {
    kind: "valid",
    taskHash,
    exitCode,
    checks: mapped,
    outputMatched,
    noTimeout,
  };
}
