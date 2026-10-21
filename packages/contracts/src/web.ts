import { z } from "zod";
import { UuidSchema } from "./ids.js";
import { CanonicalKeySchema, countCodePoints } from "./references.js";

/**
 * Web search contracts (`web.search`, self-hosted SearXNG, §3-§9 of
 * docs/plan/web_search_design.md).
 *
 * PRIVACY: results are UNTRUSTED evidence. The serialized shapes below carry
 * only validated URLs (scheme allowlist http/https), bounded display fields
 * and structural ids. No upstream engine id, raw SearXNG payload, error text
 * or operator-level detail is representable here.
 */

/* ------------------------------------------------------------------ */
/* Exact bounds (§3: query 200; url ≤2048; title ≤256; snippet ≤512)   */
/* ------------------------------------------------------------------ */

/** Query bounds: 1-200 Unicode code points (exact, §3). */
export const MIN_WEB_QUERY_CODE_POINTS = 1 as const;
export const MAX_WEB_QUERY_CODE_POINTS = 200 as const;
/** Model-facing result cap: ≤8 (§3 top_k 1..8; default 5). */
export const DEFAULT_WEB_TOP_K = 5 as const;
export const MAX_WEB_TOP_K = 8 as const;
/** URL bound: max 2048 code units (§3). */
export const MAX_WEB_URL_UTF16_UNITS = 2048 as const;
/** Display title bound: max 256 Unicode code points (§3). */
export const MAX_WEB_TITLE_CODE_POINTS = 256 as const;

/** Freshness-independent time filter vocabulary (§3). */
export const WebTimeRangeSchema = z.enum(["day", "week", "month", "year"]);
export type WebTimeRange = z.infer<typeof WebTimeRangeSchema>;

/** The single model-visible web search tool name (namespace.verb, §3). */
export const WEB_SEARCH_TOOL_NAME = "web.search" as const;

/** `web.search` input (§3, closed schema; strict unknown-key rejection). */
export const WebSearchToolInputSchema = z.strictObject({
  query: z.string().refine(
    (query) => {
      const size = countCodePoints(query);
      return (
        size >= MIN_WEB_QUERY_CODE_POINTS && size <= MAX_WEB_QUERY_CODE_POINTS
      );
    },
    { message: "query must be 1-200 Unicode code points" },
  ),
  language: z
    .string()
    .refine(
      (value) => {
        const size = countCodePoints(value);
        return size >= 1 && size <= 16;
      },
      { message: "language must be 1-16 Unicode code points" },
    )
    .optional(),
  time_range: WebTimeRangeSchema.optional(),
  top_k: z.number().int().min(1).max(MAX_WEB_TOP_K).default(DEFAULT_WEB_TOP_K),
});
export type WebSearchToolInput = z.infer<typeof WebSearchToolInputSchema>;
export type WebSearchToolInputInput = z.input<typeof WebSearchToolInputSchema>;

/**
 * Result URL allowlist (§3): `http`/`https` only, ≤2048 UTF-16 units, no
 * whitespace or control characters. This is the CONTRACT-level structural
 * check; the connector re-parses with the URL grammar before persisting.
 * Everything else (javascript:, data:, file:, etc.) is discarded by the
 * connector before it can be persisted.
 */
export const WebResultUrlSchema = z.string().refine(
  (raw) => {
    if (raw.length > MAX_WEB_URL_UTF16_UNITS) return false;
    // biome-ignore lint/suspicious/noControlCharactersInRegex: result URLs are untrusted; control characters must be rejected by code point
    if (/[\u0000-\u001f\u007f-\u009f\s]/.test(raw)) return false;
    return /^https?:\/\//.test(raw);
  },
  { message: "web result url must be a bounded http(s) URL" },
);
export type WebResultUrl = z.infer<typeof WebResultUrlSchema>;

/** Bounded display title for one search hit (nullable, ≤256 code points). */
export const WebTitleSchema = z
  .string()
  .refine((title) => countCodePoints(title) <= MAX_WEB_TITLE_CODE_POINTS, {
    message: "web title must be ≤256 Unicode code points",
  });
export type WebTitle = z.infer<typeof WebTitleSchema>;

/** One persisted search hit: structural ids + validated URL + snippet. */
export const WebSearchHitSchema = z.strictObject({
  referenceId: UuidSchema,
  ordinal: z.number().int().min(1),
  snapshotId: UuidSchema,
  resourceId: UuidSchema,
  canonicalKey: CanonicalKeySchema,
  title: WebTitleSchema.nullable(),
  url: WebResultUrlSchema,
  snippet: z.string().min(1).max(512).nullable(),
});
export type WebSearchHit = z.infer<typeof WebSearchHitSchema>;

/**
 * `web.search` output: at most `top_k` (and always ≤8) hits. The container
 * key is `hits` — the same grantable shape as the M1 markdown search tool —
 * because evidence grants and ordinal addressability are derived from the
 * delivered broker payload via the shared `hits`/`references` visitor.
 */
export const WebSearchToolOutputSchema = z.strictObject({
  hits: z.array(WebSearchHitSchema).max(MAX_WEB_TOP_K),
});
export type WebSearchToolOutput = z.infer<typeof WebSearchToolOutputSchema>;

/* ------------------------------------------------------------------ */
/* Canonical web key (§5): versioned SHA-256 of the normalized URL      */
/* ------------------------------------------------------------------ */

/**
 * Versioned prefix for web canonical keys: `"web-v1-"` followed by hex.
 * Single relative segment (no leading `/`, no `..`), satisfying
 * `CanonicalKeySchema` without funneling the 2048-char URL through the
 * 512-char key bound.
 */
export const WEB_CANONICAL_KEY_PREFIX = "web-v1-" as const;

export const WebCanonicalKeySchema = CanonicalKeySchema.refine(
  (key) =>
    key.startsWith(WEB_CANONICAL_KEY_PREFIX) &&
    /^web-v1-[0-9a-f]{40,64}$/.test(key),
  {
    message:
      "web canonical key must be web-v1-<sha256 hex> of the normalized URL",
  },
);
export type WebCanonicalKey = z.infer<typeof WebCanonicalKeySchema>;

/** Derive the canonical key from a SHA-256 hex digest of the normalized URL. */
export function buildWebCanonicalKey(sha256Hex: string): WebCanonicalKey {
  return `${WEB_CANONICAL_KEY_PREFIX}${sha256Hex.toLowerCase()}`;
}

/* ------------------------------------------------------------------ */
/* COMPANION_WEB_SEARCH_JSON configuration (§9, fail-closed)            */
/* ------------------------------------------------------------------ */

/**
 * Default response byte cap for raw SearXNG bodies before JSON.parse (§7,
 * 1MiB). Connector-level; the kernel `maxNormalizedOutputBytesPerCall`
 * (256KiB) and the 64KiB model-facing cap stay separate.
 */
export const DEFAULT_WEB_MAX_RESPONSE_BYTES = 1_048_576 as const;
/** Hard ceiling for the configurable response byte cap. */
export const MAX_WEB_MAX_RESPONSE_BYTES = 8_388_608 as const;

/**
 * Strict opt-in configuration for `web.search` (§9). Default is OFF. The
 * base URL is fail-closed: `http`/`https` (plain http in production use),
 * loopback hosts only (127.0.0.0/8 · ::1 · localhost), no credentials, no
 * query string or fragment. Everything else is rejected at parse time.
 */
export const WebSearchConfigSchema = z
  .strictObject({
    enabled: z.boolean().default(false),
    searxng_base_url: z
      .string()
      .optional()
      .refine(
        (raw) => {
          if (raw === undefined) return true;
          return isValidLoopbackHttpUrl(raw);
        },
        {
          message:
            "searxng_base_url must be a loopback http(s) URL without credentials/query/fragment",
        },
      ),
    max_results: z.number().int().min(1).max(MAX_WEB_TOP_K).default(5),
    timeout_ms: z.number().int().min(1000).max(60_000).default(10_000),
    per_turn_budget: z.number().int().min(1).max(8).default(3),
    max_response_bytes: z
      .number()
      .int()
      .min(1024)
      .max(MAX_WEB_MAX_RESPONSE_BYTES)
      .default(DEFAULT_WEB_MAX_RESPONSE_BYTES),
  })
  .superRefine((value, ctx) => {
    if (value.enabled === true && value.searxng_base_url === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "enabled:true requires searxng_base_url",
        path: ["searxng_base_url"],
      });
    }
  });
export type WebSearchConfig = z.infer<typeof WebSearchConfigSchema>;

/**
 * Loopback http(s) URL validation WITHOUT the URL/DOM grammar (contracts
 * stay `lib: ES2023` pure): structural string checks only. The connector
 * re-parses the validated URL with the real URL API per fetch.
 */
export function isValidLoopbackHttpUrl(raw: string): boolean {
  if (typeof raw !== "string" || raw.length < 11 || raw.length > 256) {
    return false;
  }
  if (raw.includes("?") || raw.includes("#") || raw.includes("@")) {
    return false;
  }
  if (!/^https?:\/\//.test(raw)) {
    return false;
  }
  const rest = raw.slice(raw.indexOf("://") + 3);
  if (/\s/.test(rest)) return false;
  const authority = rest.split("/")[0] ?? "";
  if (authority.length === 0) return false;
  let hostname = authority.toLowerCase();
  // Bracketed/[port] and bare [port] handling; "is this an IPv6 spelling?"
  // is tracked separately because the charset rules differ below.
  let isV6 = false;
  if (hostname.startsWith("[")) {
    const close = hostname.indexOf("]");
    if (close === -1) return false;
    const after = hostname.slice(close + 1);
    if (after !== "" && !/^:[0-9]+$/.test(after)) return false;
    isV6 = true;
    hostname = hostname.slice(1, close);
    if (hostname.includes(".")) return false; // no IPv4-mapped loops
  } else {
    const colon = hostname.lastIndexOf(":");
    if (colon !== -1) {
      const port = hostname.slice(colon + 1);
      if (!/^[0-9]+$/.test(port)) return false;
      hostname = hostname.slice(0, colon);
    }
    if (hostname.includes(":")) isV6 = true;
  }
  if (isV6) {
    // IPv6 loopback spellings: `::1` or an 8-group expansion whose first
    // seven groups are all zero and whose last group is `1`/`0001`.
    if (hostname === "::1") return true;
    const groups = hostname.split(":");
    if (groups.length !== 8) return false;
    return (
      groups.slice(0, 7).every((group) => /^0{1,4}$/.test(group)) &&
      (groups[7] === "1" || groups[7] === "0001")
    );
  }
  if (!/^[a-z0-9.-]+$/.test(hostname)) {
    // only [a-z0-9.-] allowed for names/addresses here
    return false;
  }
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return true;
  }
  // dotted-quad IPv4 loopback: 127.0.0.0/8 (strict, no leading-zero groups)
  const parts = hostname.split(".");
  if (parts.length !== 4) return false;
  return (
    parts.every(
      (part: string) =>
        /^[0-9]{1,3}$/.test(part) &&
        Number(part) <= 255 &&
        part !== "" &&
        (part === "0" || !part.startsWith("0")),
    ) && parts[0] === "127"
  );
}

/**
 * Parse `COMPANION_WEB_SEARCH_JSON` (§9). Undefined/empty means OFF with
 * defaults (the descriptor stays unexposed). Invalid JSON, unknown keys,
 * wrong types or a non-loopback base URL throw — fail closed, never treated
 * as "disabled silently with a log".
 */
export function parseWebSearchConfig(
  envValue: string | undefined,
): WebSearchConfig {
  if (envValue === undefined || envValue.trim() === "") {
    return WebSearchConfigSchema.parse({});
  }
  let raw: unknown;
  try {
    raw = JSON.parse(envValue) as unknown;
  } catch {
    throw new TypeError(
      "COMPANION_WEB_SEARCH_JSON must be a valid JSON object",
    );
  }
  return WebSearchConfigSchema.parse(raw);
}
