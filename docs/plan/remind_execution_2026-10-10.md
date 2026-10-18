# Remind current execution evidence — 2026-10-10

## Scope and authority
Read [active_projects_plan.md](active_projects_plan.md) G01/G02/R05 and [active_projects_tasks.md](active_projects_tasks.md) gate contracts. This report records the pre-regression baseline; no source, plan, checklist, lock, dependency, or real DB edits occurred during that baseline. Subsequent R05 execution is recorded separately in [remind_r05_execution_2026-10-10.md](remind_r05_execution_2026-10-10.md).

The plan's `.tmp-t6` location and old branch snapshot are stale in this environment. `/home/molmot/remind/.tmp-t6` is absent and git lists only root. Current root `/home/molmot/remind/plan.md` explicitly declares autonomous associative memory authoritative, replacing the old approval plan. Root docs/acceptance-manifest.md explicitly uses M1 A1–A7, not legacy A1–A13. Master commit is the merged M1 PR. Parent accepted current root as migrated authoritative M1 checkout for baseline. No missing worktree was recreated, checked out, or treated as an implementation blocker.

## G01 observed state and commands
Ordinary useful shell command `pwd` succeeded, output `/home/molmot`; no historic shell failure was rerun.

Initial command:
```sh
pwd && git -C /home/molmot/remind status --short --branch && git -C /home/molmot/remind worktree list --porcelain && git -C /home/molmot/remind show-ref && git -C /home/molmot/remind/.tmp-t6 status --short --branch && git -C /home/molmot/remind rev-parse HEAD && git -C /home/molmot/remind/.tmp-t6 rev-parse HEAD && git -C /home/molmot/remind merge-base HEAD t6
```
Exit 128 at absent `.tmp-t6`; subsequent chained rev-parse/merge-base commands did not run. Worktree output: root `/home/molmot/remind`, HEAD `12a2ffdd3cd6cdf2f6167b1a25da97dc24bd2382`, branch `refs/heads/master`; no other linked worktrees. Status: `## master...origin/master`, unstaged `M package.json`, unstaged `M src/cli.ts`, untracked `tests/cli-entry.test.ts`.

Actual refs from `git show-ref`:
- refs/heads/master, refs/remotes/origin/master, refs/remotes/origin/HEAD: 12a2ffdd3cd6cdf2f6167b1a25da97dc24bd2382
- origin/feature/autonomous-memory-m1: fd875bb719b211fbf18a8a4a2e4fc055c941fdd2
- origin/feature/mvp-t5-t6: 262b7c0c35c697edc1bfcb2b695924d0d12113ce
- origin/feature/t2-approval-store: 2e909488b71ad659e6f3b2778d2063133a2c5ed7
- origin/feature/t3-deterministic-recall: a85ece59e22b0001339d00e2ffaa0d615c365a36
- origin/feature/t4-correction-archive: 82abcfb5cb3569c03bc7e86b653ccfb8e36f12f1
- origin/fix/pr2-deadline-scope: 7cfc318f886cf933bba9263a7ae286ff4e1fb111
- origin/plan/autonomous-memory: 148ffa80786756cdb32704ea2cbc7fa88c378b70
- origin/revert-4-feature/mvp-t5-t6: 05f12a0be0f0f6bf1dd716bc9907355831d4138e
- origin/review/t2-base-t1: 96b3728d001594628181875128bfa0c0c526c678

Follow-up command (cwd root):
```sh
git rev-parse --show-toplevel --git-dir --git-common-dir HEAD && git diff --name-status && git diff --cached --name-status && git ls-files --others --exclude-standard && git merge-base master origin/feature/autonomous-memory-m1 && git log -1 --format='%H %s' master && git log -1 --format='%H %s' origin/feature/autonomous-memory-m1 && node --version && npm --version && pnpm --version
```
Root `/home/molmot/remind`, gitdir/common-dir `.git`, HEAD `12a2ffdd3cd6cdf2f6167b1a25da97dc24bd2382`. Unstaged files as above; staged output empty; untracked `tests/cli-entry.test.ts`. Merge-base equals `fd875bb719b211fbf18a8a4a2e4fc055c941fdd2`. Master subject: `Merge pull request #7 from suiso11/feature/autonomous-memory-m1`; remote M1 subject: `fix: address autonomous memory review findings`. Separate `git merge-base --is-ancestor origin/feature/autonomous-memory-m1 master` exited 0. This proves that recorded remote M1 commit is ancestor of root master; no ref-existence-only integration inference.

All dirty files are user-owned, ownership/intent otherwise unknown; preserved. Baseline includes these existing changes, especially CLI entry test. No merge/cherry-pick/push/stash/clean/reset performed. No real memory.db opened, imported, or migrated. No product edits performed.

## G02 runtime/dependencies/freshness
Node `v24.12.0`, npm `11.6.2`, pnpm `11.25.0` (obtained `pnpm --dir /home/molmot --version`). Root-local `pnpm --version` exited 1 with `[ERROR] This project is configured to use npm`; package manager boundary, not missing pnpm or failed test.

Root package engines `>=24.12.0 <25`, packageManager npm@11.6.2. `npm ls --depth=0` exit 0: @types/node@24.10.1 and typescript@5.9.3 installed, matching dependency pins in package and lock. Lock root bin points at `dist/cli.js`, while dirty package bin points at `dist/src/cli.js`; metadata mismatch reported, not repaired because existing changes are protected. No install or lock update.

Pre-build `stat -c '%n %y' src/cli.ts dist/src/cli.js src/store.ts dist/src/store.js node_modules/typescript/package.json node_modules/@types/node/package.json`:
- src/cli.ts 2026-10-10 14:44:07.151284318 +0000
- dist/src/cli.js 2026-10-10 14:44:32.736307983 +0000
- src/store.ts 2026-10-10 14:43:17.461065750 +0000
- dist/src/store.js 2026-10-10 14:44:32.720307719 +0000
- typescript package 2026-10-10 14:43:34.752351104 +0000
- @types/node package 2026-10-10 14:43:34.743350955 +0000
Sample outputs were newer than paired sources; timestamps alone are not full freshness proof. Explicit build below regenerated current src/tests/scripts into normal dist, with permission granted by assignment. Clean script was not used, preserving unrelated generated files.

### Baseline execution (once after investigation)
Exact command, cwd `/home/molmot/remind`:
```sh
node_modules/.bin/tsc -p tsconfig.json --noEmit && npm run build && node --test dist/tests/m1-core.test.js dist/tests/m1-recall.test.js dist/tests/m1-hardening.test.js dist/tests/cli-entry.test.js && node --test dist/tests/acceptance.test.js
```
Overall exit 0, wall 2.90s. Individual observed results:
- noEmit: pass (silent successful exit; subsequent build ran).
- build: pass, `tsc -p tsconfig.json && node -e "require('node:fs').chmodSync('dist/src/cli.js',0o755)"`.
- unit/CLI: 52 tests, 22 suites, pass 52, fail/cancelled/skipped/todo 0; duration 497.855107ms. Includes user-owned CLI bin symlink test, current M1 core/recall/hardening tests; not legacy T4 proof.
- acceptance: 7 tests, 1 suite, pass 7, fail/cancelled/skipped/todo 0; duration 279.119568ms. A1 fresh v2; A2 legacy DB unchanged; A3 direct immediate ingest/remember/recall/get/list; A4 feedback/correct/archive lifecycle; A5 M1 CLI and legacy-op rejection; A6 metadata-only ledgers/bounds; A7 vector/distill absent. Each reported pass.
- Node emitted ExperimentalWarning for node:sqlite; not failure.

DB isolation: inspected tests use mkdtemp under os.tmpdir, configured generated `t.db` or `accept.db` and temporary vault/config. Fixtures close handles and recursively remove their own temp directories in finally blocks; passing test executions exercised those cleanup blocks. CLI test runs `--help`, no DB operation. No root smoke script or real memory.config.json CLI invocation performed.

Unavailable, not failed: missing `.tmp-t6` checks N/A after migrated-root authority decision; current Windows 11 x64 manual smoke unavailable in Linux environment; current Windows/Linux CI proof not obtained. Linux local results do not replace Windows or CI support gates.

## R05 existing coverage and first implementation target
Current tests/m1-recall.test.ts:370–423 covers one-connection sequential correction: first succeeds, supersedes old row, hides old from list, validates body hash, replay deduplicates; only then rival correction on same connection returns CONFLICT. Archive test covers retained terminal row and recall/list exclusion. Acceptance A4 is sequential lifecycle. Hardening includes correction projection replay, not shared-file racing corrections. Search across current tests found no concurrent/parallel/Promise.all correction harness, Worker correction race, or asynchronous spawn correction coverage. Existing subprocess tests use spawnSync and do not establish overlapping correction contenders. Do not reuse old T4 tests as M1 proof.

src/store.ts:187–199 uses BEGIN IMMEDIATE/COMMIT/ROLLBACK; correctRecord transaction at 2040–2102 reads target state, requires active, conditionally flips active->superseded (2065), inserts new correction, links/sourceRefs/heat, operation and audit rows, then checks cap. `not active` maps CONFLICT at 2126. This is implementation support, not execution proof of concurrency or losing-contender rollback.

Recommended narrow Phase 1 R05 scope: extend current tests/m1-recall.test.ts correction coverage with independent simultaneous workers/processes opening the SAME newly created temporary M1 DB file, using distinct idempotency keys, valid preseeded source events, identical original active target, and a coordinated start barrier (not same-thread synchronous calls or serial spawnSync). Assert exactly one ok response and one CONFLICT (not BUSY/TIMEOUT), exactly one active replacement superseding original with revision increment, original superseded and excluded from active recall/list, winner replay deduplicated. Assert losing contender leaves no correction record/body, links, source references, heat, operation-success, audit-success, or derived index/projection residue attributable to it; preserve both preseeded raw events. Add a separate forced post-flip transactional-failure assertion if needed to prove actual mutation rollback, since losing contender may reject before mutations. Reuse existing config/temp cleanup patterns and bounded timeouts; no product changes unless this new acceptance evidence exposes a defect. Update existing documentation evidence only after checks; do not amend agreed source plans/checklist states. Root source is usable now; `.tmp-t6` need not be reconstructed.
