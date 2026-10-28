// Structural mapping for the read-only retained-candidate endpoint. The
// server sends a bounded plain-text unified diff; this module only narrows
// the shape and supplies Japanese labels. It never turns diff text into HTML.
export interface TrialCandidateChange {
  readonly path: string;
  readonly kind: "create" | "modify" | "delete";
  readonly size: number;
  readonly modeChanged: boolean;
}

export interface TrialCandidateView {
  readonly changes: readonly TrialCandidateChange[];
  readonly diff: string;
  readonly truncated: boolean;
}

export type TrialCandidateErrorCode =
  | "candidate_unavailable"
  | "candidate_digest_mismatch"
  | "base_mismatch";

export type TrialCandidateResponse =
  | { readonly available: true; readonly view: TrialCandidateView }
  | { readonly available: false; readonly code: TrialCandidateErrorCode };

const CODES = new Set([
  "candidate_unavailable",
  "candidate_digest_mismatch",
  "base_mismatch",
]);

/** Narrow the candidate GET body; malformed bodies become unavailable. */
export function readTrialCandidate(value: unknown): TrialCandidateResponse {
  if (typeof value !== "object" || value === null) {
    return { available: false, code: "candidate_unavailable" };
  }
  const record = value as Record<string, unknown>;
  if (record.available === false) {
    const code =
      typeof record.code === "string" && CODES.has(record.code)
        ? (record.code as TrialCandidateErrorCode)
        : "candidate_unavailable";
    return { available: false, code };
  }
  if (
    record.available !== true ||
    !Array.isArray(record.changes) ||
    typeof record.diff !== "string" ||
    typeof record.truncated !== "boolean"
  ) {
    return { available: false, code: "candidate_unavailable" };
  }
  const changes: TrialCandidateChange[] = [];
  for (const raw of record.changes) {
    if (typeof raw !== "object" || raw === null) continue;
    const item = raw as Record<string, unknown>;
    if (
      typeof item.path !== "string" ||
      (item.kind !== "create" &&
        item.kind !== "modify" &&
        item.kind !== "delete") ||
      typeof item.size !== "number" ||
      !Number.isInteger(item.size) ||
      item.size < 0 ||
      typeof item.modeChanged !== "boolean"
    ) {
      continue;
    }
    changes.push({
      // Preserve the server-validated identity: shortening here could map
      // distinct nested paths to the same key in the candidate list.
      path: item.path,
      kind: item.kind,
      size: item.size,
      modeChanged: item.modeChanged,
    });
  }
  return {
    available: true,
    view: {
      changes,
      diff: record.diff.slice(0, 64 * 1024),
      truncated: record.truncated,
    },
  };
}

export function trialCandidateErrorText(code: TrialCandidateErrorCode): string {
  switch (code) {
    case "candidate_digest_mismatch":
      return "候補ファイルの検証に失敗しました";
    case "base_mismatch":
      return "基準リビジョンとの照合に失敗しました";
    case "candidate_unavailable":
      return "候補ファイルは保持されていません";
  }
}

export function candidateChangeNote(change: TrialCandidateChange): string {
  const kind =
    change.kind === "create"
      ? "追加"
      : change.kind === "modify"
        ? "変更"
        : "削除";
  return change.modeChanged ? `${kind}・モード変更` : kind;
}
