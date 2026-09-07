// M2 bounded citation map (r3946377098): answer.submit citation
// verification resolves ONLY the unique cited rN ordinals from the already
// validated StructuredAnswer (at most 20 parts x 8 citations before dedup)
// via a session-scoped parameterized ordinal IN query in safe chunks. No
// full-session session_references scan; empty citations perform no
// reference scan. Unknown/cross-session ordinals stay citation_invalid;
// membership alone never grants (current-run EvidenceGrant still required);
// verification stays structural only.
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
  AGENT_REFERENCE_LOOKUP_CHUNK_SIZE,
  closeKernelDatabase,
  createAgentStrategy,
  createKernelRepository,
  createM1ToolRegistrations,
  createReferenceManager,
  createToolBroker,
  freezeStrategyContext,
  type KernelRepository,
  loadBoundedOrdinalMap,
  migrateKernelDatabase,
  openKernelDatabase,
  type ToolBroker,
} from "../src/index.js";

const T0 = 1790000000000;

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

async function setupCite(): Promise<{
  handle: ReturnType<typeof openKernelDatabase>;
  repo: KernelRepository;
  broker: ToolBroker;
  connectorInstanceId: string;
}> {
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
  const stubPort = {
    search: async () => ({ hits: [], skipped: [] }),
    readCanonical: async (canonicalKey: string) => ({
      canonicalKey,
      title: `Title ${canonicalKey}`,
      text: `body for ${canonicalKey}`,
      sourceRevision: "rev-1",
      snippet: "snippet",
      standardLinks: [],
      wikiLinks: [],
    }),
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
  return { handle, repo, broker, connectorInstanceId };
}

function insertReference(
  db: Database.Database,
  connectorInstanceId: string,
  sessionId: string,
  ordinal: number,
  canonicalKey: string,
): string {
  const resId = randomUUID();
  const snapId = randomUUID();
  const refId = randomUUID();
  db.prepare(
    "INSERT INTO resources (id, connector_instance_id, canonical_key, title, next_revision, created_at) VALUES (?, ?, ?, ?, 2, ?)",
  ).run(resId, connectorInstanceId, canonicalKey, `T ${canonicalKey}`, T0);
  db.prepare(
    "INSERT INTO resource_snapshots (id, resource_id, revision, source_revision, content_hash, body_json, size_bytes, observed_at, created_at) VALUES (?, ?, 1, 's1', ?, ?, ?, ?, ?)",
  ).run(
    snapId,
    resId,
    "a".repeat(64),
    JSON.stringify({ version: 1, text: `body ${canonicalKey}` }),
    8,
    T0,
    T0,
  );
  db.prepare(
    "INSERT INTO session_references (id, session_id, ordinal, resource_id, snapshot_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(refId, sessionId, ordinal, resId, snapId, T0);
  const cur = db
    .prepare("SELECT next_reference_ordinal FROM sessions WHERE id = ?")
    .get(sessionId) as { next_reference_ordinal: number } | undefined;
  if (cur !== undefined && cur.next_reference_ordinal <= ordinal) {
    db.prepare(
      "UPDATE sessions SET next_reference_ordinal = ? WHERE id = ?",
    ).run(ordinal + 1, sessionId);
  }
  return refId;
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

/** Capture session_references SELECTs issued after this call; returns restore. */
function spySessionReferences(rawDb: Database.Database): {
  seenSql: string[];
  restore: () => void;
} {
  const seenSql: string[] = [];
  const origPrepare = rawDb.prepare.bind(rawDb);
  // biome-ignore lint/suspicious/noExplicitAny: test spy wraps better-sqlite3 prepare.
  (rawDb as any).prepare = (sql: string, ...rest: unknown[]) => {
    if (typeof sql === "string" && sql.includes("session_references")) {
      seenSql.push(sql);
    }
    // biome-ignore lint/suspicious/noExplicitAny: passthrough spy.
    return (origPrepare as any)(sql, ...rest);
  };
  return {
    seenSql,
    restore: () => {
      // biome-ignore lint/suspicious/noExplicitAny: restore spy.
      (rawDb as any).prepare = origPrepare;
    },
  };
}

function expectBoundedSessionQueries(seenSql: string[]): void {
  expect(seenSql.length).toBeGreaterThan(0);
  for (const sql of seenSql) {
    expect(sql).toContain("session_id = ?");
    expect(sql).not.toMatch(/WHERE session_id = \?\s*$/);
    expect(sql).toMatch(/IN \(|AND (sr\.)?(id|ordinal|snapshot_id) = \?/);
    const placeholders = (sql.match(/\?/g) ?? []).length;
    expect(placeholders).toBeLessThanOrEqual(
      AGENT_REFERENCE_LOOKUP_CHUNK_SIZE + 1,
    );
  }
}

describe("bounded citation map (r3946377098)", () => {
  it("large session: granted citation succeeds with only bounded session-scoped queries", async () => {
    const setup = await setupCite();
    try {
      const { handle, repo, broker, connectorInstanceId } = setup;
      const sessionId = repo.createSession({ key: randomUUID(), now: T0 }).body
        .sessionId;
      for (let i = 1; i <= 400; i += 1) {
        insertReference(
          handle.raw,
          connectorInstanceId,
          sessionId,
          i,
          `vault/unrelated-${i}.md`,
        );
      }
      const frozen = (
        handle.raw
          .prepare(
            "SELECT id FROM session_references WHERE session_id = ? AND ordinal = ?",
          )
          .get(sessionId, 1) as { id: string }
      ).id;
      const spy = spySessionReferences(handle.raw);
      try {
        const runId = freezeTurn(
          sessionId,
          [frozen],
          "cite r1 among hundreds",
          repo,
          T0 + 10,
        );
        const { gateway } = scriptGateway([
          chatResult([toolCall("reference.open", { referenceId: "r1" }, "c0")]),
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
          version: 2,
          text: "cited",
          answer: { version: 1, parts: [{ text: "cited", citations: ["r1"] }] },
        });
        expectBoundedSessionQueries(spy.seenSql);
        // Citation needed a current-run grant: membership alone is not enough
        // (grant presence asserted by the success itself after the open).
        expect(repo.listEvidenceGrants(runId).length).toBeGreaterThan(0);
      } finally {
        spy.restore();
      }
    } finally {
      closeKernelDatabase(setup.handle);
    }
  });

  it("unknown ordinal stays citation_invalid and repairs once", async () => {
    const setup = await setupCite();
    try {
      const { handle, repo, broker } = setup;
      const sessionId = repo.createSession({ key: randomUUID(), now: T0 }).body
        .sessionId;
      const runId = freezeTurn(sessionId, [], "unknown cite", repo, T0 + 10);
      const { gateway, calls } = scriptGateway([
        chatResult([
          toolCall(
            "answer.submit",
            { version: 1, parts: [{ text: "bad", citations: ["r999"] }] },
            "a-bad",
          ),
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
        version: 2,
        text: "recovered",
        answer: { version: 1, parts: [{ text: "recovered", citations: [] }] },
      });
      expect(calls).toHaveLength(2);
      const rows = repo.listModelCalls(runId);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        step: 1,
        outcome: "failed",
        errorCode: "citation_invalid",
      });
      // Unit level: unknown ordinal maps to nothing (fail-closed, no grant).
      const map = loadBoundedOrdinalMap(handle.raw, sessionId, [999]);
      expect(map.size).toBe(0);
    } finally {
      closeKernelDatabase(setup.handle);
    }
  });

  it("cross-session ordinal is invisible and stays citation_invalid", async () => {
    const setup = await setupCite();
    try {
      const { handle, repo, broker, connectorInstanceId } = setup;
      const sessionA = repo.createSession({ key: randomUUID(), now: T0 }).body
        .sessionId;
      const sessionB = repo.createSession({ key: randomUUID(), now: T0 + 1 })
        .body.sessionId;
      insertReference(
        handle.raw,
        connectorInstanceId,
        sessionB,
        1,
        "vault/b.md",
      );
      // Session-scoped unit check: B's ordinal 1 never resolves in A.
      expect(loadBoundedOrdinalMap(handle.raw, sessionA, [1]).size).toBe(0);
      expect(loadBoundedOrdinalMap(handle.raw, sessionB, [1]).size).toBe(1);
      const runId = freezeTurn(
        sessionA,
        [],
        "cross-session cite",
        repo,
        T0 + 10,
      );
      const { gateway } = scriptGateway([
        chatResult([
          toolCall(
            "answer.submit",
            { version: 1, parts: [{ text: "bad", citations: ["r1"] }] },
            "a-cross",
          ),
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
        version: 2,
        text: "recovered",
        answer: { version: 1, parts: [{ text: "recovered", citations: [] }] },
      });
      expect(repo.listModelCalls(runId)[0]).toMatchObject({
        outcome: "failed",
        errorCode: "citation_invalid",
      });
    } finally {
      closeKernelDatabase(setup.handle);
    }
  });

  it("duplicate citations dedup to one ordinal and mapped-but-ungranted stays invalid", async () => {
    const setup = await setupCite();
    try {
      const { handle, repo, broker, connectorInstanceId } = setup;
      const sessionId = repo.createSession({ key: randomUUID(), now: T0 }).body
        .sessionId;
      const ref1 = insertReference(
        handle.raw,
        connectorInstanceId,
        sessionId,
        1,
        "vault/a.md",
      );
      insertReference(
        handle.raw,
        connectorInstanceId,
        sessionId,
        2,
        "vault/b.md",
      );
      // Dedup unit: repeated ordinals issue a single bounded ordinal query.
      const spy = spySessionReferences(handle.raw);
      const dupMap = loadBoundedOrdinalMap(handle.raw, sessionId, [1, 1, 1, 1]);
      const ordinalSql = spy.seenSql.filter((sql) =>
        sql.includes("ordinal IN"),
      );
      spy.restore();
      expect(dupMap.size).toBe(1);
      expect(dupMap.get(1)).toBe(ref1);
      expect(ordinalSql).toHaveLength(1);
      expect((ordinalSql[0]?.match(/\?/g) ?? []).length).toBe(2);
      // Mapped but ungranted r2: open only r1, then cite r2 -> repair.
      const runId = freezeTurn(
        sessionId,
        [ref1],
        "ungranted cite",
        repo,
        T0 + 10,
      );
      const { gateway } = scriptGateway([
        chatResult([toolCall("reference.open", { referenceId: "r1" }, "c0")]),
        chatResult([
          toolCall(
            "answer.submit",
            { version: 1, parts: [{ text: "bad", citations: ["r2"] }] },
            "a-ungranted",
          ),
        ]),
        chatResult([
          answerCall([{ text: "cited", citations: ["r1", "r1"] }], "a-dup"),
        ]),
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
        text: "cited",
        answer: {
          version: 1,
          parts: [{ text: "cited", citations: ["r1", "r1"] }],
        },
      });
      const rows = repo.listModelCalls(runId);
      expect(rows[1]).toMatchObject({
        step: 2,
        outcome: "failed",
        errorCode: "citation_invalid",
      });
    } finally {
      closeKernelDatabase(setup.handle);
    }
  });

  it("empty citations perform no session_references scan and succeed", async () => {
    const setup = await setupCite();
    try {
      const { handle, repo, broker, connectorInstanceId } = setup;
      const sessionId = repo.createSession({ key: randomUUID(), now: T0 }).body
        .sessionId;
      for (let i = 1; i <= 50; i += 1) {
        insertReference(
          handle.raw,
          connectorInstanceId,
          sessionId,
          i,
          `vault/filler-${i}.md`,
        );
      }
      const spy = spySessionReferences(handle.raw);
      try {
        const runId = freezeTurn(sessionId, [], "no citations", repo, T0 + 10);
        const { gateway } = scriptGateway([
          chatResult([answerCall([{ text: "plain", citations: [] }])]),
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
          text: "plain",
          answer: { version: 1, parts: [{ text: "plain", citations: [] }] },
        });
        expect(spy.seenSql).toHaveLength(0);
      } finally {
        spy.restore();
      }
      // Unit level: empty input touches no DB either.
      const spy2 = spySessionReferences(handle.raw);
      try {
        expect(loadBoundedOrdinalMap(handle.raw, sessionId, []).size).toBe(0);
        expect(spy2.seenSql).toHaveLength(0);
      } finally {
        spy2.restore();
      }
    } finally {
      closeKernelDatabase(setup.handle);
    }
  });

  it("ordinal lookup chunks bound placeholders and stays session-scoped", async () => {
    const setup = await setupCite();
    try {
      const { handle, repo, connectorInstanceId } = setup;
      const sessionId = repo.createSession({ key: randomUUID(), now: T0 }).body
        .sessionId;
      for (let i = 1; i <= 130; i += 1) {
        insertReference(
          handle.raw,
          connectorInstanceId,
          sessionId,
          i,
          `vault/chunk-${i}.md`,
        );
      }
      const ordinals = Array.from({ length: 120 }, (_, i) => i + 1);
      const spy = spySessionReferences(handle.raw);
      let map: Map<number, string>;
      try {
        map = loadBoundedOrdinalMap(handle.raw, sessionId, ordinals);
      } finally {
        spy.restore();
      }
      expect(map.size).toBe(120);
      const ordinalSql = spy.seenSql.filter((sql) =>
        sql.includes("ordinal IN"),
      );
      expect(ordinalSql.length).toBe(
        Math.ceil(120 / AGENT_REFERENCE_LOOKUP_CHUNK_SIZE),
      );
      for (const sql of ordinalSql) {
        expect(sql).toContain("session_id = ?");
        const placeholders = (sql.match(/\?/g) ?? []).length;
        expect(placeholders).toBeLessThanOrEqual(
          AGENT_REFERENCE_LOOKUP_CHUNK_SIZE + 1,
        );
      }
      expect(AGENT_REFERENCE_LOOKUP_CHUNK_SIZE).toBeLessThanOrEqual(100);
    } finally {
      closeKernelDatabase(setup.handle);
    }
  });
});
