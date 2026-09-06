// M2 dynamic rN addressability (r3943599549): per-run known ordinal->UUID
// map seeded only from frozen context, extended only by structural
// `{ ordinal, referenceId }` pairs actually present in size-accepted
// delivered feedback (search / refresh / related). Learning addressability
// never grants citation evidence; unknown / omitted / oversized /
// undelivered rNs stay unresolved and fail through ToolBroker (budget
// consumed, no UUID leak). No semantic lookup, no cross-session reuse.
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
  closeKernelDatabase,
  createAgentStrategy,
  createKernelRepository,
  createM1ToolRegistrations,
  createReferenceManager,
  createToolBroker,
  freezeStrategyContext,
  type KernelRepository,
  type MarkdownPortSearchResult,
  migrateKernelDatabase,
  openKernelDatabase,
  type ToolBroker,
} from "../src/index.js";

const T0 = 1790000000000;
const UUID_RE =
  /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}/;

function toolCall(name: string, args: unknown, id: string): NormalizedToolCall {
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

interface DynSetup {
  handle: ReturnType<typeof openKernelDatabase>;
  repo: KernelRepository;
  broker: ToolBroker;
  connectorInstanceId: string;
  readCalls: string[];
  docs: Map<string, { title: string; text: string; sourceRevision: string }>;
  searchImpl: { fn: () => Promise<MarkdownPortSearchResult> };
}

async function setupDyn(budgets?: Record<string, number>): Promise<DynSetup> {
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
  const searchImpl: DynSetup["searchImpl"] = {
    fn: async () => ({ hits: [], skipped: [] }),
  };
  const stubPort = {
    search: async (
      input: { query: string; limit: number },
      _options?: { signal?: AbortSignal },
    ) => searchImpl.fn(),
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
    ...(budgets === undefined ? {} : { budgets }),
  });
  return { handle, repo, broker, connectorInstanceId, readCalls, docs, searchImpl };
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
  const cur = db
    .prepare("SELECT next_reference_ordinal FROM sessions WHERE id = ?")
    .get(sessionId) as { next_reference_ordinal: number } | undefined;
  if (cur !== undefined && cur.next_reference_ordinal <= ordinal) {
    db.prepare(
      "UPDATE sessions SET next_reference_ordinal = ? WHERE id = ?",
    ).run(ordinal + 1, sessionId);
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
  toolName: string | undefined;
  body: { tool: string; ok: boolean; errorCode: string | null; output: unknown };
  raw: string;
}> {
  // Gateway requests accumulate history: the same role:tool message appears
  // in every later request. Dedupe by toolCallId (first occurrence wins) so
  // each ordinary call counts once in request order.
  const seen = new Map<
    string,
    {
      toolCallId: string | undefined;
      toolName: string | undefined;
      body: { tool: string; ok: boolean; errorCode: string | null; output: unknown };
      raw: string;
    }
  >();
  for (const request of calls) {
    for (const message of request.messages) {
      if (message.role === "tool") {
        const toolCallId = (message as { toolCallId?: string }).toolCallId;
        const key = toolCallId ?? `anon:${seen.size}`;
        if (seen.has(key)) continue;
        const raw = (message as { content: string }).content;
        seen.set(key, {
          toolCallId,
          toolName: (message as { toolName?: string }).toolName,
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
  return [...seen.values()];
}

function toolRequestsUsed(db: Database.Database, runId: string): number {
  const row = db
    .prepare("SELECT tool_requests_used FROM runs WHERE id = ?")
    .get(runId) as { tool_requests_used: number };
  return row.tool_requests_used;
}

describe("dynamic rN chains (search/refresh/related -> open)", () => {
  it("search -> open: search-exposed r1 resolves in a later open with full grant", async () => {
    const setup = await setupDyn();
    try {
      const { handle, repo, broker } = setup;
      const sessionId = repo.createSession({ key: randomUUID(), now: T0 }).body
        .sessionId;
      setup.searchImpl.fn = async () => ({
        hits: [
          {
            canonicalKey: "vault/new.md",
            title: "New Doc",
            snippet: "new snippet",
            text: "new evidence body",
            sourceRevision: "rev-1",
            standardLinks: [],
            wikiLinks: [],
          },
        ],
        skipped: [],
      });
      const runId = freezeTurn(sessionId, [], "search then open", repo, T0 + 10);
      const { gateway, calls } = scriptGateway([
        chatResult([toolCall("markdown.search", { query: "new" }, "c0")]),
        chatResult([toolCall("reference.open", { referenceId: "r1" }, "c1")]),
        chatResult([answerCall([{ text: "cited new", citations: ["r1"] }])]),
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
        text: "cited new",
        answer: {
          version: 1,
          parts: [{ text: "cited new", citations: ["r1"] }],
        },
      });
      const feedbacks = toolFeedbacks(calls);
      expect(feedbacks).toHaveLength(2);
      expect(feedbacks[0]?.body.tool).toBe("markdown.search");
      expect(feedbacks[0]?.body.ok).toBe(true);
      const searchOut = feedbacks[0]?.body.output as {
        hits: Array<Record<string, unknown>>;
      };
      expect(searchOut.hits).toHaveLength(1);
      expect(searchOut.hits[0]?.referenceId).toBe("r1");
      expect(feedbacks[1]?.body.tool).toBe("reference.open");
      expect(feedbacks[1]?.body.ok).toBe(true);
      expect(
        (feedbacks[1]?.body.output as Record<string, unknown>).referenceId,
      ).toBe("r1");
      for (const fb of feedbacks) expect(fb.raw).not.toMatch(UUID_RE);
      expect(toolRequestsUsed(handle.raw, runId)).toBe(2);
      const grants = repo.listEvidenceGrants(runId);
      expect(grants.length).toBeGreaterThanOrEqual(1);
      expect(grants.map((g) => g.exposure)).toContain("full");
    } finally {
      closeKernelDatabase(setup.handle);
    }
  });

  it("refresh -> open: refresh-exposed r2 resolves in a later open", async () => {
    const setup = await setupDyn();
    try {
      const { handle, repo, broker, connectorInstanceId, docs } = setup;
      const sessionId = repo.createSession({ key: randomUUID(), now: T0 }).body
        .sessionId;
      const a = insertReference(
        handle.raw,
        connectorInstanceId,
        sessionId,
        1,
        "vault/a.md",
        "Doc A",
        "original A",
        T0,
      );
      docs.set("vault/a.md", {
        title: "Doc A",
        text: "refreshed A v2",
        sourceRevision: "rev-2",
      });
      const runId = freezeTurn(sessionId, [a.refId], "refresh then open", repo, T0 + 10);
      const { gateway, calls } = scriptGateway([
        chatResult([toolCall("reference.refresh", { referenceId: "r1" }, "c0")]),
        chatResult([toolCall("reference.open", { referenceId: "r2" }, "c1")]),
        chatResult([answerCall([{ text: "cited r2", citations: ["r2"] }])]),
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
        text: "cited r2",
        answer: { version: 1, parts: [{ text: "cited r2", citations: ["r2"] }] },
      });
      const feedbacks = toolFeedbacks(calls);
      expect(feedbacks).toHaveLength(2);
      expect(feedbacks[0]?.body.ok).toBe(true);
      expect(
        (feedbacks[0]?.body.output as Record<string, unknown>).referenceId,
      ).toBe("r2");
      expect(feedbacks[1]?.body.ok).toBe(true);
      expect(
        (feedbacks[1]?.body.output as Record<string, unknown>).referenceId,
      ).toBe("r2");
      for (const fb of feedbacks) expect(fb.raw).not.toMatch(UUID_RE);
      expect(toolRequestsUsed(handle.raw, runId)).toBe(2);
      // Citing the refreshed r2 requires the open grant on the NEW reference.
      const grants = repo.listEvidenceGrants(runId);
      expect(grants.map((g) => g.exposure)).toContain("full");
    } finally {
      closeKernelDatabase(setup.handle);
    }
  });

  it("related -> open: related-exposed r2 (unfrozen) resolves in a later open with no premature grant", async () => {
    const setup = await setupDyn();
    try {
      const { handle, repo, broker, connectorInstanceId } = setup;
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
      void b;
      handle.raw
        .prepare(
          "INSERT INTO snapshot_links (source_snapshot_id, ordinal, kind, status, target_resource_id, candidates_json) VALUES (?, 1, 'standard', 'resolved', ?, ?)",
        )
        .run(a.snapId, b.resId, JSON.stringify(["vault/b.md"]));
      // Frozen context holds only r1; r2 is learned via related feedback.
      const runId = freezeTurn(sessionId, [a.refId], "related then open", repo, T0 + 10);
      const { gateway, calls } = scriptGateway([
        chatResult([toolCall("reference.related", { referenceId: "r1" }, "c0")]),
        chatResult([toolCall("reference.open", { referenceId: "r2" }, "c1")]),
        chatResult([answerCall([{ text: "cited B", citations: ["r2"] }])]),
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
        text: "cited B",
        answer: { version: 1, parts: [{ text: "cited B", citations: ["r2"] }] },
      });
      const feedbacks = toolFeedbacks(calls);
      expect(feedbacks).toHaveLength(2);
      expect(feedbacks[0]?.body.tool).toBe("reference.related");
      expect(feedbacks[0]?.body.ok).toBe(true);
      const relOut = feedbacks[0]?.body.output as {
        references: Array<Record<string, unknown>>;
      };
      expect(relOut.references).toHaveLength(1);
      expect(relOut.references[0]?.referenceId).toBe("r2");
      expect(feedbacks[1]?.body.tool).toBe("reference.open");
      expect(feedbacks[1]?.body.ok).toBe(true);
      for (const fb of feedbacks) expect(fb.raw).not.toMatch(UUID_RE);
      expect(toolRequestsUsed(handle.raw, runId)).toBe(2);
    } finally {
      closeKernelDatabase(setup.handle);
    }
  });

  it("no premature grant: related-exposed r2 is addressable but not citable without open", async () => {
    const setup = await setupDyn();
    try {
      const { handle, repo, broker, connectorInstanceId } = setup;
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
      void b;
      handle.raw
        .prepare(
          "INSERT INTO snapshot_links (source_snapshot_id, ordinal, kind, status, target_resource_id, candidates_json) VALUES (?, 1, 'standard', 'resolved', ?, ?)",
        )
        .run(a.snapId, b.resId, JSON.stringify(["vault/b.md"]));
      const runId = freezeTurn(sessionId, [a.refId], "no grant", repo, T0 + 10);
      const { gateway, calls } = scriptGateway([
        chatResult([toolCall("reference.related", { referenceId: "r1" }, "c0")]),
        // Cite r2 immediately: title-only listing granted nothing, so this
        // step must repair with citation_invalid (one repair consumed).
        chatResult([answerCall([{ text: "early cite", citations: ["r2"] }], "a0")]),
        chatResult([answerCall([{ text: "recovered", citations: [] }], "a1")]),
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
        text: "recovered",
        answer: { version: 1, parts: [{ text: "recovered", citations: [] }] },
      });
      // Repair path proves the citation was rejected: 3 gateway calls.
      expect(calls).toHaveLength(3);
      // Ordinary feedback (related) plus the fixed repair synthesis for the
      // invalid answer call (answer_invalid, no tool name).
      const feedbacks = toolFeedbacks(calls);
      const ordinary = feedbacks.filter((f) => f.body.tool !== undefined);
      expect(ordinary).toHaveLength(1);
      expect(ordinary[0]?.body.tool).toBe("reference.related");
      expect(ordinary[0]?.body.ok).toBe(true);
      // Learning addressability created no EvidenceGrant.
      expect(repo.listEvidenceGrants(runId)).toEqual([]);
      expect(toolRequestsUsed(handle.raw, runId)).toBe(1);
    } finally {
      closeKernelDatabase(setup.handle);
    }
  });

  it("oversized omission teaches nothing: fixed output_too_large then open r2 fails", async () => {
    const setup = await setupDyn({
      maxModelFacingOutputBytesPerCall: 256 * 1024,
      maxModelFacingOutputBytesPerRun: 512 * 1024,
      maxNormalizedOutputBytesPerCall: 512 * 1024,
    });
    try {
      const { handle, repo, broker, connectorInstanceId, docs } = setup;
      const sessionId = repo.createSession({ key: randomUUID(), now: T0 }).body
        .sessionId;
      // Snippets are contract-capped at 512 code points, so the oversized
      // vector is the refreshed full body (70k < 1MiB body cap, but the
      // framed role:tool message exceeds the 64KiB gateway limit).
      const a = insertReference(
        handle.raw,
        connectorInstanceId,
        sessionId,
        1,
        "vault/a.md",
        "Doc A",
        "small original",
        T0,
      );
      docs.set("vault/a.md", {
        title: "Doc A",
        text: "x".repeat(70_000),
        sourceRevision: "rev-huge",
      });
      const runId = freezeTurn(sessionId, [a.refId], "oversized", repo, T0 + 10);
      const { gateway, calls } = scriptGateway([
        chatResult([toolCall("reference.refresh", { referenceId: "r1" }, "c0")]),
        chatResult([toolCall("reference.open", { referenceId: "r2" }, "c1")]),
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
        version: 2,
        text: "recovered",
        answer: { version: 1, parts: [{ text: "recovered", citations: [] }] },
      });
      const feedbacks = toolFeedbacks(calls);
      expect(feedbacks).toHaveLength(2);
      // First feedback is the fixed compact omission (never the raw payload).
      expect(feedbacks[0]?.body).toEqual({
        tool: "reference.refresh",
        ok: false,
        errorCode: "output_too_large",
        output: null,
      });
      expect(feedbacks[0]?.raw).not.toMatch(UUID_RE);
      expect(feedbacks[0]?.raw).not.toContain("x".repeat(32));
      // The omitted r2 was NOT learned: the later open still fails via broker.
      expect(feedbacks[1]?.body.ok).toBe(false);
      expect(feedbacks[1]?.body.output).toBeNull();
      expect(feedbacks[1]?.raw).not.toMatch(UUID_RE);
      expect(toolRequestsUsed(handle.raw, runId)).toBe(2);
      expect(repo.listEvidenceGrants(runId)).toEqual([]);
    } finally {
      closeKernelDatabase(setup.handle);
    }
  });

  it("session isolation: search-learned r1 in session A stays unknown in session B", async () => {
    const setup = await setupDyn();
    try {
      const { handle, repo, broker } = setup;
      const sessionA = repo.createSession({ key: randomUUID(), now: T0 }).body
        .sessionId;
      setup.searchImpl.fn = async () => ({
        hits: [
          {
            canonicalKey: "vault/a-only.md",
            title: "A only",
            snippet: "a snippet",
            text: "a body",
            sourceRevision: "rev-a",
            standardLinks: [],
            wikiLinks: [],
          },
        ],
        skipped: [],
      });
      const runA = freezeTurn(sessionA, [], "learn A", repo, T0 + 10);
      const gwA = scriptGateway([
        chatResult([toolCall("markdown.search", { query: "a" }, "c0")]),
        chatResult([toolCall("reference.open", { referenceId: "r1" }, "c1")]),
        chatResult([answerCall([{ text: "ok A", citations: [] }])]),
      ]);
      const stratA = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway: gwA.gateway,
        model: "m",
      });
      await expect(stratA(ctxFor(repo, runA))).resolves.toEqual({
        version: 2,
        text: "ok A",
        answer: { version: 1, parts: [{ text: "ok A", citations: [] }] },
      });
      expect(toolFeedbacks(gwA.calls)[1]?.body.ok).toBe(true);

      // Session B never saw the feedback: r1 must fail through the broker.
      const sessionB = repo.createSession({ key: randomUUID(), now: T0 + 50 }).body
        .sessionId;
      const runB = freezeTurn(sessionB, [], "isolated B", repo, T0 + 60);
      const gwB = scriptGateway([
        chatResult([toolCall("reference.open", { referenceId: "r1" }, "c0")]),
        chatResult([answerCall([{ text: "ok B", citations: [] }])]),
      ]);
      const stratB = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway: gwB.gateway,
        model: "m",
      });
      await expect(stratB(ctxFor(repo, runB))).resolves.toEqual({
        version: 2,
        text: "ok B",
        answer: { version: 1, parts: [{ text: "ok B", citations: [] }] },
      });
      const fbB = toolFeedbacks(gwB.calls);
      expect(fbB).toHaveLength(1);
      expect(fbB[0]?.body.ok).toBe(false);
      expect(fbB[0]?.body.output).toBeNull();
      expect(fbB[0]?.raw).not.toMatch(UUID_RE);
      expect(toolRequestsUsed(handle.raw, runB)).toBe(1);
      expect(repo.listEvidenceGrants(runB)).toEqual([]);
    } finally {
      closeKernelDatabase(setup.handle);
    }
  });
});
