// Read-only "学習の動き" view model: strict numeric parsing + card/bar
// decisions used by MemoryActivityPanel (pure, no DOM).
import { describe, expect, it } from "vitest";
import {
  dailyActivity,
  formatRunCounts,
  MEMORY_MAINTENANCE_OPS,
  parseActivityList,
  parseActivitySummary,
  parseLearningProposals,
  resultLabel,
  summaryCards,
} from "../src/lib/memory_activity.js";

const T0 = 1790000000000;

function opWindow(runs = 0, failed = 0, counts: Record<string, number> = {}) {
  return { runs, failed, counts };
}

function summaryBody() {
  return {
    generatedAt: T0,
    windows: {
      last24h: {
        runs: 4,
        failed: 1,
        ops: {
          "maintain.consolidate": opWindow(1, 0, { applied: 2 }),
          "maintain.associate": opWindow(1, 0, { remaining: 0 }),
          "maintain.activation": opWindow(1, 0, {
            scored: 4,
            retired: 2,
            reactivated: 1,
          }),
          "topic.backfill": opWindow(1, 1, { assigned: 3 }),
          "maintain.distill": opWindow(0, 0, {}),
        },
      },
      last7d: {
        runs: 4,
        failed: 1,
        ops: {
          "maintain.consolidate": opWindow(1, 0, { applied: 2 }),
          "maintain.associate": opWindow(1, 0, { remaining: 0 }),
          "maintain.activation": opWindow(1, 0, {
            scored: 4,
            retired: 2,
            reactivated: 1,
          }),
          "topic.backfill": opWindow(1, 1, { assigned: 3 }),
          "maintain.distill": opWindow(0, 0, {}),
        },
      },
    },
    latestByOp: {
      "maintain.consolidate": {
        finishedAt: T0,
        ok: true,
        errorCode: null,
        counts: { applied: 2 },
      },
      "maintain.associate": null,
      "maintain.activation": {
        finishedAt: T0,
        ok: false,
        errorCode: "timeout",
        counts: {},
      },
      "topic.backfill": null,
      "maintain.distill": null,
    },
  };
}

describe("parseActivityList", () => {
  it("accepts fixed numeric run rows and rejects text/unknown shapes", () => {
    const body = {
      items: [
        {
          id: "run-1",
          op: "maintain.activation",
          scope: "default",
          startedAt: T0,
          finishedAt: T0 + 10,
          ok: false,
          errorCode: "timeout",
          counts: { scored: 1 },
        },
      ],
      nextCursor: null,
      hasMore: false,
    };
    expect(parseActivityList(body)).toEqual(body);
    expect(
      parseActivityList({
        ...body,
        items: [{ ...body.items[0], counts: { body: "secret" } }],
      }),
    ).toBeNull();
    expect(
      parseActivityList({
        ...body,
        items: [{ ...body.items[0], op: "maintain.unknown" }],
      }),
    ).toBeNull();
  });
});

describe("parseActivitySummary + summaryCards", () => {
  it("derives the six 24h cards from fixed numeric counts", () => {
    const summary = parseActivitySummary(summaryBody());
    expect(summary).not.toBeNull();
    expect(summaryCards(summary as NonNullable<typeof summary>)).toMatchObject([
      { key: "consolidate", value: 2 },
      { key: "associate", value: 1 },
      { key: "activation", value: 4 },
      { key: "retired", value: 2 },
      { key: "reactivated", value: 1 },
      { key: "topics", value: 3 },
    ]);
  });

  it("requires every fixed op window and non-negative numeric counts", () => {
    const body = summaryBody();
    expect(parseActivitySummary(body)).not.toBeNull();
    const missingOp = summaryBody();
    delete (missingOp.windows.last24h.ops as Record<string, unknown>)[
      "maintain.distill"
    ];
    expect(parseActivitySummary(missingOp)).toBeNull();
    const negative = summaryBody();
    negative.windows.last24h.ops["maintain.consolidate"] = opWindow(1, 0, {
      applied: -1,
    });
    expect(parseActivitySummary(negative)).toBeNull();
  });

  it("formats failure/degraded results without free text", () => {
    const run = {
      id: "run-1",
      op: "maintain.activation" as const,
      scope: "default",
      startedAt: T0,
      finishedAt: T0,
      ok: false,
      errorCode: "timeout",
      counts: {},
    };
    expect(resultLabel(run)).toBe("失敗（タイムアウト）");
    expect(formatRunCounts({ ...run, ok: true, counts: { degraded: 1 } })).toBe(
      "縮退 1",
    );
  });
});

describe("dailyActivity", () => {
  it("buckets completed runs into seven local days ending today", () => {
    const now = new Date(2026, 0, 10, 12, 0, 0).getTime();
    const runs = [
      {
        id: "run-1",
        op: "maintain.associate" as const,
        scope: "default",
        startedAt: now,
        finishedAt: now,
        ok: true,
        errorCode: null,
        counts: {},
      },
      {
        id: "run-2",
        op: "maintain.associate" as const,
        scope: "default",
        startedAt: now - 2 * 24 * 60 * 60 * 1000,
        finishedAt: now - 2 * 24 * 60 * 60 * 1000,
        ok: true,
        errorCode: null,
        counts: {},
      },
    ];
    const buckets = dailyActivity(runs, now);
    expect(buckets).toHaveLength(7);
    expect(buckets.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(2);
    expect(buckets[6]?.count).toBe(1);
    expect(buckets[4]?.count).toBe(1);
    for (const op of MEMORY_MAINTENANCE_OPS) {
      expect(dailyActivity(runs, now, op)).toHaveLength(7);
    }
  });
});

describe("parseLearningProposals", () => {
  it("accepts bounded proposal fields and rejects unknown kinds", () => {
    const body = {
      items: [
        {
          id: "proposal-1",
          kind: "observation",
          lesson: "朝の方が集中できる",
          evidence: "run-1",
          applicability: "予定調整",
          status: "pending",
          createdAt: T0,
          decidedAt: null,
        },
      ],
    };
    expect(parseLearningProposals(body)).toEqual(body.items);
    expect(
      parseLearningProposals({
        items: [{ ...body.items[0], kind: "free_text_kind" }],
      }),
    ).toBeNull();
  });
});
