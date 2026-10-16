// Host-owned pinned dedicated create identity (M6, separate entrypoint).
//
// This module is TRUSTED HOST CODE: it owns the one reviewed dedicated
// CREATE candidate adoption (fork pin + exact live-wire schema hash +
// expected wire identity for `google-calendar-create` / `1.0.0-create.1`,
// tool `create-event` ONLY). It is SEPARATE from the readonly profile AND
// the reschedule profile: the readonly surface keeps zero write tools, the
// reschedule binding is unchanged, and this module never enters the read
// allowlist.
//
// Candidate provenance: DEDICATED fork `src/create/*` (schema/server/
// google provider/cli) + `build/create-cli.js`, tool `create-event` ONLY,
// scope ONLY https://www.googleapis.com/auth/calendar.events, separate
// `M6_CREATE_*` credential namespace (readonly/reschedule tokens never
// reused). Wire hash + source commit/tree/lock are finalized AFTER the fork
// code lands; the immutable pin is recorded in
// `.m6-calendar-create-proof/PROGRESS.log` BEFORE the host commit. Until the
// finalized hash is pinned, production composition fails closed (a selected
// profile without a finalized pin is an incomplete opt-in, never a silent
// disable).
//
// Launch entry: <fork>/build/create-cli.js (separate stdio process).
// Write runtime auth reuses the M5 persisted-grant loader namespace
// explicitly (`M6_CREATE_*` client/account/path), never the readonly grant.
// The RECOMMENDED child allowlist is file-only: client file path, create
// token file path, account selector, and the readonly token path name (for
// the fork's resolved collision guard) plus mandatory SDK inherited names.
// `M6_CREATE_TEST_*` names stay rejected: the production CLI ignores test
// endpoint overrides and always uses the immutable Google host.

import { posix as posixPath, win32 as win32Path } from "node:path";
import type {
  McpBindingDefinition,
  McpConnectorConfig,
} from "@companion/connector-mcp";
import { ServerConfigError } from "./config.js";

/** Expected dedicated-create wire identity (exact, case-sensitive). */
export const CREATE_WRITE_SERVER_NAME = "google-calendar-create" as const;
export const CREATE_WRITE_SERVER_VERSION = "1.0.0-create.1" as const;

/** The ONLY tool on the dedicated create entrypoint. */
export const CREATE_WRITE_TOOL_NAME = "create-event" as const;

/**
 * Pinned LIVE-WIRE canonical input-schema hash for `create-event` (SDK wire
 * bytes, including the `$schema` annotation key).
 *
 * Probed over REAL stdio tools/list against the shipped production CLI
 * (`build/create-cli.js`, fork commit 1a53cde) with fixture credentials
 * (loopback endpoint unused by tools/list): exactly 1 tool, strict schema
 * ($schema + additionalProperties:false).
 */
export const CREATE_WRITE_WIRE_HASH =
  "983c154887b6aefd49f7ca121995abd4f09651a69426490c6a28965a07b5234e" as const;

/** Pinned fork provenance for the dedicated create entrypoint. */
export const CREATE_WRITE_FORK = Object.freeze({
  repo: "https://github.com/suiso11/google-calendar-mcp",
  branch: "feat/m6-calendar-create",
  baseCommit: "cefb63c24f062ef6a49889d7b635330dee884f63",
  sourceCommit: "1a53cdef4131cf11ed0bf4c7184d83a65ccf77b4",
  sourceTree: "b19eda3985462a091a86f36229b02c23734eee0a",
  package: "@cocal/google-calendar-mcp",
  packageVersion: "3.0.0-readonly.2",
  lockDigestSha256:
    "63261d25992ee9c97136a60bbf4fe52a5485cadea28b34d6b8b6c685f38bd533",
  serverName: CREATE_WRITE_SERVER_NAME,
  version: CREATE_WRITE_SERVER_VERSION,
  scopes: ["https://www.googleapis.com/auth/calendar.events"],
  entry: "build/create-cli.js",
});

/**
 * Host-owned trusted dedicated CREATE definition for the adopted candidate.
 * Fresh frozen copy on every call. Category is exactly `write` so only a
 * dedicated `["write"]` connector gate can ever enable it.
 */
export function getCreateWriteDefinitions(): readonly McpBindingDefinition[] {
  const def: McpBindingDefinition = {
    upstreamTool: CREATE_WRITE_TOOL_NAME,
    canonicalSchemaHash: CREATE_WRITE_WIRE_HASH,
    category: "write" as const,
  };
  return Object.freeze([Object.freeze(def)]);
}

/** Strict opt-in env name selecting the host-owned dedicated create profile. */
export const CREATE_WRITE_PROFILE_ENV = "M6_CALENDAR_CREATE_PROFILE" as const;

/** Strict connection-hint env name (hints only, never authority). */
export const CREATE_WRITE_CONNECTOR_ENV = "M6_CREATE_CONNECTOR_JSON" as const;

/** The single adopted dedicated create profile name. */
export const CREATE_WRITE_PROFILE_NAME = "google-create" as const;

/**
 * Pinned fork account grammar for the configured create selector
 * (`M6_CREATE_ACCOUNT`, fork `validateAccountId`): lowercase ASCII
 * `[a-z0-9_-]{1,64}` — never a display name or email. Reserved device names
 * refused exactly like the provider. Case-sensitive, no normalization.
 */
export const CREATE_WRITE_ACCOUNT_PATTERN = /^[a-z0-9_-]{1,64}$/;
const CREATE_WRITE_RESERVED_ACCOUNTS: ReadonlySet<string> = new Set([
  ".",
  "..",
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "lpt1",
  "lpt2",
  "lpt3",
]);

/**
 * Env name carrying the custom readonly token path (same collision-guard
 * rule as the reschedule profile: the create child must see the ACTUAL
 * custom path when one is configured).
 */
export const CREATE_WRITE_READONLY_TOKEN_ENV =
  "GOOGLE_CALENDAR_MCP_READONLY_TOKEN_PATH" as const;

/** Logical (config-only) server id for the dedicated create connector. */
export const CREATE_WRITE_SERVER_ID = "create-write" as const;

function createProfileError(message: string): ServerConfigError {
  return new ServerConfigError(message);
}

/**
 * Strict create-profile selector: unset/empty means DISABLED (null).
 * Exactly `google-create` selects the adopted provider. Any other value
 * fails closed with a fixed message (never a silent disable).
 */
export function parseCreateWriteProfileName(
  raw: string | undefined,
): typeof CREATE_WRITE_PROFILE_NAME | null {
  if (raw === undefined || raw.length === 0) {
    return null;
  }
  if (raw === CREATE_WRITE_PROFILE_NAME) {
    return CREATE_WRITE_PROFILE_NAME;
  }
  throw createProfileError("unknown create write profile");
}

/** Frozen strict connection hint for the separate create stdio child. */
export interface CreateWriteConnectorHint {
  readonly command: string;
  readonly args: readonly string[];
  readonly envAllowlist: readonly string[];
}

const CREATE_COMMAND_PATTERN =
  /^([A-Za-z0-9_.-]+|[A-Za-z0-9_./-][A-Za-z0-9_./-]*)$/;
const CREATE_COMMAND_SHELL_CHARS = /[;&|$`><"']/;
function hasCreateCommandControlChar(command: string): boolean {
  for (let index = 0; index < command.length; index += 1) {
    const code = command.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}
function isCreateCommandShape(command: string): boolean {
  if (
    CREATE_COMMAND_SHELL_CHARS.test(command) ||
    hasCreateCommandControlChar(command)
  ) {
    return false;
  }
  if (win32Path.isAbsolute(command) || posixPath.isAbsolute(command)) {
    return true;
  }
  return CREATE_COMMAND_PATTERN.test(command);
}
const CREATE_ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
const CREATE_TEST_ENV_PREFIX = "M6_CREATE_TEST_";

/**
 * Strict connection-hint parser (shape only, never credential values).
 * Exact `{ command, args?, envAllowlist? }`: unknown keys rejected; command
 * is a 1..512 single executable; args at most 16 x 1024 chars; envAllowlist
 * at most 32 UPPER_SNAKE names. `M6_CREATE_TEST_*` names (fixture-only
 * bypass) are rejected. Missing input fails closed. Deep-frozen.
 */
export function parseCreateWriteConnectorHint(
  raw: string | undefined,
): CreateWriteConnectorHint {
  if (raw === undefined) {
    throw createProfileError("create write profile requires connector hints");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw createProfileError("create write connector hints are invalid");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw createProfileError("create write connector hints are invalid");
  }
  for (const key of Object.keys(parsed)) {
    if (key !== "command" && key !== "args" && key !== "envAllowlist") {
      throw createProfileError("create write connector hints are invalid");
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
    !isCreateCommandShape(command)
  ) {
    throw createProfileError("create write connector hints are invalid");
  }
  let args: readonly string[] = Object.freeze([]);
  if (record.args !== undefined) {
    if (!Array.isArray(record.args) || record.args.length > 16) {
      throw createProfileError("create write connector hints are invalid");
    }
    for (const entry of record.args) {
      if (
        typeof entry !== "string" ||
        entry.length > 1024 ||
        entry.includes("\0")
      ) {
        throw createProfileError("create write connector hints are invalid");
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
      throw createProfileError("create write connector hints are invalid");
    }
    for (const entry of record.envAllowlist) {
      if (
        typeof entry !== "string" ||
        !CREATE_ENV_NAME_PATTERN.test(entry) ||
        entry.startsWith(CREATE_TEST_ENV_PREFIX)
      ) {
        throw createProfileError(
          "create write connector env allowlist is invalid",
        );
      }
    }
    envAllowlist = Object.freeze([...(record.envAllowlist as string[])]);
  }
  return Object.freeze({ command, args, envAllowlist });
}

/**
 * Fail-closed configured-account / active-selection consistency (no I/O,
 * before any DB side effect). Mirrors the reschedule rule exactly.
 */
export function assertCreateWriteAccountCompatible(
  configuredAccount: string | undefined,
  selectionAccount: string | undefined,
): void {
  if (configuredAccount === undefined || configuredAccount.length === 0) {
    return;
  }
  if (
    !CREATE_WRITE_ACCOUNT_PATTERN.test(configuredAccount) ||
    CREATE_WRITE_RESERVED_ACCOUNTS.has(configuredAccount)
  ) {
    throw createProfileError("create write account is invalid");
  }
  if (
    selectionAccount !== undefined &&
    configuredAccount !== selectionAccount
  ) {
    throw createProfileError(
      "create write account does not match the active calendar selection",
    );
  }
}

/**
 * Fail-closed custom readonly-path visibility (no I/O, before any DB side
 * effect). Mirrors the reschedule rule exactly.
 */
export function assertCreateWriteReadonlyPathVisible(
  hint: CreateWriteConnectorHint,
  frozenEnv: Readonly<Record<string, string | undefined>>,
): void {
  const custom = frozenEnv[CREATE_WRITE_READONLY_TOKEN_ENV];
  if (custom === undefined || custom.length === 0) {
    return;
  }
  if (!hint.envAllowlist.includes(CREATE_WRITE_READONLY_TOKEN_ENV)) {
    throw createProfileError("create write connector env allowlist is invalid");
  }
}

/**
 * Fail-closed create hint preflight (no I/O, before any DB side effect).
 */
export function assertCreateWriteHintCompatible(hint: {
  readonly command: string;
}): void {
  if (hint.command.length === 0) {
    throw createProfileError("create write connector hints are invalid");
  }
}

/**
 * Build the DEDICATED create MCP connector config for the active Calendar
 * instance. Identity (`google-calendar-create` / `1.0.0-create.1`), the
 * single `create-event` binding hash, and the `write` category gate stay
 * host-pinned; only the stdio command line + env allowlist shape come from
 * the validated hint. Test-only identity override is options-injected,
 * never env; production never passes it.
 */
export function buildCreateWriteConnectorConfig(options: {
  readonly connectorInstanceId: string;
  readonly hint: CreateWriteConnectorHint;
  readonly testIdentity?: {
    readonly expectedServerName: string;
    readonly version: string;
  };
}): McpConnectorConfig {
  const allowUnpinned =
    options.testIdentity !== undefined &&
    CREATE_WRITE_WIRE_HASH.startsWith("0000");
  if (CREATE_WRITE_WIRE_HASH.startsWith("0000") && !allowUnpinned) {
    throw createProfileError("create write profile pin is not finalized");
  }
  const identity =
    options.testIdentity !== undefined
      ? options.testIdentity
      : {
          expectedServerName: CREATE_WRITE_SERVER_NAME,
          version: CREATE_WRITE_SERVER_VERSION,
        };
  if (
    identity.expectedServerName.length === 0 ||
    identity.expectedServerName.length > 128 ||
    identity.version.length === 0 ||
    identity.version.length > 64
  ) {
    throw createProfileError("create write connector hints are invalid");
  }
  return Object.freeze({
    connectorInstanceId: options.connectorInstanceId,
    serverId: CREATE_WRITE_SERVER_ID,
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
        upstreamTool: CREATE_WRITE_TOOL_NAME,
        canonicalSchemaHash: CREATE_WRITE_WIRE_HASH,
      }),
    ]),
    clientName: "companion-harness",
    clientVersion: "0.0.0",
  }) as McpConnectorConfig;
}
