// Explicit memory management regressions: ambiguity/scope/current-target/
// stale-version guards, idempotent replay + partial-chain recovery, no heat
// on search, retire/search/reactivate lifecycle, immutable citations, and
// native tool-flow budgets.
//
// Real migrated `:memory:` kernel DB + injected fake remind CLI (behavioral
// contract only). No child, no remind DB, no network.

import { randomUUID } from "node:crypto";
import { buildRunResultV2, TOOL_BUDGET_DEFAULTS } from "@companion/contracts";
import {
  closeKernelDatabase,
  createKernelRepository,
  createMemorySearchRegistration,
  createMemoryStageRegistrations,
  type KernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
} from "@companion/kernel";
import { afterEach, describe, expect, it } from "vitest";
import type {
  MemoryCliAddress,
  MemoryCliCallOptions,
  MemoryCliEnvelope,
} from "../src/memory_cli.js";
import {
  createMemoryService,
  MemoryManageCancelled,
  MemoryManageError,
  type MemoryService,
} from "../src/memory_service.js";

const T0 = 1790000000000;
const SCOPE = "test-scope";

type CliCall = (
  address: MemoryCliAddress,
  op: string,
  params: Record<string, unknown>,
  idempotencyKey: string | undefined,
  options?: MemoryCliCallOptions,
) => Promise<MemoryCliEnvelope>;

function okEnvelope(data: Record<string, unknown> | null): MemoryCliEnvelope {
  return { ok: true, code: "OK", data, deduplicated: false };
}

function ids(): { sessionId: string; runId: string } {
  return { sessionId: "", runId: "" };
}
void ids;

async function openRepo(): Promise<{
  repo: KernelRepository;
  close: () => void;
}> {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  return {
    repo: createKernelRepository(handle.raw),
    close: () => closeKernelDatabase(handle),
  };
}

let services: MemoryService[] = [];
afterEach(async () => {
  for (const service of services) {
    await service.stop().catch(() => undefined);
  }
  services = [];
});

function makeService(repo: KernelRepository, cliCall: CliCall): MemoryService {
  const service = createMemoryService({
    address: {
      executable: "/bin/true",
      entry: "/cli.js",
      config: "/mem.json",
      timeoutMs: 5000,
      maxResponseBytes: 65536,
    },
    scope: SCOPE,
    recallLimit: 5,
    idleMs: 300_000,
    repo,
    gateway: null,
    model: "test-model",
    cliCall,
  });
  services.push(service);
  return service;
}

function completeRun(
  repo: KernelRepository,
  text = "hello",
): {
  sessionId: string;
  turnId: string;
  runId: string;
} {
  const sessionId = repo.createSession({ key: randomUUID(), now: T0 }).body
    .sessionId;
  const posted = repo.postMessage(
    sessionId,
    { text },
    { key: randomUUID(), now: T0 + 1 },
  );
  const runId = posted.body.run.id;
  const turnId = posted.body.turnId;
  repo.startRun(runId, { now: T0 + 2 });
  expect(
    repo.completeRun(
      runId,
      buildRunResultV2({ version: 1, parts: [{ text, citations: [] }] }),
      { now: T0 + 3 },
    ).applied,
  ).toBe(true);
  return { sessionId, turnId, runId };
}

interface FakeLedger {
  ops: string[];
  liveStatus: Map<string, string>;
}

function recordEnvelope(
  id: string,
  status: string,
  revision: number,
): Record<string, unknown> {
  return {
    record: {
      id,
      body: `body-of-${id}`,
      kind: "user_fact",
      status,
      revision,
      source: "companion:conversation",
      observedAt: new Date(T0).toISOString(),
      createdAt: new Date(T0).toISOString(),
      scope: SCOPE,
    },
  };
}

function makeCli(
  ledger: FakeLedger,
  searchItems: Array<{ id: string; snippet: string; status: string }>,
): CliCall {
  return async (_address, op, params) => {
    ledger.ops.push(op);
    if (op === "record.search") {
      return okEnvelope({
        searchId: `search-${randomUUID()}`,
        items: searchItems,
      });
    }
    if (op === "record.get") {
      const id = String((params as { id?: unknown }).id ?? "");
      const status = ledger.liveStatus.get(id) ?? "active";
      return okEnvelope(
        recordEnvelope(id, status, status === "active" ? 3 : 3),
      );
    }
    if (
      op === "event.append" ||
      op === "record.correct" ||
      op === "record.retire" ||
      op === "record.reactivate"
    ) {
      return okEnvelope({ ok: true });
    }
    return { ok: false, code: "BAD_REQUEST", data: null, deduplicated: false };
  };
}

describe("explicit search: opaque handles, no heat, immutable snapshot", () => {
  it("returns mN handles only and never calls feedback", async () => {
    const f = await openRepo();
    try {
      const ledger: FakeLedger = { ops: [], liveStatus: new Map() };
      const service = makeService(
        f.repo,
        makeCli(ledger, [
          { id: "rec-a", snippet: "alpha", status: "active" },
          { id: "rec-b", snippet: "beta", status: "retired" },
        ]),
      );
      const { sessionId, runId } = completeRun(f.repo);
      const out = await service.searchMemories({
        sessionId,
        runId,
        query: "alpha",
        limit: 5,
      });
      expect(out.hits.map((h) => h.handle)).toEqual(["m1", "m2"]);
      expect(out.hits.map((h) => h.status)).toEqual(["active", "retired"]);
      for (const hit of out.hits) {
        expect(hit.handle).toMatch(/^m[1-9][0-9]*$/);
      }
      expect(JSON.stringify(out)).not.toContain("rec-a");
      expect(ledger.ops).not.toContain("record.feedback");
      // Immutable: a second read of the stored rows keeps the first snapshot.
      const stored = f.repo.listMemorySearchItems(out.searchId);
      expect(stored.map((r) => r.handle)).toEqual(["m1", "m2"]);
    } finally {
      f.close();
    }
  });
});

describe("target binding: ambiguity, scope, single-match", () => {
  it("needs_clarification stages nothing on multi without explicit handle", async () => {
    const f = await openRepo();
    try {
      const ledger: FakeLedger = { ops: [], liveStatus: new Map() };
      const service = makeService(
        f.repo,
        makeCli(ledger, [
          { id: "rec-a", snippet: "alpha", status: "active" },
          { id: "rec-b", snippet: "beta", status: "active" },
        ]),
      );
      const { sessionId, runId } = completeRun(f.repo);
      const search = await service.searchMemories({
        sessionId,
        runId,
        query: "q",
      });
      const before = f.repo.listMemorySearchItems(search.searchId).length;
      expect(before).toBe(2);
      const out = await service.stageMemoryMutation({
        sessionId,
        runId,
        kind: "record.retire",
        searchId: search.searchId,
        idempotencyKey: randomUUID(),
      });
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.code).toBe("needs_clarification");
        expect((out.candidates ?? []).length).toBe(2);
      }
      // Nothing staged: repeating the ambiguous call is still ambiguous
      // (never an idempotency conflict from a phantom operation).
      const again = await service.stageMemoryMutation({
        sessionId,
        runId,
        kind: "record.retire",
        searchId: search.searchId,
        idempotencyKey: randomUUID(),
      });
      expect(again.ok).toBe(false);
      if (!again.ok) expect(again.code).toBe("needs_clarification");
    } finally {
      f.close();
    }
  });

  it("binds exactly one same-scope candidate without explicit handle", async () => {
    const f = await openRepo();
    try {
      const ledger: FakeLedger = { ops: [], liveStatus: new Map() };
      const service = makeService(
        f.repo,
        makeCli(ledger, [
          { id: "rec-only", snippet: "only", status: "active" },
        ]),
      );
      const { sessionId, runId } = completeRun(f.repo);
      const search = await service.searchMemories({
        sessionId,
        runId,
        query: "q",
      });
      const out = await service.stageMemoryMutation({
        sessionId,
        runId,
        kind: "record.retire",
        searchId: search.searchId,
        idempotencyKey: randomUUID(),
      });
      expect(out.ok).toBe(true);
    } finally {
      f.close();
    }
  });

  it("rejects cross-session searchId reuse without staging", async () => {
    const f = await openRepo();
    try {
      const ledger: FakeLedger = { ops: [], liveStatus: new Map() };
      const service = makeService(
        f.repo,
        makeCli(ledger, [{ id: "rec-a", snippet: "a", status: "active" }]),
      );
      const first = completeRun(f.repo);
      const second = completeRun(f.repo);
      const search = await service.searchMemories({
        sessionId: first.sessionId,
        runId: first.runId,
        query: "q",
      });
      const out = await service.stageMemoryMutation({
        sessionId: second.sessionId,
        runId: second.runId,
        kind: "record.retire",
        searchId: search.searchId,
        handle: "m1",
        idempotencyKey: randomUUID(),
      });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.code).toBe("target_not_found");
    } finally {
      f.close();
    }
  });
});

describe("current-target and stale guards, immutable citations", () => {
  it("detail keeps snapshot distinct from live; correct on stale is state_conflict", async () => {
    const f = await openRepo();
    try {
      const ledger: FakeLedger = {
        ops: [],
        liveStatus: new Map([["rec-a", "active"]]),
      };
      const service = makeService(
        f.repo,
        makeCli(ledger, [{ id: "rec-a", snippet: "alpha", status: "active" }]),
      );
      const { sessionId, runId } = completeRun(f.repo);
      const search = await service.searchMemories({
        sessionId,
        runId,
        query: "q",
      });
      // Live record moves to retired after the snapshot was cited.
      ledger.liveStatus.set("rec-a", "retired");
      const detail = await service.getMemoryDetail({
        sessionId,
        searchId: search.searchId,
        handle: "m1",
      });
      expect(detail.snapshot.status).toBe("active");
      expect(detail.current.status).toBe("retired");
      expect(detail.stale).toBe(true);
      const staged = await service.stageMemoryMutation({
        sessionId,
        runId,
        kind: "record.correct",
        searchId: search.searchId,
        handle: "m1",
        correctionBody: "replacement",
        idempotencyKey: randomUUID(),
      });
      expect(staged.ok).toBe(false);
      if (!staged.ok) expect(staged.code).toBe("state_conflict");
      // Historical citation rows are never rebound to latest memory.
      const stored = f.repo.listMemorySearchItems(search.searchId);
      expect(stored[0]?.status).toBe("active");
    } finally {
      f.close();
    }
  });
});

describe("idempotency and stable correction chain", () => {
  it("same key+body replays; drifted body is 409; drain recovers event then correct once", async () => {
    const f = await openRepo();
    try {
      const ledger: FakeLedger = {
        ops: [],
        liveStatus: new Map([["rec-a", "active"]]),
      };
      const service = makeService(
        f.repo,
        makeCli(ledger, [{ id: "rec-a", snippet: "alpha", status: "active" }]),
      );
      const { sessionId, runId } = completeRun(f.repo);
      const search = await service.searchMemories({
        sessionId,
        runId,
        query: "q",
      });
      const key = randomUUID();
      const first = await service.stageMemoryMutation({
        sessionId,
        runId,
        kind: "record.correct",
        searchId: search.searchId,
        handle: "m1",
        correctionBody: "fixed text",
        idempotencyKey: key,
      });
      expect(first.ok).toBe(true);
      if (!first.ok) throw new Error("stage failed");
      const replay = await service.stageMemoryMutation({
        sessionId,
        runId,
        kind: "record.correct",
        searchId: search.searchId,
        handle: "m1",
        correctionBody: "fixed text",
        idempotencyKey: key,
      });
      expect(replay.ok).toBe(true);
      if (replay.ok && first.ok) {
        expect(replay.operationId).toBe(first.operationId);
        expect(replay.deduplicated).toBe(true);
      }
      const drifted = await service.stageMemoryMutation({
        sessionId,
        runId,
        kind: "record.correct",
        searchId: search.searchId,
        handle: "m1",
        correctionBody: "different text",
        idempotencyKey: key,
      });
      expect(drifted.ok).toBe(false);
      if (!drifted.ok) expect(drifted.code).toBe("idempotency_conflict");
      // Drain: the NEW raw source event acks first, then the real correct
      // follows (one due job per tick; the chain fans out across ticks).
      let executed = 0;
      for (let tick = 0; tick < 4; tick += 1) {
        executed += (await service.drainOnce()).executed;
      }
      expect(executed).toBeGreaterThanOrEqual(2);
      expect(ledger.ops).toContain("event.append");
      expect(ledger.ops).toContain("record.correct");
      expect(ledger.ops).not.toContain("record.remember");
      const status = service.getMemoryOperation(sessionId, first.operationId);
      expect(status?.status).toBe("acked");
      const correctCount = ledger.ops.filter(
        (op) => op === "record.correct",
      ).length;
      await service.drainOnce();
      expect(ledger.ops.filter((op) => op === "record.correct").length).toBe(
        correctCount,
      );
    } finally {
      f.close();
    }
  });
});

describe("retire/reactivate lifecycle with durable operation status", () => {
  it("retire acks via drain; operation is session-guarded", async () => {
    const f = await openRepo();
    try {
      const ledger: FakeLedger = {
        ops: [],
        liveStatus: new Map([["rec-a", "active"]]),
      };
      const service = makeService(
        f.repo,
        makeCli(ledger, [{ id: "rec-a", snippet: "alpha", status: "active" }]),
      );
      const { sessionId, runId } = completeRun(f.repo);
      const other = completeRun(f.repo);
      const search = await service.searchMemories({
        sessionId,
        runId,
        query: "q",
      });
      const staged = await service.stageMemoryMutation({
        sessionId,
        runId,
        kind: "record.retire",
        searchId: search.searchId,
        handle: "m1",
        idempotencyKey: randomUUID(),
      });
      expect(staged.ok).toBe(true);
      if (!staged.ok) throw new Error("retire stage failed");
      let status = service.getMemoryOperation(sessionId, staged.operationId);
      expect(status?.status).toBe("pending");
      expect(
        service.getMemoryOperation(other.sessionId, staged.operationId),
      ).toBeNull();
      await service.drainOnce();
      status = service.getMemoryOperation(sessionId, staged.operationId);
      expect(status?.status).toBe("acked");
      // Historical citation snapshot stays as cited (never rebound).
      expect(f.repo.listMemorySearchItems(search.searchId)[0]?.status).toBe(
        "active",
      );
      // Reactivate the now-retired record.
      ledger.liveStatus.set("rec-a", "retired");
      const search2 = await service.searchMemories({
        sessionId,
        runId,
        query: "q2",
      });
      void search2;
      const re = await service.stageMemoryMutation({
        sessionId,
        runId,
        kind: "record.reactivate",
        searchId: search.searchId,
        handle: "m1",
        idempotencyKey: randomUUID(),
      });
      expect(re.ok).toBe(true);
    } finally {
      f.close();
    }
  });
});

describe("bounds and native tool flow", () => {
  it("rejects over-budget search input and keeps broker budgets", async () => {
    const f = await openRepo();
    try {
      const ledger: FakeLedger = { ops: [], liveStatus: new Map() };
      const service = makeService(f.repo, makeCli(ledger, []));
      const { sessionId, runId } = completeRun(f.repo);
      // Overlong queries are deterministically truncated to 500 code
      // points (bounded CLI call), never rejected; blank is rejected.
      const truncated = await service.searchMemories({
        sessionId,
        runId,
        query: "x".repeat(501),
      });
      expect(truncated.hits).toEqual([]);
      await expect(
        service.searchMemories({ sessionId, runId, query: "   " }),
      ).rejects.toBeInstanceOf(MemoryManageError);
      await expect(
        service.searchMemories({ sessionId, runId, query: "q", limit: 9 }),
      ).rejects.toBeInstanceOf(MemoryManageError);
      const missing = await service.stageMemoryMutation({
        sessionId,
        runId,
        kind: "record.correct",
        searchId: "search-x",
        handle: "m1",
        idempotencyKey: randomUUID(),
      });
      expect(missing.ok).toBe(false);
      // Native tool flow: shared broker budgets unchanged, closed categories.
      expect(TOOL_BUDGET_DEFAULTS.maxToolRequestsPerRun).toBe(8);
      const searchReg = createMemorySearchRegistration({
        repo: f.repo,
        port: {
          search: async () => ({ searchId: "s", hits: [] }),
          stage: async () => ({
            status: "target_not_found" as const,
            candidates: [],
          }),
        },
      });
      expect(searchReg.descriptor.category).toBe("read");
      expect(searchReg.descriptor.name).toBe("memory.search");
      const staged = createMemoryStageRegistrations({
        repo: f.repo,
        port: {
          search: async () => ({ searchId: "s", hits: [] }),
          stage: async () => ({
            status: "target_not_found" as const,
            candidates: [],
          }),
        },
      });
      expect(staged.map((r) => r.descriptor.name).sort()).toEqual(
        ["memory.correct", "memory.reactivate", "memory.retire"].sort(),
      );
      for (const reg of staged) {
        expect(reg.descriptor.category).toBe("write");
        expect(reg.proposalOnly).toBe(true);
      }
    } finally {
      f.close();
    }
  });
});

describe("review boundary: real snapshots, trusted origin, replay identity", () => {
  function makeRevisionCli(
    ledger: FakeLedger,
    searchId: string,
    searchItems: Array<{
      id: string;
      snippet: string;
      status: string;
      revision?: number;
    }>,
  ): CliCall {
    return async (_address, op, params) => {
      ledger.ops.push(op);
      if (op === "record.search") {
        return okEnvelope({
          searchId,
          items: searchItems.map((item) => ({
            id: item.id,
            snippet: item.snippet,
            status: item.status,
            ...(item.revision !== undefined ? { revision: item.revision } : {}),
          })),
        });
      }
      if (op === "record.get") {
        const id = String((params as { id?: unknown }).id ?? "");
        const status = ledger.liveStatus.get(id) ?? "active";
        return okEnvelope(recordEnvelope(id, status, 7));
      }
      if (
        op === "event.append" ||
        op === "record.correct" ||
        op === "record.retire" ||
        op === "record.reactivate"
      ) {
        return okEnvelope({ ok: true });
      }
      return {
        ok: false,
        code: "BAD_REQUEST",
        data: null,
        deduplicated: false,
      };
    };
  }

  it("F1 persists the real CLI revision snapshot and every handle resolves", async () => {
    const f = await openRepo();
    try {
      const ledger: FakeLedger = {
        ops: [],
        liveStatus: new Map([["rec-a", "active"]]),
      };
      const service = makeService(
        f.repo,
        makeRevisionCli(ledger, "search-rev-1", [
          { id: "rec-a", snippet: "alpha", status: "active", revision: 7 },
        ]),
      );
      const { sessionId, runId } = completeRun(f.repo);
      const out = await service.searchMemories({
        sessionId,
        runId,
        query: "q",
      });
      expect(out.searchId).toBe("search-rev-1");
      const stored = f.repo.listMemorySearchItems(out.searchId);
      expect(stored.length).toBe(1);
      expect(stored[0]?.revision).toBe(7);
      expect(stored[0]?.status).toBe("active");
      // Every returned handle resolves through the confirmation detail path.
      const detail = await service.getMemoryDetail({
        sessionId,
        searchId: out.searchId,
        handle: "m1",
      });
      expect(detail.snapshot.snippet).toBe("alpha");
      expect(detail.current.revision).toBe(7);
    } finally {
      f.close();
    }
  });

  it("F1 redelivered searchId keeps the FIRST snapshot (never rebound)", async () => {
    const f = await openRepo();
    try {
      const ledger: FakeLedger = { ops: [], liveStatus: new Map() };
      let call = 0;
      const cli: CliCall = async (_address, op) => {
        ledger.ops.push(op);
        if (op === "record.search") {
          call += 1;
          return okEnvelope({
            searchId: "search-fixed",
            items:
              call === 1
                ? [
                    {
                      id: "rec-first",
                      snippet: "first",
                      status: "active",
                      revision: 2,
                    },
                  ]
                : [
                    {
                      id: "rec-second",
                      snippet: "second",
                      status: "active",
                      revision: 9,
                    },
                  ],
          });
        }
        return {
          ok: false,
          code: "BAD_REQUEST",
          data: null,
          deduplicated: false,
        };
      };
      const service = makeService(f.repo, cli);
      const { sessionId, runId } = completeRun(f.repo);
      const first = await service.searchMemories({
        sessionId,
        runId,
        query: "q",
      });
      expect(first.hits[0]?.snippet).toBe("first");
      const second = await service.searchMemories({
        sessionId,
        runId,
        query: "q",
      });
      expect(second.hits[0]?.snippet).toBe("first");
      expect(f.repo.listMemorySearchItems("search-fixed")[0]?.revision).toBe(2);
    } finally {
      f.close();
    }
  });

  it("F2 model-supplied handle on multi-candidate stages NOTHING; trusted UI handle stages", async () => {
    const f = await openRepo();
    try {
      const ledger: FakeLedger = {
        ops: [],
        liveStatus: new Map([
          ["rec-a", "active"],
          ["rec-b", "active"],
        ]),
      };
      const service = makeService(
        f.repo,
        makeCli(ledger, [
          { id: "rec-a", snippet: "alpha", status: "active" },
          { id: "rec-b", snippet: "beta", status: "active" },
        ]),
      );
      const { sessionId, runId } = completeRun(f.repo);
      const search = await service.searchMemories({
        sessionId,
        runId,
        query: "q",
      });
      // Model (untrusted) origin with an explicit m1 on a 2-candidate
      // search: needs_clarification with ZERO staging.
      const modelPick = await service.stageMemoryMutation({
        sessionId,
        runId,
        kind: "record.retire",
        searchId: search.searchId,
        handle: "m1",
        idempotencyKey: randomUUID(),
        trustedSelection: false,
      });
      expect(modelPick.ok).toBe(false);
      if (!modelPick.ok) {
        expect(modelPick.code).toBe("needs_clarification");
        expect((modelPick.candidates ?? []).length).toBe(2);
      }
      // Trusted USER UI selection of the exact handle is allowed.
      const uiPick = await service.stageMemoryMutation({
        sessionId,
        runId,
        kind: "record.retire",
        searchId: search.searchId,
        handle: "m1",
        idempotencyKey: randomUUID(),
        trustedSelection: true,
      });
      expect(uiPick.ok).toBe(true);
    } finally {
      f.close();
    }
  });

  it("F3 exact replay after target state change returns original status (no superseded failure)", async () => {
    const f = await openRepo();
    try {
      const ledger: FakeLedger = {
        ops: [],
        liveStatus: new Map([["rec-a", "active"]]),
      };
      const service = makeService(
        f.repo,
        makeCli(ledger, [{ id: "rec-a", snippet: "alpha", status: "active" }]),
      );
      const { sessionId, runId } = completeRun(f.repo);
      const search = await service.searchMemories({
        sessionId,
        runId,
        query: "q",
      });
      const key = randomUUID();
      const first = await service.stageMemoryMutation({
        sessionId,
        runId,
        kind: "record.correct",
        searchId: search.searchId,
        handle: "m1",
        correctionBody: "fixed text",
        idempotencyKey: key,
      });
      expect(first.ok).toBe(true);
      if (!first.ok) throw new Error("stage failed");
      // The live target moves on (correct applied elsewhere / retired).
      ledger.liveStatus.set("rec-a", "retired");
      const replay = await service.stageMemoryMutation({
        sessionId,
        runId,
        kind: "record.correct",
        searchId: search.searchId,
        handle: "m1",
        correctionBody: "fixed text",
        idempotencyKey: key,
      });
      expect(replay.ok).toBe(true);
      if (replay.ok) {
        expect(replay.operationId).toBe(first.operationId);
        expect(replay.deduplicated).toBe(true);
      }
      // Drifted body under the same key is still a 409, not a rebind.
      const drifted = await service.stageMemoryMutation({
        sessionId,
        runId,
        kind: "record.correct",
        searchId: search.searchId,
        handle: "m1",
        correctionBody: "other text",
        idempotencyKey: key,
      });
      expect(drifted.ok).toBe(false);
      if (!drifted.ok) expect(drifted.code).toBe("idempotency_conflict");
    } finally {
      f.close();
    }
  });

  it("F4 atomic stage rejects drifted outbox payloads with no orphan operation", async () => {
    const f = await openRepo();
    try {
      const { sessionId, runId } = completeRun(f.repo);
      const jobKey = randomUUID();
      const opKey = randomUUID();
      const body = {
        op: "record.retire",
        params: { id: "rec-x", scope: SCOPE },
      };
      const first = f.repo.stageMemoryMutationAtomic(
        {
          jobKind: "record.retire",
          jobSessionId: sessionId,
          jobRunId: runId,
          jobScope: SCOPE,
          jobKey,
          requestJson: JSON.stringify(body),
          operation: {
            kind: "record.retire",
            sessionId,
            runId,
            recordId: "rec-x",
            idempotencyKey: opKey,
            requestHash: "hash-1",
          },
        },
        { now: T0 + 10 },
      );
      expect(first.deduplicated).toBe(false);
      // Same job key, drifted body: conflict, and no second operation row.
      const otherOpKey = randomUUID();
      expect(() =>
        f.repo.stageMemoryMutationAtomic(
          {
            jobKind: "record.retire",
            jobSessionId: sessionId,
            jobRunId: runId,
            jobScope: SCOPE,
            jobKey,
            requestJson: JSON.stringify({
              op: "record.retire",
              params: { id: "rec-y", scope: SCOPE },
            }),
            operation: {
              kind: "record.retire",
              sessionId,
              runId,
              recordId: "rec-y",
              idempotencyKey: otherOpKey,
              requestHash: "hash-2",
            },
          },
          { now: T0 + 11 },
        ),
      ).toThrow();
      expect(f.repo.getMemoryOperationByKey(otherOpKey)).toBeNull();
      expect(f.repo.getMemoryOperationByKey(opKey)?.id).toBe(
        first.operation.id,
      );
    } finally {
      f.close();
    }
  });

  it("F5 correction followup rebind is atomic and drift-conflicts keep the source job", async () => {
    const f = await openRepo();
    try {
      const { sessionId, runId } = completeRun(f.repo);
      const clientKey = randomUUID();
      const correctKey = randomUUID();
      const staged = f.repo.stageMemoryMutationAtomic(
        {
          jobKind: "event.append",
          jobSessionId: sessionId,
          jobRunId: runId,
          jobScope: SCOPE,
          jobKey: randomUUID(),
          requestJson: JSON.stringify({ op: "event.append", params: {} }),
          operation: {
            kind: "record.correct",
            sessionId,
            runId,
            recordId: "rec-a",
            idempotencyKey: clientKey,
            requestHash: "hash-c",
          },
        },
        { now: T0 + 20 },
      );
      const eventJobId = staged.job.id;
      expect(f.repo.getMemoryOperationByKey(clientKey)?.jobId).toBe(eventJobId);
      const correctBody = JSON.stringify({
        op: "record.correct",
        params: { recordId: "rec-a" },
      });
      const bound = f.repo.bindCorrectionFollowupAtomic(
        {
          sessionId,
          runId,
          scope: SCOPE,
          correctJobKey: correctKey,
          correctRequestJson: correctBody,
          clientKey,
        },
        { now: T0 + 21 },
      );
      expect(f.repo.getMemoryOperationByKey(clientKey)?.jobId).toBe(
        bound.correctJobId,
      );
      // Idempotent replay reuses the same correct job.
      const again = f.repo.bindCorrectionFollowupAtomic(
        {
          sessionId,
          runId,
          scope: SCOPE,
          correctJobKey: correctKey,
          correctRequestJson: correctBody,
          clientKey,
        },
        { now: T0 + 22 },
      );
      expect(again.correctJobId).toBe(bound.correctJobId);
      expect(again.deduplicated).toBe(true);
      // Drifted correct payload under the same key: conflict, binding kept.
      expect(() =>
        f.repo.bindCorrectionFollowupAtomic(
          {
            sessionId,
            runId,
            scope: SCOPE,
            correctJobKey: correctKey,
            correctRequestJson: JSON.stringify({
              op: "record.correct",
              params: { recordId: "rec-other" },
            }),
            clientKey,
          },
          { now: T0 + 23 },
        ),
      ).toThrow();
      expect(f.repo.getMemoryOperationByKey(clientKey)?.jobId).toBe(
        bound.correctJobId,
      );
    } finally {
      f.close();
    }
  });

  it("F6 terminal CLI rejection fails the bound operation (no endless pending)", async () => {
    const f = await openRepo();
    try {
      const ledger: FakeLedger = {
        ops: [],
        liveStatus: new Map([["rec-a", "active"]]),
      };
      const failingCli: CliCall = async (_address, op, params) => {
        ledger.ops.push(op);
        if (op === "record.search") {
          return okEnvelope({
            searchId: `search-${randomUUID()}`,
            items: [{ id: "rec-a", snippet: "alpha", status: "active" }],
          });
        }
        if (op === "record.get") {
          const id = String((params as { id?: unknown }).id ?? "");
          return okEnvelope(recordEnvelope(id, "active", 3));
        }
        if (op === "record.retire") {
          return {
            ok: false,
            code: "NOT_FOUND",
            data: null,
            deduplicated: false,
          };
        }
        if (
          op === "event.append" ||
          op === "record.correct" ||
          op === "record.reactivate"
        ) {
          return okEnvelope({ ok: true });
        }
        return {
          ok: false,
          code: "BAD_REQUEST",
          data: null,
          deduplicated: false,
        };
      };
      const service = makeService(f.repo, failingCli);
      const { sessionId, runId } = completeRun(f.repo);
      const search = await service.searchMemories({
        sessionId,
        runId,
        query: "q",
      });
      const staged = await service.stageMemoryMutation({
        sessionId,
        runId,
        kind: "record.retire",
        searchId: search.searchId,
        handle: "m1",
        idempotencyKey: randomUUID(),
      });
      expect(staged.ok).toBe(true);
      if (!staged.ok) throw new Error("stage failed");
      await service.drainOnce();
      expect(
        service.getMemoryOperation(sessionId, staged.operationId)?.status,
      ).toBe("failed");
    } finally {
      f.close();
    }
  });

  it("F6 exhausted transient attempts fail the bound operation atomically", async () => {
    const f = await openRepo();
    try {
      const { sessionId, runId } = completeRun(f.repo);
      const staged = f.repo.stageMemoryMutationAtomic(
        {
          jobKind: "record.retire",
          jobSessionId: sessionId,
          jobRunId: runId,
          jobScope: SCOPE,
          jobKey: randomUUID(),
          requestJson: JSON.stringify({ op: "record.retire", params: {} }),
          operation: {
            kind: "record.retire",
            sessionId,
            runId,
            recordId: "rec-a",
            idempotencyKey: randomUUID(),
            requestHash: "hash-t",
          },
        },
        { now: T0 + 30 },
      );
      // Seven transient failures stay pending; the eighth exhausts and the
      // operation flips to failed in the SAME transaction.
      for (let attempt = 0; attempt < 7; attempt += 1) {
        const outcome = f.repo.failMemoryJobWithOperationMirror(
          staged.job.id,
          "cli_unavailable",
          {
            maxAttempts: 8,
            now: T0 + 31 + attempt,
          },
        );
        expect(outcome.status).toBe("pending");
        expect(f.repo.getMemoryOperation(staged.operation.id)?.status).toBe(
          "pending",
        );
      }
      const final = f.repo.failMemoryJobWithOperationMirror(
        staged.job.id,
        "cli_unavailable",
        {
          maxAttempts: 8,
          now: T0 + 40,
        },
      );
      expect(final.status).toBe("failed");
      expect(f.repo.getMemoryOperation(staged.operation.id)?.status).toBe(
        "failed",
      );
    } finally {
      f.close();
    }
  });

  it("F7 aborted staging throws cancelled and stages nothing", async () => {
    const f = await openRepo();
    try {
      const ledger: FakeLedger = {
        ops: [],
        liveStatus: new Map([["rec-a", "active"]]),
      };
      const service = makeService(
        f.repo,
        makeCli(ledger, [{ id: "rec-a", snippet: "alpha", status: "active" }]),
      );
      const { sessionId, runId } = completeRun(f.repo);
      const search = await service.searchMemories({
        sessionId,
        runId,
        query: "q",
      });
      const controller = new AbortController();
      controller.abort();
      await expect(
        service.stageMemoryMutation({
          sessionId,
          runId,
          kind: "record.retire",
          searchId: search.searchId,
          handle: "m1",
          idempotencyKey: randomUUID(),
          signal: controller.signal,
        }),
      ).rejects.toBeInstanceOf(MemoryManageCancelled);
      await expect(
        service.searchMemories({
          sessionId,
          runId,
          query: "q",
          signal: controller.signal,
        }),
      ).rejects.toBeInstanceOf(MemoryManageCancelled);
    } finally {
      f.close();
    }
  });
});

describe("codex review 215f852: atomic ack, draining identity, owner, schemas, code points, recall", () => {
  it("F1 atomic ack trigger failure commits neither job nor operation", async () => {
    const handle = openKernelDatabase(":memory:");
    await migrateKernelDatabase({ db: handle.raw });
    const repo = createKernelRepository(handle.raw);
    try {
      const { sessionId, runId } = completeRun(repo);
      const staged = repo.stageMemoryMutationAtomic(
        {
          jobKind: "record.retire",
          jobSessionId: sessionId,
          jobRunId: runId,
          jobScope: SCOPE,
          jobKey: randomUUID(),
          requestJson: JSON.stringify({ op: "record.retire", params: {} }),
          operation: {
            kind: "record.retire",
            sessionId,
            runId,
            recordId: "rec-atomic",
            idempotencyKey: randomUUID(),
            requestHash: "hash-atomic",
          },
        },
        { now: T0 + 100 },
      );
      // Real SQL failure inside the mirror transaction: abort the operation
      // flip so the job flip must roll back too (neither commits).
      handle.raw.exec(
        `CREATE TRIGGER fail_memory_op_mirror BEFORE UPDATE ON memory_operations BEGIN SELECT RAISE(ABORT, 'mirror-fail'); END;`,
      );
      try {
        expect(() =>
          repo.ackMemoryJobWithOperationMirror(staged.job.id, {
            now: T0 + 101,
          }),
        ).toThrow();
        expect(repo.getMemoryJob(staged.job.id)?.status).toBe("pending");
        expect(repo.getMemoryOperation(staged.operation.id)?.status).toBe(
          "pending",
        );
      } finally {
        handle.raw.exec(`DROP TRIGGER fail_memory_op_mirror;`);
      }
      // Without the failing trigger the same atomic path commits both.
      repo.ackMemoryJobWithOperationMirror(staged.job.id, { now: T0 + 102 });
      expect(repo.getMemoryJob(staged.job.id)?.status).toBe("acked");
      expect(repo.getMemoryOperation(staged.operation.id)?.status).toBe(
        "acked",
      );
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("F3 draining replay shares immutable identity: exact matches, drift nulls", async () => {
    const f = await openRepo();
    try {
      const ledger: FakeLedger = {
        ops: [],
        liveStatus: new Map([["rec-a", "active"]]),
      };
      const service = makeService(
        f.repo,
        makeCli(ledger, [{ id: "rec-a", snippet: "alpha", status: "active" }]),
      );
      const { sessionId, runId } = completeRun(f.repo);
      const search = await service.searchMemories({
        sessionId,
        runId,
        query: "q",
      });
      const key = randomUUID();
      const staged = await service.stageMemoryMutation({
        sessionId,
        runId,
        kind: "record.retire",
        searchId: search.searchId,
        handle: "m1",
        idempotencyKey: key,
      });
      expect(staged.ok).toBe(true);
      if (!staged.ok) throw new Error("stage failed");
      const stored = f.repo.getMemoryOperationByKey(key.toLowerCase());
      expect(stored).not.toBeNull();
      // Exact same request recomputes the identical immutable hash/record.
      const exact = service.hashDrainingReplay({
        kind: "record.retire",
        sessionId,
        searchId: search.searchId,
        handle: "m1",
      });
      expect(exact).not.toBeNull();
      expect(exact?.requestHash).toBe(stored?.requestHash);
      expect(exact?.recordId).toBe(stored?.recordId);
      // Drifted kind/body/target yields a different identity (route 409).
      const driftKind = service.hashDrainingReplay({
        kind: "record.reactivate",
        sessionId,
        searchId: search.searchId,
        handle: "m1",
      });
      expect(driftKind?.requestHash).not.toBe(stored?.requestHash);
      const driftBody = service.hashDrainingReplay({
        kind: "record.correct",
        sessionId,
        searchId: search.searchId,
        handle: "m1",
        correctionBody: "other",
      });
      expect(driftBody?.requestHash).not.toBe(stored?.requestHash);
      // Unverifiable target (unknown handle) is null (route falls to 503).
      expect(
        service.hashDrainingReplay({
          kind: "record.retire",
          sessionId,
          searchId: search.searchId,
          handle: "m9",
        }),
      ).toBeNull();
    } finally {
      f.close();
    }
  });

  it("F7 redelivered searchId for another owner with same count fails closed", async () => {
    const f = await openRepo();
    try {
      const ledger: FakeLedger = { ops: [], liveStatus: new Map() };
      let call = 0;
      const cli: CliCall = async (_address, op) => {
        ledger.ops.push(op);
        if (op === "record.search") {
          call += 1;
          return okEnvelope({
            searchId: "search-collide",
            items:
              call === 1
                ? [
                    {
                      id: "rec-owner-a",
                      snippet: "owner-a-snip",
                      status: "active",
                    },
                  ]
                : [
                    {
                      id: "rec-owner-b",
                      snippet: "owner-b-snip",
                      status: "active",
                    },
                  ],
          });
        }
        return {
          ok: false,
          code: "BAD_REQUEST",
          data: null,
          deduplicated: false,
        };
      };
      const service = makeService(f.repo, cli);
      const first = completeRun(f.repo);
      const outA = await service.searchMemories({
        sessionId: first.sessionId,
        runId: first.runId,
        query: "same-query",
      });
      expect(outA.hits[0]?.snippet).toBe("owner-a-snip");
      // Different session/run, same count (1): must NOT receive owner A's row.
      const second = completeRun(f.repo);
      await expect(
        service.searchMemories({
          sessionId: second.sessionId,
          runId: second.runId,
          query: "same-query",
        }),
      ).rejects.toBeInstanceOf(MemoryManageError);
      // First owner's stored snapshot is untouched (never rebound).
      expect(f.repo.listMemorySearchItems("search-collide")[0]?.snippet).toBe(
        "owner-a-snip",
      );
    } finally {
      f.close();
    }
  });

  it("F8 per-tool schemas enforce correctionBody required/forbidden (behavior)", async () => {
    const { buildAgentToolDefinitions } = await import("@companion/kernel");
    const { MemoryCorrectToolInputSchema, MemoryRetireToolInputSchema } =
      await import("@companion/kernel");
    // Runtime Zod behavior: correct requires the body, retire rejects it.
    expect(
      MemoryCorrectToolInputSchema.safeParse({
        searchId: "s1",
        handle: "m1",
        correctionBody: "fix",
      }).success,
    ).toBe(true);
    expect(
      MemoryCorrectToolInputSchema.safeParse({ searchId: "s1", handle: "m1" })
        .success,
    ).toBe(false);
    expect(
      MemoryRetireToolInputSchema.safeParse({ searchId: "s1", handle: "m1" })
        .success,
    ).toBe(true);
    expect(
      MemoryRetireToolInputSchema.safeParse({
        searchId: "s1",
        handle: "m1",
        correctionBody: "fix",
      }).success,
    ).toBe(false);
    // Advertised agent schemas stay consistent with the runtime gate.
    const tools = buildAgentToolDefinitions([
      { name: "memory.correct", description: "c", category: "write" },
      { name: "memory.retire", description: "r", category: "write" },
      { name: "memory.reactivate", description: "ra", category: "write" },
    ] as never);
    const byName = new Map(tools.map((tool) => [tool.name, tool.parameters]));
    const correctParams = byName.get("memory.correct") as {
      required?: string[];
      properties?: Record<string, unknown>;
    };
    const retireParams = byName.get("memory.retire") as {
      required?: string[];
      properties?: Record<string, unknown>;
    };
    const reactivateParams = byName.get("memory.reactivate") as {
      required?: string[];
      properties?: Record<string, unknown>;
    };
    expect(correctParams.required).toContain("correctionBody");
    expect("correctionBody" in (correctParams.properties ?? {})).toBe(true);
    expect("correctionBody" in (retireParams.properties ?? {})).toBe(false);
    expect("correctionBody" in (reactivateParams.properties ?? {})).toBe(false);
  });

  it("F9 code-point budgets accept astral input at the boundary and reject over", async () => {
    const {
      MemorySearchRequestSchema,
      MemoryMutationRequestSchema,
      MemoryHitSchema,
    } = await import("@companion/contracts");
    const runId = randomUUID();
    const emoji = (count: number): string => "😀".repeat(count);
    // 300 emoji (300 code points, 600 UTF-16 units) is valid for a 500 budget.
    expect(
      MemorySearchRequestSchema.safeParse({ query: emoji(300), runId }).success,
    ).toBe(true);
    expect(
      MemorySearchRequestSchema.safeParse({ query: emoji(501), runId }).success,
    ).toBe(false);
    expect(
      MemoryMutationRequestSchema.safeParse({
        kind: "record.correct",
        searchId: "s1",
        handle: "m1",
        correctionBody: emoji(2000),
        runId,
      }).success,
    ).toBe(true);
    expect(
      MemoryMutationRequestSchema.safeParse({
        kind: "record.correct",
        searchId: "s1",
        handle: "m1",
        correctionBody: emoji(2001),
        runId,
      }).success,
    ).toBe(false);
    expect(
      MemoryHitSchema.safeParse({
        handle: "m1",
        snippet: emoji(512),
        status: "active",
      }).success,
    ).toBe(true);
    expect(
      MemoryHitSchema.safeParse({
        handle: "m1",
        snippet: emoji(513),
        status: "active",
      }).success,
    ).toBe(false);
  });

  it("F2 recall exposure binds the originating run (no cross-run/search remap)", async () => {
    const f = await openRepo();
    try {
      const ledger: FakeLedger = { ops: [], liveStatus: new Map() };
      const service = makeService(f.repo, makeCli(ledger, []));
      const first = completeRun(f.repo);
      const second = completeRun(f.repo);
      f.repo.recordMemoryExposure({
        recallId: "recall-first",
        recordId: "rec-first",
        sessionId: first.sessionId,
        runId: first.runId,
        scope: SCOPE,
        citation: "m1",
        snippet: "first-run-snippet",
      });
      // Same run+session+handle resolves to the exact immutable snippet.
      expect(
        service.getMemoryRecallExposure({
          sessionId: first.sessionId,
          runId: first.runId,
          citation: "m1",
        }),
      ).toEqual({
        runId: first.runId,
        citation: "m1",
        snippet: "first-run-snippet",
        // I04 additive: this exposure carries no pinned provenance.
        revision: null,
        kind: null,
      });
      // Another run's same ordinal never resolves through this run.
      expect(
        service.getMemoryRecallExposure({
          sessionId: second.sessionId,
          runId: second.runId,
          citation: "m1",
        }),
      ).toBeNull();
      // Cross-session use of the same run never resolves.
      expect(
        service.getMemoryRecallExposure({
          sessionId: second.sessionId,
          runId: first.runId,
          citation: "m1",
        }),
      ).toBeNull();
    } finally {
      f.close();
    }
  });
});
