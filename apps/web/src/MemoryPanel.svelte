<script lang="ts">
// PR-5 native memory page (first non-chat surface).
//
// Same public API + DOM test ids as the legacy panel
// (`apps/server/src/ui/client.ts` searchMemories/openMemoryDetail/
// stageMemoryMutation): explicit search binds an opaque mN handle to its
// (sessionId, searchId, runId) scope, detail compares the immutable cited
// snapshot with the live record, and correct/retire/reactivate stage a
// keyed operation that is polled to its durable ack. The chat shell still
// provides the conversation/composer (the memory e2e cultivates a fact
// there before searching).
import { GraphCanvas, parseGraphData } from "../../server/src/ui/graph.js";
import { errorCode, fetchJson, postJson, randomUuid } from "./lib/api.js";
import { getSessionId } from "./lib/session.svelte.js";

const POLL_INTERVAL_MS = 500;
const POLL_ATTEMPTS = 90;

interface Hit {
  handle: string;
  snippet: string;
  status: "active" | "retired";
}

interface Scope {
  readonly sessionId: string;
  readonly searchId: string;
  readonly runId: string;
}

interface Selected {
  readonly searchId: string;
  readonly handle: string;
}

type MutationKind = "record.correct" | "record.retire" | "record.reactivate";

let query = $state("");
let hits = $state<Hit[]>([]);
let detailVisible = $state(false);
let detailBody = $state("");
let correctText = $state("");
let opStatus = $state("");
let searchId = $state<string | null>(null);
let operation = $state<string | null>(null);
let selected = $state<Selected | null>(null);
let actionsDisabled = $state(true);
let searching = $state(false);
let mutating = $state(false);
let retryVisible = $state(false);
let notice = $state("");
let memoryDisabled = $state(false);

// Read-only graph view (same opaque-handle projection as the legacy panel).
type GraphScope = Scope & {
  readonly scope: "global" | "local";
  readonly center: string | null;
};
let view = $state<"list" | "graph">("list");
let graphStatus = $state("");
let graphRetired = $state(false);
let graphDepth = $state("1");
let graphScope = $state<GraphScope | null>(null);
let graphSelected = $state<string | null>(null);
let graphLoading = $state(false);
let graphCanvasEl = $state<SVGSVGElement | null>(null);
let canvas: GraphCanvas | null = null;
let graphSeq = 0;
/** The explicit list-search scope (kept separate from the graph snapshot). */
let listScope: Scope | null = null;

// Non-reactive generation state: awaited responses apply only while their
// own generation/session/target is still current (no stale overwrite).
let scope: Scope | null = null;
let pending: { key: string; body: Record<string, unknown> } | null = null;
let searchSeq = 0;
let detailSeq = 0;
let opSeq = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function failSearch(statusText: string, message: string): void {
  selected = null;
  detailVisible = false;
  actionsDisabled = true;
  retryVisible = false;
  opStatus = statusText;
  notice = message;
}

/**
 * Latest owned run for the session. The memory API requires the originating
 * runId; the chat page persists completed runs in history, so the newest
 * chronological turn with a selected run is the exact binding the legacy
 * client used (`activeRunId ?? latestRenderedRunId`).
 */
async function latestRunId(sessionId: string): Promise<string | null> {
  const res = await fetchJson(
    `/api/sessions/${encodeURIComponent(sessionId)}/history?limit=50`,
  );
  if (res.status !== 200) return null;
  const items = (res.body as { items?: unknown }).items;
  if (!Array.isArray(items)) return null;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i] as {
      selectedRun?: { runId?: unknown } | null;
    } | null;
    const runId = item?.selectedRun?.runId;
    if (typeof runId === "string" && runId.length > 0) return runId;
  }
  return null;
}

async function search(): Promise<void> {
  if (searching) return;
  const text = query.trim();
  if (text.length === 0) {
    notice = "検索語を入力してください";
    return;
  }
  if (memoryDisabled) {
    notice = "記憶は無効です";
    return;
  }
  const sessionId = getSessionId();
  if (sessionId === null) {
    failSearch("error: セッションがありません", "セッションを準備しています");
    return;
  }
  searchSeq += 1;
  const seq = searchSeq;
  // Synchronous invalidation before the first await: a prior result/selection
  // (and its draft) can never stay actionable or countable for the new query.
  selected = null;
  scope = null;
  hits = [];
  searchId = null;
  operation = null;
  detailBody = "";
  detailVisible = false;
  correctText = "";
  retryVisible = false;
  actionsDisabled = true;
  opStatus = "searching: 検索中";
  notice = "";
  searching = true;
  try {
    const runId = await latestRunId(sessionId);
    if (seq !== searchSeq) return;
    if (runId === null) {
      failSearch(
        "error: Run がありません",
        "メッセージを送信して Run を作ってから検索してください",
      );
      return;
    }
    const res = await postJson(
      `/api/sessions/${encodeURIComponent(sessionId)}/memory/search`,
      { query: text, limit: 5, runId },
      null,
    );
    if (seq !== searchSeq) return;
    if (res.status === 404) {
      const code = (res.body as { error?: { code?: unknown } }).error?.code;
      if (code === "memory_unavailable") {
        memoryDisabled = true;
        failSearch("error: 記憶は無効です", "記憶は無効です");
        return;
      }
      failSearch("error: 検索に失敗しました", "記憶の検索に失敗しました");
      return;
    }
    if (res.status !== 200) {
      failSearch("error: 検索に失敗しました", "記憶の検索に失敗しました");
      return;
    }
    const body = res.body as { searchId?: unknown; hits?: unknown };
    if (typeof body.searchId !== "string" || !Array.isArray(body.hits)) {
      failSearch("error: 検索に失敗しました", "記憶の検索に失敗しました");
      return;
    }
    const fresh: Hit[] = [];
    for (const raw of body.hits as Array<{
      handle?: unknown;
      snippet?: unknown;
      status?: unknown;
    }>) {
      if (
        typeof raw.handle !== "string" ||
        !/^m[1-9][0-9]*$/.test(raw.handle) ||
        typeof raw.snippet !== "string" ||
        (raw.status !== "active" && raw.status !== "retired")
      ) {
        continue;
      }
      fresh.push({
        handle: raw.handle,
        snippet: raw.snippet,
        status: raw.status,
      });
    }
    scope = { sessionId, searchId: body.searchId, runId };
    listScope = scope;
    searchId = body.searchId;
    hits = fresh;
    opStatus = "";
    // A bare search result stays non-actionable until a fresh detail is read.
    actionsDisabled = true;
  } finally {
    if (seq === searchSeq) searching = false;
  }
}

/** Switch between the existing result list and the read-only graph. */
function switchView(next: "list" | "graph"): void {
  view = next;
  if (next === "graph") {
    canvas?.setSearchQuery(query);
    if (graphScope === null) void loadGraph("global");
  } else {
    canvas?.setSearchQuery("");
  }
}

/** In graph view the search box highlights labels; it never calls search. */
function applyGraphSearch(): void {
  canvas?.setSearchQuery(query);
}

/**
 * Fetch the read-only global/local graph. Reads never heat memory and never
 * stage a mutation; generation + session guards make an older response
 * harmless, and a 503 graph-unavailable response leaves the list usable.
 */
async function loadGraph(kind: "global" | "local"): Promise<void> {
  const sessionId = getSessionId();
  if (sessionId === null) return;
  graphSeq += 1;
  const seq = graphSeq;
  const current = (): boolean =>
    seq === graphSeq && getSessionId() === sessionId;
  graphLoading = true;
  graphStatus = "読み込み中";
  try {
    const runId = await latestRunId(sessionId);
    if (!current()) return;
    if (runId === null) {
      graphStatus = "メッセージを送信して Run を作ってから表示してください";
      return;
    }
    let handle: string | null = null;
    let localSearchId: string | null = null;
    if (kind === "local") {
      if (graphSelected !== null && graphScope !== null) {
        handle = graphSelected;
        localSearchId = graphScope.searchId;
      } else if (selected !== null && scope !== null) {
        handle = selected.handle;
        localSearchId = scope.searchId;
      }
      if (handle === null || localSearchId === null) {
        graphStatus = "ノードを選択してください";
        return;
      }
    }
    let path = `/api/sessions/${encodeURIComponent(sessionId)}/memory/graph`;
    if (kind === "local" && handle !== null && localSearchId !== null) {
      const params = new URLSearchParams({
        searchId: localSearchId,
        handle,
        depth: graphDepth === "2" ? "2" : "1",
        runId,
      });
      path = `${path}/local?${params.toString()}`;
    } else {
      const params = new URLSearchParams({
        includeRetired: graphRetired ? "true" : "false",
        runId,
      });
      path = `${path}?${params.toString()}`;
    }
    const res = await fetchJson(path);
    if (!current()) return;
    const code = errorCode(res.body);
    if (res.status === 404 && code === "memory_unavailable") {
      memoryDisabled = true;
      graphStatus = "error: 記憶は無効です";
      notice = "記憶は無効です";
      return;
    }
    if (res.status === 503 && code === "memory_graph_unavailable") {
      graphStatus = "グラフ機能は記憶サーバーの更新後に利用できます";
      notice = "グラフ機能は記憶サーバーの更新後に利用できます";
      return;
    }
    if (res.status !== 200) {
      graphStatus = "error: グラフの取得に失敗しました";
      notice = "記憶グラフの取得に失敗しました";
      return;
    }
    const data = parseGraphData(res.body);
    if (data === null) {
      graphStatus = "error: グラフの取得に失敗しました";
      notice = "記憶グラフの取得に失敗しました";
      return;
    }
    const previous = graphScope;
    graphScope = {
      sessionId,
      searchId: data.searchId,
      runId,
      scope: data.scope,
      center: data.center,
    };
    // A mutation refetch can mint a new snapshot searchId: keep the current
    // detail actionable by moving its binding to the fresh snapshot.
    if (previous !== null && scope?.searchId === previous.searchId) {
      scope = { sessionId, searchId: data.searchId, runId };
    }
    if (
      graphSelected !== null &&
      !data.nodes.some((node) => node.handle === graphSelected)
    ) {
      graphSelected = null;
    }
    canvas?.setGraph(data, { selected: graphSelected, query });
    if (data.nodes.length === 0) {
      graphStatus = "記憶がありません";
    } else if (data.truncated) {
      graphStatus = "一部のみ表示（上限）";
    } else {
      graphStatus = "";
    }
  } finally {
    if (current()) graphLoading = false;
  }
}

/** Graph node click: select it and open the existing bound detail flow. */
async function activateGraphNode(handle: string): Promise<void> {
  const target = graphScope;
  if (target === null) return;
  graphSelected = handle;
  canvas?.setSelected(handle);
  await openDetail(target.searchId, handle);
}

/** Refresh the visible graph after an acked mutation (version-cached). */
function refreshGraphAfterMutation(): void {
  if (view !== "graph" || graphScope === null) return;
  void loadGraph(graphScope.scope);
}

$effect(() => {
  const element = graphCanvasEl;
  if (element === null || canvas !== null) return;
  canvas = new GraphCanvas(element, {
    onNodeActivate: (handle) => {
      void activateGraphNode(handle);
    },
    onSelectionChange: (handle) => {
      graphSelected = handle;
    },
  });
  return () => {
    canvas?.destroy();
    canvas = null;
  };
});

$effect(() => {
  const text = query;
  if (view === "graph") canvas?.setSearchQuery(text);
});

async function openDetail(target: string, handle: string): Promise<void> {
  // A detail can belong to the explicit list search or the graph snapshot
  // (its own session-bound searchId); only a matching authoritative scope
  // is bound, so a stale searchId still fails closed.
  const resolved =
    scope?.searchId === target
      ? scope
      : listScope?.searchId === target
        ? listScope
        : graphScope?.searchId === target
          ? graphScope
          : null;
  if (resolved === null) {
    notice = "古い検索結果です。再検索してください";
    return;
  }
  // Session switch guard: the old search's scope must never render its
  // detail inside the new session's UI.
  if (resolved.sessionId !== getSessionId()) {
    notice = "セッションが変わりました。再検索してください";
    return;
  }
  scope = resolved;
  const sessionId = resolved.sessionId;
  detailSeq += 1;
  const seq = detailSeq;
  actionsDisabled = true;
  const res = await fetchJson(
    `/api/sessions/${encodeURIComponent(sessionId)}/memory/searches/${encodeURIComponent(target)}/items/${encodeURIComponent(handle)}`,
  );
  if (seq !== detailSeq || scope?.searchId !== target) return;
  if (res.status === 404) {
    const code = (res.body as { error?: { code?: unknown } }).error?.code;
    if (code === "memory_unavailable") {
      memoryDisabled = true;
      selected = null;
      detailVisible = false;
      failSearch("error: 記憶は無効です", "記憶は無効です");
      return;
    }
    selected = null;
    detailVisible = false;
    failSearch(
      "error: 対象が見つかりません",
      "対象が見つかりません。再検索してください",
    );
    return;
  }
  if (res.status !== 200) {
    selected = null;
    detailVisible = false;
    failSearch(
      "error: 詳細の取得に失敗しました",
      "記憶の詳細取得に失敗しました",
    );
    return;
  }
  const body = res.body as {
    snapshot?: { snippet?: unknown; status?: unknown };
    current?: {
      body?: unknown;
      kind?: unknown;
      status?: unknown;
      revision?: unknown;
      source?: unknown;
    };
    stale?: unknown;
  };
  const snapshotSnippet =
    typeof body.snapshot?.snippet === "string" ? body.snapshot.snippet : "";
  const snapshotStatus =
    body.snapshot?.status === "retired" ? "retired" : "active";
  const currentBody =
    typeof body.current?.body === "string" ? body.current.body : "";
  const currentStatus =
    typeof body.current?.status === "string" ? body.current.status : "";
  const currentRevision =
    typeof body.current?.revision === "number" ? body.current.revision : 0;
  const currentKind =
    typeof body.current?.kind === "string" ? body.current.kind : "";
  const currentSource =
    typeof body.current?.source === "string" ? body.current.source : "";
  const stale = body.stale === true;
  // A draft typed for another target never carries over.
  if (
    selected === null ||
    selected.searchId !== target ||
    selected.handle !== handle
  ) {
    correctText = "";
  }
  selected = { searchId: target, handle };
  if (graphScope?.searchId === target) {
    graphSelected = handle;
    canvas?.setSelected(handle);
  }
  detailVisible = true;
  detailBody =
    `引用スナップショット ${handle} [${snapshotStatus}]\n${snapshotSnippet}\n---\n` +
    `現在 [${currentStatus} rev.${currentRevision} ${currentKind} ${currentSource}]\n${currentBody}` +
    (stale ? "\n---\n状態が変わっています。再検索してください" : "");
  opStatus = stale ? "stale: 引用時から状態が変化" : "";
  actionsDisabled = stale;
}

function currentOp(
  sessionId: string,
  seq: number,
  target: Selected | null,
): boolean {
  if (opSeq !== seq || getSessionId() !== sessionId) return false;
  if (target !== null && selected !== null) {
    if (
      selected.searchId !== target.searchId ||
      selected.handle !== target.handle
    ) {
      return false;
    }
  }
  return true;
}

async function pollOperation(
  sessionId: string,
  operationId: string,
  seq: number,
  target: Selected | null,
): Promise<void> {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    await sleep(POLL_INTERVAL_MS);
    if (!currentOp(sessionId, seq, target)) return;
    const res = await fetchJson(
      `/api/sessions/${encodeURIComponent(sessionId)}/memory/operations/${encodeURIComponent(operationId)}`,
    );
    if (!currentOp(sessionId, seq, target)) return;
    if (res.status !== 200) continue;
    const status = (res.body as { status?: unknown }).status;
    if (status === "acked") {
      opStatus = "acked: 適用済み";
      operation = operationId;
      refreshGraphAfterMutation();
      return;
    }
    if (status === "failed") {
      pending = null;
      retryVisible = false;
      opStatus = "error: 失敗しました (再検索してください)";
      operation = operationId;
      notice = "記憶の更新に失敗しました。再検索してください";
      return;
    }
  }
  // Still pending at the poll bound: keep it visibly pending with its id.
  if (currentOp(sessionId, seq, target)) {
    retryVisible = false;
    opStatus = "queued: 適用待ち (確認中)";
    operation = operationId;
  }
}

async function postMutation(
  sessionId: string,
  key: string,
  payload: Record<string, unknown>,
  seq: number,
  target: Selected | null,
): Promise<void> {
  const res = await postJson(
    `/api/sessions/${encodeURIComponent(sessionId)}/memory/mutations`,
    payload,
    key,
  );
  if (!currentOp(sessionId, seq, target)) return;
  if (res.status === 202) {
    const body = res.body as {
      operationId?: unknown;
      status?: unknown;
    };
    if (typeof body.operationId !== "string") {
      retryVisible = true;
      opStatus = "error: 失敗しました (再送できます)";
      operation = "failed";
      notice = "記憶の更新受付に失敗しました";
      return;
    }
    const operationId = body.operationId;
    retryVisible = false;
    if (body.status === "acked") {
      opStatus = "acked: 適用済み";
      operation = operationId;
      refreshGraphAfterMutation();
      return;
    }
    if (body.status === "failed") {
      pending = null;
      opStatus = "error: 失敗しました (再検索してください)";
      operation = operationId;
      notice = "記憶の更新に失敗しました。再検索してください";
      return;
    }
    opStatus = "queued: 適用待ち";
    operation = operationId;
    await pollOperation(sessionId, operationId, seq, target);
    return;
  }
  const code = (res.body as { error?: { code?: unknown } }).error?.code;
  if (res.status === 409 && code === "idempotency_key_reused") {
    retryVisible = true;
    opStatus = "queued: 送信済み (再送できます)";
    operation = "pending";
    notice = "既に送信済みです";
    return;
  }
  if (res.status === 409 && code === "needs_clarification") {
    opStatus = "対象を一つに絞ってください";
    operation = "failed";
    notice = "対象を一つに絞ってください";
    return;
  }
  if (code === "target_not_found") {
    selected = null;
    detailVisible = false;
    actionsDisabled = true;
    opStatus = "対象が見つかりません";
    operation = "failed";
    notice = "対象が見つかりません。再検索してください";
    return;
  }
  if (code === "state_conflict") {
    selected = null;
    detailVisible = false;
    actionsDisabled = true;
    opStatus = "error: 状態が変わりました";
    operation = "failed";
    notice = "状態が変わりました。再検索してください";
    return;
  }
  if (code === "memory_unavailable" && res.status === 404) {
    memoryDisabled = true;
    opStatus = "error: 記憶は無効です";
    operation = "failed";
    notice = "記憶は無効です";
    return;
  }
  retryVisible = true;
  opStatus = "error: 失敗しました (再送できます)";
  operation = "failed";
  notice = "記憶の更新に失敗しました";
}

async function stageMutation(kind: MutationKind): Promise<void> {
  if (selected === null || scope === null || mutating) return;
  const sessionId = scope.sessionId;
  if (getSessionId() !== sessionId) {
    notice = "セッションが変わりました。再検索してください";
    return;
  }
  const target: Selected = {
    searchId: selected.searchId,
    handle: selected.handle,
  };
  const payload: Record<string, unknown> = {
    kind,
    searchId: target.searchId,
    handle: target.handle,
    runId: scope.runId,
  };
  if (kind === "record.correct") {
    const replacement = correctText.trim();
    if (replacement.length === 0) {
      notice = "訂正内容を入力してください";
      return;
    }
    payload.correctionBody = replacement;
  }
  opSeq += 1;
  const seq = opSeq;
  mutating = true;
  actionsDisabled = true;
  retryVisible = false;
  // New pending status before the first await: only this op's ack can win.
  opStatus = "queued: 送信中";
  operation = "pending";
  const key = randomUuid();
  pending = { key, body: payload };
  try {
    await postMutation(sessionId, key, payload, seq, target);
  } finally {
    if (opSeq === seq) mutating = false;
  }
}

async function retryMutation(): Promise<void> {
  if (pending === null || mutating) return;
  const sessionId = getSessionId();
  if (sessionId === null) return;
  const target = selected;
  const { key, body } = pending;
  opSeq += 1;
  const seq = opSeq;
  mutating = true;
  actionsDisabled = true;
  retryVisible = false;
  opStatus = "queued: 送信中";
  operation = "pending";
  try {
    await postMutation(sessionId, key, body, seq, target);
  } finally {
    if (opSeq === seq) mutating = false;
  }
}

// Session rebinding (shared reactive store): a session switch (or a session
// becoming available) invalidates the old search synchronously — stale hits
// from the previous session never stay clickable in the new session's UI,
// and in-flight responses are dropped by the bumped generations. No polling
// watcher: the store read inside this effect is reactive.
$effect(() => {
  const sessionId = getSessionId();
  if (sessionId === null) return;
  searchSeq += 1;
  detailSeq += 1;
  opSeq += 1;
  graphSeq += 1;
  selected = null;
  scope = null;
  listScope = null;
  graphScope = null;
  graphSelected = null;
  graphStatus = "";
  graphLoading = false;
  canvas?.setGraph(
    {
      searchId: "",
      version: "",
      scope: "global",
      center: null,
      nodes: [],
      edges: [],
      truncated: false,
    },
    { selected: null },
  );
  hits = [];
  searchId = null;
  operation = null;
  detailBody = "";
  detailVisible = false;
  correctText = "";
  retryVisible = false;
  actionsDisabled = true;
  opStatus = "";
  notice = "";
  memoryDisabled = false;
  searching = false;
  mutating = false;
});
</script>

<section id="memory" aria-label="記憶の管理" class="feature-panel">
  <h2>記憶の管理</h2>
  <div id="memory-view-toggle" role="group" aria-label="表示切替">
    <button
      id="memory-view-list"
      type="button"
      aria-pressed={view === "list"}
      onclick={() => switchView("list")}>一覧</button
    >
    <button
      id="memory-view-graph"
      type="button"
      aria-pressed={view === "graph"}
      onclick={() => switchView("graph")}>グラフ</button
    >
  </div>
  <form
    id="memory-search-form"
    onsubmit={(event) => {
      event.preventDefault();
      if (view === "graph") {
        applyGraphSearch();
        return;
      }
      void search();
    }}
  >
    <input
      id="memory-search-input"
      type="text"
      autocomplete="off"
      bind:value={query}
    />
    <button id="memory-search-button" type="submit" disabled={searching}>
      記憶を検索
    </button>
  </form>
  {#if notice.length > 0}
    <p class="memory-notice" role="status">{notice}</p>
  {/if}
  {#if view === "graph"}
    <div id="memory-graph">
      <div id="memory-graph-toolbar">
        <button
          id="memory-graph-global"
          type="button"
          aria-pressed={(graphScope?.scope ?? "global") === "global"}
          disabled={graphLoading}
          onclick={() => void loadGraph("global")}>全体</button
        >
        <button
          id="memory-graph-local"
          type="button"
          aria-pressed={graphScope?.scope === "local"}
          disabled={graphLoading ||
            (graphSelected === null && selected === null)}
          onclick={() => void loadGraph("local")}>ローカル</button
        >
        <label>
          深さ
          <select
            id="memory-graph-depth"
            bind:value={graphDepth}
            onchange={() => {
              if (view === "graph" && graphScope?.scope === "local") {
                void loadGraph("local");
              }
            }}
          >
            <option value="1">1</option>
            <option value="2">2</option>
          </select>
        </label>
        <label>
          <input
            id="memory-graph-retired"
            type="checkbox"
            bind:checked={graphRetired}
            onchange={() => {
              if (view === "graph" && graphScope?.scope !== "local") {
                void loadGraph("global");
              }
            }}
          />
          引退も表示
        </label>
        <p id="memory-graph-status" aria-live="polite">{graphStatus}</p>
      </div>
      <svg
        bind:this={graphCanvasEl}
        id="memory-graph-canvas"
        role="img"
        aria-label="記憶グラフ"
        viewBox="0 0 800 480"
        preserveAspectRatio="xMidYMid meet"
      ></svg>
      <p
        id="memory-graph-legend"
        class="memory-graph-legend"
        aria-label="グラフの凡例"
      >
        <span class="memory-graph-legend__item">
          <span
            class="memory-graph-legend__swatch memory-graph-legend__swatch--user-fact"
            aria-hidden="true"
          ></span>事実
        </span>
        <span class="memory-graph-legend__item">
          <span
            class="memory-graph-legend__swatch memory-graph-legend__swatch--model-inference"
            aria-hidden="true"
          ></span>推論
        </span>
        <span class="memory-graph-legend__item">
          <span
            class="memory-graph-legend__swatch memory-graph-legend__swatch--summary"
            aria-hidden="true"
          ></span>要約
        </span>
        <span class="memory-graph-legend__item">
          <span
            class="memory-graph-legend__swatch memory-graph-legend__swatch--correction"
            aria-hidden="true"
          ></span>訂正
        </span>
        <span class="memory-graph-legend__item">
          <span
            class="memory-graph-legend__swatch memory-graph-legend__swatch--retired"
            aria-hidden="true"
          ></span>引退
        </span>
      </p>
    </div>
  {:else}
    <ul id="memory-list">
      {#each hits as hit (hit.handle)}
        <li>
          <button
            type="button"
            onclick={() => void openDetail(searchId ?? "", hit.handle)}
          >
            {hit.handle} [{hit.status}] {hit.snippet}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
  <div id="memory-detail" hidden={!detailVisible}>
    <pre id="memory-detail-body">{detailBody}</pre>
    <textarea id="memory-correct-input" bind:value={correctText}></textarea>
    <button
      id="memory-correct-button"
      type="button"
      disabled={actionsDisabled}
      onclick={() => void stageMutation("record.correct")}>訂正をキュー</button
    >
    <button
      id="memory-retire-button"
      type="button"
      disabled={actionsDisabled}
      onclick={() => void stageMutation("record.retire")}>引退をキュー</button
    >
    <button
      id="memory-reactivate-button"
      type="button"
      disabled={actionsDisabled}
      onclick={() => void stageMutation("record.reactivate")}
      >再活性をキュー</button
    >
    <button
      id="memory-retry-button"
      type="button"
      hidden={!retryVisible}
      onclick={() => void retryMutation()}>同じ内容で再送</button
    >
    <p
      id="memory-op-status"
      aria-live="polite"
      data-search-id={searchId ?? undefined}
      data-operation={operation ?? undefined}
    >
      {opStatus}
    </p>
  </div>
</section>
