// AV05 notification runtime projection service (server-owned, no model).
//
// Ownership: this module is the ONLY background projector of the durable
// notification store. Sources are ALREADY-DURABLE append-only rows
// (completed shadow jobs, M5 action receipts, autonomy task events); the
// kernel `ingestNotifications` call advances key-anchored cursors and
// inserts notices in ONE atomic TX per session. This service NEVER runs
// inside the M5 receipt writer: a projection failure degrades ONLY
// notification delivery (fixed honest `notification_delivery_degraded`
// diagnostic, ordinary chat and writes keep working), it can never lose a
// Calendar receipt.
//
// Wake happens ONLY on meaningful committed state (shadow settlement,
// foreground run settlement, action approval, purpose/task writes, control
// changes, explicit shadow requests): NO interval poll, NO continuous
// model calls. Singleflight drain (same boring pattern as the shadow
// worker): a wake arriving mid-drain re-runs once afterwards, never a
// duplicate busy loop.
//
// Deadline alerts use EXACTLY ONE timer for the earliest numeric due
// (clamped to the max Node interval): STOP holds deadlines/routines (the
// kernel reports `control_paused` with zero recordings; URGENT
// unknown/succeeded_unverified receipt notices still project while
// paused), offline-time deadlines never catch up (kernel resume cutoff),
// and a control/version change clears + reschedules the timer.
//
// Session enumeration reads the trusted `sessions` keyset directly (ALL
// rows, never a 100-cutoff collection): every owned session is ingested on
// every drain.

import type { KernelRepository } from "@companion/kernel";
import type { ServerLogger } from "./logger.js";

/** Fixed honest diagnostic: projection degraded, everything else works. */
export const NOTIFICATION_DIAGNOSTIC_CODE =
  "notification_delivery_degraded" as const;

/**
 * Single re-arm floor (ms) when the earliest deadline is already due but a
 * recording pass just ran: prevents a duplicate busy loop without losing
 * the alert (the next wake re-reads the CURRENT schedule + version).
 */
export const NOTIFICATION_REARM_FLOOR_MS = 1000;

/** Max Node setTimeout delay (2^31 - 1): longer dues clamp, never throw. */
export const NOTIFICATION_TIMER_MAX_MS = 2_147_483_647;

/**
 * Bounded sweeps per drain tick. One ingest pass consumes bounded source
 * batches (50 shadow/receipt rows, 100 task events), so a continuous
 * backlog (e.g. a 100-row source-ingest batch where cursors advance ~5
 * source events per job) needs several passes. The tick re-sweeps while
 * cursors advance, bounded — the backlog converges WITHOUT waiting for
 * another unrelated wake, and a stuck fault never spins (a cursor-reset
 * refusal or storage failure advances nothing, so the tick ends and the
 * fixed degraded diagnostic stays up until the next real wake).
 */
export const NOTIFICATION_MAX_SWEEPS = 25;

/**
 * Bounded chained re-drains when wakes land mid-tick (singleflight: a
 * wake arriving during a tick re-runs once afterwards, never a duplicate
 * busy loop). The bound covers burst settlement; a still-queued wake past
 * the bound gets exactly ONE setImmediate re-arm (never an infinite
 * poll — the re-arm runs only when a real wake was queued).
 */
export const NOTIFICATION_MAX_CHAINED_DRAINS = 10;

/** Minimal raw-DB surface the service needs (session keyset only). */
export interface NotificationDb {
  prepare(sql: string): {
    all(...args: unknown[]): unknown[];
  };
}

export interface NotificationServiceOptions {
  readonly db: NotificationDb;
  readonly repo: KernelRepository;
  readonly logger?: ServerLogger;
  readonly now?: () => number;
}

export interface NotificationService {
  /** Start the projector: initial ingest + deadline rebuild, then armed. */
  start(): void;
  /** Stop: clear the deadline timer and await the in-flight drain. */
  stop(): Promise<void>;
  /** Wake on meaningful committed state (never throws into the caller). */
  wake(): void;
  /** Control/version change: clear the timer, re-read live state, re-wake. */
  notifyControl(): void;
  /** Shadow settlement (terminal job): re-drive the projection. */
  onShadowSettled(): void;
  /** Foreground run settlement (any terminal outcome): re-drive. */
  onRunSettled(): void;
  /** Fixed honest diagnostic when projection degraded, else null. */
  getDiagnostic(): typeof NOTIFICATION_DIAGNOSTIC_CODE | null;
  /** True while a drain tick is in flight (tests/smoke). */
  readonly busy: boolean;
}

/**
 * Server-owned repo wrapper: wakes the notification projector AFTER a
 * COMMITTED source change, never per-GET. Every hook is throw-guarded: a
 * wake failure can never unwind a committed user command. Composes
 * OUTSIDE the memory/shadow wrappers so every mutation path is observed;
 * the gated post-recovery rebuild must re-apply this wrapper (same rule
 * as the memory intake + shadow priority wrappers).
 */
export function wrapRepoWithNotifications(
  inner: KernelRepository,
  service: NotificationService,
): KernelRepository {
  const wake = (): void => {
    try {
      service.wake();
    } catch {
      // Best effort: the mutation already committed.
    }
  };
  const control = (): void => {
    try {
      service.notifyControl();
    } catch {
      // Best effort: the control change already committed.
    }
    wake();
  };
  // Post-commit hooks only: each calls through first, then wakes on
  // success. A throw from the kernel propagates untouched (no masking).
  const after =
    <Args extends unknown[]>(
      fn: (...args: Args) => unknown,
      hook: () => void,
    ): ((...args: Args) => unknown) =>
    (...args: Args): unknown => {
      const out = (fn as (...args: Args) => unknown)(...args);
      hook();
      return out;
    };
  return {
    ...inner,
    postMessage: ((...args: Parameters<KernelRepository["postMessage"]>) =>
      after(
        inner.postMessage.bind(inner),
        wake,
      )(...args)) as KernelRepository["postMessage"],
    postRetry: ((...args: Parameters<KernelRepository["postRetry"]>) =>
      after(
        inner.postRetry.bind(inner),
        wake,
      )(...args)) as KernelRepository["postRetry"],
    cancelRun: ((...args: Parameters<KernelRepository["cancelRun"]>) =>
      after(
        inner.cancelRun.bind(inner),
        wake,
      )(...args)) as KernelRepository["cancelRun"],
    completeRun: ((...args: Parameters<KernelRepository["completeRun"]>) =>
      after(
        inner.completeRun.bind(inner),
        wake,
      )(...args)) as KernelRepository["completeRun"],
    failRun: ((...args: Parameters<KernelRepository["failRun"]>) =>
      after(
        inner.failRun.bind(inner),
        wake,
      )(...args)) as KernelRepository["failRun"],
    finalizeCancelRequested: ((
      ...args: Parameters<KernelRepository["finalizeCancelRequested"]>
    ) =>
      after(
        inner.finalizeCancelRequested.bind(inner),
        wake,
      )(...args)) as KernelRepository["finalizeCancelRequested"],
    approveProposal: ((
      ...args: Parameters<KernelRepository["approveProposal"]>
    ) =>
      after(
        inner.approveProposal.bind(inner),
        wake,
      )(...args)) as KernelRepository["approveProposal"],
    createAutonomyPurpose: ((
      ...args: Parameters<KernelRepository["createAutonomyPurpose"]>
    ) =>
      after(
        inner.createAutonomyPurpose.bind(inner),
        wake,
      )(...args)) as KernelRepository["createAutonomyPurpose"],
    correctAutonomyPurpose: ((
      ...args: Parameters<KernelRepository["correctAutonomyPurpose"]>
    ) =>
      after(
        inner.correctAutonomyPurpose.bind(inner),
        wake,
      )(...args)) as KernelRepository["correctAutonomyPurpose"],
    revokeAutonomyPurpose: ((
      ...args: Parameters<KernelRepository["revokeAutonomyPurpose"]>
    ) =>
      after(
        inner.revokeAutonomyPurpose.bind(inner),
        wake,
      )(...args)) as KernelRepository["revokeAutonomyPurpose"],
    achieveAutonomyPurpose: ((
      ...args: Parameters<KernelRepository["achieveAutonomyPurpose"]>
    ) =>
      after(
        inner.achieveAutonomyPurpose.bind(inner),
        wake,
      )(...args)) as KernelRepository["achieveAutonomyPurpose"],
    recordAutonomyPurposeConflict: ((
      ...args: Parameters<KernelRepository["recordAutonomyPurposeConflict"]>
    ) =>
      after(
        inner.recordAutonomyPurposeConflict.bind(inner),
        wake,
      )(...args)) as KernelRepository["recordAutonomyPurposeConflict"],
    createAutonomyTask: ((
      ...args: Parameters<KernelRepository["createAutonomyTask"]>
    ) =>
      after(
        inner.createAutonomyTask.bind(inner),
        wake,
      )(...args)) as KernelRepository["createAutonomyTask"],
    startAutonomyTask: ((
      ...args: Parameters<KernelRepository["startAutonomyTask"]>
    ) =>
      after(
        inner.startAutonomyTask.bind(inner),
        wake,
      )(...args)) as KernelRepository["startAutonomyTask"],
    holdAutonomyTask: ((
      ...args: Parameters<KernelRepository["holdAutonomyTask"]>
    ) =>
      after(
        inner.holdAutonomyTask.bind(inner),
        wake,
      )(...args)) as KernelRepository["holdAutonomyTask"],
    resumeAutonomyTask: ((
      ...args: Parameters<KernelRepository["resumeAutonomyTask"]>
    ) =>
      after(
        inner.resumeAutonomyTask.bind(inner),
        wake,
      )(...args)) as KernelRepository["resumeAutonomyTask"],
    completeAutonomyTask: ((
      ...args: Parameters<KernelRepository["completeAutonomyTask"]>
    ) =>
      after(
        inner.completeAutonomyTask.bind(inner),
        wake,
      )(...args)) as KernelRepository["completeAutonomyTask"],
    cancelAutonomyTask: ((
      ...args: Parameters<KernelRepository["cancelAutonomyTask"]>
    ) =>
      after(
        inner.cancelAutonomyTask.bind(inner),
        wake,
      )(...args)) as KernelRepository["cancelAutonomyTask"],
    setAutonomyControlState: ((
      ...args: Parameters<KernelRepository["setAutonomyControlState"]>
    ) =>
      after(
        inner.setAutonomyControlState.bind(inner),
        control,
      )(...args)) as KernelRepository["setAutonomyControlState"],
    requestShadowDeliberation: ((
      ...args: Parameters<KernelRepository["requestShadowDeliberation"]>
    ) =>
      after(
        inner.requestShadowDeliberation.bind(inner),
        wake,
      )(...args)) as KernelRepository["requestShadowDeliberation"],
    completeShadowJob: ((
      ...args: Parameters<KernelRepository["completeShadowJob"]>
    ) =>
      after(
        inner.completeShadowJob.bind(inner),
        wake,
      )(...args)) as KernelRepository["completeShadowJob"],
    holdShadowJob: ((...args: Parameters<KernelRepository["holdShadowJob"]>) =>
      after(
        inner.holdShadowJob.bind(inner),
        wake,
      )(...args)) as KernelRepository["holdShadowJob"],
    failShadowJob: ((...args: Parameters<KernelRepository["failShadowJob"]>) =>
      after(
        inner.failShadowJob.bind(inner),
        wake,
      )(...args)) as KernelRepository["failShadowJob"],
  };
}

export function createNotificationService(
  options: NotificationServiceOptions,
): NotificationService {
  const { db, repo } = options;
  const logger = options.logger;
  const now = options.now ?? Date.now;

  let started = false;
  let stopping = false;
  /** Single in-flight drain (singleflight: concurrent wakes share it). */
  let inFlight: Promise<void> | null = null;
  let wakeQueued = false;
  /** True until the startup rebuild lands cleanly on every session. */
  let scheduleBuilt = false;
  /** Earliest due the single timer is armed for (null = no timer). */
  let timer: ReturnType<typeof setTimeout> | undefined;
  let degraded = false;

  const log = (
    level: "info" | "warn",
    code: string,
    fields?: { status?: number | string },
  ): void => {
    try {
      logger?.[level](code, fields);
    } catch {
      // Logging never breaks the projection.
    }
  };

  const markDegraded = (): void => {
    if (!degraded) {
      degraded = true;
      log("warn", "notifications.degraded", {
        status: NOTIFICATION_DIAGNOSTIC_CODE,
      });
    }
  };

  const clearTimer = (): void => {
    if (timer !== undefined) {
      try {
        clearTimeout(timer);
      } catch {
        // Best effort.
      }
      timer = undefined;
    }
  };

  /** Trusted session keyset: ALL sessions, never a 100-cutoff collect. */
  function listSessionIds(): string[] {
    const rows = db
      .prepare("SELECT id FROM sessions ORDER BY created_at ASC, id ASC")
      .all() as Array<{ id?: unknown }>;
    const ids: string[] = [];
    for (const row of rows) {
      if (typeof row.id === "string" && row.id.length > 0) {
        ids.push(row.id);
      }
    }
    return ids;
  }

  /**
   * One bounded drain tick: sweep every session until cursors stop
   * advancing (bounded passes, single tick). Receipt URGENT still fires
   * while paused: ingest never consults the control fence. The derived
   * deadline schedule rebuilds once at startup; due deadlines record
   * under the CURRENT control version (paused/stale callers honestly
   * record zero), then EXACTLY ONE timer arms for the earliest numeric
   * due. Projection failures degrade ONLY delivery (fixed diagnostic,
   * next wake retries): ordinary chat and writes already committed are
   * untouched, and a cursor-reset refusal never auto-resets or drops
   * notices.
   */
  async function drainLoop(): Promise<void> {
    const at = now();
    let sessions: string[];
    try {
      sessions = listSessionIds();
    } catch {
      markDegraded();
      return;
    }
    let clean = true;
    for (let sweep = 0; sweep < NOTIFICATION_MAX_SWEEPS; sweep += 1) {
      if (!started || stopping) {
        return;
      }
      const before = readCursorFrontier();
      let advanced = false;
      for (const sessionId of sessions) {
        if (!started || stopping) {
          return;
        }
        try {
          const out = repo.ingestNotifications(sessionId, { now: at });
          if (out.ingested > 0) {
            advanced = true;
          }
        } catch {
          // Honest degradation only: cursor-reset refusals and storage
          // failures never auto-reset, never drop notices, never break
          // the committed sources. Next wake retries.
          clean = false;
          markDegraded();
        }
      }
      if (!scheduleBuilt) {
        let built = true;
        for (const sessionId of sessions) {
          if (!started || stopping) {
            return;
          }
          try {
            repo.buildDeadlineSchedule(sessionId, { now: at });
          } catch {
            built = false;
            clean = false;
            markDegraded();
          }
        }
        if (built) {
          scheduleBuilt = true;
        }
      }
      // Record due deadlines under the CURRENT control version (single
      // read: every session shares the global control epoch). Paused
      // records zero honestly; a version race records zero as stale.
      let controlVersion = 1;
      try {
        controlVersion = repo.getAutonomyControlState().version;
      } catch {
        clean = false;
        markDegraded();
      }
      for (const sessionId of sessions) {
        if (!started || stopping) {
          return;
        }
        try {
          const recorded = repo.recordDueDeadlines(sessionId, {
            expectedControlVersion: controlVersion,
            now: at,
          });
          if (recorded.recorded > 0) {
            advanced = true;
          }
        } catch {
          clean = false;
          markDegraded();
        }
      }
      if (!advanced && !cursorAdvancedSince(before)) {
        // Nothing inserted and no cursor moved: every source batch is
        // consumed (or honestly faulted, which also advances nothing).
        // End the tick here — never spin on a persistent refusal.
        break;
      }
      // Otherwise a backlog remains (inserts landed, or skipped rows
      // were consumed and advanced the frontier): sweep again, still
      // inside this same tick and bound.
    }
    if (clean) {
      degraded = false;
    }
    rescheduleTimer(sessions);
  }

  /**
   * Snapshot the durable cursor frontier (session + source -> rowid).
   * Null on read failure: the sweep then counts as no-progress (the tick
   * ends, the degraded diagnostic stays up, the next wake retries).
   */
  function readCursorFrontier(): Map<string, number> | null {
    try {
      const rows = db
        .prepare(
          "SELECT session_id, source, last_source_rowid FROM notification_cursors",
        )
        .all() as Array<{
        session_id?: unknown;
        source?: unknown;
        last_source_rowid?: unknown;
      }>;
      const out = new Map<string, number>();
      for (const row of rows) {
        if (
          typeof row.session_id === "string" &&
          typeof row.source === "string" &&
          typeof row.last_source_rowid === "number"
        ) {
          out.set(`${row.session_id}|${row.source}`, row.last_source_rowid);
        }
      }
      return out;
    } catch {
      return null;
    }
  }

  /** True when any cursor frontier rowid grew since the snapshot. */
  function cursorAdvancedSince(before: Map<string, number> | null): boolean {
    if (before === null) {
      return false;
    }
    const after = readCursorFrontier();
    if (after === null) {
      return false;
    }
    for (const [key, rowid] of after) {
      const prev = before.get(key);
      if (prev !== undefined && rowid > prev) {
        return true;
      }
    }
    return false;
  }

  /**
   * Arm EXACTLY ONE timer for the earliest numeric due across sessions.
   * Paused control or no future deadline: no timer (STOP holds
   * deadlines/routines; the next meaningful wake re-arms).
   */
  function rescheduleTimer(sessions: string[]): void {
    clearTimer();
    if (!started || stopping) {
      return;
    }
    let earliest: number | null = null;
    for (const sessionId of sessions) {
      let next: ReturnType<KernelRepository["getNextDeadline"]>;
      try {
        next = repo.getNextDeadline(sessionId);
      } catch {
        markDegraded();
        continue;
      }
      if (next.paused || next.deadline === null) {
        continue;
      }
      if (earliest === null || next.deadline.dueAt < earliest) {
        earliest = next.deadline.dueAt;
      }
    }
    if (earliest === null) {
      return;
    }
    let delay = earliest - now();
    if (delay <= 0) {
      // The recording pass above just ran: re-arm on the floor instead
      // of spinning (the next wake re-reads CURRENT schedule + version).
      delay = NOTIFICATION_REARM_FLOOR_MS;
    }
    if (delay > NOTIFICATION_TIMER_MAX_MS) {
      delay = NOTIFICATION_TIMER_MAX_MS;
    }
    timer = setTimeout(() => {
      timer = undefined;
      wake();
    }, delay);
  }

  /**
   * Event-driven pump: run one converging tick (multi-sweep while cursors
   * advance, bounded). Chained re-runs are driven from the settle
   * callback below — never from inside the tick — because a burst of
   * synchronous committed writes (session + purpose + control + job, all
   * before the first microtask) queues its wakes while the first tick is
   * still settling: consuming the flag inside the tick would observe it
   * too early and drop the burst. A still-queued wake past the bound gets
   * exactly ONE setImmediate re-arm — never an infinite poll, never a
   * dropped delivery.
   */
  async function pump(): Promise<void> {
    try {
      await drainLoop();
    } catch {
      // Best effort: drainLoop never throws (every repo/DB call is
      // guarded), but a tick must never wedge the singleflight gate.
      markDegraded();
    }
  }

  function startPump(depth: number): void {
    inFlight = pump().then(
      () => {
        inFlight = null;
        followUp(depth);
      },
      () => {
        inFlight = null;
        followUp(depth);
      },
    );
  }

  /** Consume a wake queued mid-tick (bounded chain, then one re-arm). */
  function followUp(depth: number): void {
    try {
      if (!wakeQueued || !started || stopping) {
        wakeQueued = false;
        return;
      }
      if (depth + 1 >= NOTIFICATION_MAX_CHAINED_DRAINS) {
        wakeQueued = false;
        setImmediate(() => {
          wake();
        });
        return;
      }
      wakeQueued = false;
      startPump(depth + 1);
    } catch {
      // Best effort: a follow-up failure never wedges the gate.
      wakeQueued = false;
    }
  }

  function wake(): void {
    try {
      if (!started || stopping) {
        return;
      }
      if (inFlight !== null) {
        wakeQueued = true;
        return;
      }
      startPump(0);
    } catch {
      // Best effort: wake never throws into a committed command.
    }
  }

  function notifyControl(): void {
    try {
      // Control/version change clears the single timer synchronously;
      // the wake below re-reads the CURRENT control + schedule.
      clearTimer();
    } catch {
      // Best effort.
    }
  }

  function onShadowSettled(): void {
    wake();
  }

  function onRunSettled(): void {
    wake();
  }

  function start(): void {
    started = true;
    // Startup ingest from the migration-14 baselines + derived deadline
    // rebuild (first drain): no old-deadline catchup (kernel resume
    // cutoff), no mass-notify of history (anchored cursors).
    wake();
  }

  async function stop(): Promise<void> {
    stopping = true;
    clearTimer();
    const flight = inFlight;
    if (flight !== null) {
      try {
        await flight;
      } catch {
        // Best effort: shutdown still proceeds.
      }
    }
  }

  return {
    start,
    stop,
    wake,
    notifyControl,
    onShadowSettled,
    onRunSettled,
    getDiagnostic: () => (degraded ? NOTIFICATION_DIAGNOSTIC_CODE : null),
    get busy() {
      return inFlight !== null;
    },
  };
}
