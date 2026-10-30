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
    if (run.errorCode === "preempted") return "中断";
    return `失敗（${errorLabel(run.errorCode)}）`;
  }
  if ((run.counts.degraded ?? 0) > 0) {
    return "縮退";
  }
  return "成功";
}

export type StatusTone = "ok" | "degraded" | "failed" | "preempted";

export function statusTone(run: ActivityRun): StatusTone {
  if (!run.ok) return run.errorCode === "preempted" ? "preempted" : "failed";
  return (run.counts.degraded ?? 0) > 0 ? "degraded" : "ok";
}

const LEARN_SKIP_LABELS: Record<string, string> = {
  learn_skipped_disabled: "学習が無効",
  learn_skipped_interval: "前回から間隔不足",
  learn_skipped_no_new_examples: "新しい例が不足",
  learn_skipped_min_examples: "例が不足",
  learn_skipped_min_positives: "正例が不足",
  learn_skipped_deadline: "時間切れ",
  learn_skipped_error: "エラー",
};

function learnLine(c: Readonly<Record<string, number>>): string {
  if (!Object.keys(c).some((k) => k.startsWith("learn_"))) return "";
  const examples = c.learn_examples ?? 0;
  const positives = c.learn_positives ?? 0;
  if ((c.learn_attempted ?? 0) === 0) {
    const skipKey = Object.keys(c).find(
      (k) => k.startsWith("learn_skipped_") && (c[k] ?? 0) > 0,
    );
    const reason =
      skipKey === undefined
        ? ""
        : `、理由: ${LEARN_SKIP_LABELS[skipKey] ?? skipKey.replace("learn_skipped_", "")}`;
    return `重み学習: 未試行（正例 ${positives} / 例 ${examples}${reason}）`;
  }
  return (c.learn_accepted ?? 0) > 0
    ? "重み学習: 受理"
    : "重み学習: 棄却（holdout 改善なし）";
}

/** Plain-Japanese "what actually happened" for the timeline (counts only). */
export function outcomeText(run: ActivityRun): string {
  const tone = statusTone(run);
  if (tone === "failed") {
    return `理由: ${errorLabel(run.errorCode)}。この回の変更は反映されていない可能性があります（成功済みは保持）`;
  }
  if (tone === "preempted") return "優先処理のため見送り、後で再試行";
  if (tone === "degraded") {
    return "モデル/索引が使えず、状態を変えずに継続";
  }
  const c = run.counts;
  const n = (k: string) => c[k] ?? 0;
  // Leading count always shown; the rest are omitted when zero.
  const join = (head: string, items: readonly [string, number | string][]) => {
    const t = items
      .filter(([, v]) => v !== 0 && v !== "")
      .map(([l, v]) => `${l} ${v}`)
      .join("、");
    return t.length > 0 ? `${head}、${t}` : head;
  };
  switch (run.op) {
    case "maintain.consolidate":
      return join(`統合を ${c.applied ?? n("written")} 件書き込み`, [
        ["変更なし", n("unchanged")],
        ["根拠不足", n("no_grounded")],
        ["保留", n("deferred")],
      ]);
    case "maintain.distill":
      return join(`蒸留を ${n("applied")} 件適用`, [
        ["確認", n("reviewed")],
        ["失敗", n("failed")],
        ["保留", n("deferred")],
      ]);
    case "maintain.associate": {
      const e = [
        n("edges_written") > 0 ? `+${n("edges_written")}` : "",
        n("edges_removed") > 0 ? `−${n("edges_removed")}` : "",
      ]
        .filter((s) => s.length > 0)
        .join("/");
      return join(`関連付けを ${n("applied")} 件更新`, [
        ["埋め込み", n("embedded")],
        ["辺", e],
        ["トピック", n("topics_written")],
        ["残り", n("remaining")],
      ]);
    }
    case "maintain.activation": {
      const base = join(`${n("scored")} 件を採点`, [
        ["退役", n("retired")],
        ["再活性化", n("reactivated")],
        ["退役候補", n("would_retire")],
        ["再活性候補", n("would_reactivate")],
      ]);
      const learn = learnLine(c);
      return learn.length > 0 ? `${base}\n${learn}` : base;
    }
    case "topic.backfill":
      return join(`${n("assigned")} 件にトピックを付与`, [
        ["残り", n("remaining")],
        ["失敗", n("failed")],
      ]);
  }
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

/* ---------------- memory content statistics (read-only) --------------- */

export type MemoryKind =
  | "user_fact"
  | "model_inference"
  | "summary"
  | "correction";
export type MemoryStatus = "active" | "retired" | "superseded" | "archived";

export const MEMORY_KIND_ORDER: readonly MemoryKind[] = [
  "user_fact",
  "model_inference",
  "summary",
  "correction",
];
export const MEMORY_STATUS_ORDER: readonly MemoryStatus[] = [
  "active",
  "retired",
  "superseded",
  "archived",
];

export const MEMORY_KIND_LABELS: Record<MemoryKind, string> = {
  user_fact: "ユーザーの事実",
  model_inference: "推測",
  summary: "要約",
  correction: "訂正",
};

export const MEMORY_STATUS_LABELS: Record<MemoryStatus, string> = {
  active: "有効",
  retired: "退役",
  superseded: "置換済み",
  archived: "保管",
};

export interface MemoryStats {
  readonly byKind: Readonly<Record<MemoryKind, number>>;
  readonly byStatus: Readonly<Record<MemoryStatus, number>>;
  readonly importance?: MemoryStatsImportance;
  readonly computedAt: number;
  readonly truncated: boolean;
}

export interface MemoryImportanceBucket {
  readonly lt: number;
  readonly count: number;
}

export interface MemoryStatsImportance {
  readonly scored: number;
  readonly unscored: number;
  readonly buckets: readonly MemoryImportanceBucket[];
}

export interface MemoryImportanceBar extends MemoryStatsCard {
  readonly percent: number;
}

/** Fixed server bucket upper bounds (last is the exclusive top). */
const IMPORTANCE_BUCKET_LTS: readonly number[] = [0.2, 0.4, 0.6, 0.8, 1.0001];
/** Fixed display labels for those five buckets. */
export const MEMORY_IMPORTANCE_LABELS: readonly string[] = [
  "0–0.2",
  "0.2–0.4",
  "0.4–0.6",
  "0.6–0.8",
  "0.8–1.0",
];

export interface MemoryStatsCard {
  readonly key: string;
  readonly label: string;
  readonly value: number;
}

export interface MemoryKindBar extends MemoryStatsCard {
  readonly percent: number;
}

function parseKindCounts(value: unknown): Record<MemoryKind, number> | null {
  if (!isRecord(value)) return null;
  const out = {} as Record<MemoryKind, number>;
  for (const kind of MEMORY_KIND_ORDER) {
    const count = value[kind];
    if (!isNonNegativeInteger(count)) return null;
    out[kind] = count;
  }
  return out;
}

function parseStatusCounts(
  value: unknown,
): Record<MemoryStatus, number> | null {
  if (!isRecord(value)) return null;
  const out = {} as Record<MemoryStatus, number>;
  for (const status of MEMORY_STATUS_ORDER) {
    const count = value[status];
    if (!isNonNegativeInteger(count)) return null;
    out[status] = count;
  }
  return out;
}

function parseImportance(value: unknown): MemoryStatsImportance | null {
  if (
    !isRecord(value) ||
    !isNonNegativeInteger(value.scored) ||
    !isNonNegativeInteger(value.unscored) ||
    !Array.isArray(value.buckets) ||
    value.buckets.length !== IMPORTANCE_BUCKET_LTS.length
  ) {
    return null;
  }
  const buckets: MemoryImportanceBucket[] = [];
  for (let index = 0; index < value.buckets.length; index += 1) {
    const raw = value.buckets[index];
    if (
      !isRecord(raw) ||
      raw.lt !== IMPORTANCE_BUCKET_LTS[index] ||
      !isNonNegativeInteger(raw.count)
    ) {
      return null;
    }
    buckets.push({ lt: raw.lt as number, count: raw.count });
  }
  return { scored: value.scored, unscored: value.unscored, buckets };
}

/** Strict parse of GET /api/memory/stats (numbers only, no bodies). */
export function parseMemoryStats(body: unknown): MemoryStats | null {
  if (!isRecord(body)) return null;
  const byKind = parseKindCounts(body.byKind);
  const byStatus = parseStatusCounts(body.byStatus);
  const importance =
    body.importance === undefined
      ? undefined
      : parseImportance(body.importance);
  if (
    byKind === null ||
    byStatus === null ||
    (body.importance !== undefined && importance === null) ||
    !isNonNegativeInteger(body.computedAt) ||
    typeof body.truncated !== "boolean"
  ) {
    return null;
  }
  return {
    byKind,
    byStatus,
    ...(importance !== undefined && importance !== null ? { importance } : {}),
    computedAt: body.computedAt,
    truncated: body.truncated,
  };
}

/** Four status cards in fixed order (active/retired/superseded/archived). */
export function memoryStatusCards(stats: MemoryStats): MemoryStatsCard[] {
  return MEMORY_STATUS_ORDER.map((status) => ({
    key: status,
    label: MEMORY_STATUS_LABELS[status],
    value: stats.byStatus[status],
  }));
}

/** Active-kind bars; widths are relative to the largest kind count. */
export function memoryKindBars(stats: MemoryStats): MemoryKindBar[] {
  const values = MEMORY_KIND_ORDER.map((kind) => stats.byKind[kind]);
  const max = Math.max(1, ...values);
  return MEMORY_KIND_ORDER.map((kind) => ({
    key: kind,
    label: MEMORY_KIND_LABELS[kind],
    value: stats.byKind[kind],
    percent: Math.round((stats.byKind[kind] / max) * 100),
  }));
}

/**
 * Importance distribution bars (five fixed buckets + unscored). Empty when
 * the older paged fallback produced no importance data.
 */
export function memoryImportanceBars(
  stats: MemoryStats,
): MemoryImportanceBar[] {
  const importance = stats.importance;
  if (importance === undefined) return [];
  const entries = importance.buckets.map((bucket, index) => ({
    key: `importance-${index}`,
    label: MEMORY_IMPORTANCE_LABELS[index] ?? String(bucket.lt),
    value: bucket.count,
  }));
  entries.push({
    key: "importance-unscored",
    label: "未採点",
    value: importance.unscored,
  });
  const max = Math.max(1, ...entries.map((entry) => entry.value));
  return entries.map((entry) => ({
    ...entry,
    percent: Math.round((entry.value / max) * 100),
  }));
}
