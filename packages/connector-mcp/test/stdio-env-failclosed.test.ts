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
  startupEnvTransportFactory,
} from "../src/client.js";
import {
  type McpBindingDefinition,
  type McpConnectorConfig,
  mcpConnectorConfigSchema,
} from "../src/config.js";

const HASH = "c".repeat(64);

/**
 * SOURCE-REVIEWED host fixture definition: the synthetic `search-events`
 * binding in this file is a static read handler, so the trusted definition
 * marks it explicitly `read` with an explicitly written hash — never inferred
 * from the connector config.
 */
function readDefinition(
  upstreamTool: string,
  schemaHash: string,
): McpBindingDefinition {
  return { upstreamTool, canonicalSchemaHash: schemaHash, category: "read" };
}

function stdioConfig(envAllowlist: string[]): McpConnectorConfig {
  return mcpConnectorConfigSchema.parse({
    connectorInstanceId: "cal-1",
    serverId: "fake",
    kind: "mcp" as const,
    expectedServerName: "fake-calendar",
    version: "0.0.0",
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
    expect(() => assertStdioEnvClosed(config)).toThrow("mcp_unavailable");
    expect(() => defaultTransportFactory(config)).toThrow("mcp_unavailable");

    let factoryCalls = 0;
    const countingFactory = (_c: unknown) => {
      factoryCalls += 1;
      throw new Error("must not be constructed");
    };
    const connector = new McpConnector(
      config,
      [readDefinition("search-events", HASH)],
      countingFactory as never,
    );
    const ensured = await connector.ensureConnected();
    expect(ensured).toEqual({ ok: false, code: "mcp_unavailable" });
    expect(factoryCalls).toBe(0);
    const res = await connector.callTool("search-events", { q: "x" });
    expect(res).toEqual({ ok: false, code: "mcp_unavailable" });
    expect(factoryCalls).toBe(0);
    // Fixed code only: no env values in the thrown message.
    try {
      assertStdioEnvClosed(config);
      expect.unreachable();
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("mcp_unavailable");
      expect(msg).not.toContain("secret");
    }
  });

  it("allows explicit full-default allowlist through the guard", () => {
    const config = stdioConfig([...STDIO_IMPLICIT_ENV_VARS]);
    expect(missingStdioEnvNames(config)).toEqual([]);
    expect(() => assertStdioEnvClosed(config)).not.toThrow();
  });

  it("startup snapshot factory sources child env from the snapshot, not live process.env", () => {
    const marker = "COMPANION_WRITE_CHILD_MARKER";
    const config = stdioConfig([...STDIO_IMPLICIT_ENV_VARS, marker]);
    const previous = process.env[marker];
    process.env[marker] = "live-process-value";
    try {
      const fromSnapshot = startupEnvTransportFactory({
        [marker]: "startup-snapshot-value",
      })(config) as unknown as {
        _serverParams: { env: Record<string, string> };
      };
      expect(fromSnapshot._serverParams.env[marker]).toBe(
        "startup-snapshot-value",
      );
      const absent = startupEnvTransportFactory({})(config) as unknown as {
        _serverParams: { env: Record<string, string> };
      };
      expect(marker in absent._serverParams.env).toBe(false);
    } finally {
      if (previous === undefined) delete process.env[marker];
      else process.env[marker] = previous;
    }
  });
});
