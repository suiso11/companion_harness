/**
 * tools/list pagination test (official SDK 1.30.0, in-memory only).
 *
 * These exercise the GENUINE SDK serialization/validation boundary using the
 * actual lower-level `Server` with the public `ListToolsRequestSchema` /
 * `CallToolRequestSchema` handlers over `InMemoryTransport`. No `Client` method
 * is patched, no fake Promise is substituted, no mocked transport protocol is
 * hand-rolled, and no network/spawn/OAuth/upstream code is involved.
 *
 * Covered:
 *  - a configured binding advertised only on page 2 is enabled after the page
 *    1 cursor is carried, and the actually-advertised read handler executes;
 *  - a live tool name repeated across pages is denied in either order while an
 *    unrelated reviewed read stays enabled and callable;
 *  - an UNFINISHED catalog (the fixed 10-page budget is exhausted while the
 *    server still advertises a nextCursor) fails closed on the consumer
 *    boundary: no binding is enabled and the provider is never called;
 *  - a COMPLETE tenth page with no remaining cursor is accepted and callable.
 */

import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpConnector, STDIO_IMPLICIT_ENV_VARS } from "../src/client.js";
import type {
  McpBindingDefinition,
  McpConnectorConfig,
} from "../src/config.js";
import {
  canonicalSchemaHash,
  mcpConnectorConfigSchema,
} from "../src/config.js";

const WIRE_NAME = "fake-paged";
const WIRE_VERSION = "0.0.0";

// The duplicated / conflicting upstream tool name, and an unrelated reviewed
// read used as the partial-success control.
const N = "search-events";
const M = "list-events";

function readDefinition(
  upstreamTool: string,
  schemaHash: string,
): McpBindingDefinition {
  return { upstreamTool, canonicalSchemaHash: schemaHash, category: "read" };
}

interface PageSpec {
  tools: Array<{ name: string; inputSchema: unknown }>;
  nextCursor?: string;
}

interface LinkedFixture {
  transport: Transport;
  /** Provider-side `tools/call` names, in order. */
  providerCalls: string[];
  /** Every `tools/list` cursor received, in order (first is undefined). */
  listCursors: Array<string | undefined>;
}

interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

/** Minimal observable gate used for the deterministic digest race. */
function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const closables: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  // Reverse order: shut the connector down before the server so the owned
  // client close is the intentional one.
  const pending = closables.splice(0).reverse();
  for (const close of pending) {
    await close().catch(() => undefined);
  }
  // The digest-race test installs a global WebCrypto spy; never leak it into
  // sibling tests even if its own finally did not run.
  vi.restoreAllMocks();
});

/**
 * Real lower-level SDK `Server` linked over `InMemoryTransport`. Its
 * `ListToolsRequestSchema` handler follows the "pK" cursor chain (index K-1),
 * and its `CallToolRequestSchema` handler is a real inert read that records the
 * provider-side names called, so the trusted `read` definitions below describe
 * an actually-advertised read surface rather than a transport with no call
 * handler.
 */
async function linkedServer(pages: PageSpec[]): Promise<LinkedFixture> {
  const providerCalls: string[] = [];
  const listCursors: Array<string | undefined> = [];
  const server = new Server(
    { name: WIRE_NAME, version: WIRE_VERSION },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, (async (request: {
    params?: { cursor?: string };
  }) => {
    const cursor = request.params?.cursor;
    listCursors.push(cursor);
    const index =
      cursor === undefined ? 0 : Number.parseInt(cursor.slice(1), 10) - 1;
    const page =
      Number.isInteger(index) && index >= 0 ? pages[index] : undefined;
    return {
      tools: page?.tools ?? [],
      ...(page?.nextCursor !== undefined
        ? { nextCursor: page.nextCursor }
        : {}),
    };
  }) as never);
  server.setRequestHandler(CallToolRequestSchema, ((request: {
    params: { name: string };
  }) => {
    providerCalls.push(request.params.name);
    return {
      content: [
        { type: "text" as const, text: `called ${request.params.name}` },
      ],
      structuredContent: { ok: true },
    };
  }) as never);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  closables.push(() => server.close());
  return {
    transport: clientTransport as unknown as Transport,
    providerCalls,
    listCursors,
  };
}

function pagedConfig(
  bindings: Array<{ upstreamTool: string; canonicalSchemaHash: string }>,
): McpConnectorConfig {
  return mcpConnectorConfigSchema.parse({
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
    bindings,
  });
}

function connectorFor(
  transport: Transport,
  bindings: Array<{ upstreamTool: string; canonicalSchemaHash: string }>,
  definitions: McpBindingDefinition[],
): McpConnector {
  const connector = new McpConnector(
    pagedConfig(bindings),
    definitions,
    () => transport,
  );
  closables.push(() => connector.shutdown());
  return connector;
}

describe("tools/list pagination during binding verification", () => {
  it("enables a configured binding found only on page 2 and sends page 1's cursor", async () => {
    const targetSchema = {
      type: "object",
      properties: { q: { type: "string" } },
      required: ["q"],
    };
    const targetHash = await canonicalSchemaHash(targetSchema);
    const linked = await linkedServer([
      {
        tools: [{ name: "decoy-tool", inputSchema: { type: "object" } }],
        nextCursor: "p2",
      },
      { tools: [{ name: "page-two-tool", inputSchema: targetSchema }] },
    ]);
    const connector = connectorFor(
      linked.transport,
      [{ upstreamTool: "page-two-tool", canonicalSchemaHash: targetHash }],
      [readDefinition("page-two-tool", targetHash)],
    );
    expect(await connector.ensureConnected()).toEqual({ ok: true });
    expect(connector.isAllowed("page-two-tool")).toBe(true);
    expect(connector.stats().enabledBindings).toEqual(["page-two-tool"]);
    // Page 1's cursor is carried on the second request; paging terminates.
    expect(linked.listCursors).toEqual([undefined, "p2"]);
    // Discovered-but-unconfigured tools are never auto-exposed.
    expect(connector.isAllowed("decoy-tool")).toBe(false);
    // Consumer boundary: the real advertised read handler actually executes.
    expect(await connector.callTool("page-two-tool", { q: "x" })).toMatchObject(
      {
        ok: true,
      },
    );
    expect(linked.providerCalls).toEqual(["page-two-tool"]);
  });

  it("denies a live tool name repeated across pages in either order while unrelated reads stay enabled", async () => {
    // Two conflicting names, one per page ordering:
    //  - conflict-a: page 1 bad schema, page 2 approved schema (the order that
    //    a last-wins Map would wrongly enable);
    //  - conflict-b: page 1 approved schema, page 2 bad schema.
    // Both must fail closed in a single pass, and the once-seen `control-tool`
    // must remain enabled so the denial is per-binding, not a provider blanket.
    const approvedA = {
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
    };
    const badA = {
      type: "object",
      properties: { a: { type: "number" } },
      required: ["a"],
    };
    const approvedB = {
      type: "object",
      properties: { b: { type: "string" } },
      required: ["b"],
    };
    const badB = {
      type: "object",
      properties: { b: { type: "number" } },
      required: ["b"],
    };
    const control = {
      type: "object",
      properties: { c: { type: "string" } },
      required: ["c"],
    };
    const hashA = await canonicalSchemaHash(approvedA);
    const hashB = await canonicalSchemaHash(approvedB);
    const hashControl = await canonicalSchemaHash(control);

    const linked = await linkedServer([
      {
        tools: [
          { name: "conflict-a", inputSchema: badA },
          { name: "conflict-b", inputSchema: approvedB },
          { name: "control-tool", inputSchema: control },
        ],
        nextCursor: "p2",
      },
      {
        tools: [
          { name: "conflict-a", inputSchema: approvedA },
          { name: "conflict-b", inputSchema: badB },
        ],
      },
    ]);
    const connector = connectorFor(
      linked.transport,
      [
        { upstreamTool: "conflict-a", canonicalSchemaHash: hashA },
        { upstreamTool: "conflict-b", canonicalSchemaHash: hashB },
        { upstreamTool: "control-tool", canonicalSchemaHash: hashControl },
      ],
      [
        readDefinition("conflict-a", hashA),
        readDefinition("conflict-b", hashB),
        readDefinition("control-tool", hashControl),
      ],
    );
    expect(await connector.ensureConnected()).toEqual({ ok: true });
    // A repeated live name is never enabled, in either page order.
    expect(connector.isAllowed("conflict-a")).toBe(false);
    expect(connector.isAllowed("conflict-b")).toBe(false);
    // The unrelated, once-seen read survives and is actually callable.
    expect(connector.isAllowed("control-tool")).toBe(true);
    expect(connector.stats().enabledBindings).toEqual(["control-tool"]);
    expect(linked.listCursors).toEqual([undefined, "p2"]);
    expect(await connector.callTool("control-tool", { c: "1" })).toMatchObject({
      ok: true,
    });
    expect(linked.providerCalls).toEqual(["control-tool"]);
  });

  it("fails closed on the consumer boundary when the 10-page budget is exhausted with a remaining cursor", async () => {
    // Page 1 advertises the approved N and the unrelated M; cursors p2..p10
    // consume the whole fixed budget while a nextCursor remains, and page 11
    // (cursor p11, never requested) holds a conflicting N. The unfinished
    // catalog cannot attest live identity, so ALL bindings are denied.
    const approvedN = {
      type: "object",
      properties: { q: { type: "string" } },
      required: ["q"],
    };
    const badN = {
      type: "object",
      properties: { q: { type: "number" } },
      required: ["q"],
    };
    const mSchema = {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    };
    const nHash = await canonicalSchemaHash(approvedN);
    const mHash = await canonicalSchemaHash(mSchema);
    const pages: PageSpec[] = [];
    pages.push({
      tools: [
        { name: N, inputSchema: approvedN },
        { name: M, inputSchema: mSchema },
      ],
      nextCursor: "p2",
    });
    for (let index = 1; index <= 8; index += 1) {
      pages.push({ tools: [], nextCursor: `p${index + 2}` });
    }
    pages.push({ tools: [], nextCursor: "p11" });
    pages.push({ tools: [{ name: N, inputSchema: badN }] });

    const linked = await linkedServer(pages);
    const connector = connectorFor(
      linked.transport,
      [
        { upstreamTool: N, canonicalSchemaHash: nHash },
        { upstreamTool: M, canonicalSchemaHash: mHash },
      ],
      [readDefinition(N, nHash), readDefinition(M, mHash)],
    );

    expect(await connector.callTool(N, { q: "x" })).toEqual({
      ok: false,
      code: "mcp_schema_mismatch",
    });
    // Exactly the fixed budget was used; the conflicting page 11 was never
    // requested and the provider was never called.
    expect(linked.listCursors).toHaveLength(10);
    expect(linked.providerCalls).toEqual([]);
    expect(connector.isAllowed(N)).toBe(false);
    expect(connector.isAllowed(M)).toBe(false);
    expect(connector.stats().enabledBindings).toEqual([]);
    expect(connector.stats().connected).toBe(false);
    // A schema-validation failure is not a transport failure.
    expect(connector.stats().consecutiveFailures).toBe(0);
  });

  it("accepts a configured binding on the complete tenth page with no remaining cursor", async () => {
    const approvedN = {
      type: "object",
      properties: { q: { type: "string" } },
      required: ["q"],
    };
    const nHash = await canonicalSchemaHash(approvedN);
    const pages: PageSpec[] = [];
    pages.push({ tools: [], nextCursor: "p2" });
    for (let index = 1; index <= 8; index += 1) {
      pages.push({ tools: [], nextCursor: `p${index + 2}` });
    }
    pages.push({ tools: [{ name: N, inputSchema: approvedN }] });

    const linked = await linkedServer(pages);
    const connector = connectorFor(
      linked.transport,
      [{ upstreamTool: N, canonicalSchemaHash: nHash }],
      [readDefinition(N, nHash)],
    );

    // The budget boundary is only a hang ceiling: a normal tenth page with no
    // nextCursor is a COMPLETE catalog and must still be accepted.
    expect(await connector.callTool(N, { q: "x" })).toMatchObject({ ok: true });
    expect(linked.listCursors).toHaveLength(10);
    expect(linked.providerCalls).toEqual([N]);
    expect(connector.isAllowed(N)).toBe(true);
  });

  it("reports mcp_unavailable (not schema_mismatch) when an explicit shutdown interrupts the final-page hash of an unfinished catalog", async () => {
    // Real SDK pagination fixture: page 1 advertises approved N, pages 2..9 are
    // empty, and the 10th page holds the distinct approved M with a REMAINING
    // cursor (p11), so the catalog is UNFINISHED. The explicit shutdown lands
    // inside the async WebCrypto SHA-256 of M's schema, strictly after the
    // loop's per-page readiness check but before the catalog verdict -- the
    // window the previous ordering mishandled as mcp_schema_mismatch.
    const approvedN = {
      type: "object",
      properties: { q: { type: "string" } },
      required: ["q"],
    };
    const mSchema = {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    };
    const nHash = await canonicalSchemaHash(approvedN);
    const mHash = await canonicalSchemaHash(mSchema);

    const pages: PageSpec[] = [];
    pages.push({
      tools: [{ name: N, inputSchema: approvedN }],
      nextCursor: "p2",
    });
    for (let index = 1; index <= 8; index += 1) {
      pages.push({ tools: [], nextCursor: `p${index + 2}` });
    }
    pages.push({
      tools: [{ name: M, inputSchema: mSchema }],
      nextCursor: "p11",
    });

    const linked = await linkedServer(pages);
    const connector = connectorFor(
      linked.transport,
      [
        { upstreamTool: N, canonicalSchemaHash: nHash },
        { upstreamTool: M, canonicalSchemaHash: mHash },
      ],
      [readDefinition(N, nHash), readDefinition(M, mHash)],
    );

    // Gate ONLY the final-page (M) digest; page 1's N digest still runs
    // normally through the SAME real native crypto. The approved hashes above
    // were computed before this spy is installed, so they never pass through it.
    const finalHashEntered = deferred<void>();
    const finalHashRelease = deferred<void>();
    const originalDigest = globalThis.crypto.subtle.digest;
    let digestCalls = 0;
    const digestSpy = vi
      .spyOn(globalThis.crypto.subtle, "digest")
      .mockImplementation(
        async (...args: Parameters<typeof originalDigest>) => {
          digestCalls += 1;
          if (digestCalls === 2) {
            finalHashEntered.resolve();
            await finalHashRelease.promise;
          }
          // Delegate to the ACTUAL native digest with the original bytes.
          return originalDigest.apply(globalThis.crypto.subtle, args);
        },
      );

    let shutdownPromise: Promise<void> | undefined;
    try {
      const firstCall = connector.callTool(N, { q: "x" });
      await finalHashEntered.promise;
      // Explicit shutdown while the final hash is in flight. Its own
      // boundedClose is the only await; no arbitrary sleep or retry.
      shutdownPromise = connector.shutdown();
      await shutdownPromise;
      finalHashRelease.resolve();
      // Shutdown precedence: an interrupted attempt is unavailable, NEVER a
      // schema verdict. The pre-fix catalog-completeness branch fails here.
      expect(await firstCall).toEqual({ ok: false, code: "mcp_unavailable" });
    } finally {
      finalHashRelease.resolve();
      await shutdownPromise?.catch(() => undefined);
      digestSpy.mockRestore();
    }

    expect(linked.providerCalls).toEqual([]);
    expect(linked.listCursors).toHaveLength(10);
    expect(connector.isAllowed(N)).toBe(false);
    expect(connector.isAllowed(M)).toBe(false);
    expect(connector.stats().connected).toBe(false);
    expect(connector.stats().enabledBindings).toEqual([]);
  });
});
