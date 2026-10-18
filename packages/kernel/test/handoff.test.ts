// AV03 delegation handoffs: human-driven pi-orch records + verification.
//
// Proves through the REAL kernel repository + migrator + ToolBroker
// (in-memory DB, no mocks):
// - human creation binds an EXISTING task (+ frozen parent purpose
//   snapshot ids/versions); frozen fields are stored verbatim;
// - `verified` requires a pass + evidence result for EVERY frozen
//   criterion, all passing (any fail / missing / duplicate / out-of-range
//   index refuses; criteria are never weakened to pass);
// - changing criteria needs a NEW superseding handoff (old row keeps its
//   frozen criteria, `superseded_by` links forward); the new record cannot
//   be verified with the old criterion set;
// - a retry is an explicitly human-recorded attempt row with a REQUIRED
//   closed cause (no automatic retry; attempts bounded only by explicit
//   human action);
// - a sandbox report NEVER sets production (no production column exists;
//   verification never flips it; the spec labels production unverified);
// - boundary flags grant nothing: recording every boundary changes no
//   purpose/control/grant/task state;
// - revoking the parent purpose flags active handoffs with the durable
//   `needs_reevaluation` notice in the SAME transaction, new dispatch is
//   refused while set, cancel stays allowed, and explicit human reaffirm
//   clears it (stale CAS after the flag conflicts);
// - a verified handoff NEVER completes its task;
// - foreign-session ids are 404; idempotent replay returns the stored body
//   once; key reuse with a different body conflicts (409); stale CAS
//   versions conflict (409);
// - model tools are read-only (`handoff.list` / `handoff.open` only; no
//   write registration exists) and foreign ids fail closed as
//   `execution_failed`.

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AGENT_TOOL_ORIGIN } from "../src/agent.js";
import {
  IdempotencyConflictError,
  RepositoryNotFoundError,
} from "../src/errors.js";
import {
  HandoffStateConflictError,
  HandoffVersionConflictError,
} from "../src/handoff.js";
import {
  closeKernelDatabase,
  createHandoffRegistrations,
  createKernelRepository,
  createToolBroker,
  type KernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
} from "../src/index.js";

const T0 = 1_700_006_000_000;
const MODEL_CTX = { origin: AGENT_TOOL_ORIGIN, caller: "test-agent" };

async function makeRepo() {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  const repo = createKernelRepository(handle.raw);
  const session = repo.createSession({ key: randomUUID(), now: T0 });
  const other = repo.createSession({ key: randomUUID(), now: T0 + 1 });
  return {
    handle,
    repo,
    sessionId: session.body.sessionId as string,
    otherId: other.body.sessionId as string,
  };
}

function makePurpose(
  repo: KernelRepository,
  sessionId: string,
  now: number,
  statement = "ship the release",
  scope = "work",
) {
  return repo.createAutonomyPurpose(
    sessionId,
    { scope, statement, kind: "goal", explicit: true, sourceKind: "user" },
    { key: randomUUID(), now },
  );
}

function makeTask(
  repo: KernelRepository,
  sessionId: string,
  now: number,
  parentPurposeId: string,
  scope = "work",
) {
  return repo.createAutonomyTask(
    sessionId,
    {
      scope,
      title: "migrate the queue",
      kind: "task",
      speaker: "self",
      parentPurposeId,
    },
    { key: randomUUID(), now },
  );
}

function makeHandoff(
  repo: KernelRepository,
  sessionId: string,
  taskId: string,
  now: number,
  extra: Record<string, unknown> = {},
) {
  return repo.createHandoff(
    sessionId,
    {
      taskId,
      target: "hand the queue migration to pi-orch",
      acceptanceCriteria: ["queue drains without loss", "no duplicate work"],
      opScope: "implement",
      ...extra,
    },
    { key: randomUUID(), now },
  );
}

function countRows(
  handle: ReturnType<typeof openKernelDatabase>,
  table: string,
): number {
  const row = handle.raw
    .prepare(`SELECT COUNT(*) AS n FROM ${table}`)
    .get() as { n: number };
  return row.n;
}

async function invoke(
  handle: ReturnType<typeof openKernelDatabase>,
  repo: KernelRepository,
  name: string,
  input: unknown,
  runId: string,
) {
  const broker = createToolBroker({
    db: handle.raw,
    repo,
    registrations: createHandoffRegistrations({ repo }),
  });
  const out = await broker.invoke(runId, name, input, MODEL_CTX);
  return { broker, out };
}

function newRunningRun(
  repo: KernelRepository,
  sessionId: string,
  text: string,
  now: number,
  priorRunId?: string,
): string {
  if (priorRunId !== undefined) {
    repo.failRun(priorRunId, "execution_failed", { now });
  }
  const posted = repo.postMessage(
    sessionId,
    { text },
    { key: randomUUID(), now },
  );
  const runId = (posted.body as { run: { id: string } }).run.id;
  repo.startRun(runId, { now: now + 1 });
  return runId;
}

describe("handoff core", () => {
  it("creates bound to an existing task with a frozen parent snapshot", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const purpose = makePurpose(repo, sessionId, T0);
      const task = makeTask(repo, sessionId, T0 + 1, purpose.body.id);
      const created = makeHandoff(repo, sessionId, task.body.id, T0 + 2, {
        budgetLabel: "half a day of focused work",
        boundaries: ["shared_branch", "secret"],
      });
      expect(created.status).toBe(201);
      expect(created.body.status).toBe("prepared");
      expect(created.body.taskId).toBe(task.body.id);
      expect(created.body.taskVersion).toBe(task.body.version);
      expect(created.body.parentPurposeId).toBe(purpose.body.id);
      expect(created.body.parentPurposeVersion).toBe(purpose.body.version);
      expect(created.body.acceptanceCriteria).toEqual([
        "queue drains without loss",
        "no duplicate work",
      ]);
      expect(created.body.budgetLabel).toBe("half a day of focused work");
      expect(created.body.boundaries).toEqual(["shared_branch", "secret"]);
      expect(created.body.needsReevaluation).toBe(false);
      expect(created.body.activeAttempt).toBe(0);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("refuses creation against a foreign/missing task (404)", async () => {
    const { handle, repo, sessionId, otherId } = await makeRepo();
    try {
      const purpose = makePurpose(repo, sessionId, T0);
      const task = makeTask(repo, sessionId, T0 + 1, purpose.body.id);
      expect(() =>
        repo.createHandoff(
          otherId,
          {
            taskId: task.body.id,
            target: "foreign bind",
            acceptanceCriteria: ["one"],
            opScope: "investigate",
          },
          { key: randomUUID(), now: T0 + 2 },
        ),
      ).toThrow(RepositoryNotFoundError);
      expect(() =>
        repo.createHandoff(
          sessionId,
          {
            taskId: randomUUID(),
            target: "missing bind",
            acceptanceCriteria: ["one"],
            opScope: "investigate",
          },
          { key: randomUUID(), now: T0 + 2 },
        ),
      ).toThrow(RepositoryNotFoundError);
      expect(() => repo.getHandoff(otherId, task.body.id)).toThrow(
        RepositoryNotFoundError,
      );
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("verify is blocked unless EVERY frozen criterion passes with evidence", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const purpose = makePurpose(repo, sessionId, T0);
      const task = makeTask(repo, sessionId, T0 + 1, purpose.body.id);
      const created = makeHandoff(repo, sessionId, task.body.id, T0 + 2);
      const id = created.body.id;
      const dispatched = repo.dispatchHandoff(
        sessionId,
        id,
        { expectedVersion: 1 },
        { key: randomUUID(), now: T0 + 3 },
      );
      const reported = repo.reportHandoff(
        sessionId,
        id,
        {
          expectedVersion: dispatched.body.version,
          environment: "sandbox",
          summary: "drained in sandbox",
        },
        { key: randomUUID(), now: T0 + 4 },
      );
      const version = reported.body.version;
      // One failing criterion refuses.
      expect(() =>
        repo.verifyHandoff(
          sessionId,
          id,
          {
            expectedVersion: version,
            results: [
              { index: 0, pass: true, evidence: "log line 1" },
              { index: 1, pass: false, evidence: "duplicates seen" },
            ],
          },
          { key: randomUUID(), now: T0 + 5 },
        ),
      ).toThrow(HandoffStateConflictError);
      // A missing criterion refuses.
      expect(() =>
        repo.verifyHandoff(
          sessionId,
          id,
          {
            expectedVersion: version,
            results: [{ index: 0, pass: true, evidence: "log line 1" }],
          },
          { key: randomUUID(), now: T0 + 5 },
        ),
      ).toThrow(HandoffStateConflictError);
      // A duplicated index refuses.
      expect(() =>
        repo.verifyHandoff(
          sessionId,
          id,
          {
            expectedVersion: version,
            results: [
              { index: 0, pass: true, evidence: "log line 1" },
              { index: 0, pass: true, evidence: "log line 1 again" },
            ],
          },
          { key: randomUUID(), now: T0 + 5 },
        ),
      ).toThrow(HandoffStateConflictError);
      // Verify from the wrong lifecycle refuses (still prepared copy).
      const fresh = makeHandoff(repo, sessionId, task.body.id, T0 + 6);
      expect(() =>
        repo.verifyHandoff(
          sessionId,
          fresh.body.id,
          {
            expectedVersion: 1,
            results: [
              { index: 0, pass: true, evidence: "e0" },
              { index: 1, pass: true, evidence: "e1" },
            ],
          },
          { key: randomUUID(), now: T0 + 7 },
        ),
      ).toThrow(HandoffStateConflictError);
      // All pass with evidence verifies (task NOT auto-completed).
      const taskBefore = repo.getAutonomyTask(sessionId, task.body.id);
      const verified = repo.verifyHandoff(
        sessionId,
        id,
        {
          expectedVersion: version,
          results: [
            { index: 1, pass: true, evidence: "dup check clean" },
            { index: 0, pass: true, evidence: "drain log clean" },
          ],
        },
        { key: randomUUID(), now: T0 + 8 },
      );
      expect(verified.body.status).toBe("verified");
      expect(verified.body.verificationResults).toHaveLength(2);
      expect(repo.getAutonomyTask(sessionId, task.body.id).status).toBe(
        taskBefore.status,
      );
      // Terminal records refuse further attempts.
      expect(() =>
        repo.recordHandoffAttempt(
          sessionId,
          id,
          { expectedVersion: verified.body.version, cause: "worker_error" },
          { key: randomUUID(), now: T0 + 9 },
        ),
      ).toThrow(HandoffStateConflictError);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("criteria are immutable: change needs a superseding handoff (old preserved, old set cannot verify the new)", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const purpose = makePurpose(repo, sessionId, T0);
      const task = makeTask(repo, sessionId, T0 + 1, purpose.body.id);
      const old = makeHandoff(repo, sessionId, task.body.id, T0 + 2);
      const next = repo.createHandoff(
        sessionId,
        {
          taskId: task.body.id,
          target: "hand the queue migration to pi-orch",
          acceptanceCriteria: [
            "queue drains without loss",
            "no duplicate work",
            "alerts stay green",
          ],
          opScope: "implement",
          supersedesHandoffId: old.body.id,
        },
        { key: randomUUID(), now: T0 + 3 },
      );
      expect(next.status).toBe(201);
      expect(next.body.supersedesHandoffId).toBe(old.body.id);
      const reread = repo.getHandoff(sessionId, old.body.id);
      expect(reread.supersededBy).toBe(next.body.id);
      // The old row keeps its frozen criteria verbatim.
      expect(reread.acceptanceCriteria).toEqual([
        "queue drains without loss",
        "no duplicate work",
      ]);
      // The new record cannot be verified with the OLD criterion set
      // (length mismatch refuses: criteria are never silently swapped).
      const dispatched = repo.dispatchHandoff(
        sessionId,
        next.body.id,
        { expectedVersion: 1 },
        { key: randomUUID(), now: T0 + 4 },
      );
      const reported = repo.reportHandoff(
        sessionId,
        next.body.id,
        {
          expectedVersion: dispatched.body.version,
          environment: "sandbox",
          summary: "ran in sandbox",
        },
        { key: randomUUID(), now: T0 + 5 },
      );
      expect(() =>
        repo.verifyHandoff(
          sessionId,
          next.body.id,
          {
            expectedVersion: reported.body.version,
            results: [
              { index: 0, pass: true, evidence: "e0" },
              { index: 1, pass: true, evidence: "e1" },
            ],
          },
          { key: randomUUID(), now: T0 + 6 },
        ),
      ).toThrow(HandoffStateConflictError);
      // Cross-task supersede refuses.
      const otherPurpose = makePurpose(repo, sessionId, T0 + 7, "other goal");
      const otherTask = makeTask(repo, sessionId, T0 + 8, otherPurpose.body.id);
      expect(() =>
        repo.createHandoff(
          sessionId,
          {
            taskId: otherTask.body.id,
            target: "cross bind",
            acceptanceCriteria: ["one"],
            opScope: "investigate",
            supersedesHandoffId: old.body.id,
          },
          { key: randomUUID(), now: T0 + 9 },
        ),
      ).toThrow(HandoffStateConflictError);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("retries are explicit human attempts with a REQUIRED cause (never automatic)", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const purpose = makePurpose(repo, sessionId, T0);
      const task = makeTask(repo, sessionId, T0 + 1, purpose.body.id);
      const created = makeHandoff(repo, sessionId, task.body.id, T0 + 2);
      const id = created.body.id;
      // A missing cause is a validation failure, never a silent retry.
      expect(() =>
        repo.recordHandoffAttempt(
          sessionId,
          id,
          { expectedVersion: 1 },
          { key: randomUUID(), now: T0 + 3 },
        ),
      ).toThrow();
      // A closed-vocabulary violation is a validation failure.
      expect(() =>
        repo.recordHandoffAttempt(
          sessionId,
          id,
          { expectedVersion: 1, cause: "auto_retry" },
          { key: randomUUID(), now: T0 + 3 },
        ),
      ).toThrow();
      const first = repo.recordHandoffAttempt(
        sessionId,
        id,
        { expectedVersion: 1, cause: "transient_infra" },
        { key: randomUUID(), now: T0 + 4 },
      );
      expect(first.body.activeAttempt).toBe(1);
      const second = repo.recordHandoffAttempt(
        sessionId,
        id,
        { expectedVersion: first.body.version, cause: "environment" },
        { key: randomUUID(), now: T0 + 5 },
      );
      expect(second.body.activeAttempt).toBe(2);
      const attempts = repo.listHandoffAttempts(sessionId, id);
      expect(attempts.attempts.map((a) => a.cause)).toEqual([
        "transient_infra",
        "environment",
      ]);
      // Nothing schedules attempts on its own: exactly the two recorded.
      expect(countRows(handle, "handoff_attempts")).toBe(2);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("sandbox success never sets production and boundary flags grant nothing", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const controlBefore = repo.getAutonomyControlState();
      const purpose = makePurpose(repo, sessionId, T0);
      const task = makeTask(repo, sessionId, T0 + 1, purpose.body.id);
      const created = makeHandoff(repo, sessionId, task.body.id, T0 + 2, {
        budgetLabel: "one focused afternoon",
        boundaries: [
          "external_publication",
          "shared_branch",
          "payment",
          "deletion",
          "secret",
          "access_change",
        ],
      });
      const id = created.body.id;
      const dispatched = repo.dispatchHandoff(
        sessionId,
        id,
        { expectedVersion: 1, externalRef: "pi-orch thread 7" },
        { key: randomUUID(), now: T0 + 3 },
      );
      expect(dispatched.body.externalRef).toBe("pi-orch thread 7");
      const reported = repo.reportHandoff(
        sessionId,
        id,
        {
          expectedVersion: dispatched.body.version,
          environment: "sandbox",
          summary: "green in sandbox",
        },
        { key: randomUUID(), now: T0 + 4 },
      );
      expect(reported.body.status).toBe("reported");
      expect(reported.body.reportEnvironment).toBe("sandbox");
      // No production column exists and nothing flips one: the stored row
      // carries only the unverified sandbox claim.
      const stored = handle.raw
        .prepare("SELECT * FROM delegation_handoffs WHERE id = ?")
        .get(id) as Record<string, unknown>;
      expect("production_deployed" in stored).toBe(false);
      expect(stored.report_environment).toBe("sandbox");
      // Recording every boundary flag changed no purpose, no control, no
      // task state, and created no grant row anywhere.
      expect(repo.getAutonomyControlState()).toEqual(controlBefore);
      expect(repo.getAutonomyPurpose(sessionId, purpose.body.id).status).toBe(
        "active",
      );
      expect(repo.getAutonomyTask(sessionId, task.body.id).status).toBe("open");
      expect(countRows(handle, "api_idempotency")).toBeGreaterThan(0);
      // Abnormal exit is an audited event only: lifecycle stays put.
      const abnormal = repo.abnormalExitHandoff(
        sessionId,
        id,
        { expectedVersion: reported.body.version },
        { key: randomUUID(), now: T0 + 5 },
      );
      expect(abnormal.body.status).toBe("reported");
      expect(abnormal.body.version).toBe(reported.body.version + 1);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("revocation flags active handoffs, blocks dispatch (stale CAS), cancel stays allowed, reaffirm clears", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const purpose = makePurpose(repo, sessionId, T0);
      const task = makeTask(repo, sessionId, T0 + 1, purpose.body.id);
      const created = makeHandoff(repo, sessionId, task.body.id, T0 + 2);
      const id = created.body.id;
      repo.revokeAutonomyPurpose(
        sessionId,
        purpose.body.id,
        { expectedVersion: 1 },
        { key: randomUUID(), now: T0 + 3 },
      );
      const flagged = repo.getHandoff(sessionId, id);
      expect(flagged.needsReevaluation).toBe(true);
      expect(flagged.version).toBe(2);
      // New dispatch is refused while the notice is set.
      expect(() =>
        repo.dispatchHandoff(
          sessionId,
          id,
          { expectedVersion: flagged.version },
          { key: randomUUID(), now: T0 + 4 },
        ),
      ).toThrow(HandoffStateConflictError);
      // A stale writer holding the pre-flag version conflicts.
      expect(() =>
        repo.dispatchHandoff(
          sessionId,
          id,
          { expectedVersion: 1 },
          { key: randomUUID(), now: T0 + 4 },
        ),
      ).toThrow(HandoffVersionConflictError);
      // Cancel is ALWAYS allowed under the notice.
      const cancelled = repo.cancelHandoff(
        sessionId,
        id,
        { expectedVersion: flagged.version },
        { key: randomUUID(), now: T0 + 5 },
      );
      expect(cancelled.body.status).toBe("cancelled");
      expect(cancelled.body.needsReevaluation).toBe(true);
      // A second record shows the reaffirm path: flag, reaffirm, dispatch.
      const second = makeHandoff(repo, sessionId, task.body.id, T0 + 6);
      void second;
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("reaffirm clears the notice and dispatch works again", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const purpose = makePurpose(repo, sessionId, T0);
      const task = makeTask(repo, sessionId, T0 + 1, purpose.body.id);
      const created = makeHandoff(repo, sessionId, task.body.id, T0 + 2);
      const id = created.body.id;
      repo.revokeAutonomyPurpose(
        sessionId,
        purpose.body.id,
        { expectedVersion: 1 },
        { key: randomUUID(), now: T0 + 3 },
      );
      const flagged = repo.getHandoff(sessionId, id);
      // Reaffirm without a notice refuses on a clean record (fresh active
      // parent so creation itself is unflagged; handoffs created under a
      // revoked parent start flagged instead).
      const cleanPurpose = makePurpose(repo, sessionId, T0 + 4, "clean goal");
      const cleanTask = makeTask(repo, sessionId, T0 + 5, cleanPurpose.body.id);
      const clean = makeHandoff(repo, sessionId, cleanTask.body.id, T0 + 6);
      expect(clean.body.needsReevaluation).toBe(false);
      expect(() =>
        repo.reaffirmHandoff(
          sessionId,
          clean.body.id,
          { expectedVersion: 1 },
          { key: randomUUID(), now: T0 + 5 },
        ),
      ).toThrow(HandoffStateConflictError);
      const reaffirmed = repo.reaffirmHandoff(
        sessionId,
        id,
        { expectedVersion: flagged.version },
        { key: randomUUID(), now: T0 + 6 },
      );
      expect(reaffirmed.body.needsReevaluation).toBe(false);
      expect(reaffirmed.body.status).toBe("prepared");
      const dispatched = repo.dispatchHandoff(
        sessionId,
        id,
        { expectedVersion: reaffirmed.body.version },
        { key: randomUUID(), now: T0 + 7 },
      );
      expect(dispatched.body.status).toBe("dispatched");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("supersede bumps the old version in the same tx; already-superseded refuses; dispatch/verify refuse after supersede (no fork)", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const purpose = makePurpose(repo, sessionId, T0);
      const task = makeTask(repo, sessionId, T0 + 1, purpose.body.id);
      const old = makeHandoff(repo, sessionId, task.body.id, T0 + 2);
      expect(old.body.version).toBe(1);
      const next = repo.createHandoff(
        sessionId,
        {
          taskId: task.body.id,
          target: "superseding handoff",
          acceptanceCriteria: ["one new criterion"],
          opScope: "implement",
          supersedesHandoffId: old.body.id,
        },
        { key: randomUUID(), now: T0 + 3 },
      );
      expect(next.status).toBe(201);
      // The OLD row was bumped in the SAME transaction: a human holding
      // the pre-supersede version can never race the successor.
      const reread = repo.getHandoff(sessionId, old.body.id);
      expect(reread.version).toBe(2);
      expect(reread.supersededBy).toBe(next.body.id);
      // A second forward link forks the frozen chain: refuses.
      expect(() =>
        repo.createHandoff(
          sessionId,
          {
            taskId: task.body.id,
            target: "attempted fork",
            acceptanceCriteria: ["another"],
            opScope: "investigate",
            supersedesHandoffId: old.body.id,
          },
          { key: randomUUID(), now: T0 + 4 },
        ),
      ).toThrow(HandoffStateConflictError);
      // The holder of the superseded handoff cannot dispatch/report/
      // verify/attempt over it (lifecycle 409s, no 500).
      expect(() =>
        repo.dispatchHandoff(
          sessionId,
          old.body.id,
          { expectedVersion: 2 },
          { key: randomUUID(), now: T0 + 5 },
        ),
      ).toThrow(HandoffStateConflictError);
      const oldCurrent = repo.getHandoff(sessionId, old.body.id);
      expect(() =>
        repo.reportHandoff(
          sessionId,
          old.body.id,
          {
            expectedVersion: oldCurrent.version,
            environment: "sandbox",
            summary: "superseded refuse",
          },
          { key: randomUUID(), now: T0 + 6 },
        ),
      ).toThrow(HandoffStateConflictError);
      const dispatched = repo.dispatchHandoff(
        sessionId,
        next.body.id,
        { expectedVersion: next.body.version },
        { key: randomUUID(), now: T0 + 7 },
      );
      const reported = repo.reportHandoff(
        sessionId,
        next.body.id,
        {
          expectedVersion: dispatched.body.version,
          environment: "sandbox",
          summary: "successor works",
        },
        { key: randomUUID(), now: T0 + 8 },
      );
      expect(() =>
        repo.verifyHandoff(
          sessionId,
          old.body.id,
          {
            expectedVersion: oldCurrent.version,
            results: [{ index: 0, pass: true, evidence: "e0" }],
          },
          { key: randomUUID(), now: T0 + 9 },
        ),
      ).toThrow(HandoffStateConflictError);
      // The successor's lifecycle is untouched by the old row's refusal.
      expect(reported.body.status).toBe("reported");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("recording an attempt on failed returns to prepared; full retry path dispatch→report→verify works", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const purpose = makePurpose(repo, sessionId, T0);
      const task = makeTask(repo, sessionId, T0 + 1, purpose.body.id);
      const created = makeHandoff(repo, sessionId, task.body.id, T0 + 2);
      const id = created.body.id;
      const dispatched = repo.dispatchHandoff(
        sessionId,
        id,
        { expectedVersion: 1 },
        { key: randomUUID(), now: T0 + 3 },
      );
      const failed = repo.failHandoff(
        sessionId,
        id,
        { expectedVersion: dispatched.body.version },
        { key: randomUUID(), now: T0 + 4 },
      );
      expect(failed.body.status).toBe("failed");
      const attempt = repo.recordHandoffAttempt(
        sessionId,
        id,
        { expectedVersion: failed.body.version, cause: "worker_error" },
        { key: randomUUID(), now: T0 + 5 },
      );
      // (a) semantics: the retry returns the handoff to PREPARED with the
      // recorded attempt count preserved.
      expect(attempt.body.status).toBe("prepared");
      expect(attempt.body.activeAttempt).toBe(1);
      expect(attempt.body.version).toBe(failed.body.version + 1);
      // The retry then follows the standard lifecycle: dispatch first.
      const redispatched = repo.dispatchHandoff(
        sessionId,
        id,
        { expectedVersion: attempt.body.version },
        { key: randomUUID(), now: T0 + 55 },
      );
      const rereported = repo.reportHandoff(
        sessionId,
        id,
        {
          expectedVersion: redispatched.body.version,
          environment: "sandbox",
          summary: "second try ran",
        },
        { key: randomUUID(), now: T0 + 6 },
      );
      expect(rereported.body.status).toBe("reported");
      const verified = repo.verifyHandoff(
        sessionId,
        id,
        {
          expectedVersion: rereported.body.version,
          results: [
            { index: 0, pass: true, evidence: "e0" },
            { index: 1, pass: true, evidence: "e1" },
          ],
        },
        { key: randomUUID(), now: T0 + 7 },
      );
      expect(verified.body.status).toBe("verified");
      const events = repo.listHandoffEvents(sessionId, id);
      const attemptEvent = events.events.find(
        (e) => e.event === "attempt_recorded",
      );
      expect(attemptEvent?.fromStatus).toBe("failed");
      expect(attemptEvent?.toStatus).toBe("prepared");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("completed/cancelled tasks refuse handoff create and dispatch", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const purpose = makePurpose(repo, sessionId, T0);
      const done = makeTask(repo, sessionId, T0 + 1, purpose.body.id);
      const cancelledTask = makeTask(repo, sessionId, T0 + 2, purpose.body.id);
      repo.completeAutonomyTask(
        sessionId,
        done.body.id,
        { expectedVersion: 1 },
        { key: randomUUID(), now: T0 + 3 },
      );
      repo.cancelAutonomyTask(
        sessionId,
        cancelledTask.body.id,
        { expectedVersion: 1 },
        { key: randomUUID(), now: T0 + 3 },
      );
      for (const task of [done, cancelledTask]) {
        expect(() =>
          repo.createHandoff(
            sessionId,
            {
              taskId: task.body.id,
              target: "terminal work",
              acceptanceCriteria: ["one"],
              opScope: "investigate",
            },
            { key: randomUUID(), now: T0 + 4 },
          ),
        ).toThrow(HandoffStateConflictError);
      }
      // A task completed AFTER the handoff froze refuses at dispatch.
      const stillOpen = makeTask(repo, sessionId, T0 + 5, purpose.body.id);
      const created = makeHandoff(repo, sessionId, stillOpen.body.id, T0 + 6);
      repo.completeAutonomyTask(
        sessionId,
        stillOpen.body.id,
        { expectedVersion: 1 },
        { key: randomUUID(), now: T0 + 7 },
      );
      expect(() =>
        repo.dispatchHandoff(
          sessionId,
          created.body.id,
          { expectedVersion: 1 },
          { key: randomUUID(), now: T0 + 8 },
        ),
      ).toThrow(HandoffStateConflictError);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("re-parented plus parentless-origin tasks are flagged via their CURRENT parent on revoke; flagged handoffs refuse attempts", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      // Re-parent case: handoff froze parent A, but the task currently
      // belongs to purpose B (resumed with an explicit new parent).
      const purposeA = makePurpose(repo, sessionId, T0, "goal A");
      const taskA = makeTask(repo, sessionId, T0 + 1, purposeA.body.id);
      const handoffA = makeHandoff(repo, sessionId, taskA.body.id, T0 + 2);
      repo.holdAutonomyTask(
        sessionId,
        taskA.body.id,
        { expectedVersion: 1, reason: "work", reconsiderTrigger: "work" },
        { key: randomUUID(), now: T0 + 3 },
      );
      const purposeB = makePurpose(repo, sessionId, T0 + 4, "goal B");
      repo.resumeAutonomyTask(
        sessionId,
        taskA.body.id,
        {
          expectedVersion: 2,
          evidenceKind: "parent_changed",
          evidence: "re-parented to goal B",
          newParentPurposeId: purposeB.body.id,
        },
        { key: randomUUID(), now: T0 + 5 },
      );
      // Parentless-origin case: the handoff froze NO parent, the task
      // gained one via a resume.
      const taskB = repo.createAutonomyTask(
        sessionId,
        {
          scope: "work",
          title: "standalone task",
          kind: "task",
          speaker: "user",
        },
        { key: randomUUID(), now: T0 + 6 },
      );
      const handoffB = makeHandoff(repo, sessionId, taskB.body.id, T0 + 7);
      expect(handoffB.body.parentPurposeId).toBeNull();
      repo.holdAutonomyTask(
        sessionId,
        taskB.body.id,
        { expectedVersion: 1, reason: "work", reconsiderTrigger: "work" },
        { key: randomUUID(), now: T0 + 8 },
      );
      repo.resumeAutonomyTask(
        sessionId,
        taskB.body.id,
        {
          expectedVersion: 2,
          evidenceKind: "parent_changed",
          evidence: "adopted goal B",
          newParentPurposeId: purposeB.body.id,
        },
        { key: randomUUID(), now: T0 + 9 },
      );
      // Revoking B flags BOTH handoffs (current-parent match), each with
      // its own version bump under CAS.
      repo.revokeAutonomyPurpose(
        sessionId,
        purposeB.body.id,
        { expectedVersion: 1 },
        { key: randomUUID(), now: T0 + 10 },
      );
      expect(
        repo.getHandoff(sessionId, handoffA.body.id).needsReevaluation,
      ).toBe(true);
      expect(
        repo.getHandoff(sessionId, handoffB.body.id).needsReevaluation,
      ).toBe(true);
      const flagged = repo.getHandoff(sessionId, handoffA.body.id);
      expect(flagged.version).toBe(2);
      // The flagged gate also refuses recorded attempts until reaffirm.
      expect(() =>
        repo.recordHandoffAttempt(
          sessionId,
          handoffA.body.id,
          { expectedVersion: flagged.version, cause: "worker_error" },
          { key: randomUUID(), now: T0 + 11 },
        ),
      ).toThrow(HandoffStateConflictError);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("idempotent replay returns the stored body; key reuse with drift conflicts", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const purpose = makePurpose(repo, sessionId, T0);
      const task = makeTask(repo, sessionId, T0 + 1, purpose.body.id);
      const key = randomUUID();
      const first = repo.createHandoff(
        sessionId,
        {
          taskId: task.body.id,
          target: "hand the queue migration to pi-orch",
          acceptanceCriteria: ["queue drains without loss"],
          opScope: "investigate",
        },
        { key, now: T0 + 2 },
      );
      const replay = repo.createHandoff(
        sessionId,
        {
          taskId: task.body.id,
          target: "hand the queue migration to pi-orch",
          acceptanceCriteria: ["queue drains without loss"],
          opScope: "investigate",
        },
        { key, now: T0 + 3 },
      );
      expect(replay.replayed).toBe(true);
      expect(replay.body.id).toBe(first.body.id);
      expect(() =>
        repo.createHandoff(
          sessionId,
          {
            taskId: task.body.id,
            target: "a DIFFERENT target",
            acceptanceCriteria: ["queue drains without loss"],
            opScope: "investigate",
          },
          { key, now: T0 + 4 },
        ),
      ).toThrow(IdempotencyConflictError);
      // Stale CAS on dispatch conflicts.
      expect(() =>
        repo.dispatchHandoff(
          sessionId,
          first.body.id,
          { expectedVersion: 999 },
          { key: randomUUID(), now: T0 + 5 },
        ),
      ).toThrow(HandoffVersionConflictError);
      // Foreign-session reads are 404.
      const { otherId } = await makeRepo().then(async (second) => {
        closeKernelDatabase(second.handle);
        return { otherId: second.otherId };
      });
      expect(() => repo.getHandoff(otherId, first.body.id)).toThrow(
        RepositoryNotFoundError,
      );
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("model tools are read-only (list/open) and foreign ids fail closed", async () => {
    const { handle, repo, sessionId, otherId } = await makeRepo();
    try {
      const purpose = makePurpose(repo, sessionId, T0);
      const task = makeTask(repo, sessionId, T0 + 1, purpose.body.id);
      const created = makeHandoff(repo, sessionId, task.body.id, T0 + 2);
      const runId = newRunningRun(repo, sessionId, "check handoffs", T0 + 3);
      const listed = await invoke(
        handle,
        repo,
        "handoff.list",
        { limit: 10 },
        runId,
      );
      expect(listed.out.result.actualOutcome).toBe("succeeded");
      const listedBody = listed.out.modelFacing as {
        items: { handoffId: string; status: string }[];
        hasMore: boolean;
        activeCount: number;
      };
      expect(listedBody.items).toHaveLength(1);
      expect(listedBody.items[0]?.status).toBe("prepared");
      expect(listedBody.activeCount).toBe(0);
      const opened = await invoke(
        handle,
        repo,
        "handoff.open",
        { handoffId: created.body.id },
        runId,
      );
      expect(opened.out.result.actualOutcome).toBe("succeeded");
      expect(
        (opened.out.modelFacing as { acceptanceCriteria: string[] })
          .acceptanceCriteria,
      ).toHaveLength(2);
      // No write registration exists for the model.
      expect(listed.broker.toolNames()).toEqual(
        expect.arrayContaining(["handoff.list", "handoff.open"]),
      );
      expect(listed.broker.toolNames()).not.toContain("handoff.create");
      expect(listed.broker.toolNames()).not.toContain("handoff.verify");
      // A foreign id fails closed as execution_failed (no 404 leak).
      const foreignRun = newRunningRun(
        repo,
        sessionId,
        "open foreign",
        T0 + 4,
        runId,
      );
      const otherPurpose = makePurpose(repo, otherId, T0 + 5);
      const otherTask = makeTask(repo, otherId, T0 + 6, otherPurpose.body.id);
      const otherHandoff = makeHandoff(
        repo,
        otherId,
        otherTask.body.id,
        T0 + 7,
      );
      const foreign = await invoke(
        handle,
        repo,
        "handoff.open",
        { handoffId: otherHandoff.body.id },
        foreignRun,
      );
      expect(foreign.out.result.actualOutcome).toBe("failed");
      expect(foreign.out.result.errorCode).toBe("execution_failed");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("list pages by keyset and counts active handoffs", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const purpose = makePurpose(repo, sessionId, T0);
      const task = makeTask(repo, sessionId, T0 + 1, purpose.body.id);
      const first = makeHandoff(repo, sessionId, task.body.id, T0 + 2);
      makeHandoff(repo, sessionId, task.body.id, T0 + 3);
      makeHandoff(repo, sessionId, task.body.id, T0 + 4);
      const page = repo.listHandoffs(sessionId, { limit: 2 });
      expect(page.items).toHaveLength(2);
      expect(page.hasMore).toBe(true);
      expect(typeof page.nextCursor).toBe("string");
      const older = repo.listHandoffs(sessionId, {
        limit: 2,
        cursor: page.nextCursor ?? undefined,
      });
      expect(older.items).toHaveLength(1);
      expect(older.hasMore).toBe(false);
      // Dispatched handoffs count as active (tracking only, no limit).
      repo.dispatchHandoff(
        sessionId,
        first.body.id,
        { expectedVersion: 1 },
        { key: randomUUID(), now: T0 + 5 },
      );
      expect(repo.listHandoffs(sessionId, {}).activeCount).toBe(1);
      expect(
        repo.listHandoffs(sessionId, { status: "prepared" }).items,
      ).toHaveLength(2);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("same-millisecond handoffs keep exact append order across list pages (injected fixed clock)", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const purpose = makePurpose(repo, sessionId, T0);
      const task = makeTask(repo, sessionId, T0 + 1, purpose.body.id);
      // ONE injected clock value for every append below: all handoff rows
      // land in the same millisecond, where a (created_at, id) keyset
      // orders by RANDOM UUID and flakes against insertion order.
      const SAME_MS = T0 + 10;
      const ids: string[] = [];
      for (let n = 0; n < 10; n += 1) {
        const handoff = makeHandoff(repo, sessionId, task.body.id, SAME_MS, {
          target: `same-ms append ${n}`,
        });
        expect(handoff.status).toBe(201);
        ids.push((handoff.body as { id: string }).id);
      }
      // Pages (limit=3, newest-first) stitch to the exact append order
      // reversed — no random-id reorder inside the same millisecond.
      const listed: string[] = [];
      let hasMore = true;
      let cursor: string | undefined;
      while (hasMore) {
        const page = repo.listHandoffs(sessionId, {
          limit: 3,
          ...(cursor !== undefined ? { cursor } : {}),
        });
        for (const item of page.items) listed.push((item as { id: string }).id);
        hasMore = page.hasMore;
        cursor = page.hasMore ? (page.nextCursor as string) : undefined;
      }
      expect(listed).toEqual([...ids].reverse());
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

describe("codex review #48 findings", () => {
  it("failed handoffs are flagged on parent revoke; attempt refused until reaffirm, then retry returns to prepared", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const purpose = makePurpose(repo, sessionId, T0);
      const task = makeTask(repo, sessionId, T0 + 1, purpose.body.id);
      const created = makeHandoff(repo, sessionId, task.body.id, T0 + 2);
      const failed = repo.failHandoff(
        sessionId,
        created.body.id,
        { expectedVersion: 1 },
        { key: randomUUID(), now: T0 + 3 },
      );
      expect(failed.body.status).toBe("failed");
      repo.revokeAutonomyPurpose(
        sessionId,
        purpose.body.id,
        { expectedVersion: 1 },
        { key: randomUUID(), now: T0 + 4 },
      );
      const flagged = repo.getHandoff(sessionId, created.body.id);
      expect(flagged.needsReevaluation).toBe(true);
      expect(() =>
        repo.recordHandoffAttempt(
          sessionId,
          created.body.id,
          { expectedVersion: flagged.version, cause: "worker_error" },
          { key: randomUUID(), now: T0 + 5 },
        ),
      ).toThrow(HandoffStateConflictError);
      const reaffirmed = repo.reaffirmHandoff(
        sessionId,
        created.body.id,
        { expectedVersion: flagged.version },
        { key: randomUUID(), now: T0 + 6 },
      );
      expect(reaffirmed.body.needsReevaluation).toBe(false);
      expect(reaffirmed.body.status).toBe("failed");
      const attempt = repo.recordHandoffAttempt(
        sessionId,
        created.body.id,
        {
          expectedVersion: reaffirmed.body.version,
          cause: "worker_error",
        },
        { key: randomUUID(), now: T0 + 7 },
      );
      expect(attempt.body.status).toBe("prepared");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("fail and abnormal-exit refuse superseded handoffs; cancel stays allowed", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const purpose = makePurpose(repo, sessionId, T0);
      const task = makeTask(repo, sessionId, T0 + 1, purpose.body.id);
      const old = makeHandoff(repo, sessionId, task.body.id, T0 + 2);
      const next = repo.createHandoff(
        sessionId,
        {
          taskId: task.body.id,
          target: "hand the queue migration to pi-orch",
          acceptanceCriteria: [
            "queue drains without loss",
            "no duplicate work",
            "alerts stay green",
          ],
          opScope: "implement",
          supersedesHandoffId: old.body.id,
        },
        { key: randomUUID(), now: T0 + 3 },
      );
      expect(next.status).toBe(201);
      const reread = repo.getHandoff(sessionId, old.body.id);
      expect(reread.supersededBy).toBe(next.body.id);
      expect(() =>
        repo.failHandoff(
          sessionId,
          old.body.id,
          { expectedVersion: reread.version },
          { key: randomUUID(), now: T0 + 4 },
        ),
      ).toThrow(HandoffStateConflictError);
      expect(() =>
        repo.abnormalExitHandoff(
          sessionId,
          old.body.id,
          { expectedVersion: reread.version },
          { key: randomUUID(), now: T0 + 5 },
        ),
      ).toThrow(HandoffStateConflictError);
      const cancelled = repo.cancelHandoff(
        sessionId,
        old.body.id,
        { expectedVersion: reread.version },
        { key: randomUUID(), now: T0 + 6 },
      );
      expect(cancelled.body.status).toBe("cancelled");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("dispatch refuses a handoff whose task was reparented on resume; reaffirm adopts the new binding and dispatch works", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const purposeA = makePurpose(repo, sessionId, T0, "goal A");
      const taskA = makeTask(repo, sessionId, T0 + 1, purposeA.body.id);
      const created = makeHandoff(repo, sessionId, taskA.body.id, T0 + 2);
      const id = created.body.id;
      repo.holdAutonomyTask(
        sessionId,
        taskA.body.id,
        { expectedVersion: 1, reason: "work", reconsiderTrigger: "work" },
        { key: randomUUID(), now: T0 + 3 },
      );
      const purposeB = makePurpose(repo, sessionId, T0 + 4, "goal B");
      repo.resumeAutonomyTask(
        sessionId,
        taskA.body.id,
        {
          expectedVersion: 2,
          evidenceKind: "parent_changed",
          evidence: "re-parented to goal B",
          newParentPurposeId: purposeB.body.id,
        },
        { key: randomUUID(), now: T0 + 5 },
      );
      // The resume hook flags the handoff (frozen parent A is stale).
      const flagged = repo.getHandoff(sessionId, id);
      expect(flagged.needsReevaluation).toBe(true);
      expect(() =>
        repo.dispatchHandoff(
          sessionId,
          id,
          { expectedVersion: flagged.version },
          { key: randomUUID(), now: T0 + 6 },
        ),
      ).toThrow(HandoffStateConflictError);
      const reaffirmed = repo.reaffirmHandoff(
        sessionId,
        id,
        { expectedVersion: flagged.version },
        { key: randomUUID(), now: T0 + 7 },
      );
      expect(reaffirmed.body.needsReevaluation).toBe(false);
      expect(reaffirmed.body.parentPurposeId).toBe(purposeB.body.id);
      const dispatched = repo.dispatchHandoff(
        sessionId,
        id,
        { expectedVersion: reaffirmed.body.version },
        { key: randomUUID(), now: T0 + 8 },
      );
      expect(dispatched.body.status).toBe("dispatched");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("history endpoints return event notes and stay bounded (newest-500 window)", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const purpose = makePurpose(repo, sessionId, T0);
      const task = makeTask(repo, sessionId, T0 + 1, purpose.body.id);
      const created = makeHandoff(repo, sessionId, task.body.id, T0 + 2);
      const id = created.body.id;
      repo.revokeAutonomyPurpose(
        sessionId,
        purpose.body.id,
        { expectedVersion: 1 },
        { key: randomUUID(), now: T0 + 3 },
      );
      const events = repo.listHandoffEvents(sessionId, id);
      const flagged = events.events.find(
        (e) => e.event === "reevaluation_flagged",
      );
      expect(flagged?.note).toContain("purpose_revoked");
      // Flood attempts: the endpoints stay capped, oldest-first, newest kept.
      const reaffirmed = repo.reaffirmHandoff(
        sessionId,
        id,
        { expectedVersion: repo.getHandoff(sessionId, id).version },
        { key: randomUUID(), now: T0 + 4 },
      );
      let version = reaffirmed.body.version;
      for (let n = 0; n < 505; n += 1) {
        const out = repo.recordHandoffAttempt(
          sessionId,
          id,
          { expectedVersion: version, cause: "worker_error" },
          { key: randomUUID(), now: T0 + 100 + n },
        );
        version = out.body.version;
      }
      const attempts = repo.listHandoffAttempts(sessionId, id);
      expect(attempts.attempts).toHaveLength(500);
      expect(attempts.attempts[0]?.attemptNo).toBe(6);
      const cappedEvents = repo.listHandoffEvents(sessionId, id);
      expect(cappedEvents.events).toHaveLength(500);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
