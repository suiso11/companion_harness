// PR-4 unit tests: provisional draft pure logic (no DOM, no Svelte).
import { describe, expect, test } from "vitest";
import {
  appendDraftText,
  DRAFT_LABEL,
  draftDisplayText,
  initDraftText,
  MAX_DRAFT_CHARS,
} from "../src/lib/draft.js";

describe("initDraftText", () => {
  test("starts a draft from a valid piece", () => {
    const state = initDraftText(1, "hello");
    expect(state).toEqual({ step: 1, text: "hello", truncated: false });
  });

  test("rejects invalid steps and texts", () => {
    expect(initDraftText(0, "x")).toBeNull();
    expect(initDraftText(1.5, "x")).toBeNull();
    expect(initDraftText("1", "x")).toBeNull();
    expect(initDraftText(1, "")).toBeNull();
    expect(initDraftText(1, null)).toBeNull();
    expect(initDraftText(1, 42)).toBeNull();
  });

  test("bounds over-long pieces and marks truncation", () => {
    const state = initDraftText(1, "a".repeat(MAX_DRAFT_CHARS + 10));
    expect(state?.text.length).toBe(MAX_DRAFT_CHARS);
    expect(state?.truncated).toBe(true);
    expect(draftDisplayText(state)).toContain("（以下省略）");
  });

  test("label marks the bubble as unvalidated", () => {
    expect(DRAFT_LABEL).toContain("下書き");
    expect(DRAFT_LABEL).toContain("検証前");
  });
});

describe("appendDraftText", () => {
  test("accumulates same-step pieces as plain text", () => {
    const first = initDraftText(1, "こんにちは");
    const next = appendDraftText(first, { step: 1, text: "世界" });
    expect(next?.text).toBe("こんにちは世界");
    expect(next?.truncated).toBe(false);
  });

  test("a new step restarts instead of appending", () => {
    const first = initDraftText(1, "first-piece ");
    const next = appendDraftText(first, { step: 2, text: "second-step " });
    expect(next?.step).toBe(2);
    expect(next?.text).toBe("second-step ");
    expect(next?.text).not.toContain("first-piece");
  });

  test("null draft starts from the first valid piece", () => {
    const next = appendDraftText(null, { step: 3, text: "hello" });
    expect(next).toEqual({ step: 3, text: "hello", truncated: false });
  });

  test("invalid pieces leave the state unchanged", () => {
    const first = initDraftText(1, "keep");
    expect(appendDraftText(first, null)).toBe(first);
    expect(appendDraftText(first, { step: 1, text: "" })).toBe(first);
    expect(appendDraftText(first, { step: 0, text: "x" })).toBe(first);
    expect(appendDraftText(first, { step: 1 })).toBe(first);
    expect(appendDraftText(null, { step: 0, text: "x" })).toBeNull();
  });

  test("bounds the shown length and marks truncation", () => {
    const first = initDraftText(1, "a".repeat(MAX_DRAFT_CHARS - 5));
    const next = appendDraftText(first, { step: 1, text: "b".repeat(10) });
    expect(next?.text.length).toBe(MAX_DRAFT_CHARS);
    expect(next?.truncated).toBe(true);
  });

  test("markup and citation markers stay inert plain text", () => {
    const next = appendDraftText(
      appendDraftText(null, {
        step: 1,
        text: '<a href="https://x">link</a> [r1] ',
      }),
      { step: 1, text: "<b>bold</b> [m1]" },
    );
    expect(next?.text).toBe(
      '<a href="https://x">link</a> [r1] <b>bold</b> [m1]',
    );
    expect(draftDisplayText(next)).toBe(next?.text ?? "");
  });

  test("empty draft displays nothing", () => {
    expect(draftDisplayText(null)).toBe("");
  });
});
