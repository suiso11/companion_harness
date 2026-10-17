// AV shadow-deliberation LIVE safety proof: real HTTP loopback + throwaway
// file DB + real app wiring (no in-process request harness).
//
// Proves over an ACTUAL listening loopback socket with the production
// `createApp` control wiring (`shadowControlChanged` -> worker
// `notifyControl`, exactly as bootstrap wires it):
// - PURE control STOP (no foreground message/retry/cancel anywhere first):
//   the parked native gateway call observes the abort promptly, the worker
//   settles, and the job is HELD `control_paused` with NO result committed
//   (never mislabeled `aborted_foreground`, never a fake decision);
// - SEMANTIC defect over the real native call (syntactically valid tool
//   call with unknown label sP999): the job lands terminal `failed` with
//   `model_error` and a cleared lease BEFORE any next claim, and a later
//   GOOD job on a new request completes normally.
// The gateway fixture is a loopback stand-in for the model transport (the
// native `autonomy_deliberation.submit` protocol path is real: strict tool
// shape, AbortSignal, kernel fences); it is NOT a real model.

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
import { serve } from "@hono/node-server";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadServerConfig } from "../src/config.js";
import { createCollectingLogger } from "../src/logger.js";
import {
  createShadowService,
  SHADOW_DELIBERATION_TOOL,
  type ShadowService,
} from "../src/shadow_service.js";

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

function goodOutput(label: string) {
  return {
    decision: "do-nothing",
    evidenceIds: [label],
    reason: "nothing to do yet",
    proposedAction: null,
    completion: "none required",
    stopConditions: ["any new constraint appears"],
    uncertainty: "low",
    counterargument: "waiting could miss a window",
  };
}

function badOutput() {
  return {
    decision: "execute",
    evidenceIds: ["sP999"],
    reason: "cites a label outside the frozen context",
    proposedAction: { kind: "message", summary: "phantom ping" },
    completion: "phantom acknowledged",
    stopConditions: ["user opts out"],
    uncertainty: "high",
    counterargument: "the label does not exist",
  };
}

async function settle(service: ShadowService, timeoutMs = 8000): Promise<void> {
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

describe("shadow live safety proof (real HTTP loopback, throwaway DB)", () => {
  it("pure STOP aborts the parked call; semantic defects fail terminally; good work completes after", async () => {
    const dir = mkdtempSync(join(tmpdir(), "companion-shadow-live-"));
    const dbPath = join(dir, "live.sqlite");
    const handle = openKernelDatabase(dbPath);
    await migrateKernelDatabase({ db: handle.raw });
    const repo = createKernelRepository(handle.raw);
    const config = loadServerConfig({
      COMPANION_DB_PATH: join(dir, "config-unused.sqlite"),
      COMPANION_HOST: "127.0.0.1",
      COMPANION_PORT: "0",
      COMPANION_TIME_ZONE: "UTC",
      COMPANION_LOG_LEVEL: "debug",
    });
    const { logger } = createCollectingLogger("debug");

    // Parked loopback gateway: observes the AbortSignal like a real
    // provider socket closing (rejects on abort, never resolves late).
    let observedAbort = false;
    let releaseParked!: () => void;
    const parkedGate = new Promise<void>((resolve) => {
      releaseParked = resolve;
    });
    let nativeCalls = 0;
    let defectArmed = false;
    const gateway = {
      provider: "openai-compatible",
      capabilities: { toolCalling: true },
      baseUrl: "http://127.0.0.1:1",
      chatUrl: "http://127.0.0.1:1/v1/chat/completions",
      async chat(request: ChatRequest, options?: { signal?: AbortSignal }) {
        nativeCalls += 1;
        const signal = options?.signal;
        if (signal?.aborted === true) {
          observedAbort = true;
          throw new DOMException("aborted", "AbortError");
        }
        if (defectArmed) {
          return chatResult([deliberationCall(badOutput())]);
        }
        await new Promise<void>((resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              observedAbort = true;
              reject(new DOMException("aborted", "AbortError"));
            },
            { once: true },
          );
          void parkedGate.then(() => resolve());
        });
        const userText =
          (request.messages[1] as { content: string }).content ?? "";
        const label = /-(sP\d+)/.exec(userText)?.[1] ?? "sP1";
        return chatResult([deliberationCall(goodOutput(label))]);
      },
    } as unknown as ModelGateway;

    const service = createShadowService({
      repo,
      gateway,
      model: MODEL,
      recall: null,
      now: () => Date.now(),
    });
    service.start();
    const engine = new RunEngine({ db: handle.raw, repo, cancelGraceMs: 30 });
    const created = createApp({
      config,
      repo,
      engine,
      logger,
      shadowWake: () => {
        service.wake();
      },
      shadowControlChanged: () => {
        service.notifyControl();
      },
    });
    const listener = await new Promise<{
      port: number;
      close: (cb: () => void) => void;
    }>((resolve) => {
      const server = serve(
        { fetch: created.app.fetch, port: 0, hostname: "127.0.0.1" },
        (info) => {
          resolve({
            port: info.port,
            close: (cb: () => void) => {
              (server as unknown as { close: (cb: () => void) => void }).close(
                cb,
              );
            },
          });
        },
      );
    });
    const base = `http://127.0.0.1:${String(listener.port)}`;
    try {
      const post = async (path: string, body: unknown) => {
        const response = await fetch(`${base}${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            // Same-origin Origin: Node 24 fetch sends sec-fetch-mode, so a
            // missing Origin is treated as browser-like and rejected (§16.7).
            origin: base,
            "idempotency-key": randomUUID(),
          },
          body: JSON.stringify(body),
        });
        return { status: response.status, body: await response.json() };
      };
      const get = async (path: string) => {
        const response = await fetch(`${base}${path}`, { method: "GET" });
        return { status: response.status, body: await response.json() };
      };

      const session = await post("/api/sessions", {});
      expect(session.status).toBe(201);
      const sessionId = (session.body as { sessionId: string }).sessionId;

      const control = await get("/api/autonomy/control");
      expect(control.status).toBe(200);
      const unpause = await post("/api/autonomy/control", {
        paused: false,
        expectedVersion: (control.body as { version: number }).version,
      });
      expect(unpause.status).toBe(200);
      expect((unpause.body as { paused: boolean }).paused).toBe(false);

      const purpose = await post(`/api/sessions/${sessionId}/purposes`, {
        scope: "health",
        statement: "walk daily",
        kind: "goal",
        explicit: true,
        sourceKind: "user",
      });
      expect(purpose.status).toBe(201);

      const made = await post(`/api/sessions/${sessionId}/shadow-jobs`, {
        scope: "health",
      });
      expect(made.status).toBe(201);
      const jobId = (made.body as { id: string }).id;
      // The explicit request already woke the worker via HTTP wiring; wait
      // for the native call to park in flight.
      const parkedAt = Date.now();
      while (nativeCalls < 1 && Date.now() - parkedAt < 8000) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(nativeCalls).toBe(1);

      // PURE STOP over real HTTP: no foreground message/retry/cancel first.
      const pausedControl = await get("/api/autonomy/control");
      const stopped = await post("/api/autonomy/control", {
        paused: true,
        expectedVersion: (pausedControl.body as { version: number }).version,
      });
      expect(stopped.status).toBe(200);
      expect((stopped.body as { paused: boolean }).paused).toBe(true);
      const abortAt = Date.now();
      while (!observedAbort && Date.now() - abortAt < 8000) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(observedAbort).toBe(true);
      releaseParked();
      await settle(service);
      expect(service.busy).toBe(false);
      const detail = await get(
        `/api/sessions/${sessionId}/shadow-jobs/${jobId}`,
      );
      expect(detail.status).toBe(200);
      expect((detail.body as { status: string }).status).toBe("held");
      // Truthful stop attribution: control_paused, never foreground.
      expect((detail.body as { holdReason: string }).holdReason).toBe(
        "control_paused",
      );
      expect((detail.body as { policyCode: unknown }).policyCode).toBeNull();
      expect((detail.body as { leaseOwner: unknown }).leaseOwner).toBeNull();

      // SEMANTIC defect over the real native call on a resumed control.
      const resumedControl = await get("/api/autonomy/control");
      const resumed = await post("/api/autonomy/control", {
        paused: false,
        expectedVersion: (resumedControl.body as { version: number }).version,
      });
      expect(resumed.status).toBe(200);
      defectArmed = true;
      const bad = await post(`/api/sessions/${sessionId}/shadow-jobs`, {
        scope: "health",
      });
      expect(bad.status).toBe(201);
      const badId = (bad.body as { id: string }).id;
      await settle(service);
      const badDetail = await get(
        `/api/sessions/${sessionId}/shadow-jobs/${badId}`,
      );
      expect((badDetail.body as { status: string }).status).toBe("failed");
      expect((badDetail.body as { failCode: string }).failCode).toBe(
        "model_error",
      );
      expect((badDetail.body as { leaseOwner: unknown }).leaseOwner).toBeNull();

      // A later GOOD job on a new request processes normally: no stranded
      // lease, at most one live lease ever.
      defectArmed = false;
      const good = await post(`/api/sessions/${sessionId}/shadow-jobs`, {
        scope: "health",
      });
      expect(good.status).toBe(201);
      const goodId = (good.body as { id: string }).id;
      await settle(service);
      const goodDetail = await get(
        `/api/sessions/${sessionId}/shadow-jobs/${goodId}`,
      );
      expect((goodDetail.body as { status: string }).status).toBe("completed");
      expect(
        (goodDetail.body as { leaseOwner: unknown }).leaseOwner,
      ).toBeNull();
    } finally {
      await service.stop();
      await new Promise<void>((resolve) => {
        listener.close(() => resolve());
      });
      closeKernelDatabase(handle);
    }
  });
});
