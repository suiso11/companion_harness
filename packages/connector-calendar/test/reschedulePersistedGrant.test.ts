// M5 persisted write-grant auth: REAL production-CLI proof (auth-parse level).
//
// Spawns the ACTUAL shipped fork entrypoint (`build/reschedule-cli.js`,
// `google-calendar-reschedule` / `1.0.0-reschedule.1`, tool
// `reschedule-event` ONLY) over REAL stdio and proves the persisted-grant
// file flow end to end WITHOUT any manual env secret copy and WITHOUT any
// Google contact:
//
// - the child env carries ONLY file paths + the account selector
//   (`M5_RESCHEDULE_ACCOUNT`, `M5_RESCHEDULE_WRITE_TOKEN_PATH`,
//   `GOOGLE_OAUTH_CREDENTIALS`); every `M5_RESCHEDULE_*` secret value
//   (`CLIENT_ID` / `CLIENT_SECRET` / `REFRESH_TOKEN` / `GRANTED_SCOPE` /
//   `ACCESS_TOKEN`) is explicitly REMOVED, so the proof fails if file mode
//   ever needs a secret copy;
// - the temp grant is written in the exact production file format
//   (`{ [account]: { refresh_token, scope, access_token, expiry_date } }`)
//   with the exact least-privilege scope and an UNEXPIRED access token, so
//   the CLI authorizes purely by parsing (no refresh network round-trip, no
//   PATCH dispatch — `tools/list` only);
// - `tools/list` over the real SDK wire must advertise exactly one tool
//   whose canonical schema hashes to the pinned `RESCHEDULE_WRITE_WIRE_HASH`;
// - negative boundaries (missing account, readonly-only scope, broad scope
//   alongside the exact token, grant for another account, partial env
//   credential WITH a valid grant file present, write/readonly token-path
//   collision) all exit non-zero BEFORE listening (`auth_refused`) and leave
//   the grant file byte-identical (no fallback, no clobber).
//
// Scope label (accurate): this is an AUTH-PARSE proof, not a refresh or
// pipeline proof. Refresh-before-dispatch against a live token endpoint and
// the approve -> PATCH -> receipt pipeline are covered by the fork's own
// bounded-refresh tests and the local-fixture harness suites
// (`rescheduleWriteStartup.test.ts`); the shipped CLI never accepts a test
// endpoint override, so no refresh/pipeline runs here by design.
//
// Opt-in: set `M5_RESCHEDULE_FORK_CLI` to the fork checkout root (or the
// built `build/reschedule-cli.js`). Unset (clean clone, no nested
// checkout) SKIPS — never a silent pass of a fake. Set-but-missing is a
// HARD error (never a silent skip). No live Google, no OAuth, no imports
// from any ignored nested repo (the CLI is spawned as a black-box child).

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
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  RESCHEDULE_WRITE_MCP_NAME,
  RESCHEDULE_WRITE_MCP_VERSION,
  RESCHEDULE_WRITE_TOOL,
  RESCHEDULE_WRITE_WIRE_HASH,
} from "../src/rescheduleWrite.js";

const WRITE_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const READONLY_SCOPE =
  "https://www.googleapis.com/auth/calendar.events.readonly";
const BROAD_SCOPE = "https://www.googleapis.com/auth/calendar";
const ACCOUNT = "proof-acct";
const OTHER_ACCOUNT = "other-acct";

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "companion-persisted-grant-"));
  tempDirs.push(dir);
  return dir;
}

/** Resolve the real shipped CLI (fork root or built file), or null to skip. */
function resolveForkCli(): string | null {
  const explicit = process.env.M5_RESCHEDULE_FORK_CLI ?? "";
  if (explicit.length === 0) return null;
  const cli = explicit.endsWith("reschedule-cli.js")
    ? explicit
    : join(explicit, "build", "reschedule-cli.js");
  if (!existsSync(cli)) {
    throw new Error(
      `explicit fork CLI missing: ${cli} (M5_RESCHEDULE_FORK_CLI must point at the fork root or its built build/reschedule-cli.js)`,
    );
  }
  return cli;
}

const FORK_CLI = resolveForkCli();
const describeIfFork = FORK_CLI === null ? describe.skip : describe;
if (FORK_CLI === null) {
  // Clean-clone path: the skip below keeps the suite green with no nested
  // checkout; the real-CLI proof runs wherever the fork is present.
}

function writeClientFile(dir: string): string {
  const path = join(dir, "gcp-oauth.keys.json");
  writeFileSync(
    path,
    JSON.stringify({
      client_id: "proof-client-id",
      client_secret: "proof-client-secret",
      redirect_uris: ["http://localhost:3000/oauth2callback"],
    }),
  );
  return path;
}

function writeGrantFile(
  dir: string,
  account: string,
  scope: string,
  fileName = "tokens.json",
): string {
  const path = join(dir, fileName);
  writeGrantFileAt(path, account, scope);
  return path;
}

function writeGrantFileAt(path: string, account: string, scope: string): void {
  writeFileSync(
    path,
    JSON.stringify({
      [account]: {
        refresh_token: "proof-refresh-token",
        scope,
        access_token: "proof-access-token",
        expiry_date: Date.now() + 3_600_000,
      },
    }),
  );
}

/**
 * File-only child env: the three wiring names plus the ambient process env,
 * with EVERY secret-carrying write-credential value and every fixture
 * bypass name explicitly removed. If file mode ever needs a secret copy,
 * the positive case fails here (the CLI cannot see what is absent).
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

function assertNoSecretWrites(env: Record<string, string>): void {
  for (const key of Object.keys(env)) {
    expect(key).not.toBe("M5_RESCHEDULE_CLIENT_ID");
    expect(key).not.toBe("M5_RESCHEDULE_CLIENT_SECRET");
    expect(key).not.toBe("M5_RESCHEDULE_REFRESH_TOKEN");
    expect(key).not.toBe("M5_RESCHEDULE_GRANTED_SCOPE");
    expect(key).not.toBe("M5_RESCHEDULE_ACCESS_TOKEN");
  }
  expect(env.M5_RESCHEDULE_ACCOUNT).toBe(ACCOUNT);
  expect(env.M5_RESCHEDULE_WRITE_TOKEN_PATH).toMatch(/tokens\.json$/);
  expect(env.GOOGLE_OAUTH_CREDENTIALS).toMatch(/gcp-oauth\.keys\.json$/);
}

/** Raw-spawn the CLI and wait for exit (negative paths never listen). */
async function spawnForExit(
  cli: string,
  env: Record<string, string>,
  timeoutMs = 30_000,
): Promise<{ code: number | null; stderr: string }> {
  const child: ChildProcess = spawn(process.execPath, [cli], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf-8");
  });
  const code = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Best effort.
      }
      resolve(null);
    }, timeoutMs);
    child.on("exit", (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
  return { code, stderr };
}

describeIfFork(
  "persisted write-grant auth over real production-CLI stdio",
  () => {
    it("serves tools/list from the persisted grant with file-only env (no secret copy)", async () => {
      const cli = FORK_CLI as string;
      const dir = tempDir();
      const clientFile = writeClientFile(dir);
      const tokenFile = writeGrantFile(dir, ACCOUNT, WRITE_SCOPE);
      const childEnv = fileOnlyChildEnv({
        M5_RESCHEDULE_ACCOUNT: ACCOUNT,
        M5_RESCHEDULE_WRITE_TOKEN_PATH: tokenFile,
        GOOGLE_OAUTH_CREDENTIALS: clientFile,
      });
      assertNoSecretWrites(childEnv);
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [cli],
        env: childEnv,
        stderr: "pipe",
      });
      const client = new Client(
        { name: "persisted-grant-proof", version: "0.0.0" },
        { capabilities: {} },
      );
      try {
        await client.connect(transport);
        const version = client.getServerVersion();
        expect(version?.name).toBe(RESCHEDULE_WRITE_MCP_NAME);
        expect(version?.version).toBe(RESCHEDULE_WRITE_MCP_VERSION);
        const listed = await client.listTools();
        expect(listed.tools.map((tool) => tool.name)).toEqual([
          RESCHEDULE_WRITE_TOOL,
        ]);
        const schema = listed.tools[0]?.inputSchema;
        expect(schema).toBeDefined();
        // Live-wire reprobe: the shipped persisted-grant CLI advertises the
        // pinned schema bytes (conversion + auth work left the wire alone).
        expect(await canonicalSchemaHash(schema)).toBe(
          RESCHEDULE_WRITE_WIRE_HASH,
        );
      } finally {
        try {
          await client.close();
        } catch {
          // Best effort.
        }
        try {
          await transport.close();
        } catch {
          // Best effort.
        }
      }
    }, 60_000);

    it("refuses a missing account before listening (grant file untouched)", async () => {
      const cli = FORK_CLI as string;
      const dir = tempDir();
      const clientFile = writeClientFile(dir);
      const tokenFile = writeGrantFile(dir, ACCOUNT, WRITE_SCOPE);
      const before = readFileSync(tokenFile, "utf-8");
      const childEnv = fileOnlyChildEnv({
        M5_RESCHEDULE_WRITE_TOKEN_PATH: tokenFile,
        GOOGLE_OAUTH_CREDENTIALS: clientFile,
      });
      delete childEnv.M5_RESCHEDULE_ACCOUNT;
      const { code, stderr } = await spawnForExit(cli, childEnv);
      expect(code).toBe(2);
      expect(stderr).toMatch(/auth_refused/);
      expect(readFileSync(tokenFile, "utf-8")).toBe(before);
    }, 60_000);

    it("refuses a readonly-only grant before listening (grant file untouched)", async () => {
      const cli = FORK_CLI as string;
      const dir = tempDir();
      const clientFile = writeClientFile(dir);
      const tokenFile = writeGrantFile(dir, ACCOUNT, READONLY_SCOPE);
      const before = readFileSync(tokenFile, "utf-8");
      const childEnv = fileOnlyChildEnv({
        M5_RESCHEDULE_ACCOUNT: ACCOUNT,
        M5_RESCHEDULE_WRITE_TOKEN_PATH: tokenFile,
        GOOGLE_OAUTH_CREDENTIALS: clientFile,
      });
      const { code, stderr } = await spawnForExit(cli, childEnv);
      expect(code).toBe(2);
      expect(stderr).toMatch(/auth_refused/);
      expect(readFileSync(tokenFile, "utf-8")).toBe(before);
    }, 60_000);

    it("refuses a broad scope alongside the exact token (grant file untouched)", async () => {
      const cli = FORK_CLI as string;
      const dir = tempDir();
      const clientFile = writeClientFile(dir);
      const tokenFile = writeGrantFile(
        dir,
        ACCOUNT,
        `${WRITE_SCOPE} ${BROAD_SCOPE}`,
      );
      const before = readFileSync(tokenFile, "utf-8");
      const childEnv = fileOnlyChildEnv({
        M5_RESCHEDULE_ACCOUNT: ACCOUNT,
        M5_RESCHEDULE_WRITE_TOKEN_PATH: tokenFile,
        GOOGLE_OAUTH_CREDENTIALS: clientFile,
      });
      const { code, stderr } = await spawnForExit(cli, childEnv);
      expect(code).toBe(2);
      expect(stderr).toMatch(/auth_refused/);
      expect(readFileSync(tokenFile, "utf-8")).toBe(before);
    }, 60_000);

    it("refuses a grant stored under another account (grant file untouched)", async () => {
      const cli = FORK_CLI as string;
      const dir = tempDir();
      const clientFile = writeClientFile(dir);
      const tokenFile = writeGrantFile(dir, OTHER_ACCOUNT, WRITE_SCOPE);
      const before = readFileSync(tokenFile, "utf-8");
      const childEnv = fileOnlyChildEnv({
        M5_RESCHEDULE_ACCOUNT: ACCOUNT,
        M5_RESCHEDULE_WRITE_TOKEN_PATH: tokenFile,
        GOOGLE_OAUTH_CREDENTIALS: clientFile,
      });
      const { code, stderr } = await spawnForExit(cli, childEnv);
      expect(code).toBe(2);
      expect(stderr).toMatch(/auth_refused/);
      expect(readFileSync(tokenFile, "utf-8")).toBe(before);
    }, 60_000);

    it("refuses a partial env credential without falling through to a valid grant file", async () => {
      const cli = FORK_CLI as string;
      const dir = tempDir();
      const clientFile = writeClientFile(dir);
      const tokenFile = writeGrantFile(dir, ACCOUNT, WRITE_SCOPE);
      const before = readFileSync(tokenFile, "utf-8");
      // Any single explicit credential value counts as an explicit (partial)
      // env credential: it must refuse WITHOUT file fallthrough, even though
      // the grant file on disk is fully valid.
      const childEnv = fileOnlyChildEnv({
        M5_RESCHEDULE_ACCOUNT: ACCOUNT,
        M5_RESCHEDULE_WRITE_TOKEN_PATH: tokenFile,
        GOOGLE_OAUTH_CREDENTIALS: clientFile,
        M5_RESCHEDULE_CLIENT_ID: "partial-client-id",
      });
      const { code, stderr } = await spawnForExit(cli, childEnv);
      expect(code).toBe(2);
      expect(stderr).toMatch(/auth_refused/);
      expect(readFileSync(tokenFile, "utf-8")).toBe(before);
    }, 60_000);

    it("refuses a write/readonly token-path collision before listening", async () => {
      const cli = FORK_CLI as string;
      const dir = tempDir();
      const clientFile = writeClientFile(dir);
      const tokenFile = writeGrantFile(dir, ACCOUNT, WRITE_SCOPE);
      const before = readFileSync(tokenFile, "utf-8");
      const childEnv = fileOnlyChildEnv({
        M5_RESCHEDULE_ACCOUNT: ACCOUNT,
        M5_RESCHEDULE_WRITE_TOKEN_PATH: tokenFile,
        GOOGLE_OAUTH_CREDENTIALS: clientFile,
        GOOGLE_CALENDAR_MCP_READONLY_TOKEN_PATH: tokenFile,
      });
      const { code, stderr } = await spawnForExit(cli, childEnv);
      expect(code).toBe(2);
      expect(stderr).toMatch(/auth_refused/);
      expect(readFileSync(tokenFile, "utf-8")).toBe(before);
    }, 60_000);
  },
);
