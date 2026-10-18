// AV07 Codex #46 fsync regression: a storage-level sync failure must fail
// the state commit (never report durable). fsyncSync is faulted via mock.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    fsyncSync: () => {
      throw new Error("EIO");
    },
  };
});

import {
  initialSupervisorState,
  supervisorPathsForDb,
  writeSupervisorState,
} from "../src/supervisor.js";

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs = [];
});

describe("Codex46 fsync failures propagate", () => {
  it("writeSupervisorState throws when the file sync fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "av-codex46-fsync-"));
    dirs.push(dir);
    const paths = supervisorPathsForDb(join(dir, "companion.sqlite"));
    expect(() =>
      writeSupervisorState(
        paths,
        initialSupervisorState(Date.now(), "codex46-fsync"),
      ),
    ).toThrow();
  });
});
