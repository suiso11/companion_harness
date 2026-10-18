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
            "／",
            "自律作業を止める",
          ),
          jsx(
            "button",
            { id: "autonomy-resume-button", type: "button" },
            "自律動作を再開",
            "／",
            "自律作業を再開",
          ),
        ),
        jsx(
          "form",
          { id: "autonomy-purpose-form" },
          jsx(
            "label",
            {},
            "範囲",
            jsx("input", {
              id: "autonomy-purpose-scope",
              type: "text",
              autocomplete: "off",
            }),
          ),
          jsx(
            "label",
            {},
            "目的の内容",
            jsx("textarea", { id: "autonomy-purpose-statement" }),
          ),
          jsx(
            "label",
            {},
            "種類",
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
          ),
          jsx(
            "label",
            {},
            "出所",
            jsx(
              "select",
              { id: "autonomy-purpose-source" },
              jsx("option", { value: "user" }, "本人"),
              jsx("option", { value: "self" }, "記録"),
              jsx("option", { value: "external" }, "外部"),
            ),
          ),
          jsx(
            "label",
            {},
            "本人の明示的な記録（外すと推測の記録）",
            jsx("input", {
              id: "autonomy-purpose-explicit",
              type: "checkbox",
              checked: true,
            }),
          ),
          jsx(
            "label",
            {},
            "解釈（元の記録と別に保存）",
            jsx("textarea", { id: "autonomy-purpose-interpretation" }),
          ),
          jsx(
            "label",
            {},
            "適用開始（任意・厳密な日時）",
            jsx("input", {
              id: "autonomy-purpose-valid-from",
              type: "text",
              autocomplete: "off",
            }),
          ),
          jsx(
            "label",
            {},
            "適用終了（任意・厳密な日時）",
            jsx("input", {
              id: "autonomy-purpose-valid-until",
              type: "text",
              autocomplete: "off",
            }),
          ),
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
          jsx(
            "label",
            {},
            "訂正内容",
            jsx("textarea", { id: "autonomy-purpose-correct-input" }),
          ),
          jsx(
            "label",
            {},
            "適用開始の訂正（空で維持・clearで解除）",
            jsx("input", {
              id: "autonomy-purpose-correct-valid-from",
              type: "text",
              autocomplete: "off",
            }),
          ),
          jsx(
            "label",
            {},
            "適用終了の訂正（空で維持・clearで解除）",
            jsx("input", {
              id: "autonomy-purpose-correct-valid-until",
              type: "text",
              autocomplete: "off",
            }),
          ),
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
          jsx(
            "button",
            {
              id: "autonomy-purpose-history-more-button",
              type: "button",
              hidden: true,
            },
            "履歴をもっと見る",
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
          jsx(
            "label",
            {},
            "作業内容",
            jsx("input", {
              id: "autonomy-task-title",
              type: "text",
              autocomplete: "off",
            }),
          ),
          jsx(
            "label",
            {},
            "種類",
            jsx(
              "select",
              { id: "autonomy-task-kind" },
              jsx("option", { value: "chat" }, "相談"),
              jsx("option", { value: "wish" }, "希望"),
              jsx("option", { value: "problem" }, "課題"),
              jsx("option", { value: "task" }, "作業"),
            ),
          ),
          jsx(
            "label",
            {},
            "話者",
            jsx(
              "select",
              { id: "autonomy-task-speaker" },
              jsx("option", { value: "user" }, "本人"),
              jsx("option", { value: "self" }, "記録"),
              jsx("option", { value: "external" }, "外部"),
            ),
          ),
          jsx(
            "label",
            {},
            "範囲",
            jsx("input", {
              id: "autonomy-task-scope",
              type: "text",
              autocomplete: "off",
            }),
          ),
          jsx(
            "label",
            {},
            "親の目的",
            jsx(
              "select",
              { id: "autonomy-task-parent-mode" },
              jsx("option", { value: "attached" }, "選択中の目的に結びつける"),
              jsx("option", { value: "standalone" }, "単独で記録"),
            ),
          ),
          jsx(
            "label",
            {},
            "期限（任意・厳密な日時）",
            jsx("input", {
              id: "autonomy-task-deadline",
              type: "text",
              autocomplete: "off",
            }),
          ),
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
          jsx(
            "label",
            {},
            "保留理由",
            jsx("textarea", { id: "autonomy-task-hold-input" }),
          ),
          jsx(
            "label",
            {},
            "再開の条件",
            jsx("textarea", { id: "autonomy-task-reconsider-input" }),
          ),
          jsx(
            "label",
            {},
            "再開の根拠の種類",
            jsx(
              "select",
              { id: "autonomy-task-evidence-kind" },
              jsx("option", { value: "user_confirmed" }, "本人が確認"),
              jsx("option", { value: "parent_changed" }, "親の変更"),
              jsx(
                "option",
                { value: "dependency_completed" },
                "依存作業の完了",
              ),
              jsx("option", { value: "correction_applied" }, "訂正の反映"),
              jsx("option", { value: "external_input" }, "外部からの入力"),
            ),
          ),
          jsx(
            "label",
            {},
            "再開の根拠",
            jsx("textarea", { id: "autonomy-task-resume-input" }),
          ),
          jsx(
            "label",
            {},
            "置き換え先の目的を使う",
            jsx("input", {
              id: "autonomy-task-resume-use-parent",
              type: "checkbox",
            }),
          ),
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
          jsx(
            "button",
            {
              id: "autonomy-task-history-more-button",
              type: "button",
              hidden: true,
            },
            "履歴をもっと見る",
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
        { id: "trials", "aria-label": "試行の提案" },
        jsx("h2", {}, "試行の提案"),
        jsx("p", { id: "trial-status", "aria-live": "polite" }),
        jsx("ul", { id: "trial-list" }),
        jsx(
          "div",
          { id: "trial-detail", hidden: true },
          jsx("pre", { id: "trial-detail-body" }),
          jsx(
            "button",
            { id: "trial-approve-button", type: "button" },
            "承認する",
          ),
          jsx(
            "button",
            { id: "trial-expire-button", type: "button" },
            "取り消す",
          ),
          jsx("p", { id: "trial-op-status", "aria-live": "polite" }),
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
        ),
        // The frozen-request retry + op status belong to the section, NOT
        // the detail drawer: the drawer stays hidden until a draft is
        // selected, so a retry nested inside it could never be pressed
        // after an uncertain POST with no selection.
        jsx(
          "button",
          { id: "proposal-retry", type: "button", hidden: true },
          "同じ内容で再送",
        ),
        jsx("p", { id: "proposal-status", "aria-live": "polite" }),
      ),
      jsx(
        "section",
        { id: "learning", "aria-label": "学びの記録" },
        jsx("h2", {}, "学びの記録"),
        jsx(
          "p",
          {},
          "仮説は事実ではありません（支持・反証・引退は明示の操作のみ）",
        ),
        jsx(
          "form",
          { id: "learning-create-form" },
          jsx("input", {
            id: "learning-scope",
            type: "text",
            autocomplete: "off",
          }),
          jsx(
            "select",
            { id: "learning-kind" },
            jsx("option", { value: "method" }, "方法"),
            jsx("option", { value: "hypothesis" }, "仮説"),
          ),
          jsx("textarea", { id: "learning-statement" }),
          jsx(
            "button",
            { id: "learning-create", type: "button" },
            "仮説を記録",
          ),
        ),
        jsx("ul", { id: "learning-list" }),
        jsx("button", { id: "learning-refresh", type: "button" }, "一覧を更新"),
        jsx(
          "button",
          { id: "learning-more", type: "button", hidden: true },
          "古い履歴を読み込む",
        ),
        jsx(
          "div",
          { id: "learning-detail", hidden: true },
          jsx("div", { id: "learning-detail-body" }),
          jsx("ul", { id: "learning-evidence-list" }),
          jsx(
            "button",
            { id: "learning-evidence-more", type: "button", hidden: true },
            "古い証拠を読み込む",
          ),
          jsx(
            "select",
            { id: "learning-evidence-polarity" },
            jsx("option", { value: "supports" }, "支持"),
            jsx("option", { value: "refutes" }, "反証"),
            jsx("option", { value: "neutral" }, "中立"),
          ),
          jsx(
            "select",
            { id: "learning-evidence-source-kind" },
            jsx("option", { value: "shadow_job" }, "試行"),
            jsx("option", { value: "conversation_proposal" }, "会話の候補"),
            jsx("option", { value: "action_receipt" }, "実行記録"),
            jsx("option", { value: "task_event" }, "作業履歴"),
          ),
          jsx("input", {
            id: "learning-evidence-source-id",
            type: "text",
            autocomplete: "off",
          }),
          jsx("input", {
            id: "learning-evidence-note",
            type: "text",
            autocomplete: "off",
          }),
          jsx(
            "button",
            { id: "learning-evidence-attach", type: "button" },
            "証拠を結びつける",
          ),
          jsx("button", { id: "learning-support", type: "button" }, "支持する"),
          jsx("button", { id: "learning-refute", type: "button" }, "反証する"),
          jsx("button", { id: "learning-retire", type: "button" }, "引退する"),
          jsx(
            "button",
            { id: "learning-reaffirm", type: "button" },
            "再確認する",
          ),
          jsx("button", { id: "learning-accept", type: "button" }, "採用する"),
          jsx("button", { id: "learning-reject", type: "button" }, "見送る"),
        ),
        // The frozen-request retry + op status belong to the section, NOT
        // the detail drawer: the drawer stays hidden until a hypothesis is
        // selected, so a retry nested inside it could never be pressed
        // after an uncertain POST with no selection (same pattern as the
        // shadow retry above).
        jsx(
          "button",
          { id: "learning-retry", type: "button", hidden: true },
          "同じ内容で再送",
        ),
        jsx("p", { id: "learning-status", "aria-live": "polite" }),
      ),
      jsx(
        "section",
        { id: "handoff", "aria-label": "引継ぎ" },
        jsx("h2", {}, "引継ぎ（pi-orchへの手動受渡）"),
        jsx(
          "p",
          {},
          "実行は自動化されません。人が仕様を貼り付けてpi-orchへ渡し、検証済み結果を記録します（サンドボックス成功≠本番／権限は別途承認）",
        ),
        jsx(
          "form",
          { id: "handoff-create-form" },
          jsx("input", {
            id: "handoff-task",
            type: "text",
            autocomplete: "off",
            list: "handoff-task-list",
          }),
          jsx("datalist", { id: "handoff-task-list" }),
          jsx("textarea", { id: "handoff-target" }),
          jsx("textarea", { id: "handoff-criteria" }),
          jsx(
            "select",
            { id: "handoff-op-scope" },
            jsx("option", { value: "investigate" }, "調査"),
            jsx("option", { value: "implement" }, "実装"),
          ),
          jsx("input", {
            id: "handoff-budget",
            type: "text",
            autocomplete: "off",
          }),
          jsx(
            "select",
            { id: "handoff-boundaries", multiple: true },
            jsx("option", { value: "external_publication" }, "外部公開"),
            jsx("option", { value: "shared_branch" }, "共有ブランチ"),
            jsx("option", { value: "payment" }, "支払い"),
            jsx("option", { value: "deletion" }, "削除"),
            jsx("option", { value: "secret" }, "秘密情報"),
            jsx("option", { value: "access_change" }, "権限変更"),
          ),
          jsx("input", {
            id: "handoff-supersedes",
            type: "text",
            autocomplete: "off",
            list: "handoff-supersedes-list",
          }),
          jsx("datalist", { id: "handoff-supersedes-list" }),
          jsx(
            "button",
            { id: "handoff-create", type: "button" },
            "引継ぎを記録",
          ),
        ),
        jsx("p", { id: "handoff-active-count", "aria-live": "polite" }),
        jsx("ul", { id: "handoff-list" }),
        jsx("button", { id: "handoff-refresh", type: "button" }, "一覧を更新"),
        jsx(
          "button",
          { id: "handoff-more", type: "button", hidden: true },
          "古い履歴を読み込む",
        ),
        jsx(
          "div",
          { id: "handoff-detail", hidden: true },
          jsx("div", { id: "handoff-detail-body" }),
          jsx("ul", { id: "handoff-events-list" }),
          jsx("ul", { id: "handoff-attempts-list" }),
          jsx("input", {
            id: "handoff-external-ref",
            type: "text",
            autocomplete: "off",
          }),
          jsx("button", { id: "handoff-dispatch", type: "button" }, "送付する"),
          jsx(
            "select",
            { id: "handoff-report-env" },
            jsx("option", { value: "sandbox" }, "砂箱"),
            jsx("option", { value: "production" }, "本番（未検証申告）"),
          ),
          jsx("textarea", { id: "handoff-report-summary" }),
          jsx("button", { id: "handoff-report", type: "button" }, "報告する"),
          jsx("div", { id: "handoff-verify-rows" }),
          jsx("button", { id: "handoff-verify", type: "button" }, "検証する"),
          jsx("button", { id: "handoff-fail", type: "button" }, "失敗にする"),
          jsx("button", { id: "handoff-cancel", type: "button" }, "取消する"),
          jsx(
            "button",
            { id: "handoff-abnormal", type: "button" },
            "異常終了を記録",
          ),
          jsx(
            "select",
            { id: "handoff-attempt-cause" },
            jsx("option", { value: "transient_infra" }, "一時的障害"),
            jsx("option", { value: "worker_error" }, "作業者エラー"),
            jsx("option", { value: "criteria_unmet" }, "条件未達"),
            jsx("option", { value: "environment" }, "環境要因"),
          ),
          jsx(
            "button",
            { id: "handoff-attempt", type: "button" },
            "再試行を記録",
          ),
          jsx(
            "button",
            { id: "handoff-reaffirm", type: "button" },
            "再確認する",
          ),
          jsx("button", { id: "handoff-spec", type: "button" }, "仕様を取得"),
          jsx("div", { id: "handoff-spec-view" }),
        ),
        // The frozen-request retry + op status belong to the section, NOT
        // the detail drawer: the drawer stays hidden until a handoff is
        // selected, so a retry nested inside it could never be pressed
        // after an uncertain POST with no selection (same pattern as the
        // learning retry above).
        jsx(
          "button",
          { id: "handoff-retry", type: "button", hidden: true },
          "同じ内容で再送",
        ),
        jsx("p", { id: "handoff-status", "aria-live": "polite" }),
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

/**
 * Slice (b) minimal login form for unauthenticated browsers in remote
 * mode. Deliberately asset-free: no script (inline or bundled), no
 * stylesheet, no external origins — a plain HTML form POSTing
 * `application/x-www-form-urlencoded` to `/api/remote/login`, which the
 * server accepts alongside JSON. Served only when the session cookie is
 * absent/invalid; authenticated browsers get the normal shell.
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

/** The shell carries no user/external strings; this guards regressions. */
export function shellHasNoInlineScript(html: string): boolean {  const lower = html.toLowerCase();
  if (lower.includes("<script") && !lower.includes('src="/assets/client.js"')) {
    return false;
  }
  // Inline event handlers are attributes like ` onclick=` / ` onerror=`;
  // require the leading attribute boundary so `content=` never matches.
  return !/\son\w+\s*=/u.test(lower);
}

export { escapeHtml };
