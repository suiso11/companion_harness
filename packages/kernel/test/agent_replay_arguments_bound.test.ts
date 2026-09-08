// AgentStrategy normal replay at the 32KiB bound (r3946625239).
//
// A valid exactly-32KiB ordinary tool-call arguments payload must survive
// the full normal replay path: first-step toolCalls validate, the broker
// executes within its own unchanged per-call budget (no double-count, no
// budget change here), and the second-step request replays the same
// assistant toolCalls and still satisfies `validateChatRequest` (the shared
// deterministic serialized UTF-8 bound). Oversize replay never reaches the
// broker.

import type {
  ChatRequest,
  ChatResult,
  ModelGateway,
  NormalizedToolCall,
} from "@companion/model-local";
import {
  canonicalToolArgumentsJson,
  MAX_TOOL_CALL_ARGUMENTS_BYTES,
  validateChatRequest,
} from "@companion/model-local";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  closeKernelDatabase,
  createAgentStrategy,
  createKernelRepository,
  createToolBroker,
  freezeStrategyContext,
  migrateKernelDatabase,
  openKernelDatabase,
} from "../src/index.js";

const T0 = 1790000000000;
const encoder = new TextEncoder();

const ASCII_PAD_AT_BOUND =
  MAX_TOOL_CALL_ARGUMENTS_BYTES - encoder.encode(`{"pad":""}`).byteLength;

function toolCall(name: string, args: unknown, id: string): NormalizedToolCall {
  return { id, name, arguments: args };
}

describe("agent normal replay at the 32KiB bound", () => {
  it("replays exact-bound ordinary args on the second step and completes", async () => {
    const args = { pad: "a".repeat(ASCII_PAD_AT_BOUND) };
    expect(encoder.encode(canonicalToolArgumentsJson(args)).byteLength).toBe(
      MAX_TOOL_CALL_ARGUMENTS_BYTES,
    );

    const handle = openKernelDatabase(":memory:");
    await migrateKernelDatabase({ db: handle.raw });
    try {
      const repo = createKernelRepository(handle.raw);
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [
          {
            descriptor: {
              name: "test.read",
              version: 1,
              title: "t",
              description: "d",
              category: "read",
              defaultTimeoutMs: 5000,
              maxTimeoutMs: 10000,
              supportsRefresh: true,
            },
            inputSchema: z.strictObject({ pad: z.string() }),
            outputSchema: z.strictObject({ text: z.string() }),
            handler: async () => ({ text: "ok" }),
          },
        ],
      });
      const sessionId = repo.createSession({
        key: crypto.randomUUID(),
        now: T0,
      }).body.sessionId;
      const posted = repo.postMessage(
        sessionId,
        { text: "q" },
        { key: crypto.randomUUID(), now: T0 },
      );
      const runId = posted.body.run.id;
      repo.startRun(runId, { now: T0 + 1 });

      const calls: ChatRequest[] = [];
      const answerArgs = {
        version: 1,
        parts: [{ text: "done", citations: [] }],
      };
      let step = 0;
      const gateway: ModelGateway = {
        provider: "ollama",
        capabilities: { toolCalling: true },
        baseUrl: "http://127.0.0.1:11434",
        chatUrl: "http://127.0.0.1:11434/api/chat",
        chat: async (request: ChatRequest): Promise<ChatResult> => {
          // Every strategy request — including the replay — must satisfy
          // the shared history validation bound.
          validateChatRequest(request);
          calls.push(request);
          step += 1;
          if (step === 1) {
            return {
              text: "",
              toolCalls: [toolCall("test.read", args, "c0")],
              stopReason: "tool_calls",
            };
          }
          return {
            text: "",
            toolCalls: [toolCall("answer.submit", answerArgs, "answer-1")],
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
      const run = repo.getRun(runId);
      const turn = repo.getTurn(run.turnId);
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
      expect(calls.length).toBeGreaterThanOrEqual(2);
      const replayed = calls[1]?.messages.find(
        (m) =>
          m.role === "assistant" &&
          Array.isArray(m.toolCalls) &&
          m.toolCalls.length === 1,
      );
      expect(replayed?.toolCalls?.[0]?.id).toBe("c0");
      expect(
        encoder.encode(
          canonicalToolArgumentsJson(replayed?.toolCalls?.[0]?.arguments),
        ).byteLength,
      ).toBe(MAX_TOOL_CALL_ARGUMENTS_BYTES);
      // Second-step replay still validates (valid 32KiB remains accepted).
      expect(() => validateChatRequest(calls[1] as ChatRequest)).not.toThrow();
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
