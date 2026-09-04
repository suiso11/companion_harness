/**
 * Deterministic text primitives: NFC, locale-independent folding,
 * whole-query literal matching, and bounded snippets.
 *
 * NORMALIZATION: everything is NFC (`String.normalize("NFC")`) before
 * comparison or snippet windowing.
 *
 * CASE FOLDING (documented approximation): Unicode default case-insensitive
 * matching approximated by `String.toLowerCase` applied per Unicode code
 * point (locale-independent by construction; never `toLocaleLowerCase`,
 * `toLocaleUpperCase`, or `localeCompare`). Per-code-point application keeps
 * astral characters intact via `Array.from` iteration.
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

/** Maximum snippet length in Unicode code points. */
export const SNIPPET_MAX_CODE_POINTS = 512;

/** Leading context (code points) before the first body hit in a snippet. */
export const SNIPPET_CONTEXT_BEFORE = 64;

/** NFC-normalize text. */
export function normalizeNFC(value: string): string {
  return value.normalize("NFC");
}

/** Fold already-NFC text per code point with locale-independent lowercase. */
function foldCodePoints(normalized: string): string[] {
  return Array.from(normalized).map((ch) => ch.toLowerCase());
}

/**
 * NFC + per-code-point lowercase folding for a query.
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
 * Handles 1-to-N lowercase expansions (e.g. U+0130) deterministically.
 */
function foldWithMapping(normalized: string): {
  foldedCps: string[];
  map: number[];
} {
  const foldedCps: string[] = [];
  const map: number[] = [];
  const sourceCps = Array.from(normalized);
  for (let i = 0; i < sourceCps.length; i += 1) {
    const lowered = (sourceCps[i] as string).toLowerCase();
    for (const cp of Array.from(lowered)) {
      foldedCps.push(cp);
      map.push(i);
    }
  }
  return { foldedCps, map };
}

/** Literal code-point subsequence search; -1 when absent. */
function indexOfSequence(
  hay: readonly string[],
  needle: readonly string[],
): number {
  if (needle.length === 0) return -1;
  outer: for (let i = 0; i + needle.length <= hay.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/** Whole-query literal equality under NFC + folding. Empty never equals. */
export function equalsFolded(a: string, b: string): boolean {
  const foldedA = foldCodePoints(normalizeNFC(a)).join("");
  const foldedB = foldCodePoints(normalizeNFC(b)).join("");
  if (foldedA === "" || foldedB === "") return false;
  return foldedA === foldedB;
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
  const foldedIndex = indexOfSequence(foldedCps, queryCps);
  if (foldedIndex < 0) return null;
  const firstSource = map[foldedIndex] as number;
  const lastSource = map[foldedIndex + queryCps.length - 1] as number;
  return {
    codePointIndex: firstSource,
    codePointLength: lastSource - firstSource + 1,
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
