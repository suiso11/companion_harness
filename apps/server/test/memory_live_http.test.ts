// Live conversation-memory regression: real HTTP server + synthetic local
// gateway (honestly labeled, NOT a real model) + REAL remind CLI temp DB.
//
// What this proves (repeatable, no fixture echo, no source-text checks):
// - Turn 1 over real HTTP completes; Companion `memory_outbox`
//   `event.append` + `record.remember` both reach `acked`; a direct REAL CLI
//   `record.recall` returns 1 snippet carrying the remembered body.
// - Turn 2 recalls and answers with a structural `citations: ["m1"]`; a
//   same-run `m1` grant row exists and `record.feedback` reaches `acked`.
// - Mere recall without citations grants nothing: turn 1 has zero grants
//   and zero feedback jobs.
// - Idle `maintain.distill` auto-enqueues and acks (LLM/vectors disabled, so
//   degraded scheduling proof only, zero writes claimed).
// - Graceful shutdown resolves and the listener closes (no orphaned child:
//   the service stop awaits in-flight CLI kills; a fresh CLI call still
//   works afterwards, proving the previous child was reaped).
//
// Prerequisites (clear failure, never false green):
// - Real remind CLI at `COMPANION_MEMORY_TEST_ENTRY` or the sibling
//   `../../../remind/dist/src/cli.js` plus a template config at
//   `COMPANION_MEMORY_TEST_CONFIG_TEMPLATE` or the sibling
//   `memory.config.example.json`. When either is absent the test throws a
//   prerequisite error instead of passing.
// - No model downloads: the gateway is synthetic and the remind template is
//   patched at runtime to absolute temp `dbPath`/`vaultPath` with
//   `vectors.enabled=false` and `llm.enabled=false` (existing keys only).
//
// Runnable: `pnpm --filter @companion/server exec vitest run
// test/memory_live_http.test.ts` (root `pnpm test -- memory_live_http`
// also matches). Temp stores only; no user DB writes.

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ChatRequest,
  ChatResult,
  ModelGateway,
  NormalizedToolCall,
} from "@companion/model-local";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { type StartedServer, startServer } from "../src/bootstrap.js";
import { callMemoryCli } from "../src/memory_cli.js";

const TEST_SCOPE = "personal/default";
const MODEL_NAME = "synthetic-live-gateway";
const MODEL_BASE = "http://127.0.0.1:9";

let tempDirs: string[] = [];
const servers: StartedServer[] = [];

function hereDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

function siblingRemindPath(...parts: string[]): string {
  // apps/server/test -> companion_harness -> sibling remind.
  return resolve(hereDir(), "..", "..", "..", "..", "remind", ...parts);
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
      `Live memory regression prerequisite missing (real remind CLI required, ` +
        `no fixture fallback): ${missing.join("; ")}. ` +
        `Provide COMPANION_MEMORY_TEST_ENTRY and ` +
        `COMPANION_MEMORY_TEST_CONFIG_TEMPLATE or check out the sibling ` +
        `remind repo with a built dist/src/cli.js.`,
    );
  }
  return { entry, template };
}

function patchRemindConfig(templatePath: string, dir: string): string {
  const raw = readFileSync(templatePath, "utf-8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const dbPath = join(dir, "remind-live.db");
  const vaultPath = join(dir, "vault");
  mkdirSync(vaultPath, { recursive: true });
  // Existing keys only: never invent strict-config keys.
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
  const outPath = join(dir, "remind-live.config.json");
  writeFileSync(outPath, JSON.stringify(parsed), "utf-8");
  return outPath;
}

function answerCall(text: string, citations: string[]): NormalizedToolCall {
  return {
    id: "answer-1",
    name: "answer.submit",
    arguments: { version: 1, parts: [{ text, citations }] },
  };
}

/**
 * Synthetic loopback gateway (NOT a real model): scripted `answer.submit`
 * plus extraction JSON. Extraction requests carry the fixed
 * `MEMORY_EXTRACT_SYSTEM_PROMPT` ("Extract durable memories..."); answer
 * requests carry the agent system prompt. When the projected memory block
 * already exposes `m1`, the answer cites it; otherwise it cites nothing.
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
            memories: [
              {
                body: "ユーザーは緑茶が好きだと伝え、アシスタントがそれを覚えた。",
                kind: "summary",
              },
              { body: "user likes green tea", kind: "user_fact" },
            ],
          }),
          toolCalls: [],
          stopReason: "stop",
        };
      }
      // Provenance-labelled format (F-I01-04): each projected line is
      // `- mN [label]: snippet` where the label is `user_fact` or an
      // explicit inference/summary/unverified marker (absent kind included).
      const hasMemory = request.messages.some((message) =>
        /(^|\n)- m1 \[[^\]]*\]:/.test(message.content),
      );
      if (hasMemory) {
        return {
          text: "",
          toolCalls: [answerCall("Noted green tea preference.", ["m1"])],
          stopReason: "tool_calls",
        };
      }
      return {
        text: "",
        toolCalls: [answerCall("Noted green tea.", [])],
        stopReason: "tool_calls",
      };
    },
  };
}

async function postJson(
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

async function waitForHistoryResult(
  base: string,
  sessionId: string,
  position: number,
  timeoutMs = 30_000,
): Promise<{
  runId: string;
  text: string;
  citations: string[];
  version: number;
}> {
  const started = Date.now();
  for (;;) {
    const res = await fetch(
      `${base}/api/sessions/${sessionId}/history?limit=50`,
      { headers: { host: "127.0.0.1" } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{
        seq: number;
        selectedRun: {
          runId: string;
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
      return {
        runId: item?.selectedRun?.runId as string,
        text: result.text,
        citations,
        version: result.version,
      };
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out waiting for history position ${position}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function queryOutbox(dbPath: string): Array<{
  kind: string;
  status: string;
  attempts: number;
  run_id: string;
}> {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        "SELECT kind, status, attempts, run_id FROM memory_outbox ORDER BY created_at",
      )
      .all() as Array<{
      kind: string;
      status: string;
      attempts: number;
      run_id: string;
    }>;
  } finally {
    db.close();
  }
}

function queryGrants(dbPath: string): Array<{
  run_id: string;
  citation: string;
  record_id: string;
}> {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare("SELECT run_id, citation, record_id FROM memory_grants")
      .all() as Array<{ run_id: string; citation: string; record_id: string }>;
  } finally {
    db.close();
  }
}

async function waitForOutboxKind(
  dbPath: string,
  kind: string,
  status: string,
  timeoutMs = 30_000,
): Promise<void> {
  const started = Date.now();
  for (;;) {
    const rows = queryOutbox(dbPath).filter(
      (row) => row.kind === kind && row.status === status,
    );
    if (rows.length > 0) {
      return;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out waiting for outbox ${kind}=${status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("live memory HTTP regression (real server + real remind CLI)", () => {
  it("remembers first turn, cites m1 on second, and distills idle", async () => {
    const { entry, template } = resolveCliPaths();
    const root = mkdtempSync(join(tmpdir(), "companion-live-mem-"));
    tempDirs.push(root);
    const remindDir = mkdtempSync(join(tmpdir(), "remind-live-mem-"));
    tempDirs.push(remindDir);
    const remindConfig = patchRemindConfig(template, remindDir);
    const dbPath = join(root, "companion.sqlite");
    const address = {
      executable: process.execPath,
      entry,
      config: remindConfig,
      timeoutMs: 5000,
      maxResponseBytes: 65536,
    };

    const env: NodeJS.ProcessEnv = {
      COMPANION_DB_PATH: dbPath,
      COMPANION_HOST: "127.0.0.1",
      COMPANION_PORT: "0",
      COMPANION_TIME_ZONE: "UTC",
      COMPANION_LOG_LEVEL: "error",
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
    };
    const started = await startServer({
      env,
      drainMs: 200,
      modelGateway: syntheticGateway(),
    });
    servers.push(started);
    try {
      const base = `http://127.0.0.1:${started.port}`;
      expect(started.port).toBeGreaterThan(0);

      // A fresh restart starts with the persisted paused control (kernel
      // fence); memory admission itself stays open (I03-09). This
      // cultivation regression only needs an unpaused KERNEL for realistic
      // foreground behavior, so resume explicitly via AUTH control.
      const controlRes = await fetch(`${base}/api/autonomy/control`, {
        headers: { host: "127.0.0.1" },
      });
      expect(controlRes.status).toBe(200);
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

      const created = await postJson(
        base,
        "/api/sessions",
        {},
        {
          "idempotency-key": randomUUID(),
        },
      );
      expect(created.status).toBe(201);
      const { sessionId } = (await created.json()) as { sessionId: string };

      // Turn 1: no memory yet, so the synthetic answer cites nothing.
      const first = await postJson(
        base,
        `/api/sessions/${sessionId}/messages`,
        { text: "I like green tea." },
        { "idempotency-key": randomUUID() },
      );
      expect(first.status).toBe(202);
      const turn1 = await waitForHistoryResult(base, sessionId, 1);
      expect(turn1.text).toContain("green tea");
      expect(turn1.citations).toEqual([]);

      // Durable cultivation: event + remember both acked via the REAL CLI.
      await waitForOutboxKind(dbPath, "event.append", "acked");
      await waitForOutboxKind(dbPath, "record.remember", "acked");
      const afterFirst = queryOutbox(dbPath);
      expect(
        afterFirst.filter((row) => row.kind === "event.append")[0]?.status,
      ).toBe("acked");
      expect(
        afterFirst.filter((row) => row.kind === "record.remember")[0]?.status,
      ).toBe("acked");

      // Direct REAL CLI recall proves data (not a fixture echo).
      const recall = await callMemoryCli(
        address,
        "record.recall",
        {
          query: "green tea",
          scope: TEST_SCOPE,
          runId: "companion-recall",
          limit: 5,
        },
        undefined,
      );
      expect(recall.ok).toBe(true);
      const items = (
        recall.data as unknown as {
          items: Array<{ snippet: string }>;
        }
      ).items;
      expect(items.length).toBeGreaterThanOrEqual(1);
      expect(items[0]?.snippet).toContain("green tea");

      // Mere recall without citations grants nothing (no feedback yet).
      expect(queryGrants(dbPath)).toHaveLength(0);
      expect(
        queryOutbox(dbPath).filter((row) => row.kind === "record.feedback"),
      ).toHaveLength(0);

      // Turn 2: recall exposes m1, the synthetic answer cites it.
      const second = await postJson(
        base,
        `/api/sessions/${sessionId}/messages`,
        { text: "What did you note about green tea?" },
        { "idempotency-key": randomUUID() },
      );
      expect(second.status).toBe(202);
      const turn2 = await waitForHistoryResult(base, sessionId, 2);
      expect(turn2.citations).toEqual(["m1"]);

      // Cite-gated feedback: same-run m1 grant + acked feedback job.
      await waitForOutboxKind(dbPath, "record.feedback", "acked");
      const grants = queryGrants(dbPath).filter(
        (grant) => grant.run_id === turn2.runId && grant.citation === "m1",
      );
      expect(grants).toHaveLength(1);

      // Idle cultivation: bounded distill auto-enqueues and acks
      // (degraded: LLM/vectors disabled, scheduling proof only).
      await waitForOutboxKind(dbPath, "maintain.distill", "acked", 45_000);

      // Graceful stop: shutdown resolves and the listener closes; the
      // previous CLI children were reaped (a fresh REAL CLI call works).
      await started.shutdown("test-teardown");
      servers.splice(servers.indexOf(started), 1);
      await expect(fetch(`${base}/health/live`)).rejects.toThrow();
      const afterStop = await callMemoryCli(
        address,
        "record.recall",
        {
          query: "green tea",
          scope: TEST_SCOPE,
          runId: "companion-recall",
          limit: 1,
        },
        undefined,
      );
      expect(afterStop.ok).toBe(true);
    } finally {
      const index = servers.indexOf(started);
      if (index >= 0) {
        servers.splice(index, 1);
        await started.shutdown("test-teardown").catch(() => undefined);
      }
      for (const dir of tempDirs) {
        rmSync(dir, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        });
      }
      tempDirs = [];
    }
  }, 120_000);
});
