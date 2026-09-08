import { describe, expect, it } from "vitest";
import { nextBackoffMs } from "../src/backoff.js";
import { mcpConnectorConfigSchema, STDERR_CAP_BYTES } from "../src/config.js";
import { MCP_ERROR_CODES } from "../src/errors.js";

const HASH = "a".repeat(64);

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    connectorInstanceId: "cal-1",
    serverId: "google-calendar-fork",
    kind: "mcp",
    version: "0.0.0-proposed.1",
    transport: {
      kind: "stdio",
      command: "server-bin",
      args: [],
      envAllowlist: [],
    },
    bindings: [{ upstreamTool: "search-events", canonicalSchemaHash: HASH }],
    ...overrides,
  };
}

describe("reconnect backoff (§17.6 exact)", () => {
  it("follows 1s/2s/5s/10s/max-30s", () => {
    expect([1, 2, 3, 4, 5, 6, 99].map(nextBackoffMs)).toEqual([
      1000, 2000, 5000, 10000, 30000, 30000, 30000,
    ]);
  });
});

describe("connector config (§17.3, §17.7)", () => {
  it("accepts a stdio config with explicit bindings", () => {
    const parsed = mcpConnectorConfigSchema.parse(baseConfig());
    expect(parsed.bindings.map((b) => b.upstreamTool)).toEqual([
      "search-events",
    ]);
  });

  it("rejects non-loopback Streamable HTTP hosts", () => {
    const bad = baseConfig({
      transport: {
        kind: "streamable-http",
        host: "example.com",
        port: 80,
        path: "/mcp",
      },
    });
    expect(() => mcpConnectorConfigSchema.parse(bad)).toThrow();
  });

  it("accepts loopback hosts and pins redirects off", () => {
    for (const host of ["127.0.0.1", "localhost", "::1"]) {
      const parsed = mcpConnectorConfigSchema.parse(
        baseConfig({
          transport: { kind: "streamable-http", host, port: 8377 },
        }),
      );
      if (parsed.transport.kind === "streamable-http") {
        expect(parsed.transport.followRedirects).toBe(false);
      } else {
        expect.unreachable();
      }
    }
  });

  it("requires 64-hex canonical schema hashes for every binding", () => {
    const bad = baseConfig({
      bindings: [
        { upstreamTool: "search-events", canonicalSchemaHash: "not-a-hash" },
      ],
    });
    expect(() => mcpConnectorConfigSchema.parse(bad)).toThrow();
  });

  it("rejects empty bindings (default deny needs an explicit allowlist)", () => {
    expect(() =>
      mcpConnectorConfigSchema.parse(baseConfig({ bindings: [] })),
    ).toThrow();
  });
});

describe("fixed error codes (§17.8)", () => {
  it("exposes exactly the agreed lowercase codes", () => {
    expect([...MCP_ERROR_CODES]).toEqual([
      "mcp_unavailable",
      "mcp_binding_not_allowed",
      "mcp_schema_mismatch",
      "calendar_response_invalid",
      "calendar_upstream_error",
      "calendar_range_invalid",
    ]);
  });

  it("pins the 64KiB stderr cap", () => {
    expect(STDERR_CAP_BYTES).toBe(65536);
  });
});
