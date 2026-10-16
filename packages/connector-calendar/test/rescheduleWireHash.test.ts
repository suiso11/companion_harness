// M5 dedicated write identity: LIVE-WIRE schema hash pin proof.
//
// Spawns the TRACKED fixture MCP server (contract mirror of the real fork
// entrypoint) over REAL stdio, lists tools, and asserts the advertised
// `reschedule-event` input schema hashes to the pinned
// `RESCHEDULE_WRITE_WIRE_HASH` via the REAL `canonicalSchemaHash`. The real
// fork bundle was probed once during development (identical bytes/hash) via
// explicit `M5_RESCHEDULE_FORK_CLI`; this test pins the contract with the
// tracked double so it passes on a clean clone with no nested checkout.
// No live Google, no OAuth, fixture data only.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalSchemaHash } from "@companion/connector-mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import {
  RESCHEDULE_WRITE_MCP_NAME,
  RESCHEDULE_WRITE_MCP_VERSION,
  RESCHEDULE_WRITE_TOOL,
  RESCHEDULE_WRITE_WIRE_HASH,
} from "../src/rescheduleWrite.js";

const HELPER = join(
  dirname(fileURLToPath(import.meta.url)),
  "helpers",
  "rescheduleFixtureServer.mjs",
);

describe("dedicated reschedule wire identity (real stdio probe)", () => {
  it("advertises reschedule-event with the pinned live-wire schema hash", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [HELPER],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([, value]) => value !== undefined,
          ) as Array<[string, string]>,
        ),
        M5_RESCHEDULE_TEST_ENDPOINT_BASE: "http://127.0.0.1:9",
      },
      stderr: "pipe",
    });
    const client = new Client(
      { name: "test-harness", version: "0.0.0" },
      { capabilities: {} },
    );
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name);
      expect(names).toEqual([RESCHEDULE_WRITE_TOOL]);
      const schema = listed.tools[0]?.inputSchema;
      expect(schema).toBeDefined();
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

  it("pins the dedicated (never readonly) entrypoint identity constants", () => {
    expect(RESCHEDULE_WRITE_MCP_NAME).toBe("google-calendar-reschedule");
    expect(RESCHEDULE_WRITE_MCP_VERSION).toBe("1.0.0-reschedule.1");
    expect(RESCHEDULE_WRITE_TOOL).toBe("reschedule-event");
    expect(RESCHEDULE_WRITE_MCP_NAME).not.toBe("google-calendar");
    expect(RESCHEDULE_WRITE_WIRE_HASH).toMatch(/^[0-9a-f]{64}$/);
  });
});
