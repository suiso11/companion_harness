// Memory-content statistics service: bounded `record.list` walks, counts by
// kind/status, five-minute cache with single-flight, page-limit fallback, and
// row-cap truncation. Real migrated `:memory:` kernel DB + injected fake
// remind CLI (no child, no remind DB, no network).

import {
  closeKernelDatabase,
  createKernelRepository,
  type KernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
} from "@companion/kernel";
import { afterEach, describe, expect, it } from "vitest";
import type {
  MemoryCliAddress,
  MemoryCliCallOptions,
  MemoryCliEnvelope,
} from "../src/memory_cli.js";
import {
  createMemoryService,
  MEMORY_STATS_ACTIVE_ROW_CAP,
  MEMORY_STATS_CACHE_TTL_MS,
  MEMORY_STATS_STATUS_ROW_CAP,
  type MemoryService,
} from "../src/memory_service.js";

const T0 = 1790000000000;
const SCOPE = "test-scope";

type CliCall = (
  address: MemoryCliAddress,
  op: string,
  params: Record<string, unknown>,
  idempotencyKey: string | undefined,
  options?: MemoryCliCallOptions,
) => Promise<MemoryCliEnvelope>;

interface RecordRow {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly createdAt: string;
}

interface CliState {
  readonly rows: RecordRow[];
  readonly calls: Array<{ status: string; limit: number; until?: string }>;
  readonly rejectOver?: number;
  delay?: Promise<void>;
}

let services: MemoryService[] = [];

afterEach(async () => {
  for (const service of services) {
    await service.stop().catch(() => undefined);
  }
  services = [];
});

function okEnvelope(data: Record<string, unknown> | null): MemoryCliEnvelope {
  return { ok: true, code: "OK", data, deduplicated: false };
}

function makeService(
  repo: KernelRepository,
  cliCall: CliCall,
  now: () => number,
): MemoryService {
  const service = createMemoryService({
    address: {
      executable: "/bin/true",
      entry: "/cli.js",
      config: "/mem.json",
      timeoutMs: 5000,
      maxResponseBytes: 65536,
    },
    scope: SCOPE,
    recallLimit: 5,
    idleMs: 30,
    repo,
    gateway: null,
    model: "test-model",
    cliCall,
    now,
  });
  services.push(service);
  return service;
}

function makeCli(state: CliState): CliCall {
  return async (_address, op, params) => {
    if (op !== "record.list") {
      return {
        ok: false,
        code: "BAD_REQUEST",
        data: null,
        deduplicated: false,
      };
    }
    const limit = Number(params.limit);
    const status = String(params.status);
    const until = typeof params.until === "string" ? params.until : undefined;
    state.calls.push({
      status,
      limit,
      ...(until !== undefined ? { until } : {}),
    });
    if (state.rejectOver !== undefined && limit > state.rejectOver) {
      return {
        ok: false,
        code: "LIMIT_EXCEEDED",
        data: null,
        deduplicated: false,
      };
    }
    if (state.delay !== undefined) {
      await state.delay;
    }
    const items = state.rows
      .filter((row) => row.status === status)
      .filter((row) => until === undefined || row.createdAt < until)
      .sort((left, right) =>
        left.createdAt === right.createdAt
          ? left.id < right.id
            ? -1
            : 1
          : left.createdAt > right.createdAt
            ? -1
            : 1,
      )
      .slice(0, limit)
      .map((row) => ({
        id: row.id,
        kind: row.kind,
        status: row.status,
        // A body must never be forwarded by the stats service.
        snippet: `secret-body-${row.id}`,
        truncated: false,
        createdAt: row.createdAt,
      }));
    return okEnvelope({ items });
  };
}

async function openRepo(): Promise<{
  repo: KernelRepository;
  close: () => void;
}> {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  return {
    repo: createKernelRepository(handle.raw),
    close: () => closeKernelDatabase(handle),
  };
}

function at(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString();
}

function seed(
  specs: ReadonlyArray<{ kind: string; status: string; count: number }>,
): RecordRow[] {
  const rows: RecordRow[] = [];
  let offset = 0;
  for (const spec of specs) {
    for (let index = 0; index < spec.count; index += 1) {
      rows.push({
        id: `${spec.status}-${spec.kind}-${index}`,
        kind: spec.kind,
        status: spec.status,
        createdAt: at(offset),
      });
      offset += 1;
    }
  }
  return rows;
}

describe("memory content statistics", () => {
  it("counts active kinds and all statuses without returning bodies", async () => {
    const fixture = await openRepo();
    try {
      const state: CliState = {
        rows: seed([
          { kind: "user_fact", status: "active", count: 2 },
          { kind: "model_inference", status: "active", count: 1 },
          { kind: "summary", status: "active", count: 1 },
          { kind: "correction", status: "active", count: 1 },
          { kind: "user_fact", status: "retired", count: 2 },
          { kind: "summary", status: "superseded", count: 1 },
          { kind: "model_inference", status: "archived", count: 1 },
        ]),
        calls: [],
      };
      const service = makeService(fixture.repo, makeCli(state), () => T0);
      const stats = await service.getMemoryStats();
      expect(stats.byKind).toEqual({
        user_fact: 2,
        model_inference: 1,
        summary: 1,
        correction: 1,
      });
      expect(stats.byStatus).toEqual({
        active: 5,
        retired: 2,
        superseded: 1,
        archived: 1,
      });
      expect(stats.computedAt).toBe(T0);
      expect(stats.truncated).toBe(false);
      expect(JSON.stringify(stats)).not.toContain("secret-body");
      // One page per status when every status fits in the first page.
      expect(state.calls).toHaveLength(4);
      expect(state.calls.map((call) => call.status)).toEqual([
        "active",
        "retired",
        "superseded",
        "archived",
      ]);
    } finally {
      fixture.close();
    }
  });

  it("falls back to a smaller page size when remind rejects the limit", async () => {
    const fixture = await openRepo();
    try {
      const state: CliState = {
        rows: seed([{ kind: "user_fact", status: "active", count: 1 }]),
        calls: [],
        rejectOver: 50,
      };
      const service = makeService(fixture.repo, makeCli(state), () => T0);
      const stats = await service.getMemoryStats();
      expect(stats.byStatus.active).toBe(1);
      expect(state.calls[0]?.limit).toBe(100);
      expect(state.calls[1]?.limit).toBe(25);
      expect(state.calls.slice(1).every((call) => call.limit === 25)).toBe(
        true,
      );
    } finally {
      fixture.close();
    }
  });

  it("caches for five minutes and collapses concurrent reads to one walk", async () => {
    const fixture = await openRepo();
    try {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const state: CliState = {
        rows: seed([{ kind: "user_fact", status: "active", count: 1 }]),
        calls: [],
        delay: gate,
      };
      let clock = T0;
      const service = makeService(fixture.repo, makeCli(state), () => clock);
      const first = service.getMemoryStats();
      const second = service.getMemoryStats();
      // Both callers await the SAME in-flight walk (one active page).
      expect(state.calls).toHaveLength(1);
      release();
      const [a, b] = await Promise.all([first, second]);
      expect(a).toEqual(b);
      expect(state.calls).toHaveLength(4);

      clock = T0 + MEMORY_STATS_CACHE_TTL_MS - 1;
      await service.getMemoryStats();
      expect(state.calls).toHaveLength(4);

      clock = T0 + MEMORY_STATS_CACHE_TTL_MS;
      await service.getMemoryStats();
      expect(state.calls).toHaveLength(8);
    } finally {
      fixture.close();
    }
  });

  it("stops at the row cap and marks the snapshot truncated", async () => {
    const fixture = await openRepo();
    try {
      const state: CliState = {
        rows: seed([
          {
            kind: "user_fact",
            status: "active",
            count: MEMORY_STATS_ACTIVE_ROW_CAP + 20,
          },
          {
            kind: "summary",
            status: "archived",
            count: MEMORY_STATS_STATUS_ROW_CAP + 50,
          },
        ]),
        calls: [],
      };
      const service = makeService(fixture.repo, makeCli(state), () => T0);
      const stats = await service.getMemoryStats();
      expect(stats.truncated).toBe(true);
      expect(stats.byStatus.active).toBe(MEMORY_STATS_ACTIVE_ROW_CAP);
      expect(stats.byKind.user_fact).toBe(MEMORY_STATS_ACTIVE_ROW_CAP);
      expect(stats.byStatus.archived).toBe(MEMORY_STATS_STATUS_ROW_CAP);
    } finally {
      fixture.close();
    }
  });
});
