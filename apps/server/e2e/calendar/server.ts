// C15 dedicated Calendar fake E2E harness (3/3): the server process.
//
// App A (CALENDAR_APP_PORT 4183) boots the REAL production server through
// `startServer` with the current C14 `StartServerOptions` seams ONLY
// (never any production rule change):
//   - env opt-in `COMPANION_CALENDAR_JSON` (selection + connector hint) and
//     `COMPANION_MODEL_JSON` (agent opt-in),
//   - trusted host `mcpDefinitions` (canonical hashes of the scripted fake
//     tool schemas),
//   - `mcpTransportFactory` wiring the connector to the scripted fake MCP
//     server over the OFFICIAL SDK `InMemoryTransport` (inert pair,
//     re-exported seam),
//   - `modelGateway` = the scripted fake model (real agent pipeline runs:
//     the real agent ideas/loop uses the real ToolBroker: calendar.search,
//     reference.open, reference.refresh).
// Everything else (Hono app, RunEngine, repository, migrations, UI,
// reference manager, durable target store) is the untouched production
// composition, and the Playwright spec drives the REAL UI over HTTP.
//
// A loopback-only control server (CALENDAR_CONTROL_PORT 4186, Node-side
// requests only, never page-fetch) mutates the fake upstream fixture state:
//   POST /advance-title  -> fake upstream revision 2 (etag/title change)
//   POST /delete-event   -> synthetic authoritative deletion (the upstream
//                           get/list/search then yield a bare isError miss;
//                           production code maps the fixed error, NO
//                           tombstone synthesis anywhere)
//   POST /reset          -> restore revision 1, clear deletion + counters
//   GET  /status         -> { deleted, revision, searchCalls, listCalls,
//                            getCalls } (each call went through the REAL
//                            connector wire pipeline)
//   GET  /health
//
// Temp DB dir is removed on shutdown (SIGINT/SIGTERM included). Fixes port
// constants live in e2e/calendar/ports.ts (isolated from the M3 harness).

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  McpBindingDefinition,
  TransportFactory,
} from "@companion/connector-mcp";
import { InMemoryTransport } from "@companion/connector-mcp";
import type { ModelGateway } from "@companion/model-local";
import { startServer } from "../../src/index.js";
import {
  createFakeCalendarMcpServer,
  createFakeCalendarState,
  fakeToolSchemaHashes,
  resetFakeCalendarState,
} from "./mcpFake.js";
import { createScriptedCalendarModelGateway } from "./model.js";
import {
  CALENDAR_APP_PORT,
  CALENDAR_CONTROL_ORIGIN,
  CALENDAR_CONTROL_PORT,
  CALENDAR_ID,
  FAKE_MCP_SERVER_NAME,
  FAKE_MCP_SERVER_VERSION,
} from "./ports.js";

const dir = mkdtempSync(join(tmpdir(), "companion-calendar-e2e-"));
const dbPath = join(dir, "companion-calendar.sqlite");

const hashes = await fakeToolSchemaHashes();
const state = createFakeCalendarState();

// Trusted host code: read-only definitions for the three fake tools, linked
// to the config hint hashes (canonicalSchemaHash) AND the live tools/list
// schemas on the inert transport. Never env-provided.
const mcpDefinitions: readonly McpBindingDefinition[] = [
  {
    upstreamTool: "search-events",
    canonicalSchemaHash: hashes.search,
    category: "read",
  },
  {
    upstreamTool: "list-events",
    canonicalSchemaHash: hashes.list,
    category: "read",
  },
  {
    upstreamTool: "get-event",
    canonicalSchemaHash: hashes.get,
    category: "read",
  },
];

// The C14 transport factory seam: each connect gets a FRESH inert pair;
// the client end goes into the real connector, the server end into a fresh
// scripted fake MCP server sharing the fixture state. No network/spawn.
const mcpTransportFactory: TransportFactory = () => {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  void createFakeCalendarMcpServer(state).connect(serverTransport);
  return clientTransport;
};

const modelGateway: ModelGateway = createScriptedCalendarModelGateway();

const env: NodeJS.ProcessEnv = {
  COMPANION_DB_PATH: dbPath,
  COMPANION_HOST: "127.0.0.1",
  COMPANION_PORT: String(CALENDAR_APP_PORT),
  COMPANION_TIME_ZONE: "UTC",
  COMPANION_LOG_LEVEL: "error",
  COMPANION_MODEL_JSON: JSON.stringify({
    adapter: "ollama",
    baseUrl: "http://127.0.0.1:1",
    model: "e2e-fake-calendar-model",
  }),
  COMPANION_CALENDAR_JSON: JSON.stringify({
    selection: { calendarId: CALENDAR_ID },
    connector: {
      serverId: FAKE_MCP_SERVER_NAME,
      kind: "mcp",
      expectedServerName: FAKE_MCP_SERVER_NAME,
      version: FAKE_MCP_SERVER_VERSION,
      transport: {
        kind: "streamable-http",
        host: "127.0.0.1",
        port: 9439,
      },
      bindings: [
        { upstreamTool: "search-events", canonicalSchemaHash: hashes.search },
        { upstreamTool: "list-events", canonicalSchemaHash: hashes.list },
        { upstreamTool: "get-event", canonicalSchemaHash: hashes.get },
      ],
    },
  }),
};

const started = await startServer({
  env,
  modelGateway,
  mcpDefinitions,
  mcpTransportFactory,
  // Bounded outer MCP shutdown backstop for the harness process.
  mcpShutdownMs: 2000,
});

/* ------------------------------------------------------------------ */
/* Loopback control server (fixture seam; Node-side requests only)      */
/* ------------------------------------------------------------------ */

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", () => resolve(""));
  });
}

const control = createServer(async (req, res) => {
  res.on("error", () => {});
  req.on("error", () => {});
  const json = (status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/health") {
    json(200, { status: "ok" });
    return;
  }
  if (req.method === "GET" && url.pathname === "/status") {
    json(200, { ...state });
    return;
  }
  await readBody(req);
  if (req.method === "POST" && url.pathname === "/advance-title") {
    state.revision = 2;
    json(200, { revision: state.revision });
    return;
  }
  if (req.method === "POST" && url.pathname === "/delete-event") {
    state.deleted = true;
    json(200, { deleted: state.deleted });
    return;
  }
  if (req.method === "POST" && url.pathname === "/reset") {
    resetFakeCalendarState(state);
    json(200, { reset: true });
    return;
  }
  json(404, { error: { code: "not_found" } });
});

await new Promise<void>((resolve) => {
  (control as HttpServer).listen(CALENDAR_CONTROL_PORT, "127.0.0.1", resolve);
});
// eslint-disable-next-line no-console
console.log(`calendar-e2e-control-ready ${CALENDAR_CONTROL_ORIGIN}`);

// eslint-disable-next-line no-console
console.log(`calendar-e2e-ready http://127.0.0.1:${started.port}`);

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await new Promise<void>((resolve) => {
    (control as HttpServer).close(() => resolve());
  });
  try {
    await started.shutdown();
  } catch {
    // Best effort: still remove the temp dir.
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
process.on("SIGINT", () => {
  void shutdown().then(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void shutdown().then(() => process.exit(0));
});
