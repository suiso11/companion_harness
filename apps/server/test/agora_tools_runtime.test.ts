// Executable AGORA agent-runtime smoke.
//
// The REAL server composition (startServer -> RunEngine -> Agent -> ToolBroker)
// creates a draft proposal through a model gateway, a REAL operator CLI
// subprocess approves its exact hash, and the companion later sends it
// through the same broker. The transport is a loopback fake so no public
// request is made; production bootstrap still constructs the fixed-host
// transport. The same run also proves cross-session/wrong-hash blocks,
// restart persistence, replay refusal, and that no key reaches prompts,
// answers, results, or CLI output.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AGORA_TOOL_NAMES, type AgoraTransport } from "@companion/kernel";
import type {
  ChatRequest,
  ChatResult,
  ModelGateway,
} from "@companion/model-local";
import { afterEach, describe, expect, it } from "vitest";
import { type StartedServer, startServer } from "../src/bootstrap.js";

const KEY = "agora-agent-runtime-secret-key";
const MODEL_BASE = "http://127.0.0.1:11434";
const SERVER_DIR = fileURLToPath(new URL("../", import.meta.url));

interface Hit {
  readonly method: string;
  readonly path: string;
  readonly body: string;
  readonly headers: Record<string, string>;
}

function localAgora(): Promise<{
  url: string;
  hits: Hit[];
  close: () => Promise<void>;
}> {
  const hits: Hit[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      hits.push({
        method: request.method ?? "",
        path: request.url ?? "",
        body,
        headers: Object.fromEntries(
          Object.entries(request.headers).map(([key, value]) => [
            key,
            Array.isArray(value) ? value.join(",") : String(value ?? ""),
          ]),
        ),
      });
      if (request.method === "GET" && request.url === "/api/hello") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ name: "agora", hello: "public" }));
        return;
      }
      if (request.method === "GET" && request.url?.startsWith("/t/")) {
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<html><body>public thread</body></html>");
        return;
      }
      if (request.method === "POST") {
        response.writeHead(201, { "content-type": "application/json" });
        response.end("{}");
        return;
      }
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("local agora server failed to bind"));
        return;
      }
      const base = `http://127.0.0.1:${address.port}`;
      resolve({
        url: base,
        hits,
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            server.close((error) => {
              if (error === undefined) resolveClose();
              else rejectClose(error);
            });
          }),
      });
    });
  });
}

function localTransport(url: string): AgoraTransport {
  return {
    async get(path) {
      const response = await fetch(`${url}${path}`);
      return {
        status: response.status,
        text: await response.text(),
        contentType: response.headers.get("content-type") ?? "",
      };
    },
    async post(path, body, headers) {
      const response = await fetch(`${url}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
      return { status: response.status, text: await response.text() };
    },
  };
}

interface ProposalCapture {
  id: string;
  hash: string;
  title: string;
  body: string;
}

function toolOutput(
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
      // Ignore unrelated tool feedback.
    }
  }
  return null;
}

function answer(text: string): ChatResult {
  return {
    text: "",
    toolCalls: [
      {
        id: "answer-1",
        name: "answer.submit",
        arguments: {
          version: 1,
          parts: [{ text, citations: [] }],
        },
      },
    ],
    stopReason: "tool_calls",
  };
}

function call(
  name: string,
  args: Record<string, unknown>,
): ChatResult["toolCalls"][number] {
  return { id: `${name}-${randomUUID()}`, name, arguments: args };
}

function gatewayFor(state: {
  mode:
    | "propose"
    | "cross"
    | "preapproval"
    | "status"
    | "send"
    | "replay"
    | "idle";
  capture: ProposalCapture | null;
  requests: ChatRequest[];
}): ModelGateway {
  return {
    provider: "ollama",
    capabilities: { toolCalling: true },
    baseUrl: MODEL_BASE,
    chatUrl: `${MODEL_BASE}/api/chat`,
    chat: async (request: ChatRequest): Promise<ChatResult> => {
      state.requests.push(request);
      const last = request.messages.at(-1);
      if (last?.role === "tool") {
        const proposed = toolOutput(request.messages, "agora.propose_thread");
        if (proposed !== null) {
          const proposal = proposed.proposal as Record<string, unknown>;
          state.capture = {
            id: String(proposal.proposalId),
            hash: String(proposal.payloadHash),
            title: String(proposal.title),
            body: String(proposal.body),
          };
          return answer(
            `Pending AGORA proposal ${state.capture.id} hash ${state.capture.hash} ` +
              `title ${state.capture.title} body ${state.capture.body}. Nothing was sent.`,
          );
        }
        const sent = toolOutput(request.messages, "agora.send");
        if (sent !== null) {
          const proposal = sent.proposal as Record<string, unknown> | null;
          return answer(
            `AGORA send result ${String(sent.status)} for ` +
              `${proposal === null ? "no proposal" : String(proposal.proposalId)}.`,
          );
        }
        const status = toolOutput(request.messages, "agora.status");
        if (status !== null) {
          const proposals = status.proposals as Array<Record<string, unknown>>;
          return answer(
            `Status ${String(proposals[0]?.status)} body ${String(
              proposals[0]?.body,
            )}.`,
          );
        }
        return answer("No AGORA tool output.");
      }

      if (state.mode === "propose") {
        return {
          text: "",
          toolCalls: [
            call("agora.hello", {}),
            call("agora.propose_thread", {
              title: "Agent title",
              body: "Agent exact body",
            }),
          ],
          stopReason: "tool_calls",
        };
      }
      if (state.mode === "status") {
        if (state.capture === null) throw new Error("missing proposal");
        return {
          text: "",
          toolCalls: [call("agora.status", { proposalId: state.capture.id })],
          stopReason: "tool_calls",
        };
      }
      if (state.mode === "cross") {
        if (state.capture === null) throw new Error("missing proposal");
        return {
          text: "",
          toolCalls: [
            call("agora.send", {
              proposalId: state.capture.id,
              payloadHash: state.capture.hash,
            }),
          ],
          stopReason: "tool_calls",
        };
      }
      if (state.mode === "preapproval") {
        if (state.capture === null) throw new Error("missing proposal");
        return {
          text: "",
          toolCalls: [
            call("agora.send", {
              proposalId: state.capture.id,
              payloadHash: "0".repeat(64),
            }),
          ],
          stopReason: "tool_calls",
        };
      }
      if (state.mode === "send" || state.mode === "replay") {
        if (state.capture === null) throw new Error("missing proposal");
        return {
          text: "",
          toolCalls: [
            call("agora.send", {
              proposalId: state.capture.id,
              payloadHash: state.capture.hash,
            }),
          ],
          stopReason: "tool_calls",
        };
      }
      return answer("No action.");
    },
  };
}

const dirs: string[] = [];
const servers: StartedServer[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server !== undefined) {
      await server.shutdown("test-teardown").catch(() => undefined);
    }
  }
  while (dirs.length > 0) {
    rmSync(dirs.pop() as string, {
      recursive: true,
      force: true,
      maxRetries: 5,
    });
  }
});

function tempEnv(): { env: NodeJS.ProcessEnv; dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "agora-agent-"));
  dirs.push(dir);
  const dbPath = join(dir, "companion.sqlite");
  return {
    env: {
      COMPANION_DB_PATH: dbPath,
      COMPANION_HOST: "127.0.0.1",
      COMPANION_PORT: "0",
      COMPANION_TIME_ZONE: "UTC",
      COMPANION_LOG_LEVEL: "error",
      COMPANION_MODEL_JSON: JSON.stringify({
        adapter: "ollama",
        baseUrl: MODEL_BASE,
        model: "test-model",
      }),
    },
    dir,
    dbPath,
  };
}

async function createSession(base: string): Promise<string> {
  const response = await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": randomUUID(),
      origin: base,
    },
    body: "{}",
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { sessionId: string }).sessionId;
}

async function postMessage(base: string, sessionId: string, text: string) {
  const response = await fetch(`${base}/api/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": randomUUID(),
      origin: base,
    },
    body: JSON.stringify({ text }),
  });
  expect(response.status).toBe(202);
  return ((await response.json()) as { run: { id: string } }).run.id;
}

async function waitCompleted(
  base: string,
  sessionId: string,
  runId: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await fetch(
      `${base}/api/sessions/${sessionId}/runs/${runId}/status`,
    );
    const body = (await response.json()) as { run: { status: string } };
    if (["completed", "failed", "cancelled"].includes(body.run.status)) {
      expect(body.run.status).toBe("completed");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("run did not complete");
}

function runCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "src/agora_cli.ts", ...args],
      {
        cwd: SERVER_DIR,
        env: { ...env, PATH: process.env.PATH ?? "" },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
        killSignal: "SIGKILL",
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

describe("AGORA agent tools through the real server", () => {
  it("proposes, blocks cross-session/pre-approval send, sends once after CLI approval, and refuses replay", async () => {
    const { env, dbPath } = tempEnv();
    const agoraDbPath = join(dbPath, "..", "state", "agora.sqlite");
    const local = await localAgora();
    const state = {
      mode: "propose" as
        | "propose"
        | "cross"
        | "preapproval"
        | "status"
        | "send"
        | "replay"
        | "idle",
      capture: null as ProposalCapture | null,
      requests: [] as ChatRequest[],
    };
    const gateway = gatewayFor(state);
    const started = await startServer({
      env: {
        ...env,
        COMPANION_AGORA_JSON: JSON.stringify({ dbPath: agoraDbPath }),
        COMPANION_AGORA_API_KEY: KEY,
      },
      drainMs: 50,
      modelGateway: gateway,
      agoraTransport: localTransport(local.url),
    });
    servers.push(started);
    try {
      expect([...(started.toolBroker?.toolNames() ?? [])].sort()).toEqual(
        [...AGORA_TOOL_NAMES].sort(),
      );
      const base = `http://127.0.0.1:${started.port}`;
      const sessionA = await createSession(base);

      // Run 1: public hello (JSON object must not break the reader) + draft.
      const proposeRun = await postMessage(
        base,
        sessionA,
        "draft an agora post",
      );
      await waitCompleted(base, sessionA, proposeRun);
      expect(state.capture).not.toBeNull();
      const capture = state.capture as ProposalCapture;
      expect(capture.title).toBe("Agent title");
      expect(capture.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(capture.body).toBe("Agent exact body");
      expect(local.hits.some((hit) => hit.path === "/api/hello")).toBe(true);
      expect(local.hits.filter((hit) => hit.method === "POST")).toHaveLength(0);

      // Run 2: same session can inspect exact content, still no send.
      state.mode = "status";
      const statusRun = await postMessage(base, sessionA, "show its status");
      await waitCompleted(base, sessionA, statusRun);
      expect(
        state.requests.some((request) =>
          request.messages.some(
            (message) =>
              message.role === "tool" &&
              message.content.includes("Agent exact body"),
          ),
        ),
      ).toBe(true);
      expect(local.hits.filter((hit) => hit.method === "POST")).toHaveLength(0);

      // Run 3: a DIFFERENT session cannot send/see session A's proposal.
      const sessionB = await createSession(base);
      state.mode = "cross";
      const crossRun = await postMessage(base, sessionB, "send that proposal");
      await waitCompleted(base, sessionB, crossRun);
      expect(local.hits.filter((hit) => hit.method === "POST")).toHaveLength(0);

      // Run 4: same session before approval (and a wrong hash) still sends 0.
      state.mode = "preapproval";
      const earlyRun = await postMessage(base, sessionA, "send it now");
      await waitCompleted(base, sessionA, earlyRun);
      expect(local.hits.filter((hit) => hit.method === "POST")).toHaveLength(0);

      // Operator CLI approves the EXACT hash observed by the companion.
      const cliEnv: NodeJS.ProcessEnv = {
        COMPANION_DB_PATH: dbPath,
        COMPANION_HOST: "127.0.0.1",
        COMPANION_PORT: "0",
        COMPANION_TIME_ZONE: "UTC",
        COMPANION_LOG_LEVEL: "error",
        COMPANION_AGORA_JSON: JSON.stringify({ dbPath: agoraDbPath }),
      };
      const approved = await runCli(
        ["approve", capture.id, capture.hash],
        cliEnv,
      );
      expect(
        approved.status,
        `${approved.stderr} id=${capture.id} hash=${capture.hash}`,
      ).toBe(0);
      expect(approved.stdout).toContain('"approved"');
      expect(approved.stdout).not.toContain(KEY);
      expect(approved.stderr).not.toContain(KEY);

      // Run 5: the companion sends exactly the approved bytes once.
      state.mode = "send";
      const sendRun = await postMessage(
        base,
        sessionA,
        "send the approved post",
      );
      await waitCompleted(base, sessionA, sendRun);
      const posts = local.hits.filter((hit) => hit.method === "POST");
      expect(posts).toHaveLength(1);
      expect(posts[0]?.path).toBe("/api/threads");
      expect(JSON.parse(posts[0]?.body ?? "null")).toEqual({
        title: "Agent title",
        body: "Agent exact body",
      });
      expect(posts[0]?.headers["x-agent-key"]).toBe(KEY);

      // Run 6: replay of the terminal approval is refused, no second POST.
      state.mode = "replay";
      const replayRun = await postMessage(base, sessionA, "send it again");
      await waitCompleted(base, sessionA, replayRun);
      expect(local.hits.filter((hit) => hit.method === "POST")).toHaveLength(1);

      // The key never entered a model prompt or tool output.
      const prompts = JSON.stringify(state.requests);
      expect(prompts).not.toContain(KEY);
      expect(prompts).not.toContain(agoraDbPath);
    } finally {
      await local.close();
    }
  }, 60_000);

  it("browser approval blocks the model tool until the explicit human Send click", async () => {
    const { env, dbPath } = tempEnv();
    const agoraDbPath = join(dbPath, "..", "state", "agora.sqlite");
    const local = await localAgora();
    const state = {
      mode: "propose" as
        | "propose"
        | "cross"
        | "preapproval"
        | "status"
        | "send"
        | "replay"
        | "idle",
      capture: null as ProposalCapture | null,
      requests: [] as ChatRequest[],
    };
    const started = await startServer({
      env: {
        ...env,
        COMPANION_AGORA_JSON: JSON.stringify({ dbPath: agoraDbPath }),
        COMPANION_AGORA_API_KEY: KEY,
      },
      drainMs: 50,
      modelGateway: gatewayFor(state),
      agoraTransport: localTransport(local.url),
    });
    servers.push(started);
    try {
      const base = `http://127.0.0.1:${started.port}`;
      const session = await createSession(base);
      const proposeRun = await postMessage(base, session, "draft a post");
      await waitCompleted(base, session, proposeRun);
      const capture = state.capture as ProposalCapture | null;
      expect(capture).not.toBeNull();
      const proposal = capture as ProposalCapture;

      // Browser exact-hash approve is a human review, not a Send.
      const approved = await fetch(
        `${base}/api/sessions/${session}/agora/proposals/${proposal.id}/approve`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: base,
          },
          body: JSON.stringify({ payloadHash: proposal.hash }),
        },
      );
      expect(approved.status).toBe(200);
      const approvedBody = (await approved.json()) as {
        proposal: { status: string };
      };
      expect(approvedBody.proposal.status).toBe("approved");
      expect(local.hits.filter((hit) => hit.method === "POST")).toHaveLength(0);

      // The model tool cannot consume a browser approval: zero outbound and
      // the durable row stays approved.
      state.mode = "send";
      const blockedRun = await postMessage(base, session, "send it now");
      await waitCompleted(base, session, blockedRun);
      expect(local.hits.filter((hit) => hit.method === "POST")).toHaveLength(0);
      const stillApproved = await fetch(
        `${base}/api/sessions/${session}/agora/proposals/${proposal.id}`,
      );
      expect(stillApproved.status).toBe(200);
      expect(
        (
          (await stillApproved.json()) as {
            proposal: { status: string };
          }
        ).proposal.status,
      ).toBe("approved");

      // The explicit human Send click is allowed and consumes it once.
      const sent = await fetch(
        `${base}/api/sessions/${session}/agora/proposals/${proposal.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: base,
          },
          body: JSON.stringify({ payloadHash: proposal.hash }),
        },
      );
      expect(sent.status).toBe(200);
      const sentBody = (await sent.json()) as { outcome: string };
      expect(sentBody.outcome).toBe("sent");
      const posts = local.hits.filter((hit) => hit.method === "POST");
      expect(posts).toHaveLength(1);
      expect(posts[0]?.path).toBe("/api/threads");
      expect(JSON.parse(posts[0]?.body ?? "null")).toEqual({
        title: "Agent title",
        body: "Agent exact body",
      });

      // Replay cannot resend the consumed approval.
      state.mode = "replay";
      const replayRun = await postMessage(base, session, "send it again");
      await waitCompleted(base, session, replayRun);
      expect(local.hits.filter((hit) => hit.method === "POST")).toHaveLength(1);
    } finally {
      await local.close();
    }
  }, 60_000);

  it("registers no AGORA tools when the config is absent", async () => {
    const { env } = tempEnv();
    const started = await startServer({
      env,
      drainMs: 50,
      modelGateway: gatewayFor({
        mode: "idle",
        capture: null,
        requests: [],
      }),
    });
    servers.push(started);
    expect(started.toolBroker).toBeNull();
    await started.shutdown("test-disabled");
    servers.pop();
  });
});
