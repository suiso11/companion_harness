// M2 review commit 1: bound frozen-reference summary projection to the
// shared gateway per-message content limit; deterministic-clock repair events.
import { MAX_USER_TEXT_LENGTH } from "@companion/contracts";
import {
  type ChatRequest,
  type ChatResult,
  MAX_MESSAGE_CONTENT_LENGTH,
  type ModelGateway,
  type NormalizedToolCall,
} from "@companion/model-local";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AGENT_REPAIR_HINTS,
  closeKernelDatabase,
  createAgentStrategy,
  createKernelRepository,
  createToolBroker,
  formatReferenceOmittedMarker,
  freezeStrategyContext,
  type KernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
  projectPrompt,
  type ToolRegistration,
} from "../src/index.js";

const T0 = 1790000000000;

function toolCall(
  name: string,
  args: unknown = {},
  id?: string,
): NormalizedToolCall {
  return {
    id: id ?? `call-${name}-${Math.random().toString(36).slice(2)}`,
    name,
    arguments: args,
  };
}

function answerCall(
  parts = [{ text: "final", citations: [] as string[] }],
): NormalizedToolCall {
  return toolCall("answer.submit", { version: 1, parts }, "answer-1");
}

function chatResult(toolCalls: NormalizedToolCall[], text = ""): ChatResult {
  return {
    text,
    toolCalls,
    stopReason: toolCalls.length > 0 ? "tool_calls" : "stop",
  };
}

function scriptGateway(script: Array<ChatResult | Error>): {
  gateway: ModelGateway;
  calls: ChatRequest[];
} {
  const calls: ChatRequest[] = [];
  const gateway: ModelGateway = {
    provider: "ollama",
    capabilities: { toolCalling: true },
    baseUrl: "http://127.0.0.1:11434",
    chatUrl: "http://127.0.0.1:11434/api/chat",
    chat: async (request: ChatRequest): Promise<ChatResult> => {
      calls.push(request);
      const next = script[Math.min(calls.length - 1, script.length - 1)];
      if (next instanceof Error) throw next;
      return next as ChatResult;
    },
  };
  return { gateway, calls };
}

async function setup(): Promise<{
  handle: ReturnType<typeof openKernelDatabase>;
  repo: KernelRepository;
}> {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  return { handle, repo: createKernelRepository(handle.raw) };
}

function readReg(): ToolRegistration {
  return {
    descriptor: {
      name: "test.read",
      version: 1,
      title: "t",
      description: "d",
      category: "read",
      defaultTimeoutMs: 5000,
      maxTimeoutMs: 10_000,
      supportsRefresh: true,
    },
    inputSchema: z.strictObject({ q: z.string().default("hi") }),
    outputSchema: z.strictObject({ text: z.string() }),
    handler: async () => ({ text: "ok" }),
  };
}

function longestRepairHint(): string {
  return Object.values(AGENT_REPAIR_HINTS).reduce((a, b) =>
    a.length >= b.length ? a : b,
  );
}

describe("frozen-reference summary bound", () => {
  it("fits small reference sets without an omitted marker", () => {
    const req = projectPrompt({
      requestText: "q",
      history: [],
      references: [{ ordinal: 1, title: "T", canonicalKey: "k" }],
      tools: [],
      model: "m",
    });
    const current = req.messages[req.messages.length - 1] as {
      content: string;
    };
    expect(current.content.length).toBeLessThanOrEqual(
      MAX_MESSAGE_CONTENT_LENGTH,
    );
    expect(current.content).not.toContain("omitted to fit model message limit");
    expect(current.content).toContain("- r1: T [k]");
  });

  it("bounds many summaries under a maximum user request with deterministic omission", () => {
    const requestText = "u".repeat(MAX_USER_TEXT_LENGTH);
    const references = Array.from({ length: 1000 }, (_, i) => ({
      ordinal: i + 1,
      title: `Title ${i + 1} with padding text to grow each summary line`,
      canonicalKey: `vault/doc-${i + 1}.md`,
    }));
    const first = projectPrompt({
      requestText,
      history: [],
      references,
      tools: [],
      model: "m",
      repairHint: longestRepairHint(),
    });
    const second = projectPrompt({
      requestText,
      history: [],
      references,
      tools: [],
      model: "m",
      repairHint: longestRepairHint(),
    });
    // Deterministic: identical output for identical input.
    expect(second).toEqual(first);
    for (const message of first.messages) {
      expect(message.content.length).toBeLessThanOrEqual(
        MAX_MESSAGE_CONTENT_LENGTH,
      );
    }
    const current = first.messages[first.messages.length - 1] as {
      content: string;
    };
    // The user request itself is never truncated.
    expect(current.content).toContain(requestText);
    expect(current.content).toContain(longestRepairHint());
    // Earliest summaries win; excess is omitted with a fixed count marker.
    expect(current.content).toContain("- r1:");
    const markerMatch = current.content.match(
      /\.\.\. and (\d+) more omitted to fit model message limit\./,
    );
    expect(markerMatch).not.toBeNull();
    const omitted = Number((markerMatch as RegExpMatchArray)[1]);
    expect(omitted).toBeGreaterThan(0);
    expect(current.content).toContain(formatReferenceOmittedMarker(omitted));
    // Omitted tail summaries contribute no titles/keys as data lines.
    const lastOrdinal = references.length;
    expect(current.content).not.toContain(`- r${lastOrdinal}:`);
    expect(current.content).not.toContain(`vault/doc-${lastOrdinal}.md`);
    // Kept count + omitted count reconstructs the total deterministically.
    const keptLines = current.content
      .split("\n")
      .filter((line) => line.startsWith("- r"));
    expect(keptLines.length + omitted).toBe(references.length);
  });
});

describe("deterministic clock for invalid-answer repair events", () => {
  it("stamps model.step.failed repair events with the injected clock", async () => {
    const { handle, repo } = await setup();
    try {
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [readReg()],
      });
      const oversized = "x".repeat(4001);
      const { gateway } = scriptGateway([
        chatResult([
          toolCall(
            "answer.submit",
            { version: 1, parts: [{ text: oversized, citations: [] }] },
            "a1",
          ),
        ]),
        chatResult([answerCall([{ text: "ok", citations: [] }])]),
      ]);
      const fakeNow = T0 + 12345;
      const seen: number[] = [];
      const clock = {
        now: () => {
          seen.push(fakeNow);
          return fakeNow;
        },
      };
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway,
        model: "m",
        clock,
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
      const run = repo.getRun(runId);
      const turn = repo.getTurn(run.turnId);
      const ctx = freezeStrategyContext(
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
      );
      await expect(strategy(ctx)).resolves.toEqual({
        version: 2,
        text: "ok",
        answer: { version: 1, parts: [{ text: "ok", citations: [] }] },
      });
      expect(seen.length).toBeGreaterThan(0);
      const events = repo.getEvents(sessionId, runId, {}).events;
      const failed = events.filter((e) => e.type === "model.step.failed");
      expect(failed.length).toBeGreaterThanOrEqual(1);
      // Every repair-path failure carries the fake clock, never wall time.
      for (const event of failed) {
        expect(event.createdAt).toBe(fakeNow);
      }
      // No error/event payload leaks titles or keys (fixed codes only).
      const blob = JSON.stringify(failed);
      expect(blob).not.toContain("vault/");
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
