// List-view decisions for the Svelte memory panel.
//
// The list is a full-memory browse by default; a submitted query switches it
// to explicit search results until 「すべて表示」 (or an empty query) returns
// to browse. Browse reads the global graph projection, so the legacy
// graph-unavailable fallback still leaves explicit search usable.

export type MemoryListMode = "browse" | "search";

/** A submitted query switches to search; an empty one returns to browse. */
export function listModeForQuery(query: string): MemoryListMode {
  return query.trim().length === 0 ? "browse" : "search";
}

export type BrowseFailure = "disabled" | "graph_unavailable" | "error";

/**
 * Classify a failed browse read. `null` means the response status itself is
 * acceptable; the caller still has to validate the payload structure.
 */
export function browseFailure(
  status: number,
  code: string | undefined,
): BrowseFailure | null {
  if (status === 200) return null;
  if (status === 404 && code === "memory_unavailable") return "disabled";
  if (status === 503 && code === "memory_graph_unavailable") {
    return "graph_unavailable";
  }
  return "error";
}

/** Browse status line; an empty string means "show no notice". */
export function browseStatusText(
  nodeCount: number,
  truncated: boolean,
): string {
  if (nodeCount === 0) return "記憶がありません";
  if (truncated) return "一部のみ表示（上限）";
  return "";
}
