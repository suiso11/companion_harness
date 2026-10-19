// AV04 learning shared pure state (no DOM): moved from the legacy
// `apps/server/src/ui/learning_panel.ts` so the native Svelte LearningPanel
// and the legacy DOM panel share ONE guard/label source of truth (no
// re-implementation divergence). Pure guards + labels only — no HTTP, no
// document access.

export interface EvidenceCounts {
  readonly supports: number;
  readonly refutes: number;
  readonly neutral: number;
}

export interface HypothesisView {
  readonly id: string;
  readonly sessionId: string;
  readonly scope: string;
  readonly kind: string;
  readonly statement: string;
  readonly status: "open" | "supported" | "refuted" | "retired";
  readonly version: number;
  readonly origin: "human" | "model";
  readonly staged: boolean;
  readonly needsReevaluation: boolean;
  readonly evidenceCounts: EvidenceCounts;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface EvidenceView {
  readonly id: string;
  readonly hypothesisId: string;
  readonly sessionId: string;
  readonly polarity: "supports" | "refutes" | "neutral";
  readonly sourceKind:
    | "shadow_job"
    | "conversation_proposal"
    | "action_receipt"
    | "task_event";
  readonly sourceId: string;
  readonly note: string | null;
  readonly createdAt: number;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCounts(value: unknown): value is EvidenceCounts {
  if (!isRecord(value)) return false;
  return (
    Number.isInteger(value.supports) &&
    (value.supports as number) >= 0 &&
    Number.isInteger(value.refutes) &&
    (value.refutes as number) >= 0 &&
    Number.isInteger(value.neutral) &&
    (value.neutral as number) >= 0
  );
}

export function isHypothesisView(value: unknown): value is HypothesisView {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.scope === "string" &&
    (value.kind === "method" || value.kind === "hypothesis") &&
    typeof value.statement === "string" &&
    (value.status === "open" ||
      value.status === "supported" ||
      value.status === "refuted" ||
      value.status === "retired") &&
    typeof value.version === "number" &&
    (value.origin === "human" || value.origin === "model") &&
    typeof value.staged === "boolean" &&
    typeof value.needsReevaluation === "boolean" &&
    isCounts(value.evidenceCounts) &&
    typeof value.createdAt === "number" &&
    typeof value.updatedAt === "number"
  );
}

export function isEvidenceView(value: unknown): value is EvidenceView {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.hypothesisId === "string" &&
    typeof value.sessionId === "string" &&
    (value.polarity === "supports" ||
      value.polarity === "refutes" ||
      value.polarity === "neutral") &&
    (value.sourceKind === "shadow_job" ||
      value.sourceKind === "conversation_proposal" ||
      value.sourceKind === "action_receipt" ||
      value.sourceKind === "task_event") &&
    typeof value.sourceId === "string" &&
    (value.note === null || typeof value.note === "string") &&
    typeof value.createdAt === "number"
  );
}

export function readItems(body: unknown): HypothesisView[] {
  if (!isRecord(body)) return [];
  const items = body.items;
  if (!Array.isArray(items)) return [];
  return items.filter(isHypothesisView);
}

export function readEvidence(body: unknown): EvidenceView[] {
  if (!isRecord(body)) return [];
  const items = body.items;
  if (!Array.isArray(items)) return [];
  return items.filter(isEvidenceView);
}

/** Opaque older-page cursor (null when the server has no older page). */
export function readCursor(body: unknown): string | null {
  if (!isRecord(body)) return null;
  return typeof body.nextCursor === "string" ? body.nextCursor : null;
}

export function readHasMore(body: unknown): boolean {
  if (!isRecord(body)) return false;
  return body.hasMore === true;
}

/** Strict UUID v4 shape (client-side pre-freeze validation only). */
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const KIND_TEXT: Record<string, string> = {
  method: "方法",
  hypothesis: "仮説",
};

export const STATUS_TEXT: Record<string, string> = {
  open: "検討中",
  supported: "支持",
  refuted: "反証",
  retired: "引退",
};

export const POLARITY_TEXT: Record<string, string> = {
  supports: "支持",
  refutes: "反証",
  neutral: "中立",
};

export const SOURCE_TEXT: Record<string, string> = {
  shadow_job: "試行",
  conversation_proposal: "会話の候補",
  action_receipt: "実行記録",
  task_event: "作業履歴",
};

/** Existing section that owns the source row (read-only scroll target). */
export const SOURCE_SECTION: Record<string, string> = {
  shadow_job: "shadow",
  conversation_proposal: "proposals",
  action_receipt: "autonomy",
  task_event: "autonomy",
};

export function textOf(map: Record<string, string>, key: string): string {
  return map[key] ?? key;
}
