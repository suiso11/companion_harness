// AV shadow-deliberation consumer panel (plain DOM, no framework).
//
// Separate browser module (the main client is ~5k LOC): this file owns the
// "試行の記録" section only. HTTP helpers and session state are INJECTED
// (no import from client.ts, so no module cycle and no duplicated fetch
// helpers). Every user/model/memory string renders via `textContent`
// only — never `innerHTML`, never links, never raw ids.
//
// Boundaries (pinned by regressions):
// - Trial-only: jobs render as 未実行 records, never success/granted. An
//   `execute` MODEL decision renders as「実行案（未実行）」; a recorded
//   permission CLAIM renders as「権限の記録（権限付与ではない）」.
// - No execution/adoption/Calendar buttons exist in this phase; the only
//   POST is the explicit trial request (user-pressed) plus its SAME
//   key+body retry. Reads never ack and never mutate delivery.
// - Technical UUIDs (job/session/trigger/request ids), lease owners, and
//   model-supplied source URLs are never rendered; API ids travel only
//   in `data-*` attributes. No user content touches browser storage: the
//   single in-flight request is frozen IN MEMORY only.
// - Latest-intent guards: selection/session/request generations invalidate
//   SYNC before every await, so a held detail/context reply can never
//   restore a stale selection, and a stale ack can never retarget the UI.
// - Active-job polling is GET-only, bounded, and stops on session change,
//   new selection, or terminal status. No autofocus changes, no push
//   framework; the normal composer is untouched.

/// <reference lib="dom" />

/** Injected HTTP surface (wired to the existing client helpers). */
export interface ShadowHttp {
  get(path: string): Promise<{ status: number; body: unknown }>;
  post(
    path: string,
    payload: unknown,
    key: string,
  ): Promise<{ status: number; body: unknown }>;
}

export interface ShadowPanelDeps {
  getSessionId: () => string | null;
  http: ShadowHttp;
}

/** Minimal structural views of the ACTUAL shadow HTTP DTOs. */
interface ShadowJobItem {
  readonly id: string;
  readonly scope: string;
  readonly kind: string;
  readonly status: string;
  readonly policyCode: string | null;
  readonly holdReason: string | null;
  readonly failCode: string | null;
  readonly version: number;
}

interface ShadowModelDecision {
  readonly decision: string;
  readonly evidenceIds: readonly string[];
  readonly reason: string;
  readonly proposedAction: {
    readonly kind: string;
    readonly summary: string;
    readonly taskDraft?: {
      readonly title: string;
      readonly body?: string;
      readonly deadline?: string;
    };
  } | null;
  readonly completion: string;
  readonly stopConditions: readonly string[];
  readonly uncertainty: string;
  readonly counterargument: string;
}

const TERMINAL_JOB = new Set(["completed", "held", "failed", "cancelled"]);

const STATUS_TEXT: Record<string, string> = {
  pending: "待機中",
  claimed: "検討中",
  completed: "検討済み（未実行）",
  held: "保留",
  failed: "失敗",
  cancelled: "取り消し",
};

const KIND_TEXT: Record<string, string> = {
  explicit_request: "依頼",
  policy_change: "方針更新",
};

const DECISION_TEXT: Record<string, string> = {
  execute: "実行案（未実行）",
  hold: "保留案",
  ask: "確認案",
  "do-nothing": "何もしない",
};

const POLICY_TEXT: Record<string, string> = {
  shadow_only: "方針：試行のみ",
  missing_grant: "方針：権限付与なし（未実行）",
  wish_not_command: "方針：希望は命令ではない（未実行）",
  external_no_authority: "方針：外部発言に権限なし（未実行）",
  needs_clarification: "方針：確認が必要",
  no_action: "方針：何もしない",
};

const HOLD_TEXT: Record<string, string> = {
  control_paused: "一時停止中のため保留",
  control_version_drift: "設定変更のため保留",
  scope_epoch_drift: "方針更新のため保留",
  target_changed: "対象変更のため保留",
  target_inapplicable: "対象が適用外のため保留",
  lease_expired: "期限切れのため保留",
  lease_mismatch: "競合のため保留",
  aborted_foreground: "前面作業優先のため保留",
  context_too_large: "分量超過のため保留",
  requested_while_paused: "一時停止中の依頼のため保留",
  restart_interrupted: "再起動中断のため保留",
};

const FAIL_TEXT: Record<string, string> = {
  model_error: "応答不備のため失敗",
  gateway_empty: "空応答のため失敗",
  aborted: "中断のため失敗",
};

const ACTION_KIND_TEXT: Record<string, string> = {
  local_task: "ローカル作業案",
  message: "連絡案",
  none: "作業なし",
};

function textOf(map: Record<string, string>, key: string): string {
  return map[key] ?? "不明";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isJobItem(value: unknown): value is ShadowJobItem {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.scope === "string" &&
    typeof value.kind === "string" &&
    typeof value.status === "string" &&
    (value.policyCode === null || typeof value.policyCode === "string") &&
    (value.holdReason === null || typeof value.holdReason === "string") &&
    (value.failCode === null || typeof value.failCode === "string") &&
    typeof value.version === "number"
  );
}

function isDecision(value: unknown): value is ShadowModelDecision {
  if (!isRecord(value)) return false;
  if (
    typeof value.decision !== "string" ||
    !Array.isArray(value.evidenceIds) ||
    typeof value.reason !== "string" ||
    typeof value.completion !== "string" ||
    !Array.isArray(value.stopConditions) ||
    typeof value.uncertainty !== "string" ||
    typeof value.counterargument !== "string"
  ) {
    return false;
  }
  if (value.proposedAction !== null) {
    if (!isRecord(value.proposedAction)) return false;
    if (
      typeof value.proposedAction.kind !== "string" ||
      typeof value.proposedAction.summary !== "string"
    ) {
      return false;
    }
    const draft = value.proposedAction.taskDraft;
    if (draft !== undefined) {
      if (!isRecord(draft) || typeof draft.title !== "string") return false;
      if (draft.body !== undefined && typeof draft.body !== "string") {
        return false;
      }
      if (draft.deadline !== undefined && typeof draft.deadline !== "string") {
        return false;
      }
    }
  }
  return true;
}

/** Frozen evidence entry: original text vs interpretation kept apart. */
interface EvidenceEntry {
  readonly label: string;
  readonly heading: string;
  readonly original: string;
  readonly interpretation: string | null;
  readonly provenance: string;
  readonly applicability: string;
}

function evidenceFromContext(context: unknown): EvidenceEntry[] {
  if (!isRecord(context)) return [];
  const out: EvidenceEntry[] = [];
  const purposes = Array.isArray(context.purposes) ? context.purposes : [];
  for (const entry of purposes) {
    if (!isRecord(entry) || typeof entry.label !== "string") continue;
    if (typeof entry.statement !== "string") continue;
    const interp =
      typeof entry.interpretation === "string" ? entry.interpretation : null;
    const source = typeof entry.source === "string" ? entry.source : "不明";
    const explicitness =
      entry.explicitness === "explicit" ? "本人の言葉" : "記録の解釈";
    const window: string[] = [];
    if (typeof entry.validFrom === "string")
      window.push(`開始 ${entry.validFrom}`);
    if (typeof entry.validUntil === "string")
      window.push(`終了 ${entry.validUntil}`);
    const applicable =
      entry.applicableAtClaim === true
        ? "取得時に適用中"
        : entry.applicableAtClaim === false
          ? "取得時に適用外"
          : "適用不明";
    out.push({
      label: entry.label,
      heading: `目的の記録 ${entry.label}`,
      original: entry.statement,
      interpretation: interp,
      provenance: `${explicitness}・出所 ${source}`,
      applicability:
        window.length > 0
          ? `${applicable}（${window.join("・")}）`
          : applicable,
    });
  }
  const tasks = Array.isArray(context.tasks) ? context.tasks : [];
  for (const entry of tasks) {
    if (!isRecord(entry) || typeof entry.label !== "string") continue;
    if (typeof entry.title !== "string") continue;
    const speaker = typeof entry.speaker === "string" ? entry.speaker : "不明";
    const deadline =
      typeof entry.deadline === "string" ? `・期限 ${entry.deadline}` : "";
    out.push({
      label: entry.label,
      heading: `作業の記録 ${entry.label}`,
      original: entry.title,
      interpretation: null,
      provenance: `提起 ${speaker}${deadline}`,
      applicability:
        typeof entry.status === "string" ? `状態 ${entry.status}` : "状態不明",
    });
  }
  const claims = Array.isArray(context.permissionClaims)
    ? context.permissionClaims
    : [];
  for (const entry of claims) {
    if (!isRecord(entry) || typeof entry.label !== "string") continue;
    if (typeof entry.statement !== "string") continue;
    out.push({
      label: entry.label,
      heading: `権限の記録 ${entry.label}（権限付与ではない）`,
      original: entry.statement,
      interpretation: null,
      provenance: "記録された主張であり権限ではない",
      applicability: "実行の根拠にならない",
    });
  }
  const memories = Array.isArray(context.memories) ? context.memories : [];
  for (const entry of memories) {
    if (!isRecord(entry) || typeof entry.label !== "string") continue;
    if (typeof entry.snippet !== "string") continue;
    out.push({
      label: entry.label,
      heading: `記憶の抜粋 ${entry.label}`,
      original: entry.snippet,
      interpretation: null,
      provenance: "取得時の抜粋（原文の断片）",
      applicability: "参考のみ",
    });
  }
  return out;
}

export class ShadowPanel {
  private static readonly POLL_INTERVAL_MS = 2000;
  private static readonly POLL_MAX_TICKS = 10;

  private readonly deps: ShadowPanelDeps;
  private form: HTMLFormElement | null = null;
  private scopeInput: HTMLInputElement | null = null;
  private reasonInput: HTMLTextAreaElement | null = null;
  private status: HTMLElement | null = null;
  private refreshButton: HTMLButtonElement | null = null;
  private list: HTMLElement | null = null;
  private detail: HTMLElement | null = null;
  private detailBody: HTMLElement | null = null;
  private retryButton: HTMLButtonElement | null = null;

  /** Monotonic generations: session/selection/request changes invalidate. */
  private listSeq = 0;
  private detailSeq = 0;
  private requestSeq = 0;
  private selectedJob: string | null = null;
  private selectedVersion = 0;
  /**
   * One frozen in-memory explicit request (never browser storage):
   * { ownerSession, endpoint, key, body }. Retried with the SAME key +
   * byte-identical body on uncertain network/5xx; cleared ONLY on a
   * definitive reply (2xx/4xx). An edited draft never reuses the old key.
   */
  private pendingRequest: {
    ownerSession: string;
    endpoint: string;
    key: string;
    body: { scope: string; reason?: string };
    draft: string;
  } | null = null;

  constructor(deps: ShadowPanelDeps) {
    this.deps = deps;
  }

  /** Bind the ACTUAL SSR nodes (no detached fallbacks; missing nodes throw). */
  bind(): void {
    const required = <T extends HTMLElement>(id: string): T => {
      const node = document.getElementById(id);
      if (node === null) {
        throw new Error(`shadow panel node missing: ${id}`);
      }
      return node as T;
    };
    required<HTMLElement>("shadow");
    this.form = required<HTMLFormElement>("shadow-request-form");
    this.scopeInput = required<HTMLInputElement>("shadow-scope");
    this.reasonInput = required<HTMLTextAreaElement>("shadow-reason");
    this.status = required<HTMLElement>("shadow-status");
    this.refreshButton = required<HTMLButtonElement>("shadow-refresh");
    this.list = required<HTMLElement>("shadow-job-list");
    this.detail = required<HTMLElement>("shadow-detail");
    this.detailBody = required<HTMLElement>("shadow-detail-body");
    this.retryButton = required<HTMLButtonElement>("shadow-retry");
    this.form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.submitRequest();
    });
    this.refreshButton.addEventListener("click", () => {
      void this.refreshList();
    });
    this.retryButton.addEventListener("click", () => {
      void this.retryRequest();
    });
  }

  private setStatus(text: string): void {
    if (this.status !== null) {
      this.status.textContent = text;
    }
  }

  /** Session lifecycle: a new session invalidates selection + requests. */
  notifySessionChanged(): void {
    this.listSeq += 1;
    this.detailSeq += 1;
    this.requestSeq += 1;
    this.selectedJob = null;
    this.pendingRequest = null;
    if (this.detail !== null) {
      this.detail.hidden = true;
    }
    if (this.retryButton !== null) {
      this.retryButton.hidden = true;
    }
    void this.refreshList();
  }

  /** Autonomy lifecycle: local purpose/task/control changes may enqueue work. */
  notifyAutonomyChanged(): void {
    void this.refreshList();
  }

  async refreshList(): Promise<void> {
    const sessionId = this.deps.getSessionId();
    if (sessionId === null || this.list === null) {
      return;
    }
    this.listSeq += 1;
    const seq = this.listSeq;
    let result: { status: number; body: unknown };
    try {
      result = await this.deps.http.get(
        `/api/sessions/${encodeURIComponent(sessionId)}/shadow-jobs?limit=50`,
      );
    } catch {
      if (seq !== this.listSeq || sessionId !== this.deps.getSessionId()) {
        return;
      }
      this.setStatus("一覧の取得に失敗しました。");
      return;
    }
    if (seq !== this.listSeq || sessionId !== this.deps.getSessionId()) {
      return;
    }
    if (result.status !== 200 || !isRecord(result.body)) {
      this.setStatus("一覧の取得に失敗しました。");
      return;
    }
    const items = Array.isArray(result.body.items) ? result.body.items : [];
    while (this.list.firstChild !== null) {
      this.list.removeChild(this.list.firstChild);
    }
    let rendered = 0;
    for (const item of items) {
      if (!isJobItem(item)) continue;
      const row = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      // API ids travel only in hidden attributes; visible text is
      // scope + status + kind (never UUIDs, never lease/session ids).
      button.dataset.jobId = item.id;
      button.textContent = `${item.scope}・${textOf(KIND_TEXT, item.kind)}・${textOf(STATUS_TEXT, item.status)}`;
      button.addEventListener("click", () => {
        void this.selectJob(item.id, item.version);
      });
      row.appendChild(button);
      this.list.appendChild(row);
      rendered += 1;
    }
    if (rendered === 0) {
      this.setStatus("試行の記録はまだありません。");
    } else {
      this.setStatus("");
    }
  }

  /** Select a job: SYNC-invalidate, then await detail + deliberation. */
  private async selectJob(jobId: string, version: number): Promise<void> {
    const sessionId = this.deps.getSessionId();
    if (sessionId === null) return;
    // Invalidate synchronously BEFORE any await: a held earlier reply can
    // never restore this selection, and an old view draft can never apply
    // after a version advance.
    this.detailSeq += 1;
    const seq = this.detailSeq;
    this.selectedJob = jobId;
    this.selectedVersion = version;
    if (this.detail !== null) {
      this.detail.hidden = false;
    }
    this.renderDetailLoading();
    const base = `/api/sessions/${encodeURIComponent(sessionId)}/shadow-jobs/${encodeURIComponent(jobId)}`;
    let detail: { status: number; body: unknown };
    try {
      detail = await this.deps.http.get(base);
    } catch {
      if (seq !== this.detailSeq || this.selectedJob !== jobId) return;
      this.renderDetailError("内容の取得に失敗しました。");
      return;
    }
    if (seq !== this.detailSeq || this.selectedJob !== jobId) return;
    if (sessionId !== this.deps.getSessionId()) return;
    if (detail.status !== 200 || !isJobItem(detail.body)) {
      this.renderDetailError("内容の取得に失敗しました。");
      return;
    }
    // The record version may have advanced while fetching: never render
    // an old view draft over the fresh record.
    if (detail.body.version !== this.selectedVersion) {
      this.selectedVersion = detail.body.version;
    }
    let deliberation: { status: number; body: unknown } | null = null;
    try {
      deliberation = await this.deps.http.get(`${base}/context`);
    } catch {
      deliberation = null;
    }
    if (seq !== this.detailSeq || this.selectedJob !== jobId) return;
    if (sessionId !== this.deps.getSessionId()) return;
    this.renderDetail(detail.body, deliberation);
    if (!TERMINAL_JOB.has(detail.body.status)) {
      void this.watchActive(sessionId, jobId, seq);
    }
  }

  /**
   * Bounded GET-only active watch (mirrors the existing execution-watch
   * guard shape): fixed ticks, generation + selection + session + terminal
   * exits. Never posts, never triggers model work, never loops forever.
   */
  private async watchActive(
    sessionId: string,
    jobId: string,
    seq: number,
  ): Promise<void> {
    for (let tick = 0; tick < ShadowPanel.POLL_MAX_TICKS; tick += 1) {
      await new Promise((resolve) => {
        window.setTimeout(resolve, ShadowPanel.POLL_INTERVAL_MS);
      });
      if (
        seq !== this.detailSeq ||
        this.selectedJob !== jobId ||
        sessionId !== this.deps.getSessionId()
      ) {
        return;
      }
      let current: { status: number; body: unknown };
      try {
        current = await this.deps.http.get(
          `/api/sessions/${encodeURIComponent(sessionId)}/shadow-jobs/${encodeURIComponent(jobId)}`,
        );
      } catch {
        return;
      }
      if (
        seq !== this.detailSeq ||
        this.selectedJob !== jobId ||
        sessionId !== this.deps.getSessionId()
      ) {
        return;
      }
      if (current.status !== 200 || !isJobItem(current.body)) {
        return;
      }
      if (current.body.version !== this.selectedVersion) {
        // New backend state: re-select once through the guarded path so
        // the fresh record (never an old draft) renders.
        this.selectedVersion = current.body.version;
        await this.selectJob(jobId, current.body.version);
        return;
      }
      if (TERMINAL_JOB.has(current.body.status)) {
        await this.selectJob(jobId, current.body.version);
        return;
      }
    }
  }

  private clearDetail(): void {
    if (this.detailBody === null) return;
    while (this.detailBody.firstChild !== null) {
      this.detailBody.removeChild(this.detailBody.firstChild);
    }
  }

  private appendLine(text: string): void {
    if (this.detailBody === null) return;
    const line = document.createElement("p");
    line.textContent = text;
    this.detailBody.appendChild(line);
  }

  private renderDetailLoading(): void {
    this.clearDetail();
    this.appendLine("読み込み中…");
  }

  private renderDetailError(text: string): void {
    this.clearDetail();
    this.appendLine(text);
  }

  private renderDetail(
    job: ShadowJobItem,
    deliberation: { status: number; body: unknown } | null,
  ): void {
    this.clearDetail();
    // Header: scope + kind + status only (no ids, no lease, no session).
    this.appendLine(
      `${job.scope}・${textOf(KIND_TEXT, job.kind)}・${textOf(STATUS_TEXT, job.status)}`,
    );
    if (job.status === "held" && job.holdReason !== null) {
      this.appendLine(textOf(HOLD_TEXT, job.holdReason));
      if (this.retryButton !== null) this.retryButton.hidden = true;
      if (deliberation !== null) {
        this.renderDeliberation(deliberation);
      }
      return;
    }
    if (job.status === "failed" && job.failCode !== null) {
      this.appendLine(textOf(FAIL_TEXT, job.failCode));
      if (this.retryButton !== null) this.retryButton.hidden = true;
      return;
    }
    if (job.status === "pending" || job.status === "claimed") {
      this.appendLine("検討の準備中または検討中です。実行はしません。");
      if (this.retryButton !== null) this.retryButton.hidden = true;
      return;
    }
    if (job.status === "cancelled") {
      this.appendLine("取り消されました。実行はしていません。");
      if (this.retryButton !== null) this.retryButton.hidden = true;
      return;
    }
    // Completed: CODE policy first (never model-chosen, never a grant)…
    if (job.policyCode !== null) {
      this.appendLine(textOf(POLICY_TEXT, job.policyCode));
    }
    if (deliberation !== null) {
      this.renderDeliberation(deliberation);
    } else {
      this.appendLine("検討内容の取得に失敗しました。");
    }
    if (this.retryButton !== null) this.retryButton.hidden = true;
  }

  private renderDeliberation(response: {
    status: number;
    body: unknown;
  }): void {
    if (response.status === 409 || response.status === 404) {
      // Never claimed (pending) or foreign: honest, no implicit resume.
      this.appendLine("凍結された検討内容はまだありません。");
      return;
    }
    if (response.status !== 200 || !isRecord(response.body)) {
      this.appendLine("検討内容の取得に失敗しました。");
      return;
    }
    const decision = (response.body as { modelDecision?: unknown })
      .modelDecision;
    const context = (response.body as { context?: unknown }).context;
    if (decision === null || decision === undefined) {
      this.appendLine("モデルの判断はまだ記録されていません。");
    } else if (!isDecision(decision)) {
      this.appendLine("検討内容の取得に失敗しました。");
      return;
    } else {
      // Frozen MODEL decision, shown SEPARATE from the CODE policy above.
      // `execute` renders as a proposal, never as success or a grant.
      this.appendLine(
        `モデルの判断：${textOf(DECISION_TEXT, decision.decision)}`,
      );
      this.appendLine(`理由：${decision.reason}`);
      const evidence = evidenceFromContext(context);
      const byLabel = new Map(evidence.map((entry) => [entry.label, entry]));
      for (const id of decision.evidenceIds) {
        const entry = byLabel.get(id);
        if (entry === undefined) {
          this.appendLine(`根拠 ${id}：記録なし`);
          continue;
        }
        this.appendLine(`${entry.heading}`);
        this.appendLine(`原文：${entry.original}`);
        if (entry.interpretation !== null) {
          this.appendLine(`解釈：${entry.interpretation}`);
        }
        this.appendLine(`出所：${entry.provenance}`);
        this.appendLine(`適用：${entry.applicability}`);
      }
      const action = decision.proposedAction;
      if (action !== null) {
        this.appendLine(
          `提案：${textOf(ACTION_KIND_TEXT, action.kind)}・${action.summary}（未実行）`,
        );
        if (action.taskDraft !== undefined) {
          this.appendLine(`作業案の題名：${action.taskDraft.title}（未実行）`);
          if (action.taskDraft.body !== undefined) {
            this.appendLine(`作業案の内容：${action.taskDraft.body}（未実行）`);
          }
          if (action.taskDraft.deadline !== undefined) {
            this.appendLine(
              `作業案の期限：${action.taskDraft.deadline}（引用された明示期限のみ）`,
            );
          }
        }
      } else {
        this.appendLine("提案はありません。");
      }
      this.appendLine(`完了の目安：${decision.completion}`);
      for (const condition of decision.stopConditions) {
        this.appendLine(`停止条件：${condition}`);
      }
      this.appendLine(`不確かさ：${decision.uncertainty}`);
      this.appendLine(`反対意見：${decision.counterargument}`);
    }
  }

  private currentDraft(): string {
    return `${this.scopeInput?.value ?? ""}\n${this.reasonInput?.value ?? ""}`;
  }

  /** Explicit user-pressed trial request (the only POST in this panel). */
  private async submitRequest(): Promise<void> {
    const sessionId = this.deps.getSessionId();
    if (
      sessionId === null ||
      this.scopeInput === null ||
      this.reasonInput === null
    ) {
      return;
    }
    const scope = this.scopeInput.value.trim();
    const reason = this.reasonInput.value.trim();
    if (scope.length === 0) {
      this.setStatus("分野を入力してください。");
      return;
    }
    // Invalidate synchronously: a new request supersedes any frozen one.
    this.requestSeq += 1;
    const seq = this.requestSeq;
    const key =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `shadow-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const body: { scope: string; reason?: string } =
      reason.length > 0 ? { scope, reason } : { scope };
    const endpoint = `/api/sessions/${encodeURIComponent(sessionId)}/shadow-jobs`;
    this.pendingRequest = {
      ownerSession: sessionId,
      endpoint,
      key,
      body,
      draft: this.currentDraft(),
    };
    if (this.retryButton !== null) this.retryButton.hidden = true;
    await this.commitRequest(seq);
  }

  private async commitRequest(seq: number): Promise<void> {
    const frozen = this.pendingRequest;
    const sessionId = this.deps.getSessionId();
    if (frozen === null || sessionId === null) return;
    if (frozen.ownerSession !== sessionId) return;
    let result: { status: number; body: unknown };
    try {
      result = await this.deps.http.post(
        frozen.endpoint,
        frozen.body,
        frozen.key,
      );
    } catch {
      // Uncertain network: keep the frozen SAME key+body and offer ONE
      // retry; never invent a new key here.
      if (seq !== this.requestSeq || this.pendingRequest !== frozen) return;
      if (frozen.ownerSession !== this.deps.getSessionId()) return;
      this.setStatus("通信が不確かです。同じ内容で再送できます。");
      if (this.retryButton !== null) this.retryButton.hidden = false;
      return;
    }
    if (seq !== this.requestSeq || this.pendingRequest !== frozen) return;
    // A stale ack for another session never retargets this UI.
    if (frozen.ownerSession !== this.deps.getSessionId()) return;
    if (result.status === 201 && isRecord(result.body)) {
      this.pendingRequest = null;
      if (this.retryButton !== null) this.retryButton.hidden = true;
      this.setStatus("試行を受け付けました。実行はしません。");
      await this.refreshList();
      return;
    }
    if (result.status >= 500 || result.status === 429) {
      // Uncertain server side: SAME key+body retry only.
      this.setStatus("応答が不確かです。同じ内容で再送できます。");
      if (this.retryButton !== null) this.retryButton.hidden = false;
      return;
    }
    // Definitive reply (4xx/2xx): clear the frozen request.
    this.pendingRequest = null;
    if (this.retryButton !== null) this.retryButton.hidden = true;
    if (result.status === 409) {
      this.setStatus("内容が変わったため受け付けられませんでした。");
    } else {
      this.setStatus("依頼を受け付けられませんでした。");
    }
  }

  /** ONE retry with the SAME frozen key+body; an edited draft needs a fresh request. */
  private async retryRequest(): Promise<void> {
    const frozen = this.pendingRequest;
    if (frozen === null) return;
    if (frozen.ownerSession !== this.deps.getSessionId()) return;
    // An edited scope/reason can never attach the old key or retarget:
    // the frozen body stays byte-identical, so a changed draft must
    // submit fresh instead.
    if (this.currentDraft() !== frozen.draft) {
      this.pendingRequest = null;
      if (this.retryButton !== null) this.retryButton.hidden = true;
      this.setStatus("内容が変更されました。新たに依頼してください。");
      return;
    }
    const seq = this.requestSeq;
    await this.commitRequest(seq);
  }
}
