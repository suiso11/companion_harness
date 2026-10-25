// AGORA real-browser E2E harness: the server process.
//
// Boots THREE real production servers through `startServer` (no production
// rule change, no API mocks, no public network):
//   App A (AGORA_APP_PORT): COMPANION_AGORA_JSON + a temp private AGORA
//     store + an injected local `AgoraTransport` that records every write
//     attempt and returns one verified fixed-host thread target.
//   App B (AGORA_AMBIGUOUS_APP_PORT): the same real composition, but the
//     injected transport throws on the single write, so the production
//     store records a terminal `unknown` outcome (never auto-retried).
//   App C (AGORA_DISABLED_APP_PORT): no COMPANION_AGORA_JSON, so every
//     `/agora/*` review route is the production fixed 404 and the panel
//     hides itself.
//
// The synthetic `ModelGateway` is the ONLY model substitute: it emits the
// real `agora.propose_thread` tool call followed by `answer.submit`. The
// real agent strategy, real ToolBroker, real AGORA store, real Hono routes,
// real RunEngine and real UI all run unmodified. Proposal creation therefore
// happens inside the actual conversation run and session ownership — never
// via a browser route mock or a direct store seed.
//
// A loopback-only control server exposes transport observations
// (`GET /status`, `POST /reset`) to the Node-side Playwright request fixture;
// the page never fetches it. Temp dirs are removed on shutdown.

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgoraTransport } from "@companion/kernel";
import type {
  ChatRequest,
  ChatResult,
  ModelGateway,
} from "@companion/model-local";
import { type StartedServer, startServer } from "../../src/index.js";
import {
  AGORA_AMBIGUOUS_APP_PORT,
  AGORA_AMBIGUOUS_BODY,
  AGORA_AMBIGUOUS_TITLE,
  AGORA_APP_PORT,
  AGORA_BODY,
  AGORA_CONTROL_ORIGIN,
  AGORA_CONTROL_PORT,
  AGORA_DISABLED_APP_PORT,
  AGORA_REJECT_BODY,
  AGORA_REJECT_TITLE,
  AGORA_RESULT_THREAD_ID,
  AGORA_RESULT_URL,
  AGORA_TEXT_AMBIGUOUS,
  AGORA_TEXT_PROPOSE,
  AGORA_TEXT_REJECT,
  AGORA_TITLE,
} from "./ports.js";

const MODEL_NAME = "synthetic-agora-e2e-gateway";
const MODEL_BASE = "http://127.0.0.1:9";
const AGORA_KEY = "e2e-agora-local-key-never-public";

interface TransportObservation {
  attempts: number;
  posts: Array<{
    path: string;
    body: unknown;
    hasAgentKey: boolean;
  }>;
}

function clearObservation(observation: TransportObservation): void {
  observation.attempts = 0;
  observation.posts.length = 0;
}

const observations = {
  success: { attempts: 0, posts: [] },
  ambiguous: { attempts: 0, posts: [] },
  disabled: { attempts: 0, posts: [] },
} satisfies Record<string, TransportObservation>;

function fakeTransport(
  observation: TransportObservation,
  mode: "success" | "ambiguous",
): AgoraTransport {
  return {
    async get() {
      return {
        status: 200,
        contentType: "application/json",
        text: JSON.stringify({ name: "agora", hello: "local-e2e" }),
      };
    },
    async post(path, body, headers) {
      observation.attempts += 1;
      if (mode === "ambiguous") {
        // Real transport-failure boundary: the store must persist a terminal
        // `unknown`, never retry, and the browser must not offer Send again.
        throw new Error("e2e ambiguous transport outcome");
      }
      observation.posts.push({
        path,
        body,
        hasAgentKey: typeof headers["x-agent-key"] === "string",
      });
      return {
        status: 201,
        text: JSON.stringify({
          threadId: AGORA_RESULT_THREAD_ID,
          url: AGORA_RESULT_URL,
        }),
      };
    },
  };
}

function proposalFor(text: string): {
  title: string;
  body: string;
} {
  if (text.includes(AGORA_TEXT_AMBIGUOUS)) {
    return { title: AGORA_AMBIGUOUS_TITLE, body: AGORA_AMBIGUOUS_BODY };
  }
  if (text.includes(AGORA_TEXT_REJECT)) {
    return { title: AGORA_REJECT_TITLE, body: AGORA_REJECT_BODY };
  }
  if (text.includes(AGORA_TEXT_PROPOSE)) {
    return { title: AGORA_TITLE, body: AGORA_BODY };
  }
  return { title: AGORA_TITLE, body: AGORA_BODY };
}

function lastUserText(request: ChatRequest): string {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const message = request.messages[index];
    if (message?.role === "user") {
      return message.content;
    }
  }
  return "";
}

function foundTool(
  messages: ChatRequest["messages"],
  tool: string,
): Record<string, unknown> | null {
  for (const message of messages) {
    if (message.role !== "tool") continue;
    try {
      const parsed = JSON.parse(message.content) as {
        tool?: unknown;
        ok?: unknown;
        output?: unknown;
      };
      if (
        parsed.tool === tool &&
        parsed.ok === true &&
        typeof parsed.output === "object" &&
        parsed.output !== null
      ) {
        return parsed.output as Record<string, unknown>;
      }
    } catch {
      // Unrelated feedback is ignored.
    }
  }
  return null;
}

function answer(text: string): ChatResult {
  return {
    text: "",
    toolCalls: [
      {
        id: `answer-${randomUUID()}`,
        name: "answer.submit",
        arguments: { version: 1, parts: [{ text, citations: [] }] },
      },
    ],
    stopReason: "tool_calls",
  };
}

const modelGateway: ModelGateway = {
  provider: "ollama",
  capabilities: { toolCalling: true },
  baseUrl: MODEL_BASE,
  chatUrl: `${MODEL_BASE}/api/chat`,
  async chat(request: ChatRequest): Promise<ChatResult> {
    const last = request.messages.at(-1);
    if (last?.role === "tool") {
      const proposed = foundTool(request.messages, "agora.propose_thread");
      if (proposed !== null) {
        const proposal = proposed.proposal as
          | Record<string, unknown>
          | undefined;
        return answer(
          `AGORA proposal staged ${String(proposal?.proposalId ?? "")} ` +
            `hash ${String(proposal?.payloadHash ?? "")}. Nothing was sent.`,
        );
      }
      return answer("No AGORA tool output.");
    }
    const { title, body } = proposalFor(lastUserText(request));
    return {
      text: "",
      toolCalls: [
        {
          id: `propose-${randomUUID()}`,
          name: "agora.propose_thread",
          arguments: { title, body },
        },
      ],
      stopReason: "tool_calls",
    };
  },
};

function tempServerEnv(
  port: number,
  dir: string,
  agora: boolean,
): NodeJS.ProcessEnv {
  return {
    COMPANION_DB_PATH: join(dir, "companion.sqlite"),
    COMPANION_HOST: "127.0.0.1",
    COMPANION_PORT: String(port),
    COMPANION_TIME_ZONE: "UTC",
    COMPANION_LOG_LEVEL: process.env.E2E_DEBUG_LOG === "1" ? "info" : "error",
    COMPANION_MODEL_JSON: JSON.stringify({
      adapter: "ollama",
      baseUrl: MODEL_BASE,
      model: MODEL_NAME,
    }),
    ...(agora
      ? {
          COMPANION_AGORA_JSON: JSON.stringify({
            dbPath: join(dir, "state", "agora.sqlite"),
          }),
          COMPANION_AGORA_API_KEY: AGORA_KEY,
        }
      : {}),
  };
}

const roots: string[] = [];
const servers: StartedServer[] = [];

function makeRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

// Start in dependency order: the Playwright webServer waits only for App A's
// health endpoint, so A is last and B/C are already listening when it passes.
const ambiguousDir = makeRoot("companion-agora-ambiguous-");
const ambiguousServer = await startServer({
  env: tempServerEnv(AGORA_AMBIGUOUS_APP_PORT, ambiguousDir, true),
  drainMs: 50,
  modelGateway,
  agoraTransport: fakeTransport(observations.ambiguous, "ambiguous"),
});
servers.push(ambiguousServer);

const disabledDir = makeRoot("companion-agora-disabled-");
const disabledServer = await startServer({
  env: tempServerEnv(AGORA_DISABLED_APP_PORT, disabledDir, false),
  drainMs: 50,
  modelGateway,
});
servers.push(disabledServer);

const successDir = makeRoot("companion-agora-success-");
const successServer = await startServer({
  env: tempServerEnv(AGORA_APP_PORT, successDir, true),
  drainMs: 50,
  modelGateway,
  agoraTransport: fakeTransport(observations.success, "success"),
});
servers.push(successServer);

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", () => resolve(""));
  });
}

const control = createServer(async (req, res) => {
  res.on("error", () => {});
  req.on("error", () => {});
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const json = (status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  await readBody(req);
  if (req.method === "GET" && url.pathname === "/health") {
    json(200, { status: "ok" });
    return;
  }
  if (req.method === "GET" && url.pathname === "/status") {
    json(200, observations);
    return;
  }
  if (req.method === "POST" && url.pathname === "/reset") {
    // Mutate in place: each fake transport closure holds the same object.
    clearObservation(observations.success);
    clearObservation(observations.ambiguous);
    clearObservation(observations.disabled);
    json(200, { reset: true });
    return;
  }
  json(404, { error: { code: "not_found" } });
});

await new Promise<void>((resolve) => {
  (control as HttpServer).listen(AGORA_CONTROL_PORT, "127.0.0.1", resolve);
});

// eslint-disable-next-line no-console
console.log(`agora-e2e-control-ready ${AGORA_CONTROL_ORIGIN}`);
// eslint-disable-next-line no-console
console.log(`agora-e2e-ready http://127.0.0.1:${successServer.port}`);

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await new Promise<void>((resolve) => {
    (control as HttpServer).close(() => resolve());
  });
  while (servers.length > 0) {
    const server = servers.pop();
    if (server !== undefined) {
      await server.shutdown("e2e-teardown").catch(() => undefined);
    }
  }
  while (roots.length > 0) {
    rmSync(roots.pop() as string, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
}
process.on("SIGINT", () => {
  void shutdown().then(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void shutdown().then(() => process.exit(0));
});
