import { describe, expect, it } from "vitest";
import {
  extractWikiCandidatesWithStats,
  parseMarkdown,
} from "../src/markdown.js";

describe("markdown parsing", () => {
  it("extracts the first heading as plain text", () => {
    expect(parseMarkdown("# Hello *world*").title).toBe("Hello world");
    expect(parseMarkdown("no headings here").title).toBeNull();
    expect(parseMarkdown("#   ").title).toBeNull();
    const parsed = parseMarkdown("# First\n\n## Second\n");
    expect(parsed.title).toBe("First");
  });

  it("honors only the first heading even when it is blank", () => {
    expect(parseMarkdown("#   \n\n## Second\n").title).toBeNull();
    expect(parseMarkdown("# First\n\n## Second\n").title).toBe("First");
    expect(parseMarkdown("no headings here").title).toBeNull();
  });

  it("accepts only standard relative .md links", () => {
    const parsed = parseMarkdown(
      "[a](./note.md) [b](../up/other.md#frag) " +
        "[ext](https://example.com/note.md) [abs](/root.md) " +
        "[frag](#section) [txt](./note.txt) [win](..\\note.md)",
    );
    expect(parsed.standardLinks).toEqual([
      { rawUrl: "./note.md", path: "./note.md", fragment: null },
      {
        rawUrl: "../up/other.md#frag",
        path: "../up/other.md",
        fragment: "frag",
      },
    ]);
  });

  it("extracts the narrow wiki subset with alias and fragment", () => {
    const parsed = parseMarkdown(
      "See [[Target]] and [[Target|alias]] plus [[dir/Note#Section|Label]].",
    );
    expect(parsed.wikiLinks).toEqual([
      { raw: "[[Target]]", target: "Target", alias: null, fragment: null },
      {
        raw: "[[Target|alias]]",
        target: "Target",
        alias: "alias",
        fragment: null,
      },
      {
        raw: "[[dir/Note#Section|Label]]",
        target: "dir/Note",
        alias: "Label",
        fragment: "Section",
      },
    ]);
  });

  it("extracts wiki links from text nodes only, in source order", () => {
    const parsed = parseMarkdown(
      "text [[Keep]] and `code [[Skip]]`:\n\n```\n[[SkipBlock]]\n```\n\nnext [[Keep2]].",
    );
    expect(parsed.wikiLinks.map((link) => link.target)).toEqual([
      "Keep",
      "Keep2",
    ]);
  });

  it("rejects empty, unsafe, and external wiki targets", () => {
    const parsed = parseMarkdown(
      "[[]] [[ ]] [[#frag]] [[/abs]] [[..\\win]] [[a/../b]] [[https://x]] [[ok-note_1]]",
    );
    expect(parsed.wikiLinks).toEqual([
      {
        raw: "[[ok-note_1]]",
        target: "ok-note_1",
        alias: null,
        fragment: null,
      },
    ]);
  });

  it("ignores escaped opening brackets with odd/even backslash handling", () => {
    expect(parseMarkdown("escaped \\[[Skip]] end").wikiLinks).toEqual([]);
    expect(
      parseMarkdown("double \\\\[[Keep]] end").wikiLinks.map((l) => l.target),
    ).toEqual(["Keep"]);
    expect(parseMarkdown("triple \\\\\\[[Skip]] end").wikiLinks).toEqual([]);
  });

  it("ignores escaped closing brackets", () => {
    expect(parseMarkdown("close [[A\\]] end").wikiLinks).toEqual([]);
    expect(
      parseMarkdown("close [[A]] and [[B\\]] end").wikiLinks.map(
        (l) => l.target,
      ),
    ).toEqual(["A"]);
  });

  it("ignores entity-encoded brackets but keeps real links in order", () => {
    expect(
      parseMarkdown("entity &#91;&#91;Skip&#93;&#93; end").wikiLinks,
    ).toEqual([]);
    const parsed = parseMarkdown(
      "mix \\[[Skip]] then [[Keep]] then &#91;&#91;Skip2&#93;&#93; then [[Keep2]] end",
    );
    expect(parsed.wikiLinks.map((l) => l.target)).toEqual(["Keep", "Keep2"]);
    expect(parsed.wikiLinks.map((l) => l.raw)).toEqual([
      "[[Keep]]",
      "[[Keep2]]",
    ]);
  });

  it("uses mdast only (no HTML renderer/unified/remark/GFM)", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const here = fileURLToPath(new URL("./", import.meta.url));
    const source = await readFile(`${here}../src/markdown.ts`, "utf8");
    expect(source).toContain("mdast-util-from-markdown");
    // Doc comments may name out-of-scope parsers; enforce no imports.
    const imports = source
      .split("\n")
      .filter((line) => /^\s*import\s/.test(line))
      .join("\n");
    expect(imports).not.toMatch(/unified|remark|rehype|hast|GFM/i);
  });

  it("recovers the next viable opener after a malformed opener", () => {
    expect(parseMarkdown("[[a[[b]]").wikiLinks.map((l) => l.target)).toEqual([
      "b",
    ]);
    expect(
      parseMarkdown("[[bad[inner]] [[good]]").wikiLinks.map((l) => l.target),
    ).toEqual(["good"]);
    expect(
      parseMarkdown("[[a\nb]] [[c]]").wikiLinks.map((l) => l.target),
    ).toEqual(["c"]);
    expect(
      parseMarkdown("[[A\\]]B]] [[c]]").wikiLinks.map((l) => l.target),
    ).toEqual(["c"]);
    const direct = extractWikiCandidatesWithStats("[[a[[b]]");
    expect(direct.candidates.map((c) => c.inner)).toEqual(["b"]);
  });

  it("scans wiki candidates in linear time without suffix rescans", async () => {
    const manyOpeners = "[[a".repeat(200_000);
    const many = extractWikiCandidatesWithStats(manyOpeners);
    expect(many.candidates).toEqual([]);
    expect(many.inspected).toBeLessThanOrEqual(manyOpeners.length);

    const slashes = `\\`.repeat(1_000_000);
    const slashRun = extractWikiCandidatesWithStats(`${slashes}[[a]]`);
    expect(slashRun.candidates.map((c) => c.inner)).toEqual(["a"]);
    expect(slashRun.inspected).toBeLessThanOrEqual(
      slashRun.candidates.length + `${slashes}[[a]]`.length,
    );

    const mega = "[[".repeat(500_000);
    const megaStats = extractWikiCandidatesWithStats(mega);
    expect(megaStats.candidates).toEqual([]);
    expect(megaStats.inspected).toBeLessThanOrEqual(mega.length);

    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const here = fileURLToPath(new URL("./", import.meta.url));
    const source = await readFile(`${here}../src/markdown.ts`, "utf8");
    expect(source).not.toContain("countPrecedingBackslashes");
    expect(source).not.toContain('indexOf("]]"');
  });

  it("rejects CR-spanning wiki links without losing later links", () => {
    expect(parseMarkdown("[[foo\rbar]]").wikiLinks).toEqual([]);
    expect(parseMarkdown("[[foo\r\nbar]]").wikiLinks).toEqual([]);
    // Invalid cross-line yields no edge, so no link-graph budget charge.
    expect(parseMarkdown("[[foo\rbar]]").wikiLinks.length).toBe(0);
    expect(parseMarkdown("[[foo\r\nbar]]").wikiLinks.length).toBe(0);
    // Valid links before and after CR boundaries still resolve in order.
    expect(
      parseMarkdown("[[ok]]\r[[foo\rbar]] [[later]]").wikiLinks.map(
        (l) => l.target,
      ),
    ).toEqual(["ok", "later"]);
    expect(
      parseMarkdown("[[foo\rbar]] [[good]]").wikiLinks.map((l) => l.target),
    ).toEqual(["good"]);
    expect(
      parseMarkdown("[[foo\r\nbar]] [[good]]").wikiLinks.map((l) => l.target),
    ).toEqual(["good"]);
    expect(
      parseMarkdown("before [[keep]]\r\nafter [[kept]]").wikiLinks.map(
        (l) => l.target,
      ),
    ).toEqual(["keep", "kept"]);
    // Escaped opener before a CR boundary stays escaped; later link found.
    expect(
      parseMarkdown("\\[[skip\r]] [[keep]]").wikiLinks.map((l) => l.target),
    ).toEqual(["keep"]);
    // Alias/fragment halves split by CR never emit a link edge.
    expect(parseMarkdown("[[a|b\rc]]").wikiLinks).toEqual([]);
    expect(parseMarkdown("[[a#b\rc]]").wikiLinks).toEqual([]);
    expect(parseMarkdown("[[a|b\r\nc]]").wikiLinks).toEqual([]);
    // No emitted target/alias/fragment may carry a line terminator.
    for (const input of [
      "[[foo\rbar]] [[ok]]",
      "[[foo\r\nbar]] [[ok]]",
      "[[a|b\rc]] [[ok]]",
      "[[a#b\rc]] [[ok]]",
    ]) {
      for (const link of parseMarkdown(input).wikiLinks) {
        expect(link.target).not.toContain("\r");
        expect(link.target).not.toContain("\n");
        if (link.alias !== null) {
          expect(link.alias).not.toContain("\r");
          expect(link.alias).not.toContain("\n");
        }
        if (link.fragment !== null) {
          expect(link.fragment).not.toContain("\r");
          expect(link.fragment).not.toContain("\n");
        }
      }
    }
  });

  it("scans CR boundaries linearly without reopening inside CRLF", () => {
    const cr = extractWikiCandidatesWithStats("[[foo\rbar]] [[good]]");
    expect(cr.candidates.map((c) => c.inner)).toEqual(["good"]);
    expect(cr.inspected).toBeLessThanOrEqual("[[foo\rbar]] [[good]]".length);
    const crlf = extractWikiCandidatesWithStats("[[foo\r\nbar]] [[good]]");
    expect(crlf.candidates.map((c) => c.inner)).toEqual(["good"]);
    expect(crlf.inspected).toBeLessThanOrEqual(
      "[[foo\r\nbar]] [[good]]".length,
    );
    const lone = extractWikiCandidatesWithStats("[[foo\rbar]]");
    expect(lone.candidates).toEqual([]);
    expect(lone.inspected).toBeLessThanOrEqual("[[foo\rbar]]".length);
  });
});
