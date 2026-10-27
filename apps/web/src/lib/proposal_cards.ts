// Chat proposal cards: pure state mapping for conversation proposals
// (purpose.propose / task.propose -> conversation_proposals) and trial
// proposals (trial.propose -> trial_proposals) staged by runs owned by the
// current chat session.
//
// Rendering only: every decision stays an explicit human click, and the
// dedicated Proposals/Trials pages remain the full review surface. This
// module never fetches or mutates anything, so it can be unit-tested
// without a DOM.
import { type TrialProposalInput, trialProposalModel } from "./reducer.js";

export type ChatProposalSource = "conversation" | "trial";

/** Minimal structural shape of one conversation proposal list item. */
export interface ConversationProposalItem {
  readonly id: string;
  readonly target?: string | null;
  readonly status: string;
  readonly version: number;
  readonly sourceQuote?: string | null;
  readonly interpretation?: string | null;
  readonly sourceRunId?: string | null;
  /** Staged parent purpose for a `task` target (never auto-picked). */
  readonly parentPurposeId?: string | null;
  /** Frozen parent version the task draft pinned at staging time. */
  readonly expectedParentVersion?: number | null;
}

/**
 * Readonly snapshot of the staged parent purpose, fetched from the same
 * purpose endpoint the Proposals panel uses. Only the fields needed to
 * label the card and flag version/status drift are kept.
 */
export interface ParentPurposeSnapshot {
  readonly statement: string;
  readonly version: number;
  readonly status: string;
}

/** Minimal structural shape of one trial proposal list item. */
export interface TrialProposalItem {
  readonly id: string;
  readonly status: string;
  readonly objective?: string | null;
  /** Frozen permission snapshot from the trial list API. Absent/malformed
   * fields fail closed: no approval without a reviewable snapshot. */
  readonly acceptance?: readonly string[];
  readonly literalPatchPaths?: readonly string[];
  readonly operation?: string;
  readonly readOnlyMode?: boolean;
  readonly expiry?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly requiredChecks?: readonly string[];
  readonly workspaceAlias?: string | null;
  readonly profile?: {
    readonly configFingerprint: string;
    readonly sourceRevision: string;
  } | null;
  readonly possibleExternalDataConsent?: boolean;
  /** Fixed worker-outcome summary from the list API (terminal rows). */
  readonly outcome?: {
    readonly status?: unknown;
    readonly authorized?: unknown;
    readonly summary?: unknown;
  } | null;
  /** Bounded sealed-trial report summary (terminal rows). */
  readonly reportSummary?: string | null;
}

export interface ChatProposalCardView {
  readonly key: string;
  readonly source: ChatProposalSource;
  readonly proposalId: string;
  /** 目的 / タスク / 試行 */
  readonly kindLabel: string;
  /** Interpretation (conversation) or objective (trial). */
  readonly heading: string;
  /** The human quote the conversation proposal was inferred from. */
  readonly quote: string;
  readonly status: string;
  /** CAS version for the accept/reject body; 0 for trials. */
  readonly version: number;
  readonly canAccept: boolean;
  readonly canReject: boolean;
  readonly canApprove: boolean;
  readonly canExpire: boolean;
  /** Frozen trial permission lines shown before approval (empty for
   * conversation proposals / incomplete snapshots). */
  readonly detailLines: readonly string[];
  /** Parent purpose line for a task card (empty for purpose/trial cards). */
  readonly parentLine: string;
  /** Staged parent purpose id (null unless the target is a task). */
  readonly parentPurposeId: string | null;
  /** True only when the staged parent title was resolved; `canAccept` for a
   * task card is false while this is false (fail closed). */
  readonly parentResolved: boolean;
  /** One-line terminal summary (empty for still-actionable cards). */
  readonly summaryLine: string;
  /** Link to the full /trials detail surface (empty for staged cards). */
  readonly detailHref: string;
}

export const CONVERSATION_PROPOSAL_ACTIONS = {
  accept: "採用する",
  reject: "見送る",
} as const;

export const TRIAL_PROPOSAL_ACTIONS = {
  approve: "承認する",
  expire: "取り消す",
} as const;

function clean(value: string | null | undefined): string {
  return typeof value === "string" ? value : "";
}

function conversationKindLabel(item: ConversationProposalItem): string {
  // `target` is the durable purpose/task discriminator; the draft kind is a
  // presentation detail and never widens the label beyond 目的 or タスク.
  return item.target === "task" ? "タスク" : "目的";
}

/** Exact staged parent id, or null when absent/malformed. */
function stagedParentId(item: ConversationProposalItem): string | null {
  return typeof item.parentPurposeId === "string" &&
    item.parentPurposeId.length > 0
    ? item.parentPurposeId
    : null;
}

/**
 * Parent line for a `task` card, mirroring the Proposals panel wording:
 * the STAGED pinned version is shown, never the fetched current version as
 * the referenced one, and current-version/inactive drift is flagged.
 * `resolved` is false until a well-formed snapshot for the staged parent
 * is available, so the accept button stays disabled (fail closed).
 */
export function taskParentLine(
  item: ConversationProposalItem,
  parents: ReadonlyMap<string, ParentPurposeSnapshot | null>,
): { readonly line: string; readonly resolved: boolean } {
  const parentId = stagedParentId(item);
  if (parentId === null) {
    return { line: "親の目的：なし（異常）", resolved: false };
  }
  const expected = item.expectedParentVersion;
  if (typeof expected !== "number") {
    return { line: "親の目的の版を確認できません", resolved: false };
  }
  if (!parents.has(parentId)) {
    return { line: "親の目的を確認しています…", resolved: false };
  }
  const snapshot = parents.get(parentId);
  if (snapshot === undefined || snapshot === null) {
    return {
      line: "親の目的を確認できません（再読み込みしてください）",
      resolved: false,
    };
  }
  let line = `親の目的（採用時に再確認・変更不可）: ${snapshot.statement}（提案時の版 ${String(expected)}／現在 ${String(snapshot.version)}）`;
  if (snapshot.version !== expected) {
    line += "⚠ 現在の版と一致しません（採用時に競合します）";
  }
  if (snapshot.status !== "active") {
    line += `⚠ 親は現在${snapshot.status}です`;
  }
  return { line, resolved: true };
}

/**
 * Pending conversation proposals whose source run belongs to the current
 * session projection. Proposals from runs outside the loaded/active run set
 * are deliberately hidden: they belong to another visit of this session and
 * stay available on the Proposals page.
 *
 * `parents` maps a staged parent purpose id to its readonly snapshot (null
 * when the lookup failed). A `task` card without a resolved parent keeps
 * 採用する disabled: the user must be able to see which purpose the task
 * would be attached to before accepting.
 */
export function conversationProposalCards(
  items: readonly ConversationProposalItem[],
  runIds: ReadonlySet<string>,
  parents: ReadonlyMap<string, ParentPurposeSnapshot | null> = new Map(),
): ChatProposalCardView[] {
  const cards: ChatProposalCardView[] = [];
  for (const item of items) {
    if (item.status !== "pending") continue;
    if (typeof item.sourceRunId !== "string") continue;
    if (!runIds.has(item.sourceRunId)) continue;
    const isTask = item.target === "task";
    const parent = isTask
      ? taskParentLine(item, parents)
      : { line: "", resolved: true };
    cards.push({
      key: `conversation:${item.id}`,
      source: "conversation",
      proposalId: item.id,
      kindLabel: conversationKindLabel(item),
      heading: clean(item.interpretation),
      quote: clean(item.sourceQuote),
      status: item.status,
      version: item.version,
      canAccept: item.status === "pending" && parent.resolved,
      canReject: item.status === "pending",
      canApprove: false,
      canExpire: false,
      detailLines: [],
      parentLine: parent.line,
      parentPurposeId: isTask ? stagedParentId(item) : null,
      parentResolved: parent.resolved,
      summaryLine: "",
      detailHref: "",
    });
  }
  return cards;
}

/**
 * Staged trial proposals of this session. Trial proposals carry no run
 * provenance column, so the session-scoped list is the narrowest available
 * source; only still-staged rows are actionable in chat.
 */
export function trialProposalCards(
  items: readonly TrialProposalItem[],
): ChatProposalCardView[] {
  const cards: ChatProposalCardView[] = [];
  for (const item of items) {
    if (item.status !== "staged") {
      // Terminal trials stay visible as a one-line card that links to the
      // full /trials detail (report + host checks + guest report). No action
      // is offered: only the detail surface carries the bounded report.
      if (
        item.status !== "granted" &&
        item.status !== "expired" &&
        item.status !== "invalidated"
      ) {
        continue;
      }
      const reportSummary =
        typeof item.reportSummary === "string" ? item.reportSummary : "";
      const outcomeSummary =
        typeof item.outcome?.summary === "string" ? item.outcome.summary : "";
      const summaryLine =
        reportSummary !== ""
          ? reportSummary
          : outcomeSummary !== ""
            ? outcomeSummary
            : `結果: ${item.status}`;
      cards.push({
        key: `trial:${item.id}`,
        source: "trial",
        proposalId: item.id,
        kindLabel: "試行",
        heading: clean(item.objective),
        quote: "",
        status: item.status,
        version: 0,
        canAccept: false,
        canReject: false,
        canApprove: false,
        canExpire: false,
        detailLines: [],
        parentLine: "",
        parentPurposeId: null,
        parentResolved: true,
        summaryLine,
        detailHref: "/trials",
      });
      continue;
    }
    const input = trialProposalInput(item);
    const model = input === null ? null : trialProposalModel(input, true);
    cards.push({
      key: `trial:${item.id}`,
      source: "trial",
      proposalId: item.id,
      kindLabel: "試行",
      heading: clean(item.objective),
      quote: "",
      status: item.status,
      version: 0,
      canAccept: false,
      canReject: false,
      // Approval requires the full frozen permission snapshot, so the
      // operator always sees mode/paths/workspace/consent first (review).
      canApprove: model?.decisionVisible ?? false,
      canExpire: true,
      detailLines: model?.detailLines ?? [],
      parentLine: "",
      parentPurposeId: null,
      parentResolved: true,
      summaryLine: "",
      detailHref: "",
    });
  }
  return cards;
}

/** Total parse of the list item into the shared trial review input. */
function trialProposalInput(
  item: TrialProposalItem,
): TrialProposalInput | null {
  if (
    item.status !== "staged" ||
    typeof item.objective !== "string" ||
    !Array.isArray(item.acceptance) ||
    !Array.isArray(item.literalPatchPaths) ||
    typeof item.operation !== "string" ||
    typeof item.readOnlyMode !== "boolean" ||
    typeof item.expiry !== "string" ||
    typeof item.timeoutMs !== "number" ||
    typeof item.maxOutputBytes !== "number" ||
    !Array.isArray(item.requiredChecks) ||
    typeof item.possibleExternalDataConsent !== "boolean" ||
    !(item.workspaceAlias === null || typeof item.workspaceAlias === "string")
  ) {
    return null;
  }
  const profile = item.profile;
  if (
    profile !== null &&
    (typeof profile !== "object" ||
      profile === undefined ||
      typeof profile.configFingerprint !== "string" ||
      typeof profile.sourceRevision !== "string")
  ) {
    return null;
  }
  return {
    status: "staged",
    objective: item.objective,
    acceptance: item.acceptance.filter(
      (entry): entry is string => typeof entry === "string",
    ),
    literalPatchPaths: item.literalPatchPaths.filter(
      (entry): entry is string => typeof entry === "string",
    ),
    operation: item.operation,
    readOnlyMode: item.readOnlyMode,
    expiry: item.expiry,
    timeoutMs: item.timeoutMs,
    maxOutputBytes: item.maxOutputBytes,
    requiredChecks: item.requiredChecks.filter(
      (entry): entry is string => typeof entry === "string",
    ),
    workspaceAlias: item.workspaceAlias,
    profile: profile ?? null,
    possibleExternalDataConsent: item.possibleExternalDataConsent,
  };
}

/**
 * Fixed Japanese failure text for a card decision. A 409 is the CAS
 * ("state moved under you") case and always asks for a reload; other
 * failures stay generic and never leak server internals.
 */
export function proposalCardErrorText(status: number): string {
  if (status === 409) return "状態が変わりました。再読み込みしてください";
  if (status === 404) return "対象が見つかりません。再読み込みしてください";
  return "操作に失敗しました。もう一度お試しください";
}

/**
 * Frozen decision command for a proposal card. While the outcome of a POST is
 * uncertain (network failure / 5xx), a retry MUST reuse both the
 * Idempotency-Key and the original request body: re-keying or re-reading the
 * staged version would let the server apply the decision twice or hash a
 * different body under the same key.
 */
export interface FrozenProposalDecision<Body> {
  /** proposalId + action — the freeze identity. */
  readonly id: string;
  readonly key: string;
  readonly body: Body;
}

/** Reuse the frozen command for the same (proposalId, action), otherwise
 * freeze a new key + body. A different action/proposal starts a new command. */
export function frozenProposalDecision<Body>(
  pending: FrozenProposalDecision<Body> | null,
  id: string,
  body: Body,
  key: string,
): FrozenProposalDecision<Body> {
  return pending?.id === id ? pending : { id, key, body };
}

/**
 * Latest-request guard for async proposal list refreshes. A run-completion
 * refresh can overlap a card decision's refresh; only the newest call may
 * apply its (older) list. `invalidate()` drops everything in flight, e.g.
 * when the chat session is switched.
 */
export function createProposalSyncGuard(): {
  next: () => number;
  isCurrent: (seq: number) => boolean;
  invalidate: () => void;
} {
  let current = 0;
  return {
    next: () => {
      current += 1;
      return current;
    },
    isCurrent: (seq: number) => seq === current,
    invalidate: () => {
      current += 1;
    },
  };
}
