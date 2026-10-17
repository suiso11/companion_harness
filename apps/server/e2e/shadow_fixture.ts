// AV shadow-deliberation per-test fixture server (real production UI/server,
// throwaway file DB, synthetic gateway standing in for the model transport).
//
// Unlike e2e/server.ts (deterministic echo, NO shadow model), this harness
// boots the REAL Hono createApp + kernel DB + RunEngine + ShadowService with
// an injected synthetic ModelGateway that speaks the REAL native protocol:
// strict `autonomy_deliberation.submit` tool calls (same builders as the
// service HTTP tests) and native `answer.submit` for ordinary chat. It is a
// loopback stand-in for the model transport, NOT a real model; every DB,
// HTTP, UI, and fence behavior under test is the production path.
//
// One OS process serves ONE spec test (fresh temp DB per spawn). The gateway
// plan is driven per test over the loopback-only test channel:
//   POST /shadow-test/config { plan: [...], parkIndexes: [...] }
//   POST /shadow-test/release
//   GET  /shadow-test/stats
// plan entries: "donothing" | "ask" | "execute-xss". parkIndexes parks the
// Nth deliberation call (0-based) until /shadow-test/release (AbortSignal
// still aborts like a real provider socket closing).

import { mkdtempSync, rmSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeKernelDatabase,
  createAgentStrategy,
  createAutonomyReadRegistrations,
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
import { serve } from "@hono/node-server";
import { createApp } from "../src/app.js";
import { AGENT_STRATEGY_NAME, loadUiAssets } from "../src/bootstrap.js";
import { loadServerConfig } from "../src/config.js";
import { createStdServerLogger } from "../src/logger.js";
import {
  createShadowService,
  SHADOW_DELIBERATION_TOOL,
  type ShadowService,
} from "../src/shadow_service.js";

const MODEL = "shadow-e2e-synthetic";

type PlanStep = "donothing" | "ask" | "execute-xss";

let plan: PlanStep[] = ["donothing"];
let parkIndexes = new Set<number>();
let parkReleases: Array<() => void> = [];
const stats = {
  deliberationCalls: 0,
  ordinaryCalls: 0,
  advertisedTools: new Set<string>(),
  ordinaryToolCalls: [] as string[],
};

function deliberationCall(args: unknown, id: string): NormalizedToolCall {
  return { id, name: SHADOW_DELIBERATION_TOOL, arguments: args };
}

function chatResult(toolCalls: NormalizedToolCall[]): ChatResult {
  return { text: "", toolCalls, stopReason: "tool_calls" };
}

/** First frozen evidence label visible in the request (defaults to sP1). */
function firstLabel(request: ChatRequest, prefix: string): string {
  const text = JSON.stringify(request.messages ?? []);
  // Frozen context lines read "- sP1 [...]" (dash, space, label).
  const match = new RegExp(`s${prefix}[1-9]\\d*`).exec(text);
  return match?.[0] ?? `s${prefix}1`;
}

/** Every frozen purpose/task label in request order (bounded, deduped). */
function allLabels(request: ChatRequest): string[] {
  const text = JSON.stringify(request.messages ?? []);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/s[PTMFR][1-9]\d*/g)) {
    const label = match[0] ?? "";
    if (label !== "" && !seen.has(label)) {
      seen.add(label);
      out.push(label);
    }
    if (out.length >= 8) break;
  }
  return out.length > 0 ? out : ["sP1"];
}

function baseOutput(label: string) {
  return {
    decision: "do-nothing" as const,
    evidenceIds: [label],
    reason: "nothing to do yet",
    proposedAction: null,
    completion: "none required",
    stopConditions: ["any new constraint appears"],
    uncertainty: "low",
    counterargument: "waiting could miss a window",
  };
}

function askOutput(label: string) {
  return {
    ...baseOutput(label),
    decision: "ask" as const,
    reason: "needs one clarifying detail before any trial",
    completion: "answer received",
    uncertainty: "medium",
    counterargument: "proceeding without asking could misread intent",
  };
}

function executeXssOutput(labels: string[]) {
  return {
    ...baseOutput(labels[0] as string),
    decision: "execute" as const,
    evidenceIds: labels,
    // Untrusted model-controlled strings: the UI must render these as inert
    // text (never HTML, never script execution).
    reason:
      '<img src="x" onerror="alert(1)"> untrusted <script>alert(2)</script>',
    proposedAction: {
      kind: "message" as const,
      summary: '<b>ping</b> <img src="x" onerror="alert(3)">',
    },
    completion: "user notified",
    uncertainty: "high",
    counterargument: "notification may be unwanted",
  };
}

const gateway = {
  provider: "openai-compatible",
  capabilities: { toolCalling: true },
  baseUrl: "http://127.0.0.1:1",
  chatUrl: "http://127.0.0.1:1/v1/chat/completions",
  async chat(request: ChatRequest, options?: { signal?: AbortSignal }) {
    const names = (request.tools ?? []).map((tool) => tool.name);
    for (const name of names) stats.advertisedTools.add(name);
    if (names.includes("answer.submit")) {
      stats.ordinaryCalls += 1;
      const n = stats.ordinaryCalls;
      if (n === 1) {
        const calls: NormalizedToolCall[] = [
          { id: "ord-list-1", name: "purpose.list", arguments: { limit: 10 } },
          { id: "ord-list-2", name: "task.list", arguments: { limit: 10 } },
        ];
        for (const call of calls) stats.ordinaryToolCalls.push(call.name);
        return chatResult(calls);
      }
      if (n === 2) {
        const calls: NormalizedToolCall[] = [
          {
            id: "ord-list-3",
            name: "purpose.list",
            arguments: { scope: "health", limit: 10 },
          },
          {
            id: "ord-list-4",
            name: "task.list",
            arguments: { scope: "health", limit: 10 },
          },
        ];
        for (const call of calls) stats.ordinaryToolCalls.push(call.name);
        return chatResult(calls);
      }
      return chatResult([
        {
          id: "ord-answer-1",
          name: "answer.submit",
          arguments: {
            version: 1,
            parts: [{ text: "ordinary answer ok", citations: [] }],
          },
        },
      ]);
    }
    const index = stats.deliberationCalls;
    stats.deliberationCalls += 1;
    const signal = options?.signal;
    if (parkIndexes.has(index)) {
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted === true) {
          reject(new DOMException("aborted", "AbortError"));
          return;
        }
        const onAbort = (): void => {
          reject(new DOMException("aborted", "AbortError"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        parkReleases.push(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        });
      });
      if (signal?.aborted === true) {
        throw new DOMException("aborted", "AbortError");
      }
    } else if (signal?.aborted === true) {
      throw new DOMException("aborted", "AbortError");
    }
    const step = plan[Math.min(index, plan.length - 1)] ?? "donothing";
    if (step === "ask") {
      return chatResult([
        deliberationCall(
          askOutput(firstLabel(request, "P")),
          `shadow-${index}`,
        ),
      ]);
    }
    if (step === "execute-xss") {
      return chatResult([
        deliberationCall(
          executeXssOutput(allLabels(request)),
          `shadow-${index}`,
        ),
      ]);
    }
    return chatResult([
      deliberationCall(baseOutput(firstLabel(request, "P")), `shadow-${index}`),
    ]);
  },
} as unknown as ModelGateway;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", () => resolve(""));
  });
}

const dir = mkdtempSync(join(tmpdir(), "companion-shadow-e2e-"));
const dbPath = join(dir, "companion.sqlite");

const config = loadServerConfig({
  COMPANION_DB_PATH: dbPath,
  COMPANION_HOST: "127.0.0.1",
  COMPANION_PORT: "0",
  COMPANION_TIME_ZONE: "UTC",
  COMPANION_LOG_LEVEL: "error",
});
const logger = createStdServerLogger("error");

const handle = openKernelDatabase(dbPath);
await migrateKernelDatabase({ db: handle.raw });
const baseRepo = createKernelRepository(handle.raw);

const broker = createToolBroker({
  db: handle.raw,
  repo: baseRepo,
  registrations: [...createAutonomyReadRegistrations({ repo: baseRepo })],
});
const registry = new StrategyRegistry();
registry.register(
  AGENT_STRATEGY_NAME,
  createAgentStrategy({
    db: handle.raw,
    repo: baseRepo,
    broker,
    gateway,
    model: MODEL,
  }),
);
const engine = new RunEngine({
  db: handle.raw,
  repo: baseRepo,
  registry,
  cancelGraceMs: 3000,
});
engine.start();

const service: ShadowService = createShadowService({
  repo: baseRepo,
  gateway,
  model: MODEL,
  recall: null,
  now: () => Date.now(),
});
service.start();

// Server-owned priority composition (mirrors bootstrap): accepted
// foreground work aborts shadow's OWN call; run settlement re-wakes.
function after<TArgs extends unknown[], TReturn>(
  method: (...args: TArgs) => TReturn,
  hook: () => void,
): (...args: TArgs) => TReturn {
  return (...args: TArgs): TReturn => {
    const out = method(...args);
    try {
      hook();
    } catch {
      // Best effort: the committed call already succeeded.
    }
    return out;
  };
}

const repo: KernelRepository = {
  ...baseRepo,
  postMessage: after(baseRepo.postMessage.bind(baseRepo), () =>
    service.notifyForeground(),
  ),
  postRetry: after(baseRepo.postRetry.bind(baseRepo), () =>
    service.notifyForeground(),
  ),
  cancelRun: after(baseRepo.cancelRun.bind(baseRepo), () =>
    service.notifyForeground(),
  ),
  completeRun: after(baseRepo.completeRun.bind(baseRepo), () =>
    service.onRunSettled(),
  ),
  failRun: after(baseRepo.failRun.bind(baseRepo), () => service.onRunSettled()),
  finalizeCancelRequested: after(
    baseRepo.finalizeCancelRequested.bind(baseRepo),
    () => service.onRunSettled(),
  ),
};

const { app } = createApp({
  config,
  repo,
  engine,
  logger,
  assets: loadUiAssets(),
  shadowWake: () => {
    service.wake();
  },
  shadowControlChanged: () => {
    service.notifyControl();
  },
});

const appServer = serve(
  { fetch: app.fetch, port: 0, hostname: "127.0.0.1" },
  (info) => {
    // eslint-disable-next-line no-console
    console.log(`shadow-fixture-ready http://127.0.0.1:${info.port}`);
  },
);

const control = createServer(
  async (req: IncomingMessage, res: ServerResponse) => {
    res.on("error", () => {});
    req.on("error", () => {});
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const raw = await readBody(req);
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "POST" && url.pathname === "/shadow-test/config") {
      try {
        const body = (raw === "" ? {} : JSON.parse(raw)) as {
          plan?: unknown;
          parkIndexes?: unknown;
        };
        if (
          body.plan !== undefined &&
          (!Array.isArray(body.plan) ||
            body.plan.length === 0 ||
            body.plan.length > 8 ||
            body.plan.some(
              (step) =>
                step !== "donothing" &&
                step !== "ask" &&
                step !== "execute-xss",
            ))
        ) {
          throw new Error("invalid plan");
        }
        if (
          body.parkIndexes !== undefined &&
          (!Array.isArray(body.parkIndexes) ||
            body.parkIndexes.some(
              (index) => !Number.isSafeInteger(index) || index < 0 || index > 7,
            ))
        ) {
          throw new Error("invalid parkIndexes");
        }
        if (body.plan !== undefined) plan = body.plan as PlanStep[];
        parkIndexes =
          body.parkIndexes === undefined
            ? new Set<number>()
            : new Set(body.parkIndexes as number[]);
        json(200, { configured: true });
      } catch {
        json(400, { error: { code: "validation_error" } });
      }
      return;
    }
    if (req.method === "POST" && url.pathname === "/shadow-test/release") {
      const pending = parkReleases;
      parkReleases = [];
      for (const release of pending) {
        try {
          release();
        } catch {
          // Best effort.
        }
      }
      json(200, { released: pending.length });
      return;
    }
    if (req.method === "GET" && url.pathname === "/shadow-test/stats") {
      json(200, {
        deliberationCalls: stats.deliberationCalls,
        ordinaryCalls: stats.ordinaryCalls,
        advertisedTools: [...stats.advertisedTools].sort(),
        ordinaryToolCalls: [...stats.ordinaryToolCalls],
      });
      return;
    }
    json(404, { error: { code: "not_found", message: "resource not found" } });
  },
);

const controlPort = 0;
control.listen(controlPort, "127.0.0.1", () => {
  const address = control.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;
  // eslint-disable-next-line no-console
  console.log(`shadow-fixture-control http://127.0.0.1:${port}`);
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await new Promise<void>((resolve) => {
    control.close(() => resolve());
  });
  try {
    await engine.shutdown({ drainMs: 1000 });
  } catch {
    // Best effort.
  }
  try {
    await service.stop();
  } catch {
    // Best effort.
  }
  await new Promise<void>((resolve) => {
    appServer.close(() => resolve());
  });
  try {
    closeKernelDatabase(handle);
  } catch {
    // Best effort.
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
process.on("SIGINT", () => {
  void shutdown().then(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void shutdown().then(() => process.exit(0));
});
