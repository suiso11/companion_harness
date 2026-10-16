// Memory-management real-browser E2E harness: the server process.
//
// Boots the REAL production server through `startServer` (never any
// production rule change) with:
//   - env `COMPANION_MEMORY_JSON` pointing at the REAL remind CLI
//     (`dist/src/cli.js` via `COMPANION_MEMORY_TEST_ENTRY`, temp patched
//     config via `COMPANION_MEMORY_TEST_CONFIG_TEMPLATE`, both defaulting
//     to the sibling remind checkout) with a temp DB/vault, vectors + LLM
//     disabled — temp stores only, no user DB writes;
//   - env `COMPANION_MODEL_JSON` (agent opt-in) + injected `modelGateway` =
//     the synthetic scripted gateway (scripted `answer.submit` + extraction
//     JSON, honestly labeled, NEVER a real model);
//   - NO markdown roots, NO calendar: this also proves the composition gate
//     (memory operates without Markdown or Calendar).
// Everything else (Hono app, RunEngine, repository, migrations, UI,
// ToolBroker with the four memory tools) is the untouched production
// composition, and the Playwright spec drives the REAL UI over HTTP.
//
// A loopback-only control server (MEMORY_CONTROL_PORT, Node-side requests
// only, never page-fetch) exposes:
//   POST /reset   -> no-op acknowledgement (fresh page state per test)
//   GET  /health  -> { status: "ok" }
//
// Temp dirs are removed on shutdown (SIGINT/SIGTERM included).

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ChatRequest,
  ChatResult,
  ModelGateway,
  NormalizedToolCall,
} from "@companion/model-local";
import { startServer } from "../../src/index.js";
import { MEMORY_APP_PORT, MEMORY_CONTROL_PORT } from "./ports.js";

const TEST_SCOPE = "personal/default";
const MODEL_NAME = "synthetic-memory-e2e-gateway";
const MODEL_BASE = "http://127.0.0.1:9";

function hereDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

function siblingRemindPath(...parts: string[]): string {
  // apps/server/e2e/memory -> companion_harness -> sibling remind.
  return resolve(hereDir(), "..", "..", "..", "..", "..", "remind", ...parts);
}

function resolveCliPaths(): { entry: string; template: string } {
  const entry =
    process.env.COMPANION_MEMORY_TEST_ENTRY ??
    siblingRemindPath("dist", "src", "cli.js");
  const template =
    process.env.COMPANION_MEMORY_TEST_CONFIG_TEMPLATE ??
    siblingRemindPath("memory.config.example.json");
  const missing: string[] = [];
  if (!existsSync(entry)) {
    missing.push(`remind CLI entry missing: ${entry}`);
  }
  if (!existsSync(template)) {
    const fallback = siblingRemindPath("memory.config.json");
    if (existsSync(fallback)) {
      return { entry, template: fallback };
    }
    missing.push(`remind config template missing: ${template}`);
  }
  if (missing.length > 0) {
    throw new Error(
      `Memory E2E prerequisite missing (real remind CLI required): ${missing.join("; ")}.`,
    );
  }
  return { entry, template };
}

function patchRemindConfig(templatePath: string, dir: string): string {
  const raw = readFileSync(templatePath, "utf-8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const dbPath = join(dir, "remind-memory-e2e.db");
  const vaultPath = join(dir, "vault");
  mkdirSync(vaultPath, { recursive: true });
  if (typeof parsed.dbPath === "string") {
    parsed.dbPath = dbPath;
  }
  if (typeof parsed.vaultPath === "string") {
    parsed.vaultPath = vaultPath;
  }
  if (Array.isArray(parsed.allowedScopes)) {
    const scopes = parsed.allowedScopes as unknown[];
    if (!scopes.includes(TEST_SCOPE)) {
      scopes.push(TEST_SCOPE);
    }
  }
  const vectors = parsed.vectors as Record<string, unknown> | undefined;
  if (
    vectors !== undefined &&
    typeof vectors === "object" &&
    vectors !== null
  ) {
    if ("enabled" in vectors) {
      vectors.enabled = false;
    }
  }
  const llm = parsed.llm as Record<string, unknown> | undefined;
  if (llm !== undefined && typeof llm === "object" && llm !== null) {
    if ("enabled" in llm) {
      llm.enabled = false;
    }
  }
  const outPath = join(dir, "remind-memory-e2e.config.json");
  writeFileSync(outPath, JSON.stringify(parsed), "utf-8");
  return outPath;
}

function answerCall(text: string): NormalizedToolCall {
  return {
    id: "answer-1",
    name: "answer.submit",
    arguments: { version: 1, parts: [{ text, citations: [] }] },
  };
}

/**
 * Synthetic loopback gateway (NOT a real model): scripted `answer.submit`
 * plus extraction JSON ("user likes green tea" user_fact).
 */
function syntheticGateway(): ModelGateway {
  return {
    provider: "openai-compatible",
    capabilities: { toolCalling: true },
    baseUrl: MODEL_BASE,
    chatUrl: `${MODEL_BASE}/v1/chat/completions`,
    chat: async (request: ChatRequest): Promise<ChatResult> => {
      const system = request.messages[0]?.content ?? "";
      if (system.startsWith("Extract durable memories")) {
        return {
          text: JSON.stringify({
            memories: [{ body: "user likes green tea", kind: "user_fact" }],
          }),
          toolCalls: [],
          stopReason: "stop",
        };
      }
      return {
        text: "",
        toolCalls: [answerCall("Noted green tea.")],
        stopReason: "tool_calls",
      };
    },
  };
}

const { entry, template } = resolveCliPaths();
const dir = mkdtempSync(join(tmpdir(), "companion-memory-e2e-"));
const remindDir = mkdtempSync(join(tmpdir(), "remind-memory-e2e-"));
const remindConfig = patchRemindConfig(template, remindDir);
const dbPath = join(dir, "companion-memory-e2e.sqlite");

const started = await startServer({
  env: {
    COMPANION_DB_PATH: dbPath,
    COMPANION_HOST: "127.0.0.1",
    COMPANION_PORT: String(MEMORY_APP_PORT),
    COMPANION_TIME_ZONE: "UTC",
    COMPANION_LOG_LEVEL: (process.env.E2E_DEBUG_LOG === "1"
      ? "info"
      : "error") as "info" | "error",
    COMPANION_MODEL_JSON: JSON.stringify({
      adapter: "openai-compatible",
      baseUrl: MODEL_BASE,
      model: MODEL_NAME,
    }),
    COMPANION_MEMORY_JSON: JSON.stringify({
      executable: process.execPath,
      entry,
      config: remindConfig,
      scope: TEST_SCOPE,
      timeoutMs: 5000,
      maxResponseBytes: 65536,
      recallLimit: 5,
      idleMs: 5000,
    }),
  },
  modelGateway: syntheticGateway(),
});

/* ------------------------------------------------------------------ */
/* Loopback control server (fixture seam; Node-side requests only)      */
/* ------------------------------------------------------------------ */

const control = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const json = (status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "GET" && url.pathname === "/health") {
    json(200, { status: "ok" });
    return;
  }
  if (req.method === "POST" && url.pathname === "/reset") {
    json(200, { reset: true });
    return;
  }
  json(404, { error: { code: "not_found", message: "resource not found" } });
});
control.listen(MEMORY_CONTROL_PORT, "127.0.0.1", () => {
  // eslint-disable-next-line no-console
  console.log(
    `memory-e2e-control-ready http://127.0.0.1:${MEMORY_CONTROL_PORT}`,
  );
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  await new Promise<void>((resolve) => {
    control.close(() => resolve());
  });
  try {
    await started.shutdown("e2e-teardown");
  } catch {
    // Best effort: still remove temp dirs.
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  rmSync(remindDir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
process.on("SIGINT", () => {
  void shutdown().then(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void shutdown().then(() => process.exit(0));
});
