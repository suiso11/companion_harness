// M2 review r3943508127: frozen reference summaries and tool feedback expose
// only rN plus title. Canonical keys, UUIDs, paths, and connector identifiers
// never enter gateway messages; rN resolution still works via the internal map.
import { randomUUID } from "node:crypto";
import type {
  ChatRequest,
  ChatResult,
  ModelGateway,
  NormalizedToolCall,
} from "@companion/model-local";
import { describe, expect, it } from "vitest";
import {
  closeKernelDatabase,
  createAgentStrategy,
  createKernelRepository,
  createM1ToolRegistrations,
  createReferenceManager,
  createToolBroker,
  freezeStrategyContext,
  migrateKernelDatabase,
  openKernelDatabase,
  projectPrompt,
  sanitizeModelFacingForFeedback,
} from "../src/index.js";

const T0 = 1790000000000;
const UUID_RE =
  /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}/;

function toolCall(name: string, args: unknown, id: string): NormalizedToolCall {
  return { id, name, arguments: args };
}

function chatResult(toolCalls: NormalizedToolCall[], text = ""): ChatResult {
  return { text, toolCalls, stopReason: toolCalls.length > 0 ? "tool_calls" : "stop" };
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

describe("frozen summary exposes rN plus title only", () => {
  it("formats titled and untitled references without keys, UUIDs, or paths", () => {
    const req = projectPrompt({
      requestText: "q",
      history: [],
      references: [
        { ordinal: 1, title: "Doc A" },
        { ordinal: 2, title: null },
        { ordinal: 3, title: "" },
      ],
      tools: [],
      model: "m",
    });
    const current = req.messages[req.messages.length - 1] as { content: string };
    expect(current.content).toContain("- r1: Doc A");
    expect(current.content).toContain("- r2");
    expect(current.content).toContain("- r3");
    expect(current.content).not.toContain("canonical");
    expect(current.content).not.toContain("vault/");
    expect(current.content).not.toContain(".md");
    expect(current.content).not.toMatch(UUID_RE);
    expect(current.content).not.toContain("[");
  });
});

describe("feedback sanitizer drops keys and connector identifiers", () => {
  it("omits canonicalKey/snapshot/resource/connector ids, keeps rN and evidence", () => {
    const refId = randomUUID();
    const snapId = randomUUID();
    const resId = randomUUID();
    const connectorId = randomUUID();
    const out = sanitizeModelFacingForFeedback(
      {
        referenceId: refId,
        ordinal: 1,
        snapshotId: snapId,
        resourceId: resId,
        connectorInstanceId: connectorId,
        canonicalKey: "vault/secret.md",
        title: "Doc",
        snippet: "evidence",
        body: { version: 1, text: "full body" },
      },
      new Map([[refId, 1]]),
    ) as Record<string, unknown>;
    expect(out.referenceId).toBe("r1");
    expect(out.title).toBe("Doc");
    expect(out.snippet).toBe("evidence");
    expect(out).not.toHaveProperty("canonicalKey");
    expect(out).not.toHaveProperty("snapshotId");
    expect(out).not.toHaveProperty("resourceId");
    expect(out).not.toHaveProperty("connectorInstanceId");
    const blob = JSON.stringify(out);
    expect(blob).not.toContain("vault/secret.md");
    expect(blob).not.toContain(snapId);
    expect(blob).not.toContain(resId);
    expect(blob).not.toContain(connectorId);
    expect(blob).not.toContain(refId);
    // Skipped entries keep only the closed reason, never the path key.
    const skipped = sanitizeModelFacingForFeedback(
      { skipped: [{ canonicalKey: "vault/skip.md", reason: "file_too_large" }] },
      new Map(),
    ) as { skipped: Array<Record<string, unknown>> };
    expect(skipped.skipped[0]).toEqual({ reason: "file_too_large" });
    expect(JSON.stringify(skipped)).not.toContain("vault/skip.md");
  });
});

describe("end-to-end gateway secrecy with working rN resolution", () => {
  it("prompt and tool feedback carry rN only while open r1 resolves internally", async () => {
    const handle = openKernelDatabase(":memory:");
    await migrateKernelDatabase({ db: handle.raw });
    try {
      const repo = createKernelRepository(handle.raw);
      const referenceManager = createReferenceManager(handle.raw);
      const connectorInstanceId = randomUUID();
      handle.raw
        .prepare(
          "INSERT INTO connector_instances (id, kind, display_name, config_json, created_at) VALUES (?, 'markdown', 'vault', '{}', ?)",
        )
        .run(connectorInstanceId, T0);
      const regs = createM1ToolRegistrations({
        db: handle.raw,
        repo,
        referenceManager,
        bindings: [
          {
            connectorInstanceId,
            connector: {
              search: async () => ({ hits: [], skipped: [] }),
              readCanonical: async () => {
                throw new Error("unused");
              },
            },
          },
        ],
      });
      const broker = createToolBroker({ db: handle.raw, repo, registrations: regs });
      const sessionId = repo.createSession({ key: randomUUID(), now: T0 }).body.sessionId;
      const canonicalKey = "vault/a.md";
      const resId = randomUUID();
      const snapId = randomUUID();
      const refId = randomUUID();
      handle.raw
        .prepare(
          "INSERT INTO resources (id, connector_instance_id, canonical_key, title, next_revision, created_at) VALUES (?, ?, ?, ?, 2, ?)",
        )
        .run(resId, connectorInstanceId, canonicalKey, "Doc A", T0);
      handle.raw
        .prepare(
          "INSERT INTO resource_snapshots (id, resource_id, revision, source_revision, content_hash, body_json, size_bytes, observed_at, created_at) VALUES (?, ?, 1, 's1', ?, ?, ?, ?, ?)",
        )
        .run(
          snapId,
          resId,
          "a".repeat(64),
          JSON.stringify({ version: 1, text: "evidence body A" }),
          15,
          T0,
          T0,
        );
      handle.raw
        .prepare(
          "INSERT INTO session_references (id, session_id, ordinal, resource_id, snapshot_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(refId, sessionId, 1, resId, snapId, T0);
      repo.putReferenceContext(sessionId, { version: 1, items: [refId] }, { now: T0 + 1 });
      const posted = repo.postMessage(sessionId, { text: "open r1" }, { key: randomUUID(), now: T0 + 2 });
      const runId = posted.body.run.id;
      repo.startRun(runId, { now: T0 + 3 });
      const { gateway, calls } = scriptGateway([
        chatResult([toolCall("reference.open", { referenceId: "r1" }, "c0")]),
        chatResult([toolCall("answer.submit", { version: 1, parts: [{ text: "cited", citations: ["r1"] }] }, "a1")]),
      ]);
      const strategy = createAgentStrategy({ db: handle.raw, repo, broker, gateway, model: "m" });
      const run = repo.getRun(runId);
      const turn = repo.getTurn(run.turnId);
      const ctx = freezeStrategyContext(
        { id: run.id, turnId: run.turnId, sessionId: run.sessionId, attempt: run.attempt, strategy: run.strategy },
        { id: turn.id, sessionId: turn.sessionId, seq: turn.seq, input: turn.input, frozenContext: turn.frozenContext },
        new AbortController().signal,
      );
      await expect(strategy(ctx)).resolves.toEqual({
        version: 2,
        text: "cited",
        answer: { version: 1, parts: [{ text: "cited", citations: ["r1"] }] },
      });
      // Internal rN->UUID translation worked: full grant on the real UUID.
      const grants = repo.listEvidenceGrants(runId);
      expect(grants).toHaveLength(1);
      expect(grants[0]?.referenceId).toBe(refId);
      // Every gateway message is free of keys, UUIDs, paths, connector ids.
      for (const request of calls) {
        const blob = request.messages.map((m) => m.content).join("\n");
        expect(blob).toContain("r1");
        expect(blob).not.toContain(canonicalKey);
        expect(blob).not.toContain("vault/");
        expect(blob).not.toContain(refId);
        expect(blob).not.toContain(resId);
        expect(blob).not.toContain(snapId);
        expect(blob).not.toContain(connectorInstanceId);
        expect(blob).not.toMatch(UUID_RE);
      }
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
