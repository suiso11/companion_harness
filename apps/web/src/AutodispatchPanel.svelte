<script lang="ts">
// Human-only standing-policy + automatic plan/execution panel for the
// ACTUAL chat session. It never authorizes a plan, never executes source,
// and never resumes the global autonomy control: a human creates ONE
// standing policy, then the existing durable intake/runner owns planning
// and the candidate trial. Plan text is untrusted and renders as text only.
import { fetchJson, postJson, randomUuid, type ApiResult } from "./lib/api.js";
import {
  type AutodispatchStatus,
  capsLines,
  type ControlView,
  type DispatchExecution,
  type DispatchPlan,
  executionReasonText,
  executionStatusText,
  formatExpiry,
  formatInstant,
  intentText,
  narrowOperations,
  type Operation,
  operationText,
  parseAutodispatchStatus,
  parseControl,
  parseTrialDetail,
  planStatusText,
  policyStatusText,
  selectLatestCompletedUserTurn,
  type SourceAnchor,
  type StandingPolicy,
  type TrialDetail,
} from "./lib/autodispatch.js";

const SETTLED_EVENT = "ch:run-settled";
const ACTIVE_POLL_MS = 5000;
const MAX_DETAIL_LOADS = 10;

interface PendingMutation {
  readonly kind: "create" | "revoke" | "stop";
  readonly path: string;
  readonly body: unknown;
  readonly key: string | null;
  readonly label: string;
}

let { sessionId }: { sessionId: string | null } = $props();

let status = $state<AutodispatchStatus | null>(null);
let control = $state<ControlView | null>(null);
let anchor = $state<SourceAnchor | null>(null);
let disabled = $state(false);
let loading = $state(false);
let notice = $state("");
let busy = $state<string | null>(null);
let pending = $state<PendingMutation | null>(null);
let selectedOps = $state<Operation[]>([]);
let opsTouched = $state(false);
let confirmed = $state(false);
let expiryChoice = $state("none");
let details = $state<Record<string, TrialDetail | null>>({});
let visible = $state(true);

// Non-reactive generations: every session change bumps both, so a stale
// GET/POST can never paint the previous session or re-enable a dead button.
let boundSession: string | null = null;
let boundSeq = 0;
let loadSeq = 0;
let actionSeq = 0;
let detailSeq = 0;

const EXPIRY_CHOICES: readonly { value: string; label: string; ms: number | null }[] = [
  { value: "none", label: "無期限", ms: null },
  { value: "1h", label: "1時間", ms: 60 * 60 * 1000 },
  { value: "24h", label: "24時間", ms: 24 * 60 * 60 * 1000 },
  { value: "7d", label: "7日", ms: 7 * 24 * 60 * 60 * 1000 },
];

function isCurrent(sid: string, seq: number): boolean {
  return boundSession === sid && boundSeq === seq && sessionId === sid;
}

function resetForSession(): void {
  status = null;
  control = null;
  anchor = null;
  disabled = false;
  loading = false;
  notice = "";
  busy = null;
  pending = null;
  selectedOps = [];
  opsTouched = false;
  confirmed = false;
  expiryChoice = "none";
  details = {};
}

function reconcileOperations(next: AutodispatchStatus): void {
  if (!opsTouched) {
    selectedOps = [...next.operations];
    return;
  }
  selectedOps = narrowOperations(selectedOps, next.operations);
}

function activePolicies(list: readonly StandingPolicy[]): StandingPolicy[] {
  return list.filter((policy) => policy.status === "active");
}

function plansById(): Map<string, DispatchPlan> {
  const map = new Map<string, DispatchPlan>();
  for (const plan of status?.plans ?? []) map.set(plan.id, plan);
  return map;
}

function latestPlans(limit: number): DispatchPlan[] {
  return (status?.plans ?? []).slice(0, limit);
}

function executionsFor(planId: string): DispatchExecution[] {
  return (status?.executions ?? []).filter(
    (execution) => execution.planId === planId,
  );
}

async function loadDetails(
  sid: string,
  seq: number,
  executions: readonly DispatchExecution[],
): Promise<void> {
  if (!isCurrent(sid, seq)) return;
  const ids = executions
    .map((execution) => execution.executionId)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    // Refresh non-terminal detail rows: the grant is claimed/consumed after
    // the first read, so a one-shot cache would freeze the panel at "結果待ち"
    // and never show the on_ready evidence. Terminal outcomes stay cached.
    .filter((id) => !(id in details) || details[id] === null || details[id]?.outcome === null)
    .slice(0, MAX_DETAIL_LOADS);
  if (ids.length === 0) return;
  detailSeq += 1;
  const detailToken = detailSeq;
  const result = await Promise.all(
    ids.map(async (id) => {
      let response: ApiResult;
      try {
        response = await fetchJson(
          `/api/sessions/${encodeURIComponent(sid)}/trial-grants/${encodeURIComponent(id)}`,
        );
      } catch {
        response = { status: 0, body: null };
      }
      return {
        id,
        cache: response.status === 200 || response.status === 404,
        detail: response.status === 200 ? parseTrialDetail(response.body) : null,
      };
    }),
  );
  if (
    detailToken !== detailSeq ||
    !isCurrent(sid, seq)
  ) {
    return;
  }
  const next = { ...details };
  for (const entry of result) {
    if (entry.cache) next[entry.id] = entry.detail;
  }
  details = next;
}

async function load(sid: string, seq: number, withAnchor = true): Promise<void> {
  if (!isCurrent(sid, seq)) return;
  loadSeq += 1;
  const request = loadSeq;
  loading = true;
  const [listed, controlled, history] = await Promise.all([
    (async (): Promise<ApiResult> => {
      try {
        return await fetchJson(
          `/api/sessions/${encodeURIComponent(sid)}/autodispatch`,
        );
      } catch {
        return { status: 0, body: null };
      }
    })(),
    (async (): Promise<ApiResult> => {
      try {
        return await fetchJson("/api/autonomy/control");
      } catch {
        return { status: 0, body: null };
      }
    })(),
    (async (): Promise<ApiResult> => {
      if (!withAnchor) return { status: 0, body: null };
      try {
        return await fetchJson(
          `/api/sessions/${encodeURIComponent(sid)}/history?limit=50`,
        );
      } catch {
        return { status: 0, body: null };
      }
    })(),
  ]);
  if (!isCurrent(sid, seq) || request !== loadSeq) return;
  loading = false;

  if (listed.status === 404) {
    // Config is disabled on this server: hide the whole surface without a nag.
    disabled = true;
    status = null;
    anchor = null;
    control = null;
    notice = "";
    return;
  }
  if (listed.status === 200) {
    const parsed = parseAutodispatchStatus(listed.body);
    if (parsed === null) {
      status = null;
      notice = "自動実行の応答を解釈できませんでした";
    } else {
      disabled = false;
      status = parsed;
      reconcileOperations(parsed);
      void loadDetails(sid, seq, parsed.executions);
    }
  } else if (listed.status === 0) {
    notice = "自動実行の状態を取得できませんでした。更新してください";
  } else if (listed.status === 401) {
    notice = "ログインの有効期限が切れました";
  } else {
    notice = `自動実行の状態を取得できませんでした (HTTP ${listed.status})`;
  }

  if (controlled.status === 200) {
    control = parseControl(controlled.body);
  }
  if (history.status === 200) {
    anchor = selectLatestCompletedUserTurn(history.body);
  }
}

function refresh(): void {
  const sid = boundSession;
  if (sid !== null) void load(sid, boundSeq);
}

function updateOps(operation: Operation, checked: boolean): void {
  opsTouched = true;
  const next = new Set(selectedOps);
  if (checked) next.add(operation);
  else next.delete(operation);
  selectedOps = [...next];
}

function expiryIso(): string | null {
  const choice = EXPIRY_CHOICES.find((item) => item.value === expiryChoice);
  if (choice === undefined || choice.ms === null) return null;
  return new Date(Date.now() + choice.ms).toISOString();
}

async function runMutation(mutation: PendingMutation): Promise<void> {
  const sid = boundSession;
  if (sid === null || !isCurrent(sid, boundSeq) || busy !== null) return;
  actionSeq += 1;
  const token = actionSeq;
  busy = mutation.label;
  let result: ApiResult;
  try {
    result = await postJson(mutation.path, mutation.body, mutation.key);
  } catch {
    result = { status: 0, body: null };
  }
  if (actionSeq !== token || !isCurrent(sid, boundSeq)) return;
  busy = null;

  if (result.status === 0 || result.status >= 500) {
    pending = mutation;
    notice = "通信に失敗しました。自動再送はしません。同じ操作を手動で再試行できます";
    return;
  }
  pending = null;

  if (mutation.kind === "create") {
    if (result.status === 201 || result.status === 200) {
      confirmed = false;
      opsTouched = false;
      notice =
        "スタンディングポリシーを有効化しました。グローバル自律が停止中の場合は「タスク・目的」で明示的に再開するまで実行されません";
    } else if (result.status === 409) {
      notice = "同じ操作が既に処理されました。状態を更新しました";
    } else if (result.status === 401) {
      notice = "ログインの有効期限が切れました";
    } else {
      notice = `有効化に失敗しました (HTTP ${result.status})`;
    }
  } else if (mutation.kind === "revoke") {
    if (result.status === 200) {
      notice = "ポリシーを取り消しました。実行中の試行は既存の停止境界で終了します";
    } else if (result.status === 409) {
      notice = "このポリシーは既に有効ではありません。状態を更新しました";
    } else if (result.status === 401) {
      notice = "ログインの有効期限が切れました";
    } else {
      notice = `取消に失敗しました (HTTP ${result.status})`;
    }
  } else {
    if (result.status === 200) {
      const body = (result.body ?? {}) as { revoked?: unknown };
      const revoked =
        typeof body.revoked === "number" ? body.revoked : null;
      notice =
        revoked === null
          ? "停止しました。実行中の試行は既存の停止境界で終了します"
          : `停止しました（取消したポリシー: ${revoked} 件）。実行中の試行は既存の停止境界で終了します`;
    } else if (result.status === 401) {
      notice = "ログインの有効期限が切れました";
    } else {
      notice = `停止に失敗しました (HTTP ${result.status})`;
    }
  }
  await load(sid, boundSeq);
}

function enable(): void {
  const current = status;
  const source = anchor;
  if (current === null || source === null) return;
  if (selectedOps.length === 0) {
    notice = "許可する操作を1つ以上選択してください";
    return;
  }
  if (!confirmed) {
    notice = "開示された範囲と上限の確認が必要です";
    return;
  }
  const sid = boundSession;
  if (sid === null) return;
  const body = {
    statement: `会話で合意した作業を ${current.workspaceAlias} の候補として自動計画・試行する`,
    sourceTurnId: source.turnId,
    operations: selectedOps,
    caps: current.caps,
    expiresAt: expiryIso(),
  };
  void runMutation({
    kind: "create",
    path: `/api/sessions/${encodeURIComponent(sid)}/autodispatch/policies`,
    body,
    key: randomUuid(),
    label: "有効化中…",
  });
}

function revoke(policy: StandingPolicy): void {
  const sid = boundSession;
  if (sid === null) return;
  void runMutation({
    kind: "revoke",
    path: `/api/sessions/${encodeURIComponent(sid)}/autodispatch/policies/${encodeURIComponent(policy.id)}/revoke`,
    body: {},
    key: null,
    label: "取消中…",
  });
}

function stopAll(): void {
  const sid = boundSession;
  if (sid === null) return;
  void runMutation({
    kind: "stop",
    path: `/api/sessions/${encodeURIComponent(sid)}/autodispatch/stop`,
    body: {},
    key: null,
    label: "停止中…",
  });
}

function retry(): void {
  const mutation = pending;
  if (mutation === null) return;
  void runMutation(mutation);
}

// Session lifecycle + mount/unmount: reset synchronously, drop every
// in-flight GET/POST via the generation counters, then bind the new
// session. A completed run refreshes; active polling is fixed-cadence and
// only while the document is visible.
$effect(() => {
  const sid = sessionId;
  boundSeq += 1;
  const seq = boundSeq;
  boundSession = sid;
  actionSeq += 1;
  detailSeq += 1;
  resetForSession();
  if (sid === null) return;

  const onSettled = (): void => {
    void load(sid, seq);
  };
  const onVisibility = (): void => {
    visible = document.visibilityState === "visible";
    if (visible) void load(sid, seq);
  };
  visible = document.visibilityState === "visible";
  window.addEventListener(SETTLED_EVENT, onSettled);
  document.addEventListener("visibilitychange", onVisibility);
  void load(sid, seq);
  const timer = window.setInterval(() => {
    if (document.visibilityState !== "visible" || loading) return;
    void load(sid, seq, false);
  }, ACTIVE_POLL_MS);
  return () => {
    window.removeEventListener(SETTLED_EVENT, onSettled);
    document.removeEventListener("visibilitychange", onVisibility);
    window.clearInterval(timer);
    if (boundSeq === seq) boundSeq += 1;
  };
});
</script>

{#if !disabled && sessionId !== null}
  <section
    id="autodispatch-panel"
    class="feature-panel autodispatch-panel"
    aria-label="自動ディスパッチ"
    data-autodispatch-panel="true"
  >
    <div class="autodispatch-header">
      <h2>自動ディスパッチ</h2>
      <button
        id="autodispatch-refresh"
        type="button"
        onclick={refresh}
        disabled={loading}
        aria-label="自動ディスパッチの状態を更新"
      >
        {loading ? "更新中…" : "更新"}
      </button>
    </div>
    <p class="autodispatch-fixed">
      対象: <code data-autodispatch-target="true">{status?.workspaceAlias ?? "確認中…"}</code>
      ・候補のみ（ソースへの適用・本番反映・公開は行いません）
    </p>
    <p class="autodispatch-notice" role="status" aria-live="polite">{notice}</p>

    {#if status === null}
      {#if !loading && notice === ""}
        <p class="autodispatch-empty">読み込み中…</p>
      {/if}
    {:else}
      <div class="autodispatch-state" data-autodispatch-ready={status.dependencyReady ? "true" : "false"}>
        {#if control?.paused}
          <p class="autodispatch-warning" data-autodispatch-paused="true">
            グローバル自律は停止中です。ポリシーを有効化しても自動計画・実行は始まりません。再開は「タスク・目的」で明示的に行ってください。
          </p>
        {/if}
        {#if !status.dependencyReady}
          <p class="autodispatch-warning" data-autodispatch-dependencies="missing">
            依存ブリッジが未構成です。計画が確定しても自動実行はブロックされます（成功を偽装しません）。
          </p>
        {:else}
          <p class="autodispatch-ok" data-autodispatch-dependencies="ready">
            依存構成: 準備済み（ブリッジの実稼働状態は実行結果で確認します）
          </p>
        {/if}
        {#if !visible}
          <p class="autodispatch-hint">画面が非表示のため自動更新を停止しています。</p>
        {/if}
      </div>

      <section class="autodispatch-section" aria-label="スタンディングポリシー">
        <h3>スタンディングポリシー</h3>
        <p class="autodispatch-hint">
          会話の合意から自動で計画を作り、既存の試行ランナーへ渡します。計画ごとの承認操作はありません。停止は下の取消／停止だけです。
        </p>
        {#if status.policies.length === 0}
          <p class="autodispatch-empty">このセッションのポリシーはありません。</p>
        {/if}
        <ul class="autodispatch-list">
          {#each status.policies as policy (policy.id)}
            <li class="autodispatch-item" data-autodispatch-policy={policy.id}>
              <div class="autodispatch-item-head">
                <strong>{policyStatusText(policy.status)}</strong>
                <span class="autodispatch-code">v{policy.version}</span>
              </div>
              <dl class="autodispatch-meta">
                <div><dt>対象</dt><dd><code>{policy.workspaceAlias}</code></dd></div>
                <div><dt>操作</dt><dd>{policy.operations.map(operationText).join(" / ")}</dd></div>
                <div><dt>読み取り範囲</dt><dd>{policy.readScopes.join(", ")}</dd></div>
                <div><dt>書き込み候補範囲</dt><dd>{policy.writeScopes.join(", ") || "なし"}</dd></div>
                <div><dt>チェック</dt><dd>{policy.checks.join(", ")}</dd></div>
                <div><dt>上限</dt><dd>{capsLines(policy.caps).map((line) => `${line.label}: ${line.value}`).join(" / ")}</dd></div>
                <div><dt>期限</dt><dd>{formatExpiry(policy.expiresAt)}</dd></div>
                <div><dt>作成</dt><dd>{formatInstant(policy.createdAt)}</dd></div>
              </dl>
              {#if policy.status === "active"}
                <button
                  type="button"
                  data-autodispatch-revoke={policy.id}
                  disabled={busy !== null}
                  onclick={() => revoke(policy)}
                >
                  このポリシーを取消
                </button>
              {/if}
            </li>
          {/each}
        </ul>
        <button
          type="button"
          data-autodispatch-stop="true"
          disabled={busy !== null || activePolicies(status.policies).length === 0}
          onclick={stopAll}
        >
          全スタンディングポリシーを停止
        </button>
        {#if pending !== null}
          <button type="button" data-autodispatch-retry="true" disabled={busy !== null} onclick={retry}>
            同じ操作を再試行（{pending.label.replace("中…", "")}）
          </button>
        {/if}
      </section>

      {#if activePolicies(status.policies).length === 0}
        <section class="autodispatch-section" aria-label="スタンディングポリシーの有効化">
          <h3>スタンディングポリシーを有効化</h3>
          <p class="autodispatch-hint">
            実際に完了した最新のユーザーターンを根拠にします。開示された範囲と上限を確認してから有効化してください。
          </p>
          {#if anchor === null}
            <p class="autodispatch-warning" data-autodispatch-anchor="missing">
              完了したユーザーターンがないため有効化できません。会話を1往復完了してから更新してください。
            </p>
          {:else}
            <dl class="autodispatch-meta">
              <div>
                <dt>根拠のターン</dt>
                <dd data-autodispatch-anchor={anchor.turnId}>
                  <span class="autodispatch-quote">{anchor.text.length > 160 ? `${anchor.text.slice(0, 160)}…` : anchor.text}</span>
                </dd>
              </div>
              <div><dt>許可操作</dt><dd>{status.operations.map(operationText).join(" / ")}</dd></div>
              <div><dt>読み取り範囲</dt><dd>{status.readScopes.join(", ")}</dd></div>
              <div><dt>書き込み候補範囲</dt><dd>{status.writeScopes.join(", ") || "なし"}</dd></div>
              <div><dt>チェック</dt><dd>{status.checks.join(", ")}</dd></div>
              <div><dt>上限</dt><dd>{capsLines(status.caps).map((line) => `${line.label}: ${line.value}`).join(" / ")}</dd></div>
            </dl>
            <fieldset class="autodispatch-fieldset">
              <legend>許可する操作（運用者の範囲内で選択）</legend>
              {#each status.operations as operation (operation)}
                <label>
                  <input
                    type="checkbox"
                    checked={selectedOps.includes(operation)}
                    onchange={(event) => updateOps(operation, event.currentTarget.checked)}
                  />
                  {operationText(operation)}
                </label>
              {/each}
            </fieldset>
            <label class="autodispatch-expiry">
              期限
              <select bind:value={expiryChoice}>
                {#each EXPIRY_CHOICES as choice (choice.value)}
                  <option value={choice.value}>{choice.label}</option>
                {/each}
              </select>
            </label>
            <label class="autodispatch-confirm">
              <input type="checkbox" bind:checked={confirmed} />
              上記の対象・範囲・チェック・上限・期限を確認し、スタンディングポリシーを有効化します
            </label>
            <button
              type="button"
              data-autodispatch-enable="true"
              disabled={busy !== null || !confirmed || selectedOps.length === 0}
              onclick={enable}
            >
              {busy === "有効化中…" ? "有効化中…" : "有効化"}
            </button>
          {/if}
        </section>
      {/if}

      <section class="autodispatch-section" aria-label="自動計画">
        <h3>自動計画</h3>
        {#if status.plans.length === 0}
          <p class="autodispatch-empty">計画はまだありません。ポリシー有効化後の会話完了で自動生成されます。</p>
        {/if}
        <ol class="autodispatch-list">
          {#each latestPlans(10) as plan (plan.id)}
            <li class="autodispatch-item" data-autodispatch-plan={plan.id} data-autodispatch-plan-status={plan.status}>
              <div class="autodispatch-item-head">
                <strong>r{plan.revision}: {planStatusText(plan.status)}</strong>
                <span class="autodispatch-code">{operationText(plan.operation)}</span>
              </div>
              <p class="autodispatch-goal">{plan.goal}</p>
              <dl class="autodispatch-meta">
                <div><dt>意図</dt><dd>{intentText(plan.intent.kind)}（根拠: ユーザー会話）</dd></div>
                {#if plan.decisions.length > 0}
                  <div><dt>決定</dt><dd>{plan.decisions.join(" / ")}</dd></div>
                {/if}
                {#if plan.nongoals.length > 0}
                  <div><dt>非目標</dt><dd>{plan.nongoals.join(" / ")}</dd></div>
                {/if}
                {#if plan.steps.length > 0}
                  <div><dt>手順</dt><dd>{plan.steps.join(" / ")}</dd></div>
                {/if}
                {#if plan.acceptance.length > 0}
                  <div><dt>受け入れ条件</dt><dd>{plan.acceptance.join(" / ")}</dd></div>
                {/if}
                {#if plan.missing.length > 0}
                  <div><dt>未解決</dt><dd data-autodispatch-missing="true">{plan.missing.join(" / ")}</dd></div>
                {/if}
                <div><dt>候補パス</dt><dd>{plan.relevantPaths.join(", ")}</dd></div>
                <div><dt>作成</dt><dd>{formatInstant(plan.createdAt)}</dd></div>
              </dl>
              {#if plan.status === "frozen" && !status.dependencyReady}
                <p class="autodispatch-warning">依存未構成のため、この計画は実行に進みません。</p>
              {:else if plan.status === "needs_decision"}
                <p class="autodispatch-warning">未解決の判断があります。会話で決めてから次の完了を待ってください。</p>
              {:else if plan.status === "discuss"}
                <p class="autodispatch-hint">相談として扱われ、実行は生成されません。</p>
              {:else if plan.status === "blocked"}
                <p class="autodispatch-warning">ブロックされています。原因は実行一覧を確認してください。</p>
              {/if}
              {#if executionsFor(plan.id).length > 0}
                <p class="autodispatch-hint">
                  この計画の実行: {executionsFor(plan.id).map((execution) => `${executionStatusText(execution.status)}${execution.reason === null ? "" : `（${executionReasonText(execution.reason)}）`}`).join(" / ")}
                </p>
              {/if}
            </li>
          {/each}
        </ol>
      </section>

      <section class="autodispatch-section" aria-label="実行と結果">
        <h3>実行と結果（候補のみ）</h3>
        {#if status.executions.length === 0}
          <p class="autodispatch-empty">実行はまだありません。</p>
        {/if}
        <ul class="autodispatch-list">
          {#each status.executions.slice(0, 10) as execution (execution.id)}
            {@const plan = plansById().get(execution.planId)}
            {@const detail = execution.executionId === null ? null : (details[execution.executionId] ?? null)}
            <li class="autodispatch-item" data-autodispatch-execution={execution.id} data-autodispatch-execution-status={execution.status}>
              <div class="autodispatch-item-head">
                <strong>{executionStatusText(execution.status)}</strong>
                <span class="autodispatch-code">{plan === undefined ? "" : `計画 r${plan.revision}`}</span>
              </div>
              <dl class="autodispatch-meta">
                <div><dt>原因</dt><dd>{executionReasonText(execution.reason)}</dd></div>
                <div><dt>作成</dt><dd>{formatInstant(execution.createdAt)}</dd></div>
                {#if detail !== null}
                  <div><dt>試行状態</dt><dd>{detail.grantStatus}{detail.cancelRequested ? "（停止要求済み）" : ""}</dd></div>
                  <div><dt>モード</dt><dd>{detail.mode === "write" ? "書き込み候補（ホスト未適用）" : detail.mode === "read_only" ? "読み取りのみ" : "不明"}</dd></div>
                  <div>
                    <dt>チェック</dt>
                    <dd data-autodispatch-checks="true">
                      {detail.requiredChecks.join(", ") || "—"}
                      {#if detail.outcome !== null}
                        {#if detail.outcome.authorized && detail.outcome.succeeded && detail.requiredChecks.length > 0}
                          ／ 固定チェック合格（実行内容の保証ではありません）
                        {:else}
                          ／ 未検証または失敗
                        {/if}
                      {/if}
                    </dd>
                  </div>
                  <div><dt>結果</dt><dd data-autodispatch-outcome="true">{detail.outcome === null ? "結果待ち" : detail.outcome.detail}</dd></div>
                  <div>
                    <dt>候補成果物</dt>
                    <dd data-autodispatch-candidate="true">
                      {detail.mode === "write" ? "書き込み候補（ソースへ適用していません）" : "読み取り候補（ソース変更なし）"}
                      ／ 候補パス: {detail.relevantPaths.join(", ") || "—"}
                      ／ 成果物本文はこのAPIでは公開されません
                    </dd>
                  </div>
                {:else if execution.executionId !== null}
                  <div><dt>試行詳細</dt><dd>取得できませんでした（未実行または試行機能が無効）</dd></div>
                {/if}
              </dl>
            </li>
          {/each}
        </ul>
        <p class="autodispatch-hint">
          チェック合格は固定ホストチェックの結果で、worker の完了や実行内容を保証しません。worker の状態はゲスト自己申告（未検証）で、ホストの証明ではありません。
        </p>
      </section>
    {/if}
  </section>
{/if}

<style>
  .autodispatch-panel {
    max-height: 52vh;
    overflow-y: auto;
    box-sizing: border-box;
  }
  .autodispatch-header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .autodispatch-header h2 {
    margin: 0;
  }
  .autodispatch-fixed {
    margin: 0.35rem 0;
    color: var(--muted-foreground);
    font-size: 0.82rem;
  }
  .autodispatch-fixed code {
    overflow-wrap: anywhere;
  }
  .autodispatch-notice,
  .autodispatch-hint,
  .autodispatch-empty {
    margin: 0.3rem 0;
    color: var(--muted-foreground);
    min-height: 1.2em;
  }
  .autodispatch-warning {
    margin: 0.35rem 0;
    padding: 0.35rem 0.5rem;
    border-left: 3px solid var(--destructive, #f87171);
    background: color-mix(in srgb, var(--destructive, #f87171) 10%, transparent);
  }
  .autodispatch-ok {
    margin: 0.35rem 0;
    color: var(--muted-foreground);
  }
  .autodispatch-section {
    margin-top: 0.75rem;
    border-top: 1px solid var(--border-subtle);
    padding-top: 0.5rem;
  }
  .autodispatch-section h3 {
    margin: 0 0 0.35rem;
    font-size: 0.92rem;
  }
  .autodispatch-list {
    list-style: none;
    margin: 0.5rem 0;
    padding: 0;
    display: grid;
    gap: 0.6rem;
  }
  .autodispatch-item {
    border: 1px solid var(--border-subtle);
    border-radius: 0.5rem;
    padding: 0.55rem 0.7rem;
  }
  .autodispatch-item-head {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .autodispatch-code {
    color: var(--muted-foreground);
    font-size: 0.78rem;
  }
  .autodispatch-goal {
    margin: 0.35rem 0;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .autodispatch-meta {
    display: grid;
    gap: 0.3rem;
    margin: 0.4rem 0;
  }
  .autodispatch-meta div {
    display: grid;
    grid-template-columns: 7.5rem minmax(0, 1fr);
    gap: 0.5rem;
    align-items: start;
  }
  .autodispatch-meta dt {
    color: var(--muted-foreground);
    font-size: 0.78rem;
  }
  .autodispatch-meta dd {
    margin: 0;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .autodispatch-quote {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .autodispatch-fieldset {
    margin: 0.4rem 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 1rem;
    border: 1px solid var(--border-subtle);
    border-radius: 0.4rem;
    padding: 0.4rem 0.6rem;
  }
  .autodispatch-fieldset label,
  .autodispatch-confirm,
  .autodispatch-expiry {
    display: flex;
    gap: 0.4rem;
    align-items: center;
    flex-wrap: wrap;
    font-size: 0.85rem;
  }
  .autodispatch-confirm {
    margin: 0.5rem 0;
    align-items: flex-start;
  }
  .autodispatch-confirm input {
    margin-top: 0.2rem;
  }
  .autodispatch-item button,
  .autodispatch-section > button {
    margin-top: 0.35rem;
  }
  @media (max-width: 480px) {
    .autodispatch-panel {
      max-height: 60vh;
      margin: 0.5rem 0.75rem;
    }
    .autodispatch-meta div {
      grid-template-columns: minmax(0, 1fr);
      gap: 0.1rem;
    }
  }
</style>
