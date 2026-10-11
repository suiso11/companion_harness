/**
 * Real-vault expanded link graph budget boundaries (agreed, plan §14.6:
 * exactly 256KiB / 262144 UTF-8 bytes of normalized graph metadata per
 * logical call, canonical JSON framing).
 *
 * Unlike `link_budget.test.ts` (pure framing vectors) and the kernel fake
 * port tests, every case here drives the ACTUAL connector over a small
 * deterministic temp vault: real discovery, safe reads, and incremental
 * budget enforcement during link resolution. Fixtures stay small and fast:
 * repeated unresolved same-target links exercise the metadata cache, and
 * the ambiguous case uses a modest bounded set of same-basename target
 * files with long deterministic canonical keys (not thousands of files,
 * and not body/URL/path padding). All temp dirs are removed in `finally`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMarkdownConnector } from "../src/connector.js";
import { measureLinkGraphBytes } from "../src/link_budget.js";

const CAP = 262_144;

function scratchVault(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function removeVault(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** Body with `count` repeated unresolved standard links to one missing target. */
function unresolvedBody(marker: string, count: number): string {
  const links = Array.from({ length: count }, () => "[l](./missing.md)").join(
    "\n",
  );
  return `# Doc\n${marker} body\n${links}\n`;
}

describe("real vault graph budget boundaries", () => {
  it("accepts >1024 compact links under cap via search and read", async () => {
    const dir = scratchVault("md-graph-under-");
    try {
      writeFileSync(join(dir, "doc.md"), unresolvedBody("budgetmarker", 1100));
      const connector = await createMarkdownConnector([{ path: dir }]);
      const result = await connector.search({
        query: "budgetmarker",
        limit: 10,
      });
      expect(result.hits).toHaveLength(1);
      expect(result.hits[0]?.standardLinks).toHaveLength(1100);
      expect(result.hits[0]?.canonicalKey).toBe("vault-1/doc.md");
      const doc = await connector.readCanonical("vault-1/doc.md");
      expect(doc.standardLinks).toHaveLength(1100);
      expect(doc.text).toContain("budgetmarker");
      // Canonical framing for the presented batch stays under the cap.
      const entries = doc.standardLinks.map((_, index) => ({
        kind: "standard" as const,
        status: "unresolved" as const,
        candidates: [] as readonly string[],
        ordinal: index + 1,
      }));
      expect(measureLinkGraphBytes(entries)).toBeLessThan(CAP);
    } finally {
      removeVault(dir);
    }
  });

  it("rejects an aggregate multi-hit overflow but succeeds with limit 1 (evicted hits cost nothing)", async () => {
    const dir = scratchVault("md-graph-agg-");
    try {
      // Each document alone is below the cap (~2000 * ~70B ≈ 140KiB) but the
      // two-hit batch (~280KiB) exceeds it.
      writeFileSync(join(dir, "a.md"), unresolvedBody("aggmarker", 2000));
      writeFileSync(join(dir, "b.md"), unresolvedBody("aggmarker", 2000));
      const connector = await createMarkdownConnector([{ path: dir }]);
      await expect(
        connector.search({ query: "aggmarker", limit: 10 }),
      ).rejects.toMatchObject({ code: "output_too_large" });
      // Identical call narrowed to the top hit fits: the evicted second hit
      // is released before phase-2 link resolution and consumes no budget.
      const one = await connector.search({ query: "aggmarker", limit: 1 });
      expect(one.hits).toHaveLength(1);
      expect(one.hits[0]?.canonicalKey).toBe("vault-1/a.md");
      expect(one.hits[0]?.standardLinks).toHaveLength(2000);
    } finally {
      removeVault(dir);
    }
  });

  it("ignores large nonmatching docs for the link budget", async () => {
    const dir = scratchVault("md-graph-nonmatch-");
    try {
      writeFileSync(join(dir, "small.md"), unresolvedBody("smallmarker", 10));
      // Large vault file that never matches: 3800 links would overflow alone,
      // but a non-hit is discarded before phase-2 resolution.
      const noisy = `# Noisy\nunrelated content\n${Array.from(
        { length: 3800 },
        () => "[l](./missing.md)",
      ).join("\n")}\n`;
      writeFileSync(join(dir, "noisy.md"), noisy);
      const connector = await createMarkdownConnector([{ path: dir }]);
      const result = await connector.search({
        query: "smallmarker",
        limit: 10,
      });
      expect(result.hits.map((hit) => hit.canonicalKey)).toEqual([
        "vault-1/small.md",
      ]);
      expect(result.hits[0]?.standardLinks).toHaveLength(10);
    } finally {
      removeVault(dir);
    }
  });

  it("rejects a single-document readCanonical overflow with output_too_large", async () => {
    const dir = scratchVault("md-graph-read-");
    try {
      writeFileSync(join(dir, "big.md"), unresolvedBody("readmarker", 4100));
      const connector = await createMarkdownConnector([{ path: dir }]);
      await expect(
        connector.readCanonical("vault-1/big.md"),
      ).rejects.toMatchObject({ code: "output_too_large" });
      await expect(
        connector.search({ query: "readmarker", limit: 10 }),
      ).rejects.toMatchObject({ code: "output_too_large" });
    } finally {
      removeVault(dir);
    }
  });

  it("rejects repeated ambiguous wiki links without partial output (repeats charged per occurrence) while an undersized pair stays under cap", async () => {
    const dir = scratchVault("md-graph-amb-");
    try {
      // Bounded vault: 16 same-basename targets with long deterministic
      // directory names. Every [[Note]] is ambiguous over 16 sorted
      // canonical candidates whose normalized metadata is wide on its own
      // (one 16-candidate entry ≈ 1983 UTF-8 bytes), so 160 repeats exceed
      // the 256KiB cap without thousands of files or any body/URL/path
      // padding: only the real resolved candidate keys are charged.
      const targetCount = 16;
      const targetDirs: string[] = [];
      for (let index = 0; index < targetCount; index += 1) {
        const name = `d${String(index).padStart(3, "0")}_${"x".repeat(96)}`;
        targetDirs.push(name);
        mkdirSync(join(dir, name), { recursive: true });
        writeFileSync(
          join(dir, name, "Note.md"),
          `# Note ${name}\ndup content\n`,
        );
      }
      const expectedCandidates = targetDirs
        .map((name) => `vault-1/${name}/Note.md`)
        .sort();
      const repeats = 160;
      const wikiLinks = Array.from({ length: repeats }, () => "[[Note]]").join(
        "\n",
      );
      writeFileSync(
        join(dir, "main.md"),
        `# Main\nambmarker body\n${wikiLinks}\n`,
      );
      // Undersized control in the SAME fixture: two ambiguous [[Note]] links
      // and no ambiguous-marker text (so it is never the queried hit). It
      // proves the consumer still returns real normalized metadata rather
      // than a blanket `output_too_large`.
      writeFileSync(
        join(dir, "control.md"),
        "# Control\nsafe body\n[[Note]]\n[[Note]]\n",
      );
      const connector = await createMarkdownConnector([{ path: dir }]);
      // 160 x 16-candidate ambiguous entries ≈ 317653 bytes > 262144: the
      // whole call fails, never a truncated partial hit list.
      await expect(
        connector.search({ query: "ambmarker", limit: 10 }),
      ).rejects.toMatchObject({ code: "output_too_large" });
      await expect(
        connector.readCanonical("vault-1/main.md"),
      ).rejects.toMatchObject({ code: "output_too_large" });

      // Control proof on ACTUAL consumer output: two ambiguous wiki links
      // with the exact sorted 16 canonical candidates and 1-based per-source
      // ordinals stay under the cap. Assertions read the real `wikiLinks`
      // (status + candidates), not a hand-built helper vector.
      const control = await connector.readCanonical("vault-1/control.md");
      expect(control.wikiLinks).toHaveLength(2);
      const controlEntries = control.wikiLinks.map((link, index) => {
        expect(link.status).toBe("ambiguous");
        expect(link.candidates).toEqual(expectedCandidates);
        return {
          kind: "wiki" as const,
          status: link.status,
          candidates: link.candidates,
          ordinal: index + 1,
        };
      });
      expect(measureLinkGraphBytes(controlEntries)).toBeLessThan(CAP);

      // Under-cap standard-link pair: each source document's two repeats
      // resolve independently to the same real canonical target.
      const smallDir = scratchVault("md-graph-ord-");
      try {
        writeFileSync(join(smallDir, "t.md"), "# T\nordmarker\n");
        writeFileSync(
          join(smallDir, "s1.md"),
          "# S1\nordmarker\n[T](./t.md)\n[T](./t.md)\n",
        );
        writeFileSync(
          join(smallDir, "s2.md"),
          "# S2\nordmarker\n[T](./t.md)\n[T](./t.md)\n",
        );
        const small = await createMarkdownConnector([{ path: smallDir }]);
        const found = await small.search({ query: "ordmarker", limit: 10 });
        const hits = found.hits.filter(
          (hit) =>
            hit.canonicalKey.endsWith("s1.md") ||
            hit.canonicalKey.endsWith("s2.md"),
        );
        expect(hits).toHaveLength(2);
        for (const hit of hits) {
          expect(hit.standardLinks).toHaveLength(2);
          for (const link of hit.standardLinks) {
            expect(link.status).toBe("resolved");
            expect(link.canonicalKey).toBe("vault-1/t.md");
          }
        }
      } finally {
        removeVault(smallDir);
      }
    } finally {
      removeVault(dir);
    }
  });
});
