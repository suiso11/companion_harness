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
        "section",
        { id: "memory", "aria-label": "記憶の管理" },
        jsx("h2", {}, "記憶の管理"),
        jsx(
          "form",
          { id: "memory-search-form" },
          jsx("input", {
            id: "memory-search-input",
            type: "text",
            autocomplete: "off",
          }),
          jsx(
            "button",
            { id: "memory-search-button", type: "submit" },
            "記憶を検索",
          ),
        ),
        jsx("ul", { id: "memory-list" }),
        jsx(
          "div",
          { id: "memory-detail", hidden: true },
          jsx("pre", { id: "memory-detail-body" }),
          jsx("textarea", { id: "memory-correct-input" }),
          jsx(
            "button",
            { id: "memory-correct-button", type: "button" },
            "訂正をキュー",
          ),
          jsx(
            "button",
            { id: "memory-retire-button", type: "button" },
            "引退をキュー",
          ),
          jsx(
            "button",
            { id: "memory-reactivate-button", type: "button" },
            "再活性をキュー",
          ),
          jsx(
            "button",
            { id: "memory-retry-button", type: "button", hidden: true },
            "同じ内容で再送",
          ),
          jsx("p", { id: "memory-op-status", "aria-live": "polite" }),
        ),
      ),
      jsx(
        "section",
        { id: "autonomy", "aria-label": "自律メモの管理" },
        jsx("h2", {}, "自律メモの管理"),
        jsx(
          "div",
          { id: "autonomy-control" },
          jsx("p", { id: "autonomy-control-status", "aria-live": "polite" }),
          jsx(
            "button",
            { id: "autonomy-stop-button", type: "button" },
            "自律動作を止める",
          ),
          jsx(
            "button",
            { id: "autonomy-resume-button", type: "button" },
            "自律動作を再開",
          ),
        ),
        jsx(
          "form",
          { id: "autonomy-purpose-form" },
          jsx("input", {
            id: "autonomy-purpose-scope",
            type: "text",
            autocomplete: "off",
          }),
          jsx("textarea", { id: "autonomy-purpose-statement" }),
          jsx(
            "select",
            { id: "autonomy-purpose-kind" },
            jsx("option", { value: "goal" }, "目標"),
            jsx("option", { value: "preference" }, "好み"),
            jsx("option", { value: "constraint" }, "制約"),
            jsx("option", { value: "permission" }, "許可の記録"),
            jsx("option", { value: "wish" }, "希望"),
            jsx("option", { value: "temporary_state" }, "一時状態"),
          ),
          jsx(
            "select",
            { id: "autonomy-purpose-source" },
            jsx("option", { value: "user" }, "本人"),
            jsx("option", { value: "self" }, "記録"),
            jsx("option", { value: "external" }, "外部"),
          ),
          jsx("textarea", { id: "autonomy-purpose-interpretation" }),
          jsx("input", {
            id: "autonomy-purpose-valid-from",
            type: "text",
            autocomplete: "off",
          }),
          jsx("input", {
            id: "autonomy-purpose-valid-until",
            type: "text",
            autocomplete: "off",
          }),
          jsx(
            "button",
            { id: "autonomy-purpose-create", type: "submit" },
            "目的を記録",
          ),
        ),
        jsx("ul", { id: "autonomy-purpose-list" }),
        jsx(
          "div",
          { id: "autonomy-purpose-detail", hidden: true },
          jsx("pre", { id: "autonomy-purpose-detail-body" }),
          jsx("textarea", { id: "autonomy-purpose-correct-input" }),
          jsx("input", {
            id: "autonomy-purpose-correct-valid-from",
            type: "text",
            autocomplete: "off",
          }),
          jsx("input", {
            id: "autonomy-purpose-correct-valid-until",
            type: "text",
            autocomplete: "off",
          }),
          jsx(
            "button",
            { id: "autonomy-purpose-correct-button", type: "button" },
            "訂正を記録",
          ),
          jsx(
            "button",
            { id: "autonomy-purpose-revoke-button", type: "button" },
            "取り消す",
          ),
          jsx(
            "button",
            { id: "autonomy-purpose-achieve-button", type: "button" },
            "達成にする",
          ),
          jsx("p", { id: "autonomy-conflicts", "aria-live": "polite" }),
          jsx(
            "button",
            { id: "autonomy-conflict-mark-button", type: "button" },
            "競合として記録",
          ),
        ),
        jsx(
          "form",
          { id: "autonomy-task-form" },
          jsx("input", {
            id: "autonomy-task-title",
            type: "text",
            autocomplete: "off",
          }),
          jsx(
            "select",
            { id: "autonomy-task-kind" },
            jsx("option", { value: "chat" }, "相談"),
            jsx("option", { value: "wish" }, "希望"),
            jsx("option", { value: "problem" }, "課題"),
            jsx("option", { value: "task" }, "作業"),
          ),
          jsx(
            "select",
            { id: "autonomy-task-speaker" },
            jsx("option", { value: "user" }, "本人"),
            jsx("option", { value: "self" }, "記録"),
            jsx("option", { value: "external" }, "外部"),
          ),
          jsx("input", {
            id: "autonomy-task-scope",
            type: "text",
            autocomplete: "off",
          }),
          jsx(
            "select",
            { id: "autonomy-task-parent-mode" },
            jsx("option", { value: "attached" }, "選択中の目的に結びつける"),
            jsx("option", { value: "standalone" }, "単独で記録"),
          ),
          jsx("input", {
            id: "autonomy-task-deadline",
            type: "text",
            autocomplete: "off",
          }),
          jsx(
            "button",
            { id: "autonomy-task-create", type: "submit" },
            "作業を記録",
          ),
        ),
        jsx("ul", { id: "autonomy-task-list" }),
        jsx(
          "div",
          { id: "autonomy-task-detail", hidden: true },
          jsx("pre", { id: "autonomy-task-detail-body" }),
          jsx("textarea", { id: "autonomy-task-hold-input" }),
          jsx("textarea", { id: "autonomy-task-resume-input" }),
          jsx("input", {
            id: "autonomy-task-resume-use-parent",
            type: "checkbox",
          }),
          jsx(
            "button",
            { id: "autonomy-task-start-button", type: "button" },
            "開始",
          ),
          jsx(
            "button",
            { id: "autonomy-task-hold-button", type: "button" },
            "保留",
          ),
          jsx(
            "button",
            { id: "autonomy-task-resume-button", type: "button" },
            "再開",
          ),
          jsx(
            "button",
            { id: "autonomy-task-complete-button", type: "button" },
            "完了",
          ),
          jsx(
            "button",
            { id: "autonomy-task-cancel-button", type: "button" },
            "中止",
          ),
        ),
        jsx("p", { id: "autonomy-status", "aria-live": "polite" }),
        jsx("p", { id: "autonomy-pending", "aria-live": "polite" }),
        jsx(
          "button",
          { id: "autonomy-retry-button", type: "button" },
          "同じ内容で再送",
        ),
      ),
      jsx(
        "section",
        { id: "shadow", "aria-label": "試行の記録" },
        jsx("h2", {}, "試行の記録"),
        jsx(
          "p",
          { id: "shadow-disclaimer" },
          "試行のみ・未実行・記録は権限付与ではない",
        ),
        jsx(
          "form",
          { id: "shadow-request-form" },
          jsx("input", {
            id: "shadow-scope",
            type: "text",
            autocomplete: "off",
          }),
          jsx("textarea", { id: "shadow-reason" }),
          jsx(
            "button",
            { id: "shadow-request-submit", type: "submit" },
            "試行を依頼",
          ),
        ),
        jsx("p", { id: "shadow-status", "aria-live": "polite" }),
        jsx("button", { id: "shadow-refresh", type: "button" }, "一覧を更新"),
        jsx("ul", { id: "shadow-job-list" }),
        // The frozen-request retry belongs to the request surface, NOT the
        // detail panel: the detail stays hidden until a job is selected, so
        // a retry nested inside it could never be pressed after an
        // uncertain POST (pinned by the shadow browser regression).
        jsx(
          "button",
          { id: "shadow-retry", type: "button", hidden: true },
          "同じ内容で再送",
        ),
        jsx(
          "div",
          { id: "shadow-detail", hidden: true },
          jsx("pre", { id: "shadow-detail-body" }),
        ),
      ),
      jsx(
        "section",
        { id: "notifications", "aria-label": "お知らせ" },
        jsx("h2", {}, "お知らせ"),
        jsx("p", { id: "notification-badge", "aria-live": "polite" }),
        jsx("div", { id: "notification-urgent", "aria-live": "assertive" }),
        jsx("div", { id: "notification-routine", "aria-live": "polite" }),
        jsx("ul", { id: "notification-list" }),
        jsx(
          "button",
          { id: "notification-older", type: "button", hidden: true },
          "古いお知らせを読み込む",
        ),
        jsx(
          "div",
          { id: "notification-detail", hidden: true },
          jsx("div", { id: "notification-detail-body" }),
          jsx(
            "button",
            { id: "notification-ack", type: "button" },
            "確認済みにする",
          ),
          jsx(
            "button",
            { id: "notification-retry", type: "button", hidden: true },
            "同じ内容で再送",
          ),
          jsx("p", { id: "notification-status", "aria-live": "polite" }),
        ),
      ),
      jsx(
        "section",
        { id: "proposals", "aria-label": "会話の候補" },
        jsx("h2", {}, "会話の候補"),
        jsx("p", { id: "proposal-badge", "aria-live": "polite" }),
        jsx("p", { id: "proposal-brief", "aria-live": "polite" }),
        jsx("ul", { id: "proposal-list" }),
        jsx("button", { id: "proposal-refresh", type: "button" }, "候補を更新"),
        jsx(
          "button",
          { id: "proposal-more", type: "button", hidden: true },
          "古い履歴を読み込む",
        ),
        jsx(
          "div",
          { id: "proposal-detail", hidden: true },
          jsx("div", { id: "proposal-detail-body" }),
          jsx("p", { id: "proposal-parent", "aria-live": "polite" }),
          jsx("p", { id: "proposal-date-label" }),
          jsx("input", {
            id: "proposal-date",
            type: "text",
            autocomplete: "off",
          }),
          jsx("input", {
            id: "proposal-date-until",
            type: "text",
            autocomplete: "off",
            hidden: true,
          }),
          jsx("button", { id: "proposal-accept", type: "button" }, "採用する"),
          jsx("button", { id: "proposal-reject", type: "button" }, "見送る"),
          jsx(
            "button",
            { id: "proposal-retry", type: "button", hidden: true },
            "同じ内容で再送",
          ),
          jsx("p", { id: "proposal-status", "aria-live": "polite" }),
        ),
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
        jsx(
          "button",
          { id: "composer-send", type: "submit", disabled: true },
          "送信",
        ),
        jsx(
          "button",
          { id: "composer-stop", type: "button", hidden: true },
          "停止",
        ),
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
