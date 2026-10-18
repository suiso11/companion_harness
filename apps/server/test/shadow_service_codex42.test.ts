// Codex #42 follow-up (1/3): five shadow_service findings.
// Style follows apps/server/test/shadow_service_http.test.ts (real SQLite +
// production repository, in-process gateway fixtures).
import { randomUUID } from "node:crypto";
import type { ShadowJobContext } from "@companion/contracts";
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
  NormalizedToolCall,
} from "@companion/model-local";
import { describe, expect, it } from "vitest";
import { MEMORY_RECALL_QUERY_MAX_CP } from "../src/memory_service.js";
import {
  buildShadowUserPrompt,
  createShadowService,
  SHADOW_DELIBERATION_TOOL,
  type ShadowService,
} from "../src/shadow_service.js";

const T0 = 1_700_003_000_000;
const MODEL = "test-model";

function deliberationCall(
  args: unknown,
  id = "shadow-call-1",
): NormalizedToolCall {
  return { id, name: SHADOW_DELIBERATION_TOOL, arguments: args };
}

function validOutput(evidenceIds: string[]) {
  return {
    decision: "do-nothing",
    evidenceIds,
    reason: "nothing to do yet",
    proposedAction: null,
    completion: "none required",
    stopConditions: ["any new constraint appears"],
    uncertainty: "low",
    counterargument: "waiting could miss a window",
  };
}

function chatResult(toolCalls: NormalizedToolCall[], text = ""): ChatResult {
  return {
    text,
    toolCalls,
    stopReason: toolCalls.length > 0 ? "tool_calls" : "stop",
  };
}

function makeGateway(handler: (request: ChatRequest) => Promise<ChatResult>): {
  gateway: ModelGateway;
  calls: ChatRequest[];
} {
  const calls: ChatRequest[] = [];
  const gateway = {
    provider: "openai-compatible",
    capabilities: { toolCalling: true },
    baseUrl: "http://127.0.0.1:1",
    chatUrl: "http://127.0.0.1:1/v1/chat/completions",
    async chat(request: ChatRequest, options?: { signal?: AbortSignal }) {
      calls.push(request);
      const signal = options?.signal;
      if (signal?.aborted === true) {
        throw new DOMException("aborted", "AbortError");
      }
      return handler(request);
    },
  } as unknown as ModelGateway;
  return { gateway, calls };
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
  recall: ShadowService extends never
    ? never
    : {
        scope: string;
        recall: (
          query: string,
          signal: AbortSignal,
        ) => Promise<
          ReadonlyArray<{ recordId: string; recallId: string; snippet: string }>
        >;
      } | null = null,
  extra: { wallTimeoutMs?: number } = {},
): ShadowService {
  const service = createShadowService({
    repo,
    gateway,
    model: MODEL,
    recall,
    now: () => Date.now(),
    ...(extra.wallTimeoutMs !== undefined
      ? { wallTimeoutMs: extra.wallTimeoutMs }
      : {}),
  });
  service.start();
  return service;
}

async function settle(service: ShadowService, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (!service.busy) {
      await new Promise((resolve) => setTimeout(resolve, 15));
      if (!service.busy) return;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error("shadow service did not settle");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function readJobRow(
  handle: ReturnType<typeof openKernelDatabase>,
  jobId: string,
): { status: string; hold_reason: string | null; fail_code: string | null } {
  return handle.raw
    .prepare(
      "SELECT status, hold_reason, fail_code FROM shadow_jobs WHERE id = ?",
    )
    .get(jobId) as {
    status: string;
    hold_reason: string | null;
    fail_code: string | null;
  };
}

describe("codex #42 follow-up (1/3)", () => {
  it("drains past the per-wake batch: 6 pending jobs, one wake, 6 calls", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      unpause(repo, 1, T0 + 10);
      for (let index = 0; index < 6; index += 1) {
        repo.createAutonomyPurpose(sessionId, goalBody(`goal ${index}`), {
          key: randomUUID(),
          now: T0 + 20 + index,
        });
      }
      const fixture = makeGateway(async (request) => {
        const userText = (request.messages[1] as { content: string }).content;
        const label = /-(sP\d+)/.exec(userText)?.[1] ?? "sP1";
        return chatResult([deliberationCall(validOutput([label]))]);
      });
      const service = makeService(repo, fixture.gateway);
      try {
        service.wake();
        const start = Date.now();
        while (fixture.calls.length < 6 && Date.now() - start < 8000) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        await settle(service);
        expect(fixture.calls).toHaveLength(6);
        const jobs = repo.listShadowJobs(sessionId, { limit: 50 });
        expect(jobs.items).toHaveLength(6);
        expect(jobs.items.every((job) => job.status === "completed")).toBe(
          true,
        );
      } finally {
        await service.stop();
      }
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("maps conflict pairs to frozen sP labels (unknown stays withheld)", async () => {
    const idA = randomUUID();
    const idB = randomUUID();
    const idC = randomUUID();
    const base = {
      sessionId: randomUUID(),
      scope: "health",
      tasks: [],
      activeConstraintIds: [],
      permissionClaims: [],
      explicitDeadlines: [],
      priorFailures: [],
      memories: [],
      claimControlVersion: 2,
      claimScopeEpoch: 1,
      capturedAt: T0,
    } as const;
    const purposes = [idA, idB, idC].map((id, index) => ({
      label: `sP${index + 1}`,
      id,
      version: 1,
      status: "active",
      kind: "goal",
      explicitness: "explicit",
      source: "user",
      scope: "health",
      statement: `goal ${index}`,
      interpretation: null,
      validFrom: null,
      validUntil: null,
      supersededBy: null,
      applicableAtClaim: true,
    }));
    const context = {
      ...base,
      purposes,
      conflictPairs: [
        [idA, idB],
        [idB, idC],
      ],
    } as unknown as ShadowJobContext;
    const prompt = buildShadowUserPrompt({
      context,
      triggerEvent: "purpose.created",
      kind: "policy_change",
      memoryConfigured: false,
    });
    expect(prompt).toContain("sP1 vs sP2");
    expect(prompt).toContain("sP2 vs sP3");
    const unknown = {
      ...base,
      purposes,
      conflictPairs: [[randomUUID(), randomUUID()]],
    } as unknown as ShadowJobContext;
    expect(
      buildShadowUserPrompt({
        context: unknown,
        triggerEvent: "purpose.created",
        kind: "policy_change",
        memoryConfigured: false,
      }),
    ).toContain("(withheld-pair)");
  });

  it("holds a recall-aborted job terminally: no calls, no replay on settle", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      unpause(repo, 1, T0 + 10);
      repo.createAutonomyPurpose(sessionId, goalBody("walk daily"), {
        key: randomUUID(),
        now: T0 + 20,
      });
      const fixture = makeGateway(async () =>
        chatResult([deliberationCall(validOutput(["sP1"]))]),
      );
      const recall = {
        scope: "test-scope",
        recall: (_query: string, signal: AbortSignal) =>
          new Promise<
            ReadonlyArray<{
              recordId: string;
              recallId: string;
              snippet: string;
            }>
          >((_resolve, reject) => {
            if (signal.aborted) {
              reject(new DOMException("aborted", "AbortError"));
              return;
            }
            signal.addEventListener(
              "abort",
              () => reject(new DOMException("aborted", "AbortError")),
              { once: true },
            );
          }),
      };
      const service = makeService(repo, fixture.gateway, recall);
      try {
        service.wake();
        const start = Date.now();
        while (!service.busy && Date.now() - start < 5000) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        service.notifyForeground();
        await settle(service);
        expect(fixture.calls).toHaveLength(0);
        const jobs = repo.listShadowJobs(sessionId, { limit: 50 });
        expect(jobs.items).toHaveLength(1);
        expect(jobs.items[0]?.status).toBe("held");
        expect(
          readJobRow(handle, jobs.items[0]?.id as string).hold_reason,
        ).toBe("aborted_foreground");
        service.onRunSettled();
        await settle(service);
        expect(fixture.calls).toHaveLength(0);
        expect(
          repo.getShadowJob(sessionId, jobs.items[0]?.id as string).status,
        ).toBe("held");
      } finally {
        await service.stop();
      }
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("lands a wall timeout as model_error failure, not a foreground hold", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      unpause(repo, 1, T0 + 10);
      repo.createAutonomyPurpose(sessionId, goalBody("walk daily"), {
        key: randomUUID(),
        now: T0 + 20,
      });
      const calls: ChatRequest[] = [];
      const gateway = {
        provider: "openai-compatible",
        capabilities: { toolCalling: true },
        baseUrl: "http://127.0.0.1:1",
        chatUrl: "http://127.0.0.1:1/v1/chat/completions",
        async chat(request: ChatRequest, options?: { signal?: AbortSignal }) {
          calls.push(request);
          const signal = options?.signal;
          // Slow provider: resolves well past the 50ms test wall.
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 500);
            signal?.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(new DOMException("aborted", "AbortError"));
              },
              { once: true },
            );
          });
          return chatResult([deliberationCall(validOutput(["sP1"]))]);
        },
      } as unknown as ModelGateway;
      const service = makeService(repo, gateway, null, { wallTimeoutMs: 50 });
      try {
        service.wake();
        await settle(service);
        expect(calls).toHaveLength(1);
        const jobs = repo.listShadowJobs(sessionId, { limit: 50 });
        expect(jobs.items[0]?.status).toBe("failed");
        expect(readJobRow(handle, jobs.items[0]?.id as string).fail_code).toBe(
          "model_error",
        );
      } finally {
        await service.stop();
      }
    } finally {
      closeKernelDatabase(handle);
    }
  });

  it("builds distinct bounded recall queries per scope", async () => {
    const { handle, repo, sessionId } = await makeRepo();
    try {
      unpause(repo, 1, T0 + 10);
      repo.createAutonomyPurpose(
        sessionId,
        { ...goalBody("morning run routine"), scope: "health" },
        { key: randomUUID(), now: T0 + 20 },
      );
      repo.createAutonomyPurpose(
        sessionId,
        { ...goalBody("quarterly report deadline"), scope: "work" },
        { key: randomUUID(), now: T0 + 30 },
      );
      const queries: string[] = [];
      const recall = {
        scope: "test-scope",
        recall: async (query: string) => {
          queries.push(query);
          return [];
        },
      };
      const fixture = makeGateway(async (request) => {
        const userText = (request.messages[1] as { content: string }).content;
        const label = /-(sP\d+)/.exec(userText)?.[1] ?? "sP1";
        return chatResult([deliberationCall(validOutput([label]))]);
      });
      const service = makeService(repo, fixture.gateway, recall);
      try {
        service.wake();
        await settle(service);
        expect(queries.length).toBeGreaterThanOrEqual(2);
        const unique = new Set(queries);
        expect(unique.size).toBeGreaterThanOrEqual(2);
        for (const query of queries) {
          expect(Array.from(query).length).toBeLessThanOrEqual(
            MEMORY_RECALL_QUERY_MAX_CP,
          );
        }
        expect(queries.some((query) => query.includes("health"))).toBe(true);
        expect(queries.some((query) => query.includes("work"))).toBe(true);
      } finally {
        await service.stop();
      }
    } finally {
      closeKernelDatabase(handle);
    }
  });
});
