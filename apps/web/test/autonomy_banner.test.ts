// Paused banner visibility mapping + shared resume request contract.
import { describe, expect, test } from "vitest";
import {
  AUTONOMY_BANNER_REFRESH_MS,
  AUTONOMY_CONTROL_PATH,
  autonomyBannerState,
  buildControlBody,
  frozenResumeCommand,
  parseAutonomyControl,
  shouldPollBanner,
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

  test("uncertain retry reuses the frozen key and expectedVersion", () => {
    const first = frozenResumeCommand(null, 12, "key-1");
    expect(first).toEqual({ key: "key-1", expectedVersion: 12 });
    // A focus/poll refresh discovers version 13; the retry must still send
    // the original CAS body under the original key.
    const retry = frozenResumeCommand(first, 13, "key-2");
    expect(retry).toEqual({ key: "key-1", expectedVersion: 12 });
  });

  test("a resolved command starts a fresh key and version", () => {
    expect(frozenResumeCommand(null, 13, "key-2")).toEqual({
      key: "key-2",
      expectedVersion: 13,
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

describe("autonomy paused banner revalidation", () => {
  test("polls on a bounded cadence", () => {
    expect(AUTONOMY_BANNER_REFRESH_MS).toBe(30_000);
  });

  test("only polls while the document is visible", () => {
    expect(shouldPollBanner("visible")).toBe(true);
    expect(shouldPollBanner("hidden")).toBe(false);
  });
});
