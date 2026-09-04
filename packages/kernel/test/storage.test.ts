// M0 storage invariants: STRICT tables, JSON checks, lifecycle checks,
// compound FKs, active-run uniqueness, PRAGMAs, single connection.
//
// Uses :memory: databases (fresh per test) except for the PRAGMA test,
// which needs a file-backed DB to observe WAL mode. Temp files live under
// os.tmpdir() and are removed in afterEach.

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeKernelDatabase,
  getKernelPragmas,
  migrateKernelDatabase,
  openKernelDatabase,
  sessions,
} from "../src/index.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop() as string;
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "m0-kernel-storage-"));
  tempRoots.push(dir);
  return dir;
}

async function openMigratedMemory(): Promise<ReturnType<typeof openKernelDatabase>> {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  return handle;
}

const NOW = 1790000000000;
const INPUT_JSON = JSON.stringify({ kind: "user_text", version: 1, text: "hi" });
const FROZEN_JSON = JSON.stringify({ now: NOW, timeZone: "UTC" });

function insertSession(
  db: Database.Database,
  overrides: Record<string, unknown> = {},
): string {
  const id = randomUUID();
  db.prepare(
    "INSERT INTO sessions (id, created_at, last_active_at, next_turn_position) VALUES (?, ?, ?, ?)",
  ).run(id, NOW, NOW, (overrides["next_turn_position"] as number) ?? 1);
  return id;
}

function insertTurn(
  db: Database.Database,
  sessionId: string,
  overrides: Record<string, unknown> = {},
): string {
  const id = randomUUID();
  db.prepare(
    "INSERT INTO turns (id, session_id, seq, input_json, frozen_context, created_at, next_run_attempt) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    sessionId,
    (overrides["seq"] as number) ?? 1,
    (overrides["input_json"] as string) ?? INPUT_JSON,
    (overrides["frozen_context"] as string) ?? FROZEN_JSON,
    NOW,
    (overrides["next_run_attempt"] as number) ?? 1,
  );
  return id;
}

function insertRun(
  db: Database.Database,
  sessionId: string,
  turnId: string,
  overrides: Record<string, unknown> = {},
): string {
  const id = randomUUID();
  const status = (overrides["status"] as string) ?? "queued";
  db.prepare(
    `INSERT INTO runs (id, turn_id, session_id, attempt, status, strategy,
      result_json, error_code, event_seq, select_on_success,
      tool_requests_used, created_at, started_at, finished_at,
      cancel_requested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    turnId,
    sessionId,
    (overrides["attempt"] as number) ?? 1,
    status,
    "test-strategy",
    (overrides["result_json"] as string | null) ?? null,
    (overrides["error_code"] as string | null) ?? null,
    0,
    1,
    0,
    NOW,
    (overrides["started_at"] as number | null) ?? null,
    (overrides["finished_at"] as number | null) ?? null,
    (overrides["cancel_requested_at"] as number | null) ?? null,
  );
  return id;
}

describe("m0 kernel pragmas and single connection", () => {
  it("applies WAL / foreign_keys / NORMAL / busy_timeout=5000 on file DBs", () => {
    const file = join(tempDir(), "kernel.sqlite");
    const handle = openKernelDatabase(file);
    try {
      const pragmas = getKernelPragmas(handle);
      expect(handle.journalMode).toBe("wal");
      expect(pragmas.journalMode).toBe("wal");
      expect(pragmas.foreignKeys).toBe(1);
      expect(pragmas.synchronous).toBe(1);
      expect(pragmas.busyTimeoutMs).toBe(5000);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("wraps the same connection in Drizzle (no second connection)", async () => {
    const handle = await openMigratedMemory();
    try {
      const id = randomUUID();
      handle.drizzle.insert(sessions).values({
        id,
        createdAt: NOW,
        lastActiveAt: NOW,
        nextTurnPosition: 1,
      }).run();
      const row = handle.raw
        .prepare("SELECT id FROM sessions WHERE id = ?")
        .get(id) as { id: string } | undefined;
      expect(row?.id).toBe(id);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("enforces foreign keys on the single connection", async () => {
    const handle = await openMigratedMemory();
    try {
      insertSession(handle.raw);
      expect(() =>
        handle.raw
          .prepare("INSERT INTO turns (id, session_id, seq, input_json, frozen_context, created_at, next_run_attempt) VALUES (?, ?, 1, ?, ?, ?, 1)")
          .run(randomUUID(), "missing-session", INPUT_JSON, FROZEN_JSON, NOW),
      ).toThrow();
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

describe("m0 kernel DDL shape", () => {
  it("creates exactly the seven M0 tables, all STRICT, none WITHOUT ROWID", async () => {
    const handle = await openMigratedMemory();
    try {
      const rows = handle.raw
        .prepare(
          "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as Array<{ name: string; sql: string }>;
      expect(rows.map((row) => row.name)).toEqual([
        "api_idempotency",
        "run_events",
        "runs",
        "sessions",
        "tool_calls",
        "turn_selections",
        "turns",
      ]);
      for (const row of rows) {
        expect(row.sql).toContain("STRICT");
        expect(row.sql).not.toContain("WITHOUT ROWID");
      }
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("has no messages table", async () => {
    const handle = await openMigratedMemory();
    try {
      const row = handle.raw
        .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'messages'")
        .get() as { n: number };
      expect(row.n).toBe(0);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("creates the active-run partial unique index", async () => {
    const handle = await openMigratedMemory();
    try {
      const row = handle.raw
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_runs_one_active_per_session'",
        )
        .get() as { sql: string } | undefined;
      expect(row?.sql).toContain("UNIQUE");
      expect(row?.sql).toContain("WHERE status IN");
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

describe("m0 kernel JSON checks", () => {
  it("rejects non-JSON input_json / frozen_context", async () => {
    const handle = await openMigratedMemory();
    try {
      const sessionId = insertSession(handle.raw);
      expect(() => insertTurn(handle.raw, sessionId, { input_json: "nope" })).toThrow();
      expect(() =>
        insertTurn(handle.raw, sessionId, { seq: 2, frozen_context: "[bad" }),
      ).toThrow();
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("allows NULL result_json but rejects invalid result_json", async () => {
    const handle = await openMigratedMemory();
    try {
      const sessionId = insertSession(handle.raw);
      const turnId = insertTurn(handle.raw, sessionId);
      expect(() => insertRun(handle.raw, sessionId, turnId)).not.toThrow();
      expect(() =>
        insertRun(handle.raw, sessionId, turnId, {
          attempt: 2,
          result_json: "{invalid",
        }),
      ).toThrow();
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("rejects invalid run_events payload and api_idempotency response_body", async () => {
    const handle = await openMigratedMemory();
    try {
      const sessionId = insertSession(handle.raw);
      const turnId = insertTurn(handle.raw, sessionId);
      const runId = insertRun(handle.raw, sessionId, turnId);
      expect(() =>
        handle.raw
          .prepare(
            "INSERT INTO run_events (run_id, seq, schema_version, type, payload, created_at) VALUES (?, 1, 1, 'run.queued', 'bad', ?)",
          )
          .run(runId, NOW),
      ).toThrow();
      expect(() =>
        handle.raw
          .prepare(
            "INSERT INTO api_idempotency (scope, key, request_hash, response_status, response_body, created_at) VALUES ('sessions:create', ?, 'h', 202, 'bad', ?)",
          )
          .run(randomUUID(), NOW),
      ).toThrow();
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

describe("m0 kernel run lifecycle checks", () => {
  it("accepts one valid row per status", async () => {
    const handle = await openMigratedMemory();
    try {
      const mk = (status: string, extra: Record<string, unknown>) => {
        const sessionId = insertSession(handle.raw);
        const turnId = insertTurn(handle.raw, sessionId);
        return insertRun(handle.raw, sessionId, turnId, { status, ...extra });
      };
      expect(mk("queued", {})).toBeTypeOf("string");
      expect(mk("running", { started_at: NOW })).toBeTypeOf("string");
      expect(
        mk("cancel_requested", { started_at: NOW, cancel_requested_at: NOW }),
      ).toBeTypeOf("string");
      expect(
        mk("completed", {
          started_at: NOW,
          finished_at: NOW,
          result_json: JSON.stringify({ version: 1 }),
        }),
      ).toBeTypeOf("string");
      expect(
        mk("failed", { started_at: NOW, finished_at: NOW, error_code: "x_failed" }),
      ).toBeTypeOf("string");
      // Queued direct cancel: started_at may stay NULL.
      expect(
        mk("cancelled", { cancel_requested_at: NOW, finished_at: NOW }),
      ).toBeTypeOf("string");
      expect(
        mk("abandoned", { started_at: NOW, finished_at: NOW }),
      ).toBeTypeOf("string");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("rejects lifecycle-violating combinations", async () => {
    const handle = await openMigratedMemory();
    try {
      const sessionId = insertSession(handle.raw);
      const turnId = insertTurn(handle.raw, sessionId);
      let attempt = 100;
      const attemptBad = (extra: Record<string, unknown>) => {
        attempt += 1;
        expect(() =>
          insertRun(handle.raw, sessionId, turnId, { attempt, ...extra }),
        ).toThrow();
      };
      attemptBad({ status: "queued", started_at: NOW });
      attemptBad({ status: "running" });
      attemptBad({ status: "completed", started_at: NOW, finished_at: NOW });
      attemptBad({
        status: "completed",
        started_at: NOW,
        finished_at: NOW,
        result_json: JSON.stringify({ version: 1 }),
        cancel_requested_at: NOW,
      });
      attemptBad({ status: "failed", started_at: NOW, finished_at: NOW });
      attemptBad({ status: "cancelled", finished_at: NOW });
      attemptBad({
        status: "cancelled",
        cancel_requested_at: NOW,
        finished_at: NOW,
        error_code: "x",
      });
      attemptBad({ status: "abandoned", finished_at: NOW });
      attemptBad({ status: "nope" });
      attemptBad({ status: "queued", attempt: 0 });
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("rejects out-of-range counters and flags", async () => {
    const handle = await openMigratedMemory();
    try {
      expect(() => insertSession(handle.raw, { next_turn_position: 0 })).toThrow();
      const sessionId = insertSession(handle.raw);
      expect(() => insertTurn(handle.raw, sessionId, { seq: 0 })).toThrow();
      expect(() =>
        insertTurn(handle.raw, sessionId, { seq: 2, next_run_attempt: 0 }),
      ).toThrow();
      const turnId = insertTurn(handle.raw, sessionId);
      expect(() =>
        handle.raw
          .prepare(
            "INSERT INTO runs (id, turn_id, session_id, attempt, status, strategy, event_seq, select_on_success, tool_requests_used, created_at) VALUES (?, ?, ?, 1, 'queued', 's', 0, 2, 0, ?)",
          )
          .run(randomUUID(), turnId, sessionId, NOW),
      ).toThrow();
      expect(() =>
        handle.raw
          .prepare(
            "INSERT INTO runs (id, turn_id, session_id, attempt, status, strategy, event_seq, select_on_success, tool_requests_used, created_at) VALUES (?, ?, ?, 2, 'queued', 's', -1, 1, 0, ?)",
          )
          .run(randomUUID(), turnId, sessionId, NOW),
      ).toThrow();
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

describe("m0 kernel active-run uniqueness", () => {
  it("allows at most one active run per session", async () => {
    const handle = await openMigratedMemory();
    try {
      const sessionId = insertSession(handle.raw);
      const turnId = insertTurn(handle.raw, sessionId);
      insertRun(handle.raw, sessionId, turnId);
      expect(() => insertRun(handle.raw, sessionId, turnId, { attempt: 2 })).toThrow();
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("treats cancel_requested as active and terminal states as free", async () => {
    const handle = await openMigratedMemory();
    try {
      const sessionId = insertSession(handle.raw);
      const turnId = insertTurn(handle.raw, sessionId);
      insertRun(handle.raw, sessionId, turnId, {
        status: "cancel_requested",
        started_at: NOW,
        cancel_requested_at: NOW,
      });
      expect(() => insertRun(handle.raw, sessionId, turnId, { attempt: 2 })).toThrow();

      const freeId = insertSession(handle.raw);
      const freeTurn = insertTurn(handle.raw, freeId);
      insertRun(handle.raw, freeId, freeTurn, {
        status: "completed",
        started_at: NOW,
        finished_at: NOW,
        result_json: JSON.stringify({ version: 1 }),
      });
      expect(() =>
        insertRun(handle.raw, freeId, freeTurn, { attempt: 2 }),
      ).not.toThrow();
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("isolates active runs across sessions", async () => {
    const handle = await openMigratedMemory();
    try {
      for (let i = 0; i < 2; i += 1) {
        const sessionId = insertSession(handle.raw);
        const turnId = insertTurn(handle.raw, sessionId);
        insertRun(handle.raw, sessionId, turnId);
      }
      const count = handle.raw
        .prepare("SELECT COUNT(*) AS n FROM runs WHERE status = 'queued'")
        .get() as { n: number };
      expect(count.n).toBe(2);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

describe("m0 kernel compound foreign keys", () => {
  it("rejects runs whose turn belongs to another session", async () => {
    const handle = await openMigratedMemory();
    try {
      const sessionA = insertSession(handle.raw);
      const sessionB = insertSession(handle.raw);
      const turnA = insertTurn(handle.raw, sessionA);
      expect(() => insertRun(handle.raw, sessionB, turnA)).toThrow();
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("rejects turn_selections pointing at another turn's run", async () => {
    const handle = await openMigratedMemory();
    try {
      const sessionId = insertSession(handle.raw);
      const turnA = insertTurn(handle.raw, sessionId);
      const turnB = insertTurn(handle.raw, sessionId, { seq: 2 });
      const runB = insertRun(handle.raw, sessionId, turnB);
      expect(() =>
        handle.raw
          .prepare(
            "INSERT INTO turn_selections (turn_id, run_id, selected_at) VALUES (?, ?, ?)",
          )
          .run(turnA, runB, NOW),
      ).toThrow();
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("rejects dangling tool_calls reuse references", async () => {
    const handle = await openMigratedMemory();
    try {
      const sessionId = insertSession(handle.raw);
      const turnId = insertTurn(handle.raw, sessionId);
      const runId = insertRun(handle.raw, sessionId, turnId);
      expect(() =>
        handle.raw
          .prepare(
            "INSERT INTO tool_calls (id, run_id, call_index, lifecycle_status, tool, args_hash, actual_outcome, result_disposition, reused_from_call_id, requested_at, created_at) VALUES (?, ?, 1, 'finished', 't.v', 'h', 'deduplicated', 'accepted', 'missing', ?, ?)",
          )
          .run(randomUUID(), runId, NOW, NOW),
      ).toThrow();
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

describe("m0 kernel run_events and tool_calls contracts", () => {
  it("leaves run_events.type open (no closed-set DB CHECK)", async () => {
    const handle = await openMigratedMemory();
    try {
      const sessionId = insertSession(handle.raw);
      const turnId = insertTurn(handle.raw, sessionId);
      const runId = insertRun(handle.raw, sessionId, turnId);
      expect(() =>
        handle.raw
          .prepare(
            "INSERT INTO run_events (run_id, seq, schema_version, type, payload, created_at) VALUES (?, 1, 1, 'future.custom', '{}', ?)",
          )
          .run(runId, NOW),
      ).not.toThrow();
      expect(() =>
        handle.raw
          .prepare(
            "INSERT INTO run_events (run_id, seq, schema_version, type, payload, created_at) VALUES (?, 2, 1, 'run.started', '{}', ?)",
          )
          .run(runId, NOW),
      ).not.toThrow();
      expect(() =>
        handle.raw
          .prepare(
            "INSERT INTO run_events (run_id, seq, schema_version, type, payload, created_at) VALUES (?, 0, 1, 'run.started', '{}', ?)",
          )
          .run(runId, NOW),
      ).toThrow();
      expect(() =>
        handle.raw
          .prepare(
            "INSERT INTO run_events (run_id, seq, schema_version, type, payload, created_at) VALUES (?, 3, 0, 'run.started', '{}', ?)",
          )
          .run(runId, NOW),
      ).toThrow();
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("enforces tool_calls outcome vocabularies with NULL allowed", async () => {
    const handle = await openMigratedMemory();
    try {
      const sessionId = insertSession(handle.raw);
      const turnId = insertTurn(handle.raw, sessionId);
      const runId = insertRun(handle.raw, sessionId, turnId);
      const insertCall = (index: number, extra: string, ...params: unknown[]) => {
        handle.raw
          .prepare(
            `INSERT INTO tool_calls (id, run_id, call_index, lifecycle_status, tool, args_hash, requested_at, created_at${extra}) VALUES (?, ?, ?, 'finished', 't.v', 'h', ?, ?${", ?".repeat(params.length)})`,
          )
          .run(randomUUID(), runId, index, NOW, NOW, ...params);
      };
      expect(() => insertCall(1, "")).not.toThrow();
      expect(() =>
        insertCall(2, ", reported_outcome", "succeeded"),
      ).not.toThrow();
      expect(() =>
        insertCall(3, ", actual_outcome", "deduplicated"),
      ).not.toThrow();
      expect(() => insertCall(4, ", reported_outcome", "bogus")).toThrow();
      expect(() => insertCall(5, ", actual_outcome", "bogus")).toThrow();
      expect(() => insertCall(6, ", result_disposition", "bogus")).toThrow();
      expect(() => insertCall(0, "")).toThrow();
      expect(() =>
        handle.raw
          .prepare(
            "INSERT INTO tool_calls (id, run_id, call_index, lifecycle_status, tool, args_hash, requested_at, created_at) VALUES (?, ?, 7, 'bogus', 't.v', 'h', ?, ?)",
          )
          .run(randomUUID(), runId, NOW, NOW),
      ).toThrow();
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("accepts only 2xx idempotency response statuses", async () => {
    const handle = await openMigratedMemory();
    try {
      const insertEntry = (key: string, status: number) => {
        handle.raw
          .prepare(
            "INSERT INTO api_idempotency (scope, key, request_hash, response_status, response_body, created_at) VALUES ('sessions:create', ?, 'h', ?, '{}', ?)",
          )
          .run(key, status, NOW);
      };
      expect(() => insertEntry(randomUUID(), 202)).not.toThrow();
      expect(() => insertEntry(randomUUID(), 199)).toThrow();
      expect(() => insertEntry(randomUUID(), 300)).toThrow();
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
