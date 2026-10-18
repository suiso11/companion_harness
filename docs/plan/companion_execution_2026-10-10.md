# Companion Phase 0 execution evidence — 2026-10-10

This is current evidence for `/home/molmot/companion_harness`, not an update to agreed plans/checklists or a claim that M3 is complete. No product source changes were made.

## G01 current repository snapshot

Initial useful shell command (ordinary cwd/status capture; did not repeat the historical WSL failure):

```sh
pwd && git status --short --branch && git rev-parse HEAD && git branch -vv && git worktree list --porcelain && git show-ref --heads --tags && git remote -v
```

Exit 0. Root `/home/molmot/companion_harness`; branch `feat/m4-readonly-fork-adoption`; HEAD `773132af27be9ddb06d4d4784197fba8b322185d`; tracking `origin/feat/m4-readonly-fork-adoption` at the same SHA. `master`/`origin/master` are `4dd96d0bd5205fb8857d0c28329755654ce02800`. One worktree, root above, branch/HEAD above; no linked Companion worktrees or tags reported. Remote origin fetch/push URL `https://github.com/suiso11/companion_harness.git`.

Additional exact commands:

```sh
git merge-base HEAD master && git rev-list --left-right --count master...HEAD && git rev-parse origin/master origin/feat/m4-readonly-fork-adoption && node --version && pnpm --version && npm --version && uname -srm
```

Exit 0: merge-base `52adcdcf5f029696a499334544ac9803ce55cb45`; left/right count `1 2` (one master-only, two HEAD-only). Neither branch is ancestor of the other; current feature work is not integrated into current master.

```sh
date --iso-8601=seconds && git rev-parse --show-toplevel --git-dir --git-common-dir && git diff --name-status && git diff --cached --name-status && git ls-files --others --exclude-standard && git merge-base --is-ancestor master HEAD; printf 'master_is_ancestor_exit=%s\n' "$?"; git merge-base --is-ancestor HEAD master; printf 'HEAD_is_ancestor_exit=%s\n' "$?"; command -v node pnpm npm; printf 'SHELL=%s\n' "$SHELL"
```

Snapshot timestamp `2026-10-10T16:12:23+00:00`; root above, gitdir/common gitdir `.git`; staged, unstaged and untracked captures separately empty. Both ancestry probes exit 1. Node/pnpm/npm each resolve under `/home/molmot/.local/bin/`; `SHELL=/bin/bash`. There were no pre-existing Companion dirty changes to overwrite. No merge/cherry-pick/push/stash/clean/reset was performed. Historical plan SHA `4e74d2d...` is not treated as current. Remind root/worktrees and `.tmp-t6` authority remain the separate Remind worker's evidence; no old T4/T1–T6 counts are imported here.

## Agreed requirements and inspected files

Read README, `docs/plan/active_projects_plan.md` scope/Phase 0–1 priorities, detailed `active_projects_tasks.md` G01/G02 and C01–C07, and agreed `docs/implementation_plan.md` M0 queue/CAS/API/acceptance (§9, §12–13), M1 identity/scope/acceptance (§14), M2 scope/local gateway/acceptance (§15), and M3 UI/SSE/recovery/localStorage exact contracts (§16). Planning snapshots were not used as execution proof; no agreed source plan or checklist state was changed.

Concrete UI/harness/test and execution contracts are below. Tests use existing fake strategies/loopback and temporary/in-memory stores; no live LLM/MCP/Calendar/OAuth or real user DB was used.

## G02 environment/dependencies/freshness

Runtime command above measured Node `v24.12.0`, pnpm `11.25.0`, npm `11.6.2`; Linux `7.0.0-38-generic x86_64`. Node/pnpm exactly match root and server `package.json`/README requirements. Root installed package resolution measured Biome `2.5.12`, `@playwright/test` `1.63.0`, TypeScript `5.9.3`, Vitest `3.2.4`; server installed better-sqlite3 `13.0.3`, esbuild `0.28.2`, tsx `4.20.6`, Hono `4.13.5`, matching declarations. Installed `.pnpm/lock.yaml` and repository `pnpm-lock.yaml` both SHA-256 `30d1f011437e787e840c5dfbc15ef495b6d9bf7b0178d802b3b0f3d385288914` before and after baseline. Native SQLite/esbuild availability is exercised by passing unit tests and E2E harness build/start, not inferred merely from package presence.

Read-only Node `createRequire` package/version inspection first returned `ERR_PACKAGE_PATH_NOT_EXPORTED` for `hono/package.json`, then exited 1 when root `require('playwright')` could not resolve a direct undeclared package. These are exploratory lookup mistakes, not missing declared dependencies or baseline failures. Corrected lookup used installed `@playwright/test` browser exports and Hono's resolved package location; exit 0.

No explicit install command, dependency addition, lock update, or browser download was issued. Important unexpected pnpm 11 side effect: the first `pnpm lint` invocation emitted an automatic workspace freshness/install check (`Scope: all 8 workspace projects`, `Lockfile passes supply-chain policies`, `Lockfile is up to date, resolution step is skipped`, `Already up to date`, `Done in 1s`) before the lint script. This is transparently recorded rather than asserting that no install machinery ran. No packages were reported added and before/after lock hashes match. Subsequent checks emitted their scripts only. Future strictly no-install runs should bypass pnpm's automatic install mechanism using the installed binaries or a separately confirmed disabling configuration.

UI is source-run TS; `scripts/build-ui.mjs` bundles `src/ui/client.ts` into ignored `dist/assets/client.js` and copies `client.css`. Both generated assets were missing before baseline (source mtimes `2026-10-10T14:02:45.560Z`). Standard E2E webServer generated the permitted assets: JS `2026-10-10T16:15:08.470Z`, CSS `2026-10-10T16:15:08.471Z`; build reported JS 18.2kb / 3ms. No separate unnecessary build was run.

Browser discovery:

```sh
command -v chromium chromium-browser google-chrome google-chrome-stable firefox; printf 'browser_lookup_exit=%s\n' "$?"
```

No executable found (lookup exit 1). Read-only glob inspection of `.cache`, `/opt`, `/usr/bin/*chrom*`/`*firefox*`, and recursive browser-cache `chrome`/`headless_shell` paths found no existing browser cache or alternate system Chromium. `PLAYWRIGHT_BROWSERS_PATH` unset. Installed Playwright expected Chromium `/home/molmot/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`, Firefox `/home/molmot/.cache/ms-playwright/firefox-1543/firefox/firefox`, WebKit `/home/molmot/.cache/ms-playwright/webkit-2359/pw_run.sh`; each missing. Actual configured headless launch path is separately recorded below. No alternate executable override or temporary config was needed because no candidate exists.

## Baselines executed once, sequentially

Working directory for all commands `/home/molmot/companion_harness`; environment overrides `TMPDIR=/tmp/companion-baseline-20261010-_g4aa_x8`, `CI=true`. `TMPDIR` was a newly generated worker-owned isolated temporary directory. Commands were run sequentially by Python `subprocess.run(..., timeout=300, stdout=PIPE, stderr=STDOUT)`; no test/lint/typecheck/formatter ran during investigation. The following table preserves the exact commands, observed exit codes and elapsed times; the browser prerequisite error and independent CI job evidence are recorded below. Raw captured output is not duplicated in this repository evidence.

| Exact command | Exit/result | Elapsed |
|---|---|---|
| `pnpm lint` | 0; Biome checked 182 files, no fixes; one informational existing config deprecation (`linter.rules.recommended`, use preset) | 1.85s |
| `pnpm typecheck` | 0; `tsc --noEmit -p tsconfig.json`; root includes apps/packages source and unit tests | 4.47s |
| `pnpm typecheck:e2e` | 0; `tsc --noEmit -p apps/server/tsconfig.e2e.json`; distinct E2E harness/spec/config coverage | 2.60s |
| `pnpm test` | 0; Vitest 3.2.4, 87 test files / 1089 tests passed; includes real SQLite/fake integration, M3 unit/source-contract tests 28 passed | 10.59s |
| `pnpm --filter @companion/server test:e2e --output=/tmp/companion-baseline-20261010-_g4aa_x8/playwright-results` | 1; configured production bundle and real fake-backed Hono server/control/proxy started; 12 Chromium cases scheduled, each failed at browser launch; **0 browser test bodies exercised** | 7.50s |

E2E uses repository Playwright configuration (one worker, retries 0, all three files); only artifact output was redirected to the worker's temporary directory, no repository test/config changes. Root `test:e2e` lacks the server config flag; use the documented server-filter command above. Browser/E2E is Playwright here, not a separate Vitest browser suite: root Vitest has `environment: node`.

Exact E2E prerequisite error:

```text
Error: browserType.launch: Executable doesn't exist at /home/molmot/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell
Running 12 tests using 1 worker
12 failed
```

Classify this as a failed runner command with **browser acceptance unavailable**, not 12 product-behavior failures and not 12 browser executions. No downloads or retries were performed. Source count independently remains four `conversation.spec.ts`, three `citation_recovery.spec.ts`, five `sse_history.spec.ts` (two generated corrupt-cursor variants included): 12.

Unit fixtures were inspected for `:memory:` databases and `mkdtemp(tmpdir())`; E2E `server.ts:71–79` creates temporary `companion-e2e-*` DB, registers deterministic fake `m0-default`, with no external data. After all processes returned the worker removed its own isolated temporary root (including remaining E2E DB, browser profiles and result artifacts); existence check returned false. This also removed test fixture directories whose existing tests do not clean up themselves. No real DB was opened, backed up, imported or migrated. UI generated assets remain as the only intended repo build output; no source edits.

## Current CI and unavailable support evidence (separate from local browser)

Current HEAD CI was available, not merely historical README green. Read-only GETs:

- `https://api.github.com/repos/suiso11/companion_harness/actions/runs?head_sha=773132af27be9ddb06d4d4784197fba8b322185d&per_page=10`
- `https://api.github.com/repos/suiso11/companion_harness/actions/runs/38066151257/jobs`

[Current run 38066151257](https://github.com/suiso11/companion_harness/actions/runs/38066151257) is `completed/success`, exact HEAD above, created `2026-10-10T16:04:11Z`, updated `16:06:32Z`. REST job evidence:

| Job / platform | Job ID | Conclusion | Completed UTC |
|---|---|---|---|
| `check (ubuntu-latest)` / ubuntu-latest | 114254092863 | completed/success; lint/typecheck/test steps success | 16:05:13 |
| `check (windows-latest)` / windows-latest | 114254092926 | completed/success; lint/typecheck/test steps success | 16:06:31 |
| `e2e` / ubuntu-latest | 114254092667 | completed/success; dedicated E2E typecheck, production UI build and `Smoke E2E (chromium, real browser, temp DB only)` steps success | 16:05:12 |

This CI covers the inspected HEAD only, not future changes. **Unavailable detailed CI execution evidence:** GET `https://api.github.com/repos/suiso11/companion_harness/actions/jobs/114254092667/logs` returned HTTP 403 unauthenticated. Therefore exact remote executed per-test count, traces and remote browser version are unverified; job/step success is the supported claim. Twelve source cases are not substituted for remote execution counts.

**Unavailable Windows manual support gate:** Linux host cannot exercise Windows 11 x64 manual smoke with its required dedicated temporary store. No Windows manual smoke was performed. `windows-latest` CI is separate and does not replace this gate. Local Linux unit pass does not substitute for Windows either.

## Coverage map and first implementation recommendation

### C04: existing fallback, missing dynamic real-browser acceptance

- Existing implementation `apps/server/src/ui/client.ts:717–800`: native EventSource subscription; if no valid run-event arrives, 5000ms timer closes stream and starts fallback (constructor failure starts immediately).
- `client.ts:935–989`: existing JSON `GET /api/sessions/:sessionId/runs/:runId/events?after=&limit=50`, finite pages per catch-up; non-2xx/transport errors return false; reducer applied before `runViews` update then cursor store.
- `client.ts:999–1044`: existing sequential `await catchUp` + 1000ms delay loop, **no tick cap**, five consecutive failures fixed notice `状態の取得に失敗しました。再読み込みしてください`; successful fetch resets streak; run disposal/terminal ends loop; no cancel call in fallback.
- Terminal view renders once/claims one terminal history refresh (`renderedAnswers`, `claimTerminalHydration`, lines 1046–1109); `run.cancel_requested` remains nonterminal (`reducer.ts`, view generating with stopVisible true).
- Existing unit/source-contract coverage `apps/server/test/m3_ui.test.ts:452–486` tests reducer's nonterminal cancellation invariant; `:675–682` checks source strings for failures/reset (not dynamic scheduling/I/O/browser coverage). No existing dedicated fallback E2E.
- Existing harness `e2e/server.ts:408–592` real fault proxy counts SSE/events/status, drops one seq and destroys established sockets. Control routes `/reset`, `/arm-fail`, `/release` and deterministic `TEXT_HANG` already exist; `/release` is sticky. Existing fake engine cancellation grace 50ms (`:173–179`) must be accounted for when trying to observe a stable cancel_requested interval.

**First scope:** extend only fake E2E proxy/controls and existing E2E spec/config pattern to reject/prevent initial SSE establishment, optionally fault/delay real events-page transport, and record request begin/end/max-in-flight. Add real-browser cases for continued polling beyond several normal intervals until real terminal completion; transient errors followed by reset/recovery; exactly five consecutive failures then stable no-more-request count plus fixed notice; no-overlap under delayed requests; server Run remains active despite transport/UI input/history actions (no implicit cancel); deliberate contextual stop has a separately observable nonterminal cancel_requested interval until cancelled. Use existing real routes and fake strategy, not mocked successful JSON; ensure deterministic test-only timing for cancel_requested. Do not rewrite client polling or expand API/storage. Only a dynamically demonstrated root cause warrants product fix.

### C05: duplicate reducer already covered; real duplicate injection missing

- `apps/server/src/ui/reducer.ts:127–145` returns unchanged state/ignored-duplicate for `seq <= cursor` and needs-catchup for gaps. `client.ts:857–927` serializes applications; duplicate returns without cursor write/re-render; applied state is stored then cursor persisted; unknown types advance cursor only. Catch-up `:935–989` handles duplicate pages without store/rerender.
- Existing `m3_ui.test.ts:261–287`, `:398–450` cover duplicate/gap/unknown, convergence and terminal re-seen; pure reducer proof is not browser/DOM/persistence proof.
- Existing `e2e/sse_history.spec.ts:175–226` exercises native stream drop/reconnect with Last-Event-ID and one answer, real Run not cancelled. `:230–278` already covers dropped seq2, actual JSON gap request, finite saved cursor <= authoritative eventSeq, one answer. `:284–419` covers ahead/malformed cursor; `:425` older history. These covered paths should be reused, not duplicated.
- Proxy `server.ts:543–565` parses and forwards complete real SSE frames; ideal addition is an armed **byte-for-byte duplicate forwarding** mode plus counter, including terminal frame repeated in same received batch, without fake RunEvent generation/DB insertion.

**First scope:** add armed real-frame duplication before terminal and terminal duplication to the existing proxy; assert one answer/citation/retry/terminal history-refresh effect, no extra cursor write for duplicate, correlate authoritative events/status and proxy counters. Strengthen existing gap/reconnect test with a gated real JSON catch-up response: while gap is unresolved cursor must not advance past missing event; after release it converges, and reconnect must not skip unapplied sequence. Persistence follows reducer application, **not necessarily DOM rendering** (`storeCursor` occurs before `renderRunView`), so do not assert an invented DOM-before-storage contract. Preserve existing reducer unit tests and current APIs. Need a compatible preinstalled browser or separate authorization/environment for browser acceptance.

### C06: accepted 202 reload investigation only, not a confirmed bug

`client.ts:604–612` clears pending key after normal accepted response and subscribes the in-memory run; boot (`:178–195`) recovers only pending then hydrates history. `recoverPending` (`:257–315`) can rediscover a run from accepted lookup while pending key still exists. `HistoryItemView` (`:26–38`), repository `getHistory` (`packages/kernel/src/repository.ts:1287–1366`), and history route expose turns + selected completed result only, no active run descriptor. Existing known-run status `apps/server/src/app.ts:846–870` exposes id/status/eventSeq but requires runId; it does not discover an unknown active run.

Existing `e2e/citation_recovery.spec.ts:123–230` intentionally loses POST response, preserves pending key, same-body/key replays accepted response, then reloads; this is **not** normal 202-received active reload coverage. Normal accepted 202→wait for pending clear + server running `TEXT_HANG`→reload→observe UI subscription/input state→release→compare server terminal events and browser result is the distinct required investigation. It was not executed because no real browser is available; source analysis suggests a discovery gap, **not confirmed reproduction**. Existing cursor keys might provide run IDs only after at least one applied frame and thus are not a justified universal recovery contract. Do not add activeRun/body/new storage or new API independently. If reproduction requires API discovery, propose minimal contract to parent for agreement before implementation; C04/C05 remain the initial bounded scope.

## Gate disposition

Companion G01 current branch/clean/worktree/ancestry evidence recorded. G02 local static/unit checks pass; configured runner attempted once but real-browser baseline remains unavailable locally; current exact-HEAD Linux/Windows CI job/step success is independently recorded, remote per-test detail and Windows manual smoke remain unavailable. No claim closes C04/C05/C06 or full M3. Recommended next implementation is fake harness + real-browser C04/C05 coverage only, with source fixes solely for exposed root causes; no API/localStorage expansion.
