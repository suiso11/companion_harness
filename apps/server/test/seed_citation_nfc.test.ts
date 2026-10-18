// Seed-citation NFC regression (PR #39 codex P2): the e2e /seed-citation
// fixture must store the NFC-normalized snapshot body, matching the
// production SnapshotBodySchema invariant (decomposed input rejected).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SnapshotBodySchema } from "@companion/contracts";
import { describe, expect, it } from "vitest";

const DECOMPOSED = "école";
const NORMALIZED = DECOMPOSED.normalize("NFC");

function buildSeedBody(text: string): string {
  const normalized = text.normalize("NFC");
  // Mirrors apps/server/e2e/server.ts seed-citation serialization.
  return JSON.stringify({ version: 1, text: normalized });
}

describe("seed-citation NFC normalization", () => {
  it("rejects decomposed text but accepts the normalized seed body", () => {
    expect(DECOMPOSED).not.toBe(NORMALIZED);
    expect(() =>
      SnapshotBodySchema.parse({ version: 1, text: DECOMPOSED }),
    ).toThrow();
    const parsed = SnapshotBodySchema.parse(
      JSON.parse(buildSeedBody(DECOMPOSED)),
    );
    expect(parsed.text).toBe(NORMALIZED);
  });

  it("e2e seed fixture serializes the normalized snapshot text", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "..", "e2e", "server.ts"), "utf8");
    expect(source).toContain("text: normalized");
  });
});
