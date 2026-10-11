// Active-run reload-recovery DTO (C06, additive §16.7 projection):
// strict active-only Run shape, terminals and inactive shapes rejected.

import { describe, expect, it } from "vitest";
import { ActiveRunResponseSchema } from "../src/index.js";

const UUID_A = "726e0b70-51f7-4d9f-8f0b-100000000001";
const UUID_B = "726e0b70-51f7-4d9f-8f0b-100000000002";

describe("ActiveRunResponseSchema", () => {
  it("accepts every active status with strict integer eventSeq and ids", () => {
    for (const status of ["queued", "running", "cancel_requested"]) {
      const parsed = ActiveRunResponseSchema.parse({
        run: { id: UUID_A, turnId: UUID_B, status, eventSeq: 2 },
      });
      expect(parsed.run).toEqual({
        id: UUID_A,
        turnId: UUID_B,
        status,
        eventSeq: 2,
      });
    }
    expect(ActiveRunResponseSchema.parse({ run: null }).run).toBeNull();
  });

  it("rejects terminal statuses", () => {
    for (const status of ["completed", "failed", "cancelled", "abandoned"]) {
      expect(
        ActiveRunResponseSchema.safeParse({
          run: { id: UUID_A, turnId: UUID_B, status, eventSeq: 4 },
        }).success,
      ).toBe(false);
    }
  });

  it("rejects bad ids, negative/fractional eventSeq, and extra keys", () => {
    expect(
      ActiveRunResponseSchema.safeParse({
        run: { id: "nope", turnId: UUID_B, status: "running", eventSeq: 2 },
      }).success,
    ).toBe(false);
    expect(
      ActiveRunResponseSchema.safeParse({
        run: { id: UUID_A, turnId: UUID_B, status: "running", eventSeq: -1 },
      }).success,
    ).toBe(false);
    expect(
      ActiveRunResponseSchema.safeParse({
        run: { id: UUID_A, turnId: UUID_B, status: "running", eventSeq: 1.5 },
      }).success,
    ).toBe(false);
    expect(
      ActiveRunResponseSchema.safeParse({
        run: {
          id: UUID_A,
          turnId: UUID_B,
          status: "running",
          eventSeq: 2,
          extra: true,
        },
      }).success,
    ).toBe(false);
    expect(
      ActiveRunResponseSchema.safeParse({ run: {}, next: 1 }).success,
    ).toBe(false);
  });
});
