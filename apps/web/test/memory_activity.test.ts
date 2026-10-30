// Read-only "学習の動き" view model: strict numeric parsing + card/bar
// decisions used by MemoryActivityPanel (pure, no DOM).
import { describe, expect, it } from "vitest";
import {
  dailyActivity,
  formatRunCounts,
  MEMORY_IMPORTANCE_LABELS,
  MEMORY_KIND_LABELS,
  MEMORY_MAINTENANCE_OPS,
  MEMORY_STATUS_LABELS,
  memoryImportanceBars,
  memoryKindBars,
  memoryStatusCards,
  outcomeText,
  parseActivityList,
  parseActivitySummary,
  parseLearningProposals,
  parseMemoryStats,
  resultLabel,
  statusTone,
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

describe("statusTone + outcomeText", () => {
  const base = {
    id: "r",
    op: "maintain.consolidate" as const,
    scope: "default",
    startedAt: T0,
    finishedAt: T0,
    ok: true,
    errorCode: null,
    counts: {} as Record<string, number>,
  };

  it("consolidate omits zero counts", () => {
    const run = {
      ...base,
      counts: { applied: 3, unchanged: 2, no_grounded: 1, deferred: 0 },
    };
    expect(statusTone(run)).toBe("ok");
    expect(outcomeText(run)).toBe(
      "統合を 3 件書き込み、変更なし 2、根拠不足 1",
    );
  });

  it("distill / associate / topic.backfill", () => {
    expect(
      outcomeText({
        ...base,
        op: "maintain.distill",
        counts: { applied: 2, reviewed: 5, failed: 1, deferred: 3 },
      }),
    ).toBe("蒸留を 2 件適用、確認 5、失敗 1、保留 3");
    expect(
      outcomeText({
        ...base,
        op: "maintain.associate",
        counts: {
          applied: 4,
          embedded: 6,
          edges_written: 9,
          edges_removed: 2,
          remaining: 7,
          topics_written: 1,
        },
      }),
    ).toBe("関連付けを 4 件更新、埋め込み 6、辺 +9/−2、トピック 1、残り 7");
    expect(
      outcomeText({
        ...base,
        op: "topic.backfill",
        counts: { assigned: 5, remaining: 2, failed: 0 },
      }),
    ).toBe("5 件にトピックを付与、残り 2");
  });

  it("activation includes the weight-learning line", () => {
    const act = {
      ...base,
      op: "maintain.activation" as const,
      counts: { scored: 10, retired: 1, would_reactivate: 2 },
    };
    expect(outcomeText(act)).toBe("10 件を採点、退役 1、再活性候補 2");
    expect(
      outcomeText({
        ...act,
        counts: { scored: 10, learn_examples: 30, learn_positives: 29 },
      }),
    ).toBe("10 件を採点\n重み学習: 未試行（正例 29 / 例 30）");
    expect(
      outcomeText({
        ...act,
        counts: {
          scored: 10,
          learn_examples: 30,
          learn_positives: 29,
          learn_skipped_min_positives: 1,
        },
      }),
    ).toBe(
      "10 件を採点\n重み学習: 未試行（正例 29 / 例 30、理由: 正例が不足）",
    );
    expect(
      outcomeText({
        ...act,
        counts: { scored: 10, learn_attempted: 1, learn_accepted: 1 },
      }),
    ).toBe("10 件を採点\n重み学習: 受理");
    expect(
      outcomeText({
        ...act,
        counts: { scored: 10, learn_attempted: 1, learn_accepted: 0 },
      }),
    ).toBe("10 件を採点\n重み学習: 棄却（holdout 改善なし）");
  });

  it("failure, preempted and degraded", () => {
    const failed = { ...base, ok: false, errorCode: "timeout" };
    expect(statusTone(failed)).toBe("failed");
    expect(outcomeText(failed)).toBe(
      "理由: タイムアウト。この回の変更は反映されていない可能性があります（成功済みは保持）",
    );
    const pre = { ...base, ok: false, errorCode: "preempted" };
    expect(statusTone(pre)).toBe("preempted");
    expect(resultLabel(pre)).toBe("中断");
    expect(outcomeText(pre)).toBe("優先処理のため見送り、後で再試行");
    const deg = { ...base, counts: { degraded: 1 } };
    expect(statusTone(deg)).toBe("degraded");
    expect(resultLabel(deg)).toBe("縮退");
    expect(outcomeText(deg)).toBe("モデル/索引が使えず、状態を変えずに継続");
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

describe("parseMemoryStats + memory stats view", () => {
  const statsBody = {
    byKind: {
      user_fact: 4,
      model_inference: 2,
      summary: 1,
      correction: 1,
    },
    byStatus: {
      active: 8,
      retired: 3,
      superseded: 2,
      archived: 1,
    },
    importance: {
      scored: 6,
      unscored: 2,
      buckets: [
        { lt: 0.2, count: 1 },
        { lt: 0.4, count: 2 },
        { lt: 0.6, count: 1 },
        { lt: 0.8, count: 1 },
        { lt: 1.0001, count: 1 },
      ],
    },
    computedAt: T0,
    truncated: false,
  };

  it("strictly parses numeric counts and fixed status keys", () => {
    const stats = parseMemoryStats(statsBody);
    expect(stats).not.toBeNull();
    expect(memoryStatusCards(stats as NonNullable<typeof stats>)).toEqual([
      { key: "active", label: "有効", value: 8 },
      { key: "retired", label: "退役", value: 3 },
      { key: "superseded", label: "置換済み", value: 2 },
      { key: "archived", label: "保管", value: 1 },
    ]);
    const bars = memoryKindBars(stats as NonNullable<typeof stats>);
    expect(bars.map((bar) => bar.label)).toEqual([
      MEMORY_KIND_LABELS.user_fact,
      MEMORY_KIND_LABELS.model_inference,
      MEMORY_KIND_LABELS.summary,
      MEMORY_KIND_LABELS.correction,
    ]);
    expect(bars[0]).toMatchObject({ value: 4, percent: 100 });
    expect(bars[3]).toMatchObject({ value: 1, percent: 25 });
    expect(MEMORY_STATUS_LABELS.active).toBe("有効");
  });

  it("renders the importance buckets plus the unscored bar", () => {
    const stats = parseMemoryStats(statsBody);
    expect(stats).not.toBeNull();
    const bars = memoryImportanceBars(stats as NonNullable<typeof stats>);
    expect(bars.map((bar) => bar.label)).toEqual([
      ...MEMORY_IMPORTANCE_LABELS,
      "未採点",
    ]);
    expect(bars.map((bar) => bar.value)).toEqual([1, 2, 1, 1, 1, 2]);
    expect(bars[1]).toMatchObject({ value: 2, percent: 100 });
    expect(bars[5]).toMatchObject({ value: 2, percent: 100 });
  });

  it("omits the importance chart for the paged fallback", () => {
    const withoutImportance = { ...statsBody } as Record<string, unknown>;
    delete withoutImportance.importance;
    const stats = parseMemoryStats(withoutImportance);
    expect(stats).not.toBeNull();
    expect(memoryImportanceBars(stats as NonNullable<typeof stats>)).toEqual(
      [],
    );
  });

  it("rejects missing/negative/float counts and non-boolean truncation", () => {
    expect(
      parseMemoryStats({ ...statsBody, byKind: { user_fact: 1 } }),
    ).toBeNull();
    expect(
      parseMemoryStats({
        ...statsBody,
        byStatus: { ...statsBody.byStatus, active: -1 },
      }),
    ).toBeNull();
    expect(
      parseMemoryStats({
        ...statsBody,
        byKind: { ...statsBody.byKind, summary: 1.5 },
      }),
    ).toBeNull();
    expect(parseMemoryStats({ ...statsBody, truncated: "no" })).toBeNull();
    expect(
      parseMemoryStats({
        ...statsBody,
        importance: { ...statsBody.importance, scored: -1 },
      }),
    ).toBeNull();
    expect(
      parseMemoryStats({
        ...statsBody,
        importance: {
          ...statsBody.importance,
          buckets: statsBody.importance.buckets.slice(0, 4),
        },
      }),
    ).toBeNull();
    expect(parseMemoryStats(null)).toBeNull();
  });
});
