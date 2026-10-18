// AV07 external supervisor: opt-in FOREGROUND process manager for the
// Companion server subprocess. NOT a daemon, NOT systemd, NOT OS boot
// activation: it runs in the operator's own foreground shell and dies with
// it. OS service activation requires an actual host-operator grant and is
// NEVER claimed by this module (see `service-print` in supervisor_cli.ts,
// which only prints a sample unit and never installs anything).
//
// Rules (root plan §7.8):
// - Spawns ONLY the fixed own server entry (`src/index.ts`) via the current
//   Node binary + cached tsx loader, `shell: false`, no arbitrary command,
//   no model/untrusted argv or env injection. The child inherits the
//   EXISTING configured environment (same DB/model settings, no new
//   provider, no new budget).
// - Genuine readiness comes ONLY from the child's own IPC `companion-ready`
//   AFTER listen. A port collision degrades to bounded retry, never to
//   killing any listener: the parent touches ONLY its own spawned child.
// - Persistent sidecar state lives under the configured DB data dir
//   (`<data>/supervisor/`, private 0600, atomic tmp+fsync+rename, symlink
//   guards). It holds NO conversation/model/credential content: fixed
//   reason vocabulary + timestamps + counters + nonce only.
// - Explicit operator stop (SIGINT/SIGTERM/CLI stop/stdin `stop`) persists
//   STOP BEFORE child termination; a later normal start observes the stop
//   and does NOT spawn until an explicit CLI/stdin `resume` (human operator
//   only). If the stop write itself fails (e.g. disk full), NOTHING shuts
//   down: RAM is untouched, the child is held alive, the lock is kept, and
//   a fixed diagnostic is reported. A crash NEVER creates an operator stop.
// - Crash restarts use the EXISTING MCP reconnect schedule
//   (`nextBackoffMs`: 1s/2s/5s/10s/30s, capped at 30s) for at most
//   MAX_CRASH_RESTARTS consecutive crashes, then hold with a fixed
//   diagnostic (no storm). Ready does NOT reset the consecutive budget:
//   only a genuine operator resume does (liveness alone is not health).
// - Supervisor resume NEVER resumes autonomy: the server's own restart fence
//   re-pauses background intent on every start; autonomy resume stays an
//   explicit control-plane action.
// - Single-instance ownership via an exclusive lock file whose entire
//   inspect-decide-reclaim sequence runs INSIDE an OS-backed SQLite mutex
//   (EXISTING better-sqlite3, `BEGIN IMMEDIATE`, no new deps): two starters
//   racing on a stale dead-PID lock serialize, so at most one owner exists.
//   A stale lock whose PID is dead is reclaimed; an ambiguous lock
//   (unparseable, EPERM, live PID, mutex contention) fails closed and NEVER
//   kills the old PID.
// - EVERY state read-modify-write (operator stop/resume/restart, ready,
//   crash budget, drain hold) commits INSIDE that same OS-backed mutex on
//   the LATEST state: concurrent writers serialize and a newer operator
//   stop/hold is never overwritten by stale bookkeeping. Ready never clears
//   STOP; crash accounting never clears STOP/hold; a failed commit HOLDS
//   instead of retrying blind.
// - Planned restart is an EXPLICIT operator request only (foreground stdin
//   `restart` or CLI `restart` while running, observed via the state file).
//   The child shuts down through the EXISTING graceful `shutdown()` path
//   (drain + persist, bounded by SHUTDOWN_DRAIN_MS); respawn REQUIRES the
//   affirmative `companion-drained` ack (an exit, even 0, is NOT enough).
//   On drain failure, timeout, lost child, or missing ack the supervisor
//   enters a persistent `drain_failed` hold (cleared ONLY by explicit
//   operator resume/reset), keeps a live failed child ALIVE in DRAINING
//   (never force-killed, never auto-retried), and never respawns past the
//   safe boundary. Unknown-commit rows are durable and allow
//   restart but are NEVER retried (engine recovery rule, unchanged).

import {
  chmodSync,
  lstatSync,
  mkdirSync,
  closeSync as nodeCloseSync,
  fsyncSync as nodeFsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { nextBackoffMs } from "@companion/connector-mcp";
import Database from "better-sqlite3";

/** Sidecar state schema version (bump = previous state unreadable, hold). */
export const SUPERVISOR_STATE_VERSION = 1;

/** Consecutive-crash budget: schedule [1s,2s,5s,10s,30s,30s] then hold. */
export const MAX_CRASH_RESTARTS = 6;

/** Fixed reason vocabulary for state + diagnostics (never free text). */
export type SupervisorReason =
  | "none"
  | "operator_stop"
  | "operator_resume"
  | "crash"
  | "startup_failed"
  | "address_in_use"
  | "newer_database"
  | "drain_failed"
  | "planned_restart"
  | "exhausted";

const REASONS: ReadonlySet<string> = new Set([
  "none",
  "operator_stop",
  "operator_resume",
  "crash",
  "startup_failed",
  "address_in_use",
  "newer_database",
  "drain_failed",
  "planned_restart",
  "exhausted",
]);

export interface SupervisorState {
  readonly version: 1;
  /** True while an explicit operator stop is in effect (no spawn). */
  readonly operatorStop: boolean;
  /** True while an explicit operator planned-restart is pending. */
  readonly plannedRestart: boolean;
  /** Consecutive crash count (resets ONLY on genuine operator resume). */
  readonly crashCount: number;
  readonly lastReason: SupervisorReason;
  readonly updatedAt: number;
  /** Opaque owner nonce (no conversation/model/credential content). */
  readonly nonce: string;
}

export interface SupervisorPaths {
  readonly dir: string;
  readonly stateFile: string;
  readonly lockFile: string;
  /** OS-backed mutex DB serializing every state read-modify-write. */
  readonly mutexDb: string;
}

export function supervisorPathsForDb(dbPath: string): SupervisorPaths {
  const dir = join(dirname(dbPath), "supervisor");
  return {
    dir,
    stateFile: join(dir, "supervisor-state.json"),
    lockFile: join(dir, "supervisor.lock"),
    mutexDb: join(dir, "supervisor-mutex.sqlite"),
  };
}

export function initialSupervisorState(
  now: number,
  nonce: string,
): SupervisorState {
  return {
    version: 1,
    operatorStop: false,
    plannedRestart: false,
    crashCount: 0,
    lastReason: "none",
    updatedAt: now,
    nonce,
  };
}

function isReason(value: unknown): value is SupervisorReason {
  return typeof value === "string" && REASONS.has(value);
}

export function parseSupervisorState(raw: string): SupervisorState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("supervisor state unreadable");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("supervisor state unreadable");
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.version !== SUPERVISOR_STATE_VERSION ||
    typeof record.operatorStop !== "boolean" ||
    typeof record.plannedRestart !== "boolean" ||
    typeof record.crashCount !== "number" ||
    !Number.isInteger(record.crashCount) ||
    (record.crashCount as number) < 0 ||
    (record.crashCount as number) > MAX_CRASH_RESTARTS + 1 ||
    !isReason(record.lastReason) ||
    typeof record.updatedAt !== "number" ||
    !Number.isInteger(record.updatedAt) ||
    typeof record.nonce !== "string" ||
    (record.nonce as string).length === 0 ||
    (record.nonce as string).length > 128
  ) {
    throw new Error("supervisor state unreadable");
  }
  return {
    version: 1,
    operatorStop: record.operatorStop,
    plannedRestart: record.plannedRestart,
    crashCount: record.crashCount,
    lastReason: record.lastReason,
    updatedAt: record.updatedAt,
    nonce: record.nonce,
  };
}

/** Crash backoff for the Nth consecutive failure (existing MCP schedule). */
export function crashBackoffMs(failures: number): number {
  return nextBackoffMs(failures);
}

export type SpawnDecision =
  | "spawn"
  | "held_operator_stop"
  | "held_exhausted"
  | "held_newer_database"
  | "held_drain_failed";

/**
 * Pure spawn gate: stop, drain-failure hold, exhaustion, unbootable-schema
 * holds. A `drain_failed` hold is persistent: only an explicit operator
 * resume/reset clears it (applyOperatorResume). It is never cleared by
 * ready/crash accounting.
 */
export function describeSpawnDecision(state: SupervisorState): SpawnDecision {
  if (state.operatorStop) return "held_operator_stop";
  if (state.lastReason === "newer_database") return "held_newer_database";
  if (state.lastReason === "drain_failed") return "held_drain_failed";
  if (state.crashCount >= MAX_CRASH_RESTARTS) return "held_exhausted";
  return "spawn";
}

/**
 * Pure crash accounting: a crash NEVER sets operatorStop and NEVER clears
 * an existing operator stop, drain-failure hold, or unbootable-schema hold.
 * External operator state always wins over crash bookkeeping.
 */
export function applyCrash(
  state: SupervisorState,
  now: number,
  reason: SupervisorReason,
): SupervisorState {
  if (state.lastReason === "drain_failed") {
    return { ...state, updatedAt: now };
  }
  if (state.lastReason === "newer_database") {
    return { ...state, updatedAt: now };
  }
  const crashCount = state.crashCount + 1;
  const lastReason: SupervisorReason =
    crashCount >= MAX_CRASH_RESTARTS ? "exhausted" : reason;
  return {
    ...state,
    crashCount,
    lastReason,
    updatedAt: now,
  };
}

/**
 * Pure ready accounting: consumes a pending planned restart; budget kept.
 * NEVER clears an operator stop or a drain-failure hold: when applied to the
 * LATEST state (see markReadyTransform), an external stop observed during
 * startup survives readiness.
 */
export function applyReady(
  state: SupervisorState,
  now: number,
): SupervisorState {
  if (state.lastReason === "drain_failed") {
    return { ...state, updatedAt: now };
  }
  return { ...state, plannedRestart: false, updatedAt: now };
}

/**
 * Transform for use INSIDE the mutex on the latest state: ready consumes a
 * pending planned restart but preserves a concurrently-written operator
 * stop, hold, or command epoch. Passing a stale pre-spawn snapshot here is
 * a bug; callers must read-latest-inside-mutex (see
 * updateSupervisorStateAtomically / markSupervisorReadyAtomically).
 */
export function markReadyTransform(
  latest: SupervisorState,
  now: number,
): SupervisorState {
  return applyReady(latest, now);
}

/** Persistent drain-failure hold: keeps operatorStop/crashCount, clears the
 * pending restart flag (it was attempted and failed), records the fixed
 * `drain_failed` reason. Cleared ONLY by explicit operator resume/reset. */
export function applyDrainFailedHold(
  state: SupervisorState,
  now: number,
): SupervisorState {
  return {
    ...state,
    plannedRestart: false,
    lastReason: "drain_failed",
    updatedAt: now,
  };
}

export interface PlannedRestartOutcomeInput {
  readonly drained: boolean;
  readonly drainFailed: boolean;
  readonly childGone: boolean;
  readonly timedOut: boolean;
  readonly disconnected: boolean;
}

/**
 * Planned-restart gate: respawn ONLY on affirmative `companion-drained`.
 * An exit (even code 0), a timeout, a lost child, an unexpected disconnect,
 * or a missing ack all mean HOLD with a fixed diagnostic — never an
 * unconditional terminate+respawn past the safe boundary.
 */
export function describePlannedRestartOutcome(
  input: PlannedRestartOutcomeInput,
): "respawn" | "hold" {
  if (input.drained && !input.drainFailed) return "respawn";
  return "hold";
}

/** Pure operator stop: persists BEFORE any child termination (caller order). */
export function applyOperatorStop(
  state: SupervisorState,
  now: number,
): SupervisorState {
  return {
    ...state,
    operatorStop: true,
    plannedRestart: false,
    updatedAt: now,
    lastReason: "operator_stop",
  };
}

/**
 * Pure operator resume: the ONLY path that clears operatorStop and resets
 * the consecutive crash budget. This NEVER resumes autonomy itself: the
 * server restart fence re-pauses background intent on every start.
 */
export function applyOperatorResume(
  state: SupervisorState,
  now: number,
): SupervisorState {
  return {
    ...state,
    operatorStop: false,
    plannedRestart: false,
    crashCount: 0,
    lastReason: "operator_resume",
    updatedAt: now,
  };
}

/** Pure planned-restart request (explicit operator only). Never clears a
 * persistent `drain_failed` hold: a restart requested while held preserves
 * the hold (only an explicit operator resume/reset clears it). */
export function applyPlannedRestartRequest(
  state: SupervisorState,
  now: number,
): SupervisorState {
  if (state.lastReason === "drain_failed") {
    return { ...state, updatedAt: now };
  }
  return {
    ...state,
    plannedRestart: true,
    lastReason: "planned_restart",
    updatedAt: now,
  };
}

/** Fail-closed symlink guard for the sidecar dir (existing config pattern). */
export function assertSupervisorPathHasNoSymlink(resolvedPath: string): void {
  try {
    const self = lstatSync(resolvedPath);
    if (self.isSymbolicLink()) {
      throw new Error("supervisor path must not be a symlink");
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "supervisor path must not be a symlink"
    ) {
      throw error;
    }
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      (error as { code?: string }).code !== "ENOENT"
    ) {
      throw new Error("supervisor path is not accessible");
    }
  }
  let dir = dirname(resolvedPath);
  for (;;) {
    try {
      const stat = lstatSync(dir);
      if (stat.isSymbolicLink()) {
        throw new Error("supervisor path must not pass through a symlink");
      }
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === "supervisor path must not pass through a symlink" ||
          error.message === "supervisor path is not accessible")
      ) {
        throw error;
      }
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: string }).code === "ENOENT"
      ) {
        // Missing parent is fine (created at startup); keep walking up.
      } else {
        throw new Error("supervisor parent path is not accessible");
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

export function ensureSupervisorDir(paths: SupervisorPaths): void {
  assertSupervisorPathHasNoSymlink(paths.stateFile);
  mkdirSync(paths.dir, { recursive: true });
  if (process.platform !== "win32") {
    try {
      chmodSync(paths.dir, 0o700);
    } catch {
      throw new Error("supervisor directory permissions failed");
    }
  }
  assertSupervisorPathHasNoSymlink(paths.stateFile);
}

/** Atomic private write: tmp + 0600 + fsync + rename. */
export function writeSupervisorState(
  paths: SupervisorPaths,
  state: SupervisorState,
): void {
  ensureSupervisorDir(paths);
  const tmp = `${paths.stateFile}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), { encoding: "utf-8" });
  if (process.platform !== "win32") {
    try {
      chmodSync(tmp, 0o600);
    } catch {
      // Best effort on chmod; rename still atomic.
    }
  }
  syncFile(tmp);
  renameSync(tmp, paths.stateFile);
  if (process.platform !== "win32") {
    syncDir(dirname(paths.stateFile));
  }
  if (process.platform !== "win32") {
    try {
      chmodSync(paths.stateFile, 0o600);
    } catch {
      // Best effort: the tmp write was already private.
    }
  }
}

// Lazy dynamic import avoided in sync code: use createRequire-free sync fs.

function syncFile(path: string): void {
  // Durability hint: sync failures must propagate (never report durable).
  // Open read-write: on Windows, fsync on a read-only handle throws EPERM,
  // while a writable handle syncs correctly.
  let fd = -1;
  try {
    fd = openSync(path, "r+");
    nodeFsyncSync(fd);
  } finally {
    if (fd >= 0) {
      try {
        nodeCloseSync(fd);
      } catch {
        // Best effort.
      }
    }
  }
}

function syncDir(path: string): void {
  // Directory fsync is unsupported on Windows; skip only there.
  // On POSIX failures propagate (never report durable).
  if (process.platform === "win32") {
    return;
  }
  let fd = -1;
  try {
    fd = openSync(path, "r");
    nodeFsyncSync(fd);
  } finally {
    if (fd >= 0) {
      try {
        nodeCloseSync(fd);
      } catch {
        // Best effort.
      }
    }
  }
}

export function readSupervisorState(
  paths: SupervisorPaths,
  now: number,
  nonce: string,
): SupervisorState {
  try {
    const raw = readFileSync(paths.stateFile, "utf-8");
    return parseSupervisorState(raw);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
    ) {
      return initialSupervisorState(now, nonce);
    }
    throw new Error("supervisor state unreadable");
  }
}

/**
 * OS-backed exclusive mutex for every supervisor state read-modify-write
 * and for lock-file reclamation, using the EXISTING better-sqlite3
 * dependency (no new deps). `BEGIN IMMEDIATE` takes a RESERVED filesystem
 * lock held until COMMIT/ROLLBACK, so concurrent supervisor/CLI processes
 * serialize: the second blocks (bounded busy timeout) then observes the
 * LATEST state instead of clobbering it. A holder that dies releases the
 * lock via the OS; a busy timeout fails closed.
 */
function isSqliteBusy(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as { code?: unknown; message?: unknown };
  if (record.code === "SQLITE_BUSY") return true;
  return (
    typeof record.message === "string" &&
    record.message.includes("database is locked")
  );
}

function sleepSyncMs(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const start = Date.now();
    while (Date.now() - start < ms) {
      // Best effort synchronous backoff.
    }
  }
}

export function withSupervisorMutex<T>(paths: SupervisorPaths, fn: () => T): T {
  ensureSupervisorDir(paths);
  assertSupervisorPathHasNoSymlink(paths.mutexDb);
  // Bounded contention retries: concurrent starters/CLI writers serialize
  // on BEGIN IMMEDIATE. A raw SQLITE_BUSY from setup (fresh-DB creation
  // races, WAL mode negotiation) is retried here so callers only ever see
  // the fixed fail-closed vocabulary, never "database is locked".
  const deadline = Date.now() + 8000;
  for (;;) {
    const db = new Database(paths.mutexDb);
    try {
      db.pragma("journal_mode = WAL");
      db.pragma("busy_timeout = 5000");
      db.pragma("synchronous = FULL");
      db.exec(
        "CREATE TABLE IF NOT EXISTS supervisor_mutex(id INTEGER PRIMARY KEY CHECK(id = 1))",
      );
      db.exec("INSERT OR IGNORE INTO supervisor_mutex(id) VALUES (1)");
      try {
        db.exec("BEGIN IMMEDIATE");
      } catch (error) {
        if (isSqliteBusy(error) && Date.now() < deadline) {
          try {
            db.close();
          } catch {
            // Best effort.
          }
          sleepSyncMs(50);
          continue;
        }
        throw error;
      }
      let committed = false;
      try {
        const result = fn();
        db.exec("COMMIT");
        committed = true;
        return result;
      } finally {
        if (!committed) {
          try {
            db.exec("ROLLBACK");
          } catch {
            // Best effort: original error carries the failure.
          }
        }
      }
    } catch (error) {
      // Setup-phase contention (never the caller's transform, which runs
      // only after BEGIN): retry within the bound, else propagate.
      if (isSqliteBusy(error) && Date.now() < deadline) {
        try {
          db.close();
        } catch {
          // Best effort.
        }
        sleepSyncMs(50);
        continue;
      }
      throw error;
    } finally {
      try {
        db.close();
      } catch {
        // Best effort.
      }
    }
  }
}

/**
 * Serialized state update: reads the LATEST state INSIDE the OS-backed
 * mutex, applies the transformation, and durably commits before returning.
 * Concurrent operator commands (stop/resume/restart) and loop bookkeeping
 * (ready/crash/drain) can never lost-update each other: every writer goes
 * through this seam. Transformations MUST preserve a newer operator
 * stop/hold/command already present in the latest read.
 */
export function updateSupervisorStateAtomically(
  paths: SupervisorPaths,
  now: number,
  nonce: string,
  transform: (latest: SupervisorState) => SupervisorState,
): SupervisorState {
  try {
    return withSupervisorMutex(paths, () => {
      const latest = readSupervisorState(paths, now, nonce);
      const next = transform(latest);
      writeSupervisorState(paths, next);
      return next;
    });
  } catch (error) {
    // Fixed fail-closed vocabulary only: never leak raw SQLite text.
    // The "stopped" sentinel is an explicit control-flow signal from an
    // operator-restart transform (restart refused while stopped) and must
    // propagate unchanged for the caller to report precisely.
    if (error instanceof Error && error.message === "stopped") throw error;
    if (
      error instanceof Error &&
      error.message === "supervisor state unreadable"
    ) {
      throw error;
    }
    throw new Error("supervisor state unreadable");
  }
}

/** Atomic ready commit on the latest state (never clears an external STOP). */
export function markSupervisorReadyAtomically(
  paths: SupervisorPaths,
  now: number,
  nonce: string,
): SupervisorState {
  return updateSupervisorStateAtomically(paths, now, nonce, (latest) =>
    markReadyTransform(latest, now),
  );
}

/** Atomic operator-stop commit (throws on failure: caller must NOT proceed
 * to shutdown/termination/ownership-release). */
export function persistSupervisorStopAtomically(
  paths: SupervisorPaths,
  now: number,
  nonce: string,
): SupervisorState {
  return updateSupervisorStateAtomically(paths, now, nonce, (latest) =>
    applyOperatorStop(latest, now),
  );
}

/** Atomic crash-accounting commit (throws on failure: caller must HOLD, not
 * respawn). Preserves external stop/hold via applyCrash. */
export function persistSupervisorCrashAtomically(
  paths: SupervisorPaths,
  now: number,
  nonce: string,
  reason: SupervisorReason,
): SupervisorState {
  return updateSupervisorStateAtomically(paths, now, nonce, (latest) =>
    applyCrash(latest, now, reason),
  );
}

/** Atomic drain-failure hold commit (throws on failure: caller must HOLD). */
export function persistSupervisorDrainHoldAtomically(
  paths: SupervisorPaths,
  now: number,
  nonce: string,
): SupervisorState {
  return updateSupervisorStateAtomically(paths, now, nonce, (latest) =>
    applyDrainFailedHold(latest, now),
  );
}

export interface SupervisorLock {
  readonly pid: number;
  readonly nonce: string;
  readonly startedAt: number;
}

/**
 * Acquire exclusive single-instance ownership. Never kills any PID:
 * - EEXIST + dead PID (ESRCH) -> stale: reclaim and retry with our nonce.
 * - EEXIST + live PID, EPERM, or unparseable content -> fail closed.
 *
 * The ENTIRE inspect-decide-reclaim sequence runs INSIDE the OS-backed
 * SQLite mutex (withSupervisorMutex), so two starters racing on a stale
 * dead-PID lock cannot both unlink-and-recreate: the second blocks on the
 * mutex, then observes the FIRST starter's live lock and fails closed with
 * "supervisor already running". This is serialized reclamation, not an
 * unlink/same-PID-recheck race: at most one owner ever exists.
 */
export function acquireSupervisorLock(
  paths: SupervisorPaths,
  nonce: string,
  now: number,
): SupervisorLock {
  try {
    return withSupervisorMutex(paths, () =>
      acquireSupervisorLockInner(paths, nonce, now),
    );
  } catch (error) {
    // Fixed fail-closed vocabulary only: never leak raw SQLite text.
    if (
      error instanceof Error &&
      (error.message === "supervisor already running" ||
        error.message === "supervisor ownership ambiguous" ||
        error.message === "supervisor lock failed")
    ) {
      throw error;
    }
    throw new Error("supervisor ownership ambiguous");
  }
}

function acquireSupervisorLockInner(
  paths: SupervisorPaths,
  nonce: string,
  now: number,
): SupervisorLock {
  ensureSupervisorDir(paths);
  const payload = JSON.stringify({
    pid: process.pid,
    nonce,
    startedAt: now,
  });
  try {
    const fd = openSync(paths.lockFile, "wx", 0o600);
    nodeCloseSync(fd);
    writeFileSync(paths.lockFile, payload, { encoding: "utf-8" });
    if (process.platform !== "win32") {
      try {
        chmodSync(paths.lockFile, 0o600);
      } catch {
        // Best effort.
      }
    }
    return { pid: process.pid, nonce, startedAt: now };
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      (error as { code?: string }).code !== "EEXIST"
    ) {
      throw new Error("supervisor lock failed");
    }
  }
  // Contended: inspect honestly, never kill.
  let raw: string;
  try {
    raw = readFileSync(paths.lockFile, "utf-8");
  } catch {
    throw new Error("supervisor ownership ambiguous");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("supervisor ownership ambiguous");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    typeof (parsed as { pid?: unknown }).pid !== "number" ||
    !Number.isInteger((parsed as { pid?: unknown }).pid) ||
    ((parsed as { pid?: unknown }).pid as number) <= 0 ||
    typeof (parsed as { nonce?: unknown }).nonce !== "string" ||
    ((parsed as { nonce?: unknown }).nonce as string).length === 0
  ) {
    throw new Error("supervisor ownership ambiguous");
  }
  const oldPid = (parsed as { pid: number }).pid;
  if (oldPid === process.pid) {
    throw new Error("supervisor ownership ambiguous");
  }
  let alive = true;
  try {
    process.kill(oldPid, 0);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "ESRCH"
    ) {
      alive = false;
    } else {
      // EPERM or anything else: may be alive, never touch it.
      throw new Error("supervisor ownership ambiguous");
    }
  }
  if (alive) {
    throw new Error("supervisor already running");
  }
  // Stale (dead PID): release and take over exactly once.
  try {
    unlinkSync(paths.lockFile);
  } catch {
    throw new Error("supervisor ownership ambiguous");
  }
  try {
    const fd = openSync(paths.lockFile, "wx", 0o600);
    nodeCloseSync(fd);
    writeFileSync(paths.lockFile, payload, { encoding: "utf-8" });
    return { pid: process.pid, nonce, startedAt: now };
  } catch {
    throw new Error("supervisor ownership ambiguous");
  }
}

/** Release ONLY when the lock still carries our nonce (never unrelated). */
export function releaseSupervisorLock(
  paths: SupervisorPaths,
  nonce: string,
): void {
  let raw: string;
  try {
    raw = readFileSync(paths.lockFile, "utf-8");
  } catch {
    return;
  }
  try {
    const parsed = JSON.parse(raw) as { nonce?: unknown; pid?: unknown };
    if (parsed.nonce !== nonce) return;
    if (parsed.pid !== process.pid) return;
    unlinkSync(paths.lockFile);
  } catch {
    // Fail closed on ambiguity: leave the lock in place.
  }
}

// ---- Child IPC protocol (fixed codes, no secrets, no model content) ----

export type SupervisorToChild = {
  readonly type: "supervisor-shutdown";
  readonly mode: "stop" | "planned-restart";
};

export type ChildToSupervisor =
  | { readonly type: "companion-ready"; readonly port: number }
  | { readonly type: "companion-failed"; readonly status: string }
  | { readonly type: "companion-drained" }
  | { readonly type: "companion-drain-failed" };

/**
 * Map a listen/startup failure to the fixed child status vocabulary.
 * `address_in_use` degrades to bounded retry (never kill any listener);
 * `newer_database` holds with the DB preserved (never restore old backup).
 */
export function childFailedStatusForError(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "EADDRINUSE"
  ) {
    return "address_in_use";
  }
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : "";
  if (
    message.includes("NewerDatabaseError") ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "newer_database")
  ) {
    return "newer_database";
  }
  return "startup_failed";
}

/** Crash accounting reason from a child failure status (fixed vocab). */
export function crashReasonForChildStatus(status: string): SupervisorReason {
  if (status === "address_in_use") return "address_in_use";
  if (status === "newer_database") return "newer_database";
  return "crash";
}
