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

  test("initial truncation never splits a surrogate pair", () => {
    // A non-BMP character straddles the 4000-code-unit boundary: cutting at
    // MAX would keep only its high surrogate (a replacement char in the
    // bubble). The cut must back off one code unit and drop the pair whole.
    const text = `${"a".repeat(MAX_DRAFT_CHARS - 1)}😀rest`;
    const state = initDraftText(1, text);
    expect(state?.truncated).toBe(true);
    expect(state?.text).not.toMatch(/[\uD800-\uDFFF]/);
    expect(state?.text.length).toBe(MAX_DRAFT_CHARS - 1);
    expect(draftDisplayText(state)).not.toContain("\uFFFD");
  });

  test("appended truncation never splits a surrogate pair", () => {
    const first = initDraftText(1, "a".repeat(MAX_DRAFT_CHARS - 5));
    const next = appendDraftText(first, {
      step: 1,
      text: `${"b".repeat(4)}😀tail`,
    });
    expect(next?.truncated).toBe(true);
    expect(next?.text).not.toMatch(/[\uD800-\uDFFF]/);
    expect(next?.text.length).toBe(MAX_DRAFT_CHARS - 1);
    expect(draftDisplayText(next)).not.toContain("\uFFFD");
  });

  test("a truncated draft stays closed: later pieces never re-open the text", () => {
    const first = initDraftText(1, "a".repeat(MAX_DRAFT_CHARS));
    const next = appendDraftText(first, { step: 1, text: "more" });
    expect(next?.text).toBe(first?.text);
    expect(next?.truncated).toBe(true);
    // Same guarantee after a surrogate back-off cut (length MAX - 1).
    const cut = initDraftText(1, `${"a".repeat(MAX_DRAFT_CHARS - 1)}😀`);
    const reopened = appendDraftText(cut, { step: 1, text: "z" });
    expect(reopened?.text).toBe(cut?.text);
    expect(reopened?.truncated).toBe(true);
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

  test("a step restart drops the previous step's text entirely (no carry-over)", () => {
    // PR78 review: with the server keeping coalescing buffers per step
    // (ba5599a), a piece's step always matches its text — so the client
    // restart must replace the text, never append across the boundary.
    // This holds even when the previous step's draft was truncated.
    const first = initDraftText(1, "a".repeat(MAX_DRAFT_CHARS + 10));
    expect(first?.truncated).toBe(true);
    const next = appendDraftText(first, { step: 2, text: "second" });
    expect(next).toEqual({ step: 2, text: "second", truncated: false });
    expect(next?.text).not.toContain("a");
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
