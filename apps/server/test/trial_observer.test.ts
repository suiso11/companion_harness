import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computeRemainingRuntimeMs,
  expectedTrialScopeUnit,
  parseProcStatStartTicks,
  parseSystemctlShow,
  parseSystemdUsec,
  queryScopeUnit,
  readProcessIdentity,
} from "../src/trial_observer.js";

type ExecFileImpl = (
  file: string,
  args: readonly string[],
  options: unknown,
  callback: (error: Error | null, stdout: string) => void,
) => unknown;

const execFileControl = vi.hoisted(() => {
  let impl: ExecFileImpl | null = null;
  return {
    set(fn: ExecFileImpl): void {
      impl = fn;
    },
    clear(): void {
      impl = null;
    },
    get(): ExecFileImpl | null {
      return impl;
    },
  };
});

// Deterministic execFile seam: default passthrough keeps the real-stub tests
// below, one regression test installs a delayed callback implementation.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: (
      file: string,
      args: readonly string[],
      options: unknown,
      callback: (error: Error | null, stdout: string) => void,
    ) => {
      const impl = execFileControl.get();
      if (impl !== null) return impl(file, args, options, callback);
      return (
        actual.execFile as unknown as (
          f: string,
          a: readonly string[],
          o: unknown,
          cb: (error: Error | null, stdout: string) => void,
        ) => unknown
      )(file, args, options, callback);
    },
  };
});

afterEach(() => {
  execFileControl.clear();
  vi.restoreAllMocks();
});

describe("expectedTrialScopeUnit", () => {
  it("is byte-identical to the Own-pi formula for a sample pair", () => {
    const executionId = "123e4567-e89b-42d3-a456-426614174000";
    const taskHash = "ab".repeat(32);
    // Inline copy of Own-pi capsule.ts expectedScopeUnit +
    // companion-protocol.ts companionScopeIdentity (no sibling import).
    const ownPi = `capsule-${executionId}-${taskHash}.scope`;
    expect(expectedTrialScopeUnit(executionId, taskHash)).toBe(ownPi);
    expect(expectedTrialScopeUnit(executionId, taskHash)).toBe(
      `capsule-${executionId}-${taskHash}.scope`,
    );
  });
  it("rejects malformed ids", () => {
    expect(() =>
      expectedTrialScopeUnit("not-a-uuid", "ab".repeat(32)),
    ).toThrow();
    expect(() =>
      expectedTrialScopeUnit("123e4567-e89b-42d3-a456-426614174000", "zz"),
    ).toThrow();
  });
});

describe("parseProcStatStartTicks", () => {
  it("handles names containing ') (' and spaces", () => {
    // pid (weird ) ( name) state= R ... starttime(field22)=12345.
    const after = [
      "R",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "10",
      "11",
      "12",
      "13",
      "14",
      "15",
      "16",
      "17",
      "18",
      "12345",
      "19",
      "20",
    ];
    const stat = `9999 (weird ) ( name) ${after.join(" ")}`;
    expect(parseProcStatStartTicks(stat)).toBe("12345");
  });
  it("malformed input yields null", () => {
    expect(parseProcStatStartTicks("no parens here")).toBeNull();
    expect(parseProcStatStartTicks("1 (x) R")).toBeNull(); // too few fields
    const bad = `1 (x) ${["R", ...Array(18).fill("0"), "0"].join(" ")}`; // ticks=0 invalid
    expect(parseProcStatStartTicks(bad)).toBeNull();
  });
});

describe("systemctl show parsing", () => {
  const base = (over: Record<string, string>) =>
    [
      `LoadState=${over.LoadState ?? "loaded"}`,
      `ActiveState=${over.ActiveState ?? "active"}`,
      `ActiveEnterTimestampMonotonic=${over.ActiveEnterTimestampMonotonic ?? "1000000"}`,
      `RuntimeMaxUSec=${over.RuntimeMaxUSec ?? "20000000"}`,
      "MemoryMax=infinity",
      `TasksMax=${over.TasksMax ?? "8"}`,
      "CPUQuotaPerSecUSec=infinity",
    ].join("\n");

  it("parses key=value strictly and ignores garbage", () => {
    const kv = parseSystemctlShow(
      `${base({})}\ngarbage-no-equals\n9bad=x\n=empty\n`,
    );
    expect(kv.LoadState).toBe("loaded");
    expect(kv.TasksMax).toBe("8");
    expect(kv["garbage-no-equals"]).toBeUndefined();
  });

  // Linux-only: these two cases execute stub systemctl binaries via
  // `#!/bin/sh` scripts. Windows has no POSIX sh/systemctl, so the stubs
  // cannot execute there (queryScopeUnit returns "unknown"); pure parsers
  // above stay platform-independent.
  it.runIf(process.platform !== "win32")(
    "gone/active/failed classification via stub systemctl executables",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "trial-ob-stub-"));
      const mkStub = (name: string, body: string) => {
        const p = join(dir, name);
        writeFileSync(p, `#!/bin/sh\nprintf '%b' ${JSON.stringify(body)}\n`);
        chmodSync(p, 0o755);
        return p;
      };
      const show = (over: Record<string, string>) =>
        [
          `LoadState=${over.LoadState ?? "loaded"}`,
          `ActiveState=${over.ActiveState ?? "active"}`,
          `ActiveEnterTimestampMonotonic=${over.ActiveEnterTimestampMonotonic ?? "1000000"}`,
          `RuntimeMaxUSec=${over.RuntimeMaxUSec ?? "20000000"}`,
          "MemoryMax=infinity",
          `TasksMax=${over.TasksMax ?? "8"}`,
          "CPUQuotaPerSecUSec=infinity",
        ].join("\n");
      const xdg = { xdgRuntimeDir: "/run/user/1000", timeoutMs: 3000 };

      const gone = await queryScopeUnit(
        mkStub(
          "gone.sh",
          show({ LoadState: "not-found", ActiveState: "inactive" }),
        ),
        "u.scope",
        xdg,
      );
      expect(gone.scopeState).toBe("gone");

      const failed = await queryScopeUnit(
        mkStub("failed.sh", show({ ActiveState: "failed" })),
        "u.scope",
        xdg,
      );
      expect(failed.scopeState).toBe("unknown");

      const garbage = await queryScopeUnit(
        mkStub("garbage.sh", "total nonsense\n"),
        "u.scope",
        xdg,
      );
      expect(garbage.scopeState).toBe("unknown");

      // Active with known remaining: enter=1s mono, max=20s, now≈real mono.
      // Stub enter is stale (1s) so remaining clamps out of range -> unknown;
      // use a fresh enter close to now for the positive case.
      const nowUs = process.hrtime.bigint() / 1000n;
      const fresh = await queryScopeUnit(
        mkStub(
          "active.sh",
          show({ ActiveEnterTimestampMonotonic: nowUs.toString() }),
        ),
        "u.scope",
        { ...xdg, nowMonotonicUs: nowUs + 1_000_000n },
      );
      expect(fresh.scopeState).toBe("active");
      expect(fresh.remainingRuntimeMs).toBe(19000);
      expect(fresh.tasksMax).toBe("8");

      const inf = await queryScopeUnit(
        mkStub(
          "inf.sh",
          show({
            ActiveEnterTimestampMonotonic: nowUs.toString(),
            RuntimeMaxUSec: "infinity",
          }),
        ),
        "u.scope",
        { ...xdg, nowMonotonicUs: nowUs },
      );
      expect(inf.scopeState).toBe("unknown");
      expect(inf.remainingRuntimeMs).toBeNull();

      // Missing binary -> unknown, never throws.
      const missing = await queryScopeUnit(
        "/nonexistent-systemctl-probe",
        "u.scope",
        xdg,
      );
      expect(missing.scopeState).toBe("unknown");
    },
  );

  it.runIf(process.platform !== "win32")(
    "elapsed RuntimeMax while loaded is active with remaining 0 (finding 4)",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "trial-ob-elapsed-"));
      const nowUs = process.hrtime.bigint() / 1000n;
      // Entered 30s ago with a 20s max: elapsed while still loaded+active.
      const entered = (nowUs - 30_000_000n).toString();
      const body = [
        "LoadState=loaded",
        "ActiveState=active",
        `ActiveEnterTimestampMonotonic=${entered}`,
        "RuntimeMaxUSec=20000000",
        "MemoryMax=infinity",
        "TasksMax=8",
        "CPUQuotaPerSecUSec=infinity",
      ].join("\n");
      const p = join(dir, "elapsed.sh");
      writeFileSync(p, `#!/bin/sh\nprintf '%b' ${JSON.stringify(body)}\n`);
      chmodSync(p, 0o755);
      const props = await queryScopeUnit(p, "u.scope", {
        xdgRuntimeDir: "/run/user/1000",
        timeoutMs: 3000,
        nowMonotonicUs: nowUs,
      });
      expect(props.scopeState).toBe("active");
      expect(props.remainingRuntimeMs).toBe(0);
    },
  );

  it.runIf(process.platform !== "win32")(
    "samples the clock after a delayed systemctl result (activation during query)",
    async () => {
      const runtimeMaxUs = 300_000_000n;
      const show = (enter: bigint) =>
        [
          "LoadState=loaded",
          "ActiveState=active",
          `ActiveEnterTimestampMonotonic=${enter}`,
          `RuntimeMaxUSec=${runtimeMaxUs}`,
          "MemoryMax=infinity",
          "TasksMax=8",
          "CPUQuotaPerSecUSec=infinity",
        ].join("\n");
      // Deterministic monotonic clock; no sleeps. The query starts at t0, the
      // scope activates at t0+4ms while systemctl is still in flight, and the
      // execFile callback returns after that activation.
      let nowUs = 1_000_000n;
      const clock = vi
        .spyOn(process.hrtime, "bigint")
        .mockImplementation(() => nowUs * 1000n);
      const activatedAt = nowUs + 4_000n;
      execFileControl.set((_file, _args, _options, callback) => {
        nowUs = activatedAt;
        callback(null, show(activatedAt));
        return {};
      });

      const props = await queryScopeUnit("/fake/systemctl", "u.scope", {
        xdgRuntimeDir: "/run/user/1000",
        timeoutMs: 3000,
      });
      expect(clock).toHaveBeenCalled();
      expect(props.scopeState).toBe("active");
      // Old bug sampled t0 before execFile: 300004ms > RuntimeMax/1000. The
      // post-query sample must never manufacture a bound above RuntimeMax.
      const runtimeMaxMs = Number((runtimeMaxUs + 999n) / 1000n);
      expect(props.remainingRuntimeMs).toBe(300000);
      expect(props.remainingRuntimeMs).toBeLessThanOrEqual(runtimeMaxMs);

      // A truly future ActiveEnter stamp is unknown, not a fabricated bound.
      const futureNow = nowUs;
      execFileControl.set((_file, _args, _options, callback) => {
        nowUs = futureNow;
        callback(null, show(futureNow + 1n));
        return {};
      });
      const future = await queryScopeUnit("/fake/systemctl", "u.scope", {
        xdgRuntimeDir: "/run/user/1000",
        timeoutMs: 3000,
      });
      expect(future.scopeState).toBe("unknown");
      expect(future.remainingRuntimeMs).toBeNull();
    },
  );

  it("remaining computation incl. infinity", () => {
    // enter=1s, max=20s, now=2s (all us) -> 19000ms.
    expect(computeRemainingRuntimeMs(1_000_000n, 20_000_000n, 2_000_000n)).toBe(
      19000,
    );
    // ceil: 1500us remaining -> 2ms.
    expect(computeRemainingRuntimeMs(0n, 1500n, 0n)).toBe(2);
    // infinity denies.
    expect(
      computeRemainingRuntimeMs(1_000_000n, "infinity", 2_000_000n),
    ).toBeNull();
    // elapsed RuntimeMax while still loaded: tearing down (0), NOT unknown.
    expect(computeRemainingRuntimeMs(1_000_000n, 1_000_000n, 5_000_000n)).toBe(
      0,
    );
    // missing denies.
    expect(computeRemainingRuntimeMs(null, 20_000_000n, 2_000_000n)).toBeNull();
    // future ActiveEnter is unknown (never a manufactured within-bound value).
    expect(
      computeRemainingRuntimeMs(2_000_001n, 20_000_000n, 2_000_000n),
    ).toBeNull();
  });

  it("parses systemd human time spans (as systemctl show renders them)", () => {
    expect(parseSystemdUsec("20000000")).toBe(20000000n);
    expect(parseSystemdUsec("20s")).toBe(20_000_000n);
    expect(parseSystemdUsec("500ms")).toBe(500_000n);
    expect(parseSystemdUsec("1min 30s")).toBe(90_000_000n);
    expect(parseSystemdUsec("infinity")).toBe("infinity");
    expect(parseSystemdUsec(undefined)).toBeNull();
    expect(parseSystemdUsec("soon")).toBeNull();
    expect(parseSystemdUsec("20fortnights")).toBeNull();
    expect(parseSystemdUsec("1 month")).toBeNull();
  });
});

describe("readProcessIdentity (real /proc)", () => {
  it("resolves own pid and never throws for pid 1", async () => {
    const self = await readProcessIdentity(process.pid);
    if (process.platform === "win32") {
      // No /proc on Windows: identity or unknown — never throws.
      expect(
        self === "gone" || self === "unknown" || typeof self === "object",
      ).toBe(true);
    } else {
      expect(typeof self).toBe("object");
    }
    if (typeof self !== "string") {
      expect(self.pid).toBe(process.pid);
      expect(/^[1-9][0-9]{0,19}$/.test(self.processStartTicks)).toBe(true);
      expect(self.bootId.length).toBeGreaterThan(0);
    }
    const one = await readProcessIdentity(1);
    // pid 1: identity or unknown — never throws, never 'gone'-crash.
    expect(one === "gone" || one === "unknown" || typeof one === "object").toBe(
      true,
    );
  });
});
