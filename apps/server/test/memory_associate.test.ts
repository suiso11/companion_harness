// Derived association + topic maintenance (remind PR #29): extraction
// topics ride record.remember as tags, idle topic backfill turns
// topic.pending into topic.set through the model, maintain.associate is
// scheduled after remembers and while work remains, old remind latches
// BAD_REQUEST, and graph projections expose topics/similar edges by handle.
//
// Real migrated `:memory:` kernel DB + injected fake remind CLI (behavioral
// contract only). No child, no remind DB, no network.

import { randomUUID } from "node:crypto";
import { buildRunResultV2 } from "@companion/contracts";
import {
  closeKernelDatabase,
  createKernelRepository,
  generateId,
  type KernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
} from "@companion/kernel";
import type { ChatResult, ModelGateway } from "@companion/model-local";
import { afterEach, describe, expect, it } from "vitest";
import type {
  MemoryCliAddress,
  MemoryCliCallOptions,
  MemoryCliEnvelope,
} from "../src/memory_cli.js";
import {
  createMemoryService,
  MEMORY_DISTILL_TIMEOUT_MS,
  MEMORY_TOPIC_SYSTEM_PROMPT,
  type MemoryService,
  parseExtractionOutput,
  stableMemoryJobKey,
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

interface Fixture {
  repo: KernelRepository;
  close: () => void;
}

async function openRepo(): Promise<Fixture> {
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

function okEnvelope(data: Record<string, unknown> | null): MemoryCliEnvelope {
  return { ok: true, code: "OK", data, deduplicated: false };
}

function rejectedEnvelope(code: string): MemoryCliEnvelope {
  return { ok: false, code, data: null, deduplicated: false };
}

function makeService(
  repo: KernelRepository,
  cliCall: CliCall,
  overrides: {
    gateway?: ModelGateway | null;
    idleMs?: number;
  } = {},
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
    idleMs: overrides.idleMs ?? 300_000,
    repo,
    gateway: overrides.gateway ?? null,
    model: "test-model",
    cliCall,
  });
  services.push(service);
  return service;
}

function gatewayReturning(text: string | ((index: number) => string)): {
  gateway: ModelGateway;
  calls: unknown[];
} {
  const calls: unknown[] = [];
  const gateway: ModelGateway = {
    provider: "openai-compatible",
    capabilities: { toolCalling: false },
    baseUrl: "http://127.0.0.1:9",
    chatUrl: "http://127.0.0.1:9/v1/chat/completions",
    chat: async (request): Promise<ChatResult> => {
      const index = calls.length;
      calls.push(request);
      return {
        text: typeof text === "string" ? text : text(index),
        toolCalls: [],
        stopReason: "stop",
      };
    },
  };
  return { gateway, calls };
}

async function waitFor(
  condition: () => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (condition()) {
      return;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error("waitFor timed out waiting for service state");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Post, start, and durably complete one V2 run; returns its ids. */
function completeV2Run(
  repo: KernelRepository,
  parts: Array<{ text: string; citations: string[] }>,
  text = "hello",
): { sessionId: string; turnId: string; runId: string } {
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
  const result = buildRunResultV2({ version: 1, parts });
  expect(repo.completeRun(runId, result, { now: T0 + 3 }).applied).toBe(true);
  return { sessionId, turnId, runId };
}

function enqueueRememberChain(
  repo: KernelRepository,
  memories: Array<Record<string, unknown>>,
): void {
  const sessionId = generateId();
  const runId = generateId();
  repo.enqueueMemoryJob(
    "event.append",
    sessionId,
    runId,
    SCOPE,
    stableMemoryJobKey("event", runId),
    JSON.stringify({
      op: "event.append",
      params: { eventId: `evt-${runId}`, scope: SCOPE, sessionId, runId },
      chain: {
        eventId: `evt-${runId}`,
        sessionId,
        runId,
        provenance: {
          source: "companion:conversation",
          observedAt: new Date(T0).toISOString(),
        },
        memories,
      },
    }),
    { now: T0 },
  );
}

describe("extraction topics feed record.remember tags", () => {
  it("validates topics, drops invalid entries, and keeps the memory", () => {
    const out = parseExtractionOutput(
      JSON.stringify({
        memories: [
          {
            body: "iphone camera",
            kind: "summary",
            sensitivity: "normal",
            topics: [
              " スマートフォン ",
              "ｶﾒﾗ",
              "スマートフォン",
              "",
              "x".repeat(13),
              "bad\u0001topic",
            ],
          },
          { body: "no topics", kind: "user_fact" },
          { body: "bad topics type", kind: "user_fact", topics: "not-array" },
        ],
      }),
    );
    // NFKC + trim, dedupe, 1..12 cp, max 3; invalid entries are dropped.
    expect(out[0]?.topics).toEqual(["スマートフォン", "カメラ"]);
    // Missing/invalid topics keep the memory exactly as before.
    expect(out[1]).toEqual({
      body: "no topics",
      kind: "user_fact",
      sensitivity: "sensitive",
    });
    expect(out[2]).toEqual({
      body: "bad topics type",
      kind: "user_fact",
      sensitivity: "sensitive",
    });
  });

  it("passes validated extraction topics as record.remember tags", async () => {
    const f = await openRepo();
    try {
      const remembered: Array<Record<string, unknown>> = [];
      const cliCall: CliCall = async (_address, op, params) => {
        if (op === "record.remember") {
          remembered.push(params);
        }
        return okEnvelope(null);
      };
      const { gateway } = gatewayReturning(
        JSON.stringify({
          memories: [
            {
              body: "user likes the iphone camera",
              kind: "summary",
              sensitivity: "normal",
              topics: ["スマートフォン", "カメラ", "スマートフォン"],
            },
            {
              body: "user likes tea",
              kind: "user_fact",
              sensitivity: "normal",
              topics: ["", "x".repeat(13), "飲み物"],
            },
            { body: "legacy item", kind: "user_fact", sensitivity: "normal" },
          ],
        }),
      );
      const service = makeService(f.repo, cliCall, { gateway });
      service.start();
      const run = completeV2Run(f.repo, [{ text: "answered", citations: [] }]);
      service.onRunCompleted(run.runId);
      await waitFor(() => remembered.length === 3, 5000);
      const byBody = new Map(remembered.map((params) => [params.body, params]));
      expect(byBody.get("user likes the iphone camera")?.tags).toEqual([
        "スマートフォン",
        "カメラ",
      ]);
      expect(byBody.get("user likes tea")?.tags).toEqual(["飲み物"]);
      // Existing jobs/paths without topics still send the legacy empty tags.
      expect(byBody.get("legacy item")?.tags).toEqual([]);
    } finally {
      f.close();
    }
  });
});

describe("idle topic backfill", () => {
  it("calls topic.pending -> model -> topic.set with stable keys, bounded to 8", async () => {
    const f = await openRepo();
    try {
      const pendingCalls: Array<Record<string, unknown>> = [];
      const setCalls: Array<{
        params: Record<string, unknown>;
        key: string | undefined;
      }> = [];
      const associateCalls: Array<{
        params: Record<string, unknown>;
        key: string | undefined;
        timeoutMs: number | undefined;
      }> = [];
      const items = Array.from({ length: 10 }, (_value, index) => ({
        id: `rec-${index}`,
        bodyHash: `hash-${index}`,
        body: `memory ${index}`,
        truncated: false,
      }));
      let pendingPage = 0;
      const cliCall: CliCall = async (_address, op, params, key, options) => {
        if (op === "topic.pending") {
          pendingCalls.push(params);
          pendingPage += 1;
          return okEnvelope(
            pendingPage === 1
              ? { items, remaining: 0 }
              : { items: [], remaining: 0 },
          );
        }
        if (op === "topic.set") {
          setCalls.push({ params, key });
          return okEnvelope({ topic: {} });
        }
        if (op === "maintain.associate") {
          associateCalls.push({
            params,
            key,
            timeoutMs: options?.timeoutMs,
          });
          return okEnvelope({ associate: { remaining: 0 } });
        }
        return okEnvelope(null);
      };
      const { gateway, calls: prompts } = gatewayReturning(
        '{"topics":["スマートフォン","カメラ"]}',
      );
      const service = makeService(f.repo, cliCall, { gateway, idleMs: 30 });
      service.start();
      await waitFor(() => setCalls.length === 8, 5000);

      expect(pendingCalls[0]).toMatchObject({ scope: SCOPE, limit: 8 });
      // Bounded per idle tick: the 10-item page is cut to 8.
      expect(setCalls).toHaveLength(8);
      for (let index = 0; index < setCalls.length; index += 1) {
        const call = setCalls[index];
        expect(call?.key).toBe(
          stableMemoryJobKey("topic", `rec-${index}`, `hash-${index}`),
        );
        expect(call?.params).toMatchObject({
          scope: SCOPE,
          id: `rec-${index}`,
          bodyHash: `hash-${index}`,
          topics: ["カメラ", "スマートフォン"],
        });
        expect(call?.params).not.toHaveProperty("runId");
      }
      // Then exactly one maintain.associate per idle tick with the long
      // distill-grade deadline; remaining=0 means no immediate re-run.
      await waitFor(() => associateCalls.length >= 1, 5000);
      expect(associateCalls[0]?.params).toEqual({ scope: SCOPE });
      expect(associateCalls[0]?.key).toBeDefined();
      expect(associateCalls[0]?.timeoutMs).toBe(MEMORY_DISTILL_TIMEOUT_MS);
      const associateCount = associateCalls.length;
      await sleep(200);
      expect(associateCalls.length).toBe(associateCount);
      const systems = prompts.map(
        (request) =>
          (request as { messages: Array<{ content: string }> }).messages[0]
            ?.content,
      );
      expect(systems).toContain(MEMORY_TOPIC_SYSTEM_PROMPT);
    } finally {
      f.close();
    }
  });
});

describe("maintain.associate scheduling", () => {
  it("calls once after a remember, then stops at remaining=0", async () => {
    const f = await openRepo();
    try {
      const associateCalls: Array<string | undefined> = [];
      const cliCall: CliCall = async (_address, op, _params, key) => {
        if (op === "maintain.associate") {
          associateCalls.push(key);
          return okEnvelope({ associate: { remaining: 0 } });
        }
        return okEnvelope(null);
      };
      const service = makeService(f.repo, cliCall, { idleMs: 30 });
      service.start();
      // One association pass for the existing store.
      await waitFor(() => associateCalls.length >= 1, 5000);
      await sleep(120);
      expect(associateCalls).toHaveLength(1);

      // A remember re-arms exactly one more association pass.
      enqueueRememberChain(f.repo, [{ body: "new fact", kind: "user_fact" }]);
      await service.drainOnce();
      await waitFor(() => associateCalls.length >= 2, 5000);
      await sleep(160);
      expect(associateCalls).toHaveLength(2);
      // Per-pass keys make remind recompute instead of replaying a response.
      expect(associateCalls[0]).not.toBe(associateCalls[1]);
      expect(associateCalls[0]).toBeDefined();
      expect(associateCalls[1]).toBeDefined();
    } finally {
      f.close();
    }
  });

  it("repeats while remaining>0 and stops when remaining reaches 0", async () => {
    const f = await openRepo();
    try {
      const keys: Array<string | undefined> = [];
      const remaining = [1, 1, 0];
      const cliCall: CliCall = async (_address, op, _params, key) => {
        if (op === "maintain.associate") {
          const value = remaining[keys.length] ?? 0;
          keys.push(key);
          return okEnvelope({ associate: { remaining: value } });
        }
        return okEnvelope(null);
      };
      const service = makeService(f.repo, cliCall, { idleMs: 30 });
      service.start();
      await waitFor(() => keys.length === 3, 5000);
      await sleep(180);
      // remaining=0 on the third pass stops the loop (no per-tick storm).
      expect(keys).toHaveLength(3);
      expect(new Set(keys).size).toBe(3);
    } finally {
      f.close();
    }
  });
});

describe("old remind compatibility", () => {
  it("latches BAD_REQUEST from topic.pending and maintain.associate", async () => {
    const f = await openRepo();
    try {
      let pendingCalls = 0;
      let associateCalls = 0;
      const cliCall: CliCall = async (_address, op) => {
        if (op === "topic.pending") {
          pendingCalls += 1;
          return rejectedEnvelope("BAD_REQUEST");
        }
        if (op === "maintain.associate") {
          associateCalls += 1;
          return rejectedEnvelope("BAD_REQUEST");
        }
        return okEnvelope(null);
      };
      const { gateway } = gatewayReturning('{"topics":["スマートフォン"]}');
      const service = makeService(f.repo, cliCall, { gateway, idleMs: 30 });
      service.start();
      await waitFor(() => pendingCalls >= 1 && associateCalls >= 1, 5000);
      await sleep(220);
      // Latched until restart: no per-tick retry storm, and no model call.
      expect(pendingCalls).toBe(1);
      expect(associateCalls).toBe(1);
    } finally {
      f.close();
    }
  });
});

interface RawGraphNode {
  id: string;
  label: string;
  status: "active" | "retired";
  kind: string;
  episode: {
    kind: "session" | "doc" | "day";
    episodeKey: string;
    level: "window" | "episode";
  } | null;
  topics?: string[];
  out?: Array<{ to: string; kind: "related" | "consolidation" | "similar" }>;
  danglingOut?: number;
}

interface GraphState {
  version: string;
  nodes: RawGraphNode[];
  local: {
    center: string | null;
    nodes: Array<Omit<RawGraphNode, "out">>;
    edges: Array<{
      from: string;
      to: string;
      kind: "related" | "consolidation" | "similar";
    }>;
    truncated?: boolean;
  };
}

function graphNode(
  id: string,
  out?: RawGraphNode["out"],
  topics?: string[],
): RawGraphNode {
  return {
    id,
    label: `label-${id.replace("rec-", "")}`,
    status: "active",
    kind: "user_fact",
    ...(topics !== undefined ? { topics } : {}),
    episode: null,
    ...(out !== undefined ? { out, danglingOut: 0 } : {}),
  };
}

function makeGraphCli(state: GraphState): CliCall {
  return async (_address, op, params) => {
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
      return okEnvelope({ version: state.version });
    }
    if (op === "graph.page") {
      const limit = Number(params.limit);
      const cursor = params.cursor;
      const start = typeof cursor === "string" ? Number(cursor) : 0;
      const end = start + limit;
      return okEnvelope({
        nodes: state.nodes.slice(start, end),
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
    return okEnvelope(null);
  };
}

function initialGraphState(): GraphState {
  return {
    version: "o1:r2.2:a3:e0.0.",
    nodes: [graphNode("rec-a"), graphNode("rec-b")],
    local: {
      center: "rec-a",
      nodes: [graphNode("rec-a"), graphNode("rec-b")],
      edges: [{ from: "rec-a", to: "rec-b", kind: "related" }],
    },
  };
}

describe("graph projection exposes topics and similar edges", () => {
  it("maps undirected similar edges to handles and passes topics, no raw ids", async () => {
    const f = await openRepo();
    try {
      const graph = initialGraphState();
      const topics = ["スマートフォン", "カメラ"];
      graph.nodes = [
        graphNode("rec-a", [{ to: "rec-b", kind: "similar" }], topics),
        graphNode("rec-b"),
      ];
      graph.local = {
        center: "rec-a",
        nodes: [graphNode("rec-a", undefined, topics), graphNode("rec-b")],
        // Local remind can emit both directions for one symmetric pair.
        edges: [
          { from: "rec-a", to: "rec-b", kind: "similar" },
          { from: "rec-b", to: "rec-a", kind: "similar" },
        ],
      };
      const service = makeService(f.repo, makeGraphCli(graph));
      const { sessionId, runId } = completeV2Run(f.repo, [
        { text: "hello", citations: [] },
      ]);

      const global = await service.getMemoryGraphGlobal(sessionId, { runId });
      expect(global.nodes[0]?.topics).toEqual(topics);
      expect(global.nodes[1]).not.toHaveProperty("topics");
      expect(global.edges).toEqual([{ from: "m1", to: "m2", kind: "similar" }]);
      // Raw ids still never cross the projection boundary.
      expect(JSON.stringify(global)).not.toContain("rec-a");
      expect(JSON.stringify(global)).not.toContain("rec-b");

      const local = await service.getMemoryGraphLocal(sessionId, {
        searchId: global.searchId,
        handle: "m1",
        depth: 1,
        runId,
      });
      expect(local.nodes[0]?.topics).toEqual(topics);
      // The mirrored similar pair is deduped to one undirected edge.
      expect(local.edges).toEqual([{ from: "m1", to: "m2", kind: "similar" }]);
      expect(JSON.stringify(local)).not.toContain("rec-a");
      expect(JSON.stringify(local)).not.toContain("rec-b");
    } finally {
      f.close();
    }
  });

  it("drops invalid/oversized topics without dropping the node", async () => {
    const f = await openRepo();
    try {
      const graph = initialGraphState();
      graph.nodes = [
        graphNode("rec-a", undefined, [
          "カメラ",
          "x".repeat(13),
          "bad\u0001topic",
          "カメラ",
        ]),
        graphNode("rec-b"),
      ];
      const service = makeService(f.repo, makeGraphCli(graph));
      const { sessionId, runId } = completeV2Run(f.repo, [
        { text: "hello", citations: [] },
      ]);
      const out = await service.getMemoryGraphGlobal(sessionId, { runId });
      expect(out.nodes).toHaveLength(2);
      expect(out.nodes[0]?.topics).toEqual(["カメラ"]);
    } finally {
      f.close();
    }
  });
});
