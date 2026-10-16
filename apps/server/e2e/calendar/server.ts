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
// App C (CALENDAR_TOMBSTONE_APP_PORT 4185) boots a SECOND real server
// through the EXISTING C12 `calendarBinding` seam in a throwaway DB with
// its own `calendar` instance (registered through the existing
// ReferenceManager/migration seams, never by seeding snapshots) and its own
// trusted fixture binding: the REAL production adapter over a REAL
// `McpConnector` on its own inert transport, wrapped by the EXPLICIT
// authoritative synthetic get gate (see e2e/calendar/authoritativeBinding.ts).
// Only that armed gate + a SEPARATE real wire `get-event-authoritative`
// positive decode yields a `deleted` observation; the bare404 mode stays
// `uncertain failed`. No production rule/schema/normalizer change.
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
import {
  createReferenceManager,
  migrateKernelDatabase,
  openKernelDatabase,
} from "@companion/kernel";
import type { ModelGateway } from "@companion/model-local";
import { startServer } from "../../src/index.js";
import { createFakeCalendarActionWritePort } from "./actionPort.js";
import { createAuthoritativeCalendarBinding } from "./authoritativeBinding.js";
import {
  type CreateFixtureMode,
  createCreateFixtureStore,
  handleCreateFixtureRequest,
} from "./createFixture.js";
import { createFakeCalendarCreateWritePort } from "./createPort.js";
import type { FakeWriteMode } from "./mcpFake.js";
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
  CALENDAR_TOMBSTONE_APP_PORT,
  FAKE_BINDING_DISPLAY_NAME,
  FAKE_MCP_SERVER_NAME,
  FAKE_MCP_SERVER_VERSION,
} from "./ports.js";

const dir = mkdtempSync(join(tmpdir(), "companion-calendar-e2e-"));
const dbPath = join(dir, "companion-calendar.sqlite");

const hashes = await fakeToolSchemaHashes();
const state = createFakeCalendarState();
// M6 hermetic LOCAL Google-shaped create fixture storage (loopback only,
// same process): POST materializes the created event, GET serves the
// authoritative read-back. No fork checkout, no network, no OAuth.
const createStore = createCreateFixtureStore();

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

/** Fixture-owned authoritative binding for App C (created below). */
let tombstoneBinding: ReturnType<typeof createAuthoritativeCalendarBinding>;

const env: NodeJS.ProcessEnv = {
  COMPANION_DB_PATH: dbPath,
  COMPANION_HOST: "127.0.0.1",
  COMPANION_PORT: String(CALENDAR_APP_PORT),
  COMPANION_TIME_ZONE: "UTC",
  COMPANION_LOG_LEVEL: (process.env.E2E_DEBUG_LOG === "1" ? "info" : "error") as
    | "info"
    | "error",
  COMPANION_MODEL_JSON: JSON.stringify({
    adapter: "ollama",
    baseUrl: "http://127.0.0.1:1",
    model: "e2e-fake-calendar-model",
  }),
  // C22: the ONLY action gate is the explicit host opt-in triple: config
  // opt-in + writeEnabled + the injected trusted write port derived from the
  // active Calendar instance below. Never derived from model output.
  COMPANION_ACTIONS_JSON: JSON.stringify({
    optIn: true,
    writeEnabled: true,
    createEnabled: true,
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

/* ------------------------------------------------------------------ */
/* App C (tombstone app, port 4185): POSITIVE synthetic authoritative   */
/* deletion over the C12 injected-binding seam.                        */
/* ------------------------------------------------------------------ */

// Its own throwaway DB + its OWN registered `calendar` instance (created
// through the existing ReferenceManager/kernel migration seams, NOT by
// writing snapshots or references by hand).
const tombstoneDir = mkdtempSync(
  join(tmpdir(), "companion-calendar-tombstone-"),
);
const tombstoneDbPath = join(
  tombstoneDir,
  "companion-calendar-tombstone.sqlite",
);
const tombstoneState = createFakeCalendarState();
{
  const handle = openKernelDatabase(tombstoneDbPath);
  await migrateKernelDatabase({ db: handle.raw, backupDir: tombstoneDir });
  const instance = createReferenceManager(
    handle.raw,
  ).ensureCalendarConnectorInstance(FAKE_BINDING_DISPLAY_NAME, CALENDAR_ID);
  handle.raw.close();
  // Trusted fixture binding: the REAL production adapter over the fixture's
  // OWN real MCP connector, wrapped by the explicit authoritative gate.
  const binding = createAuthoritativeCalendarBinding({
    connectorInstanceId: instance.id,
    calendarId: CALENDAR_ID,
    state: tombstoneState,
    searchHash: hashes.search,
    listHash: hashes.list,
    getHash: hashes.get,
  });
  tombstoneBinding = binding;
}

const tombstoneStarted = await startServer({
  env: {
    COMPANION_DB_PATH: tombstoneDbPath,
    COMPANION_HOST: "127.0.0.1",
    COMPANION_PORT: String(CALENDAR_TOMBSTONE_APP_PORT),
    COMPANION_TIME_ZONE: "UTC",
    COMPANION_LOG_LEVEL: (process.env.E2E_DEBUG_LOG === "1"
      ? "info"
      : "error") as "info" | "error",
    COMPANION_MODEL_JSON: JSON.stringify({
      adapter: "ollama",
      baseUrl: "http://127.0.0.1:1",
      model: "e2e-fake-calendar-model",
    }),
    // NO calendar config: the C12 injected binding seam owns this app, so the
    // C14 owned composition (App A) is never modified by this fixture.
  },
  modelGateway: createScriptedCalendarModelGateway(),
  calendarBinding: {
    connectorInstanceId: tombstoneBinding.connectorInstanceId,
    selection: { calendarId: CALENDAR_ID },
    connector: tombstoneBinding.connector,
  },
});

const started = await startServer({
  env,
  modelGateway,
  mcpDefinitions,
  mcpTransportFactory,
  // C22: the dedicated trusted fake write port, DERIVED from the Calendar
  // instance the server itself just registered (the harness never knows the
  // stored id). The production exact-identity match rule is unchanged.
  actionWriteBinding: {
    derivePort: ({ connectorInstanceId }: { connectorInstanceId: string }) =>
      createFakeCalendarActionWritePort(state, connectorInstanceId),
  },
  // M6: the dedicated trusted fake CREATE port, DERIVED the same way. Its
  // insert performs a REAL loopback HTTP POST against the hermetic
  // Google-shaped fixture above (the event actually materializes); the
  // authoritative read-back is the active read binding's GET by the stable
  // insert id through the fake MCP server below (a real loopback GET).
  actionCreateBinding: {
    derivePort: ({ connectorInstanceId }: { connectorInstanceId: string }) =>
      createFakeCalendarCreateWritePort(createStore, connectorInstanceId),
  },
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

/** Tiny JSON body parse for the control seam (fixture only). */
function parseBody(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
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
    json(200, {
      ...state,
      releaseRead: state.releaseRead === null,
      releaseWrite: state.releaseWrite === null,
      // Tombstone app (App C) gate + its real wire get count.
      authoritativeDeleted: tombstoneState.authoritativeDeleted,
      tombstoneGetCalls: tombstoneState.getCalls,
      // M6 hermetic create fixture (POST/GET counts + stored events,
      // independent of receipt state; requests carry header/body proof).
      createMode: createStore.mode,
      createPostCount: createStore.postCount,
      createGetCount: createStore.getCount,
      createdEventIds: [...createStore.events.keys()],
      createdEvents: [...createStore.events.values()],
      createRequests: createStore.requests,
    });
    return;
  }
  // M6 hermetic Google-shaped create surface (loopback fixture; never a
  // production path). Handled BEFORE the shared single body read below: the
  // fixture POST consumes its own body exactly once, like every other arm.
  if (url.pathname.startsWith("/google/calendar/v3/calendars/")) {
    const handled = await handleCreateFixtureRequest(
      req,
      res,
      createStore,
      () => readBody(req),
    );
    if (handled) return;
  }
  // The body is read EXACTLY once: a second readBody() on an already-ended
  // request stream never resolves, which used to hang every /arm-write call
  // (and with it the whole action scenario) until the test timed out.
  const raw = await readBody(req);
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
  // C15 tombstone app (App C): arm ONLY its dedicated authoritative
  // synthetic get mode. This gate is EXPLICIT and distinct from the bare404
  // `/delete-event` miss above; nothing in production reads it.
  if (req.method === "POST" && url.pathname === "/authoritative-delete") {
    tombstoneState.authoritativeDeleted = true;
    json(200, { authoritativeDeleted: tombstoneState.authoritativeDeleted });
    return;
  }
  if (req.method === "POST" && url.pathname === "/reset-tombstone") {
    resetFakeCalendarState(tombstoneState);
    json(200, { reset: true });
    return;
  }
  if (req.method === "POST" && url.pathname === "/reset") {
    resetFakeCalendarState(state);
    createStore.reset();
    json(200, { reset: true });
    return;
  }
  // C22 fixture seam: test-only upstream title override (loopback control;
  // never a production normalizer path). Lets a real search/stage/approve
  // flow freeze an arbitrary title — including one beginning with
  // `calendar.reschedule:`. Cleared by `/reset` like every fixture field.
  if (req.method === "POST" && url.pathname === "/set-title") {
    const parsed = parseBody(raw);
    const title = typeof parsed?.title === "string" ? parsed.title : "";
    if (title.length < 1 || title.length > 128) {
      json(400, { error: { code: "invalid_title" } });
      return;
    }
    state.titleOverride = title;
    json(200, { titleOverride: state.titleOverride });
    return;
  }
  // C22 fixture seams (fake write behavior + barriers; no production path).
  if (req.method === "POST" && url.pathname === "/arm-write") {
    const parsed = parseBody(raw);
    const mode = typeof parsed?.mode === "string" ? parsed.mode : "";
    if (
      mode !== "success" &&
      mode !== "unverified" &&
      mode !== "unknown" &&
      mode !== "failure" &&
      mode !== "barrier"
    ) {
      json(400, { error: { code: "invalid_write_mode" } });
      return;
    }
    state.writeMode = mode as FakeWriteMode;
    json(200, { writeMode: state.writeMode });
    return;
  }
  if (req.method === "POST" && url.pathname === "/arm-read-barrier") {
    state.readBarrier = true;
    json(200, { readBarrier: state.readBarrier });
    return;
  }
  // M6 fixture seam (fake CREATE behavior; no production path):
  //   success     insert lands, read-back verifies,
  //   loss        insert lands BEFORE the response is lost -> unknown,
  //   wrong-title insert lands, read-back observes a drifted title ->
  //               succeeded_unverified (never verified).
  if (req.method === "POST" && url.pathname === "/arm-create") {
    const parsed = parseBody(raw);
    const mode = typeof parsed?.mode === "string" ? parsed.mode : "";
    if (mode !== "success" && mode !== "loss" && mode !== "wrong-title") {
      json(400, { error: { code: "invalid_create_mode" } });
      return;
    }
    createStore.mode = mode as CreateFixtureMode;
    json(200, { createMode: createStore.mode });
    return;
  }
  if (req.method === "POST" && url.pathname === "/release") {
    state.releaseRead?.();
    state.releaseRead = null;
    state.readBarrier = false;
    state.releaseWrite?.();
    state.releaseWrite = null;
    json(200, { released: true });
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
// eslint-disable-next-line no-console
console.log(
  `calendar-e2e-tombstone-ready http://127.0.0.1:${tombstoneStarted.port}`,
);

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await new Promise<void>((resolve) => {
    (control as HttpServer).close(() => resolve());
  });
  try {
    await tombstoneBinding.shutdown();
  } catch {
    // Fixture-owned MCP cleanup is best effort.
  }
  try {
    await tombstoneStarted.shutdown();
  } catch {
    // Best effort: still remove the temp dirs.
  }
  try {
    await started.shutdown();
  } catch {
    // Best effort: still remove the temp dir.
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  rmSync(tombstoneDir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
process.on("SIGINT", () => {
  void shutdown().then(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void shutdown().then(() => process.exit(0));
});
