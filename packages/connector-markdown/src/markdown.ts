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

function countPrecedingBackslashes(text: string, index: number): number {
  let count = 0;
  let i = index - 1;
  while (i >= 0 && text[i] === "\\") {
    count += 1;
    i -= 1;
  }
  return count;
}

/**
 * Literal Wiki candidates inside one raw Markdown slice. Only unescaped
 * `[[` openers (even preceding backslashes) open a link, and only the first
 * unescaped `]]` with no brackets/newline inside closes it. Entity-encoded
 * brackets never appear as literal brackets here, so they never match.
 */
function extractWikiCandidates(
  raw: string,
): Array<{ raw: string; inner: string }> {
  const out: Array<{ raw: string; inner: string }> = [];
  let i = 0;
  while (i < raw.length - 1) {
    if (raw[i] !== "[" || raw[i + 1] !== "[") {
      i += 1;
      continue;
    }
    if (countPrecedingBackslashes(raw, i) % 2 === 1) {
      i += 2;
      continue;
    }
    let matched = false;
    let searchFrom = i + 2;
    while (searchFrom < raw.length - 1) {
      const close = raw.indexOf("]]", searchFrom);
      if (close < 0) break;
      if (countPrecedingBackslashes(raw, close) % 2 === 1) {
        searchFrom = close + 2;
        continue;
      }
      const inner = raw.slice(i + 2, close);
      if (inner.includes("[") || inner.includes("]") || inner.includes("\n")) {
        break;
      }
      out.push({ raw: raw.slice(i, close + 2), inner });
      i = close + 2;
      matched = true;
      break;
    }
    if (!matched) i += 2;
  }
  return out;
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
