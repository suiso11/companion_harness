// UI shells: Hono JSX SSR + strict CSP (plan §16.1, §16.7).
//
// The server renders the shells with Hono JSX (`hono/jsx` runtime, no
// framework). Since PR-1 the interactive UI is the Svelte chat app
// (`apps/web`) built by `scripts/build-ui.mjs` and served as a static
// asset. No inline scripts/styles, no external origins, no UI framework.
// PR-6: the legacy vanilla shell (`renderConversationShell` +
// `src/ui/client.ts` + panels) was removed; `/legacy` now 404s.

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
 * Slice (b) minimal login form for unauthenticated browsers in remote
 * mode. Deliberately script-free: no inline/bundled script, no external
 * origins — a plain HTML form POSTing
 * `application/x-www-form-urlencoded` to `/api/remote/login`, which the
 * server accepts alongside JSON. The only asset is the shared self-hosted
 * stylesheet (`/assets/client.css`, slice (c) responsive rules included)
 * so the form stays usable at 360px width and 200% text zoom; the form
 * works without it (plain flow layout). Served only when the session
 * cookie is absent/invalid; authenticated browsers get the normal shell.
 */
export function renderRemoteLogin(): HtmlEscapedString {
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
      jsx("title", {}, "Companion Harness — ログイン"),
      jsx("link", { rel: "stylesheet", href: "/assets/client.css" }),
    ),
    jsx(
      "body",
      {},
      jsx(
        "main",
        {},
        jsx("h1", {}, "ログイン"),
        jsx(
          "form",
          { method: "post", action: "/api/remote/login" },
          jsx(
            "label",
            {},
            "パスワード",
            jsx("input", {
              type: "password",
              name: "password",
              autocomplete: "current-password",
            }),
          ),
          jsx("button", { type: "submit" }, "ログイン"),
        ),
      ),
    ),
  ) as unknown as HtmlEscapedString;
}

/**
 * PR-1 Svelte chat shell (frontend plan §12 PR-1): dark-only, Japanese.
 * Same strict CSP as the vanilla shell; the ONLY script/style references
 * are the self-hosted Svelte bundle built by `scripts/build-ui.mjs` from
 * `apps/web` (no CDN, no inline script/style/handlers). The interactive
 * DOM (same `#conversation`/`#composer*`/`#drawer*` ids and `data-action-*`
 * attributes as the vanilla shell) is rendered client-side by the bundle;
 * the SSR fragment carries only the mount point plus a no-script notice.
 */
export function renderSvelteShell(): HtmlEscapedString {
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
      jsx("meta", { name: "color-scheme", content: "dark" }),
      jsx("title", {}, "Companion Harness"),
      jsx("link", { rel: "stylesheet", href: "/assets/svelte-app.css" }),
    ),
    jsx(
      "body",
      {},
      jsx("div", { id: "svelte-root" }),
      jsx(
        "noscript",
        {},
        "このページを利用するには JavaScript を有効にしてください",
      ),
      // ES module: the PR-5 route chunks import shared symbols from the
      // entry bundle, so it must be loaded as a module (same self-hosted
      // asset, same strict CSP; modules defer like `defer`).
      jsx("script", {
        type: "module",
        src: "/assets/svelte-app.js",
      }),
    ),
  ) as unknown as HtmlEscapedString;
}

/** The shell carries no user/external strings; this guards regressions. */
export function shellHasNoInlineScript(html: string): boolean {
  const lower = html.toLowerCase();
  if (
    lower.includes("<script") &&
    !lower.includes('src="/assets/client.js"') &&
    !lower.includes('src="/assets/svelte-app.js"')
  ) {
    return false;
  }
  // Inline event handlers are attributes like ` onclick=` / ` onerror=`;
  // require the leading attribute boundary so `content=` never matches.
  return !/\son\w+\s*=/u.test(lower);
}

export { escapeHtml };
