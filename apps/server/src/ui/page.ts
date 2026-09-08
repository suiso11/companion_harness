// M3 conversation shell: Hono JSX SSR + strict CSP (plan §16.1, §16.7).
//
// The server renders the shell with Hono JSX (`hono/jsx` runtime, no
// framework). The interactive UI is vanilla TypeScript (DOM API only,
// `src/ui/client.ts`) bundled with esbuild and served as a static asset.
// No inline scripts/styles, no external origins, no UI framework.

import { jsx } from "hono/jsx";
import type { HtmlEscapedString } from "hono/utils/html";
import { escapeHtml } from "./escape.js";

/**
 * Strict Content-Security-Policy (plan §16.7 exact): only the self-hosted
 * esbuild bundle and self connections. Inline scripts/styles and external
 * origins are forbidden.
 */
export const STRICT_CSP =
  "default-src 'self'; " +
  "script-src 'self'; " +
  "style-src 'self'; " +
  "img-src 'self' data:; " +
  "connect-src 'self'; " +
  "object-src 'none'; " +
  "base-uri 'self'; " +
  "frame-ancestors 'none'";

/**
 * Static shell rendered by Hono JSX on GET /. NOTE: the raw `hono/jsx`
 * runtime signature is `jsx(tag, props, children)` — children are the
 * THIRD argument, never `props.children` (that only exists for components).
 */
export function renderConversationShell(): HtmlEscapedString {
  return jsx(
    "html",
    { lang: "ja" },
    jsx(
      "head",
      {},
      jsx("meta", { charset: "utf-8" }),
      jsx("meta", {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      }),
      jsx("title", {}, "Companion Harness"),
      jsx("link", { rel: "stylesheet", href: "/assets/client.css" }),
    ),
    jsx(
      "body",
      {},
      jsx(
        "main",
        { id: "conversation", "aria-live": "polite" },
        jsx("p", {}, "読み込み中…"),
      ),
      jsx(
        "div",
        { id: "drawer", hidden: true, role: "dialog", "aria-label": "引用" },
        jsx("pre", { id: "drawer-body" }),
      ),
      jsx("p", { id: "composer-notice", "aria-live": "polite" }),
      jsx(
        "form",
        { id: "composer" },
        jsx("input", {
          id: "composer-input",
          type: "text",
          autocomplete: "off",
        }),
        jsx("button", { id: "composer-send", type: "submit" }, "送信"),
        jsx("button", { id: "composer-stop", type: "button", hidden: true }, "停止"),
      ),
      jsx("script", { src: "/assets/client.js", defer: true }),
    ),
  ) as unknown as HtmlEscapedString;
}

/** The shell carries no user/external strings; this guards regressions. */
export function shellHasNoInlineScript(html: string): boolean {
  const lower = html.toLowerCase();
  if (lower.includes("<script") && !lower.includes('src="/assets/client.js"')) {
    return false;
  }
  // Inline event handlers are attributes like ` onclick=` / ` onerror=`;
  // require the leading attribute boundary so `content=` never matches.
  return !/\son\w+\s*=/u.test(lower);
}

export { escapeHtml };
