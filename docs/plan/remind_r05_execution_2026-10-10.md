# Remind R05 shared-file correction race evidence — 2026-10-10

## Scope and changed files

Authoritative checkout: `/home/molmot/remind`, current merged autonomous M1 root, as resolved by parent from the Phase 0 evidence in [remind_execution_2026-10-10.md](remind_execution_2026-10-10.md). No `.tmp-t6` checkout or legacy T4 test was recreated/reused. This report covers the first actionable R05 shared-file concurrent-correction coverage gap, not all R05 archive/rollback requirements or any M2/M3 implementation.

Changes:
- `tests/m1-recall.test.ts`: one permanent async regression under existing correction tests, reusing existing setup/raw/remember/recall fixtures. Existing sequential lifecycle/idempotency tests remain unchanged.
- `tests/fixtures/correction-race-worker.ts`: permanent compiled worker fixture calling the real M1 `correctRecord` store API through independent `DatabaseSync` handles.
- `docs/acceptance-manifest.md`: narrow supplemental shared-file race coverage note, leaving A1–A7 and sequential A4 scope unchanged.

No product-code fix was required/exposed. No changes to source APIs, dependencies, locks, user-owned dirty files, root config/DB, companion docs/plan files, migrations/imports, or Git integration. No throwaway scripts were created. Build updated the normal generated `dist` output only.

## Deterministic real concurrency mechanism

Both workers are launched without awaiting either. Each creates its own SQLite connection inside its worker thread, on the same absolute temporary file path, configures the normal busy timeout, reads `PRAGMA database_list`, and observes the same original record still active before reporting ready. Parent verifies distinct positive worker IDs, identical real DB file path, and both active observations, then releases a shared start gate.

An SQLite authorizer observes actual `SQLITE_TRANSACTION` statements and always returns `SQLITE_OK` (no operation is replaced, denied, faked, or mocked). Each real `correctRecord` invocation rendezvouses immediately before SQLite executes its `BEGIN`; the first cannot proceed until both independent connections have entered the actual store call. This is a critical-point barrier, not sequential same-connection calls, synchronous subprocesses, or a reused legacy proof. The observer also records real BEGIN/COMMIT/ROLLBACK statements. The production BEGIN IMMEDIATE arbitrates the concurrent writes.

Distinct idempotency keys/run IDs and replacement bodies identify the contenders. Each has its own existing same-scope raw source event and resolved same-scope record link target, seeded through real M1 APIs. Worker fixtures close their own handles; the parent waits for their exit before inspecting consumer-visible and canonical state.

## Executed verification — once after edits

Exact command, cwd `/home/molmot/remind`:

```sh
node_modules/.bin/tsc -p tsconfig.json --noEmit && npm run build && node --test dist/tests/m1-core.test.js dist/tests/m1-recall.test.js dist/tests/m1-hardening.test.js dist/tests/cli-entry.test.js && node --test dist/tests/acceptance.test.js
```

Overall exit 0, wall 3.04 seconds:
- noEmit: pass, silent successful exit followed by build.
- Normal build: pass, existing `tsc -p tsconfig.json && node -e "require('node:fs').chmodSync('dist/src/cli.js',0o755)"` script.
- Units/CLI including new race: 53 tests, 22 suites, pass 53, fail/cancelled/skipped/todo 0; duration 514.44927 ms. New regression passed in 44.942203 ms.
- Acceptance: all A1–A7 passed; 7 tests, 1 suite, pass 7, fail/cancelled/skipped/todo 0; duration 280.740616 ms.
- Only observed warning: Node ExperimentalWarning for node:sqlite.

Observed race diagnostic:

```text
shared file /tmp/m1-recall-CIhwNE/t.db; independent workers 1/2; BEGIN barrier=2; OK=1/CONFLICT=1; loser ROLLBACK=1; loser revision/ref/link/operation/audit success=0
temporary DB/vault fixture removed: /tmp/m1-recall-CIhwNE
```

Regression asserts one `ok:true` result and exactly the codes `[CONFLICT, OK]`; winning connection BEGIN=1/COMMIT=1/ROLLBACK=0, losing connection BEGIN=1/COMMIT=0/ROLLBACK=1, neither connection left in a transaction. `get` retains the original body with superseded status and returns winner active with revision 2, correct supersedes pointer, winning body/sourceRefs/link. Active list contains only the two link fixture records and winning new revision. Recall includes the winner but not the superseded original.

Canonical SQL proves exactly four total records (original, two preseeded link targets, one replacement), exactly one correction/superseding revision, no losing body/revision, no losing sourceRef/link, and zero orphan record/source-event refs or link endpoints. Expected counts: links=1, sourceRefs=4, heat=4. Heat/projection/FTS/note-bigram references have zero orphan records. Exactly one correction operation exists, with winner key and byte-equivalent parsed success envelope; loser key has zero operations. Exactly one correction audit row exists, carrying winner target and run ID with code OK; loser successful audit count is zero. Preseeded losing raw event and link target intentionally remain as fixture inputs, not failed-correction residue. The real store path is launched by this regression itself, so no additional throwaway smoke invocation was necessary.

## Temporary isolation and preserved files

Fixture database path `/tmp/m1-recall-CIhwNE/t.db` and configured vault path `/tmp/m1-recall-CIhwNE/vault` are asserted to be children of the fixture's `mkdtemp(os.tmpdir())` directory before launch. Every worker reports the same realpath from its independent connection. The store race does not drain Markdown projection; vault is temporary/configured and no real vault path is used. Finally terminates any surviving workers, closes parent DB, recursively removes only that fixture directory, and asserts its absence.

Additional exact post-run cleanup command:

```sh
test ! -e /tmp/m1-recall-CIhwNE && test ! -e /tmp/m1-recall-CIhwNE/t.db && test ! -e /tmp/m1-recall-CIhwNE/t.db-wal && test ! -e /tmp/m1-recall-CIhwNE/t.db-shm && test ! -e /tmp/m1-recall-CIhwNE/vault && printf 'R05 temporary DB, WAL, SHM, vault and fixture directory absent\n'
```

Exit 0; output confirms DB/WAL/SHM/vault/fixture directory absent. All existing test suites also retain their temporary fixture cleanup conventions. No root `memory.config.json` CLI invocation or root smoke script was run, and root `memory.db` was never opened as SQLite; its bytes were read only for preservation hashes.

Before and after verification, `sha256sum package.json src/cli.ts tests/cli-entry.test.ts memory.db memory.config.json package-lock.json` matched exactly:

| File | SHA-256 before = after |
| --- | --- |
| package.json | b8dda1c43cd305876c5bca6466c438b10fa8fd30e4d648809bbf63d1158dcb07 |
| src/cli.ts | d56543b8384cdb732d0c43b62dbcdbfc59239e59206bf33de00d19382621038b |
| tests/cli-entry.test.ts | b3f8c1d65d8952d547bbc8e732fef00e8690f8fb1e97cac80edcad67061cd7ae |
| memory.db | 68b8770fdc19672584d3b659f9552a01c617836fb273e19ce1b46ff6f5709db9 |
| memory.config.json | a23e9c5d163a3dc8c8efa14c520429a9985312934bab14747505bc2bf2df5325 |
| package-lock.json | 410aa41d616f0c1cfc1fe84e12ae61c1873b12d9a1c5359d07011e06660c3b26 |

Before/after `stat -c '%n %s %y %z'` also matched for all six files. Root memory.db remained 180224 bytes with mtime and ctime `2026-10-10 14:44:33.306317389 +0000`. This preserves the pre-existing dirty package/CLI/CLI-test edits byte-for-byte and demonstrates no real DB/config/lock mutation.

Observed current-platform local verification only; no claim of Windows or CI verification.
