// Monitor page pure helpers (null vs zero, request-rate selection, gaps).
import { describe, expect, test } from "vitest";
import {
  barPercent,
  formatDuration,
  formatInteger,
  formatMemoryPair,
  formatPercent,
  formatPower,
  historyForGpu,
  latestOutputTokS,
  parseMonitorData,
  requestOutputSeries,
  sparkSegments,
  stateLabel,
  totalTokens,
  webSearchLabel,
} from "../src/lib/monitor.js";

const request = (
  at: number,
  outputTokS: number | null,
): {
  at: number;
  runId: string;
  step: number;
  model: string;
  outcome: string;
  errorCode: string | null;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  outputTokS: number | null;
} => ({
  at,
  runId: `run-${at}`,
  step: 1,
  model: "local",
  outcome: "completed",
  errorCode: null,
  durationMs: 1000,
  inputTokens: 10,
  outputTokens: 5,
  outputTokS,
});

describe("null vs zero", () => {
  test("nullable values render an em dash, real zero stays zero", () => {
    expect(formatInteger(null)).toBe("—");
    expect(formatInteger(undefined)).toBe("—");
    expect(formatInteger(Number.NaN)).toBe("—");
    expect(formatInteger(0)).toBe("0");
    expect(formatPercent(0)).toBe("0.0%");
    expect(formatPercent(null)).toBe("—");
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(0)).toBe("0 ms");
    expect(formatMemoryPair(null, null)).toBe("—");
    expect(formatMemoryPair(0, 2048)).toBe("0.0 / 2.0 GiB");
    expect(formatPower(null, null)).toBe("—");
    expect(formatPower(0, 0)).toBe("0 W / 0 W");
  });
});

describe("state labels", () => {
  test("maps live state and web-search status", () => {
    expect(stateLabel("idle")).toBe("待機中");
    expect(stateLabel("generating")).toBe("生成中");
    expect(stateLabel("queued")).toBe("待ち");
    expect(stateLabel("other")).toBe("—");
    expect(webSearchLabel("ok")).toBe("正常");
    expect(webSearchLabel("down")).toBe("停止");
    expect(webSearchLabel("disabled")).toBe("無効");
  });
});

describe("request rates", () => {
  test("latest non-null wins in server (newest-first) order", () => {
    expect(
      latestOutputTokS([request(3, null), request(2, 12.5), request(1, 9)]),
    ).toBe(12.5);
    expect(latestOutputTokS([request(1, null)])).toBeNull();
  });

  test("sparkline series is chronological and keeps null gaps", () => {
    expect(
      requestOutputSeries([request(3, 30), request(2, null), request(1, 10)]),
    ).toEqual([10, null, 30]);
  });
});

describe("sparklines and bars", () => {
  test("a null sample splits the polyline", () => {
    const segments = sparkSegments([1, 2, null, 3, 4], 100, 20, 2);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toContain("0,");
    expect(segments[1]).toContain("100,");
  });

  test("all-null or empty series draws nothing", () => {
    expect(sparkSegments([null, null])).toEqual([]);
    expect(sparkSegments([])).toEqual([]);
    expect(sparkSegments(undefined)).toEqual([]);
  });

  test("a single sample becomes a visible tick", () => {
    expect(sparkSegments([42], 100, 20, 2)).toHaveLength(1);
  });

  test("bar percent clamps and rejects null/invalid maxima", () => {
    expect(barPercent(512, 1024)).toBe(50);
    expect(barPercent(2048, 1024)).toBe(100);
    expect(barPercent(null, 1024)).toBeNull();
    expect(barPercent(1, 0)).toBeNull();
  });
});

describe("history lookup", () => {
  test("finds the matching GPU series and falls back to empty", () => {
    const history = {
      t: [1],
      cpuPct: [5],
      ramUsedMiB: [100],
      gpus: [
        {
          index: 0,
          util: [10],
          memUsedMiB: [200],
          tempC: [40],
          powerW: [50],
        },
      ],
    };
    expect(historyForGpu(history, 0).util).toEqual([10]);
    expect(historyForGpu(history, 1).util).toEqual([]);
    expect(totalTokens({ inputTokens: 2, outputTokens: 3 })).toBe(5);
  });
});

describe("payload guard", () => {
  test("rejects a non-monitor body", () => {
    expect(parseMonitorData(null)).toBeNull();
    expect(parseMonitorData({ version: 1 })).toBeNull();
    expect(parseMonitorData({ version: "1" })).toBeNull();
  });
});
