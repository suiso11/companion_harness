// Fixed loopback ports for the E2E fake-server harness.
//
// The main app port must match `playwright.config.ts` (webServer.url and
// baseURL). The control port exposes an in-process test-only channel the
// specs use to arm failure injection and release hanging strategies.

export const E2E_APP_PORT = 4173;
export const E2E_CONTROL_PORT = 4174;
/** Loopback SSE-fault proxy: forwards 1:1 to the app, can drop streams/frames. */
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
/**
 * Stored snapshot body text seeded for the citation drawer test. Contains
 * markup-significant characters so the spec can prove escaped plain-text
 * rendering (never HTML interpretation, never script execution).
 */
export const CITATION_SNAPSHOT_TEXT =
  '<script>alert("e2e-xss")</script> & <b>bold</b> \'quotes\' "dq" r1-body';
/** Fixture prefix for seeded older-history turns (`${prefix}-NNN`). */
export const SEED_HISTORY_PREFIX = "seedhist";
/** Turns seeded for the older-history spec (above the default page 50). */
export const SEED_HISTORY_COUNT = 60;
