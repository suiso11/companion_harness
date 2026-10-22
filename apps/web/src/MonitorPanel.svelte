<script lang="ts">
// System monitor (Strata-inspired layout, original markup/CSS).
//
// Data: exactly one same-origin GET /api/monitor every 2s while the document
// is visible. Hiding the tab pauses the timer; showing it resumes with an
// immediate read; unmount clears the timer and ignores late responses.
// A failed response keeps the last payload and only flips the stale banner
// (non-blocking). No other network calls, no inline styles or style:
// directives (strict CSP: style-src 'self').

import {
  barPercent,
  formatClock,
  formatCount,
  formatDuration,
  formatInteger,
  formatMemoryPair,
  formatPercent,
  formatPower,
  formatRate,
  formatRelative,
  formatTemperature,
  historyForGpu,
  latestOutputTokS,
  type MonitorData,
  outcomeLabel,
  parseMonitorData,
  requestOutputSeries,
  sparkSegments,
  stateLabel,
  totalTokens,
  webSearchLabel,
} from "./lib/monitor.js";

const POLL_MS = 2000;

let data = $state<MonitorData | null>(null);
let stale = $state(false);
let destroyed = false;
let inFlight = false;
let timer: number | null = null;

async function poll(): Promise<void> {
  if (destroyed || inFlight) return;
  if (document.visibilityState !== "visible") return;
  inFlight = true;
  try {
    const response = await fetch("/api/monitor", {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) {
      if (!destroyed) stale = true;
      return;
    }
    const parsed = parseMonitorData(await response.json());
    if (destroyed) return;
    if (parsed === null) {
      stale = true;
      return;
    }
    data = parsed;
    stale = false;
  } catch {
    if (!destroyed) stale = true;
  } finally {
    inFlight = false;
  }
}

function start(): void {
  if (destroyed || timer !== null) return;
  void poll();
  timer = window.setInterval(() => {
    void poll();
  }, POLL_MS);
}

function stop(): void {
  if (timer !== null) {
    window.clearInterval(timer);
    timer = null;
  }
}

function onVisibilityChange(): void {
  if (destroyed) return;
  if (document.visibilityState === "visible") start();
  else stop();
}

$effect(() => {
  destroyed = false;
  document.addEventListener("visibilitychange", onVisibilityChange);
  if (document.visibilityState === "visible") start();
  return () => {
    destroyed = true;
    stop();
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
});

const speed = $derived(data === null ? null : latestOutputTokS(data.requests));
const speedSeries = $derived(
  data === null ? [] : requestOutputSeries(data.requests),
);
</script>

<section
  id="monitor"
  class="feature-panel monitor-panel"
  aria-label="モニター"
>
  <header class="monitor-header">
    <div>
      <h2>モニター</h2>
      <p class="monitor-sub">ホストとモデル呼び出しの概況</p>
    </div>
    {#if data !== null}
      <div class="monitor-live">
        <span
          id="monitor-state"
          class="monitor-state-pill"
          data-state={data.live.state}>{stateLabel(data.live.state)}</span
        >
        <span id="monitor-live-counts" class="monitor-live-counts"
          >実行中 {formatCount(data.live.runningRuns)}・待ち
          {formatCount(data.live.queuedRuns)}</span
        >
      </div>
    {/if}
  </header>

  {#if data === null}
    <p id="monitor-status" class="monitor-empty" role="status">
      {stale ? "取得できません" : "読み込み中…"}
    </p>
  {:else}
    {#if stale}
      <p id="monitor-stale" class="monitor-stale" role="status">
        取得できません（最後に取得した値を表示しています）
      </p>
    {/if}

    <div class="monitor-grid">
      <article class="monitor-card" id="monitor-speed-card">
        <header class="monitor-card-head">
          <h3>出力速度</h3>
          <span class="monitor-card-note">最新</span>
        </header>
        <p class="monitor-big" id="monitor-speed-value">
          {formatRate(speed)}
        </p>
        <p class="monitor-note">プリフィル込みの概算</p>
        {@render sparkline(speedSeries, "直近")}
      </article>

      {#each data.hardware.gpus as gpu (gpu.index)}
        {@const history = historyForGpu(data.history, gpu.index)}
        <article class="monitor-card" id={`monitor-gpu-${gpu.index}`}>
          <header class="monitor-card-head">
            <h3>GPU {gpu.index}</h3>
            <span class="monitor-card-note">{gpu.name}</span>
          </header>
          <p class="monitor-big">{formatPercent(gpu.util, 0)}</p>
          <p class="monitor-note">使用率</p>
          {@render sparkline(history.util, "使用率")}
          <div class="monitor-metric-line">
            <span class="monitor-metric-label">VRAM</span>
            <span class="monitor-metric-value"
              >{formatMemoryPair(gpu.memUsedMiB, gpu.memTotalMiB)}</span
            >
          </div>
          {@render bar(gpu.memUsedMiB, gpu.memTotalMiB)}
          <div class="monitor-metric-row">
            <div class="monitor-metric-cell">
              <span class="monitor-metric-label">温度</span>
              <span class="monitor-metric-value"
                >{formatTemperature(gpu.tempC)}</span
              >
            </div>
            <div class="monitor-metric-cell">
              <span class="monitor-metric-label">電力</span>
              <span class="monitor-metric-value"
                >{formatPower(gpu.powerW, gpu.powerLimitW)}</span
              >
            </div>
          </div>
          <div class="monitor-spark-pair">
            {@render sparkline(history.tempC, "温度")}
            {@render sparkline(history.powerW, "電力")}
          </div>
        </article>
      {/each}

      <article class="monitor-card" id="monitor-cpu-card">
        <header class="monitor-card-head">
          <h3>CPU</h3>
          <span class="monitor-card-note">使用率</span>
        </header>
        <p class="monitor-big" id="monitor-cpu-pct">
          {formatPercent(data.hardware.cpuPct, 1)}
        </p>
        <p class="monitor-note">全コア合計</p>
        {@render sparkline(data.history.cpuPct, "推移")}
      </article>

      <article class="monitor-card" id="monitor-ram-card">
        <header class="monitor-card-head">
          <h3>RAM</h3>
          <span class="monitor-card-note">使用 / 合計</span>
        </header>
        <p class="monitor-mid" id="monitor-ram-used">
          {formatMemoryPair(
            data.hardware.ramUsedMiB,
            data.hardware.ramTotalMiB,
          )}
        </p>
        {@render bar(
          data.hardware.ramUsedMiB,
          data.hardware.ramTotalMiB,
        )}
        {@render sparkline(data.history.ramUsedMiB, "使用量")}
      </article>

      <article class="monitor-card monitor-card-wide" id="monitor-services">
        <header class="monitor-card-head">
          <h3>サービス</h3>
          <span class="monitor-card-note">設定と直近の状態</span>
        </header>
        <dl class="monitor-service-list">
          <div class="monitor-service-row">
            <dt>モデル設定</dt>
            <dd id="monitor-service-configured">
              {data.services.model.configured ? "設定済み" : "未設定"}
            </dd>
          </div>
          <div class="monitor-service-row">
            <dt>モデル</dt>
            <dd id="monitor-service-model">
              {data.services.model.model ?? "—"}
            </dd>
          </div>
          <div class="monitor-service-row">
            <dt>最終結果</dt>
            <dd id="monitor-service-last">
              {#if data.services.model.lastOutcome === null}
                —
              {:else}
                {outcomeLabel(data.services.model.lastOutcome)}・{formatRelative(
                  data.services.model.lastAt,
                )}
              {/if}
            </dd>
          </div>
          <div class="monitor-service-row">
            <dt>Web検索</dt>
            <dd>
              <span
                id="monitor-service-websearch"
                class="monitor-service-badge"
                data-status={data.services.webSearch.status}
                >{webSearchLabel(data.services.webSearch.status)}</span
              >
            </dd>
          </div>
        </dl>
      </article>
    </div>

    <section
      class="monitor-totals"
      aria-labelledby="monitor-totals-title"
    >
      <h3 id="monitor-totals-title">24時間合計</h3>
      <div class="monitor-totals-grid">
        <div>
          <span class="monitor-stat-label">呼び出し</span>
          <span class="monitor-stat" id="monitor-totals-calls"
            >{formatCount(data.totals.calls)}</span
          >
        </div>
        <div>
          <span class="monitor-stat-label">トークン</span>
          <span class="monitor-stat" id="monitor-totals-tokens"
            >{formatCount(totalTokens(data.totals))}</span
          >
          <span class="monitor-stat-sub"
            >入力 {formatInteger(data.totals.inputTokens)}・出力
            {formatInteger(data.totals.outputTokens)}</span
          >
        </div>
        <div>
          <span class="monitor-stat-label">失敗</span>
          <span class="monitor-stat" id="monitor-totals-failures"
            >{formatCount(data.totals.failures)}</span
          >
        </div>
      </div>
    </section>

    <section
      class="monitor-requests"
      aria-labelledby="monitor-requests-title"
    >
      <h3 id="monitor-requests-title">直近のリクエスト</h3>
      {#if data.requests.length === 0}
        <p class="monitor-empty">まだリクエストがありません</p>
      {:else}
        <div class="monitor-table-wrap">
          <table class="monitor-table" id="monitor-requests">
            <thead>
              <tr>
                <th scope="col">時刻</th>
                <th scope="col">モデル</th>
                <th scope="col">結果</th>
                <th scope="col" class="monitor-num">入力</th>
                <th scope="col" class="monitor-num">出力</th>
                <th scope="col" class="monitor-num">所要時間</th>
                <th scope="col" class="monitor-num">tok/s</th>
              </tr>
            </thead>
            <tbody>
              {#each data.requests as request (request.runId +
                ":" +
                request.step +
                ":" +
                request.at)}
                <tr>
                  <td>{formatClock(request.at)}</td>
                  <td class="monitor-model" title={request.model}>
                    {request.model}
                  </td>
                  <td>
                    <span
                      class="monitor-outcome"
                      data-outcome={request.outcome}
                      >{outcomeLabel(request.outcome)}</span
                    >
                    {#if request.errorCode !== null}
                      <span class="monitor-error-code"
                        >{request.errorCode}</span
                      >
                    {/if}
                  </td>
                  <td class="monitor-num">
                    {formatInteger(request.inputTokens)}
                  </td>
                  <td class="monitor-num">
                    {formatInteger(request.outputTokens)}
                  </td>
                  <td class="monitor-num">
                    {formatDuration(request.durationMs)}
                  </td>
                  <td class="monitor-num">
                    {formatRate(request.outputTokS)}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </section>
  {/if}
</section>

{#snippet sparkline(
  values: readonly (number | null)[],
  label: string,
)}
  {@const segments = sparkSegments(values)}
  <div class="monitor-spark">
    <span class="monitor-spark-label">{label}</span>
    {#if segments.length === 0}
      <span class="monitor-spark-empty">—</span>
    {:else}
      <svg
        class="monitor-spark-svg"
        viewBox="0 0 120 32"
        width="120"
        height="32"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {#each segments as points}
          <polyline class="monitor-spark-line" points={points} fill="none" />
        {/each}
      </svg>
    {/if}
  </div>
{/snippet}

{#snippet bar(value: number | null, max: number | null)}
  {@const percent = barPercent(value, max)}
  <svg
    class="monitor-bar"
    viewBox="0 0 100 6"
    width="100"
    height="6"
    preserveAspectRatio="none"
    aria-hidden="true"
  >
    <rect class="monitor-bar-track" x="0" y="0" width="100" height="6" rx="3" />
    {#if percent !== null}
      <rect
        class="monitor-bar-fill"
        x="0"
        y="0"
        width={percent}
        height="6"
        rx="3"
      />
    {/if}
  </svg>
{/snippet}

<style>
  .monitor-panel {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .monitor-header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .monitor-header h2 {
    margin: 0;
    font-size: 1.05rem;
  }

  .monitor-sub {
    margin: 0.1rem 0 0;
    color: var(--muted-foreground);
    font-size: 0.78rem;
  }

  .monitor-live {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }

  .monitor-state-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.15rem 0.65rem;
    border: 1px solid var(--border-subtle);
    border-radius: 999px;
    background: var(--secondary);
    color: var(--secondary-foreground);
    font-size: 0.8rem;
    font-weight: 600;
  }

  .monitor-state-pill::before {
    content: "";
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 999px;
    background: var(--muted-foreground);
  }

  .monitor-state-pill[data-state="generating"]::before {
    background: var(--chart-2);
  }

  .monitor-state-pill[data-state="queued"]::before {
    background: var(--chart-3);
  }

  .monitor-live-counts {
    color: var(--muted-foreground);
    font-size: 0.78rem;
    font-variant-numeric: tabular-nums;
  }

  .monitor-stale {
    margin: 0;
    padding: 0.4rem 0.6rem;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    background: var(--card);
    color: var(--chart-3);
    font-size: 0.82rem;
  }

  .monitor-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 0.75rem;
  }

  .monitor-card {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    padding: 0.75rem;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: var(--card);
    color: var(--card-foreground);
  }

  .monitor-card-wide {
    grid-column: span 2;
  }

  .monitor-card-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .monitor-card-head h3 {
    margin: 0;
    color: var(--muted-foreground);
    font-size: 0.8rem;
    font-weight: 600;
    letter-spacing: 0.02em;
  }

  .monitor-card-note {
    max-width: 62%;
    overflow: hidden;
    color: var(--muted-foreground);
    font-size: 0.68rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .monitor-big {
    margin: 0;
    font-size: 1.9rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.02em;
    line-height: 1.15;
  }

  .monitor-mid {
    margin: 0;
    font-size: 1.15rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    line-height: 1.2;
  }

  .monitor-note {
    margin: 0;
    color: var(--muted-foreground);
    font-size: 0.7rem;
  }

  .monitor-metric-line {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
    margin-top: 0.15rem;
    font-size: 0.76rem;
  }

  .monitor-metric-row {
    display: flex;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .monitor-metric-cell {
    display: flex;
    min-width: 0;
    flex-direction: column;
  }

  .monitor-metric-label {
    color: var(--muted-foreground);
    font-size: 0.7rem;
  }

  .monitor-metric-value {
    font-size: 0.78rem;
    font-variant-numeric: tabular-nums;
  }

  .monitor-bar {
    display: block;
    width: 100%;
    height: 6px;
  }

  .monitor-bar-track {
    fill: var(--secondary);
  }

  .monitor-bar-fill {
    fill: var(--chart-2);
  }

  .monitor-spark {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 0.4rem;
    margin-top: 0.1rem;
  }

  .monitor-spark-pair {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  .monitor-spark-label {
    flex: 0 0 auto;
    color: var(--muted-foreground);
    font-size: 0.66rem;
  }

  .monitor-spark-svg {
    display: block;
    width: 100%;
    min-width: 0;
    height: 26px;
  }

  .monitor-spark-line {
    stroke: var(--chart-2);
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
    vector-effect: non-scaling-stroke;
  }

  .monitor-spark-empty {
    color: var(--muted-foreground);
    font-size: 0.78rem;
  }

  .monitor-service-list {
    display: grid;
    gap: 0.35rem;
    margin: 0;
  }

  .monitor-service-row {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    font-size: 0.8rem;
  }

  .monitor-service-row dt {
    color: var(--muted-foreground);
  }

  .monitor-service-row dd {
    margin: 0;
    overflow-wrap: anywhere;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .monitor-service-badge {
    padding: 0.05rem 0.5rem;
    border: 1px solid var(--border-subtle);
    border-radius: 999px;
    font-size: 0.76rem;
  }

  .monitor-service-badge[data-status="ok"] {
    color: var(--chart-2);
  }

  .monitor-service-badge[data-status="down"] {
    color: var(--destructive);
  }

  .monitor-service-badge[data-status="disabled"] {
    color: var(--muted-foreground);
  }

  .monitor-totals,
  .monitor-requests {
    padding: 0.75rem;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: var(--card);
  }

  .monitor-totals h3,
  .monitor-requests h3 {
    margin: 0 0 0.5rem;
    font-size: 0.88rem;
  }

  .monitor-totals-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.75rem;
  }

  .monitor-stat-label {
    display: block;
    color: var(--muted-foreground);
    font-size: 0.7rem;
  }

  .monitor-stat {
    display: block;
    font-size: 1.25rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }

  .monitor-stat-sub {
    display: block;
    color: var(--muted-foreground);
    font-size: 0.68rem;
  }

  .monitor-table-wrap {
    overflow-x: auto;
  }

  .monitor-table {
    width: 100%;
    min-width: 640px;
    border-collapse: collapse;
    font-size: 0.76rem;
  }

  .monitor-table th,
  .monitor-table td {
    padding: 0.35rem 0.4rem;
    border-bottom: 1px solid var(--border-subtle);
    text-align: left;
    white-space: nowrap;
  }

  .monitor-table th {
    color: var(--muted-foreground);
    font-weight: 600;
  }

  .monitor-table tbody tr:last-child td {
    border-bottom: 0;
  }

  .monitor-num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .monitor-model {
    max-width: 14rem;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .monitor-outcome {
    font-weight: 600;
  }

  .monitor-outcome[data-outcome="completed"] {
    color: var(--chart-2);
  }

  .monitor-outcome[data-outcome="failed"],
  .monitor-outcome[data-outcome="timeout"] {
    color: var(--destructive);
  }

  .monitor-outcome[data-outcome="cancelled"] {
    color: var(--muted-foreground);
  }

  .monitor-error-code {
    display: block;
    color: var(--destructive);
    font-family: var(--font-mono);
    font-size: 0.66rem;
  }

  .monitor-empty {
    margin: 0.25rem 0;
    color: var(--muted-foreground);
  }

  @media (max-width: 1100px) {
    .monitor-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @media (max-width: 640px) {
    .monitor-grid,
    .monitor-totals-grid {
      grid-template-columns: minmax(0, 1fr);
    }

    .monitor-card-wide {
      grid-column: auto;
    }
  }
</style>
