// Conversation-memory service behavior: extraction decisions, outbox
// drain transitions, cite-gated feedback, recall fail-open, and
// foreground/shutdown preemption.
//
// The repository is a real migrated `:memory:` kernel DB; the remind CLI
// is an injected fake (behavioral contract only: ops, stable keys, state
// transitions). No real child, no remind DB, no network.

import { randomUUID } from "node:crypto";
import { buildRunResultV2 } from "@companion/contracts";
import {
  closeKernelDatabase,
  createKernelRepository,
  generateId,
  isUuidV4,
  type KernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
} from "@companion/kernel";
import type { ChatResult, ModelGateway } from "@companion/model-local";
import { afterEach, describe, expect, it } from "vitest";
import {
  type BackgroundResourceGate,
  createBackgroundResourceGate,
} from "../src/background_resource.js";
import {
  type MemoryCliAddress,
  type MemoryCliCallOptions,
  type MemoryCliEnvelope,
  MemoryCliError,
} from "../src/memory_cli.js";
import {
  createMemoryService,
  MEMORY_EXTRACT_MAX_ITEMS,
  MEMORY_RECALL_RUN_MARKER,
  type MemoryService,
  parseExtractionOutcome,
  parseExtractionOutput,
  parseRecallData,
  stableMemoryJobKey,
  stripOneJsonFence,
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
  db: {
    prepare: (sql: string) => {
      get: (...params: unknown[]) => unknown;
      all: (...params: unknown[]) => unknown[];
    };
  };
  close: () => void;
}

async function openRepo(): Promise<Fixture> {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  const repo = createKernelRepository(handle.raw);
  return {
    repo,
    db: handle.raw as unknown as Fixture["db"],
    close: () => closeKernelDatabase(handle),
  };
}

/** All outbox rows of one kind for a run, whatever their drain state. */
function outboxRowsByKind(
  f: Fixture,
  kind: string,
  runId: string,
): Array<{ key: string; status: string }> {
  const rows = f.db
    .prepare(
      "SELECT idempotency_key AS key, status FROM memory_outbox WHERE kind = ? AND run_id = ?",
    )
    .all(kind, runId) as Array<{ key: string; status: string }>;
  return rows;
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
    now?: () => number;
    idleMs?: number;
    scope?: string;
    background?: BackgroundResourceGate | null;
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
    scope: overrides.scope ?? SCOPE,
    recallLimit: 5,
    idleMs: overrides.idleMs ?? 300_000,
    repo,
    gateway: overrides.gateway ?? null,
    model: "test-model",
    ...(overrides.now !== undefined ? { now: overrides.now } : {}),
    ...(overrides.background !== undefined
      ? { background: overrides.background }
      : {}),
    cliCall,
  });
  services.push(service);
  return service;
}

function extractionGateway(text: string): {
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
      calls.push(request);
      return { text, toolCalls: [], stopReason: "stop" };
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

describe("parseExtractionOutput model decisions", () => {
  it("accepts the exact shape with bounded valid items", () => {
    const out = parseExtractionOutput(
      JSON.stringify({
        memories: [
          { body: "user likes tea", kind: "user_fact", sensitivity: "normal" },
          { body: "decided Friday", kind: "summary", sensitivity: "sensitive" },
        ],
      }),
    );
    expect(out).toEqual([
      { body: "user likes tea", kind: "user_fact", sensitivity: "normal" },
      { body: "decided Friday", kind: "summary", sensitivity: "sensitive" },
    ]);
  });

  it("fails closed to sensitive on missing/invalid sensitivity", () => {
    const out = parseExtractionOutput(
      JSON.stringify({
        memories: [
          { body: "legacy without sensitivity", kind: "user_fact" },
          { body: "bad value", kind: "summary", sensitivity: "top-secret" },
          { body: "non-string", kind: "user_fact", sensitivity: 42 },
          { body: "explicit normal", kind: "user_fact", sensitivity: "normal" },
        ],
      }),
    );
    expect(out).toEqual([
      {
        body: "legacy without sensitivity",
        kind: "user_fact",
        sensitivity: "sensitive",
      },
      { body: "bad value", kind: "summary", sensitivity: "sensitive" },
      { body: "non-string", kind: "user_fact", sensitivity: "sensitive" },
      { body: "explicit normal", kind: "user_fact", sensitivity: "normal" },
    ]);
  });

  it("treats malformed and empty output as a noop", () => {
    expect(parseExtractionOutput("")).toEqual([]);
    expect(parseExtractionOutput("not json")).toEqual([]);
    expect(parseExtractionOutput("null")).toEqual([]);
    expect(parseExtractionOutput('{"memories":[]}')).toEqual([]);
    expect(parseExtractionOutput('{"memories":{}}')).toEqual([]);
    expect(parseExtractionOutput('{"other":[]}')).toEqual([]);
    expect(parseExtractionOutput('{"memories":[],"extra":1}')).toEqual([]);
  });

  it("strips exactly one surrounding code fence before strict parsing", () => {
    const payload =
      '{"memories":[{"body":"fenced fact","kind":"user_fact","sensitivity":"normal"},{"body":"fenced digest","kind":"summary"}]}';
    expect(stripOneJsonFence(`\`\`\`json\n${payload}\n\`\`\``)).toBe(payload);
    expect(stripOneJsonFence(`\`\`\`\n${payload}\n\`\`\``)).toBe(payload);
    expect(stripOneJsonFence(`  \n\`\`\`json\n${payload}\n\`\`\`  \n`)).toBe(
      payload,
    );
    expect(parseExtractionOutput(`\`\`\`json\n${payload}\n\`\`\``)).toEqual([
      {
        body: "fenced fact",
        kind: "user_fact",
        sensitivity: "normal",
      },
      { body: "fenced digest", kind: "summary", sensitivity: "sensitive" },
    ]);
    // No free-text fallback: prose around the fence is still rejected.
    expect(
      parseExtractionOutput(`Here you go:\n\`\`\`json\n${payload}\n\`\`\``),
    ).toEqual([]);
    // Strict schema inside the fence is unchanged: extra keys still reject.
    expect(
      parseExtractionOutput(
        '```json\n{"memories":[{"body":"x","kind":"user_fact","confidence":1}]}\n```',
      ),
    ).toEqual([]);
  });

  it("splits tri-state outcome: none vs invalid vs ok", () => {
    const validEmpty = parseExtractionOutcome('{"memories":[]}');
    expect(validEmpty.status).toBe("none");
    expect(validEmpty.items).toEqual([]);
    const ok = parseExtractionOutcome(
      '{"memories":[{"body":"b","kind":"summary","sensitivity":"normal"}]}',
    );
    expect(ok.status).toBe("ok");
    expect(ok.items).toHaveLength(1);
    for (const bad of [
      "",
      "not json",
      "null",
      '{"memories":{}}',
      '{"other":[]}',
      '{"memories":[],"extra":1}',
      "```json\nnot json\n```",
      // Raw items present but every one rejected: an output-shape problem.
      '{"memories":[{"body":"x","kind":"episodic"}]}',
      '{"memories":[{"body":"x","kind":"user_fact","confidence":1}]}',
    ]) {
      const outcome = parseExtractionOutcome(bad);
      expect(outcome.status).toBe("invalid");
      expect(outcome.items).toEqual([]);
    }
  });

  it("drops invalid items while keeping valid ones, capped at 16", () => {
    const items: unknown[] = [
      { body: "kept", kind: "user_fact", sensitivity: "normal" },
      { body: "wrong kind", kind: "episodic" },
      { body: "", kind: "user_fact" },
      { body: "x".repeat(2001), kind: "summary" },
      { body: "bad charhere", kind: "user_fact" },
      {
        body: "extra key",
        kind: "user_fact",
        sensitivity: "normal",
        note: 1,
      },
      { body: "missing kind" },
      42,
      null,
    ];
    for (let index = 0; index < 10; index += 1) {
      items.push({
        body: `overflow-${index}`,
        kind: "summary",
        sensitivity: "sensitive",
      });
    }
    const out = parseExtractionOutput(JSON.stringify({ memories: items }));
    expect(out[0]).toEqual({
      body: "kept",
      kind: "user_fact",
      sensitivity: "normal",
    });
    expect(out.length).toBeLessThanOrEqual(MEMORY_EXTRACT_MAX_ITEMS);
    expect(
      out.every((item) => item.kind === "user_fact" || item.kind === "summary"),
    ).toBe(true);
    expect(
      out.every(
        (item) =>
          item.sensitivity === "normal" || item.sensitivity === "sensitive",
      ),
    ).toBe(true);
  });

  it("rejects valid items that lack the mandatory summary (store-everything)", () => {
    // Any valid item set MUST carry at least one summary: without it the
    // turn is unrecallable through raw descent, so the output is invalid.
    const noSummary = parseExtractionOutcome(
      JSON.stringify({
        memories: [
          { body: "user likes tea", kind: "user_fact", sensitivity: "normal" },
          {
            body: "tends to like tea",
            kind: "model_inference",
            sensitivity: "normal",
          },
        ],
      }),
    );
    expect(noSummary.status).toBe("invalid");
    expect(noSummary.items).toEqual([]);
    // Mixed valid/invalid WITH a summary still parses the valid subset.
    const withSummary = parseExtractionOutcome(
      JSON.stringify({
        memories: [
          { body: "digest", kind: "summary", sensitivity: "normal" },
          { body: "x", kind: "episodic" },
        ],
      }),
    );
    expect(withSummary.status).toBe("ok");
    expect(withSummary.items).toEqual([
      { body: "digest", kind: "summary", sensitivity: "normal" },
    ]);
  });
});

describe("stableMemoryJobKey", () => {
  it("is deterministic, v4-shaped, CLI-charset, and distinct per write", () => {
    const first = stableMemoryJobKey("event", "run-1");
    expect(stableMemoryJobKey("event", "run-1")).toBe(first);
    expect(isUuidV4(first)).toBe(true);
    expect(first).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    expect(stableMemoryJobKey("event", "run-2")).not.toBe(first);
    expect(stableMemoryJobKey("remember", "run-1", 0)).not.toBe(
      stableMemoryJobKey("remember", "run-1", 1),
    );
  });
});

describe("outbox drain transitions", () => {
  it("acks ok envelopes and reuses the stable key on replay", async () => {
    const f = await openRepo();
    try {
      const seen: Array<{ op: string; key: string | undefined }> = [];
      const cliCall: CliCall = async (_address, op, _params, key) => {
        seen.push({ op, key });
        return okEnvelope(null);
      };
      const service = makeService(f.repo, cliCall);
      const key = stableMemoryJobKey("event", generateId());
      const sessionId = generateId();
      const runId = generateId();
      const { row } = f.repo.enqueueMemoryJob(
        "event.append",
        sessionId,
        runId,
        SCOPE,
        key,
        JSON.stringify({ op: "event.append", params: { eventId: "evt-1" } }),
        { now: T0 },
      );
      const drained = await service.drainOnce();
      expect(drained.executed).toBe(1);
      expect(f.repo.getMemoryJob(row.id)?.status).toBe("acked");
      // The outbox row's stable key is the CLI idempotency key.
      expect(seen).toEqual([{ op: "event.append", key }]);
      // Crash replay reuses the same key: dedup, no second CLI write.
      const replay = f.repo.enqueueMemoryJob(
        "event.append",
        sessionId,
        runId,
        SCOPE,
        key,
        JSON.stringify({ op: "event.append", params: { eventId: "evt-1" } }),
        { now: T0 + 1 },
      );
      expect(replay.deduplicated).toBe(true);
      expect((await service.drainOnce()).executed).toBe(0);
      expect(seen).toHaveLength(1);
    } finally {
      f.close();
    }
  });

  it("keeps transient rejections pending with backoff, fails terminal ones", async () => {
    const f = await openRepo();
    try {
      let nowValue = T0;
      const codes = new Map<string, string>();
      const cliCall: CliCall = async (_address, op) => {
        const code = codes.get(op) ?? "OK";
        if (code === "OK") {
          return okEnvelope(null);
        }
        return rejectedEnvelope(code);
      };
      const service = makeService(f.repo, cliCall, { now: () => nowValue });
      const transient = f.repo.enqueueMemoryJob(
        "record.remember",
        generateId(),
        generateId(),
        SCOPE,
        stableMemoryJobKey("t", generateId()),
        JSON.stringify({ op: "record.remember", params: {} }),
        { now: nowValue },
      );
      const terminal = f.repo.enqueueMemoryJob(
        "record.remember",
        generateId(),
        generateId(),
        SCOPE,
        stableMemoryJobKey("x", generateId()),
        JSON.stringify({ op: "record.remember", params: {} }),
        { now: nowValue },
      );
      codes.set("record.remember", "TIMEOUT");
      await service.drainOnce();
      await service.drainOnce();
      // Both drains hit TIMEOUT; rows stay pending with attempts counted.
      expect(f.repo.getMemoryJob(transient.row.id)?.status).toBe("pending");
      const stored = f.repo.getMemoryJob(transient.row.id);
      expect((stored?.attempts ?? 0) >= 1).toBe(true);
      expect(stored?.lastError).toBe("cli_rejected");
      // Terminal domain rejection fails without retry.
      codes.set("record.remember", "CONFLICT");
      nowValue += 3_600_000;
      await service.drainOnce();
      await service.drainOnce();
      const endStates = [
        f.repo.getMemoryJob(transient.row.id)?.status,
        f.repo.getMemoryJob(terminal.row.id)?.status,
      ];
      expect(endStates).toContain("failed");
    } finally {
      f.close();
    }
  });

  it("treats child timeout/malformed as transient and oversize as terminal", async () => {
    const f = await openRepo();
    try {
      const failures = new Map<
        string,
        "cli_timeout" | "cli_malformed" | "cli_limit"
      >();
      const cliCall: CliCall = async (_address, _op, params) => {
        const mode = failures.get(params.marker as string) ?? "cli_timeout";
        throw new MemoryCliError(mode);
      };
      const service = makeService(f.repo, cliCall);
      service.start();
      const jobFor = (marker: string) =>
        f.repo.enqueueMemoryJob(
          "record.remember",
          generateId(),
          generateId(),
          SCOPE,
          stableMemoryJobKey(marker, generateId()),
          JSON.stringify({ op: "record.remember", params: { marker } }),
          { now: T0 },
        ).row;
      const timedOut = jobFor("timeout-marker");
      const malformed = jobFor("malformed-marker");
      const oversize = jobFor("oversize-marker");
      failures.set("timeout-marker", "cli_timeout");
      failures.set("malformed-marker", "cli_malformed");
      failures.set("oversize-marker", "cli_limit");
      await service.drainOnce();
      await service.drainOnce();
      await service.drainOnce();
      expect(f.repo.getMemoryJob(timedOut.id)?.status).toBe("pending");
      expect(f.repo.getMemoryJob(malformed.id)?.status).toBe("pending");
      expect(f.repo.getMemoryJob(oversize.id)?.status).toBe("failed");
    } finally {
      f.close();
    }
  });

  it("fails malformed outbox payloads terminally without a CLI call", async () => {
    const f = await openRepo();
    try {
      let calls = 0;
      const cliCall: CliCall = async () => {
        calls += 1;
        return okEnvelope(null);
      };
      const service = makeService(f.repo, cliCall);
      const { row } = f.repo.enqueueMemoryJob(
        "record.remember",
        generateId(),
        generateId(),
        SCOPE,
        stableMemoryJobKey("bad", generateId()),
        JSON.stringify({ nope: true }),
        { now: T0 },
      );
      await service.drainOnce();
      expect(f.repo.getMemoryJob(row.id)?.status).toBe("failed");
      expect(calls).toBe(0);
    } finally {
      f.close();
    }
  });

  it("fans event.append out to stable remember jobs before acking", async () => {
    const f = await openRepo();
    try {
      const ops: string[] = [];
      const cliCall: CliCall = async (_address, op) => {
        ops.push(op);
        return okEnvelope(null);
      };
      const service = makeService(f.repo, cliCall);
      const sessionId = generateId();
      const runId = generateId();
      const turnId = generateId();
      f.repo.enqueueMemoryJob(
        "event.append",
        sessionId,
        runId,
        SCOPE,
        stableMemoryJobKey("event", runId),
        JSON.stringify({
          op: "event.append",
          params: { eventId: "evt-1" },
          chain: {
            eventId: "evt-1",
            sessionId,
            runId,
            turnId,
            provenance: {
              source: "companion:conversation",
              observedAt: new Date(T0).toISOString(),
            },
            memories: [
              { body: "user likes tea", kind: "user_fact" },
              { body: "bogus kind", kind: "episodic" },
            ],
          },
        }),
        { turnId, now: T0 },
      );
      await service.drainOnce();
      const remembered = f.repo.claimDueMemoryJobs(5, Date.now());
      expect(
        remembered.filter((job) => job.kind === "record.remember"),
      ).toHaveLength(1);
      const remember = remembered.find((job) => job.kind === "record.remember");
      expect(remember?.idempotencyKey).toBe(
        stableMemoryJobKey("remember", runId, 0),
      );
      expect(ops).toContain("event.append");
      await service.drainOnce();
      expect(ops.filter((op) => op === "record.remember")).toHaveLength(1);
    } finally {
      f.close();
    }
  });

  it("shares one in-flight drain tick between concurrent callers", async () => {
    const f = await openRepo();
    try {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const cliCall: CliCall = async () => {
        await gate;
        return okEnvelope(null);
      };
      const service = makeService(f.repo, cliCall);
      const { row } = f.repo.enqueueMemoryJob(
        "record.remember",
        generateId(),
        generateId(),
        SCOPE,
        stableMemoryJobKey("single", generateId()),
        JSON.stringify({ op: "record.remember", params: {} }),
        { now: T0 },
      );
      const first = service.drainOnce();
      const second = service.drainOnce();
      expect(first).toBe(second);
      release();
      const result = await first;
      expect(result.executed).toBe(1);
      expect(f.repo.getMemoryJob(row.id)?.status).toBe("acked");
    } finally {
      f.close();
    }
  });
});

describe("recall hook", () => {
  it("projects bounded snippets and fails open without calls", async () => {
    const f = await openRepo();
    try {
      const paramsSeen: Record<string, unknown>[] = [];
      const cliCall: CliCall = async (_address, op, params) => {
        paramsSeen.push(params);
        expect(op).toBe("record.recall");
        return okEnvelope({
          recallId: "recall-9",
          items: [
            { id: "record-a", snippet: "alpha" },
            { id: "record-b", snippet: "beta" },
          ],
        });
      };
      const service = makeService(f.repo, cliCall);
      service.start();
      const controller = new AbortController();
      const snippets = await service.recallHook.recall(
        "what do I like?",
        controller.signal,
      );
      expect(snippets).toEqual([
        { recordId: "record-a", recallId: "recall-9", snippet: "alpha" },
        { recordId: "record-b", recallId: "recall-9", snippet: "beta" },
      ]);
      expect(paramsSeen).toHaveLength(1);
      expect(paramsSeen[0]).toMatchObject({
        scope: SCOPE,
        runId: MEMORY_RECALL_RUN_MARKER,
        limit: 5,
      });
      // Empty queries never call the CLI.
      expect(await service.recallHook.recall("", controller.signal)).toEqual(
        [],
      );
      expect(paramsSeen).toHaveLength(1);
      // Recall records no exposures itself: the agent snapshot owns that.
      expect(f.repo.listMemoryExposures(generateId())).toHaveLength(0);
    } finally {
      f.close();
    }
  });

  it("carries a recalled correction through the hook and stores it as correction", async () => {
    const f = await openRepo();
    try {
      const cliCall: CliCall = async (_address, op, _params) => {
        expect(op).toBe("record.recall");
        return okEnvelope({
          recallId: "recall-corr",
          items: [
            {
              id: "record-corr",
              snippet: "corrected text",
              kind: "correction",
              revision: 4,
            },
          ],
        });
      };
      const service = makeService(f.repo, cliCall);
      service.start();
      const snippets = await service.recallHook.recall(
        "what changed?",
        new AbortController().signal,
      );
      // The hook preserves the correction kind (never dropped to unknown).
      expect(snippets).toEqual([
        {
          recordId: "record-corr",
          recallId: "recall-corr",
          snippet: "corrected text",
          kind: "correction",
          revision: 4,
        },
      ]);
      // The agent snapshot path stores it under its own kind (0022 CHECK).
      const sessionId = generateId();
      const runId = generateId();
      const correction = snippets[0];
      expect(correction?.kind).toBe("correction");
      f.repo.recordMemoryExposure(
        {
          recallId: "recall-corr",
          recordId: "record-corr",
          sessionId,
          runId,
          scope: SCOPE,
          citation: "m1",
          snippet: "corrected text",
          ...(correction?.revision !== undefined
            ? { revision: correction.revision }
            : {}),
          ...(correction?.kind !== undefined ? { kind: correction.kind } : {}),
        },
        { now: T0 },
      );
      const stored = f.repo
        .listMemoryExposures(runId)
        .find((item) => item.recallId === "recall-corr");
      expect(stored).toMatchObject({ kind: "correction", revision: 4 });
    } finally {
      f.close();
    }
  });

  it("returns memoryless on child failure, abort, and malformed data", async () => {
    const f = await openRepo();
    try {
      let mode: "throw" | "malformed" = "throw";
      const cliCall: CliCall = async () => {
        if (mode === "throw") {
          throw new MemoryCliError("cli_unavailable");
        }
        return okEnvelope({ recallId: "", items: "nope" });
      };
      const service = makeService(f.repo, cliCall);
      service.start();
      expect(
        await service.recallHook.recall("q", new AbortController().signal),
      ).toEqual([]);
      mode = "malformed";
      expect(
        await service.recallHook.recall("q", new AbortController().signal),
      ).toEqual([]);
      const aborted = new AbortController();
      aborted.abort();
      expect(await service.recallHook.recall("q", aborted.signal)).toEqual([]);
    } finally {
      f.close();
    }
  });

  it("reports fixed failure codes to the optional kernel status sink (I01-06)", async () => {
    const f = await openRepo();
    try {
      let mode: "timeout" | "version" | "malformed" | "ok" = "timeout";
      const cliCall: CliCall = async () => {
        if (mode === "timeout") {
          throw new MemoryCliError("cli_timeout");
        }
        if (mode === "version") {
          throw new MemoryCliError("cli_version_mismatch");
        }
        if (mode === "malformed") {
          return okEnvelope({ recallId: "", items: "nope" });
        }
        return okEnvelope({ recallId: "recall-ok", items: [] });
      };
      const service = makeService(f.repo, cliCall);
      service.start();
      const codes: string[] = [];
      const sink = (code: string) => {
        codes.push(code);
      };
      expect(
        await service.recallHook.recall(
          "q",
          new AbortController().signal,
          sink,
        ),
      ).toEqual([]);
      expect(codes).toEqual(["cli_timeout"]);
      mode = "version";
      expect(
        await service.recallHook.recall(
          "q",
          new AbortController().signal,
          sink,
        ),
      ).toEqual([]);
      expect(codes).toEqual(["cli_timeout", "cli_version_mismatch"]);
      mode = "malformed";
      expect(
        await service.recallHook.recall(
          "q",
          new AbortController().signal,
          sink,
        ),
      ).toEqual([]);
      expect(codes).toEqual([
        "cli_timeout",
        "cli_version_mismatch",
        "cli_malformed",
      ]);
      // Success reports nothing to the sink.
      mode = "ok";
      expect(
        await service.recallHook.recall(
          "q",
          new AbortController().signal,
          sink,
        ),
      ).toEqual([]);
      expect(codes).toHaveLength(3);
    } finally {
      f.close();
    }
  });
});

describe("completion cultivation and cite-gated feedback", () => {
  it("grants cited memories and enqueues one feedback job per recall", async () => {
    const f = await openRepo();
    try {
      const ops: string[] = [];
      const cliCall: CliCall = async (_address, op) => {
        ops.push(op);
        return okEnvelope(null);
      };
      const service = makeService(f.repo, cliCall);
      service.start();
      const { sessionId, runId } = completeV2Run(f.repo, [
        { text: "uses both memories", citations: ["m1", "m2"] },
      ]);
      f.repo.recordMemoryExposure(
        {
          recallId: "recall-1",
          recordId: "record-1",
          sessionId,
          runId,
          scope: SCOPE,
          citation: "m1",
          snippet: "first",
        },
        { now: T0 + 4 },
      );
      f.repo.recordMemoryExposure(
        {
          recallId: "recall-1",
          recordId: "record-2",
          sessionId,
          runId,
          scope: SCOPE,
          citation: "m2",
          snippet: "second",
        },
        { now: T0 + 5 },
      );
      service.onRunCompleted(runId);
      await waitFor(() => f.repo.listMemoryGrants(runId).length === 2);
      expect(
        f.repo
          .listMemoryGrants(runId)
          .map((grant) => grant.citation)
          .sort(),
      ).toEqual(["m1", "m2"]);
      // One feedback job per recall id with the stable key, drained to ack.
      await waitFor(
        () => outboxRowsByKind(f, "record.feedback", runId).length === 1,
      );
      expect(outboxRowsByKind(f, "record.feedback", runId)).toEqual([
        {
          key: stableMemoryJobKey("feedback", runId, "recall-1"),
          status: expect.any(String),
        },
      ]);
      await service.drainOnce();
      expect(ops).toContain("record.feedback");
    } finally {
      f.close();
    }
  });

  it("sends no feedback for exposure-only runs without citations", async () => {
    const f = await openRepo();
    try {
      const cliCall: CliCall = async () => okEnvelope(null);
      const service = makeService(f.repo, cliCall);
      service.start();
      const { sessionId, runId } = completeV2Run(f.repo, [
        { text: "no citations", citations: [] },
      ]);
      f.repo.recordMemoryExposure(
        {
          recallId: "recall-1",
          recordId: "record-1",
          sessionId,
          runId,
          scope: SCOPE,
          citation: "m1",
          snippet: "unseen",
        },
        { now: T0 + 4 },
      );
      service.onRunCompleted(runId);
      await sleep(300);
      expect(f.repo.listMemoryGrants(runId)).toHaveLength(0);
      expect(
        f.repo
          .claimDueMemoryJobs(5, Date.now())
          .filter((job) => job.kind === "record.feedback"),
      ).toHaveLength(0);
    } finally {
      f.close();
    }
  });

  it("rejects wrong-scope and cross-run citations", async () => {
    const f = await openRepo();
    try {
      const cliCall: CliCall = async () => okEnvelope(null);
      const service = makeService(f.repo, cliCall);
      service.start();
      const first = completeV2Run(f.repo, [
        { text: "cites m1", citations: ["m1"] },
      ]);
      const other = completeV2Run(f.repo, [{ text: "other", citations: [] }]);
      // Same-run exposure in a foreign scope: citation rejected.
      f.repo.recordMemoryExposure(
        {
          recallId: "recall-1",
          recordId: "record-1",
          sessionId: first.sessionId,
          runId: first.runId,
          scope: "other-scope",
          citation: "m1",
          snippet: "x",
        },
        { now: T0 + 4 },
      );
      // Same citation label but a different run's exposure: rejected.
      f.repo.recordMemoryExposure(
        {
          recallId: "recall-1",
          recordId: "record-9",
          sessionId: other.sessionId,
          runId: other.runId,
          scope: SCOPE,
          citation: "m1",
          snippet: "y",
        },
        { now: T0 + 5 },
      );
      service.onRunCompleted(first.runId);
      await sleep(300);
      expect(f.repo.listMemoryGrants(first.runId)).toHaveLength(0);
      expect(
        f.repo
          .claimDueMemoryJobs(5, Date.now())
          .filter((job) => job.kind === "record.feedback"),
      ).toHaveLength(0);
    } finally {
      f.close();
    }
  });

  it("cultivates completed selected runs through extraction, never cancelled or superseded ones", async () => {
    const f = await openRepo();
    try {
      const ops: string[] = [];
      const cliCall: CliCall = async (_address, op) => {
        ops.push(op);
        return okEnvelope(null);
      };
      const { gateway, calls } = extractionGateway(
        JSON.stringify({
          memories: [
            { body: "user likes tea", kind: "user_fact" },
            { body: "turn digest", kind: "summary" },
          ],
        }),
      );
      const service = makeService(f.repo, cliCall, { gateway });
      service.start();
      const chosen = completeV2Run(f.repo, [
        { text: "answered", citations: [] },
      ]);
      service.onRunCompleted(chosen.runId);
      await waitFor(() => ops.includes("event.append"));
      expect(calls.length).toBeGreaterThan(0);
      // The drain executes the remember fan-out to acked (stronger than
      // merely pending): two stable-keyed remember jobs must land.
      await waitFor(
        () =>
          outboxRowsByKind(f, "record.remember", chosen.runId).filter(
            (row) => row.status === "acked",
          ).length === 2,
      );
      expect(outboxRowsByKind(f, "record.remember", chosen.runId)).toEqual([
        {
          key: stableMemoryJobKey("remember", chosen.runId, 0),
          status: "acked",
        },
        {
          key: stableMemoryJobKey("remember", chosen.runId, 1),
          status: "acked",
        },
      ]);

      // Cancelled runs never reach extraction: no gateway call, no jobs.
      const callsBefore = calls.length;
      const pending = f.repo.postMessage(
        chosen.sessionId,
        { text: "cancel me" },
        { key: randomUUID(), now: T0 + 10 },
      );
      f.repo.cancelRun(chosen.sessionId, pending.body.run.id, { now: T0 + 11 });
      service.onRunCompleted(pending.body.run.id);
      await sleep(300);
      expect(calls.length).toBe(callsBefore);

      // A superseded retry never cultivates even when completed.
      const retrySession = f.repo.createSession({
        key: randomUUID(),
        now: T0 + 19,
      }).body.sessionId;
      const first = f.repo.postMessage(
        retrySession,
        { text: "retry me" },
        { key: randomUUID(), now: T0 + 20 },
      );
      // Settle the first attempt before retrying: postRetry rejects a
      // session with an active run, so complete first, then retry.
      f.repo.startRun(first.body.run.id, { now: T0 + 22 });
      f.repo.completeRun(
        first.body.run.id,
        buildRunResultV2({
          version: 1,
          parts: [{ text: "old", citations: [] }],
        }),
        { now: T0 + 23 },
      );
      const second = f.repo.postRetry(retrySession, first.body.turnId, {
        key: randomUUID(),
        now: T0 + 24,
      });
      f.repo.startRun(second.body.run.id, { now: T0 + 25 });
      f.repo.completeRun(
        second.body.run.id,
        buildRunResultV2({
          version: 1,
          parts: [{ text: "new", citations: [] }],
        }),
        { now: T0 + 26 },
      );
      const jobsBefore = f.repo.countPendingMemoryJobs(Date.now());
      service.onRunCompleted(first.body.run.id);
      await sleep(300);
      expect(calls.length).toBe(callsBefore);
      expect(f.repo.countPendingMemoryJobs(Date.now())).toBe(jobsBefore);
    } finally {
      f.close();
    }
  });

  it("stores the raw event.append even when extraction is invalid or fails, with no remember fan-out", async () => {
    const f = await openRepo();
    try {
      const ops: string[] = [];
      const cliCall: CliCall = async (_address, op) => {
        ops.push(op);
        return okEnvelope(null);
      };
      const { gateway } = extractionGateway("not json at all");
      const service = makeService(f.repo, cliCall, { gateway });
      service.start();
      const run = completeV2Run(f.repo, [{ text: "answered", citations: [] }]);
      service.onRunCompleted(run.runId);
      // Decision (I): raw storage never depends on extraction. The raw
      // event.append still enqueues and acks; only the remember fan-out is
      // forgone on extract_invalid.
      await waitFor(() => ops.includes("event.append"));
      expect(
        f.repo
          .claimDueMemoryJobs(5, Date.now())
          .filter((job) => job.kind === "record.remember"),
      ).toHaveLength(0);

      const throwing: ModelGateway = {
        provider: "openai-compatible",
        capabilities: { toolCalling: false },
        baseUrl: "http://127.0.0.1:9",
        chatUrl: "http://127.0.0.1:9/v1/chat/completions",
        chat: async (): Promise<ChatResult> => {
          throw new Error("gateway down");
        },
      };
      const service2 = makeService(f.repo, cliCall, { gateway: throwing });
      service2.start();
      const run2 = completeV2Run(f.repo, [
        { text: "answered again", citations: [] },
      ]);
      service2.onRunCompleted(run2.runId);
      // The raw event.append row exists for the failed-extraction run
      // (pending or already acked by the drain); no remember fan-out.
      await waitFor(
        () => outboxRowsByKind(f, "event.append", run2.runId).length === 1,
      );
      expect(outboxRowsByKind(f, "record.remember", run2.runId)).toHaveLength(
        0,
      );
    } finally {
      f.close();
    }
  });

  it("raw append honors the background gate: open gate + invalid extraction lands, closed gate (STOP) lands nothing", async () => {
    const f = await openRepo();
    try {
      const gate = createBackgroundResourceGate();
      const ops: string[] = [];
      const cliCall: CliCall = async (_address, op) => {
        ops.push(op);
        return okEnvelope(null);
      };
      // Gate OPEN + invalid extraction payload: the raw event.append still
      // enqueues and drains (raw storage never depends on extraction
      // success); only the remember fan-out is forgone.
      const service = makeService(f.repo, cliCall, {
        gateway: extractionGateway("not json at all").gateway,
        background: gate,
      });
      service.start();
      const run = completeV2Run(f.repo, [{ text: "answered", citations: [] }]);
      service.onRunCompleted(run.runId);
      await waitFor(() => ops.includes("event.append"));
      expect(
        f.repo
          .claimDueMemoryJobs(5, Date.now())
          .filter((job) => job.kind === "record.remember"),
      ).toHaveLength(0);

      // Gate CLOSED (STOP/shutdown): a completion admits nothing new — no
      // extraction, and no raw event.append: no late writes after STOP.
      gate.close();
      expect(gate.closed).toBe(true);
      const opsBefore = ops.length;
      const stoppedRun = completeV2Run(f.repo, [
        { text: "answered while stopped", citations: [] },
      ]);
      service.onRunCompleted(stoppedRun.runId);
      await sleep(300);
      expect(ops.slice(opsBefore)).toEqual([]);
      expect(f.repo.countPendingMemoryJobs(Date.now())).toBe(0);

      // Reopen: a new completion cultivates normally again.
      gate.reopen();
      const run2 = completeV2Run(f.repo, [{ text: "answered", citations: [] }]);
      service.onRunCompleted(run2.runId);
      await waitFor(() => ops.length > opsBefore);
    } finally {
      f.close();
    }
  });
});

describe("foreground preemption and shutdown", () => {
  function hangingCliCall(calls: string[]): CliCall {
    return async (_address, op, _params, _key, options) => {
      calls.push(op);
      if (op !== "maintain.distill") {
        return okEnvelope(null);
      }
      await new Promise<void>((_resolve, reject) => {
        const signal = options?.signal;
        if (signal?.aborted === true) {
          reject(new MemoryCliError("cli_timeout"));
          return;
        }
        signal?.addEventListener(
          "abort",
          () => reject(new MemoryCliError("cli_timeout")),
          {
            once: true,
          },
        );
      });
      return okEnvelope(null);
    };
  }

  it("preempts an in-flight idle distill on foreground activity", async () => {
    const f = await openRepo();
    try {
      const calls: string[] = [];
      const service = makeService(f.repo, hangingCliCall(calls), {
        idleMs: 50,
      });
      const run = completeV2Run(f.repo, [{ text: "answered", citations: [] }]);
      service.start();
      service.onRunCompleted(run.runId);
      await waitFor(() => calls.includes("maintain.distill"));
      service.notifyForeground();
      await waitFor(() => {
        const due = f.repo.claimDueMemoryJobs(5, Date.now());
        const distill = due.find((job) => job.kind === "maintain.distill");
        return distill !== undefined && distill.attempts >= 1;
      });
      const distill = f.repo
        .claimDueMemoryJobs(5, Date.now())
        .find((job) => job.kind === "maintain.distill");
      // Preempted, not acked and not failed: durable retry stays pending.
      expect(distill?.status).toBe("pending");
      expect(distill?.lastError).toBe("cli_preempted");
    } finally {
      f.close();
    }
  });

  it("cancels an in-flight idle distill on shutdown with no orphan", async () => {
    const f = await openRepo();
    try {
      const calls: string[] = [];
      const service = makeService(f.repo, hangingCliCall(calls), {
        idleMs: 50,
      });
      const run = completeV2Run(f.repo, [{ text: "answered", citations: [] }]);
      service.start();
      service.onRunCompleted(run.runId);
      await waitFor(() => calls.includes("maintain.distill"));
      await service.stop();
      const distill = f.repo
        .claimDueMemoryJobs(100, Date.now() + 3_600_000)
        .find((job) => job.kind === "maintain.distill");
      expect(distill?.status).toBe("pending");
      // A fresh drain after shutdown still sees the pending job: no loss.
      expect(f.repo.countPendingMemoryJobs(Date.now() + 3_600_000) >= 1).toBe(
        true,
      );
    } finally {
      f.close();
    }
  });

  it("keeps the queued event scope on remember follow-ups", async () => {
    const f = await openRepo();
    try {
      const cliCall: CliCall = async () => okEnvelope(null);
      const service = makeService(f.repo, cliCall, { scope: "new-scope" });
      const sessionId = generateId();
      const runId = generateId();
      const turnId = generateId();
      f.repo.enqueueMemoryJob(
        "event.append",
        sessionId,
        runId,
        "old-scope",
        stableMemoryJobKey("event", runId),
        JSON.stringify({
          op: "event.append",
          params: { eventId: "evt-1", scope: "old-scope" },
          chain: {
            eventId: "evt-1",
            sessionId,
            runId,
            turnId,
            provenance: {
              source: "companion:conversation",
              observedAt: new Date(T0).toISOString(),
            },
            memories: [{ body: "user likes tea", kind: "user_fact" }],
          },
        }),
        { turnId, now: T0 },
      );
      await service.drainOnce();
      const rows = f.db
        .prepare(
          "SELECT scope, request_json AS requestJson FROM memory_outbox WHERE kind = ? AND run_id = ?",
        )
        .all("record.remember", runId) as Array<{
        scope: string;
        requestJson: string;
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.scope).toBe("old-scope");
      expect(JSON.parse(rows[0]?.requestJson as string).params.scope).toBe(
        "old-scope",
      );
    } finally {
      f.close();
    }
  });

  it("keeps the raw event.append but skips remember fan-out when selection changes during extraction", async () => {
    const f = await openRepo();
    try {
      const ops: string[] = [];
      const cliCall: CliCall = async (_address, op) => {
        ops.push(op);
        return okEnvelope(null);
      };
      let release!: (text: string) => void;
      const gate = new Promise<string>((resolve) => {
        release = resolve;
      });
      const gateway: ModelGateway = {
        provider: "openai-compatible",
        capabilities: { toolCalling: false },
        baseUrl: "http://127.0.0.1:9",
        chatUrl: "http://127.0.0.1:9/v1/chat/completions",
        chat: async (): Promise<ChatResult> => {
          const text = await gate;
          return { text, toolCalls: [], stopReason: "stop" };
        },
      };
      const service = makeService(f.repo, cliCall, { gateway });
      service.start();
      const run = completeV2Run(f.repo, [{ text: "answered", citations: [] }]);
      service.onRunCompleted(run.runId);
      // Supersede the run while the gateway call is still awaited.
      await sleep(50);
      const retry = f.repo.postRetry(run.sessionId, run.turnId, {
        key: randomUUID(),
        now: T0 + 10,
      });
      f.repo.startRun(retry.body.run.id, { now: T0 + 11 });
      f.repo.completeRun(
        retry.body.run.id,
        buildRunResultV2({
          version: 1,
          parts: [{ text: "new", citations: [] }],
        }),
        { now: T0 + 12 },
      );
      release(
        JSON.stringify({
          memories: [
            { body: "stale fact", kind: "user_fact" },
            { body: "stale digest", kind: "summary" },
          ],
        }),
      );
      await sleep(300);
      // Decision (I): the superseded run's raw turn is still a committed
      // turn — the raw event.append stays durable. Only the stale
      // extraction's remember fan-out is discarded.
      await waitFor(() => ops.includes("event.append"));
      expect(
        f.repo
          .claimDueMemoryJobs(5, Date.now())
          .filter((job) => job.kind === "record.remember"),
      ).toHaveLength(0);
    } finally {
      f.close();
    }
  });

  it("keeps the idle timer alive across empty ticks", async () => {
    const f = await openRepo();
    try {
      const ops: string[] = [];
      const cliCall: CliCall = async (_address, op) => {
        ops.push(op);
        return okEnvelope(null);
      };
      const service = makeService(f.repo, cliCall, { idleMs: 50 });
      service.start();
      // Several one-shot ticks with no run anchor must rearm, not stall.
      await sleep(160);
      const run = completeV2Run(f.repo, [{ text: "answered", citations: [] }]);
      service.onRunCompleted(run.runId);
      await waitFor(() => ops.includes("maintain.distill"), 5000);
    } finally {
      f.close();
    }
  });
});

describe("baseline regression contracts", () => {
  function rememberJob(i: number): {
    kind: "record.remember";
    requestJson: string;
    key: string;
  } {
    return {
      kind: "record.remember",
      requestJson: JSON.stringify({
        op: "record.remember",
        params: { body: `fact ${i}`, kind: "user_fact" },
      }),
      key: stableMemoryJobKey("batch-bound", i),
    };
  }

  it("executes at most 5 jobs per drain tick and continues on the next tick", async () => {
    const f = await openRepo();
    try {
      const cliCall: CliCall = async () => okEnvelope(null);
      const service = makeService(f.repo, cliCall);
      const sessionId = generateId();
      const runId = generateId();
      for (let i = 0; i < 7; i += 1) {
        const job = rememberJob(i);
        f.repo.enqueueMemoryJob(
          job.kind,
          sessionId,
          runId,
          SCOPE,
          job.key,
          job.requestJson,
          { now: T0 },
        );
      }
      const first = await service.drainOnce();
      expect(first.executed).toBe(5);
      // The remainder (including any follow-up chain) stays pending for a
      // later scheduled drain instead of stranding behind an over-wide tick.
      expect(f.repo.countPendingMemoryJobs(Date.now())).toBe(2);
      const second = await service.drainOnce();
      expect(second.executed).toBe(2);
      expect(f.repo.countPendingMemoryJobs(Date.now())).toBe(0);
    } finally {
      f.close();
    }
  });

  it("stop aborts an in-flight foreground drain tick with no loss", async () => {
    const f = await openRepo();
    try {
      let entered = false;
      const cliCall: CliCall = async (_address, _op, _params, _key, options) =>
        new Promise<MemoryCliEnvelope>((_resolve, reject) => {
          entered = true;
          const signal = options?.signal;
          if (signal?.aborted === true) {
            reject(new MemoryCliError("cli_timeout"));
            return;
          }
          signal?.addEventListener(
            "abort",
            () => reject(new MemoryCliError("cli_timeout")),
            { once: true },
          );
        });
      const service = makeService(f.repo, cliCall);
      const { row } = f.repo.enqueueMemoryJob(
        "record.remember",
        generateId(),
        generateId(),
        SCOPE,
        stableMemoryJobKey("foreground-stop", generateId()),
        JSON.stringify({ op: "record.remember", params: {} }),
        { now: T0 },
      );
      // Foreground (caller-driven, non-idle) tick: stop must abort it even
      // though no idle controller owns it.
      const pending = service.drainOnce();
      await waitFor(() => entered);
      await service.stop();
      await pending;
      const job = f.repo.getMemoryJob(row.id);
      expect(job?.status).toBe("pending");
      expect(job?.lastError).toBe("cli_preempted");
    } finally {
      f.close();
    }
  });

  it("idle drains startup backlog with no completed run yet", async () => {
    const f = await openRepo();
    try {
      const ops: string[] = [];
      const cliCall: CliCall = async (_address, op) => {
        ops.push(op);
        return okEnvelope(null);
      };
      const service = makeService(f.repo, cliCall, { idleMs: 50 });
      service.start();
      // Let the startup recovery tick finish empty, so only the idle path
      // can drain what follows (no run has completed: no distill anchor).
      await sleep(120);
      const job = rememberJob(0);
      f.repo.enqueueMemoryJob(
        job.kind,
        generateId(),
        generateId(),
        SCOPE,
        job.key,
        job.requestJson,
        { now: T0 },
      );
      await waitFor(() => ops.includes("record.remember"), 5000);
      expect(f.repo.countPendingMemoryJobs(Date.now())).toBe(0);
    } finally {
      f.close();
    }
  });

  it("idle retries a due distill after transient failure without another completion", async () => {
    const f = await openRepo();
    try {
      let nowValue = T0;
      let distillCalls = 0;
      const cliCall: CliCall = async (_address, op) => {
        if (op !== "maintain.distill") {
          return okEnvelope(null);
        }
        distillCalls += 1;
        if (distillCalls === 1) {
          throw new MemoryCliError("cli_timeout");
        }
        return okEnvelope({ cursor: null });
      };
      const service = makeService(f.repo, cliCall, {
        idleMs: 50,
        now: () => nowValue,
      });
      service.start();
      const run = completeV2Run(f.repo, [{ text: "answered", citations: [] }]);
      service.onRunCompleted(run.runId);
      // First distill attempt fails transiently: still pending with backoff.
      await waitFor(() => distillCalls >= 1, 5000);
      await waitFor(() => {
        const rows = f.db
          .prepare(
            "SELECT status FROM memory_outbox WHERE kind = ? AND status = ?",
          )
          .all("maintain.distill", "pending") as Array<{ status: string }>;
        return rows.length === 1;
      }, 5000);
      expect(distillCalls).toBe(1);
      // The backoff (2s after the first attempt) expires with no further
      // foreground completion: the idle tick retries the same pending
      // distill on its own instead of rearming forever.
      nowValue += 10_000;
      await waitFor(() => distillCalls >= 2, 5000);
      await waitFor(() => f.repo.countPendingMemoryJobs(nowValue) === 0, 5000);
    } finally {
      f.close();
    }
  });
});

describe("parseRecallData provenance fields", () => {
  const base = { recallId: "r-1", items: [] as unknown[] };

  it("carries kind and revision when present and valid", () => {
    const parsed = parseRecallData({
      recallId: "r-1",
      items: [
        { id: "rec-1", snippet: "s", kind: "user_fact", revision: 3 },
        { id: "rec-2", snippet: "t", kind: "model_inference", revision: 1 },
        { id: "rec-3", snippet: "u", kind: "summary", revision: 12 },
      ],
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.items).toEqual([
      { id: "rec-1", snippet: "s", kind: "user_fact", revision: 3 },
      { id: "rec-2", snippet: "t", kind: "model_inference", revision: 1 },
      { id: "rec-3", snippet: "u", kind: "summary", revision: 12 },
    ]);
  });

  it("drops unknown kinds and invalid revisions (absent, not fact)", () => {
    const parsed = parseRecallData({
      recallId: "r-1",
      items: [
        { id: "rec-1", snippet: "s" },
        { id: "rec-2", snippet: "t", kind: "unknown_kind", revision: 0 },
        { id: "rec-3", snippet: "u", kind: 42, revision: -1 },
        { id: "rec-4", snippet: "v", kind: "user_fact", revision: 1.5 },
      ],
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.items).toEqual([
      { id: "rec-1", snippet: "s" },
      { id: "rec-2", snippet: "t" },
      { id: "rec-3", snippet: "u" },
      { id: "rec-4", snippet: "v", kind: "user_fact" },
    ]);
  });

  it("still rejects a null or shape-drifted payload", () => {
    expect(parseRecallData(null)).toBeNull();
    expect(parseRecallData({ ...base, items: "nope" })).toBeNull();
    expect(parseRecallData({ items: [] })).toBeNull();
  });

  it("carries top-level vector when valid, drops it when invalid", () => {
    expect(
      parseRecallData({ recallId: "r-1", items: [], vector: "used" })?.vector,
    ).toBe("used");
    expect(
      parseRecallData({ recallId: "r-1", items: [], vector: "disabled" })
        ?.vector,
    ).toBe("disabled");
    expect(
      parseRecallData({ recallId: "r-1", items: [], vector: "unavailable" })
        ?.vector,
    ).toBe("unavailable");
    expect(
      parseRecallData({ recallId: "r-1", items: [] })?.vector,
    ).toBeUndefined();
    expect(
      parseRecallData({ recallId: "r-1", items: [], vector: "bogus" })?.vector,
    ).toBeUndefined();
    expect(
      parseRecallData({ recallId: "r-1", items: [], vector: 42 })?.vector,
    ).toBeUndefined();
  });

  it("carries the correction kind as itself (stored, never a fact)", () => {
    const parsed = parseRecallData({
      recallId: "r-1",
      items: [{ id: "rec-1", snippet: "s", kind: "correction", revision: 2 }],
    });
    expect(parsed?.items).toEqual([
      { id: "rec-1", snippet: "s", kind: "correction", revision: 2 },
    ]);
  });
});

describe("privacy metadata on memory writes (F-I01-05)", () => {
  it("sends fixed privacy on event.append and AI sensitivity on remember", async () => {
    const f = await openRepo();
    try {
      const seen: Array<{ op: string; params: Record<string, unknown> }> = [];
      const cliCall: CliCall = async (_address, op, params) => {
        seen.push({ op, params });
        return okEnvelope(null);
      };
      const { gateway } = extractionGateway(
        JSON.stringify({
          memories: [
            {
              body: "user likes tea",
              kind: "user_fact",
              sensitivity: "normal",
            },
            { body: "late-night worry", kind: "summary" },
          ],
        }),
      );
      const service = makeService(f.repo, cliCall, { gateway });
      service.start();
      const run = completeV2Run(f.repo, [{ text: "answered", citations: [] }]);
      service.onRunCompleted(run.runId);
      await waitFor(() => seen.some((call) => call.op === "event.append"));
      const appended = seen.find((call) => call.op === "event.append");
      expect(appended?.params).toMatchObject({
        privacy: { sensitivity: "normal", origin: "conversation" },
      });
      await service.drainOnce();
      const remembered = seen.filter((call) => call.op === "record.remember");
      expect(remembered).toHaveLength(2);
      const byBody = new Map(
        remembered.map((call) => [
          (call.params as { body: string }).body,
          call.params,
        ]),
      );
      expect(byBody.get("user likes tea")).toMatchObject({
        privacy: { sensitivity: "normal", origin: "conversation" },
      });
      // Missing sensitivity fails closed to sensitive (kept, never normal).
      expect(byBody.get("late-night worry")).toMatchObject({
        privacy: { sensitivity: "sensitive", origin: "conversation" },
      });
    } finally {
      f.close();
    }
  });

  it("maps invalid AI sensitivity to sensitive on remember", async () => {
    const f = await openRepo();
    try {
      const seen: Array<{ op: string; params: Record<string, unknown> }> = [];
      const cliCall: CliCall = async (_address, op, params) => {
        seen.push({ op, params });
        return okEnvelope(null);
      };
      const sessionId = generateId();
      const runId = generateId();
      const turnId = generateId();
      const service = makeService(f.repo, cliCall);
      f.repo.enqueueMemoryJob(
        "event.append",
        sessionId,
        runId,
        SCOPE,
        stableMemoryJobKey("event", runId),
        JSON.stringify({
          op: "event.append",
          params: {
            eventId: "evt-1",
            privacy: { sensitivity: "normal", origin: "conversation" },
          },
          chain: {
            eventId: "evt-1",
            sessionId,
            runId,
            turnId,
            provenance: {
              source: "companion:conversation",
              observedAt: new Date(T0).toISOString(),
            },
            memories: [
              { body: "bogus", kind: "user_fact", sensitivity: "ultra" },
            ],
          },
        }),
        { turnId, now: T0 },
      );
      await service.drainOnce();
      await service.drainOnce();
      const remembered = seen.filter((call) => call.op === "record.remember");
      expect(remembered).toHaveLength(1);
      expect(remembered[0]?.params).toMatchObject({
        privacy: { sensitivity: "sensitive", origin: "conversation" },
      });
    } finally {
      f.close();
    }
  });

  it("logs recall vector as metadata without exposing bodies", async () => {
    const f = await openRepo();
    try {
      const logged: Array<{ code: string; fields?: Record<string, unknown> }> =
        [];
      const cliCall: CliCall = async () => {
        return okEnvelope({
          recallId: "recall-v",
          items: [{ id: "rec-1", snippet: "alpha", revision: 4 }],
          vector: "used",
        });
      };
      const service = makeService(f.repo, cliCall);
      service as unknown as { recallHook: unknown };
      const { createCollectingLogger } = await import("../src/logger.js");
      const collecting = createCollectingLogger("debug");
      const { createMemoryService: create } = await import(
        "../src/memory_service.js"
      );
      const svc = create({
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
        repo: f.repo,
        gateway: null,
        model: "test-model",
        logger: collecting.logger,
        cliCall,
      });
      svc.start();
      const out = await svc.recallHook.recall(
        "q",
        new AbortController().signal,
      );
      expect(out).toEqual([
        {
          recordId: "rec-1",
          recallId: "recall-v",
          snippet: "alpha",
          revision: 4,
        },
      ]);
      const vectorLog = collecting.records.find(
        (record) => record.code === "memory.recall_vector",
      );
      expect(vectorLog?.status).toBe("used");
      await svc.stop().catch(() => undefined);
      void logged;
      await service.stop().catch(() => undefined);
    } finally {
      f.close();
    }
  });
});
