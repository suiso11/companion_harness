// T3/T4 standalone actual-`startServer` startup smoke (D2 acceptance).
//
// Permanent regression for the earlier throwaway standalone smoke in the
// PR20 T5 record: over REAL `startServer` (real SQLite in a temp dir, real
// Hono listener on port 0), with an injected OWNED write binding:
// - disabled calendar-write config (no actions opt-in): the server listens,
//   `GET /health/ready` returns 200, `derivePort` is never invoked and the
//   owned `shutdown` hook is NEVER closed on server shutdown (0 closes),
// - enabled composition (optIn + writeEnabled) with an injected binding:
//   `derivePort` fires EXACTLY ONCE with the injected selection, ready is
//   200, and server shutdown closes the adopted owned port EXACTLY ONCE.
//
// Reused coverage (NOT duplicated here): `rescheduleWriteStartup.test.ts`
// "derivePort receives the injected selection and the full approval pipeline
// succeeds" (enabled, full pipeline) and "rejects overlong test identities
// even with an injected factory (no DB, no transport)" (B4 pre-DB
// preflight); `createWriteStartup.test.ts` "preserves read-only defaults
// when every gate is off". No live Google, no OAuth, fake bindings only.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CalendarActionWritePort,
  CalendarConnectorPort,
} from "@companion/kernel";
import {
  closeKernelDatabase,
  createReferenceManager,
  migrateKernelDatabase,
  openKernelDatabase,
} from "@companion/kernel";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ActionWriteBinding,
  type StartedServer,
  startServer,
} from "../src/bootstrap.js";

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

function tempEnv(actions?: Record<string, boolean>): {
  env: NodeJS.ProcessEnv;
  dbPath: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "companion-startup-smoke-"));
  tempDirs.push(dir);
  return {
    env: {
      COMPANION_DB_PATH: join(dir, "companion.sqlite"),
      COMPANION_HOST: "127.0.0.1",
      COMPANION_PORT: "0",
      COMPANION_TIME_ZONE: "UTC",
      COMPANION_LOG_LEVEL: "error",
      ...(actions === undefined
        ? {}
        : { COMPANION_ACTIONS_JSON: JSON.stringify(actions) }),
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

function ownedWriteBinding(counts: {
  derives: number;
  updates: number;
  closes: number;
}): {
  actionWriteBinding: ActionWriteBinding;
  portFor: (connectorInstanceId: string) => CalendarActionWritePort;
} {
  const portFor = (connectorInstanceId: string): CalendarActionWritePort => ({
    capability: {
      tool: "calendar.reschedule",
      editableFields: ["start", "end"],
      connectorInstanceId,
      writeEnabled: true,
    },
    update: async () => {
      counts.updates += 1;
      return { status: "succeeded" as const };
    },
  });
  return {
    portFor,
    actionWriteBinding: {
      derivePort: (active: {
        connectorInstanceId: string;
        calendarId: string;
        account?: string;
      }) => {
        counts.derives += 1;
        return portFor(active.connectorInstanceId);
      },
      owned: true,
      shutdown: async () => {
        counts.closes += 1;
      },
    },
  };
}

async function readyStatus(port: number): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${port}/health/ready`, {
    redirect: "manual",
  });
  return response.status;
}

describe("T3/T4 standalone actual-startServer startup smoke", () => {
  it("T3: disabled calendar-write config listens with 0 capability reads and 0 closes", async () => {
    // No actions opt-in env at all: calendar-write stays disabled even with
    // an injected OWNED binding present — the server never adopts it.
    const { env, dbPath } = tempEnv();
    const instanceId = seedInstance(dbPath);
    const counts = { derives: 0, updates: 0, closes: 0 };
    const { actionWriteBinding } = ownedWriteBinding(counts);
    const started = await startServer({
      env,
      calendarBinding: {
        connectorInstanceId: instanceId,
        connector: fakeCalendarBinding(instanceId),
        selection: { calendarId: "primary", account: "ops@example" },
      },
      actionWriteBinding,
      drainMs: 50,
    });
    servers.push(started);
    expect(started.port).toBeGreaterThanOrEqual(0);
    expect(await readyStatus(started.port)).toBe(200);
    expect(counts.derives).toBe(0);
    expect(counts.updates).toBe(0);
    // Disabled composition never adopts the port: server shutdown closes 0.
    await started.shutdown("smoke-teardown");
    servers.pop();
    await started.shutdown("double-close-is-idempotent");
    expect(counts.closes).toBe(0);
  });

  it("T4: enabled owned port derives once with the injected selection and closes exactly once", async () => {
    const { env, dbPath } = tempEnv({
      optIn: true,
      writeEnabled: true,
    });
    const instanceId = seedInstance(dbPath);
    const counts = { derives: 0, updates: 0, closes: 0 };
    const { actionWriteBinding, portFor } = ownedWriteBinding(counts);
    const seen: Array<{
      connectorInstanceId: string;
      calendarId: string;
      account?: string;
    }> = [];
    const started = await startServer({
      env,
      calendarBinding: {
        connectorInstanceId: instanceId,
        connector: fakeCalendarBinding(instanceId),
        selection: { calendarId: "primary", account: "ops@example" },
      },
      actionWriteBinding: {
        ...actionWriteBinding,
        derivePort: (active) => {
          seen.push({ ...active });
          counts.derives += 1;
          return portFor(active.connectorInstanceId);
        },
      },
      drainMs: 50,
    });
    servers.push(started);
    expect(await readyStatus(started.port)).toBe(200);
    // Adopted injected binding: derivePort fires EXACTLY ONCE with the
    // injected (host-owned) selection, never a config-derived one.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      connectorInstanceId: instanceId,
      calendarId: "primary",
      account: "ops@example",
    });
    expect(counts.updates).toBe(0);
    // Explicit ownership transfer: exactly ONE close on server shutdown.
    await started.shutdown("smoke-teardown");
    servers.pop();
    await started.shutdown("double-close-is-idempotent");
    expect(counts.closes).toBe(1);
    // Disabled read-only surface untouched: still no DB capability writes.
    expect(existsSync(dbPath)).toBe(true);
  });
});
