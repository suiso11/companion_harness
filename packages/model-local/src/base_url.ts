// Loopback-only base-URL validation for local model adapters.
//
// Only plain HTTP URLs on 127.0.0.1, localhost, or IPv6 ::1 are accepted.
// HTTPS/cloud hosts, URL credentials, non-loopback hosts, and base URLs
// carrying a query string or fragment are rejected. Returned value is the
// normalized `http://host[:port][/path]` form with no trailing slash.

import { ModelLocalError } from "./errors.js";

/** Hosts allowed for local model endpoints (lowercase, brackets stripped). */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * Canonicalize a URL hostname for allowlist comparison: lowercase and strip
 * one pair of surrounding brackets from an IPv6 literal. URL implementations
 * vary on whether `hostname` retains brackets (`[::1]` vs `::1`), so both
 * spellings must compare equal. Brackets are stripped for comparison only;
 * serialization below uses `host`, which preserves them.
 */
function canonicalLoopbackHostname(hostname: string): string {
  const lower = hostname.toLowerCase();
  if (lower.startsWith("[") && lower.endsWith("]") && lower.length > 2) {
    return lower.slice(1, -1);
  }
  return lower;
}

/**
 * Validate `raw` as a loopback-only HTTP base URL and return its
 * normalized form (no trailing slash, no query/hash). Throws
 * ModelLocalError("invalid_base_url") with a generic message that never
 * echoes credentials or other sensitive URL parts.
 */
export function normalizeLoopbackBaseUrl(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new ModelLocalError(
      "invalid_base_url",
      "model base URL must be a non-empty string",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ModelLocalError("invalid_base_url", "model base URL is invalid");
  }
  if (parsed.protocol !== "http:") {
    throw new ModelLocalError(
      "invalid_base_url",
      "model base URL must use plain http for a loopback host",
    );
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new ModelLocalError(
      "invalid_base_url",
      "model base URL must not contain credentials",
    );
  }
  if (!LOOPBACK_HOSTS.has(canonicalLoopbackHostname(parsed.hostname))) {
    throw new ModelLocalError(
      "invalid_base_url",
      "model base URL host must be 127.0.0.1, localhost, or ::1",
    );
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new ModelLocalError(
      "invalid_base_url",
      "model base URL must not contain a query string or fragment",
    );
  }
  const path = parsed.pathname.replace(/\/+$/, "");
  // Serialize via `host` (not `hostname` + port): per the URL standard it
  // preserves the bracketed IPv6 literal and port (`[::1]:11434`), so the
  // normalized form stays a syntactically valid fetch URL.
  return `${parsed.protocol}//${parsed.host}${path}`;
}
