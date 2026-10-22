// Voice profile format + bundled profile loading (voice-core).
//
// A profile is immutable personality/rules data, never model-controlled at
// runtime. Bundled profiles live as JSON next to this module and are loaded
// by a validated slug, so a caller can never traverse outside `profiles/`.
// The runtime `profileVersion` is the base version plus a short canonical
// JSON fingerprint: editing any profile field changes the fingerprint while
// the human-readable version stays stable.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { canonicalJsonString, sha256Hex } from "../canonical.js";

/** Lowercase slug: starts with a letter, 1-32 chars total. */
export const VOICE_PROFILE_ID_REGEX = /^[a-z][a-z0-9-]{0,31}$/;

const VoiceProfileReferenceSchema = z.strictObject({
  quote: z.string().min(1),
  note: z.string().min(1),
});
export type VoiceProfileReference = z.infer<typeof VoiceProfileReferenceSchema>;

const VoiceProfileExemplarSchema = z.strictObject({
  canonical: z.string().min(1),
  voiced: z.string().min(1),
});
export type VoiceProfileExemplar = z.infer<typeof VoiceProfileExemplarSchema>;

/** Strict on-disk profile format (unknown keys rejected). */
export const VoiceProfileSchema = z.strictObject({
  id: z.string().regex(VOICE_PROFILE_ID_REGEX, {
    message: "voice profile id must be a lowercase slug",
  }),
  // The runtime version appends "-" plus a 12-hex fingerprint, so bounding
  // the declared version at 32 keeps every runtime version within 64 chars.
  version: z.string().min(1).max(32),
  displayName: z.string().min(1),
  description: z.string().min(1),
  rules: z.array(z.string().min(1)).min(1),
  avoid: z.array(z.string().min(1)),
  references: z.array(VoiceProfileReferenceSchema),
  exemplars: z.array(VoiceProfileExemplarSchema),
});
export type VoiceProfile = z.infer<typeof VoiceProfileSchema>;

/** Parse an unknown profile payload; rejects unknown keys and empty rules. */
export function parseVoiceProfile(data: unknown): VoiceProfile {
  return VoiceProfileSchema.parse(data);
}

/**
 * Runtime version string: `<version>-<first 12 hex chars of sha256(canonical
 * JSON)>`. Canonical JSON sorts keys, so the fingerprint is stable across
 * reads and independent of on-disk key order, but changes with any content
 * edit.
 */
export function voiceProfileFingerprint(profile: VoiceProfile): string {
  return `${profile.version}-${sha256Hex(canonicalJsonString(profile)).slice(0, 12)}`;
}

/** Load and validate a profile JSON file from an explicit path or URL. */
export function loadVoiceProfileFile(path: string | URL): VoiceProfile {
  return parseVoiceProfile(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

/** Bundled profile ids shipped with the kernel (closed set). */
export const BUNDLED_VOICE_PROFILE_IDS = ["shunkin"] as const;
export type BundledVoiceProfileId = (typeof BUNDLED_VOICE_PROFILE_IDS)[number];
export const DEFAULT_VOICE_PROFILE_ID = "shunkin" as const;

/**
 * Load a bundled profile by id. The slug regex is authoritative: unknown or
 * path-like ids are rejected before any filesystem access.
 */
export function loadBundledVoiceProfile(
  id: string = DEFAULT_VOICE_PROFILE_ID,
): VoiceProfile {
  if (!VOICE_PROFILE_ID_REGEX.test(id)) {
    throw new Error("invalid voice profile id");
  }
  const url = new URL(`./profiles/${id}.json`, import.meta.url);
  return loadVoiceProfileFile(fileURLToPath(url));
}
