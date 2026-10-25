// End-to-end runtime smoke over the real server/run/gateway path plus the REAL
// operator CLI as a subprocess on a temporary database:
// - a completed selected turn reflects through the real learning service;
// - the pending candidate is not applied before human approval;
// - an exact content-hash approval via the CLI makes it durable;
// - the next relevant same-session turn receives the approved lesson with its
//   evidence/applicability as untrusted user-role context, while unrelated and
//   cross-session turns do not;
// - the approval survives a full server restart.
// No live network and no remind/memory dependency.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChatRequest, ModelGateway } from "@companion/model-local";
import { afterEach, describe, expect, it } from "vitest";
import { type StartedServer, startServer } from "../src/bootstrap.js";
import { LEARNING_EXTRACT_SYSTEM_PROMPT } from "../src/learning_service.js";

const T0 = 1790000000000;
const SERVER_DIR = fileURLToPath(new URL("../", import.meta.url));
const CLI_PATH = fileURLToPath(
  new URL("../src/learning_cli.ts", import.meta.url),
);
const servers: StartedServer[] = [];
const dirs: string[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    await servers
      .pop()
      ?.shutdown("test-teardown")
      .catch(() => undefined);
  }
  while (dirs.length > 0) {
    rmSync(dirs.pop() as string, {
      recursive: true,
      force: true,
      maxRetries: 5,
    });
  }
});

function tempEnv(): { env: NodeJS.ProcessEnv; learningDb: string } {
  const dir = mkdtempSync(join(tmpdir(), "learning-runtime-"));
  dirs.push(dir);
  const learningDb = join(dir, "learning", "learning.sqlite");
  return {
    env: {
      COMPANION_DB_PATH: join(dir, "companion.sqlite"),
      COMPANION_HOST: "127.0.0.1",
      COMPANION_PORT: "0",
      COMPANION_TIME_ZONE: "UTC",
      COMPANION_LOG_LEVEL: "error",
      COMPANION_MODEL_JSON: JSON.stringify({
        adapter: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        model: "test-model",
      }),
      COMPANION_LEARNING_JSON: JSON.stringify({ dbPath: learningDb }),
    },
    learningDb,
  };
}

function gateway(): {
  gateway: ModelGateway;
  agentPrompts: ChatRequest[];
} {
  const agentPrompts: ChatRequest[] = [];
  let call = 0;
  const gateway: ModelGateway = {
    provider: "ollama",
    capabilities: { toolCalling: true },
    baseUrl: "http://127.0.0.1:11434",
    chatUrl: "http://127.0.0.1:11434/api/chat",
    async chat(request) {
      if (request.messages[0]?.content === LEARNING_EXTRACT_SYSTEM_PROMPT) {
        return {
          text: JSON.stringify({
            lessons: [
              {
                kind: "user_confirmed_feedback",
                lesson: "Use ISO dates when changing calendar events",
                evidence: "use ISO dates",
                applicability: "calendar date changes",
              },
            ],
          }),
          toolCalls: [],
          stopReason: "stop",
        };
      }
      agentPrompts.push(request);
      call += 1;
      return {
        text: "",
        toolCalls: [
          {
            id: `answer-${call}`,
            name: "answer.submit",
            arguments: {
              version: 1,
              parts: [{ text: "Understood.", citations: [] }],
            },
          },
        ],
        stopReason: "tool_calls",
      };
    },
  };
  return { gateway, agentPrompts };
}

async function post(
  base: string,
  path: string,
  body: unknown,
): Promise<Response> {
  return await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": randomUUID(),
      origin: base,
    },
    body: JSON.stringify(body),
  });
}

async function waitRun(
  base: string,
  sessionId: string,
  runId: string,
): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const response = await fetch(
      `${base}/api/sessions/${sessionId}/runs/${runId}/status`,
    );
    const body = (await response.json()) as { run: { status: string } };
    if (
      body.run.status === "completed" ||
      body.run.status === "failed" ||
      body.run.status === "cancelled"
    ) {
      expect(body.run.status).toBe("completed");
      return;
    }
    if (Date.now() > deadline) throw new Error("run did not settle");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function runTurn(
  base: string,
  sessionId: string,
  text: string,
): Promise<string> {
  const posted = await post(base, `/api/sessions/${sessionId}/messages`, {
    text,
  });
  expect(posted.status).toBe(202);
  const body = (await posted.json()) as { run: { id: string } };
  await waitRun(base, sessionId, body.run.id);
  return body.run.id;
}

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function invokeLearningCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): CliResult {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", CLI_PATH, ...args],
    {
      cwd: SERVER_DIR,
      env: { ...env, PATH: process.env.PATH ?? "" },
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function cliJson<T>(args: readonly string[], env: NodeJS.ProcessEnv): T {
  const result = invokeLearningCli(args, env);
  if (result.status !== 0) {
    throw new Error(`learning CLI failed: ${result.stderr.slice(0, 200)}`);
  }
  return JSON.parse(result.stdout) as T;
}

async function waitCliProposal(
  env: NodeJS.ProcessEnv,
): Promise<{
  id: string;
  contentHash: string;
  lesson: string;
  status: string;
}> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const rows = cliJson<
      Array<{ id: string; contentHash: string; lesson: string; status: string }>
    >(["list", "pending"], env);
    const first = rows[0];
    if (first !== undefined) return first;
    if (Date.now() > deadline) throw new Error("no reflection proposal");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function expectLessonInUserAdvisory(
  prompt: ChatRequest | undefined,
  lesson: string,
): void {
  expect(prompt).toBeDefined();
  const messages = prompt?.messages ?? [];
  expect(messages[0]?.role).toBe("system");
  expect(JSON.stringify(messages[0])).not.toContain(lesson);
  const lessonMessage = messages.find((message) =>
    message.content.includes(lesson),
  );
  expect(lessonMessage?.role).toBe("user");
}

describe("learning runtime smoke", () => {
  it("reflects, gates on pending, approves via subprocess CLI, applies relevant same-session lessons, and persists across restart", async () => {
    const { env } = tempEnv();
    const fake = gateway();
    const started = await startServer({
      env,
      drainMs: 50,
      now: () => T0,
      modelGateway: fake.gateway,
    });
    servers.push(started);
    const base = `http://127.0.0.1:${started.port}`;

    const created = await post(base, "/api/sessions", {});
    expect(created.status).toBe(201);
    const { sessionId } = (await created.json()) as { sessionId: string };

    await runTurn(
      base,
      sessionId,
      "Please use ISO dates when you change calendar events.",
    );
    const proposal = await waitCliProposal(env);

    // The candidate is pending and unusable until exact-hash approval.
    expect(proposal.status).toBe("pending");
    expect(cliJson<{ status: string }>(["show", proposal.id], env).status).toBe(
      "pending",
    );
    await runTurn(base, sessionId, "How do I change a calendar event date?");
    expect(JSON.stringify(fake.agentPrompts.at(-1))).not.toContain(
      proposal.lesson,
    );

    // A wrong hash never approves; the exact hash from show does.
    const mismatch = invokeLearningCli(
      ["approve", proposal.id, "0".repeat(64)],
      env,
    );
    expect(mismatch.status).not.toBe(0);
    expect(cliJson<{ status: string }>(["show", proposal.id], env).status).toBe(
      "pending",
    );
    const approved = cliJson<{ status: string; contentHash: string }>(
      ["approve", proposal.id, proposal.contentHash],
      env,
    );
    expect(approved.status).toBe("approved");
    expect(approved.contentHash).toBe(proposal.contentHash);

    await runTurn(base, sessionId, "How do I change a calendar event date?");
    const relevantPrompt = fake.agentPrompts.at(-1);
    const relevantText = JSON.stringify(relevantPrompt);
    expect(relevantText).toContain(proposal.lesson);
    expect(relevantText).toContain("use ISO dates");
    expect(relevantText).toContain("calendar date changes");
    expectLessonInUserAdvisory(relevantPrompt, proposal.lesson);

    await runTurn(base, sessionId, "Tell me a joke about the weather");
    expect(JSON.stringify(fake.agentPrompts.at(-1))).not.toContain(
      proposal.lesson,
    );

    const other = await post(base, "/api/sessions", {});
    const otherSession = (await other.json()) as { sessionId: string };
    await runTurn(
      base,
      otherSession.sessionId,
      "How do I change a calendar event date?",
    );
    expect(JSON.stringify(fake.agentPrompts.at(-1))).not.toContain(
      proposal.lesson,
    );

    const applied = cliJson<Array<{ proposalId: string }>>(
      ["applied", sessionId],
      env,
    );
    expect(applied.some((row) => row.proposalId === proposal.id)).toBe(true);

    // Operator reject is also a real subprocess command and removes the
    // candidate from the pending set before any retrieval can use it. The
    // deterministic extractor only emits the fixed lesson, so seed a turn
    // whose accepted text actually contains the quoted evidence.
    await runTurn(
      base,
      sessionId,
      "Please use ISO dates when you change calendar events.",
    );
    const rejectTarget = await waitCliProposal(env);
    const rejected = cliJson<{ status: string }>(
      ["reject", rejectTarget.id],
      env,
    );
    expect(rejected.status).toBe("rejected");
    expect(
      cliJson<{ status: string }>(["show", rejectTarget.id], env).status,
    ).toBe("rejected");
    const pendingAfterReject = cliJson<Array<{ id: string }>>(
      ["list", "pending"],
      env,
    );
    expect(pendingAfterReject.some((row) => row.id === rejectTarget.id)).toBe(
      false,
    );

    // Full restart over the same durable stores.
    await started.shutdown("test-learning-runtime");
    servers.pop();

    const restartedFake = gateway();
    const restarted = await startServer({
      env,
      drainMs: 50,
      now: () => T0,
      modelGateway: restartedFake.gateway,
    });
    servers.push(restarted);
    const restartedBase = `http://127.0.0.1:${restarted.port}`;

    const persisted = cliJson<{ status: string; contentHash: string }>(
      ["show", proposal.id],
      env,
    );
    expect(persisted.status).toBe("approved");
    expect(persisted.contentHash).toBe(proposal.contentHash);
    const approvedList = cliJson<Array<{ id: string }>>(
      ["list", "approved"],
      env,
    );
    expect(approvedList.some((row) => row.id === proposal.id)).toBe(true);

    await runTurn(
      restartedBase,
      sessionId,
      "How do I change a calendar event date?",
    );
    const persistedPrompt = restartedFake.agentPrompts.at(-1);
    const persistedText = JSON.stringify(persistedPrompt);
    expect(persistedText).toContain(proposal.lesson);
    expect(persistedText).toContain("use ISO dates");
    expect(persistedText).toContain("calendar date changes");
    expectLessonInUserAdvisory(persistedPrompt, proposal.lesson);

    await restarted.shutdown("test-learning-runtime");
    servers.pop();
  }, 60_000);
});
