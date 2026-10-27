// Human-only confirmation of chat-adopted goals (pure UI mapping).
//
// A goal adopted from a conversation proposal is stored non-explicit with
// source_kind='self'; it can never authorize a trial until a person
// presses the confirmation button. Everything here is rendering logic for
// that single HTTP route (POST /api/sessions/:sid/goals/:gid/confirm) —
// no model tool and no autonomy path exists for it.

export const UNCONFIRMED_GOAL_BADGE = "会話から採用（未確認）";
export const CONFIRM_GOAL_LABEL = "自分の目的として確定";
export const TRIAL_GOAL_AUTHORITY_HINT =
  "この作業の目的は会話から採用した未確認の目的です。「タスク・目的」で「自分の目的として確定」を押すと試行を提案できます。";

export interface GoalConfirmationFields {
  readonly explicit?: unknown;
  readonly status?: unknown;
  readonly sourceKind?: unknown;
  readonly kind?: unknown;
}

/** True only for an ACTIVE goal that still lacks explicit user consent. */
export function isUnconfirmedGoal(goal: GoalConfirmationFields): boolean {
  return (
    goal.kind === "goal" && goal.status === "active" && goal.explicit !== true
  );
}

/** True for a goal that was adopted from a chat proposal (badge). */
export function isConversationAdoptedGoal(
  goal: GoalConfirmationFields,
): boolean {
  return goal.sourceKind === "self" && isUnconfirmedGoal(goal);
}

export function goalConfirmPath(sessionId: string, goalId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/goals/${encodeURIComponent(goalId)}/confirm`;
}

/** Hint text for the trial stage form; null when authority is not blocked. */
export function trialGoalAuthorityHint(
  parentGoal: GoalConfirmationFields | null | undefined,
): string | null {
  if (parentGoal === null || parentGoal === undefined) return null;
  return isUnconfirmedGoal(parentGoal) ? TRIAL_GOAL_AUTHORITY_HINT : null;
}
