import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMarkdownConnector } from "../src/connector.js";

function scratchVault(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("markdown connector links", () => {
  it("resolves standard relative links against the source directory", async () => {
    const dir = scratchVault("md-link-std-");
    mkdirSync(join(dir, "sub"), { recursive: true });
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, "sub", "b.md"), "# B\ntarget body\n");
    writeFileSync(
      join(dir, "docs", "a.md"),
      "# A\nsee [b](../sub/b.md) and [missing](missing.md)\n",
    );
    const connector = await createMarkdownConnector([{ path: dir }]);
    const hit = (await connector.search({ query: "see" })).hits.find(
      (entry) => entry.canonicalKey === "vault-1/docs/a.md",
    );
    expect(hit).toBeDefined();
    expect(hit?.standardLinks).toEqual([
      {
        rawUrl: "../sub/b.md",
        path: "../sub/b.md",
        fragment: null,
        status: "resolved",
        canonicalKey: "vault-1/sub/b.md",
      },
      {
        rawUrl: "missing.md",
        path: "missing.md",
        fragment: null,
        status: "unresolved",
      },
    ]);
  });

  it("never resolves a standard link that escapes the root", async () => {
    const dir = scratchVault("md-link-escape-");
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(
      join(dir, "docs", "a.md"),
      "# A\nescape attempt [e](../../outside.md)\n",
    );
    const connector = await createMarkdownConnector([{ path: dir }]);
    const doc = await connector.readCanonical("vault-1/docs/a.md");
    expect(doc.standardLinks).toEqual([
      {
        rawUrl: "../../outside.md",
        path: "../../outside.md",
        fragment: null,
        status: "unresolved",
      },
    ]);
    expect(JSON.stringify(doc.standardLinks)).not.toContain(dir);
  });

  it("resolves a unique wiki target to one canonical key", async () => {
    const dir = scratchVault("md-link-wiki-one-");
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "sub", "Note.md"), "# Note\nnote body\n");
    writeFileSync(join(dir, "sub", "a.md"), "# A\nsee [[Note]] here\n");
    const connector = await createMarkdownConnector([{ path: dir }]);
    const doc = await connector.readCanonical("vault-1/sub/a.md");
    expect(doc.wikiLinks).toEqual([
      {
        raw: "[[Note]]",
        target: "Note",
        alias: null,
        fragment: null,
        status: "resolved",
        candidates: ["vault-1/sub/Note.md"],
        canonicalKey: "vault-1/sub/Note.md",
      },
    ]);
  });

  it("reports ambiguous wiki targets with sorted path-free candidates", async () => {
    const dir = scratchVault("md-link-wiki-amb-");
    mkdirSync(join(dir, "a"), { recursive: true });
    mkdirSync(join(dir, "b"), { recursive: true });
    writeFileSync(join(dir, "a", "Note.md"), "# N1\nfirst\n");
    writeFileSync(join(dir, "b", "Note.md"), "# N2\nsecond\n");
    writeFileSync(join(dir, "index.md"), "# I\nsee [[Note]] here\n");
    const connector = await createMarkdownConnector([{ path: dir }]);
    const doc = await connector.readCanonical("vault-1/index.md");
    expect(doc.wikiLinks).toEqual([
      {
        raw: "[[Note]]",
        target: "Note",
        alias: null,
        fragment: null,
        // Two basename matches: deterministic ambiguity, never a guess.
        status: "ambiguous",
        candidates: ["vault-1/a/Note.md", "vault-1/b/Note.md"],
      },
    ]);
    expect(doc.wikiLinks[0]?.canonicalKey).toBeUndefined();
    expect(JSON.stringify(doc.wikiLinks)).not.toContain(dir);
  });

  it("marks unknown wiki targets unresolved with no candidates", async () => {
    const dir = scratchVault("md-link-wiki-miss-");
    writeFileSync(join(dir, "a.md"), "# A\nsee [[Missing]] here\n");
    const connector = await createMarkdownConnector([{ path: dir }]);
    const doc = await connector.readCanonical("vault-1/a.md");
    expect(doc.wikiLinks).toEqual([
      {
        raw: "[[Missing]]",
        target: "Missing",
        alias: null,
        fragment: null,
        status: "unresolved",
        candidates: [],
      },
    ]);
  });

  it("resolves root-relative wiki targets and ignores alias/fragment", async () => {
    const dir = scratchVault("md-link-wiki-root-");
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "sub", "Note.md"), "# Note\nbody\n");
    writeFileSync(
      join(dir, "a.md"),
      "# A\nsee [[sub/Note#Section|Label]] here\n",
    );
    const connector = await createMarkdownConnector([{ path: dir }]);
    const doc = await connector.readCanonical("vault-1/a.md");
    expect(doc.wikiLinks[0]).toMatchObject({
      target: "sub/Note",
      alias: "Label",
      fragment: "Section",
      status: "resolved",
      canonicalKey: "vault-1/sub/Note.md",
    });
  });

  it("keeps wiki ambiguity stable across search and repeated reads", async () => {
    const dir = scratchVault("md-link-wiki-stable-");
    mkdirSync(join(dir, "a"), { recursive: true });
    mkdirSync(join(dir, "b"), { recursive: true });
    writeFileSync(join(dir, "a", "Note.md"), "# N1\nshared word\n");
    writeFileSync(join(dir, "b", "Note.md"), "# N2\nshared word\n");
    writeFileSync(join(dir, "index.md"), "# I\nshared word [[Note]]\n");
    const connector = await createMarkdownConnector([{ path: dir }]);
    const fromSearch = (await connector.search({ query: "shared word" })).hits;
    const indexHits = fromSearch.filter(
      (hit) => hit.canonicalKey === "vault-1/index.md",
    );
    expect(indexHits).toHaveLength(1);
    const wiki = indexHits[0]?.wikiLinks[0];
    expect(wiki?.status).toBe("ambiguous");
    expect(wiki?.candidates).toEqual([
      "vault-1/a/Note.md",
      "vault-1/b/Note.md",
    ]);
    const reread = await connector.readCanonical("vault-1/index.md");
    expect(reread.wikiLinks[0]).toEqual(wiki);
  });
});
