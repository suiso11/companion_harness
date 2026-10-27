// Schema33 sealed-trial report: bounded normalization + persisted read.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  closeKernelDatabase,
  createKernelRepository,
  migrateKernelDatabase,
  normalizeWorkerReport,
  openKernelDatabase,
  readWorkerReport,
  TRIAL_REPORT_FINDING_MAX_BYTES,
  TRIAL_REPORT_FINDINGS_JSON_MAX_CHARS,
  TRIAL_REPORT_MAX_FINDINGS,
  TRIAL_REPORT_MAX_UNRESOLVED,
  TRIAL_REPORT_SUMMARY_MAX_BYTES,
} from "../src/index.js";

const SESSION = randomUUID();
const EXEC = randomUUID();
const NOW = 1_750_000_000_000;
const PROFILE = {
  available: true,
  enabled: true,
  mandatoryChecks: ["lint"],
  configFingerprint: "b".repeat(64),
  sourceRevision: "a".repeat(40),
  currentModel: "test-model",
  disclosedWholeRepoRead: true,
  timeoutMs: 60000,
  maxOutputBytes: 1000000,
};

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

describe("serialized storage bound (Schema33 CHECK)", () => {
  it("keeps sixteen 1024-byte quote-heavy findings inside the column bound", async () => {
    const handle = openKernelDatabase(":memory:");
    await migrateKernelDatabase({ db: handle.raw });
    try {
      const repo = createKernelRepository(handle.raw);
      const session = repo.createSession({ key: randomUUID(), now: NOW });
      const sessionId = session.body.sessionId as string;
      const ctl = repo.getAutonomyControlState();
      repo.setAutonomyControlState(
        { paused: false, expectedVersion: ctl.version },
        { key: randomUUID(), now: NOW + 1 },
      );
      const goal = repo.createAutonomyPurpose(
        sessionId,
        {
          scope: "report-bound",
          statement: "ship it",
          kind: "goal",
          explicit: true,
          sourceKind: "user",
        },
        { key: randomUUID(), now: NOW + 2 },
      );
      const task = repo.createAutonomyTask(
        sessionId,
        {
          scope: "report-bound",
          title: "do work",
          kind: "task",
          speaker: "user",
          parentPurposeId: (goal.body as { id: string }).id,
        },
        { key: randomUUID(), now: NOW + 3 },
      );
      const staged = repo.stageTrial(
        sessionId,
        {
          taskId: (task.body as { id: string }).id,
          objective: "obj",
          acceptance: ["done"],
          literalPatchPaths: ["src/a.ts"],
          operation: "implement",
          readOnlyMode: false,
          expiry: new Date(NOW + 3600_000).toISOString(),
          possibleExternalDataConsent: true,
          objectiveResourceCaps: { timeoutMs: 5000, maxOutputBytes: 10000 },
          requiredChecks: ["lint"],
        },
        {
          key: randomUUID(),
          now: NOW + 4,
          profile: PROFILE,
          workspaceAlias: "ws",
        },
      );
      const approved = repo.approveTrial(sessionId, staged.body.id, {
        key: randomUUID(),
        now: NOW + 5,
        profile: PROFILE,
        workspaceAlias: "ws",
      });
      const executionId = (approved.body as { executionId: string })
        .executionId;
      const claimed = repo.claimTrial(sessionId, executionId, {
        key: randomUUID(),
        now: NOW + 6,
        profile: PROFILE,
        workspaceAlias: "ws",
      });
      const request = (claimed.body as { request: Record<string, unknown> })
        .request;
      repo.registerTrialWorkerBoot(
        {
          executionId,
          sessionId,
          pid: 4242,
          bootId: "boot-1",
          processStartTicks: "12345",
        },
        NOW + 7,
      );
      repo.issueTrialLaunchPermit(sessionId, executionId, {
        key: randomUUID(),
        now: NOW + 8,
        observation: {
          scopeState: "active",
          frontendSettled: false,
          pid: 4242,
          bootId: "boot-1",
          processStartTicks: "12345",
          remainingRuntimeMs: 1000,
          timeoutMs: 5000,
          maxOutputBytes: 10000,
          foregroundGateOpen: true,
          observedAt: NOW + 8,
        } as never,
        profile: PROFILE,
        requestHash: repo.hashTrialLaunchRequest(request),
      });
      // 1024 bytes of quotes and backslashes: JSON escaping doubles each byte,
      // so sixteen findings serialize to 32785 chars — over the 32768 CHECK.
      const quoteHeavy = '"\\'.repeat(512);
      expect(Buffer.byteLength(quoteHeavy, "utf8")).toBe(1024);
      const report = normalizeWorkerReport({
        summary: "done",
        findings: Array.from({ length: 16 }, () => quoteHeavy),
        unresolved: Array.from({ length: 8 }, () => quoteHeavy),
        checks: [{ name: "lint", outcome: "passed", exit: 0 }],
        artifact: null,
        verified: true,
      });
      expect(report?.findings).toHaveLength(16);
      const recorded = repo.recordTrialWorkerResult(
        sessionId,
        executionId,
        {
          detail: "native done",
          observation: {
            scopeState: "gone",
            frontendSettled: true,
            pid: 4242,
            bootId: "boot-1",
            processStartTicks: "12345",
            remainingRuntimeMs: 1000,
            timeoutMs: 5000,
            maxOutputBytes: 10000,
            foregroundGateOpen: true,
            observedAt: NOW + 9,
          } as never,
          result: {
            taskHash: request.taskHash as string,
            exitCode: 0,
            checks: [{ id: "lint", ok: true }],
            outputMatched: true,
            noTimeout: true,
          },
          report,
        },
        NOW + 9,
      );
      expect(recorded.outcome).toBe("done");
      const row = handle.raw
        .prepare(
          "SELECT findings_json, unresolved_json, length(findings_json) AS findings_len, length(unresolved_json) AS unresolved_len FROM trial_worker_reports WHERE execution_id=?",
        )
        .get(executionId) as {
        findings_json: string;
        unresolved_json: string;
        findings_len: number;
        unresolved_len: number;
      };
      expect(row.findings_len).toBeLessThanOrEqual(
        TRIAL_REPORT_FINDINGS_JSON_MAX_CHARS,
      );
      expect(row.findings_len).toBeLessThanOrEqual(32768);
      expect(row.unresolved_len).toBeLessThanOrEqual(16384);
      expect(row.findings_json.length).toBe(row.findings_len);
      const stored = JSON.parse(row.findings_json) as string[];
      expect(stored.length).toBeLessThanOrEqual(TRIAL_REPORT_MAX_FINDINGS);
      expect(stored.length).toBeGreaterThan(0);
      // Every retained text is intact; the shrunk tail is a prefix.
      const read = repo.readTrialWorkerReport(sessionId, executionId);
      expect(read?.findings).toHaveLength(stored.length);
      expect(read?.findings[0]).toBe(quoteHeavy);
      for (const finding of read?.findings ?? []) {
        expect(quoteHeavy.startsWith(finding)).toBe(true);
      }
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
