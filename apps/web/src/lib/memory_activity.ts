// Read-only "学習の動き" view model.
//
// The server stores only fixed numeric maintenance counts (see migration
// 0038). This module strictly validates those responses, formats Japanese
// labels for the cards/timeline, and derives cheap 7-day bars. No DOM and
// no Svelte state: the component only renders these pure decisions.

export type MemoryMaintenanceOp =
  | "topic.backfill"
  | "maintain.associate"
  | "maintain.consolidate"
  | "maintain.activation"
  | "maintain.distill";

export const MEMORY_MAINTENANCE_OPS: readonly MemoryMaintenanceOp[] = [
  "maintain.consolidate",
  "maintain.associate",
  "maintain.activation",
  "topic.backfill",
  "maintain.distill",
];

export interface ActivityRun {
  readonly id: string;
  readonly op: MemoryMaintenanceOp;
  readonly scope: string;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly ok: boolean;
  readonly errorCode: string | null;
  readonly counts: Readonly<Record<string, number>>;
}

export interface ActivityOpWindow {
  readonly runs: number;
  readonly failed: number;
  readonly counts: Readonly<Record<string, number>>;
}

export interface ActivitySummary {
  readonly generatedAt: number;
  readonly windows: {
    readonly last24h: {
      readonly runs: number;
      readonly failed: number;
      readonly ops: Readonly<Record<MemoryMaintenanceOp, ActivityOpWindow>>;
    };
    readonly last7d: {
      readonly runs: number;
      readonly failed: number;
      readonly ops: Readonly<Record<MemoryMaintenanceOp, ActivityOpWindow>>;
    };
  };
  readonly latestByOp: Readonly<
    Record<
      MemoryMaintenanceOp,
      {
        readonly finishedAt: number;
        readonly ok: boolean;
        readonly errorCode: string | null;
        readonly counts: Readonly<Record<string, number>>;
      } | null
    >
  >;
}

export type LearningProposalStatus = "pending" | "approved" | "rejected";
export type LearningProposalKind =
  | "observation"
  | "user_confirmed_feedback"
  | "model_inference";

export interface LearningProposal {
  readonly id: string;
  readonly kind: LearningProposalKind;
  readonly lesson: string;
  readonly evidence: string;
  readonly applicability: string;
  readonly status: LearningProposalStatus;
  readonly createdAt: number;
  readonly decidedAt: number | null;
}

const OP_LABELS: Record<MemoryMaintenanceOp, string> = {
  "maintain.consolidate": "統合",
  "maintain.associate": "関連付け",
  "maintain.activation": "重要度スコア",
  "topic.backfill": "トピック付与",
  "maintain.distill": "蒸留（学習）",
};

export function opLabel(op: string): string {
  return OP_LABELS[op as MemoryMaintenanceOp] ?? op;
}

const ERROR_LABELS: Record<string, string> = {
  timeout: "タイムアウト",
  bad_request: "要求が不正",
  limit_exceeded: "上限超過",
  store_unavailable: "保存先が利用不可",
  forbidden_scope: "スコープ拒否",
  not_found: "対象なし",
  conflict: "競合",
  cli_failed: "CLI 失敗",
  cli_unavailable: "CLI 利用不可",
  preempted: "中断（優先処理）",
  busy: "背景処理が混雑",
  invalid_response: "応答形式が不正",
};

export function errorLabel(code: string | null | undefined): string {
  if (code === null || code === undefined || code.length === 0) {
    return "不明";
  }
  return ERROR_LABELS[code] ?? code;
}

/** Timeline result cell: success / degraded / fixed failure reason. */
export function resultLabel(run: ActivityRun): string {
  if (!run.ok) {
    return `失敗（${errorLabel(run.errorCode)}）`;
  }
  if ((run.counts.degraded ?? 0) > 0) {
    return "縮退";
  }
  return "成功";
}

const COUNT_LABELS: Record<string, string> = {
  applied: "適用",
  written: "書込",
  unchanged: "変更なし",
  no_grounded: "根拠なし",
  deferred: "保留",
  scored: "採点",
  score_failed: "採点失敗",
  retired: "退役",
  reactivated: "再活性化",
  would_retire: "退役候補",
  would_reactivate: "再活性候補",
  remaining: "残り",
  pending: "対象",
  processed: "処理",
  assigned: "付与",
  skipped: "スキップ",
  failed: "失敗",
  degraded: "縮退",
};

/** Compact numeric summary for the timeline (never free text). */
export function formatRunCounts(run: ActivityRun): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(run.counts)) {
    if (value === 0 && key !== "applied") {
      continue;
    }
    parts.push(`${COUNT_LABELS[key] ?? key} ${value}`);
  }
  return parts.length === 0 ? "—" : parts.join(" / ");
}

export interface SummaryCard {
  readonly key: string;
  readonly label: string;
  readonly value: number;
  readonly detail: string;
  readonly op: MemoryMaintenanceOp;
}

function countOf(window: ActivityOpWindow | undefined, key: string): number {
  if (window === undefined) return 0;
  return window.counts[key] ?? 0;
}

/**
 * The six requested 24h cards. Consolidation uses its applied writes;
 * association has no numeric "linked" field, so its pass count is shown.
 */
export function summaryCards(summary: ActivitySummary): SummaryCard[] {
  const ops = summary.windows.last24h.ops;
  return [
    {
      key: "consolidate",
      label: "統合",
      value: countOf(ops["maintain.consolidate"], "applied"),
      detail: `${ops["maintain.consolidate"]?.runs ?? 0} 回実行`,
      op: "maintain.consolidate",
    },
    {
      key: "associate",
      label: "関連付け",
      value: ops["maintain.associate"]?.runs ?? 0,
      detail: `${ops["maintain.associate"]?.runs ?? 0} 回実行`,
      op: "maintain.associate",
    },
    {
      key: "activation",
      label: "重要度スコア",
      value: countOf(ops["maintain.activation"], "scored"),
      detail: `${ops["maintain.activation"]?.runs ?? 0} 回実行`,
      op: "maintain.activation",
    },
    {
      key: "retired",
      label: "退役",
      value: countOf(ops["maintain.activation"], "retired"),
      detail: "重要度スコアから",
      op: "maintain.activation",
    },
    {
      key: "reactivated",
      label: "再活性化",
      value: countOf(ops["maintain.activation"], "reactivated"),
      detail: "重要度スコアから",
      op: "maintain.activation",
    },
    {
      key: "topics",
      label: "トピック付与",
      value: countOf(ops["topic.backfill"], "assigned"),
      detail: `${ops["topic.backfill"]?.runs ?? 0} 回実行`,
      op: "topic.backfill",
    },
  ];
}

export function formatActivityTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const date = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export interface DailyBucket {
  readonly label: string;
  readonly count: number;
}

/** Seven local-day buckets ending today; optional op filter. */
export function dailyActivity(
  runs: readonly ActivityRun[],
  now: number,
  op?: MemoryMaintenanceOp,
): DailyBucket[] {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const start = today.getTime() - 6 * 24 * 60 * 60 * 1000;
  const buckets = Array.from({ length: 7 }, (_, index) => ({
    label: "",
    count: 0,
    start: start + index * 24 * 60 * 60 * 1000,
  }));
  for (let i = 0; i < buckets.length; i += 1) {
    const bucket = buckets[i];
    if (bucket === undefined) continue;
    bucket.label = formatActivityTime(bucket.start).slice(0, 5);
  }
  for (const run of runs) {
    if (op !== undefined && run.op !== op) continue;
    for (const bucket of buckets) {
      if (
        run.finishedAt >= bucket.start &&
        run.finishedAt < bucket.start + 24 * 60 * 60 * 1000
      ) {
        bucket.count += 1;
        break;
      }
    }
  }
  return buckets.map(({ label, count }) => ({ label, count }));
}

export function barPercent(
  count: number,
  buckets: readonly DailyBucket[],
): number {
  const max = Math.max(1, ...buckets.map((bucket) => bucket.count));
  return Math.round((count / max) * 100);
}

export function latestLabel(
  summary: ActivitySummary,
  op: MemoryMaintenanceOp,
): string {
  const latest = summary.latestByOp[op];
  return latest === null ? "未実行" : formatActivityTime(latest.finishedAt);
}

export const STATUS_LABELS: Record<LearningProposalStatus, string> = {
  pending: "保留",
  approved: "承認",
  rejected: "却下",
};

export function statusLabel(status: LearningProposalStatus): string {
  return STATUS_LABELS[status];
}

export const PROPOSAL_KIND_LABELS: Record<LearningProposalKind, string> = {
  observation: "観察",
  user_confirmed_feedback: "ユーザー確認済み",
  model_inference: "モデル推論",
};

export function proposalKindLabel(kind: LearningProposalKind): string {
  return PROPOSAL_KIND_LABELS[kind];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOp(value: unknown): value is MemoryMaintenanceOp {
  return MEMORY_MAINTENANCE_OPS.includes(value as MemoryMaintenanceOp);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseCounts(value: unknown): Record<string, number> | null {
  if (!isRecord(value)) return null;
  const out: Record<string, number> = {};
  for (const [key, count] of Object.entries(value)) {
    if (!isNonNegativeInteger(count)) return null;
    out[key] = count;
  }
  return out;
}

function parseRun(value: unknown): ActivityRun | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== "string" ||
    !isOp(value.op) ||
    typeof value.scope !== "string" ||
    !isNonNegativeInteger(value.startedAt) ||
    !isNonNegativeInteger(value.finishedAt) ||
    typeof value.ok !== "boolean" ||
    (value.errorCode !== null && typeof value.errorCode !== "string")
  ) {
    return null;
  }
  const counts = parseCounts(value.counts);
  if (counts === null) return null;
  return {
    id: value.id,
    op: value.op,
    scope: value.scope,
    startedAt: value.startedAt,
    finishedAt: value.finishedAt,
    ok: value.ok,
    errorCode: value.errorCode,
    counts,
  };
}

export function parseActivityList(body: unknown): {
  items: ActivityRun[];
  nextCursor: string | null;
  hasMore: boolean;
} | null {
  if (!isRecord(body) || !Array.isArray(body.items)) return null;
  const items: ActivityRun[] = [];
  for (const raw of body.items) {
    const run = parseRun(raw);
    if (run === null) return null;
    items.push(run);
  }
  if (
    (body.nextCursor !== null && typeof body.nextCursor !== "string") ||
    typeof body.hasMore !== "boolean"
  ) {
    return null;
  }
  return {
    items,
    nextCursor: body.nextCursor as string | null,
    hasMore: body.hasMore,
  };
}

function parseWindow(value: unknown): {
  runs: number;
  failed: number;
  ops: Record<MemoryMaintenanceOp, ActivityOpWindow>;
} | null {
  if (!isRecord(value) || !isRecord(value.ops)) return null;
  if (
    !isNonNegativeInteger(value.runs) ||
    !isNonNegativeInteger(value.failed)
  ) {
    return null;
  }
  const ops = {} as Record<MemoryMaintenanceOp, ActivityOpWindow>;
  for (const op of MEMORY_MAINTENANCE_OPS) {
    const raw = value.ops[op];
    if (!isRecord(raw)) return null;
    const counts = parseCounts(raw.counts);
    if (
      counts === null ||
      !isNonNegativeInteger(raw.runs) ||
      !isNonNegativeInteger(raw.failed)
    ) {
      return null;
    }
    ops[op] = { runs: raw.runs, failed: raw.failed, counts };
  }
  return { runs: value.runs, failed: value.failed, ops };
}

export function parseActivitySummary(body: unknown): ActivitySummary | null {
  if (!isRecord(body) || !isRecord(body.windows)) return null;
  if (!isNonNegativeInteger(body.generatedAt)) return null;
  const last24h = parseWindow(body.windows.last24h);
  const last7d = parseWindow(body.windows.last7d);
  if (last24h === null || last7d === null) return null;
  if (!isRecord(body.latestByOp)) return null;
  const latestByOp: Record<
    MemoryMaintenanceOp,
    ActivitySummary["latestByOp"][MemoryMaintenanceOp]
  > = {
    "maintain.consolidate": null,
    "maintain.associate": null,
    "maintain.activation": null,
    "topic.backfill": null,
    "maintain.distill": null,
  };
  for (const op of MEMORY_MAINTENANCE_OPS) {
    const raw = body.latestByOp[op];
    if (raw === null) {
      latestByOp[op] = null;
      continue;
    }
    if (
      !isRecord(raw) ||
      !isNonNegativeInteger(raw.finishedAt) ||
      typeof raw.ok !== "boolean" ||
      (raw.errorCode !== null && typeof raw.errorCode !== "string")
    ) {
      return null;
    }
    const counts = parseCounts(raw.counts);
    if (counts === null) return null;
    latestByOp[op] = {
      finishedAt: raw.finishedAt,
      ok: raw.ok,
      errorCode: raw.errorCode,
      counts,
    };
  }
  return {
    generatedAt: body.generatedAt,
    windows: { last24h, last7d },
    latestByOp,
  } as ActivitySummary;
}

const PROPOSAL_KINDS: readonly LearningProposalKind[] = [
  "observation",
  "user_confirmed_feedback",
  "model_inference",
];
const PROPOSAL_STATUSES: readonly LearningProposalStatus[] = [
  "pending",
  "approved",
  "rejected",
];

export function parseLearningProposals(
  body: unknown,
): LearningProposal[] | null {
  if (!isRecord(body) || !Array.isArray(body.items)) return null;
  const items: LearningProposal[] = [];
  for (const raw of body.items) {
    if (
      !isRecord(raw) ||
      typeof raw.id !== "string" ||
      !PROPOSAL_KINDS.includes(raw.kind as LearningProposalKind) ||
      typeof raw.lesson !== "string" ||
      typeof raw.evidence !== "string" ||
      typeof raw.applicability !== "string" ||
      !PROPOSAL_STATUSES.includes(raw.status as LearningProposalStatus) ||
      !isNonNegativeInteger(raw.createdAt) ||
      (raw.decidedAt !== null && !isNonNegativeInteger(raw.decidedAt))
    ) {
      return null;
    }
    items.push({
      id: raw.id,
      kind: raw.kind as LearningProposalKind,
      lesson: raw.lesson,
      evidence: raw.evidence,
      applicability: raw.applicability,
      status: raw.status as LearningProposalStatus,
      createdAt: raw.createdAt,
      decidedAt: raw.decidedAt,
    });
  }
  return items;
}
