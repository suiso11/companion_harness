# decision_inputs_2026-10-18

- 日付: 2026-10-18
- 目的: 残存タスクの判断・確認待ち事項を一時集約する記入テンプレート。**記入しても gate を閉じず、候補を合意仕様に昇格させない。正式反映は各台帳（operations.md / active_projects_plan.md / active_projects_tasks.md / implementation_plan.md / remind plan）へ別途追記で行う。**
- 参照: `docs/plan/active_projects_tasks.md:17-18`（2026-10-18 現況追記）、`docs/operations.md`「Remind I01–I05」行の 2026-10-18 supersede 追記（boundary セル）。
- 本書は正本ではない。未記入の項は「未決」として扱う。
- 追記（2026-10-18）: haruka による項目別確認を反映。既存記入は書き換えず、「追記（2026-10-18 確認）」として追加。

## 記入ルール
- 回答は **決定 / 保留 / 棄却 / 要追加調査** のいずれか ＋ 内容で記入する。
- **決定者・日付・根拠は必須。**
- 既存記入は書き換えず追記する。未記入欄は空のまま残す。

## 項目ブロック共通書式（全項目共通）
- 質問 /
- 背景・根拠（file:line） /
- 選択肢 /
- 依存・影響先 /
- 回答 checkboxes（□ 決定 / □ 保留 / □ 棄却 / □ 要追加調査） /
- 内容（空欄） /
- 決定者（空欄） /
- 日付（空欄） /
- 証拠・リンク（空欄）

## 確認結果サマリ（追記 2026-10-18）

| 項目 | 回答 | 内容（要約） |
| --- | --- | --- |
| A1 | 決定 | 1) push 許可 |
| A2 | 決定 | 3) 保持。A1 push・B5 取込後に破棄 |
| A3 | 決定 | 2) merge 後の HEAD で再観測 |
| B1 | 決定 | 1) SDK 継承変数を snapshot で明示上書き |
| B2 | 決定 | 1) ms より細かい入力を書込前に拒否（原記入 2 から変更） |
| B3 | 決定 | 1) derivePort 呼出条件を binding 有無に変更 |
| B4 | 決定 | 1) 早期 preflight で常時長さ検証 |
| B5 | 決定 | 1) structuredContent 優先に修正（原記入 2 から変更） |
| C08 | 決定 | 1) 段階的採用（段階・順序は別途） |
| C10-08 | 決定 | 1) gap 修正後に採用判定 |
| C11-01 | 決定 | 1) positive-evidence schema を先に合意 |
| C11-07 | 決定 | 1) 観測手順を別途設計（logger 追加なし） |
| C15 | 決定 | 1) 実アカウントでの観測手順を計画 |
| M5 | 決定 | 2) live 許可は validation 後 |
| D1 | 決定 | 1) 手順書を作って実施 |
| D2 | 決定 | 1) 受入に含める |
| R09 | 決定 | 1) 候補から絞込・ローカルのみ・依存追加承認 |
| R13 | 決定 | 1) seeded 評価方針を合意 |
| R14 | 決定 | 1) 方針を合意 |
| F-I01-01〜08 | 決定 | すべて採用 |
| F-I04-01〜06 | 決定 | 採用（I04-01 は修正つき） |
| F-I04-07 | 要追加調査 | ReferenceManager API/tests の確認 |
| F-I04-08 | 決定 | 1) 先行記録 |
| AV-01〜10 | 決定 | 方針合意（AV-02・AV-04・AV-10 は修正つき） |

---

## A 運用統合

### A1 PR41 merge `8357a6e` push 可否
- 質問: PR41 merge 作業コミット `8357a6e`（merge master into feat/av-autonomy-purpose-task-control、not pushed）を push して良いか。
- 背景・根拠: `.c12-calendar/delivery-c22/.all-plan-progress/PR41-MERGE-PROGRESS.md:3-4,100-104`（merge commit は `8357a6e`。※当初予定にあった `835a6e6` は誤記と確認済み）
- 選択肢: 1) push 許可 2) push 保留 3) 破棄・やり直し
- 依存・影響先: A2、A3
- 回答 checkboxes: ☑ 決定 / □ 保留 / □ 棄却 / □ 要追加調査
- 内容:1
  - 追記（2026-10-18 確認）: 1) push 許可。
- 決定者:haruka
- 日付: 2026-10-18
- 証拠・リンク: 2026-10-18 項目別確認

### A2 作業コピー `.c12-calendar/delivery-c22` と `.codexfix/41` の取扱
- 質問: 作業コピーを取込 / 破棄 / 保持のどれにするか。
- 背景・根拠: `.c12-calendar/delivery-c22/`（`.codexfix/41` は PR41 merge 作業ツリー）、`.c12-calendar/delivery-c22/.all-plan-progress/PR41-MERGE-PROGRESS.md`
- 選択肢: 1) 取込 2) 破棄 3) 保持
- 依存・影響先: A1、B5
- 回答 checkboxes: ☑ 決定 / □ 保留 / □ 棄却 / □ 要追加調査
- 内容:必要？
  - 追記（2026-10-18 確認）: 3) 保持。B5 の修正対象（`createWrite.ts` / `rescheduleWrite.ts`）が本作業コピー内にあるため。A1 の push と B5 の修正取込の完了後に破棄する。
- 決定者:haruka
- 日付: 2026-10-18
- 証拠・リンク: 2026-10-18 項目別確認

### A3 現 HEAD CI 23/23 再観測
- 質問: 現 HEAD での CI 23/23 再観測をいつ・どの commit で行うか。
- 背景・根拠: `docs/operations.md:2332`（23/23 browser CI aggregate は `56b7952a` に pin、not re-asserted for this HEAD）
- 選択肢: 1) 直ちに現 HEAD で再観測 2) merge 後の HEAD で実施 3) 保留
- 依存・影響先: A1/A2
- 回答 checkboxes: ☑ 決定 / □ 保留 / □ 棄却 / □ 要追加調査
- 内容:2
  - 追記（2026-10-18 確認）: 2) merge 後の HEAD（A1 push 後の HEAD）で実施。
- 決定者:haruka
- 日付: 2026-10-18
- 証拠・リンク: 2026-10-18 項目別確認

---

## B 未解決 PR レビュー 5件（出典: `.c12-calendar/threads.json`、comment databaseId は原本参照）

### B1 PRRT_kwDOUNdW7s6tFZWr — SDK env 再継承
- 質問: SDK `StdioClientTransport` が process.env 側から default 環境変数を再継承する問題（frozen snapshot から欠けた SDK-default 変数が実効 child env に残る）を防ぐ修正を採るか。
- 背景・根拠: `packages/connector-mcp/src/client.ts:1050-1075`（stdio fail-closed env 取込み・assertStdioEnvClosed）
- 選択肢: 1) snapshot から全 SDK-inherited 名を明示上書き 2) allowlisted 継承値が欠ける snapshot を拒否 3) 修正なし（review 指摘を棄却）
- 依存・影響先: C09 stdio bounds 契約
- 回答 checkboxes: ☑ 決定 / □ 保留 / □ 棄却 / □ 要追加調査
- 内容:1
  - 追記（2026-10-18 確認）: 1) snapshot から SDK 既定の継承変数名をすべて明示上書きする。
- 決定者:haruka
- 日付: 2026-10-18
- 証拠・リンク: 2026-10-18 項目別確認

### B2 PRRT_kwDOUNdW7s6tFZWt — 小数精度切捨て
- 質問: readback instants 比較で 4 桁以上の fractional（例 `.1234Z`→`.123Z`）が切り捨てられ verified succeeded 受取になりうる精度問題の処理方針（書込前の精度拒否 or 完全 fractional 比較）。
- 背景・根拠: `packages/kernel/src/action_strategy.ts:460-499`（readback 観測と boundariesMatch）；`packages/connector-calendar/src/normalize.ts`（ms 精度出力）；C10-08 fractional-ISO 関連
- 選択肢: 1) ms より細かい入力を書込前に拒否 2) 完全 fractional 値で比較 3) 棄却・現状許容
- 依存・影響先: C10-08、B4 前提整理
- 回答 checkboxes: ☑ 決定 / □ 保留 / □ 棄却 / □ 要追加調査
- 内容:2
  - 追記（2026-10-18 確認）: 1) に変更。ms より細かい入力を書込前に拒否する。理由: provider が ms 精度までしか保持しない場合、2) では 4 桁以上の入力が常に不一致（失敗）判定となるため。
- 決定者:haruka
- 日付: 2026-10-18
- 証拠・リンク: 2026-10-18 項目別確認

### B3 PRRT_kwDOUNdW7s6tFZWw — 注入 binding で derivePort 未呼出
- 質問: 注入 calendarBinding 構成（`calendarConfig === null`）で actionWriteBinding の derivePort が必要条件の足し合わらずに起動失敗する問題を、呼出条件の修正か、注入 binding × derivePort 組合せの不支持明示かで処理するか。
- 背景・根拠: `apps/server/src/bootstrap.ts:955-990`（derivePort は `calendarConfig !== null` 時のみ呼出）
- 選択肢: 1) derivePort 呼出条件を kernelCalendarBinding 有無に変更 2) 組合せを明示 unsupported に 3) 棄却
- 依存・影響先: M5 write binding 選定（C セクション）
- 回答 checkboxes: ☑ 決定 / □ 保留 / □ 棄却 / □ 要追加調査
- 内容:1
  - 追記（2026-10-18 確認）: 1) derivePort の呼出条件を kernelCalendarBinding の有無（注入・設定のどちらでも）に変更する。
- 決定者:haruka
- 日付: 2026-10-18
- 証拠・リンク: 2026-10-18 項目別確認

### B4 PRRT_kwDOUNdW7s6tFZW0 — write identity 長さ検証を DB 作成前に
- 質問: writeTestIdentity の server name 128 字 / version 64 字超の検証を、transport factory 入力の有無に関係なく DB 創生・migration・connector 登録前に強制するか。
- 背景・根拠: `apps/server/src/bootstrap.ts:630-634`（DB 副作用前の同期 preflight block）、`826-840`（binding/port 組立時の fail-closed関連）
- 選択肢: 1) 早期 preflight に恒常的に長さ検証追加 2) 呼出側 config でのみ検証 3) 棄却
- 依存・影響先: startup 契約・ServerConfigError メッセージ
- 回答 checkboxes: ☑ 決定 / □ 保留 / □ 棄却 / □ 要追加調査
- 内容:これやったらどうなるかわかりづらい、やってもいい
  - 追記（2026-10-18 確認）: 1) 早期 preflight で常に長さを検証する。不正な設定は DB 作成等の副作用なしに `ServerConfigError` で起動失敗となる。transport factory 未指定でも長さ超過なら起動失敗になる挙動変更を許容する。
- 決定者:haruka
- 日付: 2026-10-18
- 証拠・リンク: 2026-10-18 項目別確認

### B5 PRRT_kwDOUNdW7s6tFZW4 — structuredContent 優先の未適用
- 質問: write outcome 分類で `call.text` fallback のみを見て structuredContent を無視する現状を、implementation_plan 合意（structuredContent 優先）に沿うよう修正するか。
- 背景・根拠: `.c12-calendar/delivery-c22/packages/connector-calendar/src/createWrite.ts:296-300`、`rescheduleWrite.ts:408-412`；契約: `docs/implementation_plan.md:1282-1283`
- 選択肢: 1) structuredContent 優先に修正 2) 契約側を緩和・書換 3) 棄却
- 依存・影響先: A2 作業コピー取扱
- 回答 checkboxes: ☑ 決定 / □ 保留 / □ 棄却 / □ 要追加調査
- 内容:2
  - 追記（2026-10-18 確認）: 1) に変更。structuredContent 優先に修正し、implementation_plan の合意に合わせる。修正は A2 で保持した作業コピー上で行う。
- 決定者:haruka
- 日付: 2026-10-18
- 証拠・リンク: 2026-10-18 項目別確認

---

## C Calendar

### C08 upstream adoption
- 質問: C08 の正式採用（binding/pin/profile/registration）をどう段階で進めるか（現状 HOLD / NOT ADOPTED）。
- 背景・根拠: `docs/operations.md:2333`
- 選択肢: 1) 段階的採用を計画 2) HOLD 継続・条件明記 3) 棄却
- 依存・影響先: C10-08（production mapping）
- 回答 checkboxes: ☑ 決定 / □ 保留 / □ 棄却 / □ 要追加調査
- 内容:1
  - 追記（2026-10-18 確認）: 1) 段階的採用を計画する。具体的な段階・順序は別途決める。
- 決定者:haruka
- 日付: 2026-10-18
- 証拠・リンク: 2026-10-18 項目別確認

### C10-08 production mapping gate
- 質問: production mapping 採用判定をいつ何の証拠で解くか（whole-second regex vs fractional-ISO gap は B2 と連動）。
- 背景・根拠: `docs/operations.md:554-564`
- 選択肢: 1) gap 修正後に採用判定 2) 現状保留 3) 別途調査後に再判定
- 依存・影響先: B2、C08
- 回答 checkboxes: ☑ 決定 / □ 保留 / □ 棄却 / □ 要追加調査
- 内容: 追記（2026-10-18 確認）: 1) gap 修正後に採用判定する。B2 の決定（ms より細かい入力の書込前拒否）に合わせて修正する。
- 決定者: haruka
- 日付: 2026-10-18
- 証拠・リンク: 2026-10-18 項目別確認

### C11-01 positive tombstone evidence
- 質問: adopted operation-specific positive-evidence schema と実 provider 観測をどう取得するか（candidate `get-event` は `showDeleted` なし・read-only reviewed）。
- 背景・根拠: `docs/operations.md:665-668`
- 選択肢: 1) schema を先に合意 2) 実観測前提を commit 後に分担 3) 保留
- 依存・影響先: C08 adoption、C11-07
- 回答 checkboxes: ☑ 決定 / □ 保留 / □ 棄却 / □ 要追加調査
- 内容: 追記（2026-10-18 確認）: 1) positive-evidence schema を先に合意する（C08 の段階的採用と並行で進められるため）。
- 決定者: haruka
- 日付: 2026-10-18
- 証拠・リンク: 2026-10-18 項目別確認

### C11-07 実 HTTP status 証拠
- 質問: 削除境界観測での実 provider HTTP status 証拠（metadata-only 現状からの前進）を runtime logger 追加なしでどう取得するか。
- 背景・根拠: `docs/operations.md:671-672`（C11-07 row）、`docs/operations.md:682`（C11-07 positive / real HTTP status stays BLOCKED）
- 選択肢: 1) 観測手順另行設計 2) 現状維持 3) 棄却
- 依存・影響先: C11-01
- 回答 checkboxes: ☑ 決定 / □ 保留 / □ 棄却 / □ 要追加調査
- 内容: 追記（2026-10-18 確認）: 1) 観測手順を別途設計する。runtime logger は追加しない。C11-01 の schema 合意後に着手する。
- 決定者: haruka
- 日付: 2026-10-18
- 証拠・リンク: 2026-10-18 項目別確認

### C15 consent / Fresh OAuth
- 質問: C15 fake E2E は完了済だが、live consent-screen scope display の unobserved 分と Fresh OAuth flow（testing-mode re-consent 含む）をどう進めるか。
- 背景・根拠: `docs/operations.md:2342`（Fresh OAuth row：SEPARATE DECISION, untouched）、`docs/operations.md:1013-1017`（live readonly acceptance ledger：fresh consent-screen scope display のみ unobserved）。※当初予定の `673-674` は C11-01 positive-proof prerequisites の文であり本件に該当しないため修正
- 選択肢: 1) 観測手順を計画 2) separate decision のまま保留 3) 棄却
- 依存・影響先: C08、readonly binding design
- 回答 checkboxes: ☑ 決定 / □ 保留 / □ 棄却 / □ 要追加調査
- 内容: 追記（2026-10-18 確認）: 1) 観測手順を計画する。実アカウントで、同意画面の scope 表示と、testing-mode re-consent を含む Fresh OAuth flow を確認する。
- 決定者: haruka
- 日付: 2026-10-18
- 証拠・リンク: 2026-10-18 項目別確認

### M5 write binding + triple-gate live 許可
- 質問: dedicated write binding の選定（port 直付 vs derivePort）と triple-gate live 使用の承認はどう段階で判断するか（現状 production write binding 未選定・NOT authorized）。
- 背景・根拠: `docs/operations.md:2339`
- 選択肢: 1) 固定 binding 構成を先に採用 2) live 許可は validation 後 3) 保留
- 依存・影響先: B3、C16–C22、A3（C22 real chromium 13/13 at `61b3573` は再実行前）
- 回答 checkboxes: ☑ 決定 / □ 保留 / □ 棄却 / □ 要追加調査
- 内容: 追記（2026-10-18 確認）: 2) live 許可は validation 後とする。B3・B5 の修正、A3 の CI 再観測、C22 の再実行が通った後に判断する。binding は B3 の修正後に derivePort 方式で選定する。承認方式（都度 vs standing）は AV-10 を参照。
- 決定者: haruka
- 日付: 2026-10-18
- 証拠・リンク: 2026-10-18 項目別確認

---

## D manual / standalone smoke

### D1 Windows 11 x64 manual smoke
- 質問: Win11 x64 manual smoke（§19.6 support gate）を誰・どの環境で実施するか。
- 背景・根拠: `docs/operations.md:2341`（Windows 11 x64 manual smoke NOT EXECUTED）、`docs/operations.md:343-344`（Windows manual smoke remains open / synthetic gateway の限界記載）
- 選択肢: 1) 手順書を作って実施 2) 実施者待ち 3) 保留
- 依存・影響先: A3、Remind 側 Windows manual 未完
- 回答 checkboxes: ☑ 決定 / □ 保留 / □ 棄却 / □ 要追加調査
- 内容: 追記（2026-10-18 確認）: 1) 手順書を作って実施する。Windows 11 x64 実機で、Remind 側の Windows manual 確認もあわせて行う。
  - 追記（2026-10-18）: N7 により保留。代替は Linux サーバー＋Tailscale 経由ブラウザ smoke。
- 決定者: haruka
- 日付: 2026-10-18
- 証拠・リンク: 2026-10-18 項目別確認

### D2 T3/T4 standalone startServer smoke
- 質問: T3/T4 standalone actual-`startServer` smoke（disabled/enabled owned port）を受入に含めるか。
- 背景・根拠: `docs/operations.md:2083-2086`
- 選択肢: 1) 含める 2) 別窗 3) 保留
- 依存・影響先: C12 受、C13–C15 suite
- 回答 checkboxes: ☑ 決定 / □ 保留 / □ 棄却 / □ 要追加調査
- 内容: 追記（2026-10-18 確認）: 1) 受入に含める。B3・B4 の起動処理の修正を、本物の `startServer` で確認するため。
- 決定者: haruka
- 日付: 2026-10-18
- 証拠・リンク: 2026-10-18 項目別確認

---

## E remind（出典: `docs/plan/active_projects_plan.md` grep）

### R09 — M2 embedding 選定 [D]
- 質問: M2 embedding モデルの候補 / license / pin をどう合意するか（外部送信・依存追加は未承認。Ollama 等は候補提案止まり）。
- 背景・根拠: `docs/plan/active_projects_plan.md:94,97,102`
- 選択肢: 1) 既存台帳の候補範囲から絞り上げ 2) pin 等の決断を保留 3) 棄却
- 依存・影響先: R10–R12、R13
- 回答 checkboxes: ☑ 決定 / □ 保留 / □ 棄却 / □ 要追加調査
- 内容: 追記（2026-10-18 確認）: 1) 既存台帳の候補範囲から絞り込む。ローカル実行のみ（外部送信は引き続き未承認）。license 確認のうえ pin する。絞り込んだ候補の依存追加（Ollama 等）は承認する。
- 決定者: haruka
- 日付: 2026-10-18
- 証拠・リンク: 2026-10-18 項目別確認

### R13 — M2 seeded 評価方法 [D]
- 質問: seeded dataset・指標/閾値案を R09 に併せて評価方針として合意するか（実行は R11–R12 後、実ユーザデータ不使用）。
- 背景・根拠: `docs/plan/active_projects_plan.md:114,117`
- 選択肢: 1) 方針を合意 2) 閾値待ち 3) 棄却
- 依存・影響先: R09、R11–R12
- 回答 checkboxes: ☑ 決定 / □ 保留 / □ 棄却 / □ 要追加調査
- 内容: 追記（2026-10-18 確認）: 1) 方針を合意する。seeded データのみ使用し、実ユーザデータは使わない。指標・閾値は案として置き、R11–R12 後の評価実行前に確定する。
- 決定者: haruka
- 日付: 2026-10-18
- 証拠・リンク: 2026-10-18 項目別確認

### R14 — M3 保守対象・distill 方針 [D]
- 質問: M3 保守対象と distill 方針（reversible retirement・外部送信なし・既存台帳不変）を合意するか。
- 背景・根拠: `docs/plan/active_projects_plan.md:119,127,144-145`
- 選択肢: 1) 方針を合意 2) 元台帳で再検討 3) 棄却
- 依存・影響先: R15–R18
- 回答 checkboxes: ☑ 決定 / □ 保留 / □ 棄却 / □ 要追加調査
- 内容: 追記（2026-10-18 確認）: 1) 方針を合意する。reversible retirement・外部送信なし・既存台帳不変の 3 点を前提とする。保守対象の詳細は R15–R18 で詰める。
- 決定者: haruka
- 日付: 2026-10-18
- 証拠・リンク: 2026-10-18 項目別確認

---

## F integration contract decision gate（出典: `docs/plan/active_projects_tasks.md` 原文まま）

### F-I01-01
- 質問: integration version/protocol envelopeとcompatibility evolutionを決める。
- 背景・根拠: `docs/plan/active_projects_tasks.md:564`（元台帳状態 I01=D、前提記載: 同563）
- 選択肢: 1) scope 採用 2) scope 棄却 3) 保留
- 依存・影響先: 連携実装（I02–I05 全依存）
- 回答 checkboxes: ☑ 決定 / □ 保留 / □ 棄却 / □ 要追加調査
- 内容: 追記（2026-10-18 確認）: 1) scope 採用。envelope にプロトコルバージョンを持たせる。項目追加は後方互換、破壊的変更はメジャー更新、を基本ルールとする。
- 決定者: haruka
- 日付: 2026-10-18
- 証拠・リンク: 2026-10-18 項目別確認

### F-I01-02
- 質問: permitted scope mapping/trusted configとcaller identity境界を定義する。
- 背景・根拠: `docs/plan/active_projects_tasks.md:565`
- 選択肢: 1) 採用 2) 棄却 3) 保留
- 依存・影響先: F-I01-01
- 回答 checkboxes: ☑ 決定 / □ 保留 / □ 棄却 / □ 要追加調査
- 内容: 追記（2026-10-18 確認）: 1) 採用。scope mapping はサーバー側の trusted config で決め、呼出元の自己申告は信用しない。caller identity もサーバー側で判定する。
- 決定者: haruka
- 日付: 2026-10-18
- 証拠・リンク: 2026-10-18 項目別確認

### F-I01-03
- 質問: committed conversation event種別・eventId/turnId/runId sourcingを決める。
- 背景・根拠: `docs/plan/active_projects_tasks.md:566`
- 選択肢: 1) 採用 2) 棄却 3) 保留
- 依存・影響先: I03 二パス実装との整合
- 回答 checkboxes: ☑ 決定 / □ 保留 / □ 棄却 / □ 要追加調査
- 内容: 追記（2026-10-18 確認）: 1) 採用。committed イベントのみ送る。eventId/turnId/runId は本体側で発行する安定 ID（再送しても不変）とする。対象イベント種別の確定は I03 実装と整合させる。
- 決定者: haruka
- 日付: 2026-10-18
- 証拠・リンク: 2026-10-18 項目別確認

### F-I01-04
- 質問: AI judgment policyとuser_fact/model_inferenceの出所区別を合意する。
- 背景・根拠: `docs/plan/active_projects_tasks.md:567`
- 選択肢: 1) 採用 2) 棄却 3) 保留
- 依存・影響先: I03-06 provenance 分離
- 回答 checkboxes: ☑ 決定 / □ 保留 / □ 棄却 / □ 要追加調査
- 内容: 追記（2026-10-18 確認）: 1) 採用。記憶には必ず user_fact / model_inference の出所を付け、model_inference は事実として扱わない。judgment policy の詳細は I03 で詰める。
- 決定者: haruka
- 日付: 2026-10-18
- 証拠・リンク: 2026-10-18 項目別確認

### F-I01-05
- 質問: write policy・idempotency stable key generation・privacy metadataを決める。
- 背景・根拠: `docs/plan/active_projects_tasks.md:568`
- 選択肢: 1) 採用 2) 棄却 3) 保留
- 依存・影響先: I02-06 / I03-04
- 回答 checkboxes: ☑ 決定 / □ 保留 / □ 棄却 / □ 要追加調査
- 内容: 追記（2026-10-18 確認）: 1) 採用。idempotency key は F-I01-03 の安定 ID から決定的に生成する。書込は F-I01-02・F-I01-03 の条件を満たす場合のみ許可する。privacy metadata は必須とし、項目の詳細は実装時に詰める。
- 決定者: haruka
- 日付: 2026-10-18
- 証拠・リンク: 2026-10-18 項目別確認
  - 追記（2026-10-18 詳細確定）: P1b 項目は privacy:{sensitivity:"normal"|"sensitive", origin:"conversation"|"self_activity"}（secret 値は §14.3 未決のため置かない、origin は後方互換で追加可）。P2a remind プロトコルでは任意項目、Companion は常に送信、remind 設定 requirePrivacy（既定 off）で必須化可。P3 event.append・record.remember・record.correct に付与、correct は省略時に旧版を継承。P4a 保存して record.get/record.search で返すのみ、想起の順位・対象は変えない。P5 Companion の AI が remember 時に判定し判定不能は sensitive、event.append は固定 normal。実装: suiso11/remind#19・companion#59（CI pin 更新 #60）。決定者: haruka / 日付: 2026-10-18

### F-I01-06
- 質問: per-call/turn budgets・timeout・disabled/degraded response contractを決める。
- 背景・根拠: `docs/plan/active_projects_tasks.md:569`
- 選択肢: 1) 採用 2) 棄却 3) 保留
- 依存・影響先: I02-05/I02-08/I02-09
- 回答 checkboxes: ☑ 決定 / □ 保留 / □ 棄却 / □ 要追加調査
- 内容: 追記（2026-10-18 確認）: 1) 採用。budget・timeout 超過や disabled/degraded 時はエラーで止めず、その状態が分かる応答を返し、本体は記憶なしで続行する。具体的な数値は実装時に計測して決める。
- 決定者: haruka
- 日付: 2026-10-18
- 証拠・リンク: 2026-10-18 項目別確認

### F-I01-07
- 質問: opt-in/default-offとdowngrade/version mismatch behaviorを決める。
- 背景・根拠: `docs/plan/active_projects_tasks.md:570`
- 選択肢: 1) 採用 2) 棄却 3) 保留
- 依存・影響先: F-I01-01
- 回答 checkboxes: ☑ 決定 / □ 保留 / □ 棄却 / □ 要追加調査
- 内容: 追記（2026-10-18 確認）: 1) 採用。連携は default-off / opt-in とする。version mismatch・downgrade を検知した場合は連携を止め、F-I01-06 の disabled 応答と同じ扱いにして本体は続行する。
- 決定者: haruka
- 日付: 2026-10-18
- 証拠・リンク: 2026-10-18 項目別確認

### F-I01-08
- 質問: 追加scopeを採用するか棄却するかdecision recordに明記する。
- 背景・根拠: `docs/plan/active_projects_tasks.md:571`
- 選択肢: 1) 採用記録 2) 棄却記録 3) 保留
- 依存・影響先: F-I01-01..07 完了後
- 回答 checkboxes: ☑ 決定 / □ 保留 / □ 棄却 / □ 要追加調査
- 内容: 追記（2026-10-18 確認）: 1) 採用記録。F-I01-01〜07 をすべて採用。正式な decision record への記入は各台帳への追記として別途行う。
- 決定者: haruka
- 日付: 2026-10-18
- 証拠・リンク: 2026-10-18 項目別確認

### F-I04-01
- 質問: memory snippetをuntrusted evidenceとして扱い命令実行/真実保証しない契約を決める。
- 背景・根拠: `docs/plan/active_projects_tasks.md:603`（元台帳状態 I04=D、前提記載: 同602）
- 選択肢: 1) 採用 2) 棄却 3) 保留
- 依存・影響先: I04 全体
- 回答 checkboxes: ☑ 決定 / □ 保留 / □ 棄却 / □ 要追加調査
- 内容: 追記（2026-10-18 確認）: 1) 修正つき採用。memory snippet の文章は untrusted evidence として扱い、命令として直接実行しない。remind 起点の自主行動は、user_fact 由来の構造化された意図に限って行動のきっかけにできる。その場合も本体側のポリシー判断（AV-02）と既存 gate（M5 triple-gate 等）を通す。
- 決定者: haruka
- 日付: 2026-10-18
- 証拠・リンク: 2026-10-18 項目別確認

### F-I04-02
- 質問: EvidenceGrant/Citationとmemory source_kind/rN対応の要否を既存APIとの整合で判断する。
- 背景・根拠: `docs/plan/active_projects_tasks.md:604`
- 選択肢: 1) 対応を採用 2) 不要・棄却 3) 保留
- 依存・影響先: F-I04-01
- 回答 checkboxes: ☑ 決定 / □ 保留 / □ 棄却 / □ 要追加調査
- 内容: 追記（2026-10-18 確認）: 1) 対応を採用。記憶を source_kind=memory・rN 参照つきで EvidenceGrant/Citation に乗せる。既存 API との互換性確認は F-I04-07 で行う。
- 決定者: haruka
- 日付: 2026-10-18
- 証拠・リンク: 2026-10-18 項目別確認

### F-I04-03
- 質問: sourceRefとcitation provenanceの安定identity/refresh semanticsを定める。
- 背景・根拠: `docs/plan/active_projects_tasks.md:605`
- 選択肢: 1) 採用 2) 棄却 3) 保留
- 依存・影響先: C12 スナップショット
- 回答 checkboxes: ☑ 決定 / □ 保留 / □ 棄却 / □ 要追加調査
- 内容: 追記（2026-10-18 確認）: 1) 採用。sourceRef は記憶 ID ＋リビジョンの組とする。引用は使用時点の版に固定し、新規の引用は最新版を使う。
- 決定者: haruka
- 日付: 2026-10-18
- 証拠・リンク: 2026-10-18 項目別確認

### F-I04-04
- 質問: exposed IDs/recallId/scope mappingを限定し無制限memory injectionを禁止する。
- 背景・根拠: `docs/plan/active_projects_tasks.md:606`
- 選択肢: 1) 採用 2) 棄却 3) 保留
- 依存・影響先: I05-06 scope injection 防止
- 回答 checkboxes: ☑ 決定 / □ 保留 / □ 棄却 / □ 要追加調査
- 内容: 追記（2026-10-18 確認）: 1) 採用。渡す記憶は F-I01-02 の scope 内に限り、件数・量に上限を設ける（数値は F-I01-06 の budget と合わせて決める）。呼出ごとに recallId を付けて記録する。AI に見せる ID は引用用の rN に限る。
- 決定者: haruka
- 日付: 2026-10-18
- 証拠・リンク: 2026-10-18 項目別確認

### F-I04-05
- 質問: used-only feedback条件を定め、mere recallでheatを上げない。
- 背景・根拠: `docs/plan/active_projects_tasks.md:607`
- 選択肢: 1) 採用 2) 棄却 3) 保留
- 依存・影響先: I05-08
- 回答 checkboxes: ☑ 決定 / □ 保留 / □ 棄却 / □ 要追加調査
- 内容: 追記（2026-10-18 確認）: 1) 採用。heat は Citation で引用された記憶にのみ加算し、取り出しただけの記憶は加算しない。recallId で「渡したもの」と「使われたもの」を区別して記録する。
- 決定者: haruka
- 日付: 2026-10-18
- 証拠・リンク: 2026-10-18 項目別確認

### F-I04-06
- 質問: correction後も既存citation immutable snapshotとして保つか明記する。
- 背景・根拠: `docs/plan/active_projects_tasks.md:608`
- 選択肢: 1) 保つ 2) 変更する 3) 保留
- 依存・影響先: F-I04-03
- 回答 checkboxes: ☑ 決定 / □ 保留 / □ 棄却 / □ 要追加調査
- 内容: 追記（2026-10-18 確認）: 1) 保つ。correction 後も既存 citation は使用時点の immutable snapshot として固定する。修正は新しいリビジョンとして追加する（F-I04-03・R14 と整合）。
- 決定者: haruka
- 日付: 2026-10-18
- 証拠・リンク: 2026-10-18 項目別確認

### F-I04-07
- 質問: contract変更要否を既存 ReferenceManager APIs/testsの根拠で判断する。
- 背景・根拠: `docs/plan/active_projects_tasks.md:609`
- 選択肢: 1) 変更する 2) 変更しない 3) 保留
- 依存・影響先: ReferenceManager 既存 contract
- 回答 checkboxes: □ 決定 / □ 保留 / □ 棄却 / ☑ 要追加調査
- 内容: 追記（2026-10-18 確認）: 要追加調査。ReferenceManager の既存 API/tests で、①source_kind=memory を追加できるか、②リビジョン付き sourceRef を扱えるか、を確認する。変更が必要な場合は F-I01-01 のルールに従い後方互換の追加のみとする。
- 決定者: haruka
- 日付: 2026-10-18
- 証拠・リンク: 2026-10-18 項目別確認
  - 追記（2026-10-18 調査結果・決定）: ReferenceManager に source_kind 概念はなく（kind は markdown/calendar のみ）、記憶引用は mN（packages/contracts/src/structured_answer.ts）＋memory_grants の別系統。Q1a 記憶の引用 ID は mN を維持し、F-I04-02/04 の「rN」は構造化引用 ID（rN/mN）と読む（migration なし）。Q2 memory_grants の revision に想起時の revision（remind#16 で返却）を引用時点の版として固定、新規引用は最新版（companion#58/#59）。Q3 表示は record.get(id) で引用時点の版を取得（remind 側変更不要）。回答: 要追加調査 → 決定。決定者: haruka / 日付: 2026-10-18

### F-I04-08
- 質問: I02–I03完成を不要な依存にせず契約決定を先行記録する。
- 背景・根拠: `docs/plan/active_projects_tasks.md:610`、I02/I03 現況（同 593・609 付近の「現況（2026-10-15）」）
- 選択肢: 1) 先行記録 2) 保留 3) 棄却
- 依存・影響先: 記録タスク
- 回答 checkboxes: ☑ 決定 / □ 保留 / □ 棄却 / □ 要追加調査
- 内容: 追記（2026-10-18 確認）: 1) 先行記録。F-I04-01〜06 は I02–I03 の完成を待たずに記録する。F-I04-07 は要追加調査として未決のまま明記する。正式な記入は各台帳への追記として別途行う。
- 決定者: haruka
- 日付: 2026-10-18
- 証拠・リンク: 2026-10-18 項目別確認

---

## G AV 台帳判定（AV-01..AV-10）

※ 出典: 本 repo の AV 台帳（既存の受入 record）。**POLICY 合意 ≠ 実装・権限。** 判定は既存台帳の行を書き換えず、本テーブルに答えだけ置く。

追記（2026-10-18）: 題名を AV 台帳から転記し、判定を記入。各判定の内容は表の下の「G 判定内容」を参照。

| ID | 題名 | 回答 | 決定者 | 日付 |
| --- | --- | --- | --- | --- |
| AV-01 | PURPOSE MODEL [PROPOSAL] | 決定（方針合意） | haruka | 2026-10-18 |
| AV-02 | DELIBERATOR [PROPOSAL] | 決定（修正つき方針合意） | haruka | 2026-10-18 |
| AV-03 | TASK/ACTION [PROPOSAL/UNRESOLVED] | 決定（方針合意・permission 変更は UNRESOLVED 維持） | haruka | 2026-10-18 |
| AV-04 | LEARNING [POLICY] | 決定（修正つき方針合意） | haruka | 2026-10-18 |
| AV-05 | NOTIFICATIONS [POLICY] | 決定（方針合意） | haruka | 2026-10-18 |
| AV-06 | RESOURCE [POLICY] | 決定（方針合意） | haruka | 2026-10-18 |
| AV-07 | RECOVERY [POLICY] | 決定（方針合意） | haruka | 2026-10-18 |
| AV-08 | SELF MAINTENANCE [POLICY] | 決定（方針合意） | haruka | 2026-10-18 |
| AV-09 | MEMORY [PROPOSAL/UNRESOLVED] | 決定（方針合意・除外/削除等は UNRESOLVED 維持） | haruka | 2026-10-18 |
| AV-10 | 既存計画調整 [UNRESOLVED] | 決定（修正つき方針合意） | haruka | 2026-10-18 |

### G 判定内容（追記 2026-10-18）

すべて POLICY 合意であり、実装・権限付与ではない。

- **AV-01 PURPOSE MODEL**: 方針として合意。F-I01-04（user_fact / model_inference 区別）・F-I04-01（意図は gate を通して行動）と整合。
- **AV-02 DELIBERATOR**: 修正つきで方針合意。
  - 起動の限定（自律候補・重要 policy 変更時のみの有界起動）は外し、常時稼働を許容する。
  - ただし AV-06 に従い、会話・stop を優先し、応答低下時は throttle/pause し、自己予算の増加はしない。
  - proposals only と、本番前の shadow evaluation 必須は維持する。
  - モデルは未選定のまま別途決める。
- **AV-03 TASK/ACTION**: 方針として合意。正式な permission 変更の扱いは UNRESOLVED のまま残し、AV-10（M5 都度承認 vs standing）とあわせて決める。
- **AV-04 LEARNING**: 修正つきで方針合意。
  - learning で権限・予算・目標を自分で変更しない。
  - ただし、学習の結果、目標を変えたほうがよいと判断した場合は、根拠（evidence）を添えてユーザーに提案しなければならない。
  - 提案は AV-05 に従って伝え、ユーザーの沈黙は承認と見なさない。
  - 提案義務の対象は目標のみ（権限・予算は対象外。必要なら別途追記）。
- **AV-05 NOTIFICATIONS**: 方針として合意。AV-04 の目標変更の提案もこの方針に従う。
- **AV-06 RESOURCE**: 方針として合意。AV-02 の常時稼働はこの方針に従う。数値 bounds・concurrency は測定後に別途決める。
- **AV-07 RECOVERY**: 方針として合意。
- **AV-08 SELF MAINTENANCE**: 方針として合意。migration / backup 検証 / export / 終了 / device change は将来課題として未実装のまま。
- **AV-09 MEMORY**: 方針として合意。除外・削除・backup 消去・export は UNRESOLVED のまま残し、R14 の reversible retirement・AV-08 との両立を含めて別途決める。
- **AV-10 既存計画調整**: 修正つきで方針合意。
  - M5 の承認方式は、最終的に standing 承認を目指し、それまでは都度承認とする。
  - standing では、元に戻せる操作について多少の失敗を許容する。
  - ただし AV-03 の個別 boundary 対象（外部公開・共有 branch・payments・deletion・secrets・access）は、standing でも個別チェックを維持する。
  - U1 の I01 gate 必要、現 scope 拡大なし、task manager / pi-orch 統合の acceptance 不在、milestone・要件・順序の保全は記載どおり。

---

## 依存早見（合意順序の目安）
1. G01 / G02 → 既存受入（AV 台帳・implementation_plan 合意項）の再実行
2. （C08 + C10-08 + C11-01）
3. C12–C15
4. M5 write binding（内 B3 未解決指摘の先決可）
5. C16–C22
6. R13 → R09 → R10–R12
7. R14 → R15–R18
8. I01 → I02–I05（I04 は I01 後、I02–I03 と並行可）

## 残課題（追記 2026-10-18）
- F-I04-07: ReferenceManager API/tests の確認（要追加調査）
- AV-03 / AV-10: 正式 permission 変更・standing 承認の具体的な契約
- AV-09: 除外・削除・backup 消去・export
- 全項目: 本書は正本ではないため、各台帳（operations.md / active_projects_plan.md / active_projects_tasks.md / implementation_plan.md / remind plan）への正式な追記が別途必要

---

## G Linux 集約・リモートアクセス（追記 2026-10-18、haruka 決定）

### N1 Linux 集約（server＋data＋remind）
- 質問: Companion server・data・remind の実行場所を Linux に集約するか。Windows PC・スマホはブラウザのみにするか。
- 背景・根拠: haruka 指示（2026-10-18）。現行 `apps/server/src/config.ts:12`（bind host は loopback のみ）・`apps/server/src/bootstrap.ts:2702`（`serve({ hostname: config.host })`）は loopback 想定の構成。
- 選択肢: 1) Linux 集約 2) 現状維持
- 依存・影響先: N2–N7、D1
- 回答 checkboxes: ☑ 決定 / □ 保留 / □ 棄却 / □ 要追加調査
- 内容: Companion server＋data＋remind は Linux 上でのみ実行する。Windows PC とスマートフォンはブラウザとしてのみ利用する（サーバー実行なし）。
- 決定者: haruka
- 日付: 2026-10-18
- 証拠・リンク: 2026-10-18 項目別確認、設計: `docs/plan/linux_remote_access_design.md`

### N2 Tailscale 経由・0.0.0.0 bind 禁止
- 質問: リモート到達手段を Tailscale のみに限定し、サーバーの 0.0.0.0 bind を禁止するか。
- 背景・根拠: haruka 指示（2026-10-18）。現行 `apps/server/src/config.ts:33,39`（`DEFAULT_HOST = "127.0.0.1"`、`HostSchema` は `127.0.0.1`/`localhost` のみ許可）。
- 選択肢: 1) Tailscale のみ・0.0.0.0 禁止 2) インターネット公開あり
- 依存・影響先: N3、N5
- 回答 checkboxes: ☑ 決定 / □ 保留 / □ 棄却 / □ 要追加調査
- 内容: 自宅外からも含め Tailscale（tailnet）経由でのみアクセスする。インターネット公開はしない。サーバーは 0.0.0.0 に bind しない（loopback のまま `tailscale serve` で tailnet へ公開する構成を推奨。詳細は設計書）。
- 決定者: haruka
- 日付: 2026-10-18
- 証拠・リンク: 2026-10-18 項目別確認、設計: `docs/plan/linux_remote_access_design.md`

### N3 HTTPS（Tailscale 発行証明書・`tailscale serve`）
- 質問: HTTPS 化を Tailscale 発行証明書＋`tailscale serve` で行うか。
- 背景・根拠: haruka 指示（2026-10-18）。
- 選択肢: 1) `tailscale serve`＋Tailscale 証明書 2) 自前証明書・他リバプロ
- 依存・影響先: N2、N5
- 回答 checkboxes: ☑ 決定 / □ 保留 / □ 棄却 / □ 要追加調査
- 内容: HTTPS は Tailscale 発行の証明書を用い、`tailscale serve` で実現する。
- 決定者: haruka
- 日付: 2026-10-18
- 証拠・リンク: 2026-10-18 項目別確認、設計: `docs/plan/linux_remote_access_design.md`

### N4 アプリ層ログイン＋セッション Cookie（tailnet ACL に加えた defense in depth）
- 質問: tailnet ACL に加えてアプリ層のログイン＋セッション Cookie を設けるか。
- 背景・根拠: haruka 指示（2026-10-18）。現行コードにアプリ層 auth は存在しない（`apps/server/src/app.ts` に auth/cookie/session ログイン機構なし。`checkHost` は `apps/server/src/app.ts:360` で loopback のみ許可）。
- 選択肢: 1) 単一ユーザーパスワード＋セッション Cookie を追加 2) tailnet ACL のみ
- 依存・影響先: N2、テスト計画
- 回答 checkboxes: ☑ 決定 / □ 保留 / □ 棄却 / □ 要追加調査
- 内容: tailnet ACL に加え、アプリ層のログイン（単一ユーザーパスワード。ハッシュは secret-not-in-DB ルールに従い SQLite 外に保存し CLI/setup コマンドで設定）とセッション Cookie（HttpOnly・Secure・SameSite=Strict、不透明ランダムトークン、サーバーはハッシュのみ保持）を defense in depth として設ける。全 API＋SSE はセッション必須、health 方針は設計書に定める。ログイン rate limiting・logout・有効期限/アイドル timeout は未決または設計書の案を参照。
- 決定者: haruka
- 日付: 2026-10-18
- 証拠・リンク: 2026-10-18 項目別確認、設計: `docs/plan/linux_remote_access_design.md`

### N5 明示的 Origin allowlist（loopback 前提の置換）
- 質問: loopback 前提の暗黙チェックを明示的 Origin allowlist に置き換えるか。
- 背景・根拠: haruka 指示（2026-10-18）。現行 `apps/server/src/app.ts:360`（`checkHost`: loopback ホスト名のみ許可）・`apps/server/src/app.ts:411-437`（`checkMutationSecurity`: `origin === http://${host}` の同一オリジンのみ許可、Origin 未指定は CLI 的リクエストとして許容）。
- 選択肢: 1) 明示的 Origin allowlist＋Host 検査 2) loopback 暗黙前提の維持
- 依存・影響先: N2、N4
- 回答 checkboxes: ☑ 決定 / □ 保留 / □ 棄却 / □ 要追加調査
- 内容: loopback のみ暗黙許可の前提をやめ、明示的な Origin allowlist（例: `https://<host>.<tailnet>.ts.net` およびローカル開発用 loopback）を設ける。Host ヘッダ検査・state-changing リクエストの CSRF 対策とあわせて設計書に定める。
- 決定者: haruka
- 日付: 2026-10-18
- 証拠・リンク: 2026-10-18 項目別確認、設計: `docs/plan/linux_remote_access_design.md`

### N6 スマホ UI 最低限対応
- 質問: 現行 UI をスマートフォンで最低限使えるようにするか。
- 背景・根拠: haruka 指示（2026-10-18）。現行 `apps/server/src/ui/page.ts:41`（viewport `width=device-width, initial-scale=1` あり）・`apps/server/src/ui/client.css`（49 行、media query・responsive 対応なし）。
- 選択肢: 1) 最低限（viewport・レイアウト・タッチ target）対応 2) 対応しない
- 依存・影響先: N1（スマホはブラウザ利用）
- 回答 checkboxes: ☑ 決定 / □ 保留 / □ 棄却 / □ 要追加調査
- 内容: 現行 UI をスマートフォンで最低限使えるようにする（viewport・レイアウト・タッチ target が scope。具体策は設計書）。
- 決定者: haruka
- 日付: 2026-10-18
- 証拠・リンク: 2026-10-18 項目別確認、設計: `docs/plan/linux_remote_access_design.md`

### N7 Windows server-run 手動 smoke（D1）保留・代替受入
- 質問: D1「Windows server-run 手動 smoke」を保留とし、代替受入に置き換えるか。
- 背景・根拠: haruka 指示（2026-10-18）。D1 ブロック（本書 D1 項）参照。
- 選択肢: 1) 保留＋代替受入 2) D1 継続
- 依存・影響先: D1
- 回答 checkboxes: ☑ 決定 / □ 保留 / □ 棄却 / □ 要追加調査
- 内容: 「Windows server-run 手動 smoke（D1）」は保留とする。代替の受入は「Windows/スマホのブラウザ → Linux サーバー（Tailscale 経由）」smoke とする。
- 決定者: haruka
- 日付: 2026-10-18
- 証拠・リンク: 2026-10-18 項目別確認、設計: `docs/plan/linux_remote_access_design.md`（受入 smoke 節）

### NODE26 Node 26 trial（CI non-blocking、green なら pin 切替）
- 質問: Node 26 を CI で trial するか。
- 背景・根拠: haruka 指示（2026-10-18）。現行 pin: `.github/workflows/ci.yml:51,93`（`node-version: 24.12.0`）・`package.json:8`（`"node": "24.12.0"`）。
- 選択肢: 1) 試験的に Node 26 を CI に追加（non-blocking）し green なら pin 切替 2) 追加しない
- 依存・影響先: CI
- 回答 checkboxes: ☑ 決定 / □ 保留 / □ 棄却 / □ 要追加調査
- 内容: Node 26 を CI で試験的に追加する（non-blocking）。green なら pin を切り替える。
- 決定者: haruka
- 日付: 2026-10-18
- 証拠・リンク: 2026-10-18 項目別確認
- テンプレート上の不備: 依存早見の「G01 / G02」に対応する本文項目がない

---

## H フロントエンド（2026-10-18〜19 決定）

※ [frontend_ui_requirements.md](frontend_ui_requirements.md) の Q1–Q11 に対する回答。決定者: haruka。

- **Q1 フレームワーク**: 決定 — 軽量 framework の導入を許可 → **Svelte 5** を採用。
- **Q2 chat UI の理想**: 決定 — **llama.cpp WebUI を理想とし、MIT ライセンス commit `098ce52` を vendoring**（改変可・出所明記）。
- **Q3 テーマ**: 決定 — **simple dark のみ**（テーマ切替・light モードは作らない）。
- **Q4 PWA**: 決定 — **将来課題として先送り**（現時点では実装しない）。
- **Q5 push 通知**: 決定 — **現時点では導入しない**。AV-05 に従い in-app 通知のみ。
- **Q6 言語**: 決定 — **日本語のみ**（多言語化はしない）。
- **Q7 情報設計**: 決定 — **chat を最優先のトップ画面とし、他機能は別ページ**に置く。
- **Q9 bundle budget・browser matrix**: 決定 — frontend_ui_requirements.md の**推奨値を採用**（初回 page JS ≤300KB min 等・evergreen browser matrix）。
- **Q10（推奨値）**: 決定 — **推奨値を採用**。
- **Q11 応答表示**: 決定 — **thinking block ＋ run status ＋ provisional draft（暫定回答）** の表示を採用。
- 証拠・リンク: frontend_ui_requirements.md、実装は PR #75/#76/#77/#78/#82/#83/#84/#85（いずれも merged 2026-10-19）。

### Gemma 4 26B-A4B 採用・Qwen 削除（2026-10-19, haruka）

- 決定: chat model を **Gemma 4 26B-A4B（unsloth UD-Q4_K_XL）** に切替（2026-10-19 実施）。**Qwen は削除**。
- 互換対応（merged）: #87（answer protocol version 要求を撤去）、#88（answer_invalid の fixed reason codes 記録）、#89（OpenAI-compatible モデルへ `tool_choice: required` 送信）、#90（model 非依存の `local-chat` LiteLLM alias）。
- 決定者: haruka / 日付: 2026-10-19

### 自動デプロイ採用（2026-10-19）

- 決定: 単一 Linux ホスト上の systemd user units＋5分ポーリングによる **origin/master green 先端の自動デプロイを採用**（`scripts/deploy/`、docs/operations.md「自動デプロイ」節）。PR #79/#80/#86（merged）。
- 決定者: haruka / 日付: 2026-10-19
### メモリ store-everything 採用（2026-10-20）

- 決定: Companion のターン抽出は **基本すべて保存**（haruka 2026-10-20 決定）。**選別は recall 時のみ**（会話に注入するものの選択）。extraction は毎ターン必ず 1 件の `summary`（ターンの要約・重要度判断なし）＋ユーザーが明言した全詳細を個別 `user_fact`（重要度フィルタなし）＋根拠のある `model_inference` を返す。抽出失敗時は free-text フォールバックなしで `memory.extract_invalid` を記録するのみ（raw event は既存の event.append 経路で保持）。上限 8 → 16 件/ターン。
- 決定者: haruka / 日付: 2026-10-20

- I 記憶の保存基準（2026-10-20 haruka 決定）: 基本すべて保存し、会話へ持ち込む記憶は想起時に厳選する。各ターンで summary 1 件＋本人発言の詳細を全件、根拠ある傾向は model_inference。

### Web 検索: self-hosted SearXNG 採用（2026-10-20, haruka）

- 決定: Option B — Linux ホスト上の **self-hosted SearXNG** を Companion の Web 検索バックエンドとして採用。クエリテキストが SearXNG 経由でアップストリーム検索エンジンへ送られることを許可（127.0.0.1:8888 loopback 限定・tailnet 非公開・`settings.yml` で `search.formats: [html, json]`、limiter off）。Companion 側は `web.search` ツール（query ≤200 chars、top-k ≤8）、結果は untrusted evidence、ReferenceManager 新 connector kind `web` → rN citation、ターン検索予算案 3・タイムアウト案 10s。設定は `COMPANION_WEB_SEARCH_JSON` default-off。phase 1 でページ取得は行わない（`web.open` は phase 2 の別決定）。デザイン詳細: docs/plan/web_search_design.md。
- 決定者: haruka / 日付: 2026-10-20
