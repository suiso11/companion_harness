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
});
