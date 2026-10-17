// AV03 conversation-proposal consumer panel (plain DOM, no framework).
//
// Separate browser module (mirrors `notification_panel.ts`): this file owns
// the "会話の候補" section only. HTTP helpers and session/composer state are
// INJECTED (no import from client.ts, no module cycle).
//
// Boundaries (pinned by regressions):
// - Pending drafts stay QUIET: a badge counts them, a one-line brief appears
//   ONLY on a natural break (no active run + composer empty + visible), and
//   the review drawer opens ONLY on explicit click. Never steals focus or
//   selection, never touches composer/draft text, never forces a chat turn,
//   never couples to any Calendar projection.
// - Adopt/reject are explicit HUMAN decisions only: each opens the selected
//   pending draft, shows the ORIGINAL speaker quote apart from the model's
//   interpretation (kind/scope/source badge「AI候補／未採用」), and commits
//   via the trusted HTTP routes. No background service, no auto-drain, no
//   automatic taskization of chat, no ACK/notification cross-route.
// - Model text is UNTRUSTED: every string renders via `textContent` only —
//   never `innerHTML`, never links, never raw UUID walls.
// - Task drafts carry the model's EXPLICIT parent (id + expected version,
//   immutable): the panel shows the parent's readable purpose title (fetched
//   readonly) and never auto-picks another purpose. Adoption reuses the
//   staged parent exactly.
// - Dates are human-explicit only: blank by default; a task deadline or a
//   purpose window is sent only when the human types a strict RFC3339 value
//   with an explicit offset (plain text input, never datetime-local).
// - Uncertain operations freeze {key, expectedVersion, date fields} IN MEMORY
//   only (same-key retry, never a new key on a lost response). While one
//   operation is unresolved, changing selection or inputs cannot replace it.
// - Session guards: generations invalidate SYNC, so a held old-session reply
//   can never render into the new session. No user/model body in
//   localStorage. Reads come from the ACTUAL HTTP API; the drawer refreshes
//   on the existing run-settled hook (every-chat GET read, not taskization).

/// <reference lib="dom" />

export interface ProposalHttp {
  get(path: string): Promise<{ status: number; body: unknown }>;
  post(
    path: string,
    payload: unknown,
    key: string,
  ): Promise<{ status: number; body: unknown }>;
}

export interface ProposalPanelDeps {
  getSessionId: () => string | null;
  /** Natural break: no active run + composer empty + visible. */
  isNaturalBreak: () => boolean;
  http: ProposalHttp;
  /** Refresh the adopted purpose/task target via existing public hooks. */
  onAdopted?: () => void;
  randomKey?: () => string;
}

interface ProposalView {
  readonly id: string;
  readonly sessionId: string;
  readonly scope: string;
  readonly target: "purpose" | "task";
  readonly draftKind: string;
  readonly purposeKind: string | null;
  readonly taskKind: string | null;
  readonly sourceQuote: string;
  readonly interpretation: string;
  readonly sourceKind: "model";
  readonly sourceTurnId: string;
  readonly sourceRunId: string;
  readonly parentPurposeId: string | null;
  readonly expectedParentVersion: number | null;
  readonly status: "pending" | "accepted" | "rejected";
  readonly version: number;
  readonly acceptedTargetId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isProposalView(value: unknown): value is ProposalView {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.scope === "string" &&
    (value.target === "purpose" || value.target === "task") &&
    typeof value.draftKind === "string" &&
    (value.purposeKind === null || typeof value.purposeKind === "string") &&
    (value.taskKind === null || typeof value.taskKind === "string") &&
    typeof value.sourceQuote === "string" &&
    typeof value.interpretation === "string" &&
    value.sourceKind === "model" &&
    typeof value.sourceTurnId === "string" &&
    typeof value.sourceRunId === "string" &&
    (value.parentPurposeId === null ||
      typeof value.parentPurposeId === "string") &&
    (value.expectedParentVersion === null ||
      typeof value.expectedParentVersion === "number") &&
    (value.status === "pending" ||
      value.status === "accepted" ||
      value.status === "rejected") &&
    typeof value.version === "number" &&
    (value.acceptedTargetId === null ||
      typeof value.acceptedTargetId === "string") &&
    typeof value.createdAt === "number" &&
    typeof value.updatedAt === "number"
  );
}

function readItems(body: unknown): ProposalView[] {
  if (!isRecord(body)) return [];
  const items = body.items;
  if (!Array.isArray(items)) return [];
  return items.filter(isProposalView);
}

const DRAFT_KIND_TEXT: Record<string, string> = {
  casual: "雑談",
  wish: "希望",
  problem: "課題",
  task: "作業",
  deadline: "期限",
};

const STATUS_TEXT: Record<string, string> = {
  pending: "未採用",
  accepted: "採用済み",
  rejected: "見送り",
};

function textOf(map: Record<string, string>, key: string): string {
  return map[key] ?? key;
}

export class ProposalPanel {
  private readonly deps: ProposalPanelDeps;
  private badge: HTMLElement | null = null;
  private brief: HTMLElement | null = null;
  private list: HTMLElement | null = null;
  private refreshButton: HTMLButtonElement | null = null;
  private detail: HTMLElement | null = null;
  private detailBody: HTMLElement | null = null;
  private parentLine: HTMLElement | null = null;
  private dateInput: HTMLInputElement | null = null;
  private dateInputB: HTMLInputElement | null = null;
  private dateLabel: HTMLElement | null = null;
  private acceptButton: HTMLButtonElement | null = null;
  private rejectButton: HTMLButtonElement | null = null;
  private retryButton: HTMLButtonElement | null = null;
  private status: HTMLElement | null = null;

  private sessionSeq = 0;
  private listSeq = 0;
  private destroyed = false;
  private readonly items = new Map<string, ProposalView>();
  /** Explicitly selected pending draft id (drawer content). */
  private selectedId: string | null = null;
  /**
   * Frozen unresolved operation: {proposal id, session, key, endpoint,
   * body}. While set, selection/input changes cannot replace it; only the
   * explicit retry reuses the identical key+body. In memory only.
   */
  private pendingOp: {
    readonly proposalId: string;
    readonly ownerSession: string;
    readonly endpoint: string;
    readonly key: string;
    readonly body: Record<string, unknown>;
  } | null = null;
  private opInFlight = false;

  constructor(deps: ProposalPanelDeps) {
    this.deps = deps;
  }

  bind(): void {
    const required = <T extends HTMLElement>(id: string): T => {
      const node = document.getElementById(id);
      if (node === null) throw new Error(`proposal node missing: ${id}`);
      return node as T;
    };
    required<HTMLElement>("proposals");
    this.badge = required<HTMLElement>("proposal-badge");
    this.brief = required<HTMLElement>("proposal-brief");
    this.list = required<HTMLElement>("proposal-list");
    this.refreshButton = required<HTMLButtonElement>("proposal-refresh");
    this.detail = required<HTMLElement>("proposal-detail");
    this.detailBody = required<HTMLElement>("proposal-detail-body");
    this.parentLine = required<HTMLElement>("proposal-parent");
    this.dateInput = required<HTMLInputElement>("proposal-date");
    this.dateInputB = required<HTMLInputElement>("proposal-date-until");
    this.dateLabel = required<HTMLElement>("proposal-date-label");
    this.acceptButton = required<HTMLButtonElement>("proposal-accept");
    this.rejectButton = required<HTMLButtonElement>("proposal-reject");
    this.retryButton = required<HTMLButtonElement>("proposal-retry");
    this.status = required<HTMLElement>("proposal-status");
    this.refreshButton.addEventListener("click", () => {
      void this.refresh();
    });
    this.acceptButton.addEventListener("click", () => {
      void this.commitAccept();
    });
    this.rejectButton.addEventListener("click", () => {
      void this.commitReject();
    });
    this.retryButton.addEventListener("click", () => {
      void this.retryPendingOp();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") this.maybeBrief();
    });
  }

  /** Session lifecycle: clear state, hide drawer, boot new session. */
  notifySessionChanged(): void {
    this.sessionSeq += 1;
    this.items.clear();
    this.selectedId = null;
    this.pendingOp = null;
    this.opInFlight = false;
    if (this.detail !== null) this.detail.hidden = true;
    if (this.retryButton !== null) this.retryButton.hidden = true;
    this.renderAll();
    void this.refresh();
  }

  /** Run-settled hook: re-read the quiet list (never taskize chat). */
  notifyRunSettled(): void {
    void this.refresh();
  }

  /** Composer lifecycle: a natural break may show the quiet brief. */
  notifyComposureChanged(): void {
    this.maybeBrief();
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

  private pendingCount(): number {
    let n = 0;
    for (const item of this.items.values()) {
      if (item.status === "pending") n += 1;
    }
    return n;
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
        `/api/sessions/${sessionId}/conversation-proposals?limit=50`,
      );
    } catch {
      if (session === this.sessionSeq && seen === this.listSeq) {
        this.setStatus("候補の読み込みに失敗しました");
      }
      return;
    }
    if (session !== this.sessionSeq || seen !== this.listSeq) return;
    if (res.status !== 200) {
      this.setStatus("候補の読み込みに失敗しました");
      return;
    }
    const fresh = readItems(res.body);
    this.items.clear();
    for (const item of fresh) {
      if (item.sessionId === sessionId) this.items.set(item.id, item);
    }
    // A selected draft that left pending (adopted/rejected elsewhere) closes
    // the drawer; an unresolved frozen op keeps its drawer pinned.
    if (this.pendingOp === null && this.selectedId !== null) {
      const current = this.items.get(this.selectedId);
      if (current === undefined || current.status !== "pending") {
        this.selectedId = null;
        if (this.detail !== null) this.detail.hidden = true;
      }
    }
    this.renderAll();
    // Keep the open drawer truthful after a background refresh without
    // clobbering the human's typed date inputs.
    if (this.selectedId !== null) this.renderDetail(false);
  }

  private renderAll(): void {
    const pending = this.pendingCount();
    if (this.badge !== null) {
      this.badge.textContent =
        pending === 0
          ? "未採用の候補はありません"
          : `未採用の候補 ${pending}件`;
    }
    this.maybeBrief();
    if (this.list === null) return;
    while (this.list.firstChild !== null) {
      this.list.removeChild(this.list.firstChild);
    }
    const ordered = [...this.items.values()].sort(
      (a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1),
    );
    for (const item of ordered) {
      const row = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      // Badge text only: owned source + interpretation stay separate,
      // raw UUIDs hidden, status shown as human-readable text.
      button.textContent =
        `AI候補／${textOf(STATUS_TEXT, item.status)}` +
        `［${item.target === "purpose" ? "目的" : "作業"}・${textOf(DRAFT_KIND_TEXT, item.draftKind)}・${item.scope}］`;
      button.addEventListener("click", () => {
        this.select(item.id);
      });
      row.appendChild(button);
      this.list.appendChild(row);
    }
  }

  /** Quiet brief: text only, natural break only, never focus/steal. */
  private maybeBrief(): void {
    if (this.brief === null) return;
    const pending = this.pendingCount();
    if (pending === 0) {
      this.brief.textContent = "";
      return;
    }
    let natural = false;
    try {
      natural = this.deps.isNaturalBreak();
    } catch {
      natural = false;
    }
    this.brief.textContent = natural
      ? `AI候補が${pending}件あります。確認は任意です（自動では何も記録されません）。`
      : "";
  }

  private select(id: string): void {
    // An unresolved frozen operation pins the drawer: switching selection
    // cannot replace it (the retry affordance stays on the frozen draft).
    if (this.pendingOp !== null) {
      this.setStatus("未確定の操作があります。同じ内容で再送してください");
      return;
    }
    const item = this.items.get(id);
    if (item === undefined || item.status !== "pending") return;
    this.selectedId = id;
    if (this.detail !== null) this.detail.hidden = false;
    if (this.retryButton !== null) this.retryButton.hidden = true;
    this.renderDetail(true);
  }

  /** Render the drawer: quote apart from interpretation + parent title. */
  private renderDetail(resetDates: boolean): void {
    const item =
      this.selectedId === null ? undefined : this.items.get(this.selectedId);
    if (
      item === undefined ||
      this.detailBody === null ||
      this.parentLine === null ||
      this.dateInput === null ||
      this.dateInputB === null ||
      this.dateLabel === null
    ) {
      return;
    }
    while (this.detailBody.firstChild !== null) {
      this.detailBody.removeChild(this.detailBody.firstChild);
    }
    const badge = document.createElement("p");
    badge.textContent = `AI候補／未採用［${item.target === "purpose" ? "目的" : "作業"}・${textOf(DRAFT_KIND_TEXT, item.draftKind)}・${item.scope}］`;
    const quoteHead = document.createElement("p");
    quoteHead.textContent = "発言の原文（引用）:";
    const quote = document.createElement("p");
    quote.textContent = item.sourceQuote;
    const interpHead = document.createElement("p");
    interpHead.textContent = "AIの解釈（原文ではありません）:";
    const interp = document.createElement("p");
    interp.textContent = item.interpretation;
    this.detailBody.append(badge, quoteHead, quote, interpHead, interp);
    // Parent line: model's explicit parent only (immutable, human-readable
    // title fetched readonly; never auto-pick another purpose).
    this.parentLine.textContent = "";
    if (item.target === "task") {
      this.parentLine.textContent = "親の目的を確認しています…";
      void this.loadParentTitle(item);
    }
    if (resetDates || this.pendingOp === null) {
      this.dateInput.value = "";
      this.dateInputB.value = "";
    }
    if (item.target === "task") {
      this.dateLabel.textContent =
        "期限（任意・空欄は期限なし。厳密なRFC3339・時差必須。例 2026-10-20T09:00:00+09:00）";
      this.dateInputB.hidden = true;
    } else {
      this.dateLabel.textContent =
        "適用期間（任意・空欄は無期限。開始と終了いずれも厳密なRFC3339・時差必須）";
      this.dateInputB.hidden = false;
    }
    const locked = this.opInFlight;
    if (this.acceptButton !== null) this.acceptButton.disabled = locked;
    if (this.rejectButton !== null) this.rejectButton.disabled = locked;
  }

  private async loadParentTitle(item: ProposalView): Promise<void> {
    const session = this.sessionSeq;
    if (item.parentPurposeId === null) {
      if (this.parentLine !== null) {
        this.parentLine.textContent = "親の目的：なし（異常）";
      }
      return;
    }
    try {
      const res = await this.deps.http.get(
        `/api/sessions/${item.sessionId}/purposes/${item.parentPurposeId}`,
      );
      if (session !== this.sessionSeq) return;
      if (res.status === 200 && isRecord(res.body)) {
        const statement = res.body.statement;
        const version = res.body.version;
        if (typeof statement === "string" && typeof version === "number") {
          if (this.parentLine !== null) {
            // Readable title + staged version; the staged parent is
            // immutable (shown, never re-picked by the UI).
            this.parentLine.textContent = `親の目的（採用時に再確認・変更不可）: ${statement}（版 ${version}）`;
          }
          return;
        }
      }
      if (this.parentLine !== null) {
        this.parentLine.textContent =
          "親の目的は現在確認できません（採用時に再確認されます）";
      }
    } catch {
      if (session !== this.sessionSeq) return;
      if (this.parentLine !== null) {
        this.parentLine.textContent =
          "親の目的は現在確認できません（採用時に再確認されます）";
      }
    }
  }

  private frozenBody(item: ProposalView): Record<string, unknown> | null {
    if (this.dateInput === null || this.dateInputB === null) return null;
    const body: Record<string, unknown> = {
      expectedVersion: item.version,
    };
    if (item.target === "task") {
      const deadline = this.dateInput.value.trim();
      if (deadline.length > 0) body.deadline = deadline;
    } else {
      const from = this.dateInput.value.trim();
      const until = this.dateInputB.value.trim();
      if (from.length > 0) body.validFrom = from;
      if (until.length > 0) body.validUntil = until;
    }
    return body;
  }

  private async commitAccept(): Promise<void> {
    const item =
      this.selectedId === null ? undefined : this.items.get(this.selectedId);
    const sessionId = this.deps.getSessionId();
    if (item === undefined || sessionId === null || this.opInFlight) return;
    const body = this.frozenBody(item);
    if (body === null) return;
    const key = this.newKey();
    // Freeze {key, version, date fields} BEFORE the first send: every retry
    // (including the explicit retry after a lost response) reuses the
    // identical triple, so a redelivered POST replays ONE adoption.
    this.pendingOp = {
      proposalId: item.id,
      ownerSession: sessionId,
      endpoint: `/api/sessions/${sessionId}/conversation-proposals/${item.id}/accept`,
      key,
      body,
    };
    this.opInFlight = true;
    this.renderDetail(false);
    await this.sendPendingOp();
  }

  private async commitReject(): Promise<void> {
    const item =
      this.selectedId === null ? undefined : this.items.get(this.selectedId);
    const sessionId = this.deps.getSessionId();
    if (item === undefined || sessionId === null || this.opInFlight) return;
    const key = this.newKey();
    this.pendingOp = {
      proposalId: item.id,
      ownerSession: sessionId,
      endpoint: `/api/sessions/${sessionId}/conversation-proposals/${item.id}/reject`,
      key,
      body: { expectedVersion: item.version },
    };
    this.opInFlight = true;
    this.renderDetail(false);
    await this.sendPendingOp();
  }

  private async retryPendingOp(): Promise<void> {
    if (this.pendingOp === null || this.opInFlight) return;
    this.opInFlight = true;
    this.renderDetail(false);
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
      this.renderDetail(false);
      return;
    }
    if (session !== this.sessionSeq) return;
    const sessionId = this.deps.getSessionId();
    if (sessionId === null || sessionId !== op.ownerSession) return;
    if (res.status === 201 || res.status === 200) {
      this.pendingOp = null;
      this.opInFlight = false;
      if (this.retryButton !== null) this.retryButton.hidden = true;
      this.setStatus(res.status === 201 ? "採用しました" : "見送りにしました");
      this.selectedId = null;
      if (this.detail !== null) this.detail.hidden = true;
      await this.refresh();
      // Refresh the adopted purpose/task target via the existing public
      // hook without losing unrelated drafts (the drawer just closed).
      try {
        this.deps.onAdopted?.();
      } catch {
        // Best effort: the adoption already committed.
      }
      return;
    }
    if (res.status === 409) {
      // Honest conflict (stale version / parent drift / reused key):
      // keep the frozen op for the explicit same-key retry, re-read the
      // truth so the drawer never applies to a new version silently.
      this.opInFlight = false;
      if (this.retryButton !== null) this.retryButton.hidden = false;
      this.setStatus(
        "競合しました（版ずれ・親の変更・キーの再利用）。内容を確認して再送してください",
      );
      await this.refresh();
      return;
    }
    if (res.status === 404) {
      this.pendingOp = null;
      this.opInFlight = false;
      if (this.retryButton !== null) this.retryButton.hidden = true;
      this.setStatus("候補が見つかりません（別セッションの可能性）");
      this.selectedId = null;
      if (this.detail !== null) this.detail.hidden = true;
      await this.refresh();
      return;
    }
    this.opInFlight = false;
    if (this.retryButton !== null) this.retryButton.hidden = false;
    this.setStatus("操作に失敗しました。同じ内容で再送できます");
    this.renderDetail(false);
  }

  private setStatus(text: string): void {
    if (this.status !== null) this.status.textContent = text;
  }
}
