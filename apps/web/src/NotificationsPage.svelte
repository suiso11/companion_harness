<script lang="ts">
// PR-5 native notifications page (port of the AV05 consumer panel,
// `apps/server/src/ui/notification_panel.ts`, markup from `ui/page.ts`).
//
// Same public API + DOM ids as the legacy panel, so the e2e specs run
// unchanged. Boundaries preserved exactly:
// - Reads never ack: opening a notice is a pure GET; only the explicit
//   「確認済みにする」button acks (receipt only).
// - Model text is UNTRUSTED: text interpolation only, never {@html}.
// - Routine notices brief ONLY on a natural break (no active run +
//   composer empty + document visible); otherwise a quiet 保留中 badge.
//   Urgent receipts render immediately but never steal focus/selection
//   or touch the composer draft.
// - Routine questions group (general vs cited-deadline separate).
// - Uncertain ack freezes key+N+{} IN MEMORY only (same-key retry, never
//   a new key on a lost response). Nothing is persisted.
// - Session/generation guards: a held old-session reply can never render
//   into the new session.
// - Boot captures the cursor baseline FIRST, then history, then the feed
//   (dedup by seq); reconnect replays `?after=<lastSeq>` (durable paging).
// - No approval/action dispatch: source buttons are not rendered here
//   (the shadow detail seam is not part of this page).

import ChatPage from "./ChatPage.svelte";
import { fetchJson, postJson } from "./lib/api.js";

// The chat shell stays mounted (the notifications specs use the composer
// draft + natural-break seam); this page is the route-specific content in
// the shared shell's feature slot (same pattern as MemoryPage).
import { getSessionId } from "./lib/session.svelte.js";

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 10_000;

interface NotificationView {
  readonly id: string;
  readonly sessionId: string;
  readonly seq: number;
  readonly scope: string;
  readonly kind: string;
  readonly priority: string;
  readonly briefText: string;
  readonly sourceKind: string;
  readonly sourceId: string;
  readonly sourceVersion: number | null;
  readonly sourceEpoch: number | null;
  readonly citedDeadlines: readonly string[];
  readonly outdated: boolean;
  readonly contextExpiryAt: number | null;
  readonly createdAt: number;
}

const KIND_TEXT: Record<string, string> = {
  progress: "進捗",
  proposal: "提案",
  question: "確認事項",
  deadline: "期限",
  commitment: "受領確認",
};

const PRIORITY_TEXT: Record<string, string> = {
  routine: "通常",
  urgent: "要確認（受領）",
};

const SOURCE_TEXT: Record<string, string> = {
  shadow_job: "試行の記録",
  action_receipt: "実行結果の受領",
  task_deadline: "作業の期限",
};

function textOf(map: Record<string, string>, key: string): string {
  return map[key] ?? "お知らせ";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isView(value: unknown): value is NotificationView {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.seq === "number" &&
    typeof value.scope === "string" &&
    typeof value.kind === "string" &&
    typeof value.priority === "string" &&
    typeof value.briefText === "string" &&
    typeof value.sourceKind === "string" &&
    typeof value.sourceId === "string" &&
    (value.sourceVersion === null || typeof value.sourceVersion === "number") &&
    (value.sourceEpoch === null || typeof value.sourceEpoch === "number") &&
    Array.isArray(value.citedDeadlines) &&
    typeof value.outdated === "boolean" &&
    (value.contextExpiryAt === null ||
      typeof value.contextExpiryAt === "number") &&
    typeof value.createdAt === "number"
  );
}

function formatInstant(ms: number): string {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (v: number): string => String(v).padStart(2, "0");
  return (
    `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** Locally outdated: stored flag OR context expiry already passed. */
function isLocallyOutdated(view: {
  readonly outdated: boolean;
  readonly contextExpiryAt: number | null;
}): boolean {
  if (view.outdated) return true;
  if (view.contextExpiryAt === null) return false;
  return view.contextExpiryAt <= Date.now();
}

function newKey(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `00000000-0000-4000-8000-${String(Date.now()).slice(-12).padStart(12, "0")}`;
  }
}

/** Natural break: no active run + composer empty + visible. The composer
 *  and run state live in the mounted chat shell; the DOM is the seam the
 *  legacy client injected (activeRunId === null ⇔ stop control visible). */
function isNaturalBreak(): boolean {
  if (document.visibilityState !== "visible") return false;
  const stop = document.getElementById("composer-stop");
  if (stop !== null && !stop.hidden) return false;
  const input = document.getElementById("composer-input");
  if (input === null) return false;
  return (input as HTMLTextAreaElement).value.trim().length === 0;
}

// ---- Non-reactive generation/session state (no stale overwrites). ----
let sessionSeq = 0;
let bootSeq = 0;
let feed: EventSource | null = null;
let reconnectTimer: number | null = null;
let reconnectDelay = RECONNECT_BASE_MS;
let oldestBefore: number | null = null;
let loadingOlder = false;
let baseline = 0;
/** Live checkpoint: last APPLIED (cached + routed) feed seq. History
 *  reads never move it; only ordered feed consumption advances it. */
let lastSeq = 0;
const seen = new Map<number, NotificationView>();
/** Seqs already routed through deliver() (history or feed) — the only
 *  delivery/nudge dedup. Separate from the `seen` history cache. */
const delivered = new Set<number>();
/** Routine seqs already briefed on a natural break (renderable groups). */
const briefed = new Set<number>();
const acked = new Set<string>();
let serverUnread: number | null = null;
const pendingRoutine: NotificationView[] = [];
let selectedId: string | null = null;
/** Frozen ack per notification id: owner session + key. A pending entry
 *  for A never leaks its error/retry affordance onto selection B, and no
 *  new ack for B may overwrite unresolved A. */
const pendingAcks = new Map<string, { ownerSession: string; key: string }>();
const ackFlight = new Set<string>();
let drainingFeed = false;
let destroyed = false;
let historyHasMore = false;

// ---- Render state (mirrors the legacy render* writes). ----
let badgeText = $state("");
let olderVisible = $state(false);
let olderDisabled = $state(false);
let detailVisible = $state(false);
let detailLines = $state<readonly string[]>([]);
let ackHidden = $state(true);
let retryHidden = $state(true);
let statusText = $state("");

interface UrgentRow {
  readonly id: string;
  readonly head: string;
  readonly body: string;
}
interface RoutineGroup {
  readonly title: string;
  readonly items: readonly { id: string; text: string }[];
}
interface HistoryRow {
  readonly key: number;
  readonly text: string;
}
let urgentRows = $state<readonly UrgentRow[]>([]);
let routineGroups = $state<readonly RoutineGroup[]>([]);
let historyRows = $state<readonly HistoryRow[]>([]);

function sessionFresh(session: number, sessionId: string): boolean {
  return session === sessionSeq && getSessionId() === sessionId;
}

function unreadCount(): number {
  if (serverUnread !== null) return Math.max(0, serverUnread);
  let count = 0;
  for (const view of seen.values()) {
    if (acked.has(view.id)) continue;
    if (isLocallyOutdated(view)) continue;
    count += 1;
  }
  return count;
}

function renderBadge(): void {
  const deferred = pendingRoutine.length;
  badgeText = deferred > 0 ? `保留中 ${deferred}件` : `未読 ${unreadCount()}件`;
}

function sourceLine(view: NotificationView): string {
  const parts = [
    textOf(SOURCE_TEXT, view.sourceKind),
    view.scope,
    textOf(KIND_TEXT, view.kind),
    textOf(PRIORITY_TEXT, view.priority),
  ];
  const when = formatInstant(view.createdAt);
  return when.length > 0 ? `${parts.join("・")}・${when}` : parts.join("・");
}

function renderUrgent(): void {
  const urgent = [...seen.values()]
    .filter(
      (v) =>
        v.priority === "urgent" && !isLocallyOutdated(v) && !acked.has(v.id),
    )
    .sort((a, b) => b.seq - a.seq)
    .slice(0, 5);
  urgentRows = urgent.map((view) => ({
    id: view.id,
    head: `要確認（受領）・${sourceLine(view)}`,
    body: view.briefText,
  }));
}

function renderRoutineGroups(): void {
  // Only explicitly BRIEFED (flushed on a natural break) routine notices
  // render as groups; deferred ones stay behind the badge and
  // pre-baseline history never briefs. History below keeps everything.
  const briefedRoutine = [...seen.values()].filter(
    (v) =>
      v.priority !== "urgent" &&
      briefed.has(v.seq) &&
      !isLocallyOutdated(v) &&
      !acked.has(v.id) &&
      v.seq > baseline,
  );
  if (briefedRoutine.length === 0) {
    routineGroups = [];
    return;
  }
  const questions = briefedRoutine.filter((v) => v.kind === "question");
  const others = briefedRoutine.filter((v) => v.kind !== "question");
  const general = questions.filter((v) => v.citedDeadlines.length === 0);
  const dated = questions.filter((v) => v.citedDeadlines.length > 0);
  const groups: RoutineGroup[] = [];
  if (general.length > 0)
    groups.push({
      title: `確認事項 ${general.length}件`,
      items: general.map((v) => ({
        id: v.id,
        text: `${v.scope}・${v.briefText}`,
      })),
    });
  if (dated.length > 0)
    groups.push({
      title: `期限付きの確認 ${dated.length}件`,
      items: dated.map((v) => ({
        id: v.id,
        text: `${v.scope}・${v.briefText}`,
      })),
    });
  if (others.length > 0)
    groups.push({
      title: `お知らせ ${others.length}件`,
      items: others.map((v) => ({
        id: v.id,
        text: `${v.scope}・${v.briefText}`,
      })),
    });
  routineGroups = groups;
}

function renderHistory(): void {
  const items = [...seen.values()].sort((a, b) => b.seq - a.seq);
  historyRows = items.map((view) => {
    const stale = isLocallyOutdated(view);
    const done = acked.has(view.id);
    return {
      key: view.seq,
      text:
        `${sourceLine(view)}・${view.briefText}` +
        (stale ? "・古い内容" : "") +
        (done ? "・確認済み" : ""),
    };
  });
}

function renderDetailShell(): void {
  const view =
    selectedId === null
      ? null
      : ([...seen.values()].find((v) => v.id === selectedId) ?? null);
  if (view === null) {
    detailVisible = false;
    return;
  }
  detailVisible = true;
  const lines: string[] = [sourceLine(view), view.briefText];
  if (view.citedDeadlines.length > 0) {
    lines.push(`引用された期限：${view.citedDeadlines.join("、")}`);
  }
  if (isLocallyOutdated(view)) lines.push("古い内容です（履歴表示のみ）");
  if (acked.has(view.id)) lines.push("確認済み");
  detailLines = lines;
  ackHidden = acked.has(view.id);
  const uncertain = pendingAcks.has(view.id);
  retryHidden = !uncertain;
  if (!acked.has(view.id) && !uncertain) statusText = "";
}

function renderOlderButton(): void {
  olderVisible = historyHasMore;
  olderDisabled = loadingOlder;
}

function renderAll(): void {
  renderBadge();
  renderUrgent();
  renderRoutineGroups();
  renderHistory();
  renderOlderButton();
  renderDetailShell();
}

/** Cache write: always replace the owned view; delivery dedup lives in
 *  `delivered`, never in `seen`. An outdated flip without a new seq
 *  therefore refreshes the view but can never re-nudge. */
function upsertSeen(view: NotificationView): void {
  for (const [seq, current] of seen) {
    if (current.id === view.id && seq !== view.seq) seen.delete(seq);
  }
  seen.set(view.seq, view);
}

/** Route one new notice: urgent now, routine deferred past break.
 *  Exactly-once via `delivered`; render-only state (focus, selection,
 *  composer text) is never touched here. */
function deliver(view: NotificationView): void {
  if (delivered.has(view.seq)) return;
  delivered.add(view.seq);
  if (isLocallyOutdated(view)) {
    renderAll();
    return;
  }
  if (view.priority === "urgent") {
    briefed.add(view.seq);
    renderAll();
    return;
  }
  // Routine: only brief on a natural break, else quiet badge.
  if (!pendingRoutine.some((v) => v.seq === view.seq)) {
    pendingRoutine.push(view);
  }
  if (isNaturalBreak()) {
    maybeFlushRoutine();
  } else {
    renderBadge();
  }
  renderAll();
}

function maybeFlushRoutine(): void {
  if (pendingRoutine.length === 0) return;
  if (!isNaturalBreak()) {
    renderBadge();
    return;
  }
  // Drop locally-expired while deferred (history keeps them, no nudge).
  const live = pendingRoutine.filter((v) => !isLocallyOutdated(v));
  pendingRoutine.length = 0;
  for (const view of live) briefed.add(view.seq);
  renderAll();
}

function clearReconnectTimer(): void {
  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect(session: number): void {
  if (destroyed || session !== sessionSeq) return;
  clearReconnectTimer();
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    if (session !== sessionSeq || destroyed) return;
    openFeed(session, lastSeq);
  }, delay);
}

function closeFeed(): void {
  if (feed !== null) {
    try {
      feed.close();
    } catch {
      // Best effort.
    }
    feed = null;
  }
}

function openFeed(session: number, after: number): void {
  closeFeed();
  const sessionId = getSessionId();
  if (sessionId === null || destroyed) return;
  if (session !== sessionSeq) return;
  let source: EventSource;
  try {
    source = new EventSource(
      `/api/sessions/${encodeURIComponent(sessionId)}/notifications/feed/stream?after=${after}`,
    );
  } catch {
    scheduleReconnect(session);
    return;
  }
  feed = source;
  source.onopen = () => {
    if (session !== sessionSeq || destroyed) return;
    reconnectDelay = RECONNECT_BASE_MS;
  };
  source.addEventListener("notification", () => {
    if (session !== sessionSeq) return;
    if (getSessionId() !== sessionId) return;
    // The SSE signal is only a wake-up: consume the durable forward page
    // (`seq > lastSeq ORDER BY seq ASC`) so records apply strictly in
    // feed order and a failed record blocks the checkpoint instead of
    // being skipped by a parallel per-record GET. The SSE `data` is
    // intentionally unread (it lacks citedDeadlines/expiry/version).
    void drainForward(session, sessionId);
  });
  source.onerror = () => {
    if (session !== sessionSeq) return;
    closeFeed();
    scheduleReconnect(session);
  };
}

/** Ordered feed consume: one durable forward page from the APPLIED
 *  checkpoint. Records apply strictly oldest-first; the checkpoint moves
 *  only past applied records, never beyond an unapplied one. On failure
 *  the cursor is retained, our own EventSource is closed (so the native
 *  Last-Event-ID auto-advance can never resume past the unconsumed
 *  record), and the existing bounded reconnect replays from the
 *  unresolved cursor. No server writes: pure reads only. */
async function drainForward(session: number, sessionId: string): Promise<void> {
  if (drainingFeed) return;
  drainingFeed = true;
  try {
    let guard = 0;
    for (;;) {
      const res = await fetchJson(
        `/api/sessions/${encodeURIComponent(sessionId)}/notifications/forward?after=${lastSeq}&limit=100`,
      );
      if (res.status === 0) {
        closeFeed();
        scheduleReconnect(session);
        return;
      }
      if (!sessionFresh(session, sessionId)) return;
      if (res.status !== 200 || !isRecord(res.body)) {
        closeFeed();
        scheduleReconnect(session);
        return;
      }
      const body = res.body as {
        items?: unknown;
        unreadCount?: unknown;
        hasMore?: unknown;
      };
      if (typeof body.unreadCount === "number" && body.unreadCount >= 0) {
        serverUnread = Math.floor(body.unreadCount);
      }
      if (!Array.isArray(body.items)) {
        closeFeed();
        scheduleReconnect(session);
        return;
      }
      for (const item of body.items) {
        if (!isView(item)) continue;
        if (item.sessionId !== sessionId) continue;
        upsertSeen(item);
        if (item.seq <= lastSeq) continue;
        if (!delivered.has(item.seq)) deliver(item);
        // Advance only after the record is cached + routed (applied).
        if (item.seq > lastSeq) lastSeq = item.seq;
      }
      if (body.hasMore !== true) break;
      guard += 1;
      if (guard >= 5) break;
    }
    renderAll();
  } finally {
    drainingFeed = false;
  }
}

async function refreshAckState(
  sessionId: string,
  notificationId: string,
  session: number,
): Promise<void> {
  const res = await fetchJson(
    `/api/sessions/${encodeURIComponent(sessionId)}/notifications/${encodeURIComponent(notificationId)}/history`,
  );
  if (session !== sessionSeq) return;
  if (getSessionId() !== sessionId) return;
  if (res.status !== 200 || !isRecord(res.body)) return;
  const ack = (res.body as { ack?: unknown }).ack;
  if (isRecord(ack) && !acked.has(notificationId)) {
    acked.add(notificationId);
    if (serverUnread !== null && serverUnread > 0) {
      serverUnread -= 1;
    }
    renderAll();
  }
}

async function loadNewest(session: number, boot: number): Promise<void> {
  const sessionId = getSessionId();
  if (sessionId === null) return;
  const result = await fetchJson(
    `/api/sessions/${encodeURIComponent(sessionId)}/notifications?limit=50`,
  );
  if (session !== sessionSeq || boot !== bootSeq) return;
  if (getSessionId() !== sessionId) return;
  if (result.status !== 200 || !isRecord(result.body)) return;
  const body = result.body as {
    items?: unknown;
    unreadCount?: unknown;
    hasMore?: unknown;
    nextBefore?: unknown;
  };
  if (!Array.isArray(body.items)) return;
  if (typeof body.unreadCount === "number" && body.unreadCount >= 0) {
    serverUnread = Math.floor(body.unreadCount);
  }
  // History is a CACHE read, never the live checkpoint: `lastSeq` stays
  // at the boot baseline until the feed actually consumes records, so
  // post-baseline arrivals that land before this response are still
  // replayed live instead of skipped. New post-baseline history rides
  // the SAME delivery/deferral path as the feed (deduped by `delivered`
  // across both); pre-baseline history stays quiet forever.
  for (const item of body.items) {
    if (!isView(item)) continue;
    if (item.sessionId !== sessionId) continue;
    upsertSeen(item);
    if (item.seq > baseline && !delivered.has(item.seq)) {
      deliver(item);
    }
  }
  historyHasMore = body.hasMore === true && typeof body.nextBefore === "number";
  oldestBefore =
    body.hasMore === true && typeof body.nextBefore === "number"
      ? body.nextBefore
      : null;
  // History read-through: mark acked receipts without extra POSTs.
  for (const item of [...seen.values()]) {
    void refreshAckState(sessionId, item.id, session);
  }
  renderAll();
}

async function boot(): Promise<void> {
  const sessionId = getSessionId();
  if (sessionId === null || destroyed) return;
  const session = sessionSeq;
  bootSeq += 1;
  const boot = bootSeq;
  // Baseline FIRST (cursor), then history, then feed — dedup by seq.
  // A failed/foreign baseline never falls back to zero (that would
  // mass-announce history as new); abort and retry via reconnect.
  let base: number | null = null;
  const cursor = await fetchJson(
    `/api/sessions/${encodeURIComponent(sessionId)}/notifications/feed/cursor`,
  );
  if (session !== sessionSeq || boot !== bootSeq) return;
  if (cursor.status === 200 && isRecord(cursor.body)) {
    const latest = (cursor.body as { latestSeq?: unknown }).latestSeq;
    if (typeof latest === "number" && Number.isSafeInteger(latest)) {
      base = latest;
    } else {
      scheduleReconnect(session);
      return;
    }
  } else {
    scheduleReconnect(session);
    return;
  }
  baseline = base;
  lastSeq = base;
  await loadNewest(session, boot);
  if (session !== sessionSeq || boot !== bootSeq) return;
  openFeed(session, lastSeq);
}

async function loadOlder(): Promise<void> {
  const sessionId = getSessionId();
  if (sessionId === null || oldestBefore === null || loadingOlder) return;
  const session = sessionSeq;
  loadingOlder = true;
  try {
    const res = await fetchJson(
      `/api/sessions/${encodeURIComponent(sessionId)}/notifications?limit=50&beforeSeq=${oldestBefore}`,
    );
    if (!sessionFresh(session, sessionId)) return;
    if (res.status !== 200 || !isRecord(res.body)) return;
    const body = res.body as {
      items?: unknown;
      hasMore?: unknown;
      nextBefore?: unknown;
    };
    if (!Array.isArray(body.items)) return;
    for (const item of body.items) {
      if (!isView(item)) continue;
      if (item.sessionId !== sessionId) continue;
      // Older pages are pure cache backfill: always refresh the owned
      // view (a terminal task can flip `outdated` without a new seq)
      // but never route delivery or move the live checkpoint.
      upsertSeen(item);
    }
    historyHasMore =
      body.hasMore === true && typeof body.nextBefore === "number";
    oldestBefore =
      body.hasMore === true && typeof body.nextBefore === "number"
        ? body.nextBefore
        : null;
    renderAll();
  } finally {
    loadingOlder = false;
    renderOlderButton();
  }
}

/** Open (read-only): pure GET, never an ack. */
async function selectNotification(notificationId: string): Promise<void> {
  const sessionId = getSessionId();
  if (sessionId === null) return;
  const session = sessionSeq;
  selectedId = notificationId;
  renderDetailShell();
  const res = await fetchJson(
    `/api/sessions/${encodeURIComponent(sessionId)}/notifications/${encodeURIComponent(notificationId)}/history`,
  );
  if (session !== sessionSeq) return;
  if (getSessionId() !== sessionId) return;
  if (selectedId !== notificationId) return;
  if (res.status !== 200 || !isRecord(res.body)) return;
  const body = res.body as { notification?: unknown; ack?: unknown };
  if (!isView(body.notification)) return;
  if (body.notification.sessionId !== sessionId) return;
  // Always replace the owned cached view: a terminal/cancelled task can
  // flip `outdated` without a new seq, and the discarded refresh would
  // leave detail/history stale. Delivery tracking is separate (`delivered`
  // / `briefed`), so the refreshed outdated view can never re-nudge.
  upsertSeen(body.notification);
  if (isRecord(body.ack) && !acked.has(notificationId)) {
    acked.add(notificationId);
    if (serverUnread !== null && serverUnread > 0) {
      serverUnread -= 1;
    }
  }
  renderAll();
}

/** Explicit retry: resend ONLY the frozen entry owned by the current
 *  selection (same id/key/body). A selection with no frozen entry never
 *  inherits another notice's error or retry affordance. */
async function retryPendingAck(): Promise<void> {
  const target = selectedId;
  if (target === null) return;
  if (!pendingAcks.has(target)) return;
  await commitAck();
}

/** Explicit ack: frozen key+N+{} in memory, same-key retry only.
 *  Ownership rules: the frozen entry belongs to its notice; starting a
 *  fresh ack for B while A is unresolved is blocked with an honest
 *  message (never overwrites A); late responses for a deselected notice
 *  mark only that notice's receipt and never rewrite the current
 *  selection's status. Still receipt-only: never approval/permission. */
async function commitAck(): Promise<void> {
  const sessionId = getSessionId();
  const target = selectedId;
  if (sessionId === null || target === null) return;
  const session = sessionSeq;
  let frozen = pendingAcks.get(target);
  if (frozen === undefined) {
    const other = [...pendingAcks.keys()].find((k) => k !== target);
    if (other !== undefined) {
      if (selectedId === target) {
        statusText = "別の確認の再送待ちです。先にそちらを再送してください。";
      }
      return;
    }
    frozen = { ownerSession: sessionId, key: newKey() };
    pendingAcks.set(target, frozen);
  }
  if (ackFlight.has(target)) return;
  ackFlight.add(target);
  const frozenTarget = target;
  const frozenEntry = frozen;
  if (selectedId === frozenTarget) {
    statusText = "確認を送信中…";
  }
  renderDetailShell();
  const res = await postJson(
    `/api/sessions/${encodeURIComponent(sessionId)}/notifications/${encodeURIComponent(frozenTarget)}/ack`,
    {},
    frozenEntry.key,
  );
  if (res.status === 0) {
    // Network-level uncertain (fetch threw in the legacy client).
    ackFlight.delete(frozenTarget);
    if (session !== sessionSeq) return;
    if (pendingAcks.get(frozenTarget) !== frozenEntry) return;
    if (frozenEntry.ownerSession !== getSessionId()) return;
    // Uncertain A stays frozen; B never inherits it.
    if (selectedId === frozenTarget) {
      statusText = "通信が不確かです。同じ内容で再送できます。";
      renderDetailShell();
    }
    return;
  }
  ackFlight.delete(frozenTarget);
  if (session !== sessionSeq) return;
  if (pendingAcks.get(frozenTarget) !== frozenEntry) return;
  if (frozenEntry.ownerSession !== getSessionId()) return;
  if (res.status === 200 || res.status === 201) {
    pendingAcks.delete(frozenTarget);
    if (!acked.has(frozenTarget)) {
      acked.add(frozenTarget);
      if (serverUnread !== null && serverUnread > 0) {
        serverUnread -= 1;
      }
    }
    if (selectedId === frozenTarget) {
      statusText = "確認済みにしました。";
    }
    renderAll();
    return;
  }
  if (res.status === 429 || res.status >= 500) {
    if (selectedId === frozenTarget) {
      statusText = "応答が不確かです。同じ内容で再送できます。";
      renderDetailShell();
    }
    return;
  }
  pendingAcks.delete(frozenTarget);
  if (selectedId === frozenTarget) {
    statusText = "確認できませんでした。";
    renderDetailShell();
  }
}

// Mount + session rebinding (shared reactive store): the feed boots for the
// adopted session and RE-BINDS on every session change — teardown closes the
// feed and invalidates every in-flight generation (legacy
// destroy/notifySessionChanged), then the new session boots fresh. The badge
// renders BEFORE the session boot (legacy reset() → renderAll() runs
// renderBadge even without a session, so `#notification-badge` is visible
// with 未読 0件 on a fresh page load).
$effect(() => {
  renderBadge();
  destroyed = false;
  void boot();
  const onInput = (event: Event): void => {
    if ((event.target as HTMLElement | null)?.id === "composer-input") {
      maybeFlushRoutine();
    }
  };
  const onVisible = (): void => {
    if (document.visibilityState === "visible") maybeFlushRoutine();
  };
  document.addEventListener("input", onInput);
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    destroyed = true;
    sessionSeq += 1;
    closeFeed();
    clearReconnectTimer();
    document.removeEventListener("input", onInput);
    document.removeEventListener("visibilitychange", onVisible);
  };
});
</script>

<svelte:head>
  <title>お知らせ · Companion Harness</title>
</svelte:head>

<ChatPage activePath="/notifications">
  {#snippet children()}
    <section id="notifications" aria-label="お知らせ" class="feature-panel">
  <h2>お知らせ</h2>
  <p id="notification-badge" aria-live="polite">{badgeText}</p>
  <div id="notification-urgent" aria-live="assertive">
    {#each urgentRows as row (row.id)}
      <div>
        <p>{row.head}</p>
        <p>{row.body}</p>
        <button
          type="button"
          onclick={() => void selectNotification(row.id)}
        >
          内容を見る
        </button>
      </div>
    {/each}
  </div>
  <div id="notification-routine" aria-live="polite">
    {#each routineGroups as group (group.title)}
      <h3>{group.title}</h3>
      <ul>
        {#each group.items as item (item.id)}
          <li>
            <span>{item.text}</span>
            <button
              type="button"
              onclick={() => void selectNotification(item.id)}
            >
              内容を見る
            </button>
          </li>
        {/each}
      </ul>
    {/each}
  </div>
  <ul id="notification-list">
    {#each historyRows as row (row.key)}
      <li>
        <span>{row.text}</span>
        <button
          type="button"
          onclick={() => {
            const view = [...seen.values()].find((v) => v.seq === row.key);
            if (view !== undefined) void selectNotification(view.id);
          }}
        >
          内容を見る
        </button>
      </li>
    {/each}
  </ul>
  <button
    id="notification-older"
    type="button"
    hidden={!olderVisible}
    disabled={olderDisabled}
    onclick={() => void loadOlder()}
  >
    古いお知らせを読み込む
  </button>
  <div id="notification-detail" hidden={!detailVisible}>
    <div id="notification-detail-body">
      {#each detailLines as line}
        <p>{line}</p>
      {/each}
    </div>
    <button
      id="notification-ack"
      type="button"
      hidden={ackHidden}
      onclick={() => void commitAck()}
    >
      確認済みにする
    </button>
    <button
      id="notification-retry"
      type="button"
      hidden={retryHidden}
      onclick={() => void retryPendingAck()}
    >
      同じ内容で再送
    </button>
    <p id="notification-status" aria-live="polite">{statusText}</p>
  </div>
    </section>
  {/snippet}
</ChatPage>
