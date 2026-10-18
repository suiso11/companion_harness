// Kernel package surface: the typed Drizzle handle must register every
// migrated autonomy table, and the entry point must expose the full
// autonomy mutation surface (not just `recordPurposeConflict`).

import { describe, expect, it } from "vitest";
import {
  achievePurpose,
  autonomyActivity,
  autonomyControl,
  autonomyPurposeConflicts,
  autonomyPurposeEvents,
  autonomyPurposes,
  autonomyTaskEvents,
  autonomyTasks,
  cancelTask,
  completeTask,
  correctPurpose,
  createPurpose,
  createTask,
  holdTask,
  kernelSchema,
  resumeTask,
  revokePurpose,
  startTask,
} from "../src/index.js";

describe("kernel autonomy package surface", () => {
  it("registers every autonomy table in the Drizzle schema", () => {
    expect(kernelSchema.autonomyPurposes).toBe(autonomyPurposes);
    expect(kernelSchema.autonomyPurposeConflicts).toBe(
      autonomyPurposeConflicts,
    );
    expect(kernelSchema.autonomyPurposeEvents).toBe(autonomyPurposeEvents);
    expect(kernelSchema.autonomyTasks).toBe(autonomyTasks);
    expect(kernelSchema.autonomyTaskEvents).toBe(autonomyTaskEvents);
    expect(kernelSchema.autonomyControl).toBe(autonomyControl);
    expect(kernelSchema.autonomyActivity).toBe(autonomyActivity);
  });

  it("re-exports the complete autonomy mutation surface", () => {
    for (const fn of [
      createPurpose,
      correctPurpose,
      revokePurpose,
      achievePurpose,
      createTask,
      startTask,
      holdTask,
      resumeTask,
      completeTask,
      cancelTask,
    ]) {
      expect(typeof fn).toBe("function");
    }
  });
});
