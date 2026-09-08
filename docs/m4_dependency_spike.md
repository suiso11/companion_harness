# M4 MCP dependency spike — investigation only (§17.2)

Status: research-only record. No dependencies installed, no `package.json`
pin added, no compatible binding confirmed. No implementation in this spike.
Plan source: `docs/implementation_plan.md` §17 (agreed) and open spike §20 #2.

## Provisional candidate (UNVERIFIED)

Prior research-only worker reported, without ability to edit/verify:

- Candidate package: `@modelcontextprotocol/client` `2.0.0` (UNVERIFIED, provisional)
- Official reference URLs reported:
  - https://github.com/modelcontextprotocol/typescript-sdk
  - https://www.npmjs.com/package/@modelcontextprotocol/client
  - https://ts.sdk.modelcontextprotocol.io/v2

Treat the above as UNVERIFIED provisional until the SDK source/version and
the chosen upstream binding are checked. Do NOT assert adoption, compatibilty,
or installability. No exact pin is selected in this repo.

## Explicit non-selection / block

- The repo specifies NO Calendar MCP provider, tool, or schema. There is no
  agreed upstream server, version, transport choice, read-only exact tool
  names, or canonical input-schema hashes.
- This spike does NOT select an actual upstream server/version/transport, does
  NOT invent compatibility or a provider, and does NOT assert any binding
  identity (`connectorInstanceId`/`serverId`/`kind`/`version` + exact upstream
  tool names + canonical input-schema hash per §17.3).
- If the §17.2 spike cannot confirm a stable official SDK plus a specific
  upstream Calendar binding, M4 does not proceed to ad-hoc MCP implementation
  (per §17.2: re-consult before starting M4).

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
against? Without that selection, no SDK pin and no compatibility claim can be made.
