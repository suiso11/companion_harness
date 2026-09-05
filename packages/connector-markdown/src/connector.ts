/**
 * Public standalone MarkdownConnector over roots/discovery/safe_read/text/
 * markdown modules.
 *
 * SCOPE: deterministic, path-free search + canonical read. Discovery runs
 * before any content byte; every discovered candidate gets exactly one
 * bounded safe read; oversize/invalid-UTF8 files become explicit `skipped`
 * entries (never throws, never truncated to the result limit).
 *
 * BOUNDS (exact, plan 14.6): query 1-256 Unicode code points, limit
 * default 10 / max 20, snippet max 512 code points. A whitespace-only query
 * is a literal query: it is never trimmed, never rejected as blank.
 *
 * MATCHING: whole-query literal substring under NFC + locale-independent
 * per-code-point lowercase folding. No tokenization, FTS, regex query
 * interpretation, semantic, or fuzzy behavior. Ranking is exact:
 * title equality (rank 0) -> title substring (rank 1) -> body substring
 * (rank 2); ties break by canonical-key UTF-16 code-unit order (`<`/`>`).
 *
 * SNIPPETS: `makeSnippet` over the NFC body (max 512 code points,
 * containing the first body hit when one exists). Title-only hits
 * deterministically fall back to the leading body prefix; an empty body
 * falls back to the title slice so snippets are never empty.
 *
 * TITLE: first heading plain text bounded to a ReferenceTitle-compatible
 * deterministic prefix (max 512 UTF-16 code units, surrogate-safe), else
 * the canonical filename stem (already bounded by the canonical key), or
 * the canonical basename `.md` when the stem is empty.
 *
 * SOURCE REVISION: SHA-256 hex of the NFC full text (stable for identical
 * content). Hits also carry the full normalized text for later
 * ResourceObservation integration -- never an absolute path.
 *
 * LINKS:
 * - Standard relative `.md` links resolve against the source file's
 *   directory inside the same root. `..` escapes above the root are
 *   `unresolved` and never opened. Each surviving candidate is
 *   canonicalized metadata-only (`realpath` inside the owning root,
 *   containment + canonical grammar/bounds checked, then converted to
 *   `<alias>/<realpath-relative posix>`) and existence-checked against
 *   the discovery set: `resolved` carries the discovered real canonical
 *   key (so `alias.md -> real.md` and `aliasDir/note.md -> realDir/note.md`
 *   fold without duplicates), otherwise `unresolved` with no guess. No
 *   file content is read to resolve links and no alias map persists.
 * - Wiki subset (`[[Target]]`) deterministically collects, in code-unit
 *   order: (1) source-directory-relative `Target(.md)`, (2) root-relative
 *   `Target(.md)`, (3) any same-root file whose basename equals the target
 *   basename. Relative/root candidates fold through the same metadata-only
 *   canonicalization (duplicate alias spellings collapse to one real key
 *   before dedup); basename candidates are already discovered canonical
 *   keys. Exactly one distinct canonical candidate -> `resolved`; several
 *   -> `ambiguous` with the sorted path-free candidate list (never guessed);
 *   none -> `unresolved` with an empty list. Matching is exact
 *   (case-sensitive, extension appended only when absent); fragments and
 *   aliases never affect resolution. A symlink escape outside the root
 *   fails the whole call with fixed `markdown_path_unsafe` (alias only).
 *
 * PRIVACY: only `<alias>/<relative-posix>` canonical keys, aliases, titles,
 * snippets, and content-derived hashes leave this module. Absolute paths
 * and raw OS errors never escape.
 *
 * `readCanonical` validates the alias/key shape (including the exact `.md`
 * suffix), resolves the owning root by alias, runs discovery once
 * (metadata only, to existence-check links consistently with search) and
 * requires the key to be an exact discovered canonical key, plus exactly
 * one safe content read, then parses. Unknown alias or undiscovered key ->
 * `reference_not_found` before any content byte; malformed key or non-`.md`
 * suffix -> `invalid_input` before any content byte; unreadable content ->
 * the safe-read failure code.
 * Oversize/invalid-UTF8 targets cannot materialize and surface as
 * `markdown_read_failed`.
 *
 * CANCELLATION: `search` accepts an optional `{ signal }` second options
 * argument (matching the kernel `MarkdownConnectorPort`) and
 * `readCanonical` an optional `{ signal }` options argument. The signal is
 * passed into discovery and safe read and checked before discovery, before
 * each directory/entry traversal stage, before open/first byte, before
 * each 64KiB chunk, and before return. An abort throws `AbortError`
 * (never wrapped, carrying no path or content); bytes buffered before the
 * abort are discarded, and containment/identity/post-fstat/close/size/UTF-8
 * rules are never weakened.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { discoverMarkdownFiles, MAX_CANONICAL_KEY_UTF16 } from "./discovery.js";
import { MarkdownConnectorError } from "./errors.js";
import {
  type ParsedMarkdown,
  parseMarkdown,
  type StandardLink,
  type WikiLink,
} from "./markdown.js";
import {
  type ConfiguredRootInput,
  type InitializedRoot,
  type InitializedRootInfo,
  initializeRoots,
  isWithinRealRoot,
} from "./roots.js";
import { type SafeReadHooks, safeReadMarkdownFile } from "./safe_read.js";
import {
  containsFolded,
  equalsFolded,
  makeSnippet,
  sliceCodePoints,
} from "./text.js";

/** Query bounds in Unicode code points (exact, plan 14.6). */
export const SEARCH_QUERY_MIN_CODE_POINTS = 1;
export const SEARCH_QUERY_MAX_CODE_POINTS = 256;
/** Result-count bounds (exact, plan 14.6). */
export const SEARCH_DEFAULT_LIMIT = 10;
export const SEARCH_MAX_LIMIT = 20;

export type StandardLinkStatus = "resolved" | "unresolved";
export type WikiLinkStatus = "resolved" | "ambiguous" | "unresolved";

export interface ResolvedStandardLink {
  readonly rawUrl: string;
  readonly path: string;
  readonly fragment: string | null;
  readonly status: StandardLinkStatus;
  /** Present only when resolved (existence-checked, inside the same root). */
  readonly canonicalKey?: string;
}

export interface ResolvedWikiLink {
  readonly raw: string;
  readonly target: string;
  readonly alias: string | null;
  readonly fragment: string | null;
  readonly status: WikiLinkStatus;
  /**
   * Sorted path-free canonical candidates. Resolved: the single key.
   * Ambiguous: every candidate in code-unit order (never guessed).
   * Unresolved: empty.
   */
  readonly candidates: readonly string[];
  /** Present only when resolved (the single candidate). */
  readonly canonicalKey?: string;
}

export interface MarkdownSearchHit {
  readonly canonicalKey: string;
  readonly title: string;
  readonly snippet: string;
  /** Full NFC-normalized document text (for ResourceObservation use). */
  readonly text: string;
  /** SHA-256 hex of the NFC full text. */
  readonly sourceRevision: string;
  readonly standardLinks: readonly ResolvedStandardLink[];
  readonly wikiLinks: readonly ResolvedWikiLink[];
}

export interface MarkdownSkippedEntry {
  readonly canonicalKey: string;
  readonly reason: "file_too_large" | "invalid_utf8";
}

export interface MarkdownSearchResult {
  readonly hits: readonly MarkdownSearchHit[];
  readonly skipped: readonly MarkdownSkippedEntry[];
}

export interface MarkdownDocument {
  readonly canonicalKey: string;
  readonly title: string;
  /** Full NFC-normalized document text. */
  readonly text: string;
  /** SHA-256 hex of the NFC full text. */
  readonly sourceRevision: string;
  /** Leading body prefix (max 512 code points, title fallback when empty). */
  readonly snippet: string;
  readonly standardLinks: readonly ResolvedStandardLink[];
  readonly wikiLinks: readonly ResolvedWikiLink[];
}

export interface MarkdownSearchInput {
  readonly query: unknown;
  readonly limit?: unknown;
}

/**
 * Optional second-argument search options (kernel-port aligned).
 * Unknown keys are ignored; only `signal` is honored. The property is
 * omitted entirely when absent so `exactOptionalPropertyTypes` holds.
 */
export interface MarkdownSearchOptions {
  readonly signal?: AbortSignal;
}

export interface MarkdownReadOptions {
  readonly signal?: AbortSignal;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const error = new Error("operation aborted");
    error.name = "AbortError";
    throw error;
  }
}

export interface MarkdownConnector {
  /** Path-free root descriptors in alias code-unit order. */
  readonly roots: readonly InitializedRootInfo[];
  /**
   * Opaque stable instance identity: SHA-256 hex over the deterministic
   * versioned serialization of initialized roots sorted by alias
   * (alias + real root identity internally). Metadata only, never a path:
   * raw paths never leave, persist, log, or appear in errors.
   * Internal composition property only (never HTTP/log).
   */
  readonly identityFingerprint: string;
  search(
    input: MarkdownSearchInput,
    options?: MarkdownSearchOptions,
  ): Promise<MarkdownSearchResult>;
  readCanonical(
    canonicalKey: unknown,
    options?: MarkdownReadOptions,
  ): Promise<MarkdownDocument>;
}

export interface MarkdownConnectorHooks {
  readonly safeRead?: SafeReadHooks;
  /**
   * Optional path/content-free retention observer for tests only.
   * Called with `(retainedCount, limit)` after each scanned file is
   * resolved to hit/skip/miss so tests can prove the retained set never
   * exceeds the validated limit. Carries counts only (never a path, key,
   * or content) and never alters ranking, output, or production behavior
   * when absent.
   */
  readonly onSearchRetained?: (retainedCount: number, limit: number) => void;
}

function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function countCodePoints(value: string): number {
  return Array.from(value).length;
}

function validateQuery(query: unknown): string {
  if (typeof query !== "string") {
    throw new MarkdownConnectorError("invalid_input", null);
  }
  // Literal query: never trimmed. Whitespace-only queries match literally.
  const size = countCodePoints(query);
  if (
    size < SEARCH_QUERY_MIN_CODE_POINTS ||
    size > SEARCH_QUERY_MAX_CODE_POINTS
  ) {
    throw new MarkdownConnectorError("invalid_input", null);
  }
  return query;
}

function validateLimit(limit: unknown): number {
  if (limit === undefined) return SEARCH_DEFAULT_LIMIT;
  if (
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > SEARCH_MAX_LIMIT
  ) {
    throw new MarkdownConnectorError("invalid_input", null);
  }
  return limit;
}

function sha256HexUtf8(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Versioned identity serialization input (internal, never leaves). */
const IDENTITY_SERIALIZATION_VERSION = 1 as const;

/**
 * Derive the opaque stable instance identity fingerprint from initialized
 * roots. Deterministic versioned serialization sorted by alias
 * (`{"version":1,"roots":[{alias,realPath}...]}` in alias code-unit order)
 * hashed with SHA-256 hex. The serialization (with real paths) is internal
 * only; only the opaque 64-hex digest leaves this module.
 */
export function deriveIdentityFingerprint(
  roots: readonly InitializedRoot[],
): string {
  const ordered = [...roots].sort((a, b) => compareCodeUnits(a.alias, b.alias));
  const payload = JSON.stringify({
    version: IDENTITY_SERIALIZATION_VERSION,
    roots: ordered.map((root) => ({
      alias: root.alias,
      realPath: root.realPath,
    })),
  });
  return sha256HexUtf8(payload);
}

/** Canonical filename stem: basename minus the trailing `.md`. */
export function filenameStemOf(canonicalKey: string): string {
  const slash = canonicalKey.lastIndexOf("/");
  const base = slash < 0 ? canonicalKey : canonicalKey.slice(slash + 1);
  return base.endsWith(".md") ? base.slice(0, -3) : base;
}

/** Display-title bound in UTF-16 code units (contract ReferenceTitle max). */
export const REFERENCE_TITLE_MAX_UTF16 = 512;

/** Canonical-key bound in UTF-16 code units (matches CanonicalKeySchema). */
export { MAX_CANONICAL_KEY_UTF16 };

/**
 * Bound a heading-derived display title to a ReferenceTitle-compatible
 * deterministic prefix: at most 512 UTF-16 code units, never splitting a
 * surrogate pair. Short titles pass through unchanged; the body/snapshot
 * text is never truncated here.
 */
export function boundReferenceTitle(title: string): string {
  if (title.length <= REFERENCE_TITLE_MAX_UTF16) return title;
  let end = REFERENCE_TITLE_MAX_UTF16;
  const high = title.charCodeAt(end - 1);
  const low = title.charCodeAt(end);
  if (high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) {
    end -= 1;
  }
  return title.slice(0, end);
}

function deriveTitle(parsed: ParsedMarkdown, canonicalKey: string): string {
  if (parsed.title !== null && parsed.title !== "")
    return boundReferenceTitle(parsed.title);
  const stem = filenameStemOf(canonicalKey);
  if (stem !== "") return stem;
  return boundReferenceTitle(".md");
}

function aliasOf(canonicalKey: string): string | null {
  const slash = canonicalKey.indexOf("/");
  if (slash < 1) return null;
  return canonicalKey.slice(0, slash);
}

function relativeOf(canonicalKey: string): string | null {
  const slash = canonicalKey.indexOf("/");
  if (slash < 0 || slash + 1 >= canonicalKey.length) return null;
  return canonicalKey.slice(slash + 1);
}

/** POSIX source directory of a canonical key (`""` for root-level files). */
function sourceDirPosix(canonicalKey: string): string {
  const relative = relativeOf(canonicalKey) ?? "";
  const slash = relative.lastIndexOf("/");
  return slash < 0 ? "" : relative.slice(0, slash);
}

/**
 * Normalize a POSIX relative path joined from `sourceDir` + `target`.
 * Returns null when the result escapes the root (leading `..`).
 */
function normalizeInsideRoot(sourceDir: string, target: string): string | null {
  const joined = sourceDir === "" ? target : `${sourceDir}/${target}`;
  const normalized = path.posix.normalize(joined);
  if (
    normalized === "" ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/")
  ) {
    return null;
  }
  // `normalize` can only produce `.` for empty/`.` input; our targets are
  // never empty, so treat leftovers as escapes defensively.
  if (normalized === ".") return null;
  for (const segment of normalized.split("/")) {
    if (segment === "" || segment === "." || segment === "..") return null;
  }
  return normalized;
}

/**
 * Metadata-only canonicalization of one lexical `normalized` POSIX relative
 * path (already proven inside the root lexically) to its discovered real
 * canonical key. `realpath` folds internal file/directory symlink aliases;
 * containment + structural grammar + 512-unit bound are enforced; the result
 * is existence-checked against the discovery set. Missing targets return
 * null (`unresolved`); escapes/invalid derived keys throw fixed
 * `markdown_path_unsafe` carrying only the alias (never a path or OS error).
 * No file content is read and no alias map is persisted.
 */
async function canonicalizeNormalizedCandidate(
  root: InitializedRoot,
  normalized: string,
  existing: ReadonlySet<string>,
  signal: AbortSignal | undefined,
): Promise<string | null> {
  throwIfAborted(signal);
  for (const segment of normalized.split("/")) {
    if (segment === "" || segment === "." || segment === "..") return null;
  }
  const candidateAbs = path.join(root.realPath, ...normalized.split("/"));
  let real: string;
  try {
    real = await fs.realpath(candidateAbs);
  } catch {
    return null;
  }
  throwIfAborted(signal);
  if (!isWithinRealRoot(root.realPath, real)) {
    throw new MarkdownConnectorError("markdown_path_unsafe", root.alias);
  }
  const relative = path.relative(root.realPath, real);
  if (relative === "") return null;
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new MarkdownConnectorError("markdown_path_unsafe", root.alias);
  }
  const posix = relative.split(path.sep).join("/");
  if (
    process.platform === "win32" &&
    posix.split("/").some((segment) => segment.includes(":"))
  ) {
    return null;
  }
  const canonical = `${root.alias}/${posix}`;
  if (canonical.length > MAX_CANONICAL_KEY_UTF16) {
    throw new MarkdownConnectorError("markdown_path_unsafe", root.alias);
  }
  if (
    canonical.includes("\0") ||
    canonical.includes("\\") ||
    canonical.startsWith("/") ||
    /^[A-Za-z]:(\/|$)/.test(canonical)
  ) {
    throw new MarkdownConnectorError("markdown_path_unsafe", root.alias);
  }
  const parts = canonical.split("/");
  if (parts.length < 2) {
    throw new MarkdownConnectorError("markdown_path_unsafe", root.alias);
  }
  for (const part of parts) {
    if (part === "" || part === "." || part === "..") {
      throw new MarkdownConnectorError("markdown_path_unsafe", root.alias);
    }
  }
  if (!existing.has(canonical)) return null;
  return canonical;
}

async function resolveStandardLinks(
  sourceKey: string,
  links: readonly StandardLink[],
  existing: ReadonlySet<string>,
  root: InitializedRoot,
  signal: AbortSignal | undefined,
): Promise<ResolvedStandardLink[]> {
  const sourceDir = sourceDirPosix(sourceKey);
  const out: ResolvedStandardLink[] = [];
  for (const link of links) {
    throwIfAborted(signal);
    const normalized = normalizeInsideRoot(sourceDir, link.path);
    if (normalized === null) {
      out.push({
        rawUrl: link.rawUrl,
        path: link.path,
        fragment: link.fragment,
        status: "unresolved" as const,
      });
      continue;
    }
    const canonical = await canonicalizeNormalizedCandidate(
      root,
      normalized,
      existing,
      signal,
    );
    if (canonical !== null) {
      out.push({
        rawUrl: link.rawUrl,
        path: link.path,
        fragment: link.fragment,
        status: "resolved" as const,
        canonicalKey: canonical,
      });
    } else {
      out.push({
        rawUrl: link.rawUrl,
        path: link.path,
        fragment: link.fragment,
        status: "unresolved" as const,
      });
    }
  }
  return out;
}

function wikiBasePath(target: string): string {
  return target.endsWith(".md") ? target : `${target}.md`;
}

function wikiBasename(base: string): string {
  const slash = base.lastIndexOf("/");
  return slash < 0 ? base : base.slice(slash + 1);
}

async function resolveWikiLinks(
  sourceKey: string,
  links: readonly WikiLink[],
  keysInRoot: readonly string[],
  existing: ReadonlySet<string>,
  root: InitializedRoot,
  signal: AbortSignal | undefined,
): Promise<ResolvedWikiLink[]> {
  const sourceDir = sourceDirPosix(sourceKey);
  const out: ResolvedWikiLink[] = [];
  for (const link of links) {
    throwIfAborted(signal);
    const base = wikiBasePath(link.target);
    const found = new Set<string>();
    // (1) source-directory-relative candidate (folded to real canonical).
    const relative = normalizeInsideRoot(sourceDir, base);
    if (relative !== null) {
      const canonical = await canonicalizeNormalizedCandidate(
        root,
        relative,
        existing,
        signal,
      );
      if (canonical !== null) found.add(canonical);
    }
    throwIfAborted(signal);
    // (2) root-relative candidate (folded to real canonical).
    const rooted = normalizeInsideRoot("", base);
    if (rooted !== null) {
      const canonical = await canonicalizeNormalizedCandidate(
        root,
        rooted,
        existing,
        signal,
      );
      if (canonical !== null) found.add(canonical);
    }
    // (3) basename candidates: every same-root file with an equal
    // trailing filename (exact, case-sensitive). Already discovered
    // canonical keys, so no folding is needed; duplicates cannot occur
    // because discovery dedups by realpath.
    const wanted = wikiBasename(base);
    for (const key of keysInRoot) {
      const relativePart = relativeOf(key) ?? "";
      const slash = relativePart.lastIndexOf("/");
      const name = slash < 0 ? relativePart : relativePart.slice(slash + 1);
      if (name === wanted) found.add(key);
    }
    const candidates = [...found].sort(compareCodeUnits);
    if (candidates.length === 1) {
      const only = candidates[0] as string;
      out.push({
        raw: link.raw,
        target: link.target,
        alias: link.alias,
        fragment: link.fragment,
        status: "resolved" as const,
        candidates,
        canonicalKey: only,
      });
    } else if (candidates.length > 1) {
      out.push({
        raw: link.raw,
        target: link.target,
        alias: link.alias,
        fragment: link.fragment,
        status: "ambiguous" as const,
        candidates,
      });
    } else {
      out.push({
        raw: link.raw,
        target: link.target,
        alias: link.alias,
        fragment: link.fragment,
        status: "unresolved" as const,
        candidates,
      });
    }
  }
  return out;
}

interface RankedHit extends MarkdownSearchHit {
  rank: number;
}

function compareRankedHits(a: RankedHit, b: RankedHit): number {
  if (a.rank !== b.rank) return a.rank - b.rank;
  return compareCodeUnits(a.canonicalKey, b.canonicalKey);
}

async function buildHit(
  canonicalKey: string,
  text: string,
  query: string,
  existing: ReadonlySet<string>,
  keysInRoot: readonly string[],
  root: InitializedRoot,
  signal: AbortSignal | undefined,
): Promise<RankedHit | null> {
  const parsed = parseMarkdown(text);
  const title = deriveTitle(parsed, canonicalKey);
  let rank: number;
  if (equalsFolded(title, query)) {
    rank = 0;
  } else if (containsFolded(title, query)) {
    rank = 1;
  } else if (containsFolded(text, query)) {
    rank = 2;
  } else {
    return null;
  }
  let snippet = makeSnippet(text, query);
  if (snippet === "") {
    snippet = sliceCodePoints(title, 0, 512);
  }
  throwIfAborted(signal);
  const standardLinks = await resolveStandardLinks(
    canonicalKey,
    parsed.standardLinks,
    existing,
    root,
    signal,
  );
  const wikiLinks = await resolveWikiLinks(
    canonicalKey,
    parsed.wikiLinks,
    keysInRoot,
    existing,
    root,
    signal,
  );
  return {
    rank,
    canonicalKey,
    title,
    snippet,
    text,
    sourceRevision: sha256HexUtf8(text),
    standardLinks,
    wikiLinks,
  };
}

function rootForAlias(
  roots: readonly InitializedRoot[],
  alias: string,
): InitializedRoot | null {
  for (const root of roots) {
    if (root.alias === alias) return root;
  }
  return null;
}

/** Same safe token grammar as configured roots (roots.ts). */
const ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function validateCanonicalShape(canonicalKey: unknown): {
  alias: string;
} {
  if (typeof canonicalKey !== "string") {
    throw new MarkdownConnectorError("invalid_input", null);
  }
  // Canonical-key bound (UTF-16 units, matches CanonicalKeySchema max 512):
  // rejected as `invalid_input` before any discovery metadata or content
  // byte is touched. Never truncated.
  if (canonicalKey.length > MAX_CANONICAL_KEY_UTF16) {
    throw new MarkdownConnectorError("invalid_input", null);
  }
  if (
    canonicalKey === "" ||
    canonicalKey.includes("\\") ||
    canonicalKey.includes("\0") ||
    canonicalKey.startsWith("/") ||
    canonicalKey.startsWith("\\")
  ) {
    throw new MarkdownConnectorError("invalid_input", null);
  }
  const slash = canonicalKey.indexOf("/");
  if (slash < 1 || slash + 1 >= canonicalKey.length) {
    throw new MarkdownConnectorError("invalid_input", null);
  }
  const alias = canonicalKey.slice(0, slash);
  // The alias must use the same safe token grammar as configured roots so
  // drive (`C:`), scheme-like (`a:b`), slash, dot-segment, or absolute
  // aliases can never reach discovery or a content byte. Failures carry
  // null and never echo the raw input.
  if (!ALIAS_PATTERN.test(alias)) {
    throw new MarkdownConnectorError("invalid_input", null);
  }
  const rest = canonicalKey.slice(slash + 1);
  for (const segment of rest.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new MarkdownConnectorError("invalid_input", null);
    }
  }
  // Alias grammar stays colon-free on all platforms (ALIAS_PATTERN above).
  // Relative segments may contain `:` on POSIX; Windows rejects them to
  // avoid drive/ADS ambiguity.
  if (process.platform === "win32") {
    for (const segment of rest.split("/")) {
      if (segment.includes(":")) {
        throw new MarkdownConnectorError("invalid_input", null);
      }
    }
  }
  // Only discovered exact `.md` canonical keys can be read: reject bare
  // directories, extensionless names, and non-Markdown suffixes here,
  // before any discovery metadata or content byte is touched.
  if (!rest.endsWith(".md")) {
    throw new MarkdownConnectorError("invalid_input", null);
  }
  return { alias };
}

/**
 * Initialize configured roots and return the public connector. Root
 * descriptors are path-free (`{ alias }` only) in alias code-unit order.
 * The connector also exposes the opaque `identityFingerprint` (internal
 * composition property, never HTTP/log); roots output stays alias-only.
 */
export async function createMarkdownConnector(
  inputs: readonly ConfiguredRootInput[],
  hooks: MarkdownConnectorHooks = {},
): Promise<MarkdownConnector> {
  const roots = await initializeRoots(inputs);
  const infos: InitializedRootInfo[] = roots.map((root) => ({
    alias: root.alias,
  }));
  const identityFingerprint = deriveIdentityFingerprint(roots);

  const byAlias = new Map<string, InitializedRoot>();
  for (const root of roots) byAlias.set(root.alias, root);

  async function search(
    input: MarkdownSearchInput,
    options?: MarkdownSearchOptions,
  ): Promise<MarkdownSearchResult> {
    if (typeof input !== "object" || input === null) {
      throw new MarkdownConnectorError("invalid_input", null);
    }
    if (
      options !== undefined &&
      (typeof options !== "object" || options === null)
    ) {
      throw new MarkdownConnectorError("invalid_input", null);
    }
    const signal = options?.signal;
    if (signal !== undefined && !(signal instanceof AbortSignal)) {
      throw new MarkdownConnectorError("invalid_input", null);
    }
    throwIfAborted(signal);
    const query = validateQuery((input as { query?: unknown }).query);
    const limit = validateLimit((input as { limit?: unknown }).limit);
    throwIfAborted(signal);

    // Discovery before any content byte; whole-call failures propagate
    // (including AbortError, which is never wrapped with paths).
    const discovered = await discoverMarkdownFiles(roots, {
      ...(signal === undefined ? {} : { signal }),
    });
    throwIfAborted(signal);
    const existing = new Set(discovered.map((entry) => entry.canonicalKey));
    const keysByAlias = new Map<string, string[]>();
    for (const entry of discovered) {
      const alias = aliasOf(entry.canonicalKey) ?? "";
      const list = keysByAlias.get(alias);
      if (list === undefined) {
        keysByAlias.set(alias, [entry.canonicalKey]);
      } else {
        list.push(entry.canonicalKey);
      }
    }

    // Safely read every candidate (discovery order is canonical-key
    // sorted); explicit skips accumulate without any result-limit slice.
    // The signal is checked before each file so a mid-search abort
    // discards buffered bytes instead of returning partial hits.
    // RETENTION BOUND: at most `limit` top-ranked hits are retained.
    // Each file is safe-read sequentially (bounded 1MiB+1 buffering);
    // a matching hit is inserted into the sorted top-K set by
    // (rank, canonical-key code-unit) order and the worst entry is
    // evicted/released immediately, so transient memory is one in-flight
    // file plus K retained hits and the final output is identical to a
    // full sort+slice. Skipped entries stay complete, sorted, untruncated.
    const skipped: MarkdownSkippedEntry[] = [];
    const top: RankedHit[] = [];
    const notifyRetained = hooks.onSearchRetained;
    const reportRetained = (): void => {
      notifyRetained?.(top.length, limit);
    };
    const insertBounded = (hit: RankedHit): void => {
      let lo = 0;
      let hi = top.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const current = top[mid] as RankedHit;
        if (compareRankedHits(current, hit) < 0) lo = mid + 1;
        else hi = mid;
      }
      if (top.length < limit) {
        top.splice(lo, 0, hit);
      } else if (lo < top.length) {
        top.splice(lo, 0, hit);
        // Evict/release the worst immediately; the dropped reference
        // (including its full text) becomes garbage without retention.
        top.pop();
      }
      // Else: strictly worse than the retained worst -> discard
      // immediately (hit falls out of scope, nothing retained).
      reportRetained();
    };
    for (const entry of discovered) {
      throwIfAborted(signal);
      const alias = aliasOf(entry.canonicalKey) ?? "";
      const root = byAlias.get(alias);
      if (root === undefined) continue;
      const result = await safeReadMarkdownFile(root, entry.canonicalKey, {
        ...(hooks.safeRead ?? {}),
        ...(signal === undefined ? {} : { signal }),
      });
      throwIfAborted(signal);
      if (result.status === "skipped") {
        skipped.push({
          canonicalKey: entry.canonicalKey,
          reason: result.reason,
        });
        reportRetained();
        continue;
      }
      const hit = await buildHit(
        entry.canonicalKey,
        result.text,
        query,
        existing,
        keysByAlias.get(alias) ?? [],
        root,
        signal,
      );
      if (hit !== null) insertBounded(hit);
      else reportRetained();
    }

    skipped.sort((a, b) => compareCodeUnits(a.canonicalKey, b.canonicalKey));

    const hits: MarkdownSearchHit[] = top.slice(0, limit).map((hit) => ({
      canonicalKey: hit.canonicalKey,
      title: hit.title,
      snippet: hit.snippet,
      text: hit.text,
      sourceRevision: hit.sourceRevision,
      standardLinks: hit.standardLinks,
      wikiLinks: hit.wikiLinks,
    }));
    return { hits, skipped };
  }

  async function readCanonical(
    canonicalKey: unknown,
    options: MarkdownReadOptions = {},
  ): Promise<MarkdownDocument> {
    const signal = options.signal;
    if (signal !== undefined && !(signal instanceof AbortSignal)) {
      throw new MarkdownConnectorError("invalid_input", null);
    }
    throwIfAborted(signal);
    const { alias } = validateCanonicalShape(canonicalKey);
    const key = canonicalKey as string;
    const root = rootForAlias(roots, alias);
    if (root === null) {
      throw new MarkdownConnectorError("reference_not_found", key);
    }
    // Metadata-only discovery keeps link existence consistent with
    // search. The key must be an exact discovered `.md` canonical key:
    // anything undiscovered returns `reference_not_found` BEFORE the
    // single content read below, so no byte is touched for misses.
    throwIfAborted(signal);
    const discovered = await discoverMarkdownFiles(roots, {
      ...(signal === undefined ? {} : { signal }),
    });
    throwIfAborted(signal);
    const existing = new Set(discovered.map((entry) => entry.canonicalKey));
    if (!existing.has(key)) {
      throw new MarkdownConnectorError("reference_not_found", key);
    }
    const keysInRoot = discovered
      .map((entry) => entry.canonicalKey)
      .filter((candidate) => aliasOf(candidate) === alias);
    throwIfAborted(signal);
    const result = await safeReadMarkdownFile(root, key, {
      ...(hooks.safeRead ?? {}),
      ...(signal === undefined ? {} : { signal }),
    });
    throwIfAborted(signal);
    if (result.status === "skipped") {
      throw new MarkdownConnectorError("markdown_read_failed", key);
    }
    const parsed = parseMarkdown(result.text);
    const title = deriveTitle(parsed, key);
    // Leading body prefix (deterministic, query-independent); an empty
    // body falls back to the title slice so snippets are never empty.
    let snippet = sliceCodePoints(result.text, 0, 512);
    if (snippet === "") {
      snippet = sliceCodePoints(title, 0, 512);
    }
    throwIfAborted(signal);
    const standardLinks = await resolveStandardLinks(
      key,
      parsed.standardLinks,
      existing,
      root,
      signal,
    );
    const wikiLinks = await resolveWikiLinks(
      key,
      parsed.wikiLinks,
      keysInRoot,
      existing,
      root,
      signal,
    );
    return {
      canonicalKey: key,
      title,
      text: result.text,
      sourceRevision: sha256HexUtf8(result.text),
      snippet,
      standardLinks,
      wikiLinks,
    };
  }

  return {
    roots: infos,
    identityFingerprint,
    search,
    readCanonical,
  };
}
