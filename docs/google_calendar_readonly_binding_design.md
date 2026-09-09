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

Base: `https://raw.githubusercontent.com/nspady/google-calendar-mcp/7c788f58e8b00db66ddd0eccd81fdc3dda0ecf9b/`

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
  The `structuredContent-first` claim for these builders is **unverified**
  (imports-only); Companion P4 MUST NOT cite it as evidence until the
  builder bodies are re-fetched at the pinned SHA.

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
- **Separately provisioned readonly credentials (one out-of-band step)**:
  new Google Cloud OAuth client (or new consent) for the readonly scope;
  **no auto-reuse of existing broad `calendar` tokens** — old token files
  must not be picked up (`TokenManager` path/account separation + docs
  migration note). Token refresh keeps the narrowed scope (Google
  down-scoping is not automatic on reuse).
- `manage-accounts` (list/add/remove) MUST NOT be registered in the readonly
  runtime build at all — including `list`. Account provisioning is a single
  out-of-band consent step, not a runtime model-reachable tool; there are no
  account-mutation tools in runtime. (Corrects prior draft contradiction
  that left the `add` flow "unchanged".)
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
  `delete-event`, `respond-to-event`) + `manage-accounts` (list/add/remove)
  MUST NOT be registered in the readonly build (not merely filtered
  client-side).
- External vs model-exposed surface (corrects prior "exposes only the four
  bindings" overstatement): the four upstream read tools are
  connector-internal operations only. The ONLY model-exposed Companion tool
  is `calendar.search` (single tool, §17.4); upstream `tools/list` is never
  auto-exposed to the model, and the four read tools are NOT individually
  model-reachable. `manage-accounts` has no model exposure in any form.

### P3 — Pagination: one upstream page + opaque pageToken (PROPOSED delta)
- Actual gap: `ListEventsHandler`/`SearchEventsHandler` never send/return
  `maxResults`/`pageToken`/`nextPageToken`; `*_response` types have no cursor.
  Actual handler additionally fans out multi-calendar via
  `BatchRequestHandler`, whose per-calendar raw `pageToken`s cannot be
  combined into one opaque cursor.
- PROPOSED versioned delta (fork minor bump; exact version assigned by fork
  owner): scope to a SINGLE configured `calendarId` per call; add optional
  input `pageToken: string` (opaque, passthrough only) and optional
  `pageSize` that MUST equal the Companion `limit` (hard one page,
  `<=20`); pass to `events.list({maxResults: pageSize, pageToken})` on that one
  calendar; return `nextPageToken?: string` verbatim in
  `ListEventsResponse`/`SearchEventsResponse`. Companion maps
  `nextPageToken` → §17.4 `cursor` (opaque, single page per
  `calendar.search` call, **no auto-pagination**). Never synthesize or parse
  the token. Multi-calendar batch + paging is explicitly OUT of scope for
  the cursor binding. Google reference (link only, content not executed):
  `https://developers.google.com/calendar/api/v3/reference/events/list`.

### P4 — structuredContent-first + strict JSON fallback (Companion side, §17.4)
- Upstream `createStructuredResponse` shape (imports-only, UNVERIFIED —
  builder body not re-fetched; see §1). Companion
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
  (IANA only), `limit→pageSize` (exact equality, hard one page `<=20`),
  `cursor→pageToken` (single configured calendar only). WITHOUT adopted P3
  there is NO M4 paging substitute: client-side cap + truncation note is
  explicitly REMOVED as an acceptable alternative — the paging gap stays
  open and no compatibility/gate claim may be made.

### P6 — Authoritative get: NO showDeleted on get; deletion classifier UNRESOLVED
- Actual: `GetEventHandler.getEvent` catches 404 → `null` → "not found" throw;
  `BaseToolHandler` has **no 410 branch** (falls to generic error).
  No `showDeleted` in the handler.
- CORRECTION (verified 2026-09-09 via bounded HTTP fetch of the official
  references; supersedes prior draft): `events.get` has NO `showDeleted`
  parameter — its only optional query params are
  `alwaysIncludeEmail/maxAttendees/timeZone`. `showDeleted` exists ONLY on
  `events.list` (returns `status:'cancelled'` entries; cancelled instances
  of recurring events appear under specific `showDeleted`+`singleEvents`
  combinations). The prior draft's "`getEvent` gains `showDeleted:true`"
  proposal is WITHDRAWN — do not invent a get option Google does not define.
  References (links only, no live call):
  `https://developers.google.com/workspace/calendar/api/v3/reference/events/get`,
  `https://developers.google.com/workspace/calendar/api/v3/reference/events/list`
  (410 Gone = expired `syncToken` → clear storage + full resync, NOT an
  event tombstone), errors guide reachable at
  `https://developers.google.com/workspace/calendar/api/guides/errors`.
- UNSAFE mappings REMOVED: a bare 404/410 on get/refresh NEVER yields a
  tombstone. 404 can mean not-found OR inaccessible (no access, wrong
  calendar, never existed). 410 is a list sync-token-expiry recovery
  signal, not per-event deletion evidence (and unhandled in
  `BaseToolHandler`, so any 410 surfaces as `calendar_upstream_error`).
  `status:'cancelled'` alone — including via list `showDeleted` — is NOT
  deletion proof: cancelled recurring instances/exceptions need recurrence
  identity semantics before any Snapshot mapping.
- PROPOSED rule (minimal, safe): a `deleted` Snapshot status requires
  operation-specific evidence AND a prior-known resource observed on an
  accessible calendar through an authoritative read (get/list with the
  operation's documented deleted-visibility params). Ambiguous
  errors/missing entries map to fixed `calendar_upstream_error` with NO
  deletion. **Search omission NEVER creates a tombstone** (§17.5).
- Deletion classifier: explicitly LEFT UNRESOLVED until verified against
  the official deleted-visibility semantics + a fork that actually threads
  them — NOT invented here. Upstream `status` strings
  (`confirmed`/`tentative`/`cancelled`) map to Snapshot `status`
  (`confirmed`/`tentative`/`cancelled`); `deleted` has NO mapping rule yet.

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
     fallback; tombstone only on operation-specific authoritative evidence for a
  prior-known resource (search-omission creates none; ambiguous errors →
  `calendar_upstream_error`, no deletion; classifier otherwise unresolved); frozen temporal reuse across Retry; ToolBroker budget/dedup/
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
  only). Google semantics verified 2026-09-09 via bounded HTTP fetch:
  `events.get` params contain NO `showDeleted`; `events.list` defines
  `showDeleted`/`pageToken`/`maxResults`/`nextPageToken`/`syncToken` with
  410-Gone sync-expiry resync rule; errors guide reachable (content
  paraphrased, no live call). Prior draft claims equating 404/410 or
  `cancelled`+`showDeleted` with deletion are withdrawn as unsafe.
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

## 8. Scoped fork protocol evidence (2026-09-09, record-fork-protocol-evidence)

Status of this section: evidence record only. Design remains
**NOT ADOPTED**; M4 remains not implemented; §17 contracts unchanged.

- User decision: **option A scoped fork selected/approved** (design §7 path
  (a); alternative-upstream path (b) not selected). Approval covers
  protocol-compatibility evidence recording only — **NOT adoption**.
- Candidate: fork `https://github.com/suiso11/google-calendar-mcp`, branch
  `feat/readonly-mode`, verified head `97a3dc3` (short SHA; protocol-evidence
  reference only — **not a release pin**).
- Candidate version: private `3.0.0-readonly.1`. **No tag, no GitHub release,
  no npm publication** — none claimed.
- SDK parity (verified fact): both sides exact
  `@modelcontextprotocol/sdk 1.30.0`.
- Verified protocol facts (credential-free stdio; **no OAuth flow and no
  Calendar tool call occurred**): stdio `initialize` + `tools/list` passed;
  server name/version reported (version `3.0.0-readonly.1`); `tools/list`
  returned exactly four tools: `get-event`, `list-calendars`, `list-events`,
  `search-events`.
- Deterministic canonical input-schema hashes (canonical JSON → SHA-256, per
  §17.3 binding identity; verified protocol facts, not adoption):
  - `get-event`: `f3212ecb17c3e45f69f7412b3a1e28cc4aaec770121925d23d31d4b699f73e89`
  - `list-calendars`: `ae9285fc8b0632942517f82ff5819be9152a14feaec7d11098eb9476e9eeb398`
  - `list-events`: `279887bf288ea036792c32c20a7a0b800d1a34cb371c8f161b546d12f683fcf3`
  - `search-events`: `027de2d89db1284173509eae71808575412461caca0f53aeb1085b011fe63167`
- Gates remaining (unresolved live/adoption claims): (a) fresh readonly
  `calendarList` scope behavior and the §4 live checklist (items 1–7) have
  NOT been run; (b) P6 deletion-semantics classifier remains UNRESOLVED —
  no tombstone/deletion mapping is adopted here; (c) no OAuth/Calendar tool
  call occurred, so **no live OAuth/Calendar compatibility is claimed**.
  Likewise **no release/tag/npm compatibility is claimed**.
