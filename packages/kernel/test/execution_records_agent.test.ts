// Agent/Broker execution-recording integration: the opt-in recorder sees
// actual model requests, malformed raw provider bytes before parsing, tool
// inputs/results, and terminal outcomes. A recorder write failure makes the
// invocation fail explicitly instead of implying the record was captured.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ChatRequest,
  type ChatResult,
  createOpenAICompatibleGateway,
  type FetchImpl,
  type ModelGateway,
  type NormalizedToolCall,
} from "@companion/model-local";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  closeKernelDatabase,
  createAgentStrategy,
  createExecutionRecordStore,
  createKernelRepository,
  createToolBroker,
  ExecutionRecordError,
  type ExecutionRecorder,
  freezeStrategyContext,
  type KernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
  type RunStrategyContext,
  type ToolBroker,
} from "../src/index.js";

const T0 = 1_790_000_000_000;
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop() as string, { recursive: true, force: true });
  }
});

function call(name: string, args: unknown, id: string): NormalizedToolCall {
  return { id, name, arguments: args };
}

function chat(toolCalls: NormalizedToolCall[], text = ""): ChatResult {
  return {
    text,
    toolCalls,
    stopReason: toolCalls.length > 0 ? "tool_calls" : "stop",
  };
}

function sseChunk(body: unknown): string {
  return `data: ${JSON.stringify(body)}\n\n`;
}

function gatewayWithRaw(script: ChatResult[], rawBody: string): ModelGateway {
  let index = 0;
  return {
    provider: "ollama",
    capabilities: { toolCalling: true },
    baseUrl: "http://127.0.0.1:11434",
    chatUrl: "http://127.0.0.1:11434/api/chat",
    async chat(
      _request: ChatRequest,
      options?: {
        onRawResponse?: (raw: { status: number; body: string }) => void;
      },
    ): Promise<ChatResult> {
      options?.onRawResponse?.({ status: 200, body: rawBody });
      const next = script[Math.min(index, script.length - 1)];
      index += 1;
      return next as ChatResult;
    },
  };
}

function registration(): Parameters<
  typeof createToolBroker
>[0]["registrations"][number] {
  return {
    descriptor: {
      name: "test.read",
      version: 1,
      title: "Read",
      description: "Read fixed evidence",
      category: "read",
      defaultTimeoutMs: 5000,
      maxTimeoutMs: 10_000,
      supportsRefresh: false,
    },
    inputSchema: z.strictObject({ q: z.string() }),
    outputSchema: z.strictObject({ text: z.string() }),
    async handler(input: { q: string }) {
      return { text: `evidence:${input.q}` };
    },
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

function running(
  repo: KernelRepository,
  signal?: AbortSignal,
): {
  sessionId: string;
  runId: string;
  ctx: RunStrategyContext;
} {
  const sessionId = repo.createSession({
    key: crypto.randomUUID(),
    now: T0,
  }).body.sessionId;
  const posted = repo.postMessage(
    sessionId,
    { text: "fixed task" },
    { key: crypto.randomUUID(), now: T0 },
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
    signal ?? new AbortController().signal,
  );
  return { sessionId, runId, ctx };
}

function broker(
  handle: ReturnType<typeof openKernelDatabase>,
  repo: KernelRepository,
  recorder?: ExecutionRecorder,
): ToolBroker {
  return createToolBroker({
    db: handle.raw,
    repo,
    registrations: [registration()],
    ...(recorder === undefined ? {} : { executionRecorder: recorder }),
  });
}

function readDescriptor(name: string) {
  return {
    name,
    version: 1 as const,
    title: name,
    description: `${name} read tool`,
    category: "read" as const,
    defaultTimeoutMs: 5000,
    maxTimeoutMs: 10_000,
    supportsRefresh: false,
  };
}

describe("agent private execution recording", () => {
  it("records actual request settings, malformed raw bytes, tool I/O, and outcome", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-records-"));
    roots.push(root);
    const recorder = createExecutionRecordStore({
      directory: join(root, "private"),
      clock: { now: () => T0 },
    });
    const { handle, repo } = await setup();
    try {
      const gateway = gatewayWithRaw(
        [
          chat([call("test.read", { q: "alpha" }, "tool-1")]),
          chat([
            call(
              "answer.submit",
              { version: 1, parts: [{ text: "done", citations: [] }] },
              "answer-1",
            ),
          ]),
        ],
        '{"this is "malformed',
      );
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker: broker(handle, repo, recorder),
        gateway,
        model: "local-model",
        executionRecorder: recorder,
      });
      const { sessionId, runId, ctx } = running(repo);
      await strategy(ctx);

      const exported = recorder.exportRun(runId);
      const kinds = exported.map((record) => record.kind);
      expect(kinds).toContain("model.request");
      expect(kinds).toContain("model.response.raw");
      expect(kinds).toContain("model.response");
      expect(kinds).toContain("tool.input");
      expect(kinds).toContain("tool.result");
      const request = exported.find(
        (record) => record.kind === "model.request",
      );
      expect(request?.data).toMatchObject({
        provider: "ollama",
        model: "local-model",
        settings: {
          systemPrompt: expect.stringContaining("read-only research assistant"),
          harnessFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      });
      const raw = exported.find(
        (record) => record.kind === "model.response.raw",
      );
      expect(raw?.data).toEqual({
        status: 200,
        body: '{"this is "malformed',
      });
      const toolInput = exported.find((record) => record.kind === "tool.input");
      expect(toolInput?.data).toMatchObject({
        tool: "test.read",
        args: { q: "alpha" },
      });
      const toolResult = exported.find(
        (record) => record.kind === "tool.result",
      );
      expect(toolResult?.data).toMatchObject({
        tool: "test.read",
        result: { disposition: "accepted" },
      });
      expect(
        recorder.list().records.every((record) => record.runId === runId),
      ).toBe(true);
      expect(repo.getRun(runId).sessionId).toBe(sessionId);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("records model.response.raw for each streamed gateway call", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-records-stream-"));
    roots.push(root);
    const recorder = createExecutionRecordStore({
      directory: join(root, "private"),
      clock: { now: () => T0 },
    });
    const { handle, repo } = await setup();
    try {
      const streamBodies = [
        [
          sseChunk({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "stream-tool-1",
                      type: "function",
                      function: {
                        name: "test.read",
                        arguments: JSON.stringify({ q: "alpha" }),
                      },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          }),
          "data: [DONE]\n\n",
        ].join(""),
        [
          sseChunk({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "stream-answer-1",
                      type: "function",
                      function: {
                        name: "answer.submit",
                        arguments: JSON.stringify({
                          version: 1,
                          parts: [{ text: "done", citations: [] }],
                        }),
                      },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          }),
          "data: [DONE]\n\n",
        ].join(""),
      ];
      let callIndex = 0;
      const fetchImpl: FetchImpl = async () => {
        const body =
          streamBodies[Math.min(callIndex, streamBodies.length - 1)] ?? "";
        callIndex += 1;
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      };
      const gateway = createOpenAICompatibleGateway({
        baseUrl: "http://127.0.0.1:8000",
        fetchImpl,
        streamingEnabled: true,
      });
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker: broker(handle, repo, recorder),
        gateway,
        model: "local-model",
        executionRecorder: recorder,
      });
      const { runId, ctx } = running(repo);
      await strategy(ctx);

      const exported = recorder.exportRun(runId);
      const rawRecords = exported.filter(
        (record) => record.kind === "model.response.raw",
      );
      // One raw record per streamed model call, with the exact SSE bytes.
      expect(rawRecords).toHaveLength(2);
      expect(rawRecords.map((record) => record.data)).toEqual(
        expect.arrayContaining([
          { status: 200, body: streamBodies[0] },
          { status: 200, body: streamBodies[1] },
        ]),
      );
      expect(callIndex).toBe(2);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("fails the model step explicitly when the private record cannot be written", async () => {
    const recorder = {
      record(): void {
        throw new Error("disk full");
      },
    };
    const { handle, repo } = await setup();
    try {
      const gateway = gatewayWithRaw(
        [
          chat([
            call(
              "answer.submit",
              { version: 1, parts: [{ text: "x", citations: [] }] },
              "a",
            ),
          ]),
        ],
        "{}",
      );
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker: broker(handle, repo),
        gateway,
        model: "local-model",
        executionRecorder: recorder,
      });
      const { runId, ctx } = running(repo);
      await expect(strategy(ctx)).rejects.toThrow();
      expect(repo.getRun(runId).status).toBe("running");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("fails the Run when a handler's own record write throws", async () => {
    const { handle, repo } = await setup();
    try {
      const registration = {
        descriptor: readDescriptor("test.record"),
        inputSchema: z.strictObject({ q: z.string() }),
        outputSchema: z.strictObject({ text: z.string() }),
        async handler(): Promise<never> {
          throw new ExecutionRecordError("record_write_failed", "disk full");
        },
      };
      const recorder: ExecutionRecorder = { record(): void {} };
      const testBroker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [registration],
        executionRecorder: recorder,
      });
      const gateway = gatewayWithRaw(
        [
          chat([call("test.record", { q: "alpha" }, "tool-1")]),
          chat([
            call(
              "answer.submit",
              {
                version: 1,
                parts: [{ text: "should not run", citations: [] }],
              },
              "answer-1",
            ),
          ]),
        ],
        "{}",
      );
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker: testBroker,
        gateway,
        model: "local-model",
      });
      const { runId, ctx } = running(repo);
      await expect(strategy(ctx)).rejects.toThrow("execution_failed");
      expect(repo.getRun(runId).status).toBe("running");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it.each(["tool.input", "tool.handler.result", "tool.result"])(
    "fails the Run instead of submitting an answer when %s recording fails",
    async (failingKind) => {
      const recorder: ExecutionRecorder = {
        record(input): void {
          if (input.kind === failingKind) {
            throw new ExecutionRecordError("record_write_failed", "disk full");
          }
        },
      };
      const { handle, repo } = await setup();
      try {
        const gateway = gatewayWithRaw(
          [
            chat([call("test.read", { q: "alpha" }, "tool-1")]),
            chat([
              call(
                "answer.submit",
                {
                  version: 1,
                  parts: [{ text: "should not run", citations: [] }],
                },
                "answer-1",
              ),
            ]),
          ],
          "{}",
        );
        const strategy = createAgentStrategy({
          db: handle.raw,
          repo,
          broker: broker(handle, repo, recorder),
          gateway,
          model: "local-model",
        });
        const { runId, ctx } = running(repo);
        await expect(strategy(ctx)).rejects.toThrow("execution_failed");
        expect(repo.getRun(runId).status).toBe("running");
      } finally {
        closeKernelDatabase(handle);
      }
    },
  );

  it("completes the public row and terminal event before failing on a model.response record error", async () => {
    const recorder: ExecutionRecorder = {
      record(input): void {
        if (input.kind === "model.response") {
          throw new ExecutionRecordError("record_write_failed", "disk full");
        }
      },
    };
    const { handle, repo } = await setup();
    try {
      const gateway = gatewayWithRaw(
        [
          chat([
            call(
              "answer.submit",
              { version: 1, parts: [{ text: "done", citations: [] }] },
              "answer-1",
            ),
          ]),
        ],
        "{}",
      );
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker: broker(handle, repo),
        gateway,
        model: "local-model",
        executionRecorder: recorder,
      });
      const { sessionId, runId, ctx } = running(repo);
      await expect(strategy(ctx)).rejects.toThrow("disk full");

      const calls = repo.listModelCalls(runId);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        step: 1,
        outcome: "completed",
        errorCode: null,
      });
      const events = repo
        .getEvents(sessionId, runId, {})
        .events.filter((event) => event.type.startsWith("model.step."));
      expect(
        events.filter((event) => event.type === "model.step.started"),
      ).toHaveLength(1);
      expect(
        events.filter((event) => event.type === "model.step.completed"),
      ).toHaveLength(1);
      expect(
        events.filter((event) => event.type === "model.step.failed"),
      ).toHaveLength(0);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("records a cancelled model.outcome when cancellation surfaces as a gateway error", async () => {
    const recorded: Array<{ kind: string; data: unknown }> = [];
    const recorder: ExecutionRecorder = {
      record(input): void {
        recorded.push({ kind: input.kind, data: input.data });
      },
    };
    const { handle, repo } = await setup();
    try {
      // A signal that is not aborted during the gateway call but is observed
      // as aborted by the settlement-error cancellation check, exercising the
      // defensive `signal.aborted || isEngineAbortRejection` branch.
      const signal = {
        aborted: false,
        addEventListener(): void {},
        removeEventListener(): void {},
      } as unknown as AbortSignal;
      const gateway: ModelGateway = {
        provider: "ollama",
        capabilities: { toolCalling: true },
        baseUrl: "http://127.0.0.1:11434",
        chatUrl: "http://127.0.0.1:11434/api/chat",
        chat(): Promise<ChatResult> {
          const thenable = {
            // biome-ignore lint/suspicious/noThenProperty: the thenable rejection path is the test subject.
            then(
              _resolve: (value: ChatResult) => void,
              reject?: (reason: unknown) => void,
            ): void {
              reject?.(new Error("gateway failed"));
              (signal as { aborted: boolean }).aborted = true;
            },
          };
          return thenable as unknown as Promise<ChatResult>;
        },
      };
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker: broker(handle, repo),
        gateway,
        model: "local-model",
        executionRecorder: recorder,
      });
      const { sessionId, runId, ctx } = running(repo, signal);
      await expect(strategy(ctx)).rejects.toMatchObject({
        errorCode: "execution_cancelled",
      });

      const outcomes = recorded.filter(
        (entry) => entry.kind === "model.outcome",
      );
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]?.data).toMatchObject({
        outcome: "cancelled",
        errorCode: null,
      });
      expect(repo.listModelCalls(runId)[0]).toMatchObject({
        outcome: "cancelled",
        errorCode: null,
      });
      const events = repo
        .getEvents(sessionId, runId, {})
        .events.filter((event) => event.type.startsWith("model.step."));
      expect(
        events.filter((event) => event.type === "model.step.started"),
      ).toHaveLength(1);
      expect(
        events.filter((event) => event.type === "model.step.failed"),
      ).toHaveLength(0);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
