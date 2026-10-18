# D1 Windows 11 x64 手動 smoke 手順（§19.6 サポートゲート）

目的: docs/implementation_plan.md §19.6 の Windows 11 x64 手動 smoke
（docs/implementation_plan.md:1645–1658）を支援ゲートとして実行する。
現況は「Windows 11 x64 manual smoke **NOT EXECUTED**」（docs/operations.md:2368、
docs/operations.md:291 と 343 も手動 smoke 未完を明記）。本書は人が PowerShell で
実行する手順であり、docs/operations.md:1217–1222 の PowerShell 差分
（`export X="..."` は `$env:X="..."`）に従う。

## 0. ピン確認（他の SQL/Node が混ざらないよう最初に行う）

1. リポジトリ checkout の `node -v` / `pnpm -v` が以下と一致すること:
   - Node **24.12.0**（package.json engines `node`、package.json:8、`.node-version`）
   - pnpm **11.25.0**（package.json `packageManager`/engines `pnpm`、package.json:6,9）
2. 不一致なら本手順を中断し、バージョン差を記録する（ピン変更はしない）。

## 1. ソースランの依存インストール（better-sqlite3 ビルド確認）

1. `pnpm install` を実行。better-sqlite3（ネイティブモジュール）は
   リリースゲート §19.6 でプラットフォームでのビルド・取得確認が必須
   （docs/implementation_plan.md:1658）。
2. 確認: `node -e "const db=require('better-sqlite3')(':memory:');db.exec('select 1');console.log('ok')"`
   が `ok` を出すこと（prebuilt取得 or ローカルビルド成功）。

## 2. ループバック限定起動・停止

1. `pnpm start`（= `pnpm --filter @companion/server start`、package.json:12）。
   `apps/server` は `tsx src/index.ts` + `prestart: node scripts/build-ui.mjs`
   （apps/server/package.json:8–9）。
2. Model/Calendar 未設定での起動は §19 の実績どおり fail-closed だが
   health とポートは検証可能（README.md:1306–1308、run-google-readonly.sh:9–11）。
   `GET /health/live` / `GET /health/ready` が 200
   （README.md:1649 の §19 source-run 実績形式に合わせ記録する）。
3. 待受が **ループバックのみ** であること（127.0.0.1/localhost のみ、
   README.md:916、README.md:1220、README.md:558/561）。`netstat -ano` 等で
   リッスンアドレスが `127.0.0.1:<port>`（既定 `:3000`、README.md:1281）に
   限定されていることを記録する。
4. Ctrl+C で停止し、プロセスが残らないこと（onclose/persist は Linux 実績，
   docs/operations.md:1495）。

## 3. 読み取り専用動作

1. Actions は明示オプトインなしでは無効。ランチャーは
   `COMPANION_ACTIONS_JSON` を意図的に unset して起動する
   （run-google-readonly.sh:7・24）。手動 smoke も **Actions env を設定せず**
   起動し、書き込み系操作が opt-in 無しで実行されないこと（run-google-readonly.sh:8）。
2. （任意）Calendar readonly 冒頭検証が必要なら §代表性手順
   docs/operations.md:1146–1156 の同意後に `run-google-readonly.sh` を使う。
   ただし本 smoke の必須範囲外（curl 初回同様、Google/OAuth 不可の
   docs/operations.md:1219–1222 差分参照）。

## 4. 基本チャット実行（local model は設定した場合のみ有効）

1. Plan に従いローカルモデルを env で明示設定する。
   例（README.md:1293–1297 / 1303–1307）:

   ```powershell
   $env:COMPANION_MODEL_JSON='{"adapter":"ollama","baseUrl":"http://127.0.0.1:11434","model":"llama3.1"}'
   ```

   （OpenAI-compatible でも可: README.md:1303–1307。baseUrl は loopback に限る、
   README.md:1220。）
2. UI をブラウザで開き（http://127.0.0.1:3000、README.md:1281）、
   基本チャット 1 往復（質問→回答→session 停止）を記録する。
3. モデル未設定のままでも Run はフェイク回答を生成せず fail-closed
   （README.md:1310–1312）。未設定起動はモデルなしで health 検証までを記録。

## 5. Remind Windows 手動チェック

1. pinned remind ソースのビルド: `suiso11/remind@fbc928686be9d6558f903e02494a043a434d1497`
   （docs/operations.md:284–287）を `.ci/remind` 相当ディレクトリに checkout し
   `npm ci` + `npm run build`。
2. tempDB CLI smoke: `COMPANION_MEMORY_TEST_ENTRY` /
   `COMPANION_MEMORY_TEST_CONFIG_TEMPLATE` をビルド済みエントリ＋
   テンプレートに設定し（docs/operations.md:287–290）
   `pnpm exec vitest run apps/server/test/memory_live_http.test.ts` を実行
   （docs/operations.md:278–280；CI 実績 1/1 パス ~16s、docs/operations.md:291）。
   テンプレは一時ディレクトリの temp DB を指す post-conf 構成
   （docs/operations.md:273–276 の REAL remind CLI tempDB 形式）。
3. 参考: I05 相当ライブ smoke 実績
   （real HTTP + synthetic gateway + REAL remind CLI tempDB、docs/operations.md:2370）。
   Windows 手動ではこの 1 テストを「CLI 起動→recall 応答」最小構成で確認する。

## 6. エビデンスチェックリスト（記録必須）

- [ ] Node/pnpm バージョン出力（ピンと一致）
- [ ] better-sqlite3 ロード確認出力
- [ ] `pnpm start` 標準出力（migrated/recovered/listening、README.md:1649 の形式）
- [ ] /health/live・/health/ready の 200（`curl` 相当）
- [ ] netstat 待受アドレス一覧（loopback のみ）
- [ ] 停止後プロセス消滅の確認
- [ ] チャット 1 往復の結果（モデル有無の明記）
- [ ] remind: `npm run build` 成否 + `memory_live_http.test.ts` 結果

## 7. 記録先

- docs/operations.md の「Windows 11 x64 manual smoke」行（docs/operations.md:2368）に
  実行日・結果・未達項目を追記する。NOT EXECUTED からの更新は §19.6
  サポートゲートの条件を満たす場合のみ（docs/implementation_plan.md:1656）。
