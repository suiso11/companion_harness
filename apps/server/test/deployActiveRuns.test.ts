// Active-run deploy gate tests: resolveDbPath mirrors the server default,
// countActiveRuns is read-only and counts exactly queued/running/
// cancel_requested. No secrets, temp-dir SQLite only.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  ACTIVE_STATUSES,
  countActiveRuns,
  resolveDbPath,
} from "../../../scripts/deploy/activeRuns.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(
  here,
  "..",
  "..",
  "..",
  "scripts",
  "deploy",
  "activeRuns.mjs",
);

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

function makeDb(statuses: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "deploy-runs-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "companion.sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("CREATE TABLE runs (id TEXT PRIMARY KEY, status TEXT)");
    const insert = db.prepare("INSERT INTO runs (id, status) VALUES (?, ?)");
    statuses.forEach((status, i) => {
      insert.run(`run-${i}`, status);
    });
  } finally {
    db.close();
  }
  return dbPath;
}

describe("resolveDbPath", () => {
  it("honors COMPANION_DB_PATH", () => {
    expect(resolveDbPath({ COMPANION_DB_PATH: "/x/y.sqlite" })).toBe(
      "/x/y.sqlite",
    );
  });

  it("defaults to the OS app-data companion.sqlite", () => {
    const resolved = resolveDbPath({});
    expect(
      resolved.endsWith(join("companion-harness", "companion.sqlite")),
    ).toBe(true);
  });
});

describe("countActiveRuns", () => {
  it("exposes exactly the deploy-blocking statuses", () => {
    expect([...ACTIVE_STATUSES].sort()).toEqual([
      "cancel_requested",
      "queued",
      "running",
    ]);
  });

  it("counts queued/running/cancel_requested and ignores terminal states", async () => {
    const dbPath = makeDb([
      "queued",
      "running",
      "cancel_requested",
      "completed",
      "failed",
      "cancelled",
      "abandoned",
    ]);
    const result = await countActiveRuns(dbPath);
    expect(result).toMatchObject({ db: dbPath, active: 3 });
  });

  it("returns 0 for a missing DB file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "deploy-runs-"));
    tempDirs.push(dir);
    const result = await countActiveRuns(join(dir, "missing.sqlite"));
    expect(result).toMatchObject({ active: 0 });
  });

  it("returns 0 for a DB without a runs table", async () => {
    const dir = mkdtempSync(join(tmpdir(), "deploy-runs-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "empty.sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("CREATE TABLE other (id TEXT PRIMARY KEY)");
    } finally {
      db.close();
    }
    const result = await countActiveRuns(dbPath);
    expect(result).toMatchObject({ active: 0 });
  });

  it("CLI exits 0 when idle and 2 when runs are active", () => {
    const idleDb = makeDb(["completed"]);
    const idle = execFileSync(process.execPath, [scriptPath, "--db", idleDb], {
      encoding: "utf8",
    });
    expect(JSON.parse(idle).active).toBe(0);

    const busyDb = makeDb(["queued"]);
    let code = 0;
    try {
      execFileSync(process.execPath, [scriptPath, "--db", busyDb], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error: unknown) {
      const status = (error as { status?: unknown }).status;
      code = typeof status === "number" ? status : -1;
    }
    expect(code).toBe(2);
  });
});
