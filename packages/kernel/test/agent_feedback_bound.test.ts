// Exact boundary: fully framed role:tool feedback vs gateway per-message limit.
import type {
  ChatRequest,
  ChatResult,
  ModelGateway,
  NormalizedToolCall,
} from "@companion/model-local";
import { MAX_MESSAGE_CONTENT_LENGTH } from "@companion/model-local";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  buildOversizedToolFeedbackContent,
  buildToolFeedbackContent,
  closeKernelDatabase,
  createAgentStrategy,
  createKernelRepository,
  createToolBroker,
  freezeStrategyContext,
  isToolFeedbackOversized,
  type KernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
  type ToolBroker,
  type ToolRegistration,
} from "../src/index.js";

const T0 = 1790000000000;
const TOOL = "test.read";

function toolCall(id: string): NormalizedToolCall {
  return { id, name: TOOL, arguments: {} };
}
function answerCall(): NormalizedToolCall {
  return {
    id: "answer-1",
    name: "answer.submit",
    arguments: { version: 1, parts: [{ text: "done", citations: [] }] },
  };
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
function ctxFor(repo: KernelRepository, runId: string) {
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
    new AbortController().signal,
  );
}
function makeBroker(
  handle: ReturnType<typeof openKernelDatabase>,
  repo: KernelRepository,
  modelFacingForCall: (refId: string, text: string) => unknown,
  refId: string,
  text: string,
): ToolBroker {
  const reg: ToolRegistration = {
    descriptor: {
      name: TOOL,
      version: 1,
      title: "t",
      description: "d",
      category: "read",
      defaultTimeoutMs: 5000,
      maxTimeoutMs: 10_000,
      supportsRefresh: true,
    },
    inputSchema: { parse: (v: unknown) => v },
    outputSchema: { parse: (v: unknown) => v },
    handler: async () => ({ marker: "raw-handler" }),
    normalize: () => ({
      normalized: { marker: "n" },
      observations: 1,
      modelFacing: modelFacingForCall(refId, text),
    }),
  };
  return createToolBroker({ db: handle.raw, repo, registrations: [reg] });
}
/** Text length so the fully framed feedback is exactly `target` chars. */
function textLenForTarget(refId: string, target: number, suffix = ""): number {
  const base = buildToolFeedbackContent(TOOL, true, null, {
    referenceId: refId,
    body: { version: 1, text: "" },
  }).length;
  return target - base - suffix.length;
}
function toolRows(db: Database.Database, runId: string) {
  return db
    .prepare(
      "SELECT actual_outcome, result_disposition, error_code FROM tool_calls WHERE run_id = ? ORDER BY call_index ASC",
    )
    .all(runId) as Array<{
    actual_outcome: string;
    result_disposition: string;
    error_code: string | null;
  }>;
}

describe("framed role:tool boundary (gateway .length semantics)", () => {
  it("measures the final framed content: fit at LIMIT passes, LIMIT+1 omits", () => {
    const refId = crypto.randomUUID();
    const fitLen = textLenForTarget(refId, MAX_MESSAGE_CONTENT_LENGTH);
    const fit = buildToolFeedbackContent(TOOL, true, null, {
      referenceId: refId,
      body: { version: 1, text: "x".repeat(fitLen) },
    });
    expect(fit.length).toBe(MAX_MESSAGE_CONTENT_LENGTH);
    expect(isToolFeedbackOversized(fit)).toBe(false);
    const over = buildToolFeedbackContent(TOOL, true, null, {
      referenceId: refId,
      body: { version: 1, text: `x`.repeat(fitLen + 1) },
    });
    expect(over.length).toBe(MAX_MESSAGE_CONTENT_LENGTH + 1);
    expect(isToolFeedbackOversized(over)).toBe(true);
    const compact = buildOversizedToolFeedbackContent(TOOL);
    expect(compact.length).toBeLessThanOrEqual(MAX_MESSAGE_CONTENT_LENGTH);
    expect(JSON.parse(compact)).toEqual({
      tool: TOOL,
      ok: false,
      errorCode: "output_too_large",
      output: null,
    });
  });

  it("multibyte counts with .length semantics: one char over still omits", () => {
    const refId = crypto.randomUUID();
    const fitLen = textLenForTarget(refId, MAX_MESSAGE_CONTENT_LENGTH);
    // Fit with ascii, then cross by exactly one multibyte char (length +1).
    const fitText = "x".repeat(fitLen);
    const fit = buildToolFeedbackContent(TOOL, true, null, {
      referenceId: refId,
      body: { version: 1, text: fitText },
    });
    expect(fit.length).toBe(MAX_MESSAGE_CONTENT_LENGTH);
    const overText = `${"x".repeat(fitLen - 1)}あ`;
    // Same .length as fit would fit; appending one more multibyte tips over.
    const over = buildToolFeedbackContent(TOOL, true, null, {
      referenceId: refId,
      body: { version: 1, text: `${overText}x` },
    });
    expect(over.length).toBe(MAX_MESSAGE_CONTENT_LENGTH + 1);
    expect(isToolFeedbackOversized(over)).toBe(true);
    // Surrogate pair counts as 2 per gateway validation (UTF-16 units).
    expect("😀".length).toBe(2);
    expect(
      isToolFeedbackOversized(
        `${"y".repeat(MAX_MESSAGE_CONTENT_LENGTH - 1)}😀`,
      ),
    ).toBe(true);
  });

  it("fit delivers verbatim with full grant; broker audit stays accepted", async () => {
    const { handle, repo } = await setup();
    try {
      const sessionId = repo.createSession({
        key: crypto.randomUUID(),
        now: T0,
      }).body.sessionId;
      const refId = insertReference(handle.raw, sessionId, 1, T0);
      // Model feedback carries the UUID-free rN projection (referenceId
      // UUID -> "r1"), so size the payload against the projected framing.
      const fitLen = textLenForTarget("r1", MAX_MESSAGE_CONTENT_LENGTH);
      const broker = makeBroker(
        handle,
        repo,
        (id, text) => ({ referenceId: id, body: { version: 1, text } }),
        refId,
        "x".repeat(fitLen),
      );
      const { gateway, calls } = scriptGateway([
        chatResult([toolCall("c-fit")]),
        chatResult([answerCall()]),
      ]);
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway,
        model: "m",
      });
      const posted = repo.postMessage(
        sessionId,
        { text: "q" },
        { key: crypto.randomUUID(), now: T0 + 1 },
      );
      const runId = posted.body.run.id;
      repo.startRun(runId, { now: T0 + 2 });
      await expect(strategy(ctxFor(repo, runId))).resolves.toEqual({
        version: 2,
        text: "done",
        answer: { version: 1, parts: [{ text: "done", citations: [] }] },
      });
      const tools = (calls[1]?.messages ?? []).filter((m) => m.role === "tool");
      expect(tools).toHaveLength(1);
      expect(tools[0]?.toolCallId).toBe("c-fit");
      const content = (tools[0] as { content: string }).content;
      expect(content.length).toBe(MAX_MESSAGE_CONTENT_LENGTH);
      expect(JSON.parse(content).output.body.text).toBe("x".repeat(fitLen));
      // UUID-free feedback: model sees r1, never the hidden UUID.
      expect(JSON.parse(content).output.referenceId).toBe("r1");
      expect(content).not.toContain(refId);
      // Full exposure granted for delivered content.
      expect(
        repo.listEvidenceGrants(runId).map((g) => [g.referenceId, g.exposure]),
      ).toEqual([[refId, "full"]]);
      // Broker accounting unchanged: still accepted/succeeded.
      expect(toolRows(handle.raw, runId)).toEqual([
        {
          actual_outcome: "succeeded",
          result_disposition: "accepted",
          error_code: null,
        },
      ]);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("oversize by one omits payload: compact output_too_large, no grant, next step proceeds", async () => {
    const { handle, repo } = await setup();
    try {
      const sessionId = repo.createSession({
        key: crypto.randomUUID(),
        now: T0,
      }).body.sessionId;
      const refId = insertReference(handle.raw, sessionId, 1, T0);
      // Size against the UUID-free rN projection (see fit test above).
      const fitLen = textLenForTarget("r1", MAX_MESSAGE_CONTENT_LENGTH);
      const broker = makeBroker(
        handle,
        repo,
        (id, text) => ({ referenceId: id, body: { version: 1, text } }),
        refId,
        "x".repeat(fitLen + 1),
      );
      const { gateway, calls } = scriptGateway([
        chatResult([toolCall("c-over")]),
        chatResult([answerCall()]),
      ]);
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway,
        model: "m",
      });
      const posted = repo.postMessage(
        sessionId,
        { text: "q" },
        { key: crypto.randomUUID(), now: T0 + 1 },
      );
      const runId = posted.body.run.id;
      repo.startRun(runId, { now: T0 + 2 });
      await expect(strategy(ctxFor(repo, runId))).resolves.toEqual({
        version: 2,
        text: "done",
        answer: { version: 1, parts: [{ text: "done", citations: [] }] },
      });
      const tools = (calls[1]?.messages ?? []).filter((m) => m.role === "tool");
      expect(tools).toHaveLength(1);
      expect(tools[0]?.toolCallId).toBe("c-over");
      const content = (tools[0] as { content: string }).content;
      expect(content.length).toBeLessThanOrEqual(MAX_MESSAGE_CONTENT_LENGTH);
      expect(JSON.parse(content)).toEqual({
        tool: TOOL,
        ok: false,
        errorCode: "output_too_large",
        output: null,
      });
      // No silent truncation and no raw payload leaked.
      expect(content).not.toContain("x".repeat(32));
      expect(content).not.toContain(refId);
      // Omitted content creates no grant.
      expect(repo.listEvidenceGrants(runId)).toEqual([]);
      // Broker still accepted the call; only the model replay was substituted.
      expect(toolRows(handle.raw, runId)).toEqual([
        {
          actual_outcome: "succeeded",
          result_disposition: "accepted",
          error_code: null,
        },
      ]);
      // Next model step proceeded (exactly two gateway calls).
      expect(calls).toHaveLength(2);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("multibyte oversize omits with no grant and no raw multibyte leak", async () => {
    const { handle, repo } = await setup();
    try {
      const sessionId = repo.createSession({
        key: crypto.randomUUID(),
        now: T0,
      }).body.sessionId;
      const refId = insertReference(handle.raw, sessionId, 1, T0);
      // Size against the UUID-free rN projection (see fit test above).
      const fitLen = textLenForTarget("r1", MAX_MESSAGE_CONTENT_LENGTH);
      const multiText = `${"x".repeat(fitLen - 1)}あx`;
      // Unit check against the projected rN framing the model actually sees.
      const framed = buildToolFeedbackContent(TOOL, true, null, {
        referenceId: "r1",
        body: { version: 1, text: multiText },
      });
      expect(framed.length).toBe(MAX_MESSAGE_CONTENT_LENGTH + 1);
      const broker = makeBroker(
        handle,
        repo,
        (id, text) => ({ referenceId: id, body: { version: 1, text } }),
        refId,
        multiText,
      );
      const { gateway, calls } = scriptGateway([
        chatResult([toolCall("c-multi")]),
        chatResult([answerCall()]),
      ]);
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway,
        model: "m",
      });
      const posted = repo.postMessage(
        sessionId,
        { text: "q" },
        { key: crypto.randomUUID(), now: T0 + 1 },
      );
      const runId = posted.body.run.id;
      repo.startRun(runId, { now: T0 + 2 });
      await expect(strategy(ctxFor(repo, runId))).resolves.toEqual({
        version: 2,
        text: "done",
        answer: { version: 1, parts: [{ text: "done", citations: [] }] },
      });
      const tools = (calls[1]?.messages ?? []).filter((m) => m.role === "tool");
      expect(tools).toHaveLength(1);
      const content = (tools[0] as { content: string }).content;
      expect(JSON.parse(content)).toEqual({
        tool: TOOL,
        ok: false,
        errorCode: "output_too_large",
        output: null,
      });
      expect(content).not.toContain("あ");
      expect(content).not.toContain("x".repeat(32));
      expect(repo.listEvidenceGrants(runId)).toEqual([]);
      expect(calls).toHaveLength(2);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
