// Conversation-memory graph view: a small deterministic force-directed
// layout plus an SVG canvas (no framework, no inline styles, no innerHTML).
//
// Pure layout/math helpers are exported separately from `GraphCanvas` so the
// simulation can be unit-tested in Node without a DOM. Node/browser code is
// only reached when the class is constructed.

/// <reference lib="dom" />

/**
 * `YYYY-MM-DD HH:MM` for a record instant in the browser's time zone.
 * Falls back to UTC when the environment cannot resolve a zone; an invalid
 * instant renders as null (callers omit the date rather than guess).
 */
export function formatRecordedAt(value: string): string | null {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return null;
  }
  try {
    const timeZone =
      Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const get = (type: Intl.DateTimeFormatPartTypes): string =>
      parts.find((part) => part.type === type)?.value ?? "";
    const year = get("year");
    const month = get("month");
    const day = get("day");
    const hour = get("hour");
    const minute = get("minute");
    if (year === "" || month === "" || day === "" || hour === "" || minute === "") {
      return null;
    }
    return `${year}-${month}-${day} ${hour}:${minute}`;
  } catch {
    return null;
  }
}

export interface GraphNodeData {
  readonly handle: string;
  readonly label: string;
  readonly status: "active" | "retired";
  readonly kind: string;
  /** Derived general-category topics (remind PR #29); empty when absent. */
  readonly topics?: readonly string[];
  /** Client-side tag hub (`withTopicHubs`); never a real memory handle. */
  readonly topicHub?: boolean;
  /** Remind record creation instant (canonical ISO), when provided. */
  readonly createdAt?: string;
  readonly episode: unknown;
}

export interface GraphEdgeData {
  readonly from: string;
  readonly to: string;
  readonly kind: "related" | "consolidation" | "similar";
}

export interface GraphData {
  readonly searchId: string;
  readonly version: string;
  readonly scope: "global" | "local";
  readonly center: string | null;
  readonly nodes: readonly GraphNodeData[];
  readonly edges: readonly GraphEdgeData[];
  readonly truncated: boolean;
}

/**
 * Structural guard for a graph response. Shared by the Svelte feature page
 * (the production `/memory` route) so malformed rows are dropped rather than
 * rendered as partial nodes/edges. Legacy client has its own copy.
 */
function parseGraphTopics(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const topics: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") {
      continue;
    }
    const topic = raw.trim();
    if (
      topic.length === 0 ||
      Array.from(topic).length > 12 ||
      topics.includes(topic)
    ) {
      continue;
    }
    topics.push(topic);
  }
  return topics.slice(0, 3);
}

export function parseGraphData(value: unknown): GraphData | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const body = value as {
    searchId?: unknown;
    version?: unknown;
    scope?: unknown;
    center?: unknown;
    nodes?: unknown;
    edges?: unknown;
    truncated?: unknown;
  };
  if (
    typeof body.searchId !== "string" ||
    typeof body.version !== "string" ||
    (body.scope !== "global" && body.scope !== "local") ||
    !Array.isArray(body.nodes) ||
    !Array.isArray(body.edges)
  ) {
    return null;
  }
  const nodes = body.nodes.flatMap<GraphNodeData>((item) => {
    if (typeof item !== "object" || item === null) {
      return [];
    }
    const node = item as {
      handle?: unknown;
      label?: unknown;
      status?: unknown;
      kind?: unknown;
      topics?: unknown;
      createdAt?: unknown;
      episode?: unknown;
    };
    if (
      typeof node.handle !== "string" ||
      typeof node.label !== "string" ||
      (node.status !== "active" && node.status !== "retired") ||
      typeof node.kind !== "string"
    ) {
      return [];
    }
    const topics = parseGraphTopics(node.topics);
    return [
      {
        handle: node.handle,
        label: node.label,
        status: node.status,
        kind: node.kind,
        ...(topics.length > 0 ? { topics } : {}),
        ...(typeof node.createdAt === "string" &&
        node.createdAt.length >= 20 &&
        node.createdAt.length <= 30
          ? { createdAt: node.createdAt }
          : {}),
        episode: node.episode ?? null,
      },
    ];
  });
  const edges = body.edges.flatMap<GraphEdgeData>((item) => {
    if (typeof item !== "object" || item === null) {
      return [];
    }
    const edge = item as { from?: unknown; to?: unknown; kind?: unknown };
    if (
      typeof edge.from !== "string" ||
      typeof edge.to !== "string" ||
      (edge.kind !== "related" &&
        edge.kind !== "consolidation" &&
        edge.kind !== "similar")
    ) {
      return [];
    }
    return [{ from: edge.from, to: edge.to, kind: edge.kind }];
  });
  return {
    searchId: body.searchId,
    version: body.version,
    scope: body.scope,
    center: typeof body.center === "string" ? body.center : null,
    nodes,
    edges,
    truncated: body.truncated === true,
  };
}

export const TOPIC_HUB_PREFIX = "topic:";

/**
 * Minimum number of visible memory nodes that must share a topic before a
 * client-side topic hub is drawn. Single-member hubs only add a spoke to the
 * perimeter (the layout has nothing to cluster around it), so they are
 * omitted; the topic still appears in the member node's tooltip/detail.
 */
export const TOPIC_HUB_MIN_MEMBERS = 2;

/** Stable synthetic handle for one client-side topic hub. */
export function topicHubHandle(topic: string): string {
  return `${TOPIC_HUB_PREFIX}${topic}`;
}

export interface TopicHubGraph {
  readonly nodes: readonly GraphNodeData[];
  readonly edges: readonly GraphEdgeData[];
}

/**
 * Obsidian-style tags-as-nodes: append one hub node per distinct topic shared
 * by at least `TOPIC_HUB_MIN_MEMBERS` visible nodes plus a `related` edge from
 * every member to its hub. Pure (never mutates the input); topics are deduped
 * case-insensitively while the first spelling is kept. Single-member topics
 * do not get a hub (the node keeps `topics` for its tooltip/detail). Nodes
 * without topics are returned unchanged.
 */
export function withTopicHubs(
  nodes: readonly GraphNodeData[],
  edges: readonly GraphEdgeData[],
): TopicHubGraph {
  if (!nodes.some((node) => (node.topics?.length ?? 0) > 0)) {
    return { nodes: [...nodes], edges: [...edges] };
  }
  // First pass: count distinct nodes per topic so single-member topics never
  // mint a hub. Keeping the first spelling mirrors the previous behaviour.
  const topicByKey = new Map<
    string,
    { readonly label: string; count: number }
  >();
  for (const node of nodes) {
    const seenInNode = new Set<string>();
    for (const rawTopic of node.topics ?? []) {
      const topic = rawTopic.trim();
      const key = topic.toLowerCase();
      if (topic.length === 0 || seenInNode.has(key)) {
        continue;
      }
      seenInNode.add(key);
      const entry = topicByKey.get(key);
      if (entry === undefined) {
        topicByKey.set(key, { label: topic, count: 1 });
      } else {
        entry.count += 1;
      }
    }
  }
  const usedHandles = new Set(nodes.map((node) => node.handle));
  const hubByKey = new Map<string, GraphNodeData>();
  for (const [key, entry] of topicByKey) {
    if (entry.count < TOPIC_HUB_MIN_MEMBERS) {
      continue;
    }
    let handle = topicHubHandle(entry.label);
    while (usedHandles.has(handle)) {
      handle = `${handle}_`;
    }
    usedHandles.add(handle);
    hubByKey.set(key, {
      handle,
      label: entry.label,
      status: "active",
      kind: "topic",
      topicHub: true,
      episode: null,
    });
  }
  // Second pass: link every member of an existing hub. Topics that did not
  // reach the threshold have no hub and therefore no spoke.
  const hubEdges: GraphEdgeData[] = [];
  for (const node of nodes) {
    const seenInNode = new Set<string>();
    for (const rawTopic of node.topics ?? []) {
      const topic = rawTopic.trim();
      const key = topic.toLowerCase();
      if (topic.length === 0 || seenInNode.has(key)) {
        continue;
      }
      seenInNode.add(key);
      const hub = hubByKey.get(key);
      if (hub === undefined) {
        continue;
      }
      hubEdges.push({ from: node.handle, to: hub.handle, kind: "related" });
    }
  }
  return {
    nodes: [...nodes, ...hubByKey.values()],
    edges: [...edges, ...hubEdges],
  };
}

/** One browse row per projection node, preserving the server's order. */
export interface MemoryListRow {
  readonly handle: string;
  readonly status: "active" | "retired";
  readonly label: string;
  readonly topics: readonly string[];
  /** Record creation instant, when the projection carried one. */
  readonly createdAt?: string;
}

export function memoryListRows(
  nodes: readonly GraphNodeData[],
): MemoryListRow[] {
  const rows: MemoryListRow[] = [];
  for (const node of nodes) {
    if (node.topicHub === true) {
      continue;
    }
    rows.push({
      handle: node.handle,
      status: node.status,
      label: node.label,
      topics: [...(node.topics ?? [])],
      ...(node.createdAt !== undefined ? { createdAt: node.createdAt } : {}),
    });
  }
  return rows;
}

export interface LayoutNode extends GraphNodeData {
  x: number;
  y: number;
  vx: number;
  vy: number;
  degree: number;
  radius: number;
  fixed: boolean;
}

export interface GraphLayout {
  readonly nodes: LayoutNode[];
  readonly edges: readonly GraphEdgeData[];
  readonly width: number;
  readonly height: number;
  alpha: number;
  steps: number;
}

export const GRAPH_WIDTH = 800;
export const GRAPH_HEIGHT = 480;
export const GRAPH_ALPHA_MIN = 0.02;
export const GRAPH_ALPHA_DECAY = 0.97;
/**
 * Per-node x/y gravity toward the layout origin (d3 `forceX`/`forceY`
 * strength). Kept just strong enough to keep disconnected components on
 * screen: a much stronger pull clumped every graph into the middle of the
 * canvas, so clusters could not separate.
 */
export const GRAPH_CENTER_STRENGTH = 0.03;
export const LABEL_ZOOM_THRESHOLD = 1.2;
/** Displayed labels are truncated to this many characters (plus ellipsis). */
export const LABEL_MAX_CHARS = 24;
/** Tighter budget when zoomed out, where labels otherwise overlap. */
export const LABEL_SMALL_MAX_CHARS = 14;
/** Rendered label font size in CSS pixels at scale 1. */
export const LABEL_FONT_SIZE = 12;
/** Fraction of the canvas the fitted graph bounding box should occupy. */
export const FIT_VIEW_RATIO = 0.85;
export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 3;

/** Deterministic 32-bit FNV-1a hash of an opaque handle. */
export function hashHandle(handle: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < handle.length; index += 1) {
    hash ^= handle.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Deterministic starting point from the handle alone (no Math.random): the
 * same graph always produces the same layout, which keeps tests stable and
 * avoids visual reshuffles when a cached graph is re-rendered.
 */
export function seedPosition(handle: string): { x: number; y: number } {
  const hash = hashHandle(handle);
  const angle = ((hash % 100_000) / 100_000) * Math.PI * 2;
  const radius = 48 + ((hash >>> 16) % 172);
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

/** Node radius grows with degree, bounded so labels stay readable. */
export function nodeRadius(degree: number): number {
  return 6 + Math.min(Math.max(degree, 0), 12) * 1.35;
}

/** Undirected adjacency for nodes and edges that both exist. */
export function buildNeighborMap(
  nodes: readonly { readonly handle: string }[],
  edges: readonly GraphEdgeData[],
): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const node of nodes) {
    map.set(node.handle, new Set());
  }
  for (const edge of edges) {
    if (edge.from === edge.to) {
      continue;
    }
    const from = map.get(edge.from);
    const to = map.get(edge.to);
    if (from === undefined || to === undefined) {
      continue;
    }
    from.add(edge.to);
    to.add(edge.from);
  }
  return map;
}

/** Handle plus its immediate neighbours (the hover highlight set). */
export function highlightHandles(
  handle: string,
  neighbors: ReadonlyMap<string, ReadonlySet<string>>,
): Set<string> {
  const result = new Set<string>([handle]);
  for (const neighbor of neighbors.get(handle) ?? []) {
    result.add(neighbor);
  }
  return result;
}

/** CSS class for one edge kind (similar edges are dotted/dimmed in CSS). */
export function graphEdgeClass(kind: GraphEdgeData["kind"]): string {
  return `memory-graph-edge memory-graph-edge--${kind}`;
}

/** Case-insensitive substring match used by the graph-view search box. */
export function labelMatches(label: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return false;
  }
  return label.toLowerCase().includes(needle);
}

/** Camera maps world coordinates into SVG CSS pixels: p * scale + t. */
export interface GraphCamera {
  readonly scale: number;
  readonly tx: number;
  readonly ty: number;
}

export function worldToScreen(
  camera: GraphCamera,
  x: number,
  y: number,
): { x: number; y: number } {
  return { x: x * camera.scale + camera.tx, y: y * camera.scale + camera.ty };
}

export function screenToWorld(
  camera: GraphCamera,
  x: number,
  y: number,
): { x: number; y: number } {
  return {
    x: (x - camera.tx) / camera.scale,
    y: (y - camera.ty) / camera.scale,
  };
}

/** Zoom around a fixed cursor point (wheel zoom never shifts the point). */
export function zoomAt(
  camera: GraphCamera,
  cursorX: number,
  cursorY: number,
  factor: number,
  minScale = MIN_ZOOM,
  maxScale = MAX_ZOOM,
): GraphCamera {
  const scale = Math.min(maxScale, Math.max(minScale, camera.scale * factor));
  if (scale === camera.scale) {
    return camera;
  }
  const world = screenToWorld(camera, cursorX, cursorY);
  return {
    scale,
    tx: cursorX - world.x * scale,
    ty: cursorY - world.y * scale,
  };
}

export interface PositionedNode {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
}

export interface GraphBounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly width: number;
  readonly height: number;
}

/** Axis-aligned world-space bounds of the node discs (radius included). */
export function graphBounds(
  nodes: readonly PositionedNode[],
): GraphBounds | null {
  if (nodes.length === 0) {
    return null;
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const node of nodes) {
    minX = Math.min(minX, node.x - node.radius);
    minY = Math.min(minY, node.y - node.radius);
    maxX = Math.max(maxX, node.x + node.radius);
    maxY = Math.max(maxY, node.y + node.radius);
  }
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

export interface FitCameraOptions {
  /** Fraction of the limiting canvas dimension the graph should fill. */
  readonly ratio?: number;
  readonly minScale?: number;
  readonly maxScale?: number;
}

/**
 * Obsidian-style fit-to-view camera: centre the node bounding box and scale it
 * so the limiting dimension fills `ratio` of the canvas, clamped to the same
 * zoom range as wheel zoom. An empty graph falls back to the identity camera.
 */
export function fitCamera(
  nodes: readonly PositionedNode[],
  width = GRAPH_WIDTH,
  height = GRAPH_HEIGHT,
  options: FitCameraOptions = {},
): GraphCamera {
  const ratio = options.ratio ?? FIT_VIEW_RATIO;
  const minScale = options.minScale ?? MIN_ZOOM;
  const maxScale = options.maxScale ?? MAX_ZOOM;
  const bounds = graphBounds(nodes);
  if (bounds === null || width <= 0 || height <= 0) {
    return { scale: 1, tx: width / 2, ty: height / 2 };
  }
  const spanX = Math.max(bounds.width, 1);
  const spanY = Math.max(bounds.height, 1);
  const raw = ratio * Math.min(width / spanX, height / spanY);
  const scale = Math.min(maxScale, Math.max(minScale, raw));
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  return {
    scale,
    tx: width / 2 - centerX * scale,
    ty: height / 2 - centerY * scale,
  };
}

/**
 * Label character budget for the current zoom. Zoomed-in views have room for
 * the long form; zoomed-out views keep a short prefix so decluttering has a
 * chance to place more than a handful of labels. Full text lives in <title>.
 */
export function labelCharLimit(scale: number): number {
  return scale < LABEL_ZOOM_THRESHOLD
    ? Math.min(LABEL_SMALL_MAX_CHARS, LABEL_MAX_CHARS)
    : LABEL_MAX_CHARS;
}

/**
 * Truncate a label to `max` code points. The ellipsis counts toward the
 * limit, so the visible string never exceeds it. Full text goes to <title>.
 */
export function truncateLabel(label: string, max = LABEL_MAX_CHARS): string {
  if (max <= 0) {
    return "";
  }
  const characters = Array.from(label);
  if (characters.length <= max) {
    return label;
  }
  return `${characters.slice(0, max - 1).join("")}…`;
}

/**
 * Approximate rendered width of a label in CSS pixels. CJK/full-width code
 * points occupy roughly one em, ASCII roughly 0.6em. Deliberately a little
 * generous: over-estimating only drops a label, under-estimating overlaps.
 */
export function estimateLabelWidth(
  text: string,
  fontSize = LABEL_FONT_SIZE,
): number {
  let width = 0;
  for (const character of Array.from(text)) {
    const codePoint = character.codePointAt(0) ?? 0;
    const wide =
      (codePoint >= 0x1100 && codePoint <= 0x115f) ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe4f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6);
    width += wide ? fontSize : fontSize * 0.6;
  }
  return width;
}

/** Screen-space input for greedy label placement. */
export interface LabelCandidate {
  readonly handle: string;
  readonly label: string;
  /** Node centre in screen (CSS) pixels. */
  readonly x: number;
  readonly y: number;
  /** Node disc radius in screen pixels. */
  readonly radius: number;
  readonly degree: number;
  readonly topicHub?: boolean;
  readonly selected?: boolean;
  readonly hovered?: boolean;
  /** Direct neighbour of the selected/hovered node (focus priority). */
  readonly nearFocus?: boolean;
}

export interface VisibleLabel {
  readonly handle: string;
  readonly text: string;
  /** Label box in screen (CSS) pixels. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface LabelDeclutterOptions {
  readonly fontSize?: number;
  readonly charLimit?: number;
  readonly width?: number;
  readonly height?: number;
  /** Horizontal gap between the node disc and the label, in screen pixels. */
  readonly gap?: number;
}

function labelRect(
  candidate: LabelCandidate,
  text: string,
  fontSize: number,
  gap: number,
): VisibleLabel {
  return {
    handle: candidate.handle,
    text,
    x: candidate.x + candidate.radius + gap,
    y: candidate.y + gap - fontSize * 0.8,
    width: estimateLabelWidth(text, fontSize),
    height: fontSize,
  };
}

function rectsOverlap(a: VisibleLabel, b: VisibleLabel): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

function rectOverlapsDisc(
  label: VisibleLabel,
  disc: { x: number; y: number; radius: number },
): boolean {
  const nearestX = Math.max(label.x, Math.min(disc.x, label.x + label.width));
  const nearestY = Math.max(label.y, Math.min(disc.y, label.y + label.height));
  return Math.hypot(disc.x - nearestX, disc.y - nearestY) < disc.radius + 1;
}

/**
 * Greedy, deterministic label decluttering in screen space. Priority:
 * selected/hovered and their 1-hop neighbours (always placed, even if they
 * overlap), then topic hubs, then higher degree, then the rest. A label is
 * skipped when it would overlap an already-placed label or any node disc, or
 * when it falls outside the canvas.
 */
export function selectVisibleLabels(
  candidates: readonly LabelCandidate[],
  options: LabelDeclutterOptions = {},
): VisibleLabel[] {
  const fontSize = options.fontSize ?? LABEL_FONT_SIZE;
  const charLimit = options.charLimit ?? LABEL_MAX_CHARS;
  const width = options.width ?? Number.POSITIVE_INFINITY;
  const height = options.height ?? Number.POSITIVE_INFINITY;
  const gap = options.gap ?? 4;
  const rank = (candidate: LabelCandidate): number => {
    if (candidate.selected || candidate.hovered) {
      return 0;
    }
    if (candidate.nearFocus) {
      return 1;
    }
    return candidate.topicHub ? 2 : 3;
  };
  const ordered = [...candidates].sort((a, b) => {
    const rankDelta = rank(a) - rank(b);
    if (rankDelta !== 0) {
      return rankDelta;
    }
    if (a.degree !== b.degree) {
      return b.degree - a.degree;
    }
    const handleDelta = a.handle.localeCompare(b.handle);
    return handleDelta !== 0 ? handleDelta : a.label.localeCompare(b.label);
  });
  const placed: VisibleLabel[] = [];
  for (const candidate of ordered) {
    const forced =
      candidate.selected === true ||
      candidate.hovered === true ||
      candidate.nearFocus === true;
    const text = truncateLabel(candidate.label, charLimit);
    if (text.length === 0) {
      continue;
    }
    const box = labelRect(candidate, text, fontSize, gap);
    if (!forced) {
      if (
        box.x < 0 ||
        box.y < 0 ||
        box.x + box.width > width ||
        box.y + box.height > height
      ) {
        continue;
      }
      if (placed.some((other) => rectsOverlap(box, other))) {
        continue;
      }
      if (
        candidates.some((node) =>
          rectOverlapsDisc(box, {
            x: node.x,
            y: node.y,
            radius: node.radius,
          }),
        )
      ) {
        continue;
      }
    }
    placed.push(box);
  }
  return placed;
}

export function createLayout(
  nodes: readonly GraphNodeData[],
  edges: readonly GraphEdgeData[],
  width = GRAPH_WIDTH,
  height = GRAPH_HEIGHT,
): GraphLayout {
  const neighbors = buildNeighborMap(nodes, edges);
  return {
    nodes: nodes.map((node) => {
      const seed = seedPosition(node.handle);
      const degree = neighbors.get(node.handle)?.size ?? 0;
      return {
        ...node,
        x: seed.x,
        y: seed.y,
        vx: 0,
        vy: 0,
        degree,
        radius: nodeRadius(degree),
        fixed: false,
      };
    }),
    edges: [...edges],
    width,
    height,
    alpha: 1,
    steps: 0,
  };
}

/**
 * One deterministic simulation tick: O(n²) repulsion (n ≤ 500), spring
 * links, per-node x/y gravity toward the origin, velocity damping and alpha
 * decay. A collision pass keeps resting nodes from overlapping even in dense
 * local graphs.
 */
export function layoutStep(layout: GraphLayout): GraphLayout {
  if (layout.alpha <= 0) {
    return layout;
  }
  const nodes = layout.nodes;
  const count = nodes.length;
  if (count === 0) {
    layout.alpha = 0;
    return layout;
  }
  const area = layout.width * layout.height;
  // Scale the force model with the *real* canvas: a wide desktop canvas has
  // room for clusters to separate, while the old 800x480 constants clumped
  // every node into roughly a quarter of the available area.
  const spread = Math.sqrt(area / count) * 0.5;
  const desired = Math.max(72, Math.min(190, spread * 1.15));
  const repulsion = spread * spread * 0.045;
  const spring = 0.018;
  const damping = 0.84;
  const alpha = layout.alpha;

  const forceX = new Float64Array(count);
  const forceY = new Float64Array(count);

  // Pairwise repulsion + direct separation for already-overlapping nodes.
  for (let i = 0; i < count; i += 1) {
    const a = nodes[i];
    if (a === undefined) {
      continue;
    }
    for (let j = i + 1; j < count; j += 1) {
      const b = nodes[j];
      if (b === undefined) {
        continue;
      }
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      let distance = Math.sqrt(dx * dx + dy * dy);
      if (distance < 0.01) {
        // Deterministic tie-break from the handles (never Math.random).
        dx = ((hashHandle(a.handle) % 7) - 3) * 0.1 || 0.1;
        dy = ((hashHandle(b.handle) % 7) - 3) * 0.1 || -0.1;
        distance = Math.sqrt(dx * dx + dy * dy);
      }
      const ux = dx / distance;
      const uy = dy / distance;
      const force = repulsion / Math.max(distance, 8);
      forceX[i] = (forceX[i] ?? 0) + ux * force;
      forceY[i] = (forceY[i] ?? 0) + uy * force;
      forceX[j] = (forceX[j] ?? 0) - ux * force;
      forceY[j] = (forceY[j] ?? 0) - uy * force;

      const minimum = a.radius + b.radius + 8;
      if (distance < minimum) {
        const overlap = minimum - distance;
        if (a.fixed && b.fixed) {
          continue;
        }
        if (a.fixed) {
          b.x -= ux * overlap;
          b.y -= uy * overlap;
        } else if (b.fixed) {
          a.x += ux * overlap;
          a.y += uy * overlap;
        } else {
          const push = overlap / 2;
          a.x += ux * push;
          a.y += uy * push;
          b.x -= ux * push;
          b.y -= uy * push;
        }
      }
    }
  }

  const indexByHandle = new Map<string, number>();
  for (let index = 0; index < count; index += 1) {
    const node = nodes[index];
    if (node !== undefined) {
      indexByHandle.set(node.handle, index);
    }
  }

  for (const edge of layout.edges) {
    const fromIndex = indexByHandle.get(edge.from);
    const toIndex = indexByHandle.get(edge.to);
    if (
      fromIndex === undefined ||
      toIndex === undefined ||
      fromIndex === toIndex
    ) {
      continue;
    }
    const a = nodes[fromIndex];
    const b = nodes[toIndex];
    if (a === undefined || b === undefined) {
      continue;
    }
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const distance = Math.max(0.01, Math.sqrt(dx * dx + dy * dy));
    const pull = (distance - desired) * spring;
    const ux = dx / distance;
    const uy = dy / distance;
    forceX[fromIndex] = (forceX[fromIndex] ?? 0) + ux * pull;
    forceY[fromIndex] = (forceY[fromIndex] ?? 0) + uy * pull;
    forceX[toIndex] = (forceX[toIndex] ?? 0) - ux * pull;
    forceY[toIndex] = (forceY[toIndex] ?? 0) - uy * pull;
  }

  // Aspect-aware gravity: a wide canvas should settle into a wide bounding
  // box instead of a square clump, so pull harder vertically and softer
  // horizontally by the square root of the canvas aspect. fitCamera at settle
  // then frames the naturally-sized graph; there is deliberately no hard
  // clamp to the canvas box (that pinned nodes into rows on the top/bottom
  // edges while the sides stayed empty).
  const aspect = Math.max(0.1, layout.width / layout.height);
  const aspectScale = Math.sqrt(aspect);
  const gravityX = GRAPH_CENTER_STRENGTH / aspectScale;
  const gravityY = GRAPH_CENTER_STRENGTH * aspectScale;
  for (let index = 0; index < count; index += 1) {
    const node = nodes[index];
    if (node === undefined) {
      continue;
    }
    if (!node.fixed) {
      // d3-style forceX/forceY: every node, including each node of a
      // disconnected component, is pulled toward the canvas origin. Scaling
      // by alpha keeps the pull strong while the simulation is hot and lets
      // it relax as the layout settles.
      const pullX = -node.x * gravityX;
      const pullY = -node.y * gravityY;
      node.vx =
        (node.vx + (forceX[index] ?? 0) * alpha + pullX * alpha) * damping;
      node.vy =
        (node.vy + (forceY[index] ?? 0) * alpha + pullY * alpha) * damping;
      node.x += node.vx;
      node.y += node.vy;
    } else {
      node.vx = 0;
      node.vy = 0;
    }
  }

  layout.steps += 1;
  layout.alpha = layout.alpha * GRAPH_ALPHA_DECAY;
  if (layout.alpha < GRAPH_ALPHA_MIN) {
    layout.alpha = 0;
    for (const node of layout.nodes) {
      node.vx = 0;
      node.vy = 0;
    }
  }
  return layout;
}

/** Synchronous convergence, used for prefers-reduced-motion and tests. */
export function runLayout(layout: GraphLayout, maxSteps = 600): GraphLayout {
  let steps = 0;
  while (layout.alpha > 0 && steps < maxSteps) {
    layoutStep(layout);
    steps += 1;
  }
  return layout;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const KIND_CLASSES: Readonly<Record<string, string>> = {
  summary: "memory-graph-node--kind-summary",
  correction: "memory-graph-node--kind-correction",
  user_fact: "memory-graph-node--kind-user-fact",
  model_inference: "memory-graph-node--kind-model-inference",
  topic: "memory-graph-node--kind-topic",
};

export interface GraphCanvasCallbacks {
  readonly onNodeActivate: (handle: string) => void;
  readonly onSelectionChange?: (handle: string | null) => void;
}

interface PointerGesture {
  mode: "pan" | "node";
  handle: string | null;
  lastX: number;
  lastY: number;
  offsetX: number;
  offsetY: number;
  moved: boolean;
}

interface RenderedNode {
  readonly layout: LayoutNode;
  readonly group: SVGGElement;
  readonly dot: SVGElement;
  readonly label: SVGTextElement;
}

/**
 * SVG renderer + interactions. The client owns fetching/toolbar state; this
 * class only draws one graph and reports node activation.
 */
export class GraphCanvas {
  private readonly svg: SVGSVGElement;
  private readonly callbacks: GraphCanvasCallbacks;
  private readonly doc: Document;
  private readonly edgeLayer: SVGGElement;
  private readonly nodeLayer: SVGGElement;
  private readonly rendered = new Map<string, RenderedNode>();
  private readonly edgeElements: Array<{
    readonly element: SVGLineElement;
    readonly edge: GraphEdgeData;
  }> = [];
  private readonly neighbors = new Map<string, Set<string>>();
  private layout: GraphLayout | null = null;
  /** Rendered viewBox size (CSS pixels); kept in sync with the container so
   * fit-to-view can use the real aspect ratio instead of the default one. */
  private viewportWidth = GRAPH_WIDTH;
  private viewportHeight = GRAPH_HEIGHT;
  private camera: GraphCamera = {
    scale: 1,
    tx: GRAPH_WIDTH / 2,
    ty: GRAPH_HEIGHT / 2,
  };
  private selected: string | null = null;
  private hovered: string | null = null;
  private query = "";
  private frame: number | null = null;
  private destroyed = false;
  private gesture: PointerGesture | null = null;
  /** Refit once when the current simulation comes to rest. */
  private fitPending = true;
  /** The user panned/zoomed: never steal their camera on settle. */
  private userAdjusted = false;
  private readonly resizeObserver: ResizeObserver | null;

  constructor(svg: SVGSVGElement, callbacks: GraphCanvasCallbacks) {
    this.svg = svg;
    this.callbacks = callbacks;
    this.doc = svg.ownerDocument;
    svg.setAttribute("viewBox", `0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`);
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    const viewport = this.doc.createElementNS(SVG_NS, "g");
    viewport.setAttribute("class", "memory-graph-viewport");
    this.edgeLayer = this.doc.createElementNS(SVG_NS, "g");
    this.edgeLayer.setAttribute("class", "memory-graph-edges");
    this.nodeLayer = this.doc.createElementNS(SVG_NS, "g");
    this.nodeLayer.setAttribute("class", "memory-graph-nodes");
    viewport.append(this.edgeLayer, this.nodeLayer);
    while (svg.firstChild !== null) {
      svg.removeChild(svg.firstChild);
    }
    svg.append(viewport);
    this.syncViewportSize();
    this.camera = {
      scale: 1,
      tx: this.viewportWidth / 2,
      ty: this.viewportHeight / 2,
    };

    svg.addEventListener("pointerdown", this.handlePointerDown);
    svg.addEventListener("pointermove", this.handlePointerMove);
    svg.addEventListener("pointerup", this.handlePointerUp);
    svg.addEventListener("pointercancel", this.handlePointerUp);
    svg.addEventListener("wheel", this.handleWheel, { passive: false });
    this.resizeObserver =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(() => {
            if (!this.destroyed) {
              this.fitToView();
            }
          })
        : null;
    this.resizeObserver?.observe(svg);
  }

  /**
   * Match the viewBox to the rendered CSS box so "fit" fills the real canvas
   * rather than the default 800x480 aspect (which letterboxes on wide
   * containers). Hidden canvases report 0x0 and keep the previous size.
   */
  private syncViewportSize(): void {
    const rect = this.svg.getBoundingClientRect();
    const width = rect.width > 1 ? rect.width : this.viewportWidth;
    const height = rect.height > 1 ? rect.height : this.viewportHeight;
    if (width === this.viewportWidth && height === this.viewportHeight) {
      return;
    }
    this.viewportWidth = width;
    this.viewportHeight = height;
    this.svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  }

  setGraph(
    data: GraphData,
    options?: { readonly selected?: string | null; readonly query?: string },
  ): void {
    this.stopFrame();
    this.rendered.clear();
    this.edgeElements.length = 0;
    this.edgeLayer.replaceChildren();
    this.nodeLayer.replaceChildren();
    this.neighbors.clear();
    this.hovered = null;
    this.gesture = null;
    this.fitPending = true;
    this.userAdjusted = false;
    this.syncViewportSize();
    // Use the measured SVG box, not the fixed default: a 1534x480 canvas
    // otherwise lays out its nodes inside an 800x480 world and fit-to-view
    // only magnifies the clump.
    const layout = createLayout(
      data.nodes,
      data.edges,
      this.viewportWidth,
      this.viewportHeight,
    );
    this.layout = layout;
    this.camera = fitCamera(
      layout.nodes,
      this.viewportWidth,
      this.viewportHeight,
    );
    for (const [handle, set] of buildNeighborMap(layout.nodes, layout.edges)) {
      this.neighbors.set(handle, set);
    }
    this.query = options?.query ?? this.query;
    this.selected =
      options?.selected !== undefined && options.selected !== null
        ? (layout.nodes.find((node) => node.handle === options.selected)
            ?.handle ?? null)
        : null;

    for (const edge of layout.edges) {
      const element = this.doc.createElementNS(SVG_NS, "line");
      element.setAttribute("class", graphEdgeClass(edge.kind));
      this.edgeLayer.append(element);
      this.edgeElements.push({ element, edge });
    }
    for (const node of layout.nodes) {
      const isHub = node.topicHub === true;
      const group = this.doc.createElementNS(SVG_NS, "g");
      group.setAttribute("class", this.nodeClass(node));
      group.setAttribute("tabindex", "0");
      group.setAttribute("role", "button");
      group.setAttribute(
        "aria-label",
        isHub ? `${node.label}（話題）` : `${node.label} (${node.handle})`,
      );
      group.dataset.handle = node.handle;
      // Topic hubs are smaller diamonds; memory nodes keep their degree-sized
      // disc. Both use the same collision radius from the layout.
      const dotRadius = isHub ? Math.max(5, node.radius * 0.6) : node.radius;
      const dot = this.doc.createElementNS(SVG_NS, isHub ? "rect" : "circle");
      dot.setAttribute(
        "class",
        `memory-graph-node__dot ${this.nodeModifierClass(node)}`,
      );
      if (isHub) {
        dot.setAttribute("x", String(-dotRadius));
        dot.setAttribute("y", String(-dotRadius));
        dot.setAttribute("width", String(dotRadius * 2));
        dot.setAttribute("height", String(dotRadius * 2));
        dot.setAttribute("rx", "1");
        dot.setAttribute("transform", "rotate(45)");
      } else {
        dot.setAttribute("r", String(dotRadius));
        dot.setAttribute("cx", "0");
        dot.setAttribute("cy", "0");
      }
      // Full label for the native tooltip; the visible text is truncated so a
      // long memory never paints a wall of text over its neighbours. Topics
      // are metadata, so they live in the tooltip rather than the label.
      const title = this.doc.createElementNS(SVG_NS, "title");
      const topics = node.topics ?? [];
      const recorded =
        node.createdAt === undefined
          ? null
          : formatRecordedAt(node.createdAt);
      title.textContent = [
        node.label,
        ...(topics.length > 0 ? [`話題: ${topics.join("、")}`] : []),
        ...(recorded === null ? [] : [`記録: ${recorded}`]),
      ].join("\n");
      const label = this.doc.createElementNS(SVG_NS, "text");
      label.setAttribute("class", "memory-graph-node__label");
      label.setAttribute("x", String(dotRadius + 4));
      label.setAttribute("y", "4");
      label.textContent = truncateLabel(node.label);
      group.append(title, dot, label);
      group.addEventListener("pointerenter", () => {
        this.hovered = node.handle;
        this.paintFocus();
      });
      group.addEventListener("pointerleave", () => {
        if (this.hovered === node.handle) {
          this.hovered = null;
          this.paintFocus();
        }
      });
      group.addEventListener("focus", () => {
        this.hovered = node.handle;
        this.paintFocus();
      });
      group.addEventListener("blur", () => {
        if (this.hovered === node.handle) {
          this.hovered = null;
          this.paintFocus();
        }
      });
      group.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          this.activate(node.handle);
        }
      });
      this.nodeLayer.append(group);
      this.rendered.set(node.handle, { layout: node, group, dot, label });
    }
    this.paintFocus();
    this.render();
    if (this.prefersReducedMotion()) {
      runLayout(layout);
      this.camera = fitCamera(
        layout.nodes,
        this.viewportWidth,
        this.viewportHeight,
      );
      this.fitPending = false;
      this.render();
      return;
    }
    this.startFrame();
  }

  /** Fit the resting graph into the canvas (also used on container resize). */
  fitToView(): void {
    const layout = this.layout;
    if (layout === null) {
      return;
    }
    this.syncViewportSize();
    this.camera = fitCamera(
      layout.nodes,
      this.viewportWidth,
      this.viewportHeight,
    );
    // "全体表示" is an explicit request: it also cancels the keep-my-camera
    // flag set by a previous pan/zoom.
    this.userAdjusted = false;
    // A resize mid-simulation keeps the pending settle refit.
    if (layout.alpha <= 0) {
      this.fitPending = false;
    }
    this.render();
  }

  /** Zoom around the canvas centre (toolbar +/- controls). */
  zoomBy(factor: number): void {
    this.userAdjusted = true;
    this.camera = zoomAt(
      this.camera,
      this.viewportWidth / 2,
      this.viewportHeight / 2,
      factor,
    );
    this.render();
  }

  setSelected(handle: string | null): void {
    this.selected =
      handle !== null && this.rendered.has(handle) ? handle : null;
    this.paintFocus();
  }

  setSearchQuery(query: string): void {
    this.query = query;
    this.paintMatches();
  }

  /** Reheat after an interaction or a data refresh. */
  reheat(amount = 0.65): void {
    if (this.layout === null || this.prefersReducedMotion()) {
      return;
    }
    this.layout.alpha = Math.max(this.layout.alpha, amount);
    this.startFrame();
  }

  destroy(): void {
    this.destroyed = true;
    this.stopFrame();
    this.resizeObserver?.disconnect();
    this.svg.removeEventListener("pointerdown", this.handlePointerDown);
    this.svg.removeEventListener("pointermove", this.handlePointerMove);
    this.svg.removeEventListener("pointerup", this.handlePointerUp);
    this.svg.removeEventListener("pointercancel", this.handlePointerUp);
    this.svg.removeEventListener("wheel", this.handleWheel);
  }

  private prefersReducedMotion(): boolean {
    return (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  private nodeModifierClass(node: LayoutNode): string {
    const kindClass =
      KIND_CLASSES[node.kind] ?? "memory-graph-node--kind-other";
    return `memory-graph-node--${node.status} ${kindClass}`;
  }

  private nodeClass(node: LayoutNode): string {
    const hub = node.topicHub === true ? " memory-graph-node--topic" : "";
    return `memory-graph-node ${this.nodeModifierClass(node)}${hub}`;
  }

  private activate(handle: string): void {
    const node = this.rendered.get(handle)?.layout;
    this.selected = handle;
    this.paintFocus();
    // A topic hub has no memory detail: selecting it highlights its members
    // through the normal 1-hop focus, but it never opens the detail panel or
    // becomes a local-graph centre.
    if (node?.topicHub === true) {
      return;
    }
    this.callbacks.onSelectionChange?.(handle);
    this.callbacks.onNodeActivate(handle);
  }

  private paintFocus(): void {
    const focus = this.hovered ?? this.selected;
    const highlighted =
      focus !== null ? highlightHandles(focus, this.neighbors) : null;
    // Both hover and selection focus dim non-neighbours (CSS gate).
    this.svg.classList.toggle("memory-graph--focus", focus !== null);
    for (const [handle, rendered] of this.rendered) {
      rendered.group.classList.toggle(
        "memory-graph-node--selected",
        handle === this.selected,
      );
      rendered.group.classList.toggle(
        "memory-graph-node--dim",
        highlighted !== null && !highlighted.has(handle),
      );
    }
    for (const { element, edge } of this.edgeElements) {
      element.classList.toggle(
        "memory-graph-edge--dim",
        highlighted !== null &&
          (!highlighted.has(edge.from) || !highlighted.has(edge.to)),
      );
    }
    this.paintMatches();
  }

  private paintMatches(): void {
    for (const rendered of this.rendered.values()) {
      rendered.group.classList.toggle(
        "memory-graph-node--match",
        labelMatches(rendered.layout.label, this.query),
      );
    }
    this.updateLabels();
  }

  /**
   * Re-run greedy label decluttering for the current camera and focus state.
   * Selected/hovered nodes (and, at higher priority, their neighbours) always
   * win; every other label is placed only when it fits without overlap.
   */
  private updateLabels(): void {
    const layout = this.layout;
    if (layout === null) {
      return;
    }
    const scale = this.camera.scale;
    const fontSize = LABEL_FONT_SIZE * scale;
    const focus = this.hovered ?? this.selected;
    const focusSet =
      focus !== null ? highlightHandles(focus, this.neighbors) : null;
    const candidates: LabelCandidate[] = [];
    for (const [handle, rendered] of this.rendered) {
      // Hover/selection is a focus mode: keep the 1-hop neighbourhood legible
      // and hide every unrelated label so the graph reads as a local story.
      if (focusSet !== null && !focusSet.has(handle)) {
        continue;
      }
      const node = rendered.layout;
      const screen = worldToScreen(this.camera, node.x, node.y);
      const discRadius =
        node.topicHub === true ? Math.max(5, node.radius * 0.6) : node.radius;
      candidates.push({
        handle,
        label: node.label,
        x: screen.x,
        y: screen.y,
        radius: discRadius * scale,
        degree: node.degree,
        topicHub: node.topicHub === true,
        selected: handle === this.selected,
        hovered: handle === this.hovered,
        nearFocus: focusSet?.has(handle) ?? false,
      });
    }
    const visible = selectVisibleLabels(candidates, {
      fontSize,
      charLimit: labelCharLimit(scale),
      width: this.viewportWidth,
      height: this.viewportHeight,
      gap: 4 * scale,
    });
    const byHandle = new Map<string, VisibleLabel>();
    for (const label of visible) {
      byHandle.set(label.handle, label);
    }
    for (const [handle, rendered] of this.rendered) {
      const label = byHandle.get(handle);
      rendered.group.classList.toggle(
        "memory-graph-node--label",
        label !== undefined,
      );
      if (label !== undefined) {
        rendered.label.textContent = label.text;
      }
    }
  }

  private startFrame(): void {
    if (this.destroyed) {
      return;
    }
    this.stopFrame();
    const tick = (): void => {
      this.frame = null;
      const layout = this.layout;
      if (this.destroyed || layout === null) {
        return;
      }
      layoutStep(layout);
      if (layout.alpha <= 0 && this.fitPending && !this.userAdjusted) {
        // Refit the *resting* layout (not the deterministic seed cloud):
        // disconnected components can drift under repulsion, and a topic-hub
        // toggle replaces the node set, so every settled simulation needs a
        // fresh camera. fitToView clears fitPending and repaints.
        this.fitToView();
      } else {
        if (layout.alpha <= 0) {
          this.fitPending = false;
        }
        this.render();
      }
      if (layout.alpha > 0) {
        this.frame = window.requestAnimationFrame(tick);
      }
    };
    this.frame = window.requestAnimationFrame(tick);
  }

  private stopFrame(): void {
    if (this.frame !== null) {
      window.cancelAnimationFrame(this.frame);
      this.frame = null;
    }
  }

  private render(): void {
    const layout = this.layout;
    if (layout === null) {
      return;
    }
    const viewport = this.svg.firstElementChild;
    if (viewport !== null) {
      viewport.setAttribute(
        "transform",
        `translate(${this.camera.tx} ${this.camera.ty}) scale(${this.camera.scale})`,
      );
    }
    for (const { element, edge } of this.edgeElements) {
      const from = this.rendered.get(edge.from)?.layout;
      const to = this.rendered.get(edge.to)?.layout;
      if (from === undefined || to === undefined) {
        element.setAttribute("visibility", "hidden");
        continue;
      }
      element.removeAttribute("visibility");
      element.setAttribute("x1", String(from.x));
      element.setAttribute("y1", String(from.y));
      element.setAttribute("x2", String(to.x));
      element.setAttribute("y2", String(to.y));
    }
    for (const rendered of this.rendered.values()) {
      rendered.group.setAttribute(
        "transform",
        `translate(${rendered.layout.x} ${rendered.layout.y})`,
      );
    }
    this.updateLabels();
  }

  private svgPoint(event: PointerEvent | WheelEvent): { x: number; y: number } {
    const matrix = this.svg.getScreenCTM();
    if (matrix !== null) {
      const point = this.svg.createSVGPoint();
      point.x = event.clientX;
      point.y = event.clientY;
      const local = point.matrixTransform(matrix.inverse());
      return { x: local.x, y: local.y };
    }
    const rect = this.svg.getBoundingClientRect();
    const width = rect.width === 0 ? this.viewportWidth : rect.width;
    const height = rect.height === 0 ? this.viewportHeight : rect.height;
    return {
      x: ((event.clientX - rect.left) / width) * this.viewportWidth,
      y: ((event.clientY - rect.top) / height) * this.viewportHeight,
    };
  }

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) {
      return;
    }
    const target = event.target;
    const group =
      target instanceof Element
        ? target.closest<SVGGElement>(".memory-graph-node")
        : null;
    const point = this.svgPoint(event);
    const handle = group?.dataset.handle ?? null;
    if (handle !== null && this.rendered.has(handle)) {
      const node = this.rendered.get(handle)?.layout;
      if (node !== undefined) {
        node.fixed = true;
        node.vx = 0;
        node.vy = 0;
        this.gesture = {
          mode: "node",
          handle,
          lastX: point.x,
          lastY: point.y,
          offsetX: node.x - screenToWorld(this.camera, point.x, point.y).x,
          offsetY: node.y - screenToWorld(this.camera, point.x, point.y).y,
          moved: false,
        };
        this.svg.setPointerCapture(event.pointerId);
        event.preventDefault();
        return;
      }
    }
    this.gesture = {
      mode: "pan",
      handle: null,
      lastX: point.x,
      lastY: point.y,
      offsetX: 0,
      offsetY: 0,
      moved: false,
    };
    this.svg.classList.add("memory-graph--panning");
    this.svg.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    const gesture = this.gesture;
    if (gesture === null) {
      return;
    }
    const point = this.svgPoint(event);
    const dx = point.x - gesture.lastX;
    const dy = point.y - gesture.lastY;
    if (Math.abs(dx) + Math.abs(dy) > 2) {
      gesture.moved = true;
    }
    gesture.lastX = point.x;
    gesture.lastY = point.y;
    if (gesture.mode === "pan") {
      this.userAdjusted = true;
      this.camera = {
        scale: this.camera.scale,
        tx: this.camera.tx + dx,
        ty: this.camera.ty + dy,
      };
      this.render();
      return;
    }
    if (gesture.handle !== null) {
      const node = this.rendered.get(gesture.handle)?.layout;
      if (node === undefined) {
        return;
      }
      const world = screenToWorld(this.camera, point.x, point.y);
      node.x = world.x + gesture.offsetX;
      node.y = world.y + gesture.offsetY;
      node.vx = 0;
      node.vy = 0;
      this.reheat();
      this.render();
    }
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    const gesture = this.gesture;
    if (gesture === null) {
      return;
    }
    this.gesture = null;
    this.svg.classList.remove("memory-graph--panning");
    if (this.svg.hasPointerCapture(event.pointerId)) {
      this.svg.releasePointerCapture(event.pointerId);
    }
    if (gesture.mode === "node" && gesture.handle !== null) {
      const node = this.rendered.get(gesture.handle)?.layout;
      if (node !== undefined) {
        node.fixed = false;
      }
      if (!gesture.moved) {
        this.activate(gesture.handle);
      } else {
        this.reheat();
      }
    }
  };

  private readonly handleWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const point = this.svgPoint(event);
    const factor = Math.exp(-event.deltaY * 0.0015);
    this.userAdjusted = true;
    this.camera = zoomAt(this.camera, point.x, point.y, factor);
    this.render();
  };
}
