// Pure UI-state helpers for the Auto-dispatch panel: parsers reject unknown
// shapes, the source anchor is the latest COMMITTED user turn, and status /
// reason labels stay explicit about blocked/unknown states. No forwarding or
// literal-markup assertions.
import { describe, expect, test } from "vitest";
import {
  capsLines,
  executionReasonText,
  executionStatusText,
  formatExpiry,
  narrowOperations,
  parseAutodispatchStatus,
  parseControl,
  parseTrialDetail,
  planStatusText,
  policyStatusText,
  selectLatestCompletedUserTurn,
} from "../src/lib/autodispatch.js";

const caps = {
  timeoutMs: 900_000,
  maxOutputBytes: 4096,
  maxModelCalls: 24,
  maxOutputTokens: 2048,
  perCallTimeoutMs: 120_000,
  maxRequestBytes: 1_048_576,
  maxResponseBytes: 1_048_576,
  maxConcurrent: 1,
  jobsPerDay: 3,
  concurrentExecutions: 1,
};

const intent = {
  kind: "execute",
  quotes: [{ turnId: "turn-a", runId: "run-a", text: "do it", seq: 2 }],
  latestUserTurnId: "turn-a",
  latestUserRunId: "run-a",
  provenance: "user-conversation",
};

function statusBody() {
  return {
    enabled: true,
    workspaceAlias: "companion-harness",
    operations: ["investigate", "implement"],
    checks: ["lint"],
    readScopes: ["src"],
    writeScopes: ["src"],
    caps,
    dependencyReady: false,
    policies: [
      {
        id: "policy-a",
        workspaceAlias: "companion-harness",
        version: 1,
        status: "active",
        operations: ["implement"],
        readScopes: ["src"],
        writeScopes: ["src"],
        checks: ["lint"],
        caps,
        expiresAt: null,
        createdAt: 100,
      },
    ],
    plans: [
      {
        id: "plan-a",
        policyId: "policy-a",
        policyVersion: 1,
        revision: 2,
        status: "frozen",
        goal: "apply candidate",
        decisions: [],
        nongoals: [],
        steps: [],
        acceptance: [],
        missing: [],
        relevantPaths: ["src/app.ts"],
        operation: "implement",
        intent,
        createdAt: 200,
      },
    ],
    executions: [
      {
        id: "exec-a",
        planId: "plan-a",
        policyId: "policy-a",
        policyVersion: 1,
        status: "denied",
        reason: "control-paused",
        executionId: null,
        createdAt: 300,
      },
    ],
  };
}

describe("autodispatch status", () => {
  test("parses the actual enabled shape and keeps honest blocked fields", () => {
    const parsed = parseAutodispatchStatus(statusBody());
    expect(parsed).not.toBeNull();
    expect(parsed?.workspaceAlias).toBe("companion-harness");
    expect(parsed?.dependencyReady).toBe(false);
    expect(parsed?.policies[0]?.operations).toEqual(["implement"]);
    expect(parsed?.plans[0]?.revision).toBe(2);
    expect(parsed?.executions[0]?.reason).toBe("control-paused");
    expect(planStatusText("frozen")).toContain("自動実行待ち");
    expect(executionStatusText("denied")).toBe("拒否");
    expect(executionReasonText("control-paused")).toContain("停止中");
  });

  test("rejects an unenabled or malformed body instead of inventing state", () => {
    expect(
      parseAutodispatchStatus({ ...statusBody(), enabled: false }),
    ).toBeNull();
    expect(
      parseAutodispatchStatus({ ...statusBody(), operations: ["verify"] }),
    ).toBeNull();
    expect(
      parseAutodispatchStatus({ ...statusBody(), caps: { timeoutMs: 1 } }),
    ).toBeNull();
  });

  test("unknown reason and status vocabulary stay visible, not mapped to success", () => {
    expect(executionReasonText("other-cause")).toBe("other-cause");
    expect(executionReasonText(null)).toBe("—");
    expect(policyStatusText("expired")).toBe("期限切れ");
    expect(formatExpiry(null)).toBe("無期限");
  });
});

describe("source anchor selection", () => {
  test("picks the latest completed user_text turn only", () => {
    const anchor = selectLatestCompletedUserTurn({
      items: [
        {
          turnId: "turn-b",
          seq: 3,
          kind: "user_text",
          text: "latest but unfinished",
          selectedRun: null,
        },
        {
          turnId: "turn-a",
          seq: 2,
          kind: "user_text",
          text: "committed decision",
          selectedRun: {
            runId: "run-a",
            attempt: 1,
            finishedAt: 1,
            result: {},
          },
        },
        {
          turnId: "turn-0",
          seq: 1,
          kind: "user_text",
          text: "older",
          selectedRun: {
            runId: "run-0",
            attempt: 1,
            finishedAt: 1,
            result: {},
          },
        },
        {
          turnId: "approval",
          seq: 4,
          kind: "action_approval",
          text: "not user text",
          selectedRun: {
            runId: "run-x",
            attempt: 1,
            finishedAt: 1,
            result: {},
          },
        },
      ],
    });
    expect(anchor).toEqual({
      turnId: "turn-a",
      runId: "run-a",
      text: "committed decision",
      seq: 2,
    });
  });

  test("no completed user turn yields no enable anchor", () => {
    expect(selectLatestCompletedUserTurn({ items: [] })).toBeNull();
    expect(
      selectLatestCompletedUserTurn({
        items: [
          {
            turnId: "turn-a",
            seq: 1,
            kind: "user_text",
            text: "pending",
            selectedRun: null,
          },
        ],
      }),
    ).toBeNull();
  });
});

describe("operator bounds and trial detail", () => {
  test("operations can only narrow inside the actual allowed set", () => {
    expect(narrowOperations(["implement", "bogus"], ["investigate"])).toEqual(
      [],
    );
    expect(
      narrowOperations(["investigate"], ["investigate", "implement"]),
    ).toEqual(["investigate"]);
    expect(capsLines(caps).some((line) => line.value.includes("ジョブ"))).toBe(
      false,
    );
    expect(capsLines(caps)).toHaveLength(10);
  });

  test("control and trial detail parse null/unknown honestly", () => {
    expect(parseControl({ paused: false, version: 1, reason: null })).toEqual({
      paused: false,
      version: 1,
      reason: null,
    });
    expect(parseControl({ paused: "no", version: 1 })).toBeNull();
    const detail = parseTrialDetail({
      grant: { status: "consumed", cancelRequested: false },
      request: {
        mode: "write",
        requiredChecks: ["lint"],
        relevantPaths: ["src/app.ts"],
      },
      outcome: {
        status: "consumed",
        authorized: true,
        summary: "bridge-exit:0",
        recorded: true,
        succeeded: true,
        quiescent: false,
        detail: "bridge-exit:0",
      },
    });
    expect(detail?.outcome).toEqual({
      authorized: true,
      succeeded: true,
      quiescent: false,
      detail: "bridge-exit:0",
    });
    expect(detail?.mode).toBe("write");

    // Pending (grant exists, no durable row): must NOT parse as a failure.
    const pending = parseTrialDetail({
      grant: { status: "claimed", cancelRequested: false },
      outcome: {
        status: "claimed",
        authorized: false,
        summary: "",
        recorded: false,
        succeeded: false,
        quiescent: false,
        detail: "",
      },
    });
    expect(pending).not.toBeNull();
    expect(pending?.outcome).toBeNull();

    // Durable unauthorized failure: visible result with authorized=false.
    const failed = parseTrialDetail({
      grant: { status: "interrupted", cancelRequested: false },
      outcome: {
        status: "interrupted",
        authorized: false,
        summary: "observed-not-authorized:checks mismatch:bridge-exit:1",
        recorded: true,
        succeeded: true,
        quiescent: false,
        detail: "observed-not-authorized:checks mismatch:bridge-exit:1",
      },
    });
    expect(failed?.outcome).toMatchObject({
      authorized: false,
      succeeded: true,
      quiescent: false,
    });

    // Legacy outcome shape (authorized/summary only) stays null.
    expect(
      parseTrialDetail({
        grant: { status: "claimed", cancelRequested: false },
        outcome: { status: "claimed", authorized: false, summary: "" },
      })?.outcome,
    ).toBeNull();
    expect(parseTrialDetail({ grant: { status: "consumed" } })).toBeNull();
  });
});
