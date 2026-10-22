// System monitor sampler (Strata-style host telemetry).
//
// PRIVACY / SAFETY:
// - GPU data comes from `nvidia-smi` executed with execFile (NO shell), a
//   bounded 2s timeout, and a fixed argument vector. A missing binary, a
//   timeout, or a non-zero exit yields an EMPTY GPU list (never an error
//   string). `[N/A]` / `[Not Supported]` fields become null, never 0.
// - CPU/RAM come from /proc (Linux). Any read failure yields null on every
//   non-Linux/unsupported platform.
// - The sampler is lazy: no timer and no child process runs until the first
//   read. It auto-stops when no read arrived for 60s and clears its ring so
//   a later read starts from a fresh sample (the first read after idle still
//   returns current hardware even when history is short).
// - Samples never overlap: a tick is skipped while a sample is in flight.
//
// `outputTokS` (built by the HTTP route) is output tokens divided by the
// whole call duration; it INCLUDES prefill and is therefore a lower bound,
// not a decode-only rate.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

import type { WebSearchConfig } from "@companion/contracts";

export const MONITOR_SAMPLE_INTERVAL_MS = 2000;
export const MONITOR_IDLE_TIMEOUT_MS = 60_000;
export const MONITOR_HISTORY_SIZE = 60;
export const MONITOR_GPU_TIMEOUT_MS = 2000;
const MONITOR_GPU_RACE_GRACE_MS = 500;
export const MONITOR_STOP_TIMEOUT_MS = 3000;
export const MONITOR_WEB_TIMEOUT_MS = 1500;
export const MONITOR_WEB_CACHE_MS = 10_000;

const NVIDIA_SMI_ARGS = [
  "--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit",
  "--format=csv,noheader,nounits",
] as const;

export interface GpuReading {
  index: number;
  name: string;
  util: number | null;
  memUsedMiB: number | null;
  memTotalMiB: number | null;
  tempC: number | null;
  powerW: number | null;
  powerLimitW: number | null;
}

export interface HardwareReading {
  gpus: GpuReading[];
  cpuPct: number | null;
  ramUsedMiB: number | null;
  ramTotalMiB: number | null;
}

export interface HardwareHistory {
  t: number[];
  cpuPct: (number | null)[];
  ramUsedMiB: (number | null)[];
  gpus: Array<{
    index: number;
    util: (number | null)[];
    memUsedMiB: (number | null)[];
    tempC: (number | null)[];
    powerW: (number | null)[];
  }>;
}

export interface MonitorSnapshot {
  hardware: HardwareReading;
  history: HardwareHistory;
}

export interface MonitorSampler {
  /** Marks a read, starts the timer lazily, and returns current + history. */
  read(): Promise<MonitorSnapshot>;
  /** Clears the timer and awaits any in-flight sample. */
  stop(): Promise<void>;
}

export interface MonitorExecOptions {
  readonly timeoutMs: number;
  /** Registers a hard-kill hook for the spawned child (production wrapper). */
  readonly onSpawn?: (kill: (signal: NodeJS.Signals) => void) => void;
}

export type MonitorExecFile = (
  file: string,
  args: readonly string[],
  options: MonitorExecOptions,
) => Promise<string>;

export type MonitorReadText = (path: string) => Promise<string>;

export interface MonitorSamplerOptions {
  now?: () => number;
  execFile?: MonitorExecFile;
  readText?: MonitorReadText;
  sampleIntervalMs?: number;
  idleTimeoutMs?: number;
  historySize?: number;
  gpuTimeoutMs?: number;
  stopTimeoutMs?: number;
}

interface MonitorSample extends HardwareReading {
  t: number;
}

interface CpuStat {
  idle: number;
  total: number;
}

function finiteNumber(raw: string): number | null {
  const value = Number.parseFloat(raw.trim());
  return Number.isFinite(value) ? value : null;
}

/** Split one CSV row, honoring quoted names (nvidia-smi quotes commas). */
function splitCsvRow(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      fields.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current.trim());
  return fields;
}

/** Parse nvidia-smi's `--format=csv,noheader,nounits` output. */
export function parseNvidiaSmiCsv(text: string): GpuReading[] {
  const gpus: GpuReading[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const fields = splitCsvRow(line);
    if (fields.length < 2) continue;
    const index = Number.parseInt(fields[0] ?? "", 10);
    if (!Number.isInteger(index) || index < 0) continue;
    const name = fields[1] ?? "";
    if (name.length === 0) continue;
    gpus.push({
      index,
      name,
      util: finiteNumber(fields[2] ?? ""),
      memUsedMiB: finiteNumber(fields[3] ?? ""),
      memTotalMiB: finiteNumber(fields[4] ?? ""),
      tempC: finiteNumber(fields[5] ?? ""),
      powerW: finiteNumber(fields[6] ?? ""),
      powerLimitW: finiteNumber(fields[7] ?? ""),
    });
  }
  return gpus;
}

/** Parse the aggregate first `cpu` line of /proc/stat. */
export function parseCpuStat(text: string): CpuStat | null {
  const line = text
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith("cpu "));
  if (line === undefined) return null;
  const values = line
    .trim()
    .split(/\s+/)
    .slice(1)
    .map((value) => Number.parseInt(value, 10));
  if (values.length < 4) return null;
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    return null;
  }
  // guest/guest_nice are already included in user/nice; exclude fields 8/9.
  const counted = values.slice(0, 8);
  const total = counted.reduce((sum, value) => sum + value, 0);
  // idle + iowait are both non-busy time.
  const idle = (counted[3] ?? 0) + (counted[4] ?? 0);
  return { idle, total };
}

/** CPU busy percentage between two /proc/stat snapshots. */
export function cpuUsagePercent(prev: CpuStat, next: CpuStat): number | null {
  const totalDelta = next.total - prev.total;
  const idleDelta = next.idle - prev.idle;
  if (totalDelta <= 0 || idleDelta < 0) return null;
  const pct = ((totalDelta - idleDelta) / totalDelta) * 100;
  if (!Number.isFinite(pct)) return null;
  return Math.round(Math.min(Math.max(pct, 0), 100) * 10) / 10;
}

export interface RamReading {
  usedMiB: number | null;
  totalMiB: number | null;
}

/** Parse MemTotal/MemAvailable from /proc/meminfo (kB -> MiB). */
export function parseMemInfo(text: string): RamReading {
  const totalKb = readMemInfoKb(text, "MemTotal");
  const availableKb = readMemInfoKb(text, "MemAvailable");
  if (totalKb === null || availableKb === null || totalKb <= 0) {
    return { usedMiB: null, totalMiB: null };
  }
  const usedKb = Math.max(totalKb - availableKb, 0);
  return {
    usedMiB: Math.round(usedKb / 1024),
    totalMiB: Math.round(totalKb / 1024),
  };
}

function readMemInfoKb(text: string, key: string): number | null {
  const match = new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, "m").exec(text);
  if (match === null) return null;
  const value = Number.parseInt(match[1] ?? "", 10);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/** Production execFile wrapper: no shell, bounded timeout, closed argv. */
const defaultExecFile: MonitorExecFile = (file, args, options) =>
  new Promise<string>((resolvePromise, rejectPromise) => {
    const child = execFile(
      file,
      [...args],
      {
        timeout: options.timeoutMs,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        shell: false,
      },
      (error, stdout) => {
        if (error) rejectPromise(error);
        else resolvePromise(stdout);
      },
    );
    options.onSpawn?.((signal) => {
      child.kill(signal);
    });
  });

const defaultReadText: MonitorReadText = (path) => readFile(path, "utf-8");

function emptyHistory(): HardwareHistory {
  return { t: [], cpuPct: [], ramUsedMiB: [], gpus: [] };
}

export function createMonitorSampler(
  options: MonitorSamplerOptions = {},
): MonitorSampler {
  const now = options.now ?? Date.now;
  const runExec = options.execFile ?? defaultExecFile;
  const readText = options.readText ?? defaultReadText;
  const intervalMs = options.sampleIntervalMs ?? MONITOR_SAMPLE_INTERVAL_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? MONITOR_IDLE_TIMEOUT_MS;
  const historySize = options.historySize ?? MONITOR_HISTORY_SIZE;
  const gpuTimeoutMs = options.gpuTimeoutMs ?? MONITOR_GPU_TIMEOUT_MS;
  const stopTimeoutMs = options.stopTimeoutMs ?? MONITOR_STOP_TIMEOUT_MS;

  let timer: NodeJS.Timeout | null = null;
  let lastReadAt = 0;
  let idleStopPending = false;
  let inFlight: Promise<MonitorSample> | null = null;
  let samples: MonitorSample[] = [];
  let prevCpu: CpuStat | null = null;
  let stopped = false;

  async function readGpus(): Promise<GpuReading[]> {
    const killRef: {
      current: ((signal: NodeJS.Signals) => void) | null;
    } = { current: null };
    let childSettled = false;
    let raceTimer: NodeJS.Timeout | undefined;
    const execPromise = (() => {
      try {
        return runExec("nvidia-smi", NVIDIA_SMI_ARGS, {
          timeoutMs: gpuTimeoutMs,
          onSpawn: (kill) => {
            killRef.current = kill;
          },
        });
      } catch (error) {
        return Promise.reject(error);
      }
    })()
      .then((stdout) => parseNvidiaSmiCsv(stdout))
      .catch(() => [] as GpuReading[])
      .finally(() => {
        childSettled = true;
      });
    // Hard deadline ABOVE the exec timeout: even a child that ignores the
    // SIGTERM sent by execFile must never block inFlight/read()/stop().
    const deadline = new Promise<GpuReading[]>((resolvePromise) => {
      raceTimer = setTimeout(
        () => resolvePromise([]),
        gpuTimeoutMs + MONITOR_GPU_RACE_GRACE_MS,
      );
      raceTimer.unref?.();
    });
    const gpus = await Promise.race([execPromise, deadline]);
    if (raceTimer !== undefined) clearTimeout(raceTimer);
    if (!childSettled) {
      try {
        killRef.current?.("SIGKILL");
      } catch {
        // The child is already gone; never surface a kill failure.
      }
    }
    return gpus;
  }

  async function readCpu(): Promise<number | null> {
    try {
      const parsed = parseCpuStat(await readText("/proc/stat"));
      if (parsed === null) return null;
      const pct = prevCpu === null ? null : cpuUsagePercent(prevCpu, parsed);
      prevCpu = parsed;
      return pct;
    } catch {
      return null;
    }
  }

  async function readRam(): Promise<RamReading> {
    try {
      return parseMemInfo(await readText("/proc/meminfo"));
    } catch {
      return { usedMiB: null, totalMiB: null };
    }
  }

  async function collect(): Promise<MonitorSample> {
    const [gpus, cpuPct, ram] = await Promise.all([
      readGpus(),
      readCpu(),
      readRam(),
    ]);
    return {
      t: now(),
      gpus,
      cpuPct,
      ramUsedMiB: ram.usedMiB,
      ramTotalMiB: ram.totalMiB,
    };
  }

  function finishIdleStopIfReady(): void {
    if (!idleStopPending || inFlight !== null) return;
    idleStopPending = false;
    samples = [];
    prevCpu = null;
  }

  function clearTimer(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  function sampleNow(): Promise<MonitorSample> {
    if (inFlight !== null) return inFlight;
    const pending = collect()
      .then((sample) => {
        if (!stopped) {
          samples.push(sample);
          if (samples.length > historySize) {
            samples.splice(0, samples.length - historySize);
          }
        }
        return sample;
      })
      .finally(() => {
        inFlight = null;
        finishIdleStopIfReady();
      });
    inFlight = pending;
    return pending;
  }

  function tick(): void {
    if (stopped || timer === null) return;
    if (now() - lastReadAt >= idleTimeoutMs) {
      // Auto-stop: no read for 60s. Do not interrupt an in-flight sample;
      // its completion clears the ring once it is safe to do so.
      clearTimer();
      idleStopPending = true;
      finishIdleStopIfReady();
      return;
    }
    // Never overlap samples (a slow nvidia-smi can outlive one interval).
    if (inFlight !== null) return;
    void sampleNow().catch(() => undefined);
  }

  function start(): void {
    if (stopped || timer !== null) return;
    timer = setInterval(tick, intervalMs);
    timer.unref?.();
  }

  function buildHistory(): HardwareHistory {
    const history = emptyHistory();
    const gpuIndexes = new Set<number>();
    for (const sample of samples) {
      history.t.push(sample.t);
      history.cpuPct.push(sample.cpuPct);
      history.ramUsedMiB.push(sample.ramUsedMiB);
      for (const gpu of sample.gpus) gpuIndexes.add(gpu.index);
    }
    for (const index of [...gpuIndexes].sort((a, b) => a - b)) {
      const series = {
        index,
        util: [] as (number | null)[],
        memUsedMiB: [] as (number | null)[],
        tempC: [] as (number | null)[],
        powerW: [] as (number | null)[],
      };
      for (const sample of samples) {
        const gpu = sample.gpus.find((candidate) => candidate.index === index);
        series.util.push(gpu?.util ?? null);
        series.memUsedMiB.push(gpu?.memUsedMiB ?? null);
        series.tempC.push(gpu?.tempC ?? null);
        series.powerW.push(gpu?.powerW ?? null);
      }
      history.gpus.push(series);
    }
    return history;
  }

  function emptySnapshot(): MonitorSnapshot {
    return {
      hardware: {
        gpus: [],
        cpuPct: null,
        ramUsedMiB: null,
        ramTotalMiB: null,
      },
      history: emptyHistory(),
    };
  }

  return {
    async read(): Promise<MonitorSnapshot> {
      // Final after stop(): never restart the timer or sample again.
      if (stopped) return emptySnapshot();
      lastReadAt = now();
      idleStopPending = false;
      start();
      if (samples.length === 0) {
        await sampleNow();
      }
      if (stopped) return emptySnapshot();
      const current = samples[samples.length - 1];
      const hardware: HardwareReading =
        current === undefined
          ? {
              gpus: [],
              cpuPct: null,
              ramUsedMiB: null,
              ramTotalMiB: null,
            }
          : {
              gpus: current.gpus.map((gpu) => ({ ...gpu })),
              cpuPct: current.cpuPct,
              ramUsedMiB: current.ramUsedMiB,
              ramTotalMiB: current.ramTotalMiB,
            };
      return { hardware, history: buildHistory() };
    },
    async stop(): Promise<void> {
      stopped = true;
      clearTimer();
      idleStopPending = false;
      const pending = inFlight;
      if (pending !== null) {
        let waitTimer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            pending.catch(() => undefined),
            new Promise<void>((resolvePromise) => {
              waitTimer = setTimeout(resolvePromise, stopTimeoutMs);
              waitTimer.unref?.();
            }),
          ]);
        } finally {
          if (waitTimer !== undefined) clearTimeout(waitTimer);
        }
      }
      inFlight = null;
      samples = [];
      prevCpu = null;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Web-search health (opt-in config; NEVER exposes upstream URLs)      */
/* ------------------------------------------------------------------ */

export type WebSearchHealthStatus = "ok" | "down" | "disabled";

export interface WebSearchHealth {
  check(): Promise<WebSearchHealthStatus>;
}

export interface WebSearchHealthOptions {
  now?: () => number;
  /** Injected for tests; defaults to global fetch. */
  fetch?: (
    url: string,
    init: {
      readonly method: "GET";
      readonly redirect: "manual";
      readonly signal: AbortSignal;
    },
  ) => Promise<{
    readonly ok: boolean;
    readonly body?: { cancel(): Promise<void> } | null;
  }>;
  cacheMs?: number;
  timeoutMs?: number;
}

/**
 * Cached health status for the configured SearXNG instance. Only the fixed
 * `ok`/`down`/`disabled` values cross this boundary: no URL, status text,
 * headers, or body is returned or logged. Redirects are not followed.
 */
export function createWebSearchHealth(
  config: WebSearchConfig | undefined,
  options: WebSearchHealthOptions = {},
): WebSearchHealth {
  const enabled =
    config?.enabled === true && typeof config.searxng_base_url === "string";
  const baseUrl =
    enabled && config.searxng_base_url !== undefined
      ? config.searxng_base_url.replace(/\/+$/, "")
      : null;
  const now = options.now ?? Date.now;
  const cacheMs = options.cacheMs ?? MONITOR_WEB_CACHE_MS;
  const timeoutMs = options.timeoutMs ?? MONITOR_WEB_TIMEOUT_MS;
  const fetchImpl =
    options.fetch ??
    (globalThis.fetch as NonNullable<WebSearchHealthOptions["fetch"]>);
  let cachedAt = Number.NEGATIVE_INFINITY;
  let cached: WebSearchHealthStatus = "down";
  let inFlight: Promise<WebSearchHealthStatus> | null = null;

  async function probe(): Promise<WebSearchHealthStatus> {
    if (baseUrl === null) return "disabled";
    let status: WebSearchHealthStatus = "down";
    try {
      const response = await fetchImpl(`${baseUrl}/healthz`, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = response.ok ? "ok" : "down";
      // Drain/cancel the body so an undici keep-alive slot is never leaked.
      await response.body?.cancel().catch(() => undefined);
    } catch {
      status = "down";
    }
    cached = status;
    cachedAt = now();
    return status;
  }

  return {
    async check(): Promise<WebSearchHealthStatus> {
      if (!enabled) return "disabled";
      if (now() - cachedAt < cacheMs) return cached;
      if (inFlight !== null) return inFlight;
      const pending = probe().finally(() => {
        inFlight = null;
      });
      inFlight = pending;
      return pending;
    },
  };
}
