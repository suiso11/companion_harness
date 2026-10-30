// Self-improvement loop observer (P2): strict parse/grounding plus the
// service behaviour against a real kernel DB and a fake gateway.

import { randomUUID } from "node:crypto";
import {
  closeKernelDatabase,
  createKernelRepository,
  type KernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
} from "@companion/kernel";
import type {
  ChatRequest,
  ChatResult,
  ModelGateway,
} from "@companion/model-local";
import { afterEach, describe, expect, it } from "vitest";
import {
  createReflectService,
  isGroundableProposal,
  parseReflectProposal,
  type ReflectService,
} from "../src/reflect_service.js";

const T0 = 1_790_000_000_000;

describe("reflect proposal parsing", () => {
  it("accepts exactly the two keys, with or without a fence", () => {
    expect(
      parseReflectProposal('{"statement":"be shorter","quote":"もっと短く"}'),
    ).toEqual({ statement: "be shorter", quote: "もっと短く" });
    expect(
      parseReflectProposal(
        '```json\n{"statement":"be shorter","quote":"もっと短く"}\n```',
      ),
    ).toEqual({ statement: "be shorter", quote: "もっと短く" });
  });

  it("rejects prose, extra keys, wrong types and oversized values", () => {
    expect(parseReflectProposal("I think you should be shorter")).toBeNull();
    expect(
      parseReflectProposal('{"statement":"x","quote":"y","extra":1}'),
    ).toBeNull();
    expect(parseReflectProposal('{"statement":1,"quote":"y"}')).toBeNull();
    expect(
      parseReflectProposal(`{"statement":"${"a".repeat(401)}","quote":"y"}`),
    ).toBeNull();
  });

  it("grounds only on a verbatim span of the user text", () => {
    const user = "もっと短く答えて。あと敬語はなしで。";
    expect(
      isGroundableProposal(
        { statement: "be shorter", quote: "もっと短く" },
        user,
      ),
    ).toBe(true);
    expect(
      isGroundableProposal(
        { statement: "be shorter", quote: "短く答えて" },
        user,
      ),
    ).toBe(true);
    expect(
      isGroundableProposal(
        { statement: "be shorter", quote: "もっと長く" },
        user,
      ),
    ).toBe(false);
    expect(
      isGroundableProposal({ statement: "", quote: "もっと短く" }, user),
    ).toBe(false);
  });
});

function fakeGateway(reply: string | null): {
  gateway: ModelGateway;
  calls: ChatRequest[];
} {
  const calls: ChatRequest[] = [];
  return {
    calls,
    gateway: {
      provider: "ollama",
      capabilities: { toolCalling: false },
      baseUrl: "http://127.0.0.1:11434",
      chatUrl: "http://127.0.0.1:11434/api/chat",
      chat: async (request: ChatRequest): Promise<ChatResult> => {
        calls.push(request);
        if (reply === null) throw new Error("gateway down");
        return { text: reply, toolCalls: [], stopReason: "stop" };
      },
    },
  };
}

async function failedRun(repo: KernelRepository): Promise<{
  sessionId: string;
  runId: string;
  text: string;
}> {
  // A fresh DB starts paused (safe default); the observer is autonomous work.
  const control = repo.getAutonomyControlState();
  repo.setAutonomyControlState(
    { paused: false, expectedVersion: control.version },
    { key: randomUUID(), now: T0 },
  );
  const sessionId = repo.createSession({ key: randomUUID(), now: T0 }).body
    .sessionId as string;
  const text = "もっと短く答えて。あと敬語はなしで。";
  const posted = repo.postMessage(
    sessionId,
    { text },
    {
      key: randomUUID(),
      now: T0 + 1,
    },
  );
  const runId = (posted.body as { run: { id: string } }).run.id;
  repo.startRun(runId, { now: T0 + 2 });
  repo.failRun(runId, "execution_failed", { now: T0 + 3 });
  return { sessionId, runId, text };
}

describe("reflect observer", () => {
  const services: ReflectService[] = [];
  afterEach(async () => {
    while (services.length > 0) await (services.pop() as ReflectService).stop();
  });

  it("stages one grounded hypothesis and run evidence on a failed run", async () => {
    const handle = openKernelDatabase(":memory:");
    await migrateKernelDatabase({ db: handle.raw });
    try {
      const repo = createKernelRepository(handle.raw);
      const { sessionId, runId } = await failedRun(repo);
      const { gateway, calls } = fakeGateway(
        '{"statement":"keep answers short","quote":"もっと短く"}',
      );
      const service = createReflectService({
        repo,
        gateway,
        model: "test",
        now: () => T0 + 10,
      });
      services.push(service);
      service.start();
      service.onRunSettled(runId);
      await service.onIdle();
      const hypothesis = repo.listLearningHypotheses(sessionId, {
        limit: 10,
      }).items[0] as { id: string; statement: string; staged: boolean };
      expect(hypothesis.statement).toBe("keep answers short");
      expect(hypothesis.staged).toBe(true);
      const evidence = repo.listLearningHypothesisEvidence(
        sessionId,
        hypothesis.id,
      );
      expect(evidence.items).toHaveLength(1);
      expect(evidence.items[0]).toMatchObject({
        sourceKind: "run",
        sourceId: runId,
        polarity: "supports",
      });
      expect(calls).toHaveLength(1);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("drops an ungrounded quote without writing", async () => {
    const handle = openKernelDatabase(":memory:");
    await migrateKernelDatabase({ db: handle.raw });
    try {
      const repo = createKernelRepository(handle.raw);
      const { sessionId, runId } = await failedRun(repo);
      const { gateway } = fakeGateway(
        '{"statement":"keep answers short","quote":"存在しない引用"}',
      );
      const service = createReflectService({
        repo,
        gateway,
        model: "test",
        now: () => T0 + 10,
      });
      services.push(service);
      service.start();
      service.onRunSettled(runId);
      await service.onIdle();
      expect(
        repo.listLearningHypotheses(sessionId, { limit: 10 }).items,
      ).toHaveLength(0);
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("does nothing while learning is frozen or paused", async () => {
    const handle = openKernelDatabase(":memory:");
    await migrateKernelDatabase({ db: handle.raw });
    try {
      const repo = createKernelRepository(handle.raw);
      const { sessionId, runId } = await failedRun(repo);
      const control = repo.getAutonomyControlState();
      repo.setAutonomyControlState(
        {
          paused: false,
          learningFrozen: true,
          expectedVersion: control.version,
        },
        { key: randomUUID(), now: T0 + 4 },
      );
      expect(repo.getAutonomyControlState().learningFrozen).toBe(true);
      const { gateway, calls } = fakeGateway(
        '{"statement":"keep answers short","quote":"もっと短く"}',
      );
      const service = createReflectService({
        repo,
        gateway,
        model: "test",
        now: () => T0 + 10,
      });
      services.push(service);
      service.start();
      service.onRunSettled(runId);
      await service.onIdle();
      expect(calls).toHaveLength(0);
      expect(
        repo.listLearningHypotheses(sessionId, { limit: 10 }).items,
      ).toHaveLength(0);
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
