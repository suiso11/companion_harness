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
 * `#fragment` suffix, extracted from `text` nodes only (never code,
 * inlineCode, or html). Deterministic source order. Empty, unsafe
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

interface MdNode {
  type: string;
  value?: unknown;
  url?: unknown;
  alt?: unknown;
  children?: MdNode[];
}

function isMdNode(value: unknown): value is MdNode {
  return typeof value === "object" && value !== null && "type" in value;
}

function walk(node: MdNode, visit: (node: MdNode) => void): void {
  visit(node);
  const children = node.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      if (isMdNode(child)) walk(child, visit);
    }
  }
}

function collectHeadingText(heading: MdNode): string {
  const parts: string[] = [];
  walk(heading, (node) => {
    if (node === heading) return;
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

const WIKI_PATTERN = /\[\[([^[\]\n]+?)\]\]/g;

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
  const textValues: string[] = [];

  walk(root, (node) => {
    if (!headingSeen && node.type === "heading") {
      headingSeen = true;
      const text = collectHeadingText(node);
      title = text === "" ? null : text;
    }
    if (node.type === "link" && typeof node.url === "string") {
      const parsed = parseStandardUrl(node.url);
      if (parsed !== null) standardLinks.push(parsed);
    }
    // Wiki subset: `text` nodes only (excludes code/inlineCode/html by type).
    if (node.type === "text" && typeof node.value === "string") {
      textValues.push(node.value);
    }
  });

  for (const value of textValues) {
    for (const match of value.matchAll(WIKI_PATTERN)) {
      const raw = match[0];
      const inner = match[1] as string;
      const parsed = parseWikiInner(raw, inner);
      if (parsed !== null) wikiLinks.push(parsed);
    }
  }

  return { title, standardLinks, wikiLinks };
}
