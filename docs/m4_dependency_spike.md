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

## Missing upstream question for orchestrator

Which specific upstream Calendar MCP server/version/transport and which
read-only exact tool names + input schemas should the §17.2 spike verify
against — (a) an alternative existing upstream with read-only auth +
pagination + authoritative get, or (b) an explicitly approved scoped
patch/fork? Without that selection, no SDK pin and no compatibility claim
can be made. No broad OAuth grant and no fork is approved by this record.
