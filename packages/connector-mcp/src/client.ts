import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { nextBackoffMs } from "./backoff.js";
import { type McpConnectorConfig, STDERR_CAP_BYTES } from "./config.js";
import type { McpErrorCode } from "./errors.js";

/** Creates the SDK transport for a config. Injectable in tests (fake only). */
export type TransportFactory = (config: McpConnectorConfig) => Transport;

export type CallResult =
  | { ok: true; structuredContent?: unknown; text?: string }
  | { ok: false; code: McpErrorCode };

export interface ConnectorStats {
  connected: boolean;
  consecutiveFailures: number;
  enabledBindings: string[];
}

/**
 * MCP connector transport lifecycle (§17.6–§17.7) over the official SDK.
 *
 * - Lazy persistent: connects on first allowed call, reuses the Client after.
 * - Never blocks app start: constructor does no I/O; `connect()` is explicit.
 * - Demand-driven reconnect with 1/2/5/10/max-30s backoff; the failed logical
 *   call is returned as an error, never auto-resent.
 * - Per-instance concurrency 1 via a promise mutex chain.
 * - Default deny: only configured allowlist bindings are callable; tools/list
 *   is used solely for binding-identity verification, never auto-exposed.
 * - stdio: shell=false (SDK spawn without shell), config-only command (no
 *   interpolation), env allowlist filtering, stderr 64KiB cap, shutdown
 *   wait + kill timeout. HTTP: loopback only (config-validated), no redirects.
 */
export class McpConnector {
  private client: Client | undefined;
  private connected = false;
  private consecutiveFailures = 0;
  private disabledByMismatch: string[] = [];
  private mutex: Promise<void> = Promise.resolve();
  private stderrBytes = 0;
  private stderrTruncated = false;

  constructor(
    private readonly config: McpConnectorConfig,
    private readonly transportFactory: TransportFactory = defaultTransportFactory,
  ) {}

  stats(): ConnectorStats {
    const allowlisted = this.config.bindings.map((b) => b.upstreamTool);
    return {
      connected: this.connected,
      consecutiveFailures: this.consecutiveFailures,
      enabledBindings: allowlisted.filter(
        (n) => !this.disabledByMismatch.includes(n),
      ),
    };
  }

  /** Is an upstream tool name currently callable (allowlist + identity)? */
  isAllowed(upstreamTool: string): boolean {
    return (
      this.config.bindings.some((b) => b.upstreamTool === upstreamTool) &&
      !this.disabledByMismatch.includes(upstreamTool)
    );
  }

  /**
   * Verify binding identity against a tools/list snapshot: exact configured
   * upstream names must be present and their canonical input-schema hashes
   * must match. Any mismatch disables that binding (§17.3).
   */
  verifyBindingIdentity(
    listed: Array<{ name: string; inputSchemaHash: string }>,
  ): { enabled: string[]; disabled: string[] } {
    const byName = new Map(listed.map((t) => [t.name, t.inputSchemaHash]));
    const enabled: string[] = [];
    const disabled: string[] = [];
    for (const b of this.config.bindings) {
      if (byName.get(b.upstreamTool) === b.canonicalSchemaHash) {
        enabled.push(b.upstreamTool);
      } else {
        disabled.push(b.upstreamTool);
      }
    }
    this.disabledByMismatch = disabled;
    return { enabled, disabled };
  }

  /** Single logical call: exactly one attempt, never auto-resent (§17.6). */
  async callTool(upstreamTool: string, args: unknown): Promise<CallResult> {
    return this.withMutex(async () => {
      if (!this.isAllowed(upstreamTool)) {
        return { ok: false, code: "mcp_binding_not_allowed" as const };
      }
      const ensured = await this.ensureConnected();
      if (!ensured.ok) return ensured;
      try {
        const client = this.client as Client;
        const res = (await client.callTool({
          name: upstreamTool,
          arguments: (args ?? {}) as Record<string, unknown>,
        })) as {
          structuredContent?: unknown;
          content?: Array<{ type: string; text?: string }>;
        };
        const text = Array.isArray(res.content)
          ? res.content
              .filter((c) => c.type === "text")
              .map((c) => c.text ?? "")
              .join("")
          : undefined;
        return { ok: true, structuredContent: res.structuredContent, text };
      } catch {
        this.markFailure();
        return { ok: false, code: "mcp_unavailable" as const };
      }
    });
  }

  /** Lazy connect; demand reconnect applies the backoff before dialing. */
  async ensureConnected(): Promise<
    { ok: true } | { ok: false; code: McpErrorCode }
  > {
    if (this.connected && this.client !== undefined) return { ok: true };
    if (this.consecutiveFailures > 0) {
      await sleep(nextBackoffMs(this.consecutiveFailures));
    }
    try {
      const transport = this.createTransport();
      const client = new Client(
        { name: this.config.clientName, version: this.config.clientVersion },
        { capabilities: {} },
      );
      await client.connect(transport);
      this.client = client;
      this.connected = true;
      this.consecutiveFailures = 0;
      return { ok: true };
    } catch {
      this.markFailure();
      return { ok: false, code: "mcp_unavailable" as const };
    }
  }

  /** Safe shutdown: close the SDK client (stdio kill timeout lives in transport). */
  async shutdown(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.connected = false;
    if (client !== undefined) {
      await client.close().catch(() => undefined);
    }
  }

  /** Record a stderr chunk with the 64KiB cap (truncate + fixed code downstream). */
  noteStderr(chunkBytes: number): { truncated: boolean; totalBytes: number } {
    this.stderrBytes += chunkBytes;
    if (this.stderrBytes > STDERR_CAP_BYTES) {
      this.stderrTruncated = true;
      this.stderrBytes = STDERR_CAP_BYTES;
    }
    return { truncated: this.stderrTruncated, totalBytes: this.stderrBytes };
  }

  private markFailure(): void {
    this.consecutiveFailures += 1;
    this.connected = false;
    this.client = undefined;
  }

  private createTransport(): Transport {
    return this.transportFactory(this.config);
  }

  private async withMutex<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.mutex;
    let release!: () => void;
    this.mutex = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Production transport factory: real SDK transports only.
 * - stdio: shell=false (SDK spawns without a shell), config-only command
 *   (no interpolation), explicit env allowlist, stderr piped with 64KiB cap.
 * - Streamable HTTP: loopback only (config-validated), redirects refused
 *   (followRedirects is pinned false by the config schema).
 */
export function defaultTransportFactory(config: McpConnectorConfig): Transport {
  const t = config.transport;
  if (t.kind === "stdio") {
    const env: Record<string, string> = {};
    for (const name of t.envAllowlist) {
      const v = process.env[name];
      if (v !== undefined) env[name] = v;
    }
    return new StdioClientTransport({
      command: t.command,
      args: [...t.args],
      env,
      stderr: "pipe",
    });
  }
  return new StreamableHTTPClientTransport(
    new URL(`http://${t.host}:${t.port}${t.path}`),
  );
}
