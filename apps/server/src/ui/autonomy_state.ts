// AV autonomy panel state decisions (DOM-free, unit-tested).
//
// The browser panel (`client.ts`) renders plain DOM and cannot run under
// node, so every branchable autonomy-panel decision lives here as a pure
// function pinned by `test/autonomy_state.test.ts`. DOM code must call
// these instead of inlining the decision.

/** Global stop-control mutation path (session-independent). */
export const AUTONOMY_CONTROL_ENDPOINT = "/api/autonomy/control";

/**
 * Whether a retried frozen command also changes global control state.
 * A successful retry of the control endpoint must refresh the control
 * view + version alongside the session lists; otherwise the next
 * Stop/Resume submits the stale `expectedVersion` and gets a 409.
 */
export function retryRefreshesControl(endpoint: string): boolean {
  return endpoint === AUTONOMY_CONTROL_ENDPOINT;
}

/**
 * Revalidate an armed conflict purpose against the fresh active set.
 * The purpose list contains inactive rows too, so mere presence in the
 * version map does NOT prove the arm is still submittable: an arm that
 * is no longer active must be dropped (the user re-arms a live pair).
 */
export function revalidateConflictArm(
  arm: string | null,
  activeIds: ReadonlySet<string>,
): string | null {
  if (arm !== null && !activeIds.has(arm)) {
    return null;
  }
  return arm;
}

/**
 * Whether a rejected conflict pair must reset the armed purpose.
 * The server rejects pairs with an inactive member (409
 * autonomy_state_conflict); keeping the dead arm would trap every later
 * pair on the same inactive purpose with no UI way out short of reload.
 */
export function shouldResetConflictArm(status: number): boolean {
  return status === 409;
}
