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
//   POST /reset         -> no-op acknowledgement (fresh page state per test)
//   GET  /health        -> { status: "ok" }
//   POST /seed          -> reset the temp remind DB and seed a small linked
//                          graph through the REAL remind CLI (`record.remember`
//                          with `links[]`) — hermetic graph fixtures
//   POST /extraction    -> toggle the synthetic extraction result (graph
//                          specs use "empty": the conversation still creates
//                          a run, but adds no unrelated records)
//   POST /legacy-graph  -> toggle a test-only CLI wrapper that answers the
//                          graph ops with BAD_REQUEST (an "old remind" build)
//
// Graph seeding is deliberately test-only server code: the production UI
// still reads the graph through the REAL Hono routes + real CLI.
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
import { callMemoryCli } from "../../src/memory_cli.js";
import { MEMORY_APP_PORT, MEMORY_CONTROL_PORT } from "./ports.js";

const TEST_SCOPE = "personal/default";
const MODEL_NAME = "synthetic-memory-e2e-gateway";
const MODEL_BASE = "http://127.0.0.1:9";
const REMIND_DB_NAME = "remind-memory-e2e.db";
/**
 * Graph specs seed links directly, then send ONE turn with extraction
 * suppressed so the conversation-owned run does not add unrelated records.
 */
let extractionMode: "default" | "empty" = "default";

/**
 * Two stable fixture graphs are possible; this is the 10-node/12-edge graph
 * the real-browser graph spec asserts. Links refer to earlier indexes.
 */
const SEED_LABELS = [
  "graph seed alpha",
  "graph seed bravo",
  "graph seed charlie",
  "graph seed delta",
  "graph seed echo",
  "graph seed foxtrot",
  "graph seed golf",
  "graph seed hotel",
  "graph seed india",
  "graph seed juliet",
] as const;
const SEED_LINKS: readonly (readonly number[])[] = [
  [],
  [0],
  [0],
  [0],
  [1, 3],
  [2, 4],
  [5],
  [6],
  [7, 4],
  [8],
];
const SEED_EDGE_COUNT = SEED_LINKS.reduce(
  (total, links) => total + links.length,
  0,
);

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
  const dbPath = join(dir, REMIND_DB_NAME);
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
      if (system.startsWith("Extract memories from the conversation")) {
        const memories =
          extractionMode === "empty"
            ? []
            : [
                {
                  body: "ユーザーは緑茶が好きだと伝え、アシスタントがそれを覚えた。",
                  kind: "summary",
                },
                { body: "user likes green tea", kind: "user_fact" },
              ];
        return {
          text: JSON.stringify({ memories }),
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

/**
 * Test-only CLI wrapper: with the marker present it answers the graph ops
 * exactly like an older remind build (BAD_REQUEST); every other op is
 * delegated byte-for-byte to the REAL CLI. This lets one harness exercise
 * the "old remind" unavailable status without a second server process.
 */
function legacyWrapperSource(realEntry: string, markerPath: string): string {
  return `import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const REAL_ENTRY = ${JSON.stringify(realEntry)};
const MARKER = ${JSON.stringify(markerPath)};
const GRAPH_OPS = new Set(["graph.local", "graph.page", "graph.version"]);
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  let op = null;
  try { op = JSON.parse(input.trim()).op ?? null; } catch { op = null; }
  if (typeof op === "string" && GRAPH_OPS.has(op) && existsSync(MARKER)) {
    process.stdout.write(JSON.stringify({
      v: 1,
      ok: false,
      code: "BAD_REQUEST",
      message: "unknown op",
      data: null,
      deduplicated: false,
    }) + "\\n");
    return;
  }
  const child = spawn(process.execPath, [REAL_ENTRY, ...process.argv.slice(2)], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const chunks = [];
  child.stdout.on("data", (chunk) => chunks.push(chunk));
  child.on("error", () => { process.exitCode = 1; });
  child.on("close", (code) => {
    process.stdout.write(Buffer.concat(chunks));
    process.exitCode = code ?? 1;
  });
  child.stdin.end(input);
});
`;
}

const { entry, template } = resolveCliPaths();
const dir = mkdtempSync(join(tmpdir(), "companion-memory-e2e-"));
const remindDir = mkdtempSync(join(tmpdir(), "remind-memory-e2e-"));
const remindConfig = patchRemindConfig(template, remindDir);
const remindDbPath = join(remindDir, REMIND_DB_NAME);
const legacyMarkerPath = join(remindDir, "legacy-graph.marker");
const legacyEntryPath = join(dir, "remind-legacy-graph-wrapper.mjs");
writeFileSync(
  legacyEntryPath,
  legacyWrapperSource(entry, legacyMarkerPath),
  "utf-8",
);
const seedAddress = {
  executable: process.execPath,
  entry,
  config: remindConfig,
  timeoutMs: 10_000,
  maxResponseBytes: 65_536,
} as const;
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
      // A pass-through wrapper so /legacy-graph can simulate an old remind
      // build for ONLY the graph ops (README-level fixture seam).
      entry: legacyEntryPath,
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

// STOP semantics: a fresh restart starts paused with background admission
// closed. This cultivation E2E needs background extraction, so resume
// explicitly via AUTH control before any chat runs.
{
  const appBase = `http://127.0.0.1:${MEMORY_APP_PORT}`;
  const controlRes = await fetch(`${appBase}/api/autonomy/control`, {
    headers: { host: "127.0.0.1" },
  });
  if (!controlRes.ok) {
    throw new Error(
      `memory e2e resume prerequisite failed: control GET ${controlRes.status}`,
    );
  }
  const control = (await controlRes.json()) as {
    paused: boolean;
    version: number;
  };
  if (control.paused === true) {
    const { randomUUID } = await import("node:crypto");
    const resumed = await fetch(`${appBase}/api/autonomy/control`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "127.0.0.1",
        origin: appBase,
        "idempotency-key": randomUUID(),
      },
      body: JSON.stringify({
        paused: false,
        expectedVersion: control.version,
      }),
    });
    if (!resumed.ok) {
      throw new Error(
        `memory e2e resume prerequisite failed: control POST ${resumed.status}`,
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* Fixture helpers: graph seeding + old-remind simulation (test-only)   */
/* ------------------------------------------------------------------ */

function setLegacyGraph(enabled: boolean): void {
  if (enabled) {
    writeFileSync(legacyMarkerPath, "1", "utf-8");
    return;
  }
  rmSync(legacyMarkerPath, { force: true });
}

function resetRemindStore(): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${remindDbPath}${suffix}`, { force: true });
  }
}

/**
 * Seed a small linked graph with REAL `event.append` + `record.remember`
 * (README `links[]`). Raw ids stay in this process; the graph routes mint
 * opaque handles only.
 */
async function seedLinkedGraph(): Promise<{
  nodes: number;
  edges: number;
  labels: string[];
}> {
  const provenance = {
    source: "session:graph-e2e:turn:1",
    observedAt: new Date().toISOString(),
  };
  const ids: string[] = [];
  for (let index = 0; index < SEED_LABELS.length; index += 1) {
    const label = SEED_LABELS[index];
    if (label === undefined) {
      continue;
    }
    const eventId = `seed-e${index}`;
    const event = await callMemoryCli(
      seedAddress,
      "event.append",
      {
        eventId,
        sessionId: "graph-e2e",
        turnId: eventId,
        body: `${label} raw`,
        provenance,
        scope: TEST_SCOPE,
      },
      `seed-ev-${index}`,
    );
    if (!event.ok) {
      throw new Error(`seed event.append failed: ${event.code}`);
    }
    const links = (SEED_LINKS[index] ?? []).map((linked) => {
      const id = ids[linked];
      if (id === undefined) {
        throw new Error("seed link resolved before its record");
      }
      return id;
    });
    const remembered = await callMemoryCli(
      seedAddress,
      "record.remember",
      {
        body: label,
        kind: "user_fact",
        provenance,
        scope: TEST_SCOPE,
        tags: ["graph-e2e"],
        links,
        sourceRefs: [eventId],
      },
      `seed-rem-${index}`,
    );
    if (!remembered.ok) {
      throw new Error(`seed record.remember failed: ${remembered.code}`);
    }
    const record = remembered.data?.record as { id?: unknown } | undefined;
    if (typeof record?.id !== "string" || record.id.length === 0) {
      throw new Error("seed record.remember returned no record id");
    }
    ids.push(record.id);
  }
  return {
    nodes: SEED_LABELS.length,
    edges: SEED_EDGE_COUNT,
    labels: [...SEED_LABELS],
  };
}

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > 65_536) {
        reject(new Error("control body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", () => reject(new Error("control body read failed")));
  });
}

/* ------------------------------------------------------------------ */
/* Loopback control server (fixture seam; Node-side requests only)      */
/* ------------------------------------------------------------------ */

const control = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const json = (status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  try {
    if (req.method === "GET" && url.pathname === "/health") {
      json(200, { status: "ok" });
      return;
    }
    if (req.method === "POST" && url.pathname === "/reset") {
      setLegacyGraph(false);
      extractionMode = "default";
      json(200, { reset: true });
      return;
    }
    if (req.method === "POST" && url.pathname === "/extraction") {
      const body = JSON.parse(await readBody(req)) as { mode?: unknown };
      if (body.mode !== "default" && body.mode !== "empty") {
        json(400, {
          error: { code: "validation_error", message: "mode required" },
        });
        return;
      }
      extractionMode = body.mode;
      json(200, { mode: extractionMode });
      return;
    }
    if (req.method === "POST" && url.pathname === "/legacy-graph") {
      const body = JSON.parse(await readBody(req)) as { enabled?: unknown };
      if (typeof body.enabled !== "boolean") {
        json(400, {
          error: { code: "validation_error", message: "enabled required" },
        });
        return;
      }
      setLegacyGraph(body.enabled);
      json(200, { enabled: body.enabled });
      return;
    }
    if (req.method === "POST" && url.pathname === "/seed") {
      setLegacyGraph(false);
      resetRemindStore();
      const seeded = await seedLinkedGraph();
      json(200, seeded);
      return;
    }
    json(404, { error: { code: "not_found", message: "resource not found" } });
  } catch {
    json(500, { error: { code: "internal_error", message: "control failed" } });
  }
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
