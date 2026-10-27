// Chat proposal cards: pure state mapping for conversation proposals
// (purpose.propose / task.propose -> conversation_proposals) and trial
// proposals (trial.propose -> trial_proposals) staged by runs owned by the
// current chat session.
//
// Rendering only: every decision stays an explicit human click, and the
// dedicated Proposals/Trials pages remain the full review surface. This
// module never fetches or mutates anything, so it can be unit-tested
// without a DOM.

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
}

/** Minimal structural shape of one trial proposal list item. */
export interface TrialProposalItem {
  readonly id: string;
  readonly status: string;
  readonly objective?: string | null;
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

/**
 * Pending conversation proposals whose source run belongs to the current
 * session projection. Proposals from runs outside the loaded/active run set
 * are deliberately hidden: they belong to another visit of this session and
 * stay available on the Proposals page.
 */
export function conversationProposalCards(
  items: readonly ConversationProposalItem[],
  runIds: ReadonlySet<string>,
): ChatProposalCardView[] {
  const cards: ChatProposalCardView[] = [];
  for (const item of items) {
    if (item.status !== "pending") continue;
    if (typeof item.sourceRunId !== "string") continue;
    if (!runIds.has(item.sourceRunId)) continue;
    cards.push({
      key: `conversation:${item.id}`,
      source: "conversation",
      proposalId: item.id,
      kindLabel: conversationKindLabel(item),
      heading: clean(item.interpretation),
      quote: clean(item.sourceQuote),
      status: item.status,
      version: item.version,
      canAccept: item.status === "pending",
      canReject: item.status === "pending",
      canApprove: false,
      canExpire: false,
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
    if (item.status !== "staged") continue;
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
      canApprove: true,
      canExpire: true,
    });
  }
  return cards;
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
