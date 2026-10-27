import { describe, expect, it } from "vitest";
import {
  CONFIRM_GOAL_LABEL,
  goalConfirmPath,
  isConversationAdoptedGoal,
  isUnconfirmedGoal,
  trialGoalAuthorityHint,
  UNCONFIRMED_GOAL_BADGE,
} from "../src/lib/goal_confirm.js";

describe("goal confirmation mapping", () => {
  it("badges an adopted, still-unconfirmed goal", () => {
    const goal = {
      explicit: false,
      status: "active",
      sourceKind: "self",
      kind: "goal",
    };
    expect(isConversationAdoptedGoal(goal)).toBe(true);
    expect(isUnconfirmedGoal(goal)).toBe(true);
    expect(UNCONFIRMED_GOAL_BADGE).toBe("会話から採用（未確認）");
    expect(CONFIRM_GOAL_LABEL).toBe("自分の目的として確定");
  });

  it("hides badge/button once explicit or terminal", () => {
    expect(
      isConversationAdoptedGoal({
        explicit: true,
        status: "active",
        sourceKind: "user",
        kind: "goal",
      }),
    ).toBe(false);
    expect(
      isUnconfirmedGoal({
        explicit: false,
        status: "revoked",
        sourceKind: "self",
        kind: "goal",
      }),
    ).toBe(false);
  });

  it("offers no button for non-goals or unknown statuses", () => {
    expect(
      isUnconfirmedGoal({
        explicit: false,
        status: "active",
        sourceKind: "self",
        kind: "constraint",
      }),
    ).toBe(false);
    expect(
      isUnconfirmedGoal({
        explicit: false,
        status: "held",
        sourceKind: "self",
        kind: "goal",
      }),
    ).toBe(false);
    expect(isUnconfirmedGoal({ explicit: false })).toBe(false);
    expect(
      isConversationAdoptedGoal({
        explicit: false,
        status: "active",
        sourceKind: "self",
        kind: "preference",
      }),
    ).toBe(false);
  });

  it("targets the human-only confirm route", () => {
    expect(goalConfirmPath("s-1", "g/2")).toBe(
      "/api/sessions/s-1/goals/g%2F2/confirm",
    );
  });

  it("hints at the confirm button for a non-explicit parent goal", () => {
    expect(
      trialGoalAuthorityHint({
        explicit: false,
        status: "active",
        sourceKind: "self",
        kind: "goal",
      }),
    ).toContain("自分の目的として確定");
    expect(
      trialGoalAuthorityHint({
        explicit: true,
        status: "active",
        sourceKind: "user",
        kind: "goal",
      }),
    ).toBeNull();
    expect(trialGoalAuthorityHint(null)).toBeNull();
  });
});
