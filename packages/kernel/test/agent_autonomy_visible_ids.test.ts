// Model-visible autonomy handles: the normal agent must see its OWN
// session-scoped purpose/task/proposal ids (they are inputs to purpose.open /
// task.propose / trial.propose) while every other structural UUID stays on
// the rN / `[redacted]` path. Proves:
// - the per-tool-family allowlist keeps only the matching family's keys and
//   other tools still redact them;
// - purpose.list -> purpose.open round-trips the real purposeId through the
//   REAL agent strategy and ToolBroker feedback (no [redacted]).
import { randomUUID } from "node:crypto";
import type {
  ChatRequest,
  ChatResult,
  ModelGateway,
  NormalizedToolCall,
} from "@companion/model-local";
import { describe, expect, it } from "vitest";
import {
  AGENT_PURPOSE_OPEN_PARAMETERS,
  AGENT_TASK_PROPOSE_PARAMETERS,
  AGENT_TRIAL_PROPOSE_PARAMETERS,
  AGENT_UUID_PATTERN,
} from "../src/agent.js";
import {
  AGENT_SYSTEM_PROMPT,
  closeKernelDatabase,
  createAgentStrategy,
  createAutonomyReadRegistrations,
  createKernelRepository,
  createToolBroker,
  freezeStrategyContext,
  type KernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
  sanitizeModelFacingForFeedback,
  visibleUuidKeysForTool,
} from "../src/index.js";

const T0 = 1_769_000_200_000;
const PURPOSE_ID = "11111111-1111-4111-8111-111111111111";
const TASK_ID = "22222222-2222-4222-8222-222222222222";
const PARENT_ID = "33333333-3333-4333-8333-333333333333";
const PROPOSAL_ID = "44444444-4444-4444-8444-444444444444";
const TURN_ID = "55555555-5555-4555-8555-555555555555";
const GOAL_ID = "66666666-6666-4666-8666-666666666666";
const OTHER_ID = "77777777-7777-4777-8777-777777777777";

const EMPTY_MAP = new Map<string, number>();

function sanitize(toolName: string, payload: unknown) {
  return sanitizeModelFacingForFeedback(
    payload,
    EMPTY_MAP,
    visibleUuidKeysForTool(toolName),
  ) as Record<string, unknown>;
}

interface AgentSetup {
  handle: ReturnType<typeof openKernelDatabase>;
  repo: KernelRepository;
  sessionId: string;
  purposeId: string;
  runId: string;
}

async function agentSetup(): Promise<AgentSetup> {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  const repo = createKernelRepository(handle.raw);
  const sessionId = repo.createSession({ key: randomUUID(), now: T0 }).body
    .sessionId as string;
  const purposeId = repo.createAutonomyPurpose(
    sessionId,
    {
      scope: "health",
      statement: "walk every morning",
      kind: "goal",
      explicit: true,
      sourceKind: "user",
    },
    { key: randomUUID(), now: T0 + 1 },
  ).body.id as string;
  const posted = repo.postMessage(
    sessionId,
    { text: "open my goal and keep it" },
    { key: randomUUID(), now: T0 + 2 },
  );
  const runId = (posted.body as { run: { id: string } }).run.id;
  repo.startRun(runId, { now: T0 + 3 });
  return { handle, repo, sessionId, purposeId, runId };
}

function toolCall(name: string, args: unknown, id: string): NormalizedToolCall {
  return { id, name, arguments: args };
}

describe("autonomy handles visible to the model", () => {
  it("keeps only the matching tool family's UUID keys", () => {
    const payload = {
      purposeId: PURPOSE_ID,
      taskId: TASK_ID,
      parentPurposeId: PARENT_ID,
      proposalId: PROPOSAL_ID,
      sourceTurnId: TURN_ID,
      goalId: GOAL_ID,
      otherId: OTHER_ID,
    };

    const fromPurpose = sanitize("purpose.open", payload);
    expect(fromPurpose.purposeId).toBe(PURPOSE_ID);
    expect(fromPurpose.proposalId).toBe(PROPOSAL_ID);
    expect(fromPurpose.taskId).toBe("[redacted]");
    expect(fromPurpose.parentPurposeId).toBe("[redacted]");
    expect(fromPurpose.sourceTurnId).toBe("[redacted]");
    expect(fromPurpose.goalId).toBe("[redacted]");

    const fromTask = sanitize("task.open", payload);
    expect(fromTask.taskId).toBe(TASK_ID);
    expect(fromTask.parentPurposeId).toBe(PARENT_ID);
    expect(fromTask.proposalId).toBe(PROPOSAL_ID);
    expect(fromTask.purposeId).toBe("[redacted]");

    const fromTrial = sanitize("trial.propose", payload);
    expect(fromTrial.proposalId).toBe(PROPOSAL_ID);
    expect(fromTrial.taskId).toBe(TASK_ID);
    expect(fromTrial.goalId).toBe("[redacted]");

    const fromAgora = sanitize("agora.propose", payload);
    expect(fromAgora.proposalId).toBe(PROPOSAL_ID);
    expect(fromAgora.purposeId).toBe("[redacted]");

    // Any other tool family still redacts every structural UUID.
    const fromOther = sanitize("markdown.search", payload);
    for (const key of Object.keys(payload)) {
      expect(fromOther[key]).toBe("[redacted]");
    }
  });

  it("advertised inputs take the raw UUID the model now sees", () => {
    // No rN mapping on input: these proposal/open tools accept the actual
    // session-scoped UUID, and ownership/scope/CAS are re-checked server-side.
    const schemaId = (parameters: Record<string, unknown>, key: string) =>
      (parameters.properties as Record<string, { pattern?: string }>)[key]
        ?.pattern;
    expect(schemaId(AGENT_PURPOSE_OPEN_PARAMETERS, "purposeId")).toBe(
      AGENT_UUID_PATTERN,
    );
    expect(schemaId(AGENT_TASK_PROPOSE_PARAMETERS, "parentPurposeId")).toBe(
      AGENT_UUID_PATTERN,
    );
    expect(schemaId(AGENT_TRIAL_PROPOSE_PARAMETERS, "taskId")).toBe(
      AGENT_UUID_PATTERN,
    );
  });

  it("keeps the filtered-list feedback fields through the sanitizer", () => {
    const out = sanitize("purpose.list", {
      items: [],
      hasMore: false,
      appliedFilters: { scope: "personal", status: "active" },
      unfilteredTotal: 1,
      availableScopes: ["default", "health"],
    });
    expect(out).toEqual({
      items: [],
      hasMore: false,
      appliedFilters: { scope: "personal", status: "active" },
      unfilteredTotal: 1,
      availableScopes: ["default", "health"],
    });
    const taskOut = sanitize("task.list", {
      items: [],
      hasMore: false,
      appliedFilters: { scope: "personal", kind: "task" },
      unfilteredTotal: 2,
      availableScopes: ["default"],
    });
    expect(taskOut.unfilteredTotal).toBe(2);
    expect(taskOut.availableScopes).toEqual(["default"]);
    expect(taskOut.appliedFilters).toEqual({ scope: "personal", kind: "task" });
  });

  it("round-trips purpose.list -> purpose.open through real agent feedback", async () => {
    const setup = await agentSetup();
    try {
      const { handle, repo, sessionId, purposeId, runId } = setup;
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: createAutonomyReadRegistrations({ repo }),
      });
      const calls: ChatRequest[] = [];
      const gateway: ModelGateway = {
        provider: "openai-compatible",
        capabilities: { toolCalling: true },
        baseUrl: "http://127.0.0.1:11434",
        chatUrl: "http://127.0.0.1:11434/v1/chat/completions",
        chat: async (request: ChatRequest): Promise<ChatResult> => {
          calls.push(request);
          if (calls.length === 1) {
            return {
              text: "",
              toolCalls: [
                toolCall("purpose.list", { scope: "health" }, "call-list"),
              ],
              stopReason: "tool_calls",
            };
          }
          if (calls.length === 2) {
            return {
              text: "",
              toolCalls: [toolCall("purpose.open", { purposeId }, "call-open")],
              stopReason: "tool_calls",
            };
          }
          return {
            text: "",
            toolCalls: [
              toolCall(
                "answer.submit",
                {
                  version: 1,
                  parts: [{ text: "opened my goal", citations: [] }],
                },
                "answer-1",
              ),
            ],
            stopReason: "tool_calls",
          };
        },
      };
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway,
        model: "synthetic",
      });
      const run = repo.getRun(runId);
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
      expect(result.text).toBe("opened my goal");
      expect(calls).toHaveLength(3);

      // Step 2 saw the REAL purposeId from purpose.list, never [redacted].
      const listFeedback = (calls[1]?.messages ?? [])
        .filter((message) => message.role === "tool")
        .map((message) => String(message.content))
        .join("\n");
      expect(listFeedback).toContain(purposeId);
      expect(listFeedback).not.toContain("[redacted]");
      expect(listFeedback).not.toContain('"purposeId":"withheld"');

      // Step 3 saw the purpose.open result for the same id (the call
      // succeeded with the raw UUID; no rN mapping on input).
      const openFeedback = (calls[2]?.messages ?? [])
        .filter((message) => message.role === "tool")
        .map((message) => String(message.content))
        .join("\n");
      expect(openFeedback).toContain("walk every morning");
      expect(openFeedback).toContain(purposeId);
      expect(openFeedback).not.toContain("execution_failed");

      // The model is told proposals are not citations.
      expect(AGENT_SYSTEM_PROMPT).toContain("Proposals are not citations");
      expect(AGENT_SYSTEM_PROMPT).toContain("rN/mN");
      void sessionId;
    } finally {
      closeKernelDatabase(setup.handle);
    }
  });
});
