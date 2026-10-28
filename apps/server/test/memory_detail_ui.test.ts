// Memory detail rendering (legacy + Svelte panels share this formatter):
// the persisted user quote (remind#41) is displayed as 元の発言 only when
// present, without replacing the cited snapshot or current body.

import { describe, expect, it } from "vitest";
import {
  formatMemoryDetailText,
  memoryEvidenceLine,
} from "../src/ui/memory_detail.js";

function view(evidence: string | null | undefined) {
  const current = {
    body: "user likes green tea",
    kind: "user_fact",
    status: "active",
    revision: 2,
    source: "companion:conversation",
    createdAt: "2026-10-28T03:04:05.000Z",
  } as const;
  return {
    snapshot: {
      handle: "m1",
      snippet: "green tea",
      status: "active" as const,
    },
    current: evidence === undefined ? current : { ...current, evidence },
    stale: false,
  };
}

describe("memory detail user evidence", () => {
  it("shows 元の発言 when the quote is present", () => {
    const text = formatMemoryDetailText(view("  I like green tea.  "));
    expect(text).toContain(
      "現在 [active rev.2 user_fact companion:conversation]",
    );
    expect(text).toContain("user likes green tea");
    expect(text).toContain("元の発言:「I like green tea.」");
    // Nothing was substituted: both snapshot and current body remain.
    expect(text).toContain("引用スナップショット m1 [active]\ngreen tea");
  });

  it("omits the line when evidence is absent, null, or blank", () => {
    for (const evidence of [undefined, null, "   "]) {
      const text = formatMemoryDetailText(view(evidence));
      expect(text).not.toContain("元の発言");
      expect(text).toContain("user likes green tea");
    }
    expect(memoryEvidenceLine(null)).toBeNull();
    expect(memoryEvidenceLine(" ")).toBeNull();
  });
});
