# M4 MCP dependency spike — investigation only (§17.2)

Status: research-only record. No dependencies installed, no `package.json`
pin added, no compatible binding confirmed. No implementation in this spike.
Plan source: `docs/implementation_plan.md` §17 (agreed) and open spike §20 #2.

> **Update 2026-10-11 (C08, `c08-decision-docs`).** The paragraphs below are
> the 2026-09-08/09 baseline and remain historical. The current exact-pin
> runtime evidence is recorded in "C08 exact pinned binding + runtime
> evidence" at the end of this file. **Formal adoption is HOLD / NOT
> ADOPTED**: no package pin, no live binding, no OAuth/live Google run. The
> only pin form chosen is the full git SHA + lock digest recorded there (not
> a branch/short SHA/private version/npm/tag/release). SDK `1.30.0` is now
> observed at runtime on the candidate fork (the earlier line "no
> `initialize`/`tools/list` ... performed" is superseded). The original
> upstream `nspady/google-calendar-mcp@7c788f5` was **not** newly executed;
> its file bodies remain unverified for that SHA.

Provider selection: **Google Calendar** (user-selected). Specific MCP
implementation: **not selected**. No SDK adopted, no server adopted, no
compatibility confirmed.

## Verified registry evidence (HTTP 200, metadata only)

Checked 2026-09-08 via verified HTTP-200 registry metadata (no install,
no `initialize`/`tools/list`, no live checks):

- `registry.npmjs.org/@modelcontextprotocol/sdk` — latest `1.30.0`,
  `node >= 18`, license MIT. **Not marked adopted; no compatibility proof.**
- `registry.npmjs.org/@modelcontextprotocol/client` — latest `2.0.0`,
  `node >= 20`, depends on core `2.0.0`. The "TS >= 6 required" claim is
  **unsupported** — do not assert it. **Not marked adopted; no
  compatibility proof.**
- Official reference URLs on record (unverified content, links only):
  - https://github.com/modelcontextprotocol/typescript-sdk
  - https://www.npmjs.com/package/@modelcontextprotocol/client
  - https://ts.sdk.modelcontextprotocol.io/v2
- Prior "official Google remote MCP" claim is **unsupported and removed**.
  Do not assert any official Google-hosted Calendar MCP.

## Inspected upstream candidate (NOT selected)

- Repo `nspady/google-calendar-mcp`, inspected main SHA
  `7c788f58e8b00db66ddd0eccd81fdc3dda0ecf9b` (working-tree inspection
  only — **not a release pin**). Latest release tag observed: `v2.6.3`.
  npm mirror name reported: `@cocal/google-calendar-mcp` (unverified pin).
- File-level immutable URLs (`auth/server.ts`,
  `types/structured-responses.ts`, handler paths) are **not recorded here**:
  tree verification was not completed in this worker, and paths must not
  be invented.
- Release-tag SHA and exact upstream tool input-schema hashes were
  **not obtained** — binding identity (§17.3) cannot be verified from this.

## Findings scope (from inspected revision)

- OAuth scope is hardcoded broad `calendar` (full read/write); adopting it
  would exceed M4 read-only needs.
- A `tools` allowlist in config does **NOT** narrow OAuth token scopes —
  it only limits exposed tools. Scoped-down access requires an auth-level
  change, not just an allowlist edit.
- List/search output exposes **no cursor / `nextPageToken`** and **no etag**;
  `updated` timestamp is present. `cancelled` status is **not** proof of
  deletion semantics — tombstone requires authoritative get/refresh
  confirmation per §17.5.
- No SDK install, no `initialize`/`tools/list`, no live Calendar checks
  were performed. **No compatibility proof exists.**

## Scope clarification (no approval implied)

- M4 "no writes" (§17.1/§17.3/§17.9) does **not** automatically imply the
  plan mandates exact OAuth scope strings. But adopting broad scopes is a
  user security decision; least-privilege read-only is preferred and no
  broad grant or third-party fork is approved by this spike.

## Proposed choices (decision required, not selected)

1. Investigate an alternative existing upstream with read-only auth +
   pagination (`nextPageToken`/cursor) + authoritative get semantics; or
2. Explicitly user-approved scoped patch/fork adding read-only auth +
   pagination + authoritative get semantics.
3. Changing only requested scopes is **insufficient** (pagination and
   authoritative-delete semantics gaps remain).

## Explicit non-selection / block

- The repo specifies NO Calendar MCP server, version, transport choice,
  read-only exact tool names, or canonical input-schema hashes. There is
  no agreed upstream server, version, read-only scope, or binding identity
  (`connectorInstanceId`/`serverId`/`kind`/`version` + exact upstream tool
  names + canonical input-schema hash per §17.3).
- This spike does NOT select an actual upstream server/version/transport,
  does NOT invent compatibility or a provider binding, and does NOT assert
  any adoption.
- If the §17.2 spike cannot confirm a stable official SDK plus a specific
  upstream Calendar binding, M4 does not proceed to ad-hoc MCP
  implementation (per §17.2: re-consult before starting M4).

## Fixed §17 security contracts (not adjustable by spike)

- Config-only MCP server definitions; no dynamic discovery (§17.3).
- Explicit allowlist bindings only; no auto-exposure of `tools/list` (§17.3).
- Binding identity verification; mismatch disables binding (§17.3).
- M4 no writes; read-only bindings only (§17.1, §17.3, §17.9).
- `structuredContent` first; strict contract-JSON-text fallback only; no prose
  heuristics (§17.4).
- stdio: `shell=false`, config-only command, env allowlist, stderr 64KiB cap,
  shutdown wait + kill timeout (§17.7).
- Streamable HTTP: loopback (`127.0.0.1`/`localhost`) only; redirects refused (§17.7).
- Secrets/redaction via §12.4 single layer; fixed lowercase error codes only (§17.7–§17.8).
- Lazy persistent connections; app start never blocked by MCP (§17.6).
- Demand-driven reconnect with backoff `1s/2s/5s/10s/max 30s`; no automatic
  logical tool-call resend; per-instance concurrency 1 (§17.6).

## Next spike checklist (needs upstream answer)

1. Confirm stable official SDK exact package name + version (exact pin) from
   an authenticated source; record evidence, then pin.
2. Upstream selection: specific Calendar MCP server, version, transport
   (stdio vs loopback Streamable HTTP), and read-only scope.
3. Record exact upstream tool names + canonical input-schema hashes for binding
   identity (§17.3); verify `initialize`/`tools/list` behaviour.
4. Map upstream revision signals to §17.5 precedence
   (etag → source-updated → normalized hash).
5. Confirm `calendar.search` exact input mapping (query/start/end/limit/cursor,
   `start<end`, max 90d, one page, no auto-pagination) and Snapshot privacy
   exclusions (§17.4).
6. Keep CI fake-only; live test stays opt-in read-only (§17.9).

## Design follow-up (2026-09-08, user-approved design scope)

Concrete readonly patch design delivered in
`docs/google_calendar_readonly_binding_design.md` (design-only, no adoption):
SHA-`7c788f5` actual paths verified (`src/auth/server.ts` broad `calendar`
scope; `src/server.ts`; `src/tools/registry.ts` 12+1 tools; list/search/get
handlers with no cursor/etag; `BaseToolHandler` 404/no-410 + timezone
precedence; `structured-responses.ts` sensitive passthrough). Proposes external
patch/fork deltas (readonly scopes, 4-tool internal surface with single
model-exposed `calendar.search`, single-calendar opaque pageToken with hard
one-page `limit<=20` mapping, etag threading) + Companion mapping; deletion
classifier explicitly UNRESOLVED (2026-09-09 correction: `events.get` has NO
`showDeleted` — withdrawn; bare 404/410 or `cancelled` alone is NOT deletion
proof; 410 = list sync-token resync; ambiguous errors → upstream_error);
SDK NOT ADOPTED,
schema hashes unclaimed, M4 NOT implemented, §17 contracts unchanged.
Remaining decision: §7 of the design (approve scoped patch/fork vs alternative
upstream).

## Verification attempt (2026-09-09, resolve-m4-dependencies-verify)

- `pnpm install --lockfile-only` (exit 0): lockfile now coherent —
  importers `packages/connector-mcp` + `packages/connector-calendar`,
  `@modelcontextprotocol/sdk@1.30.0` resolved. Full `pnpm install`
  (2 attempts) crashed on Windows (pnpm native exit -1073740791 during
  fetch; node_modules pruned) so local tsc/Biome/vitest could NOT run —
  runtime UNVERIFIED locally. No source fixes applied blind.
- Foundation (commit 3f31fe4) remains: fake-only SDK protocol tests,
  no live Calendar/OAuth, no nspady/external compatibility claim.
  Gate open — CI fresh-env verification required.

## Hardening pass (2026-09-09, harden-m4-mcp-foundation)

- Verified SDK 1.30.0 source (unpkg immutable version URLs, no install):
  `client/stdio.js` hardcodes `shell:false`; env is
  `{...getDefaultEnvironment(), ...server.env}` — exact explicit allowlist
  is NOT enforceable (inherited `DEFAULT_INHERITED_ENV_VARS` always leak;
  surfaced as `STDIO_IMPLICIT_ENV_VARS`, no compliant claim). `close()`
  already bounds shutdown (stdin.end + 2s + SIGTERM + 2s + SIGKILL);
  `stderr:"pipe"` exposes a `PassThrough` immediately for continuous drain.
  `client/streamableHttp.d.ts` (1.30.0) exposes NO redirect option —
  redirects refused via a `redirect:"manual"` fetch wrapper + runtime
  loopback re-check at the factory boundary.
- Connector now verifies binding identity inside `ensureConnected`
  (live `tools/list` + canonical-JSON SHA-256 vs configured names/hashes);
  drift/missing yields `mcp_schema_mismatch` with no upstream call;
  `isError:true` maps to redacted `calendar_upstream_error`; failed
  connect/call disconnects (no leaked client); per-instance mutex kept.
- Calendar normalize validates real ISO/all-day start/end with end>start
  and hashes the truncated normalized snapshot (canonical JSON), not raw.
- Tests are genuine connected in-memory SDK fixtures (initialize/list/call,
  drift-denies-dispatch, isError redaction, close) + snapshot-hash/time
  units. Fake-only; NO live upstream compat claim.
- Remaining gaps: exact stdio env allowlist unenforceable with SDK 1.30.0
  (fail-closed would mean dropping stdio until a pin/option allows exact
  env); no live Calendar binding selected (orchestrator question above
  still open); local runtime unverified on Windows (CI to verify).

## Missing upstream question for orchestrator

Which specific upstream Calendar MCP server/version/transport and which
read-only exact tool names + input schemas should the §17.2 spike verify
against — (a) an alternative existing upstream with read-only auth +
pagination + authoritative get, or (b) an explicitly approved scoped
patch/fork? Without that selection, no SDK pin and no compatibility claim
can be made. No broad OAuth grant and no fork is approved by this record.

## Fail-closed stdio env (2026-09-09, verify-m4-ci-and-close-env-gap)

- SDK 1.30.0 source verified via
  `https://unpkg.com/@modelcontextprotocol/sdk@1.30.0/dist/esm/client/stdio.js`
  (HTTP 200, no install): `DEFAULT_INHERITED_ENV_VARS` is win32
  `[APPDATA,HOMEDRIVE,HOMEPATH,LOCALAPPDATA,PATH,PROCESSOR_ARCHITECTURE,
  SYSTEMDRIVE,SYSTEMROOT,TEMP,USERNAME,USERPROFILE,PROGRAMFILES]` and posix
  `[HOME,LOGNAME,PATH,SHELL,TERM,USER]`; `getDefaultEnvironment()` filters
  `process.env` to those names and `StdioClientTransport.start()` merges it
  UNDER explicit `env` with `shell:false`.
- Connector is now fail-closed: the required set is the live
  `DEFAULT_INHERITED_ENV_VARS` import (runtime-platform names, no invented
  API); `missingStdioEnvNames`/`assertStdioEnvClosed` require EVERY
  effectively inherited name explicitly in config `envAllowlist`, else
  `defaultTransportFactory` throws and `ensureConnected`/`callTool` return
  fixed `mcp_unavailable` BEFORE any transport creation/spawn. No env
  values logged (fixed code + missing count/names only).
- Regression: `packages/connector-mcp/test/stdio-env-failclosed.test.ts`
  (counting fake factory proves zero factory calls on rejection; full
  allowlist passes the guard). Existing connected tests now use the explicit
  full-default allowlist.
- CI: prior run 34247502570 (b67f0ee) failed at Lint (Biome format +
  organizeImports); fixed via real `biome check --write` on
  `packages/connector-mcp|calendar`. Full `biome check .` exits 0 locally
  (one pre-existing biome.json deprecation info only). tsc/vitest local run
  still blocked (pruned node_modules, no installs); CI fresh-env run
  re-verifies. M4 NOT complete: no upstream Calendar binding selected, no
  live compatibility claim.

## C08 exact pinned binding + runtime evidence (2026-10-11, c08-decision-docs)

Status: **FORMAL ADOPTION = HOLD / NOT ADOPTED.** This records completed C08
evidence only. No new package pin, no live binding activated, no OAuth and no
live Google Calendar call. §17 contracts unchanged. The pin form remains the
**full git SHA + lockfile digest** (below), and the C08-07 distinction between
the logical `serverId` and the wire `serverInfo.name`/version is unchanged.
Task: `c08-decision-docs`; the C08 docs plus the versioned evidence snapshot
below. The raw fixture capture is a **credential-free protocol + handler-body
probe, NOT a live Google/OAuth run**, and formal adoption remains HOLD.

### Versioned, reproducible evidence snapshot

The 9 wire-capture / provenance / manifest artifacts are committed as a
deterministic, byte-preserving gzip-tar snapshot, so another developer or CI
can audit the authoritative C08 hashes without the original host path:

- Archive (canonical repository-relative link):
  [`docs/evidence/c08/2026-10-11/c08-evidence.tar.gz`](evidence/c08/2026-10-11/c08-evidence.tar.gz)
- Archive SHA-256:
  `52b63fee169394b74c8827a04022ca454d1fa82d8b5de935702c574914db0d94`
  (9,352 bytes; deterministic tar: mode 0644, uid/gid 0, empty uname/gname,
  mtime 0, gzip mtime 0 + no gzip filename field; flat relative members only,
  no symlinks/foreign files).
- Members (9): `client-report.json` (48 KB full wire capture, primary phase),
  `consumer-mismatch.json`, `identity-gap.json`, `provenance.json`,
  `SOURCE_HASHES.txt`, `git-pins.txt`, `child-identity.json`,
  `fixture-calls.json` (root file is the later identity-probe phase; the
  complete PRIMARY-phase call counts are embedded at
  `client-report.json["fixture-calls.json"]`), `manifest.sha256`.
- Host paths inside `provenance.json`/`child-identity.json` are retained **raw
  historical metadata** only; they are NOT required to locate or read the
  archive. The canonical, durable location is the repository-relative link
  above (the original host archive is left byte-for-byte untouched).

**Reproduce / read:**

```sh
tmp="$(mktemp -d)"
tar -xzf docs/evidence/c08/2026-10-11/c08-evidence.tar.gz -C "$tmp"
( cd "$tmp" && sha256sum -c manifest.sha256 )   # 8 hashed data files: all OK
# client-report.json -> toolsList.names / toolsList.schemaHashes /
#   toolsList.toolMeta[*].inputSchema: recompute recursive-key-sort +
#   JSON.stringify + SHA-256 and compare with both schemaHashes and
#   expectedHistorical (the 4 canonical input-schema hashes, table below).
# client-report.json -> toolCalls: the 4 successful calls
#   (list-calendars / list-events / search-events / get-event) carry
#   content-text ONLY (structuredContent ABSENT); start/end are objects.
# consumer-mismatch.json -> get-event.timed + list-events.allDay are rejected
#   on start/end object-vs-string; control.stringStartEnd is accepted.
# identity-gap.json -> ensureConnected ok, list-calendars ok, unconfigured tool
#   denied with mcp_binding_not_allowed (logical serverId != wire identity).
```

Verified at snapshot time from a fresh extraction: all 8 `manifest.sha256`
entries match, and all 4 recomputed canonical input-schema hashes equal the
recorded values (table below). The archive is a binary snapshot precisely so no
JSON formatter can rewrite the raw cryptographic capture.

### C08 candidate + exact pin form

- Repo `https://github.com/suiso11/google-calendar-mcp`, package
  `@cocal/google-calendar-mcp`, private version `3.0.0-readonly.1`.
- Immutable commit full SHA `97a3dc36873b8f52870695d7706d182d5a8fc401`,
  tree `ae743a8bd7cc7002c2368618fbe098dba8af341e`; exact SHA checked out
  (not a moving branch head).
- **Exact pin form chosen for candidate revalidation is the full git SHA plus
  the candidate `package-lock.json` digest
  `6afe76f90327d4b04c4dfc24161017c85f0910350fcbcf802c1b91c2e48bd523`** —
  explicitly NOT a branch, short SHA, private version string, npm dist-tag,
  GitHub tag, or release.
- Dependency provisioning (candidate lock only): `npm ci --omit=dev
  --ignore-scripts --no-audit --no-fund` added 163 packages, lifecycle scripts
  NOT run. This was an owned external operational directory only — **no
  Companion install and no Companion lockfile change**. The lockfile did
  contain the Google runtime deps (`googleapis`/`google-auth-library`/
  `gaxios`/`open`); no missing-dependency load failure occurred (those were
  absent from the pre-existing installed workspace, not from the lock).
- Runtime versions observed on the candidate: node `24.12.0`, SDK
  `1.30.0`, zod `4.3.6`, googleapis `171.4.0`, google-auth-library `10.6.1`,
  gaxios `7.1.3`. SDK `1.30.0` **registry metadata** and the fork **runtime**
  are separate claims: metadata is npm-registry-only (HTTP if needed for
  C08-01) and was not re-run/installed here.

### Fresh genuine MCP protocol (stdio, credential-free)

- Genuine `initialize`: protocol `2025-11-25`, `serverInfo`
  `{name: "google-calendar", version: "3.0.0-readonly.1"}`,
  `capabilities.tools.listChanged = true`. `tools/list` returned exactly four
  read-only tools.

### Authoritative exact table (the single canonical table)

Canonical input-schema hash = recursive key-sort + `JSON.stringify` +
SHA-256 hex (identical routine to `packages/connector-mcp/src/config.ts`
`canonicalSchemaHash`).

| upstream tool | canonical input-schema SHA-256 | historical match |
| --- | --- | --- |
| `get-event` | `f3212ecb17c3e45f69f7412b3a1e28cc4aaec770121925d23d31d4b699f73e89` | true |
| `list-calendars` | `ae9285fc8b0632942517f82ff5819be9152a14feaec7d11098eb9476e9eeb398` | true |
| `list-events` | `279887bf288ea036792c32c20a7a0b800d1a34cb371c8f161b546d12f683fcf3` | true |
| `search-events` | `027de2d89db1284173509eae71808575412461caca0f53aeb1085b011fe63167` | true |

All four hashes match the historical (2026-09-09) record exactly. The design
doc links to this table; do not re-list the four hashes elsewhere.

### Actual handler-body proof (fixture-backed, not live Google)

- Actual fork `buildServer`/`ToolRegistry`/4 handlers/converter/
  response-builder plus the real SDK stdio transport were executed.
- Injection boundary: a probe-owned `executeWithHandler` override routed the
  **actual** `handler.runTool` with inert fixture accounts; ONLY the
  protected `BaseToolHandler.prototype.getCalendar` factory (provider
  GoogleAPI) was replaced with a deterministic fixture. Fresh HOME; stdlib
  `node:http`/`node:https` and global `fetch` replaced with throwing counters
  (fixture `networkBlocked = 0`). Ordinary fork CLI/index/`initializeOAuth`/
  account loading were **never** run. This is credential-free protocol +
  actual handler-body proof, **NOT** ordinary authenticated startup and
  **NOT** live Google compatibility.
- Bodies are JSON **content text only, `structuredContent` ABSENT** on all
  four calls (`resultEnvelope`):
  `list-calendars` → `{calendars:[...],totalCount:1}`;
  `list-events` → `{events:2,totalCount:2,nextPageToken}` (timed + all-day);
  `search-events` → `{events:2,totalCount:2,query,calendarId,nextPageToken,timeRange}`;
  `get-event` → `{event}`.
- Provider calls: exactly one `calendarList.list` and one `events.list` per
  list/search call, with `maxResults: 10` and `pageToken` opaque-in →
  opaque-out. Raw event `start`/`end` are objects (`{dateTime?,date?,timeZone?}`);
  `etag` preserved. Privacy fields (attendees/organizer/conferenceData/
  htmlLink/extendedProperties) pass through **when the fixture provider
  returns them** — the fixture does not filter a field mask, and no claim is
  made that Google ignores field masks.
- Fixture `get-event` miss → genuine MCP `isError: true`, code `-32603`,
  generic "not found" message. This is **NOT** deletion proof; authoritative
  deletion (C11) is untouched.
- Artifact caveat: the root `fixture-calls.json` was overwritten by a later
  identity-probe phase and shows only 1 `calendarListList` call. The complete
  PRIMARY-phase provider-call counts are in
  `client-report.json["fixture-calls.json"]` — use that artifact, do not
  misrepresent the overwritten root file.
- Cleanup: fork `node_modules`, temp HOME and probe sources were cleaned; the
  raw protocol capture and source-hash artifact were retained. (The declared
  scratch path `/tmp/opencode/c08-*` was denied by the external-directory
  tool policy; the worker relocated to the owned
  `/home/molmot/.local/share/opencode/tool-output/c08-probe`, accepted by the
  parent as a safe operational path change.)

### Producer/consumer mismatch (current `main` fact)

- The proposal's consumer `proposedUpstreamEventSchema` /
  `normalizeEvent` in `packages/connector-calendar/src/normalize.ts`
  (`start`/`end` typed as `z.string()`) **REJECTS** the actual timed event and
  the actual all-day event: ZodError `invalid_type` at `path=start`/`end`,
  expected `string`, received `object`.
- A control event with **string** `start`/`end` is accepted (sourceRevision
  from `etag`, revisionBasis `etag`).
- Currency check: the three C08 companion source files have **identical git
  blob hashes** at the probe revision and at `origin/master` `e6b5353`
  (`packages/connector-mcp/src/client.ts` `60f3db47…`, `config.ts` `0db183ce…`,
  `packages/connector-calendar/src/normalize.ts` `39178153…`). The mismatch
  and identity gaps are therefore **current-main** facts, not branch-only.

### C08-07 identity decision (DONE — decision selected; C09 implementation gap)

**Decision (parent GIVEN, 2026-10-11):** `serverId` remains the logical
configuration/binding identifier in the existing §17.3 tuple
(`connectorInstanceId`/`serverId`/`kind`/`version`). It is **NOT** implicitly
equal to the wire `serverInfo.name`, and C09 must **not** naively require
`config.serverId === actual serverInfo.name`. The *expected wire identity* is
instead carried explicitly by the immutable trusted candidate binding
definition.

**Exact trusted candidate expectations (this candidate):** the immutable
binding definition records the expected `initialize` `serverInfo` exactly
`{name: "google-calendar", version: "3.0.0-readonly.1"}`, tied to the full git
SHA `97a3dc36873b8f52870695d7706d182d5a8fc401` + lock digest
`6afe76f90327d4b04c4dfc24161017c85f0910350fcbcf802c1b91c2e48bd523`. Here
`binding.version` denotes the version of the **bound upstream surface** (as the
existing config documentation already means); for this candidate that expected
upstream-surface version is `3.0.0-readonly.1`.

**Required C09 behaviour (decision, not yet implemented):**
1. Resolve the expected wire identity **only** from the explicit trusted
   binding definition — never derive it from user text, and never guess it from
   the logical `serverId`; no fallback to "tool hash only".
2. Compare actual `initialize` `serverInfo.name` / `serverInfo.version`
   **before any binding is enabled**.
3. Missing expected wire identity, or **any** wire name/version mismatch,
   disables **all** bindings of that connector instance (fail-closed).
4. Only after that, run the existing exact upstream tool-name + canonical
   input-schema hash verification.

This is a **semantics / decision record**. It does **not** claim the current
config accepts new fields or that the binding profile is implemented: the C09
config representation and caller migration remain future work. **No config /
API / code change is made here.**

**Raw probe result (retained, re-interpreted):** an actual Companion
`McpConnector` was connected over real stdio to the actual pinned server using
the logical test label `serverId = intentionally-wrong-server-id`, version
`9.9.9-wrong-version`, and the correct four schema hashes. `ensureConnected`
returned `ok: true`, all four bindings enabled, and `list-calendars` succeeded;
an unconfigured `delete-event` was denied with `mcp_binding_not_allowed`. That
`intentionally-wrong-server-id` string was only a **logical** test label;
arbitrary logical IDs alone are **NOT** evidence of a wire mismatch. The real
evidence gap is narrower and precise: the connector performs **no `serverInfo`
name/version comparison at all** and there is **no expected wire identity** to
compare against — the configured version `9.9.9-wrong-version` and the four
correct tool hashes still succeeded. The connector verifies only exact upstream
tool name + canonical input-schema hash. This runtime gap is **assigned to
C09; no fix is in scope here**, and C09/C10 must not be claimed complete.

### Live scope conflict (static documentation only)

- Official fresh HTTP source read by the parent:
  `https://developers.google.com/workspace/calendar/api/v3/reference/calendarList/list`
  — its Authorization section allows `calendar.readonly`, `calendar`,
  `calendar.calendarlist`, `calendar.calendarlist.readonly` and does **NOT**
  include `calendar.events.readonly`.
- The pinned fork `src/auth/scopes.ts` (L2–L7) allows ONLY
  `https://www.googleapis.com/auth/calendar.events.readonly` and its
  `isValidGrantedScopes` rejects any broader grant. This is a **static
  contract conflict**, not an observed live 403. Resolution needs a scoped fork
  follow-up / narrow-call-strategy decision plus a separate read-only live
  opt-in; **no auth-scope expansion is approved here**.

### C08-01..08 decision matrix

| item | type | outcome |
| --- | --- | --- |
| C08-01 | 確認 | DONE — SDK `1.30.0` registry metadata kept separate from fork `97a3dc3`/`3.0.0-readonly.1` runtime evidence. |
| C08-02 | 調査 | DONE — primary evidence fixes full immutable commit, server identity, runtime versions. |
| C08-03 | 調査 | DONE — real `initialize`/`tools/list` responses captured; exact tool names. HTTP metadata not treated as protocol proof. |
| C08-04 | 調査 | DONE — canonical input-schema hashes computed and tied to names; version binding still unenforced (→ C09). |
| C08-05 | 調査 | DONE — response mapping proven by actual bodies; `structuredContent` ABSENT; design imports-only claim resolved for this fork SHA. |
| C08-06 | 決定 | DONE — exact pin form = full SHA + lock digest; formal adoption **HOLD / NOT ADOPTED**. |
| C08-07 | 決定 | DONE — decision selected: logical `serverId` ≠ wire `serverInfo.name`; expected wire identity (`google-calendar`/`3.0.0-readonly.1`) resolved from explicit trusted binding definition and fail-closed before enable. Impl gap → C09 (no config/code here). |
| C08-08 | 記録 | DONE — protocol evidence, formal adoption, live OAuth and live readiness recorded in separate columns; unexecuted items stated. |

### Independent review outcome (2026-10-11)

Two independent reviews covered this record. The **evidence review** was clean
on first pass (confidence 0.94). The **decision review** initially raised one
blocker — the logical `serverId` was being conflated with the wire
`serverInfo.name` — which was corrected in `oc28` and re-reviewed clean
(confidence 0.97, no remaining findings). Both reviews are documentation-only
and add no new runtime, adoption, or live-readiness claim.

### Adoption gates (no formal production adoption until met)

1. Implement the C09 fail-closed identity from the decision above: expected
   `serverInfo` name/version resolved from the trusted binding definition (not
   the logical `serverId`), compared before enable, plus exact tool/schema
   hash.
2. Response adapter + strict contract-JSON fallback (and privacy exclusions)
   for the real start/end object wire shape.
3. Scope compatibility resolution (the `events.readonly` vs
   `calendarList` static conflict above) plus a separately approved read-only
   live opt-in.
4. Authoritative deletion evidence remains a **separate gate (C11)**; a
   cancelled entry, a 404, or search omission must never be mapped to deleted.
   C09/C10 are not complete.
