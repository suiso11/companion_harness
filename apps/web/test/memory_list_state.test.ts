// List-view browse/search decisions (pure, no DOM).
import { describe, expect, test } from "vitest";
import {
  browseFailure,
  browseStatusText,
  listModeForQuery,
} from "../src/lib/memory_list_state.js";

describe("listModeForQuery", () => {
  test("a non-empty query switches to search mode", () => {
    expect(listModeForQuery("coffee")).toBe("search");
    expect(listModeForQuery("  記憶  ")).toBe("search");
  });

  test("an empty or whitespace-only query returns to browse", () => {
    expect(listModeForQuery("")).toBe("browse");
    expect(listModeForQuery("   ")).toBe("browse");
  });
});

describe("browseFailure", () => {
  test("accepts a successful status regardless of an error code", () => {
    expect(browseFailure(200, undefined)).toBeNull();
    expect(browseFailure(200, "memory_unavailable")).toBeNull();
  });

  test("maps a disabled memory backend to disabled", () => {
    expect(browseFailure(404, "memory_unavailable")).toBe("disabled");
  });

  test("maps the legacy graph endpoint gap to graph_unavailable", () => {
    expect(browseFailure(503, "memory_graph_unavailable")).toBe(
      "graph_unavailable",
    );
  });

  test("treats every other failure as a generic error", () => {
    expect(browseFailure(404, "not_found")).toBe("error");
    expect(browseFailure(503, undefined)).toBe("error");
    expect(browseFailure(0, undefined)).toBe("error");
  });
});

describe("browseStatusText", () => {
  test("reports an empty projection", () => {
    expect(browseStatusText(0, false)).toBe("記憶がありません");
    expect(browseStatusText(0, true)).toBe("記憶がありません");
  });

  test("reports truncation", () => {
    expect(browseStatusText(3, true)).toBe("一部のみ表示（上限）");
  });

  test("stays quiet for a complete non-empty projection", () => {
    expect(browseStatusText(3, false)).toBe("");
  });
});
