// Safe gateway diagnostics: the public M2 failure code stays unchanged while
// the fixed gateway code/cause and numeric HTTP status are retained on the
// existing model.step.failed audit event and failure sink. Raw messages,
// bodies, headers, prompts, and reasoning never travel.
import type {
  ChatRequest,
  ChatResult,
  ModelGateway,
} from "@companion/model-local";
import { ModelLocalError } from "@companion/model-local";
import { describe, expect, it } from "vitest";
import {
  type AgentModelStepFailure,
  closeKernelDatabase,
  createAgentStrategy,
  createKernelRepository,
  createToolBroker,
  freezeStrategyContext,
  type KernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
} from "../src/index.js";

const T0 = 1790000000000;
const RAW = "raw-provider-body-SECRET-do-not-persist";

function failingGateway(error: Error): ModelGateway {
  return {
    provider: "openai-compatible",
    capabilities: { toolCalling: true },
    baseUrl: "http://127.0.0.1:8000",
    chatUrl: "http://127.0.0.1:8000/chat/completions",
    chat: async (_request: ChatRequest): Promise<ChatResult> => {
      throw error;
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

function newRunningRun(repo: KernelRepository): string {
  const sessionId = repo.createSession({
    key: crypto.randomUUID(),
    now: T0,
  }).body.sessionId;
  const posted = repo.postMessage(
    sessionId,
    { text: "hello" },
    { key: crypto.randomUUID(), now: T0 },
  );
  const runId = posted.body.run.id;
  repo.startRun(runId, { now: T0 + 1 });
  return runId;
}

const cases = [
  {
    name: "invalid_response keeps oversize cause",
    error: new ModelLocalError("invalid_response", RAW, undefined, {
      invalidResponseCause: "response_too_large",
    }),
    m2Code: "model_unavailable" as const,
    publicCode: "execution_failed",
    expected: {
      gatewayErrorCode: "invalid_response",
      invalidResponseCause: "response_too_large",
    },
  },
  {
    name: "request_failed keeps numeric HTTP status",
    error: new ModelLocalError("request_failed", RAW, undefined, {
      httpStatus: 503,
    }),
    m2Code: "model_unavailable" as const,
    publicCode: "execution_failed",
    expected: { gatewayErrorCode: "request_failed", httpStatus: 503 },
  },
  {
    name: "transport_error stays distinct",
    error: new ModelLocalError("transport_error", RAW),
    m2Code: "model_unavailable" as const,
    publicCode: "execution_failed",
    expected: { gatewayErrorCode: "transport_error" },
  },
  {
    name: "provider timeout keeps its existing audit code",
    error: new ModelLocalError("timeout", RAW),
    m2Code: "model_step_timeout" as const,
    publicCode: "execution_failed",
    expected: { gatewayErrorCode: "timeout" },
  },
] as const;

describe("safe gateway failure diagnostics", () => {
  it("retains fixed cause/status beside the unchanged public M2 code", async () => {
    for (const testCase of cases) {
      const { handle, repo } = await setup();
      try {
        const broker = createToolBroker({
          db: handle.raw,
          repo,
          registrations: [],
        });
        const seen: AgentModelStepFailure[] = [];
        const strategy = createAgentStrategy({
          db: handle.raw,
          repo,
          broker,
          gateway: failingGateway(testCase.error),
          model: "m",
          onModelStepFailed: (failure): void => {
            seen.push(failure);
          },
        });
        const runId = newRunningRun(repo);
        await expect(strategy(ctxFor(repo, runId))).rejects.toMatchObject({
          errorCode: testCase.publicCode,
        });
        const rows = repo.listModelCalls(runId);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          step: 1,
          outcome:
            testCase.m2Code === "model_step_timeout" ? "timeout" : "failed",
          errorCode: testCase.m2Code,
        });
        const events = repo.getEvents(
          repo.getRun(runId).sessionId,
          runId,
          {},
        ).events;
        const failed = events.filter((e) => e.type === "model.step.failed");
        expect(failed).toHaveLength(1);
        expect(failed[0]?.payload).toMatchObject({
          step: 1,
          errorCode: testCase.m2Code,
          ...testCase.expected,
        });
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({
          errorCode: testCase.m2Code,
          ...testCase.expected,
        });
        const blob = JSON.stringify({ rows, events, seen });
        expect(blob).not.toContain(RAW);
      } finally {
        closeKernelDatabase(handle);
      }
    }
  });

  it("accepts every additive diagnostic on the strict payload and fires the sink", async () => {
    const { handle, repo } = await setup();
    try {
      const runId = newRunningRun(repo);
      // The strict contract must accept all additive diagnostics (regression:
      // a rejected payload rolled back the audit event AND skipped the sink).
      expect(() =>
        repo.appendModelStepEvent(
          runId,
          "model.step.failed",
          {
            step: 1,
            errorCode: "model_unavailable",
            durationMs: 5,
            gatewayErrorCode: "request_failed",
            invalidResponseCause: "malformed_json",
            httpStatus: 429,
          },
          { now: T0 + 1 },
        ),
      ).not.toThrow();
      const run = repo.getRun(runId);
      const failed = repo
        .getEvents(run.sessionId, runId, {})
        .events.filter((event) => event.type === "model.step.failed");
      expect(failed).toHaveLength(1);
      expect(failed[0]?.payload).toMatchObject({
        step: 1,
        errorCode: "model_unavailable",
        gatewayErrorCode: "request_failed",
        invalidResponseCause: "malformed_json",
        httpStatus: 429,
      });

      // The same failure path still emits model.step.failed AND fires the
      // onModelStepFailed sink once.
      const seen: AgentModelStepFailure[] = [];
      const strategy = createAgentStrategy({
        db: handle.raw,
        repo,
        broker: createToolBroker({
          db: handle.raw,
          repo,
          registrations: [],
        }),
        gateway: failingGateway(
          new ModelLocalError("request_failed", RAW, undefined, {
            httpStatus: 429,
          }),
        ),
        model: "m",
        onModelStepFailed: (failure): void => {
          seen.push(failure);
        },
      });
      const liveRun = newRunningRun(repo);
      await expect(strategy(ctxFor(repo, liveRun))).rejects.toMatchObject({
        errorCode: "execution_failed",
      });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        errorCode: "model_unavailable",
        gatewayErrorCode: "request_failed",
        httpStatus: 429,
      });
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
