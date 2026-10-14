// Host-owned pinned Google readonly Calendar profile (C14 production profile).
//
// This module is TRUSTED HOST CODE: it owns the one reviewed readonly
// candidate adoption (fork pin + exact live-wire schema hashes + expected
// wire identity). It is selected ONLY through the strict opt-in frozen env
// `COMPANION_CALENDAR_PROFILE=google-readonly` together with the existing
// `COMPANION_CALENDAR_JSON` hint. Unset profile (default) keeps the previous
// behavior unchanged: no Calendar unless the JSON hint is set, and a set
// JSON hint without either this profile or explicit `mcpDefinitions`
// remains an INCOMPLETE opt-in (fail closed).
//
// Candidate provenance (verified by exact fork checkout in owned scratch,
// never guessed; commit/tree/package-lock digest re-verified at inspection):
// - repo: https://github.com/suiso11/google-calendar-mcp
// - commit: 6939311fd3eae9846648e0a175e304c9500f578e
// - tree: f01b5a7b608c4091906a52c0784b828c35963de9
// - package: @cocal/google-calendar-mcp, private version 3.0.0-readonly.2
// - package-lock.json SHA-256:
//   63261d25992ee9c97136a60bbf4fe52a5485cadea28b34d6b8b6c685f38bd533
// - wire identity: serverInfo { name: "google-calendar",
//   version: "3.0.0-readonly.2" } (fork src/server.ts reads package.json
//   version at runtime; name hardcoded "google-calendar").
// - surface: EXACTLY list-events / search-events / get-event (no
//   list-calendars, no writes, no freebusy/colors/time/respond, no
//   manage-accounts). Fork registry default registers exactly these three;
//   recommended launch pins the same set explicitly via --enable-tools.
// - OAuth scope: ONLY https://www.googleapis.com/auth/calendar.events.readonly
//   (fork src/auth/scopes.ts READONLY_CALENDAR_SCOPES; broader grants
//   rejected by the fork validator).
// - launch entry: <fork>/build/index.js (bin google-calendar-mcp),
//   stdio default; `node <fork>/build/index.js --enable-tools
//   list-events,search-events,get-event` (or ENABLED_TOOLS env).
// - auth entry (USER-INTERACTIVE, never run by this worker): fork auth CLI
//   `node <fork>/build/index.js auth [account-id]` (equivalently
//   `npm run auth` / `node <fork>/build/auth-server.js`); loopback callback
//   http://localhost:<3500-3505>/oauth2callback; browser consent required.
// - secrets (provisioned OUTSIDE the repo, never read/logged here):
//   GOOGLE_OAUTH_CREDENTIALS = path to gcp-oauth.keys.json (client secrets);
//   tokens at GOOGLE_CALENDAR_MCP_READONLY_TOKEN_PATH or
//   ~/.config/google-calendar-mcp-readonly/tokens.json; account via
//   GOOGLE_ACCOUNT_MODE. Broad-scope GOOGLE_CALENDAR_MCP_TOKEN_PATH is
//   intentionally ignored by the fork (fresh readonly consent only).
//
// Binding pin: the hashes below are the LIVE-WIRE canonical input-schema
// SHA-256 values (what the connector verifies over the real SDK wire via
// tools/list), NOT the registry-direct diagnostic bytes (a065/012e/913…,
// different serializer, recorded in PR22 evidence as diagnostic only).
// Source: PR22 docs/evidence/calendar-readonly-candidate-pin.json
// (provenance read via `git show`, never copied as code).

import type { McpBindingDefinition } from "@companion/connector-mcp";
import { ServerConfigError } from "./config.js";

/** Strict opt-in env name selecting this host-owned profile. */
export const CALENDAR_PROFILE_ENV = "COMPANION_CALENDAR_PROFILE" as const;

/** The single adopted profile name. Any other value is rejected. */
export const GOOGLE_READONLY_PROFILE_NAME = "google-readonly" as const;

/**
 * Boring profile-specific persisted connector identity: the owned
 * google-readonly composition registers under this display name (kind
 * `calendar`), NEVER the generic `calendar-mcp`. A DB previously created by
 * the host-injected generic composition with the same selection therefore
 * cannot be reused, and old resources/targets (keyed by the old instance
 * id) cannot be refreshed via the Google provider. The name is path-free
 * per the kernel displayName rules.
 */
export const GOOGLE_READONLY_CONNECTOR_DISPLAY_NAME =
  "calendar-mcp-google-readonly" as const;

/**
 * Pinned fork account grammar for the profile selection: lowercase ASCII
 * `[a-z0-9_-]{1,64}` (the fork `auth [account-id]` / `GOOGLE_ACCOUNT_MODE`
 * identity). Email addresses, uppercase, overlength, or other characters
 * are rejected. Omitted account remains valid. This narrows ONLY the
 * profile path; the generic non-profile `parseCalendarConfig` account
 * contract (1..512, no NUL) is unchanged.
 */
export const GOOGLE_READONLY_ACCOUNT_PATTERN = /^[a-z0-9_-]{1,64}$/;

/** Pinned fork identity (exact pin form: full SHA + lock digest). */
export const GOOGLE_READONLY_FORK = Object.freeze({
  repo: "https://github.com/suiso11/google-calendar-mcp",
  commit: "6939311fd3eae9846648e0a175e304c9500f578e",
  tree: "f01b5a7b608c4091906a52c0784b828c35963de9",
  package: "@cocal/google-calendar-mcp",
  version: "3.0.0-readonly.2",
  lockDigestSha256:
    "63261d25992ee9c97136a60bbf4fe52a5485cadea28b34d6b8b6c685f38bd533",
  serverName: "google-calendar",
  scopes: ["https://www.googleapis.com/auth/calendar.events.readonly"],
});

/** Exact adopted tool surface (no list-calendars, no writes). */
export const GOOGLE_READONLY_TOOLS: readonly string[] = Object.freeze([
  "list-events",
  "search-events",
  "get-event",
]);

/**
 * Pinned LIVE-WIRE canonical input-schema hashes (SDK wire bytes).
 * Registry-direct bytes (a065…/012e…/913e…) are a different serializer
 * and MUST NOT be used here.
 */
export const GOOGLE_READONLY_WIRE_HASHES: Readonly<Record<string, string>> =
  Object.freeze({
    "list-events":
      "81222b89482cba77b12a707c2097c66df383cab7929c14dca03cc303846d794c",
    "search-events":
      "d48ba36e7f280d92eaba9550323e90aa7a6d7c758812932ad62012f4514558b7",
    "get-event":
      "8c6736e2a1f397d0735efa5c0881f5c350c300b21a0b026e80c112258b596bda",
  });

/** Known fork launch entry (relative to the exact fork checkout/build). */
export const GOOGLE_READONLY_LAUNCH = Object.freeze({
  entry: "build/index.js",
  bin: "google-calendar-mcp",
  transport: "stdio",
  enableToolsFlag: "--enable-tools list-events,search-events,get-event",
});

/** Known fork auth entry + secret/token env contract (docs only). */
export const GOOGLE_READONLY_AUTH = Object.freeze({
  authCommand: "node <fork>/build/index.js auth [account-id]",
  authServer: "node <fork>/build/auth-server.js",
  credentialsEnv: "GOOGLE_OAUTH_CREDENTIALS",
  tokenEnv: "GOOGLE_CALENDAR_MCP_READONLY_TOKEN_PATH",
  accountEnv: "GOOGLE_ACCOUNT_MODE",
  loopbackCallback: "http://localhost:<3500-3505>/oauth2callback",
});

function profileError(message: string): ServerConfigError {
  return new ServerConfigError(message);
}

/**
 * Strict profile selector: unset/empty means DISABLED (null, previous
 * behavior). Exactly `google-readonly` selects the adopted profile. Any
 * other value fails closed with a fixed message (never a silent disable).
 */
export function parseCalendarProfileName(
  raw: string | undefined,
): typeof GOOGLE_READONLY_PROFILE_NAME | null {
  if (raw === undefined || raw.length === 0) {
    return null;
  }
  if (raw === GOOGLE_READONLY_PROFILE_NAME) {
    return GOOGLE_READONLY_PROFILE_NAME;
  }
  throw profileError("unknown calendar profile");
}

/**
 * Host-owned trusted readonly definitions for the adopted candidate.
 * Fresh frozen copy on every call; caller mutation can never affect the
 * pinned module state or a later resolution.
 */
export function getGoogleReadonlyDefinitions(): readonly McpBindingDefinition[] {
  const defs: McpBindingDefinition[] = GOOGLE_READONLY_TOOLS.map((tool) => ({
    upstreamTool: tool,
    canonicalSchemaHash: GOOGLE_READONLY_WIRE_HASHES[tool] as string,
    category: "read" as const,
  }));
  for (const def of defs) {
    Object.freeze(def);
  }
  return Object.freeze(defs);
}

/** Minimal structural view of the calendar config hint for gating. */
interface ProfileCalendarHint {
  readonly selection?: {
    readonly calendarId?: unknown;
    readonly account?: unknown;
  };
  readonly connector: {
    readonly expectedServerName?: unknown;
    readonly version?: unknown;
    readonly transport?: { readonly kind?: unknown };
    readonly bindings?: readonly unknown[];
  };
}

/**
 * Fail-closed profile/config linkage: the JSON hint must describe EXACTLY
 * the adopted candidate — expected wire identity equal to the pin, stdio
 * transport, and EXACTLY the three pinned tools with the pinned live-wire
 * hashes (no extras, no list-calendars, no writes, no substituted hash).
 * Fixed path-free messages only; any deviation fails closed (never a
 * silent downgrade to a different surface).
 */
export function assertGoogleReadonlyHintCompatible(
  calendar: ProfileCalendarHint,
): void {
  const account = calendar.selection?.account;
  if (account !== undefined) {
    if (
      typeof account !== "string" ||
      !GOOGLE_READONLY_ACCOUNT_PATTERN.test(account)
    ) {
      throw profileError("calendar profile account mismatch");
    }
  }
  const connector = calendar.connector;
  if (
    connector.expectedServerName !== GOOGLE_READONLY_FORK.serverName ||
    connector.version !== GOOGLE_READONLY_FORK.version
  ) {
    throw profileError("calendar profile identity mismatch");
  }
  if (connector.transport?.kind !== "stdio") {
    throw profileError("calendar profile transport mismatch");
  }
  const bindings = connector.bindings;
  if (!Array.isArray(bindings) || bindings.length !== 3) {
    throw profileError("calendar profile bindings mismatch");
  }
  const seen = new Set<string>();
  for (const entry of bindings) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw profileError("calendar profile bindings mismatch");
    }
    const binding = entry as {
      readonly upstreamTool?: unknown;
      readonly canonicalSchemaHash?: unknown;
    };
    const name = binding.upstreamTool;
    const hash = binding.canonicalSchemaHash;
    if (typeof name !== "string" || typeof hash !== "string") {
      throw profileError("calendar profile bindings mismatch");
    }
    if (seen.has(name)) {
      throw profileError("calendar profile bindings mismatch");
    }
    seen.add(name);
    const expected = (GOOGLE_READONLY_WIRE_HASHES as Record<string, string>)[
      name
    ];
    if (expected === undefined || hash !== expected) {
      throw profileError("calendar profile bindings mismatch");
    }
  }
  for (const tool of GOOGLE_READONLY_TOOLS) {
    if (!seen.has(tool)) {
      throw profileError("calendar profile bindings mismatch");
    }
  }
}
