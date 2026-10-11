# Companion browser resilience execution progress — current C06 acceptance — 2026-10-11

## Scope of this document

This document records **only the current 2026-10-11 local acceptance for the C06 accepted-202 active-run reload fix** on the Companion worktree. Remind / R05 / Phase 0 / plan-checklist history is intentionally excluded; that material remains in the primary full progress document. C04/C05 real-browser acceptance evidence is in [browser resilience execution](browser_resilience_execution_2026-10-10.md); the prerequisite provisioned baseline is in [provisioned browser baseline](provisioned_browser_baseline_2026-10-10.md).

## 2026-10-11 現行追記：C06 accepted-202 reload 修正実装と local acceptance

**この節が C06 の現行状態であり、上記の「修正未実装」「提案のみ」記述は履歴として supersede される。** 計画・チェックリスト・元の履歴記述は書き換えていない。Companion の現行 local worktree（未commit の harness/tests/docs 変更を含む）に対する **local acceptance のみ**であり、現行 HEAD を主張しない。M3/Phase 1 全体・Windows manual・現行 remote CI は未完了のまま。

| 項目 | 観測内容 |
| --- | --- |
| API 契約 | `GET /api/sessions/:sessionId/active-run` を追加：厳格 UUID path + 空でない query は許可しない。projection は `{ run: { id, turnId, status, eventSeq } }`（同 session の単一 queued/running/cancel_requested run）または `{ run: null }`（真の no-active response）。session 不在は先に 404。 |
| Product 動作 | boot 時 discovery → 既存 history render → 既存 active run へ re-subscribe/durable dedup を実装。補助 `canonicalRunStatus` は宣言どおり `{ status, eventSeq }` を投影。SSE 遮断時の reload では保存済み SSE resume hint と freshly reconstructed in-memory reducer cursor を区別する：`localStorage` に保存された resume hint `ch.cursor.<runId>` は `2` を観測したが replay の authority ではない；一方 reducer cursor は reload 時に in-memory で再構築され初期値 `0` で、JSON fallback replay は `0` の後から開始する（reducer cursor は localStorage と同一ではなく、保存済み cursor と等置しない）。保存済み resume hint が authority でないことの回帰 proof。 |
| Browser suite | rebound 後の full suite（`--trace on`, list,json）：初回 **17 pass / 4 fail**（失敗原因は spec が `toEqual` で status projection 全体を比較し、schema が正しく `run.id` を carry していたこと。helper を宣言 projection へ最小修正後、当該 spec 7/7、その上で authoritative な再実行 **21/21 pass / 0 unexpected/0 flaky/0 skipped**、duration ≈76.4s）。4 新規 C06 case：(a) 正常 accepted-202 の native reload、(b) discovery 前 completion が genuine な `{ run: null }` を history へ forward、(c) captured ACTIVE response の completion 後 forward（history 1 回・terminal replay dedup）、(d) 保存済み cursor `2` からの reload で SSE blocked 時の fallback が `0` の後から replay。追加 contract/server behavior tests +7、source-string tests −10 で unit は **88 files / 1086 tests pass**（元 1089 からの比率記録）。 |
| Static checks | Biome `check .` exit 0（C06 隣接3ファイルへ format/organizeImports 修正、最終 checked 185 files・preexisting info 1）、root `tsc --noEmit` exit 0、installed binary を直接使った `tsc --noEmit -p apps/server/tsconfig.e2e.json` exit 0（`pnpm typecheck:e2e` は等価 script だが意図的に起動していない）。green 後の product tests 再実行はしていない。 |
| Native CDP | `Browser.getVersion` = `HeadlessChrome/153.0.8010.12`（protocolVersion 1.3）。取得は download済 bundled browser の**standalone launch** からであり、full-suite の page から CDP を取得した主張ではない（full-suite trace 側は UA 一致の attach のみ観測時に限る）。 |
| 保持証拠 | `/tmp/opencode/c06-verify/archive`（out-of-repo）：`COMMANDS.md`（正確なコマンド）、`SHA256SUMS.txt`、`logs/`（`playwright.log`, `playwright-retry.log`, `playwright-final.log`, `vitest.log`, `tsc-root.log`, `tsc-e2e.log`, `biome.log`, `biome2.log`, `biome-write.log`, `browser-cdp-version.txt`）、`report/`（`browser.json`=初回 4-fail, `browser-retry.json`, `browser-final.json`=21/21 JSON stats）、`traces/`（`results-first-run-4-failed`, `results-retry-spec`, `results-final-21-passed` 全 trace）。SQLite/WAL/SHM・auth secrets なし。Tar.gz への再梱包はしていない。 |
| 使用した TMP scratch | `TMPDIR=/tmp/opencode/c06-verify/tmp`（owned）。他の `/tmp/opencode` 下は観測のみ（`c06-verify` のみ存在確認；unrelated dir は触らない）。 |
| 独立 review | 最終 read-only review 実施済み。残存 C06 defect なしと報告。review は test runtime とは別の独立実行であり、その pass を置き換えるものではない。 |
| 副作用 cleanup | worker 所有の throwaway CDP launch script（repo root の `.tmp-cdp-version.cjs`）を削除（該当ファイル消失を再確認済み）。app 4173 / control 4174 / proxy 4175 は listener-free を実測（listener 再起動なし）。 |

残り gate（2026-10-11 現在）：Phase 1/M3 全体、Windows 11 x64 manual smoke、uncommitted 変更への現行 Windows/Linux CI。C06 local acceptance はこれらを代替しない。

## 2026-10-11 追記：review 修正3件の再検証（current full-browser 23 run）

上の 21 run 記録は履歴として保持する。以下は同じ nested worktree（`.pr-review/pr11`、branch `feat/c04-c05-c06-browser-reload`、uncommitted の review 修正を含む）に対する **現行の再検証**であり、HEAD を主張しない。

| 項目 | 観測内容 |
| --- | --- |
| Review 修正 | (1) citation snapshot privacy 断言を復元（localStorage の生値を `CITATION_SNAPSHOT_TEXT` と直接比較、`JSON.stringify` の vacuous 化を排除）。(2) recovery 時に `activeRunId`/composer busy を final history hydration の**前**に設定し、held history 中も送信不可・Stop 表示・input enabled を保証。(3) discovery が `cancel_requested` を carry し、native subscription 前に reducer cursor `0` の initial 非terminal「停止しました」notice を seed（subscription は hydration 後へ deferred）。 |
| 新規 browser 回帰 | (a) held-history send guard：recovered active run が history hydrate 前に composer を占有し submit を拒否。(b) cancel_requested saved cursor `3` からの reload snapshot → release 後 native stream が `after=3` で resume し cancel_requested replay なしで real `cancelled` seq 4 に到達し cursor `4`。 |
| Static / unit | Biome 初回 exit 1（新 spec の format 1件のみ）→ format-only 最小修正 → 再実行 exit 0（checked 185 files、preexisting info 1）。root `tsc --noEmit` exit 0、`tsc --noEmit -p apps/server/tsconfig.e2e.json` exit 0、`vitest run` exit 0（**88 files / 1086 tests pass**）。 |
| Full browser | installed root の Playwright CLI を直接起動（`--trace on`, list,json, CWD worktree/apps/server, worktree config）。**23/23 pass / 0 unexpected / 0 flaky / 0 skipped、duration ≈79.0s**（JSON stats duration 78972.359ms）。webServer は実際の変更 UI を esbuild し temp SQLite + fake RunEngine を loopback 4173/4174/4175 で起動。trace 23 本。 |
| Native proof | standalone bundled launch の Chromium = `HeadlessChrome/153.0.8010.12`（UA `HeadlessChrome/153.0.8010.12`）。 |
| 環境注記 | git worktree には node_modules が無いため、検証中のみ worktree 内に installed root deps への node_modules symlink を作成（packages は primary と byte-identical を確認済み、install なし）。証拠保持後に当該 symlink は削除済み。 |
| 保持証拠 | `/tmp/opencode/pr11-review-run`（out-of-repo）：`COMMANDS.md`、`SHA256SUMS.txt`、`logs/`（`biome.log`, `biome-rerun.log`, `tsc-root.log`, `tsc-e2e.log`, `vitest.log`, `playwright.log`, `chromium-version.txt`）、`browser.json`（23/23 JSON stats）、`results/`（23 traces）。SQLite/WAL/SHM・auth secrets なし。 |
| 副作用 cleanup | app 4173 / control 4174 / proxy 4175 は run 前後の listener-free を実測。primary worktree の source/index/branch は不変。 |

現行 review 修正に対する独立 read-only review の結果は未受領（parent が独立実行）。本 23 run はそれを置き換えない。

## 2026-10-11 追記：review 修正への独立 read-only review 結果

独立 read-only review（oc21、parent 実行、上記 23 run とは別実行）を実施した。前節の 3 review 修正——(1) citation snapshot privacy 断言の復元、(2) held-history 中の recovered active identity / composer busy 先行確保、(3) discovered `cancel_requested` の carry と cursor 0 の非 terminal 停止 notice seed——および 2 新規 genuine 回帰（(a) held-history send guard、(b) saved cursor `3` からの cancel_requested reload → real `cancelled` 4）に対し、残存する consumer-visible defect は検出されなかった。任意の追加 hardening（localStorage 生値の JSON-escape 変種による privacy 断言、production 3s cancel watchdog に対する test timing 感度）は non-required / out of scope と評価し、本修正では拡張していない。本 23 run の証拠を置き換えるものではないが、3 fix + 2 regression に既知の未解決 consumer bug はない。

## 2026-10-11 現行追記：C07 集約 gate（current E2E + tests + typecheck:e2e + Windows/Linux CI）

上の C06 local acceptance / 23 run / 独立 review 記録は履歴として保持する。以下の C07 matrix は、PR #11 review code の authoritative head `56b7952a7e8adc2e0dcc4b5a4658feb589723cd1`（merge `e6b53536fa4cf8790a6dfa8a136d92cc01a47c76`、2026-10-11T02:57:46Z）に対する **remote CI 集約 evidence** である。これを超える後続 HEAD を主張しない。過去の CI green は流用していない。観測した run: pull_request `38106715359` / push `38106713796`（両方 completed / success、run_attempt 1）。

| C07 | 観測内容 |
| --- | --- |
| C07-01 `[確認]` | current E2E source count：4 spec の static `test()` call site = citation_recovery 9 + conversation 4 + polling 4 + sse_history 5 = 22。`sse_history.spec.ts:447` が parameterized で 2 case を生成 → 現行 source は **23 case**。既存 12/17 は履歴 snapshot として分離（本節の authority ではない）。 |
| C07-02 `[検証]` | current E2E 実行 report から採取：両 e2e job とも `Running 23 tests using 1 worker` → **23 passed / 0 failed / 0 skipped**（各約 1.3m）。source count を executed proof に代用していない。 |
| C07-03 `[検証]` | root lint（Biome `check .`）：両 run とも `Checked 185 files in 636ms`、`Found 1 info`（`biome.json:17` の deprecated `recommended` field、preexisting）、error 0、exit 0。 |
| C07-04 `[検証]` | root `pnpm typecheck` = `tsc --noEmit -p tsconfig.json`（`apps/server` の src/test を含む）exit 0。dedicated `pnpm typecheck:e2e` = `tsc --noEmit -p apps/server/tsconfig.e2e.json` は e2e job の `E2E typecheck (harness + spec + config)` step として **別 check** で green。専用 server-only CI typecheck は存在しない（root が server を包含）。 |
| C07-05 `[検証]` | Browser E2E：実 Chromium、pull_request / push 両 e2e job で 23/23 pass。source count や typecheck 結果を実行の代替にしていない。 |
| C07-06 `[検証]` | Windows/Linux CI：tested SHA `56b7952a…` に対し pull_request `38106715359` / push `38106713796` が completed / success。job は `check (ubuntu-latest)`、`check (windows-latest)`、`e2e`（両 run 合計 e2e x2）すべて green。historical green を流用していない。 |
| C07-07 `[記録]` | browser 未実行理由は該当なし：両 run で E2E step が実際に実行（`pnpm --filter @companion/server test:e2e`）。Windows の 2 skip は browser ではなく unit の platform 条件で、`packages/connector-markdown/test/safe_read.test.ts` の (1) `reads a POSIX colon filename (notes:2026.md)`（Windows は colon filename segment を作成不能）、(2) `rejects a composed-key retarget to a decomposed internal target on POSIX`（NTFS の名前正規化により composed/decomposed が共存不能）。集計は Windows **1084 passed / 2 skipped (1086)**、Ubuntu **1086 passed / 0 skipped**。 |
| C07-08 `[記録]` | README を実測後に更新：tested SHA、run URL、job/check 名、counts、Windows 2 skip、23 source vs executed、root vs dedicated e2e typecheck を現行 C07 aggregate evidence として明記。未確認の「実行済み」主張はしない。README の local 21/23 と歴史 12/17 文脈は保持。 |

### C07 残り gate

Phase 1/M3 全体、Windows 11 x64 manual smoke、M4/Phase 4 live adoption は未完了のまま。本 C07 evidence が閉じるのは PR #11 review code（`56b7952a…`）の remote CI だけであり、`docs: record current C07 …` という本 docs commit 自体の CI は **未観測（pending until observed）**で、この remote CI を流用しない。本節は product/source/config/dep 変更を含まない docs-only 更新であり、green 後の product tests は再実行していない。
