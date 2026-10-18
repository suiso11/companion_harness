// Per-run memory status surface (I01-06, additive): optional nullable
// `memoryStatus` on the existing run status view — metadata only, closed
// union, core frozen fields unchanged.

import { describe, expect, it } from "vitest";
import { RunStatusResponseSchema } from "../src/index.js";

const UUID_A = "726e0b70-51f7-4d9f-8f0b-100000000001";

describe("RunStatusResponseSchema.memoryStatus (I01-06)", () => {
  it("accepts the frozen shape without a memoryStatus (old clients/rows)", () => {
    const parsed = RunStatusResponseSchema.parse({
      run: { id: UUID_A, status: "running", eventSeq: 2 },
    });
    expect(parsed.run).toEqual({ id: UUID_A, status: "running", eventSeq: 2 });
  });

  it("accepts every closed memory status plus null", () => {
    for (const memoryStatus of [
      "used",
      "empty",
      "disabled",
      "unavailable",
      "timeout",
      "version_mismatch",
      "limit",
      null,
    ]) {
      const parsed = RunStatusResponseSchema.parse({
        run: { id: UUID_A, status: "completed", eventSeq: 9, memoryStatus },
      });
      expect(parsed.run.memoryStatus).toBe(memoryStatus);
    }
  });

  it("rejects unknown statuses and extra keys (strict, additive only)", () => {
    expect(
      RunStatusResponseSchema.safeParse({
        run: {
          id: UUID_A,
          status: "running",
          eventSeq: 2,
          memoryStatus: "facts",
        },
      }).success,
    ).toBe(false);
    expect(
      RunStatusResponseSchema.safeParse({
        run: {
          id: UUID_A,
          status: "running",
          eventSeq: 2,
          memoryStatus: null,
          snippet: "never any content",
        },
      }).success,
    ).toBe(false);
  });
});
