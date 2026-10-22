// Conversation-memory graph service regressions: stable handle reuse,
// status-change handle minting, server-only raw ids, version-cached global
// opens, bounded pagination/truncation, local center/edge mapping, session
// binding, and old-remind unavailability.
//
// Real migrated `:memory:` kernel DB + injected fake remind CLI (behavioral
// contract only). No child, no remind DB, no network.

import { randomUUID } from "node:crypto";
import { buildRunResultV2 } from "@companion/contracts";
import {
  closeKernelDatabase,
  createKernelRepository,
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

interface RawNode {
  id: string;
  label: string;
  status: "active" | "retired";
  kind: string;
  episode: {
    kind: "session" | "doc" | "day";
    episodeKey: string;
    level: "window" | "episode";
  } | null;
  /** Real graph.page adjacency shape (`danglingOut` counts omitted refs). */
  out?: Array<{ to: string; kind: "related" | "consolidation" }>;
  danglingOut?: number;
}

interface GraphState {
  /** Opaque remind graph.version token (real contract is a string). */
  version: string;
  nodes: RawNode[];
  local: {
    center: string | null;
    nodes: Array<Omit<RawNode, "out">>;
    edges: Array<{
      from: string;
      to: string;
      kind: "related" | "consolidation";
    }>;
    truncated?: boolean;
  };
  badRequest?: boolean;
  versionCalls: number;
  pageCalls: number;
  ops: string[];
}

function okEnvelope(data: Record<string, unknown> | null): MemoryCliEnvelope {
  return { ok: true, code: "OK", data, deduplicated: false };
}

function node(
  id: string,
  status: "active" | "retired" = "active",
  out?: RawNode["out"],
): RawNode {
  return {
    id,
    label: `label-${id.replace("rec-", "")}`,
    status,
    kind: "user_fact",
    episode:
      id === "rec-b"
        ? { kind: "day", episodeKey: "2026-10-21", level: "window" }
        : null,
    ...(out !== undefined ? { out, danglingOut: 0 } : {}),
  };
}

function makeCli(state: GraphState): CliCall {
  return async (_address, op, params) => {
    state.ops.push(op);
    if (state.badRequest === true) {
      return {
        ok: false,
        code: "BAD_REQUEST",
        data: null,
        deduplicated: false,
      };
    }
    if (op === "record.search") {
      return okEnvelope({
        searchId: "source-search",
        items: [
          { id: "rec-a", snippet: "alpha", status: "active" },
          { id: "rec-b", snippet: "beta", status: "active" },
        ],
      });
    }
    if (op === "graph.version") {
      state.versionCalls += 1;
      return okEnvelope({ version: state.version });
    }
    if (op === "graph.page") {
      state.pageCalls += 1;
      const limit = Number(params.limit);
      const cursor = params.cursor;
      const start = typeof cursor === "string" ? Number(cursor) : 0;
      const end = start + limit;
      const pageNodes = state.nodes.slice(start, end);
      return okEnvelope({
        nodes: pageNodes,
        nextCursor: end < state.nodes.length ? String(end) : null,
        version: state.version,
      });
    }
    if (op === "graph.local") {
      return okEnvelope({
        center: state.local.center,
        nodes: state.local.nodes,
        edges: state.local.edges,
        truncated: state.local.truncated ?? false,
        version: state.version,
      });
    }
    return { ok: false, code: "BAD_REQUEST", data: null, deduplicated: false };
  };
}

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

function makeService(
  repo: KernelRepository,
  cliCall: CliCall,
  graphPageLimit?: number,
): MemoryService {
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
    ...(graphPageLimit !== undefined ? { graphPageLimit } : {}),
  });
  services.push(service);
  return service;
}

function completeRun(repo: KernelRepository): {
  sessionId: string;
  runId: string;
} {
  const sessionId = repo.createSession({ key: randomUUID(), now: T0 }).body
    .sessionId;
  const posted = repo.postMessage(
    sessionId,
    { text: "hello" },
    { key: randomUUID(), now: T0 + 1 },
  );
  const runId = posted.body.run.id;
  repo.startRun(runId, { now: T0 + 2 });
  repo.completeRun(
    runId,
    buildRunResultV2({ version: 1, parts: [{ text: "hello", citations: [] }] }),
    { now: T0 + 3 },
  );
  return { sessionId, runId };
}

function state(): GraphState {
  return {
    version: "o1:r2.2:a3:e0.0.",
    nodes: [
      node("rec-a", "active", [{ to: "rec-b", kind: "related" }]),
      node("rec-b"),
    ],
    local: {
      center: "rec-a",
      nodes: [node("rec-a"), node("rec-b")],
      edges: [{ from: "rec-a", to: "rec-b", kind: "related" }],
    },
    versionCalls: 0,
    pageCalls: 0,
    ops: [],
  };
}

describe("global graph: stable opaque handles", () => {
  it("reuses handles and inserts zero rows when version is unchanged", async () => {
    const f = await openRepo();
    try {
      const graph = state();
      const service = makeService(f.repo, makeCli(graph));
      const { sessionId, runId } = completeRun(f.repo);

      const first = await service.getMemoryGraphGlobal(sessionId, { runId });
      expect(first.scope).toBe("global");
      expect(first.nodes.map((n) => n.handle)).toEqual(["m1", "m2"]);
      expect(first.edges).toEqual([{ from: "m1", to: "m2", kind: "related" }]);
      expect(first.truncated).toBe(false);
      expect(first.nodes[1]?.episode).toEqual({
        kind: "day",
        episodeKey: "2026-10-21",
        level: "window",
      });
      expect(first.version).toBe("o1:r2.2:a3:e0.0.");
      expect(JSON.stringify(first)).not.toContain("rec-a");
      expect(JSON.stringify(first)).not.toContain("rec-b");
      expect(f.repo.listMemorySearchItems(first.searchId)).toHaveLength(2);
      expect(f.repo.getMemorySearch(first.searchId)?.query).toBe("graph");
      expect(graph.pageCalls).toBe(1);

      const second = await service.getMemoryGraphGlobal(sessionId, { runId });
      expect(second.searchId).toBe(first.searchId);
      expect(second.nodes.map((n) => n.handle)).toEqual(["m1", "m2"]);
      // Same version: version is re-checked, but no graph.page call and no
      // new snapshot rows.
      expect(graph.versionCalls).toBe(2);
      expect(graph.pageCalls).toBe(1);
      expect(f.repo.listMemorySearchItems(first.searchId)).toHaveLength(2);
      expect(graph.ops).not.toContain("record.feedback");
    } finally {
      f.close();
    }
  });

  it("mints a new handle only for the node whose status changed", async () => {
    const f = await openRepo();
    try {
      const graph = state();
      const service = makeService(f.repo, makeCli(graph));
      const { sessionId, runId } = completeRun(f.repo);

      const first = await service.getMemoryGraphGlobal(sessionId, { runId });
      expect(first.nodes.map((n) => n.handle)).toEqual(["m1", "m2"]);

      graph.version = "o2:r3.2:a4:e0.0.";
      graph.nodes[0] = node("rec-a", "retired", [
        { to: "rec-b", kind: "consolidation" },
      ]);
      const second = await service.getMemoryGraphGlobal(sessionId, { runId });
      expect(second.searchId).toBe(first.searchId);
      expect(second.nodes.map((n) => n.handle)).toEqual(["m3", "m2"]);
      expect(second.nodes.map((n) => n.status)).toEqual(["retired", "active"]);
      expect(second.edges).toEqual([
        { from: "m3", to: "m2", kind: "consolidation" },
      ]);
      const rows = f.repo.listMemorySearchItems(first.searchId);
      expect(rows.map((r) => [r.handle, r.status])).toEqual([
        ["m1", "active"],
        ["m2", "active"],
        ["m3", "retired"],
      ]);
      // Historical handle still resolves unchanged.
      expect(f.repo.getMemorySearchItem(first.searchId, "m1")?.recordId).toBe(
        "rec-a",
      );
    } finally {
      f.close();
    }
  });

  it("follows nextCursor pages", async () => {
    const f = await openRepo();
    try {
      const graph = state();
      graph.nodes = [node("rec-a"), node("rec-b"), node("rec-c")];
      const service = makeService(f.repo, makeCli(graph), 2);
      const { sessionId, runId } = completeRun(f.repo);

      const out = await service.getMemoryGraphGlobal(sessionId, { runId });
      expect(out.nodes.map((n) => n.handle)).toEqual(["m1", "m2", "m3"]);
      expect(graph.pageCalls).toBe(2);
      expect(out.truncated).toBe(false);
    } finally {
      f.close();
    }
  });

  it("stops at 500 nodes and reports truncation", async () => {
    const f = await openRepo();
    try {
      const graph = state();
      graph.nodes = Array.from({ length: 501 }, (_value, index) =>
        node(`rec-${index + 1}`),
      );
      const service = makeService(f.repo, makeCli(graph), 500);
      const { sessionId, runId } = completeRun(f.repo);

      const out = await service.getMemoryGraphGlobal(sessionId, { runId });
      expect(out.nodes).toHaveLength(500);
      expect(out.truncated).toBe(true);
      expect(graph.pageCalls).toBe(1);
    } finally {
      f.close();
    }
  });

  it("skips malformed nodes fail-closed instead of crashing or leaking", async () => {
    const f = await openRepo();
    try {
      const graph = state();
      graph.nodes = [
        node("rec-a", "active", [{ to: "rec-b", kind: "related" }]),
        node("rec-b"),
        // Malformed nodes: empty id, wrong status, missing label, and a
        // non-string kind. Each is dropped whole (no node, no edge).
        {
          id: "",
          label: "bad",
          status: "active",
          kind: "user_fact",
          episode: null,
        },
        {
          id: "rec-c",
          label: "bad",
          status: "archived",
          kind: "user_fact",
          episode: null,
        },
        { id: "rec-d", status: "active", kind: "user_fact", episode: null },
        { id: "rec-e", label: "bad", status: "active", kind: 7, episode: null },
      ] as unknown as RawNode[];
      const service = makeService(f.repo, makeCli(graph));
      const { sessionId, runId } = completeRun(f.repo);

      const out = await service.getMemoryGraphGlobal(sessionId, { runId });
      expect(out.nodes.map((n) => n.handle)).toEqual(["m1", "m2"]);
      expect(out.edges).toEqual([{ from: "m1", to: "m2", kind: "related" }]);
      expect(JSON.stringify(out)).not.toContain("rec-");
    } finally {
      f.close();
    }
  });

  it("maps BAD_REQUEST from old remind to memory_graph_unavailable", async () => {
    const f = await openRepo();
    try {
      const graph = state();
      graph.badRequest = true;
      const service = makeService(f.repo, makeCli(graph));
      const { sessionId, runId } = completeRun(f.repo);

      await expect(
        service.getMemoryGraphGlobal(sessionId, { runId }),
      ).rejects.toMatchObject({
        name: "MemoryManageError",
        code: "memory_graph_unavailable",
      });
      expect(graph.ops).not.toContain("record.feedback");
    } finally {
      f.close();
    }
  });
});

describe("graph shutdown tracking", () => {
  it("cancels and awaits an in-flight graph read on shutdown", async () => {
    const f = await openRepo();
    try {
      const graph = state();
      const base = makeCli(graph);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const enteredPromise = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let aborted = false;
      const cli: CliCall = async (address, op, params, key, options) => {
        if (op !== "graph.version") {
          return base(address, op, params, key, options);
        }
        entered();
        await new Promise<void>((resolve) => {
          const signal = options?.signal;
          if (signal?.aborted === true) {
            aborted = true;
            resolve();
            return;
          }
          signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve();
            },
            { once: true },
          );
          // A deferred CLI release is still harmless: shutdown aborts the
          // read and waits for this promise, so no later page can run.
          void gate.then(() => resolve());
        });
        return base(address, op, params, key, options);
      };
      const service = makeService(f.repo, cli);
      const { sessionId, runId } = completeRun(f.repo);

      const read = service.getMemoryGraphGlobal(sessionId, { runId }).then(
        () => null,
        (error: unknown) => error,
      );
      await enteredPromise;
      await service.stop();
      expect(aborted).toBe(true);
      expect(await read).toBeInstanceOf(MemoryManageCancelled);
      // The aborted version probe never reached graph.page, and no graph
      // projection was minted after shutdown.
      expect(graph.ops).toEqual(["graph.version"]);
      expect(graph.pageCalls).toBe(0);
      release();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(graph.pageCalls).toBe(0);
    } finally {
      f.close();
    }
  });
});

describe("local graph: snapshot binding and center mapping", () => {
  it("maps a search handle to graph handles and never leaks raw ids", async () => {
    const f = await openRepo();
    try {
      const graph = state();
      const service = makeService(f.repo, makeCli(graph));
      const { sessionId, runId } = completeRun(f.repo);
      const search = await service.searchMemories({
        sessionId,
        runId,
        query: "alpha",
      });
      expect(search.hits.map((h) => h.handle)).toEqual(["m1", "m2"]);

      const out = await service.getMemoryGraphLocal(sessionId, {
        searchId: search.searchId,
        handle: "m1",
        depth: 1,
        runId,
      });
      expect(out.scope).toBe("local");
      expect(out.searchId).not.toBe(search.searchId);
      expect(f.repo.getMemorySearch(out.searchId)?.query).toBe("graph");
      expect(out.center).toBe("m1");
      expect(out.nodes.map((n) => n.handle)).toEqual(["m1", "m2"]);
      expect(out.edges).toEqual([{ from: "m1", to: "m2", kind: "related" }]);
      expect(JSON.stringify(out)).not.toContain("rec-a");
      expect(JSON.stringify(out)).not.toContain("rec-b");
      // The graph handle resolves through the existing detail route path.
      expect(
        f.repo.getMemorySearchItem(out.searchId, out.center ?? "")?.recordId,
      ).toBe("rec-a");
    } finally {
      f.close();
    }
  });

  it("rejects a handle from another session", async () => {
    const f = await openRepo();
    try {
      const graph = state();
      const service = makeService(f.repo, makeCli(graph));
      const owner = completeRun(f.repo);
      const other = completeRun(f.repo);
      const search = await service.searchMemories({
        sessionId: owner.sessionId,
        runId: owner.runId,
        query: "alpha",
      });

      await expect(
        service.getMemoryGraphLocal(other.sessionId, {
          searchId: search.searchId,
          handle: "m1",
          depth: 1,
          runId: other.runId,
        }),
      ).rejects.toBeInstanceOf(MemoryManageError);
      await expect(
        service.getMemoryGraphLocal(other.sessionId, {
          searchId: search.searchId,
          handle: "m1",
          depth: 1,
          runId: other.runId,
        }),
      ).rejects.toMatchObject({ code: "target_not_found" });
    } finally {
      f.close();
    }
  });
});
