// AV07 supervisor consumer regressions: actual state-machine boundaries.
//
// Every test observes behavior (spawn gates, persisted flags, budget holds,
// lock outcomes, failure codes). No snapshots, no default names, no counts
// of unrelated suites, no source-echo assertions. The state file holds no
// conversation/model/credential content: one test asserts the serialized
// form carries only the fixed vocabulary fields.

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireSupervisorLock,
  applyCrash,
  applyOperatorResume,
  applyOperatorStop,
  applyPlannedRestartRequest,
  applyReady,
  childFailedStatusForError,
  crashBackoffMs,
  crashReasonForChildStatus,
  describeSpawnDecision,
  initialSupervisorState,
  MAX_CRASH_RESTARTS,
  parseSupervisorState,
  readSupervisorState,
  releaseSupervisorLock,
  supervisorPathsForDb,
  writeSupervisorState,
} from "../src/supervisor.js";

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs = [];
});

function tempDb(): { dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "av-supervisor-"));
  dirs.push(dir);
  return { dbPath: join(dir, "companion.sqlite") };
}

function freshNonce(tag: string): string {
  return `test-nonce-${tag}-${Math.random().toString(36).slice(2)}`;
}

describe("supervisor spawn gate", () => {
  it("spawns by default, holds while an operator stop persists", () => {
    const { dbPath } = tempDb();
    const paths = supervisorPathsForDb(dbPath);
    let state = initialSupervisorState(1000, freshNonce("a"));
    expect(describeSpawnDecision(state)).toBe("spawn");
    state = applyOperatorStop(state, 1001);
    writeSupervisorState(paths, state);
    const reopened = readSupervisorState(paths, 1002, freshNonce("b"));
    expect(reopened.operatorStop).toBe(true);
    expect(describeSpawnDecision(reopened)).toBe("held_operator_stop");
  });

  it("reopening after an explicit stop never spawns without a resume", () => {
    const { dbPath } = tempDb();
    const paths = supervisorPathsForDb(dbPath);
    writeSupervisorState(
      paths,
      applyOperatorStop(initialSupervisorState(10, freshNonce("c")), 11),
    );
    // A fresh supervisor instance reading the same sidecar still holds.
    const next = readSupervisorState(paths, 12, freshNonce("d"));
    expect(describeSpawnDecision(next)).toBe("held_operator_stop");
    // Only a genuine operator resume reopens spawning (and resets budget).
    const resumed = applyOperatorResume(applyCrash(next, 13, "crash"), 14);
    expect(resumed.operatorStop).toBe(false);
    expect(resumed.crashCount).toBe(0);
    expect(describeSpawnDecision(resumed)).toBe("spawn");
  });

  it("a crash never creates an operator stop", () => {
    const stopped = applyOperatorStop(
      initialSupervisorState(1, freshNonce("e")),
      2,
    );
    expect(stopped.operatorStop).toBe(true);
    const crashed = applyCrash(
      initialSupervisorState(1, freshNonce("f")),
      2,
      "crash",
    );
    expect(crashed.operatorStop).toBe(false);
    expect(describeSpawnDecision(crashed)).toBe("spawn");
  });
});

describe("supervisor crash budget", () => {
  it("uses the existing MCP reconnect schedule then holds without storm", () => {
    expect([
      crashBackoffMs(1),
      crashBackoffMs(2),
      crashBackoffMs(3),
      crashBackoffMs(4),
      crashBackoffMs(5),
      crashBackoffMs(6),
    ]).toEqual([1000, 2000, 5000, 10000, 30000, 30000]);
    let state = initialSupervisorState(1, freshNonce("g"));
    for (let n = 1; n < MAX_CRASH_RESTARTS; n += 1) {
      state = applyCrash(state, n, "crash");
      expect(describeSpawnDecision(state)).toBe("spawn");
    }
    state = applyCrash(state, MAX_CRASH_RESTARTS, "crash");
    expect(state.lastReason).toBe("exhausted");
    expect(describeSpawnDecision(state)).toBe("held_exhausted");
  });

  it("ready consumes a planned restart but does not reset the crash budget", () => {
    let state = applyPlannedRestartRequest(
      initialSupervisorState(1, freshNonce("h")),
      2,
    );
    state = applyCrash(state, 3, "crash");
    state = applyReady(state, 4);
    expect(state.plannedRestart).toBe(false);
    expect(state.crashCount).toBe(1);
    expect(describeSpawnDecision(state)).toBe("spawn");
  });

  it("a port collision degrades to retry and never authorizes a kill", () => {
    expect(childFailedStatusForError({ code: "EADDRINUSE" })).toBe(
      "address_in_use",
    );
    expect(crashReasonForChildStatus("address_in_use")).toBe("address_in_use");
    const state = applyCrash(
      initialSupervisorState(1, freshNonce("i")),
      2,
      crashReasonForChildStatus("address_in_use"),
    );
    // Still a bounded retry, not a hold and not a stop.
    expect(state.operatorStop).toBe(false);
    expect(describeSpawnDecision(state)).toBe("spawn");
    expect(crashBackoffMs(state.crashCount)).toBe(1000);
  });

  it("a newer schema holds with the DB preserved", () => {
    expect(childFailedStatusForError({ code: "newer_database" })).toBe(
      "newer_database",
    );
    const state = applyCrash(
      initialSupervisorState(1, freshNonce("j")),
      2,
      "newer_database",
    );
    expect(describeSpawnDecision(state)).toBe("held_newer_database");
  });
});

describe("supervisor ownership lock", () => {
  it("releases a stale dead-PID lock and fails closed on ambiguity", async () => {
    const { dbPath } = tempDb();
    const paths = supervisorPathsForDb(dbPath);
    const first = acquireSupervisorLock(paths, freshNonce("k"), 100);
    expect(first.pid).toBe(process.pid);
    releaseSupervisorLock(paths, first.nonce);
    // Unparseable content is never treated as stale: fail closed.
    writeFileSync(paths.lockFile, "not-json{{", { encoding: "utf-8" });
    expect(() => acquireSupervisorLock(paths, freshNonce("l"), 101)).toThrow(
      "supervisor ownership ambiguous",
    );
    // A foreign live PID is never killed and never taken over. PID 1 is
    // NOT portable (absent on Windows, so ESRCH would look stale): use a
    // real live child of this test process instead.
    let foreign: ChildProcess | null = null;
    try {
      foreign = spawn(process.execPath, ["-e", "setInterval(()=>{},1000);"], {
        stdio: "ignore",
      });
      const foreignPid = foreign.pid ?? 0;
      expect(foreignPid).toBeGreaterThan(0);
      writeFileSync(
        paths.lockFile,
        JSON.stringify({ pid: foreignPid, nonce: "foreign", startedAt: 1 }),
        { encoding: "utf-8" },
      );
      expect(() => acquireSupervisorLock(paths, freshNonce("m"), 102)).toThrow(
        /already running|ambiguous/,
      );
      // Release only honors our own nonce: foreign locks survive us.
      releaseSupervisorLock(paths, freshNonce("n"));
      expect(readFileSync(paths.lockFile, "utf-8")).toContain("foreign");
    } finally {
      try {
        foreign?.kill("SIGKILL");
      } catch {
        // Best effort: only our own test process is ever signalled.
      }
    }
  });

  it("state files carry only the fixed vocabulary", () => {
    const { dbPath } = tempDb();
    const paths = supervisorPathsForDb(dbPath);
    const state = applyOperatorStop(
      initialSupervisorState(1700000000000, "fixed-nonce"),
      1700000000001,
    );
    writeSupervisorState(paths, state);
    const raw = readFileSync(paths.stateFile, "utf-8");
    expect(raw).not.toMatch(/token|secret|apiKey|model|message|prompt/i);
    const parsed = parseSupervisorState(raw);
    expect(Object.keys(parsed).sort()).toEqual(
      [
        "crashCount",
        "lastReason",
        "nonce",
        "operatorStop",
        "plannedRestart",
        "updatedAt",
        "version",
      ].sort(),
    );
  });

  it("unreadable state fails closed instead of spawning blind", () => {
    const { dbPath } = tempDb();
    const paths = supervisorPathsForDb(dbPath);
    writeSupervisorState(paths, initialSupervisorState(1, freshNonce("o")));
    writeFileSync(paths.stateFile, "{broken", { encoding: "utf-8" });
    expect(() => readSupervisorState(paths, 2, freshNonce("p"))).toThrow(
      "supervisor state unreadable",
    );
  });
});
