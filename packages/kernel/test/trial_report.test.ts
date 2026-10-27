// Schema33 sealed-trial report: bounded normalization + persisted read.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  closeKernelDatabase,
  migrateKernelDatabase,
  normalizeWorkerReport,
  openKernelDatabase,
  readWorkerReport,
  TRIAL_REPORT_FINDING_MAX_BYTES,
  TRIAL_REPORT_MAX_FINDINGS,
  TRIAL_REPORT_MAX_UNRESOLVED,
  TRIAL_REPORT_SUMMARY_MAX_BYTES,
} from "../src/index.js";

const SESSION = randomUUID();
const EXEC = randomUUID();

describe("normalizeWorkerReport", () => {
  it("bounds guest text UTF-8-safely and drops extras", () => {
    const report = normalizeWorkerReport({
      summary: "あ".repeat(4096),
      findings: Array.from({ length: 40 }, () => "い".repeat(4096)),
      unresolved: Array.from({ length: 20 }, () => "う".repeat(4096)),
      checks: Array.from({ length: 40 }, (_, i) => ({
        name: `check-${i}`,
        outcome: "passed",
        exit: 0,
      })),
      artifact: { sha256: "a".repeat(64), entryCount: 4 },
      verified: true,
    });
    expect(report).not.toBeNull();
    expect(
      Buffer.byteLength(report?.summary ?? "", "utf8"),
    ).toBeLessThanOrEqual(TRIAL_REPORT_SUMMARY_MAX_BYTES);
    expect(report?.findings).toHaveLength(TRIAL_REPORT_MAX_FINDINGS);
    expect(report?.unresolved).toHaveLength(TRIAL_REPORT_MAX_UNRESOLVED);
    expect(report?.checks).toHaveLength(16);
    for (const finding of report?.findings ?? []) {
      expect(Buffer.byteLength(finding, "utf8")).toBeLessThanOrEqual(
        TRIAL_REPORT_FINDING_MAX_BYTES,
      );
      expect(finding).not.toContain("\uFFFD");
    }
    expect(report?.artifact).toEqual({ sha256: "a".repeat(64), entryCount: 4 });
    expect(report?.verified).toBe(true);
  });

  it("degrades malformed presentation members instead of fabricating authority", () => {
    const report = normalizeWorkerReport({
      summary: 42,
      findings: ["ok", 7, null],
      unresolved: "nope",
      checks: [
        { name: "bad name!", outcome: "passed", exit: 0 },
        { name: "ok", outcome: "weird", exit: 0 },
        { name: "lint", outcome: "failed", exit: 1 },
      ],
      artifact: { sha256: "not-hex", entryCount: 1 },
      verified: "yes",
    });
    expect(report).toEqual({
      summary: "",
      findings: ["ok", "", ""],
      unresolved: [],
      checks: [{ name: "lint", outcome: "failed", exit: 1 }],
      artifact: null,
      verified: false,
    });
  });
});

describe("readWorkerReport", () => {
  it("returns the bounded report with explicit provenance and ownership", async () => {
    const handle = openKernelDatabase(":memory:");
    await migrateKernelDatabase({ db: handle.raw });
    try {
      handle.raw.pragma("foreign_keys = OFF");
      handle.raw
        .prepare(
          "INSERT INTO trial_grants (execution_id, proposal_id, session_id, scope, status, cancel_requested, control_generation, created_at) VALUES (?,?,?,?,?,?,?,?)",
        )
        .run(EXEC, "proposal-1", SESSION, "scope", "consumed", 0, 1, 1);
      handle.raw
        .prepare(
          "INSERT INTO trial_worker_reports (execution_id, session_id, summary, findings_json, unresolved_json, checks_json, artifact_json, verified, recorded_at) VALUES (?,?,?,?,?,?,?,?,?)",
        )
        .run(
          EXEC,
          SESSION,
          "完了",
          JSON.stringify(["guest answer (unattested): 42"]),
          JSON.stringify([]),
          JSON.stringify([{ name: "lint", outcome: "passed", exit: 0 }]),
          JSON.stringify({ sha256: "b".repeat(64), entryCount: 2 }),
          1,
          2,
        );
      const report = readWorkerReport(handle.raw, SESSION, EXEC);
      expect(report).toMatchObject({
        summary: "完了",
        findings: ["guest answer (unattested): 42"],
        unresolved: [],
        checks: [{ name: "lint", outcome: "passed", exit: 0 }],
        artifact: { sha256: "b".repeat(64), entryCount: 2 },
        verified: true,
        provenance: {
          findings: "guest-reported-unattested",
          checks: "host-checked",
          artifact: "host-checked",
        },
      });
      expect(readWorkerReport(handle.raw, randomUUID(), EXEC)).toBeNull();
      expect(readWorkerReport(handle.raw, SESSION, randomUUID())).toBeNull();
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
