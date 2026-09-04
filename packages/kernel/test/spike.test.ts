import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

// M0.0 spike: proves better-sqlite3 loads under the pinned Node 24.x.y
// and that the bundled SQLite supports STRICT tables + json_valid.
describe("m0.0 better-sqlite3 / STRICT spike", () => {
  it("opens an in-memory DB and reports a STRICT-capable SQLite version", () => {
    const db = new Database(":memory:");
    try {
      const row = db.prepare("SELECT sqlite_version() AS version").get() as {
        version: string;
      };
      const match = /^(\d+)\.(\d+)\.(\d+)/.exec(row.version);
      expect(match).not.toBeNull();
      const major = Number(match?.[1]);
      const minor = Number(match?.[2]);
      // STRICT tables require SQLite 3.37+.
      expect(major > 3 || (major === 3 && minor >= 37)).toBe(true);
    } finally {
      db.close();
    }
  });

  it("creates a STRICT table and enforces a json_valid CHECK", () => {
    const db = new Database(":memory:");
    try {
      db.exec(
        "CREATE TABLE spike (id TEXT PRIMARY KEY, payload TEXT NOT NULL CHECK (json_valid(payload))) STRICT",
      );
      const insert = db.prepare(
        "INSERT INTO spike (id, payload) VALUES (?, ?)",
      );
      insert.run("ok", '{"kind":"user_text","version":1}');
      expect(() => insert.run("bad", "not-json")).toThrow();
      const ddl = db
        .prepare("SELECT sql FROM sqlite_master WHERE name = 'spike'")
        .get() as { sql: string };
      expect(ddl.sql).toContain("STRICT");
      const count = db.prepare("SELECT COUNT(*) AS n FROM spike").get() as {
        n: number;
      };
      expect(count.n).toBe(1);
    } finally {
      db.close();
    }
  });

  it("applies the M0 single-connection PRAGMAs", () => {
    const db = new Database(":memory:");
    try {
      db.pragma("foreign_keys = ON");
      db.pragma("busy_timeout = 5000");
      const foreignKeys = db.pragma("foreign_keys", { simple: true });
      const busyTimeout = db.pragma("busy_timeout", { simple: true });
      expect(foreignKeys).toBe(1);
      expect(busyTimeout).toBe(5000);
    } finally {
      db.close();
    }
  });
});
