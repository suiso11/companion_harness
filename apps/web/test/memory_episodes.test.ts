// Episodic selection parsing (pure, no DOM).
import { describe, expect, test } from "vitest";
import {
  formatEpisodePeriod,
  parseEpisodePage,
  parseEpisodeWindowsPage,
} from "../src/lib/memory_episodes.js";

function episode(overrides: Record<string, unknown> = {}) {
  return {
    episodeKey: "session-1",
    startAt: "2026-11-17T10:00:00.000Z",
    endAt: "2026-11-17T11:30:00.000Z",
    eventCount: 3,
    summarySnippet: "coffee and a walk",
    summaryTruncated: false,
    stale: false,
    ...overrides,
  };
}

function windowRow(overrides: Record<string, unknown> = {}) {
  return {
    spanStart: 0,
    spanEnd: 12,
    snippet: "first window",
    truncated: false,
    ...overrides,
  };
}

describe("parseEpisodePage", () => {
  test("accepts a complete page and carries the cursor", () => {
    const page = parseEpisodePage({
      items: [episode(), episode({ episodeKey: "session-2", stale: true })],
      nextCursor: "cursor-2",
    });
    expect(page).not.toBeNull();
    expect(page?.items).toHaveLength(2);
    expect(page?.items[1]?.episodeKey).toBe("session-2");
    expect(page?.items[1]?.stale).toBe(true);
    expect(page?.nextCursor).toBe("cursor-2");
  });

  test("accepts a null cursor as the end of the list", () => {
    const page = parseEpisodePage({ items: [], nextCursor: null });
    expect(page).toEqual({ items: [], nextCursor: null });
  });

  test("drops a row with an unexpected field instead of ignoring it", () => {
    const page = parseEpisodePage({
      items: [episode(), episode({ id: "raw-record-id" })],
      nextCursor: null,
    });
    expect(page?.items).toHaveLength(1);
    expect(page?.items[0]?.episodeKey).toBe("session-1");
  });

  test("drops rows whose known fields have the wrong type", () => {
    const page = parseEpisodePage({
      items: [
        episode({ eventCount: "3" }),
        episode({ summaryTruncated: "false" }),
        episode({ episodeKey: "" }),
        episode({ startAt: "short" }),
        episode({ summarySnippet: 42 }),
      ],
      nextCursor: null,
    });
    expect(page?.items).toEqual([]);
  });

  test("rejects a malformed envelope", () => {
    expect(parseEpisodePage(null)).toBeNull();
    expect(parseEpisodePage({ items: [] })).toBeNull();
    expect(parseEpisodePage({ items: {}, nextCursor: null })).toBeNull();
    expect(parseEpisodePage({ items: [], nextCursor: 2 })).toBeNull();
    expect(parseEpisodePage({ items: [], nextCursor: "" })).toBeNull();
    expect(
      parseEpisodePage({ items: [], nextCursor: null, extra: true }),
    ).toBeNull();
  });
});

describe("parseEpisodeWindowsPage", () => {
  test("accepts a complete page and carries the cursor", () => {
    const page = parseEpisodeWindowsPage({
      items: [windowRow(), windowRow({ spanStart: 12, spanEnd: 20 })],
      nextCursor: "windows-2",
    });
    expect(page?.items).toHaveLength(2);
    expect(page?.items[1]).toEqual({
      spanStart: 12,
      spanEnd: 20,
      snippet: "first window",
      truncated: false,
    });
    expect(page?.nextCursor).toBe("windows-2");
  });

  test("drops a window with an unexpected field", () => {
    const page = parseEpisodeWindowsPage({
      items: [windowRow({ id: "raw-event-id" }), windowRow()],
      nextCursor: null,
    });
    expect(page?.items).toHaveLength(1);
  });

  test("drops windows with non-integer or negative spans", () => {
    const page = parseEpisodeWindowsPage({
      items: [
        windowRow({ spanStart: -1 }),
        windowRow({ spanEnd: 1.5 }),
        windowRow({ truncated: "no" }),
      ],
      nextCursor: null,
    });
    expect(page?.items).toEqual([]);
  });

  test("rejects a malformed envelope", () => {
    expect(parseEpisodeWindowsPage(undefined)).toBeNull();
    expect(parseEpisodeWindowsPage({ items: [] })).toBeNull();
    expect(
      parseEpisodeWindowsPage({ items: [], nextCursor: false }),
    ).toBeNull();
  });
});

describe("formatEpisodePeriod", () => {
  test("formats a valid ISO period in local time", () => {
    expect(
      formatEpisodePeriod(
        "2026-11-17T10:00:00.000Z",
        "2026-11-17T11:30:00.000Z",
      ),
    ).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} – \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/,
    );
  });

  test("falls back when either instant is invalid", () => {
    expect(formatEpisodePeriod("not-a-date", "2026-11-17T11:30:00.000Z")).toBe(
      "期間不明",
    );
    expect(formatEpisodePeriod("2026-11-17T10:00:00.000Z", "")).toBe(
      "期間不明",
    );
  });
});
