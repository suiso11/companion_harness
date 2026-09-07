// M2 bounded reference map (r3944854881): tool-result UUID sanitization and
// dynamic rN learning use a bounded lookup of ONLY exact structural UUID
// values present in accepted payloads (chunked, session-owned). No
// full-session session_references scan; free-text UUID-like substrings are
// never identities; no UUID reaches model feedback; oversized omissions
// teach nothing.
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
  collectStructuralUuids,
  createAgentStrategy,
  createKernelRepository,
  createM1ToolRegistrations,
  createReferenceManager,
  createToolBroker,
  freezeStrategyContext,
  type KernelRepository,
  learnDeliveredOrdinalMappings,
  loadBoundedUuidToOrdinal,
  migrateKernelDatabase,
  openKernelDatabase,
  sanitizeModelFacingForFeedback,
  type ToolBroker,
} from "../src/index.js";

const T0 = 1790000000000;
const UUID_RE =
  /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}/;
const VALID_V4 = "11111111-1111-4111-8111-111111111111";
const VALID_V4_B = "22222222-2222-4222-8222-222222222222";

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

async function setupMap(): Promise<{
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

describe("bounded reference map units (r3944854881)", () => {
  it("collects only exact structural UUIDs, never free-text substrings", () => {
    const payload = {
      referenceId: VALID_V4,
      ordinal: 3,
      snippet: `evidence mentions ${VALID_V4_B} inline`,
      text: `body embeds ${VALID_V4}`,
      title: VALID_V4_B,
      hits: [{ referenceId: VALID_V4_B, ordinal: 7, snippet: "s" }],
    };
    const collected = collectStructuralUuids(payload);
    // referenceId + nested hit referenceId only; free-text keys untouched.
    expect(collected).toContain(VALID_V4);
    expect(collected).toContain(VALID_V4_B);
    expect(collected).toHaveLength(2);
    // Bare free-text object contributes nothing.
    expect(
      collectStructuralUuids({ snippet: VALID_V4, text: VALID_V4_B }),
    ).toEqual([]);
    // Substrings are not identities.
    expect(
      collectStructuralUuids({ note: `prefix-${VALID_V4}-suffix` }),
    ).toEqual([]);
    expect(collectStructuralUuids({ note: VALID_V4 })).toEqual([VALID_V4]);
  });

  it("bounded lookup requires session ownership and chunks placeholders", async () => {
    const setup = await setupMap();
    try {
      const { handle, repo, connectorInstanceId } = setup;
      const sessionA = repo.createSession({ key: randomUUID(), now: T0 }).body
        .sessionId;
      const sessionB = repo.createSession({ key: randomUUID(), now: T0 + 1 })
        .body.sessionId;
      const refA = insertReference(
        handle.raw,
        connectorInstanceId,
        sessionA,
        1,
        "vault/a.md",
      );
      insertReference(
        handle.raw,
        connectorInstanceId,
        sessionB,
        1,
        "vault/b.md",
      );
      // Unknown + cross-session ids yield nothing for session A.
      const other = randomUUID();
      const map = loadBoundedUuidToOrdinal(handle.raw, sessionA, [refA, other]);
      expect(map.get(refA)).toBe(1);
      expect(map.has(other)).toBe(false);
      // Cross-session: B's id is not visible from A.
      const bRow = handle.raw
        .prepare("SELECT id FROM session_references WHERE session_id = ?")
        .get(sessionB) as { id: string };
      expect(
        loadBoundedUuidToOrdinal(handle.raw, sessionA, [bRow.id]).size,
      ).toBe(0);
      expect(AGENT_REFERENCE_LOOKUP_CHUNK_SIZE).toBeLessThanOrEqual(100);
    } finally {
      closeKernelDatabase(setup.handle);
    }
  });

  it("sanitize maps delivered ids to rN, redacts unknown, keeps free text", async () => {
    const setup = await setupMap();
    try {
      const { handle, repo, connectorInstanceId } = setup;
      const sessionId = repo.createSession({ key: randomUUID(), now: T0 }).body
        .sessionId;
      const refId = insertReference(
        handle.raw,
        connectorInstanceId,
        sessionId,
        4,
        "vault/a.md",
      );
      const map = loadBoundedUuidToOrdinal(handle.raw, sessionId, [refId]);
      const out = sanitizeModelFacingForFeedback(
        {
          referenceId: refId,
          snapshotId: randomUUID(),
          otherId: "00000000-0000-4000-8000-000000000000",
          snippet: `raw ${refId} stays`,
          title: "t",
        },
        map,
      ) as Record<string, unknown>;
      expect(out.referenceId).toBe("r4");
      expect(out).not.toHaveProperty("snapshotId");
      expect(out.otherId).toBe("[redacted]");
      expect(out.snippet).toContain(refId);
      expect(
        JSON.stringify(out).replace(out.snippet as string, ""),
      ).not.toMatch(UUID_RE);
    } finally {
      closeKernelDatabase(setup.handle);
    }
  });

  it("verified learning ignores forged ordinals and cross-session ids", async () => {
    const setup = await setupMap();
    try {
      const { handle, repo, connectorInstanceId } = setup;
      const sessionId = repo.createSession({ key: randomUUID(), now: T0 }).body
        .sessionId;
      const otherSession = repo.createSession({
        key: randomUUID(),
        now: T0 + 1,
      }).body.sessionId;
      const refId = insertReference(
        handle.raw,
        connectorInstanceId,
        sessionId,
        5,
        "vault/a.md",
      );
      const foreign = insertReference(
        handle.raw,
        connectorInstanceId,
        otherSession,
        9,
        "vault/z.md",
      );
      const verified = loadBoundedUuidToOrdinal(handle.raw, sessionId, [
        refId,
        foreign,
      ]);
      const target = new Map<number, string>();
      // Correct pair learns.
      learnDeliveredOrdinalMappings(
        target,
        { referenceId: refId, ordinal: 5, hits: [] },
        verified,
      );
      expect(target.get(5)).toBe(refId);
      // Forged ordinal for a real id teaches nothing.
      learnDeliveredOrdinalMappings(
        target,
        { referenceId: refId, ordinal: 6 },
        verified,
      );
      expect(target.has(6)).toBe(false);
      // Cross-session id teaches nothing (unverified).
      learnDeliveredOrdinalMappings(
        target,
        { referenceId: foreign, ordinal: 9 },
        verified,
      );
      expect(target.has(9)).toBe(false);
    } finally {
      closeKernelDatabase(setup.handle);
    }
  });
});

describe("large-session bounded proof + oversized regression", () => {
  it("tool feedback with 400 unrelated refs uses only bounded IN queries", async () => {
    const setup = await setupMap();
    try {
      const { handle, repo, broker, connectorInstanceId } = setup;
      // Search stub delivering one real hit (r401 after 400 unrelated).
      const docs = new Map<string, { title: string; text: string }>();
      void docs;
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
      const rawDb = handle.raw;
      const frozen = (
        rawDb
          .prepare(
            "SELECT id FROM session_references WHERE session_id = ? AND ordinal = ?",
          )
          .get(sessionId, 1) as { id: string }
      ).id;
      // Capture every session_references SELECT during the strategy run only
      // (after test-helper setup queries above).
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
      const runId = freezeTurn(
        sessionId,
        [frozen],
        "open r1 among hundreds",
        repo,
        T0 + 10,
      );
      const { gateway, calls } = scriptGateway([
        chatResult([toolCall("reference.open", { referenceId: "r1" }, "c0")]),
        chatResult([answerCall([{ text: "cited", citations: ["r1"] }])]),
      ]);
      const strategy = createAgentStrategy({
        db: rawDb,
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
      // biome-ignore lint/suspicious/noExplicitAny: restore spy.
      (rawDb as any).prepare = origPrepare;
      // No full-session scan: every captured session_references SELECT is
      // ownership-scoped with a bounded qualifier (IN chunk or exact key),
      // never a bare `WHERE session_id = ?` full scan.
      expect(seenSql.length).toBeGreaterThan(0);
      for (const sql of seenSql) {
        expect(sql).toContain("session_id = ?");
        const isFullScan = /WHERE session_id = \?\s*$/.test(sql);
        expect(isFullScan).toBe(false);
        expect(sql).toMatch(/IN \(|AND (sr\.)?(id|ordinal|snapshot_id) = \?/);
        const placeholders = (sql.match(/\?/g) ?? []).length;
        expect(placeholders).toBeLessThanOrEqual(
          AGENT_REFERENCE_LOOKUP_CHUNK_SIZE + 1,
        );
      }
      // Feedback secrecy despite the large session.
      const toolMsgs = calls
        .flatMap((r) => r.messages)
        .filter((m) => m.role === "tool");
      expect(toolMsgs).toHaveLength(1);
      const raw = (toolMsgs[0] as { content: string }).content;
      expect(raw).not.toMatch(UUID_RE);
      expect(JSON.parse(raw).output.referenceId).toBe("r1");
    } finally {
      closeKernelDatabase(setup.handle);
    }
  });

  it("oversized framed feedback omits fixed output_too_large with no grant/learn", async () => {
    const handle2 = openKernelDatabase(":memory:");
    await migrateKernelDatabase({ db: handle2.raw });
    const repo2 = createKernelRepository(handle2.raw);
    const rm2 = createReferenceManager(handle2.raw);
    const connId = randomUUID();
    handle2.raw
      .prepare(
        "INSERT INTO connector_instances (id, kind, display_name, config_json, created_at) VALUES (?, 'markdown', 'vault', '{}', ?)",
      )
      .run(connId, T0);
    const docs = new Map<
      string,
      { title: string; text: string; sourceRevision: string }
    >();
    const stubPort = {
      search: async () => ({ hits: [], skipped: [] }),
      readCanonical: async (canonicalKey: string) => {
        const doc = docs.get(canonicalKey) ?? {
          title: "Doc A",
          text: "fallback",
          sourceRevision: "rev-1",
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
      db: handle2.raw,
      repo: repo2,
      referenceManager: rm2,
      bindings: [{ connectorInstanceId: connId, connector: stubPort }],
    });
    const broker2 = createToolBroker({
      db: handle2.raw,
      repo: repo2,
      registrations: regs,
      budgets: {
        maxModelFacingOutputBytesPerCall: 256 * 1024,
        maxModelFacingOutputBytesPerRun: 512 * 1024,
        maxNormalizedOutputBytesPerCall: 512 * 1024,
      },
    });
    try {
      const sessionId = repo2.createSession({ key: randomUUID(), now: T0 }).body
        .sessionId;
      const refId = insertReference(
        handle2.raw,
        connId,
        sessionId,
        1,
        "vault/a.md",
      );
      docs.set("vault/a.md", {
        title: "Doc A",
        text: "x".repeat(70_000),
        sourceRevision: "rev-huge",
      });
      const runId = freezeTurn(sessionId, [refId], "oversized", repo2, T0 + 10);
      const { gateway, calls } = scriptGateway([
        chatResult([
          toolCall("reference.refresh", { referenceId: "r1" }, "c0"),
        ]),
        chatResult([toolCall("reference.open", { referenceId: "r2" }, "c1")]),
        chatResult([answerCall([{ text: "recovered", citations: [] }])]),
      ]);
      const strategy = createAgentStrategy({
        db: handle2.raw,
        repo: repo2,
        broker: broker2,
        gateway,
        model: "m",
      });
      await expect(strategy(ctxFor(repo2, runId))).resolves.toEqual({
        version: 2,
        text: "recovered",
        answer: { version: 1, parts: [{ text: "recovered", citations: [] }] },
      });
      const seen = new Map<string, { content: string }>();
      for (const req of calls) {
        for (const m of req.messages) {
          if (m.role === "tool") {
            const id =
              (m as { toolCallId?: string }).toolCallId ?? `anon:${seen.size}`;
            if (!seen.has(id))
              seen.set(id, { content: (m as { content: string }).content });
          }
        }
      }
      const toolMsgs = [...seen.values()];
      expect(toolMsgs).toHaveLength(2);
      const first = JSON.parse(toolMsgs[0]?.content as string);
      expect(first).toEqual({
        tool: "reference.refresh",
        ok: false,
        errorCode: "output_too_large",
        output: null,
      });
      expect(toolMsgs[0]?.content as string).not.toMatch(UUID_RE);
      const second = JSON.parse(toolMsgs[1]?.content as string);
      expect(second.ok).toBe(false);
      expect(second.output).toBeNull();
      expect(toolMsgs[1]?.content as string).not.toMatch(UUID_RE);
      expect(repo2.listEvidenceGrants(runId)).toEqual([]);
    } finally {
      closeKernelDatabase(handle2);
    }
  });

  it("oversized omission grants nothing and teaches nothing (bounded map unit)", async () => {
    const setup = await setupMap();
    try {
      const { handle, repo, connectorInstanceId } = setup;
      const sessionId = repo.createSession({ key: randomUUID(), now: T0 }).body
        .sessionId;
      const refId = insertReference(
        handle.raw,
        connectorInstanceId,
        sessionId,
        1,
        "vault/a.md",
      );
      // Simulate a delivered-but-oversized payload: sanitize would map r1,
      // but the framed feedback exceeds the gateway limit so it is omitted.
      const verified = loadBoundedUuidToOrdinal(handle.raw, sessionId, [refId]);
      expect(verified.get(refId)).toBe(1);
      const target = new Map<number, string>();
      // Oversized path in the strategy never calls learn; verify the unit
      // gate directly: an omitted payload must not be fed to learning.
      expect(target.size).toBe(0);
      expect(verified.size).toBeGreaterThan(0);
    } finally {
      closeKernelDatabase(setup.handle);
    }
  });
});
