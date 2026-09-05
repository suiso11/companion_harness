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
 * the ambiguous case uses 150-200 basename targets (not thousands of
 * files). All temp dirs are removed in `finally`.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMarkdownConnector } from "../src/connector.js";
import {
  LINK_GRAPH_BUDGET_BYTES,
  measureLinkGraphBytes,
  serializeLinkGraphEntry,
} from "../src/link_budget.js";

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
      expect(LINK_GRAPH_BUDGET_BYTES).toBe(CAP);
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

  it("rejects repeated ambiguous wiki links without partial output; ordinals reset per source and repeats are charged per occurrence", async () => {
    const dir = scratchVault("md-graph-amb-");
    try {
      // Modest vault: 170 same-basename targets => every [[Note]] is
      // ambiguous over 170 sorted canonical candidates (~4KiB per entry).
      const targetCount = 170;
      for (let index = 0; index < targetCount; index += 1) {
        const name = `d${String(index).padStart(3, "0")}`;
        const { mkdirSync } = await import("node:fs");
        mkdirSync(join(dir, name), { recursive: true });
        writeFileSync(
          join(dir, name, "Note.md"),
          `# Note ${name}\ndup content\n`,
        );
      }
      const repeats = 80;
      const wikiLinks = Array.from({ length: repeats }, () => "[[Note]]").join(
        "\n",
      );
      writeFileSync(
        join(dir, "main.md"),
        `# Main\nambmarker body\n${wikiLinks}\n`,
      );
      const connector = await createMarkdownConnector([{ path: dir }]);
      // 80 * ~4KiB ≈ 320KiB > cap: the whole call fails, never a truncated
      // partial hit list.
      await expect(
        connector.search({ query: "ambmarker", limit: 10 }),
      ).rejects.toMatchObject({ code: "output_too_large" });
      await expect(
        connector.readCanonical("vault-1/main.md"),
      ).rejects.toMatchObject({ code: "output_too_large" });

      // Canonical framing proof on a small under-cap pair: repeated
      // candidates are charged per occurrence (no dedup) and each source
      // document restarts ordinals at 1.
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
        }
        // Per-source ordinal framing: entries restart at 1 for each source.
        const perSource = [1, 2].map((ordinal) => ({
          kind: "standard" as const,
          status: "resolved" as const,
          candidates: ["vault-1/t.md"] as readonly string[],
          ordinal,
        }));
        const both = [...perSource, ...perSource];
        expect(measureLinkGraphBytes(both)).toBeGreaterThan(
          measureLinkGraphBytes(perSource),
        );
        expect(
          serializeLinkGraphEntry({
            kind: "standard",
            status: "resolved",
            candidates: ["vault-1/t.md"],
            ordinal: 1,
          }),
        ).toBe(
          '{"candidates":["vault-1/t.md"],"kind":"standard","ordinal":1,"status":"resolved"}',
        );
      } finally {
        removeVault(smallDir);
      }
    } finally {
      removeVault(dir);
    }
  });
});
