import { describe, expect, it } from "vitest";
import {
  conversationProposalCards,
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
      canApprove: true,
      canExpire: true,
      canAccept: false,
      canReject: false,
    });
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
