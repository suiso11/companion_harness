import { describe, expect, it } from "vitest";
import {
  extractionBodyCoverage,
  extractionBodyDowngrade,
  hasAssistantDerivedBodyTerms,
} from "../src/extraction_grounding.js";

// Synthetic regressions for the general body-coverage rules. These use only
// generic vocabulary; no production conversation text is stored here.
describe("extraction body grounding robustness", () => {
  it("does not downgrade a body made only of generic request words", () => {
    // "変更" and "依頼" are generic framing; this body carries no topic that
    // needs surface overlap with the user's colloquial action.
    expect(
      extractionBodyCoverage("ユーザーは変更を依頼した", "変えといて"),
    ).toBe(1);
    expect(
      extractionBodyDowngrade(
        "ユーザーは変更を依頼した",
        "変えといて",
        "変更ですね",
      ),
    ).toBeNull();
  });

  it("treats katakana and hiragana spellings as the same token", () => {
    expect(
      extractionBodyDowngrade(
        "ユーザーはバイトがある",
        "ばいとがあるよ",
        "バイト、がんばって",
      ),
    ).toBeNull();
  });

  it("ignores parenthetical asides when checking assistant-only terms", () => {
    const body = "ユーザーは水の沸点を測った（標準大気圧で）";
    const user = "水の沸点を測った";
    const assistant = "水の沸点を測った（標準大気圧で）";
    expect(hasAssistantDerivedBodyTerms(body, user, assistant)).toBe(false);
    expect(extractionBodyDowngrade(body, user, assistant)).toBeNull();
  });

  it("does not treat an auxiliary ending across a word boundary as addition", () => {
    const body = "ユーザーは会議で遅刻しないと決めた";
    expect(
      hasAssistantDerivedBodyTerms(
        body,
        "会議は遅れないようにする",
        "会議で遅刻しないように、とのこと",
      ),
    ).toBe(false);
  });

  it("exempts absolute dates resolved from the trusted current time", () => {
    const body = "ユーザーは2026-10-30に歯医者に行く予定";
    const user = "明日歯医者に行く";
    const assistant = "明日（2026-10-30）は歯医者ですね。";
    expect(hasAssistantDerivedBodyTerms(body, user, assistant)).toBe(false);
    expect(extractionBodyDowngrade(body, user, assistant)).toBeNull();
  });

  it("folds ordinary English inflections before downgrading provenance", () => {
    const body = "The user likes coffee";
    const user = "I like coffee";
    const assistant = "It sounds like the user likes coffee.";
    expect(hasAssistantDerivedBodyTerms(body, user, assistant)).toBe(false);
    expect(extractionBodyDowngrade(body, user, assistant)).toBeNull();
  });

  it("does not weld terms across Japanese particles", () => {
    const body = "ユーザーは犬と猫が好き";
    const user = "犬と猫が好き";
    const assistant = "犬猫好きなのですね。";
    expect(hasAssistantDerivedBodyTerms(body, user, assistant)).toBe(false);
    expect(extractionBodyDowngrade(body, user, assistant)).toBeNull();
  });

  it("accepts a prompt-mandated translation across scripts", () => {
    const body = "ユーザーは東京に住んでいる";
    const user = "I live in Tokyo.";
    const assistant = "You live in Tokyo.";
    expect(extractionBodyDowngrade(body, user, assistant)).toBeNull();
  });

  it("still downgrades genuine assistant-only content", () => {
    expect(
      extractionBodyDowngrade(
        "ユーザーは犬と猫が好きで、新しいバイクを買った",
        "犬と猫が好き",
        "新しいバイク、いいですね。",
      ),
    ).toBe("assistant_terms");
    expect(
      extractionBodyDowngrade(
        "The user likes coffee and owns a Ducati",
        "I like coffee",
        "A Ducati is a great bike.",
      ),
    ).toBe("assistant_terms");
  });

  it("downgrades a longer body that overlaps only on generic words", () => {
    const body = "ユーザーは別件について話したいことがあると述べた";
    expect(extractionBodyCoverage(body, "もっとある")).toBe(0);
    expect(
      extractionBodyDowngrade(
        body,
        "もっとある",
        "別件についてのお話、承知しました",
      ),
    ).toBe("coverage");
  });
});
