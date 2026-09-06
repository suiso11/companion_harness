// M0 RunEngine + durable scheduler (plan §3, §9 blockers 1-3, §11.3-11.5).
//
// - RunEngine alone owns the lifecycle; every state transition and event
//   goes through repository CAS transactions. The engine never writes
//   `runs` rows directly (pickup uses a read-only SELECT; start/complete/
//   fail/cancel/finalize/recover/drain all delegate to the repository).
// - RunStrategy implementations receive only the frozen strategy context
//   plus an AbortSignal and hold no DB access, so they cannot write state.
// - Scheduler pickup is durable and ordered (`queued ORDER BY created_at`)
//   and CAS-guarded: a lost start race simply skips that row.
// - Different sessions execute concurrently up to `maxConcurrency`;
//   same-session active uniqueness stays DB-enforced (partial unique
//   index surfaces as SessionBusyError at intake, never in the engine).
// - Cancel commits to the DB FIRST, then aborts the signal. Results that
//   arrive after cancel_requested are discarded via CAS; terminal events
//   stay final.
// - Normal cancel uses a watchdog that settles cancel_requested no later
//   than `cancelGraceMs` (default 3000ms). Graceful drain uses separate
//   semantics: no watchdog, running -> abandoned, cancel_requested ->
//   cancelled, queued untouched.

import {
  isTerminalStatus,
  parseRunResult,
  type RunResult,
} from "@companion/contracts";
import type Database from "better-sqlite3";
import {
  RepositoryNotFoundError,
  RepositoryValidationError,
} from "./errors.js";
import type { KernelRepository, RunRow, TurnRow } from "./repository.js";
import {
  freezeStrategyContext,
  StrategyError,
  StrategyRegistry,
} from "./strategy.js";

/** Default: normal-cancel watchdog settles within 3000ms (§9 blocker 3). */
export const DEFAULT_CANCEL_GRACE_MS = 3000;
/** Default: graceful drain waits up to 10s for natural completion (§11.5). */
export const DEFAULT_DRAIN_MS = 10_000;
/** Default: bounded process-wide execution concurrency. */
export const DEFAULT_MAX_CONCURRENCY = 8;
/** Default: scheduler poll cadence between pickup passes. */
export const DEFAULT_POLL_INTERVAL_MS = 10;

/** Injectable clock/timers so tests can run on a fake clock. */
export interface EngineClock {
  now(): number;
  sleep(ms: number): Promise<void>;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemClock: EngineClock = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
  clearTimeout: (handle: unknown) => clearTimeout(handle as never),
};

export interface RunEngineOptions {
  /** Single better-sqlite3 connection (read-only pickup SELECTs only). */
  db: Database.Database;
  /** CAS transaction owner for every lifecycle transition. */
  repo: KernelRepository;
  /** Replaceable strategies; defaults to an empty registry. */
  registry?: StrategyRegistry;
  /** Max concurrent strategy executions process-wide. Default 8. */
  maxConcurrency?: number;
  /** Scheduler poll cadence in ms. Default 10. */
  pollIntervalMs?: number;
  /** Normal-cancel watchdog bound in ms. Default 3000. */
  cancelGraceMs?: number;
  /** Graceful-drain natural-completion budget in ms. Default 10000. */
  drainMs?: number;
  /** Injectable clock (fake-clock-friendly). Defaults to system timers. */
  clock?: EngineClock;
}

export interface EngineRecovery {
  abandoned: number;
  cancelled: number;
}

interface InFlight {
  controller: AbortController;
  sessionId: string;
}

function toRunErrorCode(error: unknown, signal: AbortSignal): string {
  if (error instanceof StrategyError) {
    return error.errorCode;
  }
  if (signal.aborted) {
    return "execution_cancelled";
  }
  return "execution_failed";
}

/**
 * Definitive repository rejections (bad input, missing row) are never
 * retried: only transient storage/concurrent failures merit another
 * persistence attempt. No logical RunStrategy retry is ever added here;
 * this only retries the durable lifecycle commit after the strategy
 * already returned or threw.
 */
function isRetriablePersistenceError(error: unknown): boolean {
  if (
    error instanceof RepositoryValidationError ||
    error instanceof RepositoryNotFoundError
  ) {
    return false;
  }
  return true;
}

/** Bounded attempts for one durable lifecycle commit (initial + retries). */
const LIFECYCLE_PERSIST_ATTEMPTS = 3;
/** Bounded watchdog finalization attempts (initial + retries). */
const WATCHDOG_FINALIZE_ATTEMPTS = 3;

export class RunEngine {
  private readonly db: Database.Database;
  private readonly repo: KernelRepository;
  private readonly registry: StrategyRegistry;
  private readonly maxConcurrency: number;
  private readonly pollIntervalMs: number;
  private readonly cancelGraceMs: number;
  private readonly drainMs: number;
  private readonly clock: EngineClock;
  private readonly inFlight = new Map<string, InFlight>();
  private readonly watchdogs = new Map<
    string,
    { handle: unknown; deadline: number }
  >();
  private timer: unknown;
  private started = false;
  private draining = false;
  private stopped = false;

  constructor(options: RunEngineOptions) {
    if (
      options.maxConcurrency !== undefined &&
      (!Number.isInteger(options.maxConcurrency) || options.maxConcurrency < 1)
    ) {
      throw new Error("maxConcurrency must be a positive integer");
    }
    this.db = options.db;
    this.repo = options.repo;
    this.registry = options.registry ?? new StrategyRegistry();
    this.maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.cancelGraceMs = options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
    this.drainMs = options.drainMs ?? DEFAULT_DRAIN_MS;
    this.clock = options.clock ?? systemClock;
  }

  get strategies(): StrategyRegistry {
    return this.registry;
  }

  /** Startup: recover (running->abandoned, cancel_requested->cancelled) BEFORE the scheduler starts. */
  start(): EngineRecovery {
    if (this.started) {
      throw new Error("RunEngine already started");
    }
    this.started = true;
    const recovery = this.repo.recover({ now: this.clock.now() });
    this.schedule();
    return recovery;
  }

  /** Single durable pickup pass: oldest queued first, CAS start, launch. Returns launches. Never picks up while draining/stopped. */
  pump(): number {
    if (!this.started || this.stopped || this.draining) {
      return 0;
    }
    const room = this.maxConcurrency - this.inFlight.size;
    if (room <= 0) {
      return 0;
    }
    let rows: Array<{ id: string }>;
    try {
      rows = this.db
        .prepare(
          "SELECT id FROM runs WHERE status = 'queued' ORDER BY created_at ASC, id ASC LIMIT ?",
        )
        .all(room) as Array<{ id: string }>;
    } catch {
      return 0;
    }
    let launched = 0;
    for (const row of rows) {
      if (this.draining || this.stopped) {
        break;
      }
      if (this.inFlight.has(row.id)) {
        continue;
      }
      let applied = false;
      try {
        // Benign CAS no-op (applied=false: row left queued/started elsewhere)
        // simply skips; only a throw indicates a repository/storage failure
        // and likewise skips without launching so the next pump retries.
        applied = this.repo.startRun(row.id, { now: this.clock.now() }).applied;
      } catch {
        continue;
      }
      if (!applied) {
        continue;
      }
      this.launch(row.id);
      launched += 1;
      if (this.inFlight.size >= this.maxConcurrency) {
        break;
      }
    }
    return launched;
  }

  /**
   * Cancel a run: DB commit FIRST, then signal abort, then arm the
   * normal-cancel watchdog. Queued runs settle directly to cancelled;
   * terminal runs are returned untouched (state-idempotent).
   */
  cancel(sessionId: string, runId: string): { status: string } {
    const out = this.repo.cancelRun(sessionId, runId, {
      now: this.clock.now(),
    });
    if (out.status === "cancel_requested") {
      const entry = this.inFlight.get(runId);
      if (entry !== undefined) {
        entry.controller.abort();
      }
      this.armWatchdog(runId);
    }
    return { status: out.status };
  }

  /**
   * Graceful drain (§11.5; NOT watchdog semantics): pause pickup, wait up
   * to `drainMs` for natural completion, then atomically abandon residual
   * running rows and cancel residual cancel_requested rows BEFORE
   * aborting. Queued rows are left untouched. Late/non-cooperative
   * results can never commit afterwards (CAS discards them).
   */
  async shutdown(options: { drainMs?: number } = {}): Promise<EngineRecovery> {
    if (this.stopped) {
      return { abandoned: 0, cancelled: 0 };
    }
    this.draining = true;
    if (this.timer !== undefined) {
      this.clock.clearTimeout(this.timer);
      this.timer = undefined;
    }
    const budget = options.drainMs ?? this.drainMs;
    const deadline = this.clock.now() + Math.max(budget, 0);
    while (this.inFlight.size > 0 && this.clock.now() < deadline) {
      const remaining = deadline - this.clock.now();
      if (remaining <= 0) {
        break;
      }
      await this.clock.sleep(Math.min(this.pollIntervalMs, remaining));
    }
    let swept: EngineRecovery = { abandoned: 0, cancelled: 0 };
    // Fail closed: a drain storage failure rejects WITHOUT marking
    // stopped, clearing in-flight ownership, or aborting controllers,
    // so a later shutdown retry can still sweep the retained runs.
    swept = this.repo.drain({ now: this.clock.now() });
    for (const [runId, entry] of this.inFlight) {
      this.clearWatchdog(runId);
      try {
        entry.controller.abort();
      } catch {
        // Abort must never fail shutdown.
      }
    }
    this.inFlight.clear();
    for (const runId of [...this.watchdogs.keys()]) {
      this.clearWatchdog(runId);
    }
    this.stopped = true;
    return swept;
  }

  inflightCount(): number {
    return this.inFlight.size;
  }

  inflightRunIds(): string[] {
    return [...this.inFlight.keys()];
  }

  isDraining(): boolean {
    return this.draining;
  }

  isStopped(): boolean {
    return this.stopped;
  }

  private schedule(): void {
    if (this.stopped || this.draining || !this.started) {
      return;
    }
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      try {
        this.pump();
      } catch {
        // Pickup failures never stop the scheduler; next tick retries.
      }
      this.schedule();
    }, this.pollIntervalMs);
  }

  private armWatchdog(runId: string): void {
    // Repeated cancels must not extend the deadline: the watchdog is bound
    // to the ORIGINAL cancel deadline, so an already-armed run keeps it.
    if (this.watchdogs.has(runId)) {
      return;
    }
    const deadline = this.clock.now() + Math.max(this.cancelGraceMs, 0);
    this.scheduleWatchdog(runId, deadline);
  }

  /**
   * Watchdog finalization bound to the ORIGINAL cancel deadline. A single
   * timer fires at `deadline`; transient synchronous failures are retried
   * with a bounded loop inside that same callback (repository methods are
   * synchronous) so they still settle at the original deadline. No retry
   * ever schedules a new timer or extends the deadline; persistent failure
   * simply stops retrying (retained fail-closed for recovery).
   */
  private scheduleWatchdog(runId: string, deadline: number): void {
    const delay = Math.max(deadline - this.clock.now(), 0);
    const handle = this.clock.setTimeout(() => {
      this.watchdogs.delete(runId);
      for (
        let attempt = 1;
        attempt <= WATCHDOG_FINALIZE_ATTEMPTS;
        attempt += 1
      ) {
        try {
          this.repo.finalizeCancelRequested(runId, { now: this.clock.now() });
          break;
        } catch (error) {
          // Terminal/absent rows (validation/not-found) stay as they are;
          // only transient failures merit another synchronous attempt, up
          // to the fixed budget, without scheduling beyond the deadline.
          if (
            !isRetriablePersistenceError(error) ||
            attempt === WATCHDOG_FINALIZE_ATTEMPTS
          ) {
            break;
          }
        }
      }
    }, delay);
    this.watchdogs.set(runId, { handle, deadline });
  }

  private clearWatchdog(runId: string): void {
    const entry = this.watchdogs.get(runId);
    if (entry !== undefined) {
      this.watchdogs.delete(runId);
      try {
        this.clock.clearTimeout(entry.handle);
      } catch {
        // Clearing timers must never throw.
      }
    }
  }

  /**
   * Retry one durable lifecycle commit after the strategy already
   * returned/failed. Benign CAS no-ops (applied=false) settle immediately
   * with true. Definitive rejections return true (nothing to retry).
   * Only transient storage failures are retried, up to the bounded
   * attempt budget; persistent failure returns false so the caller
   * retains in-flight ownership for a fail-closed shutdown.
   */
  private persistLifecycle(commit: () => unknown): boolean {
    let lastError: unknown;
    for (let attempt = 1; attempt <= LIFECYCLE_PERSIST_ATTEMPTS; attempt += 1) {
      try {
        commit();
        return true;
      } catch (error) {
        lastError = error;
        if (!isRetriablePersistenceError(error)) {
          return true;
        }
        if (attempt === LIFECYCLE_PERSIST_ATTEMPTS) {
          break;
        }
      }
    }
    void lastError;
    return false;
  }

  /**
   * Durably settle a running row orphaned by a post-pickup snapshot/read
   * failure. Only `running` rows transition (cancel_requested/terminal rows
   * are left for the watchdog/drain paths); transient storage failures are
   * retried within the bounded lifecycle budget.
   */
  private settlePostPickupFailure(runId: string): void {
    this.persistLifecycle(() =>
      this.repo.failRun(runId, "execution_failed", { now: this.clock.now() }),
    );
  }

  private launch(runId: string): void {
    let snapshot: { run: RunRow; turn: TurnRow } | undefined;
    try {
      const run = this.repo.getRun(runId);
      const turn = this.repo.getTurn(run.turnId);
      snapshot = { run, turn };
    } catch {
      // The pickup CAS already moved queued -> running, so a snapshot load
      // failure must durably settle the orphaned running row instead of
      // leaking it (fail-closed: recovery/drain sweep any persistent miss).
      this.settlePostPickupFailure(runId);
      return;
    }
    if (isTerminalStatus(snapshot.run.status)) {
      return;
    }
    const controller = new AbortController();
    this.inFlight.set(runId, { controller, sessionId: snapshot.run.sessionId });
    // A cancel may have committed between startRun and registration, in
    // which case cancel() found no controller to abort: close that gap.
    try {
      const fresh = this.repo.getRun(runId);
      if (fresh.status === "cancel_requested") {
        controller.abort();
        this.armWatchdog(runId);
      } else if (isTerminalStatus(fresh.status)) {
        this.inFlight.delete(runId);
        return;
      }
    } catch {
      // Re-read failure after registration: settle the running row durably
      // before releasing ownership so it is never leaked as running.
      this.settlePostPickupFailure(runId);
      this.inFlight.delete(runId);
      return;
    }
    const strategy = this.registry.resolve(snapshot.run.strategy);
    const captured = snapshot;
    const ctx = freezeStrategyContext(
      {
        id: captured.run.id,
        turnId: captured.run.turnId,
        sessionId: captured.run.sessionId,
        attempt: captured.run.attempt,
        strategy: captured.run.strategy,
      },
      {
        id: captured.turn.id,
        sessionId: captured.turn.sessionId,
        seq: captured.turn.seq,
        input: captured.turn.input,
        frozenContext: captured.turn.frozenContext,
      },
      controller.signal,
    );
    const task = (async (): Promise<void> => {
      // persistFailed=true means the durable commit never landed despite
      // bounded retries: retain in-flight ownership so shutdown can fail
      // closed via drain instead of silently dropping the run.
      let persistFailed = false;
      try {
        if (strategy === undefined) {
          persistFailed = !this.persistLifecycle(() =>
            this.repo.failRun(runId, "execution_failed", {
              now: this.clock.now(),
            }),
          );
          return;
        }
        const candidate = await strategy(ctx);
        let valid: RunResult;
        try {
          valid = parseRunResult(candidate);
        } catch {
          persistFailed = !this.persistLifecycle(() =>
            this.repo.failRun(runId, "output_invalid", {
              now: this.clock.now(),
            }),
          );
          return;
        }
        persistFailed = !this.persistLifecycle(() =>
          this.repo.completeRun(runId, valid, { now: this.clock.now() }),
        );
      } catch (error) {
        const code = toRunErrorCode(error, controller.signal);
        persistFailed = !this.persistLifecycle(() =>
          this.repo.failRun(runId, code, { now: this.clock.now() }),
        );
      } finally {
        if (!persistFailed) {
          // Cooperative fast path: settle promptly instead of waiting out
          // the full watchdog grace. The watchdog remains as the backstop
          // for non-cooperative strategies (idempotent CAS either way).
          // A persistently failing finalize likewise retains ownership.
          let finalizeFailed = false;
          try {
            const current = this.repo.getRun(runId);
            if (current.status === "cancel_requested") {
              finalizeFailed = !this.persistLifecycle(() =>
                this.repo.finalizeCancelRequested(runId, {
                  now: this.clock.now(),
                }),
              );
            }
          } catch (error) {
            if (isRetriablePersistenceError(error)) {
              finalizeFailed = true;
            }
          }
          if (!finalizeFailed) {
            this.clearWatchdog(runId);
            this.inFlight.delete(runId);
          }
        }
      }
    })();
    task.catch(() => {
      // All failure paths settle inside the task; this only guards the
      // shutdown path against unhandled rejections from late strategies.
    });
  }
}
