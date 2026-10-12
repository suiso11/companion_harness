/**
 * C09-07 trusted read-only policy boundary (real SDK `Client` + `McpServer`
 * over `InMemoryTransport`).
 *
 * Authorization is decided EXCLUSIVELY by the reviewed host
 * `McpBindingDefinition[]` snapshot taken at construction. Neither the
 * configured allowlist alone, the wire `tools/list` identity, the tool NAME,
 * MCP annotations (`readOnlyHint`), nor caller-supplied args (`category`)
 * can upgrade a binding to callable: only an explicitly trusted, non-ambiguous
 * `read` definition whose hash links to the configured binding is ever enabled.
 *
 * The provider-shaped upstream here advertises a `search-events` tool whose
 * name, wire identity and input-schema hash all exactly match the configured
 * binding — the classic "looks read-only" trap — to prove the policy, not the
 * upstream's self-description, is the authority.
 */
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
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

const SEARCH_SCHEMA = { q: z.string(), maxResults: z.number().optional() };
const GET_EVENT_SCHEMA = { id: z.string() };
const STATUS_SCHEMA = { eventId: z.string() };

interface ToolSpec {
  name: string;
  inputSchema: Record<string, z.ZodType>;
  annotations?: ToolAnnotations;
}

const closables: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  const pending = closables.splice(0);
  for (const close of pending) {
    await close().catch(() => undefined);
  }
});

function policyConfig(
  bindings: Array<{ upstreamTool: string; canonicalSchemaHash: string }>,
): McpConnectorConfig {
  return mcpConnectorConfigSchema.parse({
    connectorInstanceId: "cal-policy",
    serverId: "logical-policy",
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

/** Learn the ACTUAL advertised input-schema hash per tool (deterministic). */
async function probeHashes(specs: ToolSpec[]): Promise<Map<string, string>> {
  const server = new McpServer({ name: "hash-probe", version: "0.0.0" });
  for (const spec of specs) {
    server.registerTool(
      spec.name,
      { description: "probe", inputSchema: spec.inputSchema },
      async () => ({ content: [{ type: "text" as const, text: "x" }] }),
    );
  }
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const probe = new Client(
    { name: "probe", version: "0.0.0" },
    { capabilities: {} },
  );
  await probe.connect(clientTransport);
  const listed = await probe.listTools();
  const hashes = new Map<string, string>();
  for (const tool of listed.tools) {
    hashes.set(tool.name, await canonicalSchemaHash(tool.inputSchema));
  }
  await probe.close().catch(() => undefined);
  await server.close().catch(() => undefined);
  return hashes;
}

/** Real McpServer linked over InMemoryTransport; counts provider-side calls. */
async function linkedServer(specs: ToolSpec[]) {
  let calls = 0;
  const server = new McpServer({ name: WIRE_NAME, version: WIRE_VERSION });
  for (const spec of specs) {
    server.registerTool(
      spec.name,
      {
        description: "fixture",
        inputSchema: spec.inputSchema,
        ...(spec.annotations !== undefined
          ? { annotations: spec.annotations }
          : {}),
      },
      async () => {
        calls += 1;
        return {
          content: [{ type: "text" as const, text: "hits" }],
          structuredContent: { totalCount: 1 },
        };
      },
    );
  }
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  closables.push(() => server.close());
  return {
    transport: clientTransport as unknown as Transport,
    calls: () => calls,
  };
}

describe("C09-07 trusted read-only policy boundary (real in-memory SDK)", () => {
  it("denies non-read or missing trusted definitions BEFORE any factory dial despite exact wire+hash+metadata", async () => {
    const specs: ToolSpec[] = [
      {
        name: "search-events",
        inputSchema: SEARCH_SCHEMA,
        // Upstream self-describes as read-only and the caller echoes a read
        // category: neither may authorize anything.
        annotations: { readOnlyHint: true },
      },
    ];
    const hashes = await probeHashes(specs);
    const searchHash = hashes.get("search-events") as string;
    const server = await linkedServer(specs);
    const binding = {
      upstreamTool: "search-events",
      canonicalSchemaHash: searchHash,
    };

    // One combined fixture covers all three blocked categories plus the
    // missing-definition case; each is the same fixed denial with no I/O.
    for (const category of ["write", "sensitive", "unclassified"] as const) {
      let factoryCalls = 0;
      const connector = new McpConnector(
        policyConfig([binding]),
        [
          {
            upstreamTool: "search-events",
            canonicalSchemaHash: searchHash,
            category,
          },
        ],
        () => {
          factoryCalls += 1;
          return server.transport;
        },
      );
      closables.push(() => connector.shutdown());
      expect(await connector.ensureConnected()).toEqual({
        ok: false,
        code: "mcp_binding_not_allowed",
      });
      expect(
        await connector.callTool("search-events", {
          q: "x",
          category: "read",
          readOnlyHint: true,
        }),
      ).toEqual({ ok: false, code: "mcp_binding_not_allowed" });
      expect(connector.isAllowed("search-events")).toBe(false);
      expect(connector.stats()).toEqual({
        connected: false,
        consecutiveFailures: 0,
        enabledBindings: [],
      });
      expect(factoryCalls).toBe(0);
    }

    let missingFactoryCalls = 0;
    const missing = new McpConnector(policyConfig([binding]), [], () => {
      missingFactoryCalls += 1;
      return server.transport;
    });
    closables.push(() => missing.shutdown());
    expect(await missing.ensureConnected()).toEqual({
      ok: false,
      code: "mcp_binding_not_allowed",
    });
    expect(missingFactoryCalls).toBe(0);
    expect(server.calls()).toBe(0);
  });

  it("allows an independently reviewed read op with a write-looking name and readOnlyHint:false", async () => {
    const specs: ToolSpec[] = [
      {
        name: "delete-event",
        inputSchema: GET_EVENT_SCHEMA,
        annotations: { readOnlyHint: false, destructiveHint: false },
      },
    ];
    const hashes = await probeHashes(specs);
    const hash = hashes.get("delete-event") as string;
    const server = await linkedServer(specs);
    const connector = new McpConnector(
      policyConfig([
        { upstreamTool: "delete-event", canonicalSchemaHash: hash },
      ]),
      // The reviewed host explicitly classifies this handler as a read op; the
      // connector must not infer from the write-looking name or the false hint.
      [
        {
          upstreamTool: "delete-event",
          canonicalSchemaHash: hash,
          category: "read",
        },
      ],
      () => server.transport,
    );
    closables.push(() => connector.shutdown());
    expect(await connector.ensureConnected()).toEqual({ ok: true });
    expect(connector.isAllowed("delete-event")).toBe(true);
    expect(connector.stats().enabledBindings).toEqual(["delete-event"]);
    expect(
      await connector.callTool("delete-event", { id: "r1" }),
    ).toMatchObject({ ok: true });
    expect(server.calls()).toBe(1);
  });

  it("fails closed with mcp_schema_mismatch and zero IO when the trusted hash does not link to the config", async () => {
    let factoryCalls = 0;
    const connector = new McpConnector(
      policyConfig([
        { upstreamTool: "search-events", canonicalSchemaHash: "a".repeat(64) },
      ]),
      [
        {
          upstreamTool: "search-events",
          canonicalSchemaHash: "b".repeat(64),
          category: "read",
        },
      ],
      () => {
        factoryCalls += 1;
        throw new Error("must not dial");
      },
    );
    closables.push(() => connector.shutdown());
    expect(await connector.ensureConnected()).toEqual({
      ok: false,
      code: "mcp_schema_mismatch",
    });
    expect(await connector.callTool("search-events", { q: "x" })).toEqual({
      ok: false,
      code: "mcp_schema_mismatch",
    });
    expect(factoryCalls).toBe(0);
    expect(connector.stats()).toEqual({
      connected: false,
      consecutiveFailures: 0,
      enabledBindings: [],
    });
  });

  it("enables only the policy-eligible subset; a non-read wire match is never advertised", async () => {
    const specs: ToolSpec[] = [
      { name: "search-events", inputSchema: SEARCH_SCHEMA },
      { name: "get-event", inputSchema: GET_EVENT_SCHEMA },
      { name: "set-status", inputSchema: STATUS_SCHEMA },
    ];
    const hashes = await probeHashes(specs);
    const searchHash = hashes.get("search-events") as string;
    const getHash = hashes.get("get-event") as string;
    const statusHash = hashes.get("set-status") as string;
    const server = await linkedServer(specs);
    const connector = new McpConnector(
      policyConfig([
        { upstreamTool: "search-events", canonicalSchemaHash: searchHash },
        { upstreamTool: "get-event", canonicalSchemaHash: getHash },
        { upstreamTool: "set-status", canonicalSchemaHash: statusHash },
      ]),
      [
        {
          upstreamTool: "search-events",
          canonicalSchemaHash: searchHash,
          category: "read",
        },
        // Reviewed read, but the trusted hash does NOT link to the config pin.
        {
          upstreamTool: "get-event",
          canonicalSchemaHash: "0".repeat(64),
          category: "read",
        },
        // Wire hash matches the config exactly, but the class is non-read.
        {
          upstreamTool: "set-status",
          canonicalSchemaHash: statusHash,
          category: "write",
        },
      ],
      () => server.transport,
    );
    closables.push(() => connector.shutdown());
    expect(await connector.ensureConnected()).toEqual({ ok: true });
    expect(connector.stats()).toEqual({
      connected: true,
      consecutiveFailures: 0,
      enabledBindings: ["search-events"],
    });
    expect(connector.isAllowed("search-events")).toBe(true);
    expect(connector.isAllowed("get-event")).toBe(false);
    expect(connector.isAllowed("set-status")).toBe(false);
    // No public ensure path can grant the non-read / unlinked bindings.
    expect(await connector.callTool("get-event", { id: "r1" })).toEqual({
      ok: false,
      code: "mcp_schema_mismatch",
    });
    expect(await connector.callTool("set-status", { eventId: "r1" })).toEqual({
      ok: false,
      code: "mcp_binding_not_allowed",
    });
    expect(server.calls()).toBe(0);
  });

  it("denies a duplicated conflicting trusted definition as ambiguous", async () => {
    let factoryCalls = 0;
    const connector = new McpConnector(
      policyConfig([
        { upstreamTool: "search-events", canonicalSchemaHash: "a".repeat(64) },
      ]),
      [
        {
          upstreamTool: "search-events",
          canonicalSchemaHash: "a".repeat(64),
          category: "read",
        },
        {
          upstreamTool: "search-events",
          canonicalSchemaHash: "a".repeat(64),
          category: "write",
        },
      ],
      () => {
        factoryCalls += 1;
        throw new Error("must not dial");
      },
    );
    closables.push(() => connector.shutdown());
    expect(await connector.ensureConnected()).toEqual({
      ok: false,
      code: "mcp_binding_not_allowed",
    });
    expect(await connector.callTool("search-events", { q: "x" })).toEqual({
      ok: false,
      code: "mcp_binding_not_allowed",
    });
    expect(factoryCalls).toBe(0);
    expect(connector.isAllowed("search-events")).toBe(false);
  });

  it("treats any repeated identifiable name as ambiguous even when the duplicate record is malformed, without poisoning unrelated reads", async () => {
    const specs: ToolSpec[] = [
      { name: "search-events", inputSchema: SEARCH_SCHEMA },
      { name: "list-events", inputSchema: GET_EVENT_SCHEMA },
    ];
    const hashes = await probeHashes(specs);
    const searchHash = hashes.get("search-events") as string;
    const listHash = hashes.get("list-events") as string;

    const readSearch: McpBindingDefinition = {
      upstreamTool: "search-events",
      canonicalSchemaHash: searchHash,
      category: "read",
    };
    const readList: McpBindingDefinition = {
      upstreamTool: "list-events",
      canonicalSchemaHash: listHash,
      category: "read",
    };
    // Runtime-boundary malformed duplicates (programmatic callers bypass the
    // TypeScript type): a repeated identifiable name must be ambiguous even
    // when the duplicate record is missing its hash or carries an undefined /
    // unrecognized category.
    const undefinedCategory = {
      upstreamTool: "search-events",
      canonicalSchemaHash: searchHash,
    } as unknown as McpBindingDefinition;
    const unknownCategory = {
      upstreamTool: "search-events",
      canonicalSchemaHash: searchHash,
      category: "bogus",
    } as unknown as McpBindingDefinition;
    const missingHash = {
      upstreamTool: "search-events",
      category: "read",
    } as unknown as McpBindingDefinition;

    const variants: Array<{
      label: string;
      definitions: McpBindingDefinition[];
    }> = [
      {
        label: "valid-then-undefined-category",
        definitions: [readSearch, undefinedCategory, readList],
      },
      {
        label: "undefined-category-then-valid",
        definitions: [undefinedCategory, readSearch, readList],
      },
      {
        label: "valid-then-unknown-category",
        definitions: [readSearch, unknownCategory, readList],
      },
      {
        label: "unknown-category-then-valid",
        definitions: [unknownCategory, readSearch, readList],
      },
      {
        label: "valid-then-missing-hash",
        definitions: [readSearch, missingHash, readList],
      },
      {
        label: "missing-hash-then-valid",
        definitions: [missingHash, readSearch, readList],
      },
    ];

    for (const variant of variants) {
      // Fresh real in-memory server per variant: the unrelated `list-events`
      // read keeps the provider connectable, proving the ambiguous duplicate
      // is denied per-binding rather than blanketing the whole provider.
      const server = await linkedServer(specs);
      let dials = 0;
      const connector = new McpConnector(
        policyConfig([
          {
            upstreamTool: "search-events",
            canonicalSchemaHash: searchHash,
          },
          { upstreamTool: "list-events", canonicalSchemaHash: listHash },
        ]),
        variant.definitions,
        () => {
          dials += 1;
          return server.transport;
        },
      );
      closables.push(() => connector.shutdown());
      expect(await connector.ensureConnected(), variant.label).toEqual({
        ok: true,
      });
      expect(dials, variant.label).toBe(1);
      // The repeated/malformed name is never enabled nor callable.
      expect(connector.isAllowed("search-events"), variant.label).toBe(false);
      expect(
        await connector.callTool("search-events", { q: "x" }),
        variant.label,
      ).toEqual({ ok: false, code: "mcp_binding_not_allowed" });
      // The unrelated reviewed read is unaffected and executes for real.
      expect(connector.isAllowed("list-events"), variant.label).toBe(true);
      expect(connector.stats().enabledBindings, variant.label).toEqual([
        "list-events",
      ]);
      expect(
        await connector.callTool("list-events", { id: "r1" }),
        variant.label,
      ).toMatchObject({ ok: true });
      expect(server.calls(), variant.label).toBe(1);
    }
  });

  it("snapshots the trusted policy: later object/array mutations cannot upgrade a class or grant a hash", async () => {
    const specs: ToolSpec[] = [
      { name: "search-events", inputSchema: SEARCH_SCHEMA },
    ];
    const hashes = await probeHashes(specs);
    const searchHash = hashes.get("search-events") as string;
    const server = await linkedServer(specs);
    const binding = {
      upstreamTool: "search-events",
      canonicalSchemaHash: searchHash,
    };

    // (a) write -> read upgrade via caller-held object + array push: ignored.
    const upgradeDefs: McpBindingDefinition[] = [
      {
        upstreamTool: "search-events",
        canonicalSchemaHash: searchHash,
        category: "write",
      },
    ];
    let factoryCalls = 0;
    const denied = new McpConnector(
      policyConfig([binding]),
      upgradeDefs,
      () => {
        factoryCalls += 1;
        return server.transport;
      },
    );
    closables.push(() => denied.shutdown());
    (upgradeDefs[0] as unknown as { category: string }).category = "read";
    upgradeDefs.push({
      upstreamTool: "search-events",
      canonicalSchemaHash: searchHash,
      category: "read",
    });
    expect(await denied.ensureConnected()).toEqual({
      ok: false,
      code: "mcp_binding_not_allowed",
    });
    expect(factoryCalls).toBe(0);

    // (b) mutating the granted hash / emptying the array cannot revoke or
    // re-grant: the construction-time snapshot still authorizes exactly.
    const hashDefs: McpBindingDefinition[] = [
      {
        upstreamTool: "search-events",
        canonicalSchemaHash: searchHash,
        category: "read",
      },
    ];
    const allowed = new McpConnector(
      policyConfig([binding]),
      hashDefs,
      () => server.transport,
    );
    closables.push(() => allowed.shutdown());
    const mutableHashDef = hashDefs[0] as unknown as {
      canonicalSchemaHash: string;
    };
    mutableHashDef.canonicalSchemaHash = "f".repeat(64);
    hashDefs.length = 0;
    expect(await allowed.ensureConnected()).toEqual({ ok: true });
    expect(allowed.isAllowed("search-events")).toBe(true);
  });
});
