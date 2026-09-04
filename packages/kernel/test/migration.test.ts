// M0 migration behavior: fresh / older / newer databases, pre-upgrade
// backups (backup API -> .partial -> quick_check -> atomic rename),
// exact 3-generation rotation, and failure atomicity.
//
// All databases and backup directories live under os.tmpdir() and are
// removed in afterEach. Deterministic backup names use injected now/ids.

import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  BackupRequiredError,
  BUNDLED_SCHEMA_VERSION,
  closeKernelDatabase,
  createManualBackup,
  createPreMigrationBackup,
  getSchemaVersion,
  hasUserTables,
  listMigrations,
  listPreMigrationBackups,
  MANUAL_BACKUP_PREFIX,
  manualBackupName,
  migrateKernelDatabase,
  NewerDatabaseError,
  openKernelDatabase,
  PRE_MIGRATION_KEEP_GENERATIONS,
  PRE_MIGRATION_PREFIX,
  prunePreMigrationBackups,
  quickCheck,
  setSchemaVersion,
} from "../src/index.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop() as string;
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "m0-kernel-migrate-"));
  tempRoots.push(dir);
  return dir;
}

function tableNames(db: Database.Database): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

const BACKUP_NAME_PATTERN =
  /^companion-pre-migration-v0-to-v1-\d{8}T\d{6}Z-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.sqlite$/;

describe("m0 migration lifecycle", () => {
  it("migrates a fresh DB to the bundled version with no backup", async () => {
    const dir = tempDir();
    const file = join(dir, "kernel.sqlite");
    const backups = join(dir, "backups");
    const handle = openKernelDatabase(file);
    try {
      const result = await migrateKernelDatabase({
        db: handle.raw,
        backupDir: backups,
      });
      expect(result).toMatchObject({
        migrated: true,
        fromVersion: 0,
        toVersion: BUNDLED_SCHEMA_VERSION,
        applied: [1],
      });
      expect(result.backupPath).toBeUndefined();
      expect(getSchemaVersion(handle.raw)).toBe(BUNDLED_SCHEMA_VERSION);
      expect(tableNames(handle.raw)).toContain("runs");
      expect(readdirSync(dir)).not.toContain("backups");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("treats equal-version startup as a no-op with no backup", async () => {
    const dir = tempDir();
    const file = join(dir, "kernel.sqlite");
    const backups = join(dir, "backups");
    const handle = openKernelDatabase(file);
    try {
      await migrateKernelDatabase({ db: handle.raw, backupDir: backups });
      const second = await migrateKernelDatabase({
        db: handle.raw,
        backupDir: backups,
      });
      expect(second.migrated).toBe(false);
      expect(second.backupPath).toBeUndefined();
      expect(readdirSync(dir)).not.toContain("backups");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("fails before migration on a newer DB without side effects", async () => {
    const dir = tempDir();
    const file = join(dir, "kernel.sqlite");
    const backups = join(dir, "backups");
    const handle = openKernelDatabase(file);
    try {
      setSchemaVersion(handle.raw, BUNDLED_SCHEMA_VERSION + 98);
      const failure = await migrateKernelDatabase({
        db: handle.raw,
        backupDir: backups,
      }).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(NewerDatabaseError);
      expect((failure as NewerDatabaseError).currentVersion).toBe(
        BUNDLED_SCHEMA_VERSION + 98,
      );
      expect(tableNames(handle.raw)).toEqual([]);
      expect(readdirSync(dir)).not.toContain("backups");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("backs up an older non-empty DB before upgrading", async () => {
    const dir = tempDir();
    const file = join(dir, "kernel.sqlite");
    const backups = join(dir, "backups");
    const raw = new Database(file);
    raw.pragma("journal_mode = WAL");
    raw.exec("CREATE TABLE legacy (v TEXT NOT NULL) STRICT");
    raw.prepare("INSERT INTO legacy (v) VALUES ('keep-me')").run();
    raw.close();

    const handle = openKernelDatabase(file);
    try {
      const result = await migrateKernelDatabase({
        db: handle.raw,
        backupDir: backups,
        now: new Date("2026-09-04T03:59:59.000Z"),
        backupId: "11111111-2222-4333-8444-555555555555",
      });
      expect(result.migrated).toBe(true);
      expect(result.backupPath).toMatch(
        /companion-pre-migration-v0-to-v1-.*\.sqlite$/,
      );
      const name = (result.backupPath as string).split(/[\\/]/).pop() as string;
      expect(name).toMatch(BACKUP_NAME_PATTERN);
      // No .partial residue next to the final backup.
      expect(
        readdirSync(backups).filter((entry) => entry.endsWith(".partial")),
      ).toEqual([]);
      // Backup copy passes quick_check and holds the legacy table.
      const copy = new Database(result.backupPath as string, {
        readonly: true,
      });
      try {
        expect(quickCheck(copy)).toBe("ok");
        const kept = copy.prepare("SELECT v FROM legacy").get() as {
          v: string;
        };
        expect(kept.v).toBe("keep-me");
      } finally {
        copy.close();
      }
      // Live DB upgraded in place with legacy data preserved.
      expect(getSchemaVersion(handle.raw)).toBe(BUNDLED_SCHEMA_VERSION);
      expect(tableNames(handle.raw)).toContain("runs");
      const kept = handle.raw.prepare("SELECT v FROM legacy").get() as {
        v: string;
      };
      expect(kept.v).toBe("keep-me");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("requires a backup directory when upgrading a non-empty older DB", async () => {
    const dir = tempDir();
    const file = join(dir, "kernel.sqlite");
    const setup = new Database(file);
    setup.exec("CREATE TABLE legacy (v TEXT NOT NULL) STRICT");
    setup.close();
    const handle = openKernelDatabase(file);
    try {
      await expect(
        migrateKernelDatabase({ db: handle.raw }),
      ).rejects.toBeInstanceOf(BackupRequiredError);
      expect(getSchemaVersion(handle.raw)).toBe(0);
      expect(tableNames(handle.raw)).toEqual(["legacy"]);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("aborts migration when the backup fails and keeps the DB version", async () => {
    const dir = tempDir();
    const file = join(dir, "kernel.sqlite");
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "not-a-directory");
    const setup = new Database(file);
    setup.exec("CREATE TABLE legacy (v TEXT NOT NULL) STRICT");
    setup.close();
    const handle = openKernelDatabase(file);
    try {
      await expect(
        migrateKernelDatabase({ db: handle.raw, backupDir: blocker }),
      ).rejects.toThrow();
      expect(getSchemaVersion(handle.raw)).toBe(0);
      expect(tableNames(handle.raw)).toEqual(["legacy"]);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("applies pending migrations sequentially and detects gaps", async () => {
    const dir = tempDir();
    const migrations = join(dir, "migrations");
    mkdirSync(migrations, { recursive: true });
    writeFileSync(
      join(migrations, "0001_first.sql"),
      "CREATE TABLE t1 (a TEXT NOT NULL) STRICT;",
    );
    writeFileSync(
      join(migrations, "0002_second.sql"),
      "CREATE TABLE t2 (b TEXT NOT NULL) STRICT;",
    );
    writeFileSync(join(migrations, "README.md"), "ignored");
    expect(listMigrations(migrations).map((entry) => entry.version)).toEqual([
      1, 2,
    ]);

    const handle = openKernelDatabase(":memory:");
    try {
      const result = await migrateKernelDatabase({
        db: handle.raw,
        migrationsDir: migrations,
        targetVersion: 2,
      });
      expect(result.applied).toEqual([1, 2]);
      expect(getSchemaVersion(handle.raw)).toBe(2);
      expect(tableNames(handle.raw)).toEqual(["t1", "t2"]);
    } finally {
      closeKernelDatabase(handle);
    }

    const gapped = join(dir, "gapped");
    mkdirSync(gapped, { recursive: true });
    writeFileSync(
      join(gapped, "0002_only.sql"),
      "CREATE TABLE t2 (b TEXT NOT NULL) STRICT;",
    );
    const other = openKernelDatabase(":memory:");
    try {
      await expect(
        migrateKernelDatabase({
          db: other.raw,
          migrationsDir: gapped,
          targetVersion: 2,
        }),
      ).rejects.toThrow(/no committed migration covers/);
    } finally {
      closeKernelDatabase(other);
    }
  });

  it("keeps the valid backup when migration SQL fails", async () => {
    const dir = tempDir();
    const migrations = join(dir, "migrations");
    mkdirSync(migrations, { recursive: true });
    writeFileSync(
      join(migrations, "0001_broken.sql"),
      "CREATE TABLE broken (oops INVALID SYNTAX HERE) STRICT;",
    );
    const backups = join(dir, "backups");
    const handle = openKernelDatabase(":memory:");
    try {
      handle.raw.exec("CREATE TABLE legacy (v TEXT NOT NULL) STRICT");
      await expect(
        migrateKernelDatabase({
          db: handle.raw,
          backupDir: backups,
          migrationsDir: migrations,
          targetVersion: 1,
        }),
      ).rejects.toThrow(/migration 0 -> 1 failed/);
      const kept = listPreMigrationBackups(backups);
      expect(kept).toHaveLength(1);
      const copy = new Database(kept[0] as string, { readonly: true });
      try {
        expect(quickCheck(copy)).toBe("ok");
      } finally {
        copy.close();
      }
      expect(getSchemaVersion(handle.raw)).toBe(0);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

describe("m0 pre-migration backup rotation", () => {
  it("keeps exactly 3 generations and never touches manual backups", async () => {
    const dir = tempDir();
    const backups = join(dir, "backups");
    mkdirSync(backups, { recursive: true });
    // Five aging pre-migration backups plus one manual backup.
    for (let i = 0; i < 5; i += 1) {
      const seed = new Database(join(backups, `seed-${i}.sqlite`));
      seed.exec("CREATE TABLE s (v TEXT NOT NULL) STRICT");
      seed.close();
      const name = `${PRE_MIGRATION_PREFIX}v0-to-v1-2026010${i}T000000Z-11111111-2222-4333-8444-55555555555${i}.sqlite`;
      renameSync(join(backups, `seed-${i}.sqlite`), join(backups, name));
      const atime = new Date(Date.UTC(2026, 0, i + 1));
      utimesSync(join(backups, name), atime, atime);
    }
    const manualDb = new Database(
      join(backups, "companion-manual-20260101T000000Z-aaaa.sqlite"),
    );
    manualDb.exec("CREATE TABLE m (v TEXT NOT NULL) STRICT");
    manualDb.close();

    const source = openKernelDatabase(":memory:");
    try {
      await createPreMigrationBackup({
        source: source.raw,
        backupDir: backups,
        fromVersion: 0,
        toVersion: 1,
        now: new Date("2026-09-04T03:59:59.000Z"),
        backupId: randomUUID(),
      });
    } finally {
      closeKernelDatabase(source);
    }
    const remaining = readdirSync(backups).sort();
    expect(remaining).toContain(
      "companion-manual-20260101T000000Z-aaaa.sqlite",
    );
    const keptPre = remaining.filter((n) => n.startsWith(PRE_MIGRATION_PREFIX));
    expect(keptPre).toHaveLength(PRE_MIGRATION_KEEP_GENERATIONS);
    // Five seeds (20260100..20260104) plus the new September backup: keep
    // the 3 newest overall, so the three oldest January seeds are pruned.
    expect(keptPre.some((n) => n.includes("20260100T000000Z"))).toBe(false);
    expect(keptPre.some((n) => n.includes("20260101T000000Z"))).toBe(false);
    expect(keptPre.some((n) => n.includes("20260102T000000Z"))).toBe(false);
    expect(keptPre.some((n) => n.includes("20260103T000000Z"))).toBe(true);
    expect(keptPre.some((n) => n.includes("20260104T000000Z"))).toBe(true);
  });

  it("prunes oldest-first and removes no manual files", () => {
    const dir = tempDir();
    const backups = join(dir, "backups");
    mkdirSync(backups, { recursive: true });
    const names: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const name = `${PRE_MIGRATION_PREFIX}v0-to-v1-2026020${i}T000000Z-11111111-2222-4333-8444-55555555555${i}.sqlite`;
      writeFileSync(join(backups, name), "x");
      names.push(name);
      const stamp = new Date(Date.UTC(2026, 1, i + 1));
      utimesSync(join(backups, name), stamp, stamp);
    }
    writeFileSync(join(backups, "companion-manual-keep.sqlite"), "x");
    writeFileSync(join(backups, "unrelated.txt"), "x");
    const { kept, pruned } = prunePreMigrationBackups(backups, 3);
    expect(kept).toHaveLength(3);
    expect(pruned).toHaveLength(1);
    expect(pruned[0]?.endsWith(names[0] as string)).toBe(true);
    expect(
      statSync(join(backups, "companion-manual-keep.sqlite")).isFile(),
    ).toBe(true);
  });
});

describe("m0 manual backup (stopped-only, never rotated)", () => {
  const MANUAL_PATTERN =
    /^companion-manual-\d{8}T\d{6}Z-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.sqlite$/;

  it("names exact manual backups that never match the pre-migration prefix", () => {
    const name = manualBackupName(
      new Date("2026-09-04T03:59:59.000Z"),
      "11111111-2222-4333-8444-555555555555",
    );
    expect(name).toBe(
      "companion-manual-20260904T035959Z-11111111-2222-4333-8444-555555555555.sqlite",
    );
    expect(name).toMatch(MANUAL_PATTERN);
    expect(name.startsWith(PRE_MIGRATION_PREFIX)).toBe(false);
    expect(MANUAL_BACKUP_PREFIX.startsWith(PRE_MIGRATION_PREFIX)).toBe(false);
  });

  it("takes a manual backup via backup API + quick_check + rename, unrotated", async () => {
    const dir = tempDir();
    const backups = join(dir, "backups");
    const source = openKernelDatabase(":memory:");
    try {
      const first = await createManualBackup({
        source: source.raw,
        backupDir: backups,
        now: new Date("2026-09-04T03:59:59.000Z"),
        backupId: "11111111-2222-4333-8444-555555555555",
      });
      const second = await createManualBackup({
        source: source.raw,
        backupDir: backups,
        now: new Date("2026-09-05T00:00:00.000Z"),
        backupId: "22222222-3333-4444-8555-666666666666",
      });
      for (const path of [first, second]) {
        const name = path.split(/[\\/]/).pop() as string;
        expect(name).toMatch(MANUAL_PATTERN);
        const copy = new Database(path, { readonly: true });
        try {
          expect(quickCheck(copy)).toBe("ok");
        } finally {
          copy.close();
        }
      }
      // No .partial residue, no rotation: both manual backups remain.
      expect(
        readdirSync(backups).filter((entry) => entry.endsWith(".partial")),
      ).toEqual([]);
      expect(readdirSync(backups)).toHaveLength(2);
      // Pre-migration rotation never touches manual backups.
      const { kept } = prunePreMigrationBackups(backups, 3);
      expect(kept).toHaveLength(0);
      expect(readdirSync(backups)).toHaveLength(2);
    } finally {
      closeKernelDatabase(source);
    }
  });

  it("uses only the backup API (no VACUUM INTO / raw copy)", () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(testDir, "..", "src", "backup.ts"), "utf8");
    expect(src).toContain(".backup(");
    expect(src).not.toContain("VACUUM");
    expect(src).not.toContain("copyFile");
  });
});

describe("m0 storage helpers and provenance", () => {
  it("exposes version helpers with sane validation", async () => {
    const handle = openKernelDatabase(":memory:");
    try {
      expect(getSchemaVersion(handle.raw)).toBe(0);
      expect(hasUserTables(handle.raw)).toBe(false);
      setSchemaVersion(handle.raw, 1);
      expect(getSchemaVersion(handle.raw)).toBe(1);
      expect(() => setSchemaVersion(handle.raw, -1)).toThrow(RangeError);
      handle.raw.exec("CREATE TABLE t (a TEXT NOT NULL) STRICT");
      expect(hasUserTables(handle.raw)).toBe(true);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("quickCheck passes on healthy DBs and close is idempotent", async () => {
    const handle = await openKernelDatabase(":memory:");
    try {
      await migrateKernelDatabase({ db: handle.raw });
      expect(quickCheck(handle.raw)).toBe("ok");
    } finally {
      closeKernelDatabase(handle);
      expect(handle.raw.open).toBe(false);
      expect(() => closeKernelDatabase(handle)).not.toThrow();
    }
  });

  it("keeps migration provenance in the package (static check)", async () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const kernelDir = join(testDir, "..");
    const sql = readFileSync(
      join(kernelDir, "migrations", "0001_m0_foundation.sql"),
      "utf8",
    );
    expect(sql).toContain("CREATE TABLE sessions");
    expect(sql).toContain("CREATE TABLE api_idempotency");
    expect(sql).toContain("idx_runs_one_active_per_session");
    const journal = JSON.parse(
      readFileSync(
        join(kernelDir, "migrations", "meta", "_journal.json"),
        "utf8",
      ),
    ) as { entries: Array<{ tag: string }> };
    expect(journal.entries.map((entry) => entry.tag)).toContain(
      "0001_m0_foundation",
    );
    const backupSrc = readFileSync(join(kernelDir, "src", "backup.ts"), "utf8");
    expect(backupSrc).toContain(".backup(");
    expect(backupSrc).not.toContain("VACUUM");
    expect(backupSrc).not.toContain("copyFile");
    const migrateSrc = readFileSync(
      join(kernelDir, "src", "migrate.ts"),
      "utf8",
    );
    expect(migrateSrc).not.toContain("drizzle-kit");
    expect(migrateSrc).toContain("user_version");
    const kernelPkg = JSON.parse(
      readFileSync(join(kernelDir, "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(kernelPkg.dependencies ?? {}).not.toHaveProperty("drizzle-kit");
    expect(kernelPkg.devDependencies ?? {}).not.toHaveProperty("drizzle-kit");
  });
});
