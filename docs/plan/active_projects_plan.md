# アクティブプロジェクト現状照合・実装計画

## 現在地（DONE / INPROGRESS / TODO）— 2026-10-14
- 定義: DONE=限定scope実装/検証済み（下記範囲のみ）。INPROGRESS=部分実装または残gateあり。TODO=未着手。blocked/判断待ちは3分類内に記載し、4分類目は新設しない。いずれもマイルストーン全体（M3/Phase 1・M2/M3・M4/v0.1・M5/v0.2）完了の主張ではない。
- E/P/N/D/V（§1）は作成時点の歴史snapshotとして据え置き、書き換えない。現況判断は本節＋各項目の現況注記＋[execution_progress索引](execution_progress_2026-10-10.md)・README証拠で把握する。
- DONE（限定）: Companion M0–M2実装基盤（C01–C03既存実装/テストあり）。C04/C05 corrected local acceptance（2026-10-10 17/17→2026-10-11 full Browser 21/21・Vitest 88 files/1086に含む）。C06修正・local acceptance（active-run discovery契約＋C06 4 cases、同21/21）。M3文言/409 browser acceptance（10/14限定 conversation 4/4 `もう一度生成`整合＋conflict-notice citation 8/8 genuine 409×1・PUT到達×1・製品第二分岐無変更、full suite再実行とは別扱い）。remind M1実装基盤＋R05共有DB correction race/rollbackのみ（OK=1/CONFLICT=1・loser実ROLLBACK・副作用残留なし）。CalendarはC08 protocol evidenceのみ（c08-evidence.tar.gz SHA `52b63fee…`・4 schema hash一致・structuredContent ABSENT）／C09 library hardeningのみ（merged PR16/PR17、server有効化前）／C10 consumer normalizationのみ（94 files/1164等）／C11 negative deletion boundaryのみ（6/6等）に限定。
- INPROGRESS（部分・残gate）: M3集約release gates（C07: 後継remote CI aggregate 23/23が最新集約だが、未コミット変更の現行CI・Windows 11 manual smoke・M3/Phase 1全体は未完）。R05全体受入（race済みだがarchive/rollback全要件は未完）。Calendar C08–C15未完成統合（C08正式採用HOLD/NOT ADOPTED・live OAuth/Googleなし、C10-08 production mapping UNRESOLVED、C11-01 positive tombstone BLOCKED・C11-05未配線、C12はPR20 pipeline source＋local/fake verificationのみ、C13–C15はPR20後継branch code/verificationありをlocal/fake範囲として区別、実接続/採用なし）。G01/G02確認・baseline再実行も残gate。
- TODO（未着手）: remind M2（R09選定・R10–R12実装・R13評価、判断待ち: 候補/license/pin・閾値）。remind M3（R14方針・R15–R18実装、判断待ち: distill/旧記憶扱い）。連携契約と実連携（I01契約判断・I04 citation契約が判断待ち、I02/I03/I05実連携は未着手）。M5承認付きaction（C16–C22 fake含め未着手、判断待ち: 専用write binding・三重gate）。Calendar live 7-item・readonly live consentも未着手。
- 現況追記（2026-10-15、履歴保持・上記TODO行は書き換えない）: I02/I03 の実装＋単体回帰は oc-12〜oc-15 で適用済み（既存 suite green 維持の報告を継承し再実行なし）で、I05 相当の live HTTP→synthetic loopback gateway→REAL remind CLI tempDB smoke を 2026-10-15 に完了（turn1 `event.append`＋`record.remember` acked・CLI `record.recall` 1 snippet、turn2 構造 `m1` 引用＋`record.feedback` acked＋同run `m1` grant、idle `maintain.distill` 自動 acked（LLM-disabled degraded＝scheduling proof のみ）。gateway は synthetic であり real-model ではない。I01/I04 の正式採用判断・Windows manual・現行 CI は未完維持。perception/export/deletion は未実装維持。
- 証拠範囲: 本節の数値は各項目の現況注記と上記索引・READMEの再利用であり、新規製品テスト・要件/順序の変更なし。

## 0. 目的・適用範囲
- 本書は remind と Companion Harness の現状を照合し、次の実装順序を定めるための作業台帳である。
- 今回の成果は現状確認と計画保存のみ。プロダクトコード・設定・DB・依存・Git 履歴は変更しない。
- 各リポジトリの合意済み計画を置き換えない。本書はその実装状況と残差分を横断整理する。
- remind の新正本は `remind/.tmp-t6/plan.md`（自律連想記憶 M1–M3）。README と src/tests/docs manifest は実装根拠として静的に確認した。（作成時点の記述として保持。実行証拠側の現行正本判断は [execution_progress 索引](execution_progress_2026-10-10.md) を参照：当時 `.tmp-t6` 不在のため merged autonomous M1 root を現行正本とした）
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
- 集計は 42 単位: E6 / P9 / N18 / D6 / V3。47 単位: E6 / P9 / N21 / D8 / V3。（作成時点の歴史集計であり、正確な再計数はしていない。現況の完了主張ではない）
- 42 と 47 を混同しない。工数比率・完成率は算出しない。
- 現況同期（2026-10-14、履歴保持、最新証拠整合）: 上記 E/P/N/D/V は作成時点の snapshot のまま据え置く。C04/C05 corrected local acceptance、C06 修正/local acceptance（local full 21/21・Vitest 88 files/1086、2026-10-11；後継 remote CI aggregate 23/23 は C07 参照）、R05 共有DB correction race（OK=1/CONFLICT=1・loser rollback 検証済み、R05 全体は未完）、10/14 限定 conversation 4/4＋conflict-notice citation 8/8（各 full suite 再実行とは別扱い、M3 文言整合・harness seed 修正・第二分岐は製品無変更）は各項目の現況注記と [execution_progress 索引](execution_progress_2026-10-10.md) を参照。Calendar は C08 protocol DONE/HOLD・C09 pre-enable IMPLEMENTED・C10 consumer IMPLEMENTED/C10-08 UNRESOLVED・C11 negative のみ/C11-01 BLOCKED・C12 PR20 部分 local/fake のみ（実接続/採用なし）を C08–C12 現況に追記。M3/Phase 1 全体・Windows manual・未コミット変更の現行 CI・M2/M3/M4 実接続/連携は未完維持。合意要件・順序の変更なし。
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
現況（2026-10-14、履歴保持）: 共有DB correction race は OK=1/CONFLICT=1・loser 実 ROLLBACK・成功 ledger/副作用残留なしを検証済み。R05 全体（archive/rollback 全要件）は未完維持。
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

### R14–R18 補足 — ローカル小型LLMによる育成の整理（横断台帳メモ、正本の代替ではない）
- 本補足は既存 R14–R18 の分類要約であり、要件/決定/順序の変更・重複削除・新規決定をしない。DONE/INPROGRESS/TODO 分類は保持する（R14=[D]、R15–R18=[N]）。計画記載済みと実装済みを混同しない。M2 の最新 status は remind README・既存台帳・証拠を参照し、古い「M2 未実装」主張を新たに追加しない。
- 根拠: remind 正本 `remind/plan.md`（§7・§10–12、R3/R9 受入を含む）および `docs/retention.md`（exposure/heat/eviction 契約等）。本横断台帳は正本の代替ではない。詳細は正本・retention の当該位置を参照する（正本の正確な節番号は本台帳作成時の既存記載に従い、新規断定しない）。
- 合意済み方針（既存記載の整理、削除なし）:
  - 原記録保持、保持バイアス（育成で原記憶を自動削除しない）。
  - 事実/実験優先、一過性感情を人格特性化しない。
  - 固定 TTL・時間だけの忘却なし。
  - retired と archived/superseded の区別、一度の取り出しで再活性化しない、一時非表示との区別を維持する。
  - 通常記憶書込に承認・TTY を復活させない（承認不要）。
  - 外部送信なし（local-only）。
- 現行実装（既存台帳の範囲）: R01–R08 の M1 基盤のみ。distill・link 補完・育成の実装は未着手（R14–R18 の [D]/[N] を維持）。
- 提案安全策としての有界背景処理（既存 R14–R18 の小見出し整理、条件落ちなし）:
  - リンク後付け: 正当化できる orphan/dangling 関連のみ、リンク 0 件を許容し filler 禁止、想起時リンク自動付与なし。
  - 蒸留統合: distill は有界・取消可・同時 1・失敗隔離・リトライ有界・直接冪等書込み（store validation 経由・単一 transaction・provenance/sourceRefs 付き）。
  - 可逆引退: retired を archived/superseded と区別し、可逆・再活性化条件を一回の取り出しでは満たさない。一時非表示とも区別する。
  - 明示検索/再活性化: 明示的な検索・再活性化経路のみで、一度の取り出しによる自動再活性化をしない。
  - 追加訂正の実引用: correction/supersedes 連鎖・sourceRefs・引用根拠を保持し、根拠 refs なしの事実化をしない。
- 未決定技術（新規固定なし）: LLM モデル・runtime・見直し入力・API・状態 schema・閾値・資源 bounds・安全策実装検証はいずれも未決定。リンク判断のすべてを同一小型 LLM に固定しない。

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
現況（2026-10-14、履歴保持）: corrected local acceptance 済み（2026-10-10 17/17 の C04/C05 coverage、2026-10-11 full Browser 21/21 に含む。Vitest 88 files/1086）。M3/Phase 1 全体は未完。
依存: G02 と C01–C03 の既存 baseline、既存 E2E harness。client polling を再実装しない。

**C05 — duplicate-seq 実 Browser E2E [P]**
対象/根拠: reducer 単体既存、実 Browser duplicate injection 未確認。
残差分/完了: stream に duplicate を注入し二重描画・重複副作用なし、cursor 適用後保存を実証。
現況（2026-10-14、履歴保持）: corrected local acceptance 済み（2026-10-10 17/17 の held-gap terminal-consumer proof 強化、2026-10-11 full Browser 21/21 に含む）。M3/Phase 1 全体は未完。
依存: G02 と C01–C03 の既存 baseline、既存 E2E harness。reducer の既存 coverage を重複させない。

**C06 — 正常 202 後 reload 中の active Run 再発見 [D]**
対象/根拠: `client.clearPendingKey`→`hydrateHistory` は completed projection。active Run を見失う可能性は疑いであり、確定バグではない。（上記は作成時点の記述として保持）
残差分/完了: 再現調査。pending 送信応答喪失 reload の既存 coverage と別ケースで扱う。
現況（2026-10-14）: 実再現→修正実装→local acceptance 済み（`GET /api/sessions/:sessionId/active-run` 追加、2026-10-11 full Browser 21/21 の C06 4 cases、C06 疑い/未修正の記述は supersede）。M3/Phase 1 全体・Windows manual・未コミット変更の現行 CI は未完維持。
依存: G02 と C01–C03 の既存 baseline、既存 E2E harness。現行契約で解けなければ最小 API 契約拡張を合意。会話本文や新保存項目を localStorage に独断追加しない。

**C07 — current 12 E2E + tests/typecheck:e2e/CI [V]**
対象/根拠: README は source count 12、歴史的 CI green を記録。今回実 Browser は未実施。（上記は作成時点の記述として保持）
残差分/完了: current 12 E2E、追加 tests、typecheck:e2e、Windows/Linux CI release gate を確認。実行後に README 進捗を更新。
現況（2026-10-14）: 古い「12 件未実行」は履歴。provisioned 12/12→corrected 17/17（2026-10-10）→local full 21/21（2026-10-11、Vitest 88 files/1086）を経て、後継 remote CI aggregate 23/23（2026-10-11、PR11 review head 56b7952、runs 38106715359/38106713796、Ubuntu 88/1086・Windows 88/1084+2 skips）が最新集約。10/14 限定 conversation 4/4（M3 文言 `もう一度生成` 整合）＋conflict-notice citation 8/8（`参照の更新で競合しました…` 表示→再読/retry、genuine 409×1、PUT 到達×1、製品第二分岐は無変更、harness seed-citation fresh-mint 修正、e2e typecheck exit 0、他 suite 非再実行）は full suite 再実行とは別扱い。M3 全体・未コミット変更の現行 CI・Windows manual は未完維持。
依存: G02、C04–C05（C06 は当該受入を採用する場合のみ）。source count は executed count ではない。過去 CI を今回 pass としない。

**C08 — M4 exact binding identity/adoption decision [D]**
対象/根拠: `connector-mcp` は SDK 1.30.0 pin/transport/identity code。readonly fork evidence は 97a3dc3 private `3.0.0-readonly.1`、initialize/tools/list と 4 schema hash のみ。
残差分/完了: protocol evidence、採用、live OAuth を別々に判断し exact identity/version/schema hash と実応答 mapping を確定。
現況（2026-10-14）: protocol evidence のみ DONE（2026-10-11 c08-decision-docs、archive `docs/evidence/c08/2026-10-11/c08-evidence.tar.gz` SHA `52b63fee…`、4 canonical schema hash 一致、full SHA `97a3dc3…`＋lock digest `6afe76f9…`、wire `google-calendar`/`3.0.0-readonly.1`、structuredContent ABSENT）。formal adoption は HOLD/NOT ADOPTED、live OAuth/Google なし。M4 完成主張なし。
依存: §17–19。evidence は adoption/live/release 証明ではない。release 発행を無条件必須とせず fixed commit/pin 形態を選ぶ。

**C09 — MCP lifecycle/transport/security hardening [P]**
対象/根拠: connector-mcp と SDK fake tests。SDK 1.30.0。
残差分/完了: lifecycle、transport、allowlist、schema drift、env exact、stderr 64 KiB、shutdown、loopback redirect、no resend、concurrency 1 を既存 fake tests で閉じる。
現況（2026-10-14）: wire-identity guard・輸送 bounds・trusted read-only boundaries は merged master PR16/PR17 で IMPLEMENTED（stderr 64KiB cap・shutdown・HTTP redirect・no resend・concurrency 1、server 有効化前の library 段階）。prod registration・fork pin・OAuth・live は対象外。C07 gate・Windows manual は未完。
依存: C08。実環境実行は C07 gate。

**C10 — Calendar input/normalization/mapping [P]**
対象/根拠: connector-calendar の proposed binding/input/normalize helper。
残差分/完了: 採用 fork の実応答 mapping、strict fallback、privacy、revision、all-day bounds を接続テストで閉じる。
現況（2026-10-14）: consumer normalization のみ IMPLEMENTED（`normalizeSearchResult`/`normalizeGetResult`・`time.ts`・`searchInput`、94 files/1164 tests＋e2e typecheck exit 0、root typecheck/lint は初回 FAIL→bounded fix 後 PASS、11/11 smoke）。C10-08 production mapping は UNRESOLVED（adopted binding/pin/profile/OAuth/live なし）、fractional ISO gap 残存。採用主張なし。
依存: C08。提案 helper の存在を接続済みとみなさない。

**C11 — authoritative deletion evidence [D]**
対象/根拠: 正本 §17.5 と spike。tombstone 判定未解決。
残差分/完了: 証拠分類を決める。404/410/search omission だけで deleted にしない。不確実なら固定 `calendar_upstream_error`（`upstream_error` 単独は非契約）。
現況（2026-10-14）: consumer 側 negative のみ IMPLEMENTED（`deletion-boundary.test.ts` 6/6、full 95/1168、root/e2e typecheck exit 0、biome exit 0 after fix、genuine SDK Server＋InMemoryTransport fixture）。C11-01 は BLOCKED（positive tombstone 証拠なし）、HTTP status は UNKNOWN、C11-05 snapshot retention は C12 未配線。tombstone 生成なし。
依存: C08–C10。既存 tombstone 契約を勝手に緩めない。

**C12 — MCP→Calendar→Canonical/Snapshot/rN pipeline [N]**
対象/根拠: bootstrap 配線なし。ReferenceManager/Broker と Calendar は未接続。
残差分/完了: MCP search/get から既存 Calendar connector、Canonical/Snapshot/rN、open/refresh/reuse/tombstone まで実装・統合。
現況（2026-10-14）: PR20（2026-10-13 HEAD `61b3573`、merge 2026-10-14）で pipeline source 実装＋local/fake verification のみ（full 106/1270、typechecks exit 0、lint 219 files、action.spec 13/13、§19 source-run）。実接続・採用なし（C08 HOLD・C10-08 UNRESOLVED・C11-01 BLOCKED 維持）、live Google/OAuth なし。v0.1/M4 完成主張なし。
依存: C08–C11。既存 ReferenceManager の参照経路を再利用。

**C13 — calendar.search ToolBroker と frozen context [N]**
対象/根拠: ToolBroker に Calendar search 登録なし。
残差分/完了: budget/dedup/timeout/audit、Turn の frozen now/timezone、Retry/Cross-source、Markdown read-only 関連を接続。
現況（2026-10-14）: PR20 後継 branch に `calendar_tools`・frozen Turn 関連 code あり（local/fake 範囲）。実接続・採用なし（C08 HOLD・C10-08 UNRESOLVED 維持）。完成主張なし。
依存: C12。

**C14 — frozen config/opt-in bootstrap/lifecycle [N]**
対象/根拠: `bootstrap.ts`/`config.ts` に MCP/Calendar 配線なし。
残差分/完了: instance 登録・shutdown を配線。disabled/unavailable 時は起動 nonblocking。Markdown 未設定でも Calendar 利用可能な構成。
現況（2026-10-14）: PR20 後継 branch に bootstrap/config 配線 code あり（local/fake 範囲、triple-gate 等）。実接続・採用なし。完成主張なし。
依存: C12–C13。起動時の既定 opt-in 契約を保持。

**C15 — M4 fake integration E2E/CI [N]**
対象/根拠: 現行 E2E は Calendar 導線なし。
残差分/完了: fake MCP + fake model + real UI の会話→search→rN→refresh/tombstone E2E と CI。
現況（2026-10-14）: PR20 後継 branch に calendar fake E2E（`calendar.spec`/`tombstone.spec`/`action.spec` 13/13 等）あり（local/fake 範囲）。live 7-item・採用・CI for HEAD は未完。
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
現況（2026-10-15、履歴保持）: adapter 実装＋単体回帰（stdout厳格検証・shell=false固定argv・timeout kill/abort settle・EPIPE settle 等）適用済み。live smoke（2026-10-15、I05 参照）で real CLI tempDB に対する実呼び出しを確認。I01 正式採用判断は未完維持。

**I03 — 確定会話 raw→記憶化二パス [N]**
対象/根拠: 両者に跨る配線なし。
残差分/完了: 確定会話イベント→`event.append`→AI 判断の `record.remember`、安定 eventId/key、source/scope validation を接続。
依存: I01–I02。失敗 Run の出力を確定 fact にしない。
現況（2026-10-15、履歴保持）: service 実装＋単体回帰（completed＋現選択のみ耕作、async後再検査、引用gate feedback、outbox安定key追従 等）適用済み。live smoke（2026-10-15、I05 参照）で turn1 の二パス acked＋CLI recall 可視を確認。

**I04 — memory evidence/citation 契約 [D]**
対象/根拠: Companion citation/EvidenceGrant と remind memory 連携なし。
残差分/完了: 断片を untrusted 入力として扱い、Citation/EvidenceGrant/露出/feedback を決める。rN/source_kind/既存 reference 契約変更要否は合意する。
依存: I01 後に I02–I03 と並行可。I03 コード完成は判断の必須依存にしない。無制限常時注入をしない。

**I05 — adapter failure/scope/privacy E2E [N]**
対象/根拠: 跨 repo E2E なし。
残差分/完了: CLI 不可/破損/timeout 縮退、scope、汚染防御、used-only feedback の fake 跨 repo E2E。
依存: I02–I04。I03 の確定会話 raw→記憶化二パスも E2E 対象に含める。記憶欠落で通常応答を失敗させない。
現況（2026-10-15、履歴保持）: fake E2E ではなく live smoke で完了：real Companion HTTP＋synthetic loopback gateway（scripted `answer.submit`＋抽出JSON、real-model ではない）＋REAL remind CLI tempDB。turn1 acked 二パス＋CLI recall 1 snippet、turn2 構造 `m1` 引用＋feedback acked＋`m1` grant、idle `maintain.distill` 自動 acked（LLM-disabled degraded）。preemption/start/stop は既存単体回帰の範囲。Windows manual・現行CI は未完。

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
- 現況（2026-10-14、履歴保持）: 上記 2 行は作成時点の最初の候補として保持。最新証拠との整合：R05 race（OK=1/CONFLICT=1・loser rollback 済み、R05 全体未完）、C04/C05 corrected local acceptance 済み、C06 は調査限定を supersede し修正・local acceptance 済み（2026-10-11 local 21/21、後継 remote 23/23 は C07 参照）、10/14 限定 conversation 4/4＋citation 8/8 は full 再実行と別扱い、Calendar C08–C12 部分のみ（C08 HOLD・C10-08 UNRESOLVED・C11-01 BLOCKED・実接続なし）。合意要件・順序の変更なし。
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

## 7. 長期自律コンパニオン構想・議論合意の記録（設計文書のみ） {#autonomous-vision}
- 本節は 2026-10-14 のユーザ承認により会話内容を Companion docs へ保存した設計記録である。新規 docs は作らない。本節の追加は `docs/implementation_plan.md`（合意正本）・`remind/plan.md`（自律連想記憶 M1–M3 正本）・`remind/.tmp-t6/plan.md` の要件/順序/実装を変更しない。実装・自動変更・runtime 権限付与・完了主張ではない。既存 §0–§6・E/P/N/D/V snapshot・現況注記・件数・順序・マイルストーンはすべて保持し、圧縮・削除しない。
- 状態分類: 本節の将来実装はすべて TODO（未着手）として扱う。既存 DONE/INPROGRESS/TODO を書き換えない。POLICY=明示合意済み方針（将来実装時の設計拘束、runtime 許可・実装完了ではない）。PROPOSAL=議論で支持された設計案（未決定・未承認）。UNRESOLVED=明示的に未解決。ユーザの一般的賛意を実実行認可とみなさない。モデル・数値 bounds をここで選定しない。
- ポリシー合意は runtime permission でも実装完了でもないことを明示する。本節はいかなる自動権限拡張・予算拡張・目標変更も承認しない。

### 7.1 VISION（ユーザ述べた長期像、原文保持）
- 日常の気軽な会話（casual everyday conversation）を主とする。
- 会話からタスク・カレンダーを導出・整理する（derive and organize tasks/calendar from conversation）。
- `pi-orch` 経由での実装試行（attempt implementation via pi-orch）。
- 数十年単位の記憶：in-scope の原本記録をすべて保持し、適切な relevance/priority を付ける（decades-long memory retaining all in-scope original records with appropriate relevance/priority）。
- 概ね手介入なし（mostly no manual intervention）。
- 電子的生命のような継続性は志向するが、意識の主張ではない（electronic-life-like continuity not a claim of consciousness）。

### 7.2 PURPOSE MODEL（PROPOSAL：設計として支持、未実装・TODO）
- 目的種別を明示的に区別する：explicit goal／preference／constraint／permission／wish／temporary state と AI inference は別物。
- 高確信でも permission を付与しない（High confidence never grants permission）。
- provenance／原文発言・scope・時間適用性を保存する。corrections／revocation／achievement・関連 records を追跡する。
- Goals do not authorize means（目的は手段を認可しない）。
- 明示的な訂正は適用範囲の古い決定に優先する（Specific explicit corrections supersede applicable older decisions）。newest が無関係 goals を上書きしない。矛盾は未解決のまま残す。沈黙は同意でも拒否でもない（silence is neither consent nor refusal）。
- 一時的な感情を恒常的人格としない（Temporary feelings not permanent personality）。
- 有効な permissions／constraints は recall ranking や memory retirement と独立に检查する（must be checked independent of recall ranking or memory retirement）。
- 原本記録と解釈は分離する（Original records and interpretations separate）。

### 7.3 DELIBERATOR（PROPOSAL：設計として支持、モデル未選定・TODO）
- 有界 invocation：自律 action 候補または重要な policy 変更のときのみ起動し、無限の多モデル議論はしない（bounded invocation on autonomous action candidates or important policy changes, not endless multi-model discussion）。
- Inputs：triggering event／conversation、relevant memories／explicit vs inferred goals、active tasks／prior failures、permissions／constraints と remaining budget。
- Output：execute／hold／ask／do-nothing、evidence IDs、reason、proposed action、completion／stop conditions、uncertainty／counterargument。
- Proposals only：code が permissions／budget／cancel／concurrency／deadlines を enforce する。
- まず shadow evaluation（実行なし）から始める。評価対象：wishes-not-commands／corrections／external-instructions-no-authority／do-nothing。
- Dedicated role は current model を先に使ってよい。Separate model と memory cultivation small LLM は同一モデルに固定しない（separate model and memory cultivation small LLM not fixed to same model）。

### 7.4 TASK/ACTION（PROPOSAL：設計として支持、正式 permission 変更は UNRESOLVED・TODO）
- 区別：casual chat／wishes／problems／tasks／deadlines を区別する。task creation と calendar scheduling は分離する。日付を発明しない（no invented dates）。
- 発言者区別：User instructions／self-proposals／untrusted external text を区別する。
- 事前認可された隔離 workspace での自律 investigation／implementation は提案軸であり、自動の actual permission ではない（proposed axis, not automatic actual permission）。
- Predefined target／operation／resource scope を定める。
- 外部 publication／shared branch changes／payments／deletion／secrets／access changes は個別に認可された boundaries を要する。Missing permission は affected operation のみ block する。
- pi-orch handoff：purpose／target／acceptance／scope／budget を渡す。concurrency・cancel・abnormal exit を追跡する。Outcomes を検証し worker ran のみで成功としない。Sandbox success != production deployment。Retry は原因別・無限にしない。Acceptance criteria を pass させるために弱めない（never weaken acceptance criteria to pass）。
- Hold records：reason／reconsideration trigger／parent purpose を記録する。意味ある state change で resume し、繰り返し timer のみで resume しない。Revoked purpose は dependent tasks を再評価する。

### 7.5 LEARNING（POLICY：合意済み方針、未実装・TODO）
- 学ぶ対象は methods／hypotheses／evidence のみ。permissions／budget の拡張や user goals の変更はしない。
- Rejected proposal は恒常 preference ではない。Success は将来 authorization ではない。Failed hypotheses は facts ではない。
- 派生 subgoals を user goals へ trace し、revocation で再評価する。
- 有用性証明のための work／notification を生成しない（No work/notification generated just to prove usefulness）。
- Stop を覆す self-preservation をしない（No self-preservation overriding stop）。

### 7.6 NOTIFICATIONS（POLICY：明示合意、未実装・TODO）
- Casual conversation を保全し、強制 taskization や progress interruptions をしない。
- 定常 work は log し、自然な区切りで簡潔に伝える。Pending questions は deadlines を除き group する。
- Major danger／commitment impacts は promptly notify する。No change=>no notification。
- Silence は consent でも refusal でもない。Hold は unauthorized action のみを止め、allowed work は続ける。

### 7.7 RESOURCE（POLICY：明示合意、未実装・TODO）
- User conversation／stop を background より優先する。応答性が害されるなら background を throttle／pause する。
- Model は own budget を増やせない（model cannot increase own budget）。
- Numeric bounds／concurrency は測定で選び、ここでは決めない（chosen by measurement not here）。

### 7.8 RECOVERY（POLICY：明示合意、未実装・TODO）
- External supervisor が crashes／OS boot を auto restart する。Dependency recovery は related-feature degradation を伴う。
- Planned self-restart は safe boundary で supervisor 経由で state を persist する。直接の broad OS-admin grant は与えない（no direct broad OS-admin grant）。
- Explicit user activity／global stops は reboot 越えで persist する。Process restarting != permission to resume。
- Retry 前に live workers／external side effects を reconcile し、重複を作らない。Repeated failures は backoff／degrade／pause し、無限 restart storm にしない。Bulk catch-up（全 notifications／tasks の一括追行）をしない。
- Hardware／OS unbootable は separate external recovery equipment を要し、same-machine recovery を約束しない（not promised same-machine recovery）。
- Durable continuity であり、uninterrupted uptime ではない。

### 7.9 SELF MAINTENANCE（POLICY：明示合意、未実装・TODO）
- 隔離下で code／dependency fixes を自律 trial できる。Production rollout は preauthorized scope のみで、evidence・backup・recovery procedure を要する。
- Self-update で rights／budget／stop を弱めない（Never weaken rights/budget/stop by self-update）。
- Code rollback != DB rollback。Post-update の conversation／activity records を保持し、stale DB の自動 restore で新記録を失わない。Compatibility／recovery を考慮する。
- System／model／schema migration、backup restoration verification、export／service termination、device change は数十年運用に必要だが not implemented（未実装・TODO）。

### 7.10 MEMORY（PROPOSAL＋一部合意整理、未実装・TODO）
- 既存 remind small-local-LLM cultivation 詳細へ link し、本節で重複定義・上書きしない（R14–R18 補足を参照）。No external sending、reversible retirement（not deletion）。
- Facts／source／corrections priority と relevance／importance／usage を分離する。Usage != truth。Self-reinforcing recall feedback を避ける。
- 'All' scope の提案：conversations／own activities であり、全 device files／secrets ではない。Exclusions／explicit deletion／backup erasure／export は UNRESOLVED。
- Exact model／runtime／threshold／resources は発明しない（No exact model/runtime/threshold/resources invented）。

### 7.11 既存計画への調整（EXISTING PLAN ADJUSTMENTS、要件・順序不変）
- U1 integration は vision により自動承認されない（U1 integration not automatically approved by vision）。I01 決定 gate が依然必要。
- M5 per-operation approval と standing authorization の関係は explicit contract decision を要する（M5 per-operation approval vs standing authorization needs explicit contract decision）。
- Autonomous lifecycle は bounded remind maintenance（R14–R18）より広く、現行 R14–R18・I01–I05・C16–C22 の scope を拡大しない。
- Task manager と pi-orch integration は acceptance が不在（absent acceptance needed）。
- 既存 milestones／requirements／implementation order を保全する。本節は Phase 0–5・gate・判断待ちを変更しない。
- 詳細 cross-reference と未実装 planning items は [tasks 側の自律構想記録](active_projects_tasks.md#autonomous-vision-tasks)を参照。本節と tasks 側の両方が design-only であり、[execution_progress 索引](execution_progress_2026-10-10.md)の証拠扱いを変更しない。

## 現況追記（2026-10-15、履歴保持・上記分類は書き換えない）
- Companion explicit memory management 実装＋検証済み（I02/I03/I04 の管理面の完成、I01 正式採用判断・Windows manual・現行 CI は未完維持）: (1) native `memory.search` は明示検索のみ・active＋retired を opaque `mN` で返し heat/reactivate/feedback なし（immutable snapshot `memory_searches/items`）。(2) confirm UI は live current と immutable citation snapshot を対比してから mutation を stage。(3) `record.correct` は REAL source `event.append`＋`record.correct` の durable chain（安定冪等キー、同一 key+body は stored operation replay、key+drift body は 409）。(4) `record.retire`/`record.reactivate` は可逆引退であり削除/非表示ではない（retired は検索可・CLI recall のみ除外）。UI race は同期的 search/target invalidation＋generation guard、新 operation の pending reset＋poll identity、stale ack 非再利用で閉鎖。7 integrity edges（ambiguous refusal・atomic op/outbox/followup・replay-first・terminal failure・cancellation）は単体回帰で cover。証拠: full Vitest 113 files/1370 tests passed、real-browser memory spec GREEN、live HTTP/real-CLI GREEN、root＋e2e tsc exit 0、lint GREEN（gateway は synthetic であり real-model ではない）。perception/export/deletion は未実装維持。

## 現況追記（2026-10-16、AV autonomy foundationのみ・履歴保持・上記分類/ID/件数不変）
- AV01 purpose + AV03 task + persist/stop の foundation のみ実装（全AVの完成は主張しない）: session-owned purposes（create/correct=新record追加+原文superseded保持/revoke/achieve/explicit pair conflictのみ、same-kind自動conflictなし）＋ explicit tasks（standalone/attached、start/hold/resumeはevidence必須+explicit replacement parentのみ、blind resume 409、parent revoke/correct/achieveは非terminal依存をheld化、permissionは主張のみで何も付与しない）＋ durable global stop control（CAS version、default paused、restart fenceがresumedをversion+1でre-pauseし`restart_fence`記録）。consumer UI境界4件を永久回帰 `autonomy.spec.ts` 4/4（statement-only訂正のkind/scope/interpretation/window保持、explicit新parent resume、selection切替のdraft同期clear+late GET破棄（purpose+task）、backend mutation+refresh後のstale draft無効化（purpose+task））＋ full default e2e 28 passed（oc53/54 GREEN、再実行なし）＋ `autonomy_http` 3/3・`autonomy_slice` 11/11。no-runtime-permission（実OAuth/Google/secret DB/device/user listener/runtime grant/Calendar書込なし）。残件（未着手扱い）: AV02 shadow、AV04 learning、AV05 notify、AV06 priority、AV07 supervisor/reconcile、AV08 maintenance/handoff。詳細は `docs/operations.md`（AV autonomy foundation）。

## 現況追記（2026-10-17、AV02 shadow-deliberation完成・履歴保持・上記分類/ID/件数不変）
- AV02 shadow-deliberation の full vertical（kernel durable core＋model-gated service＋read-only HTTP＋consumer UI）を実装・公開（全AV完成は主張しない）: model提案は決して実行権限にならない（CODE判定 `missing_grant`、claim有無に関わらずgrant付与なし、zero executions）。scope purposes/tasks は repository getter 経由の read-only（Markdown/memory connectorなし）、memory recall は UNTRUSTED evidence・1 job 1 bounded call（native `autonomy_deliberation.submit`、ONE dot）。persistent queue＋input-complete fence（foreground は shadow 自身の call のみ abort）＋STOP global hold＋restart fence（catchup/replayなし）。UI `ShadowPanel` は latest-intent list/detail・hidden外の stable retry・XSS inert（textContent）・STOP-held background が composer を保全。証拠: full Vitest 136 files/1557 passed（8 skipped、real remind CLI、LLM/vectors無効）＋ full default browser 32 passed（28＋新規shadow 4）＋既往 production smoke 17/17（synthetic loopback、real modelではない）＋ root/e2e tsc exit 0＋root Biome exit 0。no-runtime-permission（実model/GPU性能/Google書込・OAuth・user DB・device・grantなし）。残件: AV05 notifications、AV06 shared resources、AV07 external supervisor/recovery、AV04 methods learning、AV03 conversation task-proposals＋actual pi-orch handoff、AV08 maintenance、未解決 device/standing/external rollout。詳細は `docs/operations.md`（AV02 FULL VERTICAL）。

## 現況追記（2026-10-17、schema12 AUTONOMY TRIAL AUTHORITY スライス・履歴保持・上記分類は書き換えない）
- Root ベースライン fb4e174（M6f61aca 上）上に schema12 trial authority ドメインを実装＋実証済み。server/UI/bridge は本スライス対象外で未配線のまま残す。
- 契約: `packages/contracts/src/trial_authority.ts` 新規（closed operation 4 種、ConstraintRule deny_workspace/deny_operation/deny_write_path、proposal/grant/launch-request/profile snapshot schemas、read-only ops investigate|verify）。`autonomy.ts` に optional `constraintRule` を追加（create は present 時のみ hash、correct は undefined=preserve/null=clear/object=set、view は nullable・旧 cached DTO は default null で読める）。
- Kernel: `packages/kernel/src/trial_authority.ts` 新規 leaf（autonomy 非依存で循環回避）。AUTHORITY は owned kind=task 非 held/非 terminal＋同 scope active/applicable 親 goal（sourceKind=user・explicit=true）のみ。conflict 巻込 goal は HOLD、非構造制約は HOLD、deny ルールは literal prefix の ancestor+descendant のみ block（`src` は `src2` を塞がない、`.` は全体、glob 解釈なし）。investigate/verify は read_only のみ。1 承認で 1 grant＋execution UUID（UNIQUE proposal_id で二重承認防止）。claim は grant 消費＋不変 frozen request/launch intent を provider 前に原子永続、再 claim は discriminated replay。hash は taskHash 除く全 field＋execId を real node:crypto で決定論的 hash。STOP は claimed のみ revoke（queued は生存、claim は fresh resume 必須）。goal/task/correction/conflict/status/reparent/constraint/control の既存 TX 内で invalidation（queued revoke＋claimed cancelRequested、無関係 scope/alias は継続、revive なし）。unknown execution は alias fence。GET は expiry 書込なし。
- Migration 0012（`trial_constraint_rules`/`trial_proposals`/`trial_grants`、STRICT、既存表無改変）＋journal idx11 v12＋BUNDLED 12。schema.ts・facade（stage/list/approve/claim/expire/fence/hash）・index exports を mirror。
- 証拠: kernel tsc exit 0、新規 `trial_authority.test.ts` 4 件 PASS（one-use/double-approve/replay・goal 由来拒否・deny/unstructured・queued 生存 vs claimed revoke・goal revoke 無効化・fence・corrupt fail-closed・literal prefix・無関係 alias 素通り）、既存 `autonomy_slice` 15＋`migration` 21 PASS（bundled bump に伴う `[11]`→`[11,12]` の pin 更新 1 件のみ）。実 file-DB（private temp、実行後削除）での throwaway API smoke: goal/task/stage/approve/claim/replay/Stop/Resume/revoke 阻止/新 parent resume/restage を観測、durable grant 消費を確認、`action_*`/calendar/memory 系 table は全 0 件で production 無改変。残 service 統合（scope observer/launch gate/worker outcome の trusted 配線）は次段の責務として未着手。

## 現況追記（2026-10-17、autonomy trial E2E・履歴保持・上記分類は書き換えない）
- 自律 trial 実行系（schema12＋server/runner/relay＋Own-pi bridge）を実装＋合成モデルで E2E 検証済み。証拠: `.all-plan-progress/AV-E2E-RESULTS.json`（run7: A consumed/authorized/bridge-exit:0・12 calls 全 fixed-model・token cap 内・unit 消滅・Task open/Goal active/git clean、B STOP revoked/unauthorized/bridge-exit:143・unit 消滅）、`.all-plan-progress/AV-SERVER-TRIAL-RESULTS.json`・`AV-RUNNER-RESULTS.json`・`AV-RELAY-RESULTS.json`・`AV-AUTHORITY-RESULTS.json` 等。throwaway `.e2e-trial/` は削除済み。運用面は `docs/operations.md`「Autonomous trial execution (opt-in)」に記録。未採用・未完残: real model・hardware・resource caps 未選定、real（非 synthetic）model run 未実施、Own-pi 側変更 uncommitted、Remind ops/graph は done・commits pending。

## 現況追記（2026-10-17、AV03 conversation-proposals完成・履歴保持・上記分類/ID/件数不変）
- AV03 full vertical（kernel＋HTTP＋UI、feat/av-conversation-proposals）: proposal-only core＋session review/adopt routes＋quiet drawer UI。統合受入ONCE実測: full Vitest 143 files passed/2 skipped・1606 tests passed/8 skipped（real remind CLI、LLM/vectors無効）＋default Chromium 42 passed＋root/e2e tsc exit 0＋Biome exit 0（既存warning/infoのみ）。PR未発行・review findings pending。詳細は `docs/operations.md`（AV03 FULL VERTICAL）。

## 決定追記（2026-10-18、AV-01..10 方針合意・decider haruka・既存ラベル/ID/件数不変）
- AV-01..10 の方針合意を記録（詳細全文は [decision_inputs_2026-10-18.md](decision_inputs_2026-10-18.md)）。ポリシー合意であり POLICY ≠ 実装・権限（この合意だけでは実装も runtime 権限も付与されない）。修正を含む主な内容: AV-02 常時稼働許容、AV-06 準拠、proposals-only／shadow eval は維持、AV-04 目標変更は根拠付き提案義務（沈黙は承認でない）、AV-10 は都度承認から standing 目標へ、AV-03 boundary 対象は standing でも個別チェック。なお AV-03 permission および AV-09 除外/削除等は UNRESOLVED のまま維持。
