// M0 storage invariants: STRICT tables, JSON checks, lifecycle checks,
// compound FKs, active-run uniqueness, PRAGMAs, single connection.
//
// Uses :memory: databases (fresh per test) except for the PRAGMA test,
// which needs a file-backed DB to observe WAL mode. Temp files live under
// os.tmpdir() and are removed in afterEach.

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
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

async function openMigratedMemory(): Promise<
  ReturnType<typeof openKernelDatabase>
> {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  return handle;
}

const NOW = 1790000000000;
const INPUT_JSON = JSON.stringify({
  kind: "user_text",
  version: 1,
  text: "hi",
});
const FROZEN_JSON = JSON.stringify({ now: NOW, timeZone: "UTC" });

function insertSession(
  db: Database.Database,
  overrides: Record<string, unknown> = {},
): string {
  const id = randomUUID();
  db.prepare(
    "INSERT INTO sessions (id, created_at, last_active_at, next_turn_position) VALUES (?, ?, ?, ?)",
  ).run(id, NOW, NOW, (overrides.next_turn_position as number) ?? 1);
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
    (overrides.seq as number) ?? 1,
    (overrides.input_json as string) ?? INPUT_JSON,
    (overrides.frozen_context as string) ?? FROZEN_JSON,
    NOW,
    (overrides.next_run_attempt as number) ?? 1,
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
  const status = (overrides.status as string) ?? "queued";
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
    (overrides.attempt as number) ?? 1,
    status,
    "test-strategy",
    (overrides.result_json as string | null) ?? null,
    (overrides.error_code as string | null) ?? null,
    0,
    1,
    0,
    NOW,
    (overrides.started_at as number | null) ?? null,
    (overrides.finished_at as number | null) ?? null,
    (overrides.cancel_requested_at as number | null) ?? null,
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
      handle.drizzle
        .insert(sessions)
        .values({
          id,
          createdAt: NOW,
          lastActiveAt: NOW,
          nextTurnPosition: 1,
        })
        .run();
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
          .prepare(
            "INSERT INTO turns (id, session_id, seq, input_json, frozen_context, created_at, next_run_attempt) VALUES (?, ?, 1, ?, ?, ?, 1)",
          )
          .run(randomUUID(), "missing-session", INPUT_JSON, FROZEN_JSON, NOW),
      ).toThrow();
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

describe("m0 kernel DDL shape", () => {
  it("creates exactly the seven M0 plus nine M1 tables, all STRICT, none WITHOUT ROWID", async () => {
    const handle = await openMigratedMemory();
    try {
      const rows = handle.raw
        .prepare(
          "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as Array<{ name: string; sql: string }>;
      expect(rows.map((row) => row.name)).toEqual([
        "api_idempotency",
        "connector_instances",
        "evidence_grants",
        "reference_set_items",
        "reference_sets",
        "resource_snapshots",
        "resources",
        "run_events",
        "runs",
        "session_reference_context",
        "session_references",
        "sessions",
        "snapshot_links",
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
        .prepare(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'messages'",
        )
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
      expect(() =>
        insertTurn(handle.raw, sessionId, { input_json: "nope" }),
      ).toThrow();
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
        mk("failed", {
          started_at: NOW,
          finished_at: NOW,
          error_code: "x_failed",
        }),
      ).toBeTypeOf("string");
      // Queued direct cancel: started_at may stay NULL.
      expect(
        mk("cancelled", { cancel_requested_at: NOW, finished_at: NOW }),
      ).toBeTypeOf("string");
      expect(mk("abandoned", { started_at: NOW, finished_at: NOW })).toBeTypeOf(
        "string",
      );
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
      expect(() =>
        insertSession(handle.raw, { next_turn_position: 0 }),
      ).toThrow();
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
      expect(() =>
        insertRun(handle.raw, sessionId, turnId, { attempt: 2 }),
      ).toThrow();
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
      expect(() =>
        insertRun(handle.raw, sessionId, turnId, { attempt: 2 }),
      ).toThrow();

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
      const insertCall = (
        index: number,
        extra: string,
        ...params: unknown[]
      ) => {
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

describe("m1 reference storage invariants", () => {
  const BODY_JSON = JSON.stringify({ version: 1, text: "hello" });

  function insertConnector(db: Database.Database): string {
    const id = randomUUID();
    db.prepare(
      "INSERT INTO connector_instances (id, kind, display_name, config_json, created_at) VALUES (?, 'markdown', ?, '{}', ?)",
    ).run(id, `vault-${id.slice(0, 8)}`, NOW);
    return id;
  }

  function insertResource(
    db: Database.Database,
    connectorId: string,
    key = `note-${randomUUID().slice(0, 8)}.md`,
  ): string {
    const id = randomUUID();
    db.prepare(
      "INSERT INTO resources (id, connector_instance_id, canonical_key, title, next_revision, created_at) VALUES (?, ?, ?, 't', 1, ?)",
    ).run(id, connectorId, key, NOW);
    return id;
  }

  function insertSnapshot(
    db: Database.Database,
    resourceId: string,
    revision: number,
    contentHash = `hash-${revision}-${randomUUID().slice(0, 6)}`,
  ): string {
    const id = randomUUID();
    db.prepare(
      "INSERT INTO resource_snapshots (id, resource_id, revision, source_revision, content_hash, body_json, size_bytes, observed_at, created_at) VALUES (?, ?, ?, NULL, ?, ?, 5, ?, ?)",
    ).run(id, resourceId, revision, contentHash, BODY_JSON, NOW, NOW);
    return id;
  }

  function insertReference(
    db: Database.Database,
    sessionId: string,
    ordinal: number,
    resourceId: string,
    snapshotId: string,
  ): string {
    const id = randomUUID();
    db.prepare(
      "INSERT INTO session_references (id, session_id, ordinal, resource_id, snapshot_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(id, sessionId, ordinal, resourceId, snapshotId, NOW);
    return id;
  }

  function runningRun(db: Database.Database): {
    sessionId: string;
    runId: string;
  } {
    const sessionId = insertSession(db);
    const turnId = insertTurn(db, sessionId);
    const runId = insertRun(db, sessionId, turnId, {
      status: "running",
      started_at: NOW,
    });
    return { sessionId, runId };
  }

  it("rejects allocator underflow and bad counters", async () => {
    const handle = await openMigratedMemory();
    try {
      expect(() =>
        handle.raw
          .prepare(
            "INSERT INTO sessions (id, created_at, last_active_at, next_turn_position, next_reference_ordinal) VALUES (?, ?, ?, 1, 0)",
          )
          .run(randomUUID(), NOW, NOW),
      ).toThrow();
      const sessionId = insertSession(handle.raw);
      const connectorId = insertConnector(handle.raw);
      expect(() =>
        handle.raw
          .prepare(
            "INSERT INTO resources (id, connector_instance_id, canonical_key, next_revision, created_at) VALUES (?, ?, 'k.md', 0, ?)",
          )
          .run(randomUUID(), connectorId, NOW),
      ).toThrow();
      const resourceId = insertResource(handle.raw, connectorId);
      expect(() =>
        handle.raw
          .prepare(
            "INSERT INTO resource_snapshots (id, resource_id, revision, content_hash, body_json, size_bytes, observed_at, created_at) VALUES (?, ?, 0, 'h', ?, 1, ?, ?)",
          )
          .run(randomUUID(), resourceId, BODY_JSON, NOW, NOW),
      ).toThrow();
      expect(() =>
        handle.raw
          .prepare(
            "INSERT INTO resource_snapshots (id, resource_id, revision, content_hash, body_json, size_bytes, observed_at, created_at) VALUES (?, ?, 1, 'h', ?, -1, ?, ?)",
          )
          .run(randomUUID(), resourceId, BODY_JSON, NOW, NOW),
      ).toThrow();
      const snapshotId = insertSnapshot(handle.raw, resourceId, 1, "h");
      expect(() =>
        insertReference(handle.raw, sessionId, 0, resourceId, snapshotId),
      ).toThrow();
      const setId = randomUUID();
      handle.raw
        .prepare(
          "INSERT INTO reference_sets (id, session_id, created_at) VALUES (?, ?, ?)",
        )
        .run(setId, sessionId, NOW);
      const refId = insertReference(
        handle.raw,
        sessionId,
        1,
        resourceId,
        snapshotId,
      );
      expect(() =>
        handle.raw
          .prepare(
            "INSERT INTO reference_set_items (session_id, set_id, ordinal, reference_id) VALUES (?, ?, 0, ?)",
          )
          .run(sessionId, setId, refId),
      ).toThrow();
      expect(() =>
        handle.raw
          .prepare(
            "INSERT INTO session_reference_context (session_id, version, items_json, updated_at) VALUES (?, 0, '[]', ?)",
          )
          .run(sessionId, NOW),
      ).toThrow();
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("allows duplicate snapshot content (no UNIQUE resource_id+content_hash)", async () => {
    const handle = await openMigratedMemory();
    try {
      const connectorId = insertConnector(handle.raw);
      const resourceId = insertResource(handle.raw, connectorId);
      expect(() =>
        insertSnapshot(handle.raw, resourceId, 1, "same"),
      ).not.toThrow();
      // Same content hash, new revision: legitimate (e.g. refresh).
      expect(() =>
        insertSnapshot(handle.raw, resourceId, 2, "same"),
      ).not.toThrow();
      const idx = handle.raw
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'index' AND sql LIKE '%content_hash%'",
        )
        .all() as Array<{ sql: string }>;
      expect(idx).toEqual([]);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("reuses the same rN for the same session+snapshot and isolates sessions", async () => {
    const handle = await openMigratedMemory();
    try {
      const connectorId = insertConnector(handle.raw);
      const resourceId = insertResource(handle.raw, connectorId);
      const snapshotId = insertSnapshot(handle.raw, resourceId, 1, "h");
      const sessionA = insertSession(handle.raw);
      const sessionB = insertSession(handle.raw);
      insertReference(handle.raw, sessionA, 1, resourceId, snapshotId);
      // Same session + same snapshot cannot take a second ordinal.
      expect(() =>
        insertReference(handle.raw, sessionA, 2, resourceId, snapshotId),
      ).toThrow();
      // Another session may reference the same snapshot with its own rN.
      expect(() =>
        insertReference(handle.raw, sessionB, 1, resourceId, snapshotId),
      ).not.toThrow();
      // Mismatched resource/snapshot pair violates the compound FK.
      const otherResource = insertResource(handle.raw, connectorId);
      expect(() =>
        insertReference(handle.raw, sessionB, 2, otherResource, snapshotId),
      ).toThrow();
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("enforces same-session ownership on sets, items, and grants", async () => {
    const handle = await openMigratedMemory();
    try {
      const connectorId = insertConnector(handle.raw);
      const resourceId = insertResource(handle.raw, connectorId);
      const snapshotId = insertSnapshot(handle.raw, resourceId, 1, "h");
      const sessionA = insertSession(handle.raw);
      const sessionB = insertSession(handle.raw);
      const refA = insertReference(
        handle.raw,
        sessionA,
        1,
        resourceId,
        snapshotId,
      );
      const setA = randomUUID();
      handle.raw
        .prepare(
          "INSERT INTO reference_sets (id, session_id, created_at) VALUES (?, ?, ?)",
        )
        .run(setA, sessionA, NOW);
      expect(() =>
        handle.raw
          .prepare(
            "INSERT INTO reference_set_items (session_id, set_id, ordinal, reference_id) VALUES (?, ?, 1, ?)",
          )
          .run(sessionA, setA, refA),
      ).not.toThrow();
      const refB = insertReference(
        handle.raw,
        sessionB,
        1,
        resourceId,
        snapshotId,
      );
      // Cross-session item (set of A, reference of B) is rejected.
      expect(() =>
        handle.raw
          .prepare(
            "INSERT INTO reference_set_items (session_id, set_id, ordinal, reference_id) VALUES (?, ?, 2, ?)",
          )
          .run(sessionA, setA, refB),
      ).toThrow();
      // Evidence grants require run and reference in the same session.
      const { sessionId, runId } = runningRun(handle.raw);
      const snap2 = insertSnapshot(handle.raw, resourceId, 2, "h2");
      const refOwn = insertReference(
        handle.raw,
        sessionId,
        1,
        resourceId,
        snap2,
      );
      expect(() =>
        handle.raw
          .prepare(
            "INSERT INTO evidence_grants (session_id, run_id, reference_id, exposure, created_at) VALUES (?, ?, ?, 'snippet', ?)",
          )
          .run(sessionId, runId, refOwn, NOW),
      ).not.toThrow();
      expect(() =>
        handle.raw
          .prepare(
            "INSERT INTO evidence_grants (session_id, run_id, reference_id, exposure, created_at) VALUES (?, ?, ?, 'full', ?)",
          )
          .run(sessionId, runId, refA, NOW),
      ).toThrow();
      expect(() =>
        handle.raw
          .prepare(
            "INSERT INTO evidence_grants (session_id, run_id, reference_id, exposure, created_at) VALUES (?, ?, ?, 'bogus', ?)",
          )
          .run(sessionId, runId, refOwn, NOW),
      ).toThrow();
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("validates context JSON and connector/resource uniqueness", async () => {
    const handle = await openMigratedMemory();
    try {
      const sessionId = insertSession(handle.raw);
      expect(() =>
        handle.raw
          .prepare(
            "INSERT INTO session_reference_context (session_id, version, items_json, updated_at) VALUES (?, 1, '[]', ?)",
          )
          .run(sessionId, NOW),
      ).not.toThrow();
      expect(() =>
        handle.raw
          .prepare(
            "INSERT INTO session_reference_context (session_id, version, items_json, updated_at) VALUES (?, 1, 'nope', ?)",
          )
          .run(insertSession(handle.raw), NOW),
      ).toThrow();
      expect(() =>
        handle.raw
          .prepare(
            "INSERT INTO connector_instances (id, kind, display_name, config_json, created_at) VALUES (?, 'markdown', 'dup', 'bad', ?)",
          )
          .run(randomUUID(), NOW),
      ).toThrow();
      const connectorId = insertConnector(handle.raw);
      insertResource(handle.raw, connectorId, "same.md");
      expect(() =>
        insertResource(handle.raw, connectorId, "same.md"),
      ).toThrow();
      expect(() =>
        handle.raw
          .prepare(
            "INSERT INTO resource_snapshots (id, resource_id, revision, content_hash, body_json, size_bytes, observed_at, created_at) VALUES (?, ?, 9, 'h', 'bad', 1, ?, ?)",
          )
          .run(randomUUID(), "missing-resource", NOW, NOW),
      ).toThrow();
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("keeps all M1 tables STRICT with json_valid checks", async () => {
    const handle = await openMigratedMemory();
    try {
      const rows = handle.raw
        .prepare(
          "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN ('connector_instances','resources','resource_snapshots','snapshot_links','session_references','reference_sets','reference_set_items','session_reference_context','evidence_grants')",
        )
        .all() as Array<{ name: string; sql: string }>;
      expect(rows).toHaveLength(9);
      for (const row of rows) {
        expect(row.sql).toContain("STRICT");
        expect(row.sql).not.toContain("WITHOUT ROWID");
      }
      const byName = new Map(rows.map((row) => [row.name, row.sql] as const));
      expect(byName.get("connector_instances")).toContain("json_valid");
      expect(byName.get("resource_snapshots")).toContain("json_valid");
      expect(byName.get("session_reference_context")).toContain("json_valid");
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

describe("m1 snapshot link graph invariants", () => {
  function graphSetup(db: Database.Database): {
    resourceId: string;
    snapshotId: string;
    targetId: string;
  } {
    const connectorId = randomUUID();
    db.prepare(
      "INSERT INTO connector_instances (id, kind, display_name, config_json, created_at) VALUES (?, 'markdown', ?, '{}', ?)",
    ).run(connectorId, `vault-${connectorId.slice(0, 8)}`, NOW);
    const resourceId = randomUUID();
    db.prepare(
      "INSERT INTO resources (id, connector_instance_id, canonical_key, title, next_revision, created_at) VALUES (?, ?, 'a.md', 'A', 2, ?)",
    ).run(resourceId, connectorId, NOW);
    const targetId = randomUUID();
    db.prepare(
      "INSERT INTO resources (id, connector_instance_id, canonical_key, title, next_revision, created_at) VALUES (?, ?, 'b.md', NULL, 1, ?)",
    ).run(targetId, connectorId, NOW);
    const snapshotId = randomUUID();
    db.prepare(
      "INSERT INTO resource_snapshots (id, resource_id, revision, source_revision, content_hash, body_json, size_bytes, observed_at, created_at) VALUES (?, ?, 1, NULL, 'h', ?, 5, ?, ?)",
    ).run(
      snapshotId,
      resourceId,
      JSON.stringify({ version: 1, text: "hi" }),
      NOW,
      NOW,
    );
    return { resourceId, snapshotId, targetId };
  }

  it("is STRICT with json_valid and no raw link-text columns", async () => {
    const handle = await openMigratedMemory();
    try {
      const row = handle.raw
        .prepare("SELECT sql FROM sqlite_master WHERE name = 'snapshot_links'")
        .get() as { sql: string };
      expect(row.sql).toContain("STRICT");
      expect(row.sql).not.toContain("WITHOUT ROWID");
      expect(row.sql).toContain("json_valid");
      expect(row.sql).toContain("json_array_length");
      const cols = handle.raw
        .prepare("PRAGMA table_info(snapshot_links)")
        .all() as Array<{ name: string }>;
      expect(cols.map((c) => c.name).sort()).toEqual(
        [
          "candidates_json",
          "kind",
          "ordinal",
          "source_snapshot_id",
          "status",
          "target_resource_id",
        ].sort(),
      );
      const ddl = row.sql.toLowerCase();
      expect(ddl).not.toContain("raw_url");
      expect(ddl).not.toContain("fragment");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("enforces the resolved/ambiguous/unresolved state CHECK", async () => {
    const handle = await openMigratedMemory();
    try {
      const { snapshotId, targetId } = graphSetup(handle.raw);
      const insert = (
        ordinal: number,
        kind: string,
        status: string,
        target: string | null,
        candidates: string,
      ) => {
        handle.raw
          .prepare(
            "INSERT INTO snapshot_links (source_snapshot_id, ordinal, kind, status, target_resource_id, candidates_json) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(snapshotId, ordinal, kind, status, target, candidates);
      };
      // Valid rows for each state.
      expect(() =>
        insert(1, "standard", "resolved", targetId, '["b.md"]'),
      ).not.toThrow();
      expect(() =>
        insert(2, "wiki", "ambiguous", null, '["b.md","c.md"]'),
      ).not.toThrow();
      expect(() => insert(3, "wiki", "unresolved", null, "[]")).not.toThrow();
      // State violations: resolved without target / wrong arity.
      expect(() =>
        insert(4, "standard", "resolved", null, '["b.md"]'),
      ).toThrow();
      expect(() => insert(5, "standard", "resolved", targetId, "[]")).toThrow();
      expect(() =>
        insert(6, "standard", "resolved", targetId, '["b.md","c.md"]'),
      ).toThrow();
      // Ambiguous with a target or a single candidate.
      expect(() =>
        insert(7, "wiki", "ambiguous", targetId, '["b.md","c.md"]'),
      ).toThrow();
      expect(() => insert(8, "wiki", "ambiguous", null, '["b.md"]')).toThrow();
      // Unresolved with a target or any candidate.
      expect(() => insert(9, "wiki", "unresolved", targetId, "[]")).toThrow();
      expect(() =>
        insert(10, "wiki", "unresolved", null, '["b.md"]'),
      ).toThrow();
      // Closed kind/status sets and ordinal bound.
      expect(() =>
        insert(11, "embed", "resolved", targetId, '["b.md"]'),
      ).toThrow();
      expect(() => insert(12, "standard", "guessed", null, "[]")).toThrow();
      expect(() => insert(0, "standard", "unresolved", null, "[]")).toThrow();
      // Non-JSON candidates rejected.
      expect(() =>
        insert(13, "standard", "unresolved", null, "nope"),
      ).toThrow();
      // Composite PK uniqueness.
      expect(() => insert(1, "standard", "unresolved", null, "[]")).toThrow();
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("enforces snapshot/resource FKs", async () => {
    const handle = await openMigratedMemory();
    try {
      const { snapshotId } = graphSetup(handle.raw);
      expect(() =>
        handle.raw
          .prepare(
            "INSERT INTO snapshot_links (source_snapshot_id, ordinal, kind, status, target_resource_id, candidates_json) VALUES ('missing', 1, 'standard', 'unresolved', NULL, '[]')",
          )
          .run(),
      ).toThrow();
      expect(() =>
        handle.raw
          .prepare(
            "INSERT INTO snapshot_links (source_snapshot_id, ordinal, kind, status, target_resource_id, candidates_json) VALUES (?, 9, 'standard', 'resolved', 'missing', '[\"b.md\"]')",
          )
          .run(snapshotId),
      ).toThrow();
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

describe("m0 private POSIX permissions (non-Windows only)", () => {
  const isWindows = process.platform === "win32";

  it("creates app/backup dirs 0700 and DB/backup files 0600", async () => {
    if (isWindows) {
      return;
    }
    const { statSync } = await import("node:fs");
    const { createManualBackup, ensureBackupDir } = await import(
      "../src/index.js"
    );
    const dir = tempDir();
    const backups = ensureBackupDir(join(dir, "backups"));
    expect(statSync(backups).mode & 0o777).toBe(0o700);
    const file = join(dir, "kernel.sqlite");
    const handle = openKernelDatabase(file);
    try {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      const backupPath = await createManualBackup({
        source: handle.raw,
        backupDir: backups,
        now: new Date("2026-09-04T03:59:59.000Z"),
        backupId: "11111111-2222-4333-8444-555555555555",
      });
      expect(statSync(backupPath).mode & 0o777).toBe(0o600);
      expect(statSync(backups).mode & 0o777).toBe(0o700);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
