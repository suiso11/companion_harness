// AV03 normal-agent synthetic-provider to human adoption (kernel proof).
//
// Drives the REAL normal agent strategy (`createAgentStrategy`) over a
// SYNTHETIC loopback ModelGateway (no model/Google/OAuth) whose first step
// returns a NATIVE `purpose.propose` tool call quoting the OWN chat text,
// then `answer.submit`. The REAL ToolBroker executes the proposal-only
// registration (server-derived source, exact quote): the server creates
// exactly ONE SELF purpose immediately (the trial approval is the single
// human gate), creates no grant, and never resumes the stop control.

import { randomUUID } from "node:crypto";
import type {
  ChatRequest,
  ChatResult,
  ModelGateway,
  NormalizedToolCall,
} from "@companion/model-local";
import { describe, expect, it } from "vitest";
import { AGENT_TOOL_ORIGIN } from "../src/agent.js";
import {
  closeKernelDatabase,
  createAgentStrategy,
  createAutonomyReadRegistrations,
  createConversationProposalRegistrations,
  createKernelRepository,
  createToolBroker,
  freezeStrategyContext,
  type KernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
} from "../src/index.js";

const T0 = 1_769_000_100_000;

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

describe("normal-agent propose to human adoption", () => {
  it("creates exactly one self goal via the native tool", async () => {
    const handle = openKernelDatabase(":memory:");
    try {
      await migrateKernelDatabase({ db: handle.raw });
      const repo: KernelRepository = createKernelRepository(handle.raw);
      const sessionId = repo.createSession({ key: randomUUID(), now: T0 }).body
        .sessionId as string;
      const posted = repo.postMessage(
        sessionId,
        { text: "i want to walk daily after dinner" },
        { key: randomUUID(), now: T0 + 1 },
      );
      const postedBody = posted.body as { run: { id: string } };
      repo.startRun(postedBody.run.id, { now: T0 + 2 });

      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [
          ...createAutonomyReadRegistrations({ repo }),
          ...createConversationProposalRegistrations({ repo }),
        ],
      });
      // Synthetic provider: native propose call quoting OWN chat, then done.
      const gateway = scriptGateway([
        {
          text: "",
          toolCalls: [
            toolCall(
              "purpose.propose",
              {
                scope: "health",
                draftKind: "wish",
                purposeKind: "goal",
                sourceQuote: "walk daily",
                interpretation: "wants a daily walk habit",
              },
              "call-propose-1",
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

      // The tool records the goal immediately: ONE self purpose, no grant,
      // and the stop control was never resumed by the model path.
      const listed = repo.listConversationProposals(sessionId, { limit: 50 });
      expect(listed.items).toHaveLength(1);
      const draft = listed.items[0];
      if (draft === undefined) {
        throw new Error("expected one stored proposal");
      }
      expect(draft.status).toBe("accepted");
      expect(draft.sourceKind).toBe("model");
      expect(draft.sourceQuote).toBe("walk daily");
      const purposes = repo.listAutonomyPurposes(sessionId, { limit: 50 });
      expect(purposes.items).toHaveLength(1);
      const goal = purposes.items[0];
      if (goal === undefined) {
        throw new Error("expected one created goal");
      }
      expect(goal.statement).toBe("walk daily");
      expect(goal.explicit).toBe(false);
      expect(goal.sourceKind).toBe("self");
      expect(draft.acceptedTargetId).toBe(goal.id);
      expect(repo.getAutonomyControlState().paused).toBe(true);
      expect(AGENT_TOOL_ORIGIN).toBe("agent");
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
