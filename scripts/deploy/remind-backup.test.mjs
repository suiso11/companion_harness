// Regression tests for the live ops-notify bugs (2026-10-20):
// backupDb must leave NO `.partial-*` sidecar files in the backup root,
// on success and failure alike (node / sqlite-side / runtime failures).
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { backupDb } from "./remind-backup.mjs";

function makeSrcDbSync(dir) {
  const path = join(dir, "src.sqlite");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE t (x INTEGER)");
  db.exec("INSERT INTO t VALUES (1)");
  db.close();
  return path;
}

describe("backupDb sidecar hygiene (live bug regression)", () => {
  it("leaves no .partial / -wal / -shm files after success", async () => {
    const work = mkdtempSync(join(tmpdir(), "bk-test-"));
    try {
      const src = makeSrcDbSync(work);
      const outDir = join(work, "out");
      const res = await backupDb({ dbPath: src, outDir, keep: 3 });
      expect(typeof res.file).toBe("string");
      const names = readdirSync(outDir);
      expect(names.some((n) => n.includes(".partial"))).toBe(false);
      expect(names.some((n) => n.endsWith("-wal") || n.endsWith("-shm"))).toBe(
        false,
      );
      expect(names.some((n) => n.startsWith(".tmp-"))).toBe(false);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("leaves no sidecars when the source db is missing (failure path)", async () => {
    const work = mkdtempSync(join(tmpdir(), "bk-test-"));
    try {
      const outDir = join(work, "out");
      await expect(() =>
        backupDb({
          dbPath: join(work, "does-not-exist.sqlite"),
          outDir,
          keep: 3,
        }),
      ).rejects.toThrow(/unable to open database file/);
      const names = readdirSync(outDir).filter(
        (n) => !n.startsWith(".tmp-"), // empty temp dirs are cleaned below
      );
      // No backup, no partial, no sidecars in the backup root.
      expect(names.some((n) => n.includes(".partial"))).toBe(false);
      expect(names.some((n) => n.endsWith("-wal") || n.endsWith("-shm"))).toBe(
        false,
      );
      // Temp staging dirs are removed even on failure.
      expect(readdirSync(outDir).some((n) => n.startsWith(".tmp-"))).toBe(
        false,
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
