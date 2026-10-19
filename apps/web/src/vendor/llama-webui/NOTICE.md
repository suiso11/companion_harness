# NOTICE — llama.cpp WebUI vendoring (V1 theme + V2 messages/markdown + V3/V4 reasoning/stats/composer)

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

## Source files adapted in V3 (reasoning block + statistics)

- `tools/ui/src/lib/components/app/chat/ChatMessages/ChatMessageReasoningBlock.svelte`
  — the collapsible reasoning header (chevron + "Thinking" title, muted
  mono body, auto-collapse on answer) was adapted into the existing
  `[data-thinking]` section in `apps/web/src/App.svelte` + `app.css`
  (`.thinking-toggle` / `.thinking-chevron` / `.thinking-body`). Behavior
  is unchanged (expanded while streaming, collapsed on terminal); DOM
  contracts kept (`data-thinking`, `data-thinking-toggle`,
  `aria-expanded`, `data-thinking-text`, `aria-live`).
- `tools/ui/src/lib/components/app/chat/ChatMessages/ChatMessage/ChatMessageAssistant/ChatMessageAssistantStatistics.svelte`
  (+ nearby `formatters.ts` performance-time formatting) — the props-driven
  completion stats line (tokens, tok/s, elapsed) was adapted into
  `formatThinkingStats()` in `apps/web/src/lib/thinking.ts`, fed by the
  existing `model.usage` data. The status/phase line keeps its durable
  derivation; only its stats companion changed shape.

What is still NOT taken: `bits-ui` collapsible, tooltip components,
chat/tool stores, dexie. No upstream JS ships; only the look is mirrored.

## Source files adapted in V4 (composer)

- `tools/ui/src/lib/components/app/chat/ChatForm/ChatFormInput/ChatFormInputBasic.svelte`
  + `tools/ui/src/lib/utils/autoresize-textarea.ts` — the autosizing
  textarea pattern (auto-grow to ~10 lines, then scroll) was adapted into
  `#composer-input` (now a `<textarea rows=1>`) in `App.svelte` + `app.css`
  (`autogrowTextarea()` in `apps/web/src/lib/composer.ts`). Enter submits
  via `shouldSendOnKeydown()`; Shift+Enter inserts a newline; IME
  composition (`isComposing` + `compositionstart/end` flag) never submits
  — load-bearing for Japanese input.
- `tools/ui/src/lib/components/app/chat/ChatForm/ChatFormActions/ChatFormActionSubmit.svelte`
  — the submit/stop affordance informed the composer controls, but the
  existing two-button DOM contract is kept verbatim: `#composer-send`
  (disabled while a run is active) + `#composer-stop` (visible while a
  run is active, wired to the existing cancel; C22 card Stop untouched).
  `bits-ui` Button/Tooltip and lucide ArrowUp were not taken; targets stay
  >=44px with the iOS safe-area inset.
