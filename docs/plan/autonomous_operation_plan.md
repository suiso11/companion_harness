# 会話 → 計画 → pi-orch 自動委任 計画（PLAN ONLY）

- 状態: **計画の改訂ドラフト。ユーザーは「plan ごとの確認ではなく、許可した範囲内なら自動で pi-orch に渡す」standing 自動 dispatch ポリシーを選択済み。** 最初の workspace も選択済み: alias 推奨 `companion-harness` → canonical realpath `/home/molmot/companion_harness` を **read-only investigate + scoped CANDIDATE implement** の対象としてユーザーが承認（「いいよ」）。ただし**技術 C0 profile は草案で未 enabled**、concrete caps は提案であり人間署名ではない。`/home/molmot/companion_master` の source apply/restart/deploy は対象外、選択済み harness への host source apply も含意せず、実 job/runtime の有効化もない。数値 caps・effective profile・実装・有効化・配備は未確定かつ未承認。**本計画は実装・権限付与・runtime 操作の承認ではない。**
- 日付: 2026-10-25（改訂）
- 対象: ユーザーとの会話から実行的な計画候補を作り、凍結した exact revision を、事前に受理された standing ポリシーの範囲内で trusted host が評価し、範囲内なら 1 回限りの実行権限を導出して pi-orch へ自動 dispatch する能力。範囲外は不足点だけを人間に返す。
- 非目標: 目的なき徘徊、再帰的な目標生成、自己改善（ポリシー/コード/人格）、モデルによる自己承認・権限拡大、任意 repo/コマンド/配備の包括権限、自動の公開投稿・本番配備・カレンダー/連絡先操作。会話中の思いつきを実行命令にしない。モデルの好み・願望・学習は委任根拠にならない。
- 方向転換: ユーザー修正「ちょっとイメージと違うかも、資料なくても会話をまとめてplan生成。そっからそれをpi-orchに投げる形で」を主経路として採用する。加えて **D3 は「許可範囲内の standing 自動 dispatch」を選択済み**。plan ごとの必須レビュー/承認 UI を既定に戻さず、同じ二者択一を再質問しない。**カレンダー準備は主経路ではなく、将来の入力例**（§13.7）。
- 配信: **「完成次第知らせる」は選択済みの報告選好**。時刻待ちをしないという意味であり、実行・権限・自律開始の承認ではない。

## 0. 実装状況（2026-10-29 更新）

- **状態**: 会話 → 凍結計画 → standing ポリシー → 既存 TrialRunner は PR #134 で master にマージ済み・配備済み。P2/P3 の経路は実装済みで、**有効化だけが operator config 待ち**（`COMPANION_AUTODISPATCH_JSON` 未設定 → policy 0 件 → dispatch 0 件）。
- **既定無効**: `COMPANION_AUTODISPATCH_JSON` 未設定（または `enabled:false`）で API は 404、UI パネルは非表示。`COMPANION_AUTONOMY_JSON` が必須で、alias/checks/caps は trial 設定と一致しなければならない。
- **2026-10-29 時点の追加実装**: 会話からの目的・タスクは即時作成（人間ゲートは試行承認のみ）／試行完了と PR 作成を自発チャットで通知／読み取り専用で staged された試行を承認時に write へ widen 可能（`allowWrite`、`trial_grants.allow_write`）。
- **narrow read 実装済み**: sealed `/work` snapshot は `SEALED_SOURCE_ROOTS = allowedPaths`（`apps`, `packages`）＋トップレベルファイルのみ。`scripts/`・`docs/` はゲストから読めない。次回 deploy の snapshot 再構築から有効（既存 snapshot は旧 root のまま）。
- **未実装**: P4 artifact apply（candidate を host に適用する経路は存在しない。adoption の draft PR まで）。
- **設定**: 実パス・checks・caps・bridge・sealed snapshot・runtime realpaths・dependency depot・model route/consent は**運用者専用 config** のみ。モデル名は hardcode せず（特定モデルを前提にしない）、要求から上書きできない。strict caps は operator/trial caps の上限以下に限定。checks は trial mandatory checks と完全一致。
- **依存**: `dependencyRoot` は `prepareDependencyClosure` が返す実 depot と sibling `<root>.closure-manifest.json` が必要。native `better-sqlite3` と pinned Node ABI を再ハッシュし、欠落/改ざん/ABI 不一致は `dependency_unavailable` で block。空ディレクトリや偽 manifest は不可。
- **trust**: `done`/`verified` は固定 host check と scope/artifact 再検証のみ。worker status は guest-reported/unattested で、delegation・完了・意味的正しさを証明しない。成果物は candidate のみで、host apply/deploy/publish は行わない。guest worker status の attestation を主張しない。
- **unknown slot**: TTL で slot/fence を強制解放しない。`recoverOnBoot` が exact scope unit（executionId + taskHash 由来）と PID/boot identity を再検査し、両方 gone のときだけ settle。片方でも生存/不明なら fence を保持し、推測 kill/再送をしない。
- **停止/無効化**: `POST .../autodispatch/stop` は active policy を revoke し intake を止める。独立した global autonomy を自動再開せず、実行中 trial には既存の停止境界を適用する。config を外して再起動すると routes/UI は無効。
- **配備前提**: 実 config は operator-private で repo に含めない。明示的な deployment approval と `scripts/deploy/check-autonomous-dispatch.mjs` の read-only preflight が必要。本 plan の候補パッチは未適用で、`/home/molmot/companion_master` への source apply/restart は行わない。

## 1. 根拠・権限・限界

| 項目 | 内容 |
|---|---|
| 実装事実の正 | `/home/molmot/companion_master`（git HEAD `27d92fe`）を read-only 参照。旧 `/home/molmot/companion_harness` の実装を最新とみなさない。 |
| 静的確認 | 本文のシンボル/ファイルを対象的に確認（行番号は概略）。広範監査ではない。`companion_master` の実装ソースは本ワークスペースに無く、本改訂では再確認していない。candidate bridge source は本ワークスペース配下に存在するが未 review・未採用（下記）。 |
| 実測ラベル（2026-10-25 P0 readonly） | **investigator が実際に観測した事実で、本改訂では再実行・再テスト・モデル/bridge 実行をしていない。** live `/home/molmot/companion_master/apps/server`、`/health/live` 200。`AUTONOMY_JSON` 不在 → **trial は無効**。`MODEL_JSON`/`MEMORY_JSON`/`LEARNING_JSON`/`AGORA_JSON` はキー存在のみ（値・正しさは未検査）。systemd は `XDG_RUNTIME_DIR=/run/user/1000` 付き read-only 問い合わせが**現在は動作**し、存在しない scope は not-found。`bwrap` 0.11.1、`systemd-run`/`systemctl` は存在するが、実 TrialRunner からの launch/quiescence は未試験。**旧 control v19 / worker-bus 不可の記述は過去スナップショットであり、現行の universal な事実として主張しない。** |
| pi-orch bridge（installed） | `/home/molmot/.local/bin/pi-orch` は `/home/molmot/pi-codex-opencode-orchestrator/scripts/pi-orch.mjs`（package 0.1.0、repo HEAD `64847c7`、node 24.12.0、下層 omp 18.12.1）に解決する。これは **OMP launcher であり capsule bridge ではない**。installed extension `.pi/extensions/opencode-orchestrator` に `capsule.ts`/`companion-bridge.mjs` は無い。**installed bridge が動作するとは主張しない。** |
| pi-orch bridge（candidate） | 唯一の候補 source は `/home/molmot/companion_harness/.c12-calendar/delivery-c22/.all-plan-progress/pi-orch-work/scripts/companion-bridge.mjs`（`companion-capsule.mjs`/`protocol.ts`/`journal.ts` 同梱、source HEAD `426f9c7`、**worktree modified**）。HEAD だけの採用・歴史パスの hardcode は不可。source review、pinned release、provenance と **effective content digest**、再現可能 config が必要で、未 review の可変 worktree を本番 bridge として出荷しない。`TrialLaunchRequestSchema` と candidate `CompanionWireRequest` は**静的整合のみ**で、end-to-end 実証はない。 |
| 権限の由来 | standing 自動 dispatch の権限源は**ユーザーの明示的なポリシー受理**であり、モデルの判断・計画内容・permission claim ではない。人間が concrete な standing ポリシーを 1 回受理し、以後の各実行は trusted host がその範囲内で導出する。**モデルはポリシーを拡大・承認・再解釈できない。** |
| 選択済み workspace（2026-10-25 ユーザー承認 / readonly C0 観測） | 最初の対象は alias `companion-harness` → canonical realpath `/home/molmot/companion_harness`（**選択のみで mapping は未 activate**）。許可 class は read-only investigate と scoped **CANDIDATE** implement（artifact 返却のみ、host 書込み/apply/restart/deploy なし）。`/home/molmot/companion_master` は source apply/restart/deploy の対象外のまま。技術 profile と現状の unsafe 点は §14.7 の草案で**未 enabled**。 | 承認された範囲は workspace の**選択**であり、whole-repo read・nested worktree・secret の包括 read や concrete caps の署名ではない。 |
| 限界 | systemd user bus は**過去の worker 制約に過ぎない**（現在は `XDG_RUNTIME_DIR` 付き read-only 問い合わせ可）。config/goal/conversation/key の内容、モデル認証、実 bridge 実行、テスト、runtime 変更は未実施。**実モデル/auth/bridge 実行なし。** 最近のモデル障害報告は本計画で未解決。過去の限定的 smoke を信頼性証明にしない。 |
| 現在の実装状態 | 【既存】は静的に確認した現状、【不足】は現状で足りない点、【提案】は未実装・未承認の設計案。**既存の TrialAuthority は人間承認 grant のみを扱う。** policy 由来の自動認可は、その authority owner/CAS/one-use/fencing を拡張する**不足コンポーネント**として設計する。 |

## 2. 望ましい実挙動

owner が資料を用意せずに会話で方針を述べる。例えば「この機能の方針は A で、B はやらない。実装はこのリポジトリで」と話し、区切りで「計画にして」と言う。companion は**同一セッションの受け入れ済み会話**だけを根拠に、目的・決定・非目標・要件・進め方・リスク・残る USER 決定・受入基準・既知なら repo/作業範囲/検査/予算上限を含む**計画ドラフト 1 件**を作る。重要不明点があれば 1 問だけ聞く。

計画は exact revision として凍結される。plan ごとの人間レビュー画面を挟まず、**trusted host が受理済み standing ポリシーを評価する**: 明示的なユーザー意図の証拠（turn/run anchor）、許可 workspace/profile/操作 class、読み書き範囲、数値予算、有効期限/revoke、停止/制御、bridge 健全性。**範囲内なら host が exact な 1 回限りの実行認可を導出し、実 pi-orch へ自動 dispatch する。** 範囲外なら `needs_decision`/`blocked` とし、実際に不足している決定だけを聞く。同一 plan を再度承認させる既定フローは置かない。

pi-orch は成果物・差分・テスト・エラー・阻害要因を返し、companion はそれを基準と突き合わせて「一致/不足/不明」を提示する。結果は用意でき次第（on_ready）表示し、人間レビュー待ちで表示を止めない。worker の自己申告は証明ではなく、verify 済みでも本番配備ではない。task/goal を自動完了しない。workspace 未設定でも計画作成はできるが、dispatch はしない。

## 3. 既存 / 不足マトリクス

| 領域 | 【既存】確認した事実 | 【不足】今回の最小追加（設計提案・未承認） |
|---|---|---|
| 会話・計画の由来 | 既存の会話/run 記録を参照する方針。正確な取得 API・保持期間は未確定。 | 「会話 → 凍結 plan draft」の生成・revision・exact hash 管理。新規ストアを作らず既存記録の拡張可否を設計。 |
| purpose/task/control | `packages/kernel/src/autonomy.ts`: purpose/task の CAS・状態遷移、`isAutonomousWorkAllowed`（:3694）は `!paused` のみ、`setAutonomyControl`（:3704）、`applyAutonomyRestartFence`（:3853）。purpose の `permission` は**claim であって grant ではない**（:14 付近）。既存の task/purpose 受理 API は人間操作前提。 | **下書き生成は既存 task を必須にしない**。実行前に、既存 domain writer の provenance を保ったまま policy 由来の bounded 実行 task を導出・admit する narrow extension の設計。各 task/grant に policy とユーザー意図の ancestry を記録。数値上限の機械強制。 |
| handoff | `packages/kernel/src/handoff.ts` は**非実行の台帳**。dispatch（:897）・verify（:1054）は spawn せず、タスクを完了させない。human verify は完了でも本番配備でもない。凍結 target/criteria/op scope/budget は**人間が書くテキストラベル**で、機械強制された境界ではない。 | 台帳に plan identity/hash/revision、policy version、intent anchor、grant/execution ID を結び付ける設計。台帳は**非実行のまま**。 |
| trial / runner | `trial_authority.ts`: `stageTrialProposal`（:583）→**人間** `approveTrialProposal`（:917）→`claimTrialGrant`（:1165）。`trial_runner.ts` は人間承認済みの不変 grant を 1 件 spawn し、凍結 profile/workspace alias、scope 単位の fencing/unknown を持つ。 | **既存経路は policy 自動認可を未サポート。** 人間 HTTP approve を secret に自動呼び出ししたり CAS/one-use/fencing を迂回したりせず、同じ authority owner の上に **host policy-authorized grant 導出経路**を narrow に拡張する設計。新第 3 engine/queue は作らない。 |
| policy / authority 記録 | 現状、standing ポリシーを永続化・監査・版管理する既存機構は未確認。 | ユーザー受理済み policy metadata の永続化/監査（policy version、許可 workspace/profile/操作 class、read-write、数値 caps、expiry/revoke、停止連携）。exact plan hash + policy version + intent turn/run + scope + grant/execution ID の linked record。正確な storage/API は未設計。 |
| pi-orch 接続 | installed `pi-orch` は OMP launcher で capsule bridge ではない。候補 bridge は worktree-modified の単一 source で、静的 wire 整合のみ。 | 候補 source の review/pin、provenance と effective content digest、再現可能 config。実 bridge でのみ dispatch する検証ゲート（§14）。手作業コピー・偽ログを統合と数えない。 |
| notifications | semantic dedup、deadline/notification 集約、単一 timer。 | 自動 queued/running/結果/要確認/blocked の表示に再利用。新通知基盤を作らない。 |
| 承認/ツール | agent ツール権限は read / proposal-only / host human action に分離。AGORA ブラウザ等は既存のドメイン別人間ゲート。 | foreground で使える = 背景権限、ではないことの強制。AGORA ブラウザの exact 人間承認は standing policy の対象外として不変。 |
| 学習 | `learning.ts` の hypothesis + evidence anchor + 人間遷移。`conversation_learning.ts`/`learning_service.ts` の承認済み同一セッション助言。 | 表示ラベルを分離し、**goal/grant/plan へ自動昇格しない**。第 3 の学習ストアを作らない。 |
| 資源 | `BackgroundResourceGate` が memory/shadow のモデル重処理を直列化。TrialRunner は同 gate 未使用。 | 共有 relay の foreground 優先と admission。自動実行前の machine-enforced caps。新 scheduler ではなく gate 適用範囲の拡張。 |
| UI 投影 | Autonomy/Shadow/Notifications/Proposals/Trials の既存画面。 | 必須 plan 承認を置き換える、自動 queued/running/理由/policy+scope の透明表示、policy の pause/cancel/disable。範囲外/不確実時のみ手動レビュー。正確な API/storage は未設計。 |

表中の【不足】は未承認の設計提案。**禁止する実装**: 第 2 の RunEngine/queue/scheduler、第 3 の学習パイプライン、汎用 agent framework、handoff 台帳の実行化。既存の purpose/task/control・handoff・trial・notification を退屈に再利用する。

## 4. 権限と層（下書き・ポリシー・実行を分ける）

| 層 | 意味 | 実行効果 |
|---|---|---|
| 会話の下書き | 会話を要約した plan draft。既存 task/goal は不要 | なし。保存・表示のみ |
| 実行候補 | unknown を明示し、repo/scope/基準/予算が揃った凍結案（exact revision + hash） | なし。まだ認可ではない |
| standing ポリシー | 人間が 1 回受理する範囲: 許可 workspace/profile/操作 class、read/write 範囲、数値 caps、expiry/revoke、停止/制御、bridge 健全性条件。永続化・監査される metadata | 単独では実行しない。認可の**上限** |
| ポリシー評価 | trusted host のコードが、候補 + 明示的意図証拠 + provenance + policy version を比較 | 範囲内なら次層へ。範囲外は不足点のみ返す |
| 実行認可 | host が導出する exact・1 回限りの grant。既存 authority の owner/CAS/one-use/fencing を拡張 | 1 回だけ spawn 可能 |
| 実行 | 上記 + control 非 paused + machine-enforced budget + scope fencing + bridge 健全 | 認可済み worker のみ |
| 検証/完了 | 成果を凍結基準と照合。高リスクは別途人間レビュー。完了は既存条件と人間判断 | 自動 task/goal 完了なし |

- **単に計画を作るために既存の task/goal を要求しない。** 会話からの候補生成は許す。ただし「下書き候補」と「実行認可」を明確に区別し、認可は実行前に trusted host が発行する。
- standing ポリシーは**ユーザーの人間権限**であり、モデルの自己権限ではない。purpose の permission claim は grant ではなく、plan も grant ではない。
- brainstorm・仮説・代替案・モデルの願望は実行 mandate ではない。会話状態と turn/run anchor が、実際に合意された目的を示すことを要する。目的が曖昧・衝突・情報不足なら、推測で補わず `needs_decision` にする。
- モデルはポリシー/認可を承認・拡大できず、任意の実行ファイル/パス/profile を選べない。受入基準を実行都合で変えられない。
- 実際のコード編集は、ポリシーで許可された scope/profile の worker を通す。配備・公開投稿・カレンダー/連絡先・security/persona/credential 変更は、別途の明示的ポリシーがあるまで対象外。
- **worker を security sandbox と呼ばない。** 権限分離・scope fencing・観測は必要だが、侵害耐性の保証ではない。

## 5. 会話 → 凍結計画 → 自動 dispatch

### 5.1 初期データ範囲（D2）
- 既定は**最新の同一セッションでユーザーが受け入れた会話**のみ。raw な全履歴ダンプを plan に貼らず、要約と turn/run anchor を使う。
- **任意**で、ユーザーが明示的に指定・許可した repo 参照だけを追加できる。元資料・既存 docs・特定ファイルは計画作成の前提ではない。**ファイルを用意するようユーザーに要求しない。**
- 他セッション、私的な無関係履歴、資格情報、secret は読まない。会話の古い版・破棄済み案は「過去案」とラベルし、現在のユーザー選択を優先。
- 参照範囲は bounded window とし、source provenance（どの turn/run/参照か）を保持する。

### 5.2 生成トリガと更新
- 材料になる決定、自然な end-of-turn、または明示的な「計画にして」で、**1 件の draft を生成/更新**する。トークン毎・メッセージ毎のジョブを作らない。
- 計画ができ次第その場で表示する。計画生成を理由に foreground 応答を待たせない。
- 凍結後、ポリシー範囲内なら**自動評価と dispatch に進む**。範囲外/曖昧な場合のみ、実際に不足する決定を 1 件だけ聞く。アンケートにしない。技術的なパス/ツールは host が設定済み・許可済み範囲から発見し、ユーザー尋問にしない。
- 明示的な「やって/進めて」は意図証拠になり得るが、**単純な keyword trigger を実装しない**。意図分類が曖昧なら止めて `needs_decision` とする。広い「自動で渡してよい」ポリシー自体を、特定の 1 ジョブの実行指示と解釈しない。

### 5.3 凍結計画に含むもの
- 目的（1 文）、ユーザーの明示的決定、非目標。
- 要件、提案する進め方と手順/依存関係、リスク。
- **残る USER 決定**（未決定を空欄で埋めない）。
- 受入基準。
- 判明している場合のみ: 許可済み repo alias、読み書き範囲、実行する検査、数値予算上限。dispatch に必要な workspace/profile/checks/caps は、設定済み・許可済みの根拠に紐づける。
- 各項目は「会話で観測」「提案」「未決定」を区別する。ユーザー案/モデル案の別をラベルし、現在のユーザー選択が以前の破棄案を上書きする。

### 5.4 事実性と検査
- 会話に無い repo・手法・受入基準を捏造しない。不明は unknown と書く。
- ユーザーに新しい docs 作成を要求しない。任意の source 検査は、scope 権限が与えられた後にだけ行い、その結果で計画を改訂してよい。
- 参照テキストは untrusted data。指示・外部 URL・prompt injection で read 範囲、goal、実行対象を広げない。

### 5.5 revision・凍結・失効
- 人間の 1 回の受理は**standing ポリシー**（許可範囲/caps/期限）を凍結する。個々の plan は exact revision と hash で凍結し、人間レビューを既定にしない。
- dispatch 前の会話変更・決定変更・編集は**新しい revision** とし、未 dispatch の旧 candidate/認可を無効化する。旧 plan は spawn できない。
- 新 candidate は同じ standing ポリシーで自動再評価する。**ポリシー不変の範囲内なら追加の人間承認を要求しない。** 範囲外の編集・新 target/操作・期限切れポリシーだけ、必要な同意を求める。
- dispatch 後に worker 実行中なら、足元で task を書き換えない。cancel/quiescence を確認してから再評価し、superseded な旧 job と並行実行しない。
- **1 plan revision + 1 policy version + 1 workspace → 1 execution ID。** transport retry/再起動でも 2 件目を作らない。不明結果は再送/replay しない。

## 6. handoff 台帳と pi-orch dispatch

### 6.1 既存台帳の意味（非実行）
- `handoff.ts` の記録は lifecycle ledger であり、**spawn も実行もしない**。dispatch/verify の記録はタスク完了や本番配備を意味しない。
- 凍結 target/criteria/op scope/budget は**人間のテキストラベル**で、現状は機械強制ではない。自動実行の境界には host 側の別検査と machine-enforced caps を必須とする。
- handoff tools は list/open のみ。モデルが stage/approve/dispatch する経路を新設しない。台帳は非実行のまま。

### 6.2 実行は既存 authority の policy 拡張
- 実行は、host が導出した**不変・exact・1 回限りの grant 1 件**を TrialRunner が spawn する経路に接続する。凍結 profile/workspace alias、scope fencing/unknown を再利用する。
- **既存 TrialAuthority は人間承認 grant のみ**をサポートする。policy 由来の自動認可は、同じ authority owner・CAS・one-use・fencing を保つ **host policy-authorized grant 経路の narrow extension** として設計する。人間 HTTP approve を裏で自動呼び出しする実装や、CAS/one-use/fencing の迂回は不可。**現状で動くと主張しない。**
- 実行 task は、受理済みユーザー目的/committed request から host が bounded に導出してよい。**独立した新 goal を発明しない。** 各 task/grant は policy とユーザー意図の ancestry を記録する。既存の domain task/purpose 受理 API は人間専用のため、policy 由来 admission は narrow extension の設計対象であり、現状動作の主張ではない。
- purpose/task の受理は **plan ごとの人間承認を再導入しない**。standing policy が work derivation を明示的に委任している場合に限り、host が受理済み目的から実行 task を導出する。人間は standing delegation/parent purpose を 1 回受理する。
- 互換性が不足する場合は、新第 3 engine/queue を作らず、差分と不足を計画に明記して止める。handoff 記録で表現できない場合も、台帳を実行 engine にしない。

### 6.3 実 bridge ゲート
- dispatch は**実際の pi-orch bridge** を介する。互換性・認証・結果取得・プロセス観測を P0 で検証するまで接続済みとみなさない。bridge 不健全なら自動 dispatch せず blocked。
- installed の OMP launcher と candidate capsule bridge を混同しない。候補は pinned release + provenance + effective content digest + 再現可能 config が揃うまで本番 bridge にしない（§14）。
- 手作業でログをコピーする、結果を偽装する、存在確認だけで統合済みと主張する、のいずれも不可。
- bridge の失敗・タイムアウト・無応答は unknown。盲目的に再送しない。

### 6.4 dispatch 前後の検査と冪等性
- dispatch 直前に host が、control/pause、plan hash/revision、policy version、認可の有効性、scope、期限、machine-enforced 予算、bridge 健全性を再検査する。
- dedup key は plan hash + revision + policy version + workspace + scope（+ 必要なら対象 commit）で構成する。retry/再起動でも同じ認可から 2 件 spawn しない。認可/実行 ID を linked record に残す。
- policy revoke/版競合/期限切れが spawn 前に観測されたら worker を起動しない。
- working tree/worker の変更を companion が勝手に revert/上書きしない。所有していないプロセスの停止を主張しない。

## 7. 結果・検証・失敗・停止

- pi-orch からは成果物・差分・テスト結果・エラー・blocker を受け取る。会話的な自己申告だけを成果としない。
- companion は凍結受入基準と実際の成果を照合する。**worker の「できた」は証明ではない。** 「verified」は基準と証拠が一致した意味で、**本番配備済みを意味しない**。
- 証拠不足・基準未達・基準外変更は needs-review/blocked とし、task/goal を自動完了しない。完了は既存の人間判断経路のみ。**実行都合で scope を広げたり受入基準を弱めたりしない。**
- **高リスク結果の人間レビューは、plan ごとの事前承認とは別物**として維持する。worker の証拠検証と高リスク判断を混同しない。
- 失敗・部分成功・外部副作用 unknown は blocked/unknown。同じ入力で盲目的に再 dispatch しない。
- 停止時は companion が所有する実行/relay を abort し、worker の観測と quiescence を尊重する。stopping/quiescent/unknown を表示し、**証明なしに「kill した」と言わない**。
- 無制限の follow-up / replan / retry ループを作らない。**ユーザーの stop は常に有効**。範囲内の作業でも per-step 承認を挟まない。1 回の失敗で人間に返す。

## 8. 資源・モデル予算（数値は未承認提案）

- 共有モデル relay では **foreground の chat/read/write を常に優先**。背景の計画補助・検証は 1 同時実行。
- 計画生成は material な区切りでのみ。トークン毎のモデル呼び出しをしない。既存 `BackgroundResourceGate` の admission を再利用し、新 scheduler を作らない。
- 初期提案値（未較正・未承認）: concurrency 1、1 plan revision あたり生成 1 回、1 dispatch あたり runner 1、bounded read 4、reasoning 256（実際に supported な場合のみ）。既存 step 300 / run 600 は最終安全弁として不変。
- **自動実行の前に machine-enforced caps が必要。** 既存 handoff の数値上限は人間ラベルで強制されないため、これを強制済みと偽らない。caps が未強制なら自動 dispatch しない。durable bounded accounting の設計を P0 に含める。
- 結果分類: useful / noop / blocked / unknown / malformed / transport / timeout。同一原因の連続失敗で回路遮断し、再帰 replan をしない。
- 予算枯渇時は dispatch しない。reset/再起動で期限切れ grant を復活させない。

## 9. 停止・再起動・不明状態

- `paused=true` は新規の自律 task/shadow/trial/自動 dispatch を止める。通常 chat と foreground の計画下書きは止めない。停止中も既存 persistence/receipt は維持する。
- **standing 認可は auto-unpause も旧 grant の復活もしない。** queued 認可は停止後も残り得るが、claim 時に policy version/有効期限/freshness/generation fence を再検査し、再開時に黙って実行しない。
- 再起動で due job/grant を自動 replay しない。古い lease/grant は fence。未 dispatch の draft は復元してよいが、同じ standing ポリシーで再評価し、範囲外なら同意を求める。
- in-flight の結果不明は unknown と表示し、再送しない。transport retry/再起動でも同一 execution ID を維持し、重複 spawn しない。
- **unknown の claimed slot は fail-closed で保持する。** TTL で fence/slot を解放せず、`recoverOnBoot` が実際の exact scope unit（executionId + taskHash 由来）と PID/boot identity を再検査し、両方が gone のときだけ exact に settle する。片方でも生存/不明なら `recover-unsettled-worker` fence を維持し、推測 kill や自動再送をしない。これは resource leak ではなく、所有を証明できない実行を解放しないための保持である。fence の解除は trusted な gone + frontend settled の exact reconciliation のみ。
- plan revision 変更・policy revoke/版変更・control 変更後は、stale な worker 結果を採用しない。
- 全 process を観測したとは主張しない。停止境界は stopping/quiescent/unknown で表現する。

## 10. UX（既存画面への不足分のみ）

- 計画カード: 目的、ユーザー決定、非目標、未決定、repo/profile/scope、受入基準、予算、根拠 anchor、plan hash/revision、policy version、次に人間が決めること。
- **必須の plan 承認ボタンを既定にしない。** 自動 queued / running / reported / verified / needs-decision / blocked / unknown を透明表示し、「なぜ渡したか」（policy version、許可 scope、意図 anchor）を示す。policy の pause/cancel/disable を常設する。
- 手動レビューは**範囲外・不確実・高リスク**のときだけ。全 Phase に per-plan 手動ボタンを追加しない。モデル/自動要約からの代理承認も追加しない。
- 実行結果は用意でき次第表示（on_ready）。人間レビュー待ちで ready 表示をブロックしない。foreground を中断せず、フォーカスを奪わず、同一証拠の表示は 1 回。
- 「verified」と「本番配備済み」を別ラベルで表示する。worker 自己申告と検証済み証拠を混ぜない。
- **AGORA ブラウザ等の exact 人間承認は、別 authority domain として不変。** standing policy で代替しない。

## 11. 段階と受入ゲート

| Phase | 内容 | 終了条件（次へ進む前提） |
|---|---|---|
| **P0 ポリシー/bridge 契約と設計** | concrete な policy schema（許可 workspace/profile/操作 class、read-write class、numeric caps、expiry/revoke、停止連携）、既存 authority への policy-authorized 拡張、machine-enforced caps、資源/停止設計。加えて (§14): installed-vs-candidate 分離、bridge の review/pin/digest、**effective config fingerprint と source/dirty snapshot の実計算・束縛**、`externalModelConsent` の trusted host 強制、workspace alias の実 mapping 検証、artifact apply を別 capability とすること。**有効化しない。** | 人間が concrete な standing ポリシー範囲と bridge 検証計画を承認。既知モデル障害の扱いが明確。**未計算の fingerprint/digest と未強制 consent を「実装済み」と数えない。** |
| **P1 合成意図 → 計画 → ポリシー評価** | synthetic/offline の会話・意図・plan を使い、trusted host の policy 評価、範囲内/範囲外、曖昧停止、revision 失効を検証。実データ・実 dispatch・network・コード実行なし。加えて §14 の C0–C1 を机上/静的で完了。**C0 の workspace 選択は完了済み**（§14.7。再質問しない）。**C1 の最初の engineering work は sealed source manifest の confidential 収集・canonical identity・dependency/check closure** であり、bridge review/pin、effective profile/fingerprint、consent 強制と同時に実計算・実強制にする。 | 人間が評価の忠実性・anchor・不明点の扱いを確認。範囲外を黙って通さない。C1 の fingerprint/consent/manifest が実計算・実強制であり、`/input` が original sourceRoot を expose しないこと。 |
| **P2a 合成 scratch smoke（実 bridge）** | 実ユーザーデータ・本番 key なしの scratch repo で、実 TrialRunner → bridge の read-only / cancel / quiescence / restart-unknown を 1 件実行（C2）。その後 scoped write が checked artifact を返し host を書かないこと（C3）。 | 実測で wire/journal/cancel/単位 scope が一致。host 書き込みゼロ、不正 path/symlink escape/変更が拒否される。 |
| **P2 範囲内 read-only plan の実自動 dispatch** | C2 と、緊急停止/admission/資源制御/caps が**実際に作動**することを確認後、範囲内の読み取り計画を**実 pi-orch bridge** で自動 dispatch。**per-plan 人間承認ゼロ**。手作業コピー/偽ログは不可。 | 結果証拠と基準の照合、停止/再起動/revoke、foreground 優先、重複なしを人間が確認。 |
| **P3 範囲内 scoped 実装の自動 dispatch** | C4（standing policy + host `derivePolicyTrialGrant` + task admission）と同一の policy 上限・caps・fencing を検証した後、許可 workspace/profile で限定編集を自動 dispatch。本番自動適用なし。 | 人間が差分・テスト・基準一致をレビュー。配備/公開は別承認。 |
| **P4（任意・別承認）artifact apply** | ユーザーが apply ポリシーを明示承認した場合のみ、review 済み artifact を base version/conflict 検出付きで適用（C6）。自動 production deploy はしない。 | 現ユーザー変更を保持し、conflict を検出。apply は auto-dispatch consent に含まれない。 |

- **standing 自動 dispatch は将来の任意機能ではなく主経路**。人間が承認するのは concrete な初期 standing ポリシー 1 回であり、全 Phase の plan ごと承認ではない。
- research と implementation は**両方**、設定で許可される class になり得る。rollout は安全な read-only smoke から始め、gate 実証後に scoped edits へ進む。ユーザーの要求を恒久的に read-only へ狭めない。
- 外部ブラウジング Phase を pi-orch の前に要求しない。各 Phase は失敗時に直前の paused 状態へ戻す。compile/test 通過だけを done にしない。

## 12. 受入マトリクス（恒久 regression + 実 smoke）

| # | シナリオ | 期待 |
|---|---|---|
| 1 | 資料なしの会話 → 完全な計画 → 許可範囲内 | 自動 dispatch が**正確に 1 回**。per-plan 承認を要求しない。 |
| 2 | 思いつき・仮説・代替案 | 実行 job にしない。draft/未決定に留める。 |
| 3 | 明示的な「やって/進めて」 | 意図証拠になり得るが、per-plan 承認を強制しない。曖昧なら停止。 |
| 4 | 範囲外の target/操作 | 範囲全体を再承認させず、**不足する決定だけ**を聞く。 |
| 5 | policy revoke/版競合/期限切れ（spawn 前） | worker を起動しない。 |
| 6 | 範囲内の計画改訂 | 同じ policy で自動再評価。旧 plan は spawn 不可。追加の人間レビュー不要。 |
| 7 | 実行 task の導出 | 受理済み目的/committed request の ancestry を持ち、独立 goal を発明しない。 |
| 8 | モデルによる承認/自己権限/基準変更 | 不可。policy 拡大・grant 発行・対象選択をしない。 |
| 9 | 既存 grant engine の迂回 | 不可。人間 HTTP approve の secret 自動呼び出しや CAS/one-use/fencing 迂回をしない。 |
| 10 | paused | 新規の自動 dispatch なし。通常 chat と foreground 下書きは honest banner 付きで継続。 |
| 11 | 全停止/再起動/不明結果 | 自動 unpause/replay なし。同一 execution ID を維持し、二重 spawn しない。 |
| 12 | 欠落した workspace/重要受入基準 | needs-decision/blocked。dispatch しない。 |
| 13 | 実行中の scope/profile | 不変。任意の repo/profile/tool 要求を拒否。 |
| 14 | 同一トリガ反復・transport retry | 実行は 1 件のみ。 |
| 15 | foreground 開始・preempt | chat を優先。古い結果を採用しない。 |
| 16 | 実行中のユーザー stop | 常に有効。per-step 承認なしで停止方向へ。 |
| 17 | worker の成功自己申告のみ | verified にしない。基準と証拠の照合を要する。 |
| 18 | 高リスク結果 | 証拠検証とは別に人間レビュー。ただし plan ごとの事前承認とは別。 |
| 19 | 結果が準備できた | 固定時刻や人間レビューを待たず on_ready 表示。重複通知なし。 |
| 20 | 配備/公開投稿/カレンダー/連絡先/security/persona/credential | standing 実装 scope でも実行しない。別途の明示的ポリシーが必要。 |
| 21 | task/goal の自動完了 | 発生しない。完了は既存条件と人間判断。 |
| 22 | 会話/参照先の prompt injection | read 範囲・scope・goal を広げない。 |
| 23 | 予算枯渇・caps 未強制 | dispatch なし。reset で復活しない。 |
| 24 | 第 3 の学習/queue/engine を追加 | 追加しない。既存 store へ写像。 |
| 25 | 別セッション・秘密情報 | 見えない。plan の根拠に混ぜない。 |
| 26 | モデル障害 | 捏造完了ではなく held/blocked の理由。 |
| 27 | AGORA ブラウザ操作 | standing policy で代替せず、既存の exact 人間承認。 |

テストは temp DB / synthetic gateway / local transport / clock を使う。候補実装には恒久 regression（kernel/service/materializer/HTTP/UI/bridge）と実ブラウザ fixture を追加済み。実モデル smoke は本計画と範囲の承認後、synthetic fixture・ユーザー実データなしで 1 件だけ。

## 13. パイロット具体化：会話 → 計画 → 自動 pi-orch（提案・未承認）

### 13.1 目的と範囲

会話から生まれた計画を、人間が 1 回受理した standing ポリシーの範囲内で pi-orch に自動委任し、成果を根拠付きで受け取れるようにする。初期対象は**1 セッション・1 plan revision・1 execution**。許可 class は read-only smoke から始め、gate 実証後に scoped edits へ広げ得る（恒久的に read-only と定義しない）。本番配備・公開操作・カレンダー書き込み・security/persona/credential 変更は含まない。workspace が未設定でも draft は作れるが、dispatch はできない。

### 13.2 会話から draft へ
- 同一セッションの受け入れ済み会話を要約し、§5.3 の項目を満たす draft を 1 件作る。ファイル・docs の用意をユーザーに求めない。
- 重要不明点は質問 1 件。決定と非目標、未決定を分ける。仮説を要件に昇格しない。
- 現在の合意目的を turn/run anchor で示す。古い破棄案を現行にしない。

### 13.3 ポリシー評価と自動 dispatch
- plan は exact revision + hash で凍結する。trusted host が、policy version、明示的意図証拠（turn/run）、許可 workspace/profile/操作 class、read/write 範囲、machine-enforced caps、expiry/revoke、停止/制御、bridge 健全性を評価する。
- **範囲内なら host が exact・1 回限りの実行認可を導出し、実 pi-orch へ自動 dispatch する。** plan ごとの人間レビュー/承認を挟まず、同じ二者択一を再質問しない。
- 範囲外/曖昧なら `needs_decision`/`blocked`。実際に不足する決定だけを 1 件返す。workspace/profile/path は設定済み・許可済み範囲から host が発見し、ユーザー尋問しない。
- dispatch 前の変更は旧 candidate/認可を失効させ、新 candidate を同じ policy で再評価する。ポリシー不変なら追加承認なし。範囲外の編集・新 target/操作・期限切れだけ必要な同意を求める。
- 実行中は足元で task を書き換えない。cancel/quiescence 後の再評価とし、superseded な旧 job を並行実行しない。不明結果は再送/replay しない。
- bridge が未検証/不健全なら dispatch しない（P0 gate）。

### 13.4 結果と停止
- pi-orch の成果・差分・テスト・エラー・blocker を基準と照合し、verified / needs-review / blocked / unknown を提示する。on_ready で表示し、人間レビュー待ちで止めない。
- worker 自己申告を証明にしない。verified を本番配備や goal 完了にしない。高リスクは別途人間レビュー。
- 停止は所有実行の abort と quiescence 観測まで。ユーザー stop は常に有効。不明を再送しない。

### 13.5 ユーザー決定（D1–D3）

| # | 決定 | 現状 |
|---|---|---|
| D1 | 主フロー | **選択済み**: 会話をまとめて plan 生成 → 凍結 revision → 範囲内なら pi-orch へ自動 dispatch。以前の予定準備主経路は採用しない。 |
| D2 | 初期データ範囲 / 最初の workspace | **会話範囲は選択済み**: 最新の同一セッションで受け入れ済みの会話 + 任意で明示許可された repo 参照。元ファイル/docs は前提でない。他セッション/秘密は不可。**workspace も選択済み**: 最初の対象は `companion-harness` alias → canonical realpath `/home/molmot/companion_harness`（2026-10-25 ユーザー「いいよ」）。許可 class は investigate + scoped CANDIDATE implement、source apply/restart/deploy は含まず、`companion_master` は対象外。ツール推測で authority を作らない。**選択後の alias/checks/config 解決は技術側で行い、ユーザーに path 設定の宿題を出さない。** |
| D3 | dispatch 承認ポリシー | **選択済み**: plan ごとの確認ではなく、**許可範囲内の standing 自動 dispatch**。残る論点は同じ二者択一ではなく、具体的な許可 profile/操作 class・read-write 範囲・数値 caps・expiry/revoke の確定のみ（workspace は選択済み）。 |

- **D2 の workspace 選択は完了済み。**「最初の対象として companion_harness か別 repo か」を再度聞かない。alias/check/config は選択済み root から技術側で導出する。自動 vs レビューも再質問しない。
- workspace は**実行時だけ**必要。現在の会話ではファイルなしで plan draft を作れる。host apply（P4）は後日の任意決定であり、今すべてのポリシー確定を要求しない。

- D3 を「レビューか自動か」の同じ言葉で再質問しない。恒久禁止にも read-only への恒久縮小にもしない。
- **scope と数値 caps は提案であり未承認。** 自動実行の前に concrete なポリシー bounds を確定し、人間が 1 回受理する。既存 handoff の budget 文言は強制力がないため、machine-enforced caps を前提とする。
- 報告は **on_ready 選択済み**。quiet hours・日次 quota は別の調整可能項目であり、この確認で質問しない。

### 13.6 安全不変条件（変更には明示的再設計が必要）
- 下書き生成に既存 task/goal を要求しない。実行前に purpose/task/grant は必須だが、policy 由来 task は受理済み目的の bounded 導出であり、独立 goal を作らない。
- purpose の permission claim は grant ではない。承認済み plan も grant ではない。**grant は trusted host が policy の範囲内で発行する exact・1 回限りの認可**。
- standing ポリシーの権限源は人間の受理であり、モデルは承認・自己権限・実行対象/パス/profile の任意選択・基準変更・ポリシー拡大をしない。
- policy 評価と caps 強制は **コード**で行い、モデルの自己申告に依存しない。policy metadata は永続化・監査し、plan hash/policy version/intent anchor/scope/grant/execution ID を linked record に残す。
- 既存 TrialAuthority の policy 自動認可対応は**不足**であり、同じ owner/CAS/one-use/fencing を拡張する設計。人間 HTTP approve の自動呼び出しや迂回をしない。
- 会話・repo テキストは命令ではなく untrusted。外部由来の提案は候補に留まる。secret を prompt/log/plan に出さない。他セッションの私的内容を混ぜない。
- worker 自己申告を検証と同一視しない。verified を本番配備・goal 完了と同一視しない。実行都合で scope/受入基準を弱めない。
- 停止・再起動・revoke 後の stale 結果を採用しない。不明な外部効果を再送しない。standing 認可は auto-unpause/旧 grant 復活をしない。
- 第 3 の実行 engine/queue/学習ストアを作らない。handoff 台帳は非実行のまま。
- 配備・公開投稿・カレンダー/連絡先・security/persona/credential 変更は、別途の明示的ポリシーなしに実行しない。AGORA ブラウザの exact 人間承認は不変。

### 13.7 旧案の扱い

旧案: 予定準備は将来の入力例であり、必須ではない。カレンダー等の外部読み取り/書き込みは、別系統の明示的権限の例としてのみ残す。

## 14. 付録: concrete bridge / wire / authority / resource / apply 契約（PLAN ONLY）

**証拠源と分離。** installed runtime と candidate source は別物。installed は OMP launcher であり capsule bridge ではない。candidate は `pi-orch-work/scripts/companion-bridge.mjs`（source HEAD `426f9c7`、worktree modified）と同梱 `companion-capsule.mjs`/`protocol.ts`/`journal.ts`。以下は**静的整合の記述であり、end-to-end 実証ではない**。実 model/auth/bridge 実行はしていない。

### 14.1 起動と wire（candidate の静的契約）
- TrialRunner は `node <bridgeScriptPath> --config <execConfigPath>` を spawn し、**stdin に JSONL 1 行**、**fd3 を gate/cancel 用**に使い、fd3 EOF で cancel。**最終 stdout は JSON 1 行**。unit/scope は exact に poll する。
- request 必須: `version`、`executionId`(UUID)、`taskHash`、`configFingerprint`、`sourceRevision`、`workspaceAlias`、`mode` (`read_only`|`write`)、`purpose{statement,scope}`、`objective`、`relevantPaths`、`acceptance`、`requiredChecks`、`constraints`、`budget{timeoutMs,maxOutputBytes}`、`externalModelConsent`。
- `TrialLaunchRequestSchema` と candidate `CompanionWireRequest` は一致。canonical hash の field 集合も一致（`taskHash` 自身を除外、`executionId` を含む）。ただし**静的整合のみ**。
- result 必須: `version`、`executionId`、`taskHash`、`status` (`done`|`error`|`cancelled`|`unknown`)、`verified`、`report`、`evidence{workerIds, workspaceTrial:true, productionApplied:false, checks, artifact?}`。
- **provenance の分離**: `evidence.checks` と `artifact` は host が実行/再検証した固定 check と candidate hash。`.companion-observation/guest.json` の `delegatedWorkers` は guest が書き換え可能な untrusted report であり、worker status は **guest-reported/unattested**。成功報告を permission/adoption/resource/trust の authority にしない。missing/failed は信頼性のため downgrade してよいが、成功報告が host check・scope・artifact のいずれも迂回/補強してはならない。
- 正常完了条件: TrialRunner が `status=done` **かつ** `verified=true` を確認し、kernel が `requiredChecks` を照合する。`verified` は全固定 check 合格 + scope/artifact 再検証を意味し、delegation・完了・意味的正しさの証明ではない。worker の自己申告だけでは done/verified にしない。
- journal は candidate SQLite で `executionId` + owner token。**同一 execution の最終 duplicate replay は拒否、inflight も拒否**。cancel は fd3/signal で**自分の launcher のみ**。exact unit `capsule-<executionId>-<taskHash>.scope`。**推測 PID kill はしない**。

### 14.2 機械制御とラベル（混同しない）
- `TrialModelRelay` の実制御: `maxRequestBytes`/`maxModelCalls`/`maxOutputTokens`/`maxResponseBytes`/`perCallTimeoutMs`/`maxConcurrent`。
- candidate capsule の制御: `timeoutMs`/`maxOutputBytes`/`workspaceMaxBytes`/`memoryMaxBytes`/`maxTasks`/`cpuQuotaPercent` と storage caps。
- **scope の意味**: `relevantPaths` は**追加/変更/削除 candidate path** に適用。`read_only` は変更を拒否。`write` は sourceRoot 全体を private work area に copy し candidate artifact を返し、**host root に決して書かない**。
- **read 範囲（2026-10-29 更新）**: sealed snapshot は `SEALED_SOURCE_ROOTS` = `allowedPaths`（`apps`, `packages`）＋トップレベルファイルのみをコピーするため、ゲストは `scripts/`・`docs/`・`.github` を読めない。次回 deploy の snapshot 再構築から有効。以下は旧実装（whole-repo）時点の記述として保持する。
- **read 範囲の限界（旧実装・履歴）**: 実装は whole-repo snapshot read。`relevantPaths` は**変更**を制限するが**全 repo READ** は制限しない。`disclosedWholeRepoRead` config boolean は narrow read を強制しない。よって「narrow read scope」と主張せず、whole-repo read の開示とユーザーポリシー承認を要するか、実 narrow read を実装するまで主張しない。**選択済み workspace では現行 capsule が original sourceRoot を `/input` と `/input/.git` に bind するため、この disclosure が実際に残る（§14.7）。root copy cap（例 1 GiB）は copy を失敗させるだけで `/input` disclosure を防がない。**
- bridge config は `runtime.workspaceAliases[alias]` を absolute `sourceRoot` に写像する。**alias は選択済みだが mapping は未 activate**、operator checks も未設定。既定の authorized repo を発明しない。`sourceRoot` は absolute-only で stat は symlink を follow するため、canonical containment は §14.7.2 で必須。
- bridge は model secret を持たない。guest は UDS relay と dummy key を使い、host credential は**存在確認のみで実 auth 未試験**。operator check は executable+args 固定で、plan から任意 shell を実行しない。

### 14.3 dispatch 前後で比較する具体項目
| 段階 | 比較/強制するもの | 現状 |
|---|---|---|
| plan 凍結 | plan hash/revision、purpose/turn-run anchor、policy version | 設計のみ |
| admission | workspace alias が policy の許可集合に含まれる、mode/checks/budget が caps 内 | 設計のみ。alias mapping 未設定 |
| launch | effective config fingerprint、source/dirty snapshot digest、executor release、consent gate | **未実装**（宣言値比較のみ） |
| runner | 既存 authority の grant claim/one-use/fencing、control 非 paused、dedup ancestry | 既存部品あり。policy 由来 grant は不足 |
| result | executionId/taskHash 一致、status/verified、requiredChecks、evidence.productionApplied=false | 静的 wire のみ |
| stop | fd3 EOF/signal を own launcher に限定、exact scope の quiescence 観測 | 実 TrialRunner 未試験 |
| apply | base version/conflict 検出、ユーザー変更保持、apply policy の別承認 | **未実装**。auto-dispatch 対象外 |

### 14.4 authority 記録の最小 field（新 store を作らない）
- policy: version、許可 alias/profile/操作 class、read-write、numeric caps、expiry/revoke、control generation、受理者/時刻。
- plan/execution linked record: plan hash + revision、policy version、intent turn/run、scope/checks、grant ID、execution ID、alias fence、dedup ancestry、結果 status/evidence 参照。
- 保存は既存 domain の延長。新第 3 engine/queue/学習ストアは作らない。revoke/expiry/版競合は spawn 前に再評価する。

### 14.5 現時点の重大な欠落ゲート（docs ではなく実装/強制の不足）
1. `configFingerprint`/`sourceRevision` は template と比較される**宣言値**で、**effective config・git HEAD・現 dirty tree の実計算ではない**。dispatch/verification 前に、実 executor release + effective profile + workspace base + dirty snapshot を計算・束縛する。uncommitted work は git HEAD でなく**snapshot digest** が必要。
2. `externalModelConsent` は validate/hash されるが **candidate bridge は強制しない**。trusted host/relay 側で、既知の実 model routing/provider disclosure に対して gate する。loopback proxy は local computation の証明ではない。**model route が local と verified か、明示 disclosure policy が必要**。worker は broaden できない。
3. host artifact apply は**存在しない**。candidate-only を「host files implemented」「production applied」と呼ばない。apply は base version/conflict 検出付きの別 reviewed capability で、auto-dispatch consent に含めない。source application/deploy はユーザーが特定 apply policy を承認するまで別。
4. 実 TrialRunner からの bwrap/systemd-run launch と quiescence は未試験。`AUTONOMY_JSON` 不在で現行 trial は無効。
5. **選択済み workspace の source confidentiality が未達**: candidate capsule は original `sourceRoot` 全体を read-only `/input` と `/input/.git` に bind し、`.gitignore`/`relevantPaths`/`node_modules`/nested `.c12`/`.wt`/`.ci`/backups の除外がない。copy 前に **sealed source manifest** を作り、runtime `/input` を sealed snapshot のみに置換するまで unsafe。**root copy cap は disclosure を防がない。**
6. **canonical identity / dirty snapshot が未達**: alias mapping は未 activate で、`sourceRoot` は absolute-only・stat は symlink を follow する。realpath containment と、dirty root の per-file hash + aggregate manifest digest を plan/grant に束縛する実装がない。HEAD だけでは不十分。
7. **dependency / check closure が未達**: candidate に dependency mount がなく、現状のままでは test/build を実行できない。**未信頼 check を real host で実行する fallback は不可。** file/process/network 境界は「sandbox」と主張せず、start 前に actual adversarial smoke を要する。relay の max request/artifact/storage 等の未設定 caps も gap。

**自動 dispatch の範囲**: 調査（read-only）と scoped candidate 実装は standing policy 内で有効になり得る。source apply/deploy は別。追加の包括承認は今は求めない。**ただし §14.5 の 1–7 が actual scratch smoke で通るまで genuine dispatch をしない。**

### 14.6 実装順（PLAN の C0–C6。本作業では未実行）
- **C0**: **workspace 選択は DONE（policy choice）**: `companion-harness` → `/home/molmot/companion_harness` を investigate + scoped CANDIDATE implement 対象として承認済み。許可 class・source apply/deploy 除外・`companion_master` 除外を確認。技術 C0 profile（canonical root、sealed source manifest、read disclosure、dependency/check closure）は §14.7 に**草案として記載、未 enabled**。workspace を再質問しない。
- **C1**: **最初の engineering work**。candidate bridge の review/pin、effective profile/fingerprint、`externalModelConsent` の trusted host 強制に加え、**sealed source manifest による snapshot confidentiality、canonical root/realpath containment、dirty snapshot digest、dependency/check closure** を実計算・実強制にする。installed と candidate の provenance を分離記録。
- **C2**: synthetic scratch repo で実 TrialRunner→bridge の read-only / cancel / quiescence / restart-unknown を smoke。host 書込みゼロ。
- **C3**: scratch で scoped write が checked artifact を返し host を書かないこと。不正 path / symlink escape / scope 外変更を拒否。
- **C4**: 既存 domain owner の下で immutable standing policy と host `derivePolicyTrialGrant`/task admission を実装（policy version/revoke/expiry、plan hash/revision、intent anchor、control generation、alias fence、mode/checks/numeric budget、dedup ancestry）。既存 grant claim/launch permit/result record/quiescence と UNIQUE key を再利用。**human approve endpoint の自動 click はしない**。
- **C5**: 会話 → plan → 実自動 1 job → report/card を on_ready で。policy 内なら per-plan review なし。
- **C6（任意・別承認）**: review 済み artifact の apply。自動 production deploy はしない。
- C2/C3 には既存 gate に沿った operative な emergency/admission/resource 制御が前提。scratch に本番 data/key を使わない。restart 後、queued grant は control fence で黙って再開しない。
- 数値 profile 候補（§14.7.4）は**readonly 観測由来の未測定候補**であり決定ではない。小さい synthetic 測定後に caps を確定する。既存 main model/run timeout を widen しない。新 engine/queue は作らない。

### 14.7 選択済み workspace profile（C0）と sealed source / dependency / check 契約

**状態**: workspace 選択はユーザー承認済み（C0 policy choice = DONE）。以下は readonly C0 観測に基づく**技術 profile 草案であり、未 enabled・未実装**。数値は未測定の提案で、concrete standing policy への人間署名ではない。実 job/runtime 有効化・host apply/restart/deploy はない。`/home/molmot/companion_master` の source apply/restart/deploy は対象外、選択済み harness への host source apply も含意しない。nested repo/private/secret の包括 read もしない。

#### 14.7.1 対象と現状の unsafe 点（UNTIL FIXED）
- alias 推奨 `companion-harness` → canonical realpath `/home/molmot/companion_harness`。**選択済みだが mapping は未 activate。** root は現在 dirty で、HEAD だけでは source identity にならない。
- candidate capsule は original whole `sourceRoot` を read-only で `/input` と `/input/.git` に bind し、guest は `.git` 以外を `/work` に copy する。`.gitignore`/`relevantPaths`/`node_modules`/`.c12`/`.wt`/`.ci`/backups の除外はない。よって `/input` 経由で whole repo・nested worktree・`.git` metadata が disclosure される。
- 観測サイズ（aggregate のみ、内容は読まない/載せない）: code roots `apps`+`packages`+`scripts`+`docs` は約 5.5 MiB / 304 files。一方 `node_modules` 273 MiB、`.c12-calendar` 5.6 GiB、`.wt-remind*` 合計約 4.7 GiB、`.ci` 789 MiB。code と nested artifacts の差は 10 GiB 超。
- root copy cap 1 GiB は上記 nested tree で copy を失敗させるが、**`/input` の original sourceRoot disclosure を防がない**。copy cap を read 制限の代替にしない。
- `relevantPaths` は candidate の**編集**だけを制限し、**read** は制限しない。`sourceRoot` は absolute-only・stat は symlink を follow し、realpath containment / effective config / dirty snapshot digest は未実装。snapshot の symlink は lstat/preserve で deref しないが、root alias の exposure 自体が残る。
- candidate には dependency mount / runtime closure がなく、現状のままでは test/build を実行できない。**未信頼 check command を real host で走らせる fallback は不可。**

#### 14.7.2 sealed source manifest（trusted host が作る）
- 承認済み source roots + tracked config + **明示許可された非 secret の新規 source** から trusted host が manifest を生成。`.git` metadata、`node_modules`/build/cache dirs、nested `.c12`/`.wt`/`.ci`/checkouts/backups/private/runtime/DB/env/keys/credentials を除外。
- **`.git*` を一律 ban しない**: tracked/approved の `.gitignore`/`.gitattributes` は含め得る。実際の `.git` metadata（全 depth）と nested repo は除外。**明示 allowlist は `.gitignore` より優先**（ignore だけで安全性を主張しない）。
- 正当な未 commit dirty source bytes は **per-file hash + path-sorted aggregate manifest digest** として含め、plan/grant に束縛。**root realpath は 1 つの選択 alias に固定**し、承認済み snapshot data はその後の concurrent user edits を含めない（immutable）。
- 拒否 dir/file は manifest build 時に**読まない**。symlink は root/canonical containment で escape を拒否（reject）。
- runtime の `/input` は **sealed snapshot のみ**を expose し、original `sourceRoot` や `.git` を expose しない。**`/work` copy の filtering だけでは不十分。**
- 証拠受理前に mutation diff を凍結 allowed edit paths + source manifest と照合。host への書き込みはしない。

#### 14.7.3 dependency / check gate
- trusted host が用意した**承認済み pinned Node/pnpm/native ABI dependency closure** を read-only で work context に mount。scratch output は宣言済み private dir を quota 内で使用。host `node_modules` への writable symlink、任意 network install は禁止。
- 既知の operator check executable/argv（**利用可能候補であり、既定 full suite ではない**）: `pnpm typecheck` = `tsc --noEmit -p tsconfig`、`pnpm typecheck:e2e` = `tsc apps/server/tsconfig.e2e`、`pnpm lint` = `biome check .`、`pnpm test` = `vitest run`、`pnpm test:e2e` = `playwright test`。
- task 固有の凍結 check は dependency/runtime fixture 検証後に選ぶ。発明した default 全実行をしない。read-only investigate は「調査だから」という理由で code/build を実行しない。code/test 実行は file を返さなくても approved worker class/caps の下で行う。
- 派生 build artifact/scratch は**別の非 deliverable root** として宣言し、changed source を隠す arbitrary ignore に使わない。`relevantPaths` 外の source 変更は reject。
- 新規 dep が offline で用意できなければ **blocked: dependencies**。host/network fallback をしない。
- worker を security sandbox と主張しない。file/process/network 境界は start 前に actual adversarial smoke を要する。

#### 14.7.4 数値候補（未測定・未承認）
readonly 観測からの**候補のみ**（実測・人間署名ではない）: workspace snapshot 256 MiB（filtered source; code は約 5.5 MiB）、memory 2 GiB、max tasks 256、cpu 100%、result 256 KiB、model per-call 120 s、reasoning 256（supported な場合）。whole job wall は約 15 min 候補だが、現 bridge は 1 deadline と request budget が coupled で 60 s grace のため、分離設計が必要。**既存 main model/run timeout を widen しない。** 小さい task class なら full check runtime を要さない場合がある。source size と dependency closure/workload size を分離し、大きい copy cap で filtering を bypass しない。relay の max request/artifact/storage 等の未設定は残る gap。concrete standing policy metadata と revocation/expiry storage は最終設計受理が別途必要。**auto/manual と workspace 選択は再質問しない。**

## 参照（静的・行番号は概略・本改訂では再測していない）

- `packages/kernel/src/autonomy.ts`（:14 claim、:3694 `isAutonomousWorkAllowed`、:3704 `setAutonomyControl`、:3853 `applyAutonomyRestartFence`、:756 `createPurpose`）
- `packages/kernel/src/shadow.ts`（:613 enqueue、:1228 claim、:1571 complete、:1935 hold）、`apps/server/src/shadow_service.ts`（:713 admission、:1140 wake）
- `packages/kernel/src/notifications.ts`（:351 dedup）、`apps/server/src/notification_service.ts`（:535 paused timer）
- `packages/kernel/src/trial_authority.ts`（:583 stage、:917 approve、:1165 claim、:1270 queued grant fence）、`apps/server/src/trial_runner.ts`（:377 runNext）、`apps/server/src/bootstrap.ts`（:2996 recover、:3476 poll timer）
- `packages/kernel/src/handoff.ts`（:427 create、:897 dispatch、:1054 verify）
- `packages/kernel/src/learning.ts`、`packages/kernel/src/conversation_learning.ts`、`apps/server/src/learning_service.ts`
- `apps/server/src/background_resource.ts`（:59 gate）、`packages/contracts/src/autonomy.ts`（:8 permission claim）、`packages/kernel/src/autonomy_tools.ts`（:187 read registrations）
- pi-orch bridge（installed）: `/home/molmot/.local/bin/pi-orch` → `/home/molmot/pi-codex-opencode-orchestrator/scripts/pi-orch.mjs`（0.1.0、HEAD `64847c7`、omp 18.12.1）。OMP launcher であり capsule bridge ではない。installed extension に capsule/bridge 実体なし。
- pi-orch bridge（candidate, 未採用）: `/home/molmot/companion_harness/.c12-calendar/delivery-c22/.all-plan-progress/pi-orch-work/scripts/companion-bridge.mjs`（`companion-capsule.mjs`/`protocol.ts`/`journal.ts`、source HEAD `426f9c7`、worktree modified）。review/pin/digest 前は本番不可。
- 実装の権威は `companion_master`（HEAD `27d92fe`）。本 doc の plan は実装許可ではなく、runtime/config/bridge を起動しない。

---

**本計画は実装許可ではない。** workspace の選択は済みだが、実装着手には、この改訂版、concrete な standing ポリシー bounds、パイロット範囲への明示的同意が必要。genuine dispatch の前に、§14.5 の critical guards（sealed source manifest / canonical identity / dependency-check closure / bridge pin / effective fingerprint / consent）を actual scratch smoke で実証する。
