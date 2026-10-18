// AV03 conversation-proposal core: proposal-only staging + atomic adoption.
//
// Proves through the REAL kernel repository + migrator + ToolBroker
// (in-memory DB, no mocks):
// - `purpose.propose` / `task.propose` stage exactly one durable pending
//   draft each with server-derived source (session/run/turn + exact quote
//   substring of the CURRENT ordinary `user_text` body). Staging creates
//   NO purpose, NO task, NO grant, NO calendar write, and never touches
//   the stop control. Source kind is hardcoded `model`.
// - Model date invention is impossible: strict tool inputs reject
//   `deadline` / `validFrom` / `validUntil` before anything stages, and
//   staged drafts carry no dates.
// - Ordinary repeated calls with identical input replay the pending draft
//   (per-callId idempotency + semantic exact-input hash); a meaningfully
//   new source stages a new draft. Task drafts REQUIRE an explicit parent.
// - Action-approval (non-text) turns are ineligible sources.
// - Trusted human adoption is atomic: accept creates the actual purpose /
//   task + accepted-target link + decision history in ONE transaction
//   (parent drift/revocation/scope mismatch and bad human dates fail with
//   NOTHING created; reject creates nothing at all). The stop control is
//   never resumed by adoption.

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AGENT_TOOL_ORIGIN } from "../src/agent.js";
import {
  AutonomyStateConflictError,
  AutonomyVersionConflictError,
} from "../src/autonomy.js";
import {
  IdempotencyConflictError,
  RepositoryNotFoundError,
  RepositoryValidationError,
} from "../src/errors.js";
import {
  buildAgentToolDefinitions,
  closeKernelDatabase,
  createAutonomyReadRegistrations,
  createConversationProposalRegistrations,
  createKernelRepository,
  createToolBroker,
  type KernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
} from "../src/index.js";

const T0 = 1_700_004_000_000;
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
  // One active run per session: settle the prior run before posting next.
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

async function setup() {
  const made = await makeRepo();
  const broker = createToolBroker({
    db: made.handle.raw,
    repo: made.repo,
    registrations: [
      ...createAutonomyReadRegistrations({ repo: made.repo }),
      ...createConversationProposalRegistrations({ repo: made.repo }),
    ],
  });
  return { ...made, broker };
}

function makeParent(
  repo: KernelRepository,
  sessionId: string,
  now: number,
  statement = "run a marathon",
) {
  return repo.createAutonomyPurpose(
    sessionId,
    {
      scope: "health",
      statement,
      kind: "goal",
      explicit: true,
      sourceKind: "user",
    },
    { key: randomUUID(), now },
  );
}

describe("conversation proposal tools", () => {
  it("registers exactly the two proposal-only tools and advertises both", async () => {
    const { handle, broker } = await setup();
    try {
      const names = [...broker.toolNames()].sort();
      expect(names).toEqual([
        "purpose.list",
        "purpose.open",
        "purpose.propose",
        "task.list",
        "task.open",
        "task.propose",
      ]);
      const advertised = buildAgentToolDefinitions(broker.describeTools());
      expect(advertised.map((tool) => tool.name).sort()).toEqual([
        "answer.submit",
        "purpose.list",
        "purpose.open",
        "purpose.propose",
        "task.list",
        "task.open",
        "task.propose",
      ]);
      for (const tool of advertised) {
        expect(tool.parameters).toMatchObject({
          type: "object",
          additionalProperties: false,
        });
      }
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("purpose.propose stages a pending draft with server-derived source and zero authority", async () => {
    const { handle, repo, broker, sessionId } = await setup();
    try {
      const text = "I really should start running every morning";
      const runId = newRunningRun(repo, sessionId, text, T0);
      const controlBefore = repo.getAutonomyControlState();
      const out = await broker.invoke(
        runId,
        "purpose.propose",
        {
          scope: "health",
          draftKind: "task",
          purposeKind: "goal",
          sourceQuote: "start running every morning",
          interpretation: "user wants a morning running habit",
        },
        MODEL_CTX,
      );
      expect(out.result.actualOutcome).toBe("succeeded");
      const staged = out.modelFacing as Record<string, unknown>;
      expect(staged.target).toBe("purpose");
      expect(staged.status).toBe("pending");
      expect(staged.version).toBe(1);
      // Durable server-derived trace, immutable quote + separate reading.
      const view = repo.getConversationProposal(
        sessionId,
        staged.proposalId as string,
      );
      expect(view.sessionId).toBe(sessionId);
      expect(view.sourceKind).toBe("model");
      expect(view.sourceQuote).toBe("start running every morning");
      expect(view.interpretation).toBe("user wants a morning running habit");
      expect(view.purposeKind).toBe("goal");
      expect(view.taskKind).toBeNull();
      expect(view.parentPurposeId).toBeNull();
      expect(view.acceptedTargetId).toBeNull();
      const run = repo.getRun(runId);
      expect(view.sourceRunId).toBe(runId);
      expect(view.sourceTurnId).toBe(run.turnId);
      // Zero authority: no purpose/task/grant/calendar/control mutation.
      expect(countRows(handle, "autonomy_purposes")).toBe(0);
      expect(countRows(handle, "autonomy_tasks")).toBe(0);
      expect(countRows(handle, "action_proposals")).toBe(0);
      expect(repo.getAutonomyControlState()).toEqual(controlBefore);
      const events = repo.listConversationProposalEvents(
        sessionId,
        staged.proposalId as string,
      );
      expect(events.events.map((event) => event.event)).toEqual(["proposed"]);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("replays identical drafts and stages meaningfully new sources", async () => {
    const { handle, repo, broker, sessionId } = await setup();
    try {
      const text = "maybe I should read more books this year";
      const runId = newRunningRun(repo, sessionId, text, T0);
      const draft = {
        scope: "growth",
        draftKind: "wish",
        purposeKind: "wish",
        sourceQuote: "read more books",
        interpretation: "reading aspiration, no commitment yet",
      };
      const first = await broker.invoke(
        runId,
        "purpose.propose",
        draft,
        MODEL_CTX,
      );
      expect(first.result.actualOutcome).toBe("succeeded");
      const firstId = (first.modelFacing as { proposalId: string }).proposalId;
      // Same run, identical input: broker dedup reuses the same draft.
      const second = await broker.invoke(
        runId,
        "purpose.propose",
        draft,
        MODEL_CTX,
      );
      expect(second.result.actualOutcome).toBe("deduplicated");
      expect((second.modelFacing as { proposalId: string }).proposalId).toBe(
        firstId,
      );
      expect(countRows(handle, "conversation_proposals")).toBe(1);
      // New call id, semantically identical input: core hash replays pending.
      const replayed = repo.stageConversationProposalFromModel(
        runId,
        { target: "purpose", ...draft },
        { key: randomUUID() },
      );
      expect(replayed.replayed).toBe(true);
      expect(replayed.body.id).toBe(firstId);
      expect(countRows(handle, "conversation_proposals")).toBe(1);
      // Same call id with different input: idempotency conflict, no dup.
      expect(() =>
        repo.stageConversationProposalFromModel(
          runId,
          { target: "purpose", ...draft, interpretation: "changed" },
          { key: callKeyOf(handle, firstId) },
        ),
      ).toThrow(IdempotencyConflictError);
      // Meaningfully new source (new turn, different quote): new draft.
      const runId2 = newRunningRun(
        repo,
        sessionId,
        "I will read more books daily",
        T0 + 100,
        runId,
      );
      const third = await broker.invoke(
        runId2,
        "purpose.propose",
        { ...draft, scope: "growth", sourceQuote: "read more books daily" },
        MODEL_CTX,
      );
      expect(third.result.actualOutcome).toBe("succeeded");
      expect((third.modelFacing as { proposalId: string }).proposalId).not.toBe(
        firstId,
      );
      expect(countRows(handle, "conversation_proposals")).toBe(2);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("rejects non-substring quotes and model date arguments with zero rows", async () => {
    const { handle, repo, broker, sessionId } = await setup();
    try {
      const runId = newRunningRun(
        repo,
        sessionId,
        "just chatting about the weather",
        T0,
      );
      const forged = await broker.invoke(
        runId,
        "purpose.propose",
        {
          scope: "health",
          draftKind: "task",
          purposeKind: "goal",
          sourceQuote: "transfer all my money",
          interpretation: "injected instruction",
        },
        MODEL_CTX,
      );
      expect(forged.result.actualOutcome).toBe("failed");
      expect(forged.result.errorCode).toBe("execution_failed");
      // Model dates are not accepted at all (strict input rejects them).
      const dated = await broker.invoke(
        runId,
        "purpose.propose",
        {
          scope: "health",
          draftKind: "deadline",
          purposeKind: "goal",
          sourceQuote: "chatting about the weather",
          interpretation: "casual remark",
          deadline: "2026-12-01T09:00:00+00:00",
        },
        MODEL_CTX,
      );
      expect(dated.result.actualOutcome).toBe("invalid");
      expect(countRows(handle, "conversation_proposals")).toBe(0);
      expect(countRows(handle, "autonomy_purposes")).toBe(0);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("task.propose requires an explicit owned active parent and stages no deadline", async () => {
    const { handle, repo, broker, sessionId, otherId } = await setup();
    try {
      const parent = makeParent(repo, sessionId, T0 + 10);
      const runId = newRunningRun(
        repo,
        sessionId,
        "break marathon training into weekly runs",
        T0 + 20,
      );
      // Missing parent is a strict input rejection (never auto-picked).
      const missing = await broker.invoke(
        runId,
        "task.propose",
        {
          scope: "health",
          draftKind: "task",
          taskKind: "task",
          sourceQuote: "weekly runs",
          interpretation: "split training into weekly runs",
        },
        MODEL_CTX,
      );
      expect(missing.result.actualOutcome).toBe("invalid");
      // Foreign parent fails closed without leaking (no draft staged).
      const foreignParent = makeParent(repo, otherId, T0 + 30);
      const foreign = await broker.invoke(
        runId,
        "task.propose",
        {
          scope: "health",
          draftKind: "task",
          taskKind: "task",
          sourceQuote: "weekly runs",
          interpretation: "split training into weekly runs",
          parentPurposeId: foreignParent.body.id,
          expectedParentVersion: 1,
        },
        MODEL_CTX,
      );
      expect(foreign.result.actualOutcome).toBe("failed");
      // Stale parent version fails closed.
      const stale = await broker.invoke(
        runId,
        "task.propose",
        {
          scope: "health",
          draftKind: "task",
          taskKind: "task",
          sourceQuote: "weekly runs",
          interpretation: "split training into weekly runs",
          parentPurposeId: parent.body.id,
          expectedParentVersion: 2,
        },
        MODEL_CTX,
      );
      expect(stale.result.actualOutcome).toBe("failed");
      expect(countRows(handle, "conversation_proposals")).toBe(0);
      // Explicit owned parent stages a pending draft with no deadline.
      const ok = await broker.invoke(
        runId,
        "task.propose",
        {
          scope: "health",
          draftKind: "task",
          taskKind: "task",
          sourceQuote: "weekly runs",
          interpretation: "split training into weekly runs",
          parentPurposeId: parent.body.id,
          expectedParentVersion: 1,
        },
        MODEL_CTX,
      );
      expect(ok.result.actualOutcome).toBe("succeeded");
      const view = repo.getConversationProposal(
        sessionId,
        (ok.modelFacing as { proposalId: string }).proposalId,
      );
      expect(view.target).toBe("task");
      expect(view.parentPurposeId).toBe(parent.body.id);
      expect(view.expectedParentVersion).toBe(1);
      expect(view.status).toBe("pending");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("refuses action-approval turns as proposal sources", async () => {
    const { handle, repo, sessionId } = await setup();
    try {
      const runId = newRunningRun(repo, sessionId, "ordinary chat first", T0);
      repo.failRun(runId, "execution_failed", { now: T0 + 10 });
      const run = repo.getRun(runId);
      const frozen = handle.raw
        .prepare("SELECT frozen_context FROM turns WHERE id = ?")
        .get(run.turnId) as { frozen_context: string };
      const approvalTurn = randomUUID();
      handle.raw
        .prepare(
          "INSERT INTO turns (id, session_id, seq, input_json, frozen_context, created_at, next_run_attempt) VALUES (?, ?, 999, ?, ?, ?, 1)",
        )
        .run(
          approvalTurn,
          sessionId,
          JSON.stringify({
            kind: "action_approval",
            version: 1,
            proposalId: randomUUID(),
            proposalHash: "a".repeat(64),
          }),
          frozen.frozen_context,
          T0 + 50,
        );
      const approvalRun = randomUUID();
      handle.raw
        .prepare(
          "INSERT INTO runs (id, turn_id, session_id, attempt, status, strategy, result_json, error_code, event_seq, select_on_success, tool_requests_used, created_at, started_at, finished_at, cancel_requested_at) VALUES (?, ?, ?, 1, 'running', 'agent', NULL, NULL, 0, 1, 0, ?, ?, NULL, NULL)",
        )
        .run(approvalRun, approvalTurn, sessionId, T0 + 51, T0 + 51);
      expect(() =>
        repo.stageConversationProposalFromModel(
          approvalRun,
          {
            target: "purpose",
            scope: "health",
            draftKind: "task",
            purposeKind: "goal",
            sourceQuote: "ordinary chat first",
            interpretation: "approval must never source a draft",
          },
          { key: randomUUID() },
        ),
      ).toThrow(RepositoryValidationError);
      expect(countRows(handle, "conversation_proposals")).toBe(0);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

describe("conversation proposal adoption (trusted human core)", () => {
  it("accepts a purpose draft atomically with inferred self provenance", async () => {
    const { handle, repo, sessionId } = await setup();
    try {
      const runId = newRunningRun(
        repo,
        sessionId,
        "I want to meditate each evening",
        T0,
      );
      const staged = repo.stageConversationProposalFromModel(
        runId,
        {
          target: "purpose",
          scope: "health",
          draftKind: "task",
          purposeKind: "goal",
          sourceQuote: "meditate each evening",
          interpretation: "evening meditation habit",
        },
        { key: randomUUID(), now: T0 + 5 },
      );
      const controlBefore = repo.getAutonomyControlState();
      const accepted = repo.acceptConversationProposal(
        sessionId,
        staged.body.id,
        { expectedVersion: 1 },
        { key: randomUUID(), now: T0 + 10 },
      );
      expect(accepted.status).toBe(201);
      expect(accepted.body.proposal.status).toBe("accepted");
      expect(accepted.body.proposal.version).toBe(2);
      expect(accepted.body.purpose).not.toBeNull();
      expect(accepted.body.task).toBeNull();
      const purpose = accepted.body.purpose;
      expect(purpose).not.toBeNull();
      if (purpose === null) {
        throw new Error("expected adopted purpose");
      }
      expect(accepted.body.proposal.acceptedTargetId).toBe(purpose.id);
      // Original quote + interpretation retained; inference is SELF, never user.
      expect(purpose.statement).toBe("meditate each evening");
      expect(purpose.interpretation).toBe("evening meditation habit");
      expect(purpose.sourceKind).toBe("self");
      expect(purpose.sourceTurnId).toBe(staged.body.sourceTurnId);
      expect(purpose.explicit).toBe(false);
      expect(purpose.validFrom).toBeNull();
      expect(purpose.validUntil).toBeNull();
      // Decision history is append-only; stop control untouched.
      const events = repo.listConversationProposalEvents(
        sessionId,
        staged.body.id,
      );
      expect(events.events.map((event) => event.event)).toEqual([
        "proposed",
        "accepted",
      ]);
      expect(repo.getAutonomyControlState()).toEqual(controlBefore);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("accept replay is idempotent and drifted accepts fail without side effects", async () => {
    const { handle, repo, sessionId } = await setup();
    try {
      const runId = newRunningRun(
        repo,
        sessionId,
        "drink more water daily",
        T0,
      );
      const staged = repo.stageConversationProposalFromModel(
        runId,
        {
          target: "purpose",
          scope: "health",
          draftKind: "task",
          purposeKind: "goal",
          sourceQuote: "drink more water daily",
          interpretation: "hydration habit",
        },
        { key: randomUUID(), now: T0 + 5 },
      );
      const key = randomUUID();
      const first = repo.acceptConversationProposal(
        sessionId,
        staged.body.id,
        { expectedVersion: 1 },
        { key, now: T0 + 10 },
      );
      expect(first.replayed).toBe(false);
      const purposesBefore = countRows(handle, "autonomy_purposes");
      const second = repo.acceptConversationProposal(
        sessionId,
        staged.body.id,
        { expectedVersion: 1 },
        { key, now: T0 + 11 },
      );
      expect(second.replayed).toBe(true);
      expect(second.body.proposal.id).toBe(first.body.proposal.id);
      expect(countRows(handle, "autonomy_purposes")).toBe(purposesBefore);
      // Stale version with a fresh key is a version conflict, not a dup.
      expect(() =>
        repo.acceptConversationProposal(
          sessionId,
          staged.body.id,
          { expectedVersion: 1 },
          { key: randomUUID(), now: T0 + 12 },
        ),
      ).toThrow(AutonomyStateConflictError);
      // Same key with a different body is an idempotency conflict.
      expect(() =>
        repo.acceptConversationProposal(
          sessionId,
          staged.body.id,
          { expectedVersion: 2 },
          { key, now: T0 + 13 },
        ),
      ).toThrow(IdempotencyConflictError);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("accepts a task draft with a human-explicit deadline and self speaker trace", async () => {
    const { handle, repo, sessionId } = await setup();
    try {
      const parent = makeParent(repo, sessionId, T0 + 2);
      const runId = newRunningRun(
        repo,
        sessionId,
        "schedule the long run for Sunday",
        T0 + 3,
      );
      const staged = repo.stageConversationProposalFromModel(
        runId,
        {
          target: "task",
          scope: "health",
          draftKind: "task",
          taskKind: "task",
          sourceQuote: "schedule the long run",
          interpretation: "weekend long run session",
          parentPurposeId: parent.body.id,
          expectedParentVersion: 1,
        },
        { key: randomUUID(), now: T0 + 4 },
      );
      const controlBefore = repo.getAutonomyControlState();
      const accepted = repo.acceptConversationProposal(
        sessionId,
        staged.body.id,
        { expectedVersion: 1, deadline: "2026-10-26T07:00:00+00:00" },
        { key: randomUUID(), now: T0 + 6 },
      );
      expect(accepted.status).toBe(201);
      const task = accepted.body.task;
      expect(task).not.toBeNull();
      if (task === null) {
        throw new Error("expected adopted task");
      }
      expect(accepted.body.purpose).toBeNull();
      expect(task.title).toBe("schedule the long run");
      expect(task.body).toBe("weekend long run session");
      expect(task.speaker).toBe("self");
      expect(task.parentPurposeId).toBe(parent.body.id);
      expect(task.deadline).toBe("2026-10-26T07:00:00+00:00");
      expect(accepted.body.proposal.acceptedTargetId).toBe(task.id);
      expect(repo.getAutonomyControlState()).toEqual(controlBefore);
      // Without a human deadline the adopted task deadline stays NULL.
      const runId2 = newRunningRun(
        repo,
        sessionId,
        "plan an easy recovery jog",
        T0 + 20,
        runId,
      );
      const staged2 = repo.stageConversationProposalFromModel(
        runId2,
        {
          target: "task",
          scope: "health",
          draftKind: "task",
          taskKind: "task",
          sourceQuote: "easy recovery jog",
          interpretation: "light recovery session",
          parentPurposeId: parent.body.id,
          expectedParentVersion: 1,
        },
        { key: randomUUID(), now: T0 + 21 },
      );
      const accepted2 = repo.acceptConversationProposal(
        sessionId,
        staged2.body.id,
        { expectedVersion: 1 },
        { key: randomUUID(), now: T0 + 22 },
      );
      const adopted2 = accepted2.body.task;
      expect(adopted2).not.toBeNull();
      expect(adopted2?.deadline ?? null).toBeNull();
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("rolls back atomically on invalid human dates and parent drift", async () => {
    const { handle, repo, sessionId } = await setup();
    try {
      const parent = makeParent(repo, sessionId, T0 + 2);
      const runId = newRunningRun(
        repo,
        sessionId,
        "add tempo intervals Tuesday",
        T0 + 3,
      );
      const staged = repo.stageConversationProposalFromModel(
        runId,
        {
          target: "task",
          scope: "health",
          draftKind: "task",
          taskKind: "task",
          sourceQuote: "tempo intervals Tuesday",
          interpretation: "midweek speed work",
          parentPurposeId: parent.body.id,
          expectedParentVersion: 1,
        },
        { key: randomUUID(), now: T0 + 4 },
      );
      const purposesBefore = countRows(handle, "autonomy_purposes");
      const tasksBefore = countRows(handle, "autonomy_tasks");
      // Bad human deadline: validation fails BEFORE any write.
      expect(() =>
        repo.acceptConversationProposal(
          sessionId,
          staged.body.id,
          { expectedVersion: 1, deadline: "next Tuesday" },
          { key: randomUUID(), now: T0 + 5 },
        ),
      ).toThrow(RepositoryValidationError);
      expect(
        repo.getConversationProposal(sessionId, staged.body.id).status,
      ).toBe("pending");
      expect(countRows(handle, "autonomy_tasks")).toBe(tasksBefore);
      // Parent drift (corrected => old record superseded): the recorded
      // parent is no longer active, so adoption fails closed with a
      // state conflict (409-class) and nothing is created. Version
      // staleness against a still-active parent is pinned at stage time.
      expect(() =>
        repo.stageConversationProposalFromModel(
          runId,
          {
            target: "task",
            scope: "health",
            draftKind: "task",
            taskKind: "task",
            sourceQuote: "tempo intervals Tuesday",
            interpretation: "midweek speed work",
            parentPurposeId: parent.body.id,
            expectedParentVersion: 9,
          },
          { key: randomUUID(), now: T0 + 5 },
        ),
      ).toThrow(AutonomyVersionConflictError);
      repo.correctAutonomyPurpose(
        sessionId,
        {
          purposeId: parent.body.id,
          expectedVersion: 1,
          scope: "health",
          statement: "run a marathon",
          kind: "goal",
          explicit: true,
          sourceKind: "user",
        },
        { key: randomUUID(), now: T0 + 6 },
      );
      expect(() =>
        repo.acceptConversationProposal(
          sessionId,
          staged.body.id,
          { expectedVersion: 1 },
          { key: randomUUID(), now: T0 + 7 },
        ),
      ).toThrow(AutonomyStateConflictError);
      expect(countRows(handle, "autonomy_tasks")).toBe(tasksBefore);
      expect(countRows(handle, "autonomy_purposes")).toBe(purposesBefore + 1);
      // Parent revocation: state conflict, nothing created.
      const freshParent = makeParent(repo, sessionId, T0 + 8, "swim weekly");
      const runId2 = newRunningRun(
        repo,
        sessionId,
        "buy new goggles soon",
        T0 + 9,
        runId,
      );
      const staged2 = repo.stageConversationProposalFromModel(
        runId2,
        {
          target: "task",
          scope: "health",
          draftKind: "task",
          taskKind: "task",
          sourceQuote: "buy new goggles",
          interpretation: "swim gear errand",
          parentPurposeId: freshParent.body.id,
          expectedParentVersion: 1,
        },
        { key: randomUUID(), now: T0 + 10 },
      );
      repo.revokeAutonomyPurpose(
        sessionId,
        freshParent.body.id,
        { expectedVersion: 1 },
        { key: randomUUID(), now: T0 + 11 },
      );
      expect(() =>
        repo.acceptConversationProposal(
          sessionId,
          staged2.body.id,
          { expectedVersion: 1 },
          { key: randomUUID(), now: T0 + 12 },
        ),
      ).toThrow(AutonomyStateConflictError);
      expect(
        repo.getConversationProposal(sessionId, staged2.body.id).status,
      ).toBe("pending");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("rejects terminally with zero preference/learning side effects", async () => {
    const { handle, repo, sessionId } = await setup();
    try {
      const runId = newRunningRun(
        repo,
        sessionId,
        "maybe take up chess sometime",
        T0,
      );
      const staged = repo.stageConversationProposalFromModel(
        runId,
        {
          target: "purpose",
          scope: "growth",
          draftKind: "casual",
          purposeKind: "wish",
          sourceQuote: "take up chess",
          interpretation: "passing interest, no commitment",
        },
        { key: randomUUID(), now: T0 + 2 },
      );
      const key = randomUUID();
      const controlBefore = repo.getAutonomyControlState();
      const rejected = repo.rejectConversationProposal(
        sessionId,
        staged.body.id,
        { expectedVersion: 1 },
        { key, now: T0 + 3 },
      );
      expect(rejected.status).toBe(200);
      expect(rejected.body.status).toBe("rejected");
      expect(rejected.body.version).toBe(2);
      // Zero creation: no purpose/task, control untouched, history appended.
      expect(countRows(handle, "autonomy_purposes")).toBe(0);
      expect(countRows(handle, "autonomy_tasks")).toBe(0);
      expect(repo.getAutonomyControlState()).toEqual(controlBefore);
      const events = repo.listConversationProposalEvents(
        sessionId,
        staged.body.id,
      );
      expect(events.events.map((event) => event.event)).toEqual([
        "proposed",
        "rejected",
      ]);
      // Replay with the same key; a fresh key on a terminal row conflicts on state.
      const again = repo.rejectConversationProposal(
        sessionId,
        staged.body.id,
        { expectedVersion: 1 },
        { key, now: T0 + 4 },
      );
      expect(again.replayed).toBe(true);
      expect(() =>
        repo.rejectConversationProposal(
          sessionId,
          staged.body.id,
          { expectedVersion: 2 },
          { key: randomUUID(), now: T0 + 5 },
        ),
      ).toThrow(AutonomyStateConflictError);
      // Rejected drafts can never be adopted.
      expect(() =>
        repo.acceptConversationProposal(
          sessionId,
          staged.body.id,
          { expectedVersion: 2 },
          { key: randomUUID(), now: T0 + 6 },
        ),
      ).toThrow(AutonomyStateConflictError);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("keeps proposals owned, bounded, and foreign reads closed", async () => {
    const { handle, repo, sessionId, otherId } = await setup();
    try {
      const runId = newRunningRun(repo, sessionId, "journal every night", T0);
      const staged = repo.stageConversationProposalFromModel(
        runId,
        {
          target: "purpose",
          scope: "health",
          draftKind: "task",
          purposeKind: "goal",
          sourceQuote: "journal every night",
          interpretation: "nightly journaling habit",
        },
        { key: randomUUID(), now: T0 + 2 },
      );
      expect(() =>
        repo.getConversationProposal(otherId, staged.body.id),
      ).toThrow(RepositoryNotFoundError);
      expect(() =>
        repo.acceptConversationProposal(
          otherId,
          staged.body.id,
          { expectedVersion: 1 },
          { key: randomUUID(), now: T0 + 3 },
        ),
      ).toThrow(RepositoryNotFoundError);
      const listed = repo.listConversationProposals(sessionId, { limit: 50 });
      expect(listed.items).toHaveLength(1);
      expect(
        repo.listConversationProposals(otherId, { limit: 50 }).items,
      ).toHaveLength(0);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

describe("conversation proposal retry dedup", () => {
  it("replays the pending draft when a retry run restages the same turn", async () => {
    const { handle, repo, sessionId } = await setup();
    try {
      const text = "maybe I should read more books this year";
      const runId = newRunningRun(repo, sessionId, text, T0);
      const run = repo.getRun(runId);
      const draft = {
        target: "purpose",
        scope: "growth",
        draftKind: "wish",
        purposeKind: "wish",
        sourceQuote: "read more books",
        interpretation: "reading aspiration, no commitment yet",
      } as const;
      const first = repo.stageConversationProposalFromModel(
        runId,
        { ...draft },
        { key: randomUUID(), now: T0 + 2 },
      );
      expect(first.replayed).toBe(false);
      // Retry the SAME turn: a new run id, unchanged turn + draft content.
      repo.failRun(runId, "execution_failed", { now: T0 + 3 });
      const retry = repo.postRetry(sessionId, run.turnId, {
        key: randomUUID(),
        now: T0 + 4,
      });
      const retryRunId = (retry.body as { run: { id: string } }).run.id;
      repo.startRun(retryRunId, { now: T0 + 5 });
      expect(retryRunId).not.toBe(runId);
      const second = repo.stageConversationProposalFromModel(
        retryRunId,
        { ...draft },
        { key: randomUUID(), now: T0 + 6 },
      );
      expect(second.replayed).toBe(true);
      expect(second.body.id).toBe(first.body.id);
      expect(second.body.sourceTurnId).toBe(first.body.sourceTurnId);
      expect(countRows(handle, "conversation_proposals")).toBe(1);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

function callKeyOf(
  handle: ReturnType<typeof openKernelDatabase>,
  proposalId: string,
): string {
  const row = handle.raw
    .prepare(
      "SELECT stage_call_id AS callId FROM conversation_proposals WHERE id = ?",
    )
    .get(proposalId) as { callId: string };
  return row.callId;
}
