// AV shadow-deliberation read envelope: HTTP consumer-boundary regression.
//
// Proves through the REAL Hono app + kernel repository + shadow service
// (in-memory DB, synthetic loopback gateway standing in for the model):
// - `GET .../shadow-jobs/:jobId/context` returns the deliberation
//   envelope `{ context, modelDecision }`: the frozen claim-time context
//   (original statement vs interpretation kept apart) PLUS the stored
//   MODEL decision, shown NEXT TO the CODE policy on the job detail
//   (`execute` + recorded permission CLAIM still completes
//   `missing_grant`: a CLAIM never becomes a grant);
// - the envelope is read-only (a second GET is byte-identical; no ack,
//   no status change, no mutation);
// - server-supplied text stays raw JSON (no server-side HTML mangling;
//   browser inertness is proven by the Chromium spec via `textContent`).

import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeKernelDatabase,
  createKernelRepository,
  migrateKernelDatabase,
  openKernelDatabase,
  RunEngine,
} from "@companion/kernel";
import type {
  ChatRequest,
  ChatResult,
  ModelGateway,
  NormalizedToolCall,
} from "@companion/model-local";
import { describe, expect, it } from "vitest";
import { type CreatedServerApp, createApp } from "../src/app.js";
import { loadServerConfig } from "../src/config.js";
import { createCollectingLogger } from "../src/logger.js";
import {
  createShadowService,
  SHADOW_DELIBERATION_TOOL,
  type ShadowService,
} from "../src/shadow_service.js";

const T0 = 1_700_004_000_000;
const MODEL = "test-model";

function deliberationCall(args: unknown): NormalizedToolCall {
  return {
    id: "shadow-call-1",
    name: SHADOW_DELIBERATION_TOOL,
    arguments: args,
  };
}

function chatResult(toolCalls: NormalizedToolCall[]): ChatResult {
  return { text: "", toolCalls, stopReason: "tool_calls" };
}

function makeGateway(
  handler: (request: ChatRequest) => Promise<ChatResult>,
): ModelGateway {
  return {
    provider: "openai-compatible",
    capabilities: { toolCalling: true },
    baseUrl: "http://127.0.0.1:1",
    chatUrl: "http://127.0.0.1:1/v1/chat/completions",
    async chat(request: ChatRequest, options?: { signal?: AbortSignal }) {
      if (options?.signal?.aborted === true) {
        throw new DOMException("aborted", "AbortError");
      }
      return handler(request);
    },
  } as unknown as ModelGateway;
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

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { "content-type": "application/json", host: "127.0.0.1", ...extra };
}

describe("shadow deliberation envelope", () => {
  it("exposes the frozen decision next to the CODE policy, read-only", async () => {
    const handle = openKernelDatabase(":memory:");
    await migrateKernelDatabase({ db: handle.raw });
    const repo = createKernelRepository(handle.raw);
    const config = loadServerConfig({
      COMPANION_DB_PATH: join(
        mkdtempSync(join(tmpdir(), "companion-shadow-delib-")),
        "db.sqlite",
      ),
      COMPANION_HOST: "127.0.0.1",
      COMPANION_PORT: "3000",
      COMPANION_TIME_ZONE: "UTC",
      COMPANION_LOG_LEVEL: "debug",
    });
    const { logger } = createCollectingLogger("debug");
    const engine = new RunEngine({ db: handle.raw, repo, cancelGraceMs: 30 });
    const created: CreatedServerApp = createApp({
      config,
      repo,
      engine,
      logger,
      shadowWake: () => {},
    });
    const gateway = makeGateway(async () =>
      chatResult([
        deliberationCall({
          decision: "execute",
          evidenceIds: ["sP1"],
          reason: "evening ping would help",
          proposedAction: { kind: "message", summary: "send an evening ping" },
          completion: "ping acknowledged",
          stopConditions: ["user opts out"],
          uncertainty: "medium",
          counterargument: "ping could annoy",
        }),
      ]),
    );
    const service = createShadowService({
      repo,
      gateway,
      model: MODEL,
      recall: null,
      now: () => Date.now(),
    });
    service.start();
    try {
      const post = async (path: string, body: unknown, key?: string) => {
        const response = await created.app.request(path, {
          method: "POST",
          headers: headers(key === undefined ? {} : { "idempotency-key": key }),
          body: JSON.stringify(body),
        });
        return { status: response.status, body: await response.json() };
      };
      const get = async (path: string) => {
        const response = await created.app.request(path, {
          method: "GET",
          headers: { host: "127.0.0.1" },
        });
        return { status: response.status, body: await response.json() };
      };
      const session = await post("/api/sessions", {}, randomUUID());
      expect(session.status).toBe(201);
      const sessionId = (session.body as { sessionId: string }).sessionId;
      repo.setAutonomyControlState(
        { paused: false, expectedVersion: 1 },
        { key: randomUUID(), now: T0 },
      );
      // Permission CLAIM with markup in the statement (server keeps it raw;
      // the browser proves inertness via textContent).
      const purpose = await post(
        `/api/sessions/${sessionId}/purposes`,
        {
          scope: "health",
          statement: "allow <b>evening</b> reminders",
          kind: "permission",
          explicit: true,
          sourceKind: "user",
          interpretation: "wants evening pings",
        },
        randomUUID(),
      );
      expect(purpose.status).toBe(201);
      const base = `/api/sessions/${sessionId}/shadow-jobs`;
      const made = await post(base, { scope: "health" }, randomUUID());
      expect(made.status).toBe(201);
      const jobId = (made.body as { id: string }).id;
      service.wake();
      await settle(service);
      const detail = await get(`${base}/${jobId}`);
      expect(detail.status).toBe(200);
      // CODE policy: execute + permission CLAIM stays missing_grant.
      expect((detail.body as { status: string }).status).toBe("completed");
      expect((detail.body as { policyCode: string }).policyCode).toBe(
        "missing_grant",
      );
      const first = await get(`${base}/${jobId}/context`);
      expect(first.status).toBe(200);
      const envelope = first.body as {
        context: {
          purposes: {
            label: string;
            statement: string;
            interpretation: string | null;
            explicitness: string;
            source: string;
          }[];
        };
        modelDecision: {
          decision: string;
          evidenceIds: string[];
          reason: string;
          proposedAction: { kind: string; summary: string } | null;
          completion: string;
          stopConditions: string[];
          uncertainty: string;
          counterargument: string;
        } | null;
      };
      // Frozen context: original vs interpretation kept apart, raw text.
      expect(envelope.context.purposes).toHaveLength(1);
      expect(envelope.context.purposes[0]?.label).toBe("sP1");
      expect(envelope.context.purposes[0]?.statement).toBe(
        "allow <b>evening</b> reminders",
      );
      expect(envelope.context.purposes[0]?.interpretation).toBe(
        "wants evening pings",
      );
      expect(envelope.context.purposes[0]?.explicitness).toBe("explicit");
      // Stored MODEL decision, separate from the CODE policy above.
      expect(envelope.modelDecision?.decision).toBe("execute");
      expect(envelope.modelDecision?.evidenceIds).toEqual(["sP1"]);
      expect(envelope.modelDecision?.reason).toBe("evening ping would help");
      expect(envelope.modelDecision?.proposedAction).toEqual({
        kind: "message",
        summary: "send an evening ping",
      });
      expect(envelope.modelDecision?.completion).toBe("ping acknowledged");
      expect(envelope.modelDecision?.stopConditions).toEqual(["user opts out"]);
      // Read-only: a second GET is identical and changes nothing.
      const second = await get(`${base}/${jobId}/context`);
      expect(second.status).toBe(200);
      expect(second.body).toEqual(first.body);
      const again = await get(`${base}/${jobId}`);
      expect(again.body).toEqual(detail.body);
    } finally {
      await service.stop();
      closeKernelDatabase(handle);
    }
  });
});
