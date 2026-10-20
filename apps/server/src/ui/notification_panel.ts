// AV05 notification consumer panel (plain DOM, no framework).
//
// Separate browser module (mirrors `shadow_panel.ts`): this file owns the
// "お知らせ" section only. HTTP helpers and session/composer state are
// INJECTED (no import from client.ts, no module cycle).
//
// Boundaries (pinned by regressions):
// - Reads never ack: opening/reading a notice never POSTs. Only the
//   explicit「確認済みにする」button acks (receipt only, never
//   approval/answer/permission).
// - Model text is UNTRUSTED: every string renders via `textContent` only —
//   never `innerHTML`, never links, never raw UUID walls.
// - Routine notices brief ONLY on a natural break (no active run +
//   composer empty + document visible); otherwise a quiet pending badge
//   counts. Urgent receipt alerts render immediately even while paused,
//   but NEVER steal focus/selection, never touch composer text, never
//   force-open a chat turn.
// - Routine questions group (general vs cited-TASK-deadline separate) to
//   avoid repeated interruptions. `contextExpiryAt` is NOT a deadline: an
//   outdated notice stays visible in history but is never re-nudged; a
//   deferred notice re-checks `Date.now()` against `contextExpiryAt`
//   before display.
// - Uncertain ack freezes key+N+{} IN MEMORY only (same-key retry, never a
//   new key on a lost response). No user/model body in localStorage.
// - Session guards: generations + EventSource abort invalidate SYNC, so a
//   held old-session reply can never render into the new session.
// - Boot captures the cursor baseline FIRST, then history, then the feed,
//   deduping by seq — so no new notice is lost to a cursor/history race
//   and old unread is never mass-announced. Reconnect replays
//   `?after=<lastSeq>` (durable paging, never latest-100 filter).
// - No approval/action dispatch: source buttons only navigate the existing
//   readonly shadow detail seam (`selectJob(jobId, version)`); otherwise
//   the source renders as human-readable text (no fake buttons).

/// <reference lib="dom" />

export interface NotificationHttp {
  get(path: string): Promise<{ status: number; body: unknown }>;
  post(
    path: string,
    payload: unknown,
    key: string,
  ): Promise<{ status: number; body: unknown }>;
}

export interface NotificationPanelDeps {
  getSessionId: () => string | null;
  /** Natural break: no active run + composer empty + visible. */
  isNaturalBreak: () => boolean;
  http: NotificationHttp;
  /** Readonly shadow-detail seam (when present). */
  selectShadowJob?: (jobId: string, version: number) => Promise<void> | void;
  randomKey?: () => string;
}

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
  ops: "システム通知",
};

const PRIORITY_TEXT: Record<string, string> = {
  routine: "通常",
  urgent: "要確認（受領）",
};

// Urgent items with kind="ops" are system failures, not receipt
// confirmations — give them their own heading instead of 要確認（受領）.
function urgentHeadLabel(view: NotificationView): string {
  return view.kind === "ops" ? "要確認（ops）" : "要確認（受領）";
}

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
export function isLocallyOutdated(view: {
  readonly outdated: boolean;
  readonly contextExpiryAt: number | null;
}): boolean {
  if (view.outdated) return true;
  if (view.contextExpiryAt === null) return false;
  return view.contextExpiryAt <= Date.now();
}

export class NotificationPanel {
  private static readonly RECONNECT_BASE_MS = 1000;
  private static readonly RECONNECT_MAX_MS = 10_000;

  private readonly deps: NotificationPanelDeps;
  private badge: HTMLElement | null = null;
  private urgentBox: HTMLElement | null = null;
  private routineBox: HTMLElement | null = null;
  private list: HTMLElement | null = null;
  private olderButton: HTMLButtonElement | null = null;
  private detail: HTMLElement | null = null;
  private detailBody: HTMLElement | null = null;
  private ackButton: HTMLButtonElement | null = null;
  private retryButton: HTMLButtonElement | null = null;
  private status: HTMLElement | null = null;

  private sessionSeq = 0;
  private bootSeq = 0;
  private feed: EventSource | null = null;
  private reconnectTimer: number | null = null;
  private reconnectDelay = NotificationPanel.RECONNECT_BASE_MS;
  private oldestBefore: number | null = null;
  private historyHasMore = false;
  private loadingOlder = false;
  private baseline = 0;
  /** Live checkpoint: last APPLIED (cached + routed) feed seq. History
   *  reads never move it; only ordered feed consumption advances it. */
  private lastSeq = 0;
  private readonly seen = new Map<number, NotificationView>();
  /** Seqs already routed through deliver() (history or feed) — the only
   *  delivery/nudge dedup. Separate from the `seen` history cache. */
  private readonly delivered = new Set<number>();
  /** Routine seqs already briefed on a natural break (renderable groups). */
  private readonly briefed = new Set<number>();
  private readonly acked = new Set<string>();
  private serverUnread: number | null = null;
  private readonly pendingRoutine: NotificationView[] = [];
  private selectedId: string | null = null;
  /** Frozen ack per notification id: owner session + key + in-flight guard.
   *  A pending entry for A never leaks its error/retry affordance onto
   *  selection B, and no new ack for B may overwrite unresolved A. */
  private readonly pendingAcks = new Map<
    string,
    { ownerSession: string; key: string }
  >();
  private readonly ackFlight = new Set<string>();
  private drainingFeed = false;
  private destroyed = false;

  constructor(deps: NotificationPanelDeps) {
    this.deps = deps;
  }

  bind(): void {
    const required = <T extends HTMLElement>(id: string): T => {
      const node = document.getElementById(id);
      if (node === null) throw new Error(`notification node missing: ${id}`);
      return node as T;
    };
    required<HTMLElement>("notifications");
    this.badge = required<HTMLElement>("notification-badge");
    this.urgentBox = required<HTMLElement>("notification-urgent");
    this.routineBox = required<HTMLElement>("notification-routine");
    this.list = required<HTMLElement>("notification-list");
    this.olderButton = required<HTMLButtonElement>("notification-older");
    this.detail = required<HTMLElement>("notification-detail");
    this.detailBody = required<HTMLElement>("notification-detail-body");
    this.ackButton = required<HTMLButtonElement>("notification-ack");
    this.retryButton = required<HTMLButtonElement>("notification-retry");
    this.status = required<HTMLElement>("notification-status");
    this.olderButton.addEventListener("click", () => {
      void this.loadOlder();
    });
    this.ackButton.addEventListener("click", () => {
      void this.commitAck();
    });
    this.retryButton.addEventListener("click", () => {
      void this.retryPendingAck();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") this.maybeFlushRoutine();
    });
  }

  /** Session lifecycle: abort feed/listeners, clear state, boot new S. */
  notifySessionChanged(): void {
    this.sessionSeq += 1;
    this.closeFeed();
    this.clearReconnect();
    this.seen.clear();
    this.acked.clear();
    this.delivered.clear();
    this.briefed.clear();
    this.pendingRoutine.length = 0;
    this.pendingAcks.clear();
    this.ackFlight.clear();
    this.drainingFeed = false;
    this.selectedId = null;
    this.oldestBefore = null;
    this.historyHasMore = false;
    this.baseline = 0;
    this.lastSeq = 0;
    this.serverUnread = null;
    this.resetReconnectBackoff();
    if (this.detail !== null) this.detail.hidden = true;
    if (this.retryButton !== null) this.retryButton.hidden = true;
    this.renderAll();
    void this.boot();
  }

  /** Composer/run lifecycle: a natural break may flush deferred routine. */
  notifyComposureChanged(): void {
    this.maybeFlushRoutine();
  }

  destroy(): void {
    this.destroyed = true;
    this.sessionSeq += 1;
    this.closeFeed();
    this.clearReconnect();
  }

  private newKey(): string {
    try {
      const gen = this.deps.randomKey;
      if (gen !== undefined) return gen();
      return crypto.randomUUID();
    } catch {
      return `00000000-0000-4000-8000-${String(Date.now()).slice(-12).padStart(12, "0")}`;
    }
  }

  private async boot(): Promise<void> {
    const sessionId = this.deps.getSessionId();
    if (sessionId === null || this.destroyed) return;
    const session = this.sessionSeq;
    this.bootSeq += 1;
    const boot = this.bootSeq;
    // Baseline FIRST (cursor), then history, then feed — dedup by seq.
    // A failed/foreign baseline never falls back to zero (that would
    // mass-announce history as new); abort and retry via reconnect.
    let base: number | null = null;
    try {
      const cursor = await this.deps.http.get(
        `/api/sessions/${encodeURIComponent(sessionId)}/notifications/feed/cursor`,
      );
      if (session !== this.sessionSeq || boot !== this.bootSeq) return;
      if (cursor.status === 200 && isRecord(cursor.body)) {
        const latest = (cursor.body as { latestSeq?: unknown }).latestSeq;
        if (typeof latest === "number" && Number.isSafeInteger(latest)) {
          base = latest;
        } else {
          this.scheduleReconnect(session);
          return;
        }
      } else {
        this.scheduleReconnect(session);
        return;
      }
    } catch {
      if (session !== this.sessionSeq || boot !== this.bootSeq) return;
      this.scheduleReconnect(session);
      return;
    }
    this.baseline = base;
    this.lastSeq = base;
    await this.loadNewest(session, boot);
    if (session !== this.sessionSeq || boot !== this.bootSeq) return;
    this.openFeed(session, this.lastSeq);
  }

  private async loadNewest(session: number, boot: number): Promise<void> {
    const sessionId = this.deps.getSessionId();
    if (sessionId === null) return;
    let result: { status: number; body: unknown };
    try {
      result = await this.deps.http.get(
        `/api/sessions/${encodeURIComponent(sessionId)}/notifications?limit=50`,
      );
    } catch {
      return;
    }
    if (session !== this.sessionSeq || boot !== this.bootSeq) return;
    if (sessionId !== this.deps.getSessionId()) return;
    if (result.status !== 200 || !isRecord(result.body)) return;
    const body = result.body as {
      items?: unknown;
      latestSeq?: unknown;
      unreadCount?: unknown;
      hasMore?: unknown;
      nextBefore?: unknown;
    };
    if (!Array.isArray(body.items)) return;
    if (typeof body.unreadCount === "number" && body.unreadCount >= 0) {
      this.serverUnread = Math.floor(body.unreadCount);
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
      this.upsertSeen(item);
      if (item.seq > this.baseline && !this.delivered.has(item.seq)) {
        this.deliver(item);
      }
    }
    this.historyHasMore =
      body.hasMore === true && typeof body.nextBefore === "number";
    this.oldestBefore =
      body.hasMore === true && typeof body.nextBefore === "number"
        ? body.nextBefore
        : null;
    // History read-through: mark acked receipts without extra POSTs.
    for (const item of [...this.seen.values()]) {
      void this.refreshAckState(sessionId, item.id, session);
    }
    this.renderAll();
  }

  private async refreshAckState(
    sessionId: string,
    notificationId: string,
    session: number,
  ): Promise<void> {
    let res: { status: number; body: unknown };
    try {
      res = await this.deps.http.get(
        `/api/sessions/${encodeURIComponent(sessionId)}/notifications/${encodeURIComponent(notificationId)}/history`,
      );
    } catch {
      return;
    }
    if (session !== this.sessionSeq) return;
    if (sessionId !== this.deps.getSessionId()) return;
    if (res.status !== 200 || !isRecord(res.body)) return;
    const ack = (res.body as { ack?: unknown }).ack;
    if (isRecord(ack) && !this.acked.has(notificationId)) {
      this.acked.add(notificationId);
      if (this.serverUnread !== null && this.serverUnread > 0) {
        this.serverUnread -= 1;
      }
      this.renderAll();
    }
  }

  private async loadOlder(): Promise<void> {
    const sessionId = this.deps.getSessionId();
    if (sessionId === null || this.oldestBefore === null || this.loadingOlder) {
      return;
    }
    const session = this.sessionSeq;
    this.loadingOlder = true;
    try {
      const res = await this.deps.http.get(
        `/api/sessions/${encodeURIComponent(sessionId)}/notifications?limit=50&beforeSeq=${this.oldestBefore}`,
      );
      if (session !== this.sessionSeq) return;
      if (sessionId !== this.deps.getSessionId()) return;
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
        this.upsertSeen(item);
      }
      this.historyHasMore =
        body.hasMore === true && typeof body.nextBefore === "number";
      this.oldestBefore =
        body.hasMore === true && typeof body.nextBefore === "number"
          ? body.nextBefore
          : null;
      this.renderAll();
    } finally {
      this.loadingOlder = false;
      this.renderOlderButton();
    }
  }

  private openFeed(session: number, after: number): void {
    this.closeFeed();
    const sessionId = this.deps.getSessionId();
    if (sessionId === null || this.destroyed) return;
    if (session !== this.sessionSeq) return;
    let source: EventSource;
    try {
      source = new EventSource(
        `/api/sessions/${encodeURIComponent(sessionId)}/notifications/feed/stream?after=${after}`,
      );
    } catch {
      this.scheduleReconnect(session);
      return;
    }
    this.feed = source;
    source.onopen = () => {
      if (session !== this.sessionSeq || this.destroyed) return;
      this.resetReconnectBackoff();
    };
    source.addEventListener("notification", () => {
      if (session !== this.sessionSeq) return;
      if (sessionId !== this.deps.getSessionId()) return;
      // The SSE signal is only a wake-up: consume the durable forward page
      // (`seq > lastSeq ORDER BY seq ASC`) so records apply strictly in
      // feed order and a failed record blocks the checkpoint instead of
      // being skipped by a parallel per-record GET. The SSE `data` is
      // intentionally unread (it lacks citedDeadlines/expiry/version).
      void this.drainForward(session, sessionId);
    });
    source.onerror = () => {
      if (session !== this.sessionSeq) return;
      this.closeFeed();
      this.scheduleReconnect(session);
    };
  }

  /**
   * Ordered feed consume: one durable forward page from the APPLIED
   * checkpoint. Records apply strictly oldest-first; the checkpoint moves
   * only past applied records, never beyond an unapplied one. On failure
   * the cursor is retained, our own EventSource is closed (so the native
   * Last-Event-ID auto-advance can never resume past the unconsumed
   * record), and the existing bounded reconnect replays from the
   * unresolved cursor. No server writes: pure reads only.
   */
  private async drainForward(
    session: number,
    sessionId: string,
  ): Promise<void> {
    if (this.drainingFeed) return;
    this.drainingFeed = true;
    try {
      let guard = 0;
      for (;;) {
        let res: { status: number; body: unknown };
        try {
          res = await this.deps.http.get(
            `/api/sessions/${encodeURIComponent(sessionId)}/notifications/forward?after=${this.lastSeq}&limit=100`,
          );
        } catch {
          this.closeFeed();
          this.scheduleReconnect(session);
          return;
        }
        if (session !== this.sessionSeq) return;
        if (sessionId !== this.deps.getSessionId()) return;
        if (res.status !== 200 || !isRecord(res.body)) {
          this.closeFeed();
          this.scheduleReconnect(session);
          return;
        }
        const body = res.body as {
          items?: unknown;
          unreadCount?: unknown;
          hasMore?: unknown;
        };
        if (
          typeof (body as { unreadCount?: unknown }).unreadCount === "number" &&
          (body as { unreadCount: number }).unreadCount >= 0
        ) {
          this.serverUnread = Math.floor(
            (body as { unreadCount: number }).unreadCount,
          );
        }
        if (!Array.isArray(body.items)) {
          this.closeFeed();
          this.scheduleReconnect(session);
          return;
        }
        for (const item of body.items) {
          if (!isView(item)) continue;
          if (item.sessionId !== sessionId) continue;
          this.upsertSeen(item);
          if (item.seq <= this.lastSeq) continue;
          if (!this.delivered.has(item.seq)) this.deliver(item);
          // Advance only after the record is cached + routed (applied).
          if (item.seq > this.lastSeq) this.lastSeq = item.seq;
        }
        if (body.hasMore !== true) break;
        guard += 1;
        if (guard >= 5) break;
      }
      this.renderAll();
    } finally {
      this.drainingFeed = false;
    }
  }

  /** Cache write: always replace the owned view; delivery dedup lives in
   *  `delivered`, never in `seen`. An outdated flip without a new seq
   *  therefore refreshes the view but can never re-nudge. */
  private upsertSeen(view: NotificationView): void {
    for (const [seq, current] of this.seen) {
      if (current.id === view.id && seq !== view.seq) this.seen.delete(seq);
    }
    this.seen.set(view.seq, view);
  }

  /** Route one new notice: urgent now, routine deferred past break.
   *  Exactly-once via `delivered`; render-only state (focus, selection,
   *  composer text) is never touched here. */
  private deliver(view: NotificationView): void {
    if (this.delivered.has(view.seq)) return;
    this.delivered.add(view.seq);
    if (isLocallyOutdated(view)) {
      this.renderAll();
      return;
    }
    if (view.priority === "urgent") {
      this.briefed.add(view.seq);
      this.renderAll();
      return;
    }
    // Routine: only brief on a natural break, else quiet badge.
    if (!this.pendingRoutine.some((v) => v.seq === view.seq)) {
      this.pendingRoutine.push(view);
    }
    if (this.deps.isNaturalBreak()) {
      this.maybeFlushRoutine();
    } else {
      this.renderBadge();
    }
    this.renderAll();
  }

  private maybeFlushRoutine(): void {
    if (this.pendingRoutine.length === 0) return;
    if (!this.deps.isNaturalBreak()) {
      this.renderBadge();
      return;
    }
    // Drop locally-expired while deferred (history keeps them, no nudge).
    const live = this.pendingRoutine.filter((v) => !isLocallyOutdated(v));
    this.pendingRoutine.length = 0;
    for (const view of live) this.briefed.add(view.seq);
    this.renderAll();
  }

  private scheduleReconnect(session: number): void {
    if (this.destroyed || session !== this.sessionSeq) return;
    this.clearReconnectTimer();
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(
      this.reconnectDelay * 2,
      NotificationPanel.RECONNECT_MAX_MS,
    );
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (session !== this.sessionSeq || this.destroyed) return;
      this.openFeed(session, this.lastSeq);
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearReconnect(): void {
    this.clearReconnectTimer();
    this.reconnectDelay = NotificationPanel.RECONNECT_BASE_MS;
  }

  private resetReconnectBackoff(): void {
    this.reconnectDelay = NotificationPanel.RECONNECT_BASE_MS;
  }

  private closeFeed(): void {
    if (this.feed !== null) {
      try {
        this.feed.close();
      } catch {
        // Best effort.
      }
      this.feed = null;
    }
  }

  private unreadCount(): number {
    if (this.serverUnread !== null) return Math.max(0, this.serverUnread);
    let count = 0;
    for (const view of this.seen.values()) {
      if (this.acked.has(view.id)) continue;
      if (isLocallyOutdated(view)) continue;
      count += 1;
    }
    return count;
  }

  private renderBadge(): void {
    if (this.badge === null) return;
    const deferred = this.pendingRoutine.length;
    this.badge.textContent =
      deferred > 0 ? `保留中 ${deferred}件` : `未読 ${this.unreadCount()}件`;
  }

  private sourceLine(view: NotificationView): string {
    const parts = [
      textOf(SOURCE_TEXT, view.sourceKind),
      view.scope,
      textOf(KIND_TEXT, view.kind),
      textOf(PRIORITY_TEXT, view.priority),
    ];
    const when = formatInstant(view.createdAt);
    return when.length > 0 ? `${parts.join("・")}・${when}` : parts.join("・");
  }

  private renderAll(): void {
    this.renderBadge();
    this.renderUrgent();
    this.renderRoutineGroups();
    this.renderHistory();
    this.renderOlderButton();
    this.renderDetailShell();
  }

  private renderUrgent(): void {
    if (this.urgentBox === null) return;
    while (this.urgentBox.firstChild !== null) {
      this.urgentBox.removeChild(this.urgentBox.firstChild);
    }
    const urgent = [...this.seen.values()]
      .filter(
        (v) =>
          v.priority === "urgent" &&
          !isLocallyOutdated(v) &&
          !this.acked.has(v.id),
      )
      .sort((a, b) => b.seq - a.seq)
      .slice(0, 5);
    for (const view of urgent) {
      const row = document.createElement("div");
      const head = document.createElement("p");
      head.textContent = `${urgentHeadLabel(view)}・${this.sourceLine(view)}`;
      const body = document.createElement("p");
      body.textContent = view.briefText;
      const open = document.createElement("button");
      open.type = "button";
      open.textContent = "内容を見る";
      open.addEventListener("click", () => {
        void this.selectNotification(view.id);
      });
      row.appendChild(head);
      row.appendChild(body);
      row.appendChild(open);
      this.urgentBox.appendChild(row);
    }
  }

  private renderRoutineGroups(): void {
    if (this.routineBox === null) return;
    while (this.routineBox.firstChild !== null) {
      this.routineBox.removeChild(this.routineBox.firstChild);
    }
    // Only explicitly BRIEFED (flushed on a natural break) routine
    // notices render as groups; deferred ones stay behind the badge and
    // pre-baseline history never briefs. History below keeps everything.
    const briefedRoutine = [...this.seen.values()].filter(
      (v) =>
        v.priority !== "urgent" &&
        this.briefed.has(v.seq) &&
        !isLocallyOutdated(v) &&
        !this.acked.has(v.id) &&
        v.seq > this.baseline,
    );
    if (briefedRoutine.length === 0) return;
    const questions = briefedRoutine.filter((v) => v.kind === "question");
    const others = briefedRoutine.filter((v) => v.kind !== "question");
    const general = questions.filter((v) => v.citedDeadlines.length === 0);
    const dated = questions.filter((v) => v.citedDeadlines.length > 0);
    const groups: Array<{ title: string; items: NotificationView[] }> = [];
    if (general.length > 0)
      groups.push({ title: `確認事項 ${general.length}件`, items: general });
    if (dated.length > 0)
      groups.push({ title: `期限付きの確認 ${dated.length}件`, items: dated });
    if (others.length > 0)
      groups.push({ title: `お知らせ ${others.length}件`, items: others });
    for (const group of groups) {
      const head = document.createElement("h3");
      head.textContent = group.title;
      this.routineBox.appendChild(head);
      const list = document.createElement("ul");
      for (const view of group.items) {
        const row = document.createElement("li");
        const text = document.createElement("span");
        text.textContent = `${view.scope}・${view.briefText}`;
        const open = document.createElement("button");
        open.type = "button";
        open.textContent = "内容を見る";
        open.addEventListener("click", () => {
          void this.selectNotification(view.id);
        });
        row.appendChild(text);
        row.appendChild(open);
        list.appendChild(row);
      }
      this.routineBox.appendChild(list);
    }
  }

  private renderHistory(): void {
    if (this.list === null) return;
    while (this.list.firstChild !== null) {
      this.list.removeChild(this.list.firstChild);
    }
    const items = [...this.seen.values()].sort((a, b) => b.seq - a.seq);
    for (const view of items) {
      const row = document.createElement("li");
      const line = document.createElement("span");
      const stale = isLocallyOutdated(view);
      const acked = this.acked.has(view.id);
      line.textContent =
        `${this.sourceLine(view)}・${view.briefText}` +
        (stale ? "・古い内容" : "") +
        (acked ? "・確認済み" : "");
      const open = document.createElement("button");
      open.type = "button";
      open.textContent = "内容を見る";
      open.addEventListener("click", () => {
        void this.selectNotification(view.id);
      });
      row.appendChild(line);
      row.appendChild(open);
      this.list.appendChild(row);
    }
  }

  private renderOlderButton(): void {
    if (this.olderButton === null) return;
    this.olderButton.hidden = !this.historyHasMore;
    this.olderButton.disabled = this.loadingOlder;
    this.olderButton.textContent = "古いお知らせを読み込む";
  }

  private renderDetailShell(): void {
    if (
      this.detail === null ||
      this.detailBody === null ||
      this.ackButton === null ||
      this.retryButton === null ||
      this.status === null
    ) {
      return;
    }
    const view =
      this.selectedId === null
        ? null
        : ([...this.seen.values()].find((v) => v.id === this.selectedId) ??
          null);
    if (view === null) {
      this.detail.hidden = true;
      return;
    }
    this.detail.hidden = false;
    while (this.detailBody.firstChild !== null) {
      this.detailBody.removeChild(this.detailBody.firstChild);
    }
    const add = (text: string): void => {
      const line = document.createElement("p");
      line.textContent = text;
      this.detailBody?.appendChild(line);
    };
    add(this.sourceLine(view));
    add(view.briefText);
    if (view.citedDeadlines.length > 0) {
      add(`引用された期限：${view.citedDeadlines.join("、")}`);
    }
    if (isLocallyOutdated(view)) add("古い内容です（履歴表示のみ）");
    if (this.acked.has(view.id)) add("確認済み");
    // Source navigation: ONLY the existing readonly shadow seam; every
    // other source renders as text above (no fake buttons, no no-ops).
    if (
      view.sourceKind === "shadow_job" &&
      this.deps.selectShadowJob !== undefined
    ) {
      const nav = document.createElement("button");
      nav.type = "button";
      nav.textContent = "試行の記録を見る";
      nav.addEventListener("click", () => {
        const run = this.deps.selectShadowJob?.(
          view.sourceId,
          view.sourceVersion ?? 1,
        );
        void run;
      });
      this.detailBody.appendChild(nav);
    }
    const acked = this.acked.has(view.id);
    this.ackButton.hidden = acked;
    this.ackButton.textContent = "確認済みにする";
    const uncertain = this.pendingAcks.has(view.id);
    this.retryButton.hidden = !uncertain;
    this.retryButton.textContent = "同じ内容で再送";
    if (this.status !== null && !acked && !uncertain)
      this.status.textContent = "";
  }

  /** Open (read-only): pure GET, never an ack. */
  async selectNotification(notificationId: string): Promise<void> {
    const sessionId = this.deps.getSessionId();
    if (sessionId === null) return;
    const session = this.sessionSeq;
    this.selectedId = notificationId;
    this.renderDetailShell();
    let res: { status: number; body: unknown };
    try {
      res = await this.deps.http.get(
        `/api/sessions/${encodeURIComponent(sessionId)}/notifications/${encodeURIComponent(notificationId)}/history`,
      );
    } catch {
      return;
    }
    if (session !== this.sessionSeq) return;
    if (sessionId !== this.deps.getSessionId()) return;
    if (this.selectedId !== notificationId) return;
    if (res.status !== 200 || !isRecord(res.body)) return;
    const body = res.body as { notification?: unknown; ack?: unknown };
    if (!isView(body.notification)) return;
    if (body.notification.sessionId !== sessionId) return;
    // Always replace the owned cached view: a terminal/cancelled task can
    // flip `outdated` without a new seq, and the discarded refresh would
    // leave detail/history stale. Delivery tracking is separate (`delivered`
    // / `briefed`), so the refreshed outdated view can never re-nudge.
    this.upsertSeen(body.notification);
    if (isRecord(body.ack) && !this.acked.has(notificationId)) {
      this.acked.add(notificationId);
      if (this.serverUnread !== null && this.serverUnread > 0) {
        this.serverUnread -= 1;
      }
    }
    this.renderAll();
  }

  /** Explicit retry: resend ONLY the frozen entry owned by the current
   *  selection (same id/key/body). A selection with no frozen entry never
   *  inherits another notice's error or retry affordance. */
  private async retryPendingAck(): Promise<void> {
    const target = this.selectedId;
    if (target === null) return;
    if (!this.pendingAcks.has(target)) return;
    await this.commitAck();
  }

  /** Explicit ack: frozen key+N+{} in memory, same-key retry only.
   *  Ownership rules: the frozen entry belongs to its notice; starting a
   *  fresh ack for B while A is unresolved is blocked with an honest
   *  message (never overwrites A); late responses for a deselected notice
   *  mark only that notice's receipt and never rewrite the current
   *  selection's status. Still receipt-only: never approval/permission. */
  private async commitAck(): Promise<void> {
    const sessionId = this.deps.getSessionId();
    const target = this.selectedId;
    if (sessionId === null || target === null) return;
    const session = this.sessionSeq;
    let frozen = this.pendingAcks.get(target);
    if (frozen === undefined) {
      const other = [...this.pendingAcks.keys()].find((k) => k !== target);
      if (other !== undefined) {
        if (this.status !== null && this.selectedId === target) {
          this.status.textContent =
            "別の確認の再送待ちです。先にそちらを再送してください。";
        }
        return;
      }
      frozen = { ownerSession: sessionId, key: this.newKey() };
      this.pendingAcks.set(target, frozen);
    }
    if (this.ackFlight.has(target)) return;
    this.ackFlight.add(target);
    const frozenTarget = target;
    const frozenEntry = frozen;
    if (this.status !== null && this.selectedId === frozenTarget) {
      this.status.textContent = "確認を送信中…";
    }
    this.renderDetailShell();
    let res: { status: number; body: unknown };
    try {
      res = await this.deps.http.post(
        `/api/sessions/${encodeURIComponent(sessionId)}/notifications/${encodeURIComponent(frozenTarget)}/ack`,
        {},
        frozenEntry.key,
      );
    } catch {
      this.ackFlight.delete(frozenTarget);
      if (session !== this.sessionSeq) return;
      if (this.pendingAcks.get(frozenTarget) !== frozenEntry) return;
      if (frozenEntry.ownerSession !== this.deps.getSessionId()) return;
      // Uncertain A stays frozen; B never inherits it.
      if (this.selectedId === frozenTarget) {
        if (this.status !== null) {
          this.status.textContent =
            "通信が不確かです。同じ内容で再送できます。";
        }
        this.renderDetailShell();
      }
      return;
    }
    this.ackFlight.delete(frozenTarget);
    if (session !== this.sessionSeq) return;
    if (this.pendingAcks.get(frozenTarget) !== frozenEntry) return;
    if (frozenEntry.ownerSession !== this.deps.getSessionId()) return;
    if (res.status === 200 || res.status === 201) {
      this.pendingAcks.delete(frozenTarget);
      if (!this.acked.has(frozenTarget)) {
        this.acked.add(frozenTarget);
        if (this.serverUnread !== null && this.serverUnread > 0) {
          this.serverUnread -= 1;
        }
      }
      if (this.selectedId === frozenTarget) {
        if (this.status !== null) {
          this.status.textContent = "確認済みにしました。";
        }
        this.renderAll();
      } else {
        this.renderAll();
      }
      return;
    }
    if (res.status === 429 || res.status >= 500) {
      if (this.selectedId === frozenTarget) {
        if (this.status !== null) {
          this.status.textContent =
            "応答が不確かです。同じ内容で再送できます。";
        }
        this.renderDetailShell();
      }
      return;
    }
    this.pendingAcks.delete(frozenTarget);
    if (this.selectedId === frozenTarget) {
      if (this.status !== null) {
        this.status.textContent = "確認できませんでした。";
      }
      this.renderDetailShell();
    }
  }
}
