// V2 validated-answer markdown, adapted from upstream llama.cpp WebUI
// `tools/ui` MarkdownContent (pinned commit + per-file provenance in
// `vendor/llama-webui/NOTICE.md`). Deliberate subset for calendar answers:
//
//   fromMarkdown (parse + GFM syntax/mdast, breaks) -> mdast literal-html
//   -> toHast -> subset highlight -> tables/links/code-copy enhancers
//   -> toHtml -> DOMPurify sanitize.
//
// Bundle notes (both guards must hold: `pnpm budget` gz ≤ 120KB total and
// server `build-ui` page-JS min ≤ 300KB):
// - No `unified`/`vfile` processor: the mdast/hast utilities are called
//   directly, which drops `unified`, `vfile`, `trough` and friends.
// - No `remark`/`remark-gfm` preset: `remark-gfm` pushes
//   `toMarkdownExtensions` at `.use()` time, pinning
//   `mdast-util-to-markdown` + `markdown-table` into the bundle even though
//   this pipeline never stringifies mdast. Only the from-markdown entry
//   points are imported (same syntax + mdast extensions as `remark-gfm`
//   defaults: tables, footnotes, strikethrough, autolinks, task lists).
// - No `rehype-highlight`: it imports lowlight `common` unconditionally
//   (~35 grammars). `createLowlight` is called directly with the pinned
//   subset below (never `lowlightAll`/`common`).
//
// Skipped upstream pieces (see NOTICE.md): math/katex, mermaid/svg
// execution and preview dialogs, attachment image resolving, RTL helper,
// table-html restorer, file badges. Raw HTML is never rendered: `html`
// nodes become literal text before rehype, and the sanitizer allowlist
// additionally drops style/media/MathML. Only validated answers go
// through here; drafts, approval cards, notices and citations stay plain.

import DOMPurify from "dompurify";
import type {
  Element,
  ElementContent,
  Root as HastRoot,
  Text as HastText,
  Parent,
} from "hast";
import { toHtml } from "hast-util-to-html";
import bash from "highlight.js/lib/languages/bash";
import diff from "highlight.js/lib/languages/diff";
import json from "highlight.js/lib/languages/json";
import plaintext from "highlight.js/lib/languages/plaintext";
import python from "highlight.js/lib/languages/python";
import typescript from "highlight.js/lib/languages/typescript";
import { createLowlight, type LanguageFn } from "lowlight";
import type { Root as MdastRoot } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { newlineToBreak } from "mdast-util-newline-to-break";
import { toHast } from "mdast-util-to-hast";
import { gfm } from "micromark-extension-gfm";
import { visit } from "unist-util-visit";

/** Code-block plumbing: wrapper/header/copy classes + code id attribute. */
export const CODE_BLOCK_WRAPPER_CLASS = "code-block-wrapper";
export const CODE_COPY_BUTTON_CLASS = "copy-code-btn";
export const CODE_ID_ATTR = "data-code-id";

/**
 * Pinned lowlight subset (plan: bash, json, ts/js, python, diff,
 * plaintext). `lowlightAll`/`common` are banned: importing them would pull
 * every highlight.js grammar into the bundle.
 *
 * `javascript` is intentionally NOT registered separately: the TypeScript
 * grammar embeds the full JavaScript grammar and extends it, so `js` blocks
 * highlight identically through the `typescript` registration (wired below
 * via `registerAlias`). This saves a duplicate ~17KB grammar.
 */
const HIGHLIGHT_LANGUAGES: Record<string, LanguageFn> = {
  bash,
  diff,
  json,
  plaintext,
  python,
  typescript,
};

/**
 * mdast pass adapted from upstream `plugins/remark/literal-html`:
 * raw HTML nodes become literal text so markup in an answer is displayed,
 * never executed. The upstream indentation-preserving variant is
 * simplified away (calendar answers do not need NBSP alignment); the
 * security property (no `html` node reaches hast) is unchanged.
 */
function literalHtml(tree: MdastRoot): void {
  visit(tree, "html", (node) => {
    (node as unknown as { type: string }).type = "text";
  });
}

/**
 * hast pass, verbatim from upstream `plugins/rehype/enhance-links`:
 * every link opens in a new tab with opener protection.
 */
function enhanceLinks(tree: HastRoot): void {
  visit(tree, "element", (node: Element) => {
    if (node.tagName !== "a") return;

    const props = node.properties ?? {};

    // Only modify if href exists
    if (!props.href) return;

    props.target = "_blank";
    props.rel = ["noopener", "noreferrer"];
    node.properties = props;
  });
}

/**
 * hast pass, verbatim from upstream
 * `plugins/rehype/enhance-tables`: a bare `<table>` keeps its
 * content-driven minimum width and would stretch the chat column past
 * the window, so wrap it in a scroll container instead (styled in
 * `app.css`, keeps the 360px floor intact).
 */
function enhanceTables(tree: HastRoot): void {
  visit(tree, "element", (node: Element, index, parent: Parent | undefined) => {
    if (node.tagName !== "table" || !parent || index === undefined) return;

    // already wrapped (e.g. nested tables in raw HTML input)
    const parentClass =
      parent.type === "element"
        ? (parent as Element).properties?.className
        : undefined;

    if (Array.isArray(parentClass) && parentClass.includes("table-wrapper"))
      return;

    const wrapper: Element = {
      children: [node as ElementContent],
      properties: { className: ["table-wrapper"] },
      tagName: "div",
      type: "element",
    };

    parent.children[index] = wrapper as ElementContent;
  });
}

/**
 * Strictest remote-image rule (plan: "strip img or block non-same-origin
 * src"). The app has no image use case, so every markdown image degrades
 * to its alt text and no `img` element ever reaches the sanitizer. The
 * sanitizer allowlist below additionally drops `img`/`src`/`srcset`, so
 * a future pipeline change cannot reintroduce remote media.
 */
function stripImages(tree: HastRoot): void {
  visit(tree, "element", (node: Element, index, parent: Parent | undefined) => {
    if (node.tagName !== "img" || !parent || index === undefined) return;

    const alt =
      typeof node.properties?.alt === "string" ? node.properties.alt : "";
    const text: HastText = { type: "text", value: alt };
    parent.children[index] = text as ElementContent;
    return index + 1;
  });
}

function extractLanguage(codeElement: Element): string {
  const className = codeElement.properties?.className;

  if (!Array.isArray(className)) return "text";

  for (const cls of className) {
    if (typeof cls === "string" && cls.startsWith("language-")) {
      return cls.slice("language-".length);
    }
  }

  return "text";
}

let codeBlockSeq = 0;

/**
 * hast pass adapted from upstream
 * `plugins/rehype/enhance-code-blocks`: wrap `<pre><code>` in a container
 * with a language label and a copy button. The upstream HTML preview
 * button (DialogCodePreview execution path) is intentionally not ported:
 * code blocks render as static highlighted source only.
 */
function enhanceCodeBlocks(tree: HastRoot): void {
  visit(tree, "element", (node: Element, index, parent: Parent | undefined) => {
    if (node.tagName !== "pre" || !parent || index === undefined) return;

    const codeElement = node.children.find(
      (child): child is Element =>
        child.type === "element" && (child as Element).tagName === "code",
    );

    if (!codeElement) return;

    const language = extractLanguage(codeElement);
    codeBlockSeq += 1;
    const codeId = `answer-code-${codeBlockSeq}`;

    codeElement.properties = {
      ...(codeElement.properties ?? {}),
      [CODE_ID_ATTR]: codeId,
    };

    const copyButton: Element = {
      children: [{ type: "text", value: "コピー" } as ElementContent],
      properties: {
        className: [CODE_COPY_BUTTON_CLASS],
        title: "コードをコピー",
        type: "button",
        [CODE_ID_ATTR]: codeId,
      },
      tagName: "button",
      type: "element",
    };

    const header: Element = {
      children: [
        {
          children: [{ type: "text", value: language } as ElementContent],
          properties: { className: ["code-language"] },
          tagName: "span",
          type: "element",
        },
        {
          children: [copyButton],
          properties: { className: ["code-block-actions"] },
          tagName: "div",
          type: "element",
        },
      ],
      properties: { className: ["code-block-header"] },
      tagName: "div",
      type: "element",
    };

    const wrapper: Element = {
      children: [
        header,
        {
          children: [node],
          properties: { className: ["code-scroll"] },
          tagName: "div",
          type: "element",
        },
      ],
      properties: { className: [CODE_BLOCK_WRAPPER_CLASS] },
      tagName: "div",
      type: "element",
    };

    // Replace pre with wrapper in parent
    parent.children[index] = wrapper as ElementContent;
  });
}

/**
 * DOMPurify allowlist adapted from upstream `safe-html-config.ts`:
 * the text/structure/table set plus code spans and link attributes.
 * Dropped vs upstream (nothing in this app needs them): `style`
 * (KaTeX-only; the fixed/absolute scrub hook goes with it), media
 * (`img`/`picture`/`source`/`video`/`audio`, `src`/`srcset`), MathML,
 * `id`. `data-*` (the code `data-code-id`) stays allowed via DOMPurify's
 * default `ALLOW_DATA_ATTR`.
 */
const SANITIZE_CONFIG = {
  ALLOWED_ATTR: [
    "class",
    "title",
    "href",
    "target",
    "rel",
    "colspan",
    "rowspan",
    "type",
    "aria-hidden",
    "aria-label",
    "aria-describedby",
    "aria-expanded",
  ],
  ALLOWED_TAGS: [
    // text and structure
    "a",
    "b",
    "i",
    "u",
    "s",
    "em",
    "strong",
    "code",
    "pre",
    "kbd",
    "sub",
    "sup",
    "br",
    "hr",
    "p",
    "span",
    "div",
    "blockquote",
    "ul",
    "ol",
    "li",
    "dl",
    "dt",
    "dd",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
    "colgroup",
    "col",
    "caption",
    // code-block chrome (language label, copy button)
    "button",
  ],
};

// Subset highlighter (replaces rehype-highlight with `{ detect: false }`):
// only `<pre><code class="language-x">` blocks whose language is
// registered are highlighted; unknown/missing languages and
// `no-highlight` are left as plain text (no auto-detect, no warnings).
const lowlight = createLowlight(HIGHLIGHT_LANGUAGES);
// JavaScript is a subset of the registered TypeScript grammar: highlight
// `javascript`/`js`/`jsx`/`mjs`/`cjs` blocks with it (same `hljs-` span
// output; the `language-javascript` class on the element is untouched).
lowlight.registerAlias({
  typescript: ["cjs", "javascript", "js", "jsx", "mjs"],
});

function codeText(node: Element): string {
  let out = "";
  const walk = (n: Element | ElementContent): void => {
    if (n.type === "text") {
      out += (n as HastText).value;
    } else if (n.type === "element") {
      for (const child of (n as Element).children) walk(child);
    }
  };
  for (const child of node.children) walk(child);
  return out;
}

function codeLanguage(node: Element): string | false | undefined {
  const list = node.properties?.className;
  if (!Array.isArray(list)) return undefined;
  let name: string | undefined;
  for (const entry of list) {
    const value = String(entry);
    if (value === "no-highlight" || value === "nohighlight") return false;
    if (name === undefined && value.startsWith("lang-")) {
      name = value.slice("lang-".length);
    }
    if (name === undefined && value.startsWith("language-")) {
      name = value.slice("language-".length);
    }
  }
  return name;
}

function highlightSubset(tree: HastRoot): void {
  visit(tree, "element", (node: Element, _index, parent) => {
    if (
      node.tagName !== "code" ||
      parent === undefined ||
      parent.type !== "element" ||
      (parent as Element).tagName !== "pre"
    ) {
      return;
    }
    const lang = codeLanguage(node);
    if (lang === false || lang === undefined || lang.length === 0) return;
    // Alias-aware: `javascript`/`js` resolve to the registered
    // `typescript` grammar via registerAlias above; anything else
    // unregistered (mermaid, …) stays static source.
    if (!lowlight.registered(lang)) return;
    if (!Array.isArray(node.properties.className)) {
      node.properties.className = [];
    }
    if (!node.properties.className.includes("hljs")) {
      node.properties.className.unshift("hljs");
    }
    let result: HastRoot;
    try {
      result = lowlight.highlight(lang, codeText(node), {
        prefix: "hljs-",
      });
    } catch {
      return;
    }
    if (result.children.length > 0) {
      node.children = result.children as ElementContent[];
    }
  });
}

/**
 * Render one validated answer part to sanitized HTML. Synchronous: every
 * pass is sync, and answers are short. Returns "" for empty input.
 * Throws never: pipeline failures degrade to escaped plain text so a
 * hostile or odd answer cannot break the transcript.
 */
export function renderAnswerMarkdown(text: string): string {
  if (text.length === 0) return "";
  let dirty: string;
  try {
    const mdast = fromMarkdown(text, {
      extensions: [gfm()],
      mdastExtensions: [gfmFromMarkdown()],
    });
    // remark-breaks equivalent (verbatim: newlineToBreak).
    newlineToBreak(mdast);
    literalHtml(mdast);
    // remark-rehype mutate-mode equivalent with default options.
    const hast = toHast(mdast);
    if (hast === null || hast === undefined || hast.type !== "root") {
      throw new Error("toHast: expected a root node");
    }
    // Former rehype plugin order is preserved: highlight must run before
    // the code-block wrapper replaces `<pre>` parents.
    highlightSubset(hast);
    stripImages(hast);
    enhanceTables(hast);
    enhanceLinks(hast);
    enhanceCodeBlocks(hast);
    // rehype-stringify equivalent with default options.
    dirty = toHtml(hast, {});
  } catch {
    dirty = text;
  }
  try {
    return DOMPurify.sanitize(dirty, SANITIZE_CONFIG) as unknown as string;
  } catch {
    return "";
  }
}
