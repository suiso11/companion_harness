import { describe, expect, it } from "vitest";
import {
  extractLatestAnswer,
  mouthOpen,
  newestSessionId,
} from "../src/lib/character.js";

function v2(
  canonical: string[],
  voiced?: string[],
): Record<string, unknown> {
  return {
    version: 2,
    text: canonical.join("\n\n"),
    answer: {
      version: 1,
      parts: canonical.map((text) => ({ text, citations: [] })),
    },
    ...(voiced === undefined
      ? {}
      : {
          voice: {
            status: "rendered",
            profileId: "shunkin",
            profileVersion: "12-abcdefabcdef",
            parts: voiced.map((text) => ({ text })),
          },
        }),
  };
}

describe("mouthOpen", () => {
  it("clamps and curves the level", () => {
    expect(mouthOpen(0)).toBe(0);
    expect(mouthOpen(1)).toBe(1);
    expect(mouthOpen(0.25)).toBeCloseTo(0.5, 5);
    expect(mouthOpen(-1)).toBe(0);
    expect(mouthOpen(4)).toBe(1);
    expect(mouthOpen(Number.NaN)).toBe(0);
  });
});

describe("newestSessionId", () => {
  it("reads the first session id", () => {
    expect(
      newestSessionId({ sessions: [{ id: "abc", title: "t" }] }),
    ).toBe("abc");
  });
  it("returns null for an empty or malformed list", () => {
    expect(newestSessionId({ sessions: [] })).toBeNull();
    expect(newestSessionId({})).toBeNull();
    expect(newestSessionId(null)).toBeNull();
  });
});

describe("extractLatestAnswer", () => {
  it("prefers the exactly aligned voiced projection", () => {
    const body = {
      items: [
        {
          turnId: "t1",
          selectedRun: {
            runId: "r1",
            result: v2(["予定を確認しました。"], ["予定、確かめたとこどす。"]),
          },
        },
      ],
    };
    expect(extractLatestAnswer(body)).toEqual({
      runId: "r1",
      text: "予定、確かめたとこどす。",
    });
  });

  it("falls back to the canonical text when the voice is not rendered", () => {
    const body = {
      items: [
        {
          turnId: "t1",
          selectedRun: { runId: "r1", result: v2(["予定を確認しました。"]) },
        },
      ],
    };
    expect(extractLatestAnswer(body)).toEqual({
      runId: "r1",
      text: "予定を確認しました。",
    });
  });

  it("skips turns without a selected run", () => {
    const body = {
      items: [
        { turnId: "t1", selectedRun: null },
        {
          turnId: "t2",
          selectedRun: { runId: "r2", result: v2(["東京は晴れです。"]) },
        },
      ],
    };
    expect(extractLatestAnswer(body)?.runId).toBe("r2");
  });

  it("returns null when there is no text", () => {
    expect(extractLatestAnswer({ items: [] })).toBeNull();
    expect(
      extractLatestAnswer({
        items: [{ selectedRun: { runId: "r1", result: v2([" "]) } }],
      }),
    ).toBeNull();
  });
});
