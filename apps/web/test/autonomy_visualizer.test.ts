import { describe, expect, test } from "vitest";
import {
  BAR_TOTAL_WIDTH,
  buildAutonomyGraphLayout,
  buildAutonomyMetrics,
  buildTaskKanbanLanes,
  parseConflictPairs,
  parseHistorySteps,
  STANDALONE_NODE_ID,
  type VisPurpose,
  type VisTask,
} from "../src/lib/autonomy_visualizer.js";

const SAMPLE_PURPOSES: VisPurpose[] = [
  {
    id: "p-active",
    statement: "毎日30分ウォーキングする",
    kind: "goal",
    status: "active",
    validFrom: "",
    validUntil: "",
    explicit: true,
    sourceKind: "user",
  },
  {
    id: "p-constraint",
    statement: "雨の日は無理をしない",
    kind: "constraint",
    status: "active",
    validFrom: "",
    validUntil: "",
    explicit: true,
    sourceKind: "user",
  },
  {
    id: "p-done",
    statement: "靴を新調する",
    kind: "wish",
    status: "achieved",
    validFrom: "",
    validUntil: "",
    explicit: true,
    sourceKind: "user",
  },
];

const SAMPLE_TASKS: VisTask[] = [
  {
    id: "t-run",
    title: "朝コースの確認",
    kind: "task",
    status: "in_progress",
    deadline: "2026-11-30T09:00:00+09:00",
    parentPurposeId: "p-active",
  },
  {
    id: "t-hold",
    title: "雨具の準備",
    kind: "problem",
    status: "held",
    deadline: "",
    parentPurposeId: "p-constraint",
  },
  {
    id: "t-solo",
    title: "ストレッチ記録",
    kind: "chat",
    status: "open",
    deadline: "",
    parentPurposeId: null,
  },
];

describe("autonomy_visualizer", () => {
  test("parseConflictPairs deduplicates and normalizes purposeIds", () => {
    const pairs = parseConflictPairs({
      conflicts: [
        { id: "c1", purposeIds: ["p-active", "p-constraint"] },
        { id: "c2", purposeIds: ["p-constraint", "p-active"] },
        { id: "c3", purposeIds: ["p-active"] },
      ],
    });
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toEqual({
      id: "c1",
      purposeAId: "p-active",
      purposeBId: "p-constraint",
    });
  });

  test("parseHistorySteps produces semantic tones and Japanese event labels", () => {
    const steps = parseHistorySteps(
      [
        { seq: 1, event: "created", fromStatus: null, toStatus: "open" },
        {
          seq: 2,
          event: "held",
          fromStatus: "open",
          toStatus: "held",
          note: "weather",
        },
        {
          seq: 3,
          event: "resumed",
          fromStatus: "held",
          toStatus: "in_progress",
          note: "clear",
        },
      ],
      true,
    );
    expect(steps).toHaveLength(3);
    expect(steps[0]?.eventLabel).toBe("作成");
    expect(steps[0]?.tone).toBe("accent");
    expect(steps[1]?.tone).toBe("warn");
    expect(steps[1]?.note).toBe("weather");
    expect(steps[2]?.tone).toBe("ok");
  });

  test("buildAutonomyMetrics computes donut and stacked bar segments", () => {
    const metrics = buildAutonomyMetrics(SAMPLE_PURPOSES, SAMPLE_TASKS);
    expect(metrics.purposeTotal).toBe(3);
    expect(metrics.purposeActive).toBe(2);
    expect(metrics.purposeAchieved).toBe(1);
    expect(metrics.taskTotal).toBe(3);
    expect(metrics.donutSegments).toHaveLength(2);
    const totalBarW = metrics.taskBarSegments.reduce(
      (sum, s) => sum + s.width,
      0,
    );
    expect(Math.round(totalBarW)).toBe(BAR_TOTAL_WIDTH);
  });

  test("buildAutonomyGraphLayout places purpose nodes, standalone hub, edges, and conflict arcs", () => {
    const conflicts = parseConflictPairs({
      conflicts: [{ id: "c1", purposeIds: ["p-active", "p-constraint"] }],
    });
    const layout = buildAutonomyGraphLayout(
      SAMPLE_PURPOSES,
      SAMPLE_TASKS,
      conflicts,
      "p-active",
      "t-run",
      "p-constraint",
    );
    // 3 real purposes + 1 standalone hub
    expect(layout.purposeNodes).toHaveLength(4);
    expect(
      layout.purposeNodes.some(
        (n) => n.id === STANDALONE_NODE_ID && n.standalone,
      ),
    ).toBe(true);
    const activeNode = layout.purposeNodes.find((n) => n.id === "p-active");
    expect(activeNode?.selected).toBe(true);
    expect(activeNode?.conflicting).toBe(true);
    const armedNode = layout.purposeNodes.find((n) => n.id === "p-constraint");
    expect(armedNode?.armed).toBe(true);

    expect(layout.taskNodes).toHaveLength(3);
    expect(layout.edges).toHaveLength(3);
    expect(layout.edges.find((e) => e.toTaskId === "t-run")?.highlighted).toBe(
      true,
    );
    expect(layout.conflictArcs).toHaveLength(1);
    expect(layout.conflictArcs[0]?.highlighted).toBe(true);
  });

  test("buildTaskKanbanLanes groups tasks by lifecycle stage with parent labels", () => {
    const lanes = buildTaskKanbanLanes(
      SAMPLE_TASKS,
      SAMPLE_PURPOSES,
      "p-active",
      "t-run",
    );
    expect(lanes.map((l) => l.key)).toEqual([
      "open",
      "in_progress",
      "held",
      "done",
    ]);
    const inProgress = lanes.find((l) => l.key === "in_progress");
    expect(inProgress?.items).toHaveLength(1);
    expect(inProgress?.items[0]?.parentStatement).toContain("ウォーキング");
    expect(inProgress?.items[0]?.attachedToSelectedPurpose).toBe(true);
    expect(inProgress?.items[0]?.selected).toBe(true);
  });
});
