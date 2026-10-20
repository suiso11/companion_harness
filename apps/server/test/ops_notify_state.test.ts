// Dedupe-helper tests for opsNotifyState.mjs: pure state folds only, no
// filesystem, no secrets. Covers deploy-skip hourly dedupe per target and
// health problem-key error/recovered transitions.

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  clearSkipState,
  type HealthState,
  nextHealthState,
  nextSkipState,
  runCli,
  SKIP_WINDOW_MS,
  type SkipState,
} from "../../../scripts/deploy/opsNotifyState.mjs";

describe("nextSkipState", () => {
  it("stays silent on the first skipped tick and records the episode", () => {
    const { state, notify } = nextSkipState({}, "abc1234", 1000);
    expect(notify).toBe(false);
    expect(state.targets?.abc1234).toEqual({
      firstSkipAt: 1000,
      lastNotifiedAt: 1000,
    });
  });

  it("notifies only after the skip persisted past the 1h window", () => {
    let state: SkipState = {};
    const first = nextSkipState(state, "t1", 0);
    state = first.state;
    expect(first.notify).toBe(false);
    // Just under the window: silent.
    const mid = nextSkipState(state, "t1", SKIP_WINDOW_MS - 60_000);
    expect(mid.notify).toBe(false);
    // Past the window: one notice.
    const late = nextSkipState(mid.state, "t1", SKIP_WINDOW_MS + 1);
    expect(late.notify).toBe(true);
    // The notice itself resets the window: immediate re-tick is silent.
    const again = nextSkipState(late.state, "t1", SKIP_WINDOW_MS + 2);
    expect(again.notify).toBe(false);
  });

  it("dedupes per target independently", () => {
    let state = {};
    state = nextSkipState(state, "a", 0).state;
    state = nextSkipState(state, "a", SKIP_WINDOW_MS + 1).state; // notified for a
    const other = nextSkipState(state, "b", SKIP_WINDOW_MS + 1);
    expect(other.notify).toBe(false); // b's episode just started
  });

  it("clearSkipState resets the episode", () => {
    let state = nextSkipState({}, "t", 0).state;
    state = nextSkipState(state, "t", SKIP_WINDOW_MS + 1).state;
    state = clearSkipState(state, "t");
    expect(state.targets?.t).toBeUndefined();
    // After clearing, a new episode starts silently again.
    expect(nextSkipState(state, "t", 5_000_000).notify).toBe(false);
  });
});

describe("nextHealthState", () => {
  it("emits error once per problem key and stays silent while persisting", () => {
    let state: HealthState = {};
    const first = nextHealthState(state, "disk:/", true, 1000);
    expect(first.level).toBe("error");
    state = first.state;
    const persist = nextHealthState(state, "disk:/", true, 2000);
    expect(persist.level).toBeNull();
    state = persist.state;
    expect(state.keys?.["disk:/"]).toBe(1000);
  });

  it("emits recovered info when the problem clears, then is silent", () => {
    const state = nextHealthState(
      {},
      "unit:companion.service",
      true,
      1000,
    ).state;
    const cleared = nextHealthState(
      state,
      "unit:companion.service",
      false,
      2000,
    );
    expect(cleared.level).toBe("recovered");
    expect(cleared.state.keys?.["unit:companion.service"]).toBeUndefined();
    const still = nextHealthState(
      cleared.state,
      "unit:companion.service",
      false,
      3000,
    );
    expect(still.level).toBeNull();
  });

  it("tracks keys independently", () => {
    const state = nextHealthState({}, "k1", true, 1000).state;
    const other = nextHealthState(state, "k2", true, 2000);
    expect(other.level).toBe("error");
    expect(other.state.keys?.k1).toBe(1000);
  });
});

describe("runCli", () => {
  it("maps skip/health commands to verdicts with a temp state file", () => {
    const stateDir = join(tmpdir(), "ops-notify-state-test");
    rmSync(join(stateDir, "companion"), { recursive: true, force: true });
    const env = { XDG_STATE_HOME: stateDir };
    const t = 1_000_000;
    expect(runCli(["skip", "deadbee1"], env, t)).toBe("silent");
    expect(runCli(["skip", "deadbee1"], env, t + SKIP_WINDOW_MS + 1)).toBe(
      "notify",
    );
    expect(runCli(["skip-clear", "deadbee1"], env, t)).toBe("ok");
    expect(runCli(["health", "liveness", "failing"], env, t)).toBe(
      `error ${t}`,
    );
    expect(runCli(["health", "liveness", "failing"], env, t + 1)).toBe(
      "silent",
    );
    expect(runCli(["health", "liveness", "ok"], env, t + 2)).toBe("recovered");
    // A re-occurrence in a NEW episode starts a new episode id, so callers
    // can scope their fingerprint and the kernel will not dedup it away.
    expect(runCli(["health", "liveness", "failing"], env, t + 3)).toBe(
      `error ${t + 3}`,
    );
    expect(runCli([], env, t)).toBe("usage");
  });
});
