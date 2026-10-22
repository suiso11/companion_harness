// System monitor sampler unit tests (no real nvidia-smi / host dependence).
//
// Proves: nvidia-smi CSV parsing (multi-GPU + [N/A] -> null, never 0),
// /proc/stat delta CPU%, /proc/meminfo RAM, lazy start, idle auto-stop,
// non-overlapping samples, and fixed-vocabulary cached web-search health.

import { parseWebSearchConfig } from "@companion/contracts";
import { describe, expect, it } from "vitest";
import {
  cpuUsagePercent,
  createMonitorSampler,
  createWebSearchHealth,
  parseCpuStat,
  parseMemInfo,
  parseNvidiaSmiCsv,
} from "../src/monitor.js";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const CPU_STAT_1 = "cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 1 2 3 4\n";
const CPU_STAT_2 = "cpu  200 0 100 900 0 0 0 0 0 0\ncpu0 1 2 3 4\n";
const MEMINFO =
  "MemTotal:        8388608 kB\nMemFree:         1048576 kB\nMemAvailable:    2097152 kB\n";

describe("nvidia-smi CSV parsing", () => {
  it("parses multiple GPUs and maps [N/A] fields to null (never 0)", () => {
    const csv = [
      "0, NVIDIA GeForce RTX 4090, 37, 1234, 24564, 56, 120.50, 450.00",
      "1, Tesla T4, [N/A], [N/A], 15360, [N/A], [N/A], [Not Supported]",
    ].join("\n");
    const gpus = parseNvidiaSmiCsv(csv);
    expect(gpus).toHaveLength(2);
    expect(gpus[0]).toEqual({
      index: 0,
      name: "NVIDIA GeForce RTX 4090",
      util: 37,
      memUsedMiB: 1234,
      memTotalMiB: 24564,
      tempC: 56,
      powerW: 120.5,
      powerLimitW: 450,
    });
    expect(gpus[1]).toEqual({
      index: 1,
      name: "Tesla T4",
      util: null,
      memUsedMiB: null,
      memTotalMiB: 15360,
      tempC: null,
      powerW: null,
      powerLimitW: null,
    });
    // Explicitly prove the missing values are not zeros.
    expect(gpus[1]?.util).not.toBe(0);
    expect(gpus[1]?.powerW).not.toBe(0);

    const quoted = parseNvidiaSmiCsv(
      '2, "GPU, Special Edition", 3, 4, 5, 6, 7, 8',
    );
    expect(quoted[0]?.name).toBe("GPU, Special Edition");
    expect(quoted[0]?.powerLimitW).toBe(8);
  });

  it("skips blank/malformed lines and tolerates short rows", () => {
    expect(parseNvidiaSmiCsv("")).toEqual([]);
    expect(parseNvidiaSmiCsv("not,a,gpu\n\n")).toEqual([]);
    const [row] = parseNvidiaSmiCsv("2, GPU C, 5");
    expect(row?.index).toBe(2);
    expect(row?.powerLimitW).toBeNull();
  });
});

describe("/proc parsing", () => {
  it("computes CPU busy percent from /proc/stat deltas", () => {
    const first = parseCpuStat(CPU_STAT_1);
    const second = parseCpuStat(CPU_STAT_2);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    if (first === null || second === null) throw new Error("unreachable");
    expect(cpuUsagePercent(first, second)).toBe(50);
    expect(cpuUsagePercent(second, first)).toBeNull();
    expect(parseCpuStat("nonsense")).toBeNull();
  });

  it("reads RAM used/total MiB from /proc/meminfo", () => {
    expect(parseMemInfo(MEMINFO)).toEqual({
      usedMiB: 6144,
      totalMiB: 8192,
    });
    expect(parseMemInfo("MemTotal: 100 kB\n")).toEqual({
      usedMiB: null,
      totalMiB: null,
    });
  });
});

describe("sampler lifecycle", () => {
  it("is lazy and auto-stops after the idle timeout", async () => {
    let statReads = 0;
    let execs = 0;
    const sampler = createMonitorSampler({
      readText: async (path) => {
        if (path === "/proc/stat") {
          statReads += 1;
          // Each read advances user by 100 and idle by 100: 50% busy.
          const user = 100 + 100 * statReads;
          const idle = 800 + 100 * statReads;
          return `cpu  ${user} 0 100 ${idle} 0 0 0 0 0 0\n`;
        }
        return MEMINFO;
      },
      execFile: async () => {
        execs += 1;
        return "";
      },
      sampleIntervalMs: 10,
      idleTimeoutMs: 40,
      historySize: 3,
    });

    // Lazy: nothing runs before the first read.
    await sleep(30);
    expect(statReads).toBe(0);
    expect(execs).toBe(0);

    const first = await sampler.read();
    expect(first.hardware.ramUsedMiB).toBe(6144);
    expect(first.hardware.ramTotalMiB).toBe(8192);
    expect(first.history.t).toHaveLength(1);

    await sleep(30);
    expect(execs).toBeGreaterThan(1);
    // Ring is bounded.
    const snap = await sampler.read();
    expect(snap.history.t.length).toBeLessThanOrEqual(3);
    expect(snap.hardware.cpuPct).toBe(50);

    // No reads for > idleTimeoutMs: the timer stops and sampling ends.
    await sleep(60);
    const settled = execs;
    await sleep(40);
    expect(execs).toBe(settled);

    await sampler.stop();
  });

  it("never runs overlapping nvidia-smi executions", async () => {
    let active = 0;
    let maxActive = 0;
    let execs = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sampler = createMonitorSampler({
      readText: async (path) => (path === "/proc/stat" ? CPU_STAT_1 : MEMINFO),
      execFile: async () => {
        execs += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        await gate;
        active -= 1;
        return "";
      },
      sampleIntervalMs: 5,
      idleTimeoutMs: 1000,
    });

    const readPromise = sampler.read();
    await sleep(40);
    expect(execs).toBe(1);
    expect(maxActive).toBe(1);

    release?.();
    await readPromise;
    await sleep(20);
    expect(maxActive).toBe(1);
    await sampler.stop();
  });

  it("bounds a hung nvidia-smi (ignoring SIGTERM) and SIGKILLs it", async () => {
    let killSignal: string | undefined;
    const sampler = createMonitorSampler({
      readText: async (path) => (path === "/proc/stat" ? CPU_STAT_1 : MEMINFO),
      execFile: (_file, _args, options) => {
        options.onSpawn?.((signal) => {
          killSignal = signal;
        });
        // Never settles: simulates a child that ignored the exec timeout.
        return new Promise<string>(() => undefined);
      },
      gpuTimeoutMs: 20,
      sampleIntervalMs: 1000,
    });

    const started = Date.now();
    const snapshot = await sampler.read();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(snapshot.hardware.gpus).toEqual([]);
    expect(killSignal).toBe("SIGKILL");
    await sampler.stop();
  });

  it("stop() returns even when a sample never settles, and is final", async () => {
    let execs = 0;
    const sampler = createMonitorSampler({
      readText: () => new Promise<string>(() => undefined),
      execFile: () => {
        execs += 1;
        return new Promise<string>(() => undefined);
      },
      gpuTimeoutMs: 10_000,
      sampleIntervalMs: 5,
      stopTimeoutMs: 25,
    });

    void sampler.read();
    await sleep(10);
    const started = Date.now();
    await sampler.stop();
    expect(Date.now() - started).toBeLessThan(500);
    expect(execs).toBe(1);

    // read() after stop(): empty, no sampleNow, no timer restart.
    const after = await sampler.read();
    expect(after.hardware.gpus).toEqual([]);
    expect(after.hardware.cpuPct).toBeNull();
    expect(after.history.t).toEqual([]);
    await sleep(40);
    expect(execs).toBe(1);
  });
});

describe("web-search health", () => {
  it("is disabled without opt-in and caches ok/down for 10s", async () => {
    const disabled = createWebSearchHealth(parseWebSearchConfig(undefined));
    expect(await disabled.check()).toBe("disabled");

    let now = 1_000;
    let calls = 0;
    let cancelled = 0;
    let ok = true;
    const enabled = createWebSearchHealth(
      parseWebSearchConfig(
        JSON.stringify({
          enabled: true,
          searxng_base_url: "http://127.0.0.1:8080",
        }),
      ),
      {
        now: () => now,
        fetch: async (url, init) => {
          calls += 1;
          expect(url).toBe("http://127.0.0.1:8080/healthz");
          expect(init.method).toBe("GET");
          expect(init.redirect).toBe("manual");
          return {
            ok,
            body: {
              cancel: async () => {
                cancelled += 1;
              },
            },
          };
        },
      },
    );
    expect(await enabled.check()).toBe("ok");
    expect(await enabled.check()).toBe("ok");
    expect(calls).toBe(1);
    expect(cancelled).toBe(1);

    now += 10_001;
    ok = false;
    expect(await enabled.check()).toBe("down");
    expect(calls).toBe(2);
    expect(cancelled).toBe(2);
  });
});
