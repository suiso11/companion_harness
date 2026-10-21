// Self-hosted SearXNG HTTP client for `web.search` (design §3, §7, §9).
//
// PRIVACY BOUNDARY (§7): the search endpoint is loopback-only. The client
// (1) pins `localhost` -> `127.0.0.1` at config time, (2) revalidates the
// concrete fetch URL immediately before every fetch (fail-closed, no DNS
// lookup), (3) uses `redirect: "manual"` and refuses EVERY 3xx without
// forwarding the query anywhere, and (4) never retries.
//
// RESOURCE SAFETY: the raw response body is read as a bounded stream and is
// cut off at `maxResponseBytes` BEFORE `JSON.parse`; only the bounded string
// is ever parsed. Every fetch is subject to a hard abort timeout.
//
// UNTRUSTED INPUT: connectors-provided titles/snippets are never trusted:
// control characters are stripped, whitespace collapsed, and code-point
// bounds enforced by truncation. Result URLs must pass the strict
// `http`/`https` scheme allowlist or the hit is dropped.

import { createHash } from "node:crypto";
import {
  buildWebCanonicalKey,
  isLoopbackHostname,
  isValidLoopbackHttpUrl,
  MAX_WEB_TITLE_CODE_POINTS,
  WebResultUrlSchema,
} from "@companion/contracts";

/** Connector-level error vocabulary (kernel maps these to broker codes). */
export type WebSearchErrorCode =
  | "invalid_base_url"
  | "redirect_refused"
  | "timeout"
  | "network_error"
  | "response_too_large"
  | "response_invalid"
  | "upstream_error";

export class WebSearchClientError extends Error {
  readonly code: WebSearchErrorCode;
  constructor(code: WebSearchErrorCode, message: string) {
    super(message);
    this.name = "WebSearchClientError";
    this.code = code;
  }
}

/** Pin `localhost` to the literal loopback IP without any DNS lookup. */
export function normalizeSearxBaseUrl(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new WebSearchClientError(
      "invalid_base_url",
      "searxng_base_url must be a non-empty string",
    );
  }
  if (!isValidLoopbackHttpUrl(raw)) {
    throw new WebSearchClientError(
      "invalid_base_url",
      "searxng_base_url must be a loopback http(s) URL",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new WebSearchClientError(
      "invalid_base_url",
      "searxng_base_url is invalid",
    );
  }
  const host = parsed.hostname.toLowerCase();
  // Pin the whole reserved loopback name family (RFC 6761: `localhost` and
  // every `.localhost` subdomain) to the literal IP without any DNS lookup.
  if (host === "localhost" || host.endsWith(".localhost")) {
    parsed.hostname = "127.0.0.1";
  }
  const path = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.protocol}//${parsed.host}${path}`;
}

/** Immediate pre-fetch revalidation (fail-closed, no DNS lookup). */
function assertPinnedLoopbackUrl(target: string): void {
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    throw new WebSearchClientError(
      "invalid_base_url",
      "web search endpoint is invalid",
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new WebSearchClientError(
      "invalid_base_url",
      "web search endpoint is invalid",
    );
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new WebSearchClientError(
      "invalid_base_url",
      "web search endpoint is invalid",
    );
  }
  const host = parsed.hostname.toLowerCase();
  // Whole `localhost` name family (pinned above) and the same loopback
  // vocabulary the config validation accepts: 127.0.0.0/8 + IPv6 ::1.
  if (!isLoopbackHostname(host)) {
    // `localhost` names must already have been pinned to 127.0.0.1.
    throw new WebSearchClientError(
      "invalid_base_url",
      "web search endpoint is invalid",
    );
  }
}

/* ------------------------------------------------------------------ */
/* Untrusted text sanitizers                                            */
/* ------------------------------------------------------------------ */

/**
 * Neutralize control characters in untrusted text. C0 controls (U+0000-U+001F,
 * including \t\n\r) are dropped entirely; DEL and C1 controls (U+007F-U+009F)
 * degrade to spaces; remaining runs of whitespace collapse to one space.
 * Callers decide whether to trim the result.
 */
export function stripControlChars(raw: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: sandboxing untrusted text REQUIRES matching control characters by code point
  const noC0 = raw.replaceAll(/[\u0000-\u001f]/g, "");
  const noC1 = noC0.replaceAll(/[\u007f-\u009f]/g, " ");
  return noC1.replaceAll(/\s+/g, " ");
}

/** Code-point truncation to `max` (astral characters count once). */
function truncateCodePoints(value: string, max: number): string {
  const points = Array.from(value);
  return points.length <= max ? value : points.slice(0, max).join("");
}

/* ------------------------------------------------------------------ */
/* URL normalization + canonical key (design §5)                        */
/* ------------------------------------------------------------------ */

/** Normalized URL or null when the raw URL fails the allowlist/bounds. */
export function normalizeWebUrl(
  raw: string,
): { url: string; canonicalKey: string; normalizedUrl: string } | null {
  if (typeof raw !== "string") return null;
  // NFC first so Unicode spellings of the same URL (host IDNA aside, path
  // bytes) normalize identically at both the connector and kernel layers.
  const cleaned = stripControlChars(raw).normalize("NFC");
  if (!WebResultUrlSchema.safeParse(cleaned).success) return null;
  let parsed: URL;
  try {
    parsed = new URL(cleaned);
  } catch {
    return null;
  }
  // Normalize: keep scheme, inspect nothing implicit — preserve the exact
  // validated spelling minus the fragment, with the default port dropped.
  // The stored/used URL is the SAME href-canonicalized spelling the
  // canonical key hashes (IDNA punycode host, percent-encoded path), so a
  // non-NFC or non-ASCII spelling can never diverge from its identity.
  parsed.hash = "";
  let url = parsed.toString();
  if (url.endsWith("/") && parsed.pathname === "/" && parsed.search === "") {
    url = `${parsed.protocol}//${parsed.host}`;
  }
  const normalizedUrl = url;
  const canonicalKey = buildWebCanonicalKey(
    createHash("sha256")
      .update("web-v1\u0000")
      .update(normalizedUrl)
      .digest("hex"),
  );
  return { url: normalizedUrl, canonicalKey, normalizedUrl };
}

/* ------------------------------------------------------------------ */
/* SearXNG JSON response decoding (untrusted)                           */
/* ------------------------------------------------------------------ */

export interface WebSnippet {
  readonly url: string;
  readonly title: string | null;
  readonly snippet: string | null;
  readonly canonicalKey: string;
}

/**
 * Decode a bounded raw SearXNG JSON body into sanitized snippets. Malformed
 * JSON, a non-object body, or a missing non-array `results` throws
 * `response_invalid` (never a guess); bad URLs inside individual results
 * drop only that result (scheme allowlist enforcement, §3).
 */
export function decodeSearxResults(
  rawBody: string,
  maxResults: number,
): WebSnippet[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody) as unknown;
  } catch {
    throw new WebSearchClientError(
      "response_invalid",
      "searxng response is not valid JSON",
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new WebSearchClientError(
      "response_invalid",
      "searxng response shape is invalid",
    );
  }
  const results = (parsed as { results?: unknown }).results;
  if (!Array.isArray(results)) {
    throw new WebSearchClientError(
      "response_invalid",
      "searxng response is missing a results array",
    );
  }
  const out: WebSnippet[] = [];
  for (const entry of results.slice(0, Math.max(0, maxResults) * 4)) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as {
      url?: unknown;
      title?: unknown;
      content?: unknown;
    };
    const normalized = normalizeWebUrl(
      typeof record.url === "string" ? record.url : "",
    );
    if (normalized === null) continue; // non-allowlisted scheme/bounds: drop
    const title =
      typeof record.title === "string" &&
      stripControlChars(record.title).length > 0
        ? truncateCodePoints(
            stripControlChars(record.title),
            MAX_WEB_TITLE_CODE_POINTS,
          )
        : null;
    // Snippets are interior display text: trim the bounded edge whitespace.
    const snippetRaw =
      typeof record.content === "string"
        ? stripControlChars(record.content)
        : "";
    const snippet =
      snippetRaw.trim().length > 0
        ? truncateCodePoints(snippetRaw.trim(), 512)
        : null;
    if (title === null && snippet === null) continue;
    out.push({
      url: normalized.url,
      title,
      snippet,
      canonicalKey: normalized.canonicalKey,
    });
    if (out.length >= maxResults) break;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Bounded fetch (redirect refusal + streaming byte cap)                */
/* ------------------------------------------------------------------ */

/**
 * Read the response body as a bounded stream. Aborts (and closes the
 * connection) the moment the cap is exceeded; never buffers beyond the cap
 * before `JSON.parse`.
 */
async function readBodyWithCap(
  response: Response,
  cap: number,
  signal: AbortSignal,
): Promise<string> {
  const body = response.body;
  if (body === null) {
    return "";
  }
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let text = "";
  let bytes = 0;
  try {
    for (;;) {
      if (signal.aborted) {
        throw new WebSearchClientError("timeout", "web search aborted");
      }
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > cap) {
        void reader.cancel().catch(() => {});
        throw new WebSearchClientError(
          "response_too_large",
          "searxng response exceeded the byte cap before JSON parse",
        );
      }
      text += decoder.decode(chunk.value, { stream: true });
      if (text.length > cap + 4) {
        // Defense-in-depth against pathological multi-byte expansion; the
        // byte cap above is the authoritative bound.
        void reader.cancel().catch(() => {});
        throw new WebSearchClientError(
          "response_too_large",
          "searxng response exceeded the byte cap before JSON parse",
        );
      }
    }
    text += decoder.decode();
    return text;
  } finally {
    void reader.cancel().catch(() => {});
  }
}

/**
 * Fetch `GET {base}/search?format=json&q=...` with redirect refusal, hard
 * timeout, and a pre-parse byte cap. Returns the bounded raw body string.
 */
export async function fetchSearxResults(options: {
  readonly baseUrl: string;
  readonly query: string;
  readonly maxResults: number;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly language?: string;
  readonly timeRange?: "day" | "week" | "month" | "year";
  readonly signal?: AbortSignal;
}): Promise<string> {
  const baseUrl = normalizeSearxBaseUrl(options.baseUrl);
  const searchUrl = new URL(`${baseUrl}/search`);
  const params = new URLSearchParams();
  params.set("format", "json");
  params.set("q", options.query);
  if (options.language !== undefined) params.set("language", options.language);
  if (options.timeRange !== undefined) {
    params.set("time_range", options.timeRange);
  }
  searchUrl.search = params.toString();
  const target = searchUrl.toString();
  assertPinnedLoopbackUrl(target);

  const timeoutController = new AbortController();
  const timeoutTimer = setTimeout(
    () => timeoutController.abort(),
    options.timeoutMs,
  );
  const cleanup = () => clearTimeout(timeoutTimer);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutController.signal])
    : timeoutController.signal;
  try {
    const response = await fetch(target, {
      method: "GET",
      redirect: "manual", // §7: every 3xx is refused, never followed
      headers: { accept: "application/json" },
      signal,
      ...{ keepalive: false },
    });
    if (response.status >= 300 && response.status < 400) {
      // Refuse WITHOUT reading the body; cancel the connection.
      void response.body?.cancel().catch(() => {});
      throw new WebSearchClientError(
        "redirect_refused",
        "searxng endpoint returned a redirect (refused)",
      );
    }
    if (response.status < 200 || response.status > 299) {
      void response.body?.cancel().catch(() => {});
      throw new WebSearchClientError(
        "upstream_error",
        "searxng endpoint returned a non-2xx status",
      );
    }
    return await readBodyWithCap(response, options.maxResponseBytes, signal);
  } catch (error) {
    cleanup();
    if (error instanceof WebSearchClientError) {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw new WebSearchClientError("timeout", "searxng fetch timed out");
    }
    throw new WebSearchClientError("network_error", "searxng fetch failed");
  } finally {
    cleanup();
  }
}

/** One-shot convenience: validate bounds, fetch, decode. */
export async function searchSearx(options: {
  readonly baseUrl: string;
  readonly query: string;
  readonly maxResults?: number;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly language?: string;
  readonly timeRange?: "day" | "week" | "month" | "year";
  readonly signal?: AbortSignal;
}): Promise<WebSnippet[]> {
  const rawBody = await fetchSearxResults({
    baseUrl: options.baseUrl,
    query: options.query,
    maxResults: options.maxResults ?? 5,
    timeoutMs: options.timeoutMs ?? 10_000,
    maxResponseBytes: options.maxResponseBytes ?? 1_048_576,
    ...(options.language === undefined ? {} : { language: options.language }),
    ...(options.timeRange === undefined
      ? {}
      : { timeRange: options.timeRange }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return decodeSearxResults(rawBody, options.maxResults ?? 5);
}
