// M2 history message bounds (r3943583872): every projected
// selected-completed history message must satisfy 1..MAX after framing;
// over/under-bound pairs are omitted whole (no truncation, no half-pairs).

import type {
  ChatRequest,
  ChatResult,
  ModelGateway,
} from "@companion/model-local";
import {
  MAX_MESSAGE_CONTENT_LENGTH,
  validateChatRequest,
} from "@companion/model-local";
import { describe, expect, it } from "vitest";
import {
  AGENT_HISTORY_USER_PREFIX,
  AGENT_MAX_HISTORY_ITEMS,
  closeKernelDatabase,
  createAgentStrategy,
  createKernelRepository,
  createToolBroker,
  isProjectableHistoryItem,
  migrateKernelDatabase,
  openKernelDatabase,
  projectPrompt,
} from "../src/index.js";

function historyMessages(req: ChatRequest) {
  // Exclude fixed system (index 0) and current-user (last) messages.
  return req.messages.slice(1, -1);
}

describe("history message bounds", () => {
  it("omits empty request/result pairs whole (no half-pairs, no truncation)", () => {
    const req = projectPrompt({
      requestText: "now",
      history: [
        { turnSeq: 1, requestText: "", resultText: "ok" },
        { turnSeq: 2, requestText: "q", resultText: "" },
        { turnSeq: 3, requestText: "keep-q", resultText: "keep-r" },
      ],
      references: [],
      tools: [],
      model: "m",
    });
    expect(
      isProjectableHistoryItem({ requestText: "", resultText: "ok" }),
    ).toBe(false);
    expect(isProjectableHistoryItem({ requestText: "q", resultText: "" })).toBe(
      false,
    );
    const hist = historyMessages(req);
    expect(hist).toHaveLength(2);
    expect(hist[0]).toMatchObject({
      role: "user",
      content: `${AGENT_HISTORY_USER_PREFIX}keep-q`,
    });
    expect(hist[1]).toMatchObject({ role: "assistant", content: "keep-r" });
    // No truncated residue of the omitted pair.
    const blob = hist.map((m) => m.content).join("\n");
    expect(blob).not.toContain("ok\n");
    expect(() => validateChatRequest(req)).not.toThrow();
  });

  it("keeps exact-max framed user and assistant messages", () => {
    const requestText = "x".repeat(
      MAX_MESSAGE_CONTENT_LENGTH - AGENT_HISTORY_USER_PREFIX.length,
    );
    const resultText = "y".repeat(MAX_MESSAGE_CONTENT_LENGTH);
    expect(`${AGENT_HISTORY_USER_PREFIX}${requestText}`.length).toBe(
      MAX_MESSAGE_CONTENT_LENGTH,
    );
    expect(resultText.length).toBe(MAX_MESSAGE_CONTENT_LENGTH);
    expect(isProjectableHistoryItem({ requestText, resultText })).toBe(true);
    const req = projectPrompt({
      requestText: "now",
      history: [{ turnSeq: 1, requestText, resultText }],
      references: [],
      tools: [],
      model: "m",
    });
    const hist = historyMessages(req);
    expect(hist).toHaveLength(2);
    expect(hist[0]?.content.length).toBe(MAX_MESSAGE_CONTENT_LENGTH);
    expect(hist[1]?.content.length).toBe(MAX_MESSAGE_CONTENT_LENGTH);
    // Verbatim: no truncation of stored text.
    expect(hist[0]?.content).toBe(`${AGENT_HISTORY_USER_PREFIX}${requestText}`);
    expect(hist[1]?.content).toBe(resultText);
    expect(() => validateChatRequest(req)).not.toThrow();
  });

  it("omits whole pairs on one-char framing overhead (no half-pairs)", () => {
    const overRequest = "x".repeat(
      MAX_MESSAGE_CONTENT_LENGTH - AGENT_HISTORY_USER_PREFIX.length + 1,
    );
    expect(`${AGENT_HISTORY_USER_PREFIX}${overRequest}`.length).toBe(
      MAX_MESSAGE_CONTENT_LENGTH + 1,
    );
    expect(
      isProjectableHistoryItem({ requestText: overRequest, resultText: "ok" }),
    ).toBe(false);
    const overResult = "y".repeat(MAX_MESSAGE_CONTENT_LENGTH + 1);
    expect(
      isProjectableHistoryItem({ requestText: "q", resultText: overResult }),
    ).toBe(false);
    const req = projectPrompt({
      requestText: "now",
      history: [
        { turnSeq: 1, requestText: overRequest, resultText: "r1" },
        { turnSeq: 2, requestText: "q2", resultText: overResult },
        { turnSeq: 3, requestText: "keep", resultText: "kept" },
      ],
      references: [],
      tools: [],
      model: "m",
    });
    const hist = historyMessages(req);
    expect(hist).toHaveLength(2);
    expect(hist[0]?.content).toBe(`${AGENT_HISTORY_USER_PREFIX}keep`);
    expect(hist[1]?.content).toBe("kept");
    expect(() => validateChatRequest(req)).not.toThrow();
  });

  it("omits legacy over-bound stored turns whole (beyond current V1/V2 caps)", () => {
    // Legacy rows predate/dodge the 32_768 user / 65_536 assistant caps.
    const legacyRequest = "q".repeat(70_000);
    const legacyResult = "r".repeat(MAX_MESSAGE_CONTENT_LENGTH + 1);
    expect(
      isProjectableHistoryItem({
        requestText: legacyRequest,
        resultText: "ok",
      }),
    ).toBe(false);
    expect(
      isProjectableHistoryItem({ requestText: "q", resultText: legacyResult }),
    ).toBe(false);
    const req = projectPrompt({
      requestText: "now",
      history: [
        { turnSeq: 1, requestText: legacyRequest, resultText: "r1" },
        { turnSeq: 2, requestText: "q2", resultText: legacyResult },
        { turnSeq: 3, requestText: "keep", resultText: "kept" },
      ],
      references: [],
      tools: [],
      model: "m",
    });
    const hist = historyMessages(req);
    expect(hist).toHaveLength(2);
    expect(hist[0]?.content).toBe(`${AGENT_HISTORY_USER_PREFIX}keep`);
    const blob = req.messages.map((m) => m.content).join("\n");
    expect(blob).not.toContain(legacyRequest.slice(0, 16));
    expect(() => validateChatRequest(req)).not.toThrow();
  });

  it("preserves latest deterministic order and leaves current request untruncated", () => {
    const history = Array.from({ length: 10 }, (_, i) => ({
      turnSeq: i + 1,
      requestText: `q${i + 1}`,
      resultText: `r${i + 1}`,
    }));
    const current = "current-request-text";
    const req = projectPrompt({
      requestText: current,
      history,
      references: [],
      tools: [],
      model: "m",
    });
    const hist = historyMessages(req);
    expect(hist).toHaveLength(20);
    expect(hist[0]?.content).toBe(`${AGENT_HISTORY_USER_PREFIX}q1`);
    expect(hist[hist.length - 1]?.content).toBe("r10");
    const last = req.messages[req.messages.length - 1];
    expect(last?.role).toBe("user");
    expect(last?.content).toContain(current);
    expect(() => validateChatRequest(req)).not.toThrow();
    expect(AGENT_MAX_HISTORY_ITEMS).toBe(63);
  });

  it("projects normal V1 and V2 selected-completed histories end to end", async () => {
    const handle = openKernelDatabase(":memory:");
    await migrateKernelDatabase({ db: handle.raw });
    try {
      const repo = createKernelRepository(handle.raw);
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [],
      });
      const sessionId = repo.createSession({
        key: crypto.randomUUID(),
        now: 1790000000000,
      }).body.sessionId;
      // V1 completed turn.
      const v1 = repo.postMessage(
        sessionId,
        { text: "v1-q" },
        { key: crypto.randomUUID(), now: 1790000000001 },
      );
      repo.startRun(v1.body.run.id, { now: 1790000000002 });
      repo.completeRun(
        v1.body.run.id,
        { version: 1, text: "v1-r" },
        { now: 1790000000003 },
      );
      // V2 completed turn.
      const v2 = repo.postMessage(
        sessionId,
        { text: "v2-q" },
        { key: crypto.randomUUID(), now: 1790000000004 },
      );
      repo.startRun(v2.body.run.id, { now: 1790000000005 });
      repo.completeRun(
        v2.body.run.id,
        {
          version: 2,
          text: "v2-r",
          answer: { version: 1, parts: [{ text: "v2-r", citations: [] }] },
        },
        { now: 1790000000006 },
      );
      const posted = repo.postMessage(
        sessionId,
        { text: "current" },
        { key: crypto.randomUUID(), now: 1790000000007 },
      );
      repo.startRun(posted.body.run.id, { now: 1790000000008 });
      const calls: ChatRequest[] = [];
      const gateway: ModelGateway = {
        provider: "ollama",
        capabilities: { toolCalling: true },
        baseUrl: "http://127.0.0.1:11434",
        chatUrl: "http://127.0.0.1:11434/api/chat",
        chat: async (request: ChatRequest): Promise<ChatResult> => {
          calls.push(request);
          // Validate the exact wire request the strategy sends.
          validateChatRequest(request);
          return {
            text: "",
            toolCalls: [
              {
                id: "answer-1",
                name: "answer.submit",
                arguments: {
                  version: 1,
                  parts: [{ text: "done", citations: [] }],
                },
              },
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
        model: "m",
      });
      const run = repo.getRun(posted.body.run.id);
      const turn = repo.getTurn(run.turnId);
      const { freezeStrategyContext } = await import("../src/index.js");
      await strategy(
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
      const blob = (calls[0]?.messages ?? []).map((m) => m.content).join("\n");
      expect(blob).toContain("v1-q");
      expect(blob).toContain("v1-r");
      expect(blob).toContain("v2-q");
      expect(blob).toContain("v2-r");
      for (const m of historyMessages(calls[0] as ChatRequest)) {
        expect(m.content.length).toBeGreaterThanOrEqual(1);
        expect(m.content.length).toBeLessThanOrEqual(
          MAX_MESSAGE_CONTENT_LENGTH,
        );
      }
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
