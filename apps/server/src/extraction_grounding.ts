// Shared speaker-grounding helpers for structured conversation extraction.
//
// Both memory extraction (#142) and learning extraction send an accepted turn
// to the same LOCAL gateway. The two speaker turns are untrusted model-facing
// data, so each is wrapped in `<user_message>` / `<assistant_message>` tags and
// entity-escaped; a model-supplied `evidence` quote is then accepted as
// "user-stated" ONLY when it is a verbatim (NFKC + whitespace-normalized)
// substring of the user's own turn. Quoting the assistant can never promote a
// claim to user-confirmed. These helpers are pure and shared so the two
// pipelines cannot drift apart.
//
// PR #142 checked the QUOTE only. A real quote can still back an unrelated or
// embellished BODY, so the body must also be grounded in the user's own words.
// The conservative coverage rule from the first pass rejected faithful
// paraphrases (colloquial user wording restated as formal prose) because it
// demanded 60% surface overlap. The current rule instead targets the signal we
// actually care about: substantive terms that occur in the assistant answer
// but NOT in the user turn. A very loose coverage floor remains only for
// near-zero overlap (e.g. a greeting-only turn that somehow produces a factual
// body). Both checks only DOWNGRADE provenance, never drop the item.

/**
 * Escape a speaker segment so content cannot close or open the extraction
 * delimiters (`<user_message>`, `<assistant_message>`). Both speaker blocks
 * are model-facing untrusted data; entity escaping is the only transformation
 * (no paraphrasing), so the model still sees the user's own words.
 */
export function escapeExtractionDelimiters(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** Reverse `escapeExtractionDelimiters` for a model-supplied evidence quote. */
export function unescapeExtractionDelimiters(text: string): string {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

/**
 * Grounding normalization: NFKC plus whitespace collapse/trim. This only
 * forgives formatting differences between a verbatim quote and the user's
 * turn; it never paraphrases and is deliberately case-sensitive.
 */
export function normalizeExtractionGrounding(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim();
}

/**
 * True only when `quote` is a non-empty verbatim substring of `source` after
 * grounding normalization. An empty quote never grounds anything.
 */
export function isGroundedExtractionQuote(
  quote: string,
  source: string,
): boolean {
  const normalizedQuote = normalizeExtractionGrounding(
    unescapeExtractionDelimiters(quote),
  );
  if (normalizedQuote.length === 0) return false;
  return normalizeExtractionGrounding(source).includes(normalizedQuote);
}

/**
 * Near-zero coverage floor. Paraphrase is explicitly allowed, so this is NOT
 * a similarity threshold: it only catches a body that shares almost nothing
 * with the user turn (for example a greeting-only turn whose body invents a
 * factual claim). Everything above this floor is judged by assistant-only
 * content terms instead.
 */
export const EXTRACTION_BODY_COVERAGE_MIN = 0.12;

/**
 * Assistant-derived body terms are tolerated only as isolated fragments. A
 * Japanese run of four or more characters (three overlapping bigrams) or an
 * ASCII word of five or more characters that occurs in the body and assistant
 * but NOT in the user turn is treated as assistant embellishment. Four/five
 * characters keeps common verbs and short generic words out; see
 * `EXTRACTION_BODY_GENERIC_TERMS`.
 */
export const EXTRACTION_ASSISTANT_RUN_MIN = 4;
export const EXTRACTION_ASSISTANT_ASCII_MIN = 5;

/**
 * A candidate assistant-only term is ignored when at least half of its
 * character bigrams already occur in the user turn. This treats a paraphrase
 * that reuses particles/conjugation (e.g. a verb restated in another form) as
 * covered, while a genuinely new content term still counts.
 */
export const EXTRACTION_TERM_COVERAGE_MAX = 0.5;

/**
 * Framing/extractionese removed before token comparison. Keep this list
 * SMALL and generic: it removes the "ユーザーは…" wrapper and common
 * report-verb endings, not topic words. Matching happens after coverage
 * normalization, and longer phrases are removed first so they cannot leave
 * a misleading fragment behind.
 */
export const EXTRACTION_BODY_FRAMING_PHRASES: readonly string[] = [
  "と考えている",
  "と感じている",
  "と述べた",
  "と言った",
  "における",
  "に対して",
  "によって",
  "として",
  "について",
  "に関して",
  "という",
  "ユーザーは",
  "ユーザーが",
  "ユーザーの",
  "ユーザー",
  "している",
  "したい",
  "である",
  "こと",
  "もの",
  "the user",
  "user",
];

/**
 * Generic words that carry no topic content and must never count as an
 * assistant-only addition. Covers particles, common verbs/auxiliaries,
 * report verbs, deictic words, and broad function nouns. Topic words (bike
 * models, URLs, technical names) are deliberately absent. Matching is
 * bidirectional substring: a fragment of a generic word (e.g. a 4-gram cut
 * out of プロジェクト) is also generic.
 */
export const EXTRACTION_BODY_GENERIC_TERMS: readonly string[] = [
  "している",
  "してる",
  "しまった",
  "てしま",
  "でしま",
  "すぎ",
  "あり",
  "いる",
  "ある",
  "なる",
  "する",
  "した",
  "して",
  "しない",
  "され",
  "行う",
  "行っ",
  "でき",
  "なっ",
  "おり",
  "おる",
  "やる",
  "くる",
  "いく",
  "おく",
  "もらう",
  "くれる",
  "あげる",
  "いただ",
  "くださ",
  "ござ",
  "です",
  "ます",
  "ません",
  "でしょう",
  "だろう",
  "こと",
  "もの",
  "ため",
  "ところ",
  "よう",
  "そう",
  "など",
  "なんか",
  "なんて",
  "って",
  "この",
  "その",
  "あの",
  "どの",
  "これ",
  "それ",
  "あれ",
  "どれ",
  "今日",
  "明日",
  "昨日",
  "今年",
  "去年",
  "来年",
  "自分",
  "僕",
  "私",
  "君",
  "あなた",
  "皆",
  "たち",
  "さん",
  "ちゃん",
  "プロジェクト",
  "サービス",
  "システム",
  "データ",
  "モデル",
  "アプリ",
  "アシスタント",
  "ユーザー",
  "ウェブ",
  "検索",
  "内容",
  "情報",
  "機能",
  "方法",
  "場合",
  "今回",
  "現在",
  "本当",
  "実際",
  "可能",
  "必要",
  "重要",
  "有効",
  "不安",
  "問題",
  "意味",
  "関係",
  "状態",
  "結果",
  "理由",
  "目的",
  "対象",
  "一部",
  "全て",
  "全部",
  "感じ",
  "考え",
  "思い",
  "述べ",
  "言っ",
  "尋ね",
  "話せ",
  "依頼",
  "指示",
  "利用",
  "使用",
  "管理",
  "変更",
  "参加",
  "予定",
  "興味",
  "関心",
  "遅刻",
  "挨拶",
  "日",
  "月",
  "年",
  "時間",
  "分",
  "秒",
  "今",
  "時点",
  "頃",
  "的",
  "化",
  "性",
  "者",
  "等",
  "theuser",
  "user",
  "assistant",
];

/** Coverage normalization: NFKC, lowercase, drop whitespace and punctuation. */
function normalizeCoverageText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, "");
}

/** Cheap kana folding: katakana -> hiragana so variant spellings match. */
function foldKana(text: string): string {
  return text.replace(/[\u30a1-\u30f6]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0x60),
  );
}

const FRAMING_NORMALIZED = EXTRACTION_BODY_FRAMING_PHRASES.map(
  normalizeCoverageText,
).sort((a, b) => b.length - a.length);

const GENERIC_NORMALIZED = EXTRACTION_BODY_GENERIC_TERMS.map(
  normalizeCoverageText,
).filter((term) => term.length > 0);

const GENERIC_PHRASES_NORMALIZED = GENERIC_NORMALIZED.filter(
  (term) => term.length >= 2,
).sort((a, b) => b.length - a.length);

const PARTICLES_NORMALIZED = /[はをがにでとのやもへ]/g;

function stripFraming(text: string): string {
  let out = normalizeCoverageText(text);
  for (const phrase of FRAMING_NORMALIZED) {
    if (phrase.length === 0) continue;
    out = out.split(phrase).join("");
  }
  return out;
}

/** Remove all multi-character generic words before token comparison. */
function stripGenericPhrases(text: string): string {
  let out = text;
  for (const phrase of GENERIC_PHRASES_NORMALIZED) {
    out = out.split(phrase).join("");
  }
  return out;
}

/**
 * Token form for term/run comparison: framing, generic words and single
 * particles are dropped so only substantive runs remain. This keeps a
 * boundary bigram cut out of a generic phrase from looking like content.
 */
function compactCoverageText(text: string): string {
  // A particle is a boundary, not something to weld across: removing it with
  // an empty replacement would invent terms ("犬と猫" -> "犬猫") that never
  // appeared in the body and can only match assistant text.
  return stripGenericPhrases(stripFraming(text)).replace(
    PARTICLES_NORMALIZED,
    " ",
  );
}

function isGenericTerm(term: string): boolean {
  for (const generic of GENERIC_NORMALIZED) {
    if (term === generic) return true;
    if (
      generic.length >= 2 &&
      (term.includes(generic) || generic.includes(term))
    ) {
      return true;
    }
  }
  return false;
}

const CJK_RUN_PATTERN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]+/gu;
const ASCII_WORD_PATTERN = /[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9_-]+)*/g;
const ASCII_FRAMING_TOKENS: ReadonlySet<string> = new Set([
  "the",
  "and",
  "for",
  "you",
  "that",
  "this",
  "with",
  "are",
  "was",
  "not",
  "but",
  "have",
  "has",
  "had",
  "will",
  "can",
  "just",
  "like",
  "about",
  "from",
  "your",
  "when",
  "what",
  "how",
  "why",
  "who",
  "its",
  "it",
  "is",
  "be",
  "to",
  "of",
  "in",
  "on",
  "at",
  "by",
  "as",
  "or",
  "an",
  "a",
  "user",
  "assistant",
]);

/**
 * ASCII terms from normalized text. Kept whole (split on the ORIGINAL
 * whitespace/punctuation boundaries), not after coverage normalization which
 * would weld a whole sentence into one token.
 */
function extractionAsciiTerms(text: string): Set<string> {
  const tokens = new Set<string>();
  const source = text.normalize("NFKC").toLowerCase();
  for (const match of source.matchAll(ASCII_WORD_PATTERN)) {
    if (match[0].length >= 2 && !ASCII_FRAMING_TOKENS.has(match[0])) {
      tokens.add(match[0]);
    }
  }
  return tokens;
}

/**
 * Ordinary English inflection folding for token comparison. Only suffixes
 * that change grammatical form are folded (plural/3rd-person -s/-es/-ies,
 * past -ed/-ied, progressive -ing, doubled final consonant), so a faithful
 * "likes" body is covered by a user "like" without accepting unrelated words.
 */
function asciiStems(word: string): string[] {
  if (word.length <= 4) return [word];
  let stem = word;
  if (stem.endsWith("ies") || stem.endsWith("ied")) {
    stem = `${stem.slice(0, -3)}y`;
  } else if (stem.endsWith("ing") && stem.length > 5) {
    stem = stem.slice(0, -3);
  } else if (stem.endsWith("ed") && stem.length > 4) {
    stem = stem.slice(0, -2);
  } else if (stem.endsWith("es") && stem.length > 4) {
    stem = stem.slice(0, -2);
  } else if (stem.endsWith("s") && !stem.endsWith("ss")) {
    stem = stem.slice(0, -1);
  }
  const stems = new Set([stem]);
  // "stopped" -> "stopp" and "running" -> "runn": also try the base form.
  if (stem.length > 3 && stem.endsWith(stem.slice(-2, -1))) {
    stems.add(stem.slice(0, -1));
  }
  // A silent final e ("lived" -> "liv" / "live").
  for (const variant of [...stems]) stems.add(`${variant}e`);
  return [...stems];
}

function sameAsciiStem(a: string, b: string): boolean {
  const stemsB = asciiStems(b);
  return asciiStems(a).some((stem) => stemsB.includes(stem));
}

/** Exact/substring or ordinary inflection coverage of one ASCII term. */
function containsAsciiInflection(text: string, term: string): boolean {
  if (containsCandidate(coverageHaystack(text), term)) return true;
  // Compare against EVERY word, not only content terms: a word that is
  // framing in one sentence ("I like coffee") can be the inflected verb the
  // body restates ("likes").
  for (const match of text
    .normalize("NFKC")
    .toLowerCase()
    .matchAll(ASCII_WORD_PATTERN)) {
    const token = match[0];
    if (token.length < 2) continue;
    if (token === term || sameAsciiStem(token, term)) return true;
  }
  return false;
}

/**
 * Absolute dates/times the extraction prompt requires resolving from the
 * supplied current date/time. They are sanctioned transformations, never
 * assistant embellishment.
 */
const RESOLVED_DATE_TIME_TERM =
  /^(?:\d{4}[-.]\d{1,2}[-.]\d{1,2}(?:t\d{1,2}:\d{2}(?::\d{2})?)?|\d{4}\/\d{1,2}\/\d{1,2}|\d{1,2}\/\d{1,2}(?:\/\d{4})?|\d{1,2}:\d{2}(?::\d{2})?|\d{4})$/;

/**
 * CJK bigrams plus ASCII terms. `stripped` is the coverage-normalized form
 * (used for CJK bigrams); `asciiSource` keeps original word boundaries so an
 * English sentence is not welded into one token.
 */
function extractionBigrams(stripped: string, asciiSource: string): Set<string> {
  const tokens = new Set<string>();
  // Fold kana so katakana/hiragana spellings of the same word ("バイト" and
  // "ばいと") compare equal. Kanji is unaffected.
  for (const match of foldKana(stripped).matchAll(CJK_RUN_PATTERN)) {
    const chars = Array.from(match[0]);
    for (let index = 0; index + 1 < chars.length; index += 1) {
      tokens.add(`${chars[index]}${chars[index + 1]}`);
    }
  }
  for (const token of extractionAsciiTerms(asciiSource)) tokens.add(token);
  return tokens;
}

/**
 * Content tokens for coverage: Japanese character bigrams plus ASCII words of
 * length >= 2. Bigrams are intentionally language-agnostic and require no
 * tokenizer; ASCII words are kept whole because they carry most identifiers.
 */
export function extractionContentTokens(text: string): Set<string> {
  return extractionBigrams(stripFraming(text), text);
}

interface CoverageHaystack {
  normalized: string;
  folded: string;
}

function coverageHaystack(text: string): CoverageHaystack {
  const normalized = normalizeCoverageText(text);
  return { normalized, folded: foldKana(normalized) };
}

function containsCandidate(haystack: CoverageHaystack, term: string): boolean {
  const normalizedTerm = normalizeCoverageText(term);
  return (
    haystack.normalized.includes(normalizedTerm) ||
    haystack.folded.includes(foldKana(normalizedTerm))
  );
}

/**
 * True when a text still contains something beyond framing/generic words.
 * A body that is only "ユーザーは…を依頼した" carries no topic content; the
 * coverage floor must not fire on it just because its surface form differs
 * from a short colloquial request.
 */
function hasSubstantiveCoverageTokens(text: string): boolean {
  if (
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]{2,}/u.test(
      compactCoverageText(text),
    )
  ) {
    return true;
  }
  for (const term of extractionAsciiTerms(text)) {
    if (term.length >= 2 && !isGenericTerm(term)) return true;
  }
  return false;
}

/**
 * Fraction of body content tokens present in the user's own turn. A body with
 * no substantive content (only framing/generic words) counts as fully covered:
 * there is nothing to verify and the quote check still applies. A body longer
 * than the user's turn that overlaps only on generic words is not a paraphrase
 * either, so it scores zero instead of being lifted over the floor by a single
 * function-word match.
 */
export function extractionBodyCoverage(body: string, userText: string): number {
  const bodyTokens = extractionContentTokens(body);
  if (bodyTokens.size === 0) return 1;
  if (!hasSubstantiveCoverageTokens(body)) return 1;
  const userTokens = extractionContentTokens(userText);
  let matched = 0;
  let substantiveMatched = 0;
  for (const token of bodyTokens) {
    if (!userTokens.has(token)) continue;
    matched += 1;
    if (!isGenericTerm(token)) substantiveMatched += 1;
  }
  if (substantiveMatched === 0 && bodyTokens.size > userTokens.size) return 0;
  return matched / bodyTokens.size;
}

/**
 * Fraction of a candidate term's bigrams already present in the user turn.
 * Used to forgive paraphrases that only differ by particles/conjugation.
 */
function extractionTermCoverage(
  term: string,
  userBigrams: ReadonlySet<string>,
): number {
  const termBigrams = extractionBigrams(term, term);
  if (termBigrams.size === 0) return 1;
  let matched = 0;
  for (const bigram of termBigrams) {
    if (userBigrams.has(bigram)) matched += 1;
  }
  return matched / termBigrams.size;
}

/**
 * True when the body contains a substantive term that is absent from the user
 * message but present in the assistant message: a >=4-character Japanese run
 * (three overlapping assistant-only bigrams) or a >=5-character assistant-only
 * ASCII word. Generic framing/verbs and terms already largely covered by the
 * user turn are ignored, so colloquial-to-formal paraphrases stay user_fact.
 */
export function hasAssistantDerivedBodyTerms(
  body: string,
  userText: string,
  assistantText: string | null | undefined,
): boolean {
  if (typeof assistantText !== "string") return false;
  const user = coverageHaystack(userText);
  const assistant = coverageHaystack(assistantText);
  const userBigrams = extractionBigrams(stripFraming(userText), userText);
  // Parenthetical asides are explanatory additions around the user-stated
  // core; judge the core, not the aside.
  const coreBody = body.replace(/[（(][^）)]*[）)]/gu, "");

  for (const term of extractionAsciiTerms(coreBody)) {
    if (term.length < EXTRACTION_ASSISTANT_ASCII_MIN) continue;
    if (isGenericTerm(term)) continue;
    // Resolved absolute dates/times come from the trusted current date/time,
    // not from the assistant's wording (memory extraction prompt).
    if (RESOLVED_DATE_TIME_TERM.test(term)) continue;
    if (containsAsciiInflection(userText, term)) continue;
    if (!containsAsciiInflection(assistantText, term)) continue;
    return true;
  }

  const compactBody = compactCoverageText(coreBody);
  for (const match of compactBody.matchAll(CJK_RUN_PATTERN)) {
    const chars = Array.from(match[0]);
    const seen = new Set<string>();
    for (
      let index = 0;
      index + EXTRACTION_ASSISTANT_RUN_MIN <= chars.length;
      index += 1
    ) {
      const term = chars
        .slice(index, index + EXTRACTION_ASSISTANT_RUN_MIN)
        .join("");
      if (seen.has(term)) continue;
      seen.add(term);
      if (isGenericTerm(term)) continue;
      if (containsCandidate(user, term)) continue;
      if (
        extractionTermCoverage(term, userBigrams) >=
        EXTRACTION_TERM_COVERAGE_MAX
      ) {
        continue;
      }
      if (!containsCandidate(assistant, term)) continue;
      return true;
    }
  }
  return false;
}

const CJK_SCRIPT_PATTERN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

function hasCjkScript(text: string): boolean {
  return CJK_SCRIPT_PATTERN.test(text);
}

/** Why a body was downgraded (fixed diagnostic values, never content). */
export type ExtractionBodyDowngrade = "coverage" | "assistant_terms";

/**
 * Body-level sibling of `isGroundedExtractionQuote`. Returns null when the
 * body is grounded, otherwise the first failing check. Without a user turn
 * (legacy direct parser callers) no verdict is possible and null is returned.
 */
export function extractionBodyDowngrade(
  body: string,
  userText: string | null | undefined,
  assistantText: string | null | undefined,
): ExtractionBodyDowngrade | null {
  if (typeof userText !== "string") return null;
  // The extractor writes a Japanese body even for a non-Japanese user turn
  // (MEMORY_EXTRACT_SYSTEM_PROMPT). Surface overlap cannot judge a mandated
  // translation, so cross-script pairs rely on the verbatim evidence quote.
  if (hasCjkScript(body) !== hasCjkScript(userText)) return null;
  if (extractionBodyCoverage(body, userText) < EXTRACTION_BODY_COVERAGE_MIN) {
    return "coverage";
  }
  if (hasAssistantDerivedBodyTerms(body, userText, assistantText)) {
    return "assistant_terms";
  }
  return null;
}
