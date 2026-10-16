// Fixed loopback ports for the memory-management real-browser E2E harness
// (deliberately ISOLATED from the existing M3 e2e harness):
//
//   4187  MEMORY_APP_PORT      Real production server via `startServer` with
//                              COMPANION_MEMORY_JSON (REAL remind CLI temp
//                              DB) + synthetic scripted gateway (NOT a real
//                              model). No markdown roots, no calendar.
//   4188  MEMORY_CONTROL_PORT  Loopback-only in-process control
//                              (fixture reset / health).

export const MEMORY_APP_PORT = 4187;
export const MEMORY_CONTROL_PORT = 4188;

export const MEMORY_APP_ORIGIN = `http://127.0.0.1:${MEMORY_APP_PORT}`;
export const MEMORY_CONTROL_ORIGIN = `http://127.0.0.1:${MEMORY_CONTROL_PORT}`;

/** Conversation text that cultivates the "green tea" memory. */
export const MEMORY_TURN_TEXT = "I like green tea.";
/** Corrected replacement body asserted after the correct step. */
export const MEMORY_CORRECTED_BODY = "user likes green tea, decaf only";
