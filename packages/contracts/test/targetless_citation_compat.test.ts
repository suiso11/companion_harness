// Targetless-create citation wire compatibility (PR37 follow-up).
//
// PR37 execution/history views assumed every proposal carries an owned
// `target_ref_id`; M6 `calendar.create` proposals carry NULL (no source
// event, no BEFORE) and both reads threw `DatabaseStateInvalidError`
// ("has no owned target reference (impossible state)") for create rows.
// The contract is now exact: `targetCitation` is NULL ONLY for targetless
// create (never a fabricated BEFORE); reschedule keeps its owned
// ORIGINAL-only `rN`, and anything that is not an `rN` label still fails
// schema validation.
//
// Pure contract test (no DB, no M6 stager): runnable on the PR37 base.
// The full service-lifecycle regression (pending/live/unknown/succeeded
// create reads over real SQLite) lives on the combined integration branch
// and is recorded in docs/operations.md; it requires PR38's M6 migration
// (0010 makes the target columns nullable) and stager.
import { describe, expect, it } from "vitest";
import { ProposalExecutionViewSchema } from "../src/action.js";
import { ActionRunHistorySelectionSchema } from "../src/http.js";

const EXECUTION_VIEW_BASE = {
  proposalId: "11111111-1111-4111-8111-111111111111",
  proposalStatus: "approved",
  runId: "22222222-2222-4222-8222-222222222222",
  status: "queued",
  markerCommitted: false,
  cancellable: true,
  errorCode: null,
  receipt: null,
} as const;

const HISTORY_SELECTION_BASE = {
  runId: "22222222-2222-4222-8222-222222222222",
  attempt: 1,
  runStatus: "running",
  finishedAt: null,
  result: null,
  receipt: null,
  executionStatus: "queued",
} as const;

describe("targetless citation wire compatibility", () => {
  it("execution view accepts a null BEFORE citation (targetless create)", () => {
    const view = ProposalExecutionViewSchema.parse({
      ...EXECUTION_VIEW_BASE,
      targetCitation: null,
    });
    expect(view.targetCitation).toBeNull();
  });

  it("execution view keeps the owned rN BEFORE citation (reschedule)", () => {
    const view = ProposalExecutionViewSchema.parse({
      ...EXECUTION_VIEW_BASE,
      targetCitation: "r2",
    });
    expect(view.targetCitation).toBe("r2");
  });

  it("execution view still rejects non-rN labels (no fabricated BEFORE)", () => {
    for (const bad of ["m1", "r0", "", "event-123"]) {
      expect(() =>
        ProposalExecutionViewSchema.parse({
          ...EXECUTION_VIEW_BASE,
          targetCitation: bad,
        }),
      ).toThrow();
    }
  });

  it("history selection accepts null and keeps owned rN, rejects the rest", () => {
    expect(
      ActionRunHistorySelectionSchema.parse({
        ...HISTORY_SELECTION_BASE,
        targetCitation: null,
      }).targetCitation,
    ).toBeNull();
    expect(
      ActionRunHistorySelectionSchema.parse({
        ...HISTORY_SELECTION_BASE,
        targetCitation: "r3",
      }).targetCitation,
    ).toBe("r3");
    expect(() =>
      ActionRunHistorySelectionSchema.parse({
        ...HISTORY_SELECTION_BASE,
        targetCitation: "m1",
      }),
    ).toThrow();
  });
});
