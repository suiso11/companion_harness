# アクティブプロジェクト現状照合・実装計画

## 0. 目的・適用範囲
- 本書は remind と Companion Harness の現状を照合し、次の実装順序を定めるための作業台帳である。
- 今回の成果は現状確認と計画保存のみ。プロダクトコード・設定・DB・依存・Git 履歴は変更しない。
- 各リポジトリの合意済み計画を置き換えない。本書はその実装状況と残差分を横断整理する。
- remind の新正本は `remind/.tmp-t6/plan.md`（自律連想記憶 M1–M3）。README と src/tests/docs manifest は実装根拠として静的に確認した。
- 旧 `remind/plan.md` は T1–T6 の承認ベース旧計画。新旧を加算・合算せず、旧 ledger や件数を新計画の実績にしない。
- remind の作業ツリー `.git` は `remind/.git/worktrees/-tmp-t6` を指し、逆 gitdir も一致する。これは通常の linked worktree であり、食い違いではない。
- remind HEAD ref は `feature/autonomous-memory-m1`、参照コミット `b782b9b43d47a08ed125aee4ef356df44a8108f9`。旧 remind root は `feature/t3-deterministic-recall`。
- Companion HEAD ref は `feat/m4-readonly-fork-adoption`、参照コミット `4e74d2db3278b24913dc5210ac83009d9d7be60f`。
- Companion `docs/implementation_plan.md` §16–19 が合意正本。README と `docs/m4_dependency_spike.md` 末尾の記録を進捗の証拠として優先する。
- Git status、dirty/統合状態、ancestry は今回確認していない。ref/worktree の存在だけで統合済みとは判定しない。
- 今回のコマンド検証は 0 件。WSL から `/bin/bash` 起動に失敗したためであり、テスト失敗ではなく未実行である。
- 過去の CI green は過去の証拠であり、今回の pass ではない。src/dist 鮮度、最新 CI、実 Browser も未確認。

## 1. 状態と集計
- `E` = 実装根拠・既存テストあり（今回の実行は未確認）。
- `P` = 部分実装、または受入 coverage 不足。
- `N` = 未実装。
- `D` = 仕様・採用判断待ち。
- `V` = 環境・統合・現在実行の検証待ち。
- 完了状態は設けない。既存機能の確認と新規機能の追加を混同しない。
- 横断2件（G01–G02）＋remind18件（R01–R18）＋Companion22件（C01–C22）=42件。追加連携5件（I01–I05）を含め47件。
- 集計は 42 単位: E6 / P9 / N18 / D6 / V3。47 単位: E6 / P9 / N21 / D8 / V3。
- 42 と 47 を混同しない。工数比率・完成率は算出しない。
- 既存テストで covered の契約は再実装・重複テストせず、不足箇所のみ補う。

## 2. Remind 台帳（新正本 M1–M3）

### G: 横断ゲート
**G01 — 正本・branch・作業ツリー・統合状態の確認 [V]**
対象/根拠: remind と Companion の両リポジトリ、および remind の新 linked worktree（`.tmp-t6`）と上記 worktree 情報。`status` 等は未実行。
残差分/完了: `git status`、worktree、refs ancestry または merge-base 比較を記録し、変更を保護する。合意計画は編集しない。
依存: 着手前の停止条件。参照 worktree だけで統合済みとしない。

**G02 — 実行環境と baseline 確認 [V]**
対象/根拠: 両リポジトリ。remind の unit/CLI/acceptance、Companion の unit/integration/typecheck/E2E 構成。今回のコマンドは 0 実行。
残差分/完了: 実行可能シェルを確認し current tests/typecheck/E2E を実行、結果を記録。既存依存のみ先に試す。
依存: G01。`npm test`/`npm run acceptance` は clean + build 生成を伴うため、書込み許可のある検証タスク内のみ。実ユーザ DB は使わない。

### R: Remind 自律連想記憶
**R01 — M1 起動・config・8 op・旧承認 DB 非破壊拒否 [E]**
対象/根拠: README、`src/`、M1 core/acceptance。
残差分/完了: `m1-core`・acceptance の既存チェックを再実行。旧 DB を変更・移行しないことを確認。
依存: G02。既存実装の重複作成なし。

**R02 — raw 追記→remember/sourceRefs→get/list/即時 recall/raw 下降 [E]**
対象/根拠: store/CLI と m1-core・m1-recall・acceptance。
残差分/完了: 既存テストを再実行し即時想起、raw 本文非露出、参照下降を確認。
依存: R01。scope と active 制約を維持する。

**R03 — 全書込 op の scope/sourceRefs/冪等・監査 [P]**
対象/根拠: store/protocol と既存 m1 tests。
残差分/完了: op 横断 coverage を棚卸し、不足だけ補完。scope 違反・sourceRefs・key 欠落/改変 replay と監査本文非露出を確認。
依存: R01–R02。covered 領域を再実装しない。

**R04 — 有界 hybrid recall の順序・budget・縮退 [P]**
対象/根拠: `src/store.ts`、m1-recall/hardening。
残差分/完了: FTS/bigram、tag/link、raw 下降、graph/fusion、安定順、深さ 2・展開 40・raw 3・候補 60 と予算境界、索引欠落縮退を不足分だけ検証。
依存: R02–R03。未実行を失敗と記録しない。

**R05 — correct/archive 遷移・実並行訂正勝者 1 件 [P]**
対象/根拠: store と現行の逐次訂正・冪等・除外テスト。
残差分/完了: 新計画版として実 DB を共有する並行訂正を検証し、勝者 1 件・敗者 `CONFLICT`・rollback を確認。
依存: R01、G02。legacy T4 競合テストを新 M1 の証明に流用しない。

**R06 — feedback の露出集合と heat [E]**
対象/根拠: m1-recall test の既存計数チェック。
残差分/完了: recall のみでは加熱せず、露出集合内 feedback のみ加熱、同一露出に別 key を使った重複加熱なしを再確認。
依存: R02。既存チェックを再利用。

**R07 — Markdown 投影/backlink/retry/rebuild/recovery [P]**
対象/根拠: `src/projection.ts` と hardening tests。
残差分/完了: backoff、削除・陳腐化再構築、SQLite 正本不変、再起動回復を不足分だけ確認。
依存: R01–R04。既存 retry/rebuild 実装を再利用。公的 rebuild CLI は必要時のみ判断。

**R08 — CLI deadline/stdin/worker/busy clamp/unknown commit [P]**
対象/根拠: deadline/worker-op/CLI と hardening tests。
残差分/完了: 実 CLI 全経路で deadline、stdin 上限、busy clamp、応答上限、unknown commit の同一鍵再送を検証。
依存: G02、R01。単体結果のみで CLI 経路を閉じたとしない。

**R09 — M2 embedding 選定 [D]**
対象/根拠: 正本 §10–12、README の M2 未実装記載。
残差分/完了: ローカルモデル/runtime、exact pin、license、dimension/chunk/caps を評価して選定。
依存: R13 の評価方針を入力として参照するが、R13 最終評価の完了は待たない。外部送信・依存追加は未承認。Ollama 等は候補提案であり pin を勝手に決めない。

**R10 — 派生 embedding 永続化・更新 [N]**
対象/根拠: store/index 構成。機能は未実装。
残差分/完了: model version 分離、生成・再構築・モデル変更時更新を実装し、SQLite 正本の不変性を確認。
依存: R09 の採用決定。

**R11 — bounded vector top-M と既存信号融合 [N]**
対象/根拠: recall/store。vector 検索未実装。
残差分/完了: vector、既存語彙/graph/heat の融合、stable tie と上限を実装・評価。
依存: R09–R10。標準 Node/SQLite 優先、専用 vector DB は追加しない。linear scan は実測上限を決め `ponytail:` ceiling を記録。

**R12 — vector failure 縮退と予算 [N]**
対象/根拠: recall/index。未実装。
残差分/完了: 欠落・無効・timeout 時に語彙＋graph へ縮退し、構造検証・応答予算を確認。
依存: R10–R11。

**R13 — M2 seeded 評価方法 [D]**
対象/根拠: 正本 §10–12。dataset/閾値は未決。
残差分/完了: fake 会話＋seeded dataset、適合・縮退率・latency 指標と受入閾値を定め比較評価を記録。
依存: 評価方針・dataset・指標/閾値案はモデル選定前に準備し R09 と併せて合意。比較評価の実行は R11–R12 後。実ユーザデータを使わない。

**R14 — M3 保守対象・distill 方針 [D]**
対象/根拠: 正本 §7・§10–12。distill 未実装。
残差分/完了: 対象、summary/correction、source/link 根拠、旧記憶扱い、実行契機を決定。
依存: なし。R15–R18 の設計前提。通常書込に承認/TTY を戻さない。高度 scheduler は不要、既定案は手動または明示起動の有界 batch、原記憶自動削除なし。

**R15 — 有界保守候補取得 [N]**
対象/根拠: store/保守機構。未実装。
残差分/完了: cursor/limit、raw sourceRefs 取得、budget、過去 commit 保護を実装。
依存: R14。

**R16 — distill 原子的な直接書込 [N]**
対象/根拠: store validation は既存、`maintain.distill` は未実装。
残差分/完了: summary/correction の直接書込、原子性、provenance/idempotency を実装。
依存: R14–R15。既存 store validation を再利用。

**R17 — 保守 queue/取消/失敗隔離 [N]**
対象/根拠: projection retry pattern。保守 job は未実装。
残差分/完了: 同時実行 1、取消、retry/失敗隔離、成功済み不変を実装。
依存: R15–R16。必要最小の SQLite queue と既存 projection queue pattern を使い、daemon は新設しない。

**R18 — link 後付けと最小育成評価 [N]**
対象/根拠: 正本 §7。AI link 補完/育成未実装。
残差分/完了: 正当化できる orphan/dangling 関連への後付けと最小育成を評価。filler link を作らない。
依存: R14–R17 と既存 R04/R06。完了は正本受入 R3（関連リンク）・R9（育成）を満たす。ベクトル M2 を必須依存にしない。高度 scheduler は対象外。

## 3. Companion Harness 台帳

### C: Companion M0–M5
**C01 — M0 durable queue/CAS/cancel/recovery/API/idempotency/security [E]**
対象/根拠: kernel/server と既存受入。
残差分/完了: current check で再確認し、未実行なら完了扱いしない。
依存: G02。実行結果のみが現状の受入証拠。

**C02 — M1 Markdown bounds/reference snapshot/rN/frozen/CAS [E]**
対象/根拠: ReferenceManager/connector と既存 M1 tests。
残差分/完了: current check で既存受入を再確認。
依存: C01。covered 契約を再実装しない。

**C03 — M2 model/tool loop/citation grant/budget/repair/cancel/privacy [E]**
対象/根拠: agent/model-local/kernel tests。
残差分/完了: fake による既存受入を current check で再確認。
依存: C01–C02。real LLM を必須化しない。

**C04 — JSON status fallback の動的/E2E [P]**
対象/根拠: `client.ts` の逐次 poll は既存。
残差分/完了: SSE 不成立後 terminal まで継続、一時 failure 回復、5 連続失敗停止、Run 非 cancel を E2E で証明。
依存: G02 と C01–C03 の既存 baseline、既存 E2E harness。client polling を再実装しない。

**C05 — duplicate-seq 実 Browser E2E [P]**
対象/根拠: reducer 単体既存、実 Browser duplicate injection 未確認。
残差分/完了: stream に duplicate を注入し二重描画・重複副作用なし、cursor 適用後保存を実証。
依存: G02 と C01–C03 の既存 baseline、既存 E2E harness。reducer の既存 coverage を重複させない。

**C06 — 正常 202 後 reload 中の active Run 再発見 [D]**
対象/根拠: `client.clearPendingKey`→`hydrateHistory` は completed projection。active Run を見失う可能性は疑いであり、確定バグではない。
残差分/完了: 再現調査。pending 送信応答喪失 reload の既存 coverage と別ケースで扱う。
依存: G02 と C01–C03 の既存 baseline、既存 E2E harness。現行契約で解けなければ最小 API 契約拡張を合意。会話本文や新保存項目を localStorage に独断追加しない。

**C07 — current 12 E2E + tests/typecheck:e2e/CI [V]**
対象/根拠: README は source count 12、歴史的 CI green を記録。今回実 Browser は未実施。
残差分/完了: current 12 E2E、追加 tests、typecheck:e2e、Windows/Linux CI release gate を確認。実行後に README 進捗を更新。
依存: G02、C04–C05（C06 は当該受入を採用する場合のみ）。source count は executed count ではない。過去 CI を今回 pass としない。

**C08 — M4 exact binding identity/adoption decision [D]**
対象/根拠: `connector-mcp` は SDK 1.30.0 pin/transport/identity code。readonly fork evidence は 97a3dc3 private `3.0.0-readonly.1`、initialize/tools/list と 4 schema hash のみ。
残差分/完了: protocol evidence、採用、live OAuth を別々に判断し exact identity/version/schema hash と実応答 mapping を確定。
依存: §17–19。evidence は adoption/live/release 証明ではない。release 発행を無条件必須とせず fixed commit/pin 形態を選ぶ。

**C09 — MCP lifecycle/transport/security hardening [P]**
対象/根拠: connector-mcp と SDK fake tests。SDK 1.30.0。
残差分/完了: lifecycle、transport、allowlist、schema drift、env exact、stderr 64 KiB、shutdown、loopback redirect、no resend、concurrency 1 を既存 fake tests で閉じる。
依存: C08。実環境実行は C07 gate。

**C10 — Calendar input/normalization/mapping [P]**
対象/根拠: connector-calendar の proposed binding/input/normalize helper。
残差分/完了: 採用 fork の実応答 mapping、strict fallback、privacy、revision、all-day bounds を接続テストで閉じる。
依存: C08。提案 helper の存在を接続済みとみなさない。

**C11 — authoritative deletion evidence [D]**
対象/根拠: 正本 §17.5 と spike。tombstone 判定未解決。
残差分/完了: 証拠分類を決める。404/410/search omission だけで deleted にしない。不確実なら固定 `calendar_upstream_error`（`upstream_error` 単独は非契約）。
依存: C08–C10。既存 tombstone 契約を勝手に緩めない。

**C12 — MCP→Calendar→Canonical/Snapshot/rN pipeline [N]**
対象/根拠: bootstrap 配線なし。ReferenceManager/Broker と Calendar は未接続。
残差分/完了: MCP search/get から既存 Calendar connector、Canonical/Snapshot/rN、open/refresh/reuse/tombstone まで実装・統合。
依存: C08–C11。既存 ReferenceManager の参照経路を再利用。

**C13 — calendar.search ToolBroker と frozen context [N]**
対象/根拠: ToolBroker に Calendar search 登録なし。
残差分/完了: budget/dedup/timeout/audit、Turn の frozen now/timezone、Retry/Cross-source、Markdown read-only 関連を接続。
依存: C12。

**C14 — frozen config/opt-in bootstrap/lifecycle [N]**
対象/根拠: `bootstrap.ts`/`config.ts` に MCP/Calendar 配線なし。
残差分/完了: instance 登録・shutdown を配線。disabled/unavailable 時は起動 nonblocking。Markdown 未設定でも Calendar 利用可能な構成。
依存: C12–C13。起動時の既定 opt-in 契約を保持。

**C15 — M4 fake integration E2E/CI [N]**
対象/根拠: 現行 E2E は Calendar 導線なし。
残差分/完了: fake MCP + fake model + real UI の会話→search→rN→refresh/tombstone E2E と CI。
依存: C12–C14。live 7-item checklist は専用 scope/calendar と opt-in 承認後のみ、通常 CI 不要。

**C16 — M5 contracts/schema/migrations [N]**
対象/根拠: M5 未実装。
残差分/完了: contracts、schema/migration、immutable proposal hash 15 min、1 pending、複合 FK/constraints。
依存: M5 独立計画。contracts/DB の fake 実装は C01–C03 後に先行可。本番 Action 経路・v0.2 リリースには M4/v0.1 受入と exact write binding の確定が前提。remind 連携は必須依存ではない。

**C17 — Action Agent stage-only [N]**
対象/根拠: M5 未実装。
残差分/完了: 最大 1 件・予算消費・preview のみ stage。`answer.submit` 成功 CAS 時だけ pending を原子的保存。
依存: C16。

**C18 — session-owned approve/reject atomicity [N]**
対象/根拠: M5 未実装。
残差分/完了: session-owned list、approve idempotent 202、reject keyless state-idempotent、API/Turn/Grant/queue execution の原子性。
依存: C16–C17。

**C19 — ActionRun preflight/CAS/no-side-effect-before-commit [N]**
対象/根拠: M5 未実装。
残差分/完了: sourceRevision preflight、stale/deleted 書込 zero/block、Grant 一回 CAS と marker。commit 前に副作用を起こさない。
依存: C18。fake 契約実装は先行可。本番 preflight には C08/C11/C12 の権威取得契約と write binding 確定が必要。

**C20 — readback/receipt atomic terminal [N]**
対象/根拠: M5 未実装。
残差分/完了: readback 後 verified/unverified/failure/unknown、receipt + Snapshot/rN を atomic terminal 化。
依存: C19。

**C21 — cancel/crash/drain/recovery matrix [N]**
対象/根拠: M5 ActionRun 未実装。
残差分/完了: marker 前後の cancel/crash/drain/recovery、unknown 再実行なし、impossible state fail-closed。
依存: C19（必要な終端証拠は C20 と整合）。

**C22 — approval UX/safety acceptance [N]**
対象/根拠: M5 UI/受入未実装。readonly fork に書込経路なし。
残差分/完了: hash-bound 承認カード、拒否/Stop/receipt、自然言語は非承認として fake 安全受入。
依存: C16–C21。live は opt-in + `writeEnabled=true` + 専用 binding の三重 gate。別 write binding 選定が必要。

### I: remind 実連携（未承認の追加スコープ）
**I01 — Companion↔remind 契約の判断 [D]**
対象/根拠: remind 正本 §12 U1、現状連携なし。
残差分/完了: version/scope/入力源/呼出主体/書込方針/budget/識別子を決め、追加スコープを承認。
依存: 連携実装の前提。remind 記憶書込は自律・承認不要。Calendar 外部副作用 M5 の人手承認と混同しない。

**I02 — local CLI JSON adapter [N]**
対象/根拠: remind CLI は既存、Companion adapter 未実装。
残差分/完了: 厳格 stdin/stdout JSON、`shell=false`、bounds/timeout/fixed errors、disabled 時 memoryless 縮退を実装。
依存: I01。既存 remind validation/fake adapter 契約を参照、直接 import/shared DB 禁止。同期 spawn で本番 server を block せず非同期 child を提案。

**I03 — 確定会話 raw→記憶化二パス [N]**
対象/根拠: 両者に跨る配線なし。
残差分/完了: 確定会話イベント→`event.append`→AI 判断の `record.remember`、安定 eventId/key、source/scope validation を接続。
依存: I01–I02。失敗 Run の出力を確定 fact にしない。

**I04 — memory evidence/citation 契約 [D]**
対象/根拠: Companion citation/EvidenceGrant と remind memory 連携なし。
残差分/完了: 断片を untrusted 入力として扱い、Citation/EvidenceGrant/露出/feedback を決める。rN/source_kind/既存 reference 契約変更要否は合意する。
依存: I01 後に I02–I03 と並行可。I03 コード完成は判断の必須依存にしない。無制限常時注入をしない。

**I05 — adapter failure/scope/privacy E2E [N]**
対象/根拠: 跨 repo E2E なし。
残差分/完了: CLI 不可/破損/timeout 縮退、scope、汚染防御、used-only feedback の fake 跨 repo E2E。
依存: I02–I04。I03 の確定会話 raw→記憶化二パスも E2E 対象に含める。記憶欠落で通常応答を失敗させない。

## 4. 実装順序・受入 gate
- Phase 0: G01/G02 を解消する。branch/dirty/統合と実行環境が確認できない間は後続を「実装済み」と扱わない。
- Phase 1: R01–R08 と C01–C07 の既存受入を閉じる。別 repo は並行可。
- Phase 1 方針: 既存受入の再実行を先に行い、不足テストを先行追加。露呈した root cause のみ最小修正する。
- Phase 2: C08–C15 の Calendar fake 配線と R09–R13 semantic を、それぞれの判断依存に応じて並行する。
- Phase 3: R14–R18 maintenance を実装する。M3 の最小育成受入を満たす。
- Phase 4: I01 で連携契約を採用後、I02–I05 に着手する（I04 判断は I02–I03 と並行可）。これは未承認の追加 scope。
- Phase 5: C16–C22 の承認付きアクションを fake で実装・検証。実 Calendar 書込みは opt-in + `writeEnabled=true` + 専用 binding の三重 gate 通過時のみ。M4/v0.1 gate は M5/v0.2 の前提。memory Phase 4 は任意で必須依存ではない。
- readonly v0.1 = C01–C15 acceptance。v0.2 = v0.1 + M5 acceptance。
- 全 Phase に受入 gate を置く。失敗・未実行・判断待ちは完了にしない。
- runtime 未検証のため時間・費用見積もりは出さない。

## 5. 最初の着手範囲と禁止事項
- 実行環境と branch を確認してから既存 baseline tests を再実行する。
- 最初に不足 coverage として R05 shared-DB race test、C04 JSON fallback、C05 duplicate-seq 実 Browser checks を追加・実施する。
- C06 active-reload は再現調査に限定し、契約判断前にバグ断言・API変更をしない。
- 自動 merge/cherry-pick、DB migration、旧 DB convert、remind 連携、OAuth 採用、Calendar 外部 write は実行しない。
- 今回は書込み対象 `active_projects_plan.md` のみ。プロダクトコード・元 `plan.md`・`implementation_plan.md`・lockfile・DB・`.git`・`.pi` 設定は変更しない。

## 6. ユーザ判断
- 着手必須: 新 M1 作業 branch の意図確認と verification。先に shell と dirty 状態を解決する。
- 将来判断 1: embedding 候補と評価閾値。
- 将来判断 2: distill 方法と旧記憶の扱い。
- 将来判断 3: Calendar fork 正式採用、readonly live consent、delete 証拠。
- 将来判断 4: memory 連携範囲と citation 契約。
- 将来判断 5: M5 write binding。
- 決定済みポリシーを再質問しない。全判断を一括回答しなくても Phase 1 は進められる（ただし shell/dirty 解決が先）。
- remind の通常記憶書込に承認・TTY を復活させない。M5 Calendar 外部副作用の人手承認は別境界である。
