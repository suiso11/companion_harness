// Loopback-only base-URL validation for local model adapters.
//
// Only plain HTTP URLs on 127.0.0.1, localhost, or IPv6 ::1 are accepted.
// HTTPS/cloud hosts, URL credentials, non-loopback hosts, and base URLs
// carrying a query string or fragment are rejected. Returned value is the
// normalized `http://host[:port][/path]` form with no trailing slash.

import { ModelLocalError } from "./errors.js";

/** Hostnames allowed for local model endpoints (lowercase compare). */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

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
  if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
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
  return `${parsed.protocol}//${parsed.host}${path}`;
}
