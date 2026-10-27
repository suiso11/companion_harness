import { describe, expect, it } from "vitest";
import { PurposeViewSchema } from "../src/autonomy.js";

const base = {
  id: "00000000-0000-4000-8000-000000000001",
  sessionId: "00000000-0000-4000-8000-000000000002",
  scope: "s1",
  statement: "ship it",
  kind: "goal",
  explicit: true,
  sourceKind: "user",
  sourceTurnId: null,
  interpretation: null,
  status: "active",
  version: 2,
  supersededBy: null,
  validFrom: null,
  validUntil: null,
  constraintRule: null,
  createdAt: 1_750_000_000_000,
  updatedAt: 1_750_000_000_001,
};

describe("purpose confirmation provenance DTO", () => {
  it("exposes confirmedFrom/confirmedAt when present", () => {
    const parsed = PurposeViewSchema.parse({
      ...base,
      confirmedFrom: "conversation_proposal",
      confirmedAt: 1_750_000_000_002,
    });
    expect(parsed.confirmedFrom).toBe("conversation_proposal");
    expect(parsed.confirmedAt).toBe(1_750_000_000_002);
  });

  it("defaults both provenance fields to null for unconfirmed rows", () => {
    const parsed = PurposeViewSchema.parse({ ...base, explicit: false });
    expect(parsed.confirmedFrom).toBeNull();
    expect(parsed.confirmedAt).toBeNull();
  });
});
