// Local operator records CLI: strict opt-in, list/show/export/delete/prune,
// safe fixed errors, and path-truthful traversal rejection. Uses only temp
// private storage; no HTTP route and no production DB.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExecutionRecordStore } from "@companion/kernel";
import { afterEach, describe, expect, it } from "vitest";
import { runRecordsCli, toSafeRecordsCliMessage } from "../src/records_cli.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop() as string, { recursive: true, force: true });
  }
});

function envFor(retentionDays = 30): {
  env: NodeJS.ProcessEnv;
  directory: string;
} {
  const root = mkdtempSync(join(tmpdir(), "records-cli-"));
  roots.push(root);
  const directory = join(root, "private");
  return {
    directory,
    env: {
      COMPANION_DB_PATH: join(root, "companion.sqlite"),
      COMPANION_EXECUTION_RECORDS_JSON: JSON.stringify({
        directory,
        retentionDays,
      }),
    },
  };
}

describe("records CLI", () => {
  it("lists, shows, exports, deletes, and prunes private records", () => {
    const { env, directory } = envFor();
    const store = createExecutionRecordStore({
      directory,
      clock: { now: () => Date.now() - 100 * 24 * 60 * 60 * 1000 },
    });
    store.record({
      kind: "model.request",
      runId: "run-cli",
      step: 1,
      data: { model: "m", messages: [{ role: "user", content: "hi" }] },
    });
    store.record({
      kind: "model.response",
      runId: "run-cli",
      step: 1,
      data: { text: "answer" },
    });

    const listed = JSON.parse(runRecordsCli(["list"], env)) as {
      records: Array<{ id: string; kind: string }>;
      incomplete: number;
    };
    expect(listed.incomplete).toBe(0);
    // The store has no cross-record order contract (same-millisecond writes
    // can sort either way), so assert content by kind/id rather than
    // incidental list order.
    expect(new Set(listed.records.map((record) => record.kind))).toEqual(
      new Set(["model.request", "model.response"]),
    );
    const requestRecord = listed.records.find(
      (record) => record.kind === "model.request",
    );
    if (!requestRecord) {
      throw new Error("expected a listed model.request record");
    }
    const id = requestRecord.id;

    const shown = JSON.parse(runRecordsCli(["show", id], env)) as {
      id: string;
      data: unknown;
    };
    expect(shown.id).toBe(id);
    expect(shown.data).toMatchObject({ model: "m" });

    const exported = JSON.parse(runRecordsCli(["export", "run-cli"], env)) as {
      runId: string;
      records: unknown[];
    };
    expect(exported.runId).toBe("run-cli");
    expect(exported.records).toHaveLength(2);

    expect(JSON.parse(runRecordsCli(["delete", id], env))).toEqual({
      deleted: true,
    });
    expect(JSON.parse(runRecordsCli(["delete", id], env))).toEqual({
      deleted: false,
    });
    expect(JSON.parse(runRecordsCli(["prune", "30"], env))).toEqual({
      removed: 1,
    });
  });

  it("prune without an argument uses the configured retentionDays", () => {
    const { env, directory } = envFor(1);
    const day = 24 * 60 * 60 * 1000;
    const old = createExecutionRecordStore({
      directory,
      clock: { now: () => Date.now() - 2 * day },
    });
    old.record({ kind: "tool.input", runId: "run-old", data: {} });
    const fresh = createExecutionRecordStore({ directory });
    fresh.record({ kind: "tool.input", runId: "run-new", data: {} });

    // Configured 1 day (not the 30-day default): only the old record goes.
    expect(JSON.parse(runRecordsCli(["prune"], env))).toEqual({ removed: 1 });
    const listing = JSON.parse(runRecordsCli(["list"], env)) as {
      records: Array<{ runId: string }>;
    };
    expect(listing.records.map((record) => record.runId)).toEqual(["run-new"]);
  });

  it("fails closed when disabled and never echoes ids, paths, or payloads", () => {
    const { env, directory } = envFor();
    void directory;
    const disabled = { ...env };
    delete disabled.COMPANION_EXECUTION_RECORDS_JSON;
    expect(() => runRecordsCli(["list"], disabled)).toThrow(
      /disabled; set COMPANION_EXECUTION_RECORDS_JSON/,
    );
    expect(toSafeRecordsCliMessage(new Error("raw /tmp/secret payload"))).toBe(
      "records failed",
    );
    try {
      runRecordsCli(["show", "../../etc/passwd"], env);
      throw new Error("expected failure");
    } catch (error) {
      const message = toSafeRecordsCliMessage(error);
      expect(message).toBe("records failed: record not found or invalid");
      expect(message).not.toContain("../");
      expect(message).not.toContain("/etc");
    }
    // Run IDs are not path segments: a traversal-looking id simply has no
    // records (and never touches the filesystem outside the hashed root).
    expect(
      JSON.parse(runRecordsCli(["export", "../../etc/passwd"], env)),
    ).toEqual({ runId: "../../etc/passwd", records: [] });
  });

  it("rejects malformed usage with fixed actionable text", () => {
    const { env } = envFor();
    for (const argv of [
      [],
      ["unknown"],
      ["show"],
      ["show", "a", "b"],
      ["prune", "-1"],
      ["prune", "999999"],
      ["list", "extra"],
    ]) {
      expect(() => runRecordsCli(argv, env)).toThrow(/records failed:/);
    }
  });
});
