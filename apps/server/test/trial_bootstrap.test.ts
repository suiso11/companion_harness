// Trial runner bootstrap wiring tests (existing bootstrap tests style).
//
// - Trials disabled constructs no runner (trialRunner null).
// - Trials enabled with an injected fake runner: recoverOnBoot runs at
//   startup and shutdown awaits the runner (bounded, no orphan).
// No real model/network/bridge run; the fake never touches the DB.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type StartedServer, startServer } from "../src/bootstrap.js";
import type { TrialRunner } from "../src/trial_runner.js";

const FP = "b".repeat(64);
const REV = "a".repeat(40);

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
    tempDirs = tempDirs.filter((entry) => entry !== dir);
    const { rmSync } = await import("node:fs");
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

function tempEnv(): { env: NodeJS.ProcessEnv; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "companion-trial-boot-"));
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
    dbPath,
  };
}

function trialEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    COMPANION_MODEL_JSON: JSON.stringify({
      adapter: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      model: "test-model",
    }),
    COMPANION_AUTONOMY_JSON: JSON.stringify({
      available: true,
      enabled: true,
      mandatoryChecks: ["lint"],
      configFingerprint: FP,
      sourceRevision: REV,
      currentModel: "test-model",
      disclosedWholeRepoRead: true,
      timeoutMs: 60000,
      maxOutputBytes: 1000000,
      workspaceAlias: "ws",
      runner: {
        nodeRealpath: "/usr/bin/node",
        bridgeScriptPath: "/opt/bridge.mjs",
        bridgeConfigTemplatePath: "/opt/bridge.template.json",
        systemctlRealpath: "/usr/bin/systemctl",
        xdgRuntimeDir: "/run/user/1000",
        relay: {
          maxRequestBytes: 1048576,
          maxModelCalls: 8,
          maxOutputTokens: 256,
          maxResponseBytes: 1048576,
          perCallTimeoutMs: 5000,
          maxConcurrent: 1,
        },
        observe: {
          activeTimeoutMs: 5000,
          goneTimeoutMs: 5000,
          pollIntervalMs: 50,
        },
        pollMs: 100,
      },
    }),
  };
}

function fakeRunner(calls: {
  recover: number;
  run: number;
  shutdown: number;
  revoke: number;
}): TrialRunner {
  return {
    recoverOnBoot: async () => {
      calls.recover += 1;
      return { settled: 0, fenced: 0 };
    },
    runNext: async () => {
      calls.run += 1;
      return { ran: false, outcome: "empty" as const };
    },
    shutdown: async () => {
      calls.shutdown += 1;
    },
    revokeForForeground: () => {
      calls.revoke += 1;
    },
  } as unknown as TrialRunner;
}

describe("trial runner bootstrap wiring", () => {
  it("constructs no runner when trials are disabled", async () => {
    const { env } = tempEnv();
    const started = await startServer({ env, drainMs: 50 });
    servers.push(started);
    try {
      expect(started.trialRunner).toBeNull();
      await started.shutdown("test");
      servers.pop();
    } finally {
      const index = servers.indexOf(started);
      if (index >= 0) {
        servers.splice(index, 1);
      }
    }
  });

  it("recovers on boot and awaits the runner on shutdown (fake)", async () => {
    const { env } = tempEnv();
    const calls = { recover: 0, run: 0, shutdown: 0, revoke: 0 };
    const started = await startServer({
      env: trialEnv(env),
      drainMs: 50,
      trialRunner: fakeRunner(calls),
    });
    servers.push(started);
    try {
      // recoverOnBoot ran exactly once during startup.
      expect(calls.recover).toBe(1);
      expect(started.trialRunner).not.toBeNull();
      await started.shutdown("test");
      servers.pop();
      // Shutdown awaited the runner (bounded, fake resolves at once).
      expect(calls.shutdown).toBe(1);
    } finally {
      const index = servers.indexOf(started);
      if (index >= 0) {
        servers.splice(index, 1);
      }
    }
  });
});
