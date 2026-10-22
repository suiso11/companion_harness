// Fixed loopback ports for the E2E fake-server harness.
//
// The main app port must match `playwright.config.ts` (webServer.url and
// baseURL). The control port exposes an in-process test-only channel the
// specs use to arm failure injection and release hanging strategies.

export const E2E_APP_PORT = 4173;
export const E2E_CONTROL_PORT = 4174;
/** Loopback transport-fault proxy: forwards real responses; holds/fails/drops/duplicates. */
export const E2E_PROXY_PORT = 4175;

export const E2E_APP_ORIGIN = `http://127.0.0.1:${E2E_APP_PORT}`;
export const E2E_CONTROL_ORIGIN = `http://127.0.0.1:${E2E_CONTROL_PORT}`;
export const E2E_PROXY_ORIGIN = `http://127.0.0.1:${E2E_PROXY_PORT}`;

/** Input text that resolves immediately with the deterministic echo answer. */
export const TEXT_OK = "ping";
/** Input text whose strategy fails once when failure injection is armed. */
export const TEXT_FAIL = "fail";
/** Input text whose strategy hangs until released or aborted. */
export const TEXT_HANG = "hang";
/** Input text whose strategy answers V2 with a structural r1 citation. */
export const TEXT_CITE = "cite-me";
/** Input text whose strategy answers V2 with structural r1+r2 citations. */
export const TEXT_CITE_TWO = "cite-two";
/** Input text whose fake strategy streams reasoning deltas + usage before answering. */
export const TEXT_THINK = "think-stream";
/** Input text exercising ephemeral reasoning deltas plus durable tool events. */
export const TEXT_THINK_TOOLS = "think-tools";
/** Input text whose strategy answers V2 with a structural m1 citation. */
export const TEXT_CITE_MEM = "cite-mem";
/** Input text whose fake strategy renders a voice projection (voice spec). */
export const TEXT_VOICE = "voice-render";
/** Canonical answer text the voice spec toggles away from. */
export const VOICE_CANONICAL_TEXT = "明日の天気は晴れです[r1]。";
/** Voiced projection accepted by the production gate (same r1 marker). */
export const VOICE_RENDERED_TEXT = "明日の天気は晴れでござります[r1]。";
/** Input text whose fake strategy streams draft deltas, then a V2 cited answer. */
export const TEXT_DRAFT = "draft-stream";
/** Input text whose strategy records durable `web.search` tool events. */
export const TEXT_WEB_SEARCH = "web-search";
/** Input text whose fake strategy streams step-1 then step-2 drafts (restart). */
export const TEXT_DRAFT_STEPS = "draft-steps";
/** Input text whose fake strategy streams a draft then hangs until cancel. */
export const TEXT_DRAFT_CANCEL = "draft-cancel";
/** Input text whose fake strategy streams a draft slowly (reload recovery). */
export const TEXT_DRAFT_RELOAD = "draft-reload";
/**
 * Stored snapshot body text seeded for the citation drawer test. Contains
 * markup-significant characters so the spec can prove escaped plain-text
 * rendering (never HTML interpretation, never script execution).
 */
export const CITATION_SNAPSHOT_TEXT =
  '<script>alert("e2e-xss")</script> & <b>bold</b> \'quotes\' "dq" r1-body';
/** Second distinct stored snapshot body for deterministic rA/rB races. */
export const CITATION_SNAPSHOT_TEXT_B =
  "<i>r2-body</i> & 'second' \"snapshot\" plain-only";
/** Fixture prefix for seeded older-history turns (`${prefix}-NNN`). */
export const SEED_HISTORY_PREFIX = "seedhist";
/** Turns seeded for the older-history spec (above the default page 50). */
export const SEED_HISTORY_COUNT = 60;
