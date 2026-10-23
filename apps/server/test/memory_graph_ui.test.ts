// Conversation-memory graph UI: deterministic layout maths (Node, no DOM)
// plus the SSR shell gate for the new graph controls.

import { describe, expect, it } from "vitest";
import {
  buildNeighborMap,
  createLayout,
  FIT_VIEW_RATIO,
  fitCamera,
  formatRecordedAt,
  GRAPH_HEIGHT,
  GRAPH_WIDTH,
  type GraphData,
  type GraphEdgeData,
  type GraphNodeData,
  graphBounds,
  highlightHandles,
  LABEL_FONT_SIZE,
  LABEL_MAX_CHARS,
  LABEL_SMALL_MAX_CHARS,
  type LabelCandidate,
  labelCharLimit,
  labelMatches,
  layoutStep,
  MAX_ZOOM,
  MIN_ZOOM,
  memoryListRows,
  parseGraphData,
  runLayout,
  screenToWorld,
  selectVisibleLabels,
  TOPIC_HUB_MIN_MEMBERS,
  TOPIC_HUB_PREFIX,
  topicHubHandle,
  truncateLabel,
  withTopicHubs,
  worldToScreen,
  zoomAt,
} from "../src/ui/graph.js";
import {
  browseRunId,
  returnToBrowseGenerations,
  searchButtonDisabledAfterAbandon,
} from "../src/ui/memory_list_actions.js";
import {
  renderConversationShell,
  shellHasNoInlineScript,
} from "../src/ui/page.js";

const NODES: GraphNodeData[] = [
  {
    handle: "m1",
    label: "Alpha memory",
    status: "active",
    kind: "user_fact",
    episode: null,
  },
  {
    handle: "m2",
    label: "Beta summary",
    status: "retired",
    kind: "summary",
    episode: null,
  },
  {
    handle: "m3",
    label: "Gamma inference",
    status: "active",
    kind: "model_inference",
    episode: null,
  },
];

const EDGES: GraphEdgeData[] = [
  { from: "m1", to: "m2", kind: "related" },
  { from: "m2", to: "m3", kind: "consolidation" },
];

describe("memory graph layout", () => {
  it("converges and stays deterministic for the same input", () => {
    const first = runLayout(createLayout(NODES, EDGES));
    const second = runLayout(createLayout(NODES, EDGES));
    expect(first.alpha).toBe(0);
    expect(first.steps).toBeGreaterThan(0);
    expect(first.steps).toBeLessThanOrEqual(600);
    expect(first.nodes.map((node) => [node.x, node.y])).toEqual(
      second.nodes.map((node) => [node.x, node.y]),
    );
    // A further tick is a no-op once alpha reached zero.
    const before = first.nodes.map((node) => [node.x, node.y]);
    layoutStep(first);
    expect(first.nodes.map((node) => [node.x, node.y])).toEqual(before);
  });

  it("lays out in the measured canvas size, not the fixed default", () => {
    const layout = createLayout(NODES, EDGES, 1534, 720);
    expect(layout.width).toBe(1534);
    expect(layout.height).toBe(720);
    // A larger canvas increases the spacing target, so the settled graph
    // spreads further instead of clumping into the same fixed pixel area.
    const small = runLayout(createLayout(NODES, EDGES, 800, 480));
    const large = runLayout(createLayout(NODES, EDGES, 1534, 720));
    const span = (value: typeof small): number => {
      const bounds = graphBounds(value.nodes);
      return bounds === null ? 0 : bounds.width + bounds.height;
    };
    expect(span(large)).toBeGreaterThan(span(small));
  });

  it("does not pin nodes into rows on the canvas top/bottom edges", () => {
    // 60 densely related memories: the old hard clamp pushed every node
    // beyond the box onto y = ±(height/2 - radius), producing flat rows along
    // the top and bottom while the horizontal space stayed empty.
    const nodes: GraphNodeData[] = Array.from({ length: 60 }, (_, index) => ({
      handle: `m${index + 1}`,
      label: `memory ${index + 1}`,
      status: "active" as const,
      kind: "user_fact",
      episode: null,
    }));
    const edges: GraphEdgeData[] = [];
    for (let index = 1; index < nodes.length; index += 1) {
      edges.push({
        from: `m${index + 1}`,
        to: `m${Math.max(1, index - (index % 5))}`,
        kind: "related",
      });
      if (index % 7 === 0) {
        edges.push({
          from: `m${index + 1}`,
          to: `m${Math.max(1, index - 1)}`,
          kind: "similar",
        });
      }
    }
    const width = 1534;
    const height = 480;
    const layout = runLayout(createLayout(nodes, edges, width, height));
    const bounds = graphBounds(layout.nodes);
    expect(bounds).not.toBeNull();
    if (bounds === null) {
      return;
    }
    const nearTop = layout.nodes.filter(
      (node) => Math.abs(node.y - node.radius - bounds.minY) <= 2,
    ).length;
    const nearBottom = layout.nodes.filter(
      (node) => Math.abs(node.y + node.radius - bounds.maxY) <= 2,
    ).length;
    // A bbox extreme always contains at least one node; a clamped row had
    // dozens sharing the same edge line.
    expect(nearTop).toBeLessThanOrEqual(3);
    expect(nearBottom).toBeLessThanOrEqual(3);
    // Aspect-aware gravity lets the settled bbox roughly match the wide
    // canvas rather than forming a square clump in the middle.
    const settledAspect = bounds.width / bounds.height;
    const canvasAspect = width / height;
    expect(settledAspect / canvasAspect).toBeGreaterThan(0.7);
    expect(settledAspect / canvasAspect).toBeLessThan(1.3);
  });

  it("keeps the small graph's resting nodes from overlapping", () => {
    const layout = runLayout(createLayout(NODES, EDGES));
    for (let i = 0; i < layout.nodes.length; i += 1) {
      const a = layout.nodes[i];
      if (a === undefined) {
        continue;
      }
      for (let j = i + 1; j < layout.nodes.length; j += 1) {
        const b = layout.nodes[j];
        if (b === undefined) {
          continue;
        }
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        expect(distance).toBeGreaterThanOrEqual(a.radius + b.radius);
      }
    }
  });

  it("builds neighbour maps and the self+neighbour highlight set", () => {
    const map = buildNeighborMap(NODES, [
      ...EDGES,
      { from: "m1", to: "m9", kind: "related" },
    ]);
    expect([...(map.get("m1") ?? [])].sort()).toEqual(["m2"]);
    expect([...(map.get("m2") ?? [])].sort()).toEqual(["m1", "m3"]);
    expect([...highlightHandles("m2", map)].sort()).toEqual(["m1", "m2", "m3"]);
    expect([...highlightHandles("unknown", map)]).toEqual(["unknown"]);
  });

  it("matches labels case-insensitively and ignores an empty query", () => {
    expect(labelMatches("Alpha memory", "ALPHA")).toBe(true);
    expect(labelMatches("Beta summary", "sum")).toBe(true);
    expect(labelMatches("Gamma", "delta")).toBe(false);
    expect(labelMatches("Gamma", "   ")).toBe(false);
  });

  it("zooms around the cursor without moving that world point", () => {
    const camera = { scale: 1.25, tx: 90, ty: 40 };
    const cursor = { x: 320, y: 180 };
    const before = screenToWorld(camera, cursor.x, cursor.y);
    const zoomed = zoomAt(camera, cursor.x, cursor.y, 1.8);
    const after = screenToWorld(zoomed, cursor.x, cursor.y);
    expect(zoomed.scale).toBeGreaterThan(camera.scale);
    expect(after.x).toBeCloseTo(before.x, 8);
    expect(after.y).toBeCloseTo(before.y, 8);
  });
});

describe("memory graph fit-to-view and labels", () => {
  it("fits the bounding box to 85% of the limiting canvas dimension", () => {
    const nodes = [
      { x: -120, y: -80, radius: 8 },
      { x: 120, y: 80, radius: 8 },
    ];
    const camera = fitCamera(nodes, 800, 480);
    // Width span 256, height span 176: the height is the limiting dimension.
    expect(camera.scale).toBeCloseTo((FIT_VIEW_RATIO * 480) / 176, 8);
    const topLeft = worldToScreen(camera, -128, -88);
    const bottomRight = worldToScreen(camera, 128, 88);
    expect(bottomRight.y - topLeft.y).toBeCloseTo(480 * FIT_VIEW_RATIO, 6);
    expect(bottomRight.x - topLeft.x).toBeLessThanOrEqual(800 * FIT_VIEW_RATIO);
    // The fitted box is centred on the canvas.
    expect((topLeft.x + bottomRight.x) / 2).toBeCloseTo(400, 6);
    expect((topLeft.y + bottomRight.y) / 2).toBeCloseTo(240, 6);
    // And fully inside the canvas.
    expect(topLeft.x).toBeGreaterThanOrEqual(0);
    expect(topLeft.y).toBeGreaterThanOrEqual(0);
    expect(bottomRight.x).toBeLessThanOrEqual(800);
    expect(bottomRight.y).toBeLessThanOrEqual(480);
  });

  it("keeps two disconnected components centred and fills the fitted canvas", () => {
    // Two chains with NO edges between them: repulsion alone would push the
    // clusters apart forever, so per-node gravity must keep the settled
    // bounding box near the layout origin.
    const component = (prefix: string): GraphNodeData[] =>
      Array.from({ length: 6 }, (_, index) => ({
        handle: `${prefix}${index}`,
        label: `${prefix} ${index}`,
        status: "active" as const,
        kind: "user_fact",
        episode: null,
      }));
    const chain = (prefix: string): GraphEdgeData[] =>
      Array.from({ length: 5 }, (_, index) => ({
        from: `${prefix}${index}`,
        to: `${prefix}${index + 1}`,
        kind: "related" as const,
      }));
    const nodes = [...component("a"), ...component("b")];
    const edges = [...chain("a"), ...chain("b")];
    const layout = runLayout(createLayout(nodes, edges));
    const bounds = graphBounds(layout.nodes);
    expect(bounds).not.toBeNull();
    if (bounds === null) {
      return;
    }
    const centerX = (bounds.minX + bounds.maxX) / 2;
    const centerY = (bounds.minY + bounds.maxY) / 2;
    // "Small distance" is relative to the graph size, so this scales with
    // both a compact two-cluster graph and a 500-node one.
    const tolerance = Math.max(
      24,
      Math.min(bounds.width, bounds.height) * 0.05,
    );
    expect(Math.hypot(centerX, centerY)).toBeLessThan(tolerance);

    const width = GRAPH_WIDTH;
    const height = GRAPH_HEIGHT;
    const camera = fitCamera(layout.nodes, width, height);
    const topLeft = worldToScreen(camera, bounds.minX, bounds.minY);
    const bottomRight = worldToScreen(camera, bounds.maxX, bounds.maxY);
    const spanX = (bottomRight.x - topLeft.x) / width;
    const spanY = (bottomRight.y - topLeft.y) / height;
    // The fitted transform must actually be applied: the limiting dimension
    // fills at least 80% of the canvas (fit ratio is 85%).
    expect(Math.max(spanX, spanY)).toBeGreaterThanOrEqual(0.8);
    expect(Math.max(spanX, spanY)).toBeLessThanOrEqual(FIT_VIEW_RATIO + 0.001);
    // And the settled bbox centre lands on the canvas centre.
    expect((topLeft.x + bottomRight.x) / 2).toBeCloseTo(width / 2, 4);
    expect((topLeft.y + bottomRight.y) / 2).toBeCloseTo(height / 2, 4);
  });

  it("clamps fit scale to the shared zoom range and handles empty input", () => {
    expect(fitCamera([{ x: 0, y: 0, radius: 6 }]).scale).toBe(MAX_ZOOM);
    expect(
      fitCamera([
        { x: -100_000, y: -100_000, radius: 6 },
        { x: 100_000, y: 100_000, radius: 6 },
      ]).scale,
    ).toBe(MIN_ZOOM);
    expect(fitCamera([])).toEqual({ scale: 1, tx: 400, ty: 240 });
  });

  it("centres nodes whose bbox is offset from the world origin", () => {
    const camera = fitCamera(
      [
        { x: 1_000, y: 500, radius: 10 },
        { x: 1_200, y: 700, radius: 10 },
      ],
      800,
      480,
    );
    const center = worldToScreen(camera, 1_100, 600);
    expect(center.x).toBeCloseTo(400, 6);
    expect(center.y).toBeCloseTo(240, 6);
  });

  it("shortens the label budget when zoomed out", () => {
    expect(labelCharLimit(MIN_ZOOM)).toBe(LABEL_SMALL_MAX_CHARS);
    expect(labelCharLimit(1.19)).toBe(LABEL_SMALL_MAX_CHARS);
    expect(labelCharLimit(1.2)).toBe(LABEL_MAX_CHARS);
    expect(labelCharLimit(MAX_ZOOM)).toBe(LABEL_MAX_CHARS);
    expect(LABEL_SMALL_MAX_CHARS).toBeLessThan(LABEL_MAX_CHARS);
  });

  it("truncates long labels to the character budget with an ellipsis", () => {
    expect(truncateLabel("short label")).toBe("short label");
    const exact = "x".repeat(LABEL_MAX_CHARS);
    expect(truncateLabel(exact)).toBe(exact);
    const truncated = truncateLabel("y".repeat(LABEL_MAX_CHARS + 5));
    expect(Array.from(truncated)).toHaveLength(LABEL_MAX_CHARS);
    expect(truncated.endsWith("…")).toBe(true);
    expect(truncated).toBe(`${"y".repeat(LABEL_MAX_CHARS - 1)}…`);
    expect(
      Array.from(truncateLabel("日本語のとても長いラベルです".repeat(3))),
    ).toHaveLength(LABEL_MAX_CHARS);
  });
});

describe("label declutter", () => {
  const candidate = (
    overrides: Partial<LabelCandidate> & { handle: string },
  ): LabelCandidate => ({
    label: `label ${overrides.handle}`,
    x: 100,
    y: 100,
    radius: 8,
    degree: 1,
    ...overrides,
  });

  it("places labels that do not overlap and skips the ones that would", () => {
    const visible = selectVisibleLabels(
      [
        candidate({ handle: "a", x: 100, label: "Alpha" }),
        candidate({ handle: "b", x: 400, label: "Beta" }),
        candidate({ handle: "c", x: 700, label: "Gamma" }),
        // Directly on top of Alpha's label: must be dropped.
        candidate({ handle: "d", x: 100, label: "Delta" }),
      ],
      { fontSize: LABEL_FONT_SIZE, width: 1000, height: 600 },
    );
    const handles = visible.map((label) => label.handle).sort();
    expect(handles).toEqual(["a", "b", "c"]);
    for (let i = 0; i < visible.length; i += 1) {
      for (let j = i + 1; j < visible.length; j += 1) {
        const a = visible[i];
        const b = visible[j];
        if (a === undefined || b === undefined) continue;
        const overlap =
          a.x < b.x + b.width &&
          b.x < a.x + a.width &&
          a.y < b.y + b.height &&
          b.y < a.y + a.height;
        expect(overlap).toBe(false);
      }
    }
  });

  it("prioritises selected/hovered, then hubs, then degree", () => {
    const visible = selectVisibleLabels(
      [
        candidate({
          handle: "plain",
          degree: 30,
          label: "Plain high degree",
        }),
        candidate({
          handle: "hub",
          degree: 2,
          topicHub: true,
          label: "Topic hub",
        }),
        candidate({
          handle: "selected",
          degree: 0,
          selected: true,
          label: "Selected",
        }),
      ],
      { fontSize: LABEL_FONT_SIZE, width: 1000, height: 600 },
    );
    // All three share one anchor: only the top-priority label survives.
    expect(visible.map((label) => label.handle)).toEqual(["selected"]);

    const hubFirst = selectVisibleLabels(
      [
        candidate({ handle: "plain", degree: 30, label: "Plain high degree" }),
        candidate({
          handle: "hub",
          degree: 2,
          topicHub: true,
          label: "Topic hub",
        }),
      ],
      { fontSize: LABEL_FONT_SIZE, width: 1000, height: 600 },
    );
    expect(hubFirst.map((label) => label.handle)).toEqual(["hub"]);
  });

  it("always shows the selected label, even over a node disc", () => {
    const visible = selectVisibleLabels(
      [
        candidate({
          handle: "selected",
          selected: true,
          label: "Selected memory",
        }),
        // A node disc sitting exactly where the selected label is drawn.
        candidate({ handle: "other", x: 150, y: 100, radius: 14 }),
      ],
      { fontSize: LABEL_FONT_SIZE, width: 1000, height: 600 },
    );
    expect(visible.map((label) => label.handle)).toEqual(["selected"]);
  });

  it("always shows 1-hop focus neighbours, even when they would overlap", () => {
    const visible = selectVisibleLabels(
      [
        candidate({ handle: "focus", hovered: true, label: "Focus" }),
        candidate({ handle: "near", nearFocus: true, label: "Near" }),
        // Sits exactly on the neighbour anchor and would normally be dropped.
        candidate({ handle: "plain", label: "Plain" }),
      ],
      { fontSize: LABEL_FONT_SIZE, width: 1000, height: 600 },
    );
    const handles = visible.map((label) => label.handle);
    expect(handles).toContain("focus");
    expect(handles).toContain("near");
    expect(handles).not.toContain("plain");
  });

  it("honours the character limit when rendering label text", () => {
    const visible = selectVisibleLabels(
      [candidate({ handle: "long", label: "とても長いラベル".repeat(4) })],
      {
        fontSize: LABEL_FONT_SIZE,
        charLimit: LABEL_SMALL_MAX_CHARS,
        width: 1000,
        height: 600,
      },
    );
    expect(visible).toHaveLength(1);
    expect(Array.from(visible[0]?.text ?? "")).toHaveLength(
      LABEL_SMALL_MAX_CHARS,
    );
    expect(visible[0]?.text.endsWith("…")).toBe(true);
  });
});

describe("withTopicHubs", () => {
  const topicNodes: GraphNodeData[] = [
    {
      handle: "m1",
      label: "Alpha",
      status: "active",
      kind: "user_fact",
      topics: ["仕事", "健康"],
      episode: null,
    },
    {
      handle: "m2",
      label: "Beta",
      status: "active",
      kind: "summary",
      topics: ["仕事"],
      episode: null,
    },
    {
      handle: "m3",
      label: "Gamma",
      status: "active",
      kind: "model_inference",
      topics: ["m1"],
      episode: null,
    },
    {
      handle: "topic:仕事",
      label: "Not a hub",
      status: "active",
      kind: "user_fact",
      topics: ["健康"],
      episode: null,
    },
  ];
  const topicEdges: GraphEdgeData[] = [
    ...EDGES,
    { from: "m1", to: "m3", kind: "similar" },
  ];

  it("adds one hub per distinct topic, deduped case-insensitively", () => {
    const caseNodes: GraphNodeData[] = [
      {
        handle: "m1",
        label: "Alpha",
        status: "active",
        kind: "user_fact",
        topics: ["Work", "健康"],
        episode: null,
      },
      {
        handle: "m2",
        label: "Beta",
        status: "active",
        kind: "summary",
        topics: ["work"],
        episode: null,
      },
      {
        handle: "m3",
        label: "Gamma",
        status: "active",
        kind: "model_inference",
        topics: ["健康"],
        episode: null,
      },
    ];
    const display = withTopicHubs(caseNodes, []);
    const hubs = display.nodes.filter((node) => node.topicHub === true);
    expect(hubs.map((hub) => hub.label).sort()).toEqual(["Work", "健康"]);
    expect(display.nodes).toHaveLength(caseNodes.length + 2);
  });

  it("only mints a hub when at least TOPIC_HUB_MIN_MEMBERS share a topic", () => {
    const nodes: GraphNodeData[] = [
      {
        handle: "m1",
        label: "Alpha",
        status: "active",
        kind: "user_fact",
        topics: ["solo", "shared"],
        episode: null,
      },
      {
        handle: "m2",
        label: "Beta",
        status: "active",
        kind: "summary",
        topics: ["SHARED"],
        episode: null,
      },
    ];
    expect(TOPIC_HUB_MIN_MEMBERS).toBe(2);
    const display = withTopicHubs(nodes, []);
    const hubs = display.nodes.filter((node) => node.topicHub === true);
    expect(hubs.map((hub) => hub.label)).toEqual(["shared"]);
    expect(display.edges).toEqual([
      { from: "m1", to: topicHubHandle("shared"), kind: "related" },
      { from: "m2", to: topicHubHandle("shared"), kind: "related" },
    ]);
    // Single-member topics still live on the memory node for its tooltip.
    expect(display.nodes[0]?.topics).toEqual(["solo", "shared"]);
  });

  it("links every member to its hub and keeps the original edges", () => {
    const display = withTopicHubs(topicNodes, topicEdges);
    const hubs = display.nodes.filter((node) => node.topicHub === true);
    expect(hubs.map((hub) => hub.label).sort()).toEqual(["仕事", "健康"]);
    // All original edges survive unchanged, including similar links.
    for (const edge of topicEdges) {
      expect(display.edges).toContainEqual(edge);
    }
    const members = (topic: string): string[] =>
      display.edges
        .filter(
          (edge) =>
            edge.kind === "related" &&
            hubs.some((hub) => hub.handle === edge.to && hub.label === topic),
        )
        .map((edge) => edge.from)
        .sort();
    expect(members("仕事")).toEqual(["m1", "m2"]);
    expect(members("健康")).toEqual(["m1", "topic:仕事"]);
    // "m1" is carried by a single memory (m3), so it gets no hub/spoke.
    expect(hubs.some((hub) => hub.label === "m1")).toBe(false);
  });

  it("never mints a hub handle that collides with a memory handle", () => {
    const display = withTopicHubs(topicNodes, topicEdges);
    const memoryHandles = topicNodes.map((node) => node.handle);
    const hubs = display.nodes.filter((node) => node.topicHub === true);
    const handles = hubs.map((hub) => hub.handle);
    expect(new Set(handles).size).toBe(handles.length);
    for (const handle of handles) {
      expect(handle.startsWith(TOPIC_HUB_PREFIX)).toBe(true);
      expect(memoryHandles).not.toContain(handle);
      // Opaque mN handles can never be mistaken for a hub id.
      expect(/^m[1-9][0-9]*$/.test(handle)).toBe(false);
    }
    // A real node already owns `topic:仕事`: the hub gets a suffix instead.
    expect(handles).toContain(`${topicHubHandle("仕事")}_`);
    expect(handles).not.toContain("m1");
  });

  it("returns copies unchanged when no node has topics", () => {
    const display = withTopicHubs(NODES, EDGES);
    expect(display.nodes).toEqual(NODES);
    expect(display.edges).toEqual(EDGES);
    expect(display.nodes).not.toBe(NODES);
  });
});

describe("memory list browse actions", () => {
  it("binds browse to the active Run, else the latest rendered Run", () => {
    expect(browseRunId("run-active", "run-rendered")).toBe("run-active");
    expect(browseRunId(null, "run-rendered")).toBe("run-rendered");
    // No Run at all: browse must not emit a request without a runId.
    expect(browseRunId(null, null)).toBeNull();
  });

  it("bumps both generations when returning to browse", () => {
    // An in-flight search and an in-flight detail both see a stale sequence,
    // so neither late response can repaint the fresh browse state.
    expect(returnToBrowseGenerations(4, 9)).toEqual({
      searchSeq: 5,
      detailSeq: 10,
    });
    expect(returnToBrowseGenerations(0, 0)).toEqual({
      searchSeq: 1,
      detailSeq: 1,
    });
  });

  it("re-enables search after an abandoned search unless mutating", () => {
    // The abandoned search's finally is stale, so showAll must own the reset.
    expect(searchButtonDisabledAfterAbandon(false)).toBe(false);
    expect(searchButtonDisabledAfterAbandon(true)).toBe(true);
  });
});

describe("memory graph shell", () => {
  it("renders the new controls without inline script", () => {
    const html = renderConversationShell().toString();
    for (const id of [
      "memory-view-list",
      "memory-view-graph",
      "memory-graph",
      "memory-graph-global",
      "memory-graph-local",
      "memory-graph-depth",
      "memory-graph-retired",
      "memory-graph-topics",
      "memory-graph-similar",
      "memory-graph-status",
      "memory-graph-canvas",
      "memory-graph-canvas-wrap",
      "memory-graph-zoom-controls",
      "memory-graph-zoom-in",
      "memory-graph-zoom-out",
      "memory-graph-zoom-fit",
      "memory-graph-legend",
      "memory-list-status",
      "memory-list-all",
      "memory-list-scroll",
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
    for (const label of [
      "事実",
      "推論",
      "要約",
      "訂正",
      "統合",
      "引退",
      "話題",
      "関連（自動）",
      "話題を表示",
      "自動関連を表示",
      "全体表示",
      "すべて表示",
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('aria-label="記憶グラフ"');
    expect(shellHasNoInlineScript(html)).toBe(true);
  });

  it("accepts a graph payload structurally (contract-shaped data)", () => {
    const data: GraphData = {
      searchId: "graph-search-1",
      version: "o12:r3.2:a40:e0.0.",
      scope: "global",
      center: null,
      nodes: NODES,
      edges: EDGES,
      truncated: true,
    };
    expect(data.nodes).toHaveLength(3);
    expect(data.truncated).toBe(true);
  });
});

describe("graph record dates", () => {
  it("keeps createdAt through parse and list rows", () => {
    const parsed = parseGraphData({
      searchId: "s",
      version: "v",
      scope: "global",
      center: null,
      truncated: false,
      edges: [],
      nodes: [
        {
          handle: "m1",
          label: "Alpha",
          status: "active",
          kind: "user_fact",
          createdAt: "2026-10-22T18:30:00.000Z",
          episode: null,
        },
      ],
    });
    expect(parsed?.nodes[0]?.createdAt).toBe("2026-10-22T18:30:00.000Z");
    const rows = memoryListRows(parsed?.nodes ?? []);
    expect(rows[0]?.createdAt).toBe("2026-10-22T18:30:00.000Z");
    expect(rows[0]?.label).toBe("Alpha");
  });

  it("formats a record instant as YYYY-MM-DD HH:MM (browser zone)", () => {
    expect(formatRecordedAt("2026-10-22T18:30:00.000Z")).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/,
    );
    expect(formatRecordedAt("nope")).toBe(null);
  });
});
