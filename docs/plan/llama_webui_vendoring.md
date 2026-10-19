# llama.cpp WebUI ベンダリング計画 (調査 + 導入方針)

- 調査日: 2026-10-19
- 上流: https://github.com/ggml-org/llama.cpp
- ピン留めコミット: `098ce526b546b5a190327c1da82929cee051b9ac` (master HEAD, shallow clone 時点)
- 実際の WebUI ディレクトリ: **`tools/ui`** (`tools/server/webui` は存在しない)
- ライセンス: **MIT** (Copyright (c) 2023-2026 The ggml authors)
- 本書は計画のみ。アプリコードの変更は含まない。

## 1. 上流の構成概要

- `tools/ui`: Svelte 5.56.1 + SvelteKit 2.70.2 + Vite 7.3.6、adapter-static (single bundle, hash router)。
- `package.json` に `dependencies` は無く **全て devDependencies** (静的配信のため)。
- 主要バージョン (全て pin 済み):
  - svelte 5.56.1 / @sveltejs/kit 2.70.2 / vite 7.3.6 / typescript 5.9.3
  - tailwindcss 4.3.0 + @tailwindcss/vite 4.1.11 + @tailwindcss/forms 0.5.10 + @tailwindcss/typography 0.16 + tailwind-merge 3.6.0 + tailwind-variants 3.3.1 + tw-animate-css 1.4.0
  - bits-ui 2.18.1 (shadcn-svelte 基盤, `components.json`: baseColor neutral)
  - @lucide/svelte 1.46.0 (tree-shake 前提)
  - markdown: remark 15.0.1 + remark-gfm 4.0.1 + remark-math 6.0.0 + remark-breaks 4.0.0 + remark-rehype 11.1.2 + rehype-highlight 7.0.2 + rehype-katex 7.0.1 + rehype-stringify 10.0.1 + unified 11.0.5 + unist-util-visit 5.1.0 + mdast 3.0.0 + lowlight 3.3.0 (経由) + highlight.js 11.11.1
  - 数式: katex 0.16.47 (rehype-katex の transitive。フォントは vite alias `katex-fonts` で自前ホスト、CSS は `@use 'katex/src/styles/katex.scss'`)
  - サニタイズ: dompurify 3.4.13
  - 図: mermaid 11.15.0 (unpacked 122MB。min でも 1MB 級)
  - テーマ: mode-watcher 1.1.0 (`.dark` クラス切替)
  - 永続化: dexie 4.4.3 (IndexedDB。対象外)
  - 実行系 (全て対象外): sandbox-harness/worker (独自 CSP の opaque-origin iframe)、pdfjs-dist 5.4.54 (Blob URL worker)、nerdamer-prime ベンダ + vite plugin (virtual:nerdamer)、@modelcontextprotocol/sdk 1.30.0
- `src/lib/components/ui/`: shadcn 系 (alert-dialog, badge, button, card, checkbox, collapsible, dialog, drawer, tooltip 等)。全て tailwind v4 + bits-ui 前提。
- テーマトークン: `src/app.css` の `:root` / `.dark` CSS 変数 (oklch) + `@theme inline` で tailwind トークンへ束縛。`--radius`、`--code-background/foreground`、`--chat-form-*` 等を含む。

## 2. markdown / コード / 数式の描画方式

- `MarkdownContent` (`app/content/MarkdownContent/`) が remark→rehype パイプライン (`markdown-processor.ts`) を **プロセス毎共有キャッシュ** で使い回す (添付あり時のみ別キャッシュ)。
- 既定 `allowHtml=false`: 生 HTML は `remarkLiteralHtml` でリテラル表示 (エスケープ)。`allowHtml=true` (モデルカード用) のみ DOMPurify 通過。
- ハイライト: rehype-highlight + lowlight **全言語** (`lowlightAll`)。全言語束は肥大の主因のため、移植時は subset 化が必須。
- コードブロック: `enhance-code-blocks` が言語ラベル + コピーボタン + **HTML プレビューボタン** を付与 (DialogCodePreview で実行)。プレビューは取り込まない。
- テーブル: `enhance-tables` が横スクロールラッパを付与 (360px 対策として有益) + `table-html-restorer` がセル内 `<br>`/`<ul>` のみ復元。
- リンク: `enhance-links` が全 `<a>` に `target="_blank" rel="noopener noreferrer"` を付与。そのまま流用する。
- テスト資産: `tests/client/markdown-content-sanitize.svelte.test.ts`、`tests/unit/sanitize-headers.test.ts`、`cap-img-size` 系。移植時に同等テストを自前で用意する。

## 3. CSP 関連の所見と緩和策

- 上流アプリ自体に CSP ヘッダ設定は無い (svelte.config / vite.config / static に CSP 記述なし)。唯一 `sandbox-harness.ts` がサンドボックス iframe 内独自 CSP (`default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'`) を持つが、実行系ごと対象外。
- `eval` / `new Function` / `new Worker` は `src` に無し (`import.meta.env` のみ)。`?raw` + `URL.createObjectURL(blob)` は pdfjs 用のみで対象外。
- 外部フォント/CDN は無し: KaTeX フォントは自前 alias、アイコンは lucide (バンドル)、`app.html` に外部参照なし。自アプリの「self-hosted, no CDN」方針と整合する。
- インラインスタイル: (a) KaTeX 出力が inline style 前提 (数式を使わないため影響なし)、(b) Svelte の動的 style と `autoResizeTextarea` の `el.style.height`。将来 CSP を導入する場合は `style-src 'unsafe-inline'` が必要になる見込み。V1 では CSP 導入を見送り、導入時に再評価する。
- DOMPurify 設定 (`safe-html-config.ts`) は明示 allowlist + `position: fixed/absolute` 除去フック付き。そのまま移植する (4. 安全ルール参照)。

## 4. 候補コンポーネント選定表

凡例: take=ほぼそのまま / adapt=依存を剥がして移植 / skip=不採用。工数は S(<0.5d) / M(1-2d) / L(3d+)。

| 候補 (tools/ui 内パス) | 判定 | 理由 | 内部依存と置換 | 工数 |
|---|---|---|---|---|
| `src/app.css` テーマ変数 (`:root`/`.dark`, oklch) | adapt | dark-only の自前 CSS に subset 移植。tailwind v4 本体は入れない | `@theme inline`→手書き var 参照に読替 | S |
| `MarkdownContent` 一式 (processor/utils/安全系 plugin) | adapt | 検証済み回答の描画核。mermaid/svg/添付解決 plugin を除外 | settingsStore→props、mode-watcher→dark 固定、lowlight 全言語→subset | M |
| `SyntaxHighlightedCode.svelte` | adapt | コード copy の再利用。ストリーミング自動スクロール付き | mode-watcher→dark 固定、hljs css `?inline` 流用 | S |
| `CollapsibleContentBlock.svelte` | adapt | reasoning/詳細折畳み。bits-ui は使わず自前化 | bits-ui collapsible→自前 (or `<details>`)、lucide chevron | S |
| `ChatMessageReasoningBlock.svelte` | adapt (V3) | 生成過程表示の将来用。現行 run イベントに推論は無いため V3 | AgenticSection 型→自前 run view 型、settingsStore 除去 | M |
| `ChatMessageStatistics/` + `formatters.ts formatPerformanceTime` | take (V3) | props 駆動で結合が薄い。生成/読取トークン・ms 表示に転用 | Tooltip→`title` 属性等に簡略化可 | S |
| `ChatFormInputBasic.svelte` + `utils/autoresize-textarea.ts` | take (V4) | autosize の実績パターン。Enter 送信は自前 keydown で実装 | deviceStore 依存のみ除去 (約10行の util はそのまま) | S |
| `ChatFormActionSubmit.svelte` | adapt (V4) | 送信/停止ボタンの見た目のみ参考 | bits-ui Button/Tooltip→自前 button、lucide ArrowUp | S |
| copy 系 util (`copyToClipboard`, `copyCodeToClipboard`) | take | 依存なしに近い | そのまま | S |
| `ChatMessages.svelte` / `ChatMessage*` / `LazyChatMessage` | skip | chatStore/conversationsStore/agenticStore/dexie (`DatabaseMessage`) に強結合。自前リスト継続、バブル CSS のみ参考 | — | — |
| `ChatMessageAssistant` 本体 | skip (Statistics のみ take) | chat/models/server/settings の 4 store + 加工 hooks に結合 | — | — |
| `ChatFormInputRich` / mention・slash・MCP picker 群 | skip | MCP/slash/リッチ装飾は自アプリの対象外 (下書きは plain text 維持) | — | — |
| mermaid 系 (plugin + `MermaidPreview`) | skip | 実行系・重量級。コードブロックとして静止表示に格下げ | — | — |
| svg 系 (plugin + shadow-DOM util) | skip | XSS 面・工数。静止コード表示に格下げ | — | — |
| 数式系 (remark-math/rehype-katex/katex scss) | skip (V2 では `disableMath=true`) | 暦回答に数式需要なし。将来 V5 候補 | — | — |
| `resolve-attachment-images` / `file-badge` / pdfjs / nerdamer / sandbox | skip | 添付・PDF・計算・コード実行は自アプリの対象外 | — | — |
| `components/ui` (shadcn 一式) | skip | tailwind v4 + bits-ui + tailwind-variants 前提。自前 CSS 継続 | — | — |
| mode-watcher / dexie stores・services | skip | dark-only・サーバ権威の自前状態と競合 | — | — |

自データモデルへの適合点: 回答描画は `RunViewState.answer: AnswerPartView[]` (`text` + `citations`) を入力とし、llama 側の `DatabaseMessage/extra` には結合させない。引用は既存の rN/mN ドロワ (`openCitation`) を継続し、markdown 内リンク化はしない (安全ルール参照)。

## 5. 追加依存 (バージョン固定)

V2 で `apps/web/package.json` に追加 (pnpm)。katex/mermaid/highlight.js 本体/pdfjs/dexie/bits-ui/mode-watcher/tailwind は入れない。

- `dompurify` 3.4.13 (最終 HTML のサニタイズ)
- `remark` 15.0.1 / `remark-gfm` 4.0.1 / `remark-breaks` 4.0.0 / `remark-rehype` 11.1.2 / `rehype-stringify` 10.0.1 / `rehype-highlight` 7.0.2 (上流と同一)
- `lowlight` 3.3.0 (subset 言語のみ登録。`lowlightAll` 禁止をレビュー観点化)
- `unified` 11.0.5 / `unist-util-visit` 5.1.0 / `mdast` 3.0.0 (plugin 直 import のため直接依存化)
- `@lucide/svelte` 1.46.0 (copy/chevron/arrow + stats アイコン約7種。tree-shaking 前提)
- 型: `hast` 型は rehype 経由。`mdast` は上流同様 dev に置く。
- ライセンス履行: `apps/web/src/vendor/llama-webui/` に `LICENSE` (MIT 全文) + `NOTICE` (上流パス・コミット・改変点) を同梱。対象ファイル毎に由来コメント。

## 6. バンドル予算提案

- 現行: **27KB (gz)** を floor とする (V1 で `vite build` 実測を取り直す)。
- 今回は上流のフルビルドは未実施 (storybook/playwright 同梱で 5 分枠超過のため)。`npm view dist.unpackedSize` + 既知の min 実績からの見積り:
  - remark 系 + unified 一式: min 約 60KB → gz 約 20KB
  - rehype-highlight + lowlight (subset 約10言語): min 約 100-150KB → gz 約 30-40KB
  - dompurify: gz 約 20KB
  - lucide 約7アイコン: gz 約 4KB
  - トークン CSS・自前 collapsible 等: gz 約 3KB
  - **増加見込み: gz 約 75-90KB** (katex を無効化した場合。数式を有効化すると +70KB gz 以上 + フォント)
- 提案: **予算 gz ≤120KB (上限・CI guard)**、目標 80KB。`docs/plan/frontend_ui_requirements.md` Q9 の gzip 目安 ≤120KB と整合。
- V1 で `vite build` + gzip 計測の guard (budget 超過で CI 失敗) を入れる。`lowlightAll`/`mermaid`/`katex` の混入は guard + レビューで検出する。

## 7. 安全ルール (移植の前提条件)

1. markdown 描画は **検証済み回答のみ** (`run.completed` の answer parts)。下書き (`input`)、承認カード (C22)、引用ドロワ、notice は plain text (`textContent`) のまま。`{@html}` の使用箇所は MarkdownContent 経由に限定する。
2. サニタイザは DOMPurify 3.4.13 + 上流 `SAFE_HTML_CONFIG` allowlist 移植 + `position: fixed/absolute` 除去フック。`allowHtml=false` (生 HTML はリテラル表示) を既定とし `true` は never (モデルカード用途は自アプリに無い)。
3. リンクは `enhance-links` そのまま (`target="_blank" rel="noopener noreferrer"`)。
4. **リモート画像は取り込まない**: `http(s)` の `img src` は除去 (自アプリに添付解決の需要は無く、`resolve-attachment-images` は移植しない)。引用は rN/mN ドロワ経由の既存動線のみ。
5. コードブロックの **HTML プレビュー実行ボタンは移植しない** (DialogCodePreview 相当の実行系を持ち込まない)。mermaid/svg ブロックも実行せず静止コード表示。
6. 数式は V2 で無効 (`disableMath=true`)。有効化は別提案 (katex + fonts の追加と CSP 再評価が条件)。

## 8. PR 分割

- **V1 テーマ + Tailwind トークン**: oklch subset の手書き CSS 化、LICENSE/NOTICE 配置、bundle guard (120KB) 導入。受入: 見た目差分なし + 既存 e2e green。
- **V2 メッセージリスト + markdown**: MarkdownContent core 移植 (tables/code-copy/links)、回答 parts 描画の切替、sanitize テスト追加。受入: 既存 e2e (calendar 含む) green + mobile 目視。
- **V3 reasoning ブロック + stats**: Collapsible + ReasoningBlock (将来用に非表示既定も可) + Statistics 表示。受入: 同上。
- **V4 コンポーザ**: autosize + Enter 送信/Shift+Enter 改行 + 送信/停止ボタン刷新。受入: 同上 + 44px タッチ・iOS ズームの mobile checks。
- 各 PR は docs-only 本書の方針を継承し、force-push 禁止。

## 9. 受入条件

- 既存 e2e green 維持 (calendar 系 37 件を含む全件) + mobile checks (360px スクロールなし・composer 操作性・44px ターゲット・16px 入力・200% ズーム)。
- bundle guard (gz ≤120KB) green。各 V で `vite build` 実測値を本書に追記する。
- 新規テスト: sanitize allowlist、テーブル横スクロール、コード copy、lowlight subset 外言語のフォールバック。
