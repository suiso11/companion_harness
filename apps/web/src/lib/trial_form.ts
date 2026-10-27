// Pure staging-form logic for the native trials page. No DOM/no Svelte so the
// request-body mapping (readOnlyMode derivation, local→RFC3339 expiry,
// ceiling clamping, line splitting) is unit-testable directly.
//
// The form can only ever produce the strict `TrialStageRequest` body:
// profile data (workspace alias / mandatory checks / ceilings) always comes
// from the read-only GET /trial-profile route, never from inputs.

export const TRIAL_LINE_MAX = 16;
export const TRIAL_OBJECTIVE_MAX = 8192;
export const TRIAL_ACCEPTANCE_ITEM_MAX = 1024;
export const TRIAL_PATH_ITEM_MAX = 512;
export const TRIAL_MIN_TIMEOUT_MS = 1000;
export const TRIAL_MIN_OUTPUT_BYTES = 1024;
export const TRIAL_DEFAULT_EXPIRY_MS = 3 * 60 * 60 * 1000;

export interface TrialOperationOption {
  readonly value: string;
  readonly label: string;
  readonly readOnlyMode: boolean;
}

/** Closed operation vocabulary with Japanese labels; readOnlyMode is derived
 * here (never chosen by the user) and matches the kernel rule exactly. */
export const TRIAL_OPERATIONS: readonly TrialOperationOption[] = [
  { value: "investigate", label: "調査", readOnlyMode: true },
  { value: "implement", label: "実装", readOnlyMode: false },
  { value: "verify", label: "検証", readOnlyMode: true },
  {
    value: "maintenance_trial",
    label: "保守（試行）",
    readOnlyMode: false,
  },
];

export function trialOperation(value: string): TrialOperationOption | null {
  for (const operation of TRIAL_OPERATIONS) {
    if (operation.value === value) return operation;
  }
  return null;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** Epoch ms → `datetime-local` value in the viewer's local timezone. */
export function toLocalInputValue(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(
    date.getDate(),
  )}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** Default expiry: now + 3h, rendered as a local `datetime-local` value. */
export function defaultTrialExpiryLocal(nowMs: number = Date.now()): string {
  return toLocalInputValue(nowMs + TRIAL_DEFAULT_EXPIRY_MS);
}

/** `datetime-local` (local wall clock) → strict RFC3339 UTC instant at
 * WHOLE-SECOND precision (`...:SSZ`). The trial stage wire rejects a
 * fractional-seconds instant, so the milliseconds produced by `toISOString`
 * are truncated here. Invalid/empty/past input yields null: an expiry must be
 * strictly in the future at staging time. */
export function localInputToRfc3339(
  value: string,
  nowMs: number = Date.now(),
): string | null {
  if (value.length === 0) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  if (parsed.getTime() <= nowMs) return null;
  return parsed.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** One entry per non-empty trimmed line (order preserved). */
export function splitTrialLines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Integer clamp to [min, ceiling]; unparseable input falls back to the
 * ceiling (the form default is the operator ceiling too). */
export function clampTrialCap(
  value: string | number,
  ceiling: number,
  min: number,
): number {
  const parsed =
    typeof value === "number" ? value : Number.parseFloat(value.trim());
  if (!Number.isFinite(parsed)) return ceiling;
  const floored = Math.trunc(parsed);
  return Math.min(ceiling, Math.max(min, floored));
}

export type TrialFormErrorCode =
  | "task_required"
  | "objective_required"
  | "objective_too_long"
  | "acceptance_invalid"
  | "paths_invalid"
  | "operation_invalid"
  | "expiry_invalid"
  | "checks_unavailable";

export interface TrialFormProfile {
  readonly mandatoryChecks: readonly string[];
  readonly ceilings: {
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
  };
}

export interface TrialFormInputs {
  readonly taskId: string;
  readonly objective: string;
  readonly acceptanceText: string;
  readonly pathsText: string;
  readonly operation: string;
  readonly expiryLocal: string;
  readonly timeoutValue: string;
  readonly maxOutputBytesValue: string;
  readonly possibleExternalDataConsent: boolean;
}

export interface TrialStageBody {
  readonly taskId: string;
  readonly objective: string;
  readonly acceptance: readonly string[];
  readonly literalPatchPaths: readonly string[];
  readonly operation: string;
  readonly readOnlyMode: boolean;
  readonly expiry: string;
  readonly possibleExternalDataConsent: boolean;
  readonly objectiveResourceCaps: {
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
  };
  readonly requiredChecks: readonly string[];
}

export type TrialBuildResult =
  | { readonly ok: true; readonly body: TrialStageBody }
  | { readonly ok: false; readonly error: TrialFormErrorCode };

function itemsWithin(lines: readonly string[], max: number): boolean {
  return lines.length >= 1 && lines.length <= max;
}

/** Map raw form state → the exact strict stage body (or a form error code). */
export function buildTrialStageBody(
  inputs: TrialFormInputs,
  profile: TrialFormProfile,
): TrialBuildResult {
  if (inputs.taskId.length === 0) return { ok: false, error: "task_required" };
  const objective = inputs.objective.trim();
  if (objective.length === 0) {
    return { ok: false, error: "objective_required" };
  }
  if (objective.length > TRIAL_OBJECTIVE_MAX) {
    return { ok: false, error: "objective_too_long" };
  }
  const acceptance = splitTrialLines(inputs.acceptanceText);
  if (
    !itemsWithin(acceptance, TRIAL_LINE_MAX) ||
    acceptance.some((item) => item.length > TRIAL_ACCEPTANCE_ITEM_MAX)
  ) {
    return { ok: false, error: "acceptance_invalid" };
  }
  const paths = splitTrialLines(inputs.pathsText);
  if (
    !itemsWithin(paths, TRIAL_LINE_MAX) ||
    paths.some((item) => item.length > TRIAL_PATH_ITEM_MAX)
  ) {
    return { ok: false, error: "paths_invalid" };
  }
  const operation = trialOperation(inputs.operation);
  if (operation === null) {
    return { ok: false, error: "operation_invalid" };
  }
  const expiry = localInputToRfc3339(inputs.expiryLocal);
  if (expiry === null) return { ok: false, error: "expiry_invalid" };
  if (profile.mandatoryChecks.length === 0) {
    return { ok: false, error: "checks_unavailable" };
  }
  return {
    ok: true,
    body: {
      taskId: inputs.taskId,
      objective,
      acceptance,
      literalPatchPaths: paths,
      operation: operation.value,
      readOnlyMode: operation.readOnlyMode,
      expiry,
      possibleExternalDataConsent: inputs.possibleExternalDataConsent,
      objectiveResourceCaps: {
        timeoutMs: clampTrialCap(
          inputs.timeoutValue,
          profile.ceilings.timeoutMs,
          TRIAL_MIN_TIMEOUT_MS,
        ),
        maxOutputBytes: clampTrialCap(
          inputs.maxOutputBytesValue,
          profile.ceilings.maxOutputBytes,
          TRIAL_MIN_OUTPUT_BYTES,
        ),
      },
      requiredChecks: [...profile.mandatoryChecks],
    },
  };
}

export function trialFormErrorText(code: TrialFormErrorCode): string {
  switch (code) {
    case "task_required":
      return "対象の作業を選択してください";
    case "objective_required":
      return "目的を入力してください";
    case "objective_too_long":
      return `目的は${TRIAL_OBJECTIVE_MAX}文字以内にしてください`;
    case "acceptance_invalid":
      return `受け入れ条件は1〜${TRIAL_LINE_MAX}行で入力してください`;
    case "paths_invalid":
      return `対象パスは1〜${TRIAL_LINE_MAX}行で入力してください`;
    case "operation_invalid":
      return "操作を選択してください";
    case "expiry_invalid":
      return "期限を正しく入力してください";
    case "checks_unavailable":
      return "必須チェックが取得できていません";
  }
}

function errorCodeOf(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/** Server error → fixed Japanese notice (codes, never raw messages). */
export function trialStageErrorText(status: number, body: unknown): string {
  const code = errorCodeOf(body);
  if (code === "trials_disabled") return "試行の提案は無効です";
  if (code === "trial_path_outside_profile") {
    return "対象パスが許可された範囲の外にあります。表示されている許可パスを確認してください";
  }
  if (code === "trial_external_consent_unavailable") {
    return "この環境はローカル経路のため、外部データの取り込みに同意できません";
  }
  if (code === "purpose_not_confirmed") {
    return "対象の作業の目的が明示的に確認されていません。目的を確認してから提案してください";
  }
  if (code === "idempotency_key_reused") {
    return "同じ操作がすでに送信されています。一覧を確認してください";
  }
  if (status === 400) return "入力内容を確認してください";
  if (status === 404) return "対象の作業または提案が見つかりません";
  if (status === 409) return "提案を作成できませんでした（状態が変わりました）";
  if (status === 503) return "サーバーを停止中です。しばらく待ってください";
  return "提案の作成に失敗しました";
}
