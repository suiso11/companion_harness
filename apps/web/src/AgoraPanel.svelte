<script lang="ts">
// Human-only AGORA review panel for the current chat session.
//
// The browser only reads the session-scoped review projection and commits
// explicit human decisions through the local authenticated API. Approval and
// Send are separate clicks; this panel NEVER sends automatically, never edits
// a payload, and never posts to AGORA directly. All proposal text is untrusted:
// it renders through text interpolation only (no {@html}). The only external
// link is the backend-verified `resultUrl` for the fixed `/t/<id>` target.
import { fetchJson, postJson, type ApiResult } from "./lib/api.js";

const SETTLED_EVENT = "ch:run-settled";

type ProposalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "sending"
  | "sent"
  | "unknown"
  | "failed";
type EffectiveStatus = ProposalStatus | "expired";
type Operation = "register" | "thread" | "reply";
type ActionKind = "approve" | "reject" | "send";
type SendOutcome = "sent" | "failed" | "unknown" | "throttled" | "key_missing";

interface Proposal {
  readonly proposalId: string;
  readonly operation: Operation;
  readonly status: ProposalStatus;
  readonly destination: string;
  readonly payloadHash: string;
  readonly name: string | null;
  readonly description: string | null;
  readonly title: string | null;
  readonly body: string | null;
  readonly threadId: string | null;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly decidedAt: number | null;
  readonly consumedAt: number | null;
  readonly httpStatus: number | null;
  readonly resultCode: string | null;
  readonly resultThreadId: string | null;
  readonly resultUrl: string | null;
}

interface SendResponse {
  readonly outcome: SendOutcome;
  readonly proposal: Proposal | null;
  readonly retryAfterMs: number | null;
}

const STATUS_TEXT: Record<EffectiveStatus, string> = {
  pending: "承認待ち",
  approved: "承認済み（送信待ち）",
  rejected: "却下",
  sending: "送信中",
  sent: "送信済み",
  unknown: "結果不明",
  failed: "失敗",
  expired: "期限切れ",
};

const OPERATION_TEXT: Record<Operation, string> = {
  register: "登録",
  thread: "スレッド作成",
  reply: "返信",
};

const SEND_OUTCOME_TEXT: Record<SendOutcome, string> = {
  sent: "送信しました",
  failed: "送信に失敗しました。状態を確認してください",
  unknown:
    "送信結果が不明です。自動再送はしません。更新して状態を確認してください",
  throttled: "レート制限中です",
  key_missing: "AGORA の書き込みキーが未設定のため送信できません",
};

let { sessionId }: { sessionId: string | null } = $props();

let proposals = $state<Proposal[]>([]);
let disabled = $state(false);
let loading = $state(false);
let notice = $state("");
let busyId = $state<string | null>(null);
let busyAction = $state<ActionKind | null>(null);
let throttleUntil = $state<Record<string, number>>({});
let nowMs = $state(Date.now());

// Non-reactive generations: a session change bumps `boundSeq` and
// `actionSeq`, so no in-flight list/action response can paint the old
// session's details or re-enable a stale button.
let boundSession: string | null = null;
let boundSeq = 0;
let loadSeq = 0;
let actionSeq = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function isNullableNumber(value: unknown): boolean {
  return value === null || typeof value === "number";
}

function isProposal(value: unknown): value is Proposal {
  if (!isRecord(value)) return false;
  return (
    typeof value.proposalId === "string" &&
    (value.operation === "register" ||
      value.operation === "thread" ||
      value.operation === "reply") &&
    (value.status === "pending" ||
      value.status === "approved" ||
      value.status === "rejected" ||
      value.status === "sending" ||
      value.status === "sent" ||
      value.status === "unknown" ||
      value.status === "failed") &&
    typeof value.destination === "string" &&
    typeof value.payloadHash === "string" &&
    isNullableString(value.name) &&
    isNullableString(value.description) &&
    isNullableString(value.title) &&
    isNullableString(value.body) &&
    isNullableString(value.threadId) &&
    typeof value.createdAt === "number" &&
    typeof value.expiresAt === "number" &&
    isNullableNumber(value.decidedAt) &&
    isNullableNumber(value.consumedAt) &&
    isNullableNumber(value.httpStatus) &&
    isNullableString(value.resultCode) &&
    isNullableString(value.resultThreadId) &&
    isNullableString(value.resultUrl)
  );
}

function parseList(body: unknown): Proposal[] | null {
  if (!isRecord(body) || !Array.isArray(body.proposals)) return null;
  return body.proposals.filter(isProposal);
}

function parseProposalBody(body: unknown): Proposal | null {
  if (!isRecord(body) || !isProposal(body.proposal)) return null;
  return body.proposal;
}

function parseSendResponse(body: unknown): SendResponse | null {
  if (!isRecord(body)) return null;
  const outcome = body.outcome;
  if (
    outcome !== "sent" &&
    outcome !== "failed" &&
    outcome !== "unknown" &&
    outcome !== "throttled" &&
    outcome !== "key_missing"
  ) {
    return null;
  }
  const proposal =
    body.proposal === null
      ? null
      : isProposal(body.proposal)
        ? body.proposal
        : null;
  const retryAfterMs =
    typeof body.retryAfterMs === "number" &&
    Number.isFinite(body.retryAfterMs) &&
    body.retryAfterMs >= 0
      ? body.retryAfterMs
      : null;
  return { outcome, proposal, retryAfterMs };
}

function isCurrent(sid: string, seq: number): boolean {
  return boundSession === sid && boundSeq === seq && sessionId === sid;
}

function formatInstant(ms: number): string {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

function effectiveStatus(proposal: Proposal): EffectiveStatus {
  if (proposal.resultCode === "approval_expired") return "expired";
  if (
    (proposal.status === "pending" || proposal.status === "approved") &&
    proposal.expiresAt <= nowMs
  ) {
    return "expired";
  }
  return proposal.status;
}

function throttleSeconds(proposal: Proposal): number {
  const until = throttleUntil[proposal.proposalId];
  if (until === undefined) return 0;
  return Math.max(0, Math.ceil((until - nowMs) / 1000));
}

/**
 * The backend's `resultUrl` is already fixed-origin; re-verify it here so the
 * anchor can only ever target the same origin's exact `/t/<verified id>` path.
 */
function safeResultUrl(proposal: Proposal): string | null {
  if (proposal.resultUrl === null || proposal.resultThreadId === null) {
    return null;
  }
  try {
    const destination = new URL(proposal.destination);
    const candidate = new URL(proposal.resultUrl);
    if (candidate.origin !== destination.origin) return null;
    if (candidate.username !== "" || candidate.password !== "") return null;
    if (candidate.search !== "" || candidate.hash !== "") return null;
    if (candidate.pathname !== `/t/${proposal.resultThreadId}`) return null;
    return candidate.toString();
  } catch {
    return null;
  }
}

function replaceProposal(next: Proposal): void {
  const index = proposals.findIndex(
    (item) => item.proposalId === next.proposalId,
  );
  if (index < 0) {
    proposals = [next, ...proposals];
    return;
  }
  proposals = proposals.map((item, i) => (i === index ? next : item));
}

function setThrottle(proposalId: string, retryAfterMs: number): void {
  throttleUntil = {
    ...throttleUntil,
    [proposalId]: Date.now() + Math.max(0, retryAfterMs),
  };
}

function applySendResponse(proposal: Proposal, result: SendResponse): void {
  if (result.proposal !== null) replaceProposal(result.proposal);
  if (result.outcome === "throttled") {
    if (result.retryAfterMs !== null) {
      setThrottle(proposal.proposalId, result.retryAfterMs);
    }
  }
  notice = SEND_OUTCOME_TEXT[result.outcome];
}

async function load(sid: string, seq: number): Promise<void> {
  if (!isCurrent(sid, seq)) return;
  loadSeq += 1;
  const request = loadSeq;
  loading = true;
  let result: ApiResult;
  try {
    result = await fetchJson(
      `/api/sessions/${encodeURIComponent(sid)}/agora/proposals`,
    );
  } catch {
    result = { status: 0, body: null };
  }
  if (!isCurrent(sid, seq) || request !== loadSeq) return;
  loading = false;
  if (result.status === 404) {
    // AGORA is not configured for this server: hide the whole surface.
    disabled = true;
    proposals = [];
    notice = "";
    return;
  }
  if (result.status === 200) {
    const parsed = parseList(result.body);
    if (parsed === null) {
      notice = "提案一覧の応答を解釈できませんでした";
      return;
    }
    disabled = false;
    proposals = parsed;
    return;
  }
  if (result.status === 401) {
    notice = "ログインの有効期限が切れました";
    return;
  }
  notice =
    result.status === 0
      ? "提案一覧を取得できませんでした。更新してください"
      : `提案一覧を取得できませんでした (HTTP ${result.status})`;
}

function refresh(): void {
  const sid = boundSession;
  if (sid !== null) void load(sid, boundSeq);
}

async function act(proposal: Proposal, kind: ActionKind): Promise<void> {
  if (busyId !== null) return;
  const status = effectiveStatus(proposal);
  if (kind === "send") {
    if (status !== "approved" || throttleSeconds(proposal) > 0) return;
  } else if (status !== "pending") {
    return;
  }
  const sid = boundSession;
  const seq = boundSeq;
  if (sid === null || !isCurrent(sid, seq)) return;

  actionSeq += 1;
  const token = actionSeq;
  busyId = proposal.proposalId;
  busyAction = kind;

  let result: ApiResult;
  try {
    result = await postJson(
      `/api/sessions/${encodeURIComponent(sid)}/agora/proposals/${encodeURIComponent(proposal.proposalId)}/${kind}`,
      { payloadHash: proposal.payloadHash },
      null,
    );
  } catch {
    result = { status: 0, body: null };
  }
  if (actionSeq !== token || !isCurrent(sid, seq)) return;
  busyId = null;
  busyAction = null;

  if (result.status === 200 && kind === "send") {
    const parsed = parseSendResponse(result.body);
    if (parsed !== null) {
      applySendResponse(proposal, parsed);
      return;
    }
    await load(sid, seq);
    if (!isCurrent(sid, seq) || actionSeq !== token) return;
    notice = "送信応答を解釈できませんでした。状態を更新しました";
    return;
  }
  if (result.status === 429) {
    const parsed = parseSendResponse(result.body);
    if (parsed !== null) {
      applySendResponse(proposal, parsed);
      return;
    }
    await load(sid, seq);
    if (!isCurrent(sid, seq) || actionSeq !== token) return;
    notice = "レート制限中です。しばらくしてから手動で再送してください";
    return;
  }
  if (result.status === 200) {
    const updated = parseProposalBody(result.body);
    if (updated !== null) replaceProposal(updated);
    notice = kind === "approve" ? "承認しました。送信は別の操作です" : "却下しました";
    return;
  }
  if (result.status === 409) {
    const send = kind === "send" ? parseSendResponse(result.body) : null;
    if (send !== null) {
      applySendResponse(proposal, send);
      return;
    }
    // Stale hash or state conflict: re-read the truth, then require a fresh
    // human action. The panel never replays the decision automatically.
    await load(sid, seq);
    if (!isCurrent(sid, seq) || actionSeq !== token) return;
    notice =
      "他の操作と競合しました。最新の状態を確認して、あらためて操作してください";
    return;
  }
  if (result.status === 404) {
    await load(sid, seq);
    if (!isCurrent(sid, seq) || actionSeq !== token) return;
    notice = "提案が見つかりませんでした。一覧を更新しました";
    return;
  }
  if (result.status === 0) {
    // Lost response: refresh the authoritative status, never auto-retry.
    await load(sid, seq);
    if (!isCurrent(sid, seq) || actionSeq !== token) return;
    notice = "通信に失敗しました。状態を更新しました。自動再送はしません";
    return;
  }
  if (result.status === 401) {
    notice = "ログインの有効期限が切れました";
    return;
  }
  notice = `操作に失敗しました (HTTP ${result.status})`;
}

// Session lifecycle: reset synchronously (no old-session details/buttons),
// drop every pending response via the generation counters, then bind the new
// session's list. A completed run also refreshes the list.
$effect(() => {
  const sid = sessionId;
  boundSeq += 1;
  const seq = boundSeq;
  boundSession = sid;
  actionSeq += 1;
  proposals = [];
  disabled = false;
  loading = false;
  notice = "";
  busyId = null;
  busyAction = null;
  throttleUntil = {};
  nowMs = Date.now();
  if (sid === null) return;

  const onSettled = (): void => {
    void load(sid, seq);
  };
  window.addEventListener(SETTLED_EVENT, onSettled);
  void load(sid, seq);
  return () => {
    window.removeEventListener(SETTLED_EVENT, onSettled);
    if (boundSeq === seq) boundSeq += 1;
  };
});

// Re-evaluate expiry/throttle countdown without polling the server.
$effect(() => {
  const timer = window.setInterval(() => {
    nowMs = Date.now();
  }, 1000);
  return () => {
    window.clearInterval(timer);
  };
});
</script>

{#if !disabled && sessionId !== null}
  <section
    id="agora-panel"
    class="feature-panel agora-panel"
    aria-label="AGORA レビュー"
    data-agora-panel="true"
  >
    <div class="agora-header">
      <h2>AGORA レビュー</h2>
      <button
        id="agora-refresh"
        type="button"
        onclick={refresh}
        disabled={loading}
        aria-label="AGORA の提案一覧を更新"
      >
        {loading ? "更新中…" : "更新"}
      </button>
    </div>
    <p class="agora-notice" role="status" aria-live="polite">{notice}</p>

    {#if loading && proposals.length === 0}
      <p class="agora-empty">読み込み中…</p>
    {:else if proposals.length === 0}
      <p class="agora-empty">このセッションの提案はありません。</p>
    {/if}

    <ul class="agora-list">
      {#each proposals as proposal (proposal.proposalId)}
        {@const status = effectiveStatus(proposal)}
        {@const remaining = throttleSeconds(proposal)}
        {@const resultUrl = safeResultUrl(proposal)}
        <li class="agora-item" data-agora-proposal={proposal.proposalId}>
          <article aria-labelledby={`agora-title-${proposal.proposalId}`}>
            <div class="agora-item-head">
              <h3 id={`agora-title-${proposal.proposalId}`}>
                {OPERATION_TEXT[proposal.operation]}の提案
              </h3>
              <span class="agora-status" data-agora-status={status}>
                {STATUS_TEXT[status]}
              </span>
            </div>

            <dl class="agora-meta">
              <div>
                <dt>宛先</dt>
                <dd><code data-agora-destination="true">{proposal.destination}</code></dd>
              </div>
              <div>
                <dt>状態</dt>
                <dd>
                  {STATUS_TEXT[status]}
                  <span class="agora-code">({status})</span>
                </dd>
              </div>
              <div>
                <dt>ハッシュ</dt>
                <dd><code data-agora-hash="true">{proposal.payloadHash}</code></dd>
              </div>
              <div>
                <dt>作成</dt>
                <dd>{formatInstant(proposal.createdAt)}</dd>
              </div>
              <div>
                <dt>期限</dt>
                <dd data-agora-expiry="true">{formatInstant(proposal.expiresAt)}</dd>
              </div>
              {#if proposal.name !== null}
                <div>
                  <dt>名前</dt>
                  <dd>{proposal.name}</dd>
                </div>
              {/if}
              {#if proposal.description !== null}
                <div>
                  <dt>説明</dt>
                  <dd>{proposal.description}</dd>
                </div>
              {/if}
              {#if proposal.title !== null}
                <div>
                  <dt>タイトル</dt>
                  <dd data-agora-title="true">{proposal.title}</dd>
                </div>
              {/if}
              {#if proposal.threadId !== null}
                <div>
                  <dt>スレッド</dt>
                  <dd><code data-agora-thread-id="true">{proposal.threadId}</code></dd>
                </div>
              {/if}
              {#if proposal.body !== null}
                <div class="agora-body-row">
                  <dt>本文</dt>
                  <dd class="agora-body" data-agora-body="true">{proposal.body}</dd>
                </div>
              {/if}
              <div>
                <dt>結果</dt>
                <dd class="agora-result" data-agora-result="true">
                  {#if proposal.httpStatus !== null}
                    <span>HTTP {proposal.httpStatus}</span>
                  {/if}
                  {#if proposal.resultCode !== null}
                    <code>{proposal.resultCode}</code>
                  {/if}
                  {#if proposal.resultThreadId !== null}
                    <span>スレッド {proposal.resultThreadId}</span>
                  {/if}
                  {#if resultUrl !== null}
                    <a
                      href={resultUrl}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      data-agora-result-link="true">結果スレッドを開く</a
                    >
                  {/if}
                  {#if proposal.httpStatus === null && proposal.resultCode === null && proposal.resultThreadId === null && resultUrl === null}
                    <span>未送信</span>
                  {/if}
                </dd>
              </div>
            </dl>

            <div class="agora-actions">
              <button
                type="button"
                data-agora-approve="true"
                disabled={busyId !== null || status !== "pending"}
                aria-label={`提案 ${proposal.proposalId} を承認`}
                onclick={() => void act(proposal, "approve")}
              >
                {busyId === proposal.proposalId && busyAction === "approve"
                  ? "承認中…"
                  : "承認"}
              </button>
              <button
                type="button"
                data-agora-reject="true"
                disabled={busyId !== null || status !== "pending"}
                aria-label={`提案 ${proposal.proposalId} を却下`}
                onclick={() => void act(proposal, "reject")}
              >
                {busyId === proposal.proposalId && busyAction === "reject"
                  ? "却下中…"
                  : "却下"}
              </button>
              <button
                type="button"
                data-agora-send="true"
                disabled={busyId !== null || status !== "approved" || remaining > 0}
                aria-label={`提案 ${proposal.proposalId} を AGORA へ送信`}
                onclick={() => void act(proposal, "send")}
              >
                {busyId === proposal.proposalId && busyAction === "send"
                  ? "送信中…"
                  : remaining > 0
                    ? `再送まで ${remaining} 秒`
                    : "送信"}
              </button>
            </div>

            {#if status === "approved"}
              <p class="agora-hint">
                承認と送信は別の操作です。内容を確認してから送信してください。
              </p>
            {/if}
            {#if remaining > 0}
              <p class="agora-hint" role="status">
                レート制限中です。あと {remaining} 秒で手動送信できます。
              </p>
            {/if}
            {#if status === "sending"}
              <p class="agora-hint">送信中です。完了まで再送できません。</p>
            {:else if status === "unknown"}
              <p class="agora-hint">
                結果不明です。再送せず、更新して状態を確認してください。
              </p>
            {:else if status === "expired"}
              <p class="agora-hint">承認期限が切れています。操作できません。</p>
            {:else if status === "rejected"}
              <p class="agora-hint">却下済みです。送信できません。</p>
            {:else if status === "sent"}
              <p class="agora-hint">送信済みです。再送できません。</p>
            {/if}
          </article>
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  .agora-panel {
    max-height: 42vh;
    overflow-y: auto;
    box-sizing: border-box;
  }

  .agora-header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .agora-header h2 {
    margin: 0;
  }

  .agora-notice {
    margin: 0.25rem 0;
    min-height: 1.2em;
    color: var(--muted-foreground);
  }

  .agora-empty {
    margin: 0.5rem 0;
    color: var(--muted-foreground);
  }

  .agora-list {
    list-style: none;
    margin: 0.5rem 0 0;
    padding: 0;
    display: grid;
    gap: 0.75rem;
  }

  .agora-item {
    border: 1px solid var(--border-subtle);
    border-radius: 0.5rem;
    padding: 0.6rem 0.75rem;
  }

  .agora-item-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .agora-item-head h3 {
    margin: 0;
    font-size: 0.95rem;
  }

  .agora-status {
    padding: 0 0.4rem;
    border: 1px solid var(--border-subtle);
    border-radius: 999px;
    font-size: 0.75rem;
    color: var(--muted-foreground);
  }

  .agora-meta {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 0.3rem;
    margin: 0.5rem 0;
  }

  .agora-meta div {
    display: grid;
    grid-template-columns: 6rem minmax(0, 1fr);
    gap: 0.5rem;
    align-items: start;
  }

  .agora-meta dt {
    color: var(--muted-foreground);
    font-size: 0.8rem;
  }

  .agora-meta dd {
    margin: 0;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .agora-meta code {
    font-size: 0.78rem;
    overflow-wrap: anywhere;
  }

  .agora-code {
    color: var(--muted-foreground);
    font-size: 0.78rem;
  }

  .agora-body {
    white-space: pre-wrap;
  }

  .agora-result {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    align-items: center;
  }

  .agora-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .agora-hint {
    margin: 0.4rem 0 0;
    color: var(--muted-foreground);
    font-size: 0.8rem;
  }

  @media (max-width: 480px) {
    .agora-panel {
      max-height: 48vh;
      margin: 0.5rem 0.75rem;
    }

    .agora-meta div {
      grid-template-columns: minmax(0, 1fr);
      gap: 0.1rem;
    }
  }
</style>
