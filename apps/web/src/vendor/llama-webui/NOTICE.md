# NOTICE — llama.cpp WebUI vendoring (V1 theme + V2 messages/markdown)

Upstream: https://github.com/ggml-org/llama.cpp
Pinned commit: `098ce526b546b5a190327c1da82929cee051b9ac`
Upstream license: MIT (verbatim text in `./LICENSE`)

## Source files adapted in V1

- `tools/ui/src/app.css` — the dark-theme token set (`.dark` oklch CSS
  variables), `--radius`, `--font-mono`, `--code-background` /
  `--code-foreground`, base typography/spacing, and the general dark
  look (bubbles, composer, buttons) were adapted into
  `apps/web/src/app.css` as hand-rolled CSS variables (dark only).

What was NOT taken in V1: Tailwind CSS v4 itself, `@theme inline`
bindings, `bits-ui` / shadcn components, `mode-watcher`, markdown/code/
mermaid rendering, and all runtime JS. No upstream JS ships in this bundle.

Per-file provenance comments in `apps/web/src/app.css` are marked
`llama-webui:`.

## Source files adapted in V2 (validated-answer markdown + layout)

- `tools/ui/src/lib/components/app/content/MarkdownContent/markdown-processor.ts`
  — the remark→rehype pipeline shape (gfm, breaks, highlight, link/table/
  code-block enhancers, shared process-wide cache) was adapted into
  `apps/web/src/lib/markdown.ts`. Attachments, math, and the
  per-attachment cache are gone: one shared sync pipeline, math disabled.
- `.../MarkdownContent/plugins/remark/literal-html.ts` — raw-HTML-as-text
  (allowHtml=false) adapted in simplified form: `html` nodes become text
  nodes before rehype, so answer markup is displayed, never executed.
- `.../MarkdownContent/plugins/rehype/enhance-links.ts` — verbatim logic:
  every link gets `target="_blank" rel="noopener noreferrer"`.
- `.../MarkdownContent/plugins/rehype/enhance-tables.ts` — verbatim logic:
  tables are wrapped in a `table-wrapper` horizontal scroll container.
- `.../MarkdownContent/plugins/rehype/enhance-code-blocks.ts` (+
  `code-block-utils.ts`) — adapted: wrapper + language label + copy
  button only. The HTML preview button (code execution path) is
  intentionally not ported; mermaid/svg diagram blocks are static source.
- `.../MarkdownContent/safe-html-config.ts` — the DOMPurify allowlist
  adapted and tightened: `style`, media (`img`/`picture`/`source`/
  `video`/`audio`, `src`/`srcset`), MathML, and `id` are dropped (nothing
  in this app needs them; KaTeX is the only upstream `style` consumer).
  `data-*` stays allowed for the code `data-code-id`. A new
  `rehypeStripImages` step degrades markdown images to alt text, so no
  `img` ever reaches the sanitizer (strictest remote-image rule).
- `.../MarkdownContent/markdown-content.css` — the answer-typography,
  code-block chrome, table-wrapper, and highlight-token styling were
  adapted into `apps/web/src/app.css` (dark-only, hand-rolled; code
  colors mirror the `github-dark` token palette).
- `tools/ui/src/lib/components/app/chat/ChatMessages/ChatMessage/
  ChatMessageUser/*` + `ChatMessageAssistant/*` — the bubble language
  (user right-side bubble, assistant borderless row) was adapted into
  `apps/web/src/app.css`; the Svelte components themselves were NOT
  taken (store/dexie-bound). Layout follows the upstream chat column:
  slim top header, scrollable centered message list, pinned composer.

What is still NOT taken: Tailwind, `bits-ui` / shadcn, `mode-watcher`,
`svelte` stores, KaTeX/mermaid/highlight.js full bundles (`lowlightAll`
is banned — only 7 highlight.js grammars are registered, so tree-shaking
keeps the rest out), `DialogCodePreview` execution, attachment/pdfjs/
sandbox/nerdamer/MCP runtimes, dexie persistence.

Per-file provenance comments in `apps/web/src/lib/markdown.ts` name the
upstream file each plugin mirrors.
