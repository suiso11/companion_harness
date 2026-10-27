// Paused banner visibility mapping + shared resume request contract.
import { describe, expect, test } from "vitest";
import {
  AUTONOMY_CONTROL_PATH,
  autonomyBannerState,
  buildControlBody,
  parseAutonomyControl,
} from "../src/lib/autonomy_control.js";

describe("autonomy paused banner", () => {
  test("paused snapshot shows the banner", () => {
    expect(autonomyBannerState({ paused: true, version: 4 })).toBe("paused");
  });

  test("running snapshot hides the banner", () => {
    expect(autonomyBannerState({ paused: false, version: 4 })).toBe("running");
  });

  test("unknown / malformed snapshots hide the banner", () => {
    expect(autonomyBannerState(null)).toBe("unknown");
    expect(autonomyBannerState(parseAutonomyControl(null))).toBe("unknown");
    expect(autonomyBannerState(parseAutonomyControl({}))).toBe("unknown");
    expect(
      autonomyBannerState(parseAutonomyControl({ paused: "yes", version: 1 })),
    ).toBe("unknown");
    expect(autonomyBannerState(parseAutonomyControl({ paused: true }))).toBe(
      "unknown",
    );
    expect(
      autonomyBannerState(parseAutonomyControl({ paused: true, version: "1" })),
    ).toBe("unknown");
  });

  test("valid snapshot parses to the shared shape", () => {
    expect(parseAutonomyControl({ paused: true, version: 7 })).toEqual({
      paused: true,
      version: 7,
    });
  });

  test("resume reuses the same CAS body + endpoint as AutonomyPanel", () => {
    expect(AUTONOMY_CONTROL_PATH).toBe("/api/autonomy/control");
    expect(buildControlBody(false, 12)).toEqual({
      paused: false,
      expectedVersion: 12,
    });
  });
});
