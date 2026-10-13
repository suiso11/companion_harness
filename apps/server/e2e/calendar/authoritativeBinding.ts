// C15 dedicated Calendar fake E2E harness: the TOMBSTONE app's trusted
// fixture binding (App C, port 4185).
//
// App A (the default harness app) is the untouched C14 OWNED composition:
// the production adapter over the production MCP connector, whose
// normalizer NEVER synthesizes `deleted`. A bare upstream miss (404) stays
// `uncertain failed` there — exactly the C11 boundary the existing scenario
// asserts.
//
// App C exists ONLY to observe the POSITIVE authoritative tombstone that
// production deliberately refuses to invent (C11-01: no adopted provider
// tombstone contract). It reuses EXISTING seams only:
//   - the C12 `calendarBinding` injection seam of `startServer`
//     (verified stored-instance check, kind-dispatched `reference.refresh`,
//     durable private target store, real broker/agent/UI), and
//   - its OWN `McpConnector` lifecycle over the official inert SDK
//     `InMemoryTransport` against a scripted fake MCP server that advertises
//     one EXTRA trusted read binding, `get-event-authoritative`.
//
// The `deleted` normalized event is produced HERE, in HOST-TRUSTED fixture
// code, and ONLY when BOTH gates hold:
//   1. the fixture's dedicated authoritative synthetic get mode is armed
//      (loopback control seam), and
//   2. a SEPARATE, real SDK wire `tools/call` of `get-event-authoritative`
//      comes back ok AND the REAL production normalizer
//      (`normalizeGetResult`) decoded it with the exact host-trusted
//      synthetic revision and a `cancelled` status.
//
// Nothing in `packages/connector-calendar`, `packages/connector-mcp` or
// `packages/kernel` changes: no schema loosening, no new error code, no
// local delete inference, no DB seeding of snapshots, no manual
// ReferenceManager presentation, no UI bypass.

import type {
  CalendarConnectorPort,
  CalendarSearchCallOptions,
} from "@companion/kernel";
import {
  type McpBindingDefinition,
  type McpConnectorConfig,
  McpConnector,
  type TransportFactory,
} from "@companion/connector-mcp";
import { InMemoryTransport } from "@companion/connector-mcp";
import {
  type CalendarCallOptions,
  type CalendarGetResult,
  type CalendarGetTarget,
  createCalendarConnector,
  type CalendarSearchResult,
  normalizeGetResult,
} from "@companion/connector-calendar";
import {
  createFakeCalendarMcpServer,
  type FakeCalendarState,
} from "./mcpFake.js";
import {
  AUTHORITATIVE_DELETED_REVISION,
  AUTHORITATIVE_GET_TOOL,
  FAKE_MCP_SERVER_NAME,
  FAKE_MCP_SERVER_VERSION,
} from "./ports.js";

export interface AuthoritativeBindingOptions {
  readonly connectorInstanceId: string;
  readonly calendarId: string;
  readonly state: FakeCalendarState;
  /** Canonical schema hashes of the scripted fake tool schemas. */
  readonly searchHash: string;
  readonly listHash: string;
  readonly getHash: string;
}

export interface AuthoritativeBinding {
  readonly connectorInstanceId: string;
  readonly connector: CalendarConnectorPort;
  /** Fixture-owned MCP lifecycle (never the server's). */
  shutdown(): Promise<void>;
}

/**
 * Build the trusted fixture binding: the REAL production Calendar adapter
 * over a REAL `McpConnector` (own inert transport, own fake MCP server),
 * wrapped by the explicit authoritative synthetic get gate.
 */
export function createAuthoritativeCalendarBinding(
  options: AuthoritativeBindingOptions,
): AuthoritativeBinding {
  const definitions: readonly McpBindingDefinition[] = [
    { upstreamTool: "search-events", canonicalSchemaHash: options.searchHash, category: "read" },
    { upstreamTool: "list-events", canonicalSchemaHash: options.listHash, category: "read" },
    { upstreamTool: "get-event", canonicalSchemaHash: options.getHash, category: "read" },
    {
      upstreamTool: AUTHORITATIVE_GET_TOOL,
      canonicalSchemaHash: options.getHash,
      category: "read",
    },
  ];

  const transportFactory: TransportFactory = () => {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    void createFakeCalendarMcpServer(options.state, {
      authoritativeTool: true,
    }).connect(serverTransport);
    return clientTransport;
  };

  const connectorConfig = Object.freeze({
    serverId: FAKE_MCP_SERVER_NAME,
    kind: "mcp",
    expectedServerName: FAKE_MCP_SERVER_NAME,
    version: FAKE_MCP_SERVER_VERSION,
    clientName: "companion-harness",
    clientVersion: "0.0.0",
    transport: { kind: "streamable-http", host: "127.0.0.1", port: 9439 },
    bindings: definitions.map((definition) => ({
      upstreamTool: definition.upstreamTool,
      canonicalSchemaHash: definition.canonicalSchemaHash,
    })),
    connectorInstanceId: options.connectorInstanceId,
  }) as McpConnectorConfig;

  // Constructor does no I/O: an unavailable upstream can never block startup.
  const mcp = new McpConnector(connectorConfig, definitions, transportFactory);
  const adapter = createCalendarConnector({
    connectorInstanceId: options.connectorInstanceId,
    connector: mcp,
    selection: { calendarId: options.calendarId },
  });

  return {
    connectorInstanceId: options.connectorInstanceId,
    connector: {
      connectorInstanceId: options.connectorInstanceId,
      search: async (
        input: unknown,
        callOptions: CalendarSearchCallOptions,
      ): Promise<CalendarSearchResult> => {
        return adapter.search(input, callOptions);
      },
      get: (
        target: CalendarGetTarget,
        callOptions?: CalendarCallOptions,
      ): Promise<CalendarGetResult> =>
        authoritativeGet(adapter, mcp, options, target, callOptions),
    },
    shutdown: async () => {
      await mcp.shutdown();
    },
  };
}

/**
 * The EXPLICIT gate. Ordinary reads (and the bare-404 / uncertain case)
 * always go through the REAL production adapter `get` untouched. Only an
 * armed authoritative mode performs the SEPARATE real wire operation, and
 * only a positively decoded authoritative record can become `deleted`;
 * anything else degrades to the ordinary adapter read (never a guess).
 */
async function authoritativeGet(
  adapter: {
    get(
      target: CalendarGetTarget,
      options?: CalendarCallOptions,
    ): Promise<CalendarGetResult>;
  },
  mcp: McpConnector,
  options: AuthoritativeBindingOptions,
  target: CalendarGetTarget,
  callOptions?: CalendarCallOptions,
): Promise<CalendarGetResult> {
  if (options.state.authoritativeDeleted !== true) {
    return adapter.get(target, callOptions);
  }
  const result = await mcp.callTool(
    AUTHORITATIVE_GET_TOOL,
    {
      eventId: target.eventId,
      calendarId: target.calendarId,
      ...(target.account === undefined ? {} : { account: target.account }),
    },
    callOptions?.signal,
  );
  // Decode through the REAL production normalizer (unchanged, strict).
  const decoded = await normalizeGetResult(result, {
    connectorInstanceId: options.connectorInstanceId,
    calendarId: target.calendarId,
  });
  if (!decoded.ok) return decoded;
  const event = decoded.event;
  if (
    event.sourceRevision !== AUTHORITATIVE_DELETED_REVISION ||
    event.revisionBasis !== "etag" ||
    event.status !== "cancelled"
  ) {
    // Positive wire call, but NOT the host-trusted deleted evidence: stay
    // uncertain rather than inventing a tombstone.
    return adapter.get(target, callOptions);
  }
  return {
    ok: true,
    event: {
      ...event,
      // Host-trusted fixture synthesis ONLY (the one place a `deleted`
      // status is produced in this repository, and it is test-only).
      status: "deleted",
    },
  };
}