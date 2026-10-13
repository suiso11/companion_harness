// Pinned google-readonly profile tests: strict opt-in selection, frozen
// host-owned definitions, and fail-closed normal-composition linkage.
// Behavior boundaries only: no constant-copy asserts, no network, no OAuth,
// no user secrets.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpBindingDefinition } from "@companion/connector-mcp";
import { afterEach, describe, expect, it } from "vitest";
import { type StartedServer, startServer } from "../src/bootstrap.js";
import {
  assertGoogleReadonlyHintCompatible,
  CALENDAR_PROFILE_ENV,
  GOOGLE_READONLY_FORK,
  GOOGLE_READONLY_TOOLS,
  GOOGLE_READONLY_WIRE_HASHES,
  getGoogleReadonlyDefinitions,
  parseCalendarProfileName,
} from "../src/calendarReadonlyProfile.js";
import { ServerConfigError } from "../src/config.js";

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

function tempEnv(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "companion-profile-"));
  tempDirs.push(dir);
  return {
    COMPANION_DB_PATH: join(dir, "companion.sqlite"),
    COMPANION_HOST: "127.0.0.1",
    COMPANION_PORT: "0",
    COMPANION_TIME_ZONE: "UTC",
    COMPANION_LOG_LEVEL: "error",
  };
}

/** Pinned-hint connector: identity + stdio + exactly the 3 live-wire hashes. */
function profileHint(connectorOverrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    selection: { calendarId: "primary" },
    connector: {
      serverId: "calendar-logical",
      kind: "mcp",
      expectedServerName: GOOGLE_READONLY_FORK.serverName,
      version: GOOGLE_READONLY_FORK.version,
      transport: {
        kind: "stdio",
        command: "/bin/false",
        envAllowlist: ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"],
      },
      bindings: GOOGLE_READONLY_TOOLS.map((tool) => ({
        upstreamTool: tool,
        canonicalSchemaHash: GOOGLE_READONLY_WIRE_HASHES[tool],
      })),
      ...connectorOverrides,
    },
  });
}

describe("parseCalendarProfileName", () => {
  it("stays disabled when unset or empty (previous behavior)", () => {
    expect(parseCalendarProfileName(undefined)).toBeNull();
    expect(parseCalendarProfileName("")).toBeNull();
  });

  it("selects the adopted profile on its exact name", () => {
    expect(parseCalendarProfileName("google-readonly")).toBe("google-readonly");
  });

  it("rejects unknown profiles fail-closed (never a silent disable)", () => {
    expect(() => parseCalendarProfileName("google-readonly ")).toThrow(
      ServerConfigError,
    );
    expect(() => parseCalendarProfileName("GOOGLE-READONLY")).toThrow(
      ServerConfigError,
    );
    expect(() => parseCalendarProfileName("google")).toThrow(ServerConfigError);
  });
});

describe("getGoogleReadonlyDefinitions", () => {
  it("owns exactly the 3-tool read surface with distinct pinned hashes", () => {
    const defs = getGoogleReadonlyDefinitions();
    expect(defs.map((d) => d.upstreamTool).sort()).toEqual(
      [...GOOGLE_READONLY_TOOLS].sort(),
    );
    for (const def of defs) {
      expect(def.category).toBe("read");
      expect(def.canonicalSchemaHash).toMatch(/^[0-9a-f]{64}$/);
    }
    // Distinct per tool: a swapped hash could otherwise link the wrong tool.
    const hashes = new Set(defs.map((d) => d.canonicalSchemaHash));
    expect(hashes.size).toBe(3);
    expect(Object.isFrozen(defs)).toBe(true);
  });

  it("returns a fresh frozen copy (caller mutation cannot poison the pin)", () => {
    const first = getGoogleReadonlyDefinitions();
    expect(() =>
      (first as McpBindingDefinition[]).push({
        upstreamTool: "list-calendars",
        canonicalSchemaHash: "d".repeat(64),
        category: "read",
      }),
    ).toThrow(TypeError);
    expect(getGoogleReadonlyDefinitions()).toHaveLength(3);
  });
});

describe("assertGoogleReadonlyHintCompatible", () => {
  function hint(overrides: Record<string, unknown> = {}): {
    connector: Record<string, unknown>;
  } {
    return JSON.parse(profileHint(overrides)) as {
      connector: Record<string, unknown>;
    };
  }

  it("accepts the exact pinned hint", () => {
    expect(() => assertGoogleReadonlyHintCompatible(hint())).not.toThrow();
  });

  it("rejects substituted identity, transport, and binding deviations", () => {
    // Wrong version string cannot promote the same surface.
    expect(() =>
      assertGoogleReadonlyHintCompatible(hint({ version: "9.9.9-wrong" })),
    ).toThrow(/identity mismatch/);
    // Wrong wire name cannot borrow the pinned hashes.
    expect(() =>
      assertGoogleReadonlyHintCompatible(
        hint({ expectedServerName: "google-calendar-evil" }),
      ),
    ).toThrow(/identity mismatch/);
    // Profile is stdio-only: a loopback-HTTP hint is a different binding.
    expect(() =>
      assertGoogleReadonlyHintCompatible(
        hint({
          transport: { kind: "streamable-http", host: "127.0.0.1", port: 3000 },
        }),
      ),
    ).toThrow(/transport mismatch/);
  });

  it("rejects surfaces that add, drop, or rehash a binding", () => {
    const withExtra = hint();
    (withExtra.connector.bindings as unknown[]).push({
      upstreamTool: "list-calendars",
      canonicalSchemaHash: "d".repeat(64),
    });
    expect(() => assertGoogleReadonlyHintCompatible(withExtra)).toThrow(
      /bindings mismatch/,
    );

    const dropped = JSON.parse(profileHint()) as {
      connector: { bindings: unknown[] };
    };
    dropped.connector.bindings = dropped.connector.bindings.slice(0, 2);
    expect(() => assertGoogleReadonlyHintCompatible(dropped)).toThrow(
      /bindings mismatch/,
    );

    const rehashed = JSON.parse(profileHint()) as {
      connector: {
        bindings: { upstreamTool: string; canonicalSchemaHash: string }[];
      };
    };
    const target = rehashed.connector.bindings.find(
      (b) => b.upstreamTool === "get-event",
    );
    expect(target).toBeDefined();
    if (target !== undefined) {
      target.canonicalSchemaHash = "c".repeat(64);
    }
    expect(() => assertGoogleReadonlyHintCompatible(rehashed)).toThrow(
      /bindings mismatch/,
    );
  });
});

describe("bootstrap normal composition with the pinned profile", () => {
  it("keeps NO-profile startup disabled and unchanged", async () => {
    const started = await startServer({ env: tempEnv(), drainMs: 50 });
    servers.push(started);
    expect(started.config.calendar).toBeNull();
    expect(started.toolBroker).toBeNull();
  });

  it("rejects an unknown profile before doing any work", async () => {
    await expect(
      startServer({
        env: { ...tempEnv(), [CALENDAR_PROFILE_ENV]: "google" },
        drainMs: 50,
      }),
    ).rejects.toThrow(/unknown calendar profile/);
  });

  it("fails closed when the profile is set without calendar config", async () => {
    await expect(
      startServer({
        env: { ...tempEnv(), [CALENDAR_PROFILE_ENV]: "google-readonly" },
        drainMs: 50,
      }),
    ).rejects.toThrow(/profile requires calendar config/);
  });

  it("fails closed when the profile meets explicit host definitions", async () => {
    await expect(
      startServer({
        env: {
          ...tempEnv(),
          COMPANION_CALENDAR_JSON: profileHint(),
          [CALENDAR_PROFILE_ENV]: "google-readonly",
        },
        mcpDefinitions: getGoogleReadonlyDefinitions(),
        drainMs: 50,
      }),
    ).rejects.toThrow(/mutually exclusive/);
  });

  it("fails closed on a mismatched identity without registering anything", async () => {
    const env = tempEnv();
    const dbPath = env.COMPANION_DB_PATH as string;
    await expect(
      startServer({
        env: {
          ...env,
          COMPANION_CALENDAR_JSON: profileHint({ version: "9.9.9-wrong" }),
          [CALENDAR_PROFILE_ENV]: "google-readonly",
        },
        drainMs: 50,
      }),
    ).rejects.toThrow(/identity mismatch/);
    const { default: Database } = await import("better-sqlite3");
    const probe = new Database(dbPath, { readonly: true });
    try {
      const rows = probe
        .prepare("SELECT id FROM connector_instances WHERE kind = 'calendar'")
        .all() as unknown[];
      expect(rows).toHaveLength(0);
    } finally {
      probe.close();
    }
  });

  it("owns the calendar instance through the profile with zero dials at startup", async () => {
    let created = 0;
    const started = await startServer({
      env: {
        ...tempEnv(),
        COMPANION_CALENDAR_JSON: profileHint(),
        [CALENDAR_PROFILE_ENV]: "google-readonly",
      },
      mcpTransportFactory: () => {
        created += 1;
        return {
          start: async () => {
            throw new Error("unavailable (test)");
          },
          send: async () => {},
          close: async () => {},
        } as never;
      },
      drainMs: 50,
    });
    servers.push(started);
    expect(created).toBe(0);
    expect([...(started.toolBroker?.toolNames() ?? [])].sort()).toEqual([
      "calendar.search",
      "reference.open",
      "reference.refresh",
      "reference.related",
    ]);
  });

  it("freezes a missing profile against a later mutation (still incomplete opt-in)", async () => {
    const env: NodeJS.ProcessEnv = {
      ...tempEnv(),
      COMPANION_CALENDAR_JSON: profileHint(),
    };
    const pending = startServer({ env, drainMs: 50 });
    // Mutate the SAME env object synchronously after the call: the frozen
    // startup decision must not observe it.
    env[CALENDAR_PROFILE_ENV] = "google-readonly";
    await expect(pending).rejects.toThrow(/host trusted binding definitions/);
  });

  it("freezes a present profile against later removal (retains the decision)", async () => {
    const env: NodeJS.ProcessEnv = {
      ...tempEnv(),
      COMPANION_CALENDAR_JSON: profileHint(),
      [CALENDAR_PROFILE_ENV]: "google-readonly",
    };
    let created = 0;
    const pending = startServer({
      env,
      mcpTransportFactory: () => {
        created += 1;
        return {
          start: async () => {
            throw new Error("unavailable (test)");
          },
          send: async () => {},
          close: async () => {},
        } as never;
      },
      drainMs: 50,
    });
    // Remove the selector synchronously after the call: startup must still
    // own the profile composition (lazy, zero dials).
    delete env[CALENDAR_PROFILE_ENV];
    const started = await pending;
    servers.push(started);
    expect(created).toBe(0);
    expect([...(started.toolBroker?.toolNames() ?? [])].sort()).toEqual([
      "calendar.search",
      "reference.open",
      "reference.refresh",
      "reference.related",
    ]);
  });
});
