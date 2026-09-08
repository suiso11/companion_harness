/**
 * Proposed versioned binding (NOT adopted upstream).
 *
 * Inspected base: nspady/google-calendar-mcp @ 7c788f58 (working tree only,
 * not a release pin; latest tag observed v2.6.3, unverified). The four
 * connector-internal operations below (list-calendars / list-events /
 * search-events / get-event) plus the P3 paging delta (single-calendar
 * opaque pageToken, limit<=20 one page) and P7 etag threading exist ONLY in
 * the PROPOSED external patch/fork (docs/...design.md P1–P9). The only
 * model-exposed tool is `calendar.search` (single tool); upstream tools/list
 * is never auto-exposed.
 *
 * Adoption gate (remaining, external): a versioned fork/release implementing
 * P1+P2+P3+P6+P7 with readonly re-consent, OR an alternative upstream that
 * is already read-only with pagination + authoritative get. Until then:
 * no SDK pin implies no live binding; these names/hashes bind the PROPOSED
 * surface for fake tests only and MUST NOT be cited as upstream compat.
 */
export const PROPOSED_BINDING = {
  baseUpstream: "nspady/google-calendar-mcp",
  baseCommit: "7c788f58e8b00db66ddd0eccd81fdc3dda0ecf9b",
  proposedForkVersion: "0.0.0-proposed.1",
  modelTool: "calendar.search",
  connectorOperations: [
    "list-calendars",
    "list-events",
    "search-events",
    "get-event",
  ],
  excludedUpstreamTools: [
    "create-event",
    "create-events",
    "update-event",
    "delete-event",
    "respond-to-event",
    "manage-accounts",
    "get-freebusy",
    "get-current-time",
    "list-colors",
  ],
} as const;
