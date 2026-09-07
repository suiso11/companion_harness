// Wall-start entry (r3946692097): the 300s whole-run wall deadline starts at
// strategy invocation before any loadHistory/loadReferenceSummary/ordinal-map
// /projectPrompt work, with an authoritative clock/deadline recheck after
// synchronous preparation and before the first gateway call. Preparation that
// consumes/exceeds the budget aborts without model or tool invocation (hence
// no model_calls row). Deterministic: in-memory DBs, fake clock advanced by
// synchronous DB preparation via a prepare-intercepting proxy, counting
// gateways, real timers (never fire; only the recheck decides). No network.
import type {
  ChatRequest,
  ChatResult,
  ModelGateway,
  NormalizedToolCall,
} from "@companion/model-local";
import { describe, expect, it } from "vitest";
import {
  AGENT_WALL_MS,
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

function answerCall(): NormalizedToolCall {
  return {
    id: "answer-1",
    name: "answer.submit",
    arguments: { version: 1, parts: [{ text: "final", citations: [] }] },
  };
}

function answerResult(): ChatResult {
  return { text: "", toolCalls: [answerCall()], stopReason: "tool_calls" };
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
): { sessionId: string; runId: string } {
  const sessionId = repo.createSession({ key: crypto.randomUUID(), now }).body
    .sessionId;
  const posted = repo.postMessage(
    sessionId,
    { text: "research this" },
    { key: crypto.randomUUID(), now },
  );
  const runId = posted.body.run.id;
  repo.startRun(runId, { now: now + 1 });
  return { sessionId, runId };
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

/** DB proxy whose synchronous preparation consumes wall-budget time. */
function prepConsumingDb(raw: unknown, onPrepare: () => void): unknown {
  const target = raw as Record<string | symbol, unknown>;
  return new Proxy(target, {
    get(t, p, receiver): unknown {
      if (p === "prepare") {
        return (...args: unknown[]): unknown => {
          onPrepare();
          return (Reflect.get(t, p, receiver) as (...a: unknown[]) => unknown)(
            ...args,
          );
        };
      }
      const value = Reflect.get(t, p, receiver);
      return typeof value === "function"
        ? (...args: unknown[]): unknown =>
            (value as (...a: unknown[]) => unknown).apply(t, args)
        : value;
    },
  });
}

describe("wall deadline starts before preparation", () => {
  it("fails without model invocation when DB preparation reaches the exact wall deadline", async () => {
    expect(AGENT_WALL_MS).toBe(300_000);
    const { handle, repo } = await setup();
    try {
      let now = T0;
      const clock = { now: () => now };
      let chatCalls = 0;
      const gateway: ModelGateway = {
        provider: "ollama",
        capabilities: { toolCalling: true },
        baseUrl: "http://127.0.0.1:11434",
        chatUrl: "http://127.0.0.1:11434/api/chat",
        chat: (_request: ChatRequest): Promise<ChatResult> => {
          chatCalls += 1;
          return Promise.resolve(answerResult());
        },
      };
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [],
      });
      // Synchronous DB preparation consumes the whole wall budget: the first
      // prepare during loadHistory jumps the fake clock to the exact
      // deadline. Fail-closed: at-or-past is past budget.
      const db = prepConsumingDb(handle.raw, () => {
        now = T0 + AGENT_WALL_MS;
      }) as never;
      const strategy = createAgentStrategy({
        db,
        repo,
        broker,
        gateway,
        model: "m",
        clock,
      });
      const { sessionId, runId } = newRunningTurn(repo, T0);
      await expect(strategy(ctxFor(repo, runId))).rejects.toMatchObject({
        name: "StrategyError",
        errorCode: "execution_failed",
      });
      expect(chatCalls).toBe(0);
      expect(repo.listModelCalls(runId)).toHaveLength(0);
      const events = repo
        .getEvents(sessionId, runId, {})
        .events.filter((e) => e.type.startsWith("model.step."));
      expect(events).toHaveLength(0);
      expect(repo.getRun(runId).status).toBe("running");
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("proceeds normally when DB preparation lands just before the wall deadline", async () => {
    const { handle, repo } = await setup();
    try {
      let now = T0;
      const clock = { now: () => now };
      let chatCalls = 0;
      const gateway: ModelGateway = {
        provider: "ollama",
        capabilities: { toolCalling: true },
        baseUrl: "http://127.0.0.1:11434",
        chatUrl: "http://127.0.0.1:11434/api/chat",
        chat: (_request: ChatRequest): Promise<ChatResult> => {
          chatCalls += 1;
          return Promise.resolve(answerResult());
        },
      };
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [],
      });
      const db = prepConsumingDb(handle.raw, () => {
        // First preparation query consumes nearly the whole budget but stays
        // just before the deadline; later prepares must not advance further.
        if (now === T0) {
          now = T0 + AGENT_WALL_MS - 1;
        }
      }) as never;
      const strategy = createAgentStrategy({
        db,
        repo,
        broker,
        gateway,
        model: "m",
        clock,
        // Oversized step budget isolates the wall: only the wall decides.
        stepTimeoutMs: 600_000,
      });
      const { runId } = newRunningTurn(repo, T0);
      await expect(strategy(ctxFor(repo, runId))).resolves.toEqual({
        version: 2,
        text: "final",
        answer: { version: 1, parts: [{ text: "final", citations: [] }] },
      });
      expect(chatCalls).toBe(1);
      const rows = repo.listModelCalls(runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        step: 1,
        outcome: "completed",
        errorCode: null,
      });
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
