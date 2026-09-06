/**
 * Deterministic text primitives: NFC, locale-independent folding,
 * whole-query literal matching, and bounded snippets.
 *
 * NORMALIZATION: everything is NFC (`String.normalize("NFC")`) before
 * comparison or snippet windowing.
 *
 * CASE FOLDING: Unicode default case-insensitive matching via the
 * generated static map in `unicode_case_fold.ts` (every code point whose
 * default case fold differs from its lowercase mapping, generated from
 * Python `str.casefold() !== str.lower()` with the Unicode data version
 * recorded there), with a locale-independent `String.toLowerCase` fallback
 * for unlisted code points (never `toLocaleLowerCase`,
 * `toLocaleUpperCase`, or `localeCompare`). Folding applies per Unicode
 * code point (astral-safe via `Array.from` iteration), and one-to-many
 * expansions (e.g. U+00DF `ß` -> `ss`, U+0130 `İ` -> `i` + combining dot)
 * are flattened into individual code points so queries fold exactly like
 * haystacks.
 *
 * MATCHING: whole-query literal equality/substring only (sequence search,
 * never regex interpretation of the query). `findFirstHit` maps the folded
 * hit back to source code-point indices so snippets window the original
 * (normalized) body deterministically.
 *
 * SNIPPETS: at most 512 Unicode code points, always containing the first
 * body hit when one exists (`SNIPPET_CONTEXT_BEFORE` code points of leading
 * context, shifted to fit).
 */

import { foldCharCaseFold, UNICODE_DATA_VERSION } from "./unicode_case_fold.js";

/** Unicode data version backing the case-fold override map. */
export const TEXT_FOLD_UNICODE_VERSION = UNICODE_DATA_VERSION;

/** Maximum snippet length in Unicode code points. */
export const SNIPPET_MAX_CODE_POINTS = 512;

/** Leading context (code points) before the first body hit in a snippet. */
export const SNIPPET_CONTEXT_BEFORE = 64;

/** NFC-normalize text. */
export function normalizeNFC(value: string): string {
  return value.normalize("NFC");
}

/** Fold already-NFC text per code point with Unicode default case folding.
 * Each source code point folds through the generated override map with a
 * locale-independent lowercase fallback, then flattens into individual
 * Unicode code points, so one-to-many expansions (e.g. U+00DF `ß` -> `ss`,
 * U+0130 `İ` -> `i` + combining dot) expand exactly like the haystack
 * mapping. */
function foldCodePoints(normalized: string): string[] {
  const out: string[] = [];
  for (const ch of Array.from(normalized)) {
    for (const cp of Array.from(foldCharCaseFold(ch))) {
      out.push(cp);
    }
  }
  return out;
}

/**
 * NFC + per-code-point default case folding for a query.
 * Pure structural fold; length validation lives in later slices.
 */
export function foldQuery(query: string): string {
  return foldCodePoints(normalizeNFC(query)).join("");
}

/** Count Unicode code points (astral-safe). */
export function countCodePointsLocal(value: string): number {
  return Array.from(value).length;
}

/** Slice by Unicode code-point indices `[start, end)`. */
export function sliceCodePoints(
  value: string,
  start: number,
  end?: number,
): string {
  const cps = Array.from(value);
  const from = Math.max(0, Math.trunc(start));
  const to = end === undefined ? cps.length : Math.max(0, Math.trunc(end));
  return cps.slice(from, to).join("");
}

export interface TextHit {
  /** Source (NFC body) code-point index of the hit start. */
  codePointIndex: number;
  /** Source code-point length covered by the hit. */
  codePointLength: number;
}

/**
 * Folded haystack plus per-folded-code-point map back to source indices.
 * Handles 1-to-N case-fold expansions (e.g. U+00DF, U+0130)
 * deterministically.
 */
function foldWithMapping(normalized: string): {
  foldedCps: string[];
  map: number[];
} {
  const foldedCps: string[] = [];
  const map: number[] = [];
  const sourceCps = Array.from(normalized);
  for (let i = 0; i < sourceCps.length; i += 1) {
    const folded = foldCharCaseFold(sourceCps[i] as string);
    for (const cp of Array.from(folded)) {
      foldedCps.push(cp);
      map.push(i);
    }
  }
  return { foldedCps, map };
}

/** KMP prefix table for a folded code-point needle; O(m) time. */
export function buildKmpPrefixTable(needle: readonly string[]): number[] {
  const pi = new Array<number>(needle.length).fill(0);
  for (let i = 1; i < needle.length; i += 1) {
    let j = pi[i - 1] as number;
    for (;;) {
      if (needle[i] === needle[j]) {
        j += 1;
        break;
      }
      if (j === 0) break;
      j = pi[j - 1] as number;
    }
    pi[i] = j;
  }
  return pi;
}

/**
 * Linear KMP subsequence search over folded code points; -1 when absent.
 * Builds the prefix table in O(m) and scans the haystack in O(n),
 * returning the first occurrence exactly. `stats` counts code-point
 * comparisons (prefix + scan) when provided; pass null on hot paths.
 */
function kmpIndexOfSequence(
  hay: readonly string[],
  needle: readonly string[],
  stats: { comparisons: number } | null,
): number {
  if (needle.length === 0) return -1;
  const pi = new Array<number>(needle.length).fill(0);
  for (let i = 1; i < needle.length; i += 1) {
    let j = pi[i - 1] as number;
    for (;;) {
      if (stats !== null) stats.comparisons += 1;
      if (needle[i] === needle[j]) {
        j += 1;
        break;
      }
      if (j === 0) break;
      j = pi[j - 1] as number;
    }
    pi[i] = j;
  }
  let j = 0;
  for (let i = 0; i < hay.length; i += 1) {
    for (;;) {
      if (stats !== null) stats.comparisons += 1;
      if (hay[i] === needle[j]) {
        j += 1;
        break;
      }
      if (j === 0) break;
      j = pi[j - 1] as number;
    }
    if (j === needle.length) return i - j + 1;
  }
  return -1;
}

/**
 * Test-only KMP hook (not re-exported from the package index). Same first
 * occurrence as the internal search plus the deterministic comparison
 * count (prefix + scan), so adversarial inputs can assert a linear bound
 * without relying on wall-clock timing.
 */
export function kmpIndexOfSequenceWithStats(
  hay: readonly string[],
  needle: readonly string[],
): { index: number; comparisons: number } {
  const stats = { comparisons: 0 };
  const index = kmpIndexOfSequence(hay, needle, stats);
  return { index, comparisons: stats.comparisons };
}

/** Whole-query literal equality under NFC + folding. Empty never equals. */
export function equalsFolded(a: string, b: string): boolean {
  const foldedA = foldCodePoints(normalizeNFC(a));
  const foldedB = foldCodePoints(normalizeNFC(b));
  if (foldedA.length === 0 || foldedB.length === 0) return false;
  if (foldedA.length !== foldedB.length) return false;
  for (let i = 0; i < foldedA.length; i += 1) {
    if (foldedA[i] !== foldedB[i]) return false;
  }
  return true;
}

/** Whole-query literal substring under NFC + folding. Empty query: false. */
export function containsFolded(haystack: string, query: string): boolean {
  return findFirstHit(haystack, query) !== null;
}

/**
 * First whole-query literal hit mapped to source (NFC body) code-point
 * indices, or null. Empty/whitespace-only queries are not hits: empty is
 * null, and blank queries match literally like any other sequence.
 */
export function findFirstHit(haystack: string, query: string): TextHit | null {
  const normalizedHay = normalizeNFC(haystack);
  const normalizedQuery = normalizeNFC(query);
  const queryCps = foldCodePoints(normalizedQuery);
  if (queryCps.length === 0) return null;
  const { foldedCps, map } = foldWithMapping(normalizedHay);
  const foldedIndex = kmpIndexOfSequence(foldedCps, queryCps, null);
  if (foldedIndex < 0) return null;
  const firstSource = map[foldedIndex] as number;
  const lastSource = map[foldedIndex + queryCps.length - 1] as number;
  return {
    codePointIndex: firstSource,
    codePointLength: lastSource - firstSource + 1,
  };
}

/**
 * Test-only first-hit hook (not re-exported from the package index).
 * Same hit as {@link findFirstHit} plus the deterministic KMP comparison
 * count, so adversarial inputs can assert linear matching bounds.
 */
export function findFirstHitWithComparisons(
  haystack: string,
  query: string,
): { hit: TextHit | null; comparisons: number } {
  const normalizedHay = normalizeNFC(haystack);
  const normalizedQuery = normalizeNFC(query);
  const queryCps = foldCodePoints(normalizedQuery);
  if (queryCps.length === 0) return { hit: null, comparisons: 0 };
  const { foldedCps, map } = foldWithMapping(normalizedHay);
  const stats = { comparisons: 0 };
  const foldedIndex = kmpIndexOfSequence(foldedCps, queryCps, stats);
  if (foldedIndex < 0) return { hit: null, comparisons: stats.comparisons };
  const firstSource = map[foldedIndex] as number;
  const lastSource = map[foldedIndex + queryCps.length - 1] as number;
  return {
    hit: {
      codePointIndex: firstSource,
      codePointLength: lastSource - firstSource + 1,
    },
    comparisons: stats.comparisons,
  };
}

/**
 * Deterministic snippet of at most 512 code points from the NFC body,
 * containing the first body hit when one exists. No hit (or empty query):
 * leading 512-code-point prefix.
 */
export function makeSnippet(body: string, query: string): string {
  const normalized = normalizeNFC(body);
  const total = countCodePointsLocal(normalized);
  if (total <= SNIPPET_MAX_CODE_POINTS) return normalized;
  const hit = findFirstHit(normalized, query);
  if (hit === null) {
    return sliceCodePoints(normalized, 0, SNIPPET_MAX_CODE_POINTS);
  }
  let start = Math.max(0, hit.codePointIndex - SNIPPET_CONTEXT_BEFORE);
  let end = start + SNIPPET_MAX_CODE_POINTS;
  if (end > total) {
    end = total;
    start = Math.max(0, end - SNIPPET_MAX_CODE_POINTS);
  }
  return sliceCodePoints(normalized, start, end);
}
