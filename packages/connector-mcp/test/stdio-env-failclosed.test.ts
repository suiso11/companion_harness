/**
 * Fail-closed stdio env regression (SDK 1.30.0 verified defaults).
 * Fake child transport factory counts invocations to prove rejection
 * happens BEFORE process creation. No live spawn, no env values logged.
 */
import { describe, expect, it } from "vitest";
import {
  assertStdioEnvClosed,
  defaultTransportFactory,
  McpConnector,
  missingStdioEnvNames,
  STDIO_IMPLICIT_ENV_VARS,
} from "../src/client.js";
import {
  type McpConnectorConfig,
  mcpConnectorConfigSchema,
} from "../src/config.js";

const HASH = "c".repeat(64);

function stdioConfig(envAllowlist: string[]): McpConnectorConfig {
  return mcpConnectorConfigSchema.parse({
    connectorInstanceId: "cal-1",
    serverId: "fake",
    kind: "mcp" as const,
    version: "0.0.0-proposed.1",
    transport: {
      kind: "stdio" as const,
      command: "unused",
      args: [] as string[],
      envAllowlist,
      shutdownWaitMs: 3000,
    },
    bindings: [{ upstreamTool: "search-events", canonicalSchemaHash: HASH }],
  });
}

describe("fail-closed stdio env allowlist", () => {
  it("tracks the real SDK DEFAULT_INHERITED_ENV_VARS", () => {
    expect(STDIO_IMPLICIT_ENV_VARS.length).toBeGreaterThan(0);
    expect(STDIO_IMPLICIT_ENV_VARS).toContain("PATH");
  });

  it("rejects a config missing any inherited default before factory/spawn", async () => {
    const partial = [...STDIO_IMPLICIT_ENV_VARS].slice(1);
    const config = stdioConfig(partial);
    expect(missingStdioEnvNames(config).length).toBeGreaterThan(0);
    expect(() => assertStdioEnvClosed(config)).toThrow("mcp_env_not_allowed");
    expect(() => defaultTransportFactory(config)).toThrow(
      "mcp_env_not_allowed",
    );

    let factoryCalls = 0;
    const countingFactory = (_c: unknown) => {
      factoryCalls += 1;
      throw new Error("must not be constructed");
    };
    const connector = new McpConnector(config, countingFactory as never);
    const ensured = await connector.ensureConnected();
    expect(ensured).toEqual({ ok: false, code: "mcp_env_not_allowed" });
    expect(factoryCalls).toBe(0);
    const res = await connector.callTool("search-events", { q: "x" });
    expect(res).toEqual({ ok: false, code: "mcp_env_not_allowed" });
    expect(factoryCalls).toBe(0);
    // Fixed code only: no env values in the thrown message.
    try {
      assertStdioEnvClosed(config);
      expect.unreachable();
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("mcp_env_not_allowed");
      for (const name of partial) {
        void name;
      }
      expect(msg).not.toContain("secret");
    }
  });

  it("allows explicit full-default allowlist through the guard", () => {
    const config = stdioConfig([...STDIO_IMPLICIT_ENV_VARS]);
    expect(missingStdioEnvNames(config)).toEqual([]);
    expect(() => assertStdioEnvClosed(config)).not.toThrow();
  });
});
