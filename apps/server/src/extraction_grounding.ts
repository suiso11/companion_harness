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
// embellished BODY, so the body must also be covered by the user's own words.
// `extractionBodyDowngrade` is that second, deliberately conservative check:
// it can only DOWNGRADE provenance, never drop the extracted memory/lesson.

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
 * Minimum fraction of a body's content tokens that must occur in the USER's
 * own turn before the body can remain `user_fact` / `user_confirmed_feedback`.
 *
 * 0.6 is deliberately high: a user_stated fact that shares fewer than three
 * fifths of its content with the user's turn is usually the model's own
 * elaboration. It does make the rule conservative for heavily paraphrased
 * (e.g. colloquial-to-formal) bodies; those are downgraded rather than risked
 * as user-stated facts. Downgrade-only means the memory/lesson is preserved.
 */
export const EXTRACTION_BODY_COVERAGE_MIN = 0.6;

/**
 * Assistant-derived body terms are tolerated only as isolated fragments. A
 * Japanese run of three or more characters (two overlapping bigrams) or an
 * ASCII word of four or more characters that occurs in the body and assistant
 * but NOT in the user turn is treated as assistant embellishment.
 */
export const EXTRACTION_ASSISTANT_RUN_MIN = 3;
export const EXTRACTION_ASSISTANT_ASCII_MIN = 4;

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
  "ユーザーは",
  "ユーザーが",
  "ユーザーの",
  "ユーザー",
  "している",
  "について",
  "という",
  "である",
  "したい",
  "こと",
  "もの",
  "the user",
  "user",
];

/** Coverage normalization: NFKC, lowercase, drop whitespace and punctuation. */
function normalizeCoverageText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, "");
}

const FRAMING_NORMALIZED = EXTRACTION_BODY_FRAMING_PHRASES.map(
  normalizeCoverageText,
).sort((a, b) => b.length - a.length);

function stripFraming(text: string): string {
  let out = normalizeCoverageText(text);
  for (const phrase of FRAMING_NORMALIZED) {
    if (phrase.length === 0) continue;
    out = out.split(phrase).join("");
  }
  return out;
}

const CJK_RUN_PATTERN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]+/gu;
const ASCII_WORD_PATTERN = /[a-z0-9][a-z0-9_-]+/g;
const ASCII_FRAMING_TOKENS: ReadonlySet<string> = new Set(["user"]);

/**
 * Content tokens for coverage: Japanese character bigrams plus ASCII words of
 * length >= 2. Bigrams are intentionally language-agnostic and require no
 * tokenizer; ASCII words are kept whole because they carry most identifiers.
 * ASCII words are split on their original whitespace/punctuation boundaries,
 * NOT after coverage normalization (which would weld a whole sentence into
 * one token).
 */
export function extractionContentTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  const asciiSource = text.normalize("NFKC").toLowerCase();
  for (const match of asciiSource.matchAll(ASCII_WORD_PATTERN)) {
    if (!ASCII_FRAMING_TOKENS.has(match[0])) tokens.add(match[0]);
  }
  const japaneseSource = stripFraming(text);
  for (const match of japaneseSource.matchAll(CJK_RUN_PATTERN)) {
    const chars = Array.from(match[0]);
    for (let index = 0; index + 1 < chars.length; index += 1) {
      tokens.add(`${chars[index]}${chars[index + 1]}`);
    }
  }
  return tokens;
}

/**
 * Fraction of body content tokens present in the user's own turn. A body with
 * no content tokens (only framing) counts as fully covered: there is nothing
 * substantive to verify and the quote check still applies.
 */
export function extractionBodyCoverage(body: string, userText: string): number {
  const bodyTokens = extractionContentTokens(body);
  if (bodyTokens.size === 0) return 1;
  const userTokens = extractionContentTokens(userText);
  let matched = 0;
  for (const token of bodyTokens) {
    if (userTokens.has(token)) matched += 1;
  }
  return matched / bodyTokens.size;
}

/**
 * True when the body contains a substantive term that is absent from the user
 * message but present in the assistant message: a >=3-character Japanese run
 * (two overlapping assistant-only bigrams) or a >=4-character assistant-only
 * ASCII word. Isolated differences are tolerated.
 */
export function hasAssistantDerivedBodyTerms(
  body: string,
  userText: string,
  assistantText: string | null | undefined,
): boolean {
  if (typeof assistantText !== "string") return false;
  const bodyTokens = extractionContentTokens(body);
  if (bodyTokens.size === 0) return false;
  const userTokens = extractionContentTokens(userText);
  const assistantTokens = extractionContentTokens(assistantText);
  const assistantOnly = new Set<string>();
  for (const token of bodyTokens) {
    if (!userTokens.has(token) && assistantTokens.has(token)) {
      assistantOnly.add(token);
    }
  }
  if (assistantOnly.size === 0) return false;
  for (const token of assistantOnly) {
    if (
      token.length >= EXTRACTION_ASSISTANT_ASCII_MIN &&
      /^[a-z0-9]/.test(token)
    ) {
      return true;
    }
  }
  const chars = Array.from(stripFraming(body));
  for (let index = 0; index + 2 < chars.length; index += 1) {
    const first = `${chars[index]}${chars[index + 1]}`;
    const second = `${chars[index + 1]}${chars[index + 2]}`;
    if (assistantOnly.has(first) && assistantOnly.has(second)) return true;
  }
  return false;
}

/** Why a body was downgraded (fixed diagnostic values, never content). */
export type ExtractionBodyDowngrade = "coverage" | "assistant_terms";

/**
 * Body-level sibling of `isGroundedExtractionQuote`. Returns null when the
 * body is covered, otherwise the first failing check. Without a user turn
 * (legacy direct parser callers) no verdict is possible and null is returned.
 */
export function extractionBodyDowngrade(
  body: string,
  userText: string | null | undefined,
  assistantText: string | null | undefined,
): ExtractionBodyDowngrade | null {
  if (typeof userText !== "string") return null;
  if (extractionBodyCoverage(body, userText) < EXTRACTION_BODY_COVERAGE_MIN) {
    return "coverage";
  }
  if (hasAssistantDerivedBodyTerms(body, userText, assistantText)) {
    return "assistant_terms";
  }
  return null;
}
