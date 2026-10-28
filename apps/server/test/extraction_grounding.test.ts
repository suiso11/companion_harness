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
