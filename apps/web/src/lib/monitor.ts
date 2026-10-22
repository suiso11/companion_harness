// Monitor page data contract + pure formatting helpers.
//
// The route returns scalar-only host telemetry (see apps/server/src/app.ts
// `GET /api/monitor`). Nothing here fetches; the component owns polling.
// PRIVACY: values are numbers/strings only, so the UI never needs HTML and
// every card renders through text interpolation.

export interface MonitorGpu {
  readonly index: number;
  readonly name: string;
  readonly util: number | null;
  readonly memUsedMiB: number | null;
  readonly memTotalMiB: number | null;
  readonly tempC: number | null;
  readonly powerW: number | null;
  readonly powerLimitW: number | null;
}

export interface MonitorRequest {
  readonly at: number;
  readonly runId: string;
  readonly step: number;
  readonly model: string;
  readonly outcome: string;
  readonly errorCode: string | null;
  readonly durationMs: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly outputTokS: number | null;
}

export interface MonitorGpuHistory {
  readonly index: number;
  readonly util: readonly (number | null)[];
  readonly memUsedMiB: readonly (number | null)[];
  readonly tempC: readonly (number | null)[];
  readonly powerW: readonly (number | null)[];
}

export interface MonitorData {
  readonly version: number;
  readonly time: number;
  readonly live: {
    readonly state: string;
    readonly runningRuns: number;
    readonly queuedRuns: number;
  };
  readonly services: {
    readonly model: {
      readonly configured: boolean;
      readonly model: string | null;
      readonly lastOutcome: string | null;
      readonly lastAt: number | null;
    };
    readonly webSearch: { readonly status: string };
  };
  readonly requests: readonly MonitorRequest[];
  readonly totals: {
    readonly since: number;
    readonly calls: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly failures: number;
  };
  readonly hardware: {
    readonly gpus: readonly MonitorGpu[];
    readonly cpuPct: number | null;
    readonly ramUsedMiB: number | null;
    readonly ramTotalMiB: number | null;
  };
  readonly history: {
    readonly t: readonly number[];
    readonly cpuPct: readonly (number | null)[];
    readonly ramUsedMiB: readonly (number | null)[];
    readonly gpus: readonly MonitorGpuHistory[];
  };
}

const OUTCOME_LABELS: Readonly<Record<string, string>> = {
  completed: "完了",
  failed: "失敗",
  timeout: "タイムアウト",
  cancelled: "中断",
};

const WEB_SEARCH_LABELS: Readonly<Record<string, string>> = {
  ok: "正常",
  down: "停止",
  disabled: "無効",
};

const EMPTY_GPU_HISTORY: MonitorGpuHistory = {
  index: -1,
  util: [],
  memUsedMiB: [],
  tempC: [],
  powerW: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNullableNumber(value: unknown): boolean {
  return value === null || isFiniteNumber(value);
}

function isNumberArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(isFiniteNumber);
}

function isNullableNumberArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(isNullableNumber);
}

/**
 * Structural guard for the monitor payload. The server contract is fixed,
 * but a partial/proxy response must never crash a card, so anything that
 * does not match the exact shape becomes the non-blocking stale state.
 */
export function parseMonitorData(value: unknown): MonitorData | null {
  if (!isRecord(value)) return null;
  if (!isFiniteNumber(value.version) || !isFiniteNumber(value.time)) {
    return null;
  }
  const live = value.live;
  if (
    !isRecord(live) ||
    typeof live.state !== "string" ||
    !isFiniteNumber(live.runningRuns) ||
    !isFiniteNumber(live.queuedRuns)
  ) {
    return null;
  }
  const services = value.services;
  if (!isRecord(services) || !isRecord(services.model)) return null;
  const model = services.model;
  if (
    typeof model.configured !== "boolean" ||
    (model.model !== null && typeof model.model !== "string") ||
    (model.lastOutcome !== null && typeof model.lastOutcome !== "string") ||
    (model.lastAt !== null && !isFiniteNumber(model.lastAt))
  ) {
    return null;
  }
  if (
    !isRecord(services.webSearch) ||
    typeof services.webSearch.status !== "string"
  ) {
    return null;
  }
  if (!Array.isArray(value.requests)) return null;
  for (const request of value.requests) {
    if (!isRecord(request)) return null;
    if (
      !isFiniteNumber(request.at) ||
      typeof request.runId !== "string" ||
      !isFiniteNumber(request.step) ||
      typeof request.model !== "string" ||
      typeof request.outcome !== "string" ||
      (request.errorCode !== null && typeof request.errorCode !== "string") ||
      !isFiniteNumber(request.durationMs) ||
      !isNullableNumber(request.inputTokens) ||
      !isNullableNumber(request.outputTokens) ||
      !isNullableNumber(request.outputTokS)
    ) {
      return null;
    }
  }
  const totals = value.totals;
  if (
    !isRecord(totals) ||
    !isFiniteNumber(totals.since) ||
    !isFiniteNumber(totals.calls) ||
    !isFiniteNumber(totals.inputTokens) ||
    !isFiniteNumber(totals.outputTokens) ||
    !isFiniteNumber(totals.failures)
  ) {
    return null;
  }
  const hardware = value.hardware;
  if (!isRecord(hardware) || !Array.isArray(hardware.gpus)) return null;
  if (
    !isNullableNumber(hardware.cpuPct) ||
    !isNullableNumber(hardware.ramUsedMiB) ||
    !isNullableNumber(hardware.ramTotalMiB)
  ) {
    return null;
  }
  for (const gpu of hardware.gpus) {
    if (!isRecord(gpu)) return null;
    if (
      !isFiniteNumber(gpu.index) ||
      typeof gpu.name !== "string" ||
      !isNullableNumber(gpu.util) ||
      !isNullableNumber(gpu.memUsedMiB) ||
      !isNullableNumber(gpu.memTotalMiB) ||
      !isNullableNumber(gpu.tempC) ||
      !isNullableNumber(gpu.powerW) ||
      !isNullableNumber(gpu.powerLimitW)
    ) {
      return null;
    }
  }
  const history = value.history;
  if (
    !isRecord(history) ||
    !isNumberArray(history.t) ||
    !isNullableNumberArray(history.cpuPct) ||
    !isNullableNumberArray(history.ramUsedMiB) ||
    !Array.isArray(history.gpus)
  ) {
    return null;
  }
  for (const gpu of history.gpus) {
    if (!isRecord(gpu)) return null;
    if (
      !isFiniteNumber(gpu.index) ||
      !isNullableNumberArray(gpu.util) ||
      !isNullableNumberArray(gpu.memUsedMiB) ||
      !isNullableNumberArray(gpu.tempC) ||
      !isNullableNumberArray(gpu.powerW)
    ) {
      return null;
    }
  }
  return value as unknown as MonitorData;
}

export function stateLabel(state: string): string {
  if (state === "idle") return "待機中";
  if (state === "generating") return "生成中";
  if (state === "queued") return "待ち";
  return "—";
}

export function outcomeLabel(outcome: string | null): string {
  if (outcome === null) return "—";
  return OUTCOME_LABELS[outcome] ?? outcome;
}

export function webSearchLabel(status: string): string {
  return WEB_SEARCH_LABELS[status] ?? "—";
}

/** Thousands grouping without locale-dependent output. */
export function formatThousands(value: number): string {
  const rounded = Math.round(value);
  const sign = rounded < 0 ? "-" : "";
  const digits = String(Math.abs(rounded));
  return `${sign}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

/** Null/undefined/NaN render as an em dash; a real zero stays "0". */
export function formatInteger(value: number | null | undefined): string {
  if (!isFiniteNumber(value)) return "—";
  return formatThousands(value);
}

export function formatCount(value: number | null | undefined): string {
  return formatInteger(value);
}

export function formatPercent(
  value: number | null | undefined,
  digits = 1,
): string {
  if (!isFiniteNumber(value)) return "—";
  return `${value.toFixed(digits)}%`;
}

export function formatGiB(mib: number | null | undefined): string {
  if (!isFiniteNumber(mib)) return "—";
  return (mib / 1024).toFixed(1);
}

export function formatMemoryPair(
  usedMiB: number | null,
  totalMiB: number | null,
): string {
  const used = formatGiB(usedMiB);
  const total = formatGiB(totalMiB);
  if (used === "—" && total === "—") return "—";
  return `${used} / ${total} GiB`;
}

export function formatTemperature(tempC: number | null): string {
  if (!isFiniteNumber(tempC)) return "—";
  return `${Math.round(tempC)} °C`;
}

export function formatPower(
  powerW: number | null,
  powerLimitW: number | null,
): string {
  const used = formatInteger(powerW);
  const limit = formatInteger(powerLimitW);
  if (used === "—" && limit === "—") return "—";
  return `${used} W / ${limit} W`;
}

export function formatDuration(durationMs: number | null | undefined): string {
  if (!isFiniteNumber(durationMs)) return "—";
  if (durationMs < 1000) return `${Math.round(durationMs)} ms`;
  return `${(durationMs / 1000).toFixed(2)} s`;
}

export function formatRate(tokS: number | null | undefined): string {
  if (!isFiniteNumber(tokS)) return "—";
  return `${tokS.toFixed(1)} tok/s`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** Local wall-clock time for the request table. */
export function formatClock(at: number | null | undefined): string {
  if (!isFiniteNumber(at)) return "—";
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "—";
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Compact Japanese relative time for service freshness. */
export function formatRelative(
  at: number | null | undefined,
  now = Date.now(),
): string {
  if (!isFiniteNumber(at)) return "—";
  const deltaMs = Math.max(0, now - at);
  if (deltaMs < 5000) return "たった今";
  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 60) return `${seconds}秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}時間前`;
  return `${Math.floor(hours / 24)}日前`;
}

export function totalTokens(totals: {
  readonly inputTokens: number;
  readonly outputTokens: number;
}): number {
  return totals.inputTokens + totals.outputTokens;
}

/** Newest first (server order): the first non-null output rate wins. */
export function latestOutputTokS(
  requests: readonly MonitorRequest[],
): number | null {
  for (const request of requests) {
    if (isFiniteNumber(request.outputTokS)) return request.outputTokS;
  }
  return null;
}

/** Oldest → newest series for the request-speed sparkline. */
export function requestOutputSeries(
  requests: readonly MonitorRequest[],
): (number | null)[] {
  return [...requests]
    .reverse()
    .map((request) =>
      isFiniteNumber(request.outputTokS) ? request.outputTokS : null,
    );
}

export function barPercent(
  value: number | null | undefined,
  max: number | null | undefined,
): number | null {
  if (!isFiniteNumber(value) || !isFiniteNumber(max) || max <= 0) return null;
  return Math.min(Math.max((value / max) * 100, 0), 100);
}

export function historyForGpu(
  history: MonitorData["history"],
  index: number,
): MonitorGpuHistory {
  return history.gpus.find((gpu) => gpu.index === index) ?? EMPTY_GPU_HISTORY;
}

function svgNumber(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/**
 * Break a series into contiguous polyline point strings; null samples end
 * a segment (gaps are never bridged). A lone sample becomes a tiny tick so
 * the first 2s poll is visible instead of an empty chart.
 */
export function sparkSegments(
  values: readonly (number | null)[] | null | undefined,
  width = 120,
  height = 32,
  padding = 3,
): string[] {
  if (!Array.isArray(values) || values.length === 0) return [];
  const finite = values.filter((value): value is number =>
    isFiniteNumber(value),
  );
  if (finite.length === 0) return [];
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const range = max - min;
  const innerHeight = Math.max(height - padding * 2, 1);
  const segments: string[] = [];
  let current: string[] = [];
  const flush = (): void => {
    if (current.length === 1) {
      const [point] = current;
      if (point !== undefined) {
        segments.push(`${point} ${point}`);
      }
    } else if (current.length > 1) {
      segments.push(current.join(" "));
    }
    current = [];
  };
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i] ?? null;
    if (!isFiniteNumber(value)) {
      flush();
      continue;
    }
    const x = values.length === 1 ? 0 : (i / (values.length - 1)) * width;
    const y =
      range === 0
        ? height / 2
        : padding + (1 - (value - min) / range) * innerHeight;
    current.push(`${svgNumber(x)},${svgNumber(y)}`);
  }
  flush();
  return segments;
}
