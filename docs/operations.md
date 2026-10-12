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
  lifecycle checks and the C10/C11 gates remain open. The CURRENT constructor
  additionally requires the reviewed host `McpBindingDefinition[]` second
  argument (see "C09-01 / C09-04 / C09-07 / C09-08" below): the
  `new McpConnector(cfg)` calls in the PR15/PR16 archives are the HISTORICAL
  API, not a compatibility shim, and this phase still registers nothing.

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
  `McpServer` + `StreamableHTTPServerTransport`, historical PR16 API
  `new McpConnector(cfg)` default HTTP transport — NOT the current
  constructor and NOT a compatibility shim): **7/7 green** — positive
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

### C10 Calendar consumer normalization (implemented; adoption HOLD)

- This subsection records the CURRENT C10 scope only. It is NOT a live-Google,
  OAuth, fork-compatibility, profile-registration or adoption claim, and no
  package pin changed (`@modelcontextprotocol/sdk@1.30.0`, `zod@4.5.4`). The
  only new dependency edge is the owned workspace
  `@companion/connector-mcp` (for the public `CallResult` / `McpErrorCode`
  types), added to `packages/connector-calendar` with the exact pnpm-lock
  importer entry (no external install/pin).
- Consumer decoder (package-owned, no new provider framework, no retries,
  logs, telemetry or dispatch): `normalizeSearchResult(result, options)` →
  `{ok:true,events,cursor?}` / `{ok:false,code}` and `normalizeGetResult(result,
  options)` → `{ok:true,event}` / `{ok:false,code}`, both over the merged
  `CallResult`. `normalizeEvent(raw, {connectorInstanceId})` remains the
  primitive and rejects with the fixed `Error("calendar_response_invalid")`
  (no cause/raw value/Zod issue). `structuredContent` is selected by
  OWN-PROPERTY presence; a present `null`/`undefined`/wrong-shaped value is the
  only source and is never rescued by `text`. Only an ABSENT
  `structuredContent` permits parsing the ENTIRE `text` as strict JSON (no
  fences, prose, prefix/suffix scanning, event synthesis or auto-pagination).
  An incoming fixed MCP failure code is preserved verbatim.
  Transport seam (documented, not an end-to-end claim): the merged MCP client
  omits `structuredContent` when its value is `undefined`, so a direct
  own-property `undefined` is rejected at the Calendar boundary but an
  upstream property-present `undefined` is indistinguishable from absence
  after transport (illegal JSON cannot carry it).
- Exact root envelopes: `list-events` and `search-events` pages
  (`{events,totalCount,nextPageToken?}` plus each operation's source-proven
  optional metadata) selected by an explicit `operation` option, and
  `get-event` `{event}`. `totalCount` must equal the PAGE `events.length`; a
  page with more than the requested `1..20` events is rejected (never sliced);
  unknown root fields, wrong-operation envelopes and cross-calendar raw ids are
  rejected; no id/calendarId is derived from the root.
- Event projection: the REAL nested `{dateTime?,date?,timeZone?}` endpoint union
  (exactly one of `date`/`dateTime`); all-day DATE values stay DATE strings with
  an exclusive end; explicit-offset timed instants are canonicalized to UTC.
  Required consumed fields (`id`, `calendarId`, `status`, `summary`, endpoints)
  are strict CONSUMER policy (the candidate producer marks `summary`/`status`
  optional) — no fabricated title/confirmed status. The seven privacy keys
  (`creator`/`attendees`/`organizer`/`conferenceData`/`hangoutLink`/`htmlLink`/
  `extendedProperties`) plus all unknown extras, `accountId`, page metadata and
  source identifiers are stripped and excluded from the snapshot and hash.
  Allowed `title`/`description`/`location` plaintext may itself contain
  emails/URLs; no general free-text redaction is claimed.
- Revision precedence unchanged: non-empty opaque `etag` (quotes preserved) >
  canonical `updated` > normalized-projection hash (computed after temporal
  canonicalization and truncation, excluding identity/revision/private fields).
  `canonicalKey` stays `SHA-256(JSON([connectorInstanceId, calendarId,
  eventId]))`. C11 deletion behavior is unchanged (untouched by C10).
- Candidate compatibility gap (explicit): the candidate source regex accepts
  only WHOLE-second `Z`/`±HH:MM` datetimes, while the agreed consumer input
  keeps fractional-second ISO precision (the exact 90d+1ms boundary depends on
  it). The mapper does not silently truncate/round/narrow, so this remains a
  documented gap and an additional adoption HOLD; no full-fork-compatibility
  claim is made.
- **C10-08 production mapping gate (UNRESOLVED):** no adopted
  `McpBindingDefinition`, pin, profile, OAuth flow or live-Google wiring
  exists. The candidate mapping is proven only against the retained
  synthetic-provider C08 archive (provider bodies are unadopted compatibility
  targets). Calendar consumer-readiness ≠ profile-connected/adopted, and the
  formal C08 adoption status stays **HOLD / NOT ADOPTED**. Test counts and
  command results observed for this patch are recorded by the parent's
  verification phase; no count is claimed here.
- **Final verification (observed; full patch, each check run once):** direct Node
  24.12 CLIs from the OWNED worktree node_modules (no pnpm exec/install/relink/
  dlx/npx, no test filter). FIRST attempt: `tsc --noEmit -p
  apps/server/tsconfig.e2e.json` PASS (exit 0); full `vitest run` PASS (exit 0,
  94 test files / 1164 tests, 0 failed/skipped); `tsc --noEmit -p tsconfig.json`
  FAIL (exit 2, 3× TS18048 `'zone' is possibly 'undefined'` at
  `packages/connector-calendar/src/time.ts` lines 96/97/98); `biome check .` FAIL
  (exit 1, 191 files, 1 error `assist/source/organizeImports` at
  `packages/connector-calendar/src/index.ts:1`, 1 warning
  `lint/suspicious/noPrototypeBuiltins` at
  `packages/connector-calendar/src/normalize.ts:344`, 2 infos
  `lint/complexity/noUselessUndefinedInitialization` at `normalize.ts:402` plus
  the pre-existing `biome.json` deprecated-`recommended` config note).
- **Bounded type/lint fix (CURRENT):** type-only mandatory-zone-capture assertion
  in `time.ts` (no runtime change; offsets/normal path byte-identical),
  `normalize.ts:344` own-property presence via `Object.hasOwn` (same semantics
  incl. present null/undefined and prototype-safety), removal of the useless
  `= undefined` initializer at `normalize.ts:402`, and an organizeImports reorder
  in `index.ts`. Re-running ONLY the two previously-failed checks once each:
  `tsc --noEmit -p tsconfig.json` PASS (exit 0, empty output); `biome check .`
  PASS (exit 0, 191 files, 0 errors / 0 warnings, 1 info = the pre-existing
  `biome.json` deprecated-`recommended` note). The changed presence branch was
  smoked against the retained C08 bodies over the ACTUAL public decoders
  (11/11 pass: own `structuredContent` priority, present null/undefined rejects,
  absent -> strict text, inherited/shadow `hasOwnProperty` irrelevant); the
  throwaway `.review-proof` was removed and archived at
  `c10-calendar-verify/failed-check-fix/`. The earlier e2e typecheck PASS (exit 0)
  and full 94 files / 1164 tests PASS are preserved and NOT rerun by this
  type/lint-only patch; no new full-test run is claimed. The touched-TS
  `biome format --write` run (7 files, 4 rewritten) was syntax-only and is not
  rerun.
- **time.ts native-review regression proof (archived out-of-repo):** the two
  fixes (year-0000 leap-day construction; 3-digit bounded fractional ms) are
  proven by actual Node 24.12.0 public/source-API probes at
  `c10-calendar-verify/time-review/` (14 files, byte-hash verified); the worktree
  `.review-proof` was removed after the copy. BEFORE the failure mode was split,
  not a blanket rejection: the timed year-0000 leap-day and `+01:00` offset
  normalizations returned `ok:true` with silently corrupted instants
  (`0000-02-29` shifted to `0000-03-01`, and the offset start off by one day,
  under the old `Date.UTC(0,…)` → 1900 non-leap rollover), and where a
  `.999999999999999999` fraction was accepted it advanced to `09:00:01.000Z`
  with a `sourceRevision` differing from `.999Z`; only the all-day year-0000
  leap-day range and the long-fraction interval failed closed with
  `calendar_response_invalid`. AFTER: `0000-02-29` parses as-is, `+01:00` offset
  → `0000-02-28T23:00:00.000Z`, long fraction → `09:00:00.999Z` (no next-second
  carry), and `.999Z` vs the long fraction give identical `sourceRevision`; the
  normal path is byte-identical. esbuild used was `0.25.12` (root pnpm store
  leaf; root also has `0.28.2`, which was NOT used).
- The incidental unit test that echoed an incoming fixed failure code verbatim
  (`preserves incoming fixed MCP failure codes without decoding`) was deleted; no
  mock-echo/forwarding replacement was added. MCP failure-code propagation is
  covered by the genuine SDK not-found runtime path, not by a unit echo. C11
  deletion behavior and the formal C08 HOLD / C10-08 production mapping gate are
  unchanged.

### C11 deletion-evidence boundary (consumer invariants; C11-01 BLOCKED)

- This subsection records the CURRENT C11 scope and supersedes the earlier
  design-time "deletion classifier" placeholder. It is NOT an adoption,
  live-Google, OAuth, pin or positive-tombstone claim. No package pin changed
  (`@modelcontextprotocol/sdk@1.30.0`, `zod@4.5.4`); `packages/connector-calendar`
  adds the SDK ONLY as a test-only `devDependency` (the already-resolved
  `1.30.0(zod@4.5.4)`) with the exact lockfile importer entry, no production
  dependency, no provider adoption.
- Removed dead stub: `classifyDeletion` / `DeletionVerdict` and their
  `src/index.ts` exports were deleted. They switched only on the proposed
  `get-tombstone` / `list-showDeleted-tombstone` labels and were never called
  by any producer or runtime; no always-unknown / no-op / alias / deprecated
  replacement API was added. The normative `normalizedEventSchema` keeps the
  `deleted` status (§17.5); only the unverified classifier type was removed.
- Genuine-wire consumer regression:
  `packages/connector-calendar/test/deletion-boundary.test.ts` drives the real
  `McpConnector` over a genuine lower-level SDK `Server` +
  `InMemoryTransport` linked pair (dummy loopback config with an injected
  in-memory transport, so no HTTP/stdio/OAuth is dialled) and runs the returned
  `CallResult` through the real `normalizeGetResult` /
  `normalizeSearchResult`. Six negative invariants: (1) a valid `confirmed`
  then `cancelled` get for the SAME canonical key yields normalized
  `cancelled` with a new etag revision, never `deleted`; the prior snapshot is
  NOT asserted persisted (that is the unwired C12 pipeline). (2) an
  `isError:true` body with a private synthetic 404 marker AND a conflicting
  `structuredContent.event.status:"deleted"` yields the fixed
  `calendar_upstream_error` with the marker absent and no Text rescue. (3) a
  thrown SDK `McpError` (`ErrorCode.InternalError`) carrying a private
  synthetic 410 marker is rejected by the genuine SDK to the fixed
  `mcp_unavailable`, with exactly one dispatch (no logical auto-resend). (4)
  a prior valid get followed by ONE empty search page with an opaque
  non-empty continuation token yields `events:[]` plus the cursor verbatim,
  with search-call count 1 (not an all-page omission proof, not a delete).
  (5) a get SUCCESS whose raw consumed `status` is `deleted` is rejected as
  `calendar_response_invalid` (the consumed enum cannot accept the future
  normalized value). (6) a get `confirmed` body with unknown raw
  `deleted:true` / `tombstone:true` / `get-tombstone` provenance text strips
  the flags and keeps a valid `confirmed` event, trusting no extra heuristics.
- C11 gate table (source-backed; the consumer regressions below were
  subsequently exercised by a real-SDK wire smoke and the new vitest file, but
  no formal gate PASS/adoption is claimed):

  | item | status | boundary / evidence |
  | --- | --- | --- |
  | C11-01 | **BLOCKED** | No adopted operation-specific POSITIVE tombstone evidence exists. Candidate `get-event` has no `showDeleted` and no deleted-semantics contract; candidate `97a3dc3` source is read-only reviewed. Positive gate not met → no `deleted` mapping. |
  | C11-02 | IMPLEMENTED (consumer) | `cancelled` decodes to normalized `cancelled` (same canonical key, new etag revision); never `deleted`. Regression (1). Existing-snapshot retention is C12 (unwired). |
  | C11-03 | IMPLEMENTED (consumer) | Bare 404 (`isError:true`) → `calendar_upstream_error`; a THROWN RPC error → distinct `mcp_unavailable`; no tombstone. The retained C08 get-miss is an inert-provider `-32603` `isError`, NOT an actual Google HTTP 404/410. Regressions (2)(3). |
  | C11-04 | IMPLEMENTED (consumer) | A single empty search page returns `events:[]` + opaque cursor verbatim; one search call; omission is never deletion. Regression (4). |
  | C11-05 | PARTIAL | Uncertain results map to the fixed `calendar_upstream_error` / `mcp_unavailable` / `calendar_response_invalid`. "Never erase an existing snapshot" requires the C12 pipeline, which is unwired. |
  | C11-06 | DOCUMENTED (no new policy) | Existing demand-driven backoff `1/2/5/10/max30` applies to the next logical call; NO automatic logical resend (C09). Explicit retry is a NEW Run on the SAME frozen Turn context. Stored-only open vs explicit refresh (success → newSnapshot/rN) is existing architecture NOT wired to Calendar. C13 owns retry budgets/UI. Failures are not observations/tombstones; a future C12 adapter must retain prior refs/storage, never map an accidental missing to `deleted`. |
  | C11-07 | DOCUMENTED (METADATA ONLY; HTTP status UNKNOWN) | Record format: source kind (static candidate / retained inert provider / new synthetic SDK wire), immutable archive/candidate refs, operation, request field NAMES (not raw IDs/cursors/query/emails/error body), observed MCP envelope and the fixed consumer error. No runtime logger/telemetry/status-diagnostic channel was added and error privacy was not weakened. Actual HTTP status is NOT captured; synthetic 404/410 markers are NOT provider HTTP evidence. |
  | C11-08 | RESOLVED (documentation) | The spike's cancelled/404 limitations are NOT formal implementation evidence: formal C08 stays **HOLD**, C10-08 production mapping stays **UNRESOLVED**, the candidate whole-second regex fraction gap persists, and no OAuth/live/fork/pin/profile exists. |
- Positive-proof prerequisites (source-reviewed; NONE exists for candidate
  `97a3dc3`, so C11-01 stays BLOCKED and is NOT sufficient as a Google
  contract): an ADOPTED operation-specific positive-evidence schema with
  verified official semantics; a prior KNOWN target (exact connector /
  calendar / event), not a caller-supplied `priorKnown` boolean; an accessible
  calendar/read-permission context; and an actual positive observation matching
  the operation + exact target + recurrence distinctions. Search omission, list
  `showDeleted`, `cancelled`, bare 404/410 are NEVER positive evidence; `get`
  `showDeleted` does not exist (do not invent it). A positive / real HTTP status
  for C11-07 remains BLOCKED and actual upstream HTTP status stays UNKNOWN.
- Observed verification (this C11 verification run; evidence archived out of
  repo, source unchanged): a disposable real-SDK runtime smoke
  (`.review-proof/c11-runtime.ts`, deleted after archive) drove `McpConnector`
  over a genuine low-level SDK `Server` + `InMemoryTransport` and exercised all
  SIX negative invariants through the real public API with NO HTTP/stdio/OAuth:
  6 distinct cases / 27 checks, all pass (Node 24.12.0, SDK 1.30.0, esbuild
  0.25.12). No case produced a tombstone; the private 404/410 sentinels never
  appeared; request counts were get=2 (case 1), get=1 (cases 2/3/5/6) and
  get=1+search=1 (case 4, no implicit next page). The new
  `packages/connector-calendar/test/deletion-boundary.test.ts` ran 6/6 in the
  full suite (95 files / 1168 tests, 0 failed / 0 skipped); root typecheck exit 0
  and e2e typecheck exit 0. The first `biome check .` exited 1 with ONE error
  (`assist/source/organizeImports`, import-name order, in
  deletion-boundary.test.ts) plus the pre-existing `biome.json` `recommended`
  info. That FIXABLE ordering was then applied manually exactly as the reported
  safe fix and the root `node node_modules/@biomejs/biome/bin/biome check .` was
  re-run ONCE: **exit 0, 192 files checked, 0 errors / 0 warnings**, only the
  pre-existing `recommended` info remains. No new error/warning is outstanding;
  the reorder is behaviour-neutral and changes no runtime semantics. These are
  consumer boundary verifications only: C11-01 remains **BLOCKED**, C11-05 retention
  stays C12/unwired, C11-07 actual HTTP status stays UNKNOWN, and the formal C08
  HOLD / C10-08 production-mapping gate is unchanged — no live-Google, OAuth,
  pin, profile or adoption claim. The test-only
  `packages/connector-calendar/node_modules/@modelcontextprotocol/sdk` symlink
  (raw target
  `../../../../node_modules/.pnpm/@modelcontextprotocol+sdk@1.30.0_zod@4.5.4/node_modules/@modelcontextprotocol/sdk`,
  same form as the connector-mcp link, read-only borrow) was added so the SDK
  resolves from the Calendar test source directory; no install/relink ran.

### C12 internal Calendar pipeline (implemented end-to-end consumer; adoption HOLD)

- This subsection records the CURRENT C12 scope: the internal pipeline that
  wires the C10 normalized connector into the kernel's ReferenceManager
  through a dependency-inverted port. It is a REAL-SDK, credential-free,
  in-memory-transport consumer verification only — it is NOT an adoption,
  live-Google, OAuth, pin (formal C08 stays **HOLD**) or provider claim. The
  actual upstream HTTP transport and error statuses stay UNKNOWN.
- Architecture (as implemented, `packages/kernel/src/calendar_tools.ts`):
  `calendar.search` is a ToolBroker registration built over a
  `CalendarConnectorBinding` (stored `connector_instances` row of kind
  `calendar` + an already policy-validated `McpConnector` adapter). The kernel
  owns the port shape and never imports the connector package. The frozen
  IANA zone is resolved PER CALL from the Run's immutable Turn frozen context
  (`turn.frozenContext.temporal.timeZone`), never from a construction state,
  clock or env read; `get` needs no zone. Host-private upstream `get-event`
  targets (calendarId/eventId/account) are returned by the adapter alongside
  the decoded page and persisted by the kernel inside the SINGLE
  `ReferenceManager.presentObservations` `BEGIN IMMEDIATE` transaction
  (through the `onApplied` hook), AFTER the running-status/CAS recheck:
  a cancelled/terminal/late observation writes no target and a committed
  Snapshot/rN cannot exist without its target (`C12-07`).
- Private storage: committed migration `0006_m4_calendar_targets.sql` adds the
  STRICT, non-joined `calendar_get_targets` table (canonical_key PK, valid
  JSON target, no secret/credential). The production server injects
  `createDurableCalendarTargetStore(db)` (survives restart); the in-memory
  store is a test-only default. Provider ids live ONLY in this private table —
  never in the Snapshot body, model-facing output, public DTO, or a fixed
  error (`C12-07`/provenance). The bodies carry an opaque
  `calendar:<sha256>` canonicalKey; `calendar.search` output hits carry
  structural ids + title + status + snippet only.
- Reuse semantics (delegated entirely to the existing M1 ReferenceManager,
  `C12-08`): normal presentation reuses the session's latest matching
  Snapshot (revision NULL-safe exact + content hash) with the same rN; a
  changed upstream revision (etag) with identical content materializes a NEW
  Snapshot + new rN; a content change with the same revision also materializes
  a new Snapshot; an explicit refresh always creates a new Snapshot + new rN.
  `reference.open` is stored-only (no external request). A failed
  (`calendar_upstream_error` / `mcp_unavailable` / `mcp_schema_mismatch` /
  `calendar_response_invalid` / `calendar_range_invalid`, closed map) or an
  empty page never erases or mutates an existing Snapshot: history retains
  (`C12-06`). Missing private target on a calendar refresh yields the closed
  `reference_not_found` — the kernel NEVER guesses provider ids.
- Server composition: `apps/server/src/bootstrap.ts` exposes an injectable
  `calendarBinding` seam. Injection is fail-closed: the stored row must exist,
  be kind `calendar`, and its metadata-only `{version,calendarId,account?}`
  selection must match the injected selection exactly
  (`verifyCalendarBinding`); absent injection keeps the registry
  network-disabled (Markdown-only). Per-call frozen-zone resolution and the
  registration-validated bindings are exercised by the kernel regressions
  (C12-08 binding-kind / missing-target / rollback cases).
- Observed regressions (Vitest, this worktree, local runs): genuine-SDK
  `packages/connector-calendar/test/c12-smoke.test.ts` (low-level SDK `Server`
  + `InMemoryTransport` linked pair; inert synthetic provider; no HTTP/stdio/
  OAuth/network) drives the real `McpConnector`, real adapter, real kernel
  broker + ReferenceManager + SQLite: 10 passing cases covering one-page
  frozen-zone materialization with verbatim cursor + durable private target,
  same-revision reuse vs revision-change / content-change new Snapshot+rN,
  stored-only `reference.open` (zero external calls), explicit refresh with
  identical contents (new Snapshot + new rN, one `get-event`, zero
  `search-events`), failed/empty follow-ups retaining old snapshots, a genuine
  late-cancelled result writing no snapshot/rN/set/ref/event/target, opaque
  provenance with provider ids excluded from `modelFacing` but present in the
  private table, and a restart-durable refresh target (new process reuses
  stored target, `get-event` only). Adapter-level cross-calendar get refusal
  (`calendar_range_invalid`, zero upstream calls) is covered. The kernel
  `packages/kernel/test/calendar_tools.test.ts` adds 11 C12-01..08 cases
  including the throwing-target-write full rollback and binding validation.
  Full observed suite/typecheck/lint results are recorded below in "C12 final
  checks". C12-05 (durable private storage) is verified by the restart case
  against real SQLite (migration 0006); formal gates stay separate: C08
  **HOLD**, C10-08 **UNRESOLVED** (production mapping), C11-01 **BLOCKED**,
  actual upstream HTTP status **UNKNOWN**.

#### C12-01..08 gate table (implemented; no adoption claim)

  | item | status | boundary / evidence |
  | --- | --- | --- |
  | C12-01 | IMPLEMENTED | One-page `calendar.search` with the per-Turn frozen zone, ONE upstream call, verbatim cursor; real adapter → real broker → SQLite resource/snapshot/rN/set/events; private target persisted in the SAME observation transaction. Kernel C12-01 + smoke case 1. |
  | C12-02 | IMPLEMENTED | Same revision+content reuses session-latest Snapshot/rN; changed revision (etag) with identical content, or changed content with same revision, materializes new Snapshot+rN. Kernel C12-02 + smoke case 2 (etag + rename). |
  | C12-03 | IMPLEMENTED | Explicit `reference.refresh` with identical contents always creates a new Snapshot+rN and rereads upstream via the private target (one `get-event`, no re-search). Kernel C12-03 + smoke case 4. |
  | C12-04 | IMPLEMENTED | `reference.open` is stored-only: full body from SQLite, zero external requests. Kernel C12-04 + smoke case 4 open phase. |
  | C12-05 | IMPLEMENTED (consumer) | Durable private `calendar_get_targets` (migration 0006) survives a real process restart; refresh reuses the stored target without any search. Smoke cases 5/8 against real SQLite. |
  | C12-06 | IMPLEMENTED (consumer) | Failed (`calendar_upstream_error`) and empty-page observations retain prior Snapshots/history; no deletion is ever inferred; stored open still serves the retained body. Kernel C12-06 + smoke case 5. |
  | C12-07 | IMPLEMENTED | A genuinely late-cancelled observation writes NO snapshot/rN/set/reference/target; a throwing target write rolls back the whole observation transaction; provenance stays opaque (rN + opaque key + structural ids) and provider ids are excluded from model-facing output while surviving only in the private table. Kernel C12-07 (x2) + smoke cases 7/9. |
  | C12-08 | IMPLEMENTED | The pipeline allocates through the single existing ReferenceManager path only; `calendar.search` registers exclusively over a validated kind-`calendar` binding; per-call frozen zone; missing private target never guesses (`reference_not_found`); bootstrap seam validates injected bindings fail-closed. Kernel C12-08 (x2) + registration validation. |

- C12 final checks (observed local run on this worktree, Node 24.12.0): full
  Vitest suite green (after the C12 additions; includes the 10 genuine-SDK
  smoke cases and 11 kernel C12 cases), root `tsc --noEmit` exit 0, and
  `biome check .` clean apart from the pre-existing `recommended` info. These
  are executed-code observations, not a future CI claim; the formal C08 / C10 /
  C11 gates above are unchanged.

### C09-01 / C09-04 / C09-07 / C09-08 trusted read policy, model exposure & real stdio

- This subsection records the CURRENT new-scope observed work: C09-07 trusted
  read-only binding policy, C09-01 / C09-04 model-visible tool exposure, and
  C09-08 the production DEFAULT stdio transport. It supersedes the remaining
  "unverified" C09 naming as the current scope, but the historical PR15/PR16
  counts and the earlier wire/transport subsections above remain historical
  evidence and are NOT restated as this run. It is not a global live-Google /
  Windows / production-registration claim, and no package pin changed
  (`@modelcontextprotocol/sdk@1.30.0`, `zod@4.5.4`, provider pins unchanged).
- CURRENT constructor is `new McpConnector(config, readonly
  McpBindingDefinition[], factory?)`: the trusted `McpBindingDefinition[]`
  (readonly `upstreamTool` / `canonicalSchemaHash` / `category`) is the
  REQUIRED second argument; `factory` stays the optional third. `category`
  reuses the contracts `ToolCategory` vocabulary (`read` / `write` /
  `sensitive` / `unclassified`). This is an internal, breaking-library API
  change; the `new McpConnector(cfg)` calls in the PR15/PR16 HTTP/stdio
  archives are the HISTORICAL API (recorded as such), not a compatibility shim.
- Real in-memory SDK BEFORE → AFTER policy (`before-policy/` and
  `after-policy/` under the out-of-repo `c09-security-verify/`): BEFORE, an
  unclassified fake writer with a neutral-looking `search` name was callable
  and produced a provider effect (`providerEffects=1`), and the model surface
  exposed non-read descriptors. AFTER, trusted `write` / `sensitive` /
  `unclassified` definitions and missing definitions deny `callTool` AND
  `ensureConnected` with fixed `mcp_binding_not_allowed`, `dials=0`,
  `handlerCalls=0`, `providerEffects=0`, `enabledBindings=[]`; the model
  advertisement of four KNOWN descriptors yields only `markdown.search` plus
  the reserved `answer.submit` LAST. A caller-claimed `category:"read"` /
  `readOnlyHint:true` cannot upgrade any class.
- Valid READ-positive: the ORIGINAL `after-policy` read positive is
  SUPERSEDED (its fixture incremented a writer counter; `providerEffects=1`)
  and MUST NOT be cited as a read proof; its supersession note
  (`SUPERSEDED-read-positive.txt`) is retained and the original artifacts are
  unchanged. The corrected, source-distinct immutable-read proof is
  `after-policy/corrected-read-positive/result.json`: `delete-event`
  (`readOnlyHint:false`), config/trust/wire hash linked, `ensureConnected` /
  `callTool` ok, `handlerCalls=1`, `providerEffects=0`, connector shut down
  (`connectedAfterShutdown=false`), fixture server closed. The negative and
  model halves of the original `after-policy` proof remain valid and were NOT
  re-run here.
- Real production DEFAULT stdio (Linux, Node 24.12, SDK 1.30.0 child) in
  `after-stdio/{result,summary,commands}`: the allowed canary is present and
  the excluded canary is ABSENT; the literal six injection-shaped args produce
  no shell marker and no model marker; model-supplied command/args/env travel
  only in the RPC payload (fixed transport), with the actual 2 calls sharing
  one child PID. A missing live-SDK default env name yields fixed
  `mcp_unavailable` with no START record and zero spawns. A direct real-SDK
  ENOENT on the owned path is rejected with the path/canary present, while the
  production connector returns the fixed redacted result with failure count 1.
  Cleanup observed `ownedPidsObserved=2` / `finalOwnedPidsAlive=[]` via the
  owned startup PID + `process.kill(pid, 0)` after shutdown. NO public
  `onclose` claim, NO Windows physical proof, NO fork / OAuth / live Google /
  production registration.
- Default SDK env: EVERY effectively inherited SDK default name must be
  explicitly allowlisted even when unset; there is no extra function-value
  policy or filter. `shell=false` is the SDK pin behavior plus an actual
  metacharacter proof. The PR16 transport bounds and actual `onclose` semantics
  are unchanged.
- Before/after actual-SDK archives (all under the out-of-repo
  `c09-security-verify/`; source + commands + failure history retained there,
  in-repo temporaries removed and not retained in the repo): `ambiguity`
  (6 malformed host variants in both orders permitted before, denied locally
  with zero I/O after; live conflict denied both orders `N` with 0 calls while
  the unrelated `M` read actually succeeds and is the only enabled name),
  `catalog` (before, an unfinished prefix authorized `N` with 1 call; after,
  all bindings disabled, `mcp_schema_mismatch`, `listCount=10`, 0 calls;
  complete tenth page actually succeeds; complete-catalog partial drift
  preserved), and `catalog-shutdown` (before, shutdown during the real
  final-page digest wrongly returned `mcp_schema_mismatch`; after,
  `mcp_unavailable` with `enabled=[]` and 0 calls). These are actual
  observations, not inflated case counts or upstream-compatibility claims.
- Latest local full-battery result (OBSERVED, after this patch set; recorded under
  the out-of-repo `c09-security-verify/final-checks/`): root `pnpm run
  typecheck` exit 0, `pnpm run typecheck:e2e` exit 0, `pnpm test` **94 files /
  1137 passed / 0 skipped** (Linux), and whole-repo `pnpm run lint`
  (`biome check .`) **192 files, 0 errors / 0 warnings / 1 pre-existing info**
  (the `biome.json` `recommended` deprecation is not a new warning). The first
  lint run counted the temporary in-repo `.security-proof/` helpers (216 files,
  33 errors / 60 warnings) which are NOT product code; they were archived
  out-of-repo and removed from the repo, and the affected lint was re-run. This
  is a local, owned-branch observation and not a future CI or head-SHA claim.
  The historical PR16 baseline (1123 tests / 92 files) is NOT used to predict it.

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

### PR17 merged runtime follow-up (observed on 71961c9)

- This subsection records the merged PR17 runtime (`71961c9c29205b6f18c1bf49088214138886f287`,
  merge of `8e87219` PR16-followup into `d3f1878` old-PR17) on branch
  `fix/c09-remaining-security`. The merge-updated constructor is
  `new McpConnector(config, readonly McpBindingDefinition[], factory?)`: the
  trusted, source-reviewed `McpBindingDefinition[]` (`upstreamTool` /
  `canonicalSchemaHash` / `category`) is the REQUIRED second argument and
  `factory` stays the optional third. The PR15/PR16 archive calls
  `new McpConnector(cfg)` / `new McpConnector(cfg, factory)` are the HISTORICAL
  API; there is **no** two-arg compatibility shim, and no wire config, package
  pin (`@modelcontextprotocol/sdk@1.30.0`, `zod@4.5.4`), or source behavior was
  changed by this follow-up.
- The verified PR16 OUT-archive runtime helpers were REUSED (not re-derived)
  from `c09-review-response/{before-runtime,after-runtime-pr16,final-checks-pr16}`,
  adapted ONLY for the constructor signature above. Every helper declares an
  explicit source-reviewed READ definition (`upstreamTool` + probed
  `canonicalSchemaHash` + `category:"read"`) from its fixture schema; the
  definition is never inferred, defaulted, or approved from the connector
  config. All four cases ran the actual merged production source (real SDK
  `Client`), not a reimplementation.
- P2 cancellable backoff (`after-runtime-pr17/backoff`, public observations
  only): the first demand records one failure; the fenced old demand enters the
  pre-construction `1000ms` backoff, and explicit shutdown aborts its
  per-attempt controller so it settles fixed `mcp_unavailable` promptly with
  the failure count preserved at `1` and the mutex released (no stale sleep);
  the fresh post-shutdown demand owns its OWN full `1000ms` backoff (scheduled
  at `+0ms`, before the old stale wait would have been due) and is the only
  call that reaches the upstream handler (`handler_args=["fresh"]`, two
  `1000ms` timers, no auto-replay, factory calls `2`). The merged `P2` run is
  `FIX-VERIFIED`, exit 0.
- P1 default stdio detached cleanup (`after-runtime-pr17/stdio`, public
  `stats()` + `process.kill(pid,0)` on the fixture's OWNED startup-record PID):
  the real default `defaultTransportFactory` spawns a genuine Node child; a
  `tools/call` writes `65537` bytes to stderr and hangs, so the count-only
  latch saturates at `65536`, the connection clears (`connected:false`,
  `consecutiveFailures:1`, `enabledBindings:[]`) and the detached cleanup is
  registered before it finishes. Explicit shutdown joins it: at return the
  child is already dead from the connector's OWN production SIGKILL (exactly
  one, at the original `300ms` grace, `+~308ms` shutdown duration), the
  in-flight overflow call settles fixed `mcp_unavailable`, and
  `final_owned_pids_alive=[]` with no helper safety kill. The merged `P1` run
  is `FIX-VERIFIED`, exit 0.
- Late-handoff generation / observed pre-handoff (`after-runtime-pr17/generation`
  and `generation/observed`), generic controlled PUBLIC transport (no process,
  no pid, no OS-death claim): AFTER the merged explicit `lateCleanupPhase`
  renewal, a renewed generic bounded cleanup waits ONLY on its own matching
  `rawClose` or the configured finite grace — never the superseded SDK
  client-close memo or the already-resolved global close-observed latch. Both
  cases observe that `shutdown()` stays pending while the matching close gate is
  held and the host resource is still open, then settles after release; the
  observed pre-handoff case issues the raw `onclose` with NO physical close
  (`close_count=0`, generation 0), so `closeGeneration` stays a completion
  identity guard only. Real-stdio candidate selection is unchanged. Both runs
  are `VERIFIED`, exit 0.
- Each helper run is archived OUT-OF-REPO under
  `c09-review-response/after-runtime-pr17/` (per case: `stdout.txt`,
  `stderr.txt`, `exit.txt`, `observation.json`, source + bundle + `command.txt`;
  plus `versions.json`, `commands.txt`, `helpers/`, `history/`). The in-repo
  `.review-proof/` scaffolding was TEMPORARY: it was archived first
  (`c09-review-response/final-checks-pr17/` with a 12-file sha256 manifest and
  `pr17-helper-reuse-paths.txt`), then deleted so it cannot pollute whole-repo
  lint. No prior PR16 or `c09-security-verify` archive was overwritten.
- Latest local full-battery result AFTER the merged runtime patch set (in-repo
  scaffolding removed), 94 files / 1143 tests observed: `pnpm run typecheck`
  exit 0; `pnpm run typecheck:e2e` exit 0; `pnpm test` (Vitest) **94 test files
  / 1143 passed / 0 skipped** (Linux); whole-repo `pnpm run lint`
  (`biome check .`) **192 files, 0 errors / 0 warnings / 1 pre-existing info**
  (the `biome.json` `recommended` deprecation info). The historical PR17
  security `final-checks` **1137 tests / 94 files**, PR16 **1129 / 92**, and
  earlier **1123 / 92** remain HISTORICAL truth and are NOT restated as this
  run. `pnpm` performed an implicit local relink of **191** workspace
  `node_modules` entries from the local store (no network, no lockfile change)
  during the run. These are local owned-branch observations, not a future CI or
  head-SHA claim; the formal C09/C10/C11 gates and Calendar adoption stay
  **HOLD**, and no source/test fix was needed (no observed machine failure).

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
