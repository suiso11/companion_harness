import { describe, expect, it } from "vitest";
import {
  buildRunResultV2,
  MAX_STRUCTURED_ANSWER_BYTES,
  parseM0RunEvent,
  parseM0RunEventPayload,
  parseM0RunResult,
  parseM1RunEvent,
  parseM1RunEventPayload,
  parseM2RunEvent,
  parseM2RunEventPayload,
  parseRunEvent,
  parseRunEventPayload,
  parseRunResult,
  RunResultSchema,
  RunResultV1Schema,
  RunResultV2Schema,
  renderRunResultText,
} from "../src/index.js";

const UUID = "123e4567-e89b-42d3-a456-426614174000";

function envelope(type: string, payload: unknown) {
  return {
    schemaVersion: 1,
    runId: UUID,
    seq: 1,
    createdAt: 1790000000000,
    type,
    payload,
  };
}

function answer(text = "hello", citations: string[] = []) {
  return { version: 1 as const, parts: [{ text, citations }] };
}

describe("RunResultV2 structured persistence (PR #4 r3943445771)", () => {
  it("freezes V1: exact keys only, rejects V2 shape", () => {
    expect(RunResultV1Schema.parse({ version: 1, text: "done" })).toEqual({
      version: 1,
      text: "done",
    });
    expect(() =>
      RunResultV1Schema.parse({ version: 1, text: "done", answer: answer() }),
    ).toThrow();
    expect(() =>
      RunResultV1Schema.parse({
        version: 2,
        text: "hello",
        answer: answer(),
      }),
    ).toThrow();
    expect(() => parseM0RunResult({ version: 1, text: "" })).toThrow();
  });

  it("renders deterministically as parts joined by blank lines", () => {
    expect(
      renderRunResultText({
        version: 1,
        parts: [
          { text: "a", citations: [] },
          { text: "b", citations: ["r1"] },
        ],
      }),
    ).toBe("a\n\nb");
  });

  it("builds V2 with exact part-to-citations mapping retained", () => {
    const built = buildRunResultV2(answer("hello", ["r1"]));
    expect(built).toEqual({
      version: 2,
      text: "hello",
      answer: answer("hello", ["r1"]),
    });
    expect(RunResultV2Schema.parse(built)).toEqual(built);
    expect(parseRunResult(built)).toEqual(built);
  });

  it("rejects text/answer mismatch (no silent citation drop)", () => {
    expect(() =>
      RunResultV2Schema.parse({
        version: 2,
        text: "tampered",
        answer: answer("hello", ["r1"]),
      }),
    ).toThrow();
  });

  it("revalidates exact answer bounds at the V2 layer", () => {
    // Empty part text rejected.
    expect(() =>
      RunResultV2Schema.parse({
        version: 2,
        text: "x",
        answer: { version: 1, parts: [{ text: "", citations: [] }] },
      }),
    ).toThrow();
    // Too many citations rejected.
    expect(() =>
      buildRunResultV2({
        version: 1,
        parts: [
          {
            text: "t",
            citations: ["r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9"],
          },
        ],
      }),
    ).toThrow();
    // Non-rN citation rejected.
    expect(() => buildRunResultV2(answer("t", ["bogus"]))).toThrow();
    // 16KiB whole-answer cap enforced (16384 accepted at schema layer only
    // via exact byte measure; here assert oversize is rejected).
    const big = "x".repeat(4000);
    const oversize = {
      version: 1 as const,
      parts: Array.from({ length: 20 }, () => ({
        text: big,
        citations: [] as string[],
      })),
    };
    expect(JSON.stringify(oversize).length).toBeGreaterThan(
      MAX_STRUCTURED_ANSWER_BYTES,
    );
    expect(() =>
      RunResultV2Schema.parse({
        version: 2,
        text: oversize.parts.map((p) => p.text).join("\n\n"),
        answer: oversize,
      }),
    ).toThrow();
  });

  it("latest parsing accepts V1 history and V2 rows; unknown versions rejected", () => {
    expect(parseRunResult({ version: 1, text: "old" })).toEqual({
      version: 1,
      text: "old",
    });
    const v2 = buildRunResultV2(answer("new", ["r2"]));
    expect(parseRunResult(v2)).toEqual(v2);
    expect(RunResultSchema.parse({ version: 1, text: "old" })).toEqual({
      version: 1,
      text: "old",
    });
    expect(() => parseRunResult({ version: 3, text: "x" })).toThrow();
    expect(() => parseRunResult({ text: "no-version" })).toThrow();
  });

  it("exact M0/M1 registries reject V2; latest/M2 accept V1 and V2", () => {
    const v1 = { version: 1, text: "old" };
    const v2 = buildRunResultV2(answer("new"));
    // Bare payload registries.
    expect(parseM0RunEventPayload("run.completed", { result: v1 })).toEqual({
      result: v1,
    });
    expect(() =>
      parseM0RunEventPayload("run.completed", { result: v2 }),
    ).toThrow();
    expect(() =>
      parseM1RunEventPayload("run.completed", { result: v2 }),
    ).toThrow();
    expect(parseM2RunEventPayload("run.completed", { result: v1 })).toEqual({
      result: v1,
    });
    expect(parseM2RunEventPayload("run.completed", { result: v2 })).toEqual({
      result: v2,
    });
    expect(parseRunEventPayload("run.completed", { result: v2 })).toEqual({
      result: v2,
    });
    // Full envelopes.
    expect(
      parseM0RunEvent(envelope("run.completed", { result: v1 })).type,
    ).toBe("run.completed");
    expect(() =>
      parseM0RunEvent(envelope("run.completed", { result: v2 })),
    ).toThrow();
    expect(() =>
      parseM1RunEvent(envelope("run.completed", { result: v2 })),
    ).toThrow();
    expect(
      parseM2RunEvent(envelope("run.completed", { result: v1 })).type,
    ).toBe("run.completed");
    expect(
      parseM2RunEvent(envelope("run.completed", { result: v2 })).type,
    ).toBe("run.completed");
    expect(parseRunEvent(envelope("run.completed", { result: v2 })).type).toBe(
      "run.completed",
    );
  });
});
