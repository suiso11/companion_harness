/**
 * C09-06 shutdown-race regression: explicit-shutdown epoch fencing (at
 * invocation and across the queued epoch), one-close dedupe, empty/repeated
 * shutdown, bounded cleanup of a hanging GENERIC close at the configured grace
 * window, canceled opening stages (raw start / notifications/initialized send),
 * late raw-start resource cleanup, and concurrent public `ensureConnected`
 * singleflight.
 *
 * Real SDK Client over a deterministic controlled transport. No child process,
 * no real user pid, no SDK method mocking. A targeted fake clock
 * (`setTimeout`/`clearTimeout`/`Date` only) makes the 100ms bound exact while
 * the real handshake runs on native microtasks. Observable protocol-stage
 * gates/deferreds replace dial-length polling and wall-clock waits.
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
 * Controlled JSON-RPC transport with per-stage gates/entered signals and a
 * host-resource lifecycle tied to `start()` completion. NOT a
 * StdioClientTransport: no process, no pid, no force-kill path.
 */
class ControlledTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  readonly stderr = new PassThrough();
  closeCount = 0;
  startCount = 0;
  initializeCount = 0;
  toolCallCount = 0;
  hangToolCall = false;
  hangClose = false;
  /** True once `start()` has completed and created the host resource. */
  hostResourceOpen = false;
  /**
   * When set, `close()` releases a held start gate, so the raw start resumes
   * and creates its host resource AFTER that close was invoked.
   */
  releaseStartOnClose = false;
  /**
   * When set, `close()` still releases an open resource (and fires `onclose`)
   * but returns a promise that NEVER settles, so a memoized close can outlive
   * the resource handoff without its `finally` ever running.
   */
  closeNeverSettles = false;
  /** When set, `start()` creates the resource and only THEN rejects. */
  rejectAfterStart = false;

  startGate?: Deferred<void>;
  initializeGate?: Deferred<void>;
  initializedGate?: Deferred<void>;
  toolsListGate?: Deferred<void>;

  readonly startEntered = deferred<void>();
  readonly closeEntered = deferred<void>();
  readonly initializeEntered = deferred<void>();
  readonly initializedEntered = deferred<void>();
  readonly toolsListEntered = deferred<void>();
  readonly toolCallEntered = deferred<void>();
  readonly resourceClosed = deferred<void>();

  private readonly pendingCalls: Array<string | number> = [];

  async start(): Promise<void> {
    this.startCount += 1;
    this.startEntered.resolve();
    if (this.startGate !== undefined) await this.startGate.promise;
    this.hostResourceOpen = true;
    if (this.rejectAfterStart) throw new Error("late-start-rejected");
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    this.closeEntered.resolve();
    if (this.releaseStartOnClose) this.startGate?.resolve();
    if (this.hangClose) return new Promise<void>(() => undefined);
    if (this.hostResourceOpen) {
      this.hostResourceOpen = false;
      this.resourceClosed.resolve();
      this.onclose?.();
    }
    if (this.closeNeverSettles) return new Promise<void>(() => undefined);
  }

  async send(
    message: JSONRPCMessage,
    _options?: TransportSendOptions,
  ): Promise<void> {
    const msg = message as { id?: string | number; method?: unknown };
    if (msg.method === "notifications/initialized") {
      this.initializedEntered.resolve();
      if (this.initializedGate !== undefined) {
        await this.initializedGate.promise;
      }
      return;
    }
    if (msg.method === "notifications/cancelled") return;
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
      this.reply(msg.id, {
        tools: [{ name: TOOL, inputSchema: INPUT_SCHEMA }],
      });
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
    this.initializedGate?.resolve();
    this.toolsListGate?.resolve();
  }

  resolvePending(): void {
    const ids = this.pendingCalls.splice(0);
    for (const id of ids) {
      this.reply(id, { content: [{ type: "text", text: "hits" }] });
    }
  }

  private reply(id: string | number, result: unknown): void {
    const to = this.onmessage;
    if (to === undefined) return;
    const response = { jsonrpc: "2.0", id, result } as JSONRPCMessage;
    queueMicrotask(() => to(response));
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
    connectorInstanceId: "c09-shutdown",
    serverId: "logical-shutdown",
    kind: "mcp" as const,
    expectedServerName: WIRE_NAME,
    version: WIRE_VERSION,
    transport: {
      kind: "stdio" as const,
      command: "unused-injected",
      args: [] as string[],
      envAllowlist: [...STDIO_IMPLICIT_ENV_VARS] as string[],
      shutdownWaitMs: 100,
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

function makeConnector(seed: ControlledTransport[] = []): {
  connector: McpConnector;
  transports: ControlledTransport[];
} {
  const transports: ControlledTransport[] = [];
  const factory = () => {
    const t = seed.shift() ?? new ControlledTransport();
    transports.push(t);
    streams.push(t.stderr);
    gateReleasers.push(() => t.releaseAll());
    return t as Transport;
  };
  const connector = new McpConnector(config(realHash), factory);
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

describe("C09-06 explicit shutdown fencing", () => {
  it("an empty shutdown before any connection is a no-op; a repeated shutdown after a fresh call clears the new peer", async () => {
    const { connector, transports } = makeConnector();

    await track(connector.shutdown());
    await track(connector.shutdown());
    expect(transports.length).toBe(0);
    expect(connector.stats()).toEqual({
      connected: false,
      consecutiveFailures: 0,
      enabledBindings: [],
    });

    const first = track(connector.callTool(TOOL, { q: "fresh" }));
    expect(await first).toMatchObject({ ok: true, text: "hits" });
    expect(transports.length).toBe(1);
    const peer = transports[0] as ControlledTransport;
    expect(peer.closeCount).toBe(0);
    expect(connector.isAllowed(TOOL)).toBe(true);

    await track(connector.shutdown());
    expect(peer.closeCount).toBe(1);
    expect(connector.stats()).toEqual({
      connected: false,
      consecutiveFailures: 0,
      enabledBindings: [],
    });
    expect(connector.isAllowed(TOOL)).toBe(false);
  });

  it("rejects a configured call AT INVOCATION behind a held call, epoch-fences the queued one, and dedupes parallel shutdown", async () => {
    const peer = new ControlledTransport();
    peer.hangToolCall = true;
    const { connector, transports } = makeConnector([peer]);
    expect(await track(connector.ensureConnected())).toEqual({ ok: true });

    const first = track(connector.callTool(TOOL, { q: "held" }));
    // ACTUAL tools/call entered, not merely "a dial already exists".
    await peer.toolCallEntered.promise;
    const queuedBefore = track(connector.callTool(TOOL, { q: "queued" }));
    await flush();

    const shutdownA = track(connector.shutdown());
    const shutdownB = track(connector.shutdown());
    // Submitted AT INVOCATION while shutting down: fixed unavailable.
    const during = track(connector.callTool(TOOL, { q: "during" }));

    expect(await during).toEqual({ ok: false, code: "mcp_unavailable" });
    // Pre-shutdown queued distinct demand fails the epoch: no late dial.
    expect(await queuedBefore).toEqual({
      ok: false,
      code: "mcp_unavailable",
    });
    expect(await first).toEqual({ ok: false, code: "mcp_unavailable" });
    await Promise.all([shutdownA, shutdownB]);
    expect(peer.closeCount).toBe(1);
    expect(transports.length).toBe(1);

    // A NEW explicit call after shutdown reconnects and succeeds.
    const fresh = track(connector.callTool(TOOL, { q: "after" }));
    expect(await fresh).toMatchObject({ ok: true, text: "hits" });
    expect(transports.length).toBe(2);
    expect(connector.stats()).toMatchObject({
      connected: true,
      consecutiveFailures: 0,
    });
  });

  it("denies an unconfigured name with no I/O during a held shutdown and across the queued epoch", async () => {
    const peer = new ControlledTransport();
    peer.hangToolCall = true;
    const { connector, transports } = makeConnector([peer]);
    expect(await track(connector.ensureConnected())).toEqual({ ok: true });

    const held = track(connector.callTool(TOOL, { q: "held" }));
    await peer.toolCallEntered.promise;
    const shutdown = track(connector.shutdown());

    // Pure admission BEFORE the mutex: fixed denial, no dial, no tools/call.
    const deniedDuring = await connector.callTool("delete-event", { id: "1" });
    expect(deniedDuring).toEqual({
      ok: false,
      code: "mcp_binding_not_allowed",
    });
    expect(transports.length).toBe(1);
    expect(peer.toolCallCount).toBe(1);

    await shutdown;
    // Across the queued epoch the admission is unchanged and still pure.
    const deniedAfter = await connector.callTool("delete-event", { id: "2" });
    expect(deniedAfter).toEqual({
      ok: false,
      code: "mcp_binding_not_allowed",
    });
    expect(transports.length).toBe(1);
    expect(peer.toolCallCount).toBe(1);
    await held;
  });

  it("bounds a hanging generic close at exactly the configured grace window (no wall-clock wait)", async () => {
    const peer = new ControlledTransport();
    const { connector, transports } = makeConnector([peer]);
    expect(await track(connector.ensureConnected())).toEqual({ ok: true });
    peer.hangClose = true;

    const t0 = Date.now();
    const shutdown = track(connector.shutdown());
    let settled = false;
    void shutdown.then(() => {
      settled = true;
    });
    const during = track(connector.callTool(TOOL, { q: "during" }));
    expect(await during).toEqual({ ok: false, code: "mcp_unavailable" });

    await flush();
    await vi.advanceTimersByTimeAsync(99);
    expect(Date.now() - t0).toBe(99);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(Date.now() - t0).toBe(100);
    await shutdown;
    expect(settled).toBe(true);
    expect(transports.length).toBe(1);

    // A fresh explicit call reconnects despite the abandoned hanging close.
    const fresh = track(connector.callTool(TOOL, { q: "fresh" }));
    expect(await fresh).toMatchObject({ ok: true, text: "hits" });
    expect(transports.length).toBe(2);
  });

  it("cancels a hanging RAW start at shutdown and frees the connect singleflight/mutex; the late start does not poison the fresh peer", async () => {
    const peer = new ControlledTransport();
    peer.startGate = deferred<void>();
    const { connector, transports } = makeConnector([peer]);

    const connect = track(connector.callTool(TOOL, { q: "start-hang" }));
    await peer.startEntered.promise;
    const shutdown = track(connector.shutdown());
    expect(await connect).toEqual({ ok: false, code: "mcp_unavailable" });
    await shutdown;
    expect(transports.length).toBe(1);
    expect(peer.hostResourceOpen).toBe(false);

    // New post-shutdown explicit call connects healthy while the OLD raw start
    // promise is still unsettled.
    const fresh = track(connector.callTool(TOOL, { q: "fresh" }));
    expect(await fresh).toMatchObject({ ok: true, text: "hits" });
    expect(transports.length).toBe(2);
    const freshPeer = transports[1] as ControlledTransport;
    expect(freshPeer.closeCount).toBe(0);

    // Late completion of the OLD start creates the resource; the owned late
    // cleanup must close it without touching the fresh peer.
    peer.startGate?.resolve();
    await peer.resourceClosed.promise;
    expect(peer.hostResourceOpen).toBe(false);
    expect(peer.closeCount).toBe(2);
    expect(connector.stats()).toMatchObject({
      connected: true,
      consecutiveFailures: 0,
      enabledBindings: [TOOL],
    });
    expect(connector.isAllowed(TOOL)).toBe(true);
    expect(transports.length).toBe(2);
  });

  it("cancels a hanging notifications/initialized SEND at shutdown; releasing it after the fresh peer is ready is inert", async () => {
    const peer = new ControlledTransport();
    peer.initializedGate = deferred<void>();
    const { connector, transports } = makeConnector([peer]);

    const connect = track(connector.callTool(TOOL, { q: "notify-hang" }));
    await peer.initializedEntered.promise;
    const shutdown = track(connector.shutdown());
    expect(await connect).toEqual({ ok: false, code: "mcp_unavailable" });
    await shutdown;

    const fresh = track(connector.callTool(TOOL, { q: "fresh" }));
    expect(await fresh).toMatchObject({ ok: true, text: "hits" });
    expect(transports.length).toBe(2);
    const freshPeer = transports[1] as ControlledTransport;

    // Release the OLD initialized send only AFTER the fresh peer is ready:
    // no late publication, no close, no new failure.
    peer.initializedGate?.resolve();
    await flush();
    expect(connector.stats()).toMatchObject({
      connected: true,
      consecutiveFailures: 0,
      enabledBindings: [TOOL],
    });
    expect(connector.isAllowed(TOOL)).toBe(true);
    expect(freshPeer.closeCount).toBe(0);
    expect(transports.length).toBe(2);
  });

  it("bounded-cleans a NEW resource created by a late raw start that completes after the stop, keeping a second untouched peer", async () => {
    const peer = new ControlledTransport();
    peer.startGate = deferred<void>();
    const { connector, transports } = makeConnector([peer]);

    const connect = track(connector.callTool(TOOL, { q: "late-start" }));
    await peer.startEntered.promise;
    const shutdown = track(connector.shutdown());
    expect(await connect).toEqual({ ok: false, code: "mcp_unavailable" });
    await shutdown;
    // The first owned close settled BEFORE the resource existed: one close, no
    // onclose, nothing to release.
    expect(peer.hostResourceOpen).toBe(false);
    expect(peer.closeCount).toBe(1);

    const fresh = track(connector.callTool(TOOL, { q: "fresh" }));
    expect(await fresh).toMatchObject({ ok: true, text: "hits" });
    expect(transports.length).toBe(2);
    const freshPeer = transports[1] as ControlledTransport;
    expect(freshPeer.closeCount).toBe(0);

    peer.startGate?.resolve();
    await peer.resourceClosed.promise;
    // The late-created resource is really closed; a second legitimate close is
    // expected because the first cleanup preceded the resource's existence.
    expect(peer.hostResourceOpen).toBe(false);
    expect(peer.closeCount).toBe(2);
    expect(connector.stats()).toMatchObject({
      connected: true,
      consecutiveFailures: 0,
      enabledBindings: [TOOL],
    });
    expect(connector.isAllowed(TOOL)).toBe(true);
    expect(transports.length).toBe(2);
  });

  it("releases the raw start gate then immediately shuts down: ONE generic physical close", async () => {
    const peer = new ControlledTransport();
    peer.startGate = deferred<void>();
    const { connector, transports } = makeConnector([peer]);

    const connect = track(
      connector.callTool(TOOL, { q: "gate-then-shutdown" }),
    );
    await peer.startEntered.promise;

    // Release the raw start gate and request shutdown in the same turn: the
    // handoff can complete BEFORE the first deferred physical raw.close runs.
    // That must NOT be treated as a pre-handoff close, which would drop the
    // memo and issue a needless SECOND generic physical close.
    peer.startGate.resolve();
    const shutdown = track(connector.shutdown());

    expect(await connect).toEqual({ ok: false, code: "mcp_unavailable" });
    await shutdown;
    // Exactly one close released the resource created by the handoff.
    expect(peer.hostResourceOpen).toBe(false);
    expect(peer.closeCount).toBe(1);
    // No fresh dial and no readiness published from the stopped attempt.
    expect(transports.length).toBe(1);
    expect(connector.stats()).toEqual({
      connected: false,
      consecutiveFailures: 0,
      enabledBindings: [],
    });

    // A fresh explicit call still connects normally on a new peer.
    const fresh = track(connector.callTool(TOOL, { q: "fresh" }));
    expect(await fresh).toMatchObject({ ok: true, text: "hits" });
    expect(transports.length).toBe(2);
    const freshPeer = transports[1] as ControlledTransport;
    expect(freshPeer.closeCount).toBe(0);
  });

  it("re-closes a late resource when the earlier close released the start gate and NEVER settled", async () => {
    const peer = new ControlledTransport();
    peer.startGate = deferred<void>();
    peer.releaseStartOnClose = true;
    peer.closeNeverSettles = true;
    const { connector, transports } = makeConnector([peer]);

    const connect = track(connector.callTool(TOOL, { q: "gate-close-never" }));
    await peer.startEntered.promise;
    const shutdown = track(connector.shutdown());
    // The bounded cleanup's first close releases the raw start gate and then
    // never settles: the resource is created only after that close invocation.
    await peer.closeEntered.promise;
    await peer.resourceClosed.promise;
    expect(peer.hostResourceOpen).toBe(false);
    // A second legitimate close was required; the never-settled first memo
    // could not cover a resource that did not exist when it was invoked.
    expect(peer.closeCount).toBe(2);
    expect(await connect).toEqual({ ok: false, code: "mcp_unavailable" });
    await shutdown;
    await flush();

    // A fresh explicit call connects while the OLD never-settling close memo is
    // still pending; the fresh peer must not be poisoned.
    const fresh = track(connector.callTool(TOOL, { q: "fresh" }));
    expect(await fresh).toMatchObject({ ok: true, text: "hits" });
    expect(transports.length).toBe(2);
    const freshPeer = transports[1] as ControlledTransport;
    expect(freshPeer.closeCount).toBe(0);
    expect(connector.stats()).toMatchObject({
      connected: true,
      consecutiveFailures: 0,
      enabledBindings: [TOOL],
    });
    expect(connector.isAllowed(TOOL)).toBe(true);

    // Past the configured grace + fixed post-kill window the late resource
    // stays closed and the fresh peer's state is untouched.
    await vi.advanceTimersByTimeAsync(3000);
    expect(peer.hostResourceOpen).toBe(false);
    expect(peer.closeCount).toBe(2);
    expect(connector.stats()).toMatchObject({
      connected: true,
      consecutiveFailures: 0,
    });
    expect(freshPeer.closeCount).toBe(0);
    expect(transports.length).toBe(2);
  });

  it("re-closes a late resource when the earlier gate-releasing close settled on a microtask", async () => {
    const peer = new ControlledTransport();
    peer.startGate = deferred<void>();
    peer.releaseStartOnClose = true;
    // closeNeverSettles stays false: the first close settles immediately, so
    // the resource handoff crosses a distinct close generation boundary.
    const { connector, transports } = makeConnector([peer]);

    const connect = track(connector.callTool(TOOL, { q: "gate-close-micro" }));
    await peer.startEntered.promise;
    const shutdown = track(connector.shutdown());
    await peer.closeEntered.promise;
    await peer.resourceClosed.promise;
    expect(peer.hostResourceOpen).toBe(false);
    expect(peer.closeCount).toBe(2);
    expect(await connect).toEqual({ ok: false, code: "mcp_unavailable" });
    await shutdown;

    const fresh = track(connector.callTool(TOOL, { q: "fresh" }));
    expect(await fresh).toMatchObject({ ok: true, text: "hits" });
    expect(transports.length).toBe(2);
    expect(connector.stats()).toMatchObject({
      connected: true,
      consecutiveFailures: 0,
      enabledBindings: [TOOL],
    });
    expect(connector.isAllowed(TOOL)).toBe(true);
  });

  it("closes a resource created and then REJECTED by a late raw start after shutdown and a fresh peer", async () => {
    const peer = new ControlledTransport();
    peer.startGate = deferred<void>();
    peer.rejectAfterStart = true;
    const { connector, transports } = makeConnector([peer]);

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const connect = track(connector.callTool(TOOL, { q: "late-reject" }));
      await peer.startEntered.promise;
      const shutdown = track(connector.shutdown());
      expect(await connect).toEqual({ ok: false, code: "mcp_unavailable" });
      await shutdown;
      // The first close preceded the resource: one close, nothing to release.
      expect(peer.hostResourceOpen).toBe(false);
      expect(peer.closeCount).toBe(1);

      // A fresh peer becomes ready while the OLD raw start is still pending.
      const fresh = track(connector.callTool(TOOL, { q: "fresh" }));
      expect(await fresh).toMatchObject({ ok: true, text: "hits" });
      expect(transports.length).toBe(2);
      const freshPeer = transports[1] as ControlledTransport;
      expect(freshPeer.closeCount).toBe(0);

      // NOW the old start creates its resource and then rejects: the bounded
      // late handoff cleanup must run for the rejection too, not only on
      // fulfilment, with no readiness publication and no unhandled rejection.
      peer.startGate?.resolve();
      await peer.resourceClosed.promise;
      expect(peer.hostResourceOpen).toBe(false);
      expect(peer.closeCount).toBe(2);
      await flush();
      // Native next-macrotask yield (setImmediate is NOT faked) so Node can
      // surface any late rejection that the aborted opening promise might leak.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);

      expect(connector.stats()).toMatchObject({
        connected: true,
        consecutiveFailures: 0,
        enabledBindings: [TOOL],
      });
      expect(connector.isAllowed(TOOL)).toBe(true);
      expect(freshPeer.toolCallCount).toBe(1);
      expect(transports.length).toBe(2);

      // Past the grace + post-kill window the fresh peer is still untouched.
      await vi.advanceTimersByTimeAsync(3000);
      expect(peer.hostResourceOpen).toBe(false);
      expect(freshPeer.closeCount).toBe(0);
      expect(connector.stats()).toMatchObject({
        connected: true,
        consecutiveFailures: 0,
      });
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("shares ONE factory/initialize across concurrent public ensure calls (no orphan peer)", async () => {
    const peer = new ControlledTransport();
    peer.initializeGate = deferred<void>();
    const { connector, transports } = makeConnector([peer]);

    const a = track(connector.ensureConnected());
    const b = track(connector.ensureConnected());
    await peer.initializeEntered.promise;
    expect(transports.length).toBe(1);
    expect(peer.initializeCount).toBe(1);

    peer.initializeGate?.resolve();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toEqual({ ok: true });
    expect(rb).toEqual({ ok: true });
    expect(peer.initializeCount).toBe(1);
    expect(transports.length).toBe(1);
    expect(connector.isAllowed(TOOL)).toBe(true);
  });
});
