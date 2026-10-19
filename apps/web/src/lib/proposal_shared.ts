// AV03 conversation-proposal shared pure state (no DOM): moved from the
// legacy `apps/server/src/ui/proposal_panel.ts` so the native Svelte
// ProposalsPanel and the legacy DOM panel share ONE guard/label source of
// truth (no re-implementation divergence). Pure guards + labels only — no
// HTTP, no document access.

export interface ProposalView {
  readonly id: string;
  readonly sessionId: string;
  readonly scope: string;
  readonly target: "purpose" | "task";
  readonly draftKind: string;
  readonly purposeKind: string | null;
  readonly taskKind: string | null;
  readonly sourceQuote: string;
  readonly interpretation: string;
  readonly sourceKind: "model";
  readonly sourceTurnId: string;
  readonly sourceRunId: string;
  readonly parentPurposeId: string | null;
  readonly expectedParentVersion: number | null;
  readonly status: "pending" | "accepted" | "rejected";
  readonly version: number;
  readonly acceptedTargetId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isProposalView(value: unknown): value is ProposalView {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.scope === "string" &&
    (value.target === "purpose" || value.target === "task") &&
    typeof value.draftKind === "string" &&
    (value.purposeKind === null || typeof value.purposeKind === "string") &&
    (value.taskKind === null || typeof value.taskKind === "string") &&
    typeof value.sourceQuote === "string" &&
    typeof value.interpretation === "string" &&
    value.sourceKind === "model" &&
    typeof value.sourceTurnId === "string" &&
    typeof value.sourceRunId === "string" &&
    (value.parentPurposeId === null ||
      typeof value.parentPurposeId === "string") &&
    (value.expectedParentVersion === null ||
      typeof value.expectedParentVersion === "number") &&
    (value.status === "pending" ||
      value.status === "accepted" ||
      value.status === "rejected") &&
    typeof value.version === "number" &&
    (value.acceptedTargetId === null ||
      typeof value.acceptedTargetId === "string") &&
    typeof value.createdAt === "number" &&
    typeof value.updatedAt === "number"
  );
}

export function readItems(body: unknown): ProposalView[] {
  if (!isRecord(body)) return [];
  const items = body.items;
  if (!Array.isArray(items)) return [];
  return items.filter(isProposalView);
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

/** ALL owned pending drafts (never page-limited); -1 when unknown. */
export function readPendingCount(body: unknown): number {
  if (!isRecord(body)) return -1;
  return typeof body.pendingCount === "number" &&
    Number.isInteger(body.pendingCount) &&
    body.pendingCount >= 0
    ? body.pendingCount
    : -1;
}

export const DRAFT_KIND_TEXT: Record<string, string> = {
  casual: "雑談",
  wish: "希望",
  problem: "課題",
  task: "作業",
  deadline: "期限",
};

export const STATUS_TEXT: Record<string, string> = {
  pending: "未採用",
  accepted: "採用済み",
  rejected: "見送り",
};

export function textOf(map: Record<string, string>, key: string): string {
  return map[key] ?? key;
}
