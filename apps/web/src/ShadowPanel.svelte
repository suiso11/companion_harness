<script lang="ts">
// Native port of the AV shadow-deliberation consumer panel (legacy
// `apps/server/src/ui/shadow_panel.ts`, markup from `ui/page.ts`).
//
// Same DOM ids / API endpoints / notices as the legacy panel, so the e2e
// specs run unchanged. The pure guards/labels/state types are SHARED with
// the legacy panel via `lib/shadow_shared.ts` (one source of truth); only
// the imperative DOM rendering becomes Svelte runes.
//
// Boundaries preserved exactly (pinned by regressions):
// - Trial-only: jobs render as 未実行 records, never success/granted. An
//   `execute` MODEL decision renders as「実行案（未実行）」; a recorded
//   permission CLAIM renders as「権限の記録（権限付与ではない）」.
// - No execution/adoption/Calendar buttons exist in this phase; the only
//   POST is the explicit trial request (user-pressed) plus its SAME
//   key+body retry. Reads never ack and never mutate delivery.
// - Technical UUIDs are never rendered; API ids travel only in
//   `data-*` attributes. No user content touches browser storage: the
//   single in-flight request is frozen IN MEMORY only.
// - Latest-intent guards: selection/session/request generations invalidate
//   SYNC before every await.
// - Active-job polling is GET-only, bounded, and stops on session change,
//   new selection, or terminal status.
// - `postJson` resolves `{status: 0}` on a lost response: treated as an
//   UNCERTAIN send (frozen key+body retry offered), like a thrown error.
import { fetchJson, postJson, randomUuid } from "./lib/api.js";
import {
  ACTION_KIND_TEXT,
  DECISION_TEXT,
  type EvidenceEntry,
  evidenceFromContext,
  FAIL_TEXT,
  HOLD_TEXT,
  isDecision,
  isJobItem,
  isRecord,
  KIND_TEXT,
  POLICY_TEXT,
  type ShadowJobItem,
  STATUS_TEXT,
  TERMINAL_JOB,
  textOf,
} from "./lib/shadow_shared.js";

const LS_SESSION = "ch.sessionId";
const SETTLED_EVENT = "ch:run-settled";
/** Bounded GET-only watch (2s ticks, 135s window) for a non-terminal job. */
const POLL_INTERVAL_MS = 2000;
const POLL_WINDOW_MS = 135_000;
const POLL_MAX_TICKS = Math.ceil(POLL_WINDOW_MS / POLL_INTERVAL_MS);

function readSession(): string | null {
  try {
    return localStorage.getItem(LS_SESSION);
  } catch {
    return null;
  }
}

interface PendingRequest {
  readonly ownerSession: string;
  readonly endpoint: string;
  readonly key: string;
  readonly body: { scope: string; reason?: string };
  readonly draft: string;
}

// ---- Reactive state (mirrors the legacy panel's DOM state). ----
let scope = $state("");
let reason = $state("");
let statusText = $state("");
let retryHidden = $state(true);
let jobs = $state<ShadowJobItem[]>([]);
let detailHidden = $state(true);
let detailLines = $state<readonly string[]>([]);

// ---- Non-reactive state (exact legacy contract). ----
let listSeq = 0;
let detailSeq = 0;
let requestSeq = 0;
let selectedJob: string | null = null;
let selectedVersion = 0;
let pendingRequest: PendingRequest | null = null;
let destroyed = false;
let listedSession: string | null = null;

function setStatus(text: string): void {
  statusText = text;
}

function currentDraft(): string {
  return `${scope}\n${reason}`;
}

function rowLabel(item: ShadowJobItem): string {
  return `${item.scope}・${textOf(KIND_TEXT, item.kind)}・${textOf(STATUS_TEXT, item.status)}`;
}

async function refreshList(): Promise<void> {
  const sessionId = readSession();
  if (sessionId === null) return;
  listSeq += 1;
  const seq = listSeq;
  let result: { status: number; body: unknown };
  try {
    result = await fetchJson(
      `/api/sessions/${encodeURIComponent(sessionId)}/shadow-jobs?limit=50`,
    );
  } catch {
    if (seq !== listSeq || sessionId !== readSession()) return;
    setStatus("一覧の取得に失敗しました。");
    return;
  }
  if (seq !== listSeq || sessionId !== readSession()) return;
  if (result.status !== 200 || !isRecord(result.body)) {
    setStatus("一覧の取得に失敗しました。");
    return;
  }
  const items = Array.isArray(result.body.items) ? result.body.items : [];
  jobs = items.filter(isJobItem);
  if (jobs.length === 0) {
    setStatus("試行の記録はまだありません。");
  } else {
    setStatus("");
  }
}

/** Pure line builder from the legacy renderDetail + renderDeliberation. */
function detailText(
  job: ShadowJobItem,
  deliberation: { status: number; body: unknown } | null,
): readonly string[] {
  const lines: string[] = [
    `${job.scope}・${textOf(KIND_TEXT, job.kind)}・${textOf(STATUS_TEXT, job.status)}`,
  ];
  const push = (line: string): void => {
    lines.push(line);
  };
  const renderDeliberation = (response: {
    status: number;
    body: unknown;
  }): void => {
    if (response.status === 409 || response.status === 404) {
      // Never claimed (pending) or foreign: honest, no implicit resume.
      push("凍結された検討内容はまだありません。");
      return;
    }
    if (response.status !== 200 || !isRecord(response.body)) {
      push("検討内容の取得に失敗しました。");
      return;
    }
    const decision = (response.body as { modelDecision?: unknown })
      .modelDecision;
    const context = (response.body as { context?: unknown }).context;
    if (decision === null || decision === undefined) {
      push("モデルの判断はまだ記録されていません。");
    } else if (!isDecision(decision)) {
      push("検討内容の取得に失敗しました。");
      return;
    } else {
      // Frozen MODEL decision, shown SEPARATE from the CODE policy above.
      // `execute` renders as a proposal, never as success or a grant.
      push(`モデルの判断：${textOf(DECISION_TEXT, decision.decision)}`);
      push(`理由：${decision.reason}`);
      const evidence: EvidenceEntry[] = evidenceFromContext(context);
      const byLabel = new Map(evidence.map((entry) => [entry.label, entry]));
      for (const id of decision.evidenceIds) {
        const entry = byLabel.get(id);
        if (entry === undefined) {
          push(`根拠 ${id}：記録なし`);
          continue;
        }
        push(`${entry.heading}`);
        push(`原文：${entry.original}`);
        if (entry.interpretation !== null) {
          push(`解釈：${entry.interpretation}`);
        }
        push(`出所：${entry.provenance}`);
        push(`適用：${entry.applicability}`);
      }
      const action = decision.proposedAction;
      if (action !== null) {
        push(
          `提案：${textOf(ACTION_KIND_TEXT, action.kind)}・${action.summary}（未実行）`,
        );
        if (action.taskDraft !== undefined) {
          push(`作業案の題名：${action.taskDraft.title}（未実行）`);
          if (action.taskDraft.body !== undefined) {
            push(`作業案の内容：${action.taskDraft.body}（未実行）`);
          }
          if (action.taskDraft.deadline !== undefined) {
            push(
              `作業案の期限：${action.taskDraft.deadline}（引用された明示期限のみ）`,
            );
          }
        }
      } else {
        push("提案はありません。");
      }
      push(`完了の目安：${decision.completion}`);
      for (const condition of decision.stopConditions) {
        push(`停止条件：${condition}`);
      }
      push(`不確かさ：${decision.uncertainty}`);
      push(`反対意見：${decision.counterargument}`);
    }
  };
  if (job.status === "held") {
    if (job.holdReason !== null) push(textOf(HOLD_TEXT, job.holdReason));
    if (deliberation !== null) renderDeliberation(deliberation);
    return lines;
  }
  if (job.status === "failed") {
    if (job.failCode !== null) push(textOf(FAIL_TEXT, job.failCode));
    return lines;
  }
  if (job.status === "pending" || job.status === "claimed") {
    push("検討の準備中または検討中です。実行はしません。");
    return lines;
  }
  if (job.status === "cancelled") {
    push("取り消されました。実行はしていません。");
    return lines;
  }
  // Completed: CODE policy first (never model-chosen, never a grant)…
  if (job.policyCode !== null) {
    push(textOf(POLICY_TEXT, job.policyCode));
  }
  if (deliberation !== null) {
    renderDeliberation(deliberation);
  } else {
    push("検討内容の取得に失敗しました。");
  }
  return lines;
}

/**
 * Select a job: SYNC-invalidate, then await detail + deliberation.
 * Latest-intent guards inside make a stale call a no-op.
 */
async function selectJob(jobId: string, version: number): Promise<void> {
  const sessionId = readSession();
  if (sessionId === null) return;
  // Invalidate synchronously BEFORE any await: a held earlier reply can
  // never restore this selection, and an old view draft can never apply
  // after a version advance.
  detailSeq += 1;
  const seq = detailSeq;
  selectedJob = jobId;
  selectedVersion = version;
  detailHidden = false;
  detailLines = ["読み込み中…"];
  const base = `/api/sessions/${encodeURIComponent(sessionId)}/shadow-jobs/${encodeURIComponent(jobId)}`;
  let detail: { status: number; body: unknown };
  try {
    detail = await fetchJson(base);
  } catch {
    if (seq !== detailSeq || selectedJob !== jobId) return;
    detailLines = ["内容の取得に失敗しました。"];
    return;
  }
  if (seq !== detailSeq || selectedJob !== jobId) return;
  if (sessionId !== readSession()) return;
  if (detail.status !== 200 || !isJobItem(detail.body)) {
    detailLines = ["内容の取得に失敗しました。"];
    return;
  }
  // The record version may have advanced while fetching: never render
  // an old view draft over the fresh record.
  if (detail.body.version !== selectedVersion) {
    selectedVersion = detail.body.version;
  }
  let deliberation: { status: number; body: unknown } | null = null;
  try {
    deliberation = await fetchJson(`${base}/context`);
  } catch {
    deliberation = null;
  }
  if (seq !== detailSeq || selectedJob !== jobId) return;
  if (sessionId !== readSession()) return;
  detailLines = detailText(detail.body, deliberation);
  if (!TERMINAL_JOB.has(detail.body.status)) {
    void watchActive(sessionId, jobId, seq);
  }
}

/**
 * Bounded GET-only active watch: fixed ticks, generation + selection +
 * session + terminal exits. Never posts, never triggers model work.
 */
async function watchActive(
  sessionId: string,
  jobId: string,
  seq: number,
): Promise<void> {
  for (let tick = 0; tick < POLL_MAX_TICKS; tick += 1) {
    await new Promise((resolve) => {
      window.setTimeout(resolve, POLL_INTERVAL_MS);
    });
    if (
      seq !== detailSeq ||
      selectedJob !== jobId ||
      sessionId !== readSession()
    ) {
      return;
    }
    let current: { status: number; body: unknown };
    try {
      current = await fetchJson(
        `/api/sessions/${sessionId}/shadow-jobs/${encodeURIComponent(jobId)}`,
      );
    } catch {
      return;
    }
    if (
      seq !== detailSeq ||
      selectedJob !== jobId ||
      sessionId !== readSession()
    ) {
      return;
    }
    if (current.status !== 200 || !isJobItem(current.body)) {
      return;
    }
    if (current.body.version !== selectedVersion) {
      // New backend state: re-select once through the guarded path so
      // the fresh record (never an old draft) renders.
      selectedVersion = current.body.version;
      await selectJob(jobId, current.body.version);
      return;
    }
    if (TERMINAL_JOB.has(current.body.status)) {
      await selectJob(jobId, current.body.version);
      return;
    }
  }
}

/** Explicit user-pressed trial request (the only POST in this panel). */
async function submitRequest(event?: Event): Promise<void> {
  if (event !== undefined) event.preventDefault();
  const sessionId = readSession();
  if (sessionId === null) return;
  const scopeValue = scope.trim();
  const reasonValue = reason.trim();
  if (scopeValue.length === 0) {
    setStatus("分野を入力してください。");
    return;
  }
  // Invalidate synchronously: a new request supersedes any frozen one.
  requestSeq += 1;
  const seq = requestSeq;
  const body: { scope: string; reason?: string } =
    reasonValue.length > 0
      ? { scope: scopeValue, reason: reasonValue }
      : { scope: scopeValue };
  pendingRequest = {
    ownerSession: sessionId,
    endpoint: `/api/sessions/${encodeURIComponent(sessionId)}/shadow-jobs`,
    key: randomUuid(),
    body,
    draft: currentDraft(),
  };
  retryHidden = true;
  await commitRequest(seq);
}

async function commitRequest(seq: number): Promise<void> {
  const frozen = pendingRequest;
  const sessionId = readSession();
  if (frozen === null || sessionId === null) return;
  if (frozen.ownerSession !== sessionId) return;
  let result: { status: number; body: unknown };
  try {
    result = await postJson(frozen.endpoint, frozen.body, frozen.key);
  } catch {
    // Treated identically to a lost response (uncertain, status 0).
    result = { status: 0, body: null };
  }
  if (seq !== requestSeq || pendingRequest !== frozen) return;
  // A stale ack for another session never retargets this UI.
  if (frozen.ownerSession !== readSession()) return;
  if (result.status === 0 || result.status >= 500 || result.status === 429) {
    // Uncertain network/server side: SAME key+body retry only.
    if (result.status === 0) {
      setStatus("通信が不確かです。同じ内容で再送できます。");
    } else {
      setStatus("応答が不確かです。同じ内容で再送できます。");
    }
    retryHidden = false;
    return;
  }
  if (result.status === 201) {
    pendingRequest = null;
    retryHidden = true;
    setStatus("試行を受け付けました。実行はしません。");
    await refreshList();
    return;
  }
  // Definitive reply (4xx/2xx): clear the frozen request.
  pendingRequest = null;
  retryHidden = true;
  if (result.status === 409) {
    setStatus("内容が変わったため受け付けられませんでした。");
  } else {
    setStatus("依頼を受け付けられませんでした。");
  }
}

/** ONE retry with the SAME frozen key+body; an edited draft needs a fresh request. */
async function retryRequest(): Promise<void> {
  const frozen = pendingRequest;
  if (frozen === null) return;
  if (frozen.ownerSession !== readSession()) return;
  // An edited scope/reason can never attach the old key or retarget:
  // the frozen body stays byte-identical, so a changed draft must
  // submit fresh instead.
  if (currentDraft() !== frozen.draft) {
    pendingRequest = null;
    retryHidden = true;
    setStatus("内容が変更されました。新たに依頼してください。");
    return;
  }
  const seq = requestSeq;
  await commitRequest(seq);
}

// Mount: boot the quiet list for the adopted session; unmount: invalidate
// every in-flight generation (legacy destroy/notifySessionChanged).
$effect(() => {
  void refreshList();
  // The chat shell boots the session asynchronously: the panel re-binds
  // (sync reset + boot) as soon as the stored session id appears or
  // changes, and refreshes on the run-settled hook (chat window event;
  // covers the legacy autonomy-changed hook as well).
  const watcher = window.setInterval(() => {
    if (destroyed) return;
    if (listedSession !== readSession()) {
      // Session lifecycle. A session CHANGE (a previous session existed)
      // invalidates selection + requests, mirroring the legacy
      // notifySessionChanged. The FIRST bind (no listed session yet) must
      // NOT reset: the chat shell stores the session id asynchronously, so
      // this first bind can land AFTER a user-pressed request already
      // committed — a reset here would erase a just-frozen uncertain
      // request's status/retry (same rule as the learning/proposals
      // panels).
      if (listedSession !== null) {
        listSeq += 1;
        detailSeq += 1;
        requestSeq += 1;
        selectedJob = null;
        pendingRequest = null;
        detailHidden = true;
        retryHidden = true;
      }
      listedSession = readSession();
      // The first bind's refresh is the panel's initial list load (the
      // mount-time refresh no-ops while the session id is still unstored),
      // but it must not clobber a frozen uncertain request's status/retry:
      // this bind can land right after a user-pressed POST lost its
      // response, and the refresh would clear the 再送 notice (legacy has
      // no timer bind at all, so nothing ever clobbers it there).
      if (pendingRequest === null) void refreshList();
    }
  }, 400);
  const onSettled = (): void => {
    void refreshList();
  };
  window.addEventListener(SETTLED_EVENT, onSettled);
  return () => {
    destroyed = true;
    listSeq += 1;
    detailSeq += 1;
    requestSeq += 1;
    window.clearInterval(watcher);
    window.removeEventListener(SETTLED_EVENT, onSettled);
  };
});
</script>

<section id="shadow" aria-label="試行の記録" class="feature-panel">
  <h2>試行の記録</h2>
  <p id="shadow-disclaimer">試行のみ・未実行・記録は権限付与ではない</p>
  <form
    id="shadow-request-form"
    onsubmit={(event) => {
      void submitRequest(event);
    }}
  >
    <input id="shadow-scope" type="text" autocomplete="off" bind:value={scope} />
    <textarea id="shadow-reason" bind:value={reason}></textarea>
    <button id="shadow-request-submit" type="submit">試行を依頼</button>
  </form>
  <p id="shadow-status" aria-live="polite">{statusText}</p>
  <button
    id="shadow-refresh"
    type="button"
    onclick={() => void refreshList()}
  >
    一覧を更新
  </button>
  <ul id="shadow-job-list">
    {#each jobs as job (job.id)}
      <li>
        <button
          type="button"
          data-job-id={job.id}
          onclick={() => void selectJob(job.id, job.version)}
        >
          {rowLabel(job)}
        </button>
      </li>
    {/each}
  </ul>
  <!-- The frozen-request retry belongs to the request surface, NOT the
       detail panel: the detail stays hidden until a job is selected, so
       a retry nested inside it could never be pressed after an
       uncertain POST (pinned by the shadow browser regression). -->
  <button
    id="shadow-retry"
    type="button"
    hidden={retryHidden}
    onclick={() => void retryRequest()}
  >
    同じ内容で再送
  </button>
  <div id="shadow-detail" hidden={detailHidden}>
    <pre id="shadow-detail-body">
      {#each detailLines as line}
        <p>{line}</p>
      {/each}
    </pre>
  </div>
</section>
