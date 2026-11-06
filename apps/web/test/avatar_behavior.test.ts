// Behavior brain: deterministic HFSM + locomotion. The RNG is injected so
// every transition can be asserted without timing.
import { describe, expect, test } from "vitest";
import { BehaviorBrain } from "../src/lib/avatar_behavior.js";

function sequence(values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0.5;
}

describe("BehaviorBrain", () => {
  test("stays idle for the rolled duration, then rests when the roll says so", () => {
    const brain = new BehaviorBrain(sequence([0.9, 0.9]), {
      idleSeconds: [1, 1],
      restSeconds: [5, 5],
    });
    for (let i = 0; i < 19; i += 1) {
      brain.update(0.05);
    }
    expect(brain.snapshot().mode).toBe("idle");
    brain.update(0.05);
    expect(brain.snapshot().mode).toBe("rest");
  });

  test("walks to a destination, turns toward it, and stops there", () => {
    // idle roll, decision roll (walk), destination roll (far right).
    const brain = new BehaviorBrain(sequence([0, 0.1, 0.999]), {
      idleSeconds: [0, 0],
      maxSpeed: 0.3,
      acceleration: 0.6,
    });
    brain.update(0.05);
    expect(brain.snapshot().mode).toBe("walk");
    expect(brain.snapshot().facing).toBe(1);

    let previous = brain.snapshot().x;
    for (let i = 0; i < 400; i += 1) {
      const snap = brain.update(0.05);
      expect(snap.x).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = snap.x;
      if (snap.mode !== "walk") {
        break;
      }
    }
    const done = brain.snapshot();
    expect(done.mode).toBe("idle");
    expect(done.x).toBeGreaterThan(0.9);
    expect(done.speed).toBe(0);
    expect(done.walkPhase).toBeGreaterThan(0);
  });

  test("turns left for a destination to the left", () => {
    const brain = new BehaviorBrain(sequence([0, 0.1, 0]), {
      idleSeconds: [0, 0],
      maxSpeed: 0.3,
    });
    brain.update(0.05);
    brain.update(0.05);
    expect(brain.snapshot().facing).toBe(-1);
  });

  test("interrupt stops movement and freezes the state until resume", () => {
    const brain = new BehaviorBrain(sequence([0, 0.1, 0.999]), {
      idleSeconds: [0, 0],
      maxSpeed: 0.3,
    });
    for (let i = 0; i < 20; i += 1) {
      brain.update(0.05);
    }
    expect(brain.snapshot().mode).toBe("walk");
    brain.interrupt();
    const frozen = brain.snapshot();
    for (let i = 0; i < 20; i += 1) {
      brain.update(0.05);
    }
    expect(brain.snapshot()).toEqual(frozen);
    expect(frozen.mode).toBe("interact");
    brain.resume();
    expect(brain.snapshot().mode).toBe("idle");
    expect(brain.snapshot().speed).toBe(0);
  });

  test("resume during a walk leaves the walk running", () => {
    const brain = new BehaviorBrain(sequence([0, 0.1, 0.999]), {
      idleSeconds: [0, 0],
      maxSpeed: 0.3,
    });
    for (let i = 0; i < 20; i += 1) {
      brain.update(0.05);
    }
    const before = brain.snapshot();
    expect(before.mode).toBe("walk");
    brain.resume();
    const after = brain.update(0.05);
    expect(after.mode).toBe("walk");
    expect(after.x).toBeGreaterThan(before.x);
  });

  test("walk phase only advances while the body moves", () => {
    const brain = new BehaviorBrain(sequence([0.5]), { idleSeconds: [9, 9] });
    for (let i = 0; i < 40; i += 1) {
      brain.update(0.05);
    }
    expect(brain.snapshot().walkPhase).toBe(0);
    expect(brain.snapshot().speed).toBe(0);
  });

  test("never leaves the configured margins", () => {
    const brain = new BehaviorBrain(sequence([0, 0.1, 1]), {
      idleSeconds: [0, 0],
      maxSpeed: 1,
      acceleration: 2,
    });
    for (let i = 0; i < 400; i += 1) {
      brain.update(0.05);
      const { x } = brain.snapshot();
      expect(x).toBeGreaterThanOrEqual(0.08);
      expect(x).toBeLessThanOrEqual(0.92);
    }
  });
});
