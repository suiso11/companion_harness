// Pure layout and state-visualization helpers for `/tasks` (AutonomyPanel).
//
// Strict CSP (`style-src 'self'`): all dynamic geometry is expressed as
// numeric SVG coordinates/attributes (`x`, `y`, `width`, `height`, `cx`,
// `cy`, `r`, `d`, `stroke-dasharray`, `stroke-dashoffset`) and semantic
// `data-*` state tokens — never inline CSS `style` strings.

export interface VisPurpose {
  readonly id: string;
  readonly statement: string;
  readonly kind: string;
  readonly status: string;
  readonly validFrom: string;
  readonly validUntil: string;
  readonly explicit: boolean;
  readonly sourceKind: string;
}

export interface VisTask {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
  readonly status: string;
  readonly deadline: string;
  readonly parentPurposeId: string | null;
}

export interface VisConflictPair {
  readonly id: string;
  readonly purposeAId: string;
  readonly purposeBId: string;
}

export type VisTone = "ok" | "warn" | "bad" | "done" | "accent" | "neutral";

export interface VisHistoryStep {
  readonly seq: number;
  readonly event: string;
  readonly eventLabel: string;
  readonly fromStatus: string;
  readonly toStatus: string;
  readonly note: string;
  readonly tone: VisTone;
}

const PURPOSE_KIND_LABELS: Readonly<Record<string, string>> = {
  goal: "目標",
  preference: "好み",
  constraint: "制約",
  permission: "許可",
  wish: "希望",
  temporary_state: "一時",
  standalone: "単独",
};

const PURPOSE_STATUS_LABELS: Readonly<Record<string, string>> = {
  active: "有効",
  achieved: "達成",
  revoked: "取消",
  superseded: "旧版",
};

const TASK_KIND_LABELS: Readonly<Record<string, string>> = {
  chat: "相談",
  wish: "希望",
  problem: "課題",
  task: "作業",
};

const TASK_STATUS_LABELS: Readonly<Record<string, string>> = {
  open: "未着手",
  in_progress: "進行中",
  held: "保留",
  completed: "完了",
  cancelled: "中止",
};

const EVENT_LABELS: Readonly<Record<string, string>> = {
  created: "作成",
  corrected: "訂正",
  superseded: "旧版化",
  achieved: "達成",
  revoked: "取消",
  confirmed: "本人確定",
  started: "開始",
  held: "保留",
  parent_held: "親変更で保留",
  resumed: "再開",
  completed: "完了",
  cancelled: "中止",
};

export function purposeKindLabel(kind: string): string {
  return PURPOSE_KIND_LABELS[kind] ?? kind;
}

export function purposeStatusLabel(status: string): string {
  return PURPOSE_STATUS_LABELS[status] ?? status;
}

export function taskKindLabel(kind: string): string {
  return TASK_KIND_LABELS[kind] ?? kind;
}

export function taskStatusLabel(status: string): string {
  return TASK_STATUS_LABELS[status] ?? status;
}

export function statusTone(status: string): VisTone {
  if (status === "active" || status === "in_progress") return "ok";
  if (status === "open") return "accent";
  if (status === "held") return "warn";
  if (status === "revoked") return "bad";
  if (
    status === "achieved" ||
    status === "superseded" ||
    status === "completed" ||
    status === "cancelled"
  ) {
    return "done";
  }
  return "neutral";
}

/** Truncate by Unicode code points with a single ellipsis character. */
export function truncateVisLabel(text: string, maxChars = 18): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (maxChars <= 0) return "";
  const chars = Array.from(flat);
  if (chars.length <= maxChars) return flat;
  return `${chars.slice(0, maxChars - 1).join("")}…`;
}

/**
 * Parse `/api/sessions/:id/purpose-conflicts` payload into deduplicated
 * active conflict pairs.
 */
export function parseConflictPairs(body: unknown): VisConflictPair[] {
  if (typeof body !== "object" || body === null) return [];
  const raw = (body as { conflicts?: unknown }).conflicts;
  if (!Array.isArray(raw)) return [];
  const pairs: VisConflictPair[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    if (typeof item !== "object" || item === null) continue;
    const row = item as {
      id?: unknown;
      purposeIds?: unknown;
      purposeAId?: unknown;
      purposeBId?: unknown;
    };
    let a = "";
    let b = "";
    if (Array.isArray(row.purposeIds) && row.purposeIds.length >= 2) {
      a = typeof row.purposeIds[0] === "string" ? row.purposeIds[0] : "";
      b = typeof row.purposeIds[1] === "string" ? row.purposeIds[1] : "";
    } else {
      a = typeof row.purposeAId === "string" ? row.purposeAId : "";
      b = typeof row.purposeBId === "string" ? row.purposeBId : "";
    }
    if (a.length === 0 || b.length === 0 || a === b) continue;
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const id = typeof row.id === "string" && row.id.length > 0 ? row.id : key;
    pairs.push({ id, purposeAId: a, purposeBId: b });
  }
  return pairs;
}

/**
 * Parse `/history` events into structured steps for the visual lifecycle
 * stepper while keeping the raw ledger text intact for tests.
 */
export function parseHistorySteps(
  events: unknown,
  withNote: boolean,
): VisHistoryStep[] {
  if (!Array.isArray(events)) return [];
  const steps: VisHistoryStep[] = [];
  for (const entry of events) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as {
      seq?: unknown;
      event?: unknown;
      fromStatus?: unknown;
      toStatus?: unknown;
      note?: unknown;
    };
    if (typeof row.seq !== "number" || typeof row.event !== "string") continue;
    const fromStatus =
      typeof row.fromStatus === "string" && row.fromStatus.length > 0
        ? row.fromStatus
        : "−";
    const toStatus =
      typeof row.toStatus === "string" && row.toStatus.length > 0
        ? row.toStatus
        : "";
    const note =
      withNote && typeof row.note === "string" && row.note.length > 0
        ? row.note
        : "";
    steps.push({
      seq: row.seq,
      event: row.event,
      eventLabel: EVENT_LABELS[row.event] ?? row.event,
      fromStatus,
      toStatus,
      note,
      tone: statusTone(toStatus || row.event),
    });
  }
  return steps;
}

export interface VisBarSegment {
  readonly key: string;
  readonly label: string;
  readonly count: number;
  readonly tone: VisTone;
  readonly x: number;
  readonly width: number;
}

export interface VisDonutSegment {
  readonly key: string;
  readonly label: string;
  readonly count: number;
  readonly tone: VisTone;
  readonly dasharray: string;
  readonly dashoffset: number;
}

export interface AutonomyMetrics {
  readonly purposeTotal: number;
  readonly purposeActive: number;
  readonly purposeAchieved: number;
  readonly purposeRevoked: number;
  readonly purposeSuperseded: number;
  readonly taskTotal: number;
  readonly taskOpen: number;
  readonly taskInProgress: number;
  readonly taskHeld: number;
  readonly taskCompleted: number;
  readonly taskCancelled: number;
  readonly completionPct: number;
  readonly donutSegments: readonly VisDonutSegment[];
  readonly taskBarSegments: readonly VisBarSegment[];
}

export const DONUT_RADIUS = 30;
export const DONUT_CIRCUMFERENCE = 2 * Math.PI * DONUT_RADIUS;
export const BAR_TOTAL_WIDTH = 240;

export function buildAutonomyMetrics(
  purposes: readonly VisPurpose[],
  tasks: readonly VisTask[],
): AutonomyMetrics {
  let purposeActive = 0;
  let purposeAchieved = 0;
  let purposeRevoked = 0;
  let purposeSuperseded = 0;
  for (const p of purposes) {
    if (p.status === "active") purposeActive += 1;
    else if (p.status === "achieved") purposeAchieved += 1;
    else if (p.status === "revoked") purposeRevoked += 1;
    else if (p.status === "superseded") purposeSuperseded += 1;
  }

  let taskOpen = 0;
  let taskInProgress = 0;
  let taskHeld = 0;
  let taskCompleted = 0;
  let taskCancelled = 0;
  for (const t of tasks) {
    if (t.status === "open") taskOpen += 1;
    else if (t.status === "in_progress") taskInProgress += 1;
    else if (t.status === "held") taskHeld += 1;
    else if (t.status === "completed") taskCompleted += 1;
    else if (t.status === "cancelled") taskCancelled += 1;
  }

  const actionableTasks = taskOpen + taskInProgress + taskHeld + taskCompleted;
  const completionPct =
    actionableTasks > 0
      ? Math.round((taskCompleted / actionableTasks) * 100)
      : purposes.length > 0
        ? Math.round(
            ((purposeAchieved + purposeActive) / purposes.length) * 100,
          )
        : 0;

  // Build SVG donut segments for purposes (or tasks when purposes are empty).
  const donutRaw: {
    key: string;
    label: string;
    count: number;
    tone: VisTone;
  }[] = [
    { key: "active", label: "有効", count: purposeActive, tone: "ok" },
    { key: "achieved", label: "達成", count: purposeAchieved, tone: "done" },
    {
      key: "superseded",
      label: "旧版",
      count: purposeSuperseded,
      tone: "neutral",
    },
    { key: "revoked", label: "取消", count: purposeRevoked, tone: "bad" },
  ];
  const donutSum = donutRaw.reduce((acc, item) => acc + item.count, 0);
  const donutSegments: VisDonutSegment[] = [];
  if (donutSum > 0) {
    let offset = 0;
    for (const item of donutRaw) {
      if (item.count <= 0) continue;
      const len = (item.count / donutSum) * DONUT_CIRCUMFERENCE;
      donutSegments.push({
        key: item.key,
        label: item.label,
        count: item.count,
        tone: item.tone,
        dasharray: `${len.toFixed(2)} ${(DONUT_CIRCUMFERENCE - len).toFixed(2)}`,
        dashoffset: Number((-offset).toFixed(2)),
      });
      offset += len;
    }
  }

  // Build SVG stacked horizontal bar segments for tasks (viewBox width 240).
  const barRaw: {
    key: string;
    label: string;
    count: number;
    tone: VisTone;
  }[] = [
    {
      key: "in_progress",
      label: "進行中",
      count: taskInProgress,
      tone: "ok",
    },
    { key: "open", label: "未着手", count: taskOpen, tone: "accent" },
    { key: "held", label: "保留", count: taskHeld, tone: "warn" },
    { key: "completed", label: "完了", count: taskCompleted, tone: "done" },
    { key: "cancelled", label: "中止", count: taskCancelled, tone: "bad" },
  ];
  const taskSum = barRaw.reduce((acc, item) => acc + item.count, 0);
  const taskBarSegments: VisBarSegment[] = [];
  if (taskSum > 0) {
    let cursorX = 0;
    for (const item of barRaw) {
      if (item.count <= 0) continue;
      const w = (item.count / taskSum) * BAR_TOTAL_WIDTH;
      taskBarSegments.push({
        key: item.key,
        label: item.label,
        count: item.count,
        tone: item.tone,
        x: Number(cursorX.toFixed(2)),
        width: Number(Math.max(w, 2).toFixed(2)),
      });
      cursorX += w;
    }
  }

  return {
    purposeTotal: purposes.length,
    purposeActive,
    purposeAchieved,
    purposeRevoked,
    purposeSuperseded,
    taskTotal: tasks.length,
    taskOpen,
    taskInProgress,
    taskHeld,
    taskCompleted,
    taskCancelled,
    completionPct,
    donutSegments,
    taskBarSegments,
  };
}

export const STANDALONE_NODE_ID = "__standalone__";

export interface VisPurposeNode {
  readonly id: string;
  readonly statement: string;
  readonly shortLabel: string;
  readonly kind: string;
  readonly kindLabel: string;
  readonly status: string;
  readonly statusLabel: string;
  readonly tone: VisTone;
  readonly childCount: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly selected: boolean;
  readonly armed: boolean;
  readonly conflicting: boolean;
  readonly standalone: boolean;
}

export interface VisTaskNode {
  readonly id: string;
  readonly title: string;
  readonly shortLabel: string;
  readonly kind: string;
  readonly kindLabel: string;
  readonly status: string;
  readonly statusLabel: string;
  readonly tone: VisTone;
  readonly deadline: string;
  readonly parentPurposeId: string | null;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly selected: boolean;
  readonly attachedToSelectedPurpose: boolean;
}

export interface VisHierarchyEdge {
  readonly id: string;
  readonly fromPurposeId: string;
  readonly toTaskId: string;
  readonly path: string;
  readonly tone: VisTone;
  readonly highlighted: boolean;
}

export interface VisConflictArc {
  readonly id: string;
  readonly purposeAId: string;
  readonly purposeBId: string;
  readonly path: string;
  readonly badgeX: number;
  readonly badgeY: number;
  readonly highlighted: boolean;
}

export interface AutonomyGraphLayout {
  readonly width: number;
  readonly height: number;
  readonly purposeNodes: readonly VisPurposeNode[];
  readonly taskNodes: readonly VisTaskNode[];
  readonly edges: readonly VisHierarchyEdge[];
  readonly conflictArcs: readonly VisConflictArc[];
}

export const AUTONOMY_GRAPH_WIDTH = 720;
const PURPOSE_X = 64;
const PURPOSE_W = 244;
const PURPOSE_H = 46;
const TASK_X = 432;
const TASK_W = 264;
const TASK_H = 42;
const ROW_STEP_Y = 58;
const TOP_PAD_Y = 36;

/**
 * Deterministic bipartite node-link layout:
 * - Left column: Purposes (plus a virtual "単独の作業" hub when standalone tasks exist)
 * - Far-left arcs: Red dashed conflict curves connecting conflicting purposes
 * - Right column: Tasks ordered near their parent purpose
 * - Center S-curves: Parent Purpose -> Child Task connectors
 */
export function buildAutonomyGraphLayout(
  purposes: readonly VisPurpose[],
  tasks: readonly VisTask[],
  conflicts: readonly VisConflictPair[],
  selectedPurposeId: string | null,
  selectedTaskId: string | null,
  conflictArmId: string | null,
): AutonomyGraphLayout {
  const purposeIds = new Set(purposes.map((p) => p.id));
  const conflictingIds = new Set<string>();
  for (const c of conflicts) {
    if (purposeIds.has(c.purposeAId) && purposeIds.has(c.purposeBId)) {
      conflictingIds.add(c.purposeAId);
      conflictingIds.add(c.purposeBId);
    }
  }

  const childrenByPurpose = new Map<string, VisTask[]>();
  for (const p of purposes) childrenByPurpose.set(p.id, []);
  const standaloneTasks: VisTask[] = [];
  for (const t of tasks) {
    if (
      t.parentPurposeId !== null &&
      childrenByPurpose.has(t.parentPurposeId)
    ) {
      childrenByPurpose.get(t.parentPurposeId)?.push(t);
    } else {
      standaloneTasks.push(t);
    }
  }

  const purposeNodes: VisPurposeNode[] = purposes.map((p, idx) => {
    const childCount = childrenByPurpose.get(p.id)?.length ?? 0;
    return {
      id: p.id,
      statement: p.statement,
      shortLabel: truncateVisLabel(p.statement, 16),
      kind: p.kind,
      kindLabel: purposeKindLabel(p.kind),
      status: p.status,
      statusLabel: purposeStatusLabel(p.status),
      tone: statusTone(p.status),
      childCount,
      x: PURPOSE_X,
      y: TOP_PAD_Y + idx * ROW_STEP_Y,
      width: PURPOSE_W,
      height: PURPOSE_H,
      selected: selectedPurposeId === p.id,
      armed: conflictArmId === p.id,
      conflicting: conflictingIds.has(p.id),
      standalone: false,
    };
  });

  if (standaloneTasks.length > 0) {
    const idx = purposeNodes.length;
    purposeNodes.push({
      id: STANDALONE_NODE_ID,
      statement: "単独の作業（親の目的と未接続）",
      shortLabel: "単独の作業",
      kind: "standalone",
      kindLabel: "単独",
      status: "open",
      statusLabel: `${standaloneTasks.length}件`,
      tone: "neutral",
      childCount: standaloneTasks.length,
      x: PURPOSE_X,
      y: TOP_PAD_Y + idx * ROW_STEP_Y,
      width: PURPOSE_W,
      height: PURPOSE_H,
      selected: false,
      armed: false,
      conflicting: false,
      standalone: true,
    });
  }

  // Order tasks grouped by purpose appearance so S-curve edges minimize crossings.
  const orderedTasks: VisTask[] = [];
  for (const p of purposes) {
    const group = childrenByPurpose.get(p.id) ?? [];
    orderedTasks.push(...group);
  }
  orderedTasks.push(...standaloneTasks);

  const selectedTaskObj =
    selectedTaskId === null
      ? null
      : (tasks.find((t) => t.id === selectedTaskId) ?? null);

  const taskNodes: VisTaskNode[] = orderedTasks.map((t, idx) => {
    const attachedToSelected =
      selectedPurposeId !== null && t.parentPurposeId === selectedPurposeId;
    return {
      id: t.id,
      title: t.title,
      shortLabel: truncateVisLabel(t.title, 17),
      kind: t.kind,
      kindLabel: taskKindLabel(t.kind),
      status: t.status,
      statusLabel: taskStatusLabel(t.status),
      tone: statusTone(t.status),
      deadline: t.deadline,
      parentPurposeId: t.parentPurposeId,
      x: TASK_X,
      y: TOP_PAD_Y + idx * (TASK_H + 12),
      width: TASK_W,
      height: TASK_H,
      selected: selectedTaskId === t.id,
      attachedToSelectedPurpose: attachedToSelected,
    };
  });

  const purposeNodeById = new Map(purposeNodes.map((n) => [n.id, n]));
  const edges: VisHierarchyEdge[] = [];
  for (const tNode of taskNodes) {
    const parentId =
      tNode.parentPurposeId !== null &&
      purposeNodeById.has(tNode.parentPurposeId)
        ? tNode.parentPurposeId
        : STANDALONE_NODE_ID;
    const pNode = purposeNodeById.get(parentId);
    if (pNode === undefined) continue;
    const x1 = pNode.x + pNode.width;
    const y1 = pNode.y + pNode.height / 2;
    const x2 = tNode.x;
    const y2 = tNode.y + tNode.height / 2;
    const midX = (x1 + x2) / 2;
    const highlighted =
      pNode.selected ||
      tNode.selected ||
      (selectedTaskObj !== null &&
        selectedTaskObj.parentPurposeId === pNode.id);
    edges.push({
      id: `${pNode.id}->${tNode.id}`,
      fromPurposeId: pNode.id,
      toTaskId: tNode.id,
      path: `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`,
      tone: tNode.tone,
      highlighted,
    });
  }

  const conflictArcs: VisConflictArc[] = [];
  for (let i = 0; i < conflicts.length; i += 1) {
    const pair = conflicts[i];
    if (pair === undefined) continue;
    const nodeA = purposeNodeById.get(pair.purposeAId);
    const nodeB = purposeNodeById.get(pair.purposeBId);
    if (nodeA === undefined || nodeB === undefined) continue;
    const y1 = nodeA.y + nodeA.height / 2;
    const y2 = nodeB.y + nodeB.height / 2;
    const x = PURPOSE_X;
    const bow = Math.max(12, PURPOSE_X - 26 - (i % 3) * 12);
    const highlighted = nodeA.selected || nodeB.selected;
    conflictArcs.push({
      id: pair.id,
      purposeAId: pair.purposeAId,
      purposeBId: pair.purposeBId,
      path: `M ${x} ${y1} C ${bow} ${y1}, ${bow} ${y2}, ${x} ${y2}`,
      badgeX: Math.round((x + bow) / 2),
      badgeY: Math.round((y1 + y2) / 2),
      highlighted,
    });
  }

  const maxPurposeBottom =
    purposeNodes.length > 0
      ? (purposeNodes[purposeNodes.length - 1]?.y ?? 0) + PURPOSE_H + 28
      : 160;
  const maxTaskBottom =
    taskNodes.length > 0
      ? (taskNodes[taskNodes.length - 1]?.y ?? 0) + TASK_H + 28
      : 160;
  const height = Math.max(176, maxPurposeBottom, maxTaskBottom);

  return {
    width: AUTONOMY_GRAPH_WIDTH,
    height,
    purposeNodes,
    taskNodes,
    edges,
    conflictArcs,
  };
}

export interface VisKanbanCard {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
  readonly kindLabel: string;
  readonly status: string;
  readonly statusLabel: string;
  readonly tone: VisTone;
  readonly deadline: string;
  readonly parentPurposeId: string | null;
  readonly parentStatement: string | null;
  readonly attachedToSelectedPurpose: boolean;
  readonly selected: boolean;
}

export interface VisKanbanLane {
  readonly key: "open" | "in_progress" | "held" | "done";
  readonly label: string;
  readonly tone: VisTone;
  readonly items: readonly VisKanbanCard[];
}

export function buildTaskKanbanLanes(
  tasks: readonly VisTask[],
  purposes: readonly VisPurpose[],
  selectedPurposeId: string | null,
  selectedTaskId: string | null,
): VisKanbanLane[] {
  const purposeById = new Map(purposes.map((p) => [p.id, p]));
  const buckets: Record<
    "open" | "in_progress" | "held" | "done",
    VisKanbanCard[]
  > = {
    open: [],
    in_progress: [],
    held: [],
    done: [],
  };
  for (const t of tasks) {
    const parent =
      t.parentPurposeId !== null
        ? (purposeById.get(t.parentPurposeId) ?? null)
        : null;
    const card: VisKanbanCard = {
      id: t.id,
      title: t.title,
      kind: t.kind,
      kindLabel: taskKindLabel(t.kind),
      status: t.status,
      statusLabel: taskStatusLabel(t.status),
      tone: statusTone(t.status),
      deadline: t.deadline,
      parentPurposeId: t.parentPurposeId,
      parentStatement:
        parent !== null ? truncateVisLabel(parent.statement, 20) : null,
      attachedToSelectedPurpose:
        selectedPurposeId !== null && t.parentPurposeId === selectedPurposeId,
      selected: selectedTaskId === t.id,
    };
    if (t.status === "open") buckets.open.push(card);
    else if (t.status === "in_progress") buckets.in_progress.push(card);
    else if (t.status === "held") buckets.held.push(card);
    else buckets.done.push(card);
  }
  return [
    { key: "open", label: "未着手", tone: "accent", items: buckets.open },
    {
      key: "in_progress",
      label: "進行中",
      tone: "ok",
      items: buckets.in_progress,
    },
    { key: "held", label: "保留", tone: "warn", items: buckets.held },
    { key: "done", label: "完了・中止", tone: "done", items: buckets.done },
  ];
}
