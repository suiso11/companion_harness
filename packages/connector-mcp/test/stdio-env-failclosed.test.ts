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
      // Deterministic frozen snapshot: every inherited name carries a live
      // value when inheritable, else a fixed frozen stand-in (CI workers may
      // lack e.g. TERM, and shell-function exports are never inheritable).
      const frozen: Record<string, string | undefined> = {};
      for (const name of STDIO_IMPLICIT_ENV_VARS) {
        const live = process.env[name];
        frozen[name] =
          live !== undefined && !live.startsWith("()")
            ? live
            : `frozen-${name}`;
      }
      frozen[marker] = "startup-snapshot-value";
      const fromSnapshot = startupEnvTransportFactory(frozen)(
        config,
      ) as unknown as {
        _serverParams: { env: Record<string, string> };
      };
      expect(fromSnapshot._serverParams.env[marker]).toBe(
        "startup-snapshot-value",
      );
      expect(() => startupEnvTransportFactory({})(config)).toThrow(
        /mcp_unavailable: stdio startup env misses/,
      );
    } finally {
      if (previous === undefined) delete process.env[marker];
      else process.env[marker] = previous;
    }
  });

  it("rejects a frozen snapshot missing an allowlisted inherited value before construction", () => {
    // The allowlist is complete, so `assertStdioEnvClosed` passes: it is the
    // NEW frozen-inherited freeze that rejects (no live-env fallback that a
    // post-startup PATH mutation could exploit to select another binary).
    const config = stdioConfig([...STDIO_IMPLICIT_ENV_VARS]);
    expect(() => assertStdioEnvClosed(config)).not.toThrow();
    const frozen: Record<string, string | undefined> = {};
    for (const name of STDIO_IMPLICIT_ENV_VARS) {
      if (name !== "PATH") frozen[name] = `frozen-${name}`;
    }
    expect(() => startupEnvTransportFactory(frozen)(config)).toThrow(
      /mcp_unavailable: stdio startup env misses 1 frozen inherited value\(s\): PATH/,
    );
  });

  it("never passes a frozen shell-function export through to the child", () => {
    // The SDK `getDefaultEnvironment()` deliberately skips `()...` values;
    // the frozen factory must fail closed instead of propagating them.
    const config = stdioConfig([...STDIO_IMPLICIT_ENV_VARS]);
    const frozen: Record<string, string | undefined> = {};
    for (const name of STDIO_IMPLICIT_ENV_VARS) {
      frozen[name] = name === "PATH" ? "() evil-function" : `frozen-${name}`;
    }
    expect(() => startupEnvTransportFactory(frozen)(config)).toThrow(
      /mcp_unavailable: stdio startup env misses/,
    );
  });

  it("a real child sees frozen values despite later live process.env mutations", async () => {
    // Meaningful spawn (not `_serverParams` inspection): the factory builds
    // a REAL StdioClientTransport whose child reports its env over piped
    // stderr. Mutations AFTER the freeze must not leak into the child, and a
    // bare command keeps resolving through the FROZEN PATH.
    const marker = "COMPANION_WRITE_CHILD_MARKER";
    const script = `process.stderr.write(JSON.stringify({marker:process.env[${JSON.stringify(marker)}] ?? null,path:process.env.PATH ?? null}));process.exit(0);`;
    const config = mcpConnectorConfigSchema.parse({
      connectorInstanceId: "cal-1",
      serverId: "fake",
      kind: "mcp" as const,
      expectedServerName: "fake-calendar",
      version: "0.0.0",
      transport: {
        kind: "stdio" as const,
        command: process.execPath,
        args: ["-e", script],
        envAllowlist: [...STDIO_IMPLICIT_ENV_VARS, marker],
        shutdownWaitMs: 3000,
      },
      bindings: [{ upstreamTool: "search-events", canonicalSchemaHash: HASH }],
    });
    const frozenPath = process.env.PATH;
    const frozen: Record<string, string | undefined> = {};
    for (const name of STDIO_IMPLICIT_ENV_VARS) {
      const live = process.env[name];
      frozen[name] =
        live !== undefined && !live.startsWith("()") ? live : `frozen-${name}`;
    }
    frozen[marker] = "frozen-marker-value";
    const previousMarker = process.env[marker];
    const previousPath = process.env.PATH;
    process.env[marker] = "live-marker-value";
    process.env.PATH = "/evil-post-startup-path";
    const transport = startupEnvTransportFactory(frozen)(config) as unknown as {
      start: () => Promise<void>;
      close: () => Promise<void>;
      readonly stderr: NodeJS.ReadableStream | null;
    };
    try {
      let stderrText = "";
      transport.stderr?.on("data", (chunk: Buffer) => {
        stderrText += chunk.toString("utf-8");
      });
      await transport.start();
      const deadline = Date.now() + 5000;
      while (stderrText.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const reported = JSON.parse(stderrText) as {
        marker: string | null;
        path: string | null;
      };
      expect(reported.marker).toBe("frozen-marker-value");
      expect(reported.path).toBe(frozenPath ?? null);
    } finally {
      await transport.close().catch(() => undefined);
      if (previousMarker === undefined) delete process.env[marker];
      else process.env[marker] = previousMarker;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it("resolves Windows env casing to the single canonical inherited name", () => {
    // `process.platform` is configurable in this runtime: stub posix then
    // win32, prove each freeze branch, then restore (finally, no leaks).
    const descriptor = Object.getOwnPropertyDescriptor(
      process,
      "platform",
    ) as PropertyDescriptor;
    // Frozen snapshot carries `path` (lowercase); the SDK default is `PATH`.
    const frozen: Record<string, string | undefined> = {};
    for (const name of STDIO_IMPLICIT_ENV_VARS) {
      frozen[name === "PATH" ? "path" : name] = `frozen-${name}`;
    }
    const config = stdioConfig([...STDIO_IMPLICIT_ENV_VARS]);
    // posix: exact case required, so the lowercase snapshot rejects. The
    // runner itself may be win32 (case-insensitive env block), so stub a
    // posix platform explicitly instead of relying on the host platform.
    Object.defineProperty(process, "platform", {
      value: "linux",
      configurable: true,
    });
    try {
      expect(() => startupEnvTransportFactory(frozen)(config)).toThrow(
        /mcp_unavailable: stdio startup env misses/,
      );
    } finally {
      Object.defineProperty(process, "platform", {
        value: descriptor.value,
        configurable: true,
      });
    }
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true,
    });
    try {
      // win32: the allowlist covers `PATH` via `Path`, and the frozen
      // `path` value lands on the single canonical `PATH` key (never both
      // keys, so the live default cannot survive the merge).
      expect(() =>
        assertStdioEnvClosed(
          stdioConfig([
            ...STDIO_IMPLICIT_ENV_VARS.filter((name) => name !== "PATH"),
            "Path",
          ]),
        ),
      ).not.toThrow();
      const winTransport = startupEnvTransportFactory(frozen)(
        config,
      ) as unknown as {
        _serverParams: { env: Record<string, string> };
      };
      expect(winTransport._serverParams.env.PATH).toBe("frozen-PATH");
      expect("path" in winTransport._serverParams.env).toBe(false);
    } finally {
      Object.defineProperty(process, "platform", {
        value: descriptor.value,
        configurable: true,
      });
    }
    expect(process.platform).toBe(descriptor.value);
  });
});
