import { describe, expect, it } from "vitest";
import {
  buildRunResultV2,
  parseRunResult,
  RunResultV1Schema,
  RunResultV2Schema,
  VOICE_PROFILE_ID_REGEX,
  VOICE_RENDER_REASONS,
  VoiceRenderSchema,
} from "../src/index.js";

function answer(
  texts: string | string[] = ["hello"],
  citations: string[][] = [],
) {
  const parts = typeof texts === "string" ? [texts] : texts;
  return {
    version: 1 as const,
    parts: parts.map((text, index) => ({
      text,
      citations: citations[index] ?? [],
    })),
  };
}

function rendered(parts: string[]) {
  return {
    profileId: "shunkin",
    profileVersion: "1-0123456789ab",
    status: "rendered" as const,
    parts: parts.map((text) => ({ text })),
  };
}

describe("VoiceRender contract", () => {
  it("keeps voice optional so historical V2 rows still parse", () => {
    const row = buildRunResultV2(answer("hello"));
    expect("voice" in row).toBe(false);
    expect(parseRunResult(row)).toEqual(row);
    expect(RunResultV2Schema.parse(row)).toEqual(row);
  });

  it("accepts a rendered voice aligned one-to-one with answer parts", () => {
    const canonical = answer(["hello", "bye"]);
    const voice = rendered(["こんにちは", "さようなら"]);
    const row = buildRunResultV2(canonical, voice);
    expect(row.voice).toEqual(voice);
    expect(parseRunResult(JSON.parse(JSON.stringify(row)))).toEqual(row);
  });

  it("requires reason iff non-rendered and parts iff rendered", () => {
    expect(() =>
      VoiceRenderSchema.parse({
        profileId: "shunkin",
        profileVersion: "1",
        status: "rendered",
      }),
    ).toThrow();
    expect(() =>
      VoiceRenderSchema.parse({
        profileId: "shunkin",
        profileVersion: "1",
        status: "rendered",
        reason: "error",
        parts: [{ text: "x" }],
      }),
    ).toThrow();
    expect(() =>
      VoiceRenderSchema.parse({
        profileId: "shunkin",
        profileVersion: "1",
        status: "fallback",
        parts: [{ text: "x" }],
      }),
    ).toThrow();
    expect(
      VoiceRenderSchema.parse({
        profileId: "shunkin",
        profileVersion: "1",
        status: "skipped",
        reason: "cancelled",
      }),
    ).toEqual({
      profileId: "shunkin",
      profileVersion: "1",
      status: "skipped",
      reason: "cancelled",
    });
    for (const reason of VOICE_RENDER_REASONS) {
      expect(
        VoiceRenderSchema.parse({
          profileId: "shunkin",
          profileVersion: "1",
          status: "fallback",
          reason,
        }).reason,
      ).toBe(reason);
    }
  });

  it("rejects rendered parts length mismatch with the answer", () => {
    expect(() =>
      buildRunResultV2(answer(["a", "b"]), rendered(["only one"])),
    ).toThrow();
  });

  it("enforces profile id/version and voice part bounds", () => {
    expect(VOICE_PROFILE_ID_REGEX.test("shunkin")).toBe(true);
    expect(VOICE_PROFILE_ID_REGEX.test("Shunkin")).toBe(false);
    expect(VOICE_PROFILE_ID_REGEX.test("-shunkin")).toBe(false);
    expect(VOICE_PROFILE_ID_REGEX.test("a".repeat(33))).toBe(false);
    expect(
      VoiceRenderSchema.safeParse({
        profileId: "Shunkin",
        profileVersion: "1",
        status: "fallback",
        reason: "error",
      }).success,
    ).toBe(false);
    expect(
      VoiceRenderSchema.safeParse({
        profileId: "shunkin",
        profileVersion: "",
        status: "fallback",
        reason: "error",
      }).success,
    ).toBe(false);
    expect(
      VoiceRenderSchema.safeParse({
        profileId: "shunkin",
        profileVersion: "v".repeat(65),
        status: "fallback",
        reason: "error",
      }).success,
    ).toBe(false);
    expect(
      VoiceRenderSchema.safeParse({
        profileId: "shunkin",
        profileVersion: "1",
        status: "rendered",
        parts: [{ text: "" }],
      }).success,
    ).toBe(false);
    expect(
      VoiceRenderSchema.safeParse({
        profileId: "shunkin",
        profileVersion: "1",
        status: "rendered",
        parts: [{ text: "あ".repeat(8001) }],
      }).success,
    ).toBe(false);
    expect(
      VoiceRenderSchema.safeParse({
        profileId: "shunkin",
        profileVersion: "1",
        status: "rendered",
        parts: [{ text: "x", extra: true }],
      }).success,
    ).toBe(false);
  });

  it("keeps text canonical even when voice is present", () => {
    expect(() =>
      RunResultV2Schema.parse({
        version: 2,
        text: "tampered",
        answer: answer(["hello"]),
        voice: rendered(["こんにちは"]),
      }),
    ).toThrow();
  });

  it("keeps frozen V1 rows strict (voice is not a V1 field)", () => {
    expect(RunResultV1Schema.parse({ version: 1, text: "done" })).toEqual({
      version: 1,
      text: "done",
    });
    expect(() =>
      RunResultV1Schema.parse({
        version: 1,
        text: "done",
        voice: rendered(["できました"]),
      }),
    ).toThrow();
  });
});
