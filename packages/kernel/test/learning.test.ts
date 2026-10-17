// AV04 learning slice: labeled hypotheses + anchored evidence + reevaluation.
//
// Proves through the REAL kernel repository + migrator + ToolBroker
// (in-memory DB, no mocks):
// - human creation records an `open` human-origin hypothesis; read DTOs
//   carry the explicit hypothesis label (kind + status + evidence counts);
// - model `learning.propose` stages pending only (server-bound run/turn,
//   ordinary `user_text` only); a non-text source fails; strict tool input
//   rejects status/source smuggling; staged records need explicit human
//   accept/reject (direct transition of a staged record fails);
// - a rejected conversation proposal anchors ONLY `refutes` polarity for
//   the proposal-method hypothesis at most (rejected + supports fails;
//   accepted + refutes fails); attaching evidence NEVER creates/updates
//   purposes, preferences, permissions, grants, control, or budget;
// - status changes ONLY via explicit human transitions (CAS-checked); a
//   `refuted` hypothesis is still labeled `refuted` on read (never
//   surfaced as supported/fact); success evidence never flips a status;
// - revoking a parent purpose flags in-scope hypotheses with the durable
//   `needs_reevaluation` notice in the SAME transaction (no auto-cancel of
//   tasks, no auto-resume, idempotent flagging), cleared only by an
//   explicit human transition;
// - foreign-session ids are 404; idempotent replay returns the stored body
//   once; key reuse with a different body conflicts (409).

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AGENT_TOOL_ORIGIN } from "../src/agent.js";
import {
  IdempotencyConflictError,
  RepositoryNotFoundError,
} from "../src/errors.js";
import {
  closeKernelDatabase,
  createKernelRepository,
  createLearningRegistrations,
  createToolBroker,
  type KernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
} from "../src/index.js";
import {
  LearningStateConflictError,
  LearningVersionConflictError,
} from "../src/learning.js";

const T0 = 1_700_005_000_000;
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

function countRows(
  handle: ReturnType<typeof openKernelDatabase>,
  table: string,
): number {
  const row = handle.raw
    .prepare(`SELECT COUNT(*) AS n FROM ${table}`)
    .get() as { n: number };
  return row.n;
}

function makePurpose(
  repo: KernelRepository,
  sessionId: string,
  now: number,
  statement = "walk daily",
  scope = "health",
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
  scope = "health",
) {
  return repo.createAutonomyTask(
    sessionId,
    {
      scope,
      title: "morning run",
      kind: "task",
      speaker: "self",
      parentPurposeId,
    },
    { key: randomUUID(), now },
  );
}

function taskEventId(
  handle: ReturnType<typeof openKernelDatabase>,
  taskId: string,
): string {
  const row = handle.raw
    .prepare("SELECT id FROM autonomy_task_events WHERE task_id = ? LIMIT 1")
    .get(taskId) as { id: string } | undefined;
  if (row === undefined) throw new Error("no task event found");
  return row.id;
}

async function setup() {
  const made = await makeRepo();
  const broker = createToolBroker({
    db: made.handle.raw,
    repo: made.repo,
    registrations: [...createLearningRegistrations({ repo: made.repo })],
  });
  return { ...made, broker };
}

describe("learning hypotheses", () => {
  it("registers exactly the three learning tools", async () => {
    const { handle, broker } = await setup();
    try {
      expect([...broker.toolNames()].sort()).toEqual([
        "learning.list",
        "learning.open",
        "learning.propose",
      ]);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("human creation records an explicitly labeled open hypothesis", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const out = repo.createLearningHypothesis(
        sessionId,
        { scope: "health", kind: "hypothesis", statement: "morning runs help" },
        { key: randomUUID(), now: T0 + 10 },
      );
      expect(out.status).toBe(201);
      expect(out.body.status).toBe("open");
      expect(out.body.origin).toBe("human");
      expect(out.body.staged).toBe(false);
      expect(out.body.needsReevaluation).toBe(false);
      expect(out.body.evidenceCounts).toEqual({
        supports: 0,
        refutes: 0,
        neutral: 0,
      });
      const listed = repo.listLearningHypotheses(sessionId, { limit: 50 });
      expect(listed.items).toHaveLength(1);
      expect(listed.hasMore).toBe(false);
      expect(listed.nextCursor).toBeNull();
      const got = repo.getLearningHypothesis(sessionId, out.body.id);
      expect(got.statement).toBe("morning runs help");
      // Bounded statement: over-2000 code points rejected.
      expect(() =>
        repo.createLearningHypothesis(
          sessionId,
          { scope: "health", kind: "method", statement: "x".repeat(2001) },
          { key: randomUUID(), now: T0 + 11 },
        ),
      ).toThrow();
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("model learning.propose stages pending only; strict input rejects status smuggling", async () => {
    const { handle, repo, broker, sessionId } = await setup();
    try {
      const runId = newRunningRun(
        repo,
        sessionId,
        "morning runs feel great",
        T0,
      );
      const controlBefore = repo.getAutonomyControlState();
      const out = await broker.invoke(
        runId,
        "learning.propose",
        { scope: "health", kind: "hypothesis", statement: "morning runs help" },
        MODEL_CTX,
      );
      expect(out.result.actualOutcome).toBe("succeeded");
      const staged = out.modelFacing as Record<string, unknown>;
      expect(staged.status).toBe("open");
      expect(staged.staged).toBe(true);
      const view = repo.getLearningHypothesis(
        sessionId,
        staged.hypothesisId as string,
      );
      expect(view.origin).toBe("model");
      expect(view.staged).toBe(true);
      expect(view.status).toBe("open");
      // Zero authority from staging.
      expect(countRows(handle, "autonomy_purposes")).toBe(0);
      expect(countRows(handle, "autonomy_tasks")).toBe(0);
      expect(repo.getAutonomyControlState()).toEqual(controlBefore);
      // Strict tool input: status/source fields are rejected before staging.
      const smuggled = await broker.invoke(
        runId,
        "learning.propose",
        {
          scope: "health",
          kind: "method",
          statement: "sneaky",
          status: "supported",
        },
        MODEL_CTX,
      );
      expect(smuggled.result.actualOutcome).not.toBe("succeeded");
      // Direct transition of a staged record fails: human must accept first.
      expect(() =>
        repo.transitionLearningHypothesis(
          sessionId,
          staged.hypothesisId as string,
          { expectedVersion: 1, transition: "support" },
          { key: randomUUID(), now: T0 + 20 },
        ),
      ).toThrow(LearningStateConflictError);
      // Human accept clears staged (still open); human reject retires.
      const accepted = repo.acceptLearningHypothesis(
        sessionId,
        staged.hypothesisId as string,
        { expectedVersion: 1 },
        { key: randomUUID(), now: T0 + 21 },
      );
      expect(accepted.body.staged).toBe(false);
      expect(accepted.body.status).toBe("open");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("model propose fails on non-text sources and cannot set status via read tools", async () => {
    const { handle, repo, broker, sessionId } = await setup();
    try {
      const runId = newRunningRun(repo, sessionId, "plain chat", T0);
      // Read tools are read-only: learning.list/open never mutate.
      const listed = await broker.invoke(
        runId,
        "learning.list",
        { limit: 10 },
        MODEL_CTX,
      );
      expect(listed.result.actualOutcome).toBe("succeeded");
      expect((listed.modelFacing as { items: unknown[] }).items).toEqual([]);
      // No transition/evidence/accept tool exists for the model.
      expect(broker.toolNames()).not.toContain("learning.transition");
      // Foreign ids fail closed through the same fixed code.
      const foreign = await broker.invoke(
        runId,
        "learning.open",
        { hypothesisId: randomUUID() },
        MODEL_CTX,
      );
      expect(foreign.result.actualOutcome).not.toBe("succeeded");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("rejected proposal evidence is refutes-only and changes no control/grants", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      // Stage + reject a conversation proposal via the real kernel APIs.
      const runId = newRunningRun(repo, sessionId, "I should run at dawn", T0);
      const staged = repo.stageConversationProposalFromModel(
        runId,
        {
          target: "purpose",
          scope: "health",
          draftKind: "task",
          purposeKind: "goal",
          sourceQuote: "run at dawn",
          interpretation: "dawn running method",
        },
        { key: randomUUID() },
      );
      const rejected = repo.rejectConversationProposal(
        sessionId,
        (staged.body as { id: string }).id,
        { expectedVersion: 1 },
        { key: randomUUID(), now: T0 + 6 },
      );
      const proposalId = (rejected.body as { id: string }).id;
      const hyp = repo.createLearningHypothesis(
        sessionId,
        { scope: "health", kind: "method", statement: "dawn running works" },
        { key: randomUUID(), now: T0 + 7 },
      );
      const purposesBefore = countRows(handle, "autonomy_purposes");
      const controlBefore = repo.getAutonomyControlState();
      // Rejected + supports is rejected (never laundered into endorsement).
      expect(() =>
        repo.attachLearningEvidence(
          sessionId,
          hyp.body.id,
          {
            polarity: "supports",
            sourceKind: "conversation_proposal",
            sourceId: proposalId,
          },
          { key: randomUUID(), now: T0 + 8 },
        ),
      ).toThrow(LearningStateConflictError);
      // Rejected + refutes anchors at most as refutes.
      const ev = repo.attachLearningEvidence(
        sessionId,
        hyp.body.id,
        {
          polarity: "refutes",
          sourceKind: "conversation_proposal",
          sourceId: proposalId,
          note: "user declined the dawn method",
        },
        { key: randomUUID(), now: T0 + 9 },
      );
      expect(ev.status).toBe(201);
      expect(ev.body.polarity).toBe("refutes");
      // Nothing else moved: no purposes/preferences/permissions, no grants,
      // no control change; the hypothesis is still open (no auto-promotion).
      expect(countRows(handle, "autonomy_purposes")).toBe(purposesBefore);
      expect(countRows(handle, "action_execution_grants")).toBe(0);
      expect(repo.getAutonomyControlState()).toEqual(controlBefore);
      const after = repo.getLearningHypothesis(sessionId, hyp.body.id);
      expect(after.status).toBe("open");
      expect(after.evidenceCounts).toEqual({
        supports: 0,
        refutes: 1,
        neutral: 0,
      });
      const evidence = repo.listLearningHypothesisEvidence(
        sessionId,
        hyp.body.id,
      );
      expect(evidence.items).toHaveLength(1);
      expect(evidence.items[0]?.sourceKind).toBe("conversation_proposal");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("success evidence never alters control/budget and never flips status", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const purpose = makePurpose(repo, sessionId, T0 + 10);
      const task = makeTask(repo, sessionId, T0 + 11, purpose.body.id);
      const eventId = taskEventId(handle, task.body.id);
      const hyp = repo.createLearningHypothesis(
        sessionId,
        { scope: "health", kind: "method", statement: "task-first works" },
        { key: randomUUID(), now: T0 + 12 },
      );
      const controlBefore = repo.getAutonomyControlState();
      const ev = repo.attachLearningEvidence(
        sessionId,
        hyp.body.id,
        { polarity: "supports", sourceKind: "task_event", sourceId: eventId },
        { key: randomUUID(), now: T0 + 13 },
      );
      expect(ev.status).toBe(201);
      expect(repo.getAutonomyControlState()).toEqual(controlBefore);
      // Success evidence is a label only: the status is untouched.
      expect(repo.getLearningHypothesis(sessionId, hyp.body.id).status).toBe(
        "open",
      );
      // Model free-text claims are never valid sources.
      expect(() =>
        repo.attachLearningEvidence(
          sessionId,
          hyp.body.id,
          {
            polarity: "supports",
            sourceKind: "task_event",
            sourceId: randomUUID(),
          },
          { key: randomUUID(), now: T0 + 14 },
        ),
      ).toThrow(RepositoryNotFoundError);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("explicit transitions only: refuted stays labeled refuted, CAS enforced", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const hyp = repo.createLearningHypothesis(
        sessionId,
        { scope: "health", kind: "hypothesis", statement: "cold showers help" },
        { key: randomUUID(), now: T0 + 20 },
      );
      // Stale CAS fails before any state check.
      expect(() =>
        repo.transitionLearningHypothesis(
          sessionId,
          hyp.body.id,
          { expectedVersion: 999, transition: "support" },
          { key: randomUUID(), now: T0 + 21 },
        ),
      ).toThrow(LearningVersionConflictError);
      const refuted = repo.transitionLearningHypothesis(
        sessionId,
        hyp.body.id,
        { expectedVersion: 1, transition: "refute" },
        { key: randomUUID(), now: T0 + 22 },
      );
      expect(refuted.body.status).toBe("refuted");
      // Refuted is NEVER surfaced as supported/fact on read.
      const read = repo.getLearningHypothesis(sessionId, hyp.body.id);
      expect(read.status).toBe("refuted");
      const listed = repo.listLearningHypotheses(sessionId, {
        status: "supported",
      });
      expect(listed.items).toHaveLength(0);
      // Terminal-ish: supported from refuted is rejected (no promotion path).
      expect(() =>
        repo.transitionLearningHypothesis(
          sessionId,
          hyp.body.id,
          { expectedVersion: 2, transition: "support" },
          { key: randomUUID(), now: T0 + 23 },
        ),
      ).toThrow(LearningStateConflictError);
      const retired = repo.transitionLearningHypothesis(
        sessionId,
        hyp.body.id,
        { expectedVersion: 2, transition: "retire" },
        { key: randomUUID(), now: T0 + 24 },
      );
      expect(retired.body.status).toBe("retired");
      // Retired takes no new evidence.
      expect(() =>
        repo.attachLearningEvidence(
          sessionId,
          hyp.body.id,
          {
            polarity: "neutral",
            sourceKind: "task_event",
            sourceId: taskEventId(
              handle,
              makeTask(
                repo,
                sessionId,
                T0 + 25,
                makePurpose(repo, sessionId, T0 + 26).body.id,
              ).body.id,
            ),
          },
          { key: randomUUID(), now: T0 + 27 },
        ),
      ).toThrow(LearningStateConflictError);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("revocation flags in-scope hypotheses in the same tx: no auto-cancel, idempotent", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const purpose = makePurpose(repo, sessionId, T0 + 30);
      const task = makeTask(repo, sessionId, T0 + 31, purpose.body.id);
      const inScope = repo.createLearningHypothesis(
        sessionId,
        { scope: "health", kind: "method", statement: "scope-linked method" },
        { key: randomUUID(), now: T0 + 32 },
      );
      const otherScope = repo.createLearningHypothesis(
        sessionId,
        { scope: "work", kind: "method", statement: "unrelated method" },
        { key: randomUUID(), now: T0 + 33 },
      );
      const revoked = repo.revokeAutonomyPurpose(
        sessionId,
        purpose.body.id,
        { expectedVersion: 1 },
        { key: randomUUID(), now: T0 + 34 },
      );
      expect(revoked.body.status).toBe("revoked");
      // Dependent task is HELD (never auto-cancelled), hypothesis flagged.
      expect(repo.getAutonomyTask(sessionId, task.body.id).status).toBe("held");
      const flagged = repo.getLearningHypothesis(sessionId, inScope.body.id);
      expect(flagged.needsReevaluation).toBe(true);
      expect(flagged.status).toBe("open");
      // Out-of-scope hypothesis untouched; no rows were cancelled/retired.
      expect(
        repo.getLearningHypothesis(sessionId, otherScope.body.id)
          .needsReevaluation,
      ).toBe(false);
      expect(countRows(handle, "learning_hypotheses")).toBe(2);
      // Idempotent: a second correct/supersede path re-flags without dupes.
      const eventsBefore = repo.listLearningHypothesisEvents(
        sessionId,
        inScope.body.id,
      );
      const flaggedCount = eventsBefore.events.filter(
        (event) => event.event === "reevaluation_flagged",
      ).length;
      expect(flaggedCount).toBe(1);
      // Explicit human transition clears the notice (same tx, audited).
      const supported = repo.transitionLearningHypothesis(
        sessionId,
        inScope.body.id,
        { expectedVersion: 1, transition: "support" },
        { key: randomUUID(), now: T0 + 35 },
      );
      expect(supported.body.status).toBe("supported");
      expect(supported.body.needsReevaluation).toBe(false);
      const eventsAfter = repo.listLearningHypothesisEvents(
        sessionId,
        inScope.body.id,
      );
      expect(
        eventsAfter.events.some(
          (event) => event.event === "reevaluation_cleared",
        ),
      ).toBe(true);
      // Supersede also flags (correction path).
      const p2 = makePurpose(repo, sessionId, T0 + 36, "second goal");
      const h2 = repo.createLearningHypothesis(
        sessionId,
        { scope: "health", kind: "hypothesis", statement: "second guess" },
        { key: randomUUID(), now: T0 + 37 },
      );
      repo.correctAutonomyPurpose(
        sessionId,
        {
          scope: "health",
          statement: "second goal v2",
          kind: "goal",
          explicit: true,
          sourceKind: "user",
          purposeId: p2.body.id,
          expectedVersion: 1,
        },
        { key: randomUUID(), now: T0 + 38 },
      );
      expect(
        repo.getLearningHypothesis(sessionId, h2.body.id).needsReevaluation,
      ).toBe(true);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("foreign session is 404; idempotency replays and drifts 409", async () => {
    const { handle, repo, sessionId, otherId } = await makeRepo();
    try {
      const hyp = repo.createLearningHypothesis(
        sessionId,
        { scope: "health", kind: "hypothesis", statement: "owned guess" },
        { key: randomUUID(), now: T0 + 40 },
      );
      expect(() => repo.getLearningHypothesis(otherId, hyp.body.id)).toThrow(
        RepositoryNotFoundError,
      );
      expect(() =>
        repo.transitionLearningHypothesis(
          otherId,
          hyp.body.id,
          { expectedVersion: 1, transition: "refute" },
          { key: randomUUID(), now: T0 + 41 },
        ),
      ).toThrow(RepositoryNotFoundError);
      const key = randomUUID();
      const first = repo.transitionLearningHypothesis(
        sessionId,
        hyp.body.id,
        { expectedVersion: 1, transition: "refute" },
        { key, now: T0 + 42 },
      );
      expect(first.replayed).toBe(false);
      // Same key + same body replays the stored response.
      const replay = repo.transitionLearningHypothesis(
        sessionId,
        hyp.body.id,
        { expectedVersion: 1, transition: "refute" },
        { key, now: T0 + 43 },
      );
      expect(replay.replayed).toBe(true);
      expect(replay.body.status).toBe("refuted");
      // Same key + drifted body conflicts.
      expect(() =>
        repo.transitionLearningHypothesis(
          sessionId,
          hyp.body.id,
          { expectedVersion: 2, transition: "refute" },
          { key, now: T0 + 44 },
        ),
      ).toThrow(IdempotencyConflictError);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
