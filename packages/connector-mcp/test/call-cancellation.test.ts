/**
 * Abort-cancellation regression (PR #10 review thread r3965812073).
 * McpConnector.callTool accepts an optional AbortSignal and forwards it via
 * the SDK-native per-request option (`Client.callTool(params, resultSchema?,
 * options?: RequestOptions)`, verified @modelcontextprotocol/sdk 1.30.0
 * official source/types — no Promise.race, no speculative API).
 *
 * This file uses a REAL `McpServer` + real `InMemoryTransport` linked pair
 * whose registered read handler HANGS until its own `extra.signal` aborts (no
 * fake transport, no Promise.race, no Client method patch, no sleeps and no
 * wall-clock latency assertion). It proves:
 * - an aborted hanging call settles with the fixed `mcp_unavailable`;
 * - the SDK-native `notifications/cancelled` actually crosses the wire, but
 *   carries the connector's fixed reason, never the caller's private abort
 *   reason bytes (a caller signal forwarded DIRECTLY would leak them);
 * - the server handler's own SDK abort signal actually fires;
 * - the mutex is released and a distinct queued call reconnects on a fresh
 *   peer and succeeds, exactly once per logical call (no automatic replay).
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { McpConnector, STDIO_IMPLICIT_ENV_VARS } from "../src/client.js";
import type {
  McpBindingDefinition,
  McpConnectorConfig,
} from "../src/config.js";
import {
  canonicalSchemaHash,
  mcpConnectorConfigSchema,
} from "../src/config.js";

const WIRE_NAME = "fake-calendar";
const WIRE_VERSION = "0.0.0";
const TOOL = "search-events";
/** Synthetic private markers: neither may ever appear in a fixed result/notice. */
const SECRET = "sk-inert-abort-reason-do-not-leak";
const PRIVATE_PATH = "/etc/private-abort-do-not-leak";

/**
 * SOURCE-REVIEWED host fixture definition: the only upstream tool this file's
 * real server advertises (`search-events`) is a static read handler, so the
 * trusted definition marks it explicitly `read` with an explicitly written
 * hash — never inferred from the connector config or any wire metadata.
 */
function readDefinition(
  upstreamTool: string,
  schemaHash: string,
): McpBindingDefinition {
  return { upstreamTool, canonicalSchemaHash: schemaHash, category: "read" };
}

const INPUT_SCHEMA = { q: z.string() };

let realHash = "";

/** Learn the ACTUAL advertised input-schema hash (deterministic, throwaway). */
async function probeHash(): Promise<string> {
  const server = new McpServer({ name: "hash-probe", version: "0.0.0" });
  server.registerTool(
    TOOL,
    { description: "probe", inputSchema: INPUT_SCHEMA },
    async () => ({ content: [{ type: "text" as const, text: "x" }] }),
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const probe = new Client(
    { name: "probe", version: "0.0.0" },
    { capabilities: {} },
  );
  await probe.connect(clientTransport);
  const listed = await probe.listTools();
  const hash = await canonicalSchemaHash(
    listed.tools.find((t) => t.name === TOOL)?.inputSchema,
  );
  await probe.close().catch(() => undefined);
  await server.close().catch(() => undefined);
  return hash;
}

// The probe needs real timers: computed once before any test runs.
beforeAll(async () => {
  realHash = await probeHash();
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

/** Structural view of a raw JSON-RPC wire message. */
interface WireMessage {
  jsonrpc?: unknown;
  id?: string | number;
  method?: unknown;
  params?: { requestId?: unknown; reason?: unknown };
}

interface RealPeer {
  clientTransport: Transport;
  /** Every raw message the server peer received, before SDK delegation. */
  received: WireMessage[];
  handlerCalls: () => number;
  /** Resolves when the registered handler is actually entered (mutex held). */
  entered: Promise<void>;
  /** Resolves with the handler's own SDK abort reason once it aborts. */
  abortedWith: Promise<unknown>;
}

const closables: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  const pending = closables.splice(0);
  for (const close of pending) {
    await close().catch(() => undefined);
  }
});

/**
 * Real SDK `McpServer` linked over `InMemoryTransport`. When `hang` is set the
 * read handler waits until its OWN `extra.signal` aborts (resolved by an
 * optional fixture-controlled teardown so no Promise/timer can leak).
 *
 * The public server transport `onmessage` is wrapped AFTER connect (preserving
 * the SDK Protocol handler) so the test observes the ACTUAL wire notification
 * before delegation — the SDK's reserved cancellation handler is never removed.
 */
async function makePeer(opts: { hang: boolean }): Promise<RealPeer> {
  let handlerCalls = 0;
  const entered = deferred<void>();
  const abortedWith = deferred<unknown>();
  let forceRelease: (() => void) | undefined;
  const received: WireMessage[] = [];

  const server = new McpServer({ name: WIRE_NAME, version: WIRE_VERSION });
  server.registerTool(
    TOOL,
    { description: "real hanging read fixture", inputSchema: INPUT_SCHEMA },
    async (_args, extra) => {
      handlerCalls += 1;
      entered.resolve();
      if (opts.hang) {
        await new Promise<void>((resolve) => {
          const done = () => {
            abortedWith.resolve(extra.signal.reason);
            resolve();
          };
          forceRelease = resolve;
          if (extra.signal.aborted) {
            done();
            return;
          }
          extra.signal.addEventListener("abort", done, { once: true });
        });
      }
      return {
        content: [{ type: "text" as const, text: "hits" }],
        structuredContent: { totalCount: 1 },
      };
    },
  );

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const delegate = serverTransport.onmessage;
  serverTransport.onmessage = ((message, extra) => {
    received.push(message as unknown as WireMessage);
    delegate?.(message, extra);
  }) as NonNullable<typeof serverTransport.onmessage>;

  closables.push(async () => {
    forceRelease?.();
    await server.close();
  });

  return {
    clientTransport: clientTransport as unknown as Transport,
    received,
    handlerCalls: () => handlerCalls,
    entered: entered.promise,
    abortedWith: abortedWith.promise,
  };
}

describe("McpConnector callTool abort propagation (real SDK peer)", () => {
  it("aborting a hanging call returns fixed mcp_unavailable without leaking the caller reason and frees the mutex", async () => {
    // Two FRESH precreated peers: the first hangs and is torn down by the
    // abort; the factory-synchronous second is ready for the lazy reconnect
    // (the closed first pair can never be reused).
    const hanging = await makePeer({ hang: true });
    const recovered = await makePeer({ hang: false });

    let dials = 0;
    const config: McpConnectorConfig = mcpConnectorConfigSchema.parse({
      connectorInstanceId: "cal-1",
      serverId: "fake",
      kind: "mcp" as const,
      expectedServerName: WIRE_NAME,
      version: WIRE_VERSION,
      transport: {
        kind: "stdio" as const,
        command: "unused-injected",
        args: [] as string[],
        envAllowlist: [...STDIO_IMPLICIT_ENV_VARS] as string[],
        shutdownWaitMs: 1000,
      },
      bindings: [{ upstreamTool: TOOL, canonicalSchemaHash: realHash }],
    });
    const connector = new McpConnector(
      config,
      [readDefinition(TOOL, realHash)],
      () => {
        dials += 1;
        return dials === 1
          ? hanging.clientTransport
          : recovered.clientTransport;
      },
    );
    closables.push(() => connector.shutdown());

    expect(await connector.ensureConnected()).toEqual({ ok: true });

    const controller = new AbortController();
    const first = connector.callTool(TOOL, { q: "first" }, controller.signal);
    // Explicit event-driven wait: the handler is entered and holds the mutex.
    await hanging.entered;

    // Queued behind the per-instance mutex while the first call hangs.
    const second = connector.callTool(TOOL, { q: "second" });

    // A caller-supplied PRIVATE abort reason (name AbortError, synthetic
    // credential + private path) must never surface in the fixed result nor be
    // forwarded to the SDK cancellation notification. Forwarding the caller
    // signal directly would echo these bytes.
    const privateReason = new Error(
      `upstream aborted ${SECRET} at ${PRIVATE_PATH}`,
    );
    privateReason.name = "AbortError";
    controller.abort(privateReason);

    const firstResult = await first;
    expect(firstResult).toEqual({ ok: false, code: "mcp_unavailable" });
    const firstSerialized = JSON.stringify(firstResult);
    expect(firstSerialized).not.toContain(SECRET);
    expect(firstSerialized).not.toContain(PRIVATE_PATH);
    expect(firstSerialized).not.toContain("AbortError");

    // The actual SDK cancellation notification crossed the wire, but with the
    // connector's fixed reason — no caller byte is echoed into any sent message.
    const cancelled = hanging.received.find(
      (m) => m.method === "notifications/cancelled",
    );
    expect(cancelled).toBeDefined();
    const reason = cancelled?.params?.reason;
    expect(typeof reason).toBe("string");
    expect(reason).toBe("cancelled");
    expect(String(reason)).not.toContain(SECRET);
    expect(String(reason)).not.toContain(PRIVATE_PATH);
    expect(String(reason)).not.toContain("AbortError");
    const wireSerialized = JSON.stringify(hanging.received);
    expect(wireSerialized).not.toContain(SECRET);
    expect(wireSerialized).not.toContain(PRIVATE_PATH);

    // The server handler's own SDK abort signal actually fired.
    const handlerAbortReason = await hanging.abortedWith;
    expect(handlerAbortReason).toBeDefined();
    expect(String(handlerAbortReason)).not.toContain(SECRET);
    expect(String(handlerAbortReason)).not.toContain(PRIVATE_PATH);

    // Release the gate: the queued call must settle (mutex was released),
    // reconnect on the fresh peer, and succeed.
    const secondResult = await second;
    expect(secondResult).toMatchObject({
      ok: true,
      text: "hits",
      structuredContent: { totalCount: 1 },
    });
    // Exactly one tools/call attempt per logical call: no automatic replay,
    // and the closed first peer was never reused.
    expect(hanging.handlerCalls()).toBe(1);
    expect(recovered.handlerCalls()).toBe(1);
    expect(dials).toBe(2);
  });
});
