# M4 MCP dependency spike — investigation only (§17.2)

Status: research-only record. No dependencies installed, no `package.json`
pin added, no compatible binding confirmed. No implementation in this spike.
Plan source: `docs/implementation_plan.md` §17 (agreed) and open spike §20 #2.

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
  fixed `mcp_env_not_allowed` BEFORE any transport creation/spawn. No env
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
