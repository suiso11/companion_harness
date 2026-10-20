// Live explicit memory-management regression: real HTTP server (memory
// enabled, NO markdown roots, NO calendar) + synthetic local gateway
// (honestly labeled, NOT a real model) + REAL remind CLI temp DB.
//
// What this proves (repeatable, no fixture echo, no source-text checks):
// - Gate: with memory configured but zero markdown roots, the server still
//   builds a ToolBroker exposing memory.search/correct/retire/reactivate
//   (memory operates without Markdown or Calendar).
// - Explicit search over real HTTP returns opaque mN handles including
//   retired records, and never heats (zero record.feedback jobs from search).
// - Confirmation detail keeps the immutable cited snapshot distinct from
//   the live current record (provenance source companion:conversation).
// - Correct stages a REAL source event.append + record.correct chain (both
//   acked in the Companion outbox); replaying the same idempotency key+body
//   returns the STORED operation (deduplicated, same operationId).
// - Retire excludes the record from REAL CLI record.recall but a fresh
//   explicit search still returns the handle with status retired.
// - Reactivate restores it: fresh search shows active again and REAL CLI
//   recall returns the corrected snippet.
//
// Prerequisites: same as memory_live_http.test.ts (real remind CLI +
// config template, else a prerequisite error instead of passing).
// Runnable: `pnpm --filter @companion/server exec vitest run
// test/memory_manage_live.test.ts`. Temp stores only; no user DB writes.

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
  const dbPath = join(dir, "remind-manage.db");
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
  const outPath = join(dir, "remind-manage.config.json");
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
 * `MEMORY_EXTRACT_SYSTEM_PROMPT`; answers cite nothing (management flows
 * drive explicit tools/HTTP, not citations).
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
): Promise<{ runId: string; text: string }> {
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
          result: { version: number; text: string } | null;
        } | null;
      }>;
    };
    const item = body.items.find((entry) => entry.seq === position);
    const result = item?.selectedRun?.result ?? null;
    if (result !== null && typeof result.text === "string") {
      return { runId: item?.selectedRun?.runId as string, text: result.text };
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
  last_error: string | null;
}> {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        "SELECT kind, status, attempts, last_error FROM memory_outbox ORDER BY created_at",
      )
      .all() as Array<{
      kind: string;
      status: string;
      attempts: number;
      last_error: string | null;
    }>;
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
      throw new Error(
        `timed out waiting for outbox ${kind}=${status}: ` +
          JSON.stringify(queryOutbox(dbPath)),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function waitForOperation(
  base: string,
  sessionId: string,
  operationId: string,
  want: string,
  timeoutMs = 45_000,
): Promise<{ status: string; recordRevision: number | null }> {
  const started = Date.now();
  for (;;) {
    const res = await fetch(
      `${base}/api/sessions/${sessionId}/memory/operations/${operationId}`,
      { headers: { host: "127.0.0.1" } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      recordRevision: number | null;
    };
    if (body.status === want) {
      return body;
    }
    if (body.status === "failed" && want !== "failed") {
      throw new Error(
        `operation ${operationId} failed while waiting for ${want}`,
      );
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(
        `timed out waiting for operation ${operationId}=${want} (last ${body.status})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function recallSnippets(
  address: {
    executable: string;
    entry: string;
    config: string;
    timeoutMs: number;
    maxResponseBytes: number;
  },
  query: string,
): Promise<string[]> {
  const recall = await callMemoryCli(
    address,
    "record.recall",
    { query, scope: TEST_SCOPE, runId: "companion-recall", limit: 5 },
    undefined,
  );
  expect(recall.ok).toBe(true);
  const items = (
    recall.data as unknown as { items: Array<{ snippet: string }> }
  ).items;
  return items.map((item) => item.snippet);
}

describe("live memory management lifecycle (real server + real remind CLI)", () => {
  it("search/detail/correct/retire/reactivate over real HTTP + real CLI", async () => {
    const { entry, template } = resolveCliPaths();
    const root = mkdtempSync(join(tmpdir(), "companion-live-manage-"));
    tempDirs.push(root);
    const remindDir = mkdtempSync(join(tmpdir(), "remind-live-manage-"));
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

    // Memory enabled with NO markdown roots and NO calendar: the gate fix
    // under test (memory must operate without Markdown or Calendar).
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
      // fence); memory admission itself stays open (I03-09). Resume
      // explicitly via AUTH control for realistic foreground behavior.
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

      // Gate proof: a ToolBroker exists with zero markdown roots, exposing
      // all four explicit management tools.
      expect(started.toolBroker).not.toBeNull();
      const names = started.toolBroker?.toolNames() ?? [];
      expect(names).toEqual(
        expect.arrayContaining([
          "memory.search",
          "memory.correct",
          "memory.retire",
          "memory.reactivate",
        ]),
      );

      const created = await postJson(
        base,
        "/api/sessions",
        {},
        { "idempotency-key": randomUUID() },
      );
      expect(created.status).toBe(201);
      const { sessionId } = (await created.json()) as { sessionId: string };

      const first = await postJson(
        base,
        `/api/sessions/${sessionId}/messages`,
        { text: "I like green tea." },
        { "idempotency-key": randomUUID() },
      );
      expect(first.status).toBe(202);
      const turn1 = await waitForHistoryResult(base, sessionId, 1);
      expect(turn1.text).toContain("green tea");
      const runId = turn1.runId;

      // Cultivation wrote through the REAL CLI.
      await waitForOutboxKind(dbPath, "event.append", "acked");
      await waitForOutboxKind(dbPath, "record.remember", "acked");
      const recalled = await recallSnippets(address, "green tea");
      expect(recalled.length).toBeGreaterThanOrEqual(1);
      expect(recalled[0]).toContain("green tea");

      // Explicit search: opaque mN handles, retired included by contract.
      const searchRes = await postJson(
        base,
        `/api/sessions/${sessionId}/memory/search`,
        {
          query: "green tea",
          runId,
        },
      );
      expect(searchRes.status).toBe(200);
      const search = (await searchRes.json()) as {
        searchId: string;
        hits: Array<{ handle: string; snippet: string; status: string }>;
      };
      expect(search.hits.length).toBeGreaterThanOrEqual(1);
      for (const hit of search.hits) {
        expect(hit.handle).toMatch(/^m[1-9][0-9]*$/);
      }
      expect(JSON.stringify(search)).not.toContain("rec-");
      const activeHit = search.hits.find((hit) => hit.status === "active");
      expect(activeHit).toBeDefined();
      const handle = (activeHit as { handle: string }).handle;
      // No heat from explicit search: zero feedback jobs staged.
      expect(
        queryOutbox(dbPath).filter((row) => row.kind === "record.feedback"),
      ).toHaveLength(0);

      // Confirmation detail: immutable snapshot vs live current provenance.
      const detailRes = await fetch(
        `${base}/api/sessions/${sessionId}/memory/searches/${encodeURIComponent(search.searchId)}/items/${handle}`,
        { headers: { host: "127.0.0.1" } },
      );
      expect(detailRes.status).toBe(200);
      const detail = (await detailRes.json()) as {
        snapshot: {
          searchId: string;
          handle: string;
          snippet: string;
          status: string;
        };
        current: {
          body: string;
          kind: string;
          status: string;
          revision: number;
          source: string;
          observedAt: string;
          createdAt: string;
        };
        stale: boolean;
      };
      expect(detail.snapshot.handle).toBe(handle);
      expect(detail.snapshot.status).toBe("active");
      expect(detail.current.status).toBe("active");
      expect(detail.current.source).toContain("companion");
      expect(detail.current.body).toContain("green tea");
      expect(detail.stale).toBe(false);

      // Correct: REAL source event + REAL record.correct, both acked.
      const correctKey = randomUUID();
      const correctRes = await postJson(
        base,
        `/api/sessions/${sessionId}/memory/mutations`,
        {
          kind: "record.correct",
          searchId: search.searchId,
          handle,
          correctionBody: "user likes green tea, decaf only",
          runId,
        },
        { "idempotency-key": correctKey },
      );
      expect(correctRes.status).toBe(202);
      const correct = (await correctRes.json()) as {
        operationId: string;
        status: string;
        deduplicated: boolean;
      };
      expect(correct.deduplicated).toBe(false);
      await waitForOperation(base, sessionId, correct.operationId, "acked");
      await waitForOutboxKind(dbPath, "record.correct", "acked");
      const correctedRecall = await recallSnippets(address, "green tea");
      expect(correctedRecall.some((snippet) => snippet.includes("decaf"))).toBe(
        true,
      );

      // Replay after correction with the same key+body returns the STORED
      // operation (deduplicated, same id) instead of staging a duplicate.
      const replayRes = await postJson(
        base,
        `/api/sessions/${sessionId}/memory/mutations`,
        {
          kind: "record.correct",
          searchId: search.searchId,
          handle,
          correctionBody: "user likes green tea, decaf only",
          runId,
        },
        { "idempotency-key": correctKey },
      );
      expect(replayRes.status).toBe(202);
      const replay = (await replayRes.json()) as {
        operationId: string;
        status: string;
        deduplicated: boolean;
      };
      expect(replay.operationId).toBe(correct.operationId);
      expect(replay.deduplicated).toBe(true);

      // Retire: fresh search binds the current target, then retire acks.
      const preRetireRes = await postJson(
        base,
        `/api/sessions/${sessionId}/memory/search`,
        { query: "green tea", runId },
      );
      expect(preRetireRes.status).toBe(200);
      const preRetire = (await preRetireRes.json()) as {
        searchId: string;
        hits: Array<{ handle: string; snippet: string; status: string }>;
      };
      const retireTarget = preRetire.hits.find(
        (hit) => hit.status === "active",
      );
      expect(retireTarget).toBeDefined();
      const retireRes = await postJson(
        base,
        `/api/sessions/${sessionId}/memory/mutations`,
        {
          kind: "record.retire",
          searchId: preRetire.searchId,
          handle: (retireTarget as { handle: string }).handle,
          runId,
        },
        { "idempotency-key": randomUUID() },
      );
      expect(retireRes.status).toBe(202);
      const retire = (await retireRes.json()) as { operationId: string };
      await waitForOperation(base, sessionId, retire.operationId, "acked");

      // Retired: excluded from REAL CLI recall, but explicit search still
      // returns the handle with status retired (no heat either way).
      const retiredRecall = await recallSnippets(address, "green tea");
      expect(retiredRecall.some((snippet) => snippet.includes("decaf"))).toBe(
        false,
      );
      const postRetireRes = await postJson(
        base,
        `/api/sessions/${sessionId}/memory/search`,
        { query: "green tea", runId },
      );
      expect(postRetireRes.status).toBe(200);
      const postRetire = (await postRetireRes.json()) as {
        searchId: string;
        hits: Array<{ handle: string; snippet: string; status: string }>;
      };
      const retiredHit = postRetire.hits.find(
        (hit) => hit.status === "retired",
      );
      expect(retiredHit).toBeDefined();

      // Reactivate: the retired handle reactivates and recall restores.
      const reactivateRes = await postJson(
        base,
        `/api/sessions/${sessionId}/memory/mutations`,
        {
          kind: "record.reactivate",
          searchId: postRetire.searchId,
          handle: (retiredHit as { handle: string }).handle,
          runId,
        },
        { "idempotency-key": randomUUID() },
      );
      expect(reactivateRes.status).toBe(202);
      const reactivate = (await reactivateRes.json()) as {
        operationId: string;
      };
      await waitForOperation(base, sessionId, reactivate.operationId, "acked");
      const finalSearchRes = await postJson(
        base,
        `/api/sessions/${sessionId}/memory/search`,
        { query: "green tea", runId },
      );
      expect(finalSearchRes.status).toBe(200);
      const finalSearch = (await finalSearchRes.json()) as {
        searchId: string;
        hits: Array<{ handle: string; snippet: string; status: string }>;
      };
      expect(finalSearch.hits.some((hit) => hit.status === "active")).toBe(
        true,
      );
      const restoredRecall = await recallSnippets(address, "green tea");
      expect(restoredRecall.some((snippet) => snippet.includes("decaf"))).toBe(
        true,
      );

      await started.shutdown("test-teardown");
      servers.splice(servers.indexOf(started), 1);
      await expect(fetch(`${base}/health/live`)).rejects.toThrow();
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
  }, 180_000);
});
