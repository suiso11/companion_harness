// M2 agent tool schemas (PR #4 r3943430518): AgentStrategy advertises
// accurate descriptions (real ToolDescriptor metadata) and closed JSON
// parameter schemas for every broker-visible M1 tool — never generic
// `additionalProperties: true`. No Zod introspection: explicit literals in
// `agent.ts` are cross-checked against the real Zod input schemas here.

import { randomUUID } from "node:crypto";
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  MarkdownSearchToolInputSchema,
  ReferenceOpenToolInputSchema,
  ReferenceRefreshToolInputSchema,
  ReferenceRelatedToolInputSchema,
  UuidSchema,
} from "@companion/contracts";
import type {
  ChatRequest,
  ChatResult,
  ModelGateway,
  NormalizedToolCall,
} from "@companion/model-local";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AGENT_MARKDOWN_SEARCH_PARAMETERS,
  AGENT_REFERENCE_OPEN_PARAMETERS,
  AGENT_REFERENCE_REFRESH_PARAMETERS,
  AGENT_REFERENCE_RELATED_PARAMETERS,
  AGENT_UUID_V4_PATTERN,
  answerSubmitToolDefinition,
  buildAgentToolDefinitions,
  closeKernelDatabase,
  createAgentStrategy,
  createKernelRepository,
  createM1ToolRegistrations,
  createReferenceManager,
  createToolBroker,
  freezeStrategyContext,
  migrateKernelDatabase,
  openKernelDatabase,
  type ToolBroker,
  type ToolRegistration,
} from "../src/index.js";

const T0 = 1790000000000;

async function setupM1Regs(): Promise<{
  handle: ReturnType<typeof openKernelDatabase>;
  regs: readonly ToolRegistration[];
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
    readCanonical: async () => ({
      canonicalKey: "vault/a.md",
      title: "A",
      text: "hello",
      sourceRevision: "s1",
      snippet: "hello",
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
  return { handle, regs };
}

function makeBroker(
  handle: ReturnType<typeof openKernelDatabase>,
  repo: ReturnType<typeof createKernelRepository>,
  regs: readonly ToolRegistration[],
): ToolBroker {
  return createToolBroker({ db: handle.raw, repo, registrations: regs });
}

function unknownReg(name = "test.read"): ToolRegistration {
  return {
    descriptor: {
      name,
      version: 1,
      title: "Unknown",
      description: "Unknown test tool without an explicit agent schema",
      category: "read",
      defaultTimeoutMs: 5000,
      maxTimeoutMs: 10_000,
      supportsRefresh: false,
    },
    inputSchema: z.strictObject({ q: z.string() }),
    outputSchema: z.strictObject({ ok: z.boolean() }),
    handler: (async () => ({ ok: true })) as ToolRegistration["handler"],
  };
}

describe("broker metadata API (minimal, immutable, static ownership)", () => {
  it("exposes frozen descriptor copies in registration order, no runtime", async () => {
    const { handle, regs } = await setupM1Regs();
    try {
      const repo = createKernelRepository(handle.raw);
      const broker = makeBroker(handle, repo, [...regs, unknownReg()]);
      const described = broker.describeTools();
      expect(described.map((d) => d.name)).toEqual([
        "markdown.search",
        "reference.open",
        "reference.refresh",
        "reference.related",
        "test.read",
      ]);
      // Frozen snapshots.
      for (const d of described) {
        expect(Object.isFrozen(d)).toBe(true);
      }
      // No runtime/handlers/identities leak through the metadata surface.
      for (const d of described) {
        expect(d).not.toHaveProperty("handler");
        expect(d).not.toHaveProperty("inputSchema");
        expect(d).not.toHaveProperty("normalize");
      }
      // Mutating a snapshot cannot mutate the registry.
      const first = described[0];
      expect(first).toBeDefined();
      if (first !== undefined) {
        expect(() => {
          (first as { description?: string }).description = "mutated";
        }).toThrow();
        expect(broker.describeTools()[0]?.description).toBe(first.description);
      }
      // Static ownership: repeated calls return equal but independent copies.
      const again = broker.describeTools();
      expect(again).toEqual(described);
      expect(again[0]).not.toBe(described[0]);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

describe("advertised ordinary tool definitions (exact closed schemas)", () => {
  it("uses real descriptor descriptions with closed schemas and answer.submit last", async () => {
    const { handle, regs } = await setupM1Regs();
    try {
      const repo = createKernelRepository(handle.raw);
      const broker = makeBroker(handle, repo, regs);
      const descriptors = broker.describeTools();
      const tools = buildAgentToolDefinitions(descriptors);
      expect(tools.map((t) => t.name)).toEqual([
        "markdown.search",
        "reference.open",
        "reference.refresh",
        "reference.related",
        "answer.submit",
      ]);
      // Descriptions come from the real ToolDescriptor metadata.
      for (const tool of tools.slice(0, 4)) {
        const descriptor = descriptors.find((d) => d.name === tool.name);
        expect(descriptor).toBeDefined();
        expect(tool.description).toBe(descriptor?.description);
        expect(tool.description).not.toMatch(/^Kernel tool /);
      }
      // Exact closed schemas (defaults/enums/ranges/required/no extras).
      expect(tools[0]?.parameters).toEqual({
        type: "object",
        properties: {
          query: { type: "string", minLength: 1, maxLength: 256 },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: MAX_SEARCH_LIMIT,
            default: DEFAULT_SEARCH_LIMIT,
          },
          freshness: {
            type: "string",
            enum: ["normal", "refresh"],
            default: "normal",
          },
        },
        required: ["query"],
        additionalProperties: false,
      });
      expect(tools[1]?.parameters).toEqual({
        type: "object",
        properties: {
          referenceId: { type: "string", pattern: AGENT_UUID_V4_PATTERN },
        },
        required: ["referenceId"],
        additionalProperties: false,
      });
      expect(tools[2]?.parameters).toEqual({
        type: "object",
        properties: {
          referenceId: { type: "string", pattern: AGENT_UUID_V4_PATTERN },
        },
        required: ["referenceId"],
        additionalProperties: false,
      });
      expect(tools[3]?.parameters).toEqual({
        type: "object",
        properties: {
          referenceId: { type: "string", pattern: AGENT_UUID_V4_PATTERN },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: MAX_SEARCH_LIMIT,
            default: DEFAULT_SEARCH_LIMIT,
          },
        },
        required: ["referenceId"],
        additionalProperties: false,
      });
      // Exported constants are the same schemas.
      expect(AGENT_MARKDOWN_SEARCH_PARAMETERS).toEqual(tools[0]?.parameters);
      expect(AGENT_REFERENCE_OPEN_PARAMETERS).toEqual(tools[1]?.parameters);
      expect(AGENT_REFERENCE_REFRESH_PARAMETERS).toEqual(tools[2]?.parameters);
      expect(AGENT_REFERENCE_RELATED_PARAMETERS).toEqual(tools[3]?.parameters);
      // Never generic: no additionalProperties:true anywhere ordinary.
      for (const tool of tools.slice(0, 4)) {
        expect(JSON.stringify(tool.parameters)).not.toContain(
          '"additionalProperties":true',
        );
        expect(
          (tool.parameters as { additionalProperties?: unknown })
            .additionalProperties,
        ).toBe(false);
      }
      // answer.submit stays separately defined and non-Broker, last.
      expect(tools[4]).toEqual(answerSubmitToolDefinition());
      expect(tools[4]?.name).toBe("answer.submit");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("skips unknown tools and unregistered names; empty broker yields answer.submit only", async () => {
    const { handle, regs } = await setupM1Regs();
    try {
      const repo = createKernelRepository(handle.raw);
      // Unknown registered tool is never advertised.
      const mixed = makeBroker(handle, repo, [unknownReg(), ...regs]);
      const tools = buildAgentToolDefinitions(mixed.describeTools());
      expect(tools.map((t) => t.name)).toEqual([
        "markdown.search",
        "reference.open",
        "reference.refresh",
        "reference.related",
        "answer.submit",
      ]);
      // Unknown-only broker yields the terminal protocol alone.
      const unknownOnly = makeBroker(handle, repo, [unknownReg()]);
      expect(
        buildAgentToolDefinitions(unknownOnly.describeTools()).map(
          (t) => t.name,
        ),
      ).toEqual(["answer.submit"]);
      // Empty broker yields the terminal protocol alone.
      const empty = makeBroker(handle, repo, []);
      expect(
        buildAgentToolDefinitions(empty.describeTools()).map((t) => t.name),
      ).toEqual(["answer.submit"]);
      // A forged answer.submit descriptor is never advertised as ordinary.
      const forged = buildAgentToolDefinitions([
        {
          name: "answer.submit",
          version: 1,
          title: "Forged",
          description: "Forged broker answer.submit",
          category: "read",
          defaultTimeoutMs: 1000,
          maxTimeoutMs: 1000,
          supportsRefresh: false,
        },
      ]);
      expect(forged.map((t) => t.name)).toEqual(["answer.submit"]);
      expect(forged).toEqual([answerSubmitToolDefinition()]);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("returns independent parameter copies (no shared mutation)", async () => {
    const { handle, regs } = await setupM1Regs();
    try {
      const repo = createKernelRepository(handle.raw);
      const broker = makeBroker(handle, repo, regs);
      const first = buildAgentToolDefinitions(broker.describeTools());
      const second = buildAgentToolDefinitions(broker.describeTools());
      expect(first).toEqual(second);
      expect(first[0]?.parameters).not.toBe(second[0]?.parameters);
      const firstParams = first[0]?.parameters as unknown as {
        required: string[];
      };
      expect(firstParams.required).toContain("query");
      firstParams.required.push("hacked");
      expect(second[0]?.parameters).toEqual(AGENT_MARKDOWN_SEARCH_PARAMETERS);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

describe("advertised schemas match accepted broker input (UUID contract retained)", () => {
  it("markdown.search: required/defaults/ranges/enums/closed match Zod", () => {
    // Minimal advertised input is accepted with broker defaults applied.
    expect(MarkdownSearchToolInputSchema.parse({ query: "vault" })).toEqual({
      query: "vault",
      limit: DEFAULT_SEARCH_LIMIT,
      freshness: "normal",
    });
    // Ranges/enums enforced on both sides (advertised min/max/enum).
    expect(() =>
      MarkdownSearchToolInputSchema.parse({ query: "x", limit: 0 }),
    ).toThrow();
    expect(() =>
      MarkdownSearchToolInputSchema.parse({
        query: "x",
        limit: MAX_SEARCH_LIMIT + 1,
      }),
    ).toThrow();
    expect(() =>
      MarkdownSearchToolInputSchema.parse({
        query: "x",
        freshness: "stale",
      }),
    ).toThrow();
    expect(() => MarkdownSearchToolInputSchema.parse({ query: "" })).toThrow();
    // Closed: extra keys rejected (advertised additionalProperties:false).
    expect(() =>
      MarkdownSearchToolInputSchema.parse({ query: "x", extra: 1 }),
    ).toThrow();
    expect(
      MarkdownSearchToolInputSchema.parse({ query: "x", limit: 20 }),
    ).toEqual({
      query: "x",
      limit: 20,
      freshness: "normal",
    });
  });

  it("reference.open/refresh/related: UUID required, closed, limit defaults", () => {
    const id = randomUUID();
    expect(ReferenceOpenToolInputSchema.parse({ referenceId: id })).toEqual({
      referenceId: id,
    });
    expect(ReferenceRefreshToolInputSchema.parse({ referenceId: id })).toEqual({
      referenceId: id,
    });
    expect(ReferenceRelatedToolInputSchema.parse({ referenceId: id })).toEqual({
      referenceId: id,
      limit: DEFAULT_SEARCH_LIMIT,
    });
    for (const schema of [
      ReferenceOpenToolInputSchema,
      ReferenceRefreshToolInputSchema,
      ReferenceRelatedToolInputSchema,
    ]) {
      expect(() => schema.parse({ referenceId: "r1" })).toThrow();
      expect(() => schema.parse({ referenceId: id, extra: 1 })).toThrow();
      expect(() => schema.parse({})).toThrow();
    }
    expect(() =>
      ReferenceRelatedToolInputSchema.parse({
        referenceId: id,
        limit: MAX_SEARCH_LIMIT + 1,
      }),
    ).toThrow();
  });

  it("advertised UUID pattern mirrors UuidSchema (v4 only, case-insensitive)", () => {
    const pattern = new RegExp(AGENT_UUID_V4_PATTERN);
    const v4 = randomUUID();
    expect(pattern.test(v4)).toBe(true);
    expect(() => UuidSchema.parse(v4)).not.toThrow();
    expect(() => UuidSchema.parse(v4.toUpperCase())).not.toThrow();
    expect(pattern.test(v4.toUpperCase())).toBe(true);
    // UUID v1 / nil / rN identifiers are rejected by both.
    for (const bad of [
      "6ec0bd7f-11c0-11d1-80de-00c04fd430c8",
      "00000000-0000-0000-0000-000000000000",
      "r1",
      "not-a-uuid",
    ]) {
      expect(pattern.test(bad)).toBe(false);
      expect(() => UuidSchema.parse(bad)).toThrow();
    }
  });
});

describe("strategy advertises exact broker schemas to the gateway", () => {
  it("first gateway request carries exact ordinary schemas + terminal last", async () => {
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
      const stubPort = {
        search: async () => ({ hits: [], skipped: [] }),
        readCanonical: async () => ({
          canonicalKey: "vault/a.md",
          title: "A",
          text: "hello",
          sourceRevision: "s1",
          snippet: "hello",
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
      const broker = makeBroker(handle, repo, [...regs, unknownReg()]);
      const answerCall: NormalizedToolCall = {
        id: "answer-1",
        name: "answer.submit",
        arguments: { version: 1, parts: [{ text: "done", citations: [] }] },
      };
      const result: ChatResult = {
        text: "",
        toolCalls: [answerCall],
        stopReason: "tool_calls",
      };
      const calls: ChatRequest[] = [];
      const gateway: ModelGateway = {
        provider: "ollama",
        capabilities: { toolCalling: true },
        baseUrl: "http://127.0.0.1:11434",
        chatUrl: "http://127.0.0.1:11434/api/chat",
        chat: async (request: ChatRequest) => {
          calls.push(request);
          return result;
        },
      };
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway,
        model: "test-model",
      });
      const sessionId = repo.createSession({
        key: randomUUID(),
        now: T0,
      }).body.sessionId;
      const posted = repo.postMessage(
        sessionId,
        { text: "research this" },
        { key: randomUUID(), now: T0 },
      );
      const runId = posted.body.run.id;
      repo.startRun(runId, { now: T0 + 1 });
      const run = repo.getRun(runId);
      const turn = repo.getTurn(run.turnId);
      const ctx = freezeStrategyContext(
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
      await strategy(ctx);
      expect(calls.length).toBeGreaterThan(0);
      const advertised = calls[0]?.tools ?? [];
      expect(advertised.map((t) => t.name)).toEqual([
        "markdown.search",
        "reference.open",
        "reference.refresh",
        "reference.related",
        "answer.submit",
      ]);
      expect(advertised[0]?.parameters).toEqual(
        AGENT_MARKDOWN_SEARCH_PARAMETERS,
      );
      expect(advertised[4]).toEqual(answerSubmitToolDefinition());
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
