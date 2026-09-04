import { describe, expect, it } from "vitest";
import {
  containsFolded,
  countCodePointsLocal,
  equalsFolded,
  findFirstHit,
  foldQuery,
  makeSnippet,
  normalizeNFC,
  SNIPPET_CONTEXT_BEFORE,
  SNIPPET_MAX_CODE_POINTS,
  sliceCodePoints,
} from "../src/text.js";

describe("text primitives", () => {
  it("normalizes to NFC", () => {
    expect(normalizeNFC("é")).toBe("é");
    expect(normalizeNFC("é")).toBe("é");
  });

  it("folds case locale-independently per code point", () => {
    expect(foldQuery("HeLLo")).toBe("hello");
    expect(foldQuery("é")).toBe("é");
    // Astral characters survive folding intact.
    expect(foldQuery("😀A")).toBe("😀a");
  });

  it("matches whole-query literals, never regex", () => {
    expect(containsFolded("a+b (c) .*?", "a+b (c) .*?")).toBe(true);
    expect(containsFolded("abc", ".*")).toBe(false);
    expect(containsFolded("abc", "b")).toBe(true);
    expect(containsFolded("ABC", "abc")).toBe(true);
    expect(equalsFolded("Hello", "hello")).toBe(true);
    expect(equalsFolded("Hello world", "hello")).toBe(false);
    expect(containsFolded("anything", "")).toBe(false);
    expect(equalsFolded("a", "")).toBe(false);
  });

  it("maps hits to source code-point indices (astral-safe)", () => {
    expect(countCodePointsLocal("😀")).toBe(1);
    expect(sliceCodePoints("a😀b😀c", 1, 3)).toBe("😀b");
    const hit = findFirstHit("😀a😀b", "b");
    expect(hit).toEqual({ codePointIndex: 3, codePointLength: 1 });
    expect(findFirstHit("ABC", "bc")).toEqual({
      codePointIndex: 1,
      codePointLength: 2,
    });
    expect(findFirstHit("abc", "z")).toBeNull();
    expect(findFirstHit("abc", "")).toBeNull();
  });

  it("builds max-512 snippets containing the first body hit", () => {
    expect(SNIPPET_MAX_CODE_POINTS).toBe(512);
    expect(SNIPPET_CONTEXT_BEFORE).toBeLessThan(512);
    const body = `${"x".repeat(600)}TARGET${"y".repeat(600)}`;
    const snippet = makeSnippet(body, "target");
    expect(countCodePointsLocal(snippet)).toBeLessThanOrEqual(512);
    expect(snippet.toLowerCase()).toContain("target");
    // First hit wins and leading context is bounded.
    const first = snippet.indexOf("TARGET");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThanOrEqual(SNIPPET_CONTEXT_BEFORE + 1);
  });

  it("handles astral prefix with long body deterministically", () => {
    const prefix = "😀".repeat(400);
    const body = `${prefix}HIT${"z".repeat(400)}`;
    const snippet = makeSnippet(body, "hit");
    expect(countCodePointsLocal(snippet)).toBeLessThanOrEqual(512);
    expect(snippet).toContain("HIT");
    expect(makeSnippet(body, "hit")).toBe(snippet);
  });

  it("returns a leading prefix when there is no hit", () => {
    const body = `${"q".repeat(600)}tail`;
    expect(makeSnippet(body, "missing")).toBe("q".repeat(512));
    expect(makeSnippet("short", "missing")).toBe("short");
  });

  it("never uses locale-sensitive APIs", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const here = fileURLToPath(new URL("./", import.meta.url));
    const sources = ["text.ts", "markdown.ts", "roots.ts", "errors.ts"].map(
      (name) => readFile(`${here}../src/${name}`, "utf8"),
    );
    const contents = (await Promise.all(sources)).join("\n");
    // Doc comments may name the banned APIs; enforce absence of call sites.
    expect(contents).not.toContain("toLocaleLowerCase(");
    expect(contents).not.toContain("toLocaleUpperCase(");
    expect(contents).not.toContain("localeCompare(");
  });
});
