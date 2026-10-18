// AV04 learning consumer panel (plain DOM, no framework).
//
// Separate browser module (mirrors `proposal_panel.ts`): this file owns the
// "学びの記録" section only. HTTP helpers and session state are INJECTED (no
// import from client.ts, no module cycle).
//
// Boundaries (pinned by regressions):
// - Hypotheses stay QUIET labels: every row shows the explicit「仮説」badge
//   with kind + status + evidence counts, and a `refuted` row is NEVER shown
//   as supported/fact. The detail shows the full statement plus the status
//   and the `needs_reevaluation` notice (visible, human-decided).
// - Evidence is read-only history: rows render polarity + closed source kind
//   + truncated source id + note via `textContent` only (never innerHTML).
//   Source navigation is READ-ONLY scrolling to the existing section that
//   owns the source row (shadow / proposals / autonomy) — no state change,
//   no new fetch seam.
// - All decisions are explicit HUMAN commits only: support / refute / retire
//   (CAS on the expected version), staged accept/reject, and evidence attach
//   go through the trusted HTTP routes. No background service, no
//   auto-promotion, no notification coupling, no stop-control access.
// - Model text is UNTRUSTED: every string renders via `textContent` only.
// - Uncertain operations freeze {key, expectedVersion, body} IN MEMORY only
//   (same-key retry, never a new key on a lost response). While one
//   operation is unresolved, changing selection or inputs cannot replace it.
// - Session guards: generations invalidate SYNC, so a held old-session reply
//   can never render into the new session. No user/model body in
//   localStorage. Reads come from the ACTUAL HTTP API.

/// <reference lib="dom" />

export interface LearningHttp {
  get(path: string): Promise<{ status: number; body: unknown }>;
  post(
    path: string,
    payload: unknown,
    key: string,
  ): Promise<{ status: number; body: unknown }>;
}

export interface LearningPanelDeps {
  getSessionId: () => string | null;
  http: LearningHttp;
  randomKey?: () => string;
}

interface EvidenceCounts {
  readonly supports: number;
  readonly refutes: number;
  readonly neutral: number;
}

interface HypothesisView {
  readonly id: string;
  readonly sessionId: string;
  readonly scope: string;
  readonly kind: string;
  readonly statement: string;
  readonly status: "open" | "supported" | "refuted" | "retired";
  readonly version: number;
  readonly origin: "human" | "model";
  readonly staged: boolean;
  readonly needsReevaluation: boolean;
  readonly evidenceCounts: EvidenceCounts;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface EvidenceView {
  readonly id: string;
  readonly hypothesisId: string;
  readonly sessionId: string;
  readonly polarity: "supports" | "refutes" | "neutral";
  readonly sourceKind:
    | "shadow_job"
    | "conversation_proposal"
    | "action_receipt"
    | "task_event";
  readonly sourceId: string;
  readonly note: string | null;
  readonly createdAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCounts(value: unknown): value is EvidenceCounts {
  if (!isRecord(value)) return false;
  return (
    Number.isInteger(value.supports) &&
    (value.supports as number) >= 0 &&
    Number.isInteger(value.refutes) &&
    (value.refutes as number) >= 0 &&
    Number.isInteger(value.neutral) &&
    (value.neutral as number) >= 0
  );
}

function isHypothesisView(value: unknown): value is HypothesisView {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.scope === "string" &&
    (value.kind === "method" || value.kind === "hypothesis") &&
    typeof value.statement === "string" &&
    (value.status === "open" ||
      value.status === "supported" ||
      value.status === "refuted" ||
      value.status === "retired") &&
    typeof value.version === "number" &&
    (value.origin === "human" || value.origin === "model") &&
    typeof value.staged === "boolean" &&
    typeof value.needsReevaluation === "boolean" &&
    isCounts(value.evidenceCounts) &&
    typeof value.createdAt === "number" &&
    typeof value.updatedAt === "number"
  );
}

function isEvidenceView(value: unknown): value is EvidenceView {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.hypothesisId === "string" &&
    typeof value.sessionId === "string" &&
    (value.polarity === "supports" ||
      value.polarity === "refutes" ||
      value.polarity === "neutral") &&
    (value.sourceKind === "shadow_job" ||
      value.sourceKind === "conversation_proposal" ||
      value.sourceKind === "action_receipt" ||
      value.sourceKind === "task_event") &&
    typeof value.sourceId === "string" &&
    (value.note === null || typeof value.note === "string") &&
    typeof value.createdAt === "number"
  );
}

function readItems(body: unknown): HypothesisView[] {
  if (!isRecord(body)) return [];
  const items = body.items;
  if (!Array.isArray(items)) return [];
  return items.filter(isHypothesisView);
}

function readEvidence(body: unknown): EvidenceView[] {
  if (!isRecord(body)) return [];
  const items = body.items;
  if (!Array.isArray(items)) return [];
  return items.filter(isEvidenceView);
}

/** Opaque older-page cursor (null when the server has no older page). */
function readCursor(body: unknown): string | null {
  if (!isRecord(body)) return null;
  return typeof body.nextCursor === "string" ? body.nextCursor : null;
}

function readHasMore(body: unknown): boolean {
  if (!isRecord(body)) return false;
  return body.hasMore === true;
}

/** Strict UUID v4 shape (client-side pre-freeze validation only). */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const KIND_TEXT: Record<string, string> = {
  method: "方法",
  hypothesis: "仮説",
};

const STATUS_TEXT: Record<string, string> = {
  open: "検討中",
  supported: "支持",
  refuted: "反証",
  retired: "引退",
};

const POLARITY_TEXT: Record<string, string> = {
  supports: "支持",
  refutes: "反証",
  neutral: "中立",
};

const SOURCE_TEXT: Record<string, string> = {
  shadow_job: "試行",
  conversation_proposal: "会話の候補",
  action_receipt: "実行記録",
  task_event: "作業履歴",
};

/** Existing section that owns the source row (read-only scroll target). */
const SOURCE_SECTION: Record<string, string> = {
  shadow_job: "shadow",
  conversation_proposal: "proposals",
  action_receipt: "autonomy",
  task_event: "autonomy",
};

function textOf(map: Record<string, string>, key: string): string {
  return map[key] ?? key;
}

export class LearningPanel {
  private readonly deps: LearningPanelDeps;
  private scopeInput: HTMLInputElement | null = null;
  private kindSelect: HTMLSelectElement | null = null;
  private statementInput: HTMLTextAreaElement | null = null;
  private createButton: HTMLButtonElement | null = null;
  private list: HTMLElement | null = null;
  private refreshButton: HTMLButtonElement | null = null;
  private moreButton: HTMLButtonElement | null = null;
  private detail: HTMLElement | null = null;
  private detailBody: HTMLElement | null = null;
  private evidenceList: HTMLElement | null = null;
  private evidenceMoreButton: HTMLButtonElement | null = null;
  private polaritySelect: HTMLSelectElement | null = null;
  private sourceKindSelect: HTMLSelectElement | null = null;
  private sourceIdInput: HTMLInputElement | null = null;
  private noteInput: HTMLInputElement | null = null;
  private attachButton: HTMLButtonElement | null = null;
  private supportButton: HTMLButtonElement | null = null;
  private refuteButton: HTMLButtonElement | null = null;
  private retireButton: HTMLButtonElement | null = null;
  private reaffirmButton: HTMLButtonElement | null = null;
  private acceptButton: HTMLButtonElement | null = null;
  private rejectButton: HTMLButtonElement | null = null;
  private retryButton: HTMLButtonElement | null = null;
  private status: HTMLElement | null = null;

  private sessionSeq = 0;
  private listSeq = 0;
  private destroyed = false;
  /** Newest-history keyset: opaque cursor + truthful older-page flag. */
  private historyCursor: string | null = null;
  private historyHasMore = false;
  /** Oldest-first evidence keyset for the OPEN selection. */
  private evidenceCursor: string | null = null;
  private evidenceHasMore = false;
  private readonly items = new Map<string, HypothesisView>();
  private readonly evidence = new Map<string, EvidenceView[]>();
  /** Explicitly selected hypothesis id (drawer content). */
  private selectedId: string | null = null;
  /** Guard against concurrent evidence-page loads (double-click dedupe). */
  private evidenceLoading = false;
  /**
   * Frozen unresolved operation: {hypothesis id, session, key, endpoint,
   * body}. While set, selection/input changes cannot replace it; only the
   * explicit retry reuses the identical key+body. In memory only.
   */
  private pendingOp: {
    readonly hypothesisId: string;
    readonly ownerSession: string;
    readonly endpoint: string;
    readonly key: string;
    readonly body: Record<string, unknown>;
  } | null = null;
  private opInFlight = false;

  constructor(deps: LearningPanelDeps) {
    this.deps = deps;
  }

  bind(): void {
    const required = <T extends HTMLElement>(id: string): T => {
      const node = document.getElementById(id);
      if (node === null) throw new Error(`learning node missing: ${id}`);
      return node as T;
    };
    required<HTMLElement>("learning");
    this.scopeInput = required<HTMLInputElement>("learning-scope");
    this.kindSelect = required<HTMLSelectElement>("learning-kind");
    this.statementInput = required<HTMLTextAreaElement>("learning-statement");
    this.createButton = required<HTMLButtonElement>("learning-create");
    this.list = required<HTMLElement>("learning-list");
    this.refreshButton = required<HTMLButtonElement>("learning-refresh");
    this.moreButton = required<HTMLButtonElement>("learning-more");
    this.detail = required<HTMLElement>("learning-detail");
    this.detailBody = required<HTMLElement>("learning-detail-body");
    this.evidenceList = required<HTMLElement>("learning-evidence-list");
    this.evidenceMoreButton = required<HTMLButtonElement>(
      "learning-evidence-more",
    );
    this.polaritySelect = required<HTMLSelectElement>(
      "learning-evidence-polarity",
    );
    this.sourceKindSelect = required<HTMLSelectElement>(
      "learning-evidence-source-kind",
    );
    this.sourceIdInput = required<HTMLInputElement>(
      "learning-evidence-source-id",
    );
    this.noteInput = required<HTMLInputElement>("learning-evidence-note");
    this.attachButton = required<HTMLButtonElement>("learning-evidence-attach");
    this.supportButton = required<HTMLButtonElement>("learning-support");
    this.refuteButton = required<HTMLButtonElement>("learning-refute");
    this.retireButton = required<HTMLButtonElement>("learning-retire");
    this.reaffirmButton = required<HTMLButtonElement>("learning-reaffirm");
    this.acceptButton = required<HTMLButtonElement>("learning-accept");
    this.rejectButton = required<HTMLButtonElement>("learning-reject");
    this.retryButton = required<HTMLButtonElement>("learning-retry");
    this.status = required<HTMLElement>("learning-status");
    this.createButton.addEventListener("click", () => {
      void this.commitCreate();
    });
    this.refreshButton.addEventListener("click", () => {
      void this.refresh();
    });
    this.moreButton.addEventListener("click", () => {
      void this.loadOlderHistory();
    });
    this.evidenceMoreButton.addEventListener("click", () => {
      void this.loadMoreEvidence();
    });
    this.attachButton.addEventListener("click", () => {
      void this.commitEvidence();
    });
    this.supportButton.addEventListener("click", () => {
      void this.commitTransition("support");
    });
    this.refuteButton.addEventListener("click", () => {
      void this.commitTransition("refute");
    });
    this.retireButton.addEventListener("click", () => {
      void this.commitTransition("retire");
    });
    this.reaffirmButton.addEventListener("click", () => {
      void this.commitReaffirm();
    });
    this.acceptButton.addEventListener("click", () => {
      void this.commitDecision("accept");
    });
    this.rejectButton.addEventListener("click", () => {
      void this.commitDecision("reject");
    });
    this.retryButton.addEventListener("click", () => {
      void this.retryPendingOp();
    });
  }

  /** Session lifecycle: clear state, hide drawer, boot new session. */
  notifySessionChanged(): void {
    this.sessionSeq += 1;
    this.items.clear();
    this.evidence.clear();
    this.selectedId = null;
    this.pendingOp = null;
    this.opInFlight = false;
    this.historyCursor = null;
    this.historyHasMore = false;
    this.evidenceCursor = null;
    this.evidenceHasMore = false;
    this.evidenceLoading = false;
    if (this.detail !== null) this.detail.hidden = true;
    if (this.retryButton !== null) this.retryButton.hidden = true;
    this.renderAll();
    void this.refresh();
  }

  /** Run-settled hook: re-read the quiet list (never taskize chat). */
  notifyRunSettled(): void {
    void this.refresh();
  }

  destroy(): void {
    this.destroyed = true;
    this.sessionSeq += 1;
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

  /** Read one newest-first history page behind the stored keyset cursor. */
  private async loadOlderHistory(): Promise<void> {
    const sessionId = this.deps.getSessionId();
    if (sessionId === null || this.destroyed) return;
    const cursor = this.historyCursor;
    if (cursor === null) return;
    const session = this.sessionSeq;
    let res: { status: number; body: unknown };
    try {
      res = await this.deps.http.get(
        `/api/sessions/${sessionId}/learning/hypotheses?limit=50&cursor=${encodeURIComponent(cursor)}`,
      );
    } catch {
      if (session === this.sessionSeq) {
        this.setStatus("古い履歴の読み込みに失敗しました");
      }
      return;
    }
    if (session !== this.sessionSeq) return;
    if (res.status !== 200) {
      this.setStatus("古い履歴の読み込みに失敗しました");
      return;
    }
    // The open drawer (selection, frozen inputs) is preserved: older rows
    // only merge into the list, never reset it.
    for (const item of readItems(res.body)) {
      if (item.sessionId === sessionId) this.items.set(item.id, item);
    }
    this.historyCursor = readCursor(res.body);
    this.historyHasMore = readHasMore(res.body);
    this.renderAll();
    if (this.selectedId !== null) this.renderDetail(false);
  }

  /** Read one oldest-first evidence page behind the selection cursor. */
  private async loadMoreEvidence(): Promise<void> {
    const sessionId = this.deps.getSessionId();
    const selected = this.selectedId;
    const cursor = this.evidenceCursor;
    if (
      sessionId === null ||
      this.destroyed ||
      selected === null ||
      cursor === null
    ) {
      return;
    }
    const current = this.items.get(selected);
    if (current === undefined) return;
    // Gate concurrent page loads: two double-clicked requests share the
    // same cursor and would each append the identical page (visible
    // duplicates). A second load waits for the in-flight one; the merge
    // below ALSO dedupes by id, so a late out-of-order reply can never
    // duplicate a row.
    if (this.evidenceLoading) return;
    this.evidenceLoading = true;
    const session = this.sessionSeq;
    let res: { status: number; body: unknown };
    try {
      res = await this.deps.http.get(
        `/api/sessions/${sessionId}/learning/hypotheses/${selected}/evidence?limit=50&cursor=${encodeURIComponent(cursor)}`,
      );
    } catch {
      if (session === this.sessionSeq && this.selectedId === selected) {
        this.setStatus("古い証拠の読み込みに失敗しました");
      }
      this.evidenceLoading = false;
      return;
    }
    if (session !== this.sessionSeq || this.selectedId !== selected) {
      this.evidenceLoading = false;
      return;
    }
    if (res.status !== 200) {
      this.setStatus("古い証拠の読み込みに失敗しました");
      this.evidenceLoading = false;
      return;
    }
    const rows = this.evidence.get(selected) ?? [];
    const seen = new Set(rows.map((row) => row.id));
    for (const row of readEvidence(res.body)) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push(row);
    }
    this.evidence.set(selected, rows);
    this.evidenceCursor = readCursor(res.body);
    this.evidenceHasMore = readHasMore(res.body);
    this.evidenceLoading = false;
    const shown = this.items.get(selected);
    if (shown !== undefined) this.renderEvidence(shown);
  }

  private async refresh(): Promise<void> {
    const sessionId = this.deps.getSessionId();
    if (sessionId === null || this.destroyed) return;
    const session = this.sessionSeq;
    this.listSeq += 1;
    const seen = this.listSeq;
    let res: { status: number; body: unknown };
    try {
      res = await this.deps.http.get(
        `/api/sessions/${sessionId}/learning/hypotheses?limit=50`,
      );
    } catch {
      if (session === this.sessionSeq && seen === this.listSeq) {
        this.setStatus("学びの読み込みに失敗しました");
      }
      return;
    }
    if (session !== this.sessionSeq || seen !== this.listSeq) return;
    if (res.status !== 200) {
      this.setStatus("学びの読み込みに失敗しました");
      return;
    }
    // Merge the newest page into the map (never clear): older pages loaded
    // via "古い履歴を読み込む" stay reachable, and a 409 re-read never
    // drops the older-page row behind the frozen op.
    const freshIds = new Set<string>();
    for (const item of readItems(res.body)) {
      if (item.sessionId === sessionId) {
        this.items.set(item.id, item);
        freshIds.add(item.id);
      }
    }
    this.historyCursor = readCursor(res.body);
    this.historyHasMore = readHasMore(res.body);
    // A selected hypothesis missing from the newest page is NOT gone: it
    // may live on an older page. Fetch it directly whenever it is absent
    // from the NEWLY RETURNED page (not the merged cache: a selected row
    // from an older page is already cached, yet may have transitioned
    // locally or changed externally while the newest page cannot carry it);
    // close the drawer only when the server says it is gone (404). An
    // unresolved frozen op keeps its drawer pinned without any fetch.
    if (this.pendingOp === null && this.selectedId !== null) {
      if (!freshIds.has(this.selectedId)) {
        const missing = this.selectedId;
        try {
          const single = await this.deps.http.get(
            `/api/sessions/${sessionId}/learning/hypotheses/${missing}`,
          );
          if (session !== this.sessionSeq || seen !== this.listSeq) return;
          if (
            single.status === 200 &&
            isHypothesisView(single.body) &&
            (single.body as HypothesisView).sessionId === sessionId
          ) {
            this.items.set(missing, single.body as HypothesisView);
          } else if (single.status === 404) {
            this.selectedId = null;
            if (this.detail !== null) this.detail.hidden = true;
          }
        } catch {
          // Network loss: keep the stale selection (never close on a
          // failed read); the next refresh retries.
        }
      }
    }
    this.renderAll();
    // Keep the open drawer truthful after a background refresh without
    // clobbering the human's typed create/evidence inputs: rerender the
    // cached row AND reload the first evidence page, so evidence attached
    // from another tab or API client appears without closing the drawer.
    if (this.selectedId !== null) {
      this.renderDetail(false);
      const current =
        this.selectedId === null ? undefined : this.items.get(this.selectedId);
      if (current !== undefined) void this.loadEvidence(current);
    }
  }

  private renderAll(): void {
    if (this.list === null) return;
    if (this.moreButton !== null) {
      this.moreButton.hidden = !this.historyHasMore;
    }
    while (this.list.firstChild !== null) {
      this.list.removeChild(this.list.firstChild);
    }
    // Newest-first by server timestamp only: Array.sort is stable, so
    // same-millisecond rows keep the paged API's durable rowid append
    // order. A UUID tie-breaker would replace that exact order with random
    // UUID order (the kernel keyset paginates in append order deliberately).
    const ordered = [...this.items.values()].sort(
      (a, b) => b.createdAt - a.createdAt,
    );
    for (const item of ordered) {
      const row = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      // Explicit hypothesis badge: kind + status + evidence counts +
      // staged/reevaluation flags. Raw UUIDs hidden, status human-readable.
      const flags =
        (item.staged ? "／要承認" : "") +
        (item.needsReevaluation ? "／要再評価" : "");
      button.textContent =
        `仮説［${textOf(KIND_TEXT, item.kind)}・${textOf(STATUS_TEXT, item.status)}${flags}］` +
        `［${item.scope}］支持${item.evidenceCounts.supports}／反証${item.evidenceCounts.refutes}／中立${item.evidenceCounts.neutral}`;
      button.addEventListener("click", () => {
        this.select(item.id);
      });
      row.appendChild(button);
      this.list.appendChild(row);
    }
  }

  private select(id: string): void {
    // An unresolved frozen operation pins the drawer: switching selection
    // cannot replace it (the retry affordance stays on the frozen record,
    // and the frozen key/body/action is never overwritten).
    if (this.pendingOp !== null) {
      this.setStatus("未確定の操作があります。同じ内容で再送してください");
      return;
    }
    const item = this.items.get(id);
    if (item === undefined) return;
    this.selectedId = id;
    if (this.detail !== null) this.detail.hidden = false;
    if (this.retryButton !== null) this.retryButton.hidden = true;
    // A new selection starts evidence paging from the newest page.
    this.evidenceCursor = null;
    this.evidenceHasMore = false;
    this.evidenceLoading = false;
    this.renderDetail(true);
    void this.loadEvidence(item);
  }

  /** Render the drawer: statement + explicit label + evidence + controls. */
  private renderDetail(resetInputs: boolean): void {
    const item =
      this.selectedId === null ? undefined : this.items.get(this.selectedId);
    if (item === undefined || this.detailBody === null) {
      return;
    }
    while (this.detailBody.firstChild !== null) {
      this.detailBody.removeChild(this.detailBody.firstChild);
    }
    const badge = document.createElement("p");
    const flags =
      (item.staged ? "／要承認（AI提案・未採用）" : "") +
      (item.needsReevaluation ? "／要再評価（親の目的が変更されました）" : "");
    badge.textContent = `仮説［${textOf(KIND_TEXT, item.kind)}・${textOf(STATUS_TEXT, item.status)}${flags}］［${item.scope}］`;
    const statementHead = document.createElement("p");
    statementHead.textContent = "記録（原文・仮説であり事実ではありません）:";
    const statement = document.createElement("p");
    statement.textContent = item.statement;
    const counts = document.createElement("p");
    counts.textContent =
      `証拠: 支持${item.evidenceCounts.supports}／反証${item.evidenceCounts.refutes}／中立${item.evidenceCounts.neutral}` +
      `（版 ${item.version}）`;
    this.detailBody.append(badge, statementHead, statement, counts);
    this.renderEvidence(item);
    // Human-typed evidence inputs survive every same-selection refresh:
    // only an explicit NEW selection clears them.
    if (resetInputs) {
      if (this.sourceIdInput !== null) this.sourceIdInput.value = "";
      if (this.noteInput !== null) this.noteInput.value = "";
    }
    const locked = this.opInFlight || this.pendingOp !== null;
    const terminal = item.status === "retired";
    const staged = item.staged;
    // Explicit transitions need a non-staged, non-terminal record; staged
    // records take accept/reject; retired records take nothing. Reaffirm
    // keeps the status and clears the reevaluation notice, so it needs the
    // notice set (the server rejects a reaffirm without one).
    const decidable = !terminal && !staged && !locked;
    const reaffirmAble =
      !terminal && !staged && !locked && item.needsReevaluation;
    const stagedDecidable = staged && !locked;
    const evidenceAble = !terminal && !staged && !locked;
    if (this.supportButton !== null) {
      this.supportButton.disabled = !decidable || item.status !== "open";
    }
    if (this.refuteButton !== null) {
      this.refuteButton.disabled =
        !decidable || (item.status !== "open" && item.status !== "supported");
    }
    if (this.retireButton !== null) this.retireButton.disabled = !decidable;
    if (this.reaffirmButton !== null) {
      this.reaffirmButton.disabled = !reaffirmAble;
    }
    if (this.acceptButton !== null) {
      this.acceptButton.disabled = !stagedDecidable;
    }
    if (this.rejectButton !== null)
      this.rejectButton.disabled = !stagedDecidable;
    if (this.attachButton !== null) this.attachButton.disabled = !evidenceAble;
  }

  private renderEvidence(item: HypothesisView): void {
    if (this.evidenceList === null) return;
    while (this.evidenceList.firstChild !== null) {
      this.evidenceList.removeChild(this.evidenceList.firstChild);
    }
    const rows = this.evidence.get(item.id) ?? [];
    if (rows.length === 0) {
      const empty = document.createElement("li");
      empty.textContent = "証拠はまだありません";
      this.evidenceList.appendChild(empty);
    }
    for (const row of rows) {
      const line = document.createElement("li");
      const label = document.createElement("span");
      label.textContent =
        `${textOf(POLARITY_TEXT, row.polarity)}［${textOf(SOURCE_TEXT, row.sourceKind)}］` +
        ` 参照:${row.sourceId.slice(0, 8)}…` +
        (row.note === null ? "" : ` 備考:${row.note}`);
      const open = document.createElement("button");
      open.type = "button";
      open.textContent = "参照元を開く";
      open.addEventListener("click", () => {
        // Read-only navigation to the existing owning section: scroll only,
        // no state change, no new seam.
        const target = document.getElementById(
          SOURCE_SECTION[row.sourceKind] ?? "autonomy",
        );
        if (target !== null) {
          try {
            target.scrollIntoView();
          } catch {
            // Best effort: navigation never breaks the drawer.
          }
        }
      });
      line.append(label, open);
      // Source discovery: the attach form requires a full source UUID that
      // no owning UI renders visibly, so each attached row offers a
      // one-tap reuse that fills the attach form's kind + id from a real,
      // already-anchored source (no memorization, no devtools needed).
      const reuse = document.createElement("button");
      reuse.type = "button";
      reuse.textContent = "この参照元を使う";
      reuse.addEventListener("click", () => {
        if (this.sourceKindSelect !== null) {
          this.sourceKindSelect.value = row.sourceKind;
        }
        if (this.sourceIdInput !== null) {
          this.sourceIdInput.value = row.sourceId;
        }
        this.setStatus(
          "参照元を転記しました（極性・備考を添えて追加できます）",
        );
      });
      line.appendChild(reuse);
      this.evidenceList.appendChild(line);
    }
    // Older evidence pages stay behind the explicit affordance (the drawer
    // never materializes the full history on open).
    if (this.evidenceMoreButton !== null) {
      this.evidenceMoreButton.hidden = !this.evidenceHasMore;
    }
  }

  private async loadEvidence(item: HypothesisView): Promise<void> {
    const session = this.sessionSeq;
    const selected = this.selectedId;
    try {
      const res = await this.deps.http.get(
        `/api/sessions/${item.sessionId}/learning/hypotheses/${item.id}/evidence?limit=50`,
      );
      if (session !== this.sessionSeq) return;
      if (this.selectedId !== selected) return;
      if (res.status !== 200) {
        this.setStatus("証拠の読み込みに失敗しました");
        return;
      }
      this.evidence.set(item.id, readEvidence(res.body));
      this.evidenceCursor = readCursor(res.body);
      this.evidenceHasMore = readHasMore(res.body);
      // Selection-bound: a late reply for a previous selection never
      // overwrites the shown hypothesis's evidence.
      const current = this.items.get(item.id);
      if (current === undefined || this.selectedId !== selected) return;
      this.renderEvidence(current);
    } catch {
      if (session !== this.sessionSeq) return;
      if (this.selectedId !== selected) return;
      this.setStatus("証拠の読み込みに失敗しました");
    }
  }

  private async commitCreate(): Promise<void> {
    const sessionId = this.deps.getSessionId();
    if (this.pendingOp !== null) {
      this.setStatus("未確定の操作があります。同じ内容で再送してください");
      return;
    }
    if (
      sessionId === null ||
      this.opInFlight ||
      this.scopeInput === null ||
      this.kindSelect === null ||
      this.statementInput === null
    ) {
      return;
    }
    const scope = this.scopeInput.value.trim();
    const kind = this.kindSelect.value;
    const statement = this.statementInput.value.trim();
    if (scope.length === 0 || statement.length === 0) {
      this.setStatus("範囲と記録を入力してください");
      return;
    }
    if (kind !== "method" && kind !== "hypothesis") {
      this.setStatus("種別が不正です");
      return;
    }
    const key = this.newKey();
    // Freeze {key, body} BEFORE the first send: every retry reuses the
    // identical pair, so a redelivered POST replays ONE hypothesis.
    this.pendingOp = {
      hypothesisId: "",
      ownerSession: sessionId,
      endpoint: `/api/sessions/${sessionId}/learning/hypotheses`,
      key,
      body: { scope, kind, statement },
    };
    this.opInFlight = true;
    await this.sendPendingOp();
  }

  private async commitTransition(
    transition: "support" | "refute" | "retire",
  ): Promise<void> {
    const item =
      this.selectedId === null ? undefined : this.items.get(this.selectedId);
    const sessionId = this.deps.getSessionId();
    if (this.pendingOp !== null) {
      this.setStatus("未確定の操作があります。同じ内容で再送してください");
      return;
    }
    if (
      item === undefined ||
      sessionId === null ||
      this.opInFlight ||
      item.staged ||
      item.status === "retired"
    ) {
      return;
    }
    const key = this.newKey();
    this.pendingOp = {
      hypothesisId: item.id,
      ownerSession: sessionId,
      endpoint: `/api/sessions/${sessionId}/learning/hypotheses/${item.id}/transition`,
      key,
      body: { expectedVersion: item.version, transition },
    };
    this.opInFlight = true;
    this.renderDetail(false);
    await this.sendPendingOp();
  }

  private async commitDecision(decision: "accept" | "reject"): Promise<void> {
    const item =
      this.selectedId === null ? undefined : this.items.get(this.selectedId);
    const sessionId = this.deps.getSessionId();
    if (this.pendingOp !== null) {
      this.setStatus("未確定の操作があります。同じ内容で再送してください");
      return;
    }
    if (
      item === undefined ||
      sessionId === null ||
      this.opInFlight ||
      !item.staged
    ) {
      return;
    }
    const key = this.newKey();
    this.pendingOp = {
      hypothesisId: item.id,
      ownerSession: sessionId,
      endpoint: `/api/sessions/${sessionId}/learning/hypotheses/${item.id}/${decision}`,
      key,
      body: { expectedVersion: item.version },
    };
    this.opInFlight = true;
    this.renderDetail(false);
    await this.sendPendingOp();
  }

  private async commitReaffirm(): Promise<void> {
    const item =
      this.selectedId === null ? undefined : this.items.get(this.selectedId);
    const sessionId = this.deps.getSessionId();
    if (this.pendingOp !== null) {
      this.setStatus("未確定の操作があります。同じ内容で再送してください");
      return;
    }
    if (
      item === undefined ||
      sessionId === null ||
      this.opInFlight ||
      item.staged ||
      item.status === "retired" ||
      !item.needsReevaluation
    ) {
      return;
    }
    const key = this.newKey();
    this.pendingOp = {
      hypothesisId: item.id,
      ownerSession: sessionId,
      endpoint: `/api/sessions/${sessionId}/learning/hypotheses/${item.id}/reaffirm`,
      key,
      body: { expectedVersion: item.version },
    };
    this.opInFlight = true;
    this.renderDetail(false);
    await this.sendPendingOp();
  }

  private async commitEvidence(): Promise<void> {
    const item =
      this.selectedId === null ? undefined : this.items.get(this.selectedId);
    const sessionId = this.deps.getSessionId();
    if (this.pendingOp !== null) {
      this.setStatus("未確定の操作があります。同じ内容で再送してください");
      return;
    }
    if (
      item === undefined ||
      sessionId === null ||
      this.opInFlight ||
      item.staged ||
      item.status === "retired" ||
      this.polaritySelect === null ||
      this.sourceKindSelect === null ||
      this.sourceIdInput === null
    ) {
      return;
    }
    const polarity = this.polaritySelect.value;
    const sourceKind = this.sourceKindSelect.value;
    const sourceId = this.sourceIdInput.value.trim();
    const note = this.noteInput === null ? "" : this.noteInput.value.trim();
    if (sourceId.length === 0) {
      this.setStatus("参照IDを入力してください");
      return;
    }
    // Client-side UUID validation BEFORE freezing: an ill-shaped source id
    // can never succeed server-side, so it must not pin the panel.
    if (!UUID_RE.test(sourceId)) {
      this.setStatus("参照IDはUUID形式で入力してください");
      return;
    }
    if (
      polarity !== "supports" &&
      polarity !== "refutes" &&
      polarity !== "neutral"
    ) {
      this.setStatus("極性が不正です");
      return;
    }
    if (
      sourceKind !== "shadow_job" &&
      sourceKind !== "conversation_proposal" &&
      sourceKind !== "action_receipt" &&
      sourceKind !== "task_event"
    ) {
      this.setStatus("参照種別が不正です");
      return;
    }
    const key = this.newKey();
    const body: Record<string, unknown> = { polarity, sourceKind, sourceId };
    if (note.length > 0) body.note = note;
    this.pendingOp = {
      hypothesisId: item.id,
      ownerSession: sessionId,
      endpoint: `/api/sessions/${sessionId}/learning/hypotheses/${item.id}/evidence`,
      key,
      body,
    };
    this.opInFlight = true;
    this.renderDetail(false);
    await this.sendPendingOp();
  }

  private async retryPendingOp(): Promise<void> {
    if (this.pendingOp === null || this.opInFlight) return;
    this.opInFlight = true;
    if (this.selectedId !== null) this.renderDetail(false);
    await this.sendPendingOp();
  }

  private async sendPendingOp(): Promise<void> {
    const op = this.pendingOp;
    const session = this.sessionSeq;
    if (op === null) {
      this.opInFlight = false;
      return;
    }
    let res: { status: number; body: unknown };
    try {
      res = await this.deps.http.post(op.endpoint, op.body, op.key);
    } catch {
      if (session !== this.sessionSeq) return;
      // Uncertain response loss: the frozen op SURVIVES (same-key retry
      // offered, never a new key, never an overwrite).
      this.opInFlight = false;
      if (this.retryButton !== null) this.retryButton.hidden = false;
      this.setStatus("応答が不確定です。同じ内容で再送してください");
      if (this.selectedId !== null) this.renderDetail(false);
      return;
    }
    if (session !== this.sessionSeq) return;
    const sessionId = this.deps.getSessionId();
    if (sessionId === null || sessionId !== op.ownerSession) return;
    if (res.status === 201 || res.status === 200) {
      this.pendingOp = null;
      this.opInFlight = false;
      if (this.retryButton !== null) this.retryButton.hidden = true;
      this.setStatus(
        op.hypothesisId === "" ? "仮説を記録しました" : "操作を反映しました",
      );
      // Apply the mutation response to the cache BEFORE re-reading: a
      // transitioned/reaffirmed/decided row from an older page falls outside
      // the newest 50-row page, so a merge-only refresh would keep the
      // stale version/status and the next commit would 409 on it.
      if (
        op.hypothesisId !== "" &&
        isRecord(res.body) &&
        isHypothesisView(res.body)
      ) {
        this.items.set(op.hypothesisId, res.body);
      }
      await this.refresh();
      if (session !== this.sessionSeq) return;
      // Selection-bound: the created/updated record opens only when it is
      // still owned by this session.
      if (op.hypothesisId === "" && isRecord(res.body)) {
        const id = res.body.id;
        if (typeof id === "string" && this.items.has(id)) {
          this.selectedId = id;
          if (this.detail !== null) this.detail.hidden = false;
          this.renderDetail(true);
          const current = this.items.get(id);
          if (current !== undefined) void this.loadEvidence(current);
        }
      } else if (this.selectedId !== null) {
        this.renderDetail(false);
        const current =
          this.selectedId === null
            ? undefined
            : this.items.get(this.selectedId);
        if (current !== undefined) void this.loadEvidence(current);
      }
      return;
    }
    if (res.status === 409) {
      // Definitive conflict (version mismatch, lifecycle conflict, or key
      // reuse): re-read the truth, then CLEAR the frozen op — retrying the
      // identical frozen body could never succeed, so keeping it would pin
      // the panel forever. The human re-commits fresh (new key, new
      // version) after reading the honest message. Only network loss and
      // 5xx/503 keep the frozen op (handled above/below).
      this.opInFlight = false;
      await this.refresh();
      if (session !== this.sessionSeq) return;
      this.pendingOp = null;
      if (this.retryButton !== null) this.retryButton.hidden = true;
      if (op.hypothesisId === "") {
        this.setStatus(
          "競合しました（キーの再利用）。内容を確認して入力し直してください",
        );
        return;
      }
      const current = this.items.get(op.hypothesisId);
      if (current === undefined) {
        this.setStatus("仮説が見つかりません（別セッションの可能性）");
        this.selectedId = null;
        if (this.detail !== null) this.detail.hidden = true;
        this.renderAll();
        return;
      }
      if (current.status === "retired") {
        this.setStatus("引退しています（履歴を確認してください）");
      } else {
        this.setStatus(
          "競合しました（版ずれ・キーの再利用）。一覧を確認して入力し直してください",
        );
      }
      this.renderAll();
      if (this.selectedId !== null) this.renderDetail(false);
      return;
    }
    if (res.status === 400) {
      // Definitive validation rejection: the identical body can never
      // succeed, so clear the frozen op and keep the selection + typed
      // inputs for correction (never pin the panel).
      this.pendingOp = null;
      this.opInFlight = false;
      if (this.retryButton !== null) this.retryButton.hidden = true;
      this.setStatus("入力が不正です（内容を確認して入力し直してください）");
      if (this.selectedId !== null) this.renderDetail(false);
      return;
    }
    if (res.status === 404) {
      this.opInFlight = false;
      await this.refresh();
      if (session !== this.sessionSeq) return;
      const isEvidenceOp =
        op.hypothesisId !== "" && op.endpoint.endsWith("/evidence");
      if (isEvidenceOp && this.items.has(op.hypothesisId)) {
        // The hypothesis is still there: the 404 names the UNKNOWN SOURCE
        // anchor, not the hypothesis. Keep the selection + typed inputs,
        // clear the doomed op (the identical unknown source can never
        // succeed), and say so honestly. Close only when the refresh
        // shows the hypothesis itself is gone (below).
        this.pendingOp = null;
        if (this.retryButton !== null) this.retryButton.hidden = true;
        this.selectedId = op.hypothesisId;
        if (this.detail !== null) this.detail.hidden = false;
        this.setStatus(
          "参照元が見つかりません（試行・候補・記録のIDを確認してください）",
        );
        this.renderAll();
        this.renderDetail(false);
        return;
      }
      this.pendingOp = null;
      this.opInFlight = false;
      if (this.retryButton !== null) this.retryButton.hidden = true;
      this.setStatus("仮説が見つかりません（別セッションの可能性）");
      this.selectedId = null;
      if (this.detail !== null) this.detail.hidden = true;
      this.renderAll();
      return;
    }
    this.opInFlight = false;
    if (this.retryButton !== null) this.retryButton.hidden = false;
    this.setStatus("操作に失敗しました。同じ内容で再送できます");
    if (this.selectedId !== null) this.renderDetail(false);
  }

  private setStatus(text: string): void {
    if (this.status !== null) this.status.textContent = text;
  }
}
