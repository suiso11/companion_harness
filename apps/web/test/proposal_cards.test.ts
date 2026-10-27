import { describe, expect, it } from "vitest";
import {
  conversationProposalCards,
  createProposalSyncGuard,
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

  it("hides proposals without a source run id", () => {
    const cards = conversationProposalCards(
      [{ ...base, id: "p1", sourceRunId: null }],
      new Set(["run-1"]),
    );
    expect(cards).toHaveLength(0);
  });
});

describe("trialProposalCards", () => {
  it("only exposes still-staged trials with approve/expire", () => {
    const cards = trialProposalCards([
      { id: "t1", status: "staged", objective: "テストを追加する" },
      { id: "t2", status: "granted", objective: "古い提案" },
      { id: "t3", status: "expired", objective: "取り消し済み" },
    ]);
    expect(cards).toHaveLength(1);
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
