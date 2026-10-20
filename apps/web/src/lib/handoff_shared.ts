// Handoff (AV03 delegation record) shared pure state (no DOM): moved from
// the legacy `apps/server/src/ui/handoff_panel.ts` so the native Svelte
// HandoffPanel and the legacy DOM panel share ONE guard/label source of
// truth (no re-implementation divergence). Pure guards + labels only — no
// HTTP, no document access.

export interface HandoffView {
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

export function isHandoffView(value: unknown): value is HandoffView {
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

export function readItems(body: unknown): HandoffView[] {
  if (!isRecord(body)) return [];
  const items = body.items;
  if (!Array.isArray(items)) return [];
  return items.filter(isHandoffView);
}

export function readActiveCount(body: unknown): number | null {
  if (!isRecord(body)) return null;
  return typeof body.activeCount === "number" ? body.activeCount : null;
}

/** Opaque older-page cursor (null when the server has no older page). */
export function readCursor(body: unknown): string | null {
  if (!isRecord(body)) return null;
  return typeof body.nextCursor === "string" ? body.nextCursor : null;
}

export function readHasMore(body: unknown): boolean {
  if (!isRecord(body)) return false;
  return body.hasMore === true;
}

/** Strict UUID v4 shape (client-side pre-freeze validation only). */
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const STATUS_TEXT: Record<string, string> = {
  prepared: "準備中",
  dispatched: "送付済",
  reported: "報告あり",
  verified: "検証済",
  failed: "失敗",
  cancelled: "取消",
};

export const OP_SCOPE_TEXT: Record<string, string> = {
  investigate: "調査",
  implement: "実装",
};

export const BOUNDARY_TEXT: Record<string, string> = {
  external_publication: "外部公開",
  shared_branch: "共有ブランチ",
  payment: "支払い",
  deletion: "削除",
  secret: "秘密情報",
  access_change: "権限変更",
};

export const CAUSE_TEXT: Record<string, string> = {
  transient_infra: "一時的障害",
  worker_error: "作業者エラー",
  criteria_unmet: "条件未達",
  environment: "環境要因",
};

export function textOf(map: Record<string, string>, key: string): string {
  return map[key] ?? key;
}
