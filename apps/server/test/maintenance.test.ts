// Maintenance tests: DB+WAL size warning (injected stat, no 1 GiB file),
// fixed log codes, and stopped-only manual CLI via the backup API only.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openKernelDatabase, closeKernelDatabase } from "@companion/kernel";
import { runManualBackupCli } from "../src/cli.js";
import { sanitizeLogStatus } from "../src/logger.js";
import {
  measureStoreSize,
  shouldWarnStoreSize,
  STORE_SIZE_WARN_BYTES,
} from "../src/maintenance.js";

const tempRoots: string[] = [];
afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop() as string;
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "companion-maintenance-"));
  tempRoots.push(dir);
  return dir;
}

describe("store size warning", () => {
  it("threshold is exactly 1 GiB, warning only above it", () => {
    expect(STORE_SIZE_WARN_BYTES).toBe(1024 * 1024 * 1024);
    expect(shouldWarnStoreSize(STORE_SIZE_WARN_BYTES)).toBe(false);
    expect(shouldWarnStoreSize(STORE_SIZE_WARN_BYTES + 1)).toBe(true);
    expect(shouldWarnStoreSize(0)).toBe(false);
  });

  it("combines DB+WAL with injected sizes (no real 1 GiB file)", () => {
    const sizes = new Map<string, number>([
      ["/data/companion.sqlite", STORE_SIZE_WARN_BYTES - 10],
      ["/data/companion.sqlite-wal", 11],
    ]);
    const size = measureStoreSize("/data/companion.sqlite", (path) => ({
      size: sizes.get(path) ?? 0,
    }));
    expect(size.dbBytes).toBe(STORE_SIZE_WARN_BYTES - 10);
    expect(size.walBytes).toBe(11);
    expect(size.totalBytes).toBe(STORE_SIZE_WARN_BYTES + 1);
    expect(shouldWarnStoreSize(size.totalBytes)).toBe(true);
    // Missing WAL counts as 0, never throws, never includes the path.
    const missing = measureStoreSize("/data/companion.sqlite", (path) => {
      if (path.endsWith("-wal")) {
        throw Object.assign(new Error("nope"), { code: "ENOENT" });
      }
      return { size: 5 };
    });
    expect(missing).toEqual({ dbBytes: 5, walBytes: 0, totalBytes: 5 });
    expect(JSON.stringify(missing)).not.toContain("/data/");
  });

  it("sanitizes arbitrary status strings to fixed codes", () => {
    expect(sanitizeLogStatus("sigint")).toBe("sigint");
    expect(sanitizeLogStatus(202)).toBe(202);
    expect(sanitizeLogStatus("test-teardown")).toBe("unknown");
    expect(sanitizeLogStatus("Drain Boom!")).toBe("unknown");
    expect(sanitizeLogStatus("Error: boom\npath=/etc")).toBe("unknown");
  });

  it("uses a closed status vocabulary (arbitrary lowercase maps to unknown)", () => {
    // Genuinely closed: even well-formed lowercase strings outside M0 are unknown.
    expect(sanitizeLogStatus("foobar")).toBe("unknown");
    expect(sanitizeLogStatus("ready")).toBe("unknown");
    expect(sanitizeLogStatus("injected_code")).toBe("unknown");
    // Case-insensitive members still map to the canonical member.
    expect(sanitizeLogStatus("SIGINT")).toBe("sigint");
    expect(sanitizeLogStatus("Unknown")).toBe("unknown");
    // Known M0 startup codes are preserved.
    expect(sanitizeLogStatus("newer_database")).toBe("newer_database");
    expect(sanitizeLogStatus("server_config_invalid")).toBe("server_config_invalid");
    expect(sanitizeLogStatus("kernel_backup_failed")).toBe("kernel_backup_failed");
    // Numeric statuses (migration versions, recovery counts) are preserved.
    expect(sanitizeLogStatus(0)).toBe(0);
    expect(sanitizeLogStatus(Number.NaN)).toBe(undefined);
    expect(sanitizeLogStatus(undefined)).toBe(undefined);
  });
});

describe("manual backup CLI (stopped-only, backup API only)", () => {
  it("creates an exact manual backup without starting a listener", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "companion.sqlite");
    const handle = openKernelDatabase(dbPath);
    closeKernelDatabase(handle);
    const env: NodeJS.ProcessEnv = {
      COMPANION_DB_PATH: dbPath,
      COMPANION_HOST: "127.0.0.1",
      COMPANION_PORT: "0",
      COMPANION_TIME_ZONE: "UTC",
      COMPANION_LOG_LEVEL: "error",
    };
    const backupPath = await runManualBackupCli(["backup"], env);
    expect(backupPath).toContain("companion-manual-");
    expect(backupPath.endsWith(".sqlite")).toBe(true);
    expect(backupPath).not.toContain("companion-pre-migration-");
    // Hardened output: basename only, never an absolute path.
    expect(backupPath).not.toContain("/");
    expect(backupPath).not.toContain("\\");
    expect(backupPath).toMatch(/^companion-manual-.*\.sqlite$/);
  });

  it("rejects unknown commands without side effects", async () => {
    await expect(runManualBackupCli(["restore"])).rejects.toThrow(/unknown command/);
  });

  it("rejects path override flags and extra args with fixed text", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "companion.sqlite");
    const handle = openKernelDatabase(dbPath);
    closeKernelDatabase(handle);
    const env: NodeJS.ProcessEnv = {
      COMPANION_DB_PATH: dbPath,
      COMPANION_HOST: "127.0.0.1",
      COMPANION_PORT: "0",
      COMPANION_TIME_ZONE: "UTC",
      COMPANION_LOG_LEVEL: "error",
    };
    await expect(runManualBackupCli(["backup", "--db", dbPath], env)).rejects.toThrow(
      /accepts no arguments/,
    );
    await expect(
      runManualBackupCli(["backup", "--backups", join(dir, "backups")], env),
    ).rejects.toThrow(/accepts no arguments/);
    await expect(runManualBackupCli(["backup", "extra"], env)).rejects.toThrow(
      /accepts no arguments/,
    );
    await expect(runManualBackupCli([], env)).rejects.toThrow(/unknown command/);
  });

  it("fails on a missing DB without creating DB or backups", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "companion.sqlite");
    const env: NodeJS.ProcessEnv = {
      COMPANION_DB_PATH: dbPath,
      COMPANION_HOST: "127.0.0.1",
      COMPANION_PORT: "0",
      COMPANION_TIME_ZONE: "UTC",
      COMPANION_LOG_LEVEL: "error",
    };
    await expect(runManualBackupCli(["backup"], env)).rejects.toThrow(
      /database missing/,
    );
    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(join(dir, "backups"))).toBe(false);
  });

  it("emits only fixed safe error text (no paths, no raw errors)", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "companion.sqlite");
    const env: NodeJS.ProcessEnv = {
      COMPANION_DB_PATH: dbPath,
      COMPANION_HOST: "127.0.0.1",
      COMPANION_PORT: "0",
      COMPANION_TIME_ZONE: "UTC",
      COMPANION_LOG_LEVEL: "error",
    };
    const missing = await runManualBackupCli(["backup"], env).catch(
      (error: unknown) => error,
    );
    expect(missing).toBeInstanceOf(Error);
    expect((missing as Error).message).not.toContain(dbPath);
    expect((missing as Error).message).not.toContain(dir);
    const unknown = await runManualBackupCli(["restore"], env).catch(
      (error: unknown) => error,
    );
    expect((unknown as Error).message).not.toContain("restore\n");
  });
});
