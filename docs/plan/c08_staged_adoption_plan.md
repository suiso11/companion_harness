# C08 段階的採用計画（案）

status: 案（段階・順序はユーザー決定待ち）
date: 2026-10-18
branch: docs/decisions-2026-10-18（PR #56）

本書は Calendar 上流 MCP バインディング（C08）の段階的採用手順の**草案**で
ある。段階の並び・採否はユーザー決定を待ち、本書はRealityに存在する証拠の
みを根拠とする。正式採用は現時点で **HOLD / NOT ADOPTED**
（docs/operations.md:2360）。

## 前提（根拠）

- 採用対象候補: fork `97a3dc3…`／`google-calendar` `3.0.0-readonly.1`、
  正確ピン形式 = 完全 git SHA + lock digest
  （docs/m4_dependency_spike.md:302-311）。
- ワire識別ガード（expected `serverInfo` 一致・fail-closed）は C09 として
  実装済み（docs/m4_dependency_spike.md:433-450、operations.md:494）。
- ピンとバインディング・プロファイル・OAuth・live 配線は本ブランチに存在
  しない（docs/operations.md:1999）。
- C10-08 本番マッピング（whole-second regex vs 分数 ISO の gap）は
  UNRESOLVED。gap 修正後に採用判定し、共有 strict-instant predicate は
  PR #55（docs/operations.md:2362、docs/plan/active_projects_tasks.md:21）。
- C11-01（肯定的 tombstone 証拠）は BLOCKED
  （docs/operations.md:665）。schema 先行は
  docs/plan/c11_positive_evidence_schema.md。

## 段階

### Stage 1: binding identity（ワイア名/バージョンガード）

- 内容: 明示的な信頼済み binding 定義に expected wire identity
  （`serverInfo.name`/`version`）を記載し、`initialize` 応答と正確比較。
  不一致・欠落時は当該コネクタの全 binding を無効化（fail-closed）
  （docs/m4_dependency_spike.md:424-442）。
- 開始条件: C08-07 記録済み（operations.md:494）、ガード実装済み
  （merged master PR16/PR17）。
- 終了証拠: 実 `initialize` 応答での一致確認（例証拠は
  m4_dependency_spike.md:452-465 の歴史的 probe を参照、ただし正規の
  期待 identity との一致でのこと）。
- mismatch 時の無効化: wire 不一致 → 全 binding 無効・次段階へ進まない。
- 依存: なし（先行段階）。

### Stage 2: exact pin（SHA/lock）

- 内容: 完全 git SHA `97a3dc3…` + candidate `package-lock.json` digest
  `6afe76f9…bd523` を binding 定義に記載。branch/短 SHA/tag/release/
  dist-tag は不可（docs/m4_dependency_spike.md:304-311）。
- 開始条件: Stage 1 の終了証拠があること。
- 終了証拠: 同一 SHA/lock での `npm ci --ignore-scripts` + build 手順
  （docs/google_calendar_readonly_binding_design.md:9-11 を参照、
  インストール前提として文書化）、再現ハッシュ一致。
- mismatch 時の無効化: 書き換えられたリポジトリ/lock 変更を検出したら
  binding 無効・Stage 3 以降へ進まない。
- 依存: Stage 1。C10-08 gap 修正（PR #55）は Stage 5 判定の前提。

### Stage 3: profile

- 内容: host 側 pinned profile への登録（現設計参照:
  docs/google_calendar_readonly_binding_design.md:3-8 の `google-readonly`
  構成、厳格 opt-in）。profile は DB 副作用の前に同期的に解決される
  （同 30-32 行目）。
- 開始条件: Stage 2 の pin が固定済み。
- 終了証拠: profile 選択の起動時確認（設定失敗時に DB 作成なし・旧 DB
  不変）＋起動時の binding 無効状態確認（default-off、Stage 4 を参照）。
- mismatch 時の無効化: profile 解決失敗 → 起動続行（binding 無効のまま）。
- 依存: Stage 2。

### Stage 4: server registration（default-off）

- 内容: MCP サーバ登録は**既定で無効**。明示的な session 合意でのみ
  起動時有効化。接続は遅延（最初の許可呼び出し時）で、起動は上流停止で
  ブロックされない（docs/operations.md:957-959）。
- 開始条件: Stage 3 の profile が解決可能。
- 終了証拠: default-off（有効化なしで Calendar 機能が動作する）
  ＋ 明示有効化後の `server.calendar_ready`（URL/id 非記録）
  （docs/operations.md:961-964）。
- mismatch 時の無効化: 登録内容が Stage 2 の pin と一致しなければ有効化
  を拒否。
- 依存: Stage 3、C11-01 合意（Stage 5 の前提のみ）。

### Stage 5: readonly live（C15 依存）

- 内容: live 読み取り観測。実アカウント観測手順は
  docs/plan/c15_live_consent_procedure.md を用いる（fresh OAuth は別決定、
  operations.md:2369）。
- 開始条件: Stage 1〜4 完了、**C10-08 gap 修正後の採用判定完了**
  （PR #55、operations.md:2362）、**C15 の live 受入手続きが用意済み**。
- 終了証拠: 観測台帳（整数/固定コードのみのサニタイズ）への記録。
  wire hash 一致（`81222b89…`/`d48ba36e…`/`8c6736e2…`、
  m4_dependency_spike.md spike conclusion 参照）。
- mismatch 時の無効化: 観測が pin/schema hash と不一致なら binding 無効・
  台帳に記録し Stage 4 へ戻る。
- 依存: Stage 4、C10-08（PR #55）、C15。

## 明示しないこと（新規造語の禁止）

- `get-event` に `showDeleted` は存在しない（`events.list` のみに存在）。
  本書は当該オプションを含まない
  （docs/google_calendar_readonly_binding_design.md:201-213）。
- write 対応（If-Match/412 等）は本計画の対象外
  （docs/m4_dependency_spike.md spike conclusion）。
- C11-01 肯定証拠は別スキーマ文書で合意後に扱う。
