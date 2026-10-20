// remind online backup helper tests: real SQLite temp DBs, no mocks.
//
// Covers: successful online backup + integrity_check of the copy,
// generation pruning, and the failure path (a missing DB must fail and
// leave the previous generation intact).

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  backupRemindDb,
  defaultConfigPath,
  resolveRemindDbPath,
} from "../../../scripts/deploy/remind-backup.mjs";

let tempDirs: string[] = [];

afterEach(() => {
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

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "companion-remind-backup-"));
  tempDirs.push(dir);
  return dir;
}

function makeDb(path: string, rows: number): void {
  const db = new DatabaseSync(path);
  try {
    db.exec("CREATE TABLE memories (id INTEGER PRIMARY KEY, body TEXT)");
    const insert = db.prepare("INSERT INTO memories (body) VALUES (?)");
    for (let i = 0; i < rows; i += 1) {
      insert.run(`memory-${i}`);
    }
  } finally {
    db.close();
  }
}

function writeConfig(dir: string, dbPath: string): string {
  const configPath = join(dir, "memory.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({ dbPath, vaultPath: "./vault", allowedScopes: [] }),
  );
  return configPath;
}

describe("remind online backup", () => {
  it("resolves dbPath relative to the config file", () => {
    const dir = tempDir();
    const configPath = writeConfig(dir, "./data/memory.db");
    expect(resolveRemindDbPath(configPath)).toBe(
      join(dir, "data", "memory.db"),
    );
    expect(defaultConfigPath({ XDG_CONFIG_HOME: "/tmp/xdg" })).toBe(
      join("/tmp/xdg", "remind", "memory.config.json"),
    );
  });

  it("backs up a live-format DB and verifies integrity", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "memory.db");
    makeDb(dbPath, 3);
    const configPath = writeConfig(dir, "./memory.db");
    const outDir = join(dir, "backups");

    const result = await backupRemindDb({
      configPath,
      outDir,
      keep: 7,
      now: new Date("2026-10-19T12:00:00Z"),
    });

    expect(result.file).toMatch(/^remind-\d{8}T\d{6}Z-/);
    const copy = new DatabaseSync(result.path, { readOnly: true });
    try {
      const check = copy.prepare("PRAGMA integrity_check").get();
      const count = copy
        .prepare("SELECT COUNT(*) AS n FROM memories")
        .get() as { n: number };
      expect(check?.integrity_check).toBe("ok");
      expect(count.n).toBe(3);
    } finally {
      copy.close();
    }
  });

  it("keeps the previous generation when the new backup fails", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "memory.db");
    makeDb(dbPath, 1);
    const configPath = writeConfig(dir, "./memory.db");
    const outDir = join(dir, "backups");

    const first = await backupRemindDb({
      configPath,
      outDir,
      keep: 7,
      now: new Date("2026-10-19T12:00:00Z"),
    });

    rmSync(dbPath);
    await expect(
      backupRemindDb({
        configPath,
        outDir,
        keep: 7,
        now: new Date("2026-10-20T12:00:00Z"),
      }),
    ).rejects.toThrow(/database missing/);

    const names = readdirSync(outDir).filter((n) => n.endsWith(".sqlite"));
    expect(names).toEqual([first.file]);
    expect(readdirSync(outDir).some((n) => n.endsWith(".partial"))).toBe(false);
  });

  it("prunes to the newest N generations only after success", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "memory.db");
    makeDb(dbPath, 2);
    const configPath = writeConfig(dir, "./memory.db");
    const outDir = join(dir, "backups");

    const kept: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const result = await backupRemindDb({
        configPath,
        outDir,
        keep: 2,
        now: new Date(Date.UTC(2026, 9, 19 + i, 12, 0, 0)),
      });
      kept.push(result.file);
    }

    const names = readdirSync(outDir).filter((n) => n.endsWith(".sqlite"));
    expect(names).toHaveLength(2);
    expect(names.sort()).toEqual(kept.slice(-2).sort());
  });
});
