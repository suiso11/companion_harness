import { describe, expect, it } from "vitest";
import { loadBundledVoiceProfile } from "../src/index.js";
import {
  checkFidelity,
  type FidelityViolation,
  hasCommitment,
} from "../src/voice/speech_act.js";

interface Case {
  readonly name: string;
  readonly canonical: string;
  readonly voiced: string;
  readonly expect: readonly FidelityViolation[] | "ok";
}

// Deterministic regression set: each pair is (canonical answer part, voiced
// part). Cases cover the speech-act classes the renderer must preserve:
// commitment, request, negation, and literal tokens.
const CASES: readonly Case[] = [
  {
    name: "commitment kept first-person",
    canonical: "資料を見て要点をまとめます。",
    voiced: "資料を見て要点をまとめまっさ。",
    expect: "ok",
  },
  {
    name: "commitment turned into a request (observed failure)",
    canonical: "資料を見て要点をまとめます。",
    voiced: "資料を見て要点を纏めておくれやす。",
    expect: ["introduced_request"],
  },
  {
    name: "report turned into a request",
    canonical: "予定を確認しました。",
    voiced: "予定を確かめておくれやす。",
    expect: ["introduced_request"],
  },
  {
    name: "request kept",
    canonical: "日付を確認してください。",
    voiced: "日付を確かめておくれやす。",
    expect: "ok",
  },
  {
    name: "request lost",
    canonical: "日付を確認してください。",
    voiced: "日付を確かめます。",
    expect: ["lost_request"],
  },
  {
    name: "assistant acting for user flipped",
    canonical: "資料をまとめておきます。",
    voiced: "資料をまとめておくれやす。",
    expect: ["introduced_request"],
  },
  {
    name: "negation kept",
    canonical: "その日付の予定は見つかりませんでした。",
    voiced: "その日付のご予定はありまへん。",
    expect: "ok",
  },
  {
    name: "negation dropped",
    canonical: "その日付の予定は見つかりませんでした。",
    voiced: "その日付のご予定は見つかりました。",
    expect: ["negation_lost"],
  },
  {
    name: "negation added",
    canonical: "予定は見つかりました。",
    voiced: "予定は見つかりまへん。",
    expect: ["negation_added"],
  },
  {
    name: "number preserved",
    canonical: "納期は10月30日、金額は48,000円です。",
    voiced: "納期は10月30日、金額は48,000円どす。",
    expect: "ok",
  },
  {
    name: "number changed",
    canonical: "納期は10月30日、金額は48,000円です。",
    voiced: "納期は10月3日、金額は48,000円どす。",
    expect: ["token_mismatch"],
  },
  {
    name: "citation preserved",
    canonical: "東京は晴れです[r1]。",
    voiced: "東京は晴れどす[r1]。",
    expect: "ok",
  },
  {
    name: "citation dropped",
    canonical: "東京は晴れです[r1]。",
    voiced: "東京は晴れどす。",
    expect: ["token_mismatch"],
  },
  {
    name: "url preserved",
    canonical: "詳細は https://example.com/a です。",
    voiced: "詳細は https://example.com/a どす。",
    expect: "ok",
  },
  {
    name: "code preserved",
    canonical: "`renderRunResultText` は parts を結合します。",
    voiced: "`renderRunResultText` は parts を結合しまっさ。",
    expect: "ok",
  },
  {
    name: "code changed",
    canonical: "`renderRunResultText` は parts を結合します。",
    voiced: "`renderResultText` は parts を結合しまっさ。",
    expect: ["token_mismatch"],
  },
  {
    name: "plain assertion",
    canonical: "東京の明日は晴れです。",
    voiced: "東京の明日は晴れどす。",
    expect: "ok",
  },
  {
    name: "refusal kept",
    canonical: "その予定は確認できません。",
    voiced: "そのご予定は確認できまへん。",
    expect: "ok",
  },
  {
    name: "refusal turned into request",
    canonical: "その予定は確認できません。",
    voiced: "そのご予定は確認しておくれやす。",
    expect: ["introduced_request", "negation_lost"],
  },
  {
    name: "thanks",
    canonical: "どういたしまして。",
    voiced: "どういたしませぬ。",
    expect: ["negation_added"],
  },
  {
    name: "thanks kept",
    canonical: "ありがとうございます。",
    voiced: "おおきに、ありがとうございます。",
    expect: "ok",
  },
  {
    name: "offer kept",
    canonical: "資料を探しておきます。",
    voiced: "資料を探しときまっさ。",
    expect: "ok",
  },
  {
    name: "offer turned into request",
    canonical: "資料を探しておきます。",
    voiced: "資料を探しておくれやす。",
    expect: ["introduced_request"],
  },
  {
    name: "two-part list preserved",
    canonical: "1. 資料を確認する\n2. 会議の日程を調整する",
    voiced: "1. 資料を確認する\n2. 会議の日程を調整する",
    expect: "ok",
  },
  {
    name: "list number changed",
    canonical: "1. 資料を確認する\n2. 会議の日程を調整する",
    voiced: "1. 資料を確認する\n3. 会議の日程を調整する",
    expect: ["token_mismatch"],
  },
  {
    name: "time preserved",
    canonical: "10:00にチーム定例があります。",
    voiced: "10:00にチーム定例がありまっさ。",
    expect: "ok",
  },
  {
    name: "time changed",
    canonical: "10:00にチーム定例があります。",
    voiced: "10:30にチーム定例がありまっさ。",
    expect: ["token_mismatch"],
  },
  {
    name: "polite request preserved",
    canonical: "もう一度お願いします。",
    voiced: "もういっぺんお願いします。",
    expect: "ok",
  },
  {
    name: "question kept",
    canonical: "どちらにしますか。",
    voiced: "どちらにしますか。",
    expect: "ok",
  },
  {
    name: "commitment with negation kept",
    canonical: "今日は外出しません。",
    voiced: "今日は外出しまへん。",
    expect: "ok",
  },
];

describe("checkFidelity", () => {
  for (const testCase of CASES) {
    it(testCase.name, () => {
      const result = checkFidelity(testCase.canonical, testCase.voiced);
      if (testCase.expect === "ok") {
        expect(result.ok).toBe(true);
      } else {
        expect(result.violations).toEqual(
          expect.arrayContaining([...testCase.expect]),
        );
      }
    });
  }

  it("flags the observed commitment→request failure", () => {
    const result = checkFidelity(
      "予定を確認しました。明日10:00にチーム定例があります。資料を見て要点をまとめます。",
      "予定、確かめたとこどす。明日10:00にチーム定例がありまっさ。資料を見て要点を纏めておくれやす。",
    );
    expect(result.violations).toContain("introduced_request");
  });

  it("passes every bundled profile exemplar", () => {
    const profile = loadBundledVoiceProfile();
    for (const exemplar of profile.exemplars) {
      const result = checkFidelity(exemplar.canonical, exemplar.voiced);
      expect(
        result.violations,
        `${exemplar.canonical} -> ${exemplar.voiced}`,
      ).toEqual([]);
    }
  });

  it("detects first-person commitments", () => {
    expect(hasCommitment("資料をまとめます。")).toBe(true);
    expect(hasCommitment("資料を見てください。")).toBe(false);
  });
});
