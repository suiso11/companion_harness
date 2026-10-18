# procedures_2026-10-18（手順書案 PROPOSAL）

- 状態: **PROPOSAL（案）**。本書は haruka の 2026-10-18 決定（`decision_inputs_2026-10-18.md`、決定者 haruka・日付 2026-10-18）を受けて作成した**手順の草案**であり、採用（adoption）ではない。いかなる gate も閉じない。live 実行は行っていない。数値・モデル名等の新規発明はしない。未確定は「未決」と明記する。
- 決定出典: `/home/molmot/companion_harness/.c12-calendar/ledger-wt/docs/plan/decision_inputs_2026-10-18.md`（C08: 162–172、C10-08: 174–183、C11-01: 185–194、C11-07: 196–205、C15: 207–216、M5: 218–227、D1: 233–242、D2: 244–253）。本書は正本ではなく、各台帳への正式反映は別途追記で行う（同書 4 行目・538 行目参照）。
- 証拠出典の行番号は本ブランチ（`origin/master`）時点のものである。
- 関連範囲: C08–C22（`docs/plan/active_projects_tasks.md:372–382, 408–418, 548–560`）。

## 1. C08 段階的採用計画（案：順序は提案であり決定ではない）

- 根拠: 決定 `decision_inputs_2026-10-18.md:162–172`（1) 段階的採用、具体的な段階・順序は別途）／現状 HOLD `docs/operations.md:2360`（C08 upstream adoption **HOLD / NOT ADOPTED**）／protocol evidence のみ DONE `docs/plan/active_projects_tasks.md:372–374`。
- 前提/依存: C10-08（production mapping、決定 174–183、B2 と連動）、C11-01 の schema 合意（決定 185–194）。B2 の修正（ms より細かい入力の書込前拒否、決定 110–120）は C10-08 再判定の前提。
- 手順（番号は**提案順序**であり、決定は「段階・順序は別途」なので順序自体が未決）:
  1. protocol evidence の再確認: `docs/plan/active_projects_tasks.md:375–379`（C08-01–05）の既存 evidence が現 HEAD でも有効か確認する（再実行はしない、棚卸しのみ）。
  2. pin/identity の特定: exact full commit・server identity・runtime version を一次 evidence で確定できるか調べる（同 376–377、C08-02–03）。pin 形態の選択は C08-06（同 380）の決定事項であり本書では選ばない。
  3. profile の採用判断: host-owned profile 形態（現行 `google-readonly` の前例 `docs/operations.md:1005–1017`）を C08 正式採用の器として使うか判断する。判断自体は本書の範囲外（未決）。
  4. registration の採用判断: production registration の有無を C09 enablement HOLD（`docs/operations.md:2361`）と整合させて判断する（未決）。
  5. C10-08 再判定: B2 修正（sub-ms 拒否）適用後に gap（`docs/operations.md:557–562` の whole-second regex vs fractional-ISO）が解消した証拠をもって採用判定を行う（決定 180）。
  6. live 判定: 上記 1–5 の全 gate が閉じた後に限り live 接続の可否を判断する。live 実行自体は本書の範囲外。
- 各段階の gate（提案）: 各段階は「証拠の台帳記録」を通過条件とし、前段階の gate が閉じるまで次段階の判断を行わない。gate を閉じるのは本書ではなく正式な台帳追記である。
- 記録する証拠: 各段階の判断内容・決定者・日付・証拠リンク（decision_inputs の記入ルール 9–12 行に準拠）。
- 完了条件: 段階・順序の正式決定が台帳に追記されること。本書の作成は完了条件ではない。
- 未決事項: 具体的な段階・順序（決定により別途）。pin 形態（C08-06）。profile/registration を採用の器とするか。

## 2. C11-01 positive-evidence schema 案（合意用ドラフト）

- 根拠: 決定 `decision_inputs_2026-10-18.md:185–194`（1) schema を先に合意）／現状 BLOCKED `docs/operations.md:665`（No adopted operation-specific POSITIVE tombstone evidence）／positive-proof 前提 `docs/operations.md:674–682`／既存 negative 回帰 `docs/operations.md:636–663`（`deletion-boundary.test.ts` 6 不変条件）／`get` に `showDeleted` は存在しない `docs/operations.md:680–681`、spike `docs/m4_dependency_spike.md:141,541`／design P6 `docs/google_calendar_readonly_binding_design.md:201`。
- 前提/依存: C08 採用と並行可（決定 191）。C11-07 の前提となる（決定 C11-07 依存先 C11-01）。
- 手順:
  1. schema 草案の必須欄を `docs/operations.md:671` の記録形式から起こす：source kind（static candidate / retained inert provider / new synthetic SDK wire）、immutable archive/candidate refs、operation、request field NAMES（raw ID・cursor・query・email・error body を含めない）、observed MCP envelope、fixed consumer error。
  2. operation-specific 欄を追加する（案）：対象 operation 名（例 `get-event`）、exact target（connector / calendar / event の特定方法。caller 申告の `priorKnown` boolean は不可、`docs/operations.md:676–677`）、recurrence 区別（`docs/operations.md:678`）。
  3. 「positive と認めないもの」欄を明記する（案）：search omission、list `showDeleted`、`cancelled`、bare 404/410（`docs/operations.md:679–680`）。`get` の `showDeleted` は存在しないため発明しない（同 680–681）。
  4. 上記 1–3 を合意文書として提示し、合意は台帳追記で行う。本書では合意しない。
- 記録する証拠: 草案本文・合意者・日付。合意前の観測値は positive 証拠として扱わない。
- 完了条件: schema の合意が正式な台帳に追記されること。
- 未決事項: schema の正式内容（本書は合意用ドラフトであり採用ではない）。C11-05 の C12 配線（`docs/operations.md:663` 行 C11-05 PARTIAL）は本 schema の範囲外。

## 3. C11-07 実 HTTP status 観測手順（runtime logger 追加なし）

- 根拠: 決定 `decision_inputs_2026-10-18.md:196–205`（1) 観測手順を別途設計、runtime logger は追加しない、C11-01 合意後に着手）／現状 `docs/operations.md:671–672,681–682`（HTTP status UNKNOWN、positive / real HTTP status は BLOCKED のまま）。
- 前提/依存: **C11-01 の schema 合意後に着手する**（決定 202）。着手前は本手順を実施しない。
- 手順:
  1. C11-01 合意済み schema の記録形式（上記 §2 の手順 1）に従い、観測計画書だけを先に書く（対象 operation・target・request field NAMES の列挙。raw 値を含めない）。
  2. 実 provider 観測は C11-01 合意の operation・target の範囲でのみ行う。runtime logger / telemetry / status-diagnostic channel の追加はしない（`docs/operations.md:671`）。error privacy を弱めない。
  3. 観測した MCP envelope と fixed consumer error を記録する。synthetic 404/410 marker は provider HTTP 証拠としない（`docs/operations.md:671–672`）。
  4. 実際の HTTP status が取得できない場合は UNKNOWN のまま残し、欠測を成功と読み替えない。
- 記録する証拠: source kind、immutable refs、operation、request field NAMES、observed MCP envelope、fixed consumer error（`docs/operations.md:671` の形式）。token・raw ID・個人情報を含めない。
- 完了条件: C11-07 の観測記録が台帳に追記され、HTTP status の扱い（UNKNOWN 継続／確定）が明示されること。
- 未決事項: 観測対象の具体的な operation・target（C11-01 合意待ち）。logger なしで HTTP status を取得できる手段の有無（手段がなければ UNKNOWN 維持）。

## 4. C15 同意画面 scope 表示・Fresh OAuth（testing-mode re-consent 含む）観測手順

- 根拠: 決定 `decision_inputs_2026-10-18.md:207–216`（1) 観測手順を計画、実アカウントで同意画面の scope 表示と testing-mode re-consent を含む Fresh OAuth flow を確認）／現状 `docs/operations.md:2369`（Fresh OAuth **SEPARATE DECISION, untouched**）／live ledger `docs/operations.md:2820–2916`（OAuth COMPLETED・live read OBSERVED、fresh consent-screen scope display のみ unobserved、force reconsent なし）／design §4 七項目 `docs/google_calendar_readonly_binding_design.md:304–342`／準備・実行手順 `docs/operations.md:1150–1221`。
- 前提/依存: C08、readonly binding design（決定 211）。実施者は**ユーザー本人・実アカウント**で行う（本 worker は OAuth・live RPC を行わない）。
- 手順:
  1. Google Cloud 側準備（ユーザー操作、repo 外）：自プロジェクトで Calendar API 有効化、OAuth 同意画面を user type External・publishing status Testing とし自アカウントを test user に追加、Desktop app の OAuth client ID を作成し JSON を取得する（手順詳細は `docs/operations.md:1150–1160` 付近の公式ガイド参照先に従う）。"Web application"（top "web"）は fork が受け付けないため使わない。
  2. 同意画面の表示確認：ブラウザで consent を開き、表示 scope テキストが `calendar.events.readonly` のみであることを目視する。force reconsent はしない（ledger `docs/operations.md:2849–2852` の方針）。
  3. testing-mode re-consent 確認：Testing 方式では grant が期限切れし再同意が必要になる旨（`docs/operations.md:1153–1155`）を踏まえ、再同意画面でも scope 表示が変わらないことを目視する。
  4. 記録は scope テキストのスクリーンショット・表示文言の転記のみとし、token・client secret・raw event・個人情報を保存しない（stderr/log 無 token 方針：ledger 七項目 7、`docs/operations.md:2858–2860`）。
  5. 観測後の revoke：Google アカウントのサードパーティーアクセス管理から当該 grant を取り消し、取り消し済みであることを記録する（revoke の具体 UI 手順は未決。少なくとも grant 残置をしない）。
- 記録する証拠: scope 表示のスクリーンショット（token 等が写らない範囲）、日時、実施者、revoke 済みの記録。token・secret・生イベントを含めない。
- 完了条件: scope 表示（初回＋re-consent 時）の観測記録が台帳に追記され、unobserved 項目が解消／継続のいずれか明示されること。
- 未決事項: revoke の具体 UI 手順。re-consent の期限切れ誘発を待つか否か（待つ場合は時期未定のため未決）。

## 5. D1 Windows 11 x64 manual smoke 手順書

- 根拠: 決定 `decision_inputs_2026-10-18.md:233–242`（1) 手順書を作って実施、Remind 側の Windows manual 確認もあわせて行う）／現状 `docs/operations.md:2368`（Windows 11 x64 manual smoke **NOT EXECUTED**、§19.6 support gate）／`docs/operations.md:343`（Windows manual smoke remains open）／§19 source-run 受入 `docs/operations.md:2284–2415`。
- 前提/依存: A3（merge 後 HEAD での CI 再観測、決定 82–92）。本手順は Linux CI の代替にならない（G02-11：`docs/plan/active_projects_tasks.md` G02-11 行。CI だけで代用不可）。
- 手順（Companion、Windows 11 x64 実機、専用 temp store）:
  1. `pnpm install`（README `README.md:1262`）で依存を揃える。install・lock 更新・browser download は別承認なしに行わない（G02-03）。
  2. `pnpm test`（`README.md:1268`）、`pnpm typecheck`（`README.md:1269`）を個別に実行し、各 check 名・commit・結果を記録する。`pnpm start`（`README.md:1275`）で cold start し、`GET /health/live`・`GET /health/ready` の 200 を確認する（§19 source-run の Linux 前例 `README.md:1649` と同項目を Windows で再観測する）。
  3. backup/restore の §19 項目（`docs/operations.md:2289–2330` の 7/7 documented steps 相当）を temp store で実施し、basename・0600・`quick_check`・atomic rename を確認する。
  4. 結果は Linux 証拠と区別して記録し、Windows 固有の差異（chmod 保証なし `docs/operations.md:55`、PowerShell 差異 `docs/operations.md:1217–1221`：`export X=...` は `$env:X=...`）を明記する。
- 手順（Remind、同一 Windows 実機、/home/molmot/remind/README.md 読取り専用参照）:
  1. `npm run build`（remind README 34 行）で build する。
  2. `npm test`（同 92 行：build + 全テスト）を実行する。
  3. CLI JSON line round-trip（同 11–12 行・37–40 行）：1 行 JSON 入力→1 行 JSON 出力・終了コード `0` の形式で `event.append`→`record.remember`→`record.recall` の往復を行う（例コマンドは同 README 37–40 行のとおり。config は git 管理対象外、同 30 行）。
  4. `npm run eval:operations`（同 99 行・127 行：一時 DB・実 CLI のみ）を実行する。
- 記録する証拠: 実施環境（OS・Node/npm/pnpm 実測 version）、各コマンドの exit code・件数・日時、temp store の後片付け記録。ユーザーデータ・秘密情報を含めない。
- 完了条件: Companion §19.6 項目＋Remind 上記 4 項目の観測記録が台帳に追記されること。
- 未決事項: 実施者・実施日（決定は「手順書を作って実施」まで。誰が・いつ実施するかは未決）。

## 6. M5 validation sequence（B3/B5・A3・C22 経由の live 許可判断）

- 根拠: 決定 `decision_inputs_2026-10-18.md:218–227`（2) live 許可は validation 後。B3・B5 修正、A3 CI 再観測、C22 再実行を通った後に判断。binding は B3 修正後に derivePort 方式。承認方式は AV-10 参照）／現状 `docs/operations.md:2366–2367`（No production write binding selected、triple-gate live use NOT authorized、C22 fake 13/13 at `61b3573`）／triple gate `docs/operations.md:1395–1413`・`docs/implementation_plan.md:1560–1563`／derivePort `docs/operations.md:1392`／現況検証 `docs/plan/active_projects_tasks.md:19`（B1–B5 の master 修正済み状態）。
- 前提/依存: B3（derivePort 呼出条件を binding 有無に、決定 122–132）、B5（structuredContent 優先、決定 146–156、合意 `docs/implementation_plan.md:1282–1283`）、A3（merge 後 HEAD で CI 再観測、決定 82–92）、C22（fake E2E、タスク `docs/plan/active_projects_tasks.md:548–560`）。
- 手順:
  1. B3・B5 の修正状態を確認する（`docs/plan/active_projects_tasks.md:19` の修正済み記録を起点に、対象 HEAD での有効性を再確認する。再実行の要否は A3/C22 の結果と合わせて判断する）。
  2. A3：push 後の merge HEAD で CI（windows/ubuntu × check/e2e）を再観測する。過去 CI（例 `56b7952a` の 23/23、`docs/operations.md:2332` 付近・`docs/plan/active_projects_tasks.md:362`）を現 HEAD の pass として扱わない。
  3. C22 を再実行する（前回 `61b3573` で 13/13 fake、`docs/operations.md:2367`。live ではない）。fake 範囲を超えない。
  4. 上記 1–3 が通った後に live 許可を判断する。判断は本書では行わない（未決）。binding 選定は derivePort 方式（B3 修正後）で行う。
  5. 承認方式（都度 vs standing）は AV-10 を参照する（決定 224、AV-10：最終的に standing を目指しそれまでは都度承認。standing でも AV-03 境界対象は個別チェック維持）。
- 記録する証拠: 各段階の commit・check 名・結果・日時。live 許可の判断内容・決定者・日付（判断時に記録）。
- 完了条件: live 許可の判断（許可／不許可）が正式な台帳に追記されること。本手順書の存在は完了条件ではない。
- 未決事項: live 許可の判断自体。B3/B5・A3・C22 の再実行結果（本書作成時点では未実施）。standing 承認の具体契約（AV-10 残課題）。

## D2 注記：standalone startServer smoke の受入組込み

- 根拠: 決定 `decision_inputs_2026-10-18.md:244–253`（1) 受入に含める。B3・B4 の起動処理修正を本物の `startServer` で確認するため）／PR20 T5 記録 `docs/operations.md:2110–2116`（still-pending T3/T4 standalone actual-`startServer` smoke）／D2 対応記録 `docs/operations.md:4168–4180`（`startup_smoke.test.ts` の T3/T4：disabled 構成で 0 capability reads / 0 closes、enabled owned port で derivePort exactly once・close exactly once）。
- 前提/依存: B3・B4 の起動処理修正。C12 受入、C13–C15 suite（決定 248）。
- 手順: `apps/server/test/startup_smoke.test.ts` の T3/T4 を受入に含め、disabled/enabled 両構成の `GET /health/ready` 200・capability read/close 回数を記録する。重複する rescheduleWriteStartup full-pipeline B3 case 等は再利用し二重計上しない（`docs/operations.md:4180` 付近の not-duplicated 方針）。
- 記録する証拠: T3/T4 の実行結果（ready 200、read/close 回数、derivePort 呼出回数）。
- 完了条件: T3/T4 smoke の受入組込みが台帳に追記されること。
- 未決事項: `#55` の証拠は引用指定の docs（operations.md / implementation_plan.md / m4_dependency_spike.md / binding design / active_projects_tasks.md C08–C22）中に見当たらなかったため、本書では `#55` 起源の特定を未決とする。該当 PR/issue 番号の特定は別途確認が必要。
