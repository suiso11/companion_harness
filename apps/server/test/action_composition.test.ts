// C21 M5 Action composition tests (TRIPLE gate): config opt-in +
// writeEnabled + a dedicated trusted write binding on the ACTIVE Calendar
// instance. These are composition/fail-closed assertions only; they make no
// executed-verification claim for any wider suite.

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CALENDAR_RESCHEDULE_TOOL_NAME } from "@companion/contracts";
import {
  type CalendarActionWritePort,
  type CalendarConnectorPort,
  type CalendarWriteOutcome,
  closeKernelDatabase,
  createReferenceManager,
  migrateKernelDatabase,
  openKernelDatabase,
} from "@companion/kernel";
import { afterEach, describe, expect, it } from "vitest";
import { type StartedServer, startServer } from "../src/bootstrap.js";
import { createCollectingLogger } from "../src/logger.js";

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
  const dir = mkdtempSync(join(tmpdir(), "companion-actions-"));
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

/** Pre-provision the one owned Calendar instance so the fake write port can
 *  name the EXACT active instance id (fail-closed binding identity). */
async function provisionCalendarInstance(dbPath: string): Promise<string> {
  const handle = openKernelDatabase(dbPath);
  try {
    await migrateKernelDatabase({
      db: handle.raw,
      backupDir: join(dbPath, "..", "backups"),
    });
    return createReferenceManager(handle.raw).ensureCalendarConnectorInstance(
      "calendar-fake-binding",
      "cal-primary",
      { account: "ops@example" },
    ).id;
  } finally {
    closeKernelDatabase(handle);
  }
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

function fakeWritePort(
  connectorInstanceId: string,
  onUpdate?: () => void,
): CalendarActionWritePort {
  return {
    capability: {
      tool: CALENDAR_RESCHEDULE_TOOL_NAME,
      editableFields: ["start", "end"],
      connectorInstanceId,
      writeEnabled: true,
    },
    update: async (): Promise<CalendarWriteOutcome> => {
      onUpdate?.();
      return { status: "succeeded" };
    },
  };
}

const ENABLED_ACTIONS_JSON = JSON.stringify({
  optIn: true,
  writeEnabled: true,
});

async function approveProbe(
  started: StartedServer,
): Promise<{ status: number; body: string }> {
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
  return { status: response.status, body: await response.text() };
}

describe("C21 M5 Action triple-gated composition", () => {
  it("registers nothing when the config does not opt in (default disabled)", async () => {
    const { env, dbPath } = tempEnv();
    const instanceId = await provisionCalendarInstance(dbPath);
    let updates = 0;
    let closed = 0;
    let capabilityReads = 0;
    const inner = fakeWritePort(instanceId, () => {
      updates += 1;
    });
    const port: CalendarActionWritePort = {
      get capability() {
        capabilityReads += 1;
        return inner.capability;
      },
      update: inner.update,
    };
    const started = await startServer({
      env,
      calendarBinding: {
        connectorInstanceId: instanceId,
        connector: fakeCalendarBinding(instanceId),
        selection: { calendarId: "cal-primary", account: "ops@example" },
      },
      // Injected, but the config gates it off: never used, never closed.
      actionWriteBinding: {
        port,
        owned: true,
        shutdown: async () => {
          closed += 1;
        },
      },
      drainMs: 50,
    });
    servers.push(started);
    expect([...(started.toolBroker?.toolNames() ?? [])].sort()).toEqual([
      "calendar.search",
      "reference.open",
      "reference.refresh",
      "reference.related",
    ]);
    // Approve is refused BEFORE any state change: no queued orphan run.
    // The per-tool gate resolves unknown proposals first (404, no mutation);
    // the owned-disabled 409 boundary lives in createApprovalGate.test.ts.
    const probe = await approveProbe(started);
    expect(probe.status).toBe(404);
    expect(probe.body).not.toContain("action_execution_disabled");
    expect(updates).toBe(0);
    await started.shutdown("test");
    // Disabled composition never adopts the port: no capability read, no
    // use, no owned shutdown.
    expect(capabilityReads).toBe(0);
    expect(closed).toBe(0);
  });

  it("never derives or closes a disabled derived owned binding", async () => {
    const { env, dbPath } = tempEnv();
    const instanceId = await provisionCalendarInstance(dbPath);
    let derived = 0;
    let closed = 0;
    const started = await startServer({
      env,
      calendarBinding: {
        connectorInstanceId: instanceId,
        connector: fakeCalendarBinding(instanceId),
        selection: { calendarId: "cal-primary", account: "ops@example" },
      },
      actionWriteBinding: {
        derivePort: () => {
          derived += 1;
          return fakeWritePort(instanceId);
        },
        owned: true,
        shutdown: async () => {
          closed += 1;
        },
      },
      drainMs: 50,
    });
    servers.push(started);
    // Unknown proposals resolve before the per-tool gate (404, no mutation).
    const probe = await approveProbe(started);
    expect(probe.status).toBe(404);
    await started.shutdown("test");
    expect(derived).toBe(0);
    expect(closed).toBe(0);
  });

  it("registers the proposal-only tool when all three gate conditions hold", async () => {
    const { env, dbPath } = tempEnv();
    const instanceId = await provisionCalendarInstance(dbPath);
    const started = await startServer({
      env: { ...env, COMPANION_ACTIONS_JSON: ENABLED_ACTIONS_JSON },
      calendarBinding: {
        connectorInstanceId: instanceId,
        connector: fakeCalendarBinding(instanceId),
        selection: { calendarId: "cal-primary", account: "ops@example" },
      },
      actionWriteBinding: { port: fakeWritePort(instanceId) },
      drainMs: 50,
      logger: createCollectingLogger("error").logger,
    });
    servers.push(started);
    expect([...(started.toolBroker?.toolNames() ?? [])].sort()).toEqual([
      "calendar.reschedule",
      "calendar.search",
      "reference.open",
      "reference.refresh",
      "reference.related",
    ]);
    // Gate open: the request now reaches the repository (404 for a random id).
    const probe = await approveProbe(started);
    expect(probe.status).toBe(404);
    expect(probe.body).not.toContain("action_execution_disabled");
    await started.shutdown("test");
  });

  it("fails closed when the injected binding is not the active instance", async () => {
    const { env, dbPath } = tempEnv();
    const instanceId = await provisionCalendarInstance(dbPath);
    const error = await startServer({
      env: { ...env, COMPANION_ACTIONS_JSON: ENABLED_ACTIONS_JSON },
      calendarBinding: {
        connectorInstanceId: instanceId,
        connector: fakeCalendarBinding(instanceId),
        selection: { calendarId: "cal-primary", account: "ops@example" },
      },
      actionWriteBinding: { port: fakeWritePort(randomUUID()) },
      drainMs: 50,
    }).then(
      (started) => {
        servers.push(started);
        return null;
      },
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/active calendar binding/);
  });

  it("fails closed when enabled without any write binding (absent)", async () => {
    const { env, dbPath } = tempEnv();
    const instanceId = await provisionCalendarInstance(dbPath);
    const before = process.listenerCount("SIGINT");
    const error = await startServer({
      env: { ...env, COMPANION_ACTIONS_JSON: ENABLED_ACTIONS_JSON },
      calendarBinding: {
        connectorInstanceId: instanceId,
        connector: fakeCalendarBinding(instanceId),
        selection: { calendarId: "cal-primary", account: "ops@example" },
      },
      drainMs: 50,
    }).then(
      (started) => {
        servers.push(started);
        return null;
      },
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/active calendar binding/);
    expect(process.listenerCount("SIGINT")).toBe(before);
  });

  it("fails closed when enabled with both/neither port and derivePort", async () => {
    const { env, dbPath } = tempEnv();
    const instanceId = await provisionCalendarInstance(dbPath);
    const binding = {
      connectorInstanceId: instanceId,
      connector: fakeCalendarBinding(instanceId),
      selection: { calendarId: "cal-primary", account: "ops@example" },
    } as const;
    for (const actionWriteBinding of [
      {
        port: fakeWritePort(instanceId),
        derivePort: () => fakeWritePort(instanceId),
      },
      {},
    ]) {
      const error = await startServer({
        env: { ...env, COMPANION_ACTIONS_JSON: ENABLED_ACTIONS_JSON },
        calendarBinding: binding,
        actionWriteBinding,
        drainMs: 50,
      }).then(
        (started) => {
          servers.push(started);
          return null;
        },
        (failure: unknown) => failure,
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/active calendar binding/);
    }
  });

  it("fails closed when enabled with an invalid capability", async () => {
    const { env, dbPath } = tempEnv();
    const instanceId = await provisionCalendarInstance(dbPath);
    const bad = fakeWritePort(instanceId);
    (bad.capability as { writeEnabled: boolean }).writeEnabled = false;
    const error = await startServer({
      env: { ...env, COMPANION_ACTIONS_JSON: ENABLED_ACTIONS_JSON },
      calendarBinding: {
        connectorInstanceId: instanceId,
        connector: fakeCalendarBinding(instanceId),
        selection: { calendarId: "cal-primary", account: "ops@example" },
      },
      actionWriteBinding: { port: bad },
      drainMs: 50,
    }).then(
      (started) => {
        servers.push(started);
        return null;
      },
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/active calendar binding/);
  });

  it("shuts down only an explicitly owned injected write port", async () => {
    const { env, dbPath } = tempEnv();
    const instanceId = await provisionCalendarInstance(dbPath);
    let closed = 0;
    const started = await startServer({
      env: { ...env, COMPANION_ACTIONS_JSON: ENABLED_ACTIONS_JSON },
      calendarBinding: {
        connectorInstanceId: instanceId,
        connector: fakeCalendarBinding(instanceId),
        selection: { calendarId: "cal-primary", account: "ops@example" },
      },
      actionWriteBinding: {
        port: fakeWritePort(instanceId),
        owned: true,
        shutdown: async () => {
          closed += 1;
        },
      },
      drainMs: 50,
    });
    await started.shutdown("test");
    expect(closed).toBe(1);
  });

  it("never closes an enabled caller-owned write port", async () => {
    const { env, dbPath } = tempEnv();
    const instanceId = await provisionCalendarInstance(dbPath);
    let closed = 0;
    const started = await startServer({
      env: { ...env, COMPANION_ACTIONS_JSON: ENABLED_ACTIONS_JSON },
      calendarBinding: {
        connectorInstanceId: instanceId,
        connector: fakeCalendarBinding(instanceId),
        selection: { calendarId: "cal-primary", account: "ops@example" },
      },
      actionWriteBinding: {
        port: fakeWritePort(instanceId),
        shutdown: async () => {
          closed += 1;
        },
      },
      drainMs: 50,
    });
    servers.push(started);
    await started.shutdown("test");
    expect(closed).toBe(0);
  });

  it("listen failure on a real occupied loopback port closes an enabled owned port exactly once", async () => {
    // Occupy a real loopback port with a live server (no synthetic throw:
    // the second startServer must lose a genuine OS bind).
    const holderEnv = tempEnv();
    const holder = await startServer({
      env: holderEnv.env,
      drainMs: 50,
      logger: createCollectingLogger("error").logger,
    });
    servers.push(holder);
    expect(holder.port).toBeGreaterThan(0);

    const { env, dbPath } = tempEnv();
    const instanceId = await provisionCalendarInstance(dbPath);
    const sigintBefore = process.listenerCount("SIGINT");
    const sigtermBefore = process.listenerCount("SIGTERM");
    let closed = 0;
    const error = await startServer({
      env: {
        ...env,
        COMPANION_PORT: String(holder.port),
        COMPANION_ACTIONS_JSON: ENABLED_ACTIONS_JSON,
      },
      calendarBinding: {
        connectorInstanceId: instanceId,
        connector: fakeCalendarBinding(instanceId),
        selection: { calendarId: "cal-primary", account: "ops@example" },
      },
      actionWriteBinding: {
        port: fakeWritePort(instanceId),
        owned: true,
        shutdown: async () => {
          closed += 1;
        },
      },
      drainMs: 50,
      logger: createCollectingLogger("error").logger,
    }).then(
      (started) => {
        servers.push(started);
        return null;
      },
      (failure: unknown) => failure,
    );
    // The real bind failure propagates (never suppressed or swallowed).
    expect(error).toBeInstanceOf(Error);
    expect(
      (error as NodeJS.ErrnoException).code === "EADDRINUSE" ||
        /address in use/i.test((error as Error).message),
    ).toBe(true);
    // The adopted owned hook ran exactly once across the listen-failure
    // catch and the outer startup catch (consumed before invoke, so the
    // injected hook is never required to be idempotent).
    expect(closed).toBe(1);
    // No listener allocated by the failed start, no signal-handler leak.
    expect(process.listenerCount("SIGINT")).toBe(sigintBefore);
    expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore);
    // The occupying listener is untouched and still serves (unknown ids
    // resolve before the per-tool gate: 404, no mutation).
    const probe = await approveProbe(holder);
    expect(probe.status).toBe(404);
    expect(probe.body).not.toContain("action_execution_disabled");
    // The failed start released its DB handle: the same path restarts
    // cleanly on a free port and its owned hook closes exactly once.
    let reopenedClosed = 0;
    const reopened = await startServer({
      env: { ...env, COMPANION_ACTIONS_JSON: ENABLED_ACTIONS_JSON },
      calendarBinding: {
        connectorInstanceId: instanceId,
        connector: fakeCalendarBinding(instanceId),
        selection: { calendarId: "cal-primary", account: "ops@example" },
      },
      actionWriteBinding: {
        port: fakeWritePort(instanceId),
        owned: true,
        shutdown: async () => {
          reopenedClosed += 1;
        },
      },
      drainMs: 50,
      logger: createCollectingLogger("error").logger,
    });
    servers.push(reopened);
    await reopened.shutdown("test");
    expect(reopenedClosed).toBe(1);
  });

  it("a hanging adopted owned hook never stalls shutdown past the bound", async () => {
    const { env, dbPath } = tempEnv();
    const instanceId = await provisionCalendarInstance(dbPath);
    const collecting = createCollectingLogger("warn");
    const started = await startServer({
      env: { ...env, COMPANION_ACTIONS_JSON: ENABLED_ACTIONS_JSON },
      calendarBinding: {
        connectorInstanceId: instanceId,
        connector: fakeCalendarBinding(instanceId),
        selection: { calendarId: "cal-primary", account: "ops@example" },
      },
      actionWriteBinding: {
        port: fakeWritePort(instanceId),
        owned: true,
        // Never settles: shutdown must still complete inside the bound.
        shutdown: () => new Promise<void>(() => {}),
      },
      drainMs: 50,
      mcpShutdownMs: 200,
      logger: collecting.logger,
    });
    servers.push(started);
    const begin = Date.now();
    await started.shutdown("test");
    expect(Date.now() - begin).toBeLessThan(10_000);
    expect(
      collecting.records.some(
        (record) => record.code === "server.action_write_shutdown_timeout",
      ),
    ).toBe(true);
  });
});

void (undefined as unknown as typeof CALENDAR_RESCHEDULE_TOOL_NAME);
