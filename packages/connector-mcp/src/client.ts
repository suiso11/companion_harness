import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  DEFAULT_INHERITED_ENV_VARS,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { nextBackoffMs } from "./backoff.js";
import {
  canonicalSchemaHash,
  type McpConnectorConfig,
  STDERR_CAP_BYTES,
} from "./config.js";
import type { McpErrorCode } from "./errors.js";

/** Creates the SDK transport for a config. Injectable in tests (fake only). */
export type TransportFactory = (config: McpConnectorConfig) => Transport;

/**
 * Known SDK 1.30.0 behavior (§17.7, verified against official source
 * `dist/esm/client/stdio.js` via unpkg immutable version URL, no install):
 * StdioClientTransport merges `getDefaultEnvironment()`
 * (over `DEFAULT_INHERITED_ENV_VARS`) UNDER the explicit `env` param, and
 * hardcodes `shell:false`. Fail-closed: EVERY effectively inherited default
 * name must be explicitly present in the config `envAllowlist`, otherwise
 * stdio config/call is rejected with `mcp_env_not_allowed` BEFORE spawn.
 * Verified default sets (SDK 1.30.0):
 * - win32: APPDATA, HOMEDRIVE, HOMEPATH, LOCALAPPDATA, PATH,
 *   PROCESSOR_ARCHITECTURE, SYSTEMDRIVE, SYSTEMROOT, TEMP, USERNAME,
 *   USERPROFILE, PROGRAMFILES
 * - posix: HOME, LOGNAME, PATH, SHELL, TERM, USER
 * The required set below is the live `DEFAULT_INHERITED_ENV_VARS` import
 * (runtime-platform names), so the check tracks the actual SDK defaults.
 * No env values are logged — only the fixed code and missing count/names.
 */
export const STDIO_IMPLICIT_ENV_VARS: readonly string[] =
  DEFAULT_INHERITED_ENV_VARS;

/**
 * Names from the SDK stdio defaults that are NOT explicitly allowlisted.
 * Empty means the stdio config is fail-closed compliant. Pure (no I/O).
 */
export function missingStdioEnvNames(
  config: McpConnectorConfig,
): readonly string[] {
  const t = config.transport;
  if (t.kind !== "stdio") return [];
  const allowed = new Set(t.envAllowlist);
  return DEFAULT_INHERITED_ENV_VARS.filter((name) => !allowed.has(name));
}

/** Fail-closed guard: throws a fixed-code error before any process spawn. */
export function assertStdioEnvClosed(config: McpConnectorConfig): void {
  const missing = missingStdioEnvNames(config);
  if (missing.length > 0) {
    throw new Error(
      `mcp_env_not_allowed: stdio envAllowlist misses ${missing.length} required inherited name(s): ${missing.join(",")}`,
    );
  }
}

/** Loopback hosts permitted for Streamable HTTP (§17.7, exact). */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);

export function assertLoopbackHttp(url: URL): void {
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(
      `Streamable HTTP host must be loopback, got: ${url.hostname}`,
    );
  }
}

/**
 * Fetch wrapper pinning manual redirects: any 3xx is refused as a fixed
 * error (SDK 1.30.0 exposes no redirect:false option; default fetch would
 * follow). Also re-checks loopback at the runtime boundary.
 */
export function loopbackNoRedirectFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const url =
    typeof input === "string"
      ? new URL(input)
      : input instanceof URL
        ? input
        : new URL((input as Request).url);
  assertLoopbackHttp(url);
  return fetch(input as unknown as string, {
    ...init,
    redirect: "manual",
  }).then((res) => {
    if (res.status >= 300 && res.status < 400) {
      throw new Error(`redirect refused: HTTP ${res.status}`);
    }
    return res;
  });
}

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

  /**
   * Single logical call: exactly one attempt, never auto-resent (§17.6).
   *
   * Cancellation is SDK-native (verified @modelcontextprotocol/sdk 1.30.0
   * official source/types: `Client.callTool(params, resultSchema?,
   * options?: RequestOptions)` forwards `options` to `Protocol.request`,
   * where `RequestOptions.signal?: AbortSignal` throws if already aborted
   * and rejects the in-flight request on abort after sending
   * `notifications/cancelled`). The abort rejection is redacted to the
   * existing fixed `mcp_unavailable` in the catch below: no new error code,
   * no raw abort error, no automatic retry. The per-instance mutex is
   * released by `withMutex`'s finally, so a queued call still proceeds.
   * Omitting `signal` preserves the previous behavior exactly.
   */
  async callTool(
    upstreamTool: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<CallResult> {
    return this.withMutex(async () => {
      if (!this.isAllowed(upstreamTool)) {
        const configured = this.config.bindings.some(
          (b) => b.upstreamTool === upstreamTool,
        );
        // Configured but identity-disabled (drift/missing): fixed mismatch,
        // no upstream call. Unconfigured: not-allowed.
        if (configured) {
          return { ok: false, code: "mcp_schema_mismatch" as const };
        }
        return { ok: false, code: "mcp_binding_not_allowed" as const };
      }
      const ensured = await this.ensureConnected();
      if (!ensured.ok) return ensured;
      // Re-check identity after connect (drift between calls disables).
      if (!this.isAllowed(upstreamTool)) {
        return { ok: false, code: "mcp_schema_mismatch" as const };
      }
      try {
        const client = this.client as Client;
        const res = (await client.callTool(
          {
            name: upstreamTool,
            arguments: (args ?? {}) as Record<string, unknown>,
          },
          undefined,
          signal === undefined ? undefined : { signal },
        )) as {
          isError?: boolean;
          structuredContent?: unknown;
          content?: Array<{ type: string; text?: string }>;
        };
        // MCP isError=true is a tool-level error: fixed code, never ok text.
        // No raw error content leaves this package (§17.8 redaction).
        if (res.isError === true) {
          return { ok: false, code: "calendar_upstream_error" as const };
        }
        const text = Array.isArray(res.content)
          ? res.content
              .filter((c) => c.type === "text")
              .map((c) => c.text ?? "")
              .join("")
          : undefined;
        return {
          ok: true as const,
          ...(res.structuredContent !== undefined
            ? { structuredContent: res.structuredContent }
            : {}),
          ...(text !== undefined ? { text } : {}),
        };
      } catch {
        await this.markFailure();
        return { ok: false, code: "mcp_unavailable" as const };
      }
    });
  }

  /**
   * Lazy connect + binding-identity verification (§17.3): after the SDK
   * handshake, tools/list is fetched and each configured binding's exact
   * name + canonical input-schema SHA-256 is compared. Any missing/mismatch
   * disables that binding; connect reports mcp_schema_mismatch only when
   * NO binding verifies (partial drift still connects, drifted names stay
   * disabled). Demand reconnect applies the backoff before dialing.
   */
  async ensureConnected(): Promise<
    { ok: true } | { ok: false; code: McpErrorCode }
  > {
    if (this.connected && this.client !== undefined) return { ok: true };
    // Fail-closed stdio env: reject BEFORE any transport creation/spawn.
    if (this.config.transport.kind === "stdio") {
      if (missingStdioEnvNames(this.config).length > 0) {
        return { ok: false, code: "mcp_env_not_allowed" as const };
      }
    }
    if (this.consecutiveFailures > 0) {
      await sleep(nextBackoffMs(this.consecutiveFailures));
    }
    let transport: Transport | undefined;
    let client: Client | undefined;
    try {
      transport = this.createTransport();
      this.drainStderr(transport);
      client = new Client(
        { name: this.config.clientName, version: this.config.clientVersion },
        { capabilities: {} },
      );
      await client.connect(transport);
      // Identity verification BEFORE enabling any call.
      const listed = await client.listTools();
      const snapshot: Array<{ name: string; inputSchemaHash: string }> = [];
      for (const t of listed.tools ?? []) {
        snapshot.push({
          name: t.name,
          inputSchemaHash: await canonicalSchemaHash(t.inputSchema),
        });
      }
      const { enabled } = this.verifyBindingIdentity(snapshot);
      if (enabled.length === 0) {
        await closeQuietly(client, transport);
        transport = undefined;
        client = undefined;
        this.consecutiveFailures = 0;
        return { ok: false, code: "mcp_schema_mismatch" as const };
      }
      this.client = client;
      this.connected = true;
      this.consecutiveFailures = 0;
      transport = undefined; // owned by client now
      client = undefined;
      return { ok: true };
    } catch {
      // Failed connect: release the half-open transport/client (no leak).
      await closeQuietly(client, transport);
      await this.markFailure();
      return { ok: false, code: "mcp_unavailable" as const };
    }
  }

  /**
   * Bounded safe shutdown: close the SDK client (stdio kill timeout lives
   * in the SDK transport: stdin.end + 2s wait + SIGTERM + 2s + SIGKILL per
   * verified 1.30.0 source), then enforce our own outer bound so shutdown
   * can never hang the host.
   */
  async shutdown(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.connected = false;
    if (client !== undefined) {
      await Promise.race([
        client.close().catch(() => undefined),
        sleep(this.shutdownWaitMs()).then(() => undefined),
      ]);
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

  private async markFailure(): Promise<void> {
    this.consecutiveFailures += 1;
    this.connected = false;
    // Release the dropped client/transport so failed calls disconnect (§17.6).
    const client = this.client;
    this.client = undefined;
    await closeQuietly(client, undefined);
  }

  /**
   * Attach continuous stderr drain at connect time (pipe only): data is
   * counted toward the 64KiB cap and then discarded; never buffered
   * unbounded, never blocks the child (§17.7).
   */
  private drainStderr(transport: Transport): void {
    const maybe = transport as unknown as {
      stderr?: { on?: (ev: string, fn: (c: unknown) => void) => void } | null;
    };
    const stream = maybe.stderr;
    if (stream?.on) {
      stream.on("data", (chunk: unknown) => {
        const bytes =
          typeof chunk === "string"
            ? Buffer.byteLength(chunk)
            : ((chunk as { length?: number })?.length ?? 0);
        this.noteStderr(bytes);
      });
    }
  }

  private shutdownWaitMs(): number {
    const t = this.config.transport;
    return t.kind === "stdio" ? t.shutdownWaitMs : 3000;
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
 * - stdio: fail-closed env (assertStdioEnvClosed BEFORE spawn; no silent
 *   broader env), shell=false (SDK hardcodes false; verified 1.30.0 source),
 *   config-only command (no interpolation), explicit env allowlist NOTE:
 *   SDK merges getDefaultEnvironment() underneath, so exact-allowlist is a
 *   known gap (see STDIO_IMPLICIT_ENV_VARS); stderr piped with 64KiB cap
 *   drained continuously by the connector; bounded kill lives in the SDK
 *   transport close (2s + SIGTERM + 2s + SIGKILL, verified source).
 * - Streamable HTTP: loopback re-checked at the runtime boundary (defends
 *   against programmatic configs bypassing the zod schema) and redirects
 *   refused via a manual-redirect fetch wrapper (SDK 1.30.0 has no
 *   redirect option; default fetch would follow).
 */
export function defaultTransportFactory(config: McpConnectorConfig): Transport {
  const t = config.transport;
  if (t.kind === "stdio") {
    // Fail-closed: reject BEFORE StdioClientTransport construction/spawn.
    assertStdioEnvClosed(config);
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
  const url = new URL(`http://${t.host}:${t.port}${t.path}`);
  assertLoopbackHttp(url);
  return toTransport(
    new StreamableHTTPClientTransport(url, {
      fetch: loopbackNoRedirectFetch,
    }),
  );
}

/**
 * Minimal Transport adapter for StreamableHTTPClientTransport.
 *
 * The official SDK 1.30.0 class declares `implements Transport`, but its
 * `get sessionId(): string | undefined` accessor is not assignable to
 * `Transport["sessionId"]?: string` under `exactOptionalPropertyTypes`
 * (a present-but-undefined value is rejected). The adapter therefore
 * exposes `sessionId` as a plain optional property, synced from the inner
 * transport after `start()`/each `send()` (Client.connect reads
 * `transport.sessionId` after start to detect reconnects, and calls
 * `transport.setProtocolVersion` after initialize, so both are forwarded
 * live). Callback writes (`onmessage`/`onclose`/`onerror`) are forwarded to
 * the inner transport; reads-before-write yield `undefined`, which matches
 * a fresh transport and is handled by the SDK's optional chaining. The
 * generic `Transport["onmessage"]` handler is narrowed through a wrapper
 * because the inner transport only ever delivers a single
 * `JSONRPCMessage` argument (verified 1.30.0 source). `send()` forwards
 * only the resumption fields the inner transport accepts.
 */
function toTransport(inner: StreamableHTTPClientTransport): Transport {
  const adapter: Transport = {
    start: () => {
      return inner.start().then(() => {
        syncSessionId(adapter, inner);
      });
    },
    send: (message, options) => {
      return inner
        .send(
          message,
          options === undefined
            ? undefined
            : {
                ...(options.resumptionToken !== undefined
                  ? { resumptionToken: options.resumptionToken }
                  : {}),
                ...(options.onresumptiontoken !== undefined
                  ? { onresumptiontoken: options.onresumptiontoken }
                  : {}),
              },
        )
        .then(() => {
          syncSessionId(adapter, inner);
        });
    },
    close: () => inner.close(),
    setProtocolVersion: (version) => {
      inner.setProtocolVersion(version);
    },
    set onclose(handler: () => void) {
      inner.onclose = handler;
    },
    set onerror(handler: (error: Error) => void) {
      inner.onerror = handler;
    },
    set onmessage(handler: NonNullable<Transport["onmessage"]>) {
      inner.onmessage = (message) => {
        handler(message);
      };
    },
  };
  return adapter;
}

/** Sync the live inner session id without ever assigning `undefined`. */
function syncSessionId(
  adapter: Transport,
  inner: StreamableHTTPClientTransport,
): void {
  const sid = inner.sessionId;
  if (sid !== undefined) {
    adapter.sessionId = sid;
  } else {
    delete adapter.sessionId;
  }
}

async function closeQuietly(
  client: Client | undefined,
  transport: Transport | undefined,
): Promise<void> {
  if (client !== undefined) {
    await client.close().catch(() => undefined);
  } else if (transport !== undefined) {
    await transport.close?.().catch(() => undefined);
  }
}
