import { describe, expect, test } from "vitest";
import {
  activeMemoryCount,
  bubbleText,
  buildCharacterMeters,
  CHARACTER_METER_CAPS,
  countDiaryEntries,
  parseCharacterToday,
  relativeTimeLabel,
  todayLines,
} from "../src/lib/character_status.js";

const TODAY = {
  day: "2026-11-19",
  companionMessages: ["おはようさん"],
  tasks: ["資料を送る"],
  actions: ["予定を確認"],
};

describe("buildCharacterMeters", () => {
  test("orders meters and computes percent", () => {
    expect(
      buildCharacterMeters({ activeMemories: 50, diaryEntries: 3 }),
    ).toEqual([
      { key: "memory", label: "記憶", value: 50, percent: 25 },
      { key: "diary", label: "日記", value: 3, percent: 10 },
    ]);
  });

  test("handles zero, cap and above-cap boundaries", () => {
    const [zero] = buildCharacterMeters({
      activeMemories: 0,
      diaryEntries: null,
    });
    expect(zero?.percent).toBe(0);
    const meters = buildCharacterMeters({
      activeMemories: CHARACTER_METER_CAPS.memory * 5,
      diaryEntries: CHARACTER_METER_CAPS.diary + 1,
    });
    expect(meters.map((m) => m.percent)).toEqual([100, 100]);
  });

  test("omits null inputs", () => {
    expect(
      buildCharacterMeters({ activeMemories: 10, diaryEntries: null }).map(
        (m) => m.key,
      ),
    ).toEqual(["memory"]);
  });

  test("floors and clamps odd values", () => {
    const meters = buildCharacterMeters({
      activeMemories: -4,
      diaryEntries: Number.NaN,
    });
    expect(meters.map((m) => m.value)).toEqual([0, 0]);
  });
});

describe("countDiaryEntries", () => {
  test("counts items", () => {
    expect(countDiaryEntries({ items: [{}, {}] })).toBe(2);
    expect(countDiaryEntries({ items: [] })).toBe(0);
  });

  test("returns null for malformed bodies", () => {
    expect(countDiaryEntries(null)).toBeNull();
    expect(countDiaryEntries({})).toBeNull();
    expect(countDiaryEntries({ items: {} })).toBeNull();
    expect(countDiaryEntries("items")).toBeNull();
  });
});

describe("parseCharacterToday", () => {
  test("parses a valid body", () => {
    expect(parseCharacterToday(TODAY)).toEqual(TODAY);
  });

  test("rejects malformed bodies", () => {
    expect(parseCharacterToday(null)).toBeNull();
    expect(parseCharacterToday([])).toBeNull();
    expect(parseCharacterToday({ ...TODAY, day: "2026-1-19" })).toBeNull();
    expect(parseCharacterToday({ ...TODAY, day: 20261119 })).toBeNull();
    expect(parseCharacterToday({ ...TODAY, tasks: "x" })).toBeNull();
    expect(parseCharacterToday({ ...TODAY, actions: [1] })).toBeNull();
    expect(
      parseCharacterToday({ ...TODAY, companionMessages: ["a\0b"] }),
    ).toBeNull();
    const { tasks: _tasks, ...missing } = TODAY;
    expect(parseCharacterToday(missing)).toBeNull();
  });
});

describe("todayLines", () => {
  test("prefixes and orders lines", () => {
    expect(todayLines(parseCharacterToday(TODAY))).toEqual([
      "声かけ: おはようさん",
      "タスク: 資料を送る",
      "実行: 予定を確認",
    ]);
  });

  test("clips a long activity line to the card width", () => {
    const long = {
      ...TODAY,
      companionMessages: ["あ".repeat(60)],
      tasks: [],
      actions: [],
    };
    expect(todayLines(long)).toEqual([`声かけ: ${"あ".repeat(48)}…`]);
  });

  test("returns nothing for null, skips blanks and caps", () => {
    expect(todayLines(null)).toEqual([]);
    expect(
      todayLines({
        day: "2026-11-19",
        companionMessages: ["  ", "a"],
        tasks: ["", "b", "c"],
        actions: ["d"],
      }),
    ).toEqual(["声かけ: a", "タスク: b", "タスク: c", "実行: d"]);
    const many = { ...TODAY, tasks: ["1", "2", "3", "4", "5", "6", "7"] };
    expect(todayLines(many)).toHaveLength(6);
    expect(todayLines(many, 2)).toEqual(["声かけ: おはようさん", "タスク: 1"]);
  });
});

describe("bubbleText", () => {
  test("collapses whitespace", () => {
    expect(bubbleText("  あ\n\n い\t う  ")).toBe("あ い う");
  });

  test("cuts by code points with an ellipsis", () => {
    expect(bubbleText("abcdef", 3)).toBe("abc…");
    expect(bubbleText("abc", 3)).toBe("abc");
    expect(bubbleText("😀😀😀😀", 2)).toBe("😀😀…");
    expect(bubbleText("x".repeat(61))).toBe(`${"x".repeat(60)}…`);
  });
});

describe("activeMemoryCount", () => {
  test("reads byStatus.active", () => {
    expect(activeMemoryCount({ byStatus: { active: 6 } })).toBe(6);
    expect(activeMemoryCount({ byStatus: { active: 2.9 } })).toBe(2);
  });

  test("returns null for malformed bodies", () => {
    expect(activeMemoryCount(null)).toBeNull();
    expect(activeMemoryCount({ byStatus: null })).toBeNull();
    expect(activeMemoryCount({ byStatus: { active: -1 } })).toBeNull();
    expect(activeMemoryCount({ byStatus: { active: Number.NaN } })).toBeNull();
    expect(activeMemoryCount({ byStatus: {} })).toBeNull();
  });
});

describe("relativeTimeLabel", () => {
  test("rounds to the fixed Japanese buckets", () => {
    const now = 2_000_000_000_000;
    expect(relativeTimeLabel(now, now - 30_000)).toBe("たった今");
    expect(relativeTimeLabel(now, now - 5 * 60_000)).toBe("5分前");
    expect(relativeTimeLabel(now, now - 3 * 3_600_000)).toBe("3時間前");
    expect(relativeTimeLabel(now, now - 2 * 86_400_000)).toBe("2日前");
  });

  test("future timestamps clamp to now", () => {
    expect(relativeTimeLabel(1000, 5000)).toBe("たった今");
  });
});
