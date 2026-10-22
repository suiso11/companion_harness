// Pure voice gate: structural fidelity checks between the canonical answer
// parts and a candidate voiced rendering. The gate never repairs, rewrites,
// or normalizes the voiced text; it only accepts or rejects with a fixed
// reason. The canonical answer always stays authoritative.
//
// Checks run part by part (never on the joined answer), so moving a number,
// citation, URL, or code span between parts is always a rejection:
// - citation markers (`rN` / `mN`) per part,
// - number tokens per part, compared as an ordered list. Tokens keep their
//   separators (`10:00`, `48,000`, `2026-10-22`); fullwidth digits are
//   normalized first,
// - kanji numerals followed by a counter are converted to values; each
//   voiced value must equal a number present in the canonical part unless
//   the same kanji run appears in the canonical text verbatim,
// - negation markers per part (a flipped or added negation is rejected).
//   Kansai demonstrative/interrogative words that merely contain 「ない」
//   (どない, そない, こない, あない and their -な/-に/-して forms) are masked
//   before counting, because they are not negations,
// - ASCII words of two or more letters (identifiers, acronyms),
// - URLs (multiset per part),
// - fenced code blocks / inline code spans (byte-identical, in order).
// A per-part length ratio in [0.5, 2.5] prevents runaway additions; very
// short canonical parts (under 20 code points) may expand to at most 50
// code points.

import { countCodePoints, type VoiceRenderReason } from "@companion/contracts";

export type VoiceGateReason = Extract<
  VoiceRenderReason,
  | "part_count"
  | "citation_marker"
  | "number"
  | "negation"
  | "latin"
  | "url"
  | "code_block"
  | "length"
>;

const CITATION_MARKER_PATTERN = /\b[rm][1-9][0-9]*\b/g;
const NUMBER_TOKEN_PATTERN = /[0-9]+(?:[.,:/-][0-9]+)*/g;
const ASCII_WORD_PATTERN = /[A-Za-z]{2,}/g;
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`）】」]+/g;
const CODE_SPAN_PATTERN = /```[\s\S]*?```|`[^`\n]+`/g;
const FULLWIDTH_DIGIT_PATTERN = /[０-９]/g;
const NEGATION_PATTERN =
  /ない|なかっ|なく|ません|まへん|へん|ひん|あかん|ず(?=[、。に])|ぬ(?=[、。])|ませぬ|不可|禁止/g;
// Kansai demonstrative/interrogative words that contain 「ない」 but carry no
// negation. Longest surface forms are matched first via the optional suffix.
const NON_NEGATION_NAI_PATTERN = /(?:ど|そ|こ|あ)ない(?:して|な|に)?/g;
const NON_NEGATION_NAI_MASK = "＊";
const KANJI_NUMERAL_SOURCE =
  "([〇一二三四五六七八九十百千万]+)(つ|個|人|日|時|分|年|月|件|回|円|%|割|週|本|枚|度)";
const KANJI_DIGITS = new Map<string, number>([
  ["〇", 0],
  ["一", 1],
  ["二", 2],
  ["三", 3],
  ["四", 4],
  ["五", 5],
  ["六", 6],
  ["七", 7],
  ["八", 8],
  ["九", 9],
]);
const KANJI_SMALL_UNITS = new Map<string, number>([
  ["十", 10],
  ["百", 100],
  ["千", 1000],
]);
const MIN_RATIO_CANONICAL_CODE_POINTS = 20;
const MAX_SHORT_VOICED_CODE_POINTS = 50;
const MIN_LENGTH_RATIO = 0.5;
const MAX_LENGTH_RATIO = 2.5;

function matches(text: string, pattern: RegExp): string[] {
  return text.match(pattern) ?? [];
}

function normalizeFullwidthDigits(text: string): string {
  return text.replace(FULLWIDTH_DIGIT_PATTERN, (digit) =>
    String.fromCharCode(digit.charCodeAt(0) - 0xff10 + 0x30),
  );
}

function countMultiset(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function sameMultiset(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const leftCounts = countMultiset(left);
  const rightCounts = countMultiset(right);
  for (const [value, count] of leftCounts) {
    if (rightCounts.get(value) !== count) {
      return false;
    }
  }
  return true;
}

function sameSequence(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}

function citationMarkers(text: string): string[] {
  return matches(text, CITATION_MARKER_PATTERN);
}

function numberTokens(text: string): string[] {
  return matches(normalizeFullwidthDigits(text), NUMBER_TOKEN_PATTERN);
}

function asciiWords(text: string): string[] {
  return matches(text, ASCII_WORD_PATTERN);
}

function urls(text: string): string[] {
  return matches(text, URL_PATTERN).map((url) =>
    url.replace(/[.,;:!?]+$/u, ""),
  );
}

function codeSpans(text: string): string[] {
  return matches(text, CODE_SPAN_PATTERN);
}

function maskNonNegationNai(text: string): string {
  return text.replace(NON_NEGATION_NAI_PATTERN, NON_NEGATION_NAI_MASK);
}

function negationMarkers(text: string): string[] {
  return matches(maskNonNegationNai(text), NEGATION_PATTERN);
}

interface KanjiNumeral {
  readonly run: string;
  readonly value: number;
}

/** Convert one kanji numeral run (e.g. 二十三, 一万二千, 二〇二六). */
export function kanjiNumeralValue(run: string): number | null {
  let hasUnit = false;
  for (const char of run) {
    if (KANJI_SMALL_UNITS.has(char) || char === "万") {
      hasUnit = true;
      break;
    }
  }
  if (!hasUnit) {
    let digits = "";
    for (const char of run) {
      const digit = KANJI_DIGITS.get(char);
      if (digit === undefined) {
        return null;
      }
      digits += String(digit);
    }
    return Number(digits);
  }
  let total = 0;
  let section = 0;
  let current = 0;
  for (const char of run) {
    const digit = KANJI_DIGITS.get(char);
    if (digit !== undefined) {
      current = digit;
      continue;
    }
    const smallUnit = KANJI_SMALL_UNITS.get(char);
    if (smallUnit !== undefined) {
      section += (current === 0 ? 1 : current) * smallUnit;
      current = 0;
      continue;
    }
    if (char === "万") {
      section += current;
      total += (section === 0 ? 1 : section) * 10_000;
      section = 0;
      current = 0;
      continue;
    }
    return null;
  }
  return total + section + current;
}

function kanjiNumerals(text: string): KanjiNumeral[] {
  const pattern = new RegExp(KANJI_NUMERAL_SOURCE, "g");
  const out: KanjiNumeral[] = [];
  for (const match of text.matchAll(pattern)) {
    const run = match[1];
    if (run === undefined) {
      continue;
    }
    const value = kanjiNumeralValue(run);
    if (value !== null) {
      out.push({ run, value });
    }
  }
  return out;
}

/**
 * Numeric values carried by ASCII digit tokens in a canonical part. Tokens
 * with separators contribute their digit groups (and a thousands-normalized
 * value for comma/period groups) so a kanji reading can match `48,000`.
 */
function digitTokenValues(tokens: readonly string[]): number[] {
  const values: number[] = [];
  for (const token of tokens) {
    if (!/[.,:/-]/.test(token)) {
      values.push(Number(token));
      continue;
    }
    for (const group of token.split(/[.,:/-]/)) {
      if (group.length > 0) {
        values.push(Number(group));
      }
    }
    if (/^[0-9]+(?:[.,][0-9]+)+$/.test(token)) {
      values.push(Number(token.replace(/[.,]/g, "")));
    }
  }
  return values;
}

function kanjiNumbersMatch(canonical: string, voiced: string): boolean {
  const voicedNumerals = kanjiNumerals(voiced);
  if (voicedNumerals.length === 0) {
    return true;
  }
  const allowed = new Set([
    ...digitTokenValues(numberTokens(canonical)),
    ...kanjiNumerals(canonical).map((numeral) => numeral.value),
  ]);
  return voicedNumerals.every(
    (numeral) => canonical.includes(numeral.run) || allowed.has(numeral.value),
  );
}

function lengthRatioOk(canonical: string, voiced: string): boolean {
  const voicedLength = countCodePoints(voiced);
  if (voicedLength === 0) {
    return false;
  }
  const canonicalLength = countCodePoints(canonical);
  if (canonicalLength < MIN_RATIO_CANONICAL_CODE_POINTS) {
    return voicedLength <= MAX_SHORT_VOICED_CODE_POINTS;
  }
  const ratio = voicedLength / canonicalLength;
  return ratio >= MIN_LENGTH_RATIO && ratio <= MAX_LENGTH_RATIO;
}

/**
 * Check one canonical/voiced part pair. Returns the first fixed gate reason
 * or null when the pair preserves every structural invariant.
 */
export function checkVoicePart(
  canonical: string,
  voiced: string,
): VoiceGateReason | null {
  if (!sameMultiset(citationMarkers(canonical), citationMarkers(voiced))) {
    return "citation_marker";
  }
  if (!sameSequence(numberTokens(canonical), numberTokens(voiced))) {
    return "number";
  }
  if (!kanjiNumbersMatch(canonical, voiced)) {
    return "number";
  }
  if (negationMarkers(canonical).length !== negationMarkers(voiced).length) {
    return "negation";
  }
  if (!sameMultiset(asciiWords(canonical), asciiWords(voiced))) {
    return "latin";
  }
  if (!sameMultiset(urls(canonical), urls(voiced))) {
    return "url";
  }
  if (!sameSequence(codeSpans(canonical), codeSpans(voiced))) {
    return "code_block";
  }
  if (!lengthRatioOk(canonical, voiced)) {
    return "length";
  }
  return null;
}

/**
 * Whole-answer gate: part count must match and every canonical/voiced part
 * pair is checked independently (never as a joined document). Returns the
 * first fixed reason or null.
 */
export function checkVoiceAnswer(
  canonicalParts: readonly string[],
  voicedParts: readonly string[],
): VoiceGateReason | null {
  if (canonicalParts.length !== voicedParts.length) {
    return "part_count";
  }
  for (let index = 0; index < canonicalParts.length; index += 1) {
    const reason = checkVoicePart(
      canonicalParts[index] ?? "",
      voicedParts[index] ?? "",
    );
    if (reason !== null) {
      return reason;
    }
  }
  return null;
}
