import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMarkdownConnector } from "../src/connector.js";
import { MarkdownConnectorError } from "../src/errors.js";
import { MAX_FILE_BYTES } from "../src/safe_read.js";

function scratchVault(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function codePoints(value: string): number {
  return Array.from(value).length;
}

describe("markdown connector search core", () => {
  it("exposes path-free root info in alias order", async () => {
    const dir = scratchVault("md-conn-roots-");
    writeFileSync(join(dir, "a.md"), "# A\n");
    const connector = await createMarkdownConnector([{ path: dir }]);
    expect(connector.roots).toEqual([{ alias: "vault-1" }]);
    expect(JSON.stringify(connector.roots)).not.toContain(dir);
  });

  it("rejects query/limit outside the exact contracts bounds", async () => {
    const dir = scratchVault("md-conn-bounds-");
    writeFileSync(join(dir, "a.md"), "# A\nbody\n");
    const connector = await createMarkdownConnector([{ path: dir }]);
    await expect(connector.search({ query: "" })).rejects.toMatchObject({
      name: "MarkdownConnectorError",
      code: "invalid_input",
    });
    await expect(
      connector.search({ query: "x".repeat(257) }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      connector.search({ query: 42 as unknown as string }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    for (const limit of [0, 21, 1.5, "10", Number.NaN]) {
      await expect(
        connector.search({ query: "a", limit: limit as unknown as number }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    }
    // 1 and 256 code points (astral-aware) are the accepted edges.
    await expect(connector.search({ query: "😀" })).resolves.toMatchObject({
      hits: expect.any(Array),
    });
    await expect(
      connector.search({ query: "x".repeat(256) }),
    ).resolves.toMatchObject({ hits: expect.any(Array) });
  });

  it("treats a whitespace query as a literal, never trimmed", async () => {
    const dir = scratchVault("md-conn-space-");
    writeFileSync(join(dir, "sp.md"), "# Sp\na b\n");
    const connector = await createMarkdownConnector([{ path: dir }]);
    const single = await connector.search({ query: " " });
    expect(single.hits.map((hit) => hit.canonicalKey)).toEqual([
      "vault-1/sp.md",
    ]);
    const doubleSpace = await connector.search({ query: "  " });
    expect(doubleSpace.hits).toEqual([]);
  });

  it("enforces default-10 / max-20 result limits", async () => {
    const dir = scratchVault("md-conn-limit-");
    for (let i = 0; i < 21; i += 1) {
      const name = `n${String(i).padStart(2, "0")}.md`;
      writeFileSync(join(dir, name), "# T\nplenty here\n");
    }
    const connector = await createMarkdownConnector([{ path: dir }]);
    const byDefault = await connector.search({ query: "plenty" });
    expect(byDefault.hits).toHaveLength(10);
    const capped = await connector.search({ query: "plenty", limit: 20 });
    expect(capped.hits).toHaveLength(20);
    const one = await connector.search({ query: "plenty", limit: 1 });
    expect(one.hits).toHaveLength(1);
  });

  it("ranks title equality, then title substring, then body", async () => {
    const dir = scratchVault("md-conn-rank-");
    writeFileSync(join(dir, "body.md"), "# Other\nAlpha inside the body\n");
    writeFileSync(join(dir, "exact.md"), "# Alpha\nnothing here\n");
    writeFileSync(join(dir, "partial.md"), "# Say Alpha Loud\nnothing here\n");
    const connector = await createMarkdownConnector([{ path: dir }]);
    const result = await connector.search({ query: "alpha" });
    expect(result.hits.map((hit) => hit.canonicalKey)).toEqual([
      "vault-1/exact.md",
      "vault-1/partial.md",
      "vault-1/body.md",
    ]);
  });

  it("breaks rank ties by canonical-key code-unit order", async () => {
    const dir = scratchVault("md-conn-tie-");
    writeFileSync(join(dir, "m.md"), "# T\nsame body word\n");
    writeFileSync(join(dir, "a.md"), "# T\nsame body word\n");
    const connector = await createMarkdownConnector([{ path: dir }]);
    const result = await connector.search({ query: "same body word" });
    expect(result.hits.map((hit) => hit.canonicalKey)).toEqual([
      "vault-1/a.md",
      "vault-1/m.md",
    ]);
  });

  it("matches whole folded queries literally (no regex/FTS)", async () => {
    const dir = scratchVault("md-conn-literal-");
    writeFileSync(join(dir, "re.md"), "# T\na+b (c) .*?\n");
    const connector = await createMarkdownConnector([{ path: dir }]);
    const literal = await connector.search({ query: "a+b (c) .*?" });
    expect(literal.hits).toHaveLength(1);
    const regexLike = await connector.search({ query: "a." });
    expect(regexLike.hits).toEqual([]);
    const folded = await connector.search({ query: "A+B (C) .*?" });
    expect(folded.hits).toHaveLength(1);
  });

  it("derives titles with filename-stem fallback and stable revisions", async () => {
    const dir = scratchVault("md-conn-title-");
    writeFileSync(join(dir, "notes.md"), "queryword lives here\n");
    const connector = await createMarkdownConnector([{ path: dir }]);
    const result = await connector.search({ query: "queryword" });
    expect(result.hits).toHaveLength(1);
    const hit = result.hits[0] as NonNullable<(typeof result.hits)[0]>;
    expect(hit.title).toBe("notes");
    expect(hit.text).toBe("queryword lives here\n".normalize("NFC"));
    expect(hit.sourceRevision).toBe(sha256Hex(hit.text));
    // Stable across repeated searches.
    const again = await connector.search({ query: "queryword" });
    expect(again.hits[0]?.sourceRevision).toBe(hit.sourceRevision);
  });

  it("normalizes NFC text before matching and hashing", async () => {
    const dir = scratchVault("md-conn-nfc-");
    writeFileSync(join(dir, "nfd.md"), "# café\nbody café\n");
    const connector = await createMarkdownConnector([{ path: dir }]);
    const result = await connector.search({ query: "café" });
    expect(result.hits).toHaveLength(1);
    const hit = result.hits[0] as NonNullable<(typeof result.hits)[0]>;
    expect(hit.text).toBe(hit.text.normalize("NFC"));
    expect(hit.sourceRevision).toBe(sha256Hex(hit.text.normalize("NFC")));
  });

  it("bounds snippets to 512 code points around the first body hit", async () => {
    const dir = scratchVault("md-conn-snippet-");
    const body = `${"x".repeat(600)}TARGET${"y".repeat(600)}`;
    writeFileSync(join(dir, "long.md"), `# Long\n${body}\n`);
    const connector = await createMarkdownConnector([{ path: dir }]);
    const result = await connector.search({ query: "target" });
    expect(result.hits).toHaveLength(1);
    const snippet = result.hits[0]?.snippet ?? "";
    expect(codePoints(snippet)).toBeLessThanOrEqual(512);
    expect(snippet).toContain("TARGET");
  });

  it("uses a deterministic body prefix for title-only hits", async () => {
    const dir = scratchVault("md-conn-titleonly-");
    writeFileSync(join(dir, "t.md"), "# UniqueTitleWord\nplain body text\n");
    const connector = await createMarkdownConnector([{ path: dir }]);
    const result = await connector.search({ query: "uniquetitleword" });
    expect(result.hits).toHaveLength(1);
    const hit = result.hits[0] as NonNullable<(typeof result.hits)[0]>;
    expect(codePoints(hit.snippet)).toBeLessThanOrEqual(512);
    expect(hit.snippet).toBe("# UniqueTitleWord\nplain body text\n");
  });

  it("returns every skipped entry without slicing to the result limit", async () => {
    const dir = scratchVault("md-conn-skipped-");
    writeFileSync(join(dir, "big.md"), `${"z".repeat(MAX_FILE_BYTES + 1)}`);
    writeFileSync(join(dir, "bad.md"), Buffer.from([0xff, 0xfe, 0x41]));
    writeFileSync(join(dir, "ok.md"), "# Ok\nmatchme\n");
    const connector = await createMarkdownConnector([{ path: dir }]);
    const result = await connector.search({ query: "matchme", limit: 1 });
    expect(result.hits).toHaveLength(1);
    expect(result.skipped).toEqual([
      { canonicalKey: "vault-1/bad.md", reason: "invalid_utf8" },
      { canonicalKey: "vault-1/big.md", reason: "file_too_large" },
    ]);
  });

  it("keeps absolute paths out of hits, skips, and errors", async () => {
    const dir = scratchVault("md-conn-privacy-");
    writeFileSync(join(dir, "a.md"), "# A\nsecret body\n");
    const connector = await createMarkdownConnector([{ path: dir }]);
    const result = await connector.search({ query: "secret" });
    expect(JSON.stringify(result)).not.toContain(dir);
    expect(JSON.stringify(result)).not.toContain(tmpdir());
    await expect(connector.readCanonical("nope/a.md")).rejects.toBeInstanceOf(
      MarkdownConnectorError,
    );
    try {
      await connector.readCanonical("nope/a.md");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(MarkdownConnectorError);
      expect((error as MarkdownConnectorError).code).toBe(
        "reference_not_found",
      );
      expect(String(error)).not.toContain(dir);
    }
  });

  it("is deterministic across repeated searches and connectors", async () => {
    const dir = scratchVault("md-conn-determinism-");
    writeFileSync(join(dir, "b.md"), "# B\nrepeatable word\n");
    writeFileSync(join(dir, "a.md"), "# A\nrepeatable word\n");
    const first = await createMarkdownConnector([{ path: dir }]);
    const one = await first.search({ query: "repeatable" });
    const two = await first.search({ query: "repeatable" });
    expect(two).toEqual(one);
    const second = await createMarkdownConnector([{ path: dir }]);
    const three = await second.search({ query: "repeatable" });
    expect(three).toEqual(one);
  });

  it("reads one canonical document with links and revision", async () => {
    const dir = scratchVault("md-conn-read-");
    writeFileSync(join(dir, "doc.md"), "# Doc Title\nhello body\n");
    const connector = await createMarkdownConnector([{ path: dir }]);
    const doc = await connector.readCanonical("vault-1/doc.md");
    expect(doc.canonicalKey).toBe("vault-1/doc.md");
    expect(doc.title).toBe("Doc Title");
    expect(doc.text).toBe("# Doc Title\nhello body\n");
    expect(doc.sourceRevision).toBe(sha256Hex(doc.text));
    expect(codePoints(doc.snippet)).toBeLessThanOrEqual(512);
    expect(JSON.stringify(doc)).not.toContain(dir);
    await expect(
      connector.readCanonical("vault-1/../doc.md"),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("never uses locale-sensitive APIs in the connector", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const here = fileURLToPath(new URL("./", import.meta.url));
    const source = await readFile(`${here}../src/connector.ts`, "utf8");
    expect(source).not.toContain("toLocaleLowerCase(");
    expect(source).not.toContain("toLocaleUpperCase(");
    expect(source).not.toContain("localeCompare(");
  });
});
