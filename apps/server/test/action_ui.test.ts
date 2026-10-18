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
  type ActionCardInput,
  actionCardModel,
  actionEvidenceButtons,
  composerState,
  isRetryableTurnKind,
  isStoredCitationLabel,
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
    expect(
      actionCardModel({ ...BASE, status: "approved" }).decisionVisible,
    ).toBe(false);
    expect(
      actionCardModel({ ...BASE, status: "rejected" }).decisionVisible,
    ).toBe(false);
  });

  it("never executes an expired card (client deadline guard)", () => {
    const model = actionCardModel({ ...BASE, now: BASE.expiresAt });
    expect(model.decisionVisible).toBe(false);
    expect(model.expired).toBe(true);
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
    // Behavior predicate only (no exact wording pin): every terminal
    // outcome renders a non-empty outcome distinct from any stop claim.
    const succeeded = actionCardModel({
      ...BASE,
      status: "approved",
      executionStatus: "succeeded",
      receiptOutcome: "succeeded",
    }).outcomeText;
    expect(succeeded).not.toBe("");
    expect(succeeded).not.toContain("停止");
    for (const outcome of [
      "succeeded_unverified",
      "blocked_stale",
      "failed",
      "unknown",
    ] as const) {
      const text = receiptOutcomeText(outcome);
      expect(text).not.toBe("");
      expect(text).not.toContain("停止");
    }
    expect(receiptOutcomeText(null)).toBe("");
  });

  it("offers the generic retry only for user_text Turns (decision Turns never re-execute)", () => {
    // The failure-only retry control (§16.6) stays available for ordinary
    // generation Turns, while both M5 decision kinds fail closed so a
    // failed/abandoned Action run can never be re-driven through it.
    expect(isRetryableTurnKind("user_text")).toBe(true);
    expect(isRetryableTurnKind("action_approval")).toBe(false);
    expect(isRetryableTurnKind("action_rejection")).toBe(false);
    for (const unknown of [undefined, null, "", "completed", 1, {}]) {
      expect(isRetryableTurnKind(unknown)).toBe(false);
    }
  });

  it("parses the actual cancel run status for the stop-claim gate", () => {
    // ONLY a `cancelled` terminal may claim the stop; every other real
    // status (a live accept or a terminal race loss) must refresh instead.
    expect(
      parseCancelRunStatus({
        run: {
          id: "00000000-0000-4000-8000-000000000000",
          status: "cancelled",
        },
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

  it("never offers Stop for a missing session while keeping Send disabled (P2 review)", () => {
    // Session creation failed (or boot still resolving): no run or
    // request exists, so Stop must stay hidden AND disabled — the old
    // `busy includes sessionId === null` fault showed an enabled Stop
    // precisely during the startup failure. Send stays disabled so an
    // early submit can never be silently dropped.
    const missing = composerState({
      activeRunId: null,
      sending: false,
      sessionId: null,
      actionBlocked: false,
    });
    expect(missing.sendDisabled).toBe(true);
    expect(missing.stopVisible).toBe(false);
    expect(missing.stopDisabled).toBe(true);
    // Idle with a session: everything enabled, no Stop.
    const idle = composerState({
      activeRunId: null,
      sending: false,
      sessionId: "s1",
      actionBlocked: false,
    });
    expect(idle.sendDisabled).toBe(false);
    expect(idle.stopVisible).toBe(false);
    expect(idle.stopDisabled).toBe(true);
    // A real run still offers Stop and disables Send.
    const running = composerState({
      activeRunId: "r1",
      sending: false,
      sessionId: "s1",
      actionBlocked: false,
    });
    expect(running.sendDisabled).toBe(true);
    expect(running.stopVisible).toBe(true);
    expect(running.stopDisabled).toBe(false);
  });
});

describe("M5 action evidence navigation policy", () => {
  const verifiedResult = {
    version: 2,
    text: "done",
    answer: {
      version: 1,
      parts: [{ text: "done", citations: ["r3"] }],
    },
  };

  it("accepts only structural session rN labels as evidence", () => {
    expect(isStoredCitationLabel("r1")).toBe(true);
    expect(isStoredCitationLabel("r12")).toBe(true);
    for (const bad of [
      null,
      undefined,
      "",
      "r0",
      "r01",
      "m1",
      "1",
      "r1 ",
      " r1",
      "http://x",
      "00000000-0000-4000-8000-000000000000",
    ]) {
      expect(isStoredCitationLabel(bad)).toBe(false);
    }
  });

  it("always offers BEFORE from the owned original label, even live or terminal-unverified", () => {
    // Live (no receipt yet): BEFORE only, never a fabricated AFTER.
    expect(
      actionEvidenceButtons({
        targetCitation: "r1",
        outcome: null,
        result: null,
      }),
    ).toEqual({ before: "r1", after: [] });
    // Every non-verified terminal keeps BEFORE alone with its real result.
    for (const outcome of [
      "unknown",
      "succeeded_unverified",
      "failed",
      "blocked_stale",
    ]) {
      expect(
        actionEvidenceButtons({
          targetCitation: "r1",
          outcome,
          result: verifiedResult,
        }),
      ).toEqual({ before: "r1", after: [] });
    }
  });

  it("offers the verified AFTER only for a succeeded receipt with actual result citations", () => {
    expect(
      actionEvidenceButtons({
        targetCitation: "r1",
        outcome: "succeeded",
        result: verifiedResult,
      }),
    ).toEqual({ before: "r1", after: ["r3"] });
    // Succeeded without actual result citations: BEFORE alone, no fake link.
    expect(
      actionEvidenceButtons({
        targetCitation: "r1",
        outcome: "succeeded",
        result: null,
      }),
    ).toEqual({ before: "r1", after: [] });
    expect(
      actionEvidenceButtons({
        targetCitation: "r1",
        outcome: "succeeded",
        result: { version: 1, text: "done without citations" },
      }),
    ).toEqual({ before: "r1", after: [] });
  });

  it("fails closed on a missing or malformed original label (no fabricated BEFORE)", () => {
    for (const targetCitation of [null, undefined, "", "r0", "m1"]) {
      expect(
        actionEvidenceButtons({
          targetCitation,
          outcome: "succeeded",
          result: verifiedResult,
        }),
      ).toEqual({ before: null, after: ["r3"] });
    }
  });
});
