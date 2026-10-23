// Agent pre-answer memory recall: only the rendered prefix is exposed and
// granted (astral 8192 boundary), and wall/engine cancellation aborts the
// recall instead of blocking past the deadline. Deterministic: in-memory
// DBs, scripted gateways and recall hooks, tiny real timeouts. No network.

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
  createToolBroker,
  formatMemoryPromptBlock,
  freezeStrategyContext,
  type KernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
  selectProjectedMemorySnippets,
  verifyCitations,
} from "../src/index.js";

const T0 = 1790000000000;
const SCOPE = "recall-scope";

function answerCall(citations: string[] = []): NormalizedToolCall {
  return {
    id: "answer-1",
    name: "answer.submit",
    arguments: { version: 1, parts: [{ text: "final", citations }] },
  };
}

function answerResult(citations: string[] = []): ChatResult {
  return {
    text: "",
    toolCalls: [answerCall(citations)],
    stopReason: "tool_calls",
  };
}

async function setup(): Promise<{
  handle: ReturnType<typeof openKernelDatabase>;
  repo: KernelRepository;
}> {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  return { handle, repo: createKernelRepository(handle.raw) };
}

function newRunningTurn(
  repo: KernelRepository,
  now: number,
  text = "research this",
): { sessionId: string; runId: string } {
  const sessionId = repo.createSession({ key: crypto.randomUUID(), now }).body
    .sessionId;
  const posted = repo.postMessage(
    sessionId,
    { text },
    { key: crypto.randomUUID(), now },
  );
  const runId = posted.body.run.id;
  repo.startRun(runId, { now: now + 1 });
  return { sessionId, runId };
}

function ctxFor(repo: KernelRepository, runId: string, signal?: AbortSignal) {
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
    signal ?? new AbortController().signal,
  );
}

/** Eight maximal snippets (512 code points each) built from astral units. */
function astralSnippets(): Array<{
  recordId: string;
  recallId: string;
  snippet: string;
}> {
  const out: Array<{ recordId: string; recallId: string; snippet: string }> =
    [];
  for (let i = 0; i < 8; i += 1) {
    out.push({
      recordId: `record-${i}`,
      recallId: "recall-astral",
      snippet: "😀".repeat(512),
    });
  }
  return out;
}

describe("memory block record dates", () => {
  const snippets = [
    {
      recordId: "r1",
      recallId: "k1",
      snippet: "User likes tea.",
      kind: "user_fact" as const,
      createdAt: "2026-10-22T18:30:00.000Z",
    },
  ];
  it("appends the 記録 date in the frozen zone", () => {
    expect(formatMemoryPromptBlock(snippets, "Asia/Tokyo")).toContain(
      "- m1 [user_fact]: User likes tea. (記録: 2026-10-23)",
    );
  });
  it("omits the date when createdAt is absent", () => {
    const block = formatMemoryPromptBlock(
      [
        {
          recordId: "r1",
          recallId: "k1",
          snippet: "User likes tea.",
          kind: "user_fact" as const,
        },
      ],
      "Asia/Tokyo",
    );
    expect(block).toContain("- m1 [user_fact]: User likes tea.");
    expect(block).not.toContain("記録:");
  });
});

describe("agent memory recall projection", () => {
  it("projects the astral 8192 prefix and exposes only what was rendered", async () => {
    const snippets = astralSnippets();
    // Pure projection first: UTF-16 counting prunes the tail even though
    // every snippet fits the 512-code-point validation cap.
    const kept = selectProjectedMemorySnippets(snippets);
    expect(kept.length).toBeLessThan(snippets.length);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.map((snippet) => snippet.recordId)).toEqual(
      snippets.slice(0, kept.length).map((snippet) => snippet.recordId),
    );
    const block = formatMemoryPromptBlock(snippets);
    expect(block.length).toBeLessThanOrEqual(8192);
    expect(block).toContain(`- m${kept.length} [`);
    expect(block).not.toContain(`- m${kept.length + 1}:`);
    expect(block).toMatch(
      new RegExp(
        `\\.\\.\\. and ${snippets.length - kept.length} more omitted to fit the memory budget\\.`,
      ),
    );

    const { handle, repo } = await setup();
    try {
      let seenMessages: ChatRequest["messages"] | undefined;
      const gateway: ModelGateway = {
        provider: "ollama",
        capabilities: { toolCalling: true },
        baseUrl: "http://127.0.0.1:11434",
        chatUrl: "http://127.0.0.1:11434/api/chat",
        chat: async (request: ChatRequest) => {
          seenMessages = request.messages;
          return answerResult(["m1"]);
        },
      };
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [],
      });
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway,
        model: "test-model",
        memory: {
          scope: SCOPE,
          recall: async () => snippets,
        },
      });
      const { runId } = newRunningTurn(repo, T0);
      await strategy(ctxFor(repo, runId));
      // Exposures cover exactly the rendered prefix in exposure order:
      // the pruned tail keeps no citable mN.
      const exposures = repo.listMemoryExposures(runId);
      expect(exposures.map((exposure) => exposure.citation)).toEqual(
        kept.map((_snippet, index) => `m${index + 1}`),
      );
      expect(exposures.map((exposure) => exposure.recordId)).toEqual(
        kept.map((snippet) => snippet.recordId),
      );
      expect(
        exposures.some((exposure) => exposure.recordId === "record-7"),
      ).toBe(kept.some((snippet) => snippet.recordId === "record-7"));
      // The model saw the same prefix: rendered block, no tail label.
      const userBlocks = (seenMessages ?? [])
        .filter((message) => message.role === "user")
        .map((message) => message.content)
        .join("\n");
      expect(userBlocks).toContain(block.split("\n")[1] ?? "");
      expect(userBlocks).not.toContain(`- m${kept.length + 1}:`);
      // Grants follow exposures: a cited tail mN is structurally invalid,
      // a cited kept mN verifies.
      const granted = new Set(exposures.map((exposure) => exposure.citation));
      const tailCitation = `m${kept.length + 1}`;
      expect(
        verifyCitations(
          { version: 1, parts: [{ text: "x", citations: [tailCitation] }] },
          new Map(),
          new Set(),
          granted,
        ).invalid,
      ).toEqual([tailCitation]);
      expect(
        verifyCitations(
          { version: 1, parts: [{ text: "x", citations: ["m1"] }] },
          new Map(),
          new Set(),
          granted,
        ).ok,
      ).toBe(true);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("pins the recalled revision/kind onto the exposure and the grant (I04)", async () => {
    const { handle, repo } = await setup();
    try {
      const gateway: ModelGateway = {
        provider: "ollama",
        capabilities: { toolCalling: true },
        baseUrl: "http://127.0.0.1:11434",
        chatUrl: "http://127.0.0.1:11434/api/chat",
        chat: async () => answerResult(["m1"]),
      };
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [],
      });
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway,
        model: "test-model",
        memory: {
          scope: SCOPE,
          recall: async () => [
            {
              recordId: "record-1",
              recallId: "recall-1",
              snippet: "delivered text",
              kind: "user_fact" as const,
              revision: 7,
            },
          ],
        },
      });
      const { runId } = newRunningTurn(repo, T0);
      await strategy(ctxFor(repo, runId));
      // The exposure snapshot pins the DELIVERED provenance.
      const exposures = repo.listMemoryExposures(runId);
      expect(exposures).toHaveLength(1);
      expect(exposures[0]).toMatchObject({
        citation: "m1",
        recordId: "record-1",
        snippet: "delivered text",
        revision: 7,
        kind: "user_fact",
      });
      // Grants without an accepted answer never exist; the citation-only
      // exposure path above never mints one (used vs delivered split).
      expect(repo.listMemoryGrants(runId)).toHaveLength(0);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("aborts a hanging recall on the wall deadline and never calls the model", async () => {
    const { handle, repo } = await setup();
    try {
      let recallAborted = false;
      let chatCalls = 0;
      const gateway: ModelGateway = {
        provider: "ollama",
        capabilities: { toolCalling: true },
        baseUrl: "http://127.0.0.1:11434",
        chatUrl: "http://127.0.0.1:11434/api/chat",
        chat: async () => {
          chatCalls += 1;
          return answerResult();
        },
      };
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [],
      });
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway,
        model: "test-model",
        wallMs: 40,
        memory: {
          scope: SCOPE,
          recall: (_query, signal) =>
            new Promise<readonly []>((_resolve, reject) => {
              if (signal.aborted) {
                recallAborted = true;
                reject(new Error("recall aborted"));
                return;
              }
              signal.addEventListener(
                "abort",
                () => {
                  recallAborted = true;
                  reject(new Error("recall aborted"));
                },
                { once: true },
              );
            }),
        },
      });
      const { runId } = newRunningTurn(repo, T0);
      await expect(strategy(ctxFor(repo, runId))).rejects.toMatchObject({
        errorCode: "execution_failed",
      });
      // The wall expiry cancelled the recall (fail-open, no model step
      // started past the deadline) instead of blocking on it.
      expect(recallAborted).toBe(true);
      expect(chatCalls).toBe(0);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("keeps engine cancellation distinct when it aborts a hanging recall", async () => {
    const { handle, repo } = await setup();
    try {
      let recallAborted = false;
      let chatCalls = 0;
      const gateway: ModelGateway = {
        provider: "ollama",
        capabilities: { toolCalling: true },
        baseUrl: "http://127.0.0.1:11434",
        chatUrl: "http://127.0.0.1:11434/api/chat",
        chat: async () => {
          chatCalls += 1;
          return answerResult();
        },
      };
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [],
      });
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker,
        gateway,
        model: "test-model",
        wallMs: 120_000,
        memory: {
          scope: SCOPE,
          recall: (_query, signal) =>
            new Promise<readonly []>((_resolve, reject) => {
              if (signal.aborted) {
                recallAborted = true;
                reject(new Error("recall aborted"));
                return;
              }
              signal.addEventListener(
                "abort",
                () => {
                  recallAborted = true;
                  reject(new Error("recall aborted"));
                },
                { once: true },
              );
            }),
        },
      });
      const { runId } = newRunningTurn(repo, T0);
      const controller = new AbortController();
      const pending = strategy(ctxFor(repo, runId, controller.signal));
      await new Promise((resolve) => setTimeout(resolve, 10));
      controller.abort();
      await expect(pending).rejects.toMatchObject({
        errorCode: "execution_cancelled",
      });
      expect(recallAborted).toBe(true);
      expect(chatCalls).toBe(0);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});

describe("memory block provenance labels", () => {
  it("labels user_fact as a fact and everything else as inference", () => {
    const snippets = [
      {
        recordId: "r1",
        recallId: "k1",
        snippet: "User likes tea.",
        kind: "user_fact" as const,
        revision: 2,
      },
      {
        recordId: "r2",
        recallId: "k2",
        snippet: "Model guessed coffee.",
        kind: "model_inference" as const,
      },
      { recordId: "r3", recallId: "k3", snippet: "Unknown provenance." },
      {
        recordId: "r4",
        recallId: "k4",
        snippet: "Recap.",
        kind: "summary" as const,
      },
      {
        recordId: "r5",
        recallId: "k5",
        snippet: "User corrected the time.",
        kind: "correction" as const,
      },
    ];
    const block = formatMemoryPromptBlock(snippets);
    expect(block).toContain("- m1 [user_fact]: User likes tea.");
    expect(block).toContain(
      "- m2 [model_inference — model inference, not a user fact]: Model guessed coffee.",
    );
    expect(block).toContain(
      "- m3 [inference — unverified provenance, not a user fact]: Unknown provenance.",
    );
    expect(block).toContain(
      "- m4 [summary — distilled inference, not a user fact]: Recap.",
    );
    expect(block).toContain(
      "- m5 [correction — revised memory, not a user fact]: User corrected the time.",
    );
    expect(block).toContain("only user_fact items are user-stated facts");
  });
});

describe("per-run memory status (I01-06)", () => {
  /** Scripted happy-path gateway: one model step, no tool calls. */
  function plainGateway(): ModelGateway {
    return {
      provider: "ollama",
      capabilities: { toolCalling: true },
      baseUrl: "http://127.0.0.1:11434",
      chatUrl: "http://127.0.0.1:11434/api/chat",
      chat: async () => answerResult(),
    };
  }

  it("records used when snippets were projected and the turn completes", async () => {
    const { handle, repo } = await setup();
    try {
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker: createToolBroker({
          db: handle.raw,
          repo,
          registrations: [],
        }),
        gateway: plainGateway(),
        model: "test-model",
        memory: {
          scope: SCOPE,
          recall: async () => [
            {
              recordId: "record-1",
              recallId: "recall-1",
              snippet: "User likes tea.",
            },
          ],
        },
      });
      const { runId } = newRunningTurn(repo, T0);
      await expect(strategy(ctxFor(repo, runId))).resolves.toBeDefined();
      expect(repo.getRun(runId).memoryStatus).toBe("used");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("records empty when recall succeeds with nothing to show", async () => {
    const { handle, repo } = await setup();
    try {
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker: createToolBroker({
          db: handle.raw,
          repo,
          registrations: [],
        }),
        gateway: plainGateway(),
        model: "test-model",
        memory: { scope: SCOPE, recall: async () => [] },
      });
      const { runId } = newRunningTurn(repo, T0);
      await expect(strategy(ctxFor(repo, runId))).resolves.toBeDefined();
      expect(repo.getRun(runId).memoryStatus).toBe("empty");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("records timeout from the reported CLI code and the turn still completes", async () => {
    const { handle, repo } = await setup();
    try {
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker: createToolBroker({
          db: handle.raw,
          repo,
          registrations: [],
        }),
        gateway: plainGateway(),
        model: "test-model",
        memory: {
          scope: SCOPE,
          recall: async (_query, _signal, onFailure) => {
            onFailure?.("cli_timeout");
            return [];
          },
        },
      });
      const { runId } = newRunningTurn(repo, T0);
      // Memoryless continuation: the run completes, never fails.
      await expect(strategy(ctxFor(repo, runId))).resolves.toBeDefined();
      expect(repo.getRun(runId).memoryStatus).toBe("timeout");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("records version_mismatch and limit from the reported CLI codes", async () => {
    const { handle, repo } = await setup();
    try {
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker: createToolBroker({
          db: handle.raw,
          repo,
          registrations: [],
        }),
        gateway: plainGateway(),
        model: "test-model",
        memory: {
          scope: SCOPE,
          recall: async (_query, _signal, onFailure) => {
            onFailure?.("cli_version_mismatch");
            throw new Error("recall rejected");
          },
        },
      });
      const { runId } = newRunningTurn(repo, T0);
      await expect(strategy(ctxFor(repo, runId))).resolves.toBeDefined();
      expect(repo.getRun(runId).memoryStatus).toBe("version_mismatch");

      const strategy2 = createAgentStrategy({
        db: handle.raw,
        repo,
        broker: createToolBroker({
          db: handle.raw,
          repo,
          registrations: [],
        }),
        gateway: plainGateway(),
        model: "test-model",
        memory: {
          scope: SCOPE,
          recall: async (_query, _signal, onFailure) => {
            onFailure?.("cli_limit");
            return [];
          },
        },
      });
      const { runId: runId2 } = newRunningTurn(repo, T0 + 1);
      await expect(strategy2(ctxFor(repo, runId2))).resolves.toBeDefined();
      expect(repo.getRun(runId2).memoryStatus).toBe("limit");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("records unavailable for an unclassified thrown recall", async () => {
    const { handle, repo } = await setup();
    try {
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker: createToolBroker({
          db: handle.raw,
          repo,
          registrations: [],
        }),
        gateway: plainGateway(),
        model: "test-model",
        memory: {
          scope: SCOPE,
          recall: async () => {
            throw new Error("boom");
          },
        },
      });
      const { runId } = newRunningTurn(repo, T0);
      await expect(strategy(ctxFor(repo, runId))).resolves.toBeDefined();
      expect(repo.getRun(runId).memoryStatus).toBe("unavailable");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("records disabled when memory is not configured and the turn completes", async () => {
    const { handle, repo } = await setup();
    try {
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker: createToolBroker({
          db: handle.raw,
          repo,
          registrations: [],
        }),
        gateway: plainGateway(),
        model: "test-model",
      });
      const { runId } = newRunningTurn(repo, T0);
      await expect(strategy(ctxFor(repo, runId))).resolves.toBeDefined();
      expect(repo.getRun(runId).memoryStatus).toBe("disabled");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("keeps the status absent for runs that never reach the recall boundary", async () => {
    const { handle, repo } = await setup();
    try {
      // An already-cancelled context fails the run before the recall
      // boundary: no marker is written (honest NULL).
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker: createToolBroker({
          db: handle.raw,
          repo,
          registrations: [],
        }),
        gateway: plainGateway(),
        model: "test-model",
        memory: {
          scope: SCOPE,
          recall: async () => [],
        },
      });
      const { runId } = newRunningTurn(repo, T0);
      const aborted = new AbortController();
      aborted.abort();
      await expect(
        strategy(ctxFor(repo, runId, aborted.signal)),
      ).rejects.toMatchObject({
        errorCode: "execution_cancelled",
      });
      expect(repo.getRun(runId).memoryStatus).toBeNull();
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
