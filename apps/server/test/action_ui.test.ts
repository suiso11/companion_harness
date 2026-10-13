// C22 approval-UX view contract: the pure card model the browser client
// renders from the ACTUAL proposals/execution APIs. No DOM, no network.
//
// The card is the only path to an external write, so these tests pin the
// safety-relevant mapping exactly: controls exist only for a pending,
// unexpired proposal (a stale card can never approve), Stop exists only
// before the committed external marker, and receipts render real outcomes
// (never a "stopped" claim for a write that left the process).

import { describe, expect, it } from "vitest";
import {
  actionCardModel,
  actionDecisionIntentText,
  actionErrorCodeText,
  type ActionCardInput,
  parseCancelRunStatus,
  receiptOutcomeText,
} from "../src/ui/reducer.js";

const BASE: ActionCardInput = {
  status: "pending",
  preview: "pregym",
  start: "2026-01-01T09:00:00Z",
  end: "2026-01-01T10:00:00Z",
  expiresAt: 1_000_000,
  now: 900_000,
  executionStatus: null,
  markerCommitted: false,
  cancellable: false,
  receiptOutcome: null,
  receiptSummary: null,
};

describe("C22 action card model", () => {
  it("shows the decision controls only for a pending unexpired proposal", () => {
    expect(actionCardModel(BASE).decisionVisible).toBe(true);
  });

  it("hides the controls for a decided proposal", () => {
    expect(actionCardModel({ ...BASE, status: "approved" }).decisionVisible).toBe(
      false,
    );
    expect(actionCardModel({ ...BASE, status: "rejected" }).decisionVisible).toBe(
      false,
    );
  });

  it("never executes an expired card (client deadline guard)", () => {
    const model = actionCardModel({ ...BASE, now: BASE.expiresAt });
    expect(model.decisionVisible).toBe(false);
    expect(model.expired).toBe(true);
    expect(model.outcomeText).toContain("期限");
  });

  it("maps real execution progress", () => {
    for (const status of ["queued", "preflight", "executing"] as const) {
      const model = actionCardModel({
        ...BASE,
        status: "approved",
        executionStatus: status,
        markerCommitted: status === "executing",
        cancellable: status !== "executing",
      });
      expect(model.progressText.length).toBeGreaterThan(0);
      expect(model.outcomeText).toBe("");
    }
  });

  it("offers Stop only before the committed external marker", () => {
    expect(
      actionCardModel({
        ...BASE,
        status: "approved",
        executionStatus: "executing",
        markerCommitted: false,
        cancellable: true,
      }).stopVisible,
    ).toBe(true);
    // After the marker the external write already left this process.
    expect(
      actionCardModel({
        ...BASE,
        status: "approved",
        executionStatus: "executing",
        markerCommitted: true,
        cancellable: false,
      }).stopVisible,
    ).toBe(false);
  });

  it("hides Stop for a terminal execution", () => {
    expect(
      actionCardModel({
        ...BASE,
        status: "approved",
        executionStatus: "succeeded",
        receiptOutcome: "succeeded",
      }).stopVisible,
    ).toBe(false);
  });

  it("renders the real receipt outcome, never a stopped claim", () => {
    expect(
      actionCardModel({
        ...BASE,
        status: "approved",
        executionStatus: "succeeded",
        receiptOutcome: "succeeded",
      }).outcomeText,
    ).toBe(receiptOutcomeText("succeeded"));
    for (const outcome of [
      "succeeded_unverified",
      "blocked_stale",
      "failed",
      "unknown",
    ] as const) {
      const text = receiptOutcomeText(outcome);
      expect(text).not.toBe("");
      expect(text).toContain("確認");
      expect(text).not.toContain("停止");
    }
    expect(receiptOutcomeText(null)).toBe("");
  });

  it("renders blocked_stale as not executed", () => {
    expect(receiptOutcomeText("blocked_stale")).toContain("更新しませんでした");
  });

  it("renders the pre-marker cancel as a not-executed fixed code", () => {
    expect(actionErrorCodeText("action_cancelled_before_write")).toBe(
      "更新は実施していません",
    );
    expect(actionErrorCodeText(null)).toBe("");
  });

  it("projects deterministic history intent for both decision variants", () => {
    expect(actionDecisionIntentText("action_rejection", null)).toBe(
      "日程変更の案を却下しました",
    );
    expect(actionDecisionIntentText("action_approval", null)).toBe(
      "日程変更を承認しました",
    );
    expect(actionDecisionIntentText("action_approval", "blocked_stale")).toContain(
      "承認",
    );
    expect(actionDecisionIntentText("action_approval", "blocked_stale")).toContain(
      "更新しませんでした",
    );
  });

  it("parses the actual cancel run status for the stop-claim gate", () => {
    // ONLY a `cancelled` terminal may claim the stop; every other real
    // status (a live accept or a terminal race loss) must refresh instead.
    expect(
      parseCancelRunStatus({
        run: { id: "00000000-0000-4000-8000-000000000000", status: "cancelled" },
      }),
    ).toBe("cancelled");
    for (const status of [
      "queued",
      "running",
      "cancel_requested",
      "completed",
      "failed",
      "abandoned",
    ]) {
      expect(
        parseCancelRunStatus({
          run: { id: "00000000-0000-4000-8000-000000000000", status },
        }),
      ).toBe(status);
    }
    // Malformed bodies fail closed (null = refresh, never a stop claim).
    for (const bad of [
      null,
      undefined,
      {},
      { run: null },
      { run: { id: "00000000-0000-4000-8000-000000000000" } },
      { run: { status: 200 } },
      "cancelled",
    ]) {
      expect(parseCancelRunStatus(bad)).toBeNull();
    }
  });
});