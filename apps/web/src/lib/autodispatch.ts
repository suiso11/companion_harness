// Pure read/derive helpers for the chat-shell Auto-dispatch panel.
//
// The browser only consumes the ACTUAL session-scoped autodispatch API and
// renders untrusted plan text via plain interpolation. Nothing here can
// widen a policy: the server owns alias/scopes/checks/caps and validates
// every source turn. The UI never authorizes a plan, never applies source,
// and never treats a candidate trial result as a host apply.

export type PolicyStatus = "active" | "revoked" | "expired";
export type PlanStatus =
  | "frozen"
  | "needs_decision"
  | "discuss"
  | "blocked"
  | "superseded"
  | "dispatched";
export type ExecutionStatus =
  | "reserved"
  | "authorized"
  | "blocked"
  | "denied"
  | "superseded";
export type IntentKind = "execute" | "discuss" | "unclear";
export type Operation = "investigate" | "implement";

export interface PolicyCaps {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly maxModelCalls: number;
  readonly maxOutputTokens: number;
  readonly perCallTimeoutMs: number;
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  readonly maxConcurrent: number;
  readonly jobsPerDay: number;
  readonly concurrentExecutions: number;
}

export interface StandingPolicy {
  readonly id: string;
  readonly workspaceAlias: string;
  readonly version: number;
  readonly status: PolicyStatus;
  readonly operations: readonly Operation[];
  readonly readScopes: readonly string[];
  readonly writeScopes: readonly string[];
  readonly checks: readonly string[];
  readonly caps: PolicyCaps;
  readonly expiresAt: string | null;
  readonly createdAt: number;
}

export interface IntentQuote {
  readonly turnId: string;
  readonly runId: string;
  readonly text: string;
  readonly seq: number;
}

export interface PlanIntent {
  readonly kind: IntentKind;
  readonly quotes: readonly IntentQuote[];
  readonly latestUserTurnId: string;
  readonly latestUserRunId: string;
  readonly provenance: "user-conversation";
}

export interface DispatchPlan {
  readonly id: string;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly revision: number;
  readonly status: PlanStatus;
  readonly goal: string;
  readonly decisions: readonly string[];
  readonly nongoals: readonly string[];
  readonly steps: readonly string[];
  readonly acceptance: readonly string[];
  readonly missing: readonly string[];
  readonly relevantPaths: readonly string[];
  readonly operation: Operation;
  readonly intent: PlanIntent;
  readonly createdAt: number;
}

export interface DispatchExecution {
  readonly id: string;
  readonly planId: string;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly status: ExecutionStatus;
  readonly reason: string | null;
  readonly executionId: string | null;
  readonly createdAt: number;
}

export interface AutodispatchStatus {
  readonly workspaceAlias: string;
  readonly operations: readonly Operation[];
  readonly checks: readonly string[];
  readonly readScopes: readonly string[];
  readonly writeScopes: readonly string[];
  readonly caps: PolicyCaps;
  readonly dependencyReady: boolean;
  readonly policies: readonly StandingPolicy[];
  readonly plans: readonly DispatchPlan[];
  readonly executions: readonly DispatchExecution[];
}

export interface ControlView {
  readonly paused: boolean;
  readonly version: number;
  readonly reason: string | null;
}

export interface SourceAnchor {
  readonly turnId: string;
  readonly runId: string;
  readonly text: string;
  readonly seq: number;
}

export interface TrialDetail {
  readonly grantStatus: string;
  readonly cancelRequested: boolean;
  readonly mode: "read_only" | "write" | null;
  readonly requiredChecks: readonly string[];
  readonly relevantPaths: readonly string[];
  readonly outcome: {
    readonly authorized: boolean;
    readonly succeeded: boolean;
    readonly quiescent: boolean;
    readonly detail: string;
  } | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isOperation(value: unknown): value is Operation {
  return value === "investigate" || value === "implement";
}

function readInt(value: unknown, min = 0): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min
    ? value
    : null;
}

function readCaps(value: unknown): PolicyCaps | null {
  if (!isRecord(value)) return null;
  const keys = [
    "timeoutMs",
    "maxOutputBytes",
    "maxModelCalls",
    "maxOutputTokens",
    "perCallTimeoutMs",
    "maxRequestBytes",
    "maxResponseBytes",
    "maxConcurrent",
    "jobsPerDay",
    "concurrentExecutions",
  ] as const;
  const out: Record<string, number> = {};
  for (const key of keys) {
    const number = readInt(value[key], 1);
    if (number === null) return null;
    out[key] = number;
  }
  return out as unknown as PolicyCaps;
}

function readPolicy(value: unknown): StandingPolicy | null {
  if (!isRecord(value)) return null;
  const status = value.status;
  if (status !== "active" && status !== "revoked" && status !== "expired") {
    return null;
  }
  const caps = readCaps(value.caps);
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceAlias !== "string" ||
    readInt(value.version, 1) === null ||
    readInt(value.createdAt, 0) === null ||
    !Array.isArray(value.operations) ||
    !value.operations.every(isOperation) ||
    !isStringArray(value.readScopes) ||
    !isStringArray(value.writeScopes) ||
    !isStringArray(value.checks) ||
    caps === null ||
    (value.expiresAt !== null && typeof value.expiresAt !== "string")
  ) {
    return null;
  }
  return {
    id: value.id,
    workspaceAlias: value.workspaceAlias,
    version: value.version as number,
    status,
    operations: value.operations as Operation[],
    readScopes: value.readScopes,
    writeScopes: value.writeScopes,
    checks: value.checks,
    caps,
    expiresAt: value.expiresAt as string | null,
    createdAt: value.createdAt as number,
  };
}

function readIntent(value: unknown): PlanIntent | null {
  if (!isRecord(value)) return null;
  const kind = value.kind;
  if (kind !== "execute" && kind !== "discuss" && kind !== "unclear") {
    return null;
  }
  if (!Array.isArray(value.quotes) || value.quotes.length > 8) return null;
  const quotes: IntentQuote[] = [];
  for (const entry of value.quotes) {
    if (
      !isRecord(entry) ||
      typeof entry.turnId !== "string" ||
      typeof entry.runId !== "string" ||
      typeof entry.text !== "string" ||
      readInt(entry.seq, 1) === null
    ) {
      return null;
    }
    quotes.push({
      turnId: entry.turnId,
      runId: entry.runId,
      text: entry.text,
      seq: entry.seq as number,
    });
  }
  if (
    typeof value.latestUserTurnId !== "string" ||
    typeof value.latestUserRunId !== "string" ||
    value.provenance !== "user-conversation"
  ) {
    return null;
  }
  return {
    kind,
    quotes,
    latestUserTurnId: value.latestUserTurnId,
    latestUserRunId: value.latestUserRunId,
    provenance: "user-conversation",
  };
}

function readPlan(value: unknown): DispatchPlan | null {
  if (!isRecord(value)) return null;
  const status = value.status;
  if (
    status !== "frozen" &&
    status !== "needs_decision" &&
    status !== "discuss" &&
    status !== "blocked" &&
    status !== "superseded" &&
    status !== "dispatched"
  ) {
    return null;
  }
  if (!isOperation(value.operation)) return null;
  const intent = readIntent(value.intent);
  if (
    typeof value.id !== "string" ||
    typeof value.policyId !== "string" ||
    readInt(value.policyVersion, 1) === null ||
    readInt(value.revision, 1) === null ||
    readInt(value.createdAt, 0) === null ||
    typeof value.goal !== "string" ||
    !isStringArray(value.decisions) ||
    !isStringArray(value.nongoals) ||
    !isStringArray(value.steps) ||
    !isStringArray(value.acceptance) ||
    !isStringArray(value.missing) ||
    !isStringArray(value.relevantPaths) ||
    intent === null
  ) {
    return null;
  }
  return {
    id: value.id,
    policyId: value.policyId,
    policyVersion: value.policyVersion as number,
    revision: value.revision as number,
    status,
    goal: value.goal,
    decisions: value.decisions,
    nongoals: value.nongoals,
    steps: value.steps,
    acceptance: value.acceptance,
    missing: value.missing,
    relevantPaths: value.relevantPaths,
    operation: value.operation,
    intent,
    createdAt: value.createdAt as number,
  };
}

function readExecution(value: unknown): DispatchExecution | null {
  if (!isRecord(value)) return null;
  const status = value.status;
  if (
    status !== "reserved" &&
    status !== "authorized" &&
    status !== "blocked" &&
    status !== "denied" &&
    status !== "superseded"
  ) {
    return null;
  }
  if (
    typeof value.id !== "string" ||
    typeof value.planId !== "string" ||
    typeof value.policyId !== "string" ||
    readInt(value.policyVersion, 1) === null ||
    readInt(value.createdAt, 0) === null ||
    (value.reason !== null && typeof value.reason !== "string") ||
    (value.executionId !== null && typeof value.executionId !== "string")
  ) {
    return null;
  }
  return {
    id: value.id,
    planId: value.planId,
    policyId: value.policyId,
    policyVersion: value.policyVersion as number,
    status,
    reason: value.reason as string | null,
    executionId: value.executionId as string | null,
    createdAt: value.createdAt as number,
  };
}

/** Parse the actual GET /api/sessions/:id/autodispatch body. */
export function parseAutodispatchStatus(value: unknown): AutodispatchStatus | null {
  if (!isRecord(value) || value.enabled !== true) return null;
  const caps = readCaps(value.caps);
  if (
    typeof value.workspaceAlias !== "string" ||
    !Array.isArray(value.operations) ||
    !value.operations.every(isOperation) ||
    !isStringArray(value.checks) ||
    !isStringArray(value.readScopes) ||
    !isStringArray(value.writeScopes) ||
    typeof value.dependencyReady !== "boolean" ||
    !Array.isArray(value.policies) ||
    !Array.isArray(value.plans) ||
    !Array.isArray(value.executions) ||
    caps === null
  ) {
    return null;
  }
  const policies: StandingPolicy[] = [];
  for (const item of value.policies) {
    const parsed = readPolicy(item);
    if (parsed !== null) policies.push(parsed);
  }
  const plans: DispatchPlan[] = [];
  for (const item of value.plans) {
    const parsed = readPlan(item);
    if (parsed !== null) plans.push(parsed);
  }
  const executions: DispatchExecution[] = [];
  for (const item of value.executions) {
    const parsed = readExecution(item);
    if (parsed !== null) executions.push(parsed);
  }
  return {
    workspaceAlias: value.workspaceAlias,
    operations: value.operations as Operation[],
    checks: value.checks,
    readScopes: value.readScopes,
    writeScopes: value.writeScopes,
    caps,
    dependencyReady: value.dependencyReady,
    policies,
    plans,
    executions,
  };
}

export function parseControl(value: unknown): ControlView | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.paused !== "boolean" ||
    readInt(value.version, 1) === null ||
    (value.reason !== null && typeof value.reason !== "string")
  ) {
    return null;
  }
  return {
    paused: value.paused,
    version: value.version as number,
    reason: value.reason as string | null,
  };
}

/** Read the latest committed `user_text` turn with a selected completed run. */
export function selectLatestCompletedUserTurn(value: unknown): SourceAnchor | null {
  if (!isRecord(value) || !Array.isArray(value.items)) return null;
  let best: SourceAnchor | null = null;
  for (const entry of value.items) {
    if (!isRecord(entry)) continue;
    if (entry.kind !== "user_text" || typeof entry.text !== "string") continue;
    if (entry.text.length < 1) continue;
    if (typeof entry.turnId !== "string") continue;
    const seq = readInt(entry.seq, 1);
    if (seq === null) continue;
    const selected = entry.selectedRun;
    if (!isRecord(selected) || typeof selected.runId !== "string") continue;
    if (best !== null && seq <= best.seq) continue;
    best = {
      turnId: entry.turnId,
      runId: selected.runId,
      text: entry.text,
      seq,
    };
  }
  return best;
}

export function parseTrialDetail(value: unknown): TrialDetail | null {
  if (!isRecord(value) || !isRecord(value.grant)) return null;
  const grant = value.grant;
  if (
    typeof grant.status !== "string" ||
    typeof grant.cancelRequested !== "boolean"
  ) {
    return null;
  }
  let mode: TrialDetail["mode"] = null;
  let requiredChecks: string[] = [];
  let relevantPaths: string[] = [];
  if (isRecord(value.request)) {
    const request = value.request;
    if (request.mode === "read_only" || request.mode === "write") {
      mode = request.mode;
    }
    if (isStringArray(request.requiredChecks)) {
      requiredChecks = request.requiredChecks;
    }
    if (isStringArray(request.relevantPaths)) {
      relevantPaths = request.relevantPaths;
    }
  }
  let outcome: TrialDetail["outcome"] = null;
  if (isRecord(value.outcome)) {
    const result = value.outcome;
    // A durable outcome row is authoritative. `recorded === false` means the
    // worker has not reported yet (the legacy shape has no row flags): keep
    // outcome null so the panel shows 結果待ち instead of a false failure.
    const recorded = typeof result.recorded === "boolean" ? result.recorded : true;
    if (
      recorded &&
      typeof result.authorized === "boolean" &&
      typeof result.succeeded === "boolean" &&
      typeof result.quiescent === "boolean" &&
      typeof result.detail === "string"
    ) {
      outcome = {
        authorized: result.authorized,
        succeeded: result.succeeded,
        quiescent: result.quiescent,
        detail: result.detail,
      };
    }
  }
  return {
    grantStatus: grant.status,
    cancelRequested: grant.cancelRequested,
    mode,
    requiredChecks,
    relevantPaths,
    outcome,
  };
}

export function policyStatusText(status: PolicyStatus): string {
  if (status === "active") return "有効";
  if (status === "revoked") return "取消済み";
  return "期限切れ";
}

export function planStatusText(status: PlanStatus): string {
  switch (status) {
    case "frozen":
      return "確定済み（自動実行待ち）";
    case "needs_decision":
      return "ユーザー判断待ち";
    case "discuss":
      return "相談扱い（実行しません）";
    case "blocked":
      return "ブロック";
    case "superseded":
      return "置換済み";
    case "dispatched":
      return "試行へ引き渡し済み";
  }
}

export function executionStatusText(status: ExecutionStatus): string {
  switch (status) {
    case "reserved":
      return "予約中";
    case "authorized":
      return "試行キュー投入済み";
    case "blocked":
      return "ブロック";
    case "denied":
      return "拒否";
    case "superseded":
      return "取消・置換";
  }
}

export function intentText(kind: IntentKind): string {
  if (kind === "execute") return "実行の合意";
  if (kind === "discuss") return "相談";
  return "不明確";
}

/** Fixed readable causes; unknown reason codes stay visible verbatim. */
export function executionReasonText(reason: string | null): string {
  if (reason === null || reason.length === 0) return "—";
  const map: Record<string, string> = {
    "policy-inactive": "ポリシーが有効ではありません",
    "policy-version": "ポリシーの版が一致しません",
    "plan-stale": "会話が更新され、計画が古くなりました",
    "plan-frozen": "計画が実行可能な状態ではありません",
    "plan-needs_decision": "計画に未解決の判断があります",
    "plan-discuss": "相談扱いのため実行しません",
    "plan-blocked": "計画がブロックされています",
    "intent-stale": "根拠の会話が古くなりました",
    "control-paused": "グローバル自律が停止中です",
    "alias-mismatch": "対象ワークスペースが一致しません",
    "operator-limits": "運用者の上限と一致しません",
    "operation-not-allowed": "操作が許可されていません",
    "profile-caps": "実行プロファイルの上限が不足しています",
    "quota-daily": "1日の実行上限に達しました",
    "quota-concurrent": "同時実行の上限に達しました",
    "authority-rejected": "権限検証で拒否されました",
    "authority-error": "権限処理でエラーになりました",
    "policy-revoked": "ポリシー取消で停止しました",
  };
  return map[reason] ?? reason;
}

export function operationText(operation: Operation): string {
  return operation === "implement" ? "実装候補" : "調査";
}

export function formatInstant(ms: number): string {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

export function formatExpiry(value: string | null): string {
  if (value === null) return "無期限";
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? formatInstant(ms) : value;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${Math.round(bytes / (1024 * 1024))} MiB`;
}

export interface CapsLine {
  readonly label: string;
  readonly value: string;
}

/** Readable actual operator-bounded caps (no host paths). */
export function capsLines(caps: PolicyCaps): CapsLine[] {
  return [
    { label: "実行時間", value: `${Math.round(caps.timeoutMs / 1000)} 秒` },
    { label: "出力上限", value: formatBytes(caps.maxOutputBytes) },
    { label: "モデル呼び出し", value: `${caps.maxModelCalls} 回/実行` },
    { label: "出力トークン", value: `${caps.maxOutputTokens}/呼び出し` },
    { label: "1呼び出し時間", value: `${Math.round(caps.perCallTimeoutMs / 1000)} 秒` },
    { label: "リクエスト上限", value: formatBytes(caps.maxRequestBytes) },
    { label: "応答上限", value: formatBytes(caps.maxResponseBytes) },
    { label: "同時モデル", value: `${caps.maxConcurrent}` },
    { label: "1日の実行", value: `${caps.jobsPerDay} 回` },
    { label: "同時実行", value: `${caps.concurrentExecutions}` },
  ];
}

/** Narrow a selection to actual operator-allowed operations. */
export function narrowOperations(
  selected: readonly string[],
  allowed: readonly Operation[],
): Operation[] {
  return allowed.filter((operation) => selected.includes(operation));
}
