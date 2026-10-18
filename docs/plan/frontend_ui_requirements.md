# フロントエンド UI 要件定義案（PROPOSAL）

- 状態: **要件定義案（PROPOSAL・haruka 確認待ち、実装なし）**
- 日付: 2026-10-18
- 方式: 台帳追記式（ledger style）。既存合意・現況は書き換えず、本書のみで提案する。
- 数値・ライブラリ選定の確定はしない: bundle budget・browser matrix・framework・streaming 可否・デザイン方向はいずれも**未決**として haruka 確認に委ねる。本書の数値は実測の記録のみ。

## 1. 目的・範囲

- 目的: 会話・記憶・カレンダー・承認・通知・停止・ログイン等の現行 UI を、**1 回の consolidated frontend update** として整理・改善するための要件を定義する。個別の場当たり修正を重ねず、e2e green を保ちながら段階移行する。
- 範囲: Linux サーバー（loopback bind 維持）＋ Tailscale 経由の Windows / スマホブラウザ。サーバー自体は TLS を持たず、tailnet HTTPS を終端して `127.0.0.1:<port>` へ proxy する構成（`docs/operations.md:47-55`）。
- 対象外: モデル高速化（latency 改善）は本更新の scope 外。2026-10-18 haruka 決定により「latency 改善は今は不要、progress/streaming は consolidated frontend update に延期」として本書に集約する（`docs/plan/active_projects_tasks.md` 現況追記参照）。
- 本書は実装・gate 閉鎖・合意昇格を行わない。

## 2. 現況（調査結果）

### 2.1 アーキテクチャ

- SSR shell は Hono JSX、対話 UI は vanilla TypeScript（DOM API のみ、framework なし）を esbuild で bundle し静的配信。inline script/style・外部 origin 禁止（`apps/server/src/ui/page.ts:1-6`）。
- Strict CSP は self のみ（`apps/server/src/ui/page.ts:17-25`）。shell に user/external 文字列なし、inline handler 検出 guard あり（`apps/server/src/ui/page.ts:890-899`）。
- ビルドは `apps/server/scripts/build-ui.mjs:1-35`（entry `src/ui/client.ts`、iife・browser・es2022・minify、css copy）。実測 bundle は `dist/assets/client.js 201.0kb`（2026-10-18 worktree 実測。履歴 18.2kb は `docs/plan/provisioned_browser_baseline_2026-10-10.md:29` および `companion_execution_2026-10-10.md:43` の当時値で、成長は panels 追加による）。
- Source 規模実測: `client.ts 6152行`、`page.ts 901行`、`client.css 133行`、`reducer.ts 695行`、ui 合計約 500KB。panel 分割済み: `notification_panel.ts / learning_panel.ts / shadow_panel.ts / handoff_panel.ts / proposal_panel.ts / autonomy_state.ts / escape.ts`（`apps/server/src/ui/` 一覧）。
- ブラウザ永続化は最小限（sessionId・per-run Run cursor・pending Idempotency-Key のみ、本文/snapshot 非保存）（`apps/server/src/ui/client.ts:1-9`、`docs/implementation_plan.md:1193`）。承認 key も proposal 単位の Idempotency-Key のみ保持（`apps/server/src/ui/client.ts:52-60`）。

### 2.2 現行画面・機能（SSR id ベース）

- 会話 transcript: `main#conversation`（`page.ts:51-54`）、composer `#composer/#composer-input/#composer-send(disabled 初期)/#composer-stop(hidden)`＋ notice `#composer-notice`（`page.ts:812-831`）。
- セッション・履歴: 自動初期化・履歴 cursor pagination（`implementation_plan.md:1192,1226`）。C06 active-run reload 対応済み（現況は tasks 参照）。
- 引用 drawer: `#drawer[role=dialog]`＋`#drawer-body`（`page.ts:807-811`）。rN（stored）＋ mN（run-bound recall exposure）の共有 drawer 生成（`client.ts:448,484-486`）。mN は originating run/session に bind（`client.ts:3293,3371,3530,3604`）。snapshot は plain escape 表示（`implementation_plan.md:1217-1219`）。
- 記憶管理: `#memory` 検索 form/list/detail・訂正/引退/再活性キュー・再送・status（`page.ts:56-100`）。I04 revision-pinned（新規引用は最新版、既存 citation は immutable snapshot 固定。F-I04-07 調査で mN 維持・migration なし）（tasks `I04 現況 2026-10-18`）。
- 学習/自律/目的/作業/試行/引継ぎ: `#autonomy`（目的 form/list/detail・作業 form/list/detail・conflict・status/pending・retry、`page.ts:102-442`）、`#shadow`（`page.ts:443-484`）、`#trials`（`page.ts:485-507`）、`#proposals` 会話の候補（`page.ts:538-581`）、`#learning`（`page.ts:582-681`）、`#handoff`（`page.ts:682-806`）。
- カレンダー結果: 会話内の action 系 summary として表示（`client.ts:335,339,1629,1645,2364-2371,2418`）。`calendar.create/reschedule` prefix の可視漏洩防止あり。
- 承認カード C22: 動的 card（model `actionCardModel`）。pending かつ valid unexpired 時のみ表示、hash/expiry で無効化、明示 button のみ、Stop は pre-marker のみ、receipt 4 状態＋手動確認（reducer `apps/server/src/ui/reducer.ts:357-391`、progress 文言 `:300-306`、receipt 文言 `:313-328`）。
- 通知 AV-05: `#notifications`（badge・urgent/assertive・routine/polite・list・older・detail・ack・retry・status）（`page.ts:508-536`）。会話保全・定常は自然区切りで簡潔・重大のみ即時（tasks `AV-05:649`、decision_inputs `AV-05:511`）。
- 停止/取消: contextual stop（active Run 時のみ）、Action Run は marker commit 前のみ Stop（`implementation_plan.md:1225`、reducer `:286-287,380-382`）。
- conflict notice: `#autonomy-conflicts`＋記録 button（`page.ts:268-273`）。citation 競合 `参照の更新で競合しました…` 表示→再読/retry は 10/14 限定 8/8 記録（tasks C07 現況）。
- JSON fallback polling: SSE 不成立時の bounded 逐次 poll、terminal/dispose まで継続、連続上限で固定表示停止、破損 cursor は再接続停止→履歴再同期（`implementation_plan.md:1230-1231`）。C04 要件（tasks `326-336`）。
- ログイン: remote slice (b) script-free login form（`page.ts:837-847` コメント、`renderRemoteLogin:848-888`、POST `/api/remote/login`）。session cookie は opaque 256bit・HttpOnly/Secure/SameSite=Strict、scrypt hash は SQLite 外・0600、tunables 案あり（`operations.md:79-94`）。

### 2.3 モバイル CSS（#69）

- Remote slice (c) minimum smartphone layout: 360px で水平 scroll なし・readable transcript・usable composer・primary 44px touch・200% zoom で clip なし（`client.css:51-55`）。
- 16px+ inputs（iOS auto-zoom 抑制）・border-box（`client.css:59-66`）。button/submit 44px（`client.css:68-73`）。login form 縦積み（`client.css:87-105`）。360–480px media query（`client.css:107-133`）。

### 2.4 a11y（C22-07 由来）

- `aria-live=polite`（conversation・memory/task/shadow/proposal/learning/handoff status 等）、通知 urgent のみ `assertive`（`page.ts:52,99,268,435-436,467,489,505,512-514,535,542-543,555,580,680,737,805`）。`role=dialog`＋`aria-label=引用`（`page.ts:809`）。keyboard/focus/label/status announcement は C22-07 受入として維持（tasks `550-561:558`）。

### 2.5 e2e（現行 11 spec）

- `apps/server/e2e/`: `conversation.spec.ts`・`sse_history.spec.ts`・`polling.spec.ts`・`citation_recovery.spec.ts`・`conversation_proposals.spec.ts`・`learning.spec.ts`・`shadow.spec.ts`・`autonomy.spec.ts`・`handoff.spec.ts`・`notifications.spec.ts`・`mobile_layout.spec.ts`（各 UI 域を cover）。C04/C05/C06/C07 の browser matrix は tasks `C04:326-336 / C05:338-348 / C06:350-360 / C07:362-372` 参照。現行 e2e 保証を弱めないことが制約。

### 2.6 既存 UI 要件の正本

- `docs/implementation_plan.md` §16（M3 UI 合意: §16.1 1171-1175 / §16.2 1177-1194 / §16.3 1196-1200 / §16.4 1202-1212 / §16.5 1214-1219 / §16.6 1222-1226 / §16.7 1228-1239 / §16.8 非目標 1241-1249）および §18（承認フロー: 18.1 scope 1349-1371 / 18.4 variants・approve exact 1503 / 18.5 marker・18.6 Stop 境界 / 18.7 receipt / 18.10 test 1560-1566 / 18.11 非目標）。
- `docs/plan/active_projects_tasks.md` C04–C07・C22（550-561）・AV-05（649）・AV 全体（645-654）。
- `docs/plan/decision_inputs_2026-10-18.md` AV 判定（AV-05:511 ほか 484-520）。
- `docs/plan/linux_remote_access_design.md` §6（スマホ UI 最低限、land-remote-design PR で master に着地）を正とし、`docs/operations.md:47-96`（remote allowlist/login/session）＋ `client.css:51-55,87-105`（slice b/c）とあわせて参照する。

### 2.7 進捗表示の現状

- Run phases の人間可読写像は固定: `run.queued/started→「生成中」`、tool 系は可視変化なし（`reducer.ts:148-164`、可視 message 定義 `:29,51`）。
- Action 実行中は `ACTION_PROGRESS_TEXT`（queued/preflight/executing の 3 文言）（`reducer.ts:300-306`）＋ `client.ts:252,1831` で card progress に反映。
- トークン単位 streaming は v0.1 非目標（`implementation_plan.md:1243`）。回答は `run.completed` の StructuredAnswer 単位。

## 3. 利用者・利用場面

- PC browser（Linux 直・Windows  remotely）: 長文 transcript・引用 drawer・記憶管理・承認カードの確認。
- Smartphone（Tailscale 経由）: 360px 幅・200% zoom でも送信/停止・通知 ack・承認可否が操作可能。
- Remote（外出先）: login → session cookie → 通常 shell。session expiry・lockout・401 時の UX を本書で定義する。

## 4. 機能要件

### F-01 会話・進捗表示

- F-01-1（維持）: 既存写像（生成中/回答/失敗+retry/停止しました）を維持する。`cancel_requested` は非 terminal として active 維持・SSE 購読継続（`implementation_plan.md:1190`）。
- F-01-2（改善・確定）: run phases の progress 表示を既存 events のみで段階化する。例: `考え中（run queued/started）／ツール実行中 n/m（tool.requested/completed の count のみ、tool 名・引数は出さない）／回答作成中（terminal 直前）`。技術概念（Run/Tool/seq）の露出はしない（§16.2 準拠）。文言は本書で確定しない（haruka 確認）。
- F-01-3（選択肢・未決）: optional incremental answer 表示。**要 `model stream:true`＋新規 delta events＋`structured answer.submit` redesign** のため、本更新では**選択肢**扱いとする。採用可否・delta 契約・順序保証・citation 途中表示可否は未決（未決 Q2）。

### F-02 履歴・セッション

- 自動初期化・cursor pagination・active-run reload 回復（C06）を維持。reload 後の composer 占有・submit 無効・Json fallback 継続を壊さない。

### F-03 引用・記憶表示（mN/rN）

- rN＝stored snapshot、mN＝run-bound recall exposure の区別表示を維持（`client.ts:484-486`）。
- kind framing: `user_fact` vs `inference`（model_inference は事実として扱わない、F-I01-04）を表示上で混同させない。
- revision pinned: 引用は使用時点の版に固定、新規引用は最新版（I04 現況）。correction 後も既存 citation は immutable のまま。

### F-04 記憶管理

- search（retired 含む・no-heat）・current-vs-snapshot confirm・correct/retire/reactivate queue・explicit retry・status announcement を維持。削除/非表示と retire の混同をさせない。

### F-05 カレンダー

- 結果表示は既存 summary 整形・prefix 漏洩防止を維持。tombstone（deleted）は search omission で作らない（§17.5）。unavailable/upstream error 時は固定 safe error＋通常応答縮退（F-11 に統合）。

### F-06 承認（C22 safety・verbatim 維持）

以下は本更新で**一切緩和しない**:

- C22-01: pending かつ valid unexpired Proposal がある時だけ card 表示。
- C22-02: proposal hash/body 変更・expiry 後に approve button 無効化。
- C22-03: approve/reject は**明示 button のみ**。自然言語会話を approval にしない。
- C22-04: source/target・予定 action・expiry・hash を確認可能に表示。
- C22-05: Stop は **pre-marker cancel と post-marker unknown を正確に区別**。
- C22-06: receipt は verified/unverified/failed/unknown の状態＋手動確認 notice。
- C22-07: keyboard/focus/label/status announcement の a11y basics を継承。
- C22-08/09/10: fake matrix・三重 gate（opt-in＋writeEnabled＋dedicated binding）・readonly fork は write binding でない旨を維持。

### F-07 通知（AV-05）

- 会話保全・強制 task 化/中断なし。定常は log＋自然区切りで簡潔・質問 group（deadline 除く）。重大 danger/commitment は即時、無変化は通知なし、沈黙は同意/拒否でない、hold は非認可動作のみ止める（tasks:649  verbatim）。

### F-08 停止

- 通常 Run の contextual stop を維持。Action Run の Stop 可用性は marker commit 境界に従う（§18.6）。停止後の receipt 語彙と混同させない（reducer receipt 文言参照）。

### F-09 ログイン/ログアウト・session expiry UX

- script-free login form 維持（`page.ts:848-888`）。401（session なし/期限切れ）時は JSON 401＋login 導線を明確化し、入力途中テキストの扱い（保持/再送不可の明示）を定義する。lockout（5 failures/15min 案）・absolute/idle timeout（30d/7d 案）の表示文言は未決だが、値は本書で確定しない（operations 案のまま）。

### F-10 エラー・縮退表示

- memory disabled/degraded: エラーで止めず「記憶なしで続行」が分かる応答（F-I01-06 決定）。
- vector state: index missing 時は語彙＋graph へ縮退継続（R12 方針）。
- calendar unavailable: 固定 `calendar_upstream_error/unknown`、snapshot 誤消去なし。
- いずれも技術 ID・本文漏洩なし、textContent のみ。

## 5. 非機能要件

- NF-01 Responsiveness: 360px で水平 scroll なし・composer 操作可・44px touch（現行 CSS を floor とする）。
- NF-02 a11y: C22-07 basics を継承（keyboard 到達・focus 可視・label・live region）。新規 component も同等とする。
- NF-03 Offline-asset/no CDN: self-hosted bundle＋css のみ。外部 fetch・font・CDN を追加しない。
- NF-04 CSP self: `default/script/style/connect self` 等を維持（`page.ts:17-25`）。inline script/handler 追加禁止。
- NF-05 Bundle size budget: **未決**。現行 201.0kb 実測のみ記録し、budget 値は haruka 確認（未決 Q9）。
- NF-06 Browser support matrix: **未決**（未決 Q9）。現行は Chromium e2e＋Tailscale 先ブラウザ想定。
- NF-07 Latency perception: モデル高速化は scope 外（2026-10-18 haruka 決定）。体感改善は F-01-2 の progress 表示に限定する。

## 6. 制約

- 新規外部 network 依存を追加しない（M4/M5 の allowlist・default-deny を侵さない）。
- Security boundaries: loopback bind・Host/Origin 検証・`Origin:null` 拒否・CORS 無効・session 必須（`operations.md:66-96`）を維持。password hash の env/argv 経由なし。
- 既存 e2e 保証を弱めない: 11 spec＋C04–C08 matrix の coverage を維持し、更新は green のまま段階化する。
- localStorage 拡張なし（sessionId/cursor/pending key のみ）。本文/snapshot の保存追加は合意なしに行わない。

## 7. 技術選択肢（未決）

- A: vanilla TS 維持（現行）。pros: CSP・bundle・e2e との整合、学習 cost なし。cons: 大規模化時の見通し・panel 間の重複。
- B: 軽量 framework 採用（例: Preact/Solid/Svelte 等の候補列挙に留める。具体名の推奨はしない）。pros: component 化・a11y 支援。cons: bundle/CSP/build 変更・e2e 作り直し・学習 cost。
- C: SSR 拡充＋client 最小化。pros: CSP 親和・JS 縮小。cons: interactivity 低下・SSE/drawer の作り直し。
- いずれも**未決**（未決 Q1）。本書では選定しない。

## 8. 移行方針

- Incremental に panel 単位で移行し、各 step で `lint/typecheck/e2e` green を確認する。
- C22 承認・通知・引用の safety 系を最初に固め、見た目変更は最後にする。
- 失敗時は直前 step に戻す（DB migration を伴う UI 変更はしない）。

## 9. 受入基準（draft・PROPOSAL）

- R-01: 11 e2e spec が green（削減なし）。C22 matrix（expiry/hash/duplicate/reject/cancel/unknown）が fake で pass。
- R-02: 360px・200% zoom で水平 scroll なし・送信/停止/承認/ack が操作可（mobile_layout 拡張）。
- R-03: CSP self・inline なし・外部 origin なし（shell guard pass）。
- R-04: a11y basics（keyboard のみで承認/ack 到達、live announcement 目視）が checklist で pass。
- R-05: 縮退表示（memory disabled・calendar unavailable）が固定文言で確認できる。
- R-06: session expiry・401 時の導線が手動 smoke で確認できる。
- 具体閾値・browser matrix・bundle budget は未決として受入から除外する。

## 10. 未決事項（haruka 確認用）

- Q1: framework 選択 — vanilla 維持か、軽量 framework 採用か（採用なら候補と選定軸）。
- Q2: streaming 可否 — incremental answer 表示をやるか（やるなら delta 契約・citation 扱い・answer.submit redesign の範囲）。
- Q3: デザイン方向/ビジュアルスタイル — 現行素朴スタイル維持か、刷新か（色・余白・タイポグラフィの方向性）。
- Q4: dark mode — 対応するか（`color-scheme: light` 固定の現状を変更するか）。
- Q5: PWA / home-screen install — 対応するか（manifest・service worker は scope 外とするか）。
- Q6: 通知 push — WebPush 等の push 通知をやるか（やるなら AV-05 との整合・権限・opt-in 条件）。
- Q7: i18n — 日英切替等を行うか（現行 ja 固定を変えるか）。
- Q8: 機能の優先順位 — 会話 progress／引用・記憶／承認／通知／カレンダー／記憶管理の実装順。
- Q9: bundle budget・browser support matrix — 数値・マトリクスをいくつに置くか（本書では未決）。
- Q10: ログイン UX 詳細 — session expiry・lockout・入力保持の文言と挙動（operations 案でよいか）。
- Q11: 進捗文言 — F-01-2 の「考え中／ツール実行中 n/m／回答作成中」案でよいか。

## 参照

- `apps/server/src/ui/page.ts:1-6,17-25,56-100,102-442,443-484,485-507,508-536,538-581,582-681,682-806,807-831,837-888,890-899`
- `apps/server/src/ui/client.ts:1-9,52-60,252,335,448,484-486,1629,1831,3293,3371,3530,3604`
- `apps/server/src/ui/reducer.ts:29,51,148-164,285-306,313-328,357-391`
- `apps/server/src/ui/client.css:1-6,51-73,87-105,107-133`
- `apps/server/scripts/build-ui.mjs:1-35`
- `apps/server/e2e/` 11 spec（autonomy/citation_recovery/conversation/conversation_proposals/handoff/learning/mobile_layout/notifications/polling/shadow/sse_history）
- `docs/implementation_plan.md:1171-1249`（§16）、`§18`（承認フロー）
- `docs/plan/active_projects_tasks.md:326-372`（C04–C07）、`550-561`（C22）、`649`（AV-05）、`645-654`（AV 全体）
- `docs/operations.md:47-96`（remote）
- `docs/plan/decision_inputs_2026-10-18.md:484-520`（AV 判定）

## 11. 決定（2026-10-18 haruka）

- 本節は §10 の未決 Q1–Q11 に対する haruka 決定の記録。既存節（§1–§10）は書き換えない。

### 11.0 調査根拠（決定の前提事実・出典付き）

- llama.cpp 上流 web UI の場所は `tools/server/webui` ではなく現行 `tools/ui`（`gh api .../contents/tools --jq '.[].name'` で `ui` を確認）。`<https://github.com/ggml-org/llama.cpp/tree/master/tools/ui>`。
- framework: **Svelte 5**（`svelte 5.56.1`）＋ **SvelteKit 2.70.2** ＋ **Vite 7.3.6** ＋ **Tailwind CSS 4.3.0**。component 基盤は **bits-ui 2.18.1**＋`src/lib/components/ui/` の shadcn 系 primitives（collapsible/dialog/drawer/select/skeleton/tooltip 等）＋ `@lucide/svelte` icons＋`mdsvex`（出典: `tools/ui/package.json` 全文、`tools/ui/svelte.config.js`）。
- build 出力: `@sveltejs/adapter-static`＋`output.bundleStrategy: 'single'`＋hash router で単一 static bundle を生成し、`scripts/ui-assets.cmake`→`ui.cpp.in`/`ui.h.in` 経由で llama-server バイナリに埋め込み配信（当方の「同一 server routes 背後・no CDN・CSP self」制約と同形。出典: `tools/ui/svelte.config.js`、`tools/ui/ui.cpp.in` 先頭 10 行、`tools/ui/README.md` “Build Pipeline”）。
- repo LICENSE: **MIT**（`gh api repos/ggml-org/llama.cpp --jq .license.spdx_id` → `MIT`）。再利用は表示義務付きで許可されるが、fork より pattern 流用が適する（§12 根拠）。
- thinking 表示: `ChatMessageReasoningBlock.svelte`（`components/app/chat/ChatMessages/` 下）は Collapsible＋MarkdownContent 構成。header は streaming 中 `Reasoning...`／完了後 `Reasoning`、subtitle に Error/Cancelled、user scroll-up 時は自動追従停止（出典: 同ファイル先頭 80 行、`AgenticSectionType.REASONING_PENDING`）。
- streaming: `services/chat.service.ts` が `/chat/completions`＋`/stream` を wrap し SSE parse。request は `stream: true`（約 395 行）、chunk 毎に `choice.delta.reasoning_content` を累積→`onReasoningChunk`、`timings`→`onTimings`、tool-call delta は `mergeToolCallDeltas` で統合（出典: 同ファイル `grep stream/reasoning_content/timings`）。
- stats 表示: `ChatMessageStatistics.svelte`（predicted tokens/ms・prompt tokens/ms、live generation/reading 切替 badges。tokens/s 系表示の器。出典: 同ファイル先頭 60 行）。
- markdown/code: remark 系（`remark-gfm`・`remark-math`）＋rehype 系（`rehype-highlight`＋`highlight.js 11.11.1`、`rehype-katex`）＋`mermaid 11.15`＋`dompurify`＋`safe-html-config.ts`（出典: `tools/ui/package.json` devDeps、`components/app/content/` 一覧: `MarkdownContent.svelte`・`SyntaxHighlightedCode.svelte`・`CollapsibleTerminalBlock.svelte` 等）。
- 当方 llama-server 起動実測（`ps -o args= -C llama-server`）: `/app/llama-server -hf huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF:UD-Q4_K_XL --host 0.0.0.0 --port 8080 -c 16384 --n-gpu-layers 99 -fa on --api-key <redacted> --alias qwen3.8-27b`。**`--reasoning-format`／`--jinja`／`--chat-template` 指定なし**。上流 default は `reasoning-format=auto`（出典: `tools/server/README.md:233`）のため、Qwen3.8-27B の thinking が `message.reasoning_content` に分離されるか・`<think>` のまま content に残るかは template caps 次第で**未検証**（→ 未決 O-1: live probe が必要）。
- gateway: `:4000` で `litellm --config /app/config.yaml --port 4000` が稼働（`ps aux` 実測。config は名称のみ記録し**未読**）。LiteLLM proxy は `stream: true` の SSE を透過する設計だが、当該 config での reasoning 透過は未検証（→ O-2）。
- Companion DB（`~/.local/share/companion-harness/companion.sqlite` を metadata のみ照会・本文なし）: `model_calls` の列は `id/run_id/step/adapter/model/outcome/error_code/duration_ms/usage_json/created_at` のみで **reasoning 系列なし**（`PRAGMA table_info` 実測）。これは設計通り（`schema.ts:509`「reasoning NEVER columns」、`repository.ts:3602` metadata-only 注記）。最新 3 行はいずれも `adapter=openai-compatible/model=qwen-local/outcome=completed`、`usage_json` は `{"inputTokens":N,"outputTokens":N}` のみ（39 bytes）。蓄積 reasoning の発掘は不可・不要（→ thinking 表示の源泉は将来の live stream のみ）。
- Companion model client（`packages/model-local/src/openai_compatible.ts`）: request は `stream: false` 固定（`:330`）。`normalizeOpenAIResponse`（`:106-`）は `message.content`＋`message.tool_calls`＋`finish_reason`＋`usage` のみ読み、`reasoning_content` は**読まない**（`grep reasoning` 0 件）。trial relay（`apps/server/src/trial_model_relay.ts:676-677`）は inbound の `reasoning`／`reasoning_effort` を `unsupported_option` で拒否。すなわち thinking 取得には3層（model client・relay・LiteLLM 経路）の対応が要る（→ §12 PR-2）。
- answer 経路: `answer.submit` 終端 protocol（`contracts/src/structured_answer.ts`: parts 1–20・各 text 1–4000 code points・citations 0–8・全体 16KiB・rN/mN 構造検証／`kernel/src/agent.ts`: 単独 single submit・混在禁止・repair 1 回・`renderAnswerText` 決定性描画）。
- streaming 実現性評価: (i) reasoning/thinking deltas は provider が出せば技術的に流せる（`stream:true`＋SSE delta parse＋contracts への** additive な新規 delta event 型**追加。既存 `model.step.*` は step 単位で粒度不足）。(ii) 回答文の streamed `tool_call` argument deltas（`answer.submit` の `parts[].text` 部分 JSON を provisional 表示）は技術的に可能だが、citation/grant 検証は validated submit 時にしかできないため** provisional は「下書き」明示＋validated 回答で置換**が必須（safety 条件）。(iii) tool-free の素 content streaming＋事後 citation parse は `answer.submit` 終端 protocol（agent.ts 単独 rule）と衝突し protocol redesign が要るため**非推奨**。

### 11.1 各 Q の決定

- Q1 framework: **採用可**。候補は Svelte 5＋Vite 系を第一とする（§12）。
- Q2 chat 行為 ideal: **llama.cpp web UI 並み（streaming 応答・Thinking 開閉・stats 表示）**。license（MIT）が許す範囲で同 UI の再利用も可とするが、当方の structured-citation／C22／CSP 制約から **pattern 流用＋再実装を既定**とする（§12）。
- Q3 デザイン: **シンプル維持**（現行の素朴スタイル方向。余白・可読性中心の整理に留める）。
- Q4 dark mode: **dark mode のみ**（light 切替なし。`color-scheme: dark` 固定）。
- Q5 PWA: **将来展望**。本更新の scope 外（manifest・service worker なし）。将来 issue として追跡する。
- Q6 push 通知: **本更新では見送り**（提案通り）。AV-05 の in-app のみを維持し、WebPush 等は将来項目とする。
- Q7 i18n: **日本語のみ**（ja 固定継続。切替 UI なし）。
- Q8 優先順位: **chat が最優先**。会話以外の機能（記憶管理・自律・学習・shadow・提案・引継ぎ・通知・カレンダー結果表示）は**別 page／別 route**に分離する。
- Q9 bundle budget・browser matrix（推奨値を本書で確定）: budget は**初回 page JS ≤300KB（min、現行 201.0KB 実測を floor とする）・route 毎 total ≤400KB・gzip 目安 ≤120KB**とし、build 時 guard で検査する。新 framework runtime 分の増加余地を含む。browser matrix は** Windows 上の最新 Chrome／Edge＋iOS Safari（最新）／Android Chrome（最新）の evergreen** とする。e2e は Chromium 継続＋Safari iOS／Android Chrome は Tailscale 経由の手動 smoke とする。
- Q10 ログイン UX（推奨値を本書で確定）: **401（session なし／期限切れ）時は入力途中テキストを保持**し、inline で再ログイン導線を示し、再ログイン後は**同一 session に復帰**する。再送不可の場合のみその旨を明示する。lockout・timeout 値自体は operations 案のままとする。
- Q11 thinking 表示（調査 §11.0 に基づく推奨）: **llama.cpp 式の collapsible “考え中（Thinking）” block**（`reasoning_content` が来た場合のみ streaming 表示、完了後は collapsed）＋**phase/tool 状態行**（例 `カレンダーを検索中…`。tool 名・引数は出さず count／種別のみ。F-01-2 の段階化を内包）＋**elapsed time**。回答文は **provisional draft として streaming 表示（上記 (ii)）**し、検証済み回答で置換する。provisional 表示中は「下書き・検証前」である旨を視覚的に明示する。`reasoning_content` 不在時（現行 llama-server default auto の未検証域）は phase 行のみとし、**thinking 文面の捏造はしない**。

## 12. 実装計画案

- 方針: framework 推奨は **Svelte 5＋Vite**（SvelteKit `adapter-static` single bundle または plain Vite build のいずれか。llama.cpp `tools/ui` と同系統）。理由: (a) collapsible thinking／stats／drawer 等の component 化に適合、(b) 単一 static bundle を同一 server routes 背後で配信でき no-CDN・CSP self を維持できる（llama.cpp が `ui.cpp.in` 埋め込みで実証済み）、(c) 上流 UI と知見・pattern を共有できる。**fork 再利用はしない**: 上流 client は llama-server の `/chat/completions`＋`/stream` 直結の汎用 chat であり、当方の `answer.submit` 終端 protocol・citation grant・C22 承認・session 認証には不要 surface が多く、攻撃面・e2e 作り直しが増える。MIT 表示義務を満たしつつ pattern（ReasoningBlock・SSE delta parse・statistics badges・markdown pipeline 方針）を流用する。
- PR 分割（各 PR は docs＋実装＋e2e green を条件とし、DB migration を伴わない）:
  - PR-1 chat page shell＋dark theme（新 framework、同一 server routes 背後）: 受入＝既存 SSR id（`#conversation`/`#composer` 等）と同等操作が可能・CSP self guard pass・`mobile_layout` 相当 pass。e2e: 既存 11 spec 維持（shell 差し替えに伴う selector 移行は spec 内修正で吸収し削減なし）。
  - PR-2 streaming backend（model `stream:true`＋新規 SSE delta event 型）: contracts への** additive 追加のみ**（既存 event 型の変更なし）。受入＝delta 型の schema test＋SSE 再同期/poll fallback 維持（`polling`・`sse_history` spec green）。
  - PR-3 thinking／status UI（collapsible Thinking＋phase 行＋elapsed）: 受入＝reasoning 有／無の両 matrix で表示確認（無の場合は phase 行のみ・捏造なし）、a11y（`aria-live=polite` 継承）。
  - PR-4 provisional answer streaming（option ii）: 受入＝provisional に「下書き」明示・validated 回答で置換・citation drawer は validated 後のみ。C22 承認表示には**一切触れない**（C22 safety verbatim 維持を e2e で確認）。
  - PR-5 他機能の別 page 分離（記憶管理・自律・学習・shadow・提案・引継ぎ・通知・カレンダー）: 受入＝各 page が単独 route で既存操作を維持（対応 e2e spec を page 単位に移行し 11 spec 相当を維持）。
  - PR-6 旧 UI 退役: 受入＝旧 `client.ts`/`page.ts` 参照の除去・bundle guard（§11.1 Q9 値）・11 spec 相当＋C22 matrix 全 green。
- e2e 保全: 既存 11 spec（`conversation`・`sse_history`・`polling`・`citation_recovery`・`conversation_proposals`・`learning`・`shadow`・`autonomy`・`handoff`・`notifications`・`mobile_layout`）は削減せず、移行先の同等 spec で cover する。C22 approval safety（明示 button のみ・hash/expiry・pre/post-marker・receipt 4 状態）は全 PR で回帰対象とする。
- 未決（open items）: O-1 llama-server（default auto）の Qwen3.8-27B に対する `reasoning_content` 分離挙動の live probe（`--reasoning-format` 要否の確定）。O-2 LiteLLM `/app/config.yaml` 経路での streaming＋reasoning 透過の検証（config は名称のみ確認・未読）。O-3 delta event 型の exact 名称（contracts additive 設計時に確定）。O-4 provisional「下書き」文言の最終確定。O-5 Safari iOS 実機 smoke 手順の確定。O-6 PWA／push の将来追跡 issue 起票。

## 13. Live probe 結果（2026-10-18、config 変更なし）

- 本節は §12 の open items O-1／O-2 に対する live probe の記録。既存節（§1–§12）は書き換えない。
- 方式: 台帳追記式（ledger style）。config 読替・変更なし。

### 13.1 O-1 llama-server 直結 probe（resolved）

- 対象: llama-server（Docker、`qwen3.8-27b`、default flags。`--reasoning-format`／`--jinja`／`--chat-template` 指定なし）。
- 結果: streaming 時に `delta.reasoning_content` を `delta.content` とは別に流す。`delta.content` 側に `<think>` は混入しない。
- 判定: **O-1 resolved**。Qwen3.8-27B は default（`reasoning-format=auto`）のまま thinking が `reasoning_content` に分離される。`--reasoning-format` 追加は不要。

### 13.2 O-2 LiteLLM :4000 経由 probe（resolved）

- 対象: LiteLLM `:4000`（`qwen-local`）。config は名称のみ確認・未読、変更なし。
- 結果: `reasoning_content` deltas を incremental に透過する。実測 45 tokens が約 2.8s の spread で到達し、first chunk は約 0.2s。non-streaming では `message.reasoning_content` を返す。
- 世代速度実測: 約 13.6 tok/s。
- 判定: **O-2 resolved**。LiteLLM 経路での streaming＋reasoning 透過を確認。config 変更は不要。

### 13.3 stats 表示への帰結（timings／usage）

- LiteLLM は llama の `timings` を strip する。stream 時の `usage` は `stream_options.include_usage` 設定時のみ返る（未設定では省略）。
- よって stats 表示（tokens/s）は llama `timings` に依存せず、`stream_options.include_usage` を request した上で `usage`＋elapsed から client／server-side で rate を算出すること。`timings` 直結表示はしない。

### 13.4 open items 更新

- O-1: resolved（§13.1）。
- O-2: resolved（§13.2、§13.3 の include_usage 条件付き）。
- O-3: open 維持（delta event 型の exact 名称は contracts additive 設計時に確定）。
- O-4: open 維持（provisional「下書き」文言の最終確定）。
- O-5: open 維持（Safari iOS 実機 smoke 手順の確定）。
- O-6: open 維持（PWA／push の将来追跡 issue 起票）。
- O-7（new）: show-thinking default（collapsed vs expanded）。推奨: streaming 中は expanded、回答完了後は collapsed。
