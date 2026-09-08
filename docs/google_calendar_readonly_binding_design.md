# Google Calendar LOCAL readonly MCP binding — patch design (proposal, not adopted)

Status: **design-only proposal**. No code changed, no SDK adopted, no upstream
server/version/transport selected, no `initialize`/`tools-list` compatibility
proof, no OAuth grant, no live access. M4 remains **not implemented**; §17
contracts unchanged. Companion-side plan source: `docs/implementation_plan.md`
§17 (agreed). Spike record: `docs/m4_dependency_spike.md` (research-only).
Branch: `feat/m4-mcp-spike`.

Upstream inspected (working-tree HTTP inspection only, **not a release pin**):
`nspady/google-calendar-mcp` immutable commit
`7c788f58e8b00db66ddd0eccd81fdc3dda0ecf9b` (main SHA per prior spike).
Latest release tag observed: `v2.6.3` (unverified pin). npm mirror
`@cocal/google-calendar-mcp` (unverified pin). No vendored copy, no fork, no
install, no execution in this task.

## 1. Verified actual upstream paths (SHA-pinned raw URLs, HTTP 200)

Base: `https://raw.githubusercontent.com/nspady/google-calendar-mcp/7c788f58.../`

- `src/auth/server.ts` — `AuthServer.generateOAuthUrl()` hardcodes broad scope:
  `scope: ['https://www.googleapis.com/auth/calendar']` (full read/write).
  PKCE S256 + `state` CSRF check; loopback callback `http://localhost:<3500-3505>/oauth2callback`;
  `startForMcpTool()` 5-min auto-shutdown.
- `src/server.ts` — `GoogleCalendarMcpServer`: `McpServer({name:"google-calendar",
  version: SERVER_VERSION})` (version read from `package.json` at runtime);
  `ToolRegistry.registerAll(...)` + special `manage-accounts` tool
  (`list`/`add`/`remove`, `destructiveHint:true`); stdio + HTTP transports;
  `ensureAuthenticated()` blocks tool calls without tokens.
- `src/tools/registry.ts` — actual tool table (12 + `manage-accounts`):
  `list-calendars`, `list-events`, `search-events`, `get-event`,
  `list-colors`, `create-event`, `create-events`, `update-event`,
  `delete-event`, `get-freebusy`, `get-current-time`, `respond-to-event`.
  Read-only annotations (`readOnlyHint:true, openWorldHint:false`) exist on:
  `list-calendars`, `list-events`, `search-events`, `get-event`,
  `list-colors`, `get-freebusy`, `get-current-time`.
- `src/handlers/core/ListEventsHandler.ts` — `calendar.events.list` with
  `singleEvents:true, orderBy:'startTime'`; **no `maxResults`, no
  `pageToken` passthrough, no cursor return**; merges multi-calendar via
  `BatchRequestHandler`; sorts client-side; returns `createStructuredResponse`.
- `src/handlers/core/SearchEventsHandler.ts` — same `events.list` + `q: query`;
  `timeMin`/`timeMax` **required** in zod schema; **no cursor/nextPageToken**.
- `src/handlers/core/GetEventHandler.ts` — `calendar.events.get`; maps
  404 → `null` → throws "not found"; other errors via `handleGoogleApiError`.
  No `showDeleted`, no 410 branch in handler.
- `src/handlers/core/ListCalendarsHandler.ts` — `calendar.calendarList.list()`
  (no args); no pagination passthrough.
- `src/handlers/core/BaseToolHandler.ts` — `handleGoogleApiError`: 400/403/404/
  429/5xx → `McpError`; **no explicit 410 branch**; `normalizeTimeRange`
  precedence: explicit `timeZone` > calendar default (`calendarList.get`) >
  `UTC`; `resolveCalendarId(s)` name→ID via `summaryOverride`/`summary`.
- `src/types/structured-responses.ts` — `StructuredEvent` carries
  `id/summary/description/location/start/end/status(=Google status string)/
  htmlLink/created/updated/creator/organizer/attendees/conferenceData/
  hangoutLink/extendedProperties/.../calendarId/accountId`;
  `convertGoogleEventToStructured()` passes through sensitive fields
  (attendees, organizer, links). `ListEventsResponse={events,totalCount,...}`;
  `SearchEventsResponse={events,totalCount,query,...}`; no cursor/etag fields.
- `src/utils/response-builder.ts` + `field-mask-builder.ts` referenced by
  handlers (not re-fetched; paths recorded from imports — do not quote API).

## 2. Patch spec (PROPOSED, external-server ownership — not applied)

Owner: **external server patch/fork, NOT Companion packages**.
`packages/connector-mcp` + `packages/connector-calendar` MUST NOT be created
until the §17.2 gate (stable official SDK pin + specific binding compat spike)
is satisfied. No new repo/fork/provider install/OAuth/live access in this task.

### P1 — Least-privilege auth (auth-level, not allowlist)
- File: `src/auth/server.ts` `generateOAuthUrl()`.
- PROPOSED delta: `scope: ['https://www.googleapis.com/auth/calendar.events.readonly']`
  (+ `'https://www.googleapis.com/auth/calendar.calendarlist.readonly'` ONLY
  if `list-calendars` must keep working against a fresh readonly grant; justify
  in fork PR by calling `calendarList.list` with the events-only scope and
  recording the observed 403/insufficient-permission behavior — do not assume).
- **Separately provisioned readonly credentials**: new Google Cloud OAuth client
  (or new consent) for the readonly scope; **no auto-reuse of existing broad
  `calendar` tokens** — old token files must not be picked up
  (`TokenManager` path/account separation + docs migration note). Token refresh
  keeps the narrowed scope (Google down-scoping is not automatic on reuse).
- `manage-accounts` `add` flow unchanged structurally; re-consent required.
- Rationale (§17.9 + spike): `enabledTools` allowlist does NOT narrow token
  scope — auth-level change is mandatory.

### P2 — Read-only tool surface (config allowlist is insufficient alone)
- PROPOSED fork default: `enabledTools` (existing `ServerConfig.enabledTools`
  + `ToolRegistry.validateToolNames`) ships as exactly:
  `['list-calendars','list-events','search-events','get-event']`.
  (`get-freebusy`/`get-current-time`/`list-colors` stay available upstream but
  are NOT in the Companion allowlist proposal: freebusy leaks busy detail
  outside the §17.4 Snapshot contract; current-time duplicates frozen Turn
  `now`; colors serve writes.)
- Write handlers (`create-event`, `create-events`, `update-event`,
  `delete-event`, `respond-to-event`) + `manage-accounts(add/remove)` MUST NOT
  be registered in the readonly build (not merely filtered client-side).
  Companion allowlist (§17.3) additionally exposes only the four bindings.

### P3 — Pagination: one upstream page + opaque pageToken (PROPOSED delta)
- Actual gap: `ListEventsHandler`/`SearchEventsHandler` never send/return
  `maxResults`/`pageToken`/`nextPageToken`; `*_response` types have no cursor.
- PROPOSED versioned delta (fork minor bump; exact version assigned by fork
  owner): add optional input `pageToken: string` (opaque, passthrough only) and
  optional `pageSize` (clamped server-side, e.g. max 50, default unset = API
  default); pass to `events.list({maxResults, pageToken})`; return
  `nextPageToken?: string` verbatim in `ListEventsResponse`/`SearchEventsResponse`.
  Companion maps `nextPageToken` → §17.4 `cursor` (opaque, single page per
  `calendar.search` call, **no auto-pagination**). Never synthesize or parse
  the token. Google reference (link only, content not executed):
  `https://developers.google.com/calendar/api/v3/reference/events/list`.

### P4 — structuredContent-first + strict JSON fallback (Companion side, §17.4)
- Upstream `createStructuredResponse` already returns `structuredContent`
  (per handler imports; builder body not quoted here). Companion
  `connector-calendar` (future, post-gate): `structuredContent` first; fallback
  ONLY to strict validation against the agreed contract JSON schema; reject on
  mismatch (`calendar_response_invalid`); **no prose heuristics**, no free-text
  JSON fallback (§17.4/§17.10).

### P5 — Query/time filters/timezone mapping (actual → §17.4 contract)
- Actual upstream: `search-events` requires `timeMin+timeMax` ISO-8601
  (regex `YYYY-MM-DDTHH:MM:SS[Z|±HH:MM]`), optional `timeZone` (IANA),
  `q=query` free-text (summary/desc/location/attendees server-side);
  `list-events` `timeMin/timeMax` optional; timezone precedence explicitArg >
  calendar default > UTC (`normalizeTimeRange` + `getCalendarTimezone`).
- Companion `calendar.search` exact input (agreed, unchanged):
  `query?/start(ISO,req)/end(ISO,req)/limit(default10,max20)/cursor?`,
  `start<end`, range ≤90d, **one page per call**. Mapping (future code):
  `start→timeMin`, `end→timeMax`, frozen Turn `timeZone` → upstream `timeZone`
  (IANA only), `limit→pageSize` ONLY if P3 adopted (else client-side cap +
  explicit truncation note — never claim server paging), `cursor→pageToken`.

### P6 — Authoritative get: 404/410 vs `cancelled` (actual + Google evidence)
- Actual: `GetEventHandler.getEvent` catches 404 → `null` → "not found" throw;
  `BaseToolHandler` has **no 410 branch** (falls to generic error).
  Google API semantics (links only, no live call):
  `https://developers.google.com/calendar/api/v3/reference/events/get`
  (404 = not found; deleted entries need `showDeleted` / `status:cancelled`),
  `https://developers.google.com/calendar/api/v3/reference/events/list`
  (`showDeleted`, `singleEvents`, sync `410 Gone` on expired sync tokens).
- PROPOSED delta: `getEvent` gains `showDeleted:true` option (or dedicated
  authoritative path) mapping: 404/410 on authoritative get/refresh →
  tombstone-eligible signal; `status:'cancelled'` on a `showDeleted` read =
  deletion evidence. **Search omission NEVER creates a tombstone** (§17.5).
  Upstream `status` strings (`confirmed`/`tentative`/`cancelled`) map to
  Snapshot `status` (`confirmed`/`tentative`/`cancelled`/`deleted`): only an
  authoritative deleted confirmation yields `deleted`; `cancelled` alone is
  NOT proof of deletion (spike finding preserved).

### P7 — Revision precedence `etag > updated > hash` (§17.5)
- Actual gap: `StructuredEvent` exposes `updated` (`event.updated`) but
  handlers never surface `etag`; no revision key returned.
- PROPOSED delta: thread Google `etag` through `convertGoogleEventToStructured`
  (optional `etag?` field, versioned); Companion precedence stays
  (1) `etag` → (2) `sourceUpdatedAt` (= `updated`) → (3) normalized content
  hash. Local integer `revision` stays append-only, never used for staleness;
  `source_revision ?? content_hash` is the staleness key (agreed, unchanged).

### P8 — Snapshot privacy (§17.4 exclusions enforced Companion-side)
- Actual: upstream passes through `attendees/organizer/conferenceData/
  hangoutLink/htmlLink/extendedProperties`.
- Companion normalizer (future, post-gate) keeps ONLY: `status/title/
  description?/location?/start/end/sourceUpdatedAt` (+ `personal` sensitivity,
  all-day `end` exclusive); drops attendees/emails/organizer/conference-join
  URLs/HTML links/raw MCP payload. Explicit limit: structured-field exclusion
  is enforceable; **arbitrary free-text inside `description` is NOT redacted —
  do not claim free-text PII redaction solved** (untrusted boundary stays
  structural: rN/snapshot-only, size/observation caps, §17.8).

### P9 — stdio security + redaction ownership (§17.7, §12.4)
- Companion `connector-mcp` stdio (future): `shell=false`, config-only command
  (no interpolation), explicit env allowlist only, stderr 64KiB cap
  (truncate + fixed code), shutdown wait + kill timeout; Streamable HTTP
  loopback-only, redirects refused. Secrets via §12.4 single layer; fixed
  lowercase codes only (`mcp_unavailable/mcp_binding_not_allowed/
  mcp_schema_mismatch/calendar_response_invalid/calendar_upstream_error/
  calendar_range_invalid`); no raw MCP traffic/tokens in logs/events/audit.
- Upstream fork must not log tokens (existing `process.stderr` warnings carry
  reasons — audit before adoption).

## 3. Proposed strict fixture/schema artifacts (docs-only, NOT normative)

Concrete enough to code against post-gate; schemas live in `packages/contracts`
only after the gate. Hash values deliberately absent.

```json
// PROPOSED ListEventsResponse delta (fork): adds nextPageToken only
{ "events": [], "totalCount": 0, "nextPageToken?": "opaque" }
// PROPOSED calendar.search (Companion, agreed §17.4 — unchanged):
{ "query?": "string", "start": "ISO", "end": "ISO", "limit": "10|<=20", "cursor?": "opaque" }
```

- **Exact tool schema hashes CANNOT be claimed** until canonical proposed input
  schemas are frozen and hashed (canonical JSON → SHA-256 per §17.3 binding
  identity: `connectorInstanceId/serverId/kind/version` + exact upstream names
  + canonical input-schema hash; mismatch disables binding).
- SDK candidate: **NOT ADOPTED** — no `initialize`/`tools-list` spike; pinning
  `@modelcontextprotocol/sdk@1.30.0` or `@modelcontextprotocol/client@2.0.0`
  is explicitly out of scope here.

## 4. Tests

- Fake tests (CI, post-gate, no credentials): lazy connect; startup never
  blocked; demand reconnect backoff 1/2/5/10/max30; no logical resend;
  concurrency-1; shell=false/config-only-cmd/env-allowlist/stderr-cap/
  shutdown-wait; loopback+redirect-refuse; allowlist non-exposure; binding
  identity mismatch disables; no-writes; structuredContent-first + strict
  fallback reject + no prose heuristics; exact `calendar.search` bounds
  (start<end, ≤90d, limit 10/20, one page); privacy exclusions; canonical key
  `connector+calendarId+eventId`; revision precedence with etag-missing
  fallback; tombstone only on authoritative get/refresh (search-omission
  creates none); frozen temporal reuse across Retry; ToolBroker budget/dedup/
  timeout/audit + fixed codes.
- Optional manual read-only verification checklist (requires SEPARATE user
  approval + dedicated test calendar + readonly grant; NOT run here):
  1) fresh readonly OAuth consent shows events/calendarlist-readonly scope only;
  2) `list-calendars` ok; 3) `list-events` one page + `nextPageToken` round-trip;
  4) `search-events` q+window; 5) `get-event` 404 path; 6) write tool absent
  from `tools/list`; 7) stderr/log grep shows no tokens.

## 5. Assumptions / evidence links

- Tree + file contents verified via bounded HTTP-200 raw/GitHub API reads at
  pinned SHA (evidence §1). Registry/SDK numbers from prior spike (metadata
  only). Google API 404/`cancelled`/`showDeleted`/410-sync semantics from
  public reference links above (content unexecuted, no live call).
- Assumes fork owner assigns a version + changelog for P3/P6/P7 deltas and
  publishes scope-justification for `calendarlist.readonly`.

## 6. Next bounded code objective (no credentials, post-design)

Write a **fake-only** Vitest spec + contract stub asserting the §17.4
`calendar.search` input bounds and the response normalizer's privacy/revision
mapping against **hand-written fixtures shaped like §3** (no SDK import, no
network, no upstream code copy): proves the Companion-side contract seam the
server patch must plug into, and is the prerequisite spike artifact before any
real server adoption. Needs: orchestrator approval to create stub files under
`packages/contracts` (currently blocked by §17.2 gate) OR direction to keep
fixtures docs-only.

## 7. Remaining external ownership decision (for orchestrator/user)

Approve (a) scoped external patch/fork of `nspady/google-calendar-mcp@7c788f5`
implementing P1+P2+P3+P6+P7 with readonly re-consent + version bump, owned
outside Companion packages — or (b) alternative upstream already read-only
with pagination + authoritative get. Until decided: no SDK pin, no binding
identity, no implementation.
