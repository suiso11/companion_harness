import {
  DEFAULT_INHERITED_ENV_VARS,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { nextBackoffMs } from "./backoff.js";
import { canonicalSchemaHash, type McpConnectorConfig } from "./config.js";
import type { McpErrorCode } from "./errors.js";
import { OwnedConnection } from "./session.js";

/** Creates the SDK transport for a config. Injectable in tests (fake only). */
export type TransportFactory = (config: McpConnectorConfig) => Transport;

/**
 * Fixed finite wait after SIGKILL for the SAME owned real-stdio close event.
 * Not configurable: no extra config field, flag or error code (§C09-06).
 */
const FORCE_KILL_WAIT_MS = 2000;

/**
 * Known SDK 1.30.0 behavior (§17.7, verified against official source
 * `dist/esm/client/stdio.js` via unpkg immutable version URL, no install):
 * StdioClientTransport merges `getDefaultEnvironment()`
 * (over `DEFAULT_INHERITED_ENV_VARS`) UNDER the explicit `env` param, and
 * hardcodes `shell:false`. Fail-closed: EVERY effectively inherited default
 * name must be explicitly present in the config `envAllowlist`, otherwise
 * stdio config/call is rejected with `mcp_unavailable` BEFORE spawn.
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
      `mcp_unavailable: stdio envAllowlist misses ${missing.length} required inherited name(s): ${missing.join(",")}`,
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
 * follow). Also re-checks loopback at the runtime boundary. The refused
 * response body is CANCELLED (never read/logged) so the underlying socket is
 * released without an unbounded stream await.
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
      const body = res.body;
      if (body !== null && body !== undefined) {
        // Fire-and-forget cancel; a rejected cancel must never escape or hang.
        void Promise.resolve(body.cancel()).catch(() => undefined);
      }
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
 * Hard ceiling on tools/list pages followed during binding-identity
 * verification. A malicious or buggy server could return a non-terminating
 * nextCursor sequence and hang connect forever; after the cap the collected
 * snapshot is verified as-is (unseen bindings stay disabled).
 */
const MAX_TOOL_LIST_PAGES = 10; // ponytail: deliberately small and fixed, never auto-raised

type EnsureResult = { ok: true } | { ok: false; code: McpErrorCode };

/**
 * True when the trusted wire-identity expectation is explicitly present.
 * Runtime guard for programmatic configs that bypass the zod schema: a
 * missing/empty `expectedServerName` or `version` must fail closed (fixed
 * mismatch) rather than compare against `undefined`. Never infers from
 * `serverId`/`clientName`/the actual server response and supplies no default.
 */
function hasWireIdentityExpectation(config: McpConnectorConfig): boolean {
  const expectedName: unknown = config.expectedServerName;
  const expectedVersion: unknown = config.version;
  return (
    typeof expectedName === "string" &&
    expectedName.length > 0 &&
    typeof expectedVersion === "string" &&
    expectedVersion.length > 0
  );
}

/** Forward a caller abort to a fresh per-operation controller (fixed reason). */
function forwardAbort(
  caller: AbortSignal | undefined,
  controller: AbortController,
): () => void {
  if (caller === undefined) return () => undefined;
  if (caller.aborted) {
    controller.abort("cancelled");
    return () => undefined;
  }
  const onAbort = () => {
    controller.abort("cancelled");
  };
  caller.addEventListener("abort", onAbort, { once: true });
  return () => caller.removeEventListener("abort", onAbort);
}

/**
 * Race an owned SDK operation against a fresh per-operation abort signal.
 *
 * The SDK `connect(transport, { signal })` signal only covers the initialize
 * request: `Transport.start()` and the `notifications/initialized` send carry
 * no signal, so a hang there would leave `Client.connect` (and the connector
 * mutex/singleflight) pending forever. This race rejects the caller promptly
 * on abort with the fixed code, while still consuming the losing operation's
 * late fulfilment/rejection so it can never surface as an unhandled rejection.
 * The owned late-resource cleanup itself lives in the transport start guard.
 */
function raceOperation<T>(source: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      // Consume a possibly never-settling source; the caller aborts promptly.
      void source.then(
        () => undefined,
        () => undefined,
      );
      reject(new Error("mcp_unavailable"));
      return;
    }
    const onAbort = () => {
      reject(new Error("mcp_unavailable"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    source.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
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
 *   wait + bounded force kill. HTTP: loopback only, redirects refused.
 *
 * C09-05/06: one OWNED connection record owns the raw transport, the count-only
 * stderr overflow latch, cancellable in-flight ops, and the bounded cleanup.
 * Every mismatch/connect/call/overflow/idle/stop path routes through the same
 * cleanup, except the unconfigured-name no-IO denial. Explicit shutdown is
 * epoch-fenced so calls started before it never spawn late; a NEW explicit call
 * after a completed shutdown may lazily connect fresh.
 */
export class McpConnector {
  private session: OwnedConnection | undefined;
  private connected = false;
  private consecutiveFailures = 0;
  /**
   * Configured bindings that PASSED the wire-identity gate and the per-tool
   * canonical-schema check on the current connection. Empty until a real
   * connect validates; cleared synchronously on shutdown/failure/overflow.
   */
  private enabledBindings: string[] = [];
  private mutex: Promise<void> = Promise.resolve();
  /** Increments ONLY on explicit shutdown; fences pre-shutdown demands. */
  private shutdownEpoch = 0;
  private shuttingDown = false;
  private shutdownInFlight: Promise<void> | undefined;
  /**
   * One in-progress physical connect attempt per epoch. Every joiner shares the
   * same entry, including its per-attempt AbortController; shutdown aborts that
   * controller so a fenced demand stops waiting the pre-construction backoff
   * (and releases the mutex) instead of sleeping out a stale delay.
   */
  private connectInFlight:
    | {
        epoch: number;
        controller: AbortController;
        promise: Promise<EnsureResult>;
      }
    | undefined;
  /**
   * Every bounded cleanup generation started by an owned connection, registered
   * centrally through `OwnedConnectionHooks.onCleanupStarted`. Explicit
   * shutdown joins only the cleanups already STARTED by the time it snapshots
   * this set (see `shutdown`); a cleanup that starts after shutdown completes
   * is outside this set. Pure bookkeeping only.
   */
  private readonly pendingCleanups = new Set<Promise<void>>();

  constructor(
    private readonly config: McpConnectorConfig,
    private readonly transportFactory: TransportFactory = defaultTransportFactory,
  ) {}

  stats(): ConnectorStats {
    return {
      connected: this.connected,
      consecutiveFailures: this.consecutiveFailures,
      // Never advertise a callable binding before a validated connection.
      enabledBindings: this.connected ? [...this.enabledBindings] : [],
    };
  }

  /**
   * Is an upstream tool name currently callable? True only after a live
   * connection passed both the wire-identity gate and this binding's
   * canonical-schema check. Always false while disconnected/failed/mismatched.
   */
  isAllowed(upstreamTool: string): boolean {
    return this.connected && this.enabledBindings.includes(upstreamTool);
  }

  /**
   * Verify binding identity against a tools/list snapshot: exact configured
   * upstream names must be present and their canonical input-schema hashes
   * must match. Any mismatch disables that binding (§17.3).
   */
  verifyBindingIdentity(
    listed: Array<{ name: string; inputSchemaHash: string }>,
  ): { enabled: string[]; disabled: string[] } {
    const result = computeBindingIdentity(this.config, listed);
    this.enabledBindings = result.enabled;
    return result;
  }

  /**
   * Single logical call: exactly one attempt, never auto-resent (§17.6).
   *
   * Cancellation is SDK-native (verified @modelcontextprotocol/sdk 1.30.0
   * official source/types: `Client.callTool(params, resultSchema?,
   * options?: RequestOptions)` forwards `options` to `Protocol.request`,
   * where `RequestOptions.signal?: AbortSignal` throws if already aborted
   * and rejects the in-flight request on abort after sending
   * `notifications/cancelled`). Caller cancellations are forwarded to a fresh
   * per-operation controller (fixed reason), whose forwarding listener and
   * active-op entry are removed in `finally` so no successful-request cancel
   * listener is retained. The abort rejection is redacted to the existing
   * fixed `mcp_unavailable`: no new error code, no raw abort error, no retry.
   */
  async callTool(
    upstreamTool: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<CallResult> {
    // PURE admission AT INVOCATION: an unconfigured name is denied with the
    // fixed code, no I/O, no mutex and no lifecycle interaction, regardless of
    // shutdown or cross-epoch state. This is never masked by an availability
    // change such as a completed shutdown.
    const configured = this.config.bindings.some(
      (b) => b.upstreamTool === upstreamTool,
    );
    if (!configured) {
      return { ok: false, code: "mcp_binding_not_allowed" as const };
    }
    // Capture the epoch AND the during-shutdown state AT INVOCATION, before
    // any mutex wait. A call submitted while shutdown is in progress must stay
    // fixed-unavailable even if its queued closure later runs after the flag
    // clears; a NEW call submitted after completion may lazy connect.
    const epoch = this.shutdownEpoch;
    const submissionShuttingDown = this.shuttingDown;
    return this.withMutex(async () => {
      if (submissionShuttingDown || this.isStopped(epoch)) {
        return { ok: false, code: "mcp_unavailable" as const };
      }
      const ensured = await this.ensureConnectedForEpoch(epoch);
      if (!ensured.ok) return ensured;
      if (this.isStopped(epoch)) {
        return { ok: false, code: "mcp_unavailable" as const };
      }
      if (!this.isAllowed(upstreamTool)) {
        return { ok: false, code: "mcp_schema_mismatch" as const };
      }
      const session = this.session;
      if (session === undefined) {
        return { ok: false, code: "mcp_unavailable" as const };
      }
      if (!session.ready) {
        // Transport loss observed between ensure and dispatch: route through
        // the same bounded cleanup and count once unless already stopped.
        await this.cleanupSession(session, { countFailure: !session.stop });
        return { ok: false, code: "mcp_unavailable" as const };
      }
      const controller = new AbortController();
      const detach = forwardAbort(signal, controller);
      session.trackOp(controller);
      try {
        const res = (await session.client.callTool(
          {
            name: upstreamTool,
            arguments: (args ?? {}) as Record<string, unknown>,
          },
          undefined,
          { signal: controller.signal },
        )) as {
          isError?: boolean;
          structuredContent?: unknown;
          content?: Array<{ type: string; text?: string }>;
        };
        // Overflow/shutdown observed BEFORE publication: never publish a
        // success from a session that has stopped or been superseded.
        if (
          session.stop ||
          this.isStopped(epoch) ||
          this.isSuperseded(session)
        ) {
          return { ok: false, code: "mcp_unavailable" as const };
        }
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
        await this.cleanupSession(session, { countFailure: true });
        return { ok: false, code: "mcp_unavailable" as const };
      } finally {
        detach();
        session.untrackOp(controller);
      }
    });
  }

  /**
   * Lazy connect + fail-closed identity verification (§17.3, C09-07):
   *
   * 1. Wire gate: the REAL SDK handshake `initialize.serverInfo` (exact
   *    `name`/`version`, case-sensitive) must match the trusted config
   *    (`expectedServerName`/`version`). A mismatch disables ALL bindings and
   *    bounded-cleans the half-open client/transport (failure count stays zero).
   * 2. Then tools/list pages are followed (bounded) and each configured
   *    binding's exact name + canonical input-schema SHA-256 is compared.
   *    Any missing/mismatch disables that binding; connect reports
   *    mcp_schema_mismatch only when NO binding verifies.
   *
   * Concurrent calls share one in-progress owned attempt instead of orphaned
   * clients. Every await is fenced by the owned session identity + stop flag.
   */
  async ensureConnected(): Promise<EnsureResult> {
    return this.ensureConnectedForEpoch(this.shutdownEpoch);
  }

  /**
   * Bounded safe shutdown: one idempotent owned cleanup for all parallel
   * callers. Stops synchronously, aborts every owned in-flight SDK operation,
   * begins raw close, then awaits the actual stdio close event under the
   * configured window; on timeout SIGKILLs ONLY the captured owned real-stdio
   * pid and waits the fixed finite post-kill window. State is cleared
   * synchronously so no stale enabled binding survives.
   */
  shutdown(): Promise<void> {
    if (this.shutdownInFlight !== undefined) return this.shutdownInFlight;
    this.shutdownEpoch += 1;
    this.shuttingDown = true;
    const session = this.session;
    this.session = undefined;
    this.connected = false;
    this.enabledBindings = [];
    // Retire AND abort any in-flight connect singleflight so a stopped attempt
    // can never be joined by a fresh demand on the same epoch AND a demand
    // currently waiting the pre-construction backoff stops immediately (its
    // timer is cleared) rather than sleeping out the stale delay while holding
    // the mutex. The identity-guarded `finally` in `ensureConnectedForEpoch`
    // keeps this retired entry from clearing a NEW attempt.
    const inflight = this.connectInFlight;
    this.connectInFlight = undefined;
    if (inflight !== undefined) inflight.controller.abort("cancelled");
    // Synchronous owned stop BEFORE the singleflight body runs any await, so a
    // shutdown invoked before a connect settles still fences that attempt.
    if (session !== undefined) session.beginStop();
    // Publish the singleflight promise BEFORE any body/finally can execute:
    // an empty shutdown body otherwise resolves synchronously and the later
    // assignment would permanently stale `shutdownInFlight`.
    const promise: Promise<void> = Promise.resolve()
      .then(async () => {
        if (session !== undefined) {
          await session.boundedClose(this.shutdownWaitMs(), FORCE_KILL_WAIT_MS);
        }
        // Join EVERY bounded cleanup generation registered centrally via the
        // owned `onCleanupStarted` hook. This covers a detached overflow/close
        // cleanup started before shutdown captured state (session undefined)
        // and any additional generation — e.g. a late-start generic renewal —
        // that starts WHILE an earlier one is still being awaited. Snapshot each
        // round so a newly started generation is also drained; each generation
        // is itself bounded by its grace + fixed post-kill window, so this
        // terminates.
        while (this.pendingCleanups.size > 0) {
          await Promise.allSettled([...this.pendingCleanups]);
        }
      })
      .finally(() => {
        this.shuttingDown = false;
        if (this.shutdownInFlight === promise)
          this.shutdownInFlight = undefined;
      });
    this.shutdownInFlight = promise;
    return promise;
  }

  private async ensureConnectedForEpoch(epoch: number): Promise<EnsureResult> {
    if (this.isStopped(epoch)) {
      return { ok: false, code: "mcp_unavailable" as const };
    }
    if (this.connected && this.session?.ready) {
      return { ok: true };
    }
    const inflight = this.connectInFlight;
    if (inflight !== undefined && inflight.epoch === epoch) {
      return inflight.promise;
    }
    // One FRESH controller per physical connect attempt; every joiner of this
    // epoch shares it so shutdown aborts the single shared backoff wait.
    const controller = new AbortController();
    const entry: {
      epoch: number;
      controller: AbortController;
      promise: Promise<EnsureResult>;
    } = {
      epoch,
      controller,
      promise: Promise.resolve({ ok: true } as EnsureResult),
    };
    const promise = this.doConnect(epoch, controller.signal).finally(() => {
      if (this.connectInFlight === entry) this.connectInFlight = undefined;
    });
    entry.promise = promise;
    this.connectInFlight = entry;
    return promise;
  }

  private async doConnect(
    epoch: number,
    signal: AbortSignal,
  ): Promise<EnsureResult> {
    // Runtime boundary for programmatic configs that bypass the zod schema:
    // a missing/empty wire-identity expectation fails closed with the fixed
    // mismatch BEFORE any transport creation/spawn or tools/list.
    if (!hasWireIdentityExpectation(this.config)) {
      this.enabledBindings = [];
      return { ok: false, code: "mcp_schema_mismatch" as const };
    }
    // Fail-closed stdio env: reject BEFORE any transport creation/spawn.
    if (
      this.config.transport.kind === "stdio" &&
      missingStdioEnvNames(this.config).length > 0
    ) {
      return { ok: false, code: "mcp_unavailable" as const };
    }
    if (this.consecutiveFailures > 0) {
      // Cancellable demand backoff: a shutdown fence (or any abort of this
      // attempt's controller) resolves the wait immediately and clears its
      // timer, so a fenced demand never sleeps out a stale delay or holds the
      // mutex while a fresh post-shutdown demand waits a FULL new delay.
      await sleep(nextBackoffMs(this.consecutiveFailures), signal);
    }
    if (this.isStopped(epoch) || signal.aborted) {
      return { ok: false, code: "mcp_unavailable" as const };
    }
    let session: OwnedConnection | undefined;
    try {
      const raw = this.createTransport();
      // Record + count-only stderr drain are installed BEFORE any async dial
      // and are visible to shutdown for the whole handshake.
      session = new OwnedConnection(
        raw,
        { name: this.config.clientName, version: this.config.clientVersion },
        {
          onOverflow: (s) => this.handleOverflow(s),
          onClosed: (s, info) => this.handleClosed(s, info),
          onCleanupStarted: (promise) => {
            this.trackCleanup(promise);
          },
          shutdownWaitMs: this.shutdownWaitMs(),
          forceKillWaitMs: FORCE_KILL_WAIT_MS,
        },
      );
      this.session = session;
      // Owned opening fence: abort the WHOLE handshake on stop/overflow. The
      // SDK `signal` only covers the initialize request, so `raw.start()` and
      // the `notifications/initialized` send are raced against this fresh
      // per-operation signal here: a hang there can no longer leave the mutex
      // or the connect singleflight pending forever.
      const connectOp = new AbortController();
      session.trackOp(connectOp);
      try {
        await raceOperation(
          session.client.connect(session, { signal: connectOp.signal }),
          connectOp.signal,
        );
      } finally {
        session.untrackOp(connectOp);
      }
      if (this.isStopped(epoch) || session.stop || this.isSuperseded(session)) {
        await this.cleanupSession(session, { countFailure: false });
        return { ok: false, code: "mcp_unavailable" as const };
      }
      // Wire-identity gate BEFORE tools/list or enabling any binding. The
      // ACTUAL initialize.serverInfo must equal the trusted config exactly.
      // `serverId` is a logical id and is deliberately NOT compared here.
      const wire = session.client.getServerVersion();
      if (
        wire === undefined ||
        wire.name !== this.config.expectedServerName ||
        wire.version !== this.config.version
      ) {
        await this.cleanupSession(session, {
          countFailure: false,
          resetFailures: true,
        });
        return { ok: false, code: "mcp_schema_mismatch" as const };
      }
      // Per-binding identity verification BEFORE enabling any call: follow
      // SDK 1.30.0 tools/list pages via listTools({ cursor }) until no
      // nextCursor, so bindings beyond page 1 still verify. Only configured
      // bindings are ever enabled — discovered tools are never auto-exposed.
      const snapshot: Array<{ name: string; inputSchemaHash: string }> = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_TOOL_LIST_PAGES; page += 1) {
        const op = new AbortController();
        session.trackOp(op);
        try {
          const params = cursor === undefined ? undefined : { cursor };
          const listed = await session.client.listTools(params, {
            signal: op.signal,
          });
          if (
            this.isStopped(epoch) ||
            session.stop ||
            this.isSuperseded(session)
          ) {
            await this.cleanupSession(session, { countFailure: false });
            return { ok: false, code: "mcp_unavailable" as const };
          }
          for (const t of listed.tools ?? []) {
            snapshot.push({
              name: t.name,
              inputSchemaHash: await canonicalSchemaHash(t.inputSchema),
            });
          }
          if (listed.nextCursor === undefined) break;
          cursor = listed.nextCursor;
        } finally {
          session.untrackOp(op);
        }
      }
      const { enabled } = computeBindingIdentity(this.config, snapshot);
      if (this.isStopped(epoch) || session.stop || this.isSuperseded(session)) {
        await this.cleanupSession(session, { countFailure: false });
        return { ok: false, code: "mcp_unavailable" as const };
      }
      if (enabled.length === 0) {
        await this.cleanupSession(session, {
          countFailure: false,
          resetFailures: true,
        });
        return { ok: false, code: "mcp_schema_mismatch" as const };
      }
      this.enabledBindings = enabled;
      session.ready = true;
      this.connected = true;
      this.consecutiveFailures = 0;
      return { ok: true };
    } catch {
      if (session !== undefined) {
        await this.cleanupSession(session, { countFailure: true });
      } else {
        this.consecutiveFailures += 1;
      }
      return { ok: false, code: "mcp_unavailable" as const };
    }
  }

  /** Overflow: synchronous stop + clear, failure once, one bounded cleanup. */
  private handleOverflow(session: OwnedConnection): void {
    if (this.session !== session) return; // stale peer late chunk
    session.beginStop();
    this.session = undefined;
    this.connected = false;
    this.enabledBindings = [];
    // Retire the stopped attempt so a fresh demand cannot join a pending
    // singleflight whose raw start/send never settles.
    this.connectInFlight = undefined;
    this.recordFailureOnce(session);
    void session
      .boundedClose(this.shutdownWaitMs(), FORCE_KILL_WAIT_MS)
      .catch(() => undefined);
  }

  /**
   * Synchronous reaction to an OWNED raw close event (spontaneous loss or
   * part of an already-requested cleanup). Identity-guarded: only the CURRENT
   * session may invalidate the connector, so a stale old peer's late close can
   * never poison a fresh post-shutdown/recovery peer or double-count a
   * failure. Always routes the same bounded, idempotent owned cleanup.
   */
  private handleClosed(
    session: OwnedConnection,
    info: { intentional: boolean },
  ): void {
    if (this.session !== session) {
      // Superseded peer: never touch fresh state; still guarantee a bounded
      // (idempotent) physical cleanup.
      void session
        .boundedClose(this.shutdownWaitMs(), FORCE_KILL_WAIT_MS)
        .catch(() => undefined);
      return;
    }
    this.session = undefined;
    this.connected = false;
    this.enabledBindings = [];
    this.connectInFlight = undefined;
    if (!info.intentional) {
      this.recordFailureOnce(session);
    }
    void session
      .boundedClose(this.shutdownWaitMs(), FORCE_KILL_WAIT_MS)
      .catch(() => undefined);
  }

  /**
   * Single owned bounded cleanup for every failure/mismatch/stop path.
   * Only touches public state when the session is still the current one, so
   * late callbacks from a superseded peer cannot poison a fresh session's
   * failure counter or enabled bindings.
   */
  private async cleanupSession(
    session: OwnedConnection,
    opts: { countFailure?: boolean; resetFailures?: boolean },
  ): Promise<void> {
    const current = this.session === session;
    if (current) {
      this.session = undefined;
      this.connected = false;
      this.enabledBindings = [];
    }
    if (current && opts.resetFailures === true) {
      this.consecutiveFailures = 0;
    }
    if (current && opts.countFailure === true) {
      this.recordFailureOnce(session);
    }
    session.beginStop();
    await session.boundedClose(this.shutdownWaitMs(), FORCE_KILL_WAIT_MS);
  }

  /** Count a given session's failure at most once (no close+catch doubling). */
  private recordFailureOnce(session: OwnedConnection): void {
    if (session.failureRecorded) return;
    session.failureRecorded = true;
    this.consecutiveFailures += 1;
  }

  /**
   * Central registration of one owned bounded-cleanup generation. The
   * `onCleanupStarted` hook fires exactly once per NEW memoized cleanup (a
   * repeat `boundedClose` returns the same promise without re-publishing), so
   * shutdown can join every generation without manual tracking at each call
   * site. Pure bookkeeping: the settlement handlers delete ONLY this promise,
   * never throw, and have no state/failure/publication side effects, so they
   * can never leak an unhandled rejection or delete a newer generation.
   */
  private trackCleanup(promise: Promise<void>): void {
    if (this.pendingCleanups.has(promise)) return;
    this.pendingCleanups.add(promise);
    promise.then(
      () => {
        this.pendingCleanups.delete(promise);
      },
      () => {
        this.pendingCleanups.delete(promise);
      },
    );
  }

  private isStopped(epoch: number): boolean {
    return this.shuttingDown || epoch !== this.shutdownEpoch;
  }

  /** True once `session` is no longer the connector's current owned peer. */
  private isSuperseded(session: OwnedConnection): boolean {
    return this.session !== session;
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

/** Pure binding-identity comparison (no state mutation). */
function computeBindingIdentity(
  config: McpConnectorConfig,
  listed: Array<{ name: string; inputSchemaHash: string }>,
): { enabled: string[]; disabled: string[] } {
  const byName = new Map(listed.map((t) => [t.name, t.inputSchemaHash]));
  const enabled: string[] = [];
  const disabled: string[] = [];
  for (const b of config.bindings) {
    if (byName.get(b.upstreamTool) === b.canonicalSchemaHash) {
      enabled.push(b.upstreamTool);
    } else {
      disabled.push(b.upstreamTool);
    }
  }
  return { enabled, disabled };
}

/**
 * Cancellable delay. Resolves when `ms` elapses OR when `signal` aborts
 * (immediately, if already aborted). A single shared settlement clears the
 * timeout and removes the once abort listener so no stale demand timer and no
 * listener survive an aborted backoff. Required signal: every demand backoff is
 * cancellable.
 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

/**
 * Production transport factory: real SDK transports only.
 * - stdio: fail-closed env (assertStdioEnvClosed BEFORE spawn; no silent
 *   broader env), shell=false (SDK hardcodes false; verified 1.30.0 source),
 *   config-only command (no interpolation), explicit env allowlist NOTE:
 *   SDK merges getDefaultEnvironment() underneath, so exact-allowlist is a
 *   known gap (see STDIO_IMPLICIT_ENV_VARS); stderr piped and drained by the
 *   OWNED connection record. Bounded kill lives in the owned cleanup (SDK
 *   transport close plus owned force-kill window, verified source).
 * - Streamable HTTP: loopback re-checked at the runtime boundary (defends
 *   against programmatic configs bypassing the zod schema) and redirects
 *   refused via a manual-redirect fetch wrapper (SDK 1.30.0 has no
 *   redirect option; default fetch would follow, and the refused body is
 *   cancelled without being read).
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
 * live). Callbacks (`onmessage`/`onclose`/`onerror`) are BORING plain
 * optional properties — genuinely readable and writable, never setter-only —
 * so a preinstalled factory observer, the OwnedConnection wrapper and the SDK
 * Protocol handler chain can all coexist. Inner SDK events are bridged to the
 * adapter's CURRENT callback values (not a captured setter), which is what
 * preserves the prior observer. The generic `Transport["onmessage"]` handler
 * is narrowed through the bridge because the inner transport only ever
 * delivers a single `JSONRPCMessage` argument (verified 1.30.0 source).
 * `send()` forwards only the resumption fields the inner transport accepts.
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
  };
  // Bridge inner SDK events to the adapter's live callback values so callers
  // can read and overwrite them like real optional properties.
  const priorClose = inner.onclose;
  inner.onclose = () => {
    priorClose?.();
    adapter.onclose?.();
  };
  const priorError = inner.onerror;
  inner.onerror = (error) => {
    priorError?.(error);
    adapter.onerror?.(error);
  };
  const priorMessage = inner.onmessage;
  inner.onmessage = (message) => {
    priorMessage?.(message);
    adapter.onmessage?.(message);
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
