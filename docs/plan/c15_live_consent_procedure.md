# C15 実アカウント OAuth 同意画面観測手順（人が実行する）

対象: Google カレンダー readonly MCP（pin `3.0.0-readonly.2`）を**実 Google
アカウント**に対して使い、同意画面のスコープ表示を人が自分の目で観測する手順。
自動化を禁じる既存決定は変更しない（docs/operations.md:2369 の Fresh OAuth 行、
docs/operations.md:1060 の「worker はブラウザ/OAuth/実カレンダーを起動しない」）。

## 0. 事前条件（この手順を始める前にすべて満たすこと）

1. ピン検証済みフォーク `$HOME/gcal-readonly`（`3.0.0-readonly.2`）が
   docs/operations.md:1097–1119 の検証スニペットで構築済み
   （`npm ci --ignore-scripts` → `npm run build` → `node build/index.js version`
   で `Google Calendar MCP Server v3.0.0-readonly.2` 表示まで確認）。
2. OAuth クライアントは **テストモード**（testing, user type External）、
   対象の実 Google アカウントが **テストユーザー** に追加済み
   （docs/operations.md:1065–1068 の設定ガイドに従う）。
   テストモードの許可は期限切れで再同意が必要になる — それは本手順の想定内
   （docs/operations.md:1068）。
3. 秘密情報はリポジトリ外: `GOOGLE_OAUTH_CREDENTIALS` と
   `GOOGLE_CALENDAR_MCP_READONLY_TOKEN_PATH`
   （docs/operations.md:1131–1135、run-google-readonly.sh:17–18 も同じ env を使う）。
4. 要求スコープは **readonly のみ**。pin は
   `calendar.events.readonly` のみをハードコード指定し
   （docs/google_calendar_readonly_binding_design.md:120）、
   広スコープ `GOOGLE_CALENDAR_MCP_TOKEN_PATH` は無視され、
   保存済みグラントのスコープが正確に
   `https://www.googleapis.com/auth/calendar.events.readonly` でない場合は拒否される
   （docs/operations.md:1137–1144）。

## 1. 既存許可の取り消し（Fresh OAuth の前段）

1. ブラウザで https://myaccount.google.com/permissions を開き、対象アプリの
   「アクセス権を削除」で既存グラントを撤回する。
   ※ 製品設定に依存する一般公開ページであり、pin コード外の手動操作。
2. トークンファイルを削除して再同意を確実化:
   `GOOGLE_CALENDAR_MCP_READONLY_TOKEN_PATH` を実行前に空にする（docs/operations.md:1132）。
   旧フルスコープトークンはそもそも pin で拒否されるが、残置は誤観測の元なので消す。

## 2. 再同意（Testing-mode re-consent / Fresh OAuth）

ユーザー自身の端末で対話的に実行する（docs/operations.md:1146–1154）:

```bash
node "$FORK_DIR/build/index.js" auth
```

- 既定ローカルアカウント（モード `normal`）。別ローカル ID の場合は
  `node "$FORK_DIR/build/index.js" auth work`
  （小文字 1–64 `[a-z0-9_-]`。ローカルキーであって Google アカウント名ではない、
  docs/operations.md:1149–1152）。
- フォークはループバックコールバック
  `http://localhost:<3500-3505>/oauth2callback` を提供しブラウザを開く
  （docs/operations.md:1153–1155）。テストモードユーザーの実 Google
  アカウントでログインして同意する。
- スコープ表示の観測点（ここが本手順の主目的）:
  同意画面に表示されるスコープが **`calendar.events.readonly` のみ** であること
  （docs/operations.md:1156、docs/google_calendar_readonly_binding_design.md:322）。
- 期限切れより等の理由で同意画面が再表示される場合、同じ手順で再同意する
  （docs/operations.md:1068: テストモード許可の期限切れは想定内）。

## 3. 中止基準（観測中に以下が出たら即中止・記録のみ）

1. 同意画面に表示されるスコープが `calendar.events.readonly` 以外を含む
   （書き込み可能スコープ、広い `calendar` スコープ、Calendar 以外の API 等）。
   pin は広スコードを拒否しているが（docs/operations.md:1140–1144）、
   **表示段階** でそれが見えたら先へ進めない。
2. callback ポート 3500–3505 以外の待受、環境外 URL への誘導（docs/operations.md:1153）。
3. 同意後のトークン検証で pin が許可グラントを拒否した場合
   （docs/operations.md:1142–1144）も結果を記録し、リトライを「無強制再同意」として
   行わない（docs/operations.md:1017 の `never force reconsent`）。

## 4. 記録するもの / してはならないもの

記録する:
1. 同意画面のスコープ一覧の **スクリーンショット**（URL はエクスプロイト誘導を
   弱めるため、ドメイン部のみ、クエリ/パラメータはマスク）。
2. トークンメタデータのみ（発行日時・アカウントモード
   `normal`/`work`・ファイルモード `0600` かどうか。docs/operations.md:1136）。
3. フォークバージョン文字列 `Google Calendar MCP Server v3.0.0-readonly.2`
   （docs/operations.md:1120–1121）。

禁止（決して記録しない）:
- トークン本文、refresh token、authorization code、コールバック URL 全文。
- 秘密 env 値（`GOOGLE_OAUTH_CREDENTIALS` 等）の内容。

## 5. 記録先

- docs/operations.md の "Live readonly acceptance ledger" 内
  「Fresh OAuth」行（docs/operations.md:2369）に、観測日・観測スコープ・
  スクリーンショット保存先（ユーザー私有ディレクトリ、リポジトリ外）を追記する。
- C15 未着手の現況記述（docs/operations.md:1015–1017、2369）を
  観測完了後に更新する。本ファイルは手順書であり、結果はそこに書く。
