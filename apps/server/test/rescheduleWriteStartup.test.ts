// M5 normal-startup dedicated write profile (host-owned, default OFF):
// composition preflight + trusted-lifecycle + real-process end to end.
//
// The profile is selected ONLY through strict frozen env
// (`M5_RESCHEDULE_WRITE_PROFILE=google-reschedule` together with the exact
// `M5_RESCHEDULE_CONNECTOR_JSON` stdio-hint shape); unset means DISABLED
// (previous behavior unchanged). These tests assert REAL behavior, never
// copies of the implementation:
// - every invalid selector/hint/conflict fails closed BEFORE any DB side
//   effect (no DB file is created),
// - the default composition spawns NO write child and keeps approve gated,
// - a selected profile opens the existing triple gate with NO injected
//   binding (capability on the ACTIVE instance, readonly surface intact),
// - the FULL normal path — pre-seeded staged proposal, HTTP approve, the
//   engine scheduler, the owned lazy dedicated connector over REAL stdio
//   to the TRACKED fixture server, the local Google-shaped fixture PATCH,
//   the strategy's own readonly readback, the terminal receipt — performs
//   exactly ONE conditional patch,
// - a grant gone stale before execution is blocked with NO patch (the
//   immutable committed etag is never replaced by the latest resource),
// - a drifted wire identity fails the execution with NO patch.
//
// The REAL child process arrives ONLY through the options-injected trusted
// test seam (`writeMcpTransportFactory` + `writeTestIdentity`, never env):
// the fixture endpoint variable is set in the CHILD env only, and the
// production default factory path is never given a test bypass. No live
// Google, no OAuth, fixture data only. No imports from any ignored nested
// checkout: the tracked helper resolves via import.meta.url.

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultTransportFactory,
  type McpConnectorConfig,
  STDIO_IMPLICIT_ENV_VARS,
  StdioClientTransport,
} from "@companion/connector-mcp";
import {
  ProposalExecutionViewSchema,
  SnapshotBodySchema,
} from "@companion/contracts";
import {
  type CalendarConnectorPort,
  calendarEventBodyText,
  canonicalJsonString,
  closeKernelDatabase,
  createKernelRepository,
  createReferenceManager,
  generateId,
  migrateKernelDatabase,
  openKernelDatabase,
} from "@companion/kernel";
import { afterEach, describe, expect, it } from "vitest";
import { type StartedServer, startServer } from "../src/bootstrap.js";
import {
  buildRescheduleWriteConnectorConfig,
  parseRescheduleWriteConnectorHint,
  RESCHEDULE_WRITE_CONNECTOR_ENV,
  RESCHEDULE_WRITE_PROFILE_ENV,
} from "../src/rescheduleWriteProfile.js";

const servers: StartedServer[] = [];
let tempDirs: string[] = [];
let fixture: Server | undefined;

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server !== undefined) {
      await server.shutdown("test-teardown");
    }
  }
  if (fixture !== undefined) {
    await new Promise<void>((resolve) => {
      fixture?.close(() => resolve());
      fixture = undefined;
    });
  }
  for (const dir of tempDirs) {
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
  tempDirs = [];
});

function tempEnv(): { env: NodeJS.ProcessEnv; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "companion-write-profile-"));
  tempDirs.push(dir);
  return {
    env: {
      COMPANION_DB_PATH: join(dir, "companion.sqlite"),
      COMPANION_HOST: "127.0.0.1",
      COMPANION_PORT: "0",
      COMPANION_TIME_ZONE: "UTC",
      COMPANION_LOG_LEVEL: "error",
    },
    dbPath: join(dir, "companion.sqlite"),
  };
}

/** Strip undefined entries (child-process env must be string-valued). */
function cleanEnv(input: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

const WRITE_PROFILE_ENV = {
  [RESCHEDULE_WRITE_PROFILE_ENV]: "google-reschedule",
  [RESCHEDULE_WRITE_CONNECTOR_ENV]: JSON.stringify({ command: "node" }),
} as const;

const ENABLED_ACTIONS_JSON = JSON.stringify({
  optIn: true,
  writeEnabled: true,
});

function fakeCalendarBinding(
  connectorInstanceId: string,
): CalendarConnectorPort {
  return {
    connectorInstanceId,
    search: async () => ({ ok: false as const, code: "mcp_unavailable" }),
    get: async () => ({ ok: false as const, code: "mcp_unavailable" }),
  };
}

describe("write-profile preflight fails closed before any DB side effect", () => {
  it("rejects an unknown profile without creating the DB file", async () => {
    const { env, dbPath } = tempEnv();
    await expect(
      startServer({
        env: { ...env, [RESCHEDULE_WRITE_PROFILE_ENV]: "nope" },
        drainMs: 50,
      }),
    ).rejects.toThrow(/unknown reschedule write profile/);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("rejects connector hints without the profile selector", async () => {
    const { env, dbPath } = tempEnv();
    await expect(
      startServer({
        env: {
          ...env,
          [RESCHEDULE_WRITE_CONNECTOR_ENV]: JSON.stringify({
            command: "node",
          }),
        },
        drainMs: 50,
      }),
    ).rejects.toThrow(/require a write profile/);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("rejects a profile competing with an injected write binding", async () => {
    const { env, dbPath } = tempEnv();
    const instanceId = randomUUID();
    await expect(
      startServer({
        env: {
          ...env,
          COMPANION_ACTIONS_JSON: ENABLED_ACTIONS_JSON,
          ...WRITE_PROFILE_ENV,
        },
        calendarBinding: {
          connectorInstanceId: instanceId,
          connector: fakeCalendarBinding(instanceId),
          selection: { calendarId: "primary", account: "ops@example" },
        },
        actionWriteBinding: {
          port: {
            capability: {
              tool: "calendar.reschedule",
              editableFields: ["start", "end"],
              connectorInstanceId: instanceId,
              writeEnabled: true,
            },
            update: async () => ({ status: "succeeded" as const }),
          },
        },
        drainMs: 50,
      }),
    ).rejects.toThrow(/mutually exclusive/);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("rejects the profile without the actions opt-in pair", async () => {
    const { env, dbPath } = tempEnv();
    const instanceId = randomUUID();
    await expect(
      startServer({
        env: { ...env, ...WRITE_PROFILE_ENV },
        calendarBinding: {
          connectorInstanceId: instanceId,
          connector: fakeCalendarBinding(instanceId),
          selection: { calendarId: "primary", account: "ops@example" },
        },
        drainMs: 50,
      }),
    ).rejects.toThrow(/requires action write opt-in/);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("rejects unknown hint keys without creating the DB file", async () => {
    const { env, dbPath } = tempEnv();
    const instanceId = randomUUID();
    await expect(
      startServer({
        env: {
          ...env,
          COMPANION_ACTIONS_JSON: ENABLED_ACTIONS_JSON,
          [RESCHEDULE_WRITE_PROFILE_ENV]: "google-reschedule",
          [RESCHEDULE_WRITE_CONNECTOR_ENV]: JSON.stringify({
            command: "node",
            category: "write",
          }),
        },
        calendarBinding: {
          connectorInstanceId: instanceId,
          connector: fakeCalendarBinding(instanceId),
          selection: { calendarId: "primary", account: "ops@example" },
        },
        drainMs: 50,
      }),
    ).rejects.toThrow(/connector hints are invalid/);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("rejects TEST-namespace env allowlist entries (fixture bypass)", async () => {
    const { env, dbPath } = tempEnv();
    const instanceId = randomUUID();
    await expect(
      startServer({
        env: {
          ...env,
          COMPANION_ACTIONS_JSON: ENABLED_ACTIONS_JSON,
          [RESCHEDULE_WRITE_PROFILE_ENV]: "google-reschedule",
          [RESCHEDULE_WRITE_CONNECTOR_ENV]: JSON.stringify({
            command: "node",
            envAllowlist: ["M5_RESCHEDULE_TEST_ENDPOINT_BASE"],
          }),
        },
        calendarBinding: {
          connectorInstanceId: instanceId,
          connector: fakeCalendarBinding(instanceId),
          selection: { calendarId: "primary", account: "ops@example" },
        },
        drainMs: 50,
      }),
    ).rejects.toThrow(/allowlist is invalid/);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("rejects the profile without any Calendar composition", async () => {
    const { env, dbPath } = tempEnv();
    await expect(
      startServer({
        env: {
          ...env,
          COMPANION_ACTIONS_JSON: ENABLED_ACTIONS_JSON,
          ...WRITE_PROFILE_ENV,
        },
        drainMs: 50,
      }),
    ).rejects.toThrow(/requires calendar config/);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("rejects a production-factory hint missing the platform implicit env before any DB side effect", async () => {
    // P1: `{"command":"node"}` defaults `envAllowlist` to `[]`, which the
    // production default factory deterministically rejects before spawn
    // (first approval would otherwise commit a grant then land `unknown`
    // with no write dispatched). No injected factory here, so the
    // production path is validated in preflight: fixed redacted message, no
    // DB file, no child.
    const { env, dbPath } = tempEnv();
    const instanceId = randomUUID();
    await expect(
      startServer({
        env: {
          ...env,
          COMPANION_ACTIONS_JSON: ENABLED_ACTIONS_JSON,
          ...WRITE_PROFILE_ENV,
        },
        calendarBinding: {
          connectorInstanceId: instanceId,
          connector: fakeCalendarBinding(instanceId),
          selection: { calendarId: "primary", account: "ops@example" },
        },
        drainMs: 50,
      }),
    ).rejects.toThrow(/env allowlist is invalid/);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("leaves an existing DB byte-identical on a production-factory env allowlist rejection", async () => {
    const { env, dbPath } = tempEnv();
    const handle = openKernelDatabase(dbPath);
    try {
      await migrateKernelDatabase({
        db: handle.raw,
        backupDir: join(dbPath, "..", "backups"),
      });
    } finally {
      closeKernelDatabase(handle);
    }
    const before = readFileSync(dbPath);
    const instanceId = randomUUID();
    await expect(
      startServer({
        env: {
          ...env,
          COMPANION_ACTIONS_JSON: ENABLED_ACTIONS_JSON,
          ...WRITE_PROFILE_ENV,
        },
        calendarBinding: {
          connectorInstanceId: instanceId,
          connector: fakeCalendarBinding(instanceId),
          selection: { calendarId: "primary", account: "ops@example" },
        },
        drainMs: 50,
      }),
    ).rejects.toThrow(/env allowlist is invalid/);
    expect(readFileSync(dbPath).equals(before)).toBe(true);
  });
});

describe("write-profile default/off composition", () => {
  it("spawns no write child and keeps approve gated when unselected", async () => {
    const { env, dbPath } = tempEnv();
    const handle = openKernelDatabase(dbPath);
    let instanceId: string;
    try {
      await migrateKernelDatabase({
        db: handle.raw,
        backupDir: join(dbPath, "..", "backups"),
      });
      instanceId = createReferenceManager(
        handle.raw,
      ).ensureCalendarConnectorInstance("calendar-fake-binding", "primary", {
        account: "ops@example",
      }).id;
    } finally {
      closeKernelDatabase(handle);
    }
    let writeChildren = 0;
    const started = await startServer({
      env,
      calendarBinding: {
        connectorInstanceId: instanceId,
        connector: fakeCalendarBinding(instanceId),
        selection: { calendarId: "primary", account: "ops@example" },
      },
      writeMcpTransportFactory: () => {
        writeChildren += 1;
        throw new Error("must never be constructed when unselected");
      },
      drainMs: 50,
    });
    servers.push(started);
    expect(writeChildren).toBe(0);
    expect([...(started.toolBroker?.toolNames() ?? [])].sort()).toEqual([
      "calendar.search",
      "reference.open",
      "reference.refresh",
      "reference.related",
    ]);
    const response = await fetch(
      `http://127.0.0.1:${started.port}/api/sessions/${randomUUID()}/proposals/${randomUUID()}/approve`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": randomUUID(),
          origin: `http://127.0.0.1:${started.port}`,
        },
        body: JSON.stringify({ proposalHash: "a".repeat(64) }),
      },
    );
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("action_execution_disabled");
    expect(writeChildren).toBe(0);
  });

  it("freezes the unselected decision against a later mutation", async () => {
    const { env, dbPath } = tempEnv();
    const handle = openKernelDatabase(dbPath);
    let instanceId: string;
    try {
      await migrateKernelDatabase({
        db: handle.raw,
        backupDir: join(dbPath, "..", "backups"),
      });
      instanceId = createReferenceManager(
        handle.raw,
      ).ensureCalendarConnectorInstance("calendar-fake-binding", "primary", {
        account: "ops@example",
      }).id;
    } finally {
      closeKernelDatabase(handle);
    }
    const liveEnv: NodeJS.ProcessEnv = {
      ...env,
      COMPANION_ACTIONS_JSON: ENABLED_ACTIONS_JSON,
    };
    const pending = startServer({
      env: liveEnv,
      calendarBinding: {
        connectorInstanceId: instanceId,
        connector: fakeCalendarBinding(instanceId),
        selection: { calendarId: "primary", account: "ops@example" },
      },
      drainMs: 50,
    });
    // Mutate the SAME env object synchronously after the call: the frozen
    // startup decision must not observe the profile.
    liveEnv[RESCHEDULE_WRITE_PROFILE_ENV] = "google-reschedule";
    liveEnv[RESCHEDULE_WRITE_CONNECTOR_ENV] = JSON.stringify({
      command: "node",
    });
    await expect(pending).rejects.toThrow(/active calendar binding/);
  });

  it("leaves an existing DB byte-identical on an early invalid selector", async () => {
    const { env, dbPath } = tempEnv();
    const handle = openKernelDatabase(dbPath);
    try {
      await migrateKernelDatabase({
        db: handle.raw,
        backupDir: join(dbPath, "..", "backups"),
      });
    } finally {
      closeKernelDatabase(handle);
    }
    const before = readFileSync(dbPath);
    await expect(
      startServer({
        env: { ...env, [RESCHEDULE_WRITE_PROFILE_ENV]: "nope" },
        drainMs: 50,
      }),
    ).rejects.toThrow(/unknown reschedule write profile/);
    expect(readFileSync(dbPath).equals(before)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Real-process end to end: staged approval -> engine scheduler -> owned lazy
// dedicated connector over REAL stdio to the TRACKED fixture server -> local
// Google-shaped fixture PATCH -> strategy's own readonly readback ->
// terminal receipt. Fixture endpoint arrives ONLY through the
// options-injected trusted test seam (child-process env); production env
// never carries it (TEST-namespace names are rejected by the hint parser
// above, and the production default factory is never given a bypass).
// ---------------------------------------------------------------------------

const E2E_CALENDAR_ID = "primary";
const E2E_EVENT_ID = "evt-timed-1";
const E2E_ETAG_V1 = '"etag-v1"';
const E2E_CANONICAL_KEY = `cal|${E2E_CALENDAR_ID}|${E2E_EVENT_ID}`;
const E2E_START_OLD = "2026-02-01T10:00:00Z";
const E2E_END_OLD = "2026-02-01T11:00:00Z";
const E2E_START_NEW = "2026-03-01T10:00:00Z";
const E2E_END_NEW = "2026-03-01T11:00:00Z";
const E2E_T0 = Date.parse("2026-01-01T00:00:00.000Z");

const FIXTURE_IDENTITY = {
  expectedServerName: "google-calendar-reschedule-test-fixture",
  version: "0.0.0-fixture.1",
} as const;

function fixtureHelperPath(): string {
  const helper = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "packages",
    "connector-calendar",
    "test",
    "helpers",
    "rescheduleFixtureServer.mjs",
  );
  if (!existsSync(helper)) {
    throw new Error("tracked fixture MCP server missing: test setup broken");
  }
  return helper;
}

/**
 * Trusted-test stdio hint: the MANDATORY SDK inherited names
 * (`STDIO_IMPLICIT_ENV_VARS`, live `DEFAULT_INHERITED_ENV_VARS`) so the
 * fail-closed stdio guard passes BEFORE spawn. The fixture endpoint
 * (`M5_RESCHEDULE_TEST_ENDPOINT_BASE`) NEVER appears here — production
 * parsing rejects `M5_RESCHEDULE_TEST_*`; the child-only seam below carries
 * it in the CHILD env only.
 */
function e2eConnectorHintJson(helper: string): string {
  return JSON.stringify({
    command: "node",
    args: [helper],
    envAllowlist: [...STDIO_IMPLICIT_ENV_VARS],
  });
}

interface E2EFixtureState {
  base: string;
  patchCount: () => number;
  lastIfMatch: () => string | undefined;
  lastBodyKeys: () => string[];
  eventStart: () => string;
  setEtag: (etag: string) => void;
}

/** Local Google-shaped fixture: GET returns the event; PATCH is conditional. */
async function startGoogleFixture(): Promise<E2EFixtureState> {
  let etag = E2E_ETAG_V1;
  let eventStart = E2E_START_OLD;
  let eventEnd = E2E_END_OLD;
  let patchCount = 0;
  let lastIfMatch: string | undefined;
  let lastBodyKeys: string[] = [];
  fixture = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const match = /^\/calendar\/v3\/calendars\/([^/]+)\/events\/([^/]+)$/.exec(
      url.pathname,
    );
    if (match === null) {
      res.writeHead(404).end();
      return;
    }
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          id: E2E_EVENT_ID,
          etag,
          status: "confirmed",
          start: { dateTime: eventStart },
          end: { dateTime: eventEnd },
        }),
      );
      return;
    }
    if (req.method === "PATCH") {
      let raw = "";
      req.on("data", (chunk: Buffer) => {
        raw += chunk.toString("utf-8");
      });
      req.on("end", () => {
        lastIfMatch = req.headers["if-match"] as string | undefined;
        try {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          lastBodyKeys = Object.keys(parsed).sort();
          const s = (parsed.start as { dateTime?: unknown })?.dateTime;
          const e = (parsed.end as { dateTime?: unknown })?.dateTime;
          if (req.headers["if-match"] !== etag) {
            res.writeHead(412).end();
            return;
          }
          if (typeof s !== "string" || typeof e !== "string") {
            res.writeHead(400).end();
            return;
          }
          eventStart = s;
          eventEnd = e;
          patchCount += 1;
          res.writeHead(200, { "content-type": "application/json" }).end("{}");
        } catch {
          res.writeHead(400).end();
        }
      });
      return;
    }
    res.writeHead(405).end();
  });
  await new Promise<void>((resolve) => {
    fixture?.listen(0, "127.0.0.1", () => resolve());
  });
  const address = fixture?.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("fixture did not listen");
  }
  const base = `http://127.0.0.1:${(address as { port: number }).port}`;
  return {
    base,
    patchCount: () => patchCount,
    lastIfMatch: () => lastIfMatch,
    lastBodyKeys: () => [...lastBodyKeys],
    eventStart: () => eventStart,
    setEtag: (next: string) => {
      etag = next;
    },
  };
}

/**
 * Injected READ binding only (the write binding is never injected: the
 * host-owned profile composes it). Proxies the live fixture GET so the
 * strategy's preflight AND its §18.7 readback observe the REAL fixture
 * state (pre-write etag match, post-write new boundaries).
 */
function fixtureBackedCalendarBinding(
  connectorInstanceId: string,
  getBase: () => string,
): CalendarConnectorPort {
  return {
    connectorInstanceId,
    search: async () => ({ ok: false as const, code: "mcp_unavailable" }),
    get: async (target) => {
      let response: Response;
      try {
        response = await fetch(
          `${getBase()}/calendar/v3/calendars/${encodeURIComponent(target.calendarId)}/events/${encodeURIComponent(target.eventId)}`,
          { redirect: "manual" },
        );
      } catch {
        return { ok: false as const, code: "mcp_unavailable" };
      }
      if (!response.ok) {
        return { ok: false as const, code: "mcp_unavailable" };
      }
      const body = (await response.json()) as {
        etag?: unknown;
        status?: unknown;
        start?: { dateTime?: unknown };
        end?: { dateTime?: unknown };
      };
      if (
        typeof body.etag !== "string" ||
        typeof body.start?.dateTime !== "string" ||
        typeof body.end?.dateTime !== "string"
      ) {
        return { ok: false as const, code: "mcp_unavailable" };
      }
      return {
        ok: true as const,
        event: {
          canonicalKey: E2E_CANONICAL_KEY,
          status: "confirmed" as const,
          title: "Fixture Event",
          start: body.start.dateTime,
          end: body.end.dateTime,
          allDayEndExclusive: true,
          sourceRevision: body.etag,
          revisionBasis: "etag" as const,
        },
      };
    },
  };
}

async function provisionCalendarInstance(dbPath: string): Promise<string> {
  const handle = openKernelDatabase(dbPath);
  try {
    await migrateKernelDatabase({
      db: handle.raw,
      backupDir: join(dbPath, "..", "backups"),
    });
    return createReferenceManager(handle.raw).ensureCalendarConnectorInstance(
      "calendar-fake-binding",
      "primary",
      { account: "ops@example" },
    ).id;
  } finally {
    closeKernelDatabase(handle);
  }
}

function e2eSnapshotBodyJson(): string {
  const text = calendarEventBodyText({
    canonicalKey: E2E_CANONICAL_KEY,
    status: "confirmed",
    title: "Fixture Event",
    start: E2E_START_OLD,
    end: E2E_END_OLD,
    allDayEndExclusive: true,
    sourceRevision: E2E_ETAG_V1,
    revisionBasis: "etag",
  } as const);
  return canonicalJsonString(SnapshotBodySchema.parse({ version: 1, text }));
}

/** Stage a reschedule proposal against the live-shaped snapshot (pre-start). */
async function seedStagedProposal(
  dbPath: string,
  instanceId: string,
): Promise<{ sessionId: string; proposalId: string; hash: string }> {
  const handle = openKernelDatabase(dbPath);
  try {
    const repo = createKernelRepository(handle.raw, {
      actionProposals: { writeEnabled: true },
    });
    const resourceId = generateId();
    const snapshotId = generateId();
    const refId = generateId();
    // Fixture contract: the direct SQL seed must preserve the
    // ReferenceManager allocator invariant (`next_revision` is the next FREE
    // revision). One revision-1 snapshot exists below, so the resource row
    // carries `next_revision = 2`; otherwise the preflight materialization
    // (refresh always allocates a new snapshot) hits the
    // (resource_id, revision) UNIQUE and the run abandons pre-grant.
    handle.raw
      .prepare(
        "INSERT INTO resources (id, connector_instance_id, canonical_key, title, next_revision, created_at) VALUES (?, ?, ?, 'Fixture Event', 2, 1)",
      )
      .run(resourceId, instanceId, E2E_CANONICAL_KEY);
    handle.raw
      .prepare(
        "INSERT INTO resource_snapshots (id, resource_id, revision, source_revision, content_hash, body_json, size_bytes, observed_at, created_at) VALUES (?, ?, 1, ?, 'hash@1', ?, 10, 1, 1)",
      )
      .run(snapshotId, resourceId, E2E_ETAG_V1, e2eSnapshotBodyJson());
    handle.raw
      .prepare(
        "INSERT INTO calendar_get_targets (canonical_key, target_json, updated_at) VALUES (?, ?, ?)",
      )
      .run(
        E2E_CANONICAL_KEY,
        JSON.stringify({
          calendarId: E2E_CALENDAR_ID,
          eventId: E2E_EVENT_ID,
        }),
        Date.now(),
      );
    const sessionId = repo.createSession({ key: randomUUID(), now: E2E_T0 })
      .body.sessionId;
    handle.raw
      .prepare(
        "INSERT INTO session_references (id, session_id, ordinal, resource_id, snapshot_id, created_at) VALUES (?, ?, 1, ?, ?, 1)",
      )
      .run(refId, sessionId, resourceId, snapshotId);
    // Fixture contract (same allocator invariant as above): the direct
    // ordinal-1 reference row consumes the session's first ordinal, so the
    // allocator must advance past it; otherwise the preflight
    // materialization (refresh always mints a new rN) hits the
    // (session_id, ordinal) UNIQUE and the run abandons pre-grant.
    handle.raw
      .prepare("UPDATE sessions SET next_reference_ordinal = 2 WHERE id = ?")
      .run(sessionId);
    const posted = repo.postMessage(
      sessionId,
      { text: "reschedule please" },
      { key: randomUUID(), now: E2E_T0 },
    ).body;
    await repo.startRun(posted.run.id, { now: E2E_T0 + 1 });
    const staged = repo.actionProposalsStager?.stage(posted.run.id, {
      targetRefId: refId,
      start: E2E_START_NEW,
      end: E2E_END_NEW,
    });
    if (staged === undefined) {
      throw new Error("staging unavailable");
    }
    repo.completeRun(
      posted.run.id,
      { version: 1, text: "here is the plan" },
      { now: E2E_T0 + 2 },
    );
    const events = repo.getEvents(sessionId, posted.run.id, {
      after: 0,
      limit: 50,
    });
    const proposed = events.events.find((e) => e.type === "action.proposed") as
      | { payload: { proposalId: string } }
      | undefined;
    if (proposed === undefined) {
      throw new Error("expected a committed proposal");
    }
    return {
      sessionId,
      proposalId: proposed.payload.proposalId,
      hash: staged.hash,
    };
  } finally {
    closeKernelDatabase(handle);
  }
}

/** Trusted-test stdio seam: tracked helper over REAL stdio, fixture env in the CHILD only. */
function testWriteTransportFactory(fixtureBase: string) {
  return (config: McpConnectorConfig) => {
    const transport = config.transport as {
      readonly kind: string;
      readonly command: string;
      readonly args: readonly string[];
    };
    return new StdioClientTransport({
      command: transport.command,
      args: [...transport.args],
      env: {
        ...cleanEnv(process.env),
        M5_RESCHEDULE_TEST_ENDPOINT_BASE: fixtureBase,
      },
      stderr: "pipe",
    });
  };
}

async function approveProposalHttp(
  port: number,
  sessionId: string,
  proposalId: string,
  proposalHash: string,
): Promise<{ executionId: string; runId: string }> {
  const response = await fetch(
    `http://127.0.0.1:${port}/api/sessions/${sessionId}/proposals/${proposalId}/approve`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
        origin: `http://127.0.0.1:${port}`,
      },
      body: JSON.stringify({ proposalHash }),
    },
  );
  expect(response.status).toBe(202);
  const body = (await response.json()) as {
    proposalId: string;
    executionId: string;
    runId: string;
    status: string;
  };
  expect(body.status).toBe("queued");
  return { executionId: body.executionId, runId: body.runId };
}

async function waitForTerminalReceipt(
  port: number,
  sessionId: string,
  proposalId: string,
) {
  const deadline = Date.now() + 25_000;
  for (;;) {
    const response = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}/proposals/${proposalId}/execution`,
    );
    expect(response.status).toBe(200);
    const view = ProposalExecutionViewSchema.parse(await response.json());
    if (view.receipt !== null) {
      return view;
    }
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for the terminal receipt");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("write-profile selected composition without an injected write binding", () => {
  it("opens the triple gate with the host-owned port (readonly surface intact)", async () => {
    const { env, dbPath } = tempEnv();
    const instanceId = await provisionCalendarInstance(dbPath);
    let writeChildren = 0;
    const started = await startServer({
      env: {
        ...env,
        COMPANION_ACTIONS_JSON: ENABLED_ACTIONS_JSON,
        ...WRITE_PROFILE_ENV,
      },
      calendarBinding: {
        connectorInstanceId: instanceId,
        connector: fakeCalendarBinding(instanceId),
        selection: { calendarId: "primary", account: "ops@example" },
      },
      // No actionWriteBinding: the host-owned profile composes the port.
      // Lazy lifecycle: selected but never constructed until first use.
      writeMcpTransportFactory: () => {
        writeChildren += 1;
        throw new Error("no write call expected in this composition probe");
      },
      drainMs: 50,
    });
    servers.push(started);
    expect(writeChildren).toBe(0);
    expect([...(started.toolBroker?.toolNames() ?? [])].sort()).toEqual([
      "calendar.reschedule",
      "calendar.search",
      "reference.open",
      "reference.refresh",
      "reference.related",
    ]);
    // Gate open: the request reaches the repository (404 for a random id,
    // never the disabled 409).
    const response = await fetch(
      `http://127.0.0.1:${started.port}/api/sessions/${randomUUID()}/proposals/${randomUUID()}/approve`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": randomUUID(),
          origin: `http://127.0.0.1:${started.port}`,
        },
        body: JSON.stringify({ proposalHash: "a".repeat(64) }),
      },
    );
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("action_execution_disabled");
    expect(writeChildren).toBe(0);
  });

  it("treats an explicit null write binding as absent (same gate as undefined)", async () => {
    // P2: `actionWriteBinding: null` is the documented absent value
    // (`StartServerOptions` permits `null`, the rest of bootstrap normalizes
    // with `?? null`); only a NON-NULL binding conflicts with the profile.
    const { env: nullEnv, dbPath: nullDb } = tempEnv();
    const realId = await provisionCalendarInstance(nullDb);
    let writeChildren = 0;
    const started = await startServer({
      env: {
        ...nullEnv,
        COMPANION_ACTIONS_JSON: ENABLED_ACTIONS_JSON,
        ...WRITE_PROFILE_ENV,
      },
      calendarBinding: {
        connectorInstanceId: realId,
        connector: fakeCalendarBinding(realId),
        selection: { calendarId: "primary", account: "ops@example" },
      },
      actionWriteBinding: null,
      // Lazy lifecycle: selected but never constructed until first use.
      writeMcpTransportFactory: () => {
        writeChildren += 1;
        throw new Error("no write call expected in this composition probe");
      },
      drainMs: 50,
    });
    servers.push(started);
    expect(writeChildren).toBe(0);
    expect([...(started.toolBroker?.toolNames() ?? [])].sort()).toEqual([
      "calendar.reschedule",
      "calendar.search",
      "reference.open",
      "reference.refresh",
      "reference.related",
    ]);
    const response = await fetch(
      `http://127.0.0.1:${started.port}/api/sessions/${randomUUID()}/proposals/${randomUUID()}/approve`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": randomUUID(),
          origin: `http://127.0.0.1:${started.port}`,
        },
        body: JSON.stringify({ proposalHash: "a".repeat(64) }),
      },
    );
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("action_execution_disabled");
    expect(writeChildren).toBe(0);
  });
});

describe("committed-grant revision resolver (concrete, immutable)", () => {
  it("reads back the exact stored hash+revision; unknown grants are null", async () => {
    const { dbPath } = tempEnv();
    const instanceId = await provisionCalendarInstance(dbPath);
    const { sessionId, proposalId, hash } = await seedStagedProposal(
      dbPath,
      instanceId,
    );
    const handle = openKernelDatabase(dbPath);
    try {
      const repo = createKernelRepository(handle.raw, {
        actionProposals: { writeEnabled: true },
      });
      repo.approveProposal(
        sessionId,
        proposalId,
        { proposalHash: hash },
        { key: randomUUID(), now: E2E_T0 + 10, timeZone: "UTC" },
      );
      const execution = handle.raw
        .prepare("SELECT id FROM action_executions WHERE proposal_id = ?")
        .get(proposalId) as { id: string } | undefined;
      expect(execution).not.toBeUndefined();
      const stored = repo.readCommittedGrantRevision(
        execution?.id ?? "",
        proposalId,
      );
      expect(stored).toEqual({
        proposalHash: hash,
        expectedRevision: E2E_ETAG_V1,
      });
      // Unknown execution/proposal pairs resolve to null (never a guess).
      expect(
        repo.readCommittedGrantRevision(randomUUID(), proposalId),
      ).toBeNull();
      expect(
        repo.readCommittedGrantRevision(execution?.id ?? "", randomUUID()),
      ).toBeNull();
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

describe("real-process end to end (tracked fixture over real stdio)", () => {
  it("staged approve performs exactly ONE conditional PATCH and lands a verified succeeded receipt", async () => {
    const { env, dbPath } = tempEnv();
    const fx = await startGoogleFixture();
    const instanceId = await provisionCalendarInstance(dbPath);
    const { sessionId, proposalId, hash } = await seedStagedProposal(
      dbPath,
      instanceId,
    );
    const helper = fixtureHelperPath();
    const started = await startServer({
      env: {
        ...env,
        COMPANION_ACTIONS_JSON: ENABLED_ACTIONS_JSON,
        [RESCHEDULE_WRITE_PROFILE_ENV]: "google-reschedule",
        [RESCHEDULE_WRITE_CONNECTOR_ENV]: e2eConnectorHintJson(helper),
      },
      calendarBinding: {
        connectorInstanceId: instanceId,
        connector: fixtureBackedCalendarBinding(instanceId, () => fx.base),
        selection: { calendarId: "primary", account: "ops@example" },
      },
      writeMcpTransportFactory: testWriteTransportFactory(fx.base),
      writeTestIdentity: { ...FIXTURE_IDENTITY },
      drainMs: 50,
    });
    servers.push(started);
    await approveProposalHttp(started.port, sessionId, proposalId, hash);
    const view = await waitForTerminalReceipt(
      started.port,
      sessionId,
      proposalId,
    );
    expect(view.markerCommitted).toBe(true);
    expect(view.receipt?.outcome).toBe("succeeded");
    // Exactly ONE conditional PATCH with the committed etag, start/end only.
    expect(fx.patchCount()).toBe(1);
    expect(fx.lastIfMatch()).toBe(E2E_ETAG_V1);
    expect(fx.lastBodyKeys()).toEqual(["end", "start"]);
    expect(fx.eventStart()).toBe(E2E_START_NEW);
  }, 60_000);

  it("a grant gone stale before execution is blocked with NO patch", async () => {
    const { env, dbPath } = tempEnv();
    const fx = await startGoogleFixture();
    const instanceId = await provisionCalendarInstance(dbPath);
    const { sessionId, proposalId, hash } = await seedStagedProposal(
      dbPath,
      instanceId,
    );
    // The live resource moves AFTER staging: the committed grant (etag v1)
    // no longer matches, so preflight must block with no dispatch.
    fx.setEtag('"etag-v2"');
    const helper = fixtureHelperPath();
    const started = await startServer({
      env: {
        ...env,
        COMPANION_ACTIONS_JSON: ENABLED_ACTIONS_JSON,
        [RESCHEDULE_WRITE_PROFILE_ENV]: "google-reschedule",
        [RESCHEDULE_WRITE_CONNECTOR_ENV]: e2eConnectorHintJson(helper),
      },
      calendarBinding: {
        connectorInstanceId: instanceId,
        connector: fixtureBackedCalendarBinding(instanceId, () => fx.base),
        selection: { calendarId: "primary", account: "ops@example" },
      },
      writeMcpTransportFactory: testWriteTransportFactory(fx.base),
      writeTestIdentity: { ...FIXTURE_IDENTITY },
      drainMs: 50,
    });
    servers.push(started);
    await approveProposalHttp(started.port, sessionId, proposalId, hash);
    const view = await waitForTerminalReceipt(
      started.port,
      sessionId,
      proposalId,
    );
    expect(view.receipt?.outcome).toBe("blocked_stale");
    expect(fx.patchCount()).toBe(0);
  }, 60_000);

  it("a drifted wire identity fails the execution with NO patch", async () => {
    const { env, dbPath } = tempEnv();
    const fx = await startGoogleFixture();
    const instanceId = await provisionCalendarInstance(dbPath);
    const { sessionId, proposalId, hash } = await seedStagedProposal(
      dbPath,
      instanceId,
    );
    const helper = fixtureHelperPath();
    const started = await startServer({
      env: {
        ...env,
        COMPANION_ACTIONS_JSON: ENABLED_ACTIONS_JSON,
        [RESCHEDULE_WRITE_PROFILE_ENV]: "google-reschedule",
        [RESCHEDULE_WRITE_CONNECTOR_ENV]: e2eConnectorHintJson(helper),
      },
      calendarBinding: {
        connectorInstanceId: instanceId,
        connector: fixtureBackedCalendarBinding(instanceId, () => fx.base),
        selection: { calendarId: "primary", account: "ops@example" },
      },
      writeMcpTransportFactory: testWriteTransportFactory(fx.base),
      // Drifted identity (production pin against the fixture): the
      // wire-identity gate must deny BEFORE any PATCH is dispatched.
      writeTestIdentity: {
        expectedServerName: "google-calendar-reschedule",
        version: "1.0.0-reschedule.1",
      },
      drainMs: 50,
    });
    servers.push(started);
    await approveProposalHttp(started.port, sessionId, proposalId, hash);
    const view = await waitForTerminalReceipt(
      started.port,
      sessionId,
      proposalId,
    );
    expect(view.receipt?.outcome).toBe("unknown");
    expect(fx.patchCount()).toBe(0);
  }, 60_000);
});

describe("write-command absolute paths (Windows + spaces)", () => {
  it("accepts a Windows absolute executable at startup (strict parse, no child)", async () => {
    // P2 (review): the stdio transport spawns with `shell: false`, so the
    // colon, backslashes and spaces in
    // `C:\Program Files\nodejs\node.exe` need no shell interpolation.
    // `path.win32.isAbsolute` accepts this deterministically on any CI
    // platform; startup validation (not a parser copy) proves it, with an
    // injected inert factory so no child is ever constructed.
    const { env, dbPath } = tempEnv();
    const instanceId = await provisionCalendarInstance(dbPath);
    let writeChildren = 0;
    const started = await startServer({
      env: {
        ...env,
        COMPANION_ACTIONS_JSON: ENABLED_ACTIONS_JSON,
        [RESCHEDULE_WRITE_PROFILE_ENV]: "google-reschedule",
        [RESCHEDULE_WRITE_CONNECTOR_ENV]: JSON.stringify({
          command: "C:\\Program Files\\nodejs\\node.exe",
        }),
      },
      calendarBinding: {
        connectorInstanceId: instanceId,
        connector: fakeCalendarBinding(instanceId),
        selection: { calendarId: "primary", account: "ops@example" },
      },
      writeMcpTransportFactory: () => {
        writeChildren += 1;
        throw new Error("no write call expected in this parse probe");
      },
      drainMs: 50,
    });
    servers.push(started);
    expect(writeChildren).toBe(0);
    expect([...(started.toolBroker?.toolNames() ?? [])]).toContain(
      "calendar.reschedule",
    );
  });

  it("rejects a shell command line as the command before any DB side effect", async () => {
    // The hint command is ONE executable (args stay an array): command
    // lines, interpolation and quoting never pass, even though `shell:false`
    // means this is a shape rejection, not a shell-injection claim.
    for (const command of [
      "node foo; rm -rf /",
      "node $(evil)",
      "node `evil`",
      "node --flag | tee",
    ]) {
      const { env, dbPath } = tempEnv();
      const instanceId = randomUUID();
      await expect(
        startServer({
          env: {
            ...env,
            COMPANION_ACTIONS_JSON: ENABLED_ACTIONS_JSON,
            [RESCHEDULE_WRITE_PROFILE_ENV]: "google-reschedule",
            [RESCHEDULE_WRITE_CONNECTOR_ENV]: JSON.stringify({ command }),
          },
          calendarBinding: {
            connectorInstanceId: instanceId,
            connector: fakeCalendarBinding(instanceId),
            selection: { calendarId: "primary", account: "ops@example" },
          },
          writeMcpTransportFactory: () => {
            throw new Error("must never be constructed on invalid hints");
          },
          drainMs: 50,
        }),
      ).rejects.toThrow(/connector hints are invalid/);
      expect(existsSync(dbPath)).toBe(false);
    }
  });

  it("spawns the production stdio transport from a space-containing absolute binary path", async () => {
    // Throwaway copy of the REAL current binary into `dir with space`: the
    // strict parser accepts the spaced absolute path, the built dedicated
    // config passes the PRODUCTION factory guard, and a real child spawns
    // from that path (no fixture, no Google calls). On Windows CI this is a
    // genuine `C:\...\dir with space\node.exe` invocation.
    const dir = mkdtempSync(join(tmpdir(), "companion-write-space-"));
    tempDirs.push(dir);
    const spacedDir = join(dir, "dir with space");
    mkdirSync(spacedDir, { recursive: true });
    const dest = join(
      spacedDir,
      process.execPath.endsWith(".exe") ? "node.exe" : "node",
    );
    copyFileSync(process.execPath, dest);
    if (process.platform !== "win32") {
      chmodSync(dest, 0o755);
    }
    const hint = parseRescheduleWriteConnectorHint(
      JSON.stringify({
        command: dest,
        envAllowlist: [...STDIO_IMPLICIT_ENV_VARS],
      }),
    );
    expect(hint.command).toBe(dest);
    const built = buildRescheduleWriteConnectorConfig({
      connectorInstanceId: "preflight",
      hint,
    });
    expect(() => defaultTransportFactory(built)).not.toThrow();
    const spawned = new StdioClientTransport({
      command: dest,
      args: ["--version"],
      env: {},
      stderr: "pipe",
    });
    await spawned.start();
    await spawned.close();
  }, 30_000);
});
