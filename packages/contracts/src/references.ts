import { z } from "zod";
import { Sha256HexSchema, UnixMsSchema, UuidSchema } from "./ids.js";

/* ------------------------------------------------------------------ */
/* Unicode code points (not UTF-16 units)                               */
/* ------------------------------------------------------------------ */

/**
 * Count Unicode code points (not JS UTF-16 `length`). All M1 query/snippet
 * bounds are expressed in code points (§14.6 exact), so astral characters
 * (e.g. emoji) count once.
 */
export function countCodePoints(value: string): number {
  return Array.from(value).length;
}

/* ------------------------------------------------------------------ */
/* Exact M1 Markdown search bounds (§14.6, exact)                        */
/* ------------------------------------------------------------------ */

/** Query bounds: 1-256 Unicode code points (exact, §14.6). */
export const MIN_SEARCH_QUERY_CODE_POINTS = 1 as const;
export const MAX_SEARCH_QUERY_CODE_POINTS = 256 as const;
/** Result count: default 10 / max 20 (exact, §14.6). */
export const DEFAULT_SEARCH_LIMIT = 10 as const;
export const MAX_SEARCH_LIMIT = 20 as const;
/** Snippet bound: max 512 Unicode code points (exact, §14.6). */
export const MAX_SNIPPET_CODE_POINTS = 512 as const;

/* ------------------------------------------------------------------ */
/* Freshness (§14.2, agreed)                                            */
/* ------------------------------------------------------------------ */

/**
 * Freshness semantics (exact order, §14.2): `normal` reuses the latest
 * Snapshot / same rN for identical revision/content and materializes a new
 * Snapshot + rN on change; `refresh` (explicit reread via the refresh tool
 * only) always creates a new observation Snapshot + new rN even when the
 * content is identical. `open` is stored-only and never rereads.
 */
export const FreshnessSchema = z.enum(["normal", "refresh"]);
export type Freshness = z.infer<typeof FreshnessSchema>;

/* ------------------------------------------------------------------ */
/* Canonical keys (no absolute paths)                                   */
/* ------------------------------------------------------------------ */

/**
 * Route-relative canonical key (realpath-derived, §14.3/§14.6).
 * Never an absolute path: no leading `/`, no backslashes, no NUL, no
 * Windows drive prefix, and no empty / `.` / `..` segments. Absolute paths
 * are never exposed via keys, API responses, or stored snapshots (§14.6).
 *
 * AMBIGUITY: the plan fixes "route-relative normalized key, no absolute
 * path" but no exact key grammar. This schema enforces the structural
 * minimum (relative POSIX segments, 1-512 chars); NFC normalization and
 * root-containment checks are connector/kernel concerns.
 */
function isRelativeCanonicalKey(key: string): boolean {
  if (key.includes("\0") || key.includes("\\")) return false;
  if (key.startsWith("/")) return false;
  if (/^[A-Za-z]:(\/|$)/.test(key)) return false;
  const segments = key.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") return false;
  }
  return true;
}

export const CanonicalKeySchema = z
  .string()
  .min(1)
  .max(512)
  .refine(isRelativeCanonicalKey, {
    message:
      "canonicalKey must be a route-relative key (no absolute path, no '..')",
  });
export type CanonicalKey = z.infer<typeof CanonicalKeySchema>;

/** Display-only title (first heading or file name; never identity). */
export const ReferenceTitleSchema = z.string().min(1).max(512);
export type ReferenceTitle = z.infer<typeof ReferenceTitleSchema>;

/** Upstream revision signal (content-derived for Markdown; NULL allowed). */
export const SourceRevisionSchema = z.string().min(1).max(256);
export type SourceRevision = z.infer<typeof SourceRevisionSchema>;

/* ------------------------------------------------------------------ */
/* SnapshotBody: versioned normalized full-text evidence (§4, §14.6)    */
/* ------------------------------------------------------------------ */

/**
 * Snapshot body version (implementation-level shape, currently 1 only).
 * Stored as `body_json` (`{ version: 1, text }`) in `resource_snapshots`.
 */
export const SNAPSHOT_BODY_VERSION = 1 as const;
/** Max normalized UTF-8 bytes for a Markdown snapshot body (exact, §14.6). */
export const MAX_SNAPSHOT_BODY_BYTES = 1_048_576 as const;

/**
 * UTF-8 byte length of a JS string (pure ES code-point walk, no DOM/Node
 * globals so contracts typecheck under `lib: ES2023` with no extra types).
 */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const unit of value) {
    const point = unit.codePointAt(0) ?? 0;
    if (point < 0x80) bytes += 1;
    else if (point < 0x800) bytes += 2;
    else if (point < 0x10000) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

/**
 * Strict versioned normalized full-text evidence (implementation-level
 * shape `{ version: 1, text }`, §4 + §14.6). `text` is the NFC-normalized
 * Markdown full text; UTF-8 byte count must fit 1MiB with no silent
 * truncation (oversize inputs are rejected, never cut). Empty text is
 * allowed (an empty normalized file is still immutable evidence).
 */
export const SnapshotBodySchema = z.strictObject({
  version: z.literal(SNAPSHOT_BODY_VERSION),
  text: z
    .string()
    .refine((text) => text === text.normalize("NFC"), {
      message: "snapshot body text must be NFC-normalized",
    })
    .refine((text) => utf8ByteLength(text) <= MAX_SNAPSHOT_BODY_BYTES, {
      message: "snapshot body must fit 1MiB UTF-8 without truncation",
    }),
});
export type SnapshotBody = z.infer<typeof SnapshotBodySchema>;

/* ------------------------------------------------------------------ */
/* CanonicalResource summary / detail (§14.2-§14.3)                      */
/* ------------------------------------------------------------------ */

export const CanonicalResourceSummarySchema = z.strictObject({
  id: UuidSchema,
  canonicalKey: CanonicalKeySchema,
  title: ReferenceTitleSchema.nullable(),
});
export type CanonicalResourceSummary = z.infer<
  typeof CanonicalResourceSummarySchema
>;

export const CanonicalResourceDetailSchema = z.strictObject({
  id: UuidSchema,
  connectorInstanceId: UuidSchema,
  canonicalKey: CanonicalKeySchema,
  title: ReferenceTitleSchema.nullable(),
  nextRevision: z.number().int().min(1),
  createdAt: UnixMsSchema,
});
export type CanonicalResourceDetail = z.infer<
  typeof CanonicalResourceDetailSchema
>;

/* ------------------------------------------------------------------ */
/* ResourceSnapshot summary / detail (immutable, no body text)          */
/* ------------------------------------------------------------------ */

/**
 * Snapshot summaries/details carry structural identity + integrity fields
 * only (integer `revision`, `source_revision`, `content_hash`, sizes,
 * timestamps). The normalized full-text record (`SnapshotBody`,
 * `{ version: 1, text }`, stored as `body_json`) is exposed only through
 * the stored reference detail API and the `reference.open` /
 * `reference.refresh` tool outputs below, never through summaries, search
 * hits, or `reference.presented`, so those cannot leak content.
 */
export const ResourceSnapshotSummarySchema = z.strictObject({
  id: UuidSchema,
  resourceId: UuidSchema,
  revision: z.number().int().min(1),
  sourceRevision: SourceRevisionSchema.nullable(),
  contentHash: Sha256HexSchema,
  sizeBytes: z.number().int().min(0),
  observedAt: UnixMsSchema,
});
export type ResourceSnapshotSummary = z.infer<
  typeof ResourceSnapshotSummarySchema
>;

export const ResourceSnapshotDetailSchema = z.strictObject({
  id: UuidSchema,
  resourceId: UuidSchema,
  revision: z.number().int().min(1),
  sourceRevision: SourceRevisionSchema.nullable(),
  contentHash: Sha256HexSchema,
  sizeBytes: z.number().int().min(0),
  observedAt: UnixMsSchema,
  createdAt: UnixMsSchema,
});
export type ResourceSnapshotDetail = z.infer<
  typeof ResourceSnapshotDetailSchema
>;

/* ------------------------------------------------------------------ */
/* SessionReference (rN) summary / detail                                */
/* ------------------------------------------------------------------ */

export const SessionReferenceSummarySchema = z.strictObject({
  id: UuidSchema,
  ordinal: z.number().int().min(1),
  resourceId: UuidSchema,
  snapshotId: UuidSchema,
});
export type SessionReferenceSummary = z.infer<
  typeof SessionReferenceSummarySchema
>;

export const SessionReferenceDetailSchema = z.strictObject({
  sessionId: UuidSchema,
  id: UuidSchema,
  ordinal: z.number().int().min(1),
  resourceId: UuidSchema,
  snapshotId: UuidSchema,
  createdAt: UnixMsSchema,
});
export type SessionReferenceDetail = z.infer<
  typeof SessionReferenceDetailSchema
>;

/* ------------------------------------------------------------------ */
/* ReferenceSet summary / detail (ordered)                              */
/* ------------------------------------------------------------------ */

export const ReferenceSetItemSchema = z.strictObject({
  ordinal: z.number().int().min(1),
  referenceId: UuidSchema,
});
export type ReferenceSetItem = z.infer<typeof ReferenceSetItemSchema>;

export const ReferenceSetSummarySchema = z.strictObject({
  sessionId: UuidSchema,
  id: UuidSchema,
  createdAt: UnixMsSchema,
});
export type ReferenceSetSummary = z.infer<typeof ReferenceSetSummarySchema>;

/**
 * Ordered set detail. `items` preserves presentation order; set/reference
 * session ownership (same-Session composite FK) is enforced repository-side.
 */
export const ReferenceSetDetailSchema = z.strictObject({
  sessionId: UuidSchema,
  id: UuidSchema,
  createdAt: UnixMsSchema,
  items: z.array(ReferenceSetItemSchema),
});
export type ReferenceSetDetail = z.infer<typeof ReferenceSetDetailSchema>;

/* ------------------------------------------------------------------ */
/* Session reference context (versioned CAS, `{ version, items }`)       */
/* ------------------------------------------------------------------ */

/**
 * Session reference context: the UI's implicit selection, persisted per
 * session and updated via optimistic-version CAS (§14.2-§14.3, §14.8).
 * `items` is the ordered list of SessionReference ids. Every element must
 * belong to the path Session; the repository validates membership (it
 * cannot be a DB FK because `items` is JSON).
 *
 * AMBIGUITY: the plan fixes `{ version, items }` + CAS but no bound on the
 * number of selected items, so none is enforced here.
 */
export const ReferenceContextVersionSchema = z.number().int().min(1);
export type ReferenceContextVersion = z.infer<
  typeof ReferenceContextVersionSchema
>;

export const ReferenceContextItemsSchema = z.array(UuidSchema);
export type ReferenceContextItems = z.infer<typeof ReferenceContextItemsSchema>;

/** GET /reference-context response (stored-only, §14.8). */
export const ReferenceContextGetResponseSchema = z.strictObject({
  version: ReferenceContextVersionSchema,
  items: ReferenceContextItemsSchema,
});
export type ReferenceContextGetResponse = z.infer<
  typeof ReferenceContextGetResponseSchema
>;

/** PUT /reference-context request: expected version + new selection (CAS). */
export const ReferenceContextPutRequestSchema = z.strictObject({
  version: ReferenceContextVersionSchema,
  items: ReferenceContextItemsSchema,
});
export type ReferenceContextPutRequest = z.infer<
  typeof ReferenceContextPutRequestSchema
>;

/** PUT /reference-context response: the committed version + selection. */
export const ReferenceContextPutResponseSchema = z.strictObject({
  version: ReferenceContextVersionSchema,
  items: ReferenceContextItemsSchema,
});
export type ReferenceContextPutResponse = z.infer<
  typeof ReferenceContextPutResponseSchema
>;

/* ------------------------------------------------------------------ */
/* Stored-only API responses (§14.8: stored GETs only)                   */
/* ------------------------------------------------------------------ */

/**
 * M1 reference HTTP surface is session-scoped stored-only GETs plus
 * reference-context GET/PUT. There are deliberately NO direct search /
 * open / refresh / related HTTP POST contracts: those operations are
 * ToolBroker tools callable only from inside a running Run (§14.5).
 */

export const ReferenceParamsSchema = z.strictObject({
  sessionId: UuidSchema,
  referenceId: UuidSchema,
});
export type ReferenceParams = z.infer<typeof ReferenceParamsSchema>;

export const ReferenceSetParamsSchema = z.strictObject({
  sessionId: UuidSchema,
  setId: UuidSchema,
});
export type ReferenceSetParams = z.infer<typeof ReferenceSetParamsSchema>;

/** GET /references: stored session references (no events/grants created). */
export const ReferenceListResponseSchema = z.strictObject({
  items: z.array(SessionReferenceSummarySchema),
});
export type ReferenceListResponse = z.infer<typeof ReferenceListResponseSchema>;

/**
 * GET /references/:referenceId: stored detail (stored-only, §14.8).
 * Exposes the saved full normalized evidence (`body`) for the citation
 * drawer. No external read and no new Snapshot/Event/Grant is created.
 */
export const ReferenceDetailResponseSchema = z.strictObject({
  reference: SessionReferenceDetailSchema,
  resource: CanonicalResourceSummarySchema,
  snapshot: ResourceSnapshotSummarySchema,
  body: SnapshotBodySchema,
});
export type ReferenceDetailResponse = z.infer<
  typeof ReferenceDetailResponseSchema
>;

/** GET /reference-sets/:setId: stored ordered set (stored-only, §14.8). */
export const ReferenceSetDetailResponseSchema = z.strictObject({
  set: ReferenceSetDetailSchema,
  references: z.array(SessionReferenceSummarySchema),
});
export type ReferenceSetDetailResponse = z.infer<
  typeof ReferenceSetDetailResponseSchema
>;

/* ------------------------------------------------------------------ */
/* Markdown / reference tool inputs + outputs (ToolBroker only)         */
/* ------------------------------------------------------------------ */

/**
 * M1 tool names. `markdown.search` is exact (§14.5); the kernel reference
 * tools are `reference.open` / `reference.refresh` / `reference.related`.
 *
 * AMBIGUITY: the plan writes the kernel tools as `kernel reference.open`
 * (with a space), which cannot satisfy the M0 `namespace.verb` ToolName
 * rule (§9 blocker 6). Contracts normalize them to `reference.*` in
 * `namespace.verb` form; `kernel` denotes their origin (kernel-only
 * ToolBroker tools with no direct HTTP POST, §14.5), not a namespace.
 */
export const M1_TOOL_NAMES = [
  "markdown.search",
  "reference.open",
  "reference.refresh",
  "reference.related",
] as const;
export type M1ToolName = (typeof M1_TOOL_NAMES)[number];
export const M1ToolNameSchema = z.enum(M1_TOOL_NAMES);

/** Search query: 1-256 Unicode code points (exact, §14.6). */
export const SearchQuerySchema = z.string().refine(
  (query) => {
    const size = countCodePoints(query);
    return (
      size >= MIN_SEARCH_QUERY_CODE_POINTS &&
      size <= MAX_SEARCH_QUERY_CODE_POINTS
    );
  },
  { message: "query must be 1-256 Unicode code points" },
);
export type SearchQuery = z.infer<typeof SearchQuerySchema>;

/** Deterministic excerpt: 1-512 Unicode code points (exact, §14.6). */
export const SnippetSchema = z.string().refine(
  (snippet) => {
    const size = countCodePoints(snippet);
    return size >= 1 && size <= MAX_SNIPPET_CODE_POINTS;
  },
  { message: "snippet must be 1-512 Unicode code points" },
);
export type Snippet = z.infer<typeof SnippetSchema>;

/** Result-count bound shared by search/related: 1-20, default 10. */
export const SearchLimitSchema = z.number().int().min(1).max(MAX_SEARCH_LIMIT);
export type SearchLimit = z.infer<typeof SearchLimitSchema>;

/**
 * `markdown.search` input (ToolBroker only, no HTTP POST). Searches only
 * configured roots deterministically (whole-query literal substring,
 * NFC + locale-independent folding, title-exact > title-partial > body +
 * canonical-key tie-break, §14.6) and materializes one immutable full-text
 * Snapshot per hit. `freshness: "refresh"` bypasses dedup (cf. §9
 * blocker 6); search itself is discovery reads, never an explicit reread
 * of an already-referenced rN (that is `reference.refresh` only, §14.2).
 */
export const MarkdownSearchToolInputSchema = z.strictObject({
  query: SearchQuerySchema,
  limit: SearchLimitSchema.default(DEFAULT_SEARCH_LIMIT),
  freshness: FreshnessSchema.default("normal"),
});
export type MarkdownSearchToolInput = z.infer<
  typeof MarkdownSearchToolInputSchema
>;
export type MarkdownSearchToolInputInput = z.input<
  typeof MarkdownSearchToolInputSchema
>;

/** One persisted search hit: structural ids + display fields + snippet only. */
export const MarkdownSearchHitSchema = z.strictObject({
  referenceId: UuidSchema,
  ordinal: z.number().int().min(1),
  snapshotId: UuidSchema,
  resourceId: UuidSchema,
  canonicalKey: CanonicalKeySchema,
  title: ReferenceTitleSchema.nullable(),
  snippet: SnippetSchema,
});
export type MarkdownSearchHit = z.infer<typeof MarkdownSearchHitSchema>;

export const MarkdownSearchToolOutputSchema = z.strictObject({
  hits: z.array(MarkdownSearchHitSchema).max(MAX_SEARCH_LIMIT),
});
export type MarkdownSearchToolOutput = z.infer<
  typeof MarkdownSearchToolOutputSchema
>;

/** `reference.open` input: stored Snapshot only, never rereads (§14.2). */
export const ReferenceOpenToolInputSchema = z.strictObject({
  referenceId: UuidSchema,
});
export type ReferenceOpenToolInput = z.infer<
  typeof ReferenceOpenToolInputSchema
>;

/**
 * Stored-reference view shared by open/refresh outputs: structural ids +
 * display fields + snippet plus the saved full normalized body. Search hits
 * stay snippet-only; only open/refresh (and the stored detail API above)
 * carry `body`.
 */
export const StoredReferenceViewSchema = z.strictObject({
  referenceId: UuidSchema,
  ordinal: z.number().int().min(1),
  snapshotId: UuidSchema,
  resourceId: UuidSchema,
  canonicalKey: CanonicalKeySchema,
  title: ReferenceTitleSchema.nullable(),
  snippet: SnippetSchema,
  body: SnapshotBodySchema,
});
export type StoredReferenceView = z.infer<typeof StoredReferenceViewSchema>;

export const ReferenceOpenToolOutputSchema = StoredReferenceViewSchema;
export type ReferenceOpenToolOutput = z.infer<
  typeof ReferenceOpenToolOutputSchema
>;

/**
 * `reference.open` output returns the stored full body (stored-only, no
 * external read). `reference.refresh` output returns the newly saved full
 * body (the only reread path, always a new Snapshot + rN, §14.2).
 */

/**
 * `reference.refresh` input: the ONLY path that rereads an already
 * referenced rN, always yielding a new observation Snapshot + new rN even
 * when the content is unchanged (§14.2). Fixed refresh semantics, so no
 * `freshness` field is accepted.
 */
export const ReferenceRefreshToolInputSchema = z.strictObject({
  referenceId: UuidSchema,
});
export type ReferenceRefreshToolInput = z.infer<
  typeof ReferenceRefreshToolInputSchema
>;

export const ReferenceRefreshToolOutputSchema = StoredReferenceViewSchema;
export type ReferenceRefreshToolOutput = z.infer<
  typeof ReferenceRefreshToolOutputSchema
>;

/** `reference.related` input: stored link-graph only, never rereads. */
export const ReferenceRelatedToolInputSchema = z.strictObject({
  referenceId: UuidSchema,
  limit: SearchLimitSchema.default(DEFAULT_SEARCH_LIMIT),
});
export type ReferenceRelatedToolInput = z.infer<
  typeof ReferenceRelatedToolInputSchema
>;
export type ReferenceRelatedToolInputInput = z.input<
  typeof ReferenceRelatedToolInputSchema
>;

export const ReferenceRelatedEntrySchema = z.strictObject({
  referenceId: UuidSchema,
  ordinal: z.number().int().min(1),
  snapshotId: UuidSchema,
  resourceId: UuidSchema,
  canonicalKey: CanonicalKeySchema,
  title: ReferenceTitleSchema.nullable(),
});
export type ReferenceRelatedEntry = z.infer<typeof ReferenceRelatedEntrySchema>;

export const ReferenceRelatedToolOutputSchema = z.strictObject({
  references: z.array(ReferenceRelatedEntrySchema).max(MAX_SEARCH_LIMIT),
});
export type ReferenceRelatedToolOutput = z.infer<
  typeof ReferenceRelatedToolOutputSchema
>;

/* ------------------------------------------------------------------ */
/* reference.presented payload (structural IDs/ordinals only)           */
/* ------------------------------------------------------------------ */

/**
 * `reference.presented` payload: one event per presented reference. All
 * events of a multi-reference presentation share `setId`. Structural
 * IDs/ordinals ONLY — no snapshot body, snippet, title, content, or path
 * may appear here (audit journal carries digests/codes/ids, never content,
 * cf. §12.4). Strict: those content keys are rejected.
 *
 * AMBIGUITY: the plan introduces `reference.presented` as the single new
 * non-final M1 event persisted atomically with Resource / Snapshot /
 * SessionReference / ReferenceSet (§14.4) but fixes no exact payload shape.
 * Contracts adopt one-event-per-reference with the presenting set id.
 */
export const ReferencePresentedPayloadSchema = z.strictObject({
  setId: UuidSchema,
  referenceId: UuidSchema,
  ordinal: z.number().int().min(1),
  snapshotId: UuidSchema,
  resourceId: UuidSchema,
});
export type ReferencePresentedPayload = z.infer<
  typeof ReferencePresentedPayloadSchema
>;

/* ------------------------------------------------------------------ */
/* Reference-related fixed lowercase error codes                        */
/* ------------------------------------------------------------------ */

/**
 * Closed M1 reference error vocabulary: fixed lowercase codes (same policy
 * as §12.3). `reference_not_found` (unknown reference/set id),
 * `reference_version_conflict` (CAS version mismatch on context PUT),
 * `invalid_reference` (context items not in this session). Transport
 * status mapping (404 / 409 / 400) is a server concern, not contracts.
 * M0 `ApiErrorCodeSchema` is intentionally untouched.
 */
export const M1_REFERENCE_ERROR_CODES = [
  "reference_not_found",
  "reference_version_conflict",
  "invalid_reference",
] as const;
export type M1ReferenceErrorCode = (typeof M1_REFERENCE_ERROR_CODES)[number];
export const ReferenceErrorCodeSchema = z.enum(M1_REFERENCE_ERROR_CODES);
export type ReferenceErrorCode = z.infer<typeof ReferenceErrorCodeSchema>;

export const ReferenceApiErrorSchema = z.strictObject({
  error: z.strictObject({
    code: ReferenceErrorCodeSchema,
    message: z.string().min(1).max(500),
  }),
});
export type ReferenceApiError = z.infer<typeof ReferenceApiErrorSchema>;
