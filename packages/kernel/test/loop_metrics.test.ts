// Self-improvement loop measurement (P0/P1): pure label, quarantine,
// coverage and calibration math. No database, no model.

import { describe, expect, it } from "vitest";
import {
  classifyTaskClass,
  computeCoverage,
  computeDprime,
  inverseNormal,
  isQuarantinedRun,
  LOOP_QUARANTINE_MODULUS,
  LOOP_TASK_CLASSES,
  type LoopRunFacts,
  labelRun,
} from "../src/index.js";

function facts(overrides: Partial<LoopRunFacts> = {}): LoopRunFacts {
  return {
    runId: "run-1",
    sessionId: "session-1",
    status: "completed",
    modelErrors: 0,
    toolErrors: 0,
    tools: [],
    ...overrides,
  };
}

describe("loop quarantine", () => {
  it("is deterministic and independent of call order", () => {
    const first = isQuarantinedRun("abc");
    const second = isQuarantinedRun("abc");
    expect(first).toBe(second);
    expect(isQuarantinedRun("abc")).toBe(isQuarantinedRun("abc"));
  });

  it("holds out roughly one in ten ids", () => {
    let held = 0;
    for (let i = 0; i < 5000; i += 1) {
      if (isQuarantinedRun(`run-${i}`)) held += 1;
    }
    const rate = held / 5000;
    expect(rate).toBeGreaterThan(0.07);
    expect(rate).toBeLessThan(0.13);
    expect(LOOP_QUARANTINE_MODULUS).toBe(10);
  });
});

describe("task classes", () => {
  it("classifies by the first alphabetical tool family", () => {
    expect(classifyTaskClass(["memory.search"])).toBe("memory");
    expect(classifyTaskClass(["calendar.search", "web.search"])).toBe(
      "calendar",
    );
    expect(classifyTaskClass(["web.search", "memory.search"])).toBe("memory");
    expect(classifyTaskClass([])).toBe("chat");
    expect(classifyTaskClass(["answer.submit"])).toBe("chat");
  });

  it("only produces declared classes", () => {
    for (const tools of [["x.y"], [], ["trial.propose"], ["learning.list"]]) {
      expect(LOOP_TASK_CLASSES).toContain(classifyTaskClass(tools));
    }
  });
});

describe("run labels", () => {
  it("labels a clean completed run as ok", () => {
    expect(labelRun(facts()).ok).toBe(true);
  });

  it("labels model, tool and status failures as not ok", () => {
    expect(labelRun(facts({ modelErrors: 1 })).ok).toBe(false);
    expect(labelRun(facts({ toolErrors: 1 })).ok).toBe(false);
    expect(labelRun(facts({ status: "failed" })).ok).toBe(false);
    expect(labelRun(facts({ status: "cancelled" })).ok).toBe(false);
  });

  it("carries the class and the quarantine flag", () => {
    const label = labelRun(facts({ tools: ["memory.search"] }));
    expect(label.taskClass).toBe("memory");
    expect(label.quarantined).toBe(isQuarantinedRun("run-1"));
  });
});

describe("coverage", () => {
  it("counts per class, ok runs and quarantined runs", () => {
    const labels = [
      labelRun(facts({ runId: "a", tools: ["memory.search"] })),
      labelRun(facts({ runId: "b", tools: ["memory.search"], toolErrors: 1 })),
      labelRun(facts({ runId: "c" })),
    ];
    const coverage = computeCoverage(labels);
    expect(coverage.total).toBe(3);
    expect(coverage.labeled).toBe(3);
    expect(coverage.byClass).toEqual([
      { taskClass: "chat", n: 1, ok: 1, quarantined: 0 },
      { taskClass: "memory", n: 2, ok: 1, quarantined: 0 },
    ]);
  });
});

describe("calibration (d' type-2)", () => {
  it("reports insufficient below the minimum sample", () => {
    const pairs = Array.from({ length: 10 }, () => ({
      confident: true,
      ok: true,
    }));
    expect(computeDprime(pairs)).toMatchObject({
      status: "insufficient",
      n: 10,
    });
  });

  it("gives d'≈0 to a judge that is confident at random", () => {
    const pairs = [
      ...Array.from({ length: 20 }, () => ({ confident: true, ok: true })),
      ...Array.from({ length: 20 }, () => ({ confident: true, ok: false })),
      ...Array.from({ length: 20 }, () => ({ confident: false, ok: true })),
      ...Array.from({ length: 20 }, () => ({ confident: false, ok: false })),
    ];
    const result = computeDprime(pairs);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    // Same hit and false-alarm rate: no sensitivity.
    expect(Math.abs(result.dprime)).toBeLessThan(1e-9);
  });

  it("refuses to score a judge with an empty outcome cell", () => {
    const pairs = [
      ...Array.from({ length: 40 }, () => ({ confident: true, ok: true })),
      ...Array.from({ length: 40 }, () => ({ confident: true, ok: false })),
    ];
    expect(computeDprime(pairs)).toMatchObject({ status: "insufficient" });
  });

  it("gives a positive d' to a judge that tracks the outcome", () => {
    const pairs = [
      ...Array.from({ length: 30 }, () => ({ confident: true, ok: true })),
      ...Array.from({ length: 10 }, () => ({ confident: true, ok: false })),
      ...Array.from({ length: 10 }, () => ({ confident: false, ok: true })),
      ...Array.from({ length: 20 }, () => ({ confident: false, ok: false })),
    ];
    const result = computeDprime(pairs);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.dprime).toBeGreaterThan(0);
    expect(result.hitRate).toBeGreaterThan(result.falseAlarmRate);
  });

  it("uses the standard inverse normal", () => {
    expect(inverseNormal(0.5)).toBeCloseTo(0, 12);
    expect(inverseNormal(0.975)).toBeCloseTo(1.959964, 5);
    expect(inverseNormal(0.025)).toBeCloseTo(-1.959964, 5);
  });
});
