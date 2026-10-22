// Conversation-memory graph view: a small deterministic force-directed
// layout plus an SVG canvas (no framework, no inline styles, no innerHTML).
//
// Pure layout/math helpers are exported separately from `GraphCanvas` so the
// simulation can be unit-tested in Node without a DOM. Node/browser code is
// only reached when the class is constructed.

/// <reference lib="dom" />

export interface GraphNodeData {
  readonly handle: string;
  readonly label: string;
  readonly status: "active" | "retired";
  readonly kind: string;
  readonly episode: unknown;
}

export interface GraphEdgeData {
  readonly from: string;
  readonly to: string;
  readonly kind: "related" | "consolidation";
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
    return [
      {
        handle: node.handle,
        label: node.label,
        status: node.status,
        kind: node.kind,
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
      (edge.kind !== "related" && edge.kind !== "consolidation")
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
export const LABEL_ZOOM_THRESHOLD = 1.2;
/** Graphs up to this many nodes always show every label. */
export const LABEL_NODE_LIMIT = 80;
/** Displayed labels are truncated to this many characters (plus ellipsis). */
export const LABEL_MAX_CHARS = 24;
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
 * Label rule: small graphs always show labels; large graphs only when the
 * effective zoom makes them readable (hover/selection labels are separate).
 */
export function shouldShowLabels(nodeCount: number, scale: number): boolean {
  return nodeCount <= LABEL_NODE_LIMIT || scale >= LABEL_ZOOM_THRESHOLD;
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
 * links, weak centering, velocity damping and alpha decay. A collision pass
 * keeps resting nodes from overlapping even in dense local graphs.
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
  const spread = Math.sqrt(area / count) * 0.5;
  const desired = Math.max(42, Math.min(96, spread * 0.72));
  const repulsion = spread * spread * 0.02;
  const spring = 0.018;
  const centerPull = 0.0025;
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

  const halfWidth = layout.width / 2;
  const halfHeight = layout.height / 2;
  for (let index = 0; index < count; index += 1) {
    const node = nodes[index];
    if (node === undefined) {
      continue;
    }
    if (!node.fixed) {
      node.vx =
        (node.vx + (forceX[index] ?? 0) * alpha - node.x * centerPull) *
        damping;
      node.vy =
        (node.vy + (forceY[index] ?? 0) * alpha - node.y * centerPull) *
        damping;
      node.x += node.vx;
      node.y += node.vy;
    } else {
      node.vx = 0;
      node.vy = 0;
    }
    const margin = node.radius + 4;
    node.x = Math.min(
      halfWidth - margin,
      Math.max(-halfWidth + margin, node.x),
    );
    node.y = Math.min(
      halfHeight - margin,
      Math.max(-halfHeight + margin, node.y),
    );
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
  readonly circle: SVGCircleElement;
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
    this.syncViewportSize();
    const layout = createLayout(data.nodes, data.edges);
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
      element.setAttribute(
        "class",
        `memory-graph-edge memory-graph-edge--${edge.kind}`,
      );
      this.edgeLayer.append(element);
      this.edgeElements.push({ element, edge });
    }
    for (const node of layout.nodes) {
      const group = this.doc.createElementNS(SVG_NS, "g");
      group.setAttribute("class", this.nodeClass(node));
      group.setAttribute("tabindex", "0");
      group.setAttribute("role", "button");
      group.setAttribute("aria-label", `${node.label} (${node.handle})`);
      group.dataset.handle = node.handle;
      const circle = this.doc.createElementNS(SVG_NS, "circle");
      circle.setAttribute(
        "class",
        `memory-graph-node__dot ${this.nodeModifierClass(node)}`,
      );
      circle.setAttribute("r", String(node.radius));
      circle.setAttribute("cx", "0");
      circle.setAttribute("cy", "0");
      // Full label for the native tooltip; the visible text is truncated so a
      // long memory never paints a wall of text over its neighbours.
      const title = this.doc.createElementNS(SVG_NS, "title");
      title.textContent = node.label;
      const label = this.doc.createElementNS(SVG_NS, "text");
      label.setAttribute("class", "memory-graph-node__label");
      label.setAttribute("x", String(node.radius + 4));
      label.setAttribute("y", "4");
      label.textContent = truncateLabel(node.label);
      group.append(title, circle, label);
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
      this.rendered.set(node.handle, { layout: node, group, circle, label });
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
    // A resize mid-simulation keeps the pending settle refit.
    if (layout.alpha <= 0) {
      this.fitPending = false;
    }
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
    return `memory-graph-node ${this.nodeModifierClass(node)}`;
  }

  private activate(handle: string): void {
    this.selected = handle;
    this.paintFocus();
    this.callbacks.onSelectionChange?.(handle);
    this.callbacks.onNodeActivate(handle);
  }

  private paintFocus(): void {
    const focus = this.hovered ?? this.selected;
    const highlighted =
      focus !== null ? highlightHandles(focus, this.neighbors) : null;
    const labelled = new Set<string>();
    if (this.hovered !== null) {
      labelled.add(this.hovered);
      for (const neighbor of this.neighbors.get(this.hovered) ?? []) {
        labelled.add(neighbor);
      }
    }
    if (this.selected !== null) {
      labelled.add(this.selected);
    }
    this.svg.classList.toggle("memory-graph--focus", this.hovered !== null);
    for (const [handle, rendered] of this.rendered) {
      rendered.group.classList.toggle(
        "memory-graph-node--selected",
        handle === this.selected,
      );
      rendered.group.classList.toggle(
        "memory-graph-node--label",
        labelled.has(handle),
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
    this.updateLabelMode();
  }

  private paintMatches(): void {
    for (const rendered of this.rendered.values()) {
      rendered.group.classList.toggle(
        "memory-graph-node--match",
        labelMatches(rendered.layout.label, this.query),
      );
    }
    this.updateLabelMode();
  }

  private updateLabelMode(): void {
    this.svg.classList.toggle(
      "memory-graph--labels",
      shouldShowLabels(this.layout?.nodes.length ?? 0, this.camera.scale),
    );
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
      if (layout.alpha <= 0 && this.fitPending) {
        this.camera = fitCamera(
          layout.nodes,
          this.viewportWidth,
          this.viewportHeight,
        );
        this.fitPending = false;
      }
      this.render();
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
    this.updateLabelMode();
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
    this.camera = zoomAt(this.camera, point.x, point.y, factor);
    this.render();
  };
}
