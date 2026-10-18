// AV03 normal-agent synthetic-provider to human adoption (kernel proof).
//
// Drives the REAL normal agent strategy (`createAgentStrategy`) over a
// SYNTHETIC loopback ModelGateway (no model/Google/OAuth) whose first step
// returns a NATIVE `purpose.propose` tool call quoting the OWN chat text,
// then `answer.submit`. The REAL ToolBroker executes the proposal-only
// registration (server-derived source, exact quote): the server stores ONE
// pending draft and creates NO purpose/task/grant, never auto-accepts, and
// never resumes the stop control. The explicit HUMAN adoption
// (`acceptConversationProposal`) then completes exactly ONE SELF purpose.
// This is the model-side half of the browser adoption vertical.

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
  it("stages exactly one pending draft via native tool, human adopts ONE purpose", async () => {
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

      // Server stored ONE pending draft; nothing was auto-created and the
      // stop control was never resumed by the model path.
      const listed = repo.listConversationProposals(sessionId, { limit: 50 });
      expect(listed.items).toHaveLength(1);
      const draft = listed.items[0] as {
        id: string;
        status: string;
        version: number;
        sourceKind: string;
        sourceQuote: string;
        interpretation: string;
      };
      expect(draft.status).toBe("pending");
      expect(draft.sourceKind).toBe("model");
      expect(draft.sourceQuote).toBe("walk daily");
      expect(
        repo.listAutonomyPurposes(sessionId, { limit: 50 }).items,
      ).toHaveLength(0);
      expect(repo.getAutonomyControlState().paused).toBe(true);

      // Explicit HUMAN adoption completes exactly ONE SELF purpose.
      const adopted = repo.acceptConversationProposal(
        sessionId,
        draft.id,
        { expectedVersion: draft.version },
        { key: randomUUID(), now: T0 + 100 },
      );
      expect(adopted.status).toBe(201);
      const adoptedBody = adopted.body as {
        proposal: { status: string; acceptedTargetId: string };
        purpose: {
          id: string;
          statement: string;
          explicit: boolean;
          sourceKind: string;
        } | null;
        task: unknown;
      };
      expect(adoptedBody.proposal.status).toBe("accepted");
      expect(adoptedBody.purpose?.statement).toBe("walk daily");
      expect(adoptedBody.purpose?.explicit).toBe(false);
      expect(adoptedBody.purpose?.sourceKind).toBe("self");
      expect(adoptedBody.task).toBeNull();
      expect(adoptedBody.proposal.acceptedTargetId).toBe(
        adoptedBody.purpose?.id,
      );
      expect(
        repo.listAutonomyPurposes(sessionId, { limit: 50 }).items,
      ).toHaveLength(1);
      expect(AGENT_TOOL_ORIGIN).toBe("agent");
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
