/**
 * C09-07 real-SDK RPC boundary regressions.
 *
 * These exercise the GENUINE SDK serialization/validation boundary using the
 * actual lower-level `Server` with the public `CallToolRequestSchema` /
 * `ListToolsRequestSchema` handlers over `InMemoryTransport`. No `Client`
 * method is patched, no fake Promise is substituted, and no real network,
 * spawn, OAuth or upstream code is involved.
 *
 * Covered failure boundaries (all redacted to the fixed `mcp_unavailable`):
 * - a malicious JSON-RPC protocol error whose `message`/`data` carry synthetic
 *   credential + private-path bytes;
 * - a well-formed JSON-RPC RESULT whose `isError` is NON-boolean, sent by the
 *   peer DIRECTLY over the public `InMemoryTransport.send` so it genuinely
 *   crosses the wire as a RESULT (never a JSON-RPC error) and fails the client
 *   `CallToolResultSchema` parse.
 *
 * The low-level SDK `Server` validates a `tools/call` handler result against
 * `CallToolResultSchema` BEFORE sending it, so a handler-returned malformed
 * result would be converted into a raw JSON-RPC error and never reach the
 * client as the malformed result this boundary must cover. The result test
 * therefore wraps the public server-side transport `onmessage` AFTER connect
 * and answers ONLY `tools/call` with a raw result, delegating every other
 * method to the SDK `Server`. A client-side tap on the public transport
 * `onmessage` (captured/chained by the owned connection BEFORE the SDK
 * Protocol handler) proves the malformed bytes crossed as a RESULT.
 *
 * The distinct tool-level path (an `McpServer` handler that THROWS becomes an
 * `isError` result -> `calendar_upstream_error`) is covered by the existing
 * demand-lifecycle fixture; here only the raw-RPC boundary is added.
 */
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
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

/** Synthetic private markers: neither may ever appear in a fixed result. */
const SECRET = "sk-inert-rpc-boundary-do-not-leak";
const PRIVATE_PATH = "/etc/private-rpc-boundary-do-not-leak";

/** Structural view of a raw JSON-RPC wire message (no SDK narrowing needed). */
interface WireMessage {
  jsonrpc?: unknown;
  id?: string | number;
  method?: unknown;
  params?: unknown;
  result?: Record<string, unknown>;
  error?: unknown;
}

let realHash = "";

const closables: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  const pending = closables.splice(0);
  for (const close of pending) {
    await close().catch(() => undefined);
  }
});

beforeAll(async () => {
  realHash = await canonicalSchemaHash(INPUT_SCHEMA);
});

function rawRpcConfig(): McpConnectorConfig {
  return mcpConnectorConfigSchema.parse({
    connectorInstanceId: "cal-rpc",
    serverId: "logical-rpc",
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
}

/**
 * Low-level SDK `Server` linked over `InMemoryTransport`. It advertises the
 * exact configured tool so binding verification passes; `onCall` supplies the
 * raw `tools/call` handler result (or throws), letting the REAL SDK boundary
 * produce the response the client will validate.
 */
async function linkedLowLevelServer(onCall: (request: unknown) => unknown) {
  let calls = 0;
  const server = new Server(
    { name: WIRE_NAME, version: WIRE_VERSION },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, (async () => ({
    tools: [{ name: TOOL, inputSchema: INPUT_SCHEMA }],
  })) as never);
  server.setRequestHandler(CallToolRequestSchema, ((request: unknown) => {
    calls += 1;
    return onCall(request);
  }) as never);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  closables.push(() => server.close());
  return {
    transport: clientTransport as unknown as Transport,
    calls: () => calls,
  };
}

/**
 * Low-level SDK `Server` for NORMAL initialize / tools/list, but `tools/call`
 * is answered by a raw JSON-RPC RESULT pushed straight through the public
 * `InMemoryTransport.send`. This deliberately bypasses the SDK `Server`'s
 * `CallToolResultSchema` result validation, so the malformed result reaches the
 * client as a RESULT (not a JSON-RPC error) and exercises the client parse.
 *
 * The server transport's public `onmessage` is wrapped AFTER connect, preserving
 * the SDK Protocol callback: only `tools/call` is intercepted; initialize,
 * tools/list and notifications delegate unchanged. No Client method is patched.
 *
 * A tap on the CLIENT transport's public `onmessage` is installed BEFORE the
 * connector constructs its owned connection, so the owned wrapper chains it
 * ahead of the SDK Protocol handler and it observes exactly what crossed the
 * wire, before delegation.
 */
async function linkedRawResultServer(badResult: Record<string, unknown>) {
  const server = new Server(
    { name: WIRE_NAME, version: WIRE_VERSION },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, (async () => ({
    tools: [{ name: TOOL, inputSchema: INPUT_SCHEMA }],
  })) as never);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const received: WireMessage[] = [];
  let rawSends = 0;
  const delegate = serverTransport.onmessage;
  serverTransport.onmessage = ((message: WireMessage, extra?: unknown) => {
    if (
      message.jsonrpc === "2.0" &&
      message.method === "tools/call" &&
      message.id !== undefined
    ) {
      rawSends += 1;
      // PUBLIC peer send: a genuine JSON-RPC RESULT on the wire, past the SDK
      // Server's CallToolResultSchema wrapper.
      void serverTransport.send({
        jsonrpc: "2.0",
        id: message.id,
        result: badResult,
      } as never);
      return;
    }
    delegate?.(message as never, extra as never);
  }) as NonNullable<typeof serverTransport.onmessage>;

  clientTransport.onmessage = ((message: WireMessage, extra?: unknown) => {
    received.push(message);
    void extra;
  }) as NonNullable<typeof clientTransport.onmessage>;

  closables.push(() => server.close());
  return {
    transport: clientTransport as unknown as Transport,
    received,
    rawSends: () => rawSends,
  };
}

function connectorFor(transport: Transport): McpConnector {
  const connector = new McpConnector(
    rawRpcConfig(),
    // SOURCE-REVIEWED host fixture definition: the advertised `search-events`
    // handler is a static read operation, so the trusted definition marks it
    // explicitly `read` with the explicitly written hash — never inferred from
    // the connector config or from any wire metadata.
    [{ upstreamTool: TOOL, canonicalSchemaHash: realHash, category: "read" }],
    () => transport,
  );
  closables.push(() => connector.shutdown());
  return connector;
}

describe("C09-07 raw JSON-RPC boundary redaction (real SDK Server)", () => {
  it("redacts a malicious JSON-RPC error message+data to fixed mcp_unavailable", async () => {
    const linked = await linkedLowLevelServer(() => {
      throw new McpError(ErrorCode.InternalError, `upstream failed ${SECRET}`, {
        secret: SECRET,
        privatePath: PRIVATE_PATH,
      });
    });
    const connector = connectorFor(linked.transport);
    expect(await connector.ensureConnected()).toEqual({ ok: true });

    const res = await connector.callTool(TOOL, { q: "x" });
    expect(res).toEqual({ ok: false, code: "mcp_unavailable" });
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(PRIVATE_PATH);
    // The raw RPC error DID reach the real boundary exactly once.
    expect(linked.calls()).toBe(1);
  });

  it("redacts a malformed non-boolean isError RESULT that crossed the wire to fixed mcp_unavailable", async () => {
    const badResult = {
      content: [{ type: "text", text: `leaked ${SECRET}` }],
      isError: "yes",
      rawSecret: SECRET,
      rawPrivatePath: PRIVATE_PATH,
    };
    const linked = await linkedRawResultServer(badResult);
    const connector = connectorFor(linked.transport);
    expect(await connector.ensureConnected()).toEqual({ ok: true });

    const res = await connector.callTool(TOOL, { q: "x" });
    expect(res).toEqual({ ok: false, code: "mcp_unavailable" });

    // The malformed payload crossed the REAL transport as a JSON-RPC RESULT,
    // not a JSON-RPC error: the client-side wire tap observed it with its id,
    // non-boolean isError and raw private field intact, before any parsing.
    expect(linked.rawSends()).toBe(1);
    const callResult = linked.received.find(
      (m) => m.result !== undefined && m.result.isError === "yes",
    );
    expect(callResult).toBeDefined();
    expect(callResult?.id).toBeDefined();
    expect(callResult?.error).toBeUndefined();
    expect(callResult?.result?.rawSecret).toBe(SECRET);
    expect(callResult?.result?.rawPrivatePath).toBe(PRIVATE_PATH);
    // No boundary result was a JSON-RPC error for tools/call.
    expect(linked.received.some((m) => m.error !== undefined)).toBe(false);

    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(PRIVATE_PATH);
    expect(serialized).not.toContain("leaked");
  });
});
