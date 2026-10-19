// AV autonomy panel state decisions: pure DOM-free helpers the browser
// panel calls instead of inlining the branch. No DOM, no network.

import { describe, expect, it } from "vitest";
import {
  AUTONOMY_CONTROL_ENDPOINT,
  retryRefreshesControl,
  revalidateConflictArm,
  shouldResetConflictArm,
} from "../src/lib/autonomy_state.js";

describe("autonomy panel state decisions", () => {
  it("refreshes global control after retrying its mutation", () => {
    expect(retryRefreshesControl(AUTONOMY_CONTROL_ENDPOINT)).toBe(true);
  });

  it("does not refresh global control for session-list mutations", () => {
    expect(retryRefreshesControl("/api/sessions/s/purposes")).toBe(false);
    expect(retryRefreshesControl("/api/sessions/s/purpose-conflicts")).toBe(
      false,
    );
    expect(retryRefreshesControl("/api/sessions/s/tasks")).toBe(false);
  });

  it("drops an armed purpose that is no longer active", () => {
    expect(revalidateConflictArm("gone", new Set(["live"]))).toBe(null);
    expect(revalidateConflictArm("live", new Set(["live"]))).toBe("live");
    expect(revalidateConflictArm(null, new Set(["live"]))).toBe(null);
  });

  it("resets the conflict arm only on rejection, not on success", () => {
    expect(shouldResetConflictArm(409)).toBe(true);
    expect(shouldResetConflictArm(201)).toBe(false);
    expect(shouldResetConflictArm(200)).toBe(false);
    expect(shouldResetConflictArm(500)).toBe(false);
  });
});
