// Bootstrap tests: exact startup order + graceful shutdown over a real
// (loopback, ephemeral-port) listener with a temp file DB. Resources are
// always closed; no test leaves a listener or DB handle open.

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
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

function tempEnv(): { env: NodeJS.ProcessEnv; dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "companion-bootstrap-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "companion.sqlite");
  return {
    env: {
      COMPANION_DB_PATH: dbPath,
      COMPANION_HOST: "127.0.0.1",
      COMPANION_PORT: "0",
      COMPANION_TIME_ZONE: "UTC",
      COMPANION_LOG_LEVEL: "error",
    },
    dir,
    dbPath,
  };
}

describe("bootstrap startup + graceful shutdown", () => {
  it("starts in order, serves exact health, and shuts down gracefully", async () => {
    const { env, dbPath } = tempEnv();
    const started = await startServer({ env, drainMs: 200 });
    servers.push(started);
    try {
      expect(started.config.host).toBe("127.0.0.1");
      expect(started.port).toBeGreaterThan(0);
      const base = `http://127.0.0.1:${started.port}`;
      expect(await (await fetch(`${base}/health/live`)).json()).toEqual({
        status: "live",
      });
      expect(await (await fetch(`${base}/health/ready`)).json()).toEqual({
        status: "ready",
      });

      // Startup order left a versioned, migrated file DB behind.
      const probe = new Database(dbPath, { readonly: true });
      try {
        expect(probe.pragma("user_version", { simple: true })).toBe(1);
        const sessions = probe
          .prepare("SELECT COUNT(*) AS n FROM sessions")
          .get() as {
          n: number;
        };
        expect(sessions.n).toBe(0);
      } finally {
        probe.close();
      }

      // End-to-end mutation over HTTP (local CLI-style: no Origin).
      const created = await fetch(`${base}/api/sessions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": randomUUID(),
        },
        body: "{}",
      });
      expect(created.status).toBe(201);
      const { sessionId } = (await created.json()) as { sessionId: string };

      // Draining: live stays 200, ready flips to exact 503, intake is refused.
      started.controls.markDraining();
      expect(await (await fetch(`${base}/health/live`)).json()).toEqual({
        status: "live",
      });
      const ready = await fetch(`${base}/health/ready`);
      expect(ready.status).toBe(503);
      expect(await ready.json()).toEqual({
        status: "not_ready",
        code: "server_shutting_down",
      });
      const late = await fetch(`${base}/api/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": randomUUID(),
        },
        body: JSON.stringify({ text: "late" }),
      });
      expect(late.status).toBe(503);
      expect(late.headers.get("retry-after")).toBe("5");

      await started.shutdown("test");
      servers.pop();
      await expect(fetch(`${base}/health/live`)).rejects.toThrow();
      // Idempotent shutdown resolves again.
      await started.shutdown("test-again");
    } finally {
      const index = servers.indexOf(started);
      if (index >= 0) {
        servers.splice(index, 1);
      }
    }
  });

  it("fails closed on a newer database version", async () => {
    const { env, dbPath } = tempEnv();
    const setup = new Database(dbPath);
    try {
      setup.exec("CREATE TABLE t (a TEXT) STRICT");
      setup.pragma("user_version = 99");
    } finally {
      setup.close();
    }
    await expect(startServer({ env, drainMs: 50 })).rejects.toThrow();
  });

  it("fails drain closed without closing DB/listener and permits retry", async () => {
    const { env } = tempEnv();
    const started = await startServer({ env, drainMs: 50 });
    servers.push(started);
    const base = `http://127.0.0.1:${started.port}`;
    const originalShutdown = started.engine.shutdown.bind(started.engine);
    let failOnce = true;
    started.engine.shutdown = async (options?: { drainMs?: number }) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("drain boom");
      }
      return originalShutdown(options);
    };
    await expect(started.shutdown("test-drain-fail")).rejects.toThrow(
      "drain failed",
    );
    // Fail-closed: listener and DB still serve; ready stays not_ready.
    expect(await (await fetch(`${base}/health/live`)).json()).toEqual({
      status: "live",
    });
    const ready = await fetch(`${base}/health/ready`);
    expect(ready.status).toBe(503);
    // Retry succeeds and stops the server.
    await started.shutdown("test-drain-retry");
    servers.pop();
    await expect(fetch(`${base}/health/live`)).rejects.toThrow();
  });

  it("does not leak named signal handlers across start/shutdown", async () => {
    const beforeInt = process.listenerCount("SIGINT");
    const beforeTerm = process.listenerCount("SIGTERM");
    const first = tempEnv();
    const a = await startServer({ env: first.env, drainMs: 50 });
    expect(process.listenerCount("SIGINT")).toBe(beforeInt + 1);
    expect(process.listenerCount("SIGTERM")).toBe(beforeTerm + 1);
    await a.shutdown("test");
    expect(process.listenerCount("SIGINT")).toBe(beforeInt);
    expect(process.listenerCount("SIGTERM")).toBe(beforeTerm);
    const second = tempEnv();
    const b = await startServer({ env: second.env, drainMs: 50 });
    servers.push(b);
    try {
      expect(process.listenerCount("SIGINT")).toBe(beforeInt + 1);
      expect(process.listenerCount("SIGTERM")).toBe(beforeTerm + 1);
      await b.shutdown("test");
      servers.pop();
      expect(process.listenerCount("SIGINT")).toBe(beforeInt);
      expect(process.listenerCount("SIGTERM")).toBe(beforeTerm);
    } finally {
      const index = servers.indexOf(b);
      if (index >= 0) {
        servers.splice(index, 1);
      }
    }
  });
});
