/**
 * Abort-cancellation regression (PR #10 review thread r3965812073).
 * McpConnector.callTool accepts an optional AbortSignal and forwards it via
 * the SDK-native per-request option (`Client.callTool(params, resultSchema?,
 * options?: RequestOptions)`, verified @modelcontextprotocol/sdk 1.30.0
 * official source/types — no Promise.race, no speculative API).
 *
 * Fake in-memory JSON-RPC transport (no network, no spawn): answers
 * initialize + tools/list, hangs tools/call while `hangToolCall` is set.
 * Proves: abort settles a hanging call promptly with the existing fixed
 * `mcp_unavailable` (no raw abort leak, exactly one attempt so no retry),
 * and a mutex-queued call still proceeds afterwards (mutex released).
 */
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { McpConnector, STDIO_IMPLICIT_ENV_VARS } from "../src/client.js";
import type { McpConnectorConfig } from "../src/config.js";
import {
  canonicalSchemaHash,
  mcpConnectorConfigSchema,
} from "../src/config.js";

const INPUT_SCHEMA = {
  type: "object",
  properties: { q: { type: "string" } },
  required: ["q"],
};

interface FakeState {
  hangToolCall: boolean;
  toolCallCount: number;
}

type JsonRpcId = string | number;

interface JsonRpcEnvelope {
  jsonrpc?: unknown;
  id?: JsonRpcId;
  method?: unknown;
}

/** Minimal fake Transport speaking just enough JSON-RPC for the SDK Client. */
class HangingFakeTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: unknown) => void;

  constructor(private readonly state: FakeState) {}

  async start(): Promise<void> {}

  async close(): Promise<void> {
    this.onclose?.();
  }

  async send(message: unknown): Promise<void> {
    const msg = message as JsonRpcEnvelope;
    // Notifications (initialized/cancelled): acknowledge, no reply.
    if (msg?.jsonrpc !== "2.0" || msg.id === undefined) return;
    if (msg.method === "initialize") {
      this.reply(msg.id, {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "fake-calendar", version: "0.0.0" },
      });
      return;
    }
    if (msg.method === "tools/list") {
      this.reply(msg.id, {
        tools: [
          {
            name: "search-events",
            description: "fake readonly search",
            inputSchema: INPUT_SCHEMA,
          },
        ],
      });
      return;
    }
    if (msg.method === "tools/call") {
      this.state.toolCallCount += 1;
      if (this.state.hangToolCall) {
        // Hang forever: only the SDK-native abort rejects client-side.
        return new Promise<void>(() => {});
      }
      this.reply(msg.id, {
        content: [{ type: "text", text: "hits" }],
        structuredContent: { totalCount: 1 },
      });
      return;
    }
    this.replyError(msg.id, -32601, "Method not found");
  }

  private reply(id: JsonRpcId, result: unknown): void {
    (this.onmessage as ((m: unknown) => void) | undefined)?.({
      jsonrpc: "2.0",
      id,
      result,
    });
  }

  private replyError(id: JsonRpcId, code: number, message: string): void {
    (this.onmessage as ((m: unknown) => void) | undefined)?.({
      jsonrpc: "2.0",
      id,
      error: { code, message },
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const closables: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  const pending = closables.splice(0);
  for (const close of pending) {
    await close().catch(() => undefined);
  }
});

async function abortableConnector(state: FakeState): Promise<McpConnector> {
  const hash = await canonicalSchemaHash(INPUT_SCHEMA);
  const config: McpConnectorConfig = mcpConnectorConfigSchema.parse({
    connectorInstanceId: "cal-1",
    serverId: "fake",
    kind: "mcp" as const,
    version: "0.0.0-proposed.1",
    transport: {
      kind: "stdio" as const,
      command: "unused-injected",
      args: [] as string[],
      envAllowlist: [...STDIO_IMPLICIT_ENV_VARS] as string[],
      shutdownWaitMs: 3000,
    },
    bindings: [{ upstreamTool: "search-events", canonicalSchemaHash: hash }],
  });
  const connector = new McpConnector(
    config,
    (() => new HangingFakeTransport(state)) as never,
  );
  closables.push(() => connector.shutdown());
  return connector;
}

describe("McpConnector callTool abort propagation (fake transport)", () => {
  it("aborting a hanging call returns fixed mcp_unavailable and frees the mutex", async () => {
    const state: FakeState = { hangToolCall: true, toolCallCount: 0 };
    const connector = await abortableConnector(state);
    const ensured = await connector.ensureConnected();
    expect(ensured).toEqual({ ok: true });

    const controller = new AbortController();
    const hanging = connector.callTool(
      "search-events",
      { q: "first" },
      controller.signal,
    );
    // Let the first call acquire the mutex and reach the hanging send.
    await sleep(25);
    // Queued behind the per-instance mutex while the first call hangs.
    const queued = connector.callTool("search-events", { q: "second" });
    await sleep(25);

    controller.abort();
    const abortAt = Date.now();
    const first = await hanging;
    expect(Date.now() - abortAt).toBeLessThan(2000);
    expect(first).toEqual({ ok: false, code: "mcp_unavailable" });
    expect(JSON.stringify(first)).not.toMatch(/abort/i);

    // Release the gate: the queued call must settle (mutex was released),
    // reconnect, and succeed — proving no permanent mutex block.
    state.hangToolCall = false;
    const second = await queued;
    expect(second).toMatchObject({
      ok: true,
      structuredContent: { totalCount: 1 },
    });
    // Exactly one tools/call attempt per logical call: no automatic retry.
    expect(state.toolCallCount).toBe(2);
    await connector.shutdown();
  });
});
