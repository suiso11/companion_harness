import { describe, expect, it } from "vitest";
import {
  containsFolded,
  countCodePointsLocal,
  equalsFolded,
  findFirstHit,
  findFirstHitWithComparisons,
  foldQuery,
  kmpIndexOfSequenceWithStats,
  makeSnippet,
  normalizeNFC,
  SNIPPET_CONTEXT_BEFORE,
  SNIPPET_MAX_CODE_POINTS,
  sliceCodePoints,
  TEXT_FOLD_UNICODE_VERSION,
} from "../src/text.js";
import {
  CASE_FOLD_OVERRIDE_COUNT,
  getCaseFoldOverride,
  UNICODE_DATA_VERSION,
} from "../src/unicode_case_fold.js";

describe("text primitives", () => {
  it("normalizes to NFC", () => {
    expect(normalizeNFC("é")).toBe("é");
    expect(normalizeNFC("é")).toBe("é");
  });

  it("folds case locale-independently per code point", () => {
    expect(foldQuery("HeLLo")).toBe("hello");
    expect(foldQuery("é")).toBe("é");
    // Astral characters survive folding intact.
    expect(foldQuery("😀A")).toBe("😀a");
  });

  it("matches whole-query literals, never regex", () => {
    expect(containsFolded("a+b (c) .*?", "a+b (c) .*?")).toBe(true);
    expect(containsFolded("abc", ".*")).toBe(false);
    expect(containsFolded("abc", "b")).toBe(true);
    expect(containsFolded("ABC", "abc")).toBe(true);
    expect(equalsFolded("Hello", "hello")).toBe(true);
    expect(equalsFolded("Hello world", "hello")).toBe(false);
    expect(containsFolded("anything", "")).toBe(false);
    expect(equalsFolded("a", "")).toBe(false);
  });

  it("maps hits to source code-point indices (astral-safe)", () => {
    expect(countCodePointsLocal("😀")).toBe(1);
    expect(sliceCodePoints("a😀b😀c", 1, 3)).toBe("😀b");
    const hit = findFirstHit("😀a😀b", "b");
    expect(hit).toEqual({ codePointIndex: 3, codePointLength: 1 });
    expect(findFirstHit("ABC", "bc")).toEqual({
      codePointIndex: 1,
      codePointLength: 2,
    });
    expect(findFirstHit("abc", "z")).toBeNull();
    expect(findFirstHit("abc", "")).toBeNull();
  });

  it("builds max-512 snippets containing the first body hit", () => {
    expect(SNIPPET_MAX_CODE_POINTS).toBe(512);
    expect(SNIPPET_CONTEXT_BEFORE).toBeLessThan(512);
    const body = `${"x".repeat(600)}TARGET${"y".repeat(600)}`;
    const snippet = makeSnippet(body, "target");
    expect(countCodePointsLocal(snippet)).toBeLessThanOrEqual(512);
    expect(snippet.toLowerCase()).toContain("target");
    // First hit wins and leading context is bounded.
    const first = snippet.indexOf("TARGET");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThanOrEqual(SNIPPET_CONTEXT_BEFORE + 1);
  });

  it("handles astral prefix with long body deterministically", () => {
    const prefix = "😀".repeat(400);
    const body = `${prefix}HIT${"z".repeat(400)}`;
    const snippet = makeSnippet(body, "hit");
    expect(countCodePointsLocal(snippet)).toBeLessThanOrEqual(512);
    expect(snippet).toContain("HIT");
    expect(makeSnippet(body, "hit")).toBe(snippet);
  });

  it("returns a leading prefix when there is no hit", () => {
    const body = `${"q".repeat(600)}tail`;
    expect(makeSnippet(body, "missing")).toBe("q".repeat(512));
    expect(makeSnippet("short", "missing")).toBe("short");
  });

  it("flattens U+0130 one-to-many expansions for query and haystack", () => {
    const dotted = "İ"; // U+0130.
    // Lowered expansion is `i` + combining dot (two code points).
    expect(foldQuery(dotted)).toBe("i̇");
    expect(Array.from(foldQuery(dotted))).toEqual(["i", "̇"]);
    // Expansion matches itself with a single source-code-point span.
    expect(equalsFolded(dotted, dotted)).toBe(true);
    expect(containsFolded(dotted, dotted)).toBe(true);
    expect(findFirstHit(dotted, dotted)).toEqual({
      codePointIndex: 0,
      codePointLength: 1,
    });
    // Haystack containing U+0130 matches the same query and maps the span.
    expect(findFirstHit(`a${dotted}b`, dotted)).toEqual({
      codePointIndex: 1,
      codePointLength: 1,
    });
    // Long-body snippet still windows the original source deterministically.
    const body = `${"x".repeat(600)}${dotted}${"y".repeat(600)}`;
    const snippet = makeSnippet(body, dotted);
    expect(countCodePointsLocal(snippet)).toBeLessThanOrEqual(512);
    expect(snippet).toContain(dotted);
  });

  it("never uses locale-sensitive APIs", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const here = fileURLToPath(new URL("./", import.meta.url));
    const sources = [
      "text.ts",
      "markdown.ts",
      "roots.ts",
      "errors.ts",
      "unicode_case_fold.ts",
    ].map((name) => readFile(`${here}../src/${name}`, "utf8"));
    const contents = (await Promise.all(sources)).join("\n");
    // Doc comments may name the banned APIs; enforce absence of call sites.
    expect(contents).not.toContain("toLocaleLowerCase(");
    expect(contents).not.toContain("toLocaleUpperCase(");
    expect(contents).not.toContain("localeCompare(");
  });

  it("records the generated Unicode folding data version", () => {
    expect(UNICODE_DATA_VERSION).toBe("15.0.0");
    expect(TEXT_FOLD_UNICODE_VERSION).toBe(UNICODE_DATA_VERSION);
    // Full generated map: every code point whose casefold differs from
    // its lowercase mapping (CPython str.casefold() !== str.lower()).
    expect(CASE_FOLD_OVERRIDE_COUNT).toBe(297);
    expect(getCaseFoldOverride(0xdf)).toBe("ss");
    expect(getCaseFoldOverride(0x1e9e)).toBe("ss");
    expect(getCaseFoldOverride(0x3c2)).toBe("σ");
    expect(getCaseFoldOverride(0xfb01)).toBe("fi");
    // Plain letters have no override: the lowercase fallback applies.
    expect(getCaseFoldOverride(0x69)).toBeUndefined();
    expect(getCaseFoldOverride(0x41)).toBeUndefined();
  });

  it("folds sharp s (ß/ẞ) to ss", () => {
    expect(foldQuery("ß")).toBe("ss");
    expect(foldQuery("ẞ")).toBe("ss");
    expect(equalsFolded("ß", "ss")).toBe(true);
    expect(equalsFolded("ß", "ẞ")).toBe(true);
    expect(equalsFolded("STRASSE", "Straße")).toBe(true);
    expect(containsFolded("strasse", "ß")).toBe(true);
    expect(findFirstHit("strasse", "ß")).toEqual({
      codePointIndex: 4,
      codePointLength: 2,
    });
  });

  it("merges final sigma with medial sigma", () => {
    expect(foldQuery("ς")).toBe("σ");
    expect(equalsFolded("ς", "σ")).toBe(true);
    expect(equalsFolded("ς", "Σ")).toBe(true);
    expect(containsFolded("Ὀδυσσεύς", "ὀδυσσεύσ")).toBe(true);
  });

  it("expands compatibility ligatures", () => {
    expect(foldQuery("ﬁ")).toBe("fi");
    expect(foldQuery("ﬂ")).toBe("fl");
    expect(foldQuery("ﬀ")).toBe("ff");
    expect(equalsFolded("ﬁle", "file")).toBe(true);
    expect(containsFolded("ﬁle", "file")).toBe(true);
  });

  it("keeps dotted and dotless i distinct", () => {
    // U+0130 still expands through the lowercase fallback.
    expect(Array.from(foldQuery("İ"))).toEqual(["i", "̇"]);
    // Dotless ı (U+0131) is untouched by folding.
    expect(foldQuery("ı")).toBe("ı");
    expect(equalsFolded("I", "i")).toBe(true);
    expect(equalsFolded("I", "ı")).toBe(false);
    expect(equalsFolded("İ", "ı")).toBe(false);
    expect(containsFolded("Kılıç", "kılıç")).toBe(true);
    expect(containsFolded("Kilic", "Kılıç")).toBe(false);
  });

  it("folds Cherokee capitals to themselves, not lowercase", () => {
    // U+13A0 casefolds to itself while lowercase maps it to U+AB70, so
    // the override (not the fallback) must win.
    expect(foldQuery("Ꭰ")).toBe("Ꭰ");
    expect(foldQuery("ꭰ")).toBe("Ꭰ");
    expect(equalsFolded("Ꭰ", "ꭰ")).toBe(true);
  });

  it("finds the first folded occurrence with source mapping", () => {
    expect(findFirstHit("aaabaaab", "aaab")).toEqual({
      codePointIndex: 0,
      codePointLength: 4,
    });
    expect(findFirstHit("xxabcabxx", "abcab")).toEqual({
      codePointIndex: 2,
      codePointLength: 5,
    });
    expect(findFirstHit("ABC", "bc")).toEqual({
      codePointIndex: 1,
      codePointLength: 2,
    });
    expect(findFirstHit("strasse", "ß")).toEqual({
      codePointIndex: 4,
      codePointLength: 2,
    });
    const hooked = findFirstHitWithComparisons("xxabcabxx", "abcab");
    expect(hooked.hit).toEqual(findFirstHit("xxabcabxx", "abcab"));
    expect(hooked.comparisons).toBeGreaterThan(0);
    const rawHook = kmpIndexOfSequenceWithStats(
      Array.from("xxabcabxx"),
      Array.from("abcab"),
    );
    expect(rawHook.index).toBe(2);
  });

  it("matches folded queries in linear comparison steps", async () => {
    const hay = "a".repeat(1_000_000);
    const query = `${"a".repeat(255)}b`;
    const { hit, comparisons } = findFirstHitWithComparisons(hay, query);
    expect(hit).toBeNull();
    expect(comparisons).toBeLessThanOrEqual(4 * (hay.length + query.length));
    const found = findFirstHitWithComparisons(`${hay}b`, query);
    expect(found.hit).toEqual({
      codePointIndex: 1_000_000 - 255,
      codePointLength: 256,
    });
    expect(found.comparisons).toBeLessThanOrEqual(
      4 * (hay.length + 1 + query.length),
    );

    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const here = fileURLToPath(new URL("./", import.meta.url));
    const source = await readFile(`${here}../src/text.ts`, "utf8");
    expect(source).toContain("buildKmpPrefixTable");
    expect(source).not.toContain("continue outer");
    expect(source).not.toContain('join("").indexOf');
    expect(source).not.toContain("indexOfSequence(");
  });
});
