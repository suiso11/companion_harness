<script lang="ts">
// Read-only "学習の動き" section on the memory page.
//
// It reads the two background-activity endpoints plus the read-only
// conversation-learning proposal list. Nothing here mutates state, and the
// table/API only ever carry fixed numeric maintenance counts (no memory
// bodies or model text). Auto-refresh runs every 30s while the document is
// visible.
import { onMount } from "svelte";
import { fetchJson } from "./lib/api.js";
import {
  type ActivityRun,
  type ActivitySummary,
  barPercent,
  dailyActivity,
  formatActivityTime,
  formatRunCounts,
  type LearningProposal,
  latestLabel,
  type MemoryMaintenanceOp,
  opLabel,
  parseActivityList,
  parseActivitySummary,
  parseLearningProposals,
  proposalKindLabel,
  resultLabel,
  statusLabel,
  summaryCards,
} from "./lib/memory_activity.js";

const REFRESH_MS = 30_000;

let summary = $state<ActivitySummary | null>(null);
let runs = $state<ActivityRun[]>([]);
let proposals = $state<LearningProposal[]>([]);
let status = $state("読み込み中");
let proposalsStatus = $state("読み込み中");
let loading = $state(false);
let proposalsDisabled = $state(false);
let lastLoadedAt = $state<number | null>(null);
let seq = 0;

let cards = $derived(summary === null ? [] : summaryCards(summary));
let daily = $derived(
  summary === null ? [] : dailyActivity(runs, summary.generatedAt),
);
const LATEST_OPS: readonly MemoryMaintenanceOp[] = [
  "maintain.consolidate",
  "maintain.associate",
  "maintain.activation",
  "topic.backfill",
  "maintain.distill",
];
let latestTimes = $derived(
  summary === null
    ? []
    : LATEST_OPS.map((op) => ({
        op,
        value: latestLabel(summary as ActivitySummary, op),
      })),
);

async function loadActivity(): Promise<void> {
  if (loading) return;
  loading = true;
  seq += 1;
  const current = seq;
  try {
    const [summaryRes, runsRes] = await Promise.all([
      fetchJson("/api/memory/activity/summary"),
      fetchJson("/api/memory/activity?limit=50"),
    ]);
    if (current !== seq) return;
    const nextSummary =
      summaryRes.status === 200 ? parseActivitySummary(summaryRes.body) : null;
    const nextRuns =
      runsRes.status === 200 ? parseActivityList(runsRes.body) : null;
    if (nextSummary === null || nextRuns === null) {
      status = "error: 学習の動きを取得できませんでした";
      return;
    }
    summary = nextSummary;
    runs = nextRuns.items;
    lastLoadedAt = Date.now();
    status = "";
  } catch {
    if (current === seq) {
      status = "error: 学習の動きを取得できませんでした";
    }
  } finally {
    if (current === seq) loading = false;
  }
}

async function loadProposals(): Promise<void> {
  try {
    const res = await fetchJson("/api/learning/proposals?limit=50");
    if (res.status === 404) {
      proposalsDisabled = true;
      proposals = [];
      proposalsStatus = "学習データは無効です";
      return;
    }
    const parsed = res.status === 200 ? parseLearningProposals(res.body) : null;
    if (parsed === null) {
      proposalsStatus = "error: 学習候補を取得できませんでした";
      return;
    }
    proposalsDisabled = false;
    proposals = parsed;
    proposalsStatus = parsed.length === 0 ? "学習候補はありません" : "";
  } catch {
    proposalsStatus = "error: 学習候補を取得できませんでした";
  }
}

function refresh(): void {
  if (
    typeof document !== "undefined" &&
    document.visibilityState !== "visible"
  ) {
    return;
  }
  void loadActivity();
  void loadProposals();
}

onMount(() => {
  void loadActivity();
  void loadProposals();
  const timer = window.setInterval(refresh, REFRESH_MS);
  const onVisibility = (): void => {
    if (document.visibilityState === "visible") {
      refresh();
    }
  };
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisibility);
  };
});
</script>

<section id="memory-activity" aria-label="学習の動き">
  <div class="activity-head">
    <h3>学習の動き</h3>
    <button type="button" onclick={() => refresh()} disabled={loading}>
      更新
    </button>
  </div>
  <p class="activity-lead">
    バックグラウンドの記憶学習（統合・関連付け・重要度・トピック付与）の実行履歴です。保存されるのは件数のみです。
  </p>
  {#if status.length > 0}
    <p class="activity-notice" role="status">{status}</p>
  {/if}

  {#if summary !== null}
    <h4>直近24時間</h4>
    <div class="activity-cards">
      {#each cards as card (card.key)}
        <div class="activity-card">
          <span class="activity-card-label">{card.label}</span>
          <strong class="activity-card-value">{card.value}</strong>
          <span class="activity-card-detail">{card.detail}</span>
        </div>
      {/each}
    </div>

    <div class="activity-chart-wrap">
      <div class="activity-chart" role="img" aria-label="直近7日の実行回数">
        {#each daily as bucket (bucket.label)}
          <div class="activity-bar-column">
            <span
              class="activity-bar"
              style={`height: ${Math.max(barPercent(bucket.count, daily), bucket.count > 0 ? 8 : 2)}%`}
              title={`${bucket.label}: ${bucket.count}回`}
            ></span>
            <span class="activity-bar-label">{bucket.label}</span>
          </div>
        {/each}
      </div>
      <p class="activity-latest">
        {#each latestTimes as entry (entry.op)}
          <span>{opLabel(entry.op)}: {entry.value}</span>
        {/each}
      </p>
      {#if lastLoadedAt !== null}
        <p class="activity-updated">
          最終更新 {formatActivityTime(lastLoadedAt)}（30秒ごとに自動更新）
        </p>
      {/if}
    </div>

    <h4>実行履歴</h4>
    <div class="activity-table-wrap">
      <table id="memory-activity-runs">
        <thead>
          <tr><th>時刻</th><th>処理</th><th>件数</th><th>結果</th></tr>
        </thead>
        <tbody>
          {#each runs as run (run.id)}
            <tr class:activity-failed={!run.ok}>
              <td>{formatActivityTime(run.finishedAt)}</td>
              <td>{opLabel(run.op)}</td>
              <td class="activity-counts">{formatRunCounts(run)}</td>
              <td>{resultLabel(run)}</td>
            </tr>
          {:else}
            <tr><td colspan="4">まだ実行履歴がありません</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  <h4>学習候補</h4>
  {#if proposalsStatus.length > 0}
    <p class="activity-notice" role="status">{proposalsStatus}</p>
  {/if}
  {#if !proposalsDisabled && proposals.length > 0}
    <ul id="memory-learning-proposals" class="learning-proposals">
      {#each proposals as proposal (proposal.id)}
        <li>
          <div class="proposal-head">
            <span class="proposal-kind">{proposalKindLabel(proposal.kind)}</span>
            <span
              class="proposal-status proposal-status--{proposal.status}"
            >{statusLabel(proposal.status)}</span>
            <span class="proposal-time">{formatActivityTime(proposal.createdAt)}</span>
          </div>
          <p class="proposal-lesson">{proposal.lesson}</p>
          {#if proposal.applicability.length > 0}
            <p class="proposal-meta">適用条件: {proposal.applicability}</p>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  #memory-activity {
    margin-top: 1rem;
    border-top: 1px solid var(--border, #333);
    padding-top: 0.75rem;
  }
  .activity-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .activity-head h3 {
    margin: 0;
  }
  .activity-lead,
  .activity-updated,
  .activity-notice {
    color: var(--muted, #aaa);
    font-size: 0.85rem;
  }
  .activity-cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(7.5rem, 1fr));
    gap: 0.5rem;
  }
  .activity-card {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    border: 1px solid var(--border, #333);
    border-radius: 0.5rem;
    padding: 0.5rem 0.65rem;
  }
  .activity-card-label {
    font-size: 0.8rem;
    color: var(--muted, #aaa);
  }
  .activity-card-value {
    font-size: 1.4rem;
    line-height: 1.1;
  }
  .activity-card-detail {
    font-size: 0.7rem;
    color: var(--muted, #aaa);
  }
  .activity-chart-wrap {
    margin: 0.75rem 0;
  }
  .activity-chart {
    display: flex;
    align-items: flex-end;
    gap: 0.35rem;
    height: 4rem;
  }
  .activity-bar-column {
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    align-items: center;
    flex: 1;
    height: 100%;
    gap: 0.15rem;
  }
  .activity-bar {
    display: block;
    width: 100%;
    min-height: 2px;
    border-radius: 0.2rem 0.2rem 0 0;
    background: var(--accent, #7aa2f7);
  }
  .activity-bar-label {
    font-size: 0.6rem;
    color: var(--muted, #aaa);
    white-space: nowrap;
  }
  .activity-latest {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem 0.9rem;
    font-size: 0.75rem;
    color: var(--muted, #aaa);
  }
  .activity-table-wrap {
    overflow-x: auto;
  }
  #memory-activity-runs {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8rem;
  }
  #memory-activity-runs th,
  #memory-activity-runs td {
    text-align: left;
    padding: 0.3rem 0.4rem;
    border-bottom: 1px solid var(--border, #333);
    vertical-align: top;
  }
  #memory-activity-runs th {
    color: var(--muted, #aaa);
    font-weight: 500;
  }
  .activity-counts {
    font-variant-numeric: tabular-nums;
  }
  .activity-failed td {
    color: #f7768e;
  }
  .learning-proposals {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .learning-proposals li {
    border: 1px solid var(--border, #333);
    border-radius: 0.5rem;
    padding: 0.5rem 0.65rem;
  }
  .proposal-head {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    font-size: 0.75rem;
  }
  .proposal-kind,
  .proposal-time {
    color: var(--muted, #aaa);
  }
  .proposal-status {
    border-radius: 999px;
    padding: 0.05rem 0.45rem;
    font-size: 0.7rem;
    border: 1px solid currentColor;
  }
  .proposal-status--pending {
    color: #e0af68;
  }
  .proposal-status--approved {
    color: #9ece6a;
  }
  .proposal-status--rejected {
    color: #f7768e;
  }
  .proposal-lesson {
    margin: 0.35rem 0 0.2rem;
  }
  .proposal-meta {
    margin: 0;
    font-size: 0.75rem;
    color: var(--muted, #aaa);
  }
</style>
