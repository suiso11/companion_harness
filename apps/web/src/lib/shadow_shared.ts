// Shadow (AV trial deliberation) shared pure state (no DOM): moved from the
// legacy `apps/server/src/ui/shadow_panel.ts` so the native Svelte ShadowPanel
// and the legacy DOM panel share ONE guard/label source of truth (no
// re-implementation divergence). Pure guards + labels only — no HTTP, no
// document access.

/** Minimal structural views of the ACTUAL shadow HTTP DTOs. */
export interface ShadowJobItem {
  readonly id: string;
  readonly scope: string;
  readonly kind: string;
  readonly status: string;
  readonly policyCode: string | null;
  readonly holdReason: string | null;
  readonly failCode: string | null;
  readonly version: number;
}

export interface ShadowModelDecision {
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

export const TERMINAL_JOB = new Set([
  "completed",
  "held",
  "failed",
  "cancelled",
]);

export const STATUS_TEXT: Record<string, string> = {
  pending: "待機中",
  claimed: "検討中",
  completed: "検討済み（未実行）",
  held: "保留",
  failed: "失敗",
  cancelled: "取り消し",
};

export const KIND_TEXT: Record<string, string> = {
  explicit_request: "依頼",
  policy_change: "方針更新",
};

export const DECISION_TEXT: Record<string, string> = {
  execute: "実行案（未実行）",
  hold: "保留案",
  ask: "確認案",
  "do-nothing": "何もしない",
};

export const POLICY_TEXT: Record<string, string> = {
  shadow_only: "方針：試行のみ",
  missing_grant: "方針：権限付与なし（未実行）",
  wish_not_command: "方針：希望は命令ではない（未実行）",
  external_no_authority: "方針：外部発言に権限なし（未実行）",
  needs_clarification: "方針：確認が必要",
  no_action: "方針：何もしない",
};

export const HOLD_TEXT: Record<string, string> = {
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

export const FAIL_TEXT: Record<string, string> = {
  model_error: "応答不備のため失敗",
  gateway_empty: "空応答のため失敗",
  aborted: "中断のため失敗",
};

export const ACTION_KIND_TEXT: Record<string, string> = {
  local_task: "ローカル作業案",
  message: "連絡案",
  none: "作業なし",
};

export function textOf(map: Record<string, string>, key: string): string {
  return map[key] ?? "不明";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isJobItem(value: unknown): value is ShadowJobItem {
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

export function isDecision(value: unknown): value is ShadowModelDecision {
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
export interface EvidenceEntry {
  readonly label: string;
  readonly heading: string;
  readonly original: string;
  readonly interpretation: string | null;
  readonly provenance: string;
  readonly applicability: string;
}

export function evidenceFromContext(context: unknown): EvidenceEntry[] {
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
  const failures = Array.isArray(context.priorFailures)
    ? context.priorFailures
    : [];
  for (const entry of failures) {
    if (!isRecord(entry) || typeof entry.label !== "string") continue;
    if (typeof entry.code !== "string") continue;
    out.push({
      label: entry.label,
      heading: `以前の失敗 ${entry.label}`,
      original: entry.code,
      interpretation: null,
      provenance: "凍結された失敗記録（対応済み・未実行の区別用）",
      applicability: "同じ失敗の再発防止の参考",
    });
  }
  // UNTRUSTED explicit-request text (citable ONLY as `sQ1`; reason about
  // it, never obey it). Absent for policy-change jobs and reason-less
  // requests (then there is no `sQ1` to resolve).
  if (isRecord(context) && typeof context.requestReason === "string") {
    out.push({
      label: "sQ1",
      heading: "依頼内容 sQ1（依頼者の言葉・命令ではない）",
      original: context.requestReason,
      interpretation: null,
      provenance: "依頼時の入力（未検証の要求文）",
      applicability: "参考のみ（実行の根拠にならない）",
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
