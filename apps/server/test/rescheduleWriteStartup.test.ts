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
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalKey, normalizeEvent } from "@companion/connector-calendar";
import {
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

/** Complete frozen snapshot for the inherited allowlist: live values when
 * inheritable, else a fixed stand-in (minimal CI envs may lack e.g. USER;
 * shell-function exports are never inheritable). Mirrors the production
 * freeze without re-pinning SDK defaults. */
function completeFrozenEnv(
  extra: Record<string, string> = {},
): Record<string, string> {
  const frozen: Record<string, string> = {};
  for (const name of STDIO_IMPLICIT_ENV_VARS) {
    const live = process.env[name];
    frozen[name] =
      live !== undefined && !live.startsWith("()") ? live : `frozen-${name}`;
  }
  return { ...frozen, ...extra };
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
    // Unknown proposals resolve before the per-tool gate (404, no mutation);
    // the owned-disabled 409 boundary lives in createApprovalGate.test.ts.
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("action_execution_disabled");
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

async function provisionCalendarInstance(
  dbPath: string,
  account = "ops@example",
): Promise<string> {
  const handle = openKernelDatabase(dbPath);
  try {
    await migrateKernelDatabase({
      db: handle.raw,
      backupDir: join(dbPath, "..", "backups"),
    });
    return createReferenceManager(handle.raw).ensureCalendarConnectorInstance(
      "calendar-fake-binding",
      "primary",
      { account },
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

/**
 * Stage a reschedule proposal against the live-shaped snapshot (pre-start).
 * An explicit `targetAccount` is stored in the durable target (the
 * selection-derived account the provider gate sees); omitted keeps the
 * legacy account-free target.
 */
async function seedStagedProposal(
  dbPath: string,
  instanceId: string,
  targetAccount?: string,
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
          ...(targetAccount !== undefined ? { account: targetAccount } : {}),
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

describe("normal-startup write-child env (frozen snapshot, no seam)", () => {
  it("spawns the write child from the frozen startServer env, not live process.env", async () => {
    // Host PR30 finding 4282825247: an embedding passes `M5_RESCHEDULE_*`
    // credential values via `startServer({ env })`. The lazy write child must
    // inherit THAT frozen snapshot — never a later live read of
    // `process.env`. No injected transport seam: the production default
    // factory path spawns a probe child whose allowlisted env is dumped to
    // the workspace-owned fixture store and read back here.
    const { env, dbPath } = tempEnv();
    const fx = await startGoogleFixture();
    const instanceId = await provisionCalendarInstance(dbPath);
    const { sessionId, proposalId, hash } = await seedStagedProposal(
      dbPath,
      instanceId,
    );
    const store = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "test-results",
      "write-child-env-probe",
    );
    mkdirSync(store, { recursive: true });
    const probePath = join(store, "probe.mjs");
    const outPath = join(store, `env-dump-${randomUUID()}.json`);
    writeFileSync(
      probePath,
      'import { writeFileSync } from "node:fs";\n' +
        "writeFileSync(process.env.PROBE_OUT, JSON.stringify({ marker: process.env.M5_RESCHEDULE_SMOKE_MARKER ?? null }));\n",
    );
    const previous = process.env.M5_RESCHEDULE_SMOKE_MARKER;
    delete process.env.M5_RESCHEDULE_SMOKE_MARKER;
    try {
      const started = await startServer({
        env: {
          ...env,
          ...completeFrozenEnv(),
          COMPANION_ACTIONS_JSON: ENABLED_ACTIONS_JSON,
          [RESCHEDULE_WRITE_PROFILE_ENV]: "google-reschedule",
          [RESCHEDULE_WRITE_CONNECTOR_ENV]: JSON.stringify({
            command: "node",
            args: [probePath],
            envAllowlist: [
              ...STDIO_IMPLICIT_ENV_VARS,
              "PROBE_OUT",
              "M5_RESCHEDULE_SMOKE_MARKER",
            ],
          }),
          PROBE_OUT: outPath,
          M5_RESCHEDULE_SMOKE_MARKER: "frozen-snapshot-value",
        },
        calendarBinding: {
          connectorInstanceId: instanceId,
          connector: fixtureBackedCalendarBinding(instanceId, () => fx.base),
          selection: { calendarId: "primary", account: "ops@example" },
        },
        drainMs: 50,
      });
      servers.push(started);
      await approveProposalHttp(started.port, sessionId, proposalId, hash);
      const deadline = Date.now() + 25_000;
      for (;;) {
        if (existsSync(outPath)) break;
        if (Date.now() > deadline) {
          throw new Error("write child never spawned");
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const dump = JSON.parse(readFileSync(outPath, "utf8")) as {
        marker: unknown;
      };
      // The child saw the startServer snapshot value although the live
      // process env held no such entry at spawn time.
      expect(dump.marker).toBe("frozen-snapshot-value");
      // The probe is not an MCP server, so the execution itself cannot
      // succeed — but the spawn (the env under test) happened first, and no
      // conditional PATCH was ever dispatched.
      const view = await waitForTerminalReceipt(
        started.port,
        sessionId,
        proposalId,
      );
      expect(view.receipt).not.toBeNull();
      expect(fx.patchCount()).toBe(0);
    } finally {
      if (previous === undefined) {
        delete process.env.M5_RESCHEDULE_SMOKE_MARKER;
      } else {
        process.env.M5_RESCHEDULE_SMOKE_MARKER = previous;
      }
      rmSync(outPath, { force: true });
      rmSync(probePath, { force: true });
    }
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
    // Production factory path with a COMPLETE frozen snapshot (this harness
    // env may lack genuinely-optional Unix names like USER/SHELL/LOGNAME, so
    // the live `process.env` cannot serve as the snapshot here; the factory
    // under test is identical — `defaultTransportFactory` delegates to
    // `startupEnvTransportFactory(process.env)`).
    const { startupEnvTransportFactory } = await import(
      "@companion/connector-mcp"
    );
    expect(() =>
      startupEnvTransportFactory(completeFrozenEnv())(built),
    ).not.toThrow();
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

// ---------------------------------------------------------------------------
// All-day → timed conversion pipeline: all-day snapshot, TIMED stage,
// local-fixture approve, exactly ONE conditional PATCH with `date: null`
// clearing, timed readback into a new snapshot/rN while the old all-day rN
// stays valid. Stager/canonical/revision constraints are NOT loosened: the
// staged request carries both timed instants (15:00-16:00+09:00), the
// original all-day snapshot + expected revision are preserved, and no real
// (non-fixture) approval ever happens. No live Google, no OAuth.
// ---------------------------------------------------------------------------

const ALLDAY_EVENT_ID = "evt-allday-1";
/** Real opaque canonical key over (instance, calendar, event) — computed per run. */
async function alldayCanonicalKey(instanceId: string): Promise<string> {
  return canonicalKey(instanceId, E2E_CALENDAR_ID, ALLDAY_EVENT_ID);
}
const ALLDAY_ETAG_V1 = '"etag-allday-1"';
const ALLDAY_ETAG_V2 = '"etag-allday-2"';
const ALLDAY_START_DATE = "2026-10-16";
const ALLDAY_END_DATE = "2026-10-17";
const ALLDAY_START_NEW = "2026-10-16T15:00:00+09:00";
const ALLDAY_END_NEW = "2026-10-16T16:00:00+09:00";
// Real readonly normalization canonicalizes provider `dateTime` bounds to
// UTC: these are the exact `canonicalUtcIso` images of the requested bounds
// above (never hand-tailored to the request — the binding below derives
// them through the REAL `normalizeEvent`, and these constants only assert
// the stored read-back result).
const ALLDAY_START_UTC = "2026-10-16T06:00:00.000Z";
const ALLDAY_END_UTC = "2026-10-16T07:00:00.000Z";

/** Local Google-shaped fixture serving an ALL-DAY event until converted. */
async function startGoogleFixtureAllDay(): Promise<
  E2EFixtureState & {
    lastPatchBody: () => Record<string, unknown> | undefined;
    eventEnd: () => string;
  }
> {
  let etag = ALLDAY_ETAG_V1;
  let mode: "allDay" | "timed" = "allDay";
  const eventStart = ALLDAY_START_NEW;
  const eventEnd = ALLDAY_END_NEW;
  let patchCount = 0;
  let lastIfMatch: string | undefined;
  let lastBodyKeys: string[] = [];
  let lastPatchBody: Record<string, unknown> | undefined;
  fixture = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const match = /^\/calendar\/v3\/calendars\/([^/]+)\/events\/([^/]+)$/.exec(
      url.pathname,
    );
    if (match === null || match[2] !== ALLDAY_EVENT_ID) {
      res.writeHead(404).end();
      return;
    }
    if (req.method === "GET") {
      const body =
        mode === "allDay"
          ? {
              id: ALLDAY_EVENT_ID,
              calendarId: E2E_CALENDAR_ID,
              etag,
              status: "confirmed",
              summary: "Fixture Event",
              start: { date: ALLDAY_START_DATE },
              end: { date: ALLDAY_END_DATE },
            }
          : {
              id: ALLDAY_EVENT_ID,
              calendarId: E2E_CALENDAR_ID,
              etag,
              status: "confirmed",
              summary: "Fixture Event",
              start: { dateTime: eventStart },
              end: { dateTime: eventEnd },
            };
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(body));
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
          lastPatchBody = parsed;
          if (req.headers["if-match"] !== etag) {
            res.writeHead(412).end();
            return;
          }
          // All-day → timed conversion MUST clear the stale `date` field
          // (`date: null` + new `dateTime`, the real provider contract).
          const s = parsed.start as { date?: unknown; dateTime?: unknown };
          const e = parsed.end as { date?: unknown; dateTime?: unknown };
          if (
            s?.date !== null ||
            e?.date !== null ||
            s?.dateTime !== ALLDAY_START_NEW ||
            e?.dateTime !== ALLDAY_END_NEW
          ) {
            res.writeHead(400).end();
            return;
          }
          mode = "timed";
          etag = ALLDAY_ETAG_V2;
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
    lastPatchBody: () => lastPatchBody,
    eventStart: () => eventStart,
    eventEnd: () => eventEnd,
    setEtag: (next: string) => {
      etag = next;
    },
  };
}

/**
 * Injected READ binding backing BOTH the strategy preflight (all-day
 * observation) AND its §18.7 readback (timed observation) from the live
 * loopback state. The provider-shaped GET body is decoded through the REAL
 * readonly `normalizeEvent` (UTC canonicalization, all-day flag, opaque
 * canonical key, etag revision basis) — never hand-built to match the
 * request — so the read-back carries the genuine upstream serialization.
 */
function fixtureBackedCalendarBindingAllDay(
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
        id?: unknown;
        calendarId?: unknown;
        etag?: unknown;
        status?: unknown;
        summary?: unknown;
        start?: { date?: unknown; dateTime?: unknown };
        end?: { date?: unknown; dateTime?: unknown };
      };
      let decoded: Awaited<ReturnType<typeof normalizeEvent>>;
      try {
        decoded = await normalizeEvent(
          {
            id: body.id,
            calendarId: target.calendarId,
            status: body.status,
            summary: body.summary,
            description: undefined,
            location: undefined,
            start: body.start,
            end: body.end,
            etag: body.etag,
          },
          { connectorInstanceId },
        );
      } catch {
        return { ok: false as const, code: "calendar_response_invalid" };
      }
      return {
        ok: true as const,
        event: decoded,
      };
    },
  };
}

function alldaySnapshotBodyJson(canonicalKeyValue: string): string {
  const text = calendarEventBodyText({
    canonicalKey: canonicalKeyValue,
    status: "confirmed",
    title: "Fixture Event",
    start: ALLDAY_START_DATE,
    end: ALLDAY_END_DATE,
    allDayEndExclusive: true,
    sourceRevision: ALLDAY_ETAG_V1,
    revisionBasis: "etag",
  } as const);
  return canonicalJsonString(SnapshotBodySchema.parse({ version: 1, text }));
}

/** Stage a TIMED reschedule against the stored ALL-DAY snapshot. */
async function seedStagedProposalAllDay(
  dbPath: string,
  instanceId: string,
): Promise<{
  sessionId: string;
  proposalId: string;
  hash: string;
  snapshotId: string;
  expectedRevision: string;
  canonicalKey: string;
}> {
  const handle = openKernelDatabase(dbPath);
  try {
    const repo = createKernelRepository(handle.raw, {
      actionProposals: { writeEnabled: true },
    });
    const canonicalKeyValue = await alldayCanonicalKey(instanceId);
    const resourceId = generateId();
    const snapshotId = generateId();
    const refId = generateId();
    handle.raw
      .prepare(
        "INSERT INTO resources (id, connector_instance_id, canonical_key, title, next_revision, created_at) VALUES (?, ?, ?, 'Fixture Event', 2, 1)",
      )
      .run(resourceId, instanceId, canonicalKeyValue);
    handle.raw
      .prepare(
        "INSERT INTO resource_snapshots (id, resource_id, revision, source_revision, content_hash, body_json, size_bytes, observed_at, created_at) VALUES (?, ?, 1, ?, 'hash@1', ?, 10, 1, 1)",
      )
      .run(
        snapshotId,
        resourceId,
        ALLDAY_ETAG_V1,
        alldaySnapshotBodyJson(canonicalKeyValue),
      );
    handle.raw
      .prepare(
        "INSERT INTO calendar_get_targets (canonical_key, target_json, updated_at) VALUES (?, ?, ?)",
      )
      .run(
        canonicalKeyValue,
        JSON.stringify({
          calendarId: E2E_CALENDAR_ID,
          eventId: ALLDAY_EVENT_ID,
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
    handle.raw
      .prepare("UPDATE sessions SET next_reference_ordinal = 2 WHERE id = ?")
      .run(sessionId);
    const posted = repo.postMessage(
      sessionId,
      { text: "reschedule please" },
      { key: randomUUID(), now: E2E_T0 },
    ).body;
    await repo.startRun(posted.run.id, { now: E2E_T0 + 1 });
    // TIMED request boundaries against the ALL-DAY snapshot: the stager
    // validates the request pair only (both instants), so source-class
    // conversion stages without loosening any canonical/revision rule.
    const staged = repo.actionProposalsStager?.stage(posted.run.id, {
      targetRefId: refId,
      start: ALLDAY_START_NEW,
      end: ALLDAY_END_NEW,
    });
    if (staged === undefined) {
      throw new Error("staging unavailable");
    }
    expect(staged.expectedRevision).toBe(ALLDAY_ETAG_V1);
    expect(staged.basedOnSnapshotId).toBe(snapshotId);
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
      snapshotId,
      expectedRevision: staged.expectedRevision,
      canonicalKey: canonicalKeyValue,
    };
  } finally {
    closeKernelDatabase(handle);
  }
}

describe("all-day → timed conversion pipeline (local fixture only)", () => {
  it("staged TIMED approve performs exactly ONE date-clearing PATCH; timed readback mints a new rN while the all-day rN stays valid", async () => {
    const { env, dbPath } = tempEnv();
    const fx = await startGoogleFixtureAllDay();
    const instanceId = await provisionCalendarInstance(dbPath);
    const { sessionId, proposalId, hash, snapshotId, expectedRevision } =
      await seedStagedProposalAllDay(dbPath, instanceId);
    expect(expectedRevision).toBe(ALLDAY_ETAG_V1);
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
        connector: fixtureBackedCalendarBindingAllDay(
          instanceId,
          () => fx.base,
        ),
        selection: { calendarId: "primary", account: "ops@example" },
      },
      writeMcpTransportFactory: testWriteTransportFactory(fx.base),
      writeTestIdentity: { ...FIXTURE_IDENTITY },
      drainMs: 50,
    });
    servers.push(started);
    // Local-fixture approval only (queued strategy run, no real approval).
    await approveProposalHttp(started.port, sessionId, proposalId, hash);
    const view = await waitForTerminalReceipt(
      started.port,
      sessionId,
      proposalId,
    );
    expect(view.markerCommitted).toBe(true);
    expect(view.receipt?.outcome).toBe("succeeded");
    // Exactly ONE conditional PATCH with the committed etag, start/end only,
    // carrying the `date: null` clearing contract for the conversion.
    expect(fx.patchCount()).toBe(1);
    expect(fx.lastIfMatch()).toBe(ALLDAY_ETAG_V1);
    expect(fx.lastBodyKeys()).toEqual(["end", "start"]);
    expect(fx.lastPatchBody()?.start).toEqual({
      date: null,
      dateTime: ALLDAY_START_NEW,
    });
    expect(fx.lastPatchBody()?.end).toEqual({
      date: null,
      dateTime: ALLDAY_END_NEW,
    });
    // Loopback readback is now timed with the rotated etag.
    expect(fx.eventStart()).toBe(ALLDAY_START_NEW);
    expect(fx.eventEnd()).toBe(ALLDAY_END_NEW);
    // Snapshot lineage: the ORIGINAL all-day snapshot is preserved as the
    // grant basis, r1 still resolves to it, and the timed readback minted a
    // NEW snapshot under a NEW rN.
    const handle = openKernelDatabase(dbPath);
    try {
      const proposal = handle.raw
        .prepare(
          "SELECT expected_revision, based_on_snapshot_id FROM action_proposals WHERE id = ?",
        )
        .get(proposalId) as
        | { expected_revision: string; based_on_snapshot_id: string }
        | undefined;
      expect(proposal?.expected_revision).toBe(ALLDAY_ETAG_V1);
      expect(proposal?.based_on_snapshot_id).toBe(snapshotId);
      const refs = handle.raw
        .prepare(
          `SELECT sr.ordinal AS ordinal, rs.body_json AS body_json
             FROM session_references sr
             JOIN resource_snapshots rs ON rs.id = sr.snapshot_id
            WHERE sr.session_id = ?
            ORDER BY sr.ordinal ASC`,
        )
        .all(sessionId) as Array<{ ordinal: number; body_json: string }>;
      expect(refs.length).toBeGreaterThanOrEqual(2);
      const first = refs[0] as { ordinal: number; body_json: string };
      expect(first.ordinal).toBe(1);
      const firstText = (
        SnapshotBodySchema.parse(JSON.parse(first.body_json)) as {
          text: string;
        }
      ).text;
      expect(JSON.parse(firstText)).toMatchObject({
        start: ALLDAY_START_DATE,
        end: ALLDAY_END_DATE,
        allDayEndExclusive: true,
      });
      const last = refs[refs.length - 1] as {
        ordinal: number;
        body_json: string;
      };
      expect(last.ordinal).toBeGreaterThan(1);
      const lastText = (
        SnapshotBodySchema.parse(JSON.parse(last.body_json)) as {
          text: string;
        }
      ).text;
      expect(JSON.parse(lastText)).toMatchObject({
        // Read-back bounds are the REAL normalized Google serialization
        // (canonical UTC), not the staged `+09:00` representation — the
        // strategy verified them as the same instant.
        start: ALLDAY_START_UTC,
        end: ALLDAY_END_UTC,
        allDayEndExclusive: false,
      });
    } finally {
      closeKernelDatabase(handle);
    }
  }, 60_000);
});

describe("injected calendar binding derives the write port from the active selection", () => {
  it("derivePort receives the injected selection and the full approval pipeline succeeds", async () => {
    // Fix 4291463481: `derivePort` must fire for the INJECTED binding (no
    // `calendarConfig`), carrying the injected selection — and the proof is
    // the FULL local pipeline (HTTP approve -> scheduler -> port.update ->
    // REAL fixture PATCH -> read-back -> terminal succeeded receipt), not a
    // mock echo.
    const { env, dbPath } = tempEnv();
    const fx = await startGoogleFixture();
    const instanceId = await provisionCalendarInstance(dbPath);
    const { sessionId, proposalId, hash } = await seedStagedProposal(
      dbPath,
      instanceId,
    );
    const seen: Array<{
      connectorInstanceId: string;
      calendarId: string;
      account?: string;
    }> = [];
    const started = await startServer({
      env: { ...env, COMPANION_ACTIONS_JSON: ENABLED_ACTIONS_JSON },
      calendarBinding: {
        connectorInstanceId: instanceId,
        connector: fixtureBackedCalendarBinding(instanceId, () => fx.base),
        selection: { calendarId: "primary", account: "ops@example" },
      },
      actionWriteBinding: {
        derivePort: (active) => {
          seen.push({ ...active });
          return {
            capability: {
              tool: "calendar.reschedule",
              editableFields: ["start", "end"],
              connectorInstanceId: active.connectorInstanceId,
              writeEnabled: true,
            },
            update: async (request) => {
              const response = await fetch(
                `${fx.base}/calendar/v3/calendars/${encodeURIComponent(request.target.calendarId)}/events/${encodeURIComponent(request.target.eventId)}`,
                {
                  method: "PATCH",
                  headers: {
                    "content-type": "application/json",
                    "if-match": request.grant.expectedRevision ?? "",
                  },
                  body: JSON.stringify({
                    start: { dateTime: request.start },
                    end: { dateTime: request.end },
                  }),
                },
              );
              if (!response.ok) return { status: "unknown" as const };
              return { status: "succeeded" as const };
            },
          };
        },
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
    expect(view.markerCommitted).toBe(true);
    expect(view.receipt?.outcome).toBe("succeeded");
    // derivePort fired exactly once with the INJECTED selection.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      connectorInstanceId: instanceId,
      calendarId: "primary",
      account: "ops@example",
    });
    // Exactly ONE conditional PATCH with the committed etag moved the event.
    expect(fx.patchCount()).toBe(1);
    expect(fx.lastIfMatch()).toBe(E2E_ETAG_V1);
    expect(fx.eventStart()).toBe(E2E_START_NEW);
  }, 60_000);
});

describe("canonical write identity is validated before any DB side effect", () => {
  it("rejects overlong test identities even with an injected factory (no DB, no transport)", async () => {
    // Fix 4291463486: the canonical 128/64 identity rule runs in the pure
    // preflight build BEFORE any store touch — regardless of transport
    // factory. A 129-char name / 65-char version fails closed here.
    let factoryCalls = 0;
    for (const writeTestIdentity of [
      { expectedServerName: "n".repeat(129), version: "0.0.0-fixture.1" },
      { expectedServerName: "n".repeat(128), version: "v".repeat(65) },
    ]) {
      const { env, dbPath } = tempEnv();
      const instanceId = randomUUID();
      const helper = fixtureHelperPath();
      await expect(
        startServer({
          env: {
            ...env,
            COMPANION_ACTIONS_JSON: ENABLED_ACTIONS_JSON,
            [RESCHEDULE_WRITE_PROFILE_ENV]: "google-reschedule",
            [RESCHEDULE_WRITE_CONNECTOR_ENV]: e2eConnectorHintJson(helper),
          },
          calendarBinding: {
            connectorInstanceId: instanceId,
            connector: fakeCalendarBinding(instanceId),
            selection: { calendarId: "primary", account: "ops@example" },
          },
          writeMcpTransportFactory: () => {
            factoryCalls += 1;
            throw new Error("must never be constructed on invalid identity");
          },
          writeTestIdentity,
          drainMs: 50,
        }),
      ).rejects.toThrow(/reschedule write connector hints are invalid/);
      expect(existsSync(dbPath)).toBe(false);
    }
    expect(factoryCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Persisted-grant file-only operator wiring through the NORMAL startup path.
//
// The RECOMMENDED production wiring needs NO manual env secret copy: the
// write child allowlist carries ONLY the client file path, the persisted
// write-token file path, the exact account selector, and the readonly token
// path NAME (plus the mandatory SDK inherited names). No
// `M5_RESCHEDULE_CLIENT_*` / `M5_RESCHEDULE_REFRESH_TOKEN` /
// `M5_RESCHEDULE_GRANTED_SCOPE` / `M5_RESCHEDULE_ACCESS_TOKEN` value appears
// anywhere in the startup env — every test below asserts their absence up
// front, so a future regression that requires a secret copy fails here.
//
// Scope labels (honest): the write child here is the TRACKED contract-mirror
// fixture (`rescheduleFixtureServer.mjs --file-auth`), NOT the shipped fork
// CLI — the shipped production CLI ignores test endpoint overrides by design
// and always uses the immutable Google host, so it can never back a
// loopback pipeline (its proof is the auth-parse suite
// `reschedulePersistedGrant.test.ts` + the fork's own refresh tests, 0
// Google writes). What THIS suite proves, with NO injected transport seam
// (the default production `startupEnvTransportFactory` spawns from the
// FROZEN startup snapshot, so the allowlist and all three file-only values
// are really exercised): the fixture enforces the REAL credential contract
// against TEMP files only — account grammar, resolved write/readonly path
// collision BEFORE any file read, no partial-env fallthrough, client
// registration + per-account exact-scope grant, and the explicit-target
// account gate — while the loopback endpoint travels as a child argv
// parameter (test-only transport wiring, never a credential). Dropping any
// wiring variable, mutating the live env post-start, mismatching the
// configured account, hiding the custom readonly path, or colliding the
// grant with the readonly file all fail with NO successful action and NO
// patch. No live Google, no OAuth, fixture data only.
// ---------------------------------------------------------------------------

const FILE_ONLY_ACCOUNT = "proof-acct";
const FILE_ONLY_WRITE_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const FILE_ONLY_READONLY_ENV = "GOOGLE_CALENDAR_MCP_READONLY_TOKEN_PATH";

/**
 * Exact file-only operator hint: SDK defaults + the 4 wiring names. The
 * loopback endpoint travels as argv (`--endpoint-base`, test-only transport
 * wiring); every credential travels via the frozen-env allowlist exactly
 * like production. `extraArgs`/`allowlist` overrides exist ONLY for the
 * negative startup cases below.
 */
function fileOnlyConnectorHintJson(
  helper: string,
  endpointBase: string,
  overrides: {
    readonly extraArgs?: readonly string[];
    readonly allowlist?: readonly string[];
  } = {},
): string {
  return JSON.stringify({
    command: "node",
    args: [
      helper,
      "--endpoint-base",
      endpointBase,
      "--file-auth",
      ...(overrides.extraArgs ?? []),
    ],
    envAllowlist: overrides.allowlist ?? [
      ...STDIO_IMPLICIT_ENV_VARS,
      "GOOGLE_OAUTH_CREDENTIALS",
      "M5_RESCHEDULE_WRITE_TOKEN_PATH",
      "M5_RESCHEDULE_ACCOUNT",
      FILE_ONLY_READONLY_ENV,
    ],
  });
}

function writeFileOnlyOperatorFiles(
  dir: string,
  account = FILE_ONLY_ACCOUNT,
  tokenName = "write-tokens.json",
): {
  clientFile: string;
  tokenFile: string;
} {
  const clientFile = join(dir, "gcp-oauth.keys.json");
  writeFileSync(
    clientFile,
    JSON.stringify({
      client_id: "file-only-proof-client",
      client_secret: "file-only-proof-secret",
      redirect_uris: ["http://localhost:3000/oauth2callback"],
    }),
  );
  // Well-formed exact-scope persisted grant for the account (the production
  // file format `{ [account]: { refresh_token, scope, ... } }`). The
  // file-auth fixture child READS and validates this (account, scope,
  // collision) — the harness itself never copies, mints, or rewrites it.
  const tokenFile = join(dir, tokenName);
  writeFileSync(
    tokenFile,
    JSON.stringify({
      [account]: {
        refresh_token: "file-only-proof-refresh",
        scope: FILE_ONLY_WRITE_SCOPE,
        access_token: "file-only-proof-access",
        expiry_date: Date.now() + 3_600_000,
      },
    }),
  );
  return { clientFile, tokenFile };
}

/** Assert the file-only env carries paths/selectors only — never secrets. */
function expectNoSecretCredentialValues(env: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(env)) {
    expect(key).not.toBe("M5_RESCHEDULE_CLIENT_ID");
    expect(key).not.toBe("M5_RESCHEDULE_CLIENT_SECRET");
    expect(key).not.toBe("M5_RESCHEDULE_REFRESH_TOKEN");
    expect(key).not.toBe("M5_RESCHEDULE_GRANTED_SCOPE");
    expect(key).not.toBe("M5_RESCHEDULE_ACCESS_TOKEN");
  }
}

describe("persisted-grant file-only operator wiring (normal startup, default factory)", () => {
  it("staged approve performs exactly ONE conditional PATCH and lands a verified succeeded receipt with zero secret values in env", async () => {
    const { env, dbPath } = tempEnv();
    const fx = await startGoogleFixture();
    // The configured write account EQUALS the active selection account
    // (fork `^[a-z0-9_-]{1,64}$` grammar on both sides): the documented
    // usable configuration, not a falsified mismatch.
    const instanceId = await provisionCalendarInstance(
      dbPath,
      FILE_ONLY_ACCOUNT,
    );
    const { sessionId, proposalId, hash } = await seedStagedProposal(
      dbPath,
      instanceId,
      FILE_ONLY_ACCOUNT,
    );
    const dir = mkdtempSync(join(tmpdir(), "companion-write-file-only-"));
    tempDirs.push(dir);
    const { clientFile, tokenFile } = writeFileOnlyOperatorFiles(dir);
    const grantBefore = readFileSync(tokenFile, "utf-8");
    // Distinct custom readonly path (never created): proves the host forwards
    // the visibility without reading, and the collision guard passes.
    const readonlyFile = join(dir, "readonly-tokens.json");
    const helper = fixtureHelperPath();
    const startupEnv: NodeJS.ProcessEnv = {
      ...env,
      ...completeFrozenEnv(),
      COMPANION_ACTIONS_JSON: ENABLED_ACTIONS_JSON,
      [RESCHEDULE_WRITE_PROFILE_ENV]: "google-reschedule",
      [RESCHEDULE_WRITE_CONNECTOR_ENV]: fileOnlyConnectorHintJson(
        helper,
        fx.base,
      ),
      M5_RESCHEDULE_ACCOUNT: FILE_ONLY_ACCOUNT,
      M5_RESCHEDULE_WRITE_TOKEN_PATH: tokenFile,
      GOOGLE_OAUTH_CREDENTIALS: clientFile,
      [FILE_ONLY_READONLY_ENV]: readonlyFile,
    };
    // File-only proof: no secret-carrying write-credential value may appear
    // in the startup env the profile freezes and the child inherits.
    expectNoSecretCredentialValues(startupEnv);
    // NORMAL startup path: NO injected transport factory — the default
    // production `startupEnvTransportFactory` spawns the child from the
    // frozen snapshot under the allowlist above. `writeTestIdentity` only
    // permits the TRACKED fixture identity (never production pin weakening:
    // options-injected, never env).
    const started = await startServer({
      env: startupEnv,
      calendarBinding: {
        connectorInstanceId: instanceId,
        connector: fixtureBackedCalendarBinding(instanceId, () => fx.base),
        selection: { calendarId: "primary", account: FILE_ONLY_ACCOUNT },
      },
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
    // The harness never touches the persisted grant: byte-identical, and the
    // readonly path was never created or read.
    expect(readFileSync(tokenFile, "utf-8")).toBe(grantBefore);
    expect(existsSync(readonlyFile)).toBe(false);
  }, 60_000);

  it.each([
    "M5_RESCHEDULE_ACCOUNT",
    "M5_RESCHEDULE_WRITE_TOKEN_PATH",
    "GOOGLE_OAUTH_CREDENTIALS",
  ])(
    "omitting %s from the frozen startup env yields NO successful action and NO patch",
    async (omitted) => {
      // Each omission removes one leg of the real host-to-child path (env
      // value, not just the allowlist): the file-auth child must refuse
      // BEFORE listening, so the execution cannot succeed and no PATCH is
      // ever dispatched. Grant files present stay byte-identical.
      const { env, dbPath } = tempEnv();
      const fx = await startGoogleFixture();
      const instanceId = await provisionCalendarInstance(
        dbPath,
        FILE_ONLY_ACCOUNT,
      );
      const { sessionId, proposalId, hash } = await seedStagedProposal(
        dbPath,
        instanceId,
        FILE_ONLY_ACCOUNT,
      );
      const dir = mkdtempSync(join(tmpdir(), "companion-write-file-only-"));
      tempDirs.push(dir);
      const { clientFile, tokenFile } = writeFileOnlyOperatorFiles(dir);
      const grantBefore = readFileSync(tokenFile, "utf-8");
      const readonlyFile = join(dir, "readonly-tokens.json");
      const helper = fixtureHelperPath();
      const startupEnv: NodeJS.ProcessEnv = {
        ...env,
        ...completeFrozenEnv(),
        COMPANION_ACTIONS_JSON: ENABLED_ACTIONS_JSON,
        [RESCHEDULE_WRITE_PROFILE_ENV]: "google-reschedule",
        [RESCHEDULE_WRITE_CONNECTOR_ENV]: fileOnlyConnectorHintJson(
          helper,
          fx.base,
        ),
        M5_RESCHEDULE_ACCOUNT: FILE_ONLY_ACCOUNT,
        M5_RESCHEDULE_WRITE_TOKEN_PATH: tokenFile,
        GOOGLE_OAUTH_CREDENTIALS: clientFile,
        [FILE_ONLY_READONLY_ENV]: readonlyFile,
      };
      delete startupEnv[omitted];
      expectNoSecretCredentialValues(startupEnv);
      const started = await startServer({
        env: startupEnv,
        calendarBinding: {
          connectorInstanceId: instanceId,
          connector: fixtureBackedCalendarBinding(instanceId, () => fx.base),
          selection: { calendarId: "primary", account: FILE_ONLY_ACCOUNT },
        },
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
      expect(view.receipt?.outcome).not.toBe("succeeded");
      expect(fx.patchCount()).toBe(0);
      expect(readFileSync(tokenFile, "utf-8")).toBe(grantBefore);
    },
    60_000,
  );

  it("a post-start live-env mutation cannot change the frozen write-child values", async () => {
    // The lazy write child spawns on first approved execution — AFTER this
    // mutation — but the default factory closes over the FROZEN startup
    // snapshot. The alternative files are fully VALID for a DIFFERENT
    // account, so a live-env read would configure `other-acct` against the
    // `proof-acct` target and the provider gate would refuse (`failed`, no
    // patch). Success + exactly ONE patch therefore proves the frozen
    // values won — an outcome assertion, not a forwarded-value echo.
    const { env, dbPath } = tempEnv();
    const fx = await startGoogleFixture();
    const instanceId = await provisionCalendarInstance(
      dbPath,
      FILE_ONLY_ACCOUNT,
    );
    const { sessionId, proposalId, hash } = await seedStagedProposal(
      dbPath,
      instanceId,
      FILE_ONLY_ACCOUNT,
    );
    const dir = mkdtempSync(join(tmpdir(), "companion-write-file-only-"));
    tempDirs.push(dir);
    const { clientFile, tokenFile } = writeFileOnlyOperatorFiles(dir);
    const grantBefore = readFileSync(tokenFile, "utf-8");
    const altDir = mkdtempSync(join(tmpdir(), "companion-write-file-alt-"));
    tempDirs.push(altDir);
    const alt = writeFileOnlyOperatorFiles(altDir, "other-acct", "alt.json");
    const readonlyFile = join(dir, "readonly-tokens.json");
    const helper = fixtureHelperPath();
    const liveEnv: NodeJS.ProcessEnv = {
      ...env,
      ...completeFrozenEnv(),
      COMPANION_ACTIONS_JSON: ENABLED_ACTIONS_JSON,
      [RESCHEDULE_WRITE_PROFILE_ENV]: "google-reschedule",
      [RESCHEDULE_WRITE_CONNECTOR_ENV]: fileOnlyConnectorHintJson(
        helper,
        fx.base,
      ),
      M5_RESCHEDULE_ACCOUNT: FILE_ONLY_ACCOUNT,
      M5_RESCHEDULE_WRITE_TOKEN_PATH: tokenFile,
      GOOGLE_OAUTH_CREDENTIALS: clientFile,
      [FILE_ONLY_READONLY_ENV]: readonlyFile,
    };
    expectNoSecretCredentialValues(liveEnv);
    const pending = startServer({
      env: liveEnv,
      calendarBinding: {
        connectorInstanceId: instanceId,
        connector: fixtureBackedCalendarBinding(instanceId, () => fx.base),
        selection: { calendarId: "primary", account: FILE_ONLY_ACCOUNT },
      },
      writeTestIdentity: { ...FIXTURE_IDENTITY },
      drainMs: 50,
    });
    // Mutate the SAME object synchronously after the call: the frozen
    // snapshot was already captured, so the child must never see these.
    liveEnv.M5_RESCHEDULE_ACCOUNT = "other-acct";
    liveEnv.M5_RESCHEDULE_WRITE_TOKEN_PATH = alt.tokenFile;
    liveEnv.GOOGLE_OAUTH_CREDENTIALS = alt.clientFile;
    const started = await pending;
    servers.push(started);
    await approveProposalHttp(started.port, sessionId, proposalId, hash);
    const view = await waitForTerminalReceipt(
      started.port,
      sessionId,
      proposalId,
    );
    expect(view.markerCommitted).toBe(true);
    expect(view.receipt?.outcome).toBe("succeeded");
    expect(fx.patchCount()).toBe(1);
    expect(fx.lastIfMatch()).toBe(E2E_ETAG_V1);
    // Frozen values won: the original grant is untouched and the
    // never-configured alternative files were never read or refreshed.
    expect(readFileSync(tokenFile, "utf-8")).toBe(grantBefore);
  }, 60_000);

  it("a configured write account mismatching the active selection is rejected before any DB side effect", async () => {
    // A different configured account would make every approved action fail
    // the provider exact-account precheck AFTER the grant commit (late
    // failure behind green readiness): fail closed at startup instead, with
    // no DB file created.
    const { env, dbPath } = tempEnv();
    const instanceId = randomUUID();
    const helper = fixtureHelperPath();
    await expect(
      startServer({
        env: {
          ...env,
          ...completeFrozenEnv(),
          COMPANION_ACTIONS_JSON: ENABLED_ACTIONS_JSON,
          [RESCHEDULE_WRITE_PROFILE_ENV]: "google-reschedule",
          [RESCHEDULE_WRITE_CONNECTOR_ENV]: fileOnlyConnectorHintJson(
            helper,
            "http://127.0.0.1:9",
          ),
          M5_RESCHEDULE_ACCOUNT: "other-acct",
          M5_RESCHEDULE_WRITE_TOKEN_PATH: join("write-tokens.json"),
          GOOGLE_OAUTH_CREDENTIALS: join("gcp-oauth.keys.json"),
          [FILE_ONLY_READONLY_ENV]: join("readonly-tokens.json"),
        },
        calendarBinding: {
          connectorInstanceId: instanceId,
          connector: fakeCalendarBinding(instanceId),
          selection: { calendarId: "primary", account: FILE_ONLY_ACCOUNT },
        },
        writeTestIdentity: { ...FIXTURE_IDENTITY },
        drainMs: 50,
      }),
    ).rejects.toThrow(/does not match the active calendar selection/);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("a custom readonly path hidden from the allowlist is rejected before any DB side effect", async () => {
    // The fork resolves its collision guard against the CUSTOM readonly
    // path only when the child can see it: configured-but-unallowlisted is
    // a fail-closed host configuration (never a documentation-only rule).
    const { env, dbPath } = tempEnv();
    const instanceId = randomUUID();
    const helper = fixtureHelperPath();
    await expect(
      startServer({
        env: {
          ...env,
          ...completeFrozenEnv(),
          COMPANION_ACTIONS_JSON: ENABLED_ACTIONS_JSON,
          [RESCHEDULE_WRITE_PROFILE_ENV]: "google-reschedule",
          [RESCHEDULE_WRITE_CONNECTOR_ENV]: fileOnlyConnectorHintJson(
            helper,
            "http://127.0.0.1:9",
            {
              allowlist: [
                ...STDIO_IMPLICIT_ENV_VARS,
                "GOOGLE_OAUTH_CREDENTIALS",
                "M5_RESCHEDULE_WRITE_TOKEN_PATH",
                "M5_RESCHEDULE_ACCOUNT",
              ],
            },
          ),
          M5_RESCHEDULE_ACCOUNT: FILE_ONLY_ACCOUNT,
          M5_RESCHEDULE_WRITE_TOKEN_PATH: join("write-tokens.json"),
          GOOGLE_OAUTH_CREDENTIALS: join("gcp-oauth.keys.json"),
          [FILE_ONLY_READONLY_ENV]: join("readonly-tokens.json"),
        },
        calendarBinding: {
          connectorInstanceId: instanceId,
          connector: fakeCalendarBinding(instanceId),
          selection: { calendarId: "primary", account: FILE_ONLY_ACCOUNT },
        },
        writeTestIdentity: { ...FIXTURE_IDENTITY },
        drainMs: 50,
      }),
    ).rejects.toThrow(/env allowlist is invalid/);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("a write grant colliding with the custom readonly path is refused with NO patch and unchanged files", async () => {
    // Normal-host collision regression through the DEFAULT factory: the
    // write token path EQUALS the custom readonly path (temp files, never
    // real credentials). The child refuses BEFORE token load/refresh, so no
    // PATCH is dispatched and the grant file stays byte-identical.
    const { env, dbPath } = tempEnv();
    const fx = await startGoogleFixture();
    const instanceId = await provisionCalendarInstance(
      dbPath,
      FILE_ONLY_ACCOUNT,
    );
    const { sessionId, proposalId, hash } = await seedStagedProposal(
      dbPath,
      instanceId,
      FILE_ONLY_ACCOUNT,
    );
    const dir = mkdtempSync(join(tmpdir(), "companion-write-file-only-"));
    tempDirs.push(dir);
    const { clientFile, tokenFile } = writeFileOnlyOperatorFiles(dir);
    const grantBefore = readFileSync(tokenFile, "utf-8");
    const helper = fixtureHelperPath();
    const startupEnv: NodeJS.ProcessEnv = {
      ...env,
      ...completeFrozenEnv(),
      COMPANION_ACTIONS_JSON: ENABLED_ACTIONS_JSON,
      [RESCHEDULE_WRITE_PROFILE_ENV]: "google-reschedule",
      [RESCHEDULE_WRITE_CONNECTOR_ENV]: fileOnlyConnectorHintJson(
        helper,
        fx.base,
      ),
      M5_RESCHEDULE_ACCOUNT: FILE_ONLY_ACCOUNT,
      M5_RESCHEDULE_WRITE_TOKEN_PATH: tokenFile,
      GOOGLE_OAUTH_CREDENTIALS: clientFile,
      // Collision: the custom readonly path IS the write grant file.
      [FILE_ONLY_READONLY_ENV]: tokenFile,
    };
    expectNoSecretCredentialValues(startupEnv);
    const started = await startServer({
      env: startupEnv,
      calendarBinding: {
        connectorInstanceId: instanceId,
        connector: fixtureBackedCalendarBinding(instanceId, () => fx.base),
        selection: { calendarId: "primary", account: FILE_ONLY_ACCOUNT },
      },
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
    expect(view.receipt?.outcome).not.toBe("succeeded");
    expect(fx.patchCount()).toBe(0);
    expect(readFileSync(tokenFile, "utf-8")).toBe(grantBefore);
  }, 60_000);
});
