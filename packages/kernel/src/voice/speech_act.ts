// Deterministic speech-act and fidelity checks for the voice renderer.
//
// The renderer rewrites the canonical answer into a voice profile. A rewrite
// can keep every stylistic marker and still change what the sentence does:
// a first-person commitment (「まとめます」) becomes a request to the user
// (「まとめておくれやす」), a negation disappears, or a number changes. Marker
// rates and fallback rates cannot see that, so this module compares the
// canonical and voiced text directly.
//
// The checks are deliberately coarse. They are gates (precision over recall):
// a false positive only costs a fallback to the canonical answer, which is
// itself in-register.

/** Listener-directed act: the user is asked to do something. */
const LISTENER_ACT =
  /(?:て|で)(?:ください|おくれやす|くれる|くれ|いただけ|もらえ)|しとくれやす|とくれやす/;
/** Speaker-directed act: the assistant does something for the user. */
const SPEAKER_ACT = /(?:て|で)(?:あげる|やる)/;
/** Speaker receives the action (still speaker-directed). */
const SPEAKER_RECEIVE = /(?:て|で)(?:もらう|いただく)/;
/** Negation in any of the forms the profiles use. */
const NEGATION = /(?:ません|まへん|あらへん|おまへん|ない|ぬ|ず|せん|へん)/;
/** First-person commitment markers (「します」「まっさ」「したる」…). */
const COMMIT = /(?:ます|まっさ|したる|するよって|するで)/;

export type FidelityViolation =
  | "introduced_request"
  | "lost_request"
  | "direction_flip"
  | "negation_lost"
  | "negation_added"
  | "token_mismatch";

export interface FidelityResult {
  readonly violations: readonly FidelityViolation[];
  /** True when the voiced text keeps the canonical speech act and content. */
  readonly ok: boolean;
}

function tokens(text: string): string[] {
  const found = [
    ...text.matchAll(/\d+(?:[.,:]\d+)*/g),
    ...text.matchAll(/https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/g),
    ...text.matchAll(/\[[rm]\d+\]/g),
    ...text.matchAll(/`[^`]+`/g),
  ].map((match) => match[0]);
  return found.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Compare one canonical part with its voiced counterpart. Any violation is a
 * hard failure: the renderer must fall back to the canonical text.
 */
export function checkFidelity(
  canonical: string,
  voiced: string,
): FidelityResult {
  const violations: FidelityViolation[] = [];
  const canonicalListener = LISTENER_ACT.test(canonical);
  const voicedListener = LISTENER_ACT.test(voiced);
  const canonicalNegation = NEGATION.test(canonical);
  const voicedNegation = NEGATION.test(voiced);

  if (!canonicalListener && voicedListener) {
    violations.push("introduced_request");
  }
  if (canonicalListener && !voicedListener) {
    violations.push("lost_request");
  }
  if (
    (SPEAKER_ACT.test(canonical) && voicedListener) ||
    (SPEAKER_RECEIVE.test(canonical) && SPEAKER_ACT.test(voiced))
  ) {
    violations.push("direction_flip");
  }
  if (canonicalNegation && !voicedNegation) {
    violations.push("negation_lost");
  }
  if (!canonicalNegation && voicedNegation) {
    violations.push("negation_added");
  }
  const canonicalTokens = tokens(canonical);
  const voicedTokens = tokens(voiced);
  if (canonicalTokens.join("\n") !== voicedTokens.join("\n")) {
    violations.push("token_mismatch");
  }
  return { violations, ok: violations.length === 0 };
}

/** True when the text carries a first-person commitment marker. */
export function hasCommitment(text: string): boolean {
  return COMMIT.test(text);
}
