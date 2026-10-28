// Memory maintenance activity storage: insert, newest-first keyset pages,
// retention (newest 2000 rows + 30 days), and fixed numeric counts only.

import { afterEach, describe, expect, it } from "vitest";
import {
  closeKernelDatabase,
  createKernelRepository,
  type KernelRepository,
  MEMORY_MAINTENANCE_RETENTION_ROWS,
  migrateKernelDatabase,
  openKernelDatabase,
} from "../src/index.js";

const T0 = 1790000000000;
const DAY = 24 * 60 * 60 * 1000;

interface Fixture {
  repo: KernelRepository;
  close: () => void;
}

async function openRepo(): Promise<Fixture> {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  return {
    repo: createKernelRepository(handle.raw),
    close: () => closeKernelDatabase(handle),
  };
}

let fixtures: Fixture[] = [];
afterEach(() => {
  for (const fixture of fixtures) fixture.close();
  fixtures = [];
});

async function makeRepo(): Promise<KernelRepository> {
  const fixture = await openRepo();
  fixtures.push(fixture);
  return fixture.repo;
}

describe("memory maintenance activity storage", () => {
  it("inserts and lists runs newest first with a keyset cursor", async () => {
    const repo = await makeRepo();
    const first = repo.insertMemoryMaintenanceRun({
      op: "maintain.consolidate",
      scope: "s",
      startedAt: T0,
      finishedAt: T0 + 10,
      ok: true,
      counts: { applied: 2, written: 1, degraded: 0 },
    });
    const second = repo.insertMemoryMaintenanceRun({
      op: "maintain.activation",
      scope: "s",
      startedAt: T0 + 20,
      finishedAt: T0 + 30,
      ok: false,
      errorCode: "timeout",
      counts: {},
    });
    const third = repo.insertMemoryMaintenanceRun({
      op: "topic.backfill",
      scope: "s",
      startedAt: T0 + 40,
      finishedAt: T0 + 50,
      ok: true,
      counts: { pending: 3, assigned: 2, skipped: 1 },
    });

    const page1 = repo.listMemoryMaintenanceRuns({ limit: 2 });
    expect(page1.items.map((run) => run.id)).toEqual([third.id, second.id]);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).not.toBeNull();
    expect(page1.items[1]).toMatchObject({
      op: "maintain.activation",
      ok: false,
      errorCode: "timeout",
      counts: {},
    });

    const page2 = repo.listMemoryMaintenanceRuns({
      limit: 2,
      cursor: page1.nextCursor as string,
    });
    expect(page2.items.map((run) => run.id)).toEqual([first.id]);
    expect(page2.hasMore).toBe(false);
    expect(page2.nextCursor).toBeNull();
  });

  it("keeps keyset ordering stable for equal timestamps", async () => {
    const repo = await makeRepo();
    const ids = Array.from(
      { length: 4 },
      () =>
        repo.insertMemoryMaintenanceRun({
          op: "maintain.associate",
          scope: "s",
          startedAt: T0,
          finishedAt: T0 + 1,
          ok: true,
          counts: { remaining: 0 },
        }).id,
    );
    const all = repo.listMemoryMaintenanceRuns({ limit: 100 });
    expect(all.items.map((run) => run.id)).toEqual([...ids].sort().reverse());
  });

  it("rejects non-numeric or unknown counts and wrong ok/error coupling", async () => {
    const repo = await makeRepo();
    expect(() =>
      repo.insertMemoryMaintenanceRun({
        op: "maintain.consolidate",
        scope: "s",
        startedAt: T0,
        finishedAt: T0,
        ok: true,
        counts: { applied: 1, body: "secret" } as never,
      }),
    ).toThrow();
    expect(() =>
      repo.insertMemoryMaintenanceRun({
        op: "maintain.consolidate",
        scope: "s",
        startedAt: T0,
        finishedAt: T0,
        ok: true,
        counts: { applied: -1 },
      }),
    ).toThrow();
    expect(() =>
      repo.insertMemoryMaintenanceRun({
        op: "maintain.activation",
        scope: "s",
        startedAt: T0,
        finishedAt: T0,
        ok: true,
        errorCode: "timeout",
        counts: {},
      }),
    ).toThrow();
    expect(() =>
      repo.insertMemoryMaintenanceRun({
        op: "maintain.activation",
        scope: "s",
        startedAt: T0,
        finishedAt: T0,
        ok: false,
        counts: {},
      }),
    ).toThrow();
  });

  it("prunes rows older than 30 days on insert", async () => {
    const repo = await makeRepo();
    const old = repo.insertMemoryMaintenanceRun({
      op: "maintain.associate",
      scope: "s",
      startedAt: T0 - 40 * DAY,
      finishedAt: T0 - 40 * DAY,
      ok: true,
      counts: { remaining: 1 },
    });
    const fresh = repo.insertMemoryMaintenanceRun({
      op: "maintain.associate",
      scope: "s",
      startedAt: T0,
      finishedAt: T0,
      ok: true,
      counts: { remaining: 0 },
    });
    const page = repo.listMemoryMaintenanceRuns({ limit: 100 });
    expect(page.items.map((run) => run.id)).toEqual([fresh.id]);
    expect(page.items.some((run) => run.id === old.id)).toBe(false);
  });

  it("retains only the newest 2000 rows", async () => {
    const repo = await makeRepo();
    let firstId = "";
    for (let i = 0; i < MEMORY_MAINTENANCE_RETENTION_ROWS + 3; i += 1) {
      const run = repo.insertMemoryMaintenanceRun({
        op: "maintain.distill",
        scope: "s",
        startedAt: T0 + i,
        finishedAt: T0 + i,
        ok: true,
        counts: {},
      });
      if (i === 0) firstId = run.id;
    }
    const page = repo.listMemoryMaintenanceRuns({ limit: 100 });
    expect(page.items).toHaveLength(100);
    expect(page.items.some((run) => run.id === firstId)).toBe(false);
    const summary = repo.memoryMaintenanceSummary(T0 + 10_000);
    expect(summary.windows.last7d.ops["maintain.distill"].runs).toBe(
      MEMORY_MAINTENANCE_RETENTION_ROWS,
    );
  });
});
