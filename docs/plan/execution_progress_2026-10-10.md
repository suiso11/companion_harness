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
