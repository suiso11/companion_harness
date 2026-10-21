// PR #116 review: retained graph view state, separated from the canvas
// lifecycle. The canvas itself is mounted/unmounted only with the graph
// container; search and selection changes repaint the existing instance.
//
// A successful graph read is retained across list <-> graph switches (cheap
// rehydration), but every acked memory mutation invalidates it: the next
// graph view refetches instead of showing retired/corrected nodes. The
// server-side `graph.version` cache keeps that refetch cheap.

export type MemoryView = "list" | "graph";

export interface GraphRetention {
  /** A successful graph payload is available for rehydration. */
  readonly loaded: boolean;
  /** The retained payload was invalidated by an acked mutation. */
  readonly stale: boolean;
}

export type GraphShowAction = "paint" | "refetch";

export function initialGraphRetention(): GraphRetention {
  return { loaded: false, stale: false };
}

/** Record a successful graph read (fresh server snapshot). */
export function retainLoadedGraph(): GraphRetention {
  return { loaded: true, stale: false };
}

/** What showing the graph view needs to do with the retained payload. */
export function graphShowAction(retention: GraphRetention): GraphShowAction {
  if (!retention.loaded || retention.stale) return "refetch";
  return "paint";
}

export interface GraphInvalidation {
  readonly retention: GraphRetention;
  /** Refetch now because the stale graph is currently visible. */
  readonly refetchNow: boolean;
}

/**
 * Invalidate the retained graph after an acked mutation. The replacement
 * fetch is deferred until the graph view is shown, unless it is visible
 * already (then it must refetch immediately).
 */
export function invalidateAfterMutation(
  retention: GraphRetention,
  view: MemoryView,
): GraphInvalidation {
  return {
    retention: { loaded: retention.loaded, stale: true },
    refetchNow: view === "graph" && retention.loaded,
  };
}
