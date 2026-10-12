/**
 * C09-02 / C09-03 demand lifecycle contract (plan §17.6–§17.8).
 *
 * Consumer-behavior regression over the REAL @modelcontextprotocol/sdk 1.30.0
 * Client + McpServer linked by InMemoryTransport. No SDK method mocking, no
 * private-field inspection, no network/spawn, no OAuth, no upstream compat
 * claim. A deterministic fake clock (only `setTimeout`/`clearTimeout`/`Date`)
 * drives the connector's demand backoff; provider-side handlers and factory
 * counters are the only observations. Logical markers (`q`) exist ONLY to
 * distinguish execution order/counts — the asserted values are the connector's
 * public `CallResult`/`stats()`, never an echo.
 *
 * Covered:
 * - lazy construction / idle clock / immediate first dial / exact 1s,2s,5s,
 *   10s,30s,30s backoff with one physical attempt per logical demand;
 * - a successful connect resets the failure counter and a live handshake is
 *   reused (a later loss waits 1s again, not 2s);
 * - a failed in-flight call is never replayed (no logical resend) while a
 *   queued distinct call may reconnect after the reset backoff;
 * - per-instance concurrency 1 (a queued call cannot overlap a gated one);
 * - independent instances never share a global mutex.
 */
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { z } from "zod";
import {
  type CallResult,
  McpConnector,
  STDIO_IMPLICIT_ENV_VARS,
  type TransportFactory,
} from "../src/client.js";
import type {
  McpBindingDefinition,
  McpConnectorConfig,
} from "../src/config.js";
import {
  canonicalSchemaHash,
  mcpConnectorConfigSchema,
} from "../src/config.js";

const WIRE_NAME = "fake-calendar";
const WIRE_VERSION = "0.0.0-proposed.1";
const SENTINEL = "sk-inert-fixture-do-not-leak /etc/passwd-shadow";
const SEARCH_INPUT_SCHEMA = {
  q: z.string(),
  maxResults: z.number().optional(),
};

let realHash = "";

/** Learns the real registered readonly tool input-schema hash via a throwaway
 * SDK client over a fresh in-memory pair (closed immediately). Not permanent. */
async function probeSearchHash(): Promise<string> {
  const server = new McpServer({ name: "hash-probe", version: "0.0.0" });
  server.registerTool(
    "search-events",
    { description: "probe", inputSchema: SEARCH_INPUT_SCHEMA },
    async () => ({ content: [{ type: "text" as const, text: "x" }] }),
  );
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const probe = new Client(
    { name: "probe", version: "0.0.0" },
    { capabilities: {} },
  );
  await probe.connect(ct);
  const listed = await probe.listTools();
  const hash = await canonicalSchemaHash(
    listed.tools.find((t) => t.name === "search-events")?.inputSchema,
  );
  await probe.close().catch(() => undefined);
  await server.close().catch(() => undefined);
  return hash;
}

// The probe needs real timers: computed once before any fake clock is installed.
beforeAll(async () => {
  realHash = await probeSearchHash();
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface ProducerConnection {
  server: McpServer;
  clientTransport: Transport;
}

/**
 * Local fixture: each factory call creates a FRESH real McpServer linked over
 * InMemoryTransport and returns the client side. The handler records logical
 * entry order and per-instance activity, and can be gated / made to throw.
 * Nothing here is exported or reused outside this file.
 */
function createProducer() {
  const attemptTimes: number[] = [];
  const entered: string[] = [];
  let active = 0;
  let peak = 0;
  let refuseBudget = 0;
  const connections: ProducerConnection[] = [];
  const holdGates = new Map<string, Deferred<void>>();
  const entryWaiters = new Map<string, Deferred<void>>();
  const throwMarkers = new Map<string, Error>();

  const factory: TransportFactory = () => {
    attemptTimes.push(Date.now());
    if (refuseBudget > 0) {
      if (Number.isFinite(refuseBudget)) refuseBudget -= 1;
      // Real factory boundary: fails before any transport is constructed.
      throw new Error("connect refused before transport construction");
    }
    const server = new McpServer({ name: WIRE_NAME, version: WIRE_VERSION });
    server.registerTool(
      "search-events",
      { description: "fake readonly search", inputSchema: SEARCH_INPUT_SCHEMA },
      async ({ q }) => {
        entered.push(q);
        active += 1;
        peak = Math.max(peak, active);
        const waiter = entryWaiters.get(q);
        if (waiter !== undefined) {
          entryWaiters.delete(q);
          waiter.resolve();
        }
        try {
          const thrown = throwMarkers.get(q);
          if (thrown !== undefined) throw thrown;
          const hold = holdGates.get(q);
          if (hold !== undefined) await hold.promise;
          return {
            content: [{ type: "text" as const, text: "hits" }],
            structuredContent: { totalCount: 1 },
          };
        } finally {
          active -= 1;
        }
      },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    void server.connect(serverTransport).catch(() => undefined);
    connections.push({
      server,
      clientTransport: clientTransport as unknown as Transport,
    });
    return clientTransport as unknown as Transport;
  };

  return {
    factory,
    attemptTimes,
    attempted: () => attemptTimes.length,
    entered,
    activeCount: () => active,
    peakActive: () => peak,
    refuseConnects(n: number) {
      refuseBudget = n;
    },
    hold(marker: string) {
      if (!holdGates.has(marker)) holdGates.set(marker, deferred<void>());
    },
    release(marker: string) {
      holdGates.get(marker)?.resolve();
    },
    waitEntry(marker: string): Promise<void> {
      if (entered.includes(marker)) return Promise.resolve();
      let waiter = entryWaiters.get(marker);
      if (waiter === undefined) {
        waiter = deferred<void>();
        entryWaiters.set(marker, waiter);
      }
      return waiter.promise;
    },
    throwOn(marker: string, error: Error) {
      throwMarkers.set(marker, error);
    },
    async closeConnections() {
      for (const c of connections) {
        await c.server.close().catch(() => undefined);
      }
    },
    /** Release every held handler gate only (no transport/client close). */
    releaseAllGates() {
      for (const gate of holdGates.values()) gate.resolve();
    },
    async closeAll() {
      for (const c of connections) {
        await c.server.close().catch(() => undefined);
        await c.clientTransport.close?.().catch(() => undefined);
      }
    },
  };
}

type Producer = ReturnType<typeof createProducer>;

/**
 * Per-test cleanup collections.
 *
 * - `pendingCalls` tracks EVERY logical call promise (first and queued) so
 *   teardown can settle outstanding demand work deterministically.
 * - `producers` / `connectors` are closed ONLY after all tracked calls have
 *   settled, so a queued backoff can never reconnect after shutdown, leak an
 *   unhandled rejection, or strand a held gate.
 */
const pendingCalls: Promise<unknown>[] = [];
const producers: Producer[] = [];
const connectors: McpConnector[] = [];

/** Issue a logical call and register its promise for teardown. */
function call(
  connector: McpConnector,
  upstreamTool: string,
  args: unknown,
): Promise<CallResult> {
  const promise = connector.callTool(upstreamTool, args);
  pendingCalls.push(promise);
  return promise;
}

function makeConfig(): McpConnectorConfig {
  return mcpConnectorConfigSchema.parse({
    connectorInstanceId: "cal-lifecycle",
    // Logical id deliberately unlike the wire identity.
    serverId: "logical-google-calendar-fork",
    kind: "mcp" as const,
    expectedServerName: WIRE_NAME,
    version: WIRE_VERSION,
    transport: {
      kind: "stdio" as const,
      command: "unused-injected",
      args: [] as string[],
      // Allowlist the in-memory test factory injection (no real spawn).
      envAllowlist: [...STDIO_IMPLICIT_ENV_VARS] as string[],
      shutdownWaitMs: 3000,
    },
    bindings: [
      { upstreamTool: "search-events", canonicalSchemaHash: realHash },
    ],
  });
}

function makeConnector(producer: Producer): McpConnector {
  // SOURCE-REVIEWED host fixture definition: the producer's only registered
  // upstream tool (`search-events`) is a static read handler, so the trusted
  // definition marks it explicitly `read` with the explicitly probed hash —
  // never inferred from the connector config.
  const definitions: McpBindingDefinition[] = [
    {
      upstreamTool: "search-events",
      canonicalSchemaHash: realHash,
      category: "read",
    },
  ];
  const connector = new McpConnector(
    makeConfig(),
    definitions,
    producer.factory,
  );
  producers.push(producer);
  connectors.push(connector);
  return connector;
}

/** Deterministic microtask flush: no wall-clock wait, no arbitrary sleep. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

beforeEach(() => {
  // Only the connector's demand timer + Date are faked; SDK microtasks and
  // setImmediate/queueMicrotask stay native so the real handshake runs.
  vi.useFakeTimers({ now: 0, toFake: ["setTimeout", "clearTimeout", "Date"] });
});

afterEach(async () => {
  // 1. Release EVERY held fixture gate FIRST (even when an assertion failed
  //    mid-test) so no handler promise can strand behind a never-resolved
  //    gate, including a future planned fixture gate.
  for (const producer of producers) producer.releaseAllGates();

  // 2. Drain pending queued logical work/backoff WHILE the fake clock is
  //    still installed: run every queued demand timer against the real SDK
  //    microtasks, then await each tracked call. Restoring real timers before
  //    this would silently lose a queued backoff (and could reconnect later).
  const pending = pendingCalls.splice(0);
  await vi.runAllTimersAsync();
  await Promise.allSettled(pending);

  // 3. Only after all logical work has settled: close the real clients and
  //    connector instances, then the producer/transport pairs.
  for (const connector of connectors.splice(0)) {
    await connector.shutdown().catch(() => undefined);
  }
  for (const producer of producers.splice(0)) {
    await producer.closeAll();
  }

  // 4. No timer may survive into the real-timer world.
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("McpConnector demand lifecycle (fake clock, real in-memory SDK)", () => {
  it("C09-02: lazy until first demand, immediate first dial, then 1/2/5/10/30/30s with one attempt per demand", async () => {
    const producer = createProducer();
    producer.refuseConnects(Number.POSITIVE_INFINITY);
    const connector = makeConnector(producer);

    // Construction + idle clock never create a transport.
    expect(connector.stats()).toEqual({
      connected: false,
      consecutiveFailures: 0,
      enabledBindings: [],
    });
    await vi.advanceTimersByTimeAsync(60000);
    expect(producer.attempted()).toBe(0);

    // Unconfigured binding: fixed denial, still no transport/handshake.
    const denied = await call(connector, "delete-event", { id: "42" });
    expect(denied).toEqual({ ok: false, code: "mcp_binding_not_allowed" });
    expect(producer.attempted()).toBe(0);

    // First configured demand: exactly one physical attempt at the CURRENT
    // fake Date (the idle clock above already advanced 60000ms, so this is NOT
    // 0), with no delay.
    const t0 = Date.now();
    const first = call(connector, "search-events", { q: "d0" });
    await flush();
    expect(producer.attempted()).toBe(1);
    expect(producer.attemptTimes[0]).toBe(t0);
    expect(await first).toEqual({ ok: false, code: "mcp_unavailable" });
    expect(connector.stats().consecutiveFailures).toBe(1);

    const schedule = [1000, 2000, 5000, 10000, 30000, 30000];
    // Backoff attempt timestamps are relative to the fake Date at t0.
    let expectedAt = t0;
    for (const delay of schedule) {
      expectedAt += delay;
      const before = producer.attempted();
      const demand = call(connector, "search-events", {
        q: `d${expectedAt}`,
      });
      await flush();
      // The demand is parked on the backoff: strictly no dialing before the
      // exact delay elapses, then exactly one attempt timestamped by fake Date.
      expect(producer.attempted()).toBe(before);
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(producer.attempted()).toBe(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(producer.attempted()).toBe(before + 1);
      expect(producer.attemptTimes.at(-1)).toBe(expectedAt);
      expect(await demand).toEqual({ ok: false, code: "mcp_unavailable" });
    }
    expect(connector.stats().consecutiveFailures).toBe(1 + schedule.length);

    // Idle after the failure: no background dial, counter preserved.
    const attemptsAfter = producer.attempted();
    await vi.advanceTimersByTimeAsync(300000);
    expect(producer.attempted()).toBe(attemptsAfter);
    expect(connector.stats().consecutiveFailures).toBe(1 + schedule.length);
  });

  it("C09-02: success resets backoff and reuses the handshake; a later loss waits 1s again", async () => {
    const producer = createProducer();
    producer.refuseConnects(1);
    const connector = makeConnector(producer);

    // t=0: first demand fails once (real factory boundary).
    const first = call(connector, "search-events", { q: "fail-1" });
    await flush();
    expect(producer.attempted()).toBe(1);
    expect(await first).toEqual({ ok: false, code: "mcp_unavailable" });
    expect(connector.stats()).toMatchObject({
      connected: false,
      consecutiveFailures: 1,
    });

    // After exactly 1s, a real SDK connect + call succeeds and resets failures.
    const second = call(connector, "search-events", { q: "ok-1" });
    await flush();
    await vi.advanceTimersByTimeAsync(999);
    expect(producer.attempted()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(producer.attempted()).toBe(2);
    expect(producer.attemptTimes.at(-1)).toBe(1000);
    expect(await second).toMatchObject({
      ok: true,
      structuredContent: { totalCount: 1 },
    });
    expect(connector.stats()).toMatchObject({
      connected: true,
      consecutiveFailures: 0,
    });

    // Further demand reuses the SAME live client/handshake: no new factory call.
    const third = call(connector, "search-events", { q: "ok-2" });
    expect(await third).toMatchObject({
      ok: true,
      structuredContent: { totalCount: 1 },
    });
    expect(producer.attempted()).toBe(2);

    // A real transport loss after success: logical call fails, state clears.
    producer.hold("boom");
    const fourth = call(connector, "search-events", { q: "boom" });
    await producer.waitEntry("boom");
    expect(producer.activeCount()).toBe(1);
    await producer.closeConnections();
    expect(await fourth).toEqual({ ok: false, code: "mcp_unavailable" });
    expect(connector.stats()).toMatchObject({
      connected: false,
      consecutiveFailures: 1,
    });
    producer.release("boom");

    // Backoff was reset by the success: the next demand waits 1s, not 2s.
    const fifth = call(connector, "search-events", { q: "ok-3" });
    await flush();
    await vi.advanceTimersByTimeAsync(999);
    expect(producer.attempted()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(producer.attempted()).toBe(3);
    expect(producer.attemptTimes.at(-1)).toBe(2000);
    expect(await fifth).toMatchObject({
      ok: true,
      structuredContent: { totalCount: 1 },
    });
    expect(producer.entered).toEqual(["ok-1", "ok-2", "boom", "ok-3"]);
  });

  it("C09-03: failed in-flight call is never replayed; queued distinct call reconnects and succeeds", async () => {
    const producer = createProducer();
    const connector = makeConnector(producer);

    // Establish one live connection and gate its first handler.
    producer.hold("boom");
    const first = call(connector, "search-events", { q: "boom" });
    await producer.waitEntry("boom");
    expect(producer.attempted()).toBe(1);
    expect(producer.activeCount()).toBe(1);

    // Second distinct logical call: queued behind the per-instance mutex.
    const second = call(connector, "search-events", { q: "next" });
    await flush();
    expect(producer.entered).toEqual(["boom"]);
    expect(producer.activeCount()).toBe(1);

    // Real server/transport closes BEFORE the first response -> Client request
    // rejects; public result is the fixed redacted unavailable, state cleared.
    await producer.closeConnections();
    const firstResult = await first;
    expect(firstResult).toEqual({ ok: false, code: "mcp_unavailable" });
    expect(JSON.stringify(firstResult)).not.toContain(SENTINEL);
    expect(connector.stats()).toMatchObject({
      connected: false,
      consecutiveFailures: 1,
    });
    producer.release("boom");

    // The queued call dials a FRESH real server after the reset backoff and
    // succeeds; the predecessor marker is never re-executed (no logical resend).
    await flush();
    await vi.advanceTimersByTimeAsync(999);
    expect(producer.attempted()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(producer.attempted()).toBe(2);
    expect(await second).toMatchObject({
      ok: true,
      structuredContent: { totalCount: 1 },
    });
    expect(producer.entered).toEqual(["boom", "next"]);
    expect(producer.entered.filter((m) => m === "boom")).toHaveLength(1);

    // Idle clock after the reconnect: no background dial, no replay.
    await vi.advanceTimersByTimeAsync(120000);
    expect(producer.attempted()).toBe(2);
    expect(producer.entered).toEqual(["boom", "next"]);

    // Redaction: an inert sentinel secret/path thrown by the fixture handler is
    // a tool-level error, mapped to a fixed code with no raw text in the result.
    producer.throwOn("leak", new Error(`raw upstream error ${SENTINEL}`));
    const leak = await call(connector, "search-events", { q: "leak" });
    expect(leak).toEqual({ ok: false, code: "calendar_upstream_error" });
    expect(JSON.stringify(leak)).not.toContain(SENTINEL);
    expect(producer.entered).toEqual(["boom", "next", "leak"]);
  });

  it("C09-03: same-instance concurrent calls serialize with true concurrency 1", async () => {
    const producer = createProducer();
    const connector = makeConnector(producer);

    producer.hold("gate-1");
    const first = call(connector, "search-events", { q: "gate-1" });
    await producer.waitEntry("gate-1");
    expect(producer.activeCount()).toBe(1);
    expect(producer.attempted()).toBe(1);

    const second = call(connector, "search-events", { q: "gate-2" });
    // Full microtask/event-loop chance for the queued call to (wrongly) enter.
    await flush();
    await flush();
    // Only the first handler is active/entered: no overlap (would be peak 2).
    expect(producer.entered).toEqual(["gate-1"]);
    expect(producer.activeCount()).toBe(1);
    expect(producer.peakActive()).toBe(1);

    producer.release("gate-1");
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1).toMatchObject({
      ok: true,
      structuredContent: { totalCount: 1 },
    });
    expect(r2).toMatchObject({
      ok: true,
      structuredContent: { totalCount: 1 },
    });
    expect(producer.entered).toEqual(["gate-1", "gate-2"]);
    expect(producer.peakActive()).toBe(1);
    expect(producer.attempted()).toBe(1); // one connection, reused
  });

  it("C09-03: separate instances are independent; a gated handler on A does not block B", async () => {
    const producerA = createProducer();
    const producerB = createProducer();
    const connectorA = makeConnector(producerA);
    const connectorB = makeConnector(producerB);

    producerA.hold("a-1");
    const callA = call(connectorA, "search-events", { q: "a-1" });
    await producerA.waitEntry("a-1");
    expect(producerA.activeCount()).toBe(1);

    // B connects and completes while A's handler is still gated (no global mutex).
    const callB = call(connectorB, "search-events", { q: "b-1" });
    await producerB.waitEntry("b-1");
    expect(await callB).toMatchObject({
      ok: true,
      structuredContent: { totalCount: 1 },
    });
    expect(producerA.activeCount()).toBe(1); // A still gated after B completed
    expect(producerA.entered).toEqual(["a-1"]);
    expect(producerB.entered).toEqual(["b-1"]);

    producerA.release("a-1");
    expect(await callA).toMatchObject({
      ok: true,
      structuredContent: { totalCount: 1 },
    });
    // Each instance stayed at <=1 own active handler on its own connection.
    expect(producerA.peakActive()).toBe(1);
    expect(producerB.peakActive()).toBe(1);
    expect(producerA.attempted()).toBe(1);
    expect(producerB.attempted()).toBe(1);
  });

  it("P2: shutdown cancels a fenced backoff wait, frees the mutex, and removes the stale timer without replay", async () => {
    const producer = createProducer();
    // Every physical dial is refused at the factory boundary.
    producer.refuseConnects(Number.POSITIVE_INFINITY);
    const connector = makeConnector(producer);

    // Five refused attempts: immediate, then exactly 1/2/5/10s.
    const first = call(connector, "search-events", { q: "f1" });
    await flush();
    expect(producer.attempted()).toBe(1);
    expect(await first).toEqual({ ok: false, code: "mcp_unavailable" });
    for (const delay of [1000, 2000, 5000, 10000]) {
      const before = producer.attempted();
      const demand = call(connector, "search-events", { q: `f${delay}` });
      await flush();
      expect(producer.attempted()).toBe(before);
      await vi.advanceTimersByTimeAsync(delay);
      expect(producer.attempted()).toBe(before + 1);
      expect(await demand).toEqual({ ok: false, code: "mcp_unavailable" });
    }
    expect(connector.stats().consecutiveFailures).toBe(5);

    // Old demand parks on the max 30s backoff while holding the mutex; a second
    // distinct demand queues behind it (no dial before the delay).
    const oldA = call(connector, "search-events", { q: "old-a" });
    await flush();
    const oldB = call(connector, "search-events", { q: "old-b" });
    await flush();
    const attemptsBeforeShutdown = producer.attempted();
    expect(attemptsBeforeShutdown).toBe(5);

    // Shutdown fences + aborts the backoff SYNCHRONOUSLY: both old demands and a
    // during-shutdown call/direct ensure are unavailable WITHOUT advancing the
    // 30s timer, and the factory is never called again.
    const shutdown = connector.shutdown();
    const during = call(connector, "search-events", { q: "during" });
    const duringEnsure = connector.ensureConnected();
    expect(await during).toEqual({ ok: false, code: "mcp_unavailable" });
    expect(await duringEnsure).toEqual({ ok: false, code: "mcp_unavailable" });
    expect(await oldA).toEqual({ ok: false, code: "mcp_unavailable" });
    expect(await oldB).toEqual({ ok: false, code: "mcp_unavailable" });
    await shutdown;
    expect(producer.attempted()).toBe(attemptsBeforeShutdown);
    // Shutdown must NOT reset the failure counter (fresh demand owns its delay).
    expect(connector.stats().consecutiveFailures).toBe(5);

    // The stale 30s timer was REMOVED, not merely fenced: advancing the whole old
    // delay dials nothing and never replays a failed logical call.
    await vi.advanceTimersByTimeAsync(30000);
    expect(producer.attempted()).toBe(attemptsBeforeShutdown);
    expect(producer.entered).toEqual([]);
    expect(connector.stats().consecutiveFailures).toBe(5);
  });

  it("P2: a fresh post-shutdown demand owns its FULL new max backoff, not the old remaining delay", async () => {
    const producer = createProducer();
    // Exactly five refused dials, so the sixth physical attempt is healthy.
    producer.refuseConnects(5);
    const connector = makeConnector(producer);

    const first = call(connector, "search-events", { q: "f1" });
    await flush();
    expect(await first).toEqual({ ok: false, code: "mcp_unavailable" });
    for (const delay of [1000, 2000, 5000, 10000]) {
      const demand = call(connector, "search-events", { q: `f${delay}` });
      await flush();
      await vi.advanceTimersByTimeAsync(delay);
      expect(await demand).toEqual({ ok: false, code: "mcp_unavailable" });
    }
    expect(connector.stats().consecutiveFailures).toBe(5);

    // Old demand parks on a 30s backoff; consume only 123ms of it.
    const old = call(connector, "search-events", { q: "old" });
    await flush();
    expect(producer.attempted()).toBe(5);
    await vi.advanceTimersByTimeAsync(123);
    expect(producer.attempted()).toBe(5);

    // Shutdown aborts the stale wait; the old demand is immediately unavailable
    // and the failure count is preserved for the fresh demand's OWN full delay.
    await connector.shutdown();
    expect(await old).toEqual({ ok: false, code: "mcp_unavailable" });
    expect(connector.stats().consecutiveFailures).toBe(5);

    const freshInvoke = Date.now();
    const fresh = call(connector, "search-events", { q: "fresh" });
    await flush();
    expect(producer.attempted()).toBe(5);
    await vi.advanceTimersByTimeAsync(29999);
    expect(producer.attempted()).toBe(5);
    await vi.advanceTimersByTimeAsync(1);
    expect(producer.attempted()).toBe(6);
    expect(await fresh).toMatchObject({
      ok: true,
      structuredContent: { totalCount: 1 },
    });
    // Exactly one fresh physical dial, exactly 30s after its own invocation.
    expect(producer.attemptTimes.at(-1)).toBe(freshInvoke + 30000);
    // Only the fresh marker ever reached the real provider: no replay/resend.
    expect(producer.entered).toEqual(["fresh"]);
    expect(connector.stats()).toMatchObject({
      connected: true,
      consecutiveFailures: 0,
      enabledBindings: ["search-events"],
    });
  });
});
