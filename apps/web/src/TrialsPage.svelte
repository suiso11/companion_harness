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
import ChatPage from "./ChatPage.svelte";
import { fetchJson, postJson, randomUuid } from "./lib/api.js";
import type { GoalConfirmationFields } from "./lib/goal_confirm.js";
import { trialHintForParentGoal } from "./lib/goal_confirm.js";
import { type TrialProposalStatus, trialProposalModel } from "./lib/reducer.js";
// Shared reactive session store (session-rebinding group): a direct deep-link
// into /trials adopts or creates the session ON BOOT here (the chat shell is
// not mounted on this route), and every session change rebinds the panel.
import { ensureSession, getSessionId } from "./lib/session.svelte.js";
import {
  candidateChangeNote,
  readTrialCandidate,
  type TrialCandidateView,
  trialCandidateErrorText,
} from "./lib/trial_candidate.js";
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
  readonly sessionId: string;
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
    typeof item.sessionId === "string" &&
    item.sessionId.length > 0 &&
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

/** Approval decision is about this run, not raw wire values: local time and
 * whole seconds/KiB. Unparseable values fall back to the stored string. */
function expiryText(value: string): string {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? value : new Date(ms).toLocaleString("ja-JP");
}

function capText(bytes: number): string {
  return `${Math.round(bytes / 1024)} KiB`;
}

function durationText(ms: number): string {
  return `${Math.round(ms / 1000)}秒`;
}

function proposalStatusLabel(status: TrialProposalStatus): string {
  switch (status) {
    case "staged":
      return "承認待ち";
    case "granted":
      return "承認済み";
    case "expired":
      return "期限切れ";
    case "invalidated":
      return "無効";
  }
}

/** Server expiry is enforced on approve; show it before the human clicks. */
function proposalExpired(proposal: TrialProposal): boolean {
  if (proposal.status !== "staged") return false;
  const ms = Date.parse(proposal.expiry);
  return !Number.isNaN(ms) && ms <= Date.now();
}

function effectiveStatusLabel(proposal: TrialProposal): string {
  return proposalExpired(proposal)
    ? "期限切れ"
    : proposalStatusLabel(proposal.status);
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
 * artifact are host-checked; bridge stderr diagnostics are host-observed.
 * Malformed bodies render as absent. */
interface TrialReport {
  readonly summary: string;
  readonly findings: readonly string[];
  readonly unresolved: readonly string[];
  readonly hostDiagnostics: readonly string[];
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

/** Adoption state attached to the trial detail (null before first attempt). */
interface TrialAdoption {
  readonly status: "pending" | "done" | "failed";
  readonly branch: string | null;
  readonly prUrl: string | null;
  readonly commitSha: string | null;
  readonly errorCode: string | null;
}

function readTrialAdoption(value: unknown): TrialAdoption | null {
  if (typeof value !== "object" || value === null) return null;
  const adoption = (value as Record<string, unknown>).adoption;
  if (adoption === null || adoption === undefined) return null;
  if (typeof adoption !== "object" || Array.isArray(adoption)) return null;
  const row = adoption as Record<string, unknown>;
  if (
    row.status !== "pending" &&
    row.status !== "done" &&
    row.status !== "failed"
  ) {
    return null;
  }
  const optionalString = (v: unknown): string | null =>
    typeof v === "string" ? v : null;
  return {
    status: row.status,
    branch: optionalString(row.branch),
    prUrl: optionalString(row.prUrl),
    commitSha: optionalString(row.commitSha),
    errorCode: optionalString(row.errorCode),
  };
}

function adoptionErrorText(code: string | null): string {
  switch (code) {
    case "adoption_disabled":
      return "この環境ではブランチとPRの作成は無効です";
    case "not_verified":
      return "検証済みの試行結果がないため作成できません";
    case "artifact_mismatch":
      return "確認した成果物と一致しません。試行をやり直してください";
    case "base_changed":
      return "基準リビジョンのファイルが変わりました。試行をやり直してください";
    case "branch_exists":
      return "同名のブランチが既に存在します";
    case "git_failed":
      return "Gitの操作に失敗しました";
    case "gh_failed":
      return "PRの作成に失敗しました（gh認証を確認してください）";
    default:
      return "ブランチとPRを作成できませんでした";
  }
}

const GUEST_PROVENANCE = "guest-reported-unattested";
const HOST_PROVENANCE = "host-checked";
const HOST_OBSERVED_PROVENANCE = "host-observed";

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
    prov.artifact !== HOST_PROVENANCE ||
    prov.hostDiagnostics !== HOST_OBSERVED_PROVENANCE
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
    hostDiagnostics: reportStrings(record.hostDiagnostics, 4).map((line) =>
      line.slice(0, 512),
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
/** Actionable queue (staged and not past expiry) vs. read-only history. */
const pendingProposals = $derived(
  proposals.filter(
    (proposal) => proposal.status === "staged" && !proposalExpired(proposal),
  ),
);
const pastProposals = $derived(
  proposals.filter(
    (proposal) => proposal.status !== "staged" || proposalExpired(proposal),
  ),
);
let statusText = $state("");
let detailVisible = $state(false);
/** Proposal whose decision summary is shown (web-only; null before select). */
let detailProposal = $state<TrialProposal | null>(null);
/** Outcome lines for a granted/consumed proposal, kept out of the summary. */
let detailOutcomeLines = $state<readonly string[]>([]);
let detailLines = $state<readonly string[]>([]);
let detailTitles = $state<readonly (string | undefined)[]>([]);
let opStatus = $state("");
let decisionVisible = $state(false);
let selected = $state<string | null>(null);
/** Owning session of the shown proposal (cross-session queue). */
let selectedSessionId = $state<string | null>(null);
/** The staged proposal is read-only; the human may widen it at approval. */
let selectedReadOnly = $state(false);
/** Widening needs literal paths: a pathless read-only trial cannot widen. */
let selectedPathCount = $state(0);
let allowWrite = $state(false);
let detailReport = $state<TrialReport | null>(null);
let candidateView = $state<TrialCandidateView | null>(null);
let candidateError = $state<string | null>(null);
let candidateLoading = $state(false);
let adoption = $state<TrialAdoption | null>(null);
let adoptionStatus = $state("");
let adoptionMutating = $state(false);
let mutating = $state(false);
let seq = 0;

// Staging form (native only): operator facts from GET /trial-profile, open
// session tasks from GET /tasks. readOnlyMode is always derived from the
// selected operation; requiredChecks is always the frozen mandatory set.
let profile = $state<TrialProfileFacts | null>(null);
let formVisible = $state(false);
let stageOpen = $state(false);
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
function current(mine: number): boolean {
  return seq === mine;
}

async function refreshList(): Promise<void> {
  seq += 1;
  const mine = seq;
  // Cross-session queue: self-loop proposals live in a fixed standing
  // session, not necessarily the session the reviewer is browsing.
  const listed = await fetchJson("/api/trials?limit=100");
  if (!current(mine)) return;
  if (listed.status === 404) {
    // Disabled config: fixed disabled state, no card.
    proposals = [];
    detailVisible = false;
    selected = null;
    selectedSessionId = null;
    detailProposal = null;
    detailOutcomeLines = [];
    detailLines = [];
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
    if (proposal.status === "staged" && !proposalExpired(proposal)) staged += 1;
  }
  statusText =
    staged > 0
      ? "承認待ちの試行の提案があります"
      : "承認待ちの試行の提案はありません";
  // Re-selecting the detail must not wipe an adoption failure message that
  // exists only in adoptionStatus (e.g. adoption_disabled: no durable row).
  // Auto-open the first staged proposal: the page's job is deciding on it.
  const kept = proposals.find((entry) => entry.id === selected);
  if (kept !== undefined) {
    await select(kept.id, kept.sessionId, true);
  } else {
    selected = null;
    selectedSessionId = null;
    detailVisible = false;
    detailProposal = null;
    const first = pendingProposals[0];
    if (first !== undefined) await select(first.id, first.sessionId);
  }
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
    const createdSession = (result.body as { sessionId?: unknown }).sessionId;
    stageOpen = false;
    await refreshList();
    if (typeof created === "string" && typeof createdSession === "string") {
      await select(created, createdSession);
      document
        .getElementById("trial-detail")
        ?.scrollIntoView({ block: "start" });
    }
  } finally {
    submitting = false;
  }
}

/** Select from a list below the detail and bring the detail back into view. */
async function openProposal(proposal: TrialProposal): Promise<void> {
  await select(proposal.id, proposal.sessionId);
  if (detailVisible) {
    document.getElementById("trial-detail")?.scrollIntoView({ block: "start" });
  }
}

async function select(
  proposalId: string,
  sessionId: string,
  preserveAdoptionStatus = false,
): Promise<void> {
  seq += 1;
  const mine = seq;
  const fetched = await fetchJson(
    `/api/sessions/${encodeURIComponent(sessionId)}/trials/${encodeURIComponent(proposalId)}`,
  );
  if (!current(mine)) return;
  if (fetched.status !== 200 || !isTrialProposal(fetched.body)) return;
  const proposal = fetched.body;
  const outcome = readTrialOutcome(fetched.body);
  const report = readTrialReport(fetched.body);
  detailReport = report;
  adoption = readTrialAdoption(fetched.body);
  if (!preserveAdoptionStatus) adoptionStatus = "";
  selected = proposal.id;
  selectedSessionId = proposal.sessionId;
  candidateView = null;
  candidateError = null;
  candidateLoading = report !== null && report.artifact !== null;
  if (candidateLoading) {
    const candidateFetched = await fetchJson(
      `/api/sessions/${encodeURIComponent(sessionId)}/trials/${encodeURIComponent(proposal.id)}/candidate`,
    );
    if (!current(mine)) return;
    candidateLoading = false;
    if (candidateFetched.status === 404) {
      candidateError = trialCandidateErrorText("candidate_unavailable");
    } else if (candidateFetched.status !== 200) {
      candidateError = "差分を取得できませんでした";
    } else {
      const mapped = readTrialCandidate(candidateFetched.body);
      if (mapped.available) {
        candidateView = mapped.view;
      } else {
        candidateError = trialCandidateErrorText(mapped.code);
      }
    }
  }
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
  detailProposal = proposal;
  detailOutcomeLines = trialOutcomeLines(outcome);
  const lines = [...model.detailLines];
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
  const expired = proposalExpired(proposal);
  opStatus = expired
    ? "期限切れの試行の提案です"
    : proposal.status === "staged"
      ? ""
      : model.statusText;
  decisionVisible = model.decisionVisible && !expired;
  // A fresh selection always starts at the staged mode.
  selectedReadOnly = proposal.readOnlyMode;
  selectedPathCount = proposal.literalPatchPaths.length;
  allowWrite = false;
  detailVisible = true;
}

/** Human click only: adopt the reviewed candidate. localOnly keeps the
 * commit on a LOCAL branch (no push, no PR); the PR click pushes it. */
async function adopt(localOnly = false): Promise<void> {
  const sessionId = selectedSessionId;
  const id = selected;
  const sha = detailReport?.artifact?.sha256 ?? null;
  if (
    sessionId === null ||
    id === null ||
    sha === null ||
    adoptionMutating ||
    !window.confirm(
      localOnly
        ? "確認した差分をローカルの新しいブランチにコミットします（push も PR も作りません）。続けますか？"
        : "確認した差分を GitHub の新しいブランチに push し、下書きPRを作成します。続けますか？",
    )
  ) {
    return;
  }
  adoptionMutating = true;
  adoptionStatus = localOnly
    ? "ローカルブランチに適用しています"
    : "ブランチとPRを作成しています";
  try {
    const result = await postJson(
      `/api/sessions/${encodeURIComponent(sessionId)}/trials/${encodeURIComponent(id)}/adopt`,
      localOnly
        ? { artifactSha256: sha, localOnly: true }
        : { artifactSha256: sha },
      randomUuid(),
    );
    if (
      result.status === 200 ||
      result.status === 201 ||
      result.status === 202
    ) {
      const mapped = readTrialAdoption({ adoption: result.body });
      adoption = mapped;
      if (mapped?.status === "done") {
        adoptionStatus =
          mapped.prUrl === null
            ? "ローカルブランチに適用しました"
            : "下書きPRを作成しました";
      } else if (mapped?.status === "pending") {
        adoptionStatus = "作成中です。しばらくしてから更新してください";
      } else {
        adoptionStatus = "作成状況を更新しました";
      }
    } else {
      const mapped = readTrialAdoption(result.body);
      adoption = mapped ?? adoption;
      const code = (result.body as { error?: { code?: unknown } })?.error?.code;
      adoptionStatus =
        (mapped?.errorCode ?? (typeof code === "string" ? code : null))
          ? adoptionErrorText(
              mapped?.errorCode ?? (typeof code === "string" ? code : null),
            )
          : "ブランチとPRを作成できませんでした";
    }
    await refreshList();
  } finally {
    adoptionMutating = false;
  }
}

async function approve(): Promise<void> {
  const sessionId = selectedSessionId;
  const id = selected;
  if (sessionId === null || id === null || mutating) return;
  mutating = true;
  try {
    const result = await postJson(
      `/api/sessions/${encodeURIComponent(sessionId)}/trials/${encodeURIComponent(id)}/approve`,
      allowWrite ? { allowWrite: true } : {},
      randomUuid(),
    );
    const message =
      result.status === 201
        ? "承認しました"
        : result.status === 409
          ? "他の変更がありました。一覧を更新しました"
          : "承認に失敗しました";
    await refreshList();
    // refreshList re-selects the proposal and resets opStatus to its status;
    // keep the action result the human just caused.
    opStatus = message;
  } finally {
    mutating = false;
  }
}

async function expire(): Promise<void> {
  const sessionId = selectedSessionId;
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
    const message =
      result.status === 200
        ? "承認しませんでした（破棄済み）"
        : "取り消しに失敗しました";
    await refreshList();
    // Keep the explicit rejection instead of the derived expiry status.
    opStatus = message;
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
  detailProposal = null;
  detailOutcomeLines = [];
  detailLines = [];
  detailTitles = [];
  detailReport = null;
  candidateView = null;
  candidateError = null;
  candidateLoading = false;
  adoption = null;
  adoptionStatus = "";
  adoptionMutating = false;
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

<ChatPage activePath="/trials" chatSurface={false}>
  {#snippet children()}
{#await import("./lib/AutonomyPausedBanner.svelte") then banner}
  <svelte:component this={banner.default} />
{/await}

<div class="trials-page">
<section id="trials" aria-label="試行の提案" class="feature-panel">
  <h2>試行の提案</h2>
  <p class="trial-intro">
    companionからの試行提案を承認または拒否します。承認すると、表示された内容で1回だけ隔離環境で実行されます。本番への反映やタスク・目的の完了は行いません。
  </p>
  <p id="trial-status" aria-live="polite">{statusText}</p>
  {#if formVisible && profile !== null}
    <details id="trial-stage" bind:open={stageOpen}>
      <summary>自分で試行を提案する（通常は不要）</summary>
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
    </details>
  {/if}
  <div id="trial-detail" hidden={!detailVisible}>
    {#if detailProposal !== null}
      {@const p = detailProposal}
      {@const canExpire = p.status === "staged" && p.workspaceAlias !== null}
      <section id="trial-decision" aria-label="承認の判断材料">
        <h3>判断材料</h3>
        <p class="trial-decision-note">
          承認すると、この内容で<strong>1回だけ</strong>隔離環境で実行します。本番への反映、タスク・目的の完了は行いません。
        </p>
        <dl id="trial-decision-facts">
          <dt>状態</dt>
          <dd>{effectiveStatusLabel(p)}</dd>
          <dt>目的</dt>
          <dd>{p.objective}</dd>
          <dt>操作</dt>
          <dd>
            {trialOperation(p.operation)?.label ?? p.operation}（{p.readOnlyMode
              ? "読み取り専用"
              : "ワークスペースを変更"}）
          </dd>
          <dt>作業場所</dt>
          <dd>
            {p.workspaceAlias ?? "未束縛（この提案は承認できません）"}
          </dd>
          <dt>対象パス</dt>
          <dd>
            {#if p.literalPatchPaths.length === 0}
              指定なし（読み取りのみ）
            {:else}
              <ul>
                {#each p.literalPatchPaths as path (path)}
                  <li><code>{path}</code></li>
                {/each}
              </ul>
            {/if}
          </dd>
          <dt>受け入れ条件</dt>
          <dd>
            <ul>
              {#each p.acceptance as item, index (index)}
                <li>{item}</li>
              {/each}
            </ul>
          </dd>
          <dt>実行される必須チェック</dt>
          <dd>{p.requiredChecks.join(", ")}</dd>
          <dt>制限</dt>
          <dd>
            タイムアウト {durationText(p.timeoutMs)}・出力上限 {capText(
              p.maxOutputBytes,
            )}・期限 {expiryText(p.expiry)}
          </dd>
          <dt>外部データ</dt>
          <dd>
            {p.possibleExternalDataConsent
              ? "取り込みに同意済み"
              : "取り込まない"}
          </dd>
        </dl>
        {#if selectedReadOnly && selectedPathCount > 0 && decisionVisible}
          <label for="trial-allow-write">
            <input
              id="trial-allow-write"
              type="checkbox"
              bind:checked={allowWrite}
              disabled={mutating}
            />
            この試行で編集を許可する（読み取り専用 → 書き込み）
          </label>
        {/if}
        <div id="trial-decision-actions">
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
            title="この提案を承認せずに破棄します"
            disabled={!canExpire || mutating}
            onclick={() => void expire()}
          >
            承認しない
          </button>
        </div>
        <p id="trial-op-status" aria-live="polite">{opStatus}</p>
        {#if detailOutcomeLines.length > 0}
          <ul id="trial-outcome">
            {#each detailOutcomeLines as line, index (index)}
              <li>{line}</li>
            {/each}
          </ul>
        {/if}
      </section>
    {/if}
    <details id="trial-wire-detail">
      <summary>技術的な詳細</summary>
      <pre id="trial-detail-body">
        {#each detailLines as line, i}
          <div title={detailTitles[i]}>{line}</div>
        {/each}
      </pre>
    </details>
    {#if candidateLoading}
      <p id="trial-candidate-loading">差分を読み込んでいます</p>
    {/if}
    {#if candidateError !== null}
      <p id="trial-candidate-error">{candidateError}</p>
    {/if}
    {#if candidateView !== null}
      <section id="trial-candidate" aria-label="試行の差分">
        <h3>差分</h3>
        <ul id="trial-candidate-files">
          {#each candidateView.changes as change (change.path)}
            <li>
              {change.path}: {candidateChangeNote(change)}（{change.size} バイト）
            </li>
          {/each}
        </ul>
        {#if candidateView.truncated}
          <p id="trial-candidate-truncated">差分は上限に達したため省略されています</p>
        {/if}
        <pre id="trial-candidate-diff">{candidateView.diff}</pre>
        {#if adoption === null || adoption.prUrl === null}
          <button
            id="trial-adopt-button"
            type="button"
            disabled={!detailReport?.verified || adoptionMutating}
            onclick={() => void adopt(false)}
          >
            ブランチとPRを作成（下書き）
          </button>
          <button
            id="trial-apply-button"
            type="button"
            disabled={!detailReport?.verified || adoptionMutating}
            onclick={() => void adopt(true)}
          >
            ローカルブランチに適用
          </button>
          <p id="trial-adopt-status" aria-live="polite">{adoptionStatus}</p>
        {/if}
        {#if adoption?.status === "done" && adoption.prUrl === null}
          <p id="trial-apply-note">
            ローカルブランチに適用済み（{adoption.branch ?? ""}）
          </p>
        {/if}
        {#if adoption?.status === "failed" && adoptionStatus === ""}
          <p id="trial-adoption-result">
            {adoptionErrorText(adoption.errorCode)}
          </p>
        {/if}
      </section>
    {/if}
    {#if adoption?.status === "done"}
      <section id="trial-adoption" aria-label="ブランチと下書きPR">
        <h3>ブランチと下書きPR</h3>
        <p id="trial-adoption-result">
          ブランチ:
          {#if adoption.branch !== null}
            <code>{adoption.branch}</code>
          {:else}
            作成済み
          {/if}
        </p>
        {#if adoption.commitSha !== null}
          <p id="trial-adoption-commit">コミット: {adoption.commitSha}</p>
        {/if}
        <p id="trial-adoption-pr">
          下書きPR:
          {#if adoption.prUrl !== null}
            <a href={adoption.prUrl}>{adoption.prUrl}</a>
          {:else}
            作成済み
          {/if}
        </p>
      </section>
    {/if}
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
        {#if report.hostDiagnostics.length > 0}
          <h3>ホスト診断</h3>
          <p id="trial-report-host-provenance">ホスト観測（未改変の生出力ではありません）</p>
          <ul id="trial-report-host-diagnostics">
            {#each report.hostDiagnostics as item, index (index)}
              <li>{item}</li>
            {/each}
          </ul>
        {/if}
      </section>
    {/if}
  </div>
  {#if pendingProposals.length > 0}
    <h3>承認待ち</h3>
    <ul id="trial-list">
      {#each pendingProposals as proposal (proposal.id)}
        <li>
          <button
            type="button"
            onclick={() => void openProposal(proposal)}
          >
            {trialOperation(proposal.operation)?.label ?? proposal.operation}
            [{proposal.workspaceAlias ?? "未束縛"}] {proposal.objective}
          </button>
        </li>
      {/each}
    </ul>
  {:else}
    <p id="trial-list-empty">承認待ちの提案はありません</p>
  {/if}
  {#if pastProposals.length > 0}
    <details id="trial-history">
      <summary>過去の提案（{pastProposals.length}件）</summary>
      <ul id="trial-history-list">
        {#each pastProposals as proposal (proposal.id)}
          <li>
            <button
              type="button"
              onclick={() => void openProposal(proposal)}
            >
              {trialOperation(proposal.operation)?.label ?? proposal.operation}
              [{proposal.workspaceAlias ?? "未束縛"}] {proposal.objective}
              （{effectiveStatusLabel(proposal)}）
            </button>
          </li>
        {/each}
      </ul>
    </details>
  {/if}
</section>
</div>
  {/snippet}
</ChatPage>

<style>
  /* The shared shell strips feature-panel padding on chat-hidden routes. */
  .trials-page {
    padding: 1rem;
  }
  .trial-intro {
    max-width: 60ch;
  }
  #trial-decision-facts {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: 0.35rem 1rem;
  }
  #trial-decision-facts dt {
    font-weight: 600;
  }
  #trial-decision-facts dd {
    margin: 0;
  }
  #trial-decision-facts ul {
    margin: 0;
    padding-left: 1.2rem;
  }
  #trial-decision-actions {
    display: flex;
    gap: 0.5rem;
    margin: 0.75rem 0;
  }
</style>
