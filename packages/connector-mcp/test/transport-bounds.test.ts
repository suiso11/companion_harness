/**
 * C09-05 transport bounds regression: the exact 64KiB stderr cap, per
 * CONNECTION byte reset with stale-late-event isolation, single bounded cleanup
 * per overflow session, IDLE overshoot, a raw close delivered during binding
 * verification, and the capability guard that only an OWNED real-SDK-stdio pid
 * may ever be signalled.
 *
 * Deterministic controlled stdio emitter (a structural Transport with a public
 * `stderr` PassThrough and observable protocol-stage gates), driven against the
 * REAL SDK Client. No child process, no real user pid, no SDK method mocking,
 * no snapshot/source/wiring assertions, no raw stderr bytes retained. A
 * targeted fake clock (`setTimeout`/`clearTimeout`/`Date` only) makes every
 * deadline exact; the real SDK handshake still runs on native microtasks.
 */
import { PassThrough } from "node:stream";
import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { McpConnector, STDIO_IMPLICIT_ENV_VARS } from "../src/client.js";
import type { McpConnectorConfig } from "../src/config.js";
import {
  canonicalSchemaHash,
  mcpConnectorConfigSchema,
} from "../src/config.js";

const CAP = 64 * 1024;
const TOOL = "search-events";
const WIRE_NAME = "fake-calendar";
const WIRE_VERSION = "0.0.0";

const INPUT_SCHEMA = {
  type: "object",
  properties: { q: { type: "string" } },
  required: ["q"],
};

interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

/** Small local deferred used for observable protocol-stage gates. */
function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Minimal controlled JSON-RPC transport with a piped stderr emitter and
 * per-stage gates/entered signals. It is NOT a StdioClientTransport, so it
 * carries a decoy numeric `pid` that must never be force-killed. A host
 * resource is created only once `start()` actually completes, so a late start
 * after a stop genuinely creates post-cleanup resources.
 */
class ControlledEmitter implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  readonly stderr = new PassThrough();
  /** Decoy: pid-shaped but not an owned real stdio session. */
  pid = 987654;
  closeCount = 0;
  startCount = 0;
  initializeCount = 0;
  toolCallCount = 0;
  hangToolCall = false;
  hangClose = false;
  /** True once `start()` has completed and created the host resource. */
  hostResourceOpen = false;
  /** Close the raw transport immediately after a tools/list reply is delivered. */
  closeAtListReply = false;

  startGate?: Deferred<void>;
  initializeGate?: Deferred<void>;
  toolsListGate?: Deferred<void>;

  readonly startEntered = deferred<void>();
  readonly initializeEntered = deferred<void>();
  readonly toolsListEntered = deferred<void>();
  readonly toolCallEntered = deferred<void>();
  readonly closeEntered = deferred<void>();
  readonly resourceClosed = deferred<void>();

  private readonly pendingCalls: Array<string | number> = [];

  async start(): Promise<void> {
    this.startCount += 1;
    this.startEntered.resolve();
    if (this.startGate !== undefined) await this.startGate.promise;
    this.hostResourceOpen = true;
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    // Entered signal at the PHYSICAL close entry, BEFORE the hang branch, so a
    // causal request-failure cleanup is observable even when close() hangs.
    this.closeEntered.resolve();
    if (this.hangClose) return new Promise<void>(() => undefined);
    if (!this.hostResourceOpen) return;
    this.hostResourceOpen = false;
    this.resourceClosed.resolve();
    this.onclose?.();
  }

  async send(
    message: JSONRPCMessage,
    _options?: TransportSendOptions,
  ): Promise<void> {
    const msg = message as { id?: string | number; method?: unknown };
    if (
      msg.method === "notifications/initialized" ||
      msg.method === "notifications/cancelled"
    ) {
      return;
    }
    if (msg.id === undefined || msg.method === undefined) return;
    if (msg.method === "initialize") {
      this.initializeCount += 1;
      this.initializeEntered.resolve();
      if (this.initializeGate !== undefined) await this.initializeGate.promise;
      this.reply(msg.id, {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: WIRE_NAME, version: WIRE_VERSION },
      });
      return;
    }
    if (msg.method === "tools/list") {
      this.toolsListEntered.resolve();
      if (this.toolsListGate !== undefined) await this.toolsListGate.promise;
      this.reply(
        msg.id,
        { tools: [{ name: TOOL, inputSchema: INPUT_SCHEMA }] },
        this.closeAtListReply ? () => this.spontaneousClose() : undefined,
      );
      return;
    }
    if (msg.method === "tools/call") {
      this.toolCallCount += 1;
      this.toolCallEntered.resolve();
      if (this.hangToolCall) {
        this.pendingCalls.push(msg.id);
        return;
      }
      this.reply(msg.id, { content: [{ type: "text", text: "hits" }] });
      return;
    }
    this.replyError(msg.id, -32601, "Method not found");
  }

  releaseAll(): void {
    this.startGate?.resolve();
    this.initializeGate?.resolve();
    this.toolsListGate?.resolve();
  }

  /** Emit exactly `bytes` of inert, deterministic stderr markers. */
  emitStderr(bytes: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.stderr.write(Buffer.alloc(bytes, 0x2e), () => resolve());
    });
  }

  /** Release every hanging tools/call with a successful result. */
  resolvePending(): void {
    const ids = this.pendingCalls.splice(0);
    for (const id of ids) {
      this.reply(id, { content: [{ type: "text", text: "hits" }] });
    }
  }

  /**
   * Model a spontaneous ACTUAL peer loss: a real transport releases its host
   * resource and signals closure BEFORE the raw close event. Never emit a bare
   * close event on a still-live host.
   */
  spontaneousClose(): void {
    if (this.hostResourceOpen) {
      this.hostResourceOpen = false;
      this.resourceClosed.resolve();
    }
    this.onclose?.();
  }

  private reply(
    id: string | number,
    result: unknown,
    afterDeliver?: () => void,
  ): void {
    const to = this.onmessage;
    if (to === undefined) return;
    const response = { jsonrpc: "2.0", id, result } as JSONRPCMessage;
    queueMicrotask(() => {
      to(response);
      if (afterDeliver !== undefined) queueMicrotask(afterDeliver);
    });
  }

  private replyError(id: string | number, code: number, message: string): void {
    const to = this.onmessage;
    if (to === undefined) return;
    const response = {
      jsonrpc: "2.0",
      id,
      error: { code, message },
    } as JSONRPCMessage;
    queueMicrotask(() => to(response));
  }
}

function config(hash: string): McpConnectorConfig {
  return mcpConnectorConfigSchema.parse({
    connectorInstanceId: "c09-bounds",
    serverId: "logical-bounds",
    kind: "mcp" as const,
    expectedServerName: WIRE_NAME,
    version: WIRE_VERSION,
    transport: {
      kind: "stdio" as const,
      command: "unused-injected",
      args: [] as string[],
      envAllowlist: [...STDIO_IMPLICIT_ENV_VARS] as string[],
      shutdownWaitMs: 500,
    },
    bindings: [{ upstreamTool: TOOL, canonicalSchemaHash: hash }],
  });
}

let realHash = "";

const gateReleasers: Array<() => void> = [];
const shutdowns: Array<() => Promise<unknown>> = [];
const tracked: Promise<unknown>[] = [];
const streams: PassThrough[] = [];

/** Register a logical promise so teardown can drain it deterministically. */
function track<T>(promise: Promise<T>): Promise<T> {
  tracked.push(promise);
  return promise;
}

/** Deterministic microtask flush: no wall-clock wait, no arbitrary sleep. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

/** Seed transports are handed out in order; later dials create fresh peers. */
function makeConnector(seed: ControlledEmitter[] = []): {
  connector: McpConnector;
  transports: ControlledEmitter[];
} {
  const transports: ControlledEmitter[] = [];
  const factory = () => {
    const t = seed.shift() ?? new ControlledEmitter();
    transports.push(t);
    streams.push(t.stderr);
    gateReleasers.push(() => t.releaseAll());
    return t as Transport;
  };
  const connector = new McpConnector(
    config(realHash),
    // SOURCE-REVIEWED host fixture definition: the controlled emitter only
    // advertises the static read handler `search-events`, so the trusted
    // definition marks it explicitly `read` with the explicitly probed hash —
    // never inferred from the connector config.
    [
      {
        upstreamTool: TOOL,
        canonicalSchemaHash: realHash,
        category: "read",
      },
    ],
    factory,
  );
  shutdowns.push(() => connector.shutdown());
  return { connector, transports };
}

// The learned schema hash needs real timers, computed once before any fake clock.
beforeAll(async () => {
  realHash = await canonicalSchemaHash(INPUT_SCHEMA);
});

beforeEach(() => {
  // Only the connector's demand timer + Date are faked; SDK microtasks and
  // queueMicrotask/setImmediate stay native so the real handshake runs.
  vi.useFakeTimers({ now: 0, toFake: ["setTimeout", "clearTimeout", "Date"] });
});

afterEach(async () => {
  vi.restoreAllMocks();
  // Release EVERY held gate FIRST so no transport promise can strand.
  for (const release of gateReleasers.splice(0)) release();
  const closing = shutdowns.splice(0).map((c) => c().catch(() => undefined));
  // Drain app backoff + bounded-close grace (well under the 60s SDK default
  // request timeout, so no pending initialize timeout is accidentally fired).
  await vi.advanceTimersByTimeAsync(30000);
  await Promise.allSettled([...tracked.splice(0), ...closing]);
  await flush();
  for (const stream of streams.splice(0)) stream.destroy();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("C09-05 stderr bounds and owned cleanup", () => {
  it("65536 bytes (exact cap) during an active call does not overflow and the call succeeds", async () => {
    const { connector, transports } = makeConnector();
    expect(await track(connector.ensureConnected())).toEqual({ ok: true });
    const transport = transports[0] as ControlledEmitter;

    transport.hangToolCall = true;
    const call = track(connector.callTool(TOOL, { q: "exact" }));
    await transport.toolCallEntered.promise;
    await transport.emitStderr(CAP);

    // Exactly at the cap: still live, no cleanup, no failure.
    expect(connector.stats()).toMatchObject({
      connected: true,
      consecutiveFailures: 0,
    });
    expect(transport.closeCount).toBe(0);

    transport.hangToolCall = false;
    transport.resolvePending();
    expect(await call).toMatchObject({ ok: true, text: "hits" });
    expect(connector.isAllowed(TOOL)).toBe(true);
  });

  it("65537 bytes during an active call fails fixed, clears all bindings, counts once, and dedupes cleanup", async () => {
    const { connector, transports } = makeConnector();
    expect(await track(connector.ensureConnected())).toEqual({ ok: true });
    const transport = transports[0] as ControlledEmitter;

    const killSpy = vi.spyOn(process, "kill");
    transport.hangToolCall = true;
    const call = track(connector.callTool(TOOL, { q: "overflow" }));
    await transport.toolCallEntered.promise;
    await transport.emitStderr(CAP + 1);

    // Immediate public invalidation BEFORE the bounded cleanup resolves.
    expect(connector.stats()).toEqual({
      connected: false,
      consecutiveFailures: 1,
      enabledBindings: [],
    });
    expect(connector.isAllowed(TOOL)).toBe(false);

    // Multiple further chunks must not trigger a second cleanup or failure.
    await transport.emitStderr(CAP + 1);
    await transport.emitStderr(CAP + 1);

    const result = await call;
    expect(result).toEqual({ ok: false, code: "mcp_unavailable" });
    expect(connector.stats().consecutiveFailures).toBe(1);
    expect(transport.closeCount).toBe(1);
    // Decoy pid: a non-StdioClientTransport is never force-killed.
    expect(killSpy).not.toHaveBeenCalled();
    killSpy.mockRestore();
  });

  it("stderr overflow during a gated initialize aborts the handshake and cleans up once", async () => {
    const peer = new ControlledEmitter();
    peer.initializeGate = deferred<void>();
    const { connector, transports } = makeConnector([peer]);

    const ensured = track(connector.ensureConnected());
    await peer.initializeEntered.promise;
    expect(connector.stats().connected).toBe(false);

    await peer.emitStderr(CAP + 1);
    expect(connector.stats()).toEqual({
      connected: false,
      consecutiveFailures: 1,
      enabledBindings: [],
    });

    expect(await ensured).toEqual({ ok: false, code: "mcp_unavailable" });
    expect(transports.length).toBe(1);
    expect(peer.closeCount).toBe(1);
  });

  it("stderr overflow during gated tools/list aborts binding verification and cleans up once", async () => {
    const peer = new ControlledEmitter();
    peer.toolsListGate = deferred<void>();
    const { connector, transports } = makeConnector([peer]);

    const call = track(connector.callTool(TOOL, { q: "list" }));
    await peer.toolsListEntered.promise;
    await peer.emitStderr(CAP + 1);

    expect(connector.stats()).toEqual({
      connected: false,
      consecutiveFailures: 1,
      enabledBindings: [],
    });
    expect(await call).toEqual({ ok: false, code: "mcp_unavailable" });
    expect(transports.length).toBe(1);
    expect(peer.closeCount).toBe(1);
  });

  it("IDLE stderr overflow after a healthy connect invalidates state, counts once, then recovers fresh", async () => {
    const { connector, transports } = makeConnector();
    expect(await track(connector.ensureConnected())).toEqual({ ok: true });
    const transport = transports[0] as ControlledEmitter;
    expect(connector.isAllowed(TOOL)).toBe(true);

    // No call in flight: this is the idle-loss path, a different state bug.
    await transport.emitStderr(CAP + 1);
    expect(connector.stats()).toEqual({
      connected: false,
      consecutiveFailures: 1,
      enabledBindings: [],
    });
    expect(connector.isAllowed(TOOL)).toBe(false);
    expect(transport.closeCount).toBe(1);

    // Next demand advances exactly one reset backoff and revalidates fresh.
    const reconnect = track(connector.ensureConnected());
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await reconnect).toEqual({ ok: true });
    expect(transports.length).toBe(2);
    expect(connector.stats()).toMatchObject({
      connected: true,
      consecutiveFailures: 0,
      enabledBindings: [TOOL],
    });
  });

  it("resets the byte counter per CONNECTION and only sees stale OLD events after the fresh peer is ready", async () => {
    const peer1 = new ControlledEmitter();
    const { connector, transports } = makeConnector([peer1]);
    expect(await track(connector.ensureConnected())).toEqual({ ok: true });

    // Peer 1 overflows during an active call and is cleaned up once.
    peer1.hangToolCall = true;
    const overflowCall = track(connector.callTool(TOOL, { q: "first" }));
    await peer1.toolCallEntered.promise;
    await peer1.emitStderr(CAP + 1);
    expect(await overflowCall).toEqual({ ok: false, code: "mcp_unavailable" });
    expect(peer1.closeCount).toBe(1);
    expect(connector.stats().consecutiveFailures).toBe(1);

    // Fresh demand: advance exactly one reset backoff, then let peer 2 be
    // initialized AND validated before any stale OLD event is emitted.
    const reconnect = track(connector.ensureConnected());
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await reconnect).toEqual({ ok: true });
    expect(transports.length).toBe(2);
    const peer2 = transports[1] as ControlledEmitter;
    expect(peer2).not.toBe(peer1);
    expect(connector.stats()).toMatchObject({
      connected: true,
      consecutiveFailures: 0,
      enabledBindings: [TOOL],
    });
    expect(connector.isAllowed(TOOL)).toBe(true);

    // ONLY NOW emit stale OLD chunks/close: they must not poison peer 2. The
    // stale loss models a truly closed resource, not a live-host close event.
    void peer1.emitStderr(CAP + 1024);
    peer1.spontaneousClose();
    await flush();
    expect(connector.stats()).toMatchObject({
      connected: true,
      consecutiveFailures: 0,
      enabledBindings: [TOOL],
    });
    expect(connector.isAllowed(TOOL)).toBe(true);

    // Peer 2's byte counter reset to 0: a full cap still fits and works.
    peer2.hangToolCall = true;
    const okCall = track(connector.callTool(TOOL, { q: "second" }));
    await peer2.toolCallEntered.promise;
    await peer2.emitStderr(CAP);
    expect(connector.stats().connected).toBe(true);
    peer2.hangToolCall = false;
    peer2.resolvePending();
    expect(await okCall).toMatchObject({ ok: true, text: "hits" });
    expect(connector.stats()).toMatchObject({
      connected: true,
      consecutiveFailures: 0,
    });
  });

  it("never signals a decoy pid even when a hanging generic close outlives the full grace deadline", async () => {
    const transport = new ControlledEmitter();
    const { connector, transports } = makeConnector([transport]);
    expect(await track(connector.ensureConnected())).toEqual({ ok: true });

    const killSpy = vi.spyOn(process, "kill");
    transport.hangToolCall = true;
    transport.hangClose = true;
    const call = track(connector.callTool(TOOL, { q: "decoy" }));
    await transport.toolCallEntered.promise;
    await transport.emitStderr(CAP + 1);

    // The fixed failure is gated on the bounded grace (the hanging close never
    // settles), so settle it WITHOUT awaiting and prove it is still pending.
    let callSettled = false;
    void call.then(() => {
      callSettled = true;
    });
    await flush();
    expect(callSettled).toBe(false);

    const t0 = Date.now();
    await vi.advanceTimersByTimeAsync(499);
    expect(Date.now() - t0).toBe(499);
    expect(callSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(Date.now() - t0).toBe(500);
    // Now the bounded cleanup has resolved: assert the fixed failure.
    expect(await call).toEqual({ ok: false, code: "mcp_unavailable" });
    expect(callSettled).toBe(true);

    // Past the grace + fixed post-kill window there is still no SIGKILL.
    await vi.advanceTimersByTimeAsync(2000);

    expect(transport.pid).toBe(987654);
    expect(killSpy).not.toHaveBeenCalled();
    expect(transports.length).toBe(1);
    killSpy.mockRestore();
  });

  it("an unexpected IDLE raw close clears state synchronously and the next distinct demand recovers", async () => {
    const transport = new ControlledEmitter();
    const { connector, transports } = makeConnector([transport]);
    expect(await track(connector.ensureConnected())).toEqual({ ok: true });
    expect(connector.isAllowed(TOOL)).toBe(true);

    // Spontaneous transport loss (real closed resource), not owned cleanup.
    transport.spontaneousClose();
    expect(connector.stats()).toEqual({
      connected: false,
      consecutiveFailures: 1,
      enabledBindings: [],
    });
    expect(connector.isAllowed(TOOL)).toBe(false);

    const reconnect = track(connector.callTool(TOOL, { q: "recover" }));
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await reconnect).toMatchObject({ ok: true, text: "hits" });
    expect(transports.length).toBe(2);
    expect(connector.stats()).toMatchObject({
      connected: true,
      consecutiveFailures: 0,
    });
  });

  it("a raw close delivered at tools/list reply delivery never publishes a ready connection", async () => {
    const transport = new ControlledEmitter();
    transport.closeAtListReply = true;
    const { connector, transports } = makeConnector([transport]);

    // The close is emitted while the connector's async canonical-schema digest
    // for the just-delivered page is still pending.
    const ensured = track(connector.ensureConnected());
    expect(await ensured).toEqual({ ok: false, code: "mcp_unavailable" });
    expect(connector.stats()).toEqual({
      connected: false,
      consecutiveFailures: 1,
      enabledBindings: [],
    });
    expect(connector.isAllowed(TOOL)).toBe(false);
    // A correct owner that OBSERVED the close memoizes a completed raw close
    // (the SDK Protocol has already detached from the dead peer), so there is
    // NO second physical close to count. The fixture's host resource is gone
    // and the connector is terminal; no implementation counter is pinned.
    expect(transport.hostResourceOpen).toBe(false);

    // Fresh explicit recovery revalidates and enables normally without any
    // poisoning from the closed peer.
    const reconnect = track(connector.ensureConnected());
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await reconnect).toEqual({ ok: true });
    expect(connector.isAllowed(TOOL)).toBe(true);
    expect(transports.length).toBe(2);
    const fresh = transports[1] as ControlledEmitter;
    expect(fresh).not.toBe(transport);
    expect(fresh.hostResourceOpen).toBe(true);
    expect(connector.stats()).toMatchObject({
      connected: true,
      consecutiveFailures: 0,
      enabledBindings: [TOOL],
    });
  });

  it("P1: explicit shutdown joins a DETACHED overflow cleanup until its ORIGINAL grace deadline (close once, decoy pid never killed)", async () => {
    const transport = new ControlledEmitter();
    const { connector, transports } = makeConnector([transport]);
    expect(await track(connector.ensureConnected())).toEqual({ ok: true });

    const killSpy = vi.spyOn(process, "kill");
    transport.hangToolCall = true;
    transport.hangClose = true;
    const call = track(connector.callTool(TOOL, { q: "overflow-join" }));
    await transport.toolCallEntered.promise;

    await transport.emitStderr(CAP + 1);
    // Overflow invalidated public state and started ONE detached bounded close.
    expect(connector.stats()).toEqual({
      connected: false,
      consecutiveFailures: 1,
      enabledBindings: [],
    });
    // The ORIGINAL deadline base is the cleanup generation's own physical close,
    // observed causally (never inferred from a bare counter).
    await transport.closeEntered.promise;
    const t0 = Date.now();
    expect(transport.closeCount).toBe(1);

    // Consume a NONZERO piece of the ORIGINAL 500ms grace BEFORE shutdown.
    await vi.advanceTimersByTimeAsync(123);
    expect(Date.now() - t0).toBe(123);

    // Explicit shutdown BEFORE the original grace elapses must JOIN the detached
    // cleanup instead of returning while the owned close is still pending.
    // Parallel shutdowns are the same promise.
    const shutdownA = track(connector.shutdown());
    expect(connector.shutdown()).toBe(shutdownA);
    // Invoked WHILE shutting down: fenced at invocation, still unavailable even
    // though it only reaches the mutex after the joined cleanup settles.
    const during = track(connector.callTool(TOOL, { q: "during" }));
    let shutdownSettled = false;
    void shutdownA.then(() => {
      shutdownSettled = true;
    });
    await flush();
    // The original 500ms generic grace is neither reset NOR restarted by
    // joining: settlement lands at the original boundary, not a second 623ms.
    await vi.advanceTimersByTimeAsync(376);
    expect(Date.now() - t0).toBe(499);
    expect(shutdownSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(Date.now() - t0).toBe(500);
    await shutdownA;
    expect(shutdownSettled).toBe(true);

    // Exactly one physical generic close; the bound is a host deadline, never an
    // OS process claim: the decoy pid is never signalled.
    expect(transport.closeCount).toBe(1);
    expect(transport.pid).toBe(987654);
    expect(killSpy).not.toHaveBeenCalled();
    expect(transports.length).toBe(1);
    // The gated logical call is unavailable, counted once, never replayed.
    expect(await call).toEqual({ ok: false, code: "mcp_unavailable" });
    expect(connector.stats().consecutiveFailures).toBe(1);
    // The during-shutdown call queued behind the joined cleanup's mutex still
    // settles fixed-unavailable and never dials a new peer.
    expect(await during).toEqual({ ok: false, code: "mcp_unavailable" });
    expect(transports.length).toBe(1);

    killSpy.mockRestore();
  });

  it("P1: shutdown joins a REQUEST-FAILURE cleanupSession bound and counts one failure", async () => {
    const transport = new ControlledEmitter();
    const { connector, transports } = makeConnector([transport]);
    expect(await track(connector.ensureConnected())).toEqual({ ok: true });

    const killSpy = vi.spyOn(process, "kill");
    transport.hangToolCall = true;
    transport.hangClose = true;
    const controller = new AbortController();
    // Caller cancellation rejects the in-flight SDK request, routing through the
    // request-failure `cleanupSession` path with a hanging generic close.
    const call = track(
      connector.callTool(TOOL, { q: "cancel-join" }, controller.signal),
    );
    await transport.toolCallEntered.promise;

    controller.abort();
    // Deterministic: the cleanup's physical raw close is invoked exactly when
    // the request-failure cleanupSession path starts. Fake Date is unchanged by
    // microtask progress, so this is the ORIGINAL bounded-close deadline base.
    await transport.closeEntered.promise;
    const t0 = Date.now();
    expect(connector.stats()).toEqual({
      connected: false,
      consecutiveFailures: 1,
      enabledBindings: [],
    });
    expect(transport.closeCount).toBe(1);

    // Consume a NONZERO piece of the ORIGINAL 500ms grace BEFORE shutdown.
    await vi.advanceTimersByTimeAsync(123);
    expect(Date.now() - t0).toBe(123);

    const shutdown = track(connector.shutdown());
    let settled = false;
    void shutdown.then(() => {
      settled = true;
    });
    // Joining must NOT reset NOR restart the original deadline: the remaining
    // 376ms lands at the original 500ms boundary, never a second 623ms.
    await vi.advanceTimersByTimeAsync(376);
    expect(Date.now() - t0).toBe(499);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(Date.now() - t0).toBe(500);
    await shutdown;
    expect(settled).toBe(true);

    expect(await call).toEqual({ ok: false, code: "mcp_unavailable" });
    // Failure counted exactly once (cleanup was not double-counted by the join).
    expect(connector.stats().consecutiveFailures).toBe(1);
    expect(transport.closeCount).toBe(1);
    expect(transport.pid).toBe(987654);
    expect(killSpy).not.toHaveBeenCalled();
    expect(transports.length).toBe(1);

    killSpy.mockRestore();
  });
});
