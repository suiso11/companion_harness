// Fixed loopback ports for the E2E fake-server harness.
//
// The main app port must match `playwright.config.ts` (webServer.url and
// baseURL). The control port exposes an in-process test-only channel the
// specs use to arm failure injection and release hanging strategies.

export const E2E_APP_PORT = 4173;
export const E2E_CONTROL_PORT = 4174;

export const E2E_APP_ORIGIN = `http://127.0.0.1:${E2E_APP_PORT}`;
export const E2E_CONTROL_ORIGIN = `http://127.0.0.1:${E2E_CONTROL_PORT}`;

/** Input text that resolves immediately with the deterministic echo answer. */
export const TEXT_OK = "ping";
/** Input text whose strategy fails once when failure injection is armed. */
export const TEXT_FAIL = "fail";
/** Input text whose strategy hangs until released or aborted. */
export const TEXT_HANG = "hang";
