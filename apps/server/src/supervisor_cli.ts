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
  applyCrash,
  applyOperatorResume,
  applyOperatorStop,
  applyPlannedRestartRequest,
  applyReady,
  type ChildToSupervisor,
  childFailedStatusForError,
  crashBackoffMs,
  crashReasonForChildStatus,
  describeSpawnDecision,
  MAX_CRASH_RESTARTS,
  readSupervisorState,
  releaseSupervisorLock,
  type SupervisorLock,
  type SupervisorState,
  type SupervisorToChild,
  supervisorPathsForDb,
  writeSupervisorState,
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

  const persistStopFirst = (reason: string): void => {
    // Operator stop MUST persist BEFORE child termination.
    try {
      state = applyOperatorStop(state, Date.now());
      writeSupervisorState(paths, state);
      process.stderr.write(`${reason}\n`);
    } catch {
      process.stderr.write("supervisor failed: state unreadable\n");
    }
  };

  const onSignal = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    persistStopFirst("supervisor stopped by operator");
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
        persistStopFirst("supervisor stopped by operator");
        if (child !== null) {
          sendShutdown(child, "stop");
        }
      } else if (line === "resume") {
        try {
          state = applyOperatorResume(state, Date.now());
          writeSupervisorState(paths, state);
          process.stderr.write("supervisor resumed by operator\n");
        } catch {
          process.stderr.write("supervisor failed: state unreadable\n");
        }
      } else if (line === "restart") {
        try {
          state = applyPlannedRestartRequest(state, Date.now());
          writeSupervisorState(paths, state);
          process.stderr.write("supervisor planned restart requested\n");
        } catch {
          process.stderr.write("supervisor failed: state unreadable\n");
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
    }
    if (stopping) {
      await terminateOwnChild(current, PLANNED_DRAIN_WAIT_MS);
      child = null;
      return;
    }
    if (readyPort !== null) {
      state = applyReady(state, Date.now());
      try {
        writeSupervisorState(paths, state);
      } catch {
        process.stderr.write("supervisor failed: state unreadable\n");
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
        if (drainFailed) {
          // Cannot drain safely: HOLD, never force an unsafe restart.
          try {
            state = {
              ...state,
              lastReason: "drain_failed",
              updatedAt: Date.now(),
            };
            writeSupervisorState(paths, state);
          } catch {
            // Best effort.
          }
          process.stderr.write(
            "supervisor held: planned restart cannot drain safely\n",
          );
          await terminateOwnChild(current, 0);
          child = null;
          await new Promise((resolve) => setTimeout(resolve, EXTERNAL_POLL_MS));
          continue;
        }
        await terminateOwnChild(current, 0);
        child = null;
        // Loop respawns the SAME DB (records retained, autonomy still fenced
        // paused by the server restart fence; unknown commits never retried).
        continue;
      }
      // Unexpected exit or late failure: bounded crash restart.
      const exit = await waitForExit(current);
      child = null;
      void exit;
      const reason = crashReasonForChildStatus(failedStatus ?? "crash");
      state = applyCrash(state, Date.now(), reason);
      try {
        writeSupervisorState(paths, state);
      } catch {
        process.stderr.write("supervisor failed: state unreadable\n");
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
    state = applyCrash(state, Date.now(), reason);
    try {
      writeSupervisorState(paths, state);
    } catch {
      process.stderr.write("supervisor failed: state unreadable\n");
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
    const paths = dbPaths();
    let state: SupervisorState;
    try {
      state = readSupervisorState(paths, Date.now(), randomUUID());
    } catch {
      fail("supervisor failed: state unreadable");
    }
    const now = Date.now();
    if (command === "stop") {
      state = applyOperatorStop(state, now);
    } else if (command === "resume") {
      state = applyOperatorResume(state, now);
    } else {
      if (state.operatorStop) {
        fail("supervisor failed: stopped (resume required)");
      }
      state = applyPlannedRestartRequest(state, now);
    }
    try {
      writeSupervisorState(paths, state);
    } catch {
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
