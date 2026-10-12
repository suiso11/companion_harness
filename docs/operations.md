# Operations (M0, §19)

Source-run local web app. No installers/packages, no remote access/auth,
no external telemetry, no app-managed rolling log files.

## Source run

Requirements: Node.js `24.12.0`, pnpm `11.25.0` (see `engines` +
`packageManager`).

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm start            # serve on loopback only (127.0.0.1 / localhost)
```

Manual backup (stopped-server only, no listener/scheduler started):

```sh
pnpm --filter @companion/server backup
```

Takes exactly `backup` with no arguments or path flags. The DB path comes
only from `COMPANION_DB_PATH` (or the OS default) and the backup dir is
always `<data>/backups`. Prints only the backup file basename on success;
a missing DB fails without creating any DB or backup files.

## Environment

| Variable | Default | Notes |
| --- | --- | --- |
| `COMPANION_DB_PATH` | OS app-data `companion-harness/companion.sqlite` | Absolute or resolved; symlinks rejected fail-closed |
| `COMPANION_HOST` | `127.0.0.1` | Loopback only (`127.0.0.1` / `localhost`) |
| `COMPANION_PORT` | `3000` | `0` = ephemeral (tests only) |
| `COMPANION_TIME_ZONE` | `UTC` | IANA name only (Intl membership) |
| `COMPANION_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `COMPANION_MARKDOWN_ROOTS_JSON` | `[]` | Strict JSON array of `{ path, alias? }` (see below); unset means no Markdown connector |
| `COMPANION_MODEL_JSON` | unset (no model) | Strict JSON object `{ adapter, baseUrl, model, apiKey? }` (see M2 below); unset registers no model strategy |

Config is Zod-validated and frozen at startup (no hot reload).

## Plaintext sensitivity and OS permissions

The DB and backups are stored **in plaintext** (no app-level encryption).
Protection relies on **OS file permissions**; credentials/secrets are never
stored in the DB.

- POSIX: app dir and `backups/` are `0700`; DB and backup files are `0600`.
  A POSIX app-dir `chmod` failure aborts startup fail-closed (fixed safe
  error, no path logged).
- Windows: there is **no chmod security guarantee**. Rely on the
  current-user profile ACL (per-user `%APPDATA%`); do not assume `chmod`
  restricts access.

Logs carry fixed codes plus scalar ids/sizes/durations only (stdout/stderr).
No message text, tool/model I/O, file paths, or secrets. Startup/shutdown
`status` values are a fixed vocabulary (`unknown` fallback); arbitrary
reason/error names never enter logs. The DB path is never logged.

## Capacity warning

DB + WAL combined size above exactly **1 GiB** emits a startup warning log
(`server.store_size_warning` with `bytes` only). Warning only: no vacuum,
no delete, no auto-shrink.

## Manual backup (stopped-server only)

- Sole copy method: better-sqlite3 `Database.backup`. Never `VACUUM INTO`
  or online raw file copy.
- Path: `<data>/backups/companion-manual-<UTC>-<uuid>.sqlite`
  (`<UTC>` = `YYYYMMDDTHHMMSSZ`).
- Procedure: `.partial` backup → private permissions (`0600`; Windows
  no-op) → `quick_check` of the copy → atomic rename.
- Manual backups are **never rotated** and never match the
  `companion-pre-migration-` prefix. The only automatic deletion is the
  newest-3 pre-migration rotation.
- Exposed only as the stopped-server CLI command above. **No HTTP
  backup/restore/delete endpoints exist.** The CLI takes no path flags,
  uses only the configured DB path, prints only the backup basename, and
  reports failures with fixed safe text only (no paths, no raw errors).

## Manual restore (stopped-only, exact sequence)

1. Stop the server.
2. Preserve the current db / wal / shm files (copy aside, do not delete yet).
3. Copy the selected verified backup to a temp target next to the
   configured DB.
4. Run `PRAGMA quick_check` against the temp copy; abort on failure.
5. Atomic rename the temp copy onto the configured DB path.
6. Only while still stopped, remove stale `-wal` / `-shm` sidecars.
7. Start the server (startup will migrate as needed).

There is no automatic restore/rollback.

## Full-store deletion (stopped-only)

1. Stop the server.
2. Delete the configured db file, its `-wal` / `-shm` sidecars, and the
   `backups/` contents under the app-data directory.
3. Start only when a fresh store is intended.

There is **no session-level delete/export API** (no per-session physical
deletion, no user export). Domain data is otherwise never auto-deleted
(RunEvent/Snapshot/Reference/Receipt kept indefinitely).

## Markdown references (M1, read-only)

Unset `COMPANION_MARKDOWN_ROOTS_JSON` (default `[]`) means no Markdown
connector and no reference tools (M0 behaviour). When set, exactly one
connector instance owns **all** configured roots.

### Root configuration format

- Exact format: a strict JSON array of objects with only `{ path, alias? }`.
  Example (POSIX): `[{"path":"/srv/notes","alias":"notes"}]`. Example
  (Windows generic): `[{"path":"C:/Notes","alias":"notes"}]`. Quoting for
  the JSON env value is shell-dependent; pass one JSON document as a single
  env value.
- `path`: non-empty absolute path, max 4096 chars, no NUL byte.
- `alias` (optional): `1-64` chars matching
  `/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/`; duplicates rejected. Max 1024 roots.
- Unknown keys, scalars, objects, non-absolute paths, and malformed JSON are
  rejected fail-closed at startup with a fixed safe message (no paths
  logged). The parsed roots are deep-frozen (no hot reload).

### Fingerprint-bound connector (startup gate)

- The connector identity fingerprint (derived from the resolved roots) is
  persisted on the single connector instance row with the expected root
  count. Changing roots, count, order, or aliases afterwards **fails
  startup** (fixed `connector config fingerprint mismatch`-family error).
- There is **no automatic rebinding**. Operators must either revert the
  config to the previously accepted roots, or intentionally start from a
  fresh store (see full-store deletion above) when a new root set is wanted.

### Read-only bounds, safety, and skips

- Markdown files are **never written**. There is no HTML rendering, no
  semantic/fuzzy search, and no FTS: search is whole-query literal
  substring only, under NFC normalization plus locale-independent
  per-code-point case folding.
- Exact bounds: **10000** files per vault (exceeding fails the whole
  search), **1 MiB** per file (raw or NFC-normalized UTF-8 bytes),
  query **1-256** code points, results **default 10 / max 20**, snippet max
  **512** code points (first body hit, deterministic order: title exact,
  then title substring, then body, canonical-key tie-break).
- Oversize files are never truncated: they become explicit `skipped`
  entries. Invalid UTF-8 is a fatal `invalid_utf8` skip (never replacement
  text). Bodies are stored as saved full normalized (NFC) Snapshot text.
- Safety: reads verify realpath containment inside the configured roots
  before and after reading; external symlinks are rejected, internal
  aliases fold to one canonical resource; reads use resolve+stat,
  no-follow open where available, fstat identity comparison, and post-read
  recheck.

### Expanded link graph budget (M1, agreed)

- One `markdown.search` / `reference.refresh` call may persist at most
  **256KiB** of normalized link graph metadata. There is **no per-link
  count cap**.
- Over budget, the whole call fails with **`output_too_large`**: no
  truncation, no partial writes. `reference.open` / `reference.related`
  never expand the graph. Exact accounting is defined in the
  implementation plan (§14.6).

### Stored-only reference HTTP API

- `GET /api/sessions/:sessionId/references` (saved reference list).
- `GET /api/sessions/:sessionId/references/:referenceId` (saved detail;
  returns the stored full normalized body, never rereads the external file).
- `GET /api/sessions/:sessionId/reference-sets/:setId` (saved set detail).
- `GET /api/sessions/:sessionId/reference-context` and
  `PUT /api/sessions/:sessionId/reference-context` (frozen context
  summary; optimistic version check).
- There is **no HTTP search/open/refresh/related**: those paths return
  validation/unknown-route errors. Reads create no events or grants.

### Internal-only ToolBroker tools

- Exact tool names: `markdown.search`, `reference.open` (stored-only),
  `reference.refresh` (only reread path; always a new Snapshot + rN),
  `reference.related` (saved link graph only). They are callable only from
  inside a running Run via ToolBroker (ownership/budget/audit); there is no
  direct POST endpoint for them.

### M2 local model (strict opt-in)

- Unset `COMPANION_MODEL_JSON` (default) registers **no model strategy**:
  runs fail closed with a fixed code instead of producing fake LLM output.
- When set, the value must be a strict JSON object with only
  `{ adapter, baseUrl, model, apiKey? }`. Example:
  `{"adapter":"ollama","baseUrl":"http://127.0.0.1:11434","model":"llama3.1"}`.
  `adapter` is `ollama` (POST `{base}/api/chat`) or `openai-compatible`
  (POST `{base}/v1/chat/completions`, or `{base}/chat/completions` when the
  base already ends in `/v1`). `baseUrl` must be plain `http` on a loopback
  host (`127.0.0.1` / `localhost` / `::1`) with no credentials, query, or
  fragment (normalized form is stored). `model` is `1-256` chars;
  `apiKey`, when present, is a non-empty string up to `4096` chars.
  Unknown keys, scalars, arrays, and malformed JSON are rejected
  fail-closed at startup with a fixed safe message (no URLs, names, or
  key material logged).
- The server builds the gateway from the frozen config and registers the
  M2 agent strategy under `m0-default` **before** engine recovery/start
  and listen. The agent reuses the M1 ToolBroker when Markdown roots are
  configured, otherwise a private empty-registration broker (no direct
  model endpoint is ever added; `answer.submit` stays a reserved
  non-broker terminal protocol).
- Security limitations: model config values and keys are **never logged**
  (only the tool count is logged); `model_calls` persists adapter/model
  identifier metadata only (adapter, model, outcome, error code, timing,
  usage token counts). `apiKey`, `baseUrl`, prompts, raw responses,
  reasoning, and secrets are never persisted or logged; single attempt per
  step (no retry, no fallback, no router, no redirects); per-step 120s
  and 300s whole-run wall budgets with at most one repair inside max 8
  steps; native tool calling only.

### MCP library wire identity (C09; not server-enabled)

- The connector's trusted config must carry an explicit `expectedServerName`
  and `version`. Both are compared **exactly** (case-sensitive) against the
  ACTUAL `initialize.serverInfo` `name`/`version` of the bound MCP server.
  There is no default and no inference from `serverId` (a logical id) or the
  actual response; a programmatic config that omits either fails closed.
- The wire gate runs on **every real transport, before any `tools/list` and
  before any binding is enabled**. A missing/mismatched identity disables ALL
  configured bindings, closes the half-open child, and reports the existing
  fixed `mcp_schema_mismatch` (no raw identity is surfaced). A malformed SDK
  initialize that the SDK connect rejects or cannot parse stays the existing
  fixed `mcp_unavailable`; a post-connect mismatched wire identity stays the
  fixed `mcp_schema_mismatch`.
- Only after the wire gate passes are `tools/list` pages followed (bounded)
  and each binding verified by exact upstream tool name + canonical
  input-schema SHA-256. Correct wire identity with one drifted tool is
  partial drift: the matching tool stays callable, the drifted tool stays
  denied with the same fixed `mcp_schema_mismatch`.
- `isAllowed`/`stats().enabledBindings` advertise **only** bindings validated
  on the current live connection; configured-but-drifted names stay lazy and
  never trigger an upstream call. Shutdown or a failed logical call clears
  them.
- NOT added here: readonly-binding registration, upstream fork pinning,
  OAuth, or server enablement. The formal status stays **HOLD**; other C09
  lifecycle checks and the C10/C11 gates remain open.

Config fragment (trusted fields only; **not** a production command, profile,
or complete activate config):

```json
{
  "kind": "mcp",
  "serverId": "<logical id; never compared to the wire name>",
  "expectedServerName": "<exact initialize.serverInfo.name>",
  "version": "<exact initialize.serverInfo.version>",
  "bindings": [
    { "upstreamTool": "<exact tool name>", "canonicalSchemaHash": "<64 hex>" }
  ]
}
```

### C09-02 / C09-03 demand lifecycle verification status

- This subsection records **only** C09-02 (lazy-on-demand connect + exact
  backoff) and C09-03 (per-instance concurrency / no automatic resend /
  independent instances); it is not a global "only these are verified" claim.
- Lazy: the first configured demand dials immediately; construction and idle
  time never create a transport. A valid live client/handshake is reused across
  later demands (no new factory call).
- Failure backoff follows exactly `1s, 2s, 5s, 10s, 30s, 30s` (max `30s`); a
  successful connect resets the failure counter, so the next loss waits `1s`
  again.
- A failed in-flight logical call is never automatically resent. A distinct
  new/queued call may dial a fresh connection after the reset backoff.
- Per instance the connector serializes demand with true concurrency `1`
  (FIFO queue); separate instances share no global mutex and stay independent.
- CI-compatible regression coverage (committed regression,
  `packages/connector-mcp/test/connection-lifecycle.test.ts`, 5 cases): the
  REAL `@modelcontextprotocol/sdk` `Client` + `McpServer` linked by
  `InMemoryTransport` under a deterministic fake clock
  (`setTimeout`/`clearTimeout`/`Date` only) — a framework-level contract test.
- Local non-CI proof additionally ran the same connector over a genuine SDK
  **stdio fixture** process (actual spawn / spawn-ENOENT, same-PID reuse,
  handler drop / FIFO gate). This is a fixture smoke only — it is **not**
  evidence of the upstream fork, OAuth, or live Google compatibility.
- Existing wire-gate / `serverId`-vs-`expectedServerName`+`version` semantics
  are unchanged. The formal status stays **HOLD**; the remaining unverified
  C09 gates and the C10/C11 gates stay open, and no Calendar-adoption decision
  is made here (C09-02/03 and C09-05/06 scope are separated below).
- Graph-budget CI coverage note (same PR run): the real-vault
  `packages/connector-markdown/test/graph_budget_integration.test.ts` (5 cases)
  previously reported a **Windows CI** timeout at **6099ms** on the
  ambiguous-link case, whose large same-basename fixture was the cost. It now
  drives the REAL connector over a bounded **16-directory / 18-real-`.md`-file**
  temp vault whose wide canonical candidate keys retain the 256KiB cap proof
  (160 repeats ≈317653 bytes reject `output_too_large`; a 2-link control
  ≈3969 bytes stays under cap) without the large filesystem setup. This is
  **local proof only** (target file 5/5, root `tsc`, scoped Biome clean); it
  does not raise the timeout, skip the case, or change the production budget.

### C09-05 / C09-06 transport bounds & shutdown status

- This subsection records **only** the local, owned-branch verification of
  C09-05 (stdio stderr-bounded termination) and C09-06 (bounded shutdown /
  kill timeout), plus the loopback-HTTP cleanup path.
- Real STDIO local non-test smoke (actual Node 24 + real SDK 1.30.0 real
  `StdioServerTransport` children): **8/8 green**. Latest archived real-stdio
  stdout: S7 stubborn shutdown **111.528ms** with a real `onclose`, owned PID
  gone, exactly one actual production SIGKILL; S8 cooperative **3.918ms** /
  no kill; actual `finalOwnedPidsAlive=[]`.
- Real loopback HTTP local non-test smoke (actual Node 24 + real SDK
  `McpServer` + `StreamableHTTPServerTransport`, production
  `new McpConnector(cfg)` default HTTP transport): **7/7 green** — positive
  `initialize`/`tools/list`/`tools/call`; pending-RPC shutdown with a
  preserved prior `onclose`; 3xx refusal for 301/302/303/307/308/304 with zero
  destination hits; post-connect `tools/call` 307 refusal with no resend;
  direct-fetch refusal for every input form; streaming-body cancel; and the
  schema-bypass no-network tripwire (actual fetch count `0`).
- Deterministic controlled-SDK unit coverage: **26 cases** (9
  transport-bounds / stderr-cap, 12 shutdown-race, 5 HTTP redirect-cleanup)
  inside the full **1123 tests / 92 files**; root + e2e typecheck clean;
  Biome 190 files with 0 warnings (one pre-existing recommended-rule info).
- Bounds: stdio stderr is COUNT-ONLY per connection, saturating at 64KiB;
  byte 65537 aborts open/call/idle into fixed `mcp_unavailable`, synchronous
  state clear, and bounded cleanup. `shutdownWaitMs` stays `100..10000`
  (default `3000`) as the GRACE window, plus a fixed additional **2000ms**
  force-close wait; the real owned positive public-SDK PID is captured before
  `close()` clears the getter, and the exit proof is an actual close event,
  not `close()` promise resolution. Generic/HTTP settle waits are HOST-bounded
  and do NOT prove external process death; a numeric PID public API cannot
  guarantee a durable OS identity or process tree.
- Fixture/local evidence only: NOT upstream-fork / OAuth / auth,
  ordinary-CLI, or live-Google proof. Commands and counts are typed observed
  values, not future CI or head-SHA claims. The formal status for the
  remaining C09/C10/C11 gates and Calendar adoption stays **HOLD**.
- Retained archives live OUT-OF-REPO under
  `/home/molmot/.local/share/opencode/tool-output/c09-transport-verify/`:
  `after-http/` (`harness.ts`, `tsconfig.json`, `stdout.json`, `result.json`,
  `records-result.json`, `commands.txt`, `fail-history.txt`) and the
  `after-stdio/` archive; the earlier `before/` archive is unchanged. The
  in-repo `.c09-proof/http-final` helper and its compiled output were
  TEMPORARY and deleted after publication, so it is NOT a retained archive.
  The prior root 54 env-load-failure full run (with the stale idle-trigger and
  SDK fixture-typing failures) is preserved under `final-checks/`; the final
  full pass, which followed the OWNED workspace-resolved dependency borrow,
  is under `final-checks-with-deps/`.

### PR16 review followup: retired cleanup join & late-closure renewal

- This followup records **only** the PR16 review-thread fixes on the C09-05/06
  transport bounds. It does not widen scope: the C09 security PR17 read-only
  policy (mandatory definitions / hints / readOnly sidecar) is **NOT** part of
  PR16, the Calendar-adoption status stays **HOLD**, and no wire config, pin, or
  public API changes. The 8/8 stdio smoke, 7/7 loopback-HTTP smoke, and root
  1123 tests / 92 files above remain the HISTORICAL PR16 truth; the observed
  final counts below are a separate, later section and do not replace them.
- P1 shutdown join (thread `PRRT_kwDOUNdW7s6rYfGY`): an overflow-detached
  bounded cleanup is registered centrally through
  `OwnedConnectionHooks.onCleanupStarted`, and explicit shutdown joins every
  STARTED cleanup until its ORIGINAL bounded deadline (no reset/restart).
  Observed BEFORE (`before-runtime/`): shutdown returned while a fresh cleanup
  was still unsettled (~997ms stale wait before the owned 1s). AFTER
  (`after-runtime-pr16/`): shutdown ~314ms, the owned positive public-SDK PID
  was gone at return, exactly one production SIGKILL at ~299ms (the original
  300ms grace), no helper safety kill, final owned PIDs alive `[]`.
- P2 cancellable backoff (thread `PRRT_kwDOUNdW7s6rYfGX`): each connect
  singleflight entry owns a fresh `AbortController`; shutdown aborts it
  synchronously so a fenced demand resolves fixed `mcp_unavailable` without
  sleeping the stale delay or holding the mutex. Observed AFTER
  (`after-runtime-pr16/`): the old fenced demand settles fixed-unavailable ~3ms
  after shutdown with the failure count preserved at 1 and the stale timer
  removed; the fresh post-shutdown demand owns its FULL fresh 1000ms backoff
  (scheduled at +0ms) and is the only call that reaches upstream (two 1000ms
  timers total, no auto-replay).
- Late-closure renewal (native review, fixed in-session): a RENEWED generic
  bounded cleanup must not settle on a superseded generation's SDK client-close
  memo or the already-resolved global close-observed latch. A numeric
  `closeGeneration > 1` guess missed the OBSERVED pre-handoff close (raw
  `onclose` with no physical close, generation 0); the final fix is an explicit
  private renewal PHASE (`lateCleanupPhase`, initial false, set true only in
  `startLateCleanup` on the generic path) so a renewed generation waits ONLY on
  its own matching `rawClose` or the configured finite grace. `closeGeneration`
  remains solely the stale-memo completion identity guard, and the real stdio
  path and its candidate selection are unchanged. Observed with the generic
  late-closure helper over the production `McpConnector` and real SDK `Client`
  (paths `generation/observed-close/{before,after}`): BEFORE shutdown settled
  while the first close gate was held and the new resource was still open; AFTER
  it stays pending until the matching renewed raw close, then settles.
  Permanent regression: the `shutdown-race.test.ts` renewed-cleanup case FAILS
  against the heuristic and PASSES against the phase; deterministic fake-clock
  coverage consumes 123ms of the original grace before shutdown, stays pending
  at 499ms, and settles at the original 500ms (never a restarted 623ms), plus
  the max-30s lifecycle cases (cancel without advancing the old timer, queued
  fence, fresh own full 30s).
- PR17 remains OUT of PR16: the read-only / mandatory-definition / hints /
  readOnly sidecar policy is not promoted into this document, and the
  unregistered/adoption **HOLD** and wire config are unchanged. This followup
  review touches only the C09-05/06 transport-bounds scope.
- Evidence retention: exact BEFORE/AFTER commands and JSON proof are archived
  OUT-OF-REPO under
  `/home/molmot/.local/share/opencode/tool-output/c09-review-response/`
  (`before-runtime/`, `after-runtime-pr16/`, `generation/{before,after}`,
  `generation/observed-close/{before,after}`, and the final owned scaffolding
  archive `final-checks-pr16/`). The in-repo `.review-proof/` helper scaffolding
  was TEMPORARY: it was archived first, then deleted so it cannot pollute
  whole-repo lint. Helper evidence is fixture/local only — no Windows
  process-tree or durable-PID claim, and the generic path stays HOST bounded.

### PR16 final checks (observed on base 026466a)

- Battery run ONCE after the doc/comment patches and the format-only pass, on
  the owned branch with no repo config change and no helper scaffolding present:
  - `pnpm run typecheck` -> exit 0 (root `tsconfig.json`; strict +
    `exactOptionalPropertyTypes` + `noUnusedLocals`/`noUnusedParameters`).
  - `pnpm run typecheck:e2e` -> exit 0 (`apps/server/tsconfig.e2e.json`).
  - `pnpm test` (Vitest) -> **92 test files passed, 1129 tests passed**.
  - `pnpm run lint` (Biome `check .`) -> **190 files checked, 0 warnings**,
    1 pre-existing recommended-field info, exit 0.
- These are the ACTUAL observed values on this working tree; they are not a
  prediction of any future CI run or head SHA. The earlier PR16 root **1123 /
  92** above is preserved as historical truth; the +6 tests are the new
  review-followup regression cases (backoff interruption, retired-cleanup join,
  and the late-closure renewal).
- Scope: C09-05/06 transport bounds only. PR17 read-only/security policy and
  the unregistered Calendar adoption remain **HOLD** and unchanged.

## Non-goals (explicit)
Domain retention/GC (except newest-3 backup rotation), user export,
session delete API, running-process deletion, auto-restore, DB/backup
encryption, external telemetry, app-managed log files, installers,
remote access/auth.

## Platform / TOCTOU limitations

- better-sqlite3 opens by path with no portable no-follow open; a symlink
  swap in the narrow open→recheck window cannot be fully eliminated. The
  bootstrap narrows it with pre-open lstat guards plus an immediate
  post-open recheck (fail closed).
- Backup prune re-verifies containment + non-symlink immediately before
  delete (best-effort TOCTOU narrowing).
- POSIX permission bits are not meaningful on Windows (see above).
