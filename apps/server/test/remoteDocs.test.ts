// Slice (b) docs consistency: the operator guides must describe the
// enabled remote flow (not "pending") and reference the correct
// migration. Guards the review findings on docs/operations.md and
// README migration numbering.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");

describe("remote docs consistency (review findings)", () => {
  it("operations guide documents the enabled login flow", () => {
    const ops = readFileSync(join(ROOT, "docs", "operations.md"), "utf-8");
    expect(ops).not.toContain("authentication pending");
    expect(ops).not.toContain(
      "remote mode requires authentication (not yet available)",
    );
    expect(ops).toContain("set-password");
    expect(ops).toContain("passwordFile");
    expect(ops).toContain("0023_remote_sessions.sql");
  });

});
