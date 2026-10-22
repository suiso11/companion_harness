import { describe, expect, it } from "vitest";
import { checkVoiceAnswer, checkVoicePart } from "../src/index.js";

describe("checkVoicePart", () => {
  it("accepts identical structural content", () => {
    expect(
      checkVoicePart("結果はr1です。", "結果はr1でござります。"),
    ).toBeNull();
    expect(
      checkVoicePart("10:00に集合。", "10:00に集まりましょう。"),
    ).toBeNull();
    expect(checkVoicePart("APIを使う。", "APIを使います。")).toBeNull();
    expect(
      checkVoicePart(
        "https://example.com/a を見る。",
        "https://example.com/a を見とくれやす。",
      ),
    ).toBeNull();
    expect(
      checkVoicePart("`code` を実行。", "`code` を実行しとくれやす。"),
    ).toBeNull();
  });

  it("rejects changed or dropped citation markers", () => {
    expect(checkVoicePart("結果はr1です。", "結果はr2です。")).toBe(
      "citation_marker",
    );
    expect(checkVoicePart("結果はr1です。", "結果です。")).toBe(
      "citation_marker",
    );
    expect(checkVoicePart("結果は[r1]と[m1]。", "結果は[r1]と[m2]。")).toBe(
      "citation_marker",
    );
  });

  it("compares ASCII digit runs (no new numbers)", () => {
    expect(checkVoicePart("10時に会う。", "11時に会う。")).toBe("number");
    expect(checkVoicePart("10時に会う。", "10時に会います。")).toBeNull();
    expect(checkVoicePart("10時に会う。", "十時に会う。")).toBe("number");
  });

  it("normalizes fullwidth digits before comparing", () => {
    expect(checkVoicePart("10時に会う。", "１０時に会う。")).toBeNull();
    expect(checkVoicePart("10時に会う。", "１０時に会う。12人。")).toBe(
      "number",
    );
  });

  it("allows kanji numerals only when the original digits remain", () => {
    expect(checkVoicePart("3つの項目。", "3つの項目、三つとも。")).toBeNull();
    expect(checkVoicePart("3つの項目。", "三つの項目。")).toBe("number");
  });

  it("accepts kanji numerals whose value is present in the canonical part", () => {
    expect(checkVoicePart("三つの項目。", "三つの項目や。")).toBeNull();
    expect(checkVoicePart("3つの項目。", "3つの項目、三つとも。")).toBeNull();
  });

  it("rejects a new or changed kanji number value", () => {
    expect(checkVoicePart("3つの項目。", "3つの項目、四つとも。")).toBe(
      "number",
    );
    expect(checkVoicePart("三つの項目。", "四つの項目。")).toBe("number");
    expect(checkVoicePart("十時に会う。", "十一時に会う。")).toBe("number");
  });

  it("compares number tokens in order, keeping separators", () => {
    expect(checkVoicePart("10時と20時。", "20時と10時。")).toBe("number");
    expect(checkVoicePart("10:00に会う。", "10.00に会う。")).toBe("number");
    expect(
      checkVoicePart("48,000円です。", "48,000円でござります。"),
    ).toBeNull();
  });

  it("rejects a flipped or added negation", () => {
    expect(
      checkVoicePart("その予定は確認できません。", "その予定は確認できます。"),
    ).toBe("negation");
    expect(
      checkVoicePart(
        "その予定は確認できません。",
        "その予定は確認できまへん。",
      ),
    ).toBeNull();
  });

  it("ignores Kansai どない-type words when counting negations", () => {
    // Production regression: どない is a demonstrative, not a negation.
    expect(
      checkVoicePart(
        "今の私の口調はどう感じられますか？",
        "今のわての口調、どない感じやろか？",
      ),
    ).toBeNull();
    // -な/-に/-して forms are also non-negations.
    expect(
      checkVoicePart(
        "今の私の口調はどう感じられますか？",
        "今のわての口調、どないな感じやろか？",
      ),
    ).toBeNull();
    expect(
      checkVoicePart(
        "今の私の口調はどう感じられますか？",
        "今のわての口調、どないに感じやろか？",
      ),
    ).toBeNull();
    expect(
      checkVoicePart(
        "今の私の口調はどう感じられますか？",
        "そないして、今のわての口調はどう感じやろか？",
      ),
    ).toBeNull();
  });

  it("still rejects a real negation flip next to どない", () => {
    expect(
      checkVoicePart("その予定は確認できます。", "その予定は確認できまへん。"),
    ).toBe("negation");
    expect(
      checkVoicePart(
        "今の私の口調はどう感じられますか？",
        "今のわての口調はどない感じられまへんか？",
      ),
    ).toBe("negation");
  });

  it("keeps a real なく negation while ignoring どない", () => {
    // Exact production shape: canonical has 「ではなく」(one negation);
    // voiced keeps it as 「やなく」 and adds どない, which must not count.
    expect(
      checkVoicePart(
        "ユーザーさんの口調ではなく、私の口調が変わったことに気づいていらっしゃったのですね。今の私の口調はどう感じられますか？",
        "ユーザーさんの口調やなく、わての口調が変わったことに気づいていらっしゃったんやね。今のわての口調、どない感じやろか？",
      ),
    ).toBeNull();
  });

  it("rejects changed or dropped ASCII words", () => {
    expect(checkVoicePart("APIを使う。", "apiを使う。")).toBe("latin");
    expect(checkVoicePart("APIを使う。", "エーピーアイを使う。")).toBe("latin");
    expect(checkVoicePart("renderRunResultText を使う。", "それを使う。")).toBe(
      "latin",
    );
  });

  it("rejects changed or dropped URLs", () => {
    expect(
      checkVoicePart(
        "https://example.com/a を見る。",
        "https://example.com/b を見る。",
      ),
    ).toBe("url");
  });

  it("requires byte-identical fenced blocks and inline code", () => {
    const fenced = "```ts\nconst x = 1;\n```";
    expect(checkVoicePart(fenced, fenced)).toBeNull();
    expect(checkVoicePart(fenced, "```ts\nconst x = 1; \n```")).toBe(
      "code_block",
    );
    expect(checkVoicePart("`code` を実行。", "`code ` を実行。")).toBe(
      "code_block",
    );
    expect(checkVoicePart("`code` を実行。", "`Code` を実行。")).toBe("latin");
    expect(checkVoicePart("`+` を使う。", "+ を使う。")).toBe("code_block");
  });

  it("bounds the length ratio and requires non-empty output", () => {
    const canonical =
      "これは非常に長い説明文でございます。今日の予定を詳しく説明いたします。";
    expect(checkVoicePart(canonical, "はい。")).toBe("length");
    expect(checkVoicePart(canonical, "はい。".repeat(10))).not.toBe("length");
    expect(checkVoicePart("短い", "とても長い説明でございます。")).toBeNull();
    expect(checkVoicePart("短い", "")).toBe("length");
  });

  it("caps expansion of short canonical parts at 50 code points", () => {
    expect(checkVoicePart("短い", "あ".repeat(50))).toBeNull();
    expect(checkVoicePart("短い", "あ".repeat(51))).toBe("length");
  });
});

describe("checkVoiceAnswer", () => {
  it("requires the same part count", () => {
    expect(checkVoiceAnswer(["a", "b"], ["a"])).toBe("part_count");
  });

  it("accepts a fully aligned voiced answer", () => {
    expect(
      checkVoiceAnswer(
        ["明日は晴れです。r1", "10:00に会いましょう。"],
        ["明日は晴れでござります。r1", "10:00にお会いしとくれやす。"],
      ),
    ).toBeNull();
  });

  it("checks structural invariants part by part", () => {
    expect(
      checkVoiceAnswer(
        ["r1とr2です。", "10時の予定。"],
        ["r1とr3です。", "10時のご予定。"],
      ),
    ).toBe("citation_marker");
    expect(
      checkVoiceAnswer(
        ["10時と20時。", "予定です。"],
        ["10時と21時。", "ご予定でござります。"],
      ),
    ).toBe("number");
  });

  it("rejects a number moved across parts", () => {
    expect(
      checkVoiceAnswer(
        ["10時の予定。", "20時の予定。"],
        ["20時の予定。", "10時の予定。"],
      ),
    ).toBe("number");
  });

  it("checks code blocks byte-for-byte across the answer", () => {
    expect(
      checkVoiceAnswer(
        ["```js\nconst a = 1;\n```", "説明です。"],
        ["```js\nconst a = 1;\n```", "説明でござります。"],
      ),
    ).toBeNull();
    expect(
      checkVoiceAnswer(
        ["```js\nconst a = 1;\n```", "説明です。"],
        ["```js\nconst a = 1; \n```", "説明でござります。"],
      ),
    ).toBe("code_block");
  });
});
