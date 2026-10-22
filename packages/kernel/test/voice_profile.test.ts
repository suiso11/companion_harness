import { describe, expect, it } from "vitest";
import {
  checkVoiceAnswer,
  loadBundledVoiceProfile,
  parseVoiceProfile,
  voiceProfileFingerprint,
} from "../src/index.js";

describe("bundled shunkin voice profile", () => {
  it("loads the bundled profile with the verified format", () => {
    const profile = loadBundledVoiceProfile("shunkin");
    expect(profile.id).toBe("shunkin");
    expect(profile.version).toBe("4");
    expect(profile.displayName).toBe("春琴");
    expect(profile.rules.length).toBeGreaterThan(0);
    expect(profile.avoid.length).toBeGreaterThan(0);
    expect(profile.references.length).toBe(8);
    expect(profile.exemplars).toHaveLength(8);
    expect(profile.references[0]?.quote).toBe("佐助どんにしてほしい");
    expect(profile.references[7]?.quote).toBe("妾は盲人なれども鼻は確なり");
    expect(profile.avoid.join("\n")).toContain("でおます");
    expect(profile.rules.join("\n")).toContain("文全体の言い回し");
    expect(profile.rules.join("\n")).toContain("わて");
    expect(profile.rules.join("\n")).toContain("以下の通りです");
  });

  it("computes a stable version-fingerprint", () => {
    const first = loadBundledVoiceProfile();
    const second = loadBundledVoiceProfile("shunkin");
    expect(voiceProfileFingerprint(first)).toBe(
      voiceProfileFingerprint(second),
    );
    expect(voiceProfileFingerprint(first)).toMatch(/^4-[0-9a-f]{12}$/);
    const changed = parseVoiceProfile({
      ...first,
      description: `${first.description}!`,
    });
    expect(voiceProfileFingerprint(changed)).not.toBe(
      voiceProfileFingerprint(first),
    );
    const reordered = parseVoiceProfile(
      Object.fromEntries(Object.entries(first).reverse()),
    );
    expect(voiceProfileFingerprint(reordered)).toBe(
      voiceProfileFingerprint(first),
    );
  });

  it("bounds the declared version so the runtime version stays <= 64 chars", () => {
    const profile = loadBundledVoiceProfile();
    const base = { ...profile };
    expect(
      parseVoiceProfile({ ...base, version: "v".repeat(32) }).version,
    ).toHaveLength(32);
    expect(() =>
      parseVoiceProfile({ ...base, version: "v".repeat(33) }),
    ).toThrow();
    const runtime = voiceProfileFingerprint(
      parseVoiceProfile({ ...base, version: "v".repeat(32) }),
    );
    expect(runtime.length).toBeLessThanOrEqual(64);
  });

  it("rejects unknown or path-like bundled ids", () => {
    expect(() => loadBundledVoiceProfile("../shunkin")).toThrow();
    expect(() => loadBundledVoiceProfile("Shunkin")).toThrow();
    expect(() => loadBundledVoiceProfile("unknown")).toThrow();
  });

  it("keeps avoid-list surface forms out of every exemplar", () => {
    const profile = loadBundledVoiceProfile();
    const descriptive =
      /[「」（）()]|多用|など|代わりに|ユーザー|罵倒|暴力|過度|絵文字|作法|表現/;
    const plainForms = profile.avoid
      .filter((entry) => !descriptive.test(entry))
      .map((entry) => entry.replace(/^〜/, ""));
    expect(plainForms.length).toBeGreaterThan(0);
    for (const exemplar of profile.exemplars) {
      for (const form of plainForms) {
        expect(exemplar.voiced).not.toContain(form);
      }
    }
  });

  it("keeps every exemplar inside the structural gate", () => {
    const profile = loadBundledVoiceProfile();
    for (const exemplar of profile.exemplars) {
      expect(
        checkVoiceAnswer([exemplar.canonical], [exemplar.voiced]),
        exemplar.canonical,
      ).toBeNull();
    }
  });
});
