// AV shadow-deliberation service + HTTP behavioral test (real SQLite +
// production repository/app, loopback-style in-process gateway fixtures).
//
// Proves through the REAL kernel repository + migrator + Hono app:
// SERVICE (apps/server/src/shadow_service.ts, same gateway/model as the
// ordinary agent):
// - one state event -> exactly ONE bounded native call -> model decision
//   stored SEPARATE from the CODE policy (execute + recorded permission
//   CLAIM still completes `missing_grant`: a CLAIM never becomes a grant);
// - wish/external evidence blocked (`wish_not_command` /
//   `external_no_authority`); genuine `do-nothing` completes `no_action`;
// - malformed native args (unknown grant field) / free-text-only /
//   multi-call responses are REJECTED (fixed failed codes, never a fake
//   completion); oversize input holds `context_too_large` with ZERO calls;
// - a constraint created DURING the call holds the late output
//   (`scope_epoch_drift`) and the drain picks up the LATEST pending job;
// - foreground preemption holds `aborted_foreground` (late provider output
//   can never commit) while an ordinary agent run on the SAME gateway
//   object still completes normally;
// - stop/resume epochs: paused-time work never revives (old explicit-key
//   replay returns the HELD job, zero new calls); no extra resource grants,
//   calendar actions, memory feedback, or ToolBroker use (zero action
//   executions / zero memory outbox rows; every gateway request carries
//   ONLY the one deliberation tool).
// HTTP (owned strict routes only):
// - POST explicit -> 201 + stable-key replay + drift 409; GET list/detail/
//   events/context are read-only (no ack side effect, no status change);
// - claim/complete/fail/lease-owner surfaces do NOT exist (404); foreign
//   sessions 404; draining replays FIRST then 503.
// The in-process gateway fixture is a synthetic loopback stand-in, NOT a
// real model (reported honestly in the smoke proof, not here).

import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeKernelDatabase,
  createAgentStrategy,
  createKernelRepository,
  createToolBroker,
  type KernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
  RunEngine,
  StrategyRegistry,
} from "@companion/kernel";
import type {
  ChatRequest,
  ChatResult,
  ModelGateway,
  NormalizedToolCall,
} from "@companion/model-local";
import { normalizeOpenAIResponse } from "@companion/model-local";
import { describe, expect, it } from "vitest";
import { type CreatedServerApp, createApp } from "../src/app.js";
import { AGENT_STRATEGY_NAME } from "../src/bootstrap.js";
import { loadServerConfig } from "../src/config.js";
import { createCollectingLogger } from "../src/logger.js";
import {
  createShadowService,
  SHADOW_DELIBERATION_TOOL,
  SHADOW_TOOL_DEFINITION,
  type ShadowService,
} from "../src/shadow_service.js";

const T0 = 1_700_002_000_000;
const MODEL = "test-model";

function deliberationCall(
  args: unknown,
  id = "shadow-call-1",
): NormalizedToolCall {
  return { id, name: SHADOW_DELIBERATION_TOOL, arguments: args };
}

function validOutput(
  evidenceIds: string[],
  extra: Record<string, unknown> = {},
) {
  return {
    decision: "do-nothing",
    evidenceIds,
    reason: "nothing to do yet",
    proposedAction: null,
    completion: "none required",
    stopConditions: ["any new constraint appears"],
    uncertainty: "low",
    counterargument: "waiting could miss a window",
    ...extra,
  };
}

function executeOutput(evidenceIds: string[]) {
  return validOutput(evidenceIds, {
    decision: "execute",
    proposedAction: { kind: "message", summary: "notify the user" },
  });
}

function chatResult(toolCalls: NormalizedToolCall[], text = ""): ChatResult {
  return {
    text,
    toolCalls,
    stopReason: toolCalls.length > 0 ? "tool_calls" : "stop",
  };
}

interface FixtureGateway {
  gateway: ModelGateway;
  calls: ChatRequest[];
  models: string[];
}

/**
 * Dual-mode loopback-style fixture: requests offering the deliberation
 * tool run the mutable shadow handler; requests offering `answer.submit`
 * answer as the ordinary agent. Records every request (tools + model) so
 * tests prove the one-tool surface and the shared model name.
 */
function makeGateway(
  shadowHandler: (request: ChatRequest) => Promise<ChatResult>,
): FixtureGateway & {
  setShadowHandler: (fn: (request: ChatRequest) => Promise<ChatResult>) => void;
} {
  const calls: ChatRequest[] = [];
  const models: string[] = [];
  let handler = shadowHandler;
  const gateway = {
    provider: "openai-compatible",
    capabilities: { toolCalling: true },
    baseUrl: "http://127.0.0.1:1",
    chatUrl: "http://127.0.0.1:1/v1/chat/completions",
    async chat(request: ChatRequest, options?: { signal?: AbortSignal }) {
      calls.push(request);
      models.push(request.model);
      const names = (request.tools ?? []).map((tool) => tool.name);
      if (names.includes("answer.submit")) {
        return chatResult([
          {
            id: "answer-1",
            name: "answer.submit",
            arguments: {
              version: 1,
              parts: [{ text: "ordinary answer continues", citations: [] }],
            },
          },
        ]);
      }
      const signal = options?.signal;
      if (signal?.aborted === true) {
        throw new DOMException("aborted", "AbortError");
      }
      return handler(request);
    },
  } as unknown as ModelGateway;
  return {
    gateway,
    calls,
    models,
    setShadowHandler: (fn: (request: ChatRequest) => Promise<ChatResult>) => {
      handler = fn;
    },
  };
}

async function makeRepo() {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  const repo = createKernelRepository(handle.raw);
  const session = repo.createSession({ key: randomUUID(), now: T0 });
  return { handle, repo, sessionId: session.body.sessionId as string };
}

function unpause(repo: KernelRepository, version: number, now: number) {
  return repo.setAutonomyControlState(
    { paused: false, expectedVersion: version },
    { key: randomUUID(), now },
  );
}

function pause(repo: KernelRepository, version: number, now: number) {
  return repo.setAutonomyControlState(
    { paused: true, expectedVersion: version },
    { key: randomUUID(), now },
  );
}

function goalBody(statement: string, extra: Record<string, unknown> = {}) {
  return {
    scope: "health",
    statement,
    kind: "goal",
    explicit: true,
    sourceKind: "user",
    ...extra,
  };
}

function makeService(
  repo: KernelRepository,
  gateway: ModelGateway | null,
  recall: {
    scope: string;
    recall: (
      query: string,
      signal: AbortSignal,
    ) => Promise<
      ReadonlyArray<{ recordId: string; recallId: string; snippet: string }>
    >;
  } | null = null,
): ShadowService {
  const service = createShadowService({
    repo,
    gateway,
    model: MODEL,
    recall,
    now: () => Date.now(),
  });
  service.start();
  return service;
}

async function settle(service: ShadowService, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (!service.busy) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (!service.busy) return;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error("shadow service did not settle");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function countRows(
  handle: ReturnType<typeof openKernelDatabase>,
  table: string,
): number {
  const row = handle.raw
    .prepare(`SELECT COUNT(*) AS n FROM ${table}`)
    .get() as { n: number };
  return row.n;
}

function readJobRow(
  handle: ReturnType<typeof openKernelDatabase>,
  jobId: string,
): {
  status: string;
  policy_code: string | null;
  model_decision_json: string | null;
  hold_reason: string | null;
  fail_code: string | null;
} {
  return handle.raw
    .prepare(
      "SELECT status, policy_code, model_decision_json, hold_reason, fail_code FROM shadow_jobs WHERE id = ?",
    )
    .get(jobId) as {
    status: string;
    policy_code: string | null;
    model_decision_json: string | null;
    hold_reason: string | null;
    fail_code: string | null;
  };
}

describe("shadow service (same gateway/model as the ordinary agent)", () => {
  it("completes one event with one call; execute + permission CLAIM stays missing_grant", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      unpause(repo, 1, T0 + 10);
      repo.createAutonomyPurpose(
        sessionId,
        goalBody("allow evening reminders", { kind: "permission" }),
        { key: randomUUID(), now: T0 + 20 },
      );
      const fixture = makeGateway(async () =>
        chatResult([deliberationCall(executeOutput(["sP1"]))]),
      );
      const service = makeService(repo, fixture.gateway);
      try {
        service.wake();
        await settle(service);
        expect(fixture.calls).toHaveLength(1);
        // One bounded native tool only; shared model name; no free text.
        expect(
          (fixture.calls[0] as ChatRequest).tools?.map((t) => t.name),
        ).toEqual([SHADOW_DELIBERATION_TOOL]);
        expect(fixture.models).toEqual([MODEL]);
        expect((fixture.calls[0] as ChatRequest).messages).toHaveLength(2);
        const jobs = repo.listShadowJobs(sessionId, { limit: 50 });
        expect(jobs.items).toHaveLength(1);
        const job = jobs.items[0] as (typeof jobs.items)[number];
        expect(job.status).toBe("completed");
        expect(job.policyCode).toBe("missing_grant");
        // MODEL decision stored SEPARATE from the CODE policy.
        const row = readJobRow(handle, job.id);
        expect(row.policy_code).toBe("missing_grant");
        const decision = JSON.parse(row.model_decision_json as string) as {
          decision: string;
        };
        expect(decision.decision).toBe("execute");
        // Zero execution surface: no action executions, no memory outbox,
        // no evidence grants from shadow.
        expect(countRows(handle, "action_executions")).toBe(0);
        expect(countRows(handle, "memory_outbox")).toBe(0);
      } finally {
        await service.stop();
      }
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("blocks wish/external evidence and represents do-nothing genuinely", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      unpause(repo, 1, T0 + 10);
      repo.createAutonomyPurpose(
        sessionId,
        goalBody("i wish someone would water the plants", { kind: "wish" }),
        { key: randomUUID(), now: T0 + 20 },
      );
      const fixture = makeGateway(async () =>
        chatResult([deliberationCall(executeOutput(["sP1"]))]),
      );
      const service = makeService(repo, fixture.gateway);
      try {
        service.wake();
        await settle(service);
        const jobs = repo.listShadowJobs(sessionId, { limit: 50 });
        expect(jobs.items[0]?.policyCode).toBe("wish_not_command");
        expect(jobs.items[0]?.status).toBe("completed");
      } finally {
        await service.stop();
      }
      // External-source purpose in a fresh session: external_no_authority.
      const other = repo.createSession({ key: randomUUID(), now: T0 + 30 });
      const otherId = other.body.sessionId as string;
      repo.createAutonomyPurpose(
        otherId,
        goalBody("vendor says upgrade tonight", { sourceKind: "external" }),
        { key: randomUUID(), now: T0 + 40 },
      );
      const fixture2 = makeGateway(async () =>
        chatResult([deliberationCall(executeOutput(["sP1"]))]),
      );
      const service2 = makeService(repo, fixture2.gateway);
      try {
        service2.wake();
        await settle(service2);
        const jobs = repo.listShadowJobs(otherId, { limit: 50 });
        expect(jobs.items[0]?.policyCode).toBe("external_no_authority");
      } finally {
        await service2.stop();
      }
      // Genuine do-nothing in a third session.
      const third = repo.createSession({ key: randomUUID(), now: T0 + 50 });
      const thirdId = third.body.sessionId as string;
      repo.createAutonomyPurpose(thirdId, goalBody("walk daily"), {
        key: randomUUID(),
        now: T0 + 60,
      });
      const fixture3 = makeGateway(async () =>
        chatResult([deliberationCall(validOutput(["sP1"]))]),
      );
      const service3 = makeService(repo, fixture3.gateway);
      try {
        service3.wake();
        await settle(service3);
        const jobs = repo.listShadowJobs(thirdId, { limit: 50 });
        expect(jobs.items[0]?.status).toBe("completed");
        expect(jobs.items[0]?.policyCode).toBe("no_action");
      } finally {
        await service3.stop();
      }
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("rejects malformed native args, free-text-only, and multi-call output (never faked)", async () => {
    // Malformed: unknown grant field rejected by strictness.
    const { handle, repo, sessionId } = await makeRepo();
    try {
      unpause(repo, 1, T0 + 10);
      repo.createAutonomyPurpose(sessionId, goalBody("walk daily"), {
        key: randomUUID(),
        now: T0 + 20,
      });
      const bad = {
        ...executeOutput(["sP1"]),
        grant: "calendar.write",
      };
      const fixture = makeGateway(async () =>
        chatResult([deliberationCall(bad)]),
      );
      const service = makeService(repo, fixture.gateway);
      try {
        service.wake();
        await settle(service);
        const jobs = repo.listShadowJobs(sessionId, { limit: 50 });
        expect(jobs.items[0]?.status).toBe("failed");
        expect(readJobRow(handle, jobs.items[0]?.id as string).fail_code).toBe(
          "model_error",
        );
      } finally {
        await service.stop();
      }
      // Free-text-only (zero native calls): gateway_empty, never parsed.
      const other = repo.createSession({ key: randomUUID(), now: T0 + 30 });
      const otherId = other.body.sessionId as string;
      repo.createAutonomyPurpose(otherId, goalBody("stretch hourly"), {
        key: randomUUID(),
        now: T0 + 40,
      });
      const fixture2 = makeGateway(async () =>
        chatResult([], 'do-nothing: {"decision": "do-nothing"}'),
      );
      const service2 = makeService(repo, fixture2.gateway);
      try {
        service2.wake();
        await settle(service2);
        const jobs = repo.listShadowJobs(otherId, { limit: 50 });
        expect(jobs.items[0]?.status).toBe("failed");
        expect(readJobRow(handle, jobs.items[0]?.id as string).fail_code).toBe(
          "gateway_empty",
        );
      } finally {
        await service2.stop();
      }
      // Multi-call batch: exactly one required.
      const third = repo.createSession({ key: randomUUID(), now: T0 + 50 });
      const thirdId = third.body.sessionId as string;
      repo.createAutonomyPurpose(thirdId, goalBody("drink water"), {
        key: randomUUID(),
        now: T0 + 60,
      });
      const fixture3 = makeGateway(async () =>
        chatResult([
          deliberationCall(validOutput(["sP1"]), "a"),
          deliberationCall(validOutput(["sP1"]), "b"),
        ]),
      );
      const service3 = makeService(repo, fixture3.gateway);
      try {
        service3.wake();
        await settle(service3);
        expect(
          repo.listShadowJobs(thirdId, { limit: 50 }).items[0]?.status,
        ).toBe("failed");
      } finally {
        await service3.stop();
      }
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("holds oversize input with zero gateway calls", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      unpause(repo, 1, T0 + 10);
      // Overflow the bounded frozen-context window (cap 100): 101 purposes.
      for (let index = 0; index < 101; index += 1) {
        repo.createAutonomyPurpose(sessionId, goalBody(`goal ${index}`), {
          key: randomUUID(),
          now: T0 + 20 + index,
        });
      }
      const fixture = makeGateway(async () =>
        chatResult([deliberationCall(validOutput(["sP1"]))]),
      );
      const service = makeService(repo, fixture.gateway);
      try {
        service.wake();
        await settle(service);
        expect(fixture.calls).toHaveLength(0);
        const jobs = repo.listShadowJobs(sessionId, { limit: 100 });
        const held = jobs.items.filter((job) => job.status === "held");
        expect(held.length).toBeGreaterThan(0);
        expect(
          held.every(
            (job) =>
              readJobRow(handle, job.id).hold_reason === "context_too_large",
          ),
        ).toBe(true);
      } finally {
        await service.stop();
      }
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("holds a late output on a mid-call constraint, then drains the latest pending job", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      unpause(repo, 1, T0 + 10);
      repo.createAutonomyPurpose(sessionId, goalBody("walk daily"), {
        key: randomUUID(),
        now: T0 + 20,
      });
      let releaseFirst!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let gated = false;
      const fixture = makeGateway(async (request) => {
        if (!gated) {
          gated = true;
          // New meaningful source WHILE the first call is in flight: a
          // second purpose bumps the scope epoch mid-call.
          repo.createAutonomyPurpose(sessionId, goalBody("no added sugar"), {
            key: randomUUID(),
            now: T0 + 30,
          });
          await gate;
          const userText =
            (request.messages[1] as { content: string }).content ?? "";
          const label = /-(sP\d+)/.exec(userText)?.[1] ?? "sP1";
          return chatResult([deliberationCall(executeOutput([label]))]);
        }
        return chatResult([deliberationCall(validOutput(["sP1"]))]);
      });
      const service = makeService(repo, fixture.gateway);
      try {
        service.wake();
        // Wait for the first call to land, then release it.
        const start = Date.now();
        while (fixture.calls.length < 1 && Date.now() - start < 5000) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        expect(fixture.calls).toHaveLength(1);
        releaseFirst();
        await settle(service);
        expect(fixture.calls).toHaveLength(2);
        const jobs = repo.listShadowJobs(sessionId, { limit: 50 });
        expect(jobs.items).toHaveLength(2);
        const byStatus = new Map(jobs.items.map((job) => [job.id, job.status]));
        void byStatus;
        const held = jobs.items.filter((job) => job.status === "held");
        const done = jobs.items.filter((job) => job.status === "completed");
        expect(held).toHaveLength(1);
        expect(done).toHaveLength(1);
        expect(readJobRow(handle, held[0]?.id as string).hold_reason).toBe(
          "scope_epoch_drift",
        );
        expect(done[0]?.policyCode).toBe("no_action");
      } finally {
        await service.stop();
      }
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("foreground preemption holds aborted_foreground; the ordinary run on the same gateway still completes", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      unpause(repo, 1, T0 + 10);
      repo.createAutonomyPurpose(sessionId, goalBody("walk daily"), {
        key: randomUUID(),
        now: T0 + 20,
      });
      // Ordinary agent on the SAME gateway object (dual-mode fixture).
      const broker = createToolBroker({
        db: handle.raw,
        repo,
        registrations: [],
      });
      const registry = new StrategyRegistry();
      const fixture = makeGateway(async () =>
        chatResult([deliberationCall(validOutput(["sP1"]))]),
      );
      registry.register(
        AGENT_STRATEGY_NAME,
        createAgentStrategy({
          db: handle.raw,
          repo,
          broker,
          gateway: fixture.gateway,
          model: MODEL,
        }),
      );
      const engine = new RunEngine({ db: handle.raw, repo, registry });
      engine.start();
      try {
        // Park the shadow call behind a gate, then preempt from foreground.
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        fixture.setShadowHandler(async () => {
          await gate;
          return chatResult([deliberationCall(validOutput(["sP1"]))]);
        });
        const service = makeService(repo, fixture.gateway);
        try {
          service.wake();
          const start = Date.now();
          while (fixture.calls.length < 1 && Date.now() - start < 5000) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          expect(fixture.calls).toHaveLength(1);
          // Accepted foreground work aborts the shadow's OWN call only.
          const posted = repo.postMessage(
            sessionId,
            { text: "hello foreground" },
            { key: randomUUID(), now: T0 + 30 },
          );
          expect(posted.status).toBe(202);
          service.notifyForeground();
          release();
          await settle(service);
          const jobs = repo.listShadowJobs(sessionId, { limit: 50 });
          expect(jobs.items[0]?.status).toBe("held");
          expect(
            readJobRow(handle, jobs.items[0]?.id as string).hold_reason,
          ).toBe("aborted_foreground");
          // The ordinary foreground run still completes on the same gateway.
          const runId = (posted.body as { run: { id: string } }).run.id;
          const settled = Date.now();
          let run = repo.getRun(runId);
          while (run.status !== "completed" && Date.now() - settled < 8000) {
            await new Promise((resolve) => setTimeout(resolve, 10));
            run = repo.getRun(runId);
          }
          expect(run.status).toBe("completed");
        } finally {
          await service.stop();
        }
      } finally {
        await engine.shutdown({ drainMs: 200 });
      }
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("freezes REAL memory evidence at claim; sR execute stays external_no_authority; unconfigured memory claims nothing", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      unpause(repo, 1, T0 + 10);
      repo.createAutonomyPurpose(sessionId, goalBody("walk daily"), {
        key: randomUUID(),
        now: T0 + 20,
      });
      const recall = {
        scope: "test-scope",
        recall: async () => [
          {
            recordId: "rec-1",
            recallId: "recall-1",
            snippet: "likes morning walks",
          },
        ],
      };
      const fixture = makeGateway(async (request) => {
        const userText = (request.messages[1] as { content: string }).content;
        const memory = /-(sR\d+)/.exec(userText)?.[1] ?? "sR1";
        return chatResult([deliberationCall(executeOutput([memory]))]);
      });
      const service = makeService(repo, fixture.gateway, recall);
      try {
        service.wake();
        await settle(service);
        const jobs = repo.listShadowJobs(sessionId, { limit: 50 });
        expect(jobs.items[0]?.status).toBe("completed");
        expect(jobs.items[0]?.policyCode).toBe("external_no_authority");
        // Memory frozen atomically at claim (server-constructed sR labels,
        // snippet-only provenance: no canonical record ids in context).
        const context = repo.getShadowJobContext(
          sessionId,
          jobs.items[0]?.id as string,
        );
        expect(context.memories).toHaveLength(1);
        expect(context.memories[0]?.label).toBe("sR1");
        expect(context.memories[0]?.snippet).toBe("likes morning walks");
        expect(JSON.stringify(context)).not.toContain("rec-1");
      } finally {
        await service.stop();
      }
      // Unconfigured memory: memories [] (honest "no available evidence").
      const other = repo.createSession({ key: randomUUID(), now: T0 + 30 });
      const otherId = other.body.sessionId as string;
      repo.createAutonomyPurpose(otherId, goalBody("stretch hourly"), {
        key: randomUUID(),
        now: T0 + 40,
      });
      const fixture2 = makeGateway(async () =>
        chatResult([deliberationCall(validOutput(["sP1"]))]),
      );
      const service2 = makeService(repo, fixture2.gateway, null);
      try {
        service2.wake();
        await settle(service2);
        const jobs = repo.listShadowJobs(otherId, { limit: 50 });
        const context = repo.getShadowJobContext(
          otherId,
          jobs.items[0]?.id as string,
        );
        expect(context.memories).toEqual([]);
      } finally {
        await service2.stop();
      }
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("stop/resume epochs never revive old work: old-key replay returns the HELD job with zero new calls", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      unpause(repo, 1, T0 + 10);
      const key = randomUUID();
      const first = repo.requestShadowDeliberation(
        sessionId,
        { scope: "health", reason: "check in" },
        { key, now: T0 + 20 },
      );
      expect(first.status).toBe(201);
      const control = repo.getAutonomyControlState();
      pause(repo, control.version, T0 + 30);
      // Paused stop holds the pending job in the same transaction.
      expect(repo.getShadowJob(sessionId, first.body.id).status).toBe("held");
      const resumed = repo.getAutonomyControlState();
      unpause(repo, resumed.version, T0 + 40);
      // Old-key replay reads REAL state: same HELD job, no revival.
      const replay = repo.requestShadowDeliberation(
        sessionId,
        { scope: "health", reason: "check in" },
        { key, now: T0 + 50 },
      );
      expect(replay.replayed).toBe(true);
      expect(replay.body.id).toBe(first.body.id);
      expect(replay.body.status).toBe("held");
      const fixture = makeGateway(async () =>
        chatResult([deliberationCall(validOutput(["sP1"]))]),
      );
      const service = makeService(repo, fixture.gateway);
      try {
        service.wake();
        await settle(service);
        expect(fixture.calls).toHaveLength(0);
      } finally {
        await service.stop();
      }
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("missing gateway fails honestly (gateway_empty, never a fake do-nothing)", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      unpause(repo, 1, T0 + 10);
      repo.createAutonomyPurpose(sessionId, goalBody("walk daily"), {
        key: randomUUID(),
        now: T0 + 20,
      });
      const service = makeService(repo, null);
      try {
        service.wake();
        await settle(service);
        const jobs = repo.listShadowJobs(sessionId, { limit: 50 });
        expect(jobs.items[0]?.status).toBe("failed");
        expect(readJobRow(handle, jobs.items[0]?.id as string).fail_code).toBe(
          "gateway_empty",
        );
      } finally {
        await service.stop();
      }
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("deliberation tool survives real provider normalization (two-dot names never ship)", async () => {
    // Production regression: the shared gateway name gate
    // (`namespace.verb`, single dot) once rejected the shadow tool, so every
    // real HTTP round trip failed `model_error` while the in-process
    // fixtures stayed green. The wire-format response must normalize.
    const wire = {
      id: "chatcmpl-probe",
      choices: [
        {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "shadow-1",
                type: "function",
                function: {
                  name: SHADOW_DELIBERATION_TOOL,
                  arguments: JSON.stringify(executeOutput(["sP1"])),
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    };
    const result = normalizeOpenAIResponse(wire, [SHADOW_TOOL_DEFINITION]);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.name).toBe(SHADOW_DELIBERATION_TOOL);
  });
});

async function makeHttpApp(): Promise<
  CreatedServerApp & { close: () => void; wakes: () => number }
> {
  const handle = openKernelDatabase(":memory:");
  await migrateKernelDatabase({ db: handle.raw });
  const repo = createKernelRepository(handle.raw);
  const config = loadServerConfig({
    COMPANION_DB_PATH: join(
      mkdtempSync(join(tmpdir(), "companion-shadow-http-")),
      "db.sqlite",
    ),
    COMPANION_HOST: "127.0.0.1",
    COMPANION_PORT: "3000",
    COMPANION_TIME_ZONE: "UTC",
    COMPANION_LOG_LEVEL: "debug",
  });
  const { logger } = createCollectingLogger("debug");
  const engine = new RunEngine({ db: handle.raw, repo, cancelGraceMs: 30 });
  let wakeCount = 0;
  const created = createApp({
    config,
    repo,
    engine,
    logger,
    shadowWake: () => {
      wakeCount += 1;
    },
  });
  return {
    ...created,
    close: () => closeKernelDatabase(handle),
    wakes: () => wakeCount,
  };
}

function httpHeaders(
  extra: Record<string, string> = {},
): Record<string, string> {
  return { "content-type": "application/json", host: "127.0.0.1", ...extra };
}

async function httpPost(
  app: CreatedServerApp["app"],
  path: string,
  body: unknown,
  key?: string,
): Promise<{ status: number; body: unknown }> {
  const response = await app.request(path, {
    method: "POST",
    headers: httpHeaders(key === undefined ? {} : { "idempotency-key": key }),
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function httpGet(
  app: CreatedServerApp["app"],
  path: string,
): Promise<{ status: number; body: unknown }> {
  const response = await app.request(path, {
    method: "GET",
    headers: { host: "127.0.0.1" },
  });
  return { status: response.status, body: await response.json() };
}

describe("shadow HTTP (owned strict routes only)", () => {
  it("posts explicit requests with replay + drift, reads without side effects, and hides runtime-only surfaces", async () => {
    const fixture = await makeHttpApp();
    try {
      const { app } = fixture;
      const created = await httpPost(app, "/api/sessions", {}, randomUUID());
      expect(created.status).toBe(201);
      const sessionId = (created.body as { sessionId: string }).sessionId;
      const other = await httpPost(app, "/api/sessions", {}, randomUUID());
      const otherId = (other.body as { sessionId: string }).sessionId;
      const base = `/api/sessions/${sessionId}/shadow-jobs`;

      // Paused control: explicit requests are honestly held, never queued.
      const key = randomUUID();
      const body = { scope: "health", reason: "check in" };
      const made = await httpPost(app, base, body, key);
      expect(made.status).toBe(201);
      const jobId = (made.body as { id: string }).id;
      expect((made.body as { status: string }).status).toBe("held");
      expect(fixture.wakes()).toBe(1);
      // Stable-key replay returns the identical body.
      const replay = await httpPost(app, base, body, key);
      expect(replay.status).toBe(201);
      expect(replay.body).toEqual(made.body);
      // Same key + different payload drifts to 409 (never rewritten).
      const drift = await httpPost(
        app,
        base,
        { scope: "health", reason: "different" },
        key,
      );
      expect(drift.status).toBe(409);
      expect((drift.body as { error: { code: string } }).error.code).toBe(
        "idempotency_key_reused",
      );
      // Read-only views: list/detail/events/context change nothing.
      const list = await httpGet(app, base);
      expect(list.status).toBe(200);
      expect(
        (list.body as { items: Array<{ id: string }> }).items.map((i) => i.id),
      ).toContain(jobId);
      const detail = await httpGet(app, `${base}/${jobId}`);
      expect(detail.status).toBe(200);
      expect((detail.body as { id: string }).id).toBe(jobId);
      const events = await httpGet(app, `${base}/${jobId}/events`);
      expect(events.status).toBe(200);
      expect(
        (events.body as { events: unknown[] }).events.length,
      ).toBeGreaterThan(0);
      const after = await httpGet(app, `${base}/${jobId}`);
      expect(after.body).toEqual(detail.body);
      // Trusted runtime-only surfaces do NOT exist over HTTP.
      for (const path of [
        `${base}/${jobId}/claim`,
        `${base}/${jobId}/complete`,
        `${base}/${jobId}/fail`,
      ]) {
        const missing = await httpPost(app, path, {}, randomUUID());
        expect(missing.status).toBe(404);
      }
      // Foreign sessions 404 (never 403), including idempotency scope.
      const foreign = await httpGet(
        app,
        `/api/sessions/${otherId}/shadow-jobs/${jobId}`,
      );
      expect(foreign.status).toBe(404);
    } finally {
      fixture.close();
    }
  });

  it("replays accepted keys first while draining, then 503s fresh writes", async () => {
    const fixture = await makeHttpApp();
    try {
      const { app, controls } = fixture;
      const created = await httpPost(app, "/api/sessions", {}, randomUUID());
      const sessionId = (created.body as { sessionId: string }).sessionId;
      const base = `/api/sessions/${sessionId}/shadow-jobs`;
      const key = randomUUID();
      const body = { scope: "health" };
      const made = await httpPost(app, base, body, key);
      expect(made.status).toBe(201);
      controls.markDraining();
      // Accepted key replays verbatim while draining.
      const replay = await httpPost(app, base, body, key);
      expect(replay.status).toBe(201);
      expect(replay.body).toEqual(made.body);
      // Fresh keys persist nothing and 503.
      const fresh = await httpPost(app, base, body, randomUUID());
      expect(fresh.status).toBe(503);
      // Reads stay available while draining.
      const list = await httpGet(app, base);
      expect(list.status).toBe(200);
    } finally {
      fixture.close();
    }
  });
});
