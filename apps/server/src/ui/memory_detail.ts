// Confirmation-detail text for one memory handle (legacy + Svelte panels).
//
// The immutable cited snapshot stays DISTINCT from the CURRENT record. A
// persistable user quote (remind#41 `evidence`) is display-only metadata on
// the current record: it is shown as 元の発言 only when it is a non-empty
// string, and it never replaces the memory body or the snapshot text.

import { formatRecordedAt } from "./graph.js";

export interface MemoryDetailSnapshotView {
  readonly handle: string;
  readonly snippet: string;
  readonly status: "active" | "retired";
}

export interface MemoryDetailCurrentView {
  readonly body: string;
  readonly kind: string;
  readonly status: string;
  readonly revision: number;
  readonly source: string;
  readonly createdAt: string;
  readonly evidence?: string | null;
}

export interface MemoryDetailView {
  readonly snapshot: MemoryDetailSnapshotView;
  readonly current: MemoryDetailCurrentView;
  readonly stale: boolean;
}

/** Bounded, display-only quote line; null when there is nothing to show. */
export function memoryEvidenceLine(
  evidence: string | null | undefined,
): string | null {
  if (typeof evidence !== "string") return null;
  const text = evidence.trim();
  return text.length === 0 ? null : `元の発言:「${text}」`;
}

/** Deterministic plain-text detail body (rendered via textContent). */
export function formatMemoryDetailText(view: MemoryDetailView): string {
  const recordedAt = formatRecordedAt(view.current.createdAt);
  const evidence = memoryEvidenceLine(view.current.evidence);
  return (
    `引用スナップショット ${view.snapshot.handle} [${view.snapshot.status}]\n${view.snapshot.snippet}\n---\n` +
    (recordedAt === null ? "" : `記録日時: ${recordedAt}\n`) +
    `現在 [${view.current.status} rev.${view.current.revision} ${view.current.kind} ${view.current.source}]\n${view.current.body}` +
    (evidence === null ? "" : `\n${evidence}`) +
    (view.stale ? "\n---\n状態が変わっています。再検索してください" : "")
  );
}
