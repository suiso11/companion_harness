/**
 * Real-SDK protocol spike (§17.2): official @modelcontextprotocol/sdk@1.30.0
 * Client against a deterministic in-process fake MCP server
 * (InMemoryTransport, no network, no OAuth, no upstream code).
 *
 * Proves initialize → tools/list → tools/call with structuredContent through
 * the actual SDK. This does NOT prove compatibility with the unmodified
 * nspady upstream (adoption gate remains; see binding.ts in
 * @companion/connector-calendar).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

let closables: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  const pending = closables;
  closables = [];
  for (const close of pending) {
    await close().catch(() => undefined);
  }
});

async function fakePair() {
  let searchCalls = 0;
  const server = new McpServer({
    name: "fake-calendar",
    version: "0.0.0-proposed.1",
  });
  server.registerTool(
    "search-events",
    {
      description: "fake readonly search (proposed fork shape)",
      inputSchema: { q: z.string(), maxResults: z.number().optional() },
      outputSchema: { totalCount: z.number() },
    },
    async ({ q }) => {
      searchCalls += 1;
      return {
        content: [{ type: "text" as const, text: `hits for ${q}` }],
        structuredContent: { totalCount: 1 },
      };
    },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(
    { name: "companion-harness", version: "0.0.0" },
    { capabilities: {} },
  );
  await client.connect(clientTransport);
  closables.push(
    () => client.close(),
    () => server.close(),
  );
  return { client, searchCalls: () => searchCalls };
}

describe("official SDK protocol (fake server, 1.30.0)", () => {
  it("initialize + tools/list exposes the fake tool with an input schema", async () => {
    const { client } = await fakePair();
    const listed = await client.listTools();
    const tool = listed.tools.find((t) => t.name === "search-events");
    expect(tool).toBeDefined();
    expect(tool?.inputSchema).toMatchObject({ type: "object" });
  });

  it("tools/call returns structuredContent first", async () => {
    const { client } = await fakePair();
    const res = (await client.callTool({
      name: "search-events",
      arguments: { q: "standup" },
    })) as { structuredContent?: unknown; content?: unknown };
    expect(res.structuredContent).toEqual({ totalCount: 1 });
  });

  it("tools/call for an unregistered tool resolves a denied error result, never a write", async () => {
    const { client, searchCalls } = await fakePair();
    const listed = await client.listTools();
    expect(listed.tools.some((t) => t.name === "delete-event")).toBe(false);
    const res = (await client.callTool({
      name: "delete-event",
      arguments: {},
    })) as {
      isError?: boolean;
      content?: Array<{ type: string; text?: string }>;
    };
    expect(res.isError).toBe(true);
    const text = Array.isArray(res.content)
      ? res.content
          .filter((c) => c.type === "text")
          .map((c) => c.text ?? "")
          .join(" ")
      : "";
    expect(text).toMatch(/delete-event/i);
    expect(text).toMatch(/unknown|not found|no such|missing/i);
    expect(searchCalls()).toBe(0);
  });
});
