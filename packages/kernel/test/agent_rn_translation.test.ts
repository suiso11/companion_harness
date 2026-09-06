// M2 rN translation (PR #4 r3943430520): model-facing `referenceId` for
// `reference.open` / `reference.refresh` / `reference.related` is an `rN`
// identifier (frozen context exposes only `rN`). The strategy translates a
// valid current frozen-context `rN` to its UUID immediately before the
// ToolBroker call. Unknown / malformed / out-of-context `rN` (and smuggled
// raw UUIDs) fail safely through the ordinary ToolBroker policy/budget path
// with no UUID leak. Every model-caused ordinary call traverses ToolBroker
// and consumes its normal budget. Model feedback is UUID-free (`rN` only).
import { randomUUID } from "node:crypto";
import type {
  ChatRequest,
  ChatResult,
  ModelGateway,
  NormalizedToolCall,
} from "@companion/model-local";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  AGENT_RN_PATTERN,
  closeKernelDatabase,
  createAgentStrategy,
  createKernelRepository,
  createM1ToolRegistrations,
  createReferenceManager,
  createToolBroker,
  freezeStrategyContext,
  type KernelRepository,
  type ToolBroker,
  migrateKernelDatabase,
  openKernelDatabase,
} from "../src/index.js";

const T0 = 1790000000000;
const UUID_RE =
  /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}/;

function toolCall(
  name: string,
  args: unknown,
  id: string,
): NormalizedToolCall {
  return { id, name, arguments: args };
}

function answerCall(
  parts = [{ text: "done", citations: [] as string[] }],
  id = "answer-1",
): NormalizedToolCall {
  return toolCall("answer.submit", { version: 1, parts }, id);
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

interface M1Setup {
  handle: ReturnType<typeof openKernelDatabase>;
  repo: KernelRepository;
  broker: ToolBroker;
  connectorInstanceId: string;
  readCalls: string[];
  docs: Map<string, { title: string; text: string; sourceRevision: string }>;
}

async function setupM1(): Promise<M1Setup> {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  const repo = createKernelRepository(handle.raw);
  const referenceManager = createReferenceManager(handle.raw);
  const connectorInstanceId = randomUUID();
  handle.raw
    .prepare(
      "INSERT INTO connector_instances (id, kind, display_name, config_json, created_at) VALUES (?, 'markdown', 'vault', '{}', ?)",
    )
    .run(connectorInstanceId, T0);
  const docs = new Map<
    string,
    { title: string; text: string; sourceRevision: string }
  >();
  const readCalls: string[] = [];
  const stubPort = {
    search: async () => ({ hits: [], skipped: [] }),
    readCanonical: async (canonicalKey: string) => {
      readCalls.push(canonicalKey);
      const doc = docs.get(canonicalKey) ?? {
        title: `Title ${canonicalKey}`,
        text: `refreshed body for ${canonicalKey}`,
        sourceRevision: "rev-refresh-1",
      };
      return {
        canonicalKey,
        title: doc.title,
        text: doc.text,
        sourceRevision: doc.sourceRevision,
        snippet: doc.text.slice(0, 32),
        standardLinks: [],
        wikiLinks: [],
      };
    },
  };
  const regs = createM1ToolRegistrations({
    db: handle.raw,
    repo,
    referenceManager,
    bindings: [{ connectorInstanceId, connector: stubPort }],
  });
  const broker = createToolBroker({
    db: handle.raw,
    repo,
    registrations: regs,
  });
  return { handle, repo, broker, connectorInstanceId, readCalls, docs };
}

function insertReference(
  db: Database.Database,
  connectorInstanceId: string,
  sessionId: string,
  ordinal: number,
  canonicalKey: string,
  title: string,
  text: string,
  now: number,
): { refId: string; snapId: string; resId: string } {
  const resId = randomUUID();
  const snapId = randomUUID();
  const refId = randomUUID();
  db.prepare(
    "INSERT INTO resources (id, connector_instance_id, canonical_key, title, next_revision, created_at) VALUES (?, ?, ?, ?, 2, ?)",
  ).run(resId, connectorInstanceId, canonicalKey, title, now);
  db.prepare(
    "INSERT INTO resource_snapshots (id, resource_id, revision, source_revision, content_hash, body_json, size_bytes, observed_at, created_at) VALUES (?, ?, 1, 's1', ?, ?, ?, ?, ?)",
  ).run(
    snapId,
    resId,
    "a".repeat(64),
    JSON.stringify({ version: 1, text }),
    Buffer.byteLength(text, "utf8"),
    now,
    now,
  );
  db.prepare(
    "INSERT INTO session_references (id, session_id, ordinal, resource_id, snapshot_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(refId, sessionId, ordinal, resId, snapId, now);
  // Keep the session rN allocator ahead of direct test inserts so later
  // refresh/materialization allocates a fresh ordinal (no UNIQUE clash).
  const cur = db
    .prepare("SELECT next_reference_ordinal FROM sessions WHERE id = ?")
    .get(sessionId) as { next_reference_ordinal: number } | undefined;
  if (cur !== undefined && cur.next_reference_ordinal <= ordinal) {
    db.prepare("UPDATE sessions SET next_reference_ordinal = ? WHERE id = ?").run(
      ordinal + 1,
      sessionId,
    );
  }
  return { refId, snapId, resId };
}

function freezeTurn(
  sessionId: string,
  frozenRefIds: string[],
  text: string,
  repo: KernelRepository,
  now: number,
): string {
  // putReferenceContext expects the CURRENT version; fresh sessions start at 1.
  repo.putReferenceContext(
    sessionId,
    { version: 1, items: frozenRefIds },
    { now },
  );
  const posted = repo.postMessage(
    sessionId,
    { text },
    { key: randomUUID(), now: now + 1 },
  );
  const runId = posted.body.run.id;
  repo.startRun(runId, { now: now + 2 });
  return runId;
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

function toolFeedbacks(calls: ChatRequest[]): Array<{
  toolCallId: string | undefined;
  body: { tool: string; ok: boolean; errorCode: string | null; output: unknown };
  raw: string;
}> {
  const out: Array<{
    toolCallId: string | undefined;
    body: {
      tool: string;
      ok: boolean;
      errorCode: string | null;
      output: unknown;
    };
    raw: string;
  }> = [];
  for (const request of calls) {
    for (const message of request.messages) {
      if (message.role === "tool") {
        const raw = (message as { content: string }).content;
        out.push({
          toolCallId: (message as { toolCallId?: string }).toolCallId,
          body: JSON.parse(raw) as {
            tool: string;
            ok: boolean;
            errorCode: string | null;
            output: unknown;
          },
          raw,
        });
      }
    }
  }
  return out;
}

function toolRequestsUsed(db: Database.Database, runId: string): number {
  const row = db
    .prepare("SELECT tool_requests_used FROM runs WHERE id = ?")
    .get(runId) as { tool_requests_used: number };
  return row.tool_requests_used;
}

describe("advertised reference schemas use rN", () => {
  it("advertises ^r[1-9][0-9]*$ for all three reference tools", async () => {
    const setup = await setupM1();
    try {
      expect(AGENT_RN_PATTERN).toBe("^r[1-9][0-9]*$");
      const tools = setup.broker
        .describeTools()
        .map((d) => d.name);
      expect(tools).toEqual([
        "markdown.search",
        "reference.open",
        "reference.refresh",
        "reference.related",
      ]);
    } finally {
      closeKernelDatabase(setup.handle);
    }
  });
});

describe("rN translation end-to-end (open / refresh / related)", () => {
  it("reference.open r1 succeeds with UUID-free rN feedback and full grant", async () => {
    const setup = await setupM1();
    const { handle, repo, broker, connectorInstanceId } = setup;
    try {
      const sessionId = repo.createSession({ key: randomUUID(), now: T0 }).body
        .sessionId;
      const a = insertReference(
        handle.raw,
        connectorInstanceId,
        sessionId,
        1,
        "vault/a.md",
        "Doc A",
        "evidence body A",
        T0,
      );
      const runId = freezeTurn(sessionId, [a.refId], "open r1", repo, T0 + 10);
      const { gateway, calls } = scriptGateway([
        chatResult([toolCall("reference.open", { referenceId: "r1" }, "c0")]),
        chatResult([answerCall([{ text: "cited A", citations: ["r1"] }])]),
      ]);
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway,
        model: "m",
      });
      await expect(strategy(ctxFor(repo, runId))).resolves.toEqual({
        version: 1,
        text: "cited A",
      });
      const feedbacks = toolFeedbacks(calls);
      expect(feedbacks).toHaveLength(1);
      expect(feedbacks[0]?.body.tool).toBe("reference.open");
      expect(feedbacks[0]?.body.ok).toBe(true);
      const output = feedbacks[0]?.body.output as Record<string, unknown>;
      expect(output.referenceId).toBe("r1");
      expect(output).not.toHaveProperty("snapshotId");
      expect(output).not.toHaveProperty("resourceId");
      expect(feedbacks[0]?.raw).not.toMatch(UUID_RE);
      expect(feedbacks[0]?.raw).not.toContain(a.refId);
      // Budget consumed exactly once through the ordinary broker path.
      expect(toolRequestsUsed(handle.raw, runId)).toBe(1);
      // Full exposure grant (stored body delivered) on the real UUID.
      const grants = repo.listEvidenceGrants(runId);
      expect(grants).toHaveLength(1);
      expect(grants[0]?.referenceId).toBe(a.refId);
      expect(grants[0]?.exposure).toBe("full");
      // Prompt projection never leaks UUIDs either.
      const promptBlob = (calls[0]?.messages ?? [])
        .map((m) => m.content)
        .join("\n");
      expect(promptBlob).toContain("r1");
      expect(promptBlob).not.toMatch(UUID_RE);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("reference.refresh r1 rereads and grants full on the new rN without UUID leak", async () => {
    const setup = await setupM1();
    const { handle, repo, broker, connectorInstanceId, docs } = setup;
    try {
      const sessionId = repo.createSession({ key: randomUUID(), now: T0 }).body
        .sessionId;
      const a = insertReference(
        handle.raw,
        connectorInstanceId,
        sessionId,
        1,
        "vault/a.md",
        "Doc A",
        "original body A",
        T0,
      );
      docs.set("vault/a.md", {
        title: "Doc A",
        text: "refreshed body A v2",
        sourceRevision: "rev-2",
      });
      const runId = freezeTurn(sessionId, [a.refId], "refresh r1", repo, T0 + 10);
      const { gateway, calls } = scriptGateway([
        chatResult([toolCall("reference.refresh", { referenceId: "r1" }, "c0")]),
        chatResult([answerCall([{ text: "after refresh", citations: [] }])]),
      ]);
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway,
        model: "m",
      });
      await expect(strategy(ctxFor(repo, runId))).resolves.toEqual({
        version: 1,
        text: "after refresh",
      });
      expect(setup.readCalls).toEqual(["vault/a.md"]);
      const feedbacks = toolFeedbacks(calls);
      expect(feedbacks).toHaveLength(1);
      expect(feedbacks[0]?.body.ok).toBe(true);
      const output = feedbacks[0]?.body.output as Record<string, unknown>;
      // Refresh always materializes a new Snapshot+rN (ordinal 2 here).
      expect(output.referenceId).toBe("r2");
      expect(output).not.toHaveProperty("snapshotId");
      expect(feedbacks[0]?.raw).not.toMatch(UUID_RE);
      expect(toolRequestsUsed(handle.raw, runId)).toBe(1);
      const grants = repo.listEvidenceGrants(runId);
      expect(grants).toHaveLength(1);
      expect(grants[0]?.exposure).toBe("full");
      // The granted UUID is the NEW reference, not the frozen one.
      expect(grants[0]?.referenceId).not.toBe(a.refId);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("reference.related r1 returns rN neighbors with no grant and no UUID leak", async () => {
    const setup = await setupM1();
    const { handle, repo, broker, connectorInstanceId } = setup;
    try {
      const sessionId = repo.createSession({ key: randomUUID(), now: T0 }).body
        .sessionId;
      const a = insertReference(
        handle.raw,
        connectorInstanceId,
        sessionId,
        1,
        "vault/a.md",
        "Doc A",
        "body A",
        T0,
      );
      const b = insertReference(
        handle.raw,
        connectorInstanceId,
        sessionId,
        2,
        "vault/b.md",
        "Doc B",
        "body B",
        T0,
      );
      // Stored outgoing link: snapshot A resolved -> resource B.
      handle.raw
        .prepare(
          "INSERT INTO snapshot_links (source_snapshot_id, ordinal, kind, status, target_resource_id, candidates_json) VALUES (?, 1, 'standard', 'resolved', ?, ?)",
        )
        .run(a.snapId, b.resId, JSON.stringify(["vault/b.md"]));
      const runId = freezeTurn(
        sessionId,
        [a.refId, b.refId],
        "related r1",
        repo,
        T0 + 10,
      );
      const { gateway, calls } = scriptGateway([
        chatResult([
          toolCall("reference.related", { referenceId: "r1" }, "c0"),
        ]),
        chatResult([answerCall([{ text: "neighbors", citations: [] }])]),
      ]);
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway,
        model: "m",
      });
      await expect(strategy(ctxFor(repo, runId))).resolves.toEqual({
        version: 1,
        text: "neighbors",
      });
      const feedbacks = toolFeedbacks(calls);
      expect(feedbacks).toHaveLength(1);
      expect(feedbacks[0]?.body.ok).toBe(true);
      const output = feedbacks[0]?.body.output as {
        references: Array<Record<string, unknown>>;
      };
      expect(output.references).toHaveLength(1);
      expect(output.references[0]?.referenceId).toBe("r2");
      expect(output.references[0]).not.toHaveProperty("snapshotId");
      expect(feedbacks[0]?.raw).not.toMatch(UUID_RE);
      expect(toolRequestsUsed(handle.raw, runId)).toBe(1);
      // Title-only related listings never grant.
      expect(repo.listEvidenceGrants(runId)).toEqual([]);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

describe("rN failure isolation (unknown / malformed / out-of-context / UUID smuggling)", () => {
  it("unknown r999 fails through the broker budget path with no grant and no UUID leak", async () => {
    const setup = await setupM1();
    const { handle, repo, broker, connectorInstanceId } = setup;
    try {
      const sessionId = repo.createSession({ key: randomUUID(), now: T0 }).body
        .sessionId;
      const a = insertReference(
        handle.raw,
        connectorInstanceId,
        sessionId,
        1,
        "vault/a.md",
        "Doc A",
        "body A",
        T0,
      );
      const runId = freezeTurn(sessionId, [a.refId], "unknown", repo, T0 + 10);
      const { gateway, calls } = scriptGateway([
        chatResult([toolCall("reference.open", { referenceId: "r999" }, "c0")]),
        chatResult([answerCall([{ text: "recovered", citations: [] }])]),
      ]);
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway,
        model: "m",
      });
      await expect(strategy(ctxFor(repo, runId))).resolves.toEqual({
        version: 1,
        text: "recovered",
      });
      const feedbacks = toolFeedbacks(calls);
      expect(feedbacks).toHaveLength(1);
      expect(feedbacks[0]?.body.ok).toBe(false);
      expect(feedbacks[0]?.body.output).toBeNull();
      expect(feedbacks[0]?.raw).not.toMatch(UUID_RE);
      expect(feedbacks[0]?.raw).not.toContain(a.refId);
      // Ordinary broker budget consumed even for the failure.
      expect(toolRequestsUsed(handle.raw, runId)).toBe(1);
      expect(repo.listEvidenceGrants(runId)).toEqual([]);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("malformed rN and smuggled raw UUIDs fail safely; smuggled real UUID never succeeds", async () => {
    const setup = await setupM1();
    const { handle, repo, broker, connectorInstanceId } = setup;
    try {
      const sessionId = repo.createSession({ key: randomUUID(), now: T0 }).body
        .sessionId;
      const a = insertReference(
        handle.raw,
        connectorInstanceId,
        sessionId,
        1,
        "vault/a.md",
        "Doc A",
        "body A",
        T0,
      );
      const runId = freezeTurn(sessionId, [a.refId], "smuggle", repo, T0 + 10);
      const { gateway, calls } = scriptGateway([
        chatResult([
          toolCall("reference.open", { referenceId: "r0" }, "c0"),
          toolCall("reference.open", { referenceId: a.refId }, "c1"),
          toolCall("reference.open", { referenceId: "not-an-rn" }, "c2"),
        ]),
        chatResult([answerCall([{ text: "recovered", citations: [] }])]),
      ]);
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway,
        model: "m",
      });
      await expect(strategy(ctxFor(repo, runId))).resolves.toEqual({
        version: 1,
        text: "recovered",
      });
      const feedbacks = toolFeedbacks(calls);
      expect(feedbacks).toHaveLength(3);
      for (const feedback of feedbacks) {
        expect(feedback.body.ok).toBe(false);
        expect(feedback.body.output).toBeNull();
        expect(feedback.raw).not.toMatch(UUID_RE);
        expect(feedback.raw).not.toContain(a.refId);
      }
      // All three model-caused calls traversed the broker budget.
      expect(toolRequestsUsed(handle.raw, runId)).toBe(3);
      expect(repo.listEvidenceGrants(runId)).toEqual([]);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("out-of-context r2 (valid session, unfrozen) and cross-session r1 stay isolated", async () => {
    const setup = await setupM1();
    const { handle, repo, broker, connectorInstanceId } = setup;
    try {
      const sessionA = repo.createSession({ key: randomUUID(), now: T0 }).body
        .sessionId;
      const a1 = insertReference(
        handle.raw,
        connectorInstanceId,
        sessionA,
        1,
        "vault/a1.md",
        "A1",
        "body A1",
        T0,
      );
      insertReference(
        handle.raw,
        connectorInstanceId,
        sessionA,
        2,
        "vault/a2.md",
        "A2",
        "body A2",
        T0,
      );
      // Frozen context holds only r1; r2 exists in-session but out of context.
      const runA = freezeTurn(sessionA, [a1.refId], "isolated", repo, T0 + 10);
      const sessionB = repo.createSession({ key: randomUUID(), now: T0 + 20 })
        .body.sessionId;
      const b1 = insertReference(
        handle.raw,
        connectorInstanceId,
        sessionB,
        1,
        "vault/b1.md",
        "B1",
        "body B1",
        T0 + 20,
      );
      void b1;
      const { gateway, calls } = scriptGateway([
        chatResult([toolCall("reference.open", { referenceId: "r2" }, "c0")]),
        chatResult([answerCall([{ text: "recovered", citations: [] }])]),
      ]);
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway,
        model: "m",
      });
      await expect(strategy(ctxFor(repo, runA))).resolves.toEqual({
        version: 1,
        text: "recovered",
      });
      const feedbacks = toolFeedbacks(calls);
      expect(feedbacks).toHaveLength(1);
      expect(feedbacks[0]?.body.ok).toBe(false);
      expect(feedbacks[0]?.raw).not.toMatch(UUID_RE);
      expect(toolRequestsUsed(handle.raw, runA)).toBe(1);
      expect(repo.listEvidenceGrants(runA)).toEqual([]);

      // Cross-session: r1 in session B resolves to B's own document only.
      const runB = freezeTurn(sessionB, [b1.refId], "own", repo, T0 + 30);
      const second = scriptGateway([
        chatResult([toolCall("reference.open", { referenceId: "r1" }, "c0")]),
        chatResult([answerCall([{ text: "b cited", citations: ["r1"] }])]),
      ]);
      const strategyB = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway: second.gateway,
        model: "m",
      });
      await expect(strategyB(ctxFor(repo, runB))).resolves.toEqual({
        version: 1,
        text: "b cited",
      });
      const feedbacksB = toolFeedbacks(second.calls);
      expect(feedbacksB[0]?.body.ok).toBe(true);
      const outputB = feedbacksB[0]?.body.output as Record<string, unknown>;
      expect(outputB.referenceId).toBe("r1");
      expect(outputB.canonicalKey).toBe("vault/b1.md");
      expect(feedbacksB[0]?.raw).not.toContain(a1.refId);
      expect(feedbacksB[0]?.raw).not.toMatch(UUID_RE);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("mixed success plus failure consumes budget per call and grants only successes", async () => {
    const setup = await setupM1();
    const { handle, repo, broker, connectorInstanceId } = setup;
    try {
      const sessionId = repo.createSession({ key: randomUUID(), now: T0 }).body
        .sessionId;
      const a = insertReference(
        handle.raw,
        connectorInstanceId,
        sessionId,
        1,
        "vault/a.md",
        "Doc A",
        "body A",
        T0,
      );
      const runId = freezeTurn(sessionId, [a.refId], "mixed", repo, T0 + 10);
      const { gateway, calls } = scriptGateway([
        chatResult([
          toolCall("reference.open", { referenceId: "r1" }, "c0"),
          toolCall("reference.open", { referenceId: "r999" }, "c1"),
        ]),
        chatResult([answerCall([{ text: "cited", citations: ["r1"] }])]),
      ]);
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway,
        model: "m",
      });
      await expect(strategy(ctxFor(repo, runId))).resolves.toEqual({
        version: 1,
        text: "cited",
      });
      const feedbacks = toolFeedbacks(calls);
      expect(feedbacks).toHaveLength(2);
      expect(feedbacks[0]?.body.ok).toBe(true);
      expect(feedbacks[1]?.body.ok).toBe(false);
      for (const feedback of feedbacks) {
        expect(feedback.raw).not.toMatch(UUID_RE);
      }
      expect(toolRequestsUsed(handle.raw, runId)).toBe(2);
      const grants = repo.listEvidenceGrants(runId);
      expect(grants).toHaveLength(1);
      expect(grants[0]?.referenceId).toBe(a.refId);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
