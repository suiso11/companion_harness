import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createMarkdownConnector,
  deriveIdentityFingerprint,
} from "../src/connector.js";
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

  it("rejects drive/scheme/absolute keys as invalid without echo or bytes", async () => {
    const dir = scratchVault("md-conn-alias-");
    writeFileSync(join(dir, "real.md"), "# Real\nbody\n");
    let hookCalls = 0;
    const counting = () => {
      hookCalls += 1;
    };
    const connector = await createMarkdownConnector([{ path: dir }], {
      safeRead: {
        afterPreStat: counting,
        afterOpen: counting,
        afterRead: counting,
      },
    });
    const badKeys: unknown[] = [
      "C:/secret.md",
      "C:\\secret.md",
      "a:b/c.md",
      "https:evil/a.md",
      "vault-1:C/a.md",
      "/etc/passwd.md",
      "\\server\\share.md",
      "vault-1\\note.md",
      "vault-1/a\0b.md",
      "vault-1/../evil.md",
      "vault-1/./a.md",
      "vault-1//a.md",
      ".hidden/a.md",
      "-bad/a.md",
      "vault-1/a.txt",
      "vault-1/a",
      "vault-1/",
      "not-a-key",
      "",
      42,
      null,
    ];
    for (const badKey of badKeys) {
      try {
        await connector.readCanonical(badKey);
        expect.unreachable(`expected invalid_input for ${String(badKey)}`);
      } catch (error) {
        expect(error).toBeInstanceOf(MarkdownConnectorError);
        expect((error as MarkdownConnectorError).code).toBe("invalid_input");
        // Never echo raw input, absolute paths, or drive/scheme text.
        expect((error as MarkdownConnectorError).canonicalKey).toBeNull();
        expect(String(error)).not.toContain("C:/secret");
        expect(String(error)).not.toContain("https:evil");
        expect(String(error)).not.toContain("/etc/passwd");
        expect(String(error)).not.toContain(dir);
        expect(String(error)).not.toContain(tmpdir());
      }
    }
    expect(hookCalls).toBe(0);
    // Well-formed but unknown alias/key stays reference_not_found with safe key.
    try {
      await connector.readCanonical("vault-1/missing.md");
      expect.unreachable();
    } catch (error) {
      expect((error as MarkdownConnectorError).code).toBe(
        "reference_not_found",
      );
      expect((error as MarkdownConnectorError).canonicalKey).toBe(
        "vault-1/missing.md",
      );
      expect(String(error)).not.toContain(dir);
    }
    expect(hookCalls).toBe(0);
  });

  it("rejects non-.md keys as invalid before any byte read", async () => {
    const dir = scratchVault("md-conn-nomd-");
    writeFileSync(join(dir, "notes.txt"), "plain text body\n");
    let hookCalls = 0;
    const connector = await createMarkdownConnector([{ path: dir }], {
      safeRead: {
        afterPreStat: () => {
          hookCalls += 1;
        },
        afterOpen: () => {
          hookCalls += 1;
        },
        afterRead: () => {
          hookCalls += 1;
        },
      },
    });
    await expect(
      connector.readCanonical("vault-1/notes.txt"),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      connector.readCanonical("vault-1/notes"),
    ).rejects.toMatchObject({
      code: "invalid_input",
    });
    // The existing .txt file proves the rejection happened before safeRead:
    // a content read would have run the TOCTOU hooks.
    expect(hookCalls).toBe(0);
  });

  it("returns reference_not_found for undiscovered keys before any byte read", async () => {
    const dir = scratchVault("md-conn-undiscovered-");
    writeFileSync(join(dir, "real.md"), "# Real\nbody\n");
    let hookCalls = 0;
    const connector = await createMarkdownConnector([{ path: dir }], {
      safeRead: {
        afterPreStat: () => {
          hookCalls += 1;
        },
        afterOpen: () => {
          hookCalls += 1;
        },
        afterRead: () => {
          hookCalls += 1;
        },
      },
    });
    // Well-formed `.md` keys that were never discovered: no byte is read.
    await expect(
      connector.readCanonical("vault-1/missing.md"),
    ).rejects.toMatchObject({ code: "reference_not_found" });
    await expect(
      connector.readCanonical("vault-1/sub/missing.md"),
    ).rejects.toMatchObject({ code: "reference_not_found" });
    await expect(
      connector.readCanonical("vault-9/real.md"),
    ).rejects.toMatchObject({ code: "reference_not_found" });
    expect(hookCalls).toBe(0);
    // Malformed keys stay invalid_input, also before bytes.
    await expect(connector.readCanonical("not-a-key")).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(connector.readCanonical(42)).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(hookCalls).toBe(0);
    // The discovered key still reads exactly once.
    const doc = await connector.readCanonical("vault-1/real.md");
    expect(doc.canonicalKey).toBe("vault-1/real.md");
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

  it("aborts before discovery when the signal is already aborted", async () => {
    const dir = scratchVault("md-conn-abortbefore-");
    writeFileSync(join(dir, "a.md"), "# A\nhello body\n");
    const connector = await createMarkdownConnector([{ path: dir }]);
    const controller = new AbortController();
    controller.abort();
    try {
      await connector.search({ query: "hello" }, { signal: controller.signal });
      expect.unreachable("expected AbortError");
    } catch (error) {
      expect((error as Error).name).toBe("AbortError");
      expect(String(error)).not.toContain(dir);
      expect(String(error)).not.toContain(tmpdir());
    }
    try {
      await connector.readCanonical("vault-1/a.md", {
        signal: controller.signal,
      });
      expect.unreachable("expected AbortError");
    } catch (error) {
      expect((error as Error).name).toBe("AbortError");
      expect(String(error)).not.toContain(dir);
      expect(String(error)).not.toContain(tmpdir());
      expect(String(error)).not.toContain("a.md");
    }
    // Existing call compatibility: omitting the signal still searches.
    const ok = await connector.search({ query: "hello" });
    expect(ok.hits).toHaveLength(1);
  });

  it("aborts during per-file reads and discards partial hits", async () => {
    const dir = scratchVault("md-conn-abortduring-");
    writeFileSync(join(dir, "a.md"), "# A\nhello one\n");
    writeFileSync(join(dir, "b.md"), "# B\nhello two\n");
    const controller = new AbortController();
    const connector = await createMarkdownConnector([{ path: dir }], {
      safeRead: {
        afterPreStat: () => {
          controller.abort();
        },
      },
    });
    try {
      await connector.search({ query: "hello" }, { signal: controller.signal });
      expect.unreachable("expected AbortError");
    } catch (error) {
      expect((error as Error).name).toBe("AbortError");
      expect(String(error)).not.toContain(dir);
      expect(String(error)).not.toContain(tmpdir());
    }
  });
});

describe("markdown connector identity fingerprint", () => {
  it("exposes an opaque 64-hex identity and keeps roots alias-only", async () => {
    const dir = scratchVault("md-conn-ident-");
    writeFileSync(join(dir, "a.md"), "# A\nbody\n");
    const connector = await createMarkdownConnector([{ path: dir }]);
    expect(connector.identityFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(connector.roots).toEqual([{ alias: "vault-1" }]);
    expect(JSON.stringify(connector)).not.toContain(dir);
    expect(JSON.stringify(connector)).not.toContain(tmpdir());
    expect(connector.identityFingerprint).not.toContain("vault-1");
  });

  it("is deterministic for the same roots regardless of input order", async () => {
    const first = scratchVault("md-conn-identord-a-");
    const second = scratchVault("md-conn-identord-b-");
    writeFileSync(join(first, "a.md"), "# A\n");
    writeFileSync(join(second, "a.md"), "# A\n");
    const one = await createMarkdownConnector([
      { path: first, alias: "alpha" },
      { path: second, alias: "beta" },
    ]);
    const two = await createMarkdownConnector([
      { path: second, alias: "beta" },
      { path: first, alias: "alpha" },
    ]);
    expect(one.identityFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(two.identityFingerprint).toBe(one.identityFingerprint);
    const again = await createMarkdownConnector([
      { path: first, alias: "alpha" },
      { path: second, alias: "beta" },
    ]);
    expect(again.identityFingerprint).toBe(one.identityFingerprint);
    expect(JSON.stringify(one)).not.toContain(first);
    expect(JSON.stringify(one)).not.toContain(second);
  });

  it("differs when an alias or the real root changes", async () => {
    const first = scratchVault("md-conn-identdiff-a-");
    const second = scratchVault("md-conn-identdiff-b-");
    const third = scratchVault("md-conn-identdiff-c-");
    writeFileSync(join(first, "a.md"), "# A\n");
    writeFileSync(join(second, "a.md"), "# A\n");
    writeFileSync(join(third, "a.md"), "# A\n");
    const base = await createMarkdownConnector([
      { path: first, alias: "alpha" },
    ]);
    const renamed = await createMarkdownConnector([
      { path: first, alias: "renamed" },
    ]);
    expect(renamed.identityFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(renamed.identityFingerprint).not.toBe(base.identityFingerprint);
    const moved = await createMarkdownConnector([
      { path: second, alias: "alpha" },
    ]);
    expect(moved.identityFingerprint).not.toBe(base.identityFingerprint);
    // Two roots versus one root also differ.
    const wider = await createMarkdownConnector([
      { path: first, alias: "alpha" },
      { path: third, alias: "beta" },
    ]);
    expect(wider.identityFingerprint).not.toBe(base.identityFingerprint);
    for (const connector of [base, renamed, moved, wider]) {
      expect(JSON.stringify(connector)).not.toContain(first);
      expect(JSON.stringify(connector)).not.toContain(second);
      expect(JSON.stringify(connector)).not.toContain(third);
    }
    void deriveIdentityFingerprint;
  });
});

describe("markdown connector bounded search retention", () => {
  function trackRetention() {
    let peak = 0;
    let calls = 0;
    let lastLimit = 0;
    const onSearchRetained = (retained: number, limit: number): void => {
      calls += 1;
      lastLimit = limit;
      if (retained > peak) peak = retained;
      expect(Number.isInteger(retained)).toBe(true);
      expect(retained).toBeGreaterThanOrEqual(0);
      expect(retained).toBeLessThanOrEqual(limit);
    };
    return { onSearchRetained, stats: () => ({ peak, calls, lastLimit }) };
  }

  it("retains at most the default 10 across many matching docs", async () => {
    const dir = scratchVault("md-conn-retain10-");
    for (let i = 0; i < 30; i += 1) {
      const name = `r${String(i).padStart(2, "0")}.md`;
      writeFileSync(join(dir, name), "# T\nretainme body\n");
    }
    const tracker = trackRetention();
    const connector = await createMarkdownConnector([{ path: dir }], {
      onSearchRetained: tracker.onSearchRetained,
    });
    const result = await connector.search({ query: "retainme" });
    expect(result.hits).toHaveLength(10);
    expect(result.hits.map((hit) => hit.canonicalKey)).toEqual(
      Array.from({ length: 10 }, (_, i) => `vault-1/r${String(i).padStart(2, "0")}.md`),
    );
    const { peak, calls, lastLimit } = tracker.stats();
    expect(calls).toBeGreaterThan(0);
    expect(lastLimit).toBe(10);
    expect(peak).toBeLessThanOrEqual(10);
    expect(peak).toBe(10);
    expect(result.skipped).toEqual([]);
  });

  it("retains at most the max 20 and matches full sort+slice order", async () => {
    const dir = scratchVault("md-conn-retain20-");
    for (let i = 0; i < 35; i += 1) {
      const name = `s${String(i).padStart(2, "0")}.md`;
      writeFileSync(join(dir, name), "# T\nretainmax body\n");
    }
    const tracker = trackRetention();
    const connector = await createMarkdownConnector([{ path: dir }], {
      onSearchRetained: tracker.onSearchRetained,
    });
    const result = await connector.search({ query: "retainmax", limit: 20 });
    expect(result.hits).toHaveLength(20);
    // Same rank for every doc, so canonical-key code-unit order is exact.
    const keys = result.hits.map((hit) => hit.canonicalKey);
    expect(keys).toEqual([...keys].sort());
    expect(keys[0]).toBe("vault-1/s00.md");
    const { peak, lastLimit } = tracker.stats();
    expect(lastLimit).toBe(20);
    expect(peak).toBeLessThanOrEqual(20);
    expect(peak).toBe(20);
    // Every retained hit keeps exact link metadata and query snippets.
    for (const hit of result.hits) {
      expect(hit.snippet).toContain("retainmax");
      expect(hit.text).toContain("retainmax");
      expect(hit.sourceRevision).toBe(sha256Hex(hit.text));
      expect(hit.standardLinks).toEqual([]);
      expect(hit.wikiLinks).toEqual([]);
    }
  });

  it("bounds near-1MiB matches and keeps every skipped entry complete", async () => {
    const dir = scratchVault("md-conn-retainbig-");
    // Just under 1MiB per file (no multi-GiB allocation: 12 x ~1MiB).
    const filler = "x".repeat(500_000);
    for (let i = 0; i < 12; i += 1) {
      const name = `b${String(i).padStart(2, "0")}.md`;
      writeFileSync(join(dir, name), `# T\n${filler} bigretain ${filler}\n`);
    }
    writeFileSync(join(dir, "big.md"), `${"z".repeat(MAX_FILE_BYTES + 1)}`);
    writeFileSync(join(dir, "bad.md"), Buffer.from([0xff, 0xfe, 0x41]));
    const tracker = trackRetention();
    const connector = await createMarkdownConnector([{ path: dir }], {
      onSearchRetained: tracker.onSearchRetained,
    });
    const result = await connector.search({ query: "bigretain", limit: 5 });
    expect(result.hits).toHaveLength(5);
    expect(result.hits.map((hit) => hit.canonicalKey)).toEqual([
      "vault-1/b00.md",
      "vault-1/b01.md",
      "vault-1/b02.md",
      "vault-1/b03.md",
      "vault-1/b04.md",
    ]);
    // Skipped entries remain complete, sorted, and untruncated by the limit.
    expect(result.skipped).toEqual([
      { canonicalKey: "vault-1/bad.md", reason: "invalid_utf8" },
      { canonicalKey: "vault-1/big.md", reason: "file_too_large" },
    ]);
    const { peak, lastLimit } = tracker.stats();
    expect(lastLimit).toBe(5);
    expect(peak).toBeLessThanOrEqual(5);
    expect(peak).toBe(5);
  });
});
