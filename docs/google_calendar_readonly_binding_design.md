# Google Calendar LOCAL readonly MCP binding — patch design (profile adopted; live acceptance pending)

Status (CURRENT): the host-owned pinned profile `google-readonly`
(`apps/server/src/calendarReadonlyProfile.ts`, strict opt-in
`COMPANION_CALENDAR_PROFILE`) ADOPTS the reviewed `3.0.0-readonly.2`
candidate (`6939311…`) as the normal-startup composition. The §1–§7 design
record below is HISTORICAL (proposal-era, `nspady@7c788f5` / `97a3dc3`);
the CURRENT adoption pin, run/auth contract, and credential-free proof are
`docs/operations.md` (C14 profile) and
`docs/evidence/calendar-readonly-profile/smoke-profile.result.json`.
The proof artifacts cover the runtime side only (wire identity + live-wire
hashes + behavior); the full commit/tree/lock verification before
`npm ci --ignore-scripts` + `npm run build` is the documented installation
prerequisite, not something the runtime re-verifies.
Profile-adopted is the CURRENT accepted activation: a live read-only
conversation completed end to end and live server health was observed on
2026-10-14 (ledger in `docs/operations.md`, "Live readonly acceptance
ledger"; sanitized counts/codes only). Still pending and NOT claimed:
fresh consent-screen display re-observation, Windows 11 manual smoke,
positive deletion evidence (C11-01 BLOCKED), and M5 live/write gates.

Status (CURRENT, PR23 review fixes): (1) the profile/config linkage
(frozen selector, completeness, injected conflicts, exact hint
compatibility) resolves synchronously BEFORE any DB side effect, so a
failing profile creates no DB file/dir and leaves older DBs byte-identical;
(2) the optional profile `selection.account` is pinned to
`^[a-z0-9_-]{1,64}$` (omitted valid; generic non-profile contract
unchanged); (3) the profile persists under the boring dedicated display
name `calendar-mcp-google-readonly` (never generic `calendar-mcp`), so old
generic rows/targets cannot be reused or refreshed via Google
(`reference_not_found`). No kernel migration; no live-Google claim.

Status (HISTORICAL): **design-only proposal; C08 runtime evidence recorded (2026-10-11)**.
No Companion code changed; no SDK package adopted; no OAuth grant and no live
access. The pinned candidate fork `97a3dc3` now has a credential-free
`initialize`/`tools-list` proof and an exact pin form (full SHA + lock
digest), but **FORMAL ADOPTION = HOLD / NOT ADOPTED** and M4 remains **not
implemented**; §17 contracts unchanged. Companion-side plan source:
`docs/implementation_plan.md` §17 (agreed). Authoritative exact-hash table and
full evidence: `docs/m4_dependency_spike.md` "C08 exact pinned binding +
runtime evidence" (§ "C08-01..08 decision matrix"; versioned, reproducible
9-artifact snapshot
[`docs/evidence/c08/2026-10-11/c08-evidence.tar.gz`](evidence/c08/2026-10-11/c08-evidence.tar.gz),
archive SHA-256
`52b63fee169394b74c8827a04022ca454d1fa82d8b5de935702c574914db0d94`). Prior
branch/status lines below are historical and superseded by §8.

Historical branch label: `feat/m4-mcp-spike`.

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
  handlers of the nspady `7c788f5` tree (paths recorded from imports; bodies
  not re-fetched for that SHA). The `structuredContent-first` claim for those
  bodies stays **UNVERIFIED for `7c788f5`** — the original upstream source was
  not newly executed. **C08 verification for the pinned fork SHA `97a3dc3`
  (2026-10-11):** the fork builder body was executed and read at
  `https://github.com/suiso11/google-calendar-mcp/blob/97a3dc36873b8f52870695d7706d182d5a8fc401/src/utils/response-builder.ts#L16-L23`
  — `createStructuredResponse` returns
  `content: [{type:"text", text: JSON.stringify(data)}]` with **no
  `structuredContent`**, and all four real tool calls returned content text
  JSON only. Do not generalize this fork result to `7c788f5`.

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

### P6 — Authoritative get: NO showDeleted on get; deletion boundary (C11-01 BLOCKED)
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
  signal, not per-event deletion evidence; it is unhandled in
  `BaseToolHandler`, so an upstream `isError` response for it collapses to
  the consumer's fixed `calendar_upstream_error`, while a THROWN JSON-RPC
  protocol error collapses to the distinct fixed `mcp_unavailable`. Neither
  path is deletion proof and no actual upstream HTTP status is observable
  through `CallResult`.
  `status:'cancelled'` alone — including via list `showDeleted` — is NOT
  deletion proof: cancelled recurring instances/exceptions need recurrence
  identity semantics before any Snapshot mapping.
- PROPOSED rule (minimal, safe): a `deleted` Snapshot status requires
  operation-specific evidence AND a prior-known resource observed on an
  accessible calendar through an authoritative read (get/list with the
  operation's documented deleted-visibility params). Ambiguous
  errors/missing entries map to fixed `calendar_upstream_error` with NO
  deletion. **Search omission NEVER creates a tombstone** (§17.5).
- Deletion boundary (CURRENT, C11 `feat/c11-calendar-deletion-evidence`):
  the earlier unverified `classifyDeletion` / `DeletionVerdict` stub — which
  only switched on the proposed `get-tombstone` / `list-showDeleted-tombstone`
  labels and was never reachable from any producer — was **REMOVED**, and no
  always-unknown / no-op / alias / deprecated replacement API was added. The
  boundary is now enforced directly by the consumer decoders
  (`normalizeGetResult` / `normalizeSearchResult`): a raw `deleted` status is
  rejected as `calendar_response_invalid`; unknown `deleted` / `tombstone`
  hint flags are stripped; `cancelled` stays `cancelled`; a one-page search
  omission returns the opaque cursor; and `isError` / thrown SDK errors
  surface as the fixed redacted codes. None creates a tombstone. Upstream
  `status` strings (`confirmed`/`tentative`/`cancelled`) map to Snapshot
  `status` (`confirmed`/`tentative`/`cancelled`); `deleted` still has NO
  operation-specific authoritative mapping rule and **C11-01 remains
  BLOCKED** (no proven positive contract).

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
  fallback; deletion boundary over the genuine SDK wire (cancelled stays a
  status; `isError` → `calendar_upstream_error`; thrown RPC →
  `mcp_unavailable`; one-page search omission returns the opaque cursor; raw
  `deleted` → `calendar_response_invalid`; unknown tombstone flags stripped;
  no case creates a tombstone); frozen temporal reuse across Retry; ToolBroker budget/dedup/
  timeout/audit + fixed codes.
- Optional manual read-only verification checklist (requires SEPARATE user
  approval + dedicated test calendar + readonly grant; NOT run here):
  1) fresh readonly OAuth consent shows events/calendarlist-readonly scope only;
  2) `list-calendars` ok; 3) `list-events` one page + `nextPageToken` round-trip;
  4) `search-events` q+window; 5) `get-event` 404 path; 6) write tool absent
  from `tools/list`; 7) stderr/log grep shows no tokens.

  Current-profile mapping (2026-10-14; `readonly.2` deliberately removes the
  `list-calendars` / `calendarlist` scope — row 2 is INTENTIONALLY
  UNAVAILABLE and must not be restored to satisfy this proposal-era list):
  1) static pin ACCEPTED (`calendar.events.readonly` only) + user OAuth
  COMPLETED with authenticated live reads OBSERVED; only live
  consent-screen scope display remains unobserved (never a missing-consent
  claim, never force reconsent); 2) unavailable by design; 3) ACCEPTED
  (one-page verbatim cursor); 4) ACCEPTED (live `calendar.search`
  succeeded); 5) PARTIAL (miss → fixed `calendar_upstream_error`, never a
  tombstone; positive BLOCKED); 6) ACCEPTED (events-only 3-tool surface,
  actions disabled); 7) ACCEPTED by construction. Live
  `reference.refresh` OBSERVED 2026-10-14 (real list 10 with cursor +
  page2/query + real `get-event` refresh snapshot 10->11, new rN, prior
  rN retained, privacy exclusions 0; fake-E2E-only status is HISTORICAL).
  Full ledger: `docs/operations.md` ("Live readonly acceptance ledger").

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

## 8. C08 exact fork runtime evidence (2026-10-11, c08-decision-docs)

Status of this section: evidence record. Formal adoption remains **HOLD /
NOT ADOPTED**. The prior 2026-09-09 "scoped fork protocol evidence" record
(branch `feat/m4-readonly-fork-adoption`, `97a3dc3` recorded as a short-SHA
protocol reference only) is **explicitly superseded** by this exact-pin +
runtime record; the older `nspady@7c788f5` design remains historical and was
not re-executed.

- Candidate: fork `suiso11/google-calendar-mcp@97a3dc3` full SHA
  `97a3dc36873b8f52870695d7706d182d5a8fc401`, tree `ae743a8bd7cc7002c2368618fbe098dba8af341e`,
  private version `3.0.0-readonly.1`, exact SDK `1.30.0` at runtime. The
  spike doc holds the **authoritative exact table** of the four canonical
  input-schema hashes (all historical-match true) — linked, not repeated here.
- Actual mapping (fork `97a3dc3` source line citations verified by execution):
  `src/server.ts#L102-L103` `serverInfo` name/version;
  `src/tools/registry.ts#L783/L791/L813/L821` four read tools;
  `src/handlers/core/ListCalendarsHandler.ts#L94` `calendarList.list`;
  `src/handlers/core/ListEventsHandler.ts#L78-L88` and
  `src/handlers/core/SearchEventsHandler.ts#L79-L90` `calendar.events.list`
  with `maxResults`/`pageToken` passthrough (the P3 pagination delta is
  present: `nextPageToken` is returned);
  `src/handlers/core/GetEventHandler.ts#L57` `calendar.events.get`;
  `src/utils/response-builder.ts#L16-L23` content-text-only response.
- Mapping to Companion `calendar.search` at the candidate MCP layer:
  `start→timeMin`, `end→timeMax`, frozen Turn IANA `timeZone→timeZone`,
  `limit→pageSize`, `query→query`, `cursor→pageToken` with opaque-in →
  opaque-out; one provider call per list/search, one page. The candidate
  HANDLER (not Companion) translates `pageSize→Google maxResults` and
  `query→Google q` — the observed provider parameter is `maxResults: 10`, and
  Companion never emits `maxResults`/`q`. Proposed **Companion** mapping.
  `list-calendars` →
  `{calendars,totalCount:1}`, `list-events` → `{events,totalCount:2,nextPageToken}`,
  `search-events` → `{events,totalCount:2,query,calendarId,nextPageToken,timeRange}`,
  `get-event` → `{event}` (single timed event). `etag` preserved; raw
  `start`/`end` are objects (`{dateTime?,date?}`); privacy fields pass through
  as the inert fixture returns them (no field-mask claim).
- Consumer gap (HISTORICAL C08 fact, pre-C10): at the C08 probe revision
  `packages/connector-calendar/src/normalize.ts` `proposedUpstreamEventSchema`
  typed `start`/`end` as flat strings and **rejected** the actual timed and
  all-day object wire shapes. Retained archive fact, superseded on this branch:
  the C10 consumer now validates the REAL nested `{dateTime?,date?,timeZone?}`
  endpoints and no longer contains that flat schema. See the C10 consumer
  section below.
- Scope conflict (static, not observed live): official `calendarList.list`
  authorization accepts `calendar.readonly`/`calendar`/`calendar.calendarlist`/
  `calendar.calendarlist.readonly` but **not** `calendar.events.readonly`,
  while fork `src/auth/scopes.ts#L2-L7` allows ONLY `calendar.events.readonly`
  and rejects broader grants. Resolution needs a scoped fork follow-up /
  narrow-call-strategy decision plus a separate read-only live opt-in; no
  scope expansion is approved here.
- `get-event` on a missing id returns a generic MCP error (`isError:true`,
  `-32603`) — consistent with P6; it is **not** deletion evidence and C11 is
  untouched.
- C08-01..08 decision matrix and adoption gates: see the spike doc C08 section
  (authoritative). Summary: 01–06 and 08 recorded complete; **C08-07 decision
  selected** — the logical `serverId` is **not** the wire `serverInfo.name`;
  the expected wire identity `{name: "google-calendar", version:
  "3.0.0-readonly.1"}` (for full SHA `97a3dc3` + lock digest) must come from
  the explicit trusted binding definition and be compared **before enable**,
  with missing/any mismatch disabling all bindings of that connector instance.
  That C08 runtime observation ("the connector enforced neither version nor
  expected wire identity") is a **HISTORICAL** pre-PR16/17 fact. The merged
  master C09 guard **implements** it: `mcpConnectorConfigSchema` requires an
  explicit trusted `expectedServerName` + `version`, and `client.ts` compares
  the REAL `initialize.serverInfo` name/version exactly (fail-closed, all
  bindings disabled on mismatch) before any `tools/list`. The C08 identity-gap
  is no longer a current behavior. Formal production adoption stays gated on
  the external versioned-fork/pin gate and the **C10-08 production mapping
  gate**, with C11 deletion evidence as a separate gate. C09/C10 implementation
  work does not equal adoption. Full semantics live in the spike doc; this
  summary is brief and non-authoritative.

## 9. C10 consumer implementation (this branch, adoption still HOLD)

Status: **source patch complete; consumer behaviors implemented; formal C08
adoption remains HOLD / NOT ADOPTED.** This records what the consumer code can
now do against the retained candidate bodies — NOT a live-Google, fork
compatibility or adoption claim.

- Response seam: `packages/connector-calendar` owns
  `normalizeSearchResult(result, options)` / `normalizeGetResult(result,
  options)` over the merged `CallResult`. `structuredContent` is selected by
  OWN-PROPERTY presence; a present (even `null`/`undefined`/wrong-shaped) value
  is the ONLY source and is never rescued by `text`. Only an ABSENT
  `structuredContent` permits parsing the ENTIRE `text` as strict JSON (no
  fences, prose, prefix/suffix scanning). Incoming fixed MCP failure codes are
  preserved; any decode failure is the fixed `calendar_response_invalid`.
- Root envelopes are exact and strict per operation (`list-events` vs
  `search-events` via an explicit `operation` option; `get-event` is `{event}`,
  never a page). `totalCount` must equal the PAGE `events.length`; a page over
  the requested limit (`1..20`) is rejected, never sliced. Cross-calendar raw
  ids are rejected; no per-event id/calendarId is derived from the root.
- Event projection: nested endpoint union `{dateTime?,date?,timeZone?}` with
  exactly one of `date`/`dateTime`; all-day DATE strings are unchanged and
  end-exclusive; explicit-offset timed instants are canonicalized to UTC. The
  seven privacy keys (`creator`/`attendees`/`organizer`/`conferenceData`/
  `hangoutLink`/`htmlLink`/`extendedProperties`) plus all unknown extras,
  `accountId`, page metadata and source identifiers are stripped and never
  enter the snapshot or hash. Allowed `title`/`description`/`location` plaintext
  may itself contain emails/URLs — no general free-text redaction is claimed.
- Revision precedence is unchanged: non-empty `etag` > canonical
  `updated` > normalized-projection hash (post truncation/temporal
  canonicalization). `canonicalKey` remains `SHA-256(JSON([connectorInstanceId,
  calendarId, eventId]))`.
- Candidate fraction gap (explicit): the candidate source regex accepts only
  WHOLE-second `Z`/`±HH:MM` datetimes, while the agreed consumer input contract
  keeps fractional-second ISO precision (the exact 90d+1ms boundary relies on
  it). This mapper must NOT silently truncate/round/narrow, so this remains an
  explicit **candidate compatibility gap and additional adoption HOLD** — no
  full-fork-compatibility claim.
- **C10-08 production mapping gate (UNRESOLVED):** no adopted
  `McpBindingDefinition`/pin/profile/OAuth/live-Google wiring exists; the
  candidate mapping is proven only against the retained synthetic-provider
  archive, not against an adopted production binding. C10 consumer-readiness is
  NOT profile-connected/adopted status.
