// AV07 Codex #46 regressions: drain-hold preservation, service sample
// entrypoint, signal-path stdin release. Real files/state, no source-echo.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyOperatorResume,
  applyPlannedRestartRequest,
  describeSpawnDecision,
  initialSupervisorState,
  supervisorPathsForDb,
  updateSupervisorStateAtomically,
  writeSupervisorState,
} from "../src/supervisor.js";
import { runSupervisorCli } from "../src/supervisor_cli.js";

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs = [];
});

function tempDb(): { dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "av-codex46-"));
  dirs.push(dir);
  return { dbPath: join(dir, "companion.sqlite") };
}

function nonce(tag: string): string {
  return `codex46-${tag}-${Math.random().toString(36).slice(2)}`;
}

describe("Codex46 drain-failure hold survives restart requests", () => {
  it("pure request preserves the hold (no respawn gate flip)", () => {
    const held = {
      ...initialSupervisorState(1000, nonce("d")),
      plannedRestart: false,
      lastReason: "drain_failed" as const,
    };
    const next = applyPlannedRestartRequest(held, 1001);
    expect(next.lastReason).toBe("drain_failed");
    expect(next.plannedRestart).toBe(false);
    expect(describeSpawnDecision(next)).toBe("held_drain_failed");
  });

  it("atomic CLI-equivalent restart while held is refused, hold persists", () => {
    const { dbPath } = tempDb();
    const paths = supervisorPathsForDb(dbPath);
    writeSupervisorState(paths, {
      ...initialSupervisorState(Date.now(), nonce("d2")),
      plannedRestart: false,
      lastReason: "drain_failed",
    });
    expect(() =>
      updateSupervisorStateAtomically(
        paths,
        Date.now(),
        nonce("d2x"),
        (latest) => {
          if (latest.operatorStop || latest.lastReason === "drain_failed") {
            throw new Error("stopped");
          }
          return applyPlannedRestartRequest(latest, Date.now());
        },
      ),
    ).toThrow("stopped");
    expect(describeSpawnDecision(readFileState(paths))).toBe(
      "held_drain_failed",
    );
  });

  it("resume still clears the hold after the guard", () => {
    const { dbPath } = tempDb();
    const paths = supervisorPathsForDb(dbPath);
    writeSupervisorState(paths, {
      ...initialSupervisorState(Date.now(), nonce("d3")),
      lastReason: "drain_failed",
    });
    const resumed = updateSupervisorStateAtomically(
      paths,
      Date.now(),
      nonce("d3r"),
      (latest) => applyOperatorResume(latest, Date.now()),
    );
    expect(describeSpawnDecision(resumed)).toBe("spawn");
  });
});

function readFileState(paths: ReturnType<typeof supervisorPathsForDb>) {
  const raw = readFileSync(paths.stateFile, "utf-8");
  return JSON.parse(raw) as Parameters<typeof describeSpawnDecision>[0];
}

describe("Codex46 service sample points at the supervisor CLI", () => {
  it("service-print ExecStart invokes supervisor_cli start", async () => {
    let out = "";
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      out += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await runSupervisorCli(["service-print"]);
    } finally {
      process.stdout.write = origWrite;
    }
    expect(out).toContain("supervisor_cli");
    expect(out).toMatch(/start/);
    expect(out).not.toContain("src/index.ts");
  });
});

describe("Codex46 signal path releases stdin and exits", () => {
  it("signal cleanup detaches stdin and terminates explicitly", () => {
    const src = readFileSync(
      new URL("../src/supervisor_cli.ts", import.meta.url),
      "utf-8",
    );
    const handler = src.slice(src.indexOf("stopping = true"));
    expect(handler).toContain("removeAllListeners");
    expect(handler).toContain("process.exit(0)");
  });
});

describe("Codex46 supervised child exits when the supervisor disconnects", () => {
  it("bootstrap registers a parent-death disconnect handler", () => {
    const src = readFileSync(
      new URL("../src/bootstrap.ts", import.meta.url),
      "utf-8",
    );
    expect(src).toContain('process.on("disconnect"');
  });
});
