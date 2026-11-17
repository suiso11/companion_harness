// Parser for `GET /api/diary`: strict item validation + day formatting used
// by DiaryPanel (pure, no DOM).
import { describe, expect, it } from "vitest";
import { formatDiaryDay, parseDiaryResponse } from "../src/lib/diary.js";

const entry = {
  day: "2026-11-16",
  body: "# 今日\n\n良い一日だった。",
  createdAt: 1_763_000_000_000,
};

describe("parseDiaryResponse", () => {
  it("accepts a valid payload", () => {
    expect(parseDiaryResponse({ items: [entry] })).toEqual([entry]);
    expect(parseDiaryResponse({ items: [] })).toEqual([]);
  });

  it("rejects unknown or invalid shapes", () => {
    expect(parseDiaryResponse(null)).toBeNull();
    expect(parseDiaryResponse("items")).toBeNull();
    expect(parseDiaryResponse({})).toBeNull();
    expect(parseDiaryResponse({ items: "nope" })).toBeNull();
    expect(parseDiaryResponse({ items: [null] })).toBeNull();
    expect(
      parseDiaryResponse({ items: [{ ...entry, day: 20261116 }] }),
    ).toBeNull();
    expect(
      parseDiaryResponse({ items: [{ ...entry, body: null }] }),
    ).toBeNull();
    expect(parseDiaryResponse({ items: [{ ...entry, body: "" }] })).toBeNull();
    expect(
      parseDiaryResponse({ items: [{ ...entry, createdAt: -1 }] }),
    ).toBeNull();
    expect(
      parseDiaryResponse({ items: [{ ...entry, createdAt: 1.5 }] }),
    ).toBeNull();
    expect(
      parseDiaryResponse({ items: [{ ...entry, createdAt: "1" }] }),
    ).toBeNull();
  });

  it("rejects impossible calendar days", () => {
    expect(
      parseDiaryResponse({ items: [{ ...entry, day: "2026-02-30" }] }),
    ).toBeNull();
    expect(
      parseDiaryResponse({ items: [{ ...entry, day: "2026-13-01" }] }),
    ).toBeNull();
    expect(
      parseDiaryResponse({ items: [{ ...entry, day: "2026-11-1" }] }),
    ).toBeNull();
    expect(
      parseDiaryResponse({ items: [{ ...entry, day: "2024-02-29" }] }),
    ).toEqual([{ ...entry, day: "2024-02-29" }]);
  });

  it("bounds the body in code points", () => {
    const max = "あ".repeat(2000);
    expect(
      parseDiaryResponse({ items: [{ ...entry, body: max }] }),
    ).toHaveLength(1);
    expect(
      parseDiaryResponse({ items: [{ ...entry, body: "あ".repeat(2001) }] }),
    ).toBeNull();
    // Surrogate pairs count once: 2000 emoji is exactly the limit.
    const emoji = "😀".repeat(2000);
    expect(
      parseDiaryResponse({ items: [{ ...entry, body: emoji }] }),
    ).toHaveLength(1);
    expect(
      parseDiaryResponse({ items: [{ ...entry, body: "😀".repeat(2001) }] }),
    ).toBeNull();
  });

  it("rejects more than 100 items", () => {
    const many = Array.from({ length: 100 }, () => entry);
    expect(parseDiaryResponse({ items: many })).toHaveLength(100);
    expect(parseDiaryResponse({ items: [...many, entry] })).toBeNull();
  });

  it("invalidates the whole response on one bad item", () => {
    expect(
      parseDiaryResponse({ items: [entry, { ...entry, day: "nope" }] }),
    ).toBeNull();
  });
});

describe("formatDiaryDay", () => {
  it("formats a calendar day in Japanese", () => {
    expect(formatDiaryDay("2026-11-16")).toBe("2026年11月16日");
    expect(formatDiaryDay("2026-01-05")).toBe("2026年1月5日");
  });

  it("passes unknown values through", () => {
    expect(formatDiaryDay("nope")).toBe("nope");
  });
});
