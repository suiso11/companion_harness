// Companion online backup helper tests: real SQLite temp DBs, no mocks.
//
// Covers: successful online backup of a live DB + integrity_check of the
// copy, `companion-` generation pruning, and pruning of the legacy
// `companion-manual-*.sqlite` generations the old CLI wrote into the DB's
// own backups dir.

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  backupDb,
  pruneGenerations,
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
  const dir = mkdtempSync(join(tmpdir(), "companion-online-backup-"));
  tempDirs.push(dir);
  return dir;
}

function makeDb(path: string, rows: number): void {
  const db = new DatabaseSync(path);
  try {
    db.exec("CREATE TABLE sessions (id INTEGER PRIMARY KEY, body TEXT)");
    const insert = db.prepare("INSERT INTO sessions (body) VALUES (?)");
    for (let i = 0; i < rows; i += 1) {
      insert.run(`session-${i}`);
    }
  } finally {
    db.close();
  }
}

describe("companion online backup", () => {
  it("backs up the live DB, verifies integrity, and prunes to newest N", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "companion.sqlite");
    makeDb(dbPath, 3);
    const outDir = join(dir, "backups");

    const kept: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const result = await backupDb({
        dbPath,
        outDir,
        keep: 2,
        prefix: "companion-",
        now: new Date(Date.UTC(2026, 9, 19 + i, 12, 0, 0)),
      });
      kept.push(result.file);
      expect(result.file).toMatch(/^companion-\d{8}T\d{6}Z-/);
    }

    const names = readdirSync(outDir).filter((n) => n.endsWith(".sqlite"));
    expect(names).toHaveLength(2);
    expect(names.sort()).toEqual(kept.slice(-2).sort());
    const copy = new DatabaseSync(join(outDir, kept[kept.length - 1] ?? ""), {
      readOnly: true,
    });
    try {
      const check = copy.prepare("PRAGMA integrity_check").get();
      const count = copy
        .prepare("SELECT COUNT(*) AS n FROM sessions")
        .get() as { n: number };
      expect(check?.integrity_check).toBe("ok");
      expect(count.n).toBe(3);
    } finally {
      copy.close();
    }
  });

  it("prunes legacy companion-manual-*.sqlite generations in the DB's own backups dir", () => {
    const dir = tempDir();
    const legacyDir = join(dir, "backups");
    mkdirSync(legacyDir, { recursive: true });
    for (let i = 0; i < 4; i += 1) {
      const path = join(
        legacyDir,
        `companion-manual-2026101${i}T000000Z-${i}.sqlite`,
      );
      writeFileSync(path, "");
    }
    // Make mtimes distinct and ordered oldest-first.
    const names = readdirSync(legacyDir);
    expect(names).toHaveLength(4);

    pruneGenerations(legacyDir, 2, undefined, "companion-manual-");

    const left = readdirSync(legacyDir).sort();
    expect(left).toHaveLength(2);
    expect(left[0]).toContain("2026101");
    expect(left.every((n) => n.startsWith("companion-manual-"))).toBe(true);
  });
});
