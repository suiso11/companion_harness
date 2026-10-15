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
| `COMPANION_CALENDAR_JSON` | unset (no Calendar) | Strict JSON object `{ selection, connector }` (see C14 below); unset registers no Calendar connector |
| `COMPANION_CALENDAR_PROFILE` | unset (no profile) | Strict opt-in profile selector (see C14 profile below). Unset keeps the previous behavior (explicit host `mcpDefinitions` injection or fail-closed incomplete opt-in). Only `google-readonly` is accepted; any other value fails startup. Requires `COMPANION_CALENDAR_JSON` describing exactly the adopted candidate. |
| `COMPANION_ACTIONS_JSON` | `{"optIn":false,"writeEnabled":false}` | Strict JSON object `{ optIn?, writeEnabled? }` (booleans, default false). HINT ONLY: never supplies a write capability, a category or a binding — see "C21 M5 Action composition" below |

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
  broker + ReferenceManager + SQLite: 9 passing cases (8 pipeline + 1
  adapter-level) covering one-page
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

- C12 final checks (observed local run on this worktree, Node 24.12.0):
  targeted Vitest runs show 9 genuine-SDK smoke cases, 11 kernel C12 cases,
  21 migration cases, and 39 contracts cases green, and root
  `tsc --noEmit` exits 0. Earlier claims of a full-suite and lint run in this
  window were not re-observed for these final corrections and are explicitly
  NOT claimed here; the formal C08 / C10 / C11 gates above are unchanged.
  Additionally, an INDEPENDENT runtime smoke (not vitest: plain node script
  via the repo's vite-node with `node:assert`, reusing the c12-smoke fixture
  shape minus describe/it, inert synthetic provider, real SDK `Server` +
  `McpConnector` + adapter + kernel broker + `ReferenceManager` + durable
  SQLite, deleted after the run) observed end-to-end, in one sequence:
  `calendar.search` succeeded with EXACTLY ONE upstream `search-events` call
  and 1 hit; the private `calendar_get_targets` row carried the exact
  host-side target (`calendarId`/`eventId`/`account`); `reference.open`
  served the stored body with ZERO added upstream calls; an explicit
  `reference.refresh` reread via exactly one `get-event` (no re-search),
  materialized a NEW Snapshot + NEW reference id; and an upstream-failed
  refresh observed `calendar_upstream_error` while the prior snapshot count
  and stored body (retained via `reference.open`) stayed unchanged. Exact
  observed ids (synthetic run): search slice reference
  `9c537b00-eb03-41fc-90e2-ddb289ec89da` / snapshot
  `93394e50-f075-4d4a-82a2-8c5e17ec4521` / canonicalKey
  `calendar:9896429c…f6f8`; refresh snapshot
  `a4e74081-2dd4-45b4-8eb6-b514f5e26cfc` / new reference
  `d29a8066-f39d-4428-af0a-b07364d38e10`; all success booleans true except
  the deliberately failed refresh (`calendar_upstream_error`). This
  synthetic-only run makes NO live-Google/OAuth claim.

### C13 calendar.search Broker exposure / frozen temporal context / cross-source

- This subsection records the CURRENT C13 scope on top of the C12 pipeline
  above. It does NOT change the C12/C08/C10/C11 boundaries (adoption stays
  HOLD, tombstone rules unchanged) and adds NO contracts/schema/migration/
  server changes. Because the whole C13–C15 verification pass is deliberately
  deferred (single final suite after C13–C15), the C13 test additions below
  are recorded as **ADDED, NOT YET RUN** — no executed-verification claim is
  made here.
- `packages/kernel/src/calendar_tools.ts`: the search registration now reads
  the COMPLETE frozen temporal context (not only the zone):
  `turn.frozenContext.temporal` is passed per call to the connector port as
  both `timeZone` and `now` (`CalendarSearchCallOptions` gains the required
  frozen `now`). Frozen values come ONLY from the immutable `turns`
  `frozen_context` row (validated by the existing `FrozenContextSchema`);
  nothing is recomputed, defaulted, clock-derived or rewritten per Run, so a
  Retry (a NEW Run on the SAME Turn via the existing `postRetry`
  next_run_attempt allocator) consumes the identical frozen now/zone.
- `packages/kernel/src/agent.ts` (C13-01/C13-08): `calendar.search` is now a
  model-visible tool. `AGENT_CALENDAR_SEARCH_PARAMETERS` (exported; closed
  literal `additionalProperties:false` schema mirroring
  `CalendarSearchToolInputSchema`: optional `query`, required `start`/`end`,
  `limit` 1-20 default 10, optional opaque `cursor`; NO `freshness` field —
  the Calendar contract has none) is advertised through
  `AGENT_BROKER_TOOL_PARAMETERS`, so `buildAgentToolDefinitions` exposes the
  ONE `calendar.search` descriptor (real `ToolDescriptor` description,
  category `read`) and never the connector-internal
  `list-events`/`search-events`/`get-event` tools. Grants/ordinals/mixed
  references need no new paths: calendar hits flow through the same M1
  delivered-output/grant extraction (`extractGrantCandidates`,
  structural-UUID/rN translation) as Markdown hits.
- C13-02/C13-03 (budget/dedup/timeout/audit): the registration already rides
  the existing ToolBroker pipeline; this slice keeps `dedupMode: "normal"`
  (same-Run same-fingerprint reuse consumes cumulative budgets; failed calls
  clear their cache entry) and maps upstream failures through the closed
  `mapCalendarCode` set. Audit stays metadata-only (fixed codes + digests,
  ordered `budget_reserve -> classify -> validate -> dedup -> execute ->
  normalize -> audit`). No budget/dedup code changed.
- C13-06/C13-07 (cross-source): the shared `ReferenceManager` path is
  UNCHANGED and source-agnostic — one session reference sequence covers
  Markdown and Calendar resources; `reference.open` / `reference.related`
  stay stored-only (Calendar-origin `reference.related` resolves the stored
  link graph deterministically and invents no Markdown rNs, and upstream
  Tombstone/deletion rules are untouched). A failed calendar call audits only
  the fixed code and never adds stale/uncited references or mutates prior
  evidence.
- API surface changed (all add-only, no contracts/migration touched):
  `CalendarSearchCallOptions.now` (required, frozen Turn instant), frozen
  `AGENT_CALENDAR_SEARCH_PARAMETERS` export, one new
  `AGENT_BROKER_TOOL_PARAMETERS` entry (`calendar.search`).
- Focused consumer-visible tests ADDED (packages/kernel/test/
  calendar_tools.test.ts, NOT YET RUN — verification deferred to the single
  final C13-C15 pass): C13-01 exposure (one descriptor, closed parameters,
  upstream tools never exposed, category `read`), C13-02 budget (reserve
  before dedup/execute; dedup reuse still reserves; third call over budget
  blocked with `budget_exceeded` and zero upstream calls), C13-03 dedup
  reuse + stalled-call timeout (`execution_timeout`, nothing materialized),
  C13-04/05 Retry (attempt 2 via `postRetry` reuses the identical frozen
  zone+instant; immutable Turn row unchanged; exactly one upstream call per
  Run, no auto resend), and C13-06/07 mixed-source session (Markdown+
  Calendar one ordinal sequence; store-only `reference.open`/`related` on
  the Calendar-origin reference with zero upstream reads; failed call keeps
  prior references and adds none).
- Remaining integration needs (NOT part of C13): C14 wires the frozen
  instance config/opt-in bootstrap + lazy connection lifecycle (bootstrap.ts
  already owns the validated `calendarBinding` injection seam), and C15 adds
  the fake MCP + fake model + real UI conversation→search→rN→refresh /
  tombstone E2E and CI; the C13 tests above feed the deferred final suite.

### C14 startup composition / strict opt-in Calendar-MCP config

- This subsection records the CURRENT C14 scope on top of C12/C13. It does
  NOT change the C12/C08/C10/C11 boundaries (adoption stays **HOLD / NOT
  ADOPTED**: this build ships NO provider profile, NO adopted binding
  definition and NO category data of its own) and adds NO kernel
  schema/migration/contracts changes. Like C13, the C14 test additions below
  are recorded as **ADDED, NOT YET RUN** — the C13–C15 verification pass is
  deliberately deferred (single final suite after C15); no
  executed-verification claim is made here.
- `apps/server/src/config.ts` (strict opt-in, DEFAULT DISABLED): new frozen
  `COMPANION_CALENDAR_JSON` config (`parseCalendarConfig`), unset ⇒
  `calendar: null`. It must be an exact `{ selection, connector }` object.
  `selection` is a metadata-only host choice (`calendarId` required 1..512,
  optional `account`, no NUL bytes) persisted later ONLY as
  `connector_instances` metadata — never a provider credential. `connector`
  is validated against the shared connector-mcp schema WITHOUT its
  `connectorInstanceId` field (the server itself must fill the exact id it
  registers; an env hint can never claim a stored instance id it does not
  own). Unknown keys, arrays and schema violations fail closed with fixed
  path-free messages. Everything in this file is a CONFIG HINT bound to
  exact identity/transport/binding-hash values.
- Separation of trust (load-bearing invariant): the trusted read-only
  binding definitions (`McpBindingDefinition[]` with their `category`
  vocabulary) are NOT part of this config and CANNOT be expressed through
  env. No env/config path can ever enable a call: the connector hint carries
  no category field, and the parser rejects one if present. Definitions must
  be injected separately by trusted host code; default deny and the exact
  identity/schema-hash lattice (config hint hash ⇒ host definition hash ⇒
  live tools/list hash) remain owned by the connector.
- `apps/server/src/bootstrap.ts` (owned composition + lifecycle): when
  `config.calendar` is set, the composition REQUIRES the separate host
  trusted `mcpDefinitions` option (an opt-in without them is INCOMPLETE and
  fails closed with a fixed `server_config_invalid` before listen — never a
  silent disable and never a discovered/model-defined registration). The
  C12 injected-adapter seam (`calendarBinding`) and the owned C14
  composition are mutually exclusive (fail closed on the conflict). Before
  any side effect, a fail-closed preflight requires every exact adapter
  tool (`list-events`/`search-events`/`get-event` defaults) to be a
  configured hint binding linked to exactly one non-ambiguous host
  definition of category `read` with an EQUAL hash; an incompatible
  configuration therefore never registers an instance, never attempts any
  connection and never starts the listener. The preflight only responds to
  already-injected host definitions; final enforcement stays inside the
  connector (config/definition/live-hash gate + default deny).
- Registered lifecycle (server-OWNED): after the preflight, ONE metadata
  `calendar` connector instance is registered via the existing kernel
  `ensureCalendarConnectorInstance` (display name
  `CALENDAR_CONNECTOR_DISPLAY_NAME = "calendar-mcp"` for the unprofiled
  composition, `GOOGLE_READONLY_CONNECTOR_DISPLAY_NAME =
  "calendar-mcp-google-readonly"` for the pinned profile — never shared, so
  the two compositions cannot reuse each other's rows, `version:1`, exact
  selection reconciliation — a changed selection fails closed), the hint's
  connector config is merged with the just-registered exact
  `connectorInstanceId`, one `McpConnector` is constructed (NO I/O at
  construction), the persisted row is re-verified (defense-in-depth exact
  identity), and the already-validated `createCalendarConnector` adapter is
  bound to that instance over the durable private target store. The
  C13 seam (`calendarBinding`) stays available for out-of-server callers.
- Non-blocking semantics: a DISABLED calendar (no env) never registers
  anything, and an UNAVAILABLE upstream (dead MCP endpoint/child) can never
  block server start — connection is lazy (first allowed call), failures
  surface per-call as the fixed `mcp_unavailable`. Calendar is fully usable
  WITHOUT any Markdown root: with no roots and an owned calendar, the
  single ToolBroker carries exactly `calendar.search`,
  `reference.open`, `reference.refresh`, `reference.related` (no
  `markdown.search`); counts are logged via a fixed `server.calendar_ready`
  event (never URLs/ids). The existing Markdown bound-roots guard is
  unchanged.
- Bounded shutdown (C14): on graceful drain, after the engine drain and
  BEFORE the DB close, the ONE owned connector is shut down under an outer
  backstop budget (`MCP_SHUTDOWN_BOUND_MS = 10_000`, exported
  `boundedMcpShutdown`; `options.mcpShutdownMs` is a test override capped at
  60 s). A budget loss only logs a fixed `server.calendar_mcp_shutdown_timeout`
  warn and lets the shutdown continue — the connector keeps its own internal
  stdio bounds (config `shutdownWaitMs` + fixed force-kill window). The
  listener-failure and generic startup-failure paths stop the owned
  connector best-effort as well (engine ⇒ connector ⇒ DB close order).
- Fake E2E seam inventory (exact API used by C15): `startServer({
  env: { ..., COMPANION_CALENDAR_JSON }, mcpDefinitions: readonly
  McpBindingDefinition[], mcpTransportFactory?: TransportFactory,
  mcpShutdownMs?: number, calendarBinding?: CalendarServerBinding | null,
  modelGateway?: ModelGateway | null, modelFetch?: FetchImpl,
  drainMs?: number, logger?, now?, stat?, platform?, chmod? })` — the fake
  MCP path uses the config opt-in + host definitions + an injected
  `mcpTransportFactory` (real SDK `Transport`, e.g. an in-memory pair) and
  goes through the real owned registration/adapter/connector pipeline; the
  deeper `calendarBinding` adapter seam stays for tests that build the
  port themselves. No production path passes these test-only options.
- Tests ADDED, NOT YET RUN: `apps/server/test/config.test.ts` (calendar
  opt-in defaults/parsing/deep-freeze, unknown-key and category-in-hint
  rejection, shared-schema violations, fixed-message boundaries) and
  `apps/server/test/bootstrap.test.ts` (incomplete opt-in fail closed;
  incompatible-definition fail closed with zero registration and zero
  factory invocations; mutual-exclusion fail closed; exact single calendar
  instance + four-tool broker with NO Markdown roots and a zero-dial lazy
  factory; outer shutdown bound cap). Apps/server now also declares
  workspace dependencies on `@companion/connector-mcp` and
  `@companion/connector-calendar`.

### C14 pinned google-readonly profile (CURRENT: adopted as host composition)

- HISTORICAL (above in this section): no provider profile adopted. CURRENT:
  the host-owned pinned profile `google-readonly`
  (`apps/server/src/calendarReadonlyProfile.ts`, strict opt-in
  `COMPANION_CALENDAR_PROFILE=google-readonly`) ADOPTS the reviewed
  candidate as the normal-startup composition. It is NOT a rewrite of the
  pipeline: the JSON hint, the owned registration, the lazy connector, the
  adapter and the fail-closed gates are unchanged; the profile only supplies
  the exact trusted definitions from host code and pins the hint to the
  candidate. Profile-adopted is live-accepted for authenticated reads:
  user OAuth is COMPLETED and authenticated live reads are OBSERVED
  (see "Live readonly acceptance ledger"); only fresh consent-screen
  scope display remains unobserved (never a missing-consent claim, never
  force reconsent). Still open: live production/C11 positive (BLOCKED)
  and manual Win11 smoke.
- Adoption pin (exact form, verified against a real fork checkout):
  `suiso11/google-calendar-mcp`
  commit `6939311fd3eae9846648e0a175e304c9500f578e`
  (tree `f01b5a7b608c4091906a52c0784b828c35963de9`,
  package `@cocal/google-calendar-mcp@3.0.0-readonly.2`, lock SHA-256
  `63261d25…bd533`), wire identity `{name:"google-calendar",
  version:"3.0.0-readonly.2"}`, exactly
  `list-events`/`search-events`/`get-event` with the live-wire hashes
  (`81222b89…`, `d48ba36e…`, `8c6736e2…` — SDK wire bytes, NOT the
  registry-direct `a065/012e/913…` diagnostic bytes). Scope stays
  `calendar.events.readonly` only; no `CalendarList` metadata lookup on the
  MCP path; no writes; `list-calendars` absent (denied, never registered).
- Selection rules (all fail closed with fixed messages, before listen):
  unset profile keeps the previous behavior; an unknown profile name is
  rejected; a set profile without `COMPANION_CALENDAR_JSON` is an incomplete
  opt-in; profile + explicit `mcpDefinitions` injection conflict; the hint
  must carry the exact pinned identity, stdio transport, and exactly the 3
  pinned bindings (a substituted version/name, an HTTP transport, an added
  `list-calendars`/write binding, a dropped binding, or a rehashed binding
  all fail; an arbitrary user binding/hash can never grant read or write).
  The optional `selection.account`, when present, must match the pinned fork
  grammar `^[a-z0-9_-]{1,64}$` (lowercase ASCII; email/uppercase/overlength/
  other characters fail as `calendar profile account mismatch`); omitted
  stays valid. The generic non-profile account contract (1..512, no NUL) is
  unchanged. All of the above — frozen selector, completeness, injected
  conflicts, exact profile compatibility — resolve synchronously BEFORE
  `ensureDbDir`/open/migrations, so a failing profile creates neither the DB
  file nor its parent dir and leaves an existing older DB byte-identical.
  The profile registers under its own boring persisted display name
  `calendar-mcp-google-readonly` (never the generic `calendar-mcp`), so a
  previously injected generic row with the same selection is never reused;
  canonical keys (over the instance id) separate, and an old generic target
  cannot refresh through the new provider (`reference_not_found`, no `get`
  call). Legacy/mismatched display-name rows fail closed on re-verify.
- Explicit preparation / auth / run (all USER-OPERATED, outside the repo;
  this worker never launches a browser, OAuth consent, or a real Calendar
  RPC; no secret is read or pasted anywhere below):
  1. Google Cloud prerequisites (user's own project, outside the repo):
     create a project and enable the Google Calendar API (official guide
     `https://developers.google.com/workspace/guides/create-project`);
     configure the OAuth consent screen as user type External with publishing
     status Testing and add your Google account as a test user (official
     guide `https://developers.google.com/workspace/guides/configure-oauth-consent`;
     Testing-mode grants expire and need re-consent — expected, unrelated to
     the readonly scope); then create an OAuth client ID of application type
     "Desktop app" and download its JSON (official guide
     `https://developers.google.com/workspace/guides/create-credentials#oauth-client-id`).
     The download carries a top-level "installed" object. A "Web application"
     download (top-level "web") is UNSUPPORTED: the pinned fork's
     `loadCredentialsFromFile` (`src/auth/client.ts` at the commit below)
     accepts ONLY the "installed" shape (or direct `client_id`/`client_secret`
     fields) and rejects anything else with `Invalid credentials file format`.
  2. Fork checkout, verification, then build (exact pin form; verification
     runs BEFORE any install/build):
     repo `https://github.com/suiso11/google-calendar-mcp`, commit
     `6939311fd3eae9846648e0a175e304c9500f578e`, tree
     `f01b5a7b608c4091906a52c0784b828c35963de9`, package
     `@cocal/google-calendar-mcp@3.0.0-readonly.2`, `package-lock.json`
     SHA-256
     `63261d25992ee9c97136a60bbf4fe52a5485cadea28b34d6b8b6c685f38bd533`.
     Run from the Companion checkout root (the directory containing
     `pnpm-workspace.yaml`); record its absolute path FIRST so step 5 can
     return to it. Requires the already-available exact engine `node
     v24.12.0` (see Source run above; no installer is fetched here). The
     whole clone/checkout/pin/install/build sequence runs in its OWN
     subshell with `set -eu`, so a pasted `test` failure aborts BEFORE
     `npm ci` / `npm run build` even in an interactive paste, without
     leaking `set -e` into the user's interactive shell options, and the
     outer Companion cwd is preserved (there is deliberately no bare
     `cd "$FORK_DIR"` outside the subshell):
     ```bash
     COMPANION_DIR="$PWD"  # absolute Companion checkout root (contains pnpm-workspace.yaml); keep for step 5
     FORK_DIR="$HOME/gcal-readonly"
     PIN_COMMIT="6939311fd3eae9846648e0a175e304c9500f578e"
     PIN_TREE="f01b5a7b608c4091906a52c0784b828c35963de9"
     PIN_PKG="@cocal/google-calendar-mcp@3.0.0-readonly.2"
     PIN_LOCK="63261d25992ee9c97136a60bbf4fe52a5485cadea28b34d6b8b6c685f38bd533"
     test "$(node -p "process.version")" = "v24.12.0"
     (
       set -eu
       git clone https://github.com/suiso11/google-calendar-mcp.git "$FORK_DIR"
       cd "$FORK_DIR"
       git fetch origin "$PIN_COMMIT"
       git checkout "$PIN_COMMIT"
       test "$(git rev-parse HEAD)" = "$PIN_COMMIT"
       test "$(git rev-parse 'HEAD^{tree}')" = "$PIN_TREE"
       test "$(node -p "require('./package.json').name + '@' + require('./package.json').version")" = "$PIN_PKG"
       test "$(node -e "const fs=require('node:fs');const crypto=require('node:crypto');process.stdout.write(crypto.createHash('sha256').update(fs.readFileSync('package-lock.json')).digest('hex'))")" = "$PIN_LOCK"
       npm ci --ignore-scripts
       npm run build
       node build/index.js version
     )
     ```
     The lock digest above uses the required Node `crypto` (portable
     Linux/macOS; no `sha256sum`/`Get-FileHash` needed). The last line
     prints `Google Calendar MCP Server v3.0.0-readonly.2`
     (wire identity `{name:"google-calendar", version:"3.0.0-readonly.2"}`:
     the name is hardcoded in fork `src/server.ts`, the version is read from
     `package.json` at runtime at the pinned commit).
  3. Secrets (user-private dir, OUTSIDE the repo, never committed):
     ```bash
     PRIV="$HOME/.config/companion-private"
     mkdir -p "$PRIV"
     chmod 700 "$PRIV"
     cp /path/to/downloaded-desktop-client.json "$PRIV/gcp-oauth.keys.json"
     chmod 600 "$PRIV/gcp-oauth.keys.json"
     export GOOGLE_OAUTH_CREDENTIALS="$PRIV/gcp-oauth.keys.json"
     export GOOGLE_CALENDAR_MCP_READONLY_TOKEN_PATH="$HOME/.config/google-calendar-mcp-readonly/tokens.json"
     ```
     Token-file resolution at the pin (`src/auth/paths.js`): the
     `GOOGLE_CALENDAR_MCP_READONLY_TOKEN_PATH` env path first, else
     `XDG_CONFIG_HOME`, else `~/.config/google-calendar-mcp-readonly/tokens.json`
     (mode `0600`, written by the fork on consent). The broad-scope
     `GOOGLE_CALENDAR_MCP_TOKEN_PATH` is intentionally IGNORED there, a legacy
     single-account token file is REJECTED, and a stored grant whose scope is
     not exactly `https://www.googleapis.com/auth/calendar.events.readonly`
     is rejected (`src/auth/scopes.ts` `READONLY_CALENDAR_SCOPES`,
     `src/auth/tokenManager.ts`): an old broader token can never be reused —
     fresh readonly consent is required.
  4. Consent (USER-INTERACTIVE on the user's machine; NEVER run by a worker):
     ```bash
     node "$FORK_DIR/build/index.js" auth
     ```
     consent for the default local account (mode `normal`), or
     `node "$FORK_DIR/build/index.js" auth work` for a named LOCAL account id
     (lowercase 1-64 `[a-z0-9_-]`, e.g. `work` — a local key, NOT a Google
     account name or email; `src/auth/paths.js`
     `getAccountMode`/`validateAccountId` at the pin). The fork serves the
     loopback callback `http://localhost:<3500-3505>/oauth2callback`
     (`src/auth/server.ts` at the pin) and opens the browser; consent shows
     ONLY the `calendar.events.readonly` scope.
  5. Normal run (POSIX snippet below is fully runnable on Linux/macOS;
     PowerShell differences are listed after it; a manual Windows 11 run is
     still pending). `calendarId` is the real user choice (`primary` works);
     `account` is the LOCAL account id used at consent step 4 (`normal` when
     `auth` ran without an id), or omit `account` for the default. The hint
     JSON is GENERATED (never hand-edited): the absolute node command ONLY
     (`process.execPath`; the SDK spawns with `shell:false`, so a shell
     command line is never valid), the args array with the absolute fork entry
     plus the explicit `--enable-tools` comma list, the OS-platform SDK
     implicit allowlist plus the three explicit `GOOGLE_*` names, and the
     three full pinned live-wire hashes (SDK wire bytes, NOT the
     registry-direct `a065/012e/913…` diagnostic bytes):
      ```bash
      # Absolute Companion checkout root recorded in step 2 (if this is a
      # new shell, set it to that path first; it contains pnpm-workspace.yaml).
      # Example: COMPANION_DIR="$HOME/companion_harness"
      FORK_DIR="$HOME/gcal-readonly"   # verified checkout from step 2
     ACCT="normal"                    # local account id from step 4
     cat > /tmp/gen-calendar-json.mjs <<'EOF'
     import os from "node:os";
     import path from "node:path";
     const forkDir = process.argv[2];
     const account = process.argv[3] === "" ? undefined : process.argv[3];
     const posixBase = ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"];
     const winBase = ["APPDATA", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "PATH", "PROCESSOR_ARCHITECTURE", "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "USERNAME", "USERPROFILE", "PROGRAMFILES"];
     const base = os.platform() === "win32" ? winBase : posixBase;
     const doc = {
       selection: account === undefined ? { calendarId: "primary" } : { calendarId: "primary", account },
       connector: {
         serverId: "calendar-readonly",
         kind: "mcp",
         expectedServerName: "google-calendar",
         version: "3.0.0-readonly.2",
         transport: {
           kind: "stdio",
           command: process.execPath,
           args: [path.resolve(forkDir, "build", "index.js"), "--enable-tools", "list-events,search-events,get-event"],
           envAllowlist: [...base, "GOOGLE_OAUTH_CREDENTIALS", "GOOGLE_CALENDAR_MCP_READONLY_TOKEN_PATH", "GOOGLE_ACCOUNT_MODE"],
         },
         bindings: [
           { upstreamTool: "list-events", canonicalSchemaHash: "81222b89482cba77b12a707c2097c66df383cab7929c14dca03cc303846d794c" },
           { upstreamTool: "search-events", canonicalSchemaHash: "d48ba36e7f280d92eaba9550323e90aa7a6d7c758812932ad62012f4514558b7" },
           { upstreamTool: "get-event", canonicalSchemaHash: "8c6736e2a1f397d0735efa5c0881f5c350c300b21a0b026e80c112258b596bda" },
         ],
       },
     };
     process.stdout.write(JSON.stringify(doc));
     EOF
     export COMPANION_CALENDAR_PROFILE=google-readonly
      export COMPANION_CALENDAR_JSON="$(node /tmp/gen-calendar-json.mjs "$FORK_DIR" "$ACCT")"
      export GOOGLE_ACCOUNT_MODE="$ACCT"
      cd "$COMPANION_DIR" && pnpm start  # launches Companion (root pnpm start contract), NOT the fork; never run pnpm start inside $FORK_DIR
      ```
     The SDK implicit names above are the live SDK 1.30.0
     `DEFAULT_INHERITED_ENV_VARS` (`dist/esm/client/stdio.js`: POSIX 6 /
     win32 12; `shell:false` at the spawn call site) — no other inherited
     name is passed, and the three exported `GOOGLE_*` values travel ONLY
     because they are both exported here AND allowlisted there (strict
     allowlist: anything else is never passed to the child). Missing auth
     surfaces as the fixed `mcp_unavailable` per call (never fake success);
      shutdown stays bounded and clean. PowerShell differences (not a full
      Windows run): `export X="..."` is `$env:X="..."`; the pin digest and
      package-identity checks are the same portable `node` one-liners above
      (no `sha256sum` / `Get-FileHash` needed), and there is no
      `chmod` guarantee (rely on the per-user profile ACL); the node generator
      itself is cross-platform via `os.platform()`. Manual Windows 11 is still
      pending.
  Credential-free runtime proof (no OAuth, no browser, no live Google):
  `docs/evidence/calendar-readonly-profile/smoke-profile.result.json`
  (22/22: pin reality, auth-gate source check, real SDK initialize/tools-list
  over actual fork code via InMemory + fixture provider, profile 3/3 enable,
  adapter search/get runnable, list-calendars denied with zero metadata I/O,
  mismatch fail-closed, normal `startServer` ownership + lazy + error path,
  zero network attempts) and
  `docs/evidence/calendar-readonly-profile/cli-profile.result.json` (actual
  normal-CLI `pnpm start` acceptance with missing credentials). What those
  artifacts prove is the RUNTIME side only — wire identity, the three
   live-wire hashes, and behavior. They do NOT re-verify the source SHA: the
   full commit/tree/package/lock verification in step 2 above is the prerequisite that
  must pass BEFORE `npm ci --ignore-scripts` + `npm run build`, and the
   runtime proof assumes that prerequisite was met.

  Durable local run (checked-in launcher, env-only secrets):
  `run-google-readonly.sh` (repo root, POSIX `sh`) generates
  `COMPANION_CALENDAR_JSON` exactly per the step-5 generator above
  (`primary`, account from `GOOGLE_ACCOUNT_MODE` default `normal`,
  pinned wire identity + 3 live-wire hashes, explicit `GOOGLE_*`
  allowlist) and execs `pnpm start` with
  `COMPANION_CALENDAR_PROFILE=google-readonly` on loopback port
  `COMPANION_PORT` (default `3000`). It embeds no secret: credentials
  come from `GOOGLE_OAUTH_CREDENTIALS` (launcher actual default
  `$HOME/gcal-readonly/gcp-oauth.keys.json`) and the token path env
  (default `~/.config/google-calendar-mcp-readonly/tokens.json`).
  The step-3 `$PRIV/gcp-oauth.keys.json` path above is a template only:
  the current live path is the launcher default (overridable via
  `GOOGLE_OAUTH_CREDENTIALS` env), keys are not moved.
   Actions stay disabled (`COMPANION_ACTIONS_JSON` explicitly unset).
  Model: an already-exported `COMPANION_MODEL_JSON` wins; otherwise the
  launcher builds one from the private git-ignored runtime file
  `.env.litellm` (0600, never committed/logged) against the existing local
  LiteLLM proxy (`openai-compatible`, loopback, no new keys or policy
  changes); with neither, runs fail closed while health + calendar
  registration stay verifiable. Observed: model `qwen-local` via the
  loopback proxy; a live read-only conversation completed end to end
  (`run.completed`, one `calendar.search` succeeded/accepted, one
  `reference.presented` with a snippet evidence grant = `[r1]` cited, turn
  selected). Earlier unguided prompts failed closed after repeated
  `calendar_range_invalid` (model-sent ranges without explicit offsets)
  plus step/whole-run timeouts; the proving prompt carried an explicit
  RFC3339 range (`2026-10-14T00:00:00Z` to `2026-10-15T00:00:00Z`). DB is the normal OS app-data
  default; no migration beyond standard startup. Logs stay on
  stdout/stderr (no app log files); for persistence run it under
  `tmux new-session -d -s companion-cal ./run-google-readonly.sh` and
  read back scrollback instead of a log file.

### C15 Calendar fake E2E harness fixes (observed: refresh + tombstone scenarios)

- The two failing C15 browser scenarios were ROOT-CAUSED against the real
  agent strategy, not worked around. `reference.refresh` was rejected by the
  broker with `invalid_input` on BOTH scenarios: the model addressed `r1`,
  but `translateReferenceArgs` seeds the per-run `rN` -> UUID map ONLY from
  the turn's FROZEN reference context, and the session reference context is
  written ONLY by the real §14.8 CAS `PUT` that the UI performs when the user
  OPENS a citation. The refresh/tombstone scenarios re-addressed `r1` in a
  later turn without ever opening it, so `r1` was legitimately not
  addressable. The fix is in the harness, not in production semantics: the
  scenarios now perform the REAL user selection step (click the delivered
  `r1` citation, drawer opens, real conditional `PUT` runs) before the
  follow-up turn. No selection is faked server-side and no UI path is
  bypassed.
- The scripted fake model (`apps/server/e2e/calendar/model.ts`) is now
  STATELESS: the fixed plan is selected from the CURRENT turn request text
  (the last user message framed `User request:`), the plan step is the count
  of real tool feedbacks in that turn's own transcript, and the answer
  citation is the highest `rN` ordinal those feedbacks actually delivered.
  The previous gateway-global `GatewayState` (plan/turn/step/learnedOrdinal
  reset via `userMessageCount`) could reset a plan or lose a delivered grant
  on a turn change and leaked state across sessions sharing one gateway;
  that shared state is gone. `Reference.refresh` itself needed no production
  change — the observed `invalid_input` was correct behavior for an
  unselected `rN`.
- Observed verification (only the two previously failing scenarios were
  re-run; the two passing scenarios were NOT re-run):
  `COMPANION_E2E_CALENDAR=1 playwright test --grep 'refresh|tombstone'`
  -> **2 passed** (`/tmp/calendar-refresh-fixed.log`), plus
  `tsc --noEmit -p apps/server/tsconfig.e2e.json` exit 0 and
  `biome check` on the two touched e2e files, 0 findings.

#### C15 POSITIVE authoritative tombstone — final browser proof (observed)

- The positive tombstone scenario
  (`apps/server/e2e/calendar/tombstone.spec.ts`) is now GREEN in a real
  chromium browser. Observed verification (FRESH harness, no reused state):
  from `apps/server`, `COMPANION_E2E_CALENDAR=1 pnpm exec playwright test
  --config playwright.config.ts --grep 'positive authoritative'` →
  **1 passed (4.6s)**, full log retained at
  `/tmp/calendar-authoritative-tombstone-final.log`. The harness's own
  `_diagnose.ts` / `_drive-stage.mjs` root-cause probes were removed after
  the proof.
- Fixture binding root fix
  (`apps/server/e2e/calendar/authoritativeBinding.ts`): the fixture's raw
  `McpConnectorConfig` now carries the explicit root fields
  `clientName: "companion-harness"` / `clientVersion: "0.0.0"` (no schema
  inference). App C (port 4185) boots the REAL production Calendar adapter
  over a REAL `McpConnector` on the official inert SDK
  `InMemoryTransport`, whose scripted fake MCP server additionally
  advertises the trusted read binding `get-event-authoritative`.
- The tombstone is produced ONLY by the explicit host-trusted fixture gate:
  the loopback control seam arms `authoritativeDeleted`; only then does
  `get` perform a SEPARATE real wire `tools/call` of
  `get-event-authoritative`, decoded by the UNCHANGED production
  `normalizeGetResult` (exact synthetic revision + `etag` basis +
  `cancelled`), and the fixture wrapper (never the production normalizer)
  flips it to `status: "deleted"`. Anything else degrades to the ordinary
  adapter read. This stays a test-only synthesis; it does NOT loosen the
  C11-01 policy and is NOT a live/OAuth/production tombstone claim.
- Observed scenario assertions (all through the REAL UI/API): turn 1
  delivers r1 and the REAL citation click freezes r1 via the real §14.8
  conditional `PUT`; the armed turn 2 `reference.refresh` over the real
  adapter/broker materializes a NEW r2 citation whose drawer body carries
  `"status":"deleted"`; the prior r1 drawer body still shows
  `"status":"confirmed"` with the original title/start (history retained,
  open prior rN); control status shows `tombstoneGetCalls=1` (exactly one
  authoritative get, reached only after the gate was armed). No DB seeding,
  no manual reference presentation, no UI bypass, no snapshot fabrication
  outside the explicit gate.

### C21 M5 Action composition (triple gate)

- This subsection records the CURRENT C21 scope on top of C17-C20. Focused
  verification observed on this worktree (Node 24.12.0):
  `apps/server/test/action_composition.test.ts` 9/9 green over real
  `startServer` + temp SQLite (disabled direct capability-reads 0 / close 0,
  disabled derived factory 0 / close 0, enabled owned close exactly 1,
  enabled caller-owned close 0, enabled absent/both/neither/invalid-capability/
  mismatched-instance fail closed before listen with no listener leak) and
  root `tsc --noEmit -p tsconfig.json` exit 0. No full-suite rerun is claimed
  here.
- Listen-failure follow-up (independent review
  `ReviewReplayCompositionIdentity` on repair branch `99124aa`; ground truth
  per task, not rerun pre-fix): the listen-failure catch invoked the adopted
  enabled owned write-port hook and then the outer startup-failure catch
  invoked the SAME hook again (2 closes; the injected hook is never required
  to be idempotent). `apps/server/src/bootstrap.ts` now CONSUMES the adopted
  hook (`takeOwnedActionShutdown`: cleared BEFORE invoke, so a sync throw or
  rejected promise still counts as used) at every invoke site
  (listen-failure catch, outer startup catch, post-drain shutdown), keeping
  only enabled owned adoption (disabled never closed, caller-owned never
  closed) with all failed-startup/drain cleanup paths exactly once and the
  listener error still rethrown. Regression:
  `apps/server/test/action_composition.test.ts` gains a REAL
  occupied-loopback-port fixture (live holder server, second `startServer`
  on the same port): genuine `EADDRINUSE` propagates, owned shutdown count
  is exactly 1, SIGINT/SIGTERM counts are stable, the holder still serves
  (disabled approve 409), and the same DB path restarts cleanly with a
  further exactly-1 close. Actual-runtime proof: the same standalone smoke
  (`.review-plan-work/smoke-replay-shutdown.ts` via repo tsx, removed after
  the T2 note above; review JSON kept) 12/12 checks, incl.
  `code=EADDRINUSE closed=1` with SIGINT/SIGTERM `1/1` stable. Focused
  `action_composition` 10/10 green (9 prior + 1 new), owned `biome check`
  clean. No push/resolve; thread IDs are for the parent to publish.
- Config (strict opt-in, DEFAULT DISABLED on both flags):
  `COMPANION_ACTIONS_JSON` is an exact `{ optIn?, writeEnabled? }` object
  parsed by `parseActionConfig`; both flags default to `false` and the
  frozen result is exposed as `config.actions`. Unknown keys, non-boolean
  values and non-objects fail closed with a fixed message. These flags are
  HINTS ONLY: they can never carry a write capability, a category, a
  connector instance id or any authorization decision.
- Dedicated write binding (trusted host code ONLY): the exact
  `CalendarActionWritePort` is injected through
  `startServer({ actionWriteBinding: { port, shutdown?, owned? } })`. It is
  never read from env/config. `owned: true` (explicit) transfers the port's
  lifecycle to the server ONLY when the triple gate actually opens, which
  then closes it after the engine drain and
  before the DB close; a caller-owned port (the default) is never closed by
  the server and extra caller-owned ports are never closed arbitrarily.
- TRIPLE gate: `m5-action` and the proposal-only `calendar.reschedule`
  registration exist ONLY when (1) `config.actions.optIn`, (2)
  `config.actions.writeEnabled`, and (3) a dedicated trusted write port whose
  enabled capability (`tool: calendar.reschedule`, editable fields exactly
  `["start","end"]`, `writeEnabled: true`) names the EXACT ACTIVE Calendar
  instance of the composed read binding — all three hold. When the config
  opts in and the write binding is absent, unusable (both/neither of
  port/derivePort), invalid, or does not match, startup fails closed
  (`server_config_invalid`, before listen); an injected port with the config
  disabled is simply never adopted (no derive call, no capability read, no
  use, no owned shutdown). There is deliberately NO production write
  binding selected in this codebase.
- Wired composition when the gate is open: one existing `ReferenceManager`
  (same DB), one `ActionExecutionService`, the authoritative read port
  `createCalendarActionReadPort` over the EXISTING Calendar `get` binding +
  the DURABLE private target store (real `deleted` observations pass
  through; nothing is synthesized; abort is respected before any call), the
  repository's SINGLE shared proposal stager with `writeEnabled: true`, the
  `calendar.reschedule` proposal-only registration, and the deterministic
  `m5-action` RunStrategy over `createActionStrategy`.
- Disabled behaviour: with the gate closed nothing can be staged (the stager
  refuses) and `POST .../proposals/:id/approve` returns a fixed
  `409 action_execution_disabled` BEFORE any repository call, so no queued
  Action Run (and therefore no orphan execution) can be created. Decision
  READS (`GET .../proposals`) keep listing existing state unchanged, and
  reject stays state-only.
- Read-back: the strategy verifies the post-write observation by STRICT JSON
  parsing of the canonical event body and exact `start`/`end` equality
  against the normalized intended instants (no substring matching), plus the
  same target identity and a non-deleted status; anything else is
  `succeeded_unverified`/fail-closed.
- Fake harness seam for C22 (exact API): inject deterministic fakes through
  `actionWriteBinding` (write port) and the existing `calendarBinding`
  (read/search port) seams; production passes neither. The write port must
  be pre-bound to the Calendar instance id the harness provisions (the
  server re-verifies it), and it must never retry `update`.

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

## C24 action-core review fixes (verified)

Four evidence-backed review bugs on the m5-action core, each fixed in its own
commit with a focused regression test; all four reviewed ranges are the ONLY
source touched (no scope broadening, no UI/server/browser changes).

- **Fix 1 — expired pending proposal still occupied the session cap**
  (`action_proposals.ts` `commitStaged`, before the one-pending-per-session
  recheck; commit `1d736779c1351e3e5bc0273fa8043aeb6a7489b7`): Within the
  caller's completion transaction, older pending rows with
  `expires_at <= now` are expired FIRST (`status='expired'`,
  `resolved_at=now`, `decision_turn_id=NULL`, satisfying the
  `action_proposals` CHECK), so an unattended expiry no longer blocks a fresh
  proposal in the same session. Boundary is EXACT 15min (`expires_at <= now`
  matches the stager's `now >= entry.expiresAt`). A failed completion rolls
  the sweep back with everything else (single transaction). Regression:
  `packages/kernel/test/action_proposals.test.ts` "expires an unattended
  pending proposal at commit time and frees the session cap (exact 15min
  boundary)" — unattended expiry, then the new proposal commits, old row is
  `expired/resolved@now/decision NULL`, and the forced-rollback restores the
  un-swept pending row.

- **Fix 2 — `resolveTarget === undefined` after the grant wrongly returned
  `succeeded_unverified` with 0 writes**
  (`action_strategy.ts` step 2; commit
  `da951228a10952f0c8b467efd0c25c8d8df267c3`): The host-private target is
  now resolved BEFORE `runActionPreflight` can consume the one-shot grant.
  A missing target fails through the EXACT real preflight-failure terminal
  (failed receipt + non-terminal `action.preflight_failed` + `run.failed`,
  marker NULL, UNCONSUMED grant, zero writes); a success claim is never made
  for an unattempted write. The later post-gate undefined-target
  `succeeded_unverified` branch is removed; injection-binding defaults are
  untouched. Regression: `action_scheduler_pickup.test.ts`
  "fails closed through the REAL preflight-failure terminal when the host
  cannot resolve the private target" — real RunEngine pickup, `writes: []`,
  `consumed_at` NULL, `externalCallStartedAt` NULL, last event `run.failed`.

- **Fix 4 — recovery sweep INNER JOIN excluded m5-action runs whose
  execution row is missing** (`action_executions.ts`
  `validateAndRecoverActionRuns`; commit
  `043c0a211675192161e152839925ea5eaf2d59a6`): the sweep now queries ALL
  `strategy='m5-action'` runs directly (the previous inner join silently
  skipped a real orphan). The existing validation pass rejects a missing
  execution with `DatabaseStateInvalidError` BEFORE any mutation, so the
  whole sweep fails closed with zero writes. Regression:
  `action_executions.test.ts` "fail-closes the WHOLE sweep when an
  m5-action run has NO execution row (real orphan is never silently
  skipped)" — a recoverable executing orphan plus an execution-less m5-action
  run throw `/has no execution/` and BOTH pairs stay untouched.

- **Fix 3 — recovery classifier rejected a valid post-marker
  `definite_failure` terminal** (`action_executions.ts`
  `classifyActionPair`; commit
  `9582355843d4e47974014a7ba13d65d729aeb5a9`): `failed` is now legal in BOTH
  marker states — pre-marker failure (preflight failure / pre-marker cancel,
  marker NULL) AND post-marker `definite_failure` (marker + CONSUMED grant
  + failed receipt both required by the unchanged follow-up checks). Invalid
  combos still fail closed, including a consumed grant on a pre-marker
  failed execution (never producible). Regression: "accepts an
  ALREADY-terminal post-marker definite_failure pair as unchanged"
  (startup/drain idempotency: `unchanged:1`) and "fails closed on a
  pre-marker failed execution with a consumed grant".

- Temporary scaffold deletions from the C15 commit `347dce3`
  (tracked `tombstone-run.log` copies, `test-results/.last-run.json`, and
  `logfile/tmp/*.log` action-browser-safety/approve scans — all authored by
  agents, none user-owned) were deleted in commit
  `c5b336c0f9827d32f456999cca5613a1c2f51f8c`, separate from the fixes.

- Verification observed AFTER all edits (Linux, local): focused suites
  `packages/kernel/test/{action_proposals,action_executions,
  action_scheduler_pickup}.test.ts` **31 passed / 0 failed**; full kernel
  battery **46 files / 474 passed / 0 failed**; `tsc --noEmit` for
  `packages/kernel` exit 0. The missing-target and definite-failure-recovery
  regressions run against REAL temp-dir SQLite databases, the REAL
  `ActionExecutionService` and REAL `createActionStrategy`/`RunEngine`
  pickup (no fixtures faking persistence). Whole-repo `biome check`
  retains its pre-existing errors at HEAD (confirmed by stashing and
  re-checking before the fixes).

## C24 action pause handoff (2026-10-13)

Work is PAUSED at a clean boundary at the user's explicit request to change
model configuration. No new feature/fix was implemented in this handoff and no
checks were run.

- HEAD at pause: `518636c563f6e157e5765d3494020e0efbd2135e`
  (`518636c docs(operations): record C24 action-core review fixes …`);
  `git status --short` was empty (clean tree) before this handoff commit.
- The latest completed worker fixed 4 core m5-action review bugs in commits
  `1d73677` (expired pending proposal / session cap), `da95122` (target
  resolved before the grant gate), `043c0a2` (recovery sweep without the
  inner join, fail-closed on a missing execution) and `9582355` (post-marker
  `definite_failure` terminal accepted). Verification is the prior worker's
  OBSERVED record only — 31 focused kernel cases and a 474-test kernel
  battery — NOT a new run for this handoff (see the section above for full
  hashes and regressions). Scaffold deletions out of C15 `347dce3` were
  detected as out-of-scope but agent-authored and intentional, landed as
  `c5b336c` beside the doc commit `518636c`.
- Remaining review UI bugs (NOT started): (a) the generic composer's Stop,
  after a reload, is still marked/routed as an in-flight Action; (b) the
  `cancelAction` handler ignores the response's actual terminal status and
  claims "stopped" on any 200 — it must claim cancelled ONLY when the
  response actually terminalises as cancelled (fail-closed on other
  outcomes).
- Whole-repo lint is NOT closed at HEAD. A blanket "pre-existing errors"
  claim is deliberately NOT made here: the prior worker's stash-based
  baseline check (documented above as "confirmed by stashing and
  re-checking") is unreliable because stashing is prohibited for
  preservation of unrelated changes, so remaining errors must be re-observed
  directly against HEAD by an allowed method.
- Publication blockers (last actual push; no PR was created): the HTTPS
  remote prompt had NO username supplied, the SSH public key was DENIED by
  the host, and `gh` is NOT logged in. Consequently there is no PR and no
  verified compare URL for this branch/pause state; publishing requires an
  authenticated remote or a working credential before any C22 label is
  applied.
- Next concrete steps (for the resuming worker): 1) fix the composer Stop
  post-reload marked-Action bug in the UI layer; 2) fix `cancelAction` to
  honour the actual terminal status (cancelled only on a cancelled terminal,
  never on a bare 200); 3) re-run whole-repo `biome check .` against HEAD
  without stashing and close outstanding errors; 4) only after UI review
  closes, re-run the full battery and record observed numbers. Do NOT call
  C22 done while the two UI review bugs above remain open.

## C24 action Stop-fix resume (2026-10-13, resume-stop-finish)

Resumes the paused handoff above WITHOUT rewriting it. The two remaining UI
review bugs are now FIXED, each committed separately (model kept as
configured `opencode-go/muse-spark-1.3-contributor`, no override):

- `c0327bc50714a745861cf44e351bd6affa041559` fix(ui): gate generic composer
  Stop on actual Action execution marker/cancellability (composer tracks the
  real execution view per run id; hides/disables Stop past the committed
  marker, on refused cancellability, or on terminal execution).
- `bf2b33eac12639c15c38ca064cd73ef158bc6518` fix(ui): claim action stop only
  on actual cancelled terminal, refresh otherwise (`cancelAction` parses the
  validated `run.status`; stopped notice ONLY on a cancelled terminal).

Regressions + type-only drift fixes (working tree at resume, committed by
this worker in coherent chunks — see hashes below):

- `apps/server/e2e/calendar/action.spec.ts`: 2 new actual-browser cases —
  reload-during-held-post-marker-write (no Stop anywhere, cancel API 409s,
  release verifies success) and late-cancel-on-terminal (200 keeps actual
  receipt, no stop claim).
- `apps/server/test/action_ui.test.ts`: unit gate for `parseCancelRunStatus`
  (cancelled only on cancelled; live/terminal-race statuses refresh;
  malformed bodies fail closed to null).
- Type-only (no runtime change): `authoritativeBinding.ts`
  `CalendarGetPortResult`/`CalendarSearchPortResult` → `CalendarGetResult`/
  `CalendarSearchResult`; `mcpFake.ts` spread cast to
  `Record<string, unknown>`.

Verification: per the declared prior-worker record, focused UI tests, types,
and the 2 new browser cases were ALL GREEN before this resume; this worker
ran NO passing checks again (no tests/build/browser rerun per scope). The
retained log `/tmp/resume-action-stop.log` (and `/tmp/resume-action-*`) was
NOT readable in this session (tool permission denial on `/tmp` outside
`/tmp/opencode`), so exact green counts are NOT re-quoted here — see the
prior evidence section above (31 focused kernel / 474 kernel battery) and
the Stop-fix commits for the code change.

Lint: no lint recheck was run here (explicit no-recheck scope); whole-repo
`biome check .` therefore remains NOT closed, and remaining ROOT errors on
touched files (if any) are still open — no lint/type fix beyond the retained
type-only drift fixes above was applied.

Publication: PR #20 is published for this branch, SUPERSEDING the pause
handoff's historical "no PR / publication blockers" block above (SSH denied,
HTTPS prompt, `gh` not logged in at pause time). History is not rewritten:
the pause block stands as the observed state at pause; this note records
that it is superseded.

## C24 Stop-fix lint close (2026-10-13, resume-close-lint)

Whole-repo lint was re-observed directly against the current tree (no stash,
no revert, model kept as configured, no override). Full `pnpm run lint`
(`biome check .`) was run ONCE pre-fix and ONCE post-fix; no
passing tests/types/browser reruns were done for this lint-only slice.

- PRE (HEAD `f64f169`, before fixes): `biome check .` exit 1 —
  **217 files checked, 40 errors, 1 info** (the `biome.json`
  `recommended`-deprecation info). Owned errors (ROOT, on files this
  branch touches per `git diff origin/feat/c12-calendar-snapshots...HEAD`):
  `action.spec.ts` format; `authoritativeBinding.ts` organizeImports +
  format; `mcpFake.ts` format; `src/ui/client.ts` organizeImports +
  format; `src/ui/reducer.ts` format; `test/action_ui.test.ts`
  organizeImports + format (10 diagnostics). Raw output retained at
  `.verification-log/resume-lint.log` (not committed).
- FIX (no semantics, no mass format): `biome check --write` applied ONLY
  to the 6 owned files above — import-name ordering plus formatter
  rewraps; diff-verified as reorder/whitespace only. No enum/source/table
  count test existed in the touched files, so nothing was deleted or
  repinned. The untracked owned Playwright scaffold
  `apps/server/test-results/.last-run.json` (empty `test-results/` dir,
  `{"status":"passed","failedTests":[]}`, from the Stop-fix browser runs)
  was deleted; no unknown files were touched.
- POST (after fixes, formatter step done): `pnpm run lint` exit 1 —
  **216 files checked, 30 errors, 1 info** (same pre-existing info).
  All 6 owned files are clean (zero diagnostics). The remaining 30 errors
  are all in files this branch does NOT touch (per the same base diff):
  `e2e/calendar/actionPort.ts`, `e2e/calendar/server.ts`,
  `e2e/calendar/tombstone.spec.ts`, `playwright.config.ts`,
  `src/app.ts`, `src/bootstrap.ts`, `test/action_composition.test.ts`,
  `test/proposals.test.ts`, `packages/contracts/*`,
  `packages/kernel/*` (format + organizeImports only; full list truncated
  by Biome's diagnostic cap — see `.verification-log/resume-lint-postfix.log`,
  not committed). They are reported as unrelated blockers, not fixed here
  per scope (no unrelated mass format). Whole-repo lint is therefore NOT
  closed; owned lint is closed.

## C13–C22 all-lint finish (2026-10-13, c13-c22-all-lint-finish)

SUPERSEDES the ownership claim in the section above: the "30 remaining
errors are all in files this branch does NOT touch (per ... origin/feat/
c12-calendar-snapshots)" line was an ownership mistake. That remote ref
already contains our C13–C22 implementation, so it is the wrong base. The
correct base is the known initial base `228c403`; per `git diff
228c403...HEAD` the files `e2e/calendar/actionPort.ts`,
`e2e/calendar/server.ts`, `e2e/calendar/tombstone.spec.ts`,
`playwright.config.ts`, `src/app.ts`, `src/bootstrap.ts`,
`test/action_composition.test.ts`, `test/proposals.test.ts`,
`packages/contracts/*`, `packages/kernel/*` are ALL owned by the current
user request (C13–C22), so all 30 postfix diagnostics were IN SCOPE.

- PRE: retained `.verification-log/resume-lint-postfix.log` (not rerun to
  confirm) — **216 files checked, 30 errors, 1 info** (same
  `biome.json` `recommended`-deprecation info), format + organizeImports
  only.
- FIX (no semantics, no mass unrelated format, no behavior-contract
  change): `biome check --write` applied ONLY to owned files —
  `actionPort.ts`, `server.ts`, `tombstone.spec.ts`,
  `playwright.config.ts`, `app.ts`, `bootstrap.ts`,
  `action_composition.test.ts`, `proposals.test.ts`,
  `contracts/src/action.ts`, `contracts/src/events.ts`,
  `contracts/src/http.ts`, `contracts/src/index.ts`,
  `kernel/src/action_proposals.ts`, `kernel/src/action_strategy.ts`,
  plus the diagnostic-cap-hidden owned files `kernel/src/broker.ts`,
  `kernel/src/index.ts`, `kernel/src/repository.ts`,
  `kernel/src/schema.ts`, `contracts/test/m1-references.test.ts`,
  `contracts/test/m2-contracts.test.ts`,
  `kernel/test/action_proposals.test.ts` (import/export ordering plus
  formatter rewraps; diff-verified reorder/whitespace only). Grep over
  `packages` + `apps/server/test` found no incidental latest-enum/source/
  table-count tests, so nothing was deleted or repinned.
- POST (ONE final `pnpm run lint` after fixes; no passing
  tests/types/browser reruns for this whitespace/import-format slice):
  `biome check .` exit 0 — **216 files checked, 0 errors, 1 info**
  (only the pre-existing recommended-deprecation info). Raw output was
  retained accessibly at `/tmp/opencode/resume-lint-final.log`; the
  working `.verification-log/` was removed before commit, so no logs are
  committed.

## C12–C22 final integration gate (2026-10-13, c12-c22-final-integration)

Final integration run ONCE after the core/Stop fixes and the all-lint
close (`52d61ba`). The earlier root 1242-pass predates the core/Stop
fixes, so this is NOT a mere confirm. Per scope, the already-green
browser / new Stop cases / full browser / lint were NOT rerun. Model
kept as configured (`opencode-go/muse-spark-1.3-contributor`), no
override. No new feature/live/OAuth/pins/secrets.

- `pnpm test` → exit 0, **103 test files passed, 1251 tests passed,
  0 failed / 0 skipped** (Linux, Node 24.12.0, ~11.7s). Raw stdout
  captured in local `.final-gate-tmp/test2.log` (removed after
  evidence; summary lines `Test Files 103 passed (103)` /
  `Tests 1251 passed (1251)`).
- `pnpm run typecheck` (root `tsconfig.json`) → exit 0, empty output
  (`.final-gate-tmp/typecheck.log`, removed after evidence).
- `pnpm run typecheck:e2e` (`apps/server/tsconfig.e2e.json`) → exit 0,
  empty output (`.final-gate-tmp/typecheck-e2e.log`, removed after
  evidence).
- Each command run ONCE (first `pnpm test` failed with 3 regressions, fixed below, then rerun ONCE green; the two typechecks
  ran once each and passed first try). No browser/lint rerun.

Gate fix (consumer root-cause only, no repin, no noop): the first
`pnpm test` failed 3/3 cases in `apps/server/test/proposals.test.ts`
(C18 proposal decisions) with `RepositoryValidationError: target
snapshot body is not a stored SnapshotBody` at
`packages/kernel/src/action_proposals.ts:252`. Root cause is a STALE
test fixture, not production: the test seeded `resource_snapshots`
via raw SQL with the raw calendar event object, while the stored
contract (written by the real ReferenceManager since C17) is the
`SnapshotBody` wrapper `{ version: 1, text }` with the normalized
event produced by `calendarEventBodyText` inside `text`. The fix
aligns the seed with the exact stored shape
(`SnapshotBodySchema.parse({ version: 1, text:
calendarEventBodyText({...}) })`, same pattern as the kernel
`action_proposals.test.ts` fixture); no production code changed, no
assertion wording/source/default counts repinned, no test deleted
(the 3 C18 decision cases are real behavior coverage: keyed
approve/replay, keyless reject, 409/404 conflicts). No semantics
change, so no separate runtime script was required — the changed path
(staging over the wrapper body) is exercised by the 3 fixed cases
themselves (`apps/server/test/proposals.test.ts` 3/3 green in the
final run).

Current C12–C22 milestone table (honest status; implemented vs fake
vs formal HOLD; no C24 scope inferred):

| item | status | boundary / evidence |
| --- | --- | --- |
| C12 internal Calendar pipeline | IMPLEMENTED (consumer) | Real-SDK `c12-smoke` (9) + kernel `calendar_tools` (11) green in final 1251; durable private targets via migration 0006. Adoption HOLD. |
| C13 broker exposure / frozen temporal | IMPLEMENTED (consumer) | `calendar.search` model-visible, frozen now/zone per Turn, budget/dedup/timeout via existing broker; cross-source stored-only open/related. |
| C14 startup composition / opt-in config | IMPLEMENTED | Strict `COMPANION_CALENDAR_JSON` opt-in (default disabled), trusted-definition preflight, lazy connect, bounded shutdown; no provider profile adopted. |
| C15 fake E2E harness | IMPLEMENTED (fake) | Real chromium scenarios incl. positive authoritative tombstone via the test-only `get-event-authoritative` gate; NOT a live/OAuth/production tombstone claim. |
| C16–C20 engine/M2/UI slices | IMPLEMENTED | Covered by the final 103-file / 1251-test battery, root + e2e typecheck clean, whole-repo lint closed at `52d61ba` (216 files, 0 errors, 1 pre-existing info; NOT rerun here). |
| C21 M5 Action composition | IMPLEMENTED (triple gate) | Config hints + dedicated write port + exact-instance match; disabled gate refuses staging / 409-before-repository; no production write binding selected. |
| C22 action lifecycle E2E | IMPLEMENTED (fake) | Fake harness seams only; real-UI conversation→search→rN→refresh coverage via fakes, not live. |
| C08 adoption / C10-08 production mapping / C11-01 positive tombstone | FORMAL HOLD / UNRESOLVED / BLOCKED | Unchanged: no adopted binding, pin, profile, OAuth, or live-Google wiring anywhere in this branch. |

Review/PR linkage: PR #20 is published for this branch (see the
resume-stop-finish section; it supersedes the pause-time publication
blockers). The two remaining Stop review bugs are CLOSED by
`c0327bc` (composer Stop gated on actual execution
marker/cancellability) and `bf2b33e` (`cancelAction` claims stopped
only on an actual cancelled terminal), with regressions in
`apps/server/e2e/calendar/action.spec.ts` (2 browser cases) and
`apps/server/test/action_ui.test.ts` (unit gate) — all green per the
prior record and NOT rerun here per scope.

Scaffolds: `.final-gate-tmp/` (local stdout capture) removed after
evidence; no new docs/logs committed besides this section; no
`test-results/`, `.verification-log/`, or `.review-proof/` residue in
the tree at gate time.

## PR20 T2 proposal approve idempotency lookup + draining replay (2026-10-13)

Fixes PR20 review `PRRC_kwDOUNdW7s79uYSd` (thread
`PRRT_kwDOUNdW7s6ryb6o`) on `feat/c12-calendar-snapshots` HEAD `814eac5`:
`IdempotencyScopeSchema` accepts `proposal:<uuid>:approve` but
`lookupIdempotencyForSession` recognised only session-message/turn-retry, so
the public lookup 404d a stored approval and `tryReplayStoredApprove`
returned 503 for a committed approval during drain. Ground truth per task
(not rerun to reproduce).

- `packages/kernel/src/repository.ts`: `lookupIdempotencyForSession` now
  parses the closed `proposal:<uuid-v4>:approve` scope, requires the actual
  proposal row owned by the same session (`requireOwnedProposal`; foreign or
  missing proposal 404s before any lookup, same pattern as turns), then
  delegates to the existing stored lookup. No unknown-scope fallthrough
  change; hash/scope validation stays the exact existing approve path, so a
  stored 202 replays during drain with same key/hash (no extra
  Turn/Run/Grant/events), same-key hash mismatch stays 409 with no writes,
  and fresh approvals during drain stay 503 without persisting.
- Regressions: `packages/kernel/test/proposal_idempotency_lookup.test.ts`
  (owned lookup found, foreign/missing 404, mismatch 409 with row counts
  unchanged) and
  `apps/server/test/proposal_approval_replay.test.ts` (real-SQLite Hono
  smoke: approve 202 -> GET lookup same 202 -> drain same-key replay same
  202 with 1 execution/grant -> fresh-key drain 503 with no persistence;
  plus same-key mismatch 409 with no extra rows). No mocked forwarding, no
  UI/browser needed for this path.
- Observed final-once verification (Linux, Node 24.12.0): focused
  `proposal_idempotency_lookup` 3/3, `proposal_approval_replay` +
  `proposals` 5/5, root `tsc --noEmit` exit 0. No push/comment/resolve;
  review thread IDs are for the parent to publish.

## PR20 T2 follow-up: draining stored-key mismatch replays 409 (2026-10-13)

Follow-up to the T2 section above (independent review
`ReviewReplayCompositionIdentity` on repair branch `99124aa`; ground truth
per task, not rerun pre-fix): `tryReplayStoredApprove`
(`apps/server/src/app.ts`) swallowed `IdempotencyConflictError` while
DRAINING, so a committed key retried with a different schema-valid
`proposalHash` returned 503 instead of the required 409
`idempotency_key_reused`.

- `apps/server/src/app.ts`: the draining approve replay now returns the
  existing `mapDomainError` for a stored-key permanent conflict
  (`IdempotencyConflictError` -> 409) and for session/proposal ownership
  drift (`RepositoryNotFoundError` -> 404). A fresh key (lookup miss, kernel
  never invoked, nothing persisted) and transient failures still fall
  through to the 503 drain rejection. No new approval scope.
- Regression: `apps/server/test/proposal_approval_replay.test.ts` gains a
  draining-mismatch case over real SQLite/Hono (approve 202 ->
  `markDraining` -> same-key different valid hash 409
  `idempotency_key_reused` with turns/runs/idempotency/executions/grants/
  events unchanged -> same-key same-hash replays the identical 202 with
  counts still unchanged).
- Actual-runtime proof: standalone Hono/SQLite smoke
  (`.review-plan-work/smoke-replay-shutdown.ts` via repo tsx, removed after
  this note; review JSON kept) 12/12 checks, incl. draining mismatch 409
  with row counts `turns=2 runs=2 api_idempotency=3 action_executions=1
  action_execution_grants=1 run_events=6` unchanged and the identical-202
  replay. Focused `proposal_approval_replay` 3/3 +
  `action_composition` 10/10 green, owned `biome check` on all touched
  files clean. No push/resolve; thread IDs are for the parent to publish.

## PR20 T5 calendar wrong-event get rejected, refresh closed (2026-10-13)

Fixes PR20 review `PRRC_kwDOUNdW7s79uYS6` (thread
`PRRT_kwDOUNdW7s6ryb6_`) on `feat/c12-calendar-snapshots`: a valid
`get-event` result from the selected calendar with an ID different from
`target.eventId` was accepted (normalization checked only the calendar
ID), so `reference.refresh` could materialize an unrelated event. Ground
truth per task (not rerun to reproduce the pre-fix acceptance).

- `packages/connector-calendar/src/adapter.ts`: `get` now compares the
  decoded opaque `canonicalKey` against the existing
  `normalize.canonicalKey(connectorInstanceId, target.calendarId,
  target.eventId)` helper (imported, no shim/new profile) and returns the
  fixed `calendar_response_invalid` on mismatch (no IDs/raw payload in the
  error). `normalizeGetResult` is unchanged, so strict
  structured-first/text-fallback decoding, malformed/upstream error codes,
  and matching-target behavior propagate exactly as before; no
  tombstone/user/account validation extras.
- Regression: `packages/connector-calendar/test/c12-smoke.test.ts` gains a
  genuine-SDK case (real `Server` + `InMemoryTransport` + `McpConnector` +
  broker over SQLite, deterministic zero-network fixture with a
  misdirect seam, no echo/mock forwarding): wrong-event `get` ->
  `calendar_response_invalid` with no provider ID in the error,
  structured-wrong vs text-matching still invalid, `reference.refresh` ->
  failed `calendar_response_invalid` with zero new
  resource/snapshot/rN/target/set/link rows, stored prior ref still opens
  with retained history, and a matching `get` still succeeds.
- Actual-runtime proof (throwaway script inside `.review-plan-work/`, run
  once via the repo tsx toolbin, removed after this note; 15/15 checks):
  wrong-event `get` fixed code, conflict still invalid, refresh failed
  closed with reference-table counts unchanged, prior open retained,
  matching `get`/`refresh` succeed; plus the still-pending T3/T4 standalone
  actual-`startServer` smoke (disabled injected owned port: `GET
  /health/ready` 200 then stop with 0 capability reads / 0 closes; enabled
  owned port: ready 200 then stop with exactly 1 close). Focused
  `c12-smoke` 10/10 + `normalize`/`deletion-boundary`/`calendar_tools`
  54/54, root `tsc --noEmit` exit 0, owned `biome check` clean. No
  push/resolve; thread IDs are for the parent to publish.

## PR20 T1 approval history owns its execution projection + reload dedup (2026-10-13)

Fixes PR20 review `PRRC_kwDOUNdW7s79uYSV` (thread
`PRRT_kwDOUNdW7s6ryb6i`) on `feat/c12-calendar-snapshots`: an approved
action ending failed/unknown/cancelled/abandoned created no
`turn_selections` row (completed-only by design), so history returned
`selectedRun: null` and the UI showed only the approval intent with no
receipt after reload.

- `packages/contracts/src/http.ts`: `ActionRunHistorySelectionSchema`
  now carries `runStatus` (required), `finishedAt` (nullable),
  `result` (nullable; present only for completed runs with persisted
  `result_json`), and `executionStatus` (nullable) alongside the existing
  `runId`/`attempt`/`receipt`. Non-completed terminals carry
  `result: null` with the actual receipt; active runs carry
  `receipt: null` with live statuses (frozen intent + progress, never a
  fake failure). `action_rejection` keeps `selectedRun: null` (kind is
  the discriminant).
- `packages/kernel/src/repository.ts`: `getHistory` projects approvals
  via `approvalRunProjection` keyed ONLY on owned execution identity
  (`action_executions.session_id` = history session AND
  `approval_turn_id` = this turn AND run `session_id`/`turn_id` match).
  Independent of `turn_selections` (which stays completed-only for the
  `user_text` path); a regular failed `user_text` turn stays
  `selectedRun: null`.
- `apps/server/src/ui/client.ts`: approval turns render the actual
  terminal receipt (incl. failed/unknown/cancelled/abandoned and
  recovered) or live `ACTION_PROGRESS_TEXT` for active approvals; every
  projected `runId` registers in `renderedAnswers` plus a
  `data-action-run` anchor so a captured-active reload never duplicates
  the terminal (`renderRunView`); result part TEXT is not re-rendered
  (only fresh rN citation buttons).
- Regression: `packages/kernel/test/action_history_receipt.test.ts`
  (real SQLite service lifecycle, no mocks/seeds/UI bypass): failed,
  unknown, pre-marker cancelled, recovered-abandoned pre/post-marker
  (receipt retained, non-null selection, `result: null`, zero
  `turn_selections` rows), blocked_stale/succeeded_unverified/verified
  (ID-free text, fresh rN, completed selection intact), regular failed
  `user_text` unselected.
- Actual-runtime proof: standalone Hono/SQLite history smoke
  (`.review-plan-work/smoke-history-t1t6.ts` via repo tsx, real TS APIs,
  HTTP approve + HTTP history) 53/53 checks incl. abandoned
  (`runStatus abandoned`, receipt `failed`, `result null`) and regular
  failed (`user_text`, `selectedRun null`); log
  `.review-plan-work/smoke-history-t1t6.log` (own log, removed after this
  note; review JSON kept). NEW browser cases only
  (`COMPANION_E2E_CALENDAR=1`, bounded): reload-after-unknown-terminal
  keeps the manual-check receipt with no extra write and no stop claim,
  2/2 passed; log `.review-plan-work/browser-t1t6.log` (own log, removed
  after this note). Focused `action_history_receipt` 9/9,
  `packages/kernel` `tsc --noEmit` exit 0, owned `biome check` on all
  touched files clean; broader types/units retained green per the prior
  session, not rerun. No push/resolve; thread IDs are for the parent to
  publish.

## PR20 T6 action rendered text carries no internal IDs (2026-10-13)

Fixes PR20 review `PRRC_kwDOUNdW7s79uYTF` (thread
`PRRT_kwDOUNdW7s6ryb7I`) on `feat/c12-calendar-snapshots`: completed
verified/unverified `RunResult` text embedded `calendar.reschedule` and
the raw proposal UUID, rendered verbatim in conversation history.

- `packages/kernel/src/action_executions.ts`: persisted completed
  results now render `${previewSummary} — ${safeOutcome}` (preview
  summary minus the `calendar.reschedule:` prefix, safe human outcome
  incl. manual-check guidance); stored `preview_json` contract
  unchanged; structured audit fields keep all IDs.
- `packages/kernel/src/action_strategy.ts`: the in-memory failed-run
  fallback renders the same ID-free preview + safe outcome (receipt
  outcome via the real view, never a fabricated success).
- `apps/server/src/ui/client.ts`: history receipt summaries strip the
  `calendar.reschedule:` prefix for display only (stored `summary_json`
  unchanged); visible history text never contains proposal/execution/run
  UUIDs or the tool name (IDs live only in structured fields/DOM
  metadata).
- Fixture wording pins deleted (behavior predicates only, e.g. outcome
  non-empty and stop-claim-free): `apps/server/test/action_ui.test.ts`,
  `packages/kernel/test/repository.test.ts`,
  `packages/kernel/test/structured_result.test.ts` (completed-selection
  type narrowing to the `user_text` variant).
- Actual-runtime proof: same 53/53 smoke (blocked/verified cases assert
  no tool name, no proposal/execution/run ID, V2 result with one fresh
  rN citation); NEW browser case only: completed verified history shows
  no internal IDs or tool name with the fresh citation surviving reload
  and write count unchanged, 2/2 passed with the T1 browser case above.
  Same focused/lint/type evidence as T1. No push/resolve; thread IDs are
  for the parent to publish.

## PR20 T1 follow-up: deduped active-approval terminal still hydrates (2026-10-13)

Fixes the T1 independent-review follow-up on `feat/c12-calendar-snapshots`:
T1 registers EVERY projected Action `runId` (incl. live
queued/preflight/executing progress) in `renderedAnswers`, so a reload
while the approval is active anchors the history — but the replayed
`run.completed` then hit the `renderRunView` answered-dedup early return
AFTER `finishActiveRun` and BEFORE the single-owner terminal hydration.
The approved proposal renders no card, so no execution watch drove the
update: visible progress stuck, terminal receipt/fresh rN missing.

- `apps/server/src/ui/client.ts`: the answered-dedup branch keeps the
  no-duplicate-answer guard but still claims `claimTerminalHydration`
  and runs `hydrateHistory` + `scheduleActionSync` (existing single-owner
  helper, no second watch/polling); already-hydrated terminals claim
  once, regular completed runs render unchanged. Failed/cancelled SSE
  branches additionally `scheduleActionSync` after hydration so live
  Action cards reach the same real terminal (retry append order kept).
- `apps/server/e2e/calendar/action.spec.ts`: the held post-marker
  reload case now asserts the REAL visible transition without a second
  reload — live progress after reload, verified receipt + fresh (non-r1)
  rN citation after release, exactly one history item/receipt/citation,
  no proposal/run UUID or tool name in visible text, composer released
  with no stop claim, exactly one write.
- Actual-runtime proof (`COMPANION_E2E_CALENDAR=1`, bounded): full
  `e2e/calendar/action.spec.ts` 13/13 passed (incl. the amended case);
  `apps/server` `tsc --noEmit` exit 0, e2e `tsc --noEmit` exit 0,
  `action_ui` 8/8, owned `biome check` clean. No push/resolve; thread
  IDs are for the parent to publish.

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

## PR20 integrated plan verification (2026-10-13, pr20-integrated-plan-verification)

FINAL integrated acceptance on HEAD `61b3573` (review6 threads fixed
plus the independent-review follow-ups `93f197f`/`72e5b37`/`61b3573`).
The C12–C22 gate (`814eac5`, 103 files / 1251 tests) predates the PR20
fixes, so the root full suite + both typechecks + lint below were run
ONCE against the new changes; the 13/13 browser action cases already
green at `61b3573` are confirmed by the T1 follow-up record above and
NOT rerun. Model kept as configured, no override. No new
features/tests/scaffolding, no live OAuth, no provider writes, no
adoption, no Remind work, no dependencies, no stack rewrite.

### Final checks (each run ONCE; Linux, Node 24.12.0, pnpm 11.25.0)

- `pnpm test` → exit 0, **106 test files passed, 1270 tests passed,
  0 failed / 0 skipped** (~12s).
- `pnpm typecheck` (root `tsconfig.json`) → exit 0, empty output.
- `pnpm typecheck:e2e` (`apps/server/tsconfig.e2e.json`) → exit 0,
  empty output.
- `pnpm lint` (`biome check .`) → exit 0 on the post-cleanup
  recheck (run ONCE after parsing and removing the own temporary
  `.review-plan-work/reviews-companion.json` /
  `.review-plan-work/reviews-fork.json` plus the now-empty
  `.review-plan-work/` directory): **219 files checked, 0 errors,
  1 pre-existing info** (deprecated `recommended` field in
  `biome.json`). Earlier exit-1 ground truth was exactly **2 format
  diagnostics on those two own-temp files only**; every
  product/source file was already clean. No ignore change, no
  reformat-suppress, no unrelated change.
- Browser: `apps/server/e2e/calendar/action.spec.ts` **13/13 passed at
  `61b3573`** per the T1 follow-up record above; confirmed only.

### §19 source-run acceptance (actual OPERATIONS CLI, own disposable tempstore)

First actual source-run of the documented §19.2/§19.5 path on this
branch (not a unit mock echo): real `pnpm start` cold starts, real
`GET /health/live` + `/health/ready`, real stopped-server
`pnpm --filter @companion/server backup`, real stopped-only manual
restore, real second cold start. Disposable store
`.review-plan-work/source-run-smoke/store/` only (removed after
evidence; review JSON kept). Environment was explicit and
credential-stripped: `COMPANION_DB_PATH` = own store path,
`COMPANION_HOST=127.0.0.1`, `COMPANION_PORT=44831` (probed free),
`COMPANION_TIME_ZONE=UTC`, `COMPANION_LOG_LEVEL=info`, plus inherited
`PATH`/`HOME` only; `COMPANION_MODEL_JSON` / `COMPANION_CALENDAR_JSON`
/ `COMPANION_MARKDOWN_ROOTS_JSON` / `COMPANION_ACTIONS_JSON` all unset
(verified absent beforehand), no Calendar/model config, no
Google/OAuth, no non-loopback network. No port/host value assumed from
outside: host/port came from the explicit env above against the
`config.ts` contract (loopback-only `127.0.0.1`, DB symlink guards).

- Cold start 1 (`pnpm start`): `server.starting port 44831`,
  `server.migrated status 7`, `server.recovered status 0`,
  `server.listening port 44831`. `GET /health/live` → 200
  `{"status":"live"}` (1/1). `GET /health/ready` → 200
  `{"status":"ready"}` (1/1). Marker session
  `POST /api/sessions` (fresh `Idempotency-Key`) → 201, id
  `d4685063-3e95-484f-ac57-b4c04c274161` (1/1).
- Stop 1: SIGTERM to the node server process → `server.draining
  status sigterm` → `server.stopped status sigterm`; port 44831
  closed, no server process left (2/2 stops clean in this smoke).
  Operational note: the signal must reach the node process — killing
  the `pnpm`/`sh` wrapper alone leaves the listener up (observed once,
  then corrected; no product change).
- Manual backup (stopped server, documented command
  `pnpm --filter @companion/server backup`): exit 0, stdout basename
  only `companion-manual-20261013T114053Z-87b91b9a-7d33-4342-b24e-0fd5363f0324.sqlite`
  (1/1, exact `companion-manual-<UTC>-<uuid>.sqlite` shape). Store and
  `backups/` dirs `0700`, backup file `0600` (3/3). `PRAGMA
  quick_check` of the backup copy → `ok` (1/1). Observation (product
  behavior unchanged): the run leaves
  `companion-manual-….sqlite.partial-shm` / `.partial-wal` residue in
  `backups/`; the CLI contract (basename-only stdout, fixed safe
  errors, stopped-only, no path flags) held.
- Stopped-only manual restore (documented exact sequence, with loss):
  (1) server stopped; (2) current db preserved aside (331776 B; the
  `-wal`/`-shm` sidecars were already checkpointed away by the clean
  drain); (3) live db removed to simulate loss; (4) verified backup
  copied to `restore.tmp.sqlite` next to the DB; (5) `PRAGMA
  quick_check` of the temp copy → `ok`; (6) atomic same-dir rename
  onto the DB path (mode `0600`); (7) no stale `-wal`/`-shm`
  while still stopped. (7/7 steps as documented.)
- Cold start 2 on the restored store: `server.migrated status 7`
  (no-op), `server.recovered status 0`, `server.listening port
  44831`; `GET /health/ready` → 200 `{"status":"ready"}` (2/2 across
  starts), `GET /health/live` → 200 (2/2). Marker session
  `GET /api/sessions/<id>/active-run` → 200 `{"run":null}` (data
  survived the loss+restore; not a fresh DB), unknown session id →
  404 (no false positive).
- Stop 2: draining → stopped, port closed. Own runtime files
  (smoke store, preserved copy, server logs, capture files) removed
  after this evidence; `.review-plan-work/reviews-*.json` parsed for
  publication data, then removed (publication step).

Smoke counters: cold starts 2/2 ready, health live 2/2, health ready
2/2, marker sessions created 1/1, backups 1/1 (basename + 0600 +
quick_check), restores 1/1 (7/7 documented steps), post-restore data
proofs 2/2, clean stops 2/2.

### Plan residual map (C01–C22 fake implementation/review proof vs formal release gates)

Nothing below closes a formal gate or authorizes an unapproved
decision. "IMPLEMENTED" means consumer/fake-harness implementation
with review proof; formal release gates stay explicit.

| item | status | boundary |
| --- | --- | --- |
| C01–C07 milestones / browser resilience / aggregate CI | HISTORICAL EVIDENCE (see README + C07) | 23/23 browser CI aggregate pinned to `56b7952a`; not re-asserted for this HEAD. |
| C08 upstream adoption | **HOLD / NOT ADOPTED** | No adopted binding, pin, profile, or registration anywhere in this branch. |
| C09 MCP library policy | IMPLEMENTED (library) / server enablement HOLD | Mandatory host definitions, read-only lattice, stdio/HTTP bounds proven by review smokes; production registration absent. |
| C10 consumer normalization | IMPLEMENTED / C10-08 production mapping **UNRESOLVED** | Whole-second-regex vs fractional-ISO gap persists as an adoption hold. |
| C11 deletion boundary | IMPLEMENTED (consumer negatives) / C11-01 **BLOCKED** | Cancelled / bare 404-410 / thrown RPC / search omission are never positive evidence; actual upstream HTTP status UNKNOWN. |
| C12–C16 pipeline / broker / config / fake E2E | IMPLEMENTED (consumer/fake) | Real-SDK + fake-harness proofs only; adoption HOLD. |
| C17–C20 engine / M2 / UI slices | IMPLEMENTED | Covered by the 106-file / 1270-test battery above. |
| C21 M5 Action composition | IMPLEMENTED (triple gate) | Config hints + dedicated write port + exact-instance match; disabled gate refuses staging / 409-before-repository. **No production write binding selected; dedicated write binding / adoption + triple-gate live use NOT authorized.** |
| C22 action lifecycle E2E | IMPLEMENTED (fake) | Fake seams + real chromium (13/13 at `61b3573`, confirmed not rerun); not live. |
| Windows 11 x64 manual smoke | **NOT EXECUTED** | Linux-only evidence here; §19.6 support gate stays open. |
| Fresh OAuth | **SEPARATE DECISION, untouched** | No flow, token, or status read here (`No authstatus/login/tokenread`). |
| Remind I01–I05 | **UNAPPROVED, untouched** | Other repo; no C23/C24 invented, nothing solved here. |
| Candidate PR21/22 | **STACKED REVIEW ONLY** | PR20 baseline pins have known gaps; the newest candidate is NOT claimed as the current binding. |

§20 write-binding source facts (parent-read, directly relevant to the
residual gate design only — SOURCE facts, not actual Google provider
proof; no write binding implemented/adopted, no extra docs/spike
tests created): fork `6939311` `UpdateEventHandler` is
dormant/unregistered; it performs `getCalendarTimezone` /
`detectEventType` plus broad-field and recurring-split paths; its
`events.patch` calls lack `If-Match`; no approved narrow reschedule
port exists. Google version-resources semantics: setting `If-Match`
against a concurrent revision rejects with `412`. Gate-design
consequence (still unapproved): any future narrow reschedule port
must carry the exact revision in `If-Match` and treat `412` as the
concurrency signal — recorded here only so the residual gate is
designed against the source truth.

Reachable-work check: every §19 agreed item reachable locally
(source-run, backup/restore/health exact paths, full suite +
typechecks) is observed above; all unapproved decisions (OAuth,
adoption, write binding, Remind, Windows manual, C23/C24) are
untouched. The authoritative `active_projects_plan.md` of the
external parent repo was not copied or created (not present in this
worktree); plan execution is recorded in the existing docs only
(operations here + README progress section).

Scaffolds: `.review-plan-work/source-run-smoke/` removed after
evidence; `.review-plan-work/reviews-*.json` parsed for publication
data, then removed with the now-empty `.review-plan-work/` directory
(publication cleanup; post-cleanup `pnpm lint` exit 0, 219 files,
0 errors, 1 pre-existing info — see above); no `test-results/`, `.verification-log/`, `.final-gate-tmp/`, or
`.review-proof/` residue; no test file touched by the lint ground
truth above.
## resume-calendar-default (2026-10-13)

Recovered checkpoint (observed, not asserted from docs): branch
`feat/calendar-readonly-production-profile`, HEAD `f23e245`
(`docs(operations, readme): fail-fast subshell fork-install guard …`),
`git status --short` empty (clean tree). This branch is the
google-readonly profile line stacked on the PR20 base: 7 commits since
`origin/feat/c12-calendar-snapshots` (`b2deab7` profile composition,
`094bc23` smoke evidence, `3a0d3de` CLI proof, `2b96350`/`202b476`
profile-freeze fixes, `932a811`/`f23e245` setup-accuracy docs). The
C24/C22 material above is history from the base line, not this
branch's scope.

Stale-claim supersession (no history rewrite): the C13 subsection's
"whole C13–C15 verification pass is deliberately deferred … ADDED, NOT
YET RUN" and the C14 subsection's matching "ADDED, NOT YET RUN" lines
are superseded. The deferred suites they name
(`packages/kernel/test/calendar_tools.test.ts` C13-01..07 exposure/
budget/dedup/Retry/cross-source cases;
`apps/server/test/config.test.ts` + `apps/server/test/bootstrap.test.ts`
C14 opt-in/preflight/lifecycle cases) were executed by the later
observed batteries on the base line: C12–C22 final integration
(`52d61ba`: 103 files / 1251 tests, both typechecks exit 0) and the
PR20 integrated verification (`61b3573`: 106 files / 1270 tests, both
typechecks exit 0, lint 219 files 0 errors / 1 pre-existing info).
Profile-branch additions (`calendarReadonlyProfile.test.ts`, 16 cases;
`calendarReadonlyProfile.ts` freeze-before-first-await) are covered by
this worker's final battery on this branch (observed once, Linux, Node
24.12.0, after the docs edit above — no code changed since): `pnpm
test` exit 0, **107 files / 1286 tests passed** (+1 file / +16 tests
vs the PR20 106/1270 baseline, exactly the profile suite); root
`pnpm run typecheck` exit 0; `pnpm run typecheck:e2e` exit 0; `pnpm
run lint` exit 0 (**223 files, 0 errors, 1 pre-existing
`biome.json` recommended-deprecation info**). No browser rerun for
this docs-only slice (both browser suites already green above).

Fresh credential-free harness evidence (this worker, Linux, Node
24.12.0, installed Playwright 1.63.0 CLI direct, no pnpm exec, no
OAuth, no live Google, no secrets — fake MCP over real SDK
InMemoryTransport + scripted fake model + real UI/API, temp SQLite
under owned `/tmp/opencode/calendar-resume-XFncqG`, traces on):

- Default browser suite: **23/23 passed** (conversation 4,
  citation_recovery 3, polling 4, sse_history 12 incl. 2 generated
  corrupt-cursor cases; ~1.3m). Confirms the base-line browser
  behavior unchanged on this branch.
- Calendar-mode suite (`COMPANION_E2E_CALENDAR=1`): **18/18 passed,
  0 unexpected / 0 flaky / 0 skipped** (JSON stats duration
  ~45.8s): `action.spec.ts` 13/13 (approve/reject/assent/stale/
  deleted/read-back/unknown/Stop-before/Stop-after/T1-reload/
  T6-IDs/held-reload/late-cancel), `calendar.spec.ts` 4/4
  (search→rN→open, reload, refresh V1→V2, tombstone-keeps-open),
  `tombstone.spec.ts` 1/1 (positive authoritative deleted rN, prior
  rN retained). JSON stats `expected:18`.
- Post-run `ss` on 4173/4174/4175: no listeners (both runs).
- Pinned-profile proof artifacts retained and accurate (runtime-side
  only, no source-SHA re-verification, no live claims):
  `docs/evidence/calendar-readonly-profile/smoke-profile.result.json`
  (22/22) and `cli-profile.result.json` (actual `pnpm start`
  missing-credential acceptance; CORRECTED 2026-10-14: reran full
  acceptance with valid local account `normal`, 12/12 — the prior
  `me@example.com` env is rejected by the profile account grammar
  `^[a-z0-9_-]{1,64}$`, so it could not have produced a cold start).

Branch-status note (CURRENT, supersedes the base-line residual table's
"no profile anywhere in this branch" row for THIS branch only): the
host-owned pinned `google-readonly` profile IS adopted here as normal-
startup composition (exact pin/commit/tree/lock/wire-hashes in the C14
profile subsection above). Authenticated live reads are OBSERVED (user
OAuth COMPLETED; see "Live readonly acceptance ledger"): only fresh
consent-screen scope display, live production/C11-01 (BLOCKED), and
manual Windows 11 smoke remain open external gates and are untouched
by this worker.

## PR23 final proof (2026-10-13, observed)

Focused verification only (no production change in this pass; no
browser or full-suite claim). Linux, Node 24.12.0, pnpm 11.25.0:

- `pnpm vitest run apps/server/test/calendarReadonlyProfile.test.ts
  apps/server/test/bootstrap.test.ts apps/server/test/config.test.ts`
  -> exit 0, **3 files / 78 tests passed** (profile 25, bootstrap 28,
  config 25), 0 failed.
- `pnpm run typecheck` -> exit 0; `pnpm run typecheck:e2e` -> exit 0.
- `pnpm run lint` -> exit 0, **224 files, 0 errors**, 1 pre-existing
  `biome.json` recommended-deprecation info.
- Independent throwaway credential-free smoke (tsx, removed after the
  run; no OAuth, no live Google, no secrets): invalid profile AND
  invalid account each create **no DB file and no parent dir**;
  generic `calendar-mcp` and profile `calendar-mcp-google-readonly`
  rows get **distinct instance IDs**; **restart reuses the profile ID**
  (still 2 rows); old generic target refresh through the new provider
  fails `reference_not_found` with **0 `get` calls**.
- Retained: `docs/evidence/calendar-readonly-profile/
  pr23-final-proof.result.json` (focused commands + concise smoke JSON
  + historical_reference; CORRECTED 2026-10-14: full `pnpm test` and both
  Playwright suites were never run in this focused pass, so they are
  recorded only as historical references to the resume-calendar-default
  battery above, not as PR23 results).
  Prior `smoke-profile.result.json` (22/22) unchanged;
   `cli-profile.result.json` corrected separately (valid account
  `normal` rerun, see resume note above).

## C22 approval-card target preview + bounded pending expiry (2026-10-13, observed)

Stacked on PR23 (`feat/calendar-readonly-production-profile`); no
OAuth/provider writes, no schema/policy expansion, no persisted-proposal
mutation, no mocked UI/seeded proposals in E2E.

- `packages/kernel/src/action_proposals.ts`: `loadTarget` now reads
  `sr.ordinal`; `freshSnapshotRevision` also returns the immutable
  normalized event title; the staged preview is a deterministic human
  summary `{title} (rN): start= end=` (title NFC/trimmed/whitespace-
  collapsed/128-code-point cap, blank falls back to `calendar event`).
  No tool-name prefix, no UUID/provider IDs, no upstream reads; the
  `{ summary }` seam, hash coverage, and DDL are unchanged. The legacy
  `calendar.reschedule:` display-prefix strips (execution/history
  rendering) stay as backward-compatible no-ops.
- `packages/kernel/test/action_proposals.test.ts`: the wording-pinning
  preview assertion is deleted; semantic cases assert target (title +
  current rN, incl. r2 after a retitling observation), deterministic
  hash, single-line plaintext, and privacy (no description/IDs).
- `apps/server/src/ui/client.ts`: each pending card owns at most one
  bounded one-shot expiry timer (identity-checked on fire, cleared on
  removal/decision); execution-owned/receipt/awaiting cards are never
  retired by an old timer. `syncActions` retires only still-local
  pending cards and never downgrades decision-in-flight; approve/reject
  recheck the local deadline, guard while the real POST is awaited, and
  the server stays authoritative. `visibilitychange` reconciles locally
  with no polling/provider calls.
- `apps/server/e2e/calendar/action.spec.ts` (+4, clock installed
  BEFORE goto): staged preview shows `E2E Standup` + r1 with no
  `calendar.reschedule`; `pauseAt(deadline-1)` keeps controls enabled
  and `fastForward(1)` retires the card with 0 writes; `setSystemTime`
  (no timer fire) + real `visibilitychange` retires with 0 writes;
  gated real approve-202 fulfilled across the old deadline keeps the
  live execution card, release lands the verified receipt (1 write).

Final battery (this worker, Linux, Node 24.12.0, after all edits):

- `pnpm test` -> exit 0, **107 files / 1296 tests passed**, 0 failed.
- `pnpm run typecheck`, `pnpm run typecheck:e2e`,
  `pnpm --filter @companion/server typecheck` -> exit 0.
- `pnpm run lint` -> exit 0 (**224 files, 0 errors**, 1 pre-existing
  `biome.json` recommended-deprecation info).
- Default browser suite (Chromium): **23/23 passed**.
- Calendar-mode suite (`COMPANION_E2E_CALENDAR=1`, Chromium):
  **22/22 passed** (`action.spec.ts` 17/17 incl. the 4 new cases,
  `calendar.spec.ts` 4/4, `tombstone.spec.ts` 1/1).

## C22 independent-review lifecycle fixes (2026-10-13, observed)

Followup on the same PR24 branch (`fix/c22-approval-card-target-expiry`);
review observations taken as ground truth, no failing-before rerun. No
mocked cards, DB seeding, new polling, or live provider/OAuth.

- `apps/server/src/ui/client.ts` `reject()`: the real reject POST is now
  `try/catch`. A transport abort before the server sees it releases
  `deciding`, shows the fixed retry notice
  (`却下できませんでした。もう一度お試しください`), and reconciles via
  the real proposals read: still-pending restores buttons/deadline, an
  accepted rejection retires on the real summary. Nothing is claimed
  rejected.
- `apps/server/src/ui/client.ts` `syncExecution()`: an authoritative
  non-pending summary takes card ownership BEFORE the execution GET
  (status transfer, `deciding=false`, pending timer cleared). Approved
  renders disabled decisions (known run preserved) and arms the EXISTING
  bounded execution watch for recovery when the GET resumes — no new
  polling. Rejected/expired retire on the real summary (pre-GET and
  post-GET paths) with history hydration; approved/terminal receipts keep
  their existing lifecycle.
- `apps/server/e2e/calendar/action.spec.ts` (+2, real UI/API only):
  abort-first-reject recovers pending controls then the real reject lands
  rejection history with 0 writes; real approve `route.fetch` + abort
  delivery with execution-GET failed keeps the server-accepted card
  (`approved`, controls disabled) across the original deadline, then
  resume + preflight release verifies the real receipt with exactly
  1 write.

Verification (this worker, Linux, Node 24.12.0, after all edits):

- `pnpm vitest run apps/server/test/action_ui.test.ts` -> exit 0,
  **8/8 passed**.
- `pnpm run typecheck`, `pnpm run typecheck:e2e` -> exit 0.
- `pnpm run lint` -> exit 0 (**224 files**, 1 pre-existing
  `biome.json` recommended-deprecation info).
- Calendar action suite (Chromium, `COMPANION_E2E_CALENDAR=1`):
  **19/19 passed** (`action.spec.ts` 17 existing + 2 new, ~48s).
  No default-browser or full-1296 rerun (unchanged paths).
- PR23/PR24 CI at push time: all checks SUCCESS (PR24 6/6 incl. e2e;
  PR23 6/6); no failed logs to repair.

## C22 clock-skew pending-expiry rearm (2026-10-13, observed)

Followup on the same PR24 branch (`fix/c22-approval-card-target-expiry`);
independent-reviewer defect taken as ground truth, no before-fix rerun. No
polling, provider/network, or authority change.

- `apps/server/src/ui/client.ts` `schedulePendingExpiry()`: the capped
  one-shot callback now calls `this.schedulePendingExpiry(current)` before
  the `Date.now() < deadline` early return. A client wall clock >15min
  behind the server (or rolled back after arming) no longer consumes the
  only timer forever: the single bounded timer re-arms for the remainder
  (still 1 timer, still 15min cap). Existing identity, accepted/decision,
  and execution/terminal guards are unchanged; the server stays
  authoritative.
- `apps/server/e2e/calendar/action.spec.ts` (+1, real proposal + client
  clock only): fake clock installed before goto, client set 20min behind
  before the real staged proposal, first capped 15min `fastForward` keeps
  the pending card with live controls, then advancing the actual remaining
  `expiresAt` retires the card with 0 writes and no
  visibility/network refresh. Real `expiresAt`, no DB mutation.

Verification (this worker, Linux, Node 24.12.0, after all edits):

- `pnpm run typecheck`, `pnpm run typecheck:e2e` -> exit 0.
- `pnpm exec biome check` on the owned files -> exit 0.
- Calendar action suite (Chromium, `COMPANION_E2E_CALENDAR=1`,
  `action.spec.ts` only): **20/20 passed** (~48s). No
  default-browser or full-suite rerun (unchanged paths).

## C22 preview-ambiguity + CI failure followup (2026-10-13, observed)

Followup on the same PR24 branch (`fix/c22-approval-card-target-expiry`);
the new GitHub review thread (title ambiguity) and the two CI e2e failures
on head `e4f6bf1` (PR run 38449588750: `action.spec.ts:841` lost-approve +
`calendar.spec.ts:80` date assertion; push run 38449579628 SUCCESS) taken
as ground truth, no failing-check rerun. No seeded proposals, fake HTTP
success, wording pins, timeout/skip/retry changes, or provider/normalizer
changes.

- Kernel preview (`packages/kernel/src/action_proposals.ts`
  `buildPreview`): new immutable previews now open with the unambiguous
  human marker `対象イベント: <whole title> (rN): start=… end=…`. An
  arbitrary normalized title beginning with `calendar.reschedule:` can no
  longer sit at position 0, so the legacy tool-prefix strips in
  `action_strategy.readRenderedPreviewForRun`,
  `action_executions.renderedPreviewSummary`, and the client history
  renderer never cut the real title. Reader logic is unchanged and still
  renders historical (`calendar.reschedule: …`) stored previews correctly;
  only their comments plus the stale client "staged preview carries the
  tool prefix" claim were corrected.
- `apps/server/src/ui/client.ts` `approve()`: a POST transport failure now
  awaits `reconcileLostApprove()` with `deciding` held (timer + stale lists
  cannot retire/downgrade the card mid-reconcile). A server-approved summary
  takes approved ownership immediately (timer cleared, decisions disabled,
  existing bounded watch started); still-pending re-renders controls with a
  re-armed bounded timer; unreadable falls back to sync. Root cause of the
  CI `action.spec.ts:841` failure: the fire-and-forget recovery sync could
  be deduped while an older sync held a stale pending view, leaving a
  server-approved card on its live expiry timer until `fastForward` retired
  it (card gone at line 877). The same stale approved run (read barrier
  never released) leaked into `calendar.spec.ts:80`: the next test's
  `/reset` released the barrier, the orphan run's write landed 11:00/12:00
  upstream mid-search, and the drawer showed the overwritten boundaries
  instead of the fixture 09:00. Both failures share this single root cause;
  no harness/test change was needed beyond the client fix.
- E2E seam (`mcpFake.ts` `titleOverride` + `POST /set-title`, cleared by
  `/reset`): `action.spec.ts` (+1, real
  search/select/stage/approve/reload flow, exactly 1 write) freezes the
  real title `calendar.reschedule: quarterly planning` and asserts it
  survives the initial card, the execution receipt, and the reloaded
  durable history in full.
- Kernel regressions (no wording pins): `action_proposals.test.ts` stages
  the adversarial title (marker prefix, full title, current rN, single
  line, ≤1024 chars, never at position 0); `action_executions.test.ts`
  drives a stored new-format preview through the real `blocked_stale`
  terminal and asserts the RunResult text keeps the whole title while the
  receipt `summary_json` is byte-preserved.

Verification (this worker, Linux, Node 24.12.0, after all edits):

- `pnpm test` -> exit 0, **107 files / 1298 tests passed** (+2 new), 0 failed.
- `pnpm run typecheck`, `pnpm run typecheck:e2e`,
  `pnpm --filter @companion/server typecheck`, root `tsc --noEmit` ->
  exit 0.
- `pnpm run lint` -> exit 0 (**224 files, 0 errors**, 1 pre-existing
  `biome.json` recommended-deprecation info).
- Default browser suite (Chromium): **23/23 passed**.
- Calendar-mode suite (`COMPANION_E2E_CALENDAR=1`, Chromium):
  **26/26 passed** (`action.spec.ts` 21/21 incl. the new title case,
  `calendar.spec.ts` 4/4, `tombstone.spec.ts` 1/1), plus a second
  consecutive 26/26 run.

## C22 delivery-vs-gate (2026-10-14, delivery/c22-approval-flow)

DELIVERED consumer code (this branch, fake transport only): target-aware
frozen preview (title + session rN), bounded one-shot pending expiry with
skew rearm + visibility reconcile, approve/reject error recovery with
authoritative lost-approve reconcile, kernel + E2E regressions above.
Production binding stays read-only (exact 3 tools); no write API invented.

EXTERNALLY GATED (not code, needs upstream decision/proof): write-capable
provider pin + tool-schema/API choice + OAuth scope selection, positive
deletion contract adoption, fresh OAuth/live/manual verification. No
guessed deletion positives or write capability claimed.

## M5 decision-turn retry denial (2026-10-14)

Fixes the §18 review finding on `origin/master` (`2474572`):
`repository.postRetry` accepted `action_approval` / `action_rejection`
Turns and queued a generic Run for them. A rejection Turn owns no Run
and an approval Turn owns its Action Run, so the generic generation
retry could duplicate or fabricate an external write; a terminal
(failed/unknown/abandoned/cancelled) Action must never be re-executed
through it. Pre-fix ground truth (throwaway repo/API smoke over real
SQLite, removed after this note): retry on a rejection Turn was
ACCEPTED (`202`, new queued generic Run), and retry on an approval Turn
failed only by accident of `UNIQUE(turn_id, attempt)` surfacing as a
misleading `409 session_busy`.

Fixed externally visible contract: the generic retry
(`POST /api/sessions/:sessionId/turns/:turnId/retries`) is
**user_text-only**. A decision Turn is rejected with the existing fixed
`400 validation_error` (`request validation failed`) with no new Run,
no events, no execution/grant change, no allocator bump, and no
idempotency persistence (a second key is denied identically; a stored
pre-fix success never replays). Ordinary failed/abandoned `user_text`
retry is unchanged (still `202`, same Turn, new queued Run).

- `packages/kernel/src/repository.ts`: `postRetry` parses the owned
  Turn's immutable `input_json` immediately after the session/turn
  ownership check and throws the existing `RepositoryValidationError`
  for any non-`user_text` kind — before the idempotency lookup, the
  busy admission, the `next_run_attempt` CAS, and every insert. Both
  `app.ts` call sites (live route + draining replay) inherit the denial
  through the existing `validation_error` mapping; no new error code,
  schema, or shim.
- `packages/contracts/src/http.ts`: `PostRetryRequest` doc states the
  exact user_text-only policy (schema unchanged).
- `apps/server/src/ui/reducer.ts` + `apps/server/src/ui/client.ts`:
  pure `isRetryableTurnKind` policy (unknown kinds fail closed) plus a
  client Turn-kind map hydrated from the ACTUAL history projection (and
  seeded `user_text` for fresh sends/retries). The failure-only retry
  control is appended only for `user_text` Turns and `retry()` refuses a
  known decision Turn locally with the same fixed notice; reloaded
  action results already render no control (`buildTurn` early return)
  and are unchanged.
- Regressions: `apps/server/test/proposals.test.ts` gains the
  decision-turn denial battery over real SQLite/Hono (approval retry
  400 while queued AND after terminal pre-marker cancel with
  turns/runs/events/executions/grants/idempotency unchanged + approval
  projection intact; rejection retry 400 twice with counts unchanged +
  single rejection Turn + null execution; `user_text` retry still 202
  with one new queued Run); `apps/server/test/action_ui.test.ts` pins
  `isRetryableTurnKind` (`user_text` only, both decision kinds and
  unknown inputs denied).
- Observed final-once verification (Linux, Node 24.12.0): focused
  `proposals` 6/6 + `action_ui` 9/9 green; root `tsc --noEmit` exit 0;
  real-chromium browser proof on the production UI bundle via the
  existing Calendar fake harness (throwaway spec, removed after this
  note) 2/2 — rejection retry 400 twice with 0 writes and no retry
  control before/after reload, unknown-approval retry 400 with exactly
  1 write and no retry control before/after reload; existing M3
  `failure surfaces a retry that succeeds` 1/1 (ordinary text retry
  preserved in the real browser). Throwaway smokes/specs and
   `test-results/` removed; no `pnpm` dependency change (offline
   store-link install only).

## Live readonly acceptance ledger (2026-10-14, current profile)

Current accepted activation: the host-owned pinned profile
`google-readonly` as the normal-startup composition (parent-verified
merged provenance: original-stack PR23
(`https://github.com/suiso11/companion_harness/pull/23`, head
`9e9bb94`) + PR24 merged, carried into main by merged DELIVERY
successors PR27 (`https://github.com/suiso11/companion_harness/pull/27`)
and PR28 (`https://github.com/suiso11/companion_harness/pull/28`);
PR27/28 preserved, not erased). C22 flow via PR28. Profile-adopted is the
acceptance baseline below; it does not close the residual gates listed at
the end. No code changed in this pass; prior uncommitted
`run-google-readonly.sh` launcher notes above are preserved as-is.

- Pin / schema mapping (verified this worker from actual candidate source
  and the current adapter; no secrets read, no live mutation):
  `suiso11/google-calendar-mcp` commit
  `6939311fd3eae9846648e0a175e304c9500f578e`, package
  `@cocal/google-calendar-mcp@3.0.0-readonly.2`, wire identity
  `{name:"google-calendar", version:"3.0.0-readonly.2"}`, scope
  `calendar.events.readonly` only, exactly the 3 live-wire hashes
  (`81222b89…`, `d48ba36e…`, `8c6736e2…`) matching
  `apps/server/src/calendarReadonlyProfile.ts`. `list-calendars` is
  absent by design (denied, never registered). Deletion-positive was not
  fabricated: 404/410/`cancelled`/omission remain errors/unknown and
  C11-01 stays BLOCKED.
- Proposal-era seven rows
  (`docs/google_calendar_readonly_binding_design.md` §4, current
  `readonly.2` deliberately removes the `list-calendars`/`calendarlist`
  scope — not restored to satisfy the old checklist):
  1) consent scope display — static pin ACCEPTED (events.readonly only,
  exact-grant validator); fresh consent-screen re-observation NOT claimed
  (live run reused the existing authorized grant, no new consent);
  2) `list-calendars` ok — INTENTIONALLY UNAVAILABLE (removed in
  readonly.2); 3) `list-events` one page + `nextPageToken` round-trip —
  ACCEPTED (one-page verbatim opaque cursor); 4) `search-events` q+window
  — ACCEPTED (live `calendar.search` succeeded/accepted);
  5) `get-event` 404 path — PARTIAL (miss maps to fixed
  `calendar_upstream_error`, never a tombstone; positive stays BLOCKED);
  6) write tool absent — ACCEPTED (events-only 3-tool surface, actions
  disabled); 7) stderr/log no tokens — ACCEPTED by construction (fixed
  codes + scalar ids only, no secrets persisted).
- Harness conversation / refresh: a live read-only conversation completed
  end to end (`run.completed`, one `calendar.search` succeeded/accepted,
  one `reference.presented` with snippet grant `[r1]` cited, turn
  selected; see the durable-run paragraph above). Live
  `reference.refresh` OBSERVED 2026-10-14 via a throwaway owned-temp
  SQLite proof against the real pinned google-readonly pipeline (fixed
  counting wrapper preserves the full call interface; no production
  gate/code change): list 10 hits (`list-events` x1, opaque cursor
  present), query mapping (`search-events` x1), stored-only open 0 new
  wire calls with non-empty body, explicit refresh via `get-event` x1
  only with a new snapshot (10->11) and new rN (refs +1, revision
  unchanged), prior rN re-openable with 0 new wire calls
  (`deduplicated`), fresh snapshot body keys `[text, version]` with 0
  excluded privacy keys, 3 distinct upstream tools / 3 total wire calls,
  second page `succeeded` (1 hit), `proof=live_refresh_observed`.
  Throwaway repository scaffolds (`.live-proof-tmp/`,
  `apps/server/.live-proof-tmp/`) removed; no owned repo scaffold DB
  remains. One private temp artifact `/tmp/live-refresh-proof-LMZ0zi`
  (owned 3 SQLite files) remains permission-blocked (tool
  external-directory deny), with no active process; oc13 had no stale
  proof process and live `:3000` was untouched.
- Live server health (this worker, non-disruptive readonly probes only):
  `GET /health/live` 200 + `GET /health/ready` 200 on loopback `:3000`;
  server left running. UI freshness re-verified 2026-10-14 ~17:41 UTC:
  the pre-restart served bundle predated current `client.ts` (no
  `reconcileLostReject`), so the server was safely restarted once via
  the existing `run-google-readonly.sh` (DB/model preserved, profile
  `google-readonly`, `COMPANION_ACTIONS_JSON` unset, no Google calls);
  `prestart` rebuilt `dist/assets/client.js` from current source and the
  served `/assets/client.js` (40434 bytes) now hash-matches dist and
  contains `reconcileLostReject`; `GET /` 200 references
  `/assets/client.js`; health re-probed 200/200 after restart.
  Report carries counts/codes/tool/reference transitions only — no events, tokens, or raw prompts.
- Reused automation counts (oc10 record, PRE-PR28-CODE-CHANGE baseline,
  labeled, NOT a current full-suite claim): lint 229 files 0 errors +
  1 pre-existing info; both typechecks exit 0; units 107 files / 1307
  tests; real default Chromium 24/24; fake Calendar 26/26 (action 21 /
  calendar 4 / tombstone 1). CURRENT final (oc21 observed after the 4
  PR28 race fixes; reviewer oc22 confirmed strengthened PR28-2/4
  non-vacuous): default 24/24 prior value unchanged (not rerun,
  test-only change in `calendar/action.spec.ts`); calendar 30/30
  (action 25 + calendar 4 + tombstone 1); final units 107 files / 1307
  tests pass; both typechecks exit 0; `biome check .` exit 0 (229 files,
  0 errors, 1 pre-existing info).
- Spike conclusion: the existing readonly surface cannot write; the
  dormant broad `UpdateEventHandler` lacks `If-Match` (verified absent at
  the pinned fork commit); a dedicated narrow reschedule needs an exact
  etag conditional patch with 412-stale handling, no auto resend, and a
  readback; recurring behavior, scope/tool choice, and write consent are
  unresolved source-only decisions; no live writes authorized.
- Remaining genuine blockers: Windows 11 x64 manual smoke; positive
  deletion evidence (C11-01 BLOCKED); M5 live/write gates (no production
  write binding, triple-gate never opened live); fresh OAuth
  consent-screen scope display as a separate untouched decision (OAuth
  itself COMPLETED, authenticated reads OBSERVED — never force
  reconsent). PR21/22 superseded-close is DONE (see next section; fork PR2
  left draft-open).

## PR21/PR22 superseded close (2026-10-14, observed remote actions)

Parent-verified baseline: PR23 + PR24 merged into the original stack;
PR27/PR28 are merged DELIVERY successors carrying the changes/evidence
into main (reconciled here, not erased). PR21/22 draft open at the
time; fork PR2 draft open. Ancestry/preservation investigated via `git`/`gh`/API
(read-only; no destructive commands, no source edits):

- PR21 (`feat/calendar-readonly-candidate-pin` @ `9630b25`, base
  `feat/c12-calendar-snapshots`, 3 files) is NOT an ancestor of
  `origin/master`. Its unique pin JSON was superseded by PR22's updated
  record (same path, now 6939311/readonly.2); its spike/operations text
  is superseded by merged PR23 + follow-ups.
- PR22 (`feat/calendar-readonly-compatibility` @ `6f219d8`, base
  PR21's branch, 8 files) is NOT an ancestor of `origin/master`. Its
  unique evidence files verified per-file against `origin/master`:
  `calendar-readonly-candidate-pin.json`,
  `candidate-3.0.0-readonly.2.result.json`,
  `consumer-smoke-3.0.0-readonly.2.result.json`,
  `probe-consumer-smoke.source.mts` all SAME; only
  `probe-tools-list.source.mts` DIFFERS by the later `083453f`
  fork-replay-checkout correction (clone + `git -C` detach). Design /
  spike / operations text superseded by merged PR23 + follow-ups.
- Performed (evidence-backed, non-destructive; no merges, no branch
  deletion, no rebase): closed PR21
  (`https://github.com/suiso11/companion_harness/pull/21`) and PR22
  (`https://github.com/suiso11/companion_harness/pull/22`) with precise
  superseded links + reasoning comments above, preservation verified
  per-file in merged successors on `origin/master` (see bullets above).
  Branches retained.
- Fork `suiso11/google-calendar-mcp#2` (`feat/companion-readonly-
  compatibility` → `feat/readonly-mode`, draft open, unmerged,
  head `6939311fd3ea`) contains real code changes not necessarily merged;
  left untouched — not ready-for-review evidence for Companion, no fork
  merge, no external modification. Post-close `gh pr list --state open`
   on companion_harness returns empty; fork PR2 (separate repo) stays open
   by design.

## PR28 UI race fixes + permanent browser regressions (2026-10-14, observed)

Four ground-truth defects in the C22 approval client
(`apps/server/src/ui/client.ts`), each fixed plus one permanent real-browser
regression over the existing Calendar fake harness (real UI + real fake
seams, no synthesized bodies, no source/incidental assertions):

- PR28-1 lost reject dropped while an action sync is in flight: the reject
  POST transport failure used to release decision ownership and rely on the
  deduped background sync, which is dropped while an older sync runs —
  leaving buttons disabled with the pending timer consumed. Fix: new
  `reconcileLostReject` holds `deciding` across ONE authoritative proposals
  re-read (rejected/expired retires, approved takes approved ownership,
  pending restores controls + fresh bounded timer, unreadable falls back to
  normal sync). Regression replays a held proposals list + aborted first
  reject, then proves live controls and a real second reject (200, history
  `action_rejection` x1, 0 writes).
- PR28-2 stale pending list downgrades runId-less approved ownership: a
  lost-approve card (approved, no runId yet, execution GET failed) was
  reverted to actionable pending by a stale pending replay. Fix: pending
  application and `ensureActionCard` now skip any card whose local status
  already left `pending`. Regression (strengthened 2026-10-14; the first
  version installed its stale route after approval with no ensuing list
  GET, so it never fired): the next proposals list — the real
  assent-terminal sync sent while the card is still pending — is fetched
  while genuinely pending but its delivery is held past the server commit
  and the lost-approve authoritative re-read; the held stale summary is
  released only after approved ownership with no runId, and the test
  proves the held delivery happened (exact route hits ≥3), the card stays
  approved/disabled across the original deadline, and the real receipt
  lands (1 write).
- PR28-3 historic rejections multiply full-history hydrations: every
  decided proposal's `syncExecution` hydrated history directly, so N
  historic rejections cost N full history GETs. Fix: `syncExecution` returns
  a history-need boolean and the caller hydrates exactly once per sync;
  historic rejections with no local card report no need. Regression stages
  two real reject cycles, reloads counting history GETs, and proves both
  `action_rejection` rows render with at most 2 history GETs (boot + one
  batch) and 0 writes.
- PR28-4 duplicate watch read starts before the current execution GET and a
  late live read overwrites the terminal receipt: the approved-ownership
  path started `watchAction` before the current execution GET (two
  concurrent reads), and a delayed live response could overwrite a rendered
  receipt and re-offer Stop. Fix: the watch starts only after a failed
  current execution GET, and any execution read arriving after
  `card.terminal` is ignored. Regression (strengthened 2026-10-14; the first
  version reloaded, which renders no approved card, so the terminal-wins
  guard was never reached): no reload — the live card stays alive, the next
  clock-driven watch poll is fetched while genuinely live (receipt-free)
  but its delivery is held, the run is released to its real terminal
  (Node-observed `succeeded`, 1 write), the terminal renders on the same
  card through a real assent-terminal client sync while the stale read
  stays held, and only then is the stale live read released: receipt,
  hidden Stop, and no stop claim stay stable (exact execution route hits
  ≥2).

Measured evidence (this worker, Linux, Node 24.12.0, real Chromium, owned
fake harness on loopback 4183–4186; user `:3000` service untouched):
`calendar/action.spec.ts` 25/25, `calendar/calendar.spec.ts` +
`calendar/tombstone.spec.ts` 5/5 — all exit 0, 0 retries (1.1m). Full unit
`vitest run` 107 files / 1307 tests pass. Static once after final edits:
e2e `tsc -p tsconfig.e2e.json` exit 0, root `tsc -p tsconfig.json` exit 0,
`biome check .` exit 0 (229 files, 0 errors, 1 pre-existing `biome.json`
info). The default suite (conversation/citation_recovery/sse_history/
polling) 24/24 is the prior observed value, NOT rerun here (this change is
test-only inside `calendar/action.spec.ts`, no production code touched).
Prior oc17 static runs are NOT re-claimed here (no retained oc17 logs
found; only its PR28-4 failure error-context survived and the capture was
reworked above). Owned `apps/server/test-results/` removed; no owned
servers/processes
   left. One private temp artifact `/tmp/live-refresh-proof-LMZ0zi`
   (owned 3 SQLite files) remains permission-blocked, no active process
   (see ledger cleanup note above).

## PR29 Windows stall fix (2026-10-14, CI ground truth, no timeout masking)

PR-event run `38608822921` (head `b04970b`) failed ONLY
`check (windows-latest)`: 4 `Test timed out in 5000ms` with zero assertion
failures — `apps/server/test/action_composition.test.ts:131`,
`packages/kernel/test/action_history_receipt.test.ts:258`,
`packages/kernel/test/action_scheduler_pickup.test.ts:239` and `:371`.
Ubuntu `check` and `e2e` on the same run passed, and the same-head push run
`38608803181` passed Windows: a load flake, not a logic regression. No
check was rerun for confirmation and no timeout was raised or suppressed.
Evidence for a concurrency/resource cause (not product behavior): the
failing files' own passing siblings took 3.6–4.7s each (e.g. the no-op
unapproved-bound pickup took 4669ms), total collect was 89.15s, and every
timeout fired while the test body was still running — no error log, no
receipt mismatch. Two avoidable contributors fixed minimally, behavioral
assertions/contracts untouched:
- `action_scheduler_pickup.test.ts`: the engine-idle poll slept
  `setTimeout(..., 2)` up to 500 times, so a starved Windows event loop
  stretched the wait itself past the 5s budget. It now yields via
  `setImmediate` (no wall-clock sleep): the launched strategy only awaits
  immediately-resolved ports, so it settles within a handful of yields,
  and a genuinely stuck run fails fast on the existing `inflightCount`
  assertion instead of timing out.
- `vitest.config.ts`: `maxWorkers: 2` on CI only (`CI`/`GITHUB_ACTIONS`
  env; local parallelism unchanged), so full parallel forks no longer
  thrash synchronous better-sqlite3 plus real loopback servers on
  Windows runners.
Local proof after edits (Linux, Node 24.12.0, single pass, no midflight
runs): focused `action_scheduler_pickup.test.ts` 3/3, full `vitest run`
107 files / 1307 tests, root typecheck exit 0, `biome check .` exit 0
(229 files, 0 errors, 1 pre-existing info). New-head CI observed after push,
head `7cf085b`: PR-required run `38610182826` success — `check
(ubuntu-latest)` success, `check (windows-latest)` success, `e2e` success;
same-head push run `38610174325` success (ubuntu success, windows success,
e2e success). PR29 required context is the PR-event run.

## M5 dedicated write binding — continued §20 #1 spike decision (2026-10-15, source-only, no implementation)

Continuation after the live readonly acceptance ledger. No code changed, no
live writes, no OAuth/scope/key changes, no userDB/service interruption. The
readonly fork was not modified (not even re-read from its external checkout:
this worker's tool boundary denies external directories, so the fork source
facts below reuse the recorded pin-commit evidence at `m4_dependency_spike.md`
L623-629 + operations L2192-2204, and this worker re-verified everything
reachable in-repo). The running readonly user service was untouched.

- In-repo verification (this worker, reached paths only):
  `packages/connector-calendar/src` contains no update/patch/`If-Match`/write
  path (only the read-side etag revision basis in `normalize.ts`); the C21
  triple gate + `CalendarActionWritePort` contract in
  `packages/kernel/src/action_strategy.ts` + `apps/server/src/bootstrap.ts`
  are unchanged (exact `["start","end"]` capability, one-shot `update`, exact
  three-value outcome, no retry); no production write binding is selected
  anywhere. Kernel side is ready; the independent provider side is missing.
- Exact missing independent write-provider contract (decision-ready):
  1) Narrow tool: fork `6939311` `UpdateEventHandler`
  (`src/handlers/core/UpdateEventHandler.ts`) is dormant/unregistered and
  broad-field (`getCalendarTimezone`/`detectEventType` + broad-field +
  recurring-split paths); its `events.patch` calls lack `If-Match`, so
  `expectedRevision` cannot be carried. No approved narrow start/end-only
  reschedule port exists.
  2) Conditional mutation: exact-etag `If-Match` + `412`-as-stale is recorded
  design-only (Google version-resources semantics), never provider-proven for
  this fork path; a preflight-to-write race `412` has no agreed port mapping
  beyond the closed three-value return.
  3) Idempotency capability (§20 #1 open item): kernel gives at-most-once per
  committed grant with no auto resend, but whether upstream offers update
  tokens/etag idempotency signals against duplicate delivery is unconfirmed.
  4) Scope/consent: any write needs scope beyond `calendar.events.readonly`
  plus an explicit user write-consent decision; current authorization covers
  implementation, NOT live writes or OAuth broadening.
- Smallest safe choice (user decision, no guessing): keep the triple gate
  closed; next step is a fork-side narrow-tool proposal (start/end-only,
  exact-etag `If-Match`, `412` propagation, no recurring split) + a
  write-capable pin decision + a scope/consent decision, BEFORE any binding
  code. Adopting the dormant broad handler as-is is REJECTED (violates §18.1
  start/end-only + §18.5 exact-revision preflight; it would invent an
  incompatible API). The fake-harness browser approval→receipt path (exactly
  1 fake write) already proves the kernel side; rerunning it proves nothing
  new and was not rerun.
- Genuine remaining gates (unchanged): Windows 11 x64 manual smoke; C11-01
  BLOCKED; M5 live/write gates (no production binding, triple gate never
  opened live); fresh OAuth consent-screen scope display as a separate
  untouched decision; §20 #1 UI phrasing still open.

## M5 isolated reschedule binding — real runtime (2026-10-15, no live writes)

SUPERSEDES the "fixture-only" note above: the fork-side SEPARATE
ENTRYPOINT is now a REAL production runtime (defaults disabled, no live
Google mutation, no OAuth consent/scope activation, readonly checkout
untouched — external reads were boundary-denied, so no readonly code was
copied; the entrypoint is a standalone narrow surface with its own pin).

- Real Google adapter (fork `src/google.ts`): exact events.get/patch
  shape normalization, recurring/instance/cancelled/deleted/all-day
  rejects, GET 404/410 no-write definite (never deletion proof), PATCH
  start/end ONLY with `If-Match` exact etag, 412 definite `etag_mismatch`,
  5xx/timeout/abort/disconnect/malformed-2xx after dispatch `unknown`
  (never resend); single fetch each, bounded timeout/abort/response-size,
  `redirect: manual` (never follows; no credential leak).
- Real auth (fork `src/auth.ts`, separate `M5_RESCHEDULE_*` namespace):
  exact-whitespace scope tokens (prior substring match removed, so
  `calendar.events.foo` cannot pass), exact account selection, no
  readonly token reuse, refresh-BEFORE-dispatch only (single RFC6749
  grant, no interactive flow, no scope broadening), separate 0600 token
  persistence. No live OAuth/Google invocation (fake token endpoint in
  tests only).
- Executable CLI (fork `src/cli.ts`, bin `calendar-reschedule-mcp`,
  `start` runs `dist/cli.js`; build/start are distinct commands);
  production Google URL FIXED (test endpoint only via the explicit
  `M5_RESCHEDULE_TEST_ALLOW_ENDPOINT_OVERRIDE=1` seam, never set in
  production); strict tool schema (`additionalProperties: false`, exact
  ISO `start < end`, opaque etag); SDK signal cancellation; real bounded
  stdio shutdown race (not a comment).
- Production fixture provider REMOVED from production (fixtures live in
  tests only). Harness `rescheduleWrite.test.ts` is self-contained (no
  relative import from the ignored nested repo); new
  `rescheduleProcess.test.ts` drives the ACTUAL built executable over
  real stdio MCP into a local Google-shaped fixture (success exact
  fields/If-Match, stale-etag definite, zero PATCH on rejects). Fork is a
  workspace member with the same durable pins (SDK 1.30.0, zod 4.5.4).
- Harness side unchanged in trust: `createRescheduleWritePort` (exact
  `reschedule-event`/instance binding, committed-grant etag only, one
  call, loss -> unknown) + `createDedicatedWriteBinding` into the
  existing triple-gate seam (all defaults disabled; readonly
  entrypoint/tools/scopes/pin untouched).
- Verification (Linux, Node 24.12.0 — each run ONCE, 2026-10-15):
  fork `tsc` build clean (`dist/cli.js` present); port suite 8/8 +
  real-process stdio suite 1/1 green; root typecheck + full suite +
  biome re-run recorded below. No live writes/scopes.
- Normal-startup write-profile proof (2026-10-15, default OFF unchanged):
  `apps/server/test/rescheduleWriteStartup.test.ts` 21/21 — the prior
  14/15 success case (`unknown` instead of `succeeded`) was a fixture-hint
  cause only (E2E stdio hints omitted the mandatory SDK inherited
  allowlist, so the fail-closed stdio guard denied before spawn); fixed by
  adding the exact live `STDIO_IMPLICIT_ENV_VARS` to the three real-stdio
  E2E hints. PR31 review findings (2026-10-15, same file +6): P1 —
  production-factory hints now validate the platform implicit allowlist in
  preflight (fixed `env allowlist is invalid`, no DB/child/patch; inert
  `writeMcpTransportFactory` seams skip it); P2 — explicit
  `actionWriteBinding: null` normalizes to absent (only non-null conflicts);
  P2 — write commands accept absolute paths incl. Windows
  `C:\Program Files\...\node.exe` and spaced POSIX paths (shell lines /
  interpolation / NUL / controls still rejected; real spaced-binary
  production spawn smoked). Production parsing still rejects `M5_RESCHEDULE_TEST_*`
  (fixture endpoint travels in the options-injected CHILD env only, never
  the hint). Success path verified end to end: staged HTTP approve ->
  exactly ONE conditional PATCH (`If-Match` = committed etag, start/end
  only) -> strategy readback -> `succeeded` receipt; stale grant ->
  `blocked_stale` with 0 patches; drifted identity -> `unknown` with 0
  patches; committed-grant resolver reads the exact stored hash+revision.
  Final: root suite 114 files / 1350 tests green, `tsc --noEmit` exit 0,
  `biome check .` clean, throwaway normal-startup `tsx` smoke
  (`/health/live` -> `{"status":"live"}`, default profile unselected) OK.
  No live Google/OAuth/user-DB writes; no production guard weakened.
- Remaining: nested-fork push to suiso11/google-calendar-mcp SUCCEEDED
  (branch `feat/m5-reschedule-entrypoint`, commit `164cb83`, no merge);
  draft PR BLOCKED with the exact reason `branch has no history in common
  with main` (the nested repo was built standalone because the external
  readonly clone was boundary-denied, so no shared history exists);
  actual fork-readonly-code checkout BLOCKED by external-directory read
  denial (no code copied, original untouched by construction); Windows 11 x64
  manual smoke; C11-01 BLOCKED; M5 live/write gates (triple gate never
  opened live).

## Prior M5 fixture-only record (2026-10-15, superseded — kept for history)

SUPERSEDES the "no implementation" note above: the fork-side SEPARATE
ENTRYPOINT is now implemented end-to-end against a local real-HTTP fixture
(no live Google mutation, no OAuth consent/scope activation, readonly
`6939311` checkout untouched — external reads were boundary-denied, so the
fork was built in-repo from the recorded contract and never re-read).

- Separate entrypoint (nested fork `.m5-write-fork`, own branch
  `feat/m5-reschedule-entrypoint`, parent tracks sources but ignores nested
  `.git` via `.gitignore`): identity `google-calendar-reschedule` /
  `1.0.0-reschedule.1` (distinct from readonly `google-calendar` /
  `3.0.0-readonly.2`); tool `reschedule-event` ONLY (strict start/end +
  opaque calendar/event/account + committed-grant `expectedEtag`; unknown
  keys rejected); injectable provider boundary (fixture HTTP provider +
  documented Google `events.patch` mapping); read-before-patch rejects
  recurrence/instances, cancelled/deleted, all-day, missing etag with NO
  patch; exactly ONE conditional PATCH with `If-Match` (retry:false, no
  redirect follow, no recurring split); HTTP 412 -> `definite_failure`
  (`etag_mismatch`, provider proves NO patch); transport loss after possible
  dispatch -> `unknown` (never resend, never cancel); classified outcomes as
  non-error payloads, `isError` only for lost responses (never definite on
  loss); separate `M5_RESCHEDULE_*` credential namespace + write-scope
  validation, no OAuth flow, no scope broadening.
- Harness side: `packages/connector-calendar/src/rescheduleWrite.ts`
  (`createRescheduleWritePort`, structural `CalendarActionWritePort`;
  committed-grant etag ONLY via `resolveExpectedEtag`, hash/updated-only
  revisions safely rejected with NO dispatch, exact 412 -> definite_failure,
  loss -> unknown, one call per update) +
  `apps/server/src/rescheduleWriteBinding.ts`
  (`createDedicatedWriteBinding` -> existing `derivePort` triple-gate seam;
  all defaults disabled). Readonly entrypoint/tools/scopes/pin unchanged
  (no write tool registered there; `calendarReadonlyProfile.ts` untouched).
- Verification (Linux, Node 24.12.0, pnpm 11.25.0 — each run ONCE, 2026-10-15):
  typecheck clean (`connector-calendar`, `server`); `biome check .` clean;
  new `rescheduleWrite.test.ts` 8/8 over a real loopback HTTP fixture
  exercising the real wire adapter + port (success exact fields/If-Match,
  412 definite with no patch, recurring/cancelled/deleted/all-day with zero
  dispatch, hash-only revision rejected undispatched, abort -> unknown with
  exactly 1 attempt, lost/unparseable -> unknown never definite, wrong
  tool/instance refused); throwaway full-pipeline smoke PASSED then deleted
  (dedicated MCP identity `google-calendar-reschedule`/`1.0.0-reschedule.1`
  + sole `reschedule-event` tool over the real SDK wire, direct success +
  stale-etag definite_failure, then approval -> committed grant -> MCP ->
  fixture PATCH -> readback -> `succeeded` receipt via the real scheduler);
  focused regression 134/134 across connector-calendar + kernel action +
  server action/bootstrap suites; readonly-unchanged proof: modified tracked
  files are only `.gitignore` (nested `.git` ignore), `docs/operations.md`,
  `connector-calendar/src/index.ts` (additive exports); readonly profile,
  bootstrap gates, kernel, connector-mcp untouched.
- Remaining: nested-fork push/draft-PR blocked (no remote configured; worker
  does not invent push targets); Windows 11 x64 manual smoke; C11-01
  BLOCKED; M5 live/write gates (triple gate never opened live); §20 #1 UI
  phrasing.

## M5 fork-history recovery — proper derived PR (2026-10-15, no live writes)

SUPERSEDES the two blocked-PR notes above (standalone history problem is
RESOLVED; history sections kept). No live Google mutation, no OAuth
activation, no user service/DB/model changes, no user-branch deletion.

- Derived checkout: `.m5-write-fork-derived` cloned from the KNOWN
  accessible GitHub remote (`https://github.com/suiso11/google-calendar-mcp.git`,
  branch `feat/companion-readonly-compatibility`, HEAD exactly
  `6939311fd3eae9846648e0a175e304c9500f578e` — no external-filesystem
  reads needed). New branch `feat/m5-reschedule-entrypoint-v2` (no
  force-push; orphan `feat/m5-reschedule-entrypoint` / `164cb83` retained
  on the remote for reference, superseded, never deleted).
- Separate entrypoint with TRUE ancestry (commit `f1dcde8` on top of
  `6939311`): `src/reschedule/*` ported byte-identical from `164cb83`
  (sha256-verified per file) + entry `src/reschedule-cli.ts` ->
  `build/reschedule-cli.js` (bin `calendar-reschedule-mcp`, identity
  `google-calendar-reschedule` / `1.0.0-reschedule.1`, tool
  `reschedule-event` ONLY). Readonly byte/behavior unchanged: only
  `package.json` (bin + additive `build:reschedule`/`start:reschedule`
  scripts) and `scripts/build.js` (additive bundle) modified; `src/index.ts`,
  `src/server.ts`, auth, handlers, tools, name/version
  `3.0.0-readonly.2` untouched (diff proof: 2 files, +39/-2; all else new
  files). `RESCHEDULE.md` records provenance + pin.
- Fork verification (Linux, Node 24.12.0): `npm run lint` exit 0,
  `check:imports` clean, full `npm run build` green, unit suite 821/821
  pass, real stdio smoke of `build/reschedule-cli.js` vs loopback fixture
  PASS (identity exact, one tool, success exact If-Match start/end-only,
  stale etag definite `etag_mismatch` with zero extra PATCH, no-credential
  exit 2). No live writes/scopes.
- Draft fork PR (NOT merged): suiso11/google-calendar-mcp#3
  (`feat/m5-reschedule-entrypoint-v2` -> `feat/companion-readonly-compatibility`,
  true ancestry, diff confined to the additive reschedule surface).
- Harness clean-clone durability (this worktree): `.m5-write-fork`
  standalone scaffold DELETED (directory + `pnpm-workspace.yaml` member +
  lock importer pruned via `pnpm install`); no test imports any ignored
  repo. `rescheduleProcess.test.ts` now spawns a REAL child-process MCP
  server over REAL stdio: TRACKED fixture
  (`test/helpers/rescheduleFixtureServer.mjs`, own
  `*-test-fixture` identity) by DEFAULT — always runs, never skips — and
  the REAL fork bundle only under explicit `M5_RESCHEDULE_FORK_CLI`
  (set-but-missing is a hard error). `rescheduleWrite.test.ts` header
  updated; `.gitignore` now ignores only
  `.m5-write-fork-derived/.git`. Single production implementation (fork
  branch); Harness keeps only the binding port + fixture provider in tests.
- Harness verification after final edits (Linux, Node 24.12.0, pnpm
  11.25.0 — each run ONCE, 2026-10-15): port suite 8/8 + real-process
  suite 1/1 green on the DEFAULT fixture path; explicit-fork path 1/1
  green against `build/reschedule-cli.js` (`f1dcde8`); explicit-missing
  path hard-fails (no silent skip); root typecheck + full `vitest run` +
  `biome check .` re-run recorded below. Readonly entrypoint/tools/scopes/
  pin untouched (`calendarReadonlyProfile.ts`, bootstrap gates, kernel,
  connector-mcp unchanged).
- Remaining: fork PR #3 review/merge decision (not this worker); Windows 11
  x64 manual smoke; C11-01 BLOCKED; M5 live/write gates (triple gate never
  opened live); §20 #1 UI phrasing.

## M5 reschedule hardening + wire-hash pin (2026-10-15, oc38 record, no live writes)

SUPERSEDES nothing: implements the remaining hardening on top of the
derived-PR record above. No live Google mutation, no OAuth consent/scope
activation, no user service/DB changes. Readonly surface/scopes/pin
untouched (zero write tools on the readonly entrypoint; this module never
enters the read allowlist).

- Fork (`feat/m5-reschedule-entrypoint-v2`, committed `0e61265`
  `0e612655e7054130fe37601cbe80378f73f418ea`, normal ff push, NOT
  merged): provider default-behavior hardening (`src/reschedule/google.ts`,
  `auth.ts`, `cli.ts`, `provider.ts`) — ONE deadline spans headers AND
  body (hang-safe abort), exact-account pre-check BEFORE any token or
  provider I/O, refresh-BEFORE-every GET and PATCH, `read_transport_lost`
  definite pre-dispatch, `unknown` only after possible dispatch (single
  attempt, never resend); server advertises and validates with THE SAME
  strict `RescheduleEventInputSchema` object (hand-written
  `rescheduleInputJsonSchema` removed, cannot drift). Wire identity
  unchanged (`google-calendar-reschedule` / `1.0.0-reschedule.1`, tool
  `reschedule-event` ONLY). New permanent tests
  `src/tests/unit/reschedule/googleReschedule.test.ts` (6 cases, injected
  `fetch` only: body-deadline/abort, exact account, per-request refresh,
  single-GET observation, after-dispatch unknown, pre-dispatch definite).
- Host (this branch): owned-write bounded shutdown in
  `apps/server/src/bootstrap.ts` (adopted owned-hook close paths bounded;
  a hanging hook never stalls shutdown past the bound — new hang test in
  `action_composition.test.ts`); committed-grant revision proof in
  `rescheduleWrite.ts` + `rescheduleWriteBinding.ts` (resolver keyed by
  the exact committed grant; content-hash/updated-timestamp fallbacks and
  resolver substitution rejected with NO dispatch — 4 new cases in
  `rescheduleWrite.test.ts`); `category: "write"` gate in
  `connector-mcp/src/client.ts` (default readonly connector refuses
  trusted `write` definitions with `mcp_binding_not_allowed` before any
  dial; dedicated `["write"]` connector enables ONLY write — 4 cases in
  `write-category-gate.test.ts`); host-owned wire-hash pin in new
  `apps/server/src/rescheduleWriteProfile.ts` (+ 4 pin tests) and live-wire
  stdio proof in `rescheduleWireHash.test.ts` (2 cases, tracked fixture —
  clean-clone safe). Base pin `6939311` in the profile is the branch base
  (unchanged and still exact); wire hash unchanged (no reprobe needed).
- Wire-hash pin (probed oc37, recorded in `rescheduleWriteProfile.ts`):
  live-wire canonical input-schema SHA-256
  `9f59e35bf76bfec75a99546fc3c22348cd20e33e9414154ea321d414186d09b7`,
  probed over REAL stdio against BOTH the freshly built fork bundle
  (`build/reschedule-cli.js`) and the tracked contract-mirror fixture —
  byte-identical STRICT schemas (`additionalProperties: false` + `$schema`
  key). oc38 adopts that exact strict schema object fork-side, so the pin
  stands without rebuild/reprobe.
- Verification carried from the oc38 handoff (implementation + all gates
  passed before the worker timed out at docs-recording; NOT rerun by this
  worker per scope): fork provider behavior tests pass; bootstrap
  owned-write bounded-shutdown all-paths + hang test pass; grant-revision
  proof tests pass; Harness typecheck/lint clean; fork final gates + build
  green; real-fork stdio smoke green; full Harness suite green; trusted
  approval→grant→real-stdio→local-Google-fixture→readonly-readback→receipt
  smoke PASS (temp removed); real UI approval suite all-green. Exact
  per-suite log counts are UNKNOWN (oc38 logs not retained in-repo; only
  structural counts are verifiable here: fork 6 + profile-pin 4 +
  wire-hash 2 + write-gate 4 + grant-revision 4 + shutdown-hang 1 new
  cases; retained `test-results/.last-run.json` read `passed`/zero-failed
  and was then deleted as a generated artifact).
- Remaining: fork PR #3 review/merge decision (not this worker); Harness
  PR #30 review/merge decision (not this worker); Windows 11 x64 manual
  smoke; C11-01 BLOCKED; M5 live/write gates (triple gate never opened
  live); §20 #1 UI phrasing.

## M5 production boundary final (2026-10-15, oc40 fixes, no live writes)

- POST-dispatch 3xx is `unknown` (fork `google.ts` + host mirror
  `testWirePatch`): the PATCH was already received by the server
  (`redirect: manual`, never followed), so no definite no-commit proof
  exists; exactly one attempt, no resend. Fork
  `googleReschedule.test.ts` + host `rescheduleWrite.test.ts` prove
  server-received-PATCH-then-3xx -> `unknown` with patchCount 1.
- Immutable production endpoint: shipped CLI (`src/reschedule/cli.ts`,
  bin `calendar-reschedule-mcp`) reads NO `M5_RESCHEDULE_TEST_*` env and
  never sets `endpointBase` (always the FIXED Google host). Fixture
  injection lives ONLY in the unshipped test-only runner
  (`src/tests/helpers/rescheduleTestRunner.ts` +
  `rescheduleTestStdio.ts`, outside `bin`/`files`/`scripts/build.js`),
  exercising the SAME production provider + MCP server factory
  (import-identity asserted). Host `rescheduleProcess.test.ts` explicit
  fork path now spawns that runner via tsx (never the shipped CLI with
  bypass env); new host `rescheduleEndpointIsolation.test.ts` proves the
  shipped CLI ignores test env + the committed-grant resolver contract
  with no live Google calls.
- Exact least-privilege scope: `WRITE_SCOPES` is
  `calendar.events` ONLY (broad `calendar` refused). Refresh-response
  `scope`/`scopes`, when the server reports one, must contain the exact
  write scope or the refresh is refused (config alone never equals a
  grant). Fork `productionBoundary.test.ts` covers exact/broad/readonly/
  spoof + refresh-scope verify.
- Write provenance pin (readonly pin untouched):
  `apps/server/src/rescheduleWriteProfile.ts` now pins
  branch `feat/m5-reschedule-entrypoint-v2`, base
  `6939311fd3eae9846648e0a175e304c9500f578e`, source commit
  `4f9c06dd9318c11ee9d352d61825c3f75f9ac8a6`, source tree
  `9eec88aa21951e1ea9564a62e89a40eeb2bcceef`, package-lock SHA-256
  `63261d25992ee9c97136a60bbf4fe52a5485cadea28b34d6b8b6c685f38bd533`
  (deps unchanged from the readonly base).
- Host vs fork CI scopes (no new flaky clone job added: host CI keeps no
  fork-fetch pattern; fork CI is the actual provider proof):
  fork default `npm test` (`vitest run src/tests/unit`) includes
  `src/tests/unit/reschedule` (832/832 green incl. 3xx/scope/boundary);
  fork `.github/workflows/ci.yml` now triggers on `feat/**` too so PR #3
  runs build + `lint` (`tsc -p tsconfig.lint.json`) + `check:imports` +
  unit tests with coverage. Host CI (`ci.yml` check + e2e) proves the
   tracked-fixture mirrors, static gates, and full pipeline smoke only;
   host `rescheduleProcess`/`rescheduleWrite` mirrors are NOT provider
   proof (stated here, not substituted).

## PR31 citation CI race fix (2026-10-15, test sync only, no product change)

CI ground truth: push run `38716307351` (head `a77cd1e`) failed ONLY
`e2e` with 2 failures in `apps/server/e2e/citation_recovery.spec.ts`
(stale-PUT CAS test `:71` + genuine-concurrent-409 test `:135`); both
`check` jobs passed and the same-head PR-event run `38716314333`
passed. Both failures are the identical line
`sessionIdOf (.../citation_recovery.spec.ts:42)`:
`expect(typeof id).toBe("string")` got `typeof null === "object"` —
the page's `localStorage ch.sessionId` was still empty. No seed,
409, expiry, collision, or route-capture behavior is implicated: the
read happens before `/seed-citation` and before any route is
installed. Root cause is a test/fixture race: `beforeEach` gates on
`#composer` visible + `#composer-send` enabled, which the static HTML
already satisfies before async `boot() -> ensureSession()` finishes
`POST /api/sessions` and writes `ch.sessionId`. Cold CI starts lose
the race (first two tests); warm runs win it (later tests +
same-head rerun passed). Fix (test-only, assertions kept):
`sessionIdOf` now `waitForFunction`s the real product signal
(`ch.sessionId` non-empty, 15s budget matching the file's other
waits) before reading/asserting. No M5 startup code touched, no
`client.ts`/`app.ts` product change, no timeout/retry/suppression,
readonly `:3000` service untouched. Local proof (Linux, real
Chromium, owned temp harness): the 2 affected cases pass
(`-g "citation drawer"`, 2/2, ~4s); `biome check` on the touched
spec clean. New-head CI after push, head `5195fef`: push run
`38717280204` success (e2e success, check ubuntu success, check
windows success) and PR-event run `38717286888` success (e2e
success, check ubuntu success, check windows success); zero review
comments on PR31 at observation time.
- HISTORICAL PR30 helper API (not the CURRENT normal-startup wiring):
  Concrete host resolver (closed contract, trusted-code-only, default
  OFF): `createCommittedGrantResolver` (connector-calendar, re-exported
  by `rescheduleWriteBinding.ts` + `createCommittedGrantWriteBinding`
  helper) keyed by execution/proposal/hash -> immutable
  `expectedRevision` with real source-etag basis; unknown/mismatched/
  hash-only/updated-only -> null (safe definite rejection, no dispatch).
  Nothing auto-wires: the host passes the resolver explicitly with its
  committed-grant store. Resolver answers are equality-checked against
  `grant.expectedRevision`; a throwing resolver pre-dispatch stays a
  safe definite failure (no dispatch happened). HISTORICAL scope ends here:
  in this helper the host passes the resolver explicitly. CURRENT PR31
  normal-startup composition instead auto-wires a concrete DB resolver —
  the frozen write profile (`M5_RESCHEDULE_WRITE_PROFILE=google-reschedule`
  + strict `M5_RESCHEDULE_CONNECTOR_JSON` hints) builds an inline
  `resolveExpectedEtag` over `repo.readCommittedGrantRevision`
  (`apps/server/src/bootstrap.ts`), equality-checked against the committed
  grant; see "M5 reschedule hardening + wire-hash pin" and the normal-startup
  write-profile proof above.
- Verification (this worker, no live Google/OAuth/writes): fork
  `npm run build` + `npm run lint` + `npm test` green; host units +
  typecheck/lint + pipeline smoke re-run below. Fork commits pushed
  ff-only on `feat/m5-reschedule-entrypoint-v2` (no merge, no force).
