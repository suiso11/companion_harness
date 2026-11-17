// Diary parsers, calendar helpers and `/diary/<day>` route resolution
// (pure, no DOM).
import { describe, expect, it } from "vitest";
import {
  diarySnippet,
  formatDiaryDay,
  formatMonth,
  monthCells,
  parseDiaryEntryResponse,
  parseDiaryResponse,
  shiftMonth,
} from "../src/lib/diary.js";
import { routeForPath } from "../src/lib/router.js";

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

describe("parseDiaryEntryResponse", () => {
  it("accepts an entry and an explicit null", () => {
    expect(parseDiaryEntryResponse({ entry })).toEqual(entry);
    expect(parseDiaryEntryResponse({ entry: null })).toBeNull();
  });

  it("returns undefined for invalid shapes", () => {
    expect(parseDiaryEntryResponse(null)).toBeUndefined();
    expect(parseDiaryEntryResponse({})).toBeUndefined();
    expect(parseDiaryEntryResponse({ entry: "x" })).toBeUndefined();
    expect(
      parseDiaryEntryResponse({ entry: { ...entry, day: "2026-02-30" } }),
    ).toBeUndefined();
    expect(
      parseDiaryEntryResponse({ entry: { ...entry, body: "" } }),
    ).toBeUndefined();
    expect(
      parseDiaryEntryResponse({ entry: { ...entry, body: "あ".repeat(2001) } }),
    ).toBeUndefined();
  });
});

describe("monthCells", () => {
  it("starts on Sunday with no leading blanks (2026-11)", () => {
    const cells = monthCells("2026-11");
    expect(cells[0]).toBe("2026-11-01");
    expect(cells.filter((c) => c !== null)).toHaveLength(30);
    expect(cells).toHaveLength(35);
    expect(cells.slice(30)).toEqual([null, null, null, null, null]);
  });

  it("pads one blank before a Monday start (2026-06)", () => {
    const cells = monthCells("2026-06");
    expect(cells[0]).toBeNull();
    expect(cells[1]).toBe("2026-06-01");
    expect(cells.filter((c) => c !== null)).toHaveLength(30);
  });

  it("handles February in leap and non-leap years", () => {
    const plain = monthCells("2026-02");
    expect(plain.filter((c) => c !== null)).toHaveLength(28);
    expect(plain).toHaveLength(28);
    const leap = monthCells("2024-02");
    expect(leap.filter((c) => c !== null)).toHaveLength(29);
    expect(leap.indexOf("2024-02-01")).toBe(4);
    expect(leap).toContain("2024-02-29");
  });

  it("always yields whole weeks", () => {
    for (let m = 1; m <= 12; m++) {
      const month = `2026-${String(m).padStart(2, "0")}`;
      expect(monthCells(month).length % 7).toBe(0);
    }
    expect(monthCells("nope")).toEqual([]);
  });
});

describe("shiftMonth / formatMonth", () => {
  it("crosses year boundaries", () => {
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-11", 0)).toBe("2026-11");
    expect(shiftMonth("2026-11", -11)).toBe("2025-12");
    expect(shiftMonth("nope", 1)).toBe("nope");
  });

  it("formats a month in Japanese", () => {
    expect(formatMonth("2026-11")).toBe("2026年11月");
    expect(formatMonth("2026-01")).toBe("2026年1月");
    expect(formatMonth("nope")).toBe("nope");
  });
});

describe("diarySnippet", () => {
  it("skips heading lines and strips markup", () => {
    const body =
      "### やったこと\n- **設計**を`整理`した\n> 引用\n### タスク\n- 残り";
    expect(diarySnippet(body)).toBe("設計を整理した 引用 残り");
  });

  it("falls back to heading text for heading-only bodies", () => {
    expect(diarySnippet("# 今日")).toBe("今日");
  });

  it("collapses whitespace and caps at 30 code points", () => {
    expect(diarySnippet("a\n\n  b")).toBe("a b");
    const long = diarySnippet("あ".repeat(40));
    expect(long).toBe(`${"あ".repeat(30)}…`);
    expect(diarySnippet("😀".repeat(30))).toBe("😀".repeat(30));
  });
});

describe("routeForPath diary day", () => {
  it("resolves /diary/<day> with an optional trailing slash", () => {
    expect(routeForPath("/diary/2026-11-16")?.day).toBe("2026-11-16");
    expect(routeForPath("/diary/2026-11-16/")?.day).toBe("2026-11-16");
    expect(routeForPath("/diary/2026-11-16")?.path).toBe("/diary");
    expect(routeForPath("/diary")?.day).toBeUndefined();
  });

  it("rejects impossible days and junk", () => {
    expect(routeForPath("/diary/2026-02-30")).toBeNull();
    expect(routeForPath("/diary/junk")).toBeNull();
    expect(routeForPath("/diary/2026-11-16/x")).toBeNull();
    expect(routeForPath("/diary/2026-11-16//")).toBeNull();
  });
});
