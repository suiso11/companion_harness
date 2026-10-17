// AV04 learning review fixes (read-only review feedback, consumer-boundary).
//
// Proves through the REAL kernel repository + migrator + ToolBroker and the
// REAL normal agent (in-memory DB, zero mocks):
// - the model actually sees `learning.list` / `learning.open` /
//   `learning.propose` (closed parameter schemas, never
//   `additionalProperties: true`) and a native `learning.propose` tool
//   call stages exactly ONE pending hypothesis (human accept adopts it);
// - a scope-CHANGING correction flags the OLD scope (not just the new one);
// - the reevaluation flag bumps `version` under CAS, so a stale loaded
//   version 409s instead of silently clearing the notice;
// - explicit human `reaffirm` keeps the status, clears the notice, and is
//   allowed only while the notice is set (CAS-checked, audited);
// - `learning.list` pushes the scope filter into SQL, so an older in-scope
//   row is never hidden behind 100 newer other-scope rows;
// - hypothesis evidence pages through a keyset cursor (hasMore/nextCursor)
//   past 100 rows.

import { randomUUID } from "node:crypto";
import type {
  ChatRequest,
  ChatResult,
  ModelGateway,
  NormalizedToolCall,
} from "@companion/model-local";
import { describe, expect, it } from "vitest";
import { AGENT_TOOL_ORIGIN, buildAgentToolDefinitions } from "../src/agent.js";
import {
  closeKernelDatabase,
  createAgentStrategy,
  createAutonomyReadRegistrations,
  createConversationProposalRegistrations,
  createKernelRepository,
  createLearningRegistrations,
  createToolBroker,
  freezeStrategyContext,
  type KernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
} from "../src/index.js";
import {
  LearningStateConflictError,
  LearningVersionConflictError,
} from "../src/learning.js";

const T0 = 1_700_009_000_000;
const MODEL_CTX = { origin: AGENT_TOOL_ORIGIN, caller: "test-agent" };

async function makeRepo() {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  const repo = createKernelRepository(handle.raw);
  const session = repo.createSession({ key: randomUUID(), now: T0 });
  return {
    handle,
    repo,
    sessionId: session.body.sessionId as string,
  };
}

function newRunningRun(
  repo: KernelRepository,
  sessionId: string,
  text: string,
  now: number,
): string {
  const posted = repo.postMessage(
    sessionId,
    { text },
    { key: randomUUID(), now },
  );
  const runId = (posted.body as { run: { id: string } }).run.id;
  repo.startRun(runId, { now: now + 1 });
  return runId;
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

function toolCall(name: string, args: unknown, id: string): NormalizedToolCall {
  return { id, name, arguments: args };
}

function scriptGateway(script: ChatResult[]): ModelGateway {
  let n = 0;
  return {
    provider: "ollama",
    capabilities: { toolCalling: true },
    baseUrl: "http://127.0.0.1:11434",
    chatUrl: "http://127.0.0.1:11434/api/chat",
    chat: async (request: ChatRequest): Promise<ChatResult> => {
      void request;
      const next = script[Math.min(n, script.length - 1)] as ChatResult;
      n += 1;
      return next;
    },
  };
}

describe("learning review fixes", () => {
  it("advertises learning.list/open/propose with closed schemas (never skipped)", async () => {
    const { handle, repo } = await makeRepo();
    try {
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [
          ...createAutonomyReadRegistrations({ repo }),
          ...createConversationProposalRegistrations({ repo }),
          ...createLearningRegistrations({ repo }),
        ],
      });
      const advertised = buildAgentToolDefinitions(broker.describeTools());
      const names = advertised.map((tool) => tool.name);
      expect(names).toContain("learning.list");
      expect(names).toContain("learning.open");
      expect(names).toContain("learning.propose");
      expect(names[names.length - 1]).toBe("answer.submit");
      for (const tool of advertised) {
        if (tool.name === "answer.submit") continue;
        expect(tool.parameters).toMatchObject({
          type: "object",
          additionalProperties: false,
        });
      }
      const propose = advertised.find(
        (tool) => tool.name === "learning.propose",
      );
      expect(propose?.parameters).toMatchObject({
        type: "object",
        required: ["scope", "kind", "statement"],
        additionalProperties: false,
      });
      const open = advertised.find((tool) => tool.name === "learning.open");
      expect(open?.parameters).toMatchObject({
        type: "object",
        required: ["hypothesisId"],
        additionalProperties: false,
      });
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("real agent native learning.propose stages one pending hypothesis; human accept adopts it", async () => {
    const handle = openKernelDatabase(":memory:");
    try {
      await migrateKernelDatabase({ db: handle.raw });
      const repo: KernelRepository = createKernelRepository(handle.raw);
      const sessionId = repo.createSession({ key: randomUUID(), now: T0 }).body
        .sessionId as string;
      const posted = repo.postMessage(
        sessionId,
        { text: "morning pages help me think clearly" },
        { key: randomUUID(), now: T0 + 1 },
      );
      const postedBody = posted.body as { run: { id: string } };
      repo.startRun(postedBody.run.id, { now: T0 + 2 });

      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [...createLearningRegistrations({ repo })],
      });
      const gateway = scriptGateway([
        {
          text: "",
          toolCalls: [
            toolCall(
              "learning.propose",
              {
                scope: "health",
                kind: "method",
                statement: "morning pages help",
              },
              "call-learning-propose-1",
            ),
          ],
          stopReason: "tool_calls",
        },
        {
          text: "",
          toolCalls: [
            toolCall(
              "answer.submit",
              { version: 1, parts: [{ text: "noted", citations: [] }] },
              "answer-1",
            ),
          ],
          stopReason: "tool_calls",
        },
      ]);
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway,
        model: "synthetic",
      });
      const run = repo.getRun(postedBody.run.id);
      const turn = repo.getTurn(run.turnId);
      const result = await strategy(
        freezeStrategyContext(
          {
            id: run.id,
            turnId: run.turnId,
            sessionId: run.sessionId,
            attempt: run.attempt,
            strategy: run.strategy,
          },
          {
            id: turn.id,
            sessionId: turn.sessionId,
            seq: turn.seq,
            input: turn.input,
            frozenContext: turn.frozenContext,
          },
          new AbortController().signal,
        ),
      );
      expect(result.text).toBe("noted");
      const listed = repo.listLearningHypotheses(sessionId, { limit: 50 });
      expect(listed.items).toHaveLength(1);
      const staged = listed.items[0] as {
        id: string;
        status: string;
        version: number;
        staged: boolean;
        origin: string;
        scope: string;
        kind: string;
      };
      expect(staged.status).toBe("open");
      expect(staged.staged).toBe(true);
      expect(staged.origin).toBe("model");
      expect(staged.scope).toBe("health");
      expect(staged.kind).toBe("method");
      expect(
        repo.listAutonomyPurposes(sessionId, { limit: 50 }).items,
      ).toHaveLength(0);
      // Explicit HUMAN accept adopts exactly the staged record.
      const accepted = repo.acceptLearningHypothesis(
        sessionId,
        staged.id,
        { expectedVersion: staged.version },
        { key: randomUUID(), now: T0 + 100 },
      );
      expect(accepted.status).toBe(200);
      expect(accepted.body.staged).toBe(false);
      expect(accepted.body.status).toBe("open");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("scope-changing correction flags the OLD scope (and the new one)", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const purpose = makePurpose(repo, sessionId, T0 + 10);
      const oldScoped = repo.createLearningHypothesis(
        sessionId,
        { scope: "health", kind: "method", statement: "old scope method" },
        { key: randomUUID(), now: T0 + 11 },
      );
      const newScoped = repo.createLearningHypothesis(
        sessionId,
        { scope: "work", kind: "method", statement: "new scope method" },
        { key: randomUUID(), now: T0 + 12 },
      );
      repo.correctAutonomyPurpose(
        sessionId,
        {
          scope: "work",
          statement: "walk daily v2",
          kind: "goal",
          explicit: true,
          sourceKind: "user",
          purposeId: purpose.body.id,
          expectedVersion: 1,
        },
        { key: randomUUID(), now: T0 + 13 },
      );
      expect(
        repo.getLearningHypothesis(sessionId, oldScoped.body.id)
          .needsReevaluation,
      ).toBe(true);
      expect(
        repo.getLearningHypothesis(sessionId, newScoped.body.id)
          .needsReevaluation,
      ).toBe(true);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("stale loaded version 409s after a revocation flag instead of clearing it", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const purpose = makePurpose(repo, sessionId, T0 + 10);
      const hyp = repo.createLearningHypothesis(
        sessionId,
        { scope: "health", kind: "hypothesis", statement: "stale guard" },
        { key: randomUUID(), now: T0 + 11 },
      );
      const supported = repo.transitionLearningHypothesis(
        sessionId,
        hyp.body.id,
        { expectedVersion: 1, transition: "support" },
        { key: randomUUID(), now: T0 + 12 },
      );
      expect(supported.body.version).toBe(2);
      const loadedV2 = repo.getLearningHypothesis(sessionId, hyp.body.id);
      expect(loadedV2.version).toBe(2);
      expect(loadedV2.needsReevaluation).toBe(false);
      repo.revokeAutonomyPurpose(
        sessionId,
        purpose.body.id,
        { expectedVersion: 1 },
        { key: randomUUID(), now: T0 + 13 },
      );
      const flagged = repo.getLearningHypothesis(sessionId, hyp.body.id);
      expect(flagged.version).toBe(3);
      expect(flagged.needsReevaluation).toBe(true);
      // The stale loaded v2 can no longer transition: 409, notice intact.
      expect(() =>
        repo.transitionLearningHypothesis(
          sessionId,
          hyp.body.id,
          { expectedVersion: 2, transition: "retire" },
          { key: randomUUID(), now: T0 + 14 },
        ),
      ).toThrow(LearningVersionConflictError);
      expect(
        repo.getLearningHypothesis(sessionId, hyp.body.id).needsReevaluation,
      ).toBe(true);
      // The fresh version still transitions and clears the notice.
      const retired = repo.transitionLearningHypothesis(
        sessionId,
        hyp.body.id,
        { expectedVersion: 3, transition: "retire" },
        { key: randomUUID(), now: T0 + 15 },
      );
      expect(retired.body.status).toBe("retired");
      expect(retired.body.needsReevaluation).toBe(false);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("reaffirm keeps status, clears the notice, and requires the notice", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const purpose = makePurpose(repo, sessionId, T0 + 10);
      const hyp = repo.createLearningHypothesis(
        sessionId,
        { scope: "health", kind: "method", statement: "steady method" },
        { key: randomUUID(), now: T0 + 11 },
      );
      // No notice yet: reaffirm is rejected, nothing mutates.
      expect(() =>
        repo.transitionLearningHypothesis(
          sessionId,
          hyp.body.id,
          { expectedVersion: 1, transition: "reaffirm" },
          { key: randomUUID(), now: T0 + 12 },
        ),
      ).toThrow(LearningStateConflictError);
      expect(repo.getLearningHypothesis(sessionId, hyp.body.id).version).toBe(
        1,
      );
      const supported = repo.transitionLearningHypothesis(
        sessionId,
        hyp.body.id,
        { expectedVersion: 1, transition: "support" },
        { key: randomUUID(), now: T0 + 13 },
      );
      expect(supported.body.version).toBe(2);
      repo.revokeAutonomyPurpose(
        sessionId,
        purpose.body.id,
        { expectedVersion: 1 },
        { key: randomUUID(), now: T0 + 14 },
      );
      const flagged = repo.getLearningHypothesis(sessionId, hyp.body.id);
      expect(flagged.needsReevaluation).toBe(true);
      // Stale CAS still guards the reaffirm.
      expect(() =>
        repo.transitionLearningHypothesis(
          sessionId,
          hyp.body.id,
          { expectedVersion: 2, transition: "reaffirm" },
          { key: randomUUID(), now: T0 + 15 },
        ),
      ).toThrow(LearningVersionConflictError);
      const reaffirmed = repo.transitionLearningHypothesis(
        sessionId,
        hyp.body.id,
        { expectedVersion: flagged.version, transition: "reaffirm" },
        { key: randomUUID(), now: T0 + 16 },
      );
      expect(reaffirmed.body.status).toBe("supported");
      expect(reaffirmed.body.needsReevaluation).toBe(false);
      const events = repo.listLearningHypothesisEvents(sessionId, hyp.body.id);
      expect(events.events.some((event) => event.event === "reaffirmed")).toBe(
        true,
      );
      // The notice is gone: a second reaffirm is rejected.
      expect(() =>
        repo.transitionLearningHypothesis(
          sessionId,
          hyp.body.id,
          {
            expectedVersion: reaffirmed.body.version,
            transition: "reaffirm",
          },
          { key: randomUUID(), now: T0 + 17 },
        ),
      ).toThrow(LearningStateConflictError);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("learning.list scope filter reaches older rows past 100 newer other-scope rows", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [...createLearningRegistrations({ repo })],
      });
      for (let n = 0; n < 3; n += 1) {
        repo.createLearningHypothesis(
          sessionId,
          { scope: "target", kind: "method", statement: `older target ${n}` },
          { key: randomUUID(), now: T0 + 10 + n },
        );
      }
      for (let n = 0; n < 105; n += 1) {
        repo.createLearningHypothesis(
          sessionId,
          { scope: "noise", kind: "method", statement: `newer noise ${n}` },
          { key: randomUUID(), now: T0 + 1_000 + n },
        );
      }
      const runId = newRunningRun(repo, sessionId, "list scoped", T0 + 9_000);
      const scoped = await broker.invoke(
        runId,
        "learning.list",
        { scope: "target", limit: 20 },
        MODEL_CTX,
      );
      expect(scoped.result.actualOutcome).toBe("succeeded");
      const body = scoped.modelFacing as {
        items: { scope: string }[];
        hasMore: boolean;
      };
      expect(body.items).toHaveLength(3);
      for (const item of body.items) {
        expect(item.scope).toBe("target");
      }
      expect(body.hasMore).toBe(false);
      // A full scope still reports a truthful older page behind LIMIT+1.
      for (let n = 0; n < 25; n += 1) {
        repo.createLearningHypothesis(
          sessionId,
          { scope: "full", kind: "method", statement: `full scope ${n}` },
          { key: randomUUID(), now: T0 + 20_000 + n },
        );
      }
      const full = await broker.invoke(
        runId,
        "learning.list",
        { scope: "full", limit: 20 },
        MODEL_CTX,
      );
      expect(full.result.actualOutcome).toBe("succeeded");
      const fullBody = full.modelFacing as {
        items: unknown[];
        hasMore: boolean;
      };
      expect(fullBody.items).toHaveLength(20);
      expect(fullBody.hasMore).toBe(true);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("evidence pages past 100 rows with a keyset cursor (oldest-first, never truncated)", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const hyp = repo.createLearningHypothesis(
        sessionId,
        { scope: "health", kind: "hypothesis", statement: "paged evidence" },
        { key: randomUUID(), now: T0 + 10 },
      );
      const task = makeTask(
        repo,
        sessionId,
        T0 + 11,
        makePurpose(repo, sessionId, T0 + 12).body.id,
      );
      const sourceId = taskEventId(handle, task.body.id);
      for (let n = 0; n < 105; n += 1) {
        const attached = repo.attachLearningEvidence(
          sessionId,
          hyp.body.id,
          { polarity: "neutral", sourceKind: "task_event", sourceId },
          { key: randomUUID(), now: T0 + 100 + n },
        );
        expect(attached.status).toBe(201);
      }
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      for (;;) {
        const page = repo.listLearningHypothesisEvidence(
          sessionId,
          hyp.body.id,
          {
            ...(cursor !== undefined ? { cursor } : {}),
          },
        );
        expect(page.hypothesisId).toBe(hyp.body.id);
        for (const item of page.items) {
          seen.push(item.id);
        }
        pages += 1;
        if (!page.hasMore) {
          expect(page.nextCursor).toBeNull();
          break;
        }
        expect(typeof page.nextCursor).toBe("string");
        cursor = page.nextCursor as string;
        if (pages > 10) throw new Error("evidence paging did not terminate");
      }
      expect(seen).toHaveLength(105);
      expect(new Set(seen).size).toBe(105);
      expect(pages).toBe(3);
      // Oldest-first across the page boundary: createdAt never goes back.
      const first = repo.listLearningHypothesisEvidence(
        sessionId,
        hyp.body.id,
        {
          limit: 50,
        },
      );
      expect(first.items).toHaveLength(50);
      expect(first.hasMore).toBe(true);
      const second = repo.listLearningHypothesisEvidence(
        sessionId,
        hyp.body.id,
        { limit: 50, cursor: first.nextCursor as string },
      );
      const boundary = (
        first.items[first.items.length - 1] as { createdAt: number }
      ).createdAt;
      const next = (second.items[0] as { createdAt: number }).createdAt;
      expect(next).toBeGreaterThanOrEqual(boundary);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
