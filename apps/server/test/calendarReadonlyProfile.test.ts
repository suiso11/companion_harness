// Pinned google-readonly profile tests: strict opt-in selection, frozen
// host-owned definitions, and fail-closed normal-composition linkage.
// Behavior boundaries only: no constant-copy asserts, no network, no OAuth,
// no user secrets.

import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpBindingDefinition } from "@companion/connector-mcp";
import { afterEach, describe, expect, it } from "vitest";
import {
  CALENDAR_CONNECTOR_DISPLAY_NAME,
  type StartedServer,
  startServer,
} from "../src/bootstrap.js";
import {
  assertGoogleReadonlyHintCompatible,
  CALENDAR_PROFILE_ENV,
  GOOGLE_READONLY_CONNECTOR_DISPLAY_NAME,
  GOOGLE_READONLY_FORK,
  GOOGLE_READONLY_TOOLS,
  GOOGLE_READONLY_WIRE_HASHES,
  getGoogleReadonlyDefinitions,
  parseCalendarProfileName,
} from "../src/calendarReadonlyProfile.js";
import { parseCalendarConfig, ServerConfigError } from "../src/config.js";

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

  it("rejects the superseded 6939311 list/search hashes (clean cutover)", () => {
    // Hardcoded superseded literals (documented in the profile provenance):
    // the guard must no longer accept the old multi-account schemas.
    const oldHashes: Record<string, string> = {
      "list-events":
        "81222b89482cba77b12a707c2097c66df383cab7929c14dca03cc303846d794c",
      "search-events":
        "d48ba36e7f280d92eaba9550323e90aa7a6d7c758812932ad62012f4514558b7",
    };
    for (const [tool, oldHash] of Object.entries(oldHashes)) {
      expect(oldHash).not.toBe(GOOGLE_READONLY_WIRE_HASHES[tool] as string);
      const stale = JSON.parse(profileHint()) as {
        connector: {
          bindings: { upstreamTool: string; canonicalSchemaHash: string }[];
        };
      };
      const entry = stale.connector.bindings.find(
        (b) => b.upstreamTool === tool,
      );
      expect(entry).toBeDefined();
      if (entry !== undefined) {
        entry.canonicalSchemaHash = oldHash;
      }
      expect(() => assertGoogleReadonlyHintCompatible(stale)).toThrow(
        /bindings mismatch/,
      );
    }
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
    // Pre-DB composition preflight: no DB file (and no calendar row) exists.
    expect(existsSync(dbPath)).toBe(false);
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

describe("profile pre-DB fail-closed (no DB side effect)", () => {
  it("creates neither the DB file nor its parent dir on profile failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "companion-profile-predb-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "missing-parent", "nested", "companion.sqlite");
    const env: NodeJS.ProcessEnv = {
      COMPANION_DB_PATH: dbPath,
      COMPANION_HOST: "127.0.0.1",
      COMPANION_PORT: "0",
      COMPANION_TIME_ZONE: "UTC",
      COMPANION_LOG_LEVEL: "error",
      COMPANION_CALENDAR_JSON: profileHint({ version: "9.9.9-wrong" }),
      [CALENDAR_PROFILE_ENV]: "google-readonly",
    };
    await expect(startServer({ env, drainMs: 50 })).rejects.toThrow(
      /identity mismatch/,
    );
    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(join(dir, "missing-parent"))).toBe(false);
  });

  it("leaves an existing older DB byte-identical on profile failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "companion-profile-older-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "companion.sqlite");
    const seedEnv: NodeJS.ProcessEnv = {
      COMPANION_DB_PATH: dbPath,
      COMPANION_HOST: "127.0.0.1",
      COMPANION_PORT: "0",
      COMPANION_TIME_ZONE: "UTC",
      COMPANION_LOG_LEVEL: "error",
    };
    const seeded = await startServer({ env: seedEnv, drainMs: 50 });
    await seeded.shutdown("test-teardown");
    const before = readFileSync(dbPath);
    await expect(
      startServer({
        env: {
          ...seedEnv,
          COMPANION_CALENDAR_JSON: profileHint({ version: "9.9.9-wrong" }),
          [CALENDAR_PROFILE_ENV]: "google-readonly",
        },
        drainMs: 50,
      }),
    ).rejects.toThrow(/identity mismatch/);
    expect(readFileSync(dbPath).equals(before)).toBe(true);
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
});

describe("profile account grammar (pinned fork identity)", () => {
  function hintWithAccount(account: unknown): {
    selection: Record<string, unknown>;
    connector: Record<string, unknown>;
  } {
    const base = JSON.parse(profileHint()) as {
      selection: Record<string, unknown>;
      connector: Record<string, unknown>;
    };
    if (account === undefined) {
      return base;
    }
    return {
      selection: { ...base.selection, account },
      connector: base.connector,
    };
  }

  it("accepts omitted account and boring lowercase identities", () => {
    expect(() =>
      assertGoogleReadonlyHintCompatible(hintWithAccount(undefined)),
    ).not.toThrow();
    for (const account of ["work-1_2", "a", "x".repeat(64)]) {
      expect(() =>
        assertGoogleReadonlyHintCompatible(hintWithAccount(account)),
      ).not.toThrow();
    }
  });

  it("rejects email, uppercase, overlength, and invalid characters", () => {
    for (const account of [
      "me@example.com",
      "Work",
      "UPPER",
      "x".repeat(65),
      "a b",
      "a/b",
      "a.b",
      "",
    ]) {
      expect(() =>
        assertGoogleReadonlyHintCompatible(hintWithAccount(account)),
      ).toThrow(/account mismatch/);
    }
  });

  it("rejects the superseded multi-account array form", () => {
    // The 6939311 wire schema accepted `account` arrays; the adopted fork
    // takes exactly one account string, and so does the host guard.
    for (const account of [["work"], ["a", "b"], []]) {
      expect(() =>
        assertGoogleReadonlyHintCompatible(hintWithAccount(account)),
      ).toThrow(/account mismatch/);
    }
  });

  it("does not narrow the generic non-profile account contract", () => {
    const hint = JSON.parse(profileHint()) as {
      selection: { calendarId: string };
      connector: unknown;
    };
    const raw = JSON.stringify({
      selection: {
        calendarId: hint.selection.calendarId,
        account: "me@example.com",
      },
      connector: (hint as { connector: unknown }).connector,
    });
    expect(() => parseCalendarConfig(raw)).not.toThrow();
    expect(parseCalendarConfig(raw)?.selection.account).toBe("me@example.com");
  });

  it("fails closed before any DB side effect on a profile account mismatch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "companion-profile-acct-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "missing-parent", "companion.sqlite");
    const base = JSON.parse(profileHint()) as {
      selection: Record<string, unknown>;
      connector: unknown;
    };
    const raw = JSON.stringify({
      selection: { ...base.selection, account: "me@example.com" },
      connector: base.connector,
    });
    await expect(
      startServer({
        env: {
          COMPANION_DB_PATH: dbPath,
          COMPANION_HOST: "127.0.0.1",
          COMPANION_PORT: "0",
          COMPANION_TIME_ZONE: "UTC",
          COMPANION_LOG_LEVEL: "error",
          COMPANION_CALENDAR_JSON: raw,
          [CALENDAR_PROFILE_ENV]: "google-readonly",
        },
        drainMs: 50,
      }),
    ).rejects.toThrow(/account mismatch/);
    expect(existsSync(dbPath)).toBe(false);
  });
});

describe("profile persisted identity isolation + refresh routing", () => {
  function unavailableFactory(): {
    factory: () => never;
    count: () => number;
  } {
    let created = 0;
    return {
      factory: () => {
        created += 1;
        return {
          start: async () => {
            throw new Error("unavailable (test)");
          },
          send: async () => {},
          close: async () => {},
        } as never;
      },
      count: () => created,
    };
  }

  it("persists under its own display name and reuses it on restart", async () => {
    const env = tempEnv();
    const dbPath = env.COMPANION_DB_PATH as string;
    const { factory } = unavailableFactory();
    const first = await startServer({
      env: {
        ...env,
        COMPANION_CALENDAR_JSON: profileHint(),
        [CALENDAR_PROFILE_ENV]: "google-readonly",
      },
      mcpTransportFactory: factory,
      drainMs: 50,
    });
    servers.push(first);
    const { default: Database } = await import("better-sqlite3");
    const probe = new Database(dbPath, { readonly: true });
    let firstId = "";
    try {
      const rows = probe
        .prepare(
          "SELECT id, display_name FROM connector_instances WHERE kind = 'calendar'",
        )
        .all() as { id: string; display_name: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.display_name).toBe(
        GOOGLE_READONLY_CONNECTOR_DISPLAY_NAME,
      );
      expect(rows[0]?.display_name).not.toBe(CALENDAR_CONNECTOR_DISPLAY_NAME);
      firstId = rows[0]?.id as string;
    } finally {
      probe.close();
    }
    await first.shutdown("test-teardown");
    servers.pop();
    const second = await startServer({
      env: {
        ...env,
        COMPANION_CALENDAR_JSON: profileHint(),
        [CALENDAR_PROFILE_ENV]: "google-readonly",
      },
      mcpTransportFactory: factory,
      drainMs: 50,
    });
    servers.push(second);
    const probe2 = new Database(dbPath, { readonly: true });
    try {
      const rows = probe2
        .prepare(
          "SELECT id, display_name FROM connector_instances WHERE kind = 'calendar'",
        )
        .all() as { id: string; display_name: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(firstId);
      expect(rows[0]?.display_name).toBe(
        GOOGLE_READONLY_CONNECTOR_DISPLAY_NAME,
      );
    } finally {
      probe2.close();
    }
  });

  it("never reuses a generic calendar-mcp row with the same selection", async () => {
    const env = tempEnv();
    const dbPath = env.COMPANION_DB_PATH as string;
    const generic = unavailableFactory();
    const first = await startServer({
      env: { ...env, COMPANION_CALENDAR_JSON: profileHint() },
      mcpDefinitions: getGoogleReadonlyDefinitions(),
      mcpTransportFactory: generic.factory,
      drainMs: 50,
    });
    servers.push(first);
    const { default: Database } = await import("better-sqlite3");
    let genericId = "";
    const probe = new Database(dbPath, { readonly: true });
    try {
      const rows = probe
        .prepare(
          "SELECT id, display_name FROM connector_instances WHERE kind = 'calendar'",
        )
        .all() as { id: string; display_name: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.display_name).toBe(CALENDAR_CONNECTOR_DISPLAY_NAME);
      genericId = rows[0]?.id as string;
    } finally {
      probe.close();
    }
    await first.shutdown("test-teardown");
    servers.pop();
    const profile = unavailableFactory();
    const second = await startServer({
      env: {
        ...env,
        COMPANION_CALENDAR_JSON: profileHint(),
        [CALENDAR_PROFILE_ENV]: "google-readonly",
      },
      mcpTransportFactory: profile.factory,
      drainMs: 50,
    });
    servers.push(second);
    const probe2 = new Database(dbPath, { readonly: true });
    try {
      const rows = probe2
        .prepare(
          "SELECT id, display_name FROM connector_instances WHERE kind = 'calendar' ORDER BY display_name ASC",
        )
        .all() as { id: string; display_name: string }[];
      expect(rows).toHaveLength(2);
      const names = rows.map((row) => row.display_name).sort();
      expect(names).toEqual(
        [
          CALENDAR_CONNECTOR_DISPLAY_NAME,
          GOOGLE_READONLY_CONNECTOR_DISPLAY_NAME,
        ].sort(),
      );
      const profileRow = rows.find(
        (row) => row.display_name === GOOGLE_READONLY_CONNECTOR_DISPLAY_NAME,
      );
      expect(profileRow).toBeDefined();
      expect(profileRow?.id).not.toBe(genericId);
    } finally {
      probe2.close();
    }
  });

  it("cannot refresh an old generic target through the new profile provider", async () => {
    const {
      closeKernelDatabase,
      createDurableCalendarTargetStore,
      createInMemoryCalendarTargetStore,
      createKernelRepository,
      createM1ToolRegistrations,
      createReferenceManager,
      createToolBroker,
      migrateKernelDatabase,
      openKernelDatabase,
    } = await import("@companion/kernel");
    const { createHash } = await import("node:crypto");
    const calendarKey = (
      connectorInstanceId: string,
      calendarId: string,
      eventId: string,
    ): string =>
      `calendar:${createHash("sha256")
        .update(JSON.stringify([connectorInstanceId, calendarId, eventId]))
        .digest("hex")}`;
    const handle = openKernelDatabase(":memory:");
    try {
      await migrateKernelDatabase({ db: handle.raw });
      const repo = createKernelRepository(handle.raw);
      const manager = createReferenceManager(handle.raw);
      const oldRow = manager.ensureCalendarConnectorInstance(
        CALENDAR_CONNECTOR_DISPLAY_NAME,
        "primary",
        {},
      );
      const newRow = manager.ensureCalendarConnectorInstance(
        GOOGLE_READONLY_CONNECTOR_DISPLAY_NAME,
        "primary",
        {},
      );
      expect(newRow.id).not.toBe(oldRow.id);
      const sessionId = repo.createSession({
        key: randomUUID(),
        now: 1790000000000,
      }).body.sessionId;
      const posted = repo.postMessage(
        sessionId,
        { text: "calendar please" },
        { key: randomUUID(), now: 1790000000000 },
      );
      const runId = posted.body.run.id;
      repo.startRun(runId, { now: 1790000000001 });
      const oldKey = calendarKey(oldRow.id, "primary", "evt-old");
      const newKey = calendarKey(newRow.id, "primary", "evt-old");
      expect(newKey).not.toBe(oldKey);
      const presented = manager.presentObservations(
        sessionId,
        runId,
        [
          {
            connectorInstanceId: oldRow.id,
            canonicalKey: oldKey,
            title: "Old event",
            text: "old body",
            sourceRevision: "rev-1",
            observedAt: 1790000000002,
          },
        ],
        { freshness: "normal", now: 1790000000002 },
      );
      expect(presented.applied).toBe(true);
      const oldReferenceId =
        presented.applied === true
          ? (presented.references[0]?.referenceId as string)
          : "";
      const targetStore = createInMemoryCalendarTargetStore();
      targetStore.put(oldKey, { calendarId: "primary", eventId: "evt-old" });
      let getCalls = 0;
      const newPort = {
        connectorInstanceId: newRow.id,
        search: async () => ({ ok: false as const, code: "mcp_unavailable" }),
        get: async () => {
          getCalls += 1;
          return { ok: false as const, code: "calendar_upstream_error" };
        },
      };
      const registrations = createM1ToolRegistrations({
        db: handle.raw,
        repo,
        referenceManager: manager,
        bindings: [],
        calendarBinding: { connectorInstanceId: newRow.id, connector: newPort },
        calendarTargetStore: targetStore,
      });
      const broker = createToolBroker({ db: handle.raw, repo, registrations });
      const refreshed = await broker.invoke(
        runId,
        "reference.refresh",
        { referenceId: oldReferenceId },
        { origin: "test-origin", caller: "test-caller" },
      );
      expect(refreshed.result.actualOutcome).toBe("failed");
      expect(refreshed.result.errorCode).toBe("reference_not_found");
      expect(getCalls).toBe(0);
      expect(
        createDurableCalendarTargetStore(handle.raw).get(oldKey),
      ).toBeUndefined();
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
