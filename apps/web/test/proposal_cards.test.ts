import { describe, expect, it } from "vitest";
import {
  conversationProposalCards,
  createProposalSyncGuard,
  frozenProposalDecision,
  proposalCardErrorText,
  trialProposalCards,
} from "../src/lib/proposal_cards.js";

const base = {
  target: "purpose",
  status: "pending",
  version: 3,
  sourceQuote: "来週までに資料をまとめたい",
  interpretation: "資料の下書きを作る",
  sourceRunId: "run-1",
};

describe("conversationProposalCards", () => {
  it("maps pending proposals of runs in the session projection", () => {
    const cards = conversationProposalCards(
      [{ ...base, id: "p1" }],
      new Set(["run-1"]),
    );
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      key: "conversation:p1",
      source: "conversation",
      proposalId: "p1",
      kindLabel: "目的",
      heading: "資料の下書きを作る",
      quote: "来週までに資料をまとめたい",
      version: 3,
      canAccept: true,
      canReject: true,
      canApprove: false,
      canExpire: false,
    });
  });

  it("labels task targets as タスク", () => {
    const cards = conversationProposalCards(
      [{ ...base, id: "p1", target: "task" }],
      new Set(["run-1"]),
    );
    expect(cards[0]?.kindLabel).toBe("タスク");
  });

  it("hides decided proposals and proposals from other runs", () => {
    const cards = conversationProposalCards(
      [
        { ...base, id: "accepted", status: "accepted" },
        { ...base, id: "rejected", status: "rejected" },
        { ...base, id: "other", sourceRunId: "run-other" },
      ],
      new Set(["run-1"]),
    );
    expect(cards).toHaveLength(0);
  });

  it("shows the staged parent purpose before a task proposal is accepted", () => {
    const cards = conversationProposalCards(
      [
        {
          ...base,
          id: "p1",
          target: "task",
          parentPurposeId: "parent-1",
          expectedParentVersion: 4,
        },
      ],
      new Set(["run-1"]),
      new Map([
        [
          "parent-1",
          { statement: "四半期の学習計画", version: 4, status: "active" },
        ],
      ]),
    );
    expect(cards[0]?.canAccept).toBe(true);
    expect(cards[0]?.parentResolved).toBe(true);
    expect(cards[0]?.parentPurposeId).toBe("parent-1");
    expect(cards[0]?.parentLine).toContain(
      "親の目的（採用時に再確認・変更不可）: 四半期の学習計画",
    );
    expect(cards[0]?.parentLine).toContain("提案時の版 4／現在 4");
  });

  it("flags parent version and status drift like the Proposals panel", () => {
    const cards = conversationProposalCards(
      [
        {
          ...base,
          id: "p1",
          target: "task",
          parentPurposeId: "parent-1",
          expectedParentVersion: 2,
        },
      ],
      new Set(["run-1"]),
      new Map([
        ["parent-1", { statement: "学習計画", version: 5, status: "revoked" }],
      ]),
    );
    expect(cards[0]?.parentLine).toContain("現在の版と一致しません");
    expect(cards[0]?.parentLine).toContain("親は現在revokedです");
  });

  it("disables accept while the task parent is unresolved", () => {
    const task = {
      ...base,
      id: "p1",
      target: "task",
      parentPurposeId: "parent-1",
      expectedParentVersion: 1,
    };
    // Not fetched yet.
    const pending = conversationProposalCards([task], new Set(["run-1"]));
    expect(pending[0]?.canAccept).toBe(false);
    expect(pending[0]?.parentResolved).toBe(false);
    expect(pending[0]?.parentLine).toContain("確認しています");
    // Lookup failed.
    const failed = conversationProposalCards(
      [task],
      new Set(["run-1"]),
      new Map([["parent-1", null]]),
    );
    expect(failed[0]?.canAccept).toBe(false);
    expect(failed[0]?.parentLine).toContain("確認できません");
    // No staged parent id at all (anomalous).
    const missing = conversationProposalCards(
      [{ ...base, id: "p1", target: "task" }],
      new Set(["run-1"]),
    );
    expect(missing[0]?.canAccept).toBe(false);
    expect(missing[0]?.parentLine).toBe("親の目的：なし（異常）");
    // The same unresolved state only blocks accept, not reject.
    expect(missing[0]?.canReject).toBe(true);
  });

  it("does not label purpose proposals with a parent line", () => {
    const cards = conversationProposalCards(
      [{ ...base, id: "p1" }],
      new Set(["run-1"]),
    );
    expect(cards[0]?.parentLine).toBe("");
    expect(cards[0]?.parentPurposeId).toBeNull();
    expect(cards[0]?.parentResolved).toBe(true);
  });

  it("hides proposals without a source run id", () => {
    const cards = conversationProposalCards(
      [{ ...base, id: "p1", sourceRunId: null }],
      new Set(["run-1"]),
    );
    expect(cards).toHaveLength(0);
  });
});

describe("trialProposalCards", () => {
  it("exposes staged trials with actions and terminal trials as links", () => {
    const cards = trialProposalCards([
      { id: "t1", status: "staged", objective: "テストを追加する" },
      {
        id: "t2",
        status: "granted",
        objective: "古い提案",
        reportSummary: "封印試行が完了しました",
        outcome: {
          status: "consumed",
          authorized: true,
          summary: "bridge-exit:0",
        },
      },
      { id: "t3", status: "expired", objective: "取り消し済み" },
    ]);
    expect(cards).toHaveLength(3);
    expect(cards[0]).toMatchObject({
      key: "trial:t1",
      source: "trial",
      kindLabel: "試行",
      heading: "テストを追加する",
      // A bare list row has no frozen permission snapshot: no approval.
      canApprove: false,
      canExpire: true,
      canAccept: false,
      canReject: false,
      detailLines: [],
      summaryLine: "",
      detailHref: "",
    });
    // Terminal guest summary is a plain one-line string; the detail link is
    // the only way to the bounded report.
    expect(cards[1]).toMatchObject({
      status: "granted",
      canApprove: false,
      canExpire: false,
      summaryLine: "封印試行が完了しました",
      detailHref: "/trials",
    });
    expect(cards[2]).toMatchObject({
      status: "expired",
      summaryLine: "結果: expired",
      detailHref: "/trials",
    });
  });

  it("shows the frozen trial permissions before approval", () => {
    const cards = trialProposalCards([
      {
        id: "t1",
        status: "staged",
        objective: "テストを追加する",
        acceptance: ["テストが通る"],
        literalPatchPaths: ["apps/web/src"],
        operation: "implement",
        readOnlyMode: false,
        expiry: "2026-11-01T00:00:00.000Z",
        timeoutMs: 60_000,
        maxOutputBytes: 1_000_000,
        requiredChecks: ["vitest"],
        workspaceAlias: "ws-main",
        profile: {
          configFingerprint: "a".repeat(64),
          sourceRevision: "b".repeat(40),
        },
        possibleExternalDataConsent: true,
      },
    ]);
    expect(cards[0]?.canApprove).toBe(true);
    expect(cards[0]?.detailLines).toEqual(
      expect.arrayContaining([
        "操作: implement",
        "対象パス: apps/web/src",
        "作業場所: ws-main",
        "外部データの同意: あり",
      ]),
    );
  });

  it("fails closed when the permission snapshot is incomplete", () => {
    const cards = trialProposalCards([
      {
        id: "t1",
        status: "staged",
        objective: "テストを追加する",
        workspaceAlias: null,
      },
    ]);
    expect(cards[0]?.canApprove).toBe(false);
    expect(cards[0]?.detailLines).toEqual([]);
  });
});

describe("proposalCardErrorText", () => {
  it("asks for a reload on CAS conflict", () => {
    expect(proposalCardErrorText(409)).toBe(
      "状態が変わりました。再読み込みしてください",
    );
  });

  it("uses generic Japanese text for other failures", () => {
    expect(proposalCardErrorText(500)).toBe(
      "操作に失敗しました。もう一度お試しください",
    );
    expect(proposalCardErrorText(404)).toBe(
      "対象が見つかりません。再読み込みしてください",
    );
  });
});

describe("createProposalSyncGuard", () => {
  it("accepts only the latest request", () => {
    const guard = createProposalSyncGuard();
    const first = guard.next();
    const second = guard.next();
    expect(guard.isCurrent(first)).toBe(false);
    expect(guard.isCurrent(second)).toBe(true);
  });

  it("drops everything in flight when invalidated", () => {
    const guard = createProposalSyncGuard();
    const seq = guard.next();
    guard.invalidate();
    expect(guard.isCurrent(seq)).toBe(false);
    expect(guard.isCurrent(guard.next())).toBe(true);
  });
});

describe("frozenProposalDecision", () => {
  it("reuses the same key and body for an uncertain retry", () => {
    const first = frozenProposalDecision(
      null,
      "p1accept",
      { expectedVersion: 3 },
      "key-1",
    );
    const retry = frozenProposalDecision(
      first,
      "p1accept",
      { expectedVersion: 4 },
      "key-2",
    );
    expect(retry).toBe(first);
    expect(retry.key).toBe("key-1");
    expect(retry.body.expectedVersion).toBe(3);
  });

  it("starts a new command for a different action or proposal", () => {
    const first = frozenProposalDecision(
      null,
      "p1accept",
      { expectedVersion: 3 },
      "key-1",
    );
    const reject = frozenProposalDecision(
      first,
      "p1reject",
      { expectedVersion: 4 },
      "key-2",
    );
    expect(reject.key).toBe("key-2");
    expect(reject.body.expectedVersion).toBe(4);
    const other = frozenProposalDecision(
      reject,
      "p2reject",
      { expectedVersion: 5 },
      "key-3",
    );
    expect(other.key).toBe("key-3");
  });

  it("freezes a trial approve key across an uncertain reply", () => {
    // Trial cards freeze on card key + action, exactly like conversation
    // cards, so a status-0/5xx approve retry reuses the same key + body.
    const first = frozenProposalDecision<Record<string, never>>(
      null,
      "trial:t1approve",
      {},
      "key-trial-1",
    );
    const retry = frozenProposalDecision<Record<string, never>>(
      first,
      "trial:t1approve",
      {},
      "key-trial-2",
    );
    expect(retry).toBe(first);
    expect(retry.key).toBe("key-trial-1");
    // Expire uses no frozen command, so it cannot re-key the approve.
    expect(first.key).toBe("key-trial-1");
    const approveAgain = frozenProposalDecision<Record<string, never>>(
      first,
      "trial:t1approve",
      {},
      "key-trial-3",
    );
    expect(approveAgain.key).toBe("key-trial-1");
  });
});
