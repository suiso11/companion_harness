// AV03 delegation-handoff consumer panel (plain DOM, no framework).
//
// Separate browser module (mirrors `learning_panel.ts`): this file owns the
// "引継ぎ" section only. HTTP helpers and session state are INJECTED (no
// import from client.ts, no module cycle).
//
// Boundaries (pinned by regressions):
// - Handoffs are HUMAN-DRIVEN records only: every create/dispatch/report/
//   verify/fail/cancel/abnormal-exit/attempt/reaffirm is an explicit human
//   commit (CAS on the expected version) through the trusted HTTP routes.
//   The panel NEVER spawns workers/processes, NEVER grants anything, NEVER
//   enforces numeric budgets (budget text labels only), and NEVER
//   auto-completes the task.
// - Sandbox claims stay sandbox: the report environment is UNTRUSTED text
//   and a sandbox success NEVER implies production (「サンドボックス成功≠
//   本番」). Boundary flags are recorded claims requiring separate
//   authorization (「権限は別途承認」).
// - Frozen criteria are quoted verbatim: verification needs a pass +
//   evidence result for EVERY frozen criterion (all pass), and changing
//   criteria needs a NEW superseding handoff (never an edit).
// - Model text is UNTRUSTED: every string renders via `textContent` only.
// - Uncertain operations freeze {key, expectedVersion, body} IN MEMORY only
//   (same-key retry, never a new key on a lost response). While one
//   operation is unresolved, changing selection or inputs cannot replace it.
// - Session guards: generations invalidate SYNC, so a held old-session reply
//   can never render into the new session. No user/model body in
//   localStorage. Reads come from the ACTUAL HTTP API.

/// <reference lib="dom" />

export interface HandoffHttp {
  get(path: string): Promise<{ status: number; body: unknown }>;
  post(
    path: string,
    payload: unknown,
    key: string,
  ): Promise<{ status: number; body: unknown }>;
  getText(path: string): Promise<{ status: number; text: string }>;
}

export interface HandoffPanelDeps {
  getSessionId: () => string | null;
  http: HandoffHttp;
  randomKey?: () => string;
}

interface HandoffView {
  readonly id: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly taskVersion: number;
  readonly parentPurposeId: string | null;
  readonly parentPurposeVersion: number | null;
  readonly target: string;
  readonly acceptanceCriteria: string[];
  readonly opScope: "investigate" | "implement";
  readonly budgetLabel: string | null;
  readonly boundaries: string[];
  readonly status:
    | "prepared"
    | "dispatched"
    | "reported"
    | "verified"
    | "failed"
    | "cancelled";
  readonly version: number;
  readonly needsReevaluation: boolean;
  readonly activeAttempt: number;
  readonly externalRef: string | null;
  readonly reportEnvironment: "sandbox" | "production" | null;
  readonly reportSummary: string | null;
  readonly verificationResults:
    | {
        readonly index: number;
        readonly pass: boolean;
        readonly evidence: string;
      }[]
    | null;
  readonly supersedesHandoffId: string | null;
  readonly supersededBy: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

function isHandoffView(value: unknown): value is HandoffView {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.taskId === "string" &&
    typeof value.taskVersion === "number" &&
    (value.parentPurposeId === null ||
      typeof value.parentPurposeId === "string") &&
    (value.parentPurposeVersion === null ||
      typeof value.parentPurposeVersion === "number") &&
    typeof value.target === "string" &&
    isStringArray(value.acceptanceCriteria) &&
    (value.opScope === "investigate" || value.opScope === "implement") &&
    (value.budgetLabel === null || typeof value.budgetLabel === "string") &&
    isStringArray(value.boundaries) &&
    (value.status === "prepared" ||
      value.status === "dispatched" ||
      value.status === "reported" ||
      value.status === "verified" ||
      value.status === "failed" ||
      value.status === "cancelled") &&
    typeof value.version === "number" &&
    typeof value.needsReevaluation === "boolean" &&
    typeof value.activeAttempt === "number" &&
    (value.externalRef === null || typeof value.externalRef === "string") &&
    (value.reportEnvironment === null ||
      value.reportEnvironment === "sandbox" ||
      value.reportEnvironment === "production") &&
    (value.reportSummary === null || typeof value.reportSummary === "string") &&
    (value.verificationResults === null ||
      Array.isArray(value.verificationResults)) &&
    (value.supersedesHandoffId === null ||
      typeof value.supersedesHandoffId === "string") &&
    (value.supersededBy === null || typeof value.supersededBy === "string") &&
    typeof value.createdAt === "number" &&
    typeof value.updatedAt === "number"
  );
}

function readItems(body: unknown): HandoffView[] {
  if (!isRecord(body)) return [];
  const items = body.items;
  if (!Array.isArray(items)) return [];
  return items.filter(isHandoffView);
}

function readActiveCount(body: unknown): number | null {
  if (!isRecord(body)) return null;
  return typeof body.activeCount === "number" ? body.activeCount : null;
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

const STATUS_TEXT: Record<string, string> = {
  prepared: "準備中",
  dispatched: "送付済",
  reported: "報告あり",
  verified: "検証済",
  failed: "失敗",
  cancelled: "取消",
};

const OP_SCOPE_TEXT: Record<string, string> = {
  investigate: "調査",
  implement: "実装",
};

const BOUNDARY_TEXT: Record<string, string> = {
  external_publication: "外部公開",
  shared_branch: "共有ブランチ",
  payment: "支払い",
  deletion: "削除",
  secret: "秘密情報",
  access_change: "権限変更",
};

const CAUSE_TEXT: Record<string, string> = {
  transient_infra: "一時的障害",
  worker_error: "作業者エラー",
  criteria_unmet: "条件未達",
  environment: "環境要因",
};

function textOf(map: Record<string, string>, key: string): string {
  return map[key] ?? key;
}

export class HandoffPanel {
  private readonly deps: HandoffPanelDeps;
  private taskInput: HTMLInputElement | null = null;
  private targetInput: HTMLTextAreaElement | null = null;
  private criteriaInput: HTMLTextAreaElement | null = null;
  private opScopeSelect: HTMLSelectElement | null = null;
  private budgetInput: HTMLInputElement | null = null;
  private boundariesSelect: HTMLSelectElement | null = null;
  private supersedesInput: HTMLInputElement | null = null;
  private createButton: HTMLButtonElement | null = null;
  private list: HTMLElement | null = null;
  private refreshButton: HTMLButtonElement | null = null;
  private moreButton: HTMLButtonElement | null = null;
  private activeCount: HTMLElement | null = null;
  private detail: HTMLElement | null = null;
  private detailBody: HTMLElement | null = null;
  private eventsList: HTMLElement | null = null;
  private attemptsList: HTMLElement | null = null;
  private externalRefInput: HTMLInputElement | null = null;
  private dispatchButton: HTMLButtonElement | null = null;
  private reportEnvSelect: HTMLSelectElement | null = null;
  private reportSummaryInput: HTMLTextAreaElement | null = null;
  private reportButton: HTMLButtonElement | null = null;
  private verifyRows: HTMLElement | null = null;
  private verifyButton: HTMLButtonElement | null = null;
  private failButton: HTMLButtonElement | null = null;
  private cancelButton: HTMLButtonElement | null = null;
  private abnormalButton: HTMLButtonElement | null = null;
  private attemptCauseSelect: HTMLSelectElement | null = null;
  private attemptButton: HTMLButtonElement | null = null;
  private reaffirmButton: HTMLButtonElement | null = null;
  private specButton: HTMLButtonElement | null = null;
  private specView: HTMLElement | null = null;
  private retryButton: HTMLButtonElement | null = null;
  private status: HTMLElement | null = null;

  private sessionSeq = 0;
  private listSeq = 0;
  private destroyed = false;
  /** Newest-history keyset: opaque cursor + truthful older-page flag. */
  private historyCursor: string | null = null;
  private historyHasMore = false;
  private readonly items = new Map<string, HandoffView>();
  /** Explicitly selected handoff id (drawer content). */
  private selectedId: string | null = null;
  /**
   * Frozen unresolved operation: {handoff id, session, key, endpoint,
   * body}. While set, selection/input changes cannot replace it; only the
   * explicit retry reuses the identical key+body. In memory only.
   */
  private pendingOp: {
    readonly handoffId: string;
    readonly ownerSession: string;
    readonly endpoint: string;
    readonly key: string;
    readonly body: Record<string, unknown>;
  } | null = null;
  private opInFlight = false;
  /** Per-criterion verify inputs for the OPEN selection (rebuilt per row). */
  private verifyInputs: {
    pass: HTMLSelectElement;
    evidence: HTMLInputElement;
  }[] = [];

  constructor(deps: HandoffPanelDeps) {
    this.deps = deps;
  }

  bind(): void {
    const required = <T extends HTMLElement>(id: string): T => {
      const node = document.getElementById(id);
      if (node === null) throw new Error(`handoff node missing: ${id}`);
      return node as T;
    };
    required<HTMLElement>("handoff");
    this.taskInput = required<HTMLInputElement>("handoff-task");
    this.targetInput = required<HTMLTextAreaElement>("handoff-target");
    this.criteriaInput = required<HTMLTextAreaElement>("handoff-criteria");
    this.opScopeSelect = required<HTMLSelectElement>("handoff-op-scope");
    this.budgetInput = required<HTMLInputElement>("handoff-budget");
    this.boundariesSelect = required<HTMLSelectElement>("handoff-boundaries");
    this.supersedesInput = required<HTMLInputElement>("handoff-supersedes");
    this.createButton = required<HTMLButtonElement>("handoff-create");
    this.list = required<HTMLElement>("handoff-list");
    this.refreshButton = required<HTMLButtonElement>("handoff-refresh");
    this.moreButton = required<HTMLButtonElement>("handoff-more");
    this.activeCount = required<HTMLElement>("handoff-active-count");
    this.detail = required<HTMLElement>("handoff-detail");
    this.detailBody = required<HTMLElement>("handoff-detail-body");
    this.eventsList = required<HTMLElement>("handoff-events-list");
    this.attemptsList = required<HTMLElement>("handoff-attempts-list");
    this.externalRefInput = required<HTMLInputElement>("handoff-external-ref");
    this.dispatchButton = required<HTMLButtonElement>("handoff-dispatch");
    this.reportEnvSelect = required<HTMLSelectElement>("handoff-report-env");
    this.reportSummaryInput = required<HTMLTextAreaElement>(
      "handoff-report-summary",
    );
    this.reportButton = required<HTMLButtonElement>("handoff-report");
    this.verifyRows = required<HTMLElement>("handoff-verify-rows");
    this.verifyButton = required<HTMLButtonElement>("handoff-verify");
    this.failButton = required<HTMLButtonElement>("handoff-fail");
    this.cancelButton = required<HTMLButtonElement>("handoff-cancel");
    this.abnormalButton = required<HTMLButtonElement>("handoff-abnormal");
    this.attemptCauseSelect = required<HTMLSelectElement>(
      "handoff-attempt-cause",
    );
    this.attemptButton = required<HTMLButtonElement>("handoff-attempt");
    this.reaffirmButton = required<HTMLButtonElement>("handoff-reaffirm");
    this.specButton = required<HTMLButtonElement>("handoff-spec");
    this.specView = required<HTMLElement>("handoff-spec-view");
    this.retryButton = required<HTMLButtonElement>("handoff-retry");
    this.status = required<HTMLElement>("handoff-status");
    this.createButton.addEventListener("click", () => {
      void this.commitCreate();
    });
    this.refreshButton.addEventListener("click", () => {
      void this.refresh();
    });
    this.moreButton.addEventListener("click", () => {
      void this.loadOlderHistory();
    });
    this.dispatchButton.addEventListener("click", () => {
      void this.commitMutation("dispatch");
    });
    this.reportButton.addEventListener("click", () => {
      void this.commitReport();
    });
    this.verifyButton.addEventListener("click", () => {
      void this.commitVerify();
    });
    this.failButton.addEventListener("click", () => {
      void this.commitMutation("fail");
    });
    this.cancelButton.addEventListener("click", () => {
      void this.commitMutation("cancel");
    });
    this.abnormalButton.addEventListener("click", () => {
      void this.commitMutation("abnormal-exit");
    });
    this.attemptButton.addEventListener("click", () => {
      void this.commitAttempt();
    });
    this.reaffirmButton.addEventListener("click", () => {
      void this.commitMutation("reaffirm");
    });
    this.specButton.addEventListener("click", () => {
      void this.exportSpec();
    });
    this.retryButton.addEventListener("click", () => {
      void this.retryPendingOp();
    });
  }

  /** Session lifecycle: clear state, hide drawer, boot new session. */
  notifySessionChanged(): void {
    this.sessionSeq += 1;
    this.items.clear();
    this.selectedId = null;
    this.pendingOp = null;
    this.opInFlight = false;
    this.historyCursor = null;
    this.historyHasMore = false;
    this.verifyInputs = [];
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
        `/api/sessions/${sessionId}/handoffs?limit=50&cursor=${encodeURIComponent(cursor)}`,
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

  private async refresh(): Promise<void> {
    const sessionId = this.deps.getSessionId();
    if (sessionId === null || this.destroyed) return;
    const session = this.sessionSeq;
    this.listSeq += 1;
    const seen = this.listSeq;
    let res: { status: number; body: unknown };
    try {
      res = await this.deps.http.get(
        `/api/sessions/${sessionId}/handoffs?limit=50`,
      );
    } catch {
      if (session === this.sessionSeq && seen === this.listSeq) {
        this.setStatus("引継ぎの読み込みに失敗しました");
      }
      return;
    }
    if (session !== this.sessionSeq || seen !== this.listSeq) return;
    if (res.status !== 200) {
      this.setStatus("引継ぎの読み込みに失敗しました");
      return;
    }
    // Merge the newest page into the map (never clear): older pages loaded
    // via "古い履歴を読み込む" stay reachable, and a 409 re-read never
    // drops the older-page row behind the frozen op.
    for (const item of readItems(res.body)) {
      if (item.sessionId === sessionId) this.items.set(item.id, item);
    }
    this.historyCursor = readCursor(res.body);
    this.historyHasMore = readHasMore(res.body);
    const active = readActiveCount(res.body);
    if (this.activeCount !== null) {
      // Concurrency TRACKING count only: no numeric limit is invented or
      // enforced (active = dispatched/reported).
      this.activeCount.textContent =
        active === null
          ? "実行中の記録数: 不明"
          : `実行中の記録数: ${active}（上限なし・追跡のみ）`;
    }
    // A selected handoff missing from the newest page is NOT gone: it
    // may live on an older page. Fetch it directly; close the drawer only
    // when the server says it is gone (404). An unresolved frozen op keeps
    // its drawer pinned without any fetch.
    if (this.pendingOp === null && this.selectedId !== null) {
      if (!this.items.has(this.selectedId)) {
        const missing = this.selectedId;
        try {
          const single = await this.deps.http.get(
            `/api/sessions/${sessionId}/handoffs/${missing}`,
          );
          if (session !== this.sessionSeq || seen !== this.listSeq) return;
          if (
            single.status === 200 &&
            isHandoffView(single.body) &&
            (single.body as HandoffView).sessionId === sessionId
          ) {
            this.items.set(missing, single.body as HandoffView);
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
    // clobbering the human's typed inputs.
    if (this.selectedId !== null) this.renderDetail(false);
  }

  private renderAll(): void {
    if (this.list === null) return;
    if (this.moreButton !== null) {
      this.moreButton.hidden = !this.historyHasMore;
    }
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
      // Explicit handoff badge: status + scope + reevaluation flag. Raw
      // UUIDs hidden, status human-readable.
      const flags = item.needsReevaluation ? "／要再評価" : "";
      const bounds =
        item.boundaries.length === 0
          ? ""
          : `［要承認:${item.boundaries.map((b) => textOf(BOUNDARY_TEXT, b)).join("・")}］`;
      button.textContent =
        `引継ぎ［${textOf(STATUS_TEXT, item.status)}・${textOf(OP_SCOPE_TEXT, item.opScope)}${flags}］` +
        `［試行${item.activeAttempt}］${bounds}`;
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
    this.renderDetail(true);
    void this.loadHistory(item);
  }

  /** Render the drawer: frozen fields + reports + controls. */
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
    const flags = item.needsReevaluation
      ? "／要再評価（親の目的が変更されました。送付前に再確認してください）"
      : "";
    badge.textContent = `引継ぎ［${textOf(STATUS_TEXT, item.status)}・${textOf(OP_SCOPE_TEXT, item.opScope)}${flags}］（版 ${item.version}・試行 ${item.activeAttempt}）`;
    const targetHead = document.createElement("p");
    targetHead.textContent = "目的（凍結・人間入力）:";
    const target = document.createElement("p");
    target.textContent = item.target;
    const criteriaHead = document.createElement("p");
    criteriaHead.textContent = `受入条件（凍結 ${item.acceptanceCriteria.length} 件・変更は新規引継ぎで継承のみ）:`;
    const criteria = document.createElement("ol");
    for (const criterion of item.acceptanceCriteria) {
      const line = document.createElement("li");
      line.textContent = criterion;
      criteria.appendChild(line);
    }
    const budget = document.createElement("p");
    budget.textContent = `予算（人間入力の文字列・数値強制なし）: ${item.budgetLabel ?? "（申告なし）"}`;
    const bounds = document.createElement("p");
    bounds.textContent =
      item.boundaries.length === 0
        ? "権限: 追加の個別承認を要する申請なし"
        : `権限は別途承認: ${item.boundaries.map((b) => textOf(BOUNDARY_TEXT, b)).join("・")} は個別承認が必要（この記録は何も許可しません）`;
    const report = document.createElement("p");
    report.textContent =
      item.reportEnvironment === null
        ? "報告: まだありません（サンドボックス成功≠本番）"
        : `報告（未検証の作業者申告）: 環境=${item.reportEnvironment}／${item.reportSummary ?? ""}（サンドボックス成功≠本番）`;
    const supersede = document.createElement("p");
    if (item.supersedesHandoffId !== null || item.supersededBy !== null) {
      const oldCriteria =
        item.supersedesHandoffId !== null
          ? this.items.get(item.supersedesHandoffId)?.acceptanceCriteria
          : undefined;
      let diff = "";
      if (oldCriteria !== undefined) {
        const added = item.acceptanceCriteria.filter(
          (c) => !oldCriteria.includes(c),
        );
        const removed = oldCriteria.filter(
          (c) => !item.acceptanceCriteria.includes(c),
        );
        diff = `（旧条件との差分: 追加${added.length}・削除${removed.length}。旧記録は凍結のまま残ります）`;
      }
      supersede.textContent =
        `継承: ${item.supersedesHandoffId === null ? "" : `旧=${item.supersedesHandoffId.slice(0, 8)}…`} ` +
        `${item.supersededBy === null ? "" : `新=${item.supersededBy.slice(0, 8)}…`}${diff}`;
      this.detailBody.append(supersede);
    }
    this.detailBody.append(
      badge,
      targetHead,
      target,
      criteriaHead,
      criteria,
      budget,
      bounds,
      report,
    );
    this.renderVerifyRows(item, resetInputs);
    // Human-typed report/external inputs survive every same-selection
    // refresh: only an explicit NEW selection clears them.
    if (resetInputs) {
      if (this.externalRefInput !== null) this.externalRefInput.value = "";
      if (this.reportSummaryInput !== null) this.reportSummaryInput.value = "";
      if (this.specView !== null) {
        while (this.specView.firstChild !== null) {
          this.specView.removeChild(this.specView.firstChild);
        }
      }
    }
    const locked = this.opInFlight || this.pendingOp !== null;
    const terminal =
      item.status === "verified" ||
      item.status === "failed" ||
      item.status === "cancelled";
    const active = !terminal && !locked;
    const dispatchable =
      active && item.status === "prepared" && !item.needsReevaluation;
    const reportable = active && item.status === "dispatched";
    const verifiable = active && item.status === "reported";
    const retryable =
      active &&
      (item.status === "prepared" ||
        item.status === "dispatched" ||
        item.status === "reported" ||
        item.status === "failed") &&
      !item.needsReevaluation;
    // Cancel is ALWAYS allowed (even under a reevaluation notice).
    const cancellable =
      !locked &&
      (item.status === "prepared" ||
        item.status === "dispatched" ||
        item.status === "reported");
    const reaffirmAble = !locked && !terminal && item.needsReevaluation;
    if (this.dispatchButton !== null) {
      this.dispatchButton.disabled = !dispatchable;
    }
    if (this.reportButton !== null) this.reportButton.disabled = !reportable;
    if (this.verifyButton !== null) {
      this.verifyButton.disabled = !verifiable;
    }
    if (this.failButton !== null) this.failButton.disabled = !active;
    if (this.cancelButton !== null) {
      this.cancelButton.disabled = !cancellable;
    }
    if (this.abnormalButton !== null) this.abnormalButton.disabled = !active;
    if (this.attemptButton !== null) {
      this.attemptButton.disabled = !(retryable || item.status === "failed");
    }
    if (this.reaffirmButton !== null) {
      this.reaffirmButton.disabled = !reaffirmAble;
    }
    if (this.specButton !== null) this.specButton.disabled = locked;
  }

  /** Per-criterion verify rows (frozen list length, human pass+evidence). */
  private renderVerifyRows(item: HandoffView, resetInputs: boolean): void {
    if (this.verifyRows === null) return;
    while (this.verifyRows.firstChild !== null) {
      this.verifyRows.removeChild(this.verifyRows.firstChild);
    }
    const head = document.createElement("p");
    head.textContent =
      "検証（全条件が合格かつ証拠必須・一つでも不合格なら検証不可・条件を緩めない）:";
    this.verifyRows.appendChild(head);
    const kept = resetInputs ? [] : this.verifyInputs;
    this.verifyInputs = [];
    item.acceptanceCriteria.forEach((criterion, index) => {
      const row = document.createElement("div");
      const label = document.createElement("p");
      label.textContent = `条件${index + 1}: ${criterion}`;
      const pass = document.createElement("select");
      const none = document.createElement("option");
      none.value = "";
      none.textContent = "未判定";
      const ok = document.createElement("option");
      ok.value = "pass";
      ok.textContent = "合格";
      const ng = document.createElement("option");
      ng.value = "fail";
      ng.textContent = "不合格";
      pass.append(none, ok, ng);
      const evidence = document.createElement("input");
      evidence.type = "text";
      evidence.autocomplete = "off";
      evidence.placeholder = "証拠テキスト";
      const prior = kept[index];
      if (prior !== undefined) {
        pass.value = prior.pass.value;
        evidence.value = prior.evidence.value;
      }
      row.append(label, pass, evidence);
      if (this.verifyRows !== null) this.verifyRows.appendChild(row);
      this.verifyInputs.push({ pass, evidence });
    });
  }

  private async loadHistory(item: HandoffView): Promise<void> {
    const session = this.sessionSeq;
    const selected = this.selectedId;
    try {
      const [events, attempts] = await Promise.all([
        this.deps.http.get(
          `/api/sessions/${item.sessionId}/handoffs/${item.id}/events`,
        ),
        this.deps.http.get(
          `/api/sessions/${item.sessionId}/handoffs/${item.id}/attempts`,
        ),
      ]);
      if (session !== this.sessionSeq) return;
      if (this.selectedId !== selected) return;
      if (this.eventsList !== null) {
        while (this.eventsList.firstChild !== null) {
          this.eventsList.removeChild(this.eventsList.firstChild);
        }
        const rows =
          isRecord(events.body) && Array.isArray(events.body.events)
            ? (events.body.events as unknown[])
            : [];
        if (rows.length === 0) {
          const empty = document.createElement("li");
          empty.textContent = "履歴はまだありません";
          this.eventsList.appendChild(empty);
        }
        for (const row of rows) {
          if (!isRecord(row)) continue;
          const line = document.createElement("li");
          line.textContent = `${String(row.event)}: ${String(row.fromStatus ?? "-")} → ${String(row.toStatus)}${row.note === null || row.note === undefined ? "" : ` ／ ${String(row.note).slice(0, 80)}`}`;
          this.eventsList.appendChild(line);
        }
      }
      if (this.attemptsList !== null) {
        while (this.attemptsList.firstChild !== null) {
          this.attemptsList.removeChild(this.attemptsList.firstChild);
        }
        const rows =
          isRecord(attempts.body) && Array.isArray(attempts.body.attempts)
            ? (attempts.body.attempts as unknown[])
            : [];
        if (rows.length === 0) {
          const empty = document.createElement("li");
          empty.textContent = "試行記録はまだありません（自動再試行なし）";
          this.attemptsList.appendChild(empty);
        }
        for (const row of rows) {
          if (!isRecord(row)) continue;
          const line = document.createElement("li");
          line.textContent = `試行${String(row.attemptNo)}: ${textOf(CAUSE_TEXT, String(row.cause))}（人手で記録・自動再試行なし）`;
          this.attemptsList.appendChild(line);
        }
      }
    } catch {
      if (session !== this.sessionSeq) return;
      if (this.selectedId !== selected) return;
      this.setStatus("履歴の読み込みに失敗しました");
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
      this.taskInput === null ||
      this.targetInput === null ||
      this.criteriaInput === null ||
      this.opScopeSelect === null ||
      this.boundariesSelect === null
    ) {
      return;
    }
    const taskId = this.taskInput.value.trim();
    const target = this.targetInput.value.trim();
    const criteria = this.criteriaInput.value
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const opScope = this.opScopeSelect.value;
    const budget =
      this.budgetInput === null ? "" : this.budgetInput.value.trim();
    const boundaries: string[] = [];
    for (const option of Array.from(this.boundariesSelect.selectedOptions)) {
      boundaries.push(option.value);
    }
    const supersedes =
      this.supersedesInput === null ? "" : this.supersedesInput.value.trim();
    if (!UUID_RE.test(taskId)) {
      this.setStatus("作業IDはUUID形式で入力してください");
      return;
    }
    if (target.length === 0 || criteria.length === 0) {
      this.setStatus("目的と受入条件を入力してください");
      return;
    }
    if (opScope !== "investigate" && opScope !== "implement") {
      this.setStatus("作業範囲が不正です");
      return;
    }
    if (supersedes.length > 0 && !UUID_RE.test(supersedes)) {
      this.setStatus("継承元IDはUUID形式で入力してください");
      return;
    }
    const key = this.newKey();
    const body: Record<string, unknown> = {
      taskId,
      target,
      acceptanceCriteria: criteria,
      opScope,
      boundaries,
    };
    if (budget.length > 0) body.budgetLabel = budget;
    if (supersedes.length > 0) body.supersedesHandoffId = supersedes;
    // Freeze {key, body} BEFORE the first send: every retry reuses the
    // identical pair, so a redelivered POST replays ONE handoff.
    this.pendingOp = {
      handoffId: "",
      ownerSession: sessionId,
      endpoint: `/api/sessions/${sessionId}/handoffs`,
      key,
      body,
    };
    this.opInFlight = true;
    await this.sendPendingOp();
  }

  /** Dispatch / fail / cancel / abnormal-exit / reaffirm (CAS version only). */
  private async commitMutation(
    suffix: "dispatch" | "fail" | "cancel" | "abnormal-exit" | "reaffirm",
  ): Promise<void> {
    const item =
      this.selectedId === null ? undefined : this.items.get(this.selectedId);
    const sessionId = this.deps.getSessionId();
    if (this.pendingOp !== null) {
      this.setStatus("未確定の操作があります。同じ内容で再送してください");
      return;
    }
    if (item === undefined || sessionId === null || this.opInFlight) {
      return;
    }
    if (suffix === "dispatch" && item.needsReevaluation) {
      this.setStatus("要再評価のため送付できません。再確認してください");
      return;
    }
    const key = this.newKey();
    const body: Record<string, unknown> = {
      expectedVersion: item.version,
    };
    // Dispatch records an optional human external reference text (never
    // resolved, never fetched).
    if (
      suffix === "dispatch" &&
      this.externalRefInput !== null &&
      this.externalRefInput.value.trim().length > 0
    ) {
      body.externalRef = this.externalRefInput.value.trim();
    }
    this.pendingOp = {
      handoffId: item.id,
      ownerSession: sessionId,
      endpoint: `/api/sessions/${sessionId}/handoffs/${item.id}/${suffix}`,
      key,
      body,
    };
    this.opInFlight = true;
    this.renderDetail(false);
    await this.sendPendingOp();
  }

  /** Record the UNTRUSTED worker report (sandbox NEVER means production). */
  private async commitReport(): Promise<void> {
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
      this.reportEnvSelect === null ||
      this.reportSummaryInput === null
    ) {
      return;
    }
    const environment = this.reportEnvSelect.value;
    const summary = this.reportSummaryInput.value.trim();
    if (environment !== "sandbox" && environment !== "production") {
      this.setStatus("報告環境が不正です");
      return;
    }
    if (summary.length === 0) {
      this.setStatus("報告内容を入力してください（未検証の申告として記録）");
      return;
    }
    const key = this.newKey();
    this.pendingOp = {
      handoffId: item.id,
      ownerSession: sessionId,
      endpoint: `/api/sessions/${sessionId}/handoffs/${item.id}/report`,
      key,
      body: { expectedVersion: item.version, environment, summary },
    };
    this.opInFlight = true;
    this.renderDetail(false);
    await this.sendPendingOp();
  }

  /** Verification: pass + evidence for EVERY frozen criterion (all pass). */
  private async commitVerify(): Promise<void> {
    const item =
      this.selectedId === null ? undefined : this.items.get(this.selectedId);
    const sessionId = this.deps.getSessionId();
    if (this.pendingOp !== null) {
      this.setStatus("未確定の操作があります。同じ内容で再送してください");
      return;
    }
    if (item === undefined || sessionId === null || this.opInFlight) {
      return;
    }
    if (this.verifyInputs.length !== item.acceptanceCriteria.length) {
      this.setStatus("検証入力を読み込めません（一覧を更新してください）");
      return;
    }
    const results: { index: number; pass: boolean; evidence: string }[] = [];
    for (let index = 0; index < this.verifyInputs.length; index += 1) {
      const row = this.verifyInputs[index];
      if (row === undefined) continue;
      const verdict = row.pass.value;
      const evidence = row.evidence.value.trim();
      if (verdict !== "pass" && verdict !== "fail") {
        this.setStatus(`条件${index + 1}の合否を選択してください`);
        return;
      }
      if (evidence.length === 0) {
        this.setStatus(`条件${index + 1}の証拠を入力してください`);
        return;
      }
      results.push({
        index,
        pass: verdict === "pass",
        evidence,
      });
    }
    const key = this.newKey();
    this.pendingOp = {
      handoffId: item.id,
      ownerSession: sessionId,
      endpoint: `/api/sessions/${sessionId}/handoffs/${item.id}/verify`,
      key,
      body: { expectedVersion: item.version, results },
    };
    this.opInFlight = true;
    this.renderDetail(false);
    await this.sendPendingOp();
  }

  /** Explicit human retry record with a REQUIRED cause (never automatic). */
  private async commitAttempt(): Promise<void> {
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
      this.attemptCauseSelect === null
    ) {
      return;
    }
    const cause = this.attemptCauseSelect.value;
    if (
      cause !== "transient_infra" &&
      cause !== "worker_error" &&
      cause !== "criteria_unmet" &&
      cause !== "environment"
    ) {
      this.setStatus("再試行の原因を選択してください");
      return;
    }
    const key = this.newKey();
    this.pendingOp = {
      handoffId: item.id,
      ownerSession: sessionId,
      endpoint: `/api/sessions/${sessionId}/handoffs/${item.id}/attempt`,
      key,
      body: { expectedVersion: item.version, cause },
    };
    this.opInFlight = true;
    this.renderDetail(false);
    await this.sendPendingOp();
  }

  /** Fetch the deterministic handoff spec and copy it for manual pi-orch. */
  private async exportSpec(): Promise<void> {
    const item =
      this.selectedId === null ? undefined : this.items.get(this.selectedId);
    const sessionId = this.deps.getSessionId();
    if (item === undefined || sessionId === null) return;
    const session = this.sessionSeq;
    const selected = this.selectedId;
    let res: { status: number; text: string };
    try {
      res = await this.deps.http.getText(
        `/api/sessions/${sessionId}/handoffs/${item.id}/spec`,
      );
    } catch {
      if (session === this.sessionSeq) {
        this.setStatus("仕様の取得に失敗しました");
      }
      return;
    }
    if (session !== this.sessionSeq || this.selectedId !== selected) return;
    if (res.status !== 200 || this.specView === null) {
      this.setStatus("仕様の取得に失敗しました");
      return;
    }
    while (this.specView.firstChild !== null) {
      this.specView.removeChild(this.specView.firstChild);
    }
    const pre = document.createElement("pre");
    pre.textContent = res.text;
    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "仕様をコピー（手動でpi-orchへ貼り付け）";
    copy.addEventListener("click", () => {
      try {
        const done = navigator.clipboard?.writeText(res.text);
        if (done !== undefined) {
          void done.then(
            () => this.setStatus("仕様をコピーしました"),
            () => this.setStatus("コピーに失敗しました（選択して手動コピー）"),
          );
        } else {
          this.setStatus("選択して手動でコピーしてください");
        }
      } catch {
        this.setStatus("選択して手動でコピーしてください");
      }
    });
    this.specView.append(pre, copy);
    this.setStatus("仕様を取得しました（実行は自動化されません）");
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
        op.handoffId === "" ? "引継ぎを記録しました" : "操作を反映しました",
      );
      await this.refresh();
      if (session !== this.sessionSeq) return;
      // Selection-bound: the created/updated record opens only when it is
      // still owned by this session.
      if (op.handoffId === "" && isRecord(res.body)) {
        const id = res.body.id;
        if (typeof id === "string" && this.items.has(id)) {
          this.selectedId = id;
          if (this.detail !== null) this.detail.hidden = false;
          this.renderDetail(true);
          const current = this.items.get(id);
          if (current !== undefined) void this.loadHistory(current);
        }
      } else if (this.selectedId !== null) {
        this.renderDetail(false);
        const current =
          this.selectedId === null
            ? undefined
            : this.items.get(this.selectedId);
        if (current !== undefined) void this.loadHistory(current);
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
      if (op.handoffId === "") {
        this.setStatus(
          "競合しました（キーの再利用）。内容を確認して入力し直してください",
        );
        return;
      }
      const current = this.items.get(op.handoffId);
      if (current === undefined) {
        this.setStatus("引継ぎが見つかりません（別セッションの可能性）");
        this.selectedId = null;
        if (this.detail !== null) this.detail.hidden = true;
        this.renderAll();
        return;
      }
      if (current.status === "verified") {
        this.setStatus("検証済みです（条件の変更は新規引継ぎで継承）");
      } else if (current.needsReevaluation) {
        this.setStatus(
          "要再評価のため実行できません。再確認して入力し直してください",
        );
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
      this.pendingOp = null;
      this.opInFlight = false;
      if (this.retryButton !== null) this.retryButton.hidden = true;
      this.setStatus("引継ぎが見つかりません（別セッションの可能性）");
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
