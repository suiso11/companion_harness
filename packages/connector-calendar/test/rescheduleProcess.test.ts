// M5 real-process proof: an ACTUAL child-process MCP server over REAL stdio.
//
// DEFAULT (clean-clone-safe): spawns the TRACKED fixture server
// (`test/helpers/rescheduleFixtureServer.mjs`, identity
// `google-calendar-reschedule-test-fixture`) — no nested fork checkout, no
// unpublished dependency, no skip. EXPLICIT setup: set
// `M5_RESCHEDULE_FORK_CLI` to a built fork `build/reschedule-cli.js`
// (derived branch `feat/m5-reschedule-entrypoint-v2`, draft PR
// suiso11/google-calendar-mcp#3) to drive the REAL production entrypoint
// instead; a set-but-missing path is a HARD error (never a silent skip).
// Either target is driven over the REAL MCP stdio wire (SDK Client +
// StdioClientTransport) into a local Google-shaped loopback fixture.
// Production CLI never sets the endpoint-override flag, so production
// always uses the FIXED Google URL. No live Google, no OAuth, fixture
// data only, no imports from any ignored nested repo.

import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CALENDAR_ID = "primary";
const EVENT_ID = "evt-timed-1";
const ETAG_V1 = '"etag-v1"';

let fixture: Server | undefined;
let fixtureBase = "";
let etag = ETAG_V1;
let eventStart = "2026-02-01T10:00:00Z";
let eventEnd = "2026-02-01T11:00:00Z";
let patchCount = 0;
let lastIfMatch: string | undefined;
let lastBodyKeys: string[] = [];

async function startFixture(): Promise<string> {
  etag = ETAG_V1;
  eventStart = "2026-02-01T10:00:00Z";
  eventEnd = "2026-02-01T11:00:00Z";
  patchCount = 0;
  lastIfMatch = undefined;
  lastBodyKeys = [];
  fixture = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const match = /^\/calendar\/v3\/calendars\/([^/]+)\/events\/([^/]+)$/.exec(
      url.pathname,
    );
    if (match === null) {
      res.writeHead(404).end();
      return;
    }
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          id: EVENT_ID,
          etag,
          status: "confirmed",
          start: { dateTime: eventStart },
          end: { dateTime: eventEnd },
        }),
      );
      return;
    }
    if (req.method === "PATCH") {
      let raw = "";
      req.on("data", (chunk: Buffer) => {
        raw += chunk.toString("utf-8");
      });
      req.on("end", () => {
        lastIfMatch = req.headers["if-match"] as string | undefined;
        try {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          lastBodyKeys = Object.keys(parsed).sort();
          const s = (parsed.start as { dateTime?: unknown })?.dateTime;
          const e = (parsed.end as { dateTime?: unknown })?.dateTime;
          if (req.headers["if-match"] !== etag) {
            res.writeHead(412).end();
            return;
          }
          if (typeof s !== "string" || typeof e !== "string") {
            res.writeHead(400).end();
            return;
          }
          eventStart = s;
          eventEnd = e;
          patchCount += 1;
          res.writeHead(200, { "content-type": "application/json" }).end("{}");
        } catch {
          res.writeHead(400).end();
        }
      });
      return;
    }
    res.writeHead(405).end();
  });
  await new Promise<void>((resolve) => {
    fixture?.listen(0, "127.0.0.1", () => resolve());
  });
  const address = fixture?.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("fixture did not listen");
  }
  return `http://127.0.0.1:${(address as { port: number }).port}`;
}

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (fixture === undefined) {
      resolve();
      return;
    }
    fixture.close(() => resolve());
    fixture = undefined;
  });
});

beforeEach(async () => {
  fixtureBase = await startFixture();
});

type StdioTarget = {
  readonly command: string;
  readonly args: string[];
  readonly env: Record<string, string>;
  readonly label: string;
};

/** Strip undefined entries (child-process env must be string-valued). */
function cleanEnv(input: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

async function resolveStdioTarget(): Promise<StdioTarget> {
  // Explicit real-fork setup: M5_RESCHEDULE_FORK_CLI points at a built fork
  // `build/reschedule-cli.js`. Set-but-missing is a HARD error (never skip).
  const explicit = process.env.M5_RESCHEDULE_FORK_CLI ?? "";
  if (explicit.length > 0) {
    const { existsSync } = await import("node:fs");
    if (!existsSync(explicit)) {
      throw new Error(
        `explicit fork CLI missing: ${explicit} (build the derived fork branch feat/m5-reschedule-entrypoint-v2 first)`,
      );
    }
    return {
      command: process.execPath,
      args: [explicit],
      env: {
        ...cleanEnv(process.env),
        M5_RESCHEDULE_ACCOUNT: "test-account",
        M5_RESCHEDULE_CLIENT_ID: "test-client",
        M5_RESCHEDULE_CLIENT_SECRET: "test-secret",
        M5_RESCHEDULE_REFRESH_TOKEN: "test-refresh",
        M5_RESCHEDULE_GRANTED_SCOPE:
          "https://www.googleapis.com/auth/calendar.events",
        M5_RESCHEDULE_ACCESS_TOKEN: "fake-token-for-tests",
        M5_RESCHEDULE_TEST_ALLOW_ENDPOINT_OVERRIDE: "1",
        M5_RESCHEDULE_TEST_ENDPOINT_BASE: fixtureBase,
      },
      label: `explicit fork CLI ${explicit}`,
    };
  }
  // Default: TRACKED fixture server (clean-clone-safe, always runs).
  const helper = join(
    process.cwd(),
    "packages/connector-calendar/test/helpers/rescheduleFixtureServer.mjs",
  );
  const { existsSync } = await import("node:fs");
  if (!existsSync(helper)) {
    throw new Error("tracked fixture MCP server missing: test setup broken");
  }
  return {
    command: process.execPath,
    args: [helper],
    env: {
      ...cleanEnv(process.env),
      M5_RESCHEDULE_TEST_ENDPOINT_BASE: fixtureBase,
    },
    label: "tracked fixture MCP server",
  };
}

describe("real child-process MCP server over stdio", () => {
  it("patches start/end ONLY with exact If-Match; stale etag is definite_failure", async () => {
    const target = await resolveStdioTarget();
    // Spawn the REAL child-process MCP server over stdio.
    const transport = new StdioClientTransport({
      command: target.command,
      args: target.args,
      env: target.env,
      stderr: "pipe",
    });
    const client = new Client(
      { name: "test-harness", version: "0.0.0" },
      { capabilities: {} },
    );
    try {
      await client.connect(transport);
      // Separate-entrypoint shape: `reschedule-event` is served (both the
      // tracked fixture and the real fork bundle serve this contract).
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toContain(
        "reschedule-event",
      );
      const ok = (await client.callTool({
        name: "reschedule-event",
        arguments: {
          calendarId: CALENDAR_ID,
          eventId: EVENT_ID,
          start: "2026-03-01T10:00:00Z",
          end: "2026-03-01T11:00:00Z",
          expectedEtag: ETAG_V1,
        },
      })) as unknown as {
        content?: Array<{ type?: string; text?: string }>;
      };
      const okText = ok.content?.map((c) => c.text ?? "").join("") ?? "";
      expect(JSON.parse(okText)).toEqual({ status: "succeeded" });
      expect(patchCount).toBe(1);
      expect(lastIfMatch).toBe(ETAG_V1);
      expect(lastBodyKeys).toEqual(["end", "start"]);
      expect(eventStart).toBe("2026-03-01T10:00:00Z");

      const stale = (await client.callTool({
        name: "reschedule-event",
        arguments: {
          calendarId: CALENDAR_ID,
          eventId: EVENT_ID,
          start: "2026-04-01T10:00:00Z",
          end: "2026-04-01T11:00:00Z",
          expectedEtag: '"stale-etag"',
        },
      })) as unknown as {
        content?: Array<{ type?: string; text?: string }>;
      };
      const staleText = stale.content?.map((c) => c.text ?? "").join("") ?? "";
      expect(JSON.parse(staleText)).toEqual({
        status: "definite_failure",
        code: "etag_mismatch",
      });
      expect(patchCount).toBe(1);
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
});
