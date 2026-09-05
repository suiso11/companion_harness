/**
 * Narrow Markdown parsing over `mdast-util-from-markdown` (no unified,
 * remark, GFM, or HTML rendering).
 *
 * TITLE: plain text of the first heading node, or null when absent/blank
 * (filename fallback is handled by a later slice, not here).
 *
 * STANDARD LINKS: `link` nodes whose URL is a relative `.md` reference
 * (optional `#fragment`). Absolute paths, protocol URLs, protocol-relative
 * URLs, bare fragments, query strings, backslashes, and NUL bytes are
 * rejected. `..` segments are preserved structurally (resolution is
 * deferred to a later slice).
 *
 * WIKI SUBSET (narrow): `[[Target]]`, `[[Target|alias]]`, plus an optional
 * `#fragment` suffix, extracted from literal `[[...]]` source inside `text`
 * nodes only (never code, inlineCode, or html). Recognition uses the raw
 * NFC Markdown slice for each `text` node (source positions), so Markdown
 * escapes (`\[[...]]`, `[[...}\]]`) and entity-encoded brackets
 * (`&#91;&#91;...`) are never treated as real Wiki syntax. An opener is
 * real only with an even number of immediately preceding backslashes
 * (odd = escaped). Deterministic source order. Empty, unsafe
 * (NUL/backslash/leading-slash/dot-segment), or external (URL-scheme)
 * targets are rejected. Ambiguity resolution is deferred: this module only
 * returns structural targets.
 */

import { fromMarkdown } from "mdast-util-from-markdown";

export interface StandardLink {
  /** URL exactly as written in the link node. */
  rawUrl: string;
  /** Relative path portion before any `#fragment`. */
  path: string;
  /** Fragment after the first `#`, or null when absent/empty. */
  fragment: string | null;
}

export interface WikiLink {
  /** Full matched `[[...]]` source text. */
  raw: string;
  /** Trimmed link target (before `|`/`#`). */
  target: string;
  /** Trimmed alias after the first `|`, or null when absent/empty. */
  alias: string | null;
  /** Trimmed fragment after the first `#`, or null when absent/empty. */
  fragment: string | null;
}

export interface ParsedMarkdown {
  /** Plain text of the first heading, or null when absent/blank. */
  title: string | null;
  /** Accepted relative `.md` links in document order. */
  standardLinks: StandardLink[];
  /** Accepted wiki targets in document order. */
  wikiLinks: WikiLink[];
}

interface MdPosition {
  start?: { line?: unknown; column?: unknown; offset?: unknown };
  end?: { line?: unknown; column?: unknown; offset?: unknown };
}

interface MdNode {
  type: string;
  value?: unknown;
  url?: unknown;
  alt?: unknown;
  children?: MdNode[];
  position?: MdPosition;
}

function isMdNode(value: unknown): value is MdNode {
  return typeof value === "object" && value !== null && "type" in value;
}

function walk(
  node: MdNode,
  visit: (node: MdNode, ancestors: readonly MdNode[]) => void,
  ancestors: readonly MdNode[] = [],
): void {
  visit(node, ancestors);
  const children = node.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      if (isMdNode(child)) walk(child, visit, [...ancestors, node]);
    }
  }
}

function collectHeadingText(heading: MdNode): string {
  const parts: string[] = [];
  walk(heading, (node, ancestors) => {
    if (node === heading) return;
    void ancestors;
    if (node.type === "text" || node.type === "inlineCode") {
      if (typeof node.value === "string") parts.push(node.value);
    } else if (node.type === "image") {
      if (typeof node.alt === "string") parts.push(node.alt);
    }
  });
  return parts.join("").replace(/\s+/g, " ").trim();
}

const SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/;

function parseStandardUrl(rawUrl: string): StandardLink | null {
  if (rawUrl.includes("\0")) return null;
  const trimmed = rawUrl.trim();
  if (trimmed === "") return null;
  if (trimmed.startsWith("//")) return null;
  if (SCHEME_PATTERN.test(trimmed)) return null;
  if (trimmed.includes("\\")) return null;
  const hashIndex = trimmed.indexOf("#");
  const path = hashIndex < 0 ? trimmed : trimmed.slice(0, hashIndex);
  const fragmentRaw = hashIndex < 0 ? null : trimmed.slice(hashIndex + 1);
  if (path === "") return null;
  if (path.startsWith("/")) return null;
  if (path.includes("?")) return null;
  if (!path.endsWith(".md")) return null;
  const fragment =
    fragmentRaw === null || fragmentRaw.trim() === "" ? null : fragmentRaw;
  return { rawUrl: trimmed, path, fragment };
}

/**
 * Literal Wiki candidates inside one raw Markdown slice. Single-pass O(n):
 * one left-to-right scan with O(1) work per code unit and no backtracking.
 * Backslash parity for `[[`/`]]` is tracked incrementally (a running count
 * of consecutive backslashes immediately before the current index), so long
 * backslash runs are inspected once, never rescanned. Only unescaped `[[`
 * openers (even preceding backslashes) open a link, and only the first
 * unescaped `]]` closes it. Inner content must contain no `[`, `]`, `\r`,
 * or `\n`; the first invalid code unit abandons the pending opener
 * immediately (`\r` and `\n` each terminate independently, so a CRLF pair is
 * consumed linearly with one inspection per code unit and no opener can
 * start or reopen inside the sequence). A nested viable literal `[[` inside a malformed opener
 * replaces it (equivalent to finding the next viable literal opener after
 * `openStart + 2`), so no real link after a malformed opener is lost.
 * Entity-encoded brackets never appear as literal brackets here, so they
 * never match.
 */
function scanWikiCandidates(
  raw: string,
  stats: { inspected: number } | null,
): Array<{ raw: string; inner: string }> {
  const out: Array<{ raw: string; inner: string }> = [];
  const n = raw.length;
  let openStart = -1;
  let pendingSlashes = 0;
  let i = 0;
  while (i < n) {
    if (stats !== null) stats.inspected += 1;
    const ch = raw[i] as string;
    if (openStart < 0) {
      if (ch === "\\") {
        pendingSlashes += 1;
        i += 1;
        continue;
      }
      if (ch === "[" && i + 1 < n && (raw[i + 1] as string) === "[") {
        if (pendingSlashes % 2 === 1) {
          i += 2;
          pendingSlashes = 0;
          continue;
        }
        openStart = i;
        i += 2;
        pendingSlashes = 0;
        continue;
      }
      pendingSlashes = 0;
      i += 1;
      continue;
    }
    if (ch === "\\") {
      pendingSlashes += 1;
      i += 1;
      continue;
    }
    if (ch === "[") {
      if (i + 1 < n && (raw[i + 1] as string) === "[") {
        if (pendingSlashes % 2 === 1) {
          openStart = -1;
          i += 2;
          pendingSlashes = 0;
          continue;
        }
        openStart = i;
        i += 2;
        pendingSlashes = 0;
        continue;
      }
      openStart = -1;
      pendingSlashes = 0;
      i += 1;
      continue;
    }
    if (ch === "]") {
      if (i + 1 < n && (raw[i + 1] as string) === "]") {
        if (pendingSlashes % 2 === 1) {
          openStart = -1;
          i += 2;
          pendingSlashes = 0;
          continue;
        }
        const inner = raw.slice(openStart + 2, i);
        out.push({ raw: raw.slice(openStart, i + 2), inner });
        openStart = -1;
        i += 2;
        pendingSlashes = 0;
        continue;
      }
      openStart = -1;
      pendingSlashes = 0;
      i += 1;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      openStart = -1;
      pendingSlashes = 0;
      i += 1;
      continue;
    }
    pendingSlashes = 0;
    i += 1;
  }
  return out;
}

function extractWikiCandidates(
  raw: string,
): Array<{ raw: string; inner: string }> {
  return scanWikiCandidates(raw, null);
}

/**
 * Test-only linear-scan hook (not re-exported from the package index).
 * Returns the same candidates as the internal scanner plus the number of
 * constant-time inspection steps (one per loop iteration, each advancing
 * the index by >= 1, hence `inspected <= raw.length` on every input).
 */
export function extractWikiCandidatesWithStats(raw: string): {
  candidates: Array<{ raw: string; inner: string }>;
  inspected: number;
} {
  const stats = { inspected: 0 };
  const candidates = scanWikiCandidates(raw, stats);
  return { candidates, inspected: stats.inspected };
}

function rawSliceFor(normalized: string, node: MdNode): string | null {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  if (typeof start !== "number" || typeof end !== "number") return null;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start < 0 || end < start || end > normalized.length) return null;
  return normalized.slice(start, end);
}

function parseWikiInner(raw: string, inner: string): WikiLink | null {
  if (inner.includes("\0")) return null;
  // Defense in depth: even if the scanner ever emitted a CR/LF-containing
  // inner, no target/alias/fragment may carry either line terminator.
  if (inner.includes("\r") || inner.includes("\n")) return null;
  const pipeIndex = inner.indexOf("|");
  const targetFrag = pipeIndex < 0 ? inner : inner.slice(0, pipeIndex);
  const aliasRaw = pipeIndex < 0 ? null : inner.slice(pipeIndex + 1);
  const hashIndex = targetFrag.indexOf("#");
  const targetRaw = hashIndex < 0 ? targetFrag : targetFrag.slice(0, hashIndex);
  const fragmentRaw = hashIndex < 0 ? null : targetFrag.slice(hashIndex + 1);
  const target = targetRaw.trim();
  if (target === "") return null;
  if (target.includes("\0") || target.includes("\\")) return null;
  if (target.startsWith("/")) return null;
  if (SCHEME_PATTERN.test(target)) return null;
  if (target.includes("?")) return null;
  const segments = target.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") return null;
  }
  const alias =
    aliasRaw === null || aliasRaw.trim() === "" ? null : aliasRaw.trim();
  const fragment =
    fragmentRaw === null || fragmentRaw.trim() === ""
      ? null
      : fragmentRaw.trim();
  if (target.includes("\r") || target.includes("\n")) return null;
  if (alias !== null && (alias.includes("\r") || alias.includes("\n"))) {
    return null;
  }
  if (
    fragment !== null &&
    (fragment.includes("\r") || fragment.includes("\n"))
  ) {
    return null;
  }
  return { raw, target, alias, fragment };
}

/**
 * Parse Markdown content into title and structural link targets.
 * Input is NFC-normalized before parsing for pipeline consistency.
 */
export function parseMarkdown(content: string): ParsedMarkdown {
  const normalized = content.normalize("NFC");
  const root = fromMarkdown(normalized) as unknown as MdNode;

  let title: string | null = null;
  let headingSeen = false;
  const standardLinks: StandardLink[] = [];
  const wikiLinks: WikiLink[] = [];
  const textRaws: string[] = [];

  walk(root, (node, ancestors) => {
    if (!headingSeen && node.type === "heading") {
      headingSeen = true;
      const text = collectHeadingText(node);
      title = text === "" ? null : text;
    }
    if (node.type === "link" && typeof node.url === "string") {
      const parsed = parseStandardUrl(node.url);
      if (parsed !== null) standardLinks.push(parsed);
    }
    // Wiki subset: literal source inside `text` nodes only (excludes
    // code/inlineCode/html by type and by ancestor).
    if (node.type === "text" && typeof node.value === "string") {
      if (
        ancestors.some(
          (parent) =>
            parent.type === "code" ||
            parent.type === "inlineCode" ||
            parent.type === "html",
        )
      ) {
        return;
      }
      const raw = rawSliceFor(normalized, node);
      if (raw !== null) textRaws.push(raw);
    }
  });

  for (const rawSlice of textRaws) {
    for (const candidate of extractWikiCandidates(rawSlice)) {
      const parsed = parseWikiInner(candidate.raw, candidate.inner);
      if (parsed !== null) wikiLinks.push(parsed);
    }
  }

  return { title, standardLinks, wikiLinks };
}
