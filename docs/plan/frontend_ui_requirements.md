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
