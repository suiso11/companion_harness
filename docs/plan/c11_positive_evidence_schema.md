# C11 肯定的削除証拠スキーマ（草案）

status: 合意待ち
date: 2026-10-18
branch: docs/decisions-2026-10-18（PR #56）

本書は C11-01（operation-specific な肯定的 tombstone 証拠）のスキーマ草案
である。スキーマ合意後、C11-07 の観測手順が続く。現状は C11-01 **BLOCKED**
（docs/operations.md:665）で、肯定的マッピングは存在しない。

## 現行の否定的境界（変更しない）

- `cancelled` は正規化 `cancelled` であり `deleted` にはならない
  （C11-02、docs/operations.md:666）。
- bare 404（`isError:true`）→ `calendar_upstream_error`、thrown RPC →
  `mcp_unavailable`。いずれも tombstone なし
  （C11-03、docs/operations.md:667）。
- 検索 1 ページの省略は削除ではない（C11-04、docs/operations.md:668）。
- `get-event` に `showDeleted` は存在しない。`showDeleted` は
  `events.list` のみ。410 は list sync-token 失効の回復シグナルであり
  イベントごとの削除証拠ではない
  （docs/google_calendar_readonly_binding_design.md:201-235）。
- raw `deleted` status、`deleted`/`tombstone` ヒントフラグは拒否/除去
  （docs/google_calendar_readonly_binding_design.md:237-255）。
- 不確実な結果は既存の固定コードへ。既存スナップショットの保持は
  C12（未配線）（C11-05、docs/operations.md:669）。

## 肯定的削除証拠の定義（operation ごと）

### get-event

1. 事前既知の完全特定のターゲット（connector / calendar / event を正確に
   特定。呼び出し元提供の `priorKnown` 真偽値は不可）
   （docs/m4_dependency_spike.md spike tail の前提 2 参照）。
2. アクセス可能な calendar / 読み取り権限コンテキスト（前提 3）。
3. 観測: `get-event` 呼び出しが成功した MCP 応答を返し、かつ
   `structuredContent`（または厳密 JSON fallback の `text`）内のイベントが
   同一 canonical id と一致し、`status` が `"cancelled"` であること。
   `structuredContent` は own-property 存在で選択され、present なら唯一の
   情報源、ABSENT のときのみ `text` 全体を strict JSON として解析
   （docs/operations.md:517-521）。
4. 送信済み id と応答 id の一致（exact id match）が一致条件。

### delete-operation（将来の書き込み操作）

- 意味論: 書き込み操作の成功応答（操作対象の正確な id が応答で特定でき、
  `structuredContent-first` 解析で妥当な場合）＋直後の読み戻しで
  get-event肯定的証拠（上記）が得られた場合のみ tombstone を許す。
- If-Match/412/自動再送の扱いは write binding 設計に属し本書では決定
  しない（docs/m4_dependency_spike.md spike conclusion）。

## 必須フィールド（レコード）

- `sourceKind`: 静的候補 / 保持された inert provider / 新規合成 SDK wire
- `refs`: 不変 archive/候補参照（immutability 必須）
- `operation`: 操作名
- `requestFieldNames`: リクエストの**フィールド名のみ**（生 id / cursor /
  query / email / error body は入れない）
- `observedEnvelope`: 観測された MCP envelope の**形状**
- `consumerError`: 固定 consumer エラー（もしあれば）
- `priorKnownTarget`: 完全特定の事前既知ターゲット（上記 1)
- `idMatch`: 送信 id と応答 id の一致の有無
- `structuredSource`: `structuredContent` / `text-fallback` の別
- `httpStatus`: **UNKNOWN 固定**（MCP 経由では観測不能のため、合成マーカは
  provider HTTP 証拠ではない。docs/operations.md:671）

## strict 検証

- 全フィールド必須。欠落＝無効。型を固定。
- `httpStatus` は `UNKNOWN` 以外を許さない（観測手段が存在しない限り）。
- 真偽値や曖昧フラグ（`priorKnown: true` など）によるenergetic証拠の
  セルフ宣言は不許可。

## 区分: 削除 / not-found / 権限・不明

- **削除（肯定的）**: 上記 get-event 条件をすべて満たす場合のみ。
  tombstone を書けるのは C12 配線後。
- **not-found**: bare 404 は「存在しない」or「アクセス不能」を区別できず、
  tombstone にはならない。`calendar_upstream_error` のまま
  （docs/google_calendar_readonly_binding_design.md:217-222）。
- **権限/不明**: thrown RPC → `mcp_unavailable`。その他の`isError` →
  `calendar_upstream_error`。いずれも**非肯定的＝no tombstone**。
- 検索省略は常に非肯定的（§17.5、docs/google_calendar_readonly_binding_design.md:250-253）。

## structuredContent-first 解析

- 統一的な方針: `structuredContent` own-property が present → それのみが
  情報源（null/undefined/wrong-shaped は rescue されない）。ABSENT →
  `text` 全体を strict JSON として解析（fences・部分走査・合成は不許可）
  （docs/operations.md:517-521）。
- 削除証拠の判定もこの順序に従う。`text` の部分文字列 heuristics は不許可。

## C11-07: スキーマ合意後の観測手順

1. 本スキーマの合意（ユーザー決定）を待つ。
2. 合意されたスキーマに沿って観測を**docs/ops のみ**に記録。runtime
   logger / telemetry / status 診断チャネルは**追加しない**、error privacy
   を弱めない（docs/operations.md:671、m4_dependency_spike.md
   C11-07 レコード形式）。
3. レコードは上記「必須フィールド」に従う。生 PII / メッセージ id 不載。
4. 実際の upstream HTTP status は UNKNOWN のまま。合成 404/410 マーカは
   provider HTTP 証拠として扱わない（docs/operations.md:671, 680-682）。
5. 肯定的観測が得られた場合でも、正式マッピング（`deleted`への Snapshot
   変換）は C12 配線後に行う。失敗/不明は観測にも tombstone にもならない
   （C11-06、docs/operations.md:670）。
