// trial.propose: proposal-only trial staging from the chat model.
//
// Proves through the REAL kernel repository + migrator + ToolBroker
// (in-memory DB, no mocks):
// - staging succeeds ONLY under an explicit user goal, through the same
//   `repo.stageTrial` path the human HTTP route uses (DATA-only, no grant);
// - server-injected profile facts win: readOnlyMode is derived from the
//   operation, caps/checks come from the frozen profile, alias is frozen;
// - a self/external goal fails closed with a fixed model-facing code and
//   stages nothing;
// - a repeated call with the same callId replays the same proposal;
// - the tool is absent when the trial profile is disabled;
// - the system prompt carries the proposal guidance.

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AGENT_SYSTEM_PROMPT,
  AGENT_TOOL_ORIGIN,
  buildAgentToolDefinitions,
} from "../src/agent.js";
import {
  closeKernelDatabase,
  createAutonomyReadRegistrations,
  createConversationProposalRegistrations,
  createKernelRepository,
  createToolBroker,
  createTrialProposalRegistrations,
  type KernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
} from "../src/index.js";

const NOW = 1_750_000_000_000;
const MODEL_CTX = { origin: AGENT_TOOL_ORIGIN, caller: "test-agent" };
const PROFILE = {
  available: true,
  enabled: true,
  mandatoryChecks: ["lint"],
  configFingerprint: "b".repeat(64),
  sourceRevision: "a".repeat(40),
  currentModel: "test-model",
  disclosedWholeRepoRead: true,
  timeoutMs: 60_000,
  maxOutputBytes: 1_000_000,
};
const ALIAS = "ws";

async function makeRepo() {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  const repo = createKernelRepository(handle.raw);
  const session = repo.createSession({ key: randomUUID(), now: NOW });
  return { handle, repo, sessionId: session.body.sessionId as string };
}

function newRunningRun(
  repo: KernelRepository,
  sessionId: string,
  text: string,
): string {
  const posted = repo.postMessage(
    sessionId,
    { text },
    { key: randomUUID(), now: NOW },
  );
  const runId = (posted.body as { run: { id: string } }).run.id;
  repo.startRun(runId, { now: NOW + 1 });
  return runId;
}

function goalTask(
  repo: KernelRepository,
  sessionId: string,
  sourceKind: "user" | "self" | "external",
  explicit = true,
) {
  const g = repo.createAutonomyPurpose(
    sessionId,
    {
      scope: "s1",
      statement: "ship it",
      kind: "goal",
      explicit,
      sourceKind,
    },
    { key: randomUUID(), now: NOW + 2 },
  );
  const t = repo.createAutonomyTask(
    sessionId,
    {
      scope: "s1",
      title: "do work",
      kind: "task",
      speaker: "user",
      parentPurposeId: g.body.id,
    },
    { key: randomUUID(), now: NOW + 3 },
  );
  return { goal: g.body, task: t.body };
}

function setup(
  handle: ReturnType<typeof openKernelDatabase>,
  repo: KernelRepository,
  withTrials = true,
) {
  return createToolBroker({
    db: handle.raw,
    repo,
    registrations: [
      ...createAutonomyReadRegistrations({ repo }),
      ...createConversationProposalRegistrations({ repo }),
      ...(withTrials
        ? createTrialProposalRegistrations({
            repo,
            profile: PROFILE,
            workspaceAlias: ALIAS,
            now: () => NOW + 10,
          })
        : []),
    ],
  });
}

describe("trial.propose", () => {
  it("stages a DATA-only proposal under an explicit user goal", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const { task, goal } = goalTask(repo, sessionId, "user");
      const runId = newRunningRun(repo, sessionId, "please implement it");
      const broker = setup(handle, repo);
      const out = await broker.invoke(
        runId,
        "trial.propose",
        {
          taskId: task.id,
          objective: "implement the change",
          acceptance: ["tests pass"],
          literalPatchPaths: ["src/a.ts"],
          operation: "implement",
          expiryMinutes: 60,
        },
        MODEL_CTX,
      );
      expect(out.result.actualOutcome).toBe("succeeded");
      const staged = out.modelFacing as Record<string, unknown>;
      expect(staged.status).toBe("staged");
      expect(staged.taskId).toBe(task.id);
      expect(staged.goalId).toBe(goal.id);
      expect(staged.readOnlyMode).toBe(false);
      expect(staged.workspaceAlias).toBe(ALIAS);
      expect(staged.expiry).toBe(new Date(NOW + 60 * 60_000).toISOString());
      const view = repo.readTrial(sessionId, staged.proposalId as string);
      expect(view.status).toBe("staged");
      expect(view.requiredChecks).toEqual(["lint"]);
      expect(view.timeoutMs).toBe(PROFILE.timeoutMs);
      expect(view.maxOutputBytes).toBe(PROFILE.maxOutputBytes);
      expect(view.workspaceAlias).toBe(ALIAS);
      // No authority was granted by staging.
      expect(repo.listTrials(sessionId).items).toHaveLength(1);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("derives readOnlyMode from the operation and ignores no model flag", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const { task } = goalTask(repo, sessionId, "user");
      const runId = newRunningRun(repo, sessionId, "please verify it");
      const broker = setup(handle, repo);
      const out = await broker.invoke(
        runId,
        "trial.propose",
        {
          taskId: task.id,
          objective: "verify the change",
          acceptance: ["checked"],
          literalPatchPaths: ["src/a.ts"],
          operation: "verify",
          expiryMinutes: 10,
        },
        MODEL_CTX,
      );
      const staged = out.modelFacing as Record<string, unknown>;
      expect(staged.readOnlyMode).toBe(true);
      expect(staged.status).toBe("staged");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("fails closed under a self goal and returns a fixed code", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const { task } = goalTask(repo, sessionId, "self");
      const runId = newRunningRun(repo, sessionId, "please implement it");
      const broker = setup(handle, repo);
      const out = await broker.invoke(
        runId,
        "trial.propose",
        {
          taskId: task.id,
          objective: "implement the change",
          acceptance: ["tests pass"],
          literalPatchPaths: ["src/a.ts"],
          operation: "implement",
          expiryMinutes: 60,
        },
        MODEL_CTX,
      );
      expect(out.result.actualOutcome).toBe("succeeded");
      const staged = out.modelFacing as Record<string, unknown>;
      expect(staged.status).toBe("rejected");
      expect(staged.errorCode).toBe("requires_explicit_user_goal");
      expect(repo.listTrials(sessionId).items).toHaveLength(0);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("replays the same proposal for a repeated call", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      const { task } = goalTask(repo, sessionId, "user");
      const runId = newRunningRun(repo, sessionId, "please implement it");
      const broker = setup(handle, repo);
      const args = {
        taskId: task.id,
        objective: "implement the change",
        acceptance: ["tests pass"],
        literalPatchPaths: ["src/a.ts"],
        operation: "implement",
        expiryMinutes: 60,
      };
      const first = await broker.invoke(
        runId,
        "trial.propose",
        args,
        MODEL_CTX,
      );
      const second = await broker.invoke(
        runId,
        "trial.propose",
        args,
        MODEL_CTX,
      );
      expect((second.modelFacing as Record<string, unknown>).proposalId).toBe(
        (first.modelFacing as Record<string, unknown>).proposalId,
      );
      expect(repo.listTrials(sessionId).items).toHaveLength(1);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("is not registered or advertised when trials are disabled", async () => {
    const { handle, repo } = await makeRepo();
    try {
      const broker = setup(handle, repo, false);
      expect(broker.toolNames()).not.toContain("trial.propose");
      expect(
        buildAgentToolDefinitions(broker.describeTools()).map((t) => t.name),
      ).not.toContain("trial.propose");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("advertises a closed schema and carries proposal guidance in the prompt", async () => {
    const { handle, repo } = await makeRepo();
    try {
      const broker = setup(handle, repo);
      const tool = buildAgentToolDefinitions(broker.describeTools()).find(
        (t) => t.name === "trial.propose",
      );
      expect(tool).toBeDefined();
      expect(tool?.parameters).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
      expect(AGENT_SYSTEM_PROMPT).toContain("purpose.list");
      expect(AGENT_SYSTEM_PROMPT).toContain("task.propose");
      expect(AGENT_SYSTEM_PROMPT).toContain("trial.propose");
      expect(AGENT_SYSTEM_PROMPT).toContain("候補");
      expect(AGENT_SYSTEM_PROMPT).toContain("試行の提案");
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
