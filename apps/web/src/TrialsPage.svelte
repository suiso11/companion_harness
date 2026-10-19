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
import { type TrialProposalStatus, trialProposalModel } from "./lib/reducer.js";

const LS_SESSION = "ch.sessionId";

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

function readSession(): string | null {
  try {
    return localStorage.getItem(LS_SESSION);
  } catch {
    return null;
  }
}

let proposals = $state<TrialProposal[]>([]);
let statusText = $state("");
let detailVisible = $state(false);
let detailLines = $state<readonly string[]>([]);
let detailTitles = $state<readonly (string | undefined)[]>([]);
let opStatus = $state("");
let decisionVisible = $state(false);
let selected = $state<string | null>(null);
let mutating = $state(false);
let seq = 0;

/** Stale-response guard: only the latest generation may render. */
function current(mine: number, sessionId: string | null): boolean {
  return seq === mine && readSession() === sessionId;
}

async function refreshList(): Promise<void> {
  const sessionId = readSession();
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

async function select(proposalId: string): Promise<void> {
  const sessionId = readSession();
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
  const sessionId = readSession();
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
  const sessionId = readSession();
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

// Legacy boot: one refresh on mount (the panel is refreshed again after
// every explicit decision).
$effect(() => {
  void refreshList();
});
</script>

<svelte:head>
  <title>試行の提案 · Companion Harness</title>
</svelte:head>

<section id="trials" aria-label="試行の提案" class="feature-panel">
  <h2>試行の提案</h2>
  <p id="trial-status" aria-live="polite">{statusText}</p>
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
