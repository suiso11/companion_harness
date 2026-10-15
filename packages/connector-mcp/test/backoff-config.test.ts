import { describe, expect, it } from "vitest";
import { mcpConnectorConfigSchema } from "../src/config.js";

const HASH = "a".repeat(64);

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    connectorInstanceId: "cal-1",
    serverId: "google-calendar-fork",
    kind: "mcp",
    expectedServerName: "google-calendar-fork",
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

describe("connector config (§17.3, §17.7)", () => {
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

  it("rejects ::1 Streamable HTTP host", () => {
    const bad = baseConfig({
      transport: { kind: "streamable-http", host: "::1", port: 8377 },
    });
    expect(() => mcpConnectorConfigSchema.parse(bad)).toThrow();
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

  it("requires an explicit expectedServerName (no default/inference)", () => {
    const missing: Record<string, unknown> = { ...baseConfig() };
    delete missing.expectedServerName;
    expect(() => mcpConnectorConfigSchema.parse(missing)).toThrow();
  });

  it("rejects an empty expectedServerName", () => {
    expect(() =>
      mcpConnectorConfigSchema.parse(baseConfig({ expectedServerName: "" })),
    ).toThrow();
  });

  it("requires the expected (reused) upstream version, no default", () => {
    const missing: Record<string, unknown> = { ...baseConfig() };
    delete missing.version;
    expect(() => mcpConnectorConfigSchema.parse(missing)).toThrow();
  });
});
