// Ops notify CLI tests: bounded argv surface, fixed safe errors, and real
// kernel writes on a real migrated SQLite file (WAL, dedupe by fingerprint).

import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeKernelDatabase,
  createKernelRepository,
  listNotificationsForward,
  migrateKernelDatabase,
  openKernelDatabase,
} from "@companion/kernel";
import { afterEach, describe, expect, it } from "vitest";
import {
  NOTIFY_USAGE,
  OpsNotifyCliError,
  parseNotifyArgv,
  runNotifyCli,
} from "../src/ops_notify_cli.js";

const tempRoots: string[] = [];
afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop() as string;
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "companion-ops-notify-"));
  tempRoots.push(dir);
  return dir;
}

/** Real migrated WAL store with two sessions, closed for CLI use. */
async function makeSeededDb(dir: string): Promise<string> {
  const dbPath = join(dir, "companion.sqlite");
  const handle = openKernelDatabase(dbPath);
  await migrateKernelDatabase({ db: handle.raw });
  const repo = createKernelRepository(handle.raw);
  repo.createSession({ key: randomUUID(), now: 1_700_001_000_000 });
  repo.createSession({ key: randomUUID(), now: 1_700_001_000_001 });
  closeKernelDatabase(handle);
  return dbPath;
}

function envFor(dbPath: string): NodeJS.ProcessEnv {
  return {
    COMPANION_DB_PATH: dbPath,
    COMPANION_HOST: "127.0.0.1",
    COMPANION_PORT: "0",
    COMPANION_TIME_ZONE: "UTC",
    COMPANION_LOG_LEVEL: "error",
  };
}

const GOOD_ARGS = [
  "--level",
  "info",
  "--title",
  "deploy finished",
  "--body",
  "validation ok",
  "--source",
  "ops:deploy:abc12345",
  "--subject",
  "deploy-run-42",
];

describe("notify argv parsing", () => {
  it("parses the exact bounded flags only", () => {
    expect(parseNotifyArgv(GOOD_ARGS)).toEqual({
      level: "info",
      title: "deploy finished",
      body: "validation ok",
      source: "ops:deploy:abc12345",
      subject: "deploy-run-42",
    });
  });

  it("accepts only the fixed level enum info|error", () => {
    expect(() =>
      parseNotifyArgv(["--level", "warn", ...GOOD_ARGS.slice(2)]),
    ).toThrow(/bad|Use:/);
    expect(() =>
      parseNotifyArgv(["--level", "error", ...GOOD_ARGS.slice(2)] as string[]),
    ).not.toThrow();
  });

  it("rejects unknown flags, dangling values, and missing flags", () => {
    expect(() => parseNotifyArgv(["--secret", "x", "--level", "info"])).toThrow(
      OpsNotifyCliError,
    );
    expect(() => parseNotifyArgv(["--level"])).toThrow(NOTIFY_USAGE);
    expect(() => parseNotifyArgv(GOOD_ARGS.slice(2))).toThrow(
      OpsNotifyCliError,
    );
  });
});

describe("notify CLI run against the kernel repository", () => {
  it("records a notice into every session and output is fixed safe text", async () => {
    const dir = tempDir();
    const dbPath = await makeSeededDb(dir);
    const out = runNotifyCli(GOOD_ARGS, envFor(dbPath));
    expect(out).toBe("ops notify info: recorded=2 deduped=0");
    expect(out).not.toContain(dbPath);
    expect(out).not.toContain(dir);
  });

  it("dedupes identical content and reflects level -> priority", async () => {
    const dir = tempDir();
    const dbPath = await makeSeededDb(dir);
    const errorArgs = ["--level", "error", ...GOOD_ARGS.slice(2)];
    expect(runNotifyCli(errorArgs, envFor(dbPath))).toBe(
      "ops notify error: recorded=2 deduped=0",
    );
    expect(runNotifyCli(errorArgs, envFor(dbPath))).toBe(
      "ops notify error: recorded=0 deduped=2",
    );
    const handle = openKernelDatabase(dbPath);
    try {
      const rows = handle.raw
        .prepare(
          "SELECT DISTINCT priority, kind, scope FROM notifications WHERE scope = 'ops'",
        )
        .all() as { priority: string; kind: string; scope: string }[];
      expect(rows).toEqual([{ priority: "urgent", kind: "ops", scope: "ops" }]);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("new rows appear in the durable feed poll (no restart needed)", async () => {
    const dir = tempDir();
    const dbPath = await makeSeededDb(dir);
    runNotifyCli(GOOD_ARGS, envFor(dbPath));
    // The running server's notification SSE feed polls SQLite directly via
    // listNotificationsForward per session, so a fresh CLI write is visible
    // immediately to any attached feed without a server restart.
    const handle = openKernelDatabase(dbPath);
    try {
      const sessionId = (
        handle.raw.prepare("SELECT id FROM sessions ORDER BY id ASC").get() as
          | {
              id: string;
            }
          | undefined
      )?.id;
      if (sessionId !== undefined) {
        const page = listNotificationsForward(handle.raw, sessionId, {
          after: 0,
          limit: 10,
        });
        expect(page.items[0]?.briefText).toBe(
          "deploy finished — validation ok",
        );
      }
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("fails closed on a missing DB without creating one", () => {
    const dir = tempDir();
    const dbPath = join(dir, "companion.sqlite");
    expect(() => runNotifyCli(GOOD_ARGS, envFor(dbPath))).toThrow(
      /database missing/,
    );
    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
  });

  it("surfaces fixed invalid-configuration text and bounded validation", async () => {
    const dir = tempDir();
    const invalidEnv = {
      ...envFor(join(dir, "companion.sqlite")),
      COMPANION_PORT: "not-a-port",
    };
    try {
      runNotifyCli(GOOD_ARGS, invalidEnv);
      expect.fail("expected invalid configuration failure");
    } catch (error) {
      expect(error).toBeInstanceOf(OpsNotifyCliError);
      expect((error as OpsNotifyCliError).cliCode).toBe(
        "invalid_configuration",
      );
      expect((error as Error).message).toBe(
        "ops notify failed: invalid configuration",
      );
      expect((error as Error).message).not.toContain(dir);
    }
    const dbPath = await makeSeededDb(dir);
    const argsWith = (overrides: [string, string][]): string[] => [
      ...GOOD_ARGS,
      ...overrides.flat(),
    ];
    expect(() =>
      runNotifyCli(argsWith([["--title", "t".repeat(121)]]), envFor(dbPath)),
    ).toThrow("ops notify failed");
    expect(() =>
      runNotifyCli(argsWith([["--subject", "s".repeat(201)]]), envFor(dbPath)),
    ).toThrow("ops notify failed");
    // All CLI failure states carry fixed safe text only: no paths, no raw
    // repository error text, no argv echoes.
    const failure = (() => {
      try {
        runNotifyCli(
          argsWith([["--subject", "s".repeat(201)]]),
          envFor(dbPath),
        );
        return null;
      } catch (error) {
        return error as Error;
      }
    })();
    expect(failure).toBeInstanceOf(OpsNotifyCliError);
    expect((failure as OpsNotifyCliError).cliCode).toBe("notify_failed");
    expect((failure as Error).message).toBe("ops notify failed");
  });

  it("surfaces bounded source / level failures as fixed safe messages", async () => {
    const dir = tempDir();
    const dbPath = await makeSeededDb(dir);
    const env = envFor(dbPath);
    const failure = (() => {
      try {
        runNotifyCli(
          [
            "--level",
            "error",
            "--title",
            "ok",
            "--body",
            "b",
            "--source",
            "tiny", // < 8 chars: rejected by the kernel repository
            "--subject",
            "s",
          ],
          env,
        );
        return null;
      } catch (error) {
        return error as Error;
      }
    })();
    expect(failure).toBeInstanceOf(OpsNotifyCliError);
    expect((failure as OpsNotifyCliError).cliCode).toBe("notify_failed");
    expect((failure as Error).message).toBe("ops notify failed");
  });
});
