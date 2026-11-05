import { describe, expect, test } from "vitest";
import { previewOf, relativeTime } from "../src/lib/persona_chat.js";

describe("persona chat helpers", () => {
  test("relativeTime buckets", () => {
    const now = 10_000_000_000;
    expect(relativeTime(now, now - 5_000)).toBe("たった今");
    expect(relativeTime(now, now + 5_000)).toBe("たった今");
    expect(relativeTime(now, now - 5 * 60_000)).toBe("5分前");
    expect(relativeTime(now, now - 3 * 3_600_000)).toBe("3時間前");
    expect(relativeTime(now, now - 2 * 86_400_000)).toBe("2日前");
  });

  test("previewOf flattens and truncates by code point", () => {
    expect(previewOf("a\n\n b  c")).toBe("a b c");
    expect(previewOf("😀".repeat(5), 3)).toBe("😀😀😀…");
  });
});
