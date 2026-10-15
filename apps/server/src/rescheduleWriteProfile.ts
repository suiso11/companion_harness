// Host-owned pinned dedicated reschedule write identity (M5, separate entrypoint).
//
// This module is TRUSTED HOST CODE: it owns the one reviewed dedicated WRITE
// candidate adoption (fork pin + exact live-wire schema hash + expected wire
// identity for `google-calendar-reschedule` / `1.0.0-reschedule.1`, tool
// `reschedule-event` ONLY). It is SEPARATE from the readonly profile
// (`calendarReadonlyProfile.ts`): the readonly surface keeps zero write tools
// and this module never enters the read allowlist.
//
// Candidate provenance (verified by exact wire probe, never guessed):
// - repo: https://github.com/suiso11/google-calendar-mcp
// - derived branch: feat/m5-reschedule-entrypoint-v2 (draft PR #3)
// - base commit: 6939311fd3eae9846648e0a175e304c9500f578e (readonly cutover)
// - source commit: 4f9c06dd9318c11ee9d352d61825c3f75f9ac8a6
// - source tree: 9eec88aa21951e1ea9564a62e89a40eeb2bcceef
// - package: @cocal/google-calendar-mcp, private version 3.0.0-readonly.2
// - package-lock.json SHA-256:
//   63261d25992ee9c97136a60bbf4fe52a5485cadea28b34d6b8b6c685f38bd533
//   (unchanged from the readonly base: dependency tree identical)
// - wire identity: serverInfo { name: "google-calendar-reschedule",
//   version: "1.0.0-reschedule.1" } (fork src/reschedule/schema.ts +
//   src/reschedule/server.ts; McpServer name/version, distinct from the
//   readonly `google-calendar` / `3.0.0-readonly.2`).
// - surface: EXACTLY `reschedule-event` (start/end only + opaque selection +
//   committed-grant `expectedEtag`; strict, additionalProperties false).
// - OAuth scope: ONLY https://www.googleapis.com/auth/calendar.events
//   (separate `M5_RESCHEDULE_*` credential namespace; readonly tokens and
//   the readonly `calendar.events.readonly` scope are never reused).
// - launch entry: <fork>/build/reschedule-cli.js (separate stdio process).
//
// Binding pin: the hash below is the LIVE-WIRE canonical input-schema
// SHA-256 (what the connector verifies over the real SDK wire via
// tools/list, `canonicalSchemaHash`). Probed 2026-10-15 over REAL stdio
// against BOTH the freshly built fork bundle
// (`.m5-write-fork-derived/build/reschedule-cli.js`) and the tracked
// contract-mirror fixture
// (`packages/connector-calendar/test/helpers/rescheduleFixtureServer.mjs`):
// both advertise byte-identical STRICT input schemas
// (`additionalProperties: false` + `$schema` key) with hash
// `9f59e35b…8609d7`. The fork's removed hand-written
// `rescheduleInputJsonSchema()` (neither strict nor `$schema`) MUST NOT be
// used here.

import { posix as posixPath, win32 as win32Path } from "node:path";
import type {
  McpBindingDefinition,
  McpConnectorConfig,
} from "@companion/connector-mcp";
import { ServerConfigError } from "./config.js";

/** Expected dedicated-write wire identity (exact, case-sensitive). */
export const RESCHEDULE_WRITE_SERVER_NAME =
  "google-calendar-reschedule" as const;
export const RESCHEDULE_WRITE_SERVER_VERSION = "1.0.0-reschedule.1" as const;

/** The ONLY tool on the dedicated write entrypoint. */
export const RESCHEDULE_WRITE_TOOL_NAME = "reschedule-event" as const;

/**
 * Pinned LIVE-WIRE canonical input-schema hash for `reschedule-event`
 * (SDK wire bytes, including the `$schema` annotation key).
 */
export const RESCHEDULE_WRITE_WIRE_HASH =
  "9f59e35bf76bfec75a99546fc3c22348cd20e33e9414154ea321d414186d09b7" as const;

/** Pinned fork provenance for the dedicated write entrypoint. */
export const RESCHEDULE_WRITE_FORK = Object.freeze({
  repo: "https://github.com/suiso11/google-calendar-mcp",
  branch: "feat/m5-reschedule-entrypoint-v2",
  baseCommit: "6939311fd3eae9846648e0a175e304c9500f578e",
  sourceCommit: "4f9c06dd9318c11ee9d352d61825c3f75f9ac8a6",
  sourceTree: "9eec88aa21951e1ea9564a62e89a40eeb2bcceef",
  package: "@cocal/google-calendar-mcp",
  packageVersion: "3.0.0-readonly.2",
  lockDigestSha256:
    "63261d25992ee9c97136a60bbf4fe52a5485cadea28b34d6b8b6c685f38bd533",
  serverName: RESCHEDULE_WRITE_SERVER_NAME,
  version: RESCHEDULE_WRITE_SERVER_VERSION,
  scopes: ["https://www.googleapis.com/auth/calendar.events"],
  entry: "build/reschedule-cli.js",
});

/**
 * Host-owned trusted dedicated WRITE definition for the adopted candidate.
 * Fresh frozen copy on every call; caller mutation can never affect the
 * pinned module state or a later resolution. Category is exactly `write`
 * so only a dedicated `["write"]` connector gate can ever enable it — a
 * default readonly connector refuses it with `mcp_binding_not_allowed`.
 */
export function getRescheduleWriteDefinitions(): readonly McpBindingDefinition[] {
  const def: McpBindingDefinition = {
    upstreamTool: RESCHEDULE_WRITE_TOOL_NAME,
    canonicalSchemaHash: RESCHEDULE_WRITE_WIRE_HASH,
    category: "write" as const,
  };
  return Object.freeze([Object.freeze(def)]);
}

// ---------------------------------------------------------------------------
// M5 normal-startup host-owned write composition (disabled by default).
// Selector + connection-hint contract (mirrors the readonly-profile
// precedent, strictly narrower):
// - `M5_RESCHEDULE_WRITE_PROFILE=google-reschedule` selects the ONE adopted
//   dedicated provider below. Unset/empty means DISABLED (previous behavior
//   unchanged: injected `actionWriteBinding` seam or fail-closed incomplete
//   opt-in). Any other value fails closed BEFORE any DB side effect.
// - `M5_RESCHEDULE_CONNECTOR_JSON` supplies STRICT connection hints only:
//   `{ command, args?, envAllowlist? }` for the SEPARATE write stdio child.
//   It NEVER carries a category, capability, trusted definition,
//   connectorInstanceId, consent flag, or OAuth material: those stay
//   host-owned (pinned below / the active Calendar instance id the server
//   registered itself). Unknown keys, non-stdio shapes, or TEST-namespace
//   env names (`M5_RESCHEDULE_TEST_*`, the fixture-only bypass) fail closed.
//   Token/credential VALUES are never read here — shape only.
// - The write capability always names the SAME active Calendar instance as
//   the read binding (same connectorInstanceId + calendarId/account); the
//   write MCP transport identity (command/pinned server name+version+hash)
//   stays distinct from the readonly entrypoint, which is never widened or
//   rebound by this module.
// ---------------------------------------------------------------------------

/** Strict opt-in env name selecting the host-owned dedicated write profile. */
export const RESCHEDULE_WRITE_PROFILE_ENV =
  "M5_RESCHEDULE_WRITE_PROFILE" as const;

/** Strict connection-hint env name (hints only, never authority). */
export const RESCHEDULE_WRITE_CONNECTOR_ENV =
  "M5_RESCHEDULE_CONNECTOR_JSON" as const;

/** The single adopted dedicated write profile name. */
export const RESCHEDULE_WRITE_PROFILE_NAME = "google-reschedule" as const;

/** Logical (config-only) server id for the dedicated write connector. */
export const RESCHEDULE_WRITE_SERVER_ID = "reschedule-write" as const;

function writeProfileError(message: string): ServerConfigError {
  return new ServerConfigError(message);
}

/**
 * Strict write-profile selector: unset/empty means DISABLED (null, previous
 * behavior). Exactly `google-reschedule` selects the adopted provider. Any
 * other value fails closed with a fixed message (never a silent disable).
 */
export function parseRescheduleWriteProfileName(
  raw: string | undefined,
): typeof RESCHEDULE_WRITE_PROFILE_NAME | null {
  if (raw === undefined || raw.length === 0) {
    return null;
  }
  if (raw === RESCHEDULE_WRITE_PROFILE_NAME) {
    return RESCHEDULE_WRITE_PROFILE_NAME;
  }
  throw writeProfileError("unknown reschedule write profile");
}

/** Frozen strict connection hint for the separate write stdio child. */
export interface RescheduleWriteConnectorHint {
  readonly command: string;
  readonly args: readonly string[];
  readonly envAllowlist: readonly string[];
}

const WRITE_COMMAND_PATTERN =
  /^([A-Za-z0-9_.-]+|[A-Za-z0-9_./-][A-Za-z0-9_./-]*)$/;
/**
 * Single-executable shape guard for absolute command paths (the stdio
 * transport spawns with `shell: false`, so no shell splitting/quoting ever
 * applies): an absolute path may contain platform separators, a drive colon
 * and spaces (`C:\Program Files\...\node.exe`, `/opt/my tools/node`), but a
 * shell command line never passes — `;`, `&`, `|`, `$`, backtick,
 * redirection (`>`, `<`) and quoting (`"`, `'`) are rejected, as are NUL and
 * C0/C1 control characters (including newlines). Parentheses are allowed
 * (`Program Files (x86)`). Bare names and relative shapes keep the existing
 * pattern above.
 */
const WRITE_COMMAND_SHELL_CHARS = /[;&|$`><"']/;
/** NUL and C0/C1 controls (incl. newlines) never appear in one executable. */
function hasWriteCommandControlChar(command: string): boolean {
  for (let index = 0; index < command.length; index += 1) {
    const code = command.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}
function isWriteCommandShape(command: string): boolean {
  if (
    WRITE_COMMAND_SHELL_CHARS.test(command) ||
    hasWriteCommandControlChar(command)
  ) {
    return false;
  }
  if (win32Path.isAbsolute(command) || posixPath.isAbsolute(command)) {
    return true;
  }
  return WRITE_COMMAND_PATTERN.test(command);
}
const WRITE_ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
const WRITE_TEST_ENV_PREFIX = "M5_RESCHEDULE_TEST_";

/**
 * Strict connection-hint parser (shape only, never credential values).
 * Exact `{ command, args?, envAllowlist? }`: unknown keys rejected,
 * command is a 1..512 single executable — a bare binary name, a relative
 * shape (existing contract), or an absolute path on the actual platform
 * (`path.posix`/`path.win32` absolute, spaces allowed, e.g. Windows
 * `C:\Program Files\...\node.exe`); shell command lines, interpolation
 * (`;`, `&`, `|`, `$`, backtick, `>`, `<`, quotes), NUL and control
 * characters are rejected (the stdio transport uses `shell: false`, so no
 * command splitting/quoting ever applies and args stay an array), args at
 * most 16 entries of at most 1024 chars, envAllowlist at most 32 UPPER_SNAKE
 * names.
 * `M5_RESCHEDULE_TEST_*` names (the fixture-only bypass) are rejected: the
 * production child never inherits test-endpoint overrides. Missing input
 * fails closed (a selected profile without hints is incomplete). The result
 * is deep-frozen.
 */
export function parseRescheduleWriteConnectorHint(
  raw: string | undefined,
): RescheduleWriteConnectorHint {
  if (raw === undefined) {
    throw writeProfileError(
      "reschedule write profile requires connector hints",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw writeProfileError("reschedule write connector hints are invalid");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw writeProfileError("reschedule write connector hints are invalid");
  }
  for (const key of Object.keys(parsed)) {
    if (key !== "command" && key !== "args" && key !== "envAllowlist") {
      throw writeProfileError("reschedule write connector hints are invalid");
    }
  }
  const record = parsed as {
    command?: unknown;
    args?: unknown;
    envAllowlist?: unknown;
  };
  const command = record.command;
  if (
    typeof command !== "string" ||
    command.length === 0 ||
    command.length > 512 ||
    command.includes("\0") ||
    !isWriteCommandShape(command)
  ) {
    throw writeProfileError("reschedule write connector hints are invalid");
  }
  let args: readonly string[] = Object.freeze([]);
  if (record.args !== undefined) {
    if (!Array.isArray(record.args) || record.args.length > 16) {
      throw writeProfileError("reschedule write connector hints are invalid");
    }
    for (const entry of record.args) {
      if (
        typeof entry !== "string" ||
        entry.length > 1024 ||
        entry.includes("\0")
      ) {
        throw writeProfileError("reschedule write connector hints are invalid");
      }
    }
    args = Object.freeze([...(record.args as string[])]);
  }
  let envAllowlist: readonly string[] = Object.freeze([]);
  if (record.envAllowlist !== undefined) {
    if (
      !Array.isArray(record.envAllowlist) ||
      record.envAllowlist.length > 32
    ) {
      throw writeProfileError("reschedule write connector hints are invalid");
    }
    for (const entry of record.envAllowlist) {
      if (
        typeof entry !== "string" ||
        !WRITE_ENV_NAME_PATTERN.test(entry) ||
        entry.startsWith(WRITE_TEST_ENV_PREFIX)
      ) {
        throw writeProfileError(
          "reschedule write connector env allowlist is invalid",
        );
      }
    }
    envAllowlist = Object.freeze([...(record.envAllowlist as string[])]);
  }
  return Object.freeze({ command, args, envAllowlist });
}

/**
 * Fail-closed write hint/identity preflight (no I/O, before any DB side
 * effect): the stdio transport shape is exact and the pinned wire identity
 * (name/version/hash) is the adopted one — the hint itself can never supply
 * or override identity, category, or instance authority. Fixed path-free
 * messages only.
 */
export function assertRescheduleWriteHintCompatible(hint: {
  readonly command: string;
}): void {
  if (hint.command.length === 0) {
    throw writeProfileError("reschedule write connector hints are invalid");
  }
}

/**
 * Build the DEDICATED write MCP connector config for the active Calendar
 * instance. The server fills the exact instance id IT registered (owned) or
 * verified (injected): a hint can never claim a stored instance id. Identity
 * (expectedServerName/version), the single `reschedule-event` binding hash,
 * and the `write` category gate stay host-pinned; only the stdio command
 * line + env allowlist shape come from the validated hint. An optional
 * test-only identity override exists for the explicit trusted test seam
 * (options-injected, never env); production never passes it.
 */
export function buildRescheduleWriteConnectorConfig(options: {
  readonly connectorInstanceId: string;
  readonly hint: RescheduleWriteConnectorHint;
  readonly testIdentity?: {
    readonly expectedServerName: string;
    readonly version: string;
  };
}): McpConnectorConfig {
  const identity =
    options.testIdentity !== undefined
      ? options.testIdentity
      : {
          expectedServerName: RESCHEDULE_WRITE_SERVER_NAME,
          version: RESCHEDULE_WRITE_SERVER_VERSION,
        };
  if (
    identity.expectedServerName.length === 0 ||
    identity.expectedServerName.length > 128 ||
    identity.version.length === 0 ||
    identity.version.length > 64
  ) {
    throw writeProfileError("reschedule write connector hints are invalid");
  }
  return Object.freeze({
    connectorInstanceId: options.connectorInstanceId,
    serverId: RESCHEDULE_WRITE_SERVER_ID,
    kind: "mcp",
    expectedServerName: identity.expectedServerName,
    version: identity.version,
    transport: Object.freeze({
      kind: "stdio",
      command: options.hint.command,
      args: [...options.hint.args],
      envAllowlist: [...options.hint.envAllowlist],
      shutdownWaitMs: 3000,
    }),
    bindings: Object.freeze([
      Object.freeze({
        upstreamTool: RESCHEDULE_WRITE_TOOL_NAME,
        canonicalSchemaHash: RESCHEDULE_WRITE_WIRE_HASH,
      }),
    ]),
    clientName: "companion-harness",
    clientVersion: "0.0.0",
  }) as McpConnectorConfig;
}
