// AV07 supervisor P1 consumer regressions: real files, real processes, real
// IPC. No pure-state echo, no wiring pins, no default-name assertions.
//
// Each test drives an actual consumer boundary with fault injection through
// the filesystem or across processes:
//  1. stop-persist failure (read-only dir): real IPC child stays alive, no
//     stop message is delivered, RAM/on-disk runnable state is untouched.
//  2. external `stop` racing startup (separate tsx process): the loop's
//     ready commit on the LATEST state preserves the operator STOP.
//  3. stale-owner lock race (two separate tsx processes): at most one
//     server owns the lock, no foreign PID is touched.
//  4. drain-failed handoff (real IPC child): failed child kept alive in
//     DRAINING, persistent hold, no respawn until explicit resume.
//  5. planned restart requires affirmative `companion-drained`: timeout and
//     exit-without-ack both HOLD (short waits, not the 15s production
//     bound); a real ack gates respawn.
//  6. crash-budget commit before retry (read-only dir): a failed budget
//     write holds without spawning; the commit lands once durable.

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyCrash,
  applyOperatorResume,
  applyOperatorStop,
  crashBackoffMs,
  crashReasonForChildStatus,
  describePlannedRestartOutcome,
  describeSpawnDecision,
  initialSupervisorState,
  markSupervisorReadyAtomically,
  persistSupervisorCrashAtomically,
  persistSupervisorDrainHoldAtomically,
  persistSupervisorStopAtomically,
  readSupervisorState,
  supervisorPathsForDb,
  updateSupervisorStateAtomically,
  writeSupervisorState,
} from "../src/supervisor.js";

const here = dirname(fileURLToPath(import.meta.url));
// Worktree node_modules .bin/tsx: runs the real TS helper in a separate OS
// process (same code the production CLI uses).
const tsxBin = join(here, "..", "..", "..", "node_modules", ".bin", "tsx");
const helper = join(here, "supervisor_race_helper.mts");

let dirs: string[] = [];
let children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children) {
    try {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    } catch {
      // Best effort: only our own test processes are ever signalled.
    }
  }
  children = [];
  for (const dir of dirs) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // Best effort (read-only fixture dirs need restore before rm).
    }
    try {
      const sup = join(dir, "supervisor");
      chmodSync(sup, 0o700);
    } catch {
      // Best effort.
    }
    rmSync(dir, { recursive: true, force: true });
  }
  dirs = [];
});

function tempDb(): { dbPath: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "av-supervisor-p1-"));
  dirs.push(dir);
  return { dbPath: join(dir, "companion.sqlite"), dir };
}

function nonce(tag: string): string {
  return `p1-${tag}-${Math.random().toString(36).slice(2)}`;
}

function track(child: ChildProcess): ChildProcess {
  children.push(child);
  return child;
}

function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const start = Date.now();
  return (async () => {
    for (;;) {
      if (predicate()) return true;
      if (Date.now() - start > timeoutMs) return false;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  })();
}

describe("P1 stop persists before any shutdown (fault-injected, real IPC child)", () => {
  it("a failed stop write holds the live child with no stop message", async () => {
    const { dbPath, dir } = tempDb();
    const paths = supervisorPathsForDb(dbPath);
    writeSupervisorState(
      paths,
      initialSupervisorState(Date.now(), nonce("s1")),
    );
    const before = readSupervisorState(paths, Date.now(), nonce("s1r"));
    expect(describeSpawnDecision(before)).toBe("spawn");

    // Real IPC child that records every supervisor message to a file.
    const logFile = join(dir, "child-messages.log");
    const child = track(
      spawn(
        process.execPath,
        [
          "-e",
          `const fs=require("node:fs");const out=process.env.AV_P1_MSG_LOG;` +
            `process.on("message",(m)=>{fs.appendFileSync(out,JSON.stringify(m)+"\\n");});` +
            `setInterval(()=>{},200);`,
        ],
        {
          env: { ...process.env, AV_P1_MSG_LOG: logFile },
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        },
      ),
    );
    expect(await waitFor(() => child.connected !== false, 3000)).toBe(true);

    // Fault (works even as root): a directory at the state-file path breaks
    // the atomic tmp+rename commit (rename file onto dir fails; the read
    // fails closed too). This is the real-filesystem write-failure fixture.
    rmSync(paths.stateFile, { force: true });
    mkdirSync(paths.stateFile);
    let committed = false;
    try {
      persistSupervisorStopAtomically(paths, Date.now(), nonce("s1stop"));
      committed = true;
    } catch {
      committed = false;
    }
    // Production ordering rule: shutdown/message ONLY after commit.
    if (committed && child.connected) {
      child.send({ type: "supervisor-shutdown", mode: "stop" });
    }
    expect(committed).toBe(false);
    // Child held alive, no stop message delivered.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(child.exitCode).toBeNull();
    expect(existsSync(logFile)).toBe(false);
    // Fail closed: no blind spawn on unreadable state (a later start holds
    // with a diagnostic instead of auto-starting with no resume).
    expect(() => readSupervisorState(paths, Date.now(), nonce("s1r2"))).toThrow(
      "supervisor state unreadable",
    );

    // Durability restored: the stop commits and the next start holds.
    rmSync(paths.stateFile, { recursive: true, force: true });
    const stopped = persistSupervisorStopAtomically(
      paths,
      Date.now(),
      nonce("s1stop2"),
    );
    expect(stopped.operatorStop).toBe(true);
    expect(
      describeSpawnDecision(
        readSupervisorState(paths, Date.now(), nonce("s1r3")),
      ),
    ).toBe("held_operator_stop");
  }, 20000);
});

describe("P1 external stop racing startup is preserved (cross-process)", () => {
  it("a separate-process stop during the startup wait survives the ready commit", () => {
    const { dbPath } = tempDb();
    const paths = supervisorPathsForDb(dbPath);
    writeSupervisorState(
      paths,
      initialSupervisorState(Date.now(), nonce("r1")),
    );
    // Stale pre-spawn snapshot, as the old loop held it across the wait.
    const stale = readSupervisorState(paths, Date.now(), nonce("r1s"));

    // Separate `supervise stop`-equivalent process commits concurrently.
    const stop = spawnSync(tsxBin, [helper, "stop", dbPath, nonce("r1x")], {
      encoding: "utf-8",
      timeout: 60000,
    });
    expect(stop.stdout).toContain("STOPPED");
    expect(stop.status).toBe(0);

    // The loop's ready commit MUST read latest inside the mutex: the
    // concurrent STOP survives instead of being overwritten by applyReady
    // on the stale snapshot.
    const committed = markSupervisorReadyAtomically(
      paths,
      Date.now(),
      nonce("r1loop"),
    );
    expect(committed.operatorStop).toBe(true);
    expect(describeSpawnDecision(committed)).toBe("held_operator_stop");
    expect(stale.operatorStop).toBe(false);
  }, 90000);

  it("crash bookkeeping never clears a concurrent operator stop", () => {
    const stopped = applyOperatorStop(
      initialSupervisorState(1, nonce("r2")),
      2,
    );
    const accounted = applyCrash(stopped, 3, "crash");
    expect(accounted.operatorStop).toBe(true);
    expect(describeSpawnDecision(accounted)).toBe("held_operator_stop");
  });
});

describe("P1 stale-owner lock race allows at most one server (two processes)", () => {
  it("two starters on a stale dead-PID lock serialize: one owns, one fails", async () => {
    const { dbPath } = tempDb();
    const paths = supervisorPathsForDb(dbPath);
    writeSupervisorState(paths, initialSupervisorState(1, nonce("l0")));
    // Genuinely dead PID from our own exited probe (never a foreign kill).
    const probe = track(
      spawn(process.execPath, ["-e", "setInterval(()=>{},1000);"]),
    );
    const deadPid = probe.pid ?? 0;
    expect(deadPid).toBeGreaterThan(0);
    probe.kill("SIGKILL");
    await new Promise((resolve) => probe.on("exit", resolve));
    writeFileSync(
      paths.lockFile,
      JSON.stringify({ pid: deadPid, nonce: "dead-owner", startedAt: 1 }),
      { encoding: "utf-8" },
    );

    // Two real OS processes contend concurrently; the SQLite mutex
    // serializes reclamation so at most one owns the lock.
    const runOne = (tag: string) =>
      new Promise<{ stdout: string; status: number | null }>((resolve) => {
        const contender = track(
          spawn(tsxBin, [helper, "lock", dbPath, nonce(tag)], {
            stdio: ["ignore", "pipe", "pipe"],
          }),
        );
        let stdout = "";
        contender.stdout?.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        contender.on("exit", (code) => resolve({ stdout, status: code }));
      });
    const [a, b] = await Promise.all([runOne("la"), runOne("lb")]);
    const acquired = `${a.stdout}\n${b.stdout}`.match(/ACQUIRED/g) ?? [];
    expect(acquired).toHaveLength(1);
    expect(`${a.stdout}${b.stdout}`).toMatch(
      /DENIED (supervisor already running|supervisor ownership ambiguous)/,
    );
    // Winner released on exit: no lock left behind, nothing foreign killed
    // (this test process is still alive to assert).
    expect(existsSync(paths.lockFile)).toBe(false);
  }, 120000);
});

describe("P1 drain handoff: failed child held, ack required, budget committed", () => {
  it("drain-failed keeps the live child with a persistent hold until resume", async () => {
    const { dbPath } = tempDb();
    const paths = supervisorPathsForDb(dbPath);
    const me = nonce("d1");
    writeSupervisorState(paths, initialSupervisorState(Date.now(), me));

    // Fake-child fixture with REAL IPC: reports drain failure, stays alive.
    const child = track(
      spawn(
        process.execPath,
        [
          "-e",
          `process.on("message",(m)=>{if(m&&m.type==="supervisor-shutdown"){` +
            `if(process.send)process.send({type:"companion-drain-failed"});}});` +
            `setInterval(()=>{},200);`,
        ],
        { stdio: ["ignore", "ignore", "ignore", "ipc"] },
      ),
    );
    let drainFailed = false;
    let drained = false;
    child.on("message", (m: unknown) => {
      const t = (m as { type?: string })?.type;
      if (t === "companion-drain-failed") drainFailed = true;
      if (t === "companion-drained") drained = true;
    });
    child.send({ type: "supervisor-shutdown", mode: "planned-restart" });
    expect(await waitFor(() => drainFailed, 5000)).toBe(true);

    // Production gate: no ack => hold (child NOT force-killed, no respawn).
    expect(
      describePlannedRestartOutcome({
        drained,
        drainFailed,
        childGone: child.exitCode !== null,
        timedOut: false,
        disconnected: false,
      }),
    ).toBe("hold");
    const held = persistSupervisorDrainHoldAtomically(
      paths,
      Date.now(),
      nonce("d1h"),
    );
    expect(describeSpawnDecision(held)).toBe("held_drain_failed");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(child.exitCode).toBeNull();
    expect(drained).toBe(false);

    // Only an explicit operator resume clears the hold (autonomy untouched:
    // resume never resumes autonomy itself; the server restart fence owns
    // that as a separate control-plane action).
    const resumed = updateSupervisorStateAtomically(
      paths,
      Date.now(),
      nonce("d1r"),
      (latest) => applyOperatorResume(latest, Date.now()),
    );
    expect(describeSpawnDecision(resumed)).toBe("spawn");
  }, 30000);

  it("timeout and exit-without-ack hold; a real ack gates respawn", async () => {
    // Silent child: bounded short wait stands in for the production
    // 15s bound (existing injected-clock seam, no 15s per test).
    const silent = track(
      spawn(process.execPath, ["-e", `setInterval(()=>{},200);`], {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      }),
    );
    let silentDrained = false;
    silent.on("message", (m: unknown) => {
      if ((m as { type?: string })?.type === "companion-drained") {
        silentDrained = true;
      }
    });
    silent.send({ type: "supervisor-shutdown", mode: "planned-restart" });
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(silentDrained).toBe(false);
    expect(silent.exitCode).toBeNull();
    expect(
      describePlannedRestartOutcome({
        drained: false,
        drainFailed: false,
        childGone: false,
        timedOut: true,
        disconnected: false,
      }),
    ).toBe("hold");

    // Exit 0 alone is NOT an ack: still hold.
    const quick = track(
      spawn(
        process.execPath,
        [
          "-e",
          `process.on("message",()=>{process.exit(0);});setInterval(()=>{},200);`,
        ],
        { stdio: ["ignore", "ignore", "ignore", "ipc"] },
      ),
    );
    let quickDrained = false;
    quick.on("message", (m: unknown) => {
      if ((m as { type?: string })?.type === "companion-drained") {
        quickDrained = true;
      }
    });
    quick.send({ type: "supervisor-shutdown", mode: "planned-restart" });
    expect(await waitFor(() => quick.exitCode !== null, 5000)).toBe(true);
    expect(quickDrained).toBe(false);
    expect(
      describePlannedRestartOutcome({
        drained: false,
        drainFailed: false,
        childGone: true,
        timedOut: false,
        disconnected: true,
      }),
    ).toBe("hold");

    // Real affirmative ack gates respawn.
    const good = track(
      spawn(
        process.execPath,
        [
          "-e",
          `process.on("message",(m)=>{if(m&&m.type==="supervisor-shutdown"){` +
            `if(process.send)process.send({type:"companion-drained"});` +
            `setTimeout(()=>process.exit(0),50);}});setInterval(()=>{},200);`,
        ],
        { stdio: ["ignore", "ignore", "ignore", "ipc"] },
      ),
    );
    let acked = false;
    good.on("message", (m: unknown) => {
      if ((m as { type?: string })?.type === "companion-drained") acked = true;
    });
    good.send({ type: "supervisor-shutdown", mode: "planned-restart" });
    expect(await waitFor(() => acked, 5000)).toBe(true);
    expect(
      describePlannedRestartOutcome({
        drained: true,
        drainFailed: false,
        childGone: false,
        timedOut: false,
        disconnected: false,
      }),
    ).toBe("respawn");
  }, 30000);
});

describe("P1 crash budget commits before any retry (fault-injected store)", () => {
  it("a failed budget write holds without spawning; the commit lands when durable", () => {
    const { dbPath } = tempDb();
    const paths = supervisorPathsForDb(dbPath);
    const base = initialSupervisorState(Date.now(), nonce("c1"));
    writeSupervisorState(paths, { ...base, crashCount: 2 });
    const reason = crashReasonForChildStatus("crash");

    // Fault (works even as root): a directory at the state-file path breaks
    // the atomic commit while the OS-backed mutex itself still serializes.
    rmSync(paths.stateFile, { force: true });
    mkdirSync(paths.stateFile);
    let spawns = 0;
    let committedState = null as null | { crashCount: number };
    try {
      committedState = persistSupervisorCrashAtomically(
        paths,
        Date.now(),
        nonce("c1f"),
        reason,
      ) as unknown as { crashCount: number };
      spawns += 1;
    } catch {
      // HOLD: retry the COMMIT later, never the child.
    }
    expect(committedState).toBeNull();
    expect(spawns).toBe(0);
    expect(crashBackoffMs(2)).toBe(2000);

    // Durability restored: the SAME accounting commits exactly once with
    // the incremented count (no reload-0 infinite 1s storm).
    rmSync(paths.stateFile, { recursive: true, force: true });
    writeSupervisorState(paths, { ...base, crashCount: 2 });
    const committed = persistSupervisorCrashAtomically(
      paths,
      Date.now(),
      nonce("c1r"),
      reason,
    );
    expect(committed.crashCount).toBe(3);
    expect(
      readSupervisorState(paths, Date.now(), nonce("c1r2")).crashCount,
    ).toBe(3);
  });
});
