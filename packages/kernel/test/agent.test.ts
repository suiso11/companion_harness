// M2 AgentStrategy tests (plan §15): classification, bounded loop, repair,
// ToolBroker bypass for answer.submit, concurrency/order for ordinary tools,
// evidence grants on model-facing exposure only, structural citations,
// metadata-only audit, fixed errors, timeouts/cancellation, engine CAS.
//
// Fast and deterministic: in-memory DBs, scripted fake gateways, tiny real
// timeouts (tens of ms). No network, no real models.

import type {
  ChatRequest,
  ChatResult,
  ModelGateway,
  NormalizedToolCall,
} from "@companion/model-local";
import { ModelLocalError } from "@companion/model-local";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AGENT_MAX_STEPS,
  AGENT_REPAIR_HINTS,
  AGENT_SYSTEM_PROMPT,
  AGENT_TOOL_CALLER,
  AGENT_TOOL_CONCURRENCY,
  AGENT_TOOL_ORIGIN,
  answerSubmitToolDefinition,
  BUNDLED_SCHEMA_VERSION,
  buildAgentToolDefinitions,
  classifyStep,
  createAgentStrategy,
  createKernelRepository,
  createToolBroker,
  extractGrantCandidates,
  freezeStrategyContext,
  type KernelRepository,
  type ModelCallRow,
  migrateKernelDatabase,
  openKernelDatabase,
  projectPrompt,
  type RunStrategyContext,
  renderAnswerText,
  type ToolBroker,
  type ToolRegistration,
  verifyCitations,
} from "../src/index.js";

const T0 = 1790000000000;

function toolCall(
  name: string,
  args: unknown = {},
  id = `call-${name}-${Math.random().toString(36).slice(2)}`,
): NormalizedToolCall {
  return { id, name, arguments: args };
}

function answerCall(
  parts: { text: string; citations: string[] }[] = [
    { text: "final", citations: [] },
  ],
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

/** Scripted gateway: dequeues scripted results/errors per chat() call. */
function scriptGateway(
  script: Array<ChatResult | Error>,
  opts?: { toolCalling?: boolean },
): { gateway: ModelGateway; calls: ChatRequest[] } {
  const calls: ChatRequest[] = [];
  const gateway: ModelGateway = {
    provider: "ollama",
    capabilities: { toolCalling: opts?.toolCalling ?? true },
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

function readReg(overrides?: {
  name?: string;
  handler?: ToolRegistration["handler"];
  normalize?: ToolRegistration["normalize"];
}): ToolRegistration {
  return {
    descriptor: {
      name: overrides?.name ?? "test.read",
      version: 1,
      title: "Test read tool",
      description: "M2 agent test tool",
      category: "read",
      defaultTimeoutMs: 5000,
      maxTimeoutMs: 10_000,
      supportsRefresh: true,
    },
    inputSchema: z.strictObject({ q: z.string().default("hi") }),
    outputSchema: z.strictObject({ text: z.string() }),
    handler:
      overrides?.handler ??
      (async (input: { q: string }) => ({ text: `out:${input.q}` })),
    ...(overrides?.normalize === undefined
      ? {}
      : { normalize: overrides.normalize }),
  };
}

function makeBroker(
  handle: ReturnType<typeof openKernelDatabase>,
  repo: KernelRepository,
  regs: readonly ToolRegistration[] = [],
  onStep?: () => void,
): ToolBroker {
  return createToolBroker({
    db: handle.raw,
    repo,
    registrations: regs,
    ...(onStep === undefined ? {} : { onStep: () => onStep() }),
  });
}

function newRunningTurn(
  repo: KernelRepository,
  now: number,
): { sessionId: string; turnId: string; runId: string } {
  const sessionId = repo.createSession({ key: crypto.randomUUID(), now }).body
    .sessionId;
  const posted = repo.postMessage(
    sessionId,
    { text: "research this" },
    { key: crypto.randomUUID(), now },
  );
  const runId = posted.body.run.id;
  repo.startRun(runId, { now: now + 1 });
  return { sessionId, turnId: posted.body.turnId, runId };
}

function strategyCtx(
  repo: KernelRepository,
  sessionId: string,
  runId: string,
): RunStrategyContext {
  const run = repo.getRun(runId);
  const turn = repo.getTurn(run.turnId);
  void sessionId;
  return freezeStrategyContext(
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
}

function makeStrategy(
  handle: ReturnType<typeof openKernelDatabase>,
  repo: KernelRepository,
  broker: ToolBroker,
  gateway: ModelGateway,
  extra?: { stepTimeoutMs?: number; wallMs?: number; maxSteps?: number },
): ReturnType<typeof createAgentStrategy> {
  return createAgentStrategy({
    db: handle.raw,
    repo,
    broker,
    gateway,
    model: "test-model",
    ...(extra?.stepTimeoutMs === undefined
      ? {}
      : { stepTimeoutMs: extra.stepTimeoutMs }),
    ...(extra?.wallMs === undefined ? {} : { wallMs: extra.wallMs }),
    ...(extra?.maxSteps === undefined ? {} : { maxSteps: extra.maxSteps }),
  });
}

/** Raw-SQL reference fixture (uuid ids, valid snapshot body). */
function insertReference(
  db: Database.Database,
  sessionId: string,
  ordinal: number,
  now: number,
): string {
  const conn = crypto.randomUUID();
  const res = crypto.randomUUID();
  const snap = crypto.randomUUID();
  const ref = crypto.randomUUID();
  db.prepare(
    "INSERT INTO connector_instances (id, kind, display_name, config_json, created_at) VALUES (?, 'markdown', 'vault', '{}', ?)",
  ).run(conn, now);
  db.prepare(
    "INSERT INTO resources (id, connector_instance_id, canonical_key, title, next_revision, created_at) VALUES (?, ?, ?, ?, 2, ?)",
  ).run(res, conn, `vault/doc-${ordinal}.md`, `Doc ${ordinal}`, now);
  db.prepare(
    "INSERT INTO resource_snapshots (id, resource_id, revision, source_revision, content_hash, body_json, size_bytes, observed_at, created_at) VALUES (?, ?, 1, 's1', 'h', ?, ?, ?, ?)",
  ).run(
    snap,
    res,
    JSON.stringify({ version: 1, text: "evidence text" }),
    13,
    now,
    now,
  );
  db.prepare(
    "INSERT INTO session_references (id, session_id, ordinal, resource_id, snapshot_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(ref, sessionId, ordinal, res, snap, now);
  return ref;
}

describe("classifyStep (§15.4)", () => {
  it("classifies ordinary-only steps", () => {
    const out = classifyStep([toolCall("test.read"), toolCall("test.other")]);
    expect(out.kind).toBe("ordinary");
    if (out.kind === "ordinary") expect(out.calls).toHaveLength(2);
  });
  it("classifies a single answer.submit alone", () => {
    const call = answerCall();
    const out = classifyStep([call]);
    expect(out).toEqual({ kind: "single_answer", call });
  });
  it("classifies mixed ordinary + answer as invalid", () => {
    expect(classifyStep([toolCall("test.read"), answerCall()]).kind).toBe(
      "mixed",
    );
  });
  it("classifies duplicate answer.submit as invalid", () => {
    expect(classifyStep([answerCall(), answerCall()]).kind).toBe("duplicate");
  });
  it("classifies reserved answer.* siblings as invalid", () => {
    expect(classifyStep([toolCall("answer.draft")]).kind).toBe("reserved");
    expect(classifyStep([toolCall("answer")]).kind).toBe("reserved");
  });
  it("classifies empty tool calls (free text) as invalid, never parsing content", () => {
    expect(classifyStep([]).kind).toBe("free_text");
  });
});

describe("prompt projection and answer rendering", () => {
  it("builds a deterministic prompt with fixed system prompt and repair hint", () => {
    const tools = buildAgentToolDefinitions([]);
    expect(tools.map((t) => t.name)).toEqual(["answer.submit"]);
    expect(answerSubmitToolDefinition().name).toBe("answer.submit");
    const args = {
      requestText: "q",
      history: [{ turnSeq: 1, requestText: "old", resultText: "res" }],
      references: [{ ordinal: 1, title: "T", canonicalKey: "k" }],
      tools,
      model: "m",
    };
    const first = projectPrompt(args);
    expect(projectPrompt(args)).toEqual(first);
    expect(first.messages[0]).toEqual({
      role: "system",
      content: AGENT_SYSTEM_PROMPT,
    });
    const repaired = projectPrompt({
      ...args,
      repairHint: AGENT_REPAIR_HINTS.mixed,
    });
    expect(JSON.stringify(repaired)).toContain("never both");
  });
  it("renders answer parts joined by blank lines", () => {
    expect(
      renderAnswerText({
        version: 1,
        parts: [
          { text: "a", citations: [] },
          { text: "b", citations: ["r1"] },
        ],
      }),
    ).toBe("a\n\nb");
  });
});

describe("verifyCitations and extractGrantCandidates", () => {
  it("accepts granted ordinals and flags malformed or ungranted ids in order", () => {
    const answer = {
      version: 1 as const,
      parts: [{ text: "t", citations: ["r1", "bogus", "r0", "r2", "r01"] }],
    };
    const out = verifyCitations(
      answer,
      new Map([[1, "ref-1"]]),
      new Set(["ref-1"]),
    );
    expect(out.ok).toBe(false);
    expect(out.invalid).toEqual(["bogus", "r0", "r2", "r01"]);
  });
  it("derives full exposure from body payloads and snippet otherwise", () => {
    const ref = crypto.randomUUID();
    expect(
      extractGrantCandidates({
        referenceId: ref,
        snippet: "s",
        body: { version: 1, text: "full" },
      }),
    ).toEqual([{ referenceId: ref, exposure: "full" }]);
    expect(
      extractGrantCandidates({ hits: [{ referenceId: ref, snippet: "s" }] }),
    ).toEqual([{ referenceId: ref, exposure: "snippet" }]);
    expect(
      extractGrantCandidates({
        references: [
          { referenceId: ref, snippet: "s", body: { version: 1, text: "f" } },
        ],
      }),
    ).toEqual([{ referenceId: ref, exposure: "full" }]);
    // Title/canonicalKey-only related listings never grant.
    expect(
      extractGrantCandidates({
        references: [
          {
            referenceId: ref,
            ordinal: 1,
            snapshotId: crypto.randomUUID(),
            resourceId: crypto.randomUUID(),
            canonicalKey: "vault/a.md",
            title: "A",
          },
        ],
      }),
    ).toEqual([]);
    expect(extractGrantCandidates({ hits: [{ referenceId: ref }] })).toEqual(
      [],
    );
    expect(extractGrantCandidates({ referenceId: ref })).toEqual([]);
    expect(extractGrantCandidates({ note: "no refs" })).toEqual([]);
    expect(extractGrantCandidates("frozen summary r1")).toEqual([]);
  });
});

describe("factory wiring validation", () => {
  it("rejects models without native tool calling, bad model names, wide budgets, and answer.* tools", async () => {
    const { handle, repo } = await setup();
    try {
      const broker = makeBroker(handle, repo);
      const { gateway } = scriptGateway([chatResult([answerCall()])], {
        toolCalling: false,
      });
      expect(() =>
        createAgentStrategy({
          db: handle.raw,
          repo,
          broker,
          gateway,
          model: "m",
        }),
      ).toThrow(/tool calling/);
      const { gateway: ok } = scriptGateway([chatResult([answerCall()])]);
      expect(() =>
        createAgentStrategy({
          db: handle.raw,
          repo,
          broker,
          gateway: ok,
          model: "",
        }),
      ).toThrow();
      expect(() =>
        createAgentStrategy({
          db: handle.raw,
          repo,
          broker,
          gateway: ok,
          model: "m",
          maxSteps: AGENT_MAX_STEPS + 1,
        }),
      ).toThrow();
      const bad = makeBroker(handle, repo, [
        readReg({ name: "answer.submit" }),
      ]);
      expect(() =>
        createAgentStrategy({
          db: handle.raw,
          repo,
          broker: bad,
          gateway: ok,
          model: "m",
        }),
      ).toThrow(/reserved/);
      const bad2 = makeBroker(handle, repo, [
        readReg({ name: "answer.draft" }),
      ]);
      expect(() =>
        createAgentStrategy({
          db: handle.raw,
          repo,
          broker: bad2,
          gateway: ok,
          model: "m",
        }),
      ).toThrow(/reserved/);
      expect(AGENT_MAX_STEPS).toBe(8);
      expect(AGENT_TOOL_CONCURRENCY).toBe(3);
    } finally {
      const { closeKernelDatabase } = await import("../src/index.js");
      closeKernelDatabase(handle);
    }
  });
});

describe("terminal protocol: answer.submit bypasses ToolBroker", () => {
  it("accepts a single valid answer with no broker traffic and leaves the run to the engine", async () => {
    const { handle, repo } = await setup();
    try {
      let brokerSteps = 0;
      const broker = makeBroker(handle, repo, [], () => {
        brokerSteps += 1;
      });
      const { gateway, calls } = scriptGateway([
        chatResult([answerCall([{ text: "done", citations: [] }])]),
      ]);
      const strategy = makeStrategy(handle, repo, broker, gateway);
      const { sessionId, runId } = newRunningTurn(repo, T0);
      const result = await strategy(strategyCtx(repo, sessionId, runId));
      expect(result).toEqual({
        version: 2,
        text: "done",
        answer: { version: 1, parts: [{ text: "done", citations: [] }] },
      });
      expect(brokerSteps).toBe(0);
      expect(
        handle.raw.prepare("SELECT COUNT(*) AS n FROM tool_calls").get(),
      ).toMatchObject({ n: 0 });
      // Engine still owns the terminal transition: strategy never completes.
      expect(repo.getRun(runId).status).toBe("running");
      expect(calls).toHaveLength(1);
      const posted = repo.completeRun(runId, result, { now: T0 + 5 });
      expect(posted.applied).toBe(true);
      expect(posted.run.status).toBe("completed");
    } finally {
      const { closeKernelDatabase } = await import("../src/index.js");
      closeKernelDatabase(handle);
    }
  });
  it("never executes ordinary calls bundled with answer.submit (mixed is repaired, not run)", async () => {
    const { handle, repo } = await setup();
    try {
      let executions = 0;
      const broker = makeBroker(handle, repo, [
        readReg({
          handler: async () => {
            executions += 1;
            return { text: "x" };
          },
        }),
      ]);
      const { gateway, calls } = scriptGateway([
        chatResult([toolCall("test.read", { q: "a" }, "c1"), answerCall()]),
        chatResult([answerCall([{ text: "recovered", citations: [] }])]),
      ]);
      const strategy = makeStrategy(handle, repo, broker, gateway);
      const { sessionId, runId } = newRunningTurn(repo, T0);
      const result = await strategy(strategyCtx(repo, sessionId, runId));
      expect(result).toEqual({
        version: 2,
        text: "recovered",
        answer: { version: 1, parts: [{ text: "recovered", citations: [] }] },
      });
      expect(executions).toBe(0);
      expect(calls).toHaveLength(2);
      expect(JSON.stringify(calls[1])).toContain("never both");
    } finally {
      const { closeKernelDatabase } = await import("../src/index.js");
      closeKernelDatabase(handle);
    }
  });
  it("repairs duplicate answer.submit once, then fails fixed on a repeat", async () => {
    const { handle, repo } = await setup();
    try {
      const broker = makeBroker(handle, repo);
      const { gateway, calls } = scriptGateway([
        chatResult([answerCall(), answerCall()]),
        chatResult([answerCall(), answerCall()]),
      ]);
      const strategy = makeStrategy(handle, repo, broker, gateway);
      const { sessionId, runId } = newRunningTurn(repo, T0);
      await expect(
        strategy(strategyCtx(repo, sessionId, runId)),
      ).rejects.toMatchObject({ name: "StrategyError" });
      expect(calls).toHaveLength(2);
    } finally {
      const { closeKernelDatabase } = await import("../src/index.js");
      closeKernelDatabase(handle);
    }
  });
  it("never parses free text as an answer: one repair, then fixed failure", async () => {
    const { handle, repo } = await setup();
    try {
      const broker = makeBroker(handle, repo);
      const { gateway, calls } = scriptGateway([
        chatResult(
          [],
          '{"version":1,"parts":[{"text":"sneaky","citations":[]}]}',
        ),
        chatResult([], "more prose"),
      ]);
      const strategy = makeStrategy(handle, repo, broker, gateway);
      const { sessionId, runId } = newRunningTurn(repo, T0);
      await expect(
        strategy(strategyCtx(repo, sessionId, runId)),
      ).rejects.toMatchObject({
        name: "StrategyError",
        errorCode: "output_invalid",
      });
      expect(calls).toHaveLength(2);
    } finally {
      const { closeKernelDatabase } = await import("../src/index.js");
      closeKernelDatabase(handle);
    }
  });
  it("repairs a structurally invalid answer payload once", async () => {
    const { handle, repo } = await setup();
    try {
      const broker = makeBroker(handle, repo);
      const oversized = "x".repeat(4001);
      const { gateway, calls } = scriptGateway([
        chatResult([
          toolCall(
            "answer.submit",
            { version: 1, parts: [{ text: oversized, citations: [] }] },
            "a1",
          ),
        ]),
        chatResult([answerCall([{ text: "ok", citations: [] }])]),
      ]);
      const strategy = makeStrategy(handle, repo, broker, gateway);
      const { sessionId, runId } = newRunningTurn(repo, T0);
      expect(await strategy(strategyCtx(repo, sessionId, runId))).toEqual({
        version: 2,
        text: "ok",
        answer: { version: 1, parts: [{ text: "ok", citations: [] }] },
      });
      expect(calls).toHaveLength(2);
    } finally {
      const { closeKernelDatabase } = await import("../src/index.js");
      closeKernelDatabase(handle);
    }
  });
});

describe("ordinary tools: broker concurrency and request order", () => {
  it("runs at most 3 physical executions and returns feedback in request order", async () => {
    const { handle, repo } = await setup();
    try {
      let active = 0;
      let maxActive = 0;
      const broker = makeBroker(handle, repo, [
        readReg({
          handler: async (input: { q: string }) => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise((r) => setTimeout(r, 20));
            active -= 1;
            return { text: `out:${input.q}` };
          },
        }),
      ]);
      const ordinary = ["a", "b", "c", "d", "e"].map((q, i) =>
        toolCall("test.read", { q }, `c${i}`),
      );
      const { gateway, calls } = scriptGateway([
        chatResult(ordinary),
        chatResult([answerCall([{ text: "after tools", citations: [] }])]),
      ]);
      const strategy = makeStrategy(handle, repo, broker, gateway);
      const { sessionId, runId } = newRunningTurn(repo, T0);
      expect(await strategy(strategyCtx(repo, sessionId, runId))).toEqual({
        version: 2,
        text: "after tools",
        answer: {
          version: 1,
          parts: [{ text: "after tools", citations: [] }],
        },
      });
      expect(maxActive).toBeLessThanOrEqual(AGENT_TOOL_CONCURRENCY);
      expect(maxActive).toBeGreaterThan(1);
      // Second model step must carry one role:tool message per call,
      // in request order, each with its matching toolCallId.
      const feedback = (calls[1] as ChatRequest).messages.filter(
        (m) => m.role === "tool",
      );
      expect(feedback).toHaveLength(5);
      expect(feedback.map((m) => m.toolCallId)).toEqual([
        "c0",
        "c1",
        "c2",
        "c3",
        "c4",
      ]);
      const parsed = feedback.map(
        (m) =>
          JSON.parse((m as { content: string }).content) as {
            tool: string;
            ok: boolean;
            output: unknown;
          },
      );
      expect(parsed.map((e) => (e.output as { text: string }).text)).toEqual([
        "out:a",
        "out:b",
        "out:c",
        "out:d",
        "out:e",
      ]);
      expect(parsed.every((e) => e.ok)).toBe(true);
    } finally {
      const { closeKernelDatabase } = await import("../src/index.js");
      closeKernelDatabase(handle);
    }
  });
  it("caps the model budget: persistent tool loops fail after exactly 8 calls, never a ninth", async () => {
    const { handle, repo } = await setup();
    try {
      const broker = makeBroker(handle, repo, [readReg()]);
      const script: ChatResult[] = Array.from({ length: 20 }, (_, i) =>
        chatResult([toolCall("test.read", { q: `q${i}` }, `c${i}`)]),
      );
      const { gateway, calls } = scriptGateway(script);
      const strategy = makeStrategy(handle, repo, broker, gateway);
      const { sessionId, runId } = newRunningTurn(repo, T0);
      await expect(
        strategy(strategyCtx(repo, sessionId, runId)),
      ).rejects.toMatchObject({ errorCode: "output_invalid" });
      expect(calls).toHaveLength(AGENT_MAX_STEPS);
      expect(repo.listModelCalls(runId)).toHaveLength(AGENT_MAX_STEPS);
    } finally {
      const { closeKernelDatabase } = await import("../src/index.js");
      closeKernelDatabase(handle);
    }
  });
});

describe("evidence grants and structural citations", () => {
  it("grants snippet exposure from delivered reference payloads and gates citations", async () => {
    const { handle, repo } = await setup();
    try {
      const sessionId = repo.createSession({
        key: crypto.randomUUID(),
        now: T0,
      }).body.sessionId;
      const refId = insertReference(handle.raw, sessionId, 1, T0);
      repo.putReferenceContext(
        sessionId,
        { version: 1, items: [refId] },
        { now: T0 + 1 },
      );
      const posted = repo.postMessage(
        sessionId,
        { text: "q" },
        { key: crypto.randomUUID(), now: T0 + 2 },
      );
      const runId = posted.body.run.id;
      repo.startRun(runId, { now: T0 + 3 });
      const broker = makeBroker(handle, repo, [
        readReg({
          name: "test.search",
          normalize: (raw) => ({
            normalized: raw,
            observations: 1,
            modelFacing: { hits: [{ referenceId: refId, snippet: "s" }] },
          }),
        }),
      ]);
      const { gateway } = scriptGateway([
        chatResult([toolCall("test.search", {}, "c1")]),
        chatResult([
          toolCall(
            "answer.submit",
            { version: 1, parts: [{ text: "cited", citations: ["r9"] }] },
            "a-bad",
          ),
        ]),
        chatResult([
          toolCall(
            "answer.submit",
            { version: 1, parts: [{ text: "cited", citations: ["r1"] }] },
            "a-good",
          ),
        ]),
      ]);
      const strategy = makeStrategy(handle, repo, broker, gateway);
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
      expect(await strategy(ctx)).toEqual({
        version: 2,
        text: "cited",
        answer: { version: 1, parts: [{ text: "cited", citations: ["r1"] }] },
      });
      const grants = repo.listEvidenceGrants(runId);
      expect(grants).toHaveLength(1);
      expect(grants[0]).toMatchObject({
        referenceId: refId,
        exposure: "snippet",
      });
    } finally {
      const { closeKernelDatabase } = await import("../src/index.js");
      closeKernelDatabase(handle);
    }
  });
  it("upgrades snippet to full on body exposure and never downgrades", async () => {
    const { handle, repo } = await setup();
    try {
      const sessionId = repo.createSession({
        key: crypto.randomUUID(),
        now: T0,
      }).body.sessionId;
      const refId = insertReference(handle.raw, sessionId, 1, T0);
      const posted = repo.postMessage(
        sessionId,
        { text: "q" },
        { key: crypto.randomUUID(), now: T0 + 1 },
      );
      const runId = posted.body.run.id;
      repo.startRun(runId, { now: T0 + 2 });
      expect(
        repo.upsertEvidenceGrant(sessionId, runId, refId, "snippet", {
          now: T0 + 3,
        }),
      ).toMatchObject({ exposure: "snippet" });
      expect(
        repo.upsertEvidenceGrant(sessionId, runId, refId, "full", {
          now: T0 + 4,
        }),
      ).toMatchObject({ exposure: "full" });
      expect(
        repo.upsertEvidenceGrant(sessionId, runId, refId, "snippet", {
          now: T0 + 5,
        }),
      ).toMatchObject({ exposure: "full" });
    } finally {
      const { closeKernelDatabase } = await import("../src/index.js");
      closeKernelDatabase(handle);
    }
  });
});

describe("metadata-only audit, fixed errors, timeouts, cancellation", () => {
  it("records metadata-only model_calls and model.step events with no prompt content", async () => {
    const { handle, repo } = await setup();
    try {
      const broker = makeBroker(handle, repo);
      const { gateway } = scriptGateway([
        chatResult([answerCall([{ text: "hi", citations: [] }])]),
      ]);
      const strategy = makeStrategy(handle, repo, broker, gateway);
      const { sessionId, runId } = newRunningTurn(repo, T0);
      await strategy(strategyCtx(repo, sessionId, runId));
      const calls: ModelCallRow[] = repo.listModelCalls(runId);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        step: 1,
        adapter: "ollama",
        model: "test-model",
        outcome: "completed",
        errorCode: null,
      });
      const events = repo.getEvents(sessionId, runId, {});
      const types = events.events.map((e) => e.type);
      expect(types).toContain("model.step.started");
      expect(types).toContain("model.step.completed");
      const blob = JSON.stringify(events.events);
      expect(blob).not.toContain("research this");
      // Tool-call audit table carries no prompt/model-content columns.
      const cols = handle.raw
        .prepare("PRAGMA table_info(model_calls)")
        .all() as Array<{ name: string }>;
      expect(cols.map((c) => c.name).sort()).toEqual(
        [
          "adapter",
          "created_at",
          "duration_ms",
          "error_code",
          "id",
          "model",
          "outcome",
          "run_id",
          "step",
          "usage_json",
        ].sort(),
      );
    } finally {
      const { closeKernelDatabase } = await import("../src/index.js");
      closeKernelDatabase(handle);
    }
  });
  it("maps gateway failures to fixed redacted codes without retries", async () => {
    const { handle, repo } = await setup();
    try {
      const broker = makeBroker(handle, repo);
      const bad = new ModelLocalError("tool_call_invalid", "redacted");
      const { gateway, calls } = scriptGateway([bad]);
      const strategy = makeStrategy(handle, repo, broker, gateway);
      const first = newRunningTurn(repo, T0);
      await expect(
        strategy(strategyCtx(repo, first.sessionId, first.runId)),
      ).rejects.toMatchObject({ errorCode: "execution_failed" });
      expect(calls).toHaveLength(1);
      expect(repo.listModelCalls(first.runId)[0]).toMatchObject({
        outcome: "failed",
        errorCode: "answer_invalid",
      });
      const { gateway: gw2, calls: calls2 } = scriptGateway([
        new Error("boom"),
      ]);
      const strategy2 = makeStrategy(handle, repo, broker, gw2);
      const second = newRunningTurn(repo, T0 + 10);
      await expect(
        strategy2(strategyCtx(repo, second.sessionId, second.runId)),
      ).rejects.toMatchObject({ errorCode: "execution_failed" });
      expect(calls2).toHaveLength(1);
      expect(repo.listModelCalls(second.runId)[0]).toMatchObject({
        outcome: "failed",
        errorCode: "model_unavailable",
      });
    } finally {
      const { closeKernelDatabase } = await import("../src/index.js");
      closeKernelDatabase(handle);
    }
  });
  it("times out a hung step with model_step_timeout and respects the wall budget", async () => {
    const { handle, repo } = await setup();
    try {
      const broker = makeBroker(handle, repo);
      const hanging: ModelGateway = {
        provider: "ollama",
        capabilities: { toolCalling: true },
        baseUrl: "http://127.0.0.1:11434",
        chatUrl: "http://127.0.0.1:11434/api/chat",
        chat: () => new Promise<ChatResult>(() => {}),
      };
      const strategy = makeStrategy(handle, repo, broker, hanging, {
        stepTimeoutMs: 20,
      });
      const { sessionId, runId } = newRunningTurn(repo, T0);
      await expect(
        strategy(strategyCtx(repo, sessionId, runId)),
      ).rejects.toMatchObject({ errorCode: "execution_failed" });
      expect(repo.listModelCalls(runId)[0]).toMatchObject({
        outcome: "timeout",
        errorCode: "model_step_timeout",
      });
    } finally {
      const { closeKernelDatabase } = await import("../src/index.js");
      closeKernelDatabase(handle);
    }
  });
  it("cancels on an aborted signal and on engine terminal CAS without extra model calls", async () => {
    const { handle, repo } = await setup();
    try {
      const broker = makeBroker(handle, repo);
      let chatCalls = 0;
      const gateway: ModelGateway = {
        provider: "ollama",
        capabilities: { toolCalling: true },
        baseUrl: "http://127.0.0.1:11434",
        chatUrl: "http://127.0.0.1:11434/api/chat",
        chat: async (): Promise<ChatResult> => {
          chatCalls += 1;
          return chatResult([answerCall()]);
        },
      };
      const strategy = makeStrategy(handle, repo, broker, gateway);
      const { sessionId, runId } = newRunningTurn(repo, T0);
      const controller = new AbortController();
      controller.abort();
      const run = repo.getRun(runId);
      const turn = repo.getTurn(run.turnId);
      const abortedCtx = freezeStrategyContext(
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
        controller.signal,
      );
      await expect(strategy(abortedCtx)).rejects.toMatchObject({
        errorCode: "execution_cancelled",
      });
      expect(chatCalls).toBe(0);
      // Engine-owned terminal: a cancel_requested run stops the agent with no model call.
      repo.cancelRun(sessionId, runId, { now: T0 + 5 });
      await expect(
        strategy(strategyCtx(repo, sessionId, runId)),
      ).rejects.toMatchObject({ errorCode: "execution_cancelled" });
      expect(chatCalls).toBe(0);
    } finally {
      const { closeKernelDatabase } = await import("../src/index.js");
      closeKernelDatabase(handle);
    }
  });
});

describe("migration 0005 model_calls (§15.10)", () => {
  it("ships version 5 with the metadata-only model_calls table, checks, and lookup index", async () => {
    expect(BUNDLED_SCHEMA_VERSION).toBe(5);
    const { handle } = await setup();
    try {
      const sql = (
        handle.raw
          .prepare("SELECT sql FROM sqlite_master WHERE name = 'model_calls'")
          .get() as { sql: string }
      ).sql;
      expect(sql).toContain("STRICT");
      expect(sql).toContain("step >= 1 AND step <= 8");
      expect(sql).toContain("completed','failed','timeout','cancelled");
      expect(sql).toContain("model_unavailable");
      expect(sql).toContain("UNIQUE (run_id, step)");
      const idx = handle.raw
        .prepare(
          "SELECT sql FROM sqlite_master WHERE name = 'idx_model_calls_run'",
        )
        .get() as { sql: string };
      expect(idx.sql).toContain("model_calls");
    } finally {
      const { closeKernelDatabase } = await import("../src/index.js");
      closeKernelDatabase(handle);
    }
  });
  it("validates model-call rows: step bounds, outcomes, usage, and per-step uniqueness", async () => {
    const { handle, repo } = await setup();
    try {
      const { runId } = newRunningTurn(repo, T0);
      expect(() =>
        repo.recordModelCall(runId, {
          step: 9,
          adapter: "a",
          model: "m",
          outcome: "completed",
          durationMs: 1,
        }),
      ).toThrow();
      expect(() =>
        repo.recordModelCall(runId, {
          step: 1,
          adapter: "a",
          model: "m",
          outcome: "completed",
          durationMs: -1,
        }),
      ).toThrow();
      const row = repo.recordModelCall(runId, {
        step: 1,
        adapter: "a",
        model: "m",
        outcome: "completed",
        durationMs: 3,
        usage: { inputTokens: 1, outputTokens: 2 },
      });
      expect(row.usage).toEqual({ inputTokens: 1, outputTokens: 2 });
      expect(() =>
        repo.recordModelCall(runId, {
          step: 1,
          adapter: "a",
          model: "m",
          outcome: "completed",
          durationMs: 3,
        }),
      ).toThrow(/duplicate/);
      expect(repo.listModelCalls(runId)).toHaveLength(1);
    } finally {
      const { closeKernelDatabase } = await import("../src/index.js");
      closeKernelDatabase(handle);
    }
  });
  it("rejects model-step events on terminal runs and exposes caller identity constants", async () => {
    const { handle, repo } = await setup();
    try {
      expect(AGENT_TOOL_ORIGIN).toBe("agent");
      expect(AGENT_TOOL_CALLER).toBe("m2-agent");
      const { runId } = newRunningTurn(repo, T0);
      repo.completeRun(runId, { version: 1, text: "done" }, { now: T0 + 2 });
      expect(() =>
        repo.appendModelStepEvent(
          runId,
          "model.step.started",
          { step: 1 },
          { now: T0 + 3 },
        ),
      ).toThrow(/terminal/);
    } finally {
      const { closeKernelDatabase } = await import("../src/index.js");
      closeKernelDatabase(handle);
    }
  });
});

describe("recordModelCall terminal finality (PR r3943538936)", () => {
  function validCall(step: number) {
    return {
      step,
      adapter: "ollama",
      model: "test-model",
      outcome: "completed" as const,
      durationMs: 5,
    };
  }

  it("rejects late model_calls on all terminal states without persisting rows", async () => {
    const { handle, repo } = await setup();
    try {
      // completed
      {
        const { runId } = newRunningTurn(repo, T0);
        repo.completeRun(runId, { version: 1, text: "done" }, { now: T0 + 2 });
        expect(() => repo.recordModelCall(runId, validCall(1))).toThrow(
          /terminal/,
        );
        expect(repo.listModelCalls(runId)).toHaveLength(0);
      }
      // failed
      {
        const { runId } = newRunningTurn(repo, T0 + 10);
        repo.failRun(runId, "execution_failed", { now: T0 + 12 });
        expect(() => repo.recordModelCall(runId, validCall(1))).toThrow(
          /terminal/,
        );
        expect(repo.listModelCalls(runId)).toHaveLength(0);
      }
      // cancelled (queued -> cancelled)
      {
        const sessionId = repo.createSession({
          key: crypto.randomUUID(),
          now: T0 + 20,
        }).body.sessionId;
        const posted = repo.postMessage(
          sessionId,
          { text: "q" },
          { key: crypto.randomUUID(), now: T0 + 20 },
        );
        repo.cancelRun(sessionId, posted.body.run.id, { now: T0 + 21 });
        expect(() =>
          repo.recordModelCall(posted.body.run.id, validCall(1)),
        ).toThrow(/terminal/);
        expect(repo.listModelCalls(posted.body.run.id)).toHaveLength(0);
      }
      // abandoned (running -> drain)
      {
        const { runId } = newRunningTurn(repo, T0 + 30);
        repo.drain({ now: T0 + 31 });
        expect(repo.getRun(runId).status).toBe("abandoned");
        expect(() => repo.recordModelCall(runId, validCall(1))).toThrow(
          /terminal/,
        );
        expect(repo.listModelCalls(runId)).toHaveLength(0);
      }
    } finally {
      const { closeKernelDatabase } = await import("../src/index.js");
      closeKernelDatabase(handle);
    }
  });

  it("preserves valid nonterminal audits and UNIQUE(run_id, step)", async () => {
    const { handle, repo } = await setup();
    try {
      const { sessionId, runId } = newRunningTurn(repo, T0);
      // running accepts audits.
      repo.recordModelCall(runId, validCall(1));
      // cancel_requested still accepts audits (matches event append rules).
      repo.cancelRun(sessionId, runId, { now: T0 + 2 });
      expect(repo.getRun(runId).status).toBe("cancel_requested");
      repo.recordModelCall(runId, validCall(2));
      expect(repo.listModelCalls(runId).map((r) => r.step)).toEqual([1, 2]);
      // UNIQUE(run_id, step) still enforced on nonterminal runs.
      expect(() => repo.recordModelCall(runId, validCall(1))).toThrow(
        /duplicate/,
      );
      expect(repo.listModelCalls(runId)).toHaveLength(2);
    } finally {
      const { closeKernelDatabase } = await import("../src/index.js");
      closeKernelDatabase(handle);
    }
  });

  it("drops a late AgentStrategy settlement after drain terminalization", async () => {
    const { handle, repo } = await setup();
    try {
      const { runId } = newRunningTurn(repo, T0);
      // Strategy records its in-flight step audit while running.
      repo.recordModelCall(runId, validCall(1));
      // Late cancellation/drain terminalizes before the late settlement lands.
      repo.drain({ now: T0 + 2 });
      expect(repo.getRun(runId).status).toBe("abandoned");
      // Late settlement (model output arriving after terminalization) must
      // not create a row: fixed safe error, no raw output persistence.
      expect(() =>
        repo.recordModelCall(runId, {
          ...validCall(2),
          outcome: "cancelled",
        }),
      ).toThrow(/terminal/);
      expect(() =>
        repo.appendModelStepEvent(
          runId,
          "model.step.failed",
          { step: 2, errorCode: "model_unavailable", durationMs: 1 },
          { now: T0 + 3 },
        ),
      ).toThrow(/terminal/);
      expect(repo.listModelCalls(runId).map((r) => r.step)).toEqual([1]);
    } finally {
      const { closeKernelDatabase } = await import("../src/index.js");
      closeKernelDatabase(handle);
    }
  });
});
