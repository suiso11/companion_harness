// M2 kernel review fixes: related no-grant, per-call tool messages,
// bounded history projection, wall budget around tool phases.
import type {
  ChatRequest,
  ChatResult,
  ModelGateway,
  NormalizedToolCall,
} from "@companion/model-local";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AGENT_MAX_HISTORY_ITEMS,
  closeKernelDatabase,
  createAgentStrategy,
  createKernelRepository,
  createToolBroker,
  extractGrantCandidates,
  freezeStrategyContext,
  type KernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
  projectPrompt,
  type ToolBroker,
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
function readReg(overrides?: {
  name?: string;
  handler?: ToolRegistration["handler"];
  normalize?: ToolRegistration["normalize"];
}): ToolRegistration {
  return {
    descriptor: {
      name: overrides?.name ?? "test.read",
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
    handler: overrides?.handler ?? (async () => ({ text: "ok" })),
    ...(overrides?.normalize === undefined
      ? {}
      : { normalize: overrides.normalize }),
  };
}
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
function ctxFor(repo: KernelRepository, runId: string, signal?: AbortSignal) {
  const run = repo.getRun(runId);
  const turn = repo.getTurn(run.turnId);
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
    signal ?? new AbortController().signal,
  );
}

describe("related listings never grant", () => {
  it("reference.related title-only output creates no EvidenceGrant", async () => {
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
      const relatedLike = {
        references: [
          {
            referenceId: refId,
            ordinal: 1,
            snapshotId: crypto.randomUUID(),
            resourceId: crypto.randomUUID(),
            canonicalKey: "vault/doc-1.md",
            title: "Doc 1",
          },
        ],
      };
      // Unit: title/canonicalKey-only listing yields no candidates.
      expect(extractGrantCandidates(relatedLike)).toEqual([]);
      expect(extractGrantCandidates({ referenceId: refId })).toEqual([]);
      const broker: ToolBroker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [
          readReg({
            name: "test.related",
            normalize: (raw) => ({
              normalized: raw,
              observations: 1,
              modelFacing: raw,
            }),
            handler: async () => relatedLike,
          }),
        ],
      });
      const { gateway } = scriptGateway([
        chatResult([toolCall("test.related", {}, "c0")]),
        chatResult([answerCall([{ text: "done", citations: [] }])]),
      ]);
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway,
        model: "m",
      });
      await expect(strategy(ctxFor(repo, runId))).resolves.toEqual({
        version: 2,
        text: "done",
        answer: { version: 1, parts: [{ text: "done", citations: [] }] },
      });
      expect(repo.listEvidenceGrants(runId)).toEqual([]);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("snippet grants snippet and body upgrades to full (never from id alone)", async () => {
    const ref = crypto.randomUUID();
    expect(
      extractGrantCandidates({ hits: [{ referenceId: ref, snippet: "snip" }] }),
    ).toEqual([{ referenceId: ref, exposure: "snippet" }]);
    expect(
      extractGrantCandidates({
        referenceId: ref,
        snippet: "s",
        body: { version: 1, text: "" },
      }),
    ).toEqual([{ referenceId: ref, exposure: "full" }]);
    expect(
      extractGrantCandidates({ hits: [{ referenceId: ref, title: "t" }] }),
    ).toEqual([]);
  });
});

describe("per-call tool feedback mapping", () => {
  it("emits one role:tool message per call with matching ids in order", async () => {
    const { handle, repo } = await setup();
    try {
      const broker: ToolBroker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [readReg()],
      });
      const ordinary = [
        toolCall("test.read", { q: "a" }, "c0"),
        toolCall("test.read", { q: "b" }, "c1"),
        toolCall("test.read", { q: "c" }, "c2"),
      ];
      const { gateway, calls } = scriptGateway([
        chatResult(ordinary, "help"),
        chatResult([answerCall([{ text: "done", citations: [] }])]),
      ]);
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway,
        model: "m",
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
      await expect(strategy(ctxFor(repo, runId))).resolves.toEqual({
        version: 2,
        text: "done",
        answer: { version: 1, parts: [{ text: "done", citations: [] }] },
      });
      const replayed = calls[1]?.messages ?? [];
      const assistantIdx = replayed.findIndex(
        (m) =>
          m.role === "assistant" &&
          Array.isArray(m.toolCalls) &&
          m.toolCalls.length === 3,
      );
      expect(assistantIdx).toBeGreaterThanOrEqual(0);
      const tools = replayed.filter((m) => m.role === "tool");
      expect(tools).toHaveLength(3);
      expect(tools.map((m) => m.toolCallId)).toEqual(["c0", "c1", "c2"]);
      // Order equals request order and each id matches its assistant call.
      const assistant = replayed[assistantIdx] as {
        toolCalls: NormalizedToolCall[];
      };
      expect(tools.map((m) => m.toolCallId)).toEqual(
        assistant.toolCalls.map((c) => c.id),
      );
      for (const [i, m] of tools.entries()) {
        expect(replayed.indexOf(m)).toBeGreaterThan(assistantIdx);
        const body = JSON.parse((m as { content: string }).content) as {
          ok: boolean;
        };
        expect(body.ok).toBe(true);
        void i;
      }
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

describe("bounded selected-completed history projection", () => {
  it("projectPrompt caps oversized history to the latest entries within 128 messages", () => {
    const history = Array.from({ length: 200 }, (_, i) => ({
      turnSeq: i + 1,
      requestText: `q${i + 1}`,
      resultText: `r${i + 1}`,
    }));
    const req = projectPrompt({
      requestText: "now",
      history,
      references: [],
      tools: [],
      model: "m",
    });
    expect(req.messages.length).toBeLessThanOrEqual(128);
    expect(AGENT_MAX_HISTORY_ITEMS).toBe(63);
    const contents = req.messages.map((m) => m.content).join("\n");
    expect(contents).toContain("q200");
    expect(contents).not.toContain("q1\n");
  });

  it("end-to-end history stays selected-completed, latest-first, and within cap", async () => {
    const { handle, repo } = await setup();
    try {
      const broker: ToolBroker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [],
      });
      const sessionId = repo.createSession({
        key: crypto.randomUUID(),
        now: T0,
      }).body.sessionId;
      // Build 80 selected-completed turns plus one unselected failed turn.
      for (let i = 0; i < 80; i += 1) {
        const posted = repo.postMessage(
          sessionId,
          { text: `history-q${i}` },
          { key: crypto.randomUUID(), now: T0 + i },
        );
        repo.startRun(posted.body.run.id, { now: T0 + i });
        repo.completeRun(
          posted.body.run.id,
          { version: 1, text: `history-r${i}` },
          { now: T0 + i },
        );
      }
      const failed = repo.postMessage(
        sessionId,
        { text: "failed-q" },
        { key: crypto.randomUUID(), now: T0 + 1000 },
      );
      repo.startRun(failed.body.run.id, { now: T0 + 1001 });
      repo.failRun(failed.body.run.id, "execution_failed", { now: T0 + 1002 });
      const posted = repo.postMessage(
        sessionId,
        { text: "current" },
        { key: crypto.randomUUID(), now: T0 + 2000 },
      );
      const runId = posted.body.run.id;
      repo.startRun(runId, { now: T0 + 2001 });
      const { gateway, calls } = scriptGateway([
        chatResult([answerCall([{ text: "done", citations: [] }])]),
      ]);
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway,
        model: "m",
      });
      await expect(strategy(ctxFor(repo, runId))).resolves.toEqual({
        version: 2,
        text: "done",
        answer: { version: 1, parts: [{ text: "done", citations: [] }] },
      });
      const messages = calls[0]?.messages ?? [];
      expect(messages.length).toBeLessThanOrEqual(128);
      const blob = messages.map((m) => m.content).join("\n");
      expect(blob).toContain("history-q79");
      expect(blob).not.toContain("failed-q");
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

describe("wall budget around tool phases", () => {
  it("fails when tools consume the wall budget (expiry after tools)", async () => {
    const { handle, repo } = await setup();
    try {
      let now = T0;
      const clock = { now: () => now };
      const broker: ToolBroker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [
          readReg({
            handler: async () => {
              now += 2000;
              return { text: "late" };
            },
          }),
        ],
      });
      const { gateway } = scriptGateway([
        chatResult([toolCall("test.read", { q: "a" }, "c0")]),
        chatResult([answerCall([{ text: "done", citations: [] }])]),
      ]);
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway,
        model: "m",
        clock,
        wallMs: 1000,
        stepTimeoutMs: 10_000,
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
      await expect(strategy(ctxFor(repo, runId))).rejects.toMatchObject({
        name: "StrategyError",
        errorCode: "execution_failed",
      });
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("fails when a hanging tool exceeds the remaining wall budget (expiry during tools)", async () => {
    const { handle, repo } = await setup();
    try {
      const broker: ToolBroker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [
          readReg({
            handler: async () => new Promise<{ text: string }>(() => {}),
          }),
        ],
      });
      const { gateway, calls } = scriptGateway([
        chatResult([toolCall("test.read", { q: "a" }, "c0")]),
        chatResult([answerCall([{ text: "done", citations: [] }])]),
      ]);
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway,
        model: "m",
        wallMs: 30,
        stepTimeoutMs: 10_000,
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
      await expect(strategy(ctxFor(repo, runId))).rejects.toMatchObject({
        name: "StrategyError",
        errorCode: "execution_failed",
      });
      // No second model step after wall expiry inside the tool phase.
      expect(calls.length).toBe(1);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
