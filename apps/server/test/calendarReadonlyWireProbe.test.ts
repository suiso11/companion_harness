// Readonly live-wire pin proof: REAL fork readonly entry over REAL stdio.
//
// Spawns the ACTUAL shipped fork readonly entrypoint (`build/index.js`,
// `google-calendar` / `3.0.0-readonly.2`, tools
// `list-events` / `search-events` / `get-event`) over REAL stdio and proves
// the adopted pin end to end WITHOUT any live Google contact and WITHOUT
// any user secrets:
//
// - the child env carries ONLY file paths + the account selector
//   (`GOOGLE_ACCOUNT_MODE`, `GOOGLE_CALENDAR_MCP_READONLY_TOKEN_PATH`,
//   `GOOGLE_OAUTH_CREDENTIALS`); every `M5_RESCHEDULE_*` secret value and
//   every `M5_RESCHEDULE_TEST_*` bypass name is explicitly REMOVED;
// - the temp grant is written in the exact production multi-account file
//   format with the exact readonly scope and an UNEXPIRED access token, so
//   the server authorizes purely by parsing (no refresh round-trip) and
//   `tools/list` is served with zero Google I/O;
// - the raw JSON-RPC handshake pins protocol `2024-11-05` (the version the
//   fork speaks); `tools/list` over the real SDK wire must advertise exactly
//   the three pinned tools whose canonical schemas hash — via the REAL host
//   `canonicalSchemaHash` — to the pinned `GOOGLE_READONLY_WIRE_HASHES`;
// - the listed hashes must DIFFER from the superseded 6939311 list/search
//   literals (hardcoded below, never regenerated from a fixture), proving
//   the old multi-account schema no longer verifies;
// - the temp grant file stays byte-identical (the probe never rewrites it).
//
// Opt-in: set `M5_RESCHEDULE_FORK_CLI` to the fork checkout root (or a built
// `build/index.js`; the same fork root also hosts `build/reschedule-cli.js`).
// Unset (clean clone, no nested checkout) SKIPS — never a silent pass of a
// fake. Set-but-missing is a HARD error (never a silent skip). No live
// Google, no OAuth, no imports from any ignored nested repo (the entry is
// spawned as a black-box child).

import { type ChildProcess, spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalSchemaHash } from "@companion/connector-mcp";
import { afterEach, describe, expect, it } from "vitest";
import {
  GOOGLE_READONLY_FORK,
  GOOGLE_READONLY_TOOLS,
  GOOGLE_READONLY_WIRE_HASHES,
} from "../src/calendarReadonlyProfile.js";

const READONLY_SCOPE =
  "https://www.googleapis.com/auth/calendar.events.readonly";
const ACCOUNT = "wire-proof-acct";
const PROTOCOL_VERSION = "2024-11-05";

// Superseded 6939311 live-wire literals (multi-account `account` schema).
// Hardcoded from the previous pin — never computed from a live fixture.
const SUPERSEDED_HASHES: Record<string, string> = {
  "list-events":
    "81222b89482cba77b12a707c2097c66df383cab7929c14dca03cc303846d794c",
  "search-events":
    "d48ba36e7f280d92eaba9550323e90aa7a6d7c758812932ad62012f4514558b7",
};

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "companion-readonly-wire-"));
  tempDirs.push(dir);
  return dir;
}

/** Resolve the real shipped readonly entry, or null to skip. */
function resolveForkEntry(): string | null {
  const explicit = process.env.M5_RESCHEDULE_FORK_CLI ?? "";
  if (explicit.length === 0) return null;
  const entry = explicit.endsWith("index.js")
    ? explicit
    : join(explicit, "build", "index.js");
  if (!existsSync(entry)) {
    throw new Error(
      `explicit fork entry missing: ${entry} (M5_RESCHEDULE_FORK_CLI must point at the fork root or its built build/index.js)`,
    );
  }
  return entry;
}

const FORK_ENTRY = resolveForkEntry();
const describeIfFork = FORK_ENTRY === null ? describe.skip : describe;

function writeClientFile(dir: string): string {
  const path = join(dir, "gcp-oauth.keys.json");
  writeFileSync(
    path,
    JSON.stringify({
      installed: {
        client_id: "proof-client-id",
        client_secret: "proof-client-secret",
        redirect_uris: ["http://localhost:3000/oauth2callback"],
      },
    }),
  );
  return path;
}

function writeGrantFile(dir: string): string {
  const path = join(dir, "tokens.json");
  writeFileSync(
    path,
    JSON.stringify({
      [ACCOUNT]: {
        refresh_token: "proof-refresh-token",
        scope: READONLY_SCOPE,
        access_token: "proof-access-token",
        expiry_date: Date.now() + 3_600_000,
      },
    }),
  );
  return path;
}

/**
 * File-only child env: ambient process env with EVERY secret-carrying
 * credential value and every fixture-bypass name explicitly removed, plus
 * the three file-wiring names. If file mode ever needs a secret copy, the
 * positive case fails here (the server cannot see what is absent).
 */
function fileOnlyChildEnv(
  extra: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (
      key === "M5_RESCHEDULE_CLIENT_ID" ||
      key === "M5_RESCHEDULE_CLIENT_SECRET" ||
      key === "M5_RESCHEDULE_REFRESH_TOKEN" ||
      key === "M5_RESCHEDULE_GRANTED_SCOPE" ||
      key === "M5_RESCHEDULE_ACCESS_TOKEN" ||
      key.startsWith("M5_RESCHEDULE_TEST_")
    ) {
      continue;
    }
    env[key] = value;
  }
  return { ...env, ...extra };
}

interface ToolsListResult {
  serverName: string;
  serverVersion: string;
  tools: { name: string; inputSchema: unknown }[];
}

/** Speak raw JSON-RPC to the real entry and return the tools/list result. */
async function listToolsRaw(
  entry: string,
  env: Record<string, string>,
  timeoutMs = 30_000,
): Promise<ToolsListResult> {
  const child: ChildProcess = spawn(
    process.execPath,
    [entry, "--enable-tools", [...GOOGLE_READONLY_TOOLS].join(",")],
    {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stdout = "";
  const pending = { serverName: "", serverVersion: "" };
  const done = new Promise<ToolsListResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("timed out waiting for tools/list"));
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
      for (const line of stdout.split("\n")) {
        let message: {
          id?: unknown;
          result?: {
            protocolVersion?: unknown;
            serverInfo?: { name?: unknown; version?: unknown };
            tools?: { name?: unknown; inputSchema?: unknown }[];
          };
        };
        try {
          message = JSON.parse(line) as typeof message;
        } catch {
          continue;
        }
        if (message.id === 1) {
          const info = message.result?.serverInfo;
          if (
            typeof info?.name !== "string" ||
            typeof info?.version !== "string"
          ) {
            clearTimeout(timer);
            reject(new Error("initialize response missing serverInfo"));
            return;
          }
          pending.serverName = info.name;
          pending.serverVersion = info.version;
          continue;
        }
        if (message.id === 2) {
          const tools = message.result?.tools;
          if (!Array.isArray(tools)) {
            clearTimeout(timer);
            reject(new Error("tools/list response missing tools"));
            return;
          }
          clearTimeout(timer);
          resolve({
            serverName: pending.serverName,
            serverVersion: pending.serverVersion,
            tools: tools.map((tool) => ({
              name: String(tool.name),
              inputSchema: tool.inputSchema,
            })),
          });
          return;
        }
      }
    });
    child.on("error", (cause) => {
      clearTimeout(timer);
      reject(cause);
    });
    child.on("exit", () => {
      clearTimeout(timer);
      reject(new Error("server exited before tools/list"));
    });
  });
  try {
    child.stdin?.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "wire-proof", version: "0.0.0" },
        },
      })}\n`,
    );
    child.stdin?.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    child.stdin?.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`,
    );
    return await done;
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // Best effort.
    }
  }
}

describeIfFork("readonly live-wire pin over real fork stdio", () => {
  it("advertises exactly the 3 pinned tools with the pinned live-wire hashes", async () => {
    const entry = FORK_ENTRY as string;
    const dir = tempDir();
    const clientFile = writeClientFile(dir);
    const tokenFile = writeGrantFile(dir);
    const before = readFileSync(tokenFile);
    const childEnv = fileOnlyChildEnv({
      GOOGLE_ACCOUNT_MODE: ACCOUNT,
      GOOGLE_CALENDAR_MCP_READONLY_TOKEN_PATH: tokenFile,
      GOOGLE_OAUTH_CREDENTIALS: clientFile,
    });
    for (const banned of [
      "M5_RESCHEDULE_CLIENT_ID",
      "M5_RESCHEDULE_CLIENT_SECRET",
      "M5_RESCHEDULE_REFRESH_TOKEN",
      "M5_RESCHEDULE_GRANTED_SCOPE",
      "M5_RESCHEDULE_ACCESS_TOKEN",
    ]) {
      expect(childEnv[banned]).toBeUndefined();
    }
    expect(childEnv.GOOGLE_ACCOUNT_MODE).toBe(ACCOUNT);

    const listed = await listToolsRaw(entry, childEnv);
    expect(listed.serverName).toBe(GOOGLE_READONLY_FORK.serverName);
    expect(listed.serverVersion).toBe(GOOGLE_READONLY_FORK.version);
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual(
      [...GOOGLE_READONLY_TOOLS].sort(),
    );
    for (const tool of listed.tools) {
      const expected = GOOGLE_READONLY_WIRE_HASHES[tool.name] as string;
      expect(expected).toMatch(/^[0-9a-f]{64}$/);
      expect(await canonicalSchemaHash(tool.inputSchema)).toBe(expected);
      const superseded = SUPERSEDED_HASHES[tool.name];
      if (superseded !== undefined) {
        expect(await canonicalSchemaHash(tool.inputSchema)).not.toBe(
          superseded,
        );
      }
    }
    // The probe is read-only against the grant: no rewrite, no clobber.
    expect(readFileSync(tokenFile).equals(before)).toBe(true);
  }, 60_000);
});
