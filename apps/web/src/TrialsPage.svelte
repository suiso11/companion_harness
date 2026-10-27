<script lang="ts">
// PR-5 native trials page (port of the legacy TrialPanel in
// `apps/server/src/ui/client.ts` ~TrialPanel, markup from `ui/page.ts`).
//
// Same public API + DOM ids as the legacy panel: the session's staged trial
// proposals are listed with their FROZEN staged snapshot, and Approve /
// Expire exist ONLY for a staged+bound proposal (decisionVisible), by
// explicit button press with op-status feedback. Reads never approve.
// Approval semantics preserved exactly:
// - approve: POST .../trials/:id/approve with an Idempotency-Key;
//   201 → 承認しました, 409 → 他の変更がありました, else 承認に失敗しました.
// - expire: keyless state-idempotent POST .../trials/:id/expire;
//   200 → 取り消しました, else 取り消しに失敗しました.
// Every string renders via text interpolation only (no {@html}).
import { fetchJson, postJson, randomUuid } from "./lib/api.js";
import type { GoalConfirmationFields } from "./lib/goal_confirm.js";
import { trialHintForParentGoal } from "./lib/goal_confirm.js";
import { type TrialProposalStatus, trialProposalModel } from "./lib/reducer.js";
// Shared reactive session store (session-rebinding group): a direct deep-link
// into /trials adopts or creates the session ON BOOT here (the chat shell is
// not mounted on this route), and every session change rebinds the panel.
import { ensureSession, getSessionId } from "./lib/session.svelte.js";
import {
  buildTrialStageBody,
  defaultTrialExpiryLocal,
  TRIAL_LINE_MAX,
  TRIAL_OPERATIONS,
  trialFormErrorText,
  trialOperation,
  trialStageErrorText,
} from "./lib/trial_form.js";

interface TrialProposal {
  readonly id: string;
  readonly status: TrialProposalStatus;
  readonly objective: string;
  readonly acceptance: readonly string[];
  readonly literalPatchPaths: readonly string[];
  readonly operation: string;
  readonly readOnlyMode: boolean;
  readonly expiry: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly requiredChecks: readonly string[];
  readonly workspaceAlias: string | null;
  readonly profile: {
    readonly configFingerprint: string;
    readonly sourceRevision: string;
  } | null;
  readonly possibleExternalDataConsent: boolean;
}

/**
 * Structural guard for one trial proposal read from the ACTUAL list API
 * (same contract as the legacy `isTrialProposal`): a malformed body renders
 * nothing rather than a partial card. Unknown body keys are never read.
 */
function isTrialProposal(value: unknown): value is TrialProposal {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  const aliasOk =
    item.workspaceAlias === null ||
    (typeof item.workspaceAlias === "string" &&
      /^[a-z0-9_-]{1,64}$/.test(item.workspaceAlias));
  let profileOk = false;
  if (item.profile === null) {
    profileOk = true;
  } else if (typeof item.profile === "object" && item.profile !== null) {
    const profile = item.profile as Record<string, unknown>;
    profileOk =
      typeof profile.configFingerprint === "string" &&
      /^[0-9a-f]{64}$/.test(profile.configFingerprint) &&
      typeof profile.sourceRevision === "string" &&
      /^[0-9a-f]{40}$/.test(profile.sourceRevision);
  }
  return (
    typeof item.id === "string" &&
    (item.status === "staged" ||
      item.status === "granted" ||
      item.status === "expired" ||
      item.status === "invalidated") &&
    typeof item.objective === "string" &&
    Array.isArray(item.acceptance) &&
    Array.isArray(item.literalPatchPaths) &&
    typeof item.operation === "string" &&
    typeof item.readOnlyMode === "boolean" &&
    typeof item.expiry === "string" &&
    typeof item.timeoutMs === "number" &&
    typeof item.maxOutputBytes === "number" &&
    Array.isArray(item.requiredChecks) &&
    aliasOk &&
    profileOk &&
    typeof item.possibleExternalDataConsent === "boolean"
  );
}

/** Session trial outcome attached to the trial reads (legacy
 * `readTrialOutcome`): malformed values render as absent. */
function readTrialOutcome(value: unknown): {
  readonly status: string;
  readonly authorized: boolean;
  readonly summary: string;
} | null {
  if (typeof value !== "object" || value === null) return null;
  const outcome = (value as Record<string, unknown>).outcome;
  if (outcome === null || outcome === undefined) return null;
  if (typeof outcome !== "object" || Array.isArray(outcome)) return null;
  const record = outcome as Record<string, unknown>;
  if (
    typeof record.status !== "string" ||
    typeof record.authorized !== "boolean"
  ) {
    return null;
  }
  if (
    record.summary !== undefined &&
    record.summary !== null &&
    typeof record.summary !== "string"
  ) {
    return null;
  }
  return {
    status: record.status,
    authorized: record.authorized,
    summary: typeof record.summary === "string" ? record.summary : "",
  };
}

/** Fixed plain-text outcome lines (legacy `trialOutcomeLines`). */
function trialOutcomeLines(
  outcome: {
    readonly status: string;
    readonly authorized: boolean;
    readonly summary: string;
  } | null,
): readonly string[] {
  if (outcome === null) return ["結果: 未実行"];
  const lines = [
    `結果: ${outcome.status} (承認済み: ${outcome.authorized ? "はい" : "いいえ"})`,
  ];
  if (outcome.summary.length > 0) {
    lines.push(`概要: ${outcome.summary.slice(0, 200)}`);
  }
  return lines;
}

/** Bounded sealed-trial report attached to the trial detail GET. Guest text
 * (summary/findings/unresolved) is UNATTESTED presentation data; checks and
 * artifact are host-checked. Malformed bodies render as absent. */
interface TrialReport {
  readonly summary: string;
  readonly findings: readonly string[];
  readonly unresolved: readonly string[];
  readonly checks: readonly {
    readonly name: string;
    readonly outcome: string;
    readonly exit: number | null;
  }[];
  readonly artifact: {
    readonly sha256: string;
    readonly entryCount: number;
  } | null;
  readonly verified: boolean;
}

const GUEST_PROVENANCE = "guest-reported-unattested";
const HOST_PROVENANCE = "host-checked";

function reportStrings(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .slice(0, max);
}

function readTrialReport(value: unknown): TrialReport | null {
  if (typeof value !== "object" || value === null) return null;
  const report = (value as Record<string, unknown>).report;
  if (report === null || report === undefined) return null;
  if (typeof report !== "object" || Array.isArray(report)) return null;
  const record = report as Record<string, unknown>;
  if (typeof record.summary !== "string") return null;
  if (typeof record.verified !== "boolean") return null;
  const provenance = record.provenance;
  if (typeof provenance !== "object" || provenance === null) return null;
  const prov = provenance as Record<string, unknown>;
  if (
    prov.findings !== GUEST_PROVENANCE ||
    prov.checks !== HOST_PROVENANCE ||
    prov.artifact !== HOST_PROVENANCE
  ) {
    return null;
  }
  const checksRaw = Array.isArray(record.checks) ? record.checks : [];
  const checks: { name: string; outcome: string; exit: number | null }[] = [];
  for (const entry of checksRaw) {
    if (typeof entry !== "object" || entry === null) continue;
    const check = entry as Record<string, unknown>;
    if (
      typeof check.name !== "string" ||
      (check.outcome !== "passed" && check.outcome !== "failed") ||
      (check.exit !== null &&
        !(typeof check.exit === "number" && Number.isInteger(check.exit)))
    ) {
      continue;
    }
    checks.push({
      name: check.name.slice(0, 64),
      outcome: check.outcome,
      exit: check.exit,
    });
  }
  let artifact: TrialReport["artifact"] = null;
  const rawArtifact = record.artifact;
  if (typeof rawArtifact === "object" && rawArtifact !== null) {
    const a = rawArtifact as Record<string, unknown>;
    if (
      typeof a.sha256 === "string" &&
      /^[0-9a-f]{64}$/.test(a.sha256) &&
      typeof a.entryCount === "number" &&
      Number.isInteger(a.entryCount) &&
      a.entryCount >= 0
    ) {
      artifact = { sha256: a.sha256, entryCount: a.entryCount };
    }
  }
  return {
    summary: record.summary.slice(0, 2048),
    findings: reportStrings(record.findings, 16).map((line) =>
      line.slice(0, 1024),
    ),
    unresolved: reportStrings(record.unresolved, 8).map((line) =>
      line.slice(0, 1024),
    ),
    checks,
    artifact,
    verified: record.verified,
  };
}

/** Frozen operator profile facts read from GET /trial-profile. */
interface TrialProfileFacts {
  readonly workspaceAlias: string;
  readonly mandatoryChecks: readonly string[];
  readonly allowedPaths: readonly string[];
  readonly modelRoute: "local" | "synthetic-local" | "external";
  readonly ceilings: {
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
  };
  readonly operations: readonly {
    readonly operation: string;
    readonly readOnlyMode: boolean;
  }[];
}

/** Open (actionable) session tasks offered by the staging form. */
interface TaskOption {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly parentPurposeId: string | null;
}

/** Structural guard: malformed profile bodies hide the form (fail closed). */
function isTrialProfileFacts(value: unknown): value is TrialProfileFacts {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  const ceilings = item.ceilings as Record<string, unknown> | null;
  if (typeof ceilings !== "object" || ceilings === null) return false;
  if (
    !Number.isInteger(ceilings.timeoutMs) ||
    (ceilings.timeoutMs as number) < 1000 ||
    !Number.isInteger(ceilings.maxOutputBytes) ||
    (ceilings.maxOutputBytes as number) < 1024
  ) {
    return false;
  }
  if (
    typeof item.workspaceAlias !== "string" ||
    !/^[a-z0-9_-]{1,64}$/.test(item.workspaceAlias)
  ) {
    return false;
  }
  if (
    !Array.isArray(item.mandatoryChecks) ||
    !item.mandatoryChecks.every(
      (check) =>
        typeof check === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(check),
    )
  ) {
    return false;
  }
  if (
    !Array.isArray(item.allowedPaths) ||
    item.allowedPaths.length < 1 ||
    !item.allowedPaths.every(
      (path) => typeof path === "string" && path.length > 0,
    )
  ) {
    return false;
  }
  if (
    item.modelRoute !== "local" &&
    item.modelRoute !== "synthetic-local" &&
    item.modelRoute !== "external"
  ) {
    return false;
  }
  if (!Array.isArray(item.operations)) return false;
  return item.operations.every((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const option = entry as Record<string, unknown>;
    const known = trialOperation(
      typeof option.operation === "string" ? option.operation : "",
    );
    return (
      known !== null &&
      typeof option.readOnlyMode === "boolean" &&
      option.readOnlyMode === known.readOnlyMode
    );
  });
}

function isTaskOption(value: unknown): value is TaskOption {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "string" &&
    typeof row.title === "string" &&
    typeof row.status === "string" &&
    row.kind === "task" &&
    (row.parentPurposeId === null || typeof row.parentPurposeId === "string") &&
    (row.status === "open" || row.status === "in_progress")
  );
}

let proposals = $state<TrialProposal[]>([]);
let statusText = $state("");
let detailVisible = $state(false);
let detailLines = $state<readonly string[]>([]);
let detailTitles = $state<readonly (string | undefined)[]>([]);
let opStatus = $state("");
let decisionVisible = $state(false);
let selected = $state<string | null>(null);
let detailReport = $state<TrialReport | null>(null);
let mutating = $state(false);
let seq = 0;

// Staging form (native only): operator facts from GET /trial-profile, open
// session tasks from GET /tasks. readOnlyMode is always derived from the
// selected operation; requiredChecks is always the frozen mandatory set.
let profile = $state<TrialProfileFacts | null>(null);
let formVisible = $state(false);
let formStatus = $state("");
let submitting = $state(false);
let tasks = $state<TaskOption[]>([]);
/** purposeId → confirmation-relevant purpose fields (kind/status/explicit). */
let goalFields = $state<Record<string, GoalConfirmationFields>>({});
let taskId = $state("");
let objective = $state("");
let acceptanceText = $state("");
let pathsText = $state("");
let operationValue = $state("investigate");
let expiryLocal = $state("");
let timeoutValue = $state("");
let maxOutputBytesValue = $state("");
let consent = $state(false);
let defaultsApplied = false;
let setupSeq = 0;

/** Stale-response guard: only the latest generation may render. */
function current(mine: number, sessionId: string | null): boolean {
  return seq === mine && getSessionId() === sessionId;
}

async function refreshList(): Promise<void> {
  const sessionId = getSessionId();
  if (sessionId === null) return;
  seq += 1;
  const mine = seq;
  const listed = await fetchJson(
    `/api/sessions/${encodeURIComponent(sessionId)}/trials`,
  );
  if (!current(mine, sessionId)) return;
  if (listed.status === 404) {
    // Disabled config (or unknown session): fixed disabled state, no card.
    proposals = [];
    detailVisible = false;
    selected = null;
    detailReport = null;
    statusText = "試行の提案は無効です";
    return;
  }
  if (listed.status !== 200) return;
  const items = (listed.body as { items?: unknown }).items;
  if (!Array.isArray(items)) return;
  proposals = items.filter(isTrialProposal);
  let staged = 0;
  for (const proposal of proposals) {
    if (proposal.status === "staged") staged += 1;
  }
  statusText =
    staged > 0
      ? "承認待ちの試行の提案があります"
      : "承認待ちの試行の提案はありません";
  if (selected !== null) await select(selected);
}

/** Load the form facts (profile + actionable tasks) for this session. */
async function refreshForm(sessionId: string): Promise<void> {
  const mine = ++setupSeq;
  const base = `/api/sessions/${encodeURIComponent(sessionId)}`;
  let profileResult: { status: number; body: unknown };
  let openResult: { status: number; body: unknown };
  let inProgressResult: { status: number; body: unknown };
  let purposesResult: { status: number; body: unknown };
  try {
    // Server-side filters run BEFORE the limit, so older actionable tasks
    // cannot be hidden behind newer unrelated/kinds records.
    [profileResult, openResult, inProgressResult, purposesResult] =
      await Promise.all([
        fetchJson(`${base}/trial-profile`),
        fetchJson(`${base}/tasks?kind=task&status=open&limit=50`),
        fetchJson(`${base}/tasks?kind=task&status=in_progress&limit=50`),
        fetchJson(`${base}/purposes?limit=100`),
      ]);
  } catch {
    return;
  }
  if (setupSeq !== mine || getSessionId() !== sessionId) return;
  if (
    profileResult.status !== 200 ||
    !isTrialProfileFacts(profileResult.body)
  ) {
    profile = null;
    formVisible = false;
    formStatus = "";
    return;
  }
  profile = profileResult.body;
  formVisible = true;
  if (!defaultsApplied) {
    timeoutValue = String(profile.ceilings.timeoutMs);
    maxOutputBytesValue = String(profile.ceilings.maxOutputBytes);
    expiryLocal = defaultTrialExpiryLocal();
    defaultsApplied = true;
  }
  const collect = (result: { status: number; body: unknown }): TaskOption[] => {
    const items = (result.body as { items?: unknown }).items;
    return result.status === 200 && Array.isArray(items)
      ? items.filter(isTaskOption)
      : [];
  };
  const purposesBody =
    purposesResult.status === 200
      ? (purposesResult.body as { items?: unknown }).items
      : undefined;
  const nextGoalFields: Record<string, GoalConfirmationFields> = {};
  if (Array.isArray(purposesBody)) {
    for (const entry of purposesBody) {
      const row = entry as {
        id?: unknown;
        explicit?: unknown;
        status?: unknown;
        sourceKind?: unknown;
        kind?: unknown;
      };
      if (typeof row.id === "string")
        nextGoalFields[row.id] = {
          explicit: row.explicit,
          status: row.status,
          sourceKind: row.sourceKind,
          kind: row.kind,
        };
    }
  }
  goalFields = nextGoalFields;
  tasks = [...collect(openResult), ...collect(inProgressResult)];
  if (taskId !== "" && !tasks.some((task) => task.id === taskId)) {
    taskId = "";
  }
  if (taskId === "" && tasks.length > 0) {
    taskId = tasks[0]?.id ?? "";
  }
}

/** Hint shown when the selected task's parent goal is still non-explicit
 * (trial authority requires an explicit user goal; the fix is the
 * confirmation button in the goals list, never a bypass here). */
const selectedGoalHint = $derived.by<string | null>(() => {
  const task = tasks.find((entry) => entry.id === taskId);
  return trialHintForParentGoal(goalFields, task?.parentPurposeId ?? null);
});

/** POST one strict stage body with a fresh Idempotency-Key, then select the
 * returned proposal. Approval stays a separate explicit button. */
async function stageTrial(): Promise<void> {
  const sessionId = getSessionId();
  const currentProfile = profile;
  if (sessionId === null || currentProfile === null || submitting) return;
  const built = buildTrialStageBody(
    {
      taskId,
      objective,
      acceptanceText,
      pathsText,
      operation: operationValue,
      expiryLocal,
      timeoutValue,
      maxOutputBytesValue,
      possibleExternalDataConsent: consent,
    },
    {
      mandatoryChecks: currentProfile.mandatoryChecks,
      ceilings: currentProfile.ceilings,
    },
  );
  if (!built.ok) {
    formStatus = trialFormErrorText(built.error);
    return;
  }
  submitting = true;
  try {
    const result = await postJson(
      `/api/sessions/${encodeURIComponent(sessionId)}/trials`,
      built.body,
      randomUuid(),
    );
    if (result.status !== 201) {
      formStatus = trialStageErrorText(result.status, result.body);
      return;
    }
    formStatus = "提案を作成しました。内容を確認して承認してください";
    objective = "";
    acceptanceText = "";
    pathsText = "";
    consent = false;
    expiryLocal = defaultTrialExpiryLocal();
    const created = (result.body as { id?: unknown }).id;
    await refreshList();
    if (typeof created === "string") await select(created);
  } finally {
    submitting = false;
  }
}

async function select(proposalId: string): Promise<void> {
  const sessionId = getSessionId();
  if (sessionId === null) return;
  seq += 1;
  const mine = seq;
  const fetched = await fetchJson(
    `/api/sessions/${encodeURIComponent(sessionId)}/trials/${encodeURIComponent(proposalId)}`,
  );
  if (!current(mine, sessionId)) return;
  if (fetched.status !== 200 || !isTrialProposal(fetched.body)) return;
  const proposal = fetched.body;
  const outcome = readTrialOutcome(fetched.body);
  detailReport = readTrialReport(fetched.body);
  selected = proposal.id;
  const model = trialProposalModel(
    {
      status: proposal.status,
      objective: proposal.objective,
      acceptance: proposal.acceptance.filter(
        (entry): entry is string => typeof entry === "string",
      ),
      literalPatchPaths: proposal.literalPatchPaths.filter(
        (entry): entry is string => typeof entry === "string",
      ),
      operation: proposal.operation,
      readOnlyMode: proposal.readOnlyMode,
      expiry: proposal.expiry,
      timeoutMs: proposal.timeoutMs,
      maxOutputBytes: proposal.maxOutputBytes,
      requiredChecks: proposal.requiredChecks.filter(
        (entry): entry is string => typeof entry === "string",
      ),
      workspaceAlias: proposal.workspaceAlias,
      profile: proposal.profile,
      possibleExternalDataConsent: proposal.possibleExternalDataConsent,
    },
    true,
  );
  const lines = [...model.detailLines, ...trialOutcomeLines(outcome)];
  const titles: Array<string | undefined> = lines.map(() => undefined);
  // The config-fingerprint line carries the full fingerprint as its title.
  const fingerprintLine = lines.findIndex((line) =>
    line.startsWith("設定指紋: "),
  );
  if (
    fingerprintLine >= 0 &&
    proposal.profile !== null &&
    typeof proposal.profile.configFingerprint === "string"
  ) {
    titles[fingerprintLine] = proposal.profile.configFingerprint;
  }
  detailLines = lines;
  detailTitles = titles;
  opStatus = model.statusText;
  decisionVisible = model.decisionVisible;
  detailVisible = true;
}

async function approve(): Promise<void> {
  const sessionId = getSessionId();
  const id = selected;
  if (sessionId === null || id === null || mutating) return;
  mutating = true;
  try {
    const result = await postJson(
      `/api/sessions/${encodeURIComponent(sessionId)}/trials/${encodeURIComponent(id)}/approve`,
      {},
      randomUuid(),
    );
    if (result.status === 201) {
      opStatus = "承認しました";
    } else if (result.status === 409) {
      opStatus = "他の変更がありました。一覧を更新しました";
    } else {
      opStatus = "承認に失敗しました";
    }
    await refreshList();
  } finally {
    mutating = false;
  }
}

async function expire(): Promise<void> {
  const sessionId = getSessionId();
  const id = selected;
  if (sessionId === null || id === null || mutating) return;
  mutating = true;
  try {
    // Keyless state-idempotent expire: no Idempotency-Key header.
    const result = await postJson(
      `/api/sessions/${encodeURIComponent(sessionId)}/trials/${encodeURIComponent(id)}/expire`,
      {},
      null,
    );
    if (result.status === 200) {
      opStatus = "取り消しました";
    } else {
      opStatus = "取り消しに失敗しました";
    }
    await refreshList();
  } finally {
    mutating = false;
  }
}

// Boot: adopt/create the session on a direct deep-link (finding: trials
// mounted without a session-owning shell), then rebind reactively — every
// session change (or a session becoming available) resets the detail and
// refetches the list. No polling watcher: the store is reactive.
$effect(() => {
  const sessionId = getSessionId();
  if (sessionId === null) {
    void (async () => {
      const id = await ensureSession();
      if (id !== null && getSessionId() === id) await refreshList();
    })();
    return;
  }
  // Session switch: reset selection + detail, refetch for the new session.
  selected = null;
  detailVisible = false;
  decisionVisible = false;
  detailLines = [];
  detailTitles = [];
  seq += 1;
  defaultsApplied = false;
  taskId = "";
  profile = null;
  formVisible = false;
  formStatus = "";
  void refreshList();
  void refreshForm(sessionId);
});
</script>

<svelte:head>
  <title>試行の提案 · Companion Harness</title>
</svelte:head>

{#await import("./lib/AutonomyPausedBanner.svelte") then banner}
  <svelte:component this={banner.default} />
{/await}

<section id="trials" aria-label="試行の提案" class="feature-panel">
  <h2>試行の提案</h2>
  <p id="trial-status" aria-live="polite">{statusText}</p>
  {#if formVisible && profile !== null}
    <form
      id="trial-stage-form"
      aria-label="新しい試行を提案"
      onsubmit={(event) => {
        event.preventDefault();
        void stageTrial();
      }}
    >
      <h3>新しい試行を提案</h3>
      <p id="trial-allowed-paths">
        許可パス（この範囲のみ変更できます）: {profile.allowedPaths.join(", ")}
      </p>
      <p id="trial-profile-summary">
        作業領域: {profile.workspaceAlias}・必須チェック:
        {profile.mandatoryChecks.join(", ")}
      </p>
      {#if selectedGoalHint !== null}
        <p id="trial-goal-authority-hint">{selectedGoalHint}</p>
      {/if}
      {#if tasks.length === 0}
        <p id="trial-task-hint">
          対象にできる作業がありません。<a href="/tasks">タスク・目的</a>で作業を作成してください。
        </p>
      {/if}
      <label>
        対象の作業
        <select id="trial-task-select" bind:value={taskId}>
          {#each tasks as task (task.id)}
            <option value={task.id}>{task.title}（{task.status}）</option>
          {/each}
        </select>
      </label>
      <label>
        目的
        <textarea
          id="trial-objective"
          rows="3"
          bind:value={objective}
        ></textarea>
      </label>
      <label>
        受け入れ条件（1行に1件・1〜{TRIAL_LINE_MAX}件）
        <textarea
          id="trial-acceptance"
          rows="3"
          bind:value={acceptanceText}
        ></textarea>
      </label>
      <label>
        対象パス（1行に1件・1〜{TRIAL_LINE_MAX}件）
        <textarea id="trial-paths" rows="3" bind:value={pathsText}></textarea>
      </label>
      <label>
        操作
        <select id="trial-operation" bind:value={operationValue}>
          {#each TRIAL_OPERATIONS as option (option.value)}
            <option value={option.value}>{option.label}</option>
          {/each}
        </select>
      </label>
      <p id="trial-readonly-mode">
        読み取り専用: {trialOperation(operationValue)?.readOnlyMode
          ? "はい（自動）"
          : "いいえ（自動）"}
      </p>
      <label>
        期限（ローカル時刻）
        <input
          id="trial-expiry"
          type="datetime-local"
          bind:value={expiryLocal}
        />
      </label>
      <label>
        タイムアウト（ミリ秒・上限 {profile.ceilings.timeoutMs}）
        <input
          id="trial-timeout"
          type="text"
          inputmode="numeric"
          autocomplete="off"
          bind:value={timeoutValue}
        />
      </label>
      <label>
        出力上限（バイト・上限 {profile.ceilings.maxOutputBytes}）
        <input
          id="trial-output-cap"
          type="text"
          inputmode="numeric"
          autocomplete="off"
          bind:value={maxOutputBytesValue}
        />
      </label>
      {#if profile.modelRoute === "external"}
        <label>
          外部データの取り込みに同意する
          <input
            id="trial-consent"
            type="checkbox"
            bind:checked={consent}
          />
        </label>
      {:else}
        <p id="trial-consent-unavailable">
          ローカル経路のため外部データの同意は不要です
        </p>
      {/if}
      <p id="trial-required-checks">
        必須チェック（固定）: {profile.mandatoryChecks.join(", ")}
      </p>
      <button id="trial-stage-submit" type="submit" disabled={submitting}>
        提案を作成
      </button>
      <p id="trial-form-status" aria-live="polite">{formStatus}</p>
    </form>
  {/if}
  <ul id="trial-list">
    {#each proposals as proposal (proposal.id)}
      <li>
        <button
          type="button"
          onclick={() => void select(proposal.id)}
        >
          {proposal.operation} [{proposal.workspaceAlias ?? "unbound"}]:
          {proposal.objective} ({proposal.status})
        </button>
      </li>
    {/each}
  </ul>
  <div id="trial-detail" hidden={!detailVisible}>
    <pre id="trial-detail-body">
      {#each detailLines as line, i}
        <div title={detailTitles[i]}>{line}</div>
      {/each}
    </pre>
    {#if detailReport !== null}
      {@const report = detailReport}
      <section id="trial-report" aria-label="試行の報告">
        <h3>報告</h3>
        <p id="trial-report-summary">{report.summary}</p>
        <h3>ホスト検証</h3>
        <p id="trial-report-verified">
          検証済み: {report.verified ? "はい" : "いいえ"}
        </p>
        <ul id="trial-report-checks">
          {#each report.checks as check (check.name)}
            <li>
              {check.name}: {check.outcome}
              {#if check.exit !== null}（終了コード {check.exit}）{/if}
            </li>
          {/each}
        </ul>
        {#if report.artifact !== null}
          <p id="trial-report-artifact">
            成果物: {report.artifact.sha256}（{report.artifact.entryCount} 件）
          </p>
        {/if}
        <h3>ゲスト報告（未検証）</h3>
        <ul id="trial-report-findings">
          {#each report.findings as finding, index (index)}
            <li>{finding}</li>
          {/each}
        </ul>
        <h3>未解決</h3>
        <ul id="trial-report-unresolved">
          {#each report.unresolved as item, index (index)}
            <li>{item}</li>
          {/each}
        </ul>
      </section>
    {/if}
    <button
      id="trial-approve-button"
      type="button"
      disabled={!decisionVisible || mutating}
      onclick={() => void approve()}
    >
      承認する
    </button>
    <button
      id="trial-expire-button"
      type="button"
      disabled={!decisionVisible || mutating}
      onclick={() => void expire()}
    >
      取り消す
    </button>
    <p id="trial-op-status" aria-live="polite">{opStatus}</p>
  </div>
</section>
