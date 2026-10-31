import { describe, expect, it } from "vitest";
import { createSessionPresence } from "../src/session_presence.js";

describe("session presence", () => {
  it("returns the most recent fresh session and expires stale ones", () => {
    let now = 1_000;
    const presence = createSessionPresence({
      ttlMs: 1_000,
      now: () => now,
    });
    presence.touch("a", 1_000);
    now = 1_200;
    presence.touch("b", 1_200);
    expect(presence.active()).toBe("b");
    now = 2_300;
    expect(presence.active()).toBeNull();
    presence.touch("c", 2_300);
    presence.clear();
    expect(presence.active()).toBeNull();
  });
});
