# NOTICE — llama.cpp WebUI vendoring (V1 theme)

Upstream: https://github.com/ggml-org/llama.cpp
Pinned commit: `098ce526b546b5a190327c1da82929cee051b9ac`
Upstream license: MIT (verbatim text in `./LICENSE`)

## Source files adapted in V1

- `tools/ui/src/app.css` — the dark-theme token set (`.dark` oklch CSS
  variables), `--radius`, `--font-mono`, `--code-background` /
  `--code-foreground`, base typography/spacing, and the general dark
  look (bubbles, composer, buttons) were adapted into
  `apps/web/src/app.css` as hand-rolled CSS variables (dark only).

What was NOT taken: Tailwind CSS v4 itself, `@theme inline` bindings,
`bits-ui` / shadcn components, `mode-watcher`, markdown/code/mermaid
rendering, and all runtime JS. No upstream JS ships in this bundle.

Per-file provenance comments in `apps/web/src/app.css` are marked
`llama-webui:`.
