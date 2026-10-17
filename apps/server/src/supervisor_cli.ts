// AV07 supervisor CLI (opt-in, source-run only).
//
// Usage (from the repo root, same env as `pnpm start`):
//   pnpm --filter @companion/server supervise start    # foreground manager
//   pnpm --filter @companion/server supervise stop     # persist operator stop
//   pnpm --filter @companion/server supervise resume   # clear stop, allow spawn
//   pnpm --filter @companion/server supervise restart  # request planned restart
//   pnpm --filter @companion/server supervise status   # print fixed state
//   pnpm --filter @companion/server supervise service-print  # sample unit (NOT installed)
//
// While `start` runs in the foreground, stdin accepts exactly:
// `stop`, `resume`, `restart`, `status`, `help`. Stdin counts as an explicit
// operator request. Model output, HTTP input, and any untrusted channel can
// NEVER request stop/restart/resume: only this local CLI/stdin path and the
// operator's own signals (SIGINT/SIGTERM to the supervisor process).
//
// Honest OS-boot limit: this CLI never installs, enables, or activates any
// OS service. `service-print` only prints a sample user unit; activation
// requires an actual host-operator grant outside this codebase.

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { SHUTDOWN_DRAIN_MS } from "./bootstrap.js";
import { loadServerConfig } from "./config.js";
import {
  acquireSupervisorLock,
  applyOperatorResume,
  applyOperatorStop,
  applyPlannedRestartRequest,
  type ChildToSupervisor,
  childFailedStatusForError,
  crashBackoffMs,
  crashReasonForChildStatus,
  describePlannedRestartOutcome,
  describeSpawnDecision,
  MAX_CRASH_RESTARTS,
  markSupervisorReadyAtomically,
  persistSupervisorCrashAtomically,
  persistSupervisorDrainHoldAtomically,
  persistSupervisorStopAtomically,
  readSupervisorState,
  releaseSupervisorLock,
  type SupervisorLock,
  type SupervisorState,
  type SupervisorToChild,
  supervisorPathsForDb,
  updateSupervisorStateAtomically,
} from "./supervisor.js";

const STARTUP_READY_TIMEOUT_MS = 30_000;
const EXTERNAL_POLL_MS = 500;
const PLANNED_DRAIN_WAIT_MS = SHUTDOWN_DRAIN_MS + 5_000;

const USAGE = [
  "Use: supervise start|stop|resume|restart|status|service-print",
  "start: run the foreground supervisor (same env as pnpm start)",
  "stop: persist operator stop (no spawn until resume)",
  "resume: clear operator stop and reset the crash budget",
  "restart: request a planned restart at a safe boundary",
  "status: print the fixed supervisor state",
  "service-print: print a sample OS unit (never installed)",
].join("\n");

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
  throw new Error(message);
}

function dbPaths(): ReturnType<typeof supervisorPathsForDb> {
  let config: ReturnType<typeof loadServerConfig>;
  try {
    config = loadServerConfig();
  } catch {
    fail("supervisor failed: invalid configuration");
  }
  return supervisorPathsForDb(config.dbPath);
}

function printStatus(state: SupervisorState): void {
  // Fixed fields only: no paths, no conversation/model/credential content.
  process.stdout.write(
    `${[
      `operatorStop=${state.operatorStop ? "yes" : "no"}`,
      `plannedRestart=${state.plannedRestart ? "yes" : "no"}`,
      `crashCount=${state.crashCount}`,
      `lastReason=${state.lastReason}`,
      `updatedAt=${state.updatedAt}`,
    ].join("\n")}\n`,
  );
}

/** Fixed own server entry: current Node + cached tsx loader, no shell. */
function tsxHookArgs(): string[] {
  // Reuse ONLY this process's own tsx loader hooks (the exact specifiers the
  // operator used to start THIS supervisor): no arbitrary command, no
  // model/untrusted argv, no env injection. Anything not referencing the
  // tsx loader is dropped.
  const out: string[] = [];
  const argv = process.execArgv;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    const next = argv[i + 1] as string | undefined;
    if ((arg === "--import" || arg === "--require") && next !== undefined) {
      if (next.includes("tsx")) {
        out.push(arg, next);
      }
      i += 1;
    } else if (
      (arg.startsWith("--import=") || arg.startsWith("--require=")) &&
      arg.includes("tsx")
    ) {
      out.push(arg);
    }
  }
  return out;
}

function spawnServerChild(env: NodeJS.ProcessEnv): ChildProcess {
  const entry = fileURLToPath(new URL("./index.ts", import.meta.url));
  const hooks = tsxHookArgs();
  if (hooks.length === 0) {
    throw new Error("supervisor failed: tsx loader unavailable");
  }
  const child = spawn(process.execPath, [...hooks, entry], {
    env: {
      ...env,
      // Fixed supervision marker for the child ONLY: the server's IPC
      // handshake (ready/failed/drained) is active solely under this marker,
      // so test workers, embedders, and any other IPC parent never receive
      // supervisor traffic. No provider, budget, or model setting changes.
      COMPANION_SUPERVISED: "1",
    },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    shell: false,
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  return child;
}

/** Terminate ONLY our own spawned child (process group on POSIX). */
async function terminateOwnChild(
  child: ChildProcess,
  gracefulMs: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    if (process.platform !== "win32") {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        try {
          child.kill("SIGTERM");
        } catch {
          // Best effort.
        }
      }
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    // Best effort.
  }
  const exited = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), gracefulMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  if (!exited) {
    // Graceful wait lost: force-kill ONLY our own child (never others).
    try {
      if (process.platform !== "win32") {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          try {
            child.kill("SIGKILL");
          } catch {
            // Best effort.
          }
        }
      } else {
        child.kill("SIGKILL");
      }
    } catch {
      // Best effort.
    }
  }
}

function waitForExit(child: ChildProcess): Promise<{ code: number | null }> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode });
      return;
    }
    child.once("exit", (code) => resolve({ code }));
  });
}

function sendShutdown(
  child: ChildProcess,
  mode: "stop" | "planned-restart",
): void {
  const message: SupervisorToChild = {
    type: "supervisor-shutdown",
    mode,
  };
  try {
    child.send?.(message);
  } catch {
    // Best effort: the wait below still bounds the shutdown.
  }
}

async function runSupervisor(): Promise<void> {
  const paths = dbPaths();
  const nonce = randomUUID();
  const now = Date.now();
  let lock: SupervisorLock;
  try {
    lock = acquireSupervisorLock(paths, nonce, now);
  } catch (error) {
    fail(
      error instanceof Error && error.message === "supervisor already running"
        ? "supervisor failed: already running"
        : "supervisor failed: ownership ambiguous",
    );
  }
  let state: SupervisorState;
  try {
    state = readSupervisorState(paths, Date.now(), nonce);
  } catch {
    fail("supervisor failed: state unreadable");
  }

  let stopping = false;
  let child: ChildProcess | null = null;

  /**
   * Operator stop MUST durably persist BEFORE any shutdown, termination, or
   * ownership release. Returns true only after commit; on failure the RAM
   * state is left untouched, the existing child is HELD alive, the lock is
   * kept, and a fixed diagnostic is reported. The caller must NOT proceed
   * to terminate/release when this returns false.
   */
  const persistStopFirst = (reason: string): boolean => {
    try {
      state = persistSupervisorStopAtomically(paths, Date.now(), nonce);
      process.stderr.write(`${reason}\n`);
      return true;
    } catch {
      process.stderr.write(
        "supervisor failed: state unreadable (stop not persisted, child held)\n",
      );
      return false;
    }
  };

  const onSignal = (signal: string): void => {
    if (stopping) return;
    // Durable STOP first: a disk-full (or otherwise failed) write means the
    // runnable state on disk still allows starts, so terminating the child
    // now would let it auto-start later with no resume. Hold instead.
    // This handler never silently exits without a committed stop; an
    // operator-forced SIGKILL is external and unavoidable (honest).
    if (!persistStopFirst("supervisor stopped by operator")) {
      void signal;
      return;
    }
    stopping = true;
    void (async (): Promise<void> => {
      if (child !== null) {
        sendShutdown(child, "stop");
        await terminateOwnChild(child, PLANNED_DRAIN_WAIT_MS);
      }
      releaseSupervisorLock(paths, lock.nonce);
      void signal;
      process.exitCode = 0;
    })();
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  // Foreground stdin: explicit operator requests only.
  let stdinBuffer = "";
  if (process.stdin.isTTY !== true) {
    // Non-TTY stdin still accepted line-wise (piped operator request).
  }
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk: string) => {
    stdinBuffer += chunk;
    let index = stdinBuffer.indexOf("\n");
    while (index >= 0) {
      const line = stdinBuffer.slice(0, index).trim().toLowerCase();
      stdinBuffer = stdinBuffer.slice(index + 1);
      index = stdinBuffer.indexOf("\n");
      if (line === "stop") {
        // Durable STOP first: only message the child after commit, so a
        // failed write keeps the existing child alive instead of stopping
        // it while the on-disk state still permits auto-start.
        if (persistStopFirst("supervisor stopped by operator")) {
          if (child !== null) {
            sendShutdown(child, "stop");
          }
        }
      } else if (line === "resume") {
        try {
          state = updateSupervisorStateAtomically(
            paths,
            Date.now(),
            nonce,
            (latest) => applyOperatorResume(latest, Date.now()),
          );
          process.stderr.write("supervisor resumed by operator\n");
        } catch {
          process.stderr.write("supervisor failed: state unreadable\n");
        }
      } else if (line === "restart") {
        try {
          state = updateSupervisorStateAtomically(
            paths,
            Date.now(),
            nonce,
            (latest) => {
              if (latest.operatorStop) {
                throw new Error("stopped");
              }
              return applyPlannedRestartRequest(latest, Date.now());
            },
          );
          process.stderr.write("supervisor planned restart requested\n");
        } catch (error) {
          process.stderr.write(
            error instanceof Error && error.message === "stopped"
              ? "supervisor failed: stopped (resume required)\n"
              : "supervisor failed: state unreadable\n",
          );
        }
      } else if (line === "status") {
        printStatus(state);
      } else if (line === "help" || line === "?") {
        process.stderr.write("commands: stop|resume|restart|status\n");
      } else if (line.length > 0) {
        process.stderr.write("supervisor: unknown command\n");
      }
    }
  });
  try {
    process.stdin.resume();
  } catch {
    // Best effort.
  }

  // Main loop: observe stop first, spawn only when allowed.
  let lastHeld: string | null = null;
  for (;;) {
    if (stopping) return;
    try {
      const external = readSupervisorState(paths, Date.now(), nonce);
      // External CLI stop/resume/restart while running: adopt the file.
      // A crash budget reset is honored ONLY via operator_resume.
      state = external;
    } catch {
      process.stderr.write("supervisor failed: state unreadable\n");
      await new Promise((resolve) => setTimeout(resolve, EXTERNAL_POLL_MS));
      continue;
    }
    const decision = describeSpawnDecision(state);
    if (decision !== "spawn") {
      if (decision === "held_drain_failed") {
        // Drain-failure hold: the failed child stays ALIVE and held in
        // DRAINING (never force-killed, never auto-retried). Only an
        // explicit operator resume/reset clears this hold.
        const held =
          "supervisor held: planned restart cannot drain safely (resume required)";
        if (held !== lastHeld) {
          process.stderr.write(`${held}\n`);
          lastHeld = held;
        }
        await new Promise((resolve) => setTimeout(resolve, EXTERNAL_POLL_MS));
        continue;
      }
      if (child !== null) {
        sendShutdown(child, "stop");
        await terminateOwnChild(child, PLANNED_DRAIN_WAIT_MS);
        child = null;
      }
      const held =
        decision === "held_operator_stop"
          ? "supervisor held: operator stop (resume required)"
          : decision === "held_newer_database"
            ? "supervisor held: newer database (db preserved, no restore)"
            : "supervisor held: restart budget exhausted (resume required)";
      // Held is steady-state, not a storm: report only on change.
      if (held !== lastHeld) {
        process.stderr.write(`${held}\n`);
        lastHeld = held;
      }
      await new Promise((resolve) => setTimeout(resolve, EXTERNAL_POLL_MS));
      continue;
    }
    lastHeld = null;
    // A leftover held drain-failed child is ours: after an explicit resume
    // cleared the hold, shut it down (bounded, own child only) BEFORE any
    // new spawn so the next child can bind the same port/DB.
    if (child !== null) {
      sendShutdown(child, "stop");
      await terminateOwnChild(child, PLANNED_DRAIN_WAIT_MS);
      child = null;
      if (stopping) return;
    }
    // Spawn ONLY the fixed own entry.
    child = spawnServerChild(process.env);
    const current = child;
    let readyPort: number | null = null;
    let failedStatus: string | null = null;
    let drained = false;
    let drainFailed = false;
    current.on("message", (message: unknown) => {
      const typed = message as Partial<ChildToSupervisor>;
      if (typed?.type === "companion-ready" && typeof typed.port === "number") {
        readyPort = typed.port;
      } else if (
        typed?.type === "companion-failed" &&
        typeof typed.status === "string"
      ) {
        failedStatus = typed.status;
      } else if (typed?.type === "companion-drained") {
        drained = true;
      } else if (typed?.type === "companion-drain-failed") {
        drainFailed = true;
      }
    });
    current.on("error", (error: unknown) => {
      failedStatus = childFailedStatusForError(error);
    });
    // Wait for genuine ready (never assume any existing port is ours).
    // An external operator STOP (or hold) written during this startup wait
    // is observed PROMPTLY instead of waiting out the full ready timeout:
    // the stale pre-spawn snapshot is never used for bookkeeping again.
    let startupHeld: SupervisorState | null = null;
    const readyDeadline = Date.now() + STARTUP_READY_TIMEOUT_MS;
    while (
      readyPort === null &&
      failedStatus === null &&
      current.exitCode === null &&
      current.signalCode === null &&
      Date.now() < readyDeadline &&
      !stopping
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      try {
        const latest = readSupervisorState(paths, Date.now(), nonce);
        if (latest.operatorStop || describeSpawnDecision(latest) !== "spawn") {
          startupHeld = latest;
          break;
        }
      } catch {
        // Transient read failure: keep waiting for ready.
      }
    }
    if (startupHeld !== null) {
      // External stop/hold landed mid-startup: it is already durable (the
      // CLI committed it inside the mutex), so terminate ONLY our starting
      // child and hold. The stale pre-spawn state is discarded, never
      // written back over the operator's command.
      state = startupHeld;
      sendShutdown(current, "stop");
      await terminateOwnChild(current, 5_000);
      child = null;
      continue;
    }
    if (stopping) {
      await terminateOwnChild(current, PLANNED_DRAIN_WAIT_MS);
      child = null;
      return;
    }
    if (readyPort !== null) {
      // Commit ready against the LATEST state inside the mutex: a
      // concurrent CLI stop that landed during startup is preserved (ready
      // never clears STOP) instead of being overwritten by applyReady on
      // the stale pre-spawn snapshot.
      try {
        state = markSupervisorReadyAtomically(paths, Date.now(), nonce);
      } catch {
        // Ready observed but the commit failed: HOLD with the live child
        // kept (never silently continue unaccounted, never respawn).
        process.stderr.write(
          "supervisor failed: state unreadable (ready not committed, child held)\n",
        );
        for (;;) {
          if (stopping) break;
          try {
            const live = readSupervisorState(paths, Date.now(), nonce);
            state = live;
            state = markSupervisorReadyAtomically(paths, Date.now(), nonce);
            break;
          } catch {
            await new Promise((resolve) =>
              setTimeout(resolve, EXTERNAL_POLL_MS),
            );
          }
        }
        if (stopping) {
          sendShutdown(current, "stop");
          await terminateOwnChild(current, PLANNED_DRAIN_WAIT_MS);
          child = null;
          return;
        }
      }
      if (state.operatorStop) {
        // An external stop won the race with readiness: shut down the
        // just-ready child and hold (no supervise, no restart request).
        sendShutdown(current, "stop");
        await terminateOwnChild(current, PLANNED_DRAIN_WAIT_MS);
        child = null;
        continue;
      }
      process.stderr.write(`supervisor: server ready on ${readyPort}\n`);
      // Supervise until exit or operator request.
      let restartRequested = false;
      for (;;) {
        if (stopping) break;
        try {
          const live = readSupervisorState(paths, Date.now(), nonce);
          state = live;
        } catch {
          // Keep supervising on transient read failure.
        }
        if (state.operatorStop) break;
        if (state.plannedRestart) {
          restartRequested = true;
          break;
        }
        if (current.exitCode !== null || current.signalCode !== null) break;
        if (failedStatus !== null) break;
        await new Promise((resolve) => setTimeout(resolve, EXTERNAL_POLL_MS));
      }
      if (state.operatorStop || stopping) {
        sendShutdown(current, "stop");
        await terminateOwnChild(current, PLANNED_DRAIN_WAIT_MS);
        child = null;
        continue;
      }
      if (restartRequested) {
        // Planned restart: graceful shutdown ONLY at a safe boundary.
        // Respawn REQUIRES affirmative `companion-drained`: an exit (even
        // code 0), a timeout, a lost child, or a disconnect without the ack
        // all mean durable HOLD, never terminate+respawn past the boundary.
        let disconnected = false;
        current.once("disconnect", () => {
          disconnected = true;
        });
        if (current.connected === false) disconnected = true;
        sendShutdown(current, "planned-restart");
        const drainDeadline = Date.now() + PLANNED_DRAIN_WAIT_MS;
        while (
          !drained &&
          !drainFailed &&
          current.exitCode === null &&
          current.signalCode === null &&
          Date.now() < drainDeadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const childGone =
          current.exitCode !== null || current.signalCode !== null;
        const timedOut =
          !drained && !drainFailed && !childGone && Date.now() >= drainDeadline;
        if (current.connected === false) disconnected = true;
        const outcome = describePlannedRestartOutcome({
          drained,
          drainFailed,
          childGone,
          timedOut,
          disconnected,
        });
        if (outcome !== "respawn") {
          // Cannot confirm the safe boundary: enter the persistent
          // drain-failure hold (cleared ONLY by explicit operator
          // resume/reset) and KEEP the live child held in DRAINING when it
          // is still alive — never force-kill, never auto-retry into the
          // unknown. The failed handoff keeps DB/listener open by design.
          try {
            state = persistSupervisorDrainHoldAtomically(
              paths,
              Date.now(),
              nonce,
            );
          } catch {
            process.stderr.write(
              "supervisor failed: state unreadable (drain hold not committed, child held)\n",
            );
          }
          process.stderr.write(
            "supervisor held: planned restart cannot drain safely (resume required)\n",
          );
          // child deliberately kept (no terminateOwnChild): the hold branch
          // supervises it without respawning until the operator decides.
          await new Promise((resolve) => setTimeout(resolve, EXTERNAL_POLL_MS));
          continue;
        }
        await terminateOwnChild(current, 0);
        child = null;
        // Loop respawns the SAME DB (records retained, autonomy still fenced
        // paused by the server restart fence; unknown commits never retried).
        continue;
      }
      // Unexpected exit or late failure: commit the crash budget BEFORE any
      // retry spawn. On commit failure HOLD (never loop with a stale
      // in-memory count that reloads 0 and retries every second).
      const exit = await waitForExit(current);
      child = null;
      void exit;
      const reason = crashReasonForChildStatus(failedStatus ?? "crash");
      try {
        state = persistSupervisorCrashAtomically(
          paths,
          Date.now(),
          nonce,
          reason,
        );
      } catch {
        process.stderr.write(
          "supervisor failed: state unreadable (crash budget not committed, held)\n",
        );
        for (;;) {
          if (stopping) return;
          try {
            state = persistSupervisorCrashAtomically(
              paths,
              Date.now(),
              nonce,
              reason,
            );
            break;
          } catch {
            await new Promise((resolve) =>
              setTimeout(resolve, EXTERNAL_POLL_MS),
            );
          }
        }
        if (stopping) return;
      }
      if (state.lastReason === "exhausted") {
        process.stderr.write(
          "supervisor held: restart budget exhausted (resume required)\n",
        );
        continue;
      }
      if (state.lastReason === "newer_database") {
        process.stderr.write(
          "supervisor held: newer database (db preserved, no restore)\n",
        );
        continue;
      }
      if (state.lastReason === "drain_failed") {
        process.stderr.write(
          "supervisor held: planned restart cannot drain safely (resume required)\n",
        );
        continue;
      }
      const waitMs = crashBackoffMs(state.crashCount);
      process.stderr.write(
        `supervisor: child exited (restart ${state.crashCount}/${MAX_CRASH_RESTARTS})\n`,
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }
    // Never became ready: startup failure or port collision. The child is
    // already gone or going; NEVER touch any other listener.
    const status: string = failedStatus ?? "startup_failed";
    if (current.exitCode === null && current.signalCode === null) {
      await terminateOwnChild(current, 5_000);
    } else {
      await waitForExit(current);
    }
    child = null;
    if (stopping) return;
    const reason = crashReasonForChildStatus(status);
    try {
      state = persistSupervisorCrashAtomically(
        paths,
        Date.now(),
        nonce,
        reason,
      );
    } catch {
      // Budget commit failed: HOLD and retry the COMMIT (not the child)
      // until it lands, instead of looping spawns on a stale count.
      process.stderr.write(
        "supervisor failed: state unreadable (crash budget not committed, held)\n",
      );
      for (;;) {
        if (stopping) return;
        try {
          state = persistSupervisorCrashAtomically(
            paths,
            Date.now(),
            nonce,
            reason,
          );
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, EXTERNAL_POLL_MS));
        }
      }
      if (stopping) return;
    }
    if (state.lastReason === "exhausted") {
      process.stderr.write(
        "supervisor held: restart budget exhausted (resume required)\n",
      );
      continue;
    }
    if (state.lastReason === "newer_database") {
      process.stderr.write(
        "supervisor held: newer database (db preserved, no restore)\n",
      );
      continue;
    }
    if (state.lastReason === "drain_failed") {
      process.stderr.write(
        "supervisor held: planned restart cannot drain safely (resume required)\n",
      );
      continue;
    }
    if (status === "address_in_use") {
      process.stderr.write(
        "supervisor: port occupied (foreign listener kept, bounded retry)\n",
      );
    }
    const waitMs = crashBackoffMs(state.crashCount);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

function printServiceSample(): void {
  // Sample ONLY: printed, never written to any OS location, never enabled.
  const entry = fileURLToPath(new URL("./index.ts", import.meta.url));
  const node = process.execPath;
  process.stdout.write(
    [
      "# Sample ONLY — NOT installed, NOT enabled, NOT activated.",
      "# OS service activation requires an actual host-operator grant",
      "# (systemctl --user enable/start by the host operator). This codebase",
      "# never installs or activates anything.",
      "[Unit]",
      "Description=Companion harness server (foreground supervisor, opt-in)",
      "After=network.target",
      "",
      "[Service]",
      "Type=simple",
      `ExecStart=${node} --import tsx ${entry}`,
      "Restart=no",
      "# Environment is inherited from the operator shell that enables this",
      "# unit (COMPANION_DB_PATH, COMPANION_PORT, ...). No secrets are added",
      "# here: model credentials stay in the operator's own environment.",
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n"),
  );
}

export async function runSupervisorCli(
  argv: string[] = process.argv.slice(2),
): Promise<void> {
  const [command, ...rest] = argv;
  if (rest.length > 0) {
    fail(`supervisor failed: unknown arguments. ${USAGE}`);
  }
  if (command === "start") {
    await runSupervisor();
    return;
  }
  if (command === "service-print") {
    printServiceSample();
    return;
  }
  if (command === "status") {
    const paths = dbPaths();
    let state: SupervisorState;
    try {
      state = readSupervisorState(paths, Date.now(), randomUUID());
    } catch {
      fail("supervisor failed: state unreadable");
    }
    printStatus(state);
    return;
  }
  if (command === "stop" || command === "resume" || command === "restart") {
    // Every operator command commits INSIDE the OS-backed mutex on the
    // LATEST state: a CLI stop racing loop bookkeeping (ready/crash/drain)
    // can never be lost to a concurrent read-modify-write.
    const paths = dbPaths();
    const nonce = randomUUID();
    try {
      updateSupervisorStateAtomically(paths, Date.now(), nonce, (latest) => {
        const now = Date.now();
        if (command === "stop") {
          return applyOperatorStop(latest, now);
        }
        if (command === "resume") {
          return applyOperatorResume(latest, now);
        }
        if (latest.operatorStop) {
          throw new Error("stopped");
        }
        return applyPlannedRestartRequest(latest, now);
      });
    } catch (error) {
      if (error instanceof Error && error.message === "stopped") {
        fail("supervisor failed: stopped (resume required)");
      }
      fail("supervisor failed: state unreadable");
    }
    process.stderr.write(
      command === "stop"
        ? "supervisor stopped by operator\n"
        : command === "resume"
          ? "supervisor resumed by operator\n"
          : "supervisor planned restart requested\n",
    );
    return;
  }
  fail(`supervisor failed: unknown command. ${USAGE}`);
}

function isMainModule(): boolean {
  const invoked = process.argv[1];
  return invoked?.endsWith("supervisor_cli.ts") ?? false;
}

if (isMainModule()) {
  runSupervisorCli().catch((error: unknown) => {
    if (process.exitCode === 0) {
      const message =
        error instanceof Error ? error.message : "supervisor failed";
      if (
        message !== `supervisor failed: unknown arguments. ${USAGE}` &&
        !message.startsWith("supervisor failed") &&
        !message.startsWith("Use: supervise")
      ) {
        process.stderr.write("supervisor failed\n");
      }
      process.exitCode = 1;
    }
  });
}
