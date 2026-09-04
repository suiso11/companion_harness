import { describe, expect, it } from "vitest";
import { parseMarkdown } from "../src/markdown.js";

describe("markdown parsing", () => {
  it("extracts the first heading as plain text", () => {
    expect(parseMarkdown("# Hello *world*").title).toBe("Hello world");
    expect(parseMarkdown("no headings here").title).toBeNull();
    expect(parseMarkdown("#   ").title).toBeNull();
    const parsed = parseMarkdown("# First\n\n## Second\n");
    expect(parsed.title).toBe("First");
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
});
