/**
 * tools/list pagination test (official SDK 1.30.0, in-memory only).
 * A minimal fake Transport answers initialize plus two tools/list pages, so
 * ensureConnected must follow nextCursor and enable a configured binding
 * that appears only on page 2. No network, no spawn, no timers.
 */
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { McpConnector, STDIO_IMPLICIT_ENV_VARS } from "../src/client.js";
import type { McpConnectorConfig } from "../src/config.js";
import {
  canonicalSchemaHash,
  mcpConnectorConfigSchema,
} from "../src/config.js";

const PAGE_TWO_CURSOR = "page-2";

interface PageSpec {
  tools: Array<{ name: string; inputSchema: unknown }>;
  nextCursor?: string;
}

/** Minimal in-memory MCP server: initialize plus cursor-paged tools/list. */
class PagedFakeTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  /** Every tools/list cursor received, in order (first is undefined). */
  readonly seenListCursors: Array<string | undefined> = [];

  constructor(private readonly pages: PageSpec[]) {}

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage): Promise<void> {
    const msg = message as {
      id?: string | number;
      method?: string;
      params?: { cursor?: string };
    };
    if (msg.id === undefined || msg.method === undefined) return;
    if (msg.method === "initialize") {
      this.reply(msg.id, {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "fake-paged", version: "0.0.0" },
      });
      return;
    }
    if (msg.method === "tools/list") {
      const cursor = msg.params?.cursor;
      this.seenListCursors.push(cursor);
      const page =
        cursor === undefined
          ? this.pages[0]
          : cursor === PAGE_TWO_CURSOR
            ? this.pages[1]
            : undefined;
      this.reply(msg.id, {
        tools: page?.tools ?? [],
        ...(page?.nextCursor !== undefined
          ? { nextCursor: page.nextCursor }
          : {}),
      });
    }
  }

  async close(): Promise<void> {
    this.onclose?.();
  }

  private reply(id: string | number, result: unknown): void {
    const to = this.onmessage;
    if (to === undefined) return;
    const response = { jsonrpc: "2.0", id, result } as JSONRPCMessage;
    queueMicrotask(() => {
      to(response);
    });
  }
}

function pagedConfig(targetHash: string): McpConnectorConfig {
  return mcpConnectorConfigSchema.parse({
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
    bindings: [
      { upstreamTool: "page-two-tool", canonicalSchemaHash: targetHash },
    ],
  });
}

describe("tools/list pagination during binding verification", () => {
  it("enables a configured binding found only on page 2 and sends page 1's cursor", async () => {
    const targetSchema = {
      type: "object",
      properties: { q: { type: "string" } },
      required: ["q"],
    };
    const targetHash = await canonicalSchemaHash(targetSchema);
    const transport = new PagedFakeTransport([
      {
        tools: [{ name: "decoy-tool", inputSchema: { type: "object" } }],
        nextCursor: PAGE_TWO_CURSOR,
      },
      { tools: [{ name: "page-two-tool", inputSchema: targetSchema }] },
    ]);
    const connector = new McpConnector(
      pagedConfig(targetHash),
      () => transport as Transport,
    );
    try {
      const ensured = await connector.ensureConnected();
      expect(ensured).toEqual({ ok: true });
      expect(connector.isAllowed("page-two-tool")).toBe(true);
      expect(connector.stats().enabledBindings).toEqual(["page-two-tool"]);
      // Page 1's cursor is carried on the second request; paging terminates.
      expect(transport.seenListCursors).toEqual([undefined, PAGE_TWO_CURSOR]);
      // Discovered-but-unconfigured tools are never auto-exposed.
      expect(connector.isAllowed("decoy-tool")).toBe(false);
    } finally {
      await connector.shutdown();
    }
  });
});
