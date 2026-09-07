// M2 conversation message cap: 128-message trimming across repeated
// multi-tool steps. Oldest selected-history pairs drop first, then oldest
// complete tool interaction groups (assistant toolCalls + contiguous
// role:tool responses + directly associated fixed repair hint). Never
// orphans tool_call_id correlations, preserves system + current request +
// latest interactions, adds no raw summary, keeps grants accurate.

import type {
  ChatMessage,
  ChatRequest,
  ChatResult,
  ModelGateway,
  NormalizedToolCall,
} from "@companion/model-local";
import { toOpenAIMessage, validateChatRequest } from "@companion/model-local";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AGENT_HISTORY_USER_PREFIX,
  AGENT_INVALID_TOOL_FEEDBACK_CONTENT,
  AGENT_REPAIR_HINTS,
  closeKernelDatabase,
  createAgentStrategy,
  createKernelRepository,
  createToolBroker,
  freezeStrategyContext,
  type KernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
  trimConversationToCap,
} from "../src/index.js";

const T0 = 1790000000000;

function ordinaryCalls(step: number, count: number): NormalizedToolCall[] {
  const calls: NormalizedToolCall[] = [];
  for (let i = 0; i < count; i += 1) {
    calls.push({
      id: `s${step}-c${i}`,
      name: "test.read",
      arguments: { q: `q-${step}-${i}` },
    });
  }
  return calls;
}

function answerCall(id = "answer-final"): NormalizedToolCall {
  return {
    id,
    name: "answer.submit",
    arguments: { version: 1, parts: [{ text: "done", citations: [] }] },
  };
}

function buildOverflowConversation(): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: "sys" }];
  // 60 history pairs = 120 messages (latest win, chronological).
  for (let i = 1; i <= 60; i += 1) {
    messages.push({
      role: "user",
      content: `${AGENT_HISTORY_USER_PREFIX}q${i}`,
    });
    messages.push({ role: "assistant", content: `r${i}` });
  }
  messages.push({ role: "user", content: "User request:\ncurrent" });
  // 8 tool steps x (1 assistant with 4 calls + 4 tools) = 32 calls, 40 msgs.
  for (let step = 1; step <= 8; step += 1) {
    const calls = ordinaryCalls(step, 4);
    messages.push({
      role: "assistant",
      content: "",
      toolCalls: calls.map((c) => ({ ...c })),
    });
    for (const call of calls) {
      messages.push({
        role: "tool",
        content: JSON.stringify({
          tool: call.name,
          ok: true,
          errorCode: null,
          output: { text: "ok" },
        }),
        toolCallId: call.id,
        toolName: call.name,
      });
    }
  }
  return messages;
}

/** Every assistant toolCall id has exactly one matching contiguous tool msg. */
function expectNoOrphans(messages: ChatMessage[]): void {
  const toolIds = new Map<string, number>();
  for (const m of messages) {
    if (m.role === "tool") {
      expect(typeof m.toolCallId).toBe("string");
      expect(typeof m.toolName).toBe("string");
      toolIds.set(
        m.toolCallId as string,
        (toolIds.get(m.toolCallId as string) ?? 0) + 1,
      );
    }
  }
  for (const count of toolIds.values()) {
    expect(count).toBe(1);
  }
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i] as ChatMessage;
    if (
      m.role === "assistant" &&
      Array.isArray(m.toolCalls) &&
      m.toolCalls.length > 0
    ) {
      const ids = (m.toolCalls as NormalizedToolCall[]).map((c) => c.id);
      expect(ids.length).toBeLessThanOrEqual(32);
      for (let k = 0; k < ids.length; k += 1) {
        const tool = messages[i + 1 + k];
        expect(tool?.role).toBe("tool");
        expect(tool?.toolCallId).toBe(ids[k]);
      }
      // No duplicate ids within one step.
      expect(new Set(ids).size).toBe(ids.length);
    }
  }
  // No raw summary of omitted tool data is ever added.
  const blob = messages.map((m) => m.content).join("\n");
  expect(blob).not.toContain("omitted tool");
}

function expectOpenAIWireValid(request: ChatRequest): void {
  validateChatRequest(request);
  for (const m of request.messages) {
    expect(() => toOpenAIMessage(m)).not.toThrow();
  }
}

describe("conversation 128-message cap", () => {
  it("trims oldest history first then oldest tool groups, keeps latest order", () => {
    const messages = buildOverflowConversation();
    expect(messages).toHaveLength(1 + 120 + 1 + 40); // 162
    trimConversationToCap(messages);
    expect(messages.length).toBeLessThanOrEqual(128);
    expectOpenAIWireValid({
      model: "m",
      messages: [...messages],
    });
    expectNoOrphans(messages);
    // System + current request preserved.
    expect(messages[0]?.role).toBe("system");
    const currentIdx = messages.findIndex(
      (m) => m.role === "user" && m.content.startsWith("User request:\n"),
    );
    expect(currentIdx).toBeGreaterThanOrEqual(0);
    expect(messages[currentIdx]?.content).toContain("current");
    // Latest tool groups retained in order: step 8 group must survive.
    const lastAssistantIdx = messages.reduce(
      (acc, m, i) =>
        m.role === "assistant" && Array.isArray(m.toolCalls) ? i : acc,
      -1,
    );
    expect(lastAssistantIdx).toBeGreaterThan(currentIdx);
    const lastAssistant = messages[lastAssistantIdx] as {
      toolCalls: NormalizedToolCall[];
    };
    expect(lastAssistant.toolCalls[0]?.id).toBe("s8-c0");
    // Oldest history trimmed first: q1 must be gone while later survives.
    // Exact line match: q1 is a prefix of q10..q18 so require the newline.
    const blob = messages.map((m) => m.content).join("\n");
    expect(blob).not.toContain(`${AGENT_HISTORY_USER_PREFIX}q1\n`);
    expect(blob).toContain(`${AGENT_HISTORY_USER_PREFIX}q60\n`);
    // Deterministic chronological order preserved for survivors.
    const assistantIds: string[] = [];
    for (const m of messages) {
      if (m.role === "assistant" && Array.isArray(m.toolCalls)) {
        for (const c of m.toolCalls as NormalizedToolCall[]) {
          assistantIds.push(c.id);
        }
      }
    }
    const sorted = [...assistantIds].sort();
    // Step order retained: ids appear grouped by step ascending.
    let lastStep = 0;
    for (const id of assistantIds) {
      const step = Number(id.slice(1, id.indexOf("-c")));
      expect(step).toBeGreaterThanOrEqual(lastStep);
      lastStep = step;
    }
    expect(sorted.length).toBe(assistantIds.length);
  });

  it("drops a repair group atomically, never orphaning tool_call_ids", () => {
    const messages: ChatMessage[] = [{ role: "system", content: "sys" }];
    for (let i = 1; i <= 10; i += 1) {
      messages.push({
        role: "user",
        content: `${AGENT_HISTORY_USER_PREFIX}hq${i}`,
      });
      messages.push({ role: "assistant", content: `hr${i}` });
    }
    messages.push({ role: "user", content: "User request:\ncurrent" });
    // Group 1: ordinary (2 calls).
    messages.push({
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "g1-a", name: "test.read", arguments: { q: "a" } },
        { id: "g1-b", name: "test.read", arguments: { q: "b" } },
      ],
    });
    messages.push({
      role: "tool",
      content: "t",
      toolCallId: "g1-a",
      toolName: "test.read",
    });
    messages.push({
      role: "tool",
      content: "t",
      toolCallId: "g1-b",
      toolName: "test.read",
    });
    // Group 2: invalid mixed + fixed tools + repair hint (must stay together).
    messages.push({
      role: "assistant",
      content: "mixed",
      toolCalls: [
        { id: "g2-a", name: "test.read", arguments: { q: "x" } },
        {
          id: "g2-b",
          name: "answer.submit",
          arguments: { version: 1, parts: [{ text: "x", citations: [] }] },
        },
      ],
    });
    messages.push({
      role: "tool",
      content: AGENT_INVALID_TOOL_FEEDBACK_CONTENT,
      toolCallId: "g2-a",
      toolName: "test.read",
    });
    messages.push({
      role: "tool",
      content: AGENT_INVALID_TOOL_FEEDBACK_CONTENT,
      toolCallId: "g2-b",
      toolName: "answer.submit",
    });
    messages.push({
      role: "user",
      content: `Repair instruction:\n${AGENT_REPAIR_HINTS.mixed}`,
    });
    // Groups 3-27: ordinary 4-call groups to force overflow past history
    // capacity so the oldest tool groups (including g2) must drop.
    for (let step = 3; step <= 27; step += 1) {
      const calls: NormalizedToolCall[] = [];
      for (let k = 0; k < 4; k += 1) {
        calls.push({
          id: `g${step}-c${k}`,
          name: "test.read",
          arguments: { q: "z" },
        });
      }
      messages.push({
        role: "assistant",
        content: "",
        toolCalls: calls.map((c) => ({ ...c })),
      });
      for (const call of calls) {
        messages.push({
          role: "tool",
          content: "t",
          toolCallId: call.id,
          toolName: call.name,
        });
      }
    }
    expect(messages.length).toBeGreaterThan(128);
    trimConversationToCap(messages);
    expect(messages.length).toBeLessThanOrEqual(128);
    expectOpenAIWireValid({ model: "m", messages: [...messages] });
    expectNoOrphans(messages);
    // Repair atomicity: either the whole g2 block survives or none of it.
    // Assistant ids live in toolCalls/toolCallId fields, never in content.
    const hasAssistant = messages.some(
      (m) =>
        (m.role === "assistant" &&
          Array.isArray(m.toolCalls) &&
          (m.toolCalls as NormalizedToolCall[]).some((c) => c.id === "g2-a")) ||
        (m.role === "tool" && m.toolCallId === "g2-a"),
    );
    const hasHint = messages.some(
      (m) =>
        m.role === "user" &&
        typeof m.content === "string" &&
        m.content.includes(AGENT_REPAIR_HINTS.mixed),
    );
    expect(hasAssistant).toBe(hasHint);
    if (hasAssistant) {
      // Contiguous: assistant immediately followed by both tools then hint.
      const idx = messages.findIndex(
        (m) =>
          m.role === "assistant" &&
          Array.isArray(m.toolCalls) &&
          (m.toolCalls as NormalizedToolCall[]).some((c) => c.id === "g2-a"),
      );
      expect(messages[idx + 1]?.toolCallId).toBe("g2-a");
      expect(messages[idx + 2]?.toolCallId).toBe("g2-b");
      expect(messages[idx + 3]?.content).toContain("never both");
    }
  });

  it("8-step run with 32 ordinary calls keeps every gateway request <=128 and OpenAI-valid", async () => {
    const handle = openKernelDatabase(":memory:");
    await migrateKernelDatabase({ db: handle.raw });
    try {
      const repo: KernelRepository = createKernelRepository(handle.raw);
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
            inputSchema: z.strictObject({ q: z.string().default("hi") }),
            outputSchema: z.strictObject({ text: z.string() }),
            handler: async () => ({ text: "ok" }),
          },
        ],
      });
      // Seed 55 completed history turns (110 msgs) so 8 steps x5 msgs
      // overflow the 128 cap and force history-then-group trimming.
      const sessionId = repo.createSession({
        key: crypto.randomUUID(),
        now: T0,
      }).body.sessionId;
      let now = T0 + 1;
      for (let i = 1; i <= 55; i += 1) {
        const posted = repo.postMessage(
          sessionId,
          { text: `history-q${i}` },
          { key: crypto.randomUUID(), now },
        );
        now += 1;
        repo.startRun(posted.body.run.id, { now });
        now += 1;
        repo.completeRun(
          posted.body.run.id,
          { version: 1, text: `history-r${i}` },
          { now },
        );
        now += 1;
      }
      const posted = repo.postMessage(
        sessionId,
        { text: "current research" },
        { key: crypto.randomUUID(), now },
      );
      const runId = posted.body.run.id;
      repo.startRun(runId, { now: now + 1 });
      // Seed one grant before the run: trimming prompt data later must not
      // remove it from persistence. The reference must exist in this
      // session (session_references row) for the grant to be accepted.
      const insertReference = (sessionId: string, ordinal: number): string => {
        const conn = crypto.randomUUID();
        const res = crypto.randomUUID();
        const snap = crypto.randomUUID();
        const ref = crypto.randomUUID();
        handle.raw
          .prepare(
            "INSERT INTO connector_instances (id, kind, display_name, config_json, created_at) VALUES (?, 'markdown', ?, '{}', ?)",
          )
          .run(conn, `vault-${conn.slice(0, 8)}`, now);
        handle.raw
          .prepare(
            "INSERT INTO resources (id, connector_instance_id, canonical_key, title, next_revision, created_at) VALUES (?, ?, ?, ?, 2, ?)",
          )
          .run(
            res,
            conn,
            `vault/doc-cap-${ordinal}-${ref.slice(0, 8)}.md`,
            `Doc ${ordinal}`,
            now,
          );
        handle.raw
          .prepare(
            "INSERT INTO resource_snapshots (id, resource_id, revision, source_revision, content_hash, body_json, size_bytes, observed_at, created_at) VALUES (?, ?, 1, 's1', 'h', ?, ?, ?, ?)",
          )
          .run(
            snap,
            res,
            JSON.stringify({ version: 1, text: "evidence text" }),
            13,
            now,
            now,
          );
        handle.raw
          .prepare(
            "INSERT INTO session_references (id, session_id, ordinal, resource_id, snapshot_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(ref, sessionId, 900 + ordinal, res, snap, now);
        return ref;
      };
      const refId = insertReference(sessionId, 1);
      expect(
        repo.upsertEvidenceGrant(sessionId, runId, refId, "snippet", {
          now: now + 2,
        }).exposure,
      ).toBe("snippet");

      const captured: ChatRequest[] = [];
      let stepCount = 0;
      const gateway: ModelGateway = {
        provider: "openai-compatible",
        capabilities: { toolCalling: true },
        baseUrl: "http://127.0.0.1:11434",
        chatUrl: "http://127.0.0.1:11434/v1/chat/completions",
        chat: async (request: ChatRequest): Promise<ChatResult> => {
          captured.push({
            model: request.model,
            messages: request.messages.map((m) => ({ ...m })),
            ...(request.tools !== undefined
              ? { tools: request.tools.map((t) => ({ ...t })) }
              : {}),
          });
          // Strict validation on every gateway call.
          expect(request.messages.length).toBeLessThanOrEqual(128);
          expectOpenAIWireValid(request);
          expectNoOrphans(request.messages);
          stepCount += 1;
          // Step 2 is a mixed invalid step to exercise the one repair path.
          if (stepCount === 2) {
            return {
              text: "mixed",
              toolCalls: [
                {
                  id: "repair-ordinary",
                  name: "test.read",
                  arguments: { q: "x" },
                },
                {
                  id: "repair-answer",
                  name: "answer.submit",
                  arguments: {
                    version: 1,
                    parts: [{ text: "x", citations: [] }],
                  },
                },
              ],
              stopReason: "tool_calls",
            };
          }
          if (stepCount <= 7) {
            // 4 ordinary calls per ordinary step.
            return {
              text: "",
              toolCalls: ordinaryCalls(stepCount, 4),
              stopReason: "tool_calls",
            };
          }
          return {
            text: "",
            toolCalls: [answerCall()],
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
      expect(result.text).toBe("done");
      // 8 gateway calls max (7 ordinary/mixed + repair retry + answer fit
      // within the 8-step budget: mixed consumes one step, repair is the
      // next gateway call).
      expect(captured.length).toBeLessThanOrEqual(8);
      expect(captured.length).toBeGreaterThanOrEqual(7);
      for (const req of captured) {
        expect(req.messages.length).toBeLessThanOrEqual(128);
        expectOpenAIWireValid(req);
        expectNoOrphans(req.messages);
      }
      // 32-call volume: 6 ordinary steps x4 (24) + mixed 2 + repair-retry
      // ordinary 4 = 30 ordinary gateway calls; broker executes all but the
      // 2 mixed calls. Assert the volume and that latest ordering survives.
      const ordinaryGatewayCalls = captured
        .flatMap((r) => r.messages)
        .filter((m) => m.role === "assistant" && Array.isArray(m.toolCalls))
        .flatMap((m) => (m.toolCalls as NormalizedToolCall[]).map((c) => c.id));
      expect(ordinaryGatewayCalls.length).toBeGreaterThanOrEqual(20);
      const lastReq = captured[captured.length - 1] as ChatRequest;
      const lastBlob = lastReq.messages.map((m) => m.content).join("\n");
      expect(lastBlob).toContain("current research");
      expect(lastReq.messages[0]?.role).toBe("system");
      // Repair wire retained in the request after the mixed step.
      const repairedReq = captured[2] as ChatRequest;
      const repairedBlob = repairedReq.messages
        .map((m) => `${m.role}:${m.content}`)
        .join("\n");
      expect(repairedBlob).toContain("never both");
      // Grants stay accurate even though old prompt groups were trimmed.
      expect(
        repo.listEvidenceGrants(runId).some((g) => g.referenceId === refId),
      ).toBe(true);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
