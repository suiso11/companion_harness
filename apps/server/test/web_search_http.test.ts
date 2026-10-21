// web.search server wiring regression: real HTTP server + stub SearXNG
// (local loopback HTTP, JSON) + synthetic gateway (honestly labeled, NOT a
// real model), following the memory_live_http integration patterns.
//
// What this proves:
// - DISABLED (env unset): the model-facing tool list NEVER advertises
//   `web.search` and the stub SearXNG is never contacted.
// - ENABLED with a stub SearXNG: a scripted fake-model turn calling
//   `web.search` materializes rN results and the final `answer.submit`
//   citing `r1` completes; the model tool list advertises `web.search`
//   exactly because the registration exists.
//
// Runnable: `pnpm --filter @companion/server exec vitest run
// test/web_search_http.test.ts`. Temp stores only; no user DB writes.

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ChatRequest,
  ChatResult,
  ModelGateway,
} from "@companion/model-local";
import { afterAll, describe, expect, it } from "vitest";
import { type StartedServer, startServer } from "../src/bootstrap.js";

const MODEL_NAME = "synthetic-web-gateway";
const MODEL_BASE = "http://127.0.0.1:9";

let searxPort = 0;
let searxHits = 0;
let searxServer: Server | null = null;

/** Minimal SearXNG stub: fixed JSON results for every request. */
async function startSearxStub(): Promise<void> {
  searxServer = createServer((_req, res) => {
    searxHits += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        results: [
          {
            url: "https://example.com/alpha",
            title: "Alpha page",
            content: "Alpha snippet with the answer.",
          },
          {
            url: "https://example.com/beta",
            title: "Beta page",
            content: "Beta snippet with the answer.",
          },
        ],
      }),
    );
  });
  const server = searxServer;
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  server.unref();
  searxPort = (server.address() as { port: number }).port;
}

afterAll(async () => {
  await new Promise<void>((resolve) => {
    if (searxServer === null) {
      resolve();
      return;
    }
    searxServer.close(() => resolve());
  });
});

interface GatewayScript {
  /** True: the first chat call emits a `web.search` tool call. */
  callWebSearchFirst: boolean;
}

function webGateway(
  script: GatewayScript,
  toolNamesSeen: string[],
): ModelGateway {
  // Stateful step counter: call 1 emits `web.search`, later calls emit
  // `answer.submit`. Message-content sniffing is unreliable because the
  // system prompt already lists `web.search` as a registered tool name.
  let chatCalls = 0;
  return {
    provider: "openai-compatible",
    capabilities: { toolCalling: true },
    baseUrl: MODEL_BASE,
    chatUrl: `${MODEL_BASE}/v1/chat/completions`,
    chat: async (request: ChatRequest): Promise<ChatResult> => {
      for (const tool of request.tools ?? []) {
        toolNamesSeen.push(tool.name);
      }
      chatCalls += 1;
      if (script.callWebSearchFirst && chatCalls === 1) {
        return {
          text: "",
          toolCalls: [
            {
              id: "ws-1",
              name: "web.search",
              arguments: { query: "where does the answer live", top_k: 2 },
            },
          ],
          stopReason: "tool_calls",
        };
      }
      return {
        text: "",
        toolCalls: [
          {
            id: "answer-1",
            name: "answer.submit",
            arguments: {
              version: 1,
              parts: [
                {
                  text: "The answer.",
                  // r1 exists only after a web.search materialized hits;
                  // citing it with no granted reference would loop the run
                  // on `citation_not_granted`.
                  citations: script.callWebSearchFirst ? ["r1"] : [],
                },
              ],
            },
          },
        ],
        stopReason: "tool_calls",
      };
    },
  };
}

function postJson(
  base: string,
  path: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: "127.0.0.1",
      origin: base,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

async function ensureUnpaused(base: string): Promise<void> {
  const controlRes = await fetch(`${base}/api/autonomy/control`, {
    headers: { host: "127.0.0.1" },
  });
  const control = (await controlRes.json()) as {
    paused: boolean;
    version: number;
  };
  if (control.paused === true) {
    const resumed = await postJson(
      base,
      "/api/autonomy/control",
      { paused: false, expectedVersion: control.version },
      { "idempotency-key": randomUUID() },
    );
    expect(resumed.status).toBe(200);
  }
}

async function waitForHistoryResult(
  base: string,
  sessionId: string,
  position: number,
  timeoutMs = 20_000,
): Promise<{ text: string; citations: string[] }> {
  const started = Date.now();
  for (;;) {
    const res = await fetch(
      `${base}/api/sessions/${sessionId}/history?limit=50`,
      { headers: { host: "127.0.0.1" } },
    );
    const body = (await res.json()) as {
      items: Array<{
        seq: number;
        selectedRun: {
          result: {
            version: number;
            text: string;
            answer?: { parts: Array<{ text: string; citations: string[] }> };
          } | null;
        } | null;
      }>;
    };
    const item = body.items.find((entry) => entry.seq === position);
    const result = item?.selectedRun?.result ?? null;
    if (result !== null && typeof result.text === "string") {
      const citations =
        result.version === 2
          ? (result.answer?.parts.flatMap((part) => part.citations) ?? [])
          : [];
      return { text: result.text, citations };
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error("timed out waiting for run result");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function cleanTemp(dir: string): void {
  rmSync(dir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}

/** Full scripted turn through the real HTTP server. */
async function runScriptedTurn(
  webEnv: NodeJS.ProcessEnv | undefined,
  script: GatewayScript,
): Promise<{
  started: StartedServer;
  root: string;
  text: string;
  citations: string[];
  toolNamesSeen: string[];
}> {
  const toolNamesSeen: string[] = [];
  const root = mkdtempSync(join(tmpdir(), "companion-web-"));
  const env: NodeJS.ProcessEnv = {
    COMPANION_DB_PATH: join(root, "companion.sqlite"),
    COMPANION_HOST: "127.0.0.1",
    COMPANION_PORT: "0",
    COMPANION_TIME_ZONE: "UTC",
    COMPANION_LOG_LEVEL: "debug",
    COMPANION_MODEL_JSON: JSON.stringify({
      adapter: "openai-compatible",
      baseUrl: MODEL_BASE,
      model: MODEL_NAME,
    }),
    ...webEnv,
  };
  const started = await startServer({
    env,
    drainMs: 200,
    modelGateway: webGateway(script, toolNamesSeen),
  });
  const base = `http://127.0.0.1:${started.port}`;
  try {
    await ensureUnpaused(base);
    const created = await postJson(
      base,
      "/api/sessions",
      {},
      { "idempotency-key": randomUUID() },
    );
    expect(created.status).toBe(201);
    const { sessionId } = (await created.json()) as { sessionId: string };
    const posted = await postJson(
      base,
      `/api/sessions/${sessionId}/messages`,
      { text: "search the web for the answer" },
      { "idempotency-key": randomUUID() },
    );
    expect(posted.status).toBe(202);
    const result = await waitForHistoryResult(base, sessionId, 1);
    return { started, root, ...result, toolNamesSeen };
  } catch (error) {
    await started.shutdown("test-failed").catch(() => undefined);
    cleanTemp(root);
    throw error;
  }
}

describe("web.search server wiring (stub SearXNG + synthetic gateway)", () => {
  it("disabled: tool absent from the model tool list; SearXNG never contacted", async () => {
    await startSearxStub();
    searxHits = 0;
    const { started, root, text, toolNamesSeen } = await runScriptedTurn(
      undefined,
      { callWebSearchFirst: false },
    );
    try {
      expect(text).toContain("The answer");
      expect(toolNamesSeen).not.toContain("web.search");
      expect(searxHits).toBe(0);
    } finally {
      await started.shutdown("test-teardown").catch(() => undefined);
      cleanTemp(root);
    }
  });

  it("enabled: web.search advertised; stub SearXNG returns 2 results; answer cites r1", async () => {
    await startSearxStub();
    searxHits = 0;
    const { started, root, text, citations, toolNamesSeen } =
      await runScriptedTurn(
        {
          COMPANION_WEB_SEARCH_JSON: JSON.stringify({
            enabled: true,
            searxng_base_url: `http://127.0.0.1:${searxPort}`,
            timeout_ms: 5000,
            per_turn_budget: 3,
          }),
        },
        { callWebSearchFirst: true },
      );
    try {
      expect(text).toContain("The answer");
      expect(citations).toEqual(["r1"]);
      expect(toolNamesSeen).toContain("web.search");
      expect(searxHits).toBe(1);
    } finally {
      await started.shutdown("test-teardown").catch(() => undefined);
      cleanTemp(root);
    }
  });
});
