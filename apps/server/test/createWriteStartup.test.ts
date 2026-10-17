// M6 create-only normal startup regression (host-owned, default OFF).
//
// Permanent regression for the create-only start gate: a genuinely
// configured create path (explicit config triple optIn + writeEnabled +
// createEnabled together with an injected trusted create binding on the
// ACTIVE Calendar instance, no reschedule binding) starts normally — the
// write opt-in is satisfied WITHOUT a separate reschedule binding, and the
// approval route reaches the repository (no `action_execution_disabled`)
// where the per-tool kernel gates enforce the exact surface.
//
// Conversely, a bare `createEnabled` flag with NO usable create binding is
// not intent and stays fail-closed (`action_execution_disabled`), and
// disabling everything preserves the read-only defaults. Old
// reschedule-only compositions are untouched (see
// rescheduleWriteStartup.test.ts); this file asserts ONLY the create-only
// edges, with a dummy create caller that never touches any transport.

import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CalendarConnectorPort,
  CalendarCreateWritePort,
} from "@companion/kernel";
import {
  closeKernelDatabase,
  createReferenceManager,
  migrateKernelDatabase,
  openKernelDatabase,
} from "@companion/kernel";
import { afterEach, describe, expect, it } from "vitest";
import { type StartedServer, startServer } from "../src/bootstrap.js";

const servers: StartedServer[] = [];
let tempDirs: string[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server !== undefined) {
      await server.shutdown("test-teardown");
    }
  }
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

function tempEnv(actions: Record<string, boolean>): {
  env: NodeJS.ProcessEnv;
  dbPath: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "companion-create-only-"));
  tempDirs.push(dir);
  return {
    env: {
      COMPANION_DB_PATH: join(dir, "companion.sqlite"),
      COMPANION_HOST: "127.0.0.1",
      COMPANION_PORT: "0",
      COMPANION_TIME_ZONE: "UTC",
      COMPANION_LOG_LEVEL: "error",
      COMPANION_ACTIONS_JSON: JSON.stringify(actions),
    },
    dbPath: join(dir, "companion.sqlite"),
  };
}

function fakeCalendarBinding(
  connectorInstanceId: string,
): CalendarConnectorPort {
  return {
    connectorInstanceId,
    search: async () => ({ ok: false as const, code: "mcp_unavailable" }),
    get: async () => ({ ok: false as const, code: "mcp_unavailable" }),
  };
}

function seedInstance(dbPath: string): string {
  const handle = openKernelDatabase(dbPath);
  try {
    migrateKernelDatabase({
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

async function approveStatus(port: number): Promise<{
  status: number;
  body: string;
}> {
  const response = await fetch(
    `http://127.0.0.1:${port}/api/sessions/${randomUUID()}/proposals/${randomUUID()}/approve`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
        origin: `http://127.0.0.1:${port}`,
      },
      body: JSON.stringify({ proposalHash: "a".repeat(64) }),
    },
  );
  return { status: response.status, body: await response.text() };
}

describe("create-only startup composition", () => {
  it("starts with ONLY a create binding and the approval reaches the repository", async () => {
    const { env, dbPath } = tempEnv({
      optIn: true,
      writeEnabled: true,
      createEnabled: true,
    });
    const instanceId = seedInstance(dbPath);
    let inserts = 0;
    const started = await startServer({
      env,
      calendarBinding: {
        connectorInstanceId: instanceId,
        connector: fakeCalendarBinding(instanceId),
        selection: { calendarId: "primary", account: "ops@example" },
      },
      // No actionWriteBinding and no reschedule profile: create-only.
      actionCreateBinding: {
        derivePort: ({
          connectorInstanceId,
        }: {
          connectorInstanceId: string;
        }) => ({
          capability: {
            tool: "calendar.create" as const,
            editableFields: ["title", "start", "end"] as const,
            connectorInstanceId,
            writeEnabled: true as const,
          },
          insert: async () => {
            inserts += 1;
            return { status: "definite_failure" as const };
          },
        }),
      },
      drainMs: 50,
    });
    servers.push(started);
    // The create gate is open, so the approval is NOT refused by the HTTP
    // admission gate: unknown ids reach the repository (404), never the
    // 409 `action_execution_disabled` closed surface.
    const { status, body } = await approveStatus(started.port);
    expect(status).toBe(404);
    expect(body).not.toContain("action_execution_disabled");
    expect(inserts).toBe(0);
  });

  it("keeps a bare createEnabled flag with no binding fail-closed", async () => {
    const { env, dbPath } = tempEnv({
      optIn: true,
      writeEnabled: true,
      createEnabled: true,
    });
    const instanceId = seedInstance(dbPath);
    // No create binding at all: a lone flag is not intent — startup
    // refuses the incomplete opt-in BEFORE listen (never a silent
    // half-enabled surface).
    await expect(
      startServer({
        env,
        calendarBinding: {
          connectorInstanceId: instanceId,
          connector: fakeCalendarBinding(instanceId),
          selection: { calendarId: "primary", account: "ops@example" },
        },
        drainMs: 50,
      }),
    ).rejects.toThrow(/action write binding does not match/);
  });

  it("preserves read-only defaults when every gate is off", async () => {
    const { env, dbPath } = tempEnv({
      optIn: false,
      writeEnabled: false,
      createEnabled: false,
    });
    const instanceId = seedInstance(dbPath);
    const started = await startServer({
      env,
      calendarBinding: {
        connectorInstanceId: instanceId,
        connector: fakeCalendarBinding(instanceId),
        selection: { calendarId: "primary", account: "ops@example" },
      },
      drainMs: 50,
    });
    servers.push(started);
    // Unknown proposals resolve before the per-tool gate (404, never the
    // 409 disabled surface); owned-disabled 409s live in
    // createApprovalGate.test.ts.
    const { status, body } = await approveStatus(started.port);
    expect(status).toBe(404);
    expect(body).not.toContain("action_execution_disabled");
  });
});

describe("create binding shape fail-closed", () => {
  function validPort(instanceId: string): CalendarCreateWritePort {
    return {
      capability: {
        tool: "calendar.create" as const,
        editableFields: ["title", "start", "end"] as const,
        connectorInstanceId: instanceId,
        writeEnabled: true as const,
      },
      insert: async () => ({ status: "definite_failure" as const }),
    };
  }

  it("rejects a both-port-and-derive binding BEFORE any DB side effect", async () => {
    const { env, dbPath } = tempEnv({
      optIn: true,
      writeEnabled: true,
      createEnabled: true,
    });
    const instanceId = seedInstance(dbPath);
    // Fresh DB path: the shape is validatable from options alone, so the
    // incomplete opt-in must fail before ensureDbDir/open/migrations.
    const freshDir = mkdtempSync(join(tmpdir(), "companion-create-shape-"));
    tempDirs.push(freshDir);
    const freshDb = join(freshDir, "companion.sqlite");
    const freshEnv: NodeJS.ProcessEnv = {
      ...env,
      COMPANION_DB_PATH: freshDb,
    };
    await expect(
      startServer({
        env: freshEnv,
        calendarBinding: {
          connectorInstanceId: instanceId,
          connector: fakeCalendarBinding(instanceId),
          selection: { calendarId: "primary", account: "ops@example" },
        },
        actionCreateBinding: {
          port: validPort(instanceId),
          derivePort: () => validPort(instanceId),
        },
        drainMs: 50,
      }),
    ).rejects.toThrow(/action create binding does not match/);
    expect(existsSync(freshDb)).toBe(false);
  });

  it("rejects a neither-port-nor-derive binding BEFORE any DB side effect", async () => {
    const { env } = tempEnv({
      optIn: true,
      writeEnabled: true,
      createEnabled: true,
    });
    const freshDir = mkdtempSync(join(tmpdir(), "companion-create-shape-"));
    tempDirs.push(freshDir);
    const freshDb = join(freshDir, "companion.sqlite");
    await expect(
      startServer({
        env: { ...env, COMPANION_DB_PATH: freshDb },
        drainMs: 50,
        actionCreateBinding: {},
      }),
    ).rejects.toThrow(/action create binding does not match/);
    expect(existsSync(freshDb)).toBe(false);
  });

  it("rejects a derivePort that resolves to null BEFORE listen", async () => {
    const { env, dbPath } = tempEnv({
      optIn: true,
      writeEnabled: true,
      createEnabled: true,
    });
    const instanceId = seedInstance(dbPath);
    await expect(
      startServer({
        env,
        calendarBinding: {
          connectorInstanceId: instanceId,
          connector: fakeCalendarBinding(instanceId),
          selection: { calendarId: "primary", account: "ops@example" },
        },
        actionCreateBinding: {
          derivePort: () => null as unknown as CalendarCreateWritePort,
        },
        drainMs: 50,
      }),
    ).rejects.toThrow(/action create binding does not match/);
  });

  it("ignores an invalid binding when the create gate is off (no new opt requirement)", async () => {
    const { env, dbPath } = tempEnv({
      optIn: false,
      writeEnabled: false,
      createEnabled: false,
    });
    const instanceId = seedInstance(dbPath);
    let derived = false;
    const started = await startServer({
      env,
      calendarBinding: {
        connectorInstanceId: instanceId,
        connector: fakeCalendarBinding(instanceId),
        selection: { calendarId: "primary", account: "ops@example" },
      },
      // Both/neither shape with the gate off: never adopted, never
      // derived, never read — startup stays on the read-only defaults.
      actionCreateBinding: {
        port: validPort(instanceId),
        derivePort: () => {
          derived = true;
          return validPort(instanceId);
        },
      },
      drainMs: 50,
    });
    servers.push(started);
    expect(derived).toBe(false);
    // Unknown proposals resolve before the per-tool gate (404, no mutation).
    const { status, body } = await approveStatus(started.port);
    expect(status).toBe(404);
    expect(body).not.toContain("action_execution_disabled");
  });
});
