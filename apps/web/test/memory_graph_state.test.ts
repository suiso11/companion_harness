// PR #116 review: retained graph invalidation decisions (pure, no DOM).
import { describe, expect, test } from "vitest";
import {
  graphShowAction,
  initialGraphRetention,
  invalidateAfterMutation,
  type MemoryView,
  retainLoadedGraph,
} from "../src/lib/memory_graph_state.js";

describe("graphShowAction", () => {
  test("refetches when no graph was retained", () => {
    expect(graphShowAction(initialGraphRetention())).toBe("refetch");
  });

  test("paints a retained, fresh graph without a request", () => {
    expect(graphShowAction(retainLoadedGraph())).toBe("paint");
  });

  test("refetches a retained graph after invalidation", () => {
    const { retention } = invalidateAfterMutation(retainLoadedGraph(), "list");
    expect(retention.stale).toBe(true);
    expect(graphShowAction(retention)).toBe("refetch");
  });
});

describe("invalidateAfterMutation", () => {
  const views: MemoryView[] = ["list", "graph"];

  test("marks the retained graph stale for mutations from either view", () => {
    for (const view of views) {
      const { retention } = invalidateAfterMutation(retainLoadedGraph(), view);
      expect(retention).toEqual({ loaded: true, stale: true });
    }
  });

  test("defers the refetch while the list view is shown", () => {
    const { refetchNow } = invalidateAfterMutation(retainLoadedGraph(), "list");
    expect(refetchNow).toBe(false);
  });

  test("refetches immediately while the graph view is visible", () => {
    const { refetchNow } = invalidateAfterMutation(
      retainLoadedGraph(),
      "graph",
    );
    expect(refetchNow).toBe(true);
  });

  test("does not refetch a graph that was never loaded", () => {
    const initial = initialGraphRetention();
    const { retention, refetchNow } = invalidateAfterMutation(initial, "graph");
    expect(retention).toEqual({ loaded: false, stale: true });
    expect(refetchNow).toBe(false);
  });

  test("a fresh load replaces the stale retention", () => {
    const stale = invalidateAfterMutation(
      retainLoadedGraph(),
      "list",
    ).retention;
    expect(stale.stale).toBe(true);
    const fresh = retainLoadedGraph();
    expect(fresh).toEqual({ loaded: true, stale: false });
    expect(graphShowAction(fresh)).toBe("paint");
  });
});
