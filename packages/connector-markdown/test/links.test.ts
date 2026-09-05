import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "vitest";
import { describe, expect, it } from "vitest";
import { createMarkdownConnector } from "../src/connector.js";
import { MarkdownConnectorError } from "../src/errors.js";

function scratchVault(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function trySymlink(
  target: string,
  linkPath: string,
  type: "dir" | "file" | "junction",
): "ok" | "privilege-denied" {
  try {
    symlinkSync(target, linkPath, type);
    return "ok";
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (
      code === "EPERM" ||
      code === "EACCES" ||
      code === "EROFS" ||
      code === "UNKNOWN"
    ) {
      return "privilege-denied";
    }
    throw error;
  }
}

function skipUnlessPrivileged(
  ctx: TestContext,
  outcome: "ok" | "privilege-denied",
): boolean {
  if (outcome === "privilege-denied") {
    ctx.skip();
    return false;
  }
  return true;
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

  it("exposes only real wiki links in the graph when escapes/entities mix", async () => {
    const dir = scratchVault("md-link-wiki-esc-");
    writeFileSync(join(dir, "Note.md"), "# Note\nnote body\n");
    writeFileSync(
      join(dir, "a.md"),
      "# A\nreal [[Note]] escaped \\[[Note]] entity &#91;&#91;Note&#93;&#93; code `[[Note]]`\n",
    );
    const connector = await createMarkdownConnector([{ path: dir }]);
    const doc = await connector.readCanonical("vault-1/a.md");
    expect(doc.wikiLinks.map((l) => l.raw)).toEqual(["[[Note]]"]);
    expect(doc.wikiLinks[0]).toMatchObject({
      target: "Note",
      status: "resolved",
      canonicalKey: "vault-1/Note.md",
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

  it("resolves standard links through internal file symlink aliases", async (ctx: TestContext) => {
    const dir = scratchVault("md-link-aliasfile-");
    writeFileSync(join(dir, "real.md"), "# Real\nlinkfold target body\n");
    if (
      !skipUnlessPrivileged(
        ctx,
        trySymlink(join(dir, "real.md"), join(dir, "alias.md"), "file"),
      )
    ) {
      return;
    }
    writeFileSync(
      join(dir, "a.md"),
      "# A\nlinkfold see [via alias](alias.md) and [direct](real.md) and [missing](missing.md)\n",
    );
    const connector = await createMarkdownConnector([{ path: dir }]);
    const first = await connector.search({ query: "linkfold" });
    // Discovery folds the alias: no duplicate resource, no lost edge.
    expect(first.hits.map((hit) => hit.canonicalKey).sort()).toEqual([
      "vault-1/a.md",
      "vault-1/real.md",
    ]);
    const hit = first.hits.find(
      (entry) => entry.canonicalKey === "vault-1/a.md",
    );
    expect(hit?.standardLinks).toEqual([
      {
        rawUrl: "alias.md",
        path: "alias.md",
        fragment: null,
        status: "resolved",
        canonicalKey: "vault-1/real.md",
      },
      {
        rawUrl: "real.md",
        path: "real.md",
        fragment: null,
        status: "resolved",
        canonicalKey: "vault-1/real.md",
      },
      {
        rawUrl: "missing.md",
        path: "missing.md",
        fragment: null,
        status: "unresolved",
      },
    ]);
    // Search vs read consistency and determinism.
    const doc = await connector.readCanonical("vault-1/a.md");
    expect(doc.standardLinks).toEqual(hit?.standardLinks);
    const second = await connector.search({ query: "linkfold" });
    expect(second).toEqual(first);
    const reread = await connector.readCanonical("vault-1/a.md");
    expect(reread).toEqual(doc);
    expect(JSON.stringify({ first, doc })).not.toContain(dir);
    expect(JSON.stringify({ first, doc })).not.toContain(tmpdir());
  });

  it("resolves standard links through internal directory aliases", async (ctx: TestContext) => {
    const dir = scratchVault("md-link-aliasdir-");
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(
      join(dir, "docs", "note.md"),
      "# Note\ndirfold target body\n",
    );
    const dirType = process.platform === "win32" ? "junction" : "dir";
    if (
      !skipUnlessPrivileged(
        ctx,
        trySymlink(join(dir, "docs"), join(dir, "linked"), dirType),
      )
    ) {
      return;
    }
    writeFileSync(
      join(dir, "a.md"),
      "# A\ndirfold see [via alias](linked/note.md) and [direct](docs/note.md)\n",
    );
    const connector = await createMarkdownConnector([{ path: dir }]);
    const first = await connector.search({ query: "dirfold" });
    expect(first.hits.map((hit) => hit.canonicalKey).sort()).toEqual([
      "vault-1/a.md",
      "vault-1/docs/note.md",
    ]);
    const hit = first.hits.find(
      (entry) => entry.canonicalKey === "vault-1/a.md",
    );
    expect(hit?.standardLinks).toEqual([
      {
        rawUrl: "linked/note.md",
        path: "linked/note.md",
        fragment: null,
        status: "resolved",
        canonicalKey: "vault-1/docs/note.md",
      },
      {
        rawUrl: "docs/note.md",
        path: "docs/note.md",
        fragment: null,
        status: "resolved",
        canonicalKey: "vault-1/docs/note.md",
      },
    ]);
    const doc = await connector.readCanonical("vault-1/a.md");
    expect(doc.standardLinks).toEqual(hit?.standardLinks);
    const second = await connector.search({ query: "dirfold" });
    expect(second).toEqual(first);
    expect(JSON.stringify({ first, doc })).not.toContain(dir);
  });

  it("collapses wiki alias spellings to one real candidate", async (ctx: TestContext) => {
    const dir = scratchVault("md-link-wikialias-");
    writeFileSync(join(dir, "real.md"), "# Real\nwikifold body\n");
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, "docs", "note.md"), "# Note\nwikifold body\n");
    const fileLink = trySymlink(
      join(dir, "real.md"),
      join(dir, "alias.md"),
      "file",
    );
    const dirType = process.platform === "win32" ? "junction" : "dir";
    const dirLink = trySymlink(join(dir, "docs"), join(dir, "linked"), dirType);
    if (
      !skipUnlessPrivileged(ctx, fileLink) ||
      !skipUnlessPrivileged(ctx, dirLink)
    ) {
      return;
    }
    writeFileSync(
      join(dir, "a.md"),
      "# A\nwikifold see [[alias]] and [[real]] and [[linked/note]] here\n",
    );
    const connector = await createMarkdownConnector([{ path: dir }]);
    const doc = await connector.readCanonical("vault-1/a.md");
    expect(doc.wikiLinks).toEqual([
      {
        raw: "[[alias]]",
        target: "alias",
        alias: null,
        fragment: null,
        status: "resolved",
        candidates: ["vault-1/real.md"],
        canonicalKey: "vault-1/real.md",
      },
      {
        raw: "[[real]]",
        target: "real",
        alias: null,
        fragment: null,
        status: "resolved",
        candidates: ["vault-1/real.md"],
        canonicalKey: "vault-1/real.md",
      },
      {
        raw: "[[linked/note]]",
        target: "linked/note",
        alias: null,
        fragment: null,
        status: "resolved",
        candidates: ["vault-1/docs/note.md"],
        canonicalKey: "vault-1/docs/note.md",
      },
    ]);
    // Duplicate alias spellings never become ambiguous duplicates.
    for (const link of doc.wikiLinks) {
      expect(link.candidates).toHaveLength(1);
    }
    const fromSearch = await connector.search({ query: "wikifold" });
    const hit = fromSearch.hits.find(
      (entry) => entry.canonicalKey === "vault-1/a.md",
    );
    expect(hit?.wikiLinks).toEqual(doc.wikiLinks);
    const again = await connector.readCanonical("vault-1/a.md");
    expect(again.wikiLinks).toEqual(doc.wikiLinks);
    expect(JSON.stringify(doc.wikiLinks)).not.toContain(dir);
  });

  it("resolves the same wiki base per sourceDir through different symlink targets", async (ctx: TestContext) => {
    const dir = scratchVault("md-link-wikisrcdir-");
    writeFileSync(join(dir, "a.md"), "# A\ntarget alpha body\n");
    writeFileSync(join(dir, "b.md"), "# B\ntarget beta body\n");
    mkdirSync(join(dir, "d1"), { recursive: true });
    mkdirSync(join(dir, "d2"), { recursive: true });
    // No real `Note.md` exists: each sourceDir carries its own symlink alias
    // folding to a different real target. The union is sourceDir-dependent.
    const firstLink = trySymlink(
      join(dir, "a.md"),
      join(dir, "d1", "Note.md"),
      "file",
    );
    const secondLink = trySymlink(
      join(dir, "b.md"),
      join(dir, "d2", "Note.md"),
      "file",
    );
    if (
      !skipUnlessPrivileged(ctx, firstLink) ||
      !skipUnlessPrivileged(ctx, secondLink)
    ) {
      return;
    }
    writeFileSync(
      join(dir, "d1", "s1.md"),
      "# S1\nsourcedirwiki see [[Note]] here\n",
    );
    writeFileSync(
      join(dir, "d2", "s2.md"),
      "# S2\nsourcedirwiki see [[Note]] here\n",
    );
    const connector = await createMarkdownConnector([{ path: dir }]);
    const found = await connector.search({ query: "sourcedirwiki" });
    const first = found.hits.find(
      (entry) => entry.canonicalKey === "vault-1/d1/s1.md",
    );
    const second = found.hits.find(
      (entry) => entry.canonicalKey === "vault-1/d2/s2.md",
    );
    expect(first?.wikiLinks).toEqual([
      {
        raw: "[[Note]]",
        target: "Note",
        alias: null,
        fragment: null,
        status: "resolved",
        candidates: ["vault-1/a.md"],
        canonicalKey: "vault-1/a.md",
      },
    ]);
    expect(second?.wikiLinks).toEqual([
      {
        raw: "[[Note]]",
        target: "Note",
        alias: null,
        fragment: null,
        status: "resolved",
        candidates: ["vault-1/b.md"],
        canonicalKey: "vault-1/b.md",
      },
    ]);
    // Read path resolves identically (no cross-sourceDir cache reuse).
    expect(
      (await connector.readCanonical("vault-1/d1/s1.md")).wikiLinks,
    ).toEqual(first?.wikiLinks);
    expect(
      (await connector.readCanonical("vault-1/d2/s2.md")).wikiLinks,
    ).toEqual(second?.wikiLinks);
    expect(JSON.stringify(found)).not.toContain(dir);
  });

  it("rejects external symlink escapes without leaking paths", async (ctx: TestContext) => {
    const dir = scratchVault("md-link-ext-");
    const outside = scratchVault("md-link-extout-");
    writeFileSync(join(outside, "secret.md"), "# Secret\noutside body\n");
    writeFileSync(join(dir, "ok.md"), "# Ok\nlinkext body\n");
    writeFileSync(join(dir, "a.md"), "# A\nlinkext see [evil](evil.md) here\n");
    if (
      !skipUnlessPrivileged(
        ctx,
        trySymlink(join(outside, "secret.md"), join(dir, "evil.md"), "file"),
      )
    ) {
      return;
    }
    const connector = await createMarkdownConnector([{ path: dir }]);
    try {
      await connector.search({ query: "linkext" });
      expect.unreachable("expected markdown_path_unsafe");
    } catch (error) {
      expect(error).toBeInstanceOf(MarkdownConnectorError);
      expect((error as MarkdownConnectorError).code).toBe(
        "markdown_path_unsafe",
      );
      expect((error as MarkdownConnectorError).canonicalKey).toBe("vault-1");
      expect(String(error)).not.toContain(dir);
      expect(String(error)).not.toContain(outside);
      expect(String(error)).not.toContain(tmpdir());
    }
    try {
      await connector.readCanonical("vault-1/ok.md");
      expect.unreachable("expected markdown_path_unsafe");
    } catch (error) {
      expect(error).toBeInstanceOf(MarkdownConnectorError);
      expect((error as MarkdownConnectorError).code).toBe(
        "markdown_path_unsafe",
      );
      expect(String(error)).not.toContain(dir);
      expect(String(error)).not.toContain(outside);
      expect(String(error)).not.toContain(tmpdir());
    }
  });
});
