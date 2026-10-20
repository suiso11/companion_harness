<script lang="ts">
// Native port of the AV03 conversation-proposal consumer panel (legacy
// `apps/server/src/ui/proposal_panel.ts`, markup from `ui/page.ts`).
//
// Same DOM ids / API endpoints / notices as the legacy panel, so the e2e
// specs run unchanged. The pure guards/labels/state types are SHARED with
// the legacy panel via `lib/proposal_shared.ts` (one source of truth);
// only the imperative DOM rendering becomes Svelte runes.
//
// Boundaries preserved exactly (pinned by regressions):
// - Pending drafts stay QUIET: a badge counts them, a one-line brief
//   appears ONLY on a natural break (no active run + composer empty +
//   visible), and the review drawer opens ONLY on explicit click.
// - Adopt/reject are explicit HUMAN decisions only, committed via the
//   trusted HTTP routes (CAS on the expected version, explicit dates only).
// - Model text is UNTRUSTED: text interpolation only, never {@html}.
// - Uncertain operations freeze {key, expectedVersion, date fields} IN
//   MEMORY only (same-key retry, never a new key on a lost response).
//   While one operation is unresolved, changing selection or inputs cannot
//   replace it.
// - Session guards invalidate generations SYNC: a held old-session reply
//   can never render into the new session. No user/model body in
//   localStorage. Reads come from the ACTUAL HTTP API; the drawer
//   refreshes on the existing run-settled hook (every-chat GET read, not
//   taskization).
import { fetchJson, postJson } from "./lib/api.js";
import {
  DRAFT_KIND_TEXT,
  isProposalView,
  isRecord,
  type ProposalView,
  readCursor,
  readHasMore,
  readItems,
  readPendingCount,
  STATUS_TEXT,
  textOf,
} from "./lib/proposal_shared.js";
import { revealHashTarget } from "./lib/router.js";

const LS_SESSION = "ch.sessionId";
const SETTLED_EVENT = "ch:run-settled";

function readSession(): string | null {
  try {
    return localStorage.getItem(LS_SESSION);
  } catch {
    return null;
  }
}

interface PendingOp {
  readonly proposalId: string;
  readonly ownerSession: string;
  readonly endpoint: string;
  readonly key: string;
  readonly body: Record<string, unknown>;
}

/** Natural break: no active run + composer empty + visible. The composer
 *  and run state live in the mounted chat shell; the DOM is the seam the
 *  legacy client injected (activeRunId === null ⇔ stop control visible). */
function isNaturalBreak(): boolean {
  try {
    if (document.visibilityState !== "visible") return false;
    const stop = document.getElementById("composer-stop");
    if (stop !== null && !stop.hidden) return false;
    const input = document.getElementById("composer-input");
    if (input === null) return false;
    return (input as HTMLTextAreaElement).value.trim().length === 0;
  } catch {
    return false;
  }
}

function newKey(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `00000000-0000-4000-8000-${String(Date.now()).slice(-12).padStart(12, "0")}`;
  }
}

// ---- Reactive state (mirrors the legacy panel's DOM state). ----
let badgeText = $state("");
let briefText = $state("");
let statusText = $state("");
let retryHidden = $state(true);
let historyMoreHidden = $state(true);
/** Newest-first ordered list (same stable sort as the legacy render). */
let rows = $state<ProposalView[]>([]);
let detailHidden = $state(true);
let detailLines = $state<readonly string[]>([]);
let parentText = $state("");
let dateLabelText = $state("");
let untilHidden = $state(true);
// Human-typed dates (plain text input, strict RFC3339 with offset only).
let dateFrom = $state("");
let dateUntil = $state("");

let dateDisabled = $state(true);
let untilDisabled = $state(true);
let acceptDisabled = $state(true);
let rejectDisabled = $state(true);

// ---- Non-reactive state (exact legacy contract). ----
let sessionSeq = 0;
let listSeq = 0;
let listedSession: string | null = null;
let destroyed = false;
/** Newest-history keyset: opaque cursor + truthful older-page flag. */
let historyCursor: string | null = null;
let historyHasMore = false;
/** ALL owned pending drafts (badge truth); -1 until the first read. */
let totalPending = -1;
/** Parent-read generation: every selection change invalidates late reads. */
let parentSeq = 0;
const cache = new Map<string, ProposalView>();
/** Explicitly selected pending draft id (drawer content). */
let selectedId: string | null = null;
/**
 * Frozen unresolved operation: {proposal id, session, key, endpoint,
 * body}. While set, selection/input changes cannot replace it; only the
 * explicit retry reuses the identical key+body. In memory only.
 */
let pendingOp: PendingOp | null = null;
let opInFlight = false;

function setStatus(text: string): void {
  statusText = text;
}

/** Sync invalidation (legacy notifySessionChanged). */
function resetState(): void {
  sessionSeq += 1;
  parentSeq += 1;
  cache.clear();
  selectedId = null;
  pendingOp = null;
  opInFlight = false;
  historyCursor = null;
  historyHasMore = false;
  totalPending = -1;
  detailHidden = true;
  retryHidden = true;
  statusText = "";
  renderAll();
}

function pendingCount(): number {
  if (totalPending >= 0) return totalPending;
  let n = 0;
  for (const item of cache.values()) {
    if (item.status === "pending") n += 1;
  }
  return n;
}

/** Newest-first by server timestamp (ties: ascending id, legacy sort). */
function renderAll(): void {
  const pending = pendingCount();
  badgeText =
    pending === 0 ? "未採用の候補はありません" : `未採用の候補 ${pending}件`;
  maybeBrief();
  historyMoreHidden = !historyHasMore;
  rows = [...cache.values()].sort(
    (a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1),
  );
}

/** Quiet brief: text only, natural break only, never focus/steal. */
function maybeBrief(): void {
  const pending = pendingCount();
  if (pending === 0) {
    briefText = "";
    return;
  }
  briefText = isNaturalBreak()
    ? `AI候補が${pending}件あります。確認は任意です（自動では何も記録されません）。`
    : "";
}

function rowLabel(item: ProposalView): string {
  return (
    `AI候補／${textOf(STATUS_TEXT, item.status)}` +
    `［${item.target === "purpose" ? "目的" : "作業"}・${textOf(DRAFT_KIND_TEXT, item.draftKind)}・${item.scope}］`
  );
}

/** Render the drawer: quote apart from interpretation + parent title. */
function renderDetail(resetDates: boolean): void {
  const item = selectedId === null ? undefined : cache.get(selectedId);
  if (item === undefined) return;
  const lines: string[] = [
    `AI候補／${textOf(STATUS_TEXT, item.status)}［${item.target === "purpose" ? "目的" : "作業"}・${textOf(DRAFT_KIND_TEXT, item.draftKind)}・${item.scope}］`,
    "発言の原文（引用）:",
    item.sourceQuote,
    "AIの解釈（原文ではありません）:",
    item.interpretation,
  ];
  // Resolved history: real outcome only (status + accepted target, no
  // raw UUID wall, no decision controls, no mutations from here).
  const readonly = item.status !== "pending";
  if (readonly) {
    const targetShort =
      item.acceptedTargetId === null
        ? "なし"
        : `${item.acceptedTargetId.slice(0, 8)}…`;
    lines.push(
      `結果: ${textOf(STATUS_TEXT, item.status)}／採用先: ${targetShort}`,
    );
  }
  detailLines = lines;
  // Parent line: model's explicit parent only (immutable, human-readable
  // title fetched readonly; never auto-pick another purpose).
  if (item.target === "task") {
    parentText = "親の目的を確認しています…";
    void loadParentTitle(item);
  } else {
    parentText = "";
  }
  // Human-typed dates survive every same-selection refresh: only an
  // explicit NEW selection clears them.
  if (resetDates) {
    dateFrom = "";
    dateUntil = "";
  }
  if (item.target === "task") {
    dateLabelText =
      "期限（任意・空欄は期限なし。厳密なRFC3339・時差必須。例 2026-10-20T09:00:00+09:00）";
    untilHidden = true;
  } else {
    dateLabelText =
      "適用期間（任意・空欄は無期限。開始と終了いずれも厳密なRFC3339・時差必須）";
    untilHidden = false;
  }
  const locked = opInFlight || pendingOp !== null;
  const decidable = !readonly && !locked;
  dateDisabled = !decidable;
  untilDisabled = !decidable;
  acceptDisabled = !decidable;
  rejectDisabled = !decidable;
}

function select(id: string): void {
  // An unresolved frozen operation pins the drawer: switching selection
  // cannot replace it (the retry affordance stays on the frozen draft,
  // and the frozen key/body/action is never overwritten).
  if (pendingOp !== null) {
    setStatus("未確定の操作があります。同じ内容で再送してください");
    return;
  }
  const item = cache.get(id);
  if (item === undefined) return;
  // Resolved drafts open READONLY (real quote/interpretation/source/
  // parent/target/status); only pending drafts allow dates + decisions.
  selectedId = id;
  parentSeq += 1;
  detailHidden = false;
  retryHidden = true;
  renderDetail(true);
}

/** Read one newest-first history page behind the stored keyset cursor. */
async function loadOlderHistory(): Promise<void> {
  const sessionId = readSession();
  if (sessionId === null || destroyed) return;
  const cursor = historyCursor;
  if (cursor === null) return;
  const session = sessionSeq;
  let res: { status: number; body: unknown };
  try {
    res = await fetchJson(
      `/api/sessions/${sessionId}/conversation-proposals?limit=50&cursor=${encodeURIComponent(cursor)}`,
    );
  } catch {
    if (session === sessionSeq) {
      setStatus("古い履歴の読み込みに失敗しました");
    }
    return;
  }
  if (session !== sessionSeq) return;
  if (res.status !== 200) {
    setStatus("古い履歴の読み込みに失敗しました");
    return;
  }
  // The open drawer (selection, typed dates, frozen metadata) is
  // preserved: older rows only merge into the list, never reset it.
  for (const item of readItems(res.body)) {
    if (item.sessionId === sessionId) cache.set(item.id, item);
  }
  historyCursor = readCursor(res.body);
  historyHasMore = readHasMore(res.body);
  const count = readPendingCount(res.body);
  if (count >= 0) totalPending = count;
  renderAll();
  if (selectedId !== null) renderDetail(false);
}

async function refresh(): Promise<void> {
  const sessionId = readSession();
  if (sessionId === null || destroyed) return;
  // Session change = legacy notifySessionChanged: sync-invalidate every
  // in-flight generation and all cached state BEFORE the boot read, so a
  // previous session's rows/drawer/frozen op can never leak across. The
  // FIRST boot (no listed session yet) must NOT reset: the state is still
  // empty and a reset would erase a just-committed op's status/rows.
  if (listedSession !== null && listedSession !== sessionId) resetState();
  listedSession = sessionId;
  const session = sessionSeq;
  listSeq += 1;
  const seen = listSeq;
  const pending: ProposalView[] = [];
  let history: ProposalView[] = [];
  let nextCursor: string | null = null;
  let nextHasMore = false;
  let pendingCountRead = -1;
  try {
    // Drain the OWN pending queue first (status filter, keyset pages;
    // bounded by the small pending cap so an old pending draft buried
    // under newer decisions stays reachable), then read the newest
    // history page. Older history stays behind the explicit "load
    // older" affordance — never a full materialization on refresh.
    let cursor: string | undefined;
    for (let n = 0; n < 25; n += 1) {
      const url =
        cursor === undefined
          ? `/api/sessions/${sessionId}/conversation-proposals?limit=50&status=pending`
          : `/api/sessions/${sessionId}/conversation-proposals?limit=50&status=pending&cursor=${encodeURIComponent(cursor)}`;
      const res = await fetchJson(url);
      if (res.status !== 200) throw new Error("pending page failed");
      if (session !== sessionSeq || seen !== listSeq) return;
      for (const item of readItems(res.body)) {
        if (item.sessionId === sessionId) pending.push(item);
      }
      const count = readPendingCount(res.body);
      if (count >= 0) pendingCountRead = count;
      const next = readCursor(res.body);
      if (next === null || !readHasMore(res.body)) break;
      cursor = next;
    }
    const hist = await fetchJson(
      `/api/sessions/${sessionId}/conversation-proposals?limit=50`,
    );
    if (hist.status !== 200) throw new Error("history page failed");
    if (session !== sessionSeq || seen !== listSeq) return;
    history = readItems(hist.body).filter(
      (item) => item.sessionId === sessionId,
    );
    nextCursor = readCursor(hist.body);
    nextHasMore = readHasMore(hist.body);
    const count = readPendingCount(hist.body);
    if (count >= 0) pendingCountRead = count;
  } catch {
    if (session === sessionSeq && seen === listSeq) {
      setStatus("候補の読み込みに失敗しました");
    }
    return;
  }
  if (session !== sessionSeq || seen !== listSeq) return;
  // Merge fresh pages into the map (never clear): older pages loaded via
  // "古い履歴を読み込む" stay reachable, and a 409 re-read never drops
  // the older-page row behind the frozen op.
  for (const item of pending) cache.set(item.id, item);
  for (const item of history) cache.set(item.id, item);
  historyCursor = nextCursor;
  historyHasMore = nextHasMore;
  if (pendingCountRead >= 0) totalPending = pendingCountRead;
  // A selected draft NOT on the fresh pages (pending queue or newest
  // history page) is NOT gone: it may live on an older page. Fetch it
  // directly even though the map still has it — the map's copy may be
  // stale. Close the drawer only when the server says it is gone (404).
  // An unresolved frozen op keeps its drawer pinned without any fetch.
  if (pendingOp === null && selectedId !== null) {
    if (![...pending, ...history].some((item) => item.id === selectedId)) {
      const missing = selectedId;
      try {
        const single = await fetchJson(
          `/api/sessions/${sessionId}/conversation-proposals/${missing}`,
        );
        if (session !== sessionSeq || seen !== listSeq) return;
        if (single.status === 200 && isProposalView(single.body)) {
          cache.set(missing, single.body);
        } else if (single.status === 404) {
          selectedId = null;
          detailHidden = true;
        }
      } catch {
        // Network loss: keep the stale selection (never close on a
        // failed read); the next refresh retries.
      }
    }
  }
  renderAll();
  // Deep-link reveal: /learning source links land on /proposals#<record
  // id>; scroll/focus that row once the list has rendered (retries until
  // the data load finishes).
  revealHashTarget();
  // Keep the open drawer truthful after a background refresh without
  // clobbering the human's typed date inputs.
  if (selectedId !== null) renderDetail(false);
}

async function loadParentTitle(item: ProposalView): Promise<void> {
  const session = sessionSeq;
  // Bind this read to the exact selection + generation: a late reply for
  // a previous selection must never overwrite the shown draft's parent.
  const selected = selectedId;
  const parentId = item.parentPurposeId;
  const gen = parentSeq;
  if (item.parentPurposeId === null) {
    if (selected === selectedId) {
      parentText = "親の目的：なし（異常）";
    }
    return;
  }
  try {
    const res = await fetchJson(
      `/api/sessions/${item.sessionId}/purposes/${item.parentPurposeId}`,
    );
    if (session !== sessionSeq || gen !== parentSeq) return;
    if (selectedId !== selected) return;
    const current = cache.get(item.id);
    if (current?.parentPurposeId !== parentId) return;
    if (res.status === 200 && isRecord(res.body)) {
      const statement = res.body.statement;
      const version = res.body.version;
      const status = res.body.status;
      if (
        typeof statement === "string" &&
        typeof version === "number" &&
        typeof status === "string"
      ) {
        // Show the STAGED pinned parent version (immutable), never the
        // fetched current version as the referenced one: a correction
        // or revocation after staging must not be misread as the pinned
        // reference, and accepting a drifted parent is a guaranteed
        // conflict. Flag current-version or inactive-status drift.
        const expected = item.expectedParentVersion;
        let text = `親の目的（採用時に再確認・変更不可）: ${statement}（提案時の版 ${String(expected)}／現在 ${String(version)}）`;
        if (version !== expected) {
          text += "⚠ 現在の版と一致しません（採用時に競合します）";
        }
        if (status !== "active") {
          text += `⚠ 親は現在${status}です`;
        }
        parentText = text;
        return;
      }
    }
    parentText = "親の目的は現在確認できません（採用時に再確認されます）";
  } catch {
    if (session !== sessionSeq || gen !== parentSeq) return;
    if (selectedId !== selected) return;
    const current = cache.get(item.id);
    if (current?.parentPurposeId !== parentId) return;
    parentText = "親の目的は現在確認できません（採用時に再確認されます）";
  }
}

function frozenBody(item: ProposalView): Record<string, unknown> | null {
  const body: Record<string, unknown> = {
    expectedVersion: item.version,
  };
  if (item.target === "task") {
    const deadline = dateFrom.trim();
    if (deadline.length > 0) body.deadline = deadline;
  } else {
    const from = dateFrom.trim();
    const until = dateUntil.trim();
    if (from.length > 0) body.validFrom = from;
    if (until.length > 0) body.validUntil = until;
  }
  return body;
}

async function commitAccept(): Promise<void> {
  const item = selectedId === null ? undefined : cache.get(selectedId);
  const sessionId = readSession();
  // A frozen unresolved operation owns the decision: no fresh accept may
  // overwrite its key/body while it is unresolved (retry it instead).
  if (pendingOp !== null) {
    setStatus("未確定の操作があります。同じ内容で再送してください");
    return;
  }
  if (
    item === undefined ||
    sessionId === null ||
    opInFlight ||
    item.status !== "pending"
  ) {
    return;
  }
  const body = frozenBody(item);
  if (body === null) return;
  // Freeze {key, version, date fields} BEFORE the first send: every retry
  // (including the explicit retry after a lost response) reuses the
  // identical triple, so a redelivered POST replays ONE adoption.
  pendingOp = {
    proposalId: item.id,
    ownerSession: sessionId,
    endpoint: `/api/sessions/${sessionId}/conversation-proposals/${item.id}/accept`,
    key: newKey(),
    body,
  };
  opInFlight = true;
  renderDetail(false);
  await sendPendingOp();
}

async function commitReject(): Promise<void> {
  const item = selectedId === null ? undefined : cache.get(selectedId);
  const sessionId = readSession();
  // Same ownership as accept: a frozen op blocks every fresh decision
  // (explicit reject creates no preference write of its own either).
  if (pendingOp !== null) {
    setStatus("未確定の操作があります。同じ内容で再送してください");
    return;
  }
  if (
    item === undefined ||
    sessionId === null ||
    opInFlight ||
    item.status !== "pending"
  ) {
    return;
  }
  pendingOp = {
    proposalId: item.id,
    ownerSession: sessionId,
    endpoint: `/api/sessions/${sessionId}/conversation-proposals/${item.id}/reject`,
    key: newKey(),
    body: { expectedVersion: item.version },
  };
  opInFlight = true;
  renderDetail(false);
  await sendPendingOp();
}

/** Explicit same-key retry of the frozen pending op (no new key). */
async function retryPendingOp(): Promise<void> {
  if (pendingOp === null || opInFlight) return;
  opInFlight = true;
  renderDetail(false);
  await sendPendingOp();
}

async function sendPendingOp(): Promise<void> {
  const op = pendingOp;
  const session = sessionSeq;
  if (op === null) {
    opInFlight = false;
    return;
  }
  let res: { status: number; body: unknown };
  try {
    res = await postJson(op.endpoint, op.body, op.key);
  } catch {
    // postJson normally resolves {status:0} on a lost response; a throw is
    // treated identically (uncertain loss, frozen op survives).
    res = { status: 0, body: null };
  }
  if (res.status === 0) {
    // Uncertain response loss: the frozen op SURVIVES (same-key retry
    // offered, never a new key, never an overwrite).
    if (session !== sessionSeq) return;
    opInFlight = false;
    retryHidden = false;
    setStatus("応答が不確定です。同じ内容で再送してください");
    renderDetail(false);
    return;
  }
  if (session !== sessionSeq) return;
  const sessionId = readSession();
  if (sessionId === null || sessionId !== op.ownerSession) return;
  if (res.status === 201 || res.status === 200) {
    pendingOp = null;
    opInFlight = false;
    retryHidden = true;
    setStatus(res.status === 201 ? "採用しました" : "見送りにしました");
    // Apply the deterministic returned view BEFORE the refresh so the
    // history list stays truthful if the page fetch lags (session must
    // match). An old pending proposal sits outside the newest 50-row
    // history page, so a merge-only refresh would keep it rendered as
    // pending forever (the success path clears selectedId, so no direct
    // fetch can correct it). The drawer closes either way (the decision
    // is final).
    if (isProposalView(res.body) && res.body.sessionId === op.ownerSession) {
      cache.set(res.body.id, res.body);
    }
    if (isRecord(res.body) && isProposalView(res.body)) {
      cache.set(op.proposalId, res.body);
    }
    renderAll();
    selectedId = null;
    detailHidden = true;
    await refresh();
    // Refresh the adopted purpose/task target via the existing public
    // hook without losing unrelated drafts (the drawer just closed). On
    // the native page the owning surface is the chat shell's own action
    // view; the shared hook stays best effort (the adoption already
    // committed).
    try {
      window.dispatchEvent(new CustomEvent("ch:run-settled"));
    } catch {
      // Best effort: the adoption already committed.
    }
    return;
  }
  if (res.status === 409) {
    // Definitive conflict (version drift, parent change, or key reuse):
    // re-read the truth, then CLEAR the frozen op — retrying the
    // identical frozen body could never succeed, so keeping it would pin
    // the drawer forever. Only network loss and 5xx/503 keep the frozen
    // op (handled above/below).
    opInFlight = false;
    await refresh();
    if (session !== sessionSeq) return;
    // The 409 names THIS proposal: re-read it DIRECTLY (it may live on
    // an older page) so the message evaluates against the committed
    // truth before the human re-commits.
    try {
      const single = await fetchJson(
        `/api/sessions/${op.ownerSession}/conversation-proposals/${op.proposalId}`,
      );
      if (session !== sessionSeq) return;
      if (
        single.status === 200 &&
        isProposalView(single.body) &&
        single.body.sessionId === op.ownerSession
      ) {
        cache.set(op.proposalId, single.body);
      }
    } catch {
      // Network loss on the re-read: the refresh above still ran.
    }
    pendingOp = null;
    retryHidden = true;
    const current = cache.get(op.proposalId);
    if (current === undefined) {
      setStatus("候補が見つかりません（別セッションの可能性）");
      selectedId = null;
      detailHidden = true;
    } else if (current.status !== "pending") {
      setStatus(
        current.status === "accepted"
          ? "採用されています（履歴を確認してください）"
          : "見送りになっています（履歴を確認してください）",
      );
    } else {
      setStatus(
        "競合しました（版ずれ・親の変更・キーの再利用）。内容を確認して入力し直してください",
      );
    }
    renderAll();
    if (selectedId !== null) renderDetail(false);
    return;
  }
  if (res.status === 400) {
    // Definitive validation rejection (including invalid/inverted human
    // dates): the identical body can never succeed, so clear the frozen
    // op and keep the drawer + typed dates for correction (never pin the
    // drawer with a same-body retry that leaves the controls disabled).
    pendingOp = null;
    opInFlight = false;
    retryHidden = true;
    setStatus("入力が不正です（内容を確認して入力し直してください）");
    renderDetail(false);
    return;
  }
  if (res.status === 404) {
    pendingOp = null;
    opInFlight = false;
    retryHidden = true;
    setStatus("候補が見つかりません（別セッションの可能性）");
    selectedId = null;
    detailHidden = true;
    await refresh();
    return;
  }
  opInFlight = false;
  retryHidden = false;
  setStatus("操作に失敗しました。同じ内容で再送できます");
  renderDetail(false);
}

// Mount: boot the quiet list for the adopted session; unmount: invalidate
// every in-flight generation (legacy destroy/notifySessionChanged).
$effect(() => {
  renderAll();
  void refresh();
  // The chat shell boots the session asynchronously: the panel re-binds
  // (sync reset + boot) as soon as the stored session id appears or
  // changes, and refreshes on the run-settled hook (chat window event).
  const watcher = window.setInterval(() => {
    if (destroyed) return;
    if (listedSession !== readSession()) void refresh();
  }, 400);
  const onSettled = (): void => {
    void refresh();
  };
  // Composer lifecycle: a natural break may show the quiet brief (the
  // legacy client painted the composer and called notifyComposureChanged).
  const onInput = (event: Event): void => {
    if ((event.target as HTMLElement | null)?.id === "composer-input") {
      maybeBrief();
    }
  };
  const onVisible = (): void => {
    if (document.visibilityState === "visible") maybeBrief();
  };
  window.addEventListener(SETTLED_EVENT, onSettled);
  document.addEventListener("input", onInput);
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    destroyed = true;
    sessionSeq += 1;
    window.clearInterval(watcher);
    window.removeEventListener(SETTLED_EVENT, onSettled);
    document.removeEventListener("input", onInput);
    document.removeEventListener("visibilitychange", onVisible);
  };
});
</script>

<section id="proposals" aria-label="会話の候補" class="feature-panel">
  <h2>会話の候補</h2>
  <p id="proposal-badge" aria-live="polite">{badgeText}</p>
  <p id="proposal-brief" aria-live="polite">{briefText}</p>
  <ul id="proposal-list">
    {#each rows as item (item.id)}
      <li id={item.id}>
        <button type="button" onclick={() => select(item.id)}>
          {rowLabel(item)}
        </button>
      </li>
    {/each}
  </ul>
  <button
    id="proposal-refresh"
    type="button"
    onclick={() => void refresh()}
  >
    候補を更新
  </button>
  <button
    id="proposal-more"
    type="button"
    hidden={historyMoreHidden}
    onclick={() => void loadOlderHistory()}
  >
    古い履歴を読み込む
  </button>
  <div id="proposal-detail" hidden={detailHidden}>
    <div id="proposal-detail-body">
      {#each detailLines as line}
        <p>{line}</p>
      {/each}
    </div>
    <p id="proposal-parent" aria-live="polite">{parentText}</p>
    <p id="proposal-date-label">{dateLabelText}</p>
    <input
      id="proposal-date"
      type="text"
      autocomplete="off"
      bind:value={dateFrom}
      disabled={dateDisabled}
    />
    <input
      id="proposal-date-until"
      type="text"
      autocomplete="off"
      bind:value={dateUntil}
      hidden={untilHidden}
      disabled={untilDisabled}
    />
    <button
      id="proposal-accept"
      type="button"
      disabled={acceptDisabled}
      onclick={() => void commitAccept()}
    >
      採用する
    </button>
    <button
      id="proposal-reject"
      type="button"
      disabled={rejectDisabled}
      onclick={() => void commitReject()}
    >
      見送る
    </button>
  </div>
  <!-- The frozen-request retry + op status belong to the section, NOT
       the detail drawer: the drawer stays hidden until a draft is
       selected, so a retry nested inside it could never be pressed
       after an uncertain POST with no selection. -->
  <button
    id="proposal-retry"
    type="button"
    hidden={retryHidden}
    onclick={() => void retryPendingOp()}
  >
    同じ内容で再送
  </button>
  <p id="proposal-status" aria-live="polite">{statusText}</p>
</section>
